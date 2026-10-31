"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { Client, Pool } = require("pg");
const { createPostgresqlPersistenceProvider } = require("../lib/persistence/postgresql/provider");
const { createPlanningSettingsRepository } = require("../lib/persistence/repositories/planning-settings");
const { createWorkRuleStoreRepository } = require("../lib/persistence/repositories/work-rule-store");
const { CATALOG } = require("../lib/persistence/postgresql/core/planning-shift-precondition-catalog");
const { planningShiftRevision } = require("../lib/planning-shift-precondition");

const databaseUrl = String(process.env.TEST_POSTGRESQL_URL || "").trim();

test("native PostgreSQL shift revision projection and atomic full-row update", {
  skip: !databaseUrl && "TEST_POSTGRESQL_URL absent; real PostgreSQL execution remains pending",
  timeout: 30000,
}, async t => {
  // Only the synthetic CI service used by the application workflow is allowed.
  // This test never opens a product URL or reuses product tables.
  const target = new URL(databaseUrl);
  assert.equal(target.protocol, "postgresql:");
  assert.equal(target.hostname, "127.0.0.1");
  assert.equal(target.port, "5432");
  assert.equal(target.pathname, "/grabenplaner_test");
  assert.equal(target.username, "postgres");
  const schema = "gp_shift_cas_" + randomBytes(12).toString("hex");
  assert.match(schema, /^gp_shift_cas_[a-f0-9]{24}$/);
  const setup = new Client({ connectionString: databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  let provider, catalogShiftBefore;
  await setup.connect();
  try {
    catalogShiftBefore = (await setup.query("SELECT to_regclass('pg_catalog.shifts')::oid AS oid")).rows[0].oid;
    assert.equal(catalogShiftBefore, null, "The isolated service must not already contain pg_catalog.shifts");
    await setup.query(`CREATE SCHEMA "${schema}"`);
    await setup.query(`SET search_path=pg_catalog,"${schema}"`);
    await setup.query(`CREATE TABLE "${schema}".shifts (
      id bigint PRIMARY KEY, employee_number text NOT NULL, location_id text NOT NULL,
      department_id bigint, duty_code text, shift_date text NOT NULL,
      start_time text NOT NULL, end_time text NOT NULL, area text, note text
    )`);
    const namespace = (await setup.query(`SELECT n.nspname, c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass($1)`, [schema + ".shifts"])).rows;
    assert.deepEqual(namespace, [{ nspname: schema, relname: "shifts" }]);
    assert.equal((await setup.query("SELECT to_regclass('pg_catalog.shifts')::oid AS oid")).rows[0].oid, catalogShiftBefore);
    provider = createPostgresqlPersistenceProvider({ pool, poolOwnership: "provider", catalog: CATALOG,
      prepareClient: client => client.query(`SET search_path=pg_catalog,"${schema}"`) });
    const reads = createPlanningSettingsRepository(provider);
    const writes = createWorkRuleStoreRepository(provider);
    const candidate = { id: 7, employeeNumber: "synthetic-employee", locationId: "synthetic-location",
      departmentId: 3, dutyCode: "department", shiftDate: "2031-03-04", startTime: "09:00",
      endTime: "17:00", area: "Verkauf", note: "  Notiz ü  " };
    const reset = async ({ departmentId = 3, dutyCode = "department", area = "Verkauf", note = "  Notiz ü  " } = {}) => {
      await setup.query("DELETE FROM shifts");
      await setup.query("INSERT INTO shifts VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [7, candidate.employeeNumber, candidate.locationId, departmentId, dutyCode,
          candidate.shiftDate, candidate.startTime, candidate.endTime, area, note]);
      return reads.getShiftForRevisionById({ id: 7 });
    };

    await t.test("qualified projection preserves all ten raw fields and matching updates succeed", async () => {
      const before = await reset();
      assert.deepEqual(before, { id: 7, employee_number: candidate.employeeNumber, location_id: candidate.locationId,
        department_id: 3, duty_code: "department", shift_date: candidate.shiftDate,
        start_time: "09:00", end_time: "17:00", area: "Verkauf", note: "  Notiz ü  " });
      assert.match(planningShiftRevision(before), /^[a-f0-9]{64}$/);
      assert.equal((await writes.updatePlanningShiftIfCurrent({ ...candidate, note: "changed" }, before)).rowsAffected, 1);
      assert.equal((await reads.getShiftForRevisionById({ id: 7 })).note, "changed");
    });

    await t.test("each changed old field rejects the write without changing the row", async () => {
      const replacements = { employee_number: "other", location_id: "other", department_id: 4,
        duty_code: "free", shift_date: "2031-03-05", start_time: "08:00", end_time: "18:00", area: "other", note: "other" };
      const before = await reset();
      for (const [field, value] of Object.entries(replacements)) {
        assert.equal((await writes.updatePlanningShiftIfCurrent({ ...candidate, note: "candidate" }, { ...before, [field]: value })).rowsAffected, 0, field);
      }
      assert.deepEqual(await reads.getShiftForRevisionById({ id: 7 }), before);
    });

    await t.test("nullable comparisons match null but never treat null as empty text", async () => {
      const before = await reset({ departmentId: null, dutyCode: null, area: null, note: null });
      for (const field of ["duty_code", "area", "note"]) {
        assert.equal((await writes.updatePlanningShiftIfCurrent(candidate, { ...before, [field]: "" })).rowsAffected, 0, field);
      }
      assert.equal((await writes.updatePlanningShiftIfCurrent(candidate, before)).rowsAffected, 1);
    });

    await t.test("a committed late change and a deleted row cannot be overwritten or recreated", async () => {
      const before = await reset();
      await setup.query("UPDATE shifts SET note=$1 WHERE id=$2", ["concurrent", 7]);
      assert.equal((await writes.updatePlanningShiftIfCurrent(candidate, before)).rowsAffected, 0);
      assert.equal((await reads.getShiftForRevisionById({ id: 7 })).note, "concurrent");
      await setup.query("DELETE FROM shifts WHERE id=$1", [7]);
      assert.equal((await writes.updatePlanningShiftIfCurrent(candidate, before)).rowsAffected, 0);
      assert.equal(await reads.getShiftForRevisionById({ id: 7 }), null);
    });

    await t.test("two writers sharing the same old snapshot have exactly one winner", async () => {
      const before = await reset();
      const results = await Promise.all(["first", "second"].map(note =>
        writes.updatePlanningShiftIfCurrent({ ...candidate, note }, before)));
      assert.deepEqual(results.map(result => result.rowsAffected).sort(), [0, 1]);
      assert.ok(["first", "second"].includes((await reads.getShiftForRevisionById({ id: 7 })).note));
    });
  } finally {
    try { if (provider) await provider.close(); else await pool.end(); }
    finally {
      try { await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally {
        try {
          assert.equal((await setup.query("SELECT to_regclass('pg_catalog.shifts')::oid AS oid")).rows[0].oid, catalogShiftBefore,
            "The test must never create a table in pg_catalog");
          assert.equal((await setup.query("SELECT to_regclass($1)::oid AS oid", [schema + ".shifts"])).rows[0].oid, null,
            "The isolated test schema and its shift table must be removed");
        } finally { await setup.end(); }
      }
    }
  }
});
