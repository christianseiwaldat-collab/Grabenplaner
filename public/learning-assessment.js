(function(root){
 "use strict";
 const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
 function editor(host){
  let questions=[];
  host.innerHTML='<details><summary>Wissenstest und Nachweise</summary><div class="learning-library-fields"><label>Bestehensgrenze (%)<input data-pass type="number" min="1" max="100" value="80"></label><label>Versuche je Freigabe<input data-attempts type="number" min="1" max="10" value="3"></label></div><label><input type="checkbox" data-evidence-required> Dateinachweis vor erfolgreichem Abschluss verlangen</label><div data-questions></div><button type="button" data-add-question>Frage hinzufügen</button><p>Je Frage eine richtige Antwort. Ein bestandener Test ersetzt die fachliche Abschlussbewertung nicht.</p></details>';
  const el=s=>host.querySelector(s);
  function sync(){questions=[...el('[data-questions]').children].map(card=>({id:card.dataset.id,prompt:card.querySelector('[data-prompt]').value,points:Number(card.querySelector('[data-points]').value),correctOptionId:card.querySelector('[data-correct]').value,options:[...card.querySelectorAll('[data-option]')].map(o=>({id:o.dataset.option,text:o.value}))}));}
  function render(){el('[data-questions]').innerHTML=questions.map((q,i)=>{
   const options=q.options.length?q.options:[{id:'a',text:''},{id:'b',text:''},{id:'c',text:''},{id:'d',text:''}];
   return `<fieldset class="learning-question" data-id="${esc(q.id)}"><legend>Frage ${i+1}</legend><label>Fragetext<textarea data-prompt maxlength="1000" rows="2">${esc(q.prompt)}</textarea></label><div class="learning-library-fields">${options.map((o,j)=>`<label>Antwort ${j+1}<input data-option="${esc(o.id)}" maxlength="500" value="${esc(o.text)}"></label>`).join('')}<label>Richtige Antwort<select data-correct>${options.map((o,j)=>`<option value="${esc(o.id)}" ${q.correctOptionId===o.id?'selected':''}>Antwort ${j+1}</option>`).join('')}</select></label><label>Punkte<input data-points type="number" min="1" max="10" value="${Number(q.points||1)}"></label></div><button type="button" data-add-answer="${i}" ${options.length>=6?"disabled":""}>Antwort hinzufügen</button><button type="button" data-remove-question="${i}">Frage entfernen</button></fieldset>`;
  }).join('');el('[data-add-question]').disabled=questions.length>=30;}
  host.addEventListener('click',event=>{const addAnswer=event.target.closest('[data-add-answer]');if(addAnswer){sync();const q=questions[Number(addAnswer.dataset.addAnswer)];if(q.options.length<6)q.options.push({id:'a-'+root.crypto.randomUUID(),text:''});render();}const remove=event.target.closest('[data-remove-question]');if(remove){sync();questions.splice(Number(remove.dataset.removeQuestion),1);render();}if(event.target.closest('[data-add-question]')){sync();questions.push({id:'q-'+root.crypto.randomUUID(),prompt:'',points:1,correctOptionId:'a',options:[]});render();}});
  return {set(value){questions=value?.questions?JSON.parse(JSON.stringify(value.questions)):[];el('[data-pass]').value=value?.passingPercent??80;el('[data-attempts]').value=value?.maxAttempts??3;el('[data-evidence-required]').checked=value?.requireEvidence===true;render();},get(){sync();if(!questions.length&&!el('[data-evidence-required]').checked)return null;return {questions:questions.map(q=>({...q,options:q.options.filter(o=>o.text.trim())})),passingPercent:Number(el('[data-pass]').value),maxAttempts:Number(el('[data-attempts]').value),requireEvidence:el('[data-evidence-required]').checked};}};
 }
 function init({api,printPdf}){
  const dialog=document.createElement('dialog');dialog.className='learning-library-dialog';dialog.setAttribute('aria-label','Prüfungen und Nachweise');dialog.setAttribute('data-learning-assessment','');document.body.append(dialog);
  root.GpWindow?.prepare?.(dialog);
  let data=null,id='',generation=0,busy=false,opener=null,sessionContext=null,mutationOwner=null;
  const endpoint=()=>'/api/portal/v1/personnel-learning/assignments/'+encodeURIComponent(id);
  const contextCurrent=context=>!context||root.GpWindow.currentContext(context);
  const capture=()=>({generation,id,data,context:sessionContext});
  const current=(ticket,requireOpen=true)=>ticket.generation===generation&&ticket.id===id&&ticket.data===data&&contextCurrent(ticket.context)&&(!requireOpen||dialog.open);
  async function open(assignmentId,target=null){
   const context=root.GpWindow?.captureContext?.(document);if(!contextCurrent(context))return;
   id=assignmentId;opener=target;data=null;sessionContext=context;busy=false;mutationOwner=null;
   const ticket={generation:++generation,id,data,context},url=endpoint()+'/assessment';
   dialog.innerHTML='<p>Prüfungen werden geladen …</p><button type="button" data-close>Schließen</button>';
   if(!dialog.open)dialog.showModal();
   try{const loaded=await api(url);if(!current(ticket))return;if(loaded?.assignmentId!==ticket.id)throw new Error('Die Prüfung gehört nicht zur geöffneten Schulung.');data=loaded;render();}
   catch(error){if(current(ticket))dialog.querySelector('p').textContent=error.message;}
  }
  function render(){
   const a=data.assessment;
   dialog.innerHTML=`<header><div><h2>${esc(data.title)}</h2><p>${esc(data.learner)}</p></div><button type="button" data-close aria-label="Schließen">×</button></header><h3>Wissenstest</h3>${a?.questions.length?`<p>${data.passed?'Bestanden':`${data.attempts.length} von ${a.maxAttempts} Versuchen verwendet`} · Bestehensgrenze ${a.passingPercent} %</p><form data-exam>${a.questions.map((q,i)=>`<fieldset class="learning-question"><legend>${i+1}. ${esc(q.prompt)}</legend>${q.options.map(o=>`<label class="learning-answer"><input type="radio" name="${esc(q.id)}" value="${esc(o.id)}" required ${data.canAttempt?'':'disabled'}><span>${esc(o.text)}</span></label>`).join('')}</fieldset>`).join('')}${data.canAttempt?'<button type="submit">Antworten abgeben</button>':''}</form>`:'<p>Für diese Fassung ist kein Fragenkatalog hinterlegt. Die fachliche Bewertung erfolgt über den Schulungsabschluss.</p>'}
   ${data.attempts.map((r,i)=>`<p>Versuch ${i+1}: ${r.points}/${r.total} Punkte · ${r.passed?'Bestanden':'Noch nicht bestanden'}</p>`).join('')}
   ${data.canReset&&a?.questions.length&&data.attempts.length?'<button type="button" data-action="reset">Neue Versuche freigeben</button>':''}
   <h3>Dateinachweise</h3><p>${a?.requireEvidence?'Für einen erfolgreichen Abschluss erforderlich.':'Optional zur Dokumentation.'} PDF, PNG oder JPEG, jeweils höchstens 2 MiB.</p>
   ${data.evidence.map(e=>`<div class="learning-evidence"><a href="${endpoint()}/evidence/${encodeURIComponent(e.id)}" download>${esc(e.fileName)}</a>${data.canUpload?`<button type="button" data-action="withdraw" data-id="${esc(e.id)}">Zurücknehmen</button>`:''}</div>`).join('')||'<p>Noch keine Nachweise.</p>'}
   ${data.canUpload?'<label>Nachweis auswählen<input type="file" data-file accept="application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg"></label><button type="button" data-action="upload">Nachweis hochladen</button>':''}
   ${data.canConfirm?`<p><a class="secondary-button" data-learning-confirmation-pdf href="${endpoint()}/confirmation.pdf" download>PDF-Bestätigung herunterladen</a></p>`:''}<p role="status" data-status></p><button type="button" data-close>Schließen</button>`;
  }
  async function mutate(ticket,path,body){
   if(!ticket.data||!ticket.id||!current(ticket))return;
   const target=opener,url=endpoint()+path,payload={...body,expectedReceipt:ticket.data.expectedReceipt};
   await api(url,{method:'POST',body:JSON.stringify(payload)});
   if(current(ticket))await open(ticket.id,target);
  }
  function beginMutation(){
   const ticket=capture();if(busy||!current(ticket))return null;
   const owner=Symbol('learning-assessment-mutation');mutationOwner=owner;busy=true;
   const fields=[...(dialog.querySelectorAll?.('input,select,textarea,[data-action],[type="submit"]')||[])].map(field=>({field,disabled:field.disabled}));
   for(const entry of fields)entry.field.disabled=true;
   return {ticket,owner,fields};
  }
  function endMutation(operation){
   if(mutationOwner!==operation.owner||!current(operation.ticket))return;
   busy=false;mutationOwner=null;for(const entry of operation.fields)entry.field.disabled=entry.disabled;
  }
  function mutationError(operation,error){
   if(!current(operation.ticket))return;const status=dialog.querySelector('[data-status]');if(status)status.textContent=error.message;
  }
  dialog.addEventListener('click',async event=>{
   const confirmation=event.target.closest('[data-learning-confirmation-pdf]');
   if(confirmation&&typeof printPdf==='function'){
    if(event.defaultPrevented||event.button>0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
    event.preventDefault();if(busy||!data?.canConfirm||!id)return;
    const ticket=capture(),receipt=JSON.stringify(data.expectedReceipt??null);
    const canUse=()=>current(ticket,false)&&data?.canConfirm===true&&JSON.stringify(data.expectedReceipt??null)===receipt;
    const target=opener?.isConnected&&(!opener.getClientRects||opener.getClientRects().length>0)?opener:null;
    const url=endpoint()+'/confirmation.pdf',title='Schulungsbestätigung';
    dialog.close();
    try{const opened=await printPdf({url,title,target,canUse,onClose(){if(canUse()&&!dialog.open)dialog.showModal();},onDiscard(){if(canUse())clear();}});if(opened===false&&canUse()&&!dialog.open)dialog.showModal();}
    catch(error){if(canUse()){if(!dialog.open)dialog.showModal();const status=dialog.querySelector('[data-status]');if(status)status.textContent=error.message||'Die PDF-Vorschau konnte nicht geöffnet werden.';}}
    return;
   }
   if(event.target.closest('[data-close]')){clear();return;}
   const button=event.target.closest('[data-action]');if(!button)return;
   const action=button.dataset.action;if((action==='reset'&&!data?.canReset)||(['upload','withdraw'].includes(action)&&!data?.canUpload))return;
   const operation=beginMutation();if(!operation)return;
   try{
    if(action==='reset'||action==='withdraw'){const reason=root.prompt('Bitte die Änderung begründen:');if(reason==null)return;await mutate(operation.ticket,action==='reset'?'/assessment/reset':`/evidence/${encodeURIComponent(button.dataset.id)}/withdraw`,{reason});}
    if(action==='upload'){const file=dialog.querySelector('[data-file]').files[0];if(!file||file.size>2*1024*1024)throw new Error('Bitte eine Datei bis 2 MiB auswählen.');const bytes=new Uint8Array(await file.arrayBuffer());if(!current(operation.ticket))return;let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));await mutate(operation.ticket,'/evidence',{fileName:file.name,data:root.btoa(binary)});}
   }catch(error){mutationError(operation,error);}finally{endMutation(operation);}
  });
  dialog.addEventListener('submit',async event=>{
   event.preventDefault();if(!data?.canAttempt)return;
   const answers=Object.fromEntries(new FormData(event.target)),operation=beginMutation();if(!operation)return;
   try{await mutate(operation.ticket,'/assessment/attempt',{answers});}catch(error){mutationError(operation,error);}finally{endMutation(operation);}
  });
  function clear(){generation++;id='';data=null;opener=null;sessionContext=null;busy=false;mutationOwner=null;dialog.close();dialog.replaceChildren();}
  dialog.addEventListener('cancel',()=>clear());
  document.addEventListener('click',event=>{const button=event.target.closest('[data-learning-proof]');if(button)open(button.dataset.learningProof,button);});
  return {open,clear};
 }
 root.GrabenplanerLearningAssessment={editor,init};
})(globalThis);
