(function attach(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GrabenplanerDataImport=api;
}(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels={queued:'Wartet auf Verarbeitung',retrying:'Automatischer Wiederholungsversuch geplant',paused:'Prüfung pausiert',failed:'Prüfung benötigt Aufmerksamkeit',reading:'Datei wird bereitgestellt',interrupted:'Bereitstellung unterbrochen',staging:'Zwischenspeicherung',reviewing:'Prüfung läuft',
    needs_review:'Prüfung erforderlich',ready:'Vorschau geprüft',applying:'Übernahme läuft',applied:'Übernommen',reverting:'Rücknahme läuft',reverted:'Zurückgenommen'};
  const label=state=>labels[state]||'Prüfung erforderlich';
  const number=value=>Number(value||0).toLocaleString('de-AT');
  const sourceLabel=kind=>({cash:'Kassen-Umsätze',trade:'TradeFoto-Stamm und Historie',bestell:'TradeFoto-Bestellungen, Rechnungen und Reparaturen'})[kind]||'Unbekannte Quelle';
  function renderSource(source,projection={}) {
    const tables=source.tables||[], received=tables.reduce((n,t)=>n+(t.run?.receivedRows||0),0), expected=tables.reduce((n,t)=>n+t.declaredRows,0),job=source.background;
    return `<header><h3>${escape(sourceLabel(source.kind))}</h3><p>${escape(label(job?.status||source.status))} · ${number(received)} gelesene / ${number(expected)} deklarierte Zeilen</p></header>
      <progress max="${Math.max(expected,received,1)}" value="${received}" aria-label="Bereitgestellte Quellzeilen"></progress>
      <p class="data-import-note">Dateifingerabdruck <code>${escape(source.fileSha256)}</code><br>Bereitstellung begonnen: ${escape(source.createdAt)}. Das ist kein Belegdatum.</p>
      ${tables.flatMap(t=>(t.run?.acceptedDeviations||[]).map(p=>`<aside class="data-import-tolerance"><strong>Bestätigte Quellzähler-Abweichung · ${escape(t.name)}</strong><p>${number(p.expectedRows)} lesbare / ${number(p.declaredRows)} deklarierte Zeilen. Nur für diesen Dateistand akzeptiert; keine Daten- oder Bestandskorrektur.</p><small>Freigabe: ${escape(p.approvalReference)} · Erfasst: ${escape(p.recordedAt)}<br>Prüfnachweis: ${escape(p.evidenceReference)} · ${escape(p.id)}</small></aside>`)).join('')}
      ${source.storage==='cash-compact-v1'?`<p class="data-import-note">Gesamte Kassenhistorie · alle Zeiträume. ${number(source.verifiedRows)} gespeicherte Zeilen vollständig zurückgelesen und verglichen.</p>`:''}
      ${job?`<p role="status">${['queued','reading','reviewing'].includes(job.status)?'Der Server arbeitet selbstständig weiter. Sie können den GP schließen.':job.status==='retrying'?`Ein vorübergehender Fehler ist aufgetreten. Wiederholungsversuch ${number(job.retries)} von ${number(job.maxRetries)} ist für ${escape(new Date(job.nextAt).toLocaleString('de-AT'))} geplant; kein erneuter Upload nötig.`:job.status==='paused'?'Die Prüfung ist pausiert. Sie können sie ohne erneuten Upload fortsetzen.':'Die automatischen Versuche wurden angehalten. Sie können den Auftrag erneut versuchen; bei einer ungültigen oder abgelaufenen Datei diese bitte neu auswählen.'}</p>
        ${job.error?`<details><summary>Technischer Hinweis</summary><p>${escape(job.error)}</p></details>`:''}
        <div class="data-import-actions">${['paused','failed'].includes(job.status)?`<button type="button" data-i-job="retry" ${!projection.prepare?'disabled':''}>Prüfung fortsetzen</button>`:`<button type="button" data-i-job="pause" ${!projection.prepare?'disabled':''}>Prüfung pausieren</button>`}</div>`
        :source.error?`<p role="status">Unterbrechung: ${escape(source.error)}. Bitte denselben Dateistand erneut auswählen; bereits geprüfte Pakete bleiben erhalten.</p>`:''}
      <div class="data-import-actions">
        ${source.storage==='cash-compact-v1'&&source.status==='ready'?'<button type="button" data-i-publish>Kassenstand für Auswertungen auswählen</button>':''}
        ${job?'':`<button type="button" data-i-action="review" ${!projection.prepare||!source.complete||source.active||source.status!=='reviewing'?'disabled':''}>Prüfung fortsetzen</button>`}
        ${source.storage==='cash-compact-v1'?'':`<button type="button" data-i-action="apply" ${!projection.apply||!source.activationEnabled||!source.complete||source.active||!['ready','needs_review','applying'].includes(source.status)?'disabled':''}>Übernehmen</button>
        <button type="button" data-i-action="undo" ${!projection.undo||source.active||!['applied','applying','reverting'].includes(source.status)?'disabled':''}>Rücknahme starten / fortsetzen</button>`}
      </div>
      ${source.storage==='cash-compact-v1'?'<p class="data-import-note">Bereitstellung und Prüfung aktivieren noch keine Auswertung. Den geprüften Kassenstand anschließend bewusst für Auswertungen auswählen.</p>':!source.activationEnabled?'<p class="data-import-note">Produktive Übernahme noch nicht freigegeben. Keine neuen Kunden, Artikel oder Verkaufskennzahlen werden durch die Vorschau angelegt.</p>':''}
      <div class="data-import-scroll" tabindex="0" role="region" aria-label="Tabellen und Prüfstatus"><table><thead><tr><th scope="col">Quelltabelle</th><th scope="col">Gelesen / deklariert</th><th scope="col">Status / Hinweise</th><th scope="col">Prüfung</th></tr></thead><tbody>
      ${tables.map(t=>`<tr><td>${escape(t.name)}</td><td>${number(t.run?.receivedRows)} / ${number(t.declaredRows)}</td><td>${escape(label(t.run?.status||'staging'))}${t.run?.counts.invalid?` · ${number(t.run.counts.invalid)} ungültig`:''}${t.run?.counts.conflict?` · ${number(t.run.counts.conflict)} Konflikte`:''}${t.run?.gates?.length?` · ${t.run.gates.map(escape).join(', ')}`:''}</td><td>${t.run?`${source.storage==='cash-compact-v1'?'':`<button type="button" data-i-log="${escape(t.run.id)}">Protokoll</button> `}<button type="button" data-i-rows="${escape(t.run.id)}">Zeilenstatus</button>${projection.undo&&['applied','applying','reverting'].includes(t.run.status)?` <button type="button" data-i-undo-preview="${escape(t.run.id)}">Rücknahme prüfen</button>`:''}`:'–'}</td></tr>`).join('')}
      </tbody></table></div><details><summary>Nicht übernommene technische Tabellen</summary><p>${(source.excludedTableNames||[]).map(escape).join(', ')||'Noch nicht ermittelt'}</p><p>Zugänge, Kennwörter und ausführbare Access-Bestandteile gehören nicht zur Datenübernahme.</p></details>`;
  }
  function mount(root,{api,confirmAction=message=>globalThis.confirm(message)}) {
    const body=root.querySelector('[data-import-body]');
    let disposed=false,generation=0,controller=null,timer=null,context=null,selected=null,cursor=null,working=false,logState=null,publicationView=null;
    const el=name=>body.querySelector(`[data-i="${name}"]`);
    const containers=[];
    for(let node=root.parentElement;node;node=node.parentElement) if(node.matches?.('.view,.settings-section,details')) containers.push(node);
    const visible=()=>root.open && containers.every(node=>!node.classList.contains('hidden')
      && (node.matches('details')?node.open:node.classList.contains('active')));
    const cancel=()=>{generation++;controller?.abort();controller=null;clearTimeout(timer);working=false;};
    async function request(url,options={}) {return api(url,{...options,signal:controller?.signal});}
    const post=(url,data={})=>request(url,{method:'POST',body:JSON.stringify(data)});
    const message=text=>{if(el('message'))el('message').textContent=text;};
    function renderSelected(){if(el('detail'))el('detail').innerHTML=selected?renderSource(selected,context.projection):'';}
    async function refresh(next=false) {
      const ticket=generation;
      const result=await post('/api/data-import/sources/search',next&&cursor?cursor:{});
      if(disposed||ticket!==generation)return;
      cursor=result.next;el('next').hidden=!cursor;
      el('sources').innerHTML=result.items.map(s=>`<button type="button" data-i-source="${s.id}">${escape(sourceLabel(s.kind))} · ${escape(s.createdAt)} · ${escape(label(s.background?.status||s.status))}</button>`).join('')||'<p>Noch keine eigenen Datenbankimporte.</p>';
      if(selected) {const selectedId=selected.id;const latest=await request(`/api/data-import/sources/${selectedId}`);if(disposed||ticket!==generation||selected?.id!==selectedId)return;selected=latest;renderSelected();}
      if(!working && visible() && !globalThis.document?.hidden && (selected?.active||result.items.some(s=>s.active))) timer=setTimeout(()=>refresh().catch(e=>message(e.message)),2500);
    }
    async function load() {
      if(disposed||!visible())return;cancel();const ticket=generation;controller=new AbortController();body.textContent='Importanbindung wird geprüft …';
      try {
        context=await request('/api/data-import/context');if(disposed||ticket!==generation)return;
        body.innerHTML=`<p>${escape(context.message)}</p>
          <form data-i="form" class="data-import-form" autocomplete="off"><label>Datenquelle<select data-i="kind" aria-describedby="dataImportSourceHint"><option value="trade">Trade_Daten.accdb</option><option value="cash">Kassen_Umsätze.accdb</option><option value="bestell">Trade_DatenBestell.accdb</option></select><small data-i="kind-hint" id="dataImportSourceHint">${sourceLabel('trade')}</small></label>
          <label>ACCDB-Datei<input data-i="file" type="file" required aria-describedby="dataImportFileHint"><small id="dataImportFileHint">Eine .accdb-Datei vom Gerät oder aus Ihrem Cloudspeicher auswählen.</small></label><label>Dateikennwort (falls erforderlich)<input data-i="password" type="password" autocomplete="new-password" maxlength="256"></label>
          <button type="submit" ${!context.available||!context.projection.prepare?'disabled':''}>Datei prüfen</button></form><p data-i="file-name" class="data-import-note" aria-live="polite"></p>
          <p class="data-import-note">Maximal 512 MiB. ${context.backgroundEnabled?'Nach vollständigem Upload laufen Einlesen und Prüfung automatisch am Server. Datei und erforderliches Kennwort werden dafür vorübergehend verschlüsselt gespeichert. Nach dem Einlesen wird die Dateikopie gelöscht, bei Unterbrechungen spätestens im Bereinigungslauf nach 72 Stunden.':'Originaldatei und Kennwort werden nicht gespeichert. Nach einer Unterbrechung dieselbe Datei erneut auswählen.'} Bereits bereitgestellte Datensätze bleiben verschlüsselt; Rücknahmefrist: 30 Tage.</p>
          <p data-i="message" role="status" aria-live="polite"></p><div class="data-import-actions"><button type="button" data-i-refresh>Aktualisieren</button><button type="button" data-i="stop" data-i-stop hidden>Anhalten</button></div>
          <div data-i="sources" class="data-import-sources"></div><button type="button" data-i="next" hidden>Ältere Importe</button><section data-i="detail"></section><section data-i="publication"></section><section data-i="log"></section>`;
        if(context.available)await refresh();
      }catch(error){if(!disposed&&ticket===generation)body.textContent=error.message||'Importanbindung nicht verfügbar.';}
    }
    async function runAction(action) {
      if(!selected||working)return;
      if(action!=='review'&&!confirmAction(action==='apply'?'Geprüfte Quelltabellen schrittweise übernehmen?':'Eigene Importänderungen schrittweise zurücknehmen? Spätere Änderungen und Abhängigkeiten werden vor jedem Paket erneut geprüft. Es kann nur ein Teil rücknehmbar sein.'))return;
      const ticket=generation;working=true;el('stop')?.removeAttribute('hidden');
      try {
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
      if(!target.hasAttribute('data-i-stop')){cancel();controller=new AbortController();}
      const ticket=generation;
      try {
        if(target.hasAttribute('data-i-publish')&&selected){publicationView?.destroy();publicationView=globalThis.GrabenplanerCashPublication?.mount(el('publication'),{api,source:selected,confirmAction});return;}
        if(target.hasAttribute('data-i-stop')){working=false;message('Nach dem laufenden Paket angehalten.');return;}
        if(target.dataset.iJob&&selected){selected=await post(`/api/data-import/sources/${selected.id}/${target.dataset.iJob}`);renderSelected();await refresh();return;}
        if(target.dataset.iAction)return await runAction(target.dataset.iAction);
        if(target.hasAttribute('data-i-refresh')){clearTimeout(timer);return await refresh();}
        if(target===el('next'))return await refresh(true);
        if(target.dataset.iSource){publicationView?.destroy();publicationView=null;const result=await request(`/api/data-import/sources/${target.dataset.iSource}`);if(disposed||ticket!==generation)return;selected=result;logState=null;el('log').replaceChildren();renderSelected();return;}
        if(target.dataset.iLog)return await log('events',target.dataset.iLog);
        if(target.dataset.iRows)return await log('rows',target.dataset.iRows);
        if(target.dataset.iUndoPreview)return await log('undo-preview',target.dataset.iUndoPreview);
        if(target.hasAttribute('data-i-log-next')&&logState)return await log(logState.action,logState.runId,true);
      }catch(error){if(!disposed&&ticket===generation)message(error.message);}
    }
    async function submit(event) {
      if(event.target!==el('form'))return;event.preventDefault();if(working)return;
      const file=el('file').files[0];if(!file||file.size<4096||file.size>context.maxBytes||!file.name.toLowerCase().endsWith('.accdb')){message('Bitte eine vollständige ACCDB-Datei bis 512 MiB auswählen.');return;}
      const ticket=generation;working=true;message('Datei wird geschützt übertragen …');
      let password=el('password').value;el('password').value='';
      try {
        const passwordHeader=btoa(Array.from(new TextEncoder().encode(password),b=>String.fromCharCode(b)).join(''));password='';
        const result=await request(`/api/data-import/upload/${el('kind').value}`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Import-Password':passwordHeader},body:file});
        if(disposed||ticket!==generation)return;el('file').value='';
        const source=await request(`/api/data-import/sources/${result.id}`);if(disposed||ticket!==generation)return;selected=source;working=false;
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
      if(event.target===el('file')) el('file-name').textContent=el('file').files[0]?.name||'';
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
  return {mount,renderSource};
}));
