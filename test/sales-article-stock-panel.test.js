'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const model=require('../public/sales-article-detail-preferences'),layout=require('../public/sales-article-layout'),panel=require('../public/sales-article-stock-panel');
const formats={timestamp:value=>value,money:value=>value,date:value=>value};
const stock={rows:[{id:'18',name:'Nord',quantity:'3',ordered:'4',orders:{state:'recorded',items:[{number:'BE-123',remaining:'4',sourceAt:'2026-10-01'}]}},
  {id:'19',name:'Süd',quantity:'0',ordered:null,orders:{state:'restricted',items:[]}}]};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function events() {
  const listeners=new Map();return {addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);},
    removeEventListener(type,fn){listeners.get(type)?.delete(fn);},fire(type,event){for(const fn of listeners.get(type)||[])fn(event);},
    get listeners(){return [...listeners.values()].reduce((n,set)=>n+set.size,0);}};
}
function fixture({load=()=>Promise.resolve({...model.defaults(),configured:false})}={}) {
  const requests=[],errors=[],window=events(),document={activeElement:null,defaultView:window};window.visualViewport=events();
  let allowed=true,key='A',html='',controls=[],chooser={open:false},writes=0,tableOptions=null,tableDestroyed=0;
  const host={...events(),ownerDocument:document,hidden:false,contains:node=>controls.includes(node),
    querySelector:selector=>selector==='[data-stock-settings]'?chooser:selector==='table'?{}:null,
    querySelectorAll:selector=>controls.filter(node=>node.hasAttribute(selector.slice(1,-1))),replaceChildren(){html='';controls=[];},
    get innerHTML(){return html;},set innerHTML(value){html=value;writes++;chooser={open:false};controls=[];
      for(const match of value.matchAll(/<(input|button)\b([^>]*)>/g)) {
        const attrs=Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map(found=>[found[1],found[2]]));
        for(const attr of match[2].matchAll(/\b(data-[\w-]+)(?=\s|$)/g)) attrs[attr[1]]='';
        const node={checked:/\bchecked\b/.test(match[2]),disabled:/\bdisabled\b/.test(match[2]),getAttribute:name=>attrs[name],hasAttribute:name=>Object.hasOwn(attrs,name),
          closest(selector){return this.hasAttribute(selector.slice(1,-1))?this:null;},focus(){document.activeElement=this;}};controls.push(node);
      }
    }};
  const store=model.createStore({key:()=>key,canUse:()=>allowed,error:error=>errors.push(error),api(url,options){requests.push({url,options});return options.method?Promise.resolve({}):load();}});
  const controller=panel.mount(host,{store,stock,formats,layout,columns:model.COLUMNS,canUse:()=>allowed && key==='A',
    tableLayout:{attach(table,options){tableOptions=options;return {destroy(){tableDestroyed++;}};}}});
  return {host,store,controller,requests,errors,document,window,get chooser(){return chooser;},get writes(){return writes;},get table(){return tableOptions;},get tableDestroyed(){return tableDestroyed;},
    find(attribute,value){return controls.find(node=>node.getAttribute(attribute)===value);},permit(value){allowed=value;},key(value){key=value;}};
}
test('Stock is placed between master data and photo; new branches show while saved exclusions remain article independent',()=>{
  const article={articleNumber:'A',active:true,currentRevision:1,description:'Demo',prices:{sales:[]},identifiers:[],provenance:{updatedAt:'2026-10-01'},branchStock:stock};
  const overview=layout.overview(article,formats);
  assert.ok(overview.indexOf('id="salesArticleMasterDataSection"')<overview.indexOf('id="salesArticleBranchStock"'));
  assert.ok(overview.indexOf('id="salesArticleBranchStock"')<overview.indexOf('id="salesArticlePhotoSlot"'));
  const prefs={...model.defaults(),hiddenBranchIds:['18','other-article-branch']};
  const html=layout.branchStock({rows:[...stock.rows,{id:'20',name:'New',quantity:'1'}]},formats,prefs);
  const body=html.slice(html.indexOf('<tbody>'));
  assert.doesNotMatch(body,/Nord/);assert.match(body,/Süd/);assert.match(body,/New/);
  assert.deepEqual(prefs.hiddenBranchIds,['18','other-article-branch']);
  assert.match(html,/2 \/ 3/);assert.match(layout.branchStock(stock,formats,{...prefs,hiddenBranchIds:['18','19']}),/Alle Filialen sind ausgeblendet/);
});
test('Visible columns control markup, quantities sort numerically and restricted BE information never becomes visible',()=>{
  const prefs={...model.defaults(),columns:['quantity','ordered'],sort:'quantity',direction:'desc'};
  const html=layout.branchStock(stock,formats,prefs),head=html.slice(html.indexOf('<thead>'),html.indexOf('</thead>'));
  assert.doesNotMatch(head,/data-stock-cell="branch"/);assert.match(head,/aria-sort="descending"/);
  assert.match(html,/BE BE-123 · Rest 4/);assert.match(html,/Einkaufsrecht für diese Filiale erforderlich/);
  const values={rows:[{id:'1',quantity:'10'},{id:'2',quantity:'2'},{id:'3',quantity:null}]};
  const body=layout.branchStock(values,formats,{...model.defaults(),sort:'quantity'}).split('<tbody>')[1];
  assert.ok(body.indexOf('aria-label="2:')<body.indexOf('aria-label="1:'));assert.ok(body.indexOf('aria-label="1:')<body.indexOf('aria-label="3:'));
  const malicious=layout.branchStock({rows:[{id:'<img>',name:'"><script>alert(1)</script>',quantity:null,ordered:'999',orders:{state:'restricted',items:[{number:'PRIVATE'}]}}]},formats);
  assert.doesNotMatch(malicious,/<script>|<img>|PRIVATE|999/);assert.match(malicious,/&lt;script&gt;/);
});
test('Branch and column controls keep the chooser open, preserve focus, retain hidden widths and prevent zero columns',async()=>{
  const f=fixture();await f.store.activate();f.chooser.open=true;
  const branch=f.find('data-stock-branch','19');branch.checked=false;branch.focus();f.host.fire('change',{target:branch});await tick();
  assert.deepEqual(f.store.value.hiddenBranchIds,['19']);assert.equal(f.chooser.open,true);
  assert.equal(f.document.activeElement.getAttribute('data-stock-branch'),'19');
  const before=f.writes;f.table.change({branch:145,ordered:120});assert.equal(f.writes,before,'pointer width changes must not rebuild the table');
  const count=f.requests.length;assert.equal(count,2);f.table.persist();await tick();assert.equal(f.requests.length,3);
  for(const id of ['branch','ordered']) {const control=f.find('data-stock-column',id);control.checked=false;f.host.fire('change',{target:control});}
  assert.deepEqual(f.store.value.columns,['quantity']);assert.equal(f.store.value.sort,'quantity');
  assert.deepEqual(f.store.value.columnWidths,{branch:145,ordered:120});
  const last=f.find('data-stock-column','quantity');assert.equal(last.disabled,true);last.checked=false;f.host.fire('change',{target:last});assert.equal(last.checked,true);
  assert.deepEqual(f.store.value.columns,['quantity']);
  // The all-branches button has a boolean attribute; invoke its native closest contract.
  f.host.fire('click',{target:{closest:selector=>selector==='[data-stock-all]'?{}:null}});await tick();
  assert.deepEqual(f.store.value.hiddenBranchIds,[]);
  f.controller.destroy();assert.equal(f.host.listeners,0);assert.equal(f.window.listeners,0);assert.equal(f.window.visualViewport.listeners,0);
});
test('Changed rights/account clear the mounted panel and prevent all further interactions and writes',async()=>{
  for(const reason of ['rights','account']) {
    const f=fixture();await f.store.activate();const old=f.find('data-stock-branch','18');
    if(reason==='rights')f.permit(false);else f.key('B');
    f.store.invalidate();assert.equal(f.host.hidden,true);assert.equal(f.host.innerHTML,'');
    old.checked=false;f.host.fire('change',{target:old});f.table.persist();await tick();
    assert.equal(f.requests.length,1,reason);assert.deepEqual(f.store.value,model.defaults());
    f.controller.destroy();
  }
});

test('Initial loading disables every preference control and blocks stale events and resize callbacks',async()=>{
  const pending=deferred(),f=fixture({load:()=>pending.promise}),loading=f.store.activate();
  for(const [attribute,value] of [['data-stock-branch','19'],['data-stock-column','branch'],['data-stock-sort','quantity'],['data-stock-all','']]) {
    assert.equal(f.find(attribute,value).disabled,true,attribute);
  }
  assert.equal(f.table.canResize(),false);assert.match(f.host.innerHTML,/role="status"/);
  const branch=f.find('data-stock-branch','19');branch.checked=false;f.host.fire('change',{target:branch});
  const column=f.find('data-stock-column','branch');column.checked=false;f.host.fire('change',{target:column});
  f.host.fire('click',{target:f.find('data-stock-sort','quantity')});f.host.fire('click',{target:f.find('data-stock-all','')});
  f.table.change({branch:300});f.table.persist();await tick();assert.equal(f.requests.length,1);assert.deepEqual(f.store.value,model.defaults());
  assert.equal(f.requests[0].options.signal.aborted,false);
  const baseline={...model.defaults(),hiddenBranchIds:['18'],columns:['branch','quantity'],columnWidths:{branch:230},sort:'quantity',direction:'desc'};
  pending.resolve({...baseline,configured:true});await loading;
  assert.equal(f.find('data-stock-branch','19').disabled,false);assert.equal(f.table.canResize(),true);
  const next=f.find('data-stock-branch','19');next.checked=false;f.host.fire('change',{target:next});await tick();
  assert.deepEqual(JSON.parse(f.requests[1].options.body),{...baseline,hiddenBranchIds:['18','19']});
  assert.doesNotMatch(f.host.innerHTML,/Ansichtseinstellungen werden geladen/);f.controller.destroy();
});

test('An initial load failure offers a native retry while all preference writes stay blocked',async()=>{
  const first=deferred(),second=deferred();let attempts=0;
  const f=fixture({load:()=>++attempts===1?first.promise:second.promise}),loading=f.store.activate();
  first.reject(Error('offline'));await loading;
  assert.match(f.host.innerHTML,/role="alert"/);const retry=f.find('data-stock-preferences-retry','');assert.equal(retry.disabled,false);
  assert.equal(f.find('data-stock-branch','19').disabled,true);assert.equal(f.table.canResize(),false);
  f.table.change({branch:300});f.table.persist();await f.store.activate();assert.equal(f.requests.length,1);
  f.host.fire('click',{target:retry});await tick();assert.equal(f.requests.length,2);assert.equal(f.store.ready,false);
  assert.match(f.host.innerHTML,/Ansichtseinstellungen werden geladen/);
  const baseline={...model.defaults(),hiddenBranchIds:['18'],columnWidths:{branch:230}};
  second.resolve({...baseline,configured:true});await tick();assert.equal(f.store.ready,true);assert.equal(f.store.failed,false);
  assert.doesNotMatch(f.host.innerHTML,/role="alert"|data-stock-preferences-retry/);
  const branch=f.find('data-stock-branch','19');branch.checked=false;f.host.fire('change',{target:branch});await tick();
  assert.deepEqual(JSON.parse(f.requests[2].options.body),{...baseline,hiddenBranchIds:['18','19']});assert.equal(f.errors.length,1);
  f.controller.destroy();
});
