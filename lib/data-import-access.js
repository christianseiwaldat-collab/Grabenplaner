"use strict";
const DATA_IMPORT_PERMISSIONS = Object.freeze({ READ:'data:imports:read', PREPARE:'data:imports:prepare', APPLY:'data:imports:apply', UNDO:'data:imports:undo' });
function buildDataImportProjection(session = {}) {
  const p=new Set(session?.permissions || []), personal=!!session?.employeeNumber && !session.mustChangePassword && session.isEmployee!==false && session.sessionKind!=='organization';
  // A whole-source import contains several protected data classes and cannot be
  // authorized by a location-only sales or article permission.
  const company=p.has('sales:analytics:company:read');
  const read=personal && company && p.has('sales:analytics:access') && p.has(DATA_IMPORT_PERMISSIONS.READ);
  return Object.freeze({read,prepare:read&&p.has(DATA_IMPORT_PERMISSIONS.PREPARE),apply:read&&p.has(DATA_IMPORT_PERMISSIONS.APPLY),undo:read&&p.has(DATA_IMPORT_PERMISSIONS.UNDO)});
}
const DATA_IMPORT_PERMISSION_CATALOG=Object.freeze([
  ['READ','Gesamtimport-Protokolle lesen','Eigene geschützte Importläufe, Zähler und Prüfhinweise lesen.'],
  ['PREPARE','Gesamtimport vorbereiten','Geschäftsdaten aus TradeFoto-Dateien geschützt zur Prüfung bereitstellen; keine Übernahmefreigabe.'],
  ['APPLY','Gesamtimport übernehmen','Vollständig geprüfte Quellen nach gesonderter technischer Freigabe übernehmen.'],
  ['UNDO','Gesamtimport zurücknehmen','Eigene Importänderungen nach erneuter Abhängigkeitsprüfung zurücknehmen.'],
].map(([key,label,description])=>Object.freeze({id:DATA_IMPORT_PERMISSIONS[key],label,description,group:'Import & Lohnverrechnung',warningLevel:'critical',eligibleRoles:Object.freeze(['admin','developer']),scopeBehavior:'global'})));
function dataImportPermissionDependencies(permissions) {
  const p=new Set(permissions), missing=new Set();
  if (Object.values(DATA_IMPORT_PERMISSIONS).some(id=>p.has(id))) {
    for(const id of [DATA_IMPORT_PERMISSIONS.READ,'sales:analytics:access','sales:analytics:company:read']) if(!p.has(id)) missing.add(id);
    if(p.has(DATA_IMPORT_PERMISSIONS.APPLY) && !p.has(DATA_IMPORT_PERMISSIONS.PREPARE)) missing.add(DATA_IMPORT_PERMISSIONS.PREPARE);
  }
  return {valid:!missing.size,missing:[...missing]};
}
module.exports={DATA_IMPORT_PERMISSIONS,DATA_IMPORT_PERMISSION_CATALOG,buildDataImportProjection,dataImportPermissionDependencies};
