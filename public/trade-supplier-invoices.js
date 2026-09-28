(function(host,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(host)host.GrabenplanerSupplierInvoices=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const numberFormatter=new Intl.NumberFormat('de-AT',{maximumFractionDigits:4});
 const moneyFormatter=new Intl.NumberFormat('de-AT',{style:'currency',currency:'EUR',maximumFractionDigits:2});
 const number=v=>v==null?'–':numberFormatter.format(Number(v));
 const money=v=>v==null?'–':moneyFormatter.format(Number(v));
 const date=v=>v?String(v).slice(0,10).split('-').reverse().join('.'):'–';
 const columns=[['created','Anlegedatum'],['booked','Buchdatum'],['number','Rechnungsnummer'],['supplier','Lieferant'],['quantity','Menge'],['priceMin','EK netto']];
 const collator=new Intl.Collator('de-AT',{numeric:true,sensitivity:'base'});
 function sorted(rows,key='booked',direction='desc'){
  return [...rows].sort((a,b)=>{const x=a[key],y=b[key];if(x==null||y==null)return x==null?(y==null?0:1):-1;
   const c=['quantity','priceMin','price','netNet'].includes(key)?Number(x)-Number(y):collator.compare(String(x),String(y));return (direction==='asc'?c:-c)||collator.compare(a.id,b.id);});
 }
 const price=row=>row.priceMin==null?'–':row.priceMin===row.priceMax?money(row.priceMin):money(row.priceMin)+' – '+money(row.priceMax);
 function copyText(article,row){return 'Artikel: '+article.number+' · '+article.label+'\nLieferant: '+row.supplier+' ('+row.supplierCode+')\nRechnungsnummer: '+row.number+'\nAnlegedatum: '+date(row.created)+'\nBuchdatum: '+date(row.booked)+'\nMenge: '+number(row.quantity);}
 function mount(root,{api,today=()=>new Date().toISOString().slice(0,10)}={}){
  root.classList.add('supplier-invoices');
  root.innerHTML=`<header><h2>Lieferantenrechnungen</h2><p>Rechnungsnummern für Reparatur, Austausch oder Gutschrift finden – einschließlich der Belege aus dem Zentrallager.</p></header>
   <form data-si="search" class="si-search"><label>Artikelnummer oder Bezeichnung<input name="query" maxlength="150" autocomplete="off" placeholder="z. B. 0000000077888 oder Fernglas" required></label><button type="submit" class="primary-button">Artikel suchen</button></form>
   <p class="si-hint">Suche im GP-Artikelkatalog. Für historische Artikel ohne Katalogeintrag bitte die vollständige Artikelnummer eingeben.</p>
   <p data-si="status" role="status" aria-live="polite"></p><div data-si="candidates"></div>
   <section data-si="selection" hidden><div data-si="article" class="si-article"></div>
   <form data-si="filters" class="si-filters"><label>Datum für Zeitraum<select name="dateField" aria-label="Datum für Zeitraum"><option value="booked">Buchdatum</option><option value="created">Anlegedatum</option></select></label><div class="trade-period-field"><span>Zeitraum</span><button type="button" data-si="period">Zeitraum auswählen</button><input type="hidden" name="dateFrom"><input type="hidden" name="dateTo"></div><button type="submit">Liste aktualisieren</button></form>
   <p data-si="summary"></p><div data-si="results" class="table-scroll"></div>
   <p class="si-hint">EK netto entspricht dem Rechnungspreis je Stück. Negative Mengen können Rücknahmen oder Korrekturen sein. Original-PDFs sind in dieser Datenbank nicht enthalten.</p></section>
   <dialog data-si="detail" class="modal si-detail" aria-labelledby="supplierInvoiceDetailTitle"><div class="modal-header"><h2 id="supplierInvoiceDetailTitle" data-si="detail-title">Rechnungspositionen</h2><button type="button" data-si="close" aria-label="Dialog schließen">×</button></div><div data-si="positions"></div></dialog>`;
  const q=k=>root.querySelector('[data-si="'+k+'"]'),form=q('search'),filters=q('filters'),listeners=[];
  let active=false,generation=0,selected='',data=null,key='booked',direction='desc',detailRow=null,detailKey='id',detailDirection='asc';
  const on=(node,type,fn)=>{node.addEventListener(type,fn);listeners.push(()=>node.removeEventListener(type,fn));};
  const period=globalThis.GrabenplanerTradePeriod.mount(root,filters,q('period'),{today});
  function render(){
   const a=data?.article;q('selection').hidden=!a;if(!a)return;
   q('article').innerHTML='<div><strong class="si-number">'+escape(a.number)+'</strong><h3>'+escape(a.label)+'</h3>'+(!a.current?'<small>Historischer Artikel · kein aktueller Artikelstamm</small>':'')+'</div><div class="si-prices"><span>VK brutto<strong>'+money(a.saleGross)+'</strong></span>'+(data.costs?'<span>Durchschnitts-EK netto<strong>'+money(a.averageNet)+'</strong></span>':'')+'</div>';
   q('summary').textContent=number(data.rows.length)+' Rechnungen · Importstand '+date(data.sourceDate)+(filters.elements.dateFrom.value?' · Zeitraum nach '+(filters.elements.dateField.value==='booked'?'Buchdatum':'Anlegedatum'):' · Gesamter Zeitraum');
   const cols=columns.filter(([k])=>k!=='priceMin'||data.costs);
   q('results').innerHTML=data.rows.length?'<table><thead><tr>'+cols.map(([k,label])=>'<th aria-sort="'+(key===k?(direction==='asc'?'ascending':'descending'):'none')+'"><button type="button" data-si-sort="'+k+'">'+label+' '+(key===k?(direction==='asc'?'↑':'↓'):'↕')+'</button></th>').join('')+'<th>Aktionen</th></tr></thead><tbody>'+sorted(data.rows,key,direction).map(r=>'<tr>'+cols.map(([k])=>'<td>'+(['created','booked'].includes(k)?date(r[k]):k==='priceMin'?price(r)+(r.priceMissing?'<small>Preis teilweise nicht hinterlegt</small>':''):k==='quantity'?number(r.quantity)+(r.negative?'<small>Enthält negative Mengen</small>':''):k==='number'?'<strong>'+escape(r.number)+'</strong>':escape(r[k]))+'</td>').join('')+'<td class="si-actions"><button type="button" data-si-copy="'+escape(r.id)+'">Kopieren</button><button type="button" data-si-detail="'+escape(r.id)+'">Positionen ('+r.positions.length+')</button></td></tr>').join('')+'</tbody></table>':'<p>Keine Rechnungen für diesen Artikel im gewählten Zeitraum.</p>';
  }
  async function load(number){
   const ticket=++generation;selected=number;q('status').textContent='Rechnungen werden geladen …';q('selection').hidden=true;
   try{const value=await api('supplier-invoices',{articleNumber:number,dateFrom:filters.elements.dateFrom.value,dateTo:filters.elements.dateTo.value,dateField:filters.elements.dateField.value});
    if(!active||ticket!==generation)return;data=value;render();q('status').textContent=!value.available?'Noch keine Lieferantenrechnungen übernommen. Bitte TRADE_AusgangsRech.accdb unter Einstellungen → Datenbankimporte hochladen und übernehmen.':!value.article?'Artikel nicht gefunden.':'Rechnungen geladen.';
   }catch(err){if(active&&ticket===generation&&err.name!=='AbortError'){data=null;q('selection').hidden=true;q('status').textContent=err.message;}}
  }
  on(form,'submit',async event=>{event.preventDefault();const query=form.elements.query.value.trim();if(!query)return;
   const ticket=++generation;selected='';data=null;q('selection').hidden=true;q('candidates').replaceChildren();q('status').textContent='Artikel werden gesucht …';
   try{const value=await api('supplier-invoices',{query});if(!active||ticket!==generation)return;
    q('status').textContent=!value.available?'Noch keine Lieferantenrechnungen übernommen. Bitte TRADE_AusgangsRech.accdb unter Einstellungen → Datenbankimporte hochladen und übernehmen.':value.articles.length?(value.more?'Erste 30 Treffer. Bitte die Suche bei Bedarf eingrenzen.':'Artikel auswählen.'):'Keine passenden Artikel gefunden.';
    q('candidates').innerHTML='<div class="si-candidates">'+value.articles.map(a=>'<button type="button" data-si-article="'+escape(a.number)+'"><strong>'+escape(a.number)+'</strong><span>'+escape(a.label)+'</span></button>').join('')+'</div>';
    const exact=value.articles.find(a=>a.number===query);if(exact||value.articles.length===1){q('candidates').replaceChildren();await load((exact||value.articles[0]).number);}
   }catch(err){if(active&&ticket===generation&&err.name!=='AbortError')q('status').textContent=err.message;}
  });
  on(q('candidates'),'click',e=>{const b=e.target.closest('[data-si-article]');if(b){q('candidates').replaceChildren();void load(b.dataset.siArticle);}});
  on(filters,'submit',e=>{e.preventDefault();if(selected)void load(selected);});
  on(filters,'change',()=>{if(selected)void load(selected);});
  on(q('results'),'click',async e=>{
   const sort=e.target.closest('[data-si-sort]');if(sort){direction=key===sort.dataset.siSort&&direction==='asc'?'desc':'asc';key=sort.dataset.siSort;render();q('results').querySelector('[data-si-sort="'+key+'"]').focus();return;}
   const copy=e.target.closest('[data-si-copy]'),detail=e.target.closest('[data-si-detail]');const row=data?.rows.find(r=>r.id===(copy?.dataset.siCopy||detail?.dataset.siDetail));if(!row)return;
   if(copy){const ticket=generation,text=copyText(data.article,row);try{await navigator.clipboard.writeText(text);if(!active||ticket!==generation)return;q('status').textContent='Rechnungsangaben kopiert.';}catch{if(!active||ticket!==generation)return;q('detail-title').textContent='Rechnungsangaben kopieren';q('status').textContent='Bitte die Angaben im Dialog markieren und kopieren.';q('positions').innerHTML='<label>Rechnungsangaben zum Kopieren<textarea readonly rows="8">'+escape(text)+'</textarea></label>';q('detail').showModal();q('positions').querySelector('textarea').select();}return;}
   detailRow=row;detailKey='id';detailDirection='asc';renderPositions();q('detail').showModal();
  });
  function renderPositions(){
   q('detail-title').textContent='Rechnungspositionen';
   const cols=[['location','Filiale'],['quantity','Menge'],...(data.costs?[['price','EK netto'],['netNet','NN-Preis']]:[]),['delivery','Lieferschein'],['movement','WE-ID']];
   q('positions').innerHTML='<p><strong>'+escape(detailRow.number)+'</strong> · '+escape(detailRow.supplier)+'</p><div class="table-scroll"><table><thead><tr>'+cols.map(([k,label])=>'<th aria-sort="'+(detailKey===k?(detailDirection==='asc'?'ascending':'descending'):'none')+'"><button type="button" data-si-position-sort="'+k+'">'+label+' '+(detailKey===k?(detailDirection==='asc'?'↑':'↓'):'↕')+'</button></th>').join('')+'</tr></thead><tbody>'+sorted(detailRow.positions,detailKey,detailDirection).map(p=>'<tr>'+cols.map(([k])=>'<td>'+(k==='quantity'?number(p[k]):['price','netNet'].includes(k)?money(p[k]):escape(p[k]))+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
  }
  on(q('positions'),'click',e=>{const b=e.target.closest('[data-si-position-sort]');if(!b)return;detailDirection=detailKey===b.dataset.siPositionSort&&detailDirection==='asc'?'desc':'asc';detailKey=b.dataset.siPositionSort;renderPositions();q('positions').querySelector('[data-si-position-sort="'+detailKey+'"]').focus();});
  on(q('close'),'click',()=>q('detail').close());
  function suspend(){active=false;generation++;period.close();if(q('detail').open)q('detail').close();}
  return {activate(){active=true;if(selected)void load(selected);},suspend,destroy(){suspend();for(const off of listeners)off();root.replaceChildren();}};
 }
 return {mount,sorted,copyText,escape};
});
