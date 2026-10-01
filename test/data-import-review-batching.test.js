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
  assert.equal(policy.limit('articles'),13);
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
