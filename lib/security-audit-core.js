'use strict';
const { canonicalSha256 } = require('./work-rules/receipt');
const { CATALOG, STANDARD } = require('./security-audit-catalog');
const IDS = new Map(CATALOG.map(row => [row.id, row]));
const CHECK_STATUSES = new Set(['passed', 'failed', 'partial', 'not_tested', 'not_applicable', 'blocked']);
const METHODS = new Set(['code_review', 'automated_test', 'manual_test', 'configuration_review', 'none']);
const FINDING_STATUSES = new Set(['open', 'in_progress', 'mitigated', 'fixed', 'risk_accepted']);
const ZERO = '0'.repeat(64);
const MAX_BYTES = 8 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
function fail(message, code = 'SECURITY_AUDIT_INVALID', statusCode = 400) {
  throw Object.assign(new Error(message), { code, statusCode });
}
function object(value, keys) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => !keys.includes(key))) fail('Der Auditdatensatz enthält unbekannte oder ungültige Felder.');
  return value;
}
function string(value, max = 4000, optional = false) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
    || (!optional && !value.trim())) fail('Ein Audit-Textfeld fehlt oder überschreitet die erlaubte Länge.');
  return value.trim();
}
function ident(value) { const text = string(value, 80); if (!ID.test(text)) fail('Die Auditkennung ist ungültig.'); return text; }
function array(value, max) { if (!Array.isArray(value) || value.length > max) fail('Die Auditliste überschreitet den erlaubten Umfang.'); return value; }
function enumValue(value, allowed) { if (!allowed.has(value)) fail('Ein Auditstatus ist ungültig.'); return value; }
function date(value, optional = false) {
  const result = string(value, 10, optional);
  if (!result && optional) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result))
    || new Date(result).toISOString().slice(0, 10) !== result) fail('Das Auditdatum ist ungültig.');
  return result;
}
function requirement(value) { if (!IDS.has(value)) fail('Die Anforderungskennung gehört nicht zu ASVS 5.0.0.'); return value; }
function unique(values) { if (new Set(values).size !== values.length) fail('Doppelte Auditkennungen sind nicht zulässig.'); return values; }
function evidence(input) {
  object(input, ['kind', 'reference', 'summary']);
  return { kind: string(input.kind, 80), reference: string(input.reference, 500), summary: string(input.summary, 2000) };
}
function check(input) {
  object(input, ['requirementId', 'status', 'method', 'note', 'evidence']);
  const result = { requirementId: requirement(input.requirementId), status: enumValue(input.status, CHECK_STATUSES),
    method: enumValue(input.method, METHODS), note: string(input.note, 6000), evidence: array(input.evidence, 16).map(evidence) };
  if (['passed', 'failed', 'partial'].includes(result.status) && (!result.evidence.length || result.method === 'none'))
    fail('Bewertete Anforderungen benötigen eine Prüfmethode und einen Beleg.');
  return result;
}
function finding(input) {
  object(input, ['id', 'title', 'priority', 'severity', 'status', 'confidence', 'requirementIds', 'description',
    'impact', 'recommendation', 'acceptance', 'owner', 'dueDate', 'note', 'retestEvidence', 'evidence']);
  if (input.status !== 'open') fail('Importierte Erstbefunde müssen offen sein. Spätere Entscheidungen benötigen eine dokumentierte Änderung.');
  return { id: ident(input.id), title: string(input.title, 220), priority: enumValue(input.priority, new Set(['P0', 'P1', 'P2', 'P3'])),
    severity: enumValue(input.severity, new Set(['critical', 'high', 'medium', 'low', 'info'])), status: 'open',
    confidence: enumValue(input.confidence, new Set(['code_review', 'reproduced', 'hypothesis'])),
    requirementIds: unique(array(input.requirementIds, 32).map(requirement)),
    description: string(input.description, 8000), impact: string(input.impact, 6000),
    recommendation: string(input.recommendation, 6000), acceptance: string(input.acceptance, 6000),
    owner: string(input.owner, 160, true), dueDate: date(input.dueDate, true),
    note: string(input.note, 4000, true), retestEvidence: string(input.retestEvidence, 4000, true),
    evidence: array(input.evidence || [], 16).map(evidence) };
}
function normalizeRun(input) {
  object(input, ['id', 'title', 'standardVersion', 'performedAt', 'auditor', 'scope', 'target', 'limitations', 'checks', 'findings']);
  if (input.standardVersion !== STANDARD.version) fail('Bitte einen Bericht für ASVS 5.0.0 importieren.');
  object(input.target, ['commit', 'version', 'environment']);
  if (!/^[a-f0-9]{40}$/.test(input.target.commit)) fail('Der Auditbericht benötigt den vollständigen geprüften Quellcommit.');
  const result = { id: ident(input.id), title: string(input.title, 220), standardVersion: STANDARD.version,
    performedAt: date(input.performedAt), auditor: string(input.auditor, 200), scope: string(input.scope, 8000),
    target: { commit: input.target.commit, version: string(input.target.version, 80),
      environment: enumValue(input.target.environment, new Set(['local', 'test', 'production'])) },
    limitations: array(input.limitations, 32).map(value => string(value, 2000)),
    checks: array(input.checks, CATALOG.length).map(check), findings: array(input.findings, 100).map(finding) };
  unique(result.checks.map(row => row.requirementId)); unique(result.findings.map(row => row.id));
  if (Buffer.byteLength(JSON.stringify(result)) > 900 * 1024) fail('Ein Auditbericht darf höchstens 900 KiB umfassen.', 'SECURITY_AUDIT_LIMIT', 413);
  return result;
}
function normalizeChanges(input, now) {
  object(input, ['status', 'owner', 'dueDate', 'note', 'retestEvidence']);
  const result = { status: enumValue(input.status, FINDING_STATUSES), owner: string(input.owner, 160, true),
    dueDate: date(input.dueDate, true), note: string(input.note, 4000), retestEvidence: string(input.retestEvidence, 4000, true) };
  if (result.status === 'fixed' && !result.retestEvidence) fail('Eine Behebung benötigt einen konkreten Nachprüfbeleg.');
  if (result.status === 'risk_accepted' && (!result.owner || !result.dueDate || result.dueDate <= viennaDay(now)))
    fail('Risikoakzeptanz benötigt eine verantwortliche Person und ein zukünftiges Ablaufdatum.');
  return result;
}
function viennaDay(now) {
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) fail('Der Auditzeitpunkt ist ungültig.');
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const part = type => parts.find(row => row.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function emptyLedger() { return { schemaVersion: 1, revision: 0, headSha256: ZERO, events: [] }; }
function materialize(ledger) {
  object(ledger, ['schemaVersion', 'revision', 'headSha256', 'events']);
  if (ledger.schemaVersion !== 1 || !Number.isSafeInteger(ledger.revision) || ledger.revision < 0
    || !Array.isArray(ledger.events) || ledger.events.length !== ledger.revision || ledger.events.length > 2048
    || Buffer.byteLength(JSON.stringify(ledger)) > MAX_BYTES) fail('Das Auditregister ist beschädigt.', 'SECURITY_AUDIT_INTEGRITY', 503);
  const runs = new Map(); let previous = ZERO;
  for (const [index, event] of ledger.events.entries()) {
    object(event, ['revision', 'action', 'at', 'actor', 'runId', 'findingId', 'payload', 'previousSha256', 'sha256']);
    const { sha256, ...body } = event;
    if (body.revision !== index + 1 || body.previousSha256 !== previous || sha256 !== canonicalSha256(body)
      || typeof body.at !== 'string' || !Number.isFinite(Date.parse(body.at))) fail('Die Audit-Prüfspur ist beschädigt.', 'SECURITY_AUDIT_INTEGRITY', 503);
    object(body.actor, ['employeeNumber', 'role']); string(body.actor.employeeNumber, 160); string(body.actor.role, 40);
    if (body.action === 'import') {
      const source = normalizeRun(body.payload);
      if (runs.has(source.id) || body.runId !== source.id || body.findingId !== '' || runs.size >= 32) fail('Ungültige Auditimport-Historie.', 'SECURITY_AUDIT_INTEGRITY', 503);
      runs.set(source.id, { ...source, contentSha256: canonicalSha256(source), importedAt: body.at, importedBy: body.actor.employeeNumber,
        findings: source.findings.map(row => ({ ...row, history: [] })) });
    } else if (body.action === 'update_finding') {
      const run = runs.get(body.runId), target = run?.findings.find(row => row.id === body.findingId);
      if (!target) fail('Unbekannter Befund in der Audit-Prüfspur.', 'SECURITY_AUDIT_INTEGRITY', 503);
      const changes = normalizeChanges(body.payload, body.at);
      Object.assign(target, changes);
      target.history.push({ ...changes, at: body.at, actor: body.actor.employeeNumber, revision: body.revision });
    } else fail('Unbekannte Auditaktion in der Prüfspur.', 'SECURITY_AUDIT_INTEGRITY', 503);
    previous = sha256;
  }
  if (ledger.headSha256 !== previous) fail('Der Kopfbeleg des Auditregisters stimmt nicht.', 'SECURITY_AUDIT_INTEGRITY', 503);
  return [...runs.values()];
}
function applyCommand(ledger, command, actor, now) {
  const runs = materialize(ledger);
  object(command, ['action', 'expectedRevision', 'run', 'runId', 'findingId', 'changes']);
  if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) fail('Die aktuelle Auditrevision fehlt.');
  if (command.expectedRevision !== ledger.revision) fail('Das Auditregister wurde inzwischen geändert. Bitte neu laden.', 'SECURITY_AUDIT_CONFLICT', 409);
  let payload, runId, findingId = '';
  if (command.action === 'import') {
    payload = normalizeRun(command.run); runId = payload.id;
    if (runs.some(row => row.id === runId)) fail('Diese Auditkennung ist bereits vorhanden.', 'SECURITY_AUDIT_DUPLICATE', 409);
    if (runs.length >= 32) fail('Das Register enthält bereits 32 Auditläufe.', 'SECURITY_AUDIT_LIMIT', 413);
  } else if (command.action === 'update_finding') {
    runId = ident(command.runId); findingId = ident(command.findingId);
    if (!runs.find(row => row.id === runId)?.findings.some(row => row.id === findingId)) fail('Der Befund wurde nicht gefunden.', 'SECURITY_AUDIT_NOT_FOUND', 404);
    payload = normalizeChanges(command.changes, now);
  } else fail('Diese Auditaktion wird nicht unterstützt.');
  const body = { revision: ledger.revision + 1, action: command.action, at: now,
    actor: { employeeNumber: actor.employeeNumber, role: actor.role }, runId, findingId, payload, previousSha256: ledger.headSha256 };
  const event = { ...body, sha256: canonicalSha256(body) };
  const result = { schemaVersion: 1, revision: body.revision, headSha256: event.sha256, events: [...ledger.events, event] };
  materialize(result);
  return result;
}
function summary(run) {
  const checks = new Map(run.checks.map(row => [row.requirementId, row]));
  const profile = CATALOG.filter(row => row.level <= 2 || checks.has(row.id));
  const counts = Object.fromEntries([...CHECK_STATUSES].map(status => [status, 0]));
  for (const requirement of profile) counts[checks.get(requirement.id)?.status || 'not_tested']++;
  return { total: CATALOG.length, inScope: profile.length, assessed: counts.passed + counts.failed,
    passed: counts.passed, failed: counts.failed, partial: counts.partial, notTested: counts.not_tested,
    notApplicable: counts.not_applicable, blocked: counts.blocked };
}
function project(ledger, now = new Date()) {
  const today = viennaDay(now);
  return { revision: ledger.revision, receiptSha256: ledger.headSha256,
    standard: STANDARD, catalog: CATALOG, runs: materialize(ledger).reverse().map(run => ({ ...run, summary: summary(run),
      findings: run.findings.map(row => {
        const riskAcceptanceExpired = row.status === 'risk_accepted' && row.dueDate < today;
        return { ...row, riskAcceptanceExpired, effectiveStatus: riskAcceptanceExpired ? 'risk_acceptance_expired' : row.status,
          overdue: Boolean(row.dueDate && row.dueDate < today && row.status !== 'fixed') };
      }) })) };
}
module.exports = { emptyLedger, materialize, applyCommand, project, normalizeRun, summary, MAX_BYTES };
