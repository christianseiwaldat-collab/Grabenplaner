'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createReviewBatchPolicy}=require('../lib/data-import-review-batching');

test('a spent preparation budget reduces the next packet instead of reloading unused rows',()=>{
  const policy=createReviewBatchPolicy();
  assert.equal(policy.limit('articles'),16);
  policy.observe('articles',{preparedRows:16,reviewedRows:1,durationMs:1300});
  assert.equal(policy.limit('articles'),1);
  policy.observe('articles',{preparedRows:1,reviewedRows:1,durationMs:8});
  assert.ok(policy.limit('articles')<=2,'a single fast observation cannot restore a large packet');
});
test('fast profiles grow within bounds, while a slow profile keeps its own budget',()=>{
  const policy=createReviewBatchPolicy();
  for(let n=0;n<30;n++){
    const size=policy.limit('small');policy.observe('small',{preparedRows:size,reviewedRows:size,durationMs:size*0.5});
  }
  assert.equal(policy.limit('small'),200);
  assert.equal(policy.limit('articles'),16);
  policy.observe('articles',{preparedRows:16,reviewedRows:16,durationMs:600});
  assert.equal(policy.limit('articles'),16,'a complete packet inside the actual budget retains its size');
  policy.observe('articles',{preparedRows:13,reviewedRows:13,durationMs:390});
  assert.ok(policy.limit('articles')<=16);
});
test('invalid feedback cannot change limits, and a fresh runtime starts with a bounded packet',()=>{
  const policy=createReviewBatchPolicy({maximumRows:10});
  for(const data of [{preparedRows:0,reviewedRows:0,durationMs:10},{preparedRows:1,reviewedRows:2,durationMs:10},{preparedRows:1,reviewedRows:1,durationMs:NaN}])policy.observe('a',data);
  assert.equal(policy.limit('a'),10);
  assert.throws(()=>createReviewBatchPolicy({budgetMs:0}));
  assert.equal(createReviewBatchPolicy().limit('articles'),16);
});

test('fixed preparation overhead does not collapse complete in-budget packets to single rows',()=>{
  const policy=createReviewBatchPolicy(),sizes=[];
  for(let sample=0;sample<40;sample++){
    const rows=policy.limit('fixed-overhead');sizes.push(rows);
    const durationMs=600+5*rows;
    assert.ok(durationMs<=750,'each observed full packet fits the real operation budget');
    policy.observe('fixed-overhead',{preparedRows:rows,reviewedRows:rows,durationMs});
  }
  assert.ok(sizes.every(size=>size>=16));
  assert.ok(policy.limit('fixed-overhead')>16,'bounded probes recover fixed-cost headroom');
});

test('a transient slow packet recovers gradually even when fixed overhead dominates each later packet',()=>{
  const policy=createReviewBatchPolicy();
  policy.observe('recovery',{preparedRows:16,reviewedRows:1,durationMs:1300});
  assert.equal(policy.limit('recovery'),1);
  for(let sample=0;sample<60;sample++){
    const rows=policy.limit('recovery'),durationMs=600+5*rows;
    assert.ok(durationMs<=750);
    policy.observe('recovery',{preparedRows:rows,reviewedRows:rows,durationMs});
    assert.ok(policy.limit('recovery')<=Math.ceil(rows*1.5));
  }
  assert.ok(policy.limit('recovery')>=16,'the policy does not remain stuck at one row');
});

test('an oversized growth probe backs off and permits only sparse recovery attempts',()=>{
  const policy=createReviewBatchPolicy(),sizes=[];let overruns=0;
  for(let sample=0;sample<80;sample++){
    const rows=policy.limit('bounded-probe'),durationMs=100+30*rows;
    const reviewedRows=Math.min(rows,Math.max(1,Math.ceil((750-100)/30)));
    if(durationMs>750)overruns++;
    policy.observe('bounded-probe',{preparedRows:rows,reviewedRows,durationMs:100+30*reviewedRows});
    sizes.push(policy.limit('bounded-probe'));
  }
  assert.ok(overruns<=2,'recovery probes remain rare after repeated evidence of saturation');
  assert.ok(sizes.slice(-20).every(size=>size===sizes.at(-1)));
  assert.ok(sizes.at(-1)>=16&&100+30*sizes.at(-1)<=750);
  for(let sample=0;sample<30;sample++){
    const rows=policy.limit('bounded-probe');
    policy.observe('bounded-probe',{preparedRows:rows,reviewedRows:rows,durationMs:rows*0.5});
  }
  assert.equal(policy.limit('bounded-probe'),200,'a materially faster regime can recover beyond the learned ceiling');
});

test('a short final packet neither shrinks the next full limit nor triggers an unproved growth probe',()=>{
  const policy=createReviewBatchPolicy();
  for(let sample=0;sample<12;sample++)policy.observe('tail',{preparedRows:1,reviewedRows:1,durationMs:600});
  assert.equal(policy.limit('tail'),16);
});

const key='apply:synthetic-af';
function full(policy,durationMs=550,name=key){const rows=policy.limit(name);policy.observe(name,{preparedRows:rows,reviewedRows:rows,durationMs});return policy.limit(name);}
function failProbe(policy,safe=160,probe=200){assert.equal(policy.limit(key),probe);policy.observe(key,{preparedRows:probe,reviewedRows:safe,durationMs:850});assert.ok(policy.limit(key)<=safe);}
function failedInitial(){const policy=createReviewBatchPolicy({initialRows:160});for(let n=0;n<4;n++)full(policy);assert.equal(policy.limit(key),200);failProbe(policy);return policy;}
function settleAtCeiling(policy,safe=160){let steps=0;while(policy.limit(key)<safe){full(policy);assert.ok(++steps<60);}assert.equal(policy.limit(key),safe);return steps;}
function waitForProbe(policy,safe=160,probe=200){let steps=0;while(policy.limit(key)===safe){full(policy);assert.ok(++steps<=256);}assert.equal(policy.limit(key),probe);return steps;}

test('a transient growth failure recovers to full packets despite fixed 550 ms operation costs',()=>{
 const policy=failedInitial();
 for(let n=0;n<240;n++)full(policy);
 assert.equal(policy.limit(key),200);
});
test('a learned ceiling reopens by one bounded step only after 32 full stable headroom packets',()=>{
 const policy=failedInitial();settleAtCeiling(policy);
 for(let n=0;n<31;n++)assert.equal(full(policy),160);
 assert.equal(full(policy),200);
 assert.equal(policy.limit('other-profile'),160,'the unobserved key retains its independent initial limit');
});
test('genuine saturation retries back off at 32, 64, 128, 256 and remain capped at 256 stable packets',()=>{
 const policy=failedInitial(),waits=[];
 for(let n=0;n<5;n++){settleAtCeiling(policy);waits.push(waitForProbe(policy));failProbe(policy);}
 assert.deepEqual(waits,[32,64,128,256,256]);
});
test('one successful recovery probe resets failure backoff before the next bounded recovery step',()=>{
 const policy=createReviewBatchPolicy({initialRows:100});for(let n=0;n<4;n++)full(policy);
 failProbe(policy,100,125);settleAtCeiling(policy,100);assert.equal(waitForProbe(policy,100,125),32);failProbe(policy,100,125);
 settleAtCeiling(policy,100);assert.equal(waitForProbe(policy,100,125),64);
 assert.equal(full(policy,730),125,'the larger full probe fits the unchanged actual budget');
 assert.equal(waitForProbe(policy,125,157),32,'successful recovery resets the prior 64-packet penalty');
});
test('near-budget packets do not qualify; recovery requires consecutive packets below the 95 percent margin',()=>{
 const policy=failedInitial();settleAtCeiling(policy);
 for(let n=0;n<400;n++)assert.equal(full(policy,730),160);
 for(let n=0;n<31;n++)assert.equal(full(policy,550),160);
 assert.equal(full(policy,550),200);
});
test('a short tail resets recovery eligibility and never proves a larger full packet',()=>{
 const policy=failedInitial();settleAtCeiling(policy);
 for(let n=0;n<31;n++)assert.equal(full(policy),160);
 policy.observe(key,{preparedRows:1,reviewedRows:1,durationMs:550});assert.equal(policy.limit(key),160);
 for(let n=0;n<31;n++)assert.equal(full(policy),160);
 assert.equal(full(policy),200);
});
test('the existing genuinely fast recovery and maximum/profile separation remain intact',()=>{
 const policy=failedInitial();settleAtCeiling(policy);
 for(let round=0;round<4;round++){assert.ok(waitForProbe(policy)>=32);failProbe(policy);settleAtCeiling(policy);}
 for(let n=0;n<20;n++)full(policy,50);
 assert.equal(policy.limit(key),200);assert.equal(policy.limit('review:synthetic-af'),160);
 const small=createReviewBatchPolicy({initialRows:10,maximumRows:10});for(let n=0;n<500;n++)full(small,550);assert.equal(small.limit(key),10);
});
test('invalid observations do not advance the delayed recovery counter',()=>{
 const policy=failedInitial();settleAtCeiling(policy);
 for(let n=0;n<31;n++)assert.equal(full(policy),160);
 for(let n=0;n<500;n++)policy.observe(key,{preparedRows:160,reviewedRows:0,durationMs:550});
 assert.equal(policy.limit(key),160);assert.equal(full(policy),200);
});
