'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {withSalesFixture}=require('../test-support/postgresql-migration/sales-fixture');
const {cashFixture,receipt,sourceRows,raw,TABLES}=require('../test-support/postgresql-migration/cash-fixture');
const {createCashHistoryBackend}=require('../lib/persistence/repositories/cash-history-backend');
const {createDataImportProtection}=require('../lib/data-import-protection');
const {createCashSnapshotStore}=require('../lib/persistence/repositories/cash-snapshots');
const M=require('../lib/sales-report-model');
const {createSalesSchemaPlan}=require('../lib/persistence/postgresql/sales/schema');
const {createSalesCatalog}=require('../lib/persistence/postgresql/sales/catalog');
const live={skip:process.env.GP_PG_MIGRATION_LIVE!=='1'};
const code=c=>e=>e.code===c;
const query={productGroupIds:[],manufacturerIds:[],sellerIds:[],groupBy:['productGroup'],metrics:['grossRevenue','netRevenue','grossMargin','quantity','receiptCount','customerCount']};
test('Block 5 covers all cash tables, source indexes, triggers and 70 prepared statements',()=>{
  assert.deepEqual(createSalesSchemaPlan(5).sourceCounts,{tables:13,indexes:21,triggers:26});
  assert.equal(createSalesCatalog(5).entries.length,70);
  assert.ok(createSalesCatalog(5).entries.every(e=>!e.sql.includes('INDEXED BY')));
});
test('Live Block 5 preserves the complete encrypted source, decimal text, null dates and replay identity',live,()=>withSalesFixture(5,async f=>{
  const data=sourceRows([receipt(1,'0.300000000001',[{VK_Preis:'0.300000000001',RohertragDM:'0.100000000001',EAN:'000042'}])]);
  const summaries=[];
  for(const access of [f.sqliteProvider,f.postgres]){
    const cash=cashFixture(access,f.protection),built=await cash.build(data);summaries.push(built.summary);
    assert.equal(built.summary.status,'ready');assert.equal(built.summary.verifiedRows,3);
    const duplicate=await cash.build(data);assert.equal(duplicate.id,built.id);assert.equal(duplicate.summary.verifiedRows,3);
    await access.transaction(async tx=>{
      const dataset=await cash.store.reader.load(tx,built.id);
      for(const table of TABLES){
        const stored=await tx.queryAll(table.statements.page,{datasetSlot:dataset.row.slot,after:0,limit:100});
        assert.equal(stored.length,data[table.name]?.length||0);
        for(let i=0;i<stored.length;i++){
          const decoded=cash.store.reader.decode(dataset,table,stored[i]);
          assert.deepEqual(decoded.values,table.columns.map(c=>data[table.name][i][c.name]));
          assert.doesNotMatch(stored[i].payload,/Synthetic article|000042|0\.300000/);
        }
      }
    },{readOnly:true,isolation:'serializable'});
  }
  assert.deepEqual(summaries[1],summaries[0]);
}));
test('Live Block 5 rolls back missing-parent and duplicate batches and rechecks permission before staging',live,()=>withSalesFixture(5,async f=>{
  for(const access of [f.sqliteProvider,f.postgres]){
    let allowed=true;const cash=cashFixture(access,f.protection,{check:async()=>{if(!allowed){const e=new Error('revoked');e.code='IMPORT_FORBIDDEN';throw e;}}});
    const data=sourceRows([receipt(1,'120',[{}])]),manifest=cash.manifest(data),id='a'.repeat(64);
    await cash.store.begin(id,manifest);
    for(const table of TABLES){
      if(table.name==='Umsatz_Kasse_Details'){
        await cash.store.startTable(id,table.name,2);
        const good=cash.prepare(table,data[table.name][0],1,manifest.fileSha256),bad=cash.prepare(table,{...data[table.name][0],Bonnr:'missing',RepID:'00000000-0000-0000-0000-000000002000'},2,manifest.fileSha256);
        await assert.rejects(cash.store.append(id,table.name,1,[good,bad]),code('IMPORT_HISTORY_PARENT_MISSING'));
        await assert.rejects(cash.store.append(id,table.name,1,[good,good]),code('PERSISTENCE_UNIQUE_VIOLATION'));
        allowed=false;await assert.rejects(cash.store.append(id,table.name,1,[good]),code('IMPORT_FORBIDDEN'));allowed=true;
        assert.equal((await cash.store.summary(id)).tables.find(t=>t.name===table.name).run.receivedRows,0);break;
      }
      const rows=data[table.name]||[];await cash.store.startTable(id,table.name,rows.length);
      if(rows.length)await cash.store.append(id,table.name,1,rows.map((r,i)=>cash.prepare(table,r,i+1,manifest.fileSha256)));
      await cash.store.finishTable(id,table.name);
    }
  }
}));
test('Live Block 5 publication, receipt reconciliation, source margins and rollback match SQLite',live,()=>withSalesFixture(5,async f=>{
  const receipts=[
    receipt(1,'1273.18',[{VK_Preis:'1369',RohertragDM:'137.94907831964053'},{VKMenge:'-1',VK_Preis:'95.82',Sortiment:170201,SonderartikelS:true,RohertragDM:'0'}]),
    receipt(2,'0',[{VK_Preis:'600',RohertragDM:'100'},{VKMenge:'-4',VK_Preis:'100',MWST:'0',AStorno:true,Sortiment:170101,RohertragDM:'0'}]),
    receipt(3,'0',[{VKMenge:'2',VK_Preis:'10',MWST:'0',Sortiment:170101,RohertragDM:'999.99'}]),
    receipt(4,'22',[{VKMenge:'2',VK_Preis:'11',MWST:'10',Sortiment:50901,RohertragDM:'1'}]),
    receipt(5,'-120',[{VKMenge:'-1'}]),
    receipt(6,'110',[{EAN:'0000000069877',VK_Preis:'110',MWST:'0',Sortiment:130101,RohertragDM:'25'}]),
    receipt(7,'12',[{VK_Preis:'12',MWST:'99'}]),
  ];
  const compared=[];
  for(const access of [f.sqliteProvider,f.postgres]){
    const cash=cashFixture(access,f.protection),built=await cash.build(sourceRows(receipts));
    const activated=await cash.activate(cash.request(built.id));
    const outcomes=await access.transaction(async tx=>{
      const publication=await cash.publications.active(tx),backend=createCashHistoryBackend({publication,publications:cash.publications,scopeId:cash.actor.scopeId});
      const service=backend.service(tx,async()=>true),result=[];
      for(let i=0;i<receipts.length;i++){
        const id='c'+TABLES.findIndex(t=>t.name==='Umsatz_KASSE')+'-'+activated.active+'-'+String(i+1).padStart(10,'0');
        const receiptResult=await service.receipt(id);result.push(receiptResult);
        if(i===6){assert.equal(receiptResult.canAggregate,false);assert.ok(receiptResult.issues.includes('VAT_CODE_UNKNOWN'));continue;}
        assert.equal(receiptResult.canAggregate,true,'Synthetic receipt '+(i+1)+': '+JSON.stringify(receiptResult.issues));
        const state=M.accumulator();
        for(const line of receipts[i].lines)M.accumulate(state,'current',query,{metric:receiptResult.positions.find(p=>p.key===line.RepID),quantity:line.VKMenge,margin:M.positionMargin(line.RohertragDM,line.VKMenge),receiptKey:String(i),customerKey:'000031',productGroup:{id:String(line.Sortiment),label:String(line.Sortiment)}});
        const report=M.finishReport(state,query);
        assert.equal(report.total.metrics.grossMargin.current,['137.95','100.00','0.00','2.00','-20.00','25.00'][i]);
      }
      return result;
    },{readOnly:true,isolation:'serializable'});
    compared.push(outcomes);
    const second=await cash.build(sourceRows([receipt(8,'120',[{}])]));await cash.activate(cash.request(second.id,1));
    await assert.rejects(cash.preview(cash.request(second.id,1)),code('IMPORT_REVISION_CONFLICT'));
    const preview=await access.transaction(tx=>cash.publications.rollback(tx,cash.actor,2,null,'synthetic-session'));
    const reverted=await access.transaction(tx=>cash.publications.rollback(tx,cash.actor,2,preview.planHash,'synthetic-session',true),{isolation:'serializable'});
    assert.equal(reverted.active,activated.active);assert.equal(reverted.revision,3);
  }
  assert.deepEqual(compared[1],compared[0]);
}));
test('Live Block 5 detects changed source indexes and wrong keys without rewriting source payloads',live,()=>withSalesFixture(5,async f=>{
  const cash=cashFixture(f.postgres,f.protection),built=await cash.build(sourceRows([receipt(1,'120',[{}])]));
  const detailTable='kassa.'+TABLES.find(t=>t.name==='Umsatz_Kasse_Details').sqlName;
  const before=(await f.client.query('SELECT payload FROM '+detailTable)).rows[0].payload;
  const wrong=createDataImportProtection({encryptionKey:Buffer.alloc(32,1),indexKey:Buffer.alloc(32,43),keyId:'synthetic-migration',compression:true});
  try{await assert.rejects(createCashSnapshotStore({access:f.postgres,protection:wrong,actor:cash.actor}).summary(built.id),code('IMPORT_PROTECTED_PAYLOAD_INVALID'));}finally{wrong.destroy();}
  await f.client.query('UPDATE '+detailTable+" SET business_date='2020-01-01'");
  await assert.rejects(f.postgres.transaction(tx=>cash.publications.candidate(tx,built.id,cash.actor.ownerId)),code('IMPORT_HISTORY_INTEGRITY'));
  await cash.store.reverify(built.id);await assert.rejects(async()=>{for(let i=0;i<20;i++){const result=await cash.store.review(built.id);if(result.status!=='reviewing')return;}},e=>/^IMPORT_/.test(e.code));
  assert.equal((await f.client.query('SELECT payload FROM '+detailTable)).rows[0].payload,before);
}));
