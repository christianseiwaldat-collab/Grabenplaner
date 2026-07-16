"use strict";

const net = require("node:net");
const { domainToASCII } = require("node:url");

const CONNECTION_KINDS = Object.freeze({
  personnel_sql_source: Object.freeze({
    id: "personnel_sql_source",
    label: "SQL-Personalquelle",
    direction: "import",
    purpose: "personnel",
    providers: Object.freeze(["mssql"]),
    authenticationTypes: Object.freeze(["username_password"]),
  }),
  payroll_https_target: Object.freeze({
    id: "payroll_https_target",
    label: "HTTPS-Lohnziel",
    direction: "export",
    purpose: "payroll",
    providers: Object.freeze(["generic_https_json"]),
    authenticationTypes: Object.freeze(["none", "bearer", "api_key", "basic"]),
  }),
});

const CONNECTION_PROVIDERS = Object.freeze({
  mssql: Object.freeze({
    id: "mssql",
    label: "Microsoft SQL Server",
    kind: "personnel_sql_source",
    defaultPort: 1433,
  }),
  generic_https_json: Object.freeze({
    id: "generic_https_json",
    label: "Generische HTTPS-JSON-API",
    kind: "payroll_https_target",
  }),
});

const CONNECTION_LIMITS = Object.freeze({
  nameMinLength: 2,
  nameMaxLength: 80,
  hostMaxLength: 253,
  databaseMaxLength: 128,
  identifierMaxLength: 128,
  usernameMaxLength: 256,
  secretMaxLength: 4096,
  endpointMaxLength: 2048,
  timeoutMsMin: 1000,
  timeoutMsMax: 30000,
  timeoutMsDefault: 10000,
  rowLimitMin: 1,
  rowLimitMax: 5000,
  rowLimitDefault: 1000,
  requestBytesMin: 1024,
  requestBytesMax: 10 * 1024 * 1024,
  requestBytesDefault: 5 * 1024 * 1024,
  responseBytesMin: 1024,
  responseBytesMax: 2 * 1024 * 1024,
  responseBytesDefault: 256 * 1024,
  scopeEntriesMax: 100,
  sqlAllowedColumnsMax: 100,
});

const SECRET_FIELD_NAMES = new Set([
  "apikey", "authorization", "clientsecret", "credential", "credentials", "password",
  "passphrase", "secret", "token", "user", "username",
]);
const FORBIDDEN_CUSTOM_HEADERS = new Set([
  "authorization", "connection", "content-length", "cookie", "host", "proxy-authorization", "transfer-encoding",
]);

function connectionError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainObject(value, code) {
  if (!isPlainObject(value)) throw connectionError(code);
  return value;
}

function cleanText(value, maxLength) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function normalizeFieldName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function assertNoPublicSecrets(value, path = "configuration") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPublicSecrets(entry, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_FIELD_NAMES.has(normalizeFieldName(key))) {
      throw connectionError("INTEGRATION_CONNECTION_PUBLIC_SECRET_FORBIDDEN", `Geheime Zugangsdaten dürfen nicht in ${path}.${key} gespeichert werden.`);
    }
    assertNoPublicSecrets(nested, `${path}.${key}`);
  }
}

function normalizeInteger(value, fallback, minimum, maximum, code) {
  const normalized = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) throw connectionError(code);
  return normalized;
}

function normalizeScopeIdentifier(value) {
  const normalized = String(value ?? "").trim();
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(normalized)) throw connectionError("INTEGRATION_CONNECTION_SCOPE_INVALID");
  return normalized;
}

function normalizeScope(value = {}) {
  if (value === undefined || value === null) value = {};
  requirePlainObject(value, "INTEGRATION_CONNECTION_SCOPE_INVALID");
  const normalizeList = (entries) => {
    if (entries === undefined || entries === null) return [];
    if (!Array.isArray(entries) || entries.length > CONNECTION_LIMITS.scopeEntriesMax) {
      throw connectionError("INTEGRATION_CONNECTION_SCOPE_INVALID");
    }
    return [...new Set(entries.map(normalizeScopeIdentifier))];
  };
  return {
    locationIds: normalizeList(value.locationIds),
    departmentIds: normalizeList(value.departmentIds),
  };
}

function normalizeSqlHost(value) {
  let host = String(value ?? "").trim();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host || host.length > CONNECTION_LIMITS.hostMaxLength || /[\s\\/@?#]/.test(host)) {
    throw connectionError("INTEGRATION_CONNECTION_SQL_HOST_INVALID");
  }
  if (net.isIP(host)) return host.toLowerCase();
  const ascii = domainToASCII(host.replace(/\.$/, "")).toLowerCase();
  if (!ascii || ascii.length > CONNECTION_LIMITS.hostMaxLength
    || !ascii.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw connectionError("INTEGRATION_CONNECTION_SQL_HOST_INVALID");
  }
  return ascii;
}

function normalizeSqlName(value, code, { optional = false } = {}) {
  const normalized = String(value ?? "").trim();
  if (!normalized && optional) return "";
  if (!normalized || normalized.length > CONNECTION_LIMITS.identifierMaxLength
    || !/^[\p{L}\p{N}_@$# -]+$/u.test(normalized)) throw connectionError(code);
  return normalized;
}

function normalizeSqlAllowedColumns(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > CONNECTION_LIMITS.sqlAllowedColumnsMax) {
    throw connectionError("INTEGRATION_CONNECTION_SQL_COLUMNS_INVALID");
  }
  const columns = value.map((entry) => normalizeSqlName(entry, "INTEGRATION_CONNECTION_SQL_COLUMNS_INVALID"));
  const unique = [...new Map(columns.map((column) => [column.toLocaleLowerCase("de-AT"), column])).values()];
  if (!unique.length) throw connectionError("INTEGRATION_CONNECTION_SQL_COLUMNS_INVALID");
  return unique;
}

function normalizeHeaderName(value, code) {
  const normalized = String(value ?? "").trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,80}$/.test(normalized)
    || FORBIDDEN_CUSTOM_HEADERS.has(normalized.toLowerCase())) throw connectionError(code);
  return normalized;
}

function normalizeSqlConfiguration(provider, value) {
  if (provider !== "mssql") throw connectionError("INTEGRATION_CONNECTION_PROVIDER_INVALID");
  const configuration = requirePlainObject(value, "INTEGRATION_CONNECTION_CONFIGURATION_INVALID");
  assertNoPublicSecrets(configuration);
  if (configuration.objectType !== undefined && configuration.objectType !== "view") {
    throw connectionError("INTEGRATION_CONNECTION_SQL_OBJECT_TYPE_INVALID");
  }
  if (configuration.tlsMode !== undefined && configuration.tlsMode !== "verify_full") {
    throw connectionError("INTEGRATION_CONNECTION_SQL_TLS_INVALID");
  }
  return {
    host: normalizeSqlHost(configuration.host),
    port: normalizeInteger(configuration.port, CONNECTION_PROVIDERS.mssql.defaultPort, 1, 65535, "INTEGRATION_CONNECTION_SQL_PORT_INVALID"),
    database: normalizeSqlName(configuration.database, "INTEGRATION_CONNECTION_SQL_DATABASE_INVALID"),
    instanceName: normalizeSqlName(configuration.instanceName, "INTEGRATION_CONNECTION_SQL_INSTANCE_INVALID", { optional: true }),
    schemaName: normalizeSqlName(configuration.schemaName || "dbo", "INTEGRATION_CONNECTION_SQL_SCHEMA_INVALID"),
    objectName: normalizeSqlName(configuration.objectName, "INTEGRATION_CONNECTION_SQL_OBJECT_INVALID"),
    objectType: "view",
    allowedColumns: normalizeSqlAllowedColumns(configuration.allowedColumns),
    tlsMode: "verify_full",
    timeoutMs: normalizeInteger(configuration.timeoutMs, CONNECTION_LIMITS.timeoutMsDefault,
      CONNECTION_LIMITS.timeoutMsMin, CONNECTION_LIMITS.timeoutMsMax, "INTEGRATION_CONNECTION_TIMEOUT_INVALID"),
    rowLimit: normalizeInteger(configuration.rowLimit, CONNECTION_LIMITS.rowLimitDefault,
      CONNECTION_LIMITS.rowLimitMin, CONNECTION_LIMITS.rowLimitMax, "INTEGRATION_CONNECTION_ROW_LIMIT_INVALID"),
    scope: normalizeScope(configuration.scope),
  };
}

function normalizeHttpsEndpoint(value) {
  const source = String(value ?? "").trim();
  if (!source || source.length > CONNECTION_LIMITS.endpointMaxLength) throw connectionError("INTEGRATION_CONNECTION_API_ENDPOINT_INVALID");
  let endpoint;
  try { endpoint = new URL(source); } catch { throw connectionError("INTEGRATION_CONNECTION_API_ENDPOINT_INVALID"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
    throw connectionError("INTEGRATION_CONNECTION_API_ENDPOINT_INVALID");
  }
  return endpoint.toString();
}

function normalizeApiConfiguration(provider, value) {
  if (provider !== "generic_https_json") throw connectionError("INTEGRATION_CONNECTION_PROVIDER_INVALID");
  const configuration = requirePlainObject(value, "INTEGRATION_CONNECTION_CONFIGURATION_INVALID");
  assertNoPublicSecrets(configuration);
  if (configuration.authenticationType !== undefined
    && !["none", "bearer", "api_key", "basic"].includes(configuration.authenticationType)) {
    throw connectionError("INTEGRATION_CONNECTION_AUTHENTICATION_INVALID");
  }
  const authenticationType = configuration.authenticationType || "none";
  const submittedMethod = String(configuration.method || "POST").toUpperCase();
  if (submittedMethod !== "POST") throw connectionError("INTEGRATION_CONNECTION_API_METHOD_INVALID");
  const method = "POST";
  return {
    endpoint: normalizeHttpsEndpoint(configuration.endpoint),
    method,
    authenticationType,
    apiKeyHeader: authenticationType === "api_key"
      ? normalizeHeaderName(configuration.apiKeyHeader || "X-API-Key", "INTEGRATION_CONNECTION_API_KEY_HEADER_INVALID") : "",
    idempotencyHeader: "Idempotency-Key",
    payloadFormat: "json",
    timeoutMs: normalizeInteger(configuration.timeoutMs, CONNECTION_LIMITS.timeoutMsDefault,
      CONNECTION_LIMITS.timeoutMsMin, CONNECTION_LIMITS.timeoutMsMax, "INTEGRATION_CONNECTION_TIMEOUT_INVALID"),
    requestLimitBytes: normalizeInteger(configuration.requestLimitBytes, CONNECTION_LIMITS.requestBytesDefault,
      CONNECTION_LIMITS.requestBytesMin, CONNECTION_LIMITS.requestBytesMax, "INTEGRATION_CONNECTION_REQUEST_LIMIT_INVALID"),
    responseLimitBytes: normalizeInteger(configuration.responseLimitBytes, CONNECTION_LIMITS.responseBytesDefault,
      CONNECTION_LIMITS.responseBytesMin, CONNECTION_LIMITS.responseBytesMax, "INTEGRATION_CONNECTION_RESPONSE_LIMIT_INVALID"),
    scope: normalizeScope(configuration.scope),
  };
}

function normalizedSecret(value, field, minimumLength = 1) {
  if (typeof value !== "string" || value.length < minimumLength || value.length > CONNECTION_LIMITS.secretMaxLength
    || /[\u0000\r\n]/.test(value)) throw connectionError(`INTEGRATION_CONNECTION_${field.toUpperCase()}_INVALID`);
  return value;
}

function normalizedUsername(value) {
  const username = typeof value === "string" ? value.trim() : "";
  if (!username || username.length > CONNECTION_LIMITS.usernameMaxLength || /[\u0000\r\n]/.test(username)) {
    throw connectionError("INTEGRATION_CONNECTION_USERNAME_INVALID");
  }
  return username;
}

function assertCredentialKeys(credentials, allowedKeys) {
  const allowed = new Set(allowedKeys);
  if (Object.keys(credentials).some((key) => !allowed.has(key))) {
    throw connectionError("INTEGRATION_CONNECTION_CREDENTIALS_UNEXPECTED");
  }
}

function normalizeCredentials(kind, authenticationType, value, options = {}) {
  const existingCredentialsConfigured = options.existingCredentialsConfigured === true;
  const credentialsSubmitted = value !== undefined && value !== null;
  if (!credentialsSubmitted && existingCredentialsConfigured) return { credentials: null, credentialsConfigured: true };
  const credentials = credentialsSubmitted ? requirePlainObject(value, "INTEGRATION_CONNECTION_CREDENTIALS_INVALID") : {};

  if (kind === "personnel_sql_source") {
    if (authenticationType !== "username_password") throw connectionError("INTEGRATION_CONNECTION_AUTHENTICATION_INVALID");
    assertCredentialKeys(credentials, ["username", "password"]);
    return {
      credentials: {
        username: normalizedUsername(credentials.username),
        password: normalizedSecret(credentials.password, "password"),
      },
      credentialsConfigured: true,
    };
  }

  if (authenticationType === "none") {
    assertCredentialKeys(credentials, []);
    return { credentials: {}, credentialsConfigured: false };
  }
  if (authenticationType === "bearer") {
    assertCredentialKeys(credentials, ["token"]);
    return { credentials: { token: normalizedSecret(credentials.token, "token", 8) }, credentialsConfigured: true };
  }
  if (authenticationType === "api_key") {
    assertCredentialKeys(credentials, ["apiKey"]);
    return { credentials: { apiKey: normalizedSecret(credentials.apiKey, "api_key", 8) }, credentialsConfigured: true };
  }
  if (authenticationType === "basic") {
    assertCredentialKeys(credentials, ["username", "password"]);
    return {
      credentials: {
        username: normalizedUsername(credentials.username),
        password: normalizedSecret(credentials.password, "password"),
      },
      credentialsConfigured: true,
    };
  }
  throw connectionError("INTEGRATION_CONNECTION_AUTHENTICATION_INVALID");
}

function normalizeIntegrationConnection(value = {}, options = {}) {
  const input = requirePlainObject(value, "INTEGRATION_CONNECTION_INVALID");
  for (const [key, nested] of Object.entries(input)) {
    if (key === "credentials") continue;
    if (SECRET_FIELD_NAMES.has(normalizeFieldName(key))) throw connectionError("INTEGRATION_CONNECTION_PUBLIC_SECRET_FORBIDDEN");
    if (key !== "configuration") assertNoPublicSecrets(nested, key);
  }
  const kind = String(input.kind || "");
  const definition = CONNECTION_KINDS[kind];
  if (!definition) throw connectionError("INTEGRATION_CONNECTION_KIND_INVALID");
  const provider = String(input.provider || "");
  if (!definition.providers.includes(provider)) throw connectionError("INTEGRATION_CONNECTION_PROVIDER_INVALID");
  const submittedName = String(input.name ?? "").trim().replace(/\s+/g, " ");
  if (submittedName.length < CONNECTION_LIMITS.nameMinLength || submittedName.length > CONNECTION_LIMITS.nameMaxLength) {
    throw connectionError("INTEGRATION_CONNECTION_NAME_INVALID");
  }
  const name = submittedName;

  const configuration = kind === "personnel_sql_source"
    ? normalizeSqlConfiguration(provider, input.configuration)
    : normalizeApiConfiguration(provider, input.configuration);
  const authenticationType = kind === "personnel_sql_source" ? "username_password" : configuration.authenticationType;
  const credentialState = normalizeCredentials(kind, authenticationType, input.credentials, options);
  return {
    version: 1,
    kind,
    direction: definition.direction,
    purpose: definition.purpose,
    provider,
    name,
    active: input.active !== false,
    configuration,
    credentials: credentialState.credentials,
    credentialsConfigured: credentialState.credentialsConfigured,
  };
}

function safeConfigurationProjection(kind, configuration = {}) {
  const value = isPlainObject(configuration) ? configuration : {};
  if (kind === "personnel_sql_source") {
    const candidate = Object.fromEntries(["host", "port", "database", "instanceName", "schemaName", "objectName", "objectType", "allowedColumns", "tlsMode", "timeoutMs", "rowLimit", "scope"]
      .filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
    return normalizeSqlConfiguration("mssql", candidate);
  }
  if (kind === "payroll_https_target") {
    const candidate = Object.fromEntries(["endpoint", "method", "authenticationType", "apiKeyHeader", "idempotencyHeader", "timeoutMs", "requestLimitBytes", "responseLimitBytes", "scope"]
      .filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
    return normalizeApiConfiguration("generic_https_json", candidate);
  }
  return {};
}

function toPublicIntegrationConnection(value = {}, options = {}) {
  const input = requirePlainObject(value, "INTEGRATION_CONNECTION_INVALID");
  const kind = String(input.kind || "");
  const definition = CONNECTION_KINDS[kind];
  if (!definition) throw connectionError("INTEGRATION_CONNECTION_KIND_INVALID");
  const provider = String(input.provider || "");
  if (!definition.providers.includes(provider)) throw connectionError("INTEGRATION_CONNECTION_PROVIDER_INVALID");
  const credentialsConfigured = options.credentialsConfigured !== undefined
    ? options.credentialsConfigured === true : input.credentialsConfigured === true;
  const lastErrorCode = /^[A-Z0-9_:-]{1,80}$/.test(String(input.lastErrorCode || "")) ? String(input.lastErrorCode) : "";
  return {
    id: String(input.id || ""),
    version: Number(input.version || 1),
    kind,
    direction: definition.direction,
    purpose: definition.purpose,
    provider,
    name: cleanText(input.name, CONNECTION_LIMITS.nameMaxLength),
    active: input.active !== false,
    configuration: safeConfigurationProjection(kind, input.configuration),
    credentialsConfigured,
    status: ["untested", "ready", "error", "disabled"].includes(input.status) ? input.status : "untested",
    lastTestedAt: input.lastTestedAt || null,
    lastErrorCode,
    createdAt: input.createdAt || null,
    updatedAt: input.updatedAt || null,
  };
}

function integrationConnectionCatalog() {
  return {
    version: 1,
    kinds: Object.values(CONNECTION_KINDS).map((definition) => ({
      id: definition.id,
      label: definition.label,
      direction: definition.direction,
      purpose: definition.purpose,
      providers: [...definition.providers],
      authenticationTypes: [...definition.authenticationTypes],
    })),
    providers: Object.values(CONNECTION_PROVIDERS).map((provider) => ({ ...provider })),
    limits: { ...CONNECTION_LIMITS },
  };
}

module.exports = {
  CONNECTION_KINDS,
  CONNECTION_PROVIDERS,
  CONNECTION_LIMITS,
  normalizeIntegrationConnection,
  toPublicIntegrationConnection,
  integrationConnectionCatalog,
};
