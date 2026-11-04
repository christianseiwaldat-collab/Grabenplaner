'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/data-import-contract');
const H = require('../lib/tradefoto-history-profiles');
const { definitions, readTradeFotoFullSource } = require('../lib/tradefoto-full-import-source');
const legacyHash = 'b362ea563e927c4c7366670bbc96bf1f26ce548572c80870ab8f9430872c6b05';
const name = 'ARTIKEL_FILIALEN';
const raw = extra => ({ ...Object.fromEntries(H.tableFor('trade',name).columns.map(column=>[column.name,null])),
  EAN:'0000000100430', FilialID:18, FBestand:2, ...extra });
const prepare = (profile, fileSha256, rowNumber, extra) => H.prepareTradeFotoHistoryRow('trade',name,raw(extra),
  {profileHash:profile.fingerprint,fileSha256,rowNumber});

test('branch stock v1 stays byte-compatible and separately registered from stable composite v2',()=>{
  const [current,legacy] = H.profilesFor('trade',name);
  assert.equal(legacy.fingerprint,legacyHash);
  assert.equal(legacy.version,1); assert.equal(current.version,2);
  assert.notEqual(current.entity,legacy.entity);
  assert.deepEqual(legacy.keyFields,['_source_snapshot_sha256','_source_row']);
  assert.deepEqual(current.keyFields,['EAN','FilialID']);
  assert.equal(H.profileFor('trade',name,legacyHash),legacy);
  assert.equal(H.TRADEFOTO_HISTORY_PROFILES.filter(p=>p.sourceTable===name).length,1);
  assert.equal(H.TRADEFOTO_HISTORY_READABLE_PROFILES.filter(p=>p.sourceTable===name).length,2);
  assert.equal(H.usesSnapshotMembership(legacy),false); assert.equal(H.usesSnapshotMembership(current),true);
  assert.throws(()=>H.profileFor('cash','Umsatz_KASSE',legacyHash),e=>e.code==='IMPORT_HISTORY_PROFILE_UNAVAILABLE');
});

test('v2 content and identity survive file and row-order changes without losing key zeroes or reference roles',()=>{
  const profile=H.profileFor('trade',name), first=C.normalizeDataImportRow(profile,prepare(profile,'a'.repeat(64),1));
  const second=C.normalizeDataImportRow(profile,prepare(profile,'b'.repeat(64),237201));
  assert.deepEqual(second,first); assert.deepEqual(first.key,['0000000100430','18']);
  assert.equal(profile.fields.length,27); assert.equal(Object.hasOwn(first.data,'snapshot'),false);
  const refs=H.historyReferenceRequests('trade',name,first.data,profile.fingerprint);
  assert.deepEqual(refs.map(r=>[r.table,r.key]),[['ARTIKEL_STAMM',['0000000100430']],['FILIALEN',['18']]]);
  const other=C.normalizeDataImportRow(profile,prepare(profile,'a'.repeat(64),1,{FilialID:1}));
  assert.notDeepEqual(other.key,first.key);
  for(const EAN of [null,'',' ']) assert.throws(()=>C.normalizeDataImportRow(profile,prepare(profile,'a'.repeat(64),1,{EAN})),e=>e.code===(EAN===''?'IMPORT_TEXT_INVALID':'IMPORT_KEY_MISSING'));
});

test('v1 history decoding retains the original synthetic source fields and protection classes',()=>{
  const legacy=H.profileFor('trade',name,legacyHash), prepared=prepare(legacy,'a'.repeat(64),7);
  const normalized=C.normalizeDataImportRow(legacy,prepared);
  assert.equal(normalized.data.snapshot,'a'.repeat(64)); assert.equal(normalized.data.ordinal,7);
  assert.deepEqual(H.historySource('trade',name,normalized.data,legacyHash),normalized.source);
  assert.deepEqual(H.historyKey('trade',name,normalized.data,legacyHash),['a'.repeat(64),7]);
  assert.deepEqual(H.historySegments('trade',name,normalized.data,legacyHash).map(s=>s.dataClass).sort(),['internal_business','personnel_restricted']);
});

test('saved profile selection must name every expected table in order with an approved table-specific hash',()=>{
  const current=definitions('trade'), selection=current.map(d=>({name:d.name,profileHash:d.profile.fingerprint}));
  selection.find(d=>d.name===name).profileHash=legacyHash;
  const resumed=definitions('trade',selection);
  assert.equal(resumed.find(d=>d.name===name).profile.fingerprint,legacyHash);
  assert.equal(definitions('trade').find(d=>d.name===name).profile.version,2);
  assert.throws(()=>definitions('trade',selection.slice(1)),e=>e.code==='IMPORT_PROFILE_UNAVAILABLE');
  assert.throws(()=>definitions('trade',selection.map((d,i)=>i===0?{...d,profileHash:legacyHash}:d)));
  assert.throws(()=>definitions('trade',[...selection].reverse()),e=>e.code==='IMPORT_PROFILE_UNAVAILABLE');
});

test('source reader carries the saved v1 shape through manifest and actual decoded rows',async()=>{
  const defs=definitions('trade'),buffer=Buffer.alloc(4096);buffer.write('Standard ACE DB',4);buffer[0x14]=3;
  const selection=defs.map(d=>({name:d.name,profileHash:d.name===name?legacyHash:d.profile.fingerprint}));
  const readerFactory=()=>({getTableNames:()=>defs.map(d=>d.name),getTable:table=>{
    const d=defs.find(item=>item.name===table), rows=table===name?[raw()]:[];
    return {rowCount:rows.length,getColumnNames:()=>d.columns.map(c=>c.name),getColumns:()=>d.columns.map(c=>({name:c.name,type:c.type})),
      getData:({columns,rowOffset=0,rowLimit=Infinity})=>rows.slice(rowOffset,rowOffset+rowLimit).map(r=>Object.fromEntries(columns.map(k=>[k,r[k]])))};
  }});
  const messages=[];await readTradeFotoFullSource({buffer,kind:'trade',profileSelection:selection,readerFactory,send:async message=>messages.push(message)});
  assert.equal(messages[0].tables.find(t=>t.name===name).profileHash,legacyHash);
  const rows=messages.find(m=>m.type==='rows'&&m.name===name).rows;
  assert.equal(rows[0]._source_row,1); assert.match(rows[0]._source_snapshot_sha256,/^[a-f0-9]{64}$/);
  assert.equal(rows[0].EAN,'0000000100430');
});
