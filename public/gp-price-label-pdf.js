(function(root,factory){
  'use strict'; const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GpPriceLabelPdf=api;
})(typeof window==='object'?window:globalThis,function(){
  'use strict';
  const FORM_KEYS = ['articleNumbers','priceType','options','name','stamp','position','separator','suffix'];
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  function exactKeys(value, keys) {
    if (!object(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw Error('Die Preisschild-PDF-Auswahl ist ungültig.');
  }
  function capture({ url, body, filename, dimensions, metadata = {} }) {
    if (url === '/api/sales/price-labels/export.pdf') {
      exactKeys(body, FORM_KEYS);
      if (!Array.isArray(body.articleNumbers) || !object(body.options)) throw Error('Die Preisschild-PDF-Auswahl ist ungültig.');
    } else if (url === '/api/sales/price-labels/projects/export.pdf') {
      exactKeys(body, ['project','name']);
      if (!object(body.project)) throw Error('Die Preisschild-PDF-Auswahl ist ungültig.');
    } else if (/^\/api\/sales\/price-labels\/library\/[^/?#]+\/article\.pdf$/.test(url)) {
      exactKeys(body, ['articleNumber']);
      if (typeof body.articleNumber !== 'string' || !body.articleNumber.trim()) throw Error('Die Preisschild-PDF-Auswahl ist ungültig.');
    } else throw Error('Die Preisschild-PDF-Adresse ist ungültig.');
    const serialized = JSON.stringify(body);
    if (new TextEncoder().encode(serialized).byteLength > 1024*1024) throw Error('Die Preisschild-PDF-Auswahl ist zu groß.');
    return Object.freeze({ url, body: serialized, filename: String(filename || 'Preisschilder.pdf'), summary: paperSummary(dimensions), metadata: Object.freeze(structuredClone(metadata)) });
  }
  function paperSummary(value) {
    const valid = number => typeof number === 'number' && Number.isFinite(number) && number > 0;
    if (!object(value) || !valid(value.width) || !valid(value.height)) throw Error('Die Papiergröße für die Preisschild-PDF ist ungültig.');
    const number = value => new Intl.NumberFormat('de-AT',{maximumFractionDigits:2}).format(value);
    const labels = (value.labels || []).filter(label => valid(label.width) && valid(label.height));
    const distinct = [...new Set(labels.map(label => number(label.width)+' × '+number(label.height)+' mm'))];
    const labelText = distinct.length ? ' · Schilder '+distinct.slice(0,2).join(', ')+(distinct.length>2?' · individuelle Größen':'') : '';
    return 'Papier '+number(value.width)+' × '+number(value.height)+' mm'+labelText+' · 100 % / Tatsächliche Größe drucken';
  }
  function mount(config) {
    const doc = config.document || config.host?.ownerDocument, win = doc?.defaultView;
    if (!win?.GpExistingPdfWindow || typeof config.key !== 'function' || typeof config.context !== 'function') throw Error('Die Preisschild-PDF benötigt das GP-Druckfenster und einen aktuellen Entwurf.');
    let selected = null, dead = false;
    const allowed = () => !dead && Boolean(config.key()) && config.canUse()
      && (!selected || selected.owner === String(config.key()) && selected.context === String(config.context()));
    const controller = win.GpExistingPdfWindow.mount({
      document: doc, host: config.host, id: config.id || 'price-label-pdf', title: config.title || 'Preisschilder · PDF',
      key: config.key, rawApi: async (url, init) => {
        const reference = selected;
        const check = () => {
          if (init.signal?.aborted || !reference || selected !== reference || !allowed() || !config.active()) throw Object.assign(Error('Die PDF-Anforderung wurde verworfen.'),{name:'AbortError'});
        };
        check(); const response = await config.rawApi(url,init); check();
        if (response?.ok) await config.validateResponse?.(reference.payload,response,init.signal); check();
        return response;
      }, canUse: allowed, active: config.active,
      windowPreferences: config.windowPreferences, geometry: config.geometry,
      commonFields: false, useServerFilename: true,
      defaults: payload => ({ title: config.title || 'Preisschilder', filename: payload?.filename || 'Preisschilder' }),
      request({ payload, actor }) {
        if (!allowed() || !config.active() || !selected || selected.payload !== payload || actor !== selected.owner) {
          throw Object.assign(Error('Die PDF-Anforderung wurde verworfen.'), { name:'AbortError' });
        }
        return { url: payload.url, init: { method:'POST', headers:{'Content-Type':'application/json'}, body:payload.body } };
      },
      summary: ({ payload }) => payload.summary,
      onClose() { selected=null; config.onClose?.(); },
      onState: config.onState,
    });
    return {
      open(input, target) {
        this.reset();
        if (!allowed() || !config.active()) return false;
        const payload = capture(input);
        selected = { payload, owner:String(config.key()), context:String(config.context()) };
        return controller.open({ payload, target });
      },
      sync() { if (!allowed()) this.reset(); return controller.sync(); },
      reset() { selected=null; controller.reset(); },
      activate() { controller.activate(); },
      deactivate() { controller.deactivate(); },
      destroy() { this.reset(); dead=true; controller.destroy(); },
      get element() { return controller.element; },
      get state() { return controller.state; },
    };
  }
  return Object.freeze({ capture, paperSummary, mount });
});
