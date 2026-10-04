"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const crypto = require("node:crypto"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createPrivacyOrganizationStore } = require("../lib/privacy-organization-store");
const { createPrivacyLedger, applyPrivacyCommand, verifyPrivacyLedger } = require("../lib/privacy-organization");
const { PRIVACY_ORGANIZATION_SETTING_KEY: KEY, PRIVACY_ORGANIZATION_SETTING_PREFIX: PREFIX,
  isPrivacyOrganizationSettingKey, publicSettingsRows, publicSettingsObject } = require("../lib/privacy-organization-settings");
const { createAmuStorage } = require("../lib/amu-storage");
const { openSqliteApplicationPersistence, SQLITE_CAPABILITIES } = require("../lib/persistence/sqlite/provider");
const { SQLITE_APPLICATION_CATALOG } = require("../lib/persistence/sqlite/application-catalog");
const { ensureSqliteApplicationSchema } = require("../lib/persistence/sqlite/operations/application-schema");
const { createPersistenceProviderFacade, PERSISTENCE_ERROR_CODES, PersistenceError } = require("../lib/persistence/contract");

const NOW = "2026-10-03T08:00:00.000Z";
const CONTEXT = { namespace: "privacy-organization", recordId: "ledger-v1", field: "ledger", employeeNumber: "system" };
const ACTOR = { employeeNumber: "SYNTHETIC-HR", role: "hr", personal: true,
  permissions: ["privacy_organization:read", "privacy_organization:manage", "privacy_organization:approve"] };
const create = (expectedRevision = 0, title = "PRIVATE synthetic process") => ({
  action: "create", kind: "activity", payload: { title }, expectedRevision,
});
const updateOrganization = (expectedRevision, controllerName = "PRIVATE controller") => ({
  action: "update", id: "organization", payload: { controllerName }, expectedRevision,
});

function protectedFixture(t) {
  const tempRoot = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, "gp-privacy-store-test-"));
  const storage = createAmuStorage({ rootDirectory: root, encryptionKeys: { synthetic: crypto.randomBytes(32).toString("hex") }, activeKeyId: "synthetic" });
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), tempRoot);
    assert.ok(path.basename(root).startsWith("gp-privacy-store-test-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    storage,
    protectJson: (value, context) => storage.protectRecord(JSON.stringify(value), context),
    parseProtectedJson: (value, context) => JSON.parse(storage.unprotectRecord(value, context)),
  };
}

function fixture(t, overrides = {}) {
  const app = openSqliteApplicationPersistence({ databasePath: ":memory:", catalog: SQLITE_APPLICATION_CATALOG });
  ensureSqliteApplicationSchema(app.database);
  t.after(async () => { await app.provider.close(); app.database.close(); });
  const protection = protectedFixture(t), checks = [];
  const options = { provider: app.provider, ...protection, now: () => NOW,
    revalidateActor: async (sessionContext, repositories, command) => {
      checks.push({ sessionContext, repositories, command,
        bound: typeof repositories.organizationPersonnel.transaction !== "function"
          && typeof repositories.planningSettings.transaction !== "function" });
      return sessionContext?.actor || ACTOR;
    }, ...overrides };
  const store = createPrivacyOrganizationStore(options);
  const encrypted = () => app.database.prepare("SELECT value FROM settings WHERE key=?").get(KEY)?.value;
  const audits = () => app.database.prepare("SELECT * FROM audit_log WHERE action='privacy-organization.command' ORDER BY id").all();
  const ledger = () => protection.parseProtectedJson(encrypted(), CONTEXT);
  const seed = value => app.database.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(KEY,
    typeof value === "string" ? value : protection.protectJson(value, CONTEXT));
  return { ...app, ...protection, options, store, checks, encrypted, audits, ledger, seed };
}

test("privacy settings: every reserved key is hidden from public rows/objects without mutating public settings", () => {
  const rows = [{ key: "opening_time", value: "08:00" }, { key: KEY, value: "enc:v2:SECRET" },
    { key: `${PREFIX}future_source`, value: "PRIVATE" }, { key: "not_privacy_organization_value", value: "public" }];
  const original = JSON.stringify(rows);
  assert.equal(isPrivacyOrganizationSettingKey(KEY), true);
  assert.equal(isPrivacyOrganizationSettingKey(`${PREFIX}future_source`), true);
  assert.equal(isPrivacyOrganizationSettingKey(undefined), false);
  assert.equal(isPrivacyOrganizationSettingKey("opening_time"), false);
  assert.deepEqual(publicSettingsRows(rows), [rows[0], rows[3]]);
  assert.deepEqual(publicSettingsObject(Object.fromEntries(rows.map(row => [row.key, row.value]))),
    { opening_time: "08:00", not_privacy_organization_value: "public" });
  assert.equal(JSON.stringify(rows), original);
});

test("privacy store: a genuine provider and mandatory cryptography/live authority callbacks are required", t => {
  const f = fixture(t);
  assert.throws(() => createPrivacyOrganizationStore({ ...f.options, provider: { ...f.provider } }),
    error => error.code === PERSISTENCE_ERROR_CODES.CONTRACT_VIOLATION);
  for (const callback of ["protectJson", "parseProtectedJson", "revalidateActor"]) {
    assert.throws(() => createPrivacyOrganizationStore({ ...f.options, [callback]: null }), TypeError);
  }
});

test("privacy store: reading a stable initial draft uses bound live authority and a read-only transaction without writes", async t => {
  const f = fixture(t), before = f.database.prepare("SELECT total_changes() AS n").get().n;
  const first = await f.store.read({ requestMarker: "SYNTHETIC" });
  const second = await f.store.read({ requestMarker: "OTHER" });
  assert.equal(first.revision, 0);
  assert.equal(first.receiptSha256, second.receiptSha256);
  assert.deepEqual(first.capabilities, { read: true, manage: true, approve: true });
  assert.equal(f.encrypted(), undefined);
  assert.equal(f.database.prepare("SELECT total_changes() AS n").get().n, before);
  assert.ok(f.checks.every(value => value.bound === true));
  assert.ok(f.checks.every(value => typeof value.repositories.organizationPersonnel.transaction !== "function"));
  assert.deepEqual(f.checks.map(value => value.command), [{ action: "read" }, { action: "read" }]);
  assert.equal(JSON.stringify(first).includes("enc:v2:"), false);
});

test("privacy store: startup integrity verification exposes only presence/revision/hash and never creates an account or draft", async t => {
  const f = fixture(t);
  const empty = await f.store.verifyIntegrity();
  assert.deepEqual(Object.keys(empty).sort(), ["present", "receiptSha256", "revision"]);
  assert.equal(empty.present, false);
  assert.equal(empty.revision, 0);
  assert.equal(f.checks.length, 0);
  await f.store.command(create(), {});
  const count = f.checks.length, before = f.database.prepare("SELECT total_changes() AS n").get().n;
  const present = await f.store.verifyIntegrity();
  assert.equal(present.present, true);
  assert.equal(present.revision, 1);
  assert.equal(f.checks.length, count);
  assert.equal(f.database.prepare("SELECT total_changes() AS n").get().n, before);
});

test("privacy store: technical/shared/local principals cannot read or mutate even with copied privacy permissions", async t => {
  const f = fixture(t);
  const principals = [
    { ...ACTOR, role: "developer" }, { ...ACTOR, role: "it_admin" },
    { ...ACTOR, personal: false }, { ...ACTOR, employeeNumber: "local" },
    { ...ACTOR, employeeNumber: "system" }, { ...ACTOR, permissions: [] },
  ];
  for (const actor of principals) {
    await assert.rejects(f.store.read({ actor }), error => error.statusCode === 403);
    await assert.rejects(f.store.command(create(), { actor }), error => error.statusCode === 403);
  }
  assert.equal(f.encrypted(), undefined);
  assert.equal(f.audits().length, 0);
});

test("privacy store: current read permission and exact capabilities come from the actor inside the transaction", async t => {
  const f = fixture(t), reader = { ...ACTOR, permissions: ["privacy_organization:read"] };
  const result = await f.store.read({ actor: reader });
  assert.deepEqual(result.capabilities, { read: true, manage: false, approve: false });
  await assert.rejects(f.store.read({ actor: { ...ACTOR, permissions: ["privacy_organization:manage"] } }),
    error => error.statusCode === 403);
  await assert.rejects(f.store.command(create(), { actor: reader }), error => error.statusCode === 403);
  await assert.rejects(f.store.command(create(), { actor: { ...ACTOR, permissions: ["privacy_organization:manage"] } }),
    error => error.statusCode === 403);
});

test("privacy store: live authority receives the verified fresh ledger, isolated from accidental callback mutation", async t => {
  const f = fixture(t);
  await f.store.command(updateOrganization(0, "First controller"), {});
  let observed;
  const store = createPrivacyOrganizationStore({ ...f.options, revalidateActor: async (_, repositories, command, ledger) => {
    assert.equal(command.expectedRevision, 1);
    assert.equal(typeof repositories.organizationPersonnel.transaction, "undefined");
    observed = ledger.records.find(record => record.id === "organization").payload.controllerName;
    ledger.receiptSha256 = "a".repeat(64);
    ledger.records[0].payload.controllerName = "Accidental callback mutation";
    return ACTOR;
  } });
  await store.command(updateOrganization(1, "Second controller"), {});
  assert.equal(observed, "First controller");
  assert.equal(f.ledger().records[0].payload.controllerName, "Second controller");
  verifyPrivacyLedger(f.ledger());
});

test("privacy store: free-form imported case identifiers are hashed in ordinary audit records", async t => {
  const f = fixture(t);
  const command = { ...create(), id: "PRIVATE-controller-reference" };
  await f.store.command(command, {});
  const audit = f.audits()[0];
  assert.equal(audit.entity_id, `sha256:${crypto.createHash("sha256").update(command.id).digest("hex")}`);
  assert.equal(JSON.stringify(audit).includes("PRIVATE"), false);
  assert.equal(JSON.parse(audit.detail).kind, "activity");
  assert.equal(JSON.parse(audit.detail).action, "create");
});

test("privacy store: genuine encryption binds the private ledger namespace and neutral audits contain no case payload", async t => {
  const f = fixture(t);
  const result = await f.store.command(updateOrganization(0, "PRIVATE controller name"), { authority: "live" });
  assert.equal(result.revision, 1);
  const encrypted = f.encrypted();
  assert.ok(encrypted.startsWith("enc:v2:"));
  assert.equal(encrypted.includes("PRIVATE"), false);
  const ledger = f.ledger();
  verifyPrivacyLedger(ledger);
  assert.throws(() => f.storage.unprotectRecord(encrypted, { ...CONTEXT, recordId: "another-ledger" }));
  const audit = f.audits()[0];
  assert.equal(audit.actor, ACTOR.employeeNumber);
  assert.equal(audit.entity_type, "privacy_organization");
  for (const secret of ["PRIVATE", "controllerName", "controllerContact", NOW, encrypted]) {
    assert.equal(audit.detail.includes(secret), false, secret);
  }
  const detail = JSON.parse(audit.detail);
  assert.equal(detail.revision, 1);
  assert.equal(detail.receiptSha256, ledger.receiptSha256);
  assert.equal(JSON.stringify(result).includes(encrypted), false);
});

test("privacy store: audit failure rolls back the encrypted ledger and every logical event together", async t => {
  const f = fixture(t);
  await f.store.command(create(), {});
  const before = f.encrypted(), history = JSON.stringify(f.ledger()), audits = f.audits().length;
  f.database.exec("CREATE TRIGGER synthetic_privacy_audit_failure BEFORE INSERT ON audit_log WHEN NEW.action='privacy-organization.command' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  await assert.rejects(f.store.command(updateOrganization(1), {}),
    error => error.code === PERSISTENCE_ERROR_CODES.CHECK_VIOLATION);
  assert.equal(f.encrypted(), before);
  assert.equal(JSON.stringify(f.ledger()), history);
  assert.equal(f.audits().length, audits);
});

test("privacy store: silently ignored ledger/audit writes cannot report a successful command", async t => {
  for (const target of ["settings", "audit_log"]) {
    const f = fixture(t);
    await f.store.command(create(), {});
    const before = f.encrypted();
    const predicate = target === "settings" ? `NEW.key='${KEY}'` : "NEW.action='privacy-organization.command'";
    f.database.exec(`CREATE TRIGGER synthetic_privacy_ignore BEFORE INSERT ON ${target} WHEN ${predicate} BEGIN SELECT RAISE(IGNORE); END`);
    await assert.rejects(f.store.command(updateOrganization(1), {}), error => error.code === (target === "settings"
      ? "PRIVACY_ORGANIZATION_WRITE_INCOMPLETE" : "PRIVACY_ORGANIZATION_AUDIT_INCOMPLETE"));
    assert.equal(f.encrypted(), before);
    assert.equal(f.audits().length, 1);
    assert.equal(f.ledger().revision, 1);
  }
});

test("privacy store: competing editors with the same global revision produce exactly one committed command", async t => {
  const f = fixture(t);
  const results = await Promise.allSettled([
    f.store.command(create(0, "First process"), {}), f.store.command(create(0, "Second process"), {}),
  ]);
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
  const rejected = results.find(value => value.status === "rejected");
  assert.equal(rejected.reason.statusCode, 409);
  assert.equal(f.ledger().revision, 1);
  assert.equal(f.audits().length, 1);
});

test("privacy store: stale/absent/invalid revisions cannot overwrite newer state", async t => {
  const f = fixture(t);
  await f.store.command(create(), {});
  const before = f.encrypted();
  await assert.rejects(f.store.command(updateOrganization(0), {}), error => error.statusCode === 409);
  for (const revision of [undefined, null, -1, "1", 1.5, NaN]) {
    const command = updateOrganization(1);
    if (revision === undefined) delete command.expectedRevision;
    else command.expectedRevision = revision;
    await assert.rejects(f.store.command(command, {}), error => error.statusCode === 400);
  }
  assert.equal(f.encrypted(), before);
  assert.equal(f.audits().length, 1);
});

test("privacy store: a revoked live actor fails before writes despite previously trusted request context", async t => {
  const f = fixture(t);
  let live = ACTOR;
  const store = createPrivacyOrganizationStore({ ...f.options, revalidateActor: async () => live });
  await store.command(create(), { actor: ACTOR });
  const before = f.encrypted();
  live = { ...ACTOR, permissions: [] };
  await assert.rejects(store.command(updateOrganization(1), { actor: ACTOR }), error => error.statusCode === 403);
  await assert.rejects(store.read({ actor: ACTOR }), error => error.statusCode === 403);
  assert.equal(f.encrypted(), before);
  assert.equal(f.audits().length, 1);
});

test("privacy store: mutation commands are captured before asynchronous actor validation", async t => {
  const f = fixture(t);
  let release, arrived;
  const checking = new Promise(resolve => { arrived = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const store = createPrivacyOrganizationStore({ ...f.options, revalidateActor: async () => { arrived(); await waiting; return ACTOR; } });
  const command = create(), pending = store.command(command, {});
  await checking;
  command.payload.title = "Unexpected editor mutation";
  command.expectedRevision = 123;
  release();
  await pending;
  assert.equal(JSON.stringify(f.ledger()).includes("Unexpected editor mutation"), false);
  assert.equal(JSON.stringify(f.ledger()).includes("PRIVATE synthetic process"), true);
});

test("privacy store: accessors/cycles/undefined/sparse or decorated arrays are rejected without executing getters", async t => {
  const f = fixture(t);
  let executed = false;
  const accessor = create();
  Object.defineProperty(accessor.payload, "title", { enumerable: true, get() { executed = true; return "unsafe"; } });
  const cycle = create(); cycle.payload.loop = cycle;
  const sparse = create(); sparse.payload.scope = Array(2);
  const decorated = create(); decorated.payload.scope = ["employees"]; decorated.payload.scope.hidden = "unsafe";
  const undefinedField = create(); undefinedField.extra = undefined;
  for (const command of [accessor, cycle, sparse, decorated, undefinedField]) {
    await assert.rejects(f.store.command(command, {}), error => error.statusCode === 400);
  }
  assert.equal(executed, false);
  assert.equal(f.encrypted(), undefined);
});

test("privacy store: unencrypted, invalid or swapped ciphertext fails closed for startup/read/command", async t => {
  const f = fixture(t);
  const values = [JSON.stringify(createPrivacyLedger()), "enc:v2:INVALID",
    f.protectJson(createPrivacyLedger(), { ...CONTEXT, namespace: "another-module" })];
  for (const value of values) {
    f.seed(value);
    for (const operation of [() => f.store.verifyIntegrity(), () => f.store.read({}), () => f.store.command(create(), {})]) {
      await assert.rejects(operation(), error => error.code === "PRIVACY_ORGANIZATION_INTEGRITY_FAILED" && error.statusCode === 503);
    }
    assert.equal(f.encrypted(), value);
    assert.equal(f.audits().length, 0);
  }
});

test("privacy store: missing history or altered receipt survives valid AEAD but fails ledger verification", async t => {
  const f = fixture(t);
  await f.store.command(create(), {});
  const original = f.ledger();
  for (const change of [value => { value.events = []; }, value => { value.receiptSha256 = "a".repeat(64); }]) {
    const tampered = structuredClone(original); change(tampered); f.seed(tampered);
    await assert.rejects(f.store.verifyIntegrity(), error => error.code === "PRIVACY_ORGANIZATION_INTEGRITY_FAILED");
    await assert.rejects(f.store.command(updateOrganization(1), {}), error => error.code === "PRIVACY_ORGANIZATION_INTEGRITY_FAILED");
  }
  assert.equal(f.audits().length, 1);
});

test("privacy store: plaintext protection callbacks cannot write a ledger or audit", async t => {
  const f = fixture(t);
  const store = createPrivacyOrganizationStore({ ...f.options, protectJson: value => JSON.stringify(value) });
  await assert.rejects(store.command(create(), {}), error => error.code === "PRIVACY_ORGANIZATION_PROTECTION_FAILED");
  assert.equal(f.encrypted(), undefined);
  assert.equal(f.audits().length, 0);
});

test("privacy store: read authorization is bound to the same read-only executor and cannot silently write", async t => {
  const f = fixture(t);
  const store = createPrivacyOrganizationStore({ ...f.options, revalidateActor: async (_, repositories) => {
    await repositories.planningSettings.upsertSetting({ key: "synthetic-unauthorized-write", value: "no" });
    return ACTOR;
  } });
  await assert.rejects(store.read({}), error => error.code === PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM settings WHERE key='synthetic-unauthorized-write'").get().n, 0);
});

// Contract-level fault injection, separate from the real SQLite tests above.
// A facade is genuine, but this adapter makes no native PostgreSQL claim.
function retryFixture(t, { failures = 0, errorCode = PERSISTENCE_ERROR_CODES.RETRYABLE_TRANSACTION, afterFailure } = {}) {
  const protection = protectedFixture(t);
  let settings = new Map(), audit = [], attempts = 0, commits = 0;
  const provider = createPersistenceProviderFacade({
    providerId: "postgresql", capabilities: { ...SQLITE_CAPABILITIES,
      features: { ...SQLITE_CAPABILITIES.features, concurrentWrites: true } },
    query: async () => [], execute: async () => ({ rowsAffected: 0, returnedRows: [] }), close: async () => {},
    beginTransaction: async options => {
      attempts += 1;
      const local = new Map(settings), localAudit = [...audit];
      return {
        query: async statement => {
          assert.equal(statement.id, "planning-settings.settings.list");
          return [...local].map(([key, value]) => ({ data: { key, value } }));
        },
        execute: async (statement, parameters) => {
          assert.equal(options.readOnly, false);
          if (statement.id === "planning-settings.settings.upsert") {
            local.set(parameters.payload.key, parameters.payload.value);
            return { rowsAffected: 1, returnedRows: [] };
          }
          assert.equal(statement.id, "organization-personnel.audit.insert");
          localAudit.push(parameters);
          return { rowsAffected: 1, returnedRows: [{ id: localAudit.length }] };
        },
        commit: async () => {
          if (!options.readOnly && failures-- > 0) {
            afterFailure?.({ seed: ledger => settings.set(KEY, protection.protectJson(ledger, CONTEXT)) });
            throw new PersistenceError(errorCode, { operation: "transaction" });
          }
          settings = local; audit = localAudit; commits += 1;
        },
        rollback: async () => {},
      };
    },
  });
  t.after(() => provider.close());
  return { provider, ...protection, state: () => ({ attempts, commits, audit, settings }),
    options: { provider, ...protection, now: () => NOW, revalidateActor: async () => ACTOR } };
}

test("privacy store: PostgreSQL serialization retries reread state and revalidate authority at most three times", async t => {
  const f = retryFixture(t, { failures: 3 });
  let checked = 0;
  const store = createPrivacyOrganizationStore({ ...f.options, revalidateActor: async (_, __, command) => {
    checked += 1; assert.equal(command.expectedRevision, 0); return ACTOR;
  } });
  const result = await store.command(create(), {});
  assert.equal(result.revision, 1);
  assert.equal(checked, 4);
  assert.equal(f.state().attempts, 4);
  assert.equal(f.state().commits, 1);
  assert.equal(f.state().audit.length, 1);
});

test("privacy store: exhausted serialization retries preserve all uncommitted state", async t => {
  const f = retryFixture(t, { failures: 100 });
  const store = createPrivacyOrganizationStore(f.options);
  await assert.rejects(store.command(create(), {}), error => error.code === PERSISTENCE_ERROR_CODES.RETRYABLE_TRANSACTION);
  assert.equal(f.state().attempts, 4);
  assert.equal(f.state().commits, 0);
  assert.equal(f.state().audit.length, 0);
  assert.equal(f.state().settings.has(KEY), false);
});

test("privacy store: a concurrent commit discovered on retry stays a revision conflict rather than rebasing the old draft", async t => {
  const winner = applyPrivacyCommand(createPrivacyLedger(), create(0, "Concurrent winning process"), { actor: ACTOR, now: NOW });
  const f = retryFixture(t, { failures: 1, afterFailure: ({ seed }) => seed(winner) });
  const store = createPrivacyOrganizationStore(f.options);
  await assert.rejects(store.command(create(0, "Losing process"), {}), error => error.statusCode === 409);
  assert.equal(f.state().attempts, 2);
  assert.equal(f.state().audit.length, 0);
  assert.equal(JSON.stringify(f.parseProtectedJson(f.state().settings.get(KEY), CONTEXT)).includes("Losing process"), false);
});

test("privacy store: permissions withdrawn after a retryable failure are checked again before persistence", async t => {
  const f = retryFixture(t, { failures: 1 });
  let checked = 0;
  const store = createPrivacyOrganizationStore({ ...f.options, revalidateActor: async () =>
    (++checked === 1 ? ACTOR : { ...ACTOR, permissions: [] }) });
  await assert.rejects(store.command(create(), {}), error => error.statusCode === 403);
  assert.equal(checked, 2);
  assert.equal(f.state().audit.length, 0);
  assert.equal(f.state().settings.has(KEY), false);
});

test("privacy store: non-serialization failures are never automatically retried", async t => {
  const f = retryFixture(t, { failures: 10, errorCode: PERSISTENCE_ERROR_CODES.CONNECTION_UNAVAILABLE });
  const store = createPrivacyOrganizationStore(f.options);
  await assert.rejects(store.command(create(), {}), error => error.code === PERSISTENCE_ERROR_CODES.CONNECTION_UNAVAILABLE);
  assert.equal(f.state().attempts, 1);
  assert.equal(f.state().settings.has(KEY), false);
});
