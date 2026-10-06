(function(root,factory){
  'use strict';const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.GrabenplanerPriceLabelWorkingDraft=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  const MAX_BYTES=768*1024;
  const plain=value=>value&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
  const exact=(value,keys)=>{if(!plain(value)||Object.keys(value).some(key=>!keys.includes(key))||keys.some(key=>!Object.hasOwn(value,key)))throw new TypeError('Der Arbeitsentwurf ist ungültig.');};
  function text(value,max){if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))throw new TypeError('Der Arbeitsentwurf enthält ungültige Texte.');return value;}
  function normalize(value,normalizeOptions){
    const keys=['schemaVersion','draftId','articleNumbers','priceType','options','filenameOptions','name','library','selectedArticleNumber','paperPage','rawSettings'];
    exact(value,Object.hasOwn(value||{},'project')?[...keys,'project']:keys);
    if(value.schemaVersion!==1||!UUID.test(value.draftId)||!['sales','internet_1','internet_3'].includes(value.priceType)||!Number.isInteger(value.paperPage)||value.paperPage<0||value.paperPage>199)throw new TypeError('Der Arbeitsentwurf ist ungültig.');
    exact(value.library,['mode','templateId','templateVersion','title','visibility','recipients']);
    const library=value.library;
    if(!['defaults','new','template'].includes(library.mode)||typeof library.templateId!=='string'||library.templateId&&!UUID.test(library.templateId)
      ||library.templateVersion!==null&&(!Number.isSafeInteger(library.templateVersion)||library.templateVersion<1)
      ||!['private','branch','selected'].includes(library.visibility)||!Array.isArray(library.recipients)||library.recipients.length>50
      ||library.recipients.some(id=>typeof id!=='string'||!id||id.length>120||/[\u0000-\u001f\u007f]/u.test(id))||new Set(library.recipients).size!==library.recipients.length)throw new TypeError('Die Entwurfsvorlage ist ungültig.');
    exact(value.filenameOptions,['stamp','position','separator','suffix']);
    if(!['none','date','date-time','date-suffix'].includes(value.filenameOptions.stamp)||!['before','after'].includes(value.filenameOptions.position)||!['-','_',' '].includes(value.filenameOptions.separator))throw new TypeError('Die Dateinamenoptionen sind ungültig.');
    const options=normalizeOptions(value.options),rawSettings={};
    if(!plain(value.rawSettings)||Object.keys(value.rawSettings).some(key=>!Object.hasOwn(options,key)||['textBoxes','freeTextBoxes','imageBoxes'].includes(key)))throw new TypeError('Die Eingaben des Entwurfs sind ungültig.');
    for(const [key,input] of Object.entries(value.rawSettings)){
      if(typeof options[key]==='boolean'){if(typeof input!=='boolean')throw new TypeError('Die Entwurfsanzeige ist ungültig.');rawSettings[key]=input;}
      else rawSettings[key]=text(input,Math.max(200,typeof options[key]==='string'?options[key].length:0));
    }
    const result={schemaVersion:1,draftId:value.draftId,articleNumbers:text(value.articleNumbers,12000),priceType:value.priceType,options,
      filenameOptions:{...value.filenameOptions,suffix:text(value.filenameOptions.suffix,40)},name:text(value.name,110),
      library:{...library,title:text(library.title,80),recipients:[...library.recipients]},selectedArticleNumber:text(value.selectedArticleNumber,80),paperPage:value.paperPage,rawSettings};
    if(Object.hasOwn(value,'project')){const Project=typeof module==='object'&&module.exports?require('./sales-price-label-project'):globalThis.GrabenplanerPriceLabelProject;
      if(value.project!==null){exact(value.project,['id','version','data']);if(value.project.id!==''&&!UUID.test(value.project.id)||value.project.version!==null&&(!Number.isSafeInteger(value.project.version)||value.project.version<1)||Boolean(value.project.id)!==Boolean(value.project.version))throw new TypeError('Die Projektkennung ist ungültig.');result.project={id:value.project.id,version:value.project.version,data:Project.normalize(value.project.data,normalizeOptions)};}else result.project=null;}
    if(new TextEncoder().encode(JSON.stringify(result)).length>MAX_BYTES)throw new TypeError('Der Arbeitsentwurf ist zu groß.');
    return result;
  }
  const clone=value=>value===null?null:JSON.parse(JSON.stringify(value));
  function createStore({api,key,canUse=()=>true,normalizeOptions,delay=350,onError=()=>{}}){
    let actor='',epoch=0,loaded=false,revision=0,value=null,baseline=null,read=null,write=null,timer=null,error=null,uncertain=false,lastSent=null;
    const listeners=new Set(),notify=()=>{for(const listener of listeners)listener();},same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
    const current=(owner,ticket)=>canUse()&&key()===owner&&actor===owner&&epoch===ticket;
    const dirty=()=>!same(value,baseline),clearTimer=()=>{if(timer!==null)clearTimeout(timer);timer=null;};
    function invalidate(){epoch++;clearTimer();read?.controller.abort();write?.controller.abort();actor=String(key()||'');loaded=false;revision=0;value=null;baseline=null;read=null;write=null;error=null;uncertain=false;lastSent=null;notify();}
    function sync(){if(actor!==String(key()||''))invalidate();}
    function schedule(){clearTimer();timer=setTimeout(()=>{timer=null;void flush();},delay);}
    async function activate(){
      sync();if(!canUse()||loaded||read)return read?.promise;
      const owner=actor,ticket=epoch,controller=new AbortController(),request={controller};read=request;notify();
      request.promise=(async()=>{try{
        const saved=await api('/api/sales/price-labels/draft',{signal:controller.signal});
        if(controller.signal.aborted||!current(owner,ticket))return false;
        if(!Number.isSafeInteger(saved.revision)||saved.revision<0)throw new Error('Die Entwurfsrevision ist ungültig.');
        revision=saved.revision;value=saved.draft===null?null:normalize(saved.draft,normalizeOptions);baseline=clone(value);loaded=true;error=null;notify();return true;
      }catch(cause){if(!controller.signal.aborted&&current(owner,ticket)){error=cause;notify();onError(cause);}return false;}
      finally{if(read===request)read=null;}})();return request.promise;
    }
    function change(next){sync();if(!loaded||!canUse())return false;value=normalize(next,normalizeOptions);if(!uncertain)error=null;notify();schedule();return true;}
    function flush(){
      sync();clearTimer();if(!loaded||!canUse())return Promise.resolve(false);if(write)return write.promise;if(!dirty())return Promise.resolve(true);
      if(uncertain||error?.status===409)return Promise.resolve(false);
      const owner=actor,ticket=epoch,controller=new AbortController(),request={controller};write=request;notify();
      request.promise=(async()=>{while(current(owner,ticket)&&dirty()){
        const snapshot=clone(value),mutationId=globalThis.crypto.randomUUID();lastSent={snapshot,mutationId,revision};
        try{const saved=await api('/api/sales/price-labels/draft',{method:'PUT',signal:controller.signal,body:JSON.stringify({revision,mutationId,draft:snapshot})});
          if(controller.signal.aborted||!current(owner,ticket))return false;
          if(!Number.isSafeInteger(saved.revision)||saved.revision<=revision||!same(normalize(saved.draft,normalizeOptions),snapshot))throw new Error('Der gespeicherte Entwurf konnte nicht bestätigt werden.');
          revision=saved.revision;baseline=snapshot;error=null;lastSent=null;notify();
        }catch(cause){if(!controller.signal.aborted&&current(owner,ticket)){error=cause;uncertain=true;notify();onError(cause);}return false;}
      }return current(owner,ticket)&&!dirty();})().finally(()=>{if(write===request){write=null;notify();}});return request.promise;
    }
    async function retry(){
      sync();if(!loaded)return activate();if(write)return write.promise;
      const owner=actor,ticket=epoch;
      try{const saved=await api('/api/sales/price-labels/draft');if(!current(owner,ticket))return false;
        const server=saved.draft===null?null:normalize(saved.draft,normalizeOptions);
        if(!Number.isSafeInteger(saved.revision)||saved.revision<revision)throw new Error('Die Entwurfsrevision ist ungültig.');
        const ownAcknowledgment=lastSent&&saved.lastMutationId===lastSent.mutationId&&saved.revision===lastSent.revision+1&&same(server,lastSent.snapshot);
        if(saved.revision!==revision&&!same(server,value)&&!same(server,baseline)&&!ownAcknowledgment){const conflict=new Error('Ein anderes Fenster hat den Entwurf geändert. Deine Eingaben bleiben erhalten. Öffne den gespeicherten Stand oder speichere später eine Projektkopie.');conflict.status=409;throw conflict;}
        revision=saved.revision;baseline=clone(server);error=null;uncertain=false;lastSent=null;notify();return flush();
      }catch(cause){if(current(owner,ticket)){error=cause;uncertain=true;notify();onError(cause);}return false;}
    }
    return {activate,change,flush,retry,invalidate,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},get ready(){sync();return loaded&&canUse();},
      get value(){sync();return clone(value);},get revision(){return revision;},get hasUnsaved(){return loaded&&(dirty()||Boolean(write));},
      get status(){return error?(error.status===409?'conflict':'error'):!loaded?'loading':write?'saving':dirty()?'pending':'saved';},get error(){return error;}};
  }
  return {normalize,createStore,MAX_BYTES,UUID};
});
