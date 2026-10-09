'use strict';
const D=require('./tradefoto-bestell/decimal');
const {buildSalesArticleCatalogProjection}=require('./sales-article-catalog-access');
const {projectionFor}=require('./tradefoto-bestell/access');
const {matches}=require('./flexible-search');
const KEY='sales_article_report_v1';
const MAX_ROWS=10000,MAX_SCANNED=50000;
const COLUMNS=Object.freeze([
 {id:'articleNumber',label:'Artikelnummer',width:110,type:'text'},
 {id:'description',label:'Bezeichnung',width:280,type:'text'},
 {id:'assortment',label:'Sortimentsart',width:135,type:'text'},
 {id:'location',label:'Filiale',width:150,type:'text'},
 {id:'quantity',label:'Bestand',width:90,type:'decimal'},
 {id:'ordered',label:'Bestellt',width:90,type:'decimal'},
 {id:'retailGross',label:'EH-VK brutto',width:125,type:'money',permission:'prices'},
 {id:'internetGross',label:'Internet-VK brutto',width:135,type:'money',permission:'prices'},
 {id:'averageCost',label:'Ø EK netto',width:125,type:'money',permission:'costs'},
 {id:'marginPercent',label:'RE %',width:90,type:'percent',permission:'margin'},
 {id:'stockValue',label:'Bestandswert netto',width:150,type:'money',permission:'costs'},
]);
const SORTIMENTS=Object.freeze([
 {id:'all',label:'Alle Sortimentsarten'}, {id:'sellout',label:'Abverkauf'},
 {id:'discontinued',label:'Auslaufartikel'}, {id:'no-stock',label:'Ohne Bestandsführung'},
]);
const fail=(message,status=400,code='ARTICLE_REPORT_INVALID')=>{throw Object.assign(new Error(message),{status,code});};
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
function exact(input,allowed){if(!plain(input)||Object.keys(input).some(k=>!allowed.includes(k)))fail('Die Artikelauswertung enthält unbekannte oder ungültige Felder.');}
function text(value,max,fallback=''){if(value===undefined)return fallback;if(typeof value!=='string'||value.length>max||/[\u0000-\u001f\u007f]/u.test(value))fail('Bitte einen gültigen Text eingeben.');return value.trim();}
function capabilities(session){const catalog=buildSalesArticleCatalogProjection(session),stock=projectionFor(session);
 const read=!!catalog.read&&!!stock.inventory&&!!stock.read;
 return Object.freeze({read,prices:read&&catalog.pricesRead,costs:read&&catalog.costsRead&&stock.costs,
  margin:read&&catalog.pricesRead&&catalog.costsRead&&stock.costs});}
function columnsFor(caps){return COLUMNS.filter(c=>!c.permission||caps[c.permission]);}
function integer(value,minimum,maximum,fallback){if(value===undefined||value==='')return fallback;const result=typeof value==='number'?value:/^\d+$/.test(String(value))?Number(value):NaN;
 if(!Number.isSafeInteger(result)||result<minimum||result>maximum)fail('Die Seiteneinteilung der Artikelauswertung ist ungültig.');return result;}
function normalizeFilters(input={},caps={prices:true,costs:true,margin:true}){
 exact(input,['query','assortment','locations','stock','sort','direction','limit','offset']);
 let locations=input.locations===undefined?[]:typeof input.locations==='string'?input.locations.split(',').filter(Boolean):input.locations;
 if(!Array.isArray(locations)||locations.length>100)fail('Bitte höchstens 100 Filialen auswählen.');
 locations=[...new Set(locations.map(value=>text(value,120)))].sort();if(locations.some(v=>!v))fail('Die Filialauswahl ist ungültig.');
 const assortment=text(input.assortment,100,'all');
 if(!SORTIMENTS.some(s=>s.id===assortment)&&!assortment.startsWith('source:'))fail('Bitte eine vorhandene Sortimentsart auswählen.');
 const stock=text(input.stock,20,'positive');if(!['positive','all'].includes(stock))fail('Bitte einen gültigen Bestandsfilter wählen.');
 const sort=text(input.sort,50,'articleNumber');if(!columnsFor(caps).some(c=>c.id===sort))fail('Für diese Sortierung fehlt das Leserecht.',403,'ARTICLE_REPORT_FORBIDDEN');
 const direction=text(input.direction,4,'asc');if(!['asc','desc'].includes(direction))fail('Die Sortierrichtung ist ungültig.');
 return {query:text(input.query,150),assortment,locations,stock,sort,direction,limit:integer(input.limit,1,200,50),offset:integer(input.offset,0,MAX_ROWS,0)};
}
const decimal=value=>typeof value==='string'&&/^-?\d+(?:\.\d+)?$/.test(value)?value:null;
const yes=value=>value===true||value===1;
function articleNumber(sourceKey){const key=String(sourceKey||'');if(/^\d{13}$/.test(key)){try{return require('./tradefoto-article-source-profile').normalizeTradeFotoSourceArticleKey(key).articleNumber;}catch{}}return key;}
function assortmentMatches(source,filter){const label=String(source?.Sortimentsart||'');
 if(filter==='all')return true;if(filter==='sellout')return yes(source.Abverkauf)||/abverkauf/i.test(label);
 if(filter==='discontinued')return yes(source.Auslaufartikel)||/auslauf/i.test(label);
 if(filter==='no-stock')return yes(source.OhneBestand)||/keine lw|ohne bestand/i.test(label);
 return label===filter.slice(7);
}
function projectRow({key,source,stock,catalog,location,ambiguous=false},caps){
 const quantity=ambiguous?null:decimal(stock.FBestand),ordered=ambiguous?null:decimal(stock.Bestellt);
 const row={id:key,articleNumber:catalog?.articleNumber||articleNumber(source.EAN||stock.EAN),
  description:catalog?.description||String(source.Artikelbezeichnung||''),assortment:require('./branch-article-detail').businessStatus(source),
  location:location.label,locationId:location.id,sourceLocation:String(stock.FilialID),quantity,ordered,ambiguous,
  updatedAt:stock.Bestandsänderungsdatum||null};
 const retailGross=decimal(catalog?.retailGross),internetGross=decimal(catalog?.internetGross);
 if(caps.prices)Object.assign(row,{retailGross,internetGross});
 const currentTrade=!catalog||catalog.sourceSystem==='tradefoto.artikel_stamm';
 const averageCost=currentTrade?decimal(source.DurchschnittEK):decimal(catalog.purchaseNet);
 const validCost=averageCost!==null&&D.compare(averageCost,'0')>=0?averageCost:null;
 if(caps.costs)Object.assign(row,{averageCost:validCost,stockValue:quantity!==null&&D.compare(quantity,'0')>=0&&validCost!==null&&!yes(source.OhneBestand)&&!yes(source.Sachkonto)?D.multiply(quantity,validCost):null});
 if(caps.margin){
  let net=decimal(catalog?.retailNet);const rate=new Map([['0','0'],['1','20'],['2','10'],['3','19'],['4','7']]).get(String(source.MWST));
  if(net===null&&currentTrade&&retailGross!==null&&rate!==undefined)net=D.divide(retailGross,D.add('1',D.divide(rate,'100',4)),12);
  row.marginPercent=net!==null&&D.compare(net,'0')>0&&validCost!==null?D.multiply(D.divide(D.subtract(net,validCost),net,8),'100'):null;
 }
 return row;
}
function compareRows(a,b,q){const column=COLUMNS.find(c=>c.id===q.sort),av=a[q.sort],bv=b[q.sort];
 let comparison;if(av===null||av===undefined||bv===null||bv===undefined){if(av==null&&bv==null)comparison=0;else return av==null?1:-1;}
 else comparison=column.type==='text'?String(av).localeCompare(String(bv),'de-AT',{numeric:true,sensitivity:'base'}):D.compare(av,bv);
 return comparison*(q.direction==='desc'?-1:1)||a.articleNumber.localeCompare(b.articleNumber,'de-AT',{numeric:true})||a.locationId.localeCompare(b.locationId,'de-AT',{numeric:true})||a.id.localeCompare(b.id);
}
function resultFor(rows,q,sourceAt,caps,details={}){
 const filtered=rows.filter(r=>(q.stock!=='positive'||r.quantity!==null&&D.compare(r.quantity,'0')>0)&&matches([r.articleNumber,r.description],q.query));
 if(filtered.length>MAX_ROWS)fail('Die Auswahl enthält mehr als 10.000 passende Artikel-Filial-Zeilen. Bitte die Auswahl eingrenzen.',413,'ARTICLE_REPORT_LIMIT');
 filtered.sort((a,b)=>compareRows(a,b,q));const total=filtered.length;
 const summary={articles:new Set(filtered.map(r=>r.articleNumber)).size,positions:total,quantity:'0',missingQuantity:0,ambiguous:0};
 if(caps.costs)Object.assign(summary,{stockValue:'0',missingValue:0});
 for(const row of filtered){if(row.quantity===null)summary.missingQuantity++;else summary.quantity=D.add(summary.quantity,row.quantity);if(row.ambiguous)summary.ambiguous++;
  if(caps.costs){if(row.stockValue===null)summary.missingValue++;else summary.stockValue=D.add(summary.stockValue,row.stockValue);}}
 return {available:true,rows:filtered.slice(q.offset,q.offset+q.limit),total,hasMore:q.offset+q.limit<total,sourceAt,summary,
  note:'Bestand zum importierten Quellstand. RE % = (EH-VK netto minus Ø EK netto) / EH-VK netto. Kein historischer Verkaufsertrag. Fehlende oder mehrdeutige Werte bleiben leer; Mengen verschiedener Artikel können unterschiedliche Einheiten haben.',...details};
}
function normalizePreferences(input,caps){exact(input,['columns','columnWidths','sort','direction']);
 const available=columnsFor(caps).map(c=>c.id),columns=input.columns===undefined?['articleNumber','description','assortment','location','quantity','ordered','retailGross','marginPercent'].filter(c=>available.includes(c)):Array.isArray(input.columns)?[...input.columns]:input.columns;
 if(!Array.isArray(columns)||!columns.length||columns.length>COLUMNS.length||new Set(columns).size!==columns.length||columns.some(c=>!available.includes(c)))fail('Bitte gültige Spalten für die Artikelauswertung wählen.');
 if(!columns.includes('articleNumber'))columns.unshift('articleNumber');
 const widths=input.columnWidths||{};if(!plain(widths)||Object.keys(widths).some(k=>!available.includes(k)))fail('Die Spaltenbreiten sind ungültig.');
 for(const width of Object.values(widths))if(!Number.isInteger(width)||width<60||width>800)fail('Spaltenbreiten müssen zwischen 60 und 800 Pixel liegen.');
 const sort=input.sort||'articleNumber';if(!available.includes(sort))fail('Für diese Sortierung fehlt das Leserecht.',403,'ARTICLE_REPORT_FORBIDDEN');
 const direction=input.direction||'asc';if(!['asc','desc'].includes(direction))fail('Die Sortierrichtung ist ungültig.');
 return {columns:[...columns],columnWidths:{...widths},sort,direction};
}
module.exports={KEY,COLUMNS,SORTIMENTS,MAX_ROWS,MAX_SCANNED,fail,exact,text,capabilities,columnsFor,normalizeFilters,decimal,articleNumber,assortmentMatches,projectRow,compareRows,resultFor,normalizePreferences};
