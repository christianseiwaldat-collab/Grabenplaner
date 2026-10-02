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

function editorFixture(api){
 const elements=new Map(),node=()=>({value:'',checked:false,disabled:false,hidden:false,textContent:'',children:[],handlers:new Map(),
  classList:{add(){},toggle(){}},style:{setProperty(){}},addEventListener(type,fn){this.handlers.set(type,fn);},removeEventListener(type){this.handlers.delete(type);},
  replaceChildren(...children){this.children=children;},append(...children){this.children.push(...children);},focus(){},select(){},
  querySelector(selector){if(!this.matches)this.matches=new Map();if(!this.matches.has(selector))this.matches.set(selector,node());return this.matches.get(selector);},querySelectorAll(){return [];}});
 const q=key=>{if(!elements.has(key))elements.set(key,node());return elements.get(key);};
 const settings=q('settings');settings.elements=Object.fromEntries([...Object.keys(Editor.defaults),'articleNumbers','priceType'].map(key=>[key,node()]));settings.elements.priceType.value='sales';
 q('export').elements=Object.fromEntries(['name','stamp','position','separator','suffix'].map(key=>[key,node()]));q('export').elements.name.value='Preisschilder';
 let account='account-one';
 const root={isConnected:true,classList:{add(){}},querySelector(selector){const match=/\[data-pl="([^"]+)"\]/.exec(selector);return q(match?.[1]||selector);},querySelectorAll(){return [];},replaceChildren(){},
  ownerDocument:{createElement:node}};
 const workspace=Editor.mount(root,{api,rawApi:async()=>{},accessKey:()=>account});
 return {workspace,settings,q,changeAccount(){account='account-two';}};
}
function editorApi(calls,{delayFirstDefaults}={}){
 let defaultReads=0;
 return async(path,options)=>{
  calls.push({path,options});
  if(path==='/api/sales/price-labels/templates'){defaultReads++;if(defaultReads===1&&delayFirstDefaults)return delayFirstDefaults;return {options:{...Editor.defaults},filenameOptions:{stamp:'none',position:'before',separator:'-',suffix:''}};}
  if(path==='/api/sales/price-labels/branding')return {kits:[]};
  if(path==='/api/sales/price-labels/library')return {templates:[],capabilities:{create:true,ownBranch:false},recipients:[]};
  if(path.startsWith('/api/sales/price-labels/library/'))return {...template(path.split('/').at(-1)),version:1,visibility:'private',recipients:[],options:{...Editor.defaults},filenameOptions:{stamp:'none',position:'before',separator:'-',suffix:''},received:path.endsWith('/shared')};
  if(path==='/api/sales/price-labels/articles'){const {articleNumbers}=JSON.parse(options.body);return {items:articleNumbers.map(articleNumber=>({articleNumber,description:'Fresh '+articleNumber,priceGross:'123.45'})),updatedAt:'2026-10-02T10:00:00Z'};}
  throw Error('Unexpected API '+path);
 };
}

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
