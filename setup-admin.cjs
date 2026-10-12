'use strict';
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const {makeAdminConfig}=require('./lib/admin.cjs');
async function main(){
  if(!process.stdin.isTTY)throw new Error('请在本机终端运行管理员设置。');
  const rl=readline.createInterface({input:process.stdin,output:process.stdout});
  const username=await new Promise(resolve=>rl.question('管理员账号：',resolve));rl.close();
  process.stdout.write('管理员密码（输入不显示）：');process.stdin.setRawMode(true);process.stdin.resume();
  let password='';await new Promise((resolve,reject)=>{function input(buffer){for(const ch of buffer.toString('utf8')){if(ch==='\u0003'){process.stdin.off('data',input);reject(new Error('已取消。'));return;}if(ch==='\r'||ch==='\n'){process.stdin.off('data',input);resolve();return;}if(ch==='\u007f'||ch==='\b')password=password.slice(0,-1);else password+=ch;}}process.stdin.on('data',input);});
  process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');
  const file=path.join(__dirname,'config.local.json');let config={};if(fs.existsSync(file))config=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  config.admin=makeAdminConfig(username,password);password='';fs.writeFileSync(file,JSON.stringify(config,null,2)+'\n',{encoding:'utf8',mode:0o600});
  process.stdout.write('管理员已设置，仅在本机保存加盐密码摘要。请重新启动门户。\n');
}
main().catch(()=>{if(process.stdin.isTTY)process.stdin.setRawMode(false);process.stderr.write('\n管理员设置未完成。\n');process.exitCode=1;process.stdin.pause();});
