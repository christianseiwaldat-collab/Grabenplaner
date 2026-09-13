'use strict';
const {schema}=require('./startup');
function quotedIdentifier(value){if(!/^[a-z_][a-z_0-9]*$/.test(value))throw new Error('PG_STORAGE_IDENTIFIER');return '"'+value+'"';}
async function protectedStorageReferencesFromDatabase(database) {
  const connection = database;
  const keys = [];
  if (schema.tableExists("amu_documents")) {
    keys.push(...(await connection.prepare(
      "SELECT storage_key FROM amu_documents WHERE status = 'active'",
    ).all()).map((row) => String(row.storage_key || "").toLowerCase()));
  }
  if (schema.tableExists("personnel_record_documents")) {
    const versioned = schema.tableExists("personnel_record_document_versions")
      && schema.columnExists("personnel_record_documents",
        "current_version",
      );
    if (versioned) {
      const invalidMirror = (await connection.prepare(`
        SELECT document.id
        FROM personnel_record_documents document
        LEFT JOIN personnel_record_document_versions current_version
          ON current_version.document_id = document.id
         AND current_version.version_number = document.current_version
        WHERE (
          document.status = 'purged'
          AND (
            document.current_version <> 0
            OR EXISTS (
              SELECT 1 FROM personnel_record_document_versions version
              WHERE version.document_id = document.id
            )
          )
        ) OR (
          document.status <> 'purged'
          AND (
            document.current_version < 1
            OR current_version.storage_key IS NULL
            OR current_version.storage_key <> document.storage_key
          )
        )
        LIMIT 1
      `).get());
      if (invalidMirror) {
        throw new Error("Die Versionszeiger der Personalakt-Dokumente sind nicht konsistent.");
      }
      keys.push(...(await connection.prepare(`
        SELECT version.storage_key
        FROM personnel_record_document_versions version
        JOIN personnel_record_documents document ON document.id = version.document_id
        WHERE document.status <> 'purged'
        ORDER BY document.created_at, version.document_id, version.version_number
      `).all()).map((row) => String(row.storage_key || "").toLowerCase()));
    } else {
      keys.push(...(await connection.prepare(
        "SELECT storage_key FROM personnel_record_documents WHERE status = 'active'",
      ).all()).map((row) => String(row.storage_key || "").toLowerCase()));
    }
  }
  if (schema.tableExists("candidate_document_versions")
    && schema.tableExists("candidate_documents")) {
    keys.push(...(await connection.prepare(`
      SELECT version.storage_key
      FROM candidate_document_versions version
      JOIN candidate_documents document ON document.id = version.document_id
    `).all()).map((row) => String(row.storage_key || "").toLowerCase()));
  }
  if (schema.tableExists("crm_customer_photos")) {
    keys.push(...(await connection.prepare("SELECT storage_key FROM crm_customer_photos").all())
      .map((row) => String(row.storage_key || "").toLowerCase()));
  }
  if (schema.tableExists("loan_documents")) {
    keys.push(...(await connection.prepare("SELECT storage_key FROM loan_documents").all())
      .map((row) => String(row.storage_key || "").toLowerCase()));
  }
  if (schema.tableExists("loan_photos")) {
    const retainedFilter = schema.columnExists("loan_photos", "original_retained")
      ? " WHERE original_retained = 1"
      : "";
    keys.push(...(await connection.prepare(`SELECT storage_key FROM loan_photos${retainedFilter}`).all())
      .map((row) => String(row.storage_key || "").toLowerCase()));
  }
  if (schema.tableExists("loan_photo_attachments")) {
    keys.push(...(await connection.prepare("SELECT storage_key FROM loan_photo_attachments").all())
      .map((row) => String(row.storage_key || "").toLowerCase()));
  }
  if (keys.some((key) => !key) || new Set(keys).size !== keys.length) {
    throw new Error("Die Datenbank enthält ungültige oder doppelte Verweise auf geschützte Dokumente.");
  }
  return keys;
}

async function protectedLoanStorageSnapshotFromDatabase(database) {
  const connection = database;
  const rows = async (tableName, where = "") => {
    if (!schema.tableExists(tableName)) return Object.freeze([]);
    return Object.freeze((await connection.prepare(`
      SELECT storage_key, filename, detected_mime, byte_size, sha256
      FROM ${quotedIdentifier(tableName, "protected-loan-storage-inspection")}
      ${where}
      ORDER BY created_at, id
    `).all()));
  };
  const retainedPhotoFilter = schema.columnExists("loan_photos",
    "original_retained",
  ) ? "WHERE original_retained = 1" : "";
  return Object.freeze({
    documents: await rows("loan_documents"),
    photos: await rows("loan_photos", retainedPhotoFilter),
    photoAttachments: await rows("loan_photo_attachments"),
  });
}

async function protectedSicknessAmuStorageSnapshotFromDatabase(database) {
  const connection = database;
  const candidateConversionSchema = {valid:true};
  const rows = async (tableName, sql) => {
    if (!schema.tableExists(tableName)) return Object.freeze([]);
    return Object.freeze((await connection.prepare(sql).all()));
  };
  return Object.freeze({
    amuDocuments: await rows("amu_documents", `
      SELECT d.*, r.employee_number
      FROM amu_documents d
      JOIN amu_reports r ON r.id = d.report_id
      WHERE d.status = 'active'
      ORDER BY d.created_at, d.id
    `),
    personnelDocuments: await rows("personnel_record_documents", `
      SELECT id, employee_number, storage_key, status, protected_payload, created_at, updated_at
      FROM personnel_record_documents
      WHERE status = 'active'
      ORDER BY created_at, id
    `),
    personnelDocumentVersions: await rows("personnel_record_document_versions", `
      SELECT
        version.document_id AS id,
        document.employee_number,
        version.storage_key,
        version.protected_payload,
        version.version_number
      FROM personnel_record_document_versions version
      JOIN personnel_record_documents document ON document.id = version.document_id
      WHERE document.status <> 'purged'
      ORDER BY document.created_at, version.document_id, version.version_number
    `),
    candidateDocuments: await rows("candidate_document_versions", `
      SELECT
        version.document_id,
        version.version_number,
        document.candidate_id,
        version.storage_key,
        version.content_sha256,
        version.size_bytes,
        version.media_type,
        version.protected_payload,
        version.created_at
      FROM candidate_document_versions version
      JOIN candidate_documents document ON document.id = version.document_id
      ORDER BY document.created_at, version.document_id, version.version_number
    `),
    candidateConversions: candidateConversionSchema.valid
      ? await rows("candidate_conversions", `
        SELECT
          id,
          candidate_id,
          application_id,
          employee_number,
          request_sha256,
          protected_payload,
          receipt_sha256,
          actor_employee_number,
          created_at
        FROM candidate_conversions
        ORDER BY created_at, id
      `)
      : Object.freeze([]),
  });
}


module.exports={protectedStorageReferencesFromDatabase,protectedLoanStorageSnapshotFromDatabase,protectedSicknessAmuStorageSnapshotFromDatabase};
