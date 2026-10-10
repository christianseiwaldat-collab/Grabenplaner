(function(root,factory){
  'use strict';const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;else root.GpSalesAnalyticsPrint=api;
})(typeof window==='object'?window:globalThis,function(){
  'use strict';
  const charts=[['ranking','Aktuell & Vergleich'],['change','Relative Abweichung'],['absolute_change','Absolute Abweichung'],['share','Anteile'],['pareto','Pareto-Analyse']];
  function selection(value){
    if(!value||typeof value!=='object')return null;
    const metric=String(value.metric||''),horizon=String(value.horizon||'');
    if(!metric||!horizon)return null;
    if(Array.isArray(value.reportIds)&&value.reportIds.length)return {reportIds:value.reportIds.map(String),horizon:'period',metric};
    return value.reportId?{reportId:String(value.reportId),horizon,metric}:null;
  }
  function body(value,options){const selected=selection(value);if(!selected)throw Error('Bitte eine Verkaufsanalyse öffnen.');return {...selected,optionsVersion:1,options};}
  function mount(config){
    const doc=config.document||document,win=doc.defaultView;let captured=null,saveRevision=0;
    const signature=value=>JSON.stringify(selection(value));
    const scope=()=>JSON.stringify(config.context?.()??selection(config.selection()));
    const allowed=()=>Boolean(config.canUse()&&(!captured||scope()===captured.scope));
    function readOptions(host){
      const field=name=>host.querySelector('[name="'+name+'"]');
      return {orientation:field('orientation').value,charts:[...host.querySelectorAll('[name=chart]:checked')].map(n=>n.value),topN:field('topN').value,
        includeKpis:field('includeKpis').checked,includeTable:field('includeTable').checked,filenamePrefix:field('filenamePrefix').value};
    }
    const print=win.GpExistingPdfWindow.mount({...config,id:config.id||'sales-analysis-pdf',title:'Verkaufsanalyse als PDF',commonFields:false,useServerFilename:true,canUse:allowed,
      defaults:{title:'Verkaufsanalyse',filename:'Verkaufsanalyse',orientation:'landscape'},
      renderOptions(host,context){
        const values=config.normalizeOptions(config.options());
        const add=(label,name,type,initial)=>{const row=doc.createElement('label'),input=doc.createElement(type==='select'?'select':'input');input.name=name;
          if(type!=='select')input.type=type;if(type==='checkbox')input.checked=Boolean(initial);else input.value=initial;
          if(type==='checkbox')row.append(input,doc.createTextNode(label));else row.append(doc.createTextNode(label),input);host.append(row);return input;};
        const orientation=add('A4-Ausrichtung','orientation','select',values.orientation);
        for(const[value,label]of [['landscape','Querformat'],['portrait','Hochformat']]){const option=doc.createElement('option');option.value=value;option.textContent=label;orientation.append(option);}orientation.value=values.orientation;
        const top=add('Warengruppen je Diagramm','topN','number',values.topN);top.min='5';top.max='20';top.step='1';top.required=true;
        const list=doc.createElement('fieldset'),legend=doc.createElement('legend');legend.textContent='Diagrammseiten';list.append(legend);host.append(list);
        for(const[id,label]of charts){const row=doc.createElement('label'),input=doc.createElement('input');input.type='checkbox';input.name='chart';input.value=id;input.checked=values.charts.includes(id);row.append(input,doc.createTextNode(label));list.append(row);}
        add('KPI-Übersicht','includeKpis','checkbox',values.includeKpis);add('Detailtabelle','includeTable','checkbox',values.includeTable);
        const name=add('Dateiname-Präfix','filenamePrefix','text',values.filenamePrefix);name.maxLength=64;name.required=true;
        const hint=doc.createElement('p');hint.className='gp-print-hint';hint.textContent='Datum und Dateiendung ergänzt der Export. Die Vorschau speichert keine persönliche Vorgabe.';host.append(hint);
        const reset=doc.createElement('button'),save=doc.createElement('button'),status=doc.createElement('p');
        reset.type=save.type='button';reset.textContent='Standard wiederherstellen';save.textContent='Als persönliche Vorgabe speichern';status.className='gp-print-hint';status.setAttribute('role','status');host.append(reset,save,status);
        const optionSignature=()=>JSON.stringify(config.normalizeOptions(readOptions(host)));
        const onChange=()=>{if(!save.disabled)status.textContent='Geänderte Optionen sind noch nicht als persönliche Vorgabe gespeichert.';};
        const onReset=()=>{const defaults=config.normalizeOptions({});for(const key of ['orientation','topN','filenamePrefix'])host.querySelector('[name="'+key+'"]').value=defaults[key];
          for(const key of ['includeKpis','includeTable'])host.querySelector('[name="'+key+'"]').checked=defaults[key];
          for(const input of host.querySelectorAll('[name=chart]'))input.checked=defaults.charts.includes(input.value);onChange();context.changed();};
        const onSave=async()=>{
          if(!allowed()||save.disabled||!config.saveOptions)return;
          const chosen=readOptions(host);if(!chosen.charts.length){status.textContent='Bitte mindestens eine Diagrammseite wählen.';return;}
          if(!host.closest('form')?.reportValidity())return;
          const submitted=config.normalizeOptions(chosen),submittedJSON=JSON.stringify(submitted),owner=String(config.key()),scopeAtSave=scope(),revision=++saveRevision;
          const current=()=>owner===String(config.key())&&revision===saveRevision&&allowed()&&scopeAtSave===scope();
          save.disabled=true;status.textContent='Persönliche Vorgabe wird gespeichert …';
          try{await config.saveOptions(submitted);if(current())status.textContent=submittedJSON===optionSignature()?'Für dein Konto gespeichert.':'Vorherige Auswahl gespeichert. Die aktuellen Änderungen sind noch nicht gespeichert.';}
          catch(error){if(current())status.textContent='Nicht gespeichert: '+error.message;}
          finally{if(owner===String(config.key())&&revision===saveRevision)save.disabled=false;}
        };
        reset.addEventListener('click',onReset);save.addEventListener('click',onSave);host.addEventListener('input',onChange);host.addEventListener('change',onChange);
        return ()=>{saveRevision++;reset.removeEventListener('click',onReset);save.removeEventListener('click',onSave);host.removeEventListener('input',onChange);host.removeEventListener('change',onChange);};
      },readOptions,validateOptions:options=>options.charts.length?'':'Bitte mindestens eine Diagrammseite wählen.',
      request(input){
        if(!allowed()||input.payload.scope!==scope()||signature(input.payload.selection)!==signature(config.selection()))throw Error('Die Berichtsauswahl hat sich geändert. Bitte die PDF-Ausgabe erneut öffnen.');
        return {url:'/api/sales-analytics/charts.pdf',init:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body(input.payload.selection,config.normalizeOptions(input.options)))}};
      }
    });
    const open=print.open;print.open=({target}={})=>{const selected=selection(config.selection());if(!selected||!config.canUse())return false;
      captured={scope:scope(),selection:selected};return open({target,payload:captured});};
    return print;
  }
  function completedJobRequest(row){
    if(row?.status!=='completed'||row?.format!=='pdf'||!row.id)throw Error('Der PDF-Bericht ist noch nicht verfügbar.');
    return {url:'/api/sales-report-jobs/'+encodeURIComponent(row.id)+'/download'};
  }
  return Object.freeze({mount,selection,body,completedJobRequest});
});
