(()=>{
'use strict';
const $=id=>document.getElementById(id);
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const signed=(v,d=3)=>finite(v)?(v>=0?'+':'')+v.toFixed(d):'—';
const offlineNotice=extra=>`<aside class="offline-notice ${extra||''}" aria-label="离线使用声明"><strong>离线使用声明</strong><span>导入文件仅在本机浏览器内解析与计算，本工具不上传数据，无需联网即可使用。</span></aside>`;
const state={vision:null,cmm:null,data:null,threshold:.2,mode:'point',busy:false,generation:0,saved:false};
let importQueue=Promise.resolve();
const E=window.MeasureCompareEngine;
const privacy=window.ToolPrivacy;
function setStatus(message,kind=''){ $('status').textContent=message;$('status').className='message'+(kind?' '+kind:''); }
function showResults(show){$('result').hidden=!show;$('empty-state').hidden=show;}
function hideOldResult(){state.data=null;showResults(false);$('download').disabled=true;}
function sheetNames(info,type){const values=info[type+'Sheets']||[];return values.map(s=>typeof s==='string'?s:s.name||s.sheetName).filter(Boolean);}
function preferred(names){return names.find(s=>s.trim()==='11')||names.find(s=>s.toUpperCase()==='SUMMARY')||names[0];}
function renderSlot(type){const v=state[type];$(type+'-name').textContent=v?privacy.alias('文件',v.name):'尚未导入';$(type+'-drop').classList.toggle('ready',!!v);$(type+'-sheet-row').hidden=!v;if(v){$(type+'-sheet').innerHTML=v.sheets.map((s,i)=>`<option value="${i}">${esc(privacy.alias('工作表',s))}</option>`).join('');$(type+'-sheet').value=String(v.sheets.indexOf(v.sheet));}}
function reset(){state.generation++;state.vision=null;state.cmm=null;state.data=null;state.saved=false;state.busy=false;state.mode='point';$('vision-file').value='';$('cmm-file').value='';$('point-search').value='';$('threshold').value='0.2';state.threshold=.2;$('only-exceed').checked=false;$('saved-banner').hidden=true;$('new-import').hidden=true;$('import-card').hidden=false;renderSlot('vision');renderSlot('cmm');showResults(false);setStatus('请导入现场检具报告和三坐标报告。');}
function describeError(error){return privacy.safeError(error);}
function importFiles(fileList,hint){const files=Array.from(fileList||[]),epoch=state.generation;importQueue=importQueue.then(()=>epoch===state.generation?doImportFiles(files,hint):undefined);return importQueue;}
async function doImportFiles(fileList,hint){
 const files=Array.from(fileList||[]);if(!files.length)return;
 if(files.length>2){setStatus('每次请导入一份现场报告和一份三坐标报告，最多两个文件。','error');return;}
 const generation=state.generation;
 if(state.saved){state.vision=null;state.cmm=null;state.saved=false;renderSlot('vision');renderSlot('cmm');$('saved-banner').hidden=true;$('new-import').hidden=true;}
 hideOldResult();state.busy=true;setStatus('正在读取文件，请稍候…');
 await new Promise(r=>setTimeout(r,20));
 const staged=[];
 try{
   for(const file of files){
     if(!/\.(xlsx|xlsm)$/i.test(file.name))throw new Error('请使用 .xlsx 或 .xlsm 文件；其他格式请先另存为 .xlsx。');
     if(file.size>64*1024*1024)throw new Error('文件超过 64 MB，请导出所需日期范围后再导入。');
     const wb=await E.readWorkbook(await file.arrayBuffer(),file.name);if(generation!==state.generation)return;
     const info=E.inspectWorkbook(wb),vs=sheetNames(info,'vision'),cs=sheetNames(info,'cmm');
     let type;if(vs.length&&!cs.length)type='vision';else if(cs.length&&!vs.length)type='cmm';else if(hint&&sheetNames(info,hint).length)type=hint;else if(vs.length&&cs.length)throw new Error('文件同时包含两种报表，请分别放入对应的导入框。');else throw new Error('未识别为当前现场检具或三坐标模板，请检查表头与工作表。');
     if(staged.some(v=>v.type===type))throw new Error('这两个文件都识别为'+(type==='vision'?'现场检具':'三坐标')+'报告，请各导入一份。');
     const sheets=sheetNames(info,type);staged.push({type,wb,name:file.name,sheets,sheet:preferred(sheets)});
   }
   if(generation!==state.generation)return;
   for(const v of staged){state[v.type]=v;renderSlot(v.type);}
   state.busy=false;runComparison();
 }catch(error){if(generation!==state.generation)return;state.busy=false;if(hint){state[hint]=null;renderSlot(hint);}else{state.vision=null;state.cmm=null;renderSlot('vision');renderSlot('cmm');}setStatus('未能导入：'+describeError(error),'error');}
}
function normalize(raw){
 const pairs=(raw.pairs||[]).map((p,i)=>({...p,pair_id:p.pair_id||p.id||String(i),short_sn:p.short_sn||String(p.sn||'').slice(-9)}));
 const findMeta=p=>pairs.find(x=>x.pair_id===p.pair_id)||pairs.find(x=>x.sn===p.sn&&x.vision_time===p.vision_time);
 const items=(raw.items||[]).map(m=>({...m,key:m.key||m.point+'_'+m.axis,pairs:(m.pairs||[]).filter(p=>finite(p.vision)&&finite(p.cmm)&&finite(p.diff)).map(p=>({...findMeta(p),...p,pair_id:p.pair_id||findMeta(p)?.pair_id,short_sn:p.short_sn||String(p.sn||'').slice(-9)}))})).filter(m=>m.pairs.length);
 if(!pairs.length){const found=new Map();for(const m of items)for(const p of m.pairs)found.set(p.pair_id||p.sn+'|'+p.vision_time,p);pairs.push(...found.values());}
 return privacy.compareResult({...raw,items,pairs,source_names:{vision:state.vision?.name||raw.source_names?.vision||'',cmm:state.cmm?.name||raw.source_names?.cmm||''},source_sheets:{vision:state.vision?.sheet||raw.source_sheets?.vision||'',cmm:state.cmm?.sheet||raw.source_sheets?.cmm||''}});
}
function runComparison(){
 hideOldResult();if(!state.vision||!state.cmm){setStatus('已导入'+(state.vision?'现场检具':'三坐标')+'报告，请再导入'+(state.vision?'三坐标':'现场检具')+'报告。');return;}
 try{const raw=E.compare(state.vision.wb,state.vision.sheet,state.cmm.wb,state.cmm.sheet);state.data=normalize(raw);renderAll();window.PortalToolBridge?.notify('measurement-compare',{fileCount:2,pairCount:state.data.pairs.length,itemCount:state.data.items.length});const d=state.data;if(!d.items.length){setStatus('已读取两份报告，但没有可以比较的数据。请查看匹配情况。','error');}else setStatus('比对完成：匹配'+new Set(d.pairs.map(p=>p.sn)).size+'个工件编号，'+d.items.length+'个点位方向。','success');}
 catch(error){setStatus('无法完成比对：'+describeError(error),'error');}
}
function pointLabel(m){return m.point+'点 '+m.axis;}
function sampleLabel(p){return (p.vision_time||p.cmm_date||'日期未记录')+'　'+(p.short_sn||p.sn)+(p.repeat_count>1?'　第'+p.repeat_index+'次':'');}
function stats(m){const a=m.pairs.map(p=>p.diff),min=Math.min(...a),max=Math.max(...a);return {n:a.length,min,max,mean:a.reduce((x,y)=>x+y,0)/a.length,maxAbs:Math.max(...a.map(Math.abs)),spread:max-min,count:a.filter(exceed).length};}
function exceed(v){return finite(v)&&Math.abs(v)>state.threshold+1e-12;}
function mode(name){state.mode=name;$('point-view').hidden=name!=='point';$('sample-view').hidden=name!=='sample';$('tab-point').setAttribute('aria-selected',String(name==='point'));$('tab-sample').setAttribute('aria-selected',String(name==='sample'));if(name==='sample')renderSample();}
function diagnosticText(value){if(typeof value==='string'||typeof value==='number')return String(value);if(!value)return '';if(value.message)return value.message;if(value.sn)return value.sn+(value.count?'（'+value.count+'次记录）':'')+(value.reason?'：'+value.reason:'');if(value.key)return value.key+(value.reason?'：'+value.reason:finite(value.offset)?'：现场理论值 '+value.vision_nominal+'，三坐标理论值 '+value.cmm_nominal+'，已计入 '+signed(value.offset):value.label?'：'+value.label:'');if(value.label)return value.label+(value.reason?'：'+value.reason:'');if(value.value)return value.value+(value.sheet?'（'+value.sheet+'）':'');if(value.sheet)return value.sheet+'，'+(value.cell||value.col||'');return '该记录无法纳入当前对比。';}
function renderDiagnostics(){const d=state.data,di=d.diagnostics||{};
 const labels={unmatched_cmm:'三坐标有记录、现场未找到',unmatched_vision:'现场有记录、三坐标未找到',ambiguous_cmm_sns:'三坐标同一工件存在不同记录，未自动配对',repeated_vision:'现场同一编号的复测',missing_values:'缺少数值的项目',missing_value_count:'缺失或无效数值的总组数',excluded_items:'未纳入坐标对比的项目',messages:'说明',warnings:'说明',nominal_adjustments:'已计入理论值差的点位',cmm_rows_without_nominal:'三坐标未填写理论值的坐标行',unsafe_numeric_sns:'编号以超长数字存储，无法保证准确，未匹配',empty_sn_columns:'未填写编号的数据列',duplicate_vision_records:'现场已合并的重复导出记录',duplicate_cmm_records:'三坐标已合并的重复导出记录'};
 let html=`<p><b>现场：</b>${esc(d.source_names.vision)}　${esc(d.source_sheets.vision)}<br><b>三坐标：</b>${esc(d.source_names.cmm)}　${esc(d.source_sheets.cmm)}</p>`;
 let issues=0;for(const [key,value] of Object.entries(di)){if(key==='warnings'||value==null||value===0||(Array.isArray(value)&&!value.length))continue;const name=labels[key]||'数据说明';if(Array.isArray(value)){issues+=value.length;html+=`<p><b>${esc(name)}（${value.length}）</b></p><ul>${value.slice(0,80).map(v=>'<li>'+esc(diagnosticText(v))+'</li>').join('')}</ul>`;if(value.length>80)html+='<p>以上显示前80条。</p>';}else if(typeof value!=='object'){html+=`<p>${esc(name)}：${esc(value)}</p>`;}}
 $('matching-body').innerHTML=html;$('matching-summary').textContent='查看匹配情况、未配对编号与数据说明';$('matching').open=!d.items.length;
}
function renderAll(){const d=state.data;showResults(true);$('download').disabled=!d.items.length;$('counts').textContent=`现场 ${d.vision_count??'—'} 条记录 · 三坐标 ${d.cmm_count??'—'} 条记录 · 匹配 ${new Set(d.pairs.map(p=>p.sn)).size} 件 / ${d.pairs.length} 次 · 可比较 ${d.items.length} 个方向`;
 renderDiagnostics();$('point-search').value='';const sorted=[...d.items].sort((a,b)=>Number(a.point)-Number(b.point)||a.axis.localeCompare(b.axis));$('point-select').innerHTML=sorted.map(m=>`<option value="${esc(m.key)}">${esc(pointLabel(m))}</option>`).join('');const worst=[...d.items].sort((a,b)=>stats(b).maxAbs-stats(a).maxAbs)[0];if(worst)$('point-select').value=worst.key;
 $('sample-select').innerHTML=d.pairs.map(p=>`<option value="${esc(p.pair_id)}">${esc(sampleLabel(p))}</option>`).join('');mode('point');renderPoint();}
function chart(m){
 const rows=m.pairs,n=rows.length,W=Math.max(1100,220+n*84),H=650,L=70,R=W-195,X=i=>n===1?(L+R)/2:L+36+i*(R-L-72)/(n-1),top={y:120,h:205},bottom={y:416,h:168};
 let sourceMax=0,diffMax=0;for(const item of state.data.items)for(const p of item.pairs){sourceMax=Math.max(sourceMax,Math.abs(p.vision),Math.abs(p.cmm));diffMax=Math.max(diffMax,Math.abs(p.diff));}
 const cap=Math.max(.4,Math.ceil((sourceMax+.12)/.2)*.2),dc=Math.max(.4,Math.ceil((diffMax+.08)/.2)*.2,state.threshold*1.25);
 const yTop=v=>top.y+top.h/2-v*top.h/(2*cap),yDiff=v=>bottom.y+bottom.h/2-v*bottom.h/(2*dc);
 const svg=[`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="width:100%;min-width:${n<=16?940:W}px;height:auto" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(pointLabel(m))}现场值与三坐标值、逐件差值"><rect width="100%" height="100%" fill="#fbfdff"/><rect x="${L-6}" y="${top.y-9}" width="${R-L+12}" height="${top.h+18}" rx="6" fill="white"/><rect x="${L-6}" y="${bottom.y-9}" width="${R-L+12}" height="${bottom.h+18}" rx="6" fill="white"/>`];
 const text=(x,y,s,opt='')=>`<text x="${x}" y="${y}" ${opt}>${esc(s)}</text>`;
 svg.push(text(L,31,'现场值与三坐标值','fill="#1d2b43" font-size="16" font-weight="700"'),text(L,58,'每一列对应同一件；两条曲线取自原表。','fill="#64748b" font-size="12"'));
 svg.push(`<line x1="${R-222}" x2="${R-194}" y1="85" y2="85" stroke="#2456a6" stroke-width="2"/><circle cx="${R-208}" cy="85" r="4" fill="#2456a6"/>`,text(R-187,89,'现场值','font-size="12" fill="#2456a6"'),`<line x1="${R-103}" x2="${R-75}" y1="85" y2="85" stroke="#c77424" stroke-width="2" stroke-dasharray="5 3"/>`,text(R-67,89,'三坐标值','font-size="12" fill="#aa5e18"'));
 for(const [box,limit,y] of [[top,cap,yTop],[bottom,dc,yDiff]]){for(let t=-2;t<=2;t++){const v=t*limit/2,yy=y(v);svg.push(`<line x1="${L}" x2="${R}" y1="${yy}" y2="${yy}" stroke="${t===0?'#8d9daa':'#e5edf3'}" stroke-width="${t===0?1.5:1}"/>`,text(L-12,yy+4,t===0?'0':signed(v,2),'text-anchor="end" font-size="11" fill="#63798d"'));}svg.push(text(16,box.y+box.h/2,'mm','font-size="11" fill="#63798d"'));}
 for(let i=0;i<n;i++){const p=rows[i];if(n<=80)svg.push(`<line x1="${X(i)}" x2="${X(i)}" y1="${top.y}" y2="${bottom.y+bottom.h}" stroke="#f4f7fa" stroke-dasharray="2 5"/>`);}
 const poly=(field,y,color,dash='')=>`<polyline points="${rows.map((p,i)=>`${X(i)},${y(p[field])}`).join(' ')}" fill="none" stroke="${color}" stroke-width="1.7" ${dash?'stroke-dasharray="'+dash+'"':''}/>`;
 svg.push(poly('vision',yTop,'#2456a6'),poly('cmm',yTop,'#c77424','5 3'));
 rows.forEach((p,i)=>{const x=X(i),vt=yTop(p.vision),ct=yTop(p.cmm),va=p.vision>=p.cmm;svg.push(`<circle cx="${x}" cy="${vt}" r="4" fill="#2456a6" stroke="white"><title>${esc('现场值 '+signed(p.vision,4))}</title></circle><rect x="${x-3.7}" y="${ct-3.7}" width="7.4" height="7.4" fill="#c77424" stroke="white"><title>${esc('三坐标值 '+signed(p.cmm,4))}</title></rect>`);svg.push(text(x,vt+(va?-12:20),signed(p.vision),'text-anchor="middle" fill="#2456a6" font-size="11" font-weight="600"'),text(x,ct+(va?20:-12),signed(p.cmm),'text-anchor="middle" fill="#ae631f" font-size="11" font-weight="600"'));});
 svg.push(text(L,374,'差值：现场值 − 三坐标值','fill="#1d2b43" font-size="15" font-weight="700"'));
 const correction=Math.abs(m.nominal_offset||0)>1e-9?`差值已计入理论值差 ${signed(m.nominal_offset)} mm。`:'两设备理论值相同，差值为现场值减三坐标值。';svg.push(text(L,396,correction,'fill="#64748b" font-size="12"'));
 for(const v of [-state.threshold,state.threshold]){const yy=yDiff(v);svg.push(`<line x1="${L}" x2="${R}" y1="${yy}" y2="${yy}" stroke="#bc854b" stroke-dasharray="6 4"/>`,text(R+5,yy+4,signed(v,2),'fill="#9d642d" font-size="10"'));}
 svg.push(poly('diff',yDiff,'#307bb1'));
 svg.push(text(R+9,yDiff(0)+4,'三坐标基准线','fill="#556c7f" font-size="12" font-weight="600"'));
 rows.forEach((p,i)=>{const x=X(i),y=yDiff(p.diff),c=exceed(p.diff)?'#be4528':'#5d7388';svg.push(`<circle cx="${x}" cy="${y}" r="4.3" fill="${c}" stroke="white"><title>${esc(sampleLabel(p)+'：差值 '+signed(p.diff,4))}</title></circle>`,text(x,y+(p.diff<0&&p.diff>-.83*dc?20:-12),signed(p.diff),`fill="${c}" text-anchor="middle" font-size="11" font-weight="600"`));const date=String(p.vision_time||p.cmm_date||'').replace('T',' ');svg.push(text(x,609,date.length>=10?date.slice(5,10):date,'fill="#64748b" text-anchor="middle" font-size="10"'),text(x,625,date.length>=16?date.slice(11,16):'','fill="#64748b" text-anchor="middle" font-size="10"'),text(x,642,p.short_sn||String(p.sn||'').slice(-9),'fill="#64748b" text-anchor="middle" font-size="10"'));});
 return svg.join('')+'</svg>';
}
function table(rows,sampleMode=false){const selected=$('only-exceed').checked?rows.filter(r=>exceed(r.p?.diff)):rows;const headers=sampleMode?['点位方向','现场值','三坐标值','差值','现场比三坐标']:['现场测量时间','工件尾号','现场值','三坐标值','差值','现场比三坐标'];let h='<div class="table-scroll"><table><thead><tr>'+headers.map(t=>'<th>'+t+'</th>').join('')+'</tr></thead><tbody>';
 for(const {m,p,meta} of selected){const cls=exceed(p?.diff)?'bad':'quiet';const first=sampleMode?`<td><button class="link-button" data-point="${esc(m.key)}">${esc(m.point+'点 '+m.axis)}</button></td>`:`<td>${esc(p?.vision_time||meta?.vision_time||p?.cmm_date||'未记录')}</td><td class="mono" title="${esc(p?.sn||meta?.sn)}">${esc(p?.short_sn||meta?.short_sn)}</td>`;h+=`<tr data-pair="${esc(p?.pair_id||'')}" data-key="${esc(m.key)}">${first}<td>${signed(p?.vision,4)}</td><td>${signed(p?.cmm,4)}</td><td class="${cls}">${signed(p?.diff,4)}</td><td class="${cls}">${p?signed(p.diff,4):'缺少可比数值'}</td></tr>`;}
 if(!selected.length)h+=`<tr><td class="empty-row" colspan="${headers.length}">${rows.length?'没有超过当前标记值的项目。':'没有可比较数据。'}</td></tr>`;return h+'</tbody></table></div>';}
function renderPoint(){const d=state.data;if(!d)return;const m=d.items.find(m=>m.key===$('point-select').value);if(!m){$('point-content').innerHTML='<p class="note">没有找到符合条件的点位。</p>';return;}
 const s=stats(m);let h=`<h3 class="point-name">${esc(pointLabel(m))}</h3><div class="stats"><div class="stat"><span>平均差值</span><b>${signed(s.mean)}</b></div><div class="stat"><span>最大相差</span><b>${s.maxAbs.toFixed(3)}</b></div><div class="stat"><span>件间差值最多变化</span><b>${s.spread.toFixed(3)}</b></div><div class="stat"><span>相差 &gt;${state.threshold} 的次数</span><b>${s.count} / ${s.n}</b></div></div>`;
 h+=`<p class="description">这${s.n}次比较中，差值范围为 <b>${signed(s.min)}</b> 至 <b>${signed(s.max)}</b>。${s.n===1?'只有一次配对，尚不能看出件间变化。':''}</p><div class="chart-panel">${offlineNotice()}<div class="chart-scroll">${chart(m)}</div></div><p class="chart-hint"><b>灰色水平线＝三坐标基准线。</b>蓝色曲线表示各件差值，红点表示差值绝对值超过${state.threshold}。图表可左右滑动。</p>`;
 if(Math.abs(m.nominal_offset||0)>1e-9)h+=`<p class="note">本点现场理论值 ${esc(m.vision_nominal)}，三坐标理论值 ${esc(m.cmm_nominal)}；差值已计入理论值差 ${signed(m.nominal_offset)}，无需再次相加。</p>`;
 h+=table(m.pairs.map(p=>({m,p})))+'<p class="note">表中保留4位小数；是否超过标记值按完整数值计算。</p>';$('point-content').innerHTML=h;}
function renderSample(){const d=state.data;if(!d)return;const p=d.pairs.find(p=>p.pair_id===$('sample-select').value);if(!p){$('sample-content').innerHTML='<p class="note">没有可比较工件。</p>';return;}
 const rows=d.items.map(m=>({m,p:m.pairs.find(v=>v.pair_id===p.pair_id),meta:p})).sort((a,b)=>(Math.abs(b.p?.diff)||0)-(Math.abs(a.p?.diff)||0));const n=rows.filter(r=>r.p).length,c=rows.filter(r=>exceed(r.p?.diff)).length;$('sample-content').innerHTML=`<div class="small-summary"><b>${esc(sampleLabel(p))}</b><br>可比较${n}个方向，其中${c}项相差超过${state.threshold}。按相差大小排列。</div>`+offlineNotice('sample-offline-notice')+table(rows,true)+`<p class="note">完整工件编号：${esc(p.sn)}。点击点位名称可查看这个点的多件数据。</p>`;}
async function download(){
 if(!state.data)return;const button=$('download');button.disabled=true;const label=button.textContent;button.textContent='正在打包结果…';
 try {
  const root=document.documentElement.cloneNode(true);
  root.querySelectorAll('[data-portal-return]').forEach(link=>link.remove());
  for(const input of root.querySelectorAll('input[type=\"file\"],input[type=\"search\"]')){input.value='';input.removeAttribute('value');}
  for(const type of ['vision','cmm']){root.querySelector('#'+type+'-name').textContent='尚未导入';root.querySelector('#'+type+'-sheet').innerHTML='';}
  root.querySelector('#saved-result').textContent=JSON.stringify({data:privacy.compareResult(state.data),threshold:state.threshold,saved_at:new Date().toLocaleString('zh-CN')}).replace(/</g,'\\u003c');
  // Bundle static, same-origin resources so the exported report still works offline.
  // Only GETs for application assets are made; no report content is sent anywhere.
  for(const link of root.querySelectorAll('link[rel="stylesheet"][href]')){
   const url=new URL(link.getAttribute('href'),location.href);if(url.origin!==location.origin)throw new Error('检测到非本地样式资源。');
   const response=await fetch(url,{credentials:'same-origin'});if(!response.ok)throw new Error('无法读取本地样式，请刷新工具页面后重试。');
   const style=document.createElement('style');style.textContent=(await response.text()).replace(/<\/style/gi,'<\\/style');link.replaceWith(style);
  }
  for(const script of root.querySelectorAll('script[src]')){
   const url=new URL(script.getAttribute('src'),location.href);if(url.origin!==location.origin)throw new Error('检测到非本地脚本资源。');
   const response=await fetch(url,{credentials:'same-origin'});if(!response.ok)throw new Error('无法读取本地组件，请刷新工具页面后重试。');
   script.textContent=(await response.text()).replace(/<\/script/gi,'<\\/script');script.removeAttribute('src');
  }
  root.querySelector('#download').disabled=false;root.querySelector('#download').textContent=label;
  const content='<!doctype html>\n'+root.outerHTML,blob=new Blob([content],{type:'text/html;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download='检具与三坐标_对比结果_'+new Date().toISOString().slice(0,10)+'.html';a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);
 }catch(error){$('saved-banner').hidden=false;$('saved-banner').textContent='保存失败：'+describeError(error);}finally{button.disabled=false;button.textContent=label;}
}
for(const type of ['vision','cmm']){const drop=$(type+'-drop'),input=$(type+'-file');drop.addEventListener('click',e=>{if(e.target.closest('select,input,label'))return;input.click();});drop.addEventListener('keydown',e=>{if(e.target===drop&&(e.key==='Enter'||e.key===' ')){e.preventDefault();input.click();}});input.addEventListener('change',()=>{importFiles(input.files,type);input.value='';});drop.addEventListener('dragover',e=>{e.preventDefault();e.stopPropagation();drop.classList.add('dragging');});drop.addEventListener('dragleave',()=>drop.classList.remove('dragging'));drop.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();drop.classList.remove('dragging');importFiles(e.dataTransfer.files,type);});$(type+'-sheet').addEventListener('change',e=>{if(state[type]){state[type].sheet=state[type].sheets[Number(e.target.value)];runComparison();}});}
$('import-card').addEventListener('dragover',e=>e.preventDefault());$('import-card').addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();importFiles(e.dataTransfer.files);});document.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files'))e.preventDefault();});document.addEventListener('drop',e=>{if(e.dataTransfer?.files.length&&!e.defaultPrevented){e.preventDefault();importFiles(e.dataTransfer.files);}});
$('reset').addEventListener('click',reset);$('new-import').addEventListener('click',reset);$('tab-point').addEventListener('click',()=>mode('point'));$('tab-sample').addEventListener('click',()=>mode('sample'));$('point-select').addEventListener('change',renderPoint);$('sample-select').addEventListener('change',renderSample);$('only-exceed').addEventListener('change',()=>{renderPoint();renderSample();});$('threshold').addEventListener('change',()=>{const v=Number($('threshold').value);if(!Number.isFinite(v)||v<=0){$('threshold').setCustomValidity('请输入大于0的数值。');$('threshold').reportValidity();return;}$('threshold').setCustomValidity('');state.threshold=v;renderPoint();renderSample();});$('point-search').addEventListener('input',()=>{const q=$('point-search').value.trim().toLowerCase();const options=Array.from($('point-select').options);for(const o of options)o.hidden=q?!(/^\d+$/.test(q)?o.value.split('_')[0]===q:o.textContent.toLowerCase().includes(q)):false;const found=options.find(o=>!o.hidden);if(found){$('point-select').value=found.value;renderPoint();}else $('point-content').innerHTML='<p class="note">没有找到符合条件的点位。</p>';});
document.addEventListener('click',e=>{const b=e.target.closest('[data-point]');if(b){$('point-search').value='';for(const o of $('point-select').options)o.hidden=false;$('point-select').value=b.dataset.point;mode('point');renderPoint();$('result').scrollIntoView({behavior:'smooth'});}});$('download').addEventListener('click',download);
try{const saved=JSON.parse($('saved-result').textContent);if(saved?.data){state.data=privacy.compareResult(saved.data);state.threshold=finite(saved.threshold)&&saved.threshold>0?saved.threshold:.2;$('threshold').value=state.threshold;state.saved=true;$('import-card').hidden=true;$('saved-banner').hidden=false;const savedAt=/^[\d\s/:.年月日-]+$/.test(String(saved.saved_at||''))?String(saved.saved_at):'';$('saved-banner').textContent='已保存的对比结果 · '+savedAt;$('saved-result').textContent=JSON.stringify({data:state.data,threshold:state.threshold,saved_at:savedAt}).replace(/</g,'\\u003c');$('new-import').hidden=false;renderAll();}else reset();}catch(error){reset();setStatus('已保存的数据无法读取，请重新导入两份报告。','error');}
window.MeasureCompareTool={version:'1.0.0',getResult:()=>state.data?privacy.compareResult(state.data):null,importFiles,reset};
window.PortalToolBridge?.register('measurement-compare',window.MeasureCompareTool);
})();
