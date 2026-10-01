(function attach(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.GrabenplanerImportProgress=api;
}(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const count=value=>Number.isSafeInteger(Number(value))&&Number(value)>=0?Number(value):0;
  const time=value=>Number.isFinite(Date.parse(value))?Date.parse(value):null;
  const number=value=>value.toLocaleString('de-AT');
  function duration(milliseconds){
    if(!Number.isFinite(milliseconds)||milliseconds<0)return '–';
    const seconds=Math.floor(milliseconds/1000),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60);
    if(hours>=24)return `${Math.floor(hours/24)} T ${hours%24} Std`;
    if(hours)return `${hours} Std ${minutes} Min`;
    if(minutes)return `${minutes} Min ${seconds%60} Sek`;
    return `${seconds} Sek`;
  }
  function metrics(source){
    const tables=source.tables||[],job=source.background,progress=source.progress;
    const active=!!source.active&&!['paused','failed','retrying','queued'].includes(job?.status);
    const received=tables.reduce((n,t)=>n+count(t.run?.receivedRows),0);
    const expected=tables.reduce((n,t)=>n+count(t.declaredRows),0);
    const started=job?.createdAt||progress?.startedAt||source.createdAt;
    const result=[{id:'reading',label:'Einlesen',value:received,total:Math.max(expected,received),complete:!!source.complete,
      startedAt:source.createdAt,finishedAt:source.readCompletedAt,active:active&&!source.complete,updatedAt:source.updatedAt}];
    const applying=job?.phase==='applying'||['applying','applied'].includes(source.status)||source.cashPublication?.active;
    const reverting=['reverting','reverted'].includes(source.status);
    if(applying){
      const cash=source.storage==='cash-compact-v1',complete=cash?!!source.cashPublication?.active:source.status==='applied';
      const value=tables.reduce((n,t)=>n+(t.run?.status==='applied'?count(t.run.receivedRows):count(t.run?.counts?.applied)),0);
      result.push({id:'applying',label:cash?'Kassenstand freigeben':'Übernahme insgesamt',value:complete?received:value,total:cash&&!complete?0:received,
        complete,active,startedAt:cash&&job?.phase!=='applying'?null:started,finishedAt:progress?.operation==='apply'?progress.finishedAt:null,updatedAt:source.updatedAt,
        phase:`${source.currentStep?.table||''}:${source.currentStep?.phase||''}`,allowEstimate:!cash&&source.currentStep?.phase==='applying'&&source.currentStep?.table!=='Artikelkatalog'});
    }else if(reverting){
      result.push({id:'reverting',label:'Rücknahme insgesamt',value:tables.reduce((n,t)=>n+(t.run?.status==='reverted'?count(t.run.receivedRows):count(t.run?.counts?.reverted)),0),total:received,
        complete:source.status==='reverted',active,startedAt:progress?.startedAt,finishedAt:progress?.finishedAt,updatedAt:source.updatedAt,phase:source.currentStep?.table});
    }else if(source.complete&&job?.phase!=='content-date'){
      result.push({id:'reviewing',label:'Prüfung insgesamt',value:tables.reduce((n,t)=>n+Math.max(0,count(t.run?.receivedRows)-count(t.run?.counts?.staged)),0),total:received,
        complete:['ready','needs_review','applied'].includes(source.status),active,startedAt:progress?.startedAt||source.readCompletedAt||started,
        finishedAt:progress?.operation==='review'?progress.finishedAt:null,updatedAt:source.updatedAt,phase:source.currentStep?.table});
    }
    const step=source.currentStep,table=tables.find(t=>t.name===step?.table),run=table?.run;
    if((applying||reverting||source.complete&&source.status==='reviewing')&&!['applied','reverted'].includes(source.status)&&run){
      const counts=run.counts||{},total=count(run.receivedRows),phase=step.phase;
      const value=phase==='reviewing'?total-count(counts.staged):phase==='rechecking'?count(counts.staged)+count(counts.duplicate)+count(counts.invalid)
        :phase==='reverting'?count(counts.reverted)+count(counts.unchanged)+count(counts.duplicate)
          :run.status==='applied'?total:count(counts.applied)+count(counts.unchanged)+count(counts.duplicate);
      const labels={reviewing:'Prüfung',rechecking:'Prüfung vorbereiten',applying:'Übernahme',reverting:'Rücknahme'};
      result.push({id:`table:${run.id||table.name}:${phase}`,label:`${table.name} · ${labels[phase]||'Verarbeitung'}`,value:Math.max(0,Math.min(total,value)),total,
        active,startedAt:progress?.phaseStartedAt,updatedAt:source.updatedAt,phase,
        note:phase==='reviewing'&&applying?'Geprüfte Artikel und Zeilen erscheinen hier sofort. Der Gesamtzähler steigt beim anschließenden Übernehmen.':null});
    }
    if(step?.table==='Artikelkatalog'&&source.catalog){
      const undo=step.phase==='reverting',batches=source.catalog.batches||[];
      result.push({id:undo?'catalog-undo':'catalog',label:undo?'Artikelkatalog zurücknehmen':'Artikelkatalog aktualisieren',
        value:undo?batches.filter(batch=>batch.reverted).length:count(source.catalog.after),total:undo?batches.length:Math.max(0,count(source.catalog.total)-count(source.catalog.blocked)),
        unit:undo?'Pakete':'Artikel',complete:undo?batches.every(batch=>batch.reverted):!!source.catalog.complete,active,
        startedAt:progress?.phaseStartedAt,finishedAt:progress?.finishedAt,updatedAt:source.updatedAt});
    }
    if(job?.phase==='content-date'){
      const date=source.dateProgress;
      result.push({id:'content-date',label:'Datenstand ermitteln',value:count(date?.completedRows),total:count(date?.totalRows),active,
        startedAt:date?.startedAt||started,finishedAt:date?.finishedAt,updatedAt:date?.updatedAt||source.updatedAt});
    }
    return result.map(metric=>({...metric,key:`${source.id}:${metric.id}:${metric.startedAt||''}`}));
  }
  function createTracker({now=Date.now}={}){
    const histories=new Map();
    return Object.freeze({
      describe(metric){
        const current=now(),finished=time(metric.finishedAt),start=time(metric.startedAt);
        const elapsedMs=start===null||metric.complete&&finished===null?null:Math.max(0,(finished??(metric.active?current:time(metric.updatedAt)??current))-start);
        const value=Math.min(metric.total||metric.value,metric.value),total=metric.total;
        const percent=metric.complete?100:total>0?Math.min(100,value/total*100):null;
        let history=histories.get(metric.key);
        const stamp=time(metric.updatedAt)??current;
        if(!history||history.total!==total||value<history.lastValue||history.phase!==metric.phase||history.active!==metric.active){
          history={total,phase:metric.phase,active:metric.active,lastValue:value,samples:[],lastAdvanceAt:stamp};
          histories.set(metric.key,history);
        }
        if(metric.active&&total>0){
          const last=history.samples.at(-1);
          if(!last)history.samples.push({at:stamp,value});
          else if(stamp>last.at&&value>last.value){history.samples.push({at:stamp,value});history.lastAdvanceAt=current;}
          history.samples=history.samples.filter(sample=>sample.at>=stamp-120000).slice(-24);
        }else history.samples=[];
        history.lastValue=value;
        const first=history.samples[0],last=history.samples.at(-1);
        let remainingMs=metric.complete?0:null;
        if(metric.allowEstimate!==false&&history.samples.length>=3&&last.at-first.at>=8000&&current-history.lastAdvanceAt<=30000){
          const rate=(last.value-first.value)/(last.at-first.at);
          if(rate>0)remainingMs=Math.ceil((total-value)/rate);
        }
        if(remainingMs!==null&&(!Number.isFinite(remainingMs)||remainingMs<0||remainingMs>365*86400000))remainingMs=null;
        if(histories.size>64)histories.delete(histories.keys().next().value);
        return {percent,elapsedMs,remainingMs};
      },
      clear(){histories.clear();},
    });
  }
  function render(source,tracker=createTracker()){
    return metrics(source).map(metric=>{
      const state=tracker.describe(metric),known=state.percent!==null;
      const percentage=known?`${number(Math.round(state.percent*10)/10)} %`:'Prozent wird ermittelt';
      const remaining=metric.complete?'Abgeschlossen':!metric.active?'–':state.remainingMs===null?'wird ermittelt':`ca. ${duration(state.remainingMs)}`;
      return `<section class="data-import-progress" aria-label="${escape(metric.label)}"><div class="data-import-progress-heading"><strong>${escape(metric.label)}</strong><span>${escape(percentage)}</span></div>
        <progress max="${Math.max(metric.total,1)}"${known?` value="${metric.complete?Math.max(metric.total,1):Math.min(metric.value,metric.total)}"`:''} aria-label="${escape(metric.label)}"></progress>
        <div class="data-import-progress-times"><span>Vergangen: <strong>${escape(duration(state.elapsedMs))}</strong></span><span>Restzeit: <strong>${escape(remaining)}</strong></span></div>
        ${metric.total>0?`<small>${number(Math.min(metric.value,metric.total))} / ${number(metric.total)} ${escape(metric.unit||'Zeilen')}</small>`:''}${metric.note?`<p class="data-import-note">${escape(metric.note)}</p>`:''}</section>`;
    }).join('');
  }
  return Object.freeze({metrics,createTracker,render,duration});
}));
