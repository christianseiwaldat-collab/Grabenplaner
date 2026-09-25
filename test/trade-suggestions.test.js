'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('../test-support/trade-insights-sqlite'),{seedSuggestions}=require('../test-support/trade-suggestions-fixture');
const {assess,recommend}=require('../lib/persistence/repositories/trade-suggestions');
async function all(f,q={}){const rows=[];let cursor=null,pages=0;do{const r=await f.run('suggestions',{...q,...(cursor?{cursor}:{})});rows.push(...r.rows);cursor=r.next;if(++pages>20)throw Error('Unexpected paging');}while(cursor);return rows;}
test('derived hints explain transfer, restock, stock reduction and existing inflow without inventing quantities',async t=>{
 const f=await fixture(t);await seedSuggestions(f);const rows=await all(f),r=(article,branch='18')=>rows.find(r=>r.articleNumber===article&&r.sourceLocation===branch);
 assert.equal(r('000042').type,'transfer');assert.equal(r('000042').donors[0].sourceLocation,'19');assert.equal(r('000042').donors[0].stock,'8');assert.equal(r('000042').soldNet,'4');assert.equal(r('000043').type,'restock');assert.equal(r('000044','19').type,'clearance');assert.equal(r('000045').type,'incoming');assert.equal(r('000046').type,'blocked');assert.match(r('000046').reason,/Lagerware/);assert.ok(rows.every(r=>r.availableTransferQuantity===null));assert.equal(new Set(rows.map(r=>r.id)).size,rows.length);assert.doesNotMatch(JSON.stringify(rows),/VK_Preis|Rohertrag|RechnungsBetrag/);
 const ui=require('../public/trade-suggestions'),model=require('../public/trade-insight-results'),unsafe={...r('000042'),label:'<img onerror=evil()>'};assert.doesNotMatch(ui.detail(unsafe,model,{}),/<img|data-suggestion-related="movements"/);assert.match(ui.detail(unsafe,model,{purchasing:true}),/data-suggestion-related="movements"/);assert.match(ui.detail(unsafe,model,{}),/&lt;img/);
 const exact=await f.run('suggestions',{articleNumber:'000042'});assert.equal(exact.scanned,2);assert.equal(exact.next,null);assert.deepEqual(exact.rows,rows.filter(r=>r.articleNumber==='000042'));assert.deepEqual(await all(f,{articleNumber:'42'}),[]);assert.deepEqual(await all(f,{articleNumber:'000042',query:'Reisestativ'}),[]);
 assert.equal((await all(f,{suggestionType:'transfer'})).length,1);assert.equal((await all(f,{query:'Reisestativ'}))[0].articleNumber,'000043');
});
test('stale, future, short and mismatched dates cannot become operational hints',async t=>{
 const f=await fixture(t);await seedSuggestions(f,{snapshotAt:'2026-09-01T09:00:00.000Z'});const rows=await all(f);assert.ok(rows.length);assert.ok(rows.every(r=>r.type==='blocked'&&r.soldNet===null));assert.match(rows[0].reason,/älter als 7 Tage/);
 const r=assess([{locationId:'18',stock:'4'}],{complete:true,coverage:true,stats:{stock:{},unverified:0,denied:0,unknownStock:0}},{from:'2026-09-10',to:'2026-09-15',stockDate:'2026-09-14',today:'2026-09-13',confirmed:true,reference:true});assert.match(r.reasons.join(' '),/Zukunft/);assert.match(r.reasons.join(' '),/28 Tage/);assert.match(r.reasons.join(' '),/Verkaufsende/);
});
test('exact article keys prevent numeric aliases from inflating sales; duplicate stocks remain review cases',async t=>{
 const f=await fixture(t);await seedSuggestions(f,{extraSales:[{date:'2026-09-14',branch:'18',articleNumber:'42',quantity:'100'}]});const rows=await all(f,{query:'000042'});assert.ok(rows.length);assert.ok(rows.every(r=>r.type==='blocked'));assert.match(rows[0].reason,/Artikel-\/Filialzuordnung/);
 const assessment=assess([{id:'1',locationId:'18',stock:'2'},{id:'2',locationId:'18',stock:'3'}],null,{from:'2026-06-17',to:'2026-09-14',stockDate:'2026-09-14',today:'2026-09-14',confirmed:true,reference:true});assert.match(assessment.reasons.join(' '),/Bestandszuordnung/);assert.equal(recommend(assessment.evidence[0],assessment.evidence,assessment).type,'blocked');
});
test('large receipt pages resume once and preserve returns without duplicate recommendations',async t=>{
 const f=await fixture(t);await seedSuggestions(f,{extraSales:Array.from({length:220},(_,i)=>({date:'2026-09-13',branch:'18',articleNumber:'000042',quantity:i===219?'-2':'1'}))});const rows=await all(f,{articleNumber:'000042'});assert.equal(rows.length,2);assert.equal(rows.find(r=>r.type==='transfer').soldNet,'221');
});
test('company and inventory grants, source changes, durable snapshots and PDF stay protected',async t=>{
 const f=await fixture(t),{stockRun}=await seedSuggestions(f),base=f.state.session;
 f.state.session={...base,permissions:base.permissions.filter(p=>!p.includes('company')),scopes:[{locationId:'18'}]};assert.deepEqual((await f.run('suggestions')).rows,[]);
 f.state.session={...base,permissions:base.permissions.filter(p=>p!=='sales:analytics:inventory:read')};await assert.rejects(f.run('suggestions'),e=>e.status===403);f.state.session=base;
 const jobs=require('../lib/persistence/repositories/trade-insight-jobs').createTradeInsightJobs({access:f.app.provider,vault:f.vault,runtime:f.runtime,resolvePrincipal:async()=>f.state.session});t.after(()=>jobs.stop());
 const j=await jobs.create(base,{kind:'suggestions',query:{},title:'Handlungshinweise · Synthetische Abnahme'});for(let i=0;i<4;i++)await jobs.tick();const saved=await jobs.get(base,j.id);
 await f.engine.undo(stockRun.id,stockRun.revision);assert.deepEqual((await jobs.get(base,j.id)).result,saved.result);assert.equal((await f.run('suggestions')).available,false);
 const pdf=await require('../lib/trade-insight-pdf').createTradeInsightPdf(saved,{sort:'stock',direction:'desc'});assert.equal(pdf.subarray(0,4).toString(),'%PDF');
});
