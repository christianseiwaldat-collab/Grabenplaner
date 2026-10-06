(function(root,factory){
  'use strict';
  const api=factory(typeof module==='object'&&module.exports?require('./sidebar-notepad-preferences'):root.SidebarNotepadPreferences);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.SidebarNotepad=api;
})(typeof window==='object'?window:this,function(model){
  'use strict';
  const URL='/api/portal/v1/ui-preferences',FIELDS=['text','width','height','open'];
  const same=(a,b)=>FIELDS.every(key=>a[key]===b[key]);
  function createStore(options){
    let actor='',identity='',epoch=0,loaded=false,destroyed=false,read=null,write=null,timer=null;
    let value=model.empty(),baseline=model.empty(),failure=null,uncertain=false;
    const drafts=new Map(),listeners=new Set();
    const identityNow=()=>String(options.identity?.()||options.key()||'');
    const current=(key,ticket)=>!destroyed&&options.canUse()&&actor===key&&options.key()===key&&epoch===ticket;
    const ready=()=>current(actor,epoch)&&loaded;
    const dirty=()=>uncertain||!same(value,baseline);
    const notify=()=>{for(const listener of listeners)listener();};
    const clearTimer=()=>{if(timer!==null){clearTimeout(timer);timer=null;}};
    function remember(){
      if(!identity||!loaded)return;
      const patch={};
      for(const key of FIELDS)if(uncertain||value[key]!==baseline[key]||(write&&write.snapshot[key]!==value[key]))patch[key]=value[key];
      if(Object.keys(patch).length)drafts.set(identity,patch);else drafts.delete(identity);
    }
    function invalidate(){
      remember();epoch++;clearTimer();read?.controller.abort();write?.controller.abort();read=null;write=null;
      loaded=false;failure=null;uncertain=false;actor=String(options.key()||'');identity=identityNow();
      value=model.empty();baseline=model.empty();notify();
    }
    function synchronize(){if(actor!==String(options.key()||'')||identity!==identityNow()||((loaded||read||write)&&!options.canUse()))invalidate();}
    async function activate({retry=false}={}){
      synchronize();if(destroyed||!options.canUse()||loaded||read||(failure?.kind==='load'&&!retry))return read?.promise;
      const key=actor,ticket=epoch,controller=new AbortController(),request={controller};read=request;failure=null;notify();
      request.promise=(async()=>{
        try{
          const payload=await options.api(URL,{signal:controller.signal});
          if(controller.signal.aborted||!current(key,ticket))return false;
          // An old server, denied account or malformed payload is not an empty note.
          const next=model.validate(payload?.sidebarNotepad);
          baseline=next;value=model.validate({...next,...drafts.get(identity)});loaded=true;remember();notify();
          if(dirty())schedule();
          return true;
        }catch(error){if(!controller.signal.aborted&&current(key,ticket)){failure={kind:'load',error};notify();options.error?.(error);}return false;}
        finally{if(read===request){read=null;notify();}}
      })();return request.promise;
    }
    function schedule(){clearTimer();timer=setTimeout(()=>{timer=null;void flush();},options.delay??250);}
    function change(next){
      synchronize();if(!ready())return false;
      value=model.validate(next);failure=null;remember();notify();schedule();return true;
    }
    function flush(){
      synchronize();clearTimer();if(!ready())return Promise.resolve(false);if(write)return write.promise;
      if(!dirty())return Promise.resolve(true);
      const key=actor,ticket=epoch,controller=new AbortController(),request={controller,snapshot:model.validate(value)};
      write=request;failure=null;notify();
      request.promise=(async()=>{
        while(current(key,ticket)&&!controller.signal.aborted&&dirty()){
          const snapshot=model.validate(value);request.snapshot=snapshot;
          const body=JSON.stringify({sidebarNotepad:snapshot});
          try{
            await options.api(URL,{method:'PUT',body,signal:controller.signal});
            if(controller.signal.aborted||!current(key,ticket))return false;
            baseline=snapshot;uncertain=false;remember();notify();
          }catch(error){
            if(!controller.signal.aborted&&current(key,ticket)){uncertain=true;failure={kind:'save',error};remember();notify();options.error?.(error);}
            return false;
          }
        }
        return current(key,ticket)&&!dirty();
      })().finally(()=>{if(write===request){write=null;remember();notify();}});
      return request.promise;
    }
    return {
      activate,change,flush,invalidate,retry:()=>ready()?flush():activate({retry:true}),
      get value(){return ready()?model.validate(value):model.empty();},get ready(){return ready();},
      get status(){return !current(actor,epoch)?'unavailable':failure?failure.kind+'-error':!loaded?'loading':write?'saving':dirty()?'pending':'saved';},
      get hasUnsaved(){return current(actor,epoch)&&(drafts.has(identity)||(loaded&&(dirty()||Boolean(write))));},get hasPendingDrafts(){return drafts.size>0||(ready()&&(dirty()||Boolean(write)));},
      subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
      destroy(){remember();destroyed=true;epoch++;clearTimer();read?.controller.abort();write?.controller.abort();read=null;write=null;loaded=false;value=model.empty();baseline=model.empty();drafts.clear();listeners.clear();},
    };
  }
  function mount(host,options){
    const doc=host.ownerDocument,win=doc.defaultView,sidebar=options.sidebar||host.parentElement,menu=options.menu||sidebar.querySelector('.main-nav');
    const store=createStore(options),removers=[];
    const geometry=options.geometry||win.GpWindow;
    let destroyed=false,forcedOpen=null,gesture=null,frame=null,preferredSize=null,invalid=null,leaving=false,seenKey=String(options.key()||'');
    const on=(node,type,fn,config)=>{node?.addEventListener(type,fn,config);removers.push(()=>node?.removeEventListener(type,fn,config));};
    host.classList.add('sidebar-notepad');
    host.innerHTML='<section class="sidebar-notepad-paper" data-notepad-panel hidden aria-label="Persönlicher Notizblock"><div class="sidebar-notepad-resize" data-notepad-resize role="separator" tabindex="0" aria-label="Höhe des Notizblocks" aria-orientation="horizontal" title="Höhe ziehen · Pfeil nach oben/unten zum Anpassen"><i aria-hidden="true"></i></div><header><strong>Meine Notizen</strong><button type="button" data-notepad-close aria-label="Notizblock schließen" title="Notizblock schließen">×</button></header><textarea data-notepad-text aria-label="Persönliche Notizen" placeholder="Hier ist Platz für deine Notizen …" spellcheck="true"></textarea><footer><span data-notepad-status role="status" aria-live="polite"></span><button type="button" data-notepad-retry hidden>Erneut versuchen</button><button type="button" data-notepad-clear title="Alle eigenen Notizen leeren">Leeren</button><small data-notepad-count></small></footer></section><div class="sidebar-notepad-toolbar"><button type="button" data-notepad-toggle aria-label="Notizblock öffnen" title="Persönlicher Notizblock" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 3h14v13l-5 5H5zM14 21v-5h5M8 8h8M8 12h6"/></svg><i data-notepad-pending hidden aria-hidden="true"></i></button></div>';
    const query=selector=>host.querySelector(selector)||panel.querySelector(selector),panel=query('[data-notepad-panel]'),text=query('[data-notepad-text]'),handle=query('[data-notepad-resize]');
    const toggle=query('[data-notepad-toggle]'),close=query('[data-notepad-close]'),clear=query('[data-notepad-clear]'),retry=query('[data-notepad-retry]'),status=query('[data-notepad-status]');
    text.maxLength=model.MAX_TEXT;
    panel.id=(host.id||'sidebar-personal-notepad')+'-panel';toggle.setAttribute('aria-controls',panel.id);
    // A body-level overlay can extend across the application without changing
    // menu height or being clipped by the sidebar's scroll container.
    doc.body.append(panel);
    const handles=[handle];handle.className='gp-window-edge';handle.dataset.gpWindowEdge='n';handle.setAttribute('aria-label','Notizblock oben vergrößern: ziehen oder Pfeiltasten verwenden');handle.replaceChildren();
    for(const edge of ['e','ne']){const node=doc.createElement('button');node.type='button';node.className='gp-window-edge';node.dataset.gpWindowEdge=edge;node.setAttribute('aria-label',edge==='e'?'Notizblock rechts vergrößern: ziehen oder Pfeiltasten verwenden':'Notizblock oben rechts vergrößern: ziehen oder Pfeiltasten verwenden');panel.append(node);handles.push(node);}
    const scale=()=>sidebar.offsetWidth?sidebar.getBoundingClientRect().width/sidebar.offsetWidth:1;
    const bounds=()=>geometry.viewportBounds(win.visualViewport||{width:win.innerWidth,height:win.innerHeight},scale()||1);
    function fitted(){const area=bounds(),size=preferredSize||store.value;
      const value=geometry.fit({x:0,y:0,width:size.width,height:size.height,minimized:false},area,{minWidth:model.MIN_WIDTH,minHeight:model.MIN_HEIGHT});
      return {...value,x:0,y:Math.max(0,area.height-value.height)};}
    function fit(){
      frame=null;if(destroyed||host.hidden)return;
      if(panel.hidden||!geometry)return;
      const area=bounds(),value=fitted();panel.style.left=area.left+'px';panel.style.top=(area.top+value.y)+'px';panel.style.width=value.width+'px';panel.style.height=value.height+'px';
      for(const node of handles){const horizontal=node.dataset.gpWindowEdge==='e';node.setAttribute('aria-valuemin',String(horizontal?model.MIN_WIDTH:model.MIN_HEIGHT));node.setAttribute('aria-valuemax',String(Math.floor(horizontal?area.width:area.height)));node.setAttribute('aria-valuenow',String(horizontal?value.width:value.height));node.setAttribute('aria-valuetext',`${value.width} × ${value.height} Pixel`);}
    }
    function scheduleFit(){if(frame===null)frame=win.requestAnimationFrame(fit);}
    function render(){
      const key=String(options.key()||'');if(key!==seenKey){seenKey=key;invalid=null;leaving=false;forcedOpen=null;preferredSize=null;cancelGesture();}
      const allowed=!destroyed&&options.canUse();host.hidden=!allowed;sidebar.classList.toggle('has-personal-notepad',allowed);
      const value=store.value,open=allowed&&(forcedOpen??(store.ready&&value.open));
      panel.hidden=!open;toggle.setAttribute('aria-expanded',String(open));toggle.setAttribute('aria-label',open?'Notizblock schließen':'Notizblock öffnen');
      toggle.title=open?'Persönlichen Notizblock schließen':'Persönlichen Notizblock öffnen';
      text.disabled=!store.ready||leaving;for(const node of handles){node.setAttribute('aria-disabled',String(!store.ready||leaving));node.tabIndex=store.ready&&!leaving?0:-1;}clear.disabled=!store.ready||leaving||!(invalid?text.value:value.text);
      toggle.disabled=leaving;close.disabled=leaving;retry.disabled=leaving;
      if(!store.ready)invalid=null;
      if(!invalid&&text.value!==value.text)text.value=value.text;
      text.setCustomValidity(invalid||'');
      query('[data-notepad-count]').textContent=text.value.length.toLocaleString('de-AT')+' / 20.000';
      const messages={loading:'Notizen werden geladen …',saved:'Gespeichert',pending:'Noch nicht gespeichert',saving:'Wird gespeichert …','load-error':'Laden fehlgeschlagen.','save-error':'Speichern fehlgeschlagen.','unavailable':''};
      status.textContent=invalid||messages[store.status]||'';retry.hidden=!['load-error','save-error'].includes(store.status);
      query('[data-notepad-pending]').hidden=!['pending','saving','save-error','load-error'].includes(store.status);
      if(!allowed){cancelGesture();forcedOpen=null;preferredSize=null;}
      scheduleFit();
    }
    function setOpen(open){
      if(!options.canUse()||leaving)return;
      if(store.ready){forcedOpen=null;store.change({...store.value,open});if(!invalid)void store.flush();}else{forcedOpen=open;render();}
      if(open&&store.ready)text.focus({preventScroll:true});else if(!open)toggle.focus({preventScroll:true});
    }
    function cancelGesture(){if(!gesture)return;const old=gesture;gesture=null;preferredSize=null;if(old.handle.hasPointerCapture?.(old.id))old.handle.releasePointerCapture(old.id);scheduleFit();}
    function finish(){if(!gesture)return;const next=preferredSize;cancelGesture();if(store.ready&&next!==null){store.change({...store.value,width:Math.max(model.MIN_WIDTH,Math.min(model.MAX_WIDTH,Math.round(next.width))),height:Math.max(model.MIN_HEIGHT,Math.min(model.MAX_HEIGHT,Math.round(next.height)))});void store.flush();}}
    on(toggle,'click',()=>setOpen(panel.hidden));on(close,'click',()=>setOpen(false));
    on(text,'input',()=>{if(leaving){render();return;}try{invalid=null;if(!store.change({...store.value,text:text.value}))render();}catch(error){invalid=error.message;render();}});
    on(text,'blur',()=>{if(store.ready&&!invalid)void store.flush();});
    on(clear,'click',()=>{if(store.ready&&!leaving&&text.value&&win.confirm('Alle persönlichen Notizen unwiderruflich leeren?')){invalid=null;store.change({...store.value,text:''});void store.flush();text.focus({preventScroll:true});}});
    function applyOpenIntent(){if(store.ready&&forcedOpen!==null){const open=forcedOpen;forcedOpen=null;store.change({...store.value,open});void store.flush();}}
    on(retry,'click',()=>{void store.retry().then(applyOpenIntent);});
    for(const node of handles){
      on(node,'pointerdown',event=>{if(event.button!==0||!store.ready||leaving||gesture||!geometry)return;
        event.preventDefault();node.focus({preventScroll:true});fit();gesture={id:event.pointerId,x:event.clientX,y:event.clientY,base:fitted(),preferred:store.value,edge:node.dataset.gpWindowEdge,handle:node,scale:scale()||1};node.setPointerCapture(event.pointerId);});
      on(node,'lostpointercapture',cancelGesture);
      on(node,'keydown',event=>{if(event.key==='Escape'&&gesture){event.preventDefault();cancelGesture();return;}
        const vector={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
        if(!store.ready||leaving||!geometry||!vector&&!['Home','End'].includes(event.key))return;
        event.preventDefault();const area=bounds(),start=fitted(),edge=node.dataset.gpWindowEdge,step=event.shiftKey?1:10;
        let dx=(vector?.[0]||0)*step,dy=(vector?.[1]||0)*step;
        if(event.key==='Home'||event.key==='End'){const max=event.key==='End';if(edge.includes('e'))dx=max?area.width-start.width:model.MIN_WIDTH-start.width;if(edge.includes('n'))dy=max?-start.y:start.height-model.MIN_HEIGHT;}
        const changed=geometry.adjust(start,edge,dx,dy,area,{minWidth:model.MIN_WIDTH,minHeight:model.MIN_HEIGHT}),next=geometry.persistedGeometry(store.value,start,changed,edge);
        store.change({...store.value,width:Math.max(model.MIN_WIDTH,Math.min(model.MAX_WIDTH,next.width)),height:Math.max(model.MIN_HEIGHT,Math.min(model.MAX_HEIGHT,next.height))});void store.flush();});
    }
    on(win,'pointermove',event=>{if(!gesture||event.pointerId!==gesture.id)return;if(!store.ready){cancelGesture();return;}
      const value=geometry.adjust(gesture.base,gesture.edge,(event.clientX-gesture.x)/gesture.scale,(event.clientY-gesture.y)/gesture.scale,bounds(),{minWidth:model.MIN_WIDTH,minHeight:model.MIN_HEIGHT});
      preferredSize=geometry.persistedGeometry(gesture.preferred,gesture.base,value,gesture.edge);fit();});
    on(win,'pointerup',event=>{if(gesture&&event.pointerId===gesture.id)finish();});on(win,'pointercancel',cancelGesture);
    on(panel,'keydown',event=>{if(event.key==='Escape'&&!gesture){event.preventDefault();event.stopPropagation();setOpen(false);}});
    on(win,'resize',()=>{cancelGesture();scheduleFit();});on(win,'blur',cancelGesture);on(win.visualViewport,'resize',()=>{cancelGesture();scheduleFit();});on(win.visualViewport,'scroll',scheduleFit);
    on(win,'beforeunload',event=>{if(invalid||store.hasPendingDrafts){event.preventDefault();event.returnValue='';}});
    const observer=typeof win.ResizeObserver==='function'?new win.ResizeObserver(scheduleFit):null;
    observer?.observe(sidebar);if(menu)observer?.observe(menu);
    for(const child of sidebar.children)if(child!==host)observer?.observe(child);
    const unsubscribe=store.subscribe(render);
    async function sync(){cancelGesture();await store.activate();applyOpenIntent();render();}
    async function prepareLogout(){
      if(invalid)return false;
      leaving=true;cancelGesture();render();
      if(!store.ready&&store.hasUnsaved)await store.activate();
      const result=store.ready?await store.flush():!store.hasUnsaved;
      if(!result){leaving=false;render();}
      return result;
    }
    void sync();
    return {sync,prepareLogout,flush:()=>invalid?Promise.resolve(false):store.flush(),get hasUnsaved(){return Boolean(invalid)||store.hasUnsaved;},store,
      destroy(){destroyed=true;cancelGesture();unsubscribe();store.destroy();observer?.disconnect();for(const remove of removers)remove();if(frame!==null)win.cancelAnimationFrame(frame);panel.remove();host.replaceChildren();host.classList.remove('sidebar-notepad');sidebar.classList.remove('has-personal-notepad','sidebar-notepad-scroll');}};
  }
  return Object.freeze({createStore,mount});
});
