'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { CATALOG, STANDARD } = require('../lib/security-audit-catalog');
const { emptyLedger, applyCommand, project, materialize, normalizeRun } = require('../lib/security-audit-core');
const { syntheticRun } = require('../test-support/security-audit-fixture');
const actor = { employeeNumber: 'synthetic-admin', role: 'admin' }, at = '2026-10-18T12:00:00.000Z';
function imported() { return applyCommand(emptyLedger(), { action: 'import', expectedRevision: 0, run: syntheticRun() }, actor, at); }
function update(ledger, changes) { return applyCommand(ledger, { action: 'update_finding', expectedRevision: ledger.revision,
  runId: 'synthetic-audit-001', findingId: 'SYN-001', changes }, actor, at); }
test('pinned official catalogue has all 345 distinct requirements, 253 in L1/L2 and unchanged asset bytes', () => {
  assert.equal(CATALOG.length, 345); assert.equal(new Set(CATALOG.map(row => row.id)).size, 345);
  assert.equal(CATALOG.filter(row => row.level <= 2).length, 253);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../lib/security-audits/asvs-5.0.0.json'))).digest('hex'), STANDARD.catalogSha256);
});
test('empty register is empty, read projection does not fabricate pass results or audit records', () => {
  const ledger = emptyLedger(), before = JSON.stringify(ledger), p = project(ledger);
  assert.equal(p.runs.length, 0); assert.equal(p.catalog.length, 345); assert.equal(JSON.stringify(ledger), before);
});
test('coverage uses full target profile and preserves untested and partially reviewed requirements', () => {
  const p = project(imported()).runs[0];
  assert.equal(p.summary.inScope, 253); assert.equal(p.summary.failed, 1); assert.equal(p.summary.partial, 1);
  assert.equal(p.summary.assessed, 1); assert.equal(p.summary.notTested, 251); assert.equal(p.summary.passed, 0);
});
test('explicit L3 evidence extends profile without marking other L3 reviewed', () => {
  const run = syntheticRun(), req = CATALOG.find(row => row.level === 3);
  run.checks.push({ requirementId: req.id, status: 'blocked', method: 'none', note: 'Needs live evidence', evidence: [] });
  const p = project(applyCommand(emptyLedger(), { action: 'import', expectedRevision: 0, run }, actor, at)).runs[0];
  assert.equal(p.summary.inScope, 254); assert.equal(p.summary.blocked, 1); assert.equal(p.summary.assessed, 1);
});
test('wrong standard, unknown IDs, duplicate checks and unsubstantiated pass fail closed', () => {
  for (const mutate of [r => r.standardVersion = '4.0.3', r => r.checks[0].requirementId = 'v5.0.0-999.1.1',
    r => r.checks.push(r.checks[0]), r => { r.checks[0].status = 'passed'; r.checks[0].evidence = []; },
    r => r.target.commit = 'short', r => r.performedAt = '2026-02-31', r => r.extra = true,
    r => r.findings[0].status = 'fixed']) {
    const run = syntheticRun(); mutate(run); assert.throws(() => normalizeRun(run), e => e.code === 'SECURITY_AUDIT_INVALID');
  }
});
test('duplicate imports and stale writes never overwrite an existing audit', () => {
  const ledger = imported(), before = JSON.stringify(ledger);
  assert.throws(() => applyCommand(ledger, { action: 'import', expectedRevision: 0, run: syntheticRun() }, actor, at), e => e.statusCode === 409);
  assert.throws(() => applyCommand(ledger, { action: 'import', expectedRevision: 1, run: syntheticRun() }, actor, at), e => e.code === 'SECURITY_AUDIT_DUPLICATE');
  assert.equal(JSON.stringify(ledger), before);
});
test('finding changes append history without rewriting the source report or assessment', () => {
  const ledger = imported(), original = JSON.stringify(ledger), sourceSha = project(ledger).runs[0].contentSha256;
  const next = update(ledger, { status: 'in_progress', owner: 'Synthetic owner', dueDate: '2026-11-18', note: 'Synthetic work note', retestEvidence: '' });
  const run = project(next).runs[0]; assert.equal(run.contentSha256, sourceSha); assert.equal(run.findings[0].history.length, 1);
  assert.equal(run.findings[0].status, 'in_progress'); assert.equal(run.summary.failed, 1); assert.equal(JSON.stringify(ledger), original);
});
test('closing needs retest evidence; accepted risk needs owner, reason and future expiry', () => {
  const base = { status: 'fixed', note: 'Synthetic decision', owner: '', dueDate: '', retestEvidence: '' };
  assert.throws(() => update(imported(), base));
  const fixed = project(update(imported(), { ...base, retestEvidence: 'Synthetic retest / build b / date 2026-10-18' })).runs[0];
  assert.equal(fixed.findings[0].status, 'fixed'); assert.equal(fixed.summary.failed, 1);
  assert.throws(() => update(imported(), { ...base, status: 'risk_accepted', owner: 'Synthetic owner', dueDate: '2026-10-17' }));
  assert.throws(() => update(imported(), { ...base, status: 'risk_accepted', dueDate: '2026-12-01' }));
  assert.equal(project(update(imported(), { ...base, status: 'risk_accepted', owner: 'Synthetic owner', dueDate: '2026-12-01' })).runs[0].findings[0].status, 'risk_accepted');
});
test('tampering with payload, revision, chain or head is rejected', () => {
  for (const mutate of [l => l.events[0].payload.title = 'altered', l => l.events[0].revision++,
    l => l.events[0].previousSha256 = 'f'.repeat(64), l => l.headSha256 = 'f'.repeat(64), l => l.revision++]) {
    const ledger = imported(); mutate(ledger); assert.throws(() => materialize(ledger));
  }
});
test('risk acceptance expires after its Vienna calendar day without rewriting history', () => {
  const accepted = update(imported(), { status: 'risk_accepted', owner: 'Synthetic owner', dueDate: '2026-10-20', note: 'Temporary decision', retestEvidence: '' });
  const original = JSON.stringify(accepted);
  for (const instant of ['2026-10-19T12:00:00Z', '2026-10-20T21:59:59Z']) {
    const row = project(accepted, instant).runs[0].findings[0];
    assert.equal(row.effectiveStatus, 'risk_accepted'); assert.equal(row.riskAcceptanceExpired, false);
  }
  const row = project(accepted, '2026-10-20T22:00:00Z').runs[0].findings[0];
  assert.equal(row.effectiveStatus, 'risk_acceptance_expired'); assert.equal(row.riskAcceptanceExpired, true); assert.equal(row.overdue, true);
  assert.equal(row.status, 'risk_accepted'); assert.equal(row.history[0].status, 'risk_accepted'); assert.equal(JSON.stringify(accepted), original);
});
test('new risk acceptance expiry must be future relative to Vienna rather than UTC date', () => {
  assert.throws(() => applyCommand(imported(), { action: 'update_finding', expectedRevision: 1,
    runId: 'synthetic-audit-001', findingId: 'SYN-001', changes: { status: 'risk_accepted', owner: 'Synthetic owner', dueDate: '2026-10-21', note: 'Decision', retestEvidence: '' } }, actor, '2026-10-20T22:00:00Z'));
});
test('prototype keys and oversized free text cannot enter a report', () => {
  const run = syntheticRun(); run.scope = 'a'.repeat(8001); assert.throws(() => normalizeRun(run));
  const unknown = JSON.parse(JSON.stringify(syntheticRun()).replace('"title":', '"__proto__":{"polluted":true},"title":'));
  assert.throws(() => normalizeRun(unknown)); assert.equal({}.polluted, undefined);
});
test('finding evidence is retained and validated separately from requirement evidence', () => {
  const run = syntheticRun(); run.findings[0].evidence = [{ kind: 'source', reference: 'synthetic.js:12', summary: 'Synthetic finding evidence' }];
  assert.deepEqual(normalizeRun(run).findings[0].evidence, run.findings[0].evidence);
  run.findings[0].evidence[0].unsafe = 'unknown'; assert.throws(() => normalizeRun(run));
});
