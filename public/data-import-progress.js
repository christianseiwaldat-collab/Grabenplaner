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
  function tableTotals(table){
    const run=table.run||{},counts=run.counts||{},received=count(run.receivedRows);
    const invalid=count(counts.invalid),conflict=count(counts.conflict),deferred=table.deferred==='INCOMPLETE_STOCK_SNAPSHOT';
    const eligible=deferred?0:Math.max(0,received-invalid-conflict);
    return {received,invalid,conflict,deferredRows:deferred?received:0,deferredTables:deferred?1:0,eligible,
      confirmed:deferred?0:run.status==='applied'?eligible:Math.min(eligible,count(counts.applied))};
  }
  function summarize(source){
    return (source.tables||[]).reduce((total,table)=>{
      for(const [name,value] of Object.entries(tableTotals(table)))total[name]+=value;
      return total;
    },{received:0,invalid:0,conflict:0,deferredRows:0,deferredTables:0,eligible:0,confirmed:0});
  }
  function quarantineNote(totals){
    const issues=[totals.invalid?`${number(totals.invalid)} ${totals.invalid===1?'ungültige Zeile':'ungültige Zeilen'}`:'',
      totals.conflict?`${number(totals.conflict)} ${totals.conflict===1?'offener Prüffall':'offene Prüffälle'}`:''].filter(Boolean);
    return [issues.length?`Zur Prüfung zurückgestellt: ${issues.join(' · ')}. Diese Zeilen sind nicht übernommen.`:'',
      totals.deferredTables?`Bestandsaufnahme zurückgestellt: ${number(totals.deferredRows)} Zeilen. Der bisherige gültige Bestandsstand bleibt erhalten.`:''].filter(Boolean).join(' ');
  }
  function duration(milliseconds){
    if(!Number.isFinite(milliseconds)||milliseconds<0)return '–';
    const seconds=Math.floor(milliseconds/1000),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60);
    if(hours>=24)return `${Math.floor(hours/24)} T ${hours%24} Std`;
    if(hours)return `${hours} Std ${minutes} Min`;
    if(minutes)return `${minutes} Min ${seconds%60} Sek`;
    return `${seconds} Sek`;
  }
  function metrics(source){
    const tables=source.tables||[],job=source.background,progress=source.progress,totals=summarize(source);
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
      const note=cash?null:quarantineNote(totals);
      result.push({id:'applying',label:cash?'Kassenstand freigeben':'Übernahme insgesamt',value:cash?(complete?received:totals.confirmed):totals.confirmed,total:cash?(complete?received:0):totals.eligible,
        complete,active,startedAt:cash&&job?.phase!=='applying'?null:started,finishedAt:progress?.operation==='apply'?progress.finishedAt:null,updatedAt:source.updatedAt,
        note,showEmptyTotal:!cash,completionLabel:note?'Übernahme abgeschlossen · Prüffälle zurückgestellt':null,
        phase:`${source.currentStep?.table||''}:${source.currentStep?.phase||''}`,allowEstimate:false});
    }else if(reverting){
      result.push({id:'reverting',label:'Rücknahme insgesamt',value:tables.reduce((n,t)=>n+(t.run?.status==='reverted'?count(t.run.receivedRows):count(t.run?.counts?.reverted)),0),total:received,
        complete:source.status==='reverted',active,startedAt:progress?.startedAt,finishedAt:progress?.finishedAt,updatedAt:source.updatedAt,phase:source.currentStep?.table});
    }else if(source.complete&&job?.phase!=='content-date'){
      result.push({id:'reviewing',label:'Prüfung insgesamt',value:tables.reduce((n,t)=>n+Math.max(0,count(t.run?.receivedRows)-count(t.run?.counts?.staged)),0),total:received,
        complete:['ready','needs_review','applied'].includes(source.status),active,startedAt:progress?.startedAt||source.readCompletedAt||started,
        finishedAt:progress?.operation==='review'?progress.finishedAt:null,updatedAt:source.updatedAt,phase:source.currentStep?.table,
        note:source.storage==='cash-compact-v1'?null:quarantineNote(totals)});
    }
    const step=source.currentStep,table=tables.find(t=>t.name===step?.table),run=table?.run;
    if((applying||reverting||source.complete&&source.status==='reviewing')&&!['applied','reverted'].includes(source.status)&&run){
      const counts=run.counts||{},rowTotals=tableTotals(table),phase=step.phase;
      const total=phase==='applying'?rowTotals.eligible:count(run.receivedRows);
      const value=phase==='reviewing'?total-count(counts.staged):phase==='rechecking'?count(counts.staged)+count(counts.duplicate)+count(counts.invalid)
        :phase==='reverting'?count(counts.reverted)+count(counts.unchanged)+count(counts.duplicate)
          :rowTotals.deferredRows?0:run.status==='applied'?rowTotals.eligible:count(counts.applied)+count(counts.unchanged)+count(counts.duplicate);
      const labels={reviewing:'Prüfung',rechecking:'Prüfung vorbereiten',applying:'Übernahme',reverting:'Rücknahme'};
      result.push({id:`table:${run.id||table.name}:${phase}`,label:`${table.name} · ${labels[phase]||'Verarbeitung'}`,value:Math.max(0,Math.min(total,value)),total,
        active,startedAt:progress?.phaseStartedAt,updatedAt:source.updatedAt,phase,
        allowEstimate:['reviewing','rechecking','applying','reverting'].includes(phase),
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
        if(metric.active&&total>0&&metric.allowEstimate===true){
          if(current-history.lastAdvanceAt>30000)history.samples=[];
          const last=history.samples.at(-1);
          if(!last){history.samples.push({at:stamp,value});history.lastAdvanceAt=current;}
          else if(stamp>last.at&&value>last.value){history.samples.push({at:stamp,value});history.lastAdvanceAt=current;}
          history.samples=history.samples.filter(sample=>sample.at>=stamp-120000).slice(-24);
        }else history.samples=[];
        history.lastValue=value;
        // Only compare recent work within the same run/phase. A single burst
        // cannot predict heterogeneous remaining tables or a later row type.
        const samples=history.samples.slice(-4),first=samples[0],last=samples.at(-1);
        let remainingMs=metric.complete?0:null;
        if(!metric.complete&&metric.allowEstimate===true&&value<total&&samples.length>=4&&last.at-first.at>=20000&&current-history.lastAdvanceAt<=30000){
          const rates=samples.slice(1).map((sample,index)=>(sample.value-samples[index].value)/(sample.at-samples[index].at));
          const rate=(last.value-first.value)/(last.at-first.at);
          if(rates.every(value=>Number.isFinite(value)&&value>0)&&Math.max(...rates)/Math.min(...rates)<=3)remainingMs=Math.ceil((total-value)/rate);
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
      const remaining=metric.complete?metric.completionLabel||'Abgeschlossen':!metric.active?'–':state.remainingMs===null?'nicht belastbar schätzbar':`ca. ${duration(state.remainingMs)}`;
      const remainingLabel=metric.allowEstimate===true?'Restzeit dieses Schritts':'Restzeit';
      return `<section class="data-import-progress" aria-label="${escape(metric.label)}"><div class="data-import-progress-heading"><strong>${escape(metric.label)}</strong><span>${escape(percentage)}</span></div>
        <progress max="${Math.max(metric.total,1)}"${known?` value="${metric.complete?Math.max(metric.total,1):Math.min(metric.value,metric.total)}"`:''} aria-label="${escape(metric.label)}"></progress>
        <div class="data-import-progress-times"><span>Vergangen: <strong>${escape(duration(state.elapsedMs))}</strong></span><span>${escape(remainingLabel)}: <strong>${escape(remaining)}</strong></span></div>
        ${metric.total>0||metric.showEmptyTotal?`<small>${number(Math.min(metric.value,metric.total))} / ${number(metric.total)} ${escape(metric.unit||'Zeilen')}</small>`:''}${metric.note?`<p class="data-import-note">${escape(metric.note)}</p>`:''}</section>`;
    }).join('');
  }
  return Object.freeze({metrics,summarize,createTracker,render,duration});
}));
