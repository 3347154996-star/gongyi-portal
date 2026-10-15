
'use strict';
const privacy=window.ToolPrivacy;
document.getElementById('namePolicy').textContent=privacy.nameNotice;
const procName=value=>privacy.alias('程序',value);
const dataName=(kind,value)=>privacy.engineering(kind,value);
let FILES=[];
let importGeneration=0;
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
let PROCS=[];          // {name,file,task,segs}
let DECL=null;         // {task:{name:info}}
let LAST=null;
let MAIN=Object.create(null);   // task -> {call:Set, cmt:Set}
let MODES=Object.create(null);  // 焊接模式号 -> 名称（来自 LincolnModes.sys，全局，不限任务）
function parseModes(text){
  // CONST LincWeldModeData weld_Mode_11:=[11,"CV ArMix",...];
  const re=/weld_Mode_(\d+)\s*:=\s*\[\s*(\d+)\s*,\s*"([^"]*)"/g;let m;
  while((m=re.exec(text))){MODES[m[2]]=m[3];}
}
function parseMain(text,task){
  const M=MAIN[task]||(MAIN[task]={call:new Set(),cmt:new Set(),trig:{}});
  let curIf='';
  text.split(/\r?\n/).forEach(l=>{
    const s=l.replace(/\t/g,' ').trim(); if(!s)return;
    const mi=s.match(/^IF\s+([A-Za-z0-9_]+)\s*=\s*1/i); if(mi){curIf=mi[1];return;}
    if(/^ENDIF/i.test(s)){curIf='';return;}
    const com=s.charAt(0)==='!'; const body=com?s.slice(1).trim():s;
    const m=body.match(/^(WL_[A-Za-z0-9_]*)/);
    if(m){ if(com)M.cmt.add(m[1]); else M.call.add(m[1]); M.trig[m[1]]=curIf; }
  });
}
function mainTrig(name,task){const M=MAIN[task];return (M&&M.trig[name])||'';}
function mainStatus(name,task){const M=MAIN[task];if(!M)return'none';
  if(M.call.has(name))return'call'; if(M.cmt.has(name))return'cmt'; return'none';}
const MS_TXT={call:'调用(未备注)',cmt:'注释(!备注)',none:'未引用'};
const SPD_K=2.362203794, CUR_K=2.362204724;
const CODE_PREFIX=/^(Move|Arc|Wait|Set|Reset|Pulse|IF|ELSE|ENDIF|GOTO|VelSet|AccSet|Conf|SingArea|Stop|EnterZone|ExitZone|InitZone|TPWrite|CornerPath|Soft|PathResol|RETURN|WHILE|FOR|ENDFOR|PROC|ENDPROC|Label)/;
function isMove(l){const s=l.trim();if(!s)return true;if(s.charAt(0)==='!')return false;
  return /^(Move[LJCA]|MoveAbsJ|WaitTime|VelSet|AccSet|CornerPath|SoftAct|SoftDeact|Conf[LJ]|SingArea|PathResol|Stop)\b/.test(s);}
function labelBefore(lines,start,lo){let i=start-1;while(i>=lo){const s=lines[i].trim();
  if(s===''||isMove(lines[i])){i--;continue;}
  if(s.charAt(0)==='!'){const b=s.slice(1).trim();if(CODE_PREFIX.test(b)){i--;continue;}return b.replace(/:+$/,'').trim();}
  return null;}return null;}
function arcArgs(line){const m=line.match(/,\s*(?:v\w+|\d+)\s*,\s*(\w+)\s*,\s*(\w+)\s*,/);return m?{seam:m[1],weld:m[2]}:{seam:'',weld:''};}
function parseArr(s){try{return JSON.parse(s.replace(/\s+/g,''));}catch(e){return null;}}

function taskOf(path){const parts=path.split(/[\\/]/);const i=parts.findIndex(p=>/^TASK\d+$/i.test(p));return i>=0?parts[i].toUpperCase():'(root)';}

function parseDecls(text,task,out){
  const re=/TASK PERS\s+(welddata|seamdata)\s+(\w+)\s*:=\s*(\[[\s\S]*?\]);/g;let m;
  while((m=re.exec(text))){const type=m[1],name=m[2],raw=m[3].replace(/\s+/g,' ');
    if(type!=='welddata')continue;
    let info={raw:raw};
    const numeric=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
    const a=parseArr(m[3]);if(a){info.speed=numeric(a[0]);const w=Array.isArray(a[2])?a[2]:null;
      if(w){info.mode=numeric(w[0]);info.volt=numeric(w[2]);info.current=numeric(w[3]);}}
    if(!out[task])out[task]=Object.create(null);out[task][name]=info;
  }
}
function parseMod(text,path){
  const task=taskOf(path);const lines=text.split(/\r?\n/);const procs=[];let cur=null;
  for(let i=0;i<lines.length;i++){
    if(/^\s*(?:LOCAL\s+)?PROC\s+\w+/i.test(lines[i])){const m=lines[i].match(/(?:LOCAL\s+)?PROC\s+(\w+)/i);cur={name:m[1],s:i,e:null};}
    if(/^\s*ENDPROC/i.test(lines[i])&&cur){cur.e=i;procs.push(cur);cur=null;}}
  const out=[];
  for(const p of procs){
    const starts=[];
    for(let i=p.s;i<=p.e;i++){if(/ArcLStart/.test(lines[i])&&lines[i].trim().charAt(0)!=='!')starts.push(i);}
    const segs=[];
    for(let k=0;k<starts.length;k++){const st=starts[k];const nxt=(k+1<starts.length)?starts[k+1]:p.e+1;let end=null;
      for(let j=st+1;j<nxt;j++){if(lines[j].trim().charAt(0)!=='!'&&/(ArcLEnd|ArcCEnd)/.test(lines[j])){end=j;break;}}
      if(end===null)end=nxt-1;let n=0;
      for(let j=st;j<=end;j++){if(lines[j].trim().charAt(0)!=='!'&&/Arc(LStart|LEnd|C|CEnd|L)\b/.test(lines[j]))n++;}
      const lab=labelBefore(lines,st,p.s);const a0=arcArgs(lines[st]);
      segs.push({line:st+1,label:lab||'',n:n,seam:a0.seam,weld:a0.weld});}
    if(segs.length)out.push({name:p.name,file:path,task:task,s:p.s+1,e:p.e+1,segs:segs});}
  return out;
}

// import
async function collect(files){
  const selected=[...files].filter(f=>/\.(mod|sys|txt)$/i.test(f.name));
  if(!selected.length){setImp('未发现 .mod / .sys / .txt 文件，原结果保持不变。');return;}
  if(selected.some(f=>f.size>16*1024*1024)||selected.reduce((sum,f)=>sum+f.size,0)>64*1024*1024){setImp('文件过大：单文件最多 16 MB，合计最多 64 MB。请缩小备份范围。');return;}
  resetImport();const generation=importGeneration;
  setImp('正在读取 '+selected.length+' 个文件…');
  try {
    const contents=[];
    for(const file of selected){contents.push({path:file.webkitRelativePath||file._wp||file.name,text:await file.text()});if(generation!==importGeneration)return;}
    FILES=selected;PROCS=[];DECL=Object.create(null);MAIN=Object.create(null);MODES=Object.create(null);
    for(const file of contents){const task=taskOf(file.path);parseDecls(file.text,task,DECL);if(/MainModule\.mod$/i.test(file.path))parseMain(file.text,task);parseModes(file.text);PROCS.push(...parseMod(file.text,file.path));}
    PROCS.sort((a,b)=>a.task.localeCompare(b.task)||a.file.localeCompare(b.file)||a.s-b.s);
    afterImport(selected.length);
    window.PortalToolBridge?.notify('weld-export',{fileCount:selected.length,rowCount:LAST?.length||0});
  } catch(error){if(generation!==importGeneration)return;resetImport();setImp('导入失败：'+privacy.safeError(error));}
}
async function readFiles(list){try{return await collect(list);}finally{document.getElementById('dirInput').value='';document.getElementById('fileInput').value='';}}
function readFilesRaw(files){return collect(files);}
function resetImport(){
  importGeneration++;FILES=[];PROCS=[];DECL=Object.create(null);LAST=[];MAIN=Object.create(null);MODES=Object.create(null);showAll=false;
  for(const id of ['weldCalls','weldFilters','weldResults','jumpToResults'])document.getElementById(id).hidden=true;
  document.getElementById('dirInput').value='';document.getElementById('fileInput').value='';document.getElementById('kw').value='';document.getElementById('showAll').checked=false;document.getElementById('onlyMiss').checked=false;
  document.getElementById('taskSel').innerHTML='<option value="">全部</option>';
  for(const id of ['taskInfo','proclist','resStats','resTable','expMsg'])document.getElementById(id).textContent='';
  document.getElementById('callOverview').innerHTML='<div class="empty">导入后显示主程序调用。</div>';document.getElementById('autoHint').textContent='导入后自动检索正在使用的焊接程序。';setImp('尚未导入');applyFilter();
}
function afterImport(nf){
  setImp('已导入 '+nf+' 个文件，'+PROCS.length+' 个焊接过程');
  for(const id of ['weldCalls','weldFilters','weldResults','jumpToResults'])document.getElementById(id).hidden=!PROCS.length;
  const tasks=[...new Set(PROCS.map(p=>p.task))].sort();
  const nmode=Object.keys(MODES).length;
  document.getElementById('taskInfo').innerHTML=(nmode?('<span class="hint">已读取焊接模式定义 '+nmode+' 条（LincolnModes）；</span> '):'')+'焊接过程：'+tasks.map(t=>{
    const ps=PROCS.filter(p=>p.task===t);
    const nCall=ps.filter(p=>mainStatus(p.name,p.task)==='call').length;
    const wd=Object.keys(DECL[t]||{}).length;
    return '<b>'+t+'</b>('+ps.length+'个程序, 启用'+nCall+'/'+wd+'条welddata)';}).join('　')+'　<span class="hint">（变位机等无焊接任务已忽略）</span>';
  const sel=document.getElementById('taskSel');sel.innerHTML='<option value="">全部</option>'+tasks.map(t=>'<option>'+t+'</option>').join('');
  renderProcList();renderCallOverview();applyFilter();
}
function setImp(t){document.getElementById('impMsg').textContent=t;}
function curTask(){return document.getElementById('taskSel').value;}
function renderProcList(){
  const el=document.getElementById('proclist');
  const t=curTask();const list=PROCS.filter(p=>(!t||p.task===t)&&(showAll||mainStatus(p.name,p.task)==='call'));
  if(!list.length){el.innerHTML='<div class="hint">未解析到正在使用的焊接程序</div>';return;}
  el.innerHTML='<div class="hint" style="margin-bottom:4px;">焊接过程（点卡片按该程序名筛选）：</div>'+
   list.map(p=>{const i=PROCS.indexOf(p);const c=(p.task==='TASK2'?'t2':'');return '<button type="button" class="tag '+c+'" data-proc-index="'+i+'">['+esc(p.task)+'] '+esc(procName(p.name))+' <span style="opacity:.6">('+p.segs.length+'段)</span></button>';}).join('');
}
document.getElementById('kw').addEventListener('input',applyFilter);
document.getElementById('onlyMiss').addEventListener('change',applyFilter);
function pick(i){const p=PROCS[i];pickByName(p.task,p.name);}

let showAll=false;
function callBranches(){
  // 返回 [{task, sig, name, status, segs}]
  const out=[];
  Object.keys(MAIN).sort().forEach(task=>{
    const M=MAIN[task]; const names=new Set([...M.call,...M.cmt]);
    names.forEach(nm=>{
      const p=PROCS.find(p=>p.task===task&&p.name===nm);
      if(!p) return;   // 只列本任务内真实存在的焊接过程，排除变位机等
      out.push({task:task, sig:(M.trig[nm]||''), name:nm, status:mainStatus(nm,task), segs:p.segs.length});
    });
  });
  return out;
}
function renderCallOverview(){
  const el=document.getElementById('callOverview');
  const rows=callBranches();
  if(!rows.length){el.innerHTML='<div class="empty">未解析到主程序焊接调用</div>';return;}
  const tasks=[...new Set(rows.map(r=>r.task))].sort();
  let h='';
  tasks.forEach(t=>{
    h+='<div style="margin:4px 0 10px;"><div style="font-weight:700;color:#1F3864;margin-bottom:4px;">'+t+'</div>';
    h+='<table style="width:auto;min-width:480px;box-shadow:none;"><thead><tr><th>触发信号</th><th>焊接程序</th><th>状态</th><th>段数</th><th>操作</th></tr></thead><tbody>';
    rows.filter(r=>r.task===t).sort((a,b)=>a.sig.localeCompare(b.sig)).forEach(r=>{
      const msTxt=MS_TXT[r.status];const cls=(r.status==='call'?'msC':(r.status==='cmt'?'msM':'msN'));
      h+='<tr><td class="mono">'+(esc(privacy.alias('信号',r.sig))||'—')+'</td><td class="l procname">'+esc(procName(r.name))+'</td>'+
         '<td><span class="'+cls+'">'+msTxt+'</span></td><td>'+r.segs+'</td>'+
         '<td><button class="sec" style="padding:3px 10px;font-size:12px;" data-call-index="'+PROCS.findIndex(p=>p.task===r.task&&p.name===r.name)+'">调出参数 →</button></td></tr>';
    });
    h+='</tbody></table></div>';
  });
  el.innerHTML=h;
}
function pickByName(task,name){
  document.getElementById('taskSel').value=task;
  showAll=true; document.getElementById('showAll').checked=true;
  document.getElementById('kw').value=procName(name);
  renderProcList();applyFilter();
  document.getElementById('resTable').scrollIntoView({behavior:'smooth',block:'start'});
}
function computeRows(){
  const t=curTask();const rows=[];
  PROCS.forEach(p=>{ if(t&&p.task!==t)return;
    if(!showAll && mainStatus(p.name,p.task)!=='call')return;   // 只检索正在使用的程序
    const wmap=DECL[p.task]||{};
    const ms=mainStatus(p.name,p.task); const trg=(ms==='none')?'':mainTrig(p.name,p.task);
    p.segs.forEach(s=>rows.push({task:p.task,proc:p.name,segline:s.line,label:s.label,weld:s.weld,seam:s.seam,ms:ms,trig:trg,wd:wmap[s.weld]||null}));
  });
  return rows;
}
function updHideLabel(){}
function applyFilter(){
  showAll=document.getElementById('showAll')?document.getElementById('showAll').checked:false;
  if(!PROCS.length){LAST=[];document.getElementById('resStats').textContent='';document.getElementById('resHead').innerHTML='<div class="empty">请先导入备份文件夹（第1步）</div>';document.getElementById('resTable').innerHTML='';document.getElementById('resBar').style.display='none';return;}
  renderProcList();
  let rows=computeRows();
  const kw=document.getElementById('kw').value.trim().toLowerCase();
  if(kw) rows=rows.filter(r=>[procName(r.proc),dataName('焊接数据',r.weld),dataName('标签',r.label),dataName('焊缝数据',r.seam)].some(x=>String(x).toLowerCase().includes(kw)));
  showAll=document.getElementById('showAll').checked;
  if(document.getElementById('onlyMiss').checked) rows=rows.filter(r=>!r.wd);
  const t=curTask();
  document.getElementById('autoHint').textContent=(t?('任务 '+t+'：'):'全部任务：')+(kw?'已按关键词筛选 ':'')+'已列出 '+rows.length+' 个焊接段'+(!rows.length&&!showAll?'。请确认已导入 MainModule.mod，或勾选“显示全部”查看未启用/未引用程序。':'');
  render(rows);
}
function render(rows){
  LAST=rows;
  const procs=[...new Set(rows.map(r=>r.task+'/'+r.proc))];
  const wdOk=rows.filter(r=>r.wd).length;
  document.getElementById('resHead').innerHTML='<div>共 <b>'+procs.length+'</b> 个焊接过程、'+rows.length+' 个焊接段</div>';
  document.getElementById('resStats').innerHTML=`<div class="stat">过程数 <b>${procs.length}</b></div><div class="stat">焊接段 <b>${rows.length}</b></div><div class="stat">取到 welddata <b>${wdOk}</b></div><div class="stat">未取到 <b style="color:#b00020">${rows.length-wdOk}</b></div>`;
  let h='<div class="tblwrap"><table><thead><tr>'+
    '<th rowspan="2">序号</th><th rowspan="2">任务</th><th rowspan="2">过程</th><th rowspan="2">主程序</th><th rowspan="2">触发信号</th><th rowspan="2">行号</th><th rowspan="2">!标签</th>'+
    '<th rowspan="2">焊接数据名</th><th rowspan="2">seamdata</th>'+
    '<th class="grp" colspan="5">焊接参数（由 welddata 换算）</th><th rowspan="2">welddata 数值声明</th></tr>'+
    '<tr><th>速度(mm/s)</th><th>速度(IPM)</th><th>焊接模式</th><th>电压(V)</th><th>电流(A)</th></tr></thead><tbody>';
  rows.forEach((r,i)=>{
    const d=r.wd,sp=(d&&d.speed!=null)?d.speed:null;
    const msTxt=MS_TXT[r.ms]||''; const msCls=(r.ms==='call'?'msC':(r.ms==='cmt'?'msM':'msN'));
    h+='<tr><td>'+(i+1)+'</td><td class="mono">'+r.task+'</td><td class="l procname">'+esc(procName(r.proc))+'</td><td><span class="'+msCls+'">'+msTxt+'</span></td><td class="mono">'+(esc(privacy.alias('信号',r.trig))||'—')+'</td><td>'+r.segline+'</td>'+
       '<td class="mono">'+vz(dataName('标签',r.label))+'</td><td>'+vz(dataName('焊接数据',r.weld))+'</td><td>'+vz(dataName('焊缝数据',r.seam))+'</td>'+
       '<td>'+(sp!=null?rnd(sp,4):'—')+'</td>'+
       '<td><b>'+(sp!=null?rnd(sp*SPD_K,2):'—')+'</b></td>'+
       '<td>'+(d&&d.mode!=null?('<span class="pill">'+d.mode+(MODES[d.mode]?(' '+esc(privacy.mode(MODES[d.mode]))):'')+'</span>'):'—')+'</td>'+
       '<td>'+(d&&d.volt!=null?vz(d.volt):'—')+'</td>'+
       '<td><b>'+(d&&d.current!=null?rnd(d.current*CUR_K,2):'—')+'</b></td>'+
       '<td class="raw">'+(d?esc(privacy.rawWeld(d.raw)):'<span class="waitc">未在同一任务内找到该 welddata 声明</span>')+'</td></tr>';
  });
  if(!rows.length) h+='<tr><td colspan="14" class="empty">无匹配</td></tr>';
  h+='</tbody></table></div>';
  document.getElementById('resTable').innerHTML=h;
  document.getElementById('resBar').style.display=rows.length?'flex':'none';
  updHideLabel();
}

function rnd(v,n){const p=Math.pow(10,n);return Math.round(v*p)/p;}
function vz(v){return (v===''||v==null)?'—':esc(v);}
function buildResult(matched){
  const rows=[];
  matched.forEach(p=>{
    const wmap=(DECL[p.task]||{});
    p.segs.forEach((s,idx)=>{
      const d=wmap[s.weld]||null;
      rows.push({task:p.task,proc:p.name,segline:s.line,idx:idx+1,label:s.label,weld:s.weld,seam:s.seam,wd:d});
    });
  });
  LAST=rows;
  const totSeg=rows.length, wdOk=rows.filter(r=>r.wd).length;
  document.getElementById('resHead').innerHTML='<div>匹配到 '+matched.length+' 个过程：'+
    matched.map(p=>'<span class="procname">['+p.task+'] '+esc(procName(p.name))+'</span> <span class="hint">('+p.segs.length+'段)</span>').join('、')+'</div>';
  document.getElementById('resStats').innerHTML=`<div class="stat">过程数 <b>${matched.length}</b></div><div class="stat">焊接段 <b>${totSeg}</b></div><div class="stat">取到 welddata <b>${wdOk}</b></div><div class="stat">未取到 <b style="color:#b00020">${totSeg-wdOk}</b></div>`;
  let h='<div class="tblwrap"><table><thead><tr>'+
    '<th rowspan="2">序号</th><th rowspan="2">任务</th><th rowspan="2">过程</th><th rowspan="2">主程序</th><th rowspan="2">触发信号</th><th rowspan="2">行号</th><th rowspan="2">!标签</th>'+
    '<th rowspan="2">焊接数据名</th><th rowspan="2">seamdata</th>'+
    '<th class="grp" colspan="5">焊接参数（由 welddata 换算）</th><th rowspan="2">welddata 数值声明</th></tr>'+
    '<tr><th>速度(mm/s)</th><th>速度(IPM)</th><th>焊接模式</th><th>电压(V)</th><th>电流(A)</th></tr></thead><tbody>';
  rows.forEach((r,i)=>{
    const d=r.wd,sp=(d&&d.speed!=null)?d.speed:null;
    const msTxt=MS_TXT[r.ms]||''; const msCls=(r.ms==='call'?'msC':(r.ms==='cmt'?'msM':'msN'));
    h+='<tr><td>'+(i+1)+'</td><td class="mono">'+r.task+'</td><td class="l procname">'+esc(procName(r.proc))+'</td><td><span class="'+msCls+'">'+msTxt+'</span></td><td class="mono">'+(esc(privacy.alias('信号',r.trig))||'—')+'</td><td>'+r.segline+'</td>'+
       '<td class="mono">'+vz(dataName('标签',r.label))+'</td><td>'+vz(dataName('焊接数据',r.weld))+'</td><td>'+vz(dataName('焊缝数据',r.seam))+'</td>'+
       '<td>'+(sp!=null?rnd(sp,4):'—')+'</td>'+
       '<td><b>'+(sp!=null?rnd(sp*SPD_K,2):'—')+'</b></td>'+
       '<td>'+(d&&d.mode!=null?('<span class="pill">'+d.mode+(MODES[d.mode]?(' '+esc(privacy.mode(MODES[d.mode]))):'')+'</span>'):'—')+'</td>'+
       '<td>'+(d&&d.volt!=null?vz(d.volt):'—')+'</td>'+
       '<td><b>'+(d&&d.current!=null?rnd(d.current*CUR_K,2):'—')+'</b></td>'+
       '<td class="raw">'+(d?esc(privacy.rawWeld(d.raw)):'<span class="waitc">未在同一任务内找到该 welddata 声明</span>')+'</td></tr>';
  });
  h+='</tbody></table></div>';
  document.getElementById('resTable').innerHTML=h;
  document.getElementById('resBar').style.display='flex';
}

// export
const HEAD=['序号','任务','过程','主程序','触发信号','行号','焊点标签','焊接数据名','seamdata','速度(mm/s)','速度(IPM)','焊接模式','电压(V)','电流(A)','welddata声明'];
function exportRowsArr(list){return list.map((r,i)=>{const d=r.wd,sp=(d&&d.speed!=null)?d.speed:null;
  return [i+1,r.task,procName(r.proc),(MS_TXT[r.ms]||''),privacy.alias('信号',r.trig),r.segline,dataName('标签',r.label),dataName('焊接数据',r.weld),dataName('焊缝数据',r.seam),sp!=null?rnd(sp,4):'',sp!=null?rnd(sp*SPD_K,2):'',(d&&d.mode!=null)?(d.mode+(MODES[d.mode]?(' '+privacy.mode(MODES[d.mode])):'')):'',(d&&d.volt!=null)?d.volt:'',(d&&d.current!=null)?rnd(d.current*CUR_K,2):'',d?privacy.rawWeld(d.raw):''];});}
function safeCell(v){return typeof v==='string'&&/^[\s]*[=+@-]/.test(v)?"'"+v:v;}
function csvCell(v){v=String(safeCell(v)??'');return /[",\n\r\t]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v;}
function exportRows(){ return LAST||[]; }
function exportCSV(){ const R=exportRows(); if(!R.length){alert('没有可导出的数据（已设为仅导出启用程序，可取消勾选导出全部）');return;}
  const lines=[HEAD.map(csvCell).join(',')].concat(exportRowsArr(R).map(r=>r.map(csvCell).join(',')));
  const csv='﻿'+lines.join('\r\n');
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});
  const t=curTask();let name='焊接参数'+(t?('_'+t):'')+'_当前视图.csv';
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1500);
  document.getElementById('expMsg').textContent='已导出：'+name;}
async function exportExcel(){
  const R=exportRows(); if(!R.length){alert('没有可导出的数据');return;}
  if(typeof XLSX==='undefined'){alert('本地 Excel 组件未加载，请刷新后重试，或使用 CSV 导出。');return;}
  const t=curTask();
  const meta=[
    ['焊接程序参数导出'],
    ['生成时间', new Date().toLocaleString('zh-CN')],
    ['数据来源','ABB 机器人备份（导入文件夹解析）'],
    ['任务范围', t||'全部'],
    ['检索范围', showAll?'全部焊接过程':'仅正在使用的焊接程序（主程序启用）'],
    ['焊接过程数', [...new Set(R.map(r=>r.task+'/'+r.proc))].length],
    ['焊接段数', R.length],
    [],
    ['解析规则','welddata: [速度,0,[焊接模式,?,电压,电流,…],…]'],
    ['','速度(IPM) = [0] × 2.362203794'],
    ['','电压(V) = [2][2]（直接用）'],
    ['','电流(A) = [2][3] × 2.362204724'],
    ['主程序状态','调用=主程序未备注启用；注释=主程序 !备注；未引用=主程序未出现'],
    ['触发信号','主程序中该程序调用所处的 IF 条件（如 DI08_A_HJQD）'],
    ['备注','打点/点固等无 !焊缝号 标签的段显示为“未标注”']
  ];
  const ws1=XLSX.utils.aoa_to_sheet(meta); ws1['!cols']=[{wch:12},{wch:64}];
  const ws2=XLSX.utils.aoa_to_sheet([HEAD].concat(exportRowsArr(R)));
  ws2['!cols']=[{wch:5},{wch:8},{wch:22},{wch:14},{wch:14},{wch:7},{wch:12},{wch:10},{wch:9},{wch:9},{wch:7},{wch:8},{wch:9},{wch:9},{wch:46}];
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws1,'说明与汇总');
  XLSX.utils.book_append_sheet(wb,ws2,'焊接参数');
  const base=(t?('焊接参数_'+t):'焊接参数_全部')+'_'+new Date().toISOString().slice(0,10);
  const button=document.getElementById('exportExcel');button.disabled=true;document.getElementById('expMsg').textContent='正在生成 Excel…';
  try{await XLSX.writeFile(wb, base+'.xlsx');document.getElementById('expMsg').textContent='已导出 Excel：'+base+'.xlsx';}catch(error){document.getElementById('expMsg').textContent='导出失败：'+privacy.safeError(error);}finally{button.disabled=false;}
}
function copyTSV(){ const R=exportRows(); if(!R.length){alert('没有可复制的数据（已设为仅导出启用程序）');return;}
  const tsv=[HEAD.join('\t')].concat(exportRowsArr(R).map(r=>r.map(v=>String(safeCell(v)??'').replace(/[\t\r\n]/g,' ')).join('\t'))).join('\n');
  if(!navigator.clipboard?.writeText){document.getElementById('expMsg').textContent='当前浏览器不支持剪贴板，请导出 CSV。';return;}
  navigator.clipboard.writeText(tsv).then(()=>document.getElementById('expMsg').textContent='已复制到剪贴板',
    ()=>document.getElementById('expMsg').textContent='复制失败，请用导出CSV');}

// dropbox
const db=document.getElementById('dropbox');
db.addEventListener('click',event=>{if(event.target.tagName!=='INPUT')document.getElementById('dirInput').click();});
db.addEventListener('keydown',event=>{if(event.target===db&&(event.key==='Enter'||event.key===' ')){event.preventDefault();document.getElementById('dirInput').click();}});
document.getElementById('dirInput').onchange=e=>readFiles(e.target.files);
document.getElementById('fileInput').onchange=e=>readFiles(e.target.files);
['dragenter','dragover'].forEach(ev=>db.addEventListener(ev,e=>{e.preventDefault();db.classList.add('drag');}));
['dragleave','drop'].forEach(ev=>db.addEventListener(ev,e=>{e.preventDefault();db.classList.remove('drag');}));
db.addEventListener('drop',async e=>{const items=[...e.dataTransfer.items||[]];const files=[];
  try{for(const it of items){const ent=it.webkitGetAsEntry&&it.webkitGetAsEntry();if(ent)await walk(ent,files,ent.name);}
  if(files.length)await readFilesRaw(files);else await readFiles(e.dataTransfer.files);}
  catch(error){setImp('无法读取拖入的文件夹，请改用选择文件按钮。');}});
async function walk(entry,out,path){
  if(entry.isFile){const f=await new Promise((resolve,reject)=>entry.file(resolve,reject));f._wp=path;out.push(f);}
  else if(entry.isDirectory){const reader=entry.createReader();for(;;){const entries=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));if(!entries.length)break;for(const item of entries)await walk(item,out,path+'/'+item.name);}}
}
for(const [id,handler] of [['selectFiles',()=>document.getElementById('fileInput').click()],['resetImport',resetImport],['jumpToResults',()=>{const target=document.getElementById('weldResults');target.scrollIntoView({behavior:'smooth',block:'start'});target.focus({preventScroll:true});}],['exportExcel',exportExcel],['exportCSV',exportCSV],['copyTSV',copyTSV]])document.getElementById(id).addEventListener('click',handler);
for(const id of ['taskSel','showAll'])document.getElementById(id).addEventListener('change',applyFilter);
document.getElementById('proclist').addEventListener('click',event=>{const target=event.target.closest('[data-proc-index]');if(target)pick(Number(target.dataset.procIndex));});
document.getElementById('callOverview').addEventListener('click',event=>{const target=event.target.closest('[data-call-index]');if(target)pick(Number(target.dataset.callIndex));});
window.WeldExportTool=Object.freeze({version:'1.0.0',importFiles:readFiles,reset:resetImport,getResult:()=>({version:'1.0.0',headers:HEAD,rows:exportRowsArr(LAST||[]),rowCount:LAST?.length||0})});
window.PortalToolBridge?.register('weld-export',window.WeldExportTool);
