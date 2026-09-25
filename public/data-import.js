(function attach(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GrabenplanerDataImport=api;
}(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels={dating:'Datenstand wird ermittelt',queued:'Wartet auf Verarbeitung',retrying:'Automatischer Wiederholungsversuch geplant',paused:'Auftrag pausiert',failed:'Auftrag benötigt Aufmerksamkeit',reading:'Datei wird bereitgestellt',interrupted:'Bereitstellung unterbrochen',staging:'Zwischenspeicherung',reviewing:'Prüfung läuft',rechecking:'Prüfung wird vorbereitet',
    needs_review:'Prüfung erforderlich',ready:'Vorschau geprüft',applying:'Übernahme läuft',applied:'Übernommen',reverting:'Rücknahme läuft',reverted:'Zurückgenommen',deleting:'Endgültige Löschung begonnen'};
  const label=state=>labels[state]||'Prüfung erforderlich';
  const number=value=>Number(value||0).toLocaleString('de-AT');
  const sourceLabel=kind=>({cash:'Kassen-Umsätze',trade:'TradeFoto-Stamm und Historie',bestell:'TradeFoto-Bestellungen, Rechnungen und Reparaturen'})[kind]||'Unbekannte Quelle';
  const sourceFileName=source=>source.fileName||({cash:'Kassen_Umsätze.accdb',trade:'Trade_Daten.accdb',bestell:'Trade_DatenBestell.accdb',weum:'WEUM.accdb',inventur:'InventurProtokoll.accdb'})[source.kind]||'Unbekannte Datenbank';
  const dateTime=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('de-AT',{dateStyle:'short',timeStyle:'short'}):'Nicht erfasst';
  const kindForFile=name=>/^Trade_DatenBestell(?:[ ._-]|$)/i.test(name)?'bestell':/^Trade_Daten(?:[ ._-]|$)/i.test(name)?'trade':/^Kassen[_ -]Ums[aä]tze(?:[ ._-]|$)/i.test(name)?'cash':/^WEUM(?:[ ._-]|$)/i.test(name)?'weum':/^InventurProtokoll(?:[ ._-]|$)/i.test(name)?'inventur':null;
  function contentDate(source) {
    const date=source.contentDate;
    if(date?.status!=='complete')return source.complete?(source.background?.phase==='content-date'&&source.active?'Wird ermittelt …':'Noch nicht ermittelt'):'Nach dem Einlesen';
    if(!/^\d{4}-\d{2}-\d{2}T/.test(date.value||''))return 'Kein fachliches Datum';
    const [year,month,day]=date.value.slice(0,10).split('-');
    return `<time datetime="${escape(date.value)}">${day}.${month}.${year}</time>`;
  }
  function renderSources(items,selectedId) {
    if(!items.length)return '<p>Noch keine eigenen Datenbankimporte.</p>';
    return `<div class="data-import-scroll data-import-source-table" tabindex="0" role="region" aria-label="Datenquellen und Datenstand"><table><caption>Datenquellen · Details mit Klick auf den Namen</caption><thead><tr><th scope="col">Datenquelle</th><th scope="col">Datenstand</th></tr></thead><tbody>${items.map(s=>`<tr${s.id===selectedId?' class="is-selected"':''}><th scope="row"><button type="button" data-i-source="${escape(s.id)}"${s.id===selectedId?' aria-current="true"':''}>${escape(sourceFileName(s))}</button><small>${escape(label(s.background?.status||s.status))}${s.uploadFileAvailable?' · Access-Datei noch vorhanden':''}</small>${!s.fileName?'<small>Bei älteren Importen ohne Originalnamen wird der Dateityp angezeigt.</small>':''}</th><td>${contentDate(s)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  const defaultCatalog=[['trade','Trade_Daten.accdb'],['cash','Kassen_Umsätze.accdb'],['bestell','Trade_DatenBestell.accdb']].map(([kind,fileName])=>({kind,fileName,purpose:sourceLabel(kind),group:'recommended',available:true}));
  function renderOverview(items=[],selectedId,context={},complete=true) {
    const catalog=context.sourceCatalog||defaultCatalog;
    const latest=new Map(items.map(source=>[source.kind,source]));
    function table(sources,caption) {
      return `<div class="data-import-scroll data-import-catalog-table" tabindex="0" role="region" aria-label="${escape(caption)}"><table><caption>${escape(caption)}</caption><thead><tr><th scope="col">Datenbank</th><th scope="col">Datenstand</th><th scope="col">Hochgeladen am</th><th scope="col">Status</th><th scope="col">Aktion</th></tr></thead><tbody>${sources.map(def=>{
        const source=latest.get(def.kind),enabled=def.available&&context.available&&context.projection?.prepare;
        const status=source?label(source.background?.status||source.status):def.group==='local'?'Lokal behalten':!def.available?'Noch nicht angebunden':complete?'Noch nicht hochgeladen':'Ältere Importe noch ungeprüft';
        return `<tr${source?.id===selectedId&&source?' class="is-selected"':''}><th scope="row">${source?`<button type="button" class="data-import-source-link" data-i-source="${escape(source.id)}"${source.id===selectedId?' aria-current="true"':''}>${escape(def.fileName)}</button>`:`<strong>${escape(def.fileName)}</strong>`}<small>${escape(def.purpose||'')}</small>${source?.fileName&&source.fileName!==def.fileName?`<small>Datei: ${escape(source.fileName)}</small>`:''}</th><td>${source?contentDate(source):'–'}</td><td>${source?`<time datetime="${escape(source.createdAt)}">${escape(dateTime(source.createdAt))}</time>`:'–'}</td><td><span class="data-import-state">${escape(status)}</span></td><td>${def.available?`<button type="button" data-i-upload="${escape(def.kind)}" aria-label="${escape(def.fileName)} hochladen" ${enabled?'':'disabled'}>Hochladen</button>${!context.projection?.prepare?'<small>Uploadrecht erforderlich</small>':!context.available?'<small>Import derzeit nicht verfügbar</small>':''}`:`<small>${def.group==='local'?'Kein Upload vorgesehen':def.group==='optional'?'Bei Bedarf ergänzen':'Anbindung vorgesehen'}</small>`}</td></tr>`;
      }).join('')}</tbody></table></div>`;
    }
    return table(catalog.filter(s=>s.group==='recommended'),'Datenbanken für den regelmäßigen Import')+
      (catalog.some(s=>s.group==='optional')?`<details class="data-import-other"><summary>Weitere Datenquellen bei Bedarf</summary>${table(catalog.filter(s=>s.group==='optional'),'Optionale Datenquellen')}</details>`:'')+
      (catalog.some(s=>s.group==='local')?`<details class="data-import-other"><summary>Lokal behalten · kein Import vorgesehen</summary><ul>${catalog.filter(s=>s.group==='local').map(s=>`<li><strong>${escape(s.fileName)}</strong><small>${escape(s.purpose)}</small></li>`).join('')}</ul></details>`:'')+
      (!complete?'<p class="data-import-note">Die Übersicht enthält die neuesten gefundenen Importe. Nicht gefundene Quellen können in älteren Importen liegen; bitte den Importverlauf prüfen.</p>':'');
  }
  function renderSource(source,projection={}) {
    const tables=source.tables||[], received=tables.reduce((n,t)=>n+(t.run?.receivedRows||0),0), expected=tables.reduce((n,t)=>n+t.declaredRows,0),job=source.background;
    const applied=tables.reduce((n,t)=>n+(t.run?.status==='applied'?t.run.receivedRows:t.run?.counts?.applied||0),0),takingOver=job?.phase==='applying'||['applying','applied'].includes(source.status),jobName=job?.phase==='content-date'?'Ermittlung des Datenstands':job?.phase==='applying'?'Übernahme':'Prüfung';
    const fileDeleted=job?.error==='IMPORT_JOB_FILE_DELETED';
    return `<header><h3>${escape(sourceFileName(source))}</h3><p>${escape(label(job?.status||source.status))} · Datenstand: ${contentDate(source)}</p></header>
      <progress max="${Math.max(expected,received,1)}" value="${received}" aria-label="Bereitgestellte Quellzeilen"></progress>
      ${takingOver?`<p>${number(applied)} / ${number(received)} Zeilen übernommen oder unverändert bestätigt · ${number(tables.filter(t=>t.run?.status==='applied').length)} / ${number(tables.length)} Tabellen abgeschlossen.</p><progress max="${Math.max(received,1)}" value="${applied}" aria-label="Übernommene Quellzeilen"></progress>${source.currentStep&&source.status!=='applied'?`<p>${escape(source.currentStep.table)} · ${escape(label(source.currentStep.phase))}</p>`:''}`:''}
      <p class="data-import-note">${source.uploadFileAvailable?'Die Access-Datei ist für diesen Auftrag vorübergehend gespeichert.':'Keine Access-Datei auf dem Server gespeichert.'} Die Daten und Importprotokolle im GP bleiben erhalten.</p>
      ${source.selection?`<p class="data-import-note">${source.kind==='inventur'?'Kompakter Inventurimport: belegte Inventuren als Zusammenfassung; auf Positionsebene nur Differenzen und Mengenprüffälle. Unveränderte Zählstände bleiben in Ihrer lokalen Quelldatei.':'Begrenzter Import: Warenbewegungen und historische Artikelreferenzen. Gelöschte Artikel werden als Historie gespeichert und nicht wieder aktiviert.'}</p><p class="data-import-note">${(source.selection.tables||[]).map(t=>`${escape(t.name)}: ${number(t.selectedRows)} ausgewählt aus ${number(t.sourceRows)} Quellzeilen`).join(' · ')}</p>`:''}
      ${source.uploadFileAvailable?`<button type="button" data-i-delete-upload ${!projection.prepare||source.active?'disabled':''}>Access-Datei löschen</button>`:''}
      ${projection.prepare&&!['applying','applied','reverting','reverted'].includes(source.status)&&!tables.some(t=>['applying','applied','reverting','reverted'].includes(t.run?.status))?`<button type="button" data-i-delete-source ${source.active?'disabled':''}>${source.status==='deleting'?'Endgültige Löschung fortsetzen':'Nicht übernommenen Import endgültig löschen'}</button><p class="data-import-note">Entfernt auch die eingelesenen Importdaten dieser Quelle vom Server. Bereits übernommene oder freigegebene Datenquellen sind geschützt.</p>`:''}
      ${source.storage==='cash-compact-v1'?'<p class="data-import-note">Gesamte Kassenhistorie · alle Zeiträume · alle Filialen in einem Import.</p>':''}
      ${job?`<p role="status">${fileDeleted?'Die Access-Datei ist gelöscht. Zum Fortsetzen dieselbe Datei erneut hochladen; bereits eingelesene GP-Daten bleiben erhalten.':['queued','reading','reviewing','applying','dating'].includes(job.status)?'Der Server arbeitet selbstständig weiter. Sie können den GP schließen.':job.status==='retrying'?`Ein vorübergehender Fehler ist aufgetreten. Wiederholungsversuch ${number(job.retries)} von ${number(job.maxRetries)} ist für ${escape(new Date(job.nextAt).toLocaleString('de-AT'))} geplant; kein erneuter Upload nötig.`:job.status==='paused'?`Die ${jobName} ist pausiert. Sie können sie ohne erneuten Upload fortsetzen.`:'Die automatischen Versuche wurden angehalten. Sie können den Auftrag am gespeicherten Stand erneut versuchen.'}</p>
        ${job.error?`<details><summary>Technischer Hinweis</summary><p>${escape(job.error)}</p></details>`:''}
        <div class="data-import-actions">${fileDeleted?'':['paused','failed'].includes(job.status)?`<button type="button" data-i-job="retry" ${!projection.prepare||job?.phase==='applying'&&!projection.apply?'disabled':''}>${jobName} fortsetzen</button>`:`<button type="button" data-i-job="pause" ${!projection.prepare||job?.phase==='applying'&&!projection.apply?'disabled':''}>${jobName} pausieren</button>`}</div>`
        :source.error?`<p role="status">Unterbrechung: ${escape(source.error)}. Bitte denselben Dateistand erneut auswählen; bereits geprüfte Pakete bleiben erhalten.</p>`:''}
      <div class="data-import-actions">
        ${source.storage==='cash-compact-v1'&&source.status==='ready'?'<button type="button" data-i-publish>Kassenstand für Auswertungen auswählen</button>':''}
        ${job||source.status!=='reviewing'?'':`<button type="button" data-i-action="review" ${!projection.prepare||!source.complete||source.active?'disabled':''}>Prüfung fortsetzen</button>`}
        ${source.storage==='cash-compact-v1'?'':`<button type="button" data-i-action="apply" ${!projection.apply||!source.activationEnabled||!source.complete||source.active||!source.catalogUpdatePending&&!['ready','needs_review','applying'].includes(source.status)?'disabled':''}>Übernehmen</button>
        `}
      </div>
      ${source.storage==='cash-compact-v1'?'<p class="data-import-note">Bereitstellung und Prüfung aktivieren noch keine Auswertung. Den geprüften Kassenstand anschließend bewusst für Auswertungen auswählen.</p>':!source.activationEnabled?'<p class="data-import-note">Produktive Übernahme noch nicht freigegeben. Keine neuen Kunden, Artikel oder Verkaufskennzahlen werden durch die Vorschau angelegt.</p>':''}
      ${source.kind==='trade'?`<p class="data-import-note">Die Übernahme aktualisiert auch Artikelnummern, Barcodes und Preise im Artikelkatalog.${source.catalog?` ${number(source.catalog.changed)} aktualisiert · ${number(source.catalog.unchanged)} unverändert${source.catalog.blocked?` · ${number(source.catalog.blocked)} zur Prüfung zurückgestellt`:''}.`:''}${source.catalogUpdatePending?' Bei diesem älteren Import steht der Katalogabgleich noch aus.':''}</p>`:''}
      <details class="data-import-technical"><summary>Prüfprotokolle und technische Details · ${number(tables.length)} Tabellen</summary>
      ${source.storage==='cash-compact-v1'?`<p class="data-import-note">${number(source.verifiedRows)} gespeicherte Zeilen vollständig zurückgelesen und verglichen. Die Filialzuordnung dient nur der Auswertung; sie schränkt den Import nicht ein.</p>`:''}
      <p class="data-import-note">${number(received)} gelesene / ${number(expected)} ${source.selection?'ausgewählte':'deklarierte'} Zeilen · Hochgeladen: ${escape(dateTime(source.createdAt))} · GP-Bearbeitung: ${escape(dateTime(source.updatedAt||source.createdAt))}</p><p class="data-import-note">Dateifingerabdruck <code>${escape(source.fileSha256)}</code></p>
      ${source.contentDate?.evidence?`<p class="data-import-note">Datenstand ermittelt aus ${escape(source.contentDate.evidence.table)} · ${escape(source.contentDate.evidence.field)}.</p>`:''}
      ${tables.flatMap(t=>(t.run?.acceptedDeviations||[]).map(p=>`<aside class="data-import-tolerance"><strong>Bestätigte Quellzähler-Abweichung · ${escape(t.name)}</strong><p>${number(p.expectedRows)} lesbare / ${number(p.declaredRows)} deklarierte Zeilen. Nur für diesen Dateistand akzeptiert.</p><small>Freigabe: ${escape(p.approvalReference)} · ${escape(p.recordedAt)}<br>Prüfnachweis: ${escape(p.evidenceReference)} · ${escape(p.id)}</small></aside>`)).join('')}
      ${source.storage==='cash-compact-v1'?'':`<button type="button" data-i-action="undo" ${!projection.undo||source.active||!['applied','applying','reverting'].includes(source.status)?'disabled':''}>Rücknahme starten / fortsetzen</button>`}
      <div class="data-import-scroll" tabindex="0" role="region" aria-label="Tabellen und Prüfstatus"><table><thead><tr><th scope="col">Quelltabelle</th><th scope="col">Gelesen / ${source.selection?'ausgewählt':'deklariert'}</th><th scope="col">Status / Hinweise</th><th scope="col">Prüfung</th></tr></thead><tbody>
      ${tables.map(t=>`<tr><td>${escape(t.name)}</td><td>${number(t.run?.receivedRows)} / ${number(t.declaredRows)}</td><td>${escape(label(t.run?.status||'staging'))}${t.run?.counts?.invalid?` · ${number(t.run.counts.invalid)} ungültig`:''}${t.run?.counts?.conflict?` · ${number(t.run.counts.conflict)} Konflikte`:''}${t.run?.gates?.length?` · ${t.run.gates.map(escape).join(', ')}`:''}</td><td>${t.run?`${source.storage==='cash-compact-v1'?'':`<button type="button" data-i-log="${escape(t.run.id)}">Protokoll</button> `}<button type="button" data-i-rows="${escape(t.run.id)}">Zeilenstatus</button>${projection.undo&&['applied','applying','reverting'].includes(t.run.status)?` <button type="button" data-i-undo-preview="${escape(t.run.id)}">Rücknahme prüfen</button>`:''}`:'–'}</td></tr>`).join('')}
      </tbody></table></div><p class="data-import-note">Nicht übernommene technische Tabellen: ${(source.excludedTableNames||[]).map(escape).join(', ')||'Noch nicht ermittelt'}.</p></details>`;
  }
  function mount(root,{api,confirmAction=message=>globalThis.confirm(message)}) {
    const body=root.querySelector('[data-import-body]');
    let disposed=false,generation=0,controller=null,timer=null,context=null,selected=null,cursor=null,sourcePage={},working=false,logState=null,publicationView=null;
    const el=name=>body.querySelector(`[data-i="${name}"]`);
    const containers=[];
    for(let node=root.parentElement;node;node=node.parentElement) if(node.matches?.('.view,.settings-section,details')) containers.push(node);
    const visible=()=>root.open && containers.every(node=>!node.classList.contains('hidden')
      && (node.matches('details')?node.open:node.classList.contains('active')));
    const cancel=()=>{generation++;controller?.abort();controller=null;clearTimeout(timer);working=false;};
    async function request(url,options={}) {return api(url,{...options,signal:controller?.signal});}
    const post=(url,data={})=>request(url,{method:'POST',body:JSON.stringify(data)});
    const message=text=>{if(el('message'))el('message').textContent=text;};
    let renderedSourceId=null;
    function renderSelected(){
      const detail=el('detail');if(!detail)return;
      const sameSource=selected?.id===renderedSourceId,technicalOpen=sameSource&&detail.querySelector('.data-import-technical')?.open;
      const focused=globalThis.document?.activeElement,restoreFocus=sameSource&&focused&&detail.contains(focused);
      const attributes=['data-i-action','data-i-job','data-i-delete-upload','data-i-delete-source','data-i-publish','data-i-log','data-i-rows','data-i-undo-preview'];
      const focusedAttribute=restoreFocus&&attributes.find(name=>focused.hasAttribute(name)),focusedValue=focusedAttribute&&focused.getAttribute(focusedAttribute);
      const focusedSummary=restoreFocus&&focused.matches('.data-import-technical > summary');
      detail.innerHTML=selected?renderSource(selected,context.projection):'';renderedSourceId=selected?.id;
      const technical=detail.querySelector('.data-import-technical');if(technical)technical.open=!!technicalOpen;
      if(focusedSummary)technical?.querySelector('summary')?.focus({preventScroll:true});
      else if(focusedAttribute)Array.from(detail.querySelectorAll('button')).find(button=>!button.disabled&&button.getAttribute(focusedAttribute)===focusedValue)?.focus({preventScroll:true});
    }
    async function refresh(next=false) {
      const ticket=generation;
      if(next&&cursor)sourcePage=cursor;
      const [result,overview]=await Promise.all([post('/api/data-import/sources/search',sourcePage),context.sourceCatalog?request('/api/data-import/overview'):Promise.resolve(null)]);
      if(disposed||ticket!==generation)return;
      cursor=result.next;el('next').hidden=!cursor;
      el('sources').innerHTML=renderSources(result.items,selected?.id);
      const overviewElement=el('overview');
      if(overviewElement) {
        const opened=Array.from(overviewElement.querySelectorAll('details')).map(d=>d.open);
        const focused=globalThis.document?.activeElement,attribute=overviewElement.contains(focused)&&['data-i-upload','data-i-source'].find(a=>focused.hasAttribute(a)),value=attribute&&focused.getAttribute(attribute);
        overviewElement.innerHTML=renderOverview(overview?.items||result.items,selected?.id,context,overview?.complete!==false);
        Array.from(overviewElement.querySelectorAll('details')).forEach((d,i)=>{d.open=!!opened[i];});
        if(attribute)Array.from(overviewElement.querySelectorAll('button')).find(b=>!b.disabled&&b.getAttribute(attribute)===value)?.focus({preventScroll:true});
      }
      if(selected) {const selectedId=selected.id;const latest=await request(`/api/data-import/sources/${selectedId}`);if(disposed||ticket!==generation||selected?.id!==selectedId)return;selected=latest;renderSelected();}
      clearTimeout(timer);
      if(!working && visible() && !globalThis.document?.hidden && (selected?.active||result.items.some(s=>s.active)||overview?.items?.some(s=>s.active))) timer=setTimeout(()=>refresh().catch(e=>message(e.message)),2500);
    }
    async function load() {
      if(disposed||!visible())return;cancel();const ticket=generation;controller=new AbortController();body.textContent='Importanbindung wird geprüft …';
      try {
        context=await request('/api/data-import/context');if(disposed||ticket!==generation)return;
        body.innerHTML=`<div class="data-import-workspace"><div class="data-import-overview"><div class="data-import-overview-heading"><h3>Datenbanken und Aktualisierung</h3><button type="button" data-i-refresh>Aktualisieren</button></div><p class="data-import-note">Eigene Importstände · Datenstand: letztes fachliches Änderungs- oder Belegdatum in der Datei. Hochgeladen am: Eingang dieser Datei im GP. Der Status zeigt, ob die Daten bereits übernommen wurden.</p><div data-i="overview">${renderOverview([],null,context,false)}</div></div>
          <section class="data-import-upload" data-i="upload" hidden aria-labelledby="dataImportUploadTitle"><h3 data-i="upload-title" id="dataImportUploadTitle">Datenbank hochladen</h3>
          <form data-i="form" class="data-import-form" autocomplete="off"><input type="hidden" data-i="kind" value="trade"><p class="data-import-note" data-i="kind-hint" id="dataImportSourceHint">${sourceLabel('trade')}</p>
          <label>ACCDB-Datei<input data-i="file" type="file" accept=".accdb" required aria-describedby="dataImportFileHint"><small id="dataImportFileHint">Maximal 512 MiB · alle Filialen und Zeiträume.</small></label><label>Dateikennwort (falls erforderlich)<input data-i="password" type="password" autocomplete="new-password" maxlength="256"></label>
          <div class="data-import-actions"><button type="submit" ${!context.available||!context.projection.prepare?'disabled':''}>Prüfen und hochladen</button><button type="button" data-i-upload-cancel>Abbrechen</button></div></form><p data-i="file-name" class="data-import-note" aria-live="polite"></p>
          <p class="data-import-note">${context.available?'Nach dem Hochladen automatisch prüfen, danach übernehmen.':escape(context.message)}</p><p class="data-import-note">${context.backgroundEnabled?'Die Access-Datei wird nach dem Einlesen automatisch gelöscht. Bei Unterbrechungen spätestens nach 72 Stunden.':'Die Access-Datei wird nicht gespeichert.'} GP-Daten und Importprotokolle bleiben erhalten.</p></section></div>
          ${!context.available?`<p class="data-import-note" role="status">${escape(context.message)}</p>`:''}
          <details class="data-import-history"><summary>Importverlauf und frühere Dateistände</summary><div data-i="sources"></div><button type="button" data-i="next" hidden>Ältere Importe</button></details>
          <p data-i="message" role="status" aria-live="polite"></p><button type="button" data-i="stop" data-i-stop hidden>Anhalten</button><section data-i="detail"></section><section data-i="publication"></section><section data-i="log"></section>`;
        if(context.available)await refresh();
      }catch(error){if(!disposed&&ticket===generation)body.textContent=error.message||'Importanbindung nicht verfügbar.';}
    }
    async function runAction(action) {
      if(!selected||working)return;
      if(action!=='review'&&!confirmAction(action==='apply'?'Geprüfte Quelltabellen schrittweise übernehmen?':'Eigene Importänderungen schrittweise zurücknehmen? Spätere Änderungen und Abhängigkeiten werden vor jedem Paket erneut geprüft. Es kann nur ein Teil rücknehmbar sein.'))return;
      const ticket=generation;working=true;el('stop')?.removeAttribute('hidden');
      try {
        if(action==='apply'&&context.backgroundEnabled){
          const result=await post(`/api/data-import/sources/${selected.id}/apply-background`,{expectedRevision:selected.revision});
          if(disposed||ticket!==generation)return;selected=result;renderSelected();working=false;
          message('Die Übernahme läuft am Server weiter. Sie können den GP schließen.');await refresh();return;
        }
        do {
          const result=await post(`/api/data-import/sources/${selected.id}/${action}`,{expectedRevision:selected.revision});
          if(disposed||ticket!==generation)return;selected=result;renderSelected();
          message(action==='review'?'Quelltabellen werden geprüft …':action==='undo'?'Rücknahme wird geprüft und ausgeführt …':'Quelltabellen werden übernommen …');
          await new Promise(resolve=>setTimeout(resolve,30));
        }while(working&&visible()&&!globalThis.document?.hidden&&selected.status===({review:'reviewing',apply:'applying',undo:'reverting'}[action]));
        message(label(selected.status));
      }catch(error){if(!disposed&&ticket===generation)message(error.message);}
      finally{if(!disposed&&ticket===generation){working=false;el('stop')?.setAttribute('hidden','');}}
    }
    async function log(action,runId,next=false) {
      const ticket=generation,previous=next?logState:null;
      const data={runId,...(previous?.cursor||{})};
      const result=await post(`/api/data-import/sources/${selected.id}/${action}`,data);
      if(disposed||ticket!==generation)return;
      const rows=Array.isArray(result)?result:result.rows;
      const last=rows.at(-1),nextCursor=!last?null:action==='events'?{after:last.revision}:action==='rows'?{after:last.rowNumber}:{beforeRow:last.rowNumber};
      logState={action,runId,cursor:nextCursor};
      el('log').innerHTML=`<h3>${action==='events'?'Importprotokoll':action==='rows'?'Zeilenstatus':'Rücknahmeprüfung'}</h3><p>Diese Seite zeigt nur ${rows.length} Einträge. Die Rücknahme prüft jede Änderung erneut.</p><ul>${rows.map(r=>`<li>${escape(action==='events'?`${r.at} · ${r.action==='import.source-tolerance.accepted'?'Bestätigte Quellzähler-Abweichung protokolliert':r.action} · Revision ${r.revision}`:`Zeile ${r.rowNumber} · ${r.state|| (r.canUndo?'rücknehmbar':'nicht rücknehmbar')} ${r.issue||''}`)}</li>`).join('')}</ul>${nextCursor?'<button type="button" data-i-log-next>Weitere Einträge prüfen</button>':''}`;
    }
    async function click(event) {
      const target=event.target.closest?.('button');if(!target||working&& !target.hasAttribute('data-i-stop'))return;
      if(target.disabled)return;
      if(!target.hasAttribute('data-i-stop')){cancel();controller=new AbortController();}
      const ticket=generation;
      try {
        if(target.dataset.iUpload) {
          const def=(context.sourceCatalog||defaultCatalog).find(s=>s.kind===target.dataset.iUpload&&s.available);
          if(!def||!context.available||!context.projection?.prepare)return;
          el('kind').value=def.kind;el('kind-hint').textContent=def.purpose||sourceLabel(def.kind);el('upload-title').textContent=def.fileName+' hochladen';
          el('password').value='';el('file').value='';el('file-name').textContent='';el('upload').hidden=false;message('');
          el('upload').scrollIntoView?.({block:'nearest'});el('file').click();return;
        }
        if(target.hasAttribute('data-i-upload-cancel')) {
          const kind=el('kind').value;el('upload').hidden=true;el('file').value='';el('password').value='';el('file-name').textContent='';message('');
          body.querySelector(`[data-i-upload="${kind}"]`)?.focus();await refresh();return;
        }
        if(target.hasAttribute('data-i-publish')&&selected){publicationView?.destroy();publicationView=globalThis.GrabenplanerCashPublication?.mount(el('publication'),{api,source:selected,confirmAction});return;}
        if(target.hasAttribute('data-i-stop')){working=false;message('Nach dem laufenden Paket angehalten.');return;}
        if(target.hasAttribute('data-i-delete-source')&&selected){
          const preview=await post(`/api/data-import/sources/${selected.id}/delete-preview`,{expectedRevision:selected.revision});
          if(!confirmAction(`${sourceFileName(selected)} endgültig vom VPS löschen? Betroffen sind ${number(preview.rows)} vorbereitete Quellzeilen, Importprotokolle und eine eventuell noch vorhandene Upload-Datei. Die Löschung lässt sich nicht rückgängig machen. Bereits übernommene Daten bleiben geschützt. Bestehende Sicherungen unterliegen weiterhin ihrer Aufbewahrung.`))return;
          working=true;clearTimeout(timer);el('detail').innerHTML='<p role="status">Importdaten werden endgültig gelöscht …</p><button type="button" data-i-stop>Nach diesem Paket anhalten</button>';
          try{
            do{
              const result=await post(`/api/data-import/sources/${selected.id}/delete`,{expectedRevision:selected.revision});
              if(disposed||ticket!==generation)return;
              message(`${number(result.removedRows)} Quellzeilen endgültig gelöscht.`);
              if(result.deleted){selected=null;working=false;sourcePage={};el('log').replaceChildren();renderSelected();await refresh();message('Nicht übernommene Datenquelle und Importdaten endgültig vom VPS gelöscht.');return;}
              selected={...selected,revision:result.revision,status:'deleting'};
            }while(working);
          }catch(error){if(!disposed&&ticket===generation)await refresh().catch(()=>{});throw error;}finally{working=false;}
          await refresh();message('Löschung angehalten. Bereits entfernte Daten bleiben gelöscht; die restliche Löschung kann fortgesetzt werden.');return;
        }
        if(target.hasAttribute('data-i-delete-upload')&&selected) {
          if(!confirmAction('Nur die hochgeladene Access-Datei auf dem Server löschen? Alle GP-Daten, Importstände und Protokolle bleiben erhalten. Ein unterbrochener Import benötigt zum Fortsetzen dieselbe Datei erneut.'))return;
          selected=await post(`/api/data-import/sources/${selected.id}/delete-upload`,{expectedRevision:selected.revision});
          renderSelected();message('Access-Datei gelöscht. GP-Daten und Importprotokolle sind erhalten.');await refresh();return;
        }
        if(target.dataset.iJob&&selected){selected=await post(`/api/data-import/sources/${selected.id}/${target.dataset.iJob}`);renderSelected();await refresh();return;}
        if(target.dataset.iAction)return await runAction(target.dataset.iAction);
        if(target.hasAttribute('data-i-refresh')){clearTimeout(timer);sourcePage={};return await refresh();}
        if(target===el('next'))return await refresh(true);
        if(target.dataset.iSource){publicationView?.destroy();publicationView=null;const result=await request(`/api/data-import/sources/${target.dataset.iSource}`);if(disposed||ticket!==generation)return;selected=result;logState=null;el('log').replaceChildren();renderSelected();await refresh();return;}
        if(target.dataset.iLog)return await log('events',target.dataset.iLog);
        if(target.dataset.iRows)return await log('rows',target.dataset.iRows);
        if(target.dataset.iUndoPreview)return await log('undo-preview',target.dataset.iUndoPreview);
        if(target.hasAttribute('data-i-log-next')&&logState)return await log(logState.action,logState.runId,true);
      }catch(error){if(!disposed&&ticket===generation)message(error.message);}
    }
    async function submit(event) {
      if(event.target!==el('form'))return;event.preventDefault();if(working)return;
      const kind=el('kind').value,definition=(context.sourceCatalog||defaultCatalog).find(s=>s.kind===kind&&s.available);
      if(!definition||!context.available||!context.projection?.prepare){message('Für diese Datenbank ist derzeit kein Upload möglich.');return;}
      const file=el('file').files[0];if(!file||file.size<4096||file.size>context.maxBytes||!file.name.toLowerCase().endsWith('.accdb')){message('Bitte eine vollständige ACCDB-Datei bis 512 MiB auswählen.');return;}
      const recognized=kindForFile(file.name);if(recognized&&recognized!==kind){message(`Die ausgewählte Datei gehört zu einer anderen Datenbank. Bitte ${definition.fileName} auswählen.`);return;}
      const ticket=generation;working=true;message('Datei wird geschützt übertragen …');
      let password=el('password').value;el('password').value='';
      try {
        const passwordHeader=btoa(Array.from(new TextEncoder().encode(password),b=>String.fromCharCode(b)).join(''));password='';
        const result=await request(`/api/data-import/upload/${kind}`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Import-Password':passwordHeader,'X-Import-File-Name':encodeURIComponent(file.name)},body:file});
        if(disposed||ticket!==generation)return;el('file').value='';el('file-name').textContent='';el('upload').hidden=true;
        const source=await request(`/api/data-import/sources/${result.id}`);if(disposed||ticket!==generation)return;selected=source;sourcePage={};working=false;
        message(context.backgroundEnabled?'Datei sicher angenommen. Der Server liest und prüft sie automatisch; Sie können den GP jetzt schließen.':'Datei angenommen. Der Fortschritt wird laufend aktualisiert.');await refresh();
      }catch(error){if(!disposed&&ticket===generation)message(error.message);}
      finally{password='';if(!disposed&&ticket===generation)working=false;}
    }
    let wasVisible=false;
    const visibility=()=>{
      const next=visible();if(next===wasVisible)return;wasVisible=next;
      publicationView?.destroy();publicationView=null;
      if(!next){cancel();body.replaceChildren();selected=null;logState=null;}else void load();
    };
    const change=event=>{
      if(event.target===el('kind')) el('kind-hint').textContent=sourceLabel(el('kind').value);
      if(event.target===el('file')) {
        const name=el('file').files[0]?.name||'',kind=kindForFile(name);el('file-name').textContent=name;
        message(kind&&kind!==el('kind').value?'Diese Datei gehört zu einer anderen Datenbank. Bitte die Datei für die ausgewählte Zeile verwenden.':'');
      }
    };
    root.addEventListener('toggle',visibility);body.addEventListener('click',click);body.addEventListener('submit',submit);body.addEventListener('change',change);
    // Android opens its document picker outside Chrome. Keep the actual file
    // input and an in-flight upload alive when the document temporarily hides.
    // Navigation/account teardown still calls cancel() and destroys this form.
    const documentVisibility=()=>{
      clearTimeout(timer);
      if(!globalThis.document?.hidden&&visible()&&context?.available&&el('form')&&!working)
        void refresh().catch(e=>message(e.message));
    };
    globalThis.document?.addEventListener('visibilitychange',documentVisibility);
    const observer=containers.length&&globalThis.MutationObserver?new MutationObserver(visibility):null;
    for(const container of containers) observer?.observe(container,{attributes:true,attributeFilter:['class','open']});
    visibility();
    return {destroy(){disposed=true;cancel();publicationView?.destroy();observer?.disconnect();root.removeEventListener('toggle',visibility);body.removeEventListener('click',click);body.removeEventListener('submit',submit);body.removeEventListener('change',change);globalThis.document?.removeEventListener('visibilitychange',documentVisibility);body.replaceChildren();selected=null;logState=null;}};
  }
  return {mount,renderSource,renderSources,renderOverview,contentDate,kindForFile};
}));
