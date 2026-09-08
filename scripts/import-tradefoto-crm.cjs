"use strict";

// Explicit, resumable maintenance import of ONE already uploaded KUNDEN run.
// Uses the installed domain writers, encrypted source bindings and CRM audit.
// Does not enable the generic HTTP import or touch other source tables.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const POLICY = 'tradefoto-crm-kund-nr-preserve-invalid-v1';
const LABELS = { firstName: 'Vorname', lastName: 'Nachname', street: 'Straße', addressSupplement: 'Adresszusatz',
  postalCode: 'Postleitzahl', city: 'Ort', country: 'Land', phone: 'Telefon', email: 'E-Mail', vatId: 'UID', birthDate: 'Geburtsdatum' };
const pause = () => new Promise(resolve => setTimeout(resolve, 5));

function createTools(appRequire = createRequire(path.join(__dirname, '..', 'package.json'))) {
  // appRequire resolves relative to the installed package, not this staging dir.
  const fromApp = name => appRequire('./lib/' + name);
  const C = fromApp('data-import-contract');
  const M = fromApp('tradefoto-master-profiles');
  const { normalizeCrmCustomerInput } = fromApp('crm-customers');
  const { CUSTOMER_MAP, createImportMasterService } = fromApp('persistence/repositories/import-master-data');
  const { createCrmCustomersRepository } = fromApp('persistence/repositories/crm-customers');
  const { IMPORT_MASTER_STATEMENTS: S } = fromApp('persistence/statements/import-master-data');
  const { DATA_IMPORT_RUNTIME_STATEMENTS: R } = fromApp('persistence/statements/data-import-runtime');

  function project(source) {
    const accountNumber = String(source.KUND_NR ?? '');
    assert(accountNumber && accountNumber.trim() === accountNumber, 'CRM_SOURCE_ACCOUNT_REQUIRED');
    if (accountNumber === '0') return null;
    normalizeCrmCustomerInput({ accountNumber });
    const input = { accountNumber }, corrections = {}, reviewFields = [];
    for (const [sourceField, field] of Object.entries(CUSTOMER_MAP)) {
      if (field === 'accountNumber') continue;
      let actualSourceField = sourceField;
      let value = source[sourceField] == null ? '' : String(source[sourceField]);
      if (field === 'phone' && !value && source.Handy) { value = String(source.Handy); actualSourceField = 'Handy'; }
      if (field === 'birthDate') value = value ? value.slice(0, 10) : null;
      input[field] = value;
      try { normalizeCrmCustomerInput({ accountNumber, [field]: value }); }
      catch (error) {
        if (error.name !== 'CrmValidationError') throw error;
        corrections[field] = field === 'birthDate' ? null : '';
        input[field] = corrections[field];
        // Control characters are shown as escapes; the encrypted original is
        // unchanged. These values must not become actionable email/UID fields.
        const original = String(source[actualSourceField] ?? value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
          char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
        reviewFields.push({ id: null, title: `TradeFoto – ${LABELS[field]} prüfen`,
          value: `Ungeprüfter Originalwert (${actualSourceField}):\n${original}\n\nDas reguläre Feld bleibt bis zur Prüfung leer.`, sortOrder: reviewFields.length });
      }
    }
    const normalized = normalizeCrmCustomerInput({ ...input, customFields: reviewFields });
    return { accountNumber, decision: { customerType: 'unknown', corrections }, reviewFields,
      normalized, nameless: !normalized.firstName && !normalized.lastName && !normalized.companyName };
  }

  function context({ access, protection, sourceId, expectedSourceSha256, ownerId, scopeId = 'grabenplaner-main' }) {
    C.sha(sourceId); C.sha(expectedSourceSha256); C.id(ownerId); C.id(scopeId);
    const actor = { scopeId, ownerId }, profile = M.profileFor('KUNDEN');
    const engine = fromApp('data-import-engine').createDataImportEngine({
      repository: fromApp('persistence/repositories/data-import').createDataImportRepository(access),
      protection, profiles: [profile], writers: fromApp('persistence/repositories/import-master-data').createImportMasterWriters({ protection }),
      getActor: () => actor,
      authorize: request => request.scopeId === scopeId && request.ownerId === ownerId
        && ['read', 'read_sensitive', 'apply'].includes(request.action)
        && request.dataClasses.every(value => profile.dataClasses.includes(value)),
    });
    const master = createImportMasterService({ access, protection, getActor: () => actor, sourceInstance: 'tradefoto-trade',
      authorize: request => request.scopeId === scopeId && request.ownerId === ownerId
        && ['master.read', 'customer.sync'].includes(request.action)
        && request.dataClasses.every(value => value === 'customer_restricted')
        && (!request.targetKind || request.targetKind === 'crm_customer') });
    const crm = createCrmCustomersRepository(access);
    const sourceContext = row => ['source', row.scopeId, row.ownerId, row.id, row.revision];
    async function source() {
      const row = await access.queryOne(R.source, { id: sourceId, ...actor });
      assert(row, 'CRM_SOURCE_NOT_FOUND');
      const data = protection.open(row.payload, sourceContext(row));
      assert.equal(data.kind, 'trade'); assert.equal(data.fileSha256, expectedSourceSha256);
      assert.equal(row.id, protection.digest(['source', actor, data.kind, data.fileSha256]));
      assert.equal(data.complete, true); assert.equal(data.status, 'ready');
      const table = data.tables.filter(table => table.name === 'KUNDEN');
      assert.equal(table.length, 1); assert.equal(table[0].profileHash, profile.fingerprint);
      return { row, data, table: table[0] };
    }
    return { access, protection, actor, profile, engine, master, crm, source, sourceContext };
  }

  async function plan(options, progress = () => {}) {
    const ctx = context(options), source = await ctx.source(), run = await ctx.engine.checkpoint(source.table.run.id);
    assert(['ready', 'applying', 'applied'].includes(run.status), 'CRM_SOURCE_NOT_READY');
    assert.deepEqual(run.gates, []); assert.equal(run.expectedRows, run.receivedRows);
    assert.equal(run.expectedRows, source.table.declaredRows);
    const items = [], seen = new Set(), fingerprints = [];
    const summary = { policy: POLICY, sourceId: options.sourceId, sourceSha256: options.expectedSourceSha256,
      runId: run.id, sourceRows: run.expectedRows, customerCards: 0, unassignedZero: 0, nameless: 0, reviewCustomers: 0, reviewFields: {} };
    for (let n = 1; n <= run.expectedRows; n++) {
      const row = await ctx.engine.detail(run.id, n);
      assert(['create', 'applied'].includes(row.state), 'CRM_SOURCE_ROW_NOT_READY');
      assert.equal(row.issue, '');
      const key = String(row.source.KUND_NR ?? '');
      assert(!seen.has(key), 'CRM_DUPLICATE_SOURCE_ACCOUNT'); seen.add(key);
      fingerprints.push(ctx.protection.digest(['crm-source-row', n, row.source]));
      const item = project(row.source);
      if (!item) summary.unassignedZero++;
      else {
        items.push(item); summary.customerCards++;
        if (item.nameless) summary.nameless++;
        if (item.reviewFields.length) summary.reviewCustomers++;
        for (const field of Object.keys(item.decision.corrections)) summary.reviewFields[field] = (summary.reviewFields[field] || 0) + 1;
      }
      if (n % 2000 === 0) { progress({ phase: 'plan', checked: n, total: run.expectedRows }); await pause(); }
    }
    assert.equal(summary.unassignedZero, 1, 'CRM_UNASSIGNED_ZERO_COUNT_CHANGED');
    const sourceFingerprint = ctx.protection.digest(fingerprints);
    const planHash = ctx.protection.digest([POLICY, ctx.actor, summary, sourceFingerprint,
      items.map(item => [item.accountNumber, item.decision, item.normalized])]);
    return { ctx, run, items, summary: { ...summary, sourceFingerprint, planHash } };
  }

  async function preserveReviewFields(ctx, targetId, item) {
    if (!item.reviewFields.length) return false;
    const before = await ctx.crm.get(targetId); assert(before, 'CRM_TARGET_MISSING');
    const missing = item.reviewFields.filter(field => !before.customFields.some(existing => existing.title === field.title && existing.value === field.value));
    if (!missing.length) return false;
    // A retry may find a user-edited review note; retain it rather than replace it.
    for (const field of missing) assert(!before.customFields.some(existing => existing.title === field.title), 'CRM_REVIEW_NOTE_MANUALLY_CHANGED');
    await ctx.crm.update({ id: targetId, expectedRevision: before.revision, actor: ctx.actor.ownerId, timestamp: new Date().toISOString(),
      customer: { customFields: [...before.customFields, ...missing].map((field, index) => ({ ...field, sortOrder: index })) } });
    return true;
  }

  async function apply(prepared, confirmation, progress = () => {}) {
    const { ctx, summary, items } = prepared;
    assert.equal(confirmation, summary.planHash, 'CRM_PLAN_CONFIRMATION_MISMATCH');
    let run = await ctx.engine.checkpoint(summary.runId);
    let batches = 0;
    while (run.status !== 'applied') {
      run = await ctx.engine.apply(run.id, run.revision);
      if (++batches % 5 === 0 || run.status === 'applied') progress({ phase: 'source-apply', applied: run.counts.applied || 0, total: summary.sourceRows });
      await pause();
    }
    // Keep the existing upload overview in sync with the actual run, preserving
    // all other table summaries and the source's overall staged status.
    const source = await ctx.source(); source.table.run = { ...run, canApply: false };
    const updated = { ...source.row, revision: source.row.revision + 1 };
    assert.equal((await ctx.access.execute(R.updateSource, { id: source.row.id, ...ctx.actor, revision: source.row.revision,
      updatedAt: new Date().toISOString(), payload: ctx.protection.seal(source.data, ctx.sourceContext(updated)) })).rowsAffected, 1);
    const result = { created: 0, alreadyLinked: 0, reviewNotesAdded: 0 };
    for (const [index, item] of items.entries()) {
      const record = await ctx.access.queryOne(S.find, { scopeId: ctx.actor.scopeId,
        identityHash: M.masterIdentity(ctx.protection, { ...ctx.actor, sourceInstance: 'tradefoto-trade' }, 'KUNDEN', [item.accountNumber]) });
      assert(record && record.revision === 1, 'CRM_SOURCE_REVISION_CHANGED');
      const binding = await ctx.access.queryOne(S.getBinding, { recordId: record.id });
      let targetId;
      if (binding) {
        const input = { recordId: record.id, expectedSourceRevision: record.revision };
        const checked = await ctx.master.previewCustomer(input); // Authenticates existing binding and its baseline.
        assert.equal(checked.action, 'sync'); assert.equal(binding.sourceRevision, record.revision);
        targetId = checked.targetId;
        assert.equal((await ctx.crm.get(targetId)).accountNumber, item.accountNumber);
        result.alreadyLinked++;
      } else {
        const input = { recordId: record.id, expectedSourceRevision: record.revision, decision: item.decision };
        const preview = await ctx.master.previewCustomer(input); assert.equal(preview.action, 'create');
        const applied = await ctx.master.syncCustomer(input, preview.planHash);
        targetId = applied.targetId; result.created++;
      }
      if (await preserveReviewFields(ctx, targetId, item)) result.reviewNotesAdded++;
      if ((index + 1) % 500 === 0 || index + 1 === items.length) {
        progress({ phase: 'crm-apply', processed: index + 1, total: items.length, ...result }); await pause();
      }
    }
    return result;
  }

  async function verify(prepared, progress = () => {}) {
    const { ctx, items } = prepared;
    let linked = 0, reviewCustomers = 0, nameless = 0;
    for (const [index, item] of items.entries()) {
      const record = await ctx.access.queryOne(S.find, { scopeId: ctx.actor.scopeId,
        identityHash: M.masterIdentity(ctx.protection, { ...ctx.actor, sourceInstance: 'tradefoto-trade' }, 'KUNDEN', [item.accountNumber]) });
      assert(record, 'CRM_SOURCE_MISSING');
      const preview = await ctx.master.previewCustomer({ recordId: record.id, expectedSourceRevision: record.revision });
      assert.equal(preview.action, 'sync');
      const customer = await ctx.crm.get(preview.targetId); assert.equal(customer.accountNumber, item.accountNumber);
      for (const [key, value] of Object.entries(item.normalized)) {
        if (key === 'customFields') continue;
        assert.deepEqual(customer[key], value, 'CRM_IMPORTED_FIELD_MISMATCH:' + key);
      }
      for (const field of item.reviewFields) assert(customer.customFields.some(existing => existing.title === field.title && existing.value === field.value), 'CRM_REVIEW_NOTE_MISSING');
      if (item.reviewFields.length) reviewCustomers++;
      if (!customer.firstName && !customer.lastName && !customer.companyName) nameless++;
      linked++;
      if ((index + 1) % 5000 === 0) { progress({ phase: 'verify', checked: index + 1, total: items.length }); await pause(); }
    }
    const zero = await ctx.access.queryOne(S.crmFind, { number: '0' }); assert.equal(zero, null);
    return { verifiedCustomerCards: linked, reviewCustomers, nameless, zeroCustomerCreated: false };
  }
  return { project, plan, apply, verify };
}

async function main() {
  const options = {};
  for (let n = 2; n < process.argv.length; n += 2) {
    assert(/^--[a-z][a-z0-9-]*$/.test(process.argv[n]) && process.argv[n + 1], 'CRM_ARGUMENT_INVALID');
    const key = process.argv[n].slice(2); assert(!Object.hasOwn(options, key)); options[key] = process.argv[n + 1];
  }
  assert(Object.keys(options).every(key => ['app-root', 'database', 'source-id', 'source-sha256', 'owner', 'mode', 'confirm-plan', 'report'].includes(key)));
  assert(['plan', 'apply', 'verify'].includes(options.mode));
  const appRoot = path.resolve(options['app-root'] || path.join(__dirname, '..'));
  const appRequire = createRequire(path.join(appRoot, 'package.json'));
  assert(options.database && fs.statSync(options.database).isFile(), 'CRM_DATABASE_REQUIRED');
  const { openSqliteLegacyDatabase, createSqlitePersistenceProvider } = appRequire('./lib/persistence/sqlite/provider');
  const database = openSqliteLegacyDatabase(options.database);
  const access = createSqlitePersistenceProvider({ database, catalog: appRequire('./lib/persistence/sqlite/application-catalog').SQLITE_APPLICATION_CATALOG,
    initializeConnection: false });
  // Existing database connection settings only; do not run app startup/migrations.
  database.exec('PRAGMA foreign_keys = ON'); database.exec('PRAGMA busy_timeout = 5000');
  const keyId = process.env.GRABENPLANER_INTEGRATION_KEY_ID;
  const keys = JSON.parse(process.env.GRABENPLANER_INTEGRATION_KEYS || '{}');
  if (process.env.GRABENPLANER_INTEGRATION_KEY) keys[keyId] = process.env.GRABENPLANER_INTEGRATION_KEY;
  const vault = appRequire('./lib/integration-secret-vault').createIntegrationSecretVault({ activeKeyId: keyId, keys });
  let protection;
  const startedAt = new Date().toISOString(), progress = event => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
  try {
    protection = await appRequire('./lib/data-import-managed-protection').loadManagedDataImportProtection({ access, vault, create: false });
    assert(protection, 'CRM_EXISTING_IMPORT_KEY_REQUIRED');
    const tools = createTools(appRequire);
    const prepared = await tools.plan({ access, protection, sourceId: options['source-id'], expectedSourceSha256: options['source-sha256'], ownerId: options.owner }, progress);
    const report = { startedAt, mode: options.mode, installedVersion: appRequire('./package.json').version,
      scriptSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'), ...prepared.summary };
    progress({ phase: 'plan-complete', ...report });
    if (options.mode === 'apply') report.applied = await tools.apply(prepared, options['confirm-plan'], progress);
    if (options.mode !== 'plan') report.verification = await tools.verify(prepared, progress);
    report.finishedAt = new Date().toISOString();
    if (options.report) fs.writeFileSync(options.report, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    progress({ phase: 'complete', ...report });
  } finally { protection?.destroy(); await access.close(); database.close(); }
}
module.exports = { createTools, POLICY };
if (require.main === module) main().catch(error => {
  // Never print source values, assertion operands, environment or secret bytes.
  console.error(JSON.stringify({ phase: 'failed', code: error.code || error.name, message: /^CRM_[A-Z_]+(?::[A-Za-z]+)?$/.test(error.message) ? error.message : 'CRM_IMPORT_FAILED' }));
  process.exitCode = 1;
});
