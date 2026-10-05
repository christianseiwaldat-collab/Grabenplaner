'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const deferred = () => {let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function declaration(name) {
  const start=source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start>=0,name);
  return source.slice(start,source.indexOf('\n}',start)+2);
}
function fixture() {
  const detail={article:{articleNumber:'A'},prices:{trial:123}}, requests=[], renders=[], listeners={};
  const catalog={actorKey:'A',detailAccessKey:'A|read',requestId:1,detailRequestId:1,items:[{articleNumber:'A'}],
    selectedArticleNumber:'A',detail,detailLoading:false,detailError:'',limit:50,total:1,nextOffset:1,
    searchStarted:true,sort:'articleNumber',direction:'asc'};
  let actor='A', access='A|read', read=true, tools={trial:123}, invalidations=0, suspended=0;
  const noop=()=>{};
  const context={state:{salesArticleCatalog:catalog},Intl,URLSearchParams,
    elements:{salesArticleSearchForm:{reset:noop,reportValidity:()=>true,addEventListener:(event,fn)=>{listeners.submit=fn;}},
      salesArticleSearchReset:{addEventListener:(event,fn)=>{listeners.reset=fn;}},salesArticleSearchQuery:{focus:noop}},
    canReadSalesArticles:()=>read,applySalesArticleCatalogReadState:noop,
    currentSalesArticleCatalogActorKey:()=>actor,currentSalesArticleCatalogDetailAccessKey:()=>access,
    salesArticleWindowPreferences:{invalidate(){invalidations++;},suspend(){suspended++;}},salesArticleSearchWindow:{suspend(){suspended++;}},
    salesArticleDetailPreferences:{invalidate:noop},
    syncSalesArticleSearchWindow:noop,selectedSalesArticleColumns:()=>[{id:'articleNumber'}],
    renderSalesArticleColumnOptions:noop,renderSalesArticleCatalogHead:noop,renderSalesArticleCatalogRows:noop,
    closeSalesArticleManagementDialogs:noop,resetSalesArticleLastImportState:noop,
    setSalesArticleCatalogStatus:noop,setSalesArticleCatalogDetailStatus:noop,
    salesArticleCatalogFormValues:()=>({query:'new',status:'active'}),salesArticleCatalogSearchParameters:offset=>'offset='+offset,
    normalizeSalesArticleCatalogItem:value=>value,salesArticleCatalogItemKey:value=>value.articleNumber,
    salesArticleCatalogSort:()=>({sort:'articleNumber',direction:'asc'}),normalizeSalesArticleDetailPayload:value=>value,
    renderSalesArticleCatalogDetail(){tools={trial:0};renders.push('detail');},
    renderSalesArticleCatalogResults({detail=true}={}){renders.push('results');if(detail) context.renderSalesArticleCatalogDetail();},
    api(url){const pending=deferred();requests.push({url,...pending});return pending.promise;}};
  vm.createContext(context);
  for(const name of ['resetSalesArticleCatalogDetailState','loadSalesArticleCatalog','loadSalesArticleCatalogDetail',
    'resetSalesArticleCatalogSearch','syncSalesArticleCatalogActorState','clearSalesArticleCatalogState']) {
    vm.runInContext(declaration(name),context);
  }
  const start=source.indexOf('elements.salesArticleSearchForm?.addEventListener("submit"');
  vm.runInContext(source.slice(start,source.indexOf('elements.salesArticleResults?.addEventListener',start)),context);
  return {context,catalog,detail,requests,renders,listeners,get tools(){return tools;},get invalidations(){return invalidations;},get suspended(){return suspended;},
    actor(value){actor=value;access=value+'|read';},access(value){access=value;},read(value){read=value;access='A|'+value;}};
}

test('A new search preserves the selected article and mounted trial controls during loading, empty results and failures',async()=>{
  for(const result of ['empty','different','error']) {
    const f=fixture(), originalTools=f.tools, ticket=f.catalog.detailRequestId;
    const pending=f.context.loadSalesArticleCatalog({reset:true});
    assert.equal(f.catalog.detail,f.detail);assert.equal(f.catalog.selectedArticleNumber,'A');assert.equal(f.tools,originalTools);
    if(result==='error') f.requests[0].reject(new Error('search unavailable'));
    else f.requests[0].resolve({items:result==='empty'?[]:[{articleNumber:'B'}],total:result==='empty'?0:1});
    await pending;
    assert.equal(f.catalog.detail,f.detail,result);assert.equal(f.catalog.selectedArticleNumber,'A',result);
    assert.equal(f.tools,originalTools,result);assert.equal(f.catalog.detailRequestId,ticket,result);
    assert.equal(f.renders.includes('detail'),false,result);
    assert.equal(f.catalog.loading,false);
    if(result==='error') assert.equal(f.catalog.error,'search unavailable');
  }
});

test('Actual search reset cancels old results and resets filters without removing the open article or its controls',async()=>{
  const f=fixture(), originalTools=f.tools;
  const pending=f.context.loadSalesArticleCatalog({reset:true});
  f.listeners.reset();
  assert.equal(f.catalog.query,'');assert.equal(f.catalog.searchStarted,false);assert.equal(f.catalog.loading,false);
  assert.equal(f.catalog.detail,f.detail);assert.equal(f.tools,originalTools);
  f.requests[0].resolve({items:[{articleNumber:'B'}],total:1});await pending;
  assert.equal(f.catalog.items.length,0);assert.equal(f.catalog.detail,f.detail);assert.equal(f.tools,originalTools);
  f.listeners.submit({preventDefault(){}});
  f.requests[1].resolve({items:[],total:0});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.catalog.detail,f.detail);assert.equal(f.tools,originalTools);
});

test('Only explicit article selection replaces the detail and a concurrent new search does not cancel that selection',async()=>{
  const f=fixture();
  const selectingB=f.context.loadSalesArticleCatalogDetail('B');
  assert.equal(f.catalog.selectedArticleNumber,'B');assert.equal(f.catalog.detail,null);
  const searching=f.context.loadSalesArticleCatalog({reset:true});
  f.requests[1].resolve({items:[{articleNumber:'C'}],total:1});await searching;
  assert.equal(f.catalog.selectedArticleNumber,'B');assert.equal(f.catalog.detailLoading,true);
  const detailB={article:{articleNumber:'B'}};f.requests[0].resolve(detailB);await selectingB;
  assert.equal(f.catalog.detail,detailB);
  const selectingC=f.context.loadSalesArticleCatalogDetail('C');
  const selectingD=f.context.loadSalesArticleCatalogDetail('D');
  f.requests[3].resolve({article:{articleNumber:'D'}});await selectingD;
  f.requests[2].resolve({article:{articleNumber:'C'}});await selectingC;
  assert.equal(f.catalog.selectedArticleNumber,'D');assert.equal(f.catalog.detail.article.articleNumber,'D');
});

test('Account changes, READ revocation, price-right changes and logout remove details and reject stale search/selection replies',async()=>{
  for(const reason of ['account','read','prices','logout']) {
    const f=fixture(), selection=f.context.loadSalesArticleCatalogDetail('B'), search=f.context.loadSalesArticleCatalog({reset:true});
    if(reason==='account') f.actor('other');
    if(reason==='read') f.read(false);
    if(reason==='prices') f.access('A|read|without-costs');
    if(reason==='logout') f.context.clearSalesArticleCatalogState('Session ended');
    else f.context.syncSalesArticleCatalogActorState();
    assert.equal(f.catalog.selectedArticleNumber,'',reason);assert.equal(f.catalog.detail,null,reason);
    assert.equal(f.catalog.detailLoading,false,reason);assert.equal(f.invalidations,1,reason);
    f.requests[0].resolve({article:{articleNumber:'B'},costs:{secret:42}});
    f.requests[1].resolve({items:[{articleNumber:'B',costs:42}],total:1});await selection;await search;
    assert.equal(f.catalog.detail,null,reason);assert.equal(f.catalog.selectedArticleNumber,'',reason);assert.equal(f.catalog.items.length,0,reason);
    if(reason==='prices') {assert.equal(f.requests.length,3);f.requests[2].resolve({items:[],total:0});await new Promise(resolve=>setImmediate(resolve));}
    if(reason==='logout') assert.equal(f.suspended,2);
  }
});
