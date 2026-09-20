'use strict';

// Technical categories only. Never forward database messages, SQL, credentials,
// filesystem paths or stacks across the worker/recovery diagnostic boundary.
const PHASES = new Set(['worker-load', 'core-database', 'sales-database',
  'database-routing', 'worker-runtime', 'request']);
const STARTUP_PHASES = new Set(['application-data', 'receipt-workers', 'report-worker']);
const CODE_CLASSES = Object.freeze({
  '08000': 'connection', '08001': 'connection', '08003': 'connection',
  '08004': 'connection', '08006': 'connection', '08007': 'connection', '08P01': 'connection',
  '25P03': 'connection', '53300': 'connection-capacity',
  '57P01': 'connection', '57P02': 'connection', '57P03': 'connection',
  '28P01': 'authentication', '28000': 'authentication',
  '57014': 'query-cancelled', '55P03': 'lock-unavailable', '55006': 'lock-unavailable',
  '42501': 'schema-or-permission', '42703': 'schema-or-permission',
  '42704': 'schema-or-permission', '42804': 'schema-or-permission',
  '42830': 'schema-or-permission', '42883': 'schema-or-permission',
  '42P01': 'schema-or-permission', '42P02': 'schema-or-permission',
  '3D000': 'schema-or-permission', '3F000': 'schema-or-permission',
  ECONNREFUSED: 'connection', ECONNRESET: 'connection', EHOSTUNREACH: 'connection',
  ENETUNREACH: 'connection', ENOTFOUND: 'connection', ETIMEDOUT: 'connection-timeout',
  QUERY_TIMEOUT: 'query-timeout', ERR_WORKER_OUT_OF_MEMORY: 'worker-memory',
  MODULE_NOT_FOUND: 'module-load', ERR_MODULE_NOT_FOUND: 'module-load',
  PERSISTENCE_CONNECTION_UNAVAILABLE: 'connection', PERSISTENCE_TIMEOUT: 'database-timeout',
  PERSISTENCE_SCHEMA_INVALID: 'schema-or-permission', PERSISTENCE_CONFIGURATION_INVALID: 'configuration',
  PERSISTENCE_BUSY: 'lock-unavailable',
  IMPORT_REPORT_WORKER_TIMEOUT: 'worker-timeout', IMPORT_REPORT_WORKER_FAILED: 'worker-exit',
});
const MESSAGE_CLASSES = new Map([
  ['Connection terminated due to connection timeout', 'connection-timeout'],
  ['timeout exceeded when trying to connect', 'connection-timeout'],
  ['Query read timeout', 'query-timeout'],
  ['Core base migration drift', 'schema-contract'],
  ['Core boundary migration drift', 'schema-contract'],
  ['Core boundary migration required', 'schema-contract'],
  ['Core development schema contract mismatch', 'schema-contract'],
  ['Sales application schema contract mismatch', 'schema-contract'],
  ['Isolated environment verification failed', 'environment-contract'],
  ['Verified database profile required', 'configuration'],
  ['Invalid development database configuration', 'configuration'],
  ['Development database and role required', 'configuration'],
]);
const CLASSES = new Set([...Object.values(CODE_CLASSES), ...MESSAGE_CLASSES.values(), 'unknown']);

function reportWorkerPhase(value) { return PHASES.has(value) ? value : null; }
function applicationStartupPhase(value) { return STARTUP_PHASES.has(value) ? value : null; }
function classifyReportWorkerError(error, phase = 'worker-load') {
  const originalCode = typeof error?.code === 'string' && Object.hasOwn(CODE_CLASSES, error.code) ? error.code : null;
  const diagnostic = { phase: reportWorkerPhase(phase) || 'worker-load',
    errorClass: originalCode ? CODE_CLASSES[originalCode] : MESSAGE_CLASSES.get(error?.message) || 'unknown' };
  if (originalCode) diagnostic.originalCode = originalCode;
  return Object.freeze(diagnostic);
}
function sanitizeReportWorkerDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !reportWorkerPhase(value.phase) || !CLASSES.has(value.errorClass)) return null;
  const result = { phase: value.phase, errorClass: value.errorClass };
  if (typeof value.originalCode === 'string' && Object.hasOwn(CODE_CLASSES, value.originalCode)
    && CODE_CLASSES[value.originalCode] === value.errorClass) result.originalCode = value.originalCode;
  return Object.freeze(result);
}

module.exports = { reportWorkerPhase, applicationStartupPhase,
  classifyReportWorkerError, sanitizeReportWorkerDiagnostic };
