"use strict";

const PERSISTENCE_ERROR_CODES = Object.freeze({
  UNIQUE_VIOLATION: "PERSISTENCE_UNIQUE_VIOLATION",
  FOREIGN_KEY_VIOLATION: "PERSISTENCE_FOREIGN_KEY_VIOLATION",
  NOT_NULL_VIOLATION: "PERSISTENCE_NOT_NULL_VIOLATION",
  CHECK_VIOLATION: "PERSISTENCE_CHECK_VIOLATION",
  BUSY: "PERSISTENCE_BUSY",
  RETRYABLE_TRANSACTION: "PERSISTENCE_RETRYABLE_TRANSACTION",
  CONNECTION_UNAVAILABLE: "PERSISTENCE_CONNECTION_UNAVAILABLE",
  TIMEOUT: "PERSISTENCE_TIMEOUT",
  ABORTED: "PERSISTENCE_ABORTED",
  TRANSACTION_STATE_INVALID: "PERSISTENCE_TRANSACTION_STATE_INVALID",
  STATEMENT_INVALID: "PERSISTENCE_STATEMENT_INVALID",
  SCHEMA_INVALID: "PERSISTENCE_SCHEMA_INVALID",
  RESULT_INVALID: "PERSISTENCE_RESULT_INVALID",
  CONFIGURATION_INVALID: "PERSISTENCE_CONFIGURATION_INVALID",
  PROVIDER_UNAVAILABLE: "PERSISTENCE_PROVIDER_UNAVAILABLE",
  PROVIDER_CLOSING: "PERSISTENCE_PROVIDER_CLOSING",
  PROVIDER_CLOSED: "PERSISTENCE_PROVIDER_CLOSED",
  CONTRACT_VIOLATION: "PERSISTENCE_CONTRACT_VIOLATION",
  UNKNOWN: "PERSISTENCE_UNKNOWN",
});

const PERSISTENCE_MESSAGE_KEYS = Object.freeze({
  PROVIDER_ID_INVALID: "provider-id-invalid",
  POSTGRESQL_NOT_AVAILABLE: "postgresql-not-available",
  SQLITE_DATABASE_URL_CONFLICT: "sqlite-database-url-conflict",
  SQLITE_PATH_REQUIRED: "sqlite-path-required",
  STAFF_ASSIGNMENT_HOME_SHIFT_CONFLICT: "staff-assignment-home-shift-conflict",
  STAFF_ASSIGNMENT_COVERAGE_REQUIRED: "staff-assignment-coverage-required",
  STAFF_ASSIGNMENT_DIRECT_ABSENCE_CONFLICT: "staff-assignment-direct-absence-conflict",
});

const KNOWN_ERROR_CODES = new Set(Object.values(PERSISTENCE_ERROR_CODES));
const RETRYABLE_ERROR_CODES = new Set([
  PERSISTENCE_ERROR_CODES.BUSY,
  PERSISTENCE_ERROR_CODES.RETRYABLE_TRANSACTION,
]);

const DEFAULT_MESSAGES = Object.freeze({
  [PERSISTENCE_ERROR_CODES.UNIQUE_VIOLATION]: "Ein eindeutiger Datenwert ist bereits vorhanden.",
  [PERSISTENCE_ERROR_CODES.FOREIGN_KEY_VIOLATION]: "Ein referenzierter Datensatz ist nicht verfügbar.",
  [PERSISTENCE_ERROR_CODES.NOT_NULL_VIOLATION]: "Ein erforderlicher Datenwert fehlt.",
  [PERSISTENCE_ERROR_CODES.CHECK_VIOLATION]: "Ein Datenwert verletzt eine gespeicherte Regel.",
  [PERSISTENCE_ERROR_CODES.BUSY]: "Die Datenbank ist vorübergehend ausgelastet.",
  [PERSISTENCE_ERROR_CODES.RETRYABLE_TRANSACTION]: "Die Transaktion muss kontrolliert wiederholt werden.",
  [PERSISTENCE_ERROR_CODES.CONNECTION_UNAVAILABLE]: "Die Datenbankverbindung ist nicht verfügbar.",
  [PERSISTENCE_ERROR_CODES.TIMEOUT]: "Die Datenbankoperation hat das Zeitlimit überschritten.",
  [PERSISTENCE_ERROR_CODES.ABORTED]: "Die Datenbankoperation wurde abgebrochen.",
  [PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID]: "Der Transaktionszustand erlaubt diese Operation nicht.",
  [PERSISTENCE_ERROR_CODES.STATEMENT_INVALID]: "Das Datenbank-Statement entspricht nicht dem Providervertrag.",
  [PERSISTENCE_ERROR_CODES.SCHEMA_INVALID]: "Das Datenbankschema entspricht nicht dem erwarteten Stand.",
  [PERSISTENCE_ERROR_CODES.RESULT_INVALID]: "Das Datenbankergebnis entspricht nicht dem Providervertrag.",
  [PERSISTENCE_ERROR_CODES.CONFIGURATION_INVALID]: "Die Datenbankkonfiguration ist ungültig.",
  [PERSISTENCE_ERROR_CODES.PROVIDER_UNAVAILABLE]: "Der ausgewählte Datenbank-Provider ist nicht verfügbar.",
  [PERSISTENCE_ERROR_CODES.PROVIDER_CLOSING]: "Der Datenbank-Provider wird gerade geschlossen.",
  [PERSISTENCE_ERROR_CODES.PROVIDER_CLOSED]: "Der Datenbank-Provider ist bereits geschlossen.",
  [PERSISTENCE_ERROR_CODES.CONTRACT_VIOLATION]: "Der Datenbank-Provider verletzt den vereinbarten Vertrag.",
  [PERSISTENCE_ERROR_CODES.UNKNOWN]: "Die Datenbankoperation ist fehlgeschlagen.",
});
const PUBLIC_MESSAGE_OVERRIDES = Object.freeze({
  [PERSISTENCE_MESSAGE_KEYS.PROVIDER_ID_INVALID]: Object.freeze({
    code: PERSISTENCE_ERROR_CODES.CONFIGURATION_INVALID,
    message: "DB_PROVIDER muss sqlite oder postgresql sein.",
  }),
  [PERSISTENCE_MESSAGE_KEYS.POSTGRESQL_NOT_AVAILABLE]: Object.freeze({
    code: PERSISTENCE_ERROR_CODES.PROVIDER_UNAVAILABLE,
    message: "DB_PROVIDER=postgresql ist in diesem Produktstand noch nicht implementiert oder freigegeben.",
  }),
  [PERSISTENCE_MESSAGE_KEYS.SQLITE_DATABASE_URL_CONFLICT]: Object.freeze({
    code: PERSISTENCE_ERROR_CODES.CONFIGURATION_INVALID,
    message: "DATABASE_URL darf bei DB_PROVIDER=sqlite nicht gesetzt sein.",
  }),
  [PERSISTENCE_MESSAGE_KEYS.SQLITE_PATH_REQUIRED]: Object.freeze({
    code: PERSISTENCE_ERROR_CODES.CONFIGURATION_INVALID,
    message: "Für DB_PROVIDER=sqlite ist ein Datenbankpfad erforderlich.",
  }),
  [PERSISTENCE_MESSAGE_KEYS.STAFF_ASSIGNMENT_HOME_SHIFT_CONFLICT]: Object.freeze({
    code: PERSISTENCE_ERROR_CODES.CHECK_VIOLATION,
    message: "Der Dienst überschneidet sich mit einem temporären Filialeinsatz.",
  }),
  [PERSISTENCE_MESSAGE_KEYS.STAFF_ASSIGNMENT_COVERAGE_REQUIRED]: Object.freeze({
    code: PERSISTENCE_ERROR_CODES.CHECK_VIOLATION,
    message: "Der Dienst ist nicht vollständig durch einen temporären Filialeinsatz abgedeckt.",
  }),
  [PERSISTENCE_MESSAGE_KEYS.STAFF_ASSIGNMENT_DIRECT_ABSENCE_CONFLICT]: Object.freeze({
    code: PERSISTENCE_ERROR_CODES.CHECK_VIOLATION,
    message: "Die Abwesenheit überschneidet sich mit einem temporären Filialeinsatz.",
  }),
});

function safeDiagnosticToken(value, fallback = "") {
  const token = String(value || "").trim();
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(token) ? token : fallback;
}

function sanitizedCause(cause) {
  if (!cause || (typeof cause !== "object" && typeof cause !== "function")) return null;
  const safeNames = new Set(["AbortError", "AggregateError", "Error", "RangeError", "TypeError"]);
  const name = safeDiagnosticToken(cause.name, "Error");
  return Object.freeze({ name: safeNames.has(name) ? name : "Error" });
}

class PersistenceError extends Error {
  constructor(code, {
    messageKey = "",
    retryable,
    cause,
    operation = "",
  } = {}) {
    if (!KNOWN_ERROR_CODES.has(code)) throw new TypeError("Unknown persistence error code.");
    const override = PUBLIC_MESSAGE_OVERRIDES[messageKey];
    const message = override?.code === code ? override.message : DEFAULT_MESSAGES[code];
    super(message);
    this.name = "PersistenceError";
    this.code = code;
    this.retryable = retryable === undefined ? RETRYABLE_ERROR_CODES.has(code) : retryable === true;
    const safeOperation = safeDiagnosticToken(operation);
    if (safeOperation) this.operation = safeOperation;
    const safeMessageKey = safeDiagnosticToken(messageKey);
    if (safeMessageKey && override?.code === code) this.messageKey = safeMessageKey;
    const causeSummary = sanitizedCause(cause);
    if (causeSummary) {
      Object.defineProperty(this, "cause", {
        value: causeSummary,
        configurable: false,
        enumerable: false,
        writable: false,
      });
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.operation ? { operation: this.operation } : {}),
    };
  }
}

function isPersistenceError(error) {
  return error instanceof PersistenceError && KNOWN_ERROR_CODES.has(error.code);
}

function normalizePersistenceError(error, {
  fallbackCode = PERSISTENCE_ERROR_CODES.UNKNOWN,
  operation = "",
} = {}) {
  if (isPersistenceError(error)) return error;
  return new PersistenceError(fallbackCode, { cause: error, operation });
}

module.exports = {
  PERSISTENCE_ERROR_CODES,
  PERSISTENCE_MESSAGE_KEYS,
  PersistenceError,
  isPersistenceError,
  normalizePersistenceError,
};
