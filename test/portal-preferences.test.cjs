'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function fixture(initial={}) {
  const stored=new Map(Object.entries(initial)),events=[],documentCallbacks=new Map(),windowCallbacks=new Map(),classes=new Set();
  let blocked=false;
  const storage={getItem:key=>{if(blocked)throw Error('blocked');return stored.get(key)||null;},setItem:(key,value)=>{if(blocked)throw Error('blocked');stored.set(key,value);},removeItem:key=>{if(blocked)throw Error('blocked');stored.delete(key);}};
  const context=vm.createContext({document:{documentElement:{classList:{toggle:(name,on)=>on?classes.add(name):classes.delete(name)}},addEventListener:(name,fn)=>documentCallbacks.set(name,fn),dispatchEvent:event=>events.push(event)},window:{localStorage:storage,addEventListener:(name,fn)=>windowCallbacks.set(name,fn)},CustomEvent:class{constructor(type,{detail}={}){this.type=type;this.detail=detail;}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/portal-preferences.js'),'utf8'),context);
  return {api:context.window.PortalPreferences,stored,events,classes,block:()=>{blocked=true;},emit:(name,detail)=>documentCallbacks.get(name)?.({detail}),storageEvent:event=>windowCallbacks.get('storage')?.(event)};
}
const key=account=>'gongyi.portal.preferences.v1.'+encodeURIComponent(account);

test('preferences persist only allowlisted fields and normalize untrusted storage',()=>{
  const f=fixture({[key('synthetic')]:JSON.stringify({homeModule:'javascript:bad',dateRange:'yesterday',pageSize:999,compact:'false',reduceMotion:true,reportAuthor:'\n合成\t测试\u0000',password:'never-load'})});
  f.api.setAccount('synthetic');const value=f.api.get();
  assert.equal(value.homeModule,'weld-live');assert.equal(value.dateRange,'today');assert.equal(value.pageSize,50);assert.equal(value.compact,false);assert.equal(value.reduceMotion,true);assert.equal(value.reportAuthor,'合成测试');assert.equal(value.password,undefined);
  const result=f.api.set({pageSize:'100',reportDepartment:'测试部门',password:'never-store',businessRows:[{private:'record'}]});
  assert.equal(result.persisted,true);assert.equal(result.preferences.pageSize,100);
  const serialized=f.stored.get(key('synthetic'));assert.doesNotMatch(serialized,/never-store|private|businessRows|password/);assert.match(serialized,/测试部门/);
  value.reduceMotion=false;assert.equal(f.api.get().reduceMotion,true);
});

test('accounts have independent defaults and logout resets visible preferences',()=>{
  const f=fixture();assert.equal(f.api.set({compact:true}).persisted,false);assert.equal(f.stored.size,0);
  f.api.setAccount('first');f.api.set({compact:true,reportAuthor:'第一位',homeModule:'vision'});assert.ok(f.classes.has('portal-compact'));
  f.api.setAccount('second');assert.equal(f.api.get().reportAuthor,'');assert.equal(f.api.get().compact,false);assert.ok(!f.classes.has('portal-compact'));
  f.api.set({reportAuthor:'第二位',pageSize:20});f.api.setAccount('first');assert.equal(f.api.get().reportAuthor,'第一位');assert.equal(f.api.get().homeModule,'vision');
  f.api.setAccount(null);assert.equal(f.api.get().reportAuthor,'');assert.equal(f.api.get().homeModule,'weld-live');assert.ok(!f.classes.has('portal-compact'));
  f.api.setAccount('second');assert.equal(f.api.get().reportAuthor,'第二位');assert.equal(f.api.get().pageSize,20);
});

test('reset affects only the current account and not unrelated stored data',()=>{
  const f=fixture({unrelated:'leave-alone',[key('other')]:JSON.stringify({compact:true})});
  f.api.setAccount('current');f.api.set({pageSize:100,reportShowSource:false,reduceMotion:true});assert.ok(f.classes.has('portal-reduce-motion'));
  assert.equal(f.api.reset().persisted,true);assert.equal(f.api.get().pageSize,50);assert.equal(f.api.get().reportShowSource,true);assert.equal(f.stored.has(key('current')),false);
  assert.equal(f.stored.get('unrelated'),'leave-alone');assert.equal(f.stored.has(key('other')),true);assert.ok(!f.classes.has('portal-reduce-motion'));
});

test('blocked storage reports that persistence failed while keeping page-local preferences isolated',()=>{
  const f=fixture();f.api.setAccount('first');f.api.set({reportAuthor:'原值'});f.block();
  const result=f.api.set({reportAuthor:'暂存值',compact:true});assert.equal(result.persisted,false);assert.match(result.error,/浏览器未允许/);assert.ok(f.classes.has('portal-compact'));
  f.api.setAccount('second');assert.equal(f.api.get().reportAuthor,'');f.api.setAccount('first');assert.equal(f.api.get().reportAuthor,'暂存值');
  assert.equal(f.api.reset().persisted,false);assert.equal(f.api.get().reportAuthor,'');assert.ok(!f.classes.has('portal-compact'));
});

test('status and cross-tab events update only the active account and emit change reasons',()=>{
  const f=fixture();f.emit('portal:status',{authenticated:true,account:'active'});f.api.set({pageSize:100});
  const previous=f.events.length;f.emit('portal:status',{status:{authenticated:true,account:'active'}});assert.equal(f.events.length,previous);
  f.storageEvent({key:key('other'),newValue:JSON.stringify({pageSize:20})});assert.equal(f.api.get().pageSize,100);
  f.storageEvent({key:key('active'),newValue:JSON.stringify({pageSize:20,compact:true})});assert.equal(f.api.get().pageSize,20);assert.ok(f.classes.has('portal-compact'));assert.equal(f.events.at(-1).detail.reason,'storage');
  f.emit('portal:session-expired');assert.equal(f.api.get().pageSize,50);assert.equal(f.events.at(-1).detail.account,null);assert.ok(!f.classes.has('portal-compact'));
});

test('corrupt JSON falls back to safe defaults and can be replaced with valid preferences',()=>{
  const f=fixture({[key('synthetic')]:'{invalid json'});f.api.setAccount('synthetic');assert.equal(f.api.get().dateRange,'today');
  assert.equal(f.api.set({dateRange:'all',pageSize:20}).persisted,true);assert.equal(JSON.parse(f.stored.get(key('synthetic'))).dateRange,'all');
});

test('portable preferences round-trip allowed fields without identities, credentials or business data',()=>{
  const f=fixture();f.api.setAccount('secret-account');
  f.api.set({dateRange:'companyWeek',textSize:'large',accentTheme:'teal',reportAuthor:'合成编制人',password:'must-not-export',sourcePath:'private-path'});
  const backup=f.api.exportText();assert.doesNotMatch(backup,/secret-account|must-not-export|private-path|password|sourcePath/);
  f.api.setAccount('recipient');assert.equal(f.api.get().accentTheme,'blue');
  const preview=f.api.parseImport(backup);assert.equal(preview.accentTheme,'teal');assert.equal(f.api.get().accentTheme,'blue','preview must not apply');
  assert.equal(f.api.importText(backup).persisted,true);assert.equal(f.api.get().dateRange,'companyWeek');assert.ok(f.classes.has('portal-large-text'));assert.ok(f.classes.has('portal-accent-teal'));assert.ok(!f.classes.has('portal-accent-blue'));
  f.api.setAccount(null);assert.ok(!f.classes.has('portal-large-text'));assert.ok(f.classes.has('portal-accent-blue'));assert.throws(()=>f.api.exportText(),/先登录/);
});

test('invalid and oversized preference imports never change saved values',()=>{
  const f=fixture();f.api.setAccount('active');f.api.set({accentTheme:'violet'});
  const original=f.stored.get(key('active')),backup=JSON.parse(f.api.exportText());
  for(const text of ['not-json','x'.repeat(16385),JSON.stringify({...backup,version:2}),JSON.stringify({...backup,password:'no'}),JSON.stringify({...backup,preferences:{...backup.preferences,password:'no'}}),JSON.stringify({...backup,preferences:{...backup.preferences,pageSize:'100'}}),JSON.stringify({...backup,preferences:{...backup.preferences,reportAuthor:'x'.repeat(61)}}),JSON.stringify({...backup,preferences:{...backup.preferences,textSize:'999px'}}),'{"format":"gongyi-portal-preferences","version":1,"preferences":{"__proto__":{"polluted":true}}}']){
    assert.throws(()=>f.api.importText(text));assert.equal(f.stored.get(key('active')),original);assert.equal(f.api.get().accentTheme,'violet');
  }
});

test('storage availability reports session-only fallback and does not imply server persistence',()=>{
  const f=fixture();assert.equal(f.api.storageStatus().state,'signed-out');f.api.setAccount('active');assert.equal(f.api.storageStatus().state,'available');
  f.block();f.api.set({textSize:'large'});assert.equal(f.api.storageStatus().state,'session');assert.ok(f.classes.has('portal-large-text'));
});
