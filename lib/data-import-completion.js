'use strict';

const { SOURCE_CATALOG } = require('./data-import-source-catalog');
const { summarize } = require('../public/data-import-progress');

function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function recordPhase(source, phase, startedAt, finishedAt = null) {
  source.reportPhases ??= {};
  const saved = source.reportPhases[phase];
  if (!saved?.finishedAt) {
    source.reportPhases[phase] = { startedAt: saved?.startedAt || startedAt, finishedAt };
  }
}

function completed(source) {
  return source?.complete === true && source.status === 'applied' && !source.retirement && !source.catalogUpdatePending;
}

function completionAt(source) {
  if (!completed(source)) return null;
  return timestamp(source.reportPhases?.apply?.finishedAt)
    || (source.progress?.operation === 'apply' ? timestamp(source.progress.finishedAt) : null);
}

function elapsed(phase) {
  const start = timestamp(phase?.startedAt), end = timestamp(phase?.finishedAt);
  if (!start || !end) return null;
  const result = Date.parse(end) - Date.parse(start);
  return result >= 0 ? result : null;
}

function measurements(source, cash) {
  const phase = (key, fallback) => elapsed(source.reportPhases?.[key] ?? fallback);
  return {
    read: phase('read', { startedAt: source.readStartedAt, finishedAt: source.readCompletedAt }),
    review: phase('review', source.progress?.operation === 'review' ? source.progress : null),
    apply: cash ? elapsed(cash) : phase('apply', source.progress?.operation === 'apply' ? source.progress : null),
  };
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function tableRow(table, cash) {
  const received = count(table.run?.receivedRows);
  const checked = cash ? count(table.run?.verifiedRows) : Math.max(0, received - count(table.run?.counts?.staged));
  return { name: table.name, declared: count(table.declaredRows), received, checked,
    confirmed: cash ? checked : summarize({ tables: [table] }).confirmed };
}

function buildCompletion(source, previous, cash, previousCash) {
  const finishedAt = cash ? timestamp(cash.finishedAt) : completionAt(source);
  const definition = SOURCE_CATALOG.find(entry => entry.kind === source.kind && entry.available);
  if (!(cash ? finishedAt : completed(source)) || !source.complete || !definition) return null;
  const tables = (source.tables || []).map(table => tableRow(table, cash));
  const totals = summarize(source);
  const previousAt = previous && (previousCash ? timestamp(previousCash.finishedAt) : completionAt(previous));
  return {
    kind: source.kind, label: definition.fileName, fileName: source.fileName, finishedAt,
    uploadedAt: timestamp(source.createdAt), contentDate: source.contentDate?.status === 'complete' ? source.contentDate.value || null : null,
    cashActive: cash ? cash.active : null, tables,
    counts: { received: totals.received, checked: tables.reduce((sum, table) => sum + table.checked, 0),
      confirmed: tables.reduce((sum, table) => sum + table.confirmed, 0), invalid: totals.invalid, conflict: totals.conflict,
      deferredTables: totals.deferredTables, deferredRows: totals.deferredRows },
    durations: measurements(source, cash),
    previous: previousAt ? { fileName: previous.fileName, finishedAt: previousAt,
      received: summarize(previous).received, durations: measurements(previous, previousCash) } : null,
  };
}

module.exports = { recordPhase, completionAt, buildCompletion };
