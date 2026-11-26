"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const crypto = require("node:crypto"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {createSystemNotificationReceiptStore, canConfirmReceipt, CONTEXT} = require("../lib/system-notification-receipt-store");
const {KEY} = require("../lib/system-notification-receipt-settings");
const {publicSettingsRows, publicSettingsObject} = require("../lib/privacy-organization-settings");
const {createExternalNotificationAdapter} = require("../lib/external-notifications");
const {createAmuStorage} = require("../lib/amu-storage");
const {SQLITE_APPLICATION_CATALOG} = require("../lib/persistence/sqlite/application-catalog");
const {ensureSqliteApplicationSchema} = require("../lib/persistence/sqlite/operations/application-schema");
const ACTOR = {employeeNumber: "SYNTHETIC-ADMIN", accountId: "synthetic-personal", role: "admin", sessionKind: "employee", accountType: "employee", isEmployee: true,
  permissions: ["system:readiness:review", "system:diagnostics:technical"]};
async function input(f, actor = ACTOR) {return {confirmed: true, configurationToken: await f.store.challenge(actor)};}

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
