(function(host,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(host)host.GrabenplanerTradeExport=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const defaults={stamp:'date-time',position:'before',separator:'-',suffix:''};
 const preferenceKey='trade_insight_pdf_options_v1';
 function options(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['stamp','position','separator','suffix'].includes(k)))throw new TypeError('Invalid export options');
  const value={...defaults,...input};
  if(!['none','date','date-time','date-suffix'].includes(value.stamp)||!['before','after'].includes(value.position)||!['-','_',' '].includes(value.separator)||typeof value.suffix!=='string'||value.suffix.length>40)throw new TypeError('Invalid export options');
  return value;
 }
 function cleanName(value){return String(value||'Einkauf-Bestand').normalize('NFKC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g,'').replace(/\.pdf$/i,'').trim().replace(/^[. ]+|[. ]+$/g,'').slice(0,110)||'Einkauf-Bestand';}
 function filename(name,input={},now=new Date()){
  const config=options(input),parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Vienna',year:'2-digit',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const get=k=>parts.find(v=>v.type===k).value,date=get('year')+get('month')+get('day');
  const block=config.stamp==='none'?'':config.stamp==='date-time'?date+'-'+get('hour')+get('minute'):config.stamp==='date-suffix'?date+(config.suffix.trim()?'-'+cleanName(config.suffix):''):date;
  return (config.position==='before'?[block,cleanName(name)]:[cleanName(name),block]).filter(Boolean).join(config.separator)+'.pdf';
 }
const createPrintMount = function createMount(E, P) {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return function mount(root, { api, rawApi, accessKey, scopeKey, canUse = () => true, active = () => true, windowPreferences, status = () => {} }) {
    const win = root.ownerDocument.defaultView;
    if (!win.GpExistingPdfWindow || typeof rawApi !== 'function' || typeof accessKey !== 'function' || typeof scopeKey !== 'function') throw Error('PDF-Ausgabe benötigt das GP-Druckfenster und eine aktuelle Berechtigung.');
    let saved = { ...E.defaults }, savedOwner = '', selection = null, work = null, serial = 0, preferenceRequest = null;
    const key = () => String(accessKey() || '');
    const allowed = () => Boolean(key() && canUse() && (!selection || selection.owner === key() && selection.scope === String(scopeKey())));
    const requestAllowed = () => allowed() && active();
    const valid = (owner, signal) => P.assertCurrent({ key, owner, signal, canUse: requestAllowed });
    function syncSavedOwner() {
      if (savedOwner !== key()) { saved = { ...E.defaults }; savedOwner = key(); }
    }
    function stopWork() {
      serial++;
      work?.controller.abort(); work = null;
      preferenceRequest?.abort(); preferenceRequest = null;
    }
    function startWork(payload) {
      const controller = new win.AbortController(), owner = key();
      const promise = P.completeTarget(payload, { api, signal: controller.signal, key, owner, canUse: requestAllowed, status });
      // The complete result is produced once per captured query; edits to the
      // filename only abort that PDF fetch, not creation of a second server job.
      promise.catch(() => {});
      work = { controller, owner, payload, promise };
      return work;
    }
    const controller = win.GpExistingPdfWindow.mount({
      document: root.ownerDocument, host: root, id: 'trade-insights-pdf', title: 'Einkauf & Bestand · PDF',
      key, canUse: allowed, active, rawApi, windowPreferences, useServerFilename: true,
      commonFields: { title: 'readonly', filename: false, orientation: false },
      defaults: payload => ({ title: payload?.title || 'Einkauf & Bestand', filename: payload?.title || 'Einkauf-Bestand' }),
      async request({ payload, options, actor, signal }) {
        valid(actor, signal);
        const current = work?.payload === payload ? work : startWork(payload);
        const target = await current.promise;
        valid(actor, signal);
        return { url: P.downloadUrl(target, { name: options.name, settings: options.settings, validateOptions: E.options, origin: win.location.origin }) };
      },
      summary: 'Vollständiger gespeicherter Ergebnisstand',
      renderOptions(host, { payload, actor }) {
        const value = { ...saved }, name = E.cleanName(payload?.title);
        host.innerHTML = '<div class="trade-export-options">' +
          '<label>Dateiname<input name="tradePdfName" maxlength="110" required value="' + escape(name) + '"></label>' +
          '<label>Zeitblock<select name="tradePdfStamp"><option value="date-time">JJMMTT-HHMM</option><option value="date">JJMMTT</option><option value="date-suffix">JJMMTT-xxx</option><option value="none">Ohne Zeitblock</option></select></label>' +
          '<label>Anordnung<select name="tradePdfPosition"><option value="before">Vorne</option><option value="after">Hinten</option></select></label>' +
          '<label>Eigene Ergänzung (xxx)<input name="tradePdfSuffix" maxlength="40" placeholder="z. B. Filiale18" value="' + escape(value.suffix) + '"></label>' +
          '<label>Trennzeichen<select name="tradePdfSeparator"><option value="-">Bindestrich (-)</option><option value="_">Unterstrich (_)</option><option value=" ">Leerzeichen</option></select></label>' +
          '<div><small>Dateinamenvorschau · Zeit in Wien</small><strong data-trade-pdf-name></strong></div>' +
          '<p>Die PDF enthält den vollständigen gespeicherten Ergebnisstand. Die Abfragedauer steht unten auf der letzten Seite.</p>' +
          '<button type="button" data-trade-pdf-save>Optionen für mein Konto speichern</button><p data-trade-pdf-save-status role="status"></p></div>';
        const field = name => host.querySelector('[name="tradePdf' + name + '"]');
        for (const name of ['Stamp','Position','Separator']) field(name).value = value[name.toLowerCase()];
        const read = () => E.options(Object.fromEntries(['stamp','position','separator','suffix'].map(name => [name, field(name[0].toUpperCase() + name.slice(1)).value])));
        const preview = () => {
          field('Suffix').disabled = field('Stamp').value !== 'date-suffix';
          host.querySelector('[data-trade-pdf-name]').textContent = E.filename(field('Name').value, read());
        };
        host.addEventListener('input', preview); host.addEventListener('change', preview);
        const button = host.querySelector('[data-trade-pdf-save]'), message = host.querySelector('[data-trade-pdf-save-status]');
        const save = async () => {
          if (!requestAllowed() || actor !== key()) return;
          preferenceRequest?.abort(); const pending = new win.AbortController(); preferenceRequest = pending;
          button.disabled = true; message.textContent = 'Optionen werden gespeichert …';
          try {
            const chosen = read(), response = await api('export-options', chosen, pending.signal);
            valid(actor, pending.signal); saved = E.options(response); savedOwner = actor;
            message.textContent = JSON.stringify(chosen) === JSON.stringify(read()) ? 'Optionen für dein Konto gespeichert.' : 'Der gewählte Stand wurde gespeichert; die aktuelle Auswahl enthält weitere Änderungen.';
          } catch (error) { if (error.name !== 'AbortError' && requestAllowed() && actor === key()) message.textContent = error.message; }
          finally { if (preferenceRequest === pending) { preferenceRequest = null; if (actor === key()) button.disabled = false; } }
        };
        button.addEventListener('click', save); preview();
        return () => { preferenceRequest?.abort(); preferenceRequest = null; host.removeEventListener('input', preview); host.removeEventListener('change', preview); button.removeEventListener('click', save); };
      },
      readOptions(host) {
        const field = name => host.querySelector('[name="tradePdf' + name + '"]')?.value || '';
        return { name: field('Name'), settings: E.options(Object.fromEntries(['stamp','position','separator','suffix'].map(name => [name, field(name[0].toUpperCase() + name.slice(1))]))) };
      },
      validateOptions(value) { return !value.name.trim() || value.name.length > 110 ? 'Bitte einen Dateinamen mit höchstens 110 Zeichen wählen.' : ''; },
      onClose() { stopWork(); selection = null; },
    });
    return {
      async open(input) {
        stopWork(); controller.reset(); selection = null; syncSavedOwner();
        if (!requestAllowed()) return false;
        const ticket = serial, owner = key(), pending = new win.AbortController(); preferenceRequest = pending;
        try {
          const response = await api('export-options', undefined, pending.signal);
          valid(owner, pending.signal); saved = E.options(response); savedOwner = owner;
        }
        catch (error) { if (error.name === 'AbortError') return false; if (key() === owner && requestAllowed()) status('Die gespeicherten Optionen sind gerade nicht verfügbar. Du kannst sie erneut wählen.'); }
        finally { if (preferenceRequest === pending) preferenceRequest = null; }
        if (ticket !== serial || owner !== key() || !requestAllowed()) return false;
        const payload = P.capturedTarget(input); selection = { owner, scope: String(scopeKey()), payload }; startWork(payload);
        return controller.open({ payload, target: input.target });
      },
      close() { stopWork(); controller.reset(); selection = null; },
      reset() { this.close(); },
      sync() { syncSavedOwner(); if (!allowed()) this.close(); return controller.sync(); },
      activate() { controller.activate(); },
      deactivate() { stopWork(); controller.deactivate(); },
      destroy() { this.close(); controller.destroy(); },
      get element() { return controller.element; },
      get state() { return controller.state; },
    };
  };
};

 function mount(root,config){const requests=typeof module==='object'&&module.exports?require('./trade-pdf-request'):globalThis.GrabenplanerTradePdfRequest;return createPrintMount({defaults,options,cleanName,filename},requests)(root,config);}
 return {defaults,options,filename,cleanName,preferenceKey,mount};
});
