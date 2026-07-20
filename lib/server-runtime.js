"use strict";

const path = require("node:path");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function isLoopbackHost(value) {
  return LOOPBACK_HOSTS.has(String(value || "").trim().toLowerCase());
}

function parseServerPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : Number.NaN;
}

function parseBackupKeep(value, fallback = 30) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const keep = Number(value);
  return Number.isInteger(keep) && keep >= 1 && keep <= 1000 ? keep : Number.NaN;
}

function isNetworkPath(value) {
  const candidate = String(value || "").trim();
  return /^[\\/]{2}/.test(candidate) || /^\\\\\?\\UNC\\/i.test(candidate);
}

function isAbsoluteLocalPath(value) {
  const candidate = String(value || "").trim();
  if (!candidate || candidate === ":memory:" || isNetworkPath(candidate)) return false;
  return path.isAbsolute(candidate) || path.win32.isAbsolute(candidate);
}

function isServerBootstrapStartupAllowed(configuration = {}) {
  const operationMode = String(configuration.operationMode || "").trim().toLowerCase();
  const bootstrapMode = String(configuration.bootstrapMode || "").trim();
  const host = String(configuration.host || "").trim();
  const bootstrapToken = String(configuration.bootstrapToken || "").trim();
  return operationMode === "server"
    && bootstrapMode === "1"
    && host === "127.0.0.1"
    && bootstrapToken.length >= 32;
}

function isBootstrapRequestOriginAllowed(configuration = {}) {
  const port = parseServerPort(configuration.port);
  return configuration.bootstrapActive === true
    && configuration.loopbackRequest === true
    && Number.isInteger(port)
    && String(configuration.origin || "") === `http://127.0.0.1:${port}`;
}

function runtimeValidationErrors(configuration = {}) {
  const errors = [];
  const operationMode = String(configuration.operationMode || "").trim().toLowerCase();
  const nodeEnvironment = String(configuration.nodeEnvironment || "").trim().toLowerCase();
  const deploymentKind = String(configuration.deploymentKind || "").trim().toLowerCase();
  const trustProxy = String(configuration.trustProxy || "").trim().toLowerCase();

  if (!Number.isInteger(configuration.port) || configuration.port < 1 || configuration.port > 65535) {
    errors.push("PORT muss eine ganze Zahl zwischen 1 und 65535 sein.");
  }
  if (!Number.isInteger(configuration.backupKeep) || configuration.backupKeep < 1 || configuration.backupKeep > 1000) {
    errors.push("GRABENPLANER_BACKUP_KEEP muss eine ganze Zahl zwischen 1 und 1000 sein.");
  }
  if (operationMode !== "server") {
    if (deploymentKind === "production" && operationMode === "local"
      && String(configuration.bootstrapToken || "").trim().length < 32) {
      errors.push("GRABENPLANER_BOOTSTRAP_TOKEN muss fuer die lokale Admin-Ersteinrichtung mindestens 32 Zeichen lang sein.");
    }
    return errors;
  }

  if (!isLoopbackHost(configuration.host)) {
    errors.push("GRABENPLANER_HOST muss im Serverbetrieb auf 127.0.0.1, localhost oder ::1 gesetzt sein.");
  }
  if (trustProxy !== "loopback") {
    errors.push("GRABENPLANER_TRUST_PROXY muss im Serverbetrieb exakt auf loopback gesetzt sein.");
  }
  if (!isAbsoluteLocalPath(configuration.databasePath)) {
    errors.push("DB_PATH muss im Serverbetrieb auf eine lokale absolute SQLite-Datei zeigen; In-Memory- und Netzwerkpfade sind nicht erlaubt.");
  }
  if (!isAbsoluteLocalPath(configuration.dataRoot)) {
    errors.push("GRABENPLANER_DATA_DIR muss im Serverbetrieb auf ein lokales absolutes Datenverzeichnis zeigen; Netzwerkpfade sind nicht erlaubt.");
  }

  if (deploymentKind === "production") {
    if (nodeEnvironment !== "production") {
      errors.push("NODE_ENV muss für den produktiven HTTPS-Server auf production gesetzt sein.");
    }
    if (String(configuration.seedDemo || "") === "1" || String(configuration.demoProfile || "").trim()) {
      errors.push("Demo-Daten und Demo-Profile sind im produktiven HTTPS-Server nicht erlaubt.");
    }
    if (String(configuration.forcePortal || "") === "1") {
      errors.push("GRABENPLANER_FORCE_PORTAL ist im produktiven HTTPS-Server nicht erlaubt.");
    }
    if (String(configuration.allowUnscannedAmu || "") === "1") {
      errors.push("Ungeprüfte AUM-Uploads sind im produktiven HTTPS-Server nicht erlaubt.");
    }
    if (String(configuration.testAmuScanner || "").trim()) {
      errors.push("Der AUM-Testscanner ist im produktiven HTTPS-Server nicht erlaubt.");
    }
  } else if (deploymentKind === "codespaces-test") {
    if (nodeEnvironment !== "test") {
      errors.push("Der Codespaces-Testbetrieb ist ausschließlich mit NODE_ENV=test erlaubt.");
    }
  } else if (nodeEnvironment !== "test") {
    errors.push("GRABENPLANER_DEPLOYMENT_KIND muss fuer den produktiven HTTPS-Server auf production gesetzt sein.");
  }

  return errors;
}

function assertRuntimeConfiguration(configuration = {}) {
  const errors = runtimeValidationErrors(configuration);
  if (!errors.length) return;
  const error = new Error(`Serverstart abgebrochen: ${errors.join(" ")}`);
  error.code = "SERVER_RUNTIME_CONFIGURATION_INVALID";
  error.validationErrors = errors;
  throw error;
}

function createBoundedRateLimitStore({ windowMs, maxKeys = 2048, maxEventsPerKey = 300 } = {}) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new TypeError("windowMs must be positive");
  if (!Number.isInteger(maxKeys) || maxKeys < 1) throw new TypeError("maxKeys must be a positive integer");
  if (!Number.isInteger(maxEventsPerKey) || maxEventsPerKey < 1) throw new TypeError("maxEventsPerKey must be a positive integer");
  const buckets = new Map();

  function trim(values, now) {
    return (values || []).filter((timestamp) => Number.isFinite(timestamp) && now - timestamp < windowMs)
      .slice(-maxEventsPerKey);
  }

  function prune(now = Date.now()) {
    for (const [key, values] of buckets) {
      const recent = trim(values, now);
      if (!recent.length) buckets.delete(key);
      else if (recent.length !== values.length) buckets.set(key, recent);
    }
    while (buckets.size > maxKeys) buckets.delete(buckets.keys().next().value);
  }

  function get(key, now = Date.now()) {
    const normalizedKey = String(key || "unknown");
    const recent = trim(buckets.get(normalizedKey), now);
    if (!recent.length) buckets.delete(normalizedKey);
    else {
      buckets.delete(normalizedKey);
      buckets.set(normalizedKey, recent);
    }
    return [...recent];
  }

  function set(key, values, now = Date.now()) {
    const normalizedKey = String(key || "unknown");
    const recent = trim(values, now);
    buckets.delete(normalizedKey);
    if (recent.length) buckets.set(normalizedKey, recent);
    prune(now);
    return [...recent];
  }

  function record(key, now = Date.now()) {
    const recent = get(key, now);
    recent.push(now);
    return set(key, recent, now);
  }

  return {
    get,
    set,
    record,
    clear: (key) => buckets.delete(String(key || "unknown")),
    prune,
    get size() { return buckets.size; },
  };
}

module.exports = {
  assertRuntimeConfiguration,
  createBoundedRateLimitStore,
  isAbsoluteLocalPath,
  isBootstrapRequestOriginAllowed,
  isLoopbackHost,
  isNetworkPath,
  isServerBootstrapStartupAllowed,
  parseBackupKeep,
  parseServerPort,
  runtimeValidationErrors,
};
