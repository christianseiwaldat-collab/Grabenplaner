'use strict';
const C = require('./data-import-contract'), Simulation = require('./sales-bwl-simulation-model');
const WRITE_PERMISSION = 'sales:bwl:actions:write';
const PERMISSION_CATALOG = Object.freeze([Object.freeze({ id: WRITE_PERMISSION, label: 'Filialmaßnahmen in BWL-Werkzeugen verwalten',
  description: 'Filialmaßnahmen ausdrücklich anlegen, zuweisen, bearbeiten, abschließen und verwerfen. Benötigt Artikel- und Bestandsleserechte sowie einen vollständigen Filialzugang. Führt keine Bestellung, Umlagerung oder Preisänderung aus.',
  group: 'Verkaufsverwaltung', warningLevel: 'high', scopeBehavior: 'organizational', eligibleRoles: Object.freeze(['manager', 'department_manager', 'admin', 'developer']) })]);
const LIMITS = Object.freeze({ perLocation: 500, page: 200, note: 2000, title: 120, maxDays: 365 });
const STATUSES = Object.freeze([{ id: 'open', label: 'Offen' }, { id: 'in_progress', label: 'In Bearbeitung' }, { id: 'done', label: 'Erledigt' }, { id: 'discarded', label: 'Verworfen' }].map(Object.freeze));
const PRIORITIES = Object.freeze([{ id: 'low', label: 'Niedrig' }, { id: 'normal', label: 'Normal' }, { id: 'high', label: 'Hoch' }].map(Object.freeze));
const COLUMNS = Object.freeze([
  ['title', 'Maßnahme', 300], ['articleNumber', 'Artikelnummer', 140], ['priority', 'Priorität', 100], ['status', 'Status', 130], ['dueDate', 'Fällig am', 130],
  ['assigneeNumber', 'Verantwortliche Person', 190], ['source', 'Quellenhinweis', 250], ['note', 'Notiz / Ergebnis', 300], ['updatedAt', 'Zuletzt geändert', 160],
].map(([id, label, width]) => Object.freeze({ id, label, width, type: id === 'dueDate' || id === 'updatedAt' ? 'date' : 'text' })));
const DEFAULT_COLUMNS = Object.freeze(['title', 'articleNumber', 'priority', 'status', 'dueDate', 'assigneeNumber', 'source']);
function authority(session) {
  const base = Simulation.authority(session), scopes = session.scopes || [], full = scopes.filter(s => Number(s.departmentId ?? s.department_id ?? 0) === 0)
    .map(s => String(s.locationId ?? s.location_id ?? '')).filter(Boolean);
  // Company analytics are readable by manager/admin/developer in the existing
  // catalog. Team actions additionally honor explicit organizational scopes.
  // An AL's partial department never becomes a company-wide team grant.
  const company = base.stock.company && (['admin', 'developer'].includes(session.role) || session.role === 'manager' && scopes.length === 0);
  const locationIds = company ? [] : [...new Set(full.filter(id => base.stock.company || base.stock.locationIds.includes(id)))].sort();
  if (!company && !locationIds.length) C.fail('BWL_ACTIONS_FORBIDDEN', 403);
  const write = base.caps.read && session.permissions.includes(WRITE_PERMISSION) && PERMISSION_CATALOG[0].eligibleRoles.includes(session.role);
  const caps = { ...base.caps, write };
  return Object.freeze({ identity: C.canonical([base.identity, company, locationIds, caps]), ownerId: base.ownerId, accountId: base.accountId, caps, company, locationIds });
}
function assertLocation(auth, value, { write = false } = {}) {
  const id = C.id(value); if (id.startsWith('trade-source:') || !auth.caps.read || write && !auth.caps.write || !auth.company && !auth.locationIds.includes(id)) C.fail('BWL_ACTIONS_FORBIDDEN', 403); return id;
}
function uuid(value) { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) C.fail('BWL_ACTIONS_INVALID'); return value.toLowerCase(); }
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function text(value, max, { nullable = false, multiline = false } = {}) {
  if (nullable && (value === null || value === '')) return null;
  if (typeof value !== 'string' || value.length > max || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value)) C.fail('BWL_ACTIONS_INVALID');
  const result = value.trim(); if (!result && !nullable) C.fail('BWL_ACTIONS_INVALID'); return result || null;
}
function date(value, { reference = today(), past = false } = {}) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value
    || !past && value < reference || (Date.parse(value) - Date.parse(reference)) / 86400000 > LIMITS.maxDays) C.fail('BWL_ACTIONS_DATE_INVALID'); return value;
}
function normalizeSource(input) {
  if (input === null || input === undefined) return null;
  if (!C.plain(input)) C.fail('BWL_ACTIONS_SOURCE_INVALID');
  if (input.kind === 'inventory') { C.exact(input, ['kind', 'rowId', 'sourceFingerprint']); return { kind: 'inventory', rowId: C.text(input.rowId, 1024), sourceFingerprint: C.sha(input.sourceFingerprint) }; }
  if (input.kind === 'abc') { C.exact(input, ['kind', 'rowId', 'exportToken']); return { kind: 'abc', rowId: C.text(input.rowId, 1024), exportToken: C.text(input.exportToken, 16384) }; }
  C.fail('BWL_ACTIONS_SOURCE_INVALID');
}
function validateSourceRecord(input) {
  C.exact(input, ['kind', 'rowId', 'articleNumber', 'label', 'sourceFingerprint', 'sourceAt', 'reason', 'type']);
  if (!['inventory', 'abc'].includes(input.kind)) C.fail('BWL_ACTIONS_SOURCE_INVALID');
  const record = { kind: input.kind, rowId: C.text(input.rowId, 1024), articleNumber: C.text(input.articleNumber, 120), label: text(input.label, 1000, { nullable: true }),
    sourceFingerprint: C.sha(input.sourceFingerprint), sourceAt: C.utc(input.sourceAt), reason: text(input.reason, 500) };
  if (input.type !== undefined) record.type = text(input.type, 80); return record;
}
function normalizeCreate(input, options = {}) {
  C.exact(input, ['id', 'locationId', 'title', 'articleNumber', 'priority', 'dueDate', 'assigneeNumber', 'note', 'sourceHint']);
  const result = { id: uuid(input.id), locationId: C.id(input.locationId), title: text(input.title, LIMITS.title), articleNumber: input.articleNumber == null || input.articleNumber === '' ? null : C.text(input.articleNumber, 120),
    priority: input.priority ?? 'normal', dueDate: input.dueDate === undefined ? null : date(input.dueDate, { reference: options.today || today() }),
    assigneeNumber: input.assigneeNumber === undefined ? null : text(input.assigneeNumber, 120, { nullable: true }), note: input.note === undefined ? null : text(input.note, LIMITS.note, { nullable: true, multiline: true }),
    sourceHint: normalizeSource(input.sourceHint) };
  if (!PRIORITIES.some(p => p.id === result.priority)) C.fail('BWL_ACTIONS_INVALID'); return result;
}
function normalizeUpdate(input, options = {}) {
  C.exact(input, ['version', 'title', 'priority', 'status', 'dueDate', 'assigneeNumber', 'note']);
  const result = { version: C.integer(input.version, 1, Number.MAX_SAFE_INTEGER - 1) };
  if (Object.keys(input).length < 2) C.fail('BWL_ACTIONS_INVALID');
  for (const id of ['title', 'priority', 'status', 'dueDate', 'assigneeNumber', 'note']) if (Object.hasOwn(input, id)) {
    if (id === 'title') result[id] = text(input[id], LIMITS.title);
    else if (id === 'priority' || id === 'status') { if (!(id === 'priority' ? PRIORITIES : STATUSES).some(v => v.id === input[id])) C.fail('BWL_ACTIONS_INVALID'); result[id] = input[id]; }
    else if (id === 'dueDate') result[id] = date(input[id], { reference: options.today || today(), past: true });
    else result[id] = text(input[id], id === 'note' ? LIMITS.note : 120, { nullable: true, multiline: id === 'note' });
  } return result;
}
function transition(prior, input) {
  const status = input.status ?? prior.status, closing = ['done', 'discarded'].includes(status), wasClosed = ['done', 'discarded'].includes(prior.status);
  if (status !== prior.status && (closing || wasClosed) && (!input.note || input.note === prior.note)) C.fail('BWL_ACTIONS_RESULT_REQUIRED');
  const result = {}; for (const id of ['title', 'priority', 'status', 'dueDate', 'assigneeNumber', 'note']) if (Object.hasOwn(input, id)) result[id] = input[id];
  if (status !== prior.status) result.completedAt = closing ? new Date().toISOString() : null;
  return result;
}
function normalizeQuery(input) {
  C.exact(input, ['locationId', 'status', 'query', 'sort', 'direction', 'limit', 'offset']);
  const status = input.status ?? 'all', sort = input.sort ?? 'updatedAt', direction = input.direction ?? 'desc';
  if (status !== 'all' && !STATUSES.some(s => s.id === status) || !COLUMNS.some(c => c.id === sort) || !['asc', 'desc'].includes(direction)) C.fail('BWL_ACTIONS_INVALID');
  const integer = (value, fallback, min, max) => C.integer(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value ?? fallback, min, max);
  return { locationId: C.id(input.locationId), status, query: input.query === undefined || input.query === '' ? '' : text(input.query, 150), sort, direction,
    limit: integer(input.limit, 50, 1, LIMITS.page), offset: integer(input.offset, 0, 0, LIMITS.perLocation) };
}
function normalizePreferences(value, caps, { reduce = false } = {}) {
  C.exact(value, ['columns', 'columnWidths', 'sort', 'direction']);
  if (!caps?.read) C.fail('BWL_ACTIONS_FORBIDDEN', 403);
  const known = COLUMNS.map(column => column.id), columns = value.columns ?? [...DEFAULT_COLUMNS], widths = value.columnWidths ?? {}, sort = value.sort ?? 'updatedAt', direction = value.direction ?? 'desc';
  if (!Array.isArray(columns) || !columns.length || columns.length > known.length || new Set(columns).size !== columns.length || columns.some(id => !known.includes(id))
    || !C.plain(widths) || Object.entries(widths).some(([id, width]) => !known.includes(id) || !Number.isInteger(width) || width < 80 || width > 800)
    || !known.includes(sort) || !['asc', 'desc'].includes(direction)) C.fail('BWL_ACTIONS_PREFERENCES_INVALID');
  // Every action column contains non-financial team metadata. Organizational
  // write revocation therefore does not remove valid read-only layouts.
  return { columns: [...columns], columnWidths: { ...widths }, sort, direction };
}
function context(auth, locations) { return { available: true, capabilities: auth.caps, locations: locations.filter(l => auth.company || auth.locationIds.includes(l.id)),
  statuses: STATUSES, priorities: PRIORITIES, columns: COLUMNS, defaultColumns: DEFAULT_COLUMNS, limits: LIMITS,
  note: 'Manuelle Filialmaßnahmen mit dokumentiertem Prüfhinweis. Keine automatische Bestellung, Umlagerung oder Preisänderung.' }; }
module.exports = { WRITE_PERMISSION, PERMISSION_CATALOG, LIMITS, STATUSES, PRIORITIES, COLUMNS, DEFAULT_COLUMNS, authority, assertLocation, uuid, normalizeSource, validateSourceRecord,
  normalizeCreate, normalizeUpdate, normalizeQuery, normalizePreferences, transition, context };
