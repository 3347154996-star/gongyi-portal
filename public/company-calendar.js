(function(root,factory){'use strict';if(typeof module==='object'&&module.exports)module.exports=factory();else root.PortalCalendar=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const DAY=86400000;
  function date(day){if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new RangeError('请选择有效日期。');const n=Date.parse(day+'T00:00:00Z');if(!Number.isFinite(n)||new Date(n).toISOString().slice(0,10)!==day)throw new RangeError('请选择有效日期。');return n;}
  function addDays(day,count){return new Date(date(day)+count*DAY).toISOString().slice(0,10);}
  function startOfWeek(day){return addDays(day,-((new Date(date(day)).getUTCDay()+2)%7));}
  // Confirmed anchor: 2026-10-02..2026-10-08 = KW41. Friday through Thursday.
  // Year rollover convention: the week containing January 1 is KW01.
  function first(year){if(!Number.isInteger(year)||year<1901||year>2199)throw new RangeError('年份超出支持范围。');return startOfWeek(year+'-01-01');}
  function weekInfo(day){const start=startOfWeek(day),end=addDays(start,6),year=Number(end.slice(0,4)),week=Math.round((date(start)-date(first(year)))/(7*DAY))+1,label='KW'+String(week).padStart(2,'0');return {year,week,label,key:year+'-'+label,start,end};}
  function weeks(year){const count=Math.round((date(first(year+1))-date(first(year)))/(7*DAY));return Array.from({length:count},(_,i)=>weekInfo(addDays(first(year),i*7)));}
  function range(year,week){const values=weeks(Number(year));if(!Number.isInteger(Number(week))||!values[Number(week)-1])throw new RangeError('公司周次无效。');return values[Number(week)-1];}
  return Object.freeze({weekInfo,range,weeks,addDays,startOfWeek,rule:'周五至下周四；2026-10-02 至 2026-10-08 为 KW41；跨年暂按包含 1 月 1 日的周为 KW01。'});
});
