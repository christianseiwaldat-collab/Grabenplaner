(function(host,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(host)host.GrabenplanerArticleHistory=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const labels={current:'Artikelstamm',archived:'Archiviert',ambiguous:'Zuordnung prüfen',missing:'Keine Artikelreferenz',outside_period:'Außerhalb des belegten Zeitraums',period_unknown:'Historischer Zeitraum ungeklärt',source_pending:'Artikelimport läuft'};
 const date=v=>v?String(v).slice(0,10).split('-').reverse().join('.'):'Nicht hinterlegt';
 const badge=r=>`<span class="article-history-badge" data-state="${esc(r.status)}">${esc(labels[r.status]||'Zuordnung prüfen')}</span>`;
 function provenance(r){return (r.candidates||[]).map(c=>`<section class="article-history-source"><h3>${esc(c.label||'Ohne Bezeichnung')}</h3><dl><dt>Herkunft</dt><dd>${esc(c.source)}</dd><dt>Artikelkennung</dt><dd>${esc(c.articleNumber)}</dd><dt>Sortiment</dt><dd>${esc(c.group||'Nicht hinterlegt')}</dd><dt>Angelegt</dt><dd>${esc(date(c.createdAt))}</dd>${c.origin==='archive'?`<dt>Im Archiv gelöscht</dt><dd>${esc(date(c.deletedAt))}</dd>`:''}<dt>Quellstand</dt><dd>${esc(c.snapshotAt?date(c.snapshotAt):'Im Artikelstamm nicht separat hinterlegt')}</dd><dt>Importiert</dt><dd>${esc(date(c.importedAt))}</dd></dl></section>`).join('');}
 function referenceMarkup(r,original=''){
  if(!r||r.status==='missing')return '';
  return `<details class="article-history-reference"><summary>${badge(r)} · Artikelreferenz</summary><p>Originaltext am Beleg: ${esc(original||'Nicht hinterlegt')}</p>${r.label?`<p>Ergänzende Bezeichnung: ${esc(r.label)}</p>`:''}${r.businessDate?`<p>Belegdatum: ${esc(date(r.businessDate))}</p>`:''}${provenance(r)}<p class="article-history-note">Ergänzende Anzeige. Die gespeicherte Artikelzuordnung, Preise und Umsatzwerte bleiben unverändert.</p></details>`;
 }
 function mount(root,{api,onMovements=null}){
  root.innerHTML=`<h2>Artikelhistorie</h2><p>Aktuelle und archivierte Artikelreferenzen finden. Herkunft und mögliche Mehrdeutigkeiten bleiben sichtbar.</p><form data-ah="form"><label>Artikelnummer, Bezeichnung oder Sortiment<input name="query" type="search" maxlength="150" autocomplete="off" placeholder="Artikel suchen …"></label><label>Suchart<select name="searchMode"><option value="text">Freie Suche</option><option value="exact">Artikelnummer exakt · schnell</option></select></label><label>Referenzen<select name="status"><option value="archived">Archivierte Artikel</option><option value="current">Aktueller Artikelstamm</option><option value="all">Alle Referenzen</option><option value="ambiguous">Zuordnung prüfen</option></select></label><button type="submit">Suchen</button><button type="button" data-ah="cancel" hidden>Suche anhalten</button></form><p data-ah="source" class="article-history-note"></p><p data-ah="status" role="status" aria-live="polite">Suchangaben wählen und Suche starten.</p><div data-ah="results"></div><button type="button" data-ah="more" hidden>Weitere Treffer laden</button><p class="article-history-note">Die Suche liest übernommene Artikelreferenzen. Archivierte Artikel werden nicht aktiviert. Führende Nullen bleiben Teil der Kennung.</p><dialog data-ah="dialog" aria-labelledby="articleHistoryDetailTitle"><form method="dialog" class="dialog-actions"><button>Schließen</button></form><h2 id="articleHistoryDetailTitle">Artikelreferenzen</h2><div data-ah="detail"></div><button type="button" data-ah="movements" hidden>Warenbewegungen zum Artikel</button></dialog>`;
  const q=k=>root.querySelector('[data-ah="'+k+'"]'),form=q('form');let generation=0,controller=null,items=[],cursor=null,scanned=0,selection=null,sort='articleNumber',direction=1,active=false;
  const collator=new Intl.Collator('de-AT',{numeric:true,sensitivity:'base'});
  function render(){
   const columns=[['articleNumber','Artikelnummer'],['label','Bezeichnung'],['group','Sortiment'],['status','Status'],['sourceLabel','Herkunft']];
   const sorted=items.map((r,index)=>({...r,index,sourceLabel:(r.candidates||[]).map(c=>c.source).join(' · ')})).sort((a,b)=>collator.compare(sort==='status'?labels[a.status]:a[sort]||'',sort==='status'?labels[b.status]:b[sort]||'')*direction);
   q('results').innerHTML=items.length?`<div class="table-scroll article-history-table" tabindex="0" role="region" aria-label="Artikelreferenzen"><table><thead><tr>${columns.map(([key,label])=>`<th scope="col" aria-sort="${sort===key?(direction===1?'ascending':'descending'):'none'}"><button type="button" data-ah-sort="${key}">${label} ${sort===key?(direction===1?'↑':'↓'):'↕'}</button></th>`).join('')}<th scope="col">Aktion</th></tr></thead><tbody>${sorted.map(r=>`<tr><td data-label="Artikelnummer">${esc(r.articleNumber)}</td><td data-label="Bezeichnung">${esc(r.status==='ambiguous'?'Mehrere Artikelreferenzen':r.label||'Ohne Bezeichnung')}</td><td data-label="Sortiment">${esc(r.group||'–')}</td><td data-label="Status">${badge(r)}</td><td data-label="Herkunft"><span>${(r.candidates||[]).map(c=>esc(c.source)).join('<br>')}</span></td><td data-label="Aktion"><button type="button" data-ah-detail="${r.index}">Details</button></td></tr>`).join('')}</tbody></table></div>`:'<p>Keine passenden Artikelreferenzen in den bisher geprüften Daten.</p>';
  }
  function stop(){generation++;controller?.abort();controller=null;q('cancel').hidden=true;form.querySelector('[type="submit"]').disabled=false;q('more').disabled=false;}
  async function search(more=false){
   stop();const ticket=generation;controller=new AbortController();const signal=controller.signal;
   if(!more){items=[];cursor=null;scanned=0;selection=Object.fromEntries(new FormData(form));q('results').replaceChildren();q('source').textContent='';}
   q('status').textContent='Artikelreferenzen werden geprüft …';
   const target=items.length+50;form.querySelector('[type="submit"]').disabled=true;q('cancel').hidden=false;q('more').hidden=true;
   try{
    do{
     const result=await api('article-history',{...selection,...(cursor?{cursor}: {})},signal);if(ticket!==generation||!active)return;
     const seen=new Set(items.map(r=>r.articleNumber));items.push(...result.rows.filter(r=>!seen.has(r.articleNumber)));cursor=result.next;scanned+=result.scanned;
     q('source').textContent='Übernommene Quellen: '+[result.sources?.currentImports?'Artikelstamm':null,result.sources?.archiveImports?'WEUM-Artikelarchiv':null].filter(Boolean).join(' · ');
     render();q('status').textContent=items.length+' Treffer · '+scanned+' Referenzen geprüft'+(cursor?' · Suche läuft …':' · Suche vollständig.');
     if(!result.available){q('source').textContent='Noch keine passende Datenbank übernommen.';q('status').textContent='Bitte zuerst Artikelstamm oder WEUM unter Einstellungen → Datenbankimporte übernehmen.';break;}
    }while(cursor&&items.length<target);
    q('more').hidden=!cursor;
    if(cursor)q('status').textContent=items.length+' Treffer · '+scanned+' Referenzen geprüft · weitere Daten verfügbar. Sortierung betrifft die geladenen Treffer.';
   }catch(error){if(ticket===generation&&error.name!=='AbortError'){items=[];cursor=null;q('results').replaceChildren();q('status').textContent=error.message;}}
   finally{if(ticket===generation){controller=null;q('cancel').hidden=true;form.querySelector('[type="submit"]').disabled=false;}}
  }
  form.onsubmit=e=>{e.preventDefault();if(active)void search();};
  form.oninput=()=>{q('status').textContent='Auswahl geändert. Bitte neu suchen.';stop();cursor=null;items=[];q('results').replaceChildren();q('source').textContent='';q('more').hidden=true;};
  q('cancel').onclick=()=>{stop();q('status').textContent='Suche angehalten · '+items.length+' Treffer aus '+scanned+' geprüften Referenzen. Ergebnis noch unvollständig.';q('more').hidden=!cursor;};
  q('more').onclick=()=>{if(active)void search(true);};
  q('results').onclick=e=>{
   const detail=e.target.closest('[data-ah-detail]'),header=e.target.closest('[data-ah-sort]');
   if(header){direction=sort===header.dataset.ahSort?-direction:1;sort=header.dataset.ahSort;render();q('results').querySelector('[data-ah-sort="'+sort+'"]').focus();}
   if(detail){const r=items[Number(detail.dataset.ahDetail)];q('detail').innerHTML=badge(r)+provenance(r)+(r.status==='ambiguous'?'<p class="article-history-note">Die Kennung kommt in mehreren Quellen vor. Es wurde keine automatische Zuordnung vorgenommen.</p>':'')+'<p class="article-history-note">Referenzen zum angezeigten Suchstand. Es werden keine Preise oder Bestände aus dem Artikelarchiv übernommen.</p>';q('movements').hidden=!onMovements;q('movements').onclick=()=>{q('dialog').close();onMovements?.(r.articleNumber);};q('dialog').showModal();}
  };
  return {activate(query){active=true;if(query!==undefined){form.elements.query.value=query;form.elements.status.value='all';void search();}},suspend(){active=false;if(controller){q('status').textContent='Suche angehalten. Weitere Treffer laden oder neu suchen.';q('more').hidden=!cursor;}stop();if(q('dialog').open)q('dialog').close();},destroy(){active=false;stop();root.replaceChildren();}};
 }
 return {mount,referenceMarkup,labels,provenance};
});
