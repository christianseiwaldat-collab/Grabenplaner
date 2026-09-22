(function attachTradeInsights(host,factory){
 'use strict';
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 if(host)host.GrabenplanerTradeInsights=api;
 if(host?.location?.pathname==='/trade-insights.html')host.location.replace(api.legacyUrl(host.location.search));
})(typeof globalThis!=='undefined'?globalThis:this,function createTradeInsights(){
 'use strict';
 const tabs=Object.freeze(['purchasing','transfers','stock-summary','inventory','prices','repairs','customer-history','device-history']);
 const normalizeTab=value=>tabs.includes(value)?value:'purchasing';
 const legacyUrl=search=>'/?view=tradeInsights&section='+normalizeTab(new URLSearchParams(search).get('tab'));
 const markup=`
<div data-ti="tabs" role="tablist" aria-label="Auswertung"><button type="button" data-kind="purchasing" id="tradeInsightsTab-purchasing" role="tab" aria-selected="false" aria-controls="tradeInsightsPanel" tabindex="-1" disabled>Einkauf / Lieferstände</button><button type="button" data-kind="transfers" id="tradeInsightsTab-transfers" role="tab" aria-selected="false" aria-controls="tradeInsightsPanel" tabindex="-1" disabled>Filialversorgung</button><button type="button" data-kind="stock-summary" id="tradeInsightsTab-stock-summary" role="tab" aria-selected="false" aria-controls="tradeInsightsPanel" tabindex="-1" disabled>Filialbestand & Warenwert</button><button type="button" data-kind="inventory" id="tradeInsightsTab-inventory" role="tab" aria-selected="false" aria-controls="tradeInsightsPanel" tabindex="-1" disabled>Bestand / Langsamdreher</button><button type="button" data-kind="prices" id="tradeInsightsTab-prices" role="tab" aria-selected="false" aria-controls="tradeInsightsPanel" tabindex="-1" disabled>Filialpreisvergleich</button><button type="button" data-kind="repairs" id="tradeInsightsTab-repairs" role="tab" aria-selected="false" aria-controls="tradeInsightsPanel" tabindex="-1" disabled>Reparaturen</button><button type="button" data-kind="customer-history" id="tradeInsightsTab-customer-history" role="tab" aria-selected="false" aria-controls="tradeInsightsPanel" tabindex="-1" disabled>Kundenhistorie</button><button type="button" data-kind="device-history" id="tradeInsightsTab-device-history" role="tab" aria-selected="false" aria-controls="tradeInsightsPanel" tabindex="-1" disabled>Gerätehistorie</button></div>
<div id="tradeInsightsPanel" role="tabpanel"><form data-ti="filters"><label><span data-ti="query-label">Artikel oder Bestellnummer</span><input name="query" maxlength="150" autocomplete="off"></label><label data-customer hidden>Quellkundennummer<input name="customer" maxlength="150" autocomplete="off"></label><label data-serial hidden>Seriennummer (exakt)<input name="serial" maxlength="150" autocomplete="off"></label><label>Filiale<select name="locationId"><option value="">Alle freigegebenen Filialen</option></select></label><label data-supplier>Lieferant / Suchname<input name="supplier" maxlength="150"></label><label data-period>Von<input name="dateFrom" type="date"></label><label data-period>Bis<input name="dateTo" type="date"></label><label data-stock hidden>Beobachtung<select name="days"><option value="90">90 Tage</option><option value="180" selected>180 Tage</option><option value="365">365 Tage</option></select></label><label data-inventory hidden>Sortiment<select name="group"><option value="">Alle</option></select></label><label data-inventory hidden>Warengruppe<select name="wgr"><option value="">Alle</option></select></label><button type="submit">Suchen</button></form>
<details data-ti="classification" hidden><summary>Artikelklassifikation bearbeiten</summary><p>WGR- und Sortimentsvorgaben bestimmen, welche Artikel in Bestandskennzahlen einfließen. Artikel-Ausnahmen gehen vor. Sachkonto und „Ohne Bestand“ bleiben immer ausgeschlossen.</p><form data-ti="class-form"><label>Ebene<select name="level"><option value="wgr">Warengruppe</option><option value="assortment">Sortiment</option><option value="article">Einzelner Artikel</option></select></label><label>Eintrag<select name="groupKey"></select><input name="articleKey" hidden placeholder="Artikelnr."></label><button type="submit">Laden</button></form><form data-ti="class-save" hidden><p data-ti="class-label"></p><label>Einstufung<select name="kind"><option value="inherit">Vorgabe übernehmen</option><option value="goods">Physische Lagerware</option><option value="service">Dienstleistung</option><option value="account">Verrechnung / Zahlungsposition</option><option value="excluded">Kein Lagerbestand</option><option value="unknown">Noch ungeklärt</option></select></label><button type="submit">Einstufung speichern</button></form><p data-ti="class-status" role="status"></p></details>
<p data-ti="status" role="status" aria-live="polite">Zugriff wird geprüft …</p><p data-ti="note"></p><section data-ti="results" aria-label="Suchergebnisse"></section><button data-ti="more" type="button" hidden>Weitere Quellenpositionen prüfen</button><button data-ti="pause" type="button" hidden>Suche anhalten</button>
</div><dialog data-ti="repair-dialog" aria-label="Reparaturdetails"><form method="dialog" class="dialog-actions"><button>Schließen</button></form><div data-ti="repair-content"></div><form data-ti="repair-status-form" hidden><label>Eigener GP-Status<select name="state"><option value="unassigned">Noch nicht im GP gesetzt</option><option value="ready">Abholbereit</option><option value="collected">Abgeholt</option></select></label><button type="submit">Status speichern</button></form><p data-ti="repair-status" role="status"></p></dialog>
`;
 function mount(root,{api:request,onTabChange=()=>{}}={}){
  if(!root||typeof request!=='function')throw new TypeError('Trade insights need a workspace and the GP API.');
  root.innerHTML=markup;
  const q=key=>root.querySelector('[data-ti="'+key+'"]');
  const listeners=[],requests=new Set();
  const on=(element,type,listener)=>{element.addEventListener(type,listener);listeners.push(()=>element.removeEventListener(type,listener));};
  let active=false,disposed=false,lifecycle=0,contextPromise=null,requestedTab='purchasing',selected=false;
  const aborted=()=>Object.assign(new Error('Suche angehalten.'),{name:'AbortError'});
 const form=q('filters'),status=q('status'),results=q('results'),more=q('more'),pause=q('pause');
 let kind='purchasing',generation=0,controller=null,next=null,rows=[],query=null,scanned=0,paused=false,context=null,summary=null;
 const e=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const number=v=>v===null||v===undefined?'–':new Intl.NumberFormat('de-AT',{maximumFractionDigits:4}).format(Number(v));
 const money=v=>v==null?'–':new Intl.NumberFormat('de-AT',{style:'currency',currency:'EUR'}).format(Number(v));
 const date=v=>v?String(v).slice(0,10).split('-').reverse().join('.'):'–';
 const states={quantity_missing:'Menge fehlt',correction_or_return:'Korrektur / Rücknahme',overdelivered_quantity:'Mehr geliefert',zero_order:'Bestellmenge 0',quantity_fulfilled:'Menge geliefert',partial_quantity:'Teilmenge geliefert',undelivered_quantity:'Keine Lieferung vermerkt',transfer_processed:'Umlagerung vermerkt',transfer_requested:'Umlagerung angefordert',ordering_processed:'Bestellt',request_declined:'Abgelehnt',request_pending:'Anforderung',status_unknown:'Status ungeklärt'};
 async function api(path,body,signal){
  if(!active||disposed)throw aborted();
  const epoch=lifecycle,requestController=new AbortController();requests.add(requestController);
  const abort=()=>requestController.abort();
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  try{
   const data=await request('/api/trade-insights/'+path,{credentials:'same-origin',cache:'no-store',signal:requestController.signal,...(body?{method:'POST',body:JSON.stringify(body)}:{})});
   if(!active||disposed||epoch!==lifecycle||requestController.signal.aborted)throw aborted();
   return data;
  }catch(err){if(requestController.signal.aborted||epoch!==lifecycle)throw aborted();throw err;}
  finally{requests.delete(requestController);signal?.removeEventListener('abort',abort);}
 }
 function reset(){generation++;controller?.abort();controller=null;rows=[];next=null;query=null;scanned=0;summary=null;results.replaceChildren();more.hidden=pause.hidden=true;}
 const kinds={goods:'Lagerware',service:'Dienstleistung',account:'Verrechnung',excluded:'Ohne Lagerbestand',unknown:'Ungeklärt',inherit:'Vorgabe übernehmen'};
 function render(){
  let columns,values;
  if(['repairs','customer-history','device-history'].includes(kind)){
   columns=['Art','Datum','Beleg / Vorgang','Filiale','Kundennr.','Artikel / Gerät','Seriennummer','TradeRepair','GP-Status','Betrag'];
   values=r=>[({repair:'Reparatur',invoice:'Rechnung',offer:'Angebot',order:'Auftrag',payment:'Teilzahlung',device:'Gerät',cash:'Kassenbeleg'})[r.kind]||r.kind,date(r.date),r.documentNumber,r.sourceLocation,r.customerNumber,r.label,r.serialNumber,r.sourceStatus==='ready'?'Abholbereit':r.sourceStatus==='in_progress'?'In Bearbeitung':'–',({unassigned:'Nicht gesetzt',ready:'Abholbereit',collected:'Abgeholt'})[r.gpStatus]||'–',number(r.amount)];
  }else if(kind==='stock-summary'){
   columns=['Sortimentsgruppe','Quellpositionen','Bestätigte Lagermenge','Menge ungeklärt',...(context.projection.costs?['Warenwert netto (vorläufig)','Davon bestätigte Lagerware']:[]),'Artikel ungeklärt','Prüffälle'];
   values=r=>[r.id?(r.id+' · '+r.label):r.label,number(r.positions),number(r.confirmedQuantity),number(r.unclassifiedQuantity),...(context.projection.costs?[money(r.provisionalNet),money(r.confirmedNet)]:[]),number(r.unclassified),number(r.ambiguous+r.missingArticle+r.missingQuantity+r.negative+(r.missingCost||0)+(r.zeroCost||0))];
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
  if(!active||!context||disposed||!selected)return;
  if(!continuing){reset();query=Object.fromEntries(new FormData(form));if(!['repairs','customer-history','device-history'].includes(kind)){delete query.customer;delete query.serial;}else if(kind==='customer-history')delete query.serial;if(kind!=='purchasing')delete query.supplier;if(!['inventory','stock-summary','prices'].includes(kind)){delete query.days;delete query.group;delete query.wgr;}else if(kind==='prices'){delete query.group;delete query.wgr;}if(kind==='stock-summary'){delete query.days;delete query.dateFrom;delete query.dateTo;}}
  const ticket=generation;controller=new AbortController();paused=false;pause.disabled=false;more.hidden=true;pause.hidden=false;
  let pages=0;try{
   do{
    status.textContent=`Suche läuft · ${rows.length} Treffer · ${scanned} Quellenpositionen geprüft`;
    const data=await api(kind,{...query,...(next?{cursor:next}:{})},controller.signal);if(ticket!==generation)return;
    next=data.next;if(data.cumulative){scanned=data.scanned||0;rows=data.rows||[];}else{scanned+=data.scanned||0;rows.push(...(data.rows||[]));}q('note').textContent=data.available===false?'Noch kein vollständig übernommener Quelldatenstand vorhanden.':`${data.note||''} Datenstand: ${date(data.sourceDate)}.`;
    summary=data.totals?{...data.totals,complete:data.complete}:null;
    render();
    if(kind==='stock-summary'&&summary){
     const card=(label,value)=>`<div><small>${e(label)}</small><strong>${e(value)}</strong></div>`;
     const html=`<section class="trade-stock-summary" aria-label="Gesamtbestand"><p>${summary.complete?'Alle Quellenpositionen geprüft':'Zwischenstand – Gesamtbestand noch nicht vollständig'} · ${number(scanned)} geprüft</p><div class="facts">${card('Bestätigte Lagerpositionen',number(summary.confirmedPositions))}${card('Bestätigte Lagermenge',number(summary.confirmedQuantity))}${context.projection.costs?card('Bewerteter Warenwert netto (vorläufig)',money(summary.provisionalNet))+card('Davon bestätigte Lagerware',money(summary.confirmedNet)):''}</div><p>${number(summary.excluded)} ausgeschlossene Positionen · ${number(summary.ambiguous)} mehrdeutig · ${number(summary.missingArticle)} ohne Artikelstamm · ${number(summary.missingQuantity)} ohne Menge · ${number(summary.negative)} negative Bestände · ${number(summary.unclassified)} ungeklärte Artikelarten${context.projection.costs?` · ${number(summary.missingCost)} ohne gültigen EK · ${number(summary.zeroCost)} mit EK 0`:''}. Prüffälle können sich überschneiden. Dienstleistungen zählen nicht zum Lagerbestand. Ungeklärte Artikelarten sind nicht in der bestätigten Lagermenge enthalten. Bei offenen Prüffällen ist der Warenwert nur ein Teilwert.</p></section>`;
     results.insertAdjacentHTML('afterbegin',html);
    }
    pages++;
   }while(next&&!paused&&(kind==='stock-summary'||pages<10&&rows.length<1000));
   status.textContent=`${rows.length} ${kind==='stock-summary'?'Sortimentsgruppen':'Treffer'} · ${scanned} Quellenpositionen geprüft${next?' · Suche fortsetzbar': ' · Suche abgeschlossen'}`;
  }catch(err){if(ticket===generation&&err.name!=='AbortError')status.textContent=err.message;}
  finally{if(ticket===generation){controller=null;pause.hidden=true;more.hidden=!next||(kind!=='stock-summary'&&rows.length>=1000);if(kind!=='stock-summary'&&rows.length>=1000)status.textContent+=' · Bitte Auswahl eingrenzen.';}}
 }
 on(form.elements.days,'change',()=>{form.elements.dateFrom.value='';});
 on(form,'submit',event=>{event.preventDefault();void load();});on(form,'input',()=>{if(controller){reset();status.textContent='Auswahl geändert. Bitte neu suchen.';}});
 on(more,'click',()=>void load(true));on(pause,'click',()=>{paused=true;pause.disabled=true;});
 let metadata=null,classificationSelection=null,classGeneration=0;
 const classForm=q('class-form'),classSave=q('class-save'),classStatus=q('class-status');
 function option(label,value){const item=root.ownerDocument.createElement('option');item.textContent=label;item.value=value;return item;}
 function options(select,entries,empty=true){select.replaceChildren();if(empty)select.add(option('Alle',''));for(const r of entries)select.add(option(r.id+' · '+r.label,r.id));}
 function classChanged(){classGeneration++;classificationSelection=null;classSave.hidden=true;const level=classForm.elements.level.value;
  classForm.elements.articleKey.hidden=level!=='article';classForm.elements.groupKey.hidden=level==='article';options(classForm.elements.groupKey,level==='wgr'?metadata?.wgr||[]:metadata?.groups||[],false);classStatus.textContent='';}
 async function choose(button,{replace=false}={}){
  cancelPending();reset();selected=true;kind=button.dataset.kind;
  for(const b of root.querySelectorAll('[data-kind]')){const chosen=b===button;b.classList.toggle('active',chosen);b.setAttribute('aria-selected',String(chosen));b.tabIndex=chosen?0:-1;}
  q('filters').parentElement.setAttribute('aria-labelledby',button.id);
  onTabChange(kind,{replace});
  root.querySelector('[data-customer]').hidden=!['repairs','customer-history','device-history'].includes(kind);root.querySelector('[data-serial]').hidden=!['repairs','device-history'].includes(kind);form.elements.customer.required=kind==='customer-history';form.elements.serial.required=kind==='device-history';
   root.querySelector('[data-supplier]').hidden=kind!=='purchasing';const stock=['inventory','stock-summary','prices'].includes(kind);form.elements.locationId.required=kind==='stock-summary';
   function locationOptions(){const select=form.elements.locationId,previous=select.value,items=kind==='stock-summary'?(metadata?.stockLocations||[]):context.locations||[];
    select.replaceChildren(option(kind==='stock-summary'?'Filiale wählen':'Alle freigegebenen Filialen',''));for(const l of items)select.add(option(l.label,l.id));select.value=items.some(l=>l.id===previous)?previous:'';}
   locationOptions();
  root.querySelectorAll('[data-stock]').forEach(n=>n.hidden=!stock||kind==='stock-summary');root.querySelectorAll('[data-inventory]').forEach(n=>n.hidden=!['inventory','stock-summary'].includes(kind));root.querySelectorAll('[data-period]').forEach(n=>n.hidden=kind==='stock-summary');
  q('classification').hidden=kind!=='inventory'||!context.projection.classify;
  q('query-label').textContent=kind==='prices'?'Exakte Artikelnr.':['inventory','stock-summary'].includes(kind)?'Artikelnr. oder Bezeichnung':kind==='purchasing'?'Artikel oder Bestellnummer':'Artikel oder Vorgangsnummer';form.elements.query.required=kind==='prices';
  status.textContent='Suchangaben wählen und Suche starten.';q('note').textContent='';
  if(stock&&!metadata){const ticket=generation;try{const data=await api(kind==='stock-summary'?'stock-summary-metadata':'stock-metadata',{});if(ticket!==generation)return;metadata=data;
   options(form.elements.group,data.groups);options(form.elements.wgr,data.wgr);locationOptions();classChanged();if(!form.elements.dateTo.value)form.elements.dateTo.value=data.cashPeriod?.dateTo||context.today;
  }catch(err){if(ticket===generation&&err.name!=='AbortError')status.textContent=err.message;}}
 }
 on(q('tabs'),'click',event=>{const button=event.target.closest('[data-kind]');if(button&&!button.disabled&&active&&context)void choose(button);});
 on(classForm.elements.level,'change',classChanged);on(classForm,'input',()=>{classGeneration++;classificationSelection=null;classSave.hidden=true;});
 on(classForm,'submit',async event=>{event.preventDefault();const ticket=++classGeneration;const level=classForm.elements.level.value,key=level==='article'?classForm.elements.articleKey.value.trim():classForm.elements.groupKey.value;
  classSave.hidden=true;try{const data=await api('classification',{level,key});if(ticket!==classGeneration)return;classificationSelection=data;classSave.elements.kind.value=data.value?.kind||'inherit';q('class-label').textContent=data.key+' · '+data.label;classSave.hidden=false;classStatus.textContent='';}catch(err){if(ticket===classGeneration&&err.name!=='AbortError')classStatus.textContent=err.message;}});
 on(classSave,'submit',async event=>{event.preventDefault();if(!classificationSelection)return;const selected=classificationSelection,ticket=++classGeneration;const button=classSave.querySelector('button');button.disabled=true;
  try{const data=await api('classification-save',{level:selected.level,key:selected.key,expectedRevision:selected.revision,kind:classSave.elements.kind.value});if(ticket!==classGeneration)return;classificationSelection=data;classStatus.textContent='Einstufung gespeichert. Eine neue Suche berücksichtigt die Änderung.';reset();}catch(err){if(ticket===classGeneration&&err.name!=='AbortError')classStatus.textContent=err.message;}finally{button.disabled=false;}});
 const repairDialog=q('repair-dialog'),repairForm=q('repair-status-form'),repairStatus=q('repair-status');let repairSelection=null,repairGeneration=0;
 function renderRepair(r){q('repair-content').innerHTML=`<h2>Reparatur ${e(r.documentNumber)}</h2><div class="facts"><div><small>Filiale / Kunde</small>${e(r.sourceLocation)} / ${e(r.customerNumber||'–')}</div><div><small>Gerät / Seriennr.</small>${e(r.label)} · ${e(r.serialNumber||'–')}</div><div><small>TradeRepair</small>${r.sourceStatus==='ready'?'Abholbereit':'In Bearbeitung'}</div><div><small>Eigener GP-Status</small>${e(({unassigned:'Noch nicht gesetzt',ready:'Abholbereit',collected:'Abgeholt'})[r.gpStatus])}</div></div><h3>Fehlerbeschreibung</h3><p class="long-text">${e(r.description||'–')}</p><h3>Durchgeführte Arbeiten</h3><p class="long-text">${e(r.work||'–')}</p><h3>Bemerkung</h3><p class="long-text">${e(r.note||'–')}</p><p>${e(r.noteStatus)}</p><p>Datenstand: ${date(r.sourceDate)}</p>`;
  repairForm.hidden=!context.projection.repairWrite;repairForm.elements.state.value=r.gpStatus;}
 on(results,'click',async event=>{const button=event.target.closest('[data-repair]');if(!button)return;const ticket=++repairGeneration;repairSelection=null;repairForm.hidden=true;repairStatus.textContent='Reparatur wird geladen …';q('repair-content').replaceChildren();repairDialog.showModal();
  try{const data=await api('repair-detail',{id:button.dataset.repair});if(ticket!==repairGeneration)return;repairSelection=data;renderRepair(data);repairStatus.textContent='';}catch(err){if(ticket===repairGeneration&&err.name!=='AbortError')repairStatus.textContent=err.message;}});
 on(repairDialog,'close',()=>{repairGeneration++;repairSelection=null;});
 on(repairForm,'submit',async event=>{event.preventDefault();if(!repairSelection)return;const selected=repairSelection,ticket=++repairGeneration,button=repairForm.querySelector('button');button.disabled=true;
  try{const data=await api('repair-save',{id:selected.id,state:repairForm.elements.state.value,expectedRevision:selected.revision});if(ticket!==repairGeneration)return;repairSelection=data;renderRepair(data);repairStatus.textContent='GP-Status gespeichert.';const row=rows.find(r=>r.id===data.id);if(row){Object.assign(row,data);render();}next=null;more.hidden=true;}catch(err){if(ticket===repairGeneration&&err.name!=='AbortError')repairStatus.textContent=err.message;}finally{button.disabled=false;}});

 function cancelPending(){
  lifecycle++;generation++;classGeneration++;repairGeneration++;
  for(const pending of requests)pending.abort();requests.clear();
  controller?.abort();controller=null;contextPromise=null;
  classificationSelection=null;classSave.hidden=true;repairSelection=null;
  if(repairDialog.open)repairDialog.close();
  pause.hidden=true;
 }
 function suspend(){
  if(!active)return;
  const searching=!!controller;active=false;cancelPending();
  if(searching){status.textContent='Suche angehalten. Auswahl prüfen und neu suchen oder fortsetzen.';more.hidden=!next||(kind!=='stock-summary'&&rows.length>=1000);}
 }
 async function activate(tab=requestedTab){
  if(disposed)return;active=true;requestedTab=normalizeTab(tab);
  if(!context){
   if(contextPromise)return contextPromise;
   const epoch=lifecycle;
   status.textContent='Zugriff wird geprüft …';form.querySelector('button').disabled=true;
   const pending=api('context').then(data=>{
    context=data;
    for(const b of root.querySelectorAll('[data-kind]')){
     b.disabled=!data.projection?.[['inventory','stock-summary','prices'].includes(b.dataset.kind)?'inventory':b.dataset.kind==='repairs'?'repairs':['customer-history','device-history'].includes(b.dataset.kind)?'customers':'purchasing'];
    }
    form.elements.locationId.replaceChildren(option('Alle freigegebenen Filialen',''));
    for(const l of data.locations||[])form.elements.locationId.add(option(l.label,l.id));
    return activate(requestedTab);
   }).catch(err=>{if(active&&!disposed&&epoch===lifecycle&&err.name!=='AbortError')status.textContent=err.message;})
    .finally(()=>{if(contextPromise===pending)contextPromise=null;});
   contextPromise=pending;return pending;
  }
  const allowed=[...root.querySelectorAll('[data-kind]')].filter(b=>!b.disabled);
  const button=allowed.find(b=>b.dataset.kind===requestedTab)||allowed[0];
  form.querySelector('button').disabled=!button;
  if(!button){status.textContent='Für diese Auswertungen fehlt die Freigabe.';return;}
  if(!selected||button.dataset.kind!==kind||(['inventory','stock-summary','prices'].includes(kind)&&!metadata))await choose(button,{replace:button.dataset.kind!==requestedTab});
  else if(kind!==requestedTab)onTabChange(kind,{replace:true});
 }
 on(q('tabs'),'keydown',event=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  const allowed=[...root.querySelectorAll('[data-kind]')].filter(b=>!b.disabled),current=allowed.indexOf(event.target);
  if(current<0)return;event.preventDefault();
  const index=event.key==='Home'?0:event.key==='End'?allowed.length-1:(current+(event.key==='ArrowRight'?1:-1)+allowed.length)%allowed.length;
  allowed[index].focus();void choose(allowed[index]);
 });
 return {activate,suspend,getTab:()=>kind,destroy(){if(disposed)return;suspend();disposed=true;for(const remove of listeners)remove();root.replaceChildren();}};
 }
 return {mount,normalizeTab,legacyUrl,tabs};
});
