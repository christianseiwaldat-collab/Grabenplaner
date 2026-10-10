(function(root,factory){
  'use strict'; const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GpBranchOrderPdfWindow=api;
})(typeof window==='object'?window:globalThis,function(){
  'use strict';
  function pdfUrl(value) {
    const id = String(value || '').trim();
    if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) throw Error('Die Bestellung ist ungültig.');
    return '/api/portal/v1/branch-orders/' + encodeURIComponent(id) + '/pdf';
  }
  function mount(config) {
    const win = config.document?.defaultView || config.host?.ownerDocument?.defaultView;
    if (!win?.GpExistingPdfWindow || !config.key || !config.orders || !config.scopeKey) throw Error('Die Bestellvorschau benötigt das GP-Druckfenster und eine aktuelle Auswahl.');
    let selected = null;
    const current = () => {
      if (!config.key() || !config.canUse()) return false;
      if (!selected) return true;
      return selected.owner === String(config.key()) && selected.scope === String(config.scopeKey())
        && config.orders().some(order => String(order.id) === selected.id);
    };
    const controller = win.GpExistingPdfWindow.mount({
      ...config, id: config.id || 'branch-order-pdf', title: 'Filialbestellung · PDF',
      canUse: current, commonFields: { title: 'readonly', filename: true, orientation: false },
      useServerFilename: ({ payload, values }) => values.filename.replace(/\.pdf$/i, '') === payload.filename,
      defaults: payload => ({ title: payload?.title || 'Filialbestellung', filename: payload?.filename || 'Filialbestellung' }),
      request({ payload }) {
        if (!current() || !config.active() || !selected || selected.id !== payload.id) {
          throw Object.assign(Error('Die PDF-Anforderung wurde verworfen.'), { name: 'AbortError' });
        }
        return { url: pdfUrl(payload.id) };
      },
      summary: 'Unverändertes Original der gespeicherten Bestellung',
      onClose() { selected = null; config.onClose?.(); },
    });
    return {
      open(order, target) {
        controller.reset(); selected = null;
        if (!current() || !config.active() || !config.orders().some(value => value.id === order?.id)) return false;
        const id = String(order.id), week = String(order.calendarWeek || ''), date = String(order.submittedAt || '').slice(0,10);
        pdfUrl(id); selected = { id, owner: String(config.key()), scope: String(config.scopeKey()) };
        return controller.open({ target, payload: { id, title: 'Filialbestellung · KW ' + week, filename: 'Filialbestellung-KW' + week + (date ? '-' + date : '') } });
      },
      reset() { selected = null; controller.reset(); },
      sync() { if (!current()) this.reset(); return controller.sync(); },
      activate() { controller.activate(); },
      deactivate() { controller.deactivate(); },
      destroy() { this.reset(); controller.destroy(); },
      get element() { return controller.element; },
      get state() { return controller.state; },
    };
  }
  return Object.freeze({ pdfUrl, mount });
});
