'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {pageWindow,availableKind,selectionSnapshot,deviceStamp,sourceStamp,periodDates}=require('../public/workbench-utils.js');

test('inventory pages cover all 263 rows once and clamp after a narrower search',()=>{
  const rows=Array.from({length:263},(_,index)=>index),seen=[];
  for(let page=1;page<=14;page++){const range=pageWindow(rows.length,page,20);seen.push(...rows.slice(range.start,range.end));}
  assert.deepEqual(seen,rows);
  assert.deepEqual(pageWindow(3,14,20),{page:1,pages:1,start:0,end:3,size:20,total:3});
  assert.equal(pageWindow(0,99,20).page,1);
  assert.equal(pageWindow(263,4,80).end,263);
});
test('unavailable write actions fall back to a usable workflow',()=>{
  assert.equal(availableKind('outbound',{inbound:{enabled:true},outbound:{enabled:false}}),'inbound');
  assert.equal(availableKind('inbound',{}),'count');
  assert.equal(availableKind('count',{inbound:{enabled:true}}),'count');
});
test('stock checks require the same source identity and a usable finite quantity',()=>{
  const before={id:'part-1',sourceIdentity:'source-a',selectable:true,stock:12,specification:'A'};
  const refreshed={...before,stock:9};
  assert.deepEqual(selectionSnapshot(before,[refreshed]),{item:refreshed,verified:true,changed:true});
  assert.equal(before.stock,12);
  assert.equal(selectionSnapshot(before,[{...before,sourceIdentity:'source-b'}]).verified,false);
  assert.equal(selectionSnapshot(before,[]).verified,false);
  for(const stock of [null,undefined,'',NaN,Infinity])assert.equal(selectionSnapshot(before,[{...before,stock}]).verified,false);
  assert.equal(selectionSnapshot(before,[{...before,selectable:false}]).verified,false);
  assert.equal(selectionSnapshot(before,[{...before,stock:'12'}]).changed,false);
  assert.equal(selectionSnapshot(before,[{...before,specification:'B'}]).changed,true);
});
test('portal time uses Beijing while device labels preserve their original clock',()=>{
  assert.match(sourceStamp('2026-10-15T00:30:00Z'),/2026\/10\/15 08:30:00 北京时间/);
  assert.match(sourceStamp('2026-10-15T08:30:00+08:00'),/08:30:00 北京时间/);
  assert.match(sourceStamp('2026-10-15T00:30:00'),/00:30:00（来源未标注时区）/);
  assert.equal(deviceStamp('2026-10-15T00:30:00'),'2026-10-15 00:30:00');
  assert.equal(deviceStamp('2026-10-15T00:30:00Z'),'2026-10-15 00:30:00 UTC');
});
test('quick date ranges use the Beijing calendar across UTC midnight and month boundaries',()=>{
  const now=new Date('2026-10-31T18:00:00Z');
  assert.deepEqual(periodDates('today',now),{start:'2026-11-01T00:00',end:'2026-11-01T23:59'});
  assert.deepEqual(periodDates('week',now),{start:'2026-10-26T00:00',end:'2026-11-01T23:59'});
  assert.deepEqual(periodDates('all',now),{start:'',end:''});
});
