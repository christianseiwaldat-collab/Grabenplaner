'use strict';
// Local acceptance only. Every run creates an isolated synthetic GP database.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../..'),directory=fs.mkdtempSync(path.join(root,'tmp','movement-preview-'));
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
 const source=await require('../../../test-support/trade-insights-fixture').insightFixture({access:store.provider,protection,ownerId:'article-preview',branches:['93','94'],clock:()=>new Date().toISOString()});
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
 await source.ingest('BESTELLUNGEN',[{BestellNr:'11',Suchname:'Demo Optik',LFilialID:93,Bestelldatum:'2026-09-01T00:00:00.000'}]);
 await source.ingest('BESTELLDETAILS',[{BestellId:'100',BestellNr:11,EAN:'D-1001',BArtikelbezeichnung:'Systemkamera A · Gehäuse',BMenge:'8',gMenge:'6'}]);
 await source.ingest('BESTELLKORB',[{KorbID:'21',KEAN:'D-1001',Filiale:93,UmlagerungvonFil:94,KDatum:'2026-09-12T00:00:00.000',KArtikelbezeichnung:'Systemkamera A · Gehäuse',KMenge:'2',Status:'Umlagerung',erledigt:true}]);
 const row=(id,extra={})=>({We_ID:String(id),We:true,Umlagerung:false,EAN:'D-1001',Suchname:'Demo Optik',FilialID:'93',Menge:'6',WEDatum:'2026-09-21T00:00:00.000',AkWeDatum:'2026-09-22T00:00:00.000',...extra});
 await source.ingest('WE',[
  row(101,{Bestellnr:11,Lieferscheinnr:'DEMO-LS-410',Rechnungsnr:'DEMO-RE-210'}),
  row(102,{We:false,Umlagerung:true,FilialID:'94',Filialid2:'93',Menge:'2',KorbId:21,WEDatum:'2026-09-20T00:00:00.000'}),
  row(103,{Menge:'-1',Bestellnr:11,Lieferscheinnr:'DEMO-LS-411',WEDatum:'2026-09-19T00:00:00.000'}),
  row(104,{EAN:'D-1003',Menge:'4',Suchname:'Demo Zubehör',FilialID:'94',WEDatum:'2026-09-18T00:00:00.000'}),
  row(105,{EAN:'D-1002',Menge:'1',WEDatum:'2026-05-12T00:00:00.000'}),
  row(106,{Menge:'0',Bestellnr:777,WEDatum:'2026-09-16T00:00:00.000'}),
  row(107,{EAN:'D-1003',Menge:null,WEDatum:null}),
  row(108,{We:true,Umlagerung:true,Menge:'1',Filialid2:'94',WEDatum:'2026-09-14T00:00:00.000'}),
 ],{sourceInstance:'tradefoto-weum',snapshotAt:'2026-09-24T09:00:00.000Z'});
 const getPrincipal=()=>require('../../../server').loadPortalSessionFromRequest({headers:{cookie:'grabenplaner_session='+token}},{touch:false});
 const runtime=require('../../../lib/persistence/repositories/trade-insights').createTradeInsightRuntime({access:store.provider,vault});
 const jobs=require('../../../lib/persistence/repositories/trade-insight-jobs').createTradeInsightJobs({access:store.provider,vault,runtime,resolvePrincipal:getPrincipal,onError:code=>console.error('PREVIEW_JOB',code)});
 const principal=await getPrincipal();
 const job=await jobs.create(principal,{kind:'movements',query:{},title:'Warenbewegungen · Synthetische Abnahme'});await jobs.tick();
 const saved=await jobs.get(principal,job.id);
 const output=path.resolve(root,'../output/Trade-Block3-2026-09-25');fs.mkdirSync(output,{recursive:true});
 fs.writeFileSync(path.join(output,'Warenbewegungen-Abnahme.pdf'),await require('../../../lib/trade-insight-pdf').createTradeInsightPdf(saved,{sort:'date',direction:'desc'}));
 fs.writeFileSync(path.join(output,'Pruefergebnis.json'),JSON.stringify({synthetic:true,jobId:job.id,rows:saved.result.rows.length,sourceDate:saved.result.sourceDate},null,2));
 protection.destroy();jobs.start();
 const express=require('express'),preview=express();
 preview.get('/start',(req,res)=>{res.set('Cache-Control','no-store');res.cookie('grabenplaner_session',token,{httpOnly:true,sameSite:'strict'});res.cookie('grabenplaner_csrf',csrf,{sameSite:'strict'});res.redirect('/?view=tradeInsights&section=movements');});
 preview.use(app);
 const server=preview.listen(Number(process.env.GP_MOVEMENT_PREVIEW_PORT||0),'127.0.0.1',()=>console.log('MOVEMENT_PREVIEW=http://127.0.0.1:'+server.address().port+'/start'));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
