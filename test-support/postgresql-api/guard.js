"use strict";

function assertSyntheticEnvironment(environment = process.env) {
  const marker = environment.GP_CI_POSTGRESQL_FIXTURE;
  if (environment.GP_PG_API_FIXTURE_BRIDGE !== "1"
    || !["github-actions-service-v1", "owned-local-service-v1"].includes(marker)
    || marker === "github-actions-service-v1" && (environment.CI !== "true" || environment.GITHUB_ACTIONS !== "true")) {
    throw new Error("PG_API_FIXTURE_EXPLICIT_SYNTHETIC_ENVIRONMENT_REQUIRED");
  }
  const check = (value, database, username) => {
    const url = new URL(value || "");
    if (!["postgresql:", "postgres:"].includes(url.protocol) || url.hostname !== "127.0.0.1" || url.port !== "5432"
      || url.pathname !== "/" + database || decodeURIComponent(url.username) !== username || url.search || url.hash) {
      throw new Error("PG_API_FIXTURE_SYNTHETIC_ENDPOINT_REQUIRED");
    }
  };
  check(environment.TEST_POSTGRESQL_URL, "grabenplaner_test", "postgres");
  if (marker === "owned-local-service-v1") require("../postgresql-migration/owned-local-fixture").readOwnedLocalFixtureMarker(environment);
  for (const domain of ["core", "sales"]) for (const purpose of ["migrator", "app", "reader"]) {
    check(environment[`GP_${domain.toUpperCase()}_${purpose.toUpperCase()}_URL`], "gp_migration_" + domain, "gp_" + domain + "_" + purpose);
  }
  return true;
}

module.exports = { assertSyntheticEnvironment };
