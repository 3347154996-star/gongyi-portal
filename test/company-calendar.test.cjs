'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const calendar = require('../public/company-calendar.js');

test('company week anchor is KW41 October 2-8 and KW42 October 9-15, Friday through Thursday', () => {
  for (let day = 2; day <= 8; day++) assert.deepEqual(calendar.weekInfo(`2026-10-${String(day).padStart(2,'0')}`), { year: 2026, week: 41, label: 'KW41', key: '2026-KW41', start: '2026-10-02', end: '2026-10-08' });
  for (let day = 9; day <= 15; day++) assert.deepEqual(calendar.weekInfo(`2026-10-${String(day).padStart(2,'0')}`), { year: 2026, week: 42, label: 'KW42', key: '2026-KW42', start: '2026-10-09', end: '2026-10-15' });
  assert.equal(calendar.weekInfo('2026-10-01').label,'KW40'); assert.equal(calendar.weekInfo('2026-10-16').label,'KW43');
  assert.deepEqual(calendar.range(2026,41),calendar.weekInfo('2026-10-02')); assert.deepEqual(calendar.range('2026','42'),calendar.weekInfo('2026-10-15'));
});

test('company weeks cross month and year boundaries under the documented January 1 convention', () => {
  assert.deepEqual(calendar.weekInfo('2026-11-01'), { year: 2026, week: 45, label: 'KW45', key: '2026-KW45', start: '2026-10-30', end: '2026-11-05' });
  assert.deepEqual(calendar.weekInfo('2025-12-26'), { year: 2026, week: 1, label: 'KW01', key: '2026-KW01', start: '2025-12-26', end: '2026-01-01' });
  assert.deepEqual(calendar.weekInfo('2026-12-31'), { year: 2026, week: 53, label: 'KW53', key: '2026-KW53', start: '2026-12-25', end: '2026-12-31' });
  assert.deepEqual(calendar.weekInfo('2027-01-01'), { year: 2027, week: 1, label: 'KW01', key: '2027-KW01', start: '2027-01-01', end: '2027-01-07' });
  assert.deepEqual(calendar.weekInfo('2027-12-31'), { year: 2028, week: 1, label: 'KW01', key: '2028-KW01', start: '2027-12-31', end: '2028-01-06' });
  assert.equal(calendar.weeks(2026).length,53); assert.equal(calendar.weeks(2027).length,52);
});

test('year week lists have no gaps or overlaps and round-trip every day including leap day', () => {
  for (const year of [2024,2025,2026,2027,2028]) {
    const weeks = calendar.weeks(year); assert.ok(weeks.length===52||weeks.length===53);
    for (let index=0; index<weeks.length; index++) {
      const week=weeks[index]; assert.equal(week.week,index+1); assert.equal(week.year,year);
      assert.equal(new Date(week.start+'T00:00:00Z').getUTCDay(),5); assert.equal(new Date(week.end+'T00:00:00Z').getUTCDay(),4);
      assert.equal(calendar.addDays(week.start,6),week.end); assert.deepEqual(calendar.range(year,index+1),week);
      for(let day=0;day<7;day++)assert.deepEqual(calendar.weekInfo(calendar.addDays(week.start,day)),week);
      if(index)assert.equal(calendar.addDays(weeks[index-1].end,1),week.start);
    }
    assert.equal(calendar.addDays(weeks.at(-1).end,1),calendar.weeks(year+1)[0].start);
  }
  assert.equal(calendar.weekInfo('2024-02-29').end,'2024-02-29'); assert.equal(calendar.addDays('2024-02-28',1),'2024-02-29');
});

test('invalid dates and unavailable week numbers are rejected rather than silently rolled forward', () => {
  for (const value of ['2026-02-29','2026-13-01','2026-10-32','2026-1-01','2026-10-15T00:00:00Z','not-a-date',null]) assert.throws(()=>calendar.weekInfo(value),RangeError);
  for (const value of [0,-1,54,1.5,'invalid']) assert.throws(()=>calendar.range(2026,value),RangeError);
  assert.throws(()=>calendar.range(2027,53),RangeError);
});

test('browser and Node exports apply the same company calendar rule', () => {
  const browser=vm.createContext({}); vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/company-calendar.js'),'utf8'),browser);
  for(const day of ['2026-10-02','2026-10-15','2026-12-31','2027-12-31']) assert.deepEqual(JSON.parse(JSON.stringify(browser.PortalCalendar.weekInfo(day))),calendar.weekInfo(day));
});

test('weld trend aggregation can use the same Friday boundaries and company week labels', () => {
  const {buildWeldDashboard}=require('../lib/weld-report.cjs');
  const row=(id,date)=>({id,material:'SYNTHETIC-MATERIAL',materialName:'SYNTHETIC-NAME',qr:'SYNTHETIC-'+id,recordedAt:date,defect:'SYNTHETIC-DEFECT'});
  const options={fieldMap:{material:'material',materialName:'materialName',qr:'qr',recordedAt:'recordedAt',defect:'defect'},weekCount:2,weekStart:calendar.startOfWeek,weekLabel:start=>calendar.weekInfo(start).label};
  const rows=[row('last41','2026-10-08 23:59:59'),row('first42','2026-10-09 00:00:00'),row('last42','2026-10-15 23:59:59'),row('next43','2026-10-16 00:00:00')];
  const before=structuredClone(rows),report=buildWeldDashboard(rows,{...options,startDate:'2026-10-02',endDate:'2026-10-15'});
  assert.deepEqual(report.trend.map(w=>({label:w.label,start:w.startDate,end:w.endDate,count:w.recordCount})),[{label:'KW41',start:'2026-10-02',end:'2026-10-08',count:1},{label:'KW42',start:'2026-10-09',end:'2026-10-15',count:2}]);
  assert.equal(report.overview.recordCount,3);assert.deepEqual(rows,before);
  const year=buildWeldDashboard([row('last26','2026-12-31 23:59:59'),row('first27','2027-01-01 00:00:00')],{...options,startDate:'2026-12-25',endDate:'2027-01-07'});
  assert.deepEqual(year.trend.map(w=>[w.label,w.startDate,w.endDate,w.recordCount]),[['KW53','2026-12-25','2026-12-31',1],['KW01','2027-01-01','2027-01-07',1]]);
});
