(function (root, factory) {
  'use strict';
  const windows = typeof module === 'object' && module.exports ? require('./gp-window') : root.GpWindow;
  const api = factory(windows);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SalesArticleSearchWindow = api;
})(typeof window === 'object' ? window : this, function (windows) {
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
    const value = normalize(preferred), width = Math.min(value.minimized ? 260 : value.width, Math.max(1, bounds.width));
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
    const title=element.querySelector('[data-article-window-title]');
    const body=element.querySelector('[data-article-window-body]');
    const move=element.querySelector('[data-article-window-move]');
    const toggle=element.querySelector('[data-article-window-minimize]') || element.querySelector('[data-article-window-reset]');
    const closeButton=element.querySelector('[data-article-window-close]') || element.querySelector('[data-article-window-toggle]');
    const resize=element.querySelector('[data-article-window-resize]');
    const status=element.querySelector('[data-article-window-status]');
    let docked=false;
    const initialGeometry=()=>options.initialGeometry ? normalize(options.initialGeometry()) : defaultGeometry(options.bounds());
    const controller=windows.attach(element,{...options,title,body,move,toggle,closeButton,status,
      edgeHandles:resize ? {se:resize} : undefined,minWidth:280,minHeight:200,compactWidth:options.compactWidth || 260,
      initialGeometry,canUse:()=>!docked && options.canUse(),
      change:value=>options.change({...value,version:2}),
      onClose(){docked=true;options.onClose?.();}});
    return {refresh:()=>controller.refresh(),set(value){if(!value) docked=false;controller.set(value ? normalize(value) : initialGeometry());},
      restore:()=>controller.restore(),suspend:()=>controller.suspend(),destroy:()=>controller.destroy(),
      activate(){if(!docked) controller.activate();},close:()=>controller.close(),
      reopenFresh(){docked=false;options.onFreshSearch?.();controller.activate();controller.restore();},
      get docked(){return docked;},get preferred(){return {...controller.preferred,version:2};},get fitted(){return controller.fitted;}};
  }
  return Object.freeze({DEFAULTS, normalize, defaultGeometry, contentBounds, viewportBounds, migrateGeometry, fit, createPreferences, attach});
});
