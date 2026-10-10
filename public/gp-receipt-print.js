(function(root,factory){
  'use strict';const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;else root.GpReceiptPrint=api;
})(typeof window==='object'?window:globalThis,function(){
  'use strict';
  function ids(value){
    if(!Array.isArray(value)||value.length<1||value.length>50||new Set(value).size!==value.length||value.some(id=>typeof id!=='string'||!id))throw Error('Bitte 1 bis 50 unterschiedliche Belege auswählen.');
    return [...value];
  }
  function mount(config){
    const doc=config.document||document,win=doc.defaultView;let capturedContext=null,lastSelection='';
    const context=()=>String(config.contextKey?.()??'');
    const allowed=()=>Boolean(config.canUse()&&(capturedContext===null||capturedContext===context()));
    const defaultFilename='Beleginformation-keine-Rechnung';
    const print=win.GpExistingPdfWindow.mount({...config,id:config.id||'receipt-information-pdf',title:'Beleginformation als PDF',canUse:allowed,
      defaults:{title:'Beleginformation – keine Rechnung',filename:defaultFilename,orientation:'portrait'},commonFields:{title:'readonly',filename:true,orientation:false},
      useServerFilename:input=>input.values.filename===input.payload.defaultFilename,
      renderOptions(host){const note=doc.createElement('p');note.className='gp-print-hint';note.textContent='Informationsauszug aus dem importierten Kassenstand. Kein Ersatz für den Originalbeleg. Vollständige Belegpositionen werden ausgegeben.';host.append(note);},
      request(input){
        if(!allowed()||input.payload.context!==context())throw Error('Die Belegauswahl hat sich geändert. Bitte die PDF-Ausgabe erneut öffnen.');
        return {url:config.endpoint||'/api/receipt-search/export.pdf',init:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:ids(input.payload.ids)})}};
      },summary:input=>input.payload.ids.length+' ausgewählte Belege/Buchungen'
    });
    const open=print.open;print.open=(value,target)=>{
      const selected=ids(value);if(!config.canUse())return false;
      const nextContext=context(),nextSelection=JSON.stringify([nextContext,selected]);
      if(print.state?.open&&print.state?.loading&&lastSelection===nextSelection)return false;
      capturedContext=nextContext;lastSelection=nextSelection;
      return open({target,payload:{ids:selected,context:capturedContext,defaultFilename}});
    };
    return print;
  }
  return Object.freeze({mount,ids});
});
