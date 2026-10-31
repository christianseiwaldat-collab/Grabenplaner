(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.SalesArticleDeferredNotes=api;})(typeof window!=='undefined'?window:globalThis,function(){
 'use strict';
 function create({api,articleNumber,current,onData,onError}){
  let pending=null,loaded=false,destroyed=false;
  return {
   activate(){
    if(destroyed||loaded||!current())return Promise.resolve();
    if(pending)return pending;
    pending=(async()=>{
     try{
      const query=new URLSearchParams({articleNumber,section:'notes'});
      const data=await api('/api/sales/articles/detail?'+query);
      if(destroyed||!current())return;
      if(data?.article?.articleNumber!==articleNumber||!data.article.notes||data.article.notes.deferred)
       throw new Error('Die Bemerkungen passen nicht zum ausgewählten Artikel.');
      loaded=true;onData(data.article.notes);
     }catch(error){if(!destroyed&&current())onError(error);}
     finally{pending=null;}
    })();return pending;
   },
   destroy(){destroyed=true;},
  };
 }
 return {create};
});
