'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {readSpreadsheetBuffer}=require('./spreadsheet-read.cjs');
const {parsePenetrationWorkbook,PARSER_VERSION}=require('./penetration-parser.cjs');
async function scan({directory,year,previous={}}){
  const output={},failures=[],diagnostics={files:0,read:0,reused:0,failed:0,skipped:0,incompleteGroups:0},sources=[['full','全切熔深新版反馈汇总表'],['bracket','快切支架熔深新版反馈汇总表']];
  let found=0;
  for(const [category,folder] of sources){
    const base=path.join(directory,folder);let months;
    try{months=await fs.readdir(base,{withFileTypes:true});}catch(_){diagnostics.failed++;for(const [key,value] of Object.entries(previous))if(value.category===category)output[key]=value;continue;}
    const seenMonths=new Set();
    const preserveEmptyMonth=month=>{diagnostics.failed++;diagnostics.incompleteGroups++;failures.push({category,month,reason:'month_empty_or_unavailable'});for(const [key,value]of Object.entries(previous))if(value.category===category&&value.month===month&&!output[key])output[key]=value;};
    for(const monthEntry of months){const match=/^(\d{1,2})月$/.exec(monthEntry.name);if(!monthEntry.isDirectory()||monthEntry.isSymbolicLink()||!match||+match[1]<1||+match[1]>12)continue;
      const month=+match[1],monthPath=path.join(base,monthEntry.name);
      seenMonths.add(month);const filesBefore=diagnostics.files,failedBefore=diagnostics.failed;
      async function visit(folderPath,depth){
        let entries;try{entries=await fs.readdir(folderPath,{withFileTypes:true});}catch(_){diagnostics.failed++;const relative=path.relative(base,folderPath);for(const [key,value] of Object.entries(previous))if(value.category===category&&value.month===month&&(!value.relativePath||value.relativePath.startsWith(relative+path.sep))&&!output[key])output[key]=value;return;}
        for(const entry of entries){if(entry.name.startsWith('~$')||entry.isSymbolicLink())continue;const filename=path.join(folderPath,entry.name);
          if(entry.isDirectory()){if(depth<2)await visit(filename,depth+1);else diagnostics.skipped++;continue;}
          if(!entry.isFile()||! /\.(xlsx|xls)$/i.test(entry.name))continue;if(++found>500)throw Error('file_limit');
          const key=crypto.createHash('sha256').update(filename).digest('hex');diagnostics.files++;
          try{const stat=await fs.stat(filename),fingerprint=stat.size+':'+stat.mtimeMs,prior=previous[key];if(prior?.fingerprint===fingerprint&&prior.version===PARSER_VERSION){output[key]=prior;diagnostics.reused++;continue;}
            const buffer=await readSpreadsheetBuffer(filename),data=parsePenetrationWorkbook({buffer,category,year,month});
            if(!data.diagnostics.supportedSheets&&!data.diagnostics.supportingSheets)throw Error('unsupported_sheets');
            output[key]={version:PARSER_VERSION,fingerprint,category,month,relativePath:path.relative(base,filename),records:data.records,diagnostics:data.diagnostics,productNames:data.productNames};diagnostics.read++;
          }catch(error){diagnostics.failed++;failures.push({key,category,month,relativePath:path.relative(base,filename),reason:String(error.message||error.code||'read_failed').slice(0,500)});if(previous[key])output[key]=previous[key];}
          process.send?.({type:'progress',files:diagnostics.files,read:diagnostics.read,failed:diagnostics.failed,key,entry:output[key]});
        }
      }
      await visit(monthPath,0);
      // A suddenly empty previously populated month can be a transient share view.
      // Keep its last snapshot until the source is readable; other months may update.
      if(diagnostics.files===filesBefore&&diagnostics.failed===failedBefore&&Object.values(previous).some(value=>value.category===category&&value.month===month))preserveEmptyMonth(month);
    }
    for(const month of new Set(Object.values(previous).filter(value=>value.category===category&&Number.isInteger(value.month)&&value.month>=1&&value.month<=12).map(value=>value.month)))if(!seenMonths.has(month))preserveEmptyMonth(month);
  }
  if(!diagnostics.files)throw Error('share_empty_or_unavailable');
  return {files:output,diagnostics,failures};
}
if(require.main===module){process.once('message',async input=>{try{const result=await scan(input);process.send({type:'result',result},()=>process.exit(0));}catch(_){process.send({type:'error'},()=>process.exit(1));}});}
module.exports={scan};
