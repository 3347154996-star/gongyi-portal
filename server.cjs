'use strict';
const http=require('node:http');
const https=require('node:https');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {createSource,parseQuery,PortalError}=require('./lib/source.cjs');
const {createMemberStore}=require('./lib/members.cjs');
const {createInventoryService}=require('./lib/inventory.cjs');
const {createVisionService}=require('./lib/vision.cjs');
const {createCredentialStore}=require('./lib/credential-store.cjs');
const {createAutoSource}=require('./lib/auto-source.cjs');
const ROOT=__dirname, PUBLIC=path.join(ROOT,'public');
const SESSION_MS=8*60*60*1000;
function loadConfig(){try{return JSON.parse(fs.readFileSync(path.join(ROOT,'config.local.json'),'utf8').replace(/^\uFEFF/,''));}catch(_){return {};}}
function json(res,status,data,headers={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(data));}
async function body(req){const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>2*1024*1024)throw new PortalError('上传内容超过2 MB限制。',413);chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch(_){throw new PortalError('请求格式不正确。',400);}}
function createPortal({config=loadConfig(),source,credentialStore,autoSource,memberStore,inventoryService,visionService,root=ROOT,now=Date.now}={}){
  let connector=source,configurationError=null;
  if(!connector)try{connector=createSource(config);}catch(e){configurationError=e.message;}
  const dataService=autoSource||createAutoSource({source:connector,credentialStore:credentialStore||createCredentialStore({root}),now});
  const members=memberStore||createMemberStore({root,admin:config.admin,now});
  function authorizeActor(actor,{review=false}={}){const current=members.get(actor.account);if(!current?.active||current.version!==actor.version)throw new PortalError('成员权限或登录状态已改变，请重新登录。',401);if(review&&!['admin','reviewer'].includes(current.role))throw new PortalError('只有指定复核人员可以复核盘点。',403);return current;}
  const inventory=inventoryService||createInventoryService({root,source:dataService,now,authorizeActor});
  const vision=visionService||createVisionService({root,config,now});
  async function stockCapabilities(){try{return await inventory.capabilities();}catch(_){return Object.fromEntries(['inbound','outbound','adjust'].map(key=>[key,{enabled:false,reason:'本机库存记录无法读取，请管理员核对存储文件。'}]));}}
  const tls=config.tls?.certFile&&config.tls?.keyFile?{cert:fs.readFileSync(path.resolve(root,config.tls.certFile)),key:fs.readFileSync(path.resolve(root,config.tls.keyFile))}:null;
  const configuredOrigins=new Set();
  for(const candidate of config.publicOrigins||[]){const value=new URL(candidate);if(value.protocol!=='https:'||value.username||value.password||value.pathname!=='/'||value.search||value.hash)throw new Error('手机访问地址必须是完整的HTTPS来源地址。');configuredOrigins.add(value.origin);}
  dataService.start();
  const sessions=new Map(),attempts=new Map();
  function sidOf(req){return /(?:^|;\s*)portal_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1];}
  function getSession(req){const sid=sidOf(req),session=sessions.get(sid);if(session&&session.expires>now()){const member=members.get(session.account);if(member?.active&&member.version===session.version)return {...member,expires:session.expires};}if(sid)sessions.delete(sid);return null;}
  function links(){if(!config.sourceBase)return {};const routes={weld:'/ngMould/hjBath/index',alarm:'/Spareparts/ErrorInfoSearch/index',spares:'/ProductSystem/GZJJManager/MoldSpareParts/SparepartsDetailed/index'};try{const url=new URL(config.sourceBase);return Object.fromEntries(Object.entries(routes).map(([key,route])=>[key,url.origin+'/#'+route]));}catch(_){return {};}}
  const handler=async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Permissions-Policy','camera=(self), microphone=(), geolocation=()');
    const address=server.address(),host=req.headers.host,protocol=tls?'https:':'http:',origin=`${protocol}//${host}`;
    const loopback=host===`127.0.0.1:${address.port}`||host===`localhost:${address.port}`;
    if(!loopback&&(!tls||!configuredOrigins.has(origin)))return json(res,403,{message:'此访问地址尚未由管理员配置。'});
    if(req.headers.origin&&req.headers.origin!==origin)return json(res,403,{message:'请求来源不匹配。'});
    let url;try{url=new URL(req.url,origin);}catch(_){return json(res,400,{message:'地址不正确。'});}
    if(url.pathname.startsWith('/local/')&&req.headers['sec-fetch-site']==='cross-site')return json(res,403,{message:'不接受跨站请求。'});
    try{
      const session=getSession(req);
      if(req.method==='GET'&&url.pathname==='/local/status'){
        const sourceStatus=dataService.status();
        const inventoryCapabilities=await stockCapabilities();
        return json(res,200,{authenticated:Boolean(session),connected:sourceStatus.state==='ready',account:session?.account||null,name:session?.name||null,role:session?.role||null,sourceStatus,configured:Boolean(connector),modules:{weld:Boolean(connector),alarm:Boolean(connector),spares:Boolean(connector),vision:true},writeEnabled:Object.values(inventoryCapabilities).some(value=>value.enabled),inventoryCapabilities,sourceUrls:session?links():{},environmentLabel:config.environmentLabel||'',note:configurationError});
      }
      if(req.method==='POST'&&url.pathname==='/local/login'){
        if(!String(req.headers['content-type']||'').startsWith('application/json'))throw new PortalError('登录请求需要JSON格式。',415);
        const data=await body(req);if(typeof data.username!=='string'||typeof data.password!=='string'||!data.username.trim()||!data.password||data.username.length>100||data.password.length>500)throw new PortalError('请填写账号和密码。',400);
        const account=data.username.trim(),prior=attempts.get(account);
        if(prior&&now()-prior.first<60000&&prior.count>=5)throw new PortalError('登录尝试过于频繁，请一分钟后重试。',429);
        attempts.set(account,prior&&now()-prior.first<60000?{first:prior.first,count:prior.count+1}:{first:now(),count:1});
        let member;try{member=members.authenticate(account,data.password);}finally{data.password='';}
        if(!member)throw new PortalError('工号或密码不正确，或该成员尚未获准登录。',401);
        attempts.delete(account);const old=sidOf(req);if(old)sessions.delete(old);
        for(const [key,value] of sessions)if(value.expires<=now())sessions.delete(key);
        const sid=crypto.randomBytes(32).toString('hex');sessions.set(sid,{account,version:member.version,expires:now()+SESSION_MS});
        dataService.start();const sourceStatus=dataService.status();
        return json(res,200,{authenticated:true,connected:sourceStatus.state==='ready',sourceStatus,account,name:member.name,role:member.role,inventoryCapabilities:await stockCapabilities()},{'Set-Cookie':`portal_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS/1000}${tls?'; Secure':''}`});
      }
      if(req.method==='POST'&&url.pathname==='/local/logout'){sessions.delete(sidOf(req));return json(res,200,{connected:false},{'Set-Cookie':'portal_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});}
      if(url.pathname.startsWith('/local/')){
        if(!session)throw new PortalError('请先登录工艺部门户。',401);
        if(req.method==='POST'&&!String(req.headers['content-type']||'').startsWith('application/json'))throw new PortalError('请求需要JSON格式。',415);
        if(req.method==='GET'&&url.pathname==='/local/vision/catalog'){
          const result=await vision.catalog();
          if(!getSession(req))throw new PortalError('会话已退出，请重新登录。',401);
          return json(res,200,result);
        }
        if(req.method==='POST'&&url.pathname==='/local/vision/catalog'){
          if(session.role!=='admin')throw new PortalError('只有管理员可以登记检具。',403);
          const input=await body(req);
          if(getSession(req)?.role!=='admin')throw new PortalError('管理员权限已改变，请重新登录。',401);
          const result=await vision.saveDraft(input);
          if(getSession(req)?.role!=='admin')throw new PortalError('会话已改变，请重新登录后核对登记结果。',401);
          return json(res,200,result);
        }
        if(req.method==='GET'&&url.pathname==='/local/vision/report'){
          const result=await vision.report(Object.fromEntries(url.searchParams));
          if(!getSession(req))throw new PortalError('会话已退出，请重新登录。',401);
          return json(res,200,result);
        }
        const visionRecord=/^\/local\/vision\/records\/([a-f0-9]{64})$/.exec(url.pathname);
        if(req.method==='GET'&&visionRecord){
          const result=await vision.detail(visionRecord[1]);
          if(!getSession(req))throw new PortalError('会话已退出，请重新登录。',401);
          return json(res,200,result);
        }
        if(req.method==='POST'&&url.pathname==='/local/vision/import'){
          if(session.role!=='admin')throw new PortalError('只有管理员可以导入检具记录。',403);
          const input=await body(req);
          if(getSession(req)?.role!=='admin')throw new PortalError('管理员权限已改变，请重新登录。',401);
          const result=await vision.importCsv(input);
          return json(res,200,result);
        }
        if(url.pathname==='/local/members'){
          if(session.role!=='admin')throw new PortalError('只有管理员可以管理工艺部成员。',403);
          if(req.method==='GET')return json(res,200,{members:members.list()});
          if(req.method==='POST'){const input=await body(req);let result;try{result=members.save(input,session);}finally{input.password='';}return json(res,200,result);}
        }
        if(req.method==='POST'&&url.pathname==='/local/password'){
          const input=await body(req);try{members.changePassword(session.account,input.oldPassword,input.newPassword);}finally{input.oldPassword='';input.newPassword='';}
          for(const [key,value] of sessions)if(value.account===session.account)sessions.delete(key);
          return json(res,200,{message:'密码已更新，请重新登录。',authenticated:false},{'Set-Cookie':`portal_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${tls?'; Secure':''}`});
        }
        if(req.method==='GET'&&url.pathname==='/local/inventory/catalog')return json(res,200,await inventory.catalog({search:(url.searchParams.get('search')||'').slice(0,200),code:(url.searchParams.get('code')||'').slice(0,2048)}));
        if(req.method==='GET'&&url.pathname==='/local/inventory/records')return json(res,200,await inventory.list({type:url.searchParams.get('type')||undefined,status:url.searchParams.get('status')||undefined},session));
        const stockRoutes={'/local/inventory/transactions':'transact','/local/inventory/counts':'count','/local/inventory/review':'review'};
        if(req.method==='POST'&&stockRoutes[url.pathname]){
          const input=await body(req),actor=getSession(req);if(!actor)throw new PortalError('登录状态已改变，请重新登录。',401);
          const result=await inventory[stockRoutes[url.pathname]](input,actor);return json(res,200,result);
        }
        if(req.method==='POST'&&url.pathname==='/local/connect'){
          if(session.role!=='admin')throw new PortalError('只有管理员可以配置公司系统连接。',403);
          if(!String(req.headers['content-type']||'').startsWith('application/json'))throw new PortalError('数据源设置需要JSON格式。',415);
          const data=await body(req);
          if(getSession(req)?.role!=='admin')throw new PortalError('管理员权限已改变，请重新登录。',401);
          if(typeof data.username!=='string'||typeof data.password!=='string'||!data.username||!data.password||data.username.length>100||data.password.length>500)throw new PortalError('请填写公司系统账号和密码。',400);
          let sourceStatus;try{sourceStatus=await dataService.configure(data);}finally{data.password='';}
          if(!getSession(req))throw new PortalError('门户会话已退出。',401);
          return json(res,200,{authenticated:true,connected:sourceStatus.state==='ready',sourceStatus});
        }
        if(req.method==='POST'&&url.pathname==='/local/disconnect'){
          if(session.role!=='admin')throw new PortalError('只有管理员可以配置公司系统连接。',403);
          const sourceStatus=await dataService.clear();
          return json(res,200,{authenticated:true,connected:false,sourceStatus});
        }
        const match=/^\/local\/data\/(weld|alarm|spares)$/.exec(url.pathname);
        if(req.method==='GET'&&match){
          if(match[1]==='spares'&&session.role!=='admin')throw new PortalError('请使用工艺部备件工作台查询已配置范围内的备件。',403);
          const module=match[1],query=parseQuery(url.searchParams,module);
          const result=await dataService.read(module,query);
          if(!getSession(req))throw new PortalError('会话已退出，请重新登录。',401);
          return json(res,200,result);
        }
        if(req.method==='POST'&&url.pathname==='/local/import-preview'){
          const input=await body(req);const {previewImport}=require('./lib/import-preview.cjs');
          if(typeof input.content!=='string'||typeof input.filename!=='string')throw new PortalError('请选择CSV UTF-8文件。',400);
          return json(res,200,previewImport(input.content,{filename:input.filename}));
        }
        throw new PortalError('本地服务未提供此操作。',404);
      }
      if(req.method!=='GET'&&req.method!=='HEAD')throw new PortalError('不支持该请求方式。',405);
      let relative;try{relative=decodeURIComponent(url.pathname);}catch(_){throw new PortalError('无效路径。',400);}
      const filename=path.resolve(PUBLIC,'.'+(relative==='/'?'/index.html':relative));
      if(!filename.startsWith(PUBLIC+path.sep))throw new PortalError('文件不存在。',404);
      const allowed={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8'};
      const type=allowed[path.extname(filename)];if(!type)throw new PortalError('文件不存在。',404);
      let file;try{file=await fs.promises.readFile(filename);}catch(_){throw new PortalError('文件不存在。',404);}
      res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:file);
    }catch(error){if(!res.headersSent)json(res,error.status||500,{message:error.status?error.message:'本地服务暂时无法完成此操作，请重试。',code:error.code,recordId:error.recordId,outcome:error.outcome,sourceStatus:dataService.status()});else res.end();}
  };
  const server=tls?https.createServer(tls,handler):http.createServer(handler);
  server.once('close',()=>dataService.stop());
  server.requestTimeout=65000;server.headersTimeout=15000;
  return server;
}
if(require.main===module){const config=loadConfig(),port=Number(config.port)||4173,listenHost=config.listenHost||'127.0.0.1';if(!['127.0.0.1','localhost'].includes(listenHost)&&(!config.tls?.certFile||!config.tls?.keyFile||!config.publicOrigins?.length))throw new Error('手机访问需先配置可信HTTPS证书与publicOrigins。');const server=createPortal({config});server.on('error',err=>{console.error(err.code==='EADDRINUSE'?'端口已占用，请关闭已运行的门户或修改本地配置。':'本地服务启动失败。');process.exitCode=1;});server.listen(port,listenHost,()=>console.log(`工艺部门户已启动：${config.tls?'https':'http'}://${listenHost}:${port}`));}
module.exports={createPortal,loadConfig};
