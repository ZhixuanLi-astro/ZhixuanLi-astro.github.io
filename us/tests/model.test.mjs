import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, appendRecord, reverseRecord, scoreFor, validateState, chartSeries, rangeStart, dayKey } from '../model.js';

const base = () => newState(80, '2026-10-01T00:00:00.000Z');
const add = (state, delta, person = 'her', extra = {}) => appendRecord(state, { person, delta, reason: '一个小小的日常', createdAt: '2026-10-02T10:00:00.000Z', ...extra });

test('independent ledgers and exact boundary scores', () => {
  let state = add(base(), 20); assert.equal(scoreFor(state, 'her'), 100); assert.equal(scoreFor(state, 'him'), 80);
  assert.throws(() => add(state, 1), /0～100/);
  state = add(state, -100); assert.equal(scoreFor(state, 'her'), 0); assert.throws(() => add(state, -1), /0～100/);
});
test('reject zero, fractions, missing reasons, and invalid recipients without mutation', () => {
  const state = base();
  for (const delta of [0, .5, NaN, Infinity, 101]) assert.throws(() => add(state, delta));
  assert.throws(() => add(state, 1, 'other')); assert.throws(() => add(state, 1, 'her', { reason: '  ' }));
  assert.throws(() => add(state, 1, 'her', { reason: '字'.repeat(301) })); assert.equal(state.records.length, 0);
});
test('undo preserves original and produces exactly one compensating record', () => {
  const state = add(base(), 8), original = state.records[0];
  const undone = reverseRecord(state, original.id); assert.equal(scoreFor(undone, 'her'), 80); assert.equal(undone.records.length, 2);
  assert.deepEqual(undone.records[0], original); assert.equal(undone.records[1].undoOf, original.id);
  assert.throws(() => reverseRecord(undone, original.id), /已经撤销/);
  assert.throws(() => reverseRecord(undone, undone.records[1].id), /不能撤销/);
});
test('undo refuses a later boundary violation', () => {
  const first = add(base(), -10); const state = add(first, 30);
  assert.equal(scoreFor(state, 'her'), 100); assert.throws(() => reverseRecord(state, first.records[0].id), /0～100/);
});
test('request ids are idempotent and timestamps remain ordered', () => {
  const state = add(base(), 5, 'her', { id: 'retry' });
  assert.equal(add(state, 5, 'her', { id: 'retry' }), state);
  assert.throws(() => add(state, 6, 'her', { id: 'retry' }), /标识已被使用/);
  const next = add(state, 2); assert.ok(Date.parse(next.records[1].createdAt) > Date.parse(next.records[0].createdAt));
});
test('undo does not split emoji characters at the reason limit', () => {
  const state = add(base(), 1, 'her', { reason: 'a' + '🌷'.repeat(149) });
  const undone = reverseRecord(state, state.records[0].id);
  const reason = undone.records.at(-1).reason;
  assert.ok(reason.length <= 300); assert.equal(reason.isWellFormed(), true);
});
test('backup validates every intermediate balance, duplicate ids, and forged reversals', () => {
  const state = add(base(), 5); assert.deepEqual(validateState(JSON.parse(JSON.stringify(state))), state);
  const duplicate = structuredClone(state); duplicate.records.push(duplicate.records[0]); assert.throws(() => validateState(duplicate));
  const overflow = structuredClone(state); overflow.records[0].delta = 30; assert.throws(() => validateState(overflow));
  const forged = add(state, -5, 'her'); forged.records[1].undoOf = 'missing'; assert.throws(() => validateState(forged));
});
test('range baseline includes all earlier entries and chart ends at the actual score', () => {
  let state = add(base(), 5);
  state = add(state, -2, 'her', { createdAt: '2026-10-20T10:00:00Z' });
  const points = chartSeries(state, 'her', Date.parse('2026-10-10T00:00:00Z'), Date.parse('2026-10-24T00:00:00Z'));
  assert.equal(points[0].score, 85); assert.equal(points.at(-1).score, 83); assert.equal(points.length, 3);
});
test('calendar ranges use Shanghai dates around midnight', () => {
  const now = Date.parse('2026-10-23T17:00:00Z'); assert.equal(dayKey(now), '2026-10-24');
  assert.equal(rangeStart('7', base(), now), Date.parse('2026-10-17T16:00:00Z'));
  assert.equal(rangeStart('all', base(), now), Date.parse(base().createdAt));
});
