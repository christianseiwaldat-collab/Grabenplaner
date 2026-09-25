(function attachTradeInsights(host,factory){
 'use strict';
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 if(host)host.GrabenplanerTradeInsights=api;
 if(host?.location?.pathname==='/trade-insights.html')host.location.replace(api.legacyUrl(host.location.search));
})(typeof globalThis!=='undefined'?globalThis:this,function createTradeInsights(){
 'use strict';
 const tabs=Object.freeze(['purchasing','transfers','movements','stock-summary','inventory','stocktakes','suggestions','article-history','repairs','customer-history','device-history']);
 const model=typeof module==='object'&&module.exports?require('./trade-insight-results'):globalThis.GrabenplanerTradeResults;
 const normalizeTab=value=>tabs.includes(value)?value:'purchasing';
 const legacyUrl=search=>'/?view=tradeInsights&section='+normalizeTab(new URLSearchParams(search).get('tab'));
 const markup=`
<div data-ti="tabs" role="tablist" aria-label="Auswertung"><button type="button" data-kind="purchasing" id="tradeInsightsTab-purchasing" role="tab" aria-selected="false" aria-controls="tradeInsightsPanel" tabindex="-1" disabled>Einkauf / Lieferstände</button><button type="button" data-kind="transfers" id="tradeInsightsTab-transfers" role="tab" aria-selected="false" aria-controls="tradeInsightsPanel" tabindex="-1" disabled>Filialversorgung</button><button type="button" data-kind="movements" id="tradeInsightsTab-movements" role="tab" aria-selected="false" aria-controls="tradeInsightsPanel" tabindex="-1" disabled>Warenbewegungen</button><button type="button" data-kind="stock-summary" id="tradeInsightsTab-stock-summary" role="tab" aria-selected="false" aria-controls="tradeInsightsPanel" tabindex="-1" disabled>Filialbestand & Warenwert</button><button type="button" data-kind="inventory" id="tradeInsightsTab-inventory" role="tab" aria-selected="false" aria-controls="tradeInsightsPanel" tabindex="-1" disabled>Bestand / Langsamdreher</button><button type="button" data-kind="repairs" id="tradeInsightsTab-repairs" role="tab" aria-selected="false" aria-controls="tradeInsightsPanel" tabindex="-1" disabled>Reparaturen</button><button type="button" data-kind="customer-history" id="tradeInsightsTab-customer-history" role="tab" aria-selected="false" aria-controls="tradeInsightsPanel" tabindex="-1" disabled>Kundenhistorie</button><button type="button" data-kind="device-history" id="tradeInsightsTab-device-history" role="tab" aria-selected="false" aria-controls="tradeInsightsPanel" tabindex="-1" disabled>Gerätehistorie</button></div>
<div id="tradeInsightsPanel" role="tabpanel"><header data-ti="movement-intro" class="movement-intro" hidden><h2>Warenbewegungen</h2><p>Wareneingänge und Umlagerungen aus WEUM. Buchungen prüfen, Artikelwege nachvollziehen und einen Ergebnisstand speichern.</p><p data-ti="movement-source"></p></header><header data-ti="inventory-intro" hidden><h2>Inventuren &amp; Differenzen</h2><p>Inventuren je Filiale vergleichen und Mengenabweichungen nachvollziehen. Vollständige Zählwerte in der Übersicht, verdichtete Prüffälle in den Details.</p></header><header data-ti="suggestions-intro" hidden><h2>Handlungsvorschläge</h2><p>Bestand und Verkäufe zusammen betrachten: mögliche Umlagerungen, Nachbeschaffung und Bestandsabbau nachvollziehbar prüfen.</p><p>Aktualitätsregel: Bestand maximal 7 Tage alt, Verkaufsende maximal 7 Tage davor, mindestens 28 Tage Beobachtung. Ohne Auswahl werden 90 Tage bis zum gemeinsamen Datenende verwendet.</p></header><form data-ti="filters"><label><span data-ti="query-label">Artikel oder Bestellnummer</span><input name="query" maxlength="150" autocomplete="off"></label><label data-article-exact hidden>Artikelnummer (exakt)<input name="articleNumber" maxlength="150" autocomplete="off"></label><label data-movement hidden>Bewegungsart<select name="movementType"><option value="">Alle Bewegungen</option><option value="receipt">Wareneingang</option><option value="transfer">Umlagerung</option><option value="unclear">Art ungeklärt</option></select></label><label data-movement hidden>Prüffilter<select name="review"><option value="">Alle Buchungen</option><option value="issues">Mit Prüfhinweis</option><option value="negative">Negative Mengen</option><option value="missing_date">Ohne Buchungsdatum</option></select></label><label data-suggestion-filter hidden>Hinweisart<select name="suggestionType"><option value="">Alle Hinweise</option><option value="transfer">Umlagerung prüfen</option><option value="restock">Nachbeschaffung prüfen</option><option value="incoming">Zulauf abgleichen</option><option value="clearance">Bestandsabbau prüfen</option><option value="blocked">Datengrundlage prüfen</option></select></label><input name="stocktakeId" type="hidden"><input name="stocktakeVersion" type="hidden"><input name="stocktakeSource" type="hidden"><label data-stocktake-difference hidden>Abweichung<select name="difference"><option value="">Alle Abweichungen</option><option value="positive">Mehrbestand</option><option value="negative">Minderbestand</option><option value="incomplete">Mengen unvollständig</option><option value="inconsistent">Mengenrechnung prüfen</option></select></label><label data-customer hidden>Quellkundennummer<input name="customer" maxlength="150" autocomplete="off"></label><label data-serial hidden>Seriennummer (exakt)<input name="serial" maxlength="150" autocomplete="off"></label><label>Filiale<select name="locationId"><option value="">Alle freigegebenen Filialen</option></select></label><label data-supplier>Lieferant / Suchname<input name="supplier" maxlength="150"></label><div data-period class="trade-period-field"><span>Zeitraum</span><button type="button" data-ti="period">Zeitraum auswählen</button><input name="dateFrom" type="hidden"><input name="dateTo" type="hidden"></div><label data-stock hidden>Beobachtung<select name="days"><option value="90">90 Tage</option><option value="180" selected>180 Tage</option><option value="365">365 Tage</option></select></label><label data-inventory hidden>Sortiment<select name="group"><option value="">Alle</option></select></label><label data-inventory hidden>Warengruppe<select name="wgr"><option value="">Alle</option></select></label><label>Ergebnisname (optional)<input name="resultTitle" maxlength="120" placeholder="z. B. Monatsbestand September"></label><button type="submit">Suche starten & Ergebnis speichern</button></form><button type="button" data-ti="movement-filter-toggle" hidden>Suchfilter anzeigen</button><p class="trade-job-hint">Die Suche läuft am Server weiter, während du im GP weiterarbeitest. Fertige Ergebnisse werden automatisch gespeichert.</p><details data-ti="archive" open><summary>Gespeicherte Ergebnisse & laufende Suchen <span data-ti="job-count"></span></summary><p data-ti="job-status" role="status"></p><div data-ti="jobs"></div></details><form data-ti="snapshot" hidden><label>Gespeichertes Ergebnis<input name="title" maxlength="120" required></label><button type="submit">Name speichern</button><a data-ti="pdf" class="trade-pdf-link">PDF exportieren</a><p data-ti="snapshot-info"></p></form>
<details data-ti="classification" hidden><summary>Artikelklassifikation bearbeiten</summary><p>WGR- und Sortimentsvorgaben bestimmen, welche Artikel in Bestandskennzahlen einfließen. Artikel-Ausnahmen gehen vor. Sachkonto und „Ohne Bestand“ bleiben immer ausgeschlossen.</p><form data-ti="class-form"><label>Ebene<select name="level"><option value="wgr">Warengruppe</option><option value="assortment">Sortiment</option><option value="article">Einzelner Artikel</option></select></label><label>Eintrag<select name="groupKey"></select><input name="articleKey" hidden placeholder="Artikelnr."></label><button type="submit">Laden</button></form><form data-ti="class-save" hidden><p data-ti="class-label"></p><label>Einstufung<select name="kind"><option value="inherit">Vorgabe übernehmen</option><option value="goods">Physische Lagerware</option><option value="service">Dienstleistung</option><option value="account">Verrechnung / Zahlungsposition</option><option value="excluded">Kein Lagerbestand</option><option value="unknown">Noch ungeklärt</option></select></label><button type="submit">Einstufung speichern</button></form><p data-ti="class-status" role="status"></p></details>
<p data-ti="status" role="status" aria-live="polite">Zugriff wird geprüft …</p><p data-ti="note"></p><section data-ti="results" aria-label="Suchergebnisse"></section>
</div><dialog data-ti="movement-dialog" aria-labelledby="movementDetailTitle"><form method="dialog" class="dialog-actions"><button>Schließen</button></form><div data-ti="movement-content"></div></dialog><dialog data-ti="repair-dialog" aria-label="Reparaturdetails"><form method="dialog" class="dialog-actions"><button>Schließen</button></form><div data-ti="repair-content"></div><form data-ti="repair-status-form" hidden><label>Eigener GP-Status<select name="state"><option value="unassigned">Noch nicht im GP gesetzt</option><option value="ready">Abholbereit</option><option value="collected">Abgeholt</option></select></label><button type="submit">Status speichern</button></form><p data-ti="repair-status" role="status"></p></dialog>
`;
 function mount(root,{api:request,onTabChange=()=>{}}={}){
  if(!root||typeof request!=='function')throw new TypeError('Trade insights need a workspace and the GP API.');
  root.innerHTML=markup;
  const q=key=>root.querySelector('[data-ti="'+key+'"]');
  q('tabs').insertAdjacentHTML('beforeend','<button type="button" data-kind="article-history" id="tradeInsightsTab-article-history" role="tab" aria-selected="false" aria-controls="tradeArticleHistoryPanel" tabindex="-1" disabled>Artikelhistorie</button>');
  root.insertAdjacentHTML('beforeend','<section id="tradeArticleHistoryPanel" data-ti="article-history" class="article-history-workspace" role="tabpanel" aria-labelledby="tradeInsightsTab-article-history" hidden></section>');
  q('tabs').insertAdjacentHTML('beforeend','<button type="button" data-kind="stocktakes" id="tradeInsightsTab-stocktakes" role="tab" aria-selected="false" aria-controls="tradeInsightsPanel" tabindex="-1" disabled>Inventuren &amp; Differenzen</button>');
  q('tabs').insertAdjacentHTML('beforeend','<button type="button" data-kind="suggestions" id="tradeInsightsTab-suggestions" role="tab" aria-selected="false" aria-controls="tradeInsightsPanel" tabindex="-1" disabled>Handlungsvorschläge</button>');
  const historyPanel=q('article-history');
  const historyModule=typeof module==='object'&&module.exports?require('./trade-article-history'):globalThis.GrabenplanerArticleHistory;
  let articleHistory=null,movementSelection=null,movementVisited=false;
  const movementModule=typeof module==='object'&&module.exports?require('./trade-movements'):globalThis.GrabenplanerMovements;
  const listeners=[],requests=new Set();
  const on=(element,type,listener)=>{element.addEventListener(type,listener);listeners.push(()=>element.removeEventListener(type,listener));};
  for(const select of root.querySelectorAll('select')){if(!select.options)continue;const chosen=select.value;select.replaceChildren(...[...select.options].sort((a,b)=>model.collator.compare(a.textContent,b.textContent)));select.value=chosen;}
  let active=false,disposed=false,lifecycle=0,contextPromise=null,requestedTab='purchasing',selected=false;
  const aborted=()=>Object.assign(new Error('Suche angehalten.'),{name:'AbortError'});
 const form=q('filters'),status=q('status'),results=q('results');
 const periodModule=typeof module==='object'&&module.exports?require('./trade-period'):globalThis.GrabenplanerTradePeriod;
 const stocktakesModule=typeof module==='object'&&module.exports?require('./trade-stocktakes'):globalThis.GrabenplanerStocktakes;
 const period=periodModule.mount(root,form,q('period'),{today:()=>context?.today||new Date().toISOString().slice(0,10)});
 const suggestionsModule=typeof module==='object'&&module.exports?require('./trade-suggestions'):globalThis.GrabenplanerSuggestions;
 let resultMeta={};
 let kind='purchasing',generation=0,rows=[],scanned=0,context=null,summary=null;
 let jobTimer=null,jobRefresh=null,currentJob=null,opening=null,openGeneration=0,sortKey='',sortDirection='asc',jobRows=[],jobSort='created',jobDirection='desc';
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
 function reset(){openGeneration++;currentJob=null;sortKey='';q('snapshot').hidden=true;generation++;rows=[];scanned=0;summary=null;results.replaceChildren();}
 const kinds={goods:'Lagerware',service:'Dienstleistung',account:'Verrechnung',excluded:'Ohne Lagerbestand',unknown:'Ungeklärt',inherit:'Vorgabe übernehmen'};

 function render(){
  const columns=model.columns(kind,context.projection,resultMeta),sorted=model.sortRows(rows,columns,sortKey,sortDirection);
  results.innerHTML=rows.length?'<div class="table-scroll" tabindex="0" aria-label="Sortierbare Suchergebnisse"><table><thead><tr>'+columns.map(c=>'<th aria-sort="'+(sortKey===c.key?(sortDirection==='asc'?'ascending':'descending'):'none')+'"><button type="button" data-sort="'+e(c.key)+'">'+e(c.label)+' <span aria-hidden="true">'+(sortKey===c.key?(sortDirection==='asc'?'↑':'↓'):'↕')+'</span></button></th>').join('')+'</tr></thead><tbody>'+sorted.map(r=>'<tr>'+columns.map((c,i)=>'<td class="'+(['number','money'].includes(c.type)?'numeric':'')+'">'+(i===0&&r.kind==='repair'?'<button type="button" data-repair="'+e(r.id)+'">Aktuelle Reparatur öffnen</button>':e(model.format(c.value(r),c.type)))+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>':'<p>Keine Treffer für diese Auswahl.</p>';
  if(kind==='movements')results.innerHTML=movementModule.table(sorted,columns,sortKey,sortDirection,model);
  if(kind==='stocktakes')results.innerHTML=stocktakesModule.table(sorted,columns,sortKey,sortDirection,model,resultMeta);
  if(kind==='suggestions')results.innerHTML=suggestionsModule.table(sorted,columns,sortKey,sortDirection,model);
  if(['purchasing','transfers'].includes(kind)&&context.projection.purchasing&&rows.length)results.insertAdjacentHTML('beforeend','<div class="movement-links">'+rows.filter((r,i,a)=>a.findIndex(x=>x.articleNumber===r.articleNumber)===i).slice(0,12).map(r=>'<button type="button" data-related-movements="'+e(r.articleNumber)+'">Warenbewegungen · '+e(r.articleNumber)+'</button>').join('')+'</div>');
  if(kind==='stock-summary'&&summary){
   const card=(label,value)=>'<div><small>'+e(label)+'</small><strong>'+e(value)+'</strong></div>';
   results.insertAdjacentHTML('afterbegin','<section class="trade-stock-summary" aria-label="Gesamtbestand"><div class="facts">'+card('Positionen mit positivem Bestand',number(summary.positivePositions))+card('Erfasster Bestand (vorläufig)',number(summary.positiveQuantity))+(context.projection.costs?card('Warenwert netto (vorläufig)',money(summary.provisionalNet))+card('Davon bestätigte Lagerware',money(summary.confirmedNet)):'')+'</div><p>'+number(summary.excluded)+' ausgeschlossene Positionen · '+number(summary.ambiguous)+' mehrdeutig · '+number(summary.missingArticle)+' ohne Artikelstamm · '+number(summary.missingQuantity)+' ohne Menge · '+number(summary.negative)+' negative Bestände · '+number(summary.unclassified)+' ungeklärte Artikelarten'+(context.projection.costs?' · '+number(summary.missingCost)+' ohne gültigen EK · '+number(summary.zeroCost)+' mit EK 0':'')+'. Prüffälle können sich überschneiden. Bei offenen Prüffällen ist der Warenwert nur ein Teilwert.</p></section>');
  }
  if(currentJob)q('pdf').href='/api/trade-insights/jobs/'+encodeURIComponent(currentJob)+'/pdf?sort='+encodeURIComponent(sortKey)+'&direction='+sortDirection;
 }
 const jobStates={queued:'Wartet',running:'Suche läuft',completed:'Gespeichert',failed:'Fehlgeschlagen',cancelled:'Abgebrochen'};
 const jobColumns=[{key:'title',label:'Ergebnis',type:'text',value:r=>r.title},{key:'kind',label:'Bereich',type:'text',value:r=>model.titles[r.kind]},{key:'created',label:'Abfrage',type:'date',value:r=>r.created},{key:'status',label:'Status',type:'text',value:r=>jobStates[r.status]},{key:'count',label:'Treffer',type:'number',value:r=>r.count}];
 const timestamp=v=>new Date(v).toLocaleString('de-AT');
 function renderJobs(){
  q('job-count').textContent='('+jobRows.length+')';
  q('jobs').innerHTML=jobRows.length?'<div class="table-scroll"><table><thead><tr>'+jobColumns.map(c=>'<th aria-sort="'+(jobSort===c.key?(jobDirection==='asc'?'ascending':'descending'):'none')+'"><button type="button" data-job-sort="'+c.key+'">'+c.label+' '+(jobSort===c.key?(jobDirection==='asc'?'↑':'↓'):'↕')+'</button></th>').join('')+'<th>Aktionen</th></tr></thead><tbody>'+model.sortRows(jobRows,jobColumns,jobSort,jobDirection).map(r=>'<tr><td><strong>'+e(r.title)+'</strong></td><td>'+e(model.titles[r.kind])+'</td><td>'+e(timestamp(r.created))+'</td><td><span class="trade-job-state" data-state="'+e(r.status)+'">'+e(jobStates[r.status])+'</span>'+(['running','queued'].includes(r.status)?'<small>'+number(r.processed)+' Positionen geprüft</small>':r.status==='failed'?'<small>'+e(r.error==='IMPORT_HISTORY_ANALYSIS_CHANGED'||r.error==='IMPORT_BESTELL_CURSOR'?'Datenstand geändert. Bitte neu suchen.':r.error==='IMPORT_FORBIDDEN'?'Berechtigung geändert.':r.error==='IMPORT_REPORT_DATA_LIMIT'?'Zu viele Ergebnisse. Bitte Auswahl eingrenzen.':'Suche konnte nicht abgeschlossen werden. Bitte erneut starten.')+'</small>':'')+'</td><td>'+number(r.count)+'</td><td class="trade-job-actions">'+(r.status==='completed'&&r.accessible?'<button type="button" data-job-open="'+e(r.id)+'">Öffnen</button><a class="trade-pdf-link" href="/api/trade-insights/jobs/'+encodeURIComponent(r.id)+'/pdf">PDF</a>':'')+(['queued','running'].includes(r.status)?'<button type="button" data-job-action="cancel" data-job-id="'+e(r.id)+'">Abbrechen</button>':'<button type="button" data-job-action="remove" data-job-id="'+e(r.id)+'">Entfernen</button>')+'</td></tr>').join('')+'</tbody></table></div>':'<p>Noch keine gespeicherten Ergebnisse. Starte eine Suche, um den ersten Ergebnisstand abzulegen.</p>';
 }
 async function openJob(id){
  let ticket=++openGeneration;opening=id;
  try{
   const data=await api('jobs/'+encodeURIComponent(id));if(ticket!==openGeneration)return;
   if(kind!==data.kind){const button=[...root.querySelectorAll('[data-kind]')].find(b=>b.dataset.kind===data.kind&&!b.disabled);if(!button)return;const choosing=choose(button),selection=generation;ticket=++openGeneration;await choosing;if(!active||selection!==generation||ticket!==openGeneration)return;}
   if(['movements','stocktakes','suggestions'].includes(kind)){form.hidden=true;q('movement-filter-toggle').hidden=false;q('movement-filter-toggle').textContent='Suchfilter anzeigen';q('archive').open=false;}
   currentJob=id;opening=null;rows=data.result.rows||[];resultMeta=data.result;summary=data.result.totals||null;scanned=data.processed;sortKey=['movements','stocktakes','suggestions'].includes(kind)?(model.columns(kind,context.projection,data.result).find(c=>c.key==='date')?.key||model.columns(kind,context.projection,data.result)[0]?.key||''):'';sortDirection=['movements','stocktakes','suggestions'].includes(kind)?'desc':'asc';
   for(const key of ['query','articleNumber','locationId','supplier','dateFrom','dateTo','movementType','review','stocktakeId','stocktakeVersion','stocktakeSource','difference','suggestionType','customer','serial','group','wgr'])if(form.elements[key])form.elements[key].value='';
   form.elements.days.value='180';
   for(const [key,value] of Object.entries(data.query))if(form.elements[key])form.elements[key].value=value;
   if(kind==='suggestions'){form.elements.dateFrom.value=data.result.dateFrom||data.query.dateFrom||'';form.elements.dateTo.value=data.result.dateTo||data.query.dateTo||'';}
   period.sync();root.querySelector('[data-stocktake-difference]').hidden=kind!=='stocktakes'||!resultMeta.stocktake;if(kind==='stocktakes')q('query-label').textContent=resultMeta.stocktake?'Artikelnr. oder Bezeichnung':'Inventurnummer';
   q('snapshot').hidden=false;q('snapshot').elements.title.value=data.title;
   q('snapshot-info').textContent='Abfrage '+timestamp(data.created)+' · gespeichert '+timestamp(data.completedAt)+' · damaliger Ergebnisstand'+(kind==='movements'?' · '+[data.query.articleNumber?'Artikel '+data.query.articleNumber:null,data.query.query?'Suche: '+data.query.query:null,data.query.dateFrom?'Ab '+date(data.query.dateFrom):null,data.query.dateTo?'Bis '+date(data.query.dateTo):null,data.query.movementType?({receipt:'Wareneingänge',transfer:'Umlagerungen',unclear:'Art ungeklärt'})[data.query.movementType]:null,data.query.review?({issues:'Mit Prüfhinweis',negative:'Negative Mengen',missing_date:'Ohne Buchungsdatum'})[data.query.review]:null,data.query.supplier?'Lieferant: '+data.query.supplier:null,data.query.locationId?'Filiale '+data.query.locationId:null].filter(Boolean).join(' · '):'');
   if(kind==='movements'&&!Object.values(data.query).some(Boolean))q('snapshot-info').textContent+='Alle Buchungen im freigegebenen Bereich';
   status.textContent=rows.length+' '+(kind==='stock-summary'?'Sortimentsgruppen':'Treffer')+' · '+number(scanned)+' Quellenpositionen geprüft · Ergebnis gespeichert';
   q('note').textContent=(data.result.note||'')+' Quellstand: '+date(data.result.sourceDate)+'.';render();
  }catch(err){if(err.name!=='AbortError')status.textContent=err.message;}finally{if(ticket===openGeneration)opening=null;}
 }
 async function refreshJobs(){
  if(!active||disposed||jobRefresh)return;
  const epoch=lifecycle;
  const work=(async()=>{
   try{jobRows=await api('jobs');renderJobs();q('job-status').textContent='';
    const job=jobRows.find(r=>r.id===currentJob);if(job?.status==='completed'&&q('snapshot').hidden&&!opening)await openJob(job.id);
    if(job?.status==='failed'){q('archive').open=true;status.textContent=['IMPORT_SOURCE_INCOMPLETE','IMPORT_BESTELL_SOURCE_INCOMPLETE'].includes(job.error)?'Die benötigte Datenbank ist noch nicht vollständig übernommen. Bitte Datenbankimporte prüfen.':job.error==='IMPORT_REPORT_DATA_LIMIT'?'Die Auswahl ist zu groß. Bitte Zeitraum oder Artikel eingrenzen.':'Die Suche konnte nicht abgeschlossen werden. Bitte gespeicherte Ergebnisse und Suchangaben prüfen.';}
   }catch(err){if(err.name!=='AbortError')q('job-status').textContent=err.message;}
   finally{if(epoch===lifecycle&&active){clearTimeout(jobTimer);if(jobRows.some(r=>['queued','running'].includes(r.status))){jobTimer=setTimeout(()=>void refreshJobs(),3000);jobTimer.unref?.();}}}
  })();jobRefresh=work;try{await work;}finally{if(jobRefresh===work)jobRefresh=null;}
 }
 async function load(){
  if(!active||!context||disposed||!selected)return;
  const query=Object.fromEntries(new FormData(form)),title=query.resultTitle;delete query.resultTitle;
  if(!['repairs','customer-history','device-history'].includes(kind)){delete query.customer;delete query.serial;}else if(kind==='customer-history')delete query.serial;
  if(!['purchasing','movements'].includes(kind))delete query.supplier;
  if(!['movements','suggestions'].includes(kind))delete query.articleNumber;
  if(kind!=='movements'){delete query.movementType;delete query.review;}
  if(!['inventory','stock-summary'].includes(kind)){delete query.days;delete query.group;delete query.wgr;}
  if(kind==='stock-summary'){delete query.days;delete query.dateFrom;delete query.dateTo;}
  if(kind!=='suggestions')delete query.suggestionType;
  if(kind!=='stocktakes')for(const key of ['stocktakeId','stocktakeVersion','stocktakeSource','difference'])delete query[key];
  const button=form.querySelector('button[type=submit]');button.disabled=true;const ticket=generation;
  try{const job=await api('jobs',{kind,query,title});if(ticket!==generation)return;reset();currentJob=job.id;status.textContent='Suche am Server gestartet. Du kannst im GP weiterarbeiten.';await jobRefresh;await refreshJobs();}
  catch(err){if(err.name!=='AbortError')status.textContent=err.message;}finally{button.disabled=false;}
 }
 on(form.elements.days,'change',()=>{form.elements.dateFrom.value='';period.sync();});
 on(form,'submit',event=>{event.preventDefault();void load();});
 on(results,'click',event=>{const b=event.target.closest('[data-sort]');if(!b)return;sortDirection=sortKey===b.dataset.sort&&sortDirection==='asc'?'desc':'asc';sortKey=b.dataset.sort;render();results.querySelector('[data-sort="'+sortKey+'"]')?.focus();});
 on(q('jobs'),'click',async event=>{
  const sort=event.target.closest('[data-job-sort]');if(sort){jobDirection=jobSort===sort.dataset.jobSort&&jobDirection==='asc'?'desc':'asc';jobSort=sort.dataset.jobSort;renderJobs();q('jobs').querySelector('[data-job-sort="'+jobSort+'"]')?.focus();return;}
  const open=event.target.closest('[data-job-open]');if(open){void openJob(open.dataset.jobOpen);return;}
  const action=event.target.closest('[data-job-action]');if(!action)return;action.disabled=true;
  try{await api('jobs/'+encodeURIComponent(action.dataset.jobId)+'/'+action.dataset.jobAction,{});if(action.dataset.jobId===currentJob)reset();await refreshJobs();}
  catch(err){if(err.name!=='AbortError')q('job-status').textContent=err.message;}finally{action.disabled=false;}
 });
 on(q('snapshot'),'submit',async event=>{event.preventDefault();if(!currentJob)return;try{await api('jobs/'+encodeURIComponent(currentJob)+'/rename',{title:q('snapshot').elements.title.value});await refreshJobs();}catch(err){if(err.name!=='AbortError')status.textContent=err.message;}});
 let metadata=null,classificationSelection=null,classGeneration=0;
 const classForm=q('class-form'),classSave=q('class-save'),classStatus=q('class-status');
 function option(label,value){const item=root.ownerDocument.createElement('option');item.textContent=label;item.value=value;return item;}
 function options(select,entries,empty=true){select.replaceChildren();if(empty)select.add(option('Alle',''));for(const r of [...entries].sort((a,b)=>model.collator.compare(a.id+' · '+a.label,b.id+' · '+b.label)))select.add(option(r.id+' · '+r.label,r.id));}
 function classChanged(){classGeneration++;classificationSelection=null;classSave.hidden=true;const level=classForm.elements.level.value;
  classForm.elements.articleKey.hidden=level!=='article';classForm.elements.groupKey.hidden=level==='article';options(classForm.elements.groupKey,level==='wgr'?metadata?.wgr||[]:metadata?.groups||[],false);classStatus.textContent='';}
 async function choose(button,{replace=false}={}){
  cancelPending();reset();for(const key of ['stocktakeId','stocktakeVersion','stocktakeSource','difference'])if(form.elements[key])form.elements[key].value='';resultMeta={};form.hidden=false;q('movement-filter-toggle').hidden=true;selected=true;kind=button.dataset.kind;
  for(const b of root.querySelectorAll('[data-kind]')){const chosen=b===button;b.classList.toggle('active',chosen);b.setAttribute('aria-selected',String(chosen));b.tabIndex=chosen?0:-1;}
  q('filters').parentElement.setAttribute('aria-labelledby',button.id);
  onTabChange(kind,{replace});
  q('filters').parentElement.hidden=kind==='article-history';historyPanel.hidden=kind!=='article-history';
  if(kind==='article-history'){articleHistory||=historyModule.mount(historyPanel,{api,onMovements:context.projection.purchasing?articleNumber=>openMovements({articleNumber}):null});articleHistory.activate();return;}
  q('inventory-intro').hidden=kind!=='stocktakes';q('suggestions-intro').hidden=kind!=='suggestions';root.querySelector('[data-suggestion-filter]').hidden=kind!=='suggestions';root.querySelector('[data-stocktake-difference]').hidden=true;
  root.querySelector('[data-customer]').hidden=!['repairs','customer-history','device-history'].includes(kind);root.querySelector('[data-serial]').hidden=!['repairs','device-history'].includes(kind);form.elements.customer.required=kind==='customer-history';form.elements.serial.required=kind==='device-history';
   root.querySelector('[data-supplier]').hidden=!['purchasing','movements'].includes(kind);
   root.querySelectorAll('[data-article-exact]').forEach(n=>n.hidden=!['movements','suggestions'].includes(kind));
   root.querySelectorAll('[data-movement]').forEach(n=>n.hidden=kind!=='movements');q('movement-intro').hidden=kind!=='movements';
   if(kind==='movements'){q('movement-source').textContent=context.sources?.movements?'Übernommener WEUM-Stand: '+date(context.sources.movements.date):'Noch keine WEUM-Daten übernommen. Import unter Einstellungen → Datenbankimporte.';if(!movementVisited){movementVisited=true;const day=new Date(context.today+'T00:00:00Z');day.setUTCDate(day.getUTCDate()-29);form.elements.dateFrom.value=day.toISOString().slice(0,10);form.elements.dateTo.value=context.today;}}const stock=['inventory','stock-summary'].includes(kind);form.elements.locationId.required=false;
   function locationOptions(){const select=form.elements.locationId,previous=select.value,items=kind==='stock-summary'?(metadata?.stockLocations||[]):context.locations||[];
    select.replaceChildren(option(kind==='stock-summary'?'Alle Filial-IDs zusammen':'Alle freigegebenen Filialen',''));for(const l of [...items].sort((a,b)=>model.collator.compare(a.label,b.label)))select.add(option(l.label,l.id));select.value=items.some(l=>l.id===previous)?previous:'';}
   locationOptions();
  root.querySelectorAll('[data-stock]').forEach(n=>n.hidden=!stock||kind==='stock-summary');root.querySelectorAll('[data-inventory]').forEach(n=>n.hidden=!['inventory','stock-summary'].includes(kind));root.querySelectorAll('[data-period]').forEach(n=>n.hidden=kind==='stock-summary');
  q('classification').hidden=kind!=='inventory'||!context.projection.classify;
  q('query-label').textContent=kind==='stocktakes'?'Inventurnummer':['inventory','stock-summary','suggestions'].includes(kind)?'Artikelnr. oder Bezeichnung':kind==='purchasing'?'Artikel oder Bestellnummer':'Artikel oder Vorgangsnummer';form.elements.query.required=false;
  period.sync();
  status.textContent='Suchangaben wählen und Suche starten.';q('note').textContent='';
  void refreshJobs();
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
  try{const data=await api('repair-save',{id:selected.id,state:repairForm.elements.state.value,expectedRevision:selected.revision});if(ticket!==repairGeneration)return;repairSelection=data;renderRepair(data);repairStatus.textContent='GP-Status gespeichert.';repairStatus.textContent+=' Der gespeicherte Ergebnisstand bleibt unverändert.';}catch(err){if(ticket===repairGeneration&&err.name!=='AbortError')repairStatus.textContent=err.message;}finally{button.disabled=false;}});

 function cancelPending(){
  articleHistory?.suspend();period.close();
  openGeneration++;opening=null;clearTimeout(jobTimer);jobTimer=null;jobRefresh=null;
  lifecycle++;generation++;classGeneration++;repairGeneration++;
  for(const pending of requests)pending.abort();requests.clear();
  contextPromise=null;
  classificationSelection=null;classSave.hidden=true;repairSelection=null;
  if(repairDialog.open)repairDialog.close();if(q('movement-dialog').open)q('movement-dialog').close();movementSelection=null;
 }
 function suspend(){
  if(!active)return;
  active=false;cancelPending();
 }
 async function activate(tab=requestedTab){
  if(disposed)return;active=true;requestedTab=normalizeTab(tab);
  if(!context){
   if(contextPromise)return contextPromise;
   const epoch=lifecycle;
   status.textContent='Zugriff wird geprüft …';form.querySelector('button[type=submit]').disabled=true;
   const pending=api('context').then(data=>{
    context=data;
    for(const b of root.querySelectorAll('[data-kind]')){
     b.disabled=!data.projection?.[b.dataset.kind==='article-history'?'articleHistory':['inventory','stock-summary','stocktakes','suggestions'].includes(b.dataset.kind)?'inventory':b.dataset.kind==='repairs'?'repairs':['customer-history','device-history'].includes(b.dataset.kind)?'customers':'purchasing'];
    }
    form.elements.locationId.replaceChildren(option('Alle freigegebenen Filialen',''));
    for(const l of [...(data.locations||[])].sort((a,b)=>model.collator.compare(a.label,b.label)))form.elements.locationId.add(option(l.label,l.id));
    return activate(requestedTab);
   }).catch(err=>{if(active&&!disposed&&epoch===lifecycle&&err.name!=='AbortError')status.textContent=err.message;})
    .finally(()=>{if(contextPromise===pending)contextPromise=null;});
   contextPromise=pending;return pending;
  }
  const allowed=[...root.querySelectorAll('[data-kind]')].filter(b=>!b.disabled);
  const button=allowed.find(b=>b.dataset.kind===requestedTab)||allowed[0];
  form.querySelector('button[type=submit]').disabled=!button;
  if(!button){status.textContent='Für diese Auswertungen fehlt die Freigabe.';return;}
  if(!selected||button.dataset.kind!==kind||(['inventory','stock-summary'].includes(kind)&&!metadata))await choose(button,{replace:button.dataset.kind!==requestedTab});
  else {if(kind!==requestedTab)onTabChange(kind,{replace:true});if(kind==='article-history')articleHistory.activate();else void refreshJobs();}
 }
 async function openRelated(target,criteria={}){
  await activate(target);if(!active||kind!==target)return;
  for(const key of ['query','articleNumber','locationId','supplier','dateFrom','dateTo','movementType','review','stocktakeId','stocktakeVersion','stocktakeSource','difference','suggestionType'])if(form.elements[key])form.elements[key].value=criteria[key]||'';
  period.sync();await load();
 }
 const openMovements=criteria=>openRelated('movements',criteria);
 on(q('movement-filter-toggle'),'click',()=>{form.hidden=!form.hidden;q('movement-filter-toggle').textContent=form.hidden?'Suchfilter anzeigen':'Suchfilter ausblenden';});
 on(form.elements.review,'change',()=>{if(form.elements.review.value==='missing_date'){form.elements.dateFrom.value='';form.elements.dateTo.value='';period.sync();}});
 on(form,'change',event=>{if(['dateFrom','dateTo'].includes(event.target.name)&&event.target.value&&form.elements.review.value==='missing_date')form.elements.review.value='';});
 on(results,'click',event=>{
  const related=event.target.closest('[data-related-movements]');if(related){void openMovements({articleNumber:related.dataset.relatedMovements});return;}
  const button=event.target.closest('[data-movement]');if(!button)return;
  const row=rows.find(r=>r.id===button.dataset.movement);if(!row)return;movementSelection=row;
  q('movement-content').innerHTML=movementModule.detail(row,historyModule);q('movement-dialog').showModal();
 });
 on(results,'click',event=>{
  const back=event.target.closest('[data-stocktake-back]');if(back){void openRelated('stocktakes',{});return;}
  const open=event.target.closest('[data-stocktake]');if(open){const r=rows.find(r=>r.id===open.dataset.stocktake);if(r)void openRelated('stocktakes',{stocktakeId:r.id,stocktakeVersion:String(r.revision),stocktakeSource:r.sourceHash});return;}
  const article=event.target.closest('[data-stocktake-article]');if(article){const r=rows.find(r=>r.id===article.dataset.stocktakeArticle);if(!r)return;q('movement-content').innerHTML='<h2 id="movementDetailTitle">Artikelreferenz</h2><p>'+e(r.articleNumber)+' · '+e(r.label)+'</p><p>'+e(historyModule.labels[r.articleReference.status])+'</p>'+historyModule.provenance(r.articleReference);q('movement-dialog').showModal();}
 });
 on(results,'click',event=>{const button=event.target.closest('[data-suggestion]');if(!button)return;const r=rows.find(r=>r.id===button.dataset.suggestion);if(!r)return;q('movement-content').innerHTML=suggestionsModule.detail(r,model,context.projection);q('movement-dialog').showModal();});
 on(q('movement-content'),'click',event=>{const b=event.target.closest('[data-suggestion-related]');if(!b)return;q('movement-dialog').close();void openRelated(b.dataset.suggestionRelated,b.dataset.suggestionRelated==='movements'?{articleNumber:b.dataset.article}:{query:b.dataset.article});});
 on(q('movement-content'),'click',event=>{
  const button=event.target.closest('[data-movement-related]'),row=movementSelection;if(!button||!row)return;
  q('movement-dialog').close();void openRelated(button.dataset.movementRelated,{query:button.dataset.movementRelated==='purchasing'?row.references.order.number:row.articleNumber});
 });
 on(q('movement-dialog'),'close',()=>{movementSelection=null;});
 on(q('tabs'),'keydown',event=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  const allowed=[...root.querySelectorAll('[data-kind]')].filter(b=>!b.disabled),current=allowed.indexOf(event.target);
  if(current<0)return;event.preventDefault();
  const index=event.key==='Home'?0:event.key==='End'?allowed.length-1:(current+(event.key==='ArrowRight'?1:-1)+allowed.length)%allowed.length;
  allowed[index].focus();void choose(allowed[index]);
 });
 return {activate,suspend,openMovements,async openArticleHistory(query=''){await activate('article-history');if(active&&kind==='article-history')articleHistory.activate(query);},getTab:()=>kind,destroy(){if(disposed)return;suspend();disposed=true;articleHistory?.destroy();for(const remove of listeners)remove();root.replaceChildren();}};
 }
 return {mount,normalizeTab,legacyUrl,tabs};
});
