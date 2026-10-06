'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const List=require('../public/sales-article-price-labels'),Editor=require('../public/sales-price-labels');
const template=(id,extra={})=>({id,title:'Regal '+id,creator:{label:'Synthetischer Ersteller'},received:false,canEdit:true,
 options:{labelWidthMm:90,labelHeightMm:60},updatedAt:'2026-10-02T10:00:00.000Z',...extra});
function uiFixture({api,rawApi=async()=>{},onOpen=()=>{},articleNumber='001234'}={}){
 const node=()=>({textContent:'',innerHTML:'',disabled:false,handlers:new Map(),addEventListener(type,fn){this.handlers.set(type,fn);},removeEventListener(type){this.handlers.delete(type);},replaceChildren(){this.innerHTML='';},insertAdjacentHTML(_position,html){this.innerHTML+=html;}});
 const status=node(),results=node(),create=node();let access='account-one';
 const root={isConnected:true,classList:{add(){}},innerHTML:'',ownerDocument:{},querySelector(selector){return selector==='[role=status]'?status:selector==='.sapl-results'?results:create;},replaceChildren(){this.innerHTML='';}};
 const view=List.mount(root,{api,rawApi,article:{articleNumber},accessKey:()=>access,onOpen});
 return {view,root,status,results,create,changeAccount(){access='account-two';},click(dataset){const button={dataset};results.handlers.get('click')({target:{closest:()=>button}});}};
}
const turn=()=>new Promise(setImmediate);

test('Article PDF download preserves UTF-8 names and rejects corrupt legacy names or unsafe header paths',()=>{
 const name='Eigene Vorlage · Artikelvorschau-001234.pdf';
 assert.equal(List.downloadName('attachment; filename="Preisschild.pdf"; filename*=UTF-8\'\''+encodeURIComponent(name), 'fallback.pdf'),name);
 assert.equal(List.downloadName('attachment; filename="Eigene Vorlage ý Artikelvorschau-001234.pdf"',name),name);
 assert.equal(List.downloadName('attachment; filename="ASCII-001234.pdf"',name),'ASCII-001234.pdf');
 for(const header of ["attachment; filename*=UTF-8''bad%", "attachment; filename*=UTF-8''..%2Fprivate.pdf", "attachment; filename*=UTF-8''hidden%0Aname.pdf"])
  assert.equal(List.downloadName(header,name),name);
});

test('Article intent edits only own originals and opens every received template as an unsaved copy',()=>{
 for(const decide of [List.templateIntent,(article,t)=>Editor.articleTemplateIntent(article,t)]){
  assert.deepEqual(decide('001234',template('own')),{articleNumber:'001234',templateId:'own',copy:false});
  assert.deepEqual(decide('001234',template('branch-editable',{received:true,canEdit:true})),{articleNumber:'001234',templateId:'branch-editable',copy:true});
  assert.equal(decide('001234',template('received',{received:true,canEdit:false})).copy,true);
  assert.equal(decide('001234',template('untrusted',{received:undefined})).copy,true);
  assert.deepEqual(decide('001234',null),{articleNumber:'001234',templateId:'',copy:false});
 }
 assert.throws(()=>Editor.articleTemplateIntent('001234 001235',null));
});

test('Article list uses protected visible library and keeps current article on own, shared and create links without writes',async()=>{
 const calls=[],opened=[],own=template('own'),shared=template('shared',{received:true});
 const f=uiFixture({api:async(path,options)=>{calls.push({path,options});return {templates:[own,shared]};},onOpen:value=>opened.push(value)});
 await f.view.activate();assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/sales/price-labels/library');
 assert.match(f.results.innerHTML,/Speichername/);assert.match(f.results.innerHTML,/Freigegeben · als Kopie öffnen/);
 f.click({saplOpen:'own'});await turn();f.click({saplOpen:'shared'});await turn();f.create.handlers.get('click')();await turn();
 assert.deepEqual(opened,[{articleNumber:'001234',templateId:'own',copy:false},{articleNumber:'001234',templateId:'shared',copy:true},{articleNumber:'001234',templateId:'',copy:false}]);
 assert.equal(calls.length,1,'Opening a design does not create or change a persisted template');f.view.destroy();
});

test('Direct PDF keeps exact current article and template and drops a late response after article navigation',async()=>{
 let resolvePdf,call;const response=new Promise(resolve=>{resolvePdf=resolve;});
 const f=uiFixture({api:async()=>({templates:[template('shared',{received:true})]}),rawApi:(path,options)=>{call={path,options};return response;}});
 await f.view.activate();f.click({saplPdf:'shared'});await turn();
 assert.equal(call.path,'/api/sales/price-labels/library/shared/article.pdf');assert.equal(call.options.method,'POST');
 assert.deepEqual(JSON.parse(call.options.body),{articleNumber:'001234'});
 f.view.destroy();assert.equal(call.options.signal.aborted,true);let blobRead=false;
 resolvePdf({blob:async()=>{blobRead=true;return new Blob();}});await turn();assert.equal(blobRead,false,'No download after leaving this article');
});

test('Revoked account and out-of-order library responses cannot repaint the article list',async()=>{
 const pending=[];const f=uiFixture({api:()=>new Promise(resolve=>pending.push(resolve))});
 const first=f.view.activate(),second=f.view.activate();pending[1]({templates:[template('fresh')]});await second;
 pending[0]({templates:[template('stale')]});await first;assert.match(f.results.innerHTML,/Regal fresh/);assert.doesNotMatch(f.results.innerHTML,/Regal stale/);
 const third=f.view.activate();f.changeAccount();pending[2]({templates:[template('other-account')]});await third;assert.doesNotMatch(f.results.innerHTML,/other-account/);f.view.destroy();
});

function editorFixture(api,{rawApi=async()=>{}}={}){
 // Parse the mounted markup and keep real parent/form relationships: the editor
 // moves branding controls out of the form and builds its preview with DOM calls.
 // Unknown selectors return null so missing UI cannot silently pass a test.
 const {Parser}=require('htmlparser2'),escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const dataKey=name=>name.slice(5).replace(/-([a-z])/g,(_match,c)=>c.toUpperCase());
 const events=()=>({handlers:new Map(),addEventListener(type,fn){this.handlers.set(type,fn);},removeEventListener(type){this.handlers.delete(type);}});
 const doc={activeElement:null,...events(),defaultView:{crypto:globalThis.crypto,innerWidth:1400,innerHeight:1000,...events()}},voidTags=new Set(['input','img','br','hr','meta','link']);
 let root;
 const node=(tagName='',text='')=>{
  const attrs={},element={tagName,ownerDocument:doc,parentNode:null,childNodes:[],dataset:{},handlers:new Map(),checked:false,disabled:false,hidden:false,
   style:{setProperty(key,value){this[key]=value;}},_text:text,
   get children(){return this.childNodes.filter(child=>child.tagName);},get firstChild(){return this.childNodes[0]||null;},
   get isConnected(){return this===root||Boolean(this.parentNode?.isConnected);},
   get textContent(){return tagName?this.childNodes.map(child=>child.textContent).join(''):this._text;},
   set textContent(value){if(tagName)this.replaceChildren(node('',String(value)));else this._text=String(value);},
   get innerHTML(){return this.childNodes.map(serialize).join('');},set innerHTML(html){
    this.replaceChildren();const stack=[this];new Parser({
     onopentag(name,values){const child=node(name);Object.entries(values).forEach(([key,value])=>child.setAttribute(key,value));stack.at(-1).append(child);stack.push(child);},
     ontext(value){stack.at(-1).append(node('',value));},onclosetag(){stack.pop();}
    }).end(String(html));
   },
   get value(){if(this._value!==undefined)return this._value;return tagName==='select'?this.querySelector('option')?.value||'':tagName==='option'?this.textContent:'';},
   set value(value){this._value=String(value);},
   get elements(){return this._elements ||= Object.fromEntries(root.querySelectorAll('input,select,textarea').filter(input=>input.name&&(input.closest('form')===this||this.id&&input.getAttribute('form')===this.id)).map(input=>[input.name,input]));},
   setAttribute(name,value){attrs[name]=String(value);if(name.startsWith('data-'))this.dataset[dataKey(name)]=String(value);if(name==='value')this.value=value;if(['checked','disabled','hidden','open'].includes(name))this[name]=true;},
   getAttribute(name){return name.startsWith('data-')?(this.dataset[dataKey(name)]??null):(attrs[name]??null);},
   hasAttribute(name){return this.getAttribute(name)!==null;},
   addEventListener(type,fn){this.handlers.set(type,fn);},removeEventListener(type,fn){if(this.handlers.get(type)===fn)this.handlers.delete(type);},
   replaceChildren(...children){this.childNodes.forEach(child=>child.parentNode=null);this.childNodes=[];this.append(...children);},
   append(...children){for(let child of children){if(typeof child==='string')child=node('',child);child.remove();child.parentNode=this;this.childNodes.push(child);}},
   prepend(...children){const prior=[...this.childNodes];this.replaceChildren(...children,...prior);},
   remove(){if(this.parentNode){this.parentNode.childNodes=this.parentNode.childNodes.filter(child=>child!==this);this.parentNode=null;}},
   contains(child){return Boolean(child&&(child===this||this.childNodes.some(node=>node.contains(child))));},
   matches(selector){return selector.split(',').some(part=>{
    let remaining=part.trim();if(remaining.endsWith(':checked')){if(!this.checked)return false;remaining=remaining.slice(0,-8);}
    const tag=/^[a-z][\w-]*/i.exec(remaining);if(tag){if(tag[0].toLowerCase()!==tagName)return false;remaining=remaining.slice(tag[0].length);}
    remaining=remaining.replace(/\.([\w-]+)|\[([^=\]]+)(?:="([^"]*)")?\]/g,(match,cls,attr,value)=>{
     if(cls?!this.className.split(/\s+/).includes(cls):!this.hasAttribute(attr)||value!==undefined&&this.getAttribute(attr)!==value)return '!';return '';
    });return Boolean(tagName)&&remaining==='';
   });},
   closest(selector){return this.matches(selector)?this:this.parentNode?.closest(selector)||null;},
   querySelectorAll(selector){const found=[];const visit=parent=>{for(const child of parent.childNodes){if(child.matches(selector))found.push(child);visit(child);}};visit(this);return found;},
   querySelector(selector){for(const child of this.childNodes){if(child.matches(selector))return child;const found=child.querySelector(selector);if(found)return found;}return null;},
   focus(){doc.activeElement=this;},select(){},click(){this.handlers.get('click')?.({target:this});},
   getBoundingClientRect(){return this.classList.contains('spl-label')?{left:10,top:20,width:675,height:450}:{left:0,top:0,width:100,height:100};},
   getContext(){return{font:'',measureText(text){return{width:String(text).length*(parseFloat(/([\d.]+)px/.exec(this.font)?.[1])||12)*.5};}};},
   _attributes:attrs
  };
  for(const property of ['id','name','type','src','alt','className'])Object.defineProperty(element,property,{get:()=>attrs[property==='className'?'class':property]||'',set:value=>element.setAttribute(property==='className'?'class':property,value)});
  element.classList={contains:cls=>element.className.split(/\s+/).includes(cls),add(...names){element.className=[...new Set([...element.className.split(/\s+/).filter(Boolean),...names])].join(' ');},remove(...names){element.className=element.className.split(/\s+/).filter(name=>!names.includes(name)).join(' ');},toggle(cls,force){const add=force===undefined?!this.contains(cls):force;const names=element.className.split(/\s+/).filter(name=>name&&name!==cls);if(add)names.push(cls);element.className=names.join(' ');return add;}};
  return element;
 };
 const serialize=element=>{
  if(!element.tagName)return escape(element.textContent);
  const attrs={...element._attributes,...Object.fromEntries(Object.entries(element.dataset).map(([key,value])=>['data-'+key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),value]))};
  const start='<'+element.tagName+Object.entries(attrs).map(([key,value])=>' '+key+'="'+escape(value)+'"').join('')+'>';
  return start+(voidTags.has(element.tagName)?'':element.innerHTML+'</'+element.tagName+'>');
 };
 doc.createElement=node;
 root=node('div');
 const q=key=>root.querySelector(key.startsWith('.')?key:'[data-pl="'+key+'"]');
 let account='account-one';
 const workspace=Editor.mount(root,{api,rawApi,accessKey:()=>account});
 return {workspace,settings:q('settings'),q,root,changeAccount(){account='account-two';}};
}
function editorApi(calls,{delayFirstDefaults}={}){
 let defaultReads=0,draft={revision:0,draft:null,lastMutationId:null};
 return async(path,options)=>{
  calls.push({path,options});
  if(path==='/api/sales/price-labels/draft'){if(options?.method==='PUT'){const input=JSON.parse(options.body);draft={revision:draft.revision+1,draft:input.draft,lastMutationId:input.mutationId};}return draft;}
  if(path==='/api/sales/price-labels/templates'){defaultReads++;if(defaultReads===1&&delayFirstDefaults)return delayFirstDefaults;return {options:{...Editor.defaults},filenameOptions:{stamp:'none',position:'before',separator:'-',suffix:''}};}
  if(path==='/api/sales/price-labels/branding')return {kits:[]};
  if(path==='/api/sales/price-labels/library')return {templates:[],capabilities:{create:true,ownBranch:false},recipients:[]};
  if(path.startsWith('/api/sales/price-labels/library/'))return {...template(path.split('/').at(-1)),version:1,visibility:'private',recipients:[],options:{...Editor.defaults},filenameOptions:{stamp:'none',position:'before',separator:'-',suffix:''},received:path.endsWith('/shared')};
  if(path==='/api/sales/price-labels/articles'){const {articleNumbers}=JSON.parse(options.body);return {items:articleNumbers.map(articleNumber=>({articleNumber,description:'Fresh '+articleNumber,priceGross:'123.45'})),updatedAt:'2026-10-02T10:00:00Z'};}
  throw Error('Unexpected API '+path);
 };
}

test('Paper page controls show current copies only, navigate a partial page and clamp after fewer copies',async()=>{
 const calls=[],f=editorFixture(editorApi(calls));await f.workspace.openArticle('001234');
 const fields=f.settings.elements;fields.copies.value=17;fields.gapMm.value=4;f.settings.handlers.get('input')({target:fields.copies});
 assert.equal(f.q('paper-page-count').textContent,'von 3');assert.equal(f.q('paper-prev').disabled,true);assert.equal(f.q('paper-next').disabled,false);
 f.q('paper-next').handlers.get('click')();assert.equal(f.q('paper-page-number').value,'2');
 const target=f.q('paper-page-number');target.value='3';f.settings.handlers.get('input')({target});assert.equal(target.value,'3','Bubbling input leaves the unfinished page choice alone');
 target.handlers.get('change')({target});f.settings.handlers.get('change')({target});assert.equal(target.value,'3');assert.match(f.q('paper-occupancy').textContent,/1 belegt · 7 frei · Schilder 17–17/);
 assert.equal((f.q('paper-preview').innerHTML.match(/data-pl-occupied="true"/g)||[]).length,1);
 fields.copies.value=1;f.settings.handlers.get('input')({target:fields.copies});assert.equal(f.q('paper-page-number').value,'1');assert.equal(f.q('paper-next').disabled,true);
 fields.articleNumbers.value='001235';f.settings.handlers.get('input')({target:fields.articleNumbers});
 assert.equal(f.q('paper-page-count').textContent,'von 0');assert.doesNotMatch(f.q('paper-preview').innerHTML,/data-pl-occupied="true"/);
 f.workspace.destroy();
});

test('Design changes retain legacy border defaults until an explicit border choice; stored cuts remain visibly inactive with a border',async()=>{
 const calls=[],f=editorFixture(editorApi(calls));await f.workspace.load();const fields=f.settings.elements;
 const input=target=>{f.settings.handlers.get('input')({target});f.settings.handlers.get('change')({target});};
 fields.design.value='minimal';input(fields.design);assert.equal(fields.showBorder.checked,false);assert.equal(fields.cutMarks.disabled,false);
 fields.cutMarks.checked=true;input(fields.cutMarks);assert.match(f.q('cut-hint').textContent,/gestrichelte/);
 fields.showBorder.checked=true;input(fields.showBorder);assert.equal(fields.cutMarks.checked,true);assert.equal(fields.cutMarks.disabled,true);assert.match(f.q('cut-hint').textContent,/inaktiv/);
 fields.design.value='classic';input(fields.design);fields.design.value='minimal';input(fields.design);assert.equal(fields.showBorder.checked,true);
 f.q('.spl-presets').handlers.get('click')({target:{closest:()=>({dataset:{plPreset:'shelf'}})}});assert.equal(fields.showBorder.checked,true);
 fields.showBorder.checked=false;input(fields.showBorder);fields.design.value='promo';input(fields.design);assert.equal(fields.showBorder.checked,false);
 assert.match(f.q('preview').children[0].className,/spl-border-off/);f.workspace.destroy();
});

test('Editor opens own original or foreign draft with exactly the current article and persists neither automatically',async()=>{
 for(const id of ['own','shared']){
  const calls=[],f=editorFixture(editorApi(calls));assert.equal(await f.workspace.openArticle('001234',id),true);
  assert.equal(f.settings.elements.articleNumbers.value,'001234');assert.equal(f.settings.elements.priceType.value,'sales');
  assert.equal(f.q('library-title').value,'Regal '+id+(id==='shared'?' (Kopie)':''));
  assert.equal(f.q('save').textContent,id==='shared'?'Neue Vorlage speichern':'Änderungen speichern');
  assert.ok(!calls.some(call=>call.options?.method==='PATCH'||call.path==='/api/sales/price-labels/library'&&call.options?.method==='POST'));f.workspace.destroy();
 }
});

test('Editor drops superseded article-open intent and old account intent while defaults are still loading',async()=>{
 for(const switchAccount of [false,true]){
  let resolveFirst;const delayed=new Promise(resolve=>{resolveFirst=resolve;});const calls=[],f=editorFixture(editorApi(calls,{delayFirstDefaults:delayed}));
  const stale=f.workspace.openArticle('001234','own');await turn();
  if(switchAccount){f.changeAccount();await f.workspace.load();}else assert.equal(await f.workspace.openArticle('001235','own'),true);
  resolveFirst({options:{...Editor.defaults},filenameOptions:{stamp:'none',position:'before',separator:'-',suffix:''}});
  assert.equal(await stale,false);assert.equal(f.settings.elements.articleNumbers.value,switchAccount?'':'001235');
  assert.ok(!calls.some(call=>call.path==='/api/sales/price-labels/articles'&&JSON.parse(call.options.body).articleNumbers.includes('001234')));f.workspace.destroy();
 }
});

test('Editor reports stale or revoked template errors without an unhandled open promise',async()=>{
 const calls=[],base=editorApi(calls),f=editorFixture(async(path,options)=>{if(path.endsWith('/revoked'))throw Object.assign(Error('Vorlage nicht verfügbar.'),{status:404});return base(path,options);});
 assert.equal(await f.workspace.openArticle('001234','revoked'),false);assert.equal(f.q('status').textContent,'Vorlage nicht verfügbar.');f.workspace.destroy();
});

function logoFixture(t, {readonly=false}={}) {
 const previous=globalThis.location;globalThis.location={origin:'http://synthetic.local'};t.after(()=>{globalThis.location=previous;});
 const calls=[],base=editorApi(calls),options={...Editor.defaults,logoKitId:'synthetic-kit',logoAssetKey:'logo'};
 const shared={...template('readonly',{canEdit:false,received:true}),options,visibility:'selected',version:1,recipients:[],filenameOptions:{stamp:'none',position:'before',separator:'-',suffix:''}};
 const f=editorFixture(async(path,request)=>{
  if(path==='/api/sales/price-labels/templates')return{options};
  if(path==='/api/sales/price-labels/branding')return{kits:[{id:'synthetic-kit',name:'Synthetic',logos:[{key:'logo',label:'Logo',url:'/assets/grabenplaner-logo.svg'}]}]};
  if(path==='/api/sales/price-labels/library')return{templates:readonly?[shared]:[],capabilities:{create:true,ownBranch:false},recipients:[]};
  return base(path,request);
 });
 const preview=f.q('preview');
 let capture=null;preview.setPointerCapture=id=>{capture=id;};preview.hasPointerCapture=id=>capture===id;preview.releasePointerCapture=()=>{capture=null;};
 const event=(target,extra={})=>({target,pointerId:7,button:0,clientX:100,clientY:100,preventDefault(){this.prevented=true;},...extra});
 return {...f,get editor(){return preview.querySelector('[data-pl-element="logo"]');},get grip(){return this.editor?.querySelector('[data-pl-element-resize]');},calls,event,dispatch:(type,e)=>preview.handlers.get(type)(e),capture:()=>capture};
}

test('Logo drag converts visual coordinates at 150% zoom, keeps stable capture, and Escape restores reserved geometry',async t=>{
 const f=logoFixture(t);await f.workspace.load();
 f.dispatch('pointerdown',f.event(f.editor));assert.equal(f.capture(),7);assert.equal(f.settings.elements.logoMode.value,'reserved','Selecting alone keeps the anchored layout');
 assert.equal(Number(f.settings.elements.logoXmm.value),4);assert.equal(Number(f.settings.elements.logoYmm.value),4);
 f.dispatch('pointermove',f.event(f.editor,{clientX:175,clientY:175}));
 assert.equal(f.settings.elements.logoMode.value,'free');
 assert.equal(Number(f.settings.elements.logoXmm.value),14);assert.equal(Number(f.settings.elements.logoYmm.value),14);
 f.dispatch('pointermove',f.event(f.editor));
 assert.equal(Number(f.settings.elements.logoXmm.value),4);assert.equal(Number(f.settings.elements.logoYmm.value),4,'Returning to the drag origin restores its coordinates');
 f.dispatch('pointermove',f.event(f.editor,{clientX:175,clientY:175}));
 f.dispatch('keydown',f.event(f.editor,{key:'Escape'}));
 assert.equal(f.capture(),null);assert.equal(f.settings.elements.logoMode.value,'reserved');assert.equal(Number(f.settings.elements.logoXmm.value),4);
 assert.equal(f.q('logo-live').textContent,'Elementänderung verworfen.');f.workspace.destroy();
});

test('Corner resize and keyboard arrows preserve bounded millimeters, default font choice and smaller presets',async t=>{
 const f=logoFixture(t);await f.workspace.load();
 f.dispatch('pointerdown',f.event(f.grip));f.dispatch('pointermove',f.event(f.grip,{clientX:175,clientY:175}));f.dispatch('pointerup',f.event(f.grip));
 assert.equal(Number(f.settings.elements.logoWidthMm.value),30);assert.equal(Number(f.settings.elements.logoHeightMm.value),20);
 f.dispatch('keydown',f.event(f.editor,{key:'ArrowRight',shiftKey:true}));assert.equal(Number(f.settings.elements.logoXmm.value),9);
 f.dispatch('keydown',f.event(f.grip,{key:'ArrowDown'}));assert.equal(Number(f.settings.elements.logoHeightMm.value),20.5);
 f.settings.elements.fontId.value='spectral';f.settings.handlers.get('change')({target:f.settings.elements.fontId});assert.equal(f.settings.elements.fontId.value,'spectral');
 f.settings.elements.logoXmm.value=60;f.settings.elements.logoWidthMm.value=20;
 f.q('.spl-presets').handlers.get('click')({target:{closest:()=>({dataset:{plPreset:'shelf'}})}});
 assert.equal(Number(f.settings.elements.labelWidthMm.value),70);assert.equal(Number(f.settings.elements.logoXmm.value),50);
 assert.equal(f.settings.elements.fontId.value,'spectral');f.workspace.destroy();
});

test('Read-only templates and switched accounts cannot mutate logo or text font controls',async t=>{
 const f=logoFixture(t,{readonly:true});await f.workspace.load();
 f.q('library-select').value='readonly';f.q('library-select').handlers.get('change')();
 assert.equal(f.settings.elements.fontId.disabled,true);
 f.dispatch('pointerdown',f.event(f.editor));f.dispatch('keydown',f.event(f.editor,{key:'ArrowRight'}));
 const toolbar=f.q('element-toolbar'),picker=toolbar.querySelector('[data-pl-edit="element"]');picker.value='description';toolbar.handlers.get('change')({target:picker});
 const font=toolbar.querySelector('[data-pl-edit="font"]');
 // Selection is available in a received design; changing its font remains blocked.
 const beforeFont=f.q('preview').querySelector('[data-pl-element="description"]').querySelector('.spl-element-text').style.fontFamily;
 assert.equal(font.disabled,true);font.value='spectral';toolbar.handlers.get('change')({target:font});
 assert.equal(f.q('preview').querySelector('[data-pl-element="description"]').querySelector('.spl-element-text').style.fontFamily,beforeFont);
 assert.equal(f.settings.elements.logoMode.value,'reserved');assert.equal(f.settings.elements.fontId.value,'roboto');
 f.q('library-select').value='';f.q('library-select').handlers.get('change')();
 f.dispatch('pointerdown',f.event(f.editor));const before=f.settings.elements.logoXmm.value;f.changeAccount();
 f.dispatch('pointermove',f.event(f.editor,{clientX:175}));assert.equal(f.settings.elements.logoXmm.value,before);
 f.workspace.suspend();assert.equal(f.capture(),null);f.workspace.destroy();
});

function formatFixture({ownBranch=true,branchCapability=true,create=true,templates=[],saveHook,rawApi}={}){
 const calls=[],base=editorApi(calls),api=async(path,options={})=>{
  if(path==='/api/sales/price-labels/library'&&!options.body){calls.push({path,options});return {templates,
   ownBranch:ownBranch?{id:'93',label:'Filiale 93'}:null,capabilities:{create,ownBranch:branchCapability},
   recipients:[{id:'UI-FIL94',label:'Filialkonto 94',locationId:'94',locationLabel:'Filiale 94'}]};}
  if(options.body&&(/\/library(?:\/|$)/.test(path))){const body=JSON.parse(options.body);calls.push({path,options,body});
   if(saveHook)return saveHook({path,options,body});
   return {...body,id:'created',version:body.version?body.version+1:1,canEdit:true,received:false,creator:{label:'Synthetisch'}};}
  return base(path,options);
 };
 return {...editorFixture(api,{rawApi}),calls};
}
function preset(f,id){f.q('.spl-presets').handlers.get('click')({target:{closest:()=>({dataset:{plPreset:id}})}});}
function orient(f,value){const target=f.q('label-orientation');target.value=value;
 f.settings.handlers.get('input')({target});target.handlers.get('change')({target});f.settings.handlers.get('change')({target});}
const fieldSnapshot=f=>Object.fromEntries(Object.keys(Editor.defaults).filter(key=>f.settings.elements[key]).map(key=>[key,f.settings.elements[key].value]));
const libraryWrites=f=>f.calls.filter(call=>call.options?.body&&/\/library(?:\/|$)/.test(call.path));

test('Five presets preserve their default dimensions; native orientation input/change affects only the shield and manual sizes remain reversible',async()=>{
 const f=formatFixture();await f.workspace.load();const fields=f.settings.elements;
 fields.paper.value='custom';fields.paperWidthMm.value=320;fields.paperHeightMm.value=450;fields.orientation.value='landscape';fields.marginMm.value=7.5;
 fields.fontId.value='pt-serif';const paperFields=['paper','paperWidthMm','paperHeightMm','orientation','marginMm','gapMm'];
 const paper=Object.fromEntries(paperFields.map(key=>[key,fields[key].value]));
 for(const format of Editor.labelFormats){
  preset(f,format.id);assert.equal(Number(fields.labelWidthMm.value),format.width);assert.equal(Number(fields.labelHeightMm.value),format.height);
  for(const orientation of ['portrait','landscape']){orient(f,orientation);
   assert.equal(f.q('label-orientation').value,orientation);assert.equal(Number(fields.labelWidthMm.value),orientation==='portrait'?Math.min(format.width,format.height):Math.max(format.width,format.height));
   assert.deepEqual(Object.fromEntries(paperFields.map(key=>[key,fields[key].value])),paper);assert.equal(fields.fontId.value,'pt-serif');
   assert.match(f.q('saved').textContent,/Schildausrichtung geändert/,'native bubbling must not erase the confirmation');
  }
 }
 fields.labelWidthMm.value=137.5;fields.labelHeightMm.value=84;f.settings.handlers.get('input')({target:fields.labelWidthMm});
 assert.equal(f.q('label-orientation').value,'landscape');orient(f,'portrait');
 assert.equal(Number(fields.labelWidthMm.value),84);assert.equal(Number(fields.labelHeightMm.value),137.5);
 assert.equal(libraryWrites(f).length,0);f.workspace.destroy();
});

test('A4 cannot be saved with incompatible margins; only the explicit fit action changes paper and keeps exact shield size',async()=>{
 const f=formatFixture();await f.workspace.load();f.q('library-new').handlers.get('click')();preset(f,'a4');orient(f,'landscape');
 const fields=f.settings.elements;assert.equal(fields.paper.value,'A4');assert.equal(fields.orientation.value,'portrait');assert.equal(Number(fields.marginMm.value),10);
 assert.equal(f.q('paper-fit').hidden,false);assert.equal(f.q('save').disabled,true);assert.match(f.q('paper-fit').textContent,/A4 Querformat, Rand 0 mm/);
 await f.q('save').handlers.get('click')();assert.equal(libraryWrites(f).length,0,'even a synthetic click cannot save incompatible geometry');
 f.q('paper-fit').handlers.get('click')();assert.equal(fields.orientation.value,'landscape');assert.equal(Number(fields.marginMm.value),0);
 assert.equal(Number(fields.labelWidthMm.value),297);assert.equal(Number(fields.labelHeightMm.value),210);
 assert.equal(f.q('save').disabled,false);assert.equal(f.q('paper-fit').hidden,true);
 assert.match(f.q('layout').textContent,/1 × 1 Schild pro Seite · 1 Platz auf A4/);
 await f.q('save').handlers.get('click')();const saved=libraryWrites(f).at(-1).body;
 assert.equal(saved.options.labelWidthMm,297);assert.equal(saved.options.labelHeightMm,210);assert.equal(saved.visibility,'branch');
 assert.deepEqual(Object.keys(saved.options).sort(),Object.keys(Editor.defaults).sort());f.workspace.destroy();
});

test('New and copied named templates prefer only an available own branch; fallback and explicit visibility choices stay account controlled',async()=>{
 for(const [ownBranch,branchCapability,expected]of[[true,true,'branch'],[false,true,'private'],[true,false,'private']]){
  const f=formatFixture({ownBranch,branchCapability});await f.workspace.load();f.q('library-new').handlers.get('click')();
  assert.equal(f.q('library-scope').value,expected);assert.equal(libraryWrites(f).length,0);await f.q('save').handlers.get('click')();
  assert.equal(libraryWrites(f).at(-1).body.visibility,expected);f.workspace.destroy();
 }
 for(const visibility of['private','selected']){
  const f=formatFixture();await f.workspace.load();f.q('library-new').handlers.get('click')();f.q('library-scope').value=visibility;
  f.q('library-scope').handlers.get('change')();if(visibility==='selected')f.q('library-recipients').querySelectorAll('input')[0].checked=true;
  await f.q('save').handlers.get('click')();assert.equal(libraryWrites(f).at(-1).body.visibility,visibility);
  assert.deepEqual(libraryWrites(f).at(-1).body.recipients,visibility==='selected'?['UI-FIL94']:[]);f.workspace.destroy();
 }
});

test('Received templates keep format controls disabled until an unsaved branch-default copy is explicitly requested',async()=>{
 const original={...template('received',{received:true,canEdit:false}),version:2,visibility:'selected',recipients:[],options:{...Editor.defaults},filenameOptions:{stamp:'none'}};
 const f=formatFixture({templates:[original]});await f.workspace.load();f.q('library-select').value=original.id;f.q('library-select').handlers.get('change')();
 const before=fieldSnapshot(f);assert.equal(f.q('label-orientation').disabled,true);assert.equal(f.q('paper-fit').disabled,true);
 preset(f,'a4');orient(f,'portrait');f.q('paper-fit').handlers.get('click')();await f.q('save').handlers.get('click')();
 assert.deepEqual(fieldSnapshot(f),before);assert.equal(libraryWrites(f).length,0);
 f.q('library-copy').handlers.get('click')();assert.equal(f.q('library-scope').value,'branch');assert.equal(f.q('label-orientation').disabled,false);
 assert.equal(libraryWrites(f).length,0,'copy remains an unsaved draft');await f.q('save').handlers.get('click')();
 assert.equal(libraryWrites(f).at(-1).options.method,'POST');assert.equal(libraryWrites(f).at(-1).path,'/api/sales/price-labels/library');
 assert.equal(original.version,2);assert.equal(original.options.labelWidthMm,90);f.workspace.destroy();
});

test('A read-only shared design still invalidates stale article/paper previews and requires fresh prices after an article change',async()=>{
 const original={...template('received',{received:true,canEdit:false}),version:2,visibility:'selected',recipients:[],options:{...Editor.defaults},filenameOptions:{stamp:'none'}};
 const f=formatFixture({templates:[original]});await f.workspace.load();const fields=f.settings.elements;
 fields.articleNumbers.value='ONE';f.settings.handlers.get('input')({target:fields.articleNumbers});f.q('refresh').handlers.get('click')();await turn();
 f.q('library-select').value=original.id;f.q('library-select').handlers.get('change')();assert.match(f.q('paper-preview').innerHTML,/Artikel ONE/);assert.equal(f.q('download').disabled,false);
 assert.equal(fields.showBorder.disabled,true);assert.equal(fields.cutMarks.disabled,true);
 fields.articleNumbers.value='TWO';f.settings.handlers.get('input')({target:fields.articleNumbers});
 assert.equal(f.q('download').disabled,true);assert.doesNotMatch(f.q('paper-preview').innerHTML,/Artikel ONE|data-pl-occupied="true"/);
 f.q('refresh').handlers.get('click')();await turn();assert.match(f.q('paper-preview').innerHTML,/Artikel TWO/);assert.equal(f.q('download').disabled,false);
 fields.priceType.value='internet_1';f.settings.handlers.get('change')({target:fields.priceType});assert.equal(f.q('download').disabled,true);assert.equal(f.q('paper-page-count').textContent,'von 0');
 f.workspace.destroy();
});

test('Explicit border choice persists across saved-template loading even when it matches the current design default',async()=>{
 const saved={...template('owned'),version:1,visibility:'private',recipients:[],options:{...Editor.defaults,showBorder:true,borderMode:'manual'},filenameOptions:{stamp:'none'}};
 const f=formatFixture({templates:[saved]});await f.workspace.load();f.q('library-select').value=saved.id;f.q('library-select').handlers.get('change')();const fields=f.settings.elements;
 fields.design.value='minimal';f.settings.handlers.get('input')({target:fields.design});assert.equal(fields.showBorder.checked,true);assert.equal(fields.borderMode.value,'manual');
 await f.q('save').handlers.get('click')();assert.equal(libraryWrites(f).at(-1).body.options.borderMode,'manual');assert.equal(libraryWrites(f).at(-1).body.options.showBorder,true);
 f.workspace.destroy();
});

test('Branch recipients retain locked sharing rules while owned CAS conflicts keep the draft for reload or copy',async()=>{
 const branchTemplate={...template('branch',{received:true,canEdit:true}),version:3,visibility:'branch',recipients:[],options:{...Editor.defaults},filenameOptions:{stamp:'none'}};
 const branch=formatFixture({templates:[branchTemplate]});await branch.workspace.load();branch.q('library-select').value='branch';branch.q('library-select').handlers.get('change')();
 assert.equal(branch.q('library-scope').disabled,true);assert.equal(branch.q('library-scope').value,'branch');preset(branch,'shelf');
 await branch.q('save').handlers.get('click')();assert.equal(libraryWrites(branch).at(-1).body.version,3);assert.equal(libraryWrites(branch).at(-1).body.visibility,'branch');branch.workspace.destroy();
 const own={...branchTemplate,id:'own',received:false,visibility:'private'},f=formatFixture({templates:[own],saveHook:async()=>{throw Object.assign(Error('CAS conflict'),{status:409});}});
 await f.workspace.load();f.q('library-select').value='own';f.q('library-select').handlers.get('change')();preset(f,'stand');
 await f.q('save').handlers.get('click')();assert.equal(Number(f.settings.elements.labelWidthMm.value),105);assert.equal(f.q('library-reload').hidden,false);
 assert.match(f.q('saved').textContent,/Entwurf bleibt erhalten/);assert.equal(libraryWrites(f)[0].body.version,3);
 f.q('library-copy').handlers.get('click')();assert.equal(f.q('library-scope').value,'branch');assert.equal(f.q('save').textContent,'Neue Vorlage speichern');f.workspace.destroy();
});

test('A save response preserves newer numeric edits and cannot repaint after an account change',async()=>{
 for(const switchAccount of[false,true]){
  let complete;const pending=new Promise(resolve=>{complete=resolve;}),f=formatFixture({saveHook:()=>pending});
  await f.workspace.load();f.q('library-new').handlers.get('click')();const saving=f.q('save').handlers.get('click')();
  const submitted=libraryWrites(f)[0].body;f.settings.elements.labelWidthMm.value=99;
  f.settings.handlers.get('input')({target:f.settings.elements.labelWidthMm});if(switchAccount)f.changeAccount();
  complete({...submitted,id:'saved',version:1,canEdit:true,received:false});await saving;
  assert.equal(Number(f.settings.elements.labelWidthMm.value),99);
  if(!switchAccount)assert.match(f.q('saved').textContent,/späteren Änderungen sind noch nicht gespeichert/);
  else assert.notEqual(f.q('library-select').value,'saved');f.workspace.destroy();
 }
});

test('Concurrent editor instances describe their orientation with unique local help IDs',()=>{
 const first=formatFixture(),second=formatFixture();
 const help=fixture=>{const id=/id="(sales-price-label-format-hint-\d+)"/.exec(fixture.root.innerHTML)?.[1];
  assert.ok(id);assert.ok(fixture.root.innerHTML.includes('aria-describedby="'+id+'"'));return id;};
 assert.notEqual(help(first),help(second));
 const branding=first.q('branding-preview');assert.equal(branding.querySelector('summary').firstChild.textContent,'Logo-Position & Abstand ');
 for(const name of ['logoKitId','logoAssetKey','logoMode','logoXmm','logoYmm']){
  const moved=branding.querySelector('[name="'+name+'"]');assert.equal(moved,first.settings.elements[name]);assert.equal(moved.getAttribute('form'),first.settings.id);
 }
 assert.equal([...first.root.innerHTML.matchAll(/data-pl-preset="/g)].length,5);first.workspace.destroy();second.workspace.destroy();
});

test('An outstanding image upload blocks saving, PDF export and template replacement until the image belongs to the current draft',async()=>{
 const assetId='069911db-60a3-4f73-9c40-e4614d4ae7bd',rawCalls=[];let finishUpload;
 const own={...template('own'),version:1,visibility:'private',recipients:[],options:{...Editor.defaults},filenameOptions:{stamp:'none'}};
 const other={...own,id:'other',title:'Andere Vorlage',options:{...Editor.defaults,labelWidthMm:70,labelHeightMm:40}};
 const f=formatFixture({templates:[own,other],rawApi:(path,options)=>{
  rawCalls.push({path,options});if(path==='/api/sales/price-labels/images')return new Promise(resolve=>{finishUpload=resolve;});
  throw Error('Synthetic PDF capture complete');
 }});
 try {
  await f.workspace.openArticle('001234','own');assert.equal(f.q('save').disabled,false);assert.equal(f.q('download').disabled,false);
  const imageInput=f.q('image-tools').querySelector('[data-pl-image-input]');
  imageInput.files=[new File([Buffer.from('synthetic PNG upload')],'synthetic.png',{type:'image/png'})];
  const uploading=imageInput.handlers.get('change')();
  assert.equal(rawCalls.length,1);assert.equal(rawCalls[0].path,'/api/sales/price-labels/images');assert.equal(rawCalls[0].options.method,'POST');
  assert.equal(rawCalls[0].options.body.get('image').name,'synthetic.png');
  const readsBefore=f.calls.length;
  for(const key of ['save','download','library-select','library-new','library-copy','library-reload'])assert.equal(f.q(key).disabled,true,key+' is visibly disabled during upload');
  await f.q('save').handlers.get('click')();await f.q('export').handlers.get('submit')({preventDefault(){}});
  f.q('library-select').value='other';f.q('library-select').handlers.get('change')();
  f.q('library-new').handlers.get('click')();f.q('library-copy').handlers.get('click')();await f.q('library-reload').handlers.get('click')();
  assert.equal(libraryWrites(f).length,0);assert.equal(rawCalls.length,1,'No PDF request can omit the pending image');assert.equal(f.calls.length,readsBefore,'No reload replaces a draft with an outstanding upload');
  assert.equal(f.q('library-title').value,'Regal own');assert.equal(Number(f.settings.elements.labelWidthMm.value),90);
  finishUpload({json:async()=>({image:{assetId,width:200,height:100,mime:'image/png'}})});await uploading;
  assert.equal(f.q('save').disabled,false);assert.equal(f.q('download').disabled,false);assert.equal(imageInput.disabled,false);
  assert.equal(f.q('image-tools').querySelector('[data-pl-image-count]').textContent,'1 / 3');
  assert.equal(f.q('preview').querySelector('[data-pl-element="image:'+assetId+'"]').querySelector('img').src.startsWith('/api/sales/price-labels/images/'+assetId+'?preview='),true);
  await f.q('save').handlers.get('click')();const saved=libraryWrites(f).at(-1);
  assert.equal(saved.path,'/api/sales/price-labels/library/own');assert.equal(saved.options.method,'PATCH');assert.equal(saved.body.options.imageBoxes.length,1);assert.equal(saved.body.options.imageBoxes[0].assetId,assetId);
  await f.q('export').handlers.get('submit')({preventDefault(){}});assert.equal(rawCalls.length,2);assert.equal(rawCalls[1].path,'/api/sales/price-labels/projects/export.pdf');
  assert.deepEqual(JSON.parse(rawCalls[1].options.body).project.labels[0].options.imageBoxes,saved.body.options.imageBoxes);
  f.q('library-select').value='other';f.q('library-select').handlers.get('change')();assert.equal(f.q('library-title').value,'Andere Vorlage');assert.equal(Number(f.settings.elements.labelWidthMm.value),70);
 } finally {f.workspace.destroy();}
});

function delayedArticleFixture(extra={}){
 const calls=[],base=editorApi(calls),reads=[];
 const f=editorFixture((path,options)=>{
  if(path!=='/api/sales/price-labels/articles')return base(path,options);
  return new Promise((resolve,reject)=>reads.push({selection:JSON.parse(options.body),signal:options.signal,resolve,reject}));
 },extra);
 const complete=(index,price='123.45')=>reads[index].resolve({items:reads[index].selection.articleNumbers.map(articleNumber=>({articleNumber,description:'Current '+articleNumber,priceGross:price})),updatedAt:'2026-10-05T10:00:00Z'});
 const choose=priceType=>{f.settings.elements.priceType.value=priceType;for(const event of ['input','change'])f.settings.handlers.get(event)({target:f.settings.elements.priceType});};
 return {...f,reads,complete,choose};
}
const settlePriceDebounce=()=>new Promise(resolve=>setTimeout(resolve,230));

test('Rapid price-type changes coalesce to the latest selection after a slow success or failure',async()=>{
 for(const fails of [false,true]){
  const f=delayedArticleFixture();await f.workspace.load();f.settings.elements.articleNumbers.value='001234';f.q('refresh').handlers.get('click')();
  f.choose('internet_1');await settlePriceDebounce();f.choose('internet_3');await settlePriceDebounce();
  assert.equal(f.reads.length,1,'No overlapping article reads while the first selection is outstanding');
  if(fails)f.reads[0].reject(Error('Obsolete sales failure'));else f.complete(0,'9999.99');
  await turn();assert.equal(f.reads.length,2);assert.equal(f.reads[1].selection.priceType,'internet_3');
  assert.equal(f.q('download').disabled,true);assert.doesNotMatch(f.q('status').textContent,/Obsolete/);
  f.complete(1,'12.34');await turn();assert.equal(f.q('download').disabled,false);assert.equal(f.q('refresh').disabled,false);
  assert.match(f.q('status').textContent,/aktuellen Bruttopreisen geladen/);assert.match(f.q('preview').children[0].innerHTML,/12,34/);assert.doesNotMatch(f.q('preview').children[0].innerHTML,/9\.999,99/);
  f.workspace.destroy();
 }
});

test('The latest price request may fail and be manually retried without stale prices or a stuck busy state',async()=>{
 const f=delayedArticleFixture();await f.workspace.load();f.settings.elements.articleNumbers.value='001234';f.q('refresh').handlers.get('click')();
 f.choose('internet_1');await settlePriceDebounce();f.complete(0);await turn();
 f.reads[1].reject(Error('Current request unavailable'));await turn();
 assert.equal(f.q('status').textContent,'Current request unavailable');assert.equal(f.q('refresh').disabled,false);assert.equal(f.q('download').disabled,true);
 f.q('refresh').handlers.get('click')();assert.equal(f.reads.length,3);assert.equal(f.reads[2].selection.priceType,'internet_1');
 f.complete(2);await turn();assert.equal(f.q('download').disabled,false);f.workspace.destroy();
});

test('Navigation aborts stale prices and resumes retained selection freshly; an account switch purges it',async()=>{
 for(const switchAccount of [false,true]){
  const f=delayedArticleFixture();await f.workspace.load();f.settings.elements.articleNumbers.value='001234';f.q('refresh').handlers.get('click')();
  f.choose('internet_1');await settlePriceDebounce();if(switchAccount)f.changeAccount();f.workspace.suspend();
  assert.equal(f.reads[0].signal.aborted,true);f.complete(0);await turn();await f.workspace.load();await turn();
  assert.equal(f.reads.length,switchAccount?1:2);assert.equal(f.q('download').disabled,true);
  if(!switchAccount){assert.equal(f.reads[1].selection.priceType,'internet_1');f.complete(1);await turn();}assert.equal(f.q('refresh').disabled,false);f.workspace.destroy();
 }
});

test('A queued price reload validates the latest article input instead of reusing the old selection',async()=>{
 const f=delayedArticleFixture();await f.workspace.load();f.settings.elements.articleNumbers.value='001234';f.q('refresh').handlers.get('click')();
 f.choose('internet_1');await settlePriceDebounce();f.settings.elements.articleNumbers.value='';f.settings.handlers.get('input')({target:f.settings.elements.articleNumbers});
 f.complete(0);await turn();assert.equal(f.reads.length,1);assert.match(f.q('status').textContent,/mindestens eine Artikelnummer/);
 assert.equal(f.q('download').disabled,true);assert.equal(f.q('refresh').disabled,false);f.workspace.destroy();
});

test('Changing price type during PDF creation also starts the queued article read after an export failure',async()=>{
 let rejectExport;const f=delayedArticleFixture({rawApi:()=>new Promise((_resolve,reject)=>{rejectExport=reject;})});
 await f.workspace.load();f.settings.elements.articleNumbers.value='001234';f.q('refresh').handlers.get('click')();f.complete(0);await turn();
 const exporting=f.q('export').handlers.get('submit')({preventDefault(){}});
 f.choose('internet_3');await settlePriceDebounce();assert.equal(f.reads.length,1);
 rejectExport(Error('PDF unavailable'));await exporting;assert.equal(f.reads.length,2);assert.equal(f.reads[1].selection.priceType,'internet_3');
 f.complete(1);await turn();assert.equal(f.q('download').disabled,false);f.workspace.destroy();
});
