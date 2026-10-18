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
    const queryPanel=doc.createElement('div');queryPanel.dataset.reportPanel='query';queryPanel.id='article-report-query';queryPanel.setAttribute('role','tabpanel');queryPanel.setAttribute('aria-labelledby','article-report-query-tab');
    queryPanel.append(...root.childNodes);root.append(queryPanel);
    root.insertAdjacentHTML('afterbegin','<div class="article-report-tabs" role="tablist" aria-label="Artikel-Auswertung"><button type="button" id="article-report-query-tab" role="tab" aria-selected="true" aria-controls="article-report-query" data-report-tab="query">Auswertung</button><button type="button" id="article-report-reports-tab" role="tab" aria-selected="false" aria-controls="article-report-reports" tabindex="-1" data-report-tab="reports">Berichte <span data-report-saved-count></span></button></div>');
    root.insertAdjacentHTML('beforeend','<section class="article-report-archive" data-report-panel="reports" id="article-report-reports" role="tabpanel" aria-labelledby="article-report-reports-tab" hidden><div class="article-report-results-toolbar"><div><h2>Meine Berichte</h2><p>Gespeicherte PDFs mit den Einstellungen der jeweiligen Auswertung.</p></div><button type="button" class="text-button" data-report-saved-refresh>Aktualisieren</button></div><p class="article-report-status" role="status" aria-live="polite" data-report-saved-status></p><div class="article-report-saved-list" data-report-saved-list></div></section>');
    const q=s=>root.querySelector(s),form=q('[data-report-form]'),status=q('[data-report-status]'),table=q('table');
    q('[data-report-branches] summary').insertAdjacentHTML('afterend','<div class="article-report-branch-actions"><button type="button" class="text-button" data-report-select-all>Alle auswählen</button><button type="button" class="text-button" data-report-select-none>Alle abwählen</button></div>');
    let actor=String(key()),epoch=0,dead=false,context=null,prefs=null,revision=0,prefsReady=false,write=Promise.resolve(),loading=null,hydrate=null,rows=[],total=0,offset=0,applied=null,dirty=false;
    let tab='query',reports=[],reportsRequest=null,reportsLoaded=false,reportAction=null,deletePending='',savedViewerId='',previewToken='',savedToken='',saving=false,saveButton=null,saveMessage=null;
    const listeners=[],on=(node,type,fn)=>{node.addEventListener(type,fn);listeners.push(()=>node.removeEventListener(type,fn));};
    const valid=()=>!dead&&canUse()&&String(key())===actor;
    const visible=()=>valid()&&active();
    const columns=()=>context?.columns||[];
    const selected=()=>columns().filter(c=>prefs?.columns.includes(c.id)).sort((a,b)=>prefs.columns.indexOf(a.id)-prefs.columns.indexOf(b.id));
    const field=name=>form.elements.namedItem(name);
    function setStatus(message,error=false){status.textContent=message;status.classList.toggle('is-error',error);}
    function savedStatus(message,error=false){const node=q('[data-report-saved-status]');node.textContent=message;node.classList.toggle('is-error',error);}
    function current(ticket){return visible()&&ticket===epoch;}
    function date(value){return value?new Date(value).toLocaleString('de-AT',{dateStyle:'medium',timeStyle:'short'}):'Nicht verfügbar';}
    function clearPreview(){previewToken='';savedToken='';print.reset();if(saveMessage)saveMessage.textContent='';}
    function showTab(value){
      tab=value==='reports'?'reports':'query';
      root.querySelectorAll('[data-report-tab]').forEach(node=>{const chosen=node.dataset.reportTab===tab;node.setAttribute('aria-selected',String(chosen));node.tabIndex=chosen?0:-1;});
      root.querySelectorAll('[data-report-panel]').forEach(node=>{node.hidden=node.dataset.reportPanel!==tab;});
      if(tab==='reports'){print.close();if(visible())void loadReports();}else savedPdf.close();
    }
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
      onState(state){if(saveButton){saveButton.disabled=!state.ready||!state.open||!visible()||!previewToken||saving||savedToken===previewToken;saveButton.textContent=saving?'Wird gespeichert …':savedToken&&savedToken===previewToken?'Bericht gespeichert':'Bericht speichern';}if(!state.ready&&saveMessage&&!saving)saveMessage.textContent='';},
      defaults:{title:'Artikel-Auswertung',filename:'Artikel-Auswertung',orientation:'landscape'},
      renderOptions(host,{payload}){
        const details=doc.createElement('details'),heading=doc.createElement('summary'),choices=doc.createElement('div');details.open=true;heading.textContent='Spalten im PDF';choices.dataset.reportPdfColumns='';
        for(const column of payload.columns){const label=doc.createElement('label'),input=doc.createElement('input');input.type='checkbox';input.value=column.id;input.checked=payload.selected.includes(column.id);label.append(input,doc.createTextNode(column.label));choices.append(label);}
        details.append(heading,choices);host.append(details);
      },
      readOptions:host=>({columns:[...host.querySelectorAll('input:checked')].map(input=>input.value)}),
      validateOptions:options=>options.columns.length?'':'Bitte mindestens eine Spalte wählen.',
      async createPdf({values,options,payload,signal}){
        previewToken='';savedToken='';const ticket=epoch;
        const specification={filters:payload.filters,columns:options.columns,title:values.title.trim(),name:filename(values.filename),orientation:values.orientation};
        const response=await rawApi(BASE+'/pdf-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(specification),signal});
        if(!response.ok)throw Error('PDF-Ausgabe konnte nicht erstellt werden.');
        const blob=await response.blob();if(current(ticket)&&!signal.aborted)previewToken=response.headers.get('X-Report-Preview-Token')||'';
        return {blob,filename:specification.name,summary:`${response.headers.get('X-Report-Rows')||payload.total} Zeilen`};
      }
    });
    saveButton=doc.createElement('button');saveButton.type='button';saveButton.dataset.reportSave='';saveButton.textContent='Bericht speichern';saveButton.disabled=true;
    saveMessage=doc.createElement('small');saveMessage.dataset.reportSaveStatus='';saveMessage.setAttribute('role','status');saveMessage.setAttribute('aria-live','polite');
    print.element.querySelector('.gp-print-footer-info').append(saveMessage);print.element.querySelector('.gp-print-footer').append(saveButton);
    const savedPdf=win.GpExistingPdfWindow.mount({document:doc,id:'article-report-saved-pdf',title:'Gespeicherter Bericht',key,canUse:valid,active,windowPreferences,scale,rawApi,
      trigger:()=>[...root.querySelectorAll('[data-report-saved-view]')].find(button=>button.dataset.reportSavedView===savedViewerId)||q('[data-report-tab="reports"]'),
      request:({payload})=>({url:BASE+'/reports/'+encodeURIComponent(payload.id)+'/pdf-preview'}),summary:'Gespeicherte Fassung'});
    savedPdf.element.querySelector('.gp-print-hint').textContent='Vorschau und Download zeigen die unveränderte gespeicherte PDF-Datei.';
    savedPdf.element.querySelector('[data-gp-print-save-status]').hidden=true;
    function renderReports(){
      q('[data-report-saved-count]').textContent=reportsLoaded?String(reports.length):'';
      q('[data-report-saved-refresh]').disabled=Boolean(reportsRequest)||Boolean(reportAction);
      q('[data-report-saved-list]').innerHTML=reports.length?reports.map(report=>{
        const locationNames=(report.filters?.locations||[]).map(id=>context?.locations.find(item=>item.id===id)?.label||id).join(' · ');
        const details=`${Number(report.rows||0).toLocaleString('de-AT')} Zeilen · ${Number(report.pages||0)} Seiten · Erstellt ${date(report.createdAt)}`;
        return '<article class="article-report-saved-card"><div class="article-report-saved-heading"><span class="article-report-pdf-badge" aria-hidden="true">PDF</span><div><h3>'+escape(report.title)+'</h3><p>'+escape(details)+'</p></div></div><p class="article-report-saved-scope">'+escape(locationNames)+'</p><p class="article-report-saved-source">Datenstand: '+escape(date(report.sourceAt))+'</p><div class="article-report-saved-actions"><button type="button" class="secondary-button" data-report-saved-view="'+escape(report.id)+'" '+(reportAction?'disabled':'')+'>PDF ansehen</button><button type="button" class="text-button" data-report-saved-edit="'+escape(report.id)+'" '+(reportAction?'disabled':'')+'>Einstellungen öffnen</button><button type="button" class="text-button" data-report-saved-delete="'+escape(report.id)+'" '+(reportAction?'disabled':'')+'>Löschen</button></div>'+(deletePending===report.id?'<div class="article-report-delete-confirm" role="group" aria-label="Bericht löschen"><p>„'+escape(report.title)+'“ und die gespeicherte PDF-Datei löschen?</p><button type="button" data-report-saved-confirm="'+escape(report.id)+'" '+(reportAction?'disabled':'')+'>Löschen bestätigen</button><button type="button" class="text-button" data-report-saved-cancel="'+escape(report.id)+'" '+(reportAction?'disabled':'')+'>Abbrechen</button></div>':'')+'</article>';
      }).join(''):'<div class="article-report-archive-empty"><strong>Noch keine gespeicherten Berichte</strong><p>Erstelle eine Auswertung, öffne „PDF exportieren“ und wähle im Druckfenster „Bericht speichern“.</p></div>';
    }
    async function loadReports(){
      if(!visible()||reportsRequest)return;const request=new AbortController(),ticket=epoch;reportsRequest=request;savedStatus('Berichte werden geladen …');renderReports();
      try{const result=await api(BASE+'/reports',{signal:request.signal});if(!current(ticket)||request.signal.aborted)return;reports=result.reports;reportsLoaded=true;savedStatus('Die PDFs bleiben in der gespeicherten Fassung. „Einstellungen öffnen“ verwendet den aktuellen Datenstand.');}
      catch(error){if(current(ticket)&&!request.signal.aborted){reports=[];reportsLoaded=false;savedStatus(error.message,true);}}
      finally{if(reportsRequest===request){reportsRequest=null;renderReports();}}
    }
    async function saveReport(){
      if(!visible()||!print.state.ready||!previewToken||saving||previewToken===savedToken)return;
      const token=previewToken,ticket=epoch;saving=true;saveButton.disabled=true;saveButton.textContent='Wird gespeichert …';saveMessage.textContent='Die angezeigte PDF-Datei wird gespeichert …';
      try{await api(BASE+'/reports',{method:'POST',body:JSON.stringify({previewToken:token})});if(!current(ticket))return;savedToken=token;saveMessage.textContent='Unter „Berichte“ gespeichert.';reportsLoaded=false;await loadReports();}
      catch(error){if(current(ticket))saveMessage.textContent=error.message;}
      finally{if(ticket===epoch){saving=false;saveButton.textContent=savedToken===previewToken?'Bericht gespeichert':'Bericht speichern';saveButton.disabled=!visible()||!print.state.ready||!previewToken||savedToken===previewToken;}}
    }
    async function openSaved(id,edit=false){
      if(!visible()||reportAction)return;if(edit&&!context){savedStatus('Die Filialauswahl wird noch geladen. Bitte anschließend erneut öffnen.');return;}
      const ticket=epoch,request=new AbortController();reportAction=request;renderReports();savedStatus('Bericht wird geöffnet …');
      try{
        const response=await api(BASE+'/reports/'+encodeURIComponent(id),{signal:request.signal});if(!current(ticket)||request.signal.aborted)return;const report=response.report||response;
        if(!edit){savedViewerId=id;savedStatus('Gespeicherte PDF-Fassung geöffnet.');savedPdf.open({values:{title:report.title,filename:filename(report.name)},payload:{id:report.id}});return;}
        const spec=report.spec,filter=spec.filters,allowedColumns=columns().map(column=>column.id);clearPreview();
        field('query').value=filter.query||'';field('stock').value=filter.stock==='all'?'all':'positive';
        field('assortment').value=filter.assortment;const assortmentAvailable=Boolean(field('assortment').value);
        const savedLocations=filter.locations?.length?filter.locations:(context.locations||[]).map(location=>location.id);
        q('[data-report-branch-options]').querySelectorAll('input').forEach(input=>{input.checked=savedLocations.includes(input.value);});
        const restoredColumns=spec.columns.filter(column=>allowedColumns.includes(column));
        prefs={...prefs,columns:restoredColumns.includes('articleNumber')?[...restoredColumns]:['articleNumber',...restoredColumns],sort:allowedColumns.includes(filter.sort)?filter.sort:'articleNumber',direction:filter.direction==='desc'?'desc':'asc'};
        rows=[];total=0;offset=0;applied=null;dirty=false;renderBranches();render();persist();showTab('query');
        if(!assortmentAvailable){setStatus('Diese Sortimentsart ist nicht mehr verfügbar. Bitte neu auswählen.',true);return;}
        if(!branches().length){setStatus('Bitte mindestens eine verfügbare Filiale auswählen.',true);return;}
        const evaluated=await search();if(!current(ticket)||!evaluated)return;
        if(total)openPdf({title:spec.title,filename:filename(spec.name),orientation:spec.orientation,columns:restoredColumns});
      }catch(error){if(current(ticket)&&!request.signal.aborted)savedStatus(error.message,true);}
      finally{if(reportAction===request){reportAction=null;renderReports();}}
    }
    async function deleteReport(id){
      if(!visible()||reportAction||deletePending!==id)return;const ticket=epoch,request=new AbortController();reportAction=request;savedPdf.reset();renderReports();savedStatus('Bericht wird gelöscht …');
      try{await api(BASE+'/reports/'+encodeURIComponent(id),{method:'DELETE',signal:request.signal});if(!current(ticket)||request.signal.aborted)return;reports=reports.filter(report=>report.id!==id);deletePending='';savedStatus('Bericht und PDF-Datei gelöscht.');}
      catch(error){if(current(ticket)&&!request.signal.aborted)savedStatus(error.message,true);}
      finally{if(reportAction===request){reportAction=null;renderReports();}}
    }
    function synchronize(){if(actor!==String(key())||!canUse()){
      reportsRequest?.abort();reportsRequest=null;reportAction?.abort();reportAction=null;reports=[];reportsLoaded=false;deletePending='';saving=false;previewToken='';savedToken='';saveMessage.textContent='';savedPdf.reset();savedStatus('');renderReports();showTab('query');
      actor=String(key());epoch++;loading?.abort();loading=null;hydrate=null;print.reset();context=null;prefs=null;prefsReady=false;rows=[];total=0;offset=0;applied=null;dirty=false;field('query').value='';field('stock').value='positive';field('assortment').replaceChildren();field('assortment').disabled=true;q('[data-report-branch-options]').replaceChildren();q('thead').replaceChildren();q('tbody').innerHTML='<tr><td>Auswertung wird vorbereitet …</td></tr>';q('[data-report-result-count]').textContent='Noch keine Auswertung';q('[data-report-source]').textContent='';q('[data-report-selected-branches]').textContent='';q('[data-report-preference-status]').textContent='';q('[data-report-pdf]').disabled=true;form.querySelector('[type=submit]').disabled=true;q('[data-report-column-options]').replaceChildren();
    }}
    async function activate(){synchronize();print.activate();savedPdf.activate();if(!visible())return;if(context){if(tab==='reports'&&!reportsLoaded)void loadReports();return;}if(hydrate)return hydrate;
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
      loading?.abort();const request=new AbortController(),ticket=epoch;loading=request;clearPreview();setStatus('Artikel und Filialbestände werden geladen …');render();
      const params=new URLSearchParams({...query,locations:query.locations.join(','),limit:String(PAGE_SIZE),offset:String(nextOffset)});
      try{const result=await api(BASE+'/query?'+params,{signal:request.signal});if(!valid()||ticket!==epoch||loading!==request||request.signal.aborted)return;
        rows=result.rows;total=result.total;offset=nextOffset;applied=query;dirty=JSON.stringify(filters())!==JSON.stringify(applied);q('[data-report-source]').textContent=result.sourceAt?'Datenstand: '+new Date(result.sourceAt).toLocaleString('de-AT'):'Datenstand nicht verfügbar';setStatus(dirty?'Filter geändert – bitte erneut auswerten.':'Ergebnis aus dem zuletzt übernommenen Datenstand.');
        return !dirty;
      }catch(error){if(valid()&&loading===request&&!request.signal.aborted){rows=[];total=0;applied=null;offset=0;setStatus(error.message,true);}}finally{if(loading===request){loading=null;render();}}
    }
    function openPdf(settings={}){if(!visible()||!total||dirty)return;const title=settings.title||(field('assortment').selectedOptions[0]?.textContent==='Abverkauf'?'Abverkauf nach Filiale':'Artikel-Auswertung');print.open({values:{title,filename:settings.filename||filename(title),orientation:settings.orientation||'landscape'},payload:{filters:clone(applied),columns:clone(columns()),selected:[...(settings.columns||prefs.columns)],total}});}
    function filtersChanged(){renderBranches();clearPreview();if(applied){dirty=JSON.stringify(filters())!==JSON.stringify(applied);setStatus(dirty?'Filter geändert – bitte erneut auswerten.':'Ergebnis aus dem zuletzt übernommenen Datenstand.');render();}}
    on(form,'submit',e=>{e.preventDefault();void search();});on(form,'change',filtersChanged);on(field('query'),'input',filtersChanged);
    on(q('[data-report-select-all]'),'click',()=>{if(!valid())return;q('[data-report-branch-options]').querySelectorAll('input').forEach(input=>{input.checked=true;});filtersChanged();});
    on(q('[data-report-select-none]'),'click',()=>{if(!valid())return;q('[data-report-branch-options]').querySelectorAll('input').forEach(input=>{input.checked=false;});filtersChanged();setStatus('Bitte mindestens eine Filiale auswählen.');});
    on(saveButton,'click',()=>void saveReport());on(q('[data-report-saved-refresh]'),'click',()=>void loadReports());
    on(q('[role=tablist]'),'keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();showTab(event.key==='Home'?'query':event.key==='End'?'reports':tab==='query'?'reports':'query');q('[data-report-tab="'+tab+'"]').focus();});
    on(root,'click',e=>{
      const tabButton=e.target.closest('[data-report-tab]'),view=e.target.closest('[data-report-saved-view]'),edit=e.target.closest('[data-report-saved-edit]'),remove=e.target.closest('[data-report-saved-delete]'),confirm=e.target.closest('[data-report-saved-confirm]'),cancel=e.target.closest('[data-report-saved-cancel]');
      if(tabButton&&valid())showTab(tabButton.dataset.reportTab);
      if(view)void openSaved(view.dataset.reportSavedView,false,view);if(edit)void openSaved(edit.dataset.reportSavedEdit,true,edit);
      if(remove&&valid()&&!reportAction){deletePending=remove.dataset.reportSavedDelete;renderReports();q('[data-report-saved-confirm]')?.focus();}
      if(cancel&&valid()&&!reportAction){deletePending='';renderReports();}
      if(confirm)void deleteReport(confirm.dataset.reportSavedConfirm);
      const sort=e.target.closest('[data-report-sort]'),move=e.target.closest('[data-report-move]'),article=e.target.closest('[data-report-article]');
      if(sort&&valid()){prefs={...prefs,sort:sort.dataset.reportSort,direction:prefs.sort===sort.dataset.reportSort&&prefs.direction==='asc'?'desc':'asc'};persist();if(applied)void search();else render();}
      if(move&&valid()&&prefsReady){const ids=[...prefs.columns],i=ids.indexOf(move.dataset.reportMove),j=i+Number(move.dataset.direction);if(i>=0&&j>=0&&j<ids.length){[ids[i],ids[j]]=[ids[j],ids[i]];prefs={...prefs,columns:ids};render();persist();}}
      if(article&&valid())openArticle?.(article.dataset.reportArticle);
    });
    on(q('[data-report-column-options]'),'change',e=>{const id=e.target.dataset.reportColumn;if(!id||!valid()||!prefsReady)return;const ids=e.target.checked?[...prefs.columns,id]:prefs.columns.filter(c=>c!==id);if(!ids.length){render();return;}prefs={...prefs,columns:ids};render();persist();});
    on(q('[data-report-retry]'),'click',()=>{if(loading)return;context=null;prefsReady=false;void activate();});on(q('[data-report-prev]'),'click',()=>void search(Math.max(0,offset-PAGE_SIZE),{useApplied:true}));on(q('[data-report-next]'),'click',()=>void search(offset+PAGE_SIZE,{useApplied:true}));on(q('[data-report-pdf]'),'click',()=>openPdf());
    return {activate,sync(){synchronize();print.sync();savedPdf.sync();if(visible())void activate();else{print.deactivate();savedPdf.deactivate();}},suspend(){print.deactivate();savedPdf.deactivate();reportsRequest?.abort();reportAction?.abort();},destroy(){dead=true;epoch++;loading?.abort();reportsRequest?.abort();reportAction?.abort();print.destroy();savedPdf.destroy();layout?.destroy();listeners.forEach(remove=>remove());root.replaceChildren();},get state(){return {ready:Boolean(context),preferencesReady:prefsReady,rows:clone(rows),total,filters:applied&&clone(applied),tab,reports:clone(reports)};}};
  }
  return {mount,format,filename};
});
