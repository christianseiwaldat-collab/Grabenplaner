"use strict";
(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.GrabenplanerWorkflowStudio=api;})(typeof globalThis!=="undefined"?globalThis:this,()=>{
 const escape=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
 function createController({api,key,session,canUse,active,scope=()=>"",onChange=()=>{}}){
  let owner=null,revision=0,pending=null,data=null,status="idle",error="";
  const currentIdentity=()=>({key:key(),session:session(),scope:scope()});
  const equal=(a,b)=>a&&b&&a.key===b.key&&a.session===b.session&&a.scope===b.scope;
  const emit=()=>onChange({data,status,error});
  function clear(next="idle"){revision++;pending?.abort();pending=null;data=null;status=next;error="";emit();}
  function sync(){const next=currentIdentity();if(!equal(owner,next)){owner=next;clear();}if(!canUse()){clear("denied");return;}if(!active()){clear();return;}if(status==="idle")void load();}
  async function load(){
   if(!canUse()||!active())return;const identity=currentIdentity();if(!equal(owner,identity)){owner=identity;clear();}
   pending?.abort();const request=++revision,abort=new AbortController();pending=abort;status="loading";error="";data=null;emit();
   const current=()=>request===revision&&!abort.signal.aborted&&equal(identity,currentIdentity())&&canUse()&&active();
   try{const result=await api("/api/portal/v1/workflow-studio/catalog",{signal:abort.signal});if(!current())return;
    if(result?.contractVersion!==1||result?.model!=="linear-v1"||result?.capabilities?.canRead!==true||!['definitions','legacyDefinitions','publications','instances'].every(k=>Array.isArray(result[k]))||result.instanceWindow!=="open")throw Error("Der Server hat keinen gültigen Workflow-Katalog geliefert.");
    data=result;status="ready";emit();
   }catch(e){if(!current())return;status=[401,403,428].includes(e.status)?"denied":"failed";error=status==="denied"?"Der Workflow-Zugriff ist nicht mehr verfügbar.":"Der Workflow-Katalog konnte nicht geladen werden. Bitte erneut aktualisieren.";data=null;emit();}
   finally{if(request===revision)pending=null;}
  }
  return{sync,load,clear,current:()=>({data,status,error}),destroy:()=>clear()};
 }
 function mount(host,options){
  if(!host)return null;let state={data:null,status:"idle",error:""},search="",kind="all",catalogData=null,catalogOwner=null,editor=null,runs=null;
  const ownCatalog=()=>catalogOwner?.key===options.key()&&catalogOwner?.session===options.session()&&catalogOwner?.scope===(options.scope?.()||'');
  host.innerHTML='<header class="workflow-studio-heading"><div><span class="eyebrow">ERP-Abläufe</span><h3>Workflow-Studio</h3><p>Gespeicherte Vorlagen und ihre freigegebenen Versionen im Überblick.</p></div><button class="secondary-button" type="button" data-workflow-refresh>Aktualisieren</button></header><p class="workflow-studio-status" role="status" aria-live="polite"></p><div class="workflow-studio-summary" aria-label="Freigegebener Gesamtkatalog"></div><div class="workflow-studio-filters" role="search" aria-label="Workflow-Katalog filtern"><label class="field"><span>Suche</span><input type="search" data-workflow-search placeholder="Titel, Beschreibung oder Bereich" autocomplete="off"></label><label class="field"><span>Bereich der Übersicht</span><select data-workflow-kind><option value="all">Alle Bereiche</option><option value="definitions">Studio-Entwürfe</option><option value="publications">Veröffentlichte Versionen</option><option value="instances">Offene Instanzen</option><option value="legacyDefinitions">Bestehende Abläufe</option></select></label></div><p class="workflow-studio-results" aria-live="polite"></p><div class="workflow-studio-groups"></div>';
  const statusNode=host.querySelector('.workflow-studio-status'),summary=host.querySelector('.workflow-studio-summary'),groups=host.querySelector('.workflow-studio-groups'),results=host.querySelector('.workflow-studio-results'),refresh=host.querySelector('[data-workflow-refresh]');
  const newButton=host.ownerDocument.createElement('button');newButton.type='button';newButton.className='primary-button';newButton.dataset.workflowNew='';newButton.textContent='Workflow entwerfen';newButton.hidden=true;host.querySelector('.workflow-studio-heading').append(newButton);
  const historyButton=host.ownerDocument.createElement('button');historyButton.type='button';historyButton.className='secondary-button';historyButton.dataset.workflowHistory='';historyButton.textContent='Manuelle Abläufe · Verlauf';historyButton.hidden=true;host.querySelector('.workflow-studio-heading').append(historyButton);
  const labels={definitions:"Studio-Entwürfe",publications:"Veröffentlichte Versionen",instances:"Offene Instanzen",legacyDefinitions:"Bestehende Abläufe"};
  const states={draft:"Entwurf",active:"Aktiv",archived:"Archiviert",open:"Offen"};
  function render(next){
   state=next;host.dataset.sourceStatus=state.status;host.setAttribute('aria-busy',String(state.status==='loading'));refresh.disabled=state.status==='loading'||!options.canUse();
   const ready=state.status==='ready',data=state.data;
   if(ready){catalogData=data;catalogOwner={key:options.key(),session:options.session(),scope:options.scope?.()||''};}if(state.status==='denied'){catalogData=null;catalogOwner=null;}
   newButton.hidden=!(ready&&data.capabilities.canManage===true&&(options.canManage?.()??true));historyButton.hidden=!ready;runs?.sync();editor?.sync();
   statusNode.textContent=ready?'Freigegebener Gesamtkatalog · Kennzahlen unabhängig von den Filtern. Die Instanzübersicht enthält offene manuelle Studio-Läufe.':state.error||(state.status==='loading'?'Workflow-Katalog wird geladen.':state.status==='denied'?'Kein Zugriff auf das Workflow-Studio.':'Noch kein Workflow-Katalog geladen.');
   summary.innerHTML=Object.entries(labels).map(([key,label])=>`<article><span>${label}</span><strong>${ready?data[key].length:'–'}</strong></article>`).join('');
   if(!ready){groups.innerHTML='';results.textContent='';return;}
   const needle=search.trim().toLocaleLowerCase('de-AT');let visible=0,total=0;
   groups.innerHTML=Object.entries(labels).filter(([key])=>kind==='all'||kind===key).map(([key,label])=>{
    const list=data[key],rows=list.filter(item=>[item.title,item.description,item.scope?.label].some(v=>String(v||'').toLocaleLowerCase('de-AT').includes(needle)));visible+=rows.length;total+=list.length;
    return `<section class="workflow-studio-group" aria-label="${label}"><header><h4>${label}</h4><span>${rows.length} von ${list.length}</span></header><div class="workflow-studio-list">${rows.length?rows.map(item=>`<article class="workflow-studio-card"><div class="workflow-studio-card-top"><h5>${escape(item.title)}</h5><span class="workflow-studio-chip">${escape(key==='publications'?(item.archived?'Zurückgezogen':'Veröffentlicht'):states[item.status]||item.status)}</span></div>${item.description?`<p>${escape(item.description)}</p>`:''}<dl><div><dt>Geltungsbereich</dt><dd>${escape(item.scope?.label||'Freigegebener Bereich')}</dd></div><div><dt>${key==='publications'||key==='instances'?'Version':'Gespeicherte Revision'}</dt><dd>${escape(item.versionNumber||item.revision)}</dd></div>${key==='instances'?`<div><dt>Aktueller Schritt</dt><dd>${escape(item.activeStep?.title)} · ${Number(item.activeStep?.position)} von ${Number(item.activeStep?.total)}</dd></div>`:''}</dl>${key==='legacyDefinitions'?'<small>Bestehende Definition · Leseansicht</small>':''}${key==='definitions'?`<details><summary>Gespeicherten Ablauf ansehen</summary><ol>${item.steps.map(s=>`<li><strong>${escape(s.title)}</strong><span>${s.type==='finish'?'Abschluss':s.type==='approval'?'Freigabe':'Aufgabe'} · ${s.conditionType==='optional'?'optional':'erforderlich'}</span>${s.description?`<p>${escape(s.description)}</p>`:''}</li>`).join('')}</ol></details>`:''}</article>`).join(''):`<p class="workflow-studio-empty">${needle?'Keine passenden Einträge für diese Suche.':'Noch keine freigegebenen Einträge in diesem Bereich.'}</p>`}</div></section>`;
   }).join('');results.textContent=`${visible} Treffer · ${total} Einträge in den ausgewählten Bereichen`;
   if(data.capabilities.canManage===true&&(options.canManage?.()??true)){
    const group=groups.querySelector('[aria-label="Studio-Entwürfe"]');const filtered=data.definitions.filter(item=>[item.title,item.description,item.scope?.label].some(v=>String(v||'').toLocaleLowerCase('de-AT').includes(needle)));
    for(const [index,card]of [...(group?.querySelectorAll('.workflow-studio-card')||[])].entries()){const button=host.ownerDocument.createElement('button');button.type='button';button.className='secondary-button';button.dataset.workflowEdit=filtered[index].id;button.textContent='Arbeitskopie bearbeiten';card.append(button);}
   }
   for(const key of ['publications','instances']){const group=groups.querySelector(`[aria-label="${labels[key]}"]`),filtered=data[key].filter(item=>[item.title,item.description,item.scope?.label].some(v=>String(v||'').toLocaleLowerCase('de-AT').includes(needle)));for(const [index,card]of [...(group?.querySelectorAll('.workflow-studio-card')||[])].entries()){const button=host.ownerDocument.createElement('button');button.type='button';button.className='secondary-button';button.dataset[key==='publications'?'workflowPublication':'workflowInstance']=filtered[index].id;button.textContent=key==='publications'?'Version ansehen':'Instanz ansehen';card.append(button);}}
  }
  const controller=createController({...options,onChange:render});
  if(host.ownerDocument.defaultView.GrabenplanerWorkflowStudioEditor)editor=host.ownerDocument.defaultView.GrabenplanerWorkflowStudioEditor.mount({...options,document:host.ownerDocument,catalog:()=>catalogData,catalogCurrent:()=>state.status==='ready'&&ownCatalog(),onSaved:()=>controller.load(),canUse:()=>ownCatalog()&&options.canUse()&&catalogData?.capabilities?.canManage===true&&(options.canManage?.()??true)});
  if(host.ownerDocument.defaultView.GrabenplanerWorkflowStudioRuns)runs=host.ownerDocument.defaultView.GrabenplanerWorkflowStudioRuns.mount({...options,document:host.ownerDocument,catalog:()=>catalogData,onMutation:()=>controller.load(),canUse:()=>ownCatalog()&&options.canUse()});
  newButton.addEventListener('click',()=>editor?.open(null,newButton));historyButton.addEventListener('click',()=>runs?.open('history',null,historyButton));groups.addEventListener('click',event=>{const button=event.target.closest('[data-workflow-edit],[data-workflow-publication],[data-workflow-instance]');if(button?.hasAttribute('data-workflow-edit'))editor?.open(catalogData?.definitions.find(item=>item.id===button.dataset.workflowEdit),button);else if(button?.hasAttribute('data-workflow-publication'))runs?.open('publication',button.dataset.workflowPublication,button);else if(button?.hasAttribute('data-workflow-instance'))runs?.open('instance',button.dataset.workflowInstance,button);});
  refresh.addEventListener('click',()=>controller.load());host.querySelector('[data-workflow-search]').addEventListener('input',event=>{search=event.target.value;render(state);});host.querySelector('[data-workflow-kind]').addEventListener('change',event=>{kind=event.target.value;render(state);});
  return{...controller,editor,runs,sync:()=>{host.hidden=!options.canUse();controller.sync();editor?.sync();runs?.sync();},destroy:()=>{controller.destroy();editor?.destroy();runs?.destroy();host.innerHTML='';}};
 }
 return{createController,mount};
});
