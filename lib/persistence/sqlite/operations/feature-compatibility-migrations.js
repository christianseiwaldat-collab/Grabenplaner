"use strict";

function assertFunction(value, label) {
  if (typeof value !== "function") {
    throw new TypeError(`${label} muss eine Funktion sein.`);
  }
  return value;
}

function runSqliteFeatureCompatibilityMigrations(database, {
  appVersion,
  migrationState,
  normalizeAppFontScalePercent,
  defaultPortalSettings,
  passwordMinLength,
  installationFeatureIds,
  preV063DefaultInstallationFeatures,
  preV085DefaultInstallationFeatures,
} = {}) {
  if (!database || typeof database.exec !== "function" || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  const db = database;
  const packageMetadata = { version: String(appVersion || "") };
  const portalPasswordMinLength = () => passwordMinLength;
  assertFunction(normalizeAppFontScalePercent, "normalizeAppFontScalePercent");
  if (!(installationFeatureIds instanceof Set)) {
    throw new TypeError("installationFeatureIds muss ein Set sein.");
  }
  const {
    block7SettingsMigrationId,
    block7SettingsMigrationRequired,
    collectiveAgreementMigrationId,
    loanModuleMigrationId,
    payrollHandoffMigrationId,
    privacyGovernanceMigrationId,
    productReadinessMigrationId,
    workRuleGovernanceMigrationId,
    workRuleMigrationId,
  } = migrationState || {};

function migrateBlock7SettingsAppearance() {
  if (!block7SettingsMigrationRequired) return;
  const legacyRows = db.prepare(`
    SELECT employee_number, value, updated_at
    FROM portal_user_preferences
    WHERE preference_key = 'dashboard_font_size'
  `).all();
  const existingRows = db.prepare(`
    SELECT employee_number, value
    FROM portal_user_preferences
    WHERE preference_key = 'app_font_scale_percent'
  `).all();
  const insertPreference = db.prepare(`
    INSERT OR IGNORE INTO portal_user_preferences
      (employee_number, preference_key, value, updated_at)
    VALUES (?, 'app_font_scale_percent', ?, COALESCE(?, CURRENT_TIMESTAMP))
  `);
  const normalizePreference = db.prepare(`
    UPDATE portal_user_preferences
    SET value = ?, updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = ? AND preference_key = 'app_font_scale_percent'
  `);
  const roleRows = db.prepare("SELECT id, permissions FROM portal_roles").all();
  const updateRolePermissions = db.prepare(`
    UPDATE portal_roles
    SET permissions = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of legacyRows) {
      insertPreference.run(
        row.employee_number,
        String(normalizeAppFontScalePercent(row.value)),
        row.updated_at || null,
      );
    }
    for (const row of existingRows) {
      const normalized = String(normalizeAppFontScalePercent(row.value));
      if (normalized !== String(row.value)) normalizePreference.run(normalized, row.employee_number);
    }
    db.prepare("DELETE FROM portal_user_preferences WHERE preference_key = 'dashboard_font_size'").run();
    db.prepare("DELETE FROM portal_permission_grants WHERE permission = 'operation_mode:write'").run();
    db.prepare("DELETE FROM portal_permission_denials WHERE permission = 'operation_mode:write'").run();
    for (const role of roleRows) {
      let permissions;
      try { permissions = JSON.parse(role.permissions || "[]"); } catch { permissions = []; }
      if (!Array.isArray(permissions) || !permissions.includes("operation_mode:write")) continue;
      updateRolePermissions.run(
        JSON.stringify(permissions.filter((permission) => permission !== "operation_mode:write")),
        role.id,
      );
    }
    db.prepare("DELETE FROM settings WHERE key = 'operation_mode'").run();
    db.prepare("INSERT INTO schema_migrations (id, app_version, applied_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
      .run(block7SettingsMigrationId, packageMetadata.version);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

migrateBlock7SettingsAppearance();
db.prepare("DELETE FROM portal_permission_grants WHERE permission = 'operation_mode:write'").run();
db.prepare("DELETE FROM portal_permission_denials WHERE permission = 'operation_mode:write'").run();
db.prepare("DELETE FROM settings WHERE key = 'operation_mode'").run();
for (const role of db.prepare("SELECT id, permissions FROM portal_roles").all()) {
  let permissions;
  try { permissions = JSON.parse(role.permissions || "[]"); } catch { permissions = []; }
  if (!Array.isArray(permissions) || !permissions.includes("operation_mode:write")) continue;
  db.prepare("UPDATE portal_roles SET permissions = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(JSON.stringify(permissions.filter((permission) => permission !== "operation_mode:write")), role.id);
}

const insertPortalSetting = db.prepare("INSERT OR IGNORE INTO portal_settings (key, value) VALUES (?, ?)");
for (const [key, value] of Object.entries(defaultPortalSettings)) insertPortalSetting.run(key, value);
const localAmuRoutingMigrationId = "v0.71-local-amu-routing";
const localAmuRoutingMigrationNeeded = !db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1").get(localAmuRoutingMigrationId);
if (localAmuRoutingMigrationNeeded) {
  db.prepare(`
    INSERT INTO portal_settings (key, value, updated_at) VALUES ('amu_manager_file_access', '1', CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = CURRENT_TIMESTAMP
  `).run();
  db.prepare("INSERT INTO schema_migrations (id, app_version, applied_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
    .run(localAmuRoutingMigrationId, packageMetadata.version);
}
db.prepare("UPDATE portal_settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'password_min_length'")
  .run(String(portalPasswordMinLength()));
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.49-server-foundation", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.50-portal-notifications-amu", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.51-location-hours-scopes-request-ranges", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.52-time-tracking-amu-policies", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.53-rights-branding-time-corrections-mobile", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.54-protected-developer-role-rights", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.55-time-evaluation-day-review", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.56-wifi-automation-foundation", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.57-wifi-automation-suggestions", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.58-protected-personnel-records", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.59-sickness-ocr-notifications", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.60-portal-mobile-foundation", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.70-aum-security-foundation", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.70-sensitive-personnel-records", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.71-extended-personnel-records", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.71-personnel-field-rights", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.70-sickness-allowance-valuation", packageMetadata.version);
const integrationFeatureMigrationId = "v0.63-import-payroll-integrations";
if (!db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1").get(integrationFeatureMigrationId)) {
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'installation_features'").get()?.value;
  try {
    const configured = JSON.parse(String(stored || "[]"));
    if (Array.isArray(configured)) {
      const enabled = new Set(configured.filter((feature) => installationFeatureIds.has(feature)));
      const previouslyComplete = preV063DefaultInstallationFeatures.every((feature) => enabled.has(feature));
      if (previouslyComplete && !enabled.has("integrations")) {
        db.prepare("UPDATE settings SET value = ? WHERE key = 'installation_features'")
          .run(JSON.stringify([...configured, "integrations"]));
      }
    }
  } catch {}
  db.prepare("INSERT INTO schema_migrations (id, app_version) VALUES (?, ?)")
    .run(integrationFeatureMigrationId, packageMetadata.version);
}
if (!db.prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1").get(loanModuleMigrationId)) {
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'installation_features'").get()?.value;
  try {
    const configured = JSON.parse(String(stored || "[]"));
    if (Array.isArray(configured)) {
      const enabled = new Set(configured.filter((feature) => installationFeatureIds.has(feature)));
      const previouslyComplete = preV085DefaultInstallationFeatures.every((feature) => enabled.has(feature));
      if (previouslyComplete && !enabled.has("loans")) {
        db.prepare("UPDATE settings SET value = ? WHERE key = 'installation_features'")
          .run(JSON.stringify([...configured, "loans"]));
      }
    }
  } catch {}
  db.prepare("INSERT INTO schema_migrations (id, app_version) VALUES (?, ?)")
    .run(loanModuleMigrationId, packageMetadata.version);
}
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.64-sql-api-connectors", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.65-settings-dashboard-foundation", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.66-rights-dashboard", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.67-process-dashboard", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.68-dashboard-validation", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.69-integration-contracts", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.71-custom-processes-notifications", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.80-revocable-role-rights", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run(workRuleMigrationId, packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run(privacyGovernanceMigrationId, packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run(payrollHandoffMigrationId, packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run(productReadinessMigrationId, packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run(collectiveAgreementMigrationId, packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run(workRuleGovernanceMigrationId, packageMetadata.version);

const startupIntegrity = db.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)[0]);
if (!(startupIntegrity.length === 1 && startupIntegrity[0] === "ok")) {
  throw new Error(`Datenbank-Integritätsprüfung fehlgeschlagen: ${startupIntegrity.join("; ")}`);
}
  return Object.freeze({
    localAmuRoutingMigrationNeeded,
    startupIntegrity: Object.freeze([...startupIntegrity]),
  });
}

module.exports = {
  runSqliteFeatureCompatibilityMigrations,
};
