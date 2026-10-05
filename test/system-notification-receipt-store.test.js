"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const crypto = require("node:crypto"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {createSystemNotificationReceiptStore, canConfirmReceipt, CONTEXT} = require("../lib/system-notification-receipt-store");
const {KEY} = require("../lib/system-notification-receipt-settings");
const {publicSettingsRows, publicSettingsObject} = require("../lib/privacy-organization-settings");
const {createExternalNotificationAdapter} = require("../lib/external-notifications");
const {createAmuStorage} = require("../lib/amu-storage");
const {openSqliteApplicationPersistence} = require("../lib/persistence/sqlite/provider");
const {SQLITE_APPLICATION_CATALOG} = require("../lib/persistence/sqlite/application-catalog");
const {ensureSqliteApplicationSchema} = require("../lib/persistence/sqlite/operations/application-schema");
const ACTOR = {employeeNumber: "SYNTHETIC-ADMIN", accountId: "synthetic-personal", role: "admin", sessionKind: "employee", accountType: "employee", isEmployee: true,
  permissions: ["system:readiness:review", "system:diagnostics:technical"]};
function fixture(t) {
  const app = openSqliteApplicationPersistence({databasePath: ":memory:", catalog: SQLITE_APPLICATION_CATALOG});
  ensureSqliteApplicationSchema(app.database);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-receipt-store-"));
  const storage = createAmuStorage({rootDirectory: root, encryptionKeys: {synthetic: crypto.randomBytes(32).toString("hex")}, activeKeyId: "synthetic"});
  t.after(async () => {await app.provider.close(); app.database.close(); fs.rmSync(root, {recursive: true, force: true});});
  let actor = ACTOR, fingerprint = "a".repeat(64), available = true, instant = "2026-10-05T18:00:00.000Z", revalidated = 0;
  const protectJson = (value, context) => storage.protectRecord(JSON.stringify(value), context);
  const parseProtectedJson = (value, context) => JSON.parse(storage.unprotectRecord(value, context));
  const store = createSystemNotificationReceiptStore({provider: app.provider, protectJson, parseProtectedJson,
    configuration: () => ({available, fingerprint}), now: () => instant,
    revalidateActor: async (_, repositories) => {revalidated++; assert.equal(typeof repositories.planningSettings.transaction, "undefined"); return actor;}});
  const encrypted = () => app.database.prepare("SELECT value FROM settings WHERE key=?").get(KEY)?.value;
  const audits = () => app.database.prepare("SELECT * FROM audit_log WHERE action='system.notifications.receipt.confirmed'").all();
  return {...app, store, encrypted, audits, parseProtectedJson, protectJson, setActor: value => {actor = value;},
    setConfig: value => {fingerprint = value;}, setAvailable: value => {available = value;}, setNow: value => {instant = value;}, revalidated: () => revalidated};
}
async function input(f, actor = ACTOR) {return {confirmed: true, configurationToken: await f.store.challenge(actor)};}

test("receipt persists only explicit human evidence with atomic neutral audit and authenticated encryption", async t => {
  const f = fixture(t);
  assert.equal((await f.store.read()).state, "unknown");
  assert.equal(f.encrypted(), undefined);
  const value = await f.store.confirm({...await input(f), reference: "TEST-20261005"}, {});
  assert.equal(value.state, "pass"); assert.equal(value.source, "human-receipt-confirmation");
  assert.match(f.encrypted(), /^enc:v2:/);
  assert.ok(!f.encrypted().includes("SYNTHETIC-ADMIN"));
  const stored = f.parseProtectedJson(f.encrypted(), CONTEXT);
  assert.equal(stored.recordedBy, ACTOR.employeeNumber);
  assert.equal(stored.accountId, ACTOR.accountId);
  assert.equal(stored.reference, "TEST-20261005");
  assert.equal(f.audits().length, 1); assert.equal(f.revalidated(), 1);
  assert.doesNotMatch(JSON.stringify(f.audits()), /TEST-20261005|configurationFingerprint|aaaaaa/);
  assert.deepEqual(await f.store.read(), value);
  assert.deepEqual(publicSettingsRows([{key: KEY, value: f.encrypted()}, {key: "opening_time", value: "08:00"}]), [{key: "opening_time", value: "08:00"}]);
  assert.deepEqual(publicSettingsObject({[KEY]: f.encrypted(), opening_time: "08:00"}), {opening_time: "08:00"});
});

test("a failed audit rolls the receipt write back instead of claiming confirmation", async t => {
  const f = fixture(t), body = await input(f);
  f.database.exec("CREATE TRIGGER reject_receipt_audit BEFORE INSERT ON audit_log WHEN NEW.action='system.notifications.receipt.confirmed' BEGIN SELECT RAISE(ABORT,'synthetic audit unavailable'); END");
  await assert.rejects(f.store.confirm(body, {}));
  assert.equal(f.encrypted(), undefined); assert.equal(f.audits().length, 0);
});

test("configuration changes, stale challenges, another account and disabled delivery cannot produce a pass", async t => {
  const f = fixture(t), body = await input(f);
  await f.store.confirm(body, {});
  f.setConfig("b".repeat(64));
  assert.equal((await f.store.read()).reason, "configuration_changed");
  await assert.rejects(f.store.confirm(body, {}), {code: "NOTIFICATION_RECEIPT_STALE"});
  const fresh = await input(f);
  f.setActor({...ACTOR, employeeNumber: "OTHER"});
  await assert.rejects(f.store.confirm(fresh, {}), {code: "NOTIFICATION_RECEIPT_STALE"});
  f.setActor(ACTOR); f.setNow("2026-10-05T18:16:00.000Z");
  await assert.rejects(f.store.confirm(fresh, {}), {code: "NOTIFICATION_RECEIPT_STALE"});
  f.setAvailable(false);
  assert.equal(await f.store.challenge(ACTOR), null);
  assert.equal((await f.store.read()).reason, "provider_unavailable");
  await assert.rejects(f.store.confirm(fresh, {}), {code: "NOTIFICATION_RECEIPT_PROVIDER_UNAVAILABLE"});
  assert.equal(f.audits().length, 1);
});

test("personal developer works without individual grants while restricted, local and changed-password accounts remain denied", async t => {
  const f = fixture(t);
  for (const mutation of [{sessionKind: "organization"}, {isEmployee: false}, {accountType: "branch"}, {employeeNumber: "local"}, {role: "manager"}, {role: "hr"}, {permissions: []}, {mustChangePassword: true}]) {
    const actor = {...ACTOR, ...mutation};
    assert.equal(canConfirmReceipt(actor), false);
    assert.equal(await f.store.challenge(actor), null);
    f.setActor(actor);
    await assert.rejects(f.store.confirm(await input(f), {}), error => [403,428].includes(error.status));
  }
  const developer = {...ACTOR, role: "developer", permissions: []};
  assert.equal(canConfirmReceipt(developer), true);
  f.setActor(developer);
  assert.equal((await f.store.confirm(await input(f, developer), {})).state, "pass");
});

test("unknown fields, personal free text, tampered tokens and corrupt stored records stay fail-closed", async t => {
  const f = fixture(t), valid = await input(f);
  for (const body of [{...valid, confirmed: false}, {...valid, recipient: "person@example.invalid"}, {...valid, reference: "person@example.invalid"}, {...valid, reference: "SELECT password FROM settings"}, {...valid, reference: "x".repeat(65)}]) {
    await assert.rejects(f.store.confirm(body, {}), {code: "NOTIFICATION_RECEIPT_INPUT_INVALID"});
  }
  await assert.rejects(f.store.confirm({...valid, configurationToken: "enc:v2:forged"}, {}), {code: "NOTIFICATION_RECEIPT_STALE"});
  f.database.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(KEY, "forged");
  assert.equal((await f.store.read()).reason, "invalid_evidence");
  assert.equal(f.audits().length, 0);
});

test("actual normalized SMTP and webhook route/credential changes alter internal fingerprints without dispatch", () => {
  let sends = 0;
  const smtp = {enabled: true, host: "smtp.example.invalid", port: 587, from: "sender@example.invalid", user: "synthetic-user", password: "synthetic-secret", senderApproved: true, dispatchEnabled: true, allowedEvents: ["password_reset"]};
  const adapter = patch => createExternalNotificationAdapter({configuration: {email: {...smtp, ...patch}}, smtpTransport: {sendMail: () => {sends++; throw new Error("unexpected send");}}});
  const original = adapter({}).getEmailConfigurationFingerprint();
  for (const patch of [{host: "new.example.invalid"}, {from: "other@example.invalid"}, {password: "changed-secret"}, {user: "changed-user"}, {port: 465}, {allowedEvents: ["branch_order"]}]) assert.notEqual(adapter(patch).getEmailConfigurationFingerprint(), original);
  assert.ok(!JSON.stringify(adapter({}).getProviderStatus()).includes(original));
  const webhook = token => createExternalNotificationAdapter({configuration: {emailWebhook: {url: "https://synthetic.invalid/send", token, sender: "sender@example.invalid", dispatchEnabled: true, senderApproved: true, allowedEvents: ["password_reset"]}}});
  assert.notEqual(webhook("first").getEmailConfigurationFingerprint(), webhook("second").getEmailConfigurationFingerprint());
  assert.equal(sends, 0);
});
