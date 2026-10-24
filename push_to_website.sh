#!/usr/bin/env bash
# push_to_website.sh — compile a talkMD talk and publish it onto the GitHub Pages site.
#
#   ./push_to_website.sh ~/Documents/pdex2026/talk                 # build + publish as /talk/
#   ./push_to_website.sh ~/Documents/pdex2026/talk --subdir pdex2026
#   ./push_to_website.sh <talk> --dry-run                          # show every step, change nothing
#   ./push_to_website.sh <talk> --no-push                          # build + copy + commit, no git push
#
# What it does:
#   1. compiles the talk with talkMD (tools/build_slides.py), taking theme/style/transition
#      from the talk's own config.yaml — and drops --live-reload for the published copy.
#      The interpreter MUST be able to `import markdown`: without it build_slides.py
#      silently falls back to a minimal renderer (bullets stay literal "*", paragraphs
#      become <br>, floats are laid out differently). We probe for a good interpreter and
#      refuse to publish a degraded build — see the 2026-10-08 incident.
#   2. rsyncs the deck (index.html + _talkmd/ + images/ + slides.md) into <site>/<subdir>/
#   3. makes sure .nojekyll exists at the site root (without it Jekyll eats _talkmd/)
#   4. serves the site on a spare port and smoke-tests the sub-site (HTTP + images, plus a
#      headless render check when playwright is available)
#   5. git add <subdir> .nojekyll → commit → push
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TALKMD="${TALKMD:-/home/lzx/app/talkMD}"
SITE_REPO="${SITE_REPO:-$SCRIPT_DIR}"
BRANCH="${BRANCH:-main}"
PYTHON_REQUESTED="${PYTHON:-}" # non-empty when the caller set PYTHON=…
PYTHON="${PYTHON:-python}"
ALLOW_DEGRADED=0 # --allow-degraded-markdown

TALK=""
SUBDIR=""
MSG=""
PUSH=1
DRY=0
VERIFY=1
KEEP_LR=0

usage() {
  cat <<'USAGE'
usage: push_to_website.sh <talk_dir> [options]

  <talk_dir>              folder containing slides.md + config.yaml

options
  --subdir NAME           sub-site folder on the website (default: basename of <talk_dir>)
  --site PATH             site repo (default: folder holding this script)
  --branch NAME           git branch to push (default: main)
  --message TEXT          commit message (default: "update talk: <subdir>")
  --no-push               build/copy/commit locally, do not push
  --dry-run               print every action, touch nothing
  --no-verify             skip the local HTTP smoke test
  --keep-live-reload      keep the self-reloading poller in the published deck
  --allow-degraded-markdown
                          publish even if the interpreter cannot `import markdown`
                          (literal "*" bullets, misaligned float boxes)
  -h, --help              this text

env overrides: TALKMD, SITE_REPO, BRANCH, PYTHON
  PYTHON must be an interpreter with the "markdown" package installed
  (e.g. PYTHON=/home/lzx/miniconda3/bin/python3); auto-picked when omitted.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
  -h | --help)
    usage
    exit 0
    ;;
  --subdir)
    SUBDIR="${2:?}"
    shift 2
    ;;
  --site)
    SITE_REPO="${2:?}"
    shift 2
    ;;
  --branch)
    BRANCH="${2:?}"
    shift 2
    ;;
  --message)
    MSG="${2:?}"
    shift 2
    ;;
  --no-push)
    PUSH=0
    shift
    ;;
  --dry-run)
    DRY=1
    shift
    ;;
  --no-verify)
    VERIFY=0
    shift
    ;;
  --keep-live-reload)
    KEEP_LR=1
    shift
    ;;
  --allow-degraded-markdown)
    ALLOW_DEGRADED=1
    shift
    ;;
  -*)
    echo "unknown option: $1" >&2
    usage >&2
    exit 2
    ;;
  *)
    TALK="$1"
    shift
    ;;
  esac
done

[ -n "$TALK" ] || {
  usage >&2
  exit 2
}
TALK="$(cd "$TALK" && pwd)"
[ -f "$TALK/slides.md" ] || {
  echo "ERROR: no slides.md in $TALK" >&2
  exit 1
}
[ -f "$TALKMD/tools/build_slides.py" ] || {
  echo "ERROR: talkMD not found at $TALKMD (set TALKMD=...)" >&2
  exit 1
}

# --- interpreter check --------------------------------------------------------
# tools/build_slides.py prefers the `markdown` package and SILENTLY falls back to a
# minimal renderer when it is missing: "* item" stays a literal "*", paragraphs
# become <br>, float boxes get different geometry. Homebrew's python3 (3.14, first in
# PATH since 2026-09-30) has no `markdown` — that is what broke the 2026-10-08 pushes.
# So: pick an interpreter that has it, and refuse to publish a degraded deck.
if ! "$PYTHON" -c 'import markdown' >/dev/null 2>&1; then
  FOUND_PY=""
  if [ -z "$PYTHON_REQUESTED" ]; then
    for cand in /home/lzx/miniconda3/bin/python3 python3.11 python3 python; do
      command -v "$cand" >/dev/null 2>&1 || continue
      if "$cand" -c 'import markdown' >/dev/null 2>&1; then
        FOUND_PY="$cand"
        break
      fi
    done
  fi
  if [ -n "$FOUND_PY" ]; then
    echo "note: '$PYTHON' has no python-markdown → using $FOUND_PY"
    PYTHON="$FOUND_PY"
  elif [ "$ALLOW_DEGRADED" = 0 ]; then
    {
      echo "ERROR: interpreter '$PYTHON' cannot 'import markdown'."
      echo "       build_slides.py would fall back to its minimal renderer: literal \"*\""
      echo "       bullets, <br> instead of paragraphs → misaligned floats in the deck."
      echo "       Use an interpreter that has it, e.g."
      echo "         PYTHON=/home/lzx/miniconda3/bin/python3 $0 <talk_dir>"
      echo "       or pass --allow-degraded-markdown to publish the degraded deck anyway."
    } >&2
    exit 1
  else
    echo "warning: '$PYTHON' has no python-markdown — building a DEGRADED deck (--allow-degraded-markdown)"
  fi
fi
if "$PYTHON" -c 'import markdown' >/dev/null 2>&1; then PYTHON_NOTE="markdown ✓"; else PYTHON_NOTE="markdown ✗ (degraded renderer)"; fi
SITE_REPO="$(cd "$SITE_REPO" && pwd)"
git -C "$SITE_REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "ERROR: $SITE_REPO is not a git repo" >&2
  exit 1
}
[ -n "$SUBDIR" ] || SUBDIR="$(basename "$TALK")"
SUBDIR="${SUBDIR#/}"
SUBDIR="${SUBDIR%/}"
[ -n "$MSG" ] || MSG="update talk: $SUBDIR"
DEST="$SITE_REPO/$SUBDIR"

run() { if [ "$DRY" = 1 ]; then echo "  [dry-run] $*"; else "$@"; fi; }

echo "talk      : $TALK"
echo "talkMD    : $TALKMD"
echo "python    : $PYTHON  ($PYTHON_NOTE)"
echo "site repo : $SITE_REPO  (branch $BRANCH)"
echo "sub-site  : $SUBDIR/"

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/talkmd-publish.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

# ---------------------------------------------------------------- 1. compile
echo
echo "[1/5] compiling with talkMD …"
if [ "$DRY" = 1 ]; then
  echo "  [dry-run] $PYTHON -m build_slides (config.yaml flags, --live-reload dropped) → $STAGE/index.html"
else
  TALKMD="$TALKMD" TALK="$TALK" STAGE="$STAGE" KEEP_LR="$KEEP_LR" "$PYTHON" - <<'PY'
import os, subprocess, sys, pathlib
talkmd, talk, stage, keep_lr = (os.environ[k] for k in ("TALKMD", "TALK", "STAGE", "KEEP_LR"))
sys.path.insert(0, os.path.join(talkmd, "tools"))
from helper import load_config, cfg_build_args          # talkMD's own config → CLI mapping

cfg_path = pathlib.Path(talk) / "config.yaml"
cfg = load_config(cfg_path) if cfg_path.exists() else {}
args = [a for a in cfg_build_args(cfg) if a != "--live-reload"] if keep_lr != "1" else cfg_build_args(cfg)

src = pathlib.Path(talk) / str(cfg.get("input", "slides.md"))
out = pathlib.Path(stage) / "index.html"
cmd = [sys.executable, os.path.join(talkmd, "tools", "build_slides.py"),
       "--input", str(src), "--output", str(out)] + args
print("  " + " ".join(cmd))
subprocess.run(cmd, check=True)
if not out.exists():
    sys.exit("ERROR: build produced no index.html")
print(f"  built {out.stat().st_size/1024:.0f} KB")
PY
fi

# A deck whose source has list items must end up containing <ul>: without the
# `markdown` package build_slides.py emits literal "*" bullets (plus different
# paragraph/float geometry) and gives no other sign of trouble — fail loudly.
if [ "$DRY" = 0 ] && [ "$ALLOW_DEGRADED" = 0 ]; then
  if grep -qE '^[[:space:]]*([*+-]|[0-9]+\.)[[:space:]]' "$TALK/slides.md" && ! grep -q '<ul' "$STAGE/index.html"; then
    echo "ERROR: slides.md has list items but the built deck contains no <ul> → the build" >&2
    echo "       used the Markdown-less fallback renderer (interpreter: $PYTHON)." >&2
    echo "       Nothing was published; install python-markdown or set PYTHON=… ." >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------- 2. copy
echo
echo "[2/5] copying the deck into $SUBDIR/ …"
run mkdir -p "$DEST"
# everything that belongs to the deck: images/, videos, stray figures — but not personal config
run rsync -a --delete --exclude 'config.yaml' --exclude '*.md' --exclude '.DS_Store' --exclude '__pycache__' "$TALK/" "$DEST/"
[ -f "$TALK/slides.md" ] && run rsync -a "$TALK/slides.md" "$DEST/slides.md"
if [ "$DRY" = 0 ]; then
  rsync -a --delete "$STAGE/_talkmd/" "$DEST/_talkmd/"
  cp "$STAGE/index.html" "$DEST/index.html"
else
  echo "  [dry-run] rsync $STAGE/_talkmd/ → $DEST/_talkmd/   (fresh build wins over any stale copy)"
  echo "  [dry-run] cp $STAGE/index.html → $DEST/index.html"
fi

# ---------------------------------------------------------------- 3. .nojekyll
echo
echo "[3/5] .nojekyll (Jekyll skips folders starting with '_' — _talkmd/ would 404) …"
if [ -f "$SITE_REPO/.nojekyll" ]; then
  echo "  already present"
else
  echo "  → creating $SITE_REPO/.nojekyll"
  run touch "$SITE_REPO/.nojekyll"
fi

# ---------------------------------------------------------------- 4. verify
if [ "$VERIFY" = 1 ] && [ "$DRY" = 1 ]; then
  echo
  echo "[4/5] verify: skipped in --dry-run"
elif [ "$VERIFY" = 1 ]; then
  echo
  echo "[4/5] verifying the sub-site over HTTP …"
  PORT="$("$PYTHON" -c 'import socket
s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
  (
    cd "$SITE_REPO" && "$PYTHON" -m http.server "$PORT" >/dev/null 2>&1 &
    echo $! >"$STAGE/server.pid"
  )
  sleep 2
  SERVER_PID="$(cat "$STAGE/server.pid")"
  fail=0
  check() { # url  label
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$1" || echo 000)"
    if [ "$code" != "200" ]; then
      echo "  ✗ $2 → HTTP $code  ($1)"
      fail=1
    else echo "  ✓ $2"; fi
  }
  check "/$SUBDIR/" "deck page"
  check "/$SUBDIR/_talkmd/reveal/dist/reveal.js" "reveal.js"
  found_css="$(grep -o "_talkmd/styles/[A-Za-z0-9_.-]*\.css" "$DEST/index.html" | sort -u | head -3 || true)"
  if [ -n "$found_css" ]; then
    while read -r css; do check "/$SUBDIR/$css" "stylesheet $css"; done <<<"$found_css"
  fi
  while read -r img; do
    check "/$SUBDIR/$img" "asset $img"
  done < <(grep -o 'src="images/[^"]*"' "$DEST/index.html" | sed 's/^src="//; s/"$//' | sort -u | head -40)
  if "$PYTHON" -c 'import playwright' 2>/dev/null; then
    "$PYTHON" - "$PORT" "$SUBDIR" <<'PY' || fail=1
import sys
from playwright.sync_api import sync_playwright
port, subdir = sys.argv[1], sys.argv[2]
url = f"http://127.0.0.1:{port}/{subdir}/"
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", args=["--no-sandbox", "--disable-dev-shm-usage"])
    pg = b.new_page(viewport={"width": 1600, "height": 900})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(url, wait_until="load"); pg.wait_for_timeout(3000)
    info = pg.evaluate("""() => ({
        reveal: typeof window.Reveal,
        slides: document.querySelectorAll('.reveal .slides > section').length,
        broken: [...document.querySelectorAll('img')].filter(i => !(i.naturalWidth > 0)).map(i => i.getAttribute('src')),
        videos: document.querySelectorAll('video').length,
    })""")
    print(f"  render: reveal={info['reveal']} slides={info['slides']} videos={info['videos']} broken_images={info['broken'][:5]}")
    if errs: print("  page errors:", errs[:2])
    ok = info["reveal"] == "function" and info["slides"] > 0 and not info["broken"] and not errs
    print("  ✓ headless render OK" if ok else "  ✗ headless render FAILED")
    b.close()
    sys.exit(0 if ok else 1)
PY
  else
    echo "  (playwright not importable — skipped the headless render check)"
  fi
  kill "$SERVER_PID" 2>/dev/null || true
  [ "$fail" = 0 ] || {
    echo "  ✗ verification failed — nothing committed"
    exit 1
  }
else
  echo
  echo "[4/5] verify: skipped"
fi

# ---------------------------------------------------------------- 5. git
echo
echo "[5/5] git …"
run git -C "$SITE_REPO" add "$SUBDIR" .nojekyll
if [ "$DRY" = 0 ] && git -C "$SITE_REPO" diff --cached --quiet -- "$SUBDIR" .nojekyll; then
  echo "  nothing changed in the working tree — already up to date"
else
  run git -C "$SITE_REPO" commit -q -m "$MSG" -- "$SUBDIR" .nojekyll
  if [ "$DRY" = 1 ]; then echo "  [dry-run] would commit: $MSG"; else echo "  committed: $MSG"; fi
fi
if [ "$PUSH" = 1 ]; then
  run git -C "$SITE_REPO" push origin "$BRANCH"
  if [ "$DRY" = 1 ]; then echo "  [dry-run] would push to origin/$BRANCH"; else echo "  pushed to origin/$BRANCH"; fi
else
  echo "  --no-push: commit left local (run: git -C \"$SITE_REPO\" push origin $BRANCH)"
fi

# ---------------------------------------------------------------- url
remote="$(git -C "$SITE_REPO" remote get-url origin 2>/dev/null || true)"
echo
case "$remote" in
*github.com[:/]*)
  slug="$(sed -E 's#^.*[:/]([^/]+)/([^/]+)$#\1/\2#' <<<"${remote%.git}")"
  owner="${slug%%/*}"
  repo="${slug##*/}"
  if [ "$repo" = "$owner.github.io" ]; then url="https://$owner.github.io/$SUBDIR/"; else url="https://$owner.github.io/$repo/$SUBDIR/"; fi
  echo "done. GitHub Pages usually updates within ~1 minute:"
  echo "  $url"
  ;;
*)
  echo "done. Remote \"$remote\" is not a github.com URL, so no Pages URL guessed."
  echo "  local preview: file://$DEST/index.html"
  ;;
esac
