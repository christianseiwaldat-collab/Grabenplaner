'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {interpret}=require('../lib/persistence/repositories/trade-movements');
const M=require('../public/trade-insight-results'),UI=require('../public/trade-movements');
const sourceInstance='tradefoto-weum';
const movement=(id,extra={})=>({We_ID:String(id),We:true,Umlagerung:false,EAN:'000042',Suchname:'Canon',FilialID:'18',Menge:'2',WEDatum:'2026-09-10T00:00:00.000',AkWeDatum:'2026-09-11T00:00:00.000',...extra});
test('signed source quantities, flags and precision retain their actual meaning',()=>{
 for(const [value,state] of [['-0.00000001','negative'],['0','zero'],[null,'missing'],['2.2','positive']])assert.equal(interpret(movement(1,{Menge:value})).quantityState,state);
 for(const flags of [[true,true],[false,false],[true,null],[null,true]])assert.equal(interpret(movement(1,{We:flags[0],Umlagerung:flags[1]})).kind,'unclear');
 assert.equal(UI.amount('-0.00000001'),'-0,00000001');assert.equal(M.format('-0.00000001','decimal'),'-0,00000001');
 assert.deepEqual(M.sortRows([{quantity:'-0.01'},{quantity:'-2'}],M.columns('movements'),'quantity').map(r=>r.quantity),['-2','-0.01']);
});

test('article movements keyset statements compile for PostgreSQL with literal column contracts',()=>{
 const entries=require('../lib/persistence/postgresql/reporting/branch-article-catalog').BRANCH_ARTICLE_CATALOG.filter(e=>e.statement.id.startsWith('trade-insights.article-movements-'));assert.equal(entries.length,4);
 for(const entry of entries){assert.match(entry.sql,/integration\s*\.\s*"?import_history_references/);assert.doesNotMatch(entry.sql,/\$(scopeId|master1|afterDate|afterId)/);assert.ok(entry.parameterOrder.includes('master14'));assert.match(entry.sql,/ORDER BY.*DESC/);}
});

test('all five bounded movement statements compile into the PostgreSQL reporting catalog',()=>{
 const entries=require('../lib/persistence/postgresql/reporting/branch-article-catalog').BRANCH_ARTICLE_CATALOG.filter(e=>e.statement.id.startsWith('trade-insights.movement'));
 assert.equal(entries.length,5);for(const e of entries){assert.doesNotMatch(e.sql,/\$(scopeId|dateFrom|dateTo|missingDate|weHash)/);assert.ok(e.parameterOrder.length);}
 assert.match(entries.find(e=>e.statement.id.endsWith('records')).sql,/LIMIT/);
});
test('multipage journal PDF keeps all rows, archive labels and printable page boundaries',async()=>{
 const rows=Array.from({length:28},(_,i)=>({movementNumber:String(i+1),date:'2026-09-10',typeLabel:'Wareneingang',kind:'receipt',articleNumber:'DEMO-'+i,label:'Lange synthetische Artikelbezeichnung zur Prüfung des Zeilenumbruchs',articleReference:{status:'archived'},quantity:i%2?'-0.25':'2',from:'Lieferant',to:'Filiale 18',supplier:'Demo Lieferant',documentRefs:'Best. 123 · LS DEMO-444 · RE DEMO-222',issueLabel:'Negative Menge · Grund ungeklärt'}));
 const pdf=await require('../lib/trade-insight-pdf').createTradeInsightPdf({kind:'movements',title:'PDF-Layoutprüfung',created:'2026-09-25T09:00:00.000Z',completedAt:'2026-09-25T09:00:00.000Z',query:{movementType:'receipt'},projection:{},result:{rows,note:'Synthetische Beispiele',sourceDate:'2026-09-24T09:00:00.000Z'}});
 const loading=(await import('pdfjs-dist/legacy/build/pdf.mjs')).getDocument({data:new Uint8Array(pdf),isEvalSupported:false}),doc=await loading.promise,text=[];
 try{assert.ok(doc.numPages>1);for(let i=1;i<=doc.numPages;i++){const content=await (await doc.getPage(i)).getTextContent();text.push(content.items.map(r=>r.str).join(' '));for(const item of content.items.filter(r=>r.str?.trim())){assert.ok(item.transform[4]>=31&&item.transform[4]+item.width<=812,item.str);assert.ok(item.transform[5]>=20&&item.transform[5]<=573,item.str);}}assert.match(text.join(' '),/Archiviert/);assert.match(text.join(' '),/DEMO-27/);assert.match(text.join(' '),/-0,25/);}finally{await loading.destroy();}
});
