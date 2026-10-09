(function(host,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(host)host.GrabenplanerBwlPrint=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 function mount(workspace,{document:doc,rawApi}){
  const win=doc.defaultView;if(!win.GpPrintWindow||typeof rawApi!=='function')return null;
  const context=()=>workspace.printContext(),allowed=()=>{const c=context(),s=workspace.state();return c.valid()&&!!c.exportToken&&!s.dirty&&!s.running;};
  const initial=context(),trigger=initial.trigger;
  const print=win.GpPrintWindow.mount({document:doc,id:'bwl-abc-pdf',title:'ABC-Analyse als PDF',key:initial.key,canUse:allowed,active:()=>context().active(),windowPreferences:initial.windowPreferences,scale:initial.scale,trigger:()=>trigger,
   defaults:{title:'ABC-Analyse',filename:'ABC-Analyse',orientation:'landscape'},
   renderOptions(host,{payload}){
    const details=doc.createElement('details'),title=doc.createElement('summary'),choices=doc.createElement('div');details.open=true;title.textContent='Spalten im PDF';
    const ordered=[...payload.columns].sort((a,b)=>{const x=payload.selected.indexOf(a.id),y=payload.selected.indexOf(b.id);return(x<0?1000:x)-(y<0?1000:y);});
    for(const column of ordered){const label=doc.createElement('label'),input=doc.createElement('input');input.type='checkbox';input.value=column.id;input.checked=payload.selected.includes(column.id);label.append(input,doc.createTextNode(column.label));choices.append(label);}
    const note=doc.createElement('p');note.className='gp-print-hint';note.textContent='Alle Ergebniszeilen werden exportiert. Die gespeicherte Rangfolge und Prüfhinweise bleiben nachvollziehbar.';details.append(title,choices);host.append(details,note);
   },
   readOptions:host=>({columns:[...host.querySelectorAll('input:checked')].map(n=>n.value)}),
   validateOptions:options=>options.columns.length?'':'Bitte mindestens eine Spalte wählen.',
   async createPdf({values,options,payload,signal}){
    if(!allowed()||payload.exportToken!==context().exportToken)throw Error('Bitte die ABC-Auswertung erneut öffnen.');
    const body={exportToken:payload.exportToken,title:values.title.trim(),name:values.filename.trim(),orientation:values.orientation,columns:options.columns,sort:payload.sort,direction:payload.direction};
    const response=await rawApi('/api/sales/bwl/abc/pdf-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
    if(!response.ok){let message='PDF-Ausgabe konnte nicht erstellt werden.';try{message=(await response.json()).error||message;}catch{}throw Error(message);}
    if(!allowed()||payload.exportToken!==context().exportToken)throw Error('Die Auswertung wurde zwischenzeitlich verändert.');
    return{blob:await response.blob(),filename:values.filename,summary:(response.headers.get('X-Report-Rows')||payload.rows)+' Zeilen'};
   }
  });
  const open=()=>{const c=context();if(!allowed()||!c.active())return;print.open({target:trigger,payload:{exportToken:c.exportToken,columns:c.columns.map(v=>({...v})),selected:[...c.selected],sort:c.sort,direction:c.direction,rows:c.snapshot.rows.length}});};
  trigger.addEventListener('click',open);workspace.installPrint(print);workspace.showPrintButton();
  return print;
 }
 return{mount};
});
