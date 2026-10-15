(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const root = $('settingsWorkbench');
  if (!root) return;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const roles = {member:'成员',reviewer:'盘点复核人',admin:'管理员'};
  const state = {status:null,active:false,epoch:0,members:[],member:null,reading:null,saving:false,passwordSaving:false};
  const admin = () => state.status?.authenticated && state.status.role === 'admin';
  const canManage = () => state.active && admin();
  root.innerHTML = `
    <section class="settings-panel" aria-labelledby="settingsAccountTitle">
      <div class="settings-heading"><div><h2 id="settingsAccountTitle">个人账号</h2><p>查看当前身份，维护登录密码。</p></div><button id="settingsChangePassword" class="button" type="button">修改密码</button></div>
      <dl class="settings-account"><div><dt>姓名</dt><dd id="settingsName">—</dd></div><div><dt>工号</dt><dd id="settingsAccount">—</dd></div><div><dt>当前角色</dt><dd id="settingsRole">—</dd></div></dl>
      <p id="settingsAccessNote" class="settings-note">成员名单与权限由管理员维护。</p>
    </section>
    <section id="settingsMembersPanel" class="settings-panel" aria-labelledby="settingsMembersTitle" hidden>
      <div class="settings-heading"><div><h2 id="settingsMembersTitle">成员管理</h2><p>登记工号、启停账号，并指定盘点复核人。</p></div><div class="settings-actions"><button id="settingsRefreshMembers" type="button" class="button">刷新名单</button><button id="settingsAddMember" type="button" class="button primary">添加成员</button></div></div>
      <p id="settingsMembersMessage" class="settings-message" role="status" hidden></p><div id="settingsMembers" class="settings-members"></div>
    </section>
    <dialog id="settingsMemberDialog" class="settings-dialog" aria-labelledby="settingsMemberTitle"><form id="settingsMemberForm">
      <div class="dialog-heading"><h2 id="settingsMemberTitle">添加成员</h2><button type="button" data-settings-close="settingsMemberDialog" class="icon-button" aria-label="关闭成员编辑">×</button></div>
      <div class="settings-form-grid"><label class="field"><span>工号</span><input id="settingsMemberAccount" type="text" required maxlength="80" autocomplete="off"></label><label class="field"><span>姓名</span><input id="settingsMemberName" type="text" required maxlength="100" autocomplete="off"></label></div>
      <div class="settings-form-grid"><label class="field"><span>角色</span><select id="settingsMemberRole"><option value="member">成员</option><option value="reviewer">盘点复核人</option><option value="admin">管理员</option></select></label><label class="field"><span>账号状态</span><select id="settingsMemberActive"><option value="true">启用</option><option value="false">停用</option></select></label></div>
      <label class="field"><span id="settingsMemberPasswordLabel">初始密码</span><input id="settingsMemberPassword" type="password" minlength="8" maxlength="128" autocomplete="new-password"><small>至少 8 位；请使用独立密码。</small></label>
      <p id="settingsMemberError" class="settings-message error" role="alert" hidden></p><button id="settingsMemberSave" class="button primary" type="submit">保存成员</button>
    </form></dialog>
    <dialog id="settingsPasswordDialog" class="settings-dialog" aria-labelledby="settingsPasswordTitle"><form id="settingsPasswordForm">
      <div class="dialog-heading"><h2 id="settingsPasswordTitle">修改密码</h2><button type="button" data-settings-close="settingsPasswordDialog" class="icon-button" aria-label="关闭修改密码">×</button></div>
      <p class="settings-note">保存后需使用新密码重新登录。</p>
      <label class="field"><span>当前密码</span><input id="settingsOldPassword" type="password" required autocomplete="current-password"></label><label class="field"><span>新密码（至少 8 位）</span><input id="settingsNewPassword" type="password" required minlength="8" maxlength="128" autocomplete="new-password"></label><label class="field"><span>再次输入新密码</span><input id="settingsRepeatPassword" type="password" required minlength="8" maxlength="128" autocomplete="new-password"></label>
      <p id="settingsPasswordMessage" class="settings-message error" role="alert" hidden></p><button id="settingsPasswordSave" class="button primary" type="submit">保存新密码</button>
    </form></dialog>`;

  function message(id,text,tone='info') { const node=$(id);node.textContent=text;node.className='settings-message '+tone;node.hidden=!text; }
  function closeDialogs() { for (const id of ['settingsMemberDialog','settingsPasswordDialog']) if ($(id).open) $(id).close(); }
  function cancelRead() { state.reading?.controller.abort();state.reading=null;$('settingsRefreshMembers').disabled=false; }
  function clearPrivateState() {
    state.epoch++;cancelRead();closeDialogs();state.members=[];state.member=null;state.saving=false;state.passwordSaving=false;
    $('settingsMembers').innerHTML='';$('settingsMemberForm').reset();$('settingsPasswordForm').reset();
    $('settingsMemberSave').disabled=false;$('settingsPasswordSave').disabled=false;
    message('settingsMembersMessage','');message('settingsMemberError','');message('settingsPasswordMessage','');
  }
  function expire(epoch) {
    if(epoch!==state.epoch)return;
    setContext(null,false);document.dispatchEvent(new CustomEvent('portal:session-expired'));
  }
  async function api(path,options,epoch) {
    const response=await fetch(path,{credentials:'same-origin',cache:'no-store',...options});
    let data;try{data=await response.json();}catch(_){throw new Error('服务器返回内容无法确认，请刷新后核对。');}
    if(!response.ok){if(response.status===401)expire(epoch);const error=new Error(data.message||'请求未完成，请稍后重试。');error.status=response.status;throw error;}
    return data;
  }
  function renderMembers() {
    $('settingsMembers').innerHTML=state.members.map((member,index)=>`<article class="settings-member"><span class="settings-avatar" aria-hidden="true">${escape((member.name||member.account||'员').slice(-1))}</span><div class="settings-member-info"><strong>${escape(member.name||member.account)}</strong><span>工号 ${escape(member.account)} · ${escape(roles[member.role]||'未知角色')}</span></div><span class="settings-badge ${member.active?'enabled':'disabled'}">${member.active?'启用':'停用'}</span><button class="button" type="button" data-settings-member="${index}" aria-label="编辑 ${escape(member.name||member.account)}">编辑</button></article>`).join('')||'<p class="settings-empty">暂未登记成员。</p>';
  }
  async function loadMembers() {
    if(!canManage())return;
    cancelRead();const request={controller:new AbortController(),epoch:state.epoch};state.reading=request;
    $('settingsRefreshMembers').disabled=true;message('settingsMembersMessage','正在读取成员名单…');
    try {
      const data=await api('/local/members',{signal:request.controller.signal},request.epoch);
      if(state.reading!==request||request.epoch!==state.epoch||!canManage())return;
      if(!Array.isArray(data.members))throw new Error('成员名单格式无法确认，请刷新后重试。');
      state.members=data.members;renderMembers();message('settingsMembersMessage','');
    } catch(error) {if(state.reading===request&&request.epoch===state.epoch&&error.name!=='AbortError')message('settingsMembersMessage',error.message,'error');}
    finally {if(state.reading===request){state.reading=null;$('settingsRefreshMembers').disabled=false;}}
  }
  function setContext(status,active) {
    const account=status?.authenticated?status.account:null,oldAccount=state.status?.account,wasActive=state.active,wasAdmin=admin();
    const changed=account!==oldAccount||Boolean(wasAdmin)!==Boolean(status?.authenticated&&status.role==='admin');
    state.status=account?status:null;state.active=Boolean(account&&active);
    if(changed||!account)clearPrivateState();
    root.hidden=!state.active;$('settingsMembersPanel').hidden=!admin();
    $('settingsName').textContent=status?.authenticated?(status.name||'未填写'):'—';$('settingsAccount').textContent=account||'—';$('settingsRole').textContent=account?(roles[status.role]||'未知角色'):'—';
    $('settingsAccessNote').textContent=admin()?'管理员可在下方维护成员及权限。':'成员名单与权限由管理员维护；如需调整，请联系管理员。';
    if(!state.active){cancelRead();closeDialogs();return;}
    if(admin()&&(!wasActive||changed))return loadMembers();
  }
  function openMember(index) {
    if(!canManage()||state.saving)return;
    const member=index===null?null:state.members[index];if(index!==null&&!member)return;
    state.member=member;$('settingsMemberForm').reset();$('settingsMemberTitle').textContent=member?'编辑成员':'添加成员';
    $('settingsMemberAccount').value=member?.account||'';$('settingsMemberAccount').readOnly=Boolean(member);$('settingsMemberName').value=member?.name||'';
    $('settingsMemberRole').value=member?.role||'member';$('settingsMemberActive').value=String(member?.active??true);
    $('settingsMemberPassword').required=!member;$('settingsMemberPasswordLabel').textContent=member?'重置密码（留空则保留原密码）':'初始密码';
    message('settingsMemberError','');$('settingsMemberDialog').showModal();
  }
  async function saveMember(event) {
    event.preventDefault();if(!canManage()||state.saving)return;
    const epoch=state.epoch,data={account:$('settingsMemberAccount').value.trim(),name:$('settingsMemberName').value.trim(),role:$('settingsMemberRole').value,active:$('settingsMemberActive').value==='true'};
    if(!state.member)data.createOnly=true;else if(state.member.version!==undefined)data.version=state.member.version;
    if($('settingsMemberPassword').value)data.password=$('settingsMemberPassword').value;
    state.saving=true;$('settingsMemberSave').disabled=true;message('settingsMemberError','');
    try {
      await api('/local/members',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)},epoch);
      if(epoch!==state.epoch||!admin())return;
      $('settingsMemberDialog').close();$('settingsMemberPassword').value='';
      document.dispatchEvent(new CustomEvent('portal:refresh-status'));if(state.active)await loadMembers();
    } catch(error) {if(epoch===state.epoch)message('settingsMemberError',error.message,'error');}
    finally {if(epoch===state.epoch){state.saving=false;$('settingsMemberSave').disabled=false;}}
  }
  async function savePassword(event) {
    event.preventDefault();if(!state.active||!state.status?.authenticated||state.passwordSaving)return;
    if($('settingsNewPassword').value!==$('settingsRepeatPassword').value){message('settingsPasswordMessage','两次输入的新密码不一致。','error');return;}
    const epoch=state.epoch;state.passwordSaving=true;$('settingsPasswordSave').disabled=true;
    try {
      await api('/local/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({oldPassword:$('settingsOldPassword').value,newPassword:$('settingsNewPassword').value})},epoch);
      if(epoch!==state.epoch)return;
      $('settingsPasswordForm').reset();message('settingsPasswordMessage','密码已修改。请使用新密码登录。','success');document.dispatchEvent(new CustomEvent('portal:refresh-status'));
    } catch(error) {if(epoch===state.epoch)message('settingsPasswordMessage',error.message,'error');}
    finally {if(epoch===state.epoch){state.passwordSaving=false;$('settingsPasswordSave').disabled=false;}}
  }
  root.addEventListener('click',event=>{
    const member=event.target.closest('[data-settings-member]');if(member)return openMember(Number(member.dataset.settingsMember));
    const close=event.target.closest('[data-settings-close]');if(close&&!state.saving&&!state.passwordSaving)$(close.dataset.settingsClose).close();
  });
  $('settingsAddMember').addEventListener('click',()=>openMember(null));$('settingsRefreshMembers').addEventListener('click',loadMembers);
  $('settingsMemberForm').addEventListener('submit',saveMember);$('settingsMemberDialog').addEventListener('close',()=>{$('settingsMemberPassword').value='';});
  $('settingsChangePassword').addEventListener('click',()=>{if(!state.active)return;$('settingsPasswordForm').reset();message('settingsPasswordMessage','');$('settingsPasswordDialog').showModal();});
  $('settingsPasswordForm').addEventListener('submit',savePassword);$('settingsPasswordDialog').addEventListener('close',()=>{$('settingsPasswordForm').reset();});
  for(const id of ['settingsMemberDialog','settingsPasswordDialog'])$(id).addEventListener('cancel',event=>{if(state.saving||state.passwordSaving)event.preventDefault();});
  window.SettingsWorkbench={setContext};
})();
