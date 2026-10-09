(function(host,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(host)host.GrabenplanerBwlSimulationPrint=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 function mount(workspace,{document:doc,rawApi}){
  const win=doc.defaultView;if(!win.GpPrintWindow||typeof rawApi!=='function')return null;
  const context=()=>workspace.printContext(),allowed=()=>{const c=context();return c.valid()&&!!c.snapshot&&!c.dirty&&!c.running&&!c.busy&&!!(c.snapshotToken||c.currentVariant);};
  const selector=c=>({...c.snapshotToken?{snapshotToken:c.snapshotToken}:{variantId:c.currentVariant.id,version:c.currentVariant.version},...(c.comparison?{comparisonVariantId:c.comparison.id,comparisonVersion:c.comparison.version}:{})});
  const signature=c=>JSON.stringify(selector(c));
  const initial=context(),trigger=initial.trigger;
  const print=win.GpPrintWindow.mount({document:doc,id:'bwl-simulation-pdf',title:'Abverkaufs-Simulation als PDF',key:initial.key,canUse:allowed,active:()=>context().active(),windowPreferences:initial.windowPreferences,scale:initial.scale,trigger:()=>trigger,
   defaults:{title:'Abverkaufs-Simulation',filename:'Abverkaufs-Simulation',orientation:'landscape'},
   renderOptions(host,{payload}){
    const details=doc.createElement('details'),title=doc.createElement('summary'),choices=doc.createElement('div');details.open=true;title.textContent='Spalten im PDF';
    const ordered=[...payload.columns].sort((a,b)=>{const x=payload.selected.indexOf(a.id),y=payload.selected.indexOf(b.id);return(x<0?1000:x)-(y<0?1000:y);});
    for(const column of ordered){const label=doc.createElement('label'),input=doc.createElement('input');input.type='checkbox';input.value=column.id;input.checked=payload.selected.includes(column.id);label.append(input,doc.createTextNode(column.label));choices.append(label);}
    const note=doc.createElement('p');note.className='gp-print-hint';note.textContent='Alle Artikel-Filial-Zeilen, Annahmen und der Datenstand werden exportiert.'+(payload.comparisonName?' Vergleich mit „'+payload.comparisonName+'“ ist enthalten.':'');details.append(title,choices);host.append(details,note);
   },
   readOptions:host=>({columns:[...host.querySelectorAll('input:checked')].map(n=>n.value)}),validateOptions:options=>options.columns.length>=1&&options.columns.length<=8?'':'Bitte zwischen einer und acht Spalten wählen.',
   async createPdf({values,options,payload,signal}){
    if(!allowed()||payload.signature!==signature(context()))throw Error('Das Szenario wurde verändert. Bitte das Druckfenster erneut öffnen.');
    const body={...payload.selector,title:values.title.trim(),name:values.filename.trim(),orientation:values.orientation,columns:options.columns,sort:payload.sort,direction:payload.direction};
    const response=await rawApi('/api/sales/bwl/simulation/pdf-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
    if(!response.ok){let message='Die Simulation konnte nicht als PDF erstellt werden.';try{message=(await response.json()).error||message;}catch{}throw Error(message);}
    if(!allowed()||payload.signature!==signature(context()))throw Error('Das Szenario wurde zwischenzeitlich verändert.');
    return{blob:await response.blob(),filename:values.filename,summary:(response.headers.get('X-Report-Rows')||payload.rows)+' Zeilen'+(payload.comparisonName?' · Variantenvergleich':'')};
   }
  });
  trigger.addEventListener('click',()=>{const c=context();if(!allowed()||!c.active())return;print.open({target:trigger,values:{title:c.currentVariant&&!c.snapshotToken?c.currentVariant.name:'Abverkaufs-Simulation',filename:c.currentVariant&&!c.snapshotToken?c.currentVariant.name:'Abverkaufs-Simulation',orientation:'landscape'},payload:{selector:selector(c),signature:signature(c),columns:c.columns.map(v=>({...v})),selected:c.selected.filter(id=>c.columns.some(column=>column.id===id)),sort:c.sort,direction:c.direction,rows:c.snapshot.rows.length,comparisonName:c.comparison?.name||''}});});
  workspace.installPrint(print);return print;
 }
 return{mount};
});
