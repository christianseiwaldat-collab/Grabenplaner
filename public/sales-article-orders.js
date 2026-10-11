(function(host,factory){const value=factory();if(typeof module==='object'&&module.exports)module.exports=value;if(host)host.SalesArticleOrders=value;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const columns=[['orderNumber','BE-Nummer'],['date','Bestelldatum'],['supplier','Lieferant'],['status','Status'],['ordered','Bestellt'],['delivered','Geliefert (kumuliert)'],['remaining','Restmenge'],['location','Filiale'],['kind','Zeilenart'],['sourceDate','Datenstand']];
 function mount(root,{api,articleNumber,key=()=>'',canUse=()=>true,onOrder=()=>{}}={}){
  let active=false,disposed=false,epoch=0,pending=null,rows=[],next=null,loaded=false,busy=false,message='Bestellinformationen werden beim Öffnen geladen.',sort='date',direction='desc';
  const owner=key(),valid=()=>!disposed&&active&&canUse()&&key()===owner;
  root.innerHTML='<header><h3>Bestellungen zu diesem Artikel</h3><p>Bestellpositionen und Filialzuweisungen aus den freigegebenen Datenständen.</p></header><p data-article-orders="status" role="status" aria-live="polite"></p><div data-article-orders="table" class="trade-orders-table-scroll"></div><button type="button" data-article-orders="more" hidden>Weitere Einträge prüfen</button><button type="button" data-article-orders="refresh">Aktualisieren</button><p data-article-orders="note" class="trade-orders-note"></p>';
  const q=name=>root.querySelector('[data-article-orders="'+name+'"]');
  const layout=globalThis.GrabenplanerTradeTables?.mount({api:async(path,body)=>{if(!valid())throw Error('Die Artikelauswahl hat sich geändert.');const result=await api('/api/trade-insights/'+path,body?{method:'POST',body:JSON.stringify(body)}:{});if(!valid())throw Error('Die Artikelauswahl hat sich geändert.');return result;}});
  function render(){
   q('status').textContent=message;q('more').hidden=!next;q('more').disabled=busy;q('refresh').disabled=busy;
   layout?.clear(q('table'));
   const field=(row,id)=>id==='location'?row.locationId||row.sourceLocation:row[id];
   const sorted=[...rows].sort((a,b)=>String(field(a,sort)??'').localeCompare(String(field(b,sort)??''),'de',{numeric:true})*(direction==='desc'?-1:1));
   q('table').innerHTML=!sorted.length?'':'<table class="gp-table"><thead><tr>'+columns.map(([id,label])=>'<th scope="col" aria-sort="'+(sort===id?direction==='asc'?'ascending':'descending':'none')+'"><button type="button" data-sort="'+id+'">'+label+'</button></th>').join('')+'</tr></thead><tbody>'+sorted.map(row=>'<tr>'+columns.map(([id])=>'<td>'+(id==='orderNumber'?'<button type="button" class="text-button" data-article-order-id="'+esc(row.id)+'">'+esc(row.orderNumber)+'</button>':esc(field(row,id)??'—'))+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
   if(sorted.length)layout?.attach(q('table'),'article-orders',{onSort(saved,dir){if(sort===saved&&direction===dir)return;sort=saved;direction=dir;render();}});
  }
  async function load(more=false){
   if(!valid()||busy||more&&!next)return;pending?.abort();pending=new AbortController();const signal=pending.signal,ticket=++epoch,cursor=more?next:null;
   if(!more){rows=[];next=null;loaded=false;}busy=true;message='Bestellinformationen werden geprüft …';render();
   try{const result=await api('/api/trade-insights/article-orders',{method:'POST',body:JSON.stringify({articleNumber,...(cursor?{cursor}:{})}),signal});
    if(!valid()||signal.aborted||ticket!==epoch)return;
    rows=more?[...rows,...result.rows]:result.rows;next=result.next;loaded=true;q('note').textContent=result.note||'';
    message=result.coverage?.state==='article_link_unconfirmed'?result.note:!result.available?'Die Bestellquelle ist noch nicht verfügbar.':next?'Teilstand · '+rows.length+' Einträge geladen. Weitere Einträge prüfen.':rows.length+' Einträge · zugängliche gespeicherte Bestellinformationen vollständig geprüft.';
   }catch(error){if(valid()&&!signal.aborted&&ticket===epoch){message=error.message;next=null;if(!more)rows=[];loaded=false;}}
   finally{if(valid()&&ticket===epoch){busy=false;render();}}
  }
  const click=event=>{const id=event.target.closest('[data-article-order-id]')?.dataset.articleOrderId;if(id){const row=rows.find(row=>row.id===id);if(row)onOrder(row);return;}const column=event.target.closest('[data-sort]')?.dataset.sort;if(column){direction=sort===column&&direction==='asc'?'desc':'asc';sort=column;layout?.setSort('article-orders',sort,direction);render();}};
  const more=()=>void load(true),refresh=()=>void load();root.addEventListener('click',click);q('more').addEventListener('click',more);q('refresh').addEventListener('click',refresh);
  return {activate(){active=true;layout?.activate();render();if(!loaded)void load();},suspend(){active=false;epoch++;pending?.abort();busy=false;layout?.suspend();},destroy(){this.suspend();disposed=true;layout?.destroy();root.removeEventListener('click',click);q('more').removeEventListener('click',more);q('refresh').removeEventListener('click',refresh);root.replaceChildren();}};
 }
 return {mount,columns};
});
