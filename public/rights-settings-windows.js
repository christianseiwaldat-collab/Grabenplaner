(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RightsSettingsWindows = api;
})(typeof window === 'object' ? window : this, function() {
  'use strict';
  function mount(options) {
    const items = options.windows.filter(item => item.root && item.opener).map(item => ({...item, open:false, controller:null, activated:false, closing:false, restoreOnActivate:false, minimizeOnActivate:false}));
    const listeners = [];
    let actor = '', epoch = 0, destroyed = false;
    const on = (target,name,callback) => {target.addEventListener(name,callback);listeners.push(() => target.removeEventListener(name,callback));};
    const key = () => String(options.key() || '');
    const allowed = item => !destroyed && Boolean(actor) && actor === key() && item.canUse();
    const active = item => allowed(item) && options.active();
    function forget(item) {
      item.open = false;item.activated=false;item.closing=false;item.controller?.destroy();item.controller = null;item.root.hidden = true;
      item.opener.setAttribute('aria-expanded','false');
    }
    function synchronize() {
      const next = key();
      if(next !== actor) {epoch++;items.forEach(forget);actor=next;}
      for(const item of items) if(!allowed(item)) forget(item);
    }
    function defaults(item) {
      if (item.initialGeometry) return item.initialGeometry();
      const win = item.root.ownerDocument.defaultView;
      const bounds = options.bounds?.() || win.GpWindow.viewportBounds(win.visualViewport || {width:win.innerWidth,height:win.innerHeight},options.scale?.() || 1);
      const width = Math.min(item.width || 1080,bounds.width), height = Math.min(item.height || 650,bounds.height);
      return {x:Math.max(0,Math.round((bounds.width-width)/2)),y:Math.min(70,Math.max(0,bounds.height-height)),width,height,minimized:false};
    }
    function attach(item) {
      if(item.controller) return;
      const win = item.root.ownerDocument.defaultView;
      item.controller = win.GpWindow.attach(item.root,{
        title:item.root.querySelector('[data-rights-settings-window-title]'),body:item.root.querySelector('[data-rights-settings-window-body]'),
        toggle:item.root.querySelector('[data-rights-settings-window-toggle]'),
        bounds:options.bounds,scale:options.scale,minWidth:300,minHeight:200,compactWidth:300,
        geometry:options.windowPreferences.value.windows[item.id] || defaults(item),canUse:() => active(item),
        change:geometry=>options.windowPreferences.change(item.id,geometry),
        closeTarget:()=>options.closeTarget?.() || (item.opener.getClientRects().length ? item.opener : item.opener.closest('.settings-card')?.querySelector('.settings-field-disclosure-summary')),
        onClose(){item.open=false;item.activated=false;item.root.hidden=true;item.opener.setAttribute('aria-expanded','false');},
      });
    }
    async function show(id,intent={}) {
      synchronize();const item=items.find(value=>value.id===id);
      if(!item||!active(item))return false;
      item.open=true;item.minimizeOnActivate=intent.minimized===true;item.restoreOnActivate=!item.minimizeOnActivate&&intent.restore!==false;const generation=epoch;
      await options.windowPreferences.activate();
      if(!allowed(item)||epoch!==generation||!item.open)return false;
      attach(item);
      if(!active(item)){item.controller.suspend();item.activated=false;return false;}
      item.controller.activate();item.activated=true;if(item.minimizeOnActivate)item.controller.minimize(true);else if(item.restoreOnActivate)item.controller.restore();item.restoreOnActivate=false;item.minimizeOnActivate=false;
      item.opener.setAttribute('aria-expanded','true');
      if(!item.controller.preferred.minimized)item.root.querySelector('input:not([disabled]),select:not([disabled]),summary')?.focus({preventScroll:true});
      return true;
    }
    async function requestClose(item) {
      if(!item.open||!active(item)||item.closing)return;
      item.open=false;item.closing=true;
      try{await item.controller?.close();}finally{item.closing=false;}
    }
    const unsubscribe=options.windowPreferences.subscribe(value=>{
      for(const item of items)if(allowed(item)&&value.windows[item.id])item.controller?.set(value.windows[item.id]);
    });
    for(const item of items){
      item.root.hidden=true;
      on(item.opener,'click',()=>void show(item.id));
      on(item.root.querySelector('[data-rights-settings-window-close]'),'click',()=>void requestClose(item));
      on(item.root,'keydown',event=>{
        if(event.key!=='Escape'||event.defaultPrevented||!active(item)||item.root.classList.contains('is-moving')||item.root.classList.contains('is-resizing'))return;
        event.preventDefault();event.stopPropagation();void requestClose(item);
      });
    }
    return {show,sync(){synchronize();for(const item of items){
      if(item.closing&&active(item))continue;
      if(item.open&&active(item)){
        if(item.controller&&!item.activated){item.controller.activate();item.activated=true;if(item.minimizeOnActivate)item.controller.minimize(true);else if(item.restoreOnActivate)item.controller.restore();item.restoreOnActivate=false;item.minimizeOnActivate=false;item.opener.setAttribute('aria-expanded','true');}
        if(item.activated&&!item.root.matches('.is-moving,.is-resizing'))item.controller?.refresh();
      }else{item.controller?.suspend();item.activated=false;item.root.hidden=true;}
    }},
      destroy(){destroyed=true;epoch++;unsubscribe();listeners.forEach(remove=>remove());items.forEach(forget);}};
  }
  return Object.freeze({mount});
});
