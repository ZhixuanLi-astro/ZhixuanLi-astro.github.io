export const PEOPLE = ['her', 'him'];
export const MAX_REASON = 300;

export function newState(initialScore = 80, now = new Date().toISOString()) {
  if (!Number.isInteger(initialScore) || initialScore < 0 || initialScore > 100) throw new Error('初始分数需要是 0～100 的整数。');
  return { version: 1, initialScore, createdAt: now, records: [] };
}

export function scoreFor(state, person) {
  return state.initialScore + state.records.filter(r => r.person === person).reduce((sum, r) => sum + r.delta, 0);
}

export function validateState(value) {
  if (!value || value.version !== 1 || !Number.isInteger(value.initialScore) || value.initialScore < 0 || value.initialScore > 100 || !Number.isFinite(Date.parse(value.createdAt)) || !Array.isArray(value.records)) throw new Error('记录文件格式不正确。');
  const scores = { her: value.initialScore, him: value.initialScore }, ids = new Map(), reversed = new Set();
  let last = Date.parse(value.createdAt);
  for (const r of value.records) {
    if (!r || typeof r.id !== 'string' || !r.id || ids.has(r.id) || !PEOPLE.includes(r.person) || !Number.isInteger(r.delta) || r.delta === 0 || Math.abs(r.delta) > 100 || typeof r.reason !== 'string' || !r.reason.trim() || r.reason.length > MAX_REASON || !Number.isFinite(Date.parse(r.createdAt)) || Date.parse(r.createdAt) < last) throw new Error('记录文件含有无效或重复的条目。');
    if (r.undoOf) {
      const original = ids.get(r.undoOf);
      if (!original || original.undoOf || reversed.has(original.id) || original.person !== r.person || original.delta !== -r.delta) throw new Error('撤销记录不正确。');
      reversed.add(original.id);
    }
    scores[r.person] += r.delta;
    if (scores[r.person] < 0 || scores[r.person] > 100) throw new Error('记录中的总分超出了 0～100。');
    last = Date.parse(r.createdAt); ids.set(r.id, r);
  }
  return value;
}

export function appendRecord(state, { person, delta, reason, id = crypto.randomUUID(), createdAt = new Date().toISOString(), undoOf = null }) {
  if (!PEOPLE.includes(person)) throw new Error('请选择评分对象。');
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100) throw new Error('请输入非零整数，例如 +5 或 -3。');
  reason = String(reason ?? '').trim();
  if (!reason || reason.length > MAX_REASON) throw new Error('请写下理由，最多 300 字。');
  const existing = state.records.find(r => r.id === id);
  if (existing) {
    if (existing.person === person && existing.delta === delta && existing.reason === reason && existing.undoOf === undoOf) return state;
    throw new Error('记录标识已被使用，请重试。');
  }
  const nextScore = scoreFor(state, person) + delta;
  if (nextScore < 0 || nextScore > 100) throw new Error(`这次调整后会变成 ${nextScore} 分，请让总分保持在 0～100 分。`);
  const lastTime = Date.parse(state.records.at(-1)?.createdAt || state.createdAt);
  createdAt = new Date(Math.max(Date.parse(createdAt), lastTime + 1)).toISOString();
  const next = { ...state, records: [...state.records, { id, person, delta, reason, createdAt, undoOf }] };
  return validateState(next);
}

export function reverseRecord(state, recordId, options = {}) {
  const original = state.records.find(r => r.id === recordId);
  if (!original || original.undoOf) throw new Error('这条记录不能撤销。');
  if (state.records.some(r => r.undoOf === recordId)) throw new Error('这条记录已经撤销。');
  let reason = '撤销：';
  for (const char of original.reason) { if (reason.length + char.length > MAX_REASON) break; reason += char; }
  return appendRecord(state, { ...options, person: original.person, delta: -original.delta, reason, undoOf: recordId });
}

export function dayKey(date, timeZone = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(date));
}

export function rangeStart(range, state, now = Date.now(), timeZone = 'Asia/Shanghai') {
  if (range === 'all') return Date.parse(state.createdAt);
  const today = dayKey(now, timeZone);
  // Calendar subtraction is independent of the host machine's timezone.
  const localMidnight = Date.parse(`${today}T00:00:00+08:00`);
  return localMidnight - (Number(range) - 1) * 86400000;
}

export function summarize(state, person, since = -Infinity) {
  const rows = state.records.filter(r => r.person === person && Date.parse(r.createdAt) >= since);
  return { plus: rows.reduce((n, r) => n + Math.max(0, r.delta), 0), minus: rows.reduce((n, r) => n + Math.max(0, -r.delta), 0), net: rows.reduce((n, r) => n + r.delta, 0), count: rows.length };
}

export function chartSeries(state, person, start, end) {
  let score = state.initialScore;
  for (const r of state.records) if (r.person === person && Date.parse(r.createdAt) < start) score += r.delta;
  const points = [{ time: start, score, record: null }];
  for (const r of state.records) {
    const time = Date.parse(r.createdAt);
    if (r.person === person && time >= start && time <= end) { score += r.delta; points.push({ time, score, record: r }); }
  }
  points.push({ time: end, score, record: null });
  return points;
}
