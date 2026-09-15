(function(root) {
  "use strict";
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const drafts = [
    {code:"wissen.kassa.gutscheine-anzahlungen",title:"Gutscheine und Anzahlungen unterscheiden",category:"Kassa",summary:"Unterschiedliche Wirkung bei Ausgabe und Einlösung.",body:"Gutscheine\nBei der Ausgabe entsteht kein Warenumsatz und kein Rohertrag. Die spätere Einlösung ist ein Zahlungsmittel. Sie mindert den Warenumsatz und den Kassen-Rohertrag nicht.\n\nAnzahlungen\nDer Verkauf des Anzahlungsartikels 98 mit positiver Menge erhöht den Umsatz, erzeugt aber keinen Rohertrag. Die Einlösung einer zuvor geleisteten Anzahlung mindert den Umsatz. Der gespeicherte Rohertrag der Warenartikel bleibt unverändert.\n\nBeispiel\nBei Kamera und Akku mit 300 Euro bereits bezahlter Anzahlung mindert die Einlösungsposition den Umsatz um 300 Euro. Der Rohertrag von Kamera und Akku bleibt erhalten.\n\nDiese fachlichen Regeln wurden für den Kassenimport bestätigt. Die konkrete Bedienung und Freigabe an der Kassa werden vor Ort eingeschult."},
    {code:"wissen.kassa.rohertrag",title:"Rohertrag, Rabatt und Rücknahme",category:"Kassa",summary:"Die bestätigten Kassenwerte richtig lesen.",body:"Gespeicherter Rohertrag\nRohertragDM bezeichnet den Rohertrag je Stück. KalkRohertrag ist der Rohertrag des Artikels multipliziert mit der Menge. Beispiel BILD ANALOG: Menge 2, RohertragDM 8,141667 und KalkRohertrag 16,283333.\n\nRabatt\nEine negative separate Sofortrabattposition mindert den Umsatz. Die positive Gegenbuchung nimmt den Rabatt zurück. Der Rohertrag beim Warenartikel bleibt erhalten.\n\nRücknahme\nEine negative Artikelmenge kennzeichnet eine Rücknahme und mindert entsprechend die Kassenwerte.\n\nGebrauchtware\nFür die vereinbarte Analysebehandlung wird bei hinterlegten 0 Prozent auch 0 Prozent Mehrwertsteuer angesetzt. Der erfasste Rohertrag bleibt maßgeblich.\n\nArtikel-Preisrechner\nDer Preisrechner verwendet den verfügbaren Durchschnitts-EK. Historische Verkaufsanalysen verwenden die erfassten Rohertragswerte der Kassa."},
    {code:"wissen.kassa.belegpruefung",title:"Belegpositionen und Sonderfälle prüfen",category:"Kassa",summary:"Belegaufbau, Nettokopf und Fälle für die fachliche Klärung.",body:"Belegaufbau\nPositionen werden mit Menge, Artikelnummer, Bezeichnung, Einzelpreis und Gesamtpreis gelesen. Die fett dargestellte Personalnummer steht über den zugehörigen Artikeln. Auf einem Beleg können mehrere Personalnummern vorkommen.\n\nNetto und brutto\nEin Nettobetrag im Belegkopf kann zu brutto gespeicherten Positionen gehören. Ein bestätigtes Beispiel: 720 Euro netto entsprechen bei 20 Prozent Mehrwertsteuer 864 Euro brutto. Solche Fälle können aus nachträglich gebuchten UID-Käufen stammen. Unklare Belege fachlich prüfen lassen.\n\nNormale Verkäufe\nSofortdrucke und Ausarbeitung HD sind normale Verkäufe; Staffelpreise ändern daran nichts.\n\nReparaturpauschale\nDie KVA-Pauschale beträgt im bestätigten Ablauf 75 Euro. Bei späterer Reparaturabrechnung wird sie gegengerechnet. Bei abgelehnter Reparatur wird sie nicht zurückbezahlt.\n\nUnklarheiten\nDatum, Filiale, Kasse, Belegnummer und die betroffenen Positionen für die zuständige Person notieren. Keine unbelegte Korrektur vornehmen."},
  ];
  function mount(host, {api}) {
    let payload = null, loading = null, query = "", category = "", current = null, busy = false, generation = 0;
    host.innerHTML = '<div class="learning-library-toolbar"><label>Wissen suchen<input type="search" data-knowledge-search placeholder="Titel, Text oder Schlagwort" /></label><label>Kategorie<select data-knowledge-category><option value="">Alle Kategorien</option></select></label><button type="button" data-knowledge-action="refresh">Aktualisieren</button><button type="button" data-knowledge-action="new" hidden>+ Wissenseintrag</button></div><p role="status" aria-live="polite" data-knowledge-status></p><div data-knowledge-list></div><dialog class="learning-library-dialog" data-knowledge-reader><header><h2 data-reader-title></h2><button type="button" data-reader-close aria-label="Schließen">×</button></header><label>Fassung<select data-reader-version></select></label><p data-reader-summary></p><article class="learning-library-text" data-reader-body></article></dialog><dialog class="learning-library-dialog" data-knowledge-editor><form><header><h2>Wissenseintrag bearbeiten</h2><button type="button" data-editor-close aria-label="Schließen">×</button></header><p>Als Entwurf speichern, fachlich prüfen und danach veröffentlichen. Vorherige Fassungen bleiben erhalten.</p><div class="learning-library-fields"><label>Kennung<input name="moduleCode" pattern="[a-z0-9][a-z0-9._-]{1,79}" maxlength="80" required /></label><label>Kategorie<input name="category" maxlength="80" required /></label><label>Geltungsbereich<select name="scope" required></select></label><label class="wide">Titel<input name="title" minlength="3" maxlength="200" required /></label><label class="wide">Kurzbeschreibung<textarea name="summary" rows="2" maxlength="600"></textarea></label><label class="wide">Wissenstext<textarea name="body" rows="14" minlength="10" maxlength="20000" required></textarea></label><label>Schlagwörter<input name="tags" placeholder="Mit Beistrich trennen" /></label><label class="wide">Versionshinweis<input name="versionNote" maxlength="300" /></label></div><p role="status" data-editor-status></p><footer><button type="button" data-editor-close>Abbrechen</button><button type="submit">Entwurf speichern</button></footer></form></dialog>';
    const el = selector => host.querySelector(selector), editor = el('[data-knowledge-editor]'), form=editor.querySelector('form'), reader=el('[data-knowledge-reader]');
    const field = name => form.elements.namedItem(name);
    function status(text) { el('[data-knowledge-status]').textContent=text; }
    function render() {
      const modules=payload?.modules || [];
      const categories=[...new Set(modules.map(m=>m.latestVersion.content.article.category))].sort((a,b)=>a.localeCompare(b,"de"));
      el('[data-knowledge-category]').innerHTML='<option value="">Alle Kategorien</option>'+categories.map(c=>`<option value="${escape(c)}">${escape(c)}</option>`).join('');
      if(!categories.includes(category)) category=""; el('[data-knowledge-category]').value=category;
      el('[data-knowledge-action="new"]').hidden=!payload?.capabilities?.canCreate;
      const shown=modules.filter(m=>{const v=m.latestVersion;return (!category||v.content.article.category===category)&&[v.title,v.content.summary,v.content.article.body,...v.content.tags].join(' ').toLocaleLowerCase('de-AT').includes(query);});
      el('[data-knowledge-list]').innerHTML=shown.map(m=>{
        const v=m.latestVersion,c=m.capabilities;
        return `<article class="learning-library-card"><div><strong>${escape(v.title)}</strong><span>${escape(v.content.article.category)} · ${m.archived?'Archiviert':m.status==='published'?'Veröffentlicht':m.status==='published_with_draft'?'Neue Fassung im Entwurf':'Entwurf'} · Fassung ${Number(v.versionNumber)}</span><p>${escape(v.content.summary)}</p></div><footer><button type="button" data-knowledge-action="read" data-id="${escape(m.id)}">Lesen</button>${c.canEdit?`<button type="button" data-knowledge-action="edit" data-id="${escape(m.id)}">Neue Fassung</button>`:''}${c.canPublish?`<button type="button" data-knowledge-action="publish" data-id="${escape(m.id)}">Veröffentlichen</button>`:''}${c.canArchive?`<button type="button" data-knowledge-action="archive" data-id="${escape(m.id)}">Archivieren</button>`:''}${c.canRestore?`<button type="button" data-knowledge-action="restore" data-id="${escape(m.id)}">Wiederherstellen</button>`:''}</footer></article>`;
      }).join('') || '<p>Noch keine passenden Wissenseinträge.</p>';
      if(payload?.capabilities?.canCreate) el('[data-knowledge-list]').insertAdjacentHTML('beforeend','<details class="learning-library-drafts"><summary>Kassa-Wissen vorbereiten</summary><p>Aus den bestätigten Kassenregeln. Vor Veröffentlichung fachlich prüfen.</p>'+drafts.map((d,i)=>`<button type="button" data-knowledge-action="preset" data-preset="${i}">${escape(d.title)}</button>`).join('')+'</details>');
      status(`${shown.length} von ${modules.length} Wissenseinträgen`);
    }
    async function load() {
      if(loading) return loading;
      const requestGeneration = generation;
      status('Wissensbibliothek wird geladen …');
      loading=(async()=>{try {
        const result=await api('/api/portal/v1/personnel-learning/knowledge');
        if(requestGeneration!==generation)return;
        payload=result;render();
      }catch(error){
        if(requestGeneration!==generation)return;
        clear();status(error.message);
      }finally{if(requestGeneration===generation)loading=null;}})();
      return loading;
    }
    function read(module) {
      const versions=module.versions || [module.latestVersion];
      el('[data-reader-version]').innerHTML=versions.map(v=>`<option value="${Number(v.versionNumber)}">Fassung ${Number(v.versionNumber)}${Number(v.versionNumber)===Number(module.publishedVersion?.versionNumber)?' · veröffentlicht':' · Entwurf / frühere Fassung'}</option>`).join('');
      const display=()=>{const v=versions.find(v=>String(v.versionNumber)===el('[data-reader-version]').value)||versions.at(-1);el('[data-reader-title]').textContent=v.title;el('[data-reader-summary]').textContent=v.content.summary;el('[data-reader-body]').textContent=v.content.article.body;};
      el('[data-reader-version]').value=String(module.publishedVersion?.versionNumber || module.latestVersion.versionNumber);
      el('[data-reader-version]').onchange=display; display();reader.showModal();
    }
    function edit(module=null,preset=null) {
      if(!payload?.capabilities?.canCreate && !module?.capabilities?.canEdit) return;
      current=module;const v=module?.latestVersion,content=v?.content;
      form.reset();field('moduleCode').value=module?.moduleCode||preset?.code||'';field('moduleCode').disabled=Boolean(module);
      field('scope').innerHTML=(payload.scopes||[]).map((s,i)=>`<option value="${i}">${escape(s.label)}</option>`).join('');
      if(v?.scope){const n=payload.scopes.findIndex(s=>s.type===v.scope.type&&String(s.locationId||'')===String(v.scope.locationId||'')&&Number(s.departmentId||0)===Number(v.scope.departmentId||0));field('scope').value=n>=0?String(n):'';}
      field('title').value=preset?.title||v?.title||'';field('category').value=preset?.category||content?.article.category||'';
      field('summary').value=preset?.summary||content?.summary||'';field('body').value=preset?.body||content?.article.body||'';
      field('tags').value=(content?.tags||[preset?.category].filter(Boolean)).join(', ');field('versionNote').value=preset?'Fachlich zu prüfende Arbeitsfassung':'';
      el('[data-editor-status]').textContent='';editor.showModal();field('title').focus();
    }
    host.addEventListener('click',async event=>{
      if(event.target.closest('[data-reader-close]')) reader.close();
      if(event.target.closest('[data-editor-close]')) editor.close();
      const button=event.target.closest('[data-knowledge-action]');if(!button||busy)return;
      const action=button.dataset.knowledgeAction,module=payload?.modules?.find(m=>m.id===button.dataset.id);
      try {
        if(action==='refresh')return await load();if(action==='new')return edit();
        if(action==='preset'){const p=drafts[Number(button.dataset.preset)],existing=payload.modules.find(m=>m.moduleCode===p.code);if(existing?.archived)throw new Error('Den vorhandenen Wissenseintrag zuerst wiederherstellen.');return edit(existing,p);}
        if(!module)return;if(action==='read')return read(module);if(action==='edit')return edit(module);
        if(!['publish','archive','restore'].includes(action))return;
        if(action==='publish'&&!root.confirm('Diese fachlich geprüfte Fassung veröffentlichen?'))return;
        busy=true;button.disabled=true;
        await api(`/api/portal/v1/personnel-learning/modules/${encodeURIComponent(module.id)}/${action}`,{method:'POST',body:JSON.stringify({expectedEventReceipt:module.currentEventReceipt,versionNumber:module.latestVersionNumber})});await load();
      }catch(error){status(error.message);}finally{busy=false;button.disabled=false;}
    });
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(busy)return;busy=true;const save=form.querySelector('[type="submit"]');save.disabled=true;
      try {
        const scope=payload.scopes[Number(field('scope').value)];if(!scope||field('scope').value==='')throw new Error('Bitte einen gültigen Bereich auswählen.');
        const body={moduleCode:field('moduleCode').value,moduleType:'knowledge',title:field('title').value,summary:field('summary').value,objective:'Wissenseintrag lesen und im passenden Arbeitsablauf anwenden.',estimatedMinutes:5,verificationMode:'self_confirmation',tags:field('tags').value.split(',').map(s=>s.trim()).filter(Boolean),versionNote:field('versionNote').value,scope,article:{category:field('category').value,body:field('body').value},steps:[{stepId:'lesen',title:'Wissenseintrag lesen',instruction:'',completionCriteria:'',required:true}],...(current?{expectedEventReceipt:current.currentEventReceipt}:{})};
        await api(current?`/api/portal/v1/personnel-learning/modules/${encodeURIComponent(current.id)}/versions`:'/api/portal/v1/personnel-learning/modules',{method:'POST',body:JSON.stringify(body)});editor.close();await load();
      }catch(error){el('[data-editor-status]').textContent=error.message;}finally{busy=false;save.disabled=false;}
    });
    el('[data-knowledge-search]').addEventListener('input',event=>{query=event.target.value.trim().toLocaleLowerCase('de-AT');render();});
    el('[data-knowledge-category]').addEventListener('change',event=>{category=event.target.value;render();});
    function clear() {
      generation++;loading=null;payload=null;current=null;query="";category="";
      reader.close();editor.close();form.reset();
      el('[data-reader-body]').textContent="";el('[data-reader-summary]').textContent="";el('[data-reader-title]').textContent="";
      el('[data-reader-version]').replaceChildren();el('[data-reader-version]').onchange=null;
      el('[data-knowledge-search]').value="";el('[data-knowledge-category]').innerHTML='<option value="">Alle Kategorien</option>';
      el('[data-knowledge-action="new"]').hidden=true;el('[data-knowledge-list]').replaceChildren();status("");
    }
    return {load,clear};
  }
  if(typeof module==='object'&&module.exports)module.exports={drafts};
  else root.GrabenplanerLearningLibrary={mount};
})(globalThis);
