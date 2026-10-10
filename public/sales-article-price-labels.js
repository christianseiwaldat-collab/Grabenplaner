(function(host,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(host)host.SalesArticlePriceLabels=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const columns={title:'Speichername',creator:'Erstellt von',format:'Format',updated:'Aktualisiert'};
 function templateIntent(articleNumber,template){
  if(typeof articleNumber!=='string'||!articleNumber.trim()||articleNumber.length>80||/[\u0000-\u001f\u007f]/u.test(articleNumber))throw new TypeError('Ungültige Artikelnummer.');
  if(template&&(typeof template.id!=='string'||!template.id))throw new TypeError('Ungültige Vorlage.');
  return {articleNumber:articleNumber.trim(),templateId:template?.id||'',copy:Boolean(template&&(template.received!==false||template.canEdit!==true))};
 }
 const format=template=>template.options.labelWidthMm+' × '+template.options.labelHeightMm+' mm';
 const date=value=>Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('de-AT',{dateStyle:'short',timeStyle:'short'}).format(new Date(value)):'–';
 function downloadName(disposition,fallback){
  const encoded=/filename\*=UTF-8''([^;]+)/i.exec(disposition||''),quoted=/filename="([^"\\]+)"/i.exec(disposition||'');
  try{
   // Only filename* defines Unicode encoding. A non-ASCII legacy filename can
   // already be corrupted in transit; retain the locally generated name then.
   const supplied=encoded?decodeURIComponent(encoded[1]):quoted&&/^[\x20-\x7e]+$/u.test(quoted[1])?quoted[1]:'';
   if(supplied&&!/[\u0000-\u001f\u007f/\\]/u.test(supplied))return supplied;
  }catch{/* Invalid encoding keeps the safely generated fallback. */}
  return fallback;
 }
 function mount(root,{api,rawApi,article,accessKey=()=>'',onOpen=()=>{},windowPreferences}){
  const owner=accessKey(),articleNumber=templateIntent(article.articleNumber).articleNumber;
  let disposed=false,active=false,generation=0,templates=[],busy=false,sort='updated',direction='desc',pdfSelection=null,pdfReady=false;
  const controllers=new Set(),listeners=[];
  const authorized=ticket=>!disposed&&active&&root.isConnected&&accessKey()===owner&&(ticket===undefined||ticket===generation);
  const on=(node,type,fn)=>{node.addEventListener(type,fn);listeners.push(()=>node.removeEventListener(type,fn));};
  const tables=globalThis.GrabenplanerTradeTables?.mount({api:(path,body)=>{
   if(!authorized())return Promise.reject(Object.assign(new Error('Ansicht nicht mehr aktiv.'),{name:'AbortError'}));
   return api('/api/sales/articles/tools/'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  }});
  root.classList.add('sales-article-price-labels');
  root.innerHTML='<section class="sales-article-detail-card sapl-card"><header><div><h3>Preisschilder</h3><p>Gespeicherte Gestaltungen mit den aktuellen Preisen dieses Artikels.</p></div></header><div class="sapl-content"><button type="button" class="text-button sapl-create" data-sapl="create">Preisschild für diesen Artikel erstellen</button><p class="sapl-note">Eigene Vorlagen kannst du bearbeiten. Andere freigegebene Vorlagen werden als eigener Entwurf geöffnet; das Original bleibt erhalten.</p><p class="sapl-status" role="status" aria-live="polite">Vorlagen werden geladen …</p><div class="sapl-results"></div></div></section>';
  const status=root.querySelector('[role=status]'),results=root.querySelector('.sapl-results'),create=root.querySelector('[data-sapl=create]');
  const Labels=typeof module==='object'&&module.exports?require('./sales-price-labels'):globalThis.GrabenplanerSalesPriceLabels;
  function currentTemplate(value,id) {
   if(!value||String(value.id)!==String(id)||!Number.isInteger(value.version)||value.version<1)throw Error('Die gespeicherte Vorlage ist nicht verfügbar. Bitte neu laden.');
   return {template:value,options:Labels.normalizeOptions(value.options)};
  }
  const pdfPrint=root.ownerDocument.defaultView.GpPriceLabelPdf.mount({
   host:root,id:'sales-article-price-label-pdf',title:'Artikel-Preisschild · PDF',key:accessKey,rawApi,windowPreferences,
   active:()=>active&&pdfReady&&!disposed&&root.isConnected,
   canUse:()=>!disposed&&root.isConnected&&Boolean(owner)&&accessKey()===owner
    &&(!pdfSelection||templates.some(value=>value.id===pdfSelection.id&&value.version===pdfSelection.version)),
   context:()=>JSON.stringify([owner,articleNumber,pdfSelection?.id,pdfSelection?.version]),
   async validateResponse(payload,_response,signal){
    const fresh=currentTemplate(await api('/api/sales/price-labels/library/'+encodeURIComponent(payload.metadata.id),{signal}),payload.metadata.id);
    if(fresh.template.version!==payload.metadata.version)throw Error('Die Vorlage wurde inzwischen geändert. Bitte neu laden.');
   },
  });
  function render(){
   tables?.clear(results);
   const rows=templates.slice().sort((a,b)=>{const value=key=>key==='creator'?(a.creator?.label||''):(key==='format'?format(a):key==='updated'?a.updatedAt||'':a[key]||'');const other=key=>key==='creator'?(b.creator?.label||''):(key==='format'?format(b):key==='updated'?b.updatedAt||'':b[key]||'');return value(sort).localeCompare(other(sort),'de',{numeric:true})*(direction==='asc'?1:-1)||a.id.localeCompare(b.id);});
   results.innerHTML='<div class="sapl-table-scroll"><table class="sales-article-history-table"><thead><tr>'+Object.entries(columns).map(([key,label])=>'<th scope="col" aria-sort="'+(sort===key?(direction==='asc'?'ascending':'descending'):'none')+'"><button type="button" data-sort="'+key+'">'+label+' <span aria-hidden="true">'+(sort===key?(direction==='asc'?'↑':'↓'):'↕')+'</span></button></th>').join('')+'<th scope="col">PDF</th></tr></thead><tbody>'+rows.map(template=>'<tr><td><button type="button" class="text-button" data-sapl-open="'+escape(template.id)+'">'+escape(template.title)+'</button><small>'+(template.received?'Freigegeben · als Kopie öffnen':'Eigene Vorlage')+'</small></td><td>'+escape(template.creator?.label||'–')+'</td><td>'+escape(format(template))+'</td><td>'+escape(date(template.updatedAt))+'</td><td><button type="button" class="text-button" data-sapl-pdf="'+escape(template.id)+'" aria-label="'+escape(template.title+' als PDF für Artikel '+articleNumber)+'">PDF</button></td></tr>').join('')+'</tbody></table></div>';
   if(!rows.length)results.insertAdjacentHTML('beforeend','<p class="sapl-empty">Noch keine gespeicherten Vorlagen für dein Konto oder deine Filiale verfügbar.</p>');
   tables?.attach(results,'article-price-labels');
  }
  async function open(template){
   if(!authorized()||busy)return;busy=true;create.disabled=true;const ticket=generation;
   try{await onOpen(templateIntent(articleNumber,template));}
   catch(error){if(authorized(ticket))status.textContent=error.message;}
   finally{if(authorized(ticket)){busy=false;create.disabled=false;}}
  }
  async function download(template,target){
   if(!authorized()||busy)return;const ticket=generation,controller=new AbortController();controllers.add(controller);busy=true;create.disabled=true;status.textContent='Preisschild wird mit dem aktuellen Artikelpreis erstellt …';
   pdfPrint.reset();pdfSelection=null;pdfReady=false;
   try{
    const fresh=currentTemplate(await api('/api/sales/price-labels/library/'+encodeURIComponent(template.id),{signal:controller.signal}),template.id);
    if(!authorized(ticket)||controller.signal.aborted||!templates.some(value=>value.id===template.id))return;
    templates=templates.map(value=>value.id===template.id?fresh.template:value);render();
    pdfSelection={id:fresh.template.id,version:fresh.template.version};pdfReady=true;
    const name=globalThis.GrabenplanerTradeExport?.filename(fresh.template.title+'-'+articleNumber,fresh.template.filenameOptions)||'Preisschild-'+articleNumber+'.pdf';
    pdfPrint.activate();pdfPrint.open({url:'/api/sales/price-labels/library/'+encodeURIComponent(template.id)+'/article.pdf',
     body:{articleNumber},filename:name,dimensions:{...Labels.paperLayout(fresh.options),labels:[{width:fresh.options.labelWidthMm,height:fresh.options.labelHeightMm}]},metadata:pdfSelection},target);
    status.textContent='PDF-Vorschau mit aktuellen Artikelpreisen geöffnet. Beim Drucken „Tatsächliche Größe“ wählen.';
   }catch(error){if(authorized(ticket)&&error.name!=='AbortError')status.textContent=error.message;}
   finally{controllers.delete(controller);if(authorized(ticket)){busy=false;create.disabled=false;}}
  }
  on(create,'click',()=>{void open(null);});
  on(results,'click',event=>{
   const button=event.target.closest('[data-sort],[data-sapl-open],[data-sapl-pdf]');if(!button||!authorized()||busy)return;
   if(button.dataset.sort){direction=sort===button.dataset.sort&&direction==='asc'?'desc':'asc';sort=button.dataset.sort;render();return;}
   const template=templates.find(item=>item.id===(button.dataset.saplOpen||button.dataset.saplPdf));if(!template)return;
   if(button.dataset.saplOpen)void open(template);else void download(template,button);
  });
  return {
   async activate(){
    if(disposed||accessKey()!==owner)return;pdfPrint.deactivate();pdfReady=false;active=true;const ticket=++generation;for(const c of controllers)c.abort();controllers.clear();tables?.activate();busy=false;create.disabled=false;status.textContent='Vorlagen werden geladen …';
    const controller=new AbortController();controllers.add(controller);
    try{const data=await api('/api/sales/price-labels/library',{signal:controller.signal});if(!authorized(ticket))return;templates=(Array.isArray(data.templates)?data.templates:[]).filter(item=>item?.id&&item.options);
     if(pdfSelection&&!templates.some(value=>value.id===pdfSelection.id&&value.version===pdfSelection.version)){pdfPrint.reset();pdfSelection=null;}
     render();pdfReady=true;pdfPrint.sync();pdfPrint.activate();status.textContent=templates.length+' gespeicherte Vorlage'+(templates.length===1?'':'n')+' · Artikel '+articleNumber;}
    catch(error){if(authorized(ticket)&&error.name!=='AbortError'){templates=[];pdfPrint.reset();pdfSelection=null;tables?.clear(results);results.replaceChildren();status.textContent=error.message;}}
    finally{controllers.delete(controller);}
   },
   syncPrint(){pdfPrint.sync();},
   suspend(){pdfPrint.deactivate();pdfReady=false;active=false;generation++;busy=false;for(const c of controllers)c.abort();controllers.clear();tables?.suspend();},
   destroy(){this.suspend();disposed=true;pdfPrint.destroy();tables?.destroy();for(const off of listeners)off();templates=[];root.replaceChildren();},
  };
 }
 return {mount,templateIntent,columns,downloadName};
});
