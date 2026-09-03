"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
} = require("../../errors");
const {
  openSqliteLegacyDatabase,
} = require("../provider");
const {
  inspectSqlitePersonnelLifecycleConversionSchema,
  inspectSqlitePersonnelLifecycleScopedRightsCompatibility,
} = require("./personnel-lifecycle-schema");

const SQLITE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function invalidOperation(operation) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, { operation });
}

function assertLegacyDatabase(database, operation) {
  if (!database || typeof database.prepare !== "function"
    || typeof database.exec !== "function") {
    throw invalidOperation(operation);
  }
  return database;
}

function quotedIdentifier(value, operation) {
  const identifier = String(value || "");
  if (!SQLITE_IDENTIFIER.test(identifier)) throw invalidOperation(operation);
  return `"${identifier}"`;
}

function tableExistsInDatabase(database, tableName) {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(String(tableName || "")));
}

function columnExistsInDatabase(database, tableName, columnName) {
  const table = quotedIdentifier(tableName, "schema-inspection");
  if (!tableExistsInDatabase(database, tableName)) return false;
  return database.prepare(`PRAGMA table_info(${table})`).all()
    .some((column) => column.name === String(columnName || ""));
}

function createSqliteSchemaOperations(database) {
  const connection = assertLegacyDatabase(database, "schema-operations");
  return Object.freeze({
    tableExists(tableName) {
      return tableExistsInDatabase(connection, tableName);
    },
    triggerExists(triggerName) {
      return Boolean(connection.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?",
      ).get(String(triggerName || "")));
    },
    columnExists(tableName, columnName) {
      return columnExistsInDatabase(connection, tableName, columnName);
    },
    ensureColumn(tableName, columnName, definition) {
      if (!tableExistsInDatabase(connection, tableName)
        || columnExistsInDatabase(connection, tableName, columnName)) return false;
      const table = quotedIdentifier(tableName, "schema-migration");
      const column = quotedIdentifier(columnName, "schema-migration");
      const columnDefinition = String(definition || "").trim();
      if (!columnDefinition || /[;\0]/.test(columnDefinition)) {
        throw invalidOperation("schema-migration");
      }
      connection.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnDefinition}`);
      return true;
    },
  });
}

function verifySqliteDatabaseFile(filePath) {
  const verification = openSqliteLegacyDatabase(filePath, { readOnly: true });
  try {
    const result = verification.prepare("PRAGMA quick_check").all()
      .map((row) => Object.values(row)[0]);
    return {
      ok: result.length === 1 && result[0] === "ok",
      result,
    };
  } finally {
    verification.close();
  }
}

function protectedStorageReferencesFromDatabase(database) {
  const connection = assertLegacyDatabase(database, "protected-storage-inspection");
  const keys = [];
  if (tableExistsInDatabase(connection, "amu_documents")) {
    keys.push(...connection.prepare(
      "SELECT storage_key FROM amu_documents WHERE status = 'active'",
    ).all().map((row) => String(row.storage_key || "").toLowerCase()));
  }
  if (tableExistsInDatabase(connection, "personnel_record_documents")) {
    const versioned = tableExistsInDatabase(connection, "personnel_record_document_versions")
      && columnExistsInDatabase(
        connection,
        "personnel_record_documents",
        "current_version",
      );
    if (versioned) {
      const invalidMirror = connection.prepare(`
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
      `).get();
      if (invalidMirror) {
        throw new Error("Die Versionszeiger der Personalakt-Dokumente sind nicht konsistent.");
      }
      keys.push(...connection.prepare(`
        SELECT version.storage_key
        FROM personnel_record_document_versions version
        JOIN personnel_record_documents document ON document.id = version.document_id
        WHERE document.status <> 'purged'
        ORDER BY document.created_at, version.document_id, version.version_number
      `).all().map((row) => String(row.storage_key || "").toLowerCase()));
    } else {
      keys.push(...connection.prepare(
        "SELECT storage_key FROM personnel_record_documents WHERE status = 'active'",
      ).all().map((row) => String(row.storage_key || "").toLowerCase()));
    }
  }
  if (tableExistsInDatabase(connection, "candidate_document_versions")
    && tableExistsInDatabase(connection, "candidate_documents")) {
    keys.push(...connection.prepare(`
      SELECT version.storage_key
      FROM candidate_document_versions version
      JOIN candidate_documents document ON document.id = version.document_id
    `).all().map((row) => String(row.storage_key || "").toLowerCase()));
  }
  if (tableExistsInDatabase(connection, "crm_customer_photos")) {
    keys.push(...connection.prepare("SELECT storage_key FROM crm_customer_photos").all()
      .map((row) => String(row.storage_key || "").toLowerCase()));
  }
  if (tableExistsInDatabase(connection, "loan_documents")) {
    keys.push(...connection.prepare("SELECT storage_key FROM loan_documents").all()
      .map((row) => String(row.storage_key || "").toLowerCase()));
  }
  if (tableExistsInDatabase(connection, "loan_photos")) {
    const retainedFilter = columnExistsInDatabase(connection, "loan_photos", "original_retained")
      ? " WHERE original_retained = 1"
      : "";
    keys.push(...connection.prepare(`SELECT storage_key FROM loan_photos${retainedFilter}`).all()
      .map((row) => String(row.storage_key || "").toLowerCase()));
  }
  if (tableExistsInDatabase(connection, "loan_photo_attachments")) {
    keys.push(...connection.prepare("SELECT storage_key FROM loan_photo_attachments").all()
      .map((row) => String(row.storage_key || "").toLowerCase()));
  }
  if (keys.some((key) => !key) || new Set(keys).size !== keys.length) {
    throw new Error("Die Datenbank enthält ungültige oder doppelte Verweise auf geschützte Dokumente.");
  }
  return keys;
}

function protectedLoanStorageSnapshotFromDatabase(database) {
  const connection = assertLegacyDatabase(database, "protected-loan-storage-inspection");
  const rows = (tableName, where = "") => {
    if (!tableExistsInDatabase(connection, tableName)) return Object.freeze([]);
    return Object.freeze(connection.prepare(`
      SELECT storage_key, filename, detected_mime, byte_size, sha256
      FROM ${quotedIdentifier(tableName, "protected-loan-storage-inspection")}
      ${where}
      ORDER BY created_at, id
    `).all());
  };
  const retainedPhotoFilter = columnExistsInDatabase(
    connection,
    "loan_photos",
    "original_retained",
  ) ? "WHERE original_retained = 1" : "";
  return Object.freeze({
    documents: rows("loan_documents"),
    photos: rows("loan_photos", retainedPhotoFilter),
    photoAttachments: rows("loan_photo_attachments"),
  });
}

function protectedSicknessAmuStorageSnapshotFromDatabase(database) {
  const connection = assertLegacyDatabase(database, "protected-sickness-amu-storage-inspection");
  const candidateConversionSchema = inspectSqlitePersonnelLifecycleConversionSchema(connection);
  if (!candidateConversionSchema.absent && !candidateConversionSchema.valid) {
    throw invalidOperation("protected-sickness-amu-storage-inspection");
  }
  const candidateScopedRightsCompatibility =
    inspectSqlitePersonnelLifecycleScopedRightsCompatibility(connection);
  if (!candidateScopedRightsCompatibility.valid) {
    throw invalidOperation("protected-sickness-amu-storage-inspection");
  }
  const rows = (tableName, sql) => {
    if (!tableExistsInDatabase(connection, tableName)) return Object.freeze([]);
    return Object.freeze(connection.prepare(sql).all());
  };
  return Object.freeze({
    amuDocuments: rows("amu_documents", `
      SELECT d.*, r.employee_number
      FROM amu_documents d
      JOIN amu_reports r ON r.id = d.report_id
      WHERE d.status = 'active'
      ORDER BY d.created_at, d.id
    `),
    personnelDocuments: rows("personnel_record_documents", `
      SELECT id, employee_number, storage_key, status, protected_payload, created_at, updated_at
      FROM personnel_record_documents
      WHERE status = 'active'
      ORDER BY created_at, id
    `),
    personnelDocumentVersions: rows("personnel_record_document_versions", `
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
    candidateDocuments: rows("candidate_document_versions", `
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
      ? rows("candidate_conversions", `
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

function applicationSettingsSnapshotFromDatabase(database) {
  const connection = assertLegacyDatabase(database, "application-settings-inspection");
  if (!tableExistsInDatabase(connection, "settings")) return Object.freeze({});
  return Object.freeze(Object.fromEntries(
    connection.prepare("SELECT key, value FROM settings ORDER BY key").all()
      .map((row) => [String(row.key), String(row.value)]),
  ));
}

function protectedStorageReferencesFromFile(databaseFile) {
  const snapshot = openSqliteLegacyDatabase(databaseFile, { readOnly: true });
  try {
    return protectedStorageReferencesFromDatabase(snapshot);
  } finally {
    snapshot.close();
  }
}

function createSqliteMaintenanceOperations(database) {
  const connection = assertLegacyDatabase(database, "maintenance");
  return Object.freeze({
    checkpointWal() {
      connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    },
    vacuumInto(targetPath) {
      const normalizedPath = String(targetPath || "");
      if (!normalizedPath || normalizedPath.includes("\0")) {
        throw invalidOperation("backup");
      }
      const escapedTarget = normalizedPath.replaceAll("\\", "/").replaceAll("'", "''");
      connection.exec(`VACUUM INTO '${escapedTarget}'`);
    },
    updateLegacyBackupSettings({
      externalBackupEnabled,
      backupDirectory,
      backupIntervalHours,
    } = {}) {
      if (typeof externalBackupEnabled !== "boolean"
        || typeof backupDirectory !== "string"
        || !backupDirectory.trim()
        || !Number.isSafeInteger(backupIntervalHours)
        || backupIntervalHours < 1
        || backupIntervalHours > 6) {
        throw invalidOperation("backup-settings");
      }
      const update = connection.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `);
      connection.exec("BEGIN IMMEDIATE");
      try {
        update.run("external_backup_enabled", externalBackupEnabled ? "1" : "0");
        update.run("backup_directory", backupDirectory.trim());
        update.run("backup_interval_hours", String(backupIntervalHours));
        connection.exec("COMMIT");
      } catch (error) {
        try { connection.exec("ROLLBACK"); } catch {}
        throw error;
      }
    },
  });
}

module.exports = {
  applicationSettingsSnapshotFromDatabase,
  createSqliteMaintenanceOperations,
  createSqliteSchemaOperations,
  protectedLoanStorageSnapshotFromDatabase,
  protectedSicknessAmuStorageSnapshotFromDatabase,
  protectedStorageReferencesFromDatabase,
  protectedStorageReferencesFromFile,
  verifySqliteDatabaseFile,
};
