(function attach(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GrabenplanerSourceDateTime=api;
}(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  // Access stores local civil components, not UTC instants. In particular the
  // 1899 date of a time-only field must never become the receipt's business date.
  function civil(value){
    if(typeof value!=='string')return null;
    const match=/^(\d{4})-(\d{2})-(\d{2})(?:T([0-2]\d):([0-5]\d):([0-5]\d)(\.\d{1,7})?Z?)?$/.exec(value);
    if(!match||Number(match[4]||0)>23)return null;
    const date=match.slice(1,4).join('-'),check=new Date(date+'T00:00:00Z');
    if(!Number.isFinite(check.getTime())||check.toISOString().slice(0,10)!==date)return null;
    return {date,time:match[4]?match.slice(4,7).join(':')+(match[7]||''):null};
  }
  function clock(value){
    if(typeof value!=='string')return null;
    const direct=/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,7})?$/.test(value)?value:null;
    return direct||civil(value)?.time||null;
  }
  function project(value,{date,source='',timeValue,explicitTime=false}={}){
    const parsed=civil(value),day=civil(date)?.date||parsed?.date||null;
    const supplied=explicitTime?timeValue:value,absent=supplied===null||supplied===undefined||supplied==='';
    let time=clock(supplied),timeStatus=absent?'missing':time?'source':'invalid';
    // These day-level Access fields contain midnight placeholders. Only a
    // separate time field proves a real midnight booking in that case.
    if(!explicitTime&&(!time||/^00:00:00(?:\.0+)?$/.test(time))){time=null;timeStatus=parsed?'date_only':absent?'missing':'invalid';}
    return {time:day?time:null,dateTime:day&&time?day+'T'+time:null,timeStatus:day?timeStatus:'invalid',timeSource:time&&day?source:null,timeBasis:'source_local'};
  }
  function cash(head,date){
    const result=project(head.Bondatum,{date,source:'Umsatz_KASSE.Bonzeit',timeValue:head.Bonzeit,explicitTime:true});
    const stamp=civil(head.Bonzeit),day=civil(date)?.date||civil(head.Bondatum)?.date;
    if(stamp&&stamp.date!=='1899-12-30'&&stamp.date!==day)return {...result,time:null,dateTime:null,timeStatus:'invalid',timeSource:null};
    return result;
  }
  function dateLabel(value){const parsed=civil(value);return parsed?parsed.date.split('-').reverse().join('.'):'–';}
  const timeLabel=value=>clock(value)?.replace(/\.0+$/,'')||'Uhrzeit nicht erfasst';
  function rowLabel(row){
    const date=dateLabel(row.date),time=clock(row.time);
    return date+(time?' · '+timeLabel(time)+' Uhr':Object.hasOwn(row,'timeStatus')?row.timeStatus==='invalid'?' · Uhrzeit ungeklärt':' · Uhrzeit nicht erfasst':'');
  }
  function sourceLabel(value){
    const parsed=civil(value);if(!parsed)return '–';
    return dateLabel(value)+(parsed.time&&!/^00:00:00(?:\.0+)?$/.test(parsed.time)?' · '+timeLabel(parsed.time)+' Uhr':'');
  }
  function instantLabel(value){
    if(typeof value!=='string'||!value.endsWith('Z')||!civil(value))return '–';
    return new Intl.DateTimeFormat('de-AT',{timeZone:'Europe/Vienna',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(value));
  }
  return Object.freeze({civil,clock,project,cash,dateLabel,timeLabel,rowLabel,sourceLabel,instantLabel});
}));
