'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildAlarmReport,alarmStatus,stamp}=require('../lib/alarm-report.cjs');
const base={createOn:'2026-10-12 08:00:00',equipment:'示例设备',line:'示例区域',groupName:'示例小组'};
test('alarm states respect explicit completion and preserve unknown states',()=>{
  assert.equal(alarmStatus({isClose:1,responseState:0}),'completed');assert.equal(alarmStatus({isClose:0,responseState:0}),'unresponded');assert.equal(alarmStatus({isClose:0,responseTime:'2026-10-12 09:00:00'}),'processing');assert.equal(alarmStatus({isClose:null,responseState:1}),'unknown');
});
test('chart totals, status chips and table use the same filtered set, options preserve all choices',()=>{
  const rows=[{...base,isClose:0,responseState:0},{...base,isClose:1},{...base,isClose:1,line:'其他区域'}];
  const r=buildAlarmReport(rows,{line:'示例区域',status:'completed',keyword:'示例'});
  assert.equal(r.overview.recordCount,1);assert.equal(r.filteredRows.length,1);assert.equal(r.equipmentTop[0].count,1);assert.equal(r.dailyTrend[0].total,1);assert.equal(r.options.lines.length,2);assert.equal(r.filteredRows[0]._alarmStatusLabel,'已完成');assert.equal(rows[1]._alarmStatus,undefined);
});
test('duration has explicit samples, ignores missing/negative/sentinel times and retains long durations',()=>{
  const r=buildAlarmReport([{...base,responseTime:'2026-10-12 08:30:00',trackOn:'2026-10-13 08:00:00'},{...base,responseTime:'2026-10-12 07:00:00'},{...base,responseTime:'0001-01-01 00:00:00'}]);
  assert.equal(r.durations.response.averageMinutes,30);assert.equal(r.durations.response.sampleCount,1);assert.equal(r.durations.closure.averageMinutes,1440);assert.equal(r.durations.handling.averageMinutes,null);
});
test('known open status without response metadata remains visible as unknown and counts as open',()=>{
  const r=buildAlarmReport([{...base,isClose:0}]);assert.equal(r.overview.openCount,1);assert.equal(r.overview.unknownCount,1);assert.equal(r.overview.unrespondedCount,0);
});
test('unfetched days are unknown rather than zero when source pagination is partial',()=>{
  const partial=buildAlarmReport([{...base,isClose:1}],{startDate:'2026-10-11',endDate:'2026-10-12',sourceComplete:false});assert.equal(partial.dailyTrend[0].total,null);assert.equal(partial.dailyTrend[1].total,1);
  const complete=buildAlarmReport([],{startDate:'2026-10-11',endDate:'2026-10-12',sourceComplete:true});assert.equal(complete.dailyTrend[0].total,0);
});

test('progression needs source evidence and restored-but-open state remains a visible conflict',()=>{
  assert.equal(alarmStatus({...base,isClose:0,responseState:0,dealTime:'2026-10-12 10:00:00'}),'awaiting_restore');
  assert.equal(alarmStatus({...base,isClose:0,responseState:1,dealTime:'0001-01-01 00:00:00'}),'processing');
  assert.equal(alarmStatus({...base,isClose:0,responseState:0,dealTime:'2026-02-30 10:00:00'}),'unresponded');
  assert.equal(alarmStatus({...base,isClose:' 1 ',responseState:0}),'completed');
  assert.equal(alarmStatus({...base,isClose:0,responseState:1,dealTime:'2026-10-12 10:00:00',trackOn:'2026-10-12 11:00:00'}),'unknown');
  const r=buildAlarmReport([{...base,isClose:0,dealTime:'2026-10-12 10:00:00'},{...base,isClose:0,trackOn:'2026-10-12 11:00:00'}]);
  assert.equal(r.overview.awaitingRestoreCount,1);assert.equal(r.overview.unknownCount,1);assert.equal(r.overview.openCount,2);
  assert.equal(r.diagnostics.restorationStateConflicts,1);
  assert.deepEqual(r.progressBoard.map(item=>item.value),['unresponded','processing','awaiting_restore','completed']);
  assert.equal(r.progressBoard.find(item=>item.value==='awaiting_restore').label,'待复线');
});

test('timestamp validation excludes sentinel, impossible dates and 24-hour rollover',()=>{
  for(const value of ['0001-01-01 00:00:00','2026-02-30 08:00:00','2026-10-12 24:00:00','2026-10-12 09:60:00','2026-10-12 09:00:60','2026-10-12','2026-10-12 09:00:00junk'])assert.equal(stamp(value),null);
  assert.equal(stamp('2026-10-12 08:00:00'),stamp('2026-10-12T00:00:00Z'));
  assert.equal(stamp('2026-10-12T08:00:00.0000000+08:00'),stamp('2026-10-12 08:00:00'));
});

test('department mappings are explicit, preserve original groups and never infer names',()=>{
  const rows=[{...base,isClose:1,groupName:'示例机修组'},{...base,isClose:0,responseState:1,groupName:'示例工艺组'},
    {...base,isClose:0,responseState:0,groupName:'示例质量组'},{...base,isClose:0,responseState:0,groupName:''}];
  const before=JSON.stringify(rows),settings={departmentRules:[{department:'合成部门甲',groupPattern:'^示例机修组$'},{department:'合成部门乙',groupPattern:'^示例工艺组$'}]};
  const r=buildAlarmReport(rows,settings);
  assert.equal(r.filteredRows[0]._alarmDepartment,'合成部门甲');assert.equal(r.filteredRows[1]._alarmDepartment,'合成部门乙');
  assert.equal(r.filteredRows[2]._alarmDepartment,'部门待确认');assert.equal(r.filteredRows[3]._alarmDepartment,'部门待确认');
  assert.equal(r.diagnostics.unmappedDepartmentRows,2);assert.equal(r.filteredRows[0].groupName,'示例机修组');assert.equal(JSON.stringify(rows),before);
  assert.equal(buildAlarmReport(rows).departmentSummary.find(item=>item.name==='部门待确认').total,4);
});

test('department rules support category ownership and conflicts do not pick an arbitrary department',()=>{
  const rows=[{...base,isClose:0,responseState:1,mainType:'合成类别甲'},{...base,isClose:1,mainType:'合成类别未定义'}];
  const rules=[{department:'合成部门甲',field:'mainType',pattern:'^合成类别甲$'}];
  const r=buildAlarmReport(rows,{departmentRules:rules});
  assert.equal(r.filteredRows[0]._alarmDepartment,'合成部门甲');assert.equal(r.filteredRows[1]._alarmDepartment,'部门待确认');
  assert.equal(r.filteredRows[0].mainType,'合成类别甲');
  const conflict=buildAlarmReport(rows,{departmentRules:[...rules,{department:'合成部门乙',groupPattern:'^示例小组$'}]});
  assert.equal(conflict.filteredRows[0]._alarmDepartment,'部门待确认');assert.equal(conflict.diagnostics.departmentRuleConflicts,1);
  assert.ok(r.notes.some(note=>note.includes('不是接口原生部门字段')));
});

test('declared departments stay visible and uncovered empty departments are null, not zero',()=>{
  const departments=['合成部门甲','合成部门乙','合成部门丙'];
  const settings={departments,departmentRules:[{department:'合成部门甲',field:'mainType',pattern:'^合成类别甲$'}]};
  const partial=buildAlarmReport([{...base,isClose:1,mainType:'合成类别甲'}],{...settings,sourceComplete:false});
  assert.deepEqual(partial.departmentSummary.map(item=>item.name),[...departments,'部门待确认']);
  assert.equal(partial.departmentSummary[0].total,1);assert.equal(partial.departmentSummary[1].total,null);assert.equal(partial.departmentSummary[1].completed,null);
  assert.equal(partial.options.departments.find(item=>item.value==='合成部门乙').count,null);
  const complete=buildAlarmReport([],{...settings,sourceComplete:true});
  assert.ok(complete.departmentSummary.every(item=>item.total===0&&item.completed===0));assert.ok(complete.options.departments.every(item=>item.count===0));
});

test('line naming prioritizes explicit fields then configured region and equipment rules then original region',()=>{
  const rows=[{...base,isClose:1,productionLine:'明确线甲',lineName:'明确线乙',line:'合成区域甲',equipment:'合成设备21'},
    {...base,isClose:1,lineName:'明确线乙',line:'合成区域甲',equipment:'合成设备21'},
    {...base,isClose:1,line:'合成区域甲',equipment:'合成设备21'},
    {...base,isClose:1,line:'合成区域乙',equipment:'合成设备21'},
    {...base,isClose:1,line:'合成区域甲',equipment:'设备名称999线'},
    {...base,isClose:1,line:'',equipment:'设备名称999线'}];
  const alarmLineRules=[{line:'配置线21',regionPattern:'^合成区域甲$',equipmentPattern:'^合成设备21$'},
    {line:'后置匹配线',regionPattern:'^合成区域甲$',equipmentPattern:'^合成设备21$'}];
  const r=buildAlarmReport(rows,{alarmLineRules});
  assert.deepEqual(r.filteredRows.map(item=>item._alarmLine),['明确线甲','明确线乙','配置线21','合成区域乙','合成区域甲','未填写区域']);
  assert.deepEqual(r.filteredRows.map(item=>item._alarmLineSource),['explicit','explicit','rule','region','region','unknown']);
  assert.equal(r.filteredRows[2].lineOrigin,'合成区域甲');assert.equal(r.filteredRows[2].line,'合成区域甲');
  assert.equal(r.diagnostics.explicitLineConflicts,1);assert.equal(r.diagnostics.configuredLineRows,1);
  assert.equal(r.diagnostics.regionFallbackRows,2);assert.equal(r.diagnostics.missingLineRows,1);
});

test('line matrices and department summaries partition the same records into exhaustive status counts',()=>{
  const rows=[{...base,isClose:0,responseState:0},{...base,isClose:0,responseState:1},{...base,isClose:0,dealTime:'2026-10-12 10:00:00'},
    {...base,isClose:1},{...base,isClose:0,trackOn:'2026-10-12 11:00:00'}];
  const r=buildAlarmReport(rows,{departmentRules:[{department:'合成部门甲',groupPattern:'^示例小组$'}]});
  assert.equal(r.lineStatusMatrix,r.lineSummary);
  for(const group of [...r.lineSummary,...r.departmentSummary.filter(item=>item.total!==null)]) {
    assert.equal(group.total,group.unresponded+group.processing+group.awaitingRestore+group.completed+group.unknown);
  }
  const summary=r.lineSummary[0];
  assert.deepEqual(summary,{name:'示例区域',total:5,unresponded:1,processing:1,awaitingRestore:1,completed:1,unknown:1,open:4});
  assert.equal(r.departmentSummary.find(item=>item.name==='合成部门甲').total,r.overview.recordCount);
});

test('department, group, line, status, keyword and date filters share one detail/chart scope',()=>{
  const records=[{...base,id:'keep',isClose:0,dealTime:'2026-10-12 10:00:00',productionLine:'线体甲'},
    {...base,id:'other-state',isClose:1,productionLine:'线体甲'},
    {...base,id:'other-line',isClose:0,dealTime:'2026-10-12 10:00:00',productionLine:'线体乙'},
    {...base,id:'outside',isClose:0,dealTime:'2026-10-12 10:00:00',productionLine:'线体甲',createOn:'2026-10-11 08:00:00'}];
  const r=buildAlarmReport(records,{startDate:'2026-10-12',endDate:'2026-10-12',department:'合成部门甲',group:'示例小组',line:'线体甲',status:'awaiting_restore',keyword:'keep',
    departmentRules:[{department:'合成部门甲',groupPattern:'^示例小组$'}]});
  assert.deepEqual(r.filteredRows.map(item=>item.id),['keep']);assert.equal(r.overview.awaitingRestoreCount,1);
  assert.equal(r.lineSummary[0].total,1);assert.equal(r.departmentSummary.find(item=>item.name==='合成部门甲').total,1);assert.equal(r.dailyTrend[0].total,1);
  assert.equal(r.options.lines.find(item=>item.value==='线体乙').count,1);assert.equal(r.options.statuses.find(item=>item.value==='completed').count,1);
  assert.equal(r.diagnostics.rowsExcludedByDate,1);assert.equal(r.selected.department,'合成部门甲');
});

test('malformed configuration and impossible reporting periods fail without guessing',()=>{
  assert.throws(()=>buildAlarmReport([],{departmentRules:[{department:'合成部门'}]}),/pattern/);
  assert.throws(()=>buildAlarmReport([],{alarmLineRules:[{line:'合成线',equipmentPattern:'设备'}]}),/regionPattern/);
  assert.throws(()=>buildAlarmReport([],{departments:'合成部门'}),/array/);
  assert.throws(()=>buildAlarmReport([],{startDate:'2026-02-30',endDate:'2026-03-01'}),/period/);
  assert.throws(()=>buildAlarmReport([],{startDate:'2026-01-01',endDate:'2026-12-31'}),/42 days/);
});

test('work board keeps one card per alarm across all three stages and excludes completed or unknown states',()=>{
  const rows=[{...base,id:'SYN-WAIT',isClose:0,responseState:0,equipMentCode:'SYN-EQ',beforeProblem:'合成报警描述'},
    {...base,id:'SYN-WORK',isClose:0,responseState:1,responseTime:'2026-10-12 09:00:00'},
    {...base,id:'SYN-RESTORE',isClose:0,responseState:1,responseTime:'2026-10-12 09:00:00',dealTime:'2026-10-12 10:00:00'},
    {...base,id:'SYN-CLOSED',isClose:1}, {...base,id:'SYN-UNKNOWN',isClose:0}];
  const r=buildAlarmReport(rows,{sourceComplete:true});
  assert.deepEqual(r.workBoard.columns.map(column=>[column.status,column.label,column.count]),[
    ['unresponded','待响应',1],['processing','处理中',1],['awaiting_restore','待复线',1]
  ]);
  const cards=r.workBoard.columns.flatMap(column=>column.cards);
  assert.equal(cards.length,3);assert.ok(cards.every(card=>card.equipment==='示例设备'),'same equipment does not collapse independent alarm cards');
  assert.equal(cards[0].equipmentCode,'SYN-EQ');assert.equal(cards[0].description,'合成报警描述');
  assert.equal(cards[0].line,'示例区域');assert.equal(cards[0].department,'部门待确认');assert.equal(cards[0].group,'示例小组');
  assert.equal(r.workBoard.unknownCount,1);assert.equal(r.workBoard.completedCount,1);assert.equal(r.workBoard.totalOpenCount,4);assert.equal(r.workBoard.complete,true);
  assert.equal(cards.length+r.workBoard.unknownCount+r.workBoard.completedCount,r.overview.recordCount);
});

test('work board selects its own stage timestamp and publishes timezone-safe ISO starts',()=>{
  const r=buildAlarmReport([{...base,isClose:0,responseState:0},
    {...base,isClose:0,responseState:1,responseTime:'2026-10-12 09:00:00'},
    {...base,isClose:0,responseTime:'2026-10-12T01:00:00Z',dealTime:'2026-10-12 10:00:00'}]);
  const cards=r.workBoard.columns.flatMap(column=>column.cards);
  assert.deepEqual(cards.map(card=>card.stageStartedAt),['2026-10-12T00:00:00.000Z','2026-10-12T01:00:00.000Z','2026-10-12T02:00:00.000Z']);
  assert.equal(cards[1].createdAt,'2026-10-12 08:00:00');assert.equal(cards[1].responseAt,'2026-10-12 09:00:00');
  assert.equal(cards[0].responseAt,null);assert.equal(cards[0].dealtAt,null);
});

test('work board does not substitute missing stage times or calculate durations from reversed sequences',()=>{
  const r=buildAlarmReport([{...base,id:'missing-response',isClose:0,responseState:1},
    {...base,id:'earlier-response',isClose:0,responseTime:'2026-10-12 07:00:00'},
    {...base,id:'earlier-deal',isClose:0,responseTime:'2026-10-12 09:00:00',dealTime:'2026-10-12 08:30:00'},
    {...base,id:'broken-prior-order',isClose:0,responseTime:'2026-10-12 07:00:00',dealTime:'2026-10-12 10:00:00'},
    {...base,id:'invalid-create',createOn:'2026-02-30 08:00:00',isClose:0,responseState:0},
    {...base,id:'known-deal-only',isClose:0,responseTime:'0001-01-01 00:00:00',dealTime:'2026-10-12 10:00:00'}]);
  const cards=r.workBoard.columns.flatMap(column=>column.cards);
  for(const id of ['missing-response','earlier-response','earlier-deal','broken-prior-order','invalid-create'])assert.equal(cards.find(card=>card.id===id).stageStartedAt,null,id);
  assert.equal(cards.find(card=>card.id==='invalid-create').createdAt,null);
  assert.equal(cards.find(card=>card.id==='known-deal-only').stageStartedAt,'2026-10-12T02:00:00.000Z');
  assert.equal(cards.find(card=>card.id==='known-deal-only').responseAt,null);
});

test('work board leaves future start validation to UI without reading a clock or inventing elapsed minutes',()=>{
  const r=buildAlarmReport([{...base,isClose:0,responseState:1,responseTime:'2099-10-12 09:00:00'}]);
  const card=r.workBoard.columns[1].cards[0];
  assert.equal(card.stageStartedAt,'2099-10-12T01:00:00.000Z');
  assert.equal(Object.hasOwn(card,'elapsedMinutes'),false);
  assert.ok(r.notes.some(note=>note.includes('未来时刻需显示待核实')));
});

test('work board preserves valid source IDs and creates only local display IDs for missing values',()=>{
  const rows=[{...base,id:0,isClose:0,responseState:0},{...base,isClose:0,responseState:0},{...base,id:'',isClose:0,responseState:0},
    {...base,id:'SYN-DUPLICATE',isClose:0,responseState:0},{...base,id:'SYN-DUPLICATE',isClose:0,responseState:0}];
  const before=JSON.stringify(rows),r=buildAlarmReport(rows),cards=r.workBoard.columns[0].cards;
  assert.equal(cards[0].id,0);assert.equal(cards[0].idSource,'source');assert.equal(cards[1].id,'display-2');assert.equal(cards[1].idSource,'display');
  assert.equal(cards[2].id,'display-3');assert.equal(cards.length,5);
  assert.equal(r.filteredRows[1].id,undefined);assert.equal(r.filteredRows[2].id,'');assert.equal(JSON.stringify(rows),before);
});

test('work board uses the full filtered result independently of display pagination and keeps selection scope',()=>{
  const records=Array.from({length:205},(_,i)=>({...base,id:'SYN-'+i,isClose:0,responseState:0,productionLine:'合成线甲',mainType:'合成类别甲',beforeProblem:'合成描述'}));
  records.push({...base,id:'OTHER',isClose:0,responseState:0,productionLine:'合成线乙'});
  const settings={page:2,size:10,line:'合成线甲',department:'合成部门甲',keyword:'合成描述',sourceComplete:false,
    departmentRules:[{department:'合成部门甲',field:'mainType',pattern:'^合成类别甲$'}]};
  const r=buildAlarmReport(records,settings);
  assert.equal(r.workBoard.columns[0].count,205);assert.equal(r.workBoard.columns[0].cards.length,205);
  assert.equal(r.workBoard.columns[0].count,r.filteredRows.length);assert.equal(r.overview.recordCount,205);assert.equal(r.workBoard.complete,false);
  assert.ok(r.workBoard.columns[0].cards.every(card=>card.line==='合成线甲'&&card.department==='合成部门甲'));
  assert.equal(buildAlarmReport([]).workBoard.complete,null);
});
