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
 const m={key:'phase',value:0,total:1000,active:true,allowEstimate:true,startedAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()};
 assert.equal(tracker.describe(m).remainingMs,null);
 now+=10000;m.value=10;m.updatedAt=new Date(now).toISOString();assert.equal(tracker.describe(m).remainingMs,null);
 now+=10000;m.value=20;m.updatedAt=new Date(now).toISOString();assert.equal(tracker.describe(m).remainingMs,null);
 now+=10000;m.value=30;m.updatedAt=new Date(now).toISOString();const measured=tracker.describe(m);
 assert.equal(measured.remainingMs,970000);assert.equal(measured.elapsedMs,30000);
 now+=31000;assert.equal(tracker.describe(m).remainingMs,null,'stale throughput must not keep claiming a remaining time');
});
test('pause, rollback, a new phase and completion never reuse an inappropriate estimate',()=>{
 let now=Date.parse(start);const tracker=P.createTracker({now:()=>now});
 const m={key:'phase',value:0,total:100,active:true,allowEstimate:true,startedAt:start};
 for(let n=0;n<4;n++){m.value=n*10;m.updatedAt=new Date(now).toISOString();tracker.describe(m);now+=10000;}
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

test('mixed takeover counts exclude quarantined rows and the entire deferred stock snapshot',()=>{
 const data=source();data.currentStep={table:'Current',phase:'applying'};
 data.tables=[
  {name:'Earlier',declaredRows:10,run:{status:'applied',receivedRows:10,counts:{applied:7,invalid:2,conflict:1}}},
  {name:'Stock',declaredRows:5,deferred:'INCOMPLETE_STOCK_SNAPSHOT',run:{status:'applied',receivedRows:5,counts:{applied:5,invalid:1,conflict:1}}},
  {name:'Current',declaredRows:8,run:{status:'applying',receivedRows:8,counts:{applied:2,unchanged:1,duplicate:1,invalid:1,conflict:2}}},
 ];
 const main=P.metrics(data).find(m=>m.id==='applying'),table=P.metrics(data).find(m=>m.id.startsWith('table:'));
 assert.equal(main.value,9);assert.equal(main.total,12);
 assert.equal(table.value,4);assert.equal(table.total,5);
 const html=UI.renderSource(data,{});
 assert.match(html,/9 \/ 12 Zeilen übernommen oder unverändert bestätigt/);
 assert.match(html,/1 \/ 2 Tabellen abgeschlossen/);
 assert.match(html,/Bestandsaufnahme zurückgestellt: 5 Zeilen/);
 assert.match(html,/Der bisherige gültige Bestandsstand bleibt erhalten/);
 assert.doesNotMatch(html,/23 \/ 23 Zeilen übernommen/);
});

test('completed partial takeover keeps quarantine visible without counting those rows as imported',()=>{
 const data=source();data.status='applied';data.active=false;delete data.background;delete data.currentStep;
 data.tables=[{name:'Mixed',declaredRows:6,run:{status:'applied',receivedRows:6,counts:{applied:3,invalid:2,conflict:1}}}];
 const main=P.metrics(data).find(m=>m.id==='applying');
 assert.equal(main.value,3);assert.equal(main.total,3);assert.equal(main.complete,true);
 const html=UI.renderSource(data,{});
 assert.match(html,/Übernommen · Prüffälle zurückgestellt/);
 assert.match(html,/3 \/ 3 Zeilen übernommen oder unverändert bestätigt/);
 assert.match(html,/2 ungültige Zeilen · 1 offener Prüffall/);
 assert.doesNotMatch(html,/6 \/ 6 Zeilen übernommen/);
});

test('a fully quarantined source and an empty deferred snapshot never report imported rows',()=>{
 const data=source();data.status='applied';data.active=false;delete data.background;delete data.currentStep;
 data.tables=[{name:'Invalid',declaredRows:3,run:{status:'applied',receivedRows:3,counts:{invalid:2,conflict:1}}},
  {name:'Stock',declaredRows:0,deferred:'INCOMPLETE_STOCK_SNAPSHOT',run:{status:'applied',receivedRows:0,counts:{}}}];
 const main=P.metrics(data).find(m=>m.id==='applying');
 assert.equal(main.value,0);assert.equal(main.total,0);
 const html=UI.renderSource(data,{});
 assert.match(html,/0 \/ 0 Zeilen übernommen oder unverändert bestätigt/);
 assert.match(html,/Übernahme abgeschlossen · Prüffälle zurückgestellt/);
 assert.match(html,/Bestandsaufnahme zurückgestellt: 0 Zeilen/);
 assert.doesNotMatch(html,/3 \/ 3 Zeilen übernommen/);
});

test('quarantined barcode assignments stay separate from blocked article counts',()=>{
 const data=source();data.kind='trade';data.catalog={changed:2,unchanged:3,blocked:4,quarantinedAliases:5};
 const html=UI.renderSource(data,{});
 assert.match(html,/4 Artikel zur Prüfung zurückgestellt/);
 assert.match(html,/5 Barcode-Zuordnungen zur Prüfung zurückgestellt/);
});

test('heterogeneous remaining tables never inherit the current table throughput as a total ETA',()=>{
 let now=Date.parse(start);const tracker=P.createTracker({now:()=>now}),data=source();
 data.currentStep.phase='applying';data.tables[1].run.status='applying';data.tables[1].run.counts={applied:0};
 data.tables.push({name:'Different row type',run:{id:'later',status:'ready',receivedRows:1000000,counts:{create:1000000}}});
 let main,step;
 for(let n=0;n<4;n++){
  data.tables[1].run.counts.applied=n*10;data.updatedAt=new Date(now).toISOString();
  const metrics=P.metrics(data);main=metrics.find(m=>m.id==='applying');step=metrics.find(m=>m.id.startsWith('table:'));
  assert.equal(main.allowEstimate,false);assert.equal(tracker.describe(main).remainingMs,null);
  tracker.describe(step);now+=10000;
 }
 assert.equal(main.value,115609);assert.equal(main.total,1135163);
 assert.equal(step.value,30);assert.equal(step.total,19584);assert.equal(step.allowEstimate,true);
 assert.equal(tracker.describe(step).remainingMs,19554000,'Only the current table/phase has a comparable denominator');
 const html=P.render(data,tracker),overall=html.slice(html.indexOf('aria-label="Übernahme insgesamt"')).split('</section>')[0];
 assert.match(overall,/Restzeit: <strong>nicht belastbar schätzbar/);assert.doesNotMatch(overall,/ca\./);
 assert.match(html,/Restzeit dieses Schritts:/);
});

test('waiting and isolated bursts do not provide a credible step estimate',()=>{
 let now=Date.parse(start);const tracker=P.createTracker({now:()=>now});
 const m={key:'one-run:reviewing',phase:'reviewing',value:0,total:1000,active:true,allowEstimate:true,startedAt:start};
 const sample=value=>{m.value=value;m.updatedAt=new Date(now).toISOString();return tracker.describe(m);};
 for(let n=0;n<4;n++){sample(n*10);now+=10000;}
 assert.ok(sample(30).remainingMs>0);
 now+=31000;assert.equal(sample(30).remainingMs,null);
 now+=1000;assert.equal(sample(800).remainingMs,null,'A late batch must not reuse the pre-wait history');
 now+=10000;assert.equal(sample(810).remainingMs,null);
 now+=10000;assert.equal(sample(820).remainingMs,null);
 now+=10000;assert.ok(sample(830).remainingMs>0,'A fresh comparable sequence can produce a new step estimate');
 const burstTracker=P.createTracker({now:()=>now});
 for(const value of [0,10,20,900]){m.value=value;m.updatedAt=new Date(now).toISOString();assert.equal(burstTracker.describe(m).remainingMs,null);now+=10000;}
});

test('unchanged confirmation jumps neither inflate the total counter early nor create a total ETA',()=>{
 let now=Date.parse(start);const tracker=P.createTracker({now:()=>now}),data=source();
 data.currentStep.phase='applying';const run=data.tables[1].run;run.status='applying';run.counts={applied:0,unchanged:0};
 for(let n=0;n<3;n++){run.counts.applied=n*10;data.updatedAt=new Date(now).toISOString();tracker.describe(P.metrics(data).find(m=>m.id.startsWith('table:')));now+=10000;}
 run.counts.unchanged=18000;data.updatedAt=new Date(now).toISOString();
 let metrics=P.metrics(data),main=metrics.find(m=>m.id==='applying');
 assert.equal(main.value,115599,'Unchanged review results are not an applied-table acknowledgement');
 assert.equal(tracker.describe(main).remainingMs,null);
 assert.equal(tracker.describe(metrics.find(m=>m.id.startsWith('table:'))).remainingMs,null,'The row-type burst is not comparable throughput');
 run.status='applied';metrics=P.metrics(data);main=metrics.find(m=>m.id==='applying');
 assert.equal(main.value,135163);assert.equal(main.complete,false,'The source still has its own completion boundary');
 assert.equal(tracker.describe(main).remainingMs,null);
});

test('step estimates require opt-in and fresh measurements after run, phase, retry or tracker reconstruction',()=>{
 let now=Date.parse(start);const tracker=P.createTracker({now:()=>now}),data=source();
 const step=()=>P.metrics(data).find(m=>m.id.startsWith('table:'));
 for(let n=0;n<4;n++){data.tables[1].run.counts.staged=1000-n*10;data.updatedAt=new Date(now).toISOString();tracker.describe(step());now+=10000;}
 const current=step();assert.ok(tracker.describe(current).remainingMs>0);
 assert.equal(tracker.describe({...current,complete:true}).remainingMs,0,'An explicit completion must not be overwritten by an earlier throughput estimate');
 assert.equal(P.createTracker({now:()=>now}).describe(current).remainingMs,null);
 for(const allowEstimate of [undefined,false])assert.equal(tracker.describe({...current,allowEstimate}).remainingMs,null);
 data.tables[1].run.id='new-run';assert.equal(tracker.describe(step()).remainingMs,null);
 data.currentStep.phase='rechecking';assert.equal(tracker.describe(step()).remainingMs,null);
 data.currentStep.phase='unsupported';assert.equal(step().allowEstimate,false);assert.equal(tracker.describe(step()).remainingMs,null);
 for(const status of ['paused','retrying','queued','failed']){
  data.background.status=status;assert.equal(step().active,false);assert.equal(tracker.describe(step()).remainingMs,null);
 }
 data.background.status='applying';assert.equal(tracker.describe(step()).remainingMs,null);
 tracker.clear();assert.equal(tracker.describe(current).remainingMs,null);
});
