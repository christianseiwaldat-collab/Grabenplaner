"use strict";
const { createHash } = require("node:crypto");
const { SQLITE_APPLICATION_CATALOG } = require("../../catalogs/application-catalog");
const { compileCoreEntry } = require("./catalog");
const contract = require("../contracts/session-security-catalog-v1.json");
const sha = value => createHash("sha256").update(value).digest("hex");
const additions = contract.entries.filter(entry => entry.added);
const sources = SQLITE_APPLICATION_CATALOG.filter(entry => entry.statement.id.startsWith("portal-access.security.") || entry.statement.id.startsWith("organization-personnel.security."));
if (additions.length !== 4 || sources.length !== 4) throw new Error("Session security additional catalog drift");
const CATALOG = Object.freeze(sources.map(entry => {
  const locked = additions.find(item => item.statementId === entry.statement.id);
  const compiled = compileCoreEntry(entry);
  if (!locked || locked.sourceSqlSha256 !== sha(entry.sql)
    || locked.sourceContract !== compiled.provenance.sourceContract || locked.sqlSha256 !== compiled.provenance.sqlSha256
    || locked.parameterBindingsSha256 !== sha(JSON.stringify(compiled.providerEntry.parameterBindings))
    || locked.parameterOrderSha256 !== sha(JSON.stringify(compiled.providerEntry.parameterOrder))) {
    throw new Error("Session security additional catalog drift");
  }
  return Object.freeze(compiled.providerEntry);
}));
module.exports = { CATALOG };
