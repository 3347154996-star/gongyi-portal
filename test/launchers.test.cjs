'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const scripts=['启动门户.cmd','startup-diagnostics.cmd'];
test('Windows entrypoints are ASCII with explicit CRLF lines',async()=>{for(const script of scripts){const data=await fs.readFile(path.join(__dirname,'..',script));assert.ok([...data].every(byte=>byte<128),script);const text=data.toString();assert.ok(text.includes('\r\n'),script);assert.ok(!/(?<!\r)\n/.test(text),script);}});
test('bundled entrypoints work under CMD in a Unicode path and preserve application failures',{skip:process.platform!=='win32'},async t=>{
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'portal-cmd-'));
  const folder=path.join(root,'合成 门户');
  t.after(async()=>{const resolved=await fs.realpath(root);assert.equal(path.dirname(resolved),parent);assert.ok(path.basename(resolved).startsWith('portal-cmd-'));await fs.rm(resolved,{recursive:true,force:true});});
  await fs.mkdir(path.join(folder,'portable-node'),{recursive:true});
  await fs.copyFile(process.execPath,path.join(folder,'portable-node/node.exe'));
  for(const script of scripts)await fs.copyFile(path.join(__dirname,'..',script),path.join(folder,script));
  await fs.writeFile(path.join(folder,'server.cjs'),"console.log('SYNTHETIC_ENTRY_REACHED');process.exitCode=7;");
  await fs.writeFile(path.join(folder,'config.local.json'),'{"secret":"TEST_CONFIG_SECRET"}');
  const options={cwd:folder,encoding:'utf8',timeout:15000,windowsHide:true,env:{...process.env,PATH:path.join(process.env.SystemRoot,'System32'),TEMP:root,TMP:root}};
  for(const script of scripts){const result=spawnSync(process.env.ComSpec||'cmd.exe',['/d','/c',script+' <nul'],options);assert.ifError(result.error);assert.equal(result.status,7,result.stdout+result.stderr);assert.match(result.stdout,/SYNTHETIC_ENTRY_REACHED/);assert.doesNotMatch(result.stdout+result.stderr,/not recognized|TEST_CONFIG_SECRET/i);}
  const logs=(await fs.readdir(root)).filter(file=>file.startsWith('gongyi-startup-')&&file.endsWith('.log'));
  assert.equal(logs.length,1);const log=await fs.readFile(path.join(root,logs[0]),'utf8');assert.match(log,/SYNTHETIC_ENTRY_REACHED/);assert.doesNotMatch(log,/TEST_CONFIG_SECRET/);
  await fs.rename(path.join(folder,'server.cjs'),path.join(folder,'synthetic-server-backup.cjs'));
  const missing=spawnSync(process.env.ComSpec||'cmd.exe',['/d','/c','启动门户.cmd <nul'],options);assert.equal(missing.status,2);assert.match(missing.stdout,/Extract the complete ZIP/);
});
