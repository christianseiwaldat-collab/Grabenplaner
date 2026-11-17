'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {createDiskRecipeIndex,RECORD_BYTES}=require('../lib/persistence/postgresql/operations/access-recipe-disk-index');
function fixture(t,options={}){
 const parent=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'gp-disk-index-test-'));fs.chmodSync(parent,0o700);
 const index=createDiskRecipeIndex({directory:parent,...options});t.after(()=>{index.dispose();assert.equal(path.dirname(fs.realpathSync(parent)),fs.realpathSync(os.tmpdir()));fs.rmSync(parent,{recursive:true,force:true});});return {index,parent};
}
test('append accepts only fixed hash/locator metadata and enforces the raw-record cap before growth',t=>{
 const {index}=fixture(t,{maxEntries:2});
 for(const args of [['source values',0,0],['a'.repeat(64),-1,0],['a'.repeat(64),0,0x100000000]])assert.throws(()=>index.append(...args),{code:'PG_DEPLOY_INDEX_RECORD'});
 index.append('a'.repeat(64),0,0);index.append('b'.repeat(64),0xffffffff,0xffffffff);
 assert.throws(()=>index.append('a'.repeat(64),1,1),{code:'PG_DEPLOY_INDEX_LIMIT'});
 assert.equal(RECORD_BYTES,83);assert.throws(()=>index.lookup('a'.repeat(64)),{code:'PG_DEPLOY_INDEX_STATE'});
});
test('dispose closes and removes only its exact owned child, leaving sibling files untouched',t=>{
 const {index,parent}=fixture(t),child=index.directory;fs.writeFileSync(path.join(parent,'keep.txt'),'sibling fixture');index.append('a'.repeat(64),1,2);index.dispose();
 assert.equal(fs.existsSync(child),false);assert.equal(fs.readFileSync(path.join(parent,'keep.txt'),'utf8'),'sibling fixture');index.dispose();
});
test('unknown children prevent cleanup without deleting any owned or unknown file',t=>{
 const {index}=fixture(t),extra=path.join(index.directory,'unknown');fs.writeFileSync(extra,'preserve');
 assert.throws(()=>index.dispose(),{code:'PG_DEPLOY_INDEX_UNKNOWN_FILES'});assert.ok(fs.existsSync(path.join(index.directory,'raw.records')));assert.equal(fs.readFileSync(extra,'utf8'),'preserve');
 fs.unlinkSync(extra);index.dispose();
});
test('budget failures propagate before buffered growth and do not prevent owned cleanup',t=>{
 let expired=false;const failure=Object.assign(new Error('synthetic expired budget'),{code:'SYNTHETIC_BUDGET'});
 const {index}=fixture(t,{checkBudget(){if(expired)throw failure;}});
 for(let i=0;i<1024;i++)index.append('a'.repeat(64),1,i);expired=true;
 assert.throws(()=>index.append('b'.repeat(64),2,0),error=>error===failure);index.dispose();
});
test('actual trusted platform sort preserves first duplicate, sorted iteration, binary lookups and metadata-only records',{skip:process.platform!=='linux'},async t=>{
 const {index}=fixture(t),a='0'.repeat(64),b='a'.repeat(64),c='f'.repeat(64);
 index.append(c,9,99);index.append(b,5,77);index.append(a,3,12);index.append(b,99,100);
 assert.deepEqual(await index.finalize(),{size:3});assert.equal(index.size,3);
 assert.deepEqual([...index.entries()],[[a,[3,12]],[b,[5,77]],[c,[9,99]]]);assert.deepEqual(index.lookup(b),[5,77]);assert.equal(index.lookup('b'.repeat(64)),undefined);
 const raw=fs.readFileSync(path.join(index.directory,'raw.records'),'ascii');assert.equal(raw.length,4*83);assert.ok(raw.split('\n').slice(0,-1).every(line=>/^[a-f0-9]{64}\t[a-f0-9]{8}\t[a-f0-9]{8}$/.test(line)));
 assert.throws(()=>index.append(a,0,0),{code:'PG_DEPLOY_INDEX_STATE'});index.dispose();
});
test('100k records retain first duplicates and unsigned locator boundaries across platform-sort pages',{skip:process.platform!=='linux'},async t=>{
 const {index}=fixture(t),expected=new Map(),zero='0'.repeat(64),last='f'.repeat(64);
 index.append(zero,0xffffffff,0xfedcba98);expected.set(zero,[0xffffffff,0xfedcba98]);
 index.append(last,0x80000000,0xffffffff);expected.set(last,[0x80000000,0xffffffff]);
 for(let i=0;i<100000;i++){const digest=crypto.createHash('sha256').update('large-metadata-'+(i%85000)).digest('hex');const value=[i%19,i];if(!expected.has(digest))expected.set(digest,value);index.append(digest,...value);}
 assert.equal((await index.finalize()).size,85002);assert.deepEqual(index.lookup(zero),[0xffffffff,0xfedcba98]);assert.deepEqual(index.lookup(last),[0x80000000,0xffffffff]);
 assert.deepEqual([...index.entries()],[...expected].sort(([a],[b])=>a<b?-1:1));
 let sampled=0;for(const [digest,value]of expected){if(sampled++%131===0)assert.deepEqual(index.lookup(digest),value);}index.dispose();
});
test('multiple sorted pages match an independent Map and deterministic digest order',{skip:process.platform!=='linux'},async t=>{
 const {index}=fixture(t),expected=new Map();
 for(let i=0;i<2500;i++){const digest=crypto.createHash('sha256').update(String(i%2200)).digest('hex');if(!expected.has(digest))expected.set(digest,[i%7,i]);index.append(digest,i%7,i);}
 await index.finalize();assert.deepEqual([...index.entries()],[...expected].sort(([a],[b])=>a<b?-1:1));
 for(const [digest,value] of expected)assert.deepEqual(index.lookup(digest),value);index.dispose();
});
