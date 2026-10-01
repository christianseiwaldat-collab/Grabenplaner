'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const P=require('../public/data-import-progress'),UI=require('../public/data-import');
const start='2026-09-30T10:48:15.000Z';
function source(){return {id:'synthetic',status:'applying',complete:true,active:true,createdAt:start,readCompletedAt:'2026-09-30T10:50:15.000Z',updatedAt:'2026-09-30T21:31:02.000Z',
 background:{phase:'applying',status:'applying',createdAt:start},currentStep:{table:'ARTIKEL_STAMM',phase:'reviewing'},
 progress:{operation:'apply',startedAt:start,phaseStartedAt:'2026-09-30T21:00:00.000Z'},
 tables:[{name:'Earlier',declaredRows:115579,run:{status:'applied',receivedRows:115579}},
 {name:'ARTIKEL_STAMM',declaredRows:19584,run:{id:'articles',status:'reviewing',receivedRows:19584,counts:{staged:6820,unchanged:10956,update:1808}}}]};}
test('review progress advances while the completed takeover counter remains unchanged',()=>{
 const data=source(),first=P.metrics(data),main=first.find(m=>m.id==='applying'),table=first.find(m=>m.id.startsWith('table:'));
 assert.equal(main.value,115579);assert.equal(table.value,12764);assert.equal(table.total,19584);
 const html=UI.renderSource(data,{});assert.match(html,/ARTIKEL_STAMM · Prüfung/);assert.match(html,/65,2 %/);assert.match(html,/Vergangen:/);assert.match(html,/Restzeit:/);
 data.tables[1].run.counts.staged-=46;
 assert.equal(P.metrics(data).find(m=>m.id==='applying').value,115579);
 assert.equal(P.metrics(data).find(m=>m.id.startsWith('table:')).value,12810);
});
test('rest time needs sustained real progress and expires when measurements stop',()=>{
 let now=Date.parse('2026-10-01T00:00:00Z');const tracker=P.createTracker({now:()=>now});
 const m={key:'phase',value:0,total:1000,active:true,startedAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()};
 assert.equal(tracker.describe(m).remainingMs,null);
 now+=10000;m.value=10;m.updatedAt=new Date(now).toISOString();assert.equal(tracker.describe(m).remainingMs,null);
 now+=10000;m.value=20;m.updatedAt=new Date(now).toISOString();const measured=tracker.describe(m);
 assert.equal(measured.remainingMs,980000);assert.equal(measured.elapsedMs,20000);
 now+=31000;assert.equal(tracker.describe(m).remainingMs,null,'stale throughput must not keep claiming a remaining time');
});
test('pause, rollback, a new phase and completion never reuse an inappropriate estimate',()=>{
 let now=Date.parse(start);const tracker=P.createTracker({now:()=>now});
 const m={key:'phase',value:0,total:100,active:true,startedAt:start};
 for(let n=0;n<3;n++){m.value=n*10;m.updatedAt=new Date(now).toISOString();tracker.describe(m);now+=10000;}
 assert.ok(tracker.describe(m).remainingMs>0);
 m.active=false;assert.equal(tracker.describe(m).remainingMs,null);
 m.active=true;m.value=5;assert.equal(tracker.describe(m).remainingMs,null);
 m.phase='apply';assert.equal(tracker.describe(m).remainingMs,null);
 m.complete=true;m.finishedAt=new Date(now).toISOString();assert.equal(tracker.describe(m).percent,100);assert.equal(tracker.describe(m).remainingMs,0);
});
test('unknown cash progress is indeterminate, completed legacy timings are not invented, and labels are escaped',()=>{
 const data=source();data.storage='cash-compact-v1';data.tables=[];data.cashPublication={active:false};
 const html=P.render(data);assert.match(html,/Kassenstand freigeben/);assert.match(html,/Prozent wird ermittelt/);
 assert.match(html,/<progress max="1" aria-label="Kassenstand freigeben">/);
 delete data.readCompletedAt;assert.equal(P.createTracker().describe(P.metrics(data)[0]).elapsedMs,null);
 const unsafe=source();unsafe.tables[1].name='<script>alert(1)</script>';unsafe.currentStep.table=unsafe.tables[1].name;
 assert.doesNotMatch(P.render(unsafe),/<script>/);assert.match(P.render(unsafe),/&lt;script&gt;/);
 assert.equal(P.duration(NaN),'–');assert.equal(P.duration(-1),'–');assert.equal(P.duration(65000),'1 Min 5 Sek');
});

test('initial review and catalog work expose their own progress with the correct denominator',()=>{
 const data=source();data.status='reviewing';data.background.phase='reviewing';
 assert.ok(P.metrics(data).some(metric=>metric.id.startsWith('table:')));
 assert.doesNotMatch(P.render(data),/Der Gesamtzähler steigt/);
 data.status='applying';data.background.phase='applying';data.currentStep={table:'Artikelkatalog',phase:'applying'};
 data.catalog={after:20,total:45,blocked:5,complete:false,batches:[]};
 const catalog=P.metrics(data).find(metric=>metric.id==='catalog');assert.equal(catalog.total,40);assert.equal(P.createTracker().describe(catalog).percent,50);
 data.currentStep.phase='reverting';data.status='reverting';delete data.background;
 data.catalog.batches=[{reverted:true},{reverted:false}];
 const undo=P.metrics(data).find(metric=>metric.id==='catalog-undo');assert.equal(undo.value,1);assert.equal(undo.total,2);assert.match(P.render(data),/1 \/ 2 Pakete/);
});

test('a completed cash publication never borrows the earlier review timing',()=>{
 const data=source();data.storage='cash-compact-v1';data.cashPublication={active:true};delete data.background;
 data.progress={operation:'review',startedAt:start,finishedAt:data.updatedAt};
 const metric=P.metrics(data).find(metric=>metric.id==='applying');
 assert.equal(P.createTracker().describe(metric).percent,100);assert.equal(P.createTracker().describe(metric).elapsedMs,null);
});
