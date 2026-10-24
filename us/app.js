import { config } from './config.js?v=1';
import { newState, scoreFor, validateState, dayKey, rangeStart, summarize, chartSeries } from './model.js?v=1';
import { createLocalStore, STORAGE_KEY } from './storage.js?v=1';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const names = config.names;
const giver = person => names[person === 'her' ? 'him' : 'her'];
const directionLabel = person => `${giver(person)} → ${names[person]}`;
const signed = n => n > 0 ? `+${n}` : String(n);
const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: config.timeZone, month: 'long', day: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: config.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fullFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: config.timeZone, year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const cloudConfigured = Boolean(config.supabaseUrl && config.supabasePublicKey);
let state = newState(config.initialScore), store, ready = false, busy = false;
let page = 'home', historyPerson = 'her', range = '30', visibleCount = 30;
let activeSeries = new Set(['her', 'him']), toastTimer, unsubscribe, revision = 0;

function toast(text) {
  clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4200);
}

function explain(error) {
  const message = error?.message || '暂时没有成功，请稍后再试。';
  if (/quota/i.test(message)) return '浏览器存储空间不足，请先备份记录并释放空间。';
  if (/failed to fetch|network|load failed/i.test(message)) return '暂时连接不上云端，请检查网络后重试。';
  if (/invalid login credentials/i.test(message)) return '邮箱或密码不正确，请再试一次。';
  if (/JWT|session|not authenticated/i.test(message)) return '登录已过期，请重新登录。';
  return message;
}

function fatal(error) {
  ready = false;
  $('#fatal-message').textContent = `暂时无法读取记录：${explain(error)}。原有记录没有被覆盖。`;
  $('#fatal-banner').hidden = false;
  $('#recovery-backup').hidden = cloudConfigured;
  updateForms();
}

function confirmAction(title, text, button = '确认') {
  const dialog = $('#confirm-dialog');
  $('#confirm-title').textContent = title; $('#confirm-text').textContent = text; $('#confirm-ok').textContent = button;
  return new Promise(resolve => {
    const finish = answer => { dialog.close(); cleanup(); resolve(answer); };
    const ok = () => finish(true), cancel = () => finish(false), escape = e => { e.preventDefault(); finish(false); };
    const cleanup = () => { $('#confirm-ok').removeEventListener('click', ok); $('#confirm-cancel').removeEventListener('click', cancel); dialog.removeEventListener('cancel', escape); };
    $('#confirm-ok').addEventListener('click', ok); $('#confirm-cancel').addEventListener('click', cancel); dialog.addEventListener('cancel', escape);
    dialog.showModal(); $('#confirm-cancel').focus();
  });
}

function updateForms() {
  $$('form[data-person]').forEach(form => {
    const person = form.dataset.person;
    const ownScore = cloudConfigured && store?.profile?.person === person;
    const locked = !ready || ownScore;
    form.classList.toggle('locked', locked);
    form.querySelectorAll('input, textarea, button').forEach(el => { el.disabled = locked || busy; });
    form.querySelector('.submit-button span').textContent = ownScore ? '这张卡由对方来记录' : !ready && cloudConfigured ? '登录后记一笔' : busy ? '正在记下…' : '记下这一笔';
    const raw = form.elements.delta.value.trim();
    const preview = $(`#preview-${person}`);
    preview.classList.remove('invalid');
    if (!raw) { preview.textContent = '每一分，都值得被认真对待。'; return; }
    const delta = Number(raw), next = scoreFor(state, person) + delta;
    const valid = /^[+-]?\d+$/.test(raw) && delta !== 0 && Math.abs(delta) <= 100 && next >= 0 && next <= 100;
    preview.textContent = valid ? `${scoreFor(state, person)} ${delta > 0 ? '+' : '−'} ${Math.abs(delta)} = ${next} 分` : '请输入非零整数，让总分保持在 0～100 分。';
    preview.classList.toggle('invalid', !valid);
  });
}

function updateCards() {
  ['her', 'him'].forEach(person => {
    const heading = $(`[data-direction="${person}"]`); heading.replaceChildren(document.createTextNode(giver(person) + ' '));
    const arrow = document.createElement('span'); arrow.textContent = '→'; heading.append(arrow, document.createTextNode(' ' + names[person]));
    $(`[data-score-label="${person}"]`).textContent = `${names[person]}的当前分数`;
    const score = scoreFor(state, person), output = $(`[data-score="${person}"]`);
    output.textContent = score; output.setAttribute('aria-label', `${names[person]}的当前分数：${score}`);
    const meter = $(`[data-meter="${person}"]`); meter.setAttribute('aria-valuenow', score); meter.setAttribute('aria-label', `${names[person]}的分数进度`); meter.firstElementChild.style.width = `${score}%`;
    const last = state.records.filter(r => r.person === person).at(-1);
    $(`[data-last="${person}"]`).textContent = last ? `最近一笔 ${signed(last.delta)} 分` : '从今天开始，慢慢记录';
    $(`[data-legend="${person}"]`).textContent = `${names[person]}的分数`;
    $(`[data-history-person="${person}"]`).textContent = directionLabel(person);
  });
  updateForms();
}

function renderHistory() {
  $$('[data-history-person]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.historyPerson === historyPerson)));
  const rows = state.records.filter(r => r.person === historyPerson), list = $('#history-list');
  $('#history-count').textContent = `${rows.filter(r => !r.undoOf).length} 条记录`;
  $('#history-direction').textContent = `${giver(historyPerson)}给${names[historyPerson]}的评分记录`;
  $('#history-score').textContent = scoreFor(state, historyPerson);
  list.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement('div'); empty.className = 'empty-state';
    empty.innerHTML = '<div class="empty-symbol" aria-hidden="true">✧</div><h3>故事，从第一笔开始。</h3><p>记下一个小小的心动，或一次认真说出的在意。</p><a href="#home">去记一笔 ↗</a>';
    list.append(empty); $('#more-records').hidden = true; return;
  }
  let running = state.initialScore, group = '';
  const undone = new Set(rows.filter(r => r.undoOf).map(r => r.undoOf));
  const withScores = rows.map(r => { const before = running; running += r.delta; return { ...r, before, after: running }; });
  withScores.reverse().slice(0, visibleCount).forEach(r => {
    const key = dayKey(r.createdAt, config.timeZone);
    if (key !== group) { const heading = document.createElement('h3'); heading.className = 'history-date'; heading.textContent = fullFormat.format(new Date(r.createdAt)).split(' ')[0]; list.append(heading); group = key; }
    const row = document.createElement('article'); row.className = `record-row${undone.has(r.id) ? ' record-undone' : ''}`;
    const delta = document.createElement('div'); delta.className = `record-delta${r.undoOf ? ' reversal' : r.delta < 0 ? ' negative' : ''}`; delta.textContent = signed(r.delta);
    const content = document.createElement('div'), reason = document.createElement('p'); reason.className = 'record-reason'; reason.textContent = r.reason;
    const meta = document.createElement('div'); meta.className = 'record-meta';
    const time = document.createElement('time'); time.dateTime = r.createdAt; time.textContent = timeFormat.format(new Date(r.createdAt)); meta.append(time);
    if (r.undoOf || undone.has(r.id)) { const badge = document.createElement('span'); badge.textContent = r.undoOf ? '撤销抵消' : '已撤销'; meta.append(badge); }
    content.append(reason, meta);
    const actions = document.createElement('div'); actions.className = 'record-actions';
    const change = document.createElement('div'); change.textContent = `${r.before} → ${r.after} 分`; actions.append(change);
    if (!r.undoOf && !undone.has(r.id) && (!cloudConfigured || store?.profile?.person !== r.person)) {
      const undo = document.createElement('button'); undo.className = 'undo-button'; undo.type = 'button'; undo.textContent = '撤销'; undo.setAttribute('aria-label', `撤销这笔 ${signed(r.delta)} 分的记录`);
      undo.addEventListener('click', () => undoEntry(r)); actions.append(undo);
    }
    row.append(delta, content, actions); list.append(row);
  });
  $('#more-records').hidden = rows.length <= visibleCount;
}

async function undoEntry(record) {
  if (busy || !ready) return;
  const ok = await confirmAction('撤销这笔记录？', `将抵消「${record.reason}」带来的 ${signed(record.delta)} 分。原记录会保留，并标注为已撤销。`, '确认撤销');
  if (!ok) return;
  await mutate(() => store.undo(record.id), '已撤销，原记录已保留。');
}

function renderSummary() {
  const start = rangeStart(range, state, Date.now(), config.timeZone), summary = $('#stats-summary'); summary.replaceChildren();
  ['her', 'him'].forEach(person => {
    const stats = summarize(state, person, start), card = document.createElement('article'); card.className = 'stat-card';
    const title = document.createElement('h3'); title.textContent = directionLabel(person); card.append(title);
    const values = document.createElement('div'); values.className = 'stat-values';
    [['累计加分', `+${stats.plus}`], ['累计减分', `−${stats.minus}`], ['净变化', signed(stats.net)]].forEach(([label, value]) => { const item = document.createElement('div'), small = document.createElement('small'), strong = document.createElement('strong'); small.textContent = label; strong.textContent = value; item.append(small, strong); values.append(item); });
    card.append(values); summary.append(card);
  });
}

function drawChart() {
  if (page !== 'stats') return;
  const svg = $('#score-chart'), width = svg.getBoundingClientRect().width, height = svg.getBoundingClientRect().height;
  if (width < 100) return;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.replaceChildren(); $('#chart-tooltip').hidden = true;
  const ns = 'http://www.w3.org/2000/svg';
  const make = (tag, attrs, text) => { const node = document.createElementNS(ns, tag); for (const [key, val] of Object.entries(attrs)) node.setAttribute(key, val); if (text !== undefined) node.textContent = text; svg.append(node); return node; };
  make('title', {}, '双方的分数变化，满分 100 分');
  const left = 36, right = 17, top = 24, bottom = 35;
  const end = Math.max(Date.now(), Date.parse(state.records.at(-1)?.createdAt || state.createdAt));
  const selectedStart = rangeStart(range, state, end, config.timeZone);
  const start = Math.min(Math.max(selectedStart, Date.parse(state.createdAt)), end - 3600000);
  const x = time => left + (time - start) / (end - start) * (width - left - right), y = score => top + (100 - score) / 100 * (height - top - bottom);
  const frameBottom = height - bottom;
  const colors = { her: 'var(--rose)', him: 'var(--sage)' };
  make('text', { x: left - 23, y: 11, class: 'axis-title' }, '分数');
  [0, 25, 50, 75, 100].forEach(score => { make('line', { x1: left, x2: width - right, y1: y(score), y2: y(score), stroke: 'var(--line)', 'stroke-width': .8 }); make('text', { x: left - 9, y: y(score) + 3, 'text-anchor': 'end' }, score); });
  const tickCount = width < 420 ? 3 : 5;
  const axisFormat = end - start < 86400000 ? timeFormat : new Intl.DateTimeFormat('zh-CN', { timeZone: config.timeZone, month: 'numeric', day: 'numeric' });
  for (let i = 0; i < tickCount; i++) { const time = start + (end - start) * i / (tickCount - 1); make('text', { x: x(time), y: height - 14, 'text-anchor': i === 0 ? 'start' : i === tickCount - 1 ? 'end' : 'middle' }, axisFormat.format(new Date(time))); }
  $('#chart-dates').textContent = `${dateFormat.format(new Date(start))} — ${dateFormat.format(new Date(end))}`;
  const series = {};
  ['her', 'him'].forEach(person => {
    series[person] = chartSeries(state, person, start, end);
    if (!activeSeries.has(person)) return;
    const points = series[person];
    // Scores change only when an entry is made; horizontal sections hold the last score.
    const steps = [points[0]];
    for (let i = 1; i < points.length; i++) steps.push({ time: points[i].time, score: points[i - 1].score }, points[i]);
    make('polyline', { points: steps.map(p => `${x(p.time)},${y(p.score)}`).join(' '), fill: 'none', stroke: colors[person], 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', ...(person === 'him' ? { 'stroke-dasharray': '6 5' } : {}) });
    const marks = points.filter(p => p.record);
    // Preserve the entire line for long diaries; reduce only the decorative markers.
    const stride = Math.max(1, Math.ceil(marks.length / 100));
    marks.filter((_, i) => i % stride === 0).forEach(p => make(person === 'her' ? 'circle' : 'rect', person === 'her' ? { cx: x(p.time), cy: y(p.score), r: 3.5, fill: colors[person], stroke: 'var(--paper)', 'stroke-width': 1.5 } : { x: x(p.time) - 3.2, y: y(p.score) - 3.2, width: 6.4, height: 6.4, rx: 1, fill: colors[person], stroke: 'var(--paper)', 'stroke-width': 1.3 }));
  });
  const guide = make('line', { x1: 0, x2: 0, y1: top, y2: frameBottom, stroke: '#b6aa9b', 'stroke-dasharray': '3 4', visibility: 'hidden' });
  const markers = Object.fromEntries(['her', 'him'].map(person => [person, make('circle', { cx: 0, cy: 0, r: 4, fill: colors[person], stroke: 'var(--paper)', 'stroke-width': 2, visibility: 'hidden' })]));
  const overlay = make('rect', { x: left, y: top, width: width - left - right, height: frameBottom - top, fill: 'transparent', 'aria-hidden': 'true' });
  const showAt = clientX => {
    const bounds = svg.getBoundingClientRect(), px = Math.max(left, Math.min(width - right, clientX - bounds.left));
    const time = start + (px - left) / (width - left - right) * (end - start);
    guide.setAttribute('x1', px); guide.setAttribute('x2', px); guide.setAttribute('visibility', 'visible');
    const lines = [fullFormat.format(new Date(time))];
    ['her', 'him'].forEach(person => {
      if (!activeSeries.has(person)) return;
      const points = series[person]; let lo = 0, hi = points.length - 1;
      while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (points[mid].time <= time) lo = mid; else hi = mid - 1; }
      const a = points[lo], b = points[Math.min(lo + 1, points.length - 1)];
      const value = a.score;
      markers[person].setAttribute('cx', px); markers[person].setAttribute('cy', y(value)); markers[person].setAttribute('visibility', 'visible');
      const nearest = Math.abs(time - a.time) < Math.abs(time - b.time) ? a : b;
      lines.push(`${names[person]}：${value} 分`);
      if (nearest.record && Math.abs(x(nearest.time) - px) < 16) lines.push(`${signed(nearest.record.delta)} · ${nearest.record.reason}`);
    });
    const tip = $('#chart-tooltip'); tip.textContent = lines.join('\n'); tip.hidden = false;
    tip.style.top = '22px'; tip.style.left = `${Math.max(0, Math.min(width - tip.offsetWidth, px + 14))}px`;
  };
  const hide = () => { guide.setAttribute('visibility', 'hidden'); Object.values(markers).forEach(m => m.setAttribute('visibility', 'hidden')); $('#chart-tooltip').hidden = true; };
  let pinned = false;
  overlay.addEventListener('pointermove', event => { if (!pinned) showAt(event.clientX); });
  overlay.addEventListener('pointerleave', () => { if (!pinned) hide(); });
  overlay.addEventListener('click', event => { pinned = !pinned; if (pinned) showAt(event.clientX); else hide(); });
  $('#chart-caption').textContent = state.records.length ? '轻触或移动到曲线上查看分数，点一下可固定详情。每一段变化，都对应一笔记录。' : `从 ${state.initialScore} 分出发，第一笔小事会成为轨迹的起点。`;
}

function render() { updateCards(); renderHistory(); renderSummary(); drawChart(); }

function navigate() {
  const candidate = location.hash.slice(1); page = ['home', 'history', 'stats'].includes(candidate) ? candidate : 'home';
  ['home', 'history', 'stats'].forEach(p => { $(`#page-${p}`).hidden = p !== page; });
  $$('[data-page]').forEach(a => { if (a.dataset.page === page) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  document.title = `${{ home: '记一笔', history: '我们的记录', stats: '分数轨迹' }[page]} · 两个人的小宇宙`;
  if (page === 'stats') { renderSummary(); drawChart(); }
}

async function mutate(action, message) {
  if (busy || !ready) return false;
  busy = true; revision++; updateForms();
  try { const next = await action(); state = next; revision++; render(); toast(message); return true; }
  catch (error) { toast(explain(error)); return false; }
  finally { busy = false; updateForms(); }
}

function download(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' })), anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function backup() {
  if (!ready) { toast('读取记录后才能备份。'); return; }
  try { const latest = await store.load(); state = latest; download(JSON.stringify(latest, null, 2), `我们的小宇宙-${dayKey(Date.now(), config.timeZone)}.json`); toast('备份已下载，请好好保存。'); }
  catch (error) { toast(explain(error)); }
}

function updateAccount() {
  const signedIn = cloudConfigured && ready && store?.profile;
  $('#local-description').hidden = cloudConfigured; $('#login-form').hidden = !cloudConfigured || Boolean(signedIn); $('#signed-in').hidden = !signedIn;
  $('#storage-label').textContent = cloudConfigured ? signedIn ? '两人同步' : '登录同步' : '本机记录';
  $('#storage-footnote').textContent = cloudConfigured ? signedIn ? '你们的记录已连接到共同空间。' : '登录后查看你们的共同记录。' : '记录保存在当前浏览器，请定期备份。';
  $('#import-button').hidden = cloudConfigured;
  if (signedIn) $('#signed-in-name').textContent = `你好，${names[store.profile.person]}。`;
}

$$('form[data-person]').forEach(form => {
  const person = form.dataset.person;
  form.addEventListener('input', () => { $(`[data-count="${person}"]`).textContent = `${form.elements.reason.value.length} / 300`; $(`#error-${person}`).textContent = ''; form.elements.delta.removeAttribute('aria-invalid'); form.elements.reason.removeAttribute('aria-invalid'); updateForms(); });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !ready) return;
    const raw = form.elements.delta.value.trim(), delta = Number(raw), reason = form.elements.reason.value.trim();
    let error = '', focus;
    if (!/^[+-]?\d+$/.test(raw) || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100) { error = '请输入非零整数，例如 +5 或 -3。'; focus = form.elements.delta; }
    else if (!reason) { error = '写下理由，再把这一笔记下来吧。'; focus = form.elements.reason; }
    else if (scoreFor(state, person) + delta < 0 || scoreFor(state, person) + delta > 100) { error = '调整后会超出 0～100 分，请修改分数。'; focus = form.elements.delta; }
    if (error) { $(`#error-${person}`).textContent = error; focus.setAttribute('aria-invalid', 'true'); focus.focus(); return; }
    // Keep this id for a network retry, preventing a lost response from creating duplicates.
    const signature = JSON.stringify({ delta, reason });
    if (form.dataset.signature !== signature) { form.dataset.signature = signature; form.dataset.requestId = crypto.randomUUID(); }
    const success = await mutate(() => store.add({ person, delta, reason, id: form.dataset.requestId }), '记下了，这一刻也被好好收藏。');
    if (success) { form.reset(); delete form.dataset.signature; delete form.dataset.requestId; $(`[data-count="${person}"]`).textContent = '0 / 300'; updateForms(); }
  });
});
$$('[data-history-person]').forEach(button => button.addEventListener('click', () => { historyPerson = button.dataset.historyPerson; visibleCount = 30; renderHistory(); }));
$('#more-records').addEventListener('click', () => { visibleCount += 30; renderHistory(); });
$$('[data-range]').forEach(button => button.addEventListener('click', () => { range = button.dataset.range; $$('[data-range]').forEach(b => b.setAttribute('aria-pressed', String(b === button))); renderSummary(); drawChart(); }));
$$('[data-series]').forEach(button => button.addEventListener('click', () => { const person = button.dataset.series; if (activeSeries.has(person)) { if (activeSeries.size === 1) return; activeSeries.delete(person); } else activeSeries.add(person); button.setAttribute('aria-pressed', String(activeSeries.has(person))); drawChart(); }));
$('#account-button').addEventListener('click', () => { updateAccount(); $('#account-dialog').showModal(); });
$$('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$('#backup-button').addEventListener('click', backup); $('#dialog-backup').addEventListener('click', backup);
$('#import-button').addEventListener('click', () => { if (!ready || busy) return; $('#import-file').click(); });
$('#import-file').addEventListener('change', async event => {
  const file = event.target.files[0]; event.target.value = ''; if (!file || !ready || busy) return;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('备份文件过大，请选择 2 MB 以内的 JSON 文件。');
    const imported = validateState(JSON.parse(await file.text()));
    const ok = await confirmAction('用备份替换本机记录？', `备份里有 ${imported.records.length} 笔记录，当前有 ${state.records.length} 笔。导入会替换当前记录，建议先备份现在的内容。`, '确认导入');
    if (ok) await mutate(() => store.import(imported), '备份已导入，故事接着写。');
  } catch (error) { toast(explain(error)); }
});
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget, submit = form.querySelector('button'); submit.disabled = true; $('#login-error').textContent = '';
  try { await store.signIn(form.elements.email.value.trim(), form.elements.password.value); state = await store.load(); revision++; ready = true; $('#fatal-banner').hidden = true; form.reset(); render(); updateAccount(); $('#account-dialog').close(); toast('欢迎回到你们的小宇宙。'); }
  catch (error) { $('#login-error').textContent = explain(error); }
  finally { submit.disabled = false; }
});
$('#logout-button').addEventListener('click', async () => {
  try { revision++; await store.signOut(); ready = false; state = newState(config.initialScore); render(); updateAccount(); $('#account-dialog').close(); toast('已退出登录。'); } catch (error) { toast(explain(error)); }
});
$('#recovery-backup').addEventListener('click', () => { try { download(localStorage.getItem(STORAGE_KEY) || '{}', '小宇宙-原始记录.json'); } catch (error) { toast(explain(error)); } });
$('#retry-button').addEventListener('click', () => location.reload());
window.addEventListener('hashchange', navigate);
new ResizeObserver(() => drawChart()).observe($('#chart-container'));
window.addEventListener('pagehide', () => unsubscribe?.(), { once: true });

async function initialize() {
  navigate(); render();
  try {
    if (Boolean(config.supabaseUrl) !== Boolean(config.supabasePublicKey)) throw new Error('同步配置不完整，请同时填写项目 URL 和公开 key。');
    store = cloudConfigured ? await (await import('./cloud.js?v=1')).createCloudStore(config) : createLocalStore(config.initialScore);
    if (!cloudConfigured || await store.session()) { state = await store.load(); ready = true; }
    render(); updateAccount();
    unsubscribe = store.subscribe(async () => {
      if (!ready || busy) return;
      const currentRevision = revision;
      try { const next = await store.load(); if (!ready || busy || currentRevision !== revision) return; state = next; render(); $('#storage-label').textContent = cloudConfigured ? '两人同步' : '本机记录'; }
      catch (error) { if (cloudConfigured) { $('#storage-label').textContent = '同步暂中断'; } else fatal(error); }
    });
    if (cloudConfigured && !ready) $('#account-dialog').showModal();
  } catch (error) { fatal(error); }
}
initialize();
