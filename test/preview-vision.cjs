'use strict';
// Isolated local UI verification. Does not load company config or credentials.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createPortal}=require('../server.cjs');
const {makeAdminConfig}=require('../lib/admin.cjs');
const {createVisionService}=require('../lib/vision.cjs');
(async()=>{
  const tempBase=path.resolve(os.tmpdir());
  const root=await fs.mkdtemp(path.join(tempBase,'gongyi-vision-preview-'));
  const credentialStore={async load(){return null;},async save(){throw Error('Preview only');},async remove(){}};
  const autoSource={start(){},stop(){},status(){return {state:'unconfigured',configured:false};},async read(){throw Error('No company connection in preview');}};
  const inventoryService={async capabilities(){return {};}};
  const vision=createVisionService({root});
  const input=process.argv[2];
  if(input)await vision.importCsv({filename:path.basename(input),content:await fs.readFile(input),deviceId:'vision-01'});
  const password='Vision-preview-only-2026';
  const server=createPortal({root,config:{admin:makeAdminConfig('vision-preview',password),environmentLabel:'视觉检具离线验证'},credentialStore,autoSource,inventoryService,visionService:vision});
  server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}/#vision`,username:'vision-preview',password,sampleLoaded:Boolean(input)})));
  let closing=false;
  const close=async()=>{if(closing)return;closing=true;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));const resolved=path.resolve(root);if(path.dirname(resolved)===tempBase&&path.basename(resolved).startsWith('gongyi-vision-preview-'))await fs.rm(resolved,{recursive:true,force:true});process.exit(0);};
  process.on('SIGINT',close);process.on('SIGTERM',close);
  process.stdin.on('data',data=>{if(String(data).trim()==='stop')close();});
})().catch(error=>{console.error(error.message);process.exitCode=1;});
