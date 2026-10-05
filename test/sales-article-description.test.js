'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {projectSalesArticleSourceField,loadSalesArticleDetailData}=require('../lib/sales-article-detail-source');
const UI=require('../public/sales-article-layout');
const keys=['AKurzbeschreibung','ALieferumfang','ShopText','Meldungstext'];
const field=(id,value)=>projectSalesArticleSourceField(id,'Beschreibung',value);
test('Only the four description fields gain safe previews; original values and unrelated source fields are unchanged',()=>{
  const raw='<p class="source" onclick="bad()">Text &amp; <strong>Format</strong></p><img src="https://example.invalid/x">';
  for(const id of keys){const value=field(id,raw);assert.equal(value.value,raw);assert.equal(value.id,id);assert.equal(value.richText.format,'gp-article-description-v1');
    assert.equal(value.richText.html,'<p>Text &amp; <strong>Format</strong></p>');assert.equal(value.richText.text,'Text & Format');}
  for(const id of ['Suchname','Marke','Bestelldaten','LBemerkung','Erklärung'])assert.deepEqual(field(id,raw),{id,label:'Beschreibung',value:raw});
  const oversized='ö'.repeat(20000),projected=field(keys[0],oversized);
  assert.equal(projected.value,oversized);assert.equal(projected.richText.truncated,true);
});
test('Renderer defaults genuine markup to HTML and renders decoded multiline text without unnecessary controls',()=>{
  const html=UI.fieldValue(field(keys[0],'<strong>Text</strong>'));
  assert.match(html,/data-description-view="html"><strong>Text<\/strong>/);
  assert.match(html,/data-description-mode="html" aria-pressed="true"/);
  assert.match(html,/data-description-view="text" hidden>Text/);
  const plain=UI.fieldValue(field(keys[1],'Zeile 1 &amp; Zubehör\n  Zeile 2'));
  assert.match(plain,/Zeile 1 &amp; Zubehör\n  Zeile 2/);assert.doesNotMatch(plain,/data-description-mode/);
  const encoded=UI.fieldValue(field(keys[2],'&lt;img src=x onerror=alert(1)&gt;'));
  assert.doesNotMatch(encoded,/<img\b|data-description-mode/);assert.match(encoded,/&lt;img/);
  assert.equal(UI.fieldValue({id:'Suchname',value:'<b>Quelle</b>',richText:field(keys[0],'<b>WRONG</b>').richText}),'&lt;b&gt;Quelle&lt;/b&gt;');
});
test('Fully removed content is compact and neutral; shortened previews are labeled',()=>{
  const empty=UI.fieldValue(field(keys[3],'<script>bad()</script><iframe src="https://example.invalid/"></iframe>'));
  assert.match(empty,/Kein darstellbarer Inhalt/);assert.doesNotMatch(empty,/data-description-mode|data-description-view|<script|iframe/);
  const shortened=UI.fieldValue(field(keys[0],'Text '.repeat(10000)));
  assert.match(shortened,/Gekürzte Vorschau/);assert.doesNotMatch(shortened,/data-description-mode/);
});
test('Each mounted description switch changes only its own DOM visibility and retains other detail controls',()=>{
  function makeField(){
    const listeners=[],node={dataset:{},views:[],buttons:[],addEventListener(type,handler){assert.equal(type,'click');listeners.push(handler);},
      querySelectorAll(selector){if(selector==='[data-description-view]')return this.views;if(selector==='[data-description-mode]')return this.buttons;throw Error('Unexpected selector');}};
    node.views=['html','text'].map(mode=>({dataset:{descriptionView:mode},hidden:mode!=='html'}));
    node.buttons=['html','text'].map(mode=>({dataset:{descriptionMode:mode},attributes:{'aria-pressed':String(mode==='html')},
      closest(selector){if(selector==='[data-description-mode]')return this;if(selector==='[data-description-field]')return node;return null;},
      setAttribute(key,value){this.attributes[key]=value;}}));
    node.click=mode=>listeners.forEach(handler=>handler({target:node.buttons.find(button=>button.dataset.descriptionMode===mode)}));
    node.listenerCount=()=>listeners.length;return node;
  }
  const a=makeField(),b=makeField();
  const root={querySelectorAll(selector){assert.equal(selector,'[data-description-field]');return [a,b];},
    set innerHTML(value){throw Error('Must not remount the detail');}};
  UI.mountDescriptions(root);UI.mountDescriptions(root);assert.equal(a.listenerCount(),1);
  a.click('text');assert.deepEqual(a.views.map(view=>view.hidden),[true,false]);assert.deepEqual(b.views.map(view=>view.hidden),[false,true]);
  assert.deepEqual(a.buttons.map(button=>button.attributes['aria-pressed']),['false','true']);
  a.click('html');assert.deepEqual(a.views.map(view=>view.hidden),[false,true]);
});
test('Imported descriptions are projected without source mutation, extra rights or changes to neighboring master fields',async t=>{
  const f=await require('../test-support/trade-insights-sqlite').fixture(t);
  const {article,master}=await require('../test-support/sales-article-workspace-fixture').seedWorkspace({access:f.app.provider,source:f});
  const input={...master,AKurzbeschreibung:'<h3>Gerät</h3><p onclick="bad()">Sicher <b>formatiert</b></p>',
    ALieferumfang:'Gerät\nHandbuch',ShopText:'<svg><script>bad()</script></svg>',Meldungstext:'<p>Hinweis &amp; Zubehör</p>',LBemerkung:'<p>Unveränderte Lieferantenbemerkung</p>'};
  await f.ingest('ARTIKEL_STAMM',[input],{master:true,snapshotAt:'2026-10-05T09:00:00.000Z'});
  const load=projection=>loadSalesArticleDetailData({access:f.app.provider,vault:f.vault,article,projection});
  const result=await load({read:true}),description=result.sourceSections.find(section=>section.id==='description');
  assert.deepEqual(description.fields.map(value=>value.id),keys);
  for(const value of description.fields)assert.equal(value.value,input[value.id]);
  assert.equal(description.fields[0].richText.html,'<h3>Gerät</h3><p>Sicher <b>formatiert</b></p>');
  assert.equal(description.fields[1].richText.text,'Gerät\nHandbuch');assert.equal(description.fields[2].richText.html,'');
  assert.equal(result.sourceSections.find(section=>section.id==='supplier').fields.find(value=>value.id==='LBemerkung').richText,undefined);
  assert.equal(result.priceMatrix.purchase,null);assert.equal(result.priceMatrix.sales,null);
  assert.deepEqual((await load({read:false})).sourceSections,[]);
  assert.deepEqual((await load({read:true})).sourceSections,result.sourceSections);
});
