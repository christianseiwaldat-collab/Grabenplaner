(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GrabenplanerNavigationHistory = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  function create({ window: win, app, keys, read, apply, enabled = () => true, onError = () => {} }) {
    let started = false, restoring = false, pending = false, generation = 0, previous = '';
    const allowed = new Set(keys);
    function routeUrl() {
      const url = new URL(win.location.href), route = read();
      for (const key of allowed) url.searchParams.delete(key);
      // Explicit route identifiers only. Never copy forms, reports or fetched
      // personnel/customer data into the URL or browser history state.
      for (const [key, value] of Object.entries(route)) {
        if (allowed.has(key) && typeof value === 'string' && value.length && value.length <= 160) url.searchParams.set(key, value);
      }
      return url.pathname + url.search + url.hash;
    }
    function write(replace) {
      if (!started || !enabled()) return;
      const url = routeUrl();
      if (!replace && url === previous) return;
      const state = { ...(win.history.state || {}), gpNavigation: { version: 1, app } };
      win.history[replace ? 'replaceState' : 'pushState'](state, '', url);
      previous = url;
    }
    function safely(work) { try { work(); } catch (error) { onError(error); } }
    function record() {
      if (!started || restoring || pending || !enabled()) return;
      pending = true; const ticket = generation;
      // Several setters in one click (module + subsection) form one visit.
      win.queueMicrotask(() => {
        if (ticket !== generation) return;
        pending = false; safely(() => write(false));
      });
    }
    function start() {
      generation++; pending = false; started = enabled();
      if (started) safely(() => write(true));
    }
    function stop() { generation++; pending = false; started = false; }
    function restore() {
      generation++; pending = false;
      if (!started || !enabled()) return;
      restoring = true;
      try { apply(); write(true); } catch (error) { onError(error); }
      finally { restoring = false; }
    }
    function replace() { if (!restoring) safely(() => write(true)); }
    win.addEventListener('popstate', restore);
    return Object.freeze({ start, stop, record, replace, dispose() { stop(); win.removeEventListener('popstate', restore); } });
  }
  return { create };
});
