(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.GpUsbGuidePrint=api;})(typeof window==='object'?window:globalThis,function(){
 'use strict';
 function mount(config){
  const doc=config.document||document,win=doc.defaultView;let source=null;
  const signature=()=>JSON.stringify(config.context());
  const allowed=()=>Boolean(config.canUse()&&(!source||source.signature===signature()));
  const print=win.GpExistingPdfWindow.mount({...config,document:doc,id:'usb-guide-pdf',title:'Erste Schritte als PDF',canUse:allowed,
   commonFields:false,useServerFilename:true,
   request({payload}){
    if(!allowed()||!source||payload.signature!==source.signature)throw Error('Die USB-Vorgaben haben sich geändert. Bitte die Vorschau erneut öffnen.');
    return{url:'/api/usb-provisioning/first-steps.pdf',init:{method:'POST',headers:{'Content-Type':'application/json','X-Grabenplaner-USB-Action':'provisioning'},body:JSON.stringify(payload.body)}};
   }
  });
  const open=print.open;print.open=({target}={})=>{
   if(!config.canUse())return false;
   source={signature:signature(),body:JSON.parse(signature())};
   return open({target,payload:source,values:{title:'Erste Schritte',filename:'Erste-Schritte',orientation:'portrait'}});
  };
  return print;
 }
 return{mount};
});
