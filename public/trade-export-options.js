(function(host,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(host)host.GrabenplanerTradeExport=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const defaults={stamp:'date-time',position:'before',separator:'-',suffix:''};
 const preferenceKey='trade_insight_pdf_options_v1';
 function options(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['stamp','position','separator','suffix'].includes(k)))throw new TypeError('Invalid export options');
  const value={...defaults,...input};
  if(!['none','date','date-time','date-suffix'].includes(value.stamp)||!['before','after'].includes(value.position)||!['-','_',' '].includes(value.separator)||typeof value.suffix!=='string'||value.suffix.length>40)throw new TypeError('Invalid export options');
  return value;
 }
 function cleanName(value){return String(value||'Einkauf-Bestand').normalize('NFKC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g,'').replace(/\.pdf$/i,'').trim().replace(/^[. ]+|[. ]+$/g,'').slice(0,110)||'Einkauf-Bestand';}
 function filename(name,input={},now=new Date()){
  const config=options(input),parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Vienna',year:'2-digit',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const get=k=>parts.find(v=>v.type===k).value,date=get('year')+get('month')+get('day');
  const block=config.stamp==='none'?'':config.stamp==='date-time'?date+'-'+get('hour')+get('minute'):config.stamp==='date-suffix'?date+(config.suffix.trim()?'-'+cleanName(config.suffix):''):date;
  return (config.position==='before'?[block,cleanName(name)]:[cleanName(name),block]).filter(Boolean).join(config.separator)+'.pdf';
 }
 function mount(root,{api}){
  root.insertAdjacentHTML('beforeend',`<dialog class="trade-export-dialog" data-te="dialog" aria-labelledby="tradeExportTitle"><form data-te="form"><h2 class="trade-export-wide" id="tradeExportTitle">PDF exportieren</h2><label class="trade-export-wide">Dateiname<input name="name" maxlength="110" required></label><label>Zeitblock<select name="stamp" aria-label="Zeitblock"><option value="date-time">JJMMTT-HHMM</option><option value="date">JJMMTT</option><option value="date-suffix">JJMMTT-xxx</option><option value="none">Ohne Zeitblock</option></select></label><label>Anordnung<select name="position" aria-label="Anordnung"><option value="before">Vorne</option><option value="after">Hinten</option></select></label><label>Eigene Ergänzung (xxx)<input name="suffix" maxlength="40" placeholder="z. B. Filiale18"></label><label>Trennzeichen<select name="separator" aria-label="Trennzeichen"><option value="-">Bindestrich (-)</option><option value="_">Unterstrich (_)</option><option value=" ">Leerzeichen</option></select></label><div class="trade-export-preview trade-export-wide"><small>Dateinamenvorschau · Zeit in Wien</small><strong data-te="preview"></strong></div><p class="trade-export-wide">Zeitblock und Anordnung werden für dein Konto gespeichert. Der Dateiname gilt für diesen Export. Die Abfragedauer steht unten auf der letzten PDF-Seite.</p><p class="trade-export-wide" data-te="status" role="status"></p><div class="trade-export-actions trade-export-wide"><button type="button" data-te="close">Schließen</button><button type="submit" data-te="download" class="primary-button">PDF herunterladen</button></div></form></dialog>`);
  const q=k=>root.querySelector('[data-te="'+k+'"]'),form=q('form'),dialog=q('dialog');let saved={...defaults},target=null,generation=0;
  const config=()=>options(Object.fromEntries(['stamp','position','separator','suffix'].map(k=>[k,form.elements[k].value])));
  const preview=()=>{form.elements.suffix.disabled=form.elements.stamp.value!=='date-suffix';q('preview').textContent=filename(form.elements.name.value,config());};
  form.addEventListener('input',preview);form.addEventListener('change',preview);
  q('close').addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>{generation++;q('download').disabled=false;});
  form.addEventListener('submit',async event=>{
   event.preventDefault();if(!target)return;const ticket=generation,name=form.elements.name.value,settings=config(),chosen=target;q('download').disabled=true;
   try{
    q('status').textContent='Exportoptionen werden gespeichert …';saved=await api('export-options',settings);
    let url=chosen.url;
    if(chosen.query){
     q('status').textContent='Ein vollständiger PDF-Ergebnisstand wird am Server erstellt. Er bleibt auch nach dem Schließen unter „Gespeicherte Ergebnisse“ verfügbar.';
     const job=await api('jobs',{kind:chosen.kind,query:chosen.query,title:chosen.title});
     while(ticket===generation){const states=await api('jobs'),state=states.find(v=>v.id===job.id);if(state?.status==='completed'){url='/api/trade-insights/jobs/'+encodeURIComponent(job.id)+'/pdf?sort='+encodeURIComponent(chosen.sort||'')+'&direction='+(chosen.direction||'asc');break;}if(!state||['failed','cancelled'].includes(state.status))throw new Error('Der PDF-Ergebnisstand konnte nicht erstellt werden. Bitte gespeicherte Ergebnisse prüfen.');await new Promise(resolve=>setTimeout(resolve,1500));}
    }
    if(ticket!==generation||!url)return;
    const download=new URL(url,globalThis.location.origin);download.searchParams.set('name',name);for(const [k,v]of Object.entries(settings))download.searchParams.set(k,v);
    const link=root.ownerDocument.createElement('a');link.href=download.pathname+download.search;link.download=filename(name,settings);root.append(link);link.click();link.remove();q('status').textContent='PDF-Download gestartet.';
   }catch(error){if(ticket===generation&&error.name!=='AbortError')q('status').textContent=error.message;}
   finally{if(ticket===generation)q('download').disabled=false;}
  });
  return {async open(value){target=value;const ticket=++generation;q('status').textContent='';q('download').disabled=false;for(const [k,v]of Object.entries(saved))form.elements[k].value=v;form.elements.name.value=value.title||'Einkauf-Bestand';preview();dialog.showModal();try{const value=await api('export-options');if(ticket!==generation)return;saved=options(value);for(const [k,v]of Object.entries(saved))form.elements[k].value=v;preview();}catch(error){if(ticket===generation&&error.name!=='AbortError')q('status').textContent='Die gespeicherten Optionen sind gerade nicht verfügbar. Du kannst sie erneut wählen.';}},close(){generation++;if(dialog.open)dialog.close();},destroy(){this.close();dialog.remove();}};
 }
 return {defaults,options,filename,cleanName,preferenceKey,mount};
});
