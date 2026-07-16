"use strict";

const MAX_SQL_VIEW_ROWS = 5_000;
const MAX_SQL_VIEW_COLUMNS = 100;
const MAX_SQL_VIEW_LIST_ENTRIES = 1_000;
const MAX_SQL_CELL_CHARACTERS = 2_000;
const MAX_SQL_VIEW_BYTES = 5 * 1024 * 1024;
const DEFAULT_CONNECTION_TIMEOUT_MS = 8_000;
const DEFAULT_QUERY_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 10;
const MAX_TIMEOUT_MS = 30_000;
const SQL_SERVER_PROVIDER_ID = "sqlserver";
const SQL_SERVER_ERROR_LISTENER = Symbol("grabenplanerSqlServerErrorListener");

const SQL_SERVER_LIST_VIEWS = `
SELECT TOP (1001) TABLE_SCHEMA, TABLE_NAME
FROM INFORMATION_SCHEMA.VIEWS
WHERE TABLE_CATALOG = DB_NAME()
ORDER BY TABLE_SCHEMA, TABLE_NAME
`;

const SQL_SERVER_LIST_COLUMNS = `
SELECT TOP (101) c.COLUMN_NAME, c.ORDINAL_POSITION, c.DATA_TYPE, c.IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS AS c
WHERE c.TABLE_CATALOG = DB_NAME()
  AND c.TABLE_SCHEMA = @schema
  AND c.TABLE_NAME = @view
  AND EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.VIEWS AS v
    WHERE v.TABLE_CATALOG = c.TABLE_CATALOG
      AND v.TABLE_SCHEMA = c.TABLE_SCHEMA
      AND v.TABLE_NAME = c.TABLE_NAME
  )
ORDER BY c.ORDINAL_POSITION
`;

class SqlViewSourceError extends Error {
  constructor(message, code = "SQL_VIEW_SOURCE_FAILED", status = 400) {
    super(message);
    this.name = "SqlViewSourceError";
    this.code = code;
    this.status = status;
  }
}

function sourceError(message, code, status = 400) {
  return new SqlViewSourceError(message, code, status);
}

function normalizedText(value, label, maximumLength) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maximumLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw sourceError(`${label} ist ung\u00fcltig.`, "SQL_CONNECTOR_CONFIGURATION_INVALID");
  }
  return text;
}

function normalizeSqlIdentifier(value, label = "Der SQL-Bezeichner") {
  return normalizedText(value, label, 128);
}

function quoteSqlServerIdentifier(value) {
  const identifier = normalizeSqlIdentifier(value);
  return `[${identifier.replaceAll("]", "]]")}]`;
}

function normalizeTimeout(value, fallback, label) {
  const timeout = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(timeout) || timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS) {
    throw sourceError(`${label} ist ung\u00fcltig.`, "SQL_CONNECTOR_CONFIGURATION_INVALID");
  }
  return timeout;
}

function normalizeSqlConnectorConfiguration(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw sourceError("Die SQL-Verbindung ist ung\u00fcltig.", "SQL_CONNECTOR_CONFIGURATION_INVALID");
  }
  const providerId = normalizedText(input.providerId || input.provider || SQL_SERVER_PROVIDER_ID, "Der SQL-Provider", 40).toLowerCase();
  if (!/^[a-z][a-z0-9_-]*$/.test(providerId)) {
    throw sourceError("Der SQL-Provider ist ung\u00fcltig.", "SQL_CONNECTOR_CONFIGURATION_INVALID");
  }
  const server = normalizedText(input.server || input.host, "Der SQL-Server", 253);
  if (server.includes("://") || /[\\/\s]/.test(server) || !/^[a-z0-9_.:-]+$/i.test(server)) {
    throw sourceError("Der SQL-Server ist ung\u00fcltig. Bitte Hostname oder IP-Adresse und einen eigenen Port verwenden.", "SQL_CONNECTOR_CONFIGURATION_INVALID");
  }
  const port = Number(input.port ?? 1433);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw sourceError("Der SQL-Port ist ung\u00fcltig.", "SQL_CONNECTOR_CONFIGURATION_INVALID");
  }
  return Object.freeze({
    providerId,
    server,
    port,
    database: normalizeSqlIdentifier(input.database, "Die SQL-Datenbank"),
    instanceName: input.instanceName ? normalizeSqlIdentifier(input.instanceName, "Die SQL-Instanz") : "",
    schemaName: input.schemaName ? normalizeSqlIdentifier(input.schemaName, "Das SQL-Schema") : "",
    objectName: input.objectName ? normalizeSqlIdentifier(input.objectName, "Der SQL-Viewname") : "",
    rowLimit: normalizeRowLimit(input.rowLimit),
    username: input.username === undefined || input.username === null || input.username === ""
      ? ""
      : normalizedText(input.username, "Der SQL-Benutzername", 256),
    encrypt: input.encrypt !== false,
    trustServerCertificate: input.trustServerCertificate === true || input.tlsMode === "encrypted",
    connectionTimeoutMs: normalizeTimeout(input.connectionTimeoutMs ?? input.timeoutMs, DEFAULT_CONNECTION_TIMEOUT_MS, "Das Verbindungszeitlimit"),
    queryTimeoutMs: normalizeTimeout(input.queryTimeoutMs ?? input.timeoutMs, DEFAULT_QUERY_TIMEOUT_MS, "Das Abfragezeitlimit"),
  });
}

function normalizeCredential(configuration, credential = {}) {
  if (!credential || typeof credential !== "object" || Array.isArray(credential)) {
    throw sourceError("Die SQL-Zugangsdaten fehlen.", "SQL_CREDENTIALS_REQUIRED", 401);
  }
  const username = normalizedText(credential.username || configuration.username, "Der SQL-Benutzername", 256);
  const password = String(credential.password ?? "");
  if (!password || password.length > 4_096 || /[\u0000\r\n]/.test(password)) {
    throw sourceError("Die SQL-Zugangsdaten fehlen oder sind ung\u00fcltig.", "SQL_CREDENTIALS_REQUIRED", 401);
  }
  return { username, password };
}

function normalizeRowLimit(value) {
  const limit = value === undefined || value === null || value === "" ? MAX_SQL_VIEW_ROWS : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SQL_VIEW_ROWS) {
    throw sourceError(`Eine SQL-Vorschau darf h\u00f6chstens ${MAX_SQL_VIEW_ROWS} Zeilen lesen.`, "SQL_VIEW_ROW_LIMIT_INVALID");
  }
  return limit;
}

function normalizeRequestedColumns(columns) {
  if (!Array.isArray(columns) || !columns.length || columns.length > MAX_SQL_VIEW_COLUMNS) {
    throw sourceError(`Bitte 1 bis ${MAX_SQL_VIEW_COLUMNS} SQL-Spalten ausw\u00e4hlen.`, "SQL_VIEW_COLUMNS_INVALID");
  }
  const seen = new Set();
  return columns.map((value) => {
    const name = normalizeSqlIdentifier(value, "Der SQL-Spaltenname");
    const key = name.toLocaleLowerCase("de-AT");
    if (seen.has(key)) throw sourceError("Eine SQL-Spalte wurde mehrfach ausgew\u00e4hlt.", "SQL_VIEW_COLUMNS_INVALID");
    seen.add(key);
    return name;
  });
}

function buildSqlServerViewSelect(schema, view, columns, maxRows = MAX_SQL_VIEW_ROWS) {
  const limit = normalizeRowLimit(maxRows);
  const selected = normalizeRequestedColumns(columns);
  return `SELECT TOP (${limit + 1}) ${selected.map(quoteSqlServerIdentifier).join(", ")} FROM ${quoteSqlServerIdentifier(schema)}.${quoteSqlServerIdentifier(view)}`;
}

function sqlCellText(value) {
  if (value === null || value === undefined) return "";
  let text;
  if (typeof value === "string") text = value;
  else if (typeof value === "number") {
    if (!Number.isFinite(value)) throw sourceError("Die SQL-View enth\u00e4lt einen nicht unterst\u00fctzten Zahlenwert.", "SQL_VIEW_VALUE_UNSUPPORTED", 422);
    text = String(value);
  } else if (typeof value === "bigint" || typeof value === "boolean") text = String(value);
  else if (value instanceof Date && !Number.isNaN(value.getTime())) text = value.toISOString();
  else {
    throw sourceError("Die SQL-View enth\u00e4lt einen nicht unterst\u00fctzten Bin\u00e4r- oder Objektwert.", "SQL_VIEW_VALUE_UNSUPPORTED", 422);
  }
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (text.length > MAX_SQL_CELL_CHARACTERS) {
    throw sourceError(`Ein SQL-Wert ist l\u00e4nger als ${MAX_SQL_CELL_CHARACTERS} Zeichen.`, "SQL_VIEW_CELL_LIMIT", 413);
  }
  return text;
}

function normalizedSqlRow(row, expectedColumns) {
  if (!Array.isArray(row) || row.length !== expectedColumns) {
    throw sourceError("Eine SQL-Datenzeile passt nicht zu den ausgew\u00e4hlten Spalten.", "SQL_VIEW_ROWS_INVALID", 502);
  }
  return row.map(sqlCellText);
}

function sqlSnapshotByteSize(rows, expectedColumns, maximumBytes = MAX_SQL_VIEW_BYTES) {
  let byteSize = 2;
  for (let index = 0; index < rows.length; index += 1) {
    const row = normalizedSqlRow(rows[index], expectedColumns);
    byteSize += Buffer.byteLength(JSON.stringify(row), "utf8") + (index ? 1 : 0);
    if (byteSize > maximumBytes) {
      throw sourceError(
        `Die SQL-Vorschau ist gr\u00f6\u00dfer als ${Math.floor(maximumBytes / (1024 * 1024))} MiB. Bitte die View fachlich einschr\u00e4nken.`,
        "SQL_VIEW_BYTE_LIMIT",
        413,
      );
    }
  }
  return byteSize;
}

function normalizeViews(rows) {
  if (!Array.isArray(rows)) throw sourceError("Die SQL-View-Liste ist ung\u00fcltig.", "SQL_VIEW_METADATA_INVALID", 502);
  if (rows.length > MAX_SQL_VIEW_LIST_ENTRIES) {
    throw sourceError(`Es wurden mehr als ${MAX_SQL_VIEW_LIST_ENTRIES} SQL-Views gefunden.`, "SQL_VIEW_LIST_LIMIT", 413);
  }
  const unique = new Map();
  for (const row of rows) {
    const schema = normalizeSqlIdentifier(row?.schema ?? row?.tableSchema ?? row?.[0], "Das SQL-Schema");
    const name = normalizeSqlIdentifier(row?.name ?? row?.view ?? row?.tableName ?? row?.[1], "Der SQL-Viewname");
    const key = `${schema}\u0000${name}`.toLocaleLowerCase("de-AT");
    if (!unique.has(key)) unique.set(key, { schema, name });
  }
  return [...unique.values()].sort((left, right) => `${left.schema}.${left.name}`.localeCompare(`${right.schema}.${right.name}`, "de-AT"));
}

function normalizeColumns(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  if (rows.length > MAX_SQL_VIEW_COLUMNS) {
    throw sourceError(`SQL-Views d\u00fcrfen h\u00f6chstens ${MAX_SQL_VIEW_COLUMNS} Spalten bereitstellen.`, "SQL_VIEW_COLUMN_LIMIT", 413);
  }
  const seen = new Set();
  return rows.map((row, index) => {
    const name = normalizeSqlIdentifier(row?.name ?? row?.columnName ?? row?.[0], "Der SQL-Spaltenname");
    const key = name.toLocaleLowerCase("de-AT");
    if (seen.has(key)) throw sourceError("Die SQL-View enth\u00e4lt doppelte Spaltennamen.", "SQL_VIEW_COLUMN_DUPLICATE", 422);
    seen.add(key);
    const ordinalValue = Number(row?.ordinal ?? row?.ordinalPosition ?? row?.[1] ?? index + 1);
    const ordinal = Number.isInteger(ordinalValue) && ordinalValue > 0 ? ordinalValue : index + 1;
    const dataType = String(row?.dataType ?? row?.type ?? row?.[2] ?? "").trim().slice(0, 80);
    const nullableValue = row?.nullable ?? row?.isNullable ?? row?.[3];
    return { name, ordinal, dataType, nullable: nullableValue === true || String(nullableValue || "").toUpperCase() === "YES" };
  }).sort((left, right) => left.ordinal - right.ordinal);
}

function assertKnownView(views, schema, view) {
  const normalizedSchema = normalizeSqlIdentifier(schema, "Das SQL-Schema");
  const normalizedView = normalizeSqlIdentifier(view, "Der SQL-Viewname");
  const match = views.find((entry) => entry.schema.toLocaleLowerCase("de-AT") === normalizedSchema.toLocaleLowerCase("de-AT")
    && entry.name.toLocaleLowerCase("de-AT") === normalizedView.toLocaleLowerCase("de-AT"));
  if (!match) throw sourceError("Die ausgew\u00e4hlte SQL-View ist nicht freigegeben oder nicht mehr vorhanden.", "SQL_VIEW_NOT_FOUND", 404);
  return match;
}

function providerError(error, fallbackCode, fallbackMessage, fallbackStatus = 502) {
  if (error instanceof SqlViewSourceError) return error;
  return sourceError(fallbackMessage, fallbackCode, fallbackStatus);
}

function timedOperation(operation, timeoutMs, errorCode, errorMessage, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { options.onTimeout?.(); } catch {}
      reject(sourceError(errorMessage, errorCode, 504));
    }, timeoutMs);
    Promise.resolve()
      .then(operation)
      .then((value) => {
        if (settled) {
          Promise.resolve(options.onLateResolve?.(value)).catch(() => {});
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }, (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

function assertProvider(provider) {
  const methods = ["open", "close", "listViews", "listColumns", "readRows"];
  if (!provider || methods.some((method) => typeof provider[method] !== "function")) {
    throw sourceError("Der SQL-Provider ist unvollst\u00e4ndig.", "SQL_PROVIDER_INVALID", 500);
  }
  return provider;
}

async function closeQuietly(provider, connection) {
  if (!connection) return;
  try { await provider.close(connection); } catch {}
}

function createSqlViewSource(options = {}) {
  const defaultProvider = createSqlServerProvider({ loadTedious: options.loadTedious });
  const suppliedProviders = options.providers instanceof Map
    ? Object.fromEntries(options.providers)
    : (options.providers || {});
  const providers = new Map(Object.entries({ [SQL_SERVER_PROVIDER_ID]: defaultProvider, mssql: defaultProvider, ...suppliedProviders })
    .map(([id, provider]) => [String(id).toLowerCase(), assertProvider(provider)]));

  function providerFor(configuration) {
    const provider = providers.get(configuration.providerId);
    if (!provider) throw sourceError("Dieser SQL-Provider wird nicht unterst\u00fctzt.", "SQL_PROVIDER_UNSUPPORTED", 501);
    return provider;
  }

  async function withConnection(connector, credential, operation) {
    const configuration = normalizeSqlConnectorConfiguration(connector);
    const credentials = normalizeCredential(configuration, credential);
    const provider = providerFor(configuration);
    let connection;
    try {
      connection = await timedOperation(
        () => provider.open(configuration, credentials),
        configuration.connectionTimeoutMs,
        "SQL_CONNECTION_TIMEOUT",
        "Die Verbindung zur SQL-Datenquelle hat das Zeitlimit \u00fcberschritten.",
        { onLateResolve: (lateConnection) => closeQuietly(provider, lateConnection) },
      );
    } catch (error) {
      throw providerError(error, "SQL_CONNECTION_FAILED", "Die Verbindung zur SQL-Datenquelle konnte nicht hergestellt werden.");
    }

    const controller = new AbortController();
    let result;
    let failure = null;
    try {
      result = await timedOperation(
        () => operation(provider, connection, configuration, controller.signal),
        configuration.queryTimeoutMs,
        "SQL_QUERY_TIMEOUT",
        "Die SQL-Leseabfrage hat das Zeitlimit \u00fcberschritten.",
        { onTimeout: () => controller.abort() },
      );
    } catch (error) {
      failure = providerError(error, "SQL_QUERY_FAILED", "Die SQL-Datenquelle konnte nicht gelesen werden.");
    }
    try {
      await provider.close(connection);
    } catch (error) {
      if (!failure) failure = providerError(error, "SQL_CONNECTION_CLOSE_FAILED", "Die SQL-Verbindung konnte nicht sauber geschlossen werden.");
    }
    if (failure) throw failure;
    return result;
  }

  async function viewsFor(provider, connection, signal) {
    return normalizeViews(await provider.listViews(connection, { signal }));
  }

  async function columnsFor(provider, connection, schema, view, signal) {
    const views = await viewsFor(provider, connection, signal);
    const selectedView = assertKnownView(views, schema, view);
    const columns = normalizeColumns(await provider.listColumns(connection, { ...selectedView, signal }));
    if (!columns.length) throw sourceError("Die SQL-View besitzt keine lesbaren Spalten.", "SQL_VIEW_COLUMNS_EMPTY", 422);
    return { selectedView, columns };
  }

  return Object.freeze({
    async testConnection(connector, credential) {
      return withConnection(connector, credential, async () => ({ ok: true }));
    },

    async listViews(connector, credential) {
      return withConnection(connector, credential, async (provider, connection, _configuration, signal) => ({
        views: await viewsFor(provider, connection, signal),
      }));
    },

    async listColumns(connector, credential, selection = {}) {
      return withConnection(connector, credential, async (provider, connection, configuration, signal) => {
        const { selectedView, columns } = await columnsFor(provider, connection,
          selection.schema || configuration.schemaName, selection.view || configuration.objectName, signal);
        return { view: selectedView, columns };
      });
    },

    async readView(connector, credential, selection = {}) {
      const requestedColumns = normalizeRequestedColumns(selection.columns);
      return withConnection(connector, credential, async (provider, connection, configuration, signal) => {
        const maxRows = normalizeRowLimit(selection.maxRows ?? configuration.rowLimit);
        const { selectedView, columns } = await columnsFor(provider, connection,
          selection.schema || configuration.schemaName, selection.view || configuration.objectName, signal);
        const available = new Map(columns.map((column) => [column.name.toLocaleLowerCase("de-AT"), column]));
        const selectedColumns = requestedColumns.map((name) => {
          const column = available.get(name.toLocaleLowerCase("de-AT"));
          if (!column) throw sourceError(`Die SQL-Spalte \u201e${name}\u201c ist nicht mehr vorhanden.`, "SQL_VIEW_COLUMN_NOT_FOUND", 409);
          return column;
        });
        const providerResult = await provider.readRows(connection, {
          ...selectedView,
          columns: selectedColumns.map((column) => column.name),
          maxRows,
          signal,
        });
        const sourceRows = Array.isArray(providerResult) ? providerResult : providerResult?.rows;
        if (!Array.isArray(sourceRows)) throw sourceError("Die SQL-Datenzeilen sind ung\u00fcltig.", "SQL_VIEW_ROWS_INVALID", 502);
        if (sourceRows.length > maxRows) {
          throw sourceError(`Die SQL-View liefert mehr als ${maxRows} Zeilen. Bitte die View fachlich einschr\u00e4nken.`, "SQL_VIEW_ROW_LIMIT", 413);
        }
        const rows = sourceRows.map((row) => normalizedSqlRow(row, selectedColumns.length));
        const byteSize = sqlSnapshotByteSize(rows, selectedColumns.length);
        return { view: selectedView, columns: selectedColumns, rows, rowCount: rows.length, byteSize };
      });
    },
  });
}

function loadTediousModule(loader) {
  let tedious;
  try {
    tedious = (loader || (() => require("tedious")))();
  } catch {
    throw sourceError("Der optionale SQL-Server-Treiber ist nicht installiert.", "SQL_DRIVER_UNAVAILABLE", 503);
  }
  if (!tedious?.Connection || !tedious?.Request || !tedious?.TYPES?.NVarChar) {
    throw sourceError("Der SQL-Server-Treiber ist nicht kompatibel.", "SQL_DRIVER_INVALID", 503);
  }
  return tedious;
}

function tediousQuery(connection, tedious, sql, parameters = [], signal = null, options = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(sourceError("Die SQL-Leseabfrage wurde abgebrochen.", "SQL_QUERY_ABORTED", 499));
      return;
    }
    let settled = false;
    let columnMetadata = [];
    const rows = [];
    let byteSize = 2;
    let request;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => {
      try { request?.cancel(); } catch {}
      finish(sourceError("Die SQL-Leseabfrage wurde abgebrochen.", "SQL_QUERY_ABORTED", 499));
    };
    request = new tedious.Request(sql, (error) => {
      if (error) finish(error);
      else finish(null, { columns: columnMetadata, rows });
    });
    request.on("columnMetadata", (columns) => {
      columnMetadata = columns.map((column, index) => ({
        name: String(column.colName || `Spalte ${index + 1}`),
        ordinal: index + 1,
        dataType: String(column.type?.name || ""),
        nullable: Boolean(column.nullable),
      }));
    });
    request.on("row", (columns) => {
      if (settled) return;
      try {
        const values = columns.map((column) => column.value);
        const row = options.normalizeCells ? values.map(sqlCellText) : values;
        if (Number.isFinite(options.maxBytes)) {
          byteSize += Buffer.byteLength(JSON.stringify(row), "utf8") + (rows.length ? 1 : 0);
          if (byteSize > options.maxBytes) {
            try { request.cancel(); } catch {}
            finish(sourceError(
              `Die SQL-Vorschau ist gr\u00f6\u00dfer als ${Math.floor(options.maxBytes / (1024 * 1024))} MiB. Bitte die View fachlich einschr\u00e4nken.`,
              "SQL_VIEW_BYTE_LIMIT",
              413,
            ));
            return;
          }
        }
        rows.push(row);
      } catch (error) {
        try { request.cancel(); } catch {}
        finish(error);
      }
    });
    for (const parameter of parameters) {
      request.addParameter(parameter.name, tedious.TYPES.NVarChar, parameter.value);
    }
    signal?.addEventListener("abort", abort, { once: true });
    try { connection.execSql(request); } catch (error) { finish(error); }
  });
}

function createSqlServerProvider(options = {}) {
  return Object.freeze({
    async open(configuration, credential) {
      const tedious = loadTediousModule(options.loadTedious);
      const connection = new tedious.Connection({
        server: configuration.server,
        authentication: {
          type: "default",
          options: { userName: credential.username, password: credential.password },
        },
        options: {
          ...(configuration.instanceName ? { instanceName: configuration.instanceName } : { port: configuration.port }),
          database: configuration.database,
          encrypt: configuration.encrypt,
          trustServerCertificate: configuration.trustServerCertificate,
          connectTimeout: configuration.connectionTimeoutMs,
          requestTimeout: configuration.queryTimeoutMs,
          cancelTimeout: Math.min(5_000, configuration.queryTimeoutMs),
          appName: "Grabenplaner",
          readOnlyIntent: true,
          rowCollectionOnRequestCompletion: false,
        },
      });
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          connection.removeListener("connect", onConnect);
          if (error) {
            try { connection.close(); } catch {}
            reject(error);
          }
          else resolve(connection);
        };
        const onConnect = (error) => finish(error || null);
        const onError = (error) => { if (!settled) finish(error); };
        connection[SQL_SERVER_ERROR_LISTENER] = onError;
        connection.once("connect", onConnect);
        connection.on("error", onError);
        try { connection.connect(); } catch (error) { finish(error); }
      });
    },

    async close(connection) {
      if (!connection) return;
      connection.close();
    },

    async listViews(connection, { signal } = {}) {
      const tedious = loadTediousModule(options.loadTedious);
      const result = await tediousQuery(connection, tedious, SQL_SERVER_LIST_VIEWS, [], signal);
      return result.rows.map((row) => ({ schema: row[0], name: row[1] }));
    },

    async listColumns(connection, { schema, name, signal } = {}) {
      const tedious = loadTediousModule(options.loadTedious);
      const result = await tediousQuery(connection, tedious, SQL_SERVER_LIST_COLUMNS, [
        { name: "schema", value: schema },
        { name: "view", value: name },
      ], signal);
      return result.rows.map((row) => ({
        name: row[0], ordinal: row[1], dataType: row[2], nullable: String(row[3] || "").toUpperCase() === "YES",
      }));
    },

    async readRows(connection, { schema, name, columns, maxRows, signal } = {}) {
      const tedious = loadTediousModule(options.loadTedious);
      const sql = buildSqlServerViewSelect(schema, name, columns, maxRows);
      return (await tediousQuery(connection, tedious, sql, [], signal, {
        maxBytes: MAX_SQL_VIEW_BYTES,
        normalizeCells: true,
      })).rows;
    },
  });
}

module.exports = {
  MAX_SQL_VIEW_ROWS,
  MAX_SQL_VIEW_COLUMNS,
  MAX_SQL_VIEW_BYTES,
  SqlViewSourceError,
  normalizeSqlConnectorConfiguration,
  normalizeSqlIdentifier,
  quoteSqlServerIdentifier,
  buildSqlServerViewSelect,
  sqlCellText,
  createSqlServerProvider,
  createSqlViewSource,
};
