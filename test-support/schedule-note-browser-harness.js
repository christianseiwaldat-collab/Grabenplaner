'use strict';
// An isolated loopback fixture for the actual Quill/editor functions and markup.
// It never opens the GP application, a database or a user's browser profile.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');

async function startScheduleNoteBrowserFixture(repoRoot=path.resolve(__dirname,'..')){
 const source=fs.readFileSync(path.join(repoRoot,'public/app.js'),'utf8');
 const html=fs.readFileSync(path.join(repoRoot,'public/index.html'),'utf8');
 const start=source.indexOf('const scheduleNoteMaxLength ='),end=source.indexOf('async function createManualBackup()',start);
 assert.ok(start>=0&&end>start,'Use the exact product note-editor block');
 const block=source.slice(start,end),globals=source.slice(0,start).match(/^let scheduleNote\w*\s*=.*;$/gm)||[];
 const dialogStart=html.lastIndexOf('<dialog',html.indexOf('id="scheduleNoteModal"')),dialogEnd=html.indexOf('</dialog>',dialogStart)+9;
 assert.ok(dialogStart>=0&&dialogEnd>dialogStart,'Use the exact product note-editor markup');
 const dialog=html.slice(dialogStart,dialogEnd);
 const scripts=[...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map(match=>match[1]).filter(name=>/schedule-note/.test(name));
 const styles=[...html.matchAll(/<link\b[^>]*href="([^"]+)"/g)].map(match=>match[1]).filter(name=>/schedule-note/.test(name));
 const bootstrap=`'use strict';
${globals.join('\n')}
const elements=Object.fromEntries([...document.querySelectorAll('[id]')].map(element=>[element.id,element]));
elements.scheduleNoteButtonHint=document.createElement('small');
const state={weekStart:'2026-10-26',locationId:'SYNTHETIC-18',departmentId:'',data:{scheduleNote:null}};
let persisted=null,saveCalls=0;
function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
function guardScheduleEditing(){return false;}
function contextQuery(){return '';}
function showToast(message,error){window.__noteToasts.push({message,error:!!error});}
async function loadAll(){}
async function api(url,options={}){
 if(url==='/api/schedule-note'&&options.method==='PUT'){
  const input=JSON.parse(options.body);saveCalls++;persisted=JSON.parse(JSON.stringify(input));
  state.data.scheduleNote={note_text:input.noteText,note_html:input.noteHtml};return {...state.data.scheduleNote};
 }
 throw Error('Unexpected synthetic API call: '+url+' '+options.method);
}
window.__noteToasts=[];
${block}
window.__note={
 // Let the product's 50ms initial focus handoff complete before a synthetic
 // zero-delay sequence moves focus into a number field or another control.
 async open(){openScheduleNoteModal();await new Promise(resolve=>setTimeout(resolve,75));},
 plain:scheduleNotePlainText,html:scheduleNoteHtml,setHtml:setScheduleNoteHtml,refresh:updateScheduleNoteCounter,
 get editor(){return scheduleNoteQuill;},get persisted(){return persisted;},get state(){return state;},get saveCalls(){return saveCalls;},
 select(index,length){scheduleNoteQuill.focus();scheduleNoteQuill.setSelection(index,length,'user');},
 inspect(index,length){return {range:scheduleNoteQuill.getSelection(),formats:scheduleNoteQuill.getFormat(index,length),delta:scheduleNoteQuill.getContents(index,length)};},
 async save(){await saveScheduleNote({preventDefault(){}});return persisted;}
};
elements.scheduleNoteForm.addEventListener('submit',saveScheduleNote);
document.querySelectorAll('[data-close="scheduleNoteModal"]').forEach(button=>button.addEventListener('click',()=>elements.scheduleNoteModal.close()));
window.__noteReady=true;`;
 const observe="window.__noteViolations=[];window.addEventListener('securitypolicyviolation',event=>window.__noteViolations.push({directive:event.effectiveDirective,blocked:event.blockedURI}));";
 const pageHtml=`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Synthetic schedule note</title><link rel="stylesheet" href="/vendor/quill/quill.snow.css"><link rel="stylesheet" href="/styles.css">${styles.map(name=>`<link rel="stylesheet" href="${name}">`).join('')}<script src="/observe.js"></script></head><body>${dialog}<script src="/vendor/quill/quill.js"></script>${scripts.map(name=>`<script src="${name}"></script>`).join('')}<script src="/harness.js"></script></body></html>`;
 const served=new Set(),errors=[];
 const server=http.createServer((request,response)=>{
  try{
   const name=new URL(request.url,'http://127.0.0.1').pathname;
   // Stronger than the application baseline: point sizes must work from local
   // stylesheet classes even when inline stylesheet declarations are denied.
   response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
   response.setHeader('Cache-Control','no-store');
   const literal={'/':[pageHtml,'text/html; charset=utf-8'],'/harness.js':[bootstrap,'text/javascript; charset=utf-8'],'/observe.js':[observe,'text/javascript; charset=utf-8']}[name];
   if(literal){response.setHeader('Content-Type',literal[1]);response.end(literal[0]);return;}
   const target=name.startsWith('/vendor/quill/')?path.join(repoRoot,'node_modules/quill/dist',path.basename(name)):path.resolve(repoRoot,'public','.'+name);
   assert.ok(target.startsWith(path.resolve(repoRoot,'public')+path.sep)||target.startsWith(path.resolve(repoRoot,'node_modules/quill/dist')+path.sep));
   if(!fs.existsSync(target)||!fs.statSync(target).isFile()){response.statusCode=404;response.end();return;}
   served.add(target);
   response.setHeader('Content-Type',({'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png'})[path.extname(target)]||'application/octet-stream');
   response.end(fs.readFileSync(target));
  }catch(error){errors.push(String(error));response.statusCode=500;response.end('Synthetic fixture error');}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {url:'http://127.0.0.1:'+server.address().port,errors,
  metadata:()=>({editorBlockSha256:digest(block),markupSha256:digest(dialog),servedFiles:[...served].map(file=>({path:file,sha256:digest(fs.readFileSync(file))}))}),
  close:()=>new Promise(resolve=>server.close(resolve))};
}

async function selectWord(page,word){
 return page.evaluate(word=>{const text=__note.editor.getText(),index=text.indexOf(word);if(index<0)throw Error('Missing synthetic word '+word);__note.select(index,word.length);return {index,length:word.length};},word);
}
async function wordStyle(page,word){
 return page.evaluate(word=>{
  const index=__note.editor.getText().indexOf(word);if(index<0)throw Error('Missing synthetic word '+word+' in '+JSON.stringify(__note.editor.getText()));
  // Quill resolves an exact format boundary to the preceding leaf. Inspect an
  // interior code unit while retaining the complete selected range for formats.
  const leaf=__note.editor.getLeaf(index+Math.min(1,word.length-1))[0].domNode,element=leaf.nodeType===3?leaf.parentElement:leaf,style=getComputedStyle(element);
  return {word,index,length:word.length,formats:__note.editor.getFormat(index,word.length),fontSizePx:parseFloat(style.fontSize),
   fontWeight:style.fontWeight,fontStyle:style.fontStyle,underlined:!!element.closest('u'),
   dataSize:element.closest('[data-size]')?.getAttribute('data-size')||null,html:element.outerHTML};
 },word);
}
async function rightClickSelection(page){
 const point=await page.evaluate(()=>{const selection=getSelection();if(!selection.rangeCount)throw Error('No selected DOM range');const rect=selection.getRangeAt(0).getBoundingClientRect();return {x:rect.left+Math.min(10,rect.width/2),y:rect.top+Math.min(8,rect.height/2)};});
 await page.mouse.click(point.x,point.y,{button:'right'});
 await page.locator('#scheduleNoteContextMenu').waitFor({state:'visible'});
}
const assertPoints=(style,points)=>assert.ok(Math.abs(style.fontSizePx-points*96/72)<0.05,`${style.word}: expected ${points}pt, got ${JSON.stringify(style)}`);

async function runScheduleNoteBrowserCases(page){
 const cases=[];
 await page.waitForFunction(()=>window.__noteReady);await page.evaluate(()=>__note.open());
 await page.waitForFunction(()=>window.__note?.editor?.root?.isContentEditable);
 const fixture='<p>Montag 26.10.2026: Nationalfeiertag.</p><p>Donnerstag 29.10.: TAMRON BESUCH.</p><p>Klein Mittel Groß Rücksetzen</p>';
 await page.evaluate(value=>__note.setHtml(value),fixture);
 const text=await page.evaluate(()=>__note.plain());
 const toolbar=page.locator('#scheduleNoteToolbar'),menu=page.locator('#scheduleNoteContextMenu');

 await selectWord(page,'TAMRON BESUCH');
 for(const format of ['bold','italic','underline'])await toolbar.locator(`[data-note-format="${format}"]`).click();
 await page.locator('#scheduleNoteFontSize').fill('12.5');await toolbar.locator('[data-note-size-apply]').click();
 const selected=await wordStyle(page,'TAMRON BESUCH'),neighbor=await wordStyle(page,'Donnerstag');
 assertPoints(selected,12.5);assert.equal(selected.formats.bold,true);assert.equal(selected.formats.italic,true);assert.equal(selected.formats.underline,true);
 assertPoints(neighbor,10);assert.equal(neighbor.formats.bold,undefined);assert.equal(await page.evaluate(()=>__note.plain()),text);
 cases.push({name:'toolbar retains selection across point input and applies only selected text',selected,neighbor});

 await selectWord(page,'Klein');await rightClickSelection(page);
 await page.locator('#scheduleNoteContextFontSize').fill('4');await menu.locator('[data-note-size-apply]').click();
 const small=await wordStyle(page,'Klein');assertPoints(small,4);assert.equal(small.dataSize,'4');
 await page.keyboard.press('Escape');assert.equal(await menu.isVisible(),false);
 await selectWord(page,'Groß');await rightClickSelection(page);
 await page.locator('#scheduleNoteContextFontSize').fill('72');await menu.locator('[data-note-size-apply]').click();
 const large=await wordStyle(page,'Groß');assertPoints(large,72);assert.equal(large.dataSize,'72');
 await page.keyboard.press('Escape');assert.equal(await menu.isVisible(),false);
 cases.push({name:'native right click formats exact selections at both point limits',small,large});

 await selectWord(page,'Mittel');await page.keyboard.press('Shift+F10');await menu.waitFor({state:'visible'});
 await page.keyboard.press('Escape');assert.equal(await menu.isVisible(),false);
 await page.keyboard.press('Control+b');assert.equal((await wordStyle(page,'Mittel')).formats.bold,true);
 await page.keyboard.press('Control+z');assert.equal((await wordStyle(page,'Mittel')).formats.bold,undefined);
 assertPoints(await wordStyle(page,'Groß'),72);assertPoints(await wordStyle(page,'Klein'),4);
 cases.push({name:'keyboard context menu, Escape and undo keep the selected range and prior formatting'});

 await selectWord(page,'Klein');
 for(const value of ['3','73','12.34']){
  await page.locator('#scheduleNoteFontSize').fill(value);await toolbar.locator('[data-note-size-apply]').click();
  assertPoints(await wordStyle(page,'Klein'),4);
  assert.equal(await page.locator('#scheduleNoteFontSize').getAttribute('aria-invalid'),'true');
 }
 await page.locator('#scheduleNoteFontSize').fill('4');await toolbar.locator('[data-note-size-apply]').click();
 cases.push({name:'out of range and overprecision point inputs are rejected without changing selected text'});

 await selectWord(page,'Rücksetzen');await toolbar.locator('[data-note-format="bold"]').click();
 await page.locator('#scheduleNoteFontSize').fill('24');await toolbar.locator('[data-note-size-apply]').click();
 await toolbar.locator('[data-note-format="clear"]').click();
 const cleared=await wordStyle(page,'Rücksetzen');assertPoints(cleared,10);assert.equal(cleared.formats.bold,undefined);assert.equal(cleared.formats.size,undefined);
 cases.push({name:'clear formatting resets the selected text to the documented 10 point default',cleared});

 await selectWord(page,'TAMRON BESUCH');
 const beforeSave=await page.evaluate(()=>({html:__note.html(),text:__note.plain(),delta:__note.editor.getContents()}));
 const persisted=await page.evaluate(()=>__note.save());assert.equal(persisted.noteHtml,beforeSave.html);assert.equal(persisted.noteText,beforeSave.text);
 await page.evaluate(()=>__note.open());
 const reopened=await page.evaluate(()=>({html:__note.html(),text:__note.plain(),delta:__note.editor.getContents()}));
 assert.deepEqual(reopened,beforeSave,'Saving/reopening must retain each exact point size and inline format');
 const sizes=await Promise.all(['Klein','TAMRON BESUCH','Groß'].map(word=>wordStyle(page,word)));
 [4,12.5,72].forEach((points,index)=>assertPoints(sizes[index],points));
 cases.push({name:'synthetic save and reopen preserve exact mixed-format HTML and Delta',styles:sizes});

 const zoomBounds=[];
 for(const zoom of [1.5,2]){
  await page.evaluate(value=>{document.body.style.zoom=String(value);},zoom);
  await selectWord(page,'TAMRON BESUCH');await rightClickSelection(page);
  const bounds=await page.evaluate(()=>{
   const frame=document.getElementById('scheduleNoteEditorFrame').getBoundingClientRect(),menu=document.getElementById('scheduleNoteContextMenu').getBoundingClientRect();
   return {frame:{left:frame.left,right:frame.right,top:frame.top,bottom:frame.bottom},menu:{left:menu.left,right:menu.right,top:menu.top,bottom:menu.bottom}};
  });
  assert.ok(bounds.menu.left>=bounds.frame.left-2&&bounds.menu.right<=bounds.frame.right+2,'Zoomed context menu stays inside horizontal editor bounds: '+JSON.stringify({zoom,...bounds}));
  assert.ok(bounds.menu.top>=bounds.frame.top-2&&bounds.menu.bottom<=bounds.frame.bottom+2,'Zoomed context menu stays inside vertical editor bounds: '+JSON.stringify({zoom,...bounds}));
  await page.locator('#scheduleNoteContextFontSize').fill('12.5');await menu.locator('[data-note-size-apply]').click();
  assertPoints(await wordStyle(page,'TAMRON BESUCH'),12.5);
  zoomBounds.push({zoom,...bounds});await page.keyboard.press('Escape');
 }
 await page.evaluate(()=>{document.body.style.zoom='';});
 cases.push({name:'native context menu stays inside the editor and formats the selection at 150 and 200 percent body zoom',zoomBounds});

 const submitted=[];
 for(const value of ['3','73']){
  await selectWord(page,'Klein');await rightClickSelection(page);
  const prior=await page.evaluate(()=>({html:__note.html(),delta:__note.editor.getContents(),saveCalls:__note.saveCalls}));
  await page.locator('#scheduleNoteContextFontSize').fill(value);await menu.locator('[data-note-size-apply]').click();
  assert.equal(await page.locator('#scheduleNoteContextFontSize').getAttribute('aria-invalid'),'true');
  assert.deepEqual(await page.evaluate(()=>({html:__note.html(),delta:__note.editor.getContents()})),{html:prior.html,delta:prior.delta});
  await page.keyboard.press('Escape');assert.equal(await menu.isVisible(),false);
  await page.locator('#scheduleNoteForm button[type="submit"]').click();
  await page.waitForFunction(count=>__note.saveCalls===count,prior.saveCalls+1);
  assert.equal(await page.evaluate(()=>__note.persisted.noteHtml),prior.html,'A hidden invalid format command must not block or change the saved note');
  assert.equal(await page.locator('#scheduleNoteModal').isVisible(),false);
  submitted.push({invalidContextSize:value,apiCalls:1,unchanged:true});await page.evaluate(()=>__note.open());
 }
 const priorToolbar=await page.evaluate(()=>({html:__note.html(),saveCalls:__note.saveCalls}));
 await page.locator('#scheduleNoteFontSize').fill('73');
 await page.locator('#scheduleNoteForm button[type="submit"]').click();
 await page.waitForFunction(count=>__note.saveCalls===count,priorToolbar.saveCalls+1);
 assert.equal(await page.evaluate(()=>__note.persisted.noteHtml),priorToolbar.html,'An unapplied toolbar draft must not block or enter the note payload');
 await page.evaluate(()=>__note.open());
 cases.push({name:'actual submit saves validated note formats despite rejected hidden context commands and an unapplied invalid toolbar draft',submitted,unappliedToolbarSize:'73'});

 await page.evaluate(async()=>{
  document.getElementById('scheduleNoteModal').close();
  __note.state.data.scheduleNote={note_text:'Alt & <sicher>',note_html:'',font_size:'large',bold:true,italic:true,underline:true};
  await __note.open();
 });
 const legacy=await wordStyle(page,'Alt & <sicher>');assertPoints(legacy,7.2);
 for(const name of ['bold','italic','underline'])assert.equal(legacy.formats[name],true);
 assert.equal(await page.locator('#scheduleNoteEditor script, #scheduleNoteEditor sicher').count(),0);
 const legacyBefore=await page.evaluate(()=>({html:__note.html(),text:__note.plain(),delta:__note.editor.getContents()}));
 await page.evaluate(()=>__note.save());await page.evaluate(()=>__note.open());
 assert.deepEqual(await page.evaluate(()=>({html:__note.html(),text:__note.plain(),delta:__note.editor.getContents()})),legacyBefore);
 cases.push({name:'legacy plain-text notes retain escaped text, separate style flags and their original large point size',legacy});

 const benignViolations=await page.evaluate(()=>window.__noteViolations.slice());
 assert.deepEqual(benignViolations,[],'Normal editing must work under the stronger class-only CSP');
 const unsafe='<p><strong>Safe &amp; text</strong><span data-size="999" class="ql-size-999pt" style="font-size:999pt" onclick="window.__noteInjected=1"> bounded</span><script>window.__noteInjected=1</script></p>';
 await page.evaluate(value=>{window.__noteInjected=0;__note.setHtml(value);},unsafe);
 const safe=await page.evaluate(()=>({html:__note.html(),injected:window.__noteInjected,unsafe:[...__note.editor.root.querySelectorAll('*')].some(node=>[...node.attributes].some(attr=>/^on/i.test(attr.name)||attr.name==='style')||node.localName==='script')}));
 assert.equal(safe.injected,0);assert.equal(safe.unsafe,false);assertPoints(await wordStyle(page,'bounded'),10);
 const expectedNegativeCspViolations=await page.evaluate(()=>window.__noteViolations.slice());
 assert.ok(expectedNegativeCspViolations.every(item=>item.directive==='style-src-attr'&&item.blocked==='inline'),
  'Only the deliberately supplied unsafe inline style may be rejected by CSP');
 cases.push({name:'clipboard whitelist drops executable attributes and oversized style declarations',safe,rejectedInlineStyles:expectedNegativeCspViolations});
  await page.evaluate(value=>{__note.setHtml(value);__note.refresh();},beforeSave.html);
 return {cases,note_html:beforeSave.html,note_text:beforeSave.text,delta:beforeSave.delta,styles:sizes,strictLocalCsp:true,benignViolations,expectedNegativeCspViolations};
}

module.exports={startScheduleNoteBrowserFixture,runScheduleNoteBrowserCases};
