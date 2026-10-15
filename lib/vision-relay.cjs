'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {fork}=require('node:child_process');
const {validateVisionSnapshot}=require('./vision.cjs');
const MAX_BYTES=128*1024*1024;
function failure(code){const error=new Error('检具中转未完成，保留已有目标文件。');error.code=code;return error;}
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function settings(value,root=process.cwd()){
  if(!value||typeof value!=='object')throw failure('VISION_RELAY_CONFIG');
  const result={};
  for(const key of ['sourceFile','destinationFile']){
    const input=value[key];
    if(typeof input!=='string'||!input.trim()||input.length>4096||input.includes('\0')||/^[a-z][a-z\d+.-]*:\/\//i.test(input))throw failure('VISION_RELAY_CONFIG');
    result[key]=path.resolve(root,input.trim());
  }
  result.intervalSeconds=value.intervalSeconds??30;result.timeoutSeconds=value.timeoutSeconds??60;
  if(!Number.isInteger(result.intervalSeconds)||result.intervalSeconds<5||result.intervalSeconds>3600||!Number.isInteger(result.timeoutSeconds)||result.timeoutSeconds<1||result.timeoutSeconds>300)throw failure('VISION_RELAY_CONFIG');
  const canonical=file=>process.platform==='win32'?file.toLowerCase():file;
  if(canonical(result.sourceFile)===canonical(result.destinationFile))throw failure('VISION_RELAY_SAME_PATH');
  return result;
}
function scanTime(document){
  const value=document.last_scan?.scanned_at_utc;
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value))return null;
  const milliseconds=Date.parse(value);
  return Number.isFinite(milliseconds)&&new Date(milliseconds).toISOString().slice(0,19)===value.slice(0,19)?milliseconds:null;
}
function inspectSnapshot(bytes){
  try{
    const document=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,''));
    // Keep the complete snapshot validator as the single business-rule boundary.
    // Neither its normalized records nor the parsed source document survive this call.
    const recordCount=validateVisionSnapshot(document,{retainRecords:false});
    return {recordCount,scan:scanTime(document),collectorErrorCount:Array.isArray(document.last_scan?.errors)?document.last_scan.errors.length:0};
  }catch(_){throw failure('VISION_RELAY_FORMAT');}
}
async function readSnapshotBytes(filename){
  const handle=await fs.open(filename,'r');
  try{
    const stat=await handle.stat({bigint:true});if(!stat.isFile()||stat.size>MAX_BYTES)throw failure('VISION_RELAY_SIZE');
    const bytes=await handle.readFile();if(bytes.length>MAX_BYTES)throw failure('VISION_RELAY_SIZE');
    return {bytes,stat};
  }finally{await handle.close();}
}
async function inspectTarget(filename,source){
  const target=await readSnapshotBytes(filename);
  if(source.stat.dev===target.stat.dev&&source.stat.ino===target.stat.ino&&source.stat.ino!==0n)throw failure('VISION_RELAY_SAME_PATH');
  // Byte identity to the already-validated source proves the target's schema and scan.
  // Stat timestamps alone are never treated as proof that shared-file content is unchanged.
  if(target.bytes.length===source.bytes.length&&hash(target.bytes)===source.sha256)return {unchanged:true,scan:source.scan};
  return {unchanged:false,...inspectSnapshot(target.bytes)};
}
async function fileHash(filename){
  const digest=crypto.createHash('sha256'),handle=await fs.open(filename,'r');
  try{
    // Verification still reads every byte, without allocating another snapshot-sized Buffer.
    const buffer=Buffer.allocUnsafe(64*1024);let total=0;
    while(true){const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;total+=bytesRead;if(total>MAX_BYTES)throw failure('VISION_RELAY_VERIFY');digest.update(buffer.subarray(0,bytesRead));}
    return digest.digest('hex');
  }finally{await handle.close();}
}
async function relayOnce(input){
  const config=settings(input),canonical=file=>process.platform==='win32'?file.toLowerCase():file;
  let temporary;
  try{
    const sourcePath=await fs.realpath(config.sourceFile);
    let destinationPath;try{destinationPath=await fs.realpath(config.destinationFile);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(destinationPath&&canonical(sourcePath)===canonical(destinationPath))throw failure('VISION_RELAY_SAME_PATH');
    const source=await readSnapshotBytes(config.sourceFile);Object.assign(source,inspectSnapshot(source.bytes),{sha256:hash(source.bytes)});let target=null,replacedInvalidTarget=false;
    try{target=await inspectTarget(config.destinationFile,source);}catch(error){
      if(['VISION_RELAY_FORMAT','VISION_RELAY_SIZE'].includes(error.code))replacedInvalidTarget=true;
      else if(error.code!=='ENOENT')throw error;
    }
    if(target?.scan!==null&&target?.scan!==undefined&&source.scan!==null&&target.scan>source.scan)throw failure('VISION_RELAY_ROLLBACK');
    const collectorErrorCount=source.collectorErrorCount;
    const scanAgeSeconds=source.scan===null?null:Math.round((Date.now()-source.scan)/1000);
    const collectorState=source.scan===null||scanAgeSeconds< -30||collectorErrorCount?'error':scanAgeSeconds>7200?'waiting':'ready';
    const result={recordCount:source.recordCount,sha256:source.sha256,collectorScannedAt:source.scan===null?null:new Date(source.scan).toISOString(),collectorState,collectorErrorCount,scanAgeSeconds,replacedInvalidTarget};
    if(target?.unchanged)return {...result,state:'unchanged'};
    await fs.mkdir(path.dirname(config.destinationFile),{recursive:true});
    temporary=config.destinationFile+'.relay-'+process.pid+'-'+crypto.randomUUID()+'.tmp';
    const handle=await fs.open(temporary,'wx');try{await handle.writeFile(source.bytes);await handle.sync();}finally{await handle.close();}
    if(await fileHash(temporary)!==source.sha256)throw failure('VISION_RELAY_VERIFY');
    await fs.rename(temporary,config.destinationFile);temporary=null;
    return {...result,state:'copied'};
  }catch(error){if(error.code?.startsWith('VISION_RELAY_'))throw error;throw failure(['EACCES','EPERM','ENOENT'].includes(error.code)?error.code:'VISION_RELAY_IO');}
  finally{if(temporary)await fs.rm(temporary,{force:true}).catch(()=>{});}
}
function runWorker({workerFile,config,timeoutMs,signal,spawn=fork}){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(failure('VISION_RELAY_STOPPED'));return;}
    let child,timer,result,error,closed=false,terminating=false;
    const stop=code=>{if(closed||terminating)return;terminating=true;error=failure(code);try{child.kill();}catch(_){};};
    const abort=()=>stop('VISION_RELAY_STOPPED');
    try{child=spawn(workerFile,['--worker'],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,execArgv:[]});}
    catch(_){reject(failure('VISION_RELAY_WORKER'));return;}
    child.on('message',message=>{if(terminating)return;if(message?.type==='result')result=message.value;else if(message?.type==='error')error=failure(/^VISION_RELAY_[A-Z_]+$|^(?:EACCES|EPERM|ENOENT)$/.test(message.code)?message.code:'VISION_RELAY_WORKER');});
    child.on('error',()=>stop('VISION_RELAY_WORKER'));
    child.once('close',code=>{closed=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error)reject(error);else if(result&&code===0)resolve(result);else reject(failure('VISION_RELAY_WORKER'));});
    timer=setTimeout(()=>stop('VISION_RELAY_TIMEOUT'),timeoutMs??60000);signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    try{child.send({type:'run',config});}catch(_){stop('VISION_RELAY_WORKER');}
  });
}
async function requestStop(directory){
  let owner;
  try{owner=JSON.parse(await fs.readFile(path.join(directory,'lock.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return false;throw failure('VISION_RELAY_LOCK');}
  if(typeof owner.instanceId!=='string'||!/^[a-f\d-]{36}$/i.test(owner.instanceId))throw failure('VISION_RELAY_LOCK');
  const temporary=path.join(directory,'stop-request.'+crypto.randomUUID()+'.tmp');
  try{await fs.writeFile(temporary,JSON.stringify({instanceId:owner.instanceId}),{flag:'wx'});await fs.rename(temporary,path.join(directory,'stop-request.json'));}
  finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
  return true;
}
async function consumeStopRequest(directory,instanceId){
  const filename=path.join(directory,'stop-request.json');let request;
  try{request=JSON.parse(await fs.readFile(filename,'utf8'));}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return false;throw error;}
  if(request.instanceId!==instanceId)return false;
  await fs.rm(filename,{force:true});return true;
}
module.exports={relayOnce,runWorker,settings,requestStop,consumeStopRequest};
