"use strict";
const crypto=require("node:crypto");
const A=require("./personnel-learning-assessment");
const MAX_BYTES=2*1024*1024;
const bytesHash=buffer=>crypto.createHash("sha256").update(buffer).digest("hex");
function context(row,employeeNumber){return {namespace:"personnel-learning",recordId:row.id,field:"assessment",employeeNumber};}
function register(app, deps) {
  const base="/api/portal/v1/personnel-learning/assignments/:assignmentId";
  async function load(request,repositories,write=false) {
    const session=deps.session(request,write),id=String(request.params.assignmentId||"");
    if(!id||id.length>180||id.includes("\0"))A.fail("Ungültige Schulungszuweisung.");
    const actor=await deps.actor(session,repositories?.organizationPersonnel);
    const bundle=await deps.bundle(actor,id,repositories?{learningRepository:repositories.personnelLearning,organizationRepository:repositories.organizationPersonnel}:{});
    if(bundle.access.branchAccount)A.fail("Prüfungen und persönliche Nachweise benötigen eine persönliche Anmeldung.",403);
    const repository=repositories?.personnelLearning || deps.repository;
    const records=await repository.listAssessmentRecords(id),state=A.state(records,bundle.processVersion.receiptSha256);
    return {bundle,repository,records,state,assessment:bundle.processVersion.content?.assessment||null};
  }
  function mutable(value,request) {
    if(!value.bundle.access.canRecord||value.bundle.progressState.finalized)A.fail("Diese abgeschlossene oder nicht freigegebene Schulung kann nicht geändert werden.",403);
    if(String(request.body?.expectedReceipt??"")!==value.state.lastReceipt)A.fail("Prüfung oder Nachweis wurden inzwischen geändert. Bitte neu laden.",409);
  }
  async function append(value,repositories,kind,payload,secret={}) {
    const row={id:crypto.randomUUID(),assignmentId:value.bundle.assignment.id,sequenceNumber:value.state.lastSequence+1,kind,
      previousReceipt:value.state.lastReceipt,changedBy:value.bundle.actor.actorId,changedAt:new Date().toISOString()};
    row.protectedPayload=deps.storage().protectRecord(JSON.stringify(secret),context(row,value.bundle.learner.personnel_number));
    row.payload={...payload,processReceipt:value.bundle.processVersion.receiptSha256,cipherSha256:A.hash(row.protectedPayload)};
    row.receiptSha256=A.receipt(row);
    await value.repository.insertAssessmentRecord(row);
    await repositories.organizationPersonnel.insertAudit(row.changedBy,"personnel.learning."+kind,"personnel_learning_assignment",row.assignmentId,JSON.stringify({id:row.id,receipt:row.receiptSha256}));
    return row;
  }
  app.get(base+"/assessment",async(request,response)=>{
    const value=await load(request),{bundle,state,assessment}=value;
    response.set("Cache-Control","no-store").json({assignmentId:bundle.assignment.id,title:bundle.processVersion.title,learner:bundle.learner.full_name,
      assessment:A.publicAssessment(assessment),expectedReceipt:state.lastReceipt,
      attempts:state.attempts.map(r=>({id:r.id,...r.payload,cipherSha256:undefined,processReceipt:undefined,at:r.changedAt})),
      evidence:state.evidence.map(r=>({id:r.id,fileName:r.payload.fileName,mime:r.payload.mime,byteSize:r.payload.byteSize,at:r.changedAt})),
      passed:state.passed,canAttempt:bundle.access.learnerSelf&&bundle.access.canRecord&&!bundle.progressState.finalized&&!!assessment?.questions.length&&!state.passed&&state.attempts.length<assessment.maxAttempts,
      canUpload:bundle.access.canRecord&&!bundle.progressState.finalized&&state.evidence.length<10,
      canReset:(bundle.access.trainer||bundle.access.leadership)&&!bundle.progressState.finalized,
      canConfirm:bundle.progressState.finalized&&bundle.progressState.result==="passed"});
  });
  app.post(base+"/assessment/attempt",async(request,response)=>{
    const result=await deps.transaction(async repositories=>{
      const value=await load(request,repositories,true);mutable(value,request);
      if(!value.bundle.access.learnerSelf)A.fail("Nur die zugewiesene lernende Person kann den Wissenstest abgeben.",403);
      if(!value.assessment?.questions.length)A.fail("Für diese Fassung ist kein Wissenstest hinterlegt.");
      if(value.state.passed||value.state.attempts.length>=value.assessment.maxAttempts)A.fail("Kein weiterer Versuch freigegeben. Bitte die Trainerperson kontaktieren.",409);
      const grade=A.grade(value.assessment,request.body.answers);
      await append(value,repositories,"exam_attempt",grade,{answers:request.body.answers});return grade;
    });response.status(201).json(result);
  });
  app.post(base+"/assessment/reset",async(request,response)=>{
    await deps.transaction(async repositories=>{
      const value=await load(request,repositories,true);mutable(value,request);
      if(!value.bundle.access.trainer&&!value.bundle.access.leadership)A.fail("Nur Trainer oder zuständige Leitung dürfen weitere Versuche freigeben.",403);
      const reason=String(request.body.reason||"").trim();if(reason.length<3||reason.length>600)A.fail("Bitte die erneute Freigabe begründen (3–600 Zeichen).");
      await append(value,repositories,"exam_reset",{reason},{reason});
    });response.status(201).json({saved:true});
  });
  app.post(base+"/evidence",async(request,response)=>{
    // Reject unauthorised uploads before decoding and scanning, then check again in the transaction.
    const initial=await load(request,undefined,true);mutable(initial,request);
    const encoded=request.body?.data,fileName=String(request.body?.fileName||"").split(/[\\/]/).at(-1).replace(/[\r\n\0"]/g,"").slice(0,120);
    if(typeof encoded!=="string"||encoded.length>Math.ceil(MAX_BYTES/3)*4||!fileName)A.fail("PDF, PNG oder JPEG bis 2 MiB auswählen.");
    const buffer=Buffer.from(encoded,"base64");if(!buffer.length||buffer.length>MAX_BYTES||buffer.toString("base64")!==encoded)A.fail("Ungültige oder zu große Datei.");
    const scan=await deps.storage().scanBuffer({buffer,originalName:fileName,maxBytes:MAX_BYTES});
    if(!scan.clean||scan.available===false||!["application/pdf","image/png","image/jpeg"].includes(scan.detectedMime))A.fail("Der Nachweis konnte nicht vollständig als PDF, PNG oder JPEG geprüft werden.",422);
    const id=await deps.transaction(async repositories=>{
      const value=await load(request,repositories,true);mutable(value,request);
      if(value.state.evidence.length>=10)A.fail("Höchstens zehn aktuelle Nachweise je Durchgang.");
      return (await append(value,repositories,"evidence",{fileName,mime:scan.detectedMime,byteSize:buffer.length,sha256:bytesHash(buffer)}, {data:encoded})).id;
    });response.status(201).json({id});
  });
  app.post(base+"/evidence/:evidenceId/withdraw",async(request,response)=>{
    await deps.transaction(async repositories=>{
      const value=await load(request,repositories,true);mutable(value,request);
      if(!value.state.evidence.some(r=>r.id===request.params.evidenceId))A.fail("Nachweis nicht gefunden.",404);
      const reason=String(request.body.reason||"").trim();if(reason.length<3||reason.length>600)A.fail("Bitte die Rücknahme begründen.");
      await append(value,repositories,"evidence_withdrawn",{evidenceId:request.params.evidenceId,reason});
    });response.json({saved:true});
  });
  app.get(base+"/evidence/:evidenceId",async(request,response)=>{
    const value=await load(request),metadata=value.state.evidence.find(r=>r.id===request.params.evidenceId);
    if(!metadata)A.fail("Nachweis nicht gefunden oder zurückgenommen.",404);
    const row=await value.repository.getAssessmentRecord(metadata.id);
    if(!row||row.assignmentId!==value.bundle.assignment.id||A.hash(row.protectedPayload)!==metadata.payload.cipherSha256)A.fail("Nachweis ist nicht vollständig überprüfbar.",503);
    const secret=JSON.parse(deps.storage().unprotectRecord(row.protectedPayload,context(row,value.bundle.learner.personnel_number)));
    const buffer=Buffer.from(secret.data,"base64");if(buffer.length!==row.payload.byteSize||bytesHash(buffer)!==row.payload.sha256)A.fail("Dateiintegrität konnte nicht bestätigt werden.",503);
    await deps.audit(value.bundle.actor.actorId,"personnel.learning.evidence.read","personnel_learning_assignment",row.assignmentId,row.id);
    response.set({"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Content-Type":row.payload.mime,"Content-Disposition":`attachment; filename*=UTF-8''${encodeURIComponent(row.payload.fileName)}`}).send(buffer);
  });
  app.get(base+"/confirmation.pdf",async(request,response)=>{
    const value=await load(request),b=value.bundle;
    if(!b.assignmentState.active||!b.progressState.finalized||b.progressState.result!=="passed")A.fail("Eine Bestätigung steht nur für einen aktuell erfolgreich abgeschlossenen Durchgang bereit.",409);
    A.assertCompletion(value.assessment,"passed",value.records,b.processVersion.receiptSha256);
    const buffer=await require("./personnel-learning-confirmation").createConfirmation({
      learner:b.learner.full_name,employeeNumber:b.learner.personnel_number,title:b.processVersion.title,objective:b.processVersion.content.objective,
      version:b.processVersion.versionNumber,run:b.context.schedules.get(b.assignment.id)?.runNumber||1,
      completedAt:b.progressState.current.changedAt,assessedBy:b.context.employeeByNumber.get(b.progressState.current.changedBy)?.full_name||b.progressState.current.changedBy,
      receipt:b.progressState.currentReceipt,assignmentId:b.assignment.id,steps:b.processVersion.content.steps.map(s=>s.title),
      exam:value.state.attempts.at(-1)?.payload,evidenceCount:value.state.evidence.length,generatedAt:new Date().toISOString()});
    await deps.audit(b.actor.actorId,"personnel.learning.confirmation.read","personnel_learning_assignment",b.assignment.id,b.progressState.currentReceipt);
    response.set({"Cache-Control":"no-store","Content-Type":"application/pdf","Content-Disposition":'attachment; filename="Schulungsbestaetigung.pdf"'}).send(buffer);
  });
}
module.exports={register,MAX_BYTES};
