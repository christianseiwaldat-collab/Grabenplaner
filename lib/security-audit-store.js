'use strict';
const { assertPersistenceProvider, PERSISTENCE_ERROR_CODES } = require('./persistence/contract');
const { createApplicationRepositories } = require('./persistence/application-repositories');
const { canonicalSha256 } = require('./work-rules/receipt');
const { emptyLedger, materialize, applyCommand, project, MAX_BYTES } = require('./security-audit-core');
// The existing reserved privacy prefix excludes this encrypted ledger from all public settings projections.
const KEY = 'privacy_organization_security_audits_v1';
const CONTEXT = Object.freeze({ namespace: 'security-audits', recordId: 'ledger-v1', field: 'ledger', employeeNumber: 'system' });
function error(message, code = 'SECURITY_AUDIT_INTEGRITY', statusCode = 503) { return Object.assign(new Error(message), { code, statusCode }); }
function capabilities(actor) {
  const eligible = actor?.personal === true && ['admin', 'it_admin', 'developer'].includes(actor.role)
    && typeof actor.employeeNumber === 'string' && actor.employeeNumber.trim()
    && !['local', 'system', 'data_subject'].includes(actor.employeeNumber.toLowerCase());
  const read = Boolean(eligible && actor.permissions?.includes('security_audits:read'));
  return { read, manage: Boolean(read && actor.permissions?.includes('security_audits:manage')) };
}
function authorize(actor, write) { const rights = capabilities(actor); if (!rights.read || (write && !rights.manage))
  throw error('Für Security Audits fehlt ein berechtigtes persönliches Konto.', 'SECURITY_AUDIT_ACCESS_DENIED', 403); return rights; }
function createSecurityAuditStore({ provider, protectJson, parseProtectedJson, revalidateActor, now = () => new Date() }) {
  assertPersistenceProvider(provider);
  if ([protectJson, parseProtectedJson, revalidateActor, now].some(callback => typeof callback !== 'function')) throw new TypeError('Security Audits benötigen geschützte Persistenz und erneute Kontoprüfung.');
  async function load(repositories) {
    const rows = (await repositories.planningSettings.listSettings()).filter(row => row.key === KEY);
    if (!rows.length) return emptyLedger();
    try {
      if (rows.length !== 1 || typeof rows[0].value !== 'string' || !rows[0].value.startsWith('enc:v2:')
        || Buffer.byteLength(rows[0].value) > MAX_BYTES * 2) throw new Error('invalid protection');
      const ledger = await parseProtectedJson(rows[0].value, CONTEXT); materialize(ledger); return ledger;
    } catch { throw error('Das geschützte Auditregister konnte nicht sicher gelesen werden.'); }
  }
  async function read(context) {
    return provider.transaction(async executor => {
      const repositories = createApplicationRepositories(executor);
      const actor = await revalidateActor(context, repositories, { action: 'read' });
      const rights = authorize(actor, false);
      return { ...project(await load(repositories), now()), capabilities: rights };
    }, { isolation: 'serializable', readOnly: true });
  }
  async function verifyIntegrity() {
    return provider.transaction(async executor => {
      const ledger = await load(createApplicationRepositories(executor));
      return { revision: ledger.revision, receiptSha256: ledger.headSha256 };
    }, { isolation: 'serializable', readOnly: true });
  }
  async function command(input, context) {
    // HTTP inputs are JSON; capture before awaiting so caller mutation cannot alter a transaction or retry.
    let captured;
    try { const text = JSON.stringify(input); if (!text || Buffer.byteLength(text) > 940 * 1024) throw new Error('size'); captured = JSON.parse(text); }
    catch { throw error('Die Auditaktion ist ungültig oder zu groß.', 'SECURITY_AUDIT_INVALID', 400); }
    for (let attempt = 0; ; attempt++) {
      try {
        return await provider.transaction(async executor => {
          const repositories = createApplicationRepositories(executor);
          const actor = await revalidateActor(context, repositories, captured); const rights = authorize(actor, true);
          const ledger = await load(repositories), instant = new Date(now()).toISOString();
          const next = applyCommand(ledger, captured, actor, instant);
          const encrypted = await protectJson(next, CONTEXT);
          if (typeof encrypted !== 'string' || !encrypted.startsWith('enc:v2:') || Buffer.byteLength(encrypted) > MAX_BYTES * 2)
            throw error('Das Auditregister konnte nicht geschützt gespeichert werden.');
          const write = await repositories.planningSettings.upsertSetting({ key: KEY, value: encrypted });
          const persisted = (await repositories.planningSettings.listSettings()).find(row => row.key === KEY);
          if (write.rowsAffected !== 1 || persisted?.value !== encrypted) throw error('Das Auditregister wurde nicht vollständig gespeichert.');
          const event = next.events.at(-1);
          const audit = await repositories.organizationPersonnel.insertAudit(actor.employeeNumber, 'security-audits.command', 'security_audit',
            `sha256:${canonicalSha256(event.runId)}`, JSON.stringify({ action: event.action, revision: next.revision, receiptSha256: next.headSha256 }));
          if (audit.rowsAffected !== 1 || audit.returnedRows.length !== 1) throw error('Der Auditänderungsbeleg wurde nicht vollständig gespeichert.');
          return { ...project(next, instant), capabilities: rights };
        }, { isolation: 'serializable' });
      } catch (failure) {
        if (provider.getCapabilities().providerId !== 'postgresql' || failure.code !== PERSISTENCE_ERROR_CODES.RETRYABLE_TRANSACTION || attempt >= 3) throw failure;
      }
    }
  }
  return Object.freeze({ read, command, verifyIntegrity });
}
module.exports = { createSecurityAuditStore, capabilities, KEY, CONTEXT };
