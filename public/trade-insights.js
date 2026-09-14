/* global document, fetch, URLSearchParams */
'use strict';
(()=>{
 const form=document.getElementById('filters'),status=document.getElementById('status'),results=document.getElementById('results'),more=document.getElementById('more'),pause=document.getElementById('pause');
 let kind='purchasing',generation=0,controller=null,next=null,rows=[],query=null,scanned=0,paused=false,context=null;
 const e=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const number=v=>v===null||v===undefined?'–':new Intl.NumberFormat('de-AT',{maximumFractionDigits:4}).format(Number(v));
 const date=v=>v?String(v).slice(0,10).split('-').reverse().join('.'):'–';
 const states={quantity_missing:'Menge fehlt',correction_or_return:'Korrektur / Rücknahme',overdelivered_quantity:'Mehr geliefert',zero_order:'Bestellmenge 0',quantity_fulfilled:'Menge geliefert',partial_quantity:'Teilmenge geliefert',undelivered_quantity:'Keine Lieferung vermerkt',transfer_processed:'Umlagerung vermerkt',transfer_requested:'Umlagerung angefordert',ordering_processed:'Bestellt',request_declined:'Abgelehnt',request_pending:'Anforderung',status_unknown:'Status ungeklärt'};
 async function api(path,body,signal){const csrf=document.cookie.split('; ').find(v=>v.startsWith('grabenplaner_csrf='))?.slice('grabenplaner_csrf='.length)||'';
  const res=await fetch('/api/trade-insights/'+path,{credentials:'same-origin',cache:'no-store',signal,...(body?{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':decodeURIComponent(csrf)},body:JSON.stringify(body)}:{})});
  const data=await res.json();if(!res.ok)throw new Error(data.error||'Bitte im GP anmelden.');return data;}
 function reset(){generation++;controller?.abort();controller=null;rows=[];next=null;query=null;scanned=0;results.replaceChildren();more.hidden=pause.hidden=true;}
 const navigation=window.GrabenplanerNavigationHistory.create({window,app:'trade-insights',keys:['tab'],read:()=>({tab:kind}),enabled:()=>!!context,apply:()=>{const tab=new URLSearchParams(location.search).get('tab');const button=[...document.querySelectorAll('[data-kind]')].find(b=>b.dataset.kind===tab&&!b.disabled);if(button)void choose(button);}});
 const kinds={goods:'Lagerware',service:'Dienstleistung',account:'Verrechnung',excluded:'Ohne Lagerbestand',unknown:'Ungeklärt',inherit:'Vorgabe übernehmen'};
 function render(){
  let columns,values;
  if(['repairs','customer-history','device-history'].includes(kind)){
   columns=['Art','Datum','Beleg / Vorgang','Filiale','Kundennr.','Artikel / Gerät','Seriennummer','TradeRepair','GP-Status','Betrag'];
   values=r=>[({repair:'Reparatur',invoice:'Rechnung',offer:'Angebot',order:'Auftrag',payment:'Teilzahlung',device:'Gerät',cash:'Kassenbeleg'})[r.kind]||r.kind,date(r.date),r.documentNumber,r.sourceLocation,r.customerNumber,r.label,r.serialNumber,r.sourceStatus==='ready'?'Abholbereit':r.sourceStatus==='in_progress'?'In Bearbeitung':'–',({unassigned:'Nicht gesetzt',ready:'Abholbereit',collected:'Abgeholt'})[r.gpStatus]||'–',number(r.amount)];
  }else if(kind==='inventory'){
   columns=['Artikelnr.','Bezeichnung','Filiale','Bestand','Einstufung','Nettoabsatz','Ohne Verkauf','Reichweite (Tage)',...(context.projection.costs?['Ø EK netto','Bestandswert netto']:[]),'Einordnung'];
   values=r=>[r.articleNumber,r.label,r.sourceLocation,number(r.stock),kinds[r.classification.kind],number(r.soldNet),r.noRecordedSale===null?'–':r.noRecordedSale?'Ja':'Nein',number(r.coverageDays),...(context.projection.costs?[number(r.purchaseNet),number(r.stockValue)]:[]),r.reason];
  }else if(kind==='prices'){
   columns=['Artikelnr.','Filiale','Steuerkennzeichen','Menge','Niedrigster Einzelpreis','Höchster Einzelpreis','Gewichteter Einzelpreis'];
   values=r=>[r.articleNumber,r.branch,r.vat,number(r.quantity),number(r.min),number(r.max),number(r.average)];
  }else{
   const purchasing=kind==='purchasing';columns=purchasing?['Datum','Bestellung','Artikelnr.','Bezeichnung','Filiale','Lieferant','Bestellt','Geliefert kum.','Differenz','Quellstatus']:['Datum','Artikelnr.','Bezeichnung','Nach Filiale','Von Filiale','Menge','Quellstatus'];
   values=r=>[date(r.date),...(purchasing?[r.orderNumber]:[]),r.articleNumber,r.label,r.sourceLocation,...(purchasing?[r.supplier||'Nicht zugeordnet',number(r.ordered),number(r.deliveredCumulative),number(r.rawDifference)]:[r.from||'–',number(r.quantity)]),states[r.state]||r.state];
  }
  results.innerHTML=rows.length?`<div class="table-scroll"><table><thead><tr>${columns.map(c=>`<th>${e(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${values(r).map((v,i)=>`<td>${i===0&&r.kind==='repair'?`<button type="button" data-repair="${e(r.id)}">Reparatur öffnen</button>`:e(v??'–')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`:'';
 }
 async function load(continuing=false){
  if(!continuing){reset();query=Object.fromEntries(new FormData(form));if(!['repairs','customer-history','device-history'].includes(kind)){delete query.customer;delete query.serial;}else if(kind==='customer-history')delete query.serial;if(kind!=='purchasing')delete query.supplier;if(!['inventory','prices'].includes(kind)){delete query.days;delete query.group;delete query.wgr;}else if(kind==='prices'){delete query.group;delete query.wgr;}}
  const ticket=generation;controller=new AbortController();paused=false;pause.disabled=false;more.hidden=true;pause.hidden=false;
  let pages=0;try{
   do{
    status.textContent=`Suche läuft · ${rows.length} Treffer · ${scanned} Quellenpositionen geprüft`;
    const data=await api(kind,{...query,...(next?{cursor:next}:{})},controller.signal);if(ticket!==generation)return;
    next=data.next;if(data.cumulative){scanned=data.scanned||0;rows=data.rows||[];}else{scanned+=data.scanned||0;rows.push(...(data.rows||[]));}document.getElementById('note').textContent=data.available===false?'Noch kein vollständig übernommener Quelldatenstand vorhanden.':`${data.note||''} Datenstand: ${date(data.sourceDate)}.`;
    render();pages++;
   }while(next&&!paused&&pages<10&&rows.length<1000);
   status.textContent=`${rows.length} Treffer · ${scanned} Quellenpositionen geprüft${next?' · Suche fortsetzbar': ' · Suche abgeschlossen'}`;
  }catch(err){if(ticket===generation&&err.name!=='AbortError')status.textContent=err.message;}
  finally{if(ticket===generation){controller=null;pause.hidden=true;more.hidden=!next||rows.length>=1000;if(rows.length>=1000)status.textContent+=' · Bitte Auswahl eingrenzen.';}}
 }
 form.elements.days.addEventListener('change',()=>{form.elements.dateFrom.value='';});
 form.addEventListener('submit',event=>{event.preventDefault();void load();});form.addEventListener('input',()=>{if(controller){reset();status.textContent='Auswahl geändert. Bitte neu suchen.';}});
 more.addEventListener('click',()=>void load(true));pause.addEventListener('click',()=>{paused=true;pause.disabled=true;});
 let metadata=null,classificationSelection=null,classGeneration=0;
 const classForm=document.getElementById('class-form'),classSave=document.getElementById('class-save'),classStatus=document.getElementById('class-status');
 function options(select,entries,empty=true){select.replaceChildren();if(empty)select.add(new Option('Alle',''));for(const r of entries)select.add(new Option(r.id+' · '+r.label,r.id));}
 function classChanged(){classGeneration++;classificationSelection=null;classSave.hidden=true;const level=classForm.elements.level.value;
  classForm.elements.articleKey.hidden=level!=='article';classForm.elements.groupKey.hidden=level==='article';options(classForm.elements.groupKey,level==='wgr'?metadata?.wgr||[]:metadata?.groups||[],false);classStatus.textContent='';}
 async function choose(button){reset();kind=button.dataset.kind;navigation.record();document.querySelectorAll('[data-kind]').forEach(b=>b.classList.toggle('active',b===button));
  document.querySelector('[data-customer]').hidden=!['repairs','customer-history','device-history'].includes(kind);document.querySelector('[data-serial]').hidden=!['repairs','device-history'].includes(kind);form.elements.customer.required=kind==='customer-history';form.elements.serial.required=kind==='device-history';
  document.querySelector('[data-supplier]').hidden=kind!=='purchasing';const stock=['inventory','prices'].includes(kind);
  document.querySelectorAll('[data-stock]').forEach(n=>n.hidden=!stock);document.querySelectorAll('[data-inventory]').forEach(n=>n.hidden=kind!=='inventory');
  document.getElementById('classification').hidden=kind!=='inventory'||!context.projection.classify;
  document.getElementById('query-label').textContent=kind==='prices'?'Exakte Artikelnr.':kind==='inventory'?'Artikelnr. oder Bezeichnung':kind==='purchasing'?'Artikel oder Bestellnummer':'Artikel oder Vorgangsnummer';form.elements.query.required=kind==='prices';
  status.textContent='Suchangaben wählen und Suche starten.';document.getElementById('note').textContent='';
  if(stock&&!metadata){const ticket=generation;try{const data=await api('stock-metadata',{});if(ticket!==generation)return;metadata=data;
   options(form.elements.group,data.groups);options(form.elements.wgr,data.wgr);classChanged();if(!form.elements.dateTo.value)form.elements.dateTo.value=data.cashPeriod?.dateTo||context.today;
  }catch(err){status.textContent=err.message;}}
 }
 document.getElementById('tabs').addEventListener('click',event=>{const button=event.target.closest('[data-kind]');if(button&&!button.disabled)void choose(button);});
 classForm.elements.level.addEventListener('change',classChanged);classForm.addEventListener('input',()=>{classGeneration++;classificationSelection=null;classSave.hidden=true;});
 classForm.addEventListener('submit',async event=>{event.preventDefault();const ticket=++classGeneration;const level=classForm.elements.level.value,key=level==='article'?classForm.elements.articleKey.value.trim():classForm.elements.groupKey.value;
  classSave.hidden=true;try{const data=await api('classification',{level,key});if(ticket!==classGeneration)return;classificationSelection=data;classSave.elements.kind.value=data.value?.kind||'inherit';document.getElementById('class-label').textContent=data.key+' · '+data.label;classSave.hidden=false;classStatus.textContent='';}catch(err){if(ticket===classGeneration)classStatus.textContent=err.message;}});
 classSave.addEventListener('submit',async event=>{event.preventDefault();if(!classificationSelection)return;const selected=classificationSelection,ticket=++classGeneration;const button=classSave.querySelector('button');button.disabled=true;
  try{const data=await api('classification-save',{level:selected.level,key:selected.key,expectedRevision:selected.revision,kind:classSave.elements.kind.value});if(ticket!==classGeneration)return;classificationSelection=data;classStatus.textContent='Einstufung gespeichert. Eine neue Suche berücksichtigt die Änderung.';reset();}catch(err){if(ticket===classGeneration)classStatus.textContent=err.message;}finally{button.disabled=false;}});
 const repairDialog=document.getElementById('repair-dialog'),repairForm=document.getElementById('repair-status-form'),repairStatus=document.getElementById('repair-status');let repairSelection=null,repairGeneration=0;
 function renderRepair(r){document.getElementById('repair-content').innerHTML=`<h2>Reparatur ${e(r.documentNumber)}</h2><div class="facts"><div><small>Filiale / Kunde</small>${e(r.sourceLocation)} / ${e(r.customerNumber||'–')}</div><div><small>Gerät / Seriennr.</small>${e(r.label)} · ${e(r.serialNumber||'–')}</div><div><small>TradeRepair</small>${r.sourceStatus==='ready'?'Abholbereit':'In Bearbeitung'}</div><div><small>Eigener GP-Status</small>${e(({unassigned:'Noch nicht gesetzt',ready:'Abholbereit',collected:'Abgeholt'})[r.gpStatus])}</div></div><h3>Fehlerbeschreibung</h3><p class="long-text">${e(r.description||'–')}</p><h3>Durchgeführte Arbeiten</h3><p class="long-text">${e(r.work||'–')}</p><h3>Bemerkung</h3><p class="long-text">${e(r.note||'–')}</p><p>${e(r.noteStatus)}</p><p>Datenstand: ${date(r.sourceDate)}</p>`;
  repairForm.hidden=!context.projection.repairWrite;repairForm.elements.state.value=r.gpStatus;}
 results.addEventListener('click',async event=>{const button=event.target.closest('[data-repair]');if(!button)return;const ticket=++repairGeneration;repairSelection=null;repairForm.hidden=true;repairStatus.textContent='Reparatur wird geladen …';document.getElementById('repair-content').replaceChildren();repairDialog.showModal();
  try{const data=await api('repair-detail',{id:button.dataset.repair});if(ticket!==repairGeneration)return;repairSelection=data;renderRepair(data);repairStatus.textContent='';}catch(err){if(ticket===repairGeneration)repairStatus.textContent=err.message;}});
 repairDialog.addEventListener('close',()=>{repairGeneration++;repairSelection=null;});
 repairForm.addEventListener('submit',async event=>{event.preventDefault();if(!repairSelection)return;const selected=repairSelection,ticket=++repairGeneration,button=repairForm.querySelector('button');button.disabled=true;
  try{const data=await api('repair-save',{id:selected.id,state:repairForm.elements.state.value,expectedRevision:selected.revision});if(ticket!==repairGeneration)return;repairSelection=data;renderRepair(data);repairStatus.textContent='GP-Status gespeichert.';const row=rows.find(r=>r.id===data.id);if(row){Object.assign(row,data);render();}next=null;more.hidden=true;}catch(err){if(ticket===repairGeneration)repairStatus.textContent=err.message;}finally{button.disabled=false;}});
 api('context').then(data=>{context=data;for(const b of document.querySelectorAll('[data-kind]'))b.disabled=!data.projection?.[['inventory','prices'].includes(b.dataset.kind)?'inventory':b.dataset.kind==='repairs'?'repairs':['customer-history','device-history'].includes(b.dataset.kind)?'customers':'purchasing'];
  for(const l of data.locations||[]){const option=document.createElement('option');option.value=l.id;option.textContent=l.label;form.elements.locationId.append(option);}
  const allowed=[...document.querySelectorAll('[data-kind]')].filter(b=>!b.disabled),tab=new URLSearchParams(location.search).get('tab'),first=allowed.find(b=>b.dataset.kind===tab)||allowed[0];if(first)void choose(first).then(()=>navigation.start());else{status.textContent='Für diese Auswertungen fehlt die Freigabe.';form.querySelector('button').disabled=true;}
 }).catch(err=>{status.textContent=err.message;form.querySelector('button').disabled=true;});
})();
