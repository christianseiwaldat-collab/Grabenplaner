"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createPostgresqlStartupOperations } = require("../lib/persistence/postgresql/application-operations/startup");
const columns = "singleton_id,enabled,revision,updated_at";
const expected = Object.freeze({ singleton_id: 1, enabled: 0, revision: 1 });

test("PostgreSQL birthday policy defaults preserve the exact disabled historical singleton", () => {
  const { legacyRequire } = require("../test-support/legacy-baseline");
  const database = legacyRequire("lib/persistence/sqlite/provider").openSqliteLegacyDatabase(":memory:");
  try {
    legacyRequire("lib/persistence/sqlite/operations/portal-birthday-presentation-schema")
      .ensureSqlitePortalBirthdayPresentationSchema(database);
    const rows = database.prepare("SELECT " + columns + " FROM portal_birthday_presentation_policy").all();
    assert.equal(rows.length, 1);
    assert.deepEqual({ singleton_id: rows[0].singleton_id, enabled: rows[0].enabled, revision: rows[0].revision }, expected);
    assert.ok(Number.isFinite(Date.parse(rows[0].updated_at)));
  } finally { database.close(); }
});

test("real PostgreSQL startup initializes the policy once, preserves existing choices and rejects invalid state", {
  skip: !process.env.GP_CORE_MIGRATOR_URL,
}, async () => {
  const { withCoreFixture } = require("../test-support/postgresql-migration/core-fixture");
  const { openCoreOperations } = require("../lib/persistence/postgresql/application-operations/access");
  await withCoreFixture(async () => {
    const database = await openCoreOperations({
      profile: "core-migration-development", databaseUrl: process.env.GP_CORE_APP_URL, tlsMode: "disable-local-only",
    });
    try {
      const read = () => database.prepare("SELECT " + columns + " FROM portal_birthday_presentation_policy ORDER BY singleton_id").all();
      assert.deepEqual(await read(), []);
      const startup = createPostgresqlStartupOperations(database, {});
      const seed = () => startup.seedDefaults({ defaultSettings: {}, builtinPortalRoles: [] });
      await seed();
      const rows = await read();
      assert.equal(rows.length, 1);
      assert.deepEqual({ singleton_id: rows[0].singleton_id, enabled: rows[0].enabled, revision: rows[0].revision }, expected);
      assert.ok(Number.isFinite(Date.parse(rows[0].updated_at)));
      await seed();
      assert.deepEqual(await read(), rows, "restarting must preserve the original policy revision and timestamp");
      await database.prepare(`UPDATE portal_birthday_presentation_policy
        SET enabled=1,revision=revision+1,updated_at='2026-10-24T00:00:00.000Z' WHERE singleton_id=1`).run();
      const customized = await read();
      await seed(); await seed();
      assert.deepEqual(await read(), customized, "startup must retain an existing enabled policy and its revision");
      await assert.rejects(database.prepare(`UPDATE portal_birthday_presentation_policy
        SET enabled=2,revision=revision+1 WHERE singleton_id=1`).run(), error => error.code === "23514");
      await assert.rejects(database.prepare(`INSERT INTO portal_birthday_presentation_policy
        (singleton_id,enabled,revision) VALUES(2,0,1)`).run(), error => error.code === "23514");
      assert.deepEqual(await read(), customized, "failed policy writes must preserve every existing policy field");
    } finally { await database.close(); }
  });
});
