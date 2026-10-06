(function(root, factory) {
  'use strict';
  // GP-Fenster sind interne Arbeitsfenster, keine Browserfenster. Dieser gemeinsame
  // Controller erlaubt Verschieben über den gesamten Viewport (auch die Sidebar)
  // und Größenänderung an allen Rändern/Ecken. Fachliche Karten außerhalb des
  // Startdashboards werden dadurch nicht zu frei veränderbaren Fenstern.
  const model = typeof module === 'object' && module.exports ? require('./gp-window-preferences') : root.GpWindowPreferences;
  const api = factory(model);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GpWindow = api;
})(typeof window === 'object' ? window : this, function(model) {
  'use strict';
  const EDGES = Object.freeze(['n','ne','e','se','s','sw','w','nw']);
  const DEFAULTS = Object.freeze({x:0,y:0,width:560,height:420,minimized:false});
  const clamp = (value,min,max) => Math.min(Math.max(min,max),Math.max(min,Math.round(value)));
  function normalize(value = {}, options = {}) {
    const minWidth = options.minWidth || 200, minHeight = options.minHeight || 80;
    const number = (key,min,max) => clamp(Number.isFinite(value[key]) ? value[key] : DEFAULTS[key],min,max);
    return {x:number('x',0,16384),y:number('y',0,16384),width:number('width',minWidth,4096),
      height:number('height',minHeight,4096),minimized:value.minimized === true};
  }
  function viewportBounds(viewport, scale = 1) {
    const zoom = Number.isFinite(scale) && scale > 0 ? scale : 1;
    return {left:(viewport.left || viewport.offsetLeft || 0)/zoom,top:(viewport.top || viewport.offsetTop || 0)/zoom,
      width:Math.max(1,viewport.width/zoom),height:Math.max(1,viewport.height/zoom)};
  }
  function fit(value, bounds, options = {}) {
    const preferred = normalize(value,options), availableWidth = Math.max(1,bounds.width), availableHeight = Math.max(1,bounds.height);
    const width = Math.min(preferred.minimized ? (options.compactWidth || 260) : preferred.width,availableWidth);
    const height = Math.min(preferred.minimized ? (options.titleHeight || 44) : preferred.height,availableHeight);
    return {...preferred,width,height,x:clamp(preferred.x,0,availableWidth-width),y:clamp(preferred.y,0,availableHeight-height)};
  }
  // Resize the requested edges while the opposite edges stay anchored. Limits
  // apply to the rendered viewport; they never erase preferred desktop sizes.
  function adjust(value, action, dx, dy, bounds, options = {}) {
    const result = {...value}, maxWidth = Math.max(1,bounds.width), maxHeight = Math.max(1,bounds.height);
    dx = Number.isFinite(dx) ? dx : 0; dy = Number.isFinite(dy) ? dy : 0;
    if (action === 'move') {
      result.x = clamp(value.x+dx,0,maxWidth-value.width); result.y = clamp(value.y+dy,0,maxHeight-value.height);
    } else if (EDGES.includes(action)) {
      const minWidth = Math.min(options.minWidth || 200,maxWidth), minHeight = Math.min(options.minHeight || 80,maxHeight);
      const right = value.x+value.width, bottom = value.y+value.height;
      if (action.includes('w')) {result.x=clamp(value.x+dx,0,right-minWidth); result.width=right-result.x;}
      if (action.includes('e')) result.width=clamp(value.width+dx,minWidth,maxWidth-value.x);
      if (action.includes('n')) {result.y=clamp(value.y+dy,0,bottom-minHeight); result.height=bottom-result.y;}
      if (action.includes('s')) result.height=clamp(value.height+dy,minHeight,maxHeight-value.y);
    }
    return result;
  }
  function persistedGeometry(saved,start,current,action) {
    const result = {...saved};
    const changed = action === 'move' ? ['x','y'] : ['x','y','width','height'];
    for (const key of changed) if (current[key] !== start[key]) result[key] = current[key];
    return result;
  }
  function createPreferences(options) {
    let actor = '', epoch = 0, loaded = false, active = false, destroyed = false, value = model.empty();
    let read = null, write = null, queue = Promise.resolve(), dirty = new Map();
    const listeners=new Set();
    const key = () => String(options.actorKey?.() ?? options.key?.() ?? '');
    const allowed = () => !destroyed && (options.canUse?.() ?? true);
    const current = (a,e) => allowed() && actor === a && key() === a && epoch === e;
    const publish = () => {const currentValue=model.normalize(value);options.apply?.(currentValue);for(const listener of listeners) listener(model.normalize(currentValue));};
    function invalidate() {
      epoch++; actor=key(); loaded=false; value=model.empty(); dirty=new Map();
      read?.controller.abort(); write?.abort(); read=null; write=null; publish();
    }
    const synchronize = () => {if(actor !== key()) invalidate();};
    function activate() {
      active=true; synchronize();
      if (!allowed() || !actor || loaded || read) return read?.promise || Promise.resolve();
      const a=actor,e=epoch,controller=new AbortController(), request={controller}; read=request;
      request.promise=(async()=>{
        try {
          const response=options.read ? await options.read(controller.signal) : await options.api('/api/portal/v1/ui-preferences',{signal:controller.signal});
          if(controller.signal.aborted || !current(a,e)) return;
          value=model.normalize(response?.gpWindows || response);
          for(const [id,geometry] of dirty) value.windows[id]=geometry;
          loaded=true; if(active) publish();
        } catch(error) {if(!controller.signal.aborted && current(a,e)) options.error?.(error);}
        finally {if(read===request) read=null;}
      })();
      return request.promise;
    }
    function change(id,geometry) {
      synchronize(); if(!allowed() || !actor || !model.safeId(id)) return Promise.resolve(false);
      const item=model.geometry(normalize(geometry)); dirty.set(id,item); value.windows[id]=item; publish();
      const a=actor,e=epoch;
      queue=queue.catch(()=>{}).then(async()=>{
        if(!current(a,e)) return false;
        await activate(); if(!current(a,e) || !loaded) return false;
        const snapshot=model.validate(value), controller=new AbortController(); write=controller;
        try {
          if(options.write) await options.write(snapshot,controller.signal);
          else await options.api('/api/portal/v1/ui-preferences',{method:'PUT',body:JSON.stringify({gpWindows:snapshot}),signal:controller.signal});
          if(!current(a,e)) return false;
          for(const [name,item] of dirty) if(JSON.stringify(item) === JSON.stringify(snapshot.windows[name])) dirty.delete(name);
          return true;
        } catch(error) {if(!controller.signal.aborted && current(a,e)) options.error?.(error);return false;}
        finally {if(write===controller) write=null;}
      });
      return queue;
    }
    return {activate,change,invalidate,get value(){return model.normalize(value);},get ready(){return loaded && allowed() && actor===key();},
      subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
      suspend({abortWrites=false}={}) {active=false;if(abortWrites) invalidate();},
      destroy(){destroyed=true;epoch++;read?.controller.abort();write?.abort();dirty.clear();listeners.clear();}};
  }
  function attach(element, options = {}) {
    const doc=element.ownerDocument, win=options.window || doc.defaultView;
    const resolve=(value,selector)=>typeof value==='string' ? element.querySelector(value) : value || element.querySelector(selector);
    const title=resolve(options.title,'[data-gp-window-title]'), body=resolve(options.body,'[data-gp-window-body]');
    const toggle=resolve(options.toggle,'[data-gp-window-toggle]'), closeButton=resolve(options.closeButton,'[data-gp-window-close]');
    const moveHandle=options.move || title;
    const removers=[],handles=[],ownedHandles=[];
    const on=(target,type,fn)=>{target?.addEventListener(type,fn);removers.push(()=>target?.removeEventListener(type,fn));};
    const dimensions={minWidth:options.minWidth || 200,minHeight:options.minHeight || 80,compactWidth:options.compactWidth || 260};
    const getBounds=()=>options.bounds ? options.bounds() : viewportBounds(win.visualViewport || {width:win.innerWidth,height:win.innerHeight},options.scale?.() || 1);
    let preferred=normalize(options.initialGeometry?.() || options.geometry || DEFAULTS,dimensions),fitted=null;
    let active=options.active===true, destroyed=false, gesture=null, closing=null, animation=null,last='', closeTicket=0;
    const usable=()=>!destroyed && active && (options.canUse?.() ?? true);
    const status=resolve(options.status,'[data-gp-window-status]');
    element.classList.add('gp-window'); title?.classList.add('gp-window-title');
    if(moveHandle && !moveHandle.hasAttribute('tabindex') && moveHandle.tagName !== 'BUTTON') moveHandle.setAttribute('tabindex','0');
    if(moveHandle && !moveHandle.hasAttribute('aria-label')) moveHandle.setAttribute('aria-label','Fenster verschieben: ziehen oder Pfeiltasten verwenden');
    function announce() {if(status && fitted) status.textContent=preferred.minimized ? 'Fenster minimiert.' : `Fenster: ${fitted.width} × ${fitted.height} Pixel, Position ${fitted.x}, ${fitted.y}.`;}
    function render() {
      if(!usable()) {if(!options.nativeDialog) element.hidden=true;return;}
      if(!options.nativeDialog) element.hidden=false;
      const bounds=getBounds();
      fitted=fit(preferred,bounds,{...dimensions,titleHeight:Math.max(32,title?.offsetHeight || 44)});
      element.style.left=`${bounds.left+fitted.x}px`;element.style.top=`${bounds.top+fitted.y}px`;
      element.style.width=`${fitted.width}px`;element.style.height=`${fitted.height}px`;
      element.classList.toggle('is-minimized',preferred.minimized);
      if(body) {if(preferred.minimized && body.contains(doc.activeElement)) toggle?.focus({preventScroll:true});body.hidden=preferred.minimized;}
      if(toggle) {toggle.setAttribute('aria-expanded',String(!preferred.minimized));toggle.setAttribute('aria-label',preferred.minimized?'Fenster wiederherstellen':'Fenster minimieren');toggle.textContent=preferred.minimized?'▢':'−';}
      for(const handle of handles) handle.hidden=preferred.minimized;
      const dimensionsKey=`${fitted.width}|${fitted.height}|${preferred.minimized}`;
      if(last!==dimensionsKey) {last=dimensionsKey;options.resize?.({...fitted});}
    }
    function commit() {render();announce();options.change?.({...preferred});}
    function finish(cancel=false) {
      if(!gesture) return;
      const previous=gesture;gesture=null;element.classList.remove('is-moving','is-resizing');
      if(cancel) {preferred=previous.preferred;render();}
      else {preferred=normalize(persistedGeometry(previous.preferred,previous.base,previous.current,previous.action),dimensions);commit();}
      try {if(previous.handle.hasPointerCapture?.(previous.id)) previous.handle.releasePointerCapture(previous.id);} catch {}
    }
    function begin(event,action,handle) {
      if(event.button!==0 || event.isPrimary===false || !usable() || gesture || closing || (preferred.minimized && action!=='move')) return;
      event.preventDefault();event.stopPropagation();handle.focus?.({preventScroll:true});render();
      gesture={id:event.pointerId,handle,action,x:event.clientX,y:event.clientY,scale:options.scale?.() || 1,
        preferred:{...preferred},base:{...fitted},current:{...fitted}};
      element.classList.add(action==='move'?'is-moving':'is-resizing');
      try {handle.setPointerCapture?.(event.pointerId);} catch {}
    }
    function pointerMove(event) {
      if(!gesture || event.pointerId!==gesture.id) return;
      if(!usable()) {finish(true);return;}
      const g=gesture,dx=(event.clientX-g.x)/g.scale,dy=(event.clientY-g.y)/g.scale;
      g.current=adjust(g.base,g.action,dx,dy,getBounds(),dimensions);
      preferred=normalize(persistedGeometry(g.preferred,g.base,g.current,g.action),dimensions);render();
      event.preventDefault?.();
    }
    function keydown(event,action) {
      if(event.key==='Escape' && gesture) {event.preventDefault();event.stopPropagation();finish(true);return;}
      const direction={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
      if((!direction && !['Home','End'].includes(event.key)) || !usable() || (preferred.minimized && action!=='move')) return;
      event.preventDefault();event.stopPropagation();finish(true);render();
      const step=event.shiftKey?1:10,start={...fitted};
      const bounds=getBounds();
      let dx=(direction?.[0] || 0)*step,dy=(direction?.[1] || 0)*step;
      if(event.key==='Home' || event.key==='End') {
        const end=event.key==='End';
        if(action==='move') {dx=end?bounds.width-start.width-start.x:-start.x;dy=end?bounds.height-start.height-start.y:-start.y;}
        else {
          if(action.includes('w')) dx=end?-start.x:start.width-dimensions.minWidth;
          if(action.includes('e')) dx=end?bounds.width-start.x-start.width:dimensions.minWidth-start.width;
          if(action.includes('n')) dy=end?-start.y:start.height-dimensions.minHeight;
          if(action.includes('s')) dy=end?bounds.height-start.y-start.height:dimensions.minHeight-start.height;
        }
      }
      const changed=adjust(start,action,dx,dy,bounds,dimensions);
      preferred=normalize(persistedGeometry(preferred,start,changed,action),dimensions);commit();
    }
    const labels={n:'oben',ne:'oben rechts',e:'rechts',se:'unten rechts',s:'unten',sw:'unten links',w:'links',nw:'oben links'};
    for(const edge of EDGES) {
      const handle=options.edgeHandles?.[edge] || doc.createElement('button');
      if(!options.edgeHandles?.[edge]) ownedHandles.push(handle);
      handle.type='button';handle.className='gp-window-edge';handle.dataset.gpWindowEdge=edge;
      handle.setAttribute('aria-label',`Fenstergröße ${labels[edge]} ändern: ziehen oder Pfeiltasten verwenden`);
      handle.title='Größe ändern';if(!element.contains(handle)) element.append(handle);handles.push(handle);
      on(handle,'pointerdown',event=>begin(event,edge,handle));on(handle,'keydown',event=>keydown(event,edge));
      on(handle,'click',event=>event.stopPropagation());
    }
    on(moveHandle,'pointerdown',event=>{
      const control=event.target.closest?.('button,input,select,textarea,a,[contenteditable="true"]');
      if(control && control!==moveHandle && !control.hasAttribute('data-gp-window-move') && !control.hasAttribute('data-article-window-move')) return;
      begin(event,'move',moveHandle);
    });
    on(moveHandle,'keydown',event=>{if(event.target===moveHandle) keydown(event,'move');});
    // Element listeners cover captured pointers; window listeners cover browsers
    // that refuse capture after reparenting an internal window.
    on(element,'pointermove',pointerMove);on(win,'pointermove',pointerMove);
    for(const target of [element,win]) {
      on(target,'pointerup',event=>{if(gesture?.id===event.pointerId) finish();});
      on(target,'pointercancel',event=>{if(gesture?.id===event.pointerId) finish(true);});
    }
    on(element,'lostpointercapture',event=>{if(gesture?.id===event.pointerId) finish(true);});
    on(doc,'keydown',event=>{if(event.key==='Escape' && gesture) keydown(event,'move');});
    function minimize(value,persist=true) {
      if(!usable()) return;finish(true);if(preferred.minimized === (value===true)) return;
      preferred={...preferred,minimized:value===true};render();announce();
      if(persist) options.change?.({...preferred});
    }
    function refresh() {if(gesture) finish(true);render();}
    on(toggle,'click',()=>minimize(!preferred.minimized));
    async function close() {
      if(!usable() || closing) return closing;
      finish(true);const ticket=++closeTicket,target=typeof options.closeTarget==='function'?options.closeTarget():options.closeTarget || options.opener;
      const rect=element.getBoundingClientRect?.(), destination=target?.getBoundingClientRect?.(),zoom=options.scale?.() || 1;
      const reduced=win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      closing=(async()=>{
        if(!reduced && rect?.width && rect?.height && destination?.width && destination?.height && typeof element.animate==='function') {
          const currentAnimation=element.animate([{transform:'translate(0,0) scale(1)',transformOrigin:'top left',opacity:1},{transform:`translate(${(destination.left-rect.left)/zoom}px,${(destination.top-rect.top)/zoom}px) scale(${Math.max(.02,destination.width/rect.width)},${Math.max(.02,destination.height/rect.height)})`,transformOrigin:'top left',opacity:0}],{duration:160,easing:'ease-in'});
          animation=currentAnimation;try {await currentAnimation.finished;} catch {}finally{if(animation===currentAnimation)animation=null;}
        }
        if(ticket!==closeTicket || destroyed) return;
        active=false;if(!options.nativeDialog) element.hidden=true;
        options.onClose?.();target?.focus?.({preventScroll:true});
      })();
      try {await closing;} finally {if(ticket===closeTicket) closing=null;}
    }
    on(closeButton,'click',()=>void close());
    on(win,'resize',refresh);on(win,'blur',()=>finish(true));
    on(win.visualViewport,'resize',refresh);on(win.visualViewport,'scroll',refresh);
    const observer=typeof win.ResizeObserver==='function'?new win.ResizeObserver(refresh):null;
    for(const target of options.observe || []) if(target)observer?.observe(target);
    render();
    return {refresh,minimize,restore(){minimize(false);},close,
      get preferred(){return {...preferred};},get fitted(){return fitted && {...fitted};},
      set(value){finish(true);preferred=normalize(value || options.initialGeometry?.() || DEFAULTS,dimensions);render();},
      activate(){closeTicket++;animation?.cancel();animation=null;closing=null;active=true;render();},
      suspend(){closeTicket++;animation?.cancel();animation=null;closing=null;finish(true);active=false;if(!options.nativeDialog) element.hidden=true;},
      destroy(){closeTicket++;animation?.cancel();animation=null;closing=null;finish(true);destroyed=true;observer?.disconnect();for(const remove of removers) remove();for(const handle of ownedHandles) handle.remove();element.classList.remove('gp-window');if(!options.nativeDialog) element.hidden=true;}
    };
  }
  function installDocument(doc,options={}) {
    const win=doc.defaultView,records=new Map();let destroyed=false,anonymous=0,lastOpener=doc.activeElement;
    const trackOpener=event=>{if(!event.target.closest?.('dialog')) lastOpener=event.target.closest?.('button,a') || event.target;};
    doc.addEventListener('pointerdown',trackOpener,true);doc.addEventListener('focusin',trackOpener,true);
    const key=()=>String(options.actorKey?.() || '');
    const preferences=createPreferences({actorKey:key,canUse:options.canUse,api:options.api,read:options.readPreferences,write:options.writePreferences,error:options.error,
      apply(value){for(const record of records.values()) record.controller?.set(value.windows[record.id] || record.initialGeometry);}});
    function install(dialog) {
      if(records.has(dialog) || dialog.hasAttribute('data-gp-window-manual') || dialog.classList.contains('gp-window')) return;
      const scope=dialog.parentElement?.closest?.('[id]')?.id;
      const name=dialog.getAttribute('data-po-decision')!==null?'privacy-decision':dialog.getAttribute('data-po-editor')!==null?'privacy-editor':dialog.getAttribute('data-knowledge-reader')!==null?'knowledge-reader':dialog.getAttribute('data-knowledge-editor')!==null?'knowledge-editor':dialog.getAttribute('data-r') || dialog.getAttribute('data-h') || dialog.getAttribute('aria-labelledby') || dialog.getAttribute('aria-label') || `${dialog.className || 'window'}-${++anonymous}`;
      const id=dialog.id || dialog.dataset.gpWindowId || `dialog:${scope ? scope+':' : ''}${name}`.replace(/[^a-zA-Z0-9:._-]/g,'-').slice(0,120);
      const record={id,controller:null,opener:null,header:null,ownedHeader:false};records.set(dialog,record);
      function open() {
        if(!dialog.open || destroyed || !(options.canUse?.() ?? true)) {record.controller?.suspend();return;}
        record.opener=doc.activeElement?.closest?.('dialog') ? lastOpener : doc.activeElement || lastOpener;
        if(!record.controller) {
          const rect=dialog.getBoundingClientRect(),zoom=options.scale?.() || parseFloat(win.getComputedStyle?.(doc.body)?.zoom) || 1;
          let header=dialog.querySelector('.modal-header,header,.branch-search-dialog-heading');
          if(!header) {
            header=doc.createElement('header');header.className='gp-dialog-window-title';
            const text=doc.createElement('strong');text.textContent=dialog.getAttribute('aria-label') || dialog.querySelector('h2,h3')?.textContent || 'Fenster';
            const closeButton=doc.createElement('button');closeButton.type='button';closeButton.className='gp-window-control';closeButton.textContent='×';closeButton.setAttribute('aria-label','Fenster schließen');
            closeButton.addEventListener('click',()=>void record.controller.close());header.append(text,closeButton);dialog.prepend(header);record.ownedHeader=true;
          }
          record.header=header;
          const headerAddition=record.ownedHeader ? header.getBoundingClientRect().height/zoom : 0;
          dialog.classList.add('gp-dialog');
          const bounds=()=>viewportBounds(win.visualViewport || {width:win.innerWidth,height:win.innerHeight},options.scale?.() || parseFloat(win.getComputedStyle?.(doc.body)?.zoom) || 1);
          const b=bounds(),initialGeometry={x:Math.max(0,rect.left/zoom-b.left),y:Math.max(0,rect.top/zoom-b.top),width:Math.max(200,rect.width/zoom),height:Math.max(80,rect.height/zoom+headerAddition),minimized:false};
          record.initialGeometry=initialGeometry;const geometry=preferences.value.windows[id] || initialGeometry;
          record.controller=attach(dialog,{title:header,nativeDialog:true,active:true,bounds,scale:()=>options.scale?.() || parseFloat(win.getComputedStyle?.(doc.body)?.zoom) || 1,geometry,
            canUse:()=>dialog.open && (options.canUse?.() ?? true),change:value=>preferences.change(id,{...value,minimized:false}),closeTarget:()=>record.opener,onClose:()=>dialog.close()});
        } else record.controller.activate();
        void preferences.activate();
      }
      record.closed=()=>record.controller?.suspend();dialog.addEventListener('close',record.closed);record.open=open;
      if(dialog.open) open();
    }
    function scan(node=doc) {if(node.nodeType===1 && node.tagName==='DIALOG') install(node);for(const dialog of node.querySelectorAll?.('dialog') || []) install(dialog);}
    scan();
    const observer=typeof win.MutationObserver==='function'?new win.MutationObserver(changes=>{
      for(const change of changes) {
        if(change.type==='attributes' && change.target.tagName==='DIALOG') {install(change.target);records.get(change.target)?.open();}
        for(const node of change.addedNodes || []) scan(node);
      }
      for(const [dialog,record] of records) if(dialog.isConnected===false) {
        record.controller?.destroy();dialog.removeEventListener('close',record.closed);records.delete(dialog);
      }
    }):null;
    observer?.observe(doc.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['open']});
    return {preferences,scan,synchronize(){preferences.invalidate();for(const [dialog,record] of records) {record.controller?.suspend();if(dialog.open)dialog.close();}},
      destroy(){destroyed=true;observer?.disconnect();preferences.destroy();doc.removeEventListener('pointerdown',trackOpener,true);doc.removeEventListener('focusin',trackOpener,true);for(const [dialog,record] of records) {record.controller?.destroy();dialog.removeEventListener('close',record.closed);dialog.classList.remove('gp-dialog');if(record.ownedHeader) record.header?.remove();}records.clear();}};
  }
  return Object.freeze({EDGES,DEFAULTS,normalize,viewportBounds,fit,adjust,persistedGeometry,createPreferences,attach,installDocument});
});
