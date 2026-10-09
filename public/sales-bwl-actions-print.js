(function(host,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(host)host.GrabenplanerBwlActionsPrint=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 function mount(workspace,{document:doc,rawApi}){
  const win=doc.defaultView;if(!win.GpPrintWindow||typeof rawApi!=='function')return null;
  const context=()=>workspace.printContext(),allowed=()=>{const c=context();return c.valid()&&!!c.query&&!c.loading&&!c.busy&&c.total>0;};
  const selector=c=>Object.fromEntries(['locationId','status','query','sort','direction'].map(id=>[id,c.query[id]]));
  const signature=c=>JSON.stringify([selector(c),c.total,c.rows.map(r=>[r.id,r.version])]);
  const initial=context(),trigger=initial.trigger;
  const print=win.GpPrintWindow.mount({document:doc,id:'bwl-actions-pdf',title:'Maßnahmenliste als PDF',key:initial.key,canUse:allowed,active:()=>context().active(),windowPreferences:initial.windowPreferences,scale:initial.scale,trigger:()=>trigger,
   defaults:{title:'Maßnahmenliste',filename:'Massnahmenliste',orientation:'landscape'},
   renderOptions(host,{payload}){
    const details=doc.createElement('details'),title=doc.createElement('summary'),choices=doc.createElement('div');details.open=true;title.textContent='Spalten im PDF';
    const ordered=[...payload.columns].sort((a,b)=>{const x=payload.selected.indexOf(a.id),y=payload.selected.indexOf(b.id);return(x<0?1000:x)-(y<0?1000:y);});
    for(const column of ordered){const label=doc.createElement('label'),input=doc.createElement('input');input.type='checkbox';input.value=column.id;input.checked=payload.selected.includes(column.id);label.append(input,doc.createTextNode(column.label));choices.append(label);}
    const note=doc.createElement('p');note.className='gp-print-hint';note.textContent='Exportiert werden alle Maßnahmen der zuletzt gesuchten Auswahl. Ungespeicherte Entwürfe sind nicht enthalten. Personen werden mit ihrer Personalnummer ausgegeben.';details.append(title,choices);host.append(details,note);
   },
   readOptions:host=>({columns:[...host.querySelectorAll('input:checked')].map(n=>n.value)}),validateOptions:options=>options.columns.length>=1&&options.columns.length<=8?'':'Bitte zwischen einer und acht Spalten wählen.',
   async createPdf({values,options,payload,signal}){
    if(!allowed()||payload.signature!==signature(context()))throw Error('Die Auswahl wurde verändert. Bitte das Druckfenster erneut öffnen.');
    const body={query:payload.query,title:values.title.trim(),name:values.filename.trim(),orientation:values.orientation,columns:options.columns};
    const response=await rawApi('/api/sales/bwl/actions/pdf-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
    if(!response.ok){let message='Die Maßnahmenliste konnte nicht als PDF erstellt werden.';try{message=(await response.json()).error||message;}catch{}throw Error(message);}
    if(!allowed()||payload.signature!==signature(context()))throw Error('Die Auswahl wurde zwischenzeitlich verändert.');
    return {blob:await response.blob(),filename:values.filename,summary:(response.headers.get('X-Report-Rows')||payload.total)+' Maßnahmen'};
   }
  });
  trigger.addEventListener('click',()=>{const c=context();if(!allowed()||!c.active())return;print.open({target:trigger,payload:{query:selector(c),signature:signature(c),total:c.total,columns:c.columns.map(v=>({...v})),selected:[...c.selected]}});});
  workspace.installPrint(print);return print;
 }
 return {mount};
});
