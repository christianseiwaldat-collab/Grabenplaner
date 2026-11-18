"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { absenceRequestSubmissionAllowed } = require("../lib/absence-request-policy");
const {
  PERMISSION, assertReservationReviewer, assertStaffingReservationAllowsAbsence,
  createStaffingReservations, findStaffingReservationConflict,
  writeWeekOptionWithReservationCheck,
} = require("../lib/staffing-reservations");
const { createApplicationRepositories } = require("../lib/persistence/application-repositories");
const { SQLITE_APPLICATION_CATALOG } = require("../lib/persistence/sqlite/application-catalog");
const { STAFFING_RESERVATION_CONFLICT } = require("../lib/persistence/catalogs/staff-assignment-request-catalog");
const { ensureSqliteApplicationSchema } = require("../lib/persistence/sqlite/operations/application-schema");
const { runSqliteHistoricalCompatibilityMigrations } = require("../lib/persistence/sqlite/operations/historical-compatibility-migrations");
const { createSqlitePersistenceProvider, openSqliteLegacyDatabase } = require("../lib/persistence/sqlite/provider");

const DAY = "2031-04-08";
const NEXT = "2031-04-09";
const BEFORE = "2031-04-07";
const input = {
  idempotencyKey: "wa:reservation:one",
  sourceLocationId: "18", destinationLocationId: "11",
  periodStartDate: DAY, periodEndDate: DAY, timeKind: "hourly",
  startTime: "13:00", endTime: "15:00",
};

function fixture(t) {
  const database = openSqliteLegacyDatabase(":memory:");
  ensureSqliteApplicationSchema(database);
  runSqliteHistoricalCompatibilityMigrations(database);
  for (const [id, active] of [["05", 1], ["11", 1], ["13", 0], ["18", 1], ["99", 1]]) {
    database.prepare("INSERT INTO locations (id, name, active) VALUES (?, ?, ?)").run(id, id, active);
  }
  database.prepare("INSERT INTO departments (id, location_id, name, active) VALUES (917, '11', 'Zielabteilung', 1)").run();
  for (const [number, branch] of [["Emma", "18"], ["252", "18"], ["275", "05"], ["201", "11"]]) {
    database.prepare("INSERT INTO employees (personnel_number, full_name, nickname, home_location_id, active) VALUES (?, ?, ?, ?, 1)")
      .run(number, number, number, branch);
  }
  const provider = createSqlitePersistenceProvider({
    database, catalog: [...SQLITE_APPLICATION_CATALOG, STAFFING_RESERVATION_CONFLICT],
  });
  t.after(async () => { await provider.close(); database.close(); });
  const repositories = createApplicationRepositories(provider);
  const actor = {
    employeeNumber: "Emma", sessionKind: "employee", permissions: [PERMISSION], grantedPermissions: [PERMISSION],
    explicitScopes: ["05", "11", "13", "18"].map(locationId => ({ locationId, departmentId: null })),
  };
  const context = { actor, failAudit: false };
  const service = createStaffingReservations({
    transaction: (work, options) => provider.transaction(executor => {
      const repositories = createApplicationRepositories(executor);
      return work(context.failAudit ? {
        ...repositories,
        organizationPersonnel: {
          ...repositories.organizationPersonnel,
          insertAudit: async () => { throw new Error("simulierter Fehler"); },
        },
      } : repositories);
    }, options),
    authorize: () => context.actor,
    periodForLocation: () => ({ minimum: BEFORE, maximum: "2031-09-30" }),
  });
  return { database, provider, repositories, context, service, actor };
}

function option(optionType, dateFrom = DAY, dateTo = dateFrom, employeeNumber = "252") {
  return { optionType, employeeNumber, dateFrom, dateTo, weekStart: BEFORE, groupId: "test-absence",
    allDay: 1, startTime: null, endTime: null, creditedMinutesPerDay: 0, note: "", schoolDetailsJson: null };
}

const held = { status: 409, code: "STAFFING_RESERVATION_ABSENCE_HOLD" };

test("Emma needs a live individual grant, two whole-branch scopes and an active topology", async t => {
  const { service, context, actor } = fixture(t);
  assert.deepEqual((await service.capabilities({})).locationIds, ["05", "11", "18"]);
  context.actor = { ...actor, employeeNumber: "275" };
  await assert.rejects(service.create({}, input), { status: 403, code: "STAFFING_RESERVATION_ACTOR_DENIED" });
  context.actor = { ...actor, grantedPermissions: [] };
  await assert.rejects(service.create({}, input), { status: 403, code: "STAFFING_RESERVATION_ACTOR_DENIED" });
  context.actor = { ...actor, explicitScopes: [{ locationId: "18" }, { locationId: "11", departmentId: 917 }] };
  await assert.rejects(service.create({}, input), { status: 403, code: "STAFFING_RESERVATION_SCOPE_DENIED" });
  context.actor = actor;
  await assert.rejects(service.create({}, { ...input, sourceLocationId: "99" }), { status: 403 });
  await assert.rejects(service.create({}, { ...input, sourceLocationId: "13" }), { code: "STAFFING_RESERVATION_TOPOLOGY_CHANGED" });
  await assert.rejects(service.create({}, { ...input, destinationDepartmentId: 918 }), { code: "STAFFING_RESERVATION_TOPOLOGY_CHANGED" });
  assert.throws(() => service.create({}, { ...input, confirmedEmployeeNumber: "252" }), { status: 400 });
  assert.throws(() => assertReservationReviewer(actor, "Emma"), { status: 403 });
  assert.throws(() => assertReservationReviewer({ ...actor, employeeNumber: "Kalle" }, "Emma"), { status: 403 });
  assert.doesNotThrow(() => assertReservationReviewer({ ...actor, employeeNumber: "252" }, "Emma"));
});

test("one hourly reservation holds the source calendar day, preserving pre-existing entries and pending submissions", async t => {
  const { service, repositories, database } = fixture(t);
  const existing = option("vacation");
  const planning = repositories.planningSettings;
  const [old] = (await writeWeekOptionWithReservationCheck(planning, existing)).rows;
  const created = await service.create({}, input);
  assert.equal(created.created, true);
  const { reservation } = created;
  assert.equal(reservation.status, "submitted");
  assert.equal(reservation.revisionNumber, 2);
  assert.equal(reservation.active, true);
  assert.equal(reservation.requestedHeadcount, 1);
  assert.equal((await repositories.staffAssignmentRequests.getLatestRevision(reservation.id)).confirmedEmployeeNumber, null);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM employee_location_lendings").get().count, 0);
  assert.deepEqual(await service.read({}, reservation.id), reservation);
  assert.deepEqual(await service.create({}, input), { created: false, reservation });
  await assert.rejects(service.create({}, { ...input, startTime: "12:00" }), { code: "STAFFING_RESERVATION_KEY_CONFLICT" });

  await assert.rejects(writeWeekOptionWithReservationCheck(planning, option("vacation")), held);
  await assert.rejects(writeWeekOptionWithReservationCheck(planning, {
    ...option("time_off"), allDay: 0, startTime: "08:00", endTime: "09:00",
  }), held);
  const nextDay = option("time_off", NEXT);
  const [next] = (await writeWeekOptionWithReservationCheck(planning, nextDay)).rows;
  await assert.rejects(writeWeekOptionWithReservationCheck(planning, { ...nextDay, dateFrom: DAY }, next.id), held);
  await writeWeekOptionWithReservationCheck(planning, { ...existing, note: "Bestehender Urlaub" }, old.id);
  await writeWeekOptionWithReservationCheck(planning, option("vacation", DAY, DAY, "201"));
  await assert.rejects(assertStaffingReservationAllowsAbsence(
    repositories.staffAssignmentRequests, { ...option("time_off", DAY, DAY, "201"), locationId: "18" },
  ), held);

  const inserted = await repositories.absenceManagement.insertVacationRequest({
    employeeNumber: "252", locationId: "18", dateFrom: DAY, dateTo: DAY, note: "",
  });
  const pending = await repositories.absenceManagement.requestByIdVacation(inserted.rows[0].id);
  assert.ok(["pending", "pending_local"].includes(pending.status));
  assert.equal(absenceRequestSubmissionAllowed({ ...held, allowed: false, trafficLight: "red" }), true);
  assert.equal(absenceRequestSubmissionAllowed({ code: "VACATION_REQUEST_BLOCKED", allowed: false, trafficLight: "red" }), false);
});

test("overlapping reservations, atomic writes and revision-safe release leave one consistent approval state", async t => {
  const { service, repositories, provider, context } = fixture(t);
  context.failAudit = true;
  await assert.rejects(service.create({}, input), /simulierter Fehler/);
  assert.deepEqual(await repositories.staffAssignmentRequests.listRequests(), []);
  context.failAudit = false;
  const duplicate = await Promise.all([service.create({}, input), service.create({}, input)]);
  assert.equal(duplicate.filter(result => result.created).length, 1);
  assert.equal(duplicate[0].reservation.id, duplicate[1].reservation.id);
  const first = duplicate[0].reservation;
  const { reservation: second } = await service.create({}, {
    ...input, idempotencyKey: "wa:reservation:two", periodEndDate: NEXT,
    timeKind: "multi_day", startTime: null, endTime: null,
  });
  await assert.rejects(service.release({}, first.id, { expectedRevision: 1 }), { status: 409 });
  const release = await service.release({}, first.id, { expectedRevision: 2 });
  assert.equal(release.active, false);
  assert.equal(release.status, "withdrawn");
  assert.deepEqual(await service.release({}, first.id, { expectedRevision: 2 }), release);
  const date = option("vacation", NEXT);
  assert.ok(await findStaffingReservationConflict(repositories.staffAssignmentRequests, date));
  await assert.rejects(writeWeekOptionWithReservationCheck(repositories.planningSettings, date), held);
  await assert.rejects(provider.transaction(async executor => {
    const bound = createApplicationRepositories(executor);
    await writeWeekOptionWithReservationCheck(bound.planningSettings, option("vacation", BEFORE));
    await writeWeekOptionWithReservationCheck(bound.planningSettings, date);
  }), held);
  assert.equal(await repositories.planningSettings.getWeekOptionById({ id: 1 }), null);
  await service.release({}, second.id, { expectedRevision: second.revisionNumber });
  assert.equal(await findStaffingReservationConflict(repositories.staffAssignmentRequests, date), null);
  assert.equal((await writeWeekOptionWithReservationCheck(repositories.planningSettings, date)).rowsAffected, 1);
});
