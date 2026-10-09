(function(root,factory) {
  'use strict';
  const common=typeof module==='object' && module.exports;
  const api=factory(common ? require('./start-dashboard-workspace-preferences') : root.StartDashboardWorkspacePreferences,
    common ? require('./start-dashboard-workspace-geometry') : root.StartDashboardWorkspaceGeometry);
  if(typeof module==='object' && module.exports) module.exports=api;
  else root.StartDashboardWorkspace=api;
})(typeof window==='object' ? window : this,function(model,geometryApi) {
  'use strict';
  let instanceCount=0;
  function createStore(options) {
    let actor='',epoch=0,revision=0,value=model.empty(),loaded=false,failed=false,read=null,write=null,queue=Promise.resolve();
    const listeners=new Set();
    const notify=()=>listeners.forEach(fn=>fn(value));
    const current=(key,ticket)=>options.canUse() && key===String(options.key() || '') && actor===key && ticket===epoch;
    function invalidate() {
      epoch++;revision++;read?.abort();write?.abort();read=null;write=null;loaded=false;failed=false;
      actor=String(options.key() || '');value=model.empty();notify();
    }
    function synchronize() {if(actor!==String(options.key() || '')) invalidate();}
    function localKey() {return 'gp.dashboard.workspace.v1.'+actor;}
    async function activate({retry=false}={}) {
      synchronize();if(!options.canUse() || loaded || read || (failed && !retry)) return;
      failed=false;
      const key=actor,ticket=epoch,version=revision,controller=new AbortController();read=controller;
      notify();
      try {
        let source;
        if(options.localOnly?.()) {
          try {source=JSON.parse(options.storage?.getItem(localKey()) || 'null');}
          catch {source=null; /* A damaged local-only cache falls back once to defaults. */}
        } else source=(await options.api('/api/portal/v1/ui-preferences',{signal:controller.signal})).startDashboardWorkspace;
        if(controller.signal.aborted || !current(key,ticket) || version!==revision) return;
        value=model.normalize(source);loaded=true;notify();
      } catch(error) {if(!controller.signal.aborted && current(key,ticket) && version===revision) {failed=true;notify();options.error(error);}}
      finally {if(read===controller) read=null;}
    }
    function change(next) {
      synchronize();if(!options.canUse() || !loaded) return Promise.resolve(false);
      value=model.validate(next);loaded=true;revision++;read?.abort();read=null;notify();
      const key=actor,ticket=epoch,body=JSON.stringify({startDashboardWorkspace:value});
      queue=queue.catch(()=>{}).then(async()=>{
        if(!current(key,ticket)) return;
        const controller=new AbortController();write=controller;
        try {
          if(options.localOnly?.()) options.storage?.setItem(localKey(),JSON.stringify(JSON.parse(body).startDashboardWorkspace));
          else await options.api('/api/portal/v1/ui-preferences',{method:'PUT',body,signal:controller.signal});
        } catch(error) {if(!controller.signal.aborted && current(key,ticket)) options.error(error);}
        finally {if(write===controller) write=null;}
      });return queue;
    }
    return {activate,change,invalidate,get ready(){return loaded && options.canUse() && actor===String(options.key() || '');},
      get failed(){return failed && actor===String(options.key() || '');},
      get value(){return model.validate(value);},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
  }
  function create(options) {
    const root=options.root,doc=root.ownerDocument,win=doc.defaultView;
    const fields=new Map(),removers=[],on=(node,name,fn,options)=>{node.addEventListener(name,fn,options);removers.push(()=>node.removeEventListener(name,fn,options));};
    let identity='',selected=null,destroyed=false,controlAnchor=null,controlButton=null,controlWrapper=null,geometry=null,opener=null,menuInTopLayer=false;
    const usable=()=>!destroyed && options.canUse();
    const store=createStore({...options,error:error=>options.error(error)});
    const instance=++instanceCount,menu=doc.createElement('div');
    menu.className='start-dashboard-field-context-menu';menu.id='startDashboardFieldMenu'+instance;
    menu.dataset.fieldMenu='';menu.hidden=true;menu.setAttribute('popover','manual');menu.setAttribute('role','menu');
    menu.setAttribute('aria-labelledby',menu.id+'Title');
    const icons={edit:'<path d="m4 12 1-4 7-7 3 3-7 7-4 1Z"/><path d="m10 3 3 3M3 15h12"/>',
      label:'<path d="M3 3h10M8 3v11M5 14h6"/>',geometry:'<path d="M5 2H2v3M11 2h3v3M2 11v3h3M14 11v3h-3M5 5h6v6H5z"/>',
      hide:'<path d="m2 2 12 12M6 4a8 8 0 0 1 8 4 11 11 0 0 1-3 3M8 12a8 8 0 0 1-6-4 11 11 0 0 1 2-3"/>',
      retry:'<path d="M13 6a5 5 0 1 0 .1 4M13 2v4H9"/>',close:'<path d="m4 4 8 8M12 4l-8 8"/>'};
    const action=(name,label,icon,hidden=false)=>'<button type="button" class="start-dashboard-field-context-action" role="menuitem" tabindex="-1" data-field-'+name+(hidden?' hidden':'')+'><span class="start-dashboard-field-context-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">'+icons[icon]+'</svg></span><span data-field-action-label>'+label+'</span></button>';
    const colorNames={sage:'Salbei',blue:'Hellblau',sand:'Sand',rose:'Rosé',lavender:'Lavendel',peach:'Apricot'};
    const colorChoice=color=>'<button type="button" class="start-dashboard-field-color-choice" role="menuitemradio" tabindex="-1" aria-checked="false" aria-label="Feldfarbe: '+(colorNames[color] || 'Standard')+'" title="'+(colorNames[color] || 'Standard')+'" data-field-color="'+color+'"><span aria-hidden="true">✓</span></button>';
    menu.innerHTML='<p class="start-dashboard-field-context-title" id="'+menu.id+'Title" data-menu-title>Feld anpassen</p>'
      +action('edit','Beschriftung ändern','edit')
      +'<div class="start-dashboard-field-context-separator" role="separator"></div><p class="start-dashboard-field-color-label">Feldfarbe</p><div class="start-dashboard-field-color-choices" role="group" aria-label="Feldfarbe">'+['',...model.COLORS].map(colorChoice).join('')+'</div><div class="start-dashboard-field-context-separator" role="separator"></div>'
      +action('default','Standardbeschriftung','label')
      +action('geometry-default','Standardposition und -größe','geometry')+action('hide','Kachel ausblenden','hide',true)
      +'<div class="start-dashboard-field-context-separator" role="separator"></div>'+action('retry','Erneut speichern','retry')+action('close','Schließen','close');
    const dialog=doc.createElement('dialog');dialog.className='start-dashboard-field-dialog';dialog.dataset.gpWindowManual='';
    dialog.setAttribute('aria-labelledby','startDashboardFieldEditorTitle'+instance);
    dialog.innerHTML='<header class="start-dashboard-field-editor-heading"><h3 id="startDashboardFieldEditorTitle'+instance+'">Beschriftung ändern</h3><button type="button" data-field-editor-close aria-label="Beschriftungseditor schließen">×</button></header>'
      +'<form data-field-editor><label>Feldtitel<input name="title" maxlength="120" required></label><label>Beschreibung<textarea name="description" maxlength="400" rows="3"></textarea></label><p data-field-error role="alert"></p><div class="start-dashboard-field-editor-actions"><button type="button" data-field-back>Abbrechen</button><button type="submit" class="primary-button">Übernehmen</button></div></form>';
    doc.body.append(menu,dialog);
    const editor=dialog.querySelector('[data-field-editor]');
    const allowed=field=>usable() && options.allowed(field.id);
    const menuItems=()=>[...menu.querySelectorAll('[role="menuitem"],[role="menuitemradio"]')].filter(button=>!button.hidden && !button.disabled);
    function syncColors() {
      const color=selected ? store.value.fields[selected.id]?.color || '' : '';
      for(const button of menu.querySelectorAll('[data-field-color]')) button.setAttribute('aria-checked',String(button.dataset.fieldColor===color));
    }
    function restoreFocus() {if(opener?.isConnected && !opener.hidden && !opener.disabled && opener.getClientRects().length)opener.focus({preventScroll:true});}
    function closeMenu({focus=false,keepSelection=false}={}) {
      if(!menu.hidden) {if(menuInTopLayer)menu.hidePopover();menuInTopLayer=false;menu.hidden=true;}
      opener?.setAttribute('aria-expanded','false');
      if(focus)restoreFocus();if(!keepSelection && !dialog.open)selected=null;
    }
    function closeEditor({focus=true}={}) {
      if(dialog.open)dialog.close();
      if(focus)restoreFocus();if(menu.hidden)selected=null;
    }
    function closeControls({focus=false}={}) {closeMenu({keepSelection:true});closeEditor({focus});selected=null;}
    function positionMenu() {
      if(menu.hidden || !opener?.isConnected)return;
      const anchor=opener.getBoundingClientRect(),viewport=win.visualViewport;
      const left=viewport?.offsetLeft || 0,top=viewport?.offsetTop || 0,width=viewport?.width || win.innerWidth,height=viewport?.height || win.innerHeight;
      if(anchor.bottom<top || anchor.top>top+height || anchor.right<left || anchor.left>left+width) {closeMenu();return;}
      const measured=menu.getBoundingClientRect(),scale=measured.width/menu.offsetWidth || 1;
      menu.style.maxWidth=Math.max(0,width-16)/scale+'px';menu.style.maxHeight=Math.max(0,height-16)/scale+'px';
      const rect=menu.getBoundingClientRect();
      const x=Math.max(left+8,Math.min(anchor.right-rect.width,left+width-rect.width-8));
      const below=anchor.bottom+6,y=below+rect.height<=top+height-8 ? below : Math.max(top+8,anchor.top-rect.height-6);
      menu.style.left=x/scale+'px';menu.style.top=Math.max(top+8,Math.min(y,top+height-rect.height-8))/scale+'px';
    }
    function positionEditor() {
      if(!dialog.open)return;
      const rect=dialog.getBoundingClientRect(),scale=rect.width/dialog.offsetWidth || 1,viewport=win.visualViewport;
      const left=viewport?.offsetLeft || 0,top=viewport?.offsetTop || 0,width=viewport?.width || win.innerWidth,height=viewport?.height || win.innerHeight;
      dialog.style.maxWidth=Math.max(0,width-24)/scale+'px';dialog.style.maxHeight=Math.max(0,height-24)/scale+'px';
      dialog.style.left=(left+width/2)/scale+'px';dialog.style.top=(top+height/2)/scale+'px';
    }
    function openMenu(field,{last=false,toggle=true}={}) {
      if(!allowed(field) || (!store.ready && !store.failed))return;
      if(selected===field && !menu.hidden) {if(toggle)closeMenu({focus:true});else {const items=menuItems();(last?items.at(-1):items[0])?.focus({preventScroll:true});}return;}
      closeControls();selected=field;opener=field.menu;
      menu.querySelector('[data-menu-title]').textContent=field.title.textContent;
      menu.querySelector('[data-field-hide]').hidden=!['control:center','control:vps'].includes(field.id);
      syncColors();
      menu.hidden=false;if(typeof menu.showPopover==='function') {menu.showPopover();menuInTopLayer=true;}
      opener.setAttribute('aria-expanded','true');positionMenu();
      const items=menuItems();(last?items.at(-1):items[0])?.focus({preventScroll:true});
    }
    function openEditor() {
      if(!selected || !allowed(selected) || !store.ready)return;
      editor.elements.title.value=selected.title.textContent;editor.elements.description.value=selected.description?.textContent || selected.extraDescription?.textContent || '';
      dialog.querySelector('[data-field-error]').textContent='';
      closeMenu({keepSelection:true});dialog.showModal();positionEditor();editor.elements.title.focus({preventScroll:true});
    }
    function rememberDefaults(field) {
      if(field.appliedTitle!==field.title.textContent) field.defaultTitle=field.title.textContent;
      if(field.description && field.appliedDescription!==field.description.textContent) field.defaultDescription=field.description.textContent;
    }
    function restore(field) {
      rememberDefaults(field);
      field.title.textContent=field.defaultTitle;
      if(field.description) field.description.textContent=field.defaultDescription;
      if(field.extraDescription) {field.extraDescription.remove();field.extraDescription=null;}
      delete field.element.dataset.dashboardColor;
      field.appliedTitle=null;field.appliedDescription=null;
    }
    function apply() {
      const preferences=store.value;
      for(const field of fields.values()) {
        rememberDefaults(field);
        const custom=preferences.fields[field.id];
        if(custom?.color) field.element.dataset.dashboardColor=custom.color;
        else delete field.element.dataset.dashboardColor;
        field.element.classList.toggle('start-dashboard-field-user-hidden',custom?.hidden===true);
        field.title.textContent=custom?.title ?? field.defaultTitle;
        field.appliedTitle=field.title.textContent;
        if(field.description) {
          field.description.textContent=custom?.description ?? field.defaultDescription;field.appliedDescription=field.description.textContent;
        } else if(custom?.description) {
          field.extraDescription ||= doc.createElement('p');field.extraDescription.className='start-dashboard-field-description';
          field.extraDescription.textContent=custom.description;field.title.after(field.extraDescription);
        } else if(field.extraDescription) {field.extraDescription.remove();field.extraDescription=null;}
        field.menu.hidden=!allowed(field);field.menu.setAttribute('aria-label','Feldmenü: '+field.title.textContent);
        field.menu.disabled=!store.ready && !store.failed;
      }
      for(const button of menu.querySelectorAll('[data-field-edit],[data-field-default],[data-field-geometry-default],[data-field-hide],[data-field-color]')) button.disabled=!store.ready;
      syncColors();
      menu.querySelector('[data-field-retry] [data-field-action-label]').textContent=store.ready ? 'Erneut speichern' : 'Erneut laden';
      if(selected && !allowed(selected)) closeControls();
      geometry?.sync();
      options.onApply?.({fields,preferences,store});
    }
    function add(id,element,title,description) {
      if(!element || !title || fields.has(id)) return;
      const button=doc.createElement('button');button.type='button';button.className='start-dashboard-field-menu-button';
      button.dataset.dashboardFieldMenu=id;button.textContent='⋯';button.setAttribute('aria-haspopup','menu');button.setAttribute('aria-expanded','false');button.setAttribute('aria-controls',menu.id);
      const field={id,element,title,description,defaultTitle:title.textContent,defaultDescription:description?.textContent || '',appliedTitle:null,appliedDescription:null,menu:button};
      element.classList.add('start-dashboard-workspace-field');element.append(button);fields.set(id,field);
      on(button,'click',event=>{event.stopPropagation();openMenu(field);});
      on(button,'keydown',event=>{if(!['ArrowDown','ArrowUp'].includes(event.key))return;event.preventDefault();event.stopPropagation();openMenu(field,{last:event.key==='ArrowUp',toggle:false});});
    }
    function discover() {
      for(const element of root.querySelectorAll('[data-start-dashboard-group]')) {
        const link=element.querySelector(':scope > .start-dashboard-group-link');
        add('group:'+element.dataset.startDashboardGroup,element,link?.querySelector('strong'),link?.querySelector('em'));
      }
      for(const element of root.querySelectorAll('[data-start-dashboard-card]')) {
        const link=element.querySelector(':scope > .start-dashboard-card-link');
        add('card:'+element.dataset.startDashboardCard,element,link?.querySelector('strong'),link?.querySelector('em'));
      }
      for(const element of root.querySelectorAll('[data-start-dashboard-widget]')) add('widget:'+element.dataset.startDashboardWidget,element,element.querySelector(':scope > span'),null);
      const control=root.querySelector('#startDashboardControlCenterButton');
      if(control && !fields.has('control:center')) {
        controlButton=control;controlAnchor=doc.createComment('dashboard-control-original');control.before(controlAnchor);
        const wrapper=doc.createElement('div');wrapper.className='start-dashboard-control-workspace';control.before(wrapper);wrapper.append(control);
        controlWrapper=wrapper;
        add('control:center',wrapper,control.querySelector('strong'),control.querySelector('em'));
      }
      const vps=root.querySelector('#startDashboardVpsCard');
      if(vps)add('control:vps',vps,vps.querySelector('[data-vps-title]'),vps.querySelector('[data-vps-description]'));
    }
    function modify(next) {if(!selected || !allowed(selected) || !store.ready) return;const preferences=store.value;
      if(next===null) {const old=preferences.fields[selected.id] || {};delete old.title;delete old.description;if(Object.keys(old).length) preferences.fields[selected.id]=old;else delete preferences.fields[selected.id];}
      else preferences.fields[selected.id]={...(preferences.fields[selected.id] || {}),...next};
      void store.change(preferences);closeControls({focus:true});
    }
    function setColor(color) {
      if(!selected || !allowed(selected) || !store.ready || (color!=='' && !model.COLORS.includes(color)))return;
      const preferences=store.value,id=selected.id,field={...(preferences.fields[id] || {})};
      if(color)field.color=color;else delete field.color;
      if(Object.keys(field).length)preferences.fields[id]=field;else delete preferences.fields[id];
      void store.change(preferences);closeControls({focus:true});
    }
    on(menu,'click',event=>{
      event.stopPropagation();
      if(event.target.closest('[data-field-close]')) closeMenu({focus:true});
      else if(event.target.closest('[data-field-edit]')) openEditor();
      else if(event.target.closest('[data-field-color]')) setColor(event.target.closest('[data-field-color]').dataset.fieldColor);
      else if(event.target.closest('[data-field-default]')) modify(null);
      else if(event.target.closest('[data-field-hide]')) {if(selected && ['control:center','control:vps'].includes(selected.id)) modify({hidden:true});}
      else if(event.target.closest('[data-field-geometry-default]') && selected && allowed(selected) && store.ready) {geometry?.reset(selected.id);closeMenu({focus:true});}
      else if(event.target.closest('[data-field-retry]') && selected && allowed(selected)) {if(store.ready) void store.change(store.value);else void store.activate({retry:true});closeMenu({focus:true});}
    });
    on(menu,'keydown',event=>{
      if(event.key==='Escape') {event.preventDefault();event.stopPropagation();closeMenu({focus:true});return;}
      if(event.key==='Tab') {closeMenu({focus:true});return;}
      if(['ArrowLeft','ArrowRight'].includes(event.key) && doc.activeElement?.hasAttribute('data-field-color')) {
        event.preventDefault();event.stopPropagation();const colors=menuItems().filter(button=>button.hasAttribute('data-field-color'));
        colors[(colors.indexOf(doc.activeElement)+(event.key==='ArrowLeft'?-1:1)+colors.length)%colors.length]?.focus({preventScroll:true});return;
      }
      if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
      event.preventDefault();event.stopPropagation();const items=menuItems(),index=items.indexOf(doc.activeElement);
      const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowUp'?-1:1)+items.length)%items.length;
      items[next]?.focus({preventScroll:true});
    });
    on(doc,'pointerdown',event=>{if(!menu.hidden && !menu.contains(event.target) && !opener?.contains(event.target))closeMenu();},true);
    on(doc,'focusin',event=>{if(!menu.hidden && !menu.contains(event.target) && event.target!==opener)closeMenu();});
    // Reanchor on scrolling: a trigger may have just been scrolled into view
    // before its click, with the browser's scroll event still queued.
    on(doc,'scroll',event=>{if(!menu.hidden && !menu.contains(event.target))positionMenu();},true);
    on(doc,'wheel',event=>{if(!menu.hidden && !menu.contains(event.target))closeMenu();},{capture:true,passive:true});
    const reposition=()=>{positionMenu();positionEditor();};
    on(win,'resize',reposition);on(win,'blur',()=>closeMenu());if(win.visualViewport) {on(win.visualViewport,'resize',reposition);on(win.visualViewport,'scroll',()=>{closeMenu();positionEditor();});}
    on(dialog,'click',event=>{
      if(event.target.closest('[data-field-back],[data-field-editor-close]'))closeEditor();
      else if(event.target===dialog) {
        const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left || event.clientX>rect.right || event.clientY<rect.top || event.clientY>rect.bottom)closeEditor();
      }
    });
    on(dialog,'cancel',event=>{event.preventDefault();closeEditor();});
    on(editor,'submit',event=>{event.preventDefault();if(!selected || !allowed(selected)) return;
      const next={title:editor.elements.title.value,description:editor.elements.description.value};
      try {model.validate({version:1,fields:{[selected.id]:next}});modify(next);}
      catch(error) {dialog.querySelector('[data-field-error]').textContent=error.message;}
    });
    // The native close event is queued. It must not steal later focus or clear
    // the selection of an already reopened menu or editor.
    on(dialog,'close',()=>{if(!dialog.open && menu.hidden)selected=null;});
    const unsubscribe=store.subscribe(apply);
    function sync() {
      const key=String(options.key() || '');
      if(identity!==key || !usable()) {geometry?.cancel();for(const field of fields.values()) restore(field);closeControls();store.invalidate();identity=key;}
      discover();
      if(!geometry && geometryApi && root.querySelector('#startDashboardGrid')) geometry=geometryApi.create({root,fields,allowed,usable,key:options.key,ready:()=>store.ready,value:()=>store.value,change:value=>store.change(value)});
      apply();if(usable()) void store.activate();
    }
    sync();
    return {sync,fields,store,get geometry(){return geometry;},setVisible(id,visible){if(!['control:center','control:vps'].includes(id)||!store.ready||!options.allowed(id))return Promise.resolve(false);const value=store.value;value.fields[id]={...value.fields[id],hidden:visible!==true};return store.change(value);},isVisible(id){return store.value.fields[id]?.hidden!==true;},resetAll(){geometry?.cancel();closeControls();return store.change(model.empty());},destroy(){closeControls();geometry?.destroy();destroyed=true;unsubscribe();store.invalidate();for(const remove of removers) remove();menu.remove();dialog.remove();for(const field of fields.values()) {restore(field);field.menu.remove();field.element.classList.remove('start-dashboard-workspace-field','start-dashboard-field-user-hidden');}
      if(controlAnchor?.parentNode) controlAnchor.replaceWith(controlButton);else if(controlWrapper?.parentNode) controlWrapper.before(controlButton);
      controlWrapper?.remove();controlAnchor?.remove();},dialog,menu};
  }
  return {createStore,create};
});
