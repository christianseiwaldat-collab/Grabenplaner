"use strict";
const A=require("./personnel-learning-assignment-schema"),P=require("./personnel-learning-progress-schema");
const RENAMES = Object.freeze({
  personnel_learning_assignment_progress_revisions:"personnel_learning_run_progress_revisions",
  personnel_learning_assignment_revisions:"personnel_learning_run_revisions",
  personnel_learning_assignments:"personnel_learning_runs",
});
function rename(sql) { for(const [from,to] of Object.entries(RENAMES)) sql=sql.split(from).join(to); return sql; }
const TABLES = [...A.PERSONNEL_LEARNING_ASSIGNMENT_TABLE_DEFINITIONS,...P.PERSONNEL_LEARNING_PROGRESS_TABLE_DEFINITIONS].map(item=>({name:rename(item.name),sql:rename(item.sql).replace("UNIQUE(process_module_id, learner_employee_number),","")}));
TABLES.push({name:"personnel_learning_schedule_revisions",sql:`CREATE TABLE IF NOT EXISTS personnel_learning_schedule_revisions (
  assignment_id TEXT NOT NULL, revision_number INTEGER NOT NULL CHECK(revision_number>0),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), previous_receipt_sha256 TEXT NOT NULL,
  receipt_sha256 TEXT NOT NULL UNIQUE CHECK(length(receipt_sha256)=64), changed_by TEXT NOT NULL, changed_at TEXT NOT NULL,
  PRIMARY KEY(assignment_id,revision_number))`});
const INDEXES=A.PERSONNEL_LEARNING_ASSIGNMENT_INDEX_DEFINITIONS.map(i=>({name:rename(i.name),sql:rename(i.sql)}));
INDEXES.push({name:"idx_learning_runs_learner",sql:"CREATE INDEX IF NOT EXISTS idx_learning_runs_learner ON personnel_learning_runs(learner_employee_number,process_module_id,created_at)"});
const TRIGGERS=[...A.PERSONNEL_LEARNING_ASSIGNMENT_TRIGGER_DEFINITIONS,...P.PERSONNEL_LEARNING_PROGRESS_TRIGGER_DEFINITIONS].map(i=>({name:rename(i.name),sql:rename(i.sql)}));
for(const action of ["UPDATE","DELETE"]) TRIGGERS.push({name:`trg_learning_schedule_no_${action.toLowerCase()}`,sql:`CREATE TRIGGER IF NOT EXISTS trg_learning_schedule_no_${action.toLowerCase()} BEFORE ${action} ON personnel_learning_schedule_revisions BEGIN SELECT RAISE(ABORT,'Learning schedules are immutable'); END;`});
TRIGGERS.push({name:"trg_learning_schedule_binding",sql:`CREATE TRIGGER IF NOT EXISTS trg_learning_schedule_binding BEFORE INSERT ON personnel_learning_schedule_revisions BEGIN
  SELECT RAISE(ABORT,'Learning schedule assignment missing') WHERE NOT EXISTS(SELECT 1 FROM personnel_learning_assignments WHERE id=NEW.assignment_id) AND NOT EXISTS(SELECT 1 FROM personnel_learning_runs WHERE id=NEW.assignment_id);
  SELECT RAISE(ABORT,'Learning schedule history invalid') WHERE NEW.revision_number <> COALESCE((SELECT MAX(revision_number)+1 FROM personnel_learning_schedule_revisions WHERE assignment_id=NEW.assignment_id),1);
  SELECT RAISE(ABORT,'Learning schedule receipt invalid') WHERE NEW.previous_receipt_sha256 <> COALESCE((SELECT receipt_sha256 FROM personnel_learning_schedule_revisions WHERE assignment_id=NEW.assignment_id ORDER BY revision_number DESC LIMIT 1),'');
END;`});
TABLES.push({name:"personnel_learning_assessment_records",sql:`CREATE TABLE IF NOT EXISTS personnel_learning_assessment_records (
 id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL, sequence_number INTEGER NOT NULL CHECK(sequence_number>0),
 kind TEXT NOT NULL CHECK(kind IN ('exam_attempt','exam_reset','evidence','evidence_withdrawn')),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), protected_payload TEXT NOT NULL,
 previous_receipt TEXT NOT NULL, receipt_sha256 TEXT NOT NULL UNIQUE CHECK(length(receipt_sha256)=64),
 changed_by TEXT NOT NULL, changed_at TEXT NOT NULL, UNIQUE(assignment_id,sequence_number))`});
for(const action of ["UPDATE","DELETE"])TRIGGERS.push({name:`trg_learning_assessment_no_${action.toLowerCase()}`,sql:`CREATE TRIGGER IF NOT EXISTS trg_learning_assessment_no_${action.toLowerCase()} BEFORE ${action} ON personnel_learning_assessment_records BEGIN SELECT RAISE(ABORT,'Learning assessment records are immutable'); END;`});
TRIGGERS.push({name:"trg_learning_assessment_binding",sql:`CREATE TRIGGER IF NOT EXISTS trg_learning_assessment_binding BEFORE INSERT ON personnel_learning_assessment_records BEGIN
 SELECT RAISE(ABORT,'Learning assessment assignment missing') WHERE NOT EXISTS(SELECT 1 FROM personnel_learning_assignments WHERE id=NEW.assignment_id) AND NOT EXISTS(SELECT 1 FROM personnel_learning_runs WHERE id=NEW.assignment_id);
 SELECT RAISE(ABORT,'Learning assessment sequence invalid') WHERE NEW.sequence_number<>COALESCE((SELECT MAX(sequence_number)+1 FROM personnel_learning_assessment_records WHERE assignment_id=NEW.assignment_id),1);
 SELECT RAISE(ABORT,'Learning assessment receipt invalid') WHERE NEW.previous_receipt<>COALESCE((SELECT receipt_sha256 FROM personnel_learning_assessment_records WHERE assignment_id=NEW.assignment_id ORDER BY sequence_number DESC LIMIT 1),'');
END;`});
TABLES.push({name:"personnel_learning_requirement_revisions",sql:`CREATE TABLE IF NOT EXISTS personnel_learning_requirement_revisions (
 id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),previous_receipt TEXT NOT NULL,receipt_sha256 TEXT NOT NULL UNIQUE,changed_by TEXT NOT NULL,changed_at TEXT NOT NULL,PRIMARY KEY(id,revision))`});
for(const action of ["UPDATE","DELETE"])TRIGGERS.push({name:`trg_learning_requirement_no_${action.toLowerCase()}`,sql:`CREATE TRIGGER IF NOT EXISTS trg_learning_requirement_no_${action.toLowerCase()} BEFORE ${action} ON personnel_learning_requirement_revisions BEGIN SELECT RAISE(ABORT,'Learning requirements are immutable'); END;`});
TRIGGERS.push({name:"trg_learning_requirement_sequence",sql:`CREATE TRIGGER IF NOT EXISTS trg_learning_requirement_sequence BEFORE INSERT ON personnel_learning_requirement_revisions BEGIN
 SELECT RAISE(ABORT,'Learning requirement sequence invalid') WHERE NEW.revision<>COALESCE((SELECT MAX(revision)+1 FROM personnel_learning_requirement_revisions WHERE id=NEW.id),1);
 SELECT RAISE(ABORT,'Learning requirement receipt invalid') WHERE NEW.previous_receipt<>COALESCE((SELECT receipt_sha256 FROM personnel_learning_requirement_revisions WHERE id=NEW.id ORDER BY revision DESC LIMIT 1),'');
END;`});
function ensureLearningRunsSchema(database) { for(const item of [...TABLES,...INDEXES,...TRIGGERS]) database.exec(item.sql); }
module.exports={RENAMES,rename,TABLES,INDEXES,TRIGGERS,ensureLearningRunsSchema};
