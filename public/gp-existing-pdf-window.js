(function(root,factory){
  'use strict';const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GpExistingPdfWindow=api;
})(typeof window==='object'?window:globalThis,function(){
  'use strict';
  function protectedUrl(value,origin){
    const base=new URL(origin),url=new URL(String(value||''),base);
    if(!value||url.origin!==base.origin||url.username||url.password||url.hash||!url.pathname.startsWith('/api/'))throw Error('Die PDF-Adresse ist ungültig.');
    return url.pathname+url.search;
  }
  function responseName(value){
    const encoded=String(value||'').match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    if(encoded){try{return decodeURIComponent(encoded);}catch{}}
    return String(value||'').match(/filename="([^"]+)"/i)?.[1]||'';
  }
  function current({signal,key,owner,canUse}){
    if(signal?.aborted||!owner||String(key()||'')!==owner||!(canUse?.()??true)){
      const error=Error('Die PDF-Anforderung wurde verworfen.');error.name='AbortError';throw error;
    }
  }
  async function fetchBlob({rawApi,url,init={},origin,signal,key,owner,canUse,maxBytes=32*1024*1024}){
    const authority={signal,key,owner,canUse};current(authority);
    const target=protectedUrl(url,origin),method=String(init.method||'GET').toUpperCase();
    if(!['GET','POST'].includes(method))throw Error('Die PDF-Anfrage ist ungültig.');
    const response=await rawApi(target,{...init,method,signal,credentials:'same-origin',redirect:'error',headers:{Accept:'application/pdf',...(init.headers||{})}});
    current(authority);
    if(!response?.ok){
      let message='Die PDF-Datei konnte nicht geladen werden.';
      try{message=(await response.json()).error||message;}catch{}
      current(authority);const error=Error(message);error.status=response?.status;throw error;
    }
    const blob=await response.blob();current(authority);
    if(blob?.type?.split(';')[0].trim()!=='application/pdf'||blob.size<5||blob.size>maxBytes)throw Error('Die PDF-Ausgabe ist leer oder ungültig.');
    return {blob,filename:responseName(response.headers?.get('Content-Disposition'))};
  }
  function mount(config={}){
    const doc=config.document||config.host?.ownerDocument||globalThis.document,win=doc?.defaultView;
    if(!win?.GpPrintWindow||typeof config.rawApi!=='function'||!config.request||typeof config.key!=='function')throw Error('Die PDF-Vorschau benötigt GP-Druckfenster und eine berechtigte Anfrage.');
    // Existing documents have a fixed title and paper format unless their
    // domain adapter explicitly supplies actual renderer presentation options.
    const commonFields=config.commonFields??{title:'readonly',filename:true,orientation:false};
    return win.GpPrintWindow.mount({...config,document:doc,commonFields,
      async createPdf(input){
        const authority={signal:input.signal,key:config.key,owner:input.actor,canUse:()=>Boolean((config.canUse?.()??true)&&(typeof config.active==='function'?config.active():config.active!==false))};current(authority);
        const request=typeof config.request==='function'?await config.request(input):config.request;current(authority);
        const result=await fetchBlob({rawApi:config.rawApi,url:request.url,init:request.init,origin:win.location.origin,...authority,maxBytes:config.maxBytes});
        return {blob:result.blob,filename:(typeof config.useServerFilename==='function'?config.useServerFilename(input,result):config.useServerFilename)?result.filename:input.values.filename,
          summary:typeof config.summary==='function'?config.summary(input,result):config.summary||''};
      }
    });
  }
  return Object.freeze({mount,fetchBlob,protectedUrl,responseName});
});
