"use strict";
const PDFDocument=require("pdfkit");
function createConfirmation(value) {
 return new Promise((resolve,reject)=>{
  const doc=new PDFDocument({size:"A4",margin:48,bufferPages:true,info:{Title:"Schulungsbestätigung",Author:"Grabenplaner"}}),chunks=[];
  doc.on("data",chunk=>chunks.push(chunk));doc.on("end",()=>resolve(Buffer.concat(chunks)));doc.on("error",reject);
  const date=v=>new Intl.DateTimeFormat("de-AT",{timeZone:"Europe/Vienna",dateStyle:"medium"}).format(new Date(v));
  function line(text,{size=11,bold=false,color="#243a34"}={}){
    doc.font(bold?"Helvetica-Bold":"Helvetica").fontSize(size).fillColor(color);
    const height=doc.heightOfString(String(text),{width:499});if(doc.y+height>730)doc.addPage();
    doc.text(String(text),48,doc.y,{width:499,lineGap:3}).moveDown(.45);
  }
  line("GRABENPLANER · SCHULUNG & WISSEN",{size:10,bold:true,color:"#47756b"});
  line("Schulungsbestätigung",{size:25,bold:true});
  line(value.title,{size:17,bold:true});
  line(`${value.learner} · Personalnummer ${value.employeeNumber}`,{size:13,bold:true});
  line(`Erfolgreich abgeschlossen am ${date(value.completedAt)}`);
  line(`Durchgang ${value.run} · Prozessfassung ${value.version} · Bewertet durch ${value.assessedBy}`);
  if(value.objective){line("Lernziel",{bold:true});line(value.objective);}
  line("Abgeschlossene Lernschritte",{bold:true});value.steps.forEach((step,index)=>line(`${index+1}. ${step}`));
  if(value.exam)line(`Wissenstest: ${value.exam.points} von ${value.exam.total} Punkten (${value.exam.percent} %)`);
  line(`Hinterlegte Dateinachweise: ${value.evidenceCount}`);
  line("Diese Bestätigung dokumentiert den freigegebenen Abschlussstand im Grabenplaner zum Ausstellungszeitpunkt. Sie erteilt keine zusätzliche Kompetenzstufe oder Trainerberechtigung. Spätere Korrekturen sind im GP nachvollziehbar.",{size:9});
  line(`Erstellt: ${date(value.generatedAt)} · Zuordnung: ${value.assignmentId}`,{size:8});
  line(`Abschlussbeleg: ${value.receipt}`,{size:8});
  const pages=doc.bufferedPageRange();for(let i=0;i<pages.count;i++){doc.switchToPage(i);doc.font("Helvetica").fontSize(8).fillColor("#63736d").text(`Grabenplaner | Seite ${i+1} von ${pages.count}`,48,780,{width:499,align:"right",lineBreak:false});}
  doc.end();
 });
}
module.exports={createConfirmation};
