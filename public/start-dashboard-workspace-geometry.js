(function(root, factory) {
  'use strict';
  const api = factory(typeof module === 'object' && module.exports ? require('./gp-window') : root.GpWindow);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StartDashboardWorkspaceGeometry = api;
})(typeof window === 'object' ? window : this, function(windowApi) {
  'use strict';
  function bounded(value, min, max) { return Math.min(Math.max(min, max), Math.max(min, Math.round(value))); }
  // Render to the available canvas; a narrower viewport never rewrites saved coordinates.
  function project(value, width) {
    const result = {width: bounded(value.width, 200, Math.min(4096, width)), height: bounded(value.height, 80, 4096)};
    result.x = bounded(value.x, 0, Math.min(16384, width - result.width));
    result.y = bounded(value.y, 0, 16384);
    return result;
  }
  function adjust(value, action, dx, dy, width) {
    const edge=action==='resize'?'se':action;
    const result=windowApi.adjust(value,edge,dx,dy,{width,height:20480},{minWidth:200,minHeight:80});
    // The dashboard is a vertically scrolling canvas, with the same bounded
    // preferred geometry schema as before.
    if(edge!=='move'&&edge.includes('n')&&result.height>4096){result.height=4096;result.y=value.y+value.height-result.height;}
    if(edge!=='move'&&edge.includes('w')&&result.width>4096){result.width=4096;result.x=value.x+value.width-result.width;}
    if(edge!=='move'&&edge.includes('n')&&result.y>16384){result.y=16384;result.height=value.y+value.height-result.y;}
    if(edge!=='move'&&edge.includes('w')&&result.x>16384){result.x=16384;result.width=value.x+value.width-result.x;}
    return project(result,width);
  }
  function persistedGeometry(saved, start, current, action) {
    if (!saved) return {...current};
    return windowApi.persistedGeometry(saved,start,current,action==='resize'?'se':action);
  }
  function create(options) {
    const {root, fields} = options, doc = root.ownerDocument, win = doc.defaultView;
    const grid = root.querySelector('#startDashboardGrid'),controls=['control:center','control:vps'].map(id=>fields.get(id)?.element).filter(Boolean);
    const canvas = doc.createElement('div'); canvas.className = 'start-dashboard-workspace-canvas';
    canvas.dataset.dashboardCanvas = '';
    const gridAnchor = doc.createComment('dashboard-grid-original'); grid.before(gridAnchor, canvas);
    const controlAnchors=new Map();for(const control of controls){const anchor=doc.createComment('dashboard-control-canvas-original');control.before(anchor);controlAnchors.set(control,anchor);canvas.append(control);}
    canvas.append(grid);
    const live = doc.createElement('span'); live.className = 'visually-hidden'; live.setAttribute('aria-live', 'polite'); canvas.append(live);
    const records = new Map(), removers = [];
    let gesture = null, pendingPointer = null, destroyed = false, frameRequest = null;
    const on = (node, name, handler, settings) => {node.addEventListener(name, handler, settings); removers.push(() => node.removeEventListener(name, handler, settings));};
    const visible = () => !destroyed && root.getClientRects().length > 0 && canvas.offsetWidth > 0;
    const compact = () => canvas.offsetWidth < 640 || win.innerWidth < 700;
    const canEdit = field => visible() && !compact() && options.ready() && options.allowed(field);
    function metrics() {
      const rect = canvas.getBoundingClientRect();
      return {rect, scaleX: rect.width / canvas.offsetWidth || 1, scaleY: rect.height / canvas.offsetHeight || rect.width / canvas.offsetWidth || 1, width: canvas.clientWidth};
    }
    function restore(record) {
      if (!record.frame) return;
      record.anchor.after(record.field.element);
      record.field.element.append(record.field.menu, ...record.resizes);
      record.frame.remove(); record.frame = null;
    }
    function promote(record) {
      if (record.frame) return;
      record.frame = doc.createElement('div'); record.frame.className = 'start-dashboard-workspace-floating';
      record.frame.dataset.dashboardFloating = record.field.id;
      canvas.append(record.frame);
      record.frame.append(record.field.element, record.field.menu, ...record.resizes);
    }
    function paint(record, value) {
      promote(record);
      const style = record.frame.style;
      style.left = value.x + 'px'; style.top = value.y + 'px'; style.width = value.width + 'px'; style.height = value.height + 'px';
      record.rendered = value;
    }
    function extent() {
      let bottom = 0;
      for (const record of records.values()) if (record.frame) bottom = Math.max(bottom, record.rendered.y + record.rendered.height);
      canvas.style.minHeight = bottom ? bottom + 'px' : '';
    }
    function measure(record) {
      const {rect, scaleX, scaleY, width} = metrics(), box = (record.frame || record.field.element).getBoundingClientRect();
      return project({x: (box.left - rect.left) / scaleX, y: (box.top - rect.top) / scaleY,
        width: box.width / scaleX, height: box.height / scaleY}, width);
    }
    function sync() {
      if (destroyed) return;
      if (pendingPointer && (pendingPointer.key !== options.key() || !canEdit(pendingPointer.record.field))) pendingPointer = null;
      if (gesture && (gesture.key !== options.key() || !canEdit(gesture.record.field))) cancel();
      const preferences = options.value(), editable = visible() && !compact() && options.usable();
      for (const record of records.values()) {
        const allowed = (!options.usable() || options.allowed(record.field)) && preferences.fields[record.field.id]?.hidden!==true, value = preferences.fields[record.field.id]?.geometry;
        for(const handle of record.resizes){handle.hidden=!editable||!allowed;handle.disabled=!options.ready();}
        // The title remains a normal navigation button when editing is unavailable.
        // Noninteractive title bars gain a keyboard focus stop only while movable.
        const movable = editable && allowed && options.ready();
        record.move.dataset.dashboardDragEnabled = String(movable);
        if (!record.nativeFocus) {
          if (movable) record.move.tabIndex = 0;
          else restoreAttribute(record.move, 'tabindex', record.originalTabIndex);
        }
        if (movable) record.move.setAttribute('aria-description', 'Feld verschieben: ziehen oder Pfeiltasten; Umschalt für Feinschritte, Escape zum Abbrechen.');
        else restoreAttribute(record.move, 'aria-description', record.originalDescription);
        // Detached children must still obey their original parent card's rights and V3 visibility.
        record.field.element.classList.toggle('start-dashboard-workspace-denied', !allowed);
        if (gesture?.record === record) continue;
        if (editable && allowed && value) paint(record, project(value, canvas.clientWidth));
        else restore(record);
      }
      extent();
    }
    function cancel() {
      pendingPointer = null;
      if (!gesture) return;
      const prior = gesture; gesture = null;
      prior.record.frame?.classList.remove('is-manipulating');
      try {prior.handle.releasePointerCapture(prior.pointerId);} catch {}
      sync();
    }
    function finish() {
      if (!gesture) return;
      const current = gesture;
      if (current.key !== options.key() || !canEdit(current.record.field)) {cancel(); return;}
      gesture = null; current.record.frame?.classList.remove('is-manipulating');
      try {current.handle.releasePointerCapture(current.pointerId);} catch {}
      if (!current.changed) {sync(); return;}
      const preferences = options.value(), id = current.record.field.id;
      const geometry = persistedGeometry(current.saved, current.displayOrigin, current.value, current.action);
      preferences.fields[id] = {...preferences.fields[id], geometry};
      void options.change(preferences);
      live.textContent = `${current.record.field.title.textContent}: Position ${current.value.x}, ${current.value.y}; Größe ${current.value.width} × ${current.value.height}.`;
    }
    function begin(record, action, handle, pointerId = null) {
      if (!canEdit(record.field)) return false;
      cancel();
      const value = measure(record);
      gesture = {record, action, handle, pointerId, key: options.key(), origin: value, displayOrigin: value,
        saved: options.value().fields[record.field.id]?.geometry, value, changed: false, initializing: true};
      const current = gesture;
      // Reparenting a keyboard-focused handle synchronously emits blur. It must
      // not finish/restore the field while promote() is still constructing it.
      try {
        paint(record, value); record.frame.classList.add('is-manipulating'); extent();
        handle.focus({preventScroll: true});
      } finally {current.initializing = false;}
      return true;
    }
    function update(dx, dy) {
      if (!gesture) return;
      if (gesture.key !== options.key() || !canEdit(gesture.record.field)) {cancel(); return;}
      const value = adjust(gesture.origin, gesture.action, dx, dy, canvas.clientWidth);
      gesture.changed ||= Object.keys(value).some(key => value[key] !== gesture.origin[key]);
      gesture.value = value; paint(gesture.record, value); extent();
    }
    function restoreAttribute(node, name, value) {
      if (value === null) node.removeAttribute(name);
      else node.setAttribute(name, value);
    }
    function titleBar(field) {
      return field.element.querySelector(':scope > .start-dashboard-group-link, :scope > .start-dashboard-card-link, :scope > .start-dashboard-control-center, :scope > header') || field.title;
    }
    for (const field of fields.values()) {
      const anchor = doc.createComment('dashboard-field-original:' + field.id); field.element.before(anchor);
      const move = titleBar(field), originalTabIndex = move.getAttribute('tabindex'), originalDescription = move.getAttribute('aria-description');
      move.classList.add('start-dashboard-field-titlebar');move.dataset.dashboardFieldMove=field.id;
      const resizes=windowApi.EDGES.map(edge=>{const handle=doc.createElement('button');handle.type='button';handle.className='gp-window-edge start-dashboard-field-resize';handle.dataset.gpWindowEdge=edge;handle.dataset.dashboardFieldEdge=field.id;if(edge==='se')handle.dataset.dashboardFieldResize=field.id;handle.setAttribute('aria-label','Feldgröße '+({n:'oben',ne:'oben rechts',e:'rechts',se:'unten rechts',s:'unten',sw:'unten links',w:'links',nw:'oben links'}[edge])+': ziehen oder Pfeiltasten verwenden');handle.title='Größe ändern';return handle;});
      field.element.append(...resizes);
      const record={field,anchor,move,resizes,frame:null,originalTabIndex,originalDescription,nativeFocus:move.matches('button,a[href],input,select,textarea,[contenteditable="true"]'),blockPointerClick:false};records.set(field.id,record);
      for(const [action,handle] of [['move',move],...resizes.map(handle=>[handle.dataset.gpWindowEdge,handle])]) {
        on(handle, 'click', event => {
          if (action !== 'move') {event.stopPropagation(); return;}
          if (record.blockPointerClick && event.detail > 0) {record.blockPointerClick=false;event.preventDefault();event.stopImmediatePropagation();}
        }, true);
        on(handle, 'pointerdown', event => {
          if (event.button !== 0 || event.isPrimary === false || !canEdit(field)) return;
          record.blockPointerClick=false;
          if (action === 'move') {
            // Keep clicks, focus and navigation native until the user actually drags.
            const interactive=event.target.closest('button,a[href],input,select,textarea,[contenteditable="true"]');
            if (interactive && interactive !== handle) return;
            cancel(); const m=metrics();
            pendingPointer={record,handle,key:options.key(),pointerId:event.pointerId,x:event.clientX,y:event.clientY,scaleX:m.scaleX,scaleY:m.scaleY};
            event.stopPropagation(); return;
          }
          if (!begin(record, action, handle, event.pointerId)) return;
          event.preventDefault(); event.stopPropagation();
          const m = metrics(); gesture.pointer = {x: event.clientX, y: event.clientY, scaleX: m.scaleX, scaleY: m.scaleY};
          try {handle.setPointerCapture(event.pointerId);} catch {}
        });
        on(handle, 'keydown', event => {
          if (event.key === 'Escape' && gesture?.record === record) {event.preventDefault(); cancel(); return;}
          const direction = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[event.key];
          if (!direction || !canEdit(field)) return;
          event.preventDefault(); event.stopPropagation();
          if (!gesture && !begin(record, action, handle)) return;
          if (gesture.record !== record || gesture.action !== action || gesture.pointerId !== null) return;
          const step = event.shiftKey ? 1 : 10;
          gesture.origin = gesture.value; update(direction[0] * step, direction[1] * step);
        });
        on(handle, 'keyup', event => {if (event.key.startsWith('Arrow') && gesture?.handle === handle && gesture.pointerId === null) finish();});
        on(handle, 'blur', () => {if (gesture?.handle === handle && gesture.pointerId === null && !gesture.initializing) finish();});
      }
    }
    on(win, 'pointermove', event => {
      if (pendingPointer?.pointerId === event.pointerId) {
        const pending=pendingPointer;
        if (pending.key !== options.key() || !canEdit(pending.record.field)) {cancel();return;}
        if (Math.hypot(event.clientX-pending.x,event.clientY-pending.y) < 5) return;
        if (!begin(pending.record,'move',pending.handle,pending.pointerId)) return;
        pending.record.blockPointerClick=true;
        gesture.pointer={x:pending.x,y:pending.y,scaleX:pending.scaleX,scaleY:pending.scaleY};
        try {pending.handle.setPointerCapture(pending.pointerId);} catch {}
      }
      if (!gesture?.pointer || event.pointerId !== gesture.pointerId) return;
      const p = gesture.pointer; event.preventDefault(); update((event.clientX - p.x) / p.scaleX, (event.clientY - p.y) / p.scaleY);
    });
    on(win, 'pointerup', event => {if (event.pointerId === pendingPointer?.pointerId) pendingPointer=null;if (event.pointerId === gesture?.pointerId) finish();});
    on(win, 'pointercancel', event => {if (event.pointerId === gesture?.pointerId || event.pointerId === pendingPointer?.pointerId) cancel();});
    on(win, 'keydown', event => {if (event.key === 'Escape' && (gesture || pendingPointer)) {event.preventDefault(); cancel();}});
    on(win, 'blur', cancel);
    on(win, 'resize', () => {cancel(); sync();});
    const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(() => {
      if (frameRequest !== null || destroyed) return;
      frameRequest = win.requestAnimationFrame(() => {frameRequest = null; sync();});
    }) : null;
    observer?.observe(canvas);
    function reset(id) {
      const record = records.get(id); if (!record || !options.ready() || !options.allowed(record.field)) return;
      cancel(); const preferences = options.value(), field = preferences.fields[id];
      if (field) {delete field.geometry; if (!Object.keys(field).length) delete preferences.fields[id];}
      void options.change(preferences);
    }
    sync();
    return {canvas, sync, cancel, reset, destroy() {
      cancel(); destroyed = true; observer?.disconnect(); if (frameRequest !== null) win.cancelAnimationFrame(frameRequest);
      for (const remove of removers) remove();
      for (const record of records.values()) {
        restore(record); record.anchor.remove();record.move.classList.remove('start-dashboard-field-titlebar');delete record.move.dataset.dashboardFieldMove;delete record.move.dataset.dashboardDragEnabled;
        restoreAttribute(record.move,'tabindex',record.originalTabIndex);restoreAttribute(record.move,'aria-description',record.originalDescription);
        for(const handle of record.resizes)handle.remove();record.field.element.classList.remove('start-dashboard-workspace-denied');
      }
      for(const [control,anchor] of controlAnchors)if(anchor.parentNode)anchor.replaceWith(control);
      gridAnchor.replaceWith(grid); canvas.remove();
    }};
  }
  return {project, adjust, persistedGeometry, create};
});
