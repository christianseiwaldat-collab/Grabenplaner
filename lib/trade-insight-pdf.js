'use strict';
const PDFDocument=require('pdfkit'),path=require('node:path');
const C=require('./data-import-contract'),M=require('../public/trade-insight-results');
const clean=value=>String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/[\u2010-\u2015]/g,'-');
function createTradeInsightPdf(snapshot,{sort='',direction='asc'}={}){
 const columns=M.columns(snapshot.kind,snapshot.projection,snapshot.result);
 if(sort&&!columns.some(c=>c.key===sort)||!['asc','desc'].includes(direction))C.fail('IMPORT_SHAPE_INVALID');
 const rows=M.sortRows(snapshot.result.rows,columns,sort,direction);
 return new Promise((resolve,reject)=>{
  const doc=new PDFDocument({size:'A4',layout:'landscape',margin:32,bufferPages:true,autoFirstPage:false,info:{Title:clean(snapshot.title),Author:'Grabenplaner',Subject:'Gespeicherter Ergebnisstand - Einkauf und Bestand'}});
  doc.registerFont('Regular',path.join(__dirname,'pdf-fonts/Roboto-Regular.ttf'));doc.registerFont('Bold',path.join(__dirname,'pdf-fonts/Roboto-Bold.ttf'));
  const chunks=[];let bytes=0,y=0,pages=0;
  doc.on('data',chunk=>{bytes+=chunk.length;if(bytes>32*1024*1024)doc.destroy(new C.DataImportError('IMPORT_REPORT_PDF_LIMIT',413));else chunks.push(chunk);});
  doc.on('error',reject);doc.on('end',()=>resolve(Buffer.concat(chunks)));
  const left=32,width=777.89,bottom=548;
  const font=(bold=false,size=8.5,color='#233e37')=>doc.font(bold?'Bold':'Regular').fontSize(size).fillColor(color);
  function page(){if(++pages>1200)C.fail('IMPORT_REPORT_PDF_LIMIT',413);doc.addPage();doc.rect(left,24,width,24).fill('#e8f0ed');font(true,9).text('GRABENPLANER  /  EINKAUF & BESTAND',left+10,31,{width:width-20,lineBreak:false});y=62;}
  function text(value,bold=false,size=9){const s=clean(value);font(bold,size);const h=doc.heightOfString(s,{width});if(y+h>bottom)page();font(bold,size).text(s,left,y,{width});y+=h+8;}
  const timestamp=value=>new Date(value).toLocaleString('de-AT',{timeZone:'Europe/Vienna'});
  const weights=columns.map(c=>['label','reason','state','classification','article','documentRefs','issueLabel'].includes(c.key)?1.9:['date','sourceLocation','positions','customerNumber'].includes(c.key)?.85:1.15),total=weights.reduce((a,b)=>a+b,0),widths=weights.map(w=>width*w/total);
  function tableRow(values,header=false,index=0){
   font(header,8);const height=Math.max(13,...values.map((v,i)=>doc.heightOfString(clean(v),{width:widths[i]-10})))+10;
   if(height>bottom-115)C.fail('IMPORT_REPORT_PDF_LIMIT',413);
   if(y+height>bottom){page();tableRow(columns.map(c=>c.label),true);}
   if(header||index%2===0)doc.rect(left,y,width,height).fill(header?'#e8f0ed':'#f7f9f8');
   let x=left;values.forEach((value,i)=>{font(header,8).text(clean(value),x+5,y+5,{width:widths[i]-10,align:['number','money','decimal'].includes(columns[i].type)?'right':'left'});x+=widths[i];});
   y+=height;doc.moveTo(left,y).lineTo(left+width,y).lineWidth(.35).strokeColor('#d5dfdb').stroke();
  }
  try{
   page();text(snapshot.title,true,18);text(M.titles[snapshot.kind],true,10);
   text(`Abfrage: ${timestamp(snapshot.created)}  |  Fertiggestellt: ${timestamp(snapshot.completedAt)}  |  ${rows.length} Ergebniszeilen`);
   const labels={articleNumber:'Artikelnummer (exakt)',movementType:'Bewegungsart',review:'Prüffilter',query:'Suche',locationId:'Filiale',supplier:'Lieferant',dateFrom:'Von',dateTo:'Bis',days:'Beobachtung (Tage)',group:'Sortiment',wgr:'Warengruppe',customer:'Kundennummer',serial:'Seriennummer'};
   labels.difference='Differenzfilter';labels.suggestionType='Hinweisart';
   const valueLabel=(key,value)=>key==='suggestionType'?({transfer:'Umlagerung prüfen',restock:'Nachbeschaffung prüfen',incoming:'Zulauf abgleichen',clearance:'Bestandsabbau prüfen',blocked:'Datengrundlage prüfen'}[value]||value):key==='difference'?({positive:'Mehrbestand',negative:'Minderbestand',incomplete:'Mengen unvollständig',inconsistent:'Mengenrechnung prüfen'}[value]||value):null;
   const filters=Object.entries(snapshot.query).filter(([k,v])=>v&&!k.startsWith('stocktake')).map(([k,v])=>`${labels[k]||k}: ${valueLabel(k,v)||{receipt:'Wareneingang',transfer:'Umlagerung',unclear:'Bewegungsart ungeklärt',issues:'Mit Prüfhinweis',negative:'Negative Mengen',positive:'Mehrbestand',incomplete:'Mengen unvollständig',inconsistent:'Mengenrechnung prüfen',missing_date:'Ohne Buchungsdatum'}[['movementType','review','difference'].includes(k)?v:'']||v}`).join('  ·  ');
   if(filters)text(filters);
   const inventory=snapshot.result.stocktake;if(inventory)text(`Inventur ${inventory.number} · Filiale ${inventory.sourceLocation} · ${M.format(inventory.date,'date')} · ${inventory.positions} Positionen gesamt · ${inventory.unchanged} unverändert · ${inventory.booking}`,true,10);
   if(!snapshot.query.locationId&&!inventory)text('Filialauswahl: Alle freigegebenen Filial-IDs zusammen');
   const sources=snapshot.result.sourceDates?.length?snapshot.result.sourceDates:[snapshot.result.sourceDate].filter(Boolean);
   text(`Quellstand: ${sources.length?sources.map(timestamp).join(' / '):'nicht angegeben'}  |  Sortierung: ${sort?columns.find(c=>c.key===sort).label+' '+(direction==='desc'?'absteigend':'aufsteigend'):'ursprüngliche Ergebnisreihenfolge'}`);
   const t=snapshot.result.totals;
   if(t)text(`Bestand (vorläufig): ${M.format(t.positiveQuantity,'number')}  ·  Bestätigte Lagermenge: ${M.format(t.confirmedQuantity,'number')}${snapshot.projection.costs?`  ·  Warenwert netto (vorläufig): ${M.format(t.provisionalNet,'money')}  ·  Bestätigte Lagerware: ${M.format(t.confirmedNet,'money')}`:''}`,true,10);
   if(snapshot.result.note)text(snapshot.result.note,false,8);
   text('Gespeicherter Ergebnisstand. Beim Öffnen und Exportieren wird keine neue Suche ausgeführt.',false,8);
   if(rows.length){tableRow(columns.map(c=>c.label),true);rows.forEach((r,i)=>tableRow(columns.map(c=>M.format(c.value(r),c.type)),false,i));}else text('Keine Treffer für diese Auswahl.');
   const range=doc.bufferedPageRange();for(let i=0;i<range.count;i++){doc.switchToPage(i);doc.page.margins.bottom=0;font(false,8,'#64786f').text(`Ergebnisstand ${timestamp(snapshot.completedAt)}  ·  Seite ${i+1} / ${range.count}`,left,566,{width,lineBreak:false,align:'right'});}
   doc.end();
  }catch(error){doc.destroy();reject(error);}
 });
}
module.exports={createTradeInsightPdf};
