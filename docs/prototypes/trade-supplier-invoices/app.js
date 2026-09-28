'use strict';
const $=id=>document.getElementById(id),escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=value=>value?value.split('-').reverse().join('.'):'Nicht hinterlegt';
const money=value=>value==null?'–':Number(value).toLocaleString('de-AT',{style:'currency',currency:'EUR'});
const quantity=value=>value==null?'Fehlt':Number(value).toLocaleString('de-AT',{maximumFractionDigits:8});
const labels={created:'Anlegedatum',booked:'Buchdatum',number:'Rechnungsnr.',supplier:'Lieferant',quantity:'Menge',priceMin:'EK netto'};
let current=null,visible=[],sort='booked',direction=-1,generation=0,controller=null,toastTimer;
const period=GrabenplanerTradePeriod.mount($('workspace'),$('filters'),$('period'));
function notify(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,3500);}
async function api(route,signal){const response=await fetch(route,{signal,cache:'no-store'}),data=await response.json();if(!response.ok)throw Error(data.error||'Die Daten konnten nicht geladen werden.');return data;}
function begin(){controller?.abort();controller=new AbortController();return {ticket:++generation,signal:controller.signal};}
function price(row){return row.mixedPrice?money(row.priceMin)+' – '+money(row.priceMax):money(row.priceMin);}
function render(){
 if(!current)return;
 const from=$('filters').elements.dateFrom.value,to=$('filters').elements.dateTo.value,basis=$('basis').value;
 visible=current.rows.filter(r=>!from&&!to||r[basis]&&(!from||r[basis]>=from)&&(!to||r[basis]<=to));
 visible.sort((a,b)=>{const av=a[sort],bv=b[sort];if(av==null)return bv==null?0:1;if(bv==null)return -1;const n=['quantity','priceMin'].includes(sort)?Number(av)-Number(bv):String(av).localeCompare(String(bv),'de-AT',{numeric:true});return n*direction||a.supplierCode.localeCompare(b.supplierCode)||a.number.localeCompare(b.number);});
 for(const button of document.querySelectorAll('[data-sort]')){const selected=sort===button.dataset.sort;button.textContent=labels[button.dataset.sort]+' '+(selected?(direction===1?'↑':'↓'):'↕');button.closest('th').setAttribute('aria-sort',selected?(direction===1?'ascending':'descending'):'none');}
 $('count').textContent=visible.length;$('result-note').textContent=(sort==='booked'&&direction===-1?'Neueste Buchung zuerst':'Sortiert nach '+labels[sort]+' · '+(direction===1?'aufsteigend':'absteigend'));
 $('rows').innerHTML=visible.length?visible.map((r,i)=>`<tr><td>${escape(date(r.created))}</td><td>${escape(date(r.booked))}</td><td><span class="invoice-number">${escape(r.number)}</span>${r.negative?'<span class="sub negative">Enthält negative Menge</span>':''}</td><td class="supplier">${escape(r.supplier)}<span class="sub">${escape(r.supplierCode)}</span></td><td class="numeric ${r.negative?'negative':''}">${escape(quantity(r.quantity))}</td><td class="numeric">${escape(price(r))}${r.mixedPrice?'<span class="sub">Mehrere EK-Preise</span>':''}${r.priceMissing?'<span class="sub">Preis teilweise nicht hinterlegt</span>':''}</td><td><div class="actions"><button type="button" data-copy="${i}" aria-label="Rechnung ${escape(r.number)} kopieren">Kopieren</button><button type="button" data-details="${i}" aria-label="Positionen zu Rechnung ${escape(r.number)} anzeigen">${r.positions.length} Pos.</button></div></td></tr>`).join(''):'<tr><td colspan="7" class="empty">'+(current.rows.length?'Keine Rechnungen im gewählten Zeitraum.':'Für diesen Artikel sind keine Rechnungen in dieser Quelle hinterlegt.')+'</td></tr>';
 const unknown=current.rows.filter(r=>!r[basis]).length;
 $('filter-status').textContent=`${visible.length} von ${current.rows.length} Rechnungen`+(from||to?` · nach ${labels[basis]}`:' · alle Zeiträume')+(unknown?` · ${unknown} ohne ${labels[basis]}${from||to?' außerhalb des Filters':''}`:'');$('copy-all').disabled=!visible.length;
}
async function select(number){
 const {ticket,signal}=begin();$('search-status').textContent='Rechnungen werden geladen …';$('result').hidden=true;
 try{const data=await api('/api/article?number='+encodeURIComponent(number),signal);if(ticket!==generation)return;current=data;sort='booked';direction=-1;
  $('article-number').textContent=data.article.number;$('article-label').textContent=data.article.label;$('article-badge').textContent=data.article.current?'':'· NUR IN RECHNUNGSHISTORIE';
  $('sale-price').textContent=money(data.article.saleGross);$('average-price').textContent=money(data.article.averageNet);$('matches').replaceChildren();$('search-status').textContent='';$('query').value=data.article.number;$('result').hidden=false;
  $('filters').elements.dateFrom.value='';$('filters').elements.dateTo.value='';period.sync();render();
 }catch(error){if(error.name!=='AbortError')$('search-status').textContent=error.message;}
}
$('search-form').addEventListener('submit',async event=>{
 event.preventDefault();const query=$('query').value.trim();if(!query)return;
 const {ticket,signal}=begin();$('search-status').textContent='Artikel werden gesucht …';$('matches').replaceChildren();$('result').hidden=true;current=null;
 try{const data=await api('/api/search?q='+encodeURIComponent(query),signal);if(ticket!==generation)return;
  const exact=data.articles.find(a=>a.number.toLocaleLowerCase()===query.toLocaleLowerCase());if(exact)return select(exact.number);
  if(data.articles.length===1)return select(data.articles[0].number);
  $('search-status').textContent=data.articles.length?(data.articles.length===30?'Die ersten 30 Treffer – bitte Artikel auswählen oder Suche verfeinern.':`${data.articles.length} Artikel gefunden – bitte auswählen.`):'Kein Artikel gefunden. Bitte Artikelnummer oder Bezeichnung prüfen.';
  $('matches').innerHTML=data.articles.map(a=>`<button type="button" class="match" data-article="${escape(a.number)}"><strong>${escape(a.number)}</strong><span>${escape(a.label)}</span><small>${a.invoiceCount} Rechnungen${a.current?'':' · Historie'}</small></button>`).join('');
 }catch(error){if(error.name!=='AbortError')$('search-status').textContent=error.message;}
});
$('matches').addEventListener('click',event=>{const button=event.target.closest('[data-article]');if(button)void select(button.dataset.article);});
$('filters').addEventListener('submit',event=>event.preventDefault());$('filters').elements.dateFrom.addEventListener('change',render);$('basis').addEventListener('change',render);
$('reset').addEventListener('click',()=>{$('filters').elements.dateFrom.value='';$('filters').elements.dateTo.value='';period.sync();render();});
document.querySelectorAll('[data-sort]').forEach(button=>button.addEventListener('click',()=>{if(sort===button.dataset.sort)direction*=-1;else{sort=button.dataset.sort;direction=['created','booked'].includes(sort)?-1:1;}render();}));
function copyText(r){return `Rechnung: ${r.number}\nLieferant: ${r.supplier} (${r.supplierCode})\nAnlegedatum: ${date(r.created)} · Buchdatum: ${date(r.booked)}\nArtikel: ${current.article.number} – ${current.article.label}\nMenge: ${quantity(r.quantity)} · EK netto: ${price(r)}\nBitte um eine Kopie der Rechnung.`;}
async function copy(value){try{await navigator.clipboard.writeText(value);notify('Rechnungsdaten kopiert');}catch{notify('Kopieren nicht möglich. Bitte Angaben direkt aus der Liste übernehmen.');}}
$('copy-all').addEventListener('click',()=>void copy(visible.map(copyText).join('\n\n')));
$('rows').addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button)return;
 if(button.dataset.copy!==undefined)return void copy(copyText(visible[Number(button.dataset.copy)]));
 if(button.dataset.details===undefined)return;const r=visible[Number(button.dataset.details)];$('detail-title').textContent='Rechnung '+r.number;
 $('detail-body').innerHTML=`<p><strong>${escape(r.supplier)}</strong><br>Anlegedatum ${escape(date(r.created))} · Buchdatum ${escape(date(r.booked))}</p><div class="table-scroll"><table><thead><tr><th>Menge</th><th>EK netto</th><th>NN-Preis</th><th>Lieferschein</th><th>Filiale</th></tr></thead><tbody>${r.positions.map(p=>`<tr><td>${escape(quantity(p.quantity))}</td><td>${escape(money(p.price))}</td><td>${escape(money(p.netNet))}</td><td>${escape(p.delivery||'–')}</td><td>${escape(p.location||'–')}</td></tr>`).join('')}</tbody></table></div><p class="hint">EK netto: Quellfeld „Rechnungspreis“ · NN-Preis: separates Quellfeld „NNPreis“, unverändert.</p>`;
 $('detail').showModal();
});
$('close-detail').addEventListener('click',()=>$('detail').close());
api('/api/meta').then(meta=>{$('source').textContent=`Trade · Datenstand ${date(meta.sourceDate)} · ${meta.headers.toLocaleString('de-AT')} Rechnungen`;$('query').focus();}).catch(error=>$('search-status').textContent=error.message);
