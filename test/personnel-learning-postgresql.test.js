"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { Client, Pool } = require("pg");
const fixture = require("../test-support/personnel-learning/fixture");
const { createSchemaPlan } = require("../lib/persistence/postgresql/core/schema");
const { compileCoreEntry } = require("../lib/persistence/postgresql/core/catalog");
const { SQLITE_PERSONNEL_LEARNING_CATALOG } = require("../lib/persistence/sqlite/personnel-learning-catalog");
const { createPostgresqlPersistenceProvider } = require("../lib/persistence/postgresql/provider");
const { createPersonnelLearningRepository } = require("../lib/persistence/repositories/personnel-learning");
const { buildPersonnelLearningProgressState } = require("../lib/personnel-learning-progress");

test("native PostgreSQL: publish, trainer binding, assignment, progress, completion and correction", {
  skip: !process.env.GP_LEARNING_QA_ROOT && "Dedicated isolated PostgreSQL cluster required",
}, async () => {
  const root = process.env.GP_LEARNING_QA_ROOT;
  assert.equal(process.platform, "linux");
  assert.equal(fs.realpathSync(root), root);
  assert.equal(fs.statSync(root).mode & 0o077, 0);
  assert.equal(fs.readFileSync(path.join(root, "ownership-marker"), "utf8").trim(), "gp-learning-isolated-qa-v1");
  const config = { host: path.join(root, "socket"), port: 55492, database: "gp_migration_core", user: "gpadmin", max: 1 };
  const admin = new Client(config); await admin.connect();
  let provider;
  try {
    assert.equal((await admin.query("SELECT inet_server_addr() address")).rows[0].address, null);
    assert.equal((await admin.query("SHOW data_directory")).rows[0].data_directory, root + "/data");
    assert.equal((await admin.query("SELECT to_regnamespace('gp') name")).rows[0].name, null);
    for (const role of ["gp_core_app", "gp_core_reader", "gp_core_owner", "gp_core_migrator"]) {
      if (!(await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rowCount) await admin.query(`CREATE ROLE ${role}`);
    }
    await admin.query("ALTER ROLE gp_core_app LOGIN; ALTER ROLE gp_core_migrator LOGIN; GRANT gp_core_owner TO gp_core_migrator; GRANT CREATE ON DATABASE gp_migration_core TO gp_core_owner");
    await admin.query("CREATE SCHEMA gp AUTHORIZATION gp_core_owner; SET search_path=pg_catalog,gp; SET ROLE gp_core_owner");
    await admin.query("CREATE TABLE gp.environment_contract(environment_id TEXT PRIMARY KEY,domain TEXT NOT NULL,profile TEXT NOT NULL)");
    await admin.query("INSERT INTO gp.environment_contract VALUES ('grabenplaner-development-20260912','core','core-migration-development')");
    await admin.query("GRANT USAGE ON SCHEMA gp TO gp_core_app,gp_core_reader; GRANT SELECT ON gp.environment_contract TO gp_core_app,gp_core_reader; RESET ROLE");
    const migrator=new Client({...config,user:"gp_core_migrator"});await migrator.connect();
    try {
      await require("../lib/persistence/postgresql/core/migrate").migrateCoreDevelopment(migrator);
      const migration=require("../lib/persistence/postgresql/core/personnel-learning-runs");
      assert.equal((await migration.migrate(migrator)).applied,true);
      assert.equal((await migration.migrate(migrator)).applied,false);
    } finally { await migrator.end(); }
    const queries = [];
    const capture = { prepare(sql) { return { run(...values) { let n = 0; queries.push([sql.replace(/\?/g, () => `$${++n}`), values]); } }; } };
    await admin.query("INSERT INTO gp.cost_center_types(id,code,name,is_branch) VALUES ('qa-branch','qa-branch','Testfiliale',1)");
    await admin.query("INSERT INTO gp.positions(id,name) VALUES ('verkaufsmitarbeiter','Verkauf')");
    await admin.query("INSERT INTO gp.cost_center_type_positions(cost_center_type_id,position_id) VALUES ('qa-branch','verkaufsmitarbeiter')");
    for (const [suffix, employee] of [["a", "LEARNER"], ["b", "TRAINER"]]) {
      const location = "assignment-foundation-" + suffix;
      await admin.query("INSERT INTO gp.cost_centers(id,code,name,type,cost_center_type_id) VALUES ($1,$1,'Testfiliale','branch','qa-branch')", [location]);
      await admin.query("INSERT INTO gp.locations(id,name,cost_center_id) VALUES ($1,'Testfiliale',$1)", [location]);
      await admin.query("INSERT INTO gp.employees(personnel_number,full_name,nickname,home_location_id) VALUES ($1,$1,$1,$2)", ["ASSIGNMENT-" + employee, location]);
    }
    fixture.insertPublishedModule(capture, "assignment-skill", fixture.skillInput());
    fixture.insertPublishedModule(capture, "assignment-process", fixture.processInput());
    const competency = fixture.insertTrainerCompetency(capture, "assignment-skill");
    const assignment = fixture.insertAssignment(capture, "assignment-process", competency);
    for (const [sql, values] of queries) await admin.query(sql, values);
    const pool = new Pool({ ...config, user:"gp_core_app", options: "-c search_path=pg_catalog,gp" });
    provider = createPostgresqlPersistenceProvider({ pool, poolOwnership: "provider", catalog: [...SQLITE_PERSONNEL_LEARNING_CATALOG.map(e => compileCoreEntry(e).providerEntry),...require("../lib/persistence/postgresql/core/personnel-learning-runs").CATALOG] });
    const repository = createPersonnelLearningRepository(provider);
    assert.equal((await repository.listModules()).length, 2);
    assert.equal((await repository.listEvents("assignment-process")).at(-1).eventType, "published");
    assert.equal((await repository.getLatestAssignmentRevision(assignment.identity.id)).trainerBindings[0].competencyRevisionReceipt, competency.revision.receiptSha256);
    let previous = "";
    for (const spec of [
      { completed: false, finalized: false, result: "pending" },
      { completed: true, finalized: true, result: "passed" },
      { completed: true, finalized: true, result: "follow_up_required", changeType: "corrected", correctionReason: "Praxis erneut gemeinsam prüfen." },
    ]) {
      const number = (await repository.listProgressRevisions()).length + 1;
      const row = fixture.insertProgressRevision(capture, assignment, { ...spec, revisionNumber: number, previousReceiptSha256: previous, changedAt: `2026-09-15T12:0${number}:00.000Z` });
      await repository.transaction(repo => repo.insertProgressRevision(row));
      previous = row.receiptSha256;
      assert.equal((await repository.getLatestProgressRevision(assignment.identity.id)).receiptSha256, previous);
    }
    const history = await repository.listProgressRevisions();
    const state = buildPersonnelLearningProgressState({ revisions: history, processSteps: fixture.processInput().content.steps });
    assert.equal(state.result, "follow_up_required");
    assert.equal(history.length, 3);
    await assert.rejects(admin.query("UPDATE gp.personnel_learning_assignment_progress_revisions SET assessment_note='overwrite'"), /immutable/);
    await assert.rejects(admin.query("DELETE FROM gp.personnel_learning_assignment_revisions"), /immutable/);
    assert.equal((await repository.listProgressRevisions()).length, 3);
    const assignmentsModel=require("../lib/personnel-learning-assignments");
    const identity={...assignment.identity,id:"learning-run:postgresql-second"};identity.receiptSha256=assignmentsModel.assignmentReceiptSha256(identity);
    const revision={...assignment.revision,assignmentId:identity.id};revision.receiptSha256=assignmentsModel.assignmentRevisionReceiptSha256(revision);
    await repository.transaction(async repo=>{await repo.insertAssignment(identity);await repo.insertAssignmentRevision(revision);});
    const runProgress=fixture.insertProgressRevision(capture,{identity,revision},{completed:false,finalized:false,result:"pending"});
    await repository.insertProgressRevision(runProgress);
    assert.equal((await repository.listAssignments()).length,2);
    assert.equal((await repository.getLatestProgressRevision(identity.id)).finalized,false);
    assert.equal((await repository.getLatestProgressRevision(assignment.identity.id)).result,"follow_up_required");
    const schedules=require("../lib/personnel-learning-schedules");
    const schedule={assignmentId:identity.id,revisionNumber:1,payload:{...schedules.normalizeSchedule({dueDate:"2026-10-31",repeatEveryMonths:1}),runNumber:2,previousAssignmentId:assignment.identity.id},previousReceiptSha256:"",changedBy:"ASSIGNMENT-ACTOR",changedAt:"2026-09-15T12:30:00Z"};schedule.receiptSha256=schedules.receipt(schedule);
    await repository.insertSchedule(schedule);
    assert.equal(schedules.projection(await repository.getSchedule(identity.id)).runNumber,2);
    assert.equal((await repository.listSchedules()).length,1);
    await assert.rejects(repository.transaction(async repo=>{const changed={...schedule,revisionNumber:2,previousReceiptSha256:schedule.receiptSha256};changed.receiptSha256=schedules.receipt(changed);await repo.insertSchedule(changed);throw new Error("Synthetic rollback");}),/Synthetic rollback/);
    assert.equal((await repository.getSchedule(identity.id)).revisionNumber,1);
    await assert.rejects(admin.query("DELETE FROM gp.personnel_learning_run_progress_revisions"),/immutable/);
    await assert.rejects(admin.query("UPDATE gp.personnel_learning_schedule_revisions SET changed_by='other'"),/immutable/);
    const proofModel=require("../lib/personnel-learning-assessment");
    const proof={id:"native-proof",assignmentId:identity.id,sequenceNumber:1,kind:"exam_attempt",payload:{processReceipt:"native-process",points:1,total:1,passed:true},protectedPayload:"synthetic-encrypted-placeholder",previousReceipt:"",changedBy:"ASSIGNMENT-LEARNER",changedAt:"2026-09-15T13:00:00Z"};
    proof.receiptSha256=proofModel.receipt(proof);await repository.insertAssessmentRecord(proof);
    assert.equal(proofModel.state(await repository.listAssessmentRecords(identity.id),"native-process").passed,true);
    assert.equal((await repository.getAssessmentRecord(proof.id)).protectedPayload,proof.protectedPayload);
    await assert.rejects(admin.query("DELETE FROM gp.personnel_learning_assessment_records"),/immutable/);
    await assert.rejects(repository.transaction(async repo=>{const next={...proof,id:"native-proof-rollback",sequenceNumber:2,previousReceipt:proof.receiptSha256};next.receiptSha256=proofModel.receipt(next);await repo.insertAssessmentRecord(next);throw new Error("proof rollback");}),/proof rollback/);
    assert.equal((await repository.listAssessmentRecords(identity.id)).length,1);
    const teamModel=require("../lib/personnel-learning-team");
    const requirement={id:"native-requirement",revision:1,payload:{...teamModel.normalize({title:"Kassa Anforderung",type:"skill",moduleId:"assignment-skill",scope:{type:"organization"}}),moduleVersionNumber:1},previousReceipt:"",changedBy:"ASSIGNMENT-ACTOR",changedAt:"2026-09-15T13:30:00Z"};
    requirement.receiptSha256=teamModel.receipt(requirement);await repository.insertRequirement(requirement);
    assert.equal(teamModel.rules(await repository.listRequirements()).length,1);
    await assert.rejects(admin.query("DELETE FROM gp.personnel_learning_requirement_revisions"),/immutable/);
    assert.equal((await repository.listAllVersions()).length,2);
    assert.equal((await repository.listAllEvents()).length,6);
    const filters={allLocations:true,scopeLocation:"",scopeDepartment:0,locationId:"",positionId:"",roleId:"",search:"ASSIGNMENT"};
    const total=await repository.countTeamPeople(filters);assert.ok(total.count>=2);
    const people=await repository.listTeamPeople({...filters,pageSize:1,offset:0});assert.equal(people.length,1);
    const data=await repository.teamData([assignment.identity.learnerEmployeeNumber]);
    assert.equal(data.teamAssignments.length,2);assert.equal(data.teamProgressRevisions.length,4);
    const empty=await repository.teamData(["nobody"]);assert.equal(empty.teamAssignments.length,0);assert.equal(empty.teamProgressRevisions.length,0);
    assert.equal((await repository.countTeamPeople({...filters,allLocations:false,scopeLocation:"unrelated"})).count,0);
    console.log(JSON.stringify({ nativePostgresql: (await admin.query("SHOW server_version")).rows[0].server_version, workflow: "passed", historicalRevisions: 3, independentRuns:2, additiveMigration:"idempotent", scheduleRollback:"passed",assessmentRecords:"passed",teamQueries:"passed",productionWrites: false }));
  } finally { await provider?.close(); await admin.end(); }
});
