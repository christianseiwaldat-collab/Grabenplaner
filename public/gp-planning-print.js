(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.GpPlanningPrint=api;})(typeof window==='object'?window:globalThis,function(){
 'use strict';
 const copy=value=>JSON.parse(JSON.stringify(value));
 // The current page controls visibility, while the source controls authority.
 const signature=value=>JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key])=>key!=='page')));
 function request(kind,context,options={}){
  if(!['schedule','vacation'].includes(kind))throw Error('Die Planungsausgabe ist ungültig.');
  const query=new URLSearchParams(context.query||{});
  if(kind==='schedule'){
   if(!context.designs?.some(design=>design.id===options.design))throw Error('Bitte ein gespeichertes aktives Dienstplan-Design wählen.');
   query.set('design',options.design);if(context.departmentId){query.delete('department');query.set('departmentId',context.departmentId);}
  }
  return{url:(kind==='schedule'?'/api/schedule.pdf':'/api/vacations.pdf')+'?'+query.toString()};
 }
 function mount(config){
  const doc=config.document||document,win=doc.defaultView,kind=config.kind;let captured=null;
  const allowed=()=>Boolean(config.canUse()&&(!captured||signature(config.context())===captured.sourceSignature));
  const active=()=>Boolean(captured&&config.context().page===captured.page);
  const print=win.GpExistingPdfWindow.mount({...config,document:doc,id:kind==='schedule'?'schedule-pdf':'vacation-pdf',title:kind==='schedule'?'Dienstplan als PDF':'Urlaubsplanung als PDF',canUse:allowed,active,
   commonFields:{title:'readonly',filename:true,orientation:false},
   useServerFilename:input=>input.values.filename===input.payload.defaultFilename,
   renderOptions(host,{payload}){
    if(kind==='schedule'){
     const label=doc.createElement('label'),select=doc.createElement('select');select.name='design';label.append(doc.createTextNode('Dienstplan-Design'),select);
     for(const[index,design]of payload.context.designs.entries()){const option=doc.createElement('option');option.value=design.id;option.textContent='Rang '+(index+1)+' · '+design.label;select.append(option);}select.value=payload.design;host.append(label);
    }
    const settings=payload.context.settings,details=doc.createElement('p');details.className='gp-print-hint';
    details.textContent=kind==='schedule'?'Zeitachse und Wochenmatrix verwenden die gespeicherten Schrift-, Farb-, Detail- und Bereichsvorgaben.':'Papier: '+(settings.vacation_pdf_size||'A4')+' · Kalender: '+(settings.vacation_pdf_calendar_style==='dots'?'Punkte':'Balken')+' · Urlaubssaldo: '+(settings.vacation_pdf_show_balance==='0'?'ausgeblendet':'eingeblendet');
    const note=doc.createElement('p');note.className='gp-print-hint';note.textContent='Die Vorschau verwendet die gespeicherten PDF-Vorgaben. Geänderte Grundeinstellungen vorher mit „Einstellungen speichern“ übernehmen.';host.append(details,note);
   },
   readOptions:host=>kind==='schedule'?{design:host.querySelector('[name=design]').value}:{},
   validateOptions:options=>kind==='schedule'&&!captured.context.designs.some(design=>design.id===options.design)?'Bitte ein gespeichertes aktives Dienstplan-Design wählen.':'',
   request(input){if(!allowed()||!active()||input.payload.sourceSignature!==signature(config.context()))throw Error('Der Planungsstand hat sich geändert. Bitte die PDF-Ausgabe erneut öffnen.');return request(kind,input.payload.context,input.options);}
  });
  const open=print.open;print.open=({target,design,departmentId}={})=>{
   const source=config.context();if(!config.canUse())return false;
   const context=copy(source);if(departmentId)context.departmentId=String(departmentId);
   const settings=context.settings,title=kind==='schedule'?settings.pdf_title||'Dienstplan':settings.vacation_pdf_title||'Urlaubsplanung';
   const defaultFilename=kind==='schedule'?settings.pdf_filename_prefix||title:settings.vacation_pdf_filename_prefix||title;
   captured={context,page:source.page,sourceSignature:signature(source),design:design||context.designs?.[0]?.id,defaultFilename};
   if(kind==='schedule')request(kind,context,{design:captured.design});
   return open({target,payload:captured,values:{title,filename:defaultFilename,orientation:'landscape'}});
  };
  return print;
 }
 return{mount,request};
});
