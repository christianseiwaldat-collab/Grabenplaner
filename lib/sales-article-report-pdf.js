'use strict';
const fs=require('node:fs'),path=require('node:path');
const PDFDocument=require('pdfkit');
const Model=require('./sales-article-report-model');
function plain(value,max=500){return String(value??'').normalize('NFC').replace(/<[^>]*>/g,' ').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/[\u2010-\u2015\u2212]/g,'-').replace(/\s+/g,' ').trim().slice(0,max);}
function filename(value){const name=plain(value,120).replace(/[<>:"/\\|?*]/g,'-').replace(/\.pdf$/i,'').replace(/^[. -]+|[. -]+$/g,'')||'Artikel-Auswertung';return name+'.pdf';}
function normalize(input,caps){Model.exact(input,['filters','columns','title','name','orientation']);
 const filters=Model.normalizeFilters(input.filters||{},caps),available=Model.columnsFor(caps);
 const ids=input.columns===undefined?Model.normalizePreferences({},caps).columns:input.columns;
 if(!Array.isArray(ids)||!ids.length||ids.length>Model.COLUMNS.length||new Set(ids).size!==ids.length||ids.some(id=>!available.some(c=>c.id===id)))Model.fail('Bitte gültige PDF-Spalten auswählen.');
 const orientation=Model.text(input.orientation,12,'landscape');if(!['portrait','landscape'].includes(orientation))Model.fail('Bitte Hoch- oder Querformat wählen.');
 return {filters,columns:ids.map(id=>available.find(c=>c.id===id)),title:Model.text(input.title,160,'Artikel-Auswertung')||'Artikel-Auswertung',name:filename(Model.text(input.name,120,'Artikel-Auswertung')),orientation};
}
function cell(row,column){const value=row[column.id];if(value===null||value===undefined||value==='')return '-';
 if(column.type==='text')return plain(value,500);const number=Number(value);if(!Number.isFinite(number))return '-';
 const formatted=new Intl.NumberFormat('de-AT',{minimumFractionDigits:column.type==='money'?2:0,maximumFractionDigits:column.type==='decimal'?3:2}).format(number);
 return formatted+(column.type==='money'?' EUR':column.type==='percent'?' %':'');
}
function render({spec,report,generatedAt=new Date().toISOString()}){
 if(!report.available)Model.fail('Für diese Auswahl ist noch kein Bestandsstand vorhanden.',409,'ARTICLE_REPORT_UNAVAILABLE');
 if(!report.total)Model.fail('Für die gewählten Filter wurden keine Artikel gefunden.',400,'ARTICLE_REPORT_EMPTY');
 if(report.rows.length!==report.total||report.hasMore)Model.fail('Die Artikelauswertung ist nicht vollständig.',409,'ARTICLE_REPORT_INCOMPLETE');
 return new Promise((resolve,reject)=>{
 const doc=new PDFDocument({size:'A4',layout:spec.orientation,margin:0,bufferPages:true,autoFirstPage:false,compress:true,
  info:{Title:plain(spec.title,160),Author:'Grabenplaner',Subject:'Artikel-Auswertung aus importiertem Filialbestand',CreationDate:new Date(generatedAt),ModDate:new Date(generatedAt)}});
 const chunks=[];let bytes=0,pages=0;doc.on('data',chunk=>{bytes+=chunk.length;if(bytes>10*1024*1024){doc.destroy();reject(Object.assign(new Error('Die PDF-Auswertung überschreitet 10 MiB.'),{status:413}));}else chunks.push(chunk);});
 doc.on('error',reject);doc.on('end',()=>resolve({buffer:Buffer.concat(chunks),pages,rows:report.total,name:spec.name}));
 const fonts=path.join(__dirname,'../public/fonts/price-labels/roboto');
 if(fs.existsSync(path.join(fonts,'Regular.ttf'))&&fs.existsSync(path.join(fonts,'Bold.ttf'))){doc.registerFont('Regular',path.join(fonts,'Regular.ttf'));doc.registerFont('Bold',path.join(fonts,'Bold.ttf'));}else{doc.registerFont('Regular','Helvetica');doc.registerFont('Bold','Helvetica-Bold');}
 const size=spec.orientation==='landscape'?{width:841.89,height:595.28}:{width:595.28,height:841.89};
 const left=32,width=size.width-64,bottom=size.height-58,font=8.5;
 const colors={ink:'#182a32',green:'#245747',muted:'#687976',line:'#dae3de',header:'#eaf1ed',stripe:'#f7f9f7'};
 const weights=spec.columns.map(c=>c.id==='description'?Math.max(c.width,260):c.width),sum=weights.reduce((a,b)=>a+b,0),columns=spec.columns.map((c,i)=>({...c,label:c.id==='articleNumber'?'Artikel-Nr.':c.label,width:width*weights[i]/sum}));
 doc.font('Bold').fontSize(font);
 const headerHeight=Math.max(28,...columns.map(c=>doc.heightOfString(c.label,{width:c.width-12})+14));
 let y=0,index=0;
 function tableHeader(){let x=left;doc.rect(left,y,width,headerHeight).fill(colors.header);for(const column of columns){doc.font('Bold').fontSize(font).fillColor(colors.green).text(column.label,x+6,y+7,{width:column.width-12,height:headerHeight-12});x+=column.width;}y+=headerHeight;}
 function page(){doc.addPage();doc.fillColor(colors.green).font('Bold').fontSize(18).text(plain(spec.title,160),left,28,{width,height:46,ellipsis:true});
  const source=report.sourceAt?new Intl.DateTimeFormat('de-AT',{timeZone:'Europe/Vienna',dateStyle:'medium',timeStyle:'short'}).format(new Date(report.sourceAt)):'Nicht hinterlegt';
  doc.fillColor(colors.muted).font('Regular').fontSize(8).text(`Bestandsstand ${source} · ${report.total} Artikel-Filial-Zeilen`,left,79,{width,height:14});
  const assortment=Model.SORTIMENTS.find(a=>a.id===spec.filters.assortment)?.label||spec.filters.assortment.slice(7),branch=spec.filters.locations.length?`${spec.filters.locations.length} gewählte Filiale(n)`:'Alle freigegebenen Filialen';
  doc.fontSize(8).text(`${assortment} · ${branch} · ${spec.filters.stock==='positive'?'Positiver Bestand':'Alle Bestandswerte'}${spec.filters.query?' · Suche: '+plain(spec.filters.query,150):''}`,left,95,{width,height:25,ellipsis:true});y=126;tableHeader();}
 page();
 for(const row of report.rows){doc.font('Regular').fontSize(font);const cells=columns.map(c=>cell(row,c)),height=Math.max(24,...cells.map((value,i)=>doc.heightOfString(value,{width:columns[i].width-12})+14));
  if(height>bottom-y)page();if(height>bottom-y)Model.fail('Eine Artikelzeile ist für das gewählte PDF-Format zu lang.',413,'ARTICLE_REPORT_PDF_ROW');
  if(index%2===1)doc.rect(left,y,width,height).fill(colors.stripe);let x=left;
  for(let i=0;i<columns.length;i++){const column=columns[i];doc.font('Regular').fontSize(font).fillColor(colors.ink).text(cells[i],x+6,y+7,{width:column.width-12,height:height-12,align:column.type==='text'?'left':'right'});x+=column.width;}
  doc.moveTo(left,y+height).lineTo(left+width,y+height).lineWidth(.35).strokeColor(colors.line).stroke();y+=height;index++;
 }
 const range=doc.bufferedPageRange();for(let p=range.start;p<range.start+range.count;p++){doc.switchToPage(p);
  doc.moveTo(left,size.height-48).lineTo(left+width,size.height-48).lineWidth(.5).strokeColor(colors.line).stroke();
  doc.font('Regular').fontSize(6.7).fillColor(colors.muted).text('Importierter Bestand, kein Livebestand. RE % aus aktuellem EH-VK netto und Ø EK netto; fehlende Werte: -.',left,size.height-42,{width:width-70,height:13});
  doc.text('Grabenplaner · Artikel-Auswertung',left,size.height-29,{width:width-70,height:12});doc.font('Bold').text(`${p-range.start+1} / ${range.count}`,size.width-94,size.height-30,{width:62,height:12,align:'right'});
 }
 pages=range.count;doc.end();
 });
}
module.exports={normalize,filename,plain,cell,render};
