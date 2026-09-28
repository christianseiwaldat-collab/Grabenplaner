'use strict';
// Deliberately outside the GP runtime: authenticated loopback preview on verified copies.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const {DatabaseSync}=require('node:sqlite'),Reader=require('mdb-reader').default;
const {createModel}=require('./model.cjs');
const root=path.resolve(__dirname,'../../..'),analysis=path.resolve(process.env.TRADE_ANALYSIS_DIRECTORY||path.join(root,'../output/Trade-Ergaenzungsanalyse-2026-09-22'));
const hash=file=>new Promise((resolve,reject)=>{const h=crypto.createHash('sha256');fs.createReadStream(file).on('data',b=>h.update(b)).on('end',()=>resolve(h.digest('hex'))).on('error',reject);});
async function load(){
  const proofs=JSON.parse(fs.readFileSync(path.join(analysis,'quellen.json'),'utf8')),sources=[];
  for(const name of ['TRADE_AusgangsRech.accdb','Trade_Daten.accdb']){
    const proof=proofs.find(p=>p.Name===name),copy=path.join(analysis,'arbeitsdaten',name);
    if(!proof||await hash(copy)!==proof.SHA256.toLowerCase())throw Error('Source copy fingerprint mismatch: '+name);
    sources.push({name,sha256:proof.SHA256.toLowerCase()});
  }
  const reader=new Reader(fs.readFileSync(path.join(analysis,'arbeitsdaten','TRADE_AusgangsRech.accdb')));
  const fields={Rechnung_A:['ID','Rechnungsnr','Suchname','BFirma','Anlegedatum','Buchdatum'],Rechnungsdetails_A:['ID','we_id','Rechnungsnr','Suchname','EAN','Artikelbezeichnung','menge','Rechnungspreis','NNPreis','WELieferscheinnr','Filialid']};
  const rows={};for(const [table,columns]of Object.entries(fields)){const t=reader.getTable(table);rows[table]=t.getData({columns});if(rows[table].length!==t.rowCount)throw Error('Source row count mismatch');}
  // Independently verify all used invoice values against the prior Jackcess export.
  const cached=new DatabaseSync(path.join(analysis,'arbeitsdaten','trade_ausgangsrech.sqlite'),{readOnly:true});
  try{for(const [table,columns]of Object.entries(fields)){
    const canonical=row=>JSON.stringify(columns.map(c=>row[c] instanceof Date?row[c].toISOString().replace('T',' ').replace('.000Z',''):row[c]??null));
    const original=rows[table].map(canonical).sort(),second=cached.prepare('SELECT '+columns.map(c=>'"'+c+'"').join(',')+' FROM "'+table+'"').all().map(canonical).sort();
    if(JSON.stringify(original)!==JSON.stringify(second))throw Error('Independent reader comparison failed: '+table);
  }}finally{cached.close();}
  const master=new DatabaseSync(path.join(analysis,'arbeitsdaten','trade_daten.sqlite'),{readOnly:true});let masters;
  try{masters=master.prepare('SELECT EAN,Artikelbezeichnung,Verkaufspreis,DurchschnittEK FROM ARTIKEL_STAMM').all();}finally{master.close();}
  const model=createModel({heads:rows.Rechnung_A,details:rows.Rechnungsdetails_A,masters});
  const sourceDate=rows.Rechnung_A.map(r=>r.Anlegedatum.toISOString().slice(0,10)).sort().at(-1);
  return {model,meta:{...model.summary,sourceDate,sources,readOnly:true,independentInvoiceReaderComparison:true,preview:true}};
}
async function main(){
  const {model,meta}=await load(),token=crypto.randomBytes(32).toString('hex');
  const assets=new Map([['/',['index.html','text/html']],['/app.js',['app.js','text/javascript']],['/style.css',['style.css','text/css']],['/date-range-calendar.js',[path.join(root,'public/date-range-calendar.js'),'text/javascript']],['/trade-period.js',[path.join(root,'public/trade-period.js'),'text/javascript']]]);
  let origin;
  const server=http.createServer((req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    if(req.method!=='GET'||req.headers.host!==new URL(origin).host||req.headers.origin&&req.headers.origin!==origin)return send(403,{error:'Lokale Vorschau erforderlich.'});
    const url=new URL(req.url,origin);
    if(url.pathname==='/start'&&url.searchParams.get('token')===token){res.writeHead(303,{'Set-Cookie':`trade_invoice_preview=${token}; HttpOnly; SameSite=Strict; Path=/`,Location:'/'});res.end();return;}
    const cookie=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('trade_invoice_preview='));
    if(cookie!=='trade_invoice_preview='+token)return send(401,{error:'Bitte die lokale Vorschau über ihren Startlink öffnen.'});
    try{
      if(url.pathname==='/api/meta')return send(200,meta);
      if(url.pathname==='/api/search')return send(200,{articles:model.search(url.searchParams.get('q')||'')});
      if(url.pathname==='/api/article'){const number=url.searchParams.get('number');if(!number||number.length>150)return send(422,{error:'Artikelnummer fehlt.'});const result=model.article(number);return send(result?200:404,result||{error:'Artikel nicht gefunden.'});}
      const asset=assets.get(url.pathname);if(!asset)return send(404,{error:'Nicht gefunden.'});
      res.writeHead(200,{'Content-Type':asset[1]+'; charset=utf-8'});res.end(fs.readFileSync(path.resolve(__dirname,asset[0])));
    }catch{send(422,{error:'Die Auswahl konnte nicht gelesen werden.'});}
  });
  server.listen(0,'127.0.0.1',()=>{origin='http://127.0.0.1:'+server.address().port;const state={url:origin+'/start?token='+token,origin,meta};fs.writeFileSync(path.join(root,'tmp/supplier-invoice-preview.json'),JSON.stringify(state,null,2));console.log(JSON.stringify(state));});
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={load};
