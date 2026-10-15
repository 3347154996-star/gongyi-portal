'use strict';
const {loadConfig}=require('./server.cjs');
const {createProductPrivacy}=require('./lib/product-privacy.cjs');
const {createPenetrationService}=require('./lib/penetration.cjs');
async function main(){const root=__dirname,config=loadConfig(),privacy=createProductPrivacy({root,config}),service=createPenetrationService({root,config,privacy});const timer=setInterval(()=>{const progress=service.status().progress;if(progress)console.log(JSON.stringify({progress}));},15000);try{await service.sync();const report=service.report();console.log(JSON.stringify({configured:report.enabled,state:report.sync.state,lastSuccessAt:report.sync.lastSuccessAt,summary:report.summary,diagnostics:report.diagnostics,unit:report.unit},null,2));process.exitCode=report.enabled&&report.sync.state==='ready'?0:1;}finally{clearInterval(timer);service.stop();}}
if(require.main===module)main().catch(()=>{console.error('熔深连接检查未完成，请核对本机配置、共享权限及表格格式。');process.exitCode=1;});
module.exports={main};
