(function(root){
  'use strict';
  function mount({document:doc,load,getActor,onChange=()=>{},onExit=()=>{}}){
    const win=doc.defaultView,host=doc.createElement('section'),close=doc.createElement('button');
    let actor='',items=[],frame=null,generation=0,loading=null,timer=null,opener=null,previousOverflow=null,photo=null,picker=null;
    host.hidden=true;host.className='gp-private-workspace-host';host.setAttribute('aria-label','Freigegebener Arbeitsbereich');
    close.type='button';close.textContent='×';close.setAttribute('aria-label','Arbeitsbereich beenden');close.className='gp-private-workspace-close';host.append(close);doc.body.append(host);
    const identity=()=>{const user=getActor();return user?JSON.stringify([user.accountId,user.employeeNumber,user.id,user.permissions,user.mustChangePassword]):'';};
    function clearVisit(){if(win.history.state?.gpPrivateWorkspace){const state={...win.history.state};delete state.gpPrivateWorkspace;win.history.replaceState(state,'',win.location.href);}}
    clearVisit(); // Reload/Forward returns to the portal without reopening a camera.
    function viewport(){if(host.hidden)return;const v=win.visualViewport,scale=Number.parseFloat(win.getComputedStyle(doc.body).zoom)||1;Object.assign(host.style,{inset:'auto',left:(v?.offsetLeft||0)/scale+'px',top:(v?.offsetTop||0)/scale+'px',width:(v?.width||win.innerWidth)/scale+'px',height:(v?.height||win.innerHeight)/scale+'px'});}
    function exit({history=true,notify=true}={}){
      const wasOpen=Boolean(frame);
      if(frame){frame.contentWindow?.postMessage({type:'gp-private-workspace-visibility',active:false},win.location.origin);frame.remove();frame=null;}
      photo=null;picker?.remove();picker=null;host.hidden=true;win.clearInterval(timer);timer=null;
      if(previousOverflow!==null){doc.documentElement.style.overflow=previousOverflow;previousOverflow=null;}
      if(opener?.isConnected)opener.focus({preventScroll:true});opener=null;close.blur();
      if(wasOpen&&history&&win.history.state?.gpPrivateWorkspace)win.history.back();
      if(wasOpen&&notify)onExit();
    }
    function activate(){if(!frame||host.hidden||identity()!==actor)return;frame.contentWindow?.postMessage({type:'gp-private-workspace-visibility',active:true},win.location.origin);if(photo)frame.contentWindow?.postMessage({type:'gp-private-workspace-photo',...photo},win.location.origin);}
    async function synchronize(){
      const key=identity();
      if(key!==actor){actor=key;generation++;loading=null;items=[];exit();onChange();}
      if(!key)return;if(loading)return loading;const ticket=generation;
      loading=(async()=>{try{
        const result=await load();if(ticket!==generation||identity()!==key)return;
        items=(Array.isArray(result)?result:[]).filter(v=>/^[a-z][a-z0-9-]{0,40}$/.test(v?.id||'')&&typeof v.title==='string'&&v.title.length<=80&&v.url==='/api/portal/v1/private-workspaces/'+v.id+'/page');
        if(frame&&!items.some(v=>v.id===frame.dataset.workspaceId))exit();onChange();
      }catch{if(ticket===generation){items=[];exit();onChange();}}finally{if(ticket===generation)loading=null;}})();
      return loading;
    }
    // Preserve the tile's user activation: no network await or iframe message
    // before opening the native picker. Files only go to the authorized frame.
    function capture(item){
      if(item.nativeCamera!==true||item.cameraSettings?.autoCamera===false||!win.matchMedia('(pointer: coarse), (max-width: 720px)').matches||!win.navigator.userActivation?.isActive)return;
      const input=doc.createElement('input'),ticket=generation,target=frame;
      input.type='file';input.accept='image/jpeg,image/png,image/webp';input.setAttribute('capture',item.cameraSettings?.cameraFacing==='user'?'user':'environment');input.hidden=true;input.dataset.workspaceCamera=item.id;doc.body.append(input);picker=input;
      input.addEventListener('change',()=>{const file=input.files?.[0];input.remove();if(picker===input)picker=null;if(target!==frame||ticket!==generation||identity()!==actor)return;if(!file){exit();return;}photo={id:win.crypto.randomUUID(),file};activate();},{once:true});
      input.addEventListener('cancel',()=>{if(target===frame&&ticket===generation)exit();},{once:true});
      try{if(input.showPicker)input.showPicker();else input.click();}catch{input.remove();picker=null;/* The module keeps its direct Foto aufnehmen fallback. */}
    }
    function open(id){
      // Cached launch hints are bound to the current actor. Backend authorization
      // still guards every frame and data request, including revoked grants.
      if(identity()!==actor){void synchronize();return false;}
      const item=items.find(v=>v.id===id);if(!item)return false;
      const replacing=Boolean(frame),openingButton=opener||doc.activeElement;
      exit({history:false,notify:false});opener=openingButton;
      const state={...(win.history.state||{}),gpPrivateWorkspace:id};
      win.history[replacing?'replaceState':'pushState'](state,'',win.location.href);
      previousOverflow=doc.documentElement.style.overflow;doc.documentElement.style.overflow='hidden';
      const value=doc.createElement('iframe');value.dataset.workspaceId=id;value.title=item.title;value.setAttribute('referrerpolicy','no-referrer');
      if(item.camera)value.setAttribute('allow',"camera 'self'; fullscreen 'self'");
      value.addEventListener('load',()=>{if(frame===value)activate();});
      // Initial URL before insertion avoids an about:blank navigation in the
      // joint iframe/browser history. Module switches replace the single visit.
      value.src=item.url;frame=value;host.append(value);host.hidden=false;viewport();close.focus({preventScroll:true});
      capture(item);timer=win.setInterval(()=>void synchronize(),15000);void synchronize();return true;
    }
    function onMessage(event){
      if(event.origin!==win.location.origin||!frame||event.source!==frame.contentWindow)return;
      if(event.data?.type==='gp-private-workspace-ready')activate();
      if(event.data?.type==='gp-private-workspace-photo-received'&&event.data.id===photo?.id)photo=null;
      if(event.data?.type==='gp-private-workspace-exit')exit();
      if(event.data?.type==='gp-private-workspace-navigate')open(String(event.data.id||''));
    }
    const onBack=()=>{exit({history:false});clearVisit();},onLeave=()=>exit({history:false,notify:false}),onClose=()=>exit();
    win.addEventListener('message',onMessage);win.addEventListener('popstate',onBack);close.addEventListener('click',onClose);win.addEventListener('pagehide',onLeave);win.addEventListener('resize',viewport);win.visualViewport?.addEventListener('resize',viewport);win.visualViewport?.addEventListener('scroll',viewport);
    const observer=win.ResizeObserver?new win.ResizeObserver(viewport):null;observer?.observe(doc.body);
    return {synchronize,open,exit,get launches(){return items.filter(v=>v.launch&&typeof v.launch.label==='string'&&v.launch.label.length<=40&&/^#[a-f0-9]{6}$/i.test(v.launch.color));},dispose(){generation++;exit();observer?.disconnect();host.remove();win.removeEventListener('message',onMessage);win.removeEventListener('popstate',onBack);win.removeEventListener('pagehide',onLeave);win.removeEventListener('resize',viewport);win.visualViewport?.removeEventListener('resize',viewport);win.visualViewport?.removeEventListener('scroll',viewport);}};
  }
  root.GpPrivateWorkspaces=Object.freeze({mount});
})(typeof window==='object'?window:globalThis);
