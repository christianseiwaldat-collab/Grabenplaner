(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GpPrintWindow=api;
})(typeof window==='object'?window:globalThis,function(){
  'use strict';
  const DEFAULTS=Object.freeze({title:'PDF-Ausgabe',filename:'Auswertung',orientation:'portrait'});
  function filename(value){
    return (String(value??'').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g,'-').replace(/\.pdf$/i,'').trim().replace(/[. ]+$/,'').slice(0,180)||'Auswertung')+'.pdf';
  }
  function normalizeValues(value={},defaults=DEFAULTS){
    return {title:String(value.title??defaults.title??DEFAULTS.title).slice(0,120),
      filename:String(value.filename??value.name??defaults.filename??DEFAULTS.filename).slice(0,100),
      orientation:(value.orientation??defaults.orientation)==='landscape'?'landscape':'portrait'};
  }
  function normalizeCommonFields(value=true){
    const all={title:'editable',filename:'editable',orientation:'editable'};
    if(value===false)return {title:'hidden',filename:'hidden',orientation:'hidden'};
    if(value==='readonly')return {title:'readonly',filename:'readonly',orientation:'readonly'};
    if(value===true||value===undefined)return all;
    if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(key=>!Object.hasOwn(all,key)))throw TypeError('Die gemeinsamen Druckfelder sind ungültig.');
    for(const[key,mode]of Object.entries(value)){
      if(![true,false,'editable','readonly','hidden'].includes(mode))throw TypeError('Die gemeinsamen Druckfelder sind ungültig.');
      all[key]=mode===true?'editable':mode===false?'hidden':mode;
    }
    return all;
  }
  function mount(config={}){
    const doc=config.document||config.host?.ownerDocument||globalThis.document,win=doc?.defaultView;
    if(!doc||!win?.GpWindow||!(win.GpPdfPreview||win.GrabenplanerArticleReportPdfPreview))throw Error('Druckfenster benötigt GP-Fenster und PDF-Vorschau.');
    if(typeof config.createPdf!=='function'||typeof config.key!=='function')throw Error('Druckfenster benötigt PDF-Erstellung und einen Kontoschlüssel.');
    const id=String(config.id||'gp-print'),element=doc.createElement('section');
    element.className='gp-print-window';element.hidden=true;element.dataset.gpWindowManual='';element.dataset.gpPrintId=id;
    element.setAttribute('role','region');element.setAttribute('aria-label',String(config.title||'PDF-Ausgabe'));
    element.innerHTML='<header data-gp-print-title><strong></strong><button type="button" data-gp-print-min aria-label="Druckfenster minimieren">−</button><button type="button" data-gp-print-close aria-label="Druckfenster schließen">×</button></header><div data-gp-print-body><div class="gp-print-grid"><form data-gp-print-form><div class="gp-print-common-options"><label>PDF-Titel<input name="title" maxlength="120" required autocomplete="off"></label><label>Dateiname<input name="filename" maxlength="100" required autocomplete="off"></label><label>A4-Ausrichtung<select name="orientation"><option value="portrait">Hochformat</option><option value="landscape">Querformat</option></select></label></div><div data-gp-print-options></div><p class="gp-print-hint">Vorschau und Download enthalten dieselbe PDF-Datei.</p><button type="submit" class="gp-print-refresh">Vorschau aktualisieren</button></form><section class="gp-print-preview" aria-label="PDF-Layoutvorschau"><div class="gp-print-preview-heading"><strong>Layoutvorschau</strong><span data-gp-print-count></span></div><p data-gp-print-status role="status" aria-live="polite"></p><div data-gp-print-viewer></div></section></div><footer class="gp-print-footer"><span data-gp-print-filename></span><button type="button" data-gp-print-download disabled>PDF herunterladen</button></footer></div>';
    const q=s=>element.querySelector(s),form=q('[data-gp-print-form]'),optionsHost=q('[data-gp-print-options]');
    const footerInfo=doc.createElement('div'),choiceNode=doc.createElement('small');footerInfo.className='gp-print-footer-info';
    choiceNode.dataset.gpPrintSaveStatus='';choiceNode.textContent='Druckauswahl · lokal in dieser Sitzung';
    choiceNode.setAttribute('role','status');choiceNode.setAttribute('aria-live','polite');
    footerInfo.append(q('[data-gp-print-filename]'),choiceNode);q('.gp-print-footer').prepend(footerInfo);
    q('[data-gp-print-title] strong').textContent=String(config.title||'PDF-Ausgabe');
    (config.host||doc.body).append(element);
    let actor=String(config.key()||''),dead=false,opened=false,closing=false,pageEnabled=true,payload=null,target=null,
      serial=0,request=null,timer=null,blob=null,downloadUrl='',signature='',previewTicket=0,ready=false,loading=false,
      pages=0,downloadName='',summary='',error='',cleanupOptions=null;
    const handlers=[],on=(node,type,fn,options)=>{node.addEventListener(type,fn,options);handlers.push(()=>node.removeEventListener(type,fn,options));};
    const defaults=()=>normalizeValues(typeof config.defaults==='function'?config.defaults(payload,actor):config.defaults||DEFAULTS);
    const permitted=()=>!dead&&Boolean(actor)&&String(config.key()||'')===actor&&(config.canUse?.()??true);
    const choiceStatus=win.GpSaveStatus?.create({key:config.key,canUse:permitted,persistence:'session'});
    const unmountChoice=choiceStatus?win.GpSaveStatus.mount(choiceNode,choiceStatus,{prefix:'Druckauswahl · '}):null;
    const active=()=>pageEnabled&&(typeof config.active==='function'?config.active():config.active!==false);
    const usable=()=>permitted()&&active();
    const field=name=>form.elements.namedItem(name);
    const commonFields=normalizeCommonFields(config.commonFields);
    for(const[name,mode]of Object.entries(commonFields)){
      const input=field(name);input.closest('label').hidden=mode==='hidden';
      input.disabled=mode!=='editable';input.required=mode==='editable'&&name!=='orientation';
      if(mode==='readonly')input.setAttribute('aria-readonly','true');
    }
    q('.gp-print-common-options').hidden=Object.values(commonFields).every(mode=>mode==='hidden');
    function values(){return normalizeValues({title:field('title').value,filename:field('filename').value,orientation:field('orientation').value});}
    function options(){return config.readOptions?.(optionsHost,{payload,actor})??{};}
    function snapshot(){return {open:opened&&!closing,active:usable(),loading,ready:ready&&permitted(),values:values(),pages,filename:downloadName,error,signature};}
    function notify(){choiceStatus?.sync();config.onState?.(snapshot());}
    function status(message,isError=false){q('[data-gp-print-status]').textContent=message;q('[data-gp-print-status]').classList.toggle('is-error',isError);error=isError?message:'';}
    function nameLabel(){q('[data-gp-print-filename]').textContent=downloadName||filename(values().filename);}
    function clear(){
      serial++;request?.abort();request=null;win.clearTimeout(timer);timer=null;
      ready=false;loading=false;pages=0;signature='';previewTicket=0;blob=null;summary='';
      if(downloadUrl)win.URL.revokeObjectURL(downloadUrl);downloadUrl='';downloadName='';
      viewer.clear();q('[data-gp-print-count]').textContent='';q('[data-gp-print-download]').disabled=true;
    }
    const viewer=(win.GpPdfPreview||win.GrabenplanerArticleReportPdfPreview).mount(q('[data-gp-print-viewer]'),{
      ready(value){
        if(!permitted()||!opened||closing||!blob||previewTicket!==serial)return;
        pages=value.pages;loading=false;ready=true;
        q('[data-gp-print-count]').textContent=`${pages} ${pages===1?'Seite':'Seiten'}`+(summary?' · '+summary:'');
        q('[data-gp-print-download]').disabled=!usable();status('Vorschau entspricht der PDF-Datei.');notify();
      },
      error(reason){if(permitted()&&opened&&!closing&&previewTicket===serial){loading=false;ready=false;q('[data-gp-print-download]').disabled=true;status('Vorschau konnte nicht dargestellt werden: '+String(reason?.message||reason),true);notify();}}
    });
    const defaultGeometry=()=>config.geometry||{x:180,y:90,width:1060,height:700,minimized:false};
    const trigger=()=>target||(typeof config.trigger==='function'?config.trigger():config.trigger);
    function closed(){opened=false;closing=false;clear();controller.suspend();config.onClose?.();notify();}
    function beginClose(){if(!opened||closing)return;closing=true;clear();notify();}
    on(q('[data-gp-print-close]'),'click',beginClose,true);
    const controller=win.GpWindow.attach(element,{title:q('[data-gp-print-title]'),body:q('[data-gp-print-body]'),toggle:q('[data-gp-print-min]'),closeButton:q('[data-gp-print-close]'),
      minWidth:360,minHeight:280,compactWidth:260,scale:config.scale,initialGeometry:()=>config.windowPreferences?.value.windows[id]||defaultGeometry(),
      active:false,canUse:()=>usable()&&opened,change:geometry=>config.windowPreferences?.change(id,geometry),closeTarget:trigger,onClose:closed});
    const unsubscribe=config.windowPreferences?.subscribe(value=>{if(permitted()){const geometry=value.windows[id];if(geometry)controller.set(geometry);}});
    function setValues(value){const next=normalizeValues(value,defaults());for(const name of ['title','filename','orientation'])field(name).value=next[name];nameLabel();}
    function renderOptions(){
      cleanupOptions?.();cleanupOptions=null;optionsHost.replaceChildren();
      const context={changed,refresh,getValues:values,payload,actor};
      if(typeof config.renderOptions==='function'){
        const result=config.renderOptions(optionsHost,context);
        if(typeof result==='function')cleanupOptions=result;else if(result?.nodeType===1)optionsHost.append(result);
      }else if(config.renderOptions?.nodeType===1)optionsHost.append(config.renderOptions);
    }
    function sync(){
      const current=String(config.key()||'');
      if(current!==actor||!(config.canUse?.()??true)){
        actor=current;opened=false;closing=false;payload=null;target=null;clear();controller.suspend();controller.set(defaultGeometry());
        cleanupOptions?.();cleanupOptions=null;optionsHost.replaceChildren();setValues(defaults());status('');notify();
        return false;
      }
      if(!usable()){clear();controller.suspend();}
      return permitted();
    }
    function formSnapshot(){return {values:values(),options:options()};}
    function token(){return JSON.stringify(formSnapshot());}
    function validation(input){
      if(!form.checkValidity()||['title','filename'].some(name=>commonFields[name]==='editable'&&!input.values[name].trim()))return 'Bitte PDF-Titel und Dateiname ausfüllen.';
      return config.validateOptions?.(input.options,{values:input.values,payload,actor})||'';
    }
    async function refresh(){
      sync();if(!usable()||!opened||closing)return false;
      const input=formSnapshot(),nextSignature=JSON.stringify(input);clear();nameLabel();
      const message=validation(input);if(message){status(String(message),true);notify();return false;}
      const owner=actor,ticket=serial,abort=new win.AbortController();request=abort;loading=true;status('Drucklayout wird berechnet …');notify();
      const valid=()=>!dead&&permitted()&&actor===owner&&ticket===serial&&opened&&!closing&&!abort.signal.aborted;
      try{
        const result=await config.createPdf({values:input.values,options:input.options,payload,actor:owner,signal:abort.signal});
        if(!valid())return false;
        const nextBlob=result?.blob;
        if(!(nextBlob instanceof win.Blob)||nextBlob.type.split(';')[0].trim()!=='application/pdf'||nextBlob.size<5||nextBlob.size>(config.maxBytes||32*1024*1024))throw Error('Die PDF-Ausgabe ist leer oder ungültig.');
        const bytes=await nextBlob.arrayBuffer();if(!valid())return false;
        if(String.fromCharCode(...new Uint8Array(bytes,0,5))!=='%PDF-')throw Error('Die PDF-Ausgabe ist ungültig.');
        blob=nextBlob;downloadName=filename(result.filename||input.values.filename);summary=String(result.summary||'').slice(0,180);
        downloadUrl=win.URL.createObjectURL(blob);signature=nextSignature;previewTicket=ticket;nameLabel();
        status('PDF-Seite wird dargestellt …');await viewer.load(bytes);
        return valid()&&ready;
      }catch(reason){if(valid()){loading=false;status(String(reason?.message||reason),true);notify();}return false;}
      finally{if(request===abort)request=null;}
    }
    function changed(){
      sync();if(!usable()||!opened||closing)return;
      // A blur-triggered change for the already rendered input must leave the
      // download enabled; otherwise the first mouse click loses its target.
      if(signature&&signature===token())return;
      clear();nameLabel();status('Vorschau wird aktualisiert …');notify();
      timer=win.setTimeout(()=>{timer=null;void refresh();},config.debounce??350);
    }
    function open(input={}){
      sync();if(!usable())return false;
      clear();payload=input.payload??null;target=input.target||null;opened=true;closing=false;
      setValues(normalizeValues(input.values||{},defaults()));renderOptions();controller.activate();controller.restore();
      void config.windowPreferences?.activate();(Object.keys(commonFields).map(field).find(input=>!input.disabled)||q('[data-gp-print-close]')).focus({preventScroll:true});void refresh();return true;
    }
    function activate(){pageEnabled=true;sync();if(usable()&&opened&&!closing){controller.activate();q('[data-gp-print-download]').disabled=!ready;if(!blob&&!request)void refresh();}notify();}
    function deactivate(){pageEnabled=false;clear();controller.suspend();q('[data-gp-print-download]').disabled=true;notify();}
    async function close(){if(!opened)return;beginClose();if(usable())await controller.close();else closed();}
    function reset(){opened=false;closing=false;payload=null;target=null;clear();controller.suspend();cleanupOptions?.();cleanupOptions=null;optionsHost.replaceChildren();setValues(defaults());status('');notify();}
    on(form,'submit',event=>{event.preventDefault();void refresh();});on(form,'input',changed);on(form,'change',changed);
    on(q('[data-gp-print-download]'),'click',()=>{
      sync();if(!usable()||!opened||closing||!ready||!downloadUrl||signature!==token())return;
      const anchor=doc.createElement('a');anchor.href=downloadUrl;anchor.download=downloadName;doc.body.append(anchor);anchor.click();anchor.remove();
    });
    setValues(defaults());
    return {element,optionsHost,open,activate,deactivate,close,reset,refresh,sync,
      updateValues(next,{preview=true}={}){sync();if(!permitted())return;setValues({...values(),...next});if(preview)changed();},
      get state(){return snapshot();},
      destroy(){if(dead)return;reset();dead=true;unmountChoice?.();choiceStatus?.dispose();viewer.destroy();controller.destroy();unsubscribe?.();handlers.forEach(remove=>remove());element.remove();}
    };
  }
  return Object.freeze({mount,filename,normalizeValues,normalizeCommonFields});
});
