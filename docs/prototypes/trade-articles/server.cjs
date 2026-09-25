'use strict';
// Local acceptance only. Every run creates an isolated synthetic GP database.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../..'),directory=fs.mkdtempSync(path.join(root,'tmp','article-history-preview-'));
const key=crypto.randomBytes(32);
Object.assign(process.env,{DB_PATH:path.join(directory,'preview.db'),BACKUP_DIR:path.join(directory,'backups'),GRABENPLANER_DATA_DIR:path.join(directory,'data'),GRABENPLANER_HOST:'127.0.0.1',GRABENPLANER_FORCE_PORTAL:'1',GRABENPLANER_SEED_DEMO:'1',GRABENPLANER_INTEGRATION_KEY_ID:'article-preview',GRABENPLANER_INTEGRATION_KEY:key.toString('base64'),NODE_ENV:'test'});
async function main(){
 const {app,db}=require('../../../server');
 for(const id of ['93','94'])db.prepare('INSERT OR IGNORE INTO locations(id,name,active) VALUES(?,?,1)').run(id,'Demo-Filiale '+id);
 db.exec("INSERT INTO employees(personnel_number,full_name,nickname,color,contracted_hours,home_location_id,active) VALUES('article-preview','Synthetische Vorschau','Demo','#287a67',38.5,'93',1); INSERT INTO portal_users(employee_number,password_hash,role,active,must_change_password) VALUES('article-preview','no-password-login','developer',1,0)");
 const token=crypto.randomBytes(32).toString('hex'),csrf=crypto.randomBytes(24).toString('hex');
 db.prepare("INSERT INTO portal_sessions(id,employee_number,token_hash,expires_at) VALUES(?,'article-preview',?,?)").run(crypto.randomUUID(),crypto.createHash('sha256').update(token).digest('hex'),new Date(Date.now()+86400000).toISOString());
 const store=require('../../../lib/persistence/sqlite/provider').openSqliteApplicationPersistence({databasePath:process.env.DB_PATH,catalog:require('../../../lib/persistence/sqlite/application-catalog').SQLITE_APPLICATION_CATALOG});
 const vault=require('../../../lib/integration-secret-vault').createIntegrationSecretVault({activeKeyId:'article-preview',keys:{'article-preview':key}});
 const protection=await require('../../../lib/data-import-managed-protection').loadManagedDataImportProtection({access:store.provider,vault,create:true});
 const source=await require('../../../test-support/trade-insights-fixture').insightFixture({access:store.provider,protection,ownerId:'article-preview',seedBase:false});
 await source.ingest('ARTIKEL_STAMM',[
  {EAN:'D-1001',Artikelbezeichnung:'Systemkamera A · Gehäuse',Sortiment:'Kameras',Anlagedatum:'2021-01-01T00:00:00.000'},
  {EAN:'D-1003',Artikelbezeichnung:'Reisestativ Compact',Sortiment:'Zubehör',Anlagedatum:'2020-01-01T00:00:00.000'},
  {EAN:'D-1005',Artikelbezeichnung:'Akku Typ B · neue Serie',Sortiment:'Zubehör',Anlagedatum:'2024-01-01T00:00:00.000'},
 ],{master:true});
 await source.ingest('ARTIKEL_STAMMGelöscht',[
  {EAN:'D-1002',Artikelbezeichnung:'Objektiv 50 mm · Serie Classic',Sortiment:'Objektive',Anlagedatum:'2010-01-01T00:00:00.000',Löschdatum:'2026-06-02T00:00:00.000'},
  {EAN:'D-1004',Artikelbezeichnung:'Kameratasche M · Serie Classic',Sortiment:'Zubehör',Anlagedatum:'2012-01-01T00:00:00.000',Löschdatum:'2026-03-14T00:00:00.000'},
  {EAN:'D-1005',Artikelbezeichnung:'Akku Typ B · frühere Serie',Sortiment:'Zubehör',Anlagedatum:'2010-01-01T00:00:00.000',Löschdatum:'2023-12-31T00:00:00.000'},
 ],{sourceInstance:'tradefoto-weum'});
 protection.destroy();await store.provider.close();store.database.close();
 const express=require('express'),preview=express();
 preview.get('/start',(req,res)=>{res.set('Cache-Control','no-store');res.cookie('grabenplaner_session',token,{httpOnly:true,sameSite:'strict'});res.cookie('grabenplaner_csrf',csrf,{sameSite:'strict'});res.redirect('/?view=tradeInsights&section=article-history');});
 preview.use(app);
 const server=preview.listen(0,'127.0.0.1',()=>console.log('ARTICLE_PREVIEW=http://127.0.0.1:'+server.address().port+'/start'));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
