"use strict";
const { IMPORT_MASTER_STATEMENTS: S, IMPORT_MASTER_COLUMNS: C } = require("../statements/import-master-data");
const snake = name => name.replace(/[A-Z]/gu, letter => "_" + letter.toLowerCase());
const select = (columns, prefix = "") => Object.keys(columns).map(name => `${prefix}${snake(name)} AS "${name}"`).join(", ");
const insert = (table, columns) => `INSERT INTO ${table} (${Object.keys(columns).map(snake).join(", ")}) VALUES (${Object.keys(columns).map(name => "$" + name).join(", ")})`;
const entry = (statement, sql) => Object.freeze({ statement, sql, returning: false });
const crmFields = Object.keys(C.CRM_DATA);
const SQLITE_IMPORT_MASTER_CATALOG = Object.freeze([
  entry(S.listMappings, `SELECT ${select(C.RECORD, 'r.')} FROM import_master_records r
    WHERE r.scope_id=$scopeId AND r.source_instance=$sourceInstance AND r.source_table=$sourceTable AND r.id>$after
    AND ($status='all' OR ($status='linked' AND EXISTS(SELECT 1 FROM import_master_bindings b WHERE b.record_id=r.id))
      OR ($status='unlinked' AND NOT EXISTS(SELECT 1 FROM import_master_bindings b WHERE b.record_id=r.id))) ORDER BY r.id LIMIT $limit`),
  entry(S.employeeTargets, `SELECT personnel_number AS id, full_name AS label, active FROM employees
    WHERE personnel_number>$after AND ($query='' OR personnel_number=$query)
    ORDER BY personnel_number LIMIT $limit`),
  entry(S.locationTargets, `SELECT id, name AS label, active FROM locations
    WHERE id>$after AND ($query='' OR id=$query) ORDER BY id LIMIT $limit`),
  entry(S.get, `SELECT ${select(C.RECORD)} FROM import_master_records WHERE id=$id AND scope_id=$scopeId`),
  entry(S.find, `SELECT ${select(C.RECORD)} FROM import_master_records WHERE identity_hash=$identityHash AND scope_id=$scopeId`),
  entry(S.insert, insert("import_master_records", C.RECORD)),
  entry(S.update, "UPDATE import_master_records SET revision=revision+1, profile_hash=$profileHash, updated_by=$updatedBy, updated_at=$updatedAt WHERE id=$id AND scope_id=$scopeId AND revision=$expectedRevision"),
  entry(S.remove, "DELETE FROM import_master_records WHERE id=$id AND scope_id=$scopeId AND revision=$expectedRevision"),
  entry(S.segments, `SELECT ${select(C.SEGMENT)} FROM import_master_segments WHERE record_id=$recordId ORDER BY kind, data_class`),
  entry(S.insertSegment, insert("import_master_segments", C.SEGMENT)),
  entry(S.clearSegments, "DELETE FROM import_master_segments WHERE record_id=$recordId"),
  entry(S.relations, `SELECT ${select(C.RELATION, "r.")}, p.id AS "targetId" FROM import_master_relations r LEFT JOIN import_master_records p ON p.identity_hash=r.identity_hash AND p.scope_id=$scopeId WHERE r.record_id=$recordId ORDER BY r.slot`),
  entry(S.insertRelation, insert("import_master_relations", C.RELATION)),
  entry(S.clearRelations, "DELETE FROM import_master_relations WHERE record_id=$recordId"),
  entry(S.dependencies, `SELECT (SELECT COUNT(*) FROM import_master_relations WHERE identity_hash=$identityHash AND record_id<>$id)
    + (SELECT COUNT(*) FROM import_master_bindings WHERE record_id=$id) + (SELECT COUNT(*) FROM import_master_holds WHERE record_id=$id) AS count`),
  entry(S.getBinding, `SELECT ${select(C.BINDING)} FROM import_master_bindings WHERE record_id=$recordId`),
  entry(S.insertBinding, insert("import_master_bindings", C.BINDING)),
  entry(S.updateBinding, "UPDATE import_master_bindings SET revision=revision+1, source_revision=$sourceRevision, payload=$payload, last_event_id=$lastEventId WHERE record_id=$recordId AND revision=$expectedRevision"),
  entry(S.removeBinding, "DELETE FROM import_master_bindings WHERE record_id=$recordId AND revision=$expectedRevision"),
  entry(S.insertEvent, insert("import_master_events", C.EVENT)),
  entry(S.getEvent, `SELECT ${select(C.EVENT)} FROM import_master_events WHERE id=$id AND scope_id=$scopeId`),
  entry(S.revertEvent, "UPDATE import_master_events SET reverted_at=$at WHERE id=$id AND scope_id=$scopeId AND reverted_at IS NULL"),
  entry(S.crmGet, `SELECT ${select(C.CRM)} FROM crm_customers WHERE id=$id`),
  entry(S.crmFind, `SELECT ${select(C.CRM)} FROM crm_customers WHERE lower(customer_number)=lower($number)`),
  entry(S.crmInsert, `INSERT INTO crm_customers (id, ${crmFields.map(snake).join(", ")}, revision, created_by, created_at, updated_by, updated_at)
    VALUES ($id, ${crmFields.map(name => "$" + name).join(", ")}, 1, $actor, $timestamp, $actor, $timestamp)`),
  entry(S.crmUpdate, `UPDATE crm_customers SET ${crmFields.map(name => `${snake(name)}=$${name}`).join(", ")}, revision=revision+1, updated_by=$actor, updated_at=$timestamp WHERE id=$id AND revision=$expectedRevision`),
  entry(S.crmRemove, "DELETE FROM crm_customers WHERE id=$id AND revision=$expectedRevision"),
  entry(S.crmDependents, `SELECT (SELECT COUNT(*) FROM crm_customer_custom_fields WHERE customer_id=$id)
    + (SELECT COUNT(*) FROM crm_customer_photos WHERE customer_id=$id)
    + (SELECT COUNT(*) FROM import_master_bindings WHERE target_kind='crm_customer' AND target_id=$id AND record_id<>$recordId)
    + (SELECT COUNT(*) FROM import_master_holds WHERE record_id=$recordId) AS count`),
  entry(S.articleBySource, `SELECT a.product_id AS id, a.current_revision AS revision, a.article_number AS "articleNumber", r.active AS active
    FROM sales_articles a JOIN sales_article_source_links l ON l.product_id=a.product_id
    JOIN sales_article_revisions r ON r.product_id=a.product_id AND r.revision=a.current_revision
    WHERE l.source_system=$sourceSystem AND l.source_article_key=$sourceArticleKey`),
  entry(S.employee, "SELECT personnel_number AS id, active FROM employees WHERE personnel_number=$id"),
  entry(S.location, "SELECT id, active FROM locations WHERE id=$id"),
  entry(S.insertHold, insert("import_master_holds", { recordId: "text", consumerId: "text" })),
  entry(S.removeHold, "DELETE FROM import_master_holds WHERE record_id=$recordId AND consumer_id=$consumerId"),
  entry(S.holdCount, "SELECT COUNT(*) AS count FROM import_master_holds WHERE record_id=$recordId"),
]);
module.exports = { SQLITE_IMPORT_MASTER_CATALOG };
