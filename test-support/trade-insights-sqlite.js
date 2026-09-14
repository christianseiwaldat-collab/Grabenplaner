'use strict';
const {insightFixture}=require('./trade-insights-fixture');
const {createTradeInsightRuntime}=require('../lib/persistence/repositories/trade-insights');
const A=require('../lib/sales-analytics-access').SALES_ANALYTICS_PERMISSIONS,H=require('../lib/sales-history-access').SALES_HISTORY_PERMISSIONS;
const rights=[...Object.values(A),...Object.values(H),...Object.values(require('../lib/crm-access').CRM_PERMISSIONS),...Object.values(require('../lib/tradefoto-bestell/access').BESTELL_PERMISSIONS)];
async function fixture(t){
 const app=require('../lib/persistence/sqlite/provider').openSqliteApplicationPersistence({databasePath:':memory:',catalog:require('../lib/persistence/sqlite/application-catalog').SQLITE_APPLICATION_CATALOG});
 const db=app.database;db.exec(require('../lib/persistence/sqlite/trade-annotations-catalog').TRADE_ANNOTATIONS_SCHEMA);db.exec(`CREATE TABLE audit_log(id INTEGER PRIMARY KEY,actor TEXT,action TEXT,entity_type TEXT,entity_id TEXT,detail TEXT,created_at TEXT);
 CREATE TABLE locations(id TEXT PRIMARY KEY,active INTEGER,name TEXT);INSERT INTO locations VALUES('18',1,'Synthetic 18'),('19',1,'Synthetic 19');
 CREATE TABLE employees(personnel_number TEXT PRIMARY KEY,active INTEGER,full_name TEXT,contracted_hours TEXT,role TEXT);`);
 require('../lib/persistence/sqlite/operations/data-import-runtime-schema').ensureSqliteDataImportRuntimeSchema(db);
 require('../lib/persistence/sqlite/operations/crm-schema').ensureSqliteCrmSchema(db);
 require('../lib/persistence/sqlite/operations/sales-article-catalog-schema').ensureSqliteSalesArticleCatalogSchema(db);
 const vault=require('../lib/integration-secret-vault').createIntegrationSecretVault({activeKeyId:'synthetic',keys:{synthetic:Buffer.alloc(32,42)}});
 const protection=await require('../lib/data-import-managed-protection').loadManagedDataImportProtection({access:app.provider,vault,create:true});
 t.after(async()=>{protection.destroy();await app.provider.close();db.close();});
 const source=await insightFixture({access:app.provider,protection});
 const runtime=createTradeInsightRuntime({access:app.provider,vault,today:()=> '2026-09-14'});
 const state={session:{id:'synthetic-session',employeeNumber:'synthetic-owner',sessionKind:'employee',isEmployee:true,permissions:rights,scopes:[]}};
 return {...source,app,vault,protection,state,runtime,run:(kind,input={})=>runtime.run(async()=>state.session,kind,input)};
}
module.exports={fixture,rights};
