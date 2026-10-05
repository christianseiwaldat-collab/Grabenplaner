(function(root,factory){
  'use strict';
  const api=factory(typeof module==='object'&&module.exports?require('./sidebar-notepad-preferences'):root.SidebarNotepadPreferences);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.SidebarNotepad=api;
})(typeof window==='object'?window:this,function(model){
  'use strict';
  const URL='/api/portal/v1/ui-preferences',FIELDS=['text','height','open'];
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
    let destroyed=false,forcedOpen=null,gesture=null,frame=null,preferredHeight=null,invalid=null,leaving=false,seenKey=String(options.key()||'');
    const on=(node,type,fn,config)=>{node?.addEventListener(type,fn,config);removers.push(()=>node?.removeEventListener(type,fn,config));};
    host.classList.add('sidebar-notepad');
    host.innerHTML='<section class="sidebar-notepad-paper" data-notepad-panel hidden aria-label="Persönlicher Notizblock"><div class="sidebar-notepad-resize" data-notepad-resize role="separator" tabindex="0" aria-label="Höhe des Notizblocks" aria-orientation="horizontal" title="Höhe ziehen · Pfeil nach oben/unten zum Anpassen"><i aria-hidden="true"></i></div><header><strong>Meine Notizen</strong><button type="button" data-notepad-close aria-label="Notizblock schließen" title="Notizblock schließen">×</button></header><textarea data-notepad-text aria-label="Persönliche Notizen" placeholder="Hier ist Platz für deine Notizen …" spellcheck="true"></textarea><footer><span data-notepad-status role="status" aria-live="polite"></span><button type="button" data-notepad-retry hidden>Erneut versuchen</button><button type="button" data-notepad-clear title="Alle eigenen Notizen leeren">Leeren</button><small data-notepad-count></small></footer></section><div class="sidebar-notepad-toolbar"><button type="button" data-notepad-toggle aria-label="Notizblock öffnen" title="Persönlicher Notizblock" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 3h14v13l-5 5H5zM14 21v-5h5M8 8h8M8 12h6"/></svg><i data-notepad-pending hidden aria-hidden="true"></i></button></div>';
    const query=selector=>host.querySelector(selector),panel=query('[data-notepad-panel]'),text=query('[data-notepad-text]'),handle=query('[data-notepad-resize]');
    const toggle=query('[data-notepad-toggle]'),close=query('[data-notepad-close]'),clear=query('[data-notepad-clear]'),retry=query('[data-notepad-retry]'),status=query('[data-notepad-status]');
    text.maxLength=model.MAX_TEXT;
    panel.id=(host.id||'sidebar-personal-notepad')+'-panel';toggle.setAttribute('aria-controls',panel.id);
    const scale=()=>sidebar.offsetWidth?sidebar.getBoundingClientRect().width/sidebar.offsetWidth:1;
    function availableHeight(){
      const zoom=scale()||1,style=win.getComputedStyle(sidebar);
      let used=parseFloat(style.paddingTop)||0;used+=parseFloat(style.paddingBottom)||0;
      for(const element of sidebar.children){
        if(element===host||element===menu)continue;
        const css=win.getComputedStyle(element);
        if(css.display==='none'||['absolute','fixed'].includes(css.position))continue;
        used+=element.getBoundingClientRect().height/zoom+(parseFloat(css.marginTop)||0)+(parseFloat(css.marginBottom)||0);
      }
      const toolbar=query('.sidebar-notepad-toolbar');
      used+=(toolbar.getBoundingClientRect().height/zoom)+12+Math.min(100,menu?.scrollHeight||100);
      return Math.max(0,Math.min(model.MAX_HEIGHT,sidebar.clientHeight-used));
    }
    function fit(){
      frame=null;if(destroyed||host.hidden)return;
      if(panel.hidden){sidebar.classList.remove('sidebar-notepad-scroll');return;}
      const maximum=availableHeight(),height=Math.min(preferredHeight??store.value.height,Math.max(model.MIN_HEIGHT,maximum));
      sidebar.classList.toggle('sidebar-notepad-scroll',maximum<model.MIN_HEIGHT);
      panel.style.height=Math.round(height)+'px';
      handle.setAttribute('aria-valuemin',String(model.MIN_HEIGHT));handle.setAttribute('aria-valuemax',String(Math.max(model.MIN_HEIGHT,Math.floor(maximum))));
      handle.setAttribute('aria-valuenow',String(Math.round(height)));handle.setAttribute('aria-valuetext',Math.round(height)+' Pixel hoch');
    }
    function scheduleFit(){if(frame===null)frame=win.requestAnimationFrame(fit);}
    function render(){
      const key=String(options.key()||'');if(key!==seenKey){seenKey=key;invalid=null;leaving=false;forcedOpen=null;preferredHeight=null;cancelGesture();}
      const allowed=!destroyed&&options.canUse();host.hidden=!allowed;sidebar.classList.toggle('has-personal-notepad',allowed);
      const value=store.value,open=allowed&&(forcedOpen??(store.ready&&value.open));
      panel.hidden=!open;toggle.setAttribute('aria-expanded',String(open));toggle.setAttribute('aria-label',open?'Notizblock schließen':'Notizblock öffnen');
      toggle.title=open?'Persönlichen Notizblock schließen':'Persönlichen Notizblock öffnen';
      text.disabled=!store.ready||leaving;handle.setAttribute('aria-disabled',String(!store.ready||leaving));handle.tabIndex=store.ready&&!leaving?0:-1;clear.disabled=!store.ready||leaving||!(invalid?text.value:value.text);
      toggle.disabled=leaving;close.disabled=leaving;retry.disabled=leaving;
      if(!store.ready)invalid=null;
      if(!invalid&&text.value!==value.text)text.value=value.text;
      text.setCustomValidity(invalid||'');
      query('[data-notepad-count]').textContent=text.value.length.toLocaleString('de-AT')+' / 20.000';
      const messages={loading:'Notizen werden geladen …',saved:'Gespeichert',pending:'Noch nicht gespeichert',saving:'Wird gespeichert …','load-error':'Laden fehlgeschlagen.','save-error':'Speichern fehlgeschlagen.','unavailable':''};
      status.textContent=invalid||messages[store.status]||'';retry.hidden=!['load-error','save-error'].includes(store.status);
      query('[data-notepad-pending]').hidden=!['pending','saving','save-error','load-error'].includes(store.status);
      if(!allowed){cancelGesture();forcedOpen=null;preferredHeight=null;sidebar.classList.remove('sidebar-notepad-scroll');}
      scheduleFit();
    }
    function setOpen(open){
      if(!options.canUse()||leaving)return;
      if(store.ready){forcedOpen=null;store.change({...store.value,open});if(!invalid)void store.flush();}else{forcedOpen=open;render();}
      if(open&&store.ready)text.focus({preventScroll:true});else if(!open)toggle.focus({preventScroll:true});
    }
    function cancelGesture(){if(!gesture)return;const old=gesture;gesture=null;preferredHeight=null;if(handle.hasPointerCapture?.(old.id))handle.releasePointerCapture(old.id);scheduleFit();}
    function finish(){if(!gesture)return;const next=preferredHeight;cancelGesture();if(store.ready&&next!==null){store.change({...store.value,height:Math.round(next)});void store.flush();}}
    on(toggle,'click',()=>setOpen(panel.hidden));on(close,'click',()=>setOpen(false));
    on(text,'input',()=>{if(leaving){render();return;}try{invalid=null;if(!store.change({...store.value,text:text.value}))render();}catch(error){invalid=error.message;render();}});
    on(text,'blur',()=>{if(store.ready&&!invalid)void store.flush();});
    on(clear,'click',()=>{if(store.ready&&!leaving&&text.value&&win.confirm('Alle persönlichen Notizen unwiderruflich leeren?')){invalid=null;store.change({...store.value,text:''});void store.flush();text.focus({preventScroll:true});}});
    function applyOpenIntent(){if(store.ready&&forcedOpen!==null){const open=forcedOpen;forcedOpen=null;store.change({...store.value,open});void store.flush();}}
    on(retry,'click',()=>{void store.retry().then(applyOpenIntent);});
    on(handle,'pointerdown',event=>{
      if(event.button!==0||!store.ready||leaving||gesture)return;
      event.preventDefault();handle.focus({preventScroll:true});fit();gesture={id:event.pointerId,y:event.clientY,height:panel.offsetHeight,scale:scale()||1};
      preferredHeight=panel.offsetHeight;handle.setPointerCapture(event.pointerId);
    });
    on(handle,'pointermove',event=>{if(!gesture||event.pointerId!==gesture.id)return;if(!store.ready){cancelGesture();return;}
      preferredHeight=Math.max(model.MIN_HEIGHT,Math.min(Math.max(model.MIN_HEIGHT,availableHeight()),gesture.height+(gesture.y-event.clientY)/gesture.scale));fit();});
    on(handle,'pointerup',event=>{if(gesture&&event.pointerId===gesture.id)finish();});
    on(handle,'pointercancel',cancelGesture);on(handle,'lostpointercapture',cancelGesture);
    on(handle,'keydown',event=>{
      if(event.key==='Escape'&&gesture){event.preventDefault();cancelGesture();return;}
      if(!store.ready||leaving||!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
      event.preventDefault();const max=Math.max(model.MIN_HEIGHT,Math.floor(availableHeight())),step=event.shiftKey?50:10;
      const height=event.key==='Home'?model.MIN_HEIGHT:event.key==='End'?max:Math.max(model.MIN_HEIGHT,Math.min(max,panel.offsetHeight+(event.key==='ArrowUp'?step:-step)));
      store.change({...store.value,height});void store.flush();
    });
    on(panel,'keydown',event=>{if(event.key==='Escape'&&!gesture){event.preventDefault();event.stopPropagation();setOpen(false);}});
    on(win,'resize',scheduleFit);on(win.visualViewport,'resize',scheduleFit);
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
      destroy(){destroyed=true;cancelGesture();unsubscribe();store.destroy();observer?.disconnect();for(const remove of removers)remove();if(frame!==null)win.cancelAnimationFrame(frame);host.replaceChildren();host.classList.remove('sidebar-notepad');sidebar.classList.remove('has-personal-notepad','sidebar-notepad-scroll');}};
  }
  return Object.freeze({createStore,mount});
});
