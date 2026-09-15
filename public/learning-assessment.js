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
 function init({api}){
  const dialog=document.createElement('dialog');dialog.className='learning-library-dialog';dialog.setAttribute('aria-label','Prüfungen und Nachweise');document.body.append(dialog);
  let data=null,id='',generation=0,busy=false;
  const endpoint=()=>'/api/portal/v1/personnel-learning/assignments/'+encodeURIComponent(id);
  async function open(assignmentId){id=assignmentId;const gen=++generation;dialog.innerHTML='<p>Prüfungen werden geladen …</p><button type="button" data-close>Schließen</button>';if(!dialog.open)dialog.showModal();try{const loaded=await api(endpoint()+'/assessment');if(gen!==generation)return;data=loaded;render();}catch(error){if(gen===generation)dialog.querySelector('p').textContent=error.message;}}
  function render(){
   const a=data.assessment;
   dialog.innerHTML=`<header><div><h2>${esc(data.title)}</h2><p>${esc(data.learner)}</p></div><button type="button" data-close aria-label="Schließen">×</button></header><h3>Wissenstest</h3>${a?.questions.length?`<p>${data.passed?'Bestanden':`${data.attempts.length} von ${a.maxAttempts} Versuchen verwendet`} · Bestehensgrenze ${a.passingPercent} %</p><form data-exam>${a.questions.map((q,i)=>`<fieldset class="learning-question"><legend>${i+1}. ${esc(q.prompt)}</legend>${q.options.map(o=>`<label class="learning-answer"><input type="radio" name="${esc(q.id)}" value="${esc(o.id)}" required ${data.canAttempt?'':'disabled'}><span>${esc(o.text)}</span></label>`).join('')}</fieldset>`).join('')}${data.canAttempt?'<button type="submit">Antworten abgeben</button>':''}</form>`:'<p>Für diese Fassung ist kein Fragenkatalog hinterlegt. Die fachliche Bewertung erfolgt über den Schulungsabschluss.</p>'}
   ${data.attempts.map((r,i)=>`<p>Versuch ${i+1}: ${r.points}/${r.total} Punkte · ${r.passed?'Bestanden':'Noch nicht bestanden'}</p>`).join('')}
   ${data.canReset&&a?.questions.length&&data.attempts.length?'<button type="button" data-action="reset">Neue Versuche freigeben</button>':''}
   <h3>Dateinachweise</h3><p>${a?.requireEvidence?'Für einen erfolgreichen Abschluss erforderlich.':'Optional zur Dokumentation.'} PDF, PNG oder JPEG, jeweils höchstens 2 MiB.</p>
   ${data.evidence.map(e=>`<div class="learning-evidence"><a href="${endpoint()}/evidence/${encodeURIComponent(e.id)}" download>${esc(e.fileName)}</a>${data.canUpload?`<button type="button" data-action="withdraw" data-id="${esc(e.id)}">Zurücknehmen</button>`:''}</div>`).join('')||'<p>Noch keine Nachweise.</p>'}
   ${data.canUpload?'<label>Nachweis auswählen<input type="file" data-file accept="application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg"></label><button type="button" data-action="upload">Nachweis hochladen</button>':''}
   ${data.canConfirm?`<p><a class="secondary-button" href="${endpoint()}/confirmation.pdf" download>PDF-Bestätigung herunterladen</a></p>`:''}<p role="status" data-status></p><button type="button" data-close>Schließen</button>`;
  }
  async function mutate(path,body){const gen=generation,targetId=id;if(!data||!targetId)return;await api(endpoint()+path,{method:'POST',body:JSON.stringify({...body,expectedReceipt:data.expectedReceipt})});if(gen===generation&&id===targetId)await open(targetId);}
  dialog.addEventListener('click',async event=>{
   if(event.target.closest('[data-close]')){clear();return;}const button=event.target.closest('[data-action]');if(!button||busy)return;busy=true;button.disabled=true;
   try{const action=button.dataset.action;
    if(action==='reset'||action==='withdraw'){const reason=root.prompt('Bitte die Änderung begründen:');if(reason==null)return;await mutate(action==='reset'?'/assessment/reset':`/evidence/${encodeURIComponent(button.dataset.id)}/withdraw`,{reason});}
    if(action==='upload'){const file=dialog.querySelector('[data-file]').files[0];if(!file||file.size>2*1024*1024)throw new Error('Bitte eine Datei bis 2 MiB auswählen.');const gen=generation;const bytes=new Uint8Array(await file.arrayBuffer());if(gen!==generation)return;let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));await mutate('/evidence',{fileName:file.name,data:root.btoa(binary)});}
   }catch(error){const status=dialog.querySelector('[data-status]');if(status)status.textContent=error.message;}finally{busy=false;button.disabled=false;}
  });
  dialog.addEventListener('submit',async event=>{event.preventDefault();if(busy)return;busy=true;try{await mutate('/assessment/attempt',{answers:Object.fromEntries(new FormData(event.target))});}catch(error){const status=dialog.querySelector('[data-status]');if(status)status.textContent=error.message;}finally{busy=false;}});
  function clear(){generation++;id='';data=null;dialog.close();dialog.replaceChildren();}
  document.addEventListener('click',event=>{const button=event.target.closest('[data-learning-proof]');if(button)open(button.dataset.learningProof);});
  return {open,clear};
 }
 root.GrabenplanerLearningAssessment={editor,init};
})(globalThis);
