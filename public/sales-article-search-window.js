(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SalesArticleSearchWindow = api;
})(typeof window === 'object' ? window : this, function () {
  'use strict';
  const DEFAULTS = Object.freeze({version:2, x:0, y:0, width:560, height:620, minimized:false});
  const clamp = (value, min, max) => Math.min(max, Math.max(min, Math.round(value)));
  function normalize(value) {
    const number = (key, min, max) => typeof value?.[key] === 'number' && Number.isFinite(value[key])
      ? clamp(value[key], min, max) : DEFAULTS[key];
    return {version:2, x:number('x',0,16384), y:number('y',0,16384), width:number('width',280,4096),
      height:number('height',200,4096), minimized:value?.minimized === true};
  }
  function defaultGeometry(bounds) {
    return {...DEFAULTS, x:Math.max(0, Math.floor(bounds.width - DEFAULTS.width))};
  }
  function contentBounds(content, header, viewport, scale = 1) {
    const zoom = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const viewportLeft = viewport.left || 0, viewportTop = viewport.top || 0;
    const right = Math.min(viewportLeft + viewport.width - 8, content?.right || viewportLeft + viewport.width - 8);
    const bottom = viewportTop + viewport.height - 8;
    const left = Math.min(right - 1, Math.max(viewportLeft + 8, content?.left || viewportLeft + 8));
    const top = Math.max(viewportTop + 8, (header?.bottom || viewportTop) + 8);
    return {left:left/zoom,top:top/zoom,width:Math.max(1,(right-left)/zoom),height:Math.max(1,(bottom-top)/zoom)};
  }
  function viewportBounds(viewport, scale = 1) {
    const zoom = Number.isFinite(scale) && scale > 0 ? scale : 1;
    return {left:(viewport.left || 0)/zoom,top:(viewport.top || 0)/zoom,
      width:Math.max(1,viewport.width/zoom),height:Math.max(1,viewport.height/zoom)};
  }
  function migrateGeometry(value, legacyBounds, bounds) {
    if (value && value.version !== 1) return normalize(value);
    // V1 positions were relative to the article workspace below its header.
    // Preserve their visible position and preferred size when moving to V2.
    const preferred = value ? normalize(value) : defaultGeometry(legacyBounds);
    const visible = fit(preferred,legacyBounds);
    return normalize({...preferred,x:legacyBounds.left+visible.x-bounds.left,
      y:legacyBounds.top+visible.y-bounds.top});
  }
  function fit(preferred, bounds, titleHeight = 44) {
    const value = normalize(preferred), width = Math.min(value.width, Math.max(1, bounds.width));
    const height = Math.min(value.minimized ? titleHeight : value.height, Math.max(1, bounds.height));
    return {...value, width, height, x:clamp(value.x,0,Math.max(0,bounds.width-width)),
      y:clamp(value.y,0,Math.max(0,bounds.height-height))};
  }

  // Late reads cannot alter an inactive view. Saves may finish after ordinary
  // navigation, but neither request lifecycle may cross an account or rights change.
  function createPreferences(options) {
    let actor = '', epoch = 0, revision = 0, loaded = false, active = false, destroyed = false;
    let read = null, write = null, chain = Promise.resolve();
    const abort = () => { read?.controller.abort(); write?.abort(); read = null; write = null; };
    const current = (key, ticket) => !destroyed && options.canUse()
      && key === options.key() && actor === key && ticket === epoch;
    function invalidate() {
      epoch++; revision++; loaded = false; abort(); actor = String(options.key() || '');
      options.apply(null);
    }
    function synchronize() { if (actor !== String(options.key() || '')) invalidate(); }
    async function activate() {
      if (destroyed) return;
      active = true; synchronize();
      if (!options.canUse() || loaded || read) return read?.promise;
      const key = actor, ticket = epoch, version = revision;
      const controller = new AbortController(), request = {controller}; read = request;
      request.promise = (async () => {
        try {
          const value = await options.api('/api/sales/articles/window-preferences', {signal:controller.signal});
          if (controller.signal.aborted || !active || !current(key,ticket) || version !== revision) return;
          const preferred = value?.configured === true
            ? normalize(options.migrate ? options.migrate(value) : value) : null;
          loaded = true; options.apply(preferred);
          if (preferred && value.version === 1 && options.migrate) void change(preferred);
        } catch (error) {
          if (!controller.signal.aborted && active && current(key,ticket) && version === revision) options.error(error);
        } finally { if (read === request) read = null; }
      })();
      return request.promise;
    }
    function change(value) {
      synchronize();
      if (!active || destroyed || !options.canUse()) return Promise.resolve();
      revision++; loaded = true; read?.controller.abort(); read = null;
      const key = actor, ticket = epoch, version = revision, body = JSON.stringify(normalize(value));
      chain = chain.catch(() => {}).then(async () => {
        if (!current(key,ticket)) return;
        const controller = new AbortController(); write = controller;
        try { await options.api('/api/sales/articles/window-preferences', {method:'PUT',body,signal:controller.signal}); }
        catch (error) {
          if (!controller.signal.aborted && current(key,ticket)) {
            if (version === revision) loaded = false;
            options.error(error);
          }
        }
        finally { if (write === controller) write = null; }
      });
      return chain;
    }
    function suspend({abortWrites = false} = {}) {
      active = false; read?.controller.abort(); read = null;
      if (abortWrites) { epoch++; loaded = false; abort(); }
    }
    return {activate, change, invalidate, suspend, destroy() { destroyed = true; suspend({abortWrites:true}); }};
  }

  function attach(element, options) {
    const doc = element.ownerDocument, win = options.window || doc.defaultView;
    const title = element.querySelector('[data-article-window-title]');
    const body = element.querySelector('[data-article-window-body]');
    const toggle = element.querySelector('[data-article-window-toggle]');
    const reset = element.querySelector('[data-article-window-reset]');
    const resize = element.querySelector('[data-article-window-resize]');
    const status = element.querySelector('[data-article-window-status]');
    const removers = [], on = (target,type,fn) => { target?.addEventListener(type,fn); removers.push(() => target?.removeEventListener(type,fn)); };
    const initialGeometry = () => options.initialGeometry ? normalize(options.initialGeometry()) : defaultGeometry(options.bounds());
    let preferred = initialGeometry(), fitted = null, active = false, drag = null, last = '', destroyed = false;
    const canUse = () => !destroyed && active && options.canUse();
    function announce() {
      if (status) status.textContent = preferred.minimized ? 'Suchfenster minimiert.'
        : `Suchfenster: ${Math.round(fitted.width)} × ${Math.round(fitted.height)} Pixel, Position ${fitted.x}, ${fitted.y}.`;
    }
    function render() {
      element.hidden = !canUse();
      if (!canUse()) return;
      const bounds = options.bounds();
      fitted = fit(preferred,bounds,Math.max(44,title?.offsetHeight || 44));
      element.style.left = `${bounds.left + fitted.x}px`; element.style.top = `${bounds.top + fitted.y}px`;
      element.style.width = `${fitted.width}px`; element.style.height = `${fitted.height}px`;
      element.classList.toggle('is-minimized',preferred.minimized);
      if (preferred.minimized && body.contains(doc.activeElement)) toggle.focus({preventScroll:true});
      body.hidden = preferred.minimized;
      toggle.setAttribute('aria-expanded',String(!preferred.minimized));
      toggle.setAttribute('aria-label',preferred.minimized ? 'Suchfenster wiederherstellen' : 'Suchfenster minimieren');
      toggle.textContent = preferred.minimized ? '▢' : '−';
      resize.hidden = preferred.minimized;
      const dimensions = `${fitted.width}|${fitted.height}|${preferred.minimized}`;
      if (last !== dimensions) { last = dimensions; options.resize?.(fitted); }
    }
    function commit() { render(); announce(); options.change({...preferred}); }
    function finish(cancel = false) {
      if (!drag) return;
      const previous = drag; drag = null; element.classList.remove('is-moving','is-resizing');
      if (cancel) { preferred = previous.original; render(); }
      else commit();
      if (previous.handle.hasPointerCapture?.(previous.id)) previous.handle.releasePointerCapture(previous.id);
    }
    function begin(event) {
      const handle = event.target.closest('[data-article-window-move],[data-article-window-resize]');
      if (!handle || !element.contains(handle) || event.button !== 0 || !canUse() || drag) return;
      const kind = handle.hasAttribute('data-article-window-resize') ? 'resize' : 'move';
      if (kind === 'resize' && preferred.minimized) return;
      event.preventDefault(); handle.focus({preventScroll:true}); render();
      drag = {id:event.pointerId,handle,kind,x:event.clientX,y:event.clientY,scale:options.scale(),
        original:{...preferred},base:{...fitted}};
      element.classList.add(kind === 'move' ? 'is-moving' : 'is-resizing'); handle.setPointerCapture(event.pointerId);
    }
    function move(event) {
      if (!drag || event.pointerId !== drag.id) return;
      if (!canUse()) { finish(true); return; }
      const dx = (event.clientX-drag.x)/drag.scale, dy = (event.clientY-drag.y)/drag.scale, bounds = options.bounds();
      preferred = normalize(drag.kind === 'move'
        ? {...drag.original,x:clamp(drag.base.x+dx,0,Math.max(0,bounds.width-drag.base.width)),y:clamp(drag.base.y+dy,0,Math.max(0,bounds.height-drag.base.height))}
        : {...drag.original,x:drag.base.x,y:drag.base.y,width:Math.max(280,Math.min(bounds.width-drag.base.x,drag.base.width+dx)),height:Math.max(200,Math.min(bounds.height-drag.base.y,drag.base.height+dy))});
      render();
    }
    function keydown(event) {
      if (event.key === 'Escape' && drag) { event.preventDefault(); event.stopPropagation(); finish(true); return; }
      const handle = event.target.closest?.('[data-article-window-move],[data-article-window-resize]');
      if (!handle || !element.contains(handle) || !canUse() || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); finish(true); render();
      const bounds = options.bounds(), step = event.shiftKey ? 40 : 10, resizeHandle = handle.hasAttribute('data-article-window-resize');
      if (resizeHandle && preferred.minimized) return;
      if (resizeHandle) {
        const width = event.key === 'Home' ? 280 : event.key === 'End' ? bounds.width-fitted.x : fitted.width + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0);
        const height = event.key === 'Home' ? 200 : event.key === 'End' ? bounds.height-fitted.y : fitted.height + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0);
        preferred = normalize({...preferred,width:Math.max(280,Math.min(bounds.width-fitted.x,width)),height:Math.max(200,Math.min(bounds.height-fitted.y,height))});
      } else {
        preferred = normalize({...preferred,x:event.key === 'Home' ? 0 : event.key === 'End' ? Math.max(0,bounds.width-fitted.width) : clamp(fitted.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),0,Math.max(0,bounds.width-fitted.width)),
          y:event.key === 'Home' ? 0 : event.key === 'End' ? Math.max(0,bounds.height-fitted.height) : clamp(fitted.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0),0,Math.max(0,bounds.height-fitted.height))});
      }
      commit();
    }
    function minimize(value, persist = true) {
      if (!canUse()) return;
      finish(true);
      if (preferred.minimized === value) return;
      if (value && body.contains(doc.activeElement)) toggle.focus({preventScroll:true});
      preferred = {...preferred,minimized:value}; render(); announce(); if (persist) options.change({...preferred});
    }
    function refresh() { if (drag) finish(true); render(); }
    on(element,'pointerdown',begin); on(element,'pointermove',move);
    on(element,'pointerup',event => { if (drag?.id === event.pointerId) finish(); });
    for (const type of ['pointercancel','lostpointercapture']) on(element,type,event => { if (drag?.id === event.pointerId) finish(true); });
    on(element,'keydown',keydown); on(doc,'keydown',event => { if (event.key === 'Escape' && drag) keydown(event); });
    on(toggle,'click',() => minimize(!preferred.minimized));
    on(reset,'click',() => { if (canUse()) { finish(true); preferred = initialGeometry(); commit(); } });
    on(win,'resize',refresh); on(win,'scroll',refresh); on(win,'blur',() => finish(true));
    on(win.visualViewport,'resize',refresh); on(win.visualViewport,'scroll',refresh);
    const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(refresh) : null;
    for (const target of options.observe || []) if (target) observer?.observe(target);
    render();
    return {refresh, get preferred() {return {...preferred};}, get fitted() {return fitted && {...fitted};},
      set(value) { finish(true); preferred = value ? normalize(value) : initialGeometry(); render(); },
      restore() { minimize(false); },
      activate() { active = true; render(); },
      suspend() { finish(true); active = false; element.hidden = true; },
      destroy() { finish(true); destroyed = true; observer?.disconnect(); for (const remove of removers) remove(); element.hidden = true; }
    };
  }
  return Object.freeze({DEFAULTS, normalize, defaultGeometry, contentBounds, viewportBounds, migrateGeometry, fit, createPreferences, attach});
});
