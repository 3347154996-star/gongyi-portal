(function(root,factory){
  const api=factory(typeof module==='object'&&module.exports?require('./company-calendar.js'):root.PortalCalendar);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.PortalFilters=api;
})(typeof globalThis==='object'?globalThis:this,function(calendar){
  'use strict';
  const periods=[['today','今天'],['yesterday','昨天'],['companyWeek','公司周（KW）'],['week','近 7 天'],['month','近 30 天'],['custom','自定义日期'],['all','全部时间']];
  function today(now=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
  function range(period,now=new Date()){
    const end=today(now);
    if(period==='all')return {start:'',end:''};
    if(period==='companyWeek'){const info=calendar.weekInfo(end);return {start:info.start,end:info.end};}
    if(period==='yesterday'){const day=calendar.addDays(end,-1);return {start:day,end:day};}
    return {start:calendar.addDays(end,-({week:6,month:29}[period]||0)),end};
  }
  function validDay(day){try{return calendar.addDays(day,0)===day;}catch(_){return false;}}
  function validateRange(start,end,{allowEmpty=true}={}){
    if(!start&&!end&&allowEmpty)return '';
    if(!validDay(start)||!validDay(end))return '请填写有效的开始和结束日期，或选择全部时间。';
    return start>end?'开始日期不能晚于结束日期。':'';
  }
  function infer(start,end,now=new Date()){
    if(validDay(start)&&validDay(end)){const week=calendar.weekInfo(start);if(start===week.start&&end===week.end)return 'companyWeek';}
    return periods.filter(([key])=>key!=='custom').find(([key])=>{const r=range(key,now);return r.start===start&&r.end===end;})?.[0]||'custom';
  }
  function mountDateRange({mode,start,end,onDraft=()=>{},allowAll=true}){
    mode.innerHTML=periods.filter(([key])=>allowAll||key!=='all').map(([key,label])=>`<option value="${key}">${label}</option>`).join('');
    const write=(input,value,last)=>{input.value=value?(input.type==='datetime-local'?value+(last?'T23:59':'T00:00'):value):'';};
    const group=document.createElement('div');group.className='unified-week-controls';group.setAttribute('role','group');group.setAttribute('aria-label','公司周选择');
    const prefix=mode.id||'dateRange';
    group.innerHTML=`<label class="field"><span>年份</span><select id="${prefix}Year" aria-label="公司周年份"></select></label><label class="field unified-week-number"><span>KW 周次 · 周五至周四</span><select id="${prefix}Week" aria-label="公司周次"></select></label><div class="unified-week-step"><button type="button" class="button" data-week-step="-1" aria-label="前一公司周">← 前一周</button><button type="button" class="button" data-week-step="1" aria-label="后一公司周">后一周 →</button></div><small class="unified-week-note" aria-live="polite"></small>`;
    (mode.closest('.field')||mode).after(group);
    const year=group.querySelector('select[id$="Year"]'),week=group.querySelector('select[id$="Week"]'),note=group.querySelector('small');
    function selectedWeek(){return calendar.weekInfo(validDay(start.value.slice(0,10))?start.value.slice(0,10):today());}
    function renderWeek(info=selectedWeek()){
      const current=Number(today().slice(0,4)),years=[...new Set([...Array.from({length:8},(_,i)=>current-6+i),info.year])].filter(y=>y>=1901&&y<=2198).sort((a,b)=>b-a);
      year.innerHTML=years.map(y=>`<option value="${y}">${y} 年</option>`).join('');year.value=String(info.year);
      week.innerHTML=calendar.weeks(info.year).map(w=>`<option value="${w.week}">${w.label} · ${w.start.slice(5).replace('-','/')}–${w.end.slice(5).replace('-','/')}</option>`).join('');week.value=String(info.week);
      note.textContent=`${info.year} ${info.label}：${info.start} 至 ${info.end}；选择后点击“应用筛选”。跨年周号暂按含 1 月 1 日的周为 KW01。`;
      group.hidden=mode.value!=='companyWeek';
    }
    function useWeek(info){write(start,info.start,false);write(end,info.end,true);mode.value='companyWeek';renderWeek(info);onDraft();}
    const sync=()=>{const key=infer(start.value.slice(0,10),end.value.slice(0,10));mode.value=key==='all'&&!allowAll?'custom':key;renderWeek();};
    const reset=(period='today')=>{const key=period==='all'&&!allowAll?'today':period,dates=range(key);write(start,dates.start,false);write(end,dates.end,true);mode.value=key;renderWeek();};
    mode.addEventListener('change',()=>{if(mode.value==='companyWeek'){useWeek(selectedWeek());return;}if(mode.value!=='custom'){const dates=range(mode.value);write(start,dates.start,false);write(end,dates.end,true);}renderWeek();onDraft();});
    year.addEventListener('change',()=>useWeek(calendar.range(Number(year.value),Math.min(Number(week.value)||1,calendar.weeks(Number(year.value)).length))));
    week.addEventListener('change',()=>useWeek(calendar.range(Number(year.value),Number(week.value))));
    group.querySelectorAll('[data-week-step]').forEach(button=>button.addEventListener('click',()=>useWeek(calendar.weekInfo(calendar.addDays(selectedWeek().start,Number(button.dataset.weekStep)*7)))));
    for(const input of [start,end])input.addEventListener('input',()=>{mode.value='custom';renderWeek();onDraft();});
    sync();return {sync,reset,weekControls:group};
  }
  function enhanceMaterialSelect(select,{label='物料',placeholder='搜索物料名称'}={}){
    if(!select||select.dataset.materialSearch)return null;
    select.dataset.materialSearch='true';
    const field=select.closest('.field')||select.parentElement;field.classList.add('unified-material');
    const input=document.createElement('input');input.type='search';input.autocomplete='off';input.placeholder=placeholder;input.setAttribute('aria-label','搜索'+label+'选项');input.className='material-search';input.id=select.id+'Search';
    const hint=document.createElement('small');hint.className='material-match-hint';hint.setAttribute('aria-live','polite');
    const filter=()=>{const needle=input.value.trim().toLocaleLowerCase();let matches=0;for(const option of select.options){const base=!option.value||option.value==='all',match=option.textContent.toLocaleLowerCase().includes(needle);option.hidden=Boolean(needle)&&!base&&!match&&option.value!==select.value;if(!base&&match)matches++;}hint.textContent=needle?`${matches} 项匹配 · 选择后应用筛选`:'输入名称缩小选项；默认全部物料';};
    select.before(input);select.after(hint);input.addEventListener('input',filter);select.addEventListener('change',filter);
    const observer=new MutationObserver(filter);observer.observe(select,{childList:true,subtree:true,characterData:true});filter();
    return {clear(){input.value='';filter();},refresh:filter};
  }
  return {periods,range,today,validDay,validateRange,infer,mountDateRange,enhanceMaterialSelect};
});
