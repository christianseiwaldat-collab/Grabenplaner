(function(host,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(host)host.GrabenplanerTradeTables=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 function normalize(input,allowed){
  const widths=input?.widths||{};
  if(!input||Object.keys(input).some(k=>!['columns','widths'].includes(k))||!Array.isArray(input.columns)||!input.columns.length||new Set(input.columns).size!==input.columns.length||input.columns.some(k=>!allowed.includes(k))||typeof widths!=='object'||Array.isArray(widths)||Object.entries(widths).some(([k,v])=>!allowed.includes(k)||!Number.isInteger(v)||v<80||v>800))throw new TypeError('Invalid table options');
  return {columns:[...input.columns],widths:{...widths}};
 }
 function mount({api,layout=globalThis.GrabenplanerTableLayout}){
  const cached=new Map(),reads=new Map(),instances=new Map(),writes=new Map();let active=true;
  function attach(container,key){
   if(!layout||!container?.ownerDocument)return;
   for(const [id,instance]of instances)if(id===key||instance.container===container){instance.destroy();instances.delete(id);}
   const table=container.querySelector('table');if(!table)return;
   const rows=[...table.rows],cells=rows.map(row=>[...row.cells]);
   const columns=cells[0].map((cell,i)=>{const button=cell.querySelector('[data-sort],[data-job-sort],[data-ah-sort],[data-si-sort],[data-si-position-sort]'),id=button?Object.values(button.dataset)[0]:'actions';return {id,label:button?.textContent.replace(/[↑↓↕]/g,'').trim()||cell.textContent.trim(),index:i,resizable:!!button,width:id==='actions'?190:id==='text'?420:['label','reason','article','description'].includes(id)?280:150};});
   const dataColumns=columns.filter(c=>c.resizable),allowed=dataColumns.map(c=>c.id);if(!allowed.length)return;
   let value=cached.get(key)||{columns:allowed,widths:{}},resize=null,disposed=false;
   const doc=container.ownerDocument,chooser=doc.createElement('details');chooser.className='trade-column-chooser gp-table-layout-controls';chooser.innerHTML='<summary>Spaltenanzeige</summary><div class="trade-column-options"></div><small role="status"></small>';container.before(chooser);
   const box=chooser.querySelector('div'),status=chooser.querySelector('small');
   const save=()=>{cached.set(key,value);const selected={columns:[...value.columns],widths:{...value.widths}};const work=(writes.get(key)||Promise.resolve()).catch(()=>{}).then(()=>api('table-options/'+key,selected)).then(()=>{if(!disposed)status.textContent='Gespeichert.';}).catch(error=>{if(!disposed&&error.name!=='AbortError')status.textContent='Speichern fehlgeschlagen. Bitte erneut versuchen.';});writes.set(key,work);};
   function apply(){
    const visible=columns.filter(c=>!c.resizable||value.columns.includes(c.id));rows.forEach((row,i)=>row.replaceChildren(...visible.map(c=>cells[i][c.index]).filter(Boolean)));
    box.replaceChildren(...dataColumns.map(c=>{const label=doc.createElement('label'),input=doc.createElement('input');input.type='checkbox';input.checked=value.columns.includes(c.id);input.disabled=input.checked&&value.columns.length===1;input.setAttribute('aria-label',c.label+' anzeigen');label.append(input,doc.createTextNode(c.label));input.addEventListener('change',()=>{value={...value,columns:dataColumns.filter(v=>v.id===c.id?input.checked:value.columns.includes(v.id)).map(v=>v.id)};apply();save();});return label;}));
    for(const c of visible.filter(c=>c.resizable)){const th=cells[0][c.index];if(!th.querySelector('[data-gp-column-resize]')){const handle=doc.createElement('button');handle.type='button';handle.className='gp-column-resizer';handle.setAttribute('data-gp-column-resize',c.id);handle.setAttribute('role','slider');handle.setAttribute('aria-label',c.label+' – Spaltenbreite');handle.setAttribute('aria-valuemin','80');handle.setAttribute('aria-valuemax','800');handle.setAttribute('aria-orientation','horizontal');th.append(handle);}}
    resize?.destroy();resize=layout.attach(table,{columns:()=>visible,allowedColumns:()=>allowed,widths:()=>value.widths,canResize:()=>active&&!disposed,change:widths=>{value={...value,widths};},persist:save});
   }
   const instance={container,destroy(){disposed=true;resize?.destroy();chooser.remove();}};instances.set(key,instance);apply();
   let read=reads.get(key);if(!read){read=api('table-options/'+key);reads.set(key,read);read.catch(()=>reads.delete(key));}
   read.then(saved=>{if(disposed||!active||!table.isConnected)return;if(!cached.has(key)){try{value=normalize(saved,allowed);}catch{value={columns:allowed,widths:{}};}cached.set(key,value);apply();}}).catch(error=>{if(!disposed&&error.name!=='AbortError')status.textContent='Gespeicherte Spalten gerade nicht verfügbar.';});
  }
  return {attach,clear(container){for(const [id,instance]of instances)if(instance.container===container){instance.destroy();instances.delete(id);}},suspend(){active=false;for(const v of instances.values())v.destroy();instances.clear();},activate(){active=true;},destroy(){this.suspend();cached.clear();reads.clear();}};
 }
 return {normalize,mount};
});
