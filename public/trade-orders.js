(function(host,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(host)host.GrabenplanerTradeOrders=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const parts=['header','positions','distribution','receipts'],titles={header:'Bestellkopf',positions:'Positionen',distribution:'Filialverteilung',receipts:'Wareneingänge / Umlagerungen'};
 const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const abort=()=>Object.assign(new Error('Die Auswahl oder Anmeldung hat sich geändert.'),{name:'AbortError'});
 function createController({api,key=()=>'',session=()=>null,canUse=()=>true,pageActive=()=>true,change=()=>{}}){
  let owner=key(),ownerSession=session(),epoch=0,disposed=false,requests=new Set(),detailGeneration=0,searchGeneration=0;
  const initial=()=>({active:false,query:{query:'',mode:'exact',locationId:''},context:null,rows:[],next:null,coverage:null,sources:{},sourceRevision:null,selected:null,part:'header',detail:null,detailRows:[],detailNext:null,busy:false,detailBusy:false,message:'Bestellnummer eingeben oder gespeicherte Bestellungen durchsuchen.',error:false});
  let state=initial();const emit=()=>change(state);
  const cancel=(includeContext=true)=>{if(includeContext)epoch++;for(const request of requests)if(includeContext||request.kind!=='context'){request.abort();requests.delete(request);}state.busy=false;state.detailBusy=false;};
  function sync(){if(owner!==key()||ownerSession!==session()){cancel();owner=key();ownerSession=session();state=initial();emit();return false;}if(!canUse()&&state.active){cancel();state=initial();emit();return false;}return true;}
  function allowed(){return !disposed&&sync()&&state.active&&pageActive()&&canUse()&&(!state.context||state.context.projection?.purchasing===true);}
  async function read(kind,body,valid){
   if(!allowed())throw abort();const actor=owner,stamp=epoch,pending=new AbortController();pending.kind=kind;requests.add(pending);
   try{const result=await api('/api/trade-insights/'+kind,{...(body?{method:'POST',body:JSON.stringify(body)}:{}),signal:pending.signal});
    if(!allowed()||actor!==owner||stamp!==epoch||pending.signal.aborted||!valid())throw abort();return result;
   }finally{requests.delete(pending);}
  }
  function abortDetails(){for(const pending of requests)if(pending.kind==='order-detail'){pending.abort();requests.delete(pending);}}
  function clearDetail(){abortDetails();detailGeneration++;state.selected=null;state.detail=null;state.detailRows=[];state.detailNext=null;state.detailBusy=false;}
  function setQuery(query){if(!sync())return;cancel(false);searchGeneration++;clearDetail();state.query={query:String(query.query??''),mode:query.mode==='exact'?'exact':'contains',locationId:String(query.locationId??'')};state.rows=[];state.next=null;state.coverage=null;state.sourceRevision=null;state.message='Suchangaben geändert. Suche starten.';state.error=false;emit();}
  async function search({more=false}={}){
   if(!allowed()||more&&(!state.next||state.busy))return;
   if(!more){cancel(false);clearDetail();state.rows=[];state.next=null;state.coverage=null;}
   const generation=++searchGeneration,query={...state.query},previousRevision=state.sourceRevision,cursor=more?state.next:null;
   state.busy=true;state.message='Gespeicherte Bestellungen werden geprüft …';state.error=false;emit();
   try{const result=await read('orders',{...query,...(cursor?{cursor}:{})},()=>generation===searchGeneration);
    if(more&&previousRevision!==result.sourceRevision)throw Object.assign(new Error('Der Importstand hat sich geändert. Bitte neu suchen.'),{code:'IMPORT_HISTORY_ANALYSIS_CHANGED'});
    state.rows=more?[...state.rows,...result.rows]:result.rows;state.next=result.next;state.coverage=result.coverage;state.sources=result.sources;state.sourceRevision=result.sourceRevision;
    state.message=!result.available?'Die Bestellquelle ist noch nicht verfügbar.':result.next?'Teilstand: weitere gespeicherte Einträge können geladen werden.':state.rows.length?'Alle zugänglichen gespeicherten Treffer dieser Suche wurden geprüft.':'Keine zugänglichen Treffer im vollständig geprüften Suchumfang.';
   }catch(error){if(error.name!=='AbortError'&&allowed()&&generation===searchGeneration){state.rows=[];state.next=null;state.coverage=null;state.sourceRevision=null;state.message=error.message;state.error=true;}}
   finally{if(allowed()&&generation===searchGeneration){state.busy=false;emit();}}
  }
  async function detail(part='header',{more=false}={}){
   if(!allowed()||!state.selected||!parts.includes(part)||more&&(!state.detailNext||state.detailBusy))return;
   abortDetails();const selected={...state.selected},sourceRevision=state.sourceRevision,generation=++detailGeneration,cursor=more?state.detailNext:null;
   state.part=part;state.detailBusy=true;if(!more){state.detail=null;state.detailRows=[];state.detailNext=null;}emit();
   try{const result=await read('order-detail',{orderId:selected.id,orderRevision:selected.revision,sourceRevision,part,...(cursor?{cursor}:{})},()=>generation===detailGeneration&&state.selected?.id===selected.id);
    if(result.sourceRevision!==sourceRevision)throw new Error('Der Importstand hat sich geändert. Bitte neu suchen.');
    state.detail=result;state.detailRows=more?[...state.detailRows,...result.rows]:result.rows;state.detailNext=result.next;
   }catch(error){if(error.name!=='AbortError'&&allowed()&&generation===detailGeneration){clearDetail();state.sourceRevision=null;state.rows=[];state.next=null;state.coverage=null;state.message=error.message;state.error=true;emit();}}
   finally{if(allowed()&&generation===detailGeneration){state.detailBusy=false;emit();}}
  }
  async function open(row){if(!allowed()||!state.rows.some(r=>r.id===row.id&&r.revision===row.revision))return;clearDetail();state.selected=row;return detail('header');}
  async function activate(){sync();if(disposed||!canUse()||!pageActive())return;cancel();state.active=true;state.context=null;state.rows=[];state.next=null;state.coverage=null;state.sourceRevision=null;clearDetail();const stamp=epoch;emit();
   try{const context=await read('context',null,()=>epoch===stamp);state.context=context;if(context.projection?.purchasing!==true){cancel(false);clearDetail();state.rows=[];state.next=null;state.sourceRevision=null;state.message='Für Bestellungen fehlt die Freigabe.';state.error=true;emit();return;}emit();if(!state.busy&&!state.coverage&&(state.query.query||state.query.mode==='contains'))await search();}
   catch(error){if(error.name!=='AbortError'&&allowed()){state.message=error.message;state.error=true;emit();}}
  }
  function suspend(){state.active=false;cancel();searchGeneration++;clearDetail();state.rows=[];state.next=null;state.coverage=null;state.sourceRevision=null;emit();}
  return {activate,suspend,search,detail,open,setQuery,sync,getState:()=>state,cancelDetail(){abortDetails();detailGeneration++;state.detailBusy=false;},closeDetail(){clearDetail();emit();},destroy(){suspend();disposed=true;requests.clear();}};
 }
 const labels={BestellNr:'Bestellnummer',Suchname:'Lieferant',Bestelldatum:'Bestelldatum',BFirma:'Firma',BA1:'Bestelladresse 1',BA2:'Bestelladresse 2',BA3:'Bestelladresse 3',BLand:'Land',BPLZ:'Postleitzahl',BORT:'Ort',LFilialID:'Lieferfiliale',LPLZ:'Liefer-PLZ',LOrt:'Lieferort',erledigt:'Quellstatus erledigt',Lieferungbis:'Lieferung bis',Valuta:'Valuta',LAbteilung:'Lieferabteilung',SBestellnr:'Weitere Bestellreferenz',gedruckt:'Quellstatus gedruckt',Brabatt:'Rabatt',HBestellNr:'Hauptbestellreferenz',BestellId:'Positionsschlüssel',EAN:'Artikelreferenz (EAN)',BArtikelbezeichnung:'Artikelbezeichnung',BMenge:'Bestellmenge',gMenge:'Kumulierte Liefermenge',BBestellnummer:'Lieferanten-Artikelnummer',Bbestelldaten:'Bestelldaten',BVK:'Verkaufspreis',VKNetto:'Netto-VK',bBestelleinheit:'Bestelleinheit',BListeneckpreis:'Listeneckpreis',BRechnungspreis:'Rechnungspreis',BNettoNettoPreis:'Netto-Netto-Preis',Artikeltext:'Artikeltext',Zusatz2:'Zusatztext',bsuchname:'Suchname zur Position',FilialID:'Filiale',Artikelbezeichnung:'Artikelbezeichnung',Menge:'Quellmenge',GelMenge:'Gelieferte Menge',Liefermenge:'Liefermenge',Bestand:'Bestand',Bestellt:'Bestellt',We_ID:'Buchungsschlüssel',We:'Wareneingangskennzeichen',Umlagerung:'Umlagerungskennzeichen',WEDatum:'Buchungsdatum',AkWeDatum:'Zusatzdatum',Bestellnr:'Bestellreferenz',Lieferscheinnr:'Lieferscheinreferenz (ungeprüft)',Rechnungsnr:'Rechnungsreferenz (ungeprüft)',KorbId:'Korbverweis (ungeprüft)',NNPreis:'Netto-Netto-Preis',Rechnungspreis:'Rechnungspreis',BEmail:'Bestell-E-Mail',BTelefon:'Bestelltelefon',BTelefax:'Bestellfax',LFName:'Liefername',LStraße:'Lieferstraße',Text1:'Bestelltext 1',Text2:'Bestelltext 2',KundenNummer:'Quellkundennummer',Kund_nr:'Weitere Quellkundennummer',LAdresszusatz:'Lieferadresszusatz',LTelefon:'Liefertelefon',LeMail:'Liefer-E-Mail',bezahlt:'Quellstatus bezahlt',Zahldatum:'Zahldatum',Zahlungsziel:'Zahlungsziel',zahlbetrag:'Zahlbetrag',BKostenträgercode:'Kostenträgercode',Direktlieferung:'Direktlieferung'};
 const value=v=>v==null||v===''?'Nicht hinterlegt':typeof v==='boolean'?v?'Ja':'Nein':String(v);
 const date=v=>v?String(v).replace('T',' ').replace(/\.000Z?$/,''):'Nicht hinterlegt';
 function fieldList(fields){return '<dl class="trade-orders-fields">'+Object.entries(fields||{}).map(([key,v])=>'<div><dt>'+escape(labels[key]||key)+'</dt><dd>'+escape(value(v))+'</dd></div>').join('')+'</dl>';}
 function mount(root,{api,key=()=>'',session=()=>null,canUse=()=>true,active=()=>true}={}){
  if(!root||typeof api!=='function')throw new TypeError('Bestellungen benötigen den GP-Arbeitsbereich und die GP-API.');
  root.innerHTML='<header class="trade-orders-intro"><div><span class="trade-stock-eyebrow">Logistik</span><h2>Bestellungen</h2><p>Originale BE-Nummer suchen und gespeicherte Bestellinformationen nachvollziehen.</p></div><span class="trade-data-badge">Gespeicherte Quelldaten</span></header><form data-orders="filters" class="trade-orders-filters"><label>Bestellnummer / Suchtext<input name="query" maxlength="256" autocomplete="off" placeholder="z. B. BE-12345"></label><label>Suchart<select name="mode"><option value="exact">Bestellnummer exakt</option><option value="contains">Bestellungen durchsuchen</option></select></label><label>Lieferstelle<select name="locationId"><option value="">Alle freigegebenen Stellen</option></select></label><button type="submit">Suche starten</button></form><p data-orders="status" role="status" aria-live="polite"></p><p class="trade-orders-note">Vollständig bezeichnet die zugängliche gespeicherte Historie im freigegebenen Filialumfang. Aktuell offene Aufträge und Live-Lieferstände sind daraus nicht belegt.</p><section data-orders="results" class="trade-orders-results" aria-label="Bestellungen"></section><button type="button" data-orders="more" hidden>Weitere Einträge prüfen</button><dialog class="modal trade-order-detail-modal" data-orders="dialog" data-gp-window-mode="workspace" data-gp-window-rich data-gp-window-id="logistics:order-detail" aria-label="Bestellung"><div class="modal-header"><h2 data-orders="title">Bestellung</h2><button type="button" data-orders="close" aria-label="Bestellung schließen">×</button></div><div data-orders="tabs" role="tablist" aria-label="Bestellabschnitte">'+parts.map(part=>'<button type="button" data-part="'+part+'" role="tab" aria-controls="orderDetailPanel">'+titles[part]+'</button>').join('')+'</div><p data-orders="detail-status" role="status" aria-live="polite"></p><div id="orderDetailPanel" data-orders="detail" role="tabpanel"></div><button type="button" data-orders="detail-more" hidden>Weitere Einträge des Abschnitts prüfen</button></dialog>';
  const q=name=>root.querySelector('[data-orders="'+name+'"]'),form=q('filters'),dialog=q('dialog'),listeners=[];let controller,context=null,lastRows=null,lastDetail=null,sort='orderNumber',direction='asc';
  const owner=key(),ownerSession=session(),tableLayout=globalThis.GrabenplanerTradeTables?.mount({api:async(path,body)=>{
   const valid=()=>key()===owner&&session()===ownerSession&&canUse()&&active();if(!valid())throw abort();
   const result=await api('/api/trade-insights/'+path,body?{method:'POST',body:JSON.stringify(body)}:{});if(!valid())throw abort();return result;
  }});
  const on=(node,type,fn)=>{node.addEventListener(type,fn);listeners.push(()=>node.removeEventListener(type,fn));};
  function render(state){
   root.hidden=!state.active;q('status').textContent=state.message;q('status').classList.toggle('error',state.error);form.querySelector('button').disabled=state.busy||Boolean(state.context&&state.context.projection?.purchasing!==true);
   if(context!==state.context){context=state.context;const locations=context?.purchasingLocations||context?.locations||[];form.elements.locationId.innerHTML='<option value="">Alle freigegebenen Stellen</option>'+locations.map(l=>'<option value="'+escape(l.id)+'">'+escape(l.label)+'</option>').join('');}
   for(const name of ['query','mode','locationId'])if(form.elements[name].value!==state.query[name])form.elements[name].value=state.query[name];
   q('more').hidden=!state.next;q('more').disabled=state.busy;
   if(lastRows!==state.rows){lastRows=state.rows;tableLayout?.clear(q('results'));
    const sorted=[...state.rows].sort((a,b)=>String(sort==='location'?a.locationId||a.sourceLocation:a[sort]??'').localeCompare(String(sort==='location'?b.locationId||b.sourceLocation:b[sort]??''),'de')*(direction==='desc'?-1:1));
    q('results').innerHTML=sorted.length?'<div class="trade-orders-table-scroll"><table><thead><tr>'+[['orderNumber','Bestellnummer'],['supplier','Lieferant'],['date','Bestelldatum'],['location','Lieferstelle'],['sourceDate','Quellstand']].map(([key,label])=>'<th scope="col" aria-sort="'+(sort===key?direction==='asc'?'ascending':'descending':'none')+'"><button type="button" data-sort="'+key+'">'+label+(sort===key?direction==='asc'?' ↑':' ↓':' ↕')+'</button></th>').join('')+'<th scope="col">Details</th></tr></thead><tbody>'+sorted.map(row=>'<tr><td><strong>'+escape(row.orderNumber)+'</strong>'+(row.matchMode==='be_alias'?'<small>BE-Suchalias</small>':'')+'</td><td>'+escape(row.supplier||'Nicht hinterlegt')+'</td><td>'+escape(date(row.date))+'</td><td>'+escape(row.locationId||row.sourceLocation||'Nicht zugeordnet')+'</td><td>'+escape(date(row.sourceDate))+'</td><td><button type="button" data-order-id="'+escape(row.id)+'">Öffnen</button></td></tr>').join('')+'</tbody></table></div>':'';
    if(sorted.length)tableLayout?.attach(q('results'),'orders');
   }
   if(!state.selected){if(dialog.open)dialog.close();lastDetail=null;q('detail').replaceChildren();return;}
   q('title').textContent='Bestellung '+state.selected.orderNumber;dialog.setAttribute('aria-label','Bestellung '+state.selected.orderNumber);
   globalThis.GpWindow?.prepare(dialog);if(!dialog.open)dialog.showModal();
   for(const tab of q('tabs').querySelectorAll('[data-part]')){const selected=tab.dataset.part===state.part;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;tab.disabled=state.detailBusy;}
   q('detail-more').hidden=!state.detailNext;q('detail-more').disabled=state.detailBusy;
   const result=state.detail;q('detail-status').textContent=state.detailBusy?'Abschnitt wird geprüft …':!result?'':!result.available?'Für diesen Abschnitt fehlt eine vollständig übernommene Quelle.':result.next?'Teilstand · weitere Einträge laden.':'Zugängliche gespeicherte Einträge dieses Abschnitts vollständig geprüft.';
   if(lastDetail!==result||result?.part!=='header'){lastDetail=result;
    q('detail').innerHTML=!result?'':state.part==='header'?'<p>Lieferant: <strong>'+escape(result.order.supplier||'Nicht hinterlegt')+'</strong> · Quellstand '+escape(date(result.order.sourceDate))+'</p>'+fieldList(result.order.fields)+'<p class="trade-orders-note">Weitere Angaben werden entsprechend deinen Kontakt-, Kosten- und Finanzrechten angezeigt. Nicht hinterlegte Felder sind im Import leer.</p>':state.detailRows.map(row=>'<article class="trade-orders-entry"><h3>'+escape(state.part==='positions'?'Position '+row.positionId:state.part==='distribution'?'Position '+row.positionId+' · Filiale '+(row.locationId||row.sourceLocation):'Buchung '+row.movementNumber)+'</h3>'+(row.quantityState==='negative'?'<p class="trade-orders-warning">Negative Quellmenge · Grund ungeklärt</p>':'')+fieldList(row.fields)+(row.endpoints?'<p>Von: '+escape(row.endpoints.from?.sourceId??'Lieferant / nicht freigegeben')+' · Nach: '+escape(row.endpoints.to?.sourceId??'Nicht freigegeben')+'</p>':'')+'<small>Quellstand '+escape(date(row.sourceDate))+'</small></article>').join('')+(result.issues&&(result.issues.unresolvedPositions||result.issues.articleConflicts)?'<p class="trade-orders-warning">Verknüpfung prüfen: '+result.issues.unresolvedPositions+' fehlende / abweichende Positionen, '+result.issues.articleConflicts+' abweichende Artikelreferenzen. Diese Zeilen werden nicht als bestätigte Verteilung ausgegeben.</p>':'')+(result.note?'<p class="trade-orders-note">'+escape(result.note)+'</p>':'');
   }
  }
  controller=createController({api,key,session,canUse,pageActive:active,change:render});
  const query=()=>({query:form.elements.query.value,mode:form.elements.mode.value,locationId:form.elements.locationId.value});
  on(form,'submit',event=>{event.preventDefault();controller.setQuery(query());void controller.search();});
  on(form,'input',()=>controller.setQuery(query()));on(form,'change',()=>controller.setQuery(query()));
  on(q('more'),'click',()=>void controller.search({more:true}));on(q('detail-more'),'click',()=>void controller.detail(controller.getState().part,{more:true}));
  on(q('results'),'click',event=>{const column=event.target.closest('[data-sort]')?.dataset.sort;if(column){direction=sort===column&&direction==='asc'?'desc':'asc';sort=column;lastRows=null;render(controller.getState());return;}const id=event.target.closest('[data-order-id]')?.dataset.orderId,row=controller.getState().rows.find(r=>r.id===id);if(row){if(dialog.open)globalThis.GpWindow?.prepare(dialog)?.activate();globalThis.GpWindow?.begin(dialog);void controller.open(row);}});
  on(q('tabs'),'click',event=>{const part=event.target.closest('[data-part]')?.dataset.part;if(part)void controller.detail(part);});
  on(q('tabs'),'keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;const current=parts.indexOf(event.target.dataset.part);if(current<0)return;event.preventDefault();const index=event.key==='Home'?0:event.key==='End'?parts.length-1:(current+(event.key==='ArrowRight'?1:-1)+parts.length)%parts.length;void controller.detail(parts[index]);q('tabs').querySelector('[data-part="'+parts[index]+'"]').focus();});
  on(q('close'),'click',()=>controller.closeDetail());on(dialog,'cancel',()=>controller.cancelDetail());on(dialog,'close',()=>{if(controller.getState().active&&controller.getState().selected)controller.closeDetail();});
  return {...controller,activate(){tableLayout?.activate();return controller.activate();},suspend(){controller.suspend();tableLayout?.suspend();},destroy(){controller.destroy();tableLayout?.destroy();for(const remove of listeners)remove();root.replaceChildren();}};
 }
 return {createController,mount,parts,titles,fieldList};
});
