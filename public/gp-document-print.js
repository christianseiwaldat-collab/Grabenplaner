(function (root, factory) {
  'use strict'; const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GpDocumentPrint = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const ID = '[A-Za-z0-9_-]+';
  const routes = [
    new RegExp('^/api/(?:portal/v1/self/)?time-record-statements/' + ID + '/download$'),
    new RegExp('^/api/portal/v1/personnel-learning/assignments/' + ID + '/confirmation\\.pdf$'),
    new RegExp('^/api/portal/v1/loans/documents/' + ID + '$'),
    new RegExp('^/api/portal/v1/loans/photo-attachments/' + ID + '/download$'),
    /^\/api\/portal\/v1\/system-center\/recovery-assurance\/reports\/[a-f0-9]{64}\.pdf$/
  ];
  function matchUrl(value, origin) {
    try {
      const url = new URL(value, origin);
      if (url.origin !== new URL(origin).origin || url.username || url.password || url.hash || url.search) return null;
      return routes.some(route => route.test(url.pathname)) ? url.pathname : null;
    } catch { return null; }
  }
  function visibleTarget(doc, preferred) {
    const candidates = [preferred, ...(doc.querySelectorAll?.('[data-gp-print-fallback]') || [])];
    return candidates.find(node => node?.isConnected && (!node.getClientRects || node.getClientRects().length > 0)) || null;
  }
  function mount(config) {
    const doc = config.document || globalThis.document, win = doc.defaultView;
    let print = null, page = null, target = null, sourceTarget = null, sourceUrl = '', context = '', owner = '', extraGuard = null, navigationActive = null, bridge = null;
    const currentContext = () => JSON.stringify(config.context?.(sourceUrl) ?? null);
    const sameTarget = () => { try { return !sourceTarget || (sourceTarget.isConnected && (!sourceTarget.href || new URL(sourceTarget.href, win.location.origin).href === new URL(sourceUrl, win.location.origin).href)); } catch { return false; } };
    const visible = () => !target || (typeof target.getClientRects !== 'function' || target.getClientRects().length > 0);
    const canUse = () => Boolean(owner) && owner === String(config.key() || '') && context === currentContext() && (config.canUse?.(page, sourceUrl) ?? true) && sameTarget() && (extraGuard?.() ?? true) && (bridge?.canUse?.() ?? true);
    const active = () => page === config.page() && canUse() && visible();
    function release(restore) {
      const prior = bridge; bridge = null;
      if (!prior) return;
      if (restore) prior.onClose?.(); else prior.onDiscard?.();
    }
    function reset() {
      release(false); print?.reset(); page = null; target = null; sourceTarget = null; owner = ''; extraGuard = null; navigationActive = null;
    }
    function sync() {
      // A suspended ordinary document retains its options. A modal bridge must
      // be discarded on navigation so an old form cannot reappear later.
      if (page !== null && (!canUse() || (bridge && page !== config.page()))) reset();
      const enabled = active();
      if (print && page !== null && navigationActive !== enabled) { navigationActive = enabled; if (enabled) print.activate(); else print.deactivate(); }
      print?.sync();
    }
    function open(url, trigger, title = 'Gespeicherte PDF', sourceGuard = null, perOpenBridge = null) {
      try {
        const checked = new URL(url, win.location.origin);
        if (checked.origin !== win.location.origin || checked.username || checked.password || checked.hash || !checked.pathname.startsWith('/api/')) return false;
      } catch { return false; }
      if (!config.key() || !(config.canUse?.(config.page(), url) ?? true)) return false;
      reset();
      bridge = perOpenBridge || config.beforeOpen?.({url, target:trigger, title}) || null;
      owner = String(config.key()); page = config.page(); sourceTarget = trigger || null; sourceUrl = url; context = currentContext(); extraGuard = sourceGuard;
      target = bridge ? visibleTarget(doc, bridge.target) : (trigger || visibleTarget(doc, null));
      if (!print) print = win.GpExistingPdfWindow.mount({
        id: config.id || 'document-pdf', title: 'PDF-Ausgabe', document: doc,
        key: config.key, canUse, active, rawApi: config.rawApi,
        windowPreferences: typeof config.windowPreferences === 'function' ? config.windowPreferences() : config.windowPreferences,
        commonFields: false, useServerFilename: true,
        defaults: payload => ({title: payload?.title || 'Gespeicherte PDF', filename: 'Dokument'}),
        request: ({payload}) => ({url: payload.url}),
        summary: 'Originaldokument · Inhalt und Papierformat bleiben erhalten',
        onClose() { const restore = active(); release(restore); },
      });
      navigationActive = active();
      if (!navigationActive) { release(canUse() && page === config.page()); reset(); return false; }
      print.activate();
      const opened = print.open({payload: {url, title}, target});
      if (!opened) { release(active()); reset(); }
      return opened;
    }
    function click(event) {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor = event.target.closest?.('a[href]'); if (!anchor) return;
      const url = matchUrl(anchor.href, win.location.origin); if (!url) return;
      if (open(url, anchor, anchor.textContent.trim().slice(0, 120))) event.preventDefault();
    }
    doc.addEventListener('click', click);
    const observer = win.MutationObserver ? new win.MutationObserver(() => { if (page !== null && (!canUse() || active() !== navigationActive)) sync(); }) : null;
    observer?.observe(doc.documentElement, {childList:true, subtree:true, attributes:true, attributeFilter:['class','hidden','aria-hidden','href']});
    return {open, sync, reset, destroy(){reset();observer?.disconnect();doc.removeEventListener('click',click);print?.destroy();print=null;}};
  }
  return Object.freeze({mount, matchUrl, visibleTarget});
});
