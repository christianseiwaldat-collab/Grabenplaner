(function(host,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(host)host.SalesArticleTools=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const movementColumns={date:'Datum',articleNumber:'Artikelnummer',quantity:'Anzahl',label:'Artikelbezeichnung',from:'Von Filiale',to:'Zu Filiale',typeLabel:'Bewegungsart',documentRefs:'Belegverweise',supplier:'Lieferant',issueLabel:'Prüfhinweis'};
 const noteColumns={date:'Datum',text:'Notiz',person:'Person',origin:'Herkunft'};
 const sectionLabels={master:'Stammdaten',prices:'Preise',notes:'Notizen',identifiers:'Kennungen & Verlauf',movements:'Umlagerungen',sales:'Verkäufe'};
 const formatDate=value=>value?new Intl.DateTimeFormat('de-AT').format(new Date(String(value).slice(0,10)+'T12:00:00Z')):'–';
 const numeric=new Set(['quantity','listSourcePrice','listGross','listMargin','listMarginPercent','actualGross','actualMargin','actualMarginPercent']);
 const historyFilterKeys=kind=>kind==='sales'?['dateFrom','dateTo','locationId','personnel']:['dateFrom','dateTo','fromLocationId','toLocationId'];
 function historyDefaults(kind,today){
  if(!['sales','movements'].includes(kind)||typeof today!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(today)||!Number.isFinite(Date.parse(today))||new Date(today).toISOString().slice(0,10)!==today)throw new TypeError('Ungültiger Server-Datenstand.');
  const end=new Date(today+'T12:00:00Z'),start=new Date(end);
  if(kind==='movements')start.setUTCDate(start.getUTCDate()-89);
  else {const month=end.getUTCMonth();start.setUTCFullYear(start.getUTCFullYear()-1);if(start.getUTCMonth()!==month)start.setUTCDate(0);}
  return {dateFrom:start.toISOString().slice(0,10),dateTo:today};
 }
 function display(key,value){if(value===null||value===undefined||value==='')return '–';if(key==='date')return formatDate(value);if(key==='status')return {sale:'Verkauf',return:'Rücknahme',review:'Prüfen'}[value]||String(value);if(numeric.has(key)&&/^-?\d+(\.\d+)?$/.test(String(value))){let raw=String(value),negative=raw.startsWith('-'),[whole,fraction='']=raw.replace(/^-/,'').split('.');if(key!=='quantity'){let cents=BigInt(whole)*100n+BigInt((fraction+'00').slice(0,2));if((fraction[2]||'0')>='5')cents++;whole=String(cents/100n);fraction=String(cents%100n).padStart(2,'0');if(cents===0n)negative=false;}return(negative?'-':'')+whole.replace(/\B(?=(\d{3})+(?!\d))/g,'.')+(fraction?','+fraction:'')+(key.endsWith('Percent')?' %':key==='quantity'?'':' €');}return String(value);}
 function mount(root,{api,rawApi,article,write=false,accessKey=()=>'',onCustomer=()=>{}}){
  const owner=accessKey();let disposed=false,context=null,contextLoading=null,localNotes=null,mutation=null,notesBusy=false;
  const authorized=()=>!disposed&&root.isConnected&&accessKey()===owner;
  const request=(url,body)=>api(url,body===undefined?{}:{method:'POST',body:JSON.stringify(body)});
  const tables=globalThis.GrabenplanerTradeTables?.mount({api:(path,body)=>request('/api/sales/articles/tools/'+path,body)});
  const states={};const listeners=[],dialogs=[];
  const on=(el,event,fn)=>{el?.addEventListener(event,fn);listeners.push(()=>el?.removeEventListener(event,fn));};
  const duration=ms=>globalThis.GrabenplanerTradeResults?.duration(ms)||ms+' ms';
  async function ensureContext(){if(context)return context;if(!contextLoading)contextLoading=request('/api/sales/articles/tools/context');try{context=await contextLoading;return context;}finally{contextLoading=null;}}
  const selectedFilters=state=>Object.fromEntries(historyFilterKeys(state.kind).map(key=>[key,state.form.elements[key]?.value||'']));
  function prepareHistory(state,ctx){
   if(state.prepared)return;
   const defaults=historyDefaults(state.kind,ctx.today);
   for(const [key,value]of Object.entries(defaults))state.form.elements[key].value=value;
   const locations=state.kind==='sales'?ctx.salesLocations:ctx.movementLocations;
   for(const name of state.kind==='sales'?['locationId']:['fromLocationId','toLocationId']){
    const select=state.form.elements[name];select.innerHTML='<option value="">Alle freigegebenen Filialen</option>'+(locations||[]).map(l=>'<option value="'+escape(l.id)+'">'+escape(l.label)+'</option>').join('');
   }
   if(state.kind==='sales'&&!ctx.sellers){const input=state.form.elements.personnel;input.value='';input.disabled=true;input.closest('label').hidden=true;}
   state.period=globalThis.GrabenplanerTradePeriod?.mount(state.panel,state.form,state.panel.querySelector('[data-period-button]'),{today:()=>ctx.today});dialogs.push(state.panel.querySelector('dialog'));
   state.prepared=true;state.panel.querySelector('[data-period-button]').disabled=false;
  }
  function table(container,key,rows,columns,{sort='date',direction='desc',sortAction}={}){
   tables?.clear(container);const keys=Object.keys(columns);
   container.innerHTML='<div class="sales-article-detail-table-wrap"><table class="sales-article-history-table"><thead><tr>'+keys.map(k=>'<th scope="col" aria-sort="'+(sort===k?(direction==='asc'?'ascending':'descending'):'none')+'"><button type="button" data-sort="'+escape(k)+'">'+escape(columns[k])+' <span aria-hidden="true">'+(sort===k?(direction==='asc'?'↑':'↓'):'↕')+'</span></button></th>').join('')+(key==='article-sales'?'<th scope="col">Beleg</th>':'')+'</tr></thead><tbody>'+rows.map((row,i)=>'<tr>'+keys.map(k=>{
    let value=display(k,k==='locationId'?(row.sourceLocationId??row.locationId):row[k]);
    if(k==='personnel')value='<span title="'+escape(row.personnelSurname||'Nachname nicht hinterlegt')+'">'+escape(value)+'</span>';
    else if(k==='customerNumber'&&row.customerId)value='<button type="button" class="text-button" data-customer="'+i+'">'+escape(value)+'</button>';
    else value=escape(value);
    return '<td>'+value+'</td>';
   }).join('')+(key==='article-sales'?'<td><button type="button" class="text-button" data-receipt="'+i+'"'+(!row.receiptId?' disabled':'')+'>Beleg-PDF</button></td>':'')+'</tr>').join('')+'</tbody></table></div>';
   if(!rows.length)container.insertAdjacentHTML('beforeend','<p class="sales-article-detail-message">Keine Treffer für diesen Artikel und Zeitraum.</p>');
   tables?.attach(container,key);
   container.onclick=event=>{const b=event.target.closest('[data-sort],[data-customer],[data-receipt]');if(!b)return;if(b.dataset.sort)sortAction?.(b.dataset.sort);else if(b.dataset.customer!==undefined)onCustomer(rows[Number(b.dataset.customer)].customerId);else void receipt(rows[Number(b.dataset.receipt)]);};
  }
  async function download(url,body,name){const response=await rawApi(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const blob=await response.blob();if(!authorized())return;const href=URL.createObjectURL(blob),link=root.ownerDocument.createElement('a');link.href=href;link.download=name;root.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(href),60000);}
  async function receipt(row){const state=states.sales;try{state.status.textContent='Vollständiger Beleg wird als Informations-PDF erstellt …';await download('/api/receipt-search/export.pdf',{ids:[row.receiptId]},'Beleginformation-keine-Rechnung-'+row.receipt+'.pdf');if(authorized())state.status.textContent='Beleg-PDF erstellt · keine Rechnung.';}catch(e){if(authorized())state.status.textContent=e.message;}}
  function history(kind){
   if(states[kind])return states[kind];
   const panel=root.querySelector(kind==='sales'?'#salesArticleSalesSection':'#salesArticleMovementsSection');
   const title=kind==='sales'?'Verkäufe':'Umlagerungen';
   const branch= (name,label)=>'<label>'+label+'<select name="'+name+'"><option value="">Wird geladen …</option></select></label>';
   panel.innerHTML='<section class="sales-article-detail-card article-history-card"><header><div><h3>'+title+'</h3><p>'+(kind==='sales'?'Historische Einzelverkäufe · Standard: letztes Jahr · Preise und Rohertrag je Stück':'Gebuchte Umlagerungen des Artikels · Standard: letzte 90 Tage')+'</p></div></header><form class="article-history-filters"><div><span>Zeitraum</span><button type="button" data-period-button disabled>Zeitraum wird geladen …</button><input type="hidden" name="dateFrom"><input type="hidden" name="dateTo"></div>'+(kind==='sales'?branch('locationId','Filiale')+'<label>MA / Personalnummer<input name="personnel" maxlength="160" autocomplete="off" placeholder="z. B. 252"></label>':branch('fromLocationId','Von Filiale')+branch('toLocationId','Zu Filiale'))+'<button type="submit" class="secondary-button">Aktualisieren</button></form><p class="article-history-status" role="status">Wird geladen …</p><p class="article-history-note"></p><div class="article-history-results"></div><div class="article-history-pagination"><button type="button" data-history-prev>Zurück</button><span></span><button type="button" data-history-next>Weitere</button></div></section>';
   const state={kind,panel,form:panel.querySelector('form'),status:panel.querySelector('[role=status]'),note:panel.querySelector('.article-history-note'),results:panel.querySelector('.article-history-results'),rows:[],all:[],sort:'date',direction:'desc',offset:0,next:null,resultSet:'',busy:false,ticket:0,loaded:false,cursors:[]};states[kind]=state;
   on(state.form,'submit',e=>{e.preventDefault();void loadHistory(state,true);});
   on(panel.querySelector('[data-history-next]'),'click',()=>{if(kind==='sales'){state.cursors.push(state.next);void loadHistory(state,false,state.next);}else{state.offset+=50;renderHistory(state);}});
   on(panel.querySelector('[data-history-prev]'),'click',()=>{if(kind==='sales'){state.cursors.pop();void loadHistory(state,false,state.cursors.at(-1)||'');}else{state.offset=Math.max(0,state.offset-50);renderHistory(state);}});
   return state;
  }
  function renderHistory(state){
   const {kind,panel}=state;if(!authorized())return;
   let rows=state.rows;
   if(kind==='movements'){let all=state.all.slice();all=globalThis.GrabenplanerTradeResults.sortRows(all,Object.keys(movementColumns).map(key=>({key,type:key==='quantity'?'decimal':'text',value:r=>r[key]})),state.sort,state.direction);state.filtered=all;rows=all.slice(state.offset,state.offset+50);state.total=all.length;}
   state.shown=rows;table(state.results,'article-'+kind,rows,kind==='sales'?state.columns:movementColumns,{sort:state.sort,direction:state.direction,sortAction:key=>{if(state.busy)return;state.direction=state.sort===key&&state.direction==='asc'?'desc':'asc';state.sort=key;state.offset=0;state.cursors=[];if(kind==='sales')void loadHistory(state,false);else renderHistory(state);}});
   state.results.querySelectorAll('[data-sort]').forEach(button=>{button.disabled=state.busy;});
   const pagination=panel.querySelector('.article-history-pagination'),page=kind==='sales'?state.cursors.length:state.offset/50;
   pagination.querySelector('span').textContent=(state.total||0)+' Treffer · Seite '+(page+1);
   pagination.querySelector('[data-history-prev]').disabled=state.busy||page===0;
   pagination.querySelector('[data-history-next]').disabled=state.busy||(kind==='sales'?!state.next:state.offset+50>=state.total);
   state.status.textContent=(state.total||0)+' Treffer · Abfragedauer: '+duration(state.durationMs)+(state.truncated?' · Ansicht auf 2.000 Buchungen begrenzt; bitte Zeitraum eingrenzen.':'');
   state.note.textContent=state.sourceNote||'';
  }
  async function loadHistory(state,reset=false,cursor=''){
   if(state.busy)return;const ticket=++state.ticket;state.busy=true;state.status.textContent='Daten werden gesucht …';state.form.querySelector('[type=submit]').disabled=true;state.results.querySelectorAll('[data-sort]').forEach(button=>{button.disabled=true;});
   if(reset){state.resultSet='';state.cursors=[];state.offset=0;}
   try{
    const ctx=await ensureContext();if(!authorized())return;
    if(!(state.kind==='sales'?ctx.sales:ctx.movements))throw new Error('Für diese Artikelhistorie fehlt die persönliche Freigabe.');
    prepareHistory(state,ctx);if(reset||!state.filters)state.filters=selectedFilters(state);
    // Page and sort the submitted selection, even if the form is being edited.
    const query={articleNumber:article.articleNumber,...state.filters};
    if(state.kind==='sales'){
     const result=await request('/api/sales/articles/history/sales',{...query,sort:state.sort,direction:state.direction,limit:50,...(cursor?{cursor}:state.resultSet?{resultSet:state.resultSet}:{})});
     if(!authorized()||ticket!==state.ticket)return;Object.assign(state,{rows:result.rows,total:result.total,next:result.next,resultSet:result.resultSet,columns:result.columns,durationMs:result.durationMs,sourceNote:result.note,loaded:true});
    }else{
     if(reset||!state.loaded){let next='',all=[],durationMs=0,result;do{result=await request('/api/trade-insights/article-movements',{...query,...(next?{cursor:next}:{})});if(!authorized()||ticket!==state.ticket)return;all.push(...result.rows);durationMs+=result.durationMs||0;next=result.next;}while(next&&all.length<2000);Object.assign(state,{all,durationMs,sourceNote:result.note,truncated:!!next,loaded:true});}
    }
    renderHistory(state);
   }catch(e){if(authorized()&&ticket===state.ticket){tables?.clear(state.results);state.results.replaceChildren();state.status.textContent=e.message;state.loaded=false;}}
   finally{state.busy=false;if(authorized()){state.form.querySelector('[type=submit]').disabled=false;if(state.loaded)renderHistory(state);}}
  }
  const notesPanel=root.querySelector('#salesArticleNotesSection');
  notesPanel.innerHTML='<section class="sales-article-detail-card article-notes-card"><header><div><h3>Notizen</h3><p>Trade-Notizen und eigene GP-Notizen. Eigene Notizen bleiben bei neuen Importen erhalten.</p></div></header>'+(write?'<form class="article-note-add"><label>Neue GP-Notiz<textarea name="text" maxlength="4000" rows="3" required placeholder="Notiz zum Artikel …"></textarea></label><button type="submit" class="secondary-button">Notiz speichern</button></form>':'')+'<form class="article-history-filters"><div><span>Zeitraum</span><button type="button" data-note-period>Alle Notizen</button><input name="dateFrom" type="hidden"><input name="dateTo" type="hidden"></div><button type="submit">Anzeigen</button></form><p role="status"></p><div class="article-note-results"></div></section>';
  const noteStatus=notesPanel.querySelector('[role=status]'),noteResults=notesPanel.querySelector('.article-note-results'),noteFilter=notesPanel.querySelector('.article-history-filters');let noteSort='date',noteDirection='desc';
  const notePeriod=globalThis.GrabenplanerTradePeriod?.mount(notesPanel,noteFilter,notesPanel.querySelector('[data-note-period]'));dialogs.push(notesPanel.querySelector('dialog'));
  function renderNotes(){if(!authorized())return;const imported=(article.notes?.items||[]).map(n=>({date:n.date,text:n.text,person:n.person,origin:'Trade'})),own=(localNotes?.items||[]).map(n=>({date:n.createdAt,text:n.text,person:n.author,origin:'GP'}));let rows=[...own,...imported].filter(n=>{const d=String(n.date||'').slice(0,10);return (!noteFilter.elements.dateFrom.value||d>=noteFilter.elements.dateFrom.value)&&(!noteFilter.elements.dateTo.value||d&&d<=noteFilter.elements.dateTo.value);});rows.sort((a,b)=>(noteDirection==='asc'?1:-1)*String(a[noteSort]??'').localeCompare(String(b[noteSort]??''),'de',{numeric:true}));table(noteResults,'article-notes',rows,noteColumns,{sort:noteSort,direction:noteDirection,sortAction:key=>{noteDirection=noteSort===key&&noteDirection==='asc'?'desc':'asc';noteSort=key;renderNotes();}});noteStatus.textContent=rows.length+' Notizen · '+own.length+' eigene GP-Notizen';}
  async function loadNotes(){try{localNotes=await request('/api/sales/articles/local-notes?articleNumber='+encodeURIComponent(article.articleNumber));if(authorized())renderNotes();}catch(e){if(authorized())noteStatus.textContent=e.message;}}
  on(noteFilter,'submit',e=>{e.preventDefault();renderNotes();});
  on(notesPanel.querySelector('.article-note-add'),'submit',async e=>{e.preventDefault();if(notesBusy||!localNotes)return;notesBusy=true;const form=e.target,text=form.elements.text.value;if(!mutation||mutation.text!==text)mutation={id:crypto.randomUUID(),text};form.querySelector('button').disabled=true;try{const value=await request('/api/sales/articles/local-notes',{articleNumber:article.articleNumber,text,expectedRevision:localNotes.revision,mutationId:mutation.id});if(!authorized())return;localNotes=value;mutation=null;form.reset();renderNotes();noteStatus.textContent='Eigene GP-Notiz gespeichert.';}catch(error){if(authorized()){noteStatus.textContent=error.message;if(error.status===409)await loadNotes();}}finally{notesBusy=false;if(authorized())form.querySelector('button').disabled=false;}});
  renderNotes();
  let pdf=null;
  function openPdf(){if(!pdf)pdf=pdfDialog();void pdf.open();}
  function pdfDialog(){
   const exp=globalThis.GrabenplanerTradeExport; // public export module alias is resolved below
   const exportModel=globalThis.GrabenplanerTradeExportOptions||exp;
   const dialog=root.ownerDocument.createElement('dialog');dialog.className='modal article-sheet-dialog';dialog.setAttribute('aria-label','Artikelstammblatt als PDF');
   dialog.innerHTML='<form><header class="modal-header"><h2>Artikelstammblatt als PDF</h2><button type="button" class="close-button" data-close aria-label="PDF-Dialog schließen">×</button></header><div class="article-sheet-body"><fieldset><legend>Bereiche im Stammblatt</legend>'+Object.entries(sectionLabels).map(([id,label])=>'<label><input type="checkbox" name="section" value="'+id+'"'+(['master','prices','notes'].includes(id)?' checked':'')+'> '+label+'</label>').join('')+'</fieldset><label><input type="checkbox" name="image"'+(article.image?.present?' checked':' disabled')+'> Artikelfoto einfügen'+(article.image?.present?'':' (kein Foto vorhanden)')+'</label><p>Historien verwenden die zuletzt gestarteten Filter des jeweiligen Reiters. Ohne eigene Auswahl gelten 90 Tage für Umlagerungen und ein Jahr für Verkäufe. Pro Historie werden höchstens die neuesten 1.000 Einträge exportiert.</p><label>Dateiname<input name="name" maxlength="110" required></label><div class="article-export-fields"><label>Zeitblock<select name="stamp" aria-label="Zeitblock"><option value="date-time">JJMMTT-HHMM</option><option value="date">JJMMTT</option><option value="date-suffix">JJMMTT-xxx</option><option value="none">Ohne Zeitblock</option></select></label><label>Anordnung<select name="position" aria-label="Anordnung"><option value="before">Vorne</option><option value="after">Hinten</option></select></label><label>Ergänzung (xxx)<input name="suffix" maxlength="40"></label><label>Trennzeichen<select name="separator" aria-label="Trennzeichen"><option value="-">Bindestrich</option><option value="_">Unterstrich</option><option value=" ">Leerzeichen</option></select></label></div><p class="article-sheet-preview"></p><p role="status"></p></div><footer class="modal-actions"><button type="button" class="secondary-button" data-close>Schließen</button><button type="submit" class="primary-button">PDF herunterladen</button></footer></form>';
   root.append(dialog);dialogs.push(dialog);const form=dialog.querySelector('form'),status=form.querySelector('[role=status]');
   const config=()=>Object.fromEntries(['stamp','position','separator','suffix'].map(k=>[k,form.elements[k].value]));
   const preview=()=>{form.querySelector('.article-sheet-preview').textContent=exportModel?.filename(form.elements.name.value,config())||form.elements.name.value+'.pdf';form.elements.suffix.disabled=form.elements.stamp.value!=='date-suffix';};
   form.elements.name.value='Artikel-'+article.articleNumber;on(form,'input',preview);on(form,'change',preview);on(form,'click',e=>{if(e.target.closest('[data-close]'))dialog.close();});
   on(form,'submit',async e=>{e.preventDefault();const sections=[...form.querySelectorAll('[name=section]:checked')].map(i=>i.value);if(!sections.length){status.textContent='Bitte mindestens einen Bereich auswählen.';return;}const button=form.querySelector('[type=submit]');button.disabled=true;status.textContent='Stammblatt wird erstellt …';try{const ctx=await ensureContext(),options={...config(),sections,includeImage:form.elements.image.checked,name:form.elements.name.value,movements:{},sales:{}};for(const k of ['movements','sales'])if(sections.includes(k))options[k]=states[k]?.filters||historyDefaults(k,ctx.today);await request('/api/sales/articles/tools/pdf-options',config());await download('/api/sales/articles/sheet.pdf',{articleNumber:article.articleNumber,...options},exportModel?.filename(options.name,config())||options.name+'.pdf');if(authorized())status.textContent='PDF-Download gestartet.';}catch(error){if(authorized())status.textContent=error.message;}finally{if(authorized())button.disabled=false;}});
   return {async open(){status.textContent='';dialog.showModal();try{const ctx=await ensureContext();for(const k of ['movements','sales'])form.querySelector('[name=section][value='+k+']').disabled=!(k==='sales'?ctx.sales:ctx.movements);const saved=await request('/api/sales/articles/tools/pdf-options');if(authorized()){for(const [k,v]of Object.entries(saved))if(form.elements[k])form.elements[k].value=v;preview();}}catch(e){if(authorized())status.textContent=e.message;}preview();}};
  }
  return {activate(id){if(!authorized())return;if(id==='salesArticleNotesSection'&&!localNotes)void loadNotes();if(id==='salesArticleMovementsSection'||id==='salesArticleSalesSection'){const state=history(id==='salesArticleSalesSection'?'sales':'movements');if(!state.loaded&&!state.busy)void loadHistory(state,true);}},openPdf,destroy(){disposed=true;for(const state of Object.values(states)){state.ticket++;state.period?.close();}notePeriod?.close();for(const remove of listeners)remove();tables?.destroy();for(const dialog of dialogs){if(dialog?.open)dialog.close();dialog?.remove();}}};
 }
 return {mount,movementColumns,noteColumns,sectionLabels,display,historyDefaults,historyFilterKeys};
});
