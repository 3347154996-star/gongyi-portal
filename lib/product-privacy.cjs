'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {PortalError}=require('./source.cjs');
const NAME_KEYS=new Set(['item_name','materialName','materialNames','partName','partNames','parts','productName','productNames','产品名称','物料名称','型号名称']);
const FILE_KEYS=new Set(['sourceFile','source_path','sourcePath','filename','fileName']);
const TOKEN=/(?:P|F)-[A-F0-9]{16}/g;
function createProductPrivacy({root,config={}}){
  const productNamesMode=config.privacy?.productNames??'alias';
  if(!['original','alias'].includes(productNamesMode))throw new PortalError('产品名称显示模式无效，请检查本机配置。',503);
  const filename=path.join(root,'runtime','product-aliases.json');
  let secret,dirty=false,replacer=null;const aliases=new Map(),reverse=new Map(),literalTokens=new Set();
  try{const saved=JSON.parse(fs.readFileSync(filename,'utf8'));if(saved.version!==1||!/^[a-f0-9]{64}$/.test(saved.secret)||!Array.isArray(saved.entries))throw Error();secret=saved.secret;for(const [raw,code] of saved.entries){if(typeof raw!=='string'||typeof code!=='string'||!/^([PF])-[A-F0-9]{16}$/.test(code)||reverse.has(code)&&reverse.get(code)!==raw)throw Error();aliases.set(raw,code);reverse.set(code,raw);}}
  catch(e){if(e.code!=='ENOENT')throw new PortalError('产品代号配置无法读取，请检查本机代号文件；为保护名称已停止提供数据。',503);secret=crypto.randomBytes(32).toString('hex');}
  const isAlias=value=>/^[PF]-[A-F0-9]{16}$/.test(value);
  function rememberOriginal(value){
    // Only retain tokens that could collide with this immutable legacy registry.
    // This set cannot grow beyond the registry; source text and records are not retained.
    if(typeof value==='string'){for(const token of value.match(TOKEN)||[])if(reverse.has(token))literalTokens.add(token);}
    else if(Array.isArray(value)){for(const item of value)rememberOriginal(item);}
    else if(value&&typeof value==='object'){for(const [key,item] of Object.entries(value)){rememberOriginal(key);rememberOriginal(item);}}
    return value;
  }
  function alias(value,kind='P'){if(productNamesMode==='original')return rememberOriginal(String(value??''));const raw=String(value??'').trim();if(!raw||raw==='all'||isAlias(raw))return raw;if(aliases.has(raw))return aliases.get(raw);if(aliases.size>=50000)throw new PortalError('产品代号数量超过本机上限，请管理员核对。',503);const code=kind+'-'+crypto.createHmac('sha256',secret).update(raw).digest('hex').slice(0,16).toUpperCase();if(reverse.has(code)&&reverse.get(code)!==raw)throw new PortalError('产品代号发生冲突，请管理员核对。',503);aliases.set(raw,code);reverse.set(code,raw);dirty=true;return code;}
  function learn(value,key='',insideNames=false){if(productNamesMode==='original'){rememberOriginal(value);return;}if(typeof value==='string'){if(insideNames&&value!=='all')alias(value);else if(FILE_KEYS.has(key))alias(value,'F');return;}if(Array.isArray(value)){for(const item of value)learn(item,key,insideNames||NAME_KEYS.has(key));return;}if(!value||typeof value!=='object')return;if(insideNames&&value.value==='all')return;for(const [k,v] of Object.entries(value))learn(v,k,NAME_KEYS.has(k)||(insideNames&&['value','label','name'].includes(k)));}
  function save(){if(!dirty)return;fs.mkdirSync(path.dirname(filename),{recursive:true});const tmp=filename+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify({version:1,secret,entries:[...aliases]}),{flag:'wx',mode:0o600});fs.renameSync(tmp,filename);dirty=false;}catch(_){try{fs.unlinkSync(tmp);}catch(_){}throw new PortalError('产品代号未能保存，本次未返回业务名称，请检查本机存储。',503);}}
  function replaceText(value){if(isAlias(value))return value;if(/^\d+(?:\.\d+)?$/.test(value))return value;if(aliases.has(value))return aliases.get(value);if(!replacer||replacer.size!==aliases.size){const terms=[...aliases.keys()].filter(raw=>raw.length>=2&&!/^\d+(?:\.\d+)?$/.test(raw)).sort((a,b)=>b.length-a.length);replacer={size:aliases.size,regex:terms.length?new RegExp(terms.map(raw=>raw.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'g'):null};}return replacer.regex?value.split(/((?:P|F)-[A-F0-9]{16})/g).map((part,index)=>index%2?part:part.replace(replacer.regex,raw=>aliases.get(raw))).join(''):value;}
  function walk(value,convert){if(typeof value==='string')return convert(value);if(Array.isArray(value))return value.map(v=>walk(v,convert));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[convert(k),walk(v,convert)]));return value;}
  function protect(value){if(productNamesMode==='original')return walk(value,rememberOriginal);learn(value);save();function visit(value,key='',insideNames=false){if(typeof value==='string')return (insideNames||FILE_KEYS.has(key))&&value!=='all'?(aliases.get(value)||replaceText(value)):replaceText(value);if(Array.isArray(value))return value.map(item=>visit(item,key,insideNames||NAME_KEYS.has(key)));if(value&&typeof value==='object'){const names=insideNames&&value.value!=='all';return Object.fromEntries(Object.entries(value).map(([k,v])=>[aliases.get(k)||replaceText(k),visit(v,k,NAME_KEYS.has(k)||(names&&['value','label','name'].includes(k)))]));}return value;}return visit(value);}
  function restore(value){const original=token=>productNamesMode==='original'&&literalTokens.has(token);return walk(value,text=>original(text)?text:reverse.get(text)||text.replace(TOKEN,token=>original(token)?token:reverse.get(token)||token));}
  if(productNamesMode==='original')for(const raw of aliases.keys())rememberOriginal(raw);
  for(const name of config.weldMaterialNames||[])alias(name);
  for(const name of config.privacy?.terms||[])alias(name);
  return {productNamesMode,alias,protect,restore,learn,save,replaceText:value=>productNamesMode==='original'?value:replaceText(value)};
}
module.exports={createProductPrivacy};
