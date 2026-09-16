"use strict";
const express=require('express');
const C=require('./data-import-contract');
const {buildDataImportProjection,DATA_IMPORT_PERMISSIONS:P}=require('./data-import-access');
const {MAX_BYTES}=require('./tradefoto-full-import-source');
const {decodeImportFileName}=require('./data-import-file-name');
function registerDataImportRoutes(app,{runtime,jobs=null,mappings=null,cashPublications=null,requireSession,refreshSession,assertCsrf,
  lifecycle=require('./data-import-lifecycle').createDataImportLifecycle(),onBackgroundError=code=>console.warn('Datenbankimport unterbrochen:',code)}) {
  let uploading=false;
  const headers=response=>response.set({'Cache-Control':'private, no-store',Pragma:'no-cache','X-Content-Type-Options':'nosniff'});
  function failure(response,error) {
    if(response.headersSent) return;
    const status=Number.isInteger(error?.status)&&error.status>=400&&error.status<=599?error.status:500;
    const code=/^(IMPORT_|PORTAL_)[A-Z0-9_]{1,80}$/.test(error?.code||'')?error.code:'IMPORT_OPERATION_FAILED';
    const messages={IMPORT_NOT_ACTIVATED:'Die produktive Übernahme ist noch nicht freigegeben.',
      IMPORT_MAINTENANCE:'Eine Serverwartung wird vorbereitet. Bitte den Import danach fortsetzen; gespeicherter Fortschritt bleibt erhalten.',
      IMPORT_JOB_QUEUE_FULL:'Die Importwarteschlange ist voll. Bitte einen laufenden Auftrag abwarten.',
      IMPORT_JOB_SPACE_REQUIRED:'Für die geschützte Upload-Zwischenspeicherung ist nicht genug freier Speicher vorhanden.',
      IMPORT_JOB_EXPIRED:'Die befristete Upload-Datei wurde entfernt. Bitte denselben Dateistand erneut auswählen.',
      IMPORT_JOB_FILE_DELETED:'Die Access-Datei wurde gelöscht. Zum Fortsetzen dieselbe Datei erneut hochladen; die GP-Daten sind erhalten.',
      IMPORT_VAULT_UNAVAILABLE:'Die geschützte Schlüsselverwaltung ist nicht verfügbar. Bestehende Schlüssel werden nicht ersetzt.',
      IMPORT_SOURCE_BUSY:'Ein Import arbeitet bereits. Bitte den Fortschritt abwarten.',
      IMPORT_SOURCE_INCOMPLETE:'Bitte dieselbe Quelldatei erneut auswählen, um die Bereitstellung fortzusetzen.',
      IMPORT_SOURCE_TABLE_MISSING:'Die Datei enthält nicht alle Tabellen der ausgewählten Datenquelle. Bitte Dateiauswahl und Export prüfen.',
      IMPORT_SOURCE_SCHEMA_CHANGED:'Die Tabellenstruktur hat sich geändert. Der Import bleibt zur Prüfung gesperrt.',
      IMPORT_SOURCE_TABLE_UNCLASSIFIED:'Die Datei enthält bisher nicht eingeordnete Tabellen. Vor einer Übernahme muss die Datenquelle geprüft werden.',
      IMPORT_SOURCE_FORMAT_INVALID:'Bitte eine unterstützte, unkomprimierte Access-Datenbankdatei auswählen.',
      IMPORT_SOURCE_FILENAME_INVALID:'Bitte eine ACCDB-Datei mit einem gültigen Dateinamen auswählen.',
      IMPORT_SOURCE_ROWS_LIMIT:'Die Datei überschreitet die Grenze von zwei Millionen Quellzeilen.',
      IMPORT_CUSTOMER_TYPE_REVIEW_REQUIRED:'Bitte Privat oder Gewerblich bewusst auswählen.',
      IMPORT_CUSTOMER_MATCH_CONFIRMATION_REQUIRED:'Für diese Kundennummer besteht bereits eine CRM-Karte. Bitte die Verbindung ausdrücklich bestätigen.',
      IMPORT_MANUAL_FIELD_CONFLICT:'Ein Quellfeld und die CRM-Karte wurden unabhängig geändert. Die manuelle Änderung bleibt erhalten; bitte den Konflikt gezielt prüfen.',
      IMPORT_CUSTOMER_UNASSIGNED_ZERO:'Kundennummer 0 bleibt nicht zugeordnet; daraus wird keine Kundenkarte angelegt.',
      IMPORT_EMPLOYEE_UNASSIGNED_ZERO:'Verkäufernummer 0 bleibt nicht zugeordnet.',
      IMPORT_ARTICLE_SOURCE_LINK_REQUIRED:'Zuerst muss die geprüfte Quellbindung im zentralen Artikelstamm bestehen.',
      IMPORT_ARTICLE_CATALOG_FORBIDDEN:'Für die vollständige Trade-Aktualisierung ist zusätzlich das Recht zum Artikelimport erforderlich.',
      IMPORT_ARTICLE_CATALOG_DATE:'Der Artikelstamm enthält keinen verlässlichen Änderungszeitpunkt. Der GP-Artikelkatalog wurde nicht überschrieben.',
      IMPORT_ARTICLE_CATALOG_RELATION:'Die Zweit-EAN-Tabelle enthält Artikelbezüge, die im Artikelstamm fehlen. Bitte den Trade-Export prüfen.',
      IMPORT_ARTICLE_CATALOG_LIMIT:'Der Artikelstamm überschreitet das unterstützte Arbeitsbudget. Die eingelesenen Daten bleiben erhalten.',
      IMPORT_MAPPING_INACTIVE_TARGET:'Für ein inaktives GP-Ziel muss die historische Zuordnung ausdrücklich ausgewählt werden.',
      IMPORT_PREVIEW_CHANGED:'Der Quell- oder Zielstand wurde verändert. Bitte die Zuordnung erneut prüfen.',
      IMPORT_UNDO_DEPENDENCIES:'Abhängige Vorgänge verhindern die Rücknahme. Die bestehende Zuordnung bleibt erhalten.',
      IMPORT_UNDO_MANUAL_CHANGE:'Die CRM-Karte wurde inzwischen manuell geändert. Sie wird nicht überschrieben.',
      IMPORT_CRM_NAME_REQUIRED:'Bitte fehlende Kundennamen beziehungsweise den Firmennamen ausdrücklich ergänzen.',
      IMPORT_CRM_EMAIL_INVALID:'Bitte die E-Mail-Adresse für die CRM-Karte prüfen. Der Originalwert bleibt im Quellarchiv erhalten.',
      IMPORT_CRM_VAT_ID_INVALID:'Bitte die UID für die CRM-Karte prüfen. Der Originalwert bleibt im Quellarchiv erhalten.',
      IMPORT_DECISION_GATE:'Offene Quellenprüfungen verhindern die Übernahme.',
      IMPORT_REVISION_CONFLICT:'Der Import wurde inzwischen fortgesetzt. Bitte den Stand aktualisieren.'};
    messages.IMPORT_RETRY_LATER='Die Datenbank ist vorübergehend ausgelastet. Der gespeicherte Stand bleibt erhalten; der Hintergrundauftrag versucht es automatisch erneut.';
    Object.assign(messages, {
      IMPORT_MAPPING_LOCATION_REQUIRED:'Bitte mindestens eine Kassenfiliale ausdrücklich einem GP-Standort zuordnen.',
      IMPORT_MAPPING_SOURCE_UNAVAILABLE:'Diese Quellnummer ist in dem geprüften Kassenstand nicht vorhanden.',
      IMPORT_MAPPING_DUPLICATE:'Bitte jede Quellnummer nur einmal zuordnen.',
      IMPORT_MAPPING_TARGET_MISSING:'Das ausgewählte GP-Ziel fehlt oder die bestätigte Artikelbindung passt nicht.',
      IMPORT_SALES_POLICY_UNTRUSTED:'Für diesen Dateistand sind noch keine bestätigten Kassenregeln hinterlegt.',
      IMPORT_UNDO_UNAVAILABLE:'Es ist noch kein vorheriger Kassenstand für die Rückkehr vorhanden.'
    });
    headers(response);response.status(status).json({code,error:messages[code]||(status===401||status===403?'Eine persönliche Anmeldung mit dem erforderlichen Gesamtimportrecht ist notwendig.':'Der Import konnte nicht sicher ausgeführt werden. Der bisherige Prüfstand bleibt erhalten.')});
  }
  function sessionGetter(request,permission=P.READ) {
    const original=requireSession(request,permission);
    if(!buildDataImportProjection(original).read) C.fail('IMPORT_FORBIDDEN',403);
    const owner=String(original.employeeNumber), account=original.accountId;
    return async()=> {
      const current=await refreshSession(request);
      if(!current || String(current.employeeNumber)!==owner || current.accountId!==account) C.fail('IMPORT_FORBIDDEN',403);
      return current;
    };
  }
  const route=work=>async(request,response)=> {
    headers(response);
    try {
      const getSession=sessionGetter(request);
      if(request.method!=='GET') assertCsrf(request);
      response.json(await (request.method!=='GET'?lifecycle.run(()=>work(request,getSession)):work(request,getSession)));
    }catch(error){failure(response,error);}
  };
  app.get('/api/data-import/context',route(async(_r,get)=>{
    const context=await runtime.context(get);
    return {...context,backgroundEnabled:!!jobs,
      ...(jobs&&context.available?{message:'Datei hochladen. Einlesen und Prüfung laufen anschließend automatisch am Server; danach bewusst übernehmen.'}:{})};
  }));
  if(cashPublications) for(const action of ['context','references','preview','activate','rollback-preview','rollback'])
    app.post(`/api/data-import/cash/${action}`,route((r,get)=>cashPublications.operation(get,action,r.body||{})));
  if(mappings) {
    app.get('/api/data-import/mappings/context',route((_r,get)=>mappings.operation(get,'context')));
    for(const action of ['search','targets','preview','apply','undo']) app.post(`/api/data-import/mappings/${action}`,route((r,get)=>mappings.operation(get,action,r.body||{})));
  }
  app.post('/api/data-import/sources/search',route(async(r,get)=>{
    const result=await runtime.list(get,r.body||{});
    if(jobs?.enqueueContentDate&&buildDataImportProjection(await get()).prepare) {
      for(const candidate of result.items.filter(s=>s.complete&&!s.active&&s.contentDate?.status!=='complete')) {
        try{if(await jobs.enqueueContentDate(get,candidate.id))break;}catch(error){if(error.code!=='IMPORT_JOB_QUEUE_FULL')throw error;break;}
      }
    }
    return jobs?{...result,items:await Promise.all(result.items.map(s=>jobs.overlay(s)))}:result;
  }));
  app.get('/api/data-import/sources/:id',route(async(r,get)=>{const source=await runtime.sourceOperation(get,r.params.id,'read');return jobs?jobs.overlay(source):source;}));
  if(jobs)for(const action of ['pause','retry'])app.post(`/api/data-import/sources/:id/${action}`,route((r,get)=>jobs.action(get,r.params.id,action)));
  if(jobs)app.post('/api/data-import/sources/:id/apply-background',route((r,get)=>jobs.enqueueApply(get,r.params.id,r.body||{})));
  if(jobs)app.post('/api/data-import/sources/:id/delete-upload',route((r,get)=>jobs.deleteUpload(get,r.params.id,r.body||{})));
  for(const action of ['review','apply','undo','events','rows','undo-preview']) {
    app.post(`/api/data-import/sources/:id/${action}`,route(async(r,get)=>{
      if(jobs&&['review','apply','undo'].includes(action))await jobs.assertIdle(r.params.id);
      return runtime.sourceOperation(get,r.params.id,action,r.body||{});
    }));
  }
  app.post('/api/data-import/upload/:kind',async(request,response)=> {
    headers(response);
    let admitted=false,password='',releaseUpload;
    try {
      const encoded=String(request.headers['x-import-password']||'');delete request.headers['x-import-password'];
      for(let i=0;i<(request.rawHeaders||[]).length-1;i+=2) if(request.rawHeaders[i].toLowerCase()==='x-import-password') request.rawHeaders[i+1]='';
      const getSession=sessionGetter(request,P.PREPARE);assertCsrf(request);
      if(!buildDataImportProjection(await getSession()).prepare) C.fail('IMPORT_FORBIDDEN',403);
      if(!['trade','cash','bestell'].includes(request.params.kind)) C.fail('IMPORT_SOURCE_KIND_INVALID');
      const fileName=decodeImportFileName(request.headers['x-import-file-name']);
      if(!(await runtime.context(getSession)).available) C.fail('IMPORT_VAULT_UNAVAILABLE',503);
      lifecycle.assertAvailable();
      if(uploading) C.fail('IMPORT_SOURCE_BUSY',409);
      if(request.headers['content-type']?.split(';')[0].trim()!=='application/octet-stream' || request.headers['content-encoding']) C.fail('IMPORT_SOURCE_FORMAT_INVALID');
      const length=Number(request.headers['content-length']);
      if(!Number.isSafeInteger(length)||length<4096||length>MAX_BYTES) C.fail('IMPORT_SOURCE_SIZE_INVALID',413);
      // Password is transient. Strip it from both header representations before
      // parsing errors or application request logging can retain it.
      const secretBytes=Buffer.from(encoded,'base64');
      try {if(secretBytes.toString('base64')!==encoded) C.fail('IMPORT_SOURCE_PASSWORD_INVALID');password=secretBytes.toString('utf8');}
      finally {secretBytes.fill(0);}
      if(Buffer.byteLength(password)>256) C.fail('IMPORT_SOURCE_PASSWORD_INVALID');
      releaseUpload=jobs?.beginUpload();
      uploading=true;admitted=true;
      await lifecycle.run(async signal=>{
      await new Promise((resolve,reject)=>{
        const abort=()=>{reject(new C.DataImportError('IMPORT_MAINTENANCE',503));request.destroy();};
        signal.addEventListener('abort',abort,{once:true});
        if(signal.aborted){abort();return;}
        express.raw({type:()=>true,limit:MAX_BYTES,inflate:false})(request,response,error=>{
          signal.removeEventListener('abort',abort);
          error?reject(new C.DataImportError('IMPORT_SOURCE_SIZE_INVALID',413)):resolve();
        });
      });
      // A 202 permits progress queries without a long-lived proxy response.
      // The promise remains observed; runtime persists sanitized read failures.
      if(jobs){
        const source=await jobs.enqueue(getSession,{buffer:request.body,kind:request.params.kind,fileName,password,signal});
        response.status(202).json({id:source.id,status:source.status,background:source.background});
      }else await runtime.upload(getSession,{buffer:request.body,kind:request.params.kind,fileName,password,
        onStarted:source=>response.status(202).json({id:source.id,status:source.status})});
      });
    }catch(error){
      if(response.headersSent)try{onBackgroundError(/^IMPORT_[A-Z0-9_]{1,80}$/.test(error?.code||'')?error.code:'IMPORT_OPERATION_FAILED');}catch{/* Logging must not prevent cleanup. */}
      failure(response,error);
    }
    finally{password='';if(Buffer.isBuffer(request.body)&&request.body.length)request.body.fill(0);releaseUpload?.();if(admitted)uploading=false;}
  });
  return Object.freeze({stop:async()=>{await Promise.all([lifecycle.stop(),runtime.stop?.()]);}});
}
module.exports={registerDataImportRoutes};
