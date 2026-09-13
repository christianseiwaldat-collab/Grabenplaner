"use strict";

const fs = require("node:fs");
const { validateBinding, PROFILE } = require("./runtime-binding");

const FILE = "/etc/grabenplaner/postgresql-application.json";
const ANCHOR = "/var/lib/grabenplaner/data/postgresql-pair.json";
const FORMAT = "grabenplaner-postgresql-application-v1";

function readProtectedJson(file, { gid, maximumBytes = 16384 } = {}) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== 0
      || (stat.mode & 0o037) || (gid !== undefined && stat.gid !== gid)
      || stat.size > maximumBytes || fs.realpathSync(file) !== file) {
    throw new Error("PG_APPLICATION_CONFIG_PERMISSIONS");
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function resolveDocument(document, anchor) {
  if (document?.format !== FORMAT || document.productActivation !== true
      || document.host !== "127.0.0.1" || document.port !== 55486
      || !/^[a-f0-9]{64}$/.test(document.sourceSha256 || "")
      || !/^[a-f0-9]{64}$/.test(document.applicationSha256 || "")
      || !Number.isFinite(Date.parse(document.activatedAt))) {
    throw new Error("PG_APPLICATION_ACTIVATION_REQUIRED");
  }
  const binding = validateBinding(document.binding);
  if (anchor?.format !== "grabenplaner-postgresql-pair-v1"
      || anchor.environmentId !== binding.environmentId || anchor.clusterId !== binding.clusterId
      || anchor.sourceSha256 !== document.sourceSha256 || anchor.applicationSha256 !== document.applicationSha256) {
    throw new Error("PG_APPLICATION_ANCHOR_MISMATCH");
  }
  const names = ["gp_core_app", "gp_core_reader", "gp_sales_app", "gp_sales_reader"];
  if (Object.keys(document.accounts || {}).sort().join(",") !== names.sort().join(",")
      || names.some(name => typeof document.accounts[name] !== "string" || document.accounts[name].length < 24)) {
    throw new Error("PG_APPLICATION_ACCOUNTS");
  }
  const urls = purpose => Object.fromEntries(["core", "sales"].map(domain => {
    const url = new URL(`postgresql://127.0.0.1:55486/grabenplaner_${domain}`);
    url.username = `gp_${domain}_${purpose}`;
    url.password = document.accounts[url.username];
    return [`${domain}Url`, url.href];
  }));
  return Object.freeze({
    providerId: "postgresql", databasePath: ANCHOR, databaseUrlConfigured: true,
    ...urls("app"), profile: PROFILE, binding,
    readers: Object.freeze({ ...urls("reader"), profile: PROFILE, binding }),
    productActivation: true, rehearsal: false,
  });
}

function configuration(environment) {
  if (process.platform !== "linux" || process.getuid() === 0
      || require('node:os').userInfo().username !== 'grabenplaner'
      || environment.NODE_ENV !== "production" || environment.GRABENPLANER_DEPLOYMENT_KIND !== "production"
      || environment.GRABENPLANER_POSTGRESQL_APPLICATION_CONFIG !== FILE
      || environment.GRABENPLANER_DATA_DIR !== "/var/lib/grabenplaner"
      || environment.DB_PATH !== ANCHOR || environment.DATABASE_URL
      || environment.GRABENPLANER_POSTGRESQL_REHEARSAL
      || !/^[a-f0-9]{32}$/.test(environment.INVOCATION_ID || "")) {
    throw new Error("PG_APPLICATION_MANAGED_RUNTIME_REQUIRED");
  }
  const document = readProtectedJson(FILE, { gid: process.getgid() });
  const anchor = readProtectedJson(ANCHOR, { gid: process.getgid() });
  return resolveDocument(document, anchor);
}

module.exports = { FILE, ANCHOR, FORMAT, configuration, resolveDocument, readProtectedJson };
