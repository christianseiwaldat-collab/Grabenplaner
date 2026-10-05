"use strict";
const crypto = require("node:crypto");
const {assertPersistenceProvider, PERSISTENCE_ERROR_CODES} = require("./persistence/contract");
const {createApplicationRepositories} = require("./persistence/application-repositories");
const {KEY} = require("./system-notification-receipt-settings");
const CONTEXT = Object.freeze({namespace: "system-notification-receipt", recordId: "email-v1", field: "receipt", employeeNumber: "system"});
const TOKEN_CONTEXT = Object.freeze({...CONTEXT, field: "confirmation-token"});
const SOURCE = "human-receipt-confirmation";
const REFERENCE = /^(?:[a-z0-9][a-z0-9._:-]{0,63})?$/i;
function failure(code, message, status = 400) {return Object.assign(new Error(message), {code: `NOTIFICATION_RECEIPT_${code}`, status});}
function canConfirmReceipt(actor) {
  return Boolean(actor && actor.sessionKind === "employee" && actor.isEmployee === true && actor.accountType === "employee"
    && !actor.mustChangePassword && typeof actor.employeeNumber === "string" && actor.employeeNumber.trim()
    && !["local", "system", "data_subject"].includes(actor.employeeNumber.toLowerCase())
    && ["admin", "it_admin", "developer"].includes(actor.role)
    && (actor.role === "developer" || ["system:readiness:review", "system:diagnostics:technical"]
      .every(permission => actor.permissions?.includes(permission))));
}
function requireActor(actor) {
  if (actor?.mustChangePassword) throw failure("PASSWORD_CHANGE_REQUIRED", "Bitte zuerst das persönliche Passwort ändern.", 428);
  if (!canConfirmReceipt(actor)) throw failure("ACCESS_DENIED", "Die Empfangsbestätigung benötigt ein berechtigtes persönliches Administrationskonto.", 403);
  return actor;
}
function createSystemNotificationReceiptStore({provider, protectJson, parseProtectedJson, configuration, revalidateActor, now = () => new Date()} = {}) {
  assertPersistenceProvider(provider);
  if ([protectJson, parseProtectedJson, configuration, revalidateActor, now].some(value => typeof value !== "function")) throw new TypeError("Notification receipt dependencies required");
  const unknown = reason => ({state: "unknown", source: null, checkedAt: null, reason});
  const current = () => {
    const value = configuration();
    return {available: value?.available === true, fingerprint: /^[a-f0-9]{64}$/.test(value?.fingerprint || "") ? value.fingerprint : null};
  };
  async function read() {
    const config = current();
    if (!config.available || !config.fingerprint) return unknown("provider_unavailable");
    const rows = await createApplicationRepositories(provider).planningSettings.listSettings();
    const stored = rows.filter(row => row.key === KEY);
    if (!stored.length) return unknown("not_confirmed");
    try {
      if (stored.length !== 1 || typeof stored[0].value !== "string" || !stored[0].value.startsWith("enc:v2:") || stored[0].value.length > 16384) throw new Error("invalid receipt");
      const value = await parseProtectedJson(stored[0].value, CONTEXT);
      if (value?.version !== 1 || value.source !== SOURCE || !/^[a-f0-9-]{36}$/.test(value.id || "")
        || !value.recordedBy || !value.accountId || !REFERENCE.test(value.reference || "")
        || !Number.isFinite(Date.parse(value.recordedAt)) || Date.parse(value.recordedAt) > new Date(now()).getTime() + 300000
        || !/^[a-f0-9]{64}$/.test(value.configurationFingerprint || "")) throw new Error("invalid receipt");
      if (value.configurationFingerprint !== config.fingerprint) return unknown("configuration_changed");
      return {state: "pass", source: SOURCE, checkedAt: value.recordedAt, reason: "human_confirmed"};
    } catch {return unknown("invalid_evidence");}
  }
  async function challenge(actor) {
    if (!canConfirmReceipt(actor)) return null;
    const config = current();
    if (!config.available || !config.fingerprint) return null;
    return protectJson({fingerprint: config.fingerprint, actor: actor.employeeNumber, accountId: String(actor.accountId || actor.employeeNumber), at: new Date(now()).toISOString()}, TOKEN_CONTEXT);
  }
  async function confirm(input, sessionContext) {
    if (!input || typeof input !== "object" || Array.isArray(input) || input.confirmed !== true
      || Object.keys(input).some(key => !["confirmed", "configurationToken", "reference"].includes(key))
      || typeof input.configurationToken !== "string" || input.configurationToken.length > 16384
      || (input.reference !== undefined && (typeof input.reference !== "string" || !REFERENCE.test(input.reference)))) {
      throw failure("INPUT_INVALID", "Bitte den tatsächlichen Empfang bestätigen; eine optionale Referenz darf nur eine kurze neutrale Kennung enthalten.");
    }
    const captured = {...input};
    for (let attempt = 0; ; attempt++) {
      try {
        return await provider.transaction(async executor => {
          const repositories = createApplicationRepositories(executor);
          const actor = requireActor(await revalidateActor(sessionContext, repositories));
          const config = current(), instant = new Date(now()).toISOString();
          if (!config.available || !config.fingerprint) throw failure("PROVIDER_UNAVAILABLE", "Der aktuelle Versandweg ist nicht betriebsbereit.", 409);
          let token;
          try {token = await parseProtectedJson(captured.configurationToken, TOKEN_CONTEXT);} catch {throw failure("STALE", "Bitte das System-Center neu laden und den Empfang erneut prüfen.", 409);}
          const age = Date.parse(instant) - Date.parse(token?.at);
          if (!Number.isFinite(age) || age < 0 || age > 15 * 60000 || token.fingerprint !== config.fingerprint
            || token.actor !== actor.employeeNumber || token.accountId !== String(actor.accountId || actor.employeeNumber)) {
            throw failure("STALE", "Konto oder Versandkonfiguration hat sich geändert. Bitte neu laden und den Empfang erneut prüfen.", 409);
          }
          const receipt = {version: 1, id: crypto.randomUUID(), source: SOURCE, recordedBy: actor.employeeNumber,
            accountId: String(actor.accountId || actor.employeeNumber), recordedAt: instant,
            configurationFingerprint: config.fingerprint, reference: captured.reference || ""};
          const encrypted = await protectJson(receipt, CONTEXT);
          if (typeof encrypted !== "string" || !encrypted.startsWith("enc:v2:") || encrypted.length > 16384) throw failure("PROTECTION_FAILED", "Die Bestätigung konnte nicht geschützt werden.", 503);
          const write = await repositories.planningSettings.upsertSetting({key: KEY, value: encrypted});
          const audit = await repositories.organizationPersonnel.insertAudit(actor.employeeNumber,
            "system.notifications.receipt.confirmed", "system_notification_receipt", receipt.id,
            JSON.stringify({channel: "email", source: SOURCE, recordedAt: instant}));
          if (write.rowsAffected !== 1 || audit.rowsAffected !== 1 || audit.returnedRows.length !== 1) throw failure("WRITE_INCOMPLETE", "Bestätigung und Prüfspur konnten nicht vollständig gespeichert werden.", 503);
          return {state: "pass", source: SOURCE, checkedAt: instant, reason: "human_confirmed"};
        }, {isolation: "serializable"});
      } catch (error) {
        if (provider.getCapabilities().providerId !== "postgresql" || error?.code !== PERSISTENCE_ERROR_CODES.RETRYABLE_TRANSACTION || attempt >= 3) throw error;
      }
    }
  }
  return Object.freeze({read, challenge, confirm});
}
module.exports = {createSystemNotificationReceiptStore, canConfirmReceipt, requireActor, CONTEXT};
