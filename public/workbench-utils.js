(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.PortalWorkbench=api;
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  function pageWindow(total,page,size){
    const count=Math.max(0,Number.isInteger(total)?total:0),limit=Number.isInteger(size)&&size>0?size:20;
    const pages=Math.max(1,Math.ceil(count/limit)),current=Math.min(pages,Math.max(1,Number.isInteger(page)?page:1)),start=(current-1)*limit;
    return {page:current,pages,start,end:Math.min(count,start+limit),size:limit,total:count};
  }
  function availableKind(preferred,capabilities={}){
    const available=kind=>kind==='count'||capabilities[kind]?.enabled===true;
    return ['inbound','outbound','count'].includes(preferred)&&available(preferred)?preferred:['inbound','outbound','count'].find(available);
  }
  function selectionSnapshot(previous,items){
    const item=Array.isArray(items)?items.find(candidate=>candidate.id===previous?.id&&candidate.sourceIdentity===previous?.sourceIdentity):null;
    const verified=Boolean(item?.id&&item.selectable===true&&item.stock!==null&&item.stock!==undefined&&item.stock!==''&&Number.isFinite(Number(item.stock)));
    const changed=verified&&['stock','code','name','specification','location','unit'].some(key=>String(previous?.[key]??'')!==String(item[key]??''));
    return {item:verified?{...item}:null,verified,changed};
  }
  // Original device timestamps are labels, not necessarily zoned instants.
  function deviceStamp(value){return value?String(value).replace('T',' ').replace(/\.\d+Z$/,' UTC').replace(/Z$/,' UTC'):'—';}
  function sourceStamp(value){
    if(!value)return '—';const text=String(value);
    if(!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text))return deviceStamp(text)+'（来源未标注时区）';
    const date=new Date(text);
    return Number.isNaN(date.valueOf())?deviceStamp(text):new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(date)+' 北京时间';
  }
  function periodDates(period,now=new Date()){
    if(period==='all')return {start:'',end:''};
    const days={today:1,week:7,month:30}[period]||1,parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now),part=type=>parts.find(item=>item.type===type).value;
    const today=`${part('year')}-${part('month')}-${part('day')}`,start=new Date(Date.parse(today+'T12:00:00Z')-(days-1)*86400000).toISOString().slice(0,10);
    return {start:start+'T00:00',end:today+'T23:59'};
  }
  return {pageWindow,availableKind,selectionSnapshot,deviceStamp,sourceStamp,periodDates};
});
