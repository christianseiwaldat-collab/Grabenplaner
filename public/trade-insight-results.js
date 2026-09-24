(function(host,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(host)host.GrabenplanerTradeResults=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const titles={purchasing:'Einkauf / Lieferstände',transfers:'Filialversorgung','stock-summary':'Filialbestand & Warenwert',inventory:'Bestand / Langsamdreher',repairs:'Reparaturen','customer-history':'Kundenhistorie','device-history':'Gerätehistorie'};
 const collator=new Intl.Collator('de-AT',{numeric:true,sensitivity:'base'});
 const kinds={goods:'Lagerware',service:'Dienstleistung',account:'Verrechnung',excluded:'Ohne Lagerbestand',unknown:'Ungeklärt'};
 const states={quantity_missing:'Menge fehlt',correction_or_return:'Korrektur / Rücknahme',overdelivered_quantity:'Mehr geliefert',zero_order:'Bestellmenge 0',quantity_fulfilled:'Menge geliefert',partial_quantity:'Teilmenge geliefert',undelivered_quantity:'Keine Lieferung vermerkt',transfer_processed:'Umlagerung vermerkt',transfer_requested:'Umlagerung angefordert',ordering_processed:'Bestellt',request_declined:'Abgelehnt',request_pending:'Anforderung',status_unknown:'Status ungeklärt'};
 const column=(key,label,type='text',value=r=>r[key])=>({key,label,type,value});
 function columns(kind,projection={}){
  const c=column;
  if(['repairs','customer-history','device-history'].includes(kind))return [c('kind','Art','text',r=>({repair:'Reparatur',invoice:'Rechnung',offer:'Angebot',order:'Auftrag',payment:'Teilzahlung',device:'Gerät',cash:'Kassenbeleg'})[r.kind]||r.kind),c('date','Datum','date'),c('documentNumber','Beleg / Vorgang'),c('sourceLocation','Filiale'),c('customerNumber','Kundennr.'),c('label','Artikel / Gerät'),c('serialNumber','Seriennummer'),c('sourceStatus','TradeRepair','text',r=>({ready:'Abholbereit',in_progress:'In Bearbeitung'})[r.sourceStatus]),c('gpStatus','GP-Status','text',r=>({unassigned:'Nicht gesetzt',ready:'Abholbereit',collected:'Abgeholt'})[r.gpStatus]),c('amount','Betrag','money')];
  if(kind==='stock-summary')return [c('label','Sortimentsgruppe','text',r=>r.id?r.id+' · '+r.label:r.label),c('positions','Quellpositionen','number'),c('confirmedQuantity','Bestätigte Lagermenge','number'),c('unclassifiedQuantity','Menge ungeklärt','number'),...(projection.costs?[c('provisionalNet','Warenwert netto (vorläufig)','money'),c('confirmedNet','Davon bestätigte Lagerware','money')]:[]),c('unclassified','Artikel ungeklärt','number'),c('issues','Prüffälle','number',r=>r.ambiguous+r.missingArticle+r.missingQuantity+r.negative+(r.missingCost||0)+(r.zeroCost||0))];
  if(kind==='inventory')return [c('articleNumber','Artikelnr.'),c('label','Bezeichnung'),c('sourceLocation','Filiale'),c('stock','Bestand','number'),c('classification','Einstufung','text',r=>kinds[r.classification?.kind]),c('soldNet','Nettoabsatz','number'),c('noRecordedSale','Ohne Verkauf','text',r=>r.noRecordedSale==null?null:r.noRecordedSale?'Ja':'Nein'),c('coverageDays','Reichweite (Tage)','number'),...(projection.costs?[c('purchaseNet','Ø EK netto','money'),c('stockValue','Bestandswert netto','money')]:[]),c('reason','Einordnung')];
  const purchasing=kind==='purchasing';
  return [c('date','Datum','date'),...(purchasing?[c('orderNumber','Bestellung')]:[]),c('articleNumber','Artikelnr.'),c('label','Bezeichnung'),c('sourceLocation',purchasing?'Filiale':'Nach Filiale'),...(purchasing?[c('supplier','Lieferant'),c('ordered','Bestellt','number'),c('deliveredCumulative','Geliefert kum.','number'),c('rawDifference','Differenz','number')]:[c('from','Von Filiale'),c('quantity','Menge','number')]),c('state','Quellstatus','text',r=>states[r.state]||r.state)];
 }
 function format(value,type){
  if(value==null||value==='')return '–';
  if(type==='date')return String(value).slice(0,10).split('-').reverse().join('.');
  if(type==='number'||type==='money')return new Intl.NumberFormat('de-AT',type==='money'?{style:'currency',currency:'EUR'}:{maximumFractionDigits:4}).format(Number(value));
  return String(value);
 }
 // Decimal strings stay exact while sorting (including amounts beyond 2^53).
 function decimalCompare(a,b){
  const parse=value=>{const s=String(value),negative=s.startsWith('-'),[whole,fraction='']=s.replace(/^[+-]/,'').split('.');return {negative,whole:whole.replace(/^0+(?=\d)/,''),fraction};};
  const x=parse(a),y=parse(b),zero=v=>!/[1-9]/.test(v.whole+v.fraction);if(zero(x))x.negative=false;if(zero(y))y.negative=false;
  if(x.negative!==y.negative)return x.negative?-1:1;
  const length=Math.max(x.fraction.length,y.fraction.length),l=x.fraction.padEnd(length,'0'),r=y.fraction.padEnd(length,'0');
  const n=x.whole.length-y.whole.length||(x.whole>y.whole?1:x.whole<y.whole?-1:0)||(l>r?1:l<r?-1:0);return x.negative?-n:n;
 }
 function sortRows(rows,columns,key,direction='asc'){
  const c=columns.find(c=>c.key===key);if(!c)return rows.slice();
  return rows.map((row,index)=>({row,index})).sort((a,b)=>{
   const x=c.value(a.row),y=c.value(b.row),xn=x==null||x==='',yn=y==null||y==='';if(xn||yn)return xn===yn?a.index-b.index:xn?1:-1;
   const order=['number','money'].includes(c.type)?decimalCompare(x,y):c.type==='date'?(String(x)>String(y)?1:String(x)<String(y)?-1:0):collator.compare(String(x),String(y));
   return (direction==='desc'?-order:order)||a.index-b.index;
  }).map(v=>v.row);
 }
 return {titles,columns,format,sortRows,collator};
});
