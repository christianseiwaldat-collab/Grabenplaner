(function(root,factory){
  'use strict';const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;else root.StartDashboardVps=api;
})(typeof window==='object'?window:this,function(){
  'use strict';
  const ENDPOINT='/api/portal/v1/system-center',MIN_INTERVAL_MS=60000;
  const numeric=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
  function bytes(value){const n=numeric(value);if(n===null)return 'Nicht verfügbar';const units=['B','KiB','MiB','GiB','TiB'];let amount=n,index=0;while(amount>=1024&&index<units.length-1){amount/=1024;index++;}return amount.toLocaleString('de-AT',{maximumFractionDigits:index?1:0})+' '+units[index];}
  function uptime(value){const n=numeric(value);if(n===null)return 'Nicht verfügbar';const minutes=Math.floor(n/60),days=Math.floor(minutes/1440),hours=Math.floor(minutes/60)%24;return (days?days+' T ': '')+hours+' Std '+minutes%60+' Min';}
  function timestamp(value){if(typeof value!=='string'||!value.trim())return null;const ms=Date.parse(value);return Number.isFinite(ms)?ms:null;}
  function nightly(payload,now){
    const assurance=payload.recoveryAssurance||payload.status?.recoveryAssurance||{};
    const result={id:'nightly',label:'Letzter Nachtlauf',value:'Nicht nachgewiesen',detail:'Kein verifizierter nächtlicher Lauf verfügbar.',state:'unknown'};
    if(assurance.integrityVerified!==true||assurance.statusAvailable!==true)return result;
    const runs=Array.isArray(assurance.recentRuns)?assurance.recentRuns:[];
    const run=runs.filter(r=>r?.trigger==='scheduled-nightly'&&timestamp(r.startedAt)!==null).sort((a,b)=>timestamp(b.startedAt)-timestamp(a.startedAt))[0];
    if(!run)return result;
    const state={passed:'Erfolgreich',failed:'Fehlgeschlagen',running:'Läuft'}[run.status];
    if(!state)return result;
    if(run.status!=='running'&&timestamp(run.completedAt)===null)return result;
    const when=timestamp(run.completedAt)??timestamp(run.startedAt);
    if(when>now+5*60000)return {...result,detail:'Die Zeit des Nachtlaufs liegt außerhalb des gültigen Bereichs.'};
    const stale=now-when>36*3600000,phases=Array.isArray(run.phases)?run.phases:[];
    return {...result,value:(stale?'Veraltet · ':'')+state,state:stale?'stale':run.status,
      detail:new Date(when).toLocaleString('de-AT')+(phases.length?' · '+phases.filter(p=>p?.status==='passed').length+'/'+phases.length+' Prüfschritte':'')};
  }
  function warnings(payload,now){
    const status=payload.status,alerts=status?.alerts,checked=timestamp(status?.checkedAt);
    const result={id:'warnings',label:'Warnungen',value:'Nicht verfügbar',detail:'Kein aktueller Statusnachweis verfügbar.',state:'unknown'};
    if(!Array.isArray(alerts)||checked===null||checked>now+5*60000)return result;
    const findings=alerts.filter(alert=>alert&&['warning','critical'].includes(alert.severity)),stale=now-checked>5*60000;
    return {...result,value:(stale?'Veralteter Stand · ':'')+(findings.length?findings.length+' gemeldet':'Keine gemeldet'),state:stale?'stale':findings.length?'warning':'clear',
      detail:findings.length?findings.slice(0,3).map(a=>String(a.title||a.message||'Systemzustand prüfen')).join(' · ')+(findings.length>3?' · Weitere im System-Center':''):'Stand '+new Date(checked).toLocaleString('de-AT')};
  }
  function metrics(payload,now=Date.now()){
    if(payload?.capabilities?.technicalDiagnostics!==true||!payload.resources)return [];
    const r=payload.resources,load=numeric(r.cpu?.loadAverageOneMinute),cores=numeric(r.cpu?.logicalProcessors),used=numeric(r.memory?.usedPercent);
    const memoryPercent=used!==null&&used<=100?used.toLocaleString('de-AT')+' % genutzt':'Nicht verfügbar';
    return [
      {id:'cpu',label:'CPU · Last (1 Min)',value:load===null?'Nicht verfügbar':load.toLocaleString('de-AT',{maximumFractionDigits:2}),detail:cores!==null&&cores>0?cores.toLocaleString('de-AT')+' logische Prozessoren':''},
      {id:'memory',label:'Arbeitsspeicher',value:memoryPercent,detail:bytes(r.memory?.availableBytes)+' verfügbar · '+bytes(r.memory?.totalBytes)+' gesamt'},
      {id:'storage',label:'Speicher frei',value:bytes(r.storage?.freeBytes),detail:''},
      {id:'database',label:'Datenbanken gesamt',value:bytes(r.storage?.databaseBytes),detail:''},
      {id:'uptime',label:'GP-Laufzeit',value:uptime(r.uptimeSeconds),detail:''},
      nightly(payload,now),warnings(payload,now),
    ];
  }
  function mount(host,options){
    if(!host)return null;
    const doc=host.ownerDocument,win=doc.defaultView,removers=[];
    const now=options.now||Date.now;
    function element(selector,tag){let node=host.querySelector(selector);if(!node){node=doc.createElement(tag);node.setAttribute(selector.slice(1,-1),'');host.append(node);}return node;}
    const output=element('[data-vps-metrics]','dl'),status=element('[data-vps-status]','p'),button=element('[data-vps-refresh]','button');
    output.classList.add('start-dashboard-vps-metrics');status.setAttribute('role','status');button.type='button';button.textContent='Aktualisieren';
    let identity=null,epoch=0,pending=null,lastAttempt=null,wasActive=false,destroyed=false;
    const on=(node,event,listener)=>{node.addEventListener(event,listener);removers.push(()=>node.removeEventListener(event,listener));};
    const allowed=()=>!destroyed&&options.canUse()&&Boolean(String(options.key()||''));
    const visible=()=>allowed()&&options.active()&&doc.visibilityState!=='hidden'&&host.getClientRects().length>0;
    function clear(){output.replaceChildren();status.textContent='';host.removeAttribute('aria-busy');button.disabled=!allowed();}
    function cancel(){epoch++;pending?.controller.abort();pending=null;host.removeAttribute('aria-busy');button.disabled=!allowed();}
    function current(key,ticket){return !destroyed&&key===String(options.key()||'')&&key===identity&&ticket===epoch&&visible();}
    function draw(payload){
      output.replaceChildren();
      const rows=metrics(payload,now());
      for(const row of rows){const cell=doc.createElement('div'),label=doc.createElement('dt'),content=doc.createElement('dd'),value=doc.createElement('strong'),detail=doc.createElement('small');cell.dataset.vpsMetric=row.id;if(row.state)cell.dataset.vpsState=row.state;label.textContent=row.label;value.textContent=row.value;detail.textContent=row.detail;content.append(value,detail);cell.append(label,content);output.append(cell);}
      if(!rows.length){status.textContent='Technische Ressourcen sind für dieses Konto nicht verfügbar.';return;}
      const stamp=new Date(payload.generatedAt);status.textContent='Abgerufen '+(Number.isFinite(stamp.getTime())?stamp.toLocaleString('de-AT'):new Date(now()).toLocaleString('de-AT'))+'.';
    }
    async function refresh(){
      synchronize();if(!visible())return false;
      if(pending)return pending.promise;
      if(lastAttempt!==null&&now()-lastAttempt<MIN_INTERVAL_MS)return false;
      lastAttempt=now();const key=identity,ticket=epoch,controller=new AbortController(),request={controller,promise:null};pending=request;
      host.setAttribute('aria-busy','true');button.disabled=true;status.textContent='Ressourcen werden geladen …';
      request.promise=(async()=>{
        try{const result=await options.api(ENDPOINT,{signal:controller.signal});if(controller.signal.aborted||!current(key,ticket))return false;draw(result);return true;}
        catch(error){if(!controller.signal.aborted&&current(key,ticket)){output.replaceChildren();status.textContent='Ressourcen konnten nicht geladen werden. Bitte später erneut aktualisieren.';options.error?.(error);}return false;}
        finally{if(pending===request){pending=null;host.removeAttribute('aria-busy');button.disabled=!allowed();}}
      })();return request.promise;
    }
    function synchronize(){const key=String(options.key()||'');if(identity!==key||!allowed()){cancel();identity=key;lastAttempt=null;wasActive=false;clear();}}
    function sync(){synchronize();const active=visible();if(!active){if(wasActive||pending)cancel();wasActive=false;return;}if(!wasActive){wasActive=true;void refresh();}}
    on(button,'click',()=>{if(visible())void refresh();});on(doc,'visibilitychange',sync);
    sync();
    return {sync,refresh,destroy(){if(destroyed)return;cancel();destroyed=true;for(const remove of removers)remove();clear();},get loading(){return Boolean(pending);}};
  }
  return {ENDPOINT,MIN_INTERVAL_MS,bytes,uptime,metrics,mount};
});
