import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalStore, STORAGE_KEY } from '../storage.js';

const memory = new Map();
let denyWrites = false, queue = Promise.resolve();
globalThis.localStorage = {
  getItem: key => memory.get(key) ?? null,
  setItem: (key, value) => { if (denyWrites) throw new Error('QuotaExceededError'); memory.set(key, value); },
};
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: (_key, action) => { const pending = queue.then(action); queue = pending.catch(() => {}); return pending; } } } });
const record = delta => ({ person: 'her', delta, reason: '测试事务' });

test('new diary persists and concurrent tab writes cannot lose updates', async () => {
  memory.clear(); const a = createLocalStore(80), b = createLocalStore(80);
  await a.load(); await Promise.all([a.add(record(5)), b.add(record(3))]);
  const saved = await a.load(); assert.equal(saved.records.length, 2); assert.equal(JSON.parse(memory.get(STORAGE_KEY)).records.length, 2);
});
test('corrupt diary is never silently replaced', async () => {
  memory.set(STORAGE_KEY, '{broken'); const store = createLocalStore(80);
  await assert.rejects(store.load()); await assert.rejects(store.add(record(1)));
  assert.equal(memory.get(STORAGE_KEY), '{broken');
});
test('failed storage writes preserve the last committed diary', async () => {
  memory.clear(); const store = createLocalStore(80); await store.load(); const before = memory.get(STORAGE_KEY);
  denyWrites = true; await assert.rejects(store.add(record(4)), /Quota/); denyWrites = false;
  assert.equal(memory.get(STORAGE_KEY), before);
});
test('invalid imports do not replace existing records', async () => {
  const store = createLocalStore(80), before = memory.get(STORAGE_KEY);
  await assert.rejects(store.import({ version: 1, records: [] })); assert.equal(memory.get(STORAGE_KEY), before);
});
