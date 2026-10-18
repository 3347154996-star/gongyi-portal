'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),filters=require('../public/shared-filter.js');
test('shortcuts use Shanghai calendar dates, inclusive days, and company weeks',()=>{
  const now=new Date('2026-10-15T17:00:00Z');
  assert.deepEqual(filters.range('today',now),{start:'2026-10-16',end:'2026-10-16'});
  assert.deepEqual(filters.range('week',now),{start:'2026-10-10',end:'2026-10-16'});
  assert.deepEqual(filters.range('month',now),{start:'2026-09-17',end:'2026-10-16'});
  assert.deepEqual(filters.range('companyWeek',now),{start:'2026-10-16',end:'2026-10-22'});
  assert.deepEqual(filters.range('yesterday',now),{start:'2026-10-15',end:'2026-10-15'});
});
test('dates reject impossible days, reversed and one-ended ranges',()=>{
  assert.ok(filters.validateRange('2026-02-30','2026-03-01'));
  assert.ok(filters.validateRange('2026-10-02','2026-10-01'));
  assert.ok(filters.validateRange('','2026-10-01'));
  assert.equal(filters.validateRange('',''),'');
  assert.ok(filters.validateRange('','',{allowEmpty:false}));
});
test('historical and cross-year company weeks remain identifiable after query restore',()=>{
  const now=new Date('2026-10-16T04:00:00Z');
  assert.equal(filters.infer('2026-10-02','2026-10-08',now),'companyWeek');
  assert.equal(filters.infer('2026-12-25','2026-12-31',now),'companyWeek');
  assert.equal(filters.infer('2026-10-03','2026-10-08',now),'custom');
  assert.equal(filters.infer('2026-10-16','2026-10-16',now),'today');
});
