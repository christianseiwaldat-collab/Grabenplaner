(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.GrabenplanerArticleReport=api;})(typeof window==='object'?window:globalThis,function(){
  'use strict';
  const BASE='/api/sales/article-report', PAGE_SIZE=50;
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clone=value=>JSON.parse(JSON.stringify(value));
  function format(value,column={}) {
    if(value===null||value===undefined||value==='')return '–';
    if(['quantity','ordered','retailGross','internetGross','averageCost','marginPercent','stockValue'].includes(column.id)) {
      const n=Number(value);if(!Number.isFinite(n))return '–';
      const currency=['retailGross','internetGross','averageCost','stockValue'].includes(column.id);
      return new Intl.NumberFormat('de-AT',currency?{style:'currency',currency:'EUR'}:{maximumFractionDigits:2}).format(n)+(column.id==='marginPercent'?' %':'');
    }
    return String(value);
  }
  function filename(value){return String(value||'Artikel-Auswertung').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'-').replace(/\.pdf$/i,'').trim().slice(0,100)||'Artikel-Auswertung';}
  function mount(root,{api,rawApi,key,canUse,active,windowPreferences,scale,openArticle}) {
    if(!root)return null;
    const doc=root.ownerDocument,win=doc.defaultView;
    root.innerHTML='<section class="article-report-criteria" aria-label="Auswertung eingrenzen"><div class="article-report-section-title"><div><h2>Artikel auswählen</h2><p>Eine Zeile je Artikel und Filiale.</p></div><button type="button" data-report-retry class="text-button" hidden>Erneut laden</button></div><form data-report-form><div class="article-report-filter-grid"><label class="article-report-search">Artikelsuche<input type="search" name="query" maxlength="120" placeholder="Artikelnr. oder Bezeichnung" autocomplete="off"></label><label>Sortimentsart<select name="assortment" disabled></select></label><label>Bestand<select name="stock"><option value="positive">Nur Bestand &gt; 0</option><option value="all">Alle Bestände</option></select></label><button type="submit" class="primary-button" disabled>Auswerten</button></div><div class="article-report-filial-row"><details data-report-branches><summary>Filialen <span data-report-branch-count></span></summary><div class="article-report-branch-options" data-report-branch-options></div></details><div class="article-report-selected-branches" data-report-selected-branches></div></div></form><p class="article-report-status" role="status" aria-live="polite" data-report-status>Auswertung wird vorbereitet …</p></section><section class="article-report-results"><div class="article-report-results-toolbar"><div><h2>Ergebnisliste</h2><p data-report-result-count>Noch keine Auswertung</p></div><div class="article-report-table-actions"><details class="gp-table-layout-controls" data-report-columns><summary>Spaltenansicht</summary><div data-report-column-options></div></details><button type="button" class="secondary-button" data-report-pdf disabled>PDF exportieren</button></div></div><div class="article-report-table-scroll"><table aria-label="Artikelauswertung nach Filiale"><thead></thead><tbody><tr><td>Sortiment und Filialen wählen und „Auswerten“ anklicken.</td></tr></tbody></table></div><footer class="article-report-results-footer"><span data-report-source></span><span data-report-preference-status role="status"></span><div><button type="button" class="text-button" data-report-prev disabled>← Zurück</button><span data-report-page></span><button type="button" class="text-button" data-report-next disabled>Weiter →</button></div></footer><p class="article-report-metric-note">Bestand und bestellt: letzter importierter Filialstand. RE %: aktueller EH-Netto-VK gegenüber dem durchschnittlichen Netto-EK; kein historisch erzielter Rohertrag. Fehlende oder ungeklärte Werte werden als – angezeigt.</p></section>';
    const q=s=>root.querySelector(s),form=q('[data-report-form]'),status=q('[data-report-status]'),table=q('table');
    let actor=String(key()),epoch=0,dead=false,context=null,prefs=null,revision=0,prefsReady=false,write=Promise.resolve(),loading=null,hydrate=null,rows=[],total=0,offset=0,applied=null,dirty=false;
    const listeners=[],on=(node,type,fn)=>{node.addEventListener(type,fn);listeners.push(()=>node.removeEventListener(type,fn));};
    const valid=()=>!dead&&canUse()&&String(key())===actor;
    const visible=()=>valid()&&active();
    const columns=()=>context?.columns||[];
    const selected=()=>columns().filter(c=>prefs?.columns.includes(c.id)).sort((a,b)=>prefs.columns.indexOf(a.id)-prefs.columns.indexOf(b.id));
    const field=name=>form.elements.namedItem(name);
    function setStatus(message,error=false){status.textContent=message;status.classList.toggle('is-error',error);}
    function branches(){return [...q('[data-report-branch-options]').querySelectorAll('input:checked')].map(n=>n.value);}
    function filters(){return {query:field('query').value.trim(),assortment:field('assortment').value,locations:branches(),stock:field('stock').value,sort:prefs?.sort||'articleNumber',direction:prefs?.direction||'asc'};}
    function renderBranches(){const ids=branches(),locations=context?.locations||[];q('[data-report-branch-count]').textContent=`${ids.length} / ${locations.length}`;q('[data-report-selected-branches]').textContent=locations.filter(c=>ids.includes(c.id)).map(c=>c.label).join(' · ')||'Bitte mindestens eine Filiale auswählen.';}
    function chooser(){
      const ordered=[...selected(),...columns().filter(c=>!prefs.columns.includes(c.id))];
      q('[data-report-column-options]').innerHTML=ordered.map(c=>'<div><label><input type="checkbox" data-report-column="'+escape(c.id)+'" '+(prefs.columns.includes(c.id)?'checked':'')+' '+(!prefsReady||c.id==='articleNumber'||prefs.columns.length===1&&prefs.columns.includes(c.id)?'disabled':'')+'>'+escape(c.label)+'</label><button type="button" class="text-button" data-report-move="'+escape(c.id)+'" data-direction="-1" aria-label="'+escape(c.label)+' nach links" '+(!prefsReady||!prefs.columns.includes(c.id)||prefs.columns[0]===c.id?'disabled':'')+'>←</button><button type="button" class="text-button" data-report-move="'+escape(c.id)+'" data-direction="1" aria-label="'+escape(c.label)+' nach rechts" '+(!prefsReady||!prefs.columns.includes(c.id)||prefs.columns.at(-1)===c.id?'disabled':'')+'>→</button></div>').join('');
    }
    function render(){
      const cols=selected();if(!context||!prefs)return;
      q('thead').innerHTML='<tr>'+cols.map(c=>'<th aria-sort="'+(prefs.sort===c.id?(prefs.direction==='asc'?'ascending':'descending'):'none')+'"><button type="button" data-report-sort="'+escape(c.id)+'">'+escape(c.label)+(prefs.sort===c.id?(prefs.direction==='asc'?' ↑':' ↓'):'')+'</button><button type="button" role="slider" aria-label="'+escape(c.label)+' Spaltenbreite" aria-valuemin="80" aria-valuemax="800" data-gp-column-resize="'+escape(c.id)+'"></button></th>').join('')+'</tr>';
      q('tbody').innerHTML=rows.length?rows.map(row=>'<tr>'+cols.map(c=>'<td '+(['quantity','ordered','retailGross','internetGross','averageCost','marginPercent','stockValue'].includes(c.id)?'class="is-number"':'')+'>'+(c.id==='articleNumber'?'<button type="button" class="article-report-article-link" data-report-article="'+escape(row.articleNumber)+'">'+escape(format(row[c.id],c))+'</button>':escape(format(row[c.id],c)))+'</td>').join('')+'</tr>').join(''):'<tr><td colspan="'+cols.length+'" class="article-report-empty">'+(applied?'Keine Artikel für diese Auswahl.':'Sortiment und Filialen wählen und „Auswerten“ anklicken.')+'</td></tr>';
      q('[data-report-result-count]').textContent=applied?`${total.toLocaleString('de-AT')} Artikel-Filial-Zeilen${dirty?' · Filter geändert':''}`:'Noch keine Auswertung';
      q('[data-report-prev]').disabled=!valid()||Boolean(loading)||offset===0;q('[data-report-next]').disabled=!valid()||Boolean(loading)||offset+rows.length>=total;
      q('[data-report-page]').textContent=rows.length?`${offset+1}–${offset+rows.length} von ${total}`:'';
      q('[data-report-pdf]').disabled=!valid()||Boolean(loading)||!applied||!total||dirty;
      field('assortment').disabled=!valid()||!context.available;form.querySelector('[type=submit]').disabled=!valid()||!context.available||Boolean(loading);
      chooser();layout?.render();
    }
    const layout=win.GrabenplanerTableLayout.attach(table,{columns:selected,allowedColumns:()=>columns().map(c=>c.id),widths:()=>prefs?.columnWidths||{},canResize:()=>valid()&&prefsReady,change:value=>{prefs={...prefs,columnWidths:value};},persist});
    const print=win.GpPrintWindow.mount({document:doc,id:'article-report-pdf',title:'Artikel-Auswertung als PDF',key,canUse:valid,active,windowPreferences,scale,trigger:()=>q('[data-report-pdf]'),
      defaults:{title:'Artikel-Auswertung',filename:'Artikel-Auswertung',orientation:'landscape'},
      renderOptions(host,{payload}){
        const details=doc.createElement('details'),heading=doc.createElement('summary'),choices=doc.createElement('div');details.open=true;heading.textContent='Spalten im PDF';choices.dataset.reportPdfColumns='';
        for(const column of payload.columns){const label=doc.createElement('label'),input=doc.createElement('input');input.type='checkbox';input.value=column.id;input.checked=payload.selected.includes(column.id);label.append(input,doc.createTextNode(column.label));choices.append(label);}
        details.append(heading,choices);host.append(details);
      },
      readOptions:host=>({columns:[...host.querySelectorAll('input:checked')].map(input=>input.value)}),
      validateOptions:options=>options.columns.length?'':'Bitte mindestens eine Spalte wählen.',
      async createPdf({values,options,payload,signal}){
        const specification={filters:payload.filters,columns:options.columns,title:values.title.trim(),name:filename(values.filename),orientation:values.orientation};
        const response=await rawApi(BASE+'/pdf-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(specification),signal});
        if(!response.ok)throw Error('PDF-Ausgabe konnte nicht erstellt werden.');
        return {blob:await response.blob(),filename:specification.name,summary:`${response.headers.get('X-Report-Rows')||payload.total} Zeilen`};
      }
    });
    function synchronize(){if(actor!==String(key())||!canUse()){
      actor=String(key());epoch++;loading?.abort();loading=null;hydrate=null;print.reset();context=null;prefs=null;prefsReady=false;rows=[];total=0;offset=0;applied=null;dirty=false;field('query').value='';field('stock').value='positive';field('assortment').replaceChildren();field('assortment').disabled=true;q('[data-report-branch-options]').replaceChildren();q('thead').replaceChildren();q('tbody').innerHTML='<tr><td>Auswertung wird vorbereitet …</td></tr>';q('[data-report-result-count]').textContent='Noch keine Auswertung';q('[data-report-source]').textContent='';q('[data-report-selected-branches]').textContent='';q('[data-report-preference-status]').textContent='';q('[data-report-pdf]').disabled=true;form.querySelector('[type=submit]').disabled=true;q('[data-report-column-options]').replaceChildren();
    }}
    async function activate(){synchronize();print.activate();if(!visible())return;if(context)return;if(hydrate)return hydrate;
      const owner=actor,ticket=epoch;setStatus('Auswertung wird vorbereitet …');q('[data-report-retry]').hidden=true;
      hydrate=(async()=>{try{
        const next=await api(BASE+'/context');if(!valid()||owner!==actor||ticket!==epoch)return;context=next;
        prefs={columns:(context.defaultColumns||columns().map(c=>c.id)).filter(id=>columns().some(c=>c.id===id)),columnWidths:{},sort:'articleNumber',direction:'asc'};
        field('assortment').innerHTML='<option value="all">Alle Sortimentsarten</option>'+(context.sortiments||[]).filter(c=>c.id!=='all').map(c=>'<option value="'+escape(c.id)+'">'+escape(c.label)+'</option>').join('');field('assortment').value=(context.sortiments||[]).some(c=>c.id==='sellout')?'sellout':'all';
        q('[data-report-branch-options]').innerHTML=(context.locations||[]).map(c=>'<label><input type="checkbox" value="'+escape(c.id)+'" checked>'+escape(c.label)+'</label>').join('');
        try{const saved=await api(BASE+'/preferences');if(!valid()||owner!==actor||ticket!==epoch)return;prefs=saved.preferences;revision=saved.revision;prefsReady=true;q('[data-report-preference-status]').textContent='Ansicht gespeichert';}catch(error){if(!valid()||ticket!==epoch)return;q('[data-report-preference-status]').textContent='Ansicht nicht geladen: '+error.message;q('[data-report-retry]').hidden=false;}
        renderBranches();render();setStatus(context.available?'Auswahl festlegen und auswerten. Fehlende oder ungeklärte Werte bleiben leer.':'Noch kein vollständiger importierter Filialbestand vorhanden. Bitte nach dem Import erneut laden.');if(!context.available)q('[data-report-retry]').hidden=false;
      }catch(error){if(valid()&&ticket===epoch){context=null;setStatus(error.message,true);q('[data-report-retry]').hidden=false;}}finally{if(ticket===epoch)hydrate=null;}})();return hydrate;
    }
    function persist(){if(!valid()||!prefsReady)return;const snapshot=clone(prefs),owner=actor,ticket=epoch;q('[data-report-preference-status]').textContent='Ansicht wird gespeichert …';
      write=write.catch(()=>{}).then(async()=>{if(!valid()||ticket!==epoch||owner!==actor||!prefsReady)return;try{const saved=await api(BASE+'/preferences',{method:'PUT',body:JSON.stringify({revision,preferences:snapshot})});if(valid()&&ticket===epoch){revision=saved.revision;q('[data-report-preference-status]').textContent='Ansicht gespeichert';}}catch(error){if(valid()&&ticket===epoch){prefsReady=false;q('[data-report-preference-status]').textContent='Ansicht nicht gespeichert: '+error.message;q('[data-report-retry]').hidden=false;render();}}});
    }
    async function search(nextOffset=0,{useApplied=false}={}){
      if(!visible()||!context?.available)return;const query=useApplied&&applied?clone(applied):filters();if(!query.locations.length){setStatus('Bitte mindestens eine Filiale auswählen.',true);return;}
      loading?.abort();const request=new AbortController(),ticket=epoch;loading=request;print.reset();setStatus('Artikel und Filialbestände werden geladen …');render();
      const params=new URLSearchParams({...query,locations:query.locations.join(','),limit:String(PAGE_SIZE),offset:String(nextOffset)});
      try{const result=await api(BASE+'/query?'+params,{signal:request.signal});if(!valid()||ticket!==epoch||loading!==request||request.signal.aborted)return;
        rows=result.rows;total=result.total;offset=nextOffset;applied=query;dirty=JSON.stringify(filters())!==JSON.stringify(applied);q('[data-report-source]').textContent=result.sourceAt?'Datenstand: '+new Date(result.sourceAt).toLocaleString('de-AT'):'Datenstand nicht verfügbar';setStatus(dirty?'Filter geändert – bitte erneut auswerten.':'Ergebnis aus dem zuletzt übernommenen Datenstand.');
      }catch(error){if(valid()&&loading===request&&!request.signal.aborted){rows=[];total=0;applied=null;offset=0;setStatus(error.message,true);}}finally{if(loading===request){loading=null;render();}}
    }
    function openPdf(){if(!visible()||!total||dirty)return;const title=field('assortment').selectedOptions[0]?.textContent==='Abverkauf'?'Abverkauf nach Filiale':'Artikel-Auswertung';print.open({values:{title,filename:filename(title),orientation:'landscape'},payload:{filters:clone(applied),columns:clone(columns()),selected:[...prefs.columns],total}});}
    on(form,'submit',e=>{e.preventDefault();void search();});on(form,'change',()=>{renderBranches();if(applied){dirty=JSON.stringify(filters())!==JSON.stringify(applied);setStatus(dirty?'Filter geändert – bitte erneut auswerten.':'Ergebnis aus dem zuletzt übernommenen Datenstand.');render();}});on(field('query'),'input',()=>{if(applied){dirty=JSON.stringify(filters())!==JSON.stringify(applied);render();}});
    on(root,'click',e=>{
      const sort=e.target.closest('[data-report-sort]'),move=e.target.closest('[data-report-move]'),article=e.target.closest('[data-report-article]');
      if(sort&&valid()){prefs={...prefs,sort:sort.dataset.reportSort,direction:prefs.sort===sort.dataset.reportSort&&prefs.direction==='asc'?'desc':'asc'};persist();if(applied)void search();else render();}
      if(move&&valid()&&prefsReady){const ids=[...prefs.columns],i=ids.indexOf(move.dataset.reportMove),j=i+Number(move.dataset.direction);if(i>=0&&j>=0&&j<ids.length){[ids[i],ids[j]]=[ids[j],ids[i]];prefs={...prefs,columns:ids};render();persist();}}
      if(article&&valid())openArticle?.(article.dataset.reportArticle);
    });
    on(q('[data-report-column-options]'),'change',e=>{const id=e.target.dataset.reportColumn;if(!id||!valid()||!prefsReady)return;const ids=e.target.checked?[...prefs.columns,id]:prefs.columns.filter(c=>c!==id);if(!ids.length){render();return;}prefs={...prefs,columns:ids};render();persist();});
    on(q('[data-report-retry]'),'click',()=>{if(loading)return;context=null;prefsReady=false;void activate();});on(q('[data-report-prev]'),'click',()=>void search(Math.max(0,offset-PAGE_SIZE),{useApplied:true}));on(q('[data-report-next]'),'click',()=>void search(offset+PAGE_SIZE,{useApplied:true}));on(q('[data-report-pdf]'),'click',openPdf);
    return {activate,sync(){synchronize();print.sync();if(visible())void activate();else print.deactivate();},suspend(){print.deactivate();},destroy(){dead=true;epoch++;loading?.abort();print.destroy();layout?.destroy();listeners.forEach(remove=>remove());root.replaceChildren();},get state(){return {ready:Boolean(context),preferencesReady:prefsReady,rows:clone(rows),total,filters:applied&&clone(applied)};}};
  }
  return {mount,format,filename};
});
