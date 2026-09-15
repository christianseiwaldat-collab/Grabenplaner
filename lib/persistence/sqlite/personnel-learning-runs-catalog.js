"use strict";
const {S,reads,writes}=require("../statements/personnel-learning-runs");
const {PERSONNEL_LEARNING_STATEMENTS:legacy}=require("../statements/personnel-learning");
const {SQLITE_PERSONNEL_LEARNING_CATALOG:old}=require("./personnel-learning-catalog");
const {RENAMES,rename}=require("./operations/personnel-learning-runs-schema");
const CATALOG=[];
for(const name of reads) {
  const source=old.find(e=>e.statement.id===legacy[name].id);
  let sql=source.sql;
  for(const [from,to] of Object.entries(RENAMES)) sql=sql.replace(new RegExp(`FROM ${from}\\b`),`FROM (SELECT * FROM ${from} UNION ALL SELECT * FROM ${to}) AS learning_combined`);
  CATALOG.push({statement:S[name],sql});
}
for(const name of writes) CATALOG.push({statement:S[name],sql:rename(old.find(e=>e.statement.id===legacy[name].id).sql)});
const select=`SELECT assignment_id AS assignmentId,revision_number AS revisionNumber,payload_json AS payload,previous_receipt_sha256 AS previousReceiptSha256,receipt_sha256 AS receiptSha256,changed_by AS changedBy,changed_at AS changedAt FROM personnel_learning_schedule_revisions`;
CATALOG.push({statement:S.listSchedules,sql:`${select} s WHERE revision_number=(SELECT MAX(revision_number) FROM personnel_learning_schedule_revisions p WHERE p.assignment_id=s.assignment_id)`},
 {statement:S.getSchedule,sql:`${select} WHERE assignment_id=$assignmentId ORDER BY revision_number DESC LIMIT 1`},
 {statement:S.insertSchedule,sql:`INSERT INTO personnel_learning_schedule_revisions(assignment_id,revision_number,payload_json,previous_receipt_sha256,receipt_sha256,changed_by,changed_at) VALUES($assignmentId,$revisionNumber,$payload,$previousReceiptSha256,$receiptSha256,$changedBy,$changedAt)`});
const recordSelect=`SELECT id,assignment_id AS assignmentId,sequence_number AS sequenceNumber,kind,payload_json AS payload,previous_receipt AS previousReceipt,receipt_sha256 AS receiptSha256,changed_by AS changedBy,changed_at AS changedAt`;
CATALOG.push({statement:S.listAssessmentRecords,sql:`${recordSelect} FROM personnel_learning_assessment_records WHERE assignment_id=$assignmentId ORDER BY sequence_number`},
 {statement:S.getAssessmentRecord,sql:`${recordSelect},protected_payload AS protectedPayload FROM personnel_learning_assessment_records WHERE id=$id`},
 {statement:S.insertAssessmentRecord,sql:`INSERT INTO personnel_learning_assessment_records(id,assignment_id,sequence_number,kind,payload_json,protected_payload,previous_receipt,receipt_sha256,changed_by,changed_at) VALUES($id,$assignmentId,$sequenceNumber,$kind,$payload,$protectedPayload,$previousReceipt,$receiptSha256,$changedBy,$changedAt)`});
for(const [name,oldName] of [["listAllVersions","listVersions"],["listAllEvents","listEvents"]]){
 const source=old.find(e=>e.statement.id===legacy[oldName].id).sql;CATALOG.push({statement:S[name],sql:source.replace(/WHERE module_id = \$moduleId/i,"")});
}
CATALOG.push({statement:S.listRequirements,sql:`SELECT id,revision,payload_json AS payload,previous_receipt AS previousReceipt,receipt_sha256 AS receiptSha256,changed_by AS changedBy,changed_at AS changedAt FROM personnel_learning_requirement_revisions ORDER BY id,revision`},
 {statement:S.insertRequirement,sql:`INSERT INTO personnel_learning_requirement_revisions(id,revision,payload_json,previous_receipt,receipt_sha256,changed_by,changed_at) VALUES($id,$revision,$payload,$previousReceipt,$receiptSha256,$changedBy,$changedAt)`});
const personFrom=`FROM employees e LEFT JOIN locations l ON l.id=e.home_location_id LEFT JOIN positions p ON p.id=e.position_id LEFT JOIN portal_users u ON u.employee_number=e.personnel_number LEFT JOIN portal_roles r ON r.id=u.role
 WHERE e.active=1 AND l.active=1 AND ($allLocations=1 OR (e.home_location_id=$scopeLocation AND ($scopeDepartment=0 OR e.preferred_department_id=$scopeDepartment)))
 AND ($locationId='' OR e.home_location_id=$locationId) AND ($positionId='' OR e.position_id=$positionId) AND ($roleId='' OR u.role=$roleId)
 AND ($search='' OR instr(lower(e.full_name),lower($search))>0 OR instr(e.personnel_number,$search)>0)`;
CATALOG.push({statement:S.listTeamPeople,sql:`SELECT e.personnel_number AS employeeNumber,e.full_name AS fullName,COALESCE(e.home_location_id,'') AS locationId,COALESCE(l.name,'') AS locationName,COALESCE(e.preferred_department_id,0) AS departmentId,COALESCE(e.position_id,'') AS positionId,COALESCE(p.name,'') AS positionName,COALESCE(u.role,'') AS roleId,COALESCE(r.name,'') AS roleName ${personFrom} ORDER BY e.full_name,e.personnel_number LIMIT $pageSize OFFSET $offset`},
 {statement:S.countTeamPeople,sql:`SELECT COUNT(*) AS count ${personFrom}`});
const selectedPeople=`SELECT value FROM json_each($employeeNumbers)`;
const selectedAssignments=`SELECT id FROM (SELECT id,learner_employee_number FROM personnel_learning_assignments UNION ALL SELECT id,learner_employee_number FROM personnel_learning_runs) a WHERE learner_employee_number IN (${selectedPeople})`;
for(const [name,oldName,column] of [["teamCompetencies","listCompetencies","employee_number"],["teamCompetencyRevisions","listCompetencyRevisions","competency_id"],["teamAssignments","listAssignments","learner_employee_number"],["teamAssignmentRevisions","listAssignmentRevisions","assignment_id"],["teamProgressRevisions","listProgressRevisions","assignment_id"]]){
 let source=(CATALOG.find(e=>e.statement.id===S[oldName]?.id)||old.find(e=>e.statement.id===legacy[oldName].id)).sql;
 const selected=column==="competency_id"?`SELECT id FROM personnel_learning_employee_competencies WHERE employee_number IN (${selectedPeople})`:column==="assignment_id"?selectedAssignments:selectedPeople;
 source=source.replace(/ORDER BY/i,`WHERE ${column} IN (${selected}) ORDER BY`);CATALOG.push({statement:S[name],sql:source});
}
module.exports={CATALOG:Object.freeze(CATALOG.map(entry=>Object.freeze({...entry,returning:false})))};
