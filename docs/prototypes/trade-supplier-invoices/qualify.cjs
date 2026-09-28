'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const root=path.resolve(__dirname,'../../..'),analysis=path.resolve(root,'../output/Trade-Ergaenzungsanalyse-2026-09-22'),data=path.join(analysis,'arbeitsdaten');
const output=path.resolve(root,'../output/Trade-Lieferantenrechnungen-2026-09-27');
const hash=p=>new Promise((resolve,reject)=>{const h=crypto.createHash('sha256');fs.createReadStream(p).on('data',b=>h.update(b)).on('end',()=>resolve(h.digest('hex'))).on('error',reject);});
async function main(){
 const evidence={checkedAt:new Date().toISOString(),sourceReadOnly:true,sources:[]};
 for(const p of JSON.parse(fs.readFileSync(path.join(analysis,'quellen.json')))){
  if(path.basename(p.Name)!==p.Name)throw Error('Invalid source name');
  const copy=await hash(path.join(data,p.Name)),original=await hash(path.join('C:/Users/chris/Desktop/Datenbanken',p.Name));
  evidence.sources.push({name:p.Name,sha256:copy,matchesRecordedCopy:copy===p.SHA256.toLowerCase(),matchesOriginal:copy===original});
  if(copy!==p.SHA256.toLowerCase()||copy!==original)throw Error('Source changed: '+p.Name);
 }
 const catalog=JSON.parse(fs.readFileSync(path.join(data,'catalog.json')));
 evidence.binaryOrAttachmentColumns=catalog.flatMap(d=>d.tables.flatMap(t=>t.columns.filter(c=>['BINARY','OLE','COMPLEX_TYPE'].includes(c.type)).map(c=>({database:d.database,table:t.table,column:c.name,type:c.type,nonEmpty:c.populated}))));
 const emails=new DatabaseSync(path.join(data,'trade_email_daten.sqlite'),{readOnly:true}),folders=new Map();let references=0,pdfs=0;
 for(const r of emails.prepare('SELECT Attachment1 FROM Emails').iterate())for(const ref of String(r.Attachment1||'').split(';').filter(Boolean)){references++;if(/\.pdf$/i.test(ref))pdfs++;const folder=path.win32.dirname(ref).toLowerCase().replace(/\\+$/,'');folders.set(folder,(folders.get(folder)||0)+1);}
 evidence.emailDocuments={rows:emails.prepare('SELECT COUNT(*) n FROM Emails').get().n,references,pdfPaths:pdfs,folders:[...folders].map(([folder,count])=>({folder,count})),invoiceFolderReferences:emails.prepare("SELECT Attachment1 FROM Emails WHERE lower(Attachment1) LIKE '%\\rechnungen\\%'").all(),localTradeFolderPresent:fs.existsSync('C:/tradefoto'),localTDrivePresent:fs.existsSync('T:/')};emails.close();
 const db=new DatabaseSync(path.join(data,'trade_ausgangsrech.sqlite'),{readOnly:true});
 evidence.links=db.prepare('SELECT COUNT(*) positions,SUM(h.ID IS NOT NULL) matched FROM Rechnungsdetails_A d LEFT JOIN Rechnung_A h ON h.Rechnungsnr=d.Rechnungsnr COLLATE NOCASE AND h.Suchname=d.Suchname COLLATE NOCASE').get();
 evidence.headerDates=db.prepare('SELECT MIN(Anlegedatum) firstCreated,MAX(Anlegedatum) lastCreated,SUM(date(Anlegedatum)<>date(Buchdatum)) differentDates,SUM(Buchdatum IS NULL) missingBooking,COUNT(DISTINCT Suchname) suppliers FROM Rechnung_A').get();
 evidence.priceCheck=db.prepare('WITH l AS(SELECT Rechnungsnr,Suchname,SUM(menge*Rechnungspreis*(1+MWST/100.0)) gross FROM Rechnungsdetails_A GROUP BY Rechnungsnr COLLATE NOCASE,Suchname COLLATE NOCASE) SELECT COUNT(*) invoices,SUM(ABS(h.Rechnungsbetrag-l.gross)<0.1) matchingGrossWithinTenCents FROM Rechnung_A h JOIN l ON h.Rechnungsnr=l.Rechnungsnr COLLATE NOCASE AND h.Suchname=l.Suchname COLLATE NOCASE').get();db.close();
 const {meta}=await require('./server.cjs').load();evidence.preview=meta;
 evidence.scope='Local source analysis and interactive prototype; no GP runtime registration, productive import, VPS, commit, push or deploy.';
 fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'Pruefnachweis.json'),JSON.stringify(evidence,null,2));
 console.log(JSON.stringify({sourcesVerified:evidence.sources.length,links:evidence.links,dates:evidence.headerDates,price:evidence.priceCheck,pdfs:evidence.emailDocuments,model:meta}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
