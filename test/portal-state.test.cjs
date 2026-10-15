'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeQuery, requestQuery, sameFilters, createSession, opColor } = require('../public/portal-state.js');

const day = '2026-10-15';
const committed = () => normalizeQuery({ rolling: false, start: '2026-10-01', end: '2026-10-14', keyword: '已提交', line: 'A线', defects: ['焊偏'], page: 3, size: 20 }, 'weld', day);
function request(reason, extra = {}) {
  return requestQuery({ reason, module: 'weld', day, applied: committed(), draft: { ...committed(), keyword: '尚未提交', start: '2026-10-12', line: 'B线' }, page: 4, size: 50, ...extra });
}

test('poll, refresh and route keep the committed filters while controls contain a draft', () => {
  for (const reason of ['poll', 'manual', 'route', 'initial', 'login']) assert.deepEqual(request(reason), committed(), reason);
});

test('an explicit query or drill commits a new independent snapshot', () => {
  const draft = { ...committed(), keyword: '新关键词', line: 'B线', defects: ['焊穿'], page: 1 };
  for (const reason of ['filter', 'drill', 'view']) {
    const result = request(reason, { draft });
    assert.equal(result.keyword, '新关键词');assert.equal(result.line, 'B线');assert.equal(result.page, 1);
    result.defects.push('独立快照');assert.deepEqual(draft.defects, ['焊穿']);
  }
});

test('paging changes only the committed page and size, never applies edited filters', () => {
  const result = request('page');
  assert.deepEqual(result, { ...committed(), page: 4, size: 50 });
});

test('today rolls over in Shanghai date supplied by the caller; a custom range stays fixed', () => {
  const applied = normalizeQuery({ rolling: true, keyword: '持续筛选', page: 2 }, 'weld', '2026-10-14');
  const result = request('poll', { applied });
  assert.equal(result.start, day);assert.equal(result.end, day);assert.equal(result.keyword, '持续筛选');assert.equal(result.page, 2);
  assert.equal(request('poll').start, '2026-10-01');
  assert.equal(request('poll').end, '2026-10-14');
});

test('draft detection ignores pagination but detects keyword, date, and defect changes', () => {
  assert.equal(sameFilters(committed(), { ...committed(), page: 9, size: 100 }, day), true);
  for (const change of [{ keyword: '新词' }, { end: day }, { defects: [] }]) assert.equal(sameFilters(committed(), { ...committed(), ...change }, day), false);
});

test('session query state is account scoped, allowlisted and cleared on logout', () => {
  const store = new Map(), storage = { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) };
  const first = createSession(storage);
  first.write('employee-a', { weld: { query: { ...committed(), token: 'must-not-store', rows: ['private result'] }, polling: false, interval: 60, history: [committed()] } }, day);
  first.write('employee-b', { alarm: { query: normalizeQuery({ keyword: 'B only' }, 'alarm', day), polling: true } }, day);
  const reopened = createSession(storage), a = reopened.read('employee-a', day), b = reopened.read('employee-b', day);
  assert.equal(a.weld.query.page, 3);assert.equal(a.weld.query.keyword, '已提交');assert.equal(a.weld.polling, false);assert.equal(a.weld.interval, 60);assert.equal(a.weld.history.length, 1);
  assert.equal(b.weld, undefined);assert.equal(b.alarm.query.keyword, 'B only');
  assert.equal([...store.values()].join('').includes('must-not-store'), false);
  assert.equal([...store.values()].join('').includes('private result'), false);
  reopened.clear('employee-a');assert.deepEqual(reopened.read('employee-a', day), {});assert.equal(reopened.read('employee-b', day).alarm.query.keyword, 'B only');
});

test('session state tolerates corrupt, blocked and anonymous storage', () => {
  let writes = 0;
  const corrupt = createSession({ getItem: () => '{bad', setItem: () => { writes++; }, removeItem: () => {} });
  assert.deepEqual(corrupt.read('employee', day), {});corrupt.write(null, { weld: { query: committed() } }, day);assert.equal(writes, 0);
  const blocked = createSession({ getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('blocked'); }, removeItem: () => { throw Error('blocked'); } });
  assert.deepEqual(blocked.read('employee', day), {});assert.doesNotThrow(() => blocked.write('employee', { weld: { query: committed() } }, day));assert.doesNotThrow(() => blocked.clear('employee'));
});

test('OP colors depend on station identity rather than position or line ranking', () => {
  const firstLine = ['OP120', 'OP130', 'OP140'].map(opColor);
  const secondLine = ['OP140', 'OP120', 'OP130'].map(opColor);
  assert.equal(firstLine[0], secondLine[1]);assert.equal(firstLine[1], secondLine[2]);assert.equal(firstLine[2], secondLine[0]);
  assert.equal(opColor(' op120 '), opColor('OP120'));assert.equal(opColor('其他'), '#aeb7c5');
});
