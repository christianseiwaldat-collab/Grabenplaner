"use strict";
const fs = require("node:fs");
const path = require("node:path");

function readOwnedLocalFixtureMarker(environment = process.env) {
  if (environment.GP_CI_POSTGRESQL_FIXTURE !== "owned-local-service-v1" || process.platform !== "linux") {
    throw new Error("PG_OWNED_LOCAL_FIXTURE_REQUIRED");
  }
  const file = environment.GP_PG_LOCAL_FIXTURE_MARKER;
  if (!file || !path.isAbsolute(file) || fs.realpathSync(file) !== file) throw new Error("PG_OWNED_LOCAL_MARKER_REQUIRED");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error("PG_OWNED_LOCAL_MARKER_UNSAFE");
  }
  const marker = JSON.parse(fs.readFileSync(file, "utf8"));
  if (marker.format !== "gp-postgresql-only-owned-local-v1" || marker.host !== "127.0.0.1"
    || marker.port !== 5432 || marker.database !== "grabenplaner_test" || !/^\d+$/.test(marker.clusterId || "")) {
    throw new Error("PG_OWNED_LOCAL_MARKER_INVALID");
  }
  return marker;
}

module.exports = { readOwnedLocalFixtureMarker };
