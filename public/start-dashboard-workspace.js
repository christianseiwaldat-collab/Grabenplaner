(function(root,factory) {
  'use strict';
  const common=typeof module==='object' && module.exports;
  const api=factory(common ? require('./start-dashboard-workspace-preferences') : root.StartDashboardWorkspacePreferences,
    common ? require('./start-dashboard-workspace-geometry') : root.StartDashboardWorkspaceGeometry);
  if(typeof module==='object' && module.exports) module.exports=api;
  else root.StartDashboardWorkspace=api;
})(typeof window==='object' ? window : this,function(model,geometryApi) {
  'use strict';
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
    const fields=new Map(),removers=[],on=(node,name,fn)=>{node.addEventListener(name,fn);removers.push(()=>node.removeEventListener(name,fn));};
    let identity='',selected=null,destroyed=false,controlAnchor=null,controlButton=null,controlWrapper=null,geometry=null;
    const usable=()=>!destroyed && options.canUse();
    const store=createStore({...options,error:error=>options.error(error)});
    const dialog=doc.createElement('dialog');dialog.className='start-dashboard-field-dialog';dialog.setAttribute('aria-label','Dashboard-Feld anpassen');
    dialog.innerHTML='<div data-field-menu><h3 data-menu-title>Feld anpassen</h3><button type="button" data-field-edit>Beschriftung ändern</button><button type="button" data-field-default>Standardbeschriftung</button><button type="button" data-field-geometry-default>Standardposition und -größe</button><button type="button" data-field-retry>Erneut speichern</button><button type="button" data-field-close>Schließen</button></div>'
      +'<form data-field-editor hidden><h3>Beschriftung ändern</h3><label>Feldtitel<input name="title" maxlength="120" required></label><label>Beschreibung<textarea name="description" maxlength="400" rows="3"></textarea></label><p data-field-error role="alert"></p><div class="modal-actions"><button type="button" data-field-back>Zurück</button><button type="submit" class="primary-button">Übernehmen</button></div></form>';
    doc.body.append(dialog);
    const menu=dialog.querySelector('[data-field-menu]'),editor=dialog.querySelector('[data-field-editor]');
    const allowed=field=>usable() && options.allowed(field.id);
    function rememberDefaults(field) {
      if(field.appliedTitle!==field.title.textContent) field.defaultTitle=field.title.textContent;
      if(field.description && field.appliedDescription!==field.description.textContent) field.defaultDescription=field.description.textContent;
    }
    function restore(field) {
      rememberDefaults(field);
      field.title.textContent=field.defaultTitle;
      if(field.description) field.description.textContent=field.defaultDescription;
      if(field.extraDescription) {field.extraDescription.remove();field.extraDescription=null;}
      field.appliedTitle=null;field.appliedDescription=null;
    }
    function apply() {
      const preferences=store.value;
      for(const field of fields.values()) {
        rememberDefaults(field);
        const custom=preferences.fields[field.id];
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
      for(const button of dialog.querySelectorAll('[data-field-edit],[data-field-default],[data-field-geometry-default]')) button.disabled=!store.ready;
      dialog.querySelector('[data-field-retry]').textContent=store.ready ? 'Erneut speichern' : 'Erneut laden';
      if(selected && !allowed(selected)) dialog.close();
      geometry?.sync();
      options.onApply?.({fields,preferences,store});
    }
    function add(id,element,title,description) {
      if(!element || !title || fields.has(id)) return;
      const button=doc.createElement('button');button.type='button';button.className='start-dashboard-field-menu-button';
      button.dataset.dashboardFieldMenu=id;button.textContent='⋯';button.setAttribute('aria-haspopup','dialog');
      const field={id,element,title,description,defaultTitle:title.textContent,defaultDescription:description?.textContent || '',appliedTitle:null,appliedDescription:null,menu:button};
      element.classList.add('start-dashboard-workspace-field');element.append(button);fields.set(id,field);
      on(button,'click',event=>{event.stopPropagation();if(!allowed(field)) return;selected=field;menu.hidden=false;editor.hidden=true;dialog.querySelector('[data-menu-title]').textContent=field.title.textContent;
        dialog.style.removeProperty('left');dialog.style.removeProperty('top');dialog.showModal();
        const rect=button.getBoundingClientRect(),scale=dialog.getBoundingClientRect().width/dialog.offsetWidth || 1;
        const width=dialog.getBoundingClientRect().width,height=dialog.getBoundingClientRect().height;
        dialog.style.left=Math.max(8,Math.min(rect.right-width,win.innerWidth-width-8))/scale+'px';
        dialog.style.top=Math.max(8,Math.min(rect.bottom+6,win.innerHeight-height-8))/scale+'px';
      });
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
    }
    function modify(next) {if(!selected || !allowed(selected) || !store.ready) return;const preferences=store.value;
      if(next===null) {const old=preferences.fields[selected.id] || {};delete old.title;delete old.description;if(Object.keys(old).length) preferences.fields[selected.id]=old;else delete preferences.fields[selected.id];}
      else preferences.fields[selected.id]={...(preferences.fields[selected.id] || {}),...next};
      void store.change(preferences);dialog.close();
    }
    on(dialog,'click',event=>{
      if(event.target===dialog || event.target.closest('[data-field-close]')) dialog.close();
      else if(event.target.closest('[data-field-edit]') && selected && allowed(selected) && store.ready) {
        menu.hidden=true;editor.hidden=false;editor.elements.title.value=selected.title.textContent;editor.elements.description.value=selected.description?.textContent || selected.extraDescription?.textContent || '';
        dialog.querySelector('[data-field-error]').textContent='';dialog.style.removeProperty('left');dialog.style.removeProperty('top');editor.elements.title.focus();
      } else if(event.target.closest('[data-field-default]')) modify(null);
      else if(event.target.closest('[data-field-geometry-default]') && selected && allowed(selected) && store.ready) {geometry?.reset(selected.id);dialog.close();}
      else if(event.target.closest('[data-field-retry]')) {if(store.ready) void store.change(store.value);else void store.activate({retry:true});dialog.close();}
      else if(event.target.closest('[data-field-back]')) {menu.hidden=false;editor.hidden=true;}
    });
    on(editor,'submit',event=>{event.preventDefault();if(!selected || !allowed(selected)) return;
      const next={title:editor.elements.title.value,description:editor.elements.description.value};
      try {model.validate({version:1,fields:{[selected.id]:next}});modify(next);}
      catch(error) {dialog.querySelector('[data-field-error]').textContent=error.message;}
    });
    on(dialog,'close',()=>{selected?.menu.focus({preventScroll:true});selected=null;});
    const unsubscribe=store.subscribe(apply);
    function sync() {
      const key=String(options.key() || '');
      if(identity!==key || !usable()) {geometry?.cancel();for(const field of fields.values()) restore(field);if(dialog.open) dialog.close();store.invalidate();identity=key;}
      discover();
      if(!geometry && geometryApi && root.querySelector('#startDashboardGrid')) geometry=geometryApi.create({root,fields,allowed,usable,key:options.key,ready:()=>store.ready,value:()=>store.value,change:value=>store.change(value)});
      apply();if(usable()) void store.activate();
    }
    sync();
    return {sync,fields,store,get geometry(){return geometry;},resetAll(){geometry?.cancel();if(dialog.open) dialog.close();return store.change(model.empty());},destroy(){geometry?.destroy();destroyed=true;unsubscribe();store.invalidate();for(const remove of removers) remove();dialog.remove();for(const field of fields.values()) {restore(field);field.menu.remove();field.element.classList.remove('start-dashboard-workspace-field');}
      if(controlAnchor?.parentNode) controlAnchor.replaceWith(controlButton);else if(controlWrapper?.parentNode) controlWrapper.before(controlButton);
      controlWrapper?.remove();controlAnchor?.remove();},dialog};
  }
  return {createStore,create};
});
