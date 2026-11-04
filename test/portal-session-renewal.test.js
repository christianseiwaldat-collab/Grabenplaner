'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createPortalSessionRenewal}=require('../lib/portal-session-renewal');
test('Concurrent session reads renew once while every caller keeps the database expiry',async()=>{
 const renew=createPortalSessionRenewal(),now=Date.parse('2026-09-14T10:00:00Z'),next=new Date(now+30*60000).toISOString();
 let release,writes=0;const wait=new Promise(r=>release=r);
 const sessions=Array.from({length:18},()=>Object.freeze({id:'session',expires_at:new Date(now+10*60000).toISOString(),absolute_expires_at:new Date(now+60*60000).toISOString()}));
 const jobs=sessions.map(session=>renew({session,kind:'employee',now,expiresAt:next,timeoutMinutes:30,write:async value=>{writes++;assert.equal(value.now,new Date(now).toISOString());await wait;return {rowsAffected:1};}}));
 await new Promise(r=>setImmediate(r));assert.equal(writes,1);release();const results=await Promise.all(jobs);
 assert.ok(results.every(expiry=>expiry===next));
 await renew({session:Object.freeze({...sessions[0],expires_at:next}),kind:'employee',now,expiresAt:next,timeoutMinutes:30,write:()=>{throw Error('not due');}});
 assert.equal(writes,1);
});
test('Busy renewal never invents a longer expiry and does not cache permission decisions',async()=>{
 const renew=createPortalSessionRenewal(),now=Date.parse('2026-09-14T10:00:00Z'),session={id:'old',expires_at:'2026-09-14T10:01:00Z',absolute_expires_at:'2026-09-14T11:00:00Z'};
 await renew({session,kind:'employee',now,expiresAt:'2026-09-14T10:30:00Z',timeoutMinutes:30,write:async()=>{throw Object.assign(Error(),{code:'PERSISTENCE_BUSY'});}});
 assert.equal(session.expires_at,'2026-09-14T10:01:00Z');
 await renew({session,kind:'employee',now:now+61000,expiresAt:'2026-09-14T10:31:01Z',timeoutMinutes:30,write:()=>{throw Error('expired session must not renew');}});
});
test('Unsuccessful renewal cannot claim an extension; every write is clamped to the absolute end',async()=>{
 const renew=createPortalSessionRenewal(),now=Date.parse('2026-10-18T10:00:00Z');
 const session={id:'revoked',expires_at:'2026-10-18T10:01:00Z',absolute_expires_at:'2026-10-18T10:02:00Z'};
 const result=await renew({session,kind:'employee',now,expiresAt:'2026-10-18T11:00:00Z',timeoutMinutes:30,write:async value=>{
  assert.equal(value.expiresAt,'2026-10-18T10:02:00.000Z');return {rowsAffected:0};}});
 assert.equal(result,null);
});
