'use strict';
const migration = require('../core/session-security');
const { MIGRATION_ID } = require('../../schema-definitions/session-security');
const { instant } = require('../../../portal-session-security');
const TABLES = Object.freeze(['portal_sessions', 'portal_organization_sessions', 'mobile_sessions', 'portal_password_reset_tokens']);
const FORMAT = 'historical-session-security-transform-v1';
const fail = () => { throw new Error('MIGRATION_SESSION_SECURITY_CONTRACT'); };

async function preservedMarker(client) {
  const ledger = await migration.readLedger(client);
  const rows = (await client.query('SELECT id,app_version,applied_at FROM gp.schema_migrations WHERE id=$1', [MIGRATION_ID])).rows;
  if (!ledger) { if (rows.length) fail(); return null; }
  if (rows.length !== 1 || rows[0].app_version !== '0.92.90-beta' || typeof rows[0].applied_at !== 'string' || !rows[0].applied_at) fail();
  return { ledger, marker: rows[0] };
}
function transformation(db, preserved, revokedAt) {
  if (!preserved) return null;
  if (typeof revokedAt !== 'string' || !Number.isFinite(instant(revokedAt)) || new Date(instant(revokedAt)).toISOString() !== revokedAt) fail();
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(MIGRATION_ID)) fail();
  const revoked = Object.fromEntries(TABLES.map(table => [table, Number(db.prepare('SELECT count(*) AS n FROM '+table+' WHERE revoked_at IS NULL'+(table==='portal_password_reset_tokens'?' AND used_at IS NULL':'')).get().n)]));
  return { format: FORMAT, revokedAt, policyVersion: 0, browserAuthenticationOrigin: null,
    browserAbsoluteExpiry: null, revoked, preserved };
}
function extraColumns(table, columns) {
  if (table.database !== 'core') return [];
  return migration.COLUMNS.filter(c => c.table === table.name).flatMap(definition => {
    const column = columns.find(c => c.name === definition.name);
    if (!column) return [];
    const policy = definition.name === 'password_policy_version';
    if (column.generated || (policy
      ? column.type !== 'int4' || column.notNull !== true || !/^\(?0\)?(?:::integer)?$/.test(column.defaultExpression || '')
      : column.type !== 'text' || column.notNull !== false || column.defaultExpression !== null || column.collation !== 'C')) fail();
    return [{ name: column.name, kind: policy ? 'integer' : 'text', source: policy ? 'legacy-zero' : 'legacy-null' }];
  });
}
function transformRow(table, row, security) {
  if (!security || !TABLES.includes(table.name) || row.revoked_at !== null
    || (table.name === 'portal_password_reset_tokens' && row.used_at !== null)) return row;
  return { ...row, revoked_at: security.revokedAt,
    ...(table.name === 'mobile_sessions' ? { revoked_reason: 'session_security_import' } : {}) };
}
// The single installed migration row is infrastructure. It is separately bound
// in the receipt; every historical source row remains part of its table digest.
function markerWhere(table, security) {
  return security && table.database === 'core' && table.name === 'schema_migrations'
    ? " WHERE id <> 'session-security-v1'" : '';
}
module.exports = { FORMAT, TABLES, preservedMarker, transformation, extraColumns, transformRow, markerWhere };
