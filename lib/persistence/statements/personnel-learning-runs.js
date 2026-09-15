"use strict";
const {definePersistenceStatement:d}=require("../contract");
const {PERSONNEL_LEARNING_STATEMENTS:legacy}=require("./personnel-learning");
const reads=["listAssignments","getAssignment","getAssignmentForLearner","listAssignmentRevisions","getLatestAssignmentRevision","listProgressRevisions","getLatestProgressRevision"];
const writes=["insertAssignment","insertAssignmentRevision","insertProgressRevision"];
const statements={};
for(const name of [...reads,...writes]) {
  const old=legacy[name];statements[name]=d({id:`personnel-learning.runs.${name.replace(/[A-Z]/g,c=>"-"+c.toLowerCase())}`,operation:old.operation,parameters:old.parameters,columns:old.columns});
}
const schedule={assignmentId:"text",revisionNumber:"safe_integer",payload:"json",previousReceiptSha256:"text",receiptSha256:"text",changedBy:"text",changedAt:"text"};
statements.listSchedules=d({id:"personnel-learning.schedules.list-current",operation:"queryAll",columns:schedule});
statements.getSchedule=d({id:"personnel-learning.schedules.get-current",operation:"queryOne",parameters:{assignmentId:"text"},columns:schedule});
statements.insertSchedule=d({id:"personnel-learning.schedules.insert",operation:"execute",parameters:schedule});
const record={id:"text",assignmentId:"text",sequenceNumber:"safe_integer",kind:"text",payload:"json",previousReceipt:"text",receiptSha256:"text",changedBy:"text",changedAt:"text"};
statements.listAssessmentRecords=d({id:"personnel-learning.assessment.list",operation:"queryAll",parameters:{assignmentId:"text"},columns:record});
statements.getAssessmentRecord=d({id:"personnel-learning.assessment.get",operation:"queryOne",parameters:{id:"text"},columns:{...record,protectedPayload:"text"}});
statements.insertAssessmentRecord=d({id:"personnel-learning.assessment.insert",operation:"execute",parameters:{...record,protectedPayload:"text"}});
for(const [name,oldName] of [["listAllVersions","listVersions"],["listAllEvents","listEvents"]])statements[name]=d({id:"personnel-learning.bulk."+name.replace(/[A-Z]/g,c=>"-"+c.toLowerCase()),operation:"queryAll",columns:legacy[oldName].columns});
const requirement={id:"text",revision:"safe_integer",payload:"json",previousReceipt:"text",receiptSha256:"text",changedBy:"text",changedAt:"text"};
statements.listRequirements=d({id:"personnel-learning.requirements.list",operation:"queryAll",columns:requirement});
statements.insertRequirement=d({id:"personnel-learning.requirements.insert",operation:"execute",parameters:requirement});
const filters={allLocations:"boolean",scopeLocation:"text",scopeDepartment:"safe_integer",locationId:"text",positionId:"text",roleId:"text",search:"text"};
const person={employeeNumber:"text",fullName:"text",locationId:"text",locationName:"text",departmentId:"safe_integer",positionId:"text",positionName:"text",roleId:"text",roleName:"text"};
statements.listTeamPeople=d({id:"personnel-learning.team.people",operation:"queryAll",parameters:{...filters,pageSize:"safe_integer",offset:"safe_integer"},columns:person});
statements.countTeamPeople=d({id:"personnel-learning.team.count",operation:"queryOne",parameters:filters,columns:{count:"safe_integer"}});
for(const [name,oldName] of [["teamCompetencies","listCompetencies"],["teamCompetencyRevisions","listCompetencyRevisions"],["teamAssignments","listAssignments"],["teamAssignmentRevisions","listAssignmentRevisions"],["teamProgressRevisions","listProgressRevisions"]])statements[name]=d({id:"personnel-learning.team."+name.replace(/[A-Z]/g,c=>"-"+c.toLowerCase()),operation:"queryAll",parameters:{employeeNumbers:"json"},columns:legacy[oldName].columns});
module.exports={S:Object.freeze(statements),reads,writes};
