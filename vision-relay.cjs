'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {relayOnce,runWorker,settings,requestStop,consumeStopRequest}=require('./lib/vision-relay.cjs');
if(process.argv[2]==='--worker'&&process.send){
  process.once('message',async message=>{
    try{if(message?.type!=='run')throw Error();const value=await relayOnce(message.config);process.send({type:'result',value},()=>process.exit(0));}
    catch(error){process.send({type:'error',code:error.code||'VISION_RELAY_WORKER'},()=>process.exit(1));}
  });
}else{
  main().catch(()=>{process.stderr.write('检具中转配置或本机状态无法读取；未输出路径及原始记录。\n');process.exitCode=1;});
}
function wait(milliseconds,signal){return new Promise(resolve=>{if(signal.aborted)return resolve();const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,milliseconds);signal.addEventListener('abort',done,{once:true});});}
async function main(){
  const mode=process.argv[2];
  if(!['--once','--watch','--stop'].includes(mode)||process.argv.length!==3){process.stdout.write('node vision-relay.cjs --once | --watch | --stop\n读取独立 vision-relay.local.json；watch 使用 Ctrl+C 或 --stop 停止，不自动安装开机任务。\n');process.exitCode=mode==='--help'?0:1;return;}
  const directory=path.join(__dirname,'runtime/vision-relay');
  if(mode==='--stop'){const requested=await requestStop(directory);process.stdout.write(requested?'已请求当前中转实例停止；请查看本机状态确认完成。\n':'没有中转运行锁，无需停止。\n');return;}
  const config=settings(JSON.parse((await fs.readFile(path.join(__dirname,'vision-relay.local.json'),'utf8')).replace(/^\uFEFF/,'')),__dirname);
  await fs.mkdir(directory,{recursive:true});
  const lockFile=path.join(directory,'lock.json');let lock;
  try{lock=await fs.open(lockFile,'wx');}catch(error){if(error.code==='EEXIST'){process.stderr.write('中转已有实例或遗留运行锁。请核对本机进程后再处理，不会自动停止任何 PID。\n');process.exitCode=1;return;}throw error;}
  const controller=new AbortController(),instanceId=crypto.randomUUID();
  const status={pid:process.pid,instanceId,mode:mode.slice(2),startedAt:new Date().toISOString(),state:'starting',lastAttemptAt:null,lastSuccessAt:null};
  const stop=()=>controller.abort();process.on('SIGINT',stop);process.on('SIGTERM',stop);
  let checkingStop=false;
  const stopTimer=setInterval(async()=>{if(checkingStop)return;checkingStop=true;try{if(await consumeStopRequest(directory,instanceId))stop();}catch(_){}finally{checkingStop=false;}},1000);
  const saveStatus=async()=>{const temp=path.join(directory,'status.'+instanceId+'.tmp');await fs.writeFile(temp,JSON.stringify(status,null,2)+'\n');await fs.rename(temp,path.join(directory,'status.json'));};
  try{
    await lock.writeFile(JSON.stringify({pid:process.pid,instanceId,startedAt:status.startedAt}));await lock.close();lock=null;await saveStatus();
    do{
      status.lastAttemptAt=new Date().toISOString();status.state='running';await saveStatus();
      try{
        const result=await runWorker({workerFile:__filename,config,timeoutMs:config.timeoutSeconds*1000,signal:controller.signal});
        Object.assign(status,result,{lastSuccessAt:new Date().toISOString(),errorCode:null});
        process.stdout.write(JSON.stringify(result)+'\n');
      }catch(error){
        status.state=controller.signal.aborted?'stopped':'error';status.errorCode=error.code||'VISION_RELAY_WORKER';
        if(!controller.signal.aborted)process.stdout.write(JSON.stringify({state:'error',code:status.errorCode,outcome:'not-confirmed'})+'\n');
        if(mode==='--once'&&!controller.signal.aborted)process.exitCode=1;
      }
      await saveStatus();if(mode==='--once'||controller.signal.aborted)break;
      await wait(config.intervalSeconds*1000,controller.signal);
    }while(!controller.signal.aborted);
  }finally{
    clearInterval(stopTimer);
    if(lock)await lock.close().catch(()=>{});
    status.state=controller.signal.aborted?'stopped':status.state;await saveStatus().catch(()=>{});
    try{const owner=JSON.parse(await fs.readFile(lockFile,'utf8'));if(owner.instanceId===instanceId)await fs.rm(lockFile);}catch(_){}
    await consumeStopRequest(directory,instanceId).catch(()=>{});
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  }
}
