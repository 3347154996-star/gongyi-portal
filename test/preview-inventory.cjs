'use strict';
// Isolated visual/interaction preview. Never reads company configuration or credentials.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const sourceIdentity=require('node:crypto').createHash('sha256').update('gongyi-isolated-inventory-preview:v1').digest('hex');
const {createPortal}=require('../server.cjs');
const {makeAdminConfig}=require('../lib/admin.cjs');
const {createMemberStore}=require('../lib/members.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'gongyi-inventory-preview-'));
const password='Preview-only-2026',admin=makeAdminConfig('90001',password);
const members=createMemberStore({root,admin});
for(const [account,name,role] of [['90002','测试领用员','member'],['90003','测试复核员','reviewer']])members.save({account,name,role,active:true,password,createOnly:true},members.get('90001'));
const rows=[
  {id:'preview-pin-a',bjbh:'00123',bjmc:'测试定位销',specifications:'TEST-PIN-A',location:'测试库位 A-1',unit:'件',nowStock:12},
  {id:'preview-pin-b',bjbh:'00123',bjmc:'测试定位销',specifications:'TEST-PIN-B',location:'测试库位 B-2',unit:'件',nowStock:8},
  {id:'preview-cylinder',bjbh:'TEST006',bjmc:'测试气缸',specifications:'TEST-CYL-40',location:'测试库位 C-3',unit:'只',nowStock:5},
  {id:'preview-no-code',bjbh:'',bjmc:'测试无编号导套',specifications:'TEST-GUIDE-20',location:'测试库位 D-4',unit:'件',nowStock:3}
];
const source={
  async login(){return {token:'isolated-preview-token'};},
  async read(){return {rows:[],columns:[],complete:true};},
  inventoryCapabilities(){return Object.fromEntries(['inbound','outbound','adjust'].map(kind=>[kind,{enabled:true,reason:''}]));},
  async inventoryCatalog(){return {sourceIdentity,inventoryProfile:'power-udp',inventoryLabel:'工艺部备件库（演示数据）',rows:structuredClone(rows),complete:true,fetchedAt:new Date().toISOString(),note:'测试环境 · 合成数据，仅用于检查操作流程。',scopeConfigured:true,scopeCount:4,unmatched:[]};},
  async inventoryWrite(kind,operation){
    if(operation.sourceIdentity!==sourceIdentity){const error=new Error('测试仓库来源标识不一致。');error.status=409;throw error;}
    const row=rows.find(item=>item.id===operation.item.id);
    if(!row||row.nowStock!==operation.beforeStock){const error=new Error('测试库存已变更，请刷新。');error.status=409;throw error;}
    row.nowStock=kind==='adjust'?operation.actualQuantity:Number((row.nowStock+(kind==='inbound'?1:-1)*operation.quantity).toFixed(6));
    return {confirmed:true,acknowledgement:'演示系统已确认'};
  }
};
const credentialStore={async load(){return {username:'preview',password:'preview'};},async save(){},async remove(){}};
const server=createPortal({root,config:{admin,environmentLabel:'测试环境 · 合成数据，不会修改公司库存'},source,credentialStore,memberStore:members});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}/#spares`,accounts:{admin:'90001',member:'90002',reviewer:'90003'},password})));
