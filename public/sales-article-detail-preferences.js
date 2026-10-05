(function(root,factory) {
  const value=factory(typeof module==='object' && module.exports ? require('./table-layout') : root.GrabenplanerTableLayout);
  if(typeof module==='object' && module.exports) module.exports=value;
  else root.SalesArticleDetailPreferences=value;
})(typeof window==='object' ? window : this,function(widths) {
  'use strict';
  const PREFERENCE_KEY='sales_article_detail_v1';
  const COLUMNS=Object.freeze([{id:'branch',label:'Filiale',width:100},{id:'quantity',label:'Bestand',width:90},{id:'ordered',label:'Bestellt',width:100}].map(Object.freeze));
  const ids=COLUMNS.map(c=>c.id);
  function defaults() {return {version:1,hiddenBranchIds:[],columns:[...ids],columnWidths:{},sort:'branch',direction:'asc'};}
  function normalize(input) {
    const fields=Object.keys(defaults());
    if(!input || typeof input!=='object' || Array.isArray(input)
      || Object.keys(input).some(key=>!fields.includes(key)) || fields.some(key=>!Object.hasOwn(input,key))
      || input.version!==1 || !Array.isArray(input.hiddenBranchIds) || input.hiddenBranchIds.length>500
      || input.hiddenBranchIds.some(id=>typeof id!=='string' || !id || id.length>80 || id.trim()!==id || /[\u0000-\u001f\u007f]/.test(id))
      || new Set(input.hiddenBranchIds).size!==input.hiddenBranchIds.length
      || !Array.isArray(input.columns) || input.columns.length<1 || input.columns.length>ids.length
      || input.columns.some(id=>!ids.includes(id)) || new Set(input.columns).size!==input.columns.length
      || !widths.valid(input.columnWidths,ids) || !input.columns.includes(input.sort) || !['asc','desc'].includes(input.direction)) {
      throw new TypeError('Die Einstellungen für den Filialbestand sind ungültig.');
    }
    return {version:1,hiddenBranchIds:[...input.hiddenBranchIds],columns:[...input.columns],columnWidths:{...input.columnWidths},sort:input.sort,direction:input.direction};
  }
  // Load the account's baseline before accepting complete preference snapshots.
  // Keep that baseline across article selections; stale account reads cannot apply.
  function createStore(options) {
    let value=defaults(),actor='',epoch=0,revision=0,loaded=false,failed=false,read=null,write=null,chain=Promise.resolve();
    const listeners=new Set(), notify=()=>{for(const listener of listeners) listener();};
    const current=(key,ticket)=>options.canUse() && actor===key && options.key()===key && epoch===ticket;
    function invalidate() {
      epoch++;revision++;loaded=false;failed=false;read?.controller.abort();write?.abort();read=null;write=null;
      actor=String(options.key() || '');value=defaults();notify();
    }
    function synchronize() {if(actor!==String(options.key() || '')) invalidate();}
    async function activate({retry=false}={}) {
      synchronize();if(!options.canUse() || loaded || read || (failed && !retry)) return read?.promise;
      failed=false;
      const key=actor,ticket=epoch,version=revision,controller=new AbortController(),request={controller};read=request;
      notify();
      request.promise=(async()=>{
        try {
          const payload=await options.api('/api/sales/articles/detail-preferences',{signal:controller.signal});
          if(controller.signal.aborted || !current(key,ticket) || version!==revision) return;
          const {configured,...input}=payload;
          value=normalize(input);loaded=true;notify();
        } catch(error) {if(!controller.signal.aborted && current(key,ticket) && version===revision) {failed=true;notify();options.error(error);}}
        finally {if(read===request) read=null;}
      })();return request.promise;
    }
    function change(next,{publish=true}={}) {
      synchronize();if(!options.canUse() || !loaded) return false;
      const normalized=normalize(next);
      revision++;loaded=true;read?.controller.abort();read=null;value=normalized;
      if(publish) notify();
      return true;
    }
    function save() {
      synchronize();if(!options.canUse() || !loaded) return Promise.resolve(false);
      const key=actor,ticket=epoch,body=JSON.stringify(value);
      chain=chain.catch(()=>{}).then(async()=>{
        if(!current(key,ticket)) return false;
        const controller=new AbortController();write=controller;
        try {await options.api('/api/sales/articles/detail-preferences',{method:'PUT',body,signal:controller.signal});return current(key,ticket);}
        catch(error) {if(!controller.signal.aborted && current(key,ticket)) options.error(error);return false;}
        finally {if(write===controller) write=null;}
      });return chain;
    }
    return {activate,change,save,invalidate,get value(){return normalize(value);},
      get ready(){return loaded && options.canUse() && actor===String(options.key() || '');},
      get failed(){return failed && actor===String(options.key() || '');},
      subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);}};
  }
  return Object.freeze({PREFERENCE_KEY,COLUMNS,defaults,normalize,createStore});
});
