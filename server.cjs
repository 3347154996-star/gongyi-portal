'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {createSource,parseQuery,PortalError}=require('./lib/source.cjs');
const {verifyAdmin}=require('./lib/admin.cjs');
const ROOT=__dirname, PUBLIC=path.join(ROOT,'public');
const SESSION_MS=8*60*60*1000;
function loadConfig(){try{return JSON.parse(fs.readFileSync(path.join(ROOT,'config.local.json'),'utf8').replace(/^\uFEFF/,''));}catch(_){return {};}}
function json(res,status,data,headers={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(data));}
async function body(req){const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>2*1024*1024)throw new PortalError('上传内容超过2 MB限制。',413);chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch(_){throw new PortalError('请求格式不正确。',400);}}
function createPortal({config=loadConfig(),source,now=Date.now}={}){
  let connector=source,configurationError=null;
  if(!connector)try{connector=createSource(config);}catch(e){configurationError=e.message;}
  const sessions=new Map(),attempts=new Map();
  function sidOf(req){return /(?:^|;\s*)portal_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1];}
  function getSession(req){const sid=sidOf(req),session=sessions.get(sid);if(session&&session.expires>now())return session;if(sid)sessions.delete(sid);return null;}
  function links(){if(!config.sourceBase)return {};const routes={weld:'/ngMould/hjBath/index',alarm:'/Spareparts/ErrorInfoSearch/index',spares:'/ProductSystem/GZJJManager/MoldSpareParts/SparepartsDetailed/index'};try{const url=new URL(config.sourceBase);return Object.fromEntries(Object.entries(routes).map(([key,route])=>[key,url.origin+'/#'+route]));}catch(_){return {};}}
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const address=server.address(),host=req.headers.host,expected=`127.0.0.1:${address.port}`;
    if(host!==expected&&host!==`localhost:${address.port}`)return json(res,403,{message:'此服务只接受本机访问。'});
    const origin=`http://${host}`;
    if(req.headers.origin&&req.headers.origin!==origin)return json(res,403,{message:'请求来源不匹配。'});
    let url;try{url=new URL(req.url,origin);}catch(_){return json(res,400,{message:'地址不正确。'});}
    if(url.pathname.startsWith('/local/')&&req.headers['sec-fetch-site']==='cross-site')return json(res,403,{message:'不接受跨站请求。'});
    try{
      const session=getSession(req);
      if(req.method==='GET'&&url.pathname==='/local/status')return json(res,200,{authenticated:Boolean(session),connected:Boolean(session?.token),account:session?.account||null,role:session?'admin':null,sourceAccount:session?.sourceAccount||null,configured:Boolean(connector),modules:{weld:Boolean(connector),alarm:Boolean(connector),spares:Boolean(connector)},writeEnabled:false,sourceUrls:links(),note:configurationError});
      if(req.method==='POST'&&url.pathname==='/local/login'){
        if(!String(req.headers['content-type']||'').startsWith('application/json'))throw new PortalError('登录请求需要JSON格式。',415);
        const data=await body(req);if(typeof data.username!=='string'||typeof data.password!=='string'||!data.username.trim()||!data.password||data.username.length>100||data.password.length>500)throw new PortalError('请填写账号和密码。',400);
        if(!config.admin)throw new PortalError('本机尚未设置管理员，请运行 npm run setup。',503);
        const account=data.username.trim(),prior=attempts.get(account);
        if(prior&&now()-prior.first<60000&&prior.count>=5)throw new PortalError('登录尝试过于频繁，请一分钟后重试。',429);
        attempts.set(account,prior&&now()-prior.first<60000?{first:prior.first,count:prior.count+1}:{first:now(),count:1});
        let valid;try{valid=verifyAdmin(config.admin,account,data.password);}finally{data.password='';}
        if(!valid)throw new PortalError('管理员账号或密码不正确。',401);
        attempts.delete(account);const old=sidOf(req);if(old)sessions.delete(old);
        for(const [key,value] of sessions)if(value.expires<=now())sessions.delete(key);
        const sid=crypto.randomBytes(32).toString('hex');sessions.set(sid,{account,token:null,sourceAccount:null,generation:0,expires:now()+SESSION_MS,cache:new Map(),pending:new Map()});
        return json(res,200,{authenticated:true,connected:false,account,role:'admin'},{'Set-Cookie':`portal_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS/1000}`});
      }
      if(req.method==='POST'&&url.pathname==='/local/logout'){sessions.delete(sidOf(req));return json(res,200,{connected:false},{'Set-Cookie':'portal_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});}
      if(url.pathname.startsWith('/local/')){
        if(!session)throw new PortalError('请先登录工艺部门户。',401);
        if(req.method==='POST'&&url.pathname==='/local/connect'){
          const data=await body(req);
          if(typeof data.username!=='string'||typeof data.password!=='string'||!data.username||!data.password||data.username.length>100||data.password.length>500)throw new PortalError('请填写公司系统账号和密码。',400);
          if(!connector)throw new PortalError(configurationError||'公司系统连接未配置。',503);
          const attemptKey='source:'+data.username,prior=attempts.get(attemptKey);
          if(prior&&now()-prior.first<60000&&prior.count>=5)throw new PortalError('连接尝试过于频繁，请一分钟后重试。',429);
          attempts.set(attemptKey,prior&&now()-prior.first<60000?{first:prior.first,count:prior.count+1}:{first:now(),count:1});
          let auth;try{auth=await connector.login(data.username,data.password);}catch(e){if(e.status===401)e.status=400;throw e;}finally{data.password='';}
          if(!getSession(req))throw new PortalError('门户会话已退出。',401);
          session.token=auth.token;session.sourceAccount=auth.account;session.sourceContext={token:auth.token};session.generation++;session.cache.clear();session.pending=new Map();attempts.delete(attemptKey);
          return json(res,200,{authenticated:true,connected:true,sourceAccount:session.sourceAccount});
        }
        if(req.method==='POST'&&url.pathname==='/local/disconnect'){
          session.token=null;session.sourceAccount=null;session.sourceContext=null;session.generation++;session.cache.clear();session.pending=new Map();
          return json(res,200,{authenticated:true,connected:false});
        }
        const match=/^\/local\/data\/(weld|alarm|spares)$/.exec(url.pathname);
        if(req.method==='GET'&&match){
          if(!session.token)throw new PortalError('已登录门户，请先连接公司数据。',428);
          const generation=session.generation;
          const module=match[1],query=parseQuery(url.searchParams,module),key=module+JSON.stringify({...query,page:1,size:200});
          const ttl=module==='weld'&&query.view==='live'?14000:module==='weld'?60000:module==='spares'?30000:14000;
          let result;
          // Source data and rendered pages are cached only in the current session.
          const exactKey=key+':'+query.page+':'+query.size,exact=session.cache.get(exactKey);
          if(exact&&now()-exact.at<ttl)result=exact.data;
          else{
            const pendingMap=session.pending;
            if(!pendingMap.has(exactKey))pendingMap.set(exactKey,connector.read(module,query,session.sourceContext));
            try{result=await pendingMap.get(exactKey);if(session.generation===generation)session.cache.set(exactKey,{at:now(),data:result});while(session.cache.size>12)session.cache.delete(session.cache.keys().next().value);}catch(e){if(e.status===401){if(session.generation===generation){session.token=null;session.sourceAccount=null;session.sourceContext=null;session.generation++;session.cache.clear();}e.status=428;e.message='公司数据连接已过期，请重新连接；门户登录仍有效。';}throw e;}finally{pendingMap.delete(exactKey);}
          }
          if(!getSession(req))throw new PortalError('会话已退出，请重新登录。',401);
          if(session.generation!==generation||!session.token)throw new PortalError('公司数据连接已变更，请重新查询。',428);
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
      const allowed={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'};
      const type=allowed[path.extname(filename)];if(!type)throw new PortalError('文件不存在。',404);
      let file;try{file=await fs.promises.readFile(filename);}catch(_){throw new PortalError('文件不存在。',404);}
      res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:file);
    }catch(error){if(!res.headersSent)json(res,error.status||500,{message:error.status?error.message:'本地服务暂时无法完成此操作，请重试。'});else res.end();}
  });
  server.requestTimeout=65000;server.headersTimeout=15000;
  return server;
}
if(require.main===module){const config=loadConfig(),port=Number(config.port)||4173;const server=createPortal({config});server.on('error',err=>{console.error(err.code==='EADDRINUSE'?'端口已占用，请关闭已运行的门户或修改本地配置。':'本地服务启动失败。');process.exitCode=1;});server.listen(port,'127.0.0.1',()=>console.log(`工艺部门户已启动：http://127.0.0.1:${port}`));}
module.exports={createPortal,loadConfig};
