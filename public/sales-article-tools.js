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
 function mount(root,{api,rawApi,article,write=false,accessKey=()=>'',onCustomer=()=>{},windowPreferences,scale,active=()=>true,trigger}){
  const owner=accessKey();let disposed=false,context=null,contextLoading=null,localNotes=null,mutation=null,notesBusy=false;
  const authorized=()=>!disposed&&root.isConnected&&accessKey()===owner;
  const request=(url,body)=>api(url,body===undefined?{}:{method:'POST',body:JSON.stringify(body)});
  const tables=globalThis.GrabenplanerTradeTables?.mount({api:(path,body)=>request('/api/sales/articles/tools/'+path,body)});
  const states={};const listeners=[],dialogs=[];let receiptPdf=null;
  const receiptContext=()=>JSON.stringify({article:article.articleNumber,ticket:states.sales?.ticket,resultSet:states.sales?.resultSet,filters:states.sales?selectedFilters(states.sales):null});
  function syncReceiptPrint(){if(!receiptPdf)return;if(active())receiptPdf.activate();else receiptPdf.deactivate();receiptPdf.sync();}
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
   container.onclick=event=>{const b=event.target.closest('[data-sort],[data-customer],[data-receipt]');if(!b)return;if(b.dataset.sort)sortAction?.(b.dataset.sort);else if(b.dataset.customer!==undefined)onCustomer(rows[Number(b.dataset.customer)].customerId);else void receipt(rows[Number(b.dataset.receipt)],b);};
  }
  function receipt(row,target){
   const state=states.sales;if(!row?.receiptId||!authorized()||!active()||!context?.sales)return;
   try{receiptPdf ||= root.ownerDocument.defaultView.GpReceiptPrint.mount({document:root.ownerDocument,rawApi,key:accessKey,
    id:'article-receipt-pdf',canUse:()=>authorized()&&Boolean(context?.sales),active,contextKey:receiptContext,windowPreferences,scale});receiptPdf.open([row.receiptId],target);}
   catch(error){if(authorized())state.status.textContent=error.message;}
  }
  function history(kind){
   if(states[kind])return states[kind];
   const panel=root.querySelector(kind==='sales'?'#salesArticleSalesSection':'#salesArticleMovementsSection');
   const title=kind==='sales'?'Verkäufe':'Umlagerungen';
   const branch= (name,label)=>'<label>'+label+'<select name="'+name+'"><option value="">Wird geladen …</option></select></label>';
   panel.innerHTML='<section class="sales-article-detail-card article-history-card"><header><div><h3>'+title+'</h3><p>'+(kind==='sales'?'Historische Einzelverkäufe · Standard: letztes Jahr · Preise und Rohertrag je Stück':'Gebuchte Umlagerungen des Artikels · Standard: letzte 90 Tage')+'</p></div></header><form class="article-history-filters"><div><span>Zeitraum</span><button type="button" data-period-button disabled>Zeitraum wird geladen …</button><input type="hidden" name="dateFrom"><input type="hidden" name="dateTo"></div>'+(kind==='sales'?branch('locationId','Filiale')+'<label>MA / Personalnummer<input name="personnel" maxlength="160" autocomplete="off" placeholder="z. B. 252"></label>':branch('fromLocationId','Von Filiale')+branch('toLocationId','Zu Filiale'))+'<button type="submit" class="secondary-button">Aktualisieren</button></form><p class="article-history-status" role="status">Wird geladen …</p><p class="article-history-note"></p><div class="article-history-results"></div><div class="article-history-pagination"><button type="button" data-history-prev>Zurück</button><span></span><button type="button" data-history-next>Weitere</button></div></section>';
   const state={kind,panel,form:panel.querySelector('form'),status:panel.querySelector('[role=status]'),note:panel.querySelector('.article-history-note'),results:panel.querySelector('.article-history-results'),rows:[],all:[],sort:'date',direction:'desc',offset:0,next:null,resultSet:'',busy:false,ticket:0,loaded:false,cursors:[]};states[kind]=state;
   on(state.form,'submit',e=>{e.preventDefault();void loadHistory(state,true);});
   if(kind==='sales')on(state.form,'input',syncReceiptPrint);
   on(panel.querySelector('[data-history-next]'),'click',()=>{if(kind==='sales'){state.cursors.push(state.next);void loadHistory(state,false,state.next);}else{state.offset+=50;renderHistory(state);}});
   on(panel.querySelector('[data-history-prev]'),'click',()=>{if(kind==='sales'){state.cursors.pop();void loadHistory(state,false,state.cursors.at(-1)||'');}else{state.offset=Math.max(0,state.offset-50);renderHistory(state);}});
   return state;
  }
  function renderHistory(state){
   const {kind,panel}=state;if(!authorized())return;
   syncReceiptPrint();
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
   syncReceiptPrint();
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
  let pdf=null,pdfPreparing=null,pdfConfig=null,pdfWrites=Promise.resolve();
  async function openPdf(){
   if(!authorized()||!active())return;
   root.querySelector('[data-article-print-status]')?.remove();
   if(pdf?.state.open){pdf.activate();return;}
   if(pdfPreparing)return pdfPreparing;
   pdfPreparing=(async()=>{
    try{
     const ctx=await ensureContext();if(!authorized())return;
     if(!pdfConfig)pdfConfig=await request('/api/sales/articles/tools/pdf-options');
     if(!authorized()||!active())return;
     if(!pdf)pdf=pdfWindow(ctx);
     pdf.open({payload:{ctx,config:{...pdfConfig}},values:{title:'Artikel '+article.articleNumber,filename:'Artikel-'+article.articleNumber,orientation:'landscape'}});
    }catch(error){if(authorized()&&active()){const notice=root.ownerDocument.createElement('p');notice.dataset.articlePrintStatus='';notice.className='sales-article-detail-message';notice.setAttribute('role','alert');notice.textContent='Druckfenster konnte nicht geöffnet werden: '+error.message;root.prepend(notice);}}
    finally{pdfPreparing=null;}
   })();return pdfPreparing;
  }
  function pdfWindow(ctx){
   const doc=root.ownerDocument,win=doc.defaultView,exportModel=win.GrabenplanerTradeExport;
   return win.GpPrintWindow.mount({document:doc,id:'article-sheet-pdf',title:'Artikelstammblatt als PDF',key:accessKey,canUse:authorized,active,windowPreferences,scale,trigger,
    defaults:{title:'Artikel '+article.articleNumber,filename:'Artikel-'+article.articleNumber,orientation:'landscape'},
    renderOptions(host,{payload}){
     host.innerHTML='<fieldset class="article-sheet-sections"><legend>Bereiche im Stammblatt</legend>'+Object.entries(sectionLabels).map(([id,label])=>'<label><input type="checkbox" name="section" value="'+id+'"'+(['master','prices','notes'].includes(id)?' checked':'')+((id==='sales'&&!ctx.sales||id==='movements'&&!ctx.movements)?' disabled':'')+'>'+label+'</label>').join('')+'</fieldset><label><input type="checkbox" name="image"'+(article.image?.present?' checked':' disabled')+'>Artikelfoto einfügen'+(article.image?.present?'':' (kein Foto vorhanden)')+'</label><details><summary>Dateinamen erweitern</summary><div class="article-sheet-naming"><label>Zeitblock<select name="stamp"><option value="date-time">JJMMTT-HHMM</option><option value="date">JJMMTT</option><option value="date-suffix">JJMMTT-xxx</option><option value="none">Ohne Zeitblock</option></select></label><label>Anordnung<select name="position"><option value="before">Vorne</option><option value="after">Hinten</option></select></label><label>Ergänzung (xxx)<input name="suffix" maxlength="40"></label><label>Trennzeichen<select name="separator"><option value="-">Bindestrich</option><option value="_">Unterstrich</option><option value=" ">Leerzeichen</option></select></label></div></details><p class="gp-print-hint">Historien übernehmen die zuletzt gestarteten Filter. Ohne eigene Auswahl: 90 Tage für Umlagerungen, ein Jahr für Verkäufe. Höchstens die neuesten 1.000 Einträge je Historie; begrenzte Ergebnisse werden im PDF gekennzeichnet.</p>';
     for(const [name,value]of Object.entries(payload.config)){const input=host.querySelector('[name="'+name+'"]');if(input)input.value=value;}
    },
    readOptions(host){return {sections:[...host.querySelectorAll('[name=section]:checked:not(:disabled)')].map(input=>input.value),includeImage:host.querySelector('[name=image]').checked,...Object.fromEntries(['stamp','position','separator','suffix'].map(name=>[name,host.querySelector('[name="'+name+'"]').value]))};},
    validateOptions:options=>options.sections.length?'':'Bitte mindestens einen Bereich auswählen.',
    async createPdf({values,options,signal}){
     const config=Object.fromEntries(['stamp','position','separator','suffix'].map(name=>[name,options[name]]));
     const specification={articleNumber:article.articleNumber,...options,title:values.title,name:values.filename,orientation:values.orientation};
     for(const kind of ['movements','sales'])if(options.sections.includes(kind))specification[kind]=states[kind]?.filters||historyDefaults(kind,ctx.today);
     const response=await rawApi('/api/sales/articles/sheet.pdf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(specification),signal});
     if(!response.ok)throw Error('Das Stammblatt konnte nicht erstellt werden.');
     const blob=await response.blob();if(!authorized()||signal.aborted)throw new DOMException('Abgebrochen','AbortError');
     pdfWrites=pdfWrites.catch(()=>{}).then(async()=>{
      if(!authorized()||signal.aborted||JSON.stringify(config)===JSON.stringify(pdfConfig))return;
      await request('/api/sales/articles/tools/pdf-options',config);
      if(authorized()&&!signal.aborted)pdfConfig={...config};
     });
     await pdfWrites;
     if(!authorized()||signal.aborted)throw new DOMException('Abgebrochen','AbortError');
     const disposition=response.headers.get('Content-Disposition')||'',encoded=/filename\*=UTF-8''([^;]+)/i.exec(disposition),plain=/filename="([^"]+)"/i.exec(disposition);
     let filename=exportModel.filename(values.filename,config);
     if(encoded){try{filename=decodeURIComponent(encoded[1]);}catch{}}else if(plain)filename=plain[1];
     return {blob,filename,summary:options.sections.length+' Bereiche'};
    }
   });
  }
  return {activate(id){if(!authorized())return;if(id==='salesArticleNotesSection'&&!localNotes)void loadNotes();if(id==='salesArticleMovementsSection'||id==='salesArticleSalesSection'){const state=history(id==='salesArticleSalesSection'?'sales':'movements');if(!state.loaded&&!state.busy)void loadHistory(state,true);}},openPdf,syncPrint(){if(active())pdf?.activate();else pdf?.deactivate();syncReceiptPrint();},destroy(){disposed=true;pdf?.destroy();receiptPdf?.destroy();for(const state of Object.values(states)){state.ticket++;state.period?.close();}notePeriod?.close();for(const remove of listeners)remove();tables?.destroy();for(const dialog of dialogs){if(dialog?.open)dialog.close();dialog?.remove();}}};
 }
 return {mount,movementColumns,noteColumns,sectionLabels,display,historyDefaults,historyFilterKeys};
});
