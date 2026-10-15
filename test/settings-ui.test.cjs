'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const admin={authenticated:true,account:'synthetic-admin',name:'合成管理员',role:'admin'};
const member={account:'00123',name:'合成成员',role:'member',active:true,version:3};
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});
function gate(){let resolve;const promise=new Promise(done=>{resolve=done;});return {resolve,promise};}
function fixture(fetcher=()=>response({members:[member]})){
  const nodes=new Map(),requests=[],events=[];
  function node(id){
    if(!nodes.has(id)){
      const callbacks=new Map();
      nodes.set(id,{id,hidden:false,open:false,disabled:false,value:'',textContent:'',innerHTML:'',callbacks,
        addEventListener(type,callback){callbacks.set(type,callback);},showModal(){this.open=true;},close(){this.open=false;callbacks.get('close')?.();},
        reset(){for(const [key,item] of nodes)if(id==='settingsPasswordForm'?/^settings(?:Old|New|Repeat)Password$/.test(key):key.startsWith(id.replace('Form','')))item.value='';}});
    }
    return nodes.get(id);
  }
  const context=vm.createContext({document:{getElementById:node,dispatchEvent:event=>events.push(event.type)},window:{},AbortController,
    CustomEvent:class{constructor(type){this.type=type;}},fetch:async(url,options)=>{requests.push({url,options});return fetcher(url,options);}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/settings.js'),'utf8'),context);
  const fire=(id,type,event={})=>node(id).callbacks.get(type)?.({preventDefault(){},...event});
  return {node,requests,events,api:context.window.SettingsWorkbench,fire,edit:index=>fire('settingsWorkbench','click',{target:{closest:selector=>selector==='[data-settings-member]'?{dataset:{settingsMember:String(index)}}:null}})};
}

test('settings works without a company source; only administrators request members',async()=>{
  const f=fixture();
  for(const role of ['member','reviewer']){
    await f.api.setContext({...admin,role},true);
    assert.equal(f.node('settingsWorkbench').hidden,false);assert.equal(f.node('settingsMembersPanel').hidden,true);assert.equal(f.requests.length,0);
    assert.equal(f.node('settingsAccount').textContent,admin.account);
    f.fire('settingsChangePassword','click');assert.equal(f.node('settingsPasswordDialog').open,true);
  }
  await f.api.setContext(admin,true);assert.equal(f.requests[0].url,'/local/members');assert.match(f.node('settingsMembers').innerHTML,/00123/);
  await f.api.setContext(null,false);assert.equal(f.node('settingsWorkbench').hidden,true);assert.equal(f.node('settingsMembers').innerHTML,'');
});

test('create, role change, disable and restore preserve the member API contract',async()=>{
  const f=fixture((url,options)=>options.method==='POST'?response({member}):response({members:[member]}));await f.api.setContext(admin,true);
  f.fire('settingsAddMember','click');assert.equal(f.node('settingsMemberPassword').required,true);
  for(const [id,value] of Object.entries({settingsMemberAccount:'00008',settingsMemberName:'新成员',settingsMemberRole:'reviewer',settingsMemberActive:'true',settingsMemberPassword:'synthetic-password'}))f.node(id).value=value;
  await f.fire('settingsMemberForm','submit');
  let data=JSON.parse(f.requests.find(item=>item.options.method==='POST').options.body);
  assert.deepEqual(data,{account:'00008',name:'新成员',role:'reviewer',active:true,createOnly:true,password:'synthetic-password'});
  assert.equal(f.node('settingsMemberPassword').value,'');assert.ok(f.events.includes('portal:refresh-status'));
  for(const active of [false,true]){
    f.edit(0);assert.equal(f.node('settingsMemberAccount').readOnly,true);assert.equal(f.node('settingsMemberPassword').required,false);
    f.node('settingsMemberRole').value='reviewer';f.node('settingsMemberActive').value=String(active);await f.fire('settingsMemberForm','submit');
    data=JSON.parse(f.requests.filter(item=>item.options.method==='POST').at(-1).options.body);
    assert.deepEqual(data,{account:'00123',name:'合成成员',role:'reviewer',active,version:3});
    assert.equal(Object.hasOwn(data,'password'),false);assert.equal(Object.hasOwn(data,'createOnly'),false);
  }
});

test('status refresh preserves member drafts; server conflicts keep the editable form',async()=>{
  const f=fixture((url,options)=>options.method==='POST'?response({message:'成员资料已更新，请刷新后重试。'},409):response({members:[member]}));await f.api.setContext(admin,true);f.edit(0);
  f.node('settingsMemberName').value='尚未保存';await f.api.setContext(admin,true);
  assert.equal(f.node('settingsMemberDialog').open,true);assert.equal(f.node('settingsMemberName').value,'尚未保存');assert.equal(f.requests.length,1);
  await f.fire('settingsMemberForm','submit');assert.equal(f.node('settingsMemberDialog').open,true);assert.equal(f.node('settingsMemberName').value,'尚未保存');assert.match(f.node('settingsMemberError').textContent,/资料已更新/);assert.equal(f.node('settingsMemberSave').disabled,false);
});

test('logout or revoked admin permission erases member and password state',async()=>{
  const f=fixture();await f.api.setContext(admin,true);f.edit(0);f.node('settingsMemberPassword').value='not-retained';
  await f.api.setContext({...admin,role:'member'},true);
  assert.equal(f.node('settingsMembers').innerHTML,'');assert.equal(f.node('settingsMemberDialog').open,false);assert.equal(f.node('settingsMemberPassword').value,'');assert.equal(f.node('settingsMembersPanel').hidden,true);
  f.fire('settingsChangePassword','click');f.node('settingsOldPassword').value='not-retained';await f.api.setContext(null,false);
  assert.equal(f.node('settingsPasswordDialog').open,false);assert.equal(f.node('settingsOldPassword').value,'');assert.equal(f.node('settingsAccount').textContent,'—');
});

test('late reads and 401 from an old account cannot overwrite or expire a new session',async()=>{
  const pending=gate();let reads=0;const f=fixture(()=>++reads===1?pending.promise:response({members:[{...member,name:'新会话成员'}]}));
  const first=f.api.setContext(admin,true);await f.api.setContext(null,false);await f.api.setContext({...admin,account:'other-admin'},true);
  pending.resolve(response({message:'old expired'},401));await first;
  assert.match(f.node('settingsMembers').innerHTML,/新会话成员/);assert.deepEqual(f.events,[]);assert.equal(f.node('settingsWorkbench').hidden,false);
});

test('a late save cannot alter a different account; current 401 clears data immediately',async()=>{
  const pending=gate();const f=fixture((url,options)=>options.method==='POST'?pending.promise:response({members:[member]}));await f.api.setContext(admin,true);f.edit(0);
  const saving=f.fire('settingsMemberForm','submit');await f.api.setContext(null,false);await f.api.setContext({...admin,account:'other-admin'},true);pending.resolve(response({member}));await saving;assert.deepEqual(f.events,[]);
  const expired=fixture(()=>response({message:'expired'},401));await expired.api.setContext(admin,true);assert.equal(expired.node('settingsWorkbench').hidden,true);assert.equal(expired.node('settingsMembers').innerHTML,'');assert.deepEqual(expired.events,['portal:session-expired']);
});

test('password change validates confirmation, clears secrets and refreshes authentication',async()=>{
  const f=fixture(()=>response({ok:true}));await f.api.setContext({...admin,role:'member'},true);f.fire('settingsChangePassword','click');
  f.node('settingsOldPassword').value='synthetic-old';f.node('settingsNewPassword').value='synthetic-new';f.node('settingsRepeatPassword').value='different';
  await f.fire('settingsPasswordForm','submit');assert.equal(f.requests.length,0);assert.match(f.node('settingsPasswordMessage').textContent,/不一致/);
  f.node('settingsRepeatPassword').value='synthetic-new';await f.fire('settingsPasswordForm','submit');assert.equal(f.requests[0].url,'/local/password');
  assert.deepEqual(JSON.parse(f.requests[0].options.body),{oldPassword:'synthetic-old',newPassword:'synthetic-new'});assert.equal(f.node('settingsOldPassword').value,'');assert.equal(f.node('settingsNewPassword').value,'');assert.deepEqual(f.events,['portal:refresh-status']);
});

test('member names are escaped and returning to settings refreshes the saved list',async()=>{
  const f=fixture(()=>response({members:[{...member,name:'<img src=x onerror=alert(1)>'}]}));await f.api.setContext(admin,true);
  assert.doesNotMatch(f.node('settingsMembers').innerHTML,/<img/);assert.match(f.node('settingsMembers').innerHTML,/&lt;img/);
  f.edit(0);await f.api.setContext(admin,false);assert.equal(f.node('settingsMemberDialog').open,false);await f.api.setContext(admin,true);assert.equal(f.requests.length,2);
});
