const express = require("express");
const PDFDocument = require("pdfkit");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const net = require("node:net");
const { promisify } = require("node:util");
const { createAmuStorage, syncEncryptedFilesBackup } = require("./lib/amu-storage");
const { prepareAmuDocument } = require("./lib/amu-processing");
const {
  validateSicknessDeadlines,
  sicknessDeadlineState,
  externalAlertNotBefore,
} = require("./lib/sickness-workflow");
const {
  createExternalNotificationAdapter,
  STAFFING_ALERT_TEXT,
} = require("./lib/external-notifications");
const { acquireDatabaseLock, lockPathForDatabase, releaseDatabaseLock } = require("./lib/database-lock");
const {
  assertRuntimeConfiguration,
  createBoundedRateLimitStore,
  parseBackupKeep,
  parseServerPort,
  runtimeValidationErrors,
} = require("./lib/server-runtime");
const {
  DEFAULT_PORTAL_GREETING_SETTINGS,
  PortalGreetingValidationError,
  resolvePortalGreeting,
  validatePortalGreetingSettings,
} = require("./lib/portal-greetings");
const {
  classifyRelease,
  compareVersions,
  normalizeVersionTag,
  releaseTagName,
  selectLatestRelease,
} = require("./lib/release-version");
const {
  configureSystemCertificateAuthorities,
  downloadGitHubReleaseAsset,
} = require("./lib/update-download");
const { populateUsbProfileDatabase } = require("./lib/usb-profile-database");
const {
  createSelectionToken,
  enumerateSafeUsbCandidates,
  evaluateUsbProvisioningAccess,
  expectedFormatConfirmation,
  hidePortableAppDirectory,
  provisionUsbStick,
  stagePortableInstallation,
  assertFormatConfirmation,
  verifySelectionToken,
  verifyTokenEnvelope,
} = require("./lib/usb-provisioning");
const { renderFirstStepsPdf } = require("./lib/first-steps-pdf");
const {
  MAX_IMPORT_BYTES,
  TabularDataError,
  inspectTabularBuffer,
  createCsvBuffer,
  createXlsxBuffer,
} = require("./lib/tabular-data");
const { IntegrationCache, IntegrationCacheError } = require("./lib/integration-cache");
const {
  publicPersonnelImportFields,
  suggestPersonnelMapping,
  normalizeMapping: normalizePersonnelImportMapping,
  normalizeProfileConfiguration,
  mappedPersonnelRow,
  headerFingerprint,
} = require("./lib/personnel-import");
const {
  normalizePayrollConfiguration,
  payrollCatalog,
  buildPayrollRows,
} = require("./lib/payroll-export");
const {
  normalizeIntegrationConnection,
  toPublicIntegrationConnection,
  integrationConnectionCatalog,
} = require("./lib/integration-connections");
const { createIntegrationSecretVault } = require("./lib/integration-secret-vault");
const { createSqlViewSource } = require("./lib/sql-view-source");
const { createIdempotencyKey, createSafeApiDelivery, payloadSha256 } = require("./lib/safe-api-delivery");
const { CONTRACT_IDS, contractById, contractSha256, contractSummaries } = require("./lib/integration-contracts");
const packageMetadata = require("./package.json");
const APP_NAME = "Grabenplaner";
const PORTAL_API_VERSION = 1;
const DEFAULT_OPERATION_MODE = "local";
const SERVER_MODE_STATUS = "active";
const LOCAL_PORTAL_PASSWORD_MIN_LENGTH = 6;
const SERVER_PORTAL_PASSWORD_MIN_LENGTH = 10;
const PORTAL_SESSION_COOKIE = "grabenplaner_session";
const PORTAL_CSRF_COOKIE = "grabenplaner_csrf";
const MOBILE_ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const MOBILE_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MOBILE_MAX_ACTIVE_SESSIONS = 5;
const MOBILE_ACCESS_TOKEN_PREFIX = "gpma1";
const MOBILE_REFRESH_TOKEN_PREFIX = "gpmr1";
const MOBILE_MINIMUM_APP_VERSION = "0.3.0-alpha.1";
const scryptAsync = promisify(crypto.scrypt);
const DUMMY_PORTAL_PASSWORD_HASH = `scrypt-v1$${Buffer.alloc(16, 0xa5).toString("base64url")}$${Buffer.alloc(64, 0x5a).toString("base64url")}`;
const usbProvisioningTokenSecret = crypto.randomBytes(32);
const consumedUsbProvisioningTokens = new Map();
let usbProvisioningActive = false;
const integrationCache = new IntegrationCache({
  ttlMs: 15 * 60 * 1000,
  maxEntries: 25,
  maxEntriesPerActor: 5,
  maxEntryBytes: 16 * 1024 * 1024,
  maxBytes: 64 * 1024 * 1024,
});

const delegablePortalPermissionCatalog = Object.freeze([
  { id: "schedule:read", label: "Dienstpläne lesen", group: "Dienstplanung", warningLevel: "normal", hrDelegable: true },
  { id: "schedule:write", label: "Dienstpläne bearbeiten", group: "Dienstplanung", warningLevel: "normal", hrDelegable: true },
  { id: "settings:write", label: "Planungs- und Grundeinstellungen bearbeiten", group: "Dienstplanung", warningLevel: "high", hrDelegable: true },
  { id: "employees:read", label: "Teamstammdaten lesen", group: "Teams & Standorte", warningLevel: "normal", hrDelegable: true },
  { id: "employees:display:write", label: "Teamfarben bearbeiten", description: "Nur die Farbe im Dienstplan; Name, Sollzeit und Personalstammdaten bleiben geschützt.", group: "Teams & Standorte", warningLevel: "normal", hrDelegable: true },
  { id: "employees:write", label: "Teamstammdaten vollständig bearbeiten", description: "Umfasst Namen, Sollstunden und weitere Personalstammdaten.", group: "Teams & Standorte", warningLevel: "critical" },
  { id: "departments:write", label: "Abteilungen anlegen und bearbeiten", group: "Teams & Standorte", warningLevel: "normal", hrDelegable: true },
  { id: "positions:write", label: "Positionen anlegen, bearbeiten und löschen", group: "Teams & Standorte", warningLevel: "high", hrDelegable: true },
  { id: "locations:write", label: "Standorte vollständig bearbeiten", group: "Teams & Standorte", warningLevel: "critical" },
  { id: "time:read", label: "Zeiterfassung des Bereichs lesen", group: "Zeit & Abwesenheit", warningLevel: "normal", hrDelegable: true },
  { id: "time:review", label: "Zeitbuchungen prüfen und korrigieren", group: "Zeit & Abwesenheit", warningLevel: "high", hrDelegable: true },
  { id: "time:settings", label: "Regeln der Zeiterfassung verwalten", description: "Buchungsort und Abweichungstoleranz je Standort.", group: "Zeit & Abwesenheit", warningLevel: "high", hrDelegable: true },
  { id: "vacation:read", label: "Urlaubs- und ZA-Anträge lesen", group: "Zeit & Abwesenheit", warningLevel: "normal", hrDelegable: true },
  { id: "vacation:approve", label: "Urlaubs- und ZA-Anträge bearbeiten", group: "Zeit & Abwesenheit", warningLevel: "high", hrDelegable: true },
  { id: "hr:approve", label: "Verbindliche PL-Freigaben erteilen", group: "Zeit & Abwesenheit", warningLevel: "critical" },
  { id: "hr:settings", label: "Antrags- und AUM-Regeln verwalten", group: "Zeit & Abwesenheit", warningLevel: "critical" },
  { id: "amu:metadata:read", label: "Geschützte AUM-Metadaten lesen", description: "Nur Personalleitung und höhere geschützte Rollen; nicht an Filial- oder Abteilungsleitung delegierbar.", group: "AUM", warningLevel: "critical", eligibleRoles: ["hr", "admin", "it_admin", "developer"] },
  { id: "amu:file:read", label: "AUM-Dokumente öffnen", description: "Besonders geschütztes Zusatzrecht für Personalleitung und höhere Rollen.", group: "AUM", warningLevel: "critical", eligibleRoles: ["hr", "admin", "it_admin", "developer"] },
  { id: "amu:review", label: "AUM-Meldungen prüfen", group: "AUM", warningLevel: "critical", eligibleRoles: ["hr", "admin", "it_admin", "developer"] },
  { id: "amu:delete", label: "AUM-Meldungen löschen", group: "AUM", warningLevel: "critical", eligibleRoles: ["hr", "admin", "it_admin", "developer"] },
  { id: "amu:audit", label: "AUM-Prüfprotokoll lesen", group: "AUM", warningLevel: "critical", eligibleRoles: ["hr", "admin", "it_admin", "developer"] },
  { id: "sickness:read", label: "Krankmeldungen im eigenen Bereich lesen", group: "AUM", warningLevel: "high", hrDelegable: true },
  { id: "sickness:settings", label: "Krankmeldungs- und AUM-Fristen verwalten", group: "AUM", warningLevel: "critical" },
  { id: "notifications:settings", label: "Eigene Besetzungswarnungen konfigurieren", group: "AUM", warningLevel: "normal", hrDelegable: true },
  { id: "integrations:read", label: "Schnittstellen und Laufprotokolle lesen", group: "Import & Lohnverrechnung", warningLevel: "high" },
  { id: "integrations:profiles:write", label: "Import- und Exportprofile verwalten", group: "Import & Lohnverrechnung", warningLevel: "high" },
  { id: "integrations:connections:read", label: "Direkte Verbindungen lesen", group: "Import & Lohnverrechnung", warningLevel: "high" },
  { id: "integrations:connections:write", label: "Direkte Verbindungen konfigurieren", description: "SQL-Quellen und HTTPS-Ziele ohne Offenlegung gespeicherter Zugangsdaten verwalten.", group: "Import & Lohnverrechnung", warningLevel: "critical" },
  { id: "integrations:credentials:write", label: "Zugangsdaten direkter Verbindungen ersetzen", description: "Geschützte Zugangsdaten neu setzen; gespeicherte Werte bleiben grundsätzlich unsichtbar.", group: "Import & Lohnverrechnung", warningLevel: "critical" },
  { id: "employees:import", label: "Personalstammdaten importieren", description: "CSV-/Excel-Import mit Vorschau; sensible Personalaktfelder sind ausgeschlossen.", group: "Import & Lohnverrechnung", warningLevel: "critical" },
  { id: "payroll:export", label: "Lohnverrechnungsdaten exportieren", description: "Zeit-, Abwesenheits- und Zuschlagsdaten als CSV oder Excel ausgeben.", group: "Import & Lohnverrechnung", warningLevel: "critical" },
  { id: "payroll:deliver", label: "Lohnverrechnungsdaten sicher übertragen", description: "Ausschließlich final geprüfte und minimierte Daten an ein vorkonfiguriertes HTTPS-Ziel übergeben.", group: "Import & Lohnverrechnung", warningLevel: "critical" },
  { id: "branding:read", label: "Branding-Verwaltung lesen", group: "System & Verwaltung", warningLevel: "high" },
  { id: "branding:write", label: "Brandings verwalten und zuweisen", group: "System & Verwaltung", warningLevel: "critical" },
  { id: "operation_mode:write", label: "Betriebsmodus umschalten", group: "System & Verwaltung", warningLevel: "critical" },
  { id: "backup:write", label: "Datenbanksicherungen verwalten", group: "System & Verwaltung", warningLevel: "critical" },
  { id: "update:write", label: "Grabenplaner aktualisieren", group: "System & Verwaltung", warningLevel: "critical" },
  { id: "system:write", label: "App neu starten oder beenden", group: "System & Verwaltung", warningLevel: "critical" },
]);
const delegablePortalPermissions = new Set(delegablePortalPermissionCatalog.map((entry) => entry.id));
const hrDelegablePortalPermissions = new Set(delegablePortalPermissionCatalog.filter((entry) => entry.hrDelegable).map((entry) => entry.id));
const protectedAmuPermissionIds = new Set(["amu:metadata:read", "amu:file:read", "amu:review", "amu:delete", "amu:audit"]);
const protectedAmuRoleIds = new Set(["hr", "admin", "it_admin", "developer"]);

function portalPermissionAllowedForRole(permission, role) {
  return !protectedAmuPermissionIds.has(String(permission || "")) || protectedAmuRoleIds.has(String(role || ""));
}

const portalDashboardPermissionDetails = Object.freeze([
  { id: "own_schedule:read", label: "Eigenen Dienstplan lesen", group: "Eigene Daten", scopeBehavior: "self" },
  { id: "own_time:read", label: "Eigene Zeiterfassung lesen", group: "Eigene Daten", scopeBehavior: "self" },
  { id: "own_time:write", label: "Eigene Arbeitszeit buchen", group: "Eigene Daten", scopeBehavior: "self" },
  { id: "own_time:correction_request", label: "Eigene Zeitkorrektur beantragen", group: "Eigene Daten", scopeBehavior: "self" },
  { id: "own_vacation:read", label: "Eigenen Urlaub lesen", group: "Eigene Daten", scopeBehavior: "self" },
  { id: "own_vacation:request", label: "Eigenen Urlaub beantragen", group: "Eigene Daten", scopeBehavior: "self" },
  { id: "own_amu:create", label: "Eigene AUM hochladen", group: "Eigene Daten", scopeBehavior: "self" },
  { id: "own_amu:read", label: "Eigene AUM-Meldungen lesen", group: "Eigene Daten", scopeBehavior: "self" },
  { id: "own_amu:withdraw", label: "Eigene AUM-Meldung zurückziehen", group: "Eigene Daten", scopeBehavior: "self" },
  { id: "own_sickness:create", label: "Eigene Krankmeldung erfassen", group: "Eigene Daten", scopeBehavior: "self" },
  { id: "own_sickness:read", label: "Eigene Krankmeldungen lesen", group: "Eigene Daten", scopeBehavior: "self" },
  { id: "notifications:settings", label: "Eigene Besetzungswarnungen konfigurieren", group: "Eigene Daten", scopeBehavior: "self" },
  { id: "wifi:settings", label: "WLAN-Zeitvorschläge verwalten", group: "Zeit & Abwesenheit", scopeBehavior: "global" },
  { id: "users:write", label: "Portal-Zugänge verwalten", group: "Zugänge & Rechte", scopeBehavior: "global" },
  { id: "roles:read", label: "App-Rollen lesen", group: "Zugänge & Rechte", scopeBehavior: "global" },
  { id: "roles:write", label: "App-Rollen verwalten", group: "Zugänge & Rechte", scopeBehavior: "global" },
  { id: "rights:read", label: "Rechteübersicht lesen", group: "Zugänge & Rechte", scopeBehavior: "global" },
  { id: "rights:write", label: "Individuelle Rechte verwalten", group: "Zugänge & Rechte", scopeBehavior: "global" },
  { id: "scopes:write", label: "Standort- und Abteilungsbereiche zuweisen", group: "Zugänge & Rechte", scopeBehavior: "global" },
  { id: "audit:read", label: "Prüfprotokolle lesen", group: "Zugänge & Rechte", scopeBehavior: "global" },
  { id: "usb:provision", label: "USB-Installationen vorbereiten", group: "System & Verwaltung", scopeBehavior: "global" },
  { id: "developer:system", label: "Geschützte Entwicklerfunktionen", group: "System & Verwaltung", scopeBehavior: "global" },
]);

const portalGlobalPermissionIds = new Set([
  "settings:write", "positions:write", "hr:approve", "hr:settings", "sickness:settings",
  "amu:metadata:read", "amu:file:read", "amu:review", "amu:delete", "amu:audit",
  "integrations:read", "integrations:profiles:write", "integrations:connections:read",
  "integrations:connections:write", "integrations:credentials:write", "branding:read", "branding:write",
  "operation_mode:write", "backup:write", "update:write", "system:write", "wifi:settings",
  "users:write", "roles:read", "roles:write", "rights:read", "rights:write", "scopes:write",
  "audit:read", "usb:provision", "developer:system",
]);

const builtinPortalRoles = [
  {
    id: "employee",
    name: "Mitarbeiter",
    description: "Eigener Dienstplan, eigene Zeiterfassung und eigene Urlaubsanträge.",
    sortOrder: 10,
    permissions: [
      "own_schedule:read",
      "own_time:read",
      "own_time:write",
      "own_time:correction_request",
      "own_vacation:read",
      "own_vacation:request",
      "own_amu:create",
      "own_amu:read",
      "own_amu:withdraw",
      "own_sickness:create",
      "own_sickness:read",
    ],
  },
  {
    id: "manager",
    name: "Filialleitung",
    description: "Dienstplanung sowie Prüfung von Zeitbuchungen und Urlaubsanträgen.",
    sortOrder: 20,
    permissions: [
      "own_schedule:read",
      "own_time:read",
      "own_time:write",
      "own_time:correction_request",
      "own_vacation:read",
      "own_vacation:request",
      "own_amu:create",
      "own_amu:read",
      "own_amu:withdraw",
      "own_sickness:create",
      "own_sickness:read",
      "employees:read",
      "schedule:read",
      "schedule:write",
      "time:read",
      "time:review",
      "vacation:read",
      "vacation:approve",
      "sickness:read",
      "notifications:settings",
      "scopes:write",
    ],
  },
  {
    id: "department_manager",
    name: "Abteilungsleitung",
    description: "Vertretende Antragsfreigabe bei Abwesenheit oder hinterlegter Delegation der Filialleitung.",
    sortOrder: 21,
    permissions: [
      "own_schedule:read", "own_time:read", "own_time:write", "own_time:correction_request",
      "own_vacation:read", "own_vacation:request", "own_amu:create", "own_amu:read", "own_amu:withdraw",
      "own_sickness:create", "own_sickness:read",
      "employees:read", "schedule:read", "schedule:write",
      "time:read", "time:review", "vacation:read", "vacation:approve",
      "sickness:read", "notifications:settings",
    ],
  },
  {
    id: "admin",
    name: "Admin",
    description: "Vollzugriff auf Benutzer, Einstellungen, Rollen und Protokolle.",
    sortOrder: 30,
    permissions: [
      "own_schedule:read",
      "own_time:read",
      "own_time:write",
      "own_time:correction_request",
      "own_vacation:read",
      "own_vacation:request",
      "own_amu:create",
      "own_amu:read",
      "own_amu:withdraw",
      "own_sickness:create",
      "own_sickness:read",
      "employees:read",
      "schedule:read",
      "schedule:write",
      "time:read",
      "time:review",
      "time:settings",
      "wifi:settings",
      "vacation:read",
      "vacation:approve",
      "settings:write",
      "branding:read",
      "branding:write",
      "rights:read",
      "rights:write",
      "operation_mode:write",
      "employees:write",
      "locations:write",
      "departments:write",
      "positions:write",
      "backup:write",
      "update:write",
      "system:write",
      "usb:provision",
      "users:write",
      "roles:read",
      "roles:write",
      "audit:read",
      "hr:approve",
      "hr:settings",
      "amu:metadata:read",
      "amu:file:read",
      "amu:review",
      "amu:delete",
      "amu:audit",
      "sickness:read",
      "sickness:settings",
      "notifications:settings",
      "integrations:read",
      "integrations:profiles:write",
      "integrations:connections:read",
      "employees:import",
      "payroll:export",
      "payroll:deliver",
      "scopes:write",
    ],
  },
  {
    id: "hr",
    name: "Personalleitung",
    description: "Standortübergreifende Prüfung von Urlaub und verbindlichem PL-Zeitausgleich.",
    sortOrder: 25,
    permissions: [
      "own_schedule:read",
      "own_time:read",
      "own_time:write",
      "own_time:correction_request",
      "own_vacation:read",
      "own_vacation:request",
      "own_amu:create",
      "own_amu:read",
      "own_amu:withdraw",
      "own_sickness:create",
      "own_sickness:read",
      "employees:read",
      "schedule:read",
      "time:read",
      "time:review",
      "time:settings",
      "wifi:settings",
      "vacation:read",
      "vacation:approve",
      "hr:approve",
      "hr:settings",
      "users:write",
      "settings:write",
      "branding:read",
      "branding:write",
      "rights:read",
      "rights:write",
      "operation_mode:write",
      "employees:write",
      "locations:write",
      "departments:write",
      "positions:write",
      "amu:metadata:read",
      "amu:file:read",
      "amu:review",
      "amu:delete",
      "amu:audit",
      "sickness:read",
      "sickness:settings",
      "notifications:settings",
      "integrations:read",
      "integrations:profiles:write",
      "integrations:connections:read",
      "employees:import",
      "payroll:export",
      "payroll:deliver",
      "scopes:write",
    ],
  },
];

const adminPortalRole = builtinPortalRoles.find((role) => role.id === "admin");
builtinPortalRoles.push(
  {
    id: "it_admin",
    name: "IT-Admin",
    description: "Technische Verwaltung von Zugängen, Serverbetrieb, Updates, Backups und delegierten Rechten.",
    sortOrder: 35,
    permissions: [
      "own_schedule:read", "own_time:read", "own_time:write", "own_time:correction_request",
      "own_vacation:read", "own_vacation:request", "own_amu:create", "own_amu:read", "own_amu:withdraw",
      "own_sickness:create", "own_sickness:read",
      "employees:read", "schedule:read", "rights:read", "rights:write",
      "employees:write",
      "operation_mode:write", "backup:write", "update:write", "system:write", "users:write",
      "usb:provision",
      "roles:read", "roles:write", "audit:read", "scopes:write", "wifi:settings",
      "hr:settings", "sickness:read", "sickness:settings", "notifications:settings",
      "integrations:read", "integrations:profiles:write", "integrations:connections:read",
      "integrations:connections:write", "integrations:credentials:write", "employees:import",
    ],
  },
  {
    id: "developer",
    name: "Developer",
    description: "Geschützter technischer Superuser; nur über das lokale Entwicklerwerkzeug bindbar.",
    sortOrder: 40,
    permissions: [...adminPortalRole.permissions, "integrations:connections:write", "integrations:credentials:write", "developer:system"],
  },
);

const GLOBAL_SCOPE_PORTAL_ROLES = new Set(["developer", "it_admin", "admin", "hr"]);
const RIGHTS_ADMIN_PORTAL_ROLES = new Set(["developer", "it_admin", "admin", "hr"]);
const HR_DECISION_PORTAL_ROLES = new Set(["developer", "admin", "hr"]);
const PROTECTED_PORTAL_ROLES = new Set(["developer"]);
const USB_PROVISIONING_ROLES = new Set(["developer", "it_admin", "admin"]);

const installationFeatureCatalog = Object.freeze([
  { id: "schedule", label: "Dienstplanung", required: true },
  { id: "vacation", label: "Urlaubsplanung" },
  { id: "requests", label: "Abwesenheitsanträge" },
  { id: "employeePortal", label: "Mitarbeiterportal" },
  { id: "timeTracking", label: "Zeiterfassung" },
  { id: "sicknessAmu", label: "Krankmeldung & AUM" },
  { id: "wifiSuggestions", label: "WLAN-Zeitvorschläge" },
  { id: "integrations", label: "Personalimport & Lohnverrechnung" },
]);
const installationFeatureIds = new Set(installationFeatureCatalog.map((feature) => feature.id));
const defaultInstallationFeatures = installationFeatureCatalog.map((feature) => feature.id);
const preV063DefaultInstallationFeatures = defaultInstallationFeatures.filter((feature) => feature !== "integrations");
const PORTAL_ROLE_ASSIGNMENTS = Object.freeze({
  developer: new Set(["employee", "department_manager", "manager", "hr", "admin", "it_admin"]),
  admin: new Set(["employee", "department_manager", "manager", "hr", "admin"]),
  it_admin: new Set(["employee", "department_manager", "manager", "hr"]),
  hr: new Set(["employee", "department_manager", "manager"]),
  manager: new Set(["department_manager"]),
});

const defaultPortalSettings = {
  login_required: "1",
  password_min_length: String(LOCAL_PORTAL_PASSWORD_MIN_LENGTH),
  session_timeout_minutes: "480",
  max_failed_login_attempts: "5",
  account_lock_minutes: "15",
  secure_cookies_required: "1",
  vacation_hr_approval_required: "0",
  amu_retention_days: "730",
  amu_upload_max_mb: "10",
  amu_stored_max_mb: "2",
  amu_convert_images_to_pdf: "1",
  amu_grayscale_images: "1",
  amu_ocr_enabled: "1",
  sickness_local_warning_days: "2",
  sickness_hr_warning_days: "3",
  wifi_minimum_presence_minutes: "5",
  wifi_absence_grace_minutes: "30",
  trust_levels_enabled: "1",
  trust_levels_visible_to_managers: "0",
  trust_levels_visible_to_department_managers: "0",
  trust_levels_visible_to_employees: "1",
  personalized_greetings: JSON.stringify(DEFAULT_PORTAL_GREETING_SETTINGS),
  mobile_leadership_layouts: JSON.stringify({
    department_manager: ["timeTracking", "team", "approvals", "schedule", "requests", "more"],
    manager: ["timeTracking", "team", "approvals", "schedule", "requests", "more"],
    hr: ["timeTracking", "approvals", "team", "schedule", "requests", "more"],
    admin: ["timeTracking", "approvals", "team", "schedule", "requests", "more"],
    it_admin: ["timeTracking", "team", "schedule", "requests", "more"],
    developer: ["timeTracking", "approvals", "team", "schedule", "requests", "more"],
  }),
};

function formatVersionLabel(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)-beta/);
  if (!match) return `v${version}`;
  return match[3] === "0" ? `v${match[1]}.${match[2]} Beta` : `v${match[1]}.${match[2]}.${match[3]} Beta`;
}

const APP_VERSION_LABEL = formatVersionLabel(packageMetadata.version);
const defaultBranding = {
  app_name: "Grabenplaner",
  company_name: "",
  logo_url: "/assets/grabenplaner-logo.svg",
  icon_url: "/assets/webicon.svg",
  logo_alt: "Grabenplaner",
  admin_email: "",
};

const portableDataDirectory = path.join(__dirname, "data");
const configuredDataRoot = String(process.env.GRABENPLANER_DATA_DIR || "").trim();
const environmentOperationMode = String(process.env.GRABENPLANER_OPERATION_MODE || "").trim().toLowerCase();
const serverDataRoot = configuredDataRoot
  ? path.resolve(configuredDataRoot)
  : path.join(process.env.ProgramData || path.join(os.homedir(), "AppData", "Local"), "Grabenplaner");
const runtimeConfigPath = environmentOperationMode === "server" || configuredDataRoot
  ? path.join(serverDataRoot, "runtime-config.json")
  : path.join(portableDataDirectory, "runtime-config.json");

function readRuntimeConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(runtimeConfigPath, "utf8").replace(/^\uFEFF/, ""));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeRuntimeConfig(values) {
  const next = { ...readRuntimeConfig(), ...values, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(runtimeConfigPath), { recursive: true });
  const temporaryPath = `${runtimeConfigPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, runtimeConfigPath);
  return next;
}

const runtimeConfig = readRuntimeConfig();
const configuredOperationMode = ["local", "lan", "server"].includes(environmentOperationMode)
  ? environmentOperationMode
  : (["local", "lan", "server"].includes(runtimeConfig.operationMode) ? runtimeConfig.operationMode : DEFAULT_OPERATION_MODE);
const serverModeActive = configuredOperationMode === "server";
const publicUrl = String(process.env.GRABENPLANER_PUBLIC_URL || runtimeConfig.publicUrl || "").trim().replace(/\/$/, "");
const trustProxySetting = String(process.env.GRABENPLANER_TRUST_PROXY || runtimeConfig.trustProxy || "loopback").trim() || "loopback";
const serviceControlToken = String(process.env.GRABENPLANER_SERVICE_CONTROL_TOKEN || "").trim();
const deploymentKind = String(process.env.GRABENPLANER_DEPLOYMENT_KIND || "local").trim().toLowerCase() || "local";
const codespacesForwardingDomain = String(process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || "app.github.dev")
  .trim().toLowerCase();
const app = express();
const configuredPortValue = process.env.PORT || runtimeConfig.port || 3000;
const PORT = parseServerPort(configuredPortValue);
const backupKeep = parseBackupKeep(process.env.GRABENPLANER_BACKUP_KEEP, 30);
const configuredHost = configuredOperationMode === "lan" ? "0.0.0.0" : "127.0.0.1";
const HOST = String(process.env.GRABENPLANER_HOST || configuredHost).trim() || "127.0.0.1";
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
const dataRootDirectory = serverModeActive || configuredDataRoot ? serverDataRoot : __dirname;
const dataDirectory = serverModeActive || configuredDataRoot ? path.join(dataRootDirectory, "data") : portableDataDirectory;
const databasePath = process.env.DB_PATH || path.join(dataDirectory, "dienstplan.db");
const appBackupDirectory = serverModeActive || configuredDataRoot ? path.join(dataRootDirectory, "backups") : path.join(__dirname, "backups");
const brandingKitsDirectory = serverModeActive || configuredDataRoot ? path.join(dataRootDirectory, "branding-kits") : path.join(dataDirectory, "branding-kits");
const privateDataDirectory = serverModeActive || configuredDataRoot ? path.join(dataRootDirectory, "private") : path.join(dataDirectory, "private");
const amuStorageDirectory = path.join(privateDataDirectory, "amu");
const defaultBackupDirectorySetting = "%USERPROFILE%\\Documents\\grabenplaner-backups";
const defaultBackupDirectory = process.env.BACKUP_DIR || path.join(os.homedir(), "Documents", "grabenplaner-backups");
const instanceLockPath = lockPathForDatabase(databasePath);

const runtimeConfiguration = {
  operationMode: configuredOperationMode,
  host: HOST,
  port: PORT,
  trustProxy: trustProxySetting,
  deploymentKind,
  nodeEnvironment: process.env.NODE_ENV,
  backupKeep,
  databasePath,
  dataRoot: dataRootDirectory,
  seedDemo: process.env.GRABENPLANER_SEED_DEMO,
  demoProfile: process.env.GRABENPLANER_DEMO_PROFILE,
  forcePortal: process.env.GRABENPLANER_FORCE_PORTAL,
  allowUnscannedAmu: process.env.GRABENPLANER_ALLOW_UNSCANNED_AMU,
  testAmuScanner: process.env.GRABENPLANER_TEST_AMU_SCANNER,
};
assertRuntimeConfiguration(runtimeConfiguration);

function normalizeHttpOrigin(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return "";
    const defaultPort = (parsed.protocol === 'https:' && parsed.port === '443')
      || (parsed.protocol === 'http:' && parsed.port === '80');
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.port && !defaultPort ? `:${parsed.port}` : ""}`;
  } catch {
    return "";
  }
}

const normalizedPublicOrigin = normalizeHttpOrigin(publicUrl);

function trustedCodespacesForwardedOrigin(request) {
  if (deploymentKind !== "codespaces-test" || !request.secure || !isLoopbackRequest(request)) return "";
  const configuredPortMarker = normalizedPublicOrigin
    ? new URL(normalizedPublicOrigin).hostname.match(/-(\d+)\./)?.[1]
    : "";
  const expectedHostnameSuffix = `-${configuredPortMarker || PORT}.${codespacesForwardingDomain}`;
  const hostCandidates = [
    String(request.headers.host || ""),
    String(request.headers["x-forwarded-host"] || "").split(",", 1)[0],
  ];

  for (const value of new Set(hostCandidates.map((entry) => entry.trim().toLowerCase()).filter(Boolean))) {
    if (!/^[a-z0-9.-]+(?::\d+)?$/.test(value)) continue;
    const candidate = normalizeHttpOrigin(`https://${value}`);
    if (!candidate) continue;
    const hostname = new URL(candidate).hostname;
    if (!codespacesForwardingDomain || !hostname.endsWith(expectedHostnameSuffix)) continue;
    return candidate;
  }
  return "";
}

function requestOriginAllowed(request, origin) {
  const normalizedOrigin = normalizeHttpOrigin(origin);
  if (!normalizedOrigin) return false;
  if (normalizedPublicOrigin && normalizedOrigin === normalizedPublicOrigin) return true;
  const forwardedOrigin = trustedCodespacesForwardedOrigin(request);
  return Boolean(forwardedOrigin && normalizedOrigin === forwardedOrigin);
}

if (serverModeActive) app.set("trust proxy", trustProxySetting);

function portalPasswordMinLength() {
  return serverModeActive ? SERVER_PORTAL_PASSWORD_MIN_LENGTH : LOCAL_PORTAL_PASSWORD_MIN_LENGTH;
}

fs.mkdirSync(path.dirname(databasePath), { recursive: true });
fs.mkdirSync(appBackupDirectory, { recursive: true });
fs.mkdirSync(brandingKitsDirectory, { recursive: true });
fs.mkdirSync(amuStorageDirectory, { recursive: true });

function loadPrivateSecret({ environmentName, fileName, bytes = 32, requiredInServerMode = false }) {
  const environmentValue = String(process.env[environmentName] || "").trim();
  if (environmentValue) return { value: environmentValue, source: "environment", path: "" };
  if (requiredInServerMode && serverModeActive) return null;
  const secretPath = path.join(privateDataDirectory, fileName);
  if (!fs.existsSync(secretPath)) {
    fs.mkdirSync(path.dirname(secretPath), { recursive: true });
    fs.writeFileSync(secretPath, `${crypto.randomBytes(bytes).toString("base64url")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  try { fs.chmodSync(secretPath, 0o600); } catch {}
  return { value: fs.readFileSync(secretPath, "utf8").trim(), source: "private-key-file", path: secretPath };
}

const wifiProviderId = String(process.env.GRABENPLANER_WIFI_PROVIDER_ID || "generic-radius")
  .trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 64) || "generic-radius";
const wifiIdentitySecret = loadPrivateSecret({
  environmentName: "GRABENPLANER_WIFI_IDENTITY_KEY",
  fileName: "wifi-identity.key",
  bytes: 32,
});
const wifiWebhookSecret = loadPrivateSecret({
  environmentName: "GRABENPLANER_WIFI_WEBHOOK_SECRET",
  fileName: "wifi-webhook.secret",
  bytes: 48,
  requiredInServerMode: true,
});

function loadAmuEncryptionConfiguration() {
  const keyId = String(process.env.GRABENPLANER_AMU_KEY_ID || (serverModeActive ? "" : "local-v1")).trim();
  const environmentKey = String(process.env.GRABENPLANER_AMU_KEY || "").trim();
  if (environmentKey && keyId) return { keyId, key: environmentKey, source: "environment" };
  if (serverModeActive) return null;
  const keyPath = path.join(privateDataDirectory, "amu-local.key");
  if (!fs.existsSync(keyPath)) {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, `${crypto.randomBytes(32).toString("base64")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  try { fs.chmodSync(keyPath, 0o600); } catch {}
  return { keyId, key: fs.readFileSync(keyPath, "utf8").trim(), source: "local-key-file", keyPath };
}

function loadIntegrationEncryptionConfiguration() {
  const keyId = String(process.env.GRABENPLANER_INTEGRATION_KEY_ID || (serverModeActive ? "" : "local-v1")).trim();
  const environmentKey = String(process.env.GRABENPLANER_INTEGRATION_KEY || "").trim();
  const environmentKeys = {};
  const keyRing = String(process.env.GRABENPLANER_INTEGRATION_KEYS || "").trim();
  if (keyRing) {
    try {
      const parsed = JSON.parse(keyRing);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid key ring");
      for (const [id, value] of Object.entries(parsed)) environmentKeys[String(id)] = String(value || "");
    } catch {
      throw new Error("GRABENPLANER_INTEGRATION_KEYS muss ein JSON-Objekt aus Schlüsselkennungen und 32-Byte-Schlüsseln sein.");
    }
  }
  if (environmentKey && keyId) environmentKeys[keyId] = environmentKey;
  if (keyId && environmentKeys[keyId]) return { keyId, keys: environmentKeys, source: "environment" };
  if (serverModeActive) return null;
  const keyPath = path.join(privateDataDirectory, "integration-local.key");
  if (!fs.existsSync(keyPath)) {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, `${crypto.randomBytes(32).toString("base64")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  try { fs.chmodSync(keyPath, 0o600); } catch {}
  return { keyId, keys: { [keyId]: fs.readFileSync(keyPath, "utf8").trim() }, source: "local-key-file", keyPath };
}

const integrationEncryptionConfiguration = loadIntegrationEncryptionConfiguration();
const integrationSecretVault = integrationEncryptionConfiguration
  ? createIntegrationSecretVault({
    activeKeyId: integrationEncryptionConfiguration.keyId,
    keys: integrationEncryptionConfiguration.keys,
  })
  : null;
const sqlViewSource = createSqlViewSource();
const amuEncryptionConfiguration = loadAmuEncryptionConfiguration();
let amuStorage = null;
let amuStorageStartupError = "";
let amuMutationInProgress = 0;
let amuScannerProbe = Promise.resolve(null);
if (amuEncryptionConfiguration) {
  try {
    amuStorage = createAmuStorage({
      rootDirectory: amuStorageDirectory,
      encryptionKeys: { [amuEncryptionConfiguration.keyId]: amuEncryptionConfiguration.key },
      activeKeyId: amuEncryptionConfiguration.keyId,
      scanner: process.env.NODE_ENV === "test" && process.env.GRABENPLANER_TEST_AMU_SCANNER === "clean"
        ? async () => ({ available: true, clean: true, engine: "test" })
        : null,
      requireScanner: serverModeActive && process.env.GRABENPLANER_ALLOW_UNSCANNED_AMU !== "1",
    });
    if (serverModeActive) {
      amuScannerProbe = amuStorage.probeScanner().catch((error) => {
        console.error("AUM-Virenscanner ist nicht betriebsbereit:", error.message);
        return null;
      });
    }
  } catch (error) {
    amuStorageStartupError = error.message;
  }
} else {
  amuStorageStartupError = "Im Serverbetrieb fehlt der konfigurierte AUM-Schlüssel.";
}

const externalNotificationAdapter = createExternalNotificationAdapter({ environment: process.env });

function safeRemoveFile(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o666);
  } catch {}
  fs.rmSync(filePath, { force: true });
}

function cleanupPortableInstallRoot() {
  if (serverModeActive) return;
  safeRemoveFile(path.join(__dirname, "public", "assets", ["lamp", "rechter_logo.webp"].join("")));
  if (fs.existsSync(path.join(__dirname, ".git"))) return;

  safeRemoveFile(path.join(__dirname, "public", "assets", "webicon.png"));
  safeRemoveFile(path.join(__dirname, "public", "assets", "webicon.ico"));

  const currentStartFile = `Grabenplaner ${APP_VERSION_LABEL} starten.cmd`;
  const docsDirectory = path.join(__dirname, "docs");
  fs.mkdirSync(docsDirectory, { recursive: true });

  for (const docName of ["README.md", "USB-HINWEISE.txt", "LICENSE.md"]) {
    const source = path.join(__dirname, docName);
    const target = path.join(docsDirectory, docName);
    if (fs.existsSync(source)) {
      try {
        fs.copyFileSync(source, target);
      } catch {}
      safeRemoveFile(source);
    }
  }

  for (const fileName of fs.readdirSync(__dirname)) {
    const filePath = path.join(__dirname, fileName);
    if (!fs.statSync(filePath).isFile()) continue;
    if (/^Grabenplaner v.+ Beta starten\.cmd$/i.test(fileName) && fileName !== currentStartFile) {
      safeRemoveFile(filePath);
      continue;
    }
    if ([".gitignore", "package-lock.json", "pnpm-lock.yaml"].includes(fileName)) {
      safeRemoveFile(filePath);
    }
  }
}

cleanupPortableInstallRoot();

const databaseExistedBeforeOpen = databasePath !== ":memory:" && fs.existsSync(databasePath);
let instanceLockHeld = false;
let instanceLockHandle = null;
acquireInstanceLock();
let db;
try {
  db = new DatabaseSync(databasePath);
} catch (error) {
  releaseInstanceLock();
  throw error;
}
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA wal_autocheckpoint = 1000");
let lastBackup = null;
let backupInterval = null;
let retentionInterval = null;
let scannerProbeInterval = null;
let sicknessSweepInterval = null;
let notificationDispatchInterval = null;
let rateLimitCleanupInterval = null;

function verifyDatabaseFile(filePath) {
  const verification = new DatabaseSync(filePath, { readOnly: true });
  try {
    const result = verification.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)[0]);
    const ok = result.length === 1 && result[0] === "ok";
    return { ok, result };
  } finally {
    verification.close();
  }
}

function backupTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function fileSha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function pruneDatabaseBackups(backupDirectory, keep = 30) {
  const backups = fs
    .readdirSync(backupDirectory)
    .filter((name) => /^dienstplan-.*\.db$/.test(name))
    .map((name) => ({ name, path: path.join(backupDirectory, name), time: fs.statSync(path.join(backupDirectory, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  for (const oldBackup of backups.slice(keep)) {
    const pairedAmuDirectory = path.join(backupDirectory, `${path.basename(oldBackup.name, ".db")}.amu`);
    fs.rmSync(oldBackup.path, { force: true });
    fs.rmSync(pairedAmuDirectory, { recursive: true, force: true });
  }
}

function createDatabaseBackupToDirectory(backupDirectory, reason = "automatic", kind = "external") {
  if (databasePath === ":memory:" || !fs.existsSync(databasePath)) return null;
  if (amuMutationInProgress > 0) throw new Error("Die Sicherung wartet, bis der laufende AUM-Upload abgeschlossen ist.");
  if (!amuStorage) throw new Error("Ohne betriebsbereiten AUM-Speicher wird kein unvollständiger Sicherungspunkt erstellt.");
  fs.mkdirSync(backupDirectory, { recursive: true });
  const snapshotName = `dienstplan-${backupTimestamp()}`;
  const target = path.join(backupDirectory, `${snapshotName}.db`);
  const amuTarget = path.join(backupDirectory, `${snapshotName}.amu`);
  const nonce = crypto.randomUUID();
  const temporaryDatabase = `${target}.partial-${nonce}`;
  const temporaryAmu = `${amuTarget}.partial-${nonce}`;
  let amuBackup = null;
  try {
    const escapedTarget = temporaryDatabase.replaceAll("\\", "/").replaceAll("'", "''");
    db.exec(`VACUUM INTO '${escapedTarget}'`);
    const verification = verifyDatabaseFile(temporaryDatabase);
    if (!verification.ok) throw new Error("Das erstellte Datenbank-Backup hat die Integritätsprüfung nicht bestanden.");
    const databaseHash = fileSha256(temporaryDatabase);
    amuBackup = syncEncryptedFilesBackup({
      sourceDirectory: amuStorageDirectory,
      targetDirectory: temporaryAmu,
      manifestMetadata: { database: { fileName: path.basename(target), sha256: databaseHash } },
    });
    fs.renameSync(temporaryAmu, amuTarget);
    fs.renameSync(temporaryDatabase, target);
    if (amuBackup) amuBackup.targetDirectory = amuTarget;
  } catch (error) {
    safeRemoveFile(temporaryDatabase);
    fs.rmSync(temporaryAmu, { recursive: true, force: true });
    fs.rmSync(amuTarget, { recursive: true, force: true });
    safeRemoveFile(target);
    throw error;
  }
  pruneDatabaseBackups(backupDirectory, backupKeep);
  return { path: target, createdAt: new Date().toISOString(), reason, kind, verified: true, amuBackup };
}

function createInternalDatabaseBackup(reason = "automatic") {
  return createDatabaseBackupToDirectory(appBackupDirectory, reason, "app");
}

function createExternalDatabaseBackup(reason = "automatic", settings = tableExists("settings") ? getSettings() : {}) {
  if (settings.external_backup_enabled === "0") return null;
  return createDatabaseBackupToDirectory(backupDirectoryFromSettings(settings), reason, "external");
}

function createDatabaseBackup(reason = "automatic") {
  const settings = tableExists("settings") ? getSettings() : {};
  const appBackup = createInternalDatabaseBackup(reason);
  const externalBackup = createExternalDatabaseBackup(reason, settings);
  lastBackup = {
    path: externalBackup?.path || appBackup?.path || null,
    createdAt: new Date().toISOString(),
    reason,
    appBackup,
    externalBackup,
  };
  return lastBackup;
}

function tableExists(name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function columnExists(table, column) {
  if (!tableExists(table)) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
}

function ensureColumn(table, column, definition) {
  if (tableExists(table) && !columnExists(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS locations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      min_staff INTEGER NOT NULL DEFAULT 0,
      day_settings_json TEXT NOT NULL DEFAULT '',
      time_tracking_enabled INTEGER NOT NULL DEFAULT 0,
      time_tracking_access_mode TEXT NOT NULL DEFAULT 'anywhere',
      time_tracking_allowed_networks TEXT NOT NULL DEFAULT '',
      time_tracking_variance_minutes INTEGER NOT NULL DEFAULT 15,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS location_branding (
      location_id TEXT PRIMARY KEY,
      kit_id TEXT NOT NULL DEFAULT 'custom',
      company_name TEXT NOT NULL DEFAULT '',
      logo_url TEXT NOT NULL DEFAULT '/assets/grabenplaner-logo.svg',
      icon_url TEXT NOT NULL DEFAULT '/assets/webicon.svg',
      logo_alt TEXT NOT NULL DEFAULT 'Grabenplaner',
      admin_email TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id TEXT NOT NULL,
      name TEXT NOT NULL,
      min_staff INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(location_id, name),
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS employees (
      personnel_number TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      nickname TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#0b84c6',
      contracted_hours REAL NOT NULL DEFAULT 38.5,
      preferred_day_off TEXT,
      fixed_workdays TEXT NOT NULL DEFAULT '',
      position_id TEXT NOT NULL DEFAULT 'verkaufsmitarbeiter',
      time_confirmation_level TEXT NOT NULL DEFAULT 'C',
      home_location_id TEXT,
      preferred_department_id INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (home_location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE SET NULL,
      FOREIGN KEY (preferred_department_id) REFERENCES departments(id)
        ON UPDATE CASCADE ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      builtin INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      department_id INTEGER,
      shift_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      area TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (department_id) REFERENCES departments(id)
        ON UPDATE CASCADE ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_shifts_date ON shifts(shift_date);
    CREATE INDEX IF NOT EXISTS idx_shifts_employee ON shifts(employee_number);

    CREATE TABLE IF NOT EXISTS week_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      group_id TEXT,
      week_start TEXT NOT NULL,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      option_type TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      credited_minutes_per_day INTEGER,
      all_day INTEGER NOT NULL DEFAULT 1,
      start_time TEXT,
      end_time TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_week_options_week ON week_options(week_start);

    CREATE TABLE IF NOT EXISTS global_day_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id TEXT NOT NULL DEFAULT '01',
      week_start TEXT NOT NULL,
      block_date TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      is_public_holiday INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(location_id, block_date),
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_global_day_blocks_week ON global_day_blocks(week_start);

    CREATE TABLE IF NOT EXISTS vacation_entitlements (
      employee_number TEXT NOT NULL,
      year INTEGER NOT NULL,
      days REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (employee_number, year),
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pdf_settings (
      scope_type TEXT NOT NULL,
      location_id TEXT NOT NULL,
      department_key TEXT NOT NULL DEFAULT '',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (scope_type, location_id, department_key, key),
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS schedule_notes (
      location_id TEXT NOT NULL,
      department_key TEXT NOT NULL DEFAULT '',
      week_start TEXT NOT NULL,
      note_text TEXT NOT NULL DEFAULT '',
      note_html TEXT NOT NULL DEFAULT '',
      font_size TEXT NOT NULL DEFAULT 'medium',
      bold INTEGER NOT NULL DEFAULT 0,
      italic INTEGER NOT NULL DEFAULT 0,
      underline INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (location_id, department_key, week_start),
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portal_users (
      employee_number TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'employee',
      role_locked INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      last_login_at TEXT,
      password_changed_at TEXT,
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portal_roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      builtin INTEGER NOT NULL DEFAULT 0,
      permissions TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS portal_sessions (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES portal_users(employee_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portal_user_preferences (
      employee_number TEXT NOT NULL,
      preference_key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (employee_number, preference_key),
      FOREIGN KEY (employee_number) REFERENCES portal_users(employee_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mobile_sessions (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      access_token_hash TEXT NOT NULL UNIQUE,
      access_expires_at TEXT NOT NULL,
      refresh_token_hash TEXT NOT NULL UNIQUE,
      previous_refresh_token_hash TEXT,
      refresh_expires_at TEXT NOT NULL,
      installation_id_hash TEXT NOT NULL,
      platform TEXT NOT NULL,
      device_label TEXT NOT NULL DEFAULT '',
      app_version TEXT NOT NULL DEFAULT '',
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TEXT,
      revoked_reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES portal_users(employee_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mobile_refresh_token_history (
      session_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      consumed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (session_id, token_hash),
      FOREIGN KEY (session_id) REFERENCES mobile_sessions(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portal_access_scopes (
      employee_number TEXT NOT NULL,
      location_id TEXT NOT NULL,
      department_id INTEGER NOT NULL DEFAULT 0,
      assigned_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (employee_number, location_id, department_id),
      FOREIGN KEY (employee_number) REFERENCES portal_users(employee_number) ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id) ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portal_permission_grants (
      employee_number TEXT NOT NULL,
      permission TEXT NOT NULL,
      granted_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (employee_number, permission),
      FOREIGN KEY (employee_number) REFERENCES portal_users(employee_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vacation_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS time_off_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      request_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      traffic_light TEXT NOT NULL DEFAULT 'yellow',
      check_reason TEXT NOT NULL DEFAULT '',
      option_id INTEGER,
      decided_by TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (option_id) REFERENCES week_options(id)
        ON UPDATE CASCADE ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS vacation_change_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      vacation_group_id TEXT NOT NULL,
      request_type TEXT NOT NULL,
      original_date_from TEXT NOT NULL,
      original_date_to TEXT NOT NULL,
      requested_date_from TEXT,
      requested_date_to TEXT,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS time_off_change_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      location_id TEXT,
      original_request_id INTEGER NOT NULL,
      request_type TEXT NOT NULL,
      requested_date_from TEXT,
      requested_date_to TEXT,
      requested_all_day INTEGER NOT NULL DEFAULT 0,
      requested_start_time TEXT,
      requested_end_time TEXT,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending_local',
      approval_type TEXT NOT NULL DEFAULT 'local',
      approval_stage TEXT NOT NULL DEFAULT 'local',
      decision_note TEXT NOT NULL DEFAULT '',
      local_approved_by TEXT,
      local_approved_at TEXT,
      hr_approved_by TEXT,
      hr_approved_at TEXT,
      decided_by TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (original_request_id) REFERENCES time_off_requests(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS request_blackouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id TEXT NOT NULL,
      department_id INTEGER,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      block_vacation INTEGER NOT NULL DEFAULT 1,
      block_time_off INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (department_id) REFERENCES departments(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS request_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_kind TEXT NOT NULL,
      request_id INTEGER NOT NULL,
      stage TEXT NOT NULL DEFAULT 'local',
      action TEXT NOT NULL,
      actor_employee_number TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS approval_delegations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id TEXT NOT NULL,
      delegate_employee_number TEXT NOT NULL,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (location_id) REFERENCES locations(id) ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (delegate_employee_number) REFERENCES employees(personnel_number) ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS time_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      location_id TEXT,
      department_id INTEGER,
      work_date TEXT NOT NULL DEFAULT '',
      entry_type TEXT NOT NULL,
      entry_timestamp TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'portal',
      note TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      voided_at TEXT,
      voided_by TEXT,
      void_reason TEXT NOT NULL DEFAULT '',
      correction_id INTEGER,
      client_request_id TEXT,
      mobile_session_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE SET NULL,
      FOREIGN KEY (department_id) REFERENCES departments(id)
        ON UPDATE CASCADE ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS time_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      location_id TEXT,
      department_id INTEGER,
      correction_date TEXT NOT NULL,
      requested_change TEXT NOT NULL DEFAULT '',
      request_note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT,
      decided_at TEXT,
      decision_note TEXT NOT NULL DEFAULT '',
      requested_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS time_day_reviews (
      employee_number TEXT NOT NULL,
      location_id TEXT NOT NULL,
      department_id INTEGER,
      department_key INTEGER NOT NULL DEFAULT 0,
      work_date TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      reviewed_by TEXT NOT NULL,
      reviewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      evaluation_version TEXT NOT NULL DEFAULT 'v1',
      snapshot_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (employee_number, work_date, department_key),
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (department_id) REFERENCES departments(id)
        ON UPDATE CASCADE ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS wifi_automation_preferences (
      employee_number TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      provider_id TEXT,
      external_subject_hash TEXT,
      opted_in_at TEXT,
      opted_out_at TEXT,
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wifi_presence_sessions (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      location_id TEXT NOT NULL,
      provider_id TEXT NOT NULL DEFAULT '',
      correlation_hash TEXT NOT NULL DEFAULT '',
      observed_start_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      disconnect_observed_at TEXT,
      observed_end_at TEXT,
      state TEXT NOT NULL DEFAULT 'observing',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS wifi_event_inbox (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      external_event_hash TEXT NOT NULL,
      event_type TEXT NOT NULL,
      external_subject_hash TEXT NOT NULL,
      location_reference_hash TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      payload_fingerprint TEXT NOT NULL DEFAULT '',
      processing_status TEXT NOT NULL DEFAULT 'pending',
      presence_session_id TEXT,
      processed_at TEXT,
      processing_error TEXT NOT NULL DEFAULT '',
      UNIQUE(provider_id, external_event_hash),
      FOREIGN KEY (presence_session_id) REFERENCES wifi_presence_sessions(id)
        ON UPDATE CASCADE ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS wifi_location_mappings (
      provider_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      external_location_hash TEXT NOT NULL,
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (provider_id, location_id),
      UNIQUE(provider_id, external_location_hash),
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wifi_time_suggestions (
      id TEXT PRIMARY KEY,
      presence_session_id TEXT NOT NULL,
      employee_number TEXT NOT NULL,
      location_id TEXT NOT NULL,
      work_date TEXT NOT NULL,
      suggested_start_at TEXT NOT NULL,
      suggested_end_at TEXT NOT NULL,
      confirmation_level_snapshot TEXT NOT NULL DEFAULT 'C',
      minimum_presence_minutes_snapshot INTEGER NOT NULL DEFAULT 5,
      absence_grace_minutes_snapshot INTEGER NOT NULL DEFAULT 30,
      confirmation_due_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      confirmed_start_at TEXT,
      confirmed_end_at TEXT,
      confirmed_break_start_at TEXT,
      confirmed_break_end_at TEXT,
      confirmed_by TEXT,
      confirmed_at TEXT,
      rejected_by TEXT,
      rejected_at TEXT,
      rejection_reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (presence_session_id) REFERENCES wifi_presence_sessions(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      UNIQUE(presence_session_id, work_date)
    );

    CREATE TABLE IF NOT EXISTS portal_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS portal_notifications (
      id TEXT PRIMARY KEY,
      recipient_employee_number TEXT NOT NULL,
      event_type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      target TEXT NOT NULL DEFAULT '',
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      dedupe_key TEXT,
      read_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (recipient_employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS amu_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sickness_case_id INTEGER,
      employee_number TEXT NOT NULL,
      location_id TEXT NOT NULL,
      department_id INTEGER,
      incapacity_from TEXT NOT NULL,
      incapacity_to TEXT NOT NULL,
      employee_note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'submitted',
      submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_by TEXT,
      reviewed_at TEXT,
      review_note TEXT NOT NULL DEFAULT '',
      retention_until TEXT,
      withdrawn_at TEXT,
      protected_payload TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (department_id) REFERENCES departments(id)
        ON UPDATE CASCADE ON DELETE SET NULL,
      FOREIGN KEY (sickness_case_id) REFERENCES sickness_cases(id)
        ON UPDATE CASCADE ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS amu_documents (
      id TEXT PRIMARY KEY,
      report_id INTEGER NOT NULL,
      storage_key TEXT NOT NULL UNIQUE,
      original_filename TEXT NOT NULL,
      detected_mime TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      scan_status TEXT NOT NULL DEFAULT 'pending',
      encryption_key_id TEXT NOT NULL,
      encryption_iv TEXT NOT NULL,
      encryption_tag TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      uploaded_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_by TEXT,
      deleted_at TEXT,
      purged_at TEXT,
      protected_payload TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (report_id) REFERENCES amu_reports(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sickness_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_lookup TEXT NOT NULL,
      status_lookup TEXT NOT NULL,
      protected_payload TEXT NOT NULL,
      purge_after TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sickness_alerts (
      id TEXT PRIMARY KEY,
      sickness_case_id INTEGER NOT NULL,
      status_lookup TEXT NOT NULL,
      protected_payload TEXT NOT NULL,
      purge_after TEXT NOT NULL,
      dedupe_lookup TEXT NOT NULL UNIQUE,
      FOREIGN KEY (sickness_case_id) REFERENCES sickness_cases(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sickness_notification_preferences (
      employee_number TEXT NOT NULL,
      channel TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      earliest_time TEXT NOT NULL DEFAULT '08:00',
      protected_destination TEXT NOT NULL DEFAULT '',
      verified_at TEXT,
      verification_hash TEXT NOT NULL DEFAULT '',
      verification_salt TEXT NOT NULL DEFAULT '',
      verification_expires_at TEXT,
      verification_attempts INTEGER NOT NULL DEFAULT 0,
      verification_sent_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (employee_number, channel),
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS outbound_notification_jobs (
      id TEXT PRIMARY KEY,
      recipient_lookup TEXT NOT NULL,
      channel TEXT NOT NULL,
      entity_lookup TEXT NOT NULL,
      protected_payload TEXT NOT NULL,
      not_before TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT NOT NULL DEFAULT '',
      sent_at TEXT,
      purge_after TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      dedupe_lookup TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS integration_profiles (
      id TEXT PRIMARY KEY,
      direction TEXT NOT NULL CHECK(direction IN ('import', 'export')),
      kind TEXT NOT NULL CHECK(kind IN ('personnel', 'payroll')),
      name TEXT NOT NULL COLLATE NOCASE,
      format TEXT NOT NULL CHECK(format IN ('csv', 'xlsx')),
      configuration_json TEXT NOT NULL DEFAULT '{}',
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(direction, kind, name)
    );

    CREATE TABLE IF NOT EXISTS integration_runs (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      direction TEXT NOT NULL CHECK(direction IN ('import', 'export')),
      kind TEXT NOT NULL CHECK(kind IN ('personnel', 'payroll')),
      format TEXT NOT NULL CHECK(format IN ('csv', 'xlsx')),
      content_sha256 TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'completed',
      total_count INTEGER NOT NULL DEFAULT 0,
      created_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      actor_employee_number TEXT NOT NULL DEFAULT '',
      options_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      error_code TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      FOREIGN KEY (profile_id) REFERENCES integration_profiles(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS integration_connections (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('personnel_sql_source', 'payroll_https_target')),
      name TEXT NOT NULL COLLATE NOCASE,
      provider TEXT NOT NULL,
      configuration_json TEXT NOT NULL DEFAULT '{}',
      protected_credentials TEXT NOT NULL DEFAULT '',
      credential_key_id TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      last_test_status TEXT NOT NULL DEFAULT '',
      last_test_at TEXT,
      last_error_code TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(kind, name)
    );

    CREATE TABLE IF NOT EXISTS integration_deliveries (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      profile_id TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      location_id TEXT NOT NULL,
      department_id TEXT NOT NULL DEFAULT '',
      connection_revision INTEGER NOT NULL DEFAULT 1,
      connection_fingerprint TEXT NOT NULL DEFAULT '',
      payload_sha256 TEXT NOT NULL,
      row_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'delivered', 'rejected', 'unknown')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      http_status INTEGER,
      error_code TEXT NOT NULL DEFAULT '',
      actor_employee_number TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (connection_id) REFERENCES integration_connections(id) ON DELETE RESTRICT,
      FOREIGN KEY (profile_id) REFERENCES integration_profiles(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      app_version TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_vacation_requests_employee ON vacation_requests(employee_number, status);
    CREATE INDEX IF NOT EXISTS idx_time_off_requests_employee ON time_off_requests(employee_number, status, request_date);
    CREATE INDEX IF NOT EXISTS idx_vacation_change_requests_employee ON vacation_change_requests(employee_number, status);
    CREATE INDEX IF NOT EXISTS idx_time_off_change_requests_employee ON time_off_change_requests(employee_number, status);
    CREATE INDEX IF NOT EXISTS idx_request_blackouts_range ON request_blackouts(location_id, date_from, date_to, active);
    CREATE INDEX IF NOT EXISTS idx_request_decisions_request ON request_decisions(request_kind, request_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_approval_delegations_range ON approval_delegations(location_id, date_from, date_to, active);
    CREATE INDEX IF NOT EXISTS idx_time_entries_employee_date ON time_entries(employee_number, entry_timestamp);
    CREATE INDEX IF NOT EXISTS idx_time_corrections_employee ON time_corrections(employee_number, status);
    CREATE INDEX IF NOT EXISTS idx_portal_notifications_recipient ON portal_notifications(recipient_employee_number, read_at, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_notifications_dedupe ON portal_notifications(recipient_employee_number, dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_amu_reports_employee ON amu_reports(employee_number, status, submitted_at);
    CREATE INDEX IF NOT EXISTS idx_amu_reports_location ON amu_reports(location_id, status, submitted_at);
    CREATE INDEX IF NOT EXISTS idx_amu_reports_retention ON amu_reports(retention_until, status);
    CREATE INDEX IF NOT EXISTS idx_amu_documents_report ON amu_documents(report_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_sickness_cases_employee ON sickness_cases(employee_lookup, status_lookup, created_at);
    CREATE INDEX IF NOT EXISTS idx_sickness_cases_retention ON sickness_cases(purge_after, status_lookup);
    CREATE INDEX IF NOT EXISTS idx_sickness_alerts_case ON sickness_alerts(sickness_case_id, status_lookup);
    CREATE INDEX IF NOT EXISTS idx_sickness_alerts_retention ON sickness_alerts(purge_after, status_lookup);
    CREATE INDEX IF NOT EXISTS idx_outbound_notification_jobs_due ON outbound_notification_jobs(status, not_before, created_at);
    CREATE INDEX IF NOT EXISTS idx_outbound_notification_jobs_retention ON outbound_notification_jobs(purge_after, status);
    CREATE INDEX IF NOT EXISTS idx_integration_profiles_kind ON integration_profiles(direction, kind, active, name);
    CREATE INDEX IF NOT EXISTS idx_integration_runs_started ON integration_runs(started_at DESC, direction, kind);
    CREATE INDEX IF NOT EXISTS idx_integration_runs_actor ON integration_runs(actor_employee_number, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_integration_connections_kind ON integration_connections(kind, active, name);
    CREATE INDEX IF NOT EXISTS idx_integration_deliveries_started ON integration_deliveries(started_at DESC, status);
    CREATE INDEX IF NOT EXISTS idx_integration_deliveries_connection ON integration_deliveries(connection_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_portal_users_role_active ON portal_users(role, active);
    CREATE INDEX IF NOT EXISTS idx_portal_sessions_employee ON portal_sessions(employee_number, expires_at);
    CREATE INDEX IF NOT EXISTS idx_portal_sessions_expiry ON portal_sessions(expires_at, revoked_at);
    CREATE INDEX IF NOT EXISTS idx_mobile_sessions_employee ON mobile_sessions(employee_number, refresh_expires_at);
    CREATE INDEX IF NOT EXISTS idx_mobile_sessions_expiry ON mobile_sessions(refresh_expires_at, revoked_at);
    CREATE INDEX IF NOT EXISTS idx_mobile_refresh_history_consumed ON mobile_refresh_token_history(consumed_at);
    CREATE INDEX IF NOT EXISTS idx_portal_permission_grants_employee ON portal_permission_grants(employee_number, permission);
  `);
}

function migrateLegacySchema() {
  if (!tableExists("employees") || columnExists("employees", "personnel_number")) return;

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      ALTER TABLE shifts RENAME TO shifts_legacy;
      ALTER TABLE employees RENAME TO employees_legacy;
    `);
    createSchema();
    db.exec(`
      INSERT INTO employees
        (personnel_number, full_name, nickname, color, contracted_hours, active, created_at)
      SELECT CAST(id AS TEXT), name, name, color, contracted_hours, active, created_at
      FROM employees_legacy;

      INSERT INTO shifts
        (id, employee_number, shift_date, start_time, end_time, area, note, created_at)
      SELECT id, CAST(employee_id AS TEXT), shift_date, start_time, end_time, area, note, created_at
      FROM shifts_legacy;

      DROP TABLE shifts_legacy;
      DROP TABLE employees_legacy;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

const protectedPersonnelMigrationRequired = tableExists("amu_reports") && (
  !columnExists("amu_reports", "protected_payload")
  || !columnExists("amu_documents", "protected_payload")
  || Boolean(db.prepare("SELECT 1 FROM amu_reports WHERE TRIM(COALESCE(protected_payload, '')) = '' LIMIT 1").get())
  || Boolean(db.prepare("SELECT 1 FROM amu_documents WHERE TRIM(COALESCE(protected_payload, '')) = '' AND status <> 'purged' LIMIT 1").get())
);
const unreleasedSicknessDraftSchemaPresent = tableExists("sickness_cases")
  && !columnExists("sickness_cases", "employee_lookup");
const legacySchemaMigrationRequired = tableExists("employees") && !columnExists("employees", "personnel_number");
const portalMobileBaselineMigrationRequired = !tableExists("schema_migrations")
  || !db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v0.60-portal-mobile-foundation' LIMIT 1").get();
if (databaseExistedBeforeOpen && (portalMobileBaselineMigrationRequired || protectedPersonnelMigrationRequired
  || unreleasedSicknessDraftSchemaPresent || legacySchemaMigrationRequired)) {
  createInternalDatabaseBackup("pre-migration");
}

if (unreleasedSicknessDraftSchemaPresent) {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (tableExists("amu_reports") && columnExists("amu_reports", "sickness_case_id")) {
      db.prepare("UPDATE amu_reports SET sickness_case_id = NULL").run();
    }
    db.exec(`
      DROP TABLE IF EXISTS outbound_notification_jobs;
      DROP TABLE IF EXISTS sickness_alerts;
      DROP TABLE IF EXISTS sickness_notification_preferences;
      DROP TABLE IF EXISTS sickness_cases;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

if (legacySchemaMigrationRequired) {
  migrateLegacySchema();
} else {
  createSchema();
}
createSchema();
ensureColumn("integration_connections", "revision", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("integration_deliveries", "connection_revision", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("integration_deliveries", "connection_fingerprint", "TEXT NOT NULL DEFAULT ''");
if (!columnExists("week_options", "group_id")) {
  db.exec("ALTER TABLE week_options ADD COLUMN group_id TEXT");
}
db.exec("CREATE INDEX IF NOT EXISTS idx_week_options_group ON week_options(group_id)");
if (!columnExists("week_options", "credited_minutes_per_day")) {
  db.exec("ALTER TABLE week_options ADD COLUMN credited_minutes_per_day INTEGER");
}
if (!columnExists("week_options", "all_day")) {
  db.exec("ALTER TABLE week_options ADD COLUMN all_day INTEGER NOT NULL DEFAULT 1");
}
if (!columnExists("week_options", "start_time")) {
  db.exec("ALTER TABLE week_options ADD COLUMN start_time TEXT");
}
if (!columnExists("week_options", "end_time")) {
  db.exec("ALTER TABLE week_options ADD COLUMN end_time TEXT");
}
if (!columnExists("employees", "preferred_day_off")) {
  db.exec("ALTER TABLE employees ADD COLUMN preferred_day_off TEXT");
}
if (!columnExists("employees", "fixed_workdays")) {
  db.exec("ALTER TABLE employees ADD COLUMN fixed_workdays TEXT NOT NULL DEFAULT ''");
}
if (!columnExists("employees", "position_id")) {
  db.exec("ALTER TABLE employees ADD COLUMN position_id TEXT NOT NULL DEFAULT 'verkaufsmitarbeiter'");
}
ensureColumn("employees", "time_confirmation_level", "TEXT NOT NULL DEFAULT 'C'");
ensureColumn("wifi_time_suggestions", "confirmed_start_at", "TEXT");
ensureColumn("wifi_time_suggestions", "confirmed_end_at", "TEXT");
ensureColumn("wifi_time_suggestions", "confirmed_break_start_at", "TEXT");
ensureColumn("wifi_time_suggestions", "confirmed_break_end_at", "TEXT");
ensureColumn("wifi_time_suggestions", "rejected_by", "TEXT");
ensureColumn("wifi_time_suggestions", "rejection_reason", "TEXT NOT NULL DEFAULT ''");
if (!columnExists("employees", "home_location_id")) {
  db.exec("ALTER TABLE employees ADD COLUMN home_location_id TEXT");
}
if (!columnExists("employees", "preferred_department_id")) {
  db.exec("ALTER TABLE employees ADD COLUMN preferred_department_id INTEGER");
}
if (tableExists("locations") && !columnExists("locations", "min_staff")) {
  db.exec("ALTER TABLE locations ADD COLUMN min_staff INTEGER NOT NULL DEFAULT 0");
}
ensureColumn("locations", "day_settings_json", "TEXT NOT NULL DEFAULT ''");
ensureColumn("locations", "time_tracking_enabled", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("locations", "time_tracking_access_mode", "TEXT NOT NULL DEFAULT 'anywhere'");
ensureColumn("locations", "time_tracking_allowed_networks", "TEXT NOT NULL DEFAULT ''");
ensureColumn("locations", "time_tracking_variance_minutes", "INTEGER NOT NULL DEFAULT 15");
if (tableExists("departments") && !columnExists("departments", "min_staff")) {
  db.exec("ALTER TABLE departments ADD COLUMN min_staff INTEGER NOT NULL DEFAULT 0");
}
if (tableExists("schedule_notes") && !columnExists("schedule_notes", "note_html")) {
  db.exec("ALTER TABLE schedule_notes ADD COLUMN note_html TEXT NOT NULL DEFAULT ''");
}
if (!columnExists("shifts", "department_id")) {
  db.exec("ALTER TABLE shifts ADD COLUMN department_id INTEGER");
}
ensureColumn("portal_users", "password_changed_at", "TEXT");
ensureColumn("portal_users", "failed_login_attempts", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("portal_users", "locked_until", "TEXT");
ensureColumn("portal_users", "role_locked", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("portal_roles", "description", "TEXT NOT NULL DEFAULT ''");
ensureColumn("portal_roles", "sort_order", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("portal_roles", "updated_at", "TEXT");
ensureColumn("time_entries", "location_id", "TEXT");
ensureColumn("time_entries", "department_id", "INTEGER");
ensureColumn("time_entries", "work_date", "TEXT NOT NULL DEFAULT ''");
ensureColumn("time_entries", "voided_at", "TEXT");
ensureColumn("time_entries", "voided_by", "TEXT");
ensureColumn("time_entries", "void_reason", "TEXT NOT NULL DEFAULT ''");
ensureColumn("time_entries", "correction_id", "INTEGER");
ensureColumn("time_entries", "client_request_id", "TEXT");
ensureColumn("time_entries", "mobile_session_id", "TEXT");
ensureColumn("time_corrections", "location_id", "TEXT");
ensureColumn("time_corrections", "department_id", "INTEGER");
ensureColumn("time_corrections", "request_note", "TEXT NOT NULL DEFAULT ''");
ensureColumn("time_corrections", "decision_note", "TEXT NOT NULL DEFAULT ''");
ensureColumn("time_corrections", "requested_by", "TEXT");
ensureColumn("time_day_reviews", "evaluation_version", "TEXT NOT NULL DEFAULT 'v1'");
ensureColumn("time_day_reviews", "snapshot_json", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("time_day_reviews", "department_key", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("amu_reports", "department_id", "INTEGER");
ensureColumn("amu_reports", "sickness_case_id", "INTEGER");
ensureColumn("amu_reports", "protected_payload", "TEXT NOT NULL DEFAULT ''");
ensureColumn("amu_documents", "protected_payload", "TEXT NOT NULL DEFAULT ''");
db.exec("CREATE INDEX IF NOT EXISTS idx_amu_reports_sickness_case ON amu_reports(sickness_case_id)");

function amuReportProtectionContext(row) {
  return {
    namespace: "personnel-record",
    recordId: String(row.id),
    field: "payload",
    employeeNumber: String(row.employee_number || ""),
  };
}

function amuDocumentProtectionContext(row) {
  return {
    namespace: "personnel-record-document",
    recordId: String(row.id),
    field: "payload",
    employeeNumber: String(row.employee_number || ""),
  };
}

function sicknessCaseProtectionContext(row) {
  return {
    namespace: "sickness-case",
    recordId: String(row.id),
    field: "payload",
    employeeNumber: String(row.employee_lookup || ""),
  };
}

function sicknessAlertProtectionContext(row) {
  return {
    namespace: "sickness-alert",
    recordId: String(row.id),
    field: "payload",
    employeeNumber: String(row.sickness_case_id || ""),
  };
}

function sicknessPreferenceProtectionContext(row) {
  return {
    namespace: "sickness-notification-preference",
    recordId: `${String(row.employee_number || "")}:${String(row.channel || "")}`,
    field: "destination",
    employeeNumber: String(row.employee_number || ""),
  };
}

function outboundNotificationProtectionContext(row) {
  return {
    namespace: "outbound-notification-job",
    recordId: String(row.id),
    field: "payload",
    employeeNumber: String(row.recipient_lookup || ""),
  };
}

function parseProtectedJson(value, context) {
  try {
    const text = requireAmuStorage().unprotectRecord(value, context);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid payload");
    return parsed;
  } catch (error) {
    if (tableExists("audit_log")) {
      auditPortal("system", "personnel-record.decrypt.failed", context.namespace || "personnel_record", String(context.recordId || ""), String(error.code || "invalid-payload"));
    }
    throw httpError(503, "Geschützte Personalakt-Daten konnten nicht sicher entschlüsselt werden.", error.code || "PERSONNEL_RECORD_INTEGRITY_FAILED");
  }
}

function protectJson(value, context) {
  return requireAmuStorage().protectRecord(JSON.stringify(value), context);
}

function migrateProtectedPersonnelRecords() {
  const reports = db.prepare("SELECT * FROM amu_reports ORDER BY id").all();
  const documents = db.prepare(`
    SELECT d.*, r.employee_number
    FROM amu_documents d JOIN amu_reports r ON r.id = d.report_id
    WHERE d.status <> 'purged'
    ORDER BY d.created_at, d.id
  `).all();
  const pendingReports = reports.filter((row) => !String(row.protected_payload || "").startsWith("enc:v2:"));
  const pendingDocuments = documents.filter((row) => !String(row.protected_payload || "").startsWith("enc:v2:"));
  if (!pendingReports.length && !pendingDocuments.length) {
    for (const row of reports) {
      if (row.protected_payload) parseProtectedJson(row.protected_payload, amuReportProtectionContext(row));
    }
    for (const row of documents) parseProtectedJson(row.protected_payload, amuDocumentProtectionContext(row));
    return { reports: 0, documents: 0 };
  }
  const storage = requireAmuStorage();
  const updateReport = db.prepare(`
    UPDATE amu_reports SET protected_payload = ?, incapacity_from = '', incapacity_to = '', employee_note = '',
      reviewed_by = NULL, reviewed_at = NULL, review_note = '', retention_until = NULL, withdrawn_at = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  const updateDocument = db.prepare(`
    UPDATE amu_documents SET protected_payload = ?, original_filename = '', detected_mime = 'application/octet-stream',
      byte_size = 0, sha256 = '', uploaded_by = ''
    WHERE id = ?
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of pendingReports) {
      const payload = {
        incapacityFrom: row.incapacity_from || "",
        incapacityTo: row.incapacity_to || "",
        employeeNote: storage.unprotectText(row.employee_note || ""),
        reviewedBy: row.reviewed_by || "",
        reviewedAt: row.reviewed_at || "",
        reviewNote: storage.unprotectText(row.review_note || ""),
        retentionUntil: row.retention_until || "",
        withdrawnAt: row.withdrawn_at || "",
      };
      updateReport.run(storage.protectRecord(JSON.stringify(payload), amuReportProtectionContext(row)), row.id);
    }
    for (const row of pendingDocuments) {
      const payload = {
        originalFilename: storage.unprotectText(row.original_filename || "") || "Dokument",
        detectedMime: row.detected_mime || "application/octet-stream",
        byteSize: Number(row.byte_size || 0),
        sha256: row.sha256 || "",
        uploadedBy: row.uploaded_by || "",
      };
      updateDocument.run(storage.protectRecord(JSON.stringify(payload), amuDocumentProtectionContext(row)), row.id);
    }
    db.prepare("INSERT OR REPLACE INTO schema_migrations (id, app_version, applied_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
      .run("v0.58-protected-personnel-records", packageMetadata.version);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { reports: pendingReports.length, documents: pendingDocuments.length };
}

migrateProtectedPersonnelRecords();
db.exec("CREATE INDEX IF NOT EXISTS idx_time_entries_work_date ON time_entries(employee_number, work_date, entry_timestamp)");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_time_entries_mobile_request ON time_entries(employee_number, client_request_id) WHERE client_request_id IS NOT NULL");
db.exec("CREATE INDEX IF NOT EXISTS idx_mobile_sessions_employee ON mobile_sessions(employee_number, refresh_expires_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_mobile_sessions_expiry ON mobile_sessions(refresh_expires_at, revoked_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_mobile_refresh_history_consumed ON mobile_refresh_token_history(consumed_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_time_entries_location_date ON time_entries(location_id, work_date, entry_timestamp)");
db.exec("CREATE INDEX IF NOT EXISTS idx_time_corrections_context ON time_corrections(location_id, department_id, status, correction_date)");
db.exec("CREATE INDEX IF NOT EXISTS idx_time_corrections_pending_employee_date ON time_corrections(employee_number, correction_date, status)");
db.exec("CREATE INDEX IF NOT EXISTS idx_time_day_reviews_context ON time_day_reviews(location_id, department_id, work_date)");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_wifi_preference_external_subject ON wifi_automation_preferences(provider_id, external_subject_hash) WHERE TRIM(COALESCE(external_subject_hash, '')) <> ''");
db.exec("CREATE INDEX IF NOT EXISTS idx_wifi_presence_employee_state ON wifi_presence_sessions(employee_number, state, observed_start_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_wifi_presence_location_state ON wifi_presence_sessions(location_id, state, observed_start_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_wifi_event_inbox_processing ON wifi_event_inbox(processing_status, received_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_wifi_suggestions_employee_date ON wifi_time_suggestions(employee_number, work_date, status)");
db.exec("CREATE INDEX IF NOT EXISTS idx_wifi_location_mapping_hash ON wifi_location_mappings(provider_id, external_location_hash)");
db.prepare("UPDATE time_entries SET work_date = SUBSTR(entry_timestamp, 1, 10) WHERE TRIM(COALESCE(work_date, '')) = ''").run();
db.prepare(`
  UPDATE time_entries
  SET location_id = (SELECT e.home_location_id FROM employees e WHERE e.personnel_number = time_entries.employee_number)
  WHERE TRIM(COALESCE(location_id, '')) = ''
`).run();
db.prepare(`
  UPDATE time_entries
  SET department_id = COALESCE(
    (SELECT s.department_id FROM shifts s
      WHERE s.employee_number = time_entries.employee_number AND s.shift_date = time_entries.work_date AND s.department_id IS NOT NULL
      ORDER BY s.start_time, s.id LIMIT 1),
    (SELECT e.preferred_department_id FROM employees e WHERE e.personnel_number = time_entries.employee_number)
  )
  WHERE department_id IS NULL
`).run();
db.prepare(`
  UPDATE time_corrections
  SET location_id = COALESCE(
    (SELECT t.location_id FROM time_entries t
      WHERE t.employee_number = time_corrections.employee_number AND t.work_date = time_corrections.correction_date
        AND TRIM(COALESCE(t.location_id, '')) <> ''
      ORDER BY t.entry_timestamp, t.id LIMIT 1),
    (SELECT e.home_location_id FROM employees e WHERE e.personnel_number = time_corrections.employee_number)
  )
  WHERE TRIM(COALESCE(location_id, '')) = ''
`).run();
db.prepare(`
  UPDATE time_corrections
  SET department_id = COALESCE(
    (SELECT t.department_id FROM time_entries t
      WHERE t.employee_number = time_corrections.employee_number AND t.work_date = time_corrections.correction_date
        AND t.department_id IS NOT NULL
      ORDER BY t.entry_timestamp, t.id LIMIT 1),
    (SELECT s.department_id FROM shifts s
      WHERE s.employee_number = time_corrections.employee_number AND s.shift_date = time_corrections.correction_date
        AND s.department_id IS NOT NULL
      ORDER BY s.start_time, s.id LIMIT 1),
    (SELECT e.preferred_department_id FROM employees e WHERE e.personnel_number = time_corrections.employee_number)
  )
  WHERE department_id IS NULL
`).run();
db.prepare(`
  UPDATE time_corrections SET requested_by = employee_number
  WHERE TRIM(COALESCE(requested_by, '')) = ''
`).run();
ensureColumn("vacation_requests", "vacation_group_id", "TEXT");
ensureColumn("vacation_requests", "location_id", "TEXT");
ensureColumn("vacation_requests", "approval_stage", "TEXT NOT NULL DEFAULT 'local'");
ensureColumn("vacation_requests", "decision_note", "TEXT NOT NULL DEFAULT ''");
ensureColumn("vacation_requests", "local_approved_by", "TEXT");
ensureColumn("vacation_requests", "local_approved_at", "TEXT");
ensureColumn("vacation_requests", "hr_approved_by", "TEXT");
ensureColumn("vacation_requests", "hr_approved_at", "TEXT");
ensureColumn("time_off_requests", "location_id", "TEXT");
ensureColumn("time_off_requests", "approval_type", "TEXT NOT NULL DEFAULT 'local'");
ensureColumn("time_off_requests", "approval_stage", "TEXT NOT NULL DEFAULT 'local'");
ensureColumn("time_off_requests", "decision_note", "TEXT NOT NULL DEFAULT ''");
ensureColumn("time_off_requests", "local_approved_by", "TEXT");
ensureColumn("time_off_requests", "local_approved_at", "TEXT");
ensureColumn("time_off_requests", "hr_approved_by", "TEXT");
ensureColumn("time_off_requests", "hr_approved_at", "TEXT");
ensureColumn("time_off_requests", "original_shifts_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("time_off_requests", "date_from", "TEXT");
ensureColumn("time_off_requests", "date_to", "TEXT");
ensureColumn("time_off_requests", "all_day", "INTEGER NOT NULL DEFAULT 0");
db.prepare("UPDATE time_off_requests SET date_from = COALESCE(date_from, request_date), date_to = COALESCE(date_to, request_date) WHERE date_from IS NULL OR date_to IS NULL").run();
ensureColumn("vacation_change_requests", "approval_stage", "TEXT NOT NULL DEFAULT 'local'");
ensureColumn("vacation_change_requests", "decision_note", "TEXT NOT NULL DEFAULT ''");
ensureColumn("vacation_change_requests", "local_approved_by", "TEXT");
ensureColumn("vacation_change_requests", "local_approved_at", "TEXT");
ensureColumn("vacation_change_requests", "hr_approved_by", "TEXT");
ensureColumn("vacation_change_requests", "hr_approved_at", "TEXT");
db.exec("CREATE INDEX IF NOT EXISTS idx_portal_users_role_active ON portal_users(role, active)");

function rebuildGlobalDayBlocksForLocations() {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec("ALTER TABLE global_day_blocks RENAME TO global_day_blocks_legacy");
    db.exec(`
      CREATE TABLE global_day_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        location_id TEXT NOT NULL DEFAULT '01',
        week_start TEXT NOT NULL,
        block_date TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        is_public_holiday INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(location_id, block_date),
        FOREIGN KEY (location_id) REFERENCES locations(id)
          ON UPDATE CASCADE ON DELETE CASCADE
      );
    `);
    db.exec(`
      INSERT OR IGNORE INTO global_day_blocks
        (id, location_id, week_start, block_date, reason, is_public_holiday, created_at)
      SELECT id, '18', week_start, block_date, reason, is_public_holiday, created_at
      FROM global_day_blocks_legacy;
      DROP TABLE global_day_blocks_legacy;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

if (!columnExists("global_day_blocks", "location_id")) {
  rebuildGlobalDayBlocksForLocations();
}
db.exec("CREATE INDEX IF NOT EXISTS idx_global_day_blocks_location_week ON global_day_blocks(location_id, week_start)");

const defaultSettings = {
  installation_features: JSON.stringify(defaultInstallationFeatures),
  branding_management_kit_id: "",
  branding_company_name: defaultBranding.company_name,
  branding_logo_url: defaultBranding.logo_url,
  branding_icon_url: defaultBranding.icon_url,
  branding_logo_alt: defaultBranding.logo_alt,
  branding_admin_email: defaultBranding.admin_email,
  operation_mode: DEFAULT_OPERATION_MODE,
  pdf_title: "Dienstplan",
  pdf_filename_prefix: "Dienstplan",
  pdf_filename_include_kw: "1",
  pdf_filename_include_timestamp: "0",
  vacation_pdf_title: "Urlaubsplanung",
  vacation_pdf_filename_prefix: "Urlaubsplanung",
  vacation_pdf_filename_include_period: "1",
  vacation_pdf_filename_include_timestamp: "0",
  vacation_pdf_show_balance: "1",
  vacation_pdf_balance_show_entitlement: "1",
  vacation_pdf_balance_show_planned: "1",
  vacation_pdf_balance_show_consumed: "0",
  vacation_pdf_calendar_style: "bars",
  toast_duration: "medium",
  show_inactive_personnel: "0",
  show_saturday_service_stats: "1",
  external_backup_enabled: "1",
  backup_directory: process.env.BACKUP_DIR || defaultBackupDirectorySetting,
  backup_interval_hours: "2",
  vacation_count_saturday: "0",
  vacation_pdf_size: "A4",
  allow_past_week_editing: "0",
  current_week_auto_lock: "1",
  current_week_lock_mode: "closing",
  current_week_lock_day: "saturday",
  current_week_lock_time: "17:00",
  break_rule_enabled: "1",
  break_after_minutes: "360",
  break_duration_minutes: "30",
  saturday_bonus_enabled: "1",
  saturday_bonus_from: "13:00",
  saturday_bonus_factor: "1.5",
  weekday_start_time: "09:00",
  weekday_end_time: "18:00",
  saturday_start_time: "10:00",
  saturday_end_time: "17:00",
  show_sunday: "0",
  remember_last_schedule_overall_plan: "1",
  remember_last_vacation_overall_plan: "1",
};

const planningDays = [
  ["monday", "09:00", "18:00"],
  ["tuesday", "09:00", "18:00"],
  ["wednesday", "09:00", "18:00"],
  ["thursday", "09:00", "18:00"],
  ["friday", "09:00", "18:00"],
  ["saturday", "10:00", "17:00"],
];
const fixedWorkdayKeys = planningDays.map(([day]) => day);

for (const [day, start, end] of planningDays) {
  defaultSettings[`${day}_open`] = "1";
  defaultSettings[`${day}_start_time`] = start;
  defaultSettings[`${day}_end_time`] = end;
  defaultSettings[`${day}_lunch_enabled`] = "0";
  defaultSettings[`${day}_lunch_start`] = "13:00";
  defaultSettings[`${day}_lunch_end`] = "14:00";
  defaultSettings[`${day}_min_staff`] = "0";
  defaultSettings[`${day}_min_from`] = start;
  defaultSettings[`${day}_min_to`] = end;
}

const insertSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
for (const [key, value] of Object.entries(defaultSettings)) insertSetting.run(key, value);

function legacyDaySettingsSnapshot() {
  const stored = Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().map((row) => [row.key, row.value]));
  return Object.fromEntries(planningDays.map(([day]) => [day, {
    open: stored[`${day}_open`] !== "0",
    start: stored[`${day}_start_time`], end: stored[`${day}_end_time`],
    lunchEnabled: stored[`${day}_lunch_enabled`] === "1",
    lunchStart: stored[`${day}_lunch_start`], lunchEnd: stored[`${day}_lunch_end`],
    minStaff: Number(stored[`${day}_min_staff`] || 0),
    minFrom: stored[`${day}_min_from`], minTo: stored[`${day}_min_to`],
  }]));
}
db.prepare("UPDATE locations SET day_settings_json = ? WHERE TRIM(COALESCE(day_settings_json, '')) = ''")
  .run(JSON.stringify(legacyDaySettingsSnapshot()));

const builtinPositions = [
  ["teamleitung", "Teamleitung", 1],
  ["abteilungsleitung", "Abteilungsleitung", 2],
  ["verkaufsmitarbeiter", "Verkaufsmitarbeiter", 3],
  ["lehrling", "Lehrling", 4],
];
const insertPosition = db.prepare("INSERT OR IGNORE INTO positions (id, name, builtin, sort_order) VALUES (?, ?, 1, ?)");
for (const [id, name, order] of builtinPositions) insertPosition.run(id, name, order);
db.prepare("UPDATE employees SET position_id = 'verkaufsmitarbeiter' WHERE position_id IS NULL OR position_id = ''").run();

const upsertPortalRole = db.prepare(`
  INSERT INTO portal_roles (id, name, description, builtin, permissions, sort_order, updated_at)
  VALUES (?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    description = excluded.description,
    builtin = 1,
    permissions = excluded.permissions,
    sort_order = excluded.sort_order,
    updated_at = CURRENT_TIMESTAMP
`);
for (const role of builtinPortalRoles) {
  upsertPortalRole.run(role.id, role.name, role.description, JSON.stringify(role.permissions), role.sortOrder);
}
db.prepare("UPDATE portal_users SET role_locked = 1 WHERE role = 'developer'").run();
db.prepare(`
  DELETE FROM portal_permission_grants
  WHERE permission IN ('amu:metadata:read','amu:file:read','amu:review','amu:delete','amu:audit')
    AND EXISTS (
      SELECT 1 FROM portal_users u
      WHERE u.employee_number = portal_permission_grants.employee_number
        AND u.role NOT IN ('hr','admin','it_admin','developer')
    )
`).run();
db.prepare("UPDATE portal_settings SET value = '0', updated_at = CURRENT_TIMESTAMP WHERE key = 'amu_manager_file_access'").run();
db.exec("BEGIN");
try {
  db.prepare(`
    DELETE FROM portal_permission_grants
    WHERE permission = 'employees:write'
      AND EXISTS (
        SELECT 1 FROM portal_permission_grants newer
        WHERE newer.employee_number = portal_permission_grants.employee_number
          AND newer.permission = 'employees:display:write'
      )
  `).run();
  db.prepare("UPDATE portal_permission_grants SET permission = 'employees:display:write', updated_at = CURRENT_TIMESTAMP WHERE permission = 'employees:write'").run();
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}
const insertPortalSetting = db.prepare("INSERT OR IGNORE INTO portal_settings (key, value) VALUES (?, ?)");
for (const [key, value] of Object.entries(defaultPortalSettings)) insertPortalSetting.run(key, value);
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

const startupIntegrity = db.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)[0]);
if (!(startupIntegrity.length === 1 && startupIntegrity[0] === "ok")) {
  throw new Error(`Datenbank-Integritätsprüfung fehlgeschlagen: ${startupIntegrity.join("; ")}`);
}

function ensureDefaultLocation() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM locations").get().count;
  if (count === 0) {
    db.prepare("INSERT INTO locations (id, name, day_settings_json, active) VALUES ('01', 'Hauptstandort', ?, 1)")
      .run(JSON.stringify(legacyDaySettingsSnapshot()));
  }
  const defaultLocation = db.prepare("SELECT id FROM locations ORDER BY active DESC, id LIMIT 1").get();
  if (defaultLocation) {
    db.prepare("UPDATE employees SET home_location_id = ? WHERE home_location_id IS NULL OR home_location_id = ''")
      .run(defaultLocation.id);
  }
}

ensureDefaultLocation();

function freezeLegacyLocationBranding() {
  const migrationId = "v0.53.1-branch-branding-snapshots";
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(migrationId)) return;
  const settings = getSettings();
  const branding = brandingFromSettings(settings);
  const neutralBranding = brandingFromSettings(defaultSettings);
  const isNeutral = ["companyName", "logoUrl", "iconUrl", "logoAlt", "adminEmail"]
    .every((key) => branding[key] === neutralBranding[key]);
  const kitId = String(settings.branding_management_kit_id || "").trim() || (isNeutral ? "neutral" : "custom");
  const insertSnapshot = db.prepare(`
    INSERT OR IGNORE INTO location_branding
      (location_id, kit_id, company_name, logo_url, icon_url, logo_alt, admin_email, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'migration', CURRENT_TIMESTAMP)
  `);
  db.exec("BEGIN");
  try {
    for (const location of db.prepare("SELECT id FROM locations ORDER BY id").all()) {
      insertSnapshot.run(location.id, kitId, branding.companyName, branding.logoUrl, branding.iconUrl, branding.logoAlt, branding.adminEmail);
    }
    db.prepare("INSERT INTO schema_migrations (id, app_version) VALUES (?, ?)").run(migrationId, packageMetadata.version);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

freezeLegacyLocationBranding();

const seedEmployees = [
  ["101", "Alex Demo", "Alex", "#0b84c6"],
  ["102", "Bea Demo", "Bea", "#e26500"],
  ["103", "Cem Demo", "Cem", "#07a67a"],
  ["104", "Dana Demo", "Dana", "#c873a5"],
  ["105", "Erik Demo", "Erik", "#7651b5"],
  ["106", "Fina Demo", "Fina", "#c58b00"],
];

function demoLocationDaySettings(location) {
  return Object.fromEntries(planningDays.map(([day]) => {
    const saturday = day === "saturday";
    const start = saturday ? location.saturdayStart : location.weekdayStart;
    const end = saturday ? location.saturdayEnd : location.weekdayEnd;
    return [day, {
      open: true,
      start,
      end,
      lunchEnabled: false,
      lunchStart: "13:00",
      lunchEnd: "14:00",
      minStaff: Number(location.minStaff || 0),
      minFrom: start,
      minTo: end,
    }];
  }));
}

function loadSporthandelDemoProfile() {
  const profilePath = path.join(__dirname, "demo", "sporthandel", "demo-profile.json");
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8").replace(/^\uFEFF/, ""));
  if (profile?.format !== "grabenplaner-demo-profile" || profile?.id !== "sporthandel"
    || !Array.isArray(profile.locations) || !Array.isArray(profile.employees)) {
    throw new Error("Das Sporthandel-Demoprofil ist ungueltig.");
  }
  const salesCount = profile.employees.filter((employee) => employee.category === "sales").length;
  if (profile.locations.length !== 6 || salesCount !== 31) {
    throw new Error("Das Sporthandel-Demoprofil muss sechs Filialen und 31 Verkaufsmitarbeitende enthalten.");
  }
  return profile;
}

function seedSporthandelDemo() {
  const profile = loadSporthandelDemoProfile();
  const insertLocation = db.prepare(`
    INSERT INTO locations
      (id, name, min_staff, day_settings_json, time_tracking_enabled, time_tracking_access_mode,
       time_tracking_allowed_networks, time_tracking_variance_minutes, active)
    VALUES (?, ?, ?, ?, 1, 'anywhere', '', 15, 1)
  `);
  const insertDepartment = db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, ?, ?, 1, ?)
  `);
  const insertEmployee = db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours, position_id,
       time_confirmation_level, home_location_id, preferred_department_id, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  const insertBranding = db.prepare(`
    INSERT INTO location_branding
      (location_id, kit_id, company_name, logo_url, icon_url, logo_alt, admin_email, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'demo-profile')
  `);
  const upsertSetting = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM location_branding").run();
    db.prepare("DELETE FROM departments").run();
    db.prepare("DELETE FROM locations").run();

    const departmentIds = new Map();
    for (const location of profile.locations) {
      insertLocation.run(location.id, location.name, Number(location.minStaff || 0), JSON.stringify(demoLocationDaySettings(location)));
      for (const [index, departmentName] of location.departments.entries()) {
        const result = insertDepartment.run(location.id, departmentName, 1, index + 1);
        departmentIds.set(`${location.id}:${departmentName}`, Number(result.lastInsertRowid));
      }
      insertBranding.run(
        location.id,
        profile.branding.kitId,
        profile.companyName,
        profile.branding.logoUrl,
        profile.branding.iconUrl,
        profile.branding.logoAlt,
        profile.branding.adminEmail || "",
      );
    }

    for (const employee of profile.employees) {
      const departmentId = departmentIds.get(`${employee.locationId}:${employee.department}`) || null;
      insertEmployee.run(
        employee.personnelNumber,
        employee.fullName,
        employee.nickname,
        employee.color,
        Number(employee.contractedHours || 38.5),
        employee.positionId || "verkaufsmitarbeiter",
        ["A", "B", "C"].includes(employee.confirmationLevel) ? employee.confirmationLevel : "C",
        employee.locationId,
        departmentId,
      );
    }

    const managementBranding = {
      branding_management_kit_id: profile.branding.kitId,
      branding_company_name: profile.companyName,
      branding_logo_url: profile.branding.logoUrl,
      branding_icon_url: profile.branding.iconUrl,
      branding_logo_alt: profile.branding.logoAlt,
      branding_admin_email: profile.branding.adminEmail || "",
    };
    for (const [key, value] of Object.entries(managementBranding)) upsertSetting.run(key, value);
    db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES ('demo-profile-sporthandel-v1', ?)")
      .run(packageMetadata.version);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

if (process.env.GRABENPLANER_SEED_DEMO === "1" && db.prepare("SELECT COUNT(*) AS count FROM employees").get().count === 0) {
  if (String(process.env.GRABENPLANER_DEMO_PROFILE || "").trim().toLowerCase() === "sporthandel") {
    seedSporthandelDemo();
  } else {
    const seedLocationId = db.prepare("SELECT id FROM locations ORDER BY active DESC, id LIMIT 1").get()?.id || "01";
    const insertEmployee = db.prepare(`
      INSERT INTO employees
        (personnel_number, full_name, nickname, color, contracted_hours, home_location_id, active)
      VALUES (?, ?, ?, ?, 38.5, ?, 1)
    `);
    for (const employee of seedEmployees) insertEmployee.run(...employee, seedLocationId);
  }
}

app.disable("x-powered-by");
app.use((request, response, next) => {
  const providedRequestId = String(request.headers["x-request-id"] || "").trim();
  request.grabenplanerRequestId = /^[a-z0-9._:-]{8,100}$/i.test(providedRequestId)
    ? providedRequestId
    : crypto.randomUUID();
  response.setHeader("X-Request-Id", request.grabenplanerRequestId);
  next();
});
app.use((request, response, next) => {
  const embeddedPdfPreview = request.path === "/api/schedule-preview.pdf" || request.path === "/api/vacations-preview.pdf";
  const ocrClientAsset = request.path === "/portal" || request.path === "/portal/" || request.path === "/portal.html"
    || request.path.startsWith("/vendor/tesseract") || request.path.startsWith("/vendor/pdfjs-v6.1.200");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", embeddedPdfPreview ? "SAMEORIGIN" : "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  response.setHeader("Content-Security-Policy", `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'${ocrClientAsset ? " 'wasm-unsafe-eval'" : ""}; worker-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors '${embeddedPdfPreview ? "self" : "none"}'`);
  if (request.secure) response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if ((serverModeActive && request.path.startsWith("/api/"))
    || request.path.startsWith("/api/portal/") || request.path.startsWith("/api/mobile/")) {
    response.setHeader("Cache-Control", "no-store");
  }
  if (serverModeActive && !request.secure) {
    const loopbackServiceEndpoint = isLoopbackRequest(request)
      && ((request.method === "GET" && ["/api/health", "/api/health/live", "/api/health/ready"].includes(request.path))
        || (request.method === "POST" && request.path === "/api/service/stop"));
    if (!loopbackServiceEndpoint) {
      response.status(426).json({ error: "Der öffentliche Serverbetrieb akzeptiert ausschließlich HTTPS.", code: "HTTPS_REQUIRED" });
      return;
    }
  }
  if (serverModeActive && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = String(request.headers.origin || "").replace(/\/$/, "");
    if (origin && publicUrl && !requestOriginAllowed(request, origin)) {
      response.status(403).json({ error: "Die Anfrage stammt nicht von der konfigurierten Serveradresse.", code: "ORIGIN_NOT_ALLOWED" });
      return;
    }
  }
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use("/branding-kits", express.static(brandingKitsDirectory));
app.use("/vendor/quill", express.static(path.join(__dirname, "node_modules", "quill", "dist")));
const tesseractPackageDirectory = fs.realpathSync(path.dirname(require.resolve("tesseract.js/package.json")));
const tesseractCoreDirectory = fs.realpathSync(path.join(path.dirname(tesseractPackageDirectory), "tesseract.js-core"));
const tesseractGermanDataDirectory = fs.realpathSync(path.join(__dirname, "node_modules", "@tesseract.js-data", "deu", "4.0.0_best_int"));
const pdfjsPackageDirectory = fs.realpathSync(path.dirname(require.resolve("pdfjs-dist/package.json")));
const immutableVendorAssets = { maxAge: "365d", immutable: true, fallthrough: false };
app.use("/vendor/tesseract-v7", express.static(path.join(tesseractPackageDirectory, "dist"), immutableVendorAssets));
app.use("/vendor/tesseract-core-v7", express.static(tesseractCoreDirectory, immutableVendorAssets));
app.use("/vendor/tesseract-data-deu-v1", express.static(tesseractGermanDataDirectory, immutableVendorAssets));
app.use("/vendor/pdfjs-v6.1.200/build", express.static(path.join(pdfjsPackageDirectory, "build"), immutableVendorAssets));
app.use("/vendor/pdfjs-v6.1.200/cmaps", express.static(path.join(pdfjsPackageDirectory, "cmaps"), immutableVendorAssets));
app.use("/vendor/pdfjs-v6.1.200/standard_fonts", express.static(path.join(pdfjsPackageDirectory, "standard_fonts"), immutableVendorAssets));
app.use("/vendor/pdfjs-v6.1.200/wasm", express.static(path.join(pdfjsPackageDirectory, "wasm"), immutableVendorAssets));
app.use("/vendor/pdfjs-v6.1.200/iccs", express.static(path.join(pdfjsPackageDirectory, "iccs"), immutableVendorAssets));
app.use(express.static(path.join(__dirname, "public")));
app.use("/api", enforceAdminApiAccess);
app.use("/api", enforceInstallationFeatures);

function httpError(status, message, code = "") {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function requireAmuStorage() {
  if (!amuStorage) throw httpError(503, amuStorageStartupError || "Der geschützte AUM-Speicher ist nicht verfügbar.", "AMU_STORAGE_UNAVAILABLE");
  return amuStorage;
}

function parseAmuMultipart(request, { maxFileBytes = 10 * 1024 * 1024, totalMaxBytes = 20 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const contentType = String(request.headers["content-type"] || "");
    const boundaryMatch = contentType.match(/^multipart\/form-data\s*;[\s\S]*?boundary=(?:"([^"]+)"|([^;\s]+))/i);
    const boundary = String(boundaryMatch?.[1] || boundaryMatch?.[2] || "");
    if (!boundary || boundary.length > 70 || /[\r\n]/.test(boundary)) {
      reject(httpError(415, "Bitte die AUM als Formular mit PDF- oder Bilddateien senden.", "AMU_MULTIPART_REQUIRED"));
      return;
    }
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.on("data", (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > totalMaxBytes) {
        fail(httpError(413, `Der gesamte AUM-Upload darf höchstens ${Math.ceil(totalMaxBytes / 1024 / 1024)} MB groß sein.`, "AMU_UPLOAD_TOO_LARGE"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", () => fail(httpError(400, "Der AUM-Upload konnte nicht gelesen werden.", "AMU_MULTIPART_INVALID")));
    request.on("end", () => {
      if (settled) return;
      try {
        const body = Buffer.concat(chunks);
        const delimiter = Buffer.from(`--${boundary}`, "utf8");
        const nextDelimiter = Buffer.from(`\r\n--${boundary}`, "utf8");
        const fields = {};
        const documents = [];
        let position = body.indexOf(delimiter);
        let partCount = 0;
        if (position !== 0) throw httpError(400, "Das Upload-Formular ist ungültig.", "AMU_MULTIPART_INVALID");
        while (position >= 0) {
          position += delimiter.length;
          if (body.subarray(position, position + 2).toString("ascii") === "--") break;
          if (body.subarray(position, position + 2).toString("ascii") !== "\r\n") throw httpError(400, "Das Upload-Formular ist ungültig.", "AMU_MULTIPART_INVALID");
          position += 2;
          const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), position);
          if (headerEnd < 0 || headerEnd - position > 8192) throw httpError(400, "Ein Upload-Teil hat ungültige Kopfzeilen.", "AMU_MULTIPART_INVALID");
          const headers = body.subarray(position, headerEnd).toString("utf8");
          const dataStart = headerEnd + 4;
          const dataEnd = body.indexOf(nextDelimiter, dataStart);
          if (dataEnd < 0) throw httpError(400, "Das Upload-Formular ist unvollständig.", "AMU_MULTIPART_INVALID");
          const data = body.subarray(dataStart, dataEnd);
          const disposition = headers.split("\r\n").find((line) => /^content-disposition:/i.test(line)) || "";
          const name = disposition.match(/(?:^|;)\s*name="([^"]*)"/i)?.[1] || "";
          const encodedFilename = disposition.match(/(?:^|;)\s*filename\*=UTF-8''([^;]+)/i)?.[1];
          const plainFilename = disposition.match(/(?:^|;)\s*filename="([^"]*)"/i)?.[1];
          let filename = plainFilename || "";
          if (encodedFilename) { try { filename = decodeURIComponent(encodedFilename); } catch {} }
          partCount += 1;
          if (partCount > 9) throw httpError(413, "Das AUM-Formular enthält zu viele Teile.", "AMU_TOO_MANY_PARTS");
          if (filename && name === "documents") {
            if (data.length > maxFileBytes) throw httpError(413, `Eine AUM-Datei darf höchstens ${Math.ceil(maxFileBytes / 1024 / 1024)} MB groß sein.`, "AMU_DOCUMENT_TOO_LARGE");
            documents.push({ originalName: filename, buffer: Buffer.from(data) });
            if (documents.length > 3) throw httpError(413, "Pro AUM sind höchstens drei Dateien möglich.", "AMU_TOO_MANY_DOCUMENTS");
          } else if (!filename && [
            "incapacityFrom", "incapacityTo", "employeeNote",
            "sicknessCaseId", "ocrAssisted", "ocrConfirmed",
          ].includes(name)) {
            if (data.length > 4096) throw httpError(413, "Ein AUM-Textfeld ist zu groß.", "AMU_FIELD_TOO_LARGE");
            fields[name] = data.toString("utf8");
          }
          position = dataEnd + 2;
        }
        settled = true;
        resolve({ fields, documents });
      } catch (error) {
        fail(error.status ? error : httpError(400, "Das Upload-Formular ist ungültig.", "AMU_MULTIPART_INVALID"));
      }
    });
  });
}

async function hashPortalPassword(password) {
  const value = String(password || "");
  const minimum = portalPasswordMinLength();
  if (value.length < minimum) {
    throw httpError(400, `Das Passwort muss in diesem Betriebsmodus mindestens ${minimum} Zeichen lang sein.`, "PORTAL_PASSWORD_TOO_SHORT");
  }
  const salt = crypto.randomBytes(16);
  const derivedKey = await scryptAsync(value, salt, 64);
  return `scrypt-v1$${salt.toString("base64url")}$${Buffer.from(derivedKey).toString("base64url")}`;
}

async function verifyPortalPassword(password, storedHash) {
  const [version, encodedSalt, encodedKey, ...remainder] = String(storedHash || "").split("$");
  if (version !== "scrypt-v1" || !encodedSalt || !encodedKey || remainder.length) return false;
  try {
    const salt = Buffer.from(encodedSalt, "base64url");
    const expectedKey = Buffer.from(encodedKey, "base64url");
    if (salt.length < 16 || expectedKey.length !== 64) return false;
    const actualKey = Buffer.from(await scryptAsync(String(password || ""), salt, expectedKey.length));
    return crypto.timingSafeEqual(actualKey, expectedKey);
  } catch {
    return false;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BRANDING_RATE_WINDOW_MS = 5 * 60 * 1000;
const loginRateLimits = createBoundedRateLimitStore({ windowMs: LOGIN_RATE_WINDOW_MS, maxKeys: 2048, maxEventsPerKey: 15 });
const loginBrandingRateLimits = createBoundedRateLimitStore({ windowMs: LOGIN_BRANDING_RATE_WINDOW_MS, maxKeys: 2048, maxEventsPerKey: 60 });
const mobileRefreshRateLimits = createBoundedRateLimitStore({ windowMs: LOGIN_RATE_WINDOW_MS, maxKeys: 2048, maxEventsPerKey: 90 });
const usbCreatorAuthRateLimits = createBoundedRateLimitStore({ windowMs: LOGIN_RATE_WINDOW_MS, maxKeys: 128, maxEventsPerKey: 8 });
const usbCreatorGlobalRateLimits = createBoundedRateLimitStore({ windowMs: LOGIN_RATE_WINDOW_MS, maxKeys: 32, maxEventsPerKey: 24 });

function loginRateKey(request) {
  return String(request.ip || request.socket?.remoteAddress || "unknown").replace(/^::ffff:/, "");
}

function normalizedIp(value) {
  return String(value || "").trim().replace(/^\[|\]$/g, "").replace(/^::ffff:/i, "").split("%")[0].toLowerCase();
}

function ipToInteger(value) {
  const address = normalizedIp(value);
  const version = net.isIP(address);
  if (version === 4) {
    return {
      version,
      bits: 32,
      value: address.split(".").reduce((result, part) => (result << 8n) + BigInt(Number(part)), 0n),
    };
  }
  if (version !== 6) return null;
  let ipv6 = address;
  if (ipv6.includes(".")) {
    const separator = ipv6.lastIndexOf(":");
    const ipv4 = ipToInteger(ipv6.slice(separator + 1));
    if (!ipv4 || ipv4.version !== 4) return null;
    const high = Number((ipv4.value >> 16n) & 0xffffn).toString(16);
    const low = Number(ipv4.value & 0xffffn).toString(16);
    ipv6 = `${ipv6.slice(0, separator)}:${high}:${low}`;
  }
  const halves = ipv6.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const words = [...left, ...Array(missing).fill("0"), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return null;
  return {
    version,
    bits: 128,
    value: words.reduce((result, word) => (result << 16n) + BigInt(parseInt(word, 16)), 0n),
  };
}

function ipMatchesNetwork(ipValue, networkValue) {
  const [networkAddress, prefixValue] = String(networkValue || "").split("/");
  const ip = ipToInteger(ipValue);
  const networkAddressValue = ipToInteger(networkAddress);
  if (!ip || !networkAddressValue || ip.version !== networkAddressValue.version) return false;
  const prefix = prefixValue === undefined ? ip.bits : Number(prefixValue);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > ip.bits) return false;
  if (prefix === 0) return true;
  const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(ip.bits - prefix);
  return (ip.value & mask) === (networkAddressValue.value & mask);
}

function isPrivateNetworkIp(value) {
  const ip = normalizedIp(value);
  return ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16",
    "::1/128", "fc00::/7", "fe80::/10"].some((network) => ipMatchesNetwork(ip, network));
}

function timeTrackingRequestAccess(request, location) {
  const mode = location?.time_tracking_access_mode === "trusted_network" ? "trusted_network" : "anywhere";
  const clientIp = normalizedIp(loginRateKey(request));
  const configuredNetworks = String(location?.time_tracking_allowed_networks || "").split(/[\s,;]+/).filter(Boolean);
  const explicitlyAllowed = configuredNetworks.some((network) => ipMatchesNetwork(clientIp, network));
  const trustedLanClient = !serverModeActive && isPrivateNetworkIp(clientIp);
  const allowed = mode === "anywhere" || explicitlyAllowed || trustedLanClient;
  return {
    mode,
    allowed,
    reason: allowed ? "" : "Zeitbuchungen sind für diesen Standort nur aus einem vertrauenswürdigen Firmennetz möglich.",
  };
}

function assertLoginRateLimit(request) {
  if (!serverModeActive) return;
  const key = loginRateKey(request);
  const now = Date.now();
  const recent = loginRateLimits.get(key, now);
  if (recent.length >= 15) {
    const retrySeconds = Math.max(1, Math.ceil((LOGIN_RATE_WINDOW_MS - (now - recent[0])) / 1000));
    const error = httpError(429, "Von diesem Gerät gab es zu viele fehlgeschlagene Anmeldungen. Bitte später erneut versuchen.", "LOGIN_RATE_LIMITED");
    error.retryAfter = retrySeconds;
    throw error;
  }
}

function registerFailedLogin(request) {
  if (!serverModeActive) return;
  const key = loginRateKey(request);
  loginRateLimits.record(key, Date.now());
}

function clearLoginRate(request) {
  loginRateLimits.clear(loginRateKey(request));
}

function assertLoginBrandingRateLimit(request) {
  const key = loginRateKey(request);
  const now = Date.now();
  const recent = loginBrandingRateLimits.get(key, now);
  if (recent.length >= 60) {
    const retrySeconds = Math.max(1, Math.ceil((LOGIN_BRANDING_RATE_WINDOW_MS - (now - recent[0])) / 1000));
    const error = httpError(429, "Zu viele Branding-Abfragen. Bitte spaeter erneut versuchen.", "LOGIN_BRANDING_RATE_LIMITED");
    error.retryAfter = retrySeconds;
    throw error;
  }
  loginBrandingRateLimits.record(key, now);
}

function assertMobileRefreshRateLimit(request) {
  const key = loginRateKey(request);
  const now = Date.now();
  const recent = mobileRefreshRateLimits.get(key, now);
  if (recent.length >= 90) {
    const retrySeconds = Math.max(1, Math.ceil((LOGIN_RATE_WINDOW_MS - (now - recent[0])) / 1000));
    const error = httpError(429, "Zu viele Sitzungsaktualisierungen. Bitte spaeter erneut versuchen.", "MOBILE_REFRESH_RATE_LIMITED");
    error.retryAfter = retrySeconds;
    throw error;
  }
  mobileRefreshRateLimits.record(key, now);
}

function parseCookies(request) {
  return Object.fromEntries(String(request.headers.cookie || "").split(";").map((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return ["", ""];
    const key = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    try { return [key, decodeURIComponent(rawValue)]; } catch { return [key, rawValue]; }
  }).filter(([key]) => key));
}

function appendCookie(response, value) {
  const current = response.getHeader("Set-Cookie");
  response.setHeader("Set-Cookie", current ? [...(Array.isArray(current) ? current : [current]), value] : value);
}

function portalCookie(name, value, request, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Strict"];
  if (options.httpOnly) parts.push("HttpOnly");
  if (serverModeActive || request.secure || String(request.headers["x-forwarded-proto"] || "").toLowerCase() === "https") parts.push("Secure");
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  return parts.join("; ");
}

function clearPortalCookies(request, response) {
  appendCookie(response, portalCookie(PORTAL_SESSION_COOKIE, "", request, { httpOnly: true, maxAge: 0 }));
  appendCookie(response, portalCookie(PORTAL_CSRF_COOKIE, "", request, { maxAge: 0 }));
}

function getLanUrls(port = PORT) {
  const urls = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family !== "IPv4" || address.internal || address.address.startsWith("169.254.")) continue;
      urls.push(`http://${address.address}:${port}`);
    }
  }
  return [...new Set(urls)].sort();
}

function isLoopbackRequest(request) {
  const address = String(request.socket?.remoteAddress || "").replace(/^::ffff:/, "").toLowerCase();
  return address === "127.0.0.1" || address === "::1" || address === "localhost";
}

function auditPortal(actor, action, entityType = "", entityId = "", detail = "") {
  db.prepare(`
    INSERT INTO audit_log (actor, action, entity_type, entity_id, detail)
    VALUES (?, ?, ?, ?, ?)
  `).run(String(actor || ""), String(action), String(entityType || ""), String(entityId || ""), String(detail || "").slice(0, 2000));
}

function createPortalNotification(recipient, eventType, title, message = "", options = {}) {
  const employeeNumber = String(recipient || "").trim();
  if (!employeeNumber || employeeNumber === "local") return null;
  const id = crypto.randomUUID();
  const dedupeKey = options.dedupeKey ? String(options.dedupeKey).slice(0, 240) : null;
  const result = db.prepare(`
    INSERT OR IGNORE INTO portal_notifications
      (id, recipient_employee_number, event_type, title, message, target, entity_type, entity_id, dedupe_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    employeeNumber,
    String(eventType || "info").slice(0, 80),
    stripEmoji(String(title || "")).slice(0, 160),
    stripEmoji(String(message || "")).slice(0, 500),
    String(options.target || "/portal.html?tab=requests").slice(0, 240),
    String(options.entityType || "").slice(0, 80),
    String(options.entityId || "").slice(0, 120),
    dedupeKey,
  );
  if (result.changes) return id;
  if (!dedupeKey || options.reactivate !== true) return null;
  const existing = db.prepare(`
    SELECT id FROM portal_notifications
    WHERE recipient_employee_number = ? AND dedupe_key = ?
  `).get(employeeNumber, dedupeKey);
  if (!existing) return null;
  db.prepare(`
    UPDATE portal_notifications
    SET read_at = NULL, created_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(existing.id);
  return existing.id;
}

function requestReviewerRecipients(locationId, departmentId = null, stage = "local", excludeEmployeeNumber = "") {
  const rows = stage === "hr"
    ? db.prepare(`
        SELECT u.employee_number FROM portal_users u
        WHERE u.active = 1 AND TRIM(u.password_hash) <> '' AND u.role IN ('hr','admin')
        ORDER BY u.employee_number
      `).all()
    : db.prepare(`
        SELECT u.employee_number FROM portal_users u
        JOIN employees e ON e.personnel_number = u.employee_number
        WHERE u.active = 1 AND TRIM(u.password_hash) <> ''
          AND (u.role = 'admin' OR (u.role IN ('manager','department_manager') AND (
            EXISTS (SELECT 1 FROM portal_access_scopes s WHERE s.employee_number = u.employee_number
              AND s.location_id = ? AND (u.role = 'manager' OR s.department_id = ?))
            OR (NOT EXISTS (SELECT 1 FROM portal_access_scopes s WHERE s.employee_number = u.employee_number)
              AND e.home_location_id = ? AND (u.role = 'manager' OR e.preferred_department_id = ?))
          )))
        ORDER BY u.employee_number
      `).all(String(locationId || ""), Number(departmentId || 0), String(locationId || ""), Number(departmentId || 0));
  return [...new Set(rows.map((row) => row.employee_number).filter((value) => value && value !== excludeEmployeeNumber))];
}

function notifyRequestReviewers(entry, kind, stage = "local", actor = "") {
  const labels = { vacation: "Urlaubsantrag", vacation_change: "Urlaubsänderung", time_off: "ZA-Antrag", time_off_change: "ZA-Änderung" };
  const label = labels[kind] || "Abwesenheitsantrag";
  const requestContext = employeeRequestContext(entry.employee_number, entry.request_date || entry.date_from);
  const locationId = entry.location_id || requestContext.locationId;
  const targetKind = kind.startsWith("time_off") ? "time_off" : "vacation";
  const target = `/?view=requests&kind=${targetKind}`;
  for (const recipient of requestReviewerRecipients(locationId, requestContext.departmentId, stage, actor)) {
    createPortalNotification(recipient, "request.review", `${label} wartet auf Prüfung`, `${entry.employee_number} hat einen Antrag eingereicht.`, {
      target,
      entityType: kind,
      entityId: entry.id,
      dedupeKey: `${kind}:${entry.id}:${stage}:review`,
    });
  }
}

function notifyRequestDecision(entry, kind, status, actor = "") {
  const labels = { vacation: "Urlaubsantrag", vacation_change: "Urlaubsänderung", time_off: "ZA-Antrag", time_off_change: "ZA-Änderung" };
  const statusText = {
    approved: "wurde genehmigt",
    rejected: "wurde abgelehnt",
    cancelled: "wurde storniert",
    withdrawn: "wurde zurückgezogen",
    preliminary_local: "wurde vorläufig genehmigt",
    pending_hr: "wurde an die Personalleitung weitergeleitet",
  }[status] || "wurde bearbeitet";
  createPortalNotification(entry.employee_number, "request.decision", `${labels[kind] || "Antrag"} ${statusText}`, actor ? `Bearbeitet von Personalnummer ${actor}.` : "", {
    target: "/portal.html?tab=requests",
    entityType: kind,
    entityId: entry.id,
    dedupeKey: `${kind}:${entry.id}:${status}:${actor || "system"}`,
  });
}

function resolveRequestReviewNotifications(kind, id, stage = "") {
  const suffix = stage ? `${stage}:review` : ":review";
  const pattern = stage ? `${kind}:${id}:${suffix}` : `${kind}:${id}:%:review`;
  db.prepare(`
    UPDATE portal_notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
    WHERE event_type = 'request.review' AND dedupe_key LIKE ?
  `).run(pattern);
}

function portalSessionFromRequest(request, { touch = true } = {}) {
  const token = parseCookies(request)[PORTAL_SESSION_COOKIE];
  if (!token) return null;
  const now = new Date().toISOString();
  const session = db.prepare(`
    SELECT s.id, s.employee_number, s.expires_at, s.revoked_at,
           u.role, u.role_locked, u.active, u.must_change_password,
           e.full_name, e.nickname, e.color, e.home_location_id, e.preferred_department_id,
           e.position_id, p.name AS position_name,
           r.name AS role_name, r.permissions
    FROM portal_sessions s
    JOIN portal_users u ON u.employee_number = s.employee_number
    JOIN employees e ON e.personnel_number = u.employee_number
    LEFT JOIN positions p ON p.id = e.position_id
    LEFT JOIN portal_roles r ON r.id = u.role
    WHERE s.token_hash = ?
      AND s.revoked_at IS NULL
      AND s.expires_at > ?
      AND u.active = 1
    LIMIT 1
  `).get(sha256(token), now);
  if (!session) return null;
  if (touch) db.prepare("UPDATE portal_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?").run(session.id);
  const scopes = GLOBAL_SCOPE_PORTAL_ROLES.has(session.role) ? [] : db.prepare(`
    SELECT location_id, department_id FROM portal_access_scopes
    WHERE employee_number = ? ORDER BY location_id, department_id
  `).all(session.employee_number).map((scope) => ({ locationId: scope.location_id, departmentId: Number(scope.department_id || 0) || null }));
  if (!scopes.length && !GLOBAL_SCOPE_PORTAL_ROLES.has(session.role) && session.home_location_id) {
    scopes.push({ locationId: session.home_location_id, departmentId: session.role === "department_manager" ? (Number(session.preferred_department_id) || null) : null });
  }
  const rolePermissions = parsePortalPermissions(session.permissions)
    .filter((permission) => portalPermissionAllowedForRole(permission, session.role));
  const grantedPermissions = portalPermissionGrantsForEmployee(session.employee_number);
  return {
    id: session.id,
    employeeNumber: session.employee_number,
    fullName: session.full_name,
    nickname: session.nickname,
    color: session.color,
    homeLocationId: session.home_location_id,
    positionId: session.position_id || null,
    positionName: session.position_name || "",
    role: session.role,
    roleName: session.role_name || session.role,
    roleLocked: Boolean(session.role_locked),
    permissions: [...new Set([...rolePermissions, ...grantedPermissions])],
    rolePermissions,
    grantedPermissions,
    scopes,
    mustChangePassword: Boolean(session.must_change_password),
    expiresAt: session.expires_at,
  };
}

function publicPortalUser(session) {
  if (!session) return null;
  return {
    employeeNumber: session.employeeNumber,
    fullName: session.fullName,
    nickname: session.nickname,
    color: session.color,
    homeLocationId: session.homeLocationId,
    positionId: session.positionId,
    positionName: session.positionName,
    role: session.role,
    roleName: session.roleName,
    roleLocked: Boolean(session.roleLocked),
    permissions: session.permissions,
    rolePermissions: session.rolePermissions || [],
    grantedPermissions: session.grantedPermissions || [],
    scopes: session.scopes || [],
    mustChangePassword: session.mustChangePassword,
  };
}

function sessionHasGlobalScope(session) {
  return !session || session.employeeNumber === "local" || GLOBAL_SCOPE_PORTAL_ROLES.has(session.role);
}

function assertSessionContextScope(session, input = {}) {
  if (sessionHasGlobalScope(session)) return;
  const locationId = String(input.locationId || input.location || "").trim();
  const departmentId = Number(input.departmentId || input.department || 0) || null;
  if (!locationId) return;
  const matching = (session.scopes || []).filter((scope) => scope.locationId === locationId);
  if (!matching.length) throw httpError(403, "Diese Filiale ist dem Zugang nicht zugewiesen.", "PORTAL_SCOPE_DENIED");
  if (matching.some((scope) => !Number(scope.departmentId || 0))) return;
  if (!departmentId || !matching.some((scope) => Number(scope.departmentId) === departmentId)) {
    throw httpError(403, "Diese Abteilung ist dem Zugang nicht zugewiesen.", "PORTAL_SCOPE_DENIED");
  }
}

function assertSessionEmployeeScope(session, employeeNumber) {
  if (sessionHasGlobalScope(session)) return;
  const employee = db.prepare("SELECT home_location_id, preferred_department_id FROM employees WHERE personnel_number = ?").get(employeeNumber);
  if (!employee) throw httpError(404, "Das Teammitglied wurde nicht gefunden.");
  assertSessionContextScope(session, { locationId: employee.home_location_id, departmentId: employee.preferred_department_id });
}

function assertSessionLocationAdministrationScope(session, locationId) {
  if (sessionHasGlobalScope(session)) return;
  if (!(session.scopes || []).some((scope) => scope.locationId === locationId)) {
    throw httpError(403, "Diese Filiale ist dem Zugang nicht zugewiesen.", "PORTAL_SCOPE_DENIED");
  }
}

function requirePortalSession(request, permission = "") {
  const session = portalSessionFromRequest(request);
  if (!session) throw httpError(401, "Bitte zuerst anmelden.", "PORTAL_LOGIN_REQUIRED");
  if (permission && session.mustChangePassword) {
    throw httpError(428, "Bitte zuerst das persönliche Startpasswort ändern.", "PORTAL_PASSWORD_CHANGE_REQUIRED");
  }
  if (permission && !session.permissions.includes(permission)) {
    throw httpError(403, "Für diese Aktion fehlt die Berechtigung.", "PORTAL_PERMISSION_DENIED");
  }
  return session;
}

function assertPortalCsrf(request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const cookies = parseCookies(request);
  const cookieToken = String(cookies[PORTAL_CSRF_COOKIE] || "");
  const headerToken = String(request.headers["x-csrf-token"] || "");
  const valid = cookieToken.length >= 24 && headerToken.length === cookieToken.length
    && crypto.timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken));
  if (!valid) throw httpError(403, "Die Sicherheitsprüfung ist abgelaufen. Bitte die Seite neu laden.", "PORTAL_CSRF_INVALID");
}

function mobileNativeAuthenticationAvailable() {
  const status = getPortalStatus();
  return serverModeActive
    && status.portalEnabled
    && Boolean(normalizedPublicOrigin && normalizedPublicOrigin.startsWith("https://"));
}

function requireMobileNativeAuthentication() {
  if (!mobileNativeAuthenticationAvailable()) {
    throw httpError(409, "Die native App-Anmeldung ist nur im sicheren HTTPS-Serverbetrieb verfuegbar.", "MOBILE_AUTH_UNAVAILABLE");
  }
}

function createMobileToken(prefix, sessionId) {
  return `${prefix}.${sessionId}.${crypto.randomBytes(32).toString("base64url")}`;
}

function parseMobileToken(value, expectedPrefix) {
  const token = String(value || "").trim();
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== expectedPrefix || !/^[0-9a-f-]{36}$/i.test(parts[1]) || !/^[A-Za-z0-9_-]{40,64}$/.test(parts[2])) {
    return null;
  }
  return { token, sessionId: parts[1] };
}

function mobileBearerToken(request) {
  const header = String(request.headers.authorization || "");
  const match = header.match(/^Bearer\s+([^\s]+)$/i);
  return match ? match[1] : "";
}

function safeHashEquals(left, right) {
  const leftValue = Buffer.from(String(left || ""));
  const rightValue = Buffer.from(String(right || ""));
  return leftValue.length === rightValue.length && leftValue.length > 0 && crypto.timingSafeEqual(leftValue, rightValue);
}

function parseMobileSemanticVersion(value) {
  const version = String(value || "").trim();
  const match = version.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split(".") : [];
  if (prerelease.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) return null;
  return {
    version,
    core: [match[1], match[2], match[3]],
    prerelease,
  };
}

function compareMobileNumericIdentifiers(left, right) {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  return left === right ? 0 : (left > right ? 1 : -1);
}

function compareMobileSemanticVersions(leftValue, rightValue) {
  const left = parseMobileSemanticVersion(leftValue);
  const right = parseMobileSemanticVersion(rightValue);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index += 1) {
    const comparison = compareMobileNumericIdentifiers(left.core[index], right.core[index]);
    if (comparison) return comparison;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length ? -1 : 1;
  }
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) return leftIdentifier === undefined ? -1 : 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return compareMobileNumericIdentifiers(leftIdentifier, rightIdentifier);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier > rightIdentifier ? 1 : -1;
  }
  return 0;
}

function validateMobileAppVersion(value) {
  const appVersion = String(value || "").trim();
  if (appVersion.length > 64) {
    const error = httpError(400, "Die App-Version ist kein gültiger SemVer-Wert.", "MOBILE_APP_VERSION_INVALID");
    error.details = { fieldErrors: { "device.appVersion": "Bitte eine vollständige semantische Version übermitteln." } };
    throw error;
  }
  const comparison = compareMobileSemanticVersions(appVersion, MOBILE_MINIMUM_APP_VERSION);
  if (comparison === null) {
    const error = httpError(400, "Die App-Version ist kein gültiger SemVer-Wert.", "MOBILE_APP_VERSION_INVALID");
    error.details = { fieldErrors: { "device.appVersion": "Bitte eine vollständige semantische Version übermitteln." } };
    throw error;
  }
  if (comparison < 0) {
    const error = httpError(426, "Diese App-Version wird nicht mehr unterstützt. Bitte Grabenplaner Mobile aktualisieren.", "MOBILE_APP_UPDATE_REQUIRED");
    error.details = { minimumMobileVersion: MOBILE_MINIMUM_APP_VERSION, currentMobileVersion: appVersion };
    throw error;
  }
  return appVersion;
}

function validateMobileDevice(input = {}) {
  const installationId = String(input.installationId || "").trim();
  const platform = String(input.platform || "").trim().toLowerCase();
  const label = stripEmoji(String(input.label || "").trim()).replace(/[\x00-\x1f]/g, " ").slice(0, 80);
  const appVersion = validateMobileAppVersion(input.appVersion);
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(installationId)) {
    const error = httpError(400, "Die App-Installation konnte nicht eindeutig erkannt werden.", "MOBILE_DEVICE_INVALID");
    error.details = { fieldErrors: { "device.installationId": "Bitte eine gueltige Installations-ID uebermitteln." } };
    throw error;
  }
  if (!["android", "ios"].includes(platform)) {
    const error = httpError(400, "Die mobile Plattform ist ungueltig.", "MOBILE_DEVICE_INVALID");
    error.details = { fieldErrors: { "device.platform": "Unterstuetzt werden Android und iOS." } };
    throw error;
  }
  return {
    installationIdHash: sha256(installationId),
    platform,
    label,
    appVersion,
  };
}

function mobileSessionPrincipal(row) {
  if (!row) return null;
  const scopes = GLOBAL_SCOPE_PORTAL_ROLES.has(row.role) ? [] : db.prepare(`
    SELECT location_id, department_id FROM portal_access_scopes
    WHERE employee_number = ? ORDER BY location_id, department_id
  `).all(row.employee_number).map((scope) => ({ locationId: scope.location_id, departmentId: Number(scope.department_id || 0) || null }));
  if (!scopes.length && !GLOBAL_SCOPE_PORTAL_ROLES.has(row.role) && row.home_location_id) {
    scopes.push({ locationId: row.home_location_id, departmentId: row.role === "department_manager" ? (Number(row.preferred_department_id) || null) : null });
  }
  const rolePermissions = parsePortalPermissions(row.permissions)
    .filter((permission) => portalPermissionAllowedForRole(permission, row.role));
  const grantedPermissions = portalPermissionGrantsForEmployee(row.employee_number);
  return {
    id: row.id,
    mobileSessionId: row.id,
    employeeNumber: row.employee_number,
    fullName: row.full_name,
    nickname: row.nickname,
    color: row.color,
    homeLocationId: row.home_location_id,
    positionId: row.position_id || null,
    positionName: row.position_name || "",
    role: row.role,
    roleName: row.role_name || row.role,
    roleLocked: Boolean(row.role_locked),
    permissions: [...new Set([...rolePermissions, ...grantedPermissions])],
    rolePermissions,
    grantedPermissions,
    scopes,
    mustChangePassword: Boolean(row.must_change_password),
    expiresAt: row.access_expires_at,
    refreshExpiresAt: row.refresh_expires_at,
  };
}

function mobileSessionRow(sessionId) {
  return db.prepare(`
    SELECT m.*, u.role, u.role_locked, u.active, u.must_change_password,
           e.full_name, e.nickname, e.color, e.home_location_id, e.preferred_department_id,
           e.position_id, e.active AS employee_active, p.name AS position_name,
           r.name AS role_name, r.permissions
    FROM mobile_sessions m
    JOIN portal_users u ON u.employee_number = m.employee_number
    JOIN employees e ON e.personnel_number = u.employee_number
    LEFT JOIN positions p ON p.id = e.position_id
    LEFT JOIN portal_roles r ON r.id = u.role
    WHERE m.id = ?
    LIMIT 1
  `).get(sessionId);
}

function mobileSessionFromRequest(request, { touch = true } = {}) {
  const parsed = parseMobileToken(mobileBearerToken(request), MOBILE_ACCESS_TOKEN_PREFIX);
  if (!parsed) return null;
  const row = mobileSessionRow(parsed.sessionId);
  const now = new Date().toISOString();
  if (!row || row.revoked_at || !row.active || !row.employee_active || row.access_expires_at <= now
    || !safeHashEquals(row.access_token_hash, sha256(parsed.token))) return null;
  if (touch) db.prepare("UPDATE mobile_sessions SET last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(row.id);
  return mobileSessionPrincipal(row);
}

function requireMobileSession(request, permission = "", { allowPasswordChange = false } = {}) {
  requireMobileNativeAuthentication();
  const session = mobileSessionFromRequest(request);
  if (!session) throw httpError(401, "Bitte erneut in der App anmelden.", "MOBILE_AUTH_REQUIRED");
  if (!allowPasswordChange && session.mustChangePassword) {
    throw httpError(428, "Bitte zuerst das persoenliche Startpasswort aendern.", "MOBILE_PASSWORD_CHANGE_REQUIRED");
  }
  if (permission && !session.permissions.includes(permission)) {
    throw httpError(403, "Fuer diese Aktion fehlt die Berechtigung.", "MOBILE_PERMISSION_DENIED");
  }
  return session;
}

function mobileTokenSet(accessToken, accessExpiresAt, refreshToken, refreshExpiresAt) {
  return { accessToken, accessTokenExpiresAt: accessExpiresAt, refreshToken, refreshTokenExpiresAt: refreshExpiresAt };
}

function revokeMobileSessionsForEmployee(employeeNumber, reason = "access_changed", exceptSessionId = "") {
  const query = exceptSessionId
    ? "UPDATE mobile_sessions SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE employee_number = ? AND id <> ? AND revoked_at IS NULL"
    : "UPDATE mobile_sessions SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE employee_number = ? AND revoked_at IS NULL";
  return exceptSessionId
    ? db.prepare(query).run(String(reason).slice(0, 80), String(employeeNumber), String(exceptSessionId)).changes
    : db.prepare(query).run(String(reason).slice(0, 80), String(employeeNumber)).changes;
}

function createMobileSession(employeeNumber, device, now = new Date()) {
  db.prepare("DELETE FROM mobile_sessions WHERE refresh_expires_at <= ?").run(now.toISOString());
  db.prepare(`
    UPDATE mobile_sessions
    SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = 'device_replaced', updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = ? AND installation_id_hash = ? AND revoked_at IS NULL
  `).run(employeeNumber, device.installationIdHash);
  const active = db.prepare(`
    SELECT id FROM mobile_sessions
    WHERE employee_number = ? AND revoked_at IS NULL AND refresh_expires_at > ?
    ORDER BY last_seen_at DESC, created_at DESC
  `).all(employeeNumber, now.toISOString());
  for (const stale of active.slice(Math.max(0, MOBILE_MAX_ACTIVE_SESSIONS - 1))) {
    db.prepare("UPDATE mobile_sessions SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = 'device_limit', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(stale.id);
  }
  const id = crypto.randomUUID();
  const accessToken = createMobileToken(MOBILE_ACCESS_TOKEN_PREFIX, id);
  const refreshToken = createMobileToken(MOBILE_REFRESH_TOKEN_PREFIX, id);
  const accessExpiresAt = new Date(now.getTime() + MOBILE_ACCESS_TOKEN_TTL_MS).toISOString();
  const refreshExpiresAt = new Date(now.getTime() + MOBILE_REFRESH_TOKEN_TTL_MS).toISOString();
  db.prepare(`
    INSERT INTO mobile_sessions
      (id, employee_number, access_token_hash, access_expires_at, refresh_token_hash,
       refresh_expires_at, installation_id_hash, platform, device_label, app_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, employeeNumber, sha256(accessToken), accessExpiresAt, sha256(refreshToken), refreshExpiresAt,
    device.installationIdHash, device.platform, device.label, device.appVersion);
  return { id, tokenSet: mobileTokenSet(accessToken, accessExpiresAt, refreshToken, refreshExpiresAt) };
}

function rotateAuthenticatedMobileSession(sessionId, now = new Date()) {
  const row = mobileSessionRow(sessionId);
  if (!row || row.revoked_at || !row.active || !row.employee_active || row.refresh_expires_at <= now.toISOString()) {
    throw httpError(401, "Die App-Sitzung ist abgelaufen. Bitte erneut anmelden.", "MOBILE_AUTH_REQUIRED");
  }
  const accessToken = createMobileToken(MOBILE_ACCESS_TOKEN_PREFIX, row.id);
  const refreshToken = createMobileToken(MOBILE_REFRESH_TOKEN_PREFIX, row.id);
  const accessExpiresAt = new Date(now.getTime() + MOBILE_ACCESS_TOKEN_TTL_MS).toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO mobile_refresh_token_history (session_id, token_hash, consumed_at)
    VALUES (?, ?, ?)
  `).run(row.id, row.refresh_token_hash, now.toISOString());
  const result = db.prepare(`
    UPDATE mobile_sessions
    SET access_token_hash = ?, access_expires_at = ?, previous_refresh_token_hash = refresh_token_hash,
        refresh_token_hash = ?, last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND revoked_at IS NULL
  `).run(sha256(accessToken), accessExpiresAt, sha256(refreshToken), row.id);
  if (!result.changes) throw httpError(409, "Die App-Sitzung wurde gleichzeitig geändert.", "MOBILE_SESSION_CONFLICT");
  return mobileTokenSet(accessToken, accessExpiresAt, refreshToken, row.refresh_expires_at);
}

function refreshMobileSession(rawRefreshToken, device, now = new Date()) {
  const parsed = parseMobileToken(rawRefreshToken, MOBILE_REFRESH_TOKEN_PREFIX);
  if (!parsed) throw httpError(401, "Die App-Sitzung ist abgelaufen. Bitte erneut anmelden.", "MOBILE_REFRESH_INVALID");
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = mobileSessionRow(parsed.sessionId);
    const submittedHash = sha256(parsed.token);
    if (!row || row.revoked_at || !row.active || !row.employee_active) {
      throw httpError(401, "Die App-Sitzung ist abgelaufen. Bitte erneut anmelden.", "MOBILE_REFRESH_INVALID");
    }
    if (!safeHashEquals(row.installation_id_hash, device.installationIdHash) || row.platform !== device.platform) {
      throw httpError(401, "Die App-Sitzung gehört zu einer anderen Installation.", "MOBILE_DEVICE_MISMATCH");
    }
    const consumed = db.prepare(`
      SELECT 1 FROM mobile_refresh_token_history WHERE session_id = ? AND token_hash = ? LIMIT 1
    `).get(row.id, submittedHash);
    if (consumed || safeHashEquals(row.previous_refresh_token_hash, submittedHash)) {
      db.prepare("UPDATE mobile_sessions SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = 'refresh_reuse', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(row.id);
      db.exec("COMMIT");
      throw httpError(401, "Die App-Sitzung wurde aus Sicherheitsgruenden beendet. Bitte erneut anmelden.", "MOBILE_REFRESH_REUSED");
    }
    if (row.refresh_expires_at <= now.toISOString() || !safeHashEquals(row.refresh_token_hash, submittedHash)) {
      throw httpError(401, "Die App-Sitzung ist abgelaufen. Bitte erneut anmelden.", "MOBILE_REFRESH_INVALID");
    }
    const accessToken = createMobileToken(MOBILE_ACCESS_TOKEN_PREFIX, row.id);
    const refreshToken = createMobileToken(MOBILE_REFRESH_TOKEN_PREFIX, row.id);
    const accessExpiresAt = new Date(now.getTime() + MOBILE_ACCESS_TOKEN_TTL_MS).toISOString();
    db.prepare(`
      INSERT OR IGNORE INTO mobile_refresh_token_history (session_id, token_hash, consumed_at)
      VALUES (?, ?, ?)
    `).run(row.id, row.refresh_token_hash, now.toISOString());
    const result = db.prepare(`
      UPDATE mobile_sessions
      SET access_token_hash = ?, access_expires_at = ?, previous_refresh_token_hash = refresh_token_hash,
          refresh_token_hash = ?, device_label = ?, app_version = ?,
          last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND refresh_token_hash = ? AND revoked_at IS NULL
    `).run(sha256(accessToken), accessExpiresAt, sha256(refreshToken), device.label, device.appVersion,
      row.id, row.refresh_token_hash);
    if (!result.changes) throw httpError(409, "Die App-Sitzung wurde gleichzeitig aktualisiert. Bitte erneut anmelden.", "MOBILE_REFRESH_CONFLICT");
    db.exec("COMMIT");
    return mobileTokenSet(accessToken, accessExpiresAt, refreshToken, row.refresh_expires_at);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function mobileSessionRowFromRefreshToken(rawRefreshToken, now = new Date()) {
  const parsed = parseMobileToken(rawRefreshToken, MOBILE_REFRESH_TOKEN_PREFIX);
  if (!parsed) return null;
  const row = mobileSessionRow(parsed.sessionId);
  if (!row || row.revoked_at || !row.active || !row.employee_active || row.refresh_expires_at <= now.toISOString()
    || !safeHashEquals(row.refresh_token_hash, sha256(parsed.token))) return null;
  return row;
}

function enforceAdminApiAccess(request, _response, next) {
  try {
    if (["/health", "/health/live", "/health/ready", "/service/stop", "/integrations/wifi/events"].includes(request.path)) return next();
    const status = getPortalStatus();
    if (!status.portalEnabled || request.path.startsWith("/portal/") || request.path.startsWith("/mobile/")) return next();
    const method = String(request.method || "GET").toUpperCase();
    const usbProvisioningRoute = /^\/usb-provisioning(?:\/|$)/.test(request.path);
    let permission = usbProvisioningRoute ? "usb:provision" : "schedule:read";
    const integrationRoute = /^\/integrations(?:\/|$)/.test(request.path);
    if (integrationRoute) {
      if (/^\/integrations\/personnel-import(?:\/|$)/.test(request.path)) permission = "employees:import";
      else if (/^\/integrations\/connections\/[^/]+\/sql\/inspect\/?$/.test(request.path)) permission = "employees:import";
      else if (/^\/integrations\/connections(?:\/|$)/.test(request.path)) {
        permission = ["GET", "HEAD", "OPTIONS"].includes(method) ? "integrations:connections:read" : "integrations:connections:write";
      } else if (/^\/integrations\/payroll-export\/deliver\/?$/.test(request.path)) permission = "payroll:deliver";
      else if (/^\/integrations\/payroll-export\/deliveries\/?$/.test(request.path)) permission = "integrations:read";
      else if (/^\/integrations\/payroll-export(?:\/|$)/.test(request.path)) permission = "payroll:export";
      else if (/^\/integrations\/profiles(?:\/|$)/.test(request.path) && !["GET", "HEAD", "OPTIONS"].includes(method)) permission = "integrations:profiles:write";
      else permission = "integrations:read";
    } else if (!usbProvisioningRoute && !["GET", "HEAD", "OPTIONS"].includes(method)) {
      if (/^\/branding/.test(request.path)) {
        permission = "branding:write";
      } else if (/^\/employees\/[^/]+\/display\/?$/.test(request.path)) {
        permission = "employees:display:write";
      } else if (/^\/employees/.test(request.path)) {
        permission = "employees:write";
      } else if (/^\/locations/.test(request.path)) {
        permission = "locations:write";
      } else if (/^\/departments/.test(request.path)) {
        permission = "departments:write";
      } else if (/^\/positions/.test(request.path)) {
        permission = "positions:write";
      } else if (/^\/backup/.test(request.path)) {
        permission = "backup:write";
      } else if (/^\/update/.test(request.path)) {
        permission = "update:write";
      } else if (/^\/operation-mode/.test(request.path)) {
        permission = "operation_mode:write";
      } else if (/^\/system\/restart/.test(request.path)) {
        permission = "operation_mode:write";
      } else if (/^\/system/.test(request.path)) {
        permission = "system:write";
      } else if (/^\/settings/.test(request.path)) {
        permission = "settings:write";
      } else if (/^\/(vacations|vacation-entitlements)/.test(request.path)) {
        permission = "vacation:approve";
      } else {
        permission = "schedule:write";
      }
    }
    const session = requirePortalSession(request, permission);
    assertPortalCsrf(request);
    assertSessionContextScope(session, { ...request.query, ...request.body });
    request.portalSession = session;
    next();
  } catch (error) {
    next(error);
  }
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value || "");
}

function timeToMinutes(value) {
  const [hours, minutes] = String(value).split(":").map(Number);
  return hours * 60 + minutes;
}

function addDays(isoDate, amount) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function addMonths(isoDate, amount) {
  const source = new Date(`${isoDate}T12:00:00Z`);
  const day = source.getUTCDate();
  const target = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + amount, 1, 12));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const austrianHolidayCache = new Map();

function austrianPublicHolidays(year) {
  if (austrianHolidayCache.has(year)) return austrianHolidayCache.get(year);
  const easter = easterSunday(year);
  const holidays = {
    [`${year}-01-01`]: "Neujahr",
    [`${year}-01-06`]: "Heilige Drei Könige",
    [`${year}-03-19`]: "Hl. Josef (Tirol)",
    [addDays(easter, 1)]: "Ostermontag",
    [`${year}-05-01`]: "Staatsfeiertag",
    [addDays(easter, 39)]: "Christi Himmelfahrt",
    [addDays(easter, 50)]: "Pfingstmontag",
    [addDays(easter, 60)]: "Fronleichnam",
    [`${year}-08-15`]: "Mariä Himmelfahrt / Hoher Frauentag (Tirol)",
    [`${year}-10-26`]: "Nationalfeiertag",
    [`${year}-11-01`]: "Allerheiligen",
    [`${year}-12-08`]: "Mariä Empfängnis",
    [`${year}-12-25`]: "Christtag",
    [`${year}-12-26`]: "Stephanitag",
  };
  austrianHolidayCache.set(year, holidays);
  return holidays;
}

function publicHolidayName(isoDate) {
  if (!isIsoDate(isoDate)) return "";
  return austrianPublicHolidays(Number(isoDate.slice(0, 4)))[isoDate] || "";
}

function getMonday(value = new Date().toISOString().slice(0, 10)) {
  const date = new Date(`${value}T12:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function getIsoWeek(isoDate) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  const target = new Date(date.valueOf());
  const dayNumber = (date.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4, 12));
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);
  return 1 + Math.round((target - firstThursday) / 604800000);
}

function viennaTodayIso(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vienna",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function currentWeekStart() {
  return getMonday(viennaTodayIso());
}

function isPastWeekStart(weekStart) {
  return weekStart < currentWeekStart();
}

function viennaNowLocal(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vienna", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}`;
}

function viennaLocalDateTime(date, time) {
  if (!isIsoDate(date) || !isTime(time)) throw httpError(400, "Bitte eine gültige Abschlusszeit eingeben.", "TIME_CORRECTION_INVALID");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const desiredWallTime = Date.UTC(year, month - 1, day, hour, minute, 0);
  let timestamp = desiredWallTime;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vienna", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = formatter.formatToParts(new Date(timestamp));
    const value = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
    const representedWallTime = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
    const difference = desiredWallTime - representedWallTime;
    timestamp += difference;
    if (difference === 0) break;
  }
  const result = new Date(timestamp);
  if (viennaNowLocal(result) !== `${date}T${time}`) throw httpError(400, "Diese lokale Uhrzeit ist nicht eindeutig oder nicht gültig.", "TIME_CORRECTION_INVALID");
  return result;
}

function currentWeekLockPoint(settings = getSettings()) {
  const weekStart = currentWeekStart();
  if (settings.current_week_lock_mode === "manual") {
    const offsets = { friday: 4, saturday: 5, sunday: 6 };
    const day = offsets[settings.current_week_lock_day] ?? 5;
    return `${addDays(weekStart, day)}T${isTime(settings.current_week_lock_time) ? settings.current_week_lock_time : "17:00"}`;
  }
  const openDays = planningDays
    .map(([day], index) => ({ day, index, open: settings[`${day}_open`] !== "0", end: settings[`${day}_end_time`] }))
    .filter((item) => item.open && isTime(item.end));
  const last = openDays.at(-1) || { index: 4, end: "18:00" };
  return `${addDays(weekStart, last.index)}T${last.end}`;
}

function assertWeekEditable(weekStart, settings = getSettings()) {
  if (isPastWeekStart(weekStart) && !settingEnabled(settings, "allow_past_week_editing")) {
    throw httpError(423, "Vergangene Kalenderwochen sind standardmäßig gesperrt. Das kann in den Grundeinstellungen aktiviert werden.");
  }
  if (weekStart === currentWeekStart() && settingEnabled(settings, "current_week_auto_lock") && viennaNowLocal() >= currentWeekLockPoint(settings)) {
    throw httpError(423, "Der Dienstplan der aktuellen Woche ist bereits für Änderungen gesperrt.");
  }
}

function assertDateEditable(isoDate, settings = getSettings()) {
  assertWeekEditable(getMonday(isoDate), settings);
}

function getSettings() {
  const stored = Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().map((row) => [row.key, row.value]));
  const effectiveMode = serverModeActive ? "server" : (configuredOperationMode === "lan" ? "lan" : "local");
  return {
    ...stored,
    operation_mode: effectiveMode,
    server_mode_status: SERVER_MODE_STATUS,
  };
}

function installationFeaturesForApiPath(apiPath) {
  const requestPath = String(apiPath || "").toLowerCase();
  const required = new Set();
  if (/^\/(?:schedule(?:$|\/|\.pdf$|-note(?:\/|$)|-preview\.pdf$)|shifts(?:\/|$)|week-options(?:\/|$)|global-day-blocks(?:\/|$)|auto-plan(?:\/|$)|portal\/v1\/me\/schedule(?:\/|$)|mobile\/v1\/me\/schedule(?:\/|$))/.test(requestPath)) required.add("schedule");
  if (/^\/(?:vacations?(?:$|\/|\.pdf$|-preview\.pdf$)|vacation-entitlements(?:\/|$))/.test(requestPath)) required.add("vacation");
  if (/^\/(?:portal\/v1\/(?:me\/)?(?:absence(?:-|\/|$)|vacation(?:-|\/|$)|approved-vacation(?:s)?(?:\/|$)|time-off(?:-|\/|$)|approved-time-off(?:\/|$)|request-blackouts(?:\/|$)|approval-delegations(?:\/|$))|request-blackouts(?:\/|$)|approval-delegations(?:\/|$))/.test(requestPath)) required.add("requests");
  if (/^\/portal\/v1\/(?:me\/)?(?:vacation(?:-|\/|$)|approved-vacation(?:s)?(?:\/|$))/.test(requestPath)) required.add("vacation");
  if (/^\/(?:portal\/v1\/(?:me\/)?(?:wifi-automation|wifi-suggestions)|portal\/v1\/wifi-automation|wifi(?:-|\/|$)|integrations\/wifi)/.test(requestPath)) required.add("wifiSuggestions");
  if (/^\/(?:portal\/v1\/(?:me\/)?(?:amu|sickness)|portal\/v1\/(?:amu|sickness)|portal\/v1\/personnel-records|amu(?:-|\/|$)|sickness(?:-|\/|$))/.test(requestPath)) required.add("sicknessAmu");
  if (/^\/(?:portal\/v1\/(?:me\/)?(?:time-entries|time-summary|time-corrections)|portal\/v1\/(?:time-summary|time-day|time-corrections|time-presence)|time(?:-|\/|$)|mobile\/v1\/(?:time|me\/time-entries))/.test(requestPath)) required.add("timeTracking");
  if (/^\/(?:portal\/v1\/me(?:\/|$)|mobile\/v1\/(?:bootstrap|me(?:\/|$))|portal\/v1\/(?:greeting-settings|mobile-layout|leadership\/overview))/.test(requestPath)) required.add("employeePortal");
  if (/^\/integrations\/(?:personnel-import|payroll-export|profiles|runs|connections|contracts)(?:\/|$)/.test(requestPath)) required.add("integrations");
  return [...required];
}

function enforceInstallationFeatures(request, _response, next) {
  try {
    const disabled = installationFeaturesForApiPath(request.path)
      .filter((feature) => !installationFeatureEnabled(feature));
    if (disabled.length) {
      throw httpError(403, "Diese Funktion ist für diese Grabenplaner-Installation nicht freigeschaltet.", "FEATURE_DISABLED");
    }
    next();
  } catch (error) {
    next(error);
  }
}

function installationFeatures(settings = getSettings()) {
  let configured = defaultInstallationFeatures;
  try {
    const parsed = JSON.parse(String(settings.installation_features || "[]"));
    if (Array.isArray(parsed)) configured = parsed;
  } catch {}
  const enabled = new Set(configured.filter((feature) => installationFeatureIds.has(feature)));
  for (const feature of installationFeatureCatalog.filter((item) => item.required)) enabled.add(feature.id);
  return Object.fromEntries(installationFeatureCatalog.map((feature) => [feature.id, enabled.has(feature.id)]));
}

function installationFeatureEnabled(feature, settings = getSettings()) {
  return installationFeatures(settings)[feature] !== false;
}

function daySettingsFromLocation(locationId) {
  const row = db.prepare("SELECT day_settings_json FROM locations WHERE id = ?").get(locationId);
  try {
    const parsed = JSON.parse(row?.day_settings_json || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

function settingsForLocation(locationId) {
  const settings = getSettings();
  const branding = brandingForLocation(locationId, settings);
  settings.branding_company_name = branding.companyName;
  settings.branding_logo_url = branding.logoUrl;
  settings.branding_icon_url = branding.iconUrl;
  settings.branding_logo_alt = branding.logoAlt;
  settings.branding_admin_email = branding.adminEmail;
  const days = daySettingsFromLocation(locationId);
  for (const [day] of planningDays) {
    const value = days[day];
    if (!value) continue;
    settings[`${day}_open`] = value.open === false ? "0" : "1";
    settings[`${day}_start_time`] = value.start;
    settings[`${day}_end_time`] = value.end;
    settings[`${day}_lunch_enabled`] = value.lunchEnabled === true ? "1" : "0";
    settings[`${day}_lunch_start`] = value.lunchStart;
    settings[`${day}_lunch_end`] = value.lunchEnd;
    settings[`${day}_min_staff`] = String(Number(value.minStaff || 0));
    settings[`${day}_min_from`] = value.minFrom;
    settings[`${day}_min_to`] = value.minTo;
  }
  return settings;
}

function getPortalSettings() {
  if (!tableExists("portal_settings")) return { ...defaultPortalSettings };
  return {
    ...defaultPortalSettings,
    ...Object.fromEntries(db.prepare("SELECT key, value FROM portal_settings").all().map((row) => [row.key, row.value])),
  };
}

function portalGreetingSettings() {
  try {
    const stored = JSON.parse(getPortalSettings().personalized_greetings || "{}");
    return validatePortalGreetingSettings(stored);
  } catch {
    return validatePortalGreetingSettings(DEFAULT_PORTAL_GREETING_SETTINGS);
  }
}

function validatedPortalGreetingSettings(value) {
  try {
    return validatePortalGreetingSettings(value);
  } catch (error) {
    if (error instanceof PortalGreetingValidationError) {
      throw httpError(400, error.message, error.code || "PORTAL_GREETING_SETTINGS_INVALID");
    }
    throw error;
  }
}

function getWifiAutomationPolicy() {
  const settings = getPortalSettings();
  return {
    minimumPresenceMinutes: Math.min(120, Math.max(1, Number(settings.wifi_minimum_presence_minutes || 5))),
    absenceGraceMinutes: Math.min(240, Math.max(1, Number(settings.wifi_absence_grace_minutes || 30))),
    endTimestampMode: "first_disconnect",
    connectorStatus: "not_configured",
    phase: "suggestions",
  };
}

function getTrustLevelPolicy() {
  const settings = getPortalSettings();
  return {
    enabled: settings.trust_levels_enabled !== "0",
    visibleToManagers: settings.trust_levels_visible_to_managers === "1",
    visibleToDepartmentManagers: settings.trust_levels_visible_to_department_managers === "1",
    visibleToEmployees: settings.trust_levels_visible_to_employees !== "0",
  };
}

function validateTrustLevelPolicy(body = {}) {
  return {
    enabled: body.enabled !== false,
    visibleToManagers: body.visibleToManagers === true,
    visibleToDepartmentManagers: body.visibleToDepartmentManagers === true,
    visibleToEmployees: body.visibleToEmployees !== false,
  };
}

function normalizeTimeConfirmationLevel(value) {
  const level = String(value || "C").trim().toUpperCase();
  return ["A", "B", "C"].includes(level) ? level : "C";
}

function effectiveTimeConfirmationLevel(value, policy = getTrustLevelPolicy()) {
  return policy.enabled ? normalizeTimeConfirmationLevel(value) : "C";
}

function validateWifiAutomationPolicy(body = {}) {
  const minimumPresenceMinutes = Number(body.minimumPresenceMinutes);
  const absenceGraceMinutes = Number(body.absenceGraceMinutes);
  if (!Number.isInteger(minimumPresenceMinutes) || minimumPresenceMinutes < 1 || minimumPresenceMinutes > 120) {
    throw httpError(400, "Die Mindestanwesenheit muss zwischen 1 und 120 Minuten liegen.", "WIFI_POLICY_INVALID");
  }
  if (!Number.isInteger(absenceGraceMinutes) || absenceGraceMinutes < 1 || absenceGraceMinutes > 240) {
    throw httpError(400, "Die Abwesenheitstoleranz muss zwischen 1 und 240 Minuten liegen.", "WIFI_POLICY_INVALID");
  }
  return { minimumPresenceMinutes, absenceGraceMinutes };
}

function wifiConfirmationLevels() {
  return db.prepare(`
    SELECT personnel_number, full_name, nickname, active, time_confirmation_level
    FROM employees
    ORDER BY active DESC, CAST(personnel_number AS INTEGER), personnel_number
  `).all().map((employee) => ({
    employeeNumber: employee.personnel_number,
    fullName: employee.full_name,
    nickname: employee.nickname,
    active: Boolean(employee.active),
    level: ["A", "B", "C"].includes(String(employee.time_confirmation_level || "").toUpperCase())
      ? String(employee.time_confirmation_level).toUpperCase()
      : "C",
  }));
}

function validateWifiConfirmationLevels(body = {}) {
  if (!Array.isArray(body.levels) || body.levels.length > 1000) {
    throw httpError(400, "Bitte eine gültige Liste mit höchstens 1000 Teammitgliedern übermitteln.", "WIFI_CONFIRMATION_LEVELS_INVALID");
  }
  const seen = new Set();
  return body.levels.map((item) => {
    const employeeNumber = String(item.employeeNumber || "").trim();
    const level = String(item.level || "").trim().toUpperCase();
    if (!employeeNumber || seen.has(employeeNumber) || !["A", "B", "C"].includes(level)) {
      throw httpError(400, "Die übermittelten Vertrauensstufen sind ungültig.", "WIFI_CONFIRMATION_LEVELS_INVALID");
    }
    if (!db.prepare("SELECT 1 FROM employees WHERE personnel_number = ?").get(employeeNumber)) {
      throw httpError(404, `Teammitglied ${employeeNumber} wurde nicht gefunden.`, "EMPLOYEE_NOT_FOUND");
    }
    seen.add(employeeNumber);
    return { employeeNumber, level };
  });
}

const wifiWebhookRateLimits = new Map();
const wifiEventTypes = new Set(["connected", "seen", "disconnected"]);
const wifiForbiddenEventFields = new Set(["mac", "macaddress", "mac_address", "bssid", "ssid", "device", "deviceid", "device_id"]);

function wifiCanonicalReference(value, { caseSensitive = false } = {}) {
  const normalized = String(value || "").trim().replace(/\s+/g, " ");
  return caseSensitive ? normalized : normalized.toLocaleLowerCase("de");
}

function wifiReferenceHash(kind, value, providerId = wifiProviderId, options = {}) {
  if (!wifiIdentitySecret?.value) throw httpError(503, "Der private WLAN-Identitätsschlüssel ist nicht verfügbar.", "WIFI_IDENTITY_KEY_UNAVAILABLE");
  const normalized = wifiCanonicalReference(value, options);
  return crypto.createHmac("sha256", wifiIdentitySecret.value)
    .update(`${providerId}\0${kind}\0${normalized}`, "utf8").digest("hex");
}

function wifiWebhookConfigured() {
  return Boolean(wifiWebhookSecret?.value && wifiWebhookSecret.value.length >= 32);
}

function wifiConnectorPayload(actor = null) {
  const maySeeTechnicalHint = actor?.employeeNumber === "local" || ["developer", "it_admin", "admin"].includes(actor?.role);
  return {
    configured: wifiWebhookConfigured(),
    providerId: wifiProviderId,
    eventEndpoint: "/api/integrations/wifi/events",
    secretSource: wifiWebhookSecret?.source || "missing",
    configurationHint: !wifiWebhookConfigured()
      ? "Im Serverbetrieb muss GRABENPLANER_WIFI_WEBHOOK_SECRET mit mindestens 32 Zeichen gesetzt werden."
      : wifiWebhookSecret?.source === "environment"
        ? "Der Webhook-Schlüssel wird sicher aus der Serverumgebung geladen."
        : maySeeTechnicalHint
          ? "Der Webhook-Schlüssel liegt geschützt im privaten Datenverzeichnis."
          : "Die WLAN-Schnittstelle ist geschützt konfiguriert.",
  };
}

function wifiLocationMappings() {
  const mapped = new Map(db.prepare(`
    SELECT location_id, updated_at FROM wifi_location_mappings WHERE provider_id = ?
  `).all(wifiProviderId).map((row) => [row.location_id, row.updated_at]));
  return db.prepare("SELECT id, name, active FROM locations ORDER BY active DESC, id").all().map((location) => ({
    locationId: location.id,
    locationName: location.name,
    active: Boolean(location.active),
    mapped: mapped.has(location.id),
    updatedAt: mapped.get(location.id) || null,
  }));
}

function saveWifiLocationMappings(actor, body = {}) {
  if (!Array.isArray(body.mappings) || body.mappings.length > 1000) {
    throw httpError(400, "Bitte gültige Standortzuordnungen übermitteln.", "WIFI_LOCATION_MAPPINGS_INVALID");
  }
  const seen = new Set();
  const normalized = body.mappings.map((item) => {
    const locationId = normalizeLocationId(item.locationId || "");
    if (!locationId || seen.has(locationId)) throw httpError(400, "Eine Standortzuordnung ist doppelt oder ungültig.", "WIFI_LOCATION_MAPPINGS_INVALID");
    validateLocationExists(locationId);
    seen.add(locationId);
    const clear = item.clear === true;
    const externalReference = wifiCanonicalReference(item.externalReference || "");
    if (!clear && (externalReference.length < 1 || externalReference.length > 200)) {
      throw httpError(400, `Für Filiale ${locationId} fehlt eine gültige Controller-Kennung.`, "WIFI_LOCATION_MAPPINGS_INVALID");
    }
    return { locationId, clear, externalReference };
  });
  const remove = db.prepare("DELETE FROM wifi_location_mappings WHERE provider_id = ? AND location_id = ?");
  const upsert = db.prepare(`
    INSERT INTO wifi_location_mappings
      (provider_id, location_id, external_location_hash, updated_by, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(provider_id, location_id) DO UPDATE SET
      external_location_hash = excluded.external_location_hash,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const item of normalized) {
      if (item.clear) remove.run(wifiProviderId, item.locationId);
      else upsert.run(wifiProviderId, item.locationId, wifiReferenceHash("location", item.externalReference), actor.employeeNumber);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    if (String(error.message || "").includes("UNIQUE")) {
      throw httpError(409, "Eine Controller-Kennung darf nur einer Filiale zugeordnet sein.", "WIFI_LOCATION_MAPPING_CONFLICT");
    }
    throw error;
  }
  auditPortal(actor.employeeNumber, "wifi.location_mappings.update", "wifi_location_mapping", wifiProviderId,
    JSON.stringify({ locations: normalized.map((item) => ({ locationId: item.locationId, cleared: item.clear })) }));
  return wifiLocationMappings();
}

function wifiAutomationPreference(employeeNumber) {
  const row = db.prepare(`
    SELECT employee_number, enabled, provider_id, opted_in_at, opted_out_at, updated_at
    FROM wifi_automation_preferences WHERE employee_number = ?
  `).get(employeeNumber);
  return row ? {
    enabled: Boolean(row.enabled),
    providerId: row.provider_id || wifiProviderId,
    optedInAt: row.opted_in_at,
    optedOutAt: row.opted_out_at,
    updatedAt: row.updated_at,
  } : { enabled: false, providerId: wifiProviderId, optedInAt: null, optedOutAt: null, updatedAt: null };
}

function setWifiAutomationPreference(session, enabled) {
  const employeeNumber = session.employeeNumber;
  const externalSubjectHash = enabled ? wifiReferenceHash("subject", employeeNumber) : null;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO wifi_automation_preferences
        (employee_number, enabled, provider_id, external_subject_hash, opted_in_at, opted_out_at, updated_by, updated_at)
      VALUES (?, ?, ?, ?, CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP END,
        CASE WHEN ? = 0 THEN CURRENT_TIMESTAMP END, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(employee_number) DO UPDATE SET
        enabled = excluded.enabled,
        provider_id = excluded.provider_id,
        external_subject_hash = excluded.external_subject_hash,
        opted_in_at = CASE WHEN excluded.enabled = 1 THEN COALESCE(wifi_automation_preferences.opted_in_at, CURRENT_TIMESTAMP) ELSE wifi_automation_preferences.opted_in_at END,
        opted_out_at = CASE WHEN excluded.enabled = 0 THEN CURRENT_TIMESTAMP ELSE NULL END,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `).run(employeeNumber, enabled ? 1 : 0, enabled ? wifiProviderId : null, externalSubjectHash,
      enabled ? 1 : 0, enabled ? 1 : 0, employeeNumber);
    if (!enabled) {
      db.prepare(`
        UPDATE wifi_presence_sessions SET state = 'cancelled', observed_end_at = COALESCE(observed_end_at, last_seen_at), updated_at = CURRENT_TIMESTAMP
        WHERE employee_number = ? AND state IN ('observing','present','grace')
      `).run(employeeNumber);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  auditPortal(employeeNumber, enabled ? "wifi.preference.enable" : "wifi.preference.disable", "wifi_automation_preference", employeeNumber);
  return wifiAutomationPreference(employeeNumber);
}

function wifiConfirmationDueAt(workDate, level) {
  const weekEnd = addDays(getMonday(workDate), 6);
  if (level === "A") return viennaLocalDateTime(weekEnd, "23:00").toISOString();
  if (level === "B") {
    const threeDayLimit = viennaLocalDateTime(addDays(workDate, 3), "12:00");
    const weekLimit = viennaLocalDateTime(weekEnd, "23:00");
    return new Date(Math.min(threeDayLimit.getTime(), weekLimit.getTime())).toISOString();
  }
  return viennaLocalDateTime(addDays(workDate, 1), "12:00").toISOString();
}

function splitWifiPresenceByWorkDate(startAt, endAt) {
  const start = new Date(startAt);
  const end = new Date(endAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return [];
  const result = [];
  let cursor = start;
  while (cursor < end && result.length < 8) {
    const workDate = viennaTodayIso(cursor);
    const nextMidnight = viennaLocalDateTime(addDays(workDate, 1), "00:00");
    const segmentEnd = new Date(Math.min(end.getTime(), nextMidnight.getTime()));
    if (segmentEnd > cursor) result.push({ workDate, startAt: cursor.toISOString(), endAt: segmentEnd.toISOString() });
    cursor = segmentEnd;
  }
  return result;
}

function wifiSuggestionWarning(row, now = new Date()) {
  if (row.status !== "pending") return "none";
  const dueAt = new Date(row.confirmation_due_at || 0);
  if (Number.isNaN(dueAt.getTime())) return "pending";
  const remaining = dueAt.getTime() - now.getTime();
  if (remaining <= 0) return "overdue";
  if (remaining <= 24 * 60 * 60 * 1000) return "due_soon";
  return "pending";
}

function serializeWifiSuggestion(row, now = new Date()) {
  const startAt = row.confirmed_start_at || row.suggested_start_at;
  const endAt = row.confirmed_end_at || row.suggested_end_at;
  return {
    id: row.id,
    workDate: row.work_date,
    weekStart: getMonday(row.work_date),
    locationId: row.location_id,
    locationName: row.location_name || row.location_id,
    suggestedStartAt: row.suggested_start_at,
    suggestedEndAt: row.suggested_end_at,
    startTime: viennaNowLocal(new Date(startAt)).slice(11, 16),
    endTime: viennaNowLocal(new Date(endAt)).slice(11, 16),
    breakStartTime: row.confirmed_break_start_at ? viennaNowLocal(new Date(row.confirmed_break_start_at)).slice(11, 16) : "",
    breakEndTime: row.confirmed_break_end_at ? viennaNowLocal(new Date(row.confirmed_break_end_at)).slice(11, 16) : "",
    level: row.confirmation_level_snapshot || "C",
    dueAt: row.confirmation_due_at,
    status: row.status,
    warning: wifiSuggestionWarning(row, now),
    confirmedAt: row.confirmed_at,
    rejectedAt: row.rejected_at,
    rejectionReason: row.rejection_reason || "",
  };
}

function createWifiSuggestionsForSession(sessionRow, now = new Date()) {
  const employee = db.prepare(`
    SELECT time_confirmation_level FROM employees WHERE personnel_number = ? AND active = 1
  `).get(sessionRow.employee_number);
  if (!employee) return [];
  const level = effectiveTimeConfirmationLevel(employee.time_confirmation_level);
  const policy = getWifiAutomationPolicy();
  const created = [];
  const insert = db.prepare(`
    INSERT OR IGNORE INTO wifi_time_suggestions
      (id, presence_session_id, employee_number, location_id, work_date,
       suggested_start_at, suggested_end_at, confirmation_level_snapshot,
       minimum_presence_minutes_snapshot, absence_grace_minutes_snapshot, confirmation_due_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const segment of splitWifiPresenceByWorkDate(sessionRow.observed_start_at, sessionRow.observed_end_at)) {
    if (new Date(segment.endAt).getTime() - new Date(segment.startAt).getTime() < 60 * 1000) continue;
    const id = crypto.randomUUID();
    const result = insert.run(id, sessionRow.id, sessionRow.employee_number, sessionRow.location_id, segment.workDate,
      segment.startAt, segment.endAt, level, policy.minimumPresenceMinutes, policy.absenceGraceMinutes,
      wifiConfirmationDueAt(segment.workDate, level));
    if (!result.changes) continue;
    created.push(id);
    createPortalNotification(sessionRow.employee_number, "wifi.suggestion", "Neuer WLAN-Zeitvorschlag",
      `Für ${segment.workDate} liegt ein Zeitvorschlag zur Prüfung bereit.`, {
        target: "/portal.html?tab=settings",
        entityType: "wifi_time_suggestion",
        entityId: id,
        dedupeKey: `wifi-suggestion:${id}:created`,
      });
  }
  if (created.length) {
    auditPortal("wifi-controller", "wifi.suggestions.create", "wifi_presence_session", sessionRow.id,
      JSON.stringify({ count: created.length, locationId: sessionRow.location_id }));
  }
  return created;
}

function finalizeWifiPresenceSession(row, now = new Date()) {
  const endAt = row.disconnect_observed_at || row.observed_end_at || row.last_seen_at;
  const start = new Date(row.observed_start_at);
  const end = new Date(endAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    db.prepare("UPDATE wifi_presence_sessions SET state = 'invalid', observed_end_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(endAt || now.toISOString(), row.id);
    return [];
  }
  const policy = getWifiAutomationPolicy();
  const durationMinutes = Math.floor((end.getTime() - start.getTime()) / 60000);
  const state = durationMinutes >= policy.minimumPresenceMinutes ? "closed" : "ignored_short";
  db.prepare(`
    UPDATE wifi_presence_sessions
    SET observed_end_at = ?, state = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(end.toISOString(), state, row.id);
  if (state !== "closed") return [];
  return createWifiSuggestionsForSession({ ...row, observed_end_at: end.toISOString() }, now);
}

function finalizeExpiredWifiPresenceSessions(now = new Date()) {
  const policy = getWifiAutomationPolicy();
  const rows = db.prepare(`
    SELECT * FROM wifi_presence_sessions
    WHERE state = 'grace' AND disconnect_observed_at IS NOT NULL
    ORDER BY disconnect_observed_at
  `).all();
  let finalized = 0;
  let suggestions = 0;
  for (const candidate of rows) {
    const disconnectedAt = new Date(candidate.disconnect_observed_at);
    if (Number.isNaN(disconnectedAt.getTime()) || disconnectedAt.getTime() + policy.absenceGraceMinutes * 60000 > now.getTime()) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = db.prepare("SELECT * FROM wifi_presence_sessions WHERE id = ? AND state = 'grace'").get(candidate.id);
      if (current) {
        suggestions += finalizeWifiPresenceSession(current, now).length;
        finalized += 1;
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
  return { finalized, suggestions };
}

function assertWifiWebhookRateLimit(request) {
  const key = loginRateKey(request);
  const now = Date.now();
  const windowMs = 5 * 60 * 1000;
  const recent = (wifiWebhookRateLimits.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
  if (recent.length >= 300) {
    const error = httpError(429, "Zu viele WLAN-Ereignisse. Bitte die Controller-Konfiguration prüfen.", "WIFI_WEBHOOK_RATE_LIMITED");
    error.retryAfter = Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
    throw error;
  }
  recent.push(now);
  wifiWebhookRateLimits.set(key, recent);
}

function assertWifiWebhookAuthorization(request) {
  if (!wifiWebhookConfigured()) throw httpError(503, "Die WLAN-Ereignisschnittstelle ist nicht konfiguriert.", "WIFI_WEBHOOK_NOT_CONFIGURED");
  const authorization = String(request.headers.authorization || "");
  const provided = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : String(request.headers["x-grabenplaner-wifi-token"] || "").trim();
  const expected = wifiWebhookSecret.value;
  const valid = provided.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!valid) throw httpError(403, "Die WLAN-Ereignisschnittstelle hat den Zugriff abgelehnt.", "WIFI_WEBHOOK_DENIED");
}

function validateWifiEvent(body = {}, now = new Date()) {
  const forbidden = Object.keys(body).find((key) => wifiForbiddenEventFields.has(String(key).toLowerCase()));
  if (forbidden) throw httpError(400, "Hardware-Adressen, SSIDs und Gerätekennungen dürfen nicht übermittelt werden.", "WIFI_EVENT_PRIVACY_FIELD_REJECTED");
  const providerId = String(body.providerId || wifiProviderId).trim().toLowerCase();
  if (providerId !== wifiProviderId) throw httpError(400, "Die Provider-Kennung passt nicht zur konfigurierten Schnittstelle.", "WIFI_EVENT_PROVIDER_INVALID");
  const eventType = String(body.eventType || "").trim().toLowerCase();
  const externalEventId = wifiCanonicalReference(body.eventId || body.externalEventId || "", { caseSensitive: true });
  const employeeReference = wifiCanonicalReference(body.employeeReference || "");
  const locationReference = wifiCanonicalReference(body.locationReference || "");
  const occurredAt = new Date(body.occurredAt || "");
  if (!wifiEventTypes.has(eventType)) throw httpError(400, "Der WLAN-Ereignistyp ist ungültig.", "WIFI_EVENT_TYPE_INVALID");
  if (!externalEventId || externalEventId.length > 240 || !employeeReference || employeeReference.length > 160
    || !locationReference || locationReference.length > 200 || Number.isNaN(occurredAt.getTime())) {
    throw httpError(400, "Das WLAN-Ereignis ist unvollständig oder ungültig.", "WIFI_EVENT_INVALID");
  }
  const age = now.getTime() - occurredAt.getTime();
  if (age < -10 * 60 * 1000 || age > 31 * 24 * 60 * 60 * 1000) {
    throw httpError(400, "Der Zeitpunkt des WLAN-Ereignisses liegt außerhalb des zulässigen Fensters.", "WIFI_EVENT_TIME_INVALID");
  }
  return { providerId, eventType, externalEventId, employeeReference, locationReference, occurredAt };
}

function processWifiEvent(input, now = new Date()) {
  // Controller können Ereignisse kurz verzögert oder gebündelt liefern. Bereits offene
  // Toleranzfenster werden deshalb relativ zum Ereigniszeitpunkt geschlossen, damit ein
  // zeitlich korrekter Reconnect nicht durch die spätere Zustellung fälschlich geteilt wird.
  finalizeExpiredWifiPresenceSessions(input.occurredAt);
  const externalEventHash = wifiReferenceHash("event", input.externalEventId, input.providerId, { caseSensitive: true });
  const externalSubjectHash = wifiReferenceHash("subject", input.employeeReference, input.providerId);
  const externalLocationHash = wifiReferenceHash("location", input.locationReference, input.providerId);
  const inboxId = crypto.randomUUID();
  const payloadFingerprint = sha256(JSON.stringify({
    providerId: input.providerId,
    eventType: input.eventType,
    externalEventHash,
    externalSubjectHash,
    externalLocationHash,
    occurredAt: input.occurredAt.toISOString(),
  }));
  db.exec("BEGIN IMMEDIATE");
  try {
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO wifi_event_inbox
        (id, provider_id, external_event_hash, event_type, external_subject_hash,
         location_reference_hash, occurred_at, payload_fingerprint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(inboxId, input.providerId, externalEventHash, input.eventType, externalSubjectHash,
      externalLocationHash, input.occurredAt.toISOString(), payloadFingerprint);
    if (!inserted.changes) {
      db.exec("COMMIT");
      return { accepted: true, duplicate: true, status: "duplicate" };
    }
    const preference = db.prepare(`
      SELECT p.employee_number
      FROM wifi_automation_preferences p
      JOIN employees e ON e.personnel_number = p.employee_number
      JOIN portal_users u ON u.employee_number = p.employee_number
      WHERE p.enabled = 1 AND p.provider_id = ? AND p.external_subject_hash = ?
        AND e.active = 1 AND u.active = 1
      LIMIT 1
    `).get(input.providerId, externalSubjectHash);
    if (!preference) {
      db.prepare("UPDATE wifi_event_inbox SET processing_status = 'ignored_no_opt_in', processed_at = CURRENT_TIMESTAMP WHERE id = ?").run(inboxId);
      db.exec("COMMIT");
      return { accepted: true, duplicate: false, status: "ignored_no_opt_in" };
    }
    const mapping = db.prepare(`
      SELECT location_id FROM wifi_location_mappings
      WHERE provider_id = ? AND external_location_hash = ?
    `).get(input.providerId, externalLocationHash);
    if (!mapping) {
      db.prepare("UPDATE wifi_event_inbox SET processing_status = 'ignored_unknown_location', processed_at = CURRENT_TIMESTAMP WHERE id = ?").run(inboxId);
      db.exec("COMMIT");
      return { accepted: true, duplicate: false, status: "ignored_unknown_location" };
    }
    const policy = getWifiAutomationPolicy();
    let session = db.prepare(`
      SELECT * FROM wifi_presence_sessions
      WHERE employee_number = ? AND location_id = ? AND provider_id = ?
        AND state IN ('observing','present','grace')
      ORDER BY observed_start_at DESC LIMIT 1
    `).get(preference.employee_number, mapping.location_id, input.providerId);
    let processingStatus = "processed";
    if (input.eventType === "connected" || input.eventType === "seen") {
      if (session?.state === "grace") {
        const disconnectedAt = new Date(session.disconnect_observed_at);
        const withinGrace = !Number.isNaN(disconnectedAt.getTime())
          && input.occurredAt >= disconnectedAt
          && input.occurredAt.getTime() <= disconnectedAt.getTime() + policy.absenceGraceMinutes * 60000;
        if (withinGrace) {
          db.prepare(`
            UPDATE wifi_presence_sessions SET last_seen_at = ?, disconnect_observed_at = NULL,
              observed_end_at = NULL, state = 'present', updated_at = CURRENT_TIMESTAMP WHERE id = ?
          `).run(input.occurredAt.toISOString(), session.id);
          processingStatus = "reconnected_within_grace";
        } else {
          finalizeWifiPresenceSession(session, now);
          session = null;
        }
      }
      if (session && session.state !== "grace") {
        if (input.occurredAt < new Date(session.observed_start_at)) processingStatus = "ignored_out_of_order";
        else {
          const durationMinutes = Math.floor((input.occurredAt.getTime() - new Date(session.observed_start_at).getTime()) / 60000);
          db.prepare(`
            UPDATE wifi_presence_sessions SET last_seen_at = ?, state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
          `).run(input.occurredAt.toISOString(), durationMinutes >= policy.minimumPresenceMinutes ? "present" : "observing", session.id);
        }
      } else if (!session) {
        const sessionId = crypto.randomUUID();
        db.prepare(`
          INSERT INTO wifi_presence_sessions
            (id, employee_number, location_id, provider_id, correlation_hash, observed_start_at, last_seen_at, state)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'observing')
        `).run(sessionId, preference.employee_number, mapping.location_id, input.providerId,
          wifiReferenceHash("correlation", `${externalSubjectHash}:${externalLocationHash}`),
          input.occurredAt.toISOString(), input.occurredAt.toISOString());
        session = { id: sessionId };
        processingStatus = "session_started";
      }
    } else {
      if (!session || session.state === "grace") processingStatus = "ignored_without_open_session";
      else if (input.occurredAt < new Date(session.observed_start_at)) processingStatus = "ignored_out_of_order";
      else {
        db.prepare(`
          UPDATE wifi_presence_sessions SET disconnect_observed_at = ?, state = 'grace', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(input.occurredAt.toISOString(), session.id);
        processingStatus = "grace_started";
      }
    }
    db.prepare(`
      UPDATE wifi_event_inbox SET processing_status = ?, presence_session_id = ?, processed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(processingStatus, session?.id || null, inboxId);
    auditPortal("wifi-controller", "wifi.event.process", "wifi_event", inboxId,
      JSON.stringify({ type: input.eventType, status: processingStatus, providerId: input.providerId }));
    db.exec("COMMIT");
    return { accepted: true, duplicate: false, status: processingStatus };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function wifiAutomationEmployeePayload(session, now = new Date()) {
  finalizeExpiredWifiPresenceSessions(now);
  const employee = db.prepare(`
    SELECT e.time_confirmation_level, e.home_location_id, l.name AS location_name, l.time_tracking_enabled
    FROM employees e LEFT JOIN locations l ON l.id = e.home_location_id
    WHERE e.personnel_number = ?
  `).get(session.employeeNumber);
  if (!employee) throw httpError(404, "Das Teammitglied wurde nicht gefunden.", "EMPLOYEE_NOT_FOUND");
  const connector = wifiConnectorPayload();
  const mapped = Boolean(db.prepare(`
    SELECT 1 FROM wifi_location_mappings WHERE provider_id = ? AND location_id = ?
  `).get(wifiProviderId, employee.home_location_id));
  const trackingEnabled = Boolean(employee.time_tracking_enabled);
  const canEnable = connector.configured && mapped && trackingEnabled;
  const preference = wifiAutomationPreference(session.employeeNumber);
  const cutoff = addDays(viennaTodayIso(now), -183);
  const rows = db.prepare(`
    SELECT s.*, l.name AS location_name
    FROM wifi_time_suggestions s LEFT JOIN locations l ON l.id = s.location_id
    WHERE s.employee_number = ? AND (s.status = 'pending' OR s.work_date >= ?)
    ORDER BY s.work_date DESC, s.suggested_start_at DESC
  `).all(session.employeeNumber, cutoff);
  const confirmationLevelVisible = employeeCanViewOwnTimeConfirmationLevel();
  const confirmationLevel = effectiveTimeConfirmationLevel(employee.time_confirmation_level);
  const suggestions = rows.map((row) => {
    const suggestion = serializeWifiSuggestion(row, now);
    if (!confirmationLevelVisible) delete suggestion.level;
    return suggestion;
  });
  for (const suggestion of suggestions.filter((item) => item.status === "pending" && ["due_soon", "overdue"].includes(item.warning))) {
    const overdue = suggestion.warning === "overdue";
    createPortalNotification(session.employeeNumber, overdue ? "wifi.suggestion.overdue" : "wifi.suggestion.due",
      overdue ? "WLAN-Zeitvorschlag überfällig" : "WLAN-Zeitvorschlag bald bestätigen",
      `Der Vorschlag für ${suggestion.workDate} wartet auf deine Bestätigung.`, {
        target: "/portal.html?tab=settings",
        entityType: "wifi_time_suggestion",
        entityId: suggestion.id,
        dedupeKey: `wifi-suggestion:${suggestion.id}:${suggestion.warning}`,
      });
  }
  return {
    providerId: wifiProviderId,
    connectorConfigured: connector.configured,
    locationMapped: mapped,
    trackingEnabled,
    canEnable,
    availabilityReason: !connector.configured
      ? "Die WLAN-Schnittstelle ist noch nicht durch die IT konfiguriert."
      : !mapped
        ? "Für deine Stammfiliale fehlt noch die Controller-Zuordnung."
        : !trackingEnabled
          ? "Die Zeiterfassung ist für deine Stammfiliale noch nicht aktiviert."
          : "",
    locationId: employee.home_location_id,
    locationName: employee.location_name || employee.home_location_id,
    confirmationLevel: confirmationLevelVisible ? confirmationLevel : null,
    confirmationLevelVisible,
    trustLevelsEnabled: getTrustLevelPolicy().enabled,
    canConfirmWeek: confirmationLevel === "A",
    preference,
    suggestions,
    counts: {
      pending: suggestions.filter((item) => item.status === "pending").length,
      dueSoon: suggestions.filter((item) => item.warning === "due_soon").length,
      overdue: suggestions.filter((item) => item.warning === "overdue").length,
    },
  };
}

function wifiSuggestionForEmployee(id, employeeNumber) {
  return db.prepare(`
    SELECT s.*, l.name AS location_name
    FROM wifi_time_suggestions s LEFT JOIN locations l ON l.id = s.location_id
    WHERE s.id = ? AND s.employee_number = ?
  `).get(String(id || ""), employeeNumber);
}

function validateWifiSuggestionConfirmation(row, input = {}, now = new Date()) {
  const defaultStart = viennaNowLocal(new Date(row.suggested_start_at)).slice(11, 16);
  const defaultEnd = viennaNowLocal(new Date(row.suggested_end_at)).slice(11, 16);
  const startTime = String(input.startTime || defaultStart).trim();
  const endTime = String(input.endTime || defaultEnd).trim();
  const breakStartTime = String(input.breakStartTime || "").trim();
  const breakEndTime = String(input.breakEndTime || "").trim();
  if (!isTime(startTime) || !isTime(endTime)) {
    throw httpError(400, "Bitte Beginn und Ende vollständig eingeben.", "WIFI_SUGGESTION_TIME_INVALID");
  }
  const startAt = viennaLocalDateTime(row.work_date, startTime);
  const endAt = viennaLocalDateTime(row.work_date, endTime);
  if (endAt <= startAt || endAt.getTime() - startAt.getTime() > 24 * 60 * 60 * 1000) {
    throw httpError(400, "Das Ende muss nach dem Beginn liegen.", "WIFI_SUGGESTION_TIME_INVALID");
  }
  if (endAt.getTime() > now.getTime() + 10 * 60 * 1000) {
    throw httpError(400, "Ein Zeitvorschlag darf nicht in die Zukunft bestätigt werden.", "WIFI_SUGGESTION_TIME_INVALID");
  }
  let breakStartAt = null;
  let breakEndAt = null;
  if (breakStartTime || breakEndTime) {
    if (!isTime(breakStartTime) || !isTime(breakEndTime)) {
      throw httpError(400, "Bitte für die Pause sowohl Beginn als auch Ende eingeben.", "WIFI_SUGGESTION_BREAK_INVALID");
    }
    breakStartAt = viennaLocalDateTime(row.work_date, breakStartTime);
    breakEndAt = viennaLocalDateTime(row.work_date, breakEndTime);
    if (!(startAt < breakStartAt && breakStartAt < breakEndAt && breakEndAt < endAt)) {
      throw httpError(400, "Die Pause muss vollständig zwischen Arbeitsbeginn und Arbeitsende liegen.", "WIFI_SUGGESTION_BREAK_INVALID");
    }
  }
  return { startTime, endTime, breakStartTime, breakEndTime, startAt, endAt, breakStartAt, breakEndAt };
}

function confirmWifiSuggestionBatch(session, items, now = new Date()) {
  if (!Array.isArray(items) || !items.length || items.length > 31) {
    throw httpError(400, "Bitte mindestens einen und höchstens 31 Zeitvorschläge übermitteln.", "WIFI_SUGGESTION_BATCH_INVALID");
  }
  const uniqueIds = new Set(items.map((item) => String(item.id || "").trim()).filter(Boolean));
  if (uniqueIds.size !== items.length) throw httpError(400, "Ein Zeitvorschlag wurde doppelt übermittelt.", "WIFI_SUGGESTION_BATCH_INVALID");
  const confirmed = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const item of items) {
      const row = wifiSuggestionForEmployee(item.id, session.employeeNumber);
      if (!row) throw httpError(404, "Der WLAN-Zeitvorschlag wurde nicht gefunden.", "WIFI_SUGGESTION_NOT_FOUND");
      if (row.status !== "pending") throw httpError(409, "Der WLAN-Zeitvorschlag wurde bereits bearbeitet.", "WIFI_SUGGESTION_ALREADY_DECIDED");
      const values = validateWifiSuggestionConfirmation(row, item, now);
      const departmentId = scheduledTimeEntryDepartment(session.employeeNumber, row.work_date, values.startTime)
        || employeeRequestContext(session.employeeNumber, row.work_date).departmentId;
      const additions = [
        { entry_type: "clock_in", entry_timestamp: values.startAt.toISOString() },
        ...(values.breakStartAt ? [
          { entry_type: "break_start", entry_timestamp: values.breakStartAt.toISOString() },
          { entry_type: "break_end", entry_timestamp: values.breakEndAt.toISOString() },
        ] : []),
        { entry_type: "clock_out", entry_timestamp: values.endAt.toISOString() },
      ];
      const existing = timeEntriesForDay(session.employeeNumber, row.work_date);
      const parsed = parseTimeEntrySequence([...existing, ...additions], row.work_date, now);
      if (parsed.errors.length || parsed.incomplete) {
        throw httpError(409, "Der Vorschlag überschneidet sich mit bestehenden Buchungen oder ergibt keine gültige Buchungsfolge.", "WIFI_SUGGESTION_TIME_CONFLICT");
      }
      const insert = db.prepare(`
        INSERT INTO time_entries
          (employee_number, location_id, department_id, work_date, entry_type, entry_timestamp, source, note, created_by)
        VALUES (?, ?, ?, ?, ?, ?, 'wifi_confirmed', 'Bestätigter WLAN-Zeitvorschlag', ?)
      `);
      for (const entry of additions) {
        insert.run(session.employeeNumber, row.location_id, departmentId, row.work_date,
          entry.entry_type, entry.entry_timestamp, session.employeeNumber);
      }
      const updated = db.prepare(`
        UPDATE wifi_time_suggestions SET status = 'confirmed',
          confirmed_start_at = ?, confirmed_end_at = ?,
          confirmed_break_start_at = ?, confirmed_break_end_at = ?,
          confirmed_by = ?, confirmed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND employee_number = ? AND status = 'pending'
      `).run(values.startAt.toISOString(), values.endAt.toISOString(),
        values.breakStartAt?.toISOString() || null, values.breakEndAt?.toISOString() || null,
        session.employeeNumber, row.id, session.employeeNumber);
      if (!updated.changes) throw httpError(409, "Der Zeitvorschlag wurde zwischenzeitlich bearbeitet.", "WIFI_SUGGESTION_ALREADY_DECIDED");
      invalidateTimeDayReview(session.employeeNumber, row.work_date);
      auditPortal(session.employeeNumber, "wifi.suggestion.confirm", "wifi_time_suggestion", row.id,
        JSON.stringify({ workDate: row.work_date, startTime: values.startTime, endTime: values.endTime, break: Boolean(values.breakStartAt) }));
      confirmed.push(row.id);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return confirmed;
}

function confirmWifiSuggestionWeek(session, body = {}, now = new Date()) {
  const employee = db.prepare("SELECT time_confirmation_level FROM employees WHERE personnel_number = ?").get(session.employeeNumber);
  if (effectiveTimeConfirmationLevel(employee?.time_confirmation_level) !== "A") {
    throw httpError(403, "Der Wochenabschluss ist nur für Vertrauensstufe A verfügbar.", "WIFI_WEEK_CONFIRMATION_NOT_ALLOWED");
  }
  const weekStart = String(body.weekStart || "").trim();
  if (!isIsoDate(weekStart) || getMonday(weekStart) !== weekStart) {
    throw httpError(400, "Bitte eine gültige Kalenderwoche auswählen.", "WIFI_SUGGESTION_WEEK_INVALID");
  }
  const pendingIds = db.prepare(`
    SELECT id FROM wifi_time_suggestions
    WHERE employee_number = ? AND status = 'pending' AND work_date BETWEEN ? AND ?
    ORDER BY work_date, suggested_start_at
  `).all(session.employeeNumber, weekStart, addDays(weekStart, 6)).map((row) => row.id);
  const submittedIds = Array.isArray(body.suggestions) ? body.suggestions.map((item) => String(item.id || "")) : [];
  if (!pendingIds.length || pendingIds.length !== submittedIds.length || pendingIds.some((id) => !submittedIds.includes(id))) {
    throw httpError(409, "Bitte alle offenen Vorschläge dieser Woche gemeinsam prüfen und erneut abschließen.", "WIFI_SUGGESTION_WEEK_INCOMPLETE");
  }
  return confirmWifiSuggestionBatch(session, body.suggestions, now);
}

function rejectWifiSuggestion(session, id, reason = "") {
  const row = wifiSuggestionForEmployee(id, session.employeeNumber);
  if (!row) throw httpError(404, "Der WLAN-Zeitvorschlag wurde nicht gefunden.", "WIFI_SUGGESTION_NOT_FOUND");
  if (row.status !== "pending") throw httpError(409, "Der WLAN-Zeitvorschlag wurde bereits bearbeitet.", "WIFI_SUGGESTION_ALREADY_DECIDED");
  const cleanReason = stripEmoji(String(reason || "").trim()).slice(0, 300);
  const result = db.prepare(`
    UPDATE wifi_time_suggestions SET status = 'rejected', rejected_by = ?, rejected_at = CURRENT_TIMESTAMP,
      rejection_reason = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND employee_number = ? AND status = 'pending'
  `).run(session.employeeNumber, cleanReason, row.id, session.employeeNumber);
  if (!result.changes) throw httpError(409, "Der WLAN-Zeitvorschlag wurde zwischenzeitlich bearbeitet.", "WIFI_SUGGESTION_ALREADY_DECIDED");
  auditPortal(session.employeeNumber, "wifi.suggestion.reject", "wifi_time_suggestion", row.id,
    JSON.stringify({ workDate: row.work_date, reasonProvided: Boolean(cleanReason) }));
}

function getAmuPolicy() {
  const settings = getPortalSettings();
  const parsedUploadMaxMb = Number(settings.amu_upload_max_mb);
  const uploadMaxMb = Number.isFinite(parsedUploadMaxMb)
    ? Math.min(25, Math.max(1, parsedUploadMaxMb))
    : 10;
  const parsedStoredMaxMb = Number(settings.amu_stored_max_mb);
  const storedMaxMb = Number.isFinite(parsedStoredMaxMb)
    ? Math.min(uploadMaxMb, Math.max(0.5, parsedStoredMaxMb))
    : Math.min(uploadMaxMb, 2);
  const parsedLocalWarningDays = Number(settings.sickness_local_warning_days);
  const parsedHrWarningDays = Number(settings.sickness_hr_warning_days);
  let localWarningDays = Number.isFinite(parsedLocalWarningDays)
    ? Math.min(30, Math.max(0, Math.trunc(parsedLocalWarningDays)))
    : 2;
  let hrWarningDays = Number.isFinite(parsedHrWarningDays)
    ? Math.min(60, Math.max(1, Math.trunc(parsedHrWarningDays)))
    : 3;
  if (localWarningDays >= hrWarningDays) {
    localWarningDays = 2;
    hrWarningDays = 3;
  }
  return {
    uploadMaxMb,
    storedMaxMb,
    convertImagesToPdf: settings.amu_convert_images_to_pdf !== "0",
    grayscaleImages: settings.amu_grayscale_images !== "0",
    ocrEnabled: settings.amu_ocr_enabled !== "0",
    localWarningDays,
    hrWarningDays,
  };
}

const SICKNESS_ALERT_RESOLVED_RETENTION_DAYS = 90;
const OUTBOUND_NOTIFICATION_RETENTION_DAYS = 30;
const OUTBOUND_NOTIFICATION_CANCELLED_RETENTION_DAYS = 7;
const NOTIFICATION_VERIFICATION_TTL_MINUTES = 10;
const NOTIFICATION_VERIFICATION_MAX_ATTEMPTS = 5;

function sicknessCaseRetentionDays() {
  const configured = Number(getPortalSettings().amu_retention_days || 730);
  return Number.isFinite(configured) ? Math.min(3650, Math.max(30, Math.trunc(configured))) : 730;
}

function protectedPortalEntityId(kind, id) {
  return sicknessLookup(`portal-${String(kind || "record")}`, String(id || ""));
}

function protectedPortalDedupeKey(parts) {
  return `protected:${sicknessLookup("portal-notification", parts.join(":"))}`;
}

function sicknessAlertPayload(row) {
  return parseProtectedJson(row.protected_payload, sicknessAlertProtectionContext(row));
}

function sicknessNotificationContexts(payload = {}) {
  const submitted = Array.isArray(payload.staffingRisk?.contexts) ? payload.staffingRisk.contexts : [];
  const contexts = submitted.map((context) => ({
    locationId: String(context?.locationId || "").trim(),
    departmentId: Number(context?.departmentId || 0) || null,
  })).filter((context) => context.locationId);
  if (payload.locationId) {
    contexts.push({
      locationId: String(payload.locationId),
      departmentId: Number(payload.departmentId || 0) || null,
    });
  }
  return [...new Map(contexts.map((context) => [
    `${context.locationId}:${context.departmentId || 0}`,
    context,
  ])).values()];
}

function portalScopeMatchesAnyContext(role, scopes, contexts) {
  if (GLOBAL_SCOPE_PORTAL_ROLES.has(role)) return true;
  return contexts.some((context) => scopes.some((scope) => scope.locationId === context.locationId
    && (!Number(scope.departmentId || 0)
      || Number(scope.departmentId) === Number(context.departmentId || 0))));
}

function sicknessNotificationRecipients(payload, stage = "local", excludeEmployeeNumber = "") {
  const contexts = sicknessNotificationContexts(payload);
  if (!contexts.length) return [];
  const scopeRows = db.prepare(`
    SELECT employee_number, location_id, department_id
    FROM portal_access_scopes ORDER BY employee_number, location_id, department_id
  `).all();
  const scopesByEmployee = new Map();
  for (const scope of scopeRows) {
    const values = scopesByEmployee.get(scope.employee_number) || [];
    values.push({ locationId: scope.location_id, departmentId: Number(scope.department_id || 0) || null });
    scopesByEmployee.set(scope.employee_number, values);
  }
  const users = db.prepare(`
    SELECT u.employee_number, u.role, e.home_location_id, e.preferred_department_id,
           r.permissions AS role_permissions
    FROM portal_users u
    JOIN employees e ON e.personnel_number = u.employee_number
    LEFT JOIN portal_roles r ON r.id = u.role
    WHERE u.active = 1 AND TRIM(u.password_hash) <> ''
    ORDER BY u.employee_number
  `).all();
  const recipients = [];
  for (const user of users) {
    if (!user.employee_number || user.employee_number === excludeEmployeeNumber) continue;
    const permissions = new Set([
      ...parsePortalPermissions(user.role_permissions),
      ...portalPermissionGrantsForEmployee(user.employee_number),
    ]);
    if (!permissions.has("sickness:read")) continue;
    const globalScope = GLOBAL_SCOPE_PORTAL_ROLES.has(user.role);
    if (stage === "hr" && !globalScope) continue;
    let scopes = scopesByEmployee.get(user.employee_number) || [];
    if (!scopes.length && !globalScope && user.home_location_id) {
      scopes = [{
        locationId: user.home_location_id,
        departmentId: user.role === "department_manager"
          ? (Number(user.preferred_department_id || 0) || null)
          : null,
      }];
    }
    if (portalScopeMatchesAnyContext(user.role, scopes, contexts)) recipients.push(user.employee_number);
  }
  return [...new Set(recipients)];
}

function upsertSicknessAlert(caseId, kind, severity, audience) {
  const caseRow = db.prepare("SELECT id, purge_after FROM sickness_cases WHERE id = ?").get(Number(caseId));
  if (!caseRow) return { created: false, id: null, dedupeLookup: "" };
  const dedupeLookup = sicknessAlertDedupeLookup(caseId, kind, audience);
  const existing = db.prepare("SELECT * FROM sickness_alerts WHERE dedupe_lookup = ?").get(dedupeLookup);
  if (existing) {
    const existingPayload = sicknessAlertPayload(existing);
    if (existingPayload.status === "open") {
      return { created: false, reopened: false, id: existing.id, dedupeLookup };
    }
    existingPayload.kind = kind;
    existingPayload.severity = severity;
    existingPayload.audience = audience;
    existingPayload.status = "open";
    existingPayload.triggeredAt = new Date().toISOString();
    existingPayload.resolvedAt = "";
    db.prepare(`
      UPDATE sickness_alerts
      SET status_lookup = ?, protected_payload = ?, purge_after = ?
      WHERE id = ?
    `).run(sicknessStatusLookup("open"), protectJson(existingPayload, sicknessAlertProtectionContext(existing)), caseRow.purge_after, existing.id);
    return { created: true, reopened: true, id: existing.id, dedupeLookup };
  }
  const id = crypto.randomUUID();
  const payload = protectJson({
    kind, severity, audience, status: "open", triggeredAt: new Date().toISOString(), resolvedAt: "",
  }, sicknessAlertProtectionContext({ id, sickness_case_id: Number(caseId) }));
  const result = db.prepare(`
    INSERT OR IGNORE INTO sickness_alerts
      (id, sickness_case_id, status_lookup, protected_payload, purge_after, dedupe_lookup)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, Number(caseId), sicknessStatusLookup("open"), payload, caseRow.purge_after, dedupeLookup);
  return { created: Boolean(result.changes), id: result.changes ? id : null, dedupeLookup };
}

function resolveSicknessAlerts(caseId, kinds = []) {
  const filters = new Set(Array.isArray(kinds) && kinds.length ? kinds : ["staffing_risk", "aum_overdue_local", "aum_overdue_hr"]);
  const rows = db.prepare("SELECT * FROM sickness_alerts WHERE sickness_case_id = ?").all(Number(caseId));
  const resolvedAt = new Date().toISOString();
  const purgeAfter = addDays(viennaTodayIso(), SICKNESS_ALERT_RESOLVED_RETENTION_DAYS);
  const update = db.prepare("UPDATE sickness_alerts SET status_lookup = ?, protected_payload = ?, purge_after = ? WHERE id = ?");
  let changes = 0;
  for (const row of rows) {
    const payload = sicknessAlertPayload(row);
    if (payload.status !== "open" || !filters.has(payload.kind)) continue;
    payload.status = "resolved";
    payload.resolvedAt = payload.resolvedAt || resolvedAt;
    update.run(sicknessStatusLookup("resolved"), protectJson(payload, sicknessAlertProtectionContext(row)), purgeAfter, row.id);
    changes += 1;
  }
  return changes;
}

function markSicknessNotificationsRead(caseId, kinds = []) {
  const notificationKinds = Array.isArray(kinds) ? kinds.filter(Boolean) : [];
  if (!notificationKinds.length) return 0;
  const recipients = db.prepare(`
    SELECT DISTINCT recipient_employee_number FROM portal_notifications
    WHERE entity_type = 'protected_record' AND entity_id = ?
  `).all(protectedPortalEntityId("sickness-case", caseId));
  const markRead = db.prepare(`
    UPDATE portal_notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
    WHERE recipient_employee_number = ? AND dedupe_key = ?
  `);
  let changes = 0;
  for (const recipient of recipients) {
    for (const kind of notificationKinds) {
      changes += Number(markRead.run(
        recipient.recipient_employee_number,
        protectedPortalDedupeKey([caseId, kind, recipient.recipient_employee_number]),
      ).changes || 0);
    }
  }
  return changes;
}

function notifySicknessRecipients(row, { stage = "local", kind }) {
  const casePayload = sicknessCasePayload(row);
  const recipients = sicknessNotificationRecipients(casePayload, stage, casePayload.employeeNumber);
  for (const recipient of recipients) {
    createPortalNotification(recipient, "protected.update", "Neue geschützte Meldung", "Bitte im geschützten Portal anmelden.", {
      target: "/portal.html?tab=leadershipApprovals",
      entityType: "protected_record",
      entityId: protectedPortalEntityId("sickness-case", row.id),
      dedupeKey: protectedPortalDedupeKey([row.id, kind, recipient]),
      reactivate: true,
    });
  }
  return recipients;
}

function sicknessStaffingAlertIsOpen(caseId) {
  return db.prepare("SELECT * FROM sickness_alerts WHERE sickness_case_id = ?").all(Number(caseId))
    .some((row) => {
      const payload = sicknessAlertPayload(row);
      return payload.kind === "staffing_risk" && payload.status === "open";
    });
}

function resolveSicknessStaffingArtifacts(caseId) {
  const resolved = resolveSicknessAlerts(caseId, ["staffing_risk"]);
  const entityId = protectedPortalEntityId("sickness-case", caseId);
  const notifications = db.prepare(`
    SELECT DISTINCT recipient_employee_number FROM portal_notifications
    WHERE entity_type = 'protected_record' AND entity_id = ?
  `).all(entityId);
  const markRead = db.prepare(`
    UPDATE portal_notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
    WHERE dedupe_key = ?
  `);
  for (const notification of notifications) {
    markRead.run(protectedPortalDedupeKey([caseId, "staffing", notification.recipient_employee_number]));
  }
  const cancelled = db.prepare(`
    UPDATE outbound_notification_jobs
    SET status = 'cancelled', purge_after = ?, updated_at = CURRENT_TIMESTAMP
    WHERE entity_lookup = ? AND status = 'pending'
  `).run(addDays(viennaTodayIso(), OUTBOUND_NOTIFICATION_CANCELLED_RETENTION_DAYS), sicknessOutboundEntityLookup(caseId)).changes;
  return { resolved, cancelled };
}

function reactivateSicknessStaffingNotifications(caseId, recipients) {
  const update = db.prepare("UPDATE portal_notifications SET read_at = NULL WHERE dedupe_key = ?");
  for (const recipient of recipients) {
    update.run(protectedPortalDedupeKey([caseId, "staffing", recipient]));
  }
}

function reconcileSicknessStaffingRisk(row, now = new Date()) {
  const payload = sicknessCasePayload(row);
  const futureRecovered = payload.status === "recovered" && isIsoDate(payload.returnToWorkDate)
    && payload.returnToWorkDate > viennaTodayIso(now);
  if (payload.status === "recovered" && isIsoDate(payload.returnToWorkDate) && !futureRecovered) {
      const effects = resolveSicknessStaffingArtifacts(row.id);
      return { checked: true, created: false, resolved: Boolean(effects.resolved), risk: payload.staffingRisk || null };
  }
  if ((!futureRecovered && !["reported", "aum_received"].includes(payload.status)) || !payload.startDate) {
    return { checked: false, created: false, resolved: false, risk: payload.staffingRisk || null };
  }
  const previousRisk = payload.staffingRisk || { atRisk: false, contexts: [] };
  const nextRisk = evaluateSicknessStaffingRisk(
    payload.employeeNumber,
    payload.startDate,
    futureRecovered ? addDays(payload.returnToWorkDate, -1) : payload.expectedEnd,
    { locationId: payload.locationId, departmentId: payload.departmentId },
    { asOfDate: viennaTodayIso(now) },
  );
  const previousContexts = sicknessNotificationContexts({
    locationId: payload.locationId,
    departmentId: payload.departmentId,
    staffingRisk: previousRisk,
  });
  const contextChanged = JSON.stringify(previousContexts) !== JSON.stringify(nextRisk.contexts || []);
  const primaryContext = nextRisk.contexts?.[0] || null;
  if (primaryContext) {
    payload.locationId = primaryContext.locationId;
    payload.departmentId = primaryContext.departmentId;
  }
  const payloadChanged = JSON.stringify(previousRisk) !== JSON.stringify(nextRisk) || contextChanged;
  payload.staffingRisk = nextRisk;
  if (payloadChanged) {
    row.protected_payload = protectJson(payload, sicknessCaseProtectionContext(row));
    db.prepare("UPDATE sickness_cases SET protected_payload = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(row.protected_payload, row.id);
  }
  if (!nextRisk.atRisk) {
    const effects = resolveSicknessStaffingArtifacts(row.id);
    return { checked: true, created: false, resolved: Boolean(effects.resolved), risk: nextRisk };
  }
  const alert = upsertSicknessAlert(row.id, "staffing_risk", "warning", "local");
  if (alert.created || contextChanged) {
    if (contextChanged) resolveSicknessStaffingArtifacts(row.id);
    const refreshedAlert = upsertSicknessAlert(row.id, "staffing_risk", "warning", "local");
    const recipients = notifySicknessRecipients(row, {
      stage: "local",
      kind: "staffing",
    });
    reactivateSicknessStaffingNotifications(row.id, recipients);
    queueExternalStaffingAlerts(row, recipients, now.toISOString());
    return { checked: true, created: Boolean(alert.created || refreshedAlert.created), resolved: false, risk: nextRisk };
  }
  return { checked: true, created: false, resolved: false, risk: nextRisk };
}

function runSicknessEscalationSweep(now = new Date()) {
  if (!amuStorage || !tableExists("sickness_cases")) return { checked: 0, alerts: 0 };
  const policy = getAmuPolicy();
  const rows = db.prepare(`
    SELECT * FROM sickness_cases WHERE status_lookup IN (?, ?, ?) ORDER BY created_at, id
  `).all(sicknessStatusLookup("reported"), sicknessStatusLookup("aum_received"), sicknessStatusLookup("recovered"));
  let alerts = 0;
  for (const row of rows) {
    const staffing = reconcileSicknessStaffingRisk(row, now);
    if (staffing.created) alerts += 1;
    const payload = sicknessCasePayload(row);
    const stillRequiresAum = payload.status === "reported"
      || (payload.status === "recovered" && !payload.aumReceivedAt);
    if (!stillRequiresAum) continue;
    if (!payload.startDate) continue;
    const state = sicknessDeadlineState({
      startAt: payload.startDate,
      asOf: now,
      localDays: policy.localWarningDays,
      hrDays: policy.hrWarningDays,
    });
    if (state.severity === "yellow" || state.severity === "red") {
      const localAlert = upsertSicknessAlert(row.id, "aum_overdue_local", "yellow", "local");
      if (localAlert.created) {
        alerts += 1;
        notifySicknessRecipients(row, {
          stage: "local",
          kind: "aum_overdue_local",
        });
      }
    }
    if (state.severity === "red") {
      const hrAlert = upsertSicknessAlert(row.id, "aum_overdue_hr", "red", "hr");
      if (hrAlert.created) {
        alerts += 1;
        notifySicknessRecipients(row, {
          stage: "hr",
          kind: "aum_overdue_hr",
        });
      }
    }
  }
  return { checked: rows.length, alerts };
}

function refreshSicknessStaffingAfterPlanningChange(now = new Date()) {
  try {
    return runSicknessEscalationSweep(now);
  } catch (error) {
    console.error("Krankmeldungs-Besetzungsprüfung nach Dienstplanänderung fehlgeschlagen:", error);
    return { checked: 0, alerts: 0, error: true };
  }
}

const SICKNESS_NOTIFICATION_CHANNELS = Object.freeze(["email", "sms", "whatsapp"]);

function externalNotificationProviderStatus() {
  return externalNotificationAdapter.getProviderStatus();
}

function normalizedNotificationDestination(channel, value) {
  const raw = stripEmoji(String(value || "").trim());
  if (!raw) return "";
  if (channel === "email") {
    if (raw.length > 320 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) {
      throw httpError(400, "Bitte eine gültige E-Mail-Adresse eingeben.", "SICKNESS_NOTIFICATION_DESTINATION_INVALID");
    }
    return raw;
  }
  const phone = raw.replace(/[\s()./-]/g, "");
  if (!/^\+[1-9]\d{6,15}$/.test(phone)) {
    throw httpError(400, "Bitte die Telefonnummer mit internationaler Vorwahl eingeben, zum Beispiel +436601234567.", "SICKNESS_NOTIFICATION_DESTINATION_INVALID");
  }
  return phone;
}

function sicknessNotificationPreferences(employeeNumber) {
  const rows = db.prepare(`
    SELECT employee_number, channel, enabled, earliest_time, protected_destination, verified_at,
           verification_expires_at, verification_attempts, updated_at
    FROM sickness_notification_preferences WHERE employee_number = ?
  `).all(employeeNumber);
  const byChannel = new Map(rows.map((row) => [row.channel, row]));
  const channels = {};
  for (const channel of SICKNESS_NOTIFICATION_CHANNELS) {
    const row = byChannel.get(channel);
    let destination = "";
    if (row?.protected_destination) {
      destination = parseProtectedJson(row.protected_destination, sicknessPreferenceProtectionContext(row)).destination || "";
    }
    channels[channel] = {
      enabled: Boolean(row?.enabled),
      destination,
      earliestTime: isTime(row?.earliest_time) ? row.earliest_time : "08:00",
      verifiedAt: row?.verified_at || null,
      verificationRequired: Boolean(row?.protected_destination && !row?.verified_at),
      verificationExpiresAt: row?.verification_expires_at || null,
    };
  }
  return { channels, providers: externalNotificationProviderStatus(), messagePreview: STAFFING_ALERT_TEXT };
}

function saveSicknessNotificationPreferences(employeeNumber, body = {}) {
  const earliestTime = String(body.earliestTime || "08:00");
  if (!isTime(earliestTime)) throw httpError(400, "Bitte eine gültige früheste Warnzeit eingeben.", "SICKNESS_NOTIFICATION_TIME_INVALID");
  const submitted = body.channels && typeof body.channels === "object" ? body.channels : {};
  const existingRows = db.prepare("SELECT * FROM sickness_notification_preferences WHERE employee_number = ?").all(employeeNumber);
  const existingByChannel = new Map(existingRows.map((row) => [row.channel, row]));
  const values = SICKNESS_NOTIFICATION_CHANNELS.map((channel) => {
    const input = submitted[channel] || {};
    const enabled = input.enabled === true;
    const destination = normalizedNotificationDestination(channel, input.destination);
    if (enabled && !destination) {
      throw httpError(400, "Für jeden aktivierten Warnkanal muss ein Empfänger hinterlegt sein.", "SICKNESS_NOTIFICATION_DESTINATION_REQUIRED");
    }
    const existing = existingByChannel.get(channel);
    const previousDestination = existing?.protected_destination
      ? (parseProtectedJson(existing.protected_destination, sicknessPreferenceProtectionContext(existing)).destination || "")
      : "";
    const unchanged = destination && destination === previousDestination;
    const verifiedAt = unchanged ? (existing?.verified_at || null) : null;
    if (enabled && !verifiedAt) {
      throw httpError(409, "Bitte dieses Ziel zuerst mit dem sechsstelligen Einmalcode bestätigen.", "SICKNESS_NOTIFICATION_VERIFICATION_REQUIRED");
    }
    return {
      channel, enabled, destination, verifiedAt,
      verificationHash: unchanged ? (existing?.verification_hash || "") : "",
      verificationSalt: unchanged ? (existing?.verification_salt || "") : "",
      verificationExpiresAt: unchanged ? (existing?.verification_expires_at || null) : null,
      verificationAttempts: unchanged ? Number(existing?.verification_attempts || 0) : 0,
      verificationSentAt: unchanged ? (existing?.verification_sent_at || null) : null,
    };
  });
  const upsert = db.prepare(`
    INSERT INTO sickness_notification_preferences
      (employee_number, channel, enabled, earliest_time, protected_destination, verified_at,
       verification_hash, verification_salt, verification_expires_at, verification_attempts,
       verification_sent_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number, channel) DO UPDATE SET
      enabled = excluded.enabled, earliest_time = excluded.earliest_time,
      protected_destination = excluded.protected_destination, verified_at = excluded.verified_at,
      verification_hash = excluded.verification_hash, verification_salt = excluded.verification_salt,
      verification_expires_at = excluded.verification_expires_at,
      verification_attempts = excluded.verification_attempts,
      verification_sent_at = excluded.verification_sent_at,
      updated_at = CURRENT_TIMESTAMP
  `);
  db.exec("BEGIN");
  try {
    for (const value of values) {
      const context = sicknessPreferenceProtectionContext({ employee_number: employeeNumber, channel: value.channel });
      const protectedDestination = value.destination ? protectJson({ destination: value.destination }, context) : "";
      upsert.run(employeeNumber, value.channel, value.enabled ? 1 : 0, earliestTime, protectedDestination,
        value.verifiedAt, value.verificationHash, value.verificationSalt, value.verificationExpiresAt,
        value.verificationAttempts, value.verificationSentAt);
    }
    auditPortal(employeeNumber, "sickness.notification-preferences.update", "portal_user", employeeNumber,
      JSON.stringify({ channels: values.filter((value) => value.enabled).map((value) => value.channel), earliestTime }));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return sicknessNotificationPreferences(employeeNumber);
}

function notificationVerificationHash(code, salt) {
  return crypto.scryptSync(String(code), String(salt), 32).toString("hex");
}

async function requestSicknessNotificationVerification(employeeNumber, body = {}) {
  const channel = String(body.channel || "").trim().toLowerCase();
  if (!SICKNESS_NOTIFICATION_CHANNELS.includes(channel)) {
    throw httpError(400, "Der Warnkanal ist ungültig.", "SICKNESS_NOTIFICATION_CHANNEL_INVALID");
  }
  const provider = externalNotificationProviderStatus()[channel];
  if (!provider?.available) throw httpError(503, "Dieser Warnkanal ist durch die Firmen-IT noch nicht eingerichtet.", "SICKNESS_NOTIFICATION_PROVIDER_UNAVAILABLE");
  const destination = normalizedNotificationDestination(channel, body.destination);
  if (!destination) throw httpError(400, "Bitte ein Ziel für den Warnkanal eingeben.", "SICKNESS_NOTIFICATION_DESTINATION_REQUIRED");
  const earliestTime = String(body.earliestTime || "08:00");
  if (!isTime(earliestTime)) throw httpError(400, "Bitte eine gültige früheste Warnzeit eingeben.", "SICKNESS_NOTIFICATION_TIME_INVALID");
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = notificationVerificationHash(code, salt);
  const expiresAt = new Date(Date.now() + NOTIFICATION_VERIFICATION_TTL_MINUTES * 60 * 1000).toISOString();
  const context = sicknessPreferenceProtectionContext({ employee_number: employeeNumber, channel });
  const protectedDestination = protectJson({ destination }, context);
  db.prepare(`
    INSERT INTO sickness_notification_preferences
      (employee_number, channel, enabled, earliest_time, protected_destination, verified_at,
       verification_hash, verification_salt, verification_expires_at, verification_attempts,
       verification_sent_at, updated_at)
    VALUES (?, ?, 0, ?, ?, NULL, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number, channel) DO UPDATE SET
      enabled = 0, earliest_time = excluded.earliest_time,
      protected_destination = excluded.protected_destination, verified_at = NULL,
      verification_hash = excluded.verification_hash, verification_salt = excluded.verification_salt,
      verification_expires_at = excluded.verification_expires_at, verification_attempts = 0,
      verification_sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, channel, earliestTime, protectedDestination, hash, salt, expiresAt);
  try {
    await externalNotificationAdapter.sendVerificationCode({ channel, recipient: destination, code });
  } catch (error) {
    db.prepare(`
      UPDATE sickness_notification_preferences
      SET verification_hash = '', verification_salt = '', verification_expires_at = NULL,
          verification_attempts = 0, updated_at = CURRENT_TIMESTAMP
      WHERE employee_number = ? AND channel = ?
    `).run(employeeNumber, channel);
    throw httpError(502, "Der Bestätigungscode konnte nicht zugestellt werden.", error.code || "SICKNESS_NOTIFICATION_VERIFICATION_DELIVERY_FAILED");
  }
  auditPortal(employeeNumber, "sickness.notification-destination.verification.request", "portal_user", employeeNumber,
    JSON.stringify({ channel }));
  return { ...sicknessNotificationPreferences(employeeNumber), verification: { channel, required: true, expiresAt } };
}

function confirmSicknessNotificationVerification(employeeNumber, body = {}) {
  const channel = String(body.channel || "").trim().toLowerCase();
  const code = String(body.code || "").trim();
  if (!SICKNESS_NOTIFICATION_CHANNELS.includes(channel) || !/^\d{6}$/.test(code)) {
    throw httpError(400, "Der Bestätigungscode ist ungültig.", "SICKNESS_NOTIFICATION_VERIFICATION_INVALID");
  }
  const row = db.prepare("SELECT * FROM sickness_notification_preferences WHERE employee_number = ? AND channel = ?")
    .get(employeeNumber, channel);
  const expired = !row?.verification_expires_at || new Date(row.verification_expires_at).getTime() <= Date.now();
  if (!row?.verification_hash || !row?.verification_salt || expired
      || Number(row.verification_attempts || 0) >= NOTIFICATION_VERIFICATION_MAX_ATTEMPTS) {
    throw httpError(410, "Der Bestätigungscode ist abgelaufen. Bitte einen neuen Code anfordern.", "SICKNESS_NOTIFICATION_VERIFICATION_EXPIRED");
  }
  const actual = Buffer.from(notificationVerificationHash(code, row.verification_salt), "hex");
  const expected = Buffer.from(row.verification_hash, "hex");
  const valid = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  if (!valid) {
    const attempts = Number(row.verification_attempts || 0) + 1;
    db.prepare("UPDATE sickness_notification_preferences SET verification_attempts = ?, updated_at = CURRENT_TIMESTAMP WHERE employee_number = ? AND channel = ?")
      .run(attempts, employeeNumber, channel);
    if (attempts >= NOTIFICATION_VERIFICATION_MAX_ATTEMPTS) {
      throw httpError(410, "Zu viele Fehlversuche. Bitte einen neuen Code anfordern.", "SICKNESS_NOTIFICATION_VERIFICATION_EXPIRED");
    }
    throw httpError(400, "Der Bestätigungscode ist nicht korrekt.", "SICKNESS_NOTIFICATION_VERIFICATION_INVALID");
  }
  db.prepare(`
    UPDATE sickness_notification_preferences
    SET enabled = 1, verified_at = CURRENT_TIMESTAMP, verification_hash = '', verification_salt = '',
        verification_expires_at = NULL, verification_attempts = 0, updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = ? AND channel = ?
  `).run(employeeNumber, channel);
  auditPortal(employeeNumber, "sickness.notification-destination.verification.confirm", "portal_user", employeeNumber,
    JSON.stringify({ channel }));
  return sicknessNotificationPreferences(employeeNumber);
}

function queueExternalStaffingAlerts(caseRow, recipients, reportedAt = new Date().toISOString()) {
  const providerStatus = externalNotificationProviderStatus();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO outbound_notification_jobs
      (id, recipient_lookup, channel, entity_lookup, protected_payload, not_before, purge_after, dedupe_lookup)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let queued = 0;
  for (const recipient of recipients) {
    const preferences = db.prepare(`
      SELECT employee_number, channel, enabled, earliest_time, protected_destination
      FROM sickness_notification_preferences WHERE employee_number = ? AND enabled = 1 AND verified_at IS NOT NULL
    `).all(recipient);
    for (const preference of preferences) {
      if (!SICKNESS_NOTIFICATION_CHANNELS.includes(preference.channel) || !providerStatus[preference.channel]?.available || !preference.protected_destination) continue;
      const destination = parseProtectedJson(preference.protected_destination, sicknessPreferenceProtectionContext(preference)).destination || "";
      if (!destination) continue;
      const id = crypto.randomUUID();
      const notBefore = externalAlertNotBefore({ reportAt: reportedAt, sendAfter: preference.earliest_time || "08:00" }).notBefore;
      const recipientLookup = sicknessLookup("notification-recipient", recipient);
      const protectedPayload = protectJson({
        destination,
        recipientEmployeeNumber: recipient,
        sicknessCaseId: Number(caseRow.id),
      }, outboundNotificationProtectionContext({ id, recipient_lookup: recipientLookup }));
      const dedupeLookup = sicknessOutboundDedupeLookup(caseRow.id, recipient, preference.channel);
      const result = insert.run(id, recipientLookup, preference.channel, sicknessOutboundEntityLookup(caseRow.id),
        protectedPayload, notBefore, addDays(notBefore.slice(0, 10), OUTBOUND_NOTIFICATION_RETENTION_DAYS), dedupeLookup);
      if (result.changes) {
        queued += 1;
        continue;
      }
      const existing = db.prepare("SELECT id, recipient_lookup, status FROM outbound_notification_jobs WHERE dedupe_lookup = ?").get(dedupeLookup);
      if (!existing || ["pending", "processing"].includes(existing.status)) continue;
      const rearmedPayload = protectJson({
        destination,
        recipientEmployeeNumber: recipient,
        sicknessCaseId: Number(caseRow.id),
      }, outboundNotificationProtectionContext(existing));
      const rearmed = db.prepare(`
        UPDATE outbound_notification_jobs
        SET recipient_lookup = ?, channel = ?, entity_lookup = ?, protected_payload = ?, not_before = ?,
            status = 'pending', attempts = 0, last_error_code = '', sent_at = NULL,
            purge_after = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status NOT IN ('pending','processing')
      `).run(recipientLookup, preference.channel, sicknessOutboundEntityLookup(caseRow.id), rearmedPayload, notBefore,
        addDays(notBefore.slice(0, 10), OUTBOUND_NOTIFICATION_RETENTION_DAYS), existing.id);
      if (rearmed.changes) queued += 1;
    }
  }
  if (queued) auditPortal("system", "protected.external-alerts.queued", "protected_record",
    protectedPortalEntityId("sickness-case", caseRow.id), JSON.stringify({ queued }));
  return queued;
}

async function processOutboundNotificationJobs(now = new Date()) {
  const due = db.prepare(`
    SELECT * FROM outbound_notification_jobs
    WHERE status = 'pending' AND not_before <= ? ORDER BY not_before, created_at LIMIT 20
  `).all(now.toISOString());
  let sent = 0;
  let failed = 0;
  for (const job of due) {
    const claimed = db.prepare(`
      UPDATE outbound_notification_jobs SET status = 'processing', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending'
    `).run(job.id);
    if (!claimed.changes) continue;
    try {
      const payload = parseProtectedJson(job.protected_payload, outboundNotificationProtectionContext(job));
      if (payload.sicknessCaseId && !sicknessStaffingAlertIsOpen(payload.sicknessCaseId)) {
        db.prepare(`
          UPDATE outbound_notification_jobs
          SET status = 'cancelled', purge_after = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(addDays(viennaTodayIso(), OUTBOUND_NOTIFICATION_CANCELLED_RETENTION_DAYS), job.id);
        continue;
      }
      await externalNotificationAdapter.sendStaffingAlert({ channel: job.channel, recipient: payload.destination });
      db.prepare(`
        UPDATE outbound_notification_jobs SET status = 'sent', attempts = attempts + 1,
          last_error_code = '', sent_at = CURRENT_TIMESTAMP, purge_after = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(addDays(viennaTodayIso(), OUTBOUND_NOTIFICATION_RETENTION_DAYS), job.id);
      auditPortal("system", "protected.external-alert.sent", "outbound_notification_job", job.id, JSON.stringify({ channel: job.channel }));
      sent += 1;
    } catch (error) {
      const attempts = Number(job.attempts || 0) + 1;
      const retryMinutes = [5, 15, 60, 180][Math.min(attempts - 1, 3)];
      const nextStatus = attempts >= 5 ? "failed" : "pending";
      const nextAttempt = new Date(now.getTime() + retryMinutes * 60 * 1000).toISOString();
      db.prepare(`
        UPDATE outbound_notification_jobs SET status = ?, attempts = ?, last_error_code = ?,
          not_before = ?, purge_after = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(nextStatus, attempts, String(error.code || "EXTERNAL_NOTIFICATION_DELIVERY_FAILED").slice(0, 120), nextAttempt,
        addDays(viennaTodayIso(), OUTBOUND_NOTIFICATION_RETENTION_DAYS), job.id);
      auditPortal("system", "protected.external-alert.failed", "outbound_notification_job", job.id,
        JSON.stringify({ channel: job.channel, code: String(error.code || "delivery_failed"), final: nextStatus === "failed" }));
      failed += 1;
    }
  }
  return { checked: due.length, sent, failed };
}

function purgeExpiredSicknessData(today = viennaTodayIso()) {
  if (!tableExists("sickness_cases")) return { cases: 0, alerts: 0, jobs: 0 };
  const alerts = db.prepare("DELETE FROM sickness_alerts WHERE purge_after < ? AND status_lookup <> ?")
    .run(today, sicknessStatusLookup("open")).changes;
  const jobs = db.prepare("DELETE FROM outbound_notification_jobs WHERE purge_after < ? AND status <> 'processing'").run(today).changes;
  const activeStatuses = [sicknessStatusLookup("reported"), sicknessStatusLookup("aum_received")];
  const expiredCases = db.prepare(`
    SELECT id FROM sickness_cases WHERE purge_after < ? AND status_lookup NOT IN (?, ?)
  `).all(today, ...activeStatuses);
  let cases = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of expiredCases) {
      db.prepare(`
        DELETE FROM portal_notifications WHERE entity_type = 'protected_record' AND entity_id = ?
      `).run(protectedPortalEntityId("sickness-case", row.id));
      cases += db.prepare(`
        DELETE FROM sickness_cases WHERE id = ? AND purge_after < ? AND status_lookup NOT IN (?, ?)
      `).run(row.id, today, ...activeStatuses).changes;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (cases || alerts || jobs) {
    auditPortal("system", "sickness.retention.purge", "protected_record", "", JSON.stringify({ cases, alerts, jobs }));
  }
  return { cases, alerts, jobs };
}

function validateAmuPolicy(body = {}) {
  const uploadMaxMb = Number(body.uploadMaxMb);
  const storedMaxMb = Number(body.storedMaxMb);
  if (!Number.isFinite(uploadMaxMb) || uploadMaxMb < 1 || uploadMaxMb > 25) {
    throw httpError(400, "Der maximale AUM-Upload muss zwischen 1 und 25 MB liegen.", "AMU_POLICY_INVALID");
  }
  if (!Number.isFinite(storedMaxMb) || storedMaxMb < 0.5 || storedMaxMb > uploadMaxMb) {
    throw httpError(400, "Die gespeicherte AUM-Größe muss zwischen 0,5 MB und dem Upload-Limit liegen.", "AMU_POLICY_INVALID");
  }
  const currentPolicy = getAmuPolicy();
  let deadlines;
  try {
    deadlines = validateSicknessDeadlines({
      localDays: Number(body.localWarningDays ?? currentPolicy.localWarningDays),
      hrDays: Number(body.hrWarningDays ?? currentPolicy.hrWarningDays),
    });
  } catch (error) {
    throw httpError(400, error.message, error.code || "SICKNESS_DEADLINE_INVALID");
  }
  return {
    uploadMaxMb: Math.round(uploadMaxMb * 2) / 2,
    storedMaxMb: Math.round(storedMaxMb * 2) / 2,
    convertImagesToPdf: body.convertImagesToPdf !== false,
    grayscaleImages: body.grayscaleImages !== false,
    ocrEnabled: body.ocrEnabled !== false,
    localWarningDays: deadlines.localDays,
    hrWarningDays: deadlines.hrDays,
  };
}

function actorCanReadAmuFiles(session) {
  if (!session) return false;
  if (session.employeeNumber === "local") return true;
  return protectedAmuRoleIds.has(session.role) && session.permissions?.includes("amu:file:read");
}

function actorCanReadAmuSensitiveMetadata(session) {
  if (!session) return false;
  if (session.employeeNumber === "local") return true;
  return protectedAmuRoleIds.has(session.role) && session.permissions?.includes("amu:metadata:read");
}

function parsePortalPermissions(value) {
  try {
    const permissions = JSON.parse(value || "[]");
    return Array.isArray(permissions) ? permissions.filter((permission) => typeof permission === "string") : [];
  } catch {
    return [];
  }
}

function portalPermissionGrantsForEmployee(employeeNumber) {
  if (!employeeNumber || !tableExists("portal_permission_grants")) return [];
  const role = db.prepare("SELECT role FROM portal_users WHERE employee_number = ?").get(String(employeeNumber))?.role || "employee";
  return db.prepare(`
    SELECT permission FROM portal_permission_grants
    WHERE employee_number = ? ORDER BY permission
  `).all(String(employeeNumber)).map((row) => row.permission)
    .filter((permission) => delegablePortalPermissions.has(permission) && portalPermissionAllowedForRole(permission, role));
}

function manageablePortalPermissionsForActor(actor) {
  if (!actor) return new Set();
  if (actor.employeeNumber === "local" || ["developer", "admin", "it_admin"].includes(actor.role)) {
    return new Set(delegablePortalPermissions);
  }
  if (actor.role === "hr") return new Set(hrDelegablePortalPermissions);
  return new Set();
}

function portalPermissionCatalogForActor(actor) {
  const manageable = manageablePortalPermissionsForActor(actor);
  return delegablePortalPermissionCatalog.map(({ hrDelegable: _hrDelegable, ...permission }) => ({
    ...permission,
    editable: manageable.has(permission.id),
  }));
}

function actorCanManagePermissionGrants(actor, target) {
  if (!actor || !target || target.role === "developer" || target.roleLocked || !target.configured || !target.active) return false;
  if (actor.employeeNumber === "local" || ["developer", "it_admin"].includes(actor.role)) return true;
  if (actor.role === "admin") return target.role !== "it_admin";
  return actor.role === "hr" && ["employee", "department_manager", "manager"].includes(target.role);
}

function getPortalRoles() {
  const builtinDefinitions = new Map(builtinPortalRoles.map((role) => [role.id, role]));
  return db.prepare(`
    SELECT id, name, description, builtin, permissions, sort_order
    FROM portal_roles
    ORDER BY sort_order, name, id
  `).all().map((role) => {
    const definition = builtinDefinitions.get(role.id);
    const protectedRole = PROTECTED_PORTAL_ROLES.has(role.id);
    return {
      id: role.id,
      name: role.name,
      description: role.description || "",
      builtin: Boolean(role.builtin),
      permissions: parsePortalPermissions(role.permissions)
        .filter((permission) => portalPermissionAllowedForRole(permission, role.id)),
      sortOrder: Number(role.sort_order || 0),
      protected: protectedRole,
      assignable: !protectedRole,
      technical: ["developer", "it_admin"].includes(role.id),
      knownBuiltin: Boolean(definition),
    };
  });
}

function actorCanAssignPortalRole(actor, role) {
  if (!actor || role === "developer" || PROTECTED_PORTAL_ROLES.has(role)) return false;
  if (actor.employeeNumber === "local") return role !== "developer";
  const allowed = PORTAL_ROLE_ASSIGNMENTS[actor.role];
  if (allowed?.has(role)) return true;
  return actor.role === "developer"
    ? Boolean(db.prepare("SELECT 1 FROM portal_roles WHERE id = ? AND id <> 'developer'").get(role))
    : false;
}

function actorCanManagePortalRole(actor, targetRole) {
  if (!actor || targetRole === "developer") return false;
  if (actor.employeeNumber === "local" || actor.role === "developer") return true;
  if (actor.role === "admin") return targetRole !== "it_admin";
  if (actor.role === "it_admin") return ["employee", "department_manager", "manager", "hr"].includes(targetRole);
  if (actor.role === "hr") return ["employee", "department_manager", "manager"].includes(targetRole);
  return actor.role === "manager" && targetRole === "department_manager";
}

function assertPortalUserIsMutable(target, actor) {
  if (!target) throw httpError(404, "Der Zugang wurde nicht gefunden.");
  if (target.role === "developer" || target.role_locked) {
    auditPortal(actor?.employeeNumber || "system", "portal.developer.protected", "portal_user", target.employee_number || "", "mutation-denied");
    throw httpError(403, "Der Developer-Zugang ist geschützt und kann nur mit dem lokalen Entwicklerwerkzeug geändert werden.", "PORTAL_DEVELOPER_PROTECTED");
  }
}

function actorCanEditPersonnelAccessProfile(actor) {
  return Boolean(actor && ["developer", "it_admin"].includes(actor.role));
}

function portalAccessProfileForEmployee(employeeNumber) {
  const user = db.prepare(`
    SELECT u.employee_number, u.role, u.role_locked, u.active, r.name AS role_name, r.permissions
    FROM portal_users u
    LEFT JOIN portal_roles r ON r.id = u.role
    WHERE u.employee_number = ?
  `).get(String(employeeNumber || ""));
  const roleId = user?.role || "employee";
  const role = getPortalRoles().find((entry) => entry.id === roleId)
    || getPortalRoles().find((entry) => entry.id === "employee");
  const rolePermissions = role?.permissions || parsePortalPermissions(user?.permissions);
  const grantedPermissions = user ? portalPermissionGrantsForEmployee(employeeNumber) : [];
  return {
    configured: Boolean(user),
    role: roleId,
    roleName: user?.role_name || role?.name || "Mitarbeiter",
    roleLocked: Boolean(user?.role_locked) || roleId === "developer",
    active: user ? Boolean(user.active) : false,
    rolePermissions,
    grantedPermissions,
    effectivePermissions: [...new Set([...rolePermissions, ...grantedPermissions])],
  };
}

function validatePersonnelAccessProfile(actor, payload, employee = {}) {
  if (payload === undefined) return null;
  if (!actorCanEditPersonnelAccessProfile(actor)) {
    throw httpError(403, "App-Rolle und individuelle Rechte dürfen hier nur Developer oder IT-Admin ändern.", "PERSONNEL_ACCESS_PROFILE_DENIED");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw httpError(400, "Bitte ein gültiges Rechteprofil übermitteln.", "PERSONNEL_ACCESS_PROFILE_INVALID");
  }
  const employeeNumber = String(employee.personnelNumber || employee.personnel_number || "").trim();
  const existing = db.prepare("SELECT employee_number, role, role_locked, active FROM portal_users WHERE employee_number = ?").get(employeeNumber);
  if (existing) {
    assertPortalUserIsMutable(existing, actor);
    if (!actorCanManagePortalRole(actor, existing.role)) {
      throw httpError(403, "Dieser Zugang liegt außerhalb der eigenen Verwaltungsebene.", "PORTAL_ROLE_HIERARCHY_DENIED");
    }
  }
  const role = String(payload.role || existing?.role || "employee").trim();
  if (!db.prepare("SELECT 1 FROM portal_roles WHERE id = ?").get(role)) {
    throw httpError(400, "Die ausgewählte App-Rolle ist ungültig.", "PORTAL_ROLE_INVALID");
  }
  if (!actorCanAssignPortalRole(actor, role)) {
    throw httpError(403, role === "developer"
      ? "Die Developer-Rolle kann ausschließlich mit dem lokalen Entwicklerwerkzeug gebunden werden."
      : "Diese App-Rolle darf durch den aktuellen Zugang nicht vergeben werden.", role === "developer" ? "PORTAL_DEVELOPER_PROTECTED" : "PORTAL_ROLE_HIERARCHY_DENIED");
  }
  if (!Array.isArray(payload.permissions)) {
    throw httpError(400, "Bitte eine gültige Auswahl individueller Zusatzrechte übermitteln.", "PERSONNEL_ACCESS_PROFILE_INVALID");
  }
  const submittedPermissions = [...new Set(payload.permissions
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
  const invalidPermissions = submittedPermissions.filter((permission) => !delegablePortalPermissions.has(permission));
  if (invalidPermissions.length) {
    throw httpError(403, `Diese Rechte dürfen nicht vergeben werden: ${invalidPermissions.join(", ")}`, "PORTAL_PERMISSION_NOT_DELEGABLE");
  }
  const roleRestrictedPermissions = submittedPermissions.filter((permission) => !portalPermissionAllowedForRole(permission, role));
  if (roleRestrictedPermissions.length) {
    throw httpError(403, "Geschützte AUM-Rechte dürfen nur Personalleitung und höheren Rollen zugewiesen werden.", "AMU_PERMISSION_ROLE_RESTRICTED");
  }
  const rolePermissions = new Set(getPortalRoles().find((entry) => entry.id === role)?.permissions || []);
  const permissions = submittedPermissions.filter((permission) => !rolePermissions.has(permission));
  const homeLocationId = String(employee.homeLocationId || employee.home_location_id || "").trim();
  const preferredDepartmentId = Number(employee.preferredDepartmentId || employee.preferred_department_id || 0) || null;
  if (role === "department_manager" && !preferredDepartmentId) {
    throw httpError(400, "Für eine Abteilungsleitung muss zuerst eine bevorzugte Abteilung hinterlegt werden.", "PORTAL_SCOPE_REQUIRED");
  }
  return { employeeNumber, role, permissions, homeLocationId, preferredDepartmentId, previous: existing || null };
}

function applyPersonnelAccessProfile(actor, profile) {
  if (!profile) return;
  const before = profile.previous ? portalAccessProfileForEmployee(profile.employeeNumber) : null;
  if (profile.previous?.role === "admin" && profile.role !== "admin") {
    const otherSystemOwners = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM portal_users
      WHERE role IN ('developer','admin') AND active = 1 AND employee_number <> ?
    `).get(profile.employeeNumber).count);
    if (!otherSystemOwners) throw httpError(409, "Mindestens ein aktiver Developer- oder Admin-Zugang muss bestehen bleiben.");
  }
  db.prepare(`
    INSERT INTO portal_users (employee_number, password_hash, role, active, must_change_password, updated_at)
    VALUES (?, '', ?, 1, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET role = excluded.role, updated_at = CURRENT_TIMESTAMP
  `).run(profile.employeeNumber, profile.role);
  db.prepare("DELETE FROM portal_permission_grants WHERE employee_number = ?").run(profile.employeeNumber);
  const insertGrant = db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `);
  for (const permission of profile.permissions) insertGrant.run(profile.employeeNumber, permission, actor.employeeNumber);
  db.prepare("DELETE FROM portal_access_scopes WHERE employee_number = ?").run(profile.employeeNumber);
  if (["manager", "department_manager"].includes(profile.role)) {
    db.prepare(`
      INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
      VALUES (?, ?, ?, ?)
    `).run(profile.employeeNumber, profile.homeLocationId, profile.role === "department_manager" ? profile.preferredDepartmentId : 0, actor.employeeNumber);
  }
  const after = portalAccessProfileForEmployee(profile.employeeNumber);
  auditPortal(actor.employeeNumber, "employee.access-profile.update", "portal_user", profile.employeeNumber, JSON.stringify({
    roleBefore: before?.role || null,
    roleAfter: after.role,
    grantsBefore: before?.grantedPermissions || [],
    grantsAfter: after.grantedPermissions,
  }));
  revokeMobileSessionsForEmployee(profile.employeeNumber, "access_profile_changed");
}

function getPortalStatus(locationId = "", request = null) {
  const settings = getSettings();
  const portalSettings = getPortalSettings();
  const features = installationFeatures(settings);
  const networkRuntimeActive = serverModeActive || !loopbackHosts.has(HOST.toLowerCase()) || process.env.GRABENPLANER_FORCE_PORTAL === "1";
  const portalEnabled = networkRuntimeActive && SERVER_MODE_STATUS === "active";
  const configuredAdmin = db.prepare(`
    SELECT 1
    FROM portal_users
    WHERE active = 1 AND role IN ('developer','admin') AND TRIM(password_hash) <> ''
    LIMIT 1
  `).get();
  return {
    apiVersion: PORTAL_API_VERSION,
    operationMode: settings.operation_mode,
    serverModeStatus: SERVER_MODE_STATUS,
    portalEnabled,
    serverModeAvailable: SERVER_MODE_STATUS === "active",
    loginRequired: portalEnabled,
    adminSetupState: configuredAdmin ? "configured" : "not-configured",
    adminSetupAvailable: !configuredAdmin,
    localOnly: loopbackHosts.has(HOST.toLowerCase()),
    listenHost: HOST,
    port: PORT,
    networkUrls: settings.operation_mode === "lan" && portalEnabled ? getLanUrls(PORT) : [],
    publicUrl: serverModeActive ? publicUrl : "",
    httpsRequired: serverModeActive,
    trustProxy: serverModeActive ? trustProxySetting : "",
    deploymentKind,
    installationFeatures: features,
    installationFeatureCatalog,
    usbProvisioning: usbProvisioningAvailability(request),
    passwordMinLength: portalPasswordMinLength(),
    branding: locationId ? brandingForLocation(locationId, settings) : brandingFromSettings(settings),
    capabilities: {
      login: portalEnabled,
      ownSchedule: portalEnabled && features.employeePortal && features.schedule,
      vacationRequests: portalEnabled && features.employeePortal && features.vacation && features.requests,
      timeOffRequests: portalEnabled && features.employeePortal && features.requests,
      vacationChanges: portalEnabled && features.employeePortal && features.vacation && features.requests,
      requestBlackouts: portalEnabled && features.requests,
      approvalWorkflow: portalEnabled && features.requests,
      absenceHistory: portalEnabled && features.employeePortal && features.requests,
      notifications: portalEnabled && features.employeePortal && features.requests,
      amuReports: portalEnabled && features.employeePortal && features.sicknessAmu && Boolean(amuStorage),
      sicknessReports: portalEnabled && features.employeePortal && features.sicknessAmu && Boolean(amuStorage),
      localAmuOcr: portalEnabled && features.employeePortal && features.sicknessAmu && Boolean(amuStorage) && portalSettings.amu_ocr_enabled !== "0",
      timeTracking: portalEnabled && features.employeePortal && features.timeTracking,
      wifiTimeSuggestions: portalEnabled && features.employeePortal && features.timeTracking && features.wifiSuggestions,
    },
    workflow: {
      vacationHrApprovalRequired: vacationHrApprovalRequired(),
    },
  };
}

function requirePortalAdminOrLocal(request, permission = "users:write") {
  if (!getPortalStatus().portalEnabled && isLoopbackRequest(request)) {
    return { employeeNumber: "local", role: "admin", permissions: [permission] };
  }
  const session = requirePortalSession(request, permission);
  assertPortalCsrf(request);
  return session;
}

function requirePortalReadOrLocal(request, permission = "schedule:read") {
  if (!getPortalStatus().portalEnabled && isLoopbackRequest(request)) {
    return {
      employeeNumber: "local",
      role: "admin",
      permissions: builtinPortalRoles.find((role) => role.id === "admin")?.permissions || [permission],
      scopes: [],
    };
  }
  return requirePortalSession(request, permission);
}

function requireAdminHrOrLocal(request, permission) {
  const session = requirePortalAdminOrLocal(request, permission);
  if (session.employeeNumber !== "local" && !RIGHTS_ADMIN_PORTAL_ROLES.has(session.role)) {
    throw httpError(403, "Diese Aktion ist nur für Developer, IT-Admin, Admin oder Personalleitung verfügbar.", "PORTAL_PERMISSION_DENIED");
  }
  return session;
}

function sessionCanManageTimeConfirmationLevel(session) {
  if (!getPortalStatus().portalEnabled) return true;
  return Boolean(session
    && RIGHTS_ADMIN_PORTAL_ROLES.has(session.role)
    && session.permissions?.includes("wifi:settings"));
}

function sessionCanViewTimeConfirmationLevel(session) {
  if (!getPortalStatus().portalEnabled) return true;
  if (!session) return false;
  if (RIGHTS_ADMIN_PORTAL_ROLES.has(session.role)) return true;
  const policy = getTrustLevelPolicy();
  if (!policy.enabled) return false;
  if (session.role === "manager") return policy.visibleToManagers;
  if (session.role === "department_manager") return policy.visibleToDepartmentManagers;
  return false;
}

function employeeCanViewOwnTimeConfirmationLevel() {
  const policy = getTrustLevelPolicy();
  return policy.enabled && policy.visibleToEmployees;
}

function requirePortalAnyPermission(request, permissions) {
  if (!getPortalStatus().portalEnabled && isLoopbackRequest(request)) return { employeeNumber: "local", role: "admin", permissions };
  const session = requirePortalSession(request);
  assertPortalCsrf(request);
  if (!permissions.some((permission) => session.permissions.includes(permission))) throw httpError(403, "Für diese Aktion fehlt die Berechtigung.", "PORTAL_PERMISSION_DENIED");
  return session;
}

function portalUsersForAdmin() {
  return db.prepare(`
    SELECT e.personnel_number, e.full_name, e.nickname, e.home_location_id, e.preferred_department_id, e.active AS employee_active,
           u.role, u.role_locked, u.active, u.must_change_password, u.last_login_at, u.failed_login_attempts, u.locked_until,
           CASE WHEN TRIM(COALESCE(u.password_hash, '')) <> '' THEN 1 ELSE 0 END AS password_configured,
           r.name AS role_name
    FROM employees e
    LEFT JOIN portal_users u ON u.employee_number = e.personnel_number
    LEFT JOIN portal_roles r ON r.id = u.role
    ORDER BY CAST(e.personnel_number AS INTEGER), e.personnel_number
  `).all().map((row) => ({
    employeeNumber: row.personnel_number,
    fullName: row.full_name,
    nickname: row.nickname,
    employeeActive: Boolean(row.employee_active),
    configured: Boolean(row.role),
    role: row.role || "employee",
    roleName: row.role_name || "Mitarbeiter",
    roleLocked: Boolean(row.role_locked) || row.role === "developer",
    active: row.active === null ? false : Boolean(row.active),
    mustChangePassword: row.must_change_password === null ? true : Boolean(row.must_change_password),
    passwordConfigured: Boolean(row.password_configured),
    lastLoginAt: row.last_login_at || null,
    failedLoginAttempts: Number(row.failed_login_attempts || 0),
    lockedUntil: row.locked_until || null,
    locked: Boolean(row.locked_until && new Date(row.locked_until) > new Date()),
    homeLocationId: row.home_location_id || "",
    preferredDepartmentId: Number(row.preferred_department_id || 0) || null,
    grantedPermissions: portalPermissionGrantsForEmployee(row.personnel_number),
    scopes: db.prepare("SELECT location_id, department_id FROM portal_access_scopes WHERE employee_number = ? ORDER BY location_id, department_id")
      .all(row.personnel_number).map((scope) => ({ locationId: scope.location_id, departmentId: Number(scope.department_id || 0) || null })),
  }));
}

function portalUsersForActor(actor) {
  const users = portalUsersForAdmin();
  if (actor?.role !== "manager") return users;
  const locations = new Set((actor.scopes || []).map((scope) => scope.locationId));
  return users.filter((user) => user.role === "department_manager" && locations.has(user.homeLocationId));
}

function validateVacationRequestDates(employeeNumber, body) {
  const dateFrom = String(body.dateFrom || "");
  const dateTo = String(body.dateTo || "");
  const note = stripEmoji(String(body.note || "").trim()).slice(0, 500);
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateTo < dateFrom) {
    throw httpError(400, "Bitte einen gültigen Urlaubszeitraum eingeben.");
  }
  const availability = evaluateVacationRequest(employeeNumber, { dateFrom, dateTo });
  if (!availability.allowed) throw httpError(409, availability.reason, "REQUEST_BLACKOUT");
  const overlapping = db.prepare(`
    SELECT id FROM vacation_requests
    WHERE employee_number = ? AND status IN ('pending','pending_local','preliminary_local','pending_hr','approved')
      AND date_from <= ? AND date_to >= ?
    LIMIT 1
  `).get(employeeNumber, dateTo, dateFrom);
  if (overlapping) throw httpError(409, "Für diesen Zeitraum besteht bereits ein Urlaubsantrag.");
  return { employeeNumber, dateFrom, dateTo, note };
}

function employeeRequestContext(employeeNumber, date = null, options = {}) {
  const employee = db.prepare(`
    SELECT personnel_number, full_name, nickname, home_location_id, preferred_department_id
    FROM employees WHERE personnel_number = ?${options.includeInactive ? "" : " AND active = 1"}
  `).get(employeeNumber);
  if (!employee) throw httpError(404, options.includeInactive ? "Das Teammitglied wurde nicht gefunden." : "Das aktive Teammitglied wurde nicht gefunden.");
  let departmentId = employee.preferred_department_id ? Number(employee.preferred_department_id) : null;
  if (date) {
    const shiftDepartment = db.prepare(`
      SELECT department_id FROM shifts
      WHERE employee_number = ? AND shift_date = ? AND department_id IS NOT NULL
      ORDER BY start_time LIMIT 1
    `).get(employeeNumber, date)?.department_id;
    if (shiftDepartment) departmentId = Number(shiftDepartment);
  }
  return {
    employee,
    locationId: employee.home_location_id || getLocations(true)[0]?.id || "01",
    departmentId,
  };
}

const timeEntryTypes = new Set(["clock_in", "break_start", "break_end", "clock_out"]);
const timeEntryLabels = {
  clock_in: "Kommen",
  break_start: "Pause",
  break_end: "Weiter",
  clock_out: "Gehen",
};
const TIME_EVALUATION_VERSION = "v1";

function timeEntryStateFromType(type) {
  if (type === "clock_in" || type === "break_end") return "working";
  if (type === "break_start") return "paused";
  return "off";
}

function allowedTimeEntryActions(state) {
  if (state === "off") return ["clock_in"];
  if (state === "working") return ["break_start", "clock_out"];
  if (state === "paused") return ["break_end", "clock_out"];
  return [];
}

function suggestedClockOutTime(employeeNumber, date, locationId, latestTimestamp = "") {
  const shiftEnd = db.prepare(`
    SELECT end_time FROM shifts WHERE employee_number = ? AND shift_date = ?
    ORDER BY end_time DESC LIMIT 1
  `).get(employeeNumber, date)?.end_time;
  const dayIndex = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
  const dayKey = planningDays[dayIndex]?.[0];
  const settings = settingsForLocation(locationId);
  let suggestion = isTime(shiftEnd) ? shiftEnd : (dayKey && isTime(settings[`${dayKey}_end_time`]) ? settings[`${dayKey}_end_time`] : "18:00");
  const latestLocalTime = latestTimestamp ? viennaNowLocal(new Date(latestTimestamp)).slice(11, 16) : "";
  if (isTime(latestLocalTime) && timeToMinutes(suggestion) < timeToMinutes(latestLocalTime)) suggestion = latestLocalTime;
  return suggestion;
}

function parseTimeEntrySequence(entries, date, now = new Date()) {
  const today = viennaTodayIso(now);
  const ordered = [...entries].sort((left, right) => String(left.entry_timestamp).localeCompare(String(right.entry_timestamp)) || Number(left.id || 0) - Number(right.id || 0));
  const segments = [];
  const errors = [];
  let state = "off";
  let workingFrom = null;
  let firstTimestamp = null;
  let lastTimestamp = null;
  for (const entry of ordered) {
    const timestamp = new Date(entry.entry_timestamp);
    if (Number.isNaN(timestamp.getTime())) {
      errors.push({ code: "invalid_timestamp", entryId: Number(entry.id || 0) || null });
      continue;
    }
    if (lastTimestamp && timestamp <= lastTimestamp) {
      errors.push({ code: "non_increasing_timestamp", entryId: Number(entry.id || 0) || null });
      continue;
    }
    const type = String(entry.entry_type || "");
    const allowed = allowedTimeEntryActions(state);
    if (!allowed.includes(type)) {
      errors.push({ code: "invalid_sequence", entryId: Number(entry.id || 0) || null, type, state });
      continue;
    }
    if (!firstTimestamp && type === "clock_in") firstTimestamp = timestamp;
    if (type === "clock_in" || type === "break_end") {
      workingFrom = timestamp;
      state = "working";
    } else if (type === "break_start") {
      if (workingFrom) segments.push({ start: workingFrom, end: timestamp });
      workingFrom = null;
      state = "paused";
    } else if (type === "clock_out") {
      if (state === "working" && workingFrom) segments.push({ start: workingFrom, end: timestamp });
      workingFrom = null;
      state = "off";
    }
    lastTimestamp = timestamp;
  }
  const ongoing = date === today && state !== "off";
  if (ongoing && state === "working" && workingFrom && now > workingFrom) segments.push({ start: workingFrom, end: now, ongoing: true });
  const effectiveEnd = ongoing ? now : lastTimestamp;
  const workedMilliseconds = segments.reduce((sum, segment) => sum + Math.max(0, segment.end - segment.start), 0);
  const presenceMilliseconds = firstTimestamp && effectiveEnd ? Math.max(0, effectiveEnd - firstTimestamp) : 0;
  return {
    state,
    ongoing,
    incomplete: ordered.length > 0 && state !== "off",
    segments,
    errors,
    workedMinutes: Math.floor(workedMilliseconds / 60000),
    presenceMinutes: Math.floor(presenceMilliseconds / 60000),
    breakMinutes: Math.max(0, Math.floor((presenceMilliseconds - workedMilliseconds) / 60000)),
    firstTimestamp: firstTimestamp?.toISOString() || null,
    lastTimestamp: lastTimestamp?.toISOString() || null,
  };
}

function plannedDayMetrics(employeeNumber, date, locationId, departmentId = null, filterLocation = false) {
  const settings = settingsForLocation(locationId);
  const blocks = db.prepare(`
    SELECT s.id, s.employee_number, s.department_id, s.shift_date, s.start_time, s.end_time
    FROM shifts s
    JOIN employees e ON e.personnel_number = s.employee_number
    LEFT JOIN departments d ON d.id = s.department_id
    WHERE s.employee_number = ? AND s.shift_date = ?
      AND (? IS NULL OR s.department_id = ?)
      AND (? = 0 OR COALESCE(d.location_id, e.home_location_id) = ?)
    ORDER BY s.start_time, s.id
  `).all(employeeNumber, date, departmentId, departmentId, filterLocation ? 1 : 0, locationId)
    .map((shift) => ({ ...shift, ...shiftMetrics(shift, settings) }));
  return blocks.reduce((result, block) => ({
    grossMinutes: result.grossMinutes + Number(block.raw_minutes || 0),
    breakMinutes: result.breakMinutes + Number(block.break_minutes || 0),
    netMinutes: result.netMinutes + Math.max(0, Number(block.raw_minutes || 0) - Number(block.break_minutes || 0)),
    saturdayBonusMinutes: result.saturdayBonusMinutes + Number(block.bonus_minutes || 0),
    valuedMinutes: result.valuedMinutes + Number(block.counted_minutes || 0),
    blocks: result.blocks,
  }), { grossMinutes: 0, breakMinutes: 0, netMinutes: 0, saturdayBonusMinutes: 0, valuedMinutes: 0, blocks });
}

function plannedMinutesForEmployeeDate(employeeNumber, date, locationId, departmentId = null) {
  return plannedDayMetrics(employeeNumber, date, locationId, departmentId).netMinutes;
}

function actualDayMetrics(entries, date, settings, now = new Date()) {
  const parsed = parseTimeEntrySequence(entries, date, now);
  let eligibleSaturdayMinutes = 0;
  const isSaturday = new Date(`${date}T12:00:00Z`).getUTCDay() === 6;
  if (isSaturday && settingEnabled(settings, "saturday_bonus_enabled") && isTime(settings.saturday_bonus_from)) {
    const bonusFrom = viennaLocalDateTime(date, settings.saturday_bonus_from);
    eligibleSaturdayMinutes = Math.floor(parsed.segments.reduce((sum, segment) => (
      sum + Math.max(0, segment.end - (segment.start > bonusFrom ? segment.start : bonusFrom))
    ), 0) / 60000);
  }
  const saturdayBonusMinutes = Math.round(eligibleSaturdayMinutes * Math.max(0, Number(settings.saturday_bonus_factor || 1) - 1));
  return {
    ...parsed,
    saturdayEligibleMinutes: eligibleSaturdayMinutes,
    saturdayBonusMinutes,
    valuedMinutes: parsed.workedMinutes + saturdayBonusMinutes,
  };
}

function excusedTimeForEmployeeDate(employeeNumber, date, locationId, activeSickness = null) {
  const options = db.prepare(`
    SELECT option_type, note, all_day, start_time, end_time
    FROM week_options
    WHERE employee_number = ? AND ? BETWEEN date_from AND date_to
    ORDER BY all_day DESC, start_time
  `).all(employeeNumber, date);
  if ((activeSickness || activeSicknessEmployeeNumbers(date)).has(employeeNumber)) {
    return { excused: true, label: "Krankenstand", options };
  }
  const allDayOptions = options.filter((option) => Boolean(option.all_day));
  if (allDayOptions.length) {
    return {
      excused: true,
      label: allDayOptions.map((option) => optionLabel(option.option_type)).join(", "),
      options,
    };
  }
  if (isVacationHoliday(date, locationId)) return { excused: true, label: "Feiertag", options: [] };
  return { excused: false, label: "", options };
}

function serializeTimeDayReview(row) {
  if (!row) return null;
  let snapshot = {};
  try { snapshot = JSON.parse(row.snapshot_json || "{}"); } catch {}
  return {
    employeeNumber: row.employee_number,
    locationId: row.location_id || "",
    departmentId: Number(row.department_id || 0) || null,
    workDate: row.work_date,
    note: row.note || "",
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    evaluationVersion: row.evaluation_version || TIME_EVALUATION_VERSION,
    snapshot,
  };
}

function timeDayReview(employeeNumber, date, departmentId = null) {
  const departmentKey = Number(departmentId || 0) || 0;
  return serializeTimeDayReview(db.prepare(`
    SELECT employee_number, location_id, department_id, department_key, work_date, note,
           reviewed_by, reviewed_at, evaluation_version, snapshot_json
    FROM time_day_reviews
    WHERE employee_number = ? AND work_date = ? AND department_key = ?
  `).get(employeeNumber, date, departmentKey));
}

function invalidateTimeDayReview(employeeNumber, date) {
  if (!employeeNumber || !isIsoDate(date)) return 0;
  return Number(db.prepare("DELETE FROM time_day_reviews WHERE employee_number = ? AND work_date = ?")
    .run(employeeNumber, date).changes || 0);
}

function invalidateTimeDayReviewsForRange(locationId, dateFrom, dateTo, departmentId = null) {
  if (!locationId || !isIsoDate(dateFrom) || !isIsoDate(dateTo)) return 0;
  const result = departmentId
    ? db.prepare(`
      DELETE FROM time_day_reviews
      WHERE location_id = ? AND work_date BETWEEN ? AND ? AND department_key IN (0, ?)
    `).run(locationId, dateFrom, dateTo, Number(departmentId))
    : db.prepare(`
      DELETE FROM time_day_reviews
      WHERE location_id = ? AND work_date BETWEEN ? AND ?
    `).run(locationId, dateFrom, dateTo);
  return Number(result.changes || 0);
}

function evaluateTimeDay(employeeNumber, date, now = new Date(), departmentId = null, providedEntries = null, evaluationOptions = {}) {
  const context = employeeRequestContext(employeeNumber, date, { includeInactive: evaluationOptions.includeInactive === true });
  const evaluationLocationId = String(evaluationOptions.locationId || context.locationId);
  const filterLocation = evaluationOptions.filterLocation === true;
  const location = validateLocationExists(evaluationLocationId);
  const settings = settingsForLocation(evaluationLocationId);
  const entries = (providedEntries || timeEntriesForDay(employeeNumber, date))
    .filter((entry) => (!departmentId || Number(entry.department_id || 0) === Number(departmentId))
      && (!filterLocation || String(entry.location_id || context.locationId) === evaluationLocationId));
  const planned = plannedDayMetrics(employeeNumber, date, evaluationLocationId, departmentId, filterLocation);
  const actual = actualDayMetrics(entries, date, settings, now);
  const excused = excusedTimeForEmployeeDate(employeeNumber, date, evaluationLocationId, evaluationOptions.activeSickness || null);
  const today = viennaTodayIso(now);
  const isPast = date < today;
  const isFuture = date > today;
  const plannedEndTime = planned.blocks.map((block) => block.end_time).filter(isTime).sort().at(-1) || "";
  const todayAfterPlannedEnd = date === today && plannedEndTime && viennaNowLocal(now).slice(11, 16) >= plannedEndTime;
  const bookingWindowEnded = isPast || todayAfterPlannedEnd;
  const toleranceMinutes = Math.max(0, Number(location.time_tracking_variance_minutes ?? 15));
  const differenceMinutes = actual.workedMinutes - planned.netMinutes;
  const valuedDifferenceMinutes = actual.valuedMinutes - planned.valuedMinutes;
  const requiredBreakMinutes = settingEnabled(settings, "break_rule_enabled")
    && actual.workedMinutes > Number(settings.break_after_minutes || 0)
    ? Number(settings.break_duration_minutes || 0)
    : 0;
  const issues = [];
  const addIssue = (code, severity, label, message) => issues.push({ code, severity, label, message });
  if (actual.errors.length) addIssue("invalid_sequence", "error", "Buchungsfolge prüfen", "Mindestens eine Buchung passt nicht zur zeitlichen Reihenfolge.");
  if (isPast && actual.incomplete) addIssue("incomplete", "error", "Abschluss fehlt", "Der Arbeitstag wurde nicht vollständig mit „Gehen“ abgeschlossen.");
  if (bookingWindowEnded && planned.netMinutes > 0 && entries.length === 0 && !excused.excused) {
    addIssue("missing_entries", "error", "Buchungen fehlen", "Für den geplanten Dienst wurden keine Zeitbuchungen erfasst.");
  }
  if (!isFuture && actual.workedMinutes > 0 && planned.netMinutes === 0 && !excused.excused) {
    addIssue("unscheduled_work", "warning", "Ohne Dienstplan", "Es wurde Arbeitszeit ohne geplanten Dienst erfasst.");
  }
  if (!isFuture && !actual.incomplete && requiredBreakMinutes > actual.breakMinutes) {
    addIssue("break_short", "error", "Pause zu kurz", `Erfasst sind ${actual.breakMinutes} statt mindestens ${requiredBreakMinutes} Pausenminuten.`);
  }
  if (!isFuture && !actual.incomplete && planned.netMinutes > 0 && entries.length > 0 && Math.abs(differenceMinutes) > toleranceMinutes) {
    addIssue("variance", "warning", "Zeitabweichung", `Die Ist-Zeit weicht um mehr als ${toleranceMinutes} Minuten vom Dienstplan ab.`);
  }
  const pendingCorrection = Boolean(db.prepare(`
    SELECT 1 FROM time_corrections
    WHERE employee_number = ? AND correction_date = ? AND status = 'pending'
      AND (? = 0 OR location_id = ?)
      AND (? IS NULL OR department_id = ?)
    LIMIT 1
  `).get(employeeNumber, date, filterLocation ? 1 : 0, evaluationLocationId, departmentId, departmentId));
  if (pendingCorrection) addIssue("pending_correction", "info", "Korrektur offen", "Für diesen Tag wartet ein Korrekturantrag auf Bearbeitung.");
  const evaluationHash = sha256(JSON.stringify({
    version: TIME_EVALUATION_VERSION,
    locationId: evaluationLocationId,
    departmentId: Number(departmentId || 0) || 0,
    planned: planned.blocks.map((block) => [block.id, block.department_id, block.start_time, block.end_time]),
    entries: entries.map((entry) => [entry.id, entry.department_id, entry.entry_type, entry.entry_timestamp]),
    excused: excused.options.map((option) => [option.option_type, option.all_day, option.start_time, option.end_time]),
    excusedStatus: excused.excused ? excused.label || "excused" : "",
    holiday: excused.label === "Feiertag",
    rules: [
      toleranceMinutes,
      settings.break_rule_enabled,
      settings.break_after_minutes,
      settings.break_duration_minutes,
      settings.saturday_bonus_enabled,
      settings.saturday_bonus_from,
      settings.saturday_bonus_factor,
    ],
  }));
  const review = timeDayReview(employeeNumber, date, departmentId);
  if (review) {
    review.stale = review.locationId !== evaluationLocationId || review.snapshot?.evaluationHash !== evaluationHash;
    if (review.stale) addIssue("review_stale", "info", "Prüfung veraltet", "Plan, Buchungen oder Bewertungsregeln wurden seit der Prüfung geändert.");
  }
  let code = isFuture ? "future" : date === today && actual.ongoing ? actual.state : "complete";
  if (!entries.length && excused.excused) code = "excused_absence";
  else if (!entries.length && planned.netMinutes > 0) code = isFuture || (date === today && !todayAfterPlannedEnd) ? "planned" : "missing_entries";
  else if (!entries.length && planned.netMinutes === 0) code = "no_data";
  else if (issues.some((issue) => issue.severity === "error")) code = issues[0].code;
  else if (issues.length) code = "attention";
  const severity = issues.some((issue) => issue.severity === "error") ? "error"
    : issues.some((issue) => issue.severity === "warning") ? "warning"
      : issues.some((issue) => issue.severity === "info") ? "info" : "ok";
  return {
    evaluationVersion: TIME_EVALUATION_VERSION,
    evaluationHash,
    date,
    workDate: date,
    locationId: evaluationLocationId,
    departmentId: departmentId || context.departmentId,
    code,
    severity,
    issues,
    excused,
    pendingCorrection,
    planned,
    actual,
    comparison: {
      workedDifferenceMinutes: differenceMinutes,
      valuedDifferenceMinutes,
    },
    plannedMinutes: planned.netMinutes,
    actualMinutes: actual.workedMinutes,
    differenceMinutes,
    plannedValuedMinutes: planned.valuedMinutes,
    actualValuedMinutes: actual.valuedMinutes,
    valuedDifferenceMinutes,
    breakMinutes: actual.breakMinutes,
    requiredBreakMinutes,
    saturdayBonusMinutes: actual.saturdayBonusMinutes,
    incomplete: isPast && actual.incomplete,
    review,
  };
}

function calculateWorkedMinutes(entries, now = new Date()) {
  const date = entries[0]?.work_date || viennaTodayIso(now);
  return parseTimeEntrySequence(entries, date, now).workedMinutes;
}

function timeEntriesForDay(employeeNumber, date) {
  return db.prepare(`
    SELECT id, employee_number, location_id, department_id, work_date, entry_type,
           entry_timestamp, source, note, created_by, created_at
    FROM time_entries WHERE employee_number = ? AND work_date = ? AND voided_at IS NULL
    ORDER BY entry_timestamp, id
  `).all(employeeNumber, date);
}

function findStaleOpenTimeEntry(employeeNumber, today) {
  const dates = db.prepare(`
    SELECT DISTINCT work_date FROM time_entries
    WHERE employee_number = ? AND work_date < ? AND voided_at IS NULL
    ORDER BY work_date DESC
  `).all(employeeNumber, today);
  for (const row of dates) {
    const entries = timeEntriesForDay(employeeNumber, row.work_date);
    const parsed = parseTimeEntrySequence(entries, row.work_date, new Date(`${today}T12:00:00Z`));
    if (parsed.incomplete) return entries.at(-1) || null;
  }
  return null;
}

function timeTrackingDayStatus(employeeNumber, date = viennaTodayIso(), now = new Date(), options = {}) {
  if (!isIsoDate(date)) throw httpError(400, "Bitte ein gültiges Datum auswählen.", "TIME_ENTRY_DATE_INVALID");
  const context = employeeRequestContext(employeeNumber, date);
  const location = validateLocationExists(context.locationId);
  const entries = timeEntriesForDay(employeeNumber, date);
  const latestToday = entries.at(-1) || null;
  const today = viennaTodayIso(now);
  const staleEntry = findStaleOpenTimeEntry(employeeNumber, today);
  const evaluation = evaluateTimeDay(employeeNumber, date, now, options.departmentId || null);
  const state = staleEntry && date === today ? "attention" : evaluation.actual.state;
  const trackingEnabled = Boolean(location.time_tracking_enabled);
  const access = options.access || { allowed: options.accessAllowed !== false, mode: location.time_tracking_access_mode || "anywhere", reason: "" };
  const allowedActions = trackingEnabled && access.allowed && date === today && !staleEntry ? allowedTimeEntryActions(state) : [];
  return {
    date,
    workDate: date,
    timezone: "Europe/Vienna",
    serverTime: now.toISOString(),
    trackingEnabled,
    enabled: trackingEnabled,
    locationId: context.locationId,
    locationName: location.name,
    departmentId: options.departmentId || context.departmentId,
    accessMode: access.mode,
    accessAllowed: access.allowed,
    state,
    stateSince: latestToday?.entry_timestamp || staleEntry?.entry_timestamp || null,
    staleEntry: staleEntry ? {
      date: staleEntry.work_date,
      type: staleEntry.entry_type,
      timestamp: staleEntry.entry_timestamp,
      suggestedClockOutTime: suggestedClockOutTime(employeeNumber, staleEntry.work_date, staleEntry.location_id || context.locationId, staleEntry.entry_timestamp),
      message: `Eine Buchung vom ${staleEntry.work_date} wurde nicht mit „Gehen“ abgeschlossen. Bitte die Leitung informieren.`,
    } : null,
    reason: !trackingEnabled
      ? "Die Zeiterfassung ist für diesen Standort noch nicht aktiviert."
      : !access.allowed
        ? access.reason
      : staleEntry
        ? `Eine Buchung vom ${staleEntry.work_date} wurde nicht mit „Gehen“ abgeschlossen. Bitte die Leitung informieren.`
        : "",
    allowedActions,
    ...evaluation,
    entries: entries.filter((entry) => !options.departmentId || Number(entry.department_id || 0) === Number(options.departmentId)).map((entry) => ({
      id: Number(entry.id),
      type: entry.entry_type,
      label: timeEntryLabels[entry.entry_type] || entry.entry_type,
      timestamp: entry.entry_timestamp,
      locationId: entry.location_id || context.locationId,
      departmentId: Number(entry.department_id || 0) || null,
    })),
  };
}

function timeEntryDepartment(employeeNumber, date, action, now, entries = []) {
  const latestDepartment = Number(entries.at(-1)?.department_id || 0) || null;
  if (action !== "clock_in") return latestDepartment || employeeRequestContext(employeeNumber, date).departmentId;
  const localTime = viennaNowLocal(now).slice(11, 16);
  return scheduledTimeEntryDepartment(employeeNumber, date, localTime)
    || employeeRequestContext(employeeNumber, date).departmentId;
}

function scheduledTimeEntryDepartment(employeeNumber, date, localTime) {
  const shifts = db.prepare(`
    SELECT department_id, start_time, end_time
    FROM shifts
    WHERE employee_number = ? AND shift_date = ? AND department_id IS NOT NULL
    ORDER BY start_time, id
  `).all(employeeNumber, date);
  const matching = shifts.find((shift) => shift.start_time <= localTime && shift.end_time >= localTime)
    || shifts.find((shift) => shift.start_time >= localTime)
    || shifts.at(-1);
  return Number(matching?.department_id || 0) || null;
}

function bookTimeEntry(employeeNumber, action, now = new Date(), options = {}) {
  if (!timeEntryTypes.has(action)) throw httpError(400, "Diese Zeitbuchung ist ungültig.", "TIME_ENTRY_ACTION_INVALID");
  const clientRequestId = String(options.clientRequestId || "").trim().toLowerCase();
  if (clientRequestId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientRequestId)) {
    throw httpError(400, "Die mobile Buchungs-ID ist ungültig.", "TIME_ENTRY_CLIENT_REQUEST_INVALID");
  }
  const date = viennaTodayIso(now);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (clientRequestId) {
      const existing = db.prepare(`
        SELECT id, entry_type FROM time_entries
        WHERE employee_number = ? AND client_request_id = ?
        LIMIT 1
      `).get(employeeNumber, clientRequestId);
      if (existing) {
        if (existing.entry_type !== action) {
          throw httpError(409, "Diese mobile Buchungs-ID wurde bereits für eine andere Aktion verwendet.", "TIME_ENTRY_IDEMPOTENCY_CONFLICT");
        }
        const replayStatus = timeTrackingDayStatus(employeeNumber, date, now, options);
        db.exec("COMMIT");
        return options.returnMeta ? { status: replayStatus, replayed: true } : replayStatus;
      }
    }
    const before = timeTrackingDayStatus(employeeNumber, date, now, options);
    if (!before.trackingEnabled) {
      throw httpError(409, "Die Zeiterfassung ist für diesen Standort noch nicht aktiviert.", "TIME_TRACKING_DISABLED");
    }
    if (before.staleEntry) {
      throw httpError(409, before.staleEntry.message, "TIME_ENTRY_PREVIOUS_DAY_OPEN");
    }
    if (!before.accessAllowed) {
      throw httpError(403, before.reason, "TIME_TRACKING_NETWORK_REQUIRED");
    }
    if (!before.allowedActions.includes(action)) {
      throw httpError(409, "Diese Buchung passt nicht zum aktuellen Zeiterfassungsstatus. Bitte die Anzeige aktualisieren.", "TIME_ENTRY_STATE_CONFLICT");
    }
    const context = employeeRequestContext(employeeNumber, date);
    context.departmentId = timeEntryDepartment(employeeNumber, date, action, now, timeEntriesForDay(employeeNumber, date));
    const timestamp = now.toISOString();
    const result = db.prepare(`
      INSERT INTO time_entries
        (employee_number, location_id, department_id, work_date, entry_type, entry_timestamp,
         source, created_by, client_request_id, mobile_session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(employeeNumber, context.locationId, context.departmentId, date, action, timestamp,
      options.source === "mobile" ? "mobile" : "portal", employeeNumber, clientRequestId || null,
      options.mobileSessionId ? String(options.mobileSessionId) : null);
    db.prepare("DELETE FROM time_day_reviews WHERE employee_number = ? AND work_date = ?").run(employeeNumber, date);
    auditPortal(employeeNumber, "time.entry.create", "time_entry", String(result.lastInsertRowid), JSON.stringify({ action, date, locationId: context.locationId }));
    db.exec("COMMIT");
    const status = timeTrackingDayStatus(employeeNumber, date, now, options);
    return options.returnMeta ? { status, replayed: false } : status;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function resolveStaleTimeEntry(session, employeeNumber, workDate, clockOutTime, now = new Date()) {
  if (!isIsoDate(workDate) || !isTime(clockOutTime)) throw httpError(400, "Bitte Datum und Uhrzeit vollständig eingeben.", "TIME_CORRECTION_INVALID");
  assertSessionEmployeeScope(session, employeeNumber);
  db.exec("BEGIN IMMEDIATE");
  try {
    const workDateEntries = timeEntriesForDay(employeeNumber, workDate);
    const latest = workDateEntries.at(-1) || null;
    const parsed = parseTimeEntrySequence(workDateEntries, workDate, now);
    if (!latest || workDate >= viennaTodayIso(now) || !parsed.incomplete) {
      throw httpError(409, "Die offene Altbuchung wurde bereits geändert oder ist nicht mehr vorhanden.", "TIME_CORRECTION_STATE_CONFLICT");
    }
    const fallbackContext = employeeRequestContext(employeeNumber, workDate);
    const correctionContext = {
      locationId: latest.location_id || fallbackContext.locationId,
      departmentId: Number(latest.department_id || 0) || fallbackContext.departmentId,
    };
    assertSessionContextScope(session, correctionContext);
    const correctedAt = viennaLocalDateTime(workDate, clockOutTime);
    const previousAt = new Date(latest.entry_timestamp);
    if (Number.isNaN(previousAt.getTime()) || correctedAt < previousAt || correctedAt >= now) {
      throw httpError(400, "Die Abschlusszeit muss nach der letzten Buchung und vor der aktuellen Serverzeit liegen.", "TIME_CORRECTION_INVALID");
    }
    const note = "Offene Buchung durch die Leitung abgeschlossen";
    const requestedChange = {
      action: "close_stale_entry",
      clockOutTime,
      originalEntryIds: workDateEntries.map((entry) => Number(entry.id)),
    };
    const correctionResult = db.prepare(`
      INSERT INTO time_corrections
        (employee_number, location_id, department_id, correction_date, requested_change, request_note,
         status, requested_by, decided_by, decided_at, decision_note)
      VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, CURRENT_TIMESTAMP, ?)
    `).run(employeeNumber, correctionContext.locationId, correctionContext.departmentId, workDate,
      JSON.stringify(requestedChange), note, session.employeeNumber, session.employeeNumber, note);
    const correctionId = Number(correctionResult.lastInsertRowid);
    const result = db.prepare(`
      INSERT INTO time_entries
        (employee_number, location_id, department_id, work_date, entry_type, entry_timestamp, source, note, created_by, correction_id)
      VALUES (?, ?, ?, ?, 'clock_out', ?, 'manager_correction', ?, ?, ?)
    `).run(employeeNumber, correctionContext.locationId, correctionContext.departmentId, workDate,
      correctedAt.toISOString(), note, session.employeeNumber, correctionId);
    requestedChange.timeEntryId = Number(result.lastInsertRowid);
    db.prepare("UPDATE time_corrections SET requested_change = ? WHERE id = ?")
      .run(JSON.stringify(requestedChange), correctionId);
    db.prepare("DELETE FROM time_day_reviews WHERE employee_number = ? AND work_date = ?").run(employeeNumber, workDate);
    auditPortal(session.employeeNumber, "time.entry.stale.resolve", "time_entry", String(result.lastInsertRowid), JSON.stringify({ employeeNumber, workDate, clockOutTime }));
    auditPortal(session.employeeNumber, "time.correction.approved", "time_correction", String(correctionId), JSON.stringify(requestedChange));
    db.exec("COMMIT");
    return timeTrackingDayStatus(employeeNumber, viennaTodayIso(now), now);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function timePresenceForContext(session, context, date = viennaTodayIso(), now = new Date()) {
  assertSessionContextScope(session, context);
  const employees = db.prepare(`
    SELECT personnel_number, full_name, nickname, color, home_location_id, preferred_department_id
    FROM employees WHERE active = 1 AND home_location_id = ?
  `).all(context.locationId)
    .filter((employee) => !context.departmentId || employeeRequestContext(employee.personnel_number, date).departmentId === context.departmentId)
    .sort((left, right) => left.personnel_number.localeCompare(right.personnel_number, "de", { numeric: true }));
  return {
    date,
    timezone: "Europe/Vienna",
    serverTime: now.toISOString(),
    locationId: context.locationId,
    locationName: context.locationName,
    departmentId: context.departmentId,
    departmentName: context.departmentName,
    trackingEnabled: Boolean(validateLocationExists(context.locationId).time_tracking_enabled),
    employees: employees.map((employee) => ({
      employeeNumber: employee.personnel_number,
      fullName: employee.full_name,
      nickname: employee.nickname,
      color: employee.color,
      ...timeTrackingDayStatus(employee.personnel_number, date, now, { departmentId: context.departmentId }),
    })),
  };
}

function employeeHasTimeContextActivity(employee, context, date) {
  if (employee.home_location_id !== context.locationId) return false;
  if (!context.departmentId) return true;
  if (Number(employee.preferred_department_id || 0) === Number(context.departmentId)) return true;
  return Boolean(db.prepare(`
    SELECT 1
    WHERE EXISTS (
      SELECT 1 FROM shifts
      WHERE employee_number = ? AND shift_date = ? AND department_id = ?
    ) OR EXISTS (
      SELECT 1 FROM time_entries
      WHERE employee_number = ? AND work_date = ? AND department_id = ? AND voided_at IS NULL
    )
  `).get(
    employee.personnel_number, date, context.departmentId,
    employee.personnel_number, date, context.departmentId,
  ));
}

function timeDayEvaluationsForContext(session, context, date = viennaTodayIso(), now = new Date()) {
  if (!isIsoDate(date)) throw httpError(400, "Bitte ein gültiges Datum auswählen.", "TIME_ENTRY_DATE_INVALID");
  assertSessionContextScope(session, context);
  const employees = db.prepare(`
    SELECT personnel_number, full_name, nickname, color, home_location_id, preferred_department_id
    FROM employees
    WHERE active = 1 AND home_location_id = ?
    ORDER BY CAST(personnel_number AS INTEGER), personnel_number
  `).all(context.locationId)
    .filter((employee) => employeeHasTimeContextActivity(employee, context, date));
  const evaluations = employees.map((employee) => ({
    employeeNumber: employee.personnel_number,
    fullName: employee.full_name,
    nickname: employee.nickname,
    color: employee.color,
    ...evaluateTimeDay(employee.personnel_number, date, now, context.departmentId),
  }));
  return {
    date,
    timezone: "Europe/Vienna",
    serverTime: now.toISOString(),
    context,
    counts: {
      total: evaluations.length,
      attention: evaluations.filter((entry) => entry.issues.length > 0).length,
      reviewed: evaluations.filter((entry) => Boolean(entry.review && !entry.review.stale)).length,
      unreviewed: evaluations.filter((entry) => !entry.review || entry.review.stale).length,
    },
    evaluations,
  };
}

function setTimeDayReview(session, context, employeeNumber, date, body = {}, now = new Date()) {
  if (!isIsoDate(date) || date > viennaTodayIso(now)) {
    throw httpError(400, "Es können nur heutige oder vergangene Arbeitstage geprüft werden.", "TIME_DAY_REVIEW_DATE_INVALID");
  }
  assertSessionContextScope(session, context);
  const employee = db.prepare(`
    SELECT personnel_number, full_name, nickname, color, home_location_id, preferred_department_id
    FROM employees WHERE personnel_number = ? AND active = 1
  `).get(employeeNumber);
  if (!employee || !employeeHasTimeContextActivity(employee, context, date)) {
    throw httpError(404, "Das Teammitglied wurde in diesem Bereich nicht gefunden.", "TIME_DAY_REVIEW_EMPLOYEE_NOT_FOUND");
  }
  const departmentKey = Number(context.departmentId || 0) || 0;
  if (body.reviewed === false) {
    db.prepare(`
      DELETE FROM time_day_reviews
      WHERE employee_number = ? AND work_date = ? AND department_key = ?
    `).run(employeeNumber, date, departmentKey);
    auditPortal(session.employeeNumber, "time.day_review.remove", "time_day_review", `${employeeNumber}:${date}:${departmentKey}`);
    return {
      employeeNumber: employee.personnel_number,
      fullName: employee.full_name,
      nickname: employee.nickname,
      color: employee.color,
      ...evaluateTimeDay(employeeNumber, date, now, context.departmentId),
    };
  }
  const note = stripEmoji(String(body.note || "").trim()).slice(0, 500);
  const evaluation = evaluateTimeDay(employeeNumber, date, now, context.departmentId);
  const snapshot = {
    evaluationVersion: evaluation.evaluationVersion,
    evaluationHash: evaluation.evaluationHash,
    code: evaluation.code,
    severity: evaluation.severity,
    plannedMinutes: evaluation.plannedMinutes,
    actualMinutes: evaluation.actualMinutes,
    actualValuedMinutes: evaluation.actualValuedMinutes,
    differenceMinutes: evaluation.differenceMinutes,
    issues: evaluation.issues.map((issue) => issue.code),
  };
  db.prepare(`
    INSERT INTO time_day_reviews
      (employee_number, location_id, department_id, department_key, work_date, note,
       reviewed_by, reviewed_at, evaluation_version, snapshot_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number, work_date, department_key) DO UPDATE SET
      location_id = excluded.location_id,
      department_id = excluded.department_id,
      note = excluded.note,
      reviewed_by = excluded.reviewed_by,
      reviewed_at = CURRENT_TIMESTAMP,
      evaluation_version = excluded.evaluation_version,
      snapshot_json = excluded.snapshot_json,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, context.locationId, context.departmentId, departmentKey, date, note,
    session.employeeNumber, TIME_EVALUATION_VERSION, JSON.stringify(snapshot));
  auditPortal(session.employeeNumber, "time.day_review.save", "time_day_review", `${employeeNumber}:${date}:${departmentKey}`, JSON.stringify(snapshot));
  return {
    employeeNumber: employee.personnel_number,
    fullName: employee.full_name,
    nickname: employee.nickname,
    color: employee.color,
    ...evaluateTimeDay(employeeNumber, date, now, context.departmentId),
  };
}

function calculateRecordedMinutes(entries, date, now = new Date()) {
  return parseTimeEntrySequence(entries, date, now).workedMinutes;
}

function parseTimeCorrectionChange(value) {
  if (value && typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function serializeTimeCorrection(row) {
  if (!row) return null;
  const requestedChange = parseTimeCorrectionChange(row.requested_change);
  const proposedEntries = requestedChange.proposedEntries || requestedChange.entries || [];
  return {
    id: Number(row.id),
    employeeNumber: row.employee_number,
    fullName: row.full_name || "",
    nickname: row.nickname || "",
    locationId: row.location_id || "",
    locationName: row.location_name || "",
    departmentId: Number(row.department_id || 0) || null,
    departmentName: row.department_name || "",
    correctionDate: row.correction_date,
    requestedChange,
    requested_change: requestedChange,
    proposedEntries,
    entries: proposedEntries,
    reason: row.request_note || requestedChange.note || "",
    note: row.request_note || requestedChange.note || "",
    status: row.status,
    requestedBy: row.requested_by || row.employee_number,
    decidedBy: row.decided_by || null,
    decidedAt: row.decided_at || null,
    decisionNote: row.decision_note || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function timeCorrectionRows(whereSql = "", values = []) {
  return db.prepare(`
    SELECT c.*, e.full_name, e.nickname, l.name AS location_name, d.name AS department_name
    FROM time_corrections c
    JOIN employees e ON e.personnel_number = c.employee_number
    LEFT JOIN locations l ON l.id = c.location_id
    LEFT JOIN departments d ON d.id = c.department_id
    ${whereSql}
    ORDER BY c.correction_date DESC, c.created_at DESC, c.id DESC
  `).all(...values).map(serializeTimeCorrection);
}

function activeTimeEntriesForRange(employeeNumber, dateFrom, dateTo, departmentId = null) {
  return db.prepare(`
    SELECT id, employee_number, location_id, department_id, work_date, entry_type,
           entry_timestamp, source, note, created_by, correction_id, created_at
    FROM time_entries
    WHERE employee_number = ? AND work_date BETWEEN ? AND ? AND voided_at IS NULL
      AND (? IS NULL OR department_id = ?)
    ORDER BY work_date, entry_timestamp, id
  `).all(employeeNumber, dateFrom, dateTo, departmentId, departmentId);
}

function timeSummaryForEmployee(employeeNumber, dateFrom, dateTo, period = "range", now = new Date(), departmentId = null) {
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateTo < dateFrom || daysBetweenInclusive(dateFrom, dateTo) > 370) {
    throw httpError(400, "Bitte einen gültigen Auswertungszeitraum von höchstens 370 Tagen wählen.", "TIME_SUMMARY_RANGE_INVALID");
  }
  const employee = db.prepare(`
    SELECT personnel_number, full_name, nickname, color, home_location_id, preferred_department_id
    FROM employees WHERE personnel_number = ? AND active = 1
  `).get(employeeNumber);
  if (!employee) throw httpError(404, "Das aktive Teammitglied wurde nicht gefunden.");
  const entriesByDate = new Map();
  for (const entry of activeTimeEntriesForRange(employeeNumber, dateFrom, dateTo, departmentId)) {
    if (!entriesByDate.has(entry.work_date)) entriesByDate.set(entry.work_date, []);
    entriesByDate.get(entry.work_date).push(entry);
  }
  const correctionsByDate = new Map();
  for (const correction of timeCorrectionRows(
    `WHERE c.employee_number = ? AND c.correction_date BETWEEN ? AND ? AND c.status <> 'withdrawn'
       AND (? IS NULL OR c.department_id = ?)`,
    [employeeNumber, dateFrom, dateTo, departmentId, departmentId],
  )) {
    if (!correctionsByDate.has(correction.correctionDate)) correctionsByDate.set(correction.correctionDate, correction);
  }
  const days = [];
  for (let date = dateFrom; date <= dateTo; date = addDays(date, 1)) {
    const entries = entriesByDate.get(date) || [];
    const evaluation = evaluateTimeDay(employeeNumber, date, now, departmentId, entries);
    days.push({
      ...evaluation,
      date,
      workDate: date,
      entries: entries.map((entry) => ({
        id: Number(entry.id),
        type: entry.entry_type,
        label: timeEntryLabels[entry.entry_type] || entry.entry_type,
        timestamp: entry.entry_timestamp,
        source: entry.source,
      })),
      correction: correctionsByDate.get(date) || null,
    });
  }
  const totals = days.reduce((result, day) => ({
    plannedMinutes: result.plannedMinutes + day.plannedMinutes,
    actualMinutes: result.actualMinutes + day.actualMinutes,
    differenceMinutes: result.differenceMinutes + day.differenceMinutes,
    plannedValuedMinutes: result.plannedValuedMinutes + day.plannedValuedMinutes,
    actualValuedMinutes: result.actualValuedMinutes + day.actualValuedMinutes,
    valuedDifferenceMinutes: result.valuedDifferenceMinutes + day.valuedDifferenceMinutes,
    breakMinutes: result.breakMinutes + day.breakMinutes,
    saturdayBonusMinutes: result.saturdayBonusMinutes + day.saturdayBonusMinutes,
  }), {
    plannedMinutes: 0, actualMinutes: 0, differenceMinutes: 0,
    plannedValuedMinutes: 0, actualValuedMinutes: 0, valuedDifferenceMinutes: 0,
    breakMinutes: 0, saturdayBonusMinutes: 0,
  });
  return {
    period,
    from: dateFrom,
    to: dateTo,
    dateFrom,
    dateTo,
    employeeNumber: employee.personnel_number,
    fullName: employee.full_name,
    nickname: employee.nickname,
    color: employee.color,
    ...totals,
    incompleteDays: days.filter((day) => day.incomplete).length,
    issueDays: days.filter((day) => day.issues.length).length,
    reviewedDays: days.filter((day) => day.review && !day.review.stale).length,
    totals,
    days,
  };
}

function ownTimeSummary(employeeNumber, periodValue, anchorValue) {
  const period = periodValue === "month" ? "month" : "week";
  const anchor = isIsoDate(anchorValue) ? anchorValue : viennaTodayIso();
  if (period === "month") {
    const year = Number(anchor.slice(0, 4));
    const monthIndex = Number(anchor.slice(5, 7)) - 1;
    return timeSummaryForEmployee(employeeNumber, monthStart(year, monthIndex), monthEnd(year, monthIndex), period);
  }
  const from = getMonday(anchor);
  return timeSummaryForEmployee(employeeNumber, from, addDays(from, 6), period);
}

function validateProposedTimeEntries(correctionDate, entriesValue, now = new Date()) {
  const entries = Array.isArray(entriesValue) ? entriesValue.map((entry) => ({
    type: String(entry?.type || entry?.entryType || entry?.entry_type || "").trim(),
    time: String(entry?.time || "").trim().slice(0, 5),
  })) : [];
  if (!isIsoDate(correctionDate) || correctionDate > viennaTodayIso(now) || entries.length < 2 || entries.length > 24) {
    throw httpError(400, "Bitte eine vollständige Buchungsfolge mit höchstens 24 Einträgen angeben.", "TIME_CORRECTION_INVALID");
  }
  let state = "off";
  const timestamps = entries.map((entry) => {
    if (!timeEntryTypes.has(entry.type) || !isTime(entry.time) || !allowedTimeEntryActions(state).includes(entry.type)) {
      throw httpError(400, "Die Buchungsfolge muss mit Kommen beginnen, darf Pausen oder weitere Dienste enthalten und muss vollständig mit Gehen enden.", "TIME_CORRECTION_INVALID");
    }
    state = timeEntryStateFromType(entry.type);
    return viennaLocalDateTime(correctionDate, entry.time);
  });
  if (state !== "off") {
    throw httpError(400, "Die Buchungsfolge muss vollständig mit Gehen abgeschlossen werden.", "TIME_CORRECTION_INVALID");
  }
  if (timestamps.some((timestamp, index) => index > 0 && timestamp <= timestamps[index - 1])) {
    throw httpError(400, "Die Uhrzeiten müssen in einer eindeutigen zeitlichen Reihenfolge liegen.", "TIME_CORRECTION_INVALID");
  }
  if (correctionDate === viennaTodayIso(now) && timestamps.at(-1) > now) {
    throw httpError(400, "Eine Zeitkorrektur darf nicht in der Zukunft enden.", "TIME_CORRECTION_INVALID");
  }
  return entries;
}

function timeCorrectionDepartmentScope(employeeNumber, correctionDate, originalEntries = null) {
  const fallback = employeeRequestContext(employeeNumber, correctionDate);
  const entries = originalEntries || timeEntriesForDay(employeeNumber, correctionDate);
  const departmentIds = new Set(entries.map((entry) => Number(entry.department_id || 0)).filter(Boolean));
  for (const row of db.prepare(`
    SELECT DISTINCT department_id FROM shifts
    WHERE employee_number = ? AND shift_date = ? AND department_id IS NOT NULL
  `).all(employeeNumber, correctionDate)) {
    const departmentId = Number(row.department_id || 0);
    if (departmentId) departmentIds.add(departmentId);
  }
  const values = [...departmentIds].sort((left, right) => left - right);
  return {
    locationId: fallback.locationId,
    departmentId: values.length > 1 ? null : (values[0] || fallback.departmentId),
    departmentIds: values,
    crossDepartment: values.length > 1,
  };
}

function assignCorrectionEntryDepartments(employeeNumber, correctionDate, proposedEntries, fallbackDepartmentId, originalEntries = []) {
  const originalStarts = originalEntries
    .filter((entry) => entry.entry_type === "clock_in" && Number(entry.department_id || 0))
    .map((entry) => ({
      time: viennaNowLocal(new Date(entry.entry_timestamp)).slice(11, 16),
      departmentId: Number(entry.department_id),
    }));
  let activeDepartmentId = Number(fallbackDepartmentId || 0) || null;
  return proposedEntries.map((entry) => {
    if (entry.type === "clock_in") {
      const scheduledDepartmentId = scheduledTimeEntryDepartment(employeeNumber, correctionDate, entry.time);
      const closestOriginal = originalStarts
        .map((candidate) => ({ ...candidate, distance: Math.abs(timeToMinutes(candidate.time) - timeToMinutes(entry.time)) }))
        .sort((left, right) => left.distance - right.distance)[0];
      activeDepartmentId = scheduledDepartmentId || closestOriginal?.departmentId || activeDepartmentId;
    }
    const assigned = { ...entry, departmentId: activeDepartmentId };
    if (entry.type === "clock_out") activeDepartmentId = null;
    return assigned;
  });
}

function validateOwnTimeCorrection(employeeNumber, body = {}, existingId = null) {
  const correctionDate = String(body.correctionDate || body.date || "").trim();
  const requestedEntries = body.requestedEntries || body.proposedEntries || body.entries;
  const entries = validateProposedTimeEntries(correctionDate, requestedEntries);
  const requestNote = stripEmoji(String(body.reason ?? body.note ?? "").trim()).slice(0, 500);
  const duplicate = db.prepare(`
    SELECT id FROM time_corrections
    WHERE employee_number = ? AND correction_date = ? AND status = 'pending' AND id <> ?
    LIMIT 1
  `).get(employeeNumber, correctionDate, Number(existingId || 0));
  if (duplicate) throw httpError(409, "Für diesen Tag besteht bereits ein offener Korrekturantrag.", "TIME_CORRECTION_PENDING_EXISTS");
  const originals = timeEntriesForDay(employeeNumber, correctionDate);
  const context = timeCorrectionDepartmentScope(employeeNumber, correctionDate, originals);
  return {
    correctionDate,
    entries,
    requestNote,
    context,
    requestedChange: {
      proposedEntries: entries,
      entries,
      note: requestNote,
      crossDepartment: context.crossDepartment,
      departmentIds: context.departmentIds,
      originalEntryIds: originals.map((entry) => Number(entry.id)),
      originalEntries: originals.map((entry) => ({
        id: Number(entry.id),
        type: entry.entry_type,
        timestamp: entry.entry_timestamp,
        departmentId: Number(entry.department_id || 0) || null,
      })),
    },
  };
}

function notifyTimeCorrectionReviewers(correction, actor = "") {
  for (const recipient of requestReviewerRecipients(correction.locationId, correction.departmentId, "local", actor)) {
    createPortalNotification(recipient, "time_correction.review", "Zeitkorrektur wartet auf Prüfung", `${correction.employeeNumber} hat eine Zeitkorrektur beantragt.`, {
      target: "/portal.html?tab=approvals",
      entityType: "time_correction",
      entityId: correction.id,
      dedupeKey: `time_correction:${correction.id}:review`,
    });
  }
}

function createOwnTimeCorrection(session, body) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const input = validateOwnTimeCorrection(session.employeeNumber, body);
    const result = db.prepare(`
      INSERT INTO time_corrections
        (employee_number, location_id, department_id, correction_date, requested_change, request_note, status, requested_by)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(session.employeeNumber, input.context.locationId, input.context.departmentId, input.correctionDate,
      JSON.stringify(input.requestedChange), input.requestNote, session.employeeNumber);
    db.prepare("DELETE FROM time_day_reviews WHERE employee_number = ? AND work_date = ?")
      .run(session.employeeNumber, input.correctionDate);
    auditPortal(session.employeeNumber, "time.correction.request", "time_correction", String(result.lastInsertRowid), JSON.stringify(input.requestedChange));
    db.exec("COMMIT");
    const correction = timeCorrectionRows("WHERE c.id = ?", [Number(result.lastInsertRowid)])[0];
    notifyTimeCorrectionReviewers(correction, session.employeeNumber);
    return correction;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function updateOwnTimeCorrection(session, idValue, body) {
  const id = Number(idValue);
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare("SELECT id, employee_number, correction_date, status FROM time_corrections WHERE id = ?").get(id);
    if (!existing || existing.employee_number !== session.employeeNumber) throw httpError(404, "Der Korrekturantrag wurde nicht gefunden.");
    if (existing.status !== "pending") throw httpError(409, "Nur ein offener Korrekturantrag kann bearbeitet werden.", "TIME_CORRECTION_STATE_CONFLICT");
    const input = validateOwnTimeCorrection(session.employeeNumber, body, id);
    db.prepare(`
      UPDATE time_corrections
      SET location_id = ?, department_id = ?, correction_date = ?, requested_change = ?, request_note = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending'
    `).run(input.context.locationId, input.context.departmentId, input.correctionDate, JSON.stringify(input.requestedChange), input.requestNote, id);
    db.prepare("DELETE FROM time_day_reviews WHERE employee_number = ? AND work_date IN (?, ?)")
      .run(session.employeeNumber, existing.correction_date || input.correctionDate, input.correctionDate);
    auditPortal(session.employeeNumber, "time.correction.update", "time_correction", String(id), JSON.stringify(input.requestedChange));
    db.exec("COMMIT");
    return timeCorrectionRows("WHERE c.id = ?", [id])[0];
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function withdrawOwnTimeCorrection(session, idValue) {
  const id = Number(idValue);
  const existing = db.prepare("SELECT employee_number, correction_date FROM time_corrections WHERE id = ?").get(id);
  const result = db.prepare(`
    UPDATE time_corrections SET status = 'withdrawn', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND employee_number = ? AND status = 'pending'
  `).run(id, session.employeeNumber);
  if (!result.changes) throw httpError(409, "Der Korrekturantrag wurde bereits bearbeitet oder nicht gefunden.", "TIME_CORRECTION_STATE_CONFLICT");
  if (existing) invalidateTimeDayReview(existing.employee_number, existing.correction_date);
  auditPortal(session.employeeNumber, "time.correction.withdraw", "time_correction", String(id));
}

function decideTimeCorrection(session, idValue, body = {}, now = new Date()) {
  const id = Number(idValue);
  const action = String(body.action || body.decision || "").toLowerCase();
  if (!Number.isInteger(id) || !["approve", "approved", "reject", "rejected"].includes(action)) {
    throw httpError(400, "Bitte eine gültige Entscheidung auswählen.", "TIME_CORRECTION_DECISION_INVALID");
  }
  const approved = action === "approve" || action === "approved";
  const decisionNote = stripEmoji(String(body.decisionNote ?? body.note ?? "").trim()).slice(0, 500);
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT * FROM time_corrections WHERE id = ?").get(id);
    if (!row) throw httpError(404, "Der Korrekturantrag wurde nicht gefunden.");
    if (row.status !== "pending") throw httpError(409, "Der Korrekturantrag wurde bereits entschieden.", "TIME_CORRECTION_STATE_CONFLICT");
    const requestedChange = parseTimeCorrectionChange(row.requested_change);
    const activeRows = timeEntriesForDay(row.employee_number, row.correction_date);
    const currentScope = timeCorrectionDepartmentScope(row.employee_number, row.correction_date, activeRows);
    const storedDepartmentIds = new Set((requestedChange.departmentIds || []).map(Number).filter(Boolean));
    const crossDepartment = requestedChange.crossDepartment === true || storedDepartmentIds.size > 1
      || currentScope.crossDepartment;
    const fallbackContext = employeeRequestContext(row.employee_number, row.correction_date);
    const correctionContext = {
      locationId: row.location_id || fallbackContext.locationId,
      departmentId: crossDepartment ? null : (Number(row.department_id || 0) || currentScope.departmentId || fallbackContext.departmentId),
    };
    assertSessionContextScope(session, correctionContext);
    if (!row.location_id || (!crossDepartment && !row.department_id && correctionContext.departmentId)) {
      db.prepare("UPDATE time_corrections SET location_id = ?, department_id = ? WHERE id = ?")
        .run(correctionContext.locationId, correctionContext.departmentId, id);
    }
    let decidedEntries = requestedChange.proposedEntries || requestedChange.entries || [];
    if (approved) {
      decidedEntries = validateProposedTimeEntries(row.correction_date, body.entries || body.proposedEntries || decidedEntries, now);
      const originalIds = (requestedChange.originalEntryIds || []).map(Number).sort((left, right) => left - right);
      const activeIds = activeRows.map((entry) => Number(entry.id)).sort((left, right) => left - right);
      if (JSON.stringify(originalIds) !== JSON.stringify(activeIds)) {
        throw httpError(409, "Die Originalbuchungen wurden seit dem Antrag verändert. Bitte einen neuen Korrekturantrag stellen.", "TIME_CORRECTION_SOURCE_CHANGED");
      }
      db.prepare(`
        UPDATE time_entries
        SET voided_at = CURRENT_TIMESTAMP, voided_by = ?, void_reason = ?, correction_id = ?
        WHERE employee_number = ? AND work_date = ? AND voided_at IS NULL
      `).run(session.employeeNumber, `Ersetzt durch genehmigte Zeitkorrektur ${id}`, id, row.employee_number, row.correction_date);
      const insert = db.prepare(`
        INSERT INTO time_entries
          (employee_number, location_id, department_id, work_date, entry_type, entry_timestamp, source, note, created_by, correction_id)
        VALUES (?, ?, ?, ?, ?, ?, 'manager_correction', ?, ?, ?)
      `);
      const assignedEntries = assignCorrectionEntryDepartments(
        row.employee_number,
        row.correction_date,
        decidedEntries,
        correctionContext.departmentId,
        activeRows,
      );
      for (const entry of assignedEntries) {
        insert.run(row.employee_number, correctionContext.locationId, entry.departmentId, row.correction_date, entry.type,
          viennaLocalDateTime(row.correction_date, entry.time).toISOString(), decisionNote, session.employeeNumber, id);
      }
      db.prepare("DELETE FROM time_day_reviews WHERE employee_number = ? AND work_date = ?")
        .run(row.employee_number, row.correction_date);
    }
    if (!approved) invalidateTimeDayReview(row.employee_number, row.correction_date);
    const status = approved ? "approved" : "rejected";
    const result = db.prepare(`
      UPDATE time_corrections
      SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP, decision_note = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending'
    `).run(status, session.employeeNumber, decisionNote, id);
    if (!result.changes) throw httpError(409, "Der Korrekturantrag wurde bereits entschieden.", "TIME_CORRECTION_STATE_CONFLICT");
    auditPortal(session.employeeNumber, `time.correction.${status}`, "time_correction", String(id), JSON.stringify({ decisionNote, entries: decidedEntries }));
    db.exec("COMMIT");
    db.prepare("UPDATE portal_notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP) WHERE entity_type = 'time_correction' AND entity_id = ?").run(String(id));
    createPortalNotification(row.employee_number, "time_correction.decision", `Zeitkorrektur ${approved ? "genehmigt" : "abgelehnt"}`, `Bearbeitet von Personalnummer ${session.employeeNumber}.`, {
      target: "/portal.html?tab=time", entityType: "time_correction", entityId: id,
      dedupeKey: `time_correction:${id}:${status}:${session.employeeNumber}`,
    });
    return timeCorrectionRows("WHERE c.id = ?", [id])[0];
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

const mobileLeadershipModules = Object.freeze([
  { id: "timeTracking", label: "Zeiterfassung" },
  { id: "team", label: "Team heute" },
  { id: "approvals", label: "Freigaben" },
  { id: "schedule", label: "Mein Dienstplan" },
  { id: "requests", label: "Meine Anträge" },
  { id: "more", label: "Mehr" },
]);
const mobileLeadershipModuleIds = new Set(mobileLeadershipModules.map((module) => module.id));

function mobileLeadershipLayouts() {
  const fallback = JSON.parse(defaultPortalSettings.mobile_leadership_layouts);
  try {
    const value = JSON.parse(getPortalSettings().mobile_leadership_layouts || "{}");
    for (const role of ["department_manager", "manager", "hr", "admin", "it_admin", "developer"]) {
      const requested = Array.isArray(value[role]) ? value[role].filter((id) => mobileLeadershipModuleIds.has(id)) : [];
      const modules = ["timeTracking", ...requested.filter((id) => id !== "timeTracking")];
      fallback[role] = [...new Set(modules)].slice(0, 6);
    }
  } catch {}
  return fallback;
}

function mobileModuleAllowedForSession(session, id) {
  const permissions = session.permissions || [];
  if (id === "timeTracking") return permissions.includes("own_time:read");
  if (id === "team") return permissions.includes("time:read");
  if (id === "approvals") return permissions.some((permission) => ["vacation:read", "vacation:approve", "time:review", "amu:metadata:read", "amu:review", "sickness:read"].includes(permission));
  if (id === "schedule") return permissions.includes("own_schedule:read");
  if (id === "requests") return permissions.some((permission) => ["own_vacation:read", "own_vacation:request", "own_time:read", "own_time:correction_request"].includes(permission));
  return id === "more";
}

function mobileLayoutPayload(session) {
  const layouts = mobileLeadershipLayouts();
  const roleLayout = layouts[session.role] || layouts.manager;
  const modules = roleLayout.filter((id) => mobileModuleAllowedForSession(session, id));
  return {
    modules,
    availableModules: mobileLeadershipModules,
    layouts,
    canChange: session.employeeNumber === "local" || RIGHTS_ADMIN_PORTAL_ROLES.has(session.role),
  };
}

function validateMobileLeadershipLayouts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "Bitte eine gültige Auswahl für die mobile Leitungsansicht übermitteln.", "MOBILE_LAYOUT_INVALID");
  }
  const result = mobileLeadershipLayouts();
  for (const role of ["department_manager", "manager", "hr", "admin", "it_admin", "developer"]) {
    const requested = Array.isArray(value[role]) ? value[role].map(String) : result[role];
    if (requested.some((id) => !mobileLeadershipModuleIds.has(id))) {
      throw httpError(400, "Die mobile Leitungsansicht enthält ein unbekanntes Element.", "MOBILE_LAYOUT_INVALID");
    }
    result[role] = [...new Set(["timeTracking", ...requested.filter((id) => id !== "timeTracking")])].slice(0, 6);
  }
  return result;
}

function greetingWorkdays(employeeNumber, endedOn, today, wanted = 12) {
  if (!isIsoDate(endedOn) || !isIsoDate(today)) return [];
  const horizon = [addDays(endedOn, 60), addDays(today, 30)].sort().at(-1);
  const planned = db.prepare(`
    SELECT DISTINCT shift_date FROM shifts
    WHERE employee_number = ? AND shift_date > ? AND shift_date <= ?
    ORDER BY shift_date
  `).all(employeeNumber, endedOn, horizon).map((row) => row.shift_date);
  if (planned.length) return planned.slice(0, wanted);

  const employee = db.prepare("SELECT home_location_id FROM employees WHERE personnel_number = ?").get(employeeNumber);
  let locationSettings = null;
  let locationContext = null;
  if (employee?.home_location_id) {
    try {
      locationSettings = settingsForLocation(employee.home_location_id);
      locationContext = resolvePlanningContext({ locationId: employee.home_location_id });
    } catch {}
  }
  const fallback = [];
  for (let date = addDays(endedOn, 1), attempts = 0; attempts < 90 && fallback.length < wanted; date = addDays(date, 1), attempts += 1) {
    let workingDay = false;
    if (locationSettings && locationContext) {
      try { workingDay = dayConfiguration(date, locationSettings, locationContext)?.open === true; } catch {}
    } else {
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
      workingDay = weekday >= 1 && weekday <= 6;
    }
    if (workingDay) fallback.push(date);
  }
  return fallback;
}

function portalGreetingContext(session, now = new Date()) {
  const today = viennaTodayIso(now);
  const settings = portalGreetingSettings();
  const recentVacation = approvedVacationsForEmployee(session.employeeNumber, addDays(today, -120))
    .filter((entry) => isIsoDate(entry.dateFrom) && isIsoDate(entry.dateTo) && entry.dateTo < today)
    .sort((left, right) => right.dateTo.localeCompare(left.dateTo))[0] || null;
  const vacation = recentVacation ? {
    startedOn: recentVacation.dateFrom,
    endedOn: recentVacation.dateTo,
    returnWorkdays: greetingWorkdays(session.employeeNumber, recentVacation.dateTo, today),
  } : null;

  let sickness = null;
  try {
    const cases = ownSicknessCases(session.employeeNumber);
    const active = cases.find((entry) => ["reported", "aum_received"].includes(entry.status) && entry.start_date <= today);
    if (active) {
      sickness = { active: true };
    } else {
      const recovered = cases
        .filter((entry) => entry.status === "recovered" && isIsoDate(entry.return_to_work_date) && entry.return_to_work_date <= today)
        .sort((left, right) => right.return_to_work_date.localeCompare(left.return_to_work_date))[0];
      if (recovered) {
        const endedOn = addDays(recovered.return_to_work_date, -1);
        sickness = {
          active: false,
          endedOn,
          returnWorkdays: greetingWorkdays(session.employeeNumber, endedOn, today),
        };
      }
    }
  } catch {
    sickness = null;
  }

  const displayName = String(session.nickname || session.fullName || "").trim().split(/\s+/)[0] || "du";
  return {
    at: now,
    stableKey: session.employeeNumber,
    name: displayName,
    settings,
    vacation,
    sickness,
  };
}

function portalGreetingForSession(session, now = new Date()) {
  return resolvePortalGreeting(portalGreetingContext(session, now));
}

const mobileNavigationLabels = Object.freeze({
  timeTracking: "Zeiterfassung",
  team: "Team heute",
  approvals: "Freigaben",
  schedule: "Mein Dienstplan",
  requests: "Meine Anträge",
  sicknessAndAmu: "Krankmeldung & AUM",
  notifications: "Benachrichtigungen",
  settings: "Einstellungen",
  more: "Mehr",
});

function mobileApiStatus(now = new Date()) {
  const status = getPortalStatus();
  const nativeAuthentication = mobileNativeAuthenticationAvailable();
  return {
    appName: APP_NAME,
    serverVersion: packageMetadata.version,
    apiVersion: 1,
    minimumMobileVersion: MOBILE_MINIMUM_APP_VERSION,
    serverTime: now.toISOString(),
    deploymentKind: status.deploymentKind,
    operationMode: status.operationMode,
    portalEnabled: status.portalEnabled,
    nativeAuthentication,
    passwordMinLength: status.passwordMinLength,
    capabilities: {
      timeTracking: status.capabilities.timeTracking,
      schedule: status.capabilities.ownSchedule,
      absenceRequests: status.capabilities.vacationRequests && status.capabilities.timeOffRequests,
      sicknessAndAmu: status.capabilities.sicknessReports && status.capabilities.amuReports,
      notifications: status.capabilities.notifications,
      pushNotifications: false,
      personalSettingsRead: true,
      personalSettingsWrite: nativeAuthentication,
      personalizedGreetings: portalGreetingSettings().enabled,
    },
  };
}

function mobileUserPayload(session) {
  return {
    employeeNumber: session.employeeNumber,
    fullName: session.fullName || "",
    nickname: session.nickname || "",
    displayName: session.nickname || session.fullName || session.employeeNumber,
    color: session.color || "#276e55",
    homeLocationId: session.homeLocationId || "",
    role: { id: session.role, name: session.roleName || session.role },
    position: { id: session.positionId == null ? null : Number(session.positionId), name: session.positionName || "" },
    mustChangePassword: Boolean(session.mustChangePassword),
  };
}

function mobileNavigationPayload(session, status = getPortalStatus()) {
  const permissions = session.permissions || [];
  let modules;
  if (["department_manager", "manager", "hr", "admin", "it_admin", "developer"].includes(session.role)) {
    modules = mobileLayoutPayload(session).modules;
  } else {
    modules = [
      status.capabilities.timeTracking && permissions.includes("own_time:read") ? "timeTracking" : "",
      permissions.includes("own_schedule:read") ? "schedule" : "",
      permissions.some((permission) => ["own_vacation:read", "own_vacation:request", "own_time:correction_request"].includes(permission)) ? "requests" : "",
      permissions.some((permission) => ["own_sickness:create", "own_amu:create", "own_amu:read"].includes(permission)) ? "sicknessAndAmu" : "",
      "settings",
    ].filter(Boolean);
  }
  const normalized = [...new Set(modules)].filter((id) => mobileNavigationLabels[id] && id !== "settings").slice(0, 6);
  normalized.unshift("settings");
  return {
    defaultModule: normalized.includes("timeTracking") ? "timeTracking" : (normalized[0] || "settings"),
    items: normalized.map((id) => ({ id, label: mobileNavigationLabels[id], badgeCount: null })),
  };
}

function mobilePersonalSettingsPayload(session, now = new Date()) {
  const user = db.prepare("SELECT password_changed_at FROM portal_users WHERE employee_number = ?").get(session.employeeNumber) || {};
  const policy = getWifiAutomationPolicy();
  let wifi = null;
  try { wifi = wifiAutomationEmployeePayload(session, now); } catch {}
  return {
    password: {
      mustChange: Boolean(session.mustChangePassword),
      minimumLength: portalPasswordMinLength(),
      lastChangedAt: user.password_changed_at || null,
    },
    wifiTimeSuggestions: {
      available: Boolean(wifi && (wifi.canEnable || wifi.preference?.enabled)),
      enabled: Boolean(wifi?.preference?.enabled),
      confirmationLevel: wifi?.confirmationLevelVisible ? wifi.confirmationLevel : null,
      confirmationLevelVisible: Boolean(wifi?.confirmationLevelVisible),
      trustLevelsEnabled: Boolean(wifi?.trustLevelsEnabled),
      minimumPresenceMinutes: policy.minimumPresenceMinutes,
      absenceGraceMinutes: policy.absenceGraceMinutes,
    },
  };
}

function mobileHomePayload(session, request = null, now = new Date()) {
  const date = viennaTodayIso(now);
  let timeTracking = {
    enabled: false,
    accessAllowed: false,
    state: "off",
    stateSince: null,
    allowedActions: [],
    reason: "Die Zeiterfassung ist für diesen Zugang nicht verfügbar.",
  };
  if (session.permissions?.includes("own_time:read")) {
    try {
      const context = employeeRequestContext(session.employeeNumber, date);
      const location = validateLocationExists(context.locationId);
      const access = request ? timeTrackingRequestAccess(request, location) : undefined;
      const day = timeTrackingDayStatus(session.employeeNumber, date, now, access ? { access } : {});
      timeTracking = {
        enabled: Boolean(day.enabled),
        accessAllowed: Boolean(day.accessAllowed),
        state: day.state,
        stateSince: day.stateSince || null,
        allowedActions: session.permissions?.includes("own_time:write") ? (day.allowedActions || []) : [],
        reason: day.reason || "",
      };
    } catch {}
  }
  const greeting = portalGreetingForSession(session, now);
  const unreadNotificationCount = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM portal_notifications
    WHERE recipient_employee_number = ? AND read_at IS NULL
  `).get(session.employeeNumber)?.count || 0);
  return {
    date,
    timezone: "Europe/Vienna",
    greeting: {
      id: greeting.id,
      kind: greeting.kind,
      text: greeting.text,
      validUntil: greeting.validUntil,
      enabled: greeting.enabled,
    },
    timeTracking,
    unreadNotificationCount,
  };
}

function mobileBootstrapPayload(session, request = null, now = new Date()) {
  const portalStatus = portalStatusForSession(session);
  return {
    generatedAt: now.toISOString(),
    status: mobileApiStatus(now),
    user: mobileUserPayload(session),
    branding: mobileBrandingPayload(session),
    navigation: mobileNavigationPayload(session, portalStatus),
    home: mobileHomePayload(session, request, now),
    settings: mobilePersonalSettingsPayload(session, now),
  };
}

function leadershipOverviewForContext(session, context, now = new Date()) {
  const presence = timePresenceForContext(session, context, viennaTodayIso(now), now);
  const stateCounts = presence.employees.reduce((counts, employee) => {
    counts[employee.state] = (counts[employee.state] || 0) + 1;
    return counts;
  }, {});
  const corrections = timeCorrectionRows(`
    WHERE c.status = 'pending' AND c.location_id = ?
      AND (? IS NULL OR c.department_id = ?)
  `, [context.locationId, context.departmentId, context.departmentId])
    .filter((correction) => {
      try {
        assertSessionContextScope(session, correction);
        return true;
      } catch {
        return false;
      }
    });
  const pendingAbsenceRows = db.prepare(`
    SELECT employee_number, date_from AS request_date
    FROM vacation_requests
    WHERE location_id = ? AND status IN ('pending','pending_local','preliminary_local','pending_hr')
    UNION ALL
    SELECT employee_number, COALESCE(date_from, request_date) AS request_date
    FROM time_off_requests
    WHERE location_id = ? AND status IN ('pending','pending_local','preliminary_local','pending_hr')
  `).all(context.locationId, context.locationId);
  const absenceCount = pendingAbsenceRows.filter((entry) => !context.departmentId
    || Number(employeeRequestContext(entry.employee_number, entry.request_date).departmentId || 0) === Number(context.departmentId)).length;
  const amuCount = db.prepare(`
    SELECT COUNT(*) AS count FROM amu_reports
    WHERE location_id = ? AND status IN ('submitted','returned')
      AND (? IS NULL OR department_id = ?)
  `).get(context.locationId, context.departmentId, context.departmentId)?.count || 0;
  return {
    date: presence.date,
    context,
    presence,
    counts: {
      working: Number(stateCounts.working || 0),
      paused: Number(stateCounts.paused || 0),
      attention: Number(stateCounts.attention || 0),
      off: Number(stateCounts.off || 0),
      absenceRequests: Number(absenceCount),
      amuReports: Number(amuCount),
      timeCorrections: corrections.length,
    },
    timeCorrections: corrections,
  };
}

function serializeRequestBlackout(row) {
  return {
    id: Number(row.id),
    locationId: row.location_id,
    locationName: row.location_name || "",
    departmentId: row.department_id ? Number(row.department_id) : null,
    departmentName: row.department_name || "",
    dateFrom: row.date_from,
    dateTo: row.date_to,
    blockVacation: Boolean(row.block_vacation),
    blockTimeOff: Boolean(row.block_time_off),
    reason: row.reason || "",
    active: Boolean(row.active),
    createdBy: row.created_by || "",
  };
}

function getRequestBlackouts(activeOnly = false) {
  return db.prepare(`
    SELECT b.*, l.name AS location_name, d.name AS department_name
    FROM request_blackouts b
    JOIN locations l ON l.id = b.location_id
    LEFT JOIN departments d ON d.id = b.department_id
    ${activeOnly ? "WHERE b.active = 1" : ""}
    ORDER BY b.active DESC, b.date_from, b.location_id, b.department_id
  `).all().map(serializeRequestBlackout);
}

function getRequestBlackoutsForSession(session, activeOnly = false) {
  const blackouts = getRequestBlackouts(activeOnly);
  if (sessionHasGlobalScope(session)) return blackouts;
  return blackouts.filter((blackout) => (session.scopes || []).some((scope) => scope.locationId === blackout.locationId
    && (session.role !== "department_manager" || Number(scope.departmentId) === Number(blackout.departmentId || 0))));
}

function validateRequestBlackout(body, existingId = 0) {
  const locationId = normalizeLocationId(body.locationId || body.location_id || "");
  const departmentId = normalizeDepartmentId(body.departmentId ?? body.department_id, true);
  const dateFrom = String(body.dateFrom || body.date_from || "");
  const dateTo = String(body.dateTo || body.date_to || "");
  const blockVacation = body.blockVacation !== false;
  const blockTimeOff = body.blockTimeOff === true;
  const reason = stripEmoji(String(body.reason || "").trim()).slice(0, 240);
  const active = body.active !== false;
  validateLocationExists(locationId);
  if (departmentId) validateDepartmentExists(departmentId, locationId);
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateTo < dateFrom) {
    throw httpError(400, "Bitte einen gültigen Sperrzeitraum eingeben.");
  }
  if (!blockVacation && !blockTimeOff) throw httpError(400, "Bitte Urlaub, Zeitausgleich oder beides sperren.");
  const duplicate = db.prepare(`
    SELECT id FROM request_blackouts
    WHERE id <> ? AND location_id = ? AND COALESCE(department_id, 0) = COALESCE(?, 0)
      AND date_from = ? AND date_to = ? AND block_vacation = ? AND block_time_off = ?
  `).get(Number(existingId || 0), locationId, departmentId, dateFrom, dateTo, blockVacation ? 1 : 0, blockTimeOff ? 1 : 0);
  if (duplicate) throw httpError(409, "Diese Antragssperre besteht bereits.");
  return { locationId, departmentId, dateFrom, dateTo, blockVacation, blockTimeOff, reason, active };
}

function findRequestBlackout(employeeNumber, requestType, dateFrom, dateTo, dateForDepartment = null) {
  const context = employeeRequestContext(employeeNumber, dateForDepartment || dateFrom);
  const typeColumn = requestType === "time_off" ? "block_time_off" : "block_vacation";
  const rows = db.prepare(`
    SELECT b.*, l.name AS location_name, d.name AS department_name
    FROM request_blackouts b
    JOIN locations l ON l.id = b.location_id
    LEFT JOIN departments d ON d.id = b.department_id
    WHERE b.active = 1 AND b.location_id = ? AND b.${typeColumn} = 1
      AND b.date_from <= ? AND b.date_to >= ?
      AND (b.department_id IS NULL OR b.department_id = ?)
    ORDER BY CASE WHEN b.department_id IS NULL THEN 1 ELSE 0 END, b.date_from
  `).all(context.locationId, dateTo, dateFrom, context.departmentId);
  return rows[0] ? serializeRequestBlackout(rows[0]) : null;
}

function requestBlackoutReason(blackout, requestLabel) {
  const scope = blackout.departmentName ? `Abteilung ${blackout.departmentName}` : `Filiale ${blackout.locationName}`;
  const reason = blackout.reason ? `: ${blackout.reason}` : ".";
  return `${requestLabel} ist von ${blackout.dateFrom} bis ${blackout.dateTo} für ${scope} gesperrt${reason}`;
}

function evaluateVacationRequest(employeeNumber, body) {
  const dateFrom = String(body.dateFrom || "");
  const dateTo = String(body.dateTo || "");
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateTo < dateFrom) {
    return { trafficLight: "red", allowed: false, reason: "Bitte einen gültigen Urlaubszeitraum eingeben." };
  }
  const blackout = findRequestBlackout(employeeNumber, "vacation", dateFrom, dateTo);
  if (blackout) return { trafficLight: "red", allowed: false, reason: requestBlackoutReason(blackout, "Urlaub") };
  return { trafficLight: "green", allowed: true, reason: "Für diesen Zeitraum besteht keine Antragssperre." };
}

function staffingCountAt(locationId, departmentId, date, pointTime, excludedEmployeeNumber) {
  const departmentClause = departmentId ? "AND s.department_id = ?" : "";
  const values = departmentId
    ? [date, locationId, pointTime, pointTime, excludedEmployeeNumber, departmentId]
    : [date, locationId, pointTime, pointTime, excludedEmployeeNumber];
  return Number(db.prepare(`
    SELECT COUNT(DISTINCT s.employee_number) AS count
    FROM shifts s JOIN employees e ON e.personnel_number = s.employee_number
    WHERE s.shift_date = ? AND e.home_location_id = ?
      AND s.start_time <= ? AND s.end_time > ? AND s.employee_number <> ?
      ${departmentClause}
  `).get(...values).count || 0);
}

function evaluateTimeOffRequest(employeeNumber, body) {
  const date = String(body.date || body.requestDate || body.dateFrom || "");
  const dateTo = String(body.dateTo || date);
  const allDay = body.allDay === true || dateTo !== date;
  const startTime = String(body.startTime || "");
  const endTime = String(body.endTime || "");
  if (!isIsoDate(date) || !isIsoDate(dateTo) || dateTo < date) {
    return { trafficLight: "red", allowed: false, reason: "Bitte einen gültigen ZA-Zeitraum eingeben." };
  }
  if (date < viennaTodayIso()) return { trafficLight: "red", allowed: false, reason: "Für vergangene Tage kann kein Zeitausgleich beantragt werden." };
  if (allDay) {
    const blackout = findRequestBlackout(employeeNumber, "time_off", date, dateTo, date);
    if (blackout) return { trafficLight: "red", allowed: false, reason: requestBlackoutReason(blackout, "Zeitausgleich") };
    const overlap = db.prepare(`SELECT id FROM time_off_requests WHERE employee_number = ?
      AND status IN ('pending','pending_local','preliminary_local','pending_hr','approved') AND id <> ?
      AND COALESCE(date_from, request_date) <= ? AND COALESCE(date_to, request_date) >= ? LIMIT 1`)
      .get(employeeNumber, Number(body.excludeRequestId || 0), dateTo, date);
    if (overlap) return { trafficLight: "red", allowed: false, reason: "Für diesen Zeitraum besteht bereits ein ZA-Antrag." };
    const missingDays = [];
    for (let current = date; current <= dateTo; current = addDays(current, 1)) {
      const context = employeeRequestContext(employeeNumber, current);
      if (!operatingHours(current, settingsForLocation(context.locationId))) {
        return { trafficLight: "red", allowed: false, reason: `Am ${current} ist die Filiale geschlossen; dafür kann kein ganztägiger ZA beantragt werden.` };
      }
      const globalBlock = getGlobalDayBlockForDate(current, context.locationId);
      if (globalBlock) return { trafficLight: "red", allowed: false, reason: `Der ${current} ist bereits gesperrt: ${globalBlock.reason || globalBlock.holiday_name || "gesperrt"}.` };
      const planned = db.prepare("SELECT 1 FROM shifts WHERE employee_number = ? AND shift_date = ? LIMIT 1").get(employeeNumber, current);
      if (!planned) missingDays.push(current);
    }
    return { trafficLight: "yellow", allowed: true, reason: missingDays.length
      ? "Der ganztägige ZA kann beantragt werden; der Dienstplan ist für mindestens einen Tag noch unvollständig und wird manuell geprüft."
      : "Der ganztägige ZA wird unabhängig von der Vorprüfung immer zur Genehmigung eingereicht." };
  }
  if (!isIsoDate(date) || !isTime(startTime) || !isTime(endTime) || endTime <= startTime) {
    return { trafficLight: "red", allowed: false, reason: "Bitte Datum und Uhrzeit für den Zeitausgleich vollständig eingeben." };
  }
  if (timeToMinutes(endTime) - timeToMinutes(startTime) < 15) {
    return { trafficLight: "red", allowed: false, reason: "Zeitausgleich muss mindestens 15 Minuten dauern." };
  }
  const context = employeeRequestContext(employeeNumber, date);
  const blackout = findRequestBlackout(employeeNumber, "time_off", date, date, date);
  if (blackout) return { trafficLight: "red", allowed: false, reason: requestBlackoutReason(blackout, "Zeitausgleich") };
  const settings = settingsForLocation(context.locationId);
  const hours = operatingHours(date, settings);
  if (!hours) return { trafficLight: "red", allowed: false, reason: "An diesem Tag ist die Filiale geschlossen." };
  if (startTime < hours.start || endTime > hours.end) {
    return { trafficLight: "red", allowed: false, reason: `Der Zeitraum liegt außerhalb der Öffnungszeit ${hours.start}–${hours.end} Uhr.` };
  }
  const globalBlock = getGlobalDayBlockForDate(date, context.locationId);
  if (globalBlock) {
    return { trafficLight: "red", allowed: false, reason: `Dieser Tag ist gesperrt: ${globalBlock.reason || globalBlock.holiday_name || "gesperrt"}.` };
  }
  const conflictingOption = db.prepare(`
    SELECT option_type, note, all_day, start_time, end_time, group_id FROM week_options
    WHERE employee_number = ? AND ? BETWEEN date_from AND date_to
  `).all(employeeNumber, date).find((option) => option.group_id !== `za-request-${Number(body.excludeRequestId || 0)}`
    && optionOverlapsTime(option, startTime, endTime));
  if (conflictingOption) {
    return { trafficLight: "red", allowed: false, reason: `Zu dieser Zeit ist bereits „${optionLabel(conflictingOption.option_type)}“ eingetragen.` };
  }
  const pendingOverlap = db.prepare(`
    SELECT id FROM time_off_requests
    WHERE employee_number = ? AND ? BETWEEN COALESCE(date_from, request_date) AND COALESCE(date_to, request_date)
      AND status IN ('pending','pending_local','preliminary_local','pending_hr','approved') AND id <> ?
      AND (all_day = 1 OR (start_time < ? AND ? < end_time)) LIMIT 1
  `).get(employeeNumber, date, Number(body.excludeRequestId || 0), endTime, startTime);
  if (pendingOverlap) return { trafficLight: "red", allowed: false, reason: "Für diesen Zeitraum besteht bereits ein offener ZA-Antrag." };
  const coveringShift = db.prepare(`
    SELECT * FROM shifts
    WHERE employee_number = ? AND shift_date = ? AND start_time <= ? AND end_time >= ?
    ORDER BY start_time LIMIT 1
  `).get(employeeNumber, date, startTime, endTime);
  const overlappingShift = db.prepare(`
    SELECT * FROM shifts
    WHERE employee_number = ? AND shift_date = ? AND start_time < ? AND ? < end_time
    ORDER BY start_time LIMIT 1
  `).get(employeeNumber, date, endTime, startTime);
  if (!coveringShift && overlappingShift) {
    return { trafficLight: "red", allowed: false, reason: `Der gewünschte Zeitraum liegt nicht vollständig innerhalb des Dienstes ${overlappingShift.start_time}–${overlappingShift.end_time} Uhr.` };
  }
  if (!coveringShift) {
    return { trafficLight: "yellow", allowed: true, reason: "Für diesen Zeitraum ist noch kein Dienst eingetragen. Der Antrag wird manuell geprüft." };
  }
  const locationContext = resolvePlanningContext({ locationId: context.locationId, departmentId: null });
  const locationRequired = Number(dayConfiguration(date, settings, locationContext)?.minStaff || 0);
  const departmentId = coveringShift.department_id ? Number(coveringShift.department_id) : context.departmentId;
  const departmentRequired = departmentId
    ? Number(db.prepare("SELECT min_staff FROM departments WHERE id = ?").get(departmentId)?.min_staff || 0)
    : 0;
  for (let minute = timeToMinutes(startTime); minute < timeToMinutes(endTime); minute += 15) {
    const point = minutesToTime(minute);
    const locationCount = staffingCountAt(context.locationId, null, date, point, employeeNumber);
    if (locationCount < locationRequired) {
      return { trafficLight: "red", allowed: false, reason: `Um ${point} Uhr würde die Filial-Mindestbesetzung auf ${locationCount} von ${locationRequired} Personen sinken.` };
    }
    if (departmentId && departmentRequired > 0) {
      const departmentCount = staffingCountAt(context.locationId, departmentId, date, point, employeeNumber);
      if (departmentCount < departmentRequired) {
        const departmentName = db.prepare("SELECT name FROM departments WHERE id = ?").get(departmentId)?.name || "Abteilung";
        return { trafficLight: "red", allowed: false, reason: `Um ${point} Uhr würde die Mindestbesetzung in ${departmentName} auf ${departmentCount} von ${departmentRequired} Personen sinken.` };
      }
    }
  }
  return { trafficLight: "green", allowed: true, reason: "Der Zeitausgleich ist nach dem aktuellen Dienstplan möglich und kann zur Genehmigung eingereicht werden." };
}

function approvedVacationsForEmployee(employeeNumber, fromDate = `${new Date().getUTCFullYear()}-01-01`) {
  const rows = db.prepare(`
    SELECT id, group_id, date_from, date_to, note FROM week_options
    WHERE employee_number = ? AND option_type = 'vacation' AND date_to >= ?
    ORDER BY date_from, id
  `).all(employeeNumber, fromDate);
  const grouped = new Map();
  for (const row of rows) {
    const groupId = vacationGroupKey(row);
    const item = grouped.get(groupId) || { groupId, dateFrom: row.date_from, dateTo: row.date_to, note: row.note || "" };
    item.dateFrom = item.dateFrom < row.date_from ? item.dateFrom : row.date_from;
    item.dateTo = item.dateTo > row.date_to ? item.dateTo : row.date_to;
    item.note ||= row.note || "";
    grouped.set(groupId, item);
  }
  return [...grouped.values()];
}

function insertApprovedTimeOff(entry) {
  const dateFrom = entry.date_from || entry.request_date;
  const dateTo = entry.date_to || entry.request_date;
  const allDay = Boolean(entry.all_day) || dateTo !== dateFrom;
  const shifts = allDay
    ? db.prepare("SELECT * FROM shifts WHERE employee_number = ? AND shift_date BETWEEN ? AND ? ORDER BY shift_date, start_time").all(entry.employee_number, dateFrom, dateTo)
    : db.prepare(`SELECT * FROM shifts WHERE employee_number = ? AND shift_date = ? AND start_time < ? AND ? < end_time ORDER BY start_time`)
      .all(entry.employee_number, entry.request_date, entry.end_time, entry.start_time);
  db.prepare("UPDATE time_off_requests SET original_shifts_json = ? WHERE id = ?")
    .run(JSON.stringify(shifts), entry.id);
  const insertShift = db.prepare(`
    INSERT INTO shifts (employee_number, department_id, shift_date, start_time, end_time, area, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const shift of shifts) {
    db.prepare("DELETE FROM shifts WHERE id = ?").run(shift.id);
    if (!allDay && shift.start_time < entry.start_time) {
      insertShift.run(shift.employee_number, shift.department_id, shift.shift_date, shift.start_time, entry.start_time, shift.area, shift.note);
    }
    if (!allDay && shift.end_time > entry.end_time) {
      insertShift.run(shift.employee_number, shift.department_id, shift.shift_date, entry.end_time, shift.end_time, shift.area, shift.note);
    }
  }
  const groupId = `za-request-${entry.id}`;
  const insert = db.prepare(`INSERT INTO week_options
      (employee_number, group_id, week_start, date_from, date_to, option_type, note, credited_minutes_per_day, all_day, start_time, end_time)
    VALUES (?, ?, ?, ?, ?, 'time_off', ?, NULL, ?, ?, ?)`);
  let firstId = null;
  for (let segmentStart = dateFrom; segmentStart <= dateTo;) {
    const weekStart = getMonday(segmentStart);
    const segmentEnd = [dateTo, addDays(weekStart, 6)].sort()[0];
    const result = insert.run(entry.employee_number, groupId, weekStart, segmentStart, segmentEnd, entry.note || "", allDay ? 1 : 0,
      allDay ? null : entry.start_time, allDay ? null : entry.end_time);
    firstId ||= Number(result.lastInsertRowid);
    segmentStart = addDays(segmentEnd, 1);
  }
  return firstId;
}

function restoreApprovedTimeOff(entry) {
  let originals = [];
  try { originals = JSON.parse(entry.original_shifts_json || "[]"); } catch {}
  db.prepare("DELETE FROM week_options WHERE group_id = ? OR id = ?").run(`za-request-${entry.id}`, entry.option_id || 0);
  for (const original of originals) {
    db.prepare(`
      DELETE FROM shifts WHERE employee_number = ? AND shift_date = ?
        AND COALESCE(department_id, 0) = COALESCE(?, 0)
        AND start_time >= ? AND end_time <= ?
    `).run(original.employee_number, original.shift_date, original.department_id, original.start_time, original.end_time);
    db.prepare(`
      INSERT INTO shifts (employee_number, department_id, shift_date, start_time, end_time, area, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(original.employee_number, original.department_id, original.shift_date, original.start_time, original.end_time, original.area || "", original.note || "");
  }
}

function recordRequestDecision(kind, id, stage, action, actor, note = "") {
  db.prepare(`
    INSERT INTO request_decisions (request_kind, request_id, stage, action, actor_employee_number, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(kind, Number(id), stage, action, actor, stripEmoji(String(note || "").trim()).slice(0, 500));
}

function requestDecisionHistory(kind, id) {
  return db.prepare(`
    SELECT id, stage, action, actor_employee_number, note, created_at
    FROM request_decisions WHERE request_kind = ? AND request_id = ? ORDER BY id
  `).all(kind, Number(id));
}

function absenceHistoryForEmployee(employeeNumber) {
  const visibleSince = addMonths(viennaTodayIso(), -6);
  const vacations = db.prepare(`
    SELECT id, date_from, date_to, note, status, approval_stage, decision_note,
           local_approved_by, local_approved_at, hr_approved_by, hr_approved_at,
           decided_by, decided_at, created_at, updated_at
    FROM vacation_requests WHERE employee_number = ?
  `).all(employeeNumber).map((item) => ({
    ...item,
    kind: "vacation",
    decisions: requestDecisionHistory("vacation", item.id),
  }));
  const timeOff = db.prepare(`
    SELECT id, request_date, COALESCE(date_from, request_date) AS date_from, COALESCE(date_to, request_date) AS date_to,
           all_day, start_time, end_time, note, status, approval_type, approval_stage,
           traffic_light, check_reason, decision_note, local_approved_by, local_approved_at,
           hr_approved_by, hr_approved_at, decided_by, decided_at, created_at, updated_at
    FROM time_off_requests WHERE employee_number = ?
  `).all(employeeNumber).map((item) => ({
    ...item,
    kind: "time_off",
    decisions: requestDecisionHistory("time_off", item.id),
  }));
  const changes = db.prepare(`
    SELECT id, vacation_group_id, request_type, original_date_from, original_date_to,
           requested_date_from, requested_date_to, note, status, approval_stage, decision_note,
           local_approved_by, local_approved_at, hr_approved_by, hr_approved_at,
           decided_by, decided_at, created_at, updated_at
    FROM vacation_change_requests WHERE employee_number = ?
  `).all(employeeNumber).map((item) => ({
    ...item,
    kind: item.request_type === "cancel" ? "vacation_cancel" : "vacation_change",
    decisions: requestDecisionHistory("vacation_change", item.id),
  }));
  const timeOffChanges = db.prepare(`
    SELECT c.id, c.original_request_id, c.request_type, c.requested_date_from,
           c.requested_date_to, c.requested_all_day, c.requested_start_time,
           c.requested_end_time, c.note, c.status, c.approval_type, c.approval_stage,
           c.decision_note, c.local_approved_by, c.local_approved_at, c.hr_approved_by,
           c.hr_approved_at, c.decided_by, c.decided_at, c.created_at, c.updated_at,
           COALESCE(t.date_from, t.request_date) AS original_date_from,
           COALESCE(t.date_to, t.request_date) AS original_date_to,
           t.all_day AS original_all_day, t.start_time AS original_start_time,
           t.end_time AS original_end_time
    FROM time_off_change_requests c
    JOIN time_off_requests t ON t.id = c.original_request_id
    WHERE c.employee_number = ?
  `).all(employeeNumber).map((item) => ({
    ...item,
    kind: item.request_type === "cancel" ? "time_off_cancel" : "time_off_change",
    decisions: requestDecisionHistory("time_off_change", item.id),
  }));
  return [...vacations, ...timeOff, ...changes, ...timeOffChanges]
    .filter((item) => ["pending", "pending_local", "preliminary_local", "pending_hr"].includes(item.status)
      || String(item.date_to || item.request_date || item.requested_date_to || item.original_date_to || item.created_at).slice(0, 10) >= visibleSince)
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)) || Number(right.id) - Number(left.id));
}

function amuDocumentsForReports(reportIds) {
  const ids = [...new Set(reportIds.map(Number).filter(Number.isInteger))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT d.id, d.report_id, d.protected_payload, d.scan_status, d.status, d.created_at,
           r.employee_number
    FROM amu_documents d JOIN amu_reports r ON r.id = d.report_id
    WHERE d.report_id IN (${placeholders}) AND d.status = 'active'
    ORDER BY d.created_at, d.id
  `).all(...ids);
  const grouped = new Map(ids.map((id) => [id, []]));
  for (const row of rows) {
    const payload = parseProtectedJson(row.protected_payload, amuDocumentProtectionContext(row));
    grouped.get(Number(row.report_id))?.push({
      id: row.id,
      original_name: payload.originalFilename || "Dokument",
      original_filename: payload.originalFilename || "Dokument",
      detected_mime: payload.detectedMime || "application/octet-stream",
      size: Number(payload.byteSize || 0),
      byte_size: Number(payload.byteSize || 0),
      scan_status: row.scan_status,
      status: row.status,
      created_at: row.created_at,
    });
  }
  return grouped;
}

function sicknessCasePayload(row) {
  return parseProtectedJson(row.protected_payload, sicknessCaseProtectionContext(row));
}

function sicknessCaseCoversDate(row, date) {
  if (!row) return false;
  const payload = sicknessCasePayload(row);
  if (!payload.startDate || payload.startDate > date) return false;
  if (["reported", "aum_received"].includes(payload.status)) {
    return !isIsoDate(payload.expectedEnd) || date <= payload.expectedEnd;
  }
  if (payload.status === "recovered" && isIsoDate(payload.returnToWorkDate)) {
    return date < payload.returnToWorkDate;
  }
  return false;
}

function activeSicknessEmployeeNumbers(date, { excludeCaseId = null, includeEmployeeNumber = "" } = {}) {
  const rows = db.prepare(`
    SELECT id, employee_lookup, status_lookup, protected_payload
    FROM sickness_cases WHERE status_lookup IN (?, ?, ?)
  `).all(sicknessStatusLookup("reported"), sicknessStatusLookup("aum_received"), sicknessStatusLookup("recovered"));
  const numbers = new Set(String(includeEmployeeNumber || "") ? [String(includeEmployeeNumber)] : []);
  for (const row of rows) {
    if (excludeCaseId != null && Number(row.id) === Number(excludeCaseId)) continue;
    if (sicknessCaseCoversDate(row, date)) numbers.add(sicknessCasePayload(row).employeeNumber);
  }
  return numbers;
}

function staffingCountAtAvailable(locationId, departmentId, date, pointTime, excludedEmployeeNumbers = new Set()) {
  const departmentClause = departmentId ? "AND s.department_id = ?" : "";
  const values = departmentId
    ? [date, locationId, pointTime, pointTime, departmentId]
    : [date, locationId, pointTime, pointTime];
  const rows = db.prepare(`
    SELECT DISTINCT s.employee_number
    FROM shifts s
    JOIN employees e ON e.personnel_number = s.employee_number
    LEFT JOIN departments d ON d.id = s.department_id
    WHERE s.shift_date = ? AND COALESCE(d.location_id, e.home_location_id) = ?
      AND s.start_time <= ? AND s.end_time > ?
      ${departmentClause}
  `).all(...values);
  return rows.filter((row) => !excludedEmployeeNumbers.has(row.employee_number)).length;
}

function evaluateSicknessStaffingRisk(employeeNumber, startDate, expectedEnd, context, options = {}) {
  const dateFrom = isIsoDate(options.asOfDate) && options.asOfDate > startDate ? options.asOfDate : startDate;
  const latestPlannedDate = db.prepare(`
    SELECT MAX(shift_date) AS date_to FROM shifts WHERE employee_number = ? AND shift_date >= ?
  `).get(employeeNumber, dateFrom)?.date_to || "";
  const dateTo = isIsoDate(expectedEnd) ? expectedEnd : (isIsoDate(latestPlannedDate) ? latestPlannedDate : startDate);
  const shifts = db.prepare(`
    SELECT s.shift_date, s.start_time, s.end_time, s.department_id,
           COALESCE(d.location_id, e.home_location_id) AS location_id
    FROM shifts s
    JOIN employees e ON e.personnel_number = s.employee_number
    LEFT JOIN departments d ON d.id = s.department_id
    WHERE s.employee_number = ? AND s.shift_date BETWEEN ? AND ?
    ORDER BY s.shift_date, s.start_time, s.id
  `).all(employeeNumber, dateFrom, dateTo);
  const slots = [];
  const contexts = new Map();
  let worstShortfall = 0;
  for (const shift of shifts) {
    const locationId = String(shift.location_id || context.locationId || "").trim();
    if (!locationId) continue;
    const departmentId = Number(shift.department_id || 0) || null;
    contexts.set(`${locationId}:${departmentId || 0}`, { locationId, departmentId });
    const settings = settingsForLocation(locationId);
    const locationContext = resolvePlanningContext({ locationId, departmentId: null });
    const config = dayConfiguration(shift.shift_date, settings, locationContext);
    if (!config?.open || !isTime(config.minFrom) || !isTime(config.minTo)) continue;
    const fromMinute = Math.max(timeToMinutes(shift.start_time), timeToMinutes(config.minFrom));
    const toMinute = Math.min(timeToMinutes(shift.end_time), timeToMinutes(config.minTo));
    const departmentRequired = departmentId
      ? Number(db.prepare("SELECT min_staff FROM departments WHERE id = ? AND location_id = ?").get(departmentId, locationId)?.min_staff || 0)
      : 0;
    const unavailable = activeSicknessEmployeeNumbers(shift.shift_date, { includeEmployeeNumber: employeeNumber });
    for (let minute = fromMinute; minute < toMinute; minute += 15) {
      const time = minutesToTime(minute);
      const locationCount = staffingCountAtAvailable(locationId, null, shift.shift_date, time, unavailable);
      const locationShortfall = Math.max(0, Number(config.minStaff || 0) - locationCount);
      const departmentCount = departmentId
        ? staffingCountAtAvailable(locationId, departmentId, shift.shift_date, time, unavailable)
        : 0;
      const departmentShortfall = Math.max(0, departmentRequired - departmentCount);
      const shortfall = Math.max(locationShortfall, departmentShortfall);
      if (!shortfall) continue;
      worstShortfall = Math.max(worstShortfall, shortfall);
      if (slots.length < 12) {
        slots.push({
          date: shift.shift_date,
          time,
          locationId,
          locationCount,
          locationRequired: Number(config.minStaff || 0),
          departmentId,
          departmentCount,
          departmentRequired,
          shortfall,
        });
      }
    }
  }
  return {
    atRisk: worstShortfall > 0,
    plannedShiftCount: shifts.length,
    worstShortfall,
    slots,
    contexts: [...contexts.values()],
  };
}

function serializeSicknessCases(rows, { includeNote = true } = {}) {
  const alertStatement = db.prepare(`
    SELECT * FROM sickness_alerts WHERE sickness_case_id = ? ORDER BY id
  `);
  const amuStatusStatement = db.prepare(`
    SELECT status FROM amu_reports
    WHERE sickness_case_id = ? AND status NOT IN ('withdrawn','purged')
    ORDER BY submitted_at DESC, id DESC
  `);
  return rows.map((row) => {
    const payload = sicknessCasePayload(row);
    const reportStatuses = amuStatusStatement.all(row.id).map((report) => String(report.status || ""));
    const amuStatus = reportStatuses.includes("reviewed")
      ? "reviewed"
      : reportStatuses.some((status) => ["submitted", "returned"].includes(status)) || payload.status === "aum_received"
        ? "received"
        : "required";
    const alerts = alertStatement.all(row.id).map((alertRow) => {
      const alert = sicknessAlertPayload(alertRow);
      return {
        kind: alert.kind, severity: alert.severity, audience: alert.audience, status: alert.status,
        triggered_at: alert.triggeredAt || null, resolved_at: alert.resolvedAt || null,
      };
    });
    const employee = db.prepare("SELECT full_name, nickname FROM employees WHERE personnel_number = ?").get(payload.employeeNumber) || {};
    const location = db.prepare("SELECT name FROM locations WHERE id = ?").get(payload.locationId) || {};
    const department = payload.departmentId == null ? {} : (db.prepare("SELECT name FROM departments WHERE id = ?").get(payload.departmentId) || {});
    const openAlerts = alerts.filter((alert) => alert.status === "open");
    const severity = openAlerts.some((alert) => alert.severity === "red") ? "red"
      : openAlerts.some((alert) => alert.severity === "yellow") ? "yellow"
        : openAlerts.some((alert) => alert.kind === "staffing_risk") ? "warning" : "normal";
    return {
      id: Number(row.id),
      employee_number: payload.employeeNumber || "",
      full_name: employee.full_name || "",
      nickname: employee.nickname || "",
      location_id: payload.locationId || "",
      location_name: location.name || "",
      department_id: payload.departmentId == null ? null : Number(payload.departmentId),
      department_name: department.name || "",
      status: payload.status || "reported",
      reported_at: payload.reportedAt || row.created_at,
      aum_received_at: payload.aumReceivedAt || null,
      closed_at: payload.closedAt || null,
      start_date: payload.startDate || "",
      expected_end: payload.expectedEnd || "",
      return_to_work_date: payload.returnToWorkDate || "",
      employee_note: includeNote ? (payload.note || "") : "",
      amu_status: amuStatus,
      staffing_risk: payload.staffingRisk || { atRisk: false, plannedShiftCount: 0, worstShortfall: 0, slots: [] },
      severity,
      alerts,
    };
  });
}

function sicknessCaseMetadata(id) {
  return db.prepare("SELECT * FROM sickness_cases WHERE id = ?").get(Number(id));
}

function ownSicknessCases(employeeNumber) {
  return serializeSicknessCases(db.prepare(`
    SELECT * FROM sickness_cases WHERE employee_lookup = ? ORDER BY created_at DESC, id DESC
  `).all(sicknessEmployeeLookup(employeeNumber)));
}

function assertSicknessCaseScope(session, row) {
  if (!row) throw httpError(404, "Die Krankmeldung wurde nicht gefunden.", "SICKNESS_CASE_NOT_FOUND");
  if (session.employeeNumber === "local" || GLOBAL_SCOPE_PORTAL_ROLES.has(session.role)) return;
  const payload = sicknessCasePayload(row);
  const allowed = portalScopeMatchesAnyContext(session.role, session.scopes || [], sicknessNotificationContexts(payload));
  if (!allowed) throw httpError(403, "Diese Krankmeldung gehört nicht zum eigenen Verantwortungsbereich.", "PORTAL_PERMISSION_DENIED");
}

function serializeAmuReports(rows) {
  const documents = amuDocumentsForReports(rows.map((row) => row.id));
  return rows.map((row) => {
    const payload = parseProtectedJson(row.protected_payload, amuReportProtectionContext(row));
    return {
      ...row,
      id: Number(row.id),
      incapacity_from: payload.incapacityFrom || "",
      incapacity_to: payload.incapacityTo || "",
      employee_note: payload.employeeNote || "",
      reviewed_by: payload.reviewedBy || null,
      reviewed_at: payload.reviewedAt || null,
      review_note: payload.reviewNote || "",
      retention_until: payload.retentionUntil || null,
      withdrawn_at: payload.withdrawnAt || null,
      protected_payload: undefined,
      documents: documents.get(Number(row.id)) || [],
    };
  });
}

function ownAmuReports(employeeNumber) {
  return serializeAmuReports(db.prepare(`
    SELECT r.*, l.name AS location_name
    FROM amu_reports r JOIN locations l ON l.id = r.location_id
    WHERE r.employee_number = ? AND r.status <> 'purged' ORDER BY r.submitted_at DESC, r.id DESC
  `).all(employeeNumber));
}

function amuReportMetadata(id) {
  return db.prepare(`
    SELECT r.*, e.full_name, e.nickname, e.color, e.preferred_department_id, l.name AS location_name,
           d.name AS department_name
    FROM amu_reports r JOIN employees e ON e.personnel_number = r.employee_number
    JOIN locations l ON l.id = r.location_id
    LEFT JOIN departments d ON d.id = r.department_id WHERE r.id = ?
  `).get(Number(id));
}

function sessionCanAccessAmuReport(session, report) {
  if (!report) return false;
  if (sessionHasGlobalScope(session)) return true;
  return (session.scopes || []).some((scope) => scope.locationId === report.location_id
    && (!Number(scope.departmentId || 0)
      || (report.department_id != null && Number(scope.departmentId) === Number(report.department_id))));
}

function assertAmuReportScope(session, report) {
  if (!report) throw httpError(404, "Die Arbeitsunfähigkeitsmeldung wurde nicht gefunden.", "AMU_REPORT_NOT_FOUND");
  if (!sessionCanAccessAmuReport(session, report)) {
    auditPortal(session.employeeNumber, "amu.access.denied", "amu_report", String(report.id), "scope");
    throw httpError(403, "Diese Arbeitsunfähigkeitsmeldung gehört nicht zum eigenen Standort.", "PORTAL_PERMISSION_DENIED");
  }
}

function amuDocumentMetadata(reportId, documentId) {
  return db.prepare(`
    SELECT d.*, r.employee_number, r.location_id, r.department_id, r.status AS report_status
    FROM amu_documents d JOIN amu_reports r ON r.id = d.report_id
    WHERE d.report_id = ? AND d.id = ? AND d.status = 'active'
  `).get(Number(reportId), String(documentId));
}

function sendAmuDocument(response, metadata) {
  const payload = parseProtectedJson(metadata.protected_payload, amuDocumentProtectionContext(metadata));
  const originalFilename = payload.originalFilename || "Dokument";
  const content = requireAmuStorage().readBuffer({
    storageKey: metadata.storage_key,
    byteSize: payload.byteSize,
    sha256: payload.sha256,
    detectedMime: payload.detectedMime,
    originalFilename,
  });
  response.setHeader("Content-Type", payload.detectedMime);
  response.setHeader("Content-Length", String(content.length));
  response.setHeader("Content-Disposition", contentDispositionHeader(originalFilename));
  response.setHeader("Cache-Control", "private, no-store, max-age=0");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(content);
}

function purgeExpiredAmuDocuments(today = viennaTodayIso()) {
  if (!amuStorage || !tableExists("amu_documents") || amuMutationInProgress > 0) return { purged: 0 };
  const expiringReports = db.prepare(`
    SELECT id, employee_number, protected_payload, status
    FROM amu_reports
    WHERE status IN ('submitted','returned','reviewed','withdrawn','purged')
    ORDER BY id
  `).all().filter((row) => {
    if (!row.protected_payload) return false;
    const payload = parseProtectedJson(row.protected_payload, amuReportProtectionContext(row));
    return Boolean(payload.retentionUntil && payload.retentionUntil < today);
  });
  const reportIds = expiringReports.map((row) => Number(row.id));
  const rows = reportIds.length ? db.prepare(`
    SELECT id, storage_key, report_id
    FROM amu_documents
    WHERE report_id IN (${reportIds.map(() => "?").join(",")}) AND status IN ('active','deleted')
    ORDER BY created_at, id
  `).all(...reportIds) : [];
  let purged = 0;
  amuMutationInProgress += 1;
  try {
    for (const row of rows) {
      db.prepare("UPDATE amu_documents SET status = 'deleted', deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP) WHERE id = ?").run(row.id);
      try { amuStorage.deleteBlob(row.storage_key); } catch (error) {
        auditPortal("system", "amu.document.purge.error", "amu_document", row.id, error.message);
        continue;
      }
      db.prepare(`
        UPDATE amu_documents SET status = 'purged', original_filename = '', protected_payload = '', purged_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(row.id);
      auditPortal("system", "amu.document.purge", "amu_document", row.id);
      purged += 1;
    }
    const updateReport = db.prepare(`
      UPDATE amu_reports SET status = 'purged', protected_payload = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND NOT EXISTS (SELECT 1 FROM amu_documents d WHERE d.report_id = amu_reports.id AND d.status <> 'purged')
    `);
    for (const report of expiringReports) {
      const purgedPayload = protectJson({
        incapacityFrom: "", incapacityTo: "", employeeNote: "", reviewedBy: "", reviewedAt: "",
        reviewNote: "", retentionUntil: "", withdrawnAt: "",
      }, amuReportProtectionContext(report));
      updateReport.run(purgedPayload, report.id);
    }
  } finally {
    amuMutationInProgress = Math.max(0, amuMutationInProgress - 1);
  }
  return { purged };
}

function reconcileOrphanAmuBlobs() {
  if (!amuStorage || !tableExists("amu_documents") || amuMutationInProgress > 0) return { removed: 0 };
  const referenced = new Set(db.prepare("SELECT storage_key FROM amu_documents").all().map((row) => String(row.storage_key || "").toLowerCase()));
  let removed = 0;
  for (const storageKey of amuStorage.listStorageKeys()) {
    if (referenced.has(storageKey)) continue;
    if (amuStorage.deleteBlob(storageKey)) {
      auditPortal("system", "amu.document.orphan.purge", "amu_document", storageKey);
      removed += 1;
    }
  }
  return { removed };
}

function vacationHrApprovalRequired() {
  return getPortalSettings().vacation_hr_approval_required === "1";
}

function sessionCanApproveHr(session) {
  return Boolean(session && (session.employeeNumber === "local" || session.permissions?.includes("hr:approve")));
}

function actorStage(session, entry) {
  if (entry.approval_stage === "hr" && sessionCanApproveHr(session)) return "hr";
  return "local";
}

function assertRequestScope(session, entry) {
  if (sessionHasGlobalScope(session)) return;
  const locationId = entry.location_id || db.prepare("SELECT home_location_id FROM employees WHERE personnel_number = ?").get(entry.employee_number)?.home_location_id;
  const assignedScopes = session.scopes || [];
  if (!assignedScopes.some((scope) => scope.locationId === locationId)) {
    throw httpError(403, "Dieser Antrag gehört nicht zum eigenen Standort.", "PORTAL_PERMISSION_DENIED");
  }
  if (session.role === "department_manager") {
    const employeeDepartment = employeeRequestContext(entry.employee_number, entry.request_date || entry.date_from).departmentId;
    if (!assignedScopes.some((scope) => scope.locationId === locationId && Number(scope.departmentId) === Number(employeeDepartment))) {
      throw httpError(403, "Dieser Antrag gehört nicht zur eigenen Abteilung.", "PORTAL_PERMISSION_DENIED");
    }
    const today = viennaTodayIso();
    const delegated = db.prepare(`
      SELECT 1 FROM approval_delegations WHERE location_id = ? AND delegate_employee_number = ?
        AND active = 1 AND date_from <= ? AND date_to >= ? LIMIT 1
    `).get(locationId, session.employeeNumber, today, today);
    const managerPresent = db.prepare(`
      SELECT u.employee_number FROM portal_users u JOIN employees e ON e.personnel_number = u.employee_number
      WHERE u.role = 'manager' AND u.active = 1 AND e.home_location_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM week_options w WHERE w.employee_number = u.employee_number
            AND ? BETWEEN w.date_from AND w.date_to AND w.option_type IN ('vacation','sick','time_off','branch')
        ) LIMIT 1
    `).get(locationId, today);
    if (!delegated && managerPresent) throw httpError(403, "Die Abteilungsleitung darf diesen Antrag nur bei Abwesenheit oder hinterlegter Vertretung der Filialleitung bearbeiten.");
  }
}

function publicRequestStatus(value) {
  return ({
    pending: "pending_local",
    pending_local: "pending_local",
    preliminary_local: "preliminary_local",
    pending_hr: "pending_hr",
    approved: "approved",
    rejected: "rejected",
    cancelled: "cancelled",
  })[value] || value;
}

function sendPortalInactive(_request, response) {
  response.status(503).json({
    error: "Der Mitarbeiterzugang ist technisch vorbereitet, aber in dieser Version noch nicht aktiv.",
    code: "PORTAL_INACTIVE",
    status: getPortalStatus(),
  });
}

function brandingFromSettings(settings = getSettings()) {
  const companyName = settings.companyName ?? settings.brandingCompanyName ?? settings.branding_company_name;
  const logoUrl = settings.logoUrl ?? settings.brandingLogoUrl ?? settings.branding_logo_url;
  const iconUrl = settings.iconUrl ?? settings.brandingIconUrl ?? settings.branding_icon_url;
  const logoAlt = settings.logoAlt ?? settings.brandingLogoAlt ?? settings.branding_logo_alt ?? companyName;
  const adminEmail = settings.adminEmail ?? settings.brandingAdminEmail ?? settings.branding_admin_email;
  return {
    appName: defaultBranding.app_name,
    companyName: String(companyName || defaultBranding.company_name).trim(),
    logoUrl: String(logoUrl || defaultBranding.logo_url).trim() || defaultBranding.logo_url,
    iconUrl: String(iconUrl || defaultBranding.icon_url).trim() || defaultBranding.icon_url,
    logoAlt: String(logoAlt || defaultBranding.logo_alt).trim() || defaultBranding.logo_alt,
    adminEmail: String(adminEmail || defaultBranding.admin_email).trim(),
  };
}

function locationBrandingRow(locationId) {
  if (!locationId || !tableExists("location_branding")) return null;
  return db.prepare(`
    SELECT location_id, kit_id, company_name, logo_url, icon_url, logo_alt, admin_email, updated_by, updated_at
    FROM location_branding WHERE location_id = ?
  `).get(String(locationId));
}

function brandingForLocation(locationId, _fallbackSettings = null) {
  const row = locationBrandingRow(locationId);
  if (!row) return brandingFromSettings(defaultSettings);
  return brandingFromSettings({
    companyName: row.company_name,
    logoUrl: row.logo_url,
    iconUrl: row.icon_url,
    logoAlt: row.logo_alt,
    adminEmail: row.admin_email,
  });
}

function managementBrandingPreference() {
  const settings = getSettings();
  return {
    kitId: String(settings.branding_management_kit_id || ""),
    branding: brandingFromSettings(settings),
  };
}

function brandingForPortalSession(session) {
  if (sessionHasGlobalScope(session)) {
    return managementBrandingPreference().branding;
  }
  return brandingForLocation(session.homeLocationId);
}

const defaultMobileBrandingTheme = Object.freeze({
  primary: "#205b49",
  secondary: "#2d8f6e",
  accent: "#f4c952",
  text: "#17222e",
  background: "#f4f1e8",
});

function mobileHexColor(value, fallback) {
  const color = String(value || "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : fallback;
}

function mobileColorLuminance(color) {
  const channels = color.slice(1).match(/.{2}/g).map((entry) => Number.parseInt(entry, 16) / 255)
    .map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function mobileColorContrast(left, right) {
  const first = mobileColorLuminance(left);
  const second = mobileColorLuminance(right);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function mobileBrandingTheme(raw = {}) {
  const colors = raw.colors && typeof raw.colors === "object" ? raw.colors : {};
  const theme = {
    primary: mobileHexColor(raw.primaryColor || raw.primary_color || colors.primary, defaultMobileBrandingTheme.primary),
    secondary: mobileHexColor(raw.secondaryColor || raw.secondary_color || colors.secondary, defaultMobileBrandingTheme.secondary),
    accent: mobileHexColor(raw.accentColor || raw.accent_color || colors.accent, defaultMobileBrandingTheme.accent),
    text: mobileHexColor(raw.textColor || raw.text_color || colors.text, defaultMobileBrandingTheme.text),
    background: mobileHexColor(raw.backgroundColor || raw.background_color || colors.background, defaultMobileBrandingTheme.background),
  };
  if (mobileColorContrast(theme.text, theme.background) < 4.5) {
    theme.text = defaultMobileBrandingTheme.text;
    theme.background = defaultMobileBrandingTheme.background;
  }
  return theme;
}

function mobileSameOriginAssetPath(value, fallback) {
  const candidate = String(value || "").trim();
  let pathname = "";
  try {
    if (candidate.startsWith("/")) pathname = new URL(candidate, "https://grabenplaner.invalid").pathname;
    else {
      const parsed = new URL(candidate);
      if (!normalizedPublicOrigin || parsed.origin !== normalizedPublicOrigin) return fallback;
      pathname = parsed.pathname;
    }
  } catch {
    return fallback;
  }
  if (!/^\/(?:assets|branding-kits)\/[A-Za-z0-9._~!$&'()+,;=:@%\/-]+$/.test(pathname)
    || pathname.includes("..") || /%2f|%5c|%2e%2e/i.test(pathname)) return fallback;
  return pathname;
}

function mobileBrandingSourceForSession(session) {
  let kitId = "neutral";
  if (sessionHasGlobalScope(session)) kitId = String(getSettings().branding_management_kit_id || "neutral");
  else kitId = String(locationBrandingRow(session.homeLocationId)?.kit_id || "neutral");
  if (kitId && kitId !== "custom") {
    try {
      const kit = readBrandingKitManifest(kitId);
      return { kitId, raw: kit.branding || kit };
    } catch {}
  }
  return { kitId: kitId || "custom", raw: {} };
}

function mobileBrandingPayload(session) {
  const branding = brandingForPortalSession(session);
  const source = mobileBrandingSourceForSession(session);
  const theme = mobileBrandingTheme(source.raw);
  const payload = {
    ...branding,
    logoUrl: mobileSameOriginAssetPath(branding.logoUrl, defaultBranding.logo_url),
    iconUrl: mobileSameOriginAssetPath(branding.iconUrl, defaultBranding.icon_url),
    theme,
  };
  return {
    ...payload,
    revision: sha256(JSON.stringify({ kitId: source.kitId, ...payload })).slice(0, 24),
  };
}

function mobileSchedulePayload(session, weekValue = "") {
  if (weekValue && !isIsoDate(weekValue)) {
    throw httpError(400, "Bitte eine gültige Kalenderwoche auswählen.", "MOBILE_SCHEDULE_WEEK_INVALID");
  }
  const weekStart = getMonday(weekValue || currentWeekStart());
  const weekEnd = addDays(weekStart, 6);
  const shifts = db.prepare(`
    SELECT s.id, s.shift_date, s.start_time, s.end_time, s.area, s.note, s.department_id,
           d.name AS department_name
    FROM shifts s LEFT JOIN departments d ON d.id = s.department_id
    WHERE s.employee_number = ? AND s.shift_date BETWEEN ? AND ?
    ORDER BY s.shift_date, s.start_time, s.id
  `).all(session.employeeNumber, weekStart, weekEnd).map((shift) => ({
    id: Number(shift.id),
    date: shift.shift_date,
    startTime: shift.start_time,
    endTime: shift.end_time,
    area: shift.area || "",
    note: shift.note || "",
    departmentId: Number(shift.department_id || 0) || null,
    departmentName: shift.department_name || "",
  }));
  const options = db.prepare(`
    SELECT id, date_from, date_to, option_type, note, all_day, start_time, end_time
    FROM week_options
    WHERE employee_number = ? AND date_from <= ? AND date_to >= ?
    ORDER BY date_from, id
  `).all(session.employeeNumber, weekEnd, weekStart).map((option) => ({
    id: Number(option.id),
    dateFrom: option.date_from,
    dateTo: option.date_to,
    type: option.option_type,
    note: option.note || "",
    allDay: Boolean(option.all_day),
    startTime: option.start_time || null,
    endTime: option.end_time || null,
  }));
  return {
    weekStart,
    weekEnd,
    calendarWeek: getIsoWeek(weekStart),
    timezone: "Europe/Vienna",
    locationId: session.homeLocationId || "",
    shifts,
    options,
  };
}

function portalStatusForSession(session, request = null) {
  return {
    ...getPortalStatus("", request),
    branding: brandingForPortalSession(session),
  };
}

function saveManagementBrandingPreference(kitId, brandingInput, actor = "") {
  const normalizedKitId = validateBrandOptionalText(kitId || "custom", 120) || "custom";
  if (!/^[a-z0-9_-]+$/i.test(normalizedKitId)) throw httpError(400, "Die Branding-Kit-ID ist ungueltig.");
  const values = brandingValuesFromBody(brandingInput || {});
  const update = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const entries = {
    branding_management_kit_id: normalizedKitId,
    ...values,
  };
  db.exec("BEGIN");
  try {
    for (const [key, value] of Object.entries(entries)) update.run(key, value);
    auditPortal(actor, "branding.preference.update", "settings", "management", JSON.stringify({ kitId: normalizedKitId }));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return managementBrandingPreference();
}

function saveLocationBrandingSnapshot(locationId, kitId, brandingInput, actor = "") {
  const normalizedLocationId = normalizeLocationId(locationId);
  validateLocationExists(normalizedLocationId);
  const normalizedKitId = validateBrandOptionalText(kitId || "custom", 120) || "custom";
  if (!/^[a-z0-9_-]+$/i.test(normalizedKitId)) throw httpError(400, "Die Branding-Kit-ID ist ungültig.");
  const values = brandingValuesFromBody(brandingInput || {});
  db.prepare(`
    INSERT INTO location_branding
      (location_id, kit_id, company_name, logo_url, icon_url, logo_alt, admin_email, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(location_id) DO UPDATE SET
      kit_id = excluded.kit_id,
      company_name = excluded.company_name,
      logo_url = excluded.logo_url,
      icon_url = excluded.icon_url,
      logo_alt = excluded.logo_alt,
      admin_email = excluded.admin_email,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    normalizedLocationId,
    normalizedKitId,
    values.branding_company_name,
    values.branding_logo_url,
    values.branding_icon_url,
    values.branding_logo_alt,
    values.branding_admin_email,
    String(actor || ""),
  );
  return brandingForLocation(normalizedLocationId);
}

function brandingAssignmentForLocation(location) {
  const row = locationBrandingRow(location.id);
  return {
    locationId: location.id,
    locationName: location.name,
    active: Boolean(location.active),
    assigned: Boolean(row),
    kitId: row?.kit_id || "",
    branding: brandingForLocation(location.id),
    updatedBy: row?.updated_by || "",
    updatedAt: row?.updated_at || null,
  };
}

function locationBrandingAssignments() {
  return getLocations(true).map(brandingAssignmentForLocation);
}

function pdfFooterContact(settings = getSettings(), createdAt = new Date()) {
  const branding = brandingFromSettings(settings);
  return `${branding.adminEmail ? `Admin: ${branding.adminEmail} · ` : ""}Erstellt am ${formatPdfTimestamp(createdAt)}`;
}

function settingEnabled(settings, key) {
  return settings[key] === "1";
}

function serializeLocation(row, departments = []) {
  return {
    ...row,
    min_staff: Number(row.min_staff || 0),
    day_settings: daySettingsFromLocation(row.id),
    time_tracking_enabled: Boolean(row.time_tracking_enabled),
    time_tracking_access_mode: row.time_tracking_access_mode === "trusted_network" ? "trusted_network" : "anywhere",
    time_tracking_allowed_networks: String(row.time_tracking_allowed_networks || ""),
    time_tracking_variance_minutes: Math.max(0, Number(row.time_tracking_variance_minutes || 0)),
    active: Boolean(row.active),
    departments,
  };
}

function serializeDepartment(row) {
  return {
    ...row,
    id: Number(row.id),
    min_staff: Number(row.min_staff || 0),
    active: Boolean(row.active),
    sort_order: Number(row.sort_order || 0),
  };
}

function serializePosition(row) {
  return {
    ...row,
    builtin: Boolean(row.builtin),
    sort_order: Number(row.sort_order || 0),
  };
}

function getPositions() {
  return db.prepare("SELECT id, name, builtin, sort_order, created_at FROM positions ORDER BY builtin DESC, sort_order, name")
    .all()
    .map(serializePosition);
}

function getLocations(includeInactive = true) {
  const locationRows = db
    .prepare(`
      SELECT id, name, min_staff, day_settings_json, time_tracking_enabled,
             time_tracking_access_mode, time_tracking_allowed_networks, time_tracking_variance_minutes,
             active, created_at
      FROM locations
      ${includeInactive ? "" : "WHERE active = 1"}
      ORDER BY active DESC, id
    `)
    .all();
  const departmentRows = db
    .prepare(`
      SELECT id, location_id, name, min_staff, active, sort_order, created_at
      FROM departments
      ${includeInactive ? "" : "WHERE active = 1"}
      ORDER BY location_id, active DESC, sort_order, name
    `)
    .all()
    .map(serializeDepartment);
  return locationRows.map((location) =>
    serializeLocation(location, departmentRows.filter((department) => department.location_id === location.id)),
  );
}

function getLocationsForSession(session, includeInactive = true) {
  const locations = getLocations(includeInactive);
  const canReadTimeSettings = !session || session.employeeNumber === "local" || session.permissions?.includes("time:settings");
  const visibleLocation = (location) => canReadTimeSettings ? location : { ...location, time_tracking_allowed_networks: "" };
  if (sessionHasGlobalScope(session)) return locations.map(visibleLocation);
  const allowed = new Map((session.scopes || []).map((scope) => [`${scope.locationId}:${scope.departmentId || 0}`, scope]));
  return locations.filter((location) => [...allowed.keys()].some((key) => key.startsWith(`${location.id}:`))).map((location) => ({
    ...visibleLocation(location),
    departments: session.role === "department_manager"
      ? location.departments.filter((department) => allowed.has(`${location.id}:${department.id}`))
      : location.departments,
  }));
}

function normalizeLocationId(value) {
  const id = String(value || "").trim();
  if (!/^\d{2}$/.test(id)) {
    throw httpError(400, "Die Filial-ID muss aus genau 2 Ziffern bestehen.");
  }
  return id;
}

function normalizeDepartmentId(value, allowEmpty = true) {
  if ((value === undefined || value === null || value === "") && allowEmpty) return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw httpError(400, "Die Abteilung ist ungültig.");
  }
  return id;
}

function validateLocationExists(locationId) {
  const location = db.prepare(`
    SELECT id, name, min_staff, time_tracking_enabled, time_tracking_access_mode,
           time_tracking_allowed_networks, time_tracking_variance_minutes, active
    FROM locations WHERE id = ?
  `).get(locationId);
  if (!location) throw httpError(404, "Die Filiale wurde nicht gefunden.");
  return location;
}

function normalizeTimeTrackingNetworks(value) {
  const entries = [...new Set((Array.isArray(value) ? value : String(value || "").split(/[\s,;]+/))
    .map((entry) => String(entry || "").trim().toLowerCase())
    .filter(Boolean))];
  if (entries.length > 20) throw httpError(400, "Es können höchstens 20 vertrauenswürdige IP-Adressen oder Netze hinterlegt werden.");
  for (const entry of entries) {
    const [address, prefix, ...remainder] = entry.split("/");
    const version = net.isIP(address);
    if (!version || remainder.length || (prefix !== undefined && (
      !/^\d+$/.test(prefix) || Number(prefix) < 0 || Number(prefix) > (version === 4 ? 32 : 128)
    ))) {
      throw httpError(400, `Die Netzwerkangabe „${entry}“ ist ungültig.`);
    }
  }
  return entries.join("\n");
}

function validateDepartmentExists(departmentId, locationId = null) {
  if (!departmentId) return null;
  const department = db.prepare("SELECT id, location_id, name, min_staff, active FROM departments WHERE id = ?").get(departmentId);
  if (!department) throw httpError(404, "Die Abteilung wurde nicht gefunden.");
  if (locationId && department.location_id !== locationId) {
    throw httpError(400, "Die Abteilung gehört nicht zur ausgewählten Filiale.");
  }
  return department;
}

function validateLocationPayload(body, isNew = false) {
  const id = normalizeLocationId(body.id || body.locationId);
  const name = String(body.name || "").trim();
  const minStaff = Number(body.minStaff ?? body.min_staff ?? 0);
  if (!name) throw httpError(400, "Bitte einen Namen für die Filiale eingeben.");
  if (name.length > 80) throw httpError(400, "Der Filialname darf maximal 80 Zeichen lang sein.");
  if (!Number.isInteger(minStaff) || minStaff < 0 || minStaff > 99) {
    throw httpError(400, "Die Mindestbesetzung der Filiale muss zwischen 0 und 99 liegen.");
  }
  if (!isNew) validateLocationExists(id);
  const daySettings = validateDaySettings(body.daySettings || (isNew ? legacyDaySettingsSnapshot() : daySettingsFromLocation(id)));
  const timeTrackingAccessMode = body.timeTrackingAccessMode === "trusted_network" || body.time_tracking_access_mode === "trusted_network"
    ? "trusted_network"
    : "anywhere";
  const timeTrackingVarianceMinutes = Number(body.timeTrackingVarianceMinutes ?? body.time_tracking_variance_minutes ?? 15);
  if (!Number.isInteger(timeTrackingVarianceMinutes) || timeTrackingVarianceMinutes < 0 || timeTrackingVarianceMinutes > 240) {
    throw httpError(400, "Die Toleranz der Zeiterfassung muss zwischen 0 und 240 Minuten liegen.");
  }
  return {
    id,
    name,
    minStaff,
    daySettings,
    timeTrackingEnabled: body.timeTrackingEnabled === true || body.time_tracking_enabled === true ? 1 : 0,
    timeTrackingAccessMode,
    timeTrackingAllowedNetworks: normalizeTimeTrackingNetworks(body.timeTrackingAllowedNetworks ?? body.time_tracking_allowed_networks),
    timeTrackingVarianceMinutes,
    active: body.active === false ? 0 : 1,
  };
}

function validateDaySettings(submittedDays = {}) {
  const result = {};
  for (const [day] of planningDays) {
    const submitted = submittedDays[day] || {};
    const open = submitted.open !== false;
    const start = String(submitted.start || "");
    const end = String(submitted.end || "");
    const lunchEnabled = submitted.lunchEnabled === true;
    const lunchStart = String(submitted.lunchStart || "13:00");
    const lunchEnd = String(submitted.lunchEnd || "14:00");
    const minStaff = Number(submitted.minStaff || 0);
    const minFrom = String(submitted.minFrom || start);
    const minTo = String(submitted.minTo || end);
    if (![start, end, lunchStart, lunchEnd, minFrom, minTo].every(isTime)) throw httpError(400, `Bitte gültige Zeiten für ${day} eingeben.`);
    if (open && end <= start) throw httpError(400, `Das Dienstende für ${day} muss nach dem Beginn liegen.`);
    if (lunchEnabled && (lunchEnd <= lunchStart || lunchStart < start || lunchEnd > end)) throw httpError(400, `Die Mittagspause für ${day} muss innerhalb der Dienstzeit liegen.`);
    if (!Number.isInteger(minStaff) || minStaff < 0 || minStaff > 99) throw httpError(400, `Die Mindestbesetzung für ${day} ist ungültig.`);
    if (open && (minTo <= minFrom || minFrom < start || minTo > end)) throw httpError(400, `Der Zeitraum der Mindestbesetzung für ${day} muss innerhalb der Dienstzeit liegen.`);
    result[day] = { open, start, end, lunchEnabled, lunchStart, lunchEnd, minStaff, minFrom, minTo };
  }
  return result;
}

function validateDepartmentPayload(body, existingId = null) {
  const locationId = normalizeLocationId(body.locationId || body.location_id);
  validateLocationExists(locationId);
  const name = String(body.name || "").trim();
  const minStaff = Number(body.minStaff ?? body.min_staff ?? 0);
  if (!name) throw httpError(400, "Bitte einen Namen für die Abteilung eingeben.");
  if (name.length > 80) throw httpError(400, "Der Abteilungsname darf maximal 80 Zeichen lang sein.");
  if (!Number.isInteger(minStaff) || minStaff < 0 || minStaff > 99) {
    throw httpError(400, "Die Mindestbesetzung der Abteilung muss zwischen 0 und 99 liegen.");
  }
  const active = body.active === false ? 0 : 1;
  const departmentCount = db
    .prepare("SELECT COUNT(*) AS count FROM departments WHERE location_id = ? AND id != ?")
    .get(locationId, Number(existingId || 0)).count;
  if (departmentCount >= 3) {
    throw httpError(400, "Pro Filiale können maximal 3 Abteilungen angelegt werden.");
  }
  return { locationId, name, minStaff, active };
}

function resolvePlanningContext(input = {}) {
  ensureDefaultLocation();
  const activeLocations = db.prepare("SELECT id, name FROM locations WHERE active = 1 ORDER BY id").all();
  const fallbackLocation = activeLocations[0] || db.prepare("SELECT id, name FROM locations ORDER BY id LIMIT 1").get();
  let locationId = String(input.locationId || input.location || "").trim();
  if (!locationId) locationId = fallbackLocation?.id || "01";
  locationId = normalizeLocationId(locationId);
  const location = validateLocationExists(locationId);
  let departmentId = normalizeDepartmentId(input.departmentId ?? input.department, true);
  const department = validateDepartmentExists(departmentId, locationId);
  return {
    locationId,
    locationName: location.name,
    departmentId,
    departmentName: department?.name || "",
  };
}

function staffingFloorForContext(context = {}) {
  if (!context.locationId) return 0;
  const location = db.prepare("SELECT min_staff FROM locations WHERE id = ?").get(context.locationId);
  const locationMinimum = Number(location?.min_staff || 0);
  if (context.departmentId) {
    const department = db.prepare("SELECT min_staff FROM departments WHERE id = ?").get(context.departmentId);
    return Math.max(locationMinimum, Number(department?.min_staff || 0));
  }
  const departmentSum = db.prepare("SELECT COALESCE(SUM(min_staff), 0) AS total FROM departments WHERE location_id = ? AND active = 1")
    .get(context.locationId).total;
  return Math.max(locationMinimum, Number(departmentSum || 0));
}

function pdfDepartmentKey(context = {}) {
  return context.departmentId ? String(context.departmentId) : "";
}

function defaultSchedulePdfSettings(context = {}) {
  const titleParts = [`${context.departmentName ? "Abteilungsplan" : "Dienstplan"} ${context.locationName || "Hauptstandort"}`];
  if (context.departmentName) titleParts.push(context.departmentName);
  const title = titleParts.join(" · ");
  return {
    pdf_title: title,
    pdf_filename_prefix: title,
    pdf_filename_include_kw: "1",
    pdf_filename_include_timestamp: "0",
  };
}

function defaultVacationPdfSettings(context = {}) {
  const title = `Urlaubsplanung ${context.locationName || "Hauptstandort"}`;
  return {
    vacation_pdf_title: title,
    vacation_pdf_filename_prefix: title,
    vacation_pdf_filename_include_period: "1",
    vacation_pdf_filename_include_timestamp: "0",
    vacation_pdf_show_balance: "1",
    vacation_pdf_balance_show_entitlement: "1",
    vacation_pdf_balance_show_planned: "1",
    vacation_pdf_balance_show_consumed: "0",
    vacation_pdf_calendar_style: "bars",
  };
}

function getScopedPdfSettings(scopeType, context) {
  const departmentKey = scopeType === "schedule" ? pdfDepartmentKey(context) : "";
  const rows = db
    .prepare(`
      SELECT key, value
      FROM pdf_settings
      WHERE scope_type = ? AND location_id = ? AND department_key = ?
    `)
    .all(scopeType, context.locationId, departmentKey);
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function applyScopedPdfSettings(settings, context, scopeType) {
  const defaults = scopeType === "vacation"
    ? defaultVacationPdfSettings(context)
    : defaultSchedulePdfSettings(context);
  return {
    ...settings,
    ...defaults,
    ...getScopedPdfSettings(scopeType, context),
  };
}

function saveScopedPdfSettings(scopeType, context, values) {
  const departmentKey = scopeType === "schedule" ? pdfDepartmentKey(context) : "";
  const upsert = db.prepare(`
    INSERT INTO pdf_settings (scope_type, location_id, department_key, key, value, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(scope_type, location_id, department_key, key)
    DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `);
  for (const [key, value] of Object.entries(values)) {
    upsert.run(scopeType, context.locationId, departmentKey, key, String(value));
  }
}

function validatePdfText(value, fieldName, { min = 1, max = 80 } = {}) {
  const text = String(value || "").trim();
  if (!text) throw httpError(400, `Bitte ${fieldName} eingeben.`);
  if (text.length < min || text.length > max) {
    throw httpError(400, `${fieldName} muss zwischen ${min} und ${max} Zeichen lang sein.`);
  }
  return text;
}

function validateBrandText(value, fallback, max = 100) {
  const text = String(value ?? "").replace(/[\x00-\x1F]/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, max) || fallback;
}

function validateBrandOptionalText(value, max = 120) {
  return String(value ?? "").replace(/[\x00-\x1F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function validateBrandLogoUrl(value, fallback = defaultBranding.logo_url) {
  const text = validateBrandOptionalText(value, 300) || fallback;
  if (/^javascript:/i.test(text)) throw httpError(400, "Die Logo-Adresse ist ungültig.");
  return text;
}

function validateBrandEmail(value) {
  const text = validateBrandOptionalText(value, 180);
  if (text && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) throw httpError(400, "Bitte eine gültige Admin-E-Mail eingeben oder leer lassen.");
  return text;
}

function brandingValuesFromBody(body = {}) {
  return {
    branding_company_name: validateBrandOptionalText(body.companyName ?? body.brandingCompanyName ?? body.branding_company_name, 100),
    branding_logo_url: validateBrandLogoUrl(body.logoUrl ?? body.brandingLogoUrl ?? body.branding_logo_url),
    branding_icon_url: validateBrandLogoUrl(body.iconUrl ?? body.brandingIconUrl ?? body.branding_icon_url, defaultBranding.icon_url),
    branding_logo_alt: validateBrandText(body.logoAlt ?? body.brandingLogoAlt ?? body.branding_logo_alt, defaultBranding.logo_alt, 120),
    branding_admin_email: validateBrandEmail(body.adminEmail ?? body.brandingAdminEmail ?? body.branding_admin_email),
  };
}

function brandingKitFromSettings(settings = getSettings()) {
  const branding = brandingFromSettings(settings);
  return {
    format: "grabenplaner-branding-kit",
    version: 1,
    exportedAt: new Date().toISOString(),
    branding,
    pdf: {
      scheduleTitle: settings.pdf_title || defaultSettings.pdf_title,
      scheduleFilenamePrefix: settings.pdf_filename_prefix || defaultSettings.pdf_filename_prefix,
      vacationTitle: settings.vacation_pdf_title || defaultSettings.vacation_pdf_title,
      vacationFilenamePrefix: settings.vacation_pdf_filename_prefix || defaultSettings.vacation_pdf_filename_prefix,
    },
  };
}

function runPowerShell(command, args = []) {
  const invocation = `${String(command || "").trim()}${args.length ? ` ${args.map((value) => `'${String(value ?? "").replaceAll("'", "''")}'`).join(" ")}` : ""}`;
  return childProcess.execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", invocation],
    { stdio: "pipe", windowsHide: true },
  );
}

function createZipArchive(sourcePath, zipPath) {
  runPowerShell(
    "& { param($sourcePath, $zipPath) $ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath $sourcePath -DestinationPath $zipPath -Force }",
    [sourcePath, zipPath],
  );
}

function inspectZipArchive(zipPath, {
  maximumEntries = 300,
  maximumUncompressedBytes = 75 * 1024 * 1024,
  maximumEntryBytes = 20 * 1024 * 1024,
  maximumPathLength = 240,
  maximumPathDepth = 12,
  maximumSegmentLength = 100,
} = {}) {
  const output = runPowerShell(`
& {
  param($zipPath)
  $ErrorActionPreference = 'Stop'
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $count = 0
    [Int64]$total = 0
    [Int64]$largest = 0
    $unsafe = $false
    $unsafeName = $false
    foreach ($entry in $archive.Entries) {
      $count += 1
      [Int64]$length = $entry.Length
      $total += $length
      if ($length -gt $largest) { $largest = $length }
      $name = ([string]$entry.FullName).Replace('\\', '/')
      if ([System.IO.Path]::IsPathRooted($name) -or $name -match '^[A-Za-z]:' -or @($name.Split('/') | Where-Object { $_ -eq '..' }).Count -gt 0) { $unsafe = $true }
      $segments = @($name.Split('/') | Where-Object { $_ -ne '' })
      if ($name.Length -gt ${Number(maximumPathLength)} -or $segments.Count -gt ${Number(maximumPathDepth)} -or @($segments | Where-Object { $_.Length -gt ${Number(maximumSegmentLength)} -or $_ -match ':' }).Count -gt 0) { $unsafeName = $true }
    }
    [PSCustomObject]@{ entries = $count; totalBytes = $total; largestBytes = $largest; unsafePath = $unsafe; unsafeName = $unsafeName } | ConvertTo-Json -Compress
  } finally {
    $archive.Dispose()
  }
}
`, [zipPath]).toString("utf8").replace(/^\uFEFF/, "").trim();
  let inspection;
  try { inspection = JSON.parse(output); }
  catch { throw httpError(400, "Die Branding-ZIP-Datei konnte nicht sicher geprüft werden.", "BRANDING_ARCHIVE_INVALID"); }
  if (inspection.unsafePath || inspection.unsafeName || Number(inspection.entries) > maximumEntries
    || Number(inspection.totalBytes) > maximumUncompressedBytes
    || Number(inspection.largestBytes) > maximumEntryBytes) {
    throw httpError(400, "Die Branding-ZIP-Datei ist zu groß oder enthält unzulässige Pfade.", "BRANDING_ARCHIVE_LIMIT");
  }
  return inspection;
}

function validateExtractedBrandingArchive(extractPath, limits = {}) {
  const maximumEntries = Number(limits.maximumEntries || 300);
  const maximumUncompressedBytes = Number(limits.maximumUncompressedBytes || 75 * 1024 * 1024);
  const maximumPathLength = Number(limits.maximumPathLength || 240);
  const maximumPathDepth = Number(limits.maximumPathDepth || 12);
  const maximumSegmentLength = Number(limits.maximumSegmentLength || 100);
  let entries = 0;
  let totalBytes = 0;
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > maximumEntries) throw httpError(400, "Die Branding-ZIP-Datei enthält zu viele Dateien.", "BRANDING_ARCHIVE_LIMIT");
      const entryPath = path.join(directory, entry.name);
      const relativePath = path.relative(extractPath, entryPath);
      const segments = relativePath.split(path.sep).filter(Boolean);
      if (relativePath.length > maximumPathLength || segments.length > maximumPathDepth
        || segments.some((segment) => segment.length > maximumSegmentLength || segment.includes(":"))) {
        throw httpError(400, "Die Branding-ZIP-Datei enthält unzulässig lange oder tiefe Pfade.", "BRANDING_ARCHIVE_LIMIT");
      }
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) throw httpError(400, "Verknüpfungen sind in Branding-Kits nicht erlaubt.", "BRANDING_ARCHIVE_LINK");
      if (stat.isDirectory()) walk(entryPath);
      else if (stat.isFile()) {
        totalBytes += stat.size;
        if (totalBytes > maximumUncompressedBytes) throw httpError(400, "Die Branding-ZIP-Datei ist entpackt zu groß.", "BRANDING_ARCHIVE_LIMIT");
      }
    }
  };
  walk(extractPath);
}

function extractZipArchive(zipPath, extractPath) {
  const limits = {
    maximumEntries: 300,
    maximumUncompressedBytes: 75 * 1024 * 1024,
    maximumEntryBytes: 20 * 1024 * 1024,
    maximumPathLength: 240,
    maximumPathDepth: 12,
    maximumSegmentLength: 100,
  };
  inspectZipArchive(zipPath, limits);
  runPowerShell(
    "& { param($zipPath, $extractPath) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath -Force }",
    [zipPath, extractPath],
  );
  validateExtractedBrandingArchive(extractPath, limits);
}

function walkFiles(directory) {
  const result = [];
  if (!fs.existsSync(directory)) return result;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(entryPath));
    if (entry.isFile()) result.push(entryPath);
  }
  return result;
}

function safeBrandingAssetFilename(fileName) {
  const extension = path.extname(String(fileName || "")).toLowerCase();
  if (![".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico"].includes(extension)) {
    throw httpError(400, "Das Branding-Logo muss eine Bilddatei sein.");
  }
  const base = path.basename(String(fileName || "branding-logo"), extension)
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "branding-logo";
  return `${base}${extension}`;
}

function findKitJsonFile(extractPath) {
  const files = walkFiles(extractPath);
  return files.find((file) => path.basename(file).toLowerCase() === "branding-kit.json")
    || files.find((file) => path.basename(file).toLowerCase() === "grabenplaner-branding-kit.json")
    || files.find((file) => path.extname(file).toLowerCase() === ".json");
}

function findBrandingAssetFile(extractPath, kit) {
  const files = walkFiles(extractPath);
  const candidates = [
    kit.assets?.logo,
    kit.logoAsset,
    kit.branding?.logoAsset,
    kit.branding?.logoFile,
    kit.branding?.logoUrl,
  ].filter(Boolean).map((value) => String(value).replace(/\\/g, "/"));
  for (const candidate of candidates) {
    const baseName = path.basename(candidate);
    if (!baseName || /^https?:/i.test(candidate)) continue;
    const found = files.find((file) => path.basename(file).toLowerCase() === baseName.toLowerCase());
    if (found) return found;
  }
  return files.find((file) => ["assets", "logo"].some((part) => file.toLowerCase().includes(part))
    && [".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico"].includes(path.extname(file).toLowerCase()));
}

function findBrandingIconFile(extractPath, kit) {
  const files = walkFiles(extractPath);
  const candidates = [
    kit.assets?.icon,
    kit.assets?.favicon,
    kit.assets?.webicon,
    kit.iconAsset,
    kit.branding?.iconAsset,
    kit.branding?.iconFile,
    kit.branding?.iconUrl,
  ].filter(Boolean).map((value) => String(value).replace(/\\/g, "/"));
  for (const candidate of candidates) {
    const baseName = path.basename(candidate);
    if (!baseName || /^https?:/i.test(candidate)) continue;
    const found = files.find((file) => path.basename(file).toLowerCase() === baseName.toLowerCase());
    if (found) return found;
  }
  return files.find((file) => ["webicon", "favicon", "icon"].some((part) => path.basename(file).toLowerCase().includes(part))
    && [".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico"].includes(path.extname(file).toLowerCase()));
}

function importBrandingAssetFromZip(extractPath, kit, brandingValues) {
  const assetFile = findBrandingAssetFile(extractPath, kit);
  if (!assetFile) return brandingValues;
  const targetDirectory = path.join(__dirname, "public", "assets", "branding");
  fs.mkdirSync(targetDirectory, { recursive: true });
  const safeName = safeBrandingAssetFilename(path.basename(assetFile));
  const targetPath = path.join(targetDirectory, safeName);
  fs.copyFileSync(assetFile, targetPath);
  return {
    ...brandingValues,
    branding_logo_url: `/assets/branding/${safeName}`,
  };
}

function applyBrandingKit(kit, contextInput = {}, actor = "", { manageTransaction = true } = {}) {
  const brandingSource = kit.branding || kit;
  const pdfSource = kit.pdf || {};
  const brandingValues = brandingValuesFromBody(brandingSource);
  const scheduleContext = resolvePlanningContext(contextInput);
  const vacationContext = resolvePlanningContext({ ...contextInput, departmentId: null, department: null });
  const scheduleTitle = pdfSource.scheduleTitle ? validatePdfText(pdfSource.scheduleTitle, "den Dienstplan-PDF-Titel") : null;
  const schedulePrefix = pdfSource.scheduleFilenamePrefix ? validatePdfText(pdfSource.scheduleFilenamePrefix, "der Dienstplan-PDF-Dateiname", { min: 5, max: 80 }) : null;
  const vacationTitle = pdfSource.vacationTitle ? validatePdfText(pdfSource.vacationTitle, "den Urlaubsplaner-PDF-Titel") : null;
  const vacationPrefix = pdfSource.vacationFilenamePrefix ? validatePdfText(pdfSource.vacationFilenamePrefix, "der Urlaubsplaner-PDF-Dateiname", { min: 5, max: 80 }) : null;
  if (manageTransaction) db.exec("BEGIN");
  try {
    saveLocationBrandingSnapshot(scheduleContext.locationId, kit.id || "custom", brandingValues, actor);
    const scheduleValues = {};
    if (scheduleTitle) {
      scheduleValues.pdf_title = scheduleTitle;
    }
    if (schedulePrefix) {
      scheduleValues.pdf_filename_prefix = schedulePrefix;
    }
    const vacationValues = {};
    if (vacationTitle) {
      vacationValues.vacation_pdf_title = vacationTitle;
    }
    if (vacationPrefix) {
      vacationValues.vacation_pdf_filename_prefix = vacationPrefix;
    }
    if (Object.keys(scheduleValues).length) saveScopedPdfSettings("schedule", scheduleContext, scheduleValues);
    if (Object.keys(vacationValues).length) saveScopedPdfSettings("vacation", vacationContext, vacationValues);
    if (manageTransaction) db.exec("COMMIT");
  } catch (error) {
    if (manageTransaction) db.exec("ROLLBACK");
    throw error;
  }
  const settings = settingsForLocation(scheduleContext.locationId);
  return { ok: true, settings, branding: brandingFromSettings(settings), locationId: scheduleContext.locationId };
}

function brandingKitForExport(requestQuery) {
  const scheduleContext = resolvePlanningContext(requestQuery);
  const vacationContext = resolvePlanningContext({ ...requestQuery, departmentId: null, department: null });
  const baseSettings = settingsForLocation(scheduleContext.locationId);
  const scheduleSettings = applyScopedPdfSettings(baseSettings, scheduleContext, "schedule");
  const vacationSettings = applyScopedPdfSettings(baseSettings, vacationContext, "vacation");
  return brandingKitFromSettings({
    ...baseSettings,
    pdf_title: scheduleSettings.pdf_title,
    pdf_filename_prefix: scheduleSettings.pdf_filename_prefix,
    vacation_pdf_title: vacationSettings.vacation_pdf_title,
    vacation_pdf_filename_prefix: vacationSettings.vacation_pdf_filename_prefix,
  });
}

function localAssetPathFromUrl(logoUrl) {
  const text = String(logoUrl || "");
  if (text.startsWith("/branding-kits/") && !text.includes("..")) {
    const assetPath = path.join(dataDirectory, ...text.split("/").filter(Boolean).slice(1));
    const normalizedAssetPath = path.resolve(assetPath);
    if (!normalizedAssetPath.startsWith(path.resolve(brandingKitsDirectory))) return null;
    return fs.existsSync(normalizedAssetPath) ? normalizedAssetPath : null;
  }
  if (!text.startsWith("/assets/") || text.includes("..")) return null;
  const assetPath = path.join(__dirname, "public", ...text.split("/").filter(Boolean));
  const normalizedAssetsRoot = path.join(__dirname, "public", "assets");
  const normalizedAssetPath = path.resolve(assetPath);
  if (!normalizedAssetPath.startsWith(path.resolve(normalizedAssetsRoot))) return null;
  return fs.existsSync(normalizedAssetPath) ? normalizedAssetPath : null;
}

function writeBrandingKitZip(kit, zipPath) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-branding-export-"));
  const kitRoot = path.join(tempRoot, "grabenplaner-branding-kit");
  const assetsRoot = path.join(kitRoot, "assets");
  fs.mkdirSync(assetsRoot, { recursive: true });
  const logoPath = localAssetPathFromUrl(kit.branding?.logoUrl);
  if (logoPath) {
    const safeName = safeBrandingAssetFilename(path.basename(logoPath));
    fs.copyFileSync(logoPath, path.join(assetsRoot, safeName));
    kit.assets = { ...(kit.assets || {}), logo: `assets/${safeName}` };
    kit.branding.logoUrl = `/assets/branding/${safeName}`;
  }
  const iconPath = localAssetPathFromUrl(kit.branding?.iconUrl);
  if (iconPath) {
    const safeName = safeBrandingAssetFilename(path.basename(iconPath));
    fs.copyFileSync(iconPath, path.join(assetsRoot, safeName));
    kit.assets = { ...(kit.assets || {}), icon: `assets/${safeName}` };
    kit.branding.iconUrl = `/assets/branding/${safeName}`;
  }
  fs.writeFileSync(path.join(kitRoot, "branding-kit.json"), JSON.stringify(kit, null, 2), "utf8");
  createZipArchive(kitRoot, zipPath);
  return tempRoot;
}

function slugifyKitPart(value, fallback = "branding-kit") {
  return String(value || fallback)
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/_+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase()
    .slice(0, 48) || fallback;
}

function brandingKitName(kit = {}) {
  return String(kit.name || kit.branding?.companyName || kit.branding?.company_name || kit.branding?.logoAlt || "Branding-Kit").trim() || "Branding-Kit";
}

function copyKitAssetToLibrary(assetFile, kitDirectory, kitId) {
  if (!assetFile) return "";
  const assetsDirectory = path.join(kitDirectory, "assets");
  fs.mkdirSync(assetsDirectory, { recursive: true });
  const safeName = safeBrandingAssetFilename(path.basename(assetFile));
  fs.copyFileSync(assetFile, path.join(assetsDirectory, safeName));
  return `/branding-kits/${encodeURIComponent(kitId)}/assets/${encodeURIComponent(safeName)}`;
}

function installBrandingKit(kit, { extractPath = "", fileName = "" } = {}) {
  const sourceName = brandingKitName(kit);
  const kitId = `${slugifyKitPart(sourceName)}-${backupTimestamp().replace(/[^0-9A-Za-z-]/g, "").slice(0, 17)}`;
  const kitDirectory = path.join(brandingKitsDirectory, kitId);
  fs.mkdirSync(kitDirectory, { recursive: true });

  const installedKit = {
    ...kit,
    id: kitId,
    name: sourceName,
    installedAt: new Date().toISOString(),
    sourceFile: validateBrandOptionalText(fileName, 180),
    branding: { ...(kit.branding || kit) },
    assets: { ...(kit.assets || {}) },
  };
  installedKit.branding.appName = defaultBranding.app_name;

  if (extractPath) {
    const logoFile = findBrandingAssetFile(extractPath, kit);
    const iconFile = findBrandingIconFile(extractPath, kit);
    const logoUrl = copyKitAssetToLibrary(logoFile, kitDirectory, kitId);
    const iconUrl = copyKitAssetToLibrary(iconFile, kitDirectory, kitId);
    if (logoUrl) {
      installedKit.branding.logoUrl = logoUrl;
      installedKit.assets.logo = logoUrl;
    }
    if (iconUrl) {
      installedKit.branding.iconUrl = iconUrl;
      installedKit.assets.icon = iconUrl;
    }
  }

  fs.writeFileSync(path.join(kitDirectory, "manifest.json"), JSON.stringify(installedKit, null, 2), "utf8");
  return installedKit;
}

function neutralBrandingKit() {
  return {
    id: "neutral",
    name: "Grabenplaner Standard",
    builtin: true,
    branding: {
      appName: defaultBranding.app_name,
      companyName: defaultBranding.company_name,
      logoUrl: defaultBranding.logo_url,
      iconUrl: defaultBranding.icon_url,
      logoAlt: defaultBranding.logo_alt,
      adminEmail: defaultBranding.admin_email,
    },
    pdf: {
      scheduleTitle: defaultSettings.pdf_title,
      scheduleFilenamePrefix: defaultSettings.pdf_filename_prefix,
      vacationTitle: defaultSettings.vacation_pdf_title,
      vacationFilenamePrefix: defaultSettings.vacation_pdf_filename_prefix,
    },
  };
}

function readBrandingKitManifest(kitId) {
  if (kitId === "neutral") return neutralBrandingKit();
  if (!/^[a-z0-9-]+$/i.test(String(kitId || ""))) throw httpError(400, "Ungültiges Branding-Kit.");
  const manifestPath = path.join(brandingKitsDirectory, kitId, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw httpError(404, "Branding-Kit wurde nicht gefunden.");
  return JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
}

function listBrandingKits(locationId = "") {
  const assignment = locationId ? locationBrandingRow(locationId) : null;
  const current = locationId ? brandingForLocation(locationId) : brandingFromSettings(getSettings());
  const kits = [neutralBrandingKit()];
  for (const entry of fs.readdirSync(brandingKitsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      kits.push(readBrandingKitManifest(entry.name));
    } catch {}
  }
  return kits.map((kit) => {
    const branding = brandingFromSettings(kit.branding || {});
    return {
      id: kit.id || "neutral",
      name: kit.name || branding.companyName || "Branding-Kit",
      builtin: Boolean(kit.builtin),
      installedAt: kit.installedAt || "",
      branding,
      pdf: kit.pdf || {},
      active: assignment?.kit_id
        ? String(kit.id || "neutral") === assignment.kit_id
        : branding.logoUrl === current.logoUrl
          && branding.iconUrl === current.iconUrl
          && branding.companyName === current.companyName
          && branding.adminEmail === current.adminEmail,
    };
  }).sort((a, b) => Number(b.builtin) - Number(a.builtin) || String(a.name).localeCompare(String(b.name), "de"));
}

function validateBrandingAssignmentInput(input = {}) {
  const locationId = normalizeLocationId(input.locationId || input.location);
  validateLocationExists(locationId);
  const kitId = String(input.kitId ?? "").trim();
  if (kitId && kitId !== "custom") readBrandingKitManifest(kitId);
  if (kitId === "custom" && !input.branding) {
    throw httpError(400, "Fuer ein individuelles Branding fehlen die Branding-Daten.", "BRANDING_ASSIGNMENT_INVALID");
  }
  return { locationId, kitId, branding: input.branding || input };
}

function applyBrandingAssignment(input, actor, { manageTransaction = true } = {}) {
  const assignment = validateBrandingAssignmentInput(input);
  let result;
  if (!assignment.kitId) {
    db.prepare("DELETE FROM location_branding WHERE location_id = ?").run(assignment.locationId);
    result = {
      ok: true,
      locationId: assignment.locationId,
      settings: settingsForLocation(assignment.locationId),
      branding: brandingForLocation(assignment.locationId),
    };
  } else if (assignment.kitId === "custom") {
    const branding = saveLocationBrandingSnapshot(assignment.locationId, "custom", assignment.branding, actor.employeeNumber);
    result = { ok: true, locationId: assignment.locationId, settings: settingsForLocation(assignment.locationId), branding };
  } else {
    const kit = readBrandingKitManifest(assignment.kitId);
    result = applyBrandingKit(kit, { locationId: assignment.locationId }, actor.employeeNumber, { manageTransaction });
  }
  auditPortal(actor.employeeNumber, "branding.assignment.update", "location", assignment.locationId, JSON.stringify({ kitId: assignment.kitId || "default" }));
  return result;
}

function deleteInstalledBrandingKit(kitId, actor = "") {
  const normalizedKitId = String(kitId || "").trim();
  if (normalizedKitId === "neutral") throw httpError(400, "Das Standard-Branding kann nicht geloescht werden.", "BRANDING_KIT_BUILTIN");
  const kit = readBrandingKitManifest(normalizedKitId);
  const assignedLocations = db.prepare(`
    SELECT lb.location_id, l.name AS location_name
    FROM location_branding lb
    LEFT JOIN locations l ON l.id = lb.location_id
    WHERE lb.kit_id = ?
    ORDER BY lb.location_id
  `).all(normalizedKitId);
  const selectedForManagement = String(getSettings().branding_management_kit_id || "") === normalizedKitId;
  if (assignedLocations.length || selectedForManagement) {
    const locations = assignedLocations.map((row) => `${row.location_id}${row.location_name ? ` ${row.location_name}` : ""}`);
    const error = httpError(409, "Das Branding-Kit ist noch in Verwendung und kann erst nach dem Aufheben der Zuordnung geloescht werden.", "BRANDING_KIT_IN_USE");
    error.details = { locations, selectedForManagement };
    throw error;
  }
  const kitDirectory = path.resolve(brandingKitsDirectory, normalizedKitId);
  const libraryRoot = path.resolve(brandingKitsDirectory);
  if (!kitDirectory.startsWith(`${libraryRoot}${path.sep}`) || !fs.existsSync(kitDirectory)) {
    throw httpError(404, "Branding-Kit wurde nicht gefunden.");
  }
  const stagedDirectory = `${kitDirectory}.deleting-${crypto.randomUUID()}`;
  fs.renameSync(kitDirectory, stagedDirectory);
  try {
    auditPortal(actor, "branding.kit.delete", "branding_kit", normalizedKitId, JSON.stringify({ name: brandingKitName(kit) }));
    fs.rmSync(stagedDirectory, { recursive: true, force: true });
  } catch (error) {
    if (fs.existsSync(stagedDirectory) && !fs.existsSync(kitDirectory)) fs.renameSync(stagedDirectory, kitDirectory);
    throw error;
  }
  return { id: normalizedKitId, name: brandingKitName(kit) };
}

function employeeLocationFilterSql(context, alias = "e") {
  const prefix = alias ? `${alias}.` : "";
  const sql = [`${prefix}home_location_id = ?`];
  const values = [context.locationId];
  if (context.departmentId) {
    sql.push(`${prefix}preferred_department_id = ?`);
    values.push(context.departmentId);
  }
  return { sql: sql.join(" AND "), values };
}

function scheduleEmployeeFilterSql(context, weekStart, weekEnd, alias = "e") {
  const prefix = alias ? `${alias}.` : "";
  if (!context.departmentId) return employeeLocationFilterSql(context, alias);
  return {
    sql: `${prefix}home_location_id = ? AND (${prefix}preferred_department_id = ? OR EXISTS (
      SELECT 1
      FROM shifts sx
      WHERE sx.employee_number = ${prefix}personnel_number
        AND sx.shift_date BETWEEN ? AND ?
        AND sx.department_id = ?
    ))`,
    values: [context.locationId, context.departmentId, weekStart, weekEnd, context.departmentId],
  };
}

function resolveBackupDirectory(value) {
  const raw = String(value || defaultBackupDirectorySetting).trim()
    .replace(/%GRABENPLANER_ROOT%/gi, path.basename(__dirname).toLowerCase() === "app" ? path.dirname(__dirname) : __dirname)
    .replace(/%USERPROFILE%/gi, os.homedir())
    .replace(/%HOME%/gi, os.homedir());
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function backupDirectoryFromSettings(settings = getSettings()) {
  return process.env.BACKUP_DIR || resolveBackupDirectory(settings.backup_directory || defaultBackupDirectorySetting);
}

function validateBackupDirectory(value) {
  const stored = String(value || "").trim();
  if (!stored) throw httpError(400, "Bitte einen Backup-Ordner angeben.");
  const backupDirectory = process.env.BACKUP_DIR || resolveBackupDirectory(stored);
  if (!path.isAbsolute(backupDirectory)) {
    throw httpError(400, "Bitte einen vollständigen Backup-Pfad angeben.");
  }
  fs.mkdirSync(backupDirectory, { recursive: true });
  fs.accessSync(backupDirectory, fs.constants.W_OK);
  return { stored: process.env.BACKUP_DIR || stored, resolved: backupDirectory };
}

function backupIntervalMs(settings = getSettings()) {
  const hours = Number(settings.backup_interval_hours || 2);
  return Math.min(6, Math.max(1, Number.isFinite(hours) ? hours : 2)) * 60 * 60 * 1000;
}

function scheduleAutomaticBackups() {
  if (backupInterval) clearInterval(backupInterval);
  backupInterval = setInterval(() => {
    try {
      const settings = getSettings();
      const backup = createExternalDatabaseBackup("scheduled", settings);
      if (backup) {
        lastBackup = {
          path: backup.path,
          createdAt: backup.createdAt,
          reason: "scheduled",
          appBackup: lastBackup?.appBackup || null,
          externalBackup: backup,
        };
      }
    } catch (error) {
      console.error("Backup konnte nicht erstellt werden:", error);
    }
  }, backupIntervalMs());
  backupInterval.unref();
}

const dayKeyByNumber = {
  1: "monday",
  2: "tuesday",
  3: "wednesday",
  4: "thursday",
  5: "friday",
  6: "saturday",
};

function dayKeyForDate(isoDate) {
  return dayKeyByNumber[new Date(`${isoDate}T12:00:00Z`).getUTCDay()] || null;
}

function parseFixedWorkdays(value) {
  return String(value || "")
    .split(",")
    .map((day) => day.trim())
    .filter(Boolean);
}

function normalizeFixedWorkdays(value) {
  const submitted = Array.isArray(value) ? value : parseFixedWorkdays(value);
  const normalized = [...new Set(submitted.map((day) => String(day || "").trim()).filter(Boolean))];
  if (!normalized.every((day) => fixedWorkdayKeys.includes(day))) {
    throw httpError(400, "Die fixen Arbeitstage sind ungültig.");
  }
  return normalized;
}

function employeeCanWorkOnDate(employee, isoDate) {
  const fixedDays = parseFixedWorkdays(employee.fixed_workdays);
  return fixedDays.length === 0 || fixedDays.includes(dayKeyForDate(isoDate));
}

function dayConfiguration(isoDate, settings, context = null) {
  const key = dayKeyForDate(isoDate);
  if (!key) return null;
  const configuredMinStaff = Number(settings[`${key}_min_staff`] || 0);
  const contextMinStaff = context ? staffingFloorForContext(context) : 0;
  return {
    key,
    open: settings[`${key}_open`] !== "0",
    start: settings[`${key}_start_time`],
    end: settings[`${key}_end_time`],
    lunchEnabled: settingEnabled(settings, `${key}_lunch_enabled`),
    lunchStart: settings[`${key}_lunch_start`],
    lunchEnd: settings[`${key}_lunch_end`],
    minStaff: Math.max(configuredMinStaff, contextMinStaff),
    configuredMinStaff,
    contextMinStaff,
    minFrom: settings[`${key}_min_from`],
    minTo: settings[`${key}_min_to`],
  };
}

function operatingHours(isoDate, settings) {
  const config = dayConfiguration(isoDate, settings);
  return config?.open ? { start: config.start, end: config.end } : null;
}

function serializeGlobalDayBlock(row) {
  const holidayName = publicHolidayName(row.block_date);
  return {
    ...row,
    location_id: row.location_id || "01",
    is_public_holiday: Boolean(row.is_public_holiday),
    holiday_name: holidayName,
  };
}

function getGlobalDayBlocksForRange(start, end, locationId = null) {
  const locationFilter = locationId ? "AND location_id = ?" : "";
  const params = locationId ? [start, end, locationId] : [start, end];
  return db
    .prepare(`
      SELECT id, location_id, week_start, block_date, reason, is_public_holiday, created_at
      FROM global_day_blocks
      WHERE block_date BETWEEN ? AND ?
        ${locationFilter}
      ORDER BY block_date
    `)
    .all(...params)
    .map(serializeGlobalDayBlock);
}

function getGlobalDayBlockForDate(isoDate, locationId = null) {
  const locationFilter = locationId ? "AND location_id = ?" : "";
  const params = locationId ? [isoDate, locationId] : [isoDate];
  const row = db
    .prepare(`
      SELECT id, location_id, week_start, block_date, reason, is_public_holiday, created_at
      FROM global_day_blocks
      WHERE block_date = ?
        ${locationFilter}
    `)
    .get(...params);
  return row ? serializeGlobalDayBlock(row) : null;
}

function publicHolidaysForRange(start, end) {
  const holidays = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const name = publicHolidayName(date);
    if (name) holidays.push({ date, name });
  }
  return holidays;
}

function isVacationHoliday(isoDate, locationId = null) {
  if (publicHolidayName(isoDate)) return true;
  const block = getGlobalDayBlockForDate(isoDate, locationId);
  return Boolean(block?.is_public_holiday);
}

function holidayCreditMinutes(employee) {
  return Math.round((Number(employee.contracted_hours || 0) * 60) / 5);
}

function overlapMinutes(start, end, rangeStart, rangeEnd) {
  return Math.max(0, Math.min(end, rangeEnd) - Math.max(start, rangeStart));
}

function overlappingWeekOption(employeeNumber, date, startTime, endTime) {
  return db.prepare(`
    SELECT o.*, e.nickname
    FROM week_options o
    JOIN employees e ON e.personnel_number = o.employee_number
    WHERE o.employee_number = ? AND ? BETWEEN o.date_from AND o.date_to
    ORDER BY o.all_day DESC, o.start_time
  `).all(employeeNumber, date)
    .find((option) => optionOverlapsTime(option, startTime, endTime));
}

function shiftMetrics(shift, settings) {
  const start = timeToMinutes(shift.start_time);
  let end = timeToMinutes(shift.end_time);
  if (end <= start) end += 24 * 60;
  const rawMinutes = end - start;
  const ruleBreakMinutes =
    settingEnabled(settings, "break_rule_enabled") &&
    rawMinutes > Number(settings.break_after_minutes)
      ? Number(settings.break_duration_minutes)
      : 0;
  const dayConfig = dayConfiguration(shift.shift_date, settings);
  const lunchBreakMinutes = dayConfig?.lunchEnabled
    ? overlapMinutes(
        start,
        end,
        timeToMinutes(dayConfig.lunchStart),
        timeToMinutes(dayConfig.lunchEnd),
      )
    : 0;
  const breakMinutes = Math.max(ruleBreakMinutes, lunchBreakMinutes);

  let countedMinutes = rawMinutes - breakMinutes;
  let bonusMinutes = 0;
  const isSaturday = new Date(`${shift.shift_date}T12:00:00Z`).getUTCDay() === 6;

  if (isSaturday && settingEnabled(settings, "saturday_bonus_enabled")) {
    const bonusStart = timeToMinutes(settings.saturday_bonus_from);
    let eligibleMinutes = Math.max(0, end - Math.max(start, bonusStart));
    if (dayConfig?.lunchEnabled) {
      eligibleMinutes -= overlapMinutes(
        Math.max(start, bonusStart),
        end,
        timeToMinutes(dayConfig.lunchStart),
        timeToMinutes(dayConfig.lunchEnd),
      );
    }
    bonusMinutes = Math.round(eligibleMinutes * (Number(settings.saturday_bonus_factor) - 1));
    countedMinutes += bonusMinutes;
  }

  return {
    raw_minutes: rawMinutes,
    break_minutes: breakMinutes,
    lunch_break_minutes: lunchBreakMinutes,
    bonus_minutes: bonusMinutes,
    counted_minutes: countedMinutes,
  };
}

function serializeEmployee(row, options = {}) {
  const serialized = {
    ...row,
    fixed_workdays: row.fixed_workdays || "",
    position_id: row.position_id || "verkaufsmitarbeiter",
    position_name: row.position_name || "Verkaufsmitarbeiter",
    time_confirmation_level: ["A", "B", "C"].includes(String(row.time_confirmation_level || "").toUpperCase())
      ? String(row.time_confirmation_level).toUpperCase()
      : "C",
    home_location_id: row.home_location_id || "",
    home_location_name: row.home_location_name || "",
    preferred_department_id: row.preferred_department_id ? Number(row.preferred_department_id) : null,
    preferred_department_name: row.preferred_department_name || "",
    active: Boolean(row.active),
  };
  if (options.includeTimeConfirmationLevel === false) delete serialized.time_confirmation_level;
  return serialized;
}

function validateEmployee(body, isNew, options = {}) {
  const personnelNumber = String(body.personnelNumber || "").trim();
  const fullName = String(body.fullName || "").trim();
  const nickname = String(body.nickname || "").trim();
  const color = /^#[0-9a-f]{6}$/i.test(body.color || "") ? body.color : "#0b84c6";
  const contractedHours = Number(body.contractedHours);
  const preferredDayOff = String(body.preferredDayOff || "").trim();
  const fixedWorkdays = normalizeFixedWorkdays(body.fixedWorkdays ?? body.fixed_workdays);
  const positionId = String(body.positionId || body.position_id || "verkaufsmitarbeiter").trim() || "verkaufsmitarbeiter";
  const submittedTimeConfirmationLevel = body.timeConfirmationLevel ?? body.time_confirmation_level
    ?? options.defaultTimeConfirmationLevel ?? "C";
  const timeConfirmationLevel = String(submittedTimeConfirmationLevel).trim().toUpperCase();
  const allowedPreferredDays = ["", "monday", "tuesday", "wednesday", "thursday", "friday"];
  const homeLocationId = normalizeLocationId(body.homeLocationId || body.home_location_id || "01");
  validateLocationExists(homeLocationId);
  const preferredDepartmentId = normalizeDepartmentId(body.preferredDepartmentId ?? body.preferred_department_id, true);
  if (preferredDepartmentId) validateDepartmentExists(preferredDepartmentId, homeLocationId);
  if (!db.prepare("SELECT 1 FROM positions WHERE id = ?").get(positionId)) {
    throw httpError(400, "Bitte eine gültige Position auswählen.");
  }

  if (isNew && !/^[A-Za-z0-9._-]{1,24}$/.test(personnelNumber)) {
    throw httpError(400, "Bitte eine gültige Personalnummer eingeben.");
  }
  if (!fullName) throw httpError(400, "Bitte den Namen eingeben.");
  if (!nickname) throw httpError(400, "Bitte den Dienstplan-Namen eingeben.");
  if (!Number.isFinite(contractedHours) || contractedHours < 0 || contractedHours > 80) {
    throw httpError(400, "Die Wochen-Sollzeit muss zwischen 0 und 80 Stunden liegen.");
  }
  if (!allowedPreferredDays.includes(preferredDayOff)) {
    throw httpError(400, "Der bevorzugte freie Tag ist ungültig.");
  }
  if (!["A", "B", "C"].includes(timeConfirmationLevel)) {
    throw httpError(400, "Bitte eine gültige Vertrauensstufe A, B oder C auswählen.", "EMPLOYEE_CONFIRMATION_LEVEL_INVALID");
  }

  return {
    personnelNumber,
    fullName,
    nickname,
    color,
    contractedHours,
    preferredDayOff: preferredDayOff || null,
    fixedWorkdays: fixedWorkdays.join(","),
    positionId,
    timeConfirmationLevel,
    homeLocationId,
    preferredDepartmentId,
    active: body.active === false ? 0 : 1,
  };
}

function validateShift(body) {
  const employeeNumber = String(body.employeeNumber || "").trim();
  const shiftDate = String(body.date || "");
  const startTime = String(body.startTime || "");
  const endTime = String(body.endTime || "");
  const area = String(body.area || "").trim();
  const note = String(body.note || "").trim();
  const departmentId = normalizeDepartmentId(body.departmentId ?? body.department_id, true);

  if (!employeeNumber) throw httpError(400, "Bitte ein Teammitglied auswählen.");
  if (!isIsoDate(shiftDate)) throw httpError(400, "Das Datum ist ungültig.");
  if (!isTime(startTime) || !isTime(endTime)) throw httpError(400, "Die Arbeitszeit ist ungültig.");
  const employee = db.prepare("SELECT nickname, fixed_workdays, home_location_id FROM employees WHERE personnel_number = ?").get(employeeNumber);
  if (!employee) {
    throw httpError(404, "Die ausgewählte Person wurde nicht gefunden.");
  }
  if (departmentId) validateDepartmentExists(departmentId, employee.home_location_id);
  if (!employeeCanWorkOnDate(employee, shiftDate)) {
    throw httpError(409, `${employee.nickname} hat an diesem Wochentag keinen fix vereinbarten Arbeitstag.`);
  }
  const settings = settingsForLocation(employee.home_location_id);
  assertDateEditable(shiftDate, settings);
  const globalBlock = getGlobalDayBlockForDate(shiftDate, employee.home_location_id);
  if (globalBlock) {
    throw httpError(409, `Dieser Tag ist für alle gesperrt: ${globalBlock.reason || globalBlock.holiday_name || "gesperrt"}.`);
  }
  const hours = operatingHours(shiftDate, settings);
  if (!hours) throw httpError(400, "An Sonntagen kann kein Dienst eingetragen werden.");
  if (startTime < hours.start || endTime > hours.end || endTime <= startTime) {
    throw httpError(
      400,
      `Der Dienst muss innerhalb der Dienstzeit ${hours.start}–${hours.end} Uhr liegen.`,
    );
  }
  const dayConfig = dayConfiguration(shiftDate, settings);
  if (
    dayConfig.lunchEnabled &&
    startTime >= dayConfig.lunchStart &&
    endTime <= dayConfig.lunchEnd
  ) {
    throw httpError(400, "Der Dienst liegt vollständig innerhalb der eingestellten Mittagspause.");
  }
  const conflict = overlappingWeekOption(employeeNumber, shiftDate, startTime, endTime);
  if (conflict) {
    throw httpError(
      409,
      `${conflict.nickname} ist zu dieser Zeit bereits als „${optionLabel(conflict.option_type)}“ eingetragen.`,
    );
  }
  if (activeSicknessEmployeeNumbers(shiftDate).has(employeeNumber)) {
    throw httpError(409, `${employee.nickname} ist an diesem Tag krankgemeldet.`, "SICKNESS_SHIFT_CONFLICT");
  }

  return { employeeNumber, departmentId, shiftDate, startTime, endTime, area, note };
}

const alwaysFullDayOptionTypes = new Set(["vacation", "sick", "branch", "vocational_school", "special_leave"]);
const timedOptionTypes = new Set(["school", "time_off", "external_appointment", "team_meeting", "other"]);
const manualAllDayCreditTypes = new Set(["school", "external_appointment", "team_meeting", "other"]);
const allowedWeekOptionTypes = [
  "vacation",
  "sick",
  "branch",
  "vocational_school",
  "school",
  "time_off",
  "special_leave",
  "external_appointment",
  "team_meeting",
  "other",
];

function optionIsAllDay(option) {
  return Number(option.all_day ?? 1) === 1;
}

function optionTimeRange(option) {
  if (optionIsAllDay(option)) return { start: "00:00", end: "23:59" };
  return { start: option.start_time, end: option.end_time };
}

function timeRangesOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function optionOverlapsTime(option, startTime, endTime) {
  if (optionIsAllDay(option)) return true;
  if (!isTime(option.start_time) || !isTime(option.end_time)) return true;
  return timeRangesOverlap(startTime, endTime, option.start_time, option.end_time);
}

function validateWeekOption(body, existingId = 0) {
  const employeeNumber = String(body.employeeNumber || "").trim();
  const weekStart = getMonday(String(body.weekStart || ""));
  const dateFrom = String(body.dateFrom || "");
  const dateTo = String(body.dateTo || "");
  const optionType = String(body.optionType || "");
  const note = String(body.note || "").trim();
  const allDay = alwaysFullDayOptionTypes.has(optionType) || body.allDay === true;
  const startTime = String(body.startTime || "");
  const endTime = String(body.endTime || "");
  const manualHours = body.manualHours === "" || body.manualHours === undefined
    ? null
    : Number(body.manualHours);

  const employee = db.prepare("SELECT home_location_id FROM employees WHERE personnel_number = ?").get(employeeNumber);
  if (!employee) {
    throw httpError(404, "Die ausgewählte Person wurde nicht gefunden.");
  }
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateTo < dateFrom) {
    throw httpError(400, "Bitte einen gültigen Zeitraum eingeben.");
  }
  if (dateFrom < weekStart || dateTo > addDays(weekStart, 6)) {
    throw httpError(400, "Der Zeitraum muss innerhalb der ausgewählten Woche liegen.");
  }
  assertWeekEditable(weekStart, settingsForLocation(employee.home_location_id));
  if (!allowedWeekOptionTypes.includes(optionType)) throw httpError(400, "Bitte eine gültige Option auswählen.");
  if (!alwaysFullDayOptionTypes.has(optionType) && !timedOptionTypes.has(optionType)) {
    throw httpError(400, "Bitte eine gültige Option auswählen.");
  }
  if (!allDay) {
    if (!isTime(startTime) || !isTime(endTime) || endTime <= startTime) {
      throw httpError(400, "Bitte eine gültige Uhrzeit für die Planungsoption eingeben.");
    }
  }
  if (allDay && manualAllDayCreditTypes.has(optionType)) {
    if (!Number.isFinite(manualHours) || manualHours < 0 || manualHours > 24) {
      throw httpError(400, "Bitte die anrechenbaren Stunden pro Tag zwischen 0 und 24 eingeben.");
    }
  }
  const overlappingOption = db.prepare(`
    SELECT id, all_day, start_time, end_time
    FROM week_options
    WHERE employee_number = ? AND date_from <= ? AND date_to >= ? AND id != ?
  `).all(employeeNumber, dateTo, dateFrom, Number(existingId || 0))
    .some((option) => allDay || optionOverlapsTime(option, startTime, endTime));
  if (overlappingOption) {
    throw httpError(409, "Für diesen Zeitraum ist bereits eine überschneidende Planungsoption eingetragen.");
  }
  const existingShift = db.prepare(`
    SELECT shift_date, start_time, end_time
    FROM shifts
    WHERE employee_number = ? AND shift_date BETWEEN ? AND ?
  `).all(employeeNumber, dateFrom, dateTo)
    .find((shift) => allDay || timeRangesOverlap(startTime, endTime, shift.start_time, shift.end_time));
  if (existingShift) {
    throw httpError(
      409,
      `Für ${existingShift.shift_date} ist bereits ein Dienst von ${existingShift.start_time} bis ${existingShift.end_time} Uhr eingetragen.`,
    );
  }

  return {
    employeeNumber,
    weekStart,
    dateFrom,
    dateTo,
    optionType,
    note,
    groupId: String(body.groupId || "").trim() || null,
    allDay: allDay ? 1 : 0,
    startTime: allDay ? null : startTime,
    endTime: allDay ? null : endTime,
    creditedMinutesPerDay: allDay && manualAllDayCreditTypes.has(optionType) ? Math.round(manualHours * 60) : null,
  };
}

function optionMinutesPerDay(option, contractedHours) {
  if (alwaysFullDayOptionTypes.has(option.option_type)) {
    return Math.round((Number(contractedHours) * 60) / 5);
  }
  if (option.option_type === "time_off") return 0;
  if (!optionIsAllDay(option) && isTime(option.start_time) && isTime(option.end_time)) {
    return Math.max(0, timeToMinutes(option.end_time) - timeToMinutes(option.start_time));
  }
  return Math.max(0, Number(option.credited_minutes_per_day || 0));
}

function vacationDayCount(dateFrom, dateTo, settings = getSettings(), locationId = null) {
  let days = 0;
  const countSaturday = settingEnabled(settings, "vacation_count_saturday");
  for (let date = dateFrom; date <= dateTo; date = addDays(date, 1)) {
    const day = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (day === 0) continue;
    if (day === 6 && !countSaturday) continue;
    if (isVacationHoliday(date, locationId)) continue;
    days += 1;
  }
  return days;
}

function countCreditedOptionDays(option, settings = getSettings(), locationId = null) {
  if (option.option_type === "vacation") {
    return vacationDayCount(option.date_from, option.date_to, settings, locationId);
  }
  let days = 0;
  for (let date = option.date_from; date <= option.date_to; date = addDays(date, 1)) {
    if (new Date(`${date}T12:00:00Z`).getUTCDay() !== 0) days += 1;
  }
  return optionIsAllDay(option) && alwaysFullDayOptionTypes.has(option.option_type) ? Math.min(days, 5) : days;
}

function hasNonVacationCreditOnDate(options, employeeNumber, date) {
  return options.some((option) =>
    option.employee_number === employeeNumber &&
    option.option_type !== "vacation" &&
    date >= option.date_from &&
    date <= option.date_to &&
    optionMinutesPerDay(option, option.contracted_hours) > 0,
  );
}

function countSaturdaysInRange(startDate, endDate) {
  if (!startDate || !endDate || startDate > endDate) return 0;
  let count = 0;
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
    if (new Date(`${date}T12:00:00Z`).getUTCDay() === 6) count += 1;
  }
  return count;
}

function saturdayShiftFilterSql(context, prefix = "s") {
  const clauses = [
    "strftime('%w', shift_date) = '6'",
    "((CAST(substr(end_time, 1, 2) AS INTEGER) * 60 + CAST(substr(end_time, 4, 2) AS INTEGER)) - (CAST(substr(start_time, 1, 2) AS INTEGER) * 60 + CAST(substr(start_time, 4, 2) AS INTEGER))) >= 120",
  ];
  if (context.departmentId) clauses.push(`${prefix}.department_id = ?`);
  return clauses.join(" AND ");
}

function buildSaturdayServiceStats(weekStart, context, employees, currentWeekShifts, settings) {
  const employeeNumbers = employees.map((employee) => employee.personnel_number);
  if (!employeeNumbers.length || !settingEnabled(settings, "show_saturday_service_stats")) {
    return { byEmployee: {}, estimated: false };
  }
  const employeeFilter = employeeLocationFilterSql(context, "e");
  const departmentValue = context.departmentId ? [context.departmentId] : [];
  const earliest = db.prepare(`
    SELECT MIN(s.shift_date) AS first_date
    FROM shifts s
    JOIN employees e ON e.personnel_number = s.employee_number
    WHERE e.active = 1 AND ${employeeFilter.sql}
      ${context.departmentId ? "AND s.department_id = ?" : ""}
  `).get(...employeeFilter.values, ...departmentValue)?.first_date;
  const saturdayDate = addDays(weekStart, 5);
  const currentSaturdayStaff = new Set(
    currentWeekShifts
      .filter((shift) => shift.shift_date === saturdayDate)
      .filter((shift) => (shift.raw_minutes || 0) >= 120)
      .map((shift) => shift.employee_number),
  ).size;
  const fallbackStaffPerSaturday = Math.max(
    currentSaturdayStaff,
    Math.min(employees.length, Math.max(2, Number(dayConfiguration(saturdayDate, settings, context)?.minStaff || 0))),
  );
  const fallbackPerEmployee = employees.length ? fallbackStaffPerSaturday / employees.length : 0;

  function statsForWindow(startDate, endDate) {
    const totalSaturdays = countSaturdaysInRange(startDate, endDate);
    const complete = Boolean(earliest && earliest <= startDate);
    const observedStart = earliest && earliest > startDate ? earliest : startDate;
    const observedSaturdays = earliest && observedStart <= endDate ? countSaturdaysInRange(observedStart, endDate) : 0;
    const values = Object.fromEntries(employeeNumbers.map((number) => [number, 0]));
    if (earliest && observedStart <= endDate) {
      const rows = db.prepare(`
        SELECT s.employee_number, COUNT(DISTINCT s.shift_date) AS count
        FROM shifts s
        JOIN employees e ON e.personnel_number = s.employee_number
        WHERE s.shift_date BETWEEN ? AND ?
          AND e.active = 1 AND ${employeeFilter.sql}
          AND ${saturdayShiftFilterSql(context, "s")}
        GROUP BY s.employee_number
      `).all(observedStart, endDate, ...employeeFilter.values, ...departmentValue);
      for (const row of rows) values[row.employee_number] = Number(row.count || 0);
    }
    const estimated = !complete;
    const fallbackValue = estimated && observedSaturdays === 0 ? totalSaturdays * fallbackPerEmployee : 0;
    return {
      estimated,
      values: Object.fromEntries(
        employeeNumbers.map((number) => [
          number,
          estimated
            ? observedSaturdays > 0
              ? values[number] * (totalSaturdays / observedSaturdays)
              : fallbackValue
            : values[number],
        ]),
      ),
    };
  }

  const fourWeeks = statsForWindow(addDays(weekStart, -28), addDays(weekStart, -1));
  const threeMonths = statsForWindow(addMonths(weekStart, -3), addDays(weekStart, -1));
  return {
    byEmployee: Object.fromEntries(
      employeeNumbers.map((number) => [
        number,
        {
          fourWeeks: fourWeeks.values[number] || 0,
          fourWeeksEstimated: fourWeeks.estimated,
          threeMonths: threeMonths.values[number] || 0,
          threeMonthsEstimated: threeMonths.estimated,
        },
      ]),
    ),
    estimated: fourWeeks.estimated || threeMonths.estimated,
  };
}

function getSchedule(weekValue, contextInput = {}, session = null) {
  const weekStart = getMonday(isIsoDate(weekValue) ? weekValue : undefined);
  const weekEnd = addDays(weekStart, 6);
  const context = resolvePlanningContext(contextInput);
  assertSessionContextScope(session, context);
  const settings = applyScopedPdfSettings(settingsForLocation(context.locationId), context, "schedule");
  const globalDayBlocks = getGlobalDayBlocksForRange(weekStart, weekEnd, context.locationId);
  const globalBlockDates = new Set(globalDayBlocks.map((block) => block.block_date));
  const employeeFilter = scheduleEmployeeFilterSql(context, weekStart, weekEnd, "e");
  const employees = db
    .prepare(`
      SELECT e.personnel_number, e.full_name, e.nickname, e.color, e.contracted_hours,
             e.preferred_day_off, e.fixed_workdays, e.position_id, e.home_location_id, e.preferred_department_id,
             e.active, l.name AS home_location_name, d.name AS preferred_department_name,
             p.name AS position_name
      FROM employees e
      LEFT JOIN locations l ON l.id = e.home_location_id
      LEFT JOIN departments d ON d.id = e.preferred_department_id
      LEFT JOIN positions p ON p.id = e.position_id
      WHERE e.active = 1 AND ${employeeFilter.sql}
      ORDER BY CAST(personnel_number AS INTEGER), personnel_number
    `)
    .all(...employeeFilter.values)
    .map(serializeEmployee);
  const shiftDepartmentFilter = context.departmentId ? "AND s.department_id = ?" : "";
  const shiftValues = context.departmentId
    ? [weekStart, weekEnd, context.locationId, context.departmentId]
    : [weekStart, weekEnd, context.locationId];
  const shifts = db
    .prepare(`
      SELECT s.id, s.employee_number, s.department_id, s.shift_date, s.start_time, s.end_time,
             s.area, s.note, e.full_name, e.nickname, e.color, d.name AS department_name
      FROM shifts s
      JOIN employees e ON e.personnel_number = s.employee_number
      LEFT JOIN departments d ON d.id = s.department_id
      WHERE s.shift_date BETWEEN ? AND ?
        AND e.home_location_id = ?
        ${shiftDepartmentFilter}
      ORDER BY s.shift_date, s.start_time, CAST(s.employee_number AS INTEGER), s.employee_number
    `)
    .all(...shiftValues)
    .map((shift) => ({ ...shift, ...shiftMetrics(shift, settings) }));
  const weekOptions = db
    .prepare(`
      SELECT o.id, o.group_id, o.employee_number, o.week_start, o.date_from, o.date_to,
             o.option_type, o.note, o.credited_minutes_per_day,
             o.all_day, o.start_time, o.end_time,
             e.nickname, e.color, e.contracted_hours
      FROM week_options o
      JOIN employees e ON e.personnel_number = o.employee_number
      WHERE o.week_start = ? AND ${employeeFilter.sql}
      ORDER BY CAST(o.employee_number AS INTEGER), o.employee_number, o.date_from
    `)
    .all(weekStart, ...employeeFilter.values);
  const pendingTimeOff = db.prepare(`
    SELECT t.id, t.employee_number, COALESCE(t.date_from, t.request_date) AS date_from,
           COALESCE(t.date_to, t.request_date) AS date_to, t.all_day, t.start_time, t.end_time, t.note,
           e.nickname, e.color, e.contracted_hours
    FROM time_off_requests t JOIN employees e ON e.personnel_number = t.employee_number
    WHERE t.status IN ('pending','pending_local','preliminary_local','pending_hr')
      AND COALESCE(t.date_from, t.request_date) <= ? AND COALESCE(t.date_to, t.request_date) >= ?
      AND ${employeeFilter.sql}
  `).all(weekEnd, weekStart, ...employeeFilter.values).map((item) => ({
    ...item,
    id: `pending-za-${item.id}`,
    group_id: null,
    week_start: weekStart,
    option_type: "time_off",
    note: `Beantragt${item.note ? ` · ${item.note}` : ""}`,
    credited_minutes_per_day: 0,
    soft_pending: true,
  }));
  weekOptions.push(...pendingTimeOff);

  const totals = {};
  const plannedTotals = {};
  const inStoreTotals = {};
  const bonusTotals = {};
  const optionCreditTotals = {};
  for (const employee of employees) {
    totals[employee.personnel_number] = 0;
    plannedTotals[employee.personnel_number] = 0;
    inStoreTotals[employee.personnel_number] = 0;
    bonusTotals[employee.personnel_number] = 0;
    optionCreditTotals[employee.personnel_number] = 0;
  }
  for (const shift of shifts) {
    totals[shift.employee_number] =
      (totals[shift.employee_number] || 0) + shift.counted_minutes;
    plannedTotals[shift.employee_number] =
      (plannedTotals[shift.employee_number] || 0) + shift.raw_minutes - shift.break_minutes;
    inStoreTotals[shift.employee_number] =
      (inStoreTotals[shift.employee_number] || 0) + shift.raw_minutes - shift.break_minutes;
    bonusTotals[shift.employee_number] =
      (bonusTotals[shift.employee_number] || 0) + shift.bonus_minutes;
  }
  for (const option of weekOptions) {
    option.credited_minutes_per_day_effective = optionMinutesPerDay(option, option.contracted_hours);
    option.credited_minutes = option.credited_minutes_per_day_effective * countCreditedOptionDays(option, settings, context.locationId);
    optionCreditTotals[option.employee_number] =
      (optionCreditTotals[option.employee_number] || 0) + option.credited_minutes;
    totals[option.employee_number] =
      (totals[option.employee_number] || 0) + option.credited_minutes;
  }
  const saturdayStats = buildSaturdayServiceStats(weekStart, context, employees, shifts, settings);
  const creditedHolidayDates = new Set();
  for (const holiday of publicHolidaysForRange(weekStart, weekEnd)) {
    const day = new Date(`${holiday.date}T12:00:00Z`).getUTCDay();
    if (day === 0 || day === 6) continue;
    for (const employee of employees) {
      if (hasNonVacationCreditOnDate(weekOptions, employee.personnel_number, holiday.date)) continue;
      const credit = holidayCreditMinutes(employee);
      optionCreditTotals[employee.personnel_number] = (optionCreditTotals[employee.personnel_number] || 0) + credit;
      totals[employee.personnel_number] = (totals[employee.personnel_number] || 0) + credit;
    }
    creditedHolidayDates.add(holiday.date);
  }
  for (const block of globalDayBlocks) {
    if (!block.is_public_holiday || creditedHolidayDates.has(block.block_date)) continue;
    const day = new Date(`${block.block_date}T12:00:00Z`).getUTCDay();
    if (day === 0 || day === 6) continue;
    for (const employee of employees) {
      if (hasNonVacationCreditOnDate(weekOptions, employee.personnel_number, block.block_date)) continue;
      const credit = holidayCreditMinutes(employee);
      optionCreditTotals[employee.personnel_number] = (optionCreditTotals[employee.personnel_number] || 0) + credit;
      totals[employee.personnel_number] = (totals[employee.personnel_number] || 0) + credit;
    }
  }

  return {
    weekStart,
    weekEnd,
    calendarWeek: getIsoWeek(weekStart),
    context,
    locations: getLocationsForSession(session, true),
    settings,
    currentWeekStart: currentWeekStart(),
    isPastWeek: isPastWeekStart(weekStart),
    isPastWeekLocked: (isPastWeekStart(weekStart) && !settingEnabled(settings, "allow_past_week_editing"))
      || (weekStart === currentWeekStart() && settingEnabled(settings, "current_week_auto_lock") && viennaNowLocal() >= currentWeekLockPoint(settings)),
    currentWeekLockPoint: currentWeekLockPoint(settings),
    employees,
    shifts,
    weekOptions,
    globalDayBlocks,
    scheduleNote: getScheduleNote(weekStart, context),
    globalBlockDates: Array.from(globalBlockDates),
    publicHolidays: publicHolidaysForRange(weekStart, weekEnd),
    totals,
    plannedTotals,
    inStoreTotals,
    bonusTotals,
    optionCreditTotals,
    saturdayStats,
  };
}

function validateYear(value = new Date().getFullYear()) {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw httpError(400, "Bitte ein gültiges Jahr auswählen.");
  }
  return year;
}

function daysBetweenInclusive(startDate, endDate) {
  return Math.round((new Date(`${endDate}T12:00:00Z`) - new Date(`${startDate}T12:00:00Z`)) / 86400000) + 1;
}

function overlapDateRange(startA, endA, startB, endB) {
  return startA <= endB && startB <= endA;
}

function monthStart(year, monthIndex) {
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}-01`;
}

function monthEnd(year, monthIndex) {
  const date = new Date(Date.UTC(year, monthIndex + 1, 0, 12));
  return date.toISOString().slice(0, 10);
}

function vacationGroupKey(row) {
  return row.group_id || `legacy-${row.id}`;
}

function getVacationPlan(yearValue, contextInput = {}, session = null) {
  const year = validateYear(yearValue);
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const today = new Date().toISOString().slice(0, 10);
  const consumedEnd = today < yearStart ? null : today > yearEnd ? yearEnd : today;
  const context = resolvePlanningContext(contextInput);
  assertSessionContextScope(session, context);
  const settings = applyScopedPdfSettings(settingsForLocation(context.locationId), context, "vacation");
  const employeeFilter = employeeLocationFilterSql(context, "e");
  const publicHolidays = publicHolidaysForRange(yearStart, yearEnd);
  const globalHolidayBlocks = getGlobalDayBlocksForRange(yearStart, yearEnd, context.locationId)
    .filter((block) => block.is_public_holiday)
    .map((block) => ({ date: block.block_date, name: block.reason || block.holiday_name || "Feiertag" }));
  const vacationHolidays = [...publicHolidays];
  for (const holiday of globalHolidayBlocks) {
    if (!vacationHolidays.some((item) => item.date === holiday.date)) vacationHolidays.push(holiday);
  }
  const employees = db
    .prepare(`
      SELECT e.personnel_number, e.full_name, e.nickname, e.color, e.contracted_hours,
             e.preferred_day_off, e.fixed_workdays, e.position_id, e.home_location_id, e.preferred_department_id,
             e.active, l.name AS home_location_name, d.name AS preferred_department_name,
             p.name AS position_name
      FROM employees e
      LEFT JOIN locations l ON l.id = e.home_location_id
      LEFT JOIN departments d ON d.id = e.preferred_department_id
      LEFT JOIN positions p ON p.id = e.position_id
      WHERE e.active = 1 AND ${employeeFilter.sql}
      ORDER BY CAST(personnel_number AS INTEGER), personnel_number
    `)
    .all(...employeeFilter.values)
    .map(serializeEmployee);
  const entitlementRows = db
    .prepare("SELECT employee_number, days FROM vacation_entitlements WHERE year = ?")
    .all(year);
  const entitlements = Object.fromEntries(employees.map((employee) => [employee.personnel_number, 0]));
  const entitlementsSaved = Object.fromEntries(employees.map((employee) => [employee.personnel_number, false]));
  for (const row of entitlementRows) {
    entitlements[row.employee_number] = Number(row.days || 0);
    entitlementsSaved[row.employee_number] = true;
  }

  const optionRows = db
    .prepare(`
      SELECT o.id, o.group_id, o.employee_number, o.week_start, o.date_from, o.date_to,
             o.option_type, o.note, o.credited_minutes_per_day, o.all_day, o.start_time, o.end_time,
             e.nickname, e.full_name, e.color
      FROM week_options o
      JOIN employees e ON e.personnel_number = o.employee_number
      WHERE o.option_type = 'vacation'
        AND o.date_from <= ?
        AND o.date_to >= ?
        AND ${employeeFilter.sql}
      ORDER BY o.date_from, CAST(o.employee_number AS INTEGER), o.employee_number
    `)
    .all(yearEnd, yearStart, ...employeeFilter.values);

  const grouped = new Map();
  for (const row of optionRows) {
    const key = vacationGroupKey(row);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        group_id: key,
        employee_number: row.employee_number,
        nickname: row.nickname,
        full_name: row.full_name,
        color: row.color,
        date_from: row.date_from,
        date_to: row.date_to,
        note: row.note || "",
        ids: [row.id],
      });
    } else {
      existing.date_from = existing.date_from < row.date_from ? existing.date_from : row.date_from;
      existing.date_to = existing.date_to > row.date_to ? existing.date_to : row.date_to;
      existing.note = existing.note || row.note || "";
      existing.ids.push(row.id);
    }
  }

  const vacations = Array.from(grouped.values())
    .map((vacation) => {
      const clippedFrom = vacation.date_from < yearStart ? yearStart : vacation.date_from;
      const clippedTo = vacation.date_to > yearEnd ? yearEnd : vacation.date_to;
      return {
        ...vacation,
        days: vacationDayCount(clippedFrom, clippedTo, settings, context.locationId),
        calendar_days: daysBetweenInclusive(clippedFrom, clippedTo),
      };
    })
    .sort((a, b) => a.date_from.localeCompare(b.date_from) || a.nickname.localeCompare(b.nickname));

  const plannedByEmployee = Object.fromEntries(employees.map((employee) => [employee.personnel_number, 0]));
  const consumedByEmployee = Object.fromEntries(employees.map((employee) => [employee.personnel_number, 0]));
  for (const vacation of vacations) {
    plannedByEmployee[vacation.employee_number] = (plannedByEmployee[vacation.employee_number] || 0) + vacation.days;
    if (consumedEnd && vacation.date_from <= consumedEnd) {
      const clippedFrom = vacation.date_from < yearStart ? yearStart : vacation.date_from;
      const clippedTo = vacation.date_to > consumedEnd ? consumedEnd : vacation.date_to;
      consumedByEmployee[vacation.employee_number] =
        (consumedByEmployee[vacation.employee_number] || 0) + vacationDayCount(clippedFrom, clippedTo, settings, context.locationId);
    }
  }
  const totals = Object.fromEntries(
    employees.map((employee) => {
      const entitlement = Number(entitlements[employee.personnel_number] || 0);
      const planned = Number(plannedByEmployee[employee.personnel_number] || 0);
      const consumed = Number(consumedByEmployee[employee.personnel_number] || 0);
      return [
        employee.personnel_number,
        {
          entitlement,
          entitlement_saved: Boolean(entitlementsSaved[employee.personnel_number]),
          used: planned,
          planned,
          consumed,
          remaining: entitlement - planned,
        },
      ];
    }),
  );

  return {
    year,
    context,
    locations: getLocationsForSession(session, true),
    settings,
    employees,
    entitlements,
    entitlementsSaved,
    vacations,
    totals,
    publicHolidays: vacationHolidays.sort((a, b) => a.date.localeCompare(b.date)),
  };
}

function validateVacationEntry(body, excludeGroupId = null) {
  const employeeNumber = String(body.employeeNumber || "").trim();
  const dateFrom = String(body.dateFrom || "");
  const dateTo = String(body.dateTo || "");
  const note = String(body.note || "").trim();

  if (!db.prepare("SELECT 1 FROM employees WHERE personnel_number = ?").get(employeeNumber)) {
    throw httpError(404, "Das ausgewählte Teammitglied wurde nicht gefunden.");
  }
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateTo < dateFrom) {
    throw httpError(400, "Bitte einen gültigen Urlaubszeitraum eingeben.");
  }
  const overlappingOption = db
    .prepare(`
      SELECT id, group_id, option_type, date_from, date_to
      FROM week_options
      WHERE employee_number = ? AND date_from <= ? AND date_to >= ?
    `)
    .all(employeeNumber, dateTo, dateFrom)
    .find((option) => vacationGroupKey(option) !== excludeGroupId);
  if (overlappingOption) {
    throw httpError(
      409,
      `In diesem Zeitraum ist bereits „${optionLabel(overlappingOption.option_type)}“ eingetragen.`,
    );
  }
  const existingShift = db
    .prepare(`
      SELECT shift_date, start_time, end_time
      FROM shifts
      WHERE employee_number = ? AND shift_date BETWEEN ? AND ?
      LIMIT 1
    `)
    .get(employeeNumber, dateFrom, dateTo);
  if (existingShift) {
    throw httpError(
      409,
      `Für ${existingShift.shift_date} ist bereits ein Dienst von ${existingShift.start_time} bis ${existingShift.end_time} Uhr eingetragen.`,
    );
  }

  return { employeeNumber, dateFrom, dateTo, note };
}

function validateGlobalDayBlock(body, existingId = 0) {
  const context = resolvePlanningContext({ ...body, departmentId: null, department: null });
  const blockDate = String(body.blockDate || body.date || "").trim();
  const weekStart = getMonday(String(body.weekStart || blockDate || ""));
  const reason = String(body.reason || "").trim();
  const isPublicHoliday = body.isPublicHoliday === true ? 1 : 0;

  if (!isIsoDate(blockDate)) throw httpError(400, "Bitte ein gültiges Datum für den Sperrtag auswählen.");
  if (blockDate < weekStart || blockDate > addDays(weekStart, 6)) {
    throw httpError(400, "Der Sperrtag muss innerhalb der ausgewählten Kalenderwoche liegen.");
  }
  if (!reason) throw httpError(400, "Bitte einen Grund für den Sperrtag eintragen.");
  assertWeekEditable(weekStart, settingsForLocation(context.locationId));

  const existingBlock = db
    .prepare("SELECT id FROM global_day_blocks WHERE location_id = ? AND block_date = ? AND id != ?")
    .get(context.locationId, blockDate, Number(existingId || 0));
  if (existingBlock) {
    throw httpError(409, "Für diesen Tag ist bereits eine ganztägige Sperre eingetragen.");
  }

  const shiftCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM shifts s
    JOIN employees e ON e.personnel_number = s.employee_number
    WHERE s.shift_date = ? AND e.home_location_id = ?
  `).get(blockDate, context.locationId).count;
  if (Number(shiftCount) > 0) {
    throw httpError(409, "Für diesen Tag sind bereits Dienste eingetragen. Bitte zuerst die Dienste entfernen.");
  }

  return { locationId: context.locationId, weekStart, blockDate, reason, isPublicHoliday };
}

const scheduleNoteMaxLength = 900;

function stripEmoji(value) {
  return String(value || "")
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .replace(/[\u2600-\u27BF]/gu, "")
    .replace(/\uFEFF/g, "");
}

function decodeBasicEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function textFromScheduleNoteHtml(html) {
  return decodeBasicEntities(
    String(html || "")
      .replace(/<\/(div|p)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeScheduleNoteHtml(input) {
  let html = stripEmoji(String(input || ""));
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  html = html.replace(/<span[^>]*class\s*=\s*["'][^"']*\bql-cursor\b[^"']*["'][^>]*>[\s\S]*?<\/span>/gi, "");
  html = html.replace(/<[^>]*>/g, (tag) => {
    const lower = tag.toLowerCase();
    if (/^<(b|strong)(\s[^>]*)?>$/.test(lower)) return "<b>";
    if (/^<\/(b|strong)>$/.test(lower)) return "</b>";
    if (/^<(i|em)(\s[^>]*)?>$/.test(lower)) return "<i>";
    if (/^<\/(i|em)>$/.test(lower)) return "</i>";
    if (/^<u(\s[^>]*)?>$/.test(lower)) return "<u>";
    if (/^<\/u>$/.test(lower)) return "</u>";
    if (/^<br\s*\/?>$/.test(lower)) return "<br>";
    if (/^<(div|p)(\s[^>]*)?>$/.test(lower)) return "<div>";
    if (/^<\/(div|p)>$/.test(lower)) return "</div>";
    if (/^<span\b/i.test(lower)) {
      const size = lower.match(/data-size\s*=\s*["']?(small|normal|large)["']?/i)?.[1]
        || lower.match(/class\s*=\s*["'][^"']*\bql-size-(small|large)\b/i)?.[1]
        || "normal";
      return `<span data-size="${size}">`;
    }
    if (/^<\/span>$/.test(lower)) return "</span>";
    return "";
  });
  return html.trim();
}

function getScheduleNote(weekStart, context) {
  const row = db
    .prepare(`
      SELECT location_id, department_key, week_start, note_text, note_html, font_size, bold, italic, underline, updated_at
      FROM schedule_notes
      WHERE location_id = ? AND department_key = ? AND week_start = ?
    `)
    .get(context.locationId, pdfDepartmentKey(context), weekStart);
  if (!row || !String(row.note_text || "").trim()) return null;
  return {
    location_id: row.location_id,
    department_key: row.department_key,
    week_start: row.week_start,
    note_text: row.note_text,
    note_html: row.note_html || "",
    font_size: row.font_size,
    bold: Boolean(row.bold),
    italic: Boolean(row.italic),
    underline: Boolean(row.underline),
    updated_at: row.updated_at,
  };
}

function validateScheduleNote(body) {
  const weekStart = getMonday(isIsoDate(body.weekStart) ? body.weekStart : undefined);
  const context = resolvePlanningContext(body);
  assertWeekEditable(weekStart, settingsForLocation(context.locationId));
  const noteHtml = sanitizeScheduleNoteHtml(body.noteHtml || "");
  const noteText = stripEmoji(
    textFromScheduleNoteHtml(noteHtml) || String(body.noteText || body.text || ""),
  ).trim();
  if (!noteText) throw httpError(400, "Bitte eine Bemerkung eingeben.");
  if (noteText.length > scheduleNoteMaxLength) {
    throw httpError(400, `Die Bemerkung ist zu lang. Maximal ${scheduleNoteMaxLength} Zeichen.`);
  }
  return {
    weekStart,
    context,
    noteText,
    noteHtml: noteHtml || noteText,
    fontSize: "medium",
    bold: 0,
    italic: 0,
    underline: 0,
  };
}

function createVacationGroupId() {
  return `vac-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function insertVacationEntries(vacation, groupId) {
  const insertOption = db.prepare(`
    INSERT INTO week_options
      (employee_number, group_id, week_start, date_from, date_to, option_type, note, credited_minutes_per_day, all_day, start_time, end_time)
    VALUES (?, ?, ?, ?, ?, 'vacation', ?, NULL, 1, NULL, NULL)
  `);
  let date = vacation.dateFrom;
  let created = 0;
  while (date <= vacation.dateTo) {
    const weekStart = getMonday(date);
    const weekEnd = addDays(weekStart, 6);
    const segmentEnd = weekEnd < vacation.dateTo ? weekEnd : vacation.dateTo;
    insertOption.run(vacation.employeeNumber, groupId, weekStart, date, segmentEnd, vacation.note);
    created += 1;
    date = addDays(segmentEnd, 1);
  }
  return created;
}

function createVacationEntries(vacation) {
  const groupId = createVacationGroupId();
  let created = 0;
  db.exec("BEGIN");
  try {
    created = insertVacationEntries(vacation, groupId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { groupId, created };
}

function vacationGroupExists(groupId) {
  if (String(groupId).startsWith("legacy-")) {
    const id = Number(String(groupId).replace("legacy-", ""));
    return Number.isInteger(id) && Boolean(db.prepare("SELECT 1 FROM week_options WHERE id = ? AND option_type = 'vacation'").get(id));
  }
  return Boolean(db.prepare("SELECT 1 FROM week_options WHERE group_id = ? AND option_type = 'vacation'").get(groupId));
}

function replaceVacationGroup(groupId, vacation) {
  let created = 0;
  db.exec("BEGIN");
  try {
    deleteVacationGroup(groupId);
    created = insertVacationEntries(vacation, groupId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { groupId, created };
}

function deleteVacationGroup(groupId) {
  if (String(groupId).startsWith("legacy-")) {
    const id = Number(String(groupId).replace("legacy-", ""));
    if (!Number.isInteger(id)) return 0;
    return db.prepare("DELETE FROM week_options WHERE id = ? AND option_type = 'vacation'").run(id).changes;
  }
  return db.prepare("DELETE FROM week_options WHERE group_id = ? AND option_type = 'vacation'").run(groupId).changes;
}

function databasePragmaValue(name) {
  const row = db.prepare(`PRAGMA ${name}`).get();
  return row ? Object.values(row)[0] : null;
}

function directoryDiagnostics(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
    const stats = typeof fs.statfsSync === "function" ? fs.statfsSync(directory) : null;
    return {
      writable: true,
      freeBytes: stats ? Number(stats.bavail) * Number(stats.bsize) : null,
      volume: path.parse(path.resolve(directory)).root,
    };
  } catch (error) {
    return { writable: false, freeBytes: null, volume: path.parse(path.resolve(directory)).root, error: error.message };
  }
}

function latestDatabaseBackup(backupDirectory) {
  try {
    return fs.readdirSync(backupDirectory)
      .filter((name) => /^dienstplan-.*\.db$/.test(name))
      .map((name) => {
        const modified = fs.statSync(path.join(backupDirectory, name)).mtime;
        return { name, modifiedAt: modified.toISOString(), modifiedMs: modified.getTime() };
      })
      .sort((left, right) => right.modifiedMs - left.modifiedMs)[0] || null;
  } catch { return null; }
}

function serverDiagnostics() {
  const settings = getSettings();
  const portal = getPortalStatus();
  const migration = db.prepare("SELECT id, app_version, applied_at FROM schema_migrations ORDER BY applied_at DESC, id DESC LIMIT 1").get() || null;
  const warnings = [];
  const requiredStorageDirectories = {
    database: path.dirname(path.resolve(databasePath)),
    appBackups: appBackupDirectory,
    brandingKits: brandingKitsDirectory,
    privateData: privateDataDirectory,
    amu: amuStorageDirectory,
  };
  const requiredStorageHealth = Object.fromEntries(Object.entries(requiredStorageDirectories)
    .map(([name, directory]) => [name, { directory, ...directoryDiagnostics(directory) }]));
  const requiredStorageVolumes = Object.values(requiredStorageHealth).map((item) => item.volume).filter(Boolean);
  const requiredStorageFreeBytes = Object.values(requiredStorageHealth).map((item) => item.freeBytes).filter(Number.isFinite);
  const dataHealth = {
    writable: Object.values(requiredStorageHealth).every((item) => item.writable),
    freeBytes: requiredStorageFreeBytes.length ? Math.min(...requiredStorageFreeBytes) : null,
    volume: requiredStorageVolumes[0] || path.parse(path.resolve(dataRootDirectory)).root,
    directories: requiredStorageHealth,
  };
  let externalDirectory = "";
  try { externalDirectory = backupDirectoryFromSettings(settings); } catch (error) { warnings.push(`Das externe Backupziel ist ungültig: ${error.message}`); }
  const backupHealth = externalDirectory ? directoryDiagnostics(externalDirectory) : { writable: false, freeBytes: null, volume: "" };
  const latestExternalBackup = externalDirectory ? latestDatabaseBackup(externalDirectory) : null;
  const latestAppBackup = latestDatabaseBackup(appBackupDirectory);
  const latestBackup = latestExternalBackup || latestAppBackup;
  const latestBackupAgeHours = latestBackup ? Math.max(0, (Date.now() - latestBackup.modifiedMs) / 3600000) : null;
  const latestExternalBackupAgeHours = latestExternalBackup ? Math.max(0, (Date.now() - latestExternalBackup.modifiedMs) / 3600000) : null;
  const backupFreshnessHours = Math.max(6, Number(settings.backup_interval_hours || 2) * 3);
  const externalBackupReady = settingEnabled(settings, "external_backup_enabled") && backupHealth.writable
    && latestExternalBackupAgeHours !== null && latestExternalBackupAgeHours <= backupFreshnessHours;
  const amu = amuStorage ? amuStorage.diagnostics() : { ok: false, writable: false, error: amuStorageStartupError };
  const protectedIntegrationConnectionCount = Number(db.prepare("SELECT COUNT(*) AS count FROM integration_connections WHERE protected_credentials <> '' AND active = 1").get().count || 0);
  const integrationSecretsReady = protectedIntegrationConnectionCount === 0 || Boolean(integrationSecretVault);
  const runtimeErrors = runtimeValidationErrors(runtimeConfiguration);
  const publicHttpsReady = /^https:\/\//i.test(publicUrl);
  if (serverModeActive && !/^https:\/\//i.test(publicUrl)) warnings.push("Für den Serverbetrieb fehlt eine gültige HTTPS-Adresse.");
  if (serverModeActive && portal.adminSetupState !== "configured") warnings.push("Vor dem Serverstart muss ein Admin-Zugang eingerichtet sein.");
  if (serverModeActive && !loopbackHosts.has(HOST.toLowerCase())) warnings.push("Der Server lauscht nicht ausschließlich auf Loopback. Firewall und Reverse-Proxy-Konfiguration prüfen.");
  if (runtimeErrors.length) warnings.push(...runtimeErrors);
  if (settings.external_backup_enabled === "0") warnings.push("Die zusätzliche externe Datensicherung ist deaktiviert.");
  if (!dataHealth.writable) {
    const failedDirectories = Object.entries(requiredStorageHealth).filter(([, item]) => !item.writable).map(([name]) => name);
    warnings.push(`Mindestens ein benötigtes Server-Datenverzeichnis ist nicht beschreibbar: ${failedDirectories.join(", ")}.`);
  }
  if (settingEnabled(settings, "external_backup_enabled") && !backupHealth.writable) warnings.push("Das externe Backupziel ist nicht beschreibbar.");
  if (latestExternalBackupAgeHours === null || latestExternalBackupAgeHours > backupFreshnessHours) warnings.push("Es wurde kein ausreichend aktuelles verifiziertes externes Datenbank-Backup gefunden.");
  if (externalDirectory && path.parse(path.resolve(databasePath)).root.toLowerCase() === path.parse(path.resolve(externalDirectory)).root.toLowerCase()) warnings.push("Datenbank und externes Backup liegen auf demselben Laufwerk.");
  if (!amu.ok) warnings.push(`Der geschützte AUM-Speicher ist nicht betriebsbereit${amu.error ? `: ${amu.error}` : "."}`);
  if (!integrationSecretsReady) warnings.push("Für aktive direkte Verbindungen fehlt der geschützte Integrationsschlüssel.");
  if (serverModeActive && serviceControlToken.length < 32) warnings.push("Der sichere Token für den Windows-Dienststopp fehlt.");
  const lockedAccounts = Number(db.prepare("SELECT COUNT(*) AS count FROM portal_users WHERE locked_until > CURRENT_TIMESTAMP").get().count || 0);
  if (lockedAccounts) warnings.push(`${lockedAccounts} Zugang/Zugänge sind derzeit gesperrt.`);
  const productionChecks = [
    { id: "mode", label: "Servermodus", ok: serverModeActive, detail: serverModeActive ? "aktiv" : "nicht aktiv" },
    { id: "runtime", label: "Produktionslaufzeit", ok: runtimeErrors.length === 0, detail: `${deploymentKind} / NODE_ENV=${process.env.NODE_ENV || "nicht gesetzt"}` },
    { id: "listener", label: "Interne Bindung", ok: loopbackHosts.has(HOST.toLowerCase()), detail: `${HOST}:${PORT}` },
    { id: "proxy", label: "Proxy-Vertrauen", ok: trustProxySetting.toLowerCase() === "loopback", detail: trustProxySetting },
    { id: "https", label: "HTTPS-Adresse", ok: publicHttpsReady, detail: publicUrl || "nicht konfiguriert" },
    { id: "admin", label: "Admin-Zugang", ok: portal.adminSetupState === "configured", detail: portal.adminSetupState },
    { id: "database", label: "SQLite-Integrität", ok: startupIntegrity[0] === "ok", detail: startupIntegrity[0] || "unbekannt" },
    { id: "data", label: "Datenverzeichnis", ok: dataHealth.writable, detail: dataHealth.writable ? "beschreibbar" : "nicht beschreibbar" },
    { id: "backup", label: "Externes Backup", ok: externalBackupReady, detail: latestExternalBackup ? latestExternalBackup.modifiedAt : "noch kein verifiziertes Backup" },
    { id: "amu", label: "AUM-Speicher", ok: amu.ok, detail: amu.ok ? "verschlüsselt und beschreibbar" : (amu.error || "nicht bereit") },
    { id: "integration-secrets", label: "Schnittstellenschlüssel", ok: integrationSecretsReady, detail: protectedIntegrationConnectionCount ? `${protectedIntegrationConnectionCount} geschützte Verbindung(en)` : "derzeit nicht benötigt" },
    { id: "scanner", label: "AUM-Virenscanner", ok: !amu.requireScanner || (amu.scannerChecked && amu.scannerAvailable && amu.ok), detail: amu.scannerEngine || (amu.scannerChecked ? "nicht verfügbar" : "Prüfung läuft") },
    { id: "service-stop", label: "Dienststopp", ok: serviceControlToken.length >= 32, detail: serviceControlToken.length >= 32 ? "Token konfiguriert" : "Token fehlt" },
  ];
  return {
    ready: startupIntegrity.length === 1 && startupIntegrity[0] === "ok" && dataHealth.writable
      && (!serverModeActive || (runtimeErrors.length === 0 && publicHttpsReady && portal.adminSetupState === "configured"
        && externalBackupReady && amu.ok && integrationSecretsReady && serviceControlToken.length >= 32)),
    mode: portal.operationMode,
    publicUrl: portal.publicUrl,
    httpsRequired: portal.httpsRequired,
    listenHost: HOST,
    port: PORT,
    trustProxy: portal.trustProxy,
    passwordMinLength: portal.passwordMinLength,
    database: {
      file: path.basename(databasePath),
      integrity: startupIntegrity[0] || "unknown",
      journalMode: databasePragmaValue("journal_mode"),
      synchronous: databasePragmaValue("synchronous"),
      busyTimeoutMs: Number(databasePragmaValue("busy_timeout") || 0),
      foreignKeys: Boolean(databasePragmaValue("foreign_keys")),
      migration,
    },
    instanceLock: { enabled: Boolean(instanceLockPath), held: instanceLockHeld },
    process: { pid: process.pid, uptimeSeconds: Math.floor(process.uptime()), startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() },
    storage: { dataRoot: dataRootDirectory, data: dataHealth, amu },
    backups: {
      appDirectory: appBackupDirectory,
      externalEnabled: settingEnabled(settings, "external_backup_enabled"),
      externalDirectory,
      externalWritable: backupHealth.writable,
      freeBytes: backupHealth.freeBytes,
      latest: latestBackup,
      latestAgeHours: latestBackupAgeHours,
      latestExternal: latestExternalBackup,
      latestExternalAgeHours: latestExternalBackupAgeHours,
      retentionCount: backupKeep,
      lastVerified: Boolean(lastBackup?.appBackup?.verified || lastBackup?.externalBackup?.verified),
    },
    productionChecks,
    pilotChecks: productionChecks,
    security: {
      lockedAccounts,
      activeSessions: Number(db.prepare("SELECT COUNT(*) AS count FROM portal_sessions WHERE revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP").get().count || 0),
      loginRateLimitActive: serverModeActive,
      secureCookies: serverModeActive,
      serviceControlConfigured: serviceControlToken.length >= 32,
    },
    warnings,
  };
}

function sendReadiness(response) {
  const diagnostics = serverDiagnostics();
  response.status(diagnostics.ready ? 200 : 503).json({ ok: diagnostics.ready });
}

function integrationActor(request, permission) {
  return requirePortalAdminOrLocal(request, permission);
}

function parseIntegrationJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function requireIntegrationSecretVault() {
  if (!integrationSecretVault) {
    throw httpError(503, "Der geschützte Schlüsselspeicher für direkte Verbindungen ist nicht konfiguriert.", "INTEGRATION_SECRET_KEY_UNAVAILABLE");
  }
  return integrationSecretVault;
}

function integrationCredentialContext(connection) {
  return {
    namespace: "integration-connection",
    connectorId: String(connection.id || ""),
    field: "credentials",
    purpose: String(connection.kind || "integration"),
  };
}

function serializeIntegrationConnection(row) {
  const configuration = parseIntegrationJson(row.configuration_json);
  const serialized = toPublicIntegrationConnection({
    id: row.id,
    version: 1,
    kind: row.kind,
    provider: row.provider,
    name: row.name,
    active: Boolean(row.active),
    configuration,
    status: row.active ? (row.last_test_status || "untested") : "disabled",
    lastTestedAt: row.last_test_at || null,
    lastErrorCode: row.last_error_code || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }, { credentialsConfigured: Boolean(row.protected_credentials) });
  return { ...serialized, revision: Math.max(1, Number(row.revision || 1)) };
}

function integrationConnectionRows(kind = "") {
  const where = ["personnel_sql_source", "payroll_https_target"].includes(kind) ? "WHERE kind = ?" : "";
  return db.prepare(`
    SELECT * FROM integration_connections ${where}
    ORDER BY active DESC, kind, name COLLATE NOCASE
  `).all(...(where ? [kind] : [])).map(serializeIntegrationConnection);
}

function integrationConnectionById(id, kind = "", options = {}) {
  const row = db.prepare(`SELECT * FROM integration_connections WHERE id = ?${options.includeInactive ? "" : " AND active = 1"}`)
    .get(String(id || ""));
  if (!row || (kind && row.kind !== kind)) {
    throw httpError(404, "Die direkte Verbindung wurde nicht gefunden.", "INTEGRATION_CONNECTION_NOT_FOUND");
  }
  return { row, public: serializeIntegrationConnection(row) };
}

function normalizeIntegrationConnectionRequest(body, existing = null) {
  const previous = existing?.public || null;
  if (previous && body?.kind !== undefined && String(body.kind) !== previous.kind) {
    throw httpError(400, "Die Art einer bestehenden direkten Verbindung kann nicht geändert werden.", "INTEGRATION_CONNECTION_KIND_LOCKED");
  }
  if (previous && body?.provider !== undefined && String(body.provider) !== previous.provider) {
    throw httpError(400, "Der Provider einer bestehenden direkten Verbindung kann nicht geändert werden.", "INTEGRATION_CONNECTION_PROVIDER_LOCKED");
  }
  const merged = {
    ...(previous || {}),
    ...(body || {}),
    configuration: {
      ...(previous?.configuration || {}),
      ...((body?.configuration && typeof body.configuration === "object") ? body.configuration : {}),
    },
  };
  if (body && Object.hasOwn(body, "credentials")) merged.credentials = body.credentials;
  else delete merged.credentials;
  if (previous?.kind === "payroll_https_target"
    && merged.configuration.authenticationType === "none"
    && previous.configuration.authenticationType !== "none"
    && !Object.hasOwn(body || {}, "credentials")) merged.credentials = {};
  if (previous?.kind === "payroll_https_target"
    && merged.configuration.authenticationType !== previous.configuration.authenticationType
    && merged.configuration.authenticationType !== "none"
    && !Object.hasOwn(body || {}, "credentials")) {
    throw httpError(400, "Bei einer geänderten Authentifizierungsart müssen neue Zugangsdaten gesetzt werden.", "INTEGRATION_CONNECTION_CREDENTIALS_REQUIRED");
  }
  try {
    return normalizeIntegrationConnection(merged, {
      existingCredentialsConfigured: Boolean(existing?.row?.protected_credentials),
    });
  } catch (error) {
    throw httpError(400, error.message && !/^INTEGRATION_/.test(error.message)
      ? error.message : "Die Angaben der direkten Verbindung sind ungültig.", error.code || "INTEGRATION_CONNECTION_INVALID");
  }
}

function protectIntegrationCredentials(connectionId, kind, credentials) {
  if (!credentials || !Object.keys(credentials).length) return { protectedCredentials: "", keyId: "" };
  const vault = requireIntegrationSecretVault();
  const protectedCredentials = vault.seal(JSON.stringify(credentials), integrationCredentialContext({ id: connectionId, kind }));
  return { protectedCredentials, keyId: vault.inspect(protectedCredentials).keyId };
}

async function withIntegrationCredentials(connection, consumer) {
  if (typeof consumer !== "function") throw new TypeError("consumer required");
  if (!connection.row.protected_credentials) return consumer({});
  const vault = requireIntegrationSecretVault();
  let result;
  await vault.useSecret(connection.row.protected_credentials, integrationCredentialContext(connection.row), async (buffer) => {
    let credentials;
    try {
      credentials = JSON.parse(buffer.toString("utf8"));
      result = await consumer(credentials);
    } finally {
      if (credentials && typeof credentials === "object") {
        for (const key of Object.keys(credentials)) credentials[key] = "";
      }
    }
  });
  return result;
}

function assertIntegrationConnectionScope(actor, connection, context = {}) {
  assertSessionContextScope(actor, context);
  const scope = connection.public.configuration.scope || {};
  const locationId = String(context.locationId || "");
  const departmentId = String(context.departmentId || "");
  if (scope.locationIds?.length && (!locationId || !scope.locationIds.includes(locationId))) {
    throw httpError(403, "Diese Verbindung ist für den gewählten Standort nicht freigegeben.", "INTEGRATION_CONNECTION_SCOPE_DENIED");
  }
  if (scope.departmentIds?.length && (!departmentId || !scope.departmentIds.includes(departmentId))) {
    throw httpError(403, "Diese Verbindung ist für die gewählte Abteilung nicht freigegeben.", "INTEGRATION_CONNECTION_SCOPE_DENIED");
  }
}

function assertIntegrationPermission(actor, permission) {
  if (actor.employeeNumber === "local") return;
  if (!actor.permissions?.includes(permission)) {
    throw httpError(403, "Für diese Schnittstellenaktion fehlt die Berechtigung.", "PORTAL_PERMISSION_DENIED");
  }
}

function apiAuthenticationHeaders(connection, credentials) {
  const configuration = connection.public.configuration;
  if (configuration.authenticationType === "none") return {};
  if (configuration.authenticationType === "bearer") return { authorization: `Bearer ${credentials.token}` };
  if (configuration.authenticationType === "api_key") return { [configuration.apiKeyHeader]: credentials.apiKey };
  if (configuration.authenticationType === "basic") {
    return { authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, "utf8").toString("base64")}` };
  }
  throw httpError(400, "Die Authentifizierung des API-Ziels ist ungültig.", "INTEGRATION_CONNECTION_AUTHENTICATION_INVALID");
}

function apiDeliveryClient(connection) {
  const configuration = connection.public.configuration;
  return createSafeApiDelivery({
    timeoutMs: configuration.timeoutMs,
    maxRequestBytes: configuration.requestLimitBytes,
    maxResponseBytes: configuration.responseLimitBytes,
    allowedHeaders: [
      "accept", "authorization", "content-type", "idempotency-key", "user-agent", "x-api-key",
      ...(configuration.apiKeyHeader ? [configuration.apiKeyHeader] : []),
    ],
  });
}

const forbiddenSqlPersonnelColumnTokens = [
  "svnr", "svnummer", "sozialversicherung", "iban", "bank", "konto", "adresse", "anschrift", "strasse",
  "telefon", "phone", "passwort", "password", "token", "secret", "aum", "diagnose",
];

function normalizedSqlColumnToken(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function assertSqlPersonnelColumns(columns) {
  const blocked = columns.filter((column) => forbiddenSqlPersonnelColumnTokens
    .some((token) => normalizedSqlColumnToken(column.name).includes(token)));
  if (blocked.length) {
    throw httpError(422,
      "Die freigegebene SQL-View enthält sensible oder für den Personalimport nicht erforderliche Spalten. Bitte dafür eine datensparsame View bereitstellen.",
      "SQL_VIEW_SENSITIVE_COLUMNS_FORBIDDEN");
  }
}

function allowedSqlPersonnelColumns(configuration, columns) {
  const available = new Map(columns.map((column) => [String(column.name || "").toLocaleLowerCase("de-AT"), column]));
  const selected = (configuration.allowedColumns || []).map((name) => available.get(String(name).toLocaleLowerCase("de-AT")));
  if (!selected.length || selected.some((column) => !column)) {
    throw httpError(409,
      "Mindestens eine freigegebene SQL-Spalte ist nicht mehr in der View vorhanden. Bitte die Verbindung pr\u00fcfen.",
      "SQL_VIEW_ALLOWED_COLUMNS_CHANGED");
  }
  assertSqlPersonnelColumns(selected);
  return selected;
}

function sqlPersonnelScopeContext(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) input = {};
  return {
    locationId: String(input.locationId || input.defaultLocationId || ""),
    departmentId: String(input.departmentId || input.defaultDepartmentId || ""),
  };
}

function assertGlobalSqlPersonnelImportActor(actor) {
  if (!sessionHasGlobalScope(actor)) {
    throw httpError(403,
      "Der direkte SQL-Personalimport ist nur f\u00fcr Zug\u00e4nge mit globalem Unternehmensbereich verf\u00fcgbar.",
      "INTEGRATION_SQL_GLOBAL_SCOPE_REQUIRED");
  }
}

function assertGlobalIntegrationConnectionActor(actor) {
  if (!sessionHasGlobalScope(actor)) {
    throw httpError(403,
      "Direkte Verbindungen können nur von Zugängen mit globalem Unternehmensbereich verwaltet werden.",
      "INTEGRATION_CONNECTION_GLOBAL_SCOPE_REQUIRED");
  }
}

function integrationConnectionConfigurationFingerprint(connection) {
  const value = connection?.public || connection || {};
  return sha256(JSON.stringify({
    id: String(value.id || ""),
    kind: String(value.kind || ""),
    provider: String(value.provider || ""),
    configuration: value.configuration || {},
  }));
}

function revalidateSqlPersonnelPreviewConnection(actor, preview) {
  assertGlobalSqlPersonnelImportActor(actor);
  assertIntegrationPermission(actor, "integrations:connections:read");
  if (!preview.connectionId || !preview.connectionFingerprint) {
    throw httpError(409, "Die SQL-Importvorschau ist veraltet. Bitte die Daten erneut einlesen.", "INTEGRATION_CONNECTION_CHANGED");
  }
  let connection;
  try {
    connection = integrationConnectionById(preview.connectionId, "personnel_sql_source");
  } catch (error) {
    if (error.code === "INTEGRATION_CONNECTION_NOT_FOUND") {
      throw httpError(409, "Die SQL-Verbindung wurde deaktiviert oder entfernt. Bitte die Daten erneut einlesen.", "INTEGRATION_CONNECTION_CHANGED");
    }
    throw error;
  }
  if (connection.public.status !== "ready") {
    throw httpError(409, "Die SQL-Verbindung ist nicht mehr einsatzbereit. Bitte die Verbindung erneut pr\u00fcfen und die Daten neu einlesen.", "INTEGRATION_CONNECTION_CHANGED");
  }
  assertIntegrationConnectionScope(actor, connection, sqlPersonnelScopeContext(preview.connectionScopeContext));
  if (integrationConnectionConfigurationFingerprint(connection) !== preview.connectionFingerprint) {
    throw httpError(409, "Die SQL-Verbindung wurde seit der Vorschau ge\u00e4ndert. Bitte die Daten erneut einlesen.", "INTEGRATION_CONNECTION_CHANGED");
  }
  return connection;
}

function publicPersonnelInspection(parsed, session) {
  return {
    inspectionId: session.id,
    expiresAt: session.expiresAt,
    format: parsed.format,
    sourceTransport: parsed.sourceTransport || "file",
    sourceLabel: parsed.sourceLabel || parsed.format.toUpperCase(),
    sourceContractId: parsed.sourceContractId || null,
    encoding: parsed.encoding,
    delimiter: parsed.delimiter === "\t" ? "tab" : parsed.delimiter,
    byteSize: parsed.byteSize,
    sheets: parsed.summaries.map((summary) => {
      const sheet = parsed.sheets.find((item) => item.name === summary.name);
      const header = sheet?.rows?.[summary.suggestedHeaderRow - 1] || [];
      return {
        ...summary,
        headerFingerprint: headerFingerprint(header),
        suggestedMapping: suggestPersonnelMapping(header),
        headerCandidates: (sheet?.rows || []).slice(0, 20).map((candidate, index) => ({
          rowNumber: index + 1,
          headerFingerprint: headerFingerprint(candidate),
          suggestedMapping: suggestPersonnelMapping(candidate),
        })),
      };
    }),
  };
}

function sqlSourceConfiguration(connection) {
  const config = connection.public.configuration;
  return {
    providerId: connection.public.provider,
    host: config.host,
    port: config.port,
    database: config.database,
    instanceName: config.instanceName,
    schemaName: config.schemaName,
    objectName: config.objectName,
    tlsMode: config.tlsMode,
    timeoutMs: config.timeoutMs,
  };
}

function sqlInspectionFromResult(connection, result, scopeContext = {}) {
  const header = result.columns.map((column) => ({ text: column.name, formula: false, error: false }));
  const rows = [header, ...result.rows.map((row) => row.map((text) => ({ text: String(text ?? ""), formula: false, error: false })))];
  const sheetName = `${result.view.schema}.${result.view.name}`;
  const serializedRows = JSON.stringify(result.rows);
  const contentSha256 = crypto.createHash("sha256")
    .update(JSON.stringify({ connectionId: connection.public.id, sheetName }), "utf8")
    .update("\n", "utf8")
    .update(serializedRows, "utf8")
    .digest("hex");
  return {
    format: "csv",
    sourceTransport: "sql_view",
    sourceLabel: "SQL-View",
    sourceContractId: connection.public.configuration.contractId || CONTRACT_IDS.personnelSqlView,
    connectionId: connection.public.id,
    connectionFingerprint: integrationConnectionConfigurationFingerprint(connection),
    connectionScopeContext: sqlPersonnelScopeContext(scopeContext),
    contentSha256,
    byteSize: Number(result.byteSize || Buffer.byteLength(serializedRows, "utf8")),
    encoding: "utf8",
    delimiter: ",",
    sheets: [{ name: sheetName, rows }],
    summaries: [{
      name: sheetName,
      rowCount: result.rowCount,
      columnCount: result.columns.length,
      suggestedHeaderRow: 1,
      topRows: rows.slice(0, 20).map((row) => row.map((cell) => cell.text)),
      headers: result.columns.map((column, columnIndex) => ({ columnIndex, label: column.name })),
    }],
  };
}

function serializeIntegrationProfile(row) {
  return {
    id: row.id,
    direction: row.direction,
    kind: row.kind,
    name: row.name,
    format: row.format,
    configuration: parseIntegrationJson(row.configuration_json),
    active: Boolean(row.active),
    createdBy: row.created_by || "",
    updatedBy: row.updated_by || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function integrationProfiles(filters = {}) {
  const where = [];
  const values = [];
  if (["import", "export"].includes(filters.direction)) { where.push("direction = ?"); values.push(filters.direction); }
  if (["personnel", "payroll"].includes(filters.kind)) { where.push("kind = ?"); values.push(filters.kind); }
  return db.prepare(`
    SELECT * FROM integration_profiles
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY active DESC, direction, kind, name COLLATE NOCASE
  `).all(...values).map(serializeIntegrationProfile);
}

function normalizeIntegrationProfile(body = {}, existing = null) {
  if (existing && body.direction !== undefined && String(body.direction) !== existing.direction) {
    throw httpError(400, "Die Richtung eines bestehenden Schnittstellenprofils kann nicht geändert werden.", "INTEGRATION_PROFILE_KIND_LOCKED");
  }
  if (existing && body.kind !== undefined && String(body.kind) !== existing.kind) {
    throw httpError(400, "Die Art eines bestehenden Schnittstellenprofils kann nicht geändert werden.", "INTEGRATION_PROFILE_KIND_LOCKED");
  }
  const direction = String(body.direction || existing?.direction || "");
  const kind = String(body.kind || existing?.kind || "");
  if (!((direction === "import" && kind === "personnel") || (direction === "export" && kind === "payroll"))) {
    throw httpError(400, "Dieses Schnittstellenprofil wird nicht unterst\u00fctzt.", "INTEGRATION_PROFILE_KIND_INVALID");
  }
  const name = String(body.name || existing?.name || "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 80) throw httpError(400, "Der Profilname muss 2 bis 80 Zeichen lang sein.", "INTEGRATION_PROFILE_NAME_INVALID");
  let configuration;
  try {
    configuration = direction === "import"
      ? normalizeProfileConfiguration(body.configuration || existing?.configuration || {})
      : normalizePayrollConfiguration(body.configuration || existing?.configuration || {});
  } catch (error) {
    throw httpError(400, "Die Profilkonfiguration ist ung\u00fcltig.", error.message || "INTEGRATION_PROFILE_INVALID");
  }
  const format = configuration.format;
  return { direction, kind, name, format, configuration, active: body.active !== false };
}

function serializeIntegrationRun(row) {
  return {
    id: row.id,
    profileId: row.profile_id || null,
    direction: row.direction,
    kind: row.kind,
    format: row.format,
    status: row.status,
    totalCount: Number(row.total_count || 0),
    createdCount: Number(row.created_count || 0),
    updatedCount: Number(row.updated_count || 0),
    skippedCount: Number(row.skipped_count || 0),
    errorCount: Number(row.error_count || 0),
    actorEmployeeNumber: row.actor_employee_number || "",
    options: parseIntegrationJson(row.options_json),
    result: parseIntegrationJson(row.result_json),
    errorCode: row.error_code || "",
    startedAt: row.started_at,
    completedAt: row.completed_at || null,
  };
}

function insertIntegrationRun(run) {
  const id = run.id || crypto.randomUUID();
  db.prepare(`
    INSERT INTO integration_runs
      (id, profile_id, direction, kind, format, content_sha256, status, total_count,
       created_count, updated_count, skipped_count, error_count, actor_employee_number,
       options_json, result_json, error_code, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    id, run.profileId || null, run.direction, run.kind, run.format, run.contentSha256 || "",
    run.status || "completed", Number(run.totalCount || 0), Number(run.createdCount || 0),
    Number(run.updatedCount || 0), Number(run.skippedCount || 0), Number(run.errorCount || 0),
    run.actor || "", JSON.stringify(run.options || {}), JSON.stringify(run.result || {}), run.errorCode || "",
  );
  return id;
}

function integrationProfileById(id, direction = "", kind = "", options = {}) {
  const row = db.prepare(`SELECT * FROM integration_profiles WHERE id = ?${options.includeInactive ? "" : " AND active = 1"}`).get(String(id || ""));
  if (!row || (direction && row.direction !== direction) || (kind && row.kind !== kind)) {
    throw httpError(404, "Das Schnittstellenprofil wurde nicht gefunden.", "INTEGRATION_PROFILE_NOT_FOUND");
  }
  return serializeIntegrationProfile(row);
}

function personnelImportReferenceData(actor = null) {
  return {
    positions: getPositions().map((position) => ({ id: position.id, name: position.name, active: true })),
    locations: getLocationsForSession(actor, true).map((location) => ({
      id: location.id,
      name: location.name,
      active: location.active,
      departments: location.departments.map((department) => ({ id: department.id, name: department.name, active: department.active })),
    })),
  };
}

function employeeImportRow(personnelNumber) {
  return db.prepare(`
    SELECT personnel_number, full_name, nickname, color, contracted_hours, preferred_day_off,
           fixed_workdays, position_id, time_confirmation_level, home_location_id,
           preferred_department_id, active
    FROM employees WHERE personnel_number = ?
  `).get(personnelNumber);
}

function employeeImportRowsCaseInsensitive(personnelNumber) {
  return db.prepare(`
    SELECT personnel_number, full_name, nickname, color, contracted_hours, preferred_day_off,
           fixed_workdays, position_id, time_confirmation_level, home_location_id,
           preferred_department_id, active
    FROM employees WHERE personnel_number = ? COLLATE NOCASE
    ORDER BY personnel_number
  `).all(personnelNumber);
}

function employeeImportFingerprint(row) {
  if (!row) return "";
  return sha256(JSON.stringify([
    row.personnel_number, row.full_name, row.nickname, row.color, Number(row.contracted_hours),
    row.preferred_day_off || "", row.fixed_workdays || "", row.position_id || "",
    row.time_confirmation_level || "C", row.home_location_id || "",
    Number(row.preferred_department_id || 0), Number(row.active || 0),
  ]));
}

function uniqueReferenceByName(rows, name, typeLabel) {
  const normalized = String(name || "").trim().toLocaleLowerCase("de-AT");
  const matches = rows.filter((row) => String(row.name || "").trim().toLocaleLowerCase("de-AT") === normalized);
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw httpError(400, `${typeLabel} wurde nicht gefunden.`, "IMPORT_REFERENCE_NOT_FOUND");
  throw httpError(400, `${typeLabel} ist nicht eindeutig. Bitte die ID importieren.`, "IMPORT_REFERENCE_AMBIGUOUS");
}

function importFieldMapped(mapping, ...fields) {
  return fields.some((field) => Object.hasOwn(mapping, field));
}

function resolvePersonnelImportCandidate(incoming, mapping, existing, actor) {
  const creating = !existing;
  if (existing) {
    assertSessionContextScope(actor, {
      locationId: existing.home_location_id,
      departmentId: existing.preferred_department_id,
    });
  }
  const base = existing ? {
    personnelNumber: existing.personnel_number,
    fullName: existing.full_name,
    nickname: existing.nickname,
    color: existing.color,
    contractedHours: Number(existing.contracted_hours),
    preferredDayOff: existing.preferred_day_off || "",
    fixedWorkdays: String(existing.fixed_workdays || "").split(",").filter(Boolean),
    positionId: existing.position_id,
    timeConfirmationLevel: existing.time_confirmation_level || "C",
    homeLocationId: existing.home_location_id,
    preferredDepartmentId: existing.preferred_department_id || "",
    active: Boolean(existing.active),
  } : {
    personnelNumber: incoming.personnelNumber,
    fullName: incoming.fullName,
    nickname: incoming.nickname,
    color: incoming.color,
    contractedHours: incoming.contractedHours,
    preferredDayOff: incoming.preferredDayOff,
    fixedWorkdays: incoming.fixedWorkdays,
    positionId: incoming.positionId,
    timeConfirmationLevel: "C",
    homeLocationId: incoming.homeLocationId,
    preferredDepartmentId: incoming.preferredDepartmentId,
    active: incoming.active,
  };
  const use = (field) => creating || importFieldMapped(mapping, field);
  if (use("fullName")) base.fullName = incoming.fullName;
  if (use("nickname")) base.nickname = incoming.nickname;
  if (use("color")) base.color = incoming.color;
  if (use("contractedHours")) base.contractedHours = incoming.contractedHours;
  if (use("preferredDayOff")) base.preferredDayOff = incoming.preferredDayOff;
  if (use("fixedWorkdays")) base.fixedWorkdays = incoming.fixedWorkdays;
  if (use("active")) base.active = incoming.active;

  const references = personnelImportReferenceData(actor);
  if (creating || importFieldMapped(mapping, "positionId", "positionName")) {
    const position = incoming.positionId && references.positions.find((item) => item.id === incoming.positionId)
      || (incoming.positionName ? uniqueReferenceByName(references.positions, incoming.positionName, "Die Position") : null);
    if (!position) throw httpError(400, "Bitte eine g\u00fcltige Position zuordnen.", "IMPORT_POSITION_REQUIRED");
    base.positionId = position.id;
  }
  if (creating || importFieldMapped(mapping, "homeLocationId", "homeLocationName")) {
    const location = incoming.homeLocationId && references.locations.find((item) => item.id === incoming.homeLocationId)
      || (incoming.homeLocationName ? uniqueReferenceByName(references.locations, incoming.homeLocationName, "Der Standort") : null);
    if (!location) throw httpError(400, "Bitte einen g\u00fcltigen Standardstandort ausw\u00e4hlen.", "IMPORT_LOCATION_REQUIRED");
    base.homeLocationId = location.id;
  }
  if (creating || importFieldMapped(mapping, "preferredDepartmentId", "preferredDepartmentName")) {
    const location = references.locations.find((item) => item.id === base.homeLocationId);
    if (!incoming.preferredDepartmentId && !incoming.preferredDepartmentName) base.preferredDepartmentId = "";
    else {
      const departmentId = Number(incoming.preferredDepartmentId || 0);
      const department = departmentId && location?.departments.find((item) => Number(item.id) === departmentId)
        || (incoming.preferredDepartmentName ? uniqueReferenceByName(location?.departments || [], incoming.preferredDepartmentName, "Die Abteilung") : null);
      if (!department) throw httpError(400, "Bitte eine g\u00fcltige Abteilung zuordnen.", "IMPORT_DEPARTMENT_INVALID");
      base.preferredDepartmentId = department.id;
    }
  }
  const candidate = validateEmployee(base, creating, { defaultTimeConfirmationLevel: existing?.time_confirmation_level || "C" });
  assertSessionContextScope(actor, { locationId: candidate.homeLocationId, departmentId: candidate.preferredDepartmentId });
  return candidate;
}

function personnelImportPreview(actor, inspection, body = {}) {
  const sheetName = String(body.sheetName || inspection.sheets[0]?.name || "");
  const sheet = inspection.sheets.find((item) => item.name === sheetName);
  if (!sheet) throw httpError(400, "Das ausgew\u00e4hlte Tabellenblatt wurde nicht gefunden.", "IMPORT_SHEET_NOT_FOUND");
  const headerRow = Number(body.headerRow || 1);
  if (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > 20 || headerRow > sheet.rows.length) {
    throw httpError(400, "Die Kopfzeile ist ung\u00fcltig.", "IMPORT_HEADER_ROW_INVALID");
  }
  const headerCells = sheet.rows[headerRow - 1] || [];
  let mapping;
  try { mapping = normalizePersonnelImportMapping(body.mapping || {}, headerCells.length); }
  catch (error) {
    const message = error.message === "IMPORT_MAPPING_REQUIRED_FIELDS"
      ? "Personalnummer und vollst\u00e4ndiger Name m\u00fcssen zugeordnet sein."
      : "Die Feldzuordnung ist ung\u00fcltig.";
    throw httpError(400, message, error.message || "IMPORT_MAPPING_INVALID");
  }
  const fingerprint = headerFingerprint(headerCells);
  if (body.headerFingerprint && body.headerFingerprint !== fingerprint) {
    throw httpError(409, "Die Spalten stimmen nicht mehr mit dem ausgew\u00e4hlten Profil \u00fcberein.", "IMPORT_HEADER_CHANGED");
  }
  const duplicateStrategy = body.duplicateStrategy === "update" ? "update" : "skip";
  const profile = body.profileId ? integrationProfileById(body.profileId, "import", "personnel") : null;
  assertPersonnelImportProfileSource(profile, inspection);
  const defaults = body.defaults && typeof body.defaults === "object" ? body.defaults : (profile?.configuration?.defaults || {});
  const rows = [];
  const seen = new Map();
  const sourceRows = sheet.rows.slice(headerRow);
  sourceRows.forEach((sourceRow, offset) => {
    const rowNumber = headerRow + offset + 1;
    if (!sourceRow.some((cell) => cell.text || cell.formula || cell.error)) return;
    const incoming = mappedPersonnelRow(sourceRow, mapping, defaults);
    const errors = [];
    const warnings = [];
    for (const [field, meta] of Object.entries(incoming.sourceMeta || {})) {
      if (meta.formula) errors.push({ code: "FORMULA_CELL", field, message: "Formelzellen werden im Personalimport nicht \u00fcbernommen." });
      if (meta.error) errors.push({ code: "ERROR_CELL", field, message: "Die Quelldatei enth\u00e4lt in diesem Feld einen Excel-Fehler." });
    }
    if (!incoming.personnelNumber) errors.push({ code: "PERSONNEL_NUMBER_REQUIRED", field: "personnelNumber", message: "Personalnummer fehlt." });
    if (!incoming.fullName) errors.push({ code: "FULL_NAME_REQUIRED", field: "fullName", message: "Name fehlt." });
    if (incoming.derivedNickname) warnings.push({ code: "NICKNAME_DERIVED", field: "nickname", message: "Der Anzeigename wird aus dem ersten Namensteil gebildet." });
    const key = incoming.personnelNumber.toLocaleLowerCase("de-AT");
    if (key && seen.has(key)) {
      errors.push({ code: "DUPLICATE_IN_FILE", field: "personnelNumber", message: "Diese Personalnummer kommt in der Datei mehrfach vor." });
      seen.get(key).errors.push({ code: "DUPLICATE_IN_FILE", field: "personnelNumber", message: "Diese Personalnummer kommt in der Datei mehrfach vor." });
    } else if (key) seen.set(key, { errors });
    const existingMatches = incoming.personnelNumber ? employeeImportRowsCaseInsensitive(incoming.personnelNumber) : [];
    if (existingMatches.length > 1) {
      errors.push({ code: "PERSONNEL_NUMBER_AMBIGUOUS", field: "personnelNumber", message: "Diese Personalnummer ist im Bestand nicht eindeutig. Bitte die Stammdaten zuerst bereinigen." });
    }
    const existing = existingMatches.length === 1 ? existingMatches[0] : null;
    if (existing && existing.personnel_number !== incoming.personnelNumber) {
      warnings.push({ code: "PERSONNEL_NUMBER_CASE_MATCH", field: "personnelNumber", message: `Die Personalnummer entspricht dem bestehenden Eintrag ${existing.personnel_number}; Groß-/Kleinschreibung wird nicht als neue Person behandelt.` });
    }
    let candidate = null;
    let action = existing ? (duplicateStrategy === "update" ? "update" : "skip") : "create";
    if (existing && duplicateStrategy === "skip") warnings.push({ code: "EXISTING_SKIPPED", message: "Die vorhandene Personalnummer wird nicht ver\u00e4ndert." });
    if (!errors.length && action !== "skip") {
      try {
        candidate = resolvePersonnelImportCandidate(incoming, mapping, existing, actor);
        if (existing && employeeImportFingerprint(existing) === employeeImportFingerprint({
          personnel_number: candidate.personnelNumber,
          full_name: candidate.fullName,
          nickname: candidate.nickname,
          color: candidate.color,
          contracted_hours: candidate.contractedHours,
          preferred_day_off: candidate.preferredDayOff,
          fixed_workdays: candidate.fixedWorkdays,
          position_id: candidate.positionId,
          time_confirmation_level: candidate.timeConfirmationLevel,
          home_location_id: candidate.homeLocationId,
          preferred_department_id: candidate.preferredDepartmentId,
          active: candidate.active,
        })) {
          action = "skip";
          warnings.push({ code: "UNCHANGED", message: "Es sind keine \u00c4nderungen erforderlich." });
        }
      } catch (error) {
        errors.push({ code: error.code || "ROW_INVALID", message: error.message || "Die Zeile ist ung\u00fcltig." });
      }
    }
    if (errors.length) action = "error";
    rows.push({
      rowNumber,
      action,
      candidate,
      existingFingerprint: employeeImportFingerprint(existing),
      errors,
      warnings,
      display: {
        personnelNumber: incoming.personnelNumber,
        fullName: incoming.fullName,
        nickname: incoming.nickname,
        contractedHours: incoming.contractedHours,
        location: candidate?.homeLocationId || incoming.homeLocationId || incoming.homeLocationName,
        department: candidate?.preferredDepartmentId || incoming.preferredDepartmentId || incoming.preferredDepartmentName,
        position: candidate?.positionId || incoming.positionId || incoming.positionName,
        active: candidate ? Boolean(candidate.active) : incoming.active,
      },
    });
  });
  if (!rows.length) {
    throw httpError(400, "Unterhalb der Kopfzeile wurden keine Importdaten gefunden.", "IMPORT_DATA_ROWS_REQUIRED");
  }
  for (const row of rows) if (row.errors.length) row.action = "error";
  const summary = {
    total: rows.length,
    create: rows.filter((row) => row.action === "create").length,
    update: rows.filter((row) => row.action === "update").length,
    skip: rows.filter((row) => row.action === "skip").length,
    errors: rows.filter((row) => row.action === "error").length,
    warnings: rows.reduce((sum, row) => sum + row.warnings.length, 0),
  };
  return { sheetName, headerRow, mapping, headerFingerprint: fingerprint, duplicateStrategy, profileId: profile?.id || null, rows, summary };
}

function assertPersonnelImportProfileSource(profile, inspection) {
  if (!profile) return;
  const actualSourceType = inspection.sourceTransport === "sql_view" ? "sql" : "file";
  if (profile.configuration.sourceType !== actualSourceType) {
    throw httpError(409, "Das Importprofil ist an eine andere Quellenart gebunden.", "INTEGRATION_PROFILE_SOURCE_MISMATCH");
  }
  if (actualSourceType === "sql" && profile.configuration.connectionId !== inspection.connectionId) {
    throw httpError(409, "Das Importprofil ist an eine andere SQL-Personalquelle gebunden.", "INTEGRATION_PROFILE_CONNECTION_MISMATCH");
  }
}

function publicPersonnelPreview(preview, previewSession) {
  const errorRows = preview.rows.filter((row) => row.action === "error");
  const regularRows = preview.rows.filter((row) => row.action !== "error");
  const visibleRows = preview.rows.length <= 200
    ? preview.rows
    : [...errorRows.slice(0, 200), ...regularRows.slice(0, Math.max(0, 200 - errorRows.length))];
  return {
    previewId: previewSession.id,
    expiresAt: previewSession.expiresAt,
    summary: preview.summary,
    rows: visibleRows.map(({ candidate: _candidate, existingFingerprint: _fingerprint, ...row }) => row),
    truncated: preview.rows.length > 200,
    hiddenErrorCount: Math.max(0, errorRows.length - visibleRows.filter((row) => row.action === "error").length),
  };
}

function applyPersonnelImport(actor, preview) {
  if (preview.summary.errors) throw httpError(422, "Der Import enth\u00e4lt noch fehlerhafte Zeilen.", "IMPORT_HAS_ERRORS");
  const createEmployee = db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours, preferred_day_off, fixed_workdays,
       position_id, time_confirmation_level, home_location_id, preferred_department_id, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateEmployee = db.prepare(`
    UPDATE employees SET full_name = ?, nickname = ?, color = ?, contracted_hours = ?, preferred_day_off = ?,
      fixed_workdays = ?, position_id = ?, time_confirmation_level = ?, home_location_id = ?, preferred_department_id = ?, active = ?
    WHERE personnel_number = ?
  `);
  const runId = crypto.randomUUID();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of preview.rows) {
      if (!["create", "update"].includes(row.action)) continue;
      const candidate = row.candidate;
      const currentMatches = employeeImportRowsCaseInsensitive(candidate.personnelNumber);
      const current = currentMatches.length === 1 ? currentMatches[0] : null;
      if (row.action === "create" && currentMatches.length) throw httpError(409, "Die Importvorschau ist veraltet. Eine Personalnummer wurde inzwischen angelegt.", "IMPORT_PREVIEW_STALE");
      if (row.action === "update" && currentMatches.length !== 1) throw httpError(409, "Die Importvorschau ist veraltet. Die Personalnummer ist nicht mehr eindeutig.", "IMPORT_PREVIEW_STALE");
      if (row.action === "update" && employeeImportFingerprint(current) !== row.existingFingerprint) {
        throw httpError(409, "Die Importvorschau ist veraltet. Stammdaten wurden inzwischen ge\u00e4ndert.", "IMPORT_PREVIEW_STALE");
      }
      if (row.action === "update") {
        assertSessionContextScope(actor, {
          locationId: current.home_location_id,
          departmentId: current.preferred_department_id,
        });
      }
      const validated = validateEmployee(candidate, row.action === "create", { defaultTimeConfirmationLevel: candidate.timeConfirmationLevel || "C" });
      assertSessionContextScope(actor, { locationId: validated.homeLocationId, departmentId: validated.preferredDepartmentId });
      if (row.action === "create") {
        createEmployee.run(validated.personnelNumber, validated.fullName, validated.nickname, validated.color,
          validated.contractedHours, validated.preferredDayOff, validated.fixedWorkdays, validated.positionId,
          validated.timeConfirmationLevel, validated.homeLocationId, validated.preferredDepartmentId, validated.active);
      } else {
        updateEmployee.run(validated.fullName, validated.nickname, validated.color, validated.contractedHours,
          validated.preferredDayOff, validated.fixedWorkdays, validated.positionId, validated.timeConfirmationLevel,
          validated.homeLocationId, validated.preferredDepartmentId, validated.active, validated.personnelNumber);
      }
    }
    insertIntegrationRun({
      id: runId,
      profileId: preview.profileId,
      direction: "import",
      kind: "personnel",
      format: ["csv", "xlsx"].includes(preview.format) ? preview.format : "csv",
      contentSha256: preview.contentSha256,
      actor: actor.employeeNumber,
      totalCount: preview.summary.total,
      createdCount: preview.summary.create,
      updatedCount: preview.summary.update,
      skippedCount: preview.summary.skip,
      errorCount: 0,
      options: {
        duplicateStrategy: preview.duplicateStrategy,
        sheetName: preview.sheetName,
        headerRow: preview.headerRow,
        sourceTransport: preview.sourceTransport || "file",
        connectionId: preview.connectionId || null,
      },
      result: { rows: preview.rows.map((row) => ({ rowNumber: row.rowNumber, action: row.action })) },
    });
    auditPortal(actor.employeeNumber, "integration.personnel.import.applied", "integration_run", runId,
      JSON.stringify({ profileId: preview.profileId, total: preview.summary.total, created: preview.summary.create, updated: preview.summary.update, skipped: preview.summary.skip, contentSha256: preview.contentSha256 }));
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return { runId, ...preview.summary };
}

const payrollAbsenceCodeByOption = Object.freeze({
  vacation: "vacation",
  sick: "sickness",
  time_off: "time_off",
  branch: "branch_assignment",
  vocational_school: "vocational_school",
  school: "training",
  special_leave: "special_leave",
  external_appointment: "external_appointment",
  team_meeting: "team_meeting",
  other: "other",
});

function payrollOptionCreditedOnDate(option, date, settings, locationId) {
  if (!optionIsAllDay(option)) return true;
  if (option.option_type === "vacation") return vacationDayCount(date, date, settings, locationId) === 1;
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (day === 0) return false;
  if (!alwaysFullDayOptionTypes.has(option.option_type)) return true;
  let creditedBeforeOrOnDate = 0;
  for (let current = option.date_from; current <= date; current = addDays(current, 1)) {
    if (new Date(`${current}T12:00:00Z`).getUTCDay() !== 0) creditedBeforeOrOnDate += 1;
  }
  return creditedBeforeOrOnDate <= 5;
}

function payrollAbsencesForDay(employee, date, locationId, activeSickness = null, departmentId = null) {
  const employeeNumber = employee.personnel_number;
  if (String(employee.home_location_id || "") !== String(locationId || "")) return [];
  if (departmentId && Number(employee.preferred_department_id || 0) !== Number(departmentId)) return [];
  const settings = settingsForLocation(locationId);
  const rows = db.prepare(`
    SELECT id, option_type, date_from, date_to, all_day, start_time, end_time, credited_minutes_per_day
    FROM week_options
    WHERE employee_number = ? AND ? BETWEEN date_from AND date_to
    ORDER BY id
  `).all(employeeNumber, date);
  const absences = rows.filter((row) => payrollOptionCreditedOnDate(row, date, settings, locationId)).map((row) => {
    const internalCode = payrollAbsenceCodeByOption[row.option_type] || "other";
    const quantityMinutes = !row.all_day && isTime(row.start_time) && isTime(row.end_time)
      ? Math.max(0, timeToMinutes(row.end_time) - timeToMinutes(row.start_time))
      : optionMinutesPerDay(row, employee.contracted_hours);
    return {
      internalCode,
      referenceType: "week_option",
      referenceId: Number(row.id),
      quantityMinutes,
      quantityDays: row.all_day ? 1 : 0,
      unit: row.all_day ? "days" : "minutes",
      allDay: Boolean(row.all_day),
      startTime: row.start_time || "",
      endTime: row.end_time || "",
    };
  });
  const weekDay = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (weekDay >= 1 && weekDay <= 5 && (activeSickness || activeSicknessEmployeeNumbers(date)).has(employeeNumber) && !absences.some((absence) => absence.internalCode === "sickness")) {
    absences.push({
      internalCode: "sickness", referenceType: "sickness_case", referenceId: null,
      quantityMinutes: Math.round((Number(employee.contracted_hours || 0) * 60) / 5), quantityDays: 1,
      unit: "days", allDay: true, startTime: "", endTime: "",
    });
  }
  const holidayCredited = weekDay >= 1 && weekDay <= 5
    || (weekDay === 6 && settingEnabled(settings, "vacation_count_saturday"));
  if (employee.active && holidayCredited && isVacationHoliday(date, locationId)) {
    absences.push({
      internalCode: "public_holiday", referenceType: "public_holiday", referenceId: null,
      quantityMinutes: Math.round((Number(employee.contracted_hours || 0) * 60) / 5), quantityDays: 1,
      unit: "days", allDay: true, startTime: "", endTime: "",
    });
  }
  const unique = new Map();
  for (const absence of absences) {
    const key = `${absence.internalCode}:${absence.referenceType}:${absence.referenceId ?? date}`;
    if (!unique.has(key)) unique.set(key, absence);
  }
  return [...unique.values()];
}

function payrollEmployeesForContext(context, dateFrom, dateTo) {
  const employees = db.prepare(`
    SELECT e.personnel_number, e.full_name, e.contracted_hours, e.home_location_id, e.preferred_department_id, e.active
    FROM employees e
    WHERE (e.active = 1 AND e.home_location_id = ?)
       OR EXISTS (
         SELECT 1 FROM time_entries t
         WHERE t.employee_number = e.personnel_number AND t.location_id = ?
           AND t.work_date BETWEEN ? AND ? AND t.voided_at IS NULL
       )
       OR EXISTS (
         SELECT 1 FROM shifts s
         LEFT JOIN departments d ON d.id = s.department_id
         WHERE s.employee_number = e.personnel_number
           AND COALESCE(d.location_id, e.home_location_id) = ?
           AND s.shift_date BETWEEN ? AND ?
       )
       OR EXISTS (
         SELECT 1 FROM week_options w
         WHERE w.employee_number = e.personnel_number AND e.home_location_id = ?
           AND w.date_from <= ? AND w.date_to >= ?
       )
    ORDER BY CAST(e.personnel_number AS INTEGER), e.personnel_number
  `).all(context.locationId, context.locationId, dateFrom, dateTo,
    context.locationId, dateFrom, dateTo, context.locationId, dateTo, dateFrom);
  return employees.filter((employee) => {
    if (!context.departmentId) return true;
    if (Number(employee.preferred_department_id || 0) === Number(context.departmentId)) return true;
    return Boolean(db.prepare(`
      SELECT 1
      WHERE EXISTS (SELECT 1 FROM shifts WHERE employee_number = ? AND shift_date BETWEEN ? AND ? AND department_id = ?)
         OR EXISTS (SELECT 1 FROM time_entries WHERE employee_number = ? AND work_date BETWEEN ? AND ? AND department_id = ? AND voided_at IS NULL)
    `).get(employee.personnel_number, dateFrom, dateTo, context.departmentId,
      employee.personnel_number, dateFrom, dateTo, context.departmentId));
  });
}

function payrollCorrectionState(employeeNumber, date, locationId, departmentId = null) {
  const row = db.prepare(`
    SELECT status FROM time_corrections
    WHERE employee_number = ? AND correction_date = ?
      AND location_id = ?
      AND (? IS NULL OR department_id = ?)
    ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, id DESC LIMIT 1
  `).get(employeeNumber, date, locationId, departmentId, departmentId);
  return row?.status || "none";
}

function payrollWorkRanges(evaluation, sourceMode) {
  if (sourceMode === "planned") {
    return (evaluation.planned?.blocks || []).map((block) => ({ start: block.start_time, end: block.end_time }));
  }
  return (evaluation.actual?.segments || []).map((segment) => ({
    start: viennaNowLocal(segment.start).slice(11, 16),
    end: viennaNowLocal(segment.end).slice(11, 16),
  }));
}

function payrollAbsenceOverlapsWork(absence, ranges) {
  if (!ranges.length) return false;
  if (absence.allDay) return true;
  if (!isTime(absence.startTime) || !isTime(absence.endTime)) return true;
  return ranges.some((range) => isTime(range.start) && isTime(range.end)
    && timeRangesOverlap(absence.startTime, absence.endTime, range.start, range.end));
}

function payrollPreflight(actor, body = {}) {
  const dateFrom = String(body.dateFrom || body.from || "");
  const dateTo = String(body.dateTo || body.to || "");
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateTo < dateFrom || daysBetweenInclusive(dateFrom, dateTo) > 93) {
    throw httpError(400, "Bitte einen g\u00fcltigen Zeitraum von h\u00f6chstens 93 Tagen ausw\u00e4hlen.", "PAYROLL_RANGE_INVALID");
  }
  const context = resolvePlanningContext(body);
  assertSessionContextScope(actor, context);
  let configuration = body.configuration || {};
  const profile = body.profileId ? integrationProfileById(body.profileId, "export", "payroll") : null;
  if (profile) configuration = { ...profile.configuration, ...configuration };
  const config = normalizePayrollConfiguration(configuration);
  const employees = payrollEmployeesForContext(context, dateFrom, dateTo);
  const sicknessByDate = new Map();
  const days = [];
  const blockers = [];
  const warnings = [{
    code: "CURRENT_RULES_USED",
    message: "Vertragsstunden und Zuschlagsregeln sind noch nicht historisiert; f\u00fcr den Zeitraum gilt der aktuell gespeicherte Regelstand.",
  }];
  for (const employee of employees) {
    for (let date = dateFrom; date <= dateTo; date = addDays(date, 1)) {
      if (!sicknessByDate.has(date)) sicknessByDate.set(date, activeSicknessEmployeeNumbers(date));
      const activeSickness = sicknessByDate.get(date);
      const dayEntries = timeEntriesForDay(employee.personnel_number, date);
      const evaluation = evaluateTimeDay(employee.personnel_number, date, new Date(), context.departmentId, dayEntries, {
        locationId: context.locationId,
        filterLocation: true,
        activeSickness,
        includeInactive: true,
      });
      const conflictAbsences = payrollAbsencesForDay(employee, date, context.locationId, activeSickness, null);
      const absences = context.departmentId
        ? payrollAbsencesForDay(employee, date, context.locationId, activeSickness, context.departmentId)
        : conflictAbsences;
      const relevant = evaluation.plannedMinutes > 0 || evaluation.actualMinutes > 0 || absences.length > 0
        || evaluation.pendingCorrection || Boolean(evaluation.review);
      if (!relevant) continue;
      const reviewState = config.sourceMode === "planned" ? "not_required"
        : !evaluation.review ? "missing" : evaluation.review.stale ? "stale" : "reviewed";
      const correctionState = payrollCorrectionState(employee.personnel_number, date, context.locationId, context.departmentId);
      const issueCodes = (evaluation.issues || []).map((issue) => issue.code);
      const departmentIds = new Set([
        ...(evaluation.planned?.blocks || []).map((block) => Number(block.department_id || 0)),
        ...dayEntries.filter((entry) => String(entry.location_id || employee.home_location_id) === context.locationId)
          .map((entry) => Number(entry.department_id || 0)),
      ].filter(Boolean));
      if (!context.departmentId && departmentIds.size > 1) {
        issueCodes.push("mixed_departments");
        blockers.push({ code: "MIXED_DEPARTMENTS", employeeNumber: employee.personnel_number, workDate: date });
      }
      const exportedDepartmentId = context.departmentId
        || (departmentIds.size === 1 ? [...departmentIds][0] : (departmentIds.size ? "" : employee.preferred_department_id || ""));
      const workRanges = payrollWorkRanges(evaluation, config.sourceMode);
      const overlappingAbsence = conflictAbsences.find((absence) => absence.internalCode !== "public_holiday"
        && payrollAbsenceOverlapsWork(absence, workRanges));
      const hasWork = (config.sourceMode === "planned" ? evaluation.plannedMinutes : evaluation.actualMinutes) > 0;
      if (config.sourceMode === "actual_reviewed" && employee.home_location_id !== context.locationId && evaluation.actualMinutes > 0) {
        blockers.push({ code: "CROSS_LOCATION_REVIEW_UNAVAILABLE", employeeNumber: employee.personnel_number, workDate: date });
      }
      if (config.sourceMode === "actual_reviewed" && hasWork && reviewState !== "reviewed") {
        blockers.push({ code: reviewState === "stale" ? "STALE_REVIEW" : "MISSING_REVIEW", employeeNumber: employee.personnel_number, workDate: date });
      }
      if (config.sourceMode === "actual_reviewed" && correctionState === "pending") {
        blockers.push({ code: "PENDING_CORRECTION", employeeNumber: employee.personnel_number, workDate: date });
      }
      if (config.sourceMode === "actual_reviewed" && (evaluation.incomplete || (evaluation.issues || []).some((issue) => issue.severity === "error"))) {
        blockers.push({ code: "TIME_EVALUATION_ERROR", employeeNumber: employee.personnel_number, workDate: date });
      }
      if (overlappingAbsence && (config.sourceMode === "planned" ? evaluation.plannedMinutes : evaluation.actualMinutes) > 0) {
        blockers.push({ code: "WORK_ABSENCE_OVERLAP", employeeNumber: employee.personnel_number, workDate: date });
      }
      if (!employee.active) {
        warnings.push({ code: "INACTIVE_EMPLOYEE_INCLUDED", employeeNumber: employee.personnel_number, workDate: date, message: "Ein inaktives Teammitglied hat Bewegungen im Exportzeitraum; der Beschäftigungszeitraum ist noch nicht historisiert." });
        blockers.push({ code: "INACTIVE_EMPLOYMENT_HISTORY_REQUIRED", employeeNumber: employee.personnel_number, workDate: date });
      }
      const settings = settingsForLocation(context.locationId);
      const saturdayFactor = Number(settings.saturday_bonus_factor || 1);
      const plannedEligible = saturdayFactor > 1
        ? Math.round(Number(evaluation.planned?.saturdayBonusMinutes || 0) / (saturdayFactor - 1))
        : 0;
      days.push({
        personnelNumber: employee.personnel_number,
        fullName: employee.full_name,
        workDate: date,
        locationId: context.locationId,
        departmentId: exportedDepartmentId,
        sourceMode: config.sourceMode,
        plannedMinutes: Number(evaluation.plannedMinutes || 0),
        actualMinutes: Number(evaluation.actualMinutes || 0),
        breakMinutes: Number(evaluation.breakMinutes || 0),
        saturdayBonusMinutes: config.sourceMode === "planned"
          ? Number(evaluation.planned?.saturdayBonusMinutes || 0)
          : Number(evaluation.saturdayBonusMinutes || 0),
        saturdayEligibleMinutes: config.sourceMode === "planned"
          ? plannedEligible
          : Number(evaluation.actual?.saturdayEligibleMinutes || 0),
        saturdayFactor,
        valuedMinutes: config.sourceMode === "planned" ? Number(evaluation.plannedValuedMinutes || 0) : Number(evaluation.actualValuedMinutes || 0),
        differenceMinutes: Number(evaluation.differenceMinutes || 0),
        absences,
        reviewState,
        correctionState,
        issueCodes,
      });
    }
  }
  const built = buildPayrollRows(days, config);
  const fingerprint = sha256(JSON.stringify({ dateFrom, dateTo, context, config: built.config, rows: built.rows }));
  return {
    dateFrom,
    dateTo,
    context,
    profileId: profile?.id || null,
    configuration: built.config,
    columns: built.columns,
    rows: built.rows,
    rowCount: built.rows.length,
    employeeCount: new Set(days.map((day) => day.personnelNumber)).size,
    dayCount: days.length,
    blockers,
    warnings: warnings.slice(0, 200),
    fingerprint,
  };
}

function payrollFileName(preflight, draft = false) {
  const extension = preflight.configuration.format === "xlsx" ? "xlsx" : "csv";
  const mode = preflight.configuration.sourceMode === "planned" ? "planwerte" : "istzeiten";
  return `${draft ? "ENTWURF-" : ""}grabenplaner-lohnexport-${mode}-${preflight.dateFrom}-${preflight.dateTo}.${extension}`;
}

function payrollRowsForCsv(preflight) {
  if (preflight.configuration.decimalSeparator !== "comma") return preflight.rows;
  return preflight.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    typeof value === "number" && !Number.isInteger(value) ? String(value).replace(".", ",") : value,
  ])));
}

function serializeIntegrationDelivery(row) {
  return {
    id: row.id,
    connectionId: row.connection_id,
    profileId: row.profile_id || null,
    dateFrom: row.date_from,
    dateTo: row.date_to,
    locationId: row.location_id,
    departmentId: row.department_id || null,
    connectionRevision: Math.max(1, Number(row.connection_revision || 1)),
    connectionFingerprint: row.connection_fingerprint || "",
    payloadSha256: row.payload_sha256,
    rowCount: Number(row.row_count || 0),
    status: row.status,
    attemptCount: Number(row.attempt_count || 0),
    httpStatus: row.http_status === null ? null : Number(row.http_status),
    errorCode: row.error_code || "",
    actorEmployeeNumber: row.actor_employee_number || "",
    startedAt: row.started_at,
    completedAt: row.completed_at || null,
    updatedAt: row.updated_at,
  };
}

function reconcileInterruptedIntegrationDeliveries() {
  if (!tableExists("integration_deliveries")) return 0;
  const interrupted = db.prepare("SELECT id FROM integration_deliveries WHERE status = 'sending'").all();
  if (!interrupted.length) return 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const markUnknown = db.prepare(`
      UPDATE integration_deliveries
      SET status = 'unknown', error_code = 'PROCESS_INTERRUPTED',
          completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'sending'
    `);
    let recovered = 0;
    for (const row of interrupted) {
      if (markUnknown.run(row.id).changes) {
        recovered += 1;
        auditPortal("system", "integration.payroll.delivery.recovered", "integration_delivery", row.id,
          JSON.stringify({ status: "unknown", errorCode: "PROCESS_INTERRUPTED" }));
      }
    }
    db.exec("COMMIT");
    return recovered;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

reconcileInterruptedIntegrationDeliveries();

function minimizedPayrollApiPayload(preflight, deliveryId, generatedAt) {
  const columns = preflight.columns.filter((column) => column.id !== "fullName")
    .map((column) => ({ id: column.id, label: column.label, type: column.type }));
  const rows = preflight.rows.map((row) => Object.fromEntries(columns.map((column) => [column.id, row[column.id] ?? ""])));
  const dataSha256 = payloadSha256({ columns, rows });
  return {
    schema: CONTRACT_IDS.payrollHttpsJson,
    deliveryId,
    generatedAt,
    source: {
      dateFrom: preflight.dateFrom,
      dateTo: preflight.dateTo,
      locationId: preflight.context.locationId,
      departmentId: preflight.context.departmentId || null,
      sourceMode: preflight.configuration.sourceMode,
      layout: preflight.configuration.layout,
    },
    columns,
    rows,
    dataSha256,
  };
}

app.get("/api/integrations/contracts", (request, response) => {
  integrationActor(request, "integrations:read");
  response.json({
    contracts: contractSummaries().map((contract) => ({
      ...contract,
      documentUrl: `/api/integrations/contracts/${encodeURIComponent(contract.id)}?download=1`,
    })),
  });
});

app.get("/api/integrations/contracts/:id", (request, response) => {
  integrationActor(request, "integrations:read");
  const contract = contractById(request.params.id);
  if (!contract) throw httpError(404, "Der Schnittstellenvertrag wurde nicht gefunden.", "INTEGRATION_CONTRACT_NOT_FOUND");
  const sha256 = contractSha256(contract);
  response.setHeader("ETag", `\"sha256-${sha256}\"`);
  response.setHeader("Cache-Control", "private, no-store");
  if (String(request.query.download || "") === "1") {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Content-Disposition", `attachment; filename=\"${contract.id}.json\"`);
  }
  response.json({ contract, documentSha256: sha256 });
});

app.get("/api/integrations/connections/catalog", (request, response) => {
  const actor = integrationActor(request, "integrations:connections:read");
  assertGlobalIntegrationConnectionActor(actor);
  response.json({ ...integrationConnectionCatalog(), secretStoreAvailable: Boolean(integrationSecretVault) });
});

app.get("/api/integrations/connections", (request, response) => {
  const actor = integrationActor(request, "integrations:connections:read");
  assertGlobalIntegrationConnectionActor(actor);
  response.json({ connections: integrationConnectionRows(String(request.query.kind || "")) });
});

app.post("/api/integrations/connections", (request, response) => {
  const actor = integrationActor(request, "integrations:connections:write");
  assertGlobalIntegrationConnectionActor(actor);
  const connection = normalizeIntegrationConnectionRequest(request.body || {});
  const id = crypto.randomUUID();
  let protectedState = { protectedCredentials: "", keyId: "" };
  if (connection.credentials && Object.keys(connection.credentials).length) {
    assertIntegrationPermission(actor, "integrations:credentials:write");
    protectedState = protectIntegrationCredentials(id, connection.kind, connection.credentials);
  }
  try {
    db.prepare(`
      INSERT INTO integration_connections
        (id, kind, name, provider, configuration_json, protected_credentials, credential_key_id,
         active, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, connection.kind, connection.name, connection.provider, JSON.stringify(connection.configuration),
      protectedState.protectedCredentials, protectedState.keyId, connection.active ? 1 : 0,
      actor.employeeNumber, actor.employeeNumber);
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      throw httpError(409, "Eine direkte Verbindung mit diesem Namen besteht bereits.", "INTEGRATION_CONNECTION_DUPLICATE");
    }
    throw error;
  }
  auditPortal(actor.employeeNumber, "integration.connection.create", "integration_connection", id,
    JSON.stringify({ kind: connection.kind, provider: connection.provider, credentialsConfigured: Boolean(protectedState.protectedCredentials) }));
  response.status(201).json({ connection: integrationConnectionById(id, "", { includeInactive: true }).public });
});

app.put("/api/integrations/connections/:id", (request, response) => {
  const actor = integrationActor(request, "integrations:connections:write");
  assertGlobalIntegrationConnectionActor(actor);
  const existing = integrationConnectionById(request.params.id, "", { includeInactive: true });
  const connection = normalizeIntegrationConnectionRequest(request.body || {}, existing);
  let protectedCredentials = existing.row.protected_credentials;
  let keyId = existing.row.credential_key_id;
  if (connection.credentials !== null) {
    assertIntegrationPermission(actor, "integrations:credentials:write");
    const protectedState = protectIntegrationCredentials(existing.row.id, connection.kind, connection.credentials);
    protectedCredentials = protectedState.protectedCredentials;
    keyId = protectedState.keyId;
  }
  try {
    db.prepare(`
      UPDATE integration_connections
      SET name = ?, provider = ?, configuration_json = ?, protected_credentials = ?, credential_key_id = ?,
          active = ?, revision = revision + 1, last_test_status = '', last_test_at = NULL, last_error_code = '',
          updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(connection.name, connection.provider, JSON.stringify(connection.configuration), protectedCredentials, keyId,
      connection.active ? 1 : 0, actor.employeeNumber, existing.row.id);
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      throw httpError(409, "Eine direkte Verbindung mit diesem Namen besteht bereits.", "INTEGRATION_CONNECTION_DUPLICATE");
    }
    throw error;
  }
  auditPortal(actor.employeeNumber, "integration.connection.update", "integration_connection", existing.row.id,
    JSON.stringify({ kind: connection.kind, provider: connection.provider, credentialsReplaced: connection.credentials !== null }));
  response.json({ connection: integrationConnectionById(existing.row.id, "", { includeInactive: true }).public });
});

app.delete("/api/integrations/connections/:id", (request, response) => {
  const actor = integrationActor(request, "integrations:connections:write");
  assertGlobalIntegrationConnectionActor(actor);
  const existing = integrationConnectionById(request.params.id, "", { includeInactive: true });
  db.prepare(`
    UPDATE integration_connections SET active = 0, revision = revision + 1, last_test_status = '', last_error_code = '',
      updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(actor.employeeNumber, existing.row.id);
  auditPortal(actor.employeeNumber, "integration.connection.disable", "integration_connection", existing.row.id,
    JSON.stringify({ kind: existing.row.kind }));
  response.status(204).end();
});

app.post("/api/integrations/connections/:id/test", async (request, response) => {
  const actor = integrationActor(request, "integrations:connections:write");
  assertGlobalIntegrationConnectionActor(actor);
  const connection = integrationConnectionById(request.params.id);
  let status = "ready";
  let errorCode = "";
  try {
    if (connection.row.kind === "personnel_sql_source") {
      await withIntegrationCredentials(connection, async (credentials) => {
        const config = connection.public.configuration;
        const columns = await sqlViewSource.listColumns(sqlSourceConfiguration(connection), credentials, {
          schema: config.schemaName,
          view: config.objectName,
        });
        allowedSqlPersonnelColumns(config, columns.columns);
      });
    } else {
      const client = apiDeliveryClient(connection);
      await withIntegrationCredentials(connection, async () => client.probe({ url: connection.public.configuration.endpoint }));
    }
  } catch (error) {
    status = "error";
    errorCode = String(error.code || "INTEGRATION_CONNECTION_TEST_FAILED").slice(0, 80);
    db.prepare(`UPDATE integration_connections SET last_test_status = ?, last_test_at = CURRENT_TIMESTAMP,
      last_error_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(status, errorCode, connection.row.id);
    auditPortal(actor.employeeNumber, "integration.connection.test", "integration_connection", connection.row.id,
      JSON.stringify({ kind: connection.row.kind, status, errorCode }));
    if (!error.status) error.status = 502;
    throw error;
  }
  db.prepare(`UPDATE integration_connections SET last_test_status = ?, last_test_at = CURRENT_TIMESTAMP,
    last_error_code = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(status, connection.row.id);
  auditPortal(actor.employeeNumber, "integration.connection.test", "integration_connection", connection.row.id,
    JSON.stringify({ kind: connection.row.kind, status }));
  response.json({ ok: true, connection: integrationConnectionById(connection.row.id).public });
});

app.post("/api/integrations/connections/:id/sql/inspect", async (request, response) => {
  const actor = integrationActor(request, "employees:import");
  assertGlobalSqlPersonnelImportActor(actor);
  assertIntegrationPermission(actor, "integrations:connections:read");
  const connection = integrationConnectionById(request.params.id, "personnel_sql_source");
  if (connection.public.status !== "ready") {
    throw httpError(409, "Die SQL-Personalquelle muss nach der letzten Änderung zuerst erfolgreich geprüft werden.", "INTEGRATION_CONNECTION_NOT_READY");
  }
  const scopeContext = sqlPersonnelScopeContext(request.body);
  assertIntegrationConnectionScope(actor, connection, scopeContext);
  const config = connection.public.configuration;
  const result = await withIntegrationCredentials(connection, async (credentials) => {
    const metadata = await sqlViewSource.listColumns(sqlSourceConfiguration(connection), credentials, {
      schema: config.schemaName,
      view: config.objectName,
    });
    const selectedColumns = allowedSqlPersonnelColumns(config, metadata.columns);
    return sqlViewSource.readView(sqlSourceConfiguration(connection), credentials, {
      schema: config.schemaName,
      view: config.objectName,
      columns: selectedColumns.map((column) => column.name),
      maxRows: config.rowLimit,
    });
  });
  const parsed = sqlInspectionFromResult(connection, result, scopeContext);
  const session = integrationCache.create(actor.employeeNumber, "personnel-inspection", parsed);
  auditPortal(actor.employeeNumber, "integration.personnel.sql.inspect", "integration_connection", connection.row.id,
    JSON.stringify({ rows: result.rowCount, columns: result.columns.length, contentSha256: parsed.contentSha256 }));
  response.status(201).json(publicPersonnelInspection(parsed, session));
});

app.get("/api/integrations/personnel-import/catalog", (request, response) => {
  const actor = integrationActor(request, "employees:import");
  response.json({
    fields: publicPersonnelImportFields(),
    references: personnelImportReferenceData(actor),
    limits: { maxBytes: MAX_IMPORT_BYTES, maxRows: 5000, maxColumns: 100 },
    duplicateStrategies: [
      { id: "skip", label: "Vorhandene Personalnummern \u00fcberspringen" },
      { id: "update", label: "Vorhandene Stammdaten aktualisieren" },
    ],
  });
});

app.post("/api/integrations/personnel-import/inspect", express.raw({
  type: ["text/csv", "text/tab-separated-values", "application/csv", "application/vnd.ms-excel", "application/octet-stream", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  limit: "5mb",
}), async (request, response) => {
  const actor = integrationActor(request, "employees:import");
  let fileName = String(request.get("X-Import-Filename") || "import.csv");
  try { fileName = decodeURIComponent(fileName); } catch {}
  const parsed = await inspectTabularBuffer(request.body, {
    fileName,
    contentType: request.get("Content-Type") || "",
    encoding: String(request.query.encoding || "auto"),
    delimiter: String(request.query.delimiter || "auto") === "tab" ? "\t" : String(request.query.delimiter || "auto"),
  });
  const session = integrationCache.create(actor.employeeNumber, "personnel-inspection", parsed);
  response.status(201).json(publicPersonnelInspection(parsed, session));
});

app.post("/api/integrations/personnel-import/preview", (request, response) => {
  const actor = integrationActor(request, "employees:import");
  const inspectionEntry = integrationCache.get(request.body.inspectionId, actor.employeeNumber, "personnel-inspection");
  const preview = personnelImportPreview(actor, inspectionEntry.value, request.body || {});
  preview.inspectionId = request.body.inspectionId;
  preview.format = inspectionEntry.value.format;
  preview.sourceTransport = inspectionEntry.value.sourceTransport || "file";
  preview.connectionId = inspectionEntry.value.connectionId || null;
  preview.connectionFingerprint = inspectionEntry.value.connectionFingerprint || null;
  preview.connectionScopeContext = inspectionEntry.value.connectionScopeContext || null;
  preview.sourceContractId = inspectionEntry.value.sourceContractId || null;
  preview.contentSha256 = inspectionEntry.value.contentSha256;
  integrationCache.deleteKind(actor.employeeNumber, "personnel-preview");
  const previewSession = integrationCache.create(actor.employeeNumber, "personnel-preview", preview);
  response.status(201).json(publicPersonnelPreview(preview, previewSession));
});

app.post("/api/integrations/personnel-import/apply", (request, response) => {
  const actor = integrationActor(request, "employees:import");
  const entry = integrationCache.get(request.body.previewId, actor.employeeNumber, "personnel-preview");
  if (entry.value.sourceTransport === "sql_view") revalidateSqlPersonnelPreviewConnection(actor, entry.value);
  const result = applyPersonnelImport(actor, entry.value);
  integrationCache.delete(entry.id, actor.employeeNumber);
  if (entry.value.inspectionId) integrationCache.delete(entry.value.inspectionId, actor.employeeNumber);
  response.status(201).json({ ok: true, ...result });
});

app.delete("/api/integrations/personnel-import/sessions/:id", (request, response) => {
  const actor = integrationActor(request, "employees:import");
  integrationCache.delete(request.params.id, actor.employeeNumber);
  response.status(204).end();
});

app.get("/api/integrations/profiles", (request, response) => {
  integrationActor(request, "integrations:read");
  response.json({ profiles: integrationProfiles({ direction: request.query.direction, kind: request.query.kind }) });
});

app.post("/api/integrations/profiles", (request, response) => {
  const actor = integrationActor(request, "integrations:profiles:write");
  const profile = normalizeIntegrationProfile(request.body || {});
  const id = crypto.randomUUID();
  try {
    db.prepare(`
      INSERT INTO integration_profiles
        (id, direction, kind, name, format, configuration_json, active, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, profile.direction, profile.kind, profile.name, profile.format, JSON.stringify(profile.configuration), profile.active ? 1 : 0, actor.employeeNumber, actor.employeeNumber);
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) throw httpError(409, "Ein Profil mit diesem Namen besteht bereits.", "INTEGRATION_PROFILE_DUPLICATE");
    throw error;
  }
  auditPortal(actor.employeeNumber, "integration.profile.create", "integration_profile", id, JSON.stringify({ direction: profile.direction, kind: profile.kind, format: profile.format }));
  response.status(201).json({ profile: serializeIntegrationProfile(db.prepare("SELECT * FROM integration_profiles WHERE id = ?").get(id)) });
});

app.put("/api/integrations/profiles/:id", (request, response) => {
  const actor = integrationActor(request, "integrations:profiles:write");
  const existing = integrationProfileById(request.params.id, "", "", { includeInactive: true });
  const profile = normalizeIntegrationProfile(request.body || {}, existing);
  try {
    db.prepare(`
      UPDATE integration_profiles SET name = ?, format = ?, configuration_json = ?, active = ?,
        updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(profile.name, profile.format, JSON.stringify(profile.configuration), profile.active ? 1 : 0, actor.employeeNumber, existing.id);
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) throw httpError(409, "Ein Profil mit diesem Namen besteht bereits.", "INTEGRATION_PROFILE_DUPLICATE");
    throw error;
  }
  auditPortal(actor.employeeNumber, "integration.profile.update", "integration_profile", existing.id, JSON.stringify({ direction: profile.direction, kind: profile.kind, format: profile.format }));
  response.json({ profile: serializeIntegrationProfile(db.prepare("SELECT * FROM integration_profiles WHERE id = ?").get(existing.id)) });
});

app.delete("/api/integrations/profiles/:id", (request, response) => {
  const actor = integrationActor(request, "integrations:profiles:write");
  const existing = integrationProfileById(request.params.id, "", "", { includeInactive: true });
  db.prepare("DELETE FROM integration_profiles WHERE id = ?").run(existing.id);
  auditPortal(actor.employeeNumber, "integration.profile.delete", "integration_profile", existing.id, JSON.stringify({ direction: existing.direction, kind: existing.kind }));
  response.status(204).end();
});

app.get("/api/integrations/runs", (request, response) => {
  const actor = integrationActor(request, "integrations:read");
  const requestedLimit = Number(request.query.limit);
  const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.trunc(requestedLimit))) : 30;
  const globalAccess = sessionHasGlobalScope(actor);
  const rows = db.prepare(`
    SELECT * FROM integration_runs
    ${globalAccess ? "" : "WHERE actor_employee_number = ?"}
    ORDER BY started_at DESC, id DESC LIMIT ?
  `).all(...(globalAccess ? [limit] : [actor.employeeNumber, limit])).map(serializeIntegrationRun);
  response.json({ runs: rows });
});

app.get("/api/integrations/payroll-export/catalog", (request, response) => {
  integrationActor(request, "payroll:export");
  response.json({ ...payrollCatalog(), locations: getLocationsForSession(request.portalSession, true) });
});

app.post("/api/integrations/payroll-export/preflight", (request, response) => {
  const actor = integrationActor(request, "payroll:export");
  const preflight = payrollPreflight(actor, request.body || {});
  response.json({
    dateFrom: preflight.dateFrom,
    dateTo: preflight.dateTo,
    context: preflight.context,
    profileId: preflight.profileId,
    configuration: preflight.configuration,
    columns: preflight.columns,
    rowCount: preflight.rowCount,
    employeeCount: preflight.employeeCount,
    dayCount: preflight.dayCount,
    blockers: preflight.blockers.slice(0, 200),
    warnings: preflight.warnings,
    fingerprint: preflight.fingerprint,
    sampleRows: preflight.rows.slice(0, 50),
    sampleTruncated: preflight.rows.length > 50,
  });
});

app.get("/api/integrations/payroll-export/deliveries", (request, response) => {
  const actor = integrationActor(request, "integrations:read");
  const requestedLimit = Number(request.query.limit);
  const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.trunc(requestedLimit))) : 30;
  const globalAccess = sessionHasGlobalScope(actor);
  const rows = db.prepare(`
    SELECT * FROM integration_deliveries
    ${globalAccess ? "" : "WHERE actor_employee_number = ?"}
    ORDER BY started_at DESC, id DESC LIMIT ?
  `).all(...(globalAccess ? [limit] : [actor.employeeNumber, limit])).map(serializeIntegrationDelivery);
  response.json({ deliveries: rows });
});

app.post("/api/integrations/payroll-export/deliver", async (request, response) => {
  const actor = integrationActor(request, "payroll:deliver");
  const connection = integrationConnectionById(request.body.connectionId, "payroll_https_target");
  if (connection.public.configuration.contractId !== CONTRACT_IDS.payrollHttpsJson) {
    throw httpError(409, "Das HTTPS-Ziel ist nicht an den aktuellen Lohnvertrag gebunden.", "INTEGRATION_CONTRACT_MISMATCH");
  }
  const preflight = payrollPreflight(actor, request.body || {});
  if (!request.body.fingerprint || request.body.fingerprint !== preflight.fingerprint) {
    throw httpError(409, "Die Daten haben sich seit der Vorprüfung geändert. Bitte erneut prüfen.", "PAYROLL_PREFLIGHT_STALE");
  }
  if (preflight.configuration.sourceMode !== "actual_reviewed") {
    throw httpError(422,
      "Die direkte Übertragung ist ausschließlich mit final geprüften Ist-Zeiten zulässig.",
      "PAYROLL_DELIVERY_FINAL_VALUES_REQUIRED");
  }
  if (preflight.blockers.length) {
    throw httpError(422, "Eine direkte Übertragung ist erst ohne offene Prüfpunkte möglich.", "PAYROLL_DELIVERY_BLOCKED");
  }
  if (!preflight.rowCount) throw httpError(422, "Für die direkte Übertragung sind keine Daten vorhanden.", "PAYROLL_DELIVERY_EMPTY");
  assertIntegrationConnectionScope(actor, connection, {
    locationId: preflight.context.locationId,
    departmentId: preflight.context.departmentId || "",
  });
  if (connection.public.status !== "ready") {
    throw httpError(409, "Das HTTPS-Lohnziel muss nach der letzten Änderung zuerst erfolgreich geprüft werden.", "INTEGRATION_CONNECTION_NOT_READY");
  }
  const connectionRevision = Math.max(1, Number(connection.row.revision || 1));
  const connectionFingerprint = integrationConnectionConfigurationFingerprint(connection);
  const idempotencyKey = createIdempotencyKey({
    connectorId: `${connection.row.id}:${connectionRevision}:${connectionFingerprint}`,
    profileId: preflight.profileId || "inline",
    fingerprint: preflight.fingerprint,
    scope: `${preflight.context.locationId}:${preflight.context.departmentId || "all"}:${preflight.dateFrom}:${preflight.dateTo}`,
  });
  let deliveryRow = db.prepare("SELECT * FROM integration_deliveries WHERE idempotency_key = ?").get(idempotencyKey);
  if (deliveryRow && !(request.body.retry === true && deliveryRow.status === "unknown")) {
    response.status(deliveryRow.status === "delivered" ? 200 : 409).json({
      ok: deliveryRow.status === "delivered",
      reused: true,
      delivery: serializeIntegrationDelivery(deliveryRow),
    });
    return;
  }
  const deliveryId = deliveryRow?.id || crypto.randomUUID();
  const generatedAt = deliveryRow?.started_at || new Date().toISOString();
  const payload = minimizedPayrollApiPayload(preflight, deliveryId, generatedAt);
  const contentSha256 = payloadSha256(payload);
  if (deliveryRow && deliveryRow.payload_sha256 !== contentSha256) {
    throw httpError(409, "Die frühere Übertragung kann wegen geänderter Daten nicht wiederholt werden.", "PAYROLL_DELIVERY_PAYLOAD_CHANGED");
  }
  if (!deliveryRow) {
    db.prepare(`
      INSERT INTO integration_deliveries
        (id, connection_id, profile_id, idempotency_key, date_from, date_to, location_id, department_id,
         connection_revision, connection_fingerprint, payload_sha256, row_count, status, attempt_count,
         actor_employee_number, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    `).run(deliveryId, connection.row.id, preflight.profileId, idempotencyKey, preflight.dateFrom, preflight.dateTo,
      preflight.context.locationId, preflight.context.departmentId || "", connectionRevision, connectionFingerprint,
      contentSha256, preflight.rowCount,
      actor.employeeNumber, generatedAt, generatedAt);
  }
  const claim = db.prepare(`
    UPDATE integration_deliveries
    SET status = 'sending', attempt_count = attempt_count + 1, http_status = NULL, error_code = '',
        completed_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('pending', 'unknown')
  `).run(deliveryId);
  if (!claim.changes) {
    deliveryRow = db.prepare("SELECT * FROM integration_deliveries WHERE id = ?").get(deliveryId);
    response.status(409).json({ ok: false, reused: true, delivery: serializeIntegrationDelivery(deliveryRow) });
    return;
  }
  try {
    const result = await withIntegrationCredentials(connection, async (credentials) => {
      const client = apiDeliveryClient(connection);
      return client.deliver({
        url: connection.public.configuration.endpoint,
        payload,
        headers: {
          ...apiAuthenticationHeaders(connection, credentials),
          "user-agent": `Grabenplaner/${packageMetadata.version}`,
        },
        idempotencyKey,
      });
    });
    const status = result.ok ? "delivered" : "rejected";
    const errorCode = result.ok ? "" : "API_DELIVERY_REJECTED";
    db.prepare(`
      UPDATE integration_deliveries
      SET status = ?, http_status = ?, error_code = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, result.statusCode, errorCode, deliveryId);
    auditPortal(actor.employeeNumber, "integration.payroll.delivery", "integration_delivery", deliveryId,
      JSON.stringify({ connectionId: connection.row.id, rows: preflight.rowCount, status, httpStatus: result.statusCode, contentSha256 }));
    const completed = serializeIntegrationDelivery(db.prepare("SELECT * FROM integration_deliveries WHERE id = ?").get(deliveryId));
    if (!result.ok) throw httpError(502, "Das Zielsystem hat die Übertragung abgelehnt.", "PAYROLL_DELIVERY_REJECTED");
    response.status(201).json({ ok: true, delivery: completed });
  } catch (error) {
    const current = db.prepare("SELECT status FROM integration_deliveries WHERE id = ?").get(deliveryId);
    if (current?.status === "sending") {
      const errorCode = String(error.code || "API_DELIVERY_UNKNOWN").slice(0, 80);
      const definitive = errorCode.startsWith("INTEGRATION_SECRET_") || errorCode.includes("AUTHENTICATION");
      db.prepare(`
        UPDATE integration_deliveries
        SET status = ?, error_code = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(definitive ? "rejected" : "unknown", errorCode, deliveryId);
      auditPortal(actor.employeeNumber, "integration.payroll.delivery", "integration_delivery", deliveryId,
        JSON.stringify({ connectionId: connection.row.id, rows: preflight.rowCount, status: definitive ? "rejected" : "unknown", errorCode, contentSha256 }));
    }
    if (!error.status) error.status = 502;
    throw error;
  }
});

app.post("/api/integrations/payroll-export/file", async (request, response) => {
  const actor = integrationActor(request, "payroll:export");
  const preflight = payrollPreflight(actor, request.body || {});
  if (request.body.fingerprint && request.body.fingerprint !== preflight.fingerprint) {
    throw httpError(409, "Die Daten haben sich seit der Vorpr\u00fcfung ge\u00e4ndert. Bitte erneut pr\u00fcfen.", "PAYROLL_PREFLIGHT_STALE");
  }
  const draft = request.body.allowDraft === true;
  if (preflight.blockers.length && !draft) {
    throw httpError(422, "Der finale Export ist wegen offener Pr\u00fcfpunkte noch gesperrt. Bitte die Hinweise beheben oder ausdr\u00fccklich einen Entwurf exportieren.", "PAYROLL_EXPORT_BLOCKED");
  }
  const delimiter = preflight.configuration.delimiter === "tab" ? "\t" : preflight.configuration.delimiter;
  const draftNotice = draft
    ? `ENTWURF – ${preflight.blockers.length} offene Prüfpunkte. Nicht für die endgültige Lohnverrechnung verwenden.`
    : "";
  const output = preflight.configuration.format === "xlsx"
    ? await createXlsxBuffer(preflight.columns, preflight.rows, {
      sheetName: preflight.configuration.layout === "movement_lines" ? "Lohnarten" : "Tagesjournal",
      notice: draftNotice,
    })
    : createCsvBuffer(preflight.columns, payrollRowsForCsv(preflight), { delimiter, notice: draftNotice });
  const contentSha256 = sha256(output);
  const runId = insertIntegrationRun({
    profileId: preflight.profileId,
    direction: "export",
    kind: "payroll",
    format: preflight.configuration.format,
    contentSha256,
    status: draft ? "draft" : "completed",
    totalCount: preflight.rowCount,
    errorCount: preflight.blockers.length,
    actor: actor.employeeNumber,
    options: {
      dateFrom: preflight.dateFrom,
      dateTo: preflight.dateTo,
      locationId: preflight.context.locationId,
      departmentId: preflight.context.departmentId || null,
      sourceMode: preflight.configuration.sourceMode,
      layout: preflight.configuration.layout,
      draft,
    },
    result: {
      warningCodes: [...new Set(preflight.warnings.map((warning) => warning.code))],
      blockerCodes: [...new Set(preflight.blockers.map((blocker) => blocker.code))],
    },
  });
  auditPortal(actor.employeeNumber, "integration.payroll.export", "integration_run", runId,
    JSON.stringify({ profileId: preflight.profileId, format: preflight.configuration.format, rows: preflight.rowCount, draft, contentSha256 }));
  response.setHeader("Content-Type", preflight.configuration.format === "xlsx"
    ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    : "text/csv; charset=utf-8");
  response.setHeader("Content-Disposition", contentDispositionHeader(payrollFileName(preflight, draft)));
  response.setHeader("X-Grabenplaner-Export-Status", draft ? "draft" : "final");
  response.setHeader("Content-Length", output.length);
  response.setHeader("X-Integration-Run-Id", runId);
  response.send(output);
});

app.get("/api/health/live", (_request, response) => response.json({ ok: true }));
app.get("/api/health/ready", (_request, response) => sendReadiness(response));
app.get("/api/health", (_request, response) => sendReadiness(response));

app.post("/api/service/stop", (request, response) => {
  if (!serverModeActive || !isLoopbackRequest(request) || serviceControlToken.length < 32) {
    throw httpError(404, "Der Dienststeuerungs-Endpunkt ist nicht verfügbar.", "SERVICE_CONTROL_UNAVAILABLE");
  }
  const provided = String(request.headers["x-grabenplaner-service-token"] || "");
  const valid = provided.length === serviceControlToken.length
    && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(serviceControlToken));
  if (!valid) {
    auditPortal("service", "service.stop.denied", "system", "server");
    throw httpError(403, "Die Dienststeuerung wurde abgelehnt.", "SERVICE_CONTROL_DENIED");
  }
  response.json({ ok: true, message: "Der Grabenplaner-Dienst wird kontrolliert beendet." });
  response.on("finish", () => setTimeout(() => shutdown({ reason: "windows-service" }), 150));
});

app.get("/api/server-diagnostics", (request, response) => {
  requirePortalAdminOrLocal(request, "settings:write");
  response.json(serverDiagnostics());
});

function runtimeDriveInfo() {
  const root = path.parse(__dirname).root;
  const match = root.match(/^([a-z]):\\/i);
  if (!match) return { root, drive: null, canEject: false };
  const drive = `${match[1].toUpperCase()}:`;
  return {
    root,
    drive,
    canEject: process.platform === "win32" && drive !== "C:",
  };
}

const GITHUB_REPO = "christianseiwaldat-collab/Grabenplaner";

function findGhExecutable() {
  const candidates = [
    "C:\\Program Files\\GitHub CLI\\gh.exe",
    path.join(os.homedir(), "AppData", "Local", "Programs", "GitHub CLI", "gh.exe"),
    ...(() => {
      try {
        return childProcess.execFileSync("where.exe", ["gh"], { encoding: "utf8", timeout: 3000 })
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter(Boolean);
      } catch {
        return [];
      }
    })(),
    "gh",
  ];
  return [...new Set(candidates)].find((candidate) => {
    try {
      childProcess.execFileSync(candidate, ["--version"], { stdio: "ignore", timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }) || null;
}

async function latestReleaseViaFetch() {
  configureSystemCertificateAuthorities();
  const headers = {
    "Accept": "application/vnd.github+json",
    "User-Agent": `${APP_NAME}/${packageMetadata.version}`,
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=20`, { headers });
  if (response.status === 404) throw new Error("GitHub release not found");
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  const release = selectLatestRelease(await response.json());
  if (!release) throw new Error("GitHub release not found");
  return {
    source: token ? "github-token" : "github-public",
    tagName: release.tag_name,
    name: release.name || "",
    url: release.html_url,
    assets: (release.assets || []).map((asset) => ({
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
      digest: asset.digest || "",
    })),
  };
}

function latestReleaseViaGh() {
  const gh = findGhExecutable();
  if (!gh) throw new Error("GitHub CLI nicht gefunden oder nicht angemeldet.");
  const listOutput = childProcess.execFileSync(
    gh,
    ["release", "list", "--repo", GITHUB_REPO, "--limit", "20", "--json", "tagName,isDraft,isPrerelease,createdAt,publishedAt"],
    { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] },
  );
  const selected = selectLatestRelease(JSON.parse(listOutput));
  if (!selected) throw new Error("release not found");
  const output = childProcess.execFileSync(
    gh,
    ["release", "view", selected.tagName, "--repo", GITHUB_REPO, "--json", "tagName,name,url,assets"],
    { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] },
  );
  const release = JSON.parse(output);
  return {
    source: "gh",
    tagName: release.tagName,
    name: release.name || "",
    url: release.url,
    assets: (release.assets || []).map((asset) => ({
      name: asset.name,
      url: asset.url,
      size: asset.size,
      digest: asset.digest || "",
    })),
  };
}

async function getLatestReleaseInfo() {
  const errors = [];
  try {
    return await latestReleaseViaFetch();
  } catch (error) {
    errors.push(error.message);
  }
  try {
    return latestReleaseViaGh();
  } catch (error) {
    errors.push(error.message);
  }
  if (errors.some((message) => /release not found|GitHub release not found|HTTP 404/i.test(message))) {
    return {
      source: "none",
      tagName: packageMetadata.version,
      name: "",
      url: `https://github.com/${GITHUB_REPO}/releases`,
      assets: [],
    };
  }
  const failure = new Error(`Update-Check nicht möglich: ${errors.join(" · ")}`);
  failure.status = 503;
  throw failure;
}

async function resolveUpdateStatus() {
  const latest = await getLatestReleaseInfo();
  const comparison = compareVersions(latest.tagName, packageMetadata.version);
  const asset = latest.assets.find((item) => /windows-portable\.zip$/i.test(item.name)) || null;
  const updateType = classifyRelease(latest);
  const status = {
    ok: true,
    currentVersion: packageMetadata.version,
    currentLabel: APP_VERSION_LABEL,
    latestVersion: normalizeVersionTag(latest.tagName),
    latestTag: latest.tagName,
    latestUrl: latest.url,
    source: latest.source,
    updateKind: updateType.kind,
    updateTypeLabel: updateType.label,
    updateAvailable: comparison > 0,
    assetName: asset?.name || "",
    assetSize: Number(asset?.size || 0),
    assetIntegrity: asset?.digest ? "sha256" : "https",
    canAutoUpdate: Boolean(asset) && !serverModeActive,
    managementNote: serverModeActive ? "Serverupdates werden kontrolliert am Server durchgeführt." : "",
  };
  return { status, asset };
}

async function buildUpdateStatus() {
  return (await resolveUpdateStatus()).status;
}

app.get("/api/system-info", (request, response) => {
  const settings = getSettings();
  const privileged = !getPortalStatus().portalEnabled || request.portalSession?.permissions?.includes("system:write");
  const sqliteVersion = db.prepare("SELECT sqlite_version() AS version").get().version;
  const serverTime = new Intl.DateTimeFormat("de-AT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Europe/Vienna",
  }).format(new Date());
  response.json({
    serverTime,
    timezone: "Europe/Vienna",
    nodeVersion: process.version,
    sqliteVersion,
    platform: `${os.type()} ${os.release()} · ${os.arch()}`,
    uptimeSeconds: Math.floor(process.uptime()),
    database: path.basename(databasePath),
    appBackupDirectory: privileged ? appBackupDirectory : "",
    backupDirectory: privileged ? backupDirectoryFromSettings(settings) : "",
    externalBackupEnabled: settingEnabled(settings, "external_backup_enabled"),
    backupIntervalHours: Number(settings.backup_interval_hours || 2),
    lastBackup: privileged ? lastBackup : null,
    adminContact: brandingFromSettings(settings).adminEmail,
    appName: brandingFromSettings(settings).appName,
    branding: brandingFromSettings(settings),
    appVersion: packageMetadata.version,
    appVersionLabel: APP_VERSION_LABEL,
    portal: getPortalStatus(),
    serverDiagnostics: privileged ? serverDiagnostics() : null,
    runtimeDrive: privileged ? runtimeDriveInfo() : null,
  });
});

app.get("/api/update-status", async (_request, response) => {
  response.json(await buildUpdateStatus());
});

app.post("/api/update-apply", async (_request, response) => {
  if (serverModeActive) throw httpError(409, "Im Serverbetrieb werden Updates kontrolliert am Server eingespielt.", "SERVER_MANAGED_UPDATE");
  if (fs.existsSync(path.join(__dirname, ".git"))) {
    throw httpError(409, "Ein Quellcode-Checkout wird nicht über den Portable-Updater überschrieben. Bitte die Aktualisierung mit Git durchführen.", "SOURCE_CHECKOUT_UPDATE_BLOCKED");
  }
  const { status, asset } = await resolveUpdateStatus();
  if (!status.updateAvailable) {
    response.json({ ok: true, message: "Grabenplaner ist bereits aktuell.", status });
    return;
  }
  if (!asset) throw httpError(503, "Für diese Version wurde kein Windows-Portable-ZIP veröffentlicht.", "UPDATE_ASSET_MISSING");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-update-"));
  const scriptPath = path.join(tempRoot, "apply-update.ps1");
  const launcherPath = path.join(tempRoot, "launch-update.cmd");
  let download;
  try {
    download = await downloadGitHubReleaseAsset({
      asset,
      destinationDirectory: path.join(tempRoot, "download"),
      userAgent: `${APP_NAME}/${packageMetadata.version}`,
    });
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    throw httpError(502, `Das Update konnte nicht sicher von GitHub geladen werden: ${error.message}`, error.code || "UPDATE_DOWNLOAD_FAILED");
  }
  const safeAppDir = __dirname.replaceAll("'", "''");
  const safeParentDir = path.dirname(__dirname).replaceAll("'", "''");
  const safeTag = status.latestTag.replaceAll("'", "''");
  const safeZipPath = download.filePath.replaceAll("'", "''");
  const safeExpectedSha256 = download.sha256.replaceAll("'", "''");
  const safeVersionLabel = formatVersionLabel(status.latestVersion).replaceAll("'", "''");
  const script = `
$ErrorActionPreference = 'Stop'
$appDir = '${safeAppDir}'
$parentDir = '${safeParentDir}'
$workDir = '${tempRoot.replaceAll("'", "''")}'
$tag = '${safeTag}'
$zipPath = '${safeZipPath}'
$expectedSha256 = '${safeExpectedSha256}'
$expectedByteSize = ${download.byteSize}
$versionLabel = '${safeVersionLabel}'
$pidToWait = ${process.pid}
$logPath = Join-Path $appDir 'data\\update-last.log'
function Write-UpdateLog([string]$message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}
try {
  New-Item -ItemType Directory -Path (Split-Path -Parent $logPath) -Force | Out-Null
  Set-Content -LiteralPath $logPath -Value ("[{0}] Updater gestartet: {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $versionLabel) -Encoding UTF8
  Write-UpdateLog "App-Verzeichnis: $appDir"
  Write-UpdateLog "Release-ZIP wurde direkt über GitHub HTTPS geladen: $tag"
  Write-UpdateLog "Warte auf Server-Prozess $pidToWait ..."
  $deadline = (Get-Date).AddMinutes(2)
  while (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue) {
    if ((Get-Date) -gt $deadline) { throw "Server-Prozess $pidToWait wurde nicht rechtzeitig beendet." }
    Start-Sleep -Milliseconds 300
  }
  Start-Sleep -Milliseconds 800
$extractDir = Join-Path $workDir 'extract'
New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
if (-not (Test-Path -LiteralPath $zipPath)) { throw 'Das sicher geladene Release-ZIP wurde nicht gefunden.' }
$zip = Get-Item -LiteralPath $zipPath
if ($zip.Length -ne $expectedByteSize) { throw 'Die Größe des Release-ZIPs hat sich vor der Installation verändert.' }
$actualSha256 = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSha256 -ne $expectedSha256) { throw 'Die SHA-256-Prüfsumme des Release-ZIPs hat sich vor der Installation verändert.' }
Write-UpdateLog "Release-ZIP geprüft: $($zip.Name), $expectedByteSize Bytes, SHA-256 $expectedSha256"
Write-UpdateLog "Entpacke $($zip.Name) ..."
Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force
$source = Join-Path $extractDir 'Grabenplaner'
if (-not (Test-Path (Join-Path $source 'server.js'))) { throw 'Entpackte Version ist unvollständig.' }
Write-UpdateLog "Kopiere neue App-Dateien ..."
  Get-ChildItem -LiteralPath $appDir -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { try { $_.IsReadOnly = $false } catch {} }
  $robocopyOutput = & robocopy $source $appDir /MIR /XD '.git' 'data' 'backups' 'release' 'usb-backups' /XF '*.db' '*.db-shm' '*.db-wal' '*.log' 'portable-layout.json' /NFL /NDL /NJH /NJS /NP 2>&1
$robocopyExitCode = $LASTEXITCODE
$robocopyOutput | ForEach-Object { Write-UpdateLog "robocopy: $_" }
if ($robocopyExitCode -gt 7) { throw "Robocopy fehlgeschlagen: $robocopyExitCode" }
if ((Split-Path $appDir -Leaf) -eq 'app') {
  Get-ChildItem -LiteralPath $parentDir -Filter 'Grabenplaner v* Beta starten.cmd' -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $parentDir 'Dienstplan starten.cmd') -Force -ErrorAction SilentlyContinue
  "@echo off\`r\`ncd /d ""%~dp0app""\`r\`ncall ""Dienstplan starten.cmd""\`r\`n" | Set-Content -LiteralPath (Join-Path $parentDir 'Grabenplaner starten.cmd') -Encoding Default
  "@echo off\`r\`ncd /d ""%~dp0app""\`r\`ncall ""Backup erstellen.cmd""\`r\`n" | Set-Content -LiteralPath (Join-Path $parentDir 'Backup erstellen.cmd') -Encoding Default
  $portableLayout = Join-Path $appDir 'portable-layout.json'
  if (Test-Path -LiteralPath $portableLayout) {
    try {
      $layout = Get-Content -LiteralPath $portableLayout -Raw | ConvertFrom-Json
      if ($layout.protectProgramFiles) {
        Get-ChildItem -LiteralPath $appDir -Force -File -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -ne 'portable-layout.json' } |
          ForEach-Object { try { $_.IsReadOnly = $true } catch {} }
        foreach ($name in @('lib','node_modules','public','runtime','scripts','docs')) {
          $protectedRoot = Join-Path $appDir $name
          if (Test-Path -LiteralPath $protectedRoot) { Get-ChildItem -LiteralPath $protectedRoot -Recurse -Force -File | ForEach-Object { $_.IsReadOnly = $true } }
        }
      }
      if ($layout.hideProgramFolder) { & attrib.exe +H +S $appDir }
    } catch { Write-UpdateLog "Portabler Versehschutz konnte nicht vollständig wiederhergestellt werden: $($_.Exception.Message)" }
  }
}
$startFile = Join-Path $appDir "Grabenplaner $versionLabel starten.cmd"
if (-not (Test-Path $startFile)) { $startFile = Join-Path $appDir 'Dienstplan starten.cmd' }
Write-UpdateLog "Starte neu: $startFile"
Start-Process -FilePath $startFile -WorkingDirectory $appDir
Start-Sleep -Seconds 3
Write-UpdateLog "Update erfolgreich abgeschlossen."
Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
} catch {
  try {
    Write-UpdateLog ("FEHLER: " + $_.Exception.Message)
    Write-UpdateLog ("Details: " + $_.ScriptStackTrace)
  } catch {}
  exit 1
}
`;
  fs.writeFileSync(scriptPath, script, "utf8");
  fs.writeFileSync(
    launcherPath,
    `@echo off\r\nstart "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"\r\n`,
    "utf8",
  );
  response.json({
    ok: true,
    message: "Update wurde sicher über GitHub HTTPS geladen und wird installiert. Grabenplaner startet danach automatisch neu. Alle Datenbanken und Backups bleiben erhalten.",
    logPath: path.join(__dirname, "data", "update-last.log"),
    status,
  });
  setTimeout(() => {
    childProcess.spawn("cmd.exe", ["/d", "/c", launcherPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    setTimeout(shutdown, 1500);
  }, 100);
});

app.post("/api/backup", (_request, response) => {
  response.status(201).json(createDatabaseBackup("manual"));
});

function scheduleApplicationRestart() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-restart-"));
  const scriptPath = path.join(tempRoot, "restart-grabenplaner.ps1");
  const launcherPath = path.join(tempRoot, "launch-restart.cmd");
  const safeAppDir = __dirname.replaceAll("'", "''");
  const safeVersionLabel = APP_VERSION_LABEL.replaceAll("'", "''");
  const script = `
$ErrorActionPreference = 'Stop'
$appDir = '${safeAppDir}'
$versionLabel = '${safeVersionLabel}'
$pidToWait = ${process.pid}
$deadline = (Get-Date).AddMinutes(2)
while (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue) {
  if ((Get-Date) -gt $deadline) { throw "Server-Prozess $pidToWait wurde nicht rechtzeitig beendet." }
  Start-Sleep -Milliseconds 300
}
Start-Sleep -Milliseconds 600
$startFile = Join-Path $appDir "Grabenplaner $versionLabel starten.cmd"
if (-not (Test-Path $startFile)) { $startFile = Join-Path $appDir 'Dienstplan starten.cmd' }
Start-Process -FilePath $startFile -WorkingDirectory $appDir
Start-Sleep -Seconds 2
Remove-Item -LiteralPath '${tempRoot.replaceAll("'", "''")}' -Recurse -Force -ErrorAction SilentlyContinue
`;
  fs.writeFileSync(scriptPath, script, "utf8");
  fs.writeFileSync(launcherPath, `@echo off\r\nstart "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"\r\n`, "utf8");
  childProcess.spawn("cmd.exe", ["/d", "/c", launcherPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
  setTimeout(shutdown, 900);
}

app.post("/api/system/restart", (_request, response) => {
  if (serverModeActive) throw httpError(409, "Der Serverbetrieb wird über den Serverdienst neu gestartet.", "SERVER_MANAGED_RESTART");
  const backup = createDatabaseBackup("restart");
  response.json({ ok: true, message: "Grabenplaner wird sicher neu gestartet.", backup });
  response.on("finish", () => setTimeout(scheduleApplicationRestart, 250));
});

app.post("/api/system/exit", (request, response) => {
  if (serverModeActive) {
    const session = requirePortalSession(request, "system:write");
    if (!["developer", "it_admin", "admin"].includes(session.role)) {
      throw httpError(403, "Nur Developer, IT-Administration oder Administration dürfen den Server beenden.", "SERVER_SHUTDOWN_ROLE_DENIED");
    }
  }
  const driveInfo = runtimeDriveInfo();
  let backup = null;
  try {
    backup = createDatabaseBackup("shutdown");
  } catch (error) {
    console.error("Backup beim Beenden konnte nicht erstellt werden:", error);
  }
  response.json({
    ok: true,
    message: serverModeActive
      ? "Der Grabenplaner-Server wird sicher beendet."
      : "Grabenplaner wird sicher beendet. Bitte dieses Fenster danach schließen.",
    backup,
    drive: driveInfo.drive,
  });
  response.on("finish", () => setTimeout(() => shutdown({ reason: "api", skipBackup: true }), 350));
});

function scheduleBackupImport(importPath) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-db-import-"));
  const scriptPath = path.join(tempRoot, "apply-db-import.ps1");
  const launcherPath = path.join(tempRoot, "launch-db-import.cmd");
  const safeAppDir = __dirname.replaceAll("'", "''");
  const safeDatabasePath = databasePath.replaceAll("'", "''");
  const safeImportPath = importPath.replaceAll("'", "''");
  const safeTempRoot = tempRoot.replaceAll("'", "''");
  const safeVersionLabel = APP_VERSION_LABEL.replaceAll("'", "''");
  const script = `
$ErrorActionPreference = 'Stop'
$appDir = '${safeAppDir}'
$databasePath = '${safeDatabasePath}'
$importPath = '${safeImportPath}'
$workDir = '${safeTempRoot}'
$versionLabel = '${safeVersionLabel}'
$pidToWait = ${process.pid}
$logPath = Join-Path $appDir 'data\\import-last.log'
function Write-ImportLog([string]$message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}
try {
  New-Item -ItemType Directory -Path (Split-Path -Parent $logPath) -Force | Out-Null
  Set-Content -LiteralPath $logPath -Value ("[{0}] Datenbank-Import gestartet" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding UTF8
  Write-ImportLog "App-Verzeichnis: $appDir"
  Write-ImportLog "Warte auf Server-Prozess $pidToWait ..."
  $deadline = (Get-Date).AddMinutes(2)
  while (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue) {
    if ((Get-Date) -gt $deadline) { throw "Server-Prozess $pidToWait wurde nicht rechtzeitig beendet." }
    Start-Sleep -Milliseconds 300
  }
  Start-Sleep -Milliseconds 800
  Remove-Item -LiteralPath "$databasePath-wal" -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath "$databasePath-shm" -Force -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath $importPath -Destination $databasePath -Force
  Remove-Item -LiteralPath $importPath -Force -ErrorAction SilentlyContinue
  $runtimeConfigPath = Join-Path $appDir 'data\runtime-config.json'
  '{"operationMode":"local"}' | Set-Content -LiteralPath $runtimeConfigPath -Encoding UTF8
  Write-ImportLog "Datenbank ersetzt."
  Write-ImportLog "Betriebsmodus aus Sicherheitsgründen auf Lokalbetrieb zurückgesetzt."
  $startFile = Join-Path $appDir "Grabenplaner $versionLabel starten.cmd"
  if (-not (Test-Path $startFile)) { $startFile = Join-Path $appDir 'Dienstplan starten.cmd' }
  Write-ImportLog "Starte neu: $startFile"
  Start-Process -FilePath $startFile -WorkingDirectory $appDir
  Start-Sleep -Seconds 3
  Write-ImportLog "Datenbank-Import erfolgreich abgeschlossen."
  Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
} catch {
  try {
    Write-ImportLog ("FEHLER: " + $_.Exception.Message)
    Write-ImportLog ("Details: " + $_.ScriptStackTrace)
  } catch {}
  exit 1
}
`;
  fs.writeFileSync(scriptPath, script, "utf8");
  fs.writeFileSync(
    launcherPath,
    `@echo off\r\nstart "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"\r\n`,
    "utf8",
  );
  setTimeout(() => {
    childProcess.spawn("cmd.exe", ["/d", "/c", launcherPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    setTimeout(shutdown, 900);
  }, 450);
}

const brandingPreserveSettingKeys = [
  "branding_management_kit_id",
  "branding_company_name",
  "branding_logo_url",
  "branding_icon_url",
  "branding_logo_alt",
  "branding_admin_email",
  "pdf_title",
  "pdf_filename_prefix",
  "pdf_filename_include_kw",
  "pdf_filename_include_timestamp",
  "vacation_pdf_title",
  "vacation_pdf_filename_prefix",
  "vacation_pdf_filename_include_period",
  "vacation_pdf_filename_include_timestamp",
  "vacation_pdf_show_balance",
  "vacation_pdf_balance_show_entitlement",
  "vacation_pdf_balance_show_planned",
  "vacation_pdf_balance_show_consumed",
  "vacation_pdf_calendar_style",
];

function currentBrandingSnapshot() {
  const placeholders = brandingPreserveSettingKeys.map(() => "?").join(",");
  return {
    settings: db.prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`).all(...brandingPreserveSettingKeys),
    pdfSettings: tableExists("pdf_settings")
      ? db.prepare(`
          SELECT scope_type, location_id, department_key, key, value
          FROM pdf_settings
          WHERE key IN (${placeholders})
        `).all(...brandingPreserveSettingKeys)
      : [],
    locationBranding: tableExists("location_branding")
      ? db.prepare(`
          SELECT location_id, kit_id, company_name, logo_url, icon_url, logo_alt, admin_email, updated_by
          FROM location_branding ORDER BY location_id
        `).all()
      : [],
  };
}

function applyBrandingSnapshotToDatabase(importPath, snapshot) {
  const imported = new DatabaseSync(importPath);
  try {
    imported.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pdf_settings (
        scope_type TEXT NOT NULL,
        location_id TEXT NOT NULL,
        department_key TEXT NOT NULL DEFAULT '',
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (scope_type, location_id, department_key, key)
      );
      CREATE TABLE IF NOT EXISTS location_branding (
        location_id TEXT PRIMARY KEY,
        kit_id TEXT NOT NULL DEFAULT 'custom',
        company_name TEXT NOT NULL DEFAULT '',
        logo_url TEXT NOT NULL DEFAULT '/assets/grabenplaner-logo.svg',
        icon_url TEXT NOT NULL DEFAULT '/assets/webicon.svg',
        logo_alt TEXT NOT NULL DEFAULT 'Grabenplaner',
        admin_email TEXT NOT NULL DEFAULT '',
        updated_by TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (location_id) REFERENCES locations(id)
          ON UPDATE CASCADE ON DELETE CASCADE
      );
    `);
    const updateSetting = imported.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    const updatePdfSetting = imported.prepare(`
      INSERT INTO pdf_settings (scope_type, location_id, department_key, key, value, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(scope_type, location_id, department_key, key)
      DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `);
    const updateLocationBranding = imported.prepare(`
      INSERT INTO location_branding
        (location_id, kit_id, company_name, logo_url, icon_url, logo_alt, admin_email, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(location_id) DO UPDATE SET
        kit_id = excluded.kit_id,
        company_name = excluded.company_name,
        logo_url = excluded.logo_url,
        icon_url = excluded.icon_url,
        logo_alt = excluded.logo_alt,
        admin_email = excluded.admin_email,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `);
    imported.exec("BEGIN");
    try {
      for (const row of snapshot.settings || []) updateSetting.run(row.key, row.value);
      for (const row of snapshot.pdfSettings || []) {
        updatePdfSetting.run(row.scope_type, row.location_id, row.department_key || "", row.key, row.value);
      }
      imported.prepare("DELETE FROM location_branding").run();
      const importedLocationExists = imported.prepare("SELECT 1 FROM locations WHERE id = ?");
      for (const row of snapshot.locationBranding || []) {
        if (!importedLocationExists.get(row.location_id)) continue;
        updateLocationBranding.run(
          row.location_id, row.kit_id, row.company_name, row.logo_url, row.icon_url,
          row.logo_alt, row.admin_email, row.updated_by || "",
        );
      }
      imported.exec("COMMIT");
    } catch (error) {
      imported.exec("ROLLBACK");
      throw error;
    }
  } finally {
    imported.close();
  }
}

function importedDatabaseHasColumn(importedDatabase, tableName, columnName) {
  return importedDatabase.prepare(`PRAGMA table_info(${tableName})`).all()
    .some((column) => column.name === columnName);
}

function verifyImportedProtectedPersonnelPayloads(importedDatabase) {
  const storage = requireAmuStorage();
  let verified = 0;
  if (importedDatabaseHasColumn(importedDatabase, "amu_reports", "protected_payload")) {
    const reports = importedDatabase.prepare(`
      SELECT id, employee_lookup, protected_payload
      FROM amu_reports
      WHERE protected_payload <> ''
      ORDER BY id
    `).all();
    for (const report of reports) {
      const payload = storage.unprotectRecord(report.protected_payload, amuReportProtectionContext(report), { allowLegacy: true });
      const parsed = JSON.parse(payload);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid protected report payload");
      verified += 1;
    }
  }
  if (importedDatabaseHasColumn(importedDatabase, "sickness_alerts", "protected_payload")) {
    const alerts = importedDatabase.prepare("SELECT id, sickness_case_id, protected_payload FROM sickness_alerts ORDER BY id").all();
    for (const alert of alerts) {
      if (!alert.protected_payload) throw new Error("missing protected sickness alert payload");
      const payload = storage.unprotectRecord(alert.protected_payload, sicknessAlertProtectionContext(alert), { allowLegacy: true });
      const parsed = JSON.parse(payload);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid protected sickness alert payload");
      verified += 1;
    }
  }
  if (importedDatabaseHasColumn(importedDatabase, "amu_reports", "employee_note")
    && importedDatabaseHasColumn(importedDatabase, "amu_reports", "review_note")) {
    const legacyReports = importedDatabase.prepare(`
      SELECT employee_note, review_note
      FROM amu_reports
      WHERE employee_note LIKE 'enc:v1:%' OR review_note LIKE 'enc:v1:%'
    `).all();
    for (const report of legacyReports) {
      for (const value of [report.employee_note, report.review_note]) {
        if (!String(value || "").startsWith("enc:v1:")) continue;
        storage.unprotectText(value);
        verified += 1;
      }
    }
  }
  if (importedDatabaseHasColumn(importedDatabase, "amu_documents", "protected_payload")) {
    const documents = importedDatabase.prepare(`
      SELECT d.id, d.protected_payload, r.employee_number
      FROM amu_documents d
      JOIN amu_reports r ON r.id = d.report_id
      WHERE d.protected_payload <> ''
      ORDER BY d.id
    `).all();
    for (const document of documents) {
      const payload = storage.unprotectRecord(document.protected_payload, amuDocumentProtectionContext(document), { allowLegacy: true });
      const parsed = JSON.parse(payload);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid protected document payload");
      verified += 1;
    }
  }
  if (importedDatabaseHasColumn(importedDatabase, "amu_documents", "original_filename")) {
    const legacyDocuments = importedDatabase.prepare(`
      SELECT original_filename
      FROM amu_documents
      WHERE original_filename LIKE 'enc:v1:%'
    `).all();
    for (const document of legacyDocuments) {
      storage.unprotectText(document.original_filename);
      verified += 1;
    }
  }
  if (importedDatabaseHasColumn(importedDatabase, "sickness_cases", "protected_payload")) {
    const cases = importedDatabase.prepare(`
      SELECT id, employee_number, protected_payload
      FROM sickness_cases
      ORDER BY id
    `).all();
    for (const sicknessCase of cases) {
      if (!sicknessCase.protected_payload) throw new Error("missing protected sickness case payload");
      const payload = storage.unprotectRecord(
        sicknessCase.protected_payload,
        sicknessCaseProtectionContext(sicknessCase),
        { allowLegacy: true },
      );
      const parsed = JSON.parse(payload);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid protected sickness case payload");
      verified += 1;
    }
  }
  if (importedDatabaseHasColumn(importedDatabase, "sickness_notification_preferences", "protected_destination")) {
    const preferences = importedDatabase.prepare(`
      SELECT employee_number, channel, protected_destination
      FROM sickness_notification_preferences
      WHERE protected_destination <> ''
      ORDER BY employee_number, channel
    `).all();
    for (const preference of preferences) {
      const payload = storage.unprotectRecord(
        preference.protected_destination,
        sicknessPreferenceProtectionContext(preference),
        { allowLegacy: true },
      );
      const parsed = JSON.parse(payload);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid protected notification destination");
      verified += 1;
    }
  }
  if (importedDatabaseHasColumn(importedDatabase, "outbound_notification_jobs", "protected_payload")) {
    const jobs = importedDatabase.prepare(`
      SELECT id, recipient_lookup, protected_payload
      FROM outbound_notification_jobs
      ORDER BY created_at, id
    `).all();
    for (const job of jobs) {
      if (!job.protected_payload) throw new Error("missing protected outbound notification payload");
      const payload = storage.unprotectRecord(
        job.protected_payload,
        outboundNotificationProtectionContext(job),
        { allowLegacy: true },
      );
      const parsed = JSON.parse(payload);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid protected outbound notification payload");
      verified += 1;
    }
  }
  return verified;
}

async function verifyImportedIntegrationCredentials(importedDatabase) {
  if (!importedDatabase.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'integration_connections'").get()
    || !importedDatabaseHasColumn(importedDatabase, "integration_connections", "protected_credentials")) return 0;
  const connections = importedDatabase.prepare(`
    SELECT id, kind, protected_credentials
    FROM integration_connections
    WHERE protected_credentials <> ''
    ORDER BY id
  `).all();
  if (!connections.length) return 0;
  const vault = requireIntegrationSecretVault();
  for (const connection of connections) {
    await vault.useSecret(connection.protected_credentials, integrationCredentialContext(connection), async (buffer) => {
      const parsed = JSON.parse(buffer.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid protected integration credential");
    });
  }
  return connections.length;
}

app.post("/api/backup/import", express.raw({ type: "application/octet-stream", limit: "200mb" }), async (request, response) => {
  if (getPortalStatus().portalEnabled && !["developer", "it_admin"].includes(request.portalSession?.role)) {
    throw httpError(403, "Datenbankimporte dürfen im geschützten Betrieb nur durch Developer oder IT-Admin ausgeführt werden.", "BACKUP_IMPORT_ROLE_DENIED");
  }
  const currentAmuDocuments = tableExists("amu_documents")
    ? Number(db.prepare("SELECT COUNT(*) AS count FROM amu_documents WHERE status <> 'purged'").get().count || 0)
    : 0;
  if (currentAmuDocuments > 0) {
    throw httpError(409, "Diese Datenbank enthält geschützte AUM-Dokumente. Bitte Datenbank und AUM-Dateisicherung gemeinsam über die Wartungswerkzeuge wiederherstellen.", "AMU_FULL_RESTORE_REQUIRED");
  }
  if (serverModeActive) throw httpError(409, "Datenbankimporte sind im laufenden Serverbetrieb gesperrt und müssen in einem Wartungsfenster am Server durchgeführt werden.", "SERVER_MAINTENANCE_REQUIRED");
  if (!Buffer.isBuffer(request.body) || request.body.length < 1024) {
    throw httpError(400, "Bitte eine gültige Backup-Datei auswählen.");
  }
  fs.mkdirSync(dataDirectory, { recursive: true });
  const importPath = path.join(dataDirectory, `pending-import-${backupTimestamp()}.db`);
  fs.writeFileSync(importPath, request.body);
  let importedDatabase;
  let importedAmuDocuments = 0;
  let importedProtectedPayloadError = false;
  let importedIntegrationCredentialError = false;
  try {
    importedDatabase = new DatabaseSync(importPath, { readOnly: true });
    importedDatabase.prepare("SELECT name FROM sqlite_master LIMIT 1").all();
    const hasAmuDocuments = importedDatabase.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'amu_documents'").get();
    if (hasAmuDocuments) importedAmuDocuments = Number(importedDatabase.prepare("SELECT COUNT(*) AS count FROM amu_documents WHERE status <> 'purged'").get().count || 0);
    if (!importedAmuDocuments) {
      try { verifyImportedProtectedPersonnelPayloads(importedDatabase); }
      catch { importedProtectedPayloadError = true; }
    }
    try { await verifyImportedIntegrationCredentials(importedDatabase); }
    catch { importedIntegrationCredentialError = true; }
  } catch {
    fs.rmSync(importPath, { force: true });
    throw httpError(400, "Die ausgewählte Datei ist keine lesbare SQLite-Backup-Datei.");
  } finally {
    if (importedDatabase) importedDatabase.close();
  }
  if (importedProtectedPayloadError) {
    fs.rmSync(importPath, { force: true });
    throw httpError(409, "Die geschützten Personalakt-Daten dieses Backups gehören zu einem anderen Schlüsselsatz. Bitte die vollständige Datenbank- und AUM-Sicherung gemeinsam wiederherstellen.", "AMU_FULL_RESTORE_REQUIRED");
  }
  if (importedIntegrationCredentialError) {
    fs.rmSync(importPath, { force: true });
    throw httpError(409, "Die geschützten Zugangsdaten direkter Verbindungen gehören zu einem anderen Schlüsselsatz. Bitte die vollständige Serversicherung mit dem zugehörigen Integrationsschlüssel wiederherstellen oder die Verbindungen im Quellsystem entfernen.", "INTEGRATION_FULL_RESTORE_REQUIRED");
  }
  if (importedAmuDocuments > 0) {
    fs.rmSync(importPath, { force: true });
    throw httpError(409, "Das ausgewählte Backup enthält geschützte AUM-Dokumente. Bitte die vollständige Datenbank- und AUM-Sicherung gemeinsam wiederherstellen.", "AMU_FULL_RESTORE_REQUIRED");
  }
  const preserveBranding = String(request.query.preserveBranding ?? "1") !== "0";
  if (preserveBranding) {
    applyBrandingSnapshotToDatabase(importPath, currentBrandingSnapshot());
  }
  const safetyBackup = createDatabaseBackup("before-import");
  response.status(202).json({
    ok: true,
    message: preserveBranding
      ? "Backup wurde übernommen, aktuelles Branding bleibt erhalten. Grabenplaner wird sicher neu gestartet."
      : "Backup wurde vollständig übernommen. Grabenplaner wird sicher neu gestartet.",
    safetyBackup,
    preserveBranding,
  });
  scheduleBackupImport(importPath);
});

app.get("/api/schedule", (request, response) => {
  response.json(getSchedule(request.query.week, request.query, request.portalSession));
});

app.put("/api/schedule-note", (request, response) => {
  const note = validateScheduleNote(request.body);
  assertSessionContextScope(request.portalSession, note.context);
  db.prepare(`
    INSERT INTO schedule_notes
      (location_id, department_key, week_start, note_text, note_html, font_size, bold, italic, underline, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(location_id, department_key, week_start)
    DO UPDATE SET
      note_text = excluded.note_text,
      note_html = excluded.note_html,
      font_size = excluded.font_size,
      bold = excluded.bold,
      italic = excluded.italic,
      underline = excluded.underline,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    note.context.locationId,
    pdfDepartmentKey(note.context),
    note.weekStart,
    note.noteText,
    note.noteHtml,
    note.fontSize,
    note.bold,
    note.italic,
    note.underline,
  );
  response.json({ scheduleNote: getScheduleNote(note.weekStart, note.context) });
});

app.delete("/api/schedule-note", (request, response) => {
  const weekStart = getMonday(isIsoDate(request.query.week) ? request.query.week : undefined);
  const context = resolvePlanningContext(request.query);
  assertSessionContextScope(request.portalSession, context);
  assertWeekEditable(weekStart, settingsForLocation(context.locationId));
  db.prepare("DELETE FROM schedule_notes WHERE location_id = ? AND department_key = ? AND week_start = ?")
    .run(context.locationId, pdfDepartmentKey(context), weekStart);
  response.status(204).end();
});

app.get("/api/locations", (request, response) => {
  response.json(getLocationsForSession(request.portalSession, true));
});

app.post("/api/locations", (request, response) => {
  const location = validateLocationPayload(request.body, true);
  if (location.timeTrackingEnabled || location.timeTrackingAccessMode !== "anywhere"
    || location.timeTrackingAllowedNetworks || location.timeTrackingVarianceMinutes !== 15) {
    assertRequestPermission(request, "time:settings");
  }
  try {
    db.prepare(`
      INSERT INTO locations
        (id, name, min_staff, day_settings_json, time_tracking_enabled, time_tracking_access_mode,
         time_tracking_allowed_networks, time_tracking_variance_minutes, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(location.id, location.name, location.minStaff, JSON.stringify(location.daySettings), location.timeTrackingEnabled,
      location.timeTrackingAccessMode, location.timeTrackingAllowedNetworks, location.timeTrackingVarianceMinutes, location.active);
    if (!sessionHasGlobalScope(request.portalSession)) {
      db.prepare(`
        INSERT OR IGNORE INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
        VALUES (?, ?, 0, ?)
      `).run(request.portalSession.employeeNumber, location.id, request.portalSession.employeeNumber);
      request.portalSession.scopes = [...(request.portalSession.scopes || []), { locationId: location.id, departmentId: null }];
    }
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) throw httpError(409, "Diese Filial-ID ist bereits vergeben.");
    throw error;
  }
  response.status(201).json(getLocationsForSession(request.portalSession, true));
});

app.put("/api/locations/:id", (request, response) => {
  const id = normalizeLocationId(request.params.id);
  assertSessionLocationAdministrationScope(request.portalSession, id);
  const current = validateLocationExists(id);
  const location = validateLocationPayload({
    timeTrackingEnabled: Boolean(current.time_tracking_enabled),
    timeTrackingAccessMode: current.time_tracking_access_mode || "anywhere",
    timeTrackingAllowedNetworks: current.time_tracking_allowed_networks || "",
    timeTrackingVarianceMinutes: Number(current.time_tracking_variance_minutes ?? 15),
    ...request.body,
    id,
  }, false);
  const timeSettingsChanged = Number(current.time_tracking_enabled || 0) !== location.timeTrackingEnabled
    || String(current.time_tracking_access_mode || "anywhere") !== location.timeTrackingAccessMode
    || String(current.time_tracking_allowed_networks || "") !== location.timeTrackingAllowedNetworks
    || Number(current.time_tracking_variance_minutes ?? 15) !== location.timeTrackingVarianceMinutes;
  if (timeSettingsChanged) assertRequestPermission(request, "time:settings");
  const result = db.prepare(`
    UPDATE locations
    SET name = ?, min_staff = ?, day_settings_json = ?, time_tracking_enabled = ?,
        time_tracking_access_mode = ?, time_tracking_allowed_networks = ?, time_tracking_variance_minutes = ?, active = ?
    WHERE id = ?
  `).run(location.name, location.minStaff, JSON.stringify(location.daySettings), location.timeTrackingEnabled,
    location.timeTrackingAccessMode, location.timeTrackingAllowedNetworks, location.timeTrackingVarianceMinutes, location.active, id);
  if (!result.changes) throw httpError(404, "Die Filiale wurde nicht gefunden.");
  response.json(getLocationsForSession(request.portalSession, true));
});

app.post("/api/departments", (request, response) => {
  const department = validateDepartmentPayload(request.body);
  const departmentManagerCreatingInAssignedLocation = request.portalSession?.role === "department_manager"
    && (request.portalSession.scopes || []).some((scope) => scope.locationId === department.locationId);
  if (!departmentManagerCreatingInAssignedLocation) {
    assertSessionContextScope(request.portalSession, { locationId: department.locationId });
  }
  try {
    const sortOrder = db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM departments WHERE location_id = ?")
      .get(department.locationId).next;
    const result = db.prepare("INSERT INTO departments (location_id, name, min_staff, active, sort_order) VALUES (?, ?, ?, ?, ?)")
      .run(department.locationId, department.name, department.minStaff, department.active, sortOrder);
    if (departmentManagerCreatingInAssignedLocation) {
      db.prepare(`
        INSERT OR IGNORE INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
        VALUES (?, ?, ?, ?)
      `).run(request.portalSession.employeeNumber, department.locationId, Number(result.lastInsertRowid), request.portalSession.employeeNumber);
      request.portalSession.scopes = [...(request.portalSession.scopes || []), {
        locationId: department.locationId,
        departmentId: Number(result.lastInsertRowid),
      }];
    }
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) throw httpError(409, "Diese Abteilung gibt es in der Filiale bereits.");
    throw error;
  }
  response.status(201).json(getLocationsForSession(request.portalSession, true));
});

app.put("/api/departments/:id", (request, response) => {
  const id = normalizeDepartmentId(request.params.id, false);
  const existing = validateDepartmentExists(id);
  assertSessionContextScope(request.portalSession, { locationId: existing.location_id, departmentId: id });
  const department = validateDepartmentPayload(request.body, id);
  assertSessionContextScope(request.portalSession, { locationId: department.locationId, departmentId: id });
  try {
    const result = db.prepare("UPDATE departments SET location_id = ?, name = ?, min_staff = ?, active = ? WHERE id = ?")
      .run(department.locationId, department.name, department.minStaff, department.active, id);
    if (!result.changes) throw httpError(404, "Die Abteilung wurde nicht gefunden.");
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) throw httpError(409, "Diese Abteilung gibt es in der Filiale bereits.");
    throw error;
  }
  response.json(getLocationsForSession(request.portalSession, true));
});

function positionSlug(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function validatePositionPayload(body, existingId = null) {
  const name = String(body.name || "").trim();
  if (!name) throw httpError(400, "Bitte eine Position eingeben.");
  if (name.length > 60) throw httpError(400, "Die Position darf maximal 60 Zeichen lang sein.");
  const id = existingId || positionSlug(name);
  if (!id) throw httpError(400, "Die Position braucht einen gültigen Namen.");
  return { id, name };
}

app.get("/api/positions", (_request, response) => {
  response.json(getPositions());
});

app.post("/api/positions", (request, response) => {
  const position = validatePositionPayload(request.body);
  try {
    const sortOrder = db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM positions").get().next;
    db.prepare("INSERT INTO positions (id, name, builtin, sort_order) VALUES (?, ?, 0, ?)")
      .run(position.id, position.name, sortOrder);
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) throw httpError(409, "Diese Position gibt es bereits.");
    throw error;
  }
  response.status(201).json(getPositions());
});

app.put("/api/positions/:id", (request, response) => {
  const id = String(request.params.id || "").trim();
  const existing = db.prepare("SELECT id, builtin FROM positions WHERE id = ?").get(id);
  if (!existing) throw httpError(404, "Die Position wurde nicht gefunden.");
  if (existing.builtin) throw httpError(403, "Diese Standardposition kann nicht bearbeitet werden.");
  const position = validatePositionPayload(request.body, id);
  try {
    db.prepare("UPDATE positions SET name = ? WHERE id = ?").run(position.name, id);
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) throw httpError(409, "Diese Position gibt es bereits.");
    throw error;
  }
  response.json(getPositions());
});

app.delete("/api/positions/:id", (request, response) => {
  const id = String(request.params.id || "").trim();
  const existing = db.prepare("SELECT id, builtin FROM positions WHERE id = ?").get(id);
  if (!existing) throw httpError(404, "Die Position wurde nicht gefunden.");
  if (existing.builtin) throw httpError(403, "Diese Standardposition kann nicht gelöscht werden.");
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE employees SET position_id = 'verkaufsmitarbeiter' WHERE position_id = ?").run(id);
    db.prepare("DELETE FROM positions WHERE id = ?").run(id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  response.status(204).end();
});

app.get("/api/employees", (request, response) => {
  const session = request.portalSession;
  let employees = db
      .prepare(`
        SELECT e.personnel_number, e.full_name, e.nickname, e.color, e.contracted_hours,
               e.preferred_day_off, e.fixed_workdays, e.position_id, e.time_confirmation_level,
               e.home_location_id, e.preferred_department_id,
               e.active, l.name AS home_location_name, d.name AS preferred_department_name,
               p.name AS position_name
        FROM employees e
        LEFT JOIN locations l ON l.id = e.home_location_id
        LEFT JOIN departments d ON d.id = e.preferred_department_id
        LEFT JOIN positions p ON p.id = e.position_id
        ORDER BY e.active DESC, CAST(e.personnel_number AS INTEGER), e.personnel_number
      `)
      .all().map((row) => ({
        ...serializeEmployee(row, {
          includeTimeConfirmationLevel: sessionCanViewTimeConfirmationLevel(session),
        }),
        portal_access: portalAccessProfileForEmployee(row.personnel_number),
      }));
  if (!sessionHasGlobalScope(session)) {
    const locations = new Set((session.scopes || []).map((scope) => scope.locationId));
    const departments = new Set((session.scopes || []).map((scope) => Number(scope.departmentId || 0)).filter(Boolean));
    employees = employees.filter((employee) => locations.has(employee.home_location_id)
      && (session.role !== "department_manager" || departments.has(Number(employee.preferred_department_id || 0))));
  }
  response.json(employees);
});

app.post("/api/employees", (request, response) => {
  const employee = validateEmployee(request.body, true);
  const canManageTimeConfirmationLevel = sessionCanManageTimeConfirmationLevel(request.portalSession);
  if (!canManageTimeConfirmationLevel) employee.timeConfirmationLevel = "C";
  assertSessionContextScope(request.portalSession, { locationId: employee.homeLocationId, departmentId: employee.preferredDepartmentId });
  const accessProfile = validatePersonnelAccessProfile(request.portalSession, request.body.accessProfile, employee);
  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT INTO employees
        (personnel_number, full_name, nickname, color, contracted_hours, preferred_day_off, fixed_workdays,
         position_id, time_confirmation_level, home_location_id, preferred_department_id, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      employee.personnelNumber,
      employee.fullName,
      employee.nickname,
      employee.color,
      employee.contractedHours,
      employee.preferredDayOff,
      employee.fixedWorkdays,
      employee.positionId,
      employee.timeConfirmationLevel,
      employee.homeLocationId,
      employee.preferredDepartmentId,
      employee.active,
    );
    applyPersonnelAccessProfile(request.portalSession, accessProfile);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    if (String(error.message).includes("UNIQUE")) throw httpError(409, "Diese Personalnummer ist bereits vergeben.");
    throw error;
  }
  auditPortal(request.portalSession?.employeeNumber || "local", "employee.create", "employee", employee.personnelNumber,
    JSON.stringify({ timeConfirmationLevel: employee.timeConfirmationLevel }));
  const responseEmployee = {
    ...employee,
    active: Boolean(employee.active),
    portal_access: portalAccessProfileForEmployee(employee.personnelNumber),
  };
  if (!canManageTimeConfirmationLevel) delete responseEmployee.timeConfirmationLevel;
  response.status(201).json(responseEmployee);
});

app.put("/api/employees/:personnelNumber", (request, response) => {
  const personnelNumber = request.params.personnelNumber;
  assertSessionEmployeeScope(request.portalSession, personnelNumber);
  const existing = db.prepare("SELECT time_confirmation_level FROM employees WHERE personnel_number = ?").get(personnelNumber);
  if (!existing) throw httpError(404, "Die Person wurde nicht gefunden.");
  const canManageTimeConfirmationLevel = sessionCanManageTimeConfirmationLevel(request.portalSession);
  const employee = validateEmployee({
    ...request.body,
    personnelNumber,
    ...(canManageTimeConfirmationLevel ? {} : { timeConfirmationLevel: existing.time_confirmation_level || "C" }),
  }, false, { defaultTimeConfirmationLevel: existing.time_confirmation_level || "C" });
  assertSessionContextScope(request.portalSession, { locationId: employee.homeLocationId, departmentId: employee.preferredDepartmentId });
  const accessProfile = validatePersonnelAccessProfile(request.portalSession, request.body.accessProfile, {
    ...employee,
    personnelNumber,
  });
  db.exec("BEGIN");
  try {
    const result = db.prepare(`
      UPDATE employees
      SET full_name = ?, nickname = ?, color = ?, contracted_hours = ?, preferred_day_off = ?, fixed_workdays = ?,
          position_id = ?, time_confirmation_level = ?, home_location_id = ?, preferred_department_id = ?, active = ?
      WHERE personnel_number = ?
    `).run(
      employee.fullName,
      employee.nickname,
      employee.color,
      employee.contractedHours,
      employee.preferredDayOff,
      employee.fixedWorkdays,
      employee.positionId,
      employee.timeConfirmationLevel,
      employee.homeLocationId,
      employee.preferredDepartmentId,
      employee.active,
      personnelNumber,
    );
    if (!result.changes) throw httpError(404, "Die Person wurde nicht gefunden.");
    applyPersonnelAccessProfile(request.portalSession, accessProfile);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  auditPortal(request.portalSession?.employeeNumber || "local", "employee.update", "employee", personnelNumber,
    JSON.stringify({
      timeConfirmationLevelBefore: existing.time_confirmation_level || "C",
      timeConfirmationLevelAfter: employee.timeConfirmationLevel,
    }));
  const responseEmployee = {
    ...employee,
    personnelNumber,
    active: Boolean(employee.active),
    portal_access: portalAccessProfileForEmployee(personnelNumber),
  };
  if (!canManageTimeConfirmationLevel) delete responseEmployee.timeConfirmationLevel;
  response.json(responseEmployee);
});

app.patch("/api/employees/:personnelNumber/display", (request, response) => {
  const personnelNumber = String(request.params.personnelNumber || "").trim();
  assertSessionEmployeeScope(request.portalSession, personnelNumber);
  const color = String(request.body.color || "").trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(color)) {
    throw httpError(400, "Bitte eine gültige RGB-Farbe auswählen.", "EMPLOYEE_DISPLAY_INVALID");
  }
  const result = db.prepare("UPDATE employees SET color = ? WHERE personnel_number = ?").run(color, personnelNumber);
  if (!result.changes) throw httpError(404, "Die Person wurde nicht gefunden.");
  auditPortal(request.portalSession?.employeeNumber || "local", "employee.display.update", "employee", personnelNumber, JSON.stringify({ color }));
  response.json({ personnelNumber, color });
});

app.delete("/api/employees/:personnelNumber", (request, response) => {
  assertSessionEmployeeScope(request.portalSession, request.params.personnelNumber);
  const protectedUser = db.prepare("SELECT employee_number, role, role_locked FROM portal_users WHERE employee_number = ?").get(request.params.personnelNumber);
  if (protectedUser && (protectedUser.role === "developer" || protectedUser.role_locked)) {
    throw httpError(403, "Das Teammitglied ist mit dem geschützten Developer-Zugang verbunden und kann nicht gelöscht werden.", "PORTAL_DEVELOPER_PROTECTED");
  }
  const result = db.prepare("DELETE FROM employees WHERE personnel_number = ?").run(request.params.personnelNumber);
  if (!result.changes) throw httpError(404, "Die Person wurde nicht gefunden.");
  response.status(204).end();
});

app.get(["/api/portal/status", "/api/portal/v1/status"], (request, response) => {
  const publicStatus = getPortalStatus("", request);
  const session = publicStatus.portalEnabled ? portalSessionFromRequest(request, { touch: false }) : null;
  response.json(session ? portalStatusForSession(session, request) : publicStatus);
});

app.get("/api/mobile/v1/status", (_request, response) => {
  response.json(mobileApiStatus(new Date()));
});

app.post("/api/mobile/v1/auth/branding", (request, response) => {
  assertLoginBrandingRateLimit(request);
  response.json({ branding: mobileBrandingPayload({ role: "admin", homeLocationId: "" }) });
});

app.post("/api/mobile/v1/auth/login", async (request, response) => {
  requireMobileNativeAuthentication();
  assertLoginRateLimit(request);
  const employeeNumber = String(request.body?.employeeNumber || "").trim();
  const device = validateMobileDevice(request.body?.device || {});
  const user = db.prepare(`
    SELECT u.employee_number, u.password_hash, u.active, u.failed_login_attempts, u.locked_until,
           e.active AS employee_active
    FROM portal_users u JOIN employees e ON e.personnel_number = u.employee_number
    WHERE u.employee_number = ?
  `).get(employeeNumber);
  const now = new Date();
  if (user?.locked_until && new Date(user.locked_until) > now) {
    throw httpError(429, "Der Zugang ist vorübergehend gesperrt. Bitte später erneut versuchen.", "MOBILE_ACCOUNT_LOCKED");
  }
  const passwordMatches = await verifyPortalPassword(request.body?.password, user?.password_hash || DUMMY_PORTAL_PASSWORD_HASH);
  const valid = Boolean(user?.active && user?.employee_active && user.password_hash) && passwordMatches;
  if (!valid) {
    registerFailedLogin(request);
    if (user) {
      const portalSettings = getPortalSettings();
      const attempts = Number(user.failed_login_attempts || 0) + 1;
      const maximum = Number(portalSettings.max_failed_login_attempts || 5);
      const lockUntil = attempts >= maximum
        ? new Date(now.getTime() + Number(portalSettings.account_lock_minutes || 15) * 60000).toISOString()
        : null;
      db.prepare("UPDATE portal_users SET failed_login_attempts = ?, locked_until = ?, updated_at = CURRENT_TIMESTAMP WHERE employee_number = ?")
        .run(lockUntil ? 0 : attempts, lockUntil, employeeNumber);
    }
    auditPortal(employeeNumber, "mobile.login.failed", "portal_user", employeeNumber, `ip=${loginRateKey(request)}`);
    throw httpError(401, "Personalnummer oder Passwort ist nicht korrekt.", "MOBILE_LOGIN_FAILED");
  }
  clearLoginRate(request);
  db.prepare(`
    UPDATE portal_users SET failed_login_attempts = 0, locked_until = NULL,
      last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = ?
  `).run(employeeNumber);
  const created = createMobileSession(employeeNumber, device, now);
  const session = mobileSessionPrincipal(mobileSessionRow(created.id));
  auditPortal(employeeNumber, "mobile.login.success", "mobile_session", created.id,
    JSON.stringify({ platform: device.platform, appVersion: device.appVersion }));
  response.status(201).json({ tokenSet: created.tokenSet, bootstrap: mobileBootstrapPayload(session, request, now) });
});

app.post("/api/mobile/v1/auth/refresh", (request, response) => {
  requireMobileNativeAuthentication();
  assertMobileRefreshRateLimit(request);
  const device = validateMobileDevice(request.body?.device || {});
  const parsed = parseMobileToken(request.body?.refreshToken, MOBILE_REFRESH_TOKEN_PREFIX);
  const rowBefore = parsed ? mobileSessionRow(parsed.sessionId) : null;
  const tokenSet = refreshMobileSession(request.body?.refreshToken, device, new Date());
  if (rowBefore) auditPortal(rowBefore.employee_number, "mobile.session.refresh", "mobile_session", rowBefore.id);
  response.json({ tokenSet });
});

app.post("/api/mobile/v1/auth/logout", (request, response) => {
  requireMobileNativeAuthentication();
  const accessSession = mobileSessionFromRequest(request, { touch: false });
  const row = accessSession
    ? mobileSessionRow(accessSession.mobileSessionId)
    : mobileSessionRowFromRefreshToken(request.body?.refreshToken, new Date());
  const result = row ? db.prepare(`
    UPDATE mobile_sessions SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = 'logout', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND revoked_at IS NULL
  `).run(row.id) : { changes: 0 };
  if (row && result.changes) auditPortal(row.employee_number, "mobile.logout", "mobile_session", row.id);
  response.json({ ok: true });
});

app.get("/api/portal/v1/roles", (_request, response) => {
  response.json({
    apiVersion: PORTAL_API_VERSION,
    roles: getPortalRoles(),
    catalog: delegablePortalPermissionCatalog.map(({ hrDelegable: _hrDelegable, ...permission }) => permission),
  });
});

function sicknessLookup(kind, value) {
  const key = amuEncryptionConfiguration?.key;
  if (!key) throw httpError(503, "Der geschützte Krankmeldungsindex ist nicht verfügbar.", "SICKNESS_INDEX_UNAVAILABLE");
  return crypto.createHmac("sha256", key)
    .update(`grabenplaner-sickness-index-v1\0${String(kind || "")}\0${String(value ?? "")}`)
    .digest("hex");
}

function sicknessEmployeeLookup(employeeNumber) {
  return sicknessLookup("employee", String(employeeNumber || ""));
}

function sicknessStatusLookup(status) {
  return sicknessLookup("status", String(status || ""));
}

function sicknessAlertDedupeLookup(caseId, kind, audience) {
  return sicknessLookup("alert", `${Number(caseId)}:${String(kind || "")}:${String(audience || "")}`);
}

function sicknessOutboundEntityLookup(caseId) {
  return sicknessLookup("outbound-entity", String(Number(caseId)));
}

function sicknessOutboundDedupeLookup(caseId, recipient, channel) {
  return sicknessLookup("outbound-dedupe", `${Number(caseId)}:${String(recipient || "")}:${String(channel || "")}`);
}

app.get("/api/portal/v1/wifi-automation/settings", (request, response) => {
  const actor = requireAdminHrOrLocal(request, "wifi:settings");
  const connector = wifiConnectorPayload(actor);
  response.json({
    ...getWifiAutomationPolicy(),
    connectorStatus: connector.configured ? "configured" : "not_configured",
    connector,
    locationMappings: wifiLocationMappings(),
    automationActive: connector.configured,
    canChange: true,
    employees: wifiConfirmationLevels(),
  });
});

app.get("/api/portal/v1/trust-level-settings", (request, response) => {
  requireAdminHrOrLocal(request, "wifi:settings");
  response.json({
    ...getTrustLevelPolicy(),
    canChange: true,
    employees: wifiConfirmationLevels(),
  });
});

app.put("/api/portal/v1/trust-level-settings", (request, response) => {
  const actor = requireAdminHrOrLocal(request, "wifi:settings");
  const policy = validateTrustLevelPolicy(request.body || {});
  const levels = request.body?.levels === undefined ? [] : validateWifiConfirmationLevels(request.body || {});
  const values = {
    trust_levels_enabled: policy.enabled ? "1" : "0",
    trust_levels_visible_to_managers: policy.visibleToManagers ? "1" : "0",
    trust_levels_visible_to_department_managers: policy.visibleToDepartmentManagers ? "1" : "0",
    trust_levels_visible_to_employees: policy.visibleToEmployees ? "1" : "0",
  };
  const upsert = db.prepare(`
    INSERT INTO portal_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `);
  const getCurrent = db.prepare("SELECT time_confirmation_level FROM employees WHERE personnel_number = ?");
  const updateLevel = db.prepare("UPDATE employees SET time_confirmation_level = ? WHERE personnel_number = ?");
  const changed = [];
  db.exec("BEGIN");
  try {
    for (const [key, value] of Object.entries(values)) upsert.run(key, value);
    for (const item of levels) {
      const before = normalizeTimeConfirmationLevel(getCurrent.get(item.employeeNumber)?.time_confirmation_level);
      if (before === item.level) continue;
      updateLevel.run(item.level, item.employeeNumber);
      changed.push({ ...item, before });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  auditPortal(actor.employeeNumber, "trust_levels.settings.update", "portal_settings", "trust_levels", JSON.stringify(policy));
  for (const item of changed) {
    auditPortal(actor.employeeNumber, "employee.time_confirmation_level.update", "employee", item.employeeNumber,
      JSON.stringify({ before: item.before, after: item.level }));
  }
  response.json({ ...getTrustLevelPolicy(), changed: changed.length, canChange: true, employees: wifiConfirmationLevels() });
});

app.put("/api/portal/v1/wifi-automation/settings", (request, response) => {
  const actor = requireAdminHrOrLocal(request, "wifi:settings");
  const policy = validateWifiAutomationPolicy(request.body || {});
  const upsert = db.prepare(`
    INSERT INTO portal_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `);
  db.exec("BEGIN");
  try {
    upsert.run("wifi_minimum_presence_minutes", String(policy.minimumPresenceMinutes));
    upsert.run("wifi_absence_grace_minutes", String(policy.absenceGraceMinutes));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  auditPortal(actor.employeeNumber, "wifi.settings.update", "portal_settings", "wifi_automation", JSON.stringify(policy));
  response.json({
    ...getWifiAutomationPolicy(),
    connectorStatus: wifiWebhookConfigured() ? "configured" : "not_configured",
    connector: wifiConnectorPayload(actor),
    locationMappings: wifiLocationMappings(),
    automationActive: wifiWebhookConfigured(),
    canChange: true,
  });
});

app.put("/api/portal/v1/wifi-automation/location-mappings", (request, response) => {
  const actor = requireAdminHrOrLocal(request, "wifi:settings");
  response.json({ locationMappings: saveWifiLocationMappings(actor, request.body || {}) });
});

app.put("/api/portal/v1/wifi-automation/confirmation-levels", (request, response) => {
  const actor = requireAdminHrOrLocal(request, "wifi:settings");
  const levels = validateWifiConfirmationLevels(request.body || {});
  const getCurrent = db.prepare("SELECT time_confirmation_level FROM employees WHERE personnel_number = ?");
  const update = db.prepare("UPDATE employees SET time_confirmation_level = ? WHERE personnel_number = ?");
  const changed = [];
  db.exec("BEGIN");
  try {
    for (const item of levels) {
      const before = String(getCurrent.get(item.employeeNumber)?.time_confirmation_level || "C").toUpperCase();
      if (before === item.level) continue;
      update.run(item.level, item.employeeNumber);
      changed.push({ ...item, before });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  for (const item of changed) {
    auditPortal(actor.employeeNumber, "employee.time_confirmation_level.update", "employee", item.employeeNumber,
      JSON.stringify({ before: item.before, after: item.level }));
  }
  response.json({ changed: changed.length, employees: wifiConfirmationLevels() });
});

app.post("/api/integrations/wifi/events", (request, response) => {
  assertWifiWebhookRateLimit(request);
  assertWifiWebhookAuthorization(request);
  const result = processWifiEvent(validateWifiEvent(request.body || {}, new Date()), new Date());
  response.status(result.duplicate ? 200 : 202).json(result);
});

app.get("/api/portal/v1/workflow-settings", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "vacation:read");
  response.json({
    vacationHrApprovalRequired: vacationHrApprovalRequired(),
    canChange: session.employeeNumber === "local" || session.role === "admin" || session.permissions?.includes("hr:settings"),
  });
});

app.put("/api/portal/v1/workflow-settings", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "hr:settings");
  const required = request.body.vacationHrApprovalRequired === true;
  if (required) {
    const hr = db.prepare("SELECT 1 FROM portal_users WHERE role = 'hr' AND active = 1 AND TRIM(password_hash) <> '' LIMIT 1").get();
    if (!hr) throw httpError(409, "Bitte zuerst mindestens einen aktiven Zugang mit der Rolle Personalleitung einrichten.");
  }
  db.prepare(`
    INSERT INTO portal_settings (key, value, updated_at) VALUES ('vacation_hr_approval_required', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(required ? "1" : "0");
  auditPortal(session.employeeNumber, "workflow.settings.update", "portal_settings", "vacation_hr_approval_required", required ? "1" : "0");
  response.json({ vacationHrApprovalRequired: required, canChange: true });
});

function approvalDelegations() {
  return db.prepare(`
    SELECT d.*, l.name AS location_name, e.full_name, e.nickname
    FROM approval_delegations d JOIN locations l ON l.id = d.location_id
    JOIN employees e ON e.personnel_number = d.delegate_employee_number
    ORDER BY d.active DESC, d.date_from DESC, d.id DESC
  `).all().map((row) => ({ ...row, active: Boolean(row.active) }));
}

app.get("/api/portal/v1/approval-delegations", (request, response) => {
  requirePortalAdminOrLocal(request, "vacation:read");
  response.json({ delegations: approvalDelegations() });
});

app.post("/api/portal/v1/approval-delegations", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "settings:write");
  const locationId = normalizeLocationId(request.body.locationId);
  const employeeNumber = String(request.body.employeeNumber || "").trim();
  const dateFrom = String(request.body.dateFrom || "");
  const dateTo = String(request.body.dateTo || "");
  const note = stripEmoji(String(request.body.note || "").trim()).slice(0, 240);
  validateLocationExists(locationId);
  const delegate = db.prepare(`
    SELECT e.personnel_number FROM employees e JOIN portal_users u ON u.employee_number = e.personnel_number
    WHERE e.personnel_number = ? AND e.home_location_id = ? AND u.role = 'department_manager' AND u.active = 1
  `).get(employeeNumber, locationId);
  if (!delegate) throw httpError(400, "Bitte eine aktive Abteilungsleitung dieser Filiale auswählen.");
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateTo < dateFrom) throw httpError(400, "Bitte einen gültigen Vertretungszeitraum eingeben.");
  db.prepare(`INSERT INTO approval_delegations (location_id, delegate_employee_number, date_from, date_to, note, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(locationId, employeeNumber, dateFrom, dateTo, note, session.employeeNumber);
  response.status(201).json({ delegations: approvalDelegations() });
});

app.delete("/api/portal/v1/approval-delegations/:id", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "settings:write");
  const result = db.prepare("DELETE FROM approval_delegations WHERE id = ?").run(Number(request.params.id));
  if (!result.changes) throw httpError(404, "Die Vertretung wurde nicht gefunden.");
  auditPortal(session.employeeNumber, "approval_delegation.delete", "approval_delegation", request.params.id);
  response.status(204).end();
});

app.get("/api/portal/v1/session", (request, response) => {
  const publicStatus = getPortalStatus("", request);
  const session = publicStatus.portalEnabled ? portalSessionFromRequest(request) : null;
  const status = session ? portalStatusForSession(session, request) : publicStatus;
  if (session && !parseCookies(request)[PORTAL_CSRF_COOKIE]) {
    appendCookie(response, portalCookie(PORTAL_CSRF_COOKIE, crypto.randomBytes(24).toString("base64url"), request, {
      maxAge: Math.max(60, Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000)),
    }));
  }
  response.json({
    apiVersion: PORTAL_API_VERSION,
    authenticated: Boolean(session),
    loginRequired: status.loginRequired,
    user: publicPortalUser(session),
    status,
  });
});

app.post("/api/portal/v1/auth/branding", (request, response) => {
  assertLoginBrandingRateLimit(request);
  const employeeNumber = String(request.body.employeeNumber || "").trim();
  const user = employeeNumber ? db.prepare(`
    SELECT u.role, e.home_location_id
    FROM portal_users u
    JOIN employees e ON e.personnel_number = u.employee_number
    WHERE u.employee_number = ? AND u.active = 1 AND e.active = 1
    LIMIT 1
  `).get(employeeNumber) : null;
  const branding = user && !GLOBAL_SCOPE_PORTAL_ROLES.has(user.role)
    ? brandingForLocation(user.home_location_id)
    : managementBrandingPreference().branding;
  response.json({ branding });
});

app.post("/api/portal/v1/setup/admin", async (request, response) => {
  if (!isLoopbackRequest(request)) throw httpError(403, "Die Admin-Ersteinrichtung ist nur direkt am Grabenplaner-PC möglich.");
  if (getPortalStatus().adminSetupState === "configured") throw httpError(409, "Die Admin-Ersteinrichtung wurde bereits abgeschlossen.");
  const employeeNumber = String(request.body.employeeNumber || "").trim();
  const employee = db.prepare("SELECT personnel_number, full_name FROM employees WHERE personnel_number = ? AND active = 1").get(employeeNumber);
  if (!employee) throw httpError(404, "Das ausgewählte aktive Teammitglied wurde nicht gefunden.");
  const passwordHash = await hashPortalPassword(request.body.password);
  db.prepare(`
    INSERT INTO portal_users (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
    VALUES (?, ?, 'admin', 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = excluded.password_hash, role = 'admin', active = 1,
      must_change_password = 0, password_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, passwordHash);
  revokeMobileSessionsForEmployee(employeeNumber, "admin_setup_changed");
  auditPortal(employeeNumber, "portal.admin.setup", "portal_user", employeeNumber);
  response.status(201).json({ ok: true, status: getPortalStatus("", request) });
});

app.post("/api/portal/v1/auth/login", async (request, response) => {
  if (!getPortalStatus().portalEnabled) return sendPortalInactive(request, response);
  assertLoginRateLimit(request);
  const employeeNumber = String(request.body.employeeNumber || "").trim();
  const user = db.prepare(`
    SELECT u.employee_number, u.password_hash, u.active, u.failed_login_attempts, u.locked_until,
           e.active AS employee_active
    FROM portal_users u JOIN employees e ON e.personnel_number = u.employee_number
    WHERE u.employee_number = ?
  `).get(employeeNumber);
  const now = new Date();
  if (user?.locked_until && new Date(user.locked_until) > now) {
    throw httpError(429, "Der Zugang ist vorübergehend gesperrt. Bitte später erneut versuchen.", "PORTAL_ACCOUNT_LOCKED");
  }
  const passwordMatches = await verifyPortalPassword(request.body.password, user?.password_hash || DUMMY_PORTAL_PASSWORD_HASH);
  const valid = Boolean(user?.active && user?.employee_active && user.password_hash) && passwordMatches;
  if (!valid) {
    registerFailedLogin(request);
    if (user) {
      const portalSettings = getPortalSettings();
      const attempts = Number(user.failed_login_attempts || 0) + 1;
      const maximum = Number(portalSettings.max_failed_login_attempts || 5);
      const lockUntil = attempts >= maximum
        ? new Date(now.getTime() + Number(portalSettings.account_lock_minutes || 15) * 60000).toISOString()
        : null;
      db.prepare("UPDATE portal_users SET failed_login_attempts = ?, locked_until = ?, updated_at = CURRENT_TIMESTAMP WHERE employee_number = ?")
        .run(lockUntil ? 0 : attempts, lockUntil, employeeNumber);
    }
    auditPortal(employeeNumber, "portal.login.failed", "portal_user", employeeNumber, `ip=${loginRateKey(request)}`);
    throw httpError(401, "Personalnummer oder Passwort ist nicht korrekt.", "PORTAL_LOGIN_FAILED");
  }
  db.prepare("DELETE FROM portal_sessions WHERE expires_at <= CURRENT_TIMESTAMP OR revoked_at IS NOT NULL").run();
  clearLoginRate(request);
  db.prepare("UPDATE portal_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE employee_number = ? AND revoked_at IS NULL").run(employeeNumber);
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const csrfToken = crypto.randomBytes(24).toString("base64url");
  const timeoutMinutes = Math.min(1440, Math.max(15, Number(getPortalSettings().session_timeout_minutes || 480)));
  const expiresAt = new Date(now.getTime() + timeoutMinutes * 60000).toISOString();
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(crypto.randomUUID(), employeeNumber, sha256(rawToken), expiresAt);
  db.prepare(`
    UPDATE portal_users SET failed_login_attempts = 0, locked_until = NULL,
      last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = ?
  `).run(employeeNumber);
  appendCookie(response, portalCookie(PORTAL_SESSION_COOKIE, rawToken, request, { httpOnly: true, maxAge: timeoutMinutes * 60 }));
  appendCookie(response, portalCookie(PORTAL_CSRF_COOKIE, csrfToken, request, { maxAge: timeoutMinutes * 60 }));
  const session = portalSessionFromRequest({ ...request, headers: { ...request.headers, cookie: `${PORTAL_SESSION_COOKIE}=${rawToken}` } }, { touch: false });
  auditPortal(employeeNumber, "portal.login.success", "portal_user", employeeNumber, `ip=${loginRateKey(request)}`);
  response.json({ ok: true, authenticated: true, user: publicPortalUser(session), status: portalStatusForSession(session, request) });
});

app.post("/api/portal/v1/auth/logout", (request, response) => {
  const session = portalSessionFromRequest(request, { touch: false });
  if (session) {
    assertPortalCsrf(request);
    db.prepare("UPDATE portal_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?").run(session.id);
    auditPortal(session.employeeNumber, "portal.logout", "portal_user", session.employeeNumber);
  }
  clearPortalCookies(request, response);
  if (serverModeActive) response.setHeader("Clear-Site-Data", '"cache", "cookies", "storage"');
  response.json({ ok: true });
});

function rightsDashboardPermissionCatalog(roles = getPortalRoles()) {
  const details = new Map(portalDashboardPermissionDetails.map((permission) => [permission.id, permission]));
  const catalog = new Map();
  for (const permission of delegablePortalPermissionCatalog) {
    const dashboardDetail = details.get(permission.id) || {};
    catalog.set(permission.id, {
      id: permission.id,
      label: dashboardDetail.label || permission.label || permission.id,
      description: permission.description || dashboardDetail.description || "",
      group: dashboardDetail.group || permission.group || "Weitere Rechte",
      warningLevel: permission.warningLevel || "normal",
      scopeBehavior: dashboardDetail.scopeBehavior
        || (portalGlobalPermissionIds.has(permission.id) ? "global" : "organizational"),
    });
  }
  for (const permission of portalDashboardPermissionDetails) {
    if (catalog.has(permission.id)) continue;
    catalog.set(permission.id, {
      description: "",
      warningLevel: permission.id === "developer:system" ? "critical" : "normal",
      ...permission,
    });
  }
  for (const role of roles) {
    for (const permissionId of role.permissions || []) {
      if (catalog.has(permissionId)) continue;
      catalog.set(permissionId, {
        id: permissionId,
        label: permissionId.replaceAll("_", " ").replaceAll(":", " · "),
        description: "Technisches Rollenrecht ohne eigene Zusatzrechte-Freigabe.",
        group: "Weitere Rechte",
        warningLevel: "normal",
        scopeBehavior: portalGlobalPermissionIds.has(permissionId) ? "global" : "organizational",
      });
    }
  }
  return [...catalog.values()].sort((left, right) => left.group.localeCompare(right.group, "de-AT")
    || left.label.localeCompare(right.label, "de-AT") || left.id.localeCompare(right.id));
}

function rightsDashboardScopes(user, locationLookup, departmentLookup) {
  if (!user.configured) return { type: "inactive", source: "none", label: "Kein Portal-Zugang", entries: [] };
  if (GLOBAL_SCOPE_PORTAL_ROLES.has(user.role)) {
    return { type: "global", source: "role", label: "Alle Standorte und Abteilungen", entries: [] };
  }
  const assigned = Array.isArray(user.scopes) && user.scopes.length
    ? user.scopes.map((scope) => ({ ...scope, source: "assigned" }))
    : user.homeLocationId
      ? [{
          locationId: user.homeLocationId,
          departmentId: user.role === "department_manager" ? user.preferredDepartmentId : null,
          source: "home",
        }]
      : [];
  const entries = assigned.map((scope) => {
    const location = locationLookup.get(String(scope.locationId || ""));
    const department = scope.departmentId ? departmentLookup.get(Number(scope.departmentId)) : null;
    return {
      locationId: String(scope.locationId || ""),
      locationName: location?.name || String(scope.locationId || "Nicht zugewiesen"),
      departmentId: department?.id || null,
      departmentName: department?.name || "",
      source: scope.source,
      label: department
        ? `${location?.name || scope.locationId} · ${department.name}`
        : location?.name || String(scope.locationId || "Nicht zugewiesen"),
    };
  });
  if (!entries.length) return { type: "none", source: "none", label: "Kein wirksamer Bereich", entries: [] };
  const departmentOnly = entries.every((entry) => entry.departmentId);
  return {
    type: departmentOnly ? "department" : "location",
    source: entries.some((entry) => entry.source === "assigned") ? "assigned" : "home",
    label: entries.map((entry) => entry.label).join(", "),
    entries,
  };
}

function rightsDashboardCoverage(permission, user, scope) {
  if (permission.scopeBehavior === "self") {
    return { type: "self", label: "Nur eigene Daten", restricted: true };
  }
  if (permission.scopeBehavior === "global" || GLOBAL_SCOPE_PORTAL_ROLES.has(user.role)) {
    return { type: "global", label: "Gesamte Installation", restricted: false };
  }
  if (scope.type === "none" || scope.type === "inactive") {
    return { type: "none", label: "Kein wirksamer Bereich", restricted: true };
  }
  return { type: scope.type, label: scope.label, restricted: true };
}

function rightsDashboardThemeForActor(actor) {
  if (!actor || actor.employeeNumber === "local") return "light";
  const stored = db.prepare(`
    SELECT value FROM portal_user_preferences
    WHERE employee_number = ? AND preference_key = 'rights_dashboard_theme'
  `).get(actor.employeeNumber)?.value;
  return stored === "dark" ? "dark" : "light";
}

function rightsDashboardProcesses() {
  const features = installationFeatures();
  const portalSettings = getPortalSettings();
  const amuPolicy = getAmuPolicy();
  const vacationHrRequired = vacationHrApprovalRequired();
  const activeVacationBlackouts = Number(db.prepare("SELECT COUNT(*) AS count FROM request_blackouts WHERE active = 1 AND block_vacation = 1").get()?.count || 0);
  const activeTimeOffBlackouts = Number(db.prepare("SELECT COUNT(*) AS count FROM request_blackouts WHERE active = 1 AND block_time_off = 1").get()?.count || 0);
  const activeDelegations = Number(db.prepare("SELECT COUNT(*) AS count FROM approval_delegations WHERE active = 1").get()?.count || 0);
  const payrollTargets = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM integration_connections
    WHERE kind = 'payroll_https_target' AND active = 1 AND TRIM(COALESCE(protected_credentials, '')) <> ''
  `).get()?.count || 0);
  const payrollProfiles = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM integration_profiles
    WHERE direction = 'export' AND kind = 'payroll' AND active = 1
  `).get()?.count || 0);
  const locations = getLocations(false).map((location) => ({
    id: location.id,
    name: location.name,
    timeTrackingEnabled: Boolean(location.time_tracking_enabled),
    timeTrackingAccessMode: location.time_tracking_access_mode === "trusted_network" ? "trusted_network" : "anywhere",
    timeTrackingAccessLabel: location.time_tracking_access_mode === "trusted_network" ? "Nur freigegebene Netzwerke" : "Ortsunabhängige Buchung",
    timeTrackingVarianceMinutes: Math.max(0, Number(location.time_tracking_variance_minutes || 0)),
  }));
  const process = (definition) => ({
    ...definition,
    statusLabel: definition.enabled ? "Ablauf aktiv" : "Modul nicht freigeschaltet",
  });
  return {
    generatedAt: new Date().toISOString(),
    locations,
    processes: [
      process({
        id: "vacation",
        symbol: "U",
        title: "Urlaubsantrag",
        summary: "Vom Antrag über die lokale Freigabe bis zur verbindlichen Urlaubsplanung.",
        enabled: features.requests !== false && features.vacation !== false,
        locationSensitive: false,
        rules: [
          { label: "PL-Freigabe", value: vacationHrRequired ? "Erforderlich" : "Nicht erforderlich", tone: vacationHrRequired ? "attention" : "positive" },
          { label: "Aktive Antragssperren", value: String(activeVacationBlackouts), tone: activeVacationBlackouts ? "attention" : "neutral" },
          { label: "Aktive Vertretungen", value: String(activeDelegations), tone: activeDelegations ? "positive" : "neutral" },
        ],
        simulations: [
          { id: "current", label: "Aktuelle Konfiguration", description: "Zeigt den momentan gespeicherten Freigabeweg.", stepStates: {} },
          { id: "local_only", label: "Nur lokale Freigabe", description: "Simuliert einen Abschluss ohne zusätzliche Freigabe durch die Personalleitung.", stepStates: { hr_approval: "bypassed" } },
          { id: "two_stage", label: "Zweistufige Freigabe", description: "Simuliert die lokale Entscheidung mit anschließender verbindlicher PL-Freigabe.", stepStates: { hr_approval: "active" } },
        ],
        steps: [
          { id: "request", title: "Urlaub beantragen", actor: "Teammitglied", type: "actor", state: "active", description: "Zeitraum auswählen, optional eine Bemerkung ergänzen und den Antrag absenden.", setting: "Nur freigegebene Zeiträume können beantragt werden.", permissions: ["own_vacation:request"] },
          { id: "eligibility", title: "Sperren und Überschneidungen prüfen", actor: "Grabenplaner", type: "system", state: "active", description: "Antragssperren, bestehende Anträge und der ausgewählte Zeitraum werden automatisch geprüft.", setting: `${activeVacationBlackouts} aktive Urlaubssperre(n)`, permissions: [], settingsTarget: { tab: "vacation", label: "Urlaubseinstellungen öffnen" } },
          { id: "local_approval", title: "Lokale Freigabe", actor: "Filial- oder vertretende Abteilungsleitung", type: "approval", state: "active", description: "Die zuständige Leitung kann genehmigen, vorläufig genehmigen oder ablehnen und eine Bemerkung hinterlegen.", setting: activeDelegations ? "Aktive Vertretungsregeln werden berücksichtigt." : "Zuständigkeit folgt dem zugewiesenen Bereich.", permissions: ["vacation:read", "vacation:approve"] },
          { id: "hr_approval", title: "Freigabe durch Personalleitung", actor: "Personalleitung", type: "approval", state: vacationHrRequired ? "active" : "bypassed", description: vacationHrRequired ? "Nach der lokalen Freigabe entscheidet die Personalleitung verbindlich." : "Dieser Schritt wird mit der aktuellen Einstellung übersprungen.", setting: vacationHrRequired ? "Zweistufige Freigabe ist aktiv." : "Lokale Freigabe ist ausreichend.", permissions: ["hr:approve"], settingsTarget: { tab: "vacation", label: "Freigabeworkflow öffnen" } },
          { id: "planning", title: "Urlaub verbindlich eintragen", actor: "Grabenplaner", type: "finish", state: "active", description: "Der genehmigte Zeitraum wird in Urlaubs- und Dienstplanung übernommen und bleibt für Änderungs- oder Stornoanträge nachvollziehbar.", setting: "Genehmigte Daten werden als Abwesenheit berücksichtigt.", permissions: [] },
        ],
      }),
      process({
        id: "time_off",
        symbol: "ZA",
        title: "Zeitausgleich",
        summary: "Filialinterner oder PL-gebundener ZA mit Planbarkeitsprüfung und passendem Freigabeweg.",
        enabled: features.requests !== false,
        locationSensitive: false,
        rules: [
          { label: "Freigabeart", value: "Vom MA auswählbar", tone: "positive" },
          { label: "Aktive ZA-Sperren", value: String(activeTimeOffBlackouts), tone: activeTimeOffBlackouts ? "attention" : "neutral" },
          { label: "Mehrtägiger ZA", value: "Nur ganztägig", tone: "neutral" },
        ],
        simulations: [
          { id: "current", label: "Aktuelle Konfiguration", description: "Zeigt beide möglichen Wege als Entscheidung.", stepStates: {} },
          { id: "internal", label: "Filialinterner ZA", description: "Der Antrag wird nach der lokalen Freigabe ohne PL-Schritt abgeschlossen.", stepStates: { approval_type: "active", hr_approval: "bypassed" } },
          { id: "hr_bound", label: "PL-gebundener ZA", description: "Nach der lokalen Freigabe ist zusätzlich die Entscheidung der Personalleitung erforderlich.", stepStates: { approval_type: "active", hr_approval: "active" } },
        ],
        steps: [
          { id: "request", title: "ZA beantragen", actor: "Teammitglied", type: "actor", state: "active", description: "Ein Tag kann stundenweise oder ganztägig, ein Zeitraum ausschließlich ganztägig beantragt werden.", setting: "Filialinterner oder PL-gebundener ZA wird bereits im Antrag gewählt.", permissions: ["own_vacation:request"] },
          { id: "traffic_light", title: "Planbarkeit prüfen", actor: "Grabenplaner", type: "system", state: "active", description: "Dienstplan, Öffnungszeiten, Mindestbesetzung und Antragssperren ergeben eine verständliche Ampelbewertung.", setting: `${activeTimeOffBlackouts} aktive ZA-Sperre(n)`, permissions: [], settingsTarget: { tab: "vacation", label: "Urlaubseinstellungen öffnen" } },
          { id: "local_approval", title: "Lokale Freigabe", actor: "Filial- oder vertretende Abteilungsleitung", type: "approval", state: "active", description: "Die zuständige Leitung prüft den Antrag im eigenen Standort- oder Abteilungsbereich.", setting: "Dieser Schritt ist für beide ZA-Arten erforderlich.", permissions: ["vacation:read", "vacation:approve"] },
          { id: "approval_type", title: "Gewählte ZA-Art auswerten", actor: "Grabenplaner", type: "decision", state: "conditional", description: "Filialinterner ZA wird lokal abgeschlossen; PL-gebundener ZA wird an die Personalleitung weitergegeben.", setting: "Die Auswahl des Teammitglieds bestimmt den zweiten Freigabeschritt.", permissions: [] },
          { id: "hr_approval", title: "Optionale PL-Freigabe", actor: "Personalleitung", type: "approval", state: "conditional", description: "Nur ein ausdrücklich PL-gebundener ZA benötigt diese zusätzliche Genehmigung.", setting: "Bei filialinternem ZA wird dieser Schritt übersprungen.", permissions: ["hr:approve"] },
          { id: "planning", title: "ZA im Plan vormerken", actor: "Grabenplaner", type: "finish", state: "active", description: "Der genehmigte ZA wird in der Planung als Abwesenheit berücksichtigt; offene Anträge können zuvor weich sichtbar sein.", setting: "ZA erzeugt keine Arbeitsstunden.", permissions: [] },
        ],
      }),
      process({
        id: "sickness_amu",
        symbol: "AUM",
        title: "Krankmeldung & AUM",
        summary: "Sichere Krankmeldung, optionale AUM-Nachreichung, Fristen und geschützter Abschluss des Falls.",
        enabled: features.employeePortal !== false && features.sicknessAmu !== false,
        locationSensitive: false,
        rules: [
          { label: "Lokaler Hinweis", value: `nach ${amuPolicy.localWarningDays} Tag(en)`, tone: "attention" },
          { label: "PL-Eskalation", value: `nach ${amuPolicy.hrWarningDays} Tag(en)`, tone: "critical" },
          { label: "Lokale OCR", value: amuPolicy.ocrEnabled ? "Aktiv" : "Deaktiviert", tone: amuPolicy.ocrEnabled ? "positive" : "neutral" },
          { label: "AUM-Dateizugriff", value: "PL+ mit Zusatzrecht", tone: "positive" },
        ],
        simulations: [
          { id: "current", label: "Aktuelle Konfiguration", description: "Zeigt Krankmeldung, optionale Nachreichung und fachliche Prüfung.", stepStates: {} },
          { id: "report_only", label: "Zunächst nur krank melden", description: "Die AUM wird noch nicht mitgesendet und kann später nachgereicht werden.", stepStates: { document: "conditional", ocr: "bypassed" } },
          { id: "document_now", label: "AUM direkt mitsenden", description: "Die AUM wird im selben Ablauf übermittelt und – falls aktiv – lokal erkannt.", stepStates: { document: "active", ocr: amuPolicy.ocrEnabled ? "active" : "bypassed" } },
        ],
        steps: [
          { id: "report", title: "Krank melden", actor: "Teammitglied", type: "actor", state: "active", description: "Der Krankenstand wird mit Startdatum gemeldet; eine vorhandene AUM kann sofort mitgesendet werden.", setting: "Die Meldung ist unabhängig vom aktuellen Arbeitsort möglich.", permissions: ["own_sickness:create"] },
          { id: "staffing", title: "Besetzung und Hinweise prüfen", actor: "Grabenplaner", type: "system", state: "active", description: "Die Person wird als nicht einsetzbar berücksichtigt; bei gefährdeter Mindestbesetzung können geschützte Warnungen entstehen.", setting: `Lokale Warnung nach ${amuPolicy.localWarningDays}, PL-Eskalation nach ${amuPolicy.hrWarningDays} Tag(en).`, permissions: ["sickness:read", "notifications:settings"] },
          { id: "document", title: "AUM direkt oder später nachreichen", actor: "Teammitglied", type: "actor", state: "conditional", description: "Foto oder PDF kann bei der Krankmeldung oder nachträglich sicher hochgeladen werden; ein offenes Enddatum ist zulässig.", setting: `Upload bis ${amuPolicy.uploadMaxMb} MB, Speicherung bis ${amuPolicy.storedMaxMb} MB.`, permissions: ["own_amu:create"], settingsTarget: { tab: "access", label: "AUM-Einstellungen öffnen" } },
          { id: "ocr", title: "Datumswerte lokal erkennen", actor: "Grabenplaner", type: "system", state: amuPolicy.ocrEnabled ? "active" : "bypassed", description: amuPolicy.ocrEnabled ? "Die lokale OCR schlägt Beginn und Ende zur menschlichen Bestätigung vor." : "Die lokale OCR ist deaktiviert; Datumswerte werden manuell bestätigt.", setting: amuPolicy.ocrEnabled ? "OCR erstellt nur bearbeitbare Vorschläge." : "Keine automatische Datenerkennung.", permissions: [], settingsTarget: { tab: "access", label: "AUM-Einstellungen öffnen" } },
          { id: "secure_storage", title: "Dokument geschützt speichern", actor: "Grabenplaner", type: "system", state: "active", description: "AUM-Dokumente und Personalakt werden getrennt verschlüsselt gespeichert und revisionsfähig zugeordnet.", setting: amuPolicy.grayscaleImages ? "Bilder werden platzsparend in Graustufen verarbeitet." : "Farbinformationen bleiben erhalten.", permissions: [] },
          { id: "review", title: "Fall fachlich prüfen", actor: "Personalleitung", type: "approval", state: "active", description: "Filial- und Abteilungsleitung sehen ausschließlich Zeitraum, Status und Planungswirkung. Das Dokument bleibt geschützten PL+-Rollen mit ausdrücklichem Leserecht vorbehalten.", setting: "AUM-Dateizugriff ist nicht an lokale Leitungen delegierbar.", permissions: ["amu:metadata:read", "amu:file:read", "amu:review"], settingsTarget: { tab: "access", label: "AUM-Einstellungen öffnen" } },
          { id: "completion", title: "Arbeitsfähigkeit abschließen", actor: "Teammitglied oder Personalleitung", type: "finish", state: "active", description: "Ein bestätigtes Enddatum oder eine Rückkehrmeldung beendet die Nichtverfügbarkeit nachvollziehbar.", setting: "Ohne Enddatum bleibt der Krankenstandsfall offen.", permissions: ["own_sickness:read"] },
        ],
      }),
      process({
        id: "time_review",
        symbol: "ZEIT",
        title: "Zeiterfassung & Tagesprüfung",
        summary: "Von der Buchung über Abweichungen und Korrekturen bis zum geprüften Tagesabschluss.",
        enabled: features.timeTracking !== false,
        locationSensitive: true,
        rules: [
          { label: "Standortregel", value: "Standort auswählen", tone: "neutral", locationRule: "tracking" },
          { label: "Buchungsort", value: "Standort auswählen", tone: "neutral", locationRule: "access" },
          { label: "Abweichungstoleranz", value: "Standort auswählen", tone: "neutral", locationRule: "variance" },
        ],
        simulations: [
          { id: "current", label: "Aktuelle Konfiguration", description: "Zeigt Tagesprüfung und eine mögliche Korrekturschleife.", stepStates: {} },
          { id: "regular", label: "Regulärer Arbeitstag", description: "Alle Buchungen sind vollständig; die Korrekturschleife wird übersprungen.", stepStates: { correction: "bypassed" } },
          { id: "correction", label: "Mit Korrekturantrag", description: "Eine Abweichung wird vor der finalen Tagesprüfung geklärt.", stepStates: { correction: "active" } },
        ],
        steps: [
          { id: "booking", title: "Kommen, Pause, Weiter, Gehen", actor: "Teammitglied", type: "actor", state: "active", stateRule: "timeTrackingEnabled", description: "Zeitereignisse werden mit vertrauenswürdiger Serverzeit und sicherer Buchungsreihenfolge erfasst.", setting: "Die Verfügbarkeit richtet sich nach dem gewählten Standort.", permissions: ["own_time:write"], settingsTarget: { tab: "timeTracking", label: "Zeiterfassung öffnen" } },
          { id: "evaluation", title: "Tageswerte berechnen", actor: "Grabenplaner", type: "system", state: "active", description: "Sollzeit, Istzeit, Pausen, Samstagswertung und Abwesenheiten werden zu einer Tagesbewertung zusammengeführt.", setting: "Änderungen an Dienst, Zeit oder Abwesenheit machen eine alte Prüfung automatisch ungültig.", permissions: [] },
          { id: "variance", title: "Abweichungen kennzeichnen", actor: "Grabenplaner", type: "decision", state: "active", description: "Fehlende Buchungen, unvollständige Tage, Pausenfehler und Abweichungen außerhalb der Standorttoleranz werden sichtbar.", setting: "Die Minuten-Toleranz wird je Standort angewendet.", permissions: [], settingsTarget: { tab: "timeTracking", label: "Zeiterfassung öffnen" } },
          { id: "correction", title: "Korrektur klären", actor: "Teammitglied und Leitung", type: "approval", state: "conditional", description: "Das Teammitglied kann eine Korrektur beantragen; berechtigte Leitung prüft oder berichtigt die Buchungsfolge.", setting: "Offene Korrekturen verhindern einen finalen Ist-Lohnexport.", permissions: ["own_time:correction_request", "time:review"] },
          { id: "review", title: "Arbeitstag final prüfen", actor: "Filial- oder Abteilungsleitung", type: "approval", state: "active", description: "Die zuständige Leitung bestätigt die aktuelle Bewertung im eigenen Bereich.", setting: "Die Prüfung speichert einen nachvollziehbaren Snapshot des Tages.", permissions: ["time:read", "time:review"] },
          { id: "ready", title: "Für Auswertung bereit", actor: "Grabenplaner", type: "finish", state: "active", description: "Ein aktueller, vollständig geprüfter Tag kann in die Lohnverrechnungsauswertung einfließen.", setting: "Spätere Änderungen setzen den Status wieder auf ungeprüft.", permissions: [] },
        ],
      }),
      process({
        id: "payroll",
        symbol: "LV",
        title: "Lohnverrechnung übergeben",
        summary: "Geprüfte Zeit- und Abwesenheitsdaten als Datei oder über ein freigegebenes HTTPS-Ziel ausgeben.",
        enabled: features.integrations !== false,
        locationSensitive: true,
        rules: [
          { label: "Exportprofile", value: String(payrollProfiles), tone: payrollProfiles ? "positive" : "neutral" },
          { label: "Aktive HTTPS-Ziele", value: String(payrollTargets), tone: payrollTargets ? "positive" : "neutral" },
          { label: "Maximaler Zeitraum", value: "93 Tage", tone: "neutral" },
        ],
        simulations: [
          { id: "current", label: "Aktuelle Konfiguration", description: "Zeigt Datei-Export und eine vorhandene oder übersprungene HTTPS-Zustellung.", stepStates: {} },
          { id: "file_only", label: "Datei-Export", description: "Die Übergabe endet mit einer erzeugten CSV- oder Excel-Datei.", stepStates: { delivery: "bypassed" } },
          { id: "https_delivery", label: "HTTPS-Übergabe", description: "Simuliert eine kontrollierte direkte Zustellung nach erfolgreicher Vorprüfung.", stepStates: { delivery: "active" } },
        ],
        steps: [
          { id: "context", title: "Zeitraum und Bereich wählen", actor: "Personalleitung oder Administration", type: "actor", state: "active", description: "Standort, optionale Abteilung, Zeitraum, Datenquelle und ein gespeichertes Exportprofil werden festgelegt.", setting: `${payrollProfiles} aktive(s) Lohnprofil(e) verfügbar.`, permissions: ["payroll:export"], settingsTarget: { tab: "integrations", label: "Lohnverrechnung öffnen" } },
          { id: "preflight", title: "Daten vorprüfen", actor: "Grabenplaner", type: "system", state: "active", description: "Prüfstatus, Korrekturen, unvollständige Buchungen, Überschneidungen und Abteilungszuordnung werden kontrolliert.", setting: "Für geprüfte Ist-Werte sind aktuelle Tagesprüfungen erforderlich.", permissions: [] },
          { id: "decision", title: "Blocker oder freigabefähig", actor: "Grabenplaner", type: "decision", state: "active", description: "Blocker verhindern die finale Ausgabe; ein ausdrücklich gekennzeichneter Entwurf kann weiterhin zur Kontrolle erstellt werden.", setting: "Finale Übergabe ist nur ohne Blocker möglich.", permissions: [] },
          { id: "file", title: "CSV oder Excel erzeugen", actor: "Berechtigte Stelle", type: "actor", state: "active", description: "Die minimierten Lohnwerte können als Datei ausgegeben und extern weiterverarbeitet werden.", setting: "Keine Personalakt-, Bank-, Adress-, SV- oder AUM-Daten im Export.", permissions: ["payroll:export"] },
          { id: "delivery", title: "Optional sicher per HTTPS übertragen", actor: "Grabenplaner", type: "system", state: payrollTargets ? "active" : "bypassed", description: payrollTargets ? "Final geprüfte Daten können an ein vorkonfiguriertes, getestetes HTTPS-Ziel gesendet werden." : "Kein aktives HTTPS-Lohnziel mit Zugangsdaten konfiguriert; der Datei-Export bleibt verfügbar.", setting: `${payrollTargets} aktives HTTPS-Ziel(e).`, permissions: ["payroll:deliver"], settingsTarget: { tab: "integrations", label: "Schnittstellen öffnen" } },
          { id: "audit", title: "Ergebnis protokollieren", actor: "Grabenplaner", type: "finish", state: "active", description: "Status, Zeit, Zielrevision, Zeilenzahl und Prüfsumme bleiben nachvollziehbar; fachliche Nutzdaten werden nicht in das Audit kopiert.", setting: "Unterbrochene Übertragungen werden als unklar markiert und nicht still wiederholt.", permissions: ["integrations:read"] },
        ],
      }),
    ],
  };
}

function rightsDashboardProcessValidation(processDashboard) {
  const checks = [];
  const add = (processId, stepId, severity, title, detail, settingsTab = "") => checks.push({
    id: `${processId}-${checks.length + 1}`,
    processId,
    stepId,
    severity,
    title,
    detail,
    settingsTarget: settingsTab ? { tab: settingsTab, label: "Passende Einstellung öffnen" } : null,
  });
  const processes = new Map(processDashboard.processes.map((process) => [process.id, process]));
  const vacation = processes.get("vacation");
  const timeOff = processes.get("time_off");
  const sickness = processes.get("sickness_amu");
  const timeReview = processes.get("time_review");
  const payroll = processes.get("payroll");
  const ruleValue = (process, label) => process?.rules?.find((rule) => rule.label === label)?.value || "0";

  add("vacation", "request", vacation?.enabled ? "ok" : "blocker",
    vacation?.enabled ? "Urlaubsanträge sind freigeschaltet" : "Urlaubsanträge sind deaktiviert",
    vacation?.enabled ? "Antrag, lokale Prüfung und verbindlicher Eintrag stehen zur Verfügung." : "Mindestens Urlaub und Abwesenheitsanträge müssen im Funktionsprofil freigeschaltet sein.", "vacation");
  add("vacation", "hr_approval", "info", "Freigabeweg ist eindeutig",
    ruleValue(vacation, "PL-Freigabe") === "Erforderlich" ? "Die zweistufige Freigabe mit Personalleitung ist aktiv." : "Die lokale Leitung kann Urlaubsanträge verbindlich abschließen.", "vacation");

  add("time_off", "request", timeOff?.enabled ? "ok" : "blocker",
    timeOff?.enabled ? "ZA-Anträge sind freigeschaltet" : "ZA-Anträge sind deaktiviert",
    timeOff?.enabled ? "Filialinterner und PL-gebundener ZA können beantragt werden." : "Die Funktion Abwesenheitsanträge ist im Installationsprofil nicht aktiv.", "vacation");

  const amuDiagnostics = amuStorage?.diagnostics?.() || { ok: false };
  add("sickness_amu", "secure_storage", !sickness?.enabled ? "blocker" : amuDiagnostics.ok ? "ok" : "blocker",
    !sickness?.enabled ? "Krankmeldung und AUM sind deaktiviert" : amuDiagnostics.ok ? "Geschützter AUM-Speicher ist bereit" : "Geschützter AUM-Speicher ist nicht bereit",
    !sickness?.enabled ? "Mitarbeiterportal und Krankmeldung/AUM müssen im Funktionsprofil aktiv sein." : amuDiagnostics.ok ? "Dokumente können verschlüsselt gespeichert und wieder eindeutig zugeordnet werden." : "Speicher, Schlüssel und Virenscanner müssen vor produktiven Uploads geprüft werden.", "access");
  add("sickness_amu", "ocr", "info", `Lokale OCR ist ${ruleValue(sickness, "Lokale OCR").toLowerCase()}`,
    "OCR bleibt eine Komfortfunktion: erkannte Werte werden nie ohne menschliche Bestätigung übernommen.", "access");

  const activeLocations = processDashboard.locations.length;
  const trackingLocations = processDashboard.locations.filter((location) => location.timeTrackingEnabled).length;
  const rawTrackingLocations = db.prepare(`
    SELECT id, name, time_tracking_access_mode, time_tracking_allowed_networks
    FROM locations WHERE active = 1 AND time_tracking_enabled = 1 ORDER BY id
  `).all();
  const trustedWithoutNetworks = rawTrackingLocations.filter((location) => location.time_tracking_access_mode === "trusted_network"
    && !String(location.time_tracking_allowed_networks || "").split(/[\s,;]+/).filter(Boolean).length);
  add("time_review", "booking", !timeReview?.enabled ? "blocker" : !activeLocations ? "blocker" : trackingLocations ? "ok" : "warning",
    !timeReview?.enabled ? "Zeiterfassung ist deaktiviert" : trackingLocations ? `Zeiterfassung an ${trackingLocations} Standort(en) aktiv` : "An keinem Standort ist Zeiterfassung aktiv",
    !timeReview?.enabled ? "Die Funktion Zeiterfassung ist im Installationsprofil nicht aktiv." : trackingLocations ? "Mindestens ein aktiver Standort kann Zeitbuchungen annehmen." : "Die Prozessdarstellung bleibt verfügbar, Buchungen sind derzeit aber an keinem Standort möglich.", "timeTracking");
  if (trustedWithoutNetworks.length) add("time_review", "booking", "blocker", "Freigegebenes Netzwerk fehlt",
    `${trustedWithoutNetworks.length} Standort(e) verlangen ein freigegebenes Netzwerk, haben aber noch keine Netzadresse hinterlegt. Vertrauliche Netzwerkwerte werden im Dashboard nicht angezeigt.`, "timeTracking");

  const profileCount = Number(ruleValue(payroll, "Exportprofile"));
  const targetCount = Number(ruleValue(payroll, "Aktive HTTPS-Ziele"));
  add("payroll", "context", !payroll?.enabled ? "blocker" : profileCount ? "ok" : "warning",
    !payroll?.enabled ? "Import und Lohnverrechnung sind deaktiviert" : profileCount ? `${profileCount} aktives Lohnprofil verfügbar` : "Noch kein aktives Lohnprofil",
    !payroll?.enabled ? "Die Schnittstellenfunktion ist im Installationsprofil nicht freigeschaltet." : profileCount ? "Der strukturierte Datei-Export kann vorbereitet werden." : "Vor einem wiederholbaren Lohnexport sollte ein geprüftes Exportprofil gespeichert werden.", "integrations");
  add("payroll", "delivery", "info", targetCount ? `${targetCount} sichere(s) HTTPS-Ziel(e) aktiv` : "Datei-Export ohne direktes HTTPS-Ziel",
    targetCount ? "Nach erfolgreicher Vorprüfung kann eine kontrollierte Direktübergabe verwendet werden." : "Das ist zulässig: CSV- und Excel-Ausgabe bleiben auch ohne direkte Verbindung verfügbar.", "integrations");

  const summary = { ok: 0, warning: 0, blocker: 0, info: 0 };
  for (const check of checks) summary[check.severity] += 1;
  return {
    generatedAt: new Date().toISOString(),
    ready: summary.blocker === 0,
    summary,
    checks,
  };
}

function rightsDashboardProcessSimulation(process, scenarioId = "current") {
  const scenarios = Array.isArray(process.simulations) && process.simulations.length
    ? process.simulations
    : [{ id: "current", label: "Aktuelle Konfiguration", description: "Aktuell gespeicherter Ablauf.", stepStates: {} }];
  const scenario = scenarios.find((entry) => entry.id === scenarioId) || scenarios[0];
  return {
    ...process,
    scenario,
    steps: process.steps.map((step) => ({ ...step, state: scenario.stepStates?.[step.id] || step.state })),
  };
}

function rightsDashboardProcessLocation(processDashboard, locationId) {
  return processDashboard.locations.find((location) => String(location.id) === String(locationId))
    || processDashboard.locations[0]
    || null;
}

function rightsDashboardProcessStepState(process, step, location) {
  if (!process.enabled) return "inactive";
  if (step.stateRule === "timeTrackingEnabled") return location?.timeTrackingEnabled ? "active" : "inactive";
  return step.state || "active";
}

function rightsDashboardProcessRuleValue(rule, location) {
  if (!rule.locationRule) return String(rule.value);
  if (!location) return "Kein Standort";
  if (rule.locationRule === "tracking") return location.timeTrackingEnabled ? "Aktiv" : "Deaktiviert";
  if (rule.locationRule === "access") return location.timeTrackingAccessLabel;
  if (rule.locationRule === "variance") return `${location.timeTrackingVarianceMinutes} Minuten`;
  return String(rule.value);
}

function rightsDashboardProcessStepSetting(process, step, location) {
  if (!process.locationSensitive || !location) return step.setting;
  if (process.id === "time_review" && step.id === "booking") {
    return location.timeTrackingEnabled ? `${location.name}: aktiv · ${location.timeTrackingAccessLabel}` : `${location.name}: Zeiterfassung deaktiviert`;
  }
  if (process.id === "time_review" && step.id === "variance") return `${location.name}: ${location.timeTrackingVarianceMinutes} Minuten Abweichungstoleranz`;
  if (process.id === "payroll" && step.id === "context") return `${location.name} ist als aktueller Standortbezug gewählt.`;
  return step.setting;
}

function rightsDashboardPayload(actor) {
  const roles = getPortalRoles();
  const roleLookup = new Map(roles.map((role) => [role.id, role]));
  const locations = db.prepare("SELECT id, name, active FROM locations ORDER BY id").all()
    .map((location) => ({ id: location.id, name: location.name, active: Boolean(location.active) }));
  const departments = db.prepare("SELECT id, location_id, name, active FROM departments ORDER BY location_id, sort_order, name, id").all()
    .map((department) => ({ id: Number(department.id), locationId: department.location_id, name: department.name, active: Boolean(department.active) }));
  const locationLookup = new Map(locations.map((location) => [String(location.id), location]));
  const departmentLookup = new Map(departments.map((department) => [Number(department.id), department]));
  const catalog = rightsDashboardPermissionCatalog(roles);
  const catalogLookup = new Map(catalog.map((permission) => [permission.id, permission]));
  const users = portalUsersForAdmin().filter((user) => user.employeeActive).map((user) => {
    const role = roleLookup.get(user.role) || roleLookup.get("employee") || { id: "employee", name: "Mitarbeiter", permissions: [] };
    const rolePermissions = new Set(role.permissions || []);
    const grantedPermissions = new Set(user.grantedPermissions || []);
    const scope = rightsDashboardScopes(user, locationLookup, departmentLookup);
    const accessActive = Boolean(user.configured && user.active && user.passwordConfigured);
    const assignedPermissionIds = [...new Set([...rolePermissions, ...grantedPermissions])].sort();
    const permissions = assignedPermissionIds.map((permissionId) => {
      const permission = catalogLookup.get(permissionId) || {
        id: permissionId, label: permissionId, description: "", group: "Weitere Rechte",
        warningLevel: "normal", scopeBehavior: "organizational",
      };
      const origin = rolePermissions.has(permissionId) ? "role" : "delegated";
      const coverage = rightsDashboardCoverage(permission, user, scope);
      return {
        id: permission.id,
        label: permission.label,
        description: permission.description,
        group: permission.group,
        warningLevel: permission.warningLevel,
        origin,
        originLabel: origin === "role" ? `Grundrecht der Rolle ${role.name}` : "Individuelles Zusatzrecht",
        coverage,
        effective: accessActive && coverage.type !== "none",
      };
    });
    return {
      employeeNumber: user.employeeNumber,
      fullName: user.fullName,
      nickname: user.nickname,
      configured: user.configured,
      accessActive,
      role: role.id,
      roleName: role.name,
      roleDescription: role.description || "",
      homeLocationId: user.homeLocationId,
      preferredDepartmentId: user.preferredDepartmentId,
      scope,
      permissions,
      counts: {
        effective: permissions.filter((permission) => permission.effective).length,
        role: permissions.filter((permission) => permission.effective && permission.origin === "role").length,
        delegated: permissions.filter((permission) => permission.effective && permission.origin === "delegated").length,
        restricted: permissions.filter((permission) => permission.effective && permission.coverage.restricted).length,
      },
    };
  });
  const effectivePermissions = users.flatMap((user) => user.permissions.filter((permission) => permission.effective));
  const processDashboard = rightsDashboardProcesses();
  processDashboard.validation = rightsDashboardProcessValidation(processDashboard);
  return {
    generatedAt: new Date().toISOString(),
    actor: { employeeNumber: actor.employeeNumber, role: actor.role },
    preferences: { theme: rightsDashboardThemeForActor(actor) },
    summary: {
      teamMembers: users.length,
      activeAccesses: users.filter((user) => user.accessActive).length,
      delegatedRights: effectivePermissions.filter((permission) => permission.origin === "delegated").length,
      scopedRights: effectivePermissions.filter((permission) => permission.coverage.restricted).length,
    },
    roles: roles.map((role) => ({ id: role.id, name: role.name, description: role.description || "" })),
    locations: locations.map((location) => ({
      ...location,
      departments: departments.filter((department) => department.locationId === location.id),
    })),
    catalog,
    users,
    processDashboard,
  };
}

function rightsManagementPayload(actor) {
  const roles = new Map(getPortalRoles().map((role) => [role.id, role]));
  const users = portalUsersForAdmin()
    .filter((user) => user.employeeActive)
    .map((user) => {
      const rolePermissions = roles.get(user.role)?.permissions || [];
      return {
        ...user,
        rolePermissions,
        effectivePermissions: [...new Set([...rolePermissions, ...(user.grantedPermissions || [])])],
        manageable: actorCanManagePermissionGrants(actor, user),
      };
    });
  return {
    catalog: portalPermissionCatalogForActor(actor),
    users,
  };
}

function drawRightsDashboardProcessPdf(processDashboard, process, location, validation, response, createdAt = new Date()) {
  const doc = new PDFDocument({
    size: "A4",
    margin: 0,
    info: {
      Title: `Prozessweg · ${process.title}`,
      Subject: `${APP_NAME} ${APP_VERSION_LABEL} · Rechte-Dashboard`,
    },
  });
  doc.pipe(response);
  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const left = 42;
  const width = pageWidth - left * 2;
  const colors = { text: "#172331", muted: "#6f7b80", line: "#d7dfdb", accent: "#26785f", soft: "#eef6f2", warning: "#b77a12", blocker: "#b8473b" };
  let y = 38;
  const pageHeader = (continued = false) => {
    doc.fillColor(colors.accent).font("Helvetica-Bold").fontSize(7).text("GRABENPLANER · RECHTE-DASHBOARD", left, y, { characterSpacing: 1.2 });
    y += 16;
    doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(continued ? 14 : 22).text(continued ? `${process.title} · Fortsetzung` : process.title, left, y, { width });
    y += continued ? 25 : 34;
  };
  const ensureSpace = (height) => {
    if (y + height <= pageHeight - 42) return;
    doc.addPage({ size: "A4", margin: 0 });
    y = 38;
    pageHeader(true);
  };
  pageHeader();
  doc.fillColor(colors.muted).font("Helvetica").fontSize(9).text(process.summary, left, y, { width, lineGap: 2 });
  y = doc.y + 13;
  const contextParts = [`Simulation: ${process.scenario.label}`];
  if (process.locationSensitive && location) contextParts.push(`Standort: ${location.id} · ${location.name}`);
  contextParts.push(`Erstellt: ${createdAt.toLocaleString("de-AT", { timeZone: "Europe/Vienna" })}`);
  doc.roundedRect(left, y, width, 31, 7).fill(colors.soft);
  doc.fillColor(colors.accent).font("Helvetica-Bold").fontSize(8).text(contextParts.join("  ·  "), left + 10, y + 11, { width: width - 20, ellipsis: true });
  y += 45;

  doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(12).text("Aktuell wirksame Regeln", left, y);
  y += 20;
  const ruleColumns = 2;
  const ruleGap = 8;
  const ruleWidth = (width - ruleGap) / ruleColumns;
  process.rules.forEach((rule, index) => {
    const column = index % ruleColumns;
    if (column === 0 && index > 0) y += 42;
    const x = left + column * (ruleWidth + ruleGap);
    doc.roundedRect(x, y, ruleWidth, 34, 6).lineWidth(.7).fillAndStroke("#ffffff", colors.line);
    doc.fillColor(colors.muted).font("Helvetica-Bold").fontSize(6.5).text(rule.label.toUpperCase(), x + 9, y + 7, { width: ruleWidth - 18, ellipsis: true });
    doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(8.5).text(rightsDashboardProcessRuleValue(rule, location), x + 9, y + 18, { width: ruleWidth - 18, ellipsis: true });
  });
  y += 51;

  doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(12).text("Ablauf", left, y);
  y += 18;
  for (let index = 0; index < process.steps.length; index += 1) {
    const step = process.steps[index];
    const state = rightsDashboardProcessStepState(process, step, location);
    const setting = rightsDashboardProcessStepSetting(process, step, location);
    doc.font("Helvetica").fontSize(7.5);
    const descriptionHeight = doc.heightOfString(step.description, { width: width - 185, lineGap: 1.4 });
    doc.font("Helvetica-Oblique").fontSize(6.5);
    const settingHeight = doc.heightOfString(setting, { width: 107, lineGap: 1 });
    const rowHeight = Math.max(56, descriptionHeight + 34, settingHeight + 39);
    ensureSpace(rowHeight + 8);
    const stateColor = state === "active" ? colors.accent : state === "conditional" ? colors.warning : colors.muted;
    doc.lineWidth(1.2).strokeColor(index === process.steps.length - 1 ? "#ffffff" : colors.line).moveTo(left + 11, y + 22).lineTo(left + 11, y + rowHeight + 8).stroke();
    doc.circle(left + 11, y + 16, 6).fill(stateColor);
    doc.roundedRect(left + 27, y, width - 27, rowHeight, 7).lineWidth(.7).fillAndStroke("#ffffff", colors.line);
    doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(9).text(step.title, left + 38, y + 9, { width: width - 170, ellipsis: true });
    doc.fillColor(colors.accent).font("Helvetica-Bold").fontSize(6.7).text(step.actor, left + 38, y + 22, { width: width - 170, ellipsis: true });
    doc.fillColor(colors.muted).font("Helvetica").fontSize(7.5).text(step.description, left + 38, y + 34, { width: width - 185, lineGap: 1.4 });
    doc.fillColor(stateColor).font("Helvetica-Bold").fontSize(6.5).text(({ active: "AKTIV", conditional: "BEDINGT", bypassed: "ÜBERSPRUNGEN", inactive: "DEAKTIVIERT" })[state] || "AKTIV", pageWidth - left - 82, y + 10, { width: 71, align: "right" });
    doc.fillColor(colors.muted).font("Helvetica-Oblique").fontSize(6.5).text(setting, pageWidth - left - 118, y + 29, { width: 107, align: "right", lineGap: 1 });
    y += rowHeight + 8;
  }

  const processChecks = validation.checks.filter((check) => check.processId === process.id);
  ensureSpace(56 + processChecks.length * 34);
  y += 4;
  doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(12).text("Konfigurationsprüfung", left, y);
  y += 19;
  for (const check of processChecks) {
    const checkColor = check.severity === "blocker" ? colors.blocker : check.severity === "warning" ? colors.warning : colors.accent;
    doc.roundedRect(left, y, width, 29, 6).fill(check.severity === "blocker" ? "#faecea" : check.severity === "warning" ? "#fff5dc" : colors.soft);
    doc.circle(left + 12, y + 14.5, 4).fill(checkColor);
    doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(7.5).text(check.title, left + 23, y + 6, { width: width - 35, ellipsis: true });
    doc.fillColor(colors.muted).font("Helvetica").fontSize(6.5).text(check.detail, left + 23, y + 17, { width: width - 35, ellipsis: true });
    y += 34;
  }
  doc.fillColor(colors.muted).font("Helvetica").fontSize(6.5).text(`Nur lesende Dokumentation · ${APP_NAME} ${APP_VERSION_LABEL}`, left, pageHeight - 28, { width, align: "center" });
  doc.end();
}

app.get("/api/portal/v1/rights", (request, response) => {
  const actor = requireAdminHrOrLocal(request, "rights:read");
  response.json(rightsManagementPayload(actor));
});

app.get("/api/portal/v1/rights-dashboard", (request, response) => {
  const actor = requireAdminHrOrLocal(request, "rights:read");
  response.json(rightsDashboardPayload(actor));
});

app.get("/api/portal/v1/rights-dashboard/process-export.pdf", (request, response) => {
  requireAdminHrOrLocal(request, "rights:read");
  const processDashboard = rightsDashboardProcesses();
  const validation = rightsDashboardProcessValidation(processDashboard);
  processDashboard.validation = validation;
  const requestedProcessId = String(request.query.process || "vacation");
  const selected = processDashboard.processes.find((process) => process.id === requestedProcessId);
  if (!selected) throw httpError(400, "Bitte einen gültigen Prozess für den PDF-Export auswählen.", "RIGHTS_DASHBOARD_PROCESS_INVALID");
  const process = rightsDashboardProcessSimulation(selected, String(request.query.scenario || "current"));
  const location = rightsDashboardProcessLocation(processDashboard, request.query.location);
  const filename = `Prozessweg ${sanitizeFilenamePart(process.title)}.pdf`;
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader("Content-Disposition", contentDispositionHeader(filename));
  drawRightsDashboardProcessPdf(processDashboard, process, location, validation, response, new Date());
});

app.put("/api/portal/v1/rights-dashboard/preferences", (request, response) => {
  const actor = requireAdminHrOrLocal(request, "rights:read");
  const theme = request.body.theme === "dark" ? "dark" : request.body.theme === "light" ? "light" : "";
  if (!theme) throw httpError(400, "Bitte eine gültige Dashboard-Darstellung auswählen.", "RIGHTS_DASHBOARD_THEME_INVALID");
  if (actor.employeeNumber !== "local") {
    db.prepare(`
      INSERT INTO portal_user_preferences (employee_number, preference_key, value, updated_at)
      VALUES (?, 'rights_dashboard_theme', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(employee_number, preference_key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(actor.employeeNumber, theme);
  }
  response.json({ theme });
});

app.put("/api/portal/v1/rights/:employeeNumber", (request, response) => {
  const actor = requireAdminHrOrLocal(request, "rights:write");
  const employeeNumber = String(request.params.employeeNumber || "").trim();
  const target = portalUsersForAdmin().find((user) => user.employeeNumber === employeeNumber);
  if (!target?.configured || !target.active) throw httpError(404, "Der aktive Portal-Zugang wurde nicht gefunden.");
  if (!actorCanManagePermissionGrants(actor, target)) throw httpError(403, target.role === "developer"
    ? "Der Developer-Zugang ist geschützt und kann nicht über die App verändert werden."
    : "Für diesen Zugang dürfen keine individuellen Rechte geändert werden.", target.role === "developer" ? "PORTAL_DEVELOPER_PROTECTED" : "PORTAL_ROLE_HIERARCHY_DENIED");
  if (!Array.isArray(request.body.permissions)) throw httpError(400, "Bitte eine gültige Rechteauswahl übermitteln.");
  const submitted = [...new Set(request.body.permissions.map((value) => String(value || "").trim()).filter(Boolean))];
  const manageablePermissions = manageablePortalPermissionsForActor(actor);
  const invalid = submitted.filter((permission) => !manageablePermissions.has(permission));
  if (invalid.length) {
    throw httpError(403, `Diese Rechte dürfen durch den aktuellen Zugang nicht vergeben werden: ${invalid.join(", ")}`, "PORTAL_PERMISSION_NOT_DELEGABLE");
  }
  const roleRestricted = submitted.filter((permission) => !portalPermissionAllowedForRole(permission, target.role));
  if (roleRestricted.length) {
    throw httpError(403, "Geschützte AUM-Rechte dürfen nur Personalleitung und höheren Rollen zugewiesen werden.", "AMU_PERMISSION_ROLE_RESTRICTED");
  }
  const before = portalPermissionGrantsForEmployee(employeeNumber);
  db.exec("BEGIN");
  try {
    const remove = db.prepare("DELETE FROM portal_permission_grants WHERE employee_number = ? AND permission = ?");
    for (const permission of manageablePermissions) remove.run(employeeNumber, permission);
    const insert = db.prepare(`
      INSERT INTO portal_permission_grants (employee_number, permission, granted_by, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `);
    for (const permission of submitted) insert.run(employeeNumber, permission, actor.employeeNumber);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const after = portalPermissionGrantsForEmployee(employeeNumber);
  revokeMobileSessionsForEmployee(employeeNumber, "permissions_changed");
  auditPortal(actor.employeeNumber, "portal.rights.update", "portal_user", employeeNumber, JSON.stringify({ before, after }));
  response.json(rightsManagementPayload(actor));
});

app.get("/api/portal/v1/users", (request, response) => {
  const actor = requirePortalAnyPermission(request, ["users:write", "scopes:write"]);
  response.json({ users: portalUsersForActor(actor), roles: getPortalRoles() });
});

app.put("/api/portal/v1/users/:employeeNumber/scopes", (request, response) => {
  const actor = requirePortalAdminOrLocal(request, "scopes:write");
  const employeeNumber = String(request.params.employeeNumber || "").trim();
  const target = db.prepare(`SELECT u.role, e.home_location_id FROM portal_users u JOIN employees e ON e.personnel_number = u.employee_number WHERE u.employee_number = ?`).get(employeeNumber);
  if (!target) throw httpError(404, "Der Zugang wurde nicht gefunden.");
  if (!["manager", "department_manager"].includes(target.role)) throw httpError(400, "Nur Filial- und Abteilungsleitungen benötigen eine Bereichszuweisung.");
  const submitted = Array.isArray(request.body.scopes) ? request.body.scopes : [];
  const scopes = submitted.map((scope) => ({
    locationId: normalizeLocationId(scope.locationId),
    departmentId: normalizeDepartmentId(scope.departmentId, true),
  }));
  if (!scopes.length) throw httpError(400, "Bitte mindestens einen Bereich zuweisen.");
  for (const scope of scopes) {
    validateLocationExists(scope.locationId);
    if (target.role === "department_manager") {
      if (!scope.departmentId) throw httpError(400, "Für eine Abteilungsleitung muss eine Abteilung ausgewählt werden.");
      validateDepartmentExists(scope.departmentId, scope.locationId);
    } else scope.departmentId = null;
    if (actor.role === "manager") assertSessionContextScope(actor, { locationId: scope.locationId });
    if (actor.role === "manager" && target.home_location_id !== scope.locationId) throw httpError(403, "Die Abteilungsleitung gehört nicht zum eigenen Standort.");
  }
  if (actor.role === "manager" && target.role !== "department_manager") throw httpError(403, "Eine Filialleitung darf nur Abteilungsleitungen ihres Standorts zuweisen.");
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM portal_access_scopes WHERE employee_number = ?").run(employeeNumber);
    const insert = db.prepare("INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by) VALUES (?, ?, ?, ?)");
    for (const scope of scopes) insert.run(employeeNumber, scope.locationId, scope.departmentId || 0, actor.employeeNumber);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  revokeMobileSessionsForEmployee(employeeNumber, "scopes_changed");
  auditPortal(actor.employeeNumber, "portal.scope.update", "portal_user", employeeNumber, JSON.stringify(scopes));
  response.json({ users: portalUsersForActor(actor), roles: getPortalRoles() });
});

app.put("/api/portal/v1/users/:employeeNumber", async (request, response) => {
  const actor = requirePortalAdminOrLocal(request, "users:write");
  const employeeNumber = String(request.params.employeeNumber || "").trim();
  if (!db.prepare("SELECT 1 FROM employees WHERE personnel_number = ?").get(employeeNumber)) {
    throw httpError(404, "Das Teammitglied wurde nicht gefunden.");
  }
  const role = String(request.body.role || "employee");
  if (!db.prepare("SELECT 1 FROM portal_roles WHERE id = ?").get(role)) throw httpError(400, "Die ausgewählte Rolle ist ungültig.");
  if (role === "developer") {
    throw httpError(403, "Die Developer-Rolle kann ausschließlich mit dem lokalen Entwicklerwerkzeug gebunden werden.", "PORTAL_DEVELOPER_PROTECTED");
  }
  const existingUser = db.prepare("SELECT employee_number, role, role_locked, password_hash, must_change_password FROM portal_users WHERE employee_number = ?").get(employeeNumber);
  if (existingUser) {
    assertPortalUserIsMutable(existingUser, actor);
    if (!actorCanManagePortalRole(actor, existingUser.role)) {
      throw httpError(403, "Dieser Zugang liegt außerhalb der eigenen Verwaltungsebene.", "PORTAL_ROLE_HIERARCHY_DENIED");
    }
  }
  if (!actorCanAssignPortalRole(actor, role)) {
    throw httpError(403, role === "developer"
      ? "Die Developer-Rolle kann ausschließlich mit dem lokalen Entwicklerwerkzeug gebunden werden."
      : "Diese Rolle darf durch den aktuellen Zugang nicht vergeben werden.", role === "developer" ? "PORTAL_DEVELOPER_PROTECTED" : "PORTAL_ROLE_HIERARCHY_DENIED");
  }
  const password = String(request.body.password || "");
  const passwordHash = password ? await hashPortalPassword(password) : existingUser?.password_hash || "";
  const active = request.body.active !== false ? 1 : 0;
  const mustChangePassword = password
    ? Number(request.body.mustChangePassword !== false)
    : existingUser ? Number(Boolean(existingUser.must_change_password)) : Number(request.body.mustChangePassword !== false);
  if (existingUser?.role === "admin" && (role !== "admin" || !active)) {
    const otherSystemOwners = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM portal_users
      WHERE role IN ('developer','admin') AND active = 1 AND employee_number <> ?
    `).get(employeeNumber).count);
    if (!otherSystemOwners) throw httpError(409, "Mindestens ein aktiver Developer- oder Admin-Zugang muss bestehen bleiben.");
  }
  db.prepare(`
    INSERT INTO portal_users (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, CASE WHEN ? <> '' THEN CURRENT_TIMESTAMP ELSE NULL END, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = excluded.password_hash, role = excluded.role, active = excluded.active,
      must_change_password = excluded.must_change_password,
      password_changed_at = CASE WHEN ? <> '' THEN CURRENT_TIMESTAMP ELSE portal_users.password_changed_at END,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, passwordHash, role, active, mustChangePassword, password, password);
  if (!active || password) db.prepare("UPDATE portal_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE employee_number = ? AND revoked_at IS NULL").run(employeeNumber);
  revokeMobileSessionsForEmployee(employeeNumber, "account_changed");
  auditPortal(actor.employeeNumber, "portal.user.update", "portal_user", employeeNumber, JSON.stringify({ role, active: Boolean(active), passwordReset: Boolean(password) }));
  response.json({ users: portalUsersForAdmin(), roles: getPortalRoles() });
});

app.post("/api/portal/v1/users/:employeeNumber/unlock", (request, response) => {
  const actor = requirePortalAdminOrLocal(request, "users:write");
  const employeeNumber = String(request.params.employeeNumber || "").trim();
  const target = db.prepare("SELECT employee_number, role, role_locked FROM portal_users WHERE employee_number = ?").get(employeeNumber);
  assertPortalUserIsMutable(target, actor);
  if (!actorCanManagePortalRole(actor, target.role)) {
    throw httpError(403, "Dieser Zugang liegt außerhalb der eigenen Verwaltungsebene.", "PORTAL_ROLE_HIERARCHY_DENIED");
  }
  const result = db.prepare(`
    UPDATE portal_users SET failed_login_attempts = 0, locked_until = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = ?
  `).run(employeeNumber);
  if (!result.changes) throw httpError(404, "Der Zugang wurde nicht gefunden.");
  auditPortal(actor.employeeNumber, "portal.user.unlock", "portal_user", employeeNumber);
  response.json({ users: portalUsersForAdmin(), roles: getPortalRoles() });
});

app.get("/api/portal/v1/me", (request, response) => {
  const session = requirePortalSession(request);
  response.json({ user: publicPortalUser(session), branding: brandingForPortalSession(session) });
});

app.get("/api/portal/v1/me/home", (request, response) => {
  const session = requirePortalSession(request);
  response.json(mobileHomePayload(session, request, new Date()));
});

app.get("/api/mobile/v1/bootstrap", (request, response) => {
  const session = requireMobileSession(request, "", { allowPasswordChange: true });
  response.json(mobileBootstrapPayload(session, request, new Date()));
});

app.get("/api/mobile/v1/me/home", (request, response) => {
  const session = requireMobileSession(request);
  response.json(mobileHomePayload(session, request, new Date()));
});

app.get("/api/mobile/v1/me/settings", (request, response) => {
  const session = requireMobileSession(request);
  response.json(mobilePersonalSettingsPayload(session, new Date()));
});

app.post("/api/mobile/v1/me/password", async (request, response) => {
  const session = requireMobileSession(request, "", { allowPasswordChange: true });
  const current = db.prepare("SELECT password_hash FROM portal_users WHERE employee_number = ?").get(session.employeeNumber);
  if (!await verifyPortalPassword(request.body?.currentPassword, current?.password_hash)) {
    throw httpError(401, "Das bisherige Passwort ist nicht korrekt.", "MOBILE_PASSWORD_CURRENT_INVALID");
  }
  const passwordHash = await hashPortalPassword(request.body?.newPassword);
  let tokenSet;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      UPDATE portal_users SET password_hash = ?, must_change_password = 0,
        password_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE employee_number = ?
    `).run(passwordHash, session.employeeNumber);
    db.prepare("UPDATE portal_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE employee_number = ? AND revoked_at IS NULL").run(session.employeeNumber);
    revokeMobileSessionsForEmployee(session.employeeNumber, "password_changed", session.mobileSessionId);
    tokenSet = rotateAuthenticatedMobileSession(session.mobileSessionId, new Date());
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  auditPortal(session.employeeNumber, "mobile.password.change", "portal_user", session.employeeNumber);
  response.json({ ok: true, tokenSet });
});

app.get("/api/mobile/v1/me/schedule", (request, response) => {
  const session = requireMobileSession(request, "own_schedule:read");
  response.json(mobileSchedulePayload(session, String(request.query.week || "")));
});

app.put("/api/portal/v1/me/password", async (request, response) => {
  const session = requirePortalSession(request);
  assertPortalCsrf(request);
  const current = db.prepare("SELECT password_hash FROM portal_users WHERE employee_number = ?").get(session.employeeNumber);
  if (!await verifyPortalPassword(request.body.currentPassword, current?.password_hash)) {
    throw httpError(401, "Das bisherige Passwort ist nicht korrekt.");
  }
  const passwordHash = await hashPortalPassword(request.body.newPassword);
  db.prepare(`
    UPDATE portal_users SET password_hash = ?, must_change_password = 0,
      password_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = ?
  `).run(passwordHash, session.employeeNumber);
  revokeMobileSessionsForEmployee(session.employeeNumber, "password_changed");
  auditPortal(session.employeeNumber, "portal.password.change", "portal_user", session.employeeNumber);
  response.json({ ok: true });
});

app.get("/api/portal/v1/me/schedule", (request, response) => {
  const session = requirePortalSession(request, "own_schedule:read");
  const weekStart = getMonday(isIsoDate(request.query.week) ? request.query.week : currentWeekStart());
  const weekEnd = addDays(weekStart, 6);
  const shifts = db.prepare(`
    SELECT s.id, s.shift_date, s.start_time, s.end_time, s.area, s.note,
           d.name AS department_name
    FROM shifts s LEFT JOIN departments d ON d.id = s.department_id
    WHERE s.employee_number = ? AND s.shift_date BETWEEN ? AND ?
    ORDER BY s.shift_date, s.start_time
  `).all(session.employeeNumber, weekStart, weekEnd);
  const options = db.prepare(`
    SELECT id, date_from, date_to, option_type, note, all_day, start_time, end_time
    FROM week_options
    WHERE employee_number = ? AND date_from <= ? AND date_to >= ?
    ORDER BY date_from, id
  `).all(session.employeeNumber, weekEnd, weekStart);
  response.json({ weekStart, weekEnd, calendarWeek: getIsoWeek(weekStart), shifts, options, user: publicPortalUser(session) });
});

app.get(["/api/portal/v1/me/absence-history", "/api/portal/v1/me/absence-requests"], (request, response) => {
  const session = requirePortalSession(request, "own_vacation:read");
  response.json({ items: absenceHistoryForEmployee(session.employeeNumber) });
});

app.get("/api/portal/v1/me/notifications", (request, response) => {
  const session = requirePortalSession(request);
  const notifications = db.prepare(`
    SELECT id, event_type, title, message, target, entity_type, entity_id, read_at, created_at
    FROM portal_notifications WHERE recipient_employee_number = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 100
  `).all(session.employeeNumber).map((item) => ({ ...item, link: item.target, request_id: item.entity_id || null }));
  const unreadCount = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM portal_notifications
    WHERE recipient_employee_number = ? AND read_at IS NULL
  `).get(session.employeeNumber).count || 0);
  response.json({ notifications, unreadCount });
});

app.put("/api/portal/v1/me/notifications/:id/read", (request, response) => {
  const session = requirePortalSession(request);
  assertPortalCsrf(request);
  const result = db.prepare(`
    UPDATE portal_notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
    WHERE id = ? AND recipient_employee_number = ?
  `).run(String(request.params.id), session.employeeNumber);
  if (!result.changes) throw httpError(404, "Die Benachrichtigung wurde nicht gefunden.");
  response.json({ ok: true });
});

app.put("/api/portal/v1/me/notifications/read-all", (request, response) => {
  const session = requirePortalSession(request);
  assertPortalCsrf(request);
  const result = db.prepare(`
    UPDATE portal_notifications SET read_at = CURRENT_TIMESTAMP
    WHERE recipient_employee_number = ? AND read_at IS NULL
  `).run(session.employeeNumber);
  response.json({ ok: true, updated: Number(result.changes || 0) });
});

app.get("/api/portal/v1/me/sickness-notification-preferences", (request, response) => {
  const session = requirePortalSession(request, "notifications:settings");
  response.json(sicknessNotificationPreferences(session.employeeNumber));
});

app.put("/api/portal/v1/me/sickness-notification-preferences", (request, response) => {
  const session = requirePortalSession(request, "notifications:settings");
  assertPortalCsrf(request);
  response.json(saveSicknessNotificationPreferences(session.employeeNumber, request.body || {}));
});

app.post("/api/portal/v1/me/sickness-notification-preferences/verification", async (request, response) => {
  const session = requirePortalSession(request, "notifications:settings");
  assertPortalCsrf(request);
  response.json(await requestSicknessNotificationVerification(session.employeeNumber, request.body || {}));
});

app.post("/api/portal/v1/me/sickness-notification-preferences/verification/confirm", (request, response) => {
  const session = requirePortalSession(request, "notifications:settings");
  assertPortalCsrf(request);
  response.json(confirmSicknessNotificationVerification(session.employeeNumber, request.body || {}));
});

app.get("/api/portal/v1/me/sickness-cases", (request, response) => {
  const session = requirePortalSession(request, "own_sickness:read");
  response.json({ cases: ownSicknessCases(session.employeeNumber), policy: getAmuPolicy() });
});

app.post("/api/portal/v1/me/sickness-cases", (request, response) => {
  const session = requirePortalSession(request, "own_sickness:create");
  assertPortalCsrf(request);
  const startDate = String(request.body.startDate || "");
  const expectedEnd = String(request.body.expectedEnd || "");
  const note = stripEmoji(String(request.body.note || "").trim()).slice(0, 500);
  const today = viennaTodayIso();
  if (!isIsoDate(startDate) || startDate > today || startDate < addDays(today, -365)) {
    throw httpError(400, "Bitte ein gültiges Beginn-Datum bis einschließlich heute eingeben.", "SICKNESS_DATE_INVALID");
  }
  if (expectedEnd && (!isIsoDate(expectedEnd) || expectedEnd < startDate || expectedEnd > addDays(startDate, 365))) {
    throw httpError(400, "Das voraussichtliche Ende muss am oder nach dem Beginn liegen.", "SICKNESS_DATE_INVALID");
  }
  const overlapping = db.prepare(`
    SELECT * FROM sickness_cases
    WHERE employee_lookup = ? AND status_lookup IN (?, ?, ?)
    ORDER BY created_at DESC, id DESC
  `).all(
    sicknessEmployeeLookup(session.employeeNumber),
    sicknessStatusLookup("reported"),
    sicknessStatusLookup("aum_received"),
    sicknessStatusLookup("recovered"),
  ).find((row) => sicknessCaseLinksToRange(row, startDate, expectedEnd));
  if (overlapping) throw httpError(409, "Für diesen Zeitraum besteht bereits eine offene Krankmeldung.", "SICKNESS_CASE_OVERLAP");
  const context = employeeRequestContext(session.employeeNumber, startDate);
  const staffingRisk = evaluateSicknessStaffingRisk(session.employeeNumber, startDate, expectedEnd, context, { asOfDate: today });
  const effectiveContext = staffingRisk.contexts?.[0] || context;
  const policy = getAmuPolicy();
  const deadlines = sicknessDeadlineState({ startAt: startDate, asOf: new Date(), localDays: policy.localWarningDays, hrDays: policy.hrWarningDays });
  const reportedAt = new Date().toISOString();
  const employeeLookup = sicknessEmployeeLookup(session.employeeNumber);
  const purgeAfter = addDays(expectedEnd || startDate, sicknessCaseRetentionDays());
  let caseId;
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare(`
      INSERT INTO sickness_cases
        (employee_lookup, status_lookup, protected_payload, purge_after)
      VALUES (?, ?, '', ?)
    `).run(employeeLookup, sicknessStatusLookup("reported"), purgeAfter);
    caseId = Number(result.lastInsertRowid);
    const protectedPayload = protectJson({
      startDate,
      expectedEnd,
      note,
      employeeNumber: session.employeeNumber,
      locationId: effectiveContext.locationId,
      departmentId: effectiveContext.departmentId,
      status: "reported",
      reportedAt,
      aumReceivedAt: "",
      closedAt: "",
      returnToWorkDate: "",
      retentionUntil: purgeAfter,
      localDeadlineDate: deadlines.localDeadlineDate,
      hrDeadlineDate: deadlines.hrDeadlineDate,
      staffingRisk,
    }, sicknessCaseProtectionContext({ id: caseId, employee_lookup: employeeLookup }));
    db.prepare("UPDATE sickness_cases SET protected_payload = ? WHERE id = ?").run(protectedPayload, caseId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const row = sicknessCaseMetadata(caseId);
  const recipients = notifySicknessRecipients(row, {
    stage: "local",
    kind: "reported",
  });
  if (staffingRisk.atRisk) {
    const riskAlert = upsertSicknessAlert(caseId, "staffing_risk", "warning", "local");
    const riskRecipients = notifySicknessRecipients(row, {
      stage: "local",
      kind: "staffing",
    });
    if (riskAlert.created) queueExternalStaffingAlerts(row, riskRecipients, reportedAt);
  }
  auditPortal(`protected:${sicknessEmployeeLookup(session.employeeNumber)}`, "protected.record.create", "protected_record",
    protectedPortalEntityId("sickness-case", caseId), JSON.stringify({ staffingRisk: staffingRisk.atRisk, plannedShiftCount: staffingRisk.plannedShiftCount }));
  runSicknessEscalationSweep();
  response.status(201).json({ case: serializeSicknessCases([sicknessCaseMetadata(caseId)])[0] });
});

app.post("/api/portal/v1/me/sickness-cases/:id/withdraw", (request, response) => {
  const session = requirePortalSession(request, "own_sickness:create");
  assertPortalCsrf(request);
  const row = db.prepare(`
    SELECT * FROM sickness_cases WHERE id = ? AND employee_lookup = ? AND status_lookup = ?
  `).get(Number(request.params.id), sicknessEmployeeLookup(session.employeeNumber), sicknessStatusLookup("reported"));
  if (!row) throw httpError(404, "Die offene Krankmeldung wurde nicht gefunden.", "SICKNESS_CASE_NOT_FOUND");
  const payload = sicknessCasePayload(row);
  payload.status = "withdrawn";
  payload.closedAt = new Date().toISOString();
  payload.retentionUntil = addDays(viennaTodayIso(), 30);
  const result = db.prepare(`
    UPDATE sickness_cases SET status_lookup = ?, protected_payload = ?, purge_after = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status_lookup = ?
  `).run(sicknessStatusLookup("withdrawn"), protectJson(payload, sicknessCaseProtectionContext(row)), payload.retentionUntil,
    row.id, sicknessStatusLookup("reported"));
  if (!result.changes) throw httpError(409, "Die Krankmeldung wurde zwischenzeitlich bearbeitet.", "SICKNESS_CASE_ALREADY_UPDATED");
  resolveSicknessAlerts(row.id);
  db.prepare("UPDATE portal_notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP) WHERE entity_type = 'protected_record' AND entity_id = ?")
    .run(protectedPortalEntityId("sickness-case", row.id));
  db.prepare("UPDATE outbound_notification_jobs SET status = 'cancelled', purge_after = ?, updated_at = CURRENT_TIMESTAMP WHERE entity_lookup = ? AND status = 'pending'")
    .run(addDays(viennaTodayIso(), OUTBOUND_NOTIFICATION_CANCELLED_RETENTION_DAYS), sicknessOutboundEntityLookup(row.id));
  auditPortal(`protected:${sicknessEmployeeLookup(session.employeeNumber)}`, "protected.record.withdraw", "protected_record",
    protectedPortalEntityId("sickness-case", row.id));
  response.json({ ok: true });
});

app.post("/api/portal/v1/me/sickness-cases/:id/return-to-work", (request, response) => {
  const session = requirePortalSession(request, "own_sickness:create");
  assertPortalCsrf(request);
  const row = db.prepare(`
    SELECT * FROM sickness_cases
    WHERE id = ? AND employee_lookup = ? AND status_lookup IN (?, ?)
  `).get(Number(request.params.id), sicknessEmployeeLookup(session.employeeNumber),
    sicknessStatusLookup("reported"), sicknessStatusLookup("aum_received"));
  if (!row) throw httpError(404, "Die offene Krankmeldung wurde nicht gefunden.", "SICKNESS_CASE_NOT_FOUND");
  const payload = sicknessCasePayload(row);
  const returnDate = String(request.body.returnDate || "").trim();
  if (!isIsoDate(returnDate) || returnDate < payload.startDate || returnDate > addDays(viennaTodayIso(), 31)) {
    throw httpError(400, "Bitte ein gültiges Datum für die Wiederaufnahme der Arbeit eingeben.", "SICKNESS_RETURN_DATE_INVALID");
  }
  const closedAt = new Date().toISOString();
  const retentionUntil = addDays(returnDate, sicknessCaseRetentionDays());
  payload.status = "recovered";
  payload.returnToWorkDate = returnDate;
  payload.closedAt = closedAt;
  payload.retentionUntil = retentionUntil;
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare(`
      UPDATE sickness_cases SET status_lookup = ?, protected_payload = ?, purge_after = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND employee_lookup = ? AND status_lookup IN (?, ?)
    `).run(sicknessStatusLookup("recovered"), protectJson(payload, sicknessCaseProtectionContext(row)), retentionUntil,
      row.id, sicknessEmployeeLookup(session.employeeNumber), sicknessStatusLookup("reported"), sicknessStatusLookup("aum_received"));
    if (!result.changes) throw httpError(409, "Die Krankmeldung wurde zwischenzeitlich bearbeitet.", "SICKNESS_CASE_ALREADY_UPDATED");
    const linkedReports = db.prepare(`
      SELECT * FROM amu_reports WHERE sickness_case_id = ? AND status <> 'purged'
    `).all(row.id);
    const updateReport = db.prepare("UPDATE amu_reports SET protected_payload = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
    for (const report of linkedReports) {
      const reportPayload = parseProtectedJson(report.protected_payload, amuReportProtectionContext(report));
      reportPayload.retentionUntil = retentionUntil;
      updateReport.run(protectJson(reportPayload, amuReportProtectionContext(report)), report.id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  auditPortal(`protected:${sicknessEmployeeLookup(session.employeeNumber)}`, "protected.record.return-to-work", "protected_record",
    protectedPortalEntityId("sickness-case", row.id));
  const updatedCase = sicknessCaseMetadata(row.id);
  reconcileSicknessStaffingRisk(updatedCase);
  notifySicknessRecipients(updatedCase, { stage: "local", kind: "return_to_work" });
  runSicknessEscalationSweep();
  response.json({ case: serializeSicknessCases([updatedCase])[0] });
});

app.get("/api/portal/v1/sickness-cases", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "sickness:read");
  const rows = db.prepare("SELECT * FROM sickness_cases ORDER BY created_at DESC, id DESC").all().filter((row) => {
    if (sicknessCasePayload(row).status === "withdrawn") return false;
    try { assertSicknessCaseScope(session, row); return true; } catch { return false; }
  });
  const cases = serializeSicknessCases(rows, { includeNote: actorCanReadAmuSensitiveMetadata(session) });
  response.json({
    cases,
    pendingCount: cases.filter((entry) => entry.status === "reported" || ["yellow", "red", "warning"].includes(entry.severity)).length,
  });
});

app.get("/api/portal/v1/amu-settings", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "own_amu:read");
  response.json({
    policy: getAmuPolicy(),
    canChange: session.employeeNumber === "local" || ["admin", "hr"].includes(session.role) || session.permissions?.includes("hr:settings"),
  });
});

app.get("/api/portal/v1/greeting-settings", (request, response) => {
  requireAdminHrOrLocal(request, "hr:settings");
  response.json({ settings: portalGreetingSettings(), canChange: true });
});

app.put("/api/portal/v1/greeting-settings", (request, response) => {
  const actor = requireAdminHrOrLocal(request, "hr:settings");
  const settings = validatedPortalGreetingSettings(request.body || {});
  db.prepare(`
    INSERT INTO portal_settings (key, value, updated_at) VALUES ('personalized_greetings', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(JSON.stringify(settings));
  auditPortal(actor.employeeNumber, "portal.greetings.update", "portal_settings", "personalized_greetings",
    JSON.stringify({ enabled: settings.enabled, templateCounts: Object.fromEntries(Object.entries(settings.templates).map(([key, value]) => [key, value.length])) }));
  response.json({ settings, canChange: true });
});

app.put("/api/portal/v1/amu-settings", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "hr:settings");
  const policy = validateAmuPolicy(request.body || {});
  const entries = {
    amu_upload_max_mb: String(policy.uploadMaxMb),
    amu_stored_max_mb: String(policy.storedMaxMb),
    amu_convert_images_to_pdf: policy.convertImagesToPdf ? "1" : "0",
    amu_grayscale_images: policy.grayscaleImages ? "1" : "0",
    amu_ocr_enabled: policy.ocrEnabled ? "1" : "0",
    sickness_local_warning_days: String(policy.localWarningDays),
    sickness_hr_warning_days: String(policy.hrWarningDays),
  };
  const upsert = db.prepare(`
    INSERT INTO portal_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `);
  db.exec("BEGIN");
  try {
    for (const [key, value] of Object.entries(entries)) upsert.run(key, value);
    auditPortal(session.employeeNumber, "amu.settings.update", "portal_settings", "amu", JSON.stringify(policy));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  runSicknessEscalationSweep();
  response.json({ policy, canChange: true });
});

app.get("/api/portal/v1/personnel-records/:employeeNumber", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "amu:metadata:read");
  const employeeNumber = String(request.params.employeeNumber || "").trim();
  assertSessionEmployeeScope(session, employeeNumber);
  const employee = db.prepare(`
    SELECT e.personnel_number, e.full_name, e.nickname, e.color, e.home_location_id,
           e.preferred_department_id, l.name AS home_location_name, d.name AS preferred_department_name
    FROM employees e LEFT JOIN locations l ON l.id = e.home_location_id
    LEFT JOIN departments d ON d.id = e.preferred_department_id
    WHERE e.personnel_number = ?
  `).get(employeeNumber);
  if (!employee) throw httpError(404, "Das Teammitglied wurde nicht gefunden.", "EMPLOYEE_NOT_FOUND");
  let reports = db.prepare(`
    SELECT r.*, e.full_name, e.nickname, e.color, e.preferred_department_id,
           l.name AS location_name, d.name AS department_name
    FROM amu_reports r JOIN employees e ON e.personnel_number = r.employee_number
    JOIN locations l ON l.id = r.location_id LEFT JOIN departments d ON d.id = r.department_id
    WHERE r.employee_number = ? AND r.status <> 'purged'
    ORDER BY r.submitted_at DESC, r.id DESC
  `).all(employeeNumber);
  reports = reports.filter((report) => sessionCanAccessAmuReport(session, report));
  const serialized = serializeAmuReports(reports)
    .sort((left, right) => String(right.incapacity_from).localeCompare(String(left.incapacity_from)) || Number(right.id) - Number(left.id));
  const canOpenFiles = actorCanReadAmuFiles(session);
  if (!canOpenFiles) {
    for (const report of serialized) {
      report.employee_note = "";
      report.review_note = "";
      report.documents = report.documents.map(({ id, detected_mime, size, byte_size, scan_status, status, created_at }, index) => ({
        id, original_name: `Dokument ${index + 1}`, original_filename: `Dokument ${index + 1}`, detected_mime, size, byte_size,
        scan_status, status, created_at, content_access: false,
      }));
    }
  }
  auditPortal(session.employeeNumber, "personnel-record.view", "employee", employeeNumber, `entries=${serialized.length}`);
  response.json({ employee, reports: serialized, canOpenFiles });
});

app.get("/api/portal/v1/me/amu-reports", (request, response) => {
  const session = requirePortalSession(request, "own_amu:read");
  response.json({ reports: ownAmuReports(session.employeeNumber) });
});

function sicknessCaseLinksToRange(row, incapacityFrom, incapacityTo = "") {
  if (!row) return false;
  const reportEnd = incapacityTo || incapacityFrom;
  const payload = sicknessCasePayload(row);
  const caseEnd = payload.status === "recovered" && isIsoDate(payload.returnToWorkDate)
    ? addDays(payload.returnToWorkDate, -1)
    : isIsoDate(payload.expectedEnd) ? payload.expectedEnd : "9999-12-31";
  return payload.startDate <= reportEnd && caseEnd >= incapacityFrom;
}

function findLinkableSicknessCase(employeeNumber, incapacityFrom, incapacityTo = "") {
  return db.prepare(`
    SELECT * FROM sickness_cases
    WHERE employee_lookup = ? AND status_lookup IN (?, ?, ?)
    ORDER BY created_at DESC, id DESC
  `).all(
    sicknessEmployeeLookup(employeeNumber),
    sicknessStatusLookup("reported"),
    sicknessStatusLookup("aum_received"),
    sicknessStatusLookup("recovered"),
  ).find((row) => sicknessCaseLinksToRange(row, incapacityFrom, incapacityTo)) || null;
}

app.post("/api/portal/v1/me/amu-reports", async (request, response) => {
  const session = requirePortalSession(request, "own_amu:create");
  assertPortalCsrf(request);
  if (shutdownStarted) throw httpError(503, "Grabenplaner wird gerade sicher beendet. Bitte den Upload danach erneut versuchen.", "SERVER_SHUTTING_DOWN");
  const storage = requireAmuStorage();
  const policy = getAmuPolicy();
  const maxInputBytes = Math.round(policy.uploadMaxMb * 1024 * 1024);
  const maxStoredBytes = Math.round(policy.storedMaxMb * 1024 * 1024);
  const { fields, documents } = await parseAmuMultipart(request, {
    maxFileBytes: maxInputBytes,
    totalMaxBytes: (maxInputBytes * 3) + (1024 * 1024),
  });
  const incapacityFrom = String(fields.incapacityFrom || "").trim();
  const incapacityTo = String(fields.incapacityTo || "").trim();
  const employeeNote = stripEmoji(String(fields.employeeNote || "").trim()).slice(0, 500);
  const ocrAssisted = String(fields.ocrAssisted || "") === "1";
  const ocrConfirmed = String(fields.ocrConfirmed || "") === "1";
  if (!isIsoDate(incapacityFrom) || (incapacityTo && (!isIsoDate(incapacityTo) || incapacityTo < incapacityFrom))) {
    throw httpError(400, "Bitte einen gültigen Zeitraum der Arbeitsunfähigkeit eingeben.", "AMU_DATE_INVALID");
  }
  if (!documents.length || documents.length > 3) {
    throw httpError(400, "Bitte mindestens eine und höchstens drei PDF- oder Bilddateien auswählen.", "AMU_DOCUMENTS_REQUIRED");
  }
  if (ocrAssisted && !ocrConfirmed) {
    throw httpError(400, "Bitte die durch OCR vorgeschlagenen Datumswerte vor dem Upload bestätigen.", "AMU_OCR_CONFIRMATION_REQUIRED");
  }
  const requestedSicknessCaseId = Number(fields.sicknessCaseId || 0);
  let linkedSicknessCase = requestedSicknessCaseId > 0
    ? db.prepare(`
        SELECT * FROM sickness_cases WHERE id = ? AND employee_lookup = ? AND status_lookup IN (?, ?, ?)
      `).get(requestedSicknessCaseId, sicknessEmployeeLookup(session.employeeNumber),
        sicknessStatusLookup("reported"), sicknessStatusLookup("aum_received"), sicknessStatusLookup("recovered"))
    : null;
  if (requestedSicknessCaseId > 0 && !linkedSicknessCase) {
    throw httpError(404, "Die ausgewählte Krankmeldung wurde nicht gefunden.", "SICKNESS_CASE_NOT_FOUND");
  }
  if (linkedSicknessCase) {
    if (!sicknessCaseLinksToRange(linkedSicknessCase, incapacityFrom, incapacityTo)) {
      linkedSicknessCase = null;
    }
  }
  if (!linkedSicknessCase) {
    linkedSicknessCase = findLinkableSicknessCase(session.employeeNumber, incapacityFrom, incapacityTo);
  }
  let reportContext = employeeRequestContext(session.employeeNumber, incapacityFrom);
  const retentionDays = Math.min(3650, Math.max(30, Number(getPortalSettings().amu_retention_days || 730)));
  const saved = [];
  let createdSicknessCaseId = 0;
  let committed = false;
  amuMutationInProgress += 1;
  try {
    for (const document of documents) {
      const prepared = await prepareAmuDocument({
        buffer: document.buffer,
        originalName: document.originalName,
        convertImagesToPdf: policy.convertImagesToPdf,
        grayscale: policy.grayscaleImages,
        maxInputBytes,
        maxStoredBytes,
        scanOriginal: policy.convertImagesToPdf ? (input) => storage.scanBuffer(input) : null,
      });
      const stored = await storage.saveBuffer({
        buffer: prepared.buffer,
        originalName: prepared.originalFilename,
        maxBytes: maxStoredBytes,
      });
      saved.push({ ...stored, processing: prepared.processing, converted: prepared.converted, sourceMime: prepared.sourceMime });
    }
    db.exec("BEGIN");
    try {
      if (linkedSicknessCase) {
        const refreshedSicknessCase = db.prepare(`
          SELECT * FROM sickness_cases
          WHERE id = ? AND employee_lookup = ? AND status_lookup IN (?, ?, ?)
        `).get(linkedSicknessCase.id, sicknessEmployeeLookup(session.employeeNumber),
          sicknessStatusLookup("reported"), sicknessStatusLookup("aum_received"), sicknessStatusLookup("recovered"));
        if (!refreshedSicknessCase) {
          throw httpError(409, "Die ausgewählte Krankmeldung wurde zwischenzeitlich bearbeitet.", "SICKNESS_CASE_ALREADY_UPDATED");
        }
        linkedSicknessCase = sicknessCaseLinksToRange(refreshedSicknessCase, incapacityFrom, incapacityTo)
          ? refreshedSicknessCase
          : null;
      }
      if (!linkedSicknessCase) {
        // Dateiverarbeitung findet vor der Transaktion statt. Deshalb innerhalb der
        // Transaktion erneut verknüpfen, falls parallel bereits ein Fall angelegt wurde.
        linkedSicknessCase = findLinkableSicknessCase(session.employeeNumber, incapacityFrom, incapacityTo);
      }
      let linkedPayload = linkedSicknessCase ? sicknessCasePayload(linkedSicknessCase) : null;
      if (linkedPayload) {
        reportContext = {
          ...reportContext,
          locationId: linkedPayload.locationId || reportContext.locationId,
          departmentId: Number(linkedPayload.departmentId || 0) || null,
        };
      }
      if (!linkedSicknessCase) {
        const reportedAt = new Date().toISOString();
        const staffingRisk = evaluateSicknessStaffingRisk(session.employeeNumber, incapacityFrom, incapacityTo, reportContext,
          { asOfDate: viennaTodayIso() });
        const effectiveContext = staffingRisk.contexts?.[0] || reportContext;
        reportContext = {
          ...reportContext,
          locationId: effectiveContext.locationId,
          departmentId: effectiveContext.departmentId,
        };
        const policy = getAmuPolicy();
        const deadlines = sicknessDeadlineState({
          startAt: incapacityFrom,
          asOf: new Date(),
          localDays: policy.localWarningDays,
          hrDays: policy.hrWarningDays,
        });
        const employeeLookup = sicknessEmployeeLookup(session.employeeNumber);
        const purgeAfter = addDays(incapacityTo || incapacityFrom, sicknessCaseRetentionDays());
        const caseResult = db.prepare(`
          INSERT INTO sickness_cases (employee_lookup, status_lookup, protected_payload, purge_after)
          VALUES (?, ?, '', ?)
        `).run(employeeLookup, sicknessStatusLookup("aum_received"), purgeAfter);
        createdSicknessCaseId = Number(caseResult.lastInsertRowid);
        linkedPayload = {
          startDate: incapacityFrom,
          expectedEnd: incapacityTo,
          note: "",
          employeeNumber: session.employeeNumber,
          locationId: effectiveContext.locationId,
          departmentId: effectiveContext.departmentId,
          status: "aum_received",
          reportedAt,
          aumReceivedAt: reportedAt,
          closedAt: "",
          returnToWorkDate: "",
          retentionUntil: purgeAfter,
          localDeadlineDate: deadlines.localDeadlineDate,
          hrDeadlineDate: deadlines.hrDeadlineDate,
          staffingRisk,
        };
        db.prepare("UPDATE sickness_cases SET protected_payload = ? WHERE id = ?").run(protectJson(linkedPayload,
          sicknessCaseProtectionContext({ id: createdSicknessCaseId, employee_lookup: employeeLookup })), createdSicknessCaseId);
        linkedSicknessCase = sicknessCaseMetadata(createdSicknessCaseId);
      }
      const reportRetentionBase = incapacityTo
        || (linkedPayload?.status === "recovered" ? linkedPayload.returnToWorkDate : "");
      const reportResult = db.prepare(`
        INSERT INTO amu_reports
          (sickness_case_id, employee_number, location_id, department_id, incapacity_from, incapacity_to, employee_note, status, retention_until, protected_payload)
        VALUES (?, ?, ?, ?, '', '', '', 'submitted', NULL, '')
      `).run(linkedSicknessCase?.id || null, session.employeeNumber, reportContext.locationId, reportContext.departmentId);
      const reportId = Number(reportResult.lastInsertRowid);
      const reportPayload = storage.protectRecord(JSON.stringify({
        incapacityFrom,
        incapacityTo,
        employeeNote,
        reviewedBy: "",
        reviewedAt: "",
        reviewNote: "",
        retentionUntil: isIsoDate(reportRetentionBase) ? addDays(reportRetentionBase, retentionDays) : "",
        withdrawnAt: "",
      }), amuReportProtectionContext({ id: reportId, employee_number: session.employeeNumber }));
      db.prepare("UPDATE amu_reports SET protected_payload = ? WHERE id = ?").run(reportPayload, reportId);
      const insertDocument = db.prepare(`
        INSERT INTO amu_documents
          (id, report_id, storage_key, original_filename, detected_mime, byte_size, sha256, scan_status,
           encryption_key_id, encryption_iv, encryption_tag, status, uploaded_by, protected_payload)
        VALUES (?, ?, ?, '', 'application/octet-stream', 0, '', ?, ?, '', '', 'active', '', ?)
      `);
      for (const item of saved) {
        const documentId = crypto.randomUUID();
        const documentPayload = storage.protectRecord(JSON.stringify({
          originalFilename: item.originalFilename,
          detectedMime: item.detectedMime,
          byteSize: item.byteSize,
          sha256: item.sha256,
          uploadedBy: session.employeeNumber,
        }), amuDocumentProtectionContext({ id: documentId, employee_number: session.employeeNumber }));
        insertDocument.run(documentId, reportId, item.storageKey, item.scanStatus, item.encryptionKeyId, documentPayload);
        auditPortal(session.employeeNumber, "amu.document.upload", "amu_document", documentId,
          JSON.stringify({ reportId, mime: item.detectedMime, sourceMime: item.sourceMime, converted: item.converted, size: item.byteSize, scan: item.scanStatus, processing: item.processing }));
      }
      if (linkedSicknessCase) {
        const sicknessPayload = linkedPayload;
        sicknessPayload.startDate = sicknessPayload.startDate && sicknessPayload.startDate < incapacityFrom
          ? sicknessPayload.startDate : incapacityFrom;
        if (incapacityTo) {
          sicknessPayload.expectedEnd = sicknessPayload.expectedEnd && sicknessPayload.expectedEnd > incapacityTo
            ? sicknessPayload.expectedEnd : incapacityTo;
        }
        const contradictsReportedReturn = sicknessPayload.status === "recovered"
          && isIsoDate(sicknessPayload.returnToWorkDate) && incapacityTo && incapacityTo >= sicknessPayload.returnToWorkDate;
        if (contradictsReportedReturn) {
          sicknessPayload.returnToWorkDate = "";
          sicknessPayload.closedAt = "";
        }
        const nextStatus = sicknessPayload.status === "recovered" && !contradictsReportedReturn ? "recovered" : "aum_received";
        sicknessPayload.status = nextStatus;
        sicknessPayload.aumReceivedAt = new Date().toISOString();
        const sicknessRetentionBase = sicknessPayload.returnToWorkDate || sicknessPayload.expectedEnd
          || incapacityTo || sicknessPayload.startDate;
        sicknessPayload.retentionUntil = addDays(sicknessRetentionBase, sicknessCaseRetentionDays());
        db.prepare(`
          UPDATE sickness_cases SET status_lookup = ?, protected_payload = ?, purge_after = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(sicknessStatusLookup(nextStatus), protectJson(sicknessPayload, sicknessCaseProtectionContext(linkedSicknessCase)),
          sicknessPayload.retentionUntil, linkedSicknessCase.id);
      }
      auditPortal(session.employeeNumber, "amu.report.create", "amu_report", String(reportId), JSON.stringify({ locationId: reportContext.locationId, documentCount: saved.length }));
      db.exec("COMMIT");
      committed = true;
      if (createdSicknessCaseId) {
        auditPortal(`protected:${sicknessEmployeeLookup(session.employeeNumber)}`, "protected.record.create", "protected_record",
          protectedPortalEntityId("sickness-case", createdSicknessCaseId), JSON.stringify({ source: "direct_aum" }));
        notifySicknessRecipients(sicknessCaseMetadata(createdSicknessCaseId), { stage: "local", kind: "reported" });
      }
      if (linkedSicknessCase) {
        const overdueKinds = ["aum_overdue_local", "aum_overdue_hr"];
        resolveSicknessAlerts(linkedSicknessCase.id, overdueKinds);
        markSicknessNotificationsRead(linkedSicknessCase.id, overdueKinds);
      }
      if (linkedSicknessCase && sicknessCasePayload(sicknessCaseMetadata(linkedSicknessCase.id)).status !== "recovered") {
        reconcileSicknessStaffingRisk(sicknessCaseMetadata(linkedSicknessCase.id));
      }
      const report = amuReportMetadata(reportId);
      const recipients = new Set([
        ...requestReviewerRecipients(reportContext.locationId, reportContext.departmentId, "local", session.employeeNumber),
        ...requestReviewerRecipients(reportContext.locationId, reportContext.departmentId, "hr", session.employeeNumber),
      ]);
      for (const recipient of recipients) {
        createPortalNotification(recipient, "protected.update", "Neue geschützte Meldung", "Bitte im geschützten Portal anmelden.", {
          target: "/portal.html?tab=leadershipApprovals",
          entityType: "protected_record",
          entityId: protectedPortalEntityId("amu-report", reportId),
          dedupeKey: protectedPortalDedupeKey(["amu", reportId, "submitted", recipient]),
        });
      }
      response.status(201).json({ report: serializeAmuReports([report])[0] });
    } catch (error) {
      if (!committed) db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    if (!committed) {
      for (const item of saved) {
        try { storage.deleteBlob(item.storageKey); } catch {}
      }
    }
    if (error.code?.startsWith?.("AMU_")) {
      const status = error.code.includes("TOO_LARGE") || error.code.includes("LIMIT")
        ? 413
        : error.code.includes("TYPE") || error.code.includes("HEIC") ? 415 : 400;
      throw httpError(status, error.message, error.code);
    }
    throw error;
  } finally {
    amuMutationInProgress = Math.max(0, amuMutationInProgress - 1);
  }
});

app.post("/api/portal/v1/me/amu-reports/:id/withdraw", (request, response) => {
  const session = requirePortalSession(request, "own_amu:withdraw");
  assertPortalCsrf(request);
  const report = db.prepare(`
    SELECT * FROM amu_reports WHERE id = ? AND employee_number = ? AND status IN ('submitted','returned')
  `).get(Number(request.params.id), session.employeeNumber);
  if (!report) throw httpError(404, "Die offene Arbeitsunfähigkeitsmeldung wurde nicht gefunden.", "AMU_REPORT_NOT_FOUND");
  const protectedPayload = parseProtectedJson(report.protected_payload, amuReportProtectionContext(report));
  protectedPayload.withdrawnAt = new Date().toISOString();
  protectedPayload.retentionUntil = addDays(viennaTodayIso(), 30);
  db.exec("BEGIN");
  try {
    db.prepare(`
      UPDATE amu_reports SET status = 'withdrawn', protected_payload = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(protectJson(protectedPayload, amuReportProtectionContext(report)), report.id);
    db.prepare("UPDATE amu_documents SET status = 'deleted', deleted_by = ?, deleted_at = CURRENT_TIMESTAMP WHERE report_id = ? AND status = 'active'")
      .run(session.employeeNumber, report.id);
    auditPortal(session.employeeNumber, "amu.report.withdraw", "amu_report", String(report.id));
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  db.prepare("UPDATE portal_notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP) WHERE entity_type = 'protected_record' AND entity_id = ?")
    .run(protectedPortalEntityId("amu-report", report.id));
  if (report.sickness_case_id) {
    const remaining = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM amu_reports
      WHERE sickness_case_id = ? AND id <> ? AND status NOT IN ('withdrawn','purged')
    `).get(report.sickness_case_id, report.id).count || 0);
    if (!remaining) {
      const linked = sicknessCaseMetadata(report.sickness_case_id);
      if (linked && ["aum_received", "recovered"].includes(sicknessCasePayload(linked).status)) {
        const linkedPayload = sicknessCasePayload(linked);
        if (linkedPayload.status === "aum_received") linkedPayload.status = "reported";
        linkedPayload.aumReceivedAt = "";
        db.prepare("UPDATE sickness_cases SET status_lookup = ?, protected_payload = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(sicknessStatusLookup(linkedPayload.status), protectJson(linkedPayload, sicknessCaseProtectionContext(linked)), linked.id);
      }
      runSicknessEscalationSweep();
    }
  }
  response.json({ ok: true });
});

app.get("/api/portal/v1/me/amu-reports/:reportId/documents/:documentId/content", (request, response) => {
  const session = requirePortalSession(request, "own_amu:read");
  const document = amuDocumentMetadata(request.params.reportId, request.params.documentId);
  if (!document || document.employee_number !== session.employeeNumber || document.report_status === "withdrawn") {
    auditPortal(session.employeeNumber, "amu.document.access.denied", "amu_document", String(request.params.documentId));
    throw httpError(404, "Das AUM-Dokument wurde nicht gefunden.", "AMU_DOCUMENT_NOT_FOUND");
  }
  auditPortal(session.employeeNumber, "amu.document.download", "amu_document", document.id);
  sendAmuDocument(response, document);
});

app.get("/api/portal/v1/amu-reports", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "amu:metadata:read");
  const rows = db.prepare(`
    SELECT r.*, e.full_name, e.nickname, e.color, e.preferred_department_id, l.name AS location_name,
           d.name AS department_name
    FROM amu_reports r JOIN employees e ON e.personnel_number = r.employee_number
    JOIN locations l ON l.id = r.location_id LEFT JOIN departments d ON d.id = r.department_id
    WHERE r.status <> 'purged'
    ORDER BY r.submitted_at DESC, r.id DESC
  `).all();
  const scopedRows = rows.filter((row) => sessionCanAccessAmuReport(session, row));
  const reports = serializeAmuReports(scopedRows);
  const canOpenFiles = actorCanReadAmuFiles(session);
  if (!canOpenFiles) {
    for (const report of reports) {
      report.employee_note = "";
      report.review_note = "";
      report.documents = report.documents.map(({ id, detected_mime, size, byte_size, scan_status, status, created_at }, index) => ({
        id, original_name: `Dokument ${index + 1}`, original_filename: `Dokument ${index + 1}`, detected_mime, size, byte_size, scan_status, status, created_at, content_access: false,
      }));
    }
  }
  response.json({ reports, pendingCount: reports.filter((item) => item.status === "submitted").length, canOpenFiles });
});

app.put("/api/portal/v1/amu-reports/:id/review", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "amu:review");
  const report = amuReportMetadata(request.params.id);
  assertAmuReportScope(session, report);
  if (!report || !["submitted", "returned"].includes(report.status)) throw httpError(409, "Diese Arbeitsunfähigkeitsmeldung ist bereits abgeschlossen.");
  const action = String(request.body.action || "reviewed");
  if (action !== "reviewed") throw httpError(400, "Bitte die Arbeitsunfähigkeitsmeldung als geprüft markieren.");
  const note = stripEmoji(String(request.body.note || "").trim()).slice(0, 500);
  const protectedPayload = parseProtectedJson(report.protected_payload, amuReportProtectionContext(report));
  protectedPayload.reviewedBy = session.employeeNumber;
  protectedPayload.reviewedAt = new Date().toISOString();
  protectedPayload.reviewNote = note;
  db.prepare(`
    UPDATE amu_reports SET status = ?, protected_payload = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(action, protectJson(protectedPayload, amuReportProtectionContext(report)), report.id);
  auditPortal(session.employeeNumber, `amu.report.${action}`, "amu_report", String(report.id));
  db.prepare("UPDATE portal_notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP) WHERE entity_type = 'protected_record' AND entity_id = ?")
    .run(protectedPortalEntityId("amu-report", report.id));
  createPortalNotification(report.employee_number, "protected.update", "Geschützte Meldung aktualisiert", "Bitte im geschützten Portal anmelden.", {
    target: "/portal.html?tab=amu",
    entityType: "protected_record",
    entityId: protectedPortalEntityId("amu-report", report.id),
    dedupeKey: protectedPortalDedupeKey(["amu", report.id, action, session.employeeNumber]),
  });
  response.json({ report: serializeAmuReports([amuReportMetadata(report.id)])[0] });
});

app.get("/api/portal/v1/amu-reports/:reportId/documents/:documentId/content", (request, response) => {
  const session = requirePortalReadOrLocal(request, "");
  if (!actorCanReadAmuSensitiveMetadata(session) || !actorCanReadAmuFiles(session)) {
    auditPortal(session.employeeNumber, "amu.document.access.denied", "amu_document", String(request.params.documentId), "missing-protected-file-right");
    throw httpError(403, "AUM-Dateien dürfen von diesem Zugang nicht geöffnet werden.", "PORTAL_PERMISSION_DENIED");
  }
  const document = amuDocumentMetadata(request.params.reportId, request.params.documentId);
  if (!document) {
    auditPortal(session.employeeNumber, "amu.document.access.denied", "amu_document", String(request.params.documentId), "not-found");
    throw httpError(404, "Das AUM-Dokument wurde nicht gefunden.", "AMU_DOCUMENT_NOT_FOUND");
  }
  assertAmuReportScope(session, document);
  auditPortal(session.employeeNumber, "amu.document.download", "amu_document", document.id);
  sendAmuDocument(response, document);
});

app.delete("/api/portal/v1/amu-reports/:reportId/documents/:documentId", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "amu:delete");
  const document = amuDocumentMetadata(request.params.reportId, request.params.documentId);
  if (!document) throw httpError(404, "Das AUM-Dokument wurde nicht gefunden.", "AMU_DOCUMENT_NOT_FOUND");
  assertAmuReportScope(session, document);
  amuMutationInProgress += 1;
  try {
    db.prepare("UPDATE amu_documents SET status = 'deleted', deleted_by = ?, deleted_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(session.employeeNumber, document.id);
    try {
      requireAmuStorage().deleteBlob(document.storage_key);
    } catch (error) {
      db.prepare("UPDATE amu_documents SET status = 'active', deleted_by = NULL, deleted_at = NULL WHERE id = ?").run(document.id);
      throw error;
    }
    db.prepare("UPDATE amu_documents SET status = 'purged', original_filename = '', protected_payload = '', purged_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(document.id);
    auditPortal(session.employeeNumber, "amu.document.delete", "amu_document", document.id);
  } finally {
    amuMutationInProgress = Math.max(0, amuMutationInProgress - 1);
  }
  response.status(204).end();
});

app.post("/api/portal/v1/me/vacation-check", (request, response) => {
  const session = requirePortalSession(request, "own_vacation:request");
  assertPortalCsrf(request);
  response.json(evaluateVacationRequest(session.employeeNumber, request.body));
});

app.post("/api/portal/v1/me/time-off-check", (request, response) => {
  const session = requirePortalSession(request, "own_time:write");
  assertPortalCsrf(request);
  response.json(evaluateTimeOffRequest(session.employeeNumber, request.body));
});

app.get("/api/portal/v1/me/time-off-slots", (request, response) => {
  const session = requirePortalSession(request, "own_time:read");
  const date = String(request.query.date || "");
  if (!isIsoDate(date)) throw httpError(400, "Bitte zuerst ein gültiges Datum auswählen.");
  const context = employeeRequestContext(session.employeeNumber, date);
  const settings = settingsForLocation(context.locationId);
  const hours = operatingHours(date, settings);
  const block = getGlobalDayBlockForDate(date, context.locationId);
  if (!hours || block) {
    response.json({ date, closed: true, reason: block?.reason || block?.holiday_name || "An diesem Tag ist die Filiale geschlossen.", startTimes: [], endTimes: [] });
    return;
  }
  const values = [];
  for (let minute = timeToMinutes(hours.start); minute <= timeToMinutes(hours.end); minute += 15) values.push(minutesToTime(minute));
  response.json({ date, closed: false, start: hours.start, end: hours.end, startTimes: values.slice(0, -1), endTimes: values.slice(1) });
});

app.get("/api/portal/v1/me/time-off-requests", (request, response) => {
  const session = requirePortalSession(request, "own_time:read");
  const requests = db.prepare(`
    SELECT id, request_date, COALESCE(date_from, request_date) AS date_from, COALESCE(date_to, request_date) AS date_to,
           all_day, start_time, end_time, note, status, approval_type, approval_stage,
           traffic_light, check_reason, decision_note, local_approved_by, local_approved_at,
           hr_approved_by, hr_approved_at, decided_by, decided_at, created_at, updated_at
    FROM time_off_requests WHERE employee_number = ?
      AND (status IN ('pending','pending_local','preliminary_local','pending_hr') OR COALESCE(date_to, request_date) >= ?)
    ORDER BY COALESCE(date_from, request_date) DESC, created_at DESC
  `).all(session.employeeNumber, addMonths(viennaTodayIso(), -6));
  response.json({ requests });
});

app.post("/api/portal/v1/me/time-off-requests", (request, response) => {
  const session = requirePortalSession(request, "own_time:write");
  assertPortalCsrf(request);
  const check = evaluateTimeOffRequest(session.employeeNumber, request.body);
  if (!check.allowed) throw httpError(409, check.reason, "TIME_OFF_NOT_POSSIBLE");
  const date = String(request.body.date || request.body.requestDate || request.body.dateFrom || "");
  const dateTo = String(request.body.dateTo || date);
  const allDay = request.body.allDay === true || dateTo !== date;
  const startTime = allDay ? "00:00" : String(request.body.startTime || "");
  const endTime = allDay ? "23:59" : String(request.body.endTime || "");
  const note = stripEmoji(String(request.body.note || "").trim()).slice(0, 500);
  const approvalType = request.body.approvalType === "hr" ? "hr" : "local";
  const locationId = employeeRequestContext(session.employeeNumber, date).locationId;
  const result = db.prepare(`
    INSERT INTO time_off_requests
      (employee_number, location_id, request_date, date_from, date_to, all_day, start_time, end_time, note, approval_type, approval_stage, status, traffic_light, check_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', 'pending_local', ?, ?)
  `).run(session.employeeNumber, locationId, date, date, dateTo, allDay ? 1 : 0, startTime, endTime, note, approvalType, check.trafficLight, check.reason);
  auditPortal(session.employeeNumber, "time_off.request.create", "time_off_request", String(result.lastInsertRowid), JSON.stringify(check));
  notifyRequestReviewers({ id: Number(result.lastInsertRowid), employee_number: session.employeeNumber, location_id: locationId }, "time_off", "local", session.employeeNumber);
  response.status(201).json({ id: Number(result.lastInsertRowid), status: "pending", check });
});

app.put("/api/portal/v1/me/time-off-requests/:id", (request, response) => {
  const session = requirePortalSession(request, "own_time:write");
  assertPortalCsrf(request);
  const entry = db.prepare("SELECT * FROM time_off_requests WHERE id = ? AND employee_number = ? AND status IN ('pending','pending_local','preliminary_local','pending_hr')")
    .get(Number(request.params.id), session.employeeNumber);
  if (!entry) throw httpError(404, "Der offene ZA-Antrag wurde nicht gefunden.");
  const check = evaluateTimeOffRequest(session.employeeNumber, { ...request.body, excludeRequestId: entry.id });
  if (!check.allowed) throw httpError(409, check.reason, "TIME_OFF_NOT_POSSIBLE");
  const dateFrom = String(request.body.date || request.body.dateFrom || "");
  const dateTo = String(request.body.dateTo || dateFrom);
  const allDay = request.body.allDay === true || dateTo !== dateFrom;
  const startTime = allDay ? "00:00" : String(request.body.startTime || "");
  const endTime = allDay ? "23:59" : String(request.body.endTime || "");
  const note = stripEmoji(String(request.body.note || "").trim()).slice(0, 500);
  const approvalType = request.body.approvalType === "hr" ? "hr" : "local";
  db.prepare(`UPDATE time_off_requests SET request_date = ?, date_from = ?, date_to = ?, all_day = ?, start_time = ?, end_time = ?, note = ?, approval_type = ?,
      status = 'pending_local', approval_stage = 'local', traffic_light = ?, check_reason = ?, decision_note = '', local_approved_by = NULL,
      local_approved_at = NULL, hr_approved_by = NULL, hr_approved_at = NULL, decided_by = NULL, decided_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(dateFrom, dateFrom, dateTo, allDay ? 1 : 0, startTime, endTime, note, approvalType, check.trafficLight, check.reason, entry.id);
  recordRequestDecision("time_off", entry.id, "employee", "change", session.employeeNumber, note);
  resolveRequestReviewNotifications("time_off", entry.id);
  notifyRequestReviewers({ ...entry, location_id: entry.location_id }, "time_off", "local", session.employeeNumber);
  response.json({ id: entry.id, status: "pending", check });
});

app.delete("/api/portal/v1/me/time-off-requests/:id", (request, response) => {
  const session = requirePortalSession(request, "own_time:write");
  assertPortalCsrf(request);
  const entry = db.prepare("SELECT * FROM time_off_requests WHERE id = ? AND employee_number = ? AND status IN ('pending','pending_local','preliminary_local','pending_hr')")
    .get(Number(request.params.id), session.employeeNumber);
  if (!entry) throw httpError(404, "Der offene ZA-Antrag wurde nicht gefunden.");
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE time_off_requests SET status = 'withdrawn', approval_stage = 'complete', decided_by = ?, decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(session.employeeNumber, entry.id);
    recordRequestDecision("time_off", entry.id, "employee", "withdraw", session.employeeNumber, "");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  resolveRequestReviewNotifications("time_off", entry.id);
  auditPortal(session.employeeNumber, "time_off.request.withdraw", "time_off_request", request.params.id);
  response.status(204).end();
});

app.get("/api/portal/v1/me/approved-time-off", (request, response) => {
  const session = requirePortalSession(request, "own_time:read");
  const requests = db.prepare(`
    SELECT id, request_date, COALESCE(date_from, request_date) AS date_from,
           COALESCE(date_to, request_date) AS date_to, all_day, start_time, end_time,
           note, approval_type, local_approved_by, hr_approved_by, decided_by, decided_at
    FROM time_off_requests
    WHERE employee_number = ? AND status = 'approved' AND COALESCE(date_to, request_date) >= ?
    ORDER BY COALESCE(date_from, request_date), start_time, id
  `).all(session.employeeNumber, viennaTodayIso());
  const pendingChanges = db.prepare(`
    SELECT id, original_request_id, request_type, requested_date_from, requested_date_to,
           requested_all_day, requested_start_time, requested_end_time, note, status, created_at
    FROM time_off_change_requests
    WHERE employee_number = ? AND status IN ('pending','pending_local','preliminary_local','pending_hr')
    ORDER BY created_at DESC
  `).all(session.employeeNumber);
  response.json({ requests, pendingChanges });
});

app.post("/api/portal/v1/me/time-off-change-requests", (request, response) => {
  const session = requirePortalSession(request, "own_time:write");
  assertPortalCsrf(request);
  const originalRequestId = Number(request.body.requestId || request.body.originalRequestId || 0);
  const requestType = String(request.body.requestType || "");
  if (!Number.isInteger(originalRequestId) || !["change", "cancel"].includes(requestType)) {
    throw httpError(400, "Bitte eine gültige ZA-Änderung auswählen.");
  }
  const original = db.prepare(`SELECT * FROM time_off_requests
    WHERE id = ? AND employee_number = ? AND status = 'approved' AND COALESCE(date_to, request_date) >= ?`)
    .get(originalRequestId, session.employeeNumber, viennaTodayIso());
  if (!original) throw httpError(404, "Der genehmigte Zeitausgleich wurde nicht gefunden.");
  const pending = db.prepare(`SELECT id FROM time_off_change_requests
    WHERE original_request_id = ? AND status IN ('pending','pending_local','preliminary_local','pending_hr') LIMIT 1`)
    .get(original.id);
  if (pending) throw httpError(409, "Für diesen Zeitausgleich besteht bereits ein offener Änderungs- oder Stornoantrag.");

  let dateFrom = null;
  let dateTo = null;
  let allDay = false;
  let startTime = null;
  let endTime = null;
  if (requestType === "change") {
    dateFrom = String(request.body.dateFrom || request.body.date || "");
    dateTo = String(request.body.dateTo || dateFrom);
    allDay = request.body.allDay === true || dateTo !== dateFrom;
    startTime = allDay ? "00:00" : String(request.body.startTime || "");
    endTime = allDay ? "23:59" : String(request.body.endTime || "");
    const check = evaluateTimeOffRequest(session.employeeNumber, {
      date: dateFrom, dateFrom, dateTo, allDay, startTime, endTime, excludeRequestId: original.id,
    });
    if (!check.allowed) throw httpError(409, check.reason, "TIME_OFF_NOT_POSSIBLE");
  }
  const note = stripEmoji(String(request.body.note || "").trim()).slice(0, 500);
  const result = db.prepare(`INSERT INTO time_off_change_requests
      (employee_number, location_id, original_request_id, request_type,
       requested_date_from, requested_date_to, requested_all_day, requested_start_time,
       requested_end_time, note, status, approval_type, approval_stage)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_local', ?, 'local')`)
    .run(session.employeeNumber, original.location_id, original.id, requestType, dateFrom, dateTo,
      allDay ? 1 : 0, startTime, endTime, note, original.approval_type || "local");
  const id = Number(result.lastInsertRowid);
  recordRequestDecision("time_off_change", id, "employee", requestType, session.employeeNumber, note);
  auditPortal(session.employeeNumber, `time_off.${requestType}.request`, "time_off_change_request", String(id));
  notifyRequestReviewers({ id, employee_number: session.employeeNumber, location_id: original.location_id }, "time_off_change", "local", session.employeeNumber);
  response.status(201).json({ id, status: "pending" });
});

app.delete("/api/portal/v1/me/time-off-change-requests/:id", (request, response) => {
  const session = requirePortalSession(request, "own_time:write");
  assertPortalCsrf(request);
  const entry = db.prepare(`SELECT * FROM time_off_change_requests
    WHERE id = ? AND employee_number = ? AND status IN ('pending','pending_local','preliminary_local','pending_hr')`)
    .get(Number(request.params.id), session.employeeNumber);
  if (!entry) throw httpError(404, "Der offene Änderungs- oder Stornoantrag wurde nicht gefunden.");
  db.prepare(`UPDATE time_off_change_requests SET status = 'withdrawn', approval_stage = 'complete',
    decided_by = ?, decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(session.employeeNumber, entry.id);
  recordRequestDecision("time_off_change", entry.id, "employee", "withdraw", session.employeeNumber, "");
  resolveRequestReviewNotifications("time_off_change", entry.id);
  auditPortal(session.employeeNumber, "time_off.change_request.withdraw", "time_off_change_request", String(entry.id));
  response.status(204).end();
});

app.get("/api/portal/v1/me/approved-vacations", (request, response) => {
  const session = requirePortalSession(request, "own_vacation:read");
  const vacations = approvedVacationsForEmployee(session.employeeNumber, viennaTodayIso());
  const pendingChanges = db.prepare(`
    SELECT id, vacation_group_id, request_type, original_date_from, original_date_to,
           requested_date_from, requested_date_to, note, status, created_at
    FROM vacation_change_requests WHERE employee_number = ? AND status IN ('pending','pending_local','preliminary_local','pending_hr')
    ORDER BY created_at DESC
  `).all(session.employeeNumber);
  response.json({ vacations, pendingChanges });
});

app.post("/api/portal/v1/me/vacation-change-requests", (request, response) => {
  const session = requirePortalSession(request, "own_vacation:request");
  assertPortalCsrf(request);
  const groupId = String(request.body.groupId || "").trim();
  const requestType = String(request.body.requestType || "");
  if (!groupId || !["change", "cancel"].includes(requestType)) throw httpError(400, "Bitte eine gültige Urlaubsänderung auswählen.");
  const vacation = approvedVacationsForEmployee(session.employeeNumber, "1900-01-01").find((item) => item.groupId === groupId);
  if (!vacation) throw httpError(404, "Der genehmigte Urlaub wurde nicht gefunden.");
  const pending = db.prepare(`
    SELECT id FROM vacation_change_requests
    WHERE employee_number = ? AND vacation_group_id = ? AND status IN ('pending','pending_local','preliminary_local','pending_hr') LIMIT 1
  `).get(session.employeeNumber, groupId);
  if (pending) throw httpError(409, "Für diesen Urlaub besteht bereits ein offener Änderungs- oder Stornoantrag.");
  let requestedFrom = null;
  let requestedTo = null;
  if (requestType === "change") {
    requestedFrom = String(request.body.dateFrom || "");
    requestedTo = String(request.body.dateTo || "");
    if (!isIsoDate(requestedFrom) || !isIsoDate(requestedTo) || requestedTo < requestedFrom) {
      throw httpError(400, "Bitte einen gültigen neuen Urlaubszeitraum eingeben.");
    }
    const availability = evaluateVacationRequest(session.employeeNumber, { dateFrom: requestedFrom, dateTo: requestedTo });
    if (!availability.allowed) throw httpError(409, availability.reason, "REQUEST_BLACKOUT");
  }
  const note = stripEmoji(String(request.body.note || "").trim()).slice(0, 500);
  const result = db.prepare(`
    INSERT INTO vacation_change_requests
      (employee_number, vacation_group_id, request_type, original_date_from, original_date_to,
       requested_date_from, requested_date_to, note, status, approval_stage)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_local', 'local')
  `).run(session.employeeNumber, groupId, requestType, vacation.dateFrom, vacation.dateTo, requestedFrom, requestedTo, note);
  auditPortal(session.employeeNumber, `vacation.${requestType}.request`, "vacation_change_request", String(result.lastInsertRowid));
  notifyRequestReviewers({ id: Number(result.lastInsertRowid), employee_number: session.employeeNumber, location_id: employeeRequestContext(session.employeeNumber, vacation.dateFrom).locationId }, "vacation_change", "local", session.employeeNumber);
  response.status(201).json({ id: Number(result.lastInsertRowid), status: "pending" });
});

app.delete("/api/portal/v1/me/vacation-change-requests/:id", (request, response) => {
  const session = requirePortalSession(request, "own_vacation:request");
  assertPortalCsrf(request);
  const entry = db.prepare("SELECT * FROM vacation_change_requests WHERE id = ? AND employee_number = ? AND status IN ('pending','pending_local','preliminary_local','pending_hr')")
    .get(Number(request.params.id), session.employeeNumber);
  const result = { changes: entry ? 1 : 0 };
  if (!result.changes) throw httpError(404, "Der offene Änderungs- oder Stornoantrag wurde nicht gefunden.");
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE vacation_change_requests SET status = 'withdrawn', approval_stage = 'complete', decided_by = ?, decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(session.employeeNumber, entry.id);
    recordRequestDecision("vacation_change", entry.id, "employee", "withdraw", session.employeeNumber, "");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  resolveRequestReviewNotifications("vacation_change", entry.id);
  auditPortal(session.employeeNumber, "vacation.change_request.withdraw", "vacation_change_request", request.params.id);
  response.status(204).end();
});

app.get("/api/portal/v1/me/vacation-requests", (request, response) => {
  const session = requirePortalSession(request, "own_vacation:read");
  const requests = db.prepare(`
    SELECT id, date_from, date_to, note, status, approval_stage, decision_note,
           local_approved_by, local_approved_at, hr_approved_by, hr_approved_at,
           decided_by, decided_at, created_at, updated_at
    FROM vacation_requests WHERE employee_number = ?
      AND (status IN ('pending','pending_local','preliminary_local','pending_hr') OR date_to >= ?)
    ORDER BY created_at DESC, id DESC
  `).all(session.employeeNumber, addMonths(viennaTodayIso(), -6));
  response.json({ requests });
});

app.post("/api/portal/v1/me/vacation-requests", (request, response) => {
  const session = requirePortalSession(request, "own_vacation:request");
  assertPortalCsrf(request);
  const vacation = validateVacationRequestDates(session.employeeNumber, request.body);
  const locationId = employeeRequestContext(session.employeeNumber, vacation.dateFrom).locationId;
  const result = db.prepare(`
    INSERT INTO vacation_requests (employee_number, location_id, date_from, date_to, note, status, approval_stage)
    VALUES (?, ?, ?, ?, ?, 'pending_local', 'local')
  `).run(vacation.employeeNumber, locationId, vacation.dateFrom, vacation.dateTo, vacation.note);
  auditPortal(session.employeeNumber, "vacation.request.create", "vacation_request", String(result.lastInsertRowid));
  notifyRequestReviewers({ id: Number(result.lastInsertRowid), employee_number: session.employeeNumber, location_id: locationId }, "vacation", "local", session.employeeNumber);
  response.status(201).json({ id: Number(result.lastInsertRowid), status: "pending" });
});

app.put("/api/portal/v1/me/vacation-requests/:id", (request, response) => {
  const session = requirePortalSession(request, "own_vacation:request");
  assertPortalCsrf(request);
  const entry = db.prepare("SELECT * FROM vacation_requests WHERE id = ? AND employee_number = ? AND status IN ('pending','pending_local','preliminary_local','pending_hr')")
    .get(Number(request.params.id), session.employeeNumber);
  if (!entry) throw httpError(404, "Der offene Urlaubsantrag wurde nicht gefunden.");
  const dateFrom = String(request.body.dateFrom || "");
  const dateTo = String(request.body.dateTo || "");
  const note = stripEmoji(String(request.body.note || "").trim()).slice(0, 500);
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateTo < dateFrom) throw httpError(400, "Bitte einen gültigen Urlaubszeitraum eingeben.");
  const availability = evaluateVacationRequest(session.employeeNumber, { dateFrom, dateTo });
  if (!availability.allowed) throw httpError(409, availability.reason, "REQUEST_BLACKOUT");
  const overlapping = db.prepare(`SELECT id FROM vacation_requests WHERE employee_number = ? AND id <> ?
    AND status IN ('pending','pending_local','preliminary_local','pending_hr','approved') AND date_from <= ? AND date_to >= ? LIMIT 1`)
    .get(session.employeeNumber, entry.id, dateTo, dateFrom);
  if (overlapping) throw httpError(409, "Für diesen Zeitraum besteht bereits ein Urlaubsantrag.");
  db.prepare(`UPDATE vacation_requests SET date_from = ?, date_to = ?, note = ?, status = 'pending_local', approval_stage = 'local',
    decision_note = '', local_approved_by = NULL, local_approved_at = NULL, hr_approved_by = NULL, hr_approved_at = NULL,
    decided_by = NULL, decided_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(dateFrom, dateTo, note, entry.id);
  recordRequestDecision("vacation", entry.id, "employee", "change", session.employeeNumber, note);
  resolveRequestReviewNotifications("vacation", entry.id);
  notifyRequestReviewers(entry, "vacation", "local", session.employeeNumber);
  response.json({ id: entry.id, status: "pending" });
});

app.delete("/api/portal/v1/me/vacation-requests/:id", (request, response) => {
  const session = requirePortalSession(request, "own_vacation:request");
  assertPortalCsrf(request);
  const entry = db.prepare("SELECT * FROM vacation_requests WHERE id = ? AND employee_number = ? AND status IN ('pending','pending_local','preliminary_local','pending_hr')")
    .get(Number(request.params.id), session.employeeNumber);
  const result = { changes: entry ? 1 : 0 };
  if (!result.changes) throw httpError(404, "Der offene Urlaubsantrag wurde nicht gefunden.");
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE vacation_requests SET status = 'withdrawn', approval_stage = 'complete', decided_by = ?, decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(session.employeeNumber, entry.id);
    recordRequestDecision("vacation", entry.id, "employee", "withdraw", session.employeeNumber, "");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  resolveRequestReviewNotifications("vacation", entry.id);
  auditPortal(session.employeeNumber, "vacation.request.withdraw", "vacation_request", request.params.id);
  response.status(204).end();
});

app.get("/api/portal/v1/vacation-requests", (request, response) => {
  const actor = requirePortalAdminOrLocal(request, "vacation:read");
  const status = ["pending", "approved", "rejected"].includes(String(request.query.status)) ? String(request.query.status) : "pending";
  const requests = db.prepare(`
    SELECT v.id, v.employee_number, v.date_from, v.date_to, v.note, v.status,
           v.decided_by, v.decided_at, v.created_at, e.full_name, e.nickname, e.color,
           COALESCE(v.location_id, e.home_location_id) AS scoped_location_id, e.preferred_department_id
    FROM vacation_requests v JOIN employees e ON e.personnel_number = v.employee_number
    WHERE v.status = ? ORDER BY v.created_at, v.id
  `).all(status).filter((entry) => sessionHasGlobalScope(actor) || (actor.scopes || []).some((scope) => scope.locationId === entry.scoped_location_id
    && (actor.role !== "department_manager" || Number(scope.departmentId) === Number(entry.preferred_department_id || 0))));
  response.json({ requests, status });
});

app.put("/api/portal/v1/vacation-requests/:id/decision", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "vacation:approve");
  const decision = String(request.body.decision || "");
  if (!["approved", "rejected"].includes(decision)) throw httpError(400, "Bitte genehmigen oder ablehnen.");
  const entry = db.prepare("SELECT * FROM vacation_requests WHERE id = ? AND status IN ('pending','pending_local','preliminary_local')").get(Number(request.params.id));
  if (!entry) throw httpError(404, "Der offene Urlaubsantrag wurde nicht gefunden.");
  assertRequestScope(session, entry);
  if (session.role === "hr") throw httpError(403, "Die Personalleitung darf die vorgelagerte Filialfreigabe nicht ersetzen.");
  if (vacationHrApprovalRequired()) throw httpError(409, "Dieser Antrag muss über den zweistufigen Freigabeworkflow bearbeitet werden.");
  let groupId = null;
  if (decision === "approved") {
    const availability = evaluateVacationRequest(entry.employee_number, { dateFrom: entry.date_from, dateTo: entry.date_to });
    if (!availability.allowed) throw httpError(409, availability.reason, "REQUEST_BLACKOUT");
    const vacation = validateVacationEntry({ employeeNumber: entry.employee_number, dateFrom: entry.date_from, dateTo: entry.date_to, note: entry.note });
    groupId = createVacationGroupId();
    db.exec("BEGIN");
    try {
      insertVacationEntries(vacation, groupId);
      db.prepare(`
        UPDATE vacation_requests SET status = 'approved', decided_by = ?, decided_at = CURRENT_TIMESTAMP,
          vacation_group_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(session.employeeNumber, groupId, entry.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } else {
    db.prepare(`
      UPDATE vacation_requests SET status = 'rejected', decided_by = ?, decided_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(session.employeeNumber, entry.id);
  }
  auditPortal(session.employeeNumber, `vacation.request.${decision}`, "vacation_request", String(entry.id));
  recordRequestDecision("vacation", entry.id, "local", decision === "approved" ? "approve" : "reject", session.employeeNumber, "");
  notifyRequestDecision(entry, "vacation", decision, session.employeeNumber);
  response.json({ ok: true, id: entry.id, status: decision, vacationGroupId: groupId });
});

app.get("/api/portal/v1/absence-requests", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "vacation:read");
  const scoped = !sessionHasGlobalScope(session);
  const scopeSql = scoped ? "AND COALESCE(v.location_id, e.home_location_id) = ?" : "";
  const scopeParams = scoped ? [session.scopes?.[0]?.locationId || session.homeLocationId] : [];
  const vacationRequests = db.prepare(`
    SELECT v.id, v.employee_number, v.location_id, v.date_from, v.date_to, v.note, v.status,
           v.approval_stage, v.decision_note, v.local_approved_by, v.local_approved_at,
           v.hr_approved_by, v.hr_approved_at, v.decided_by, v.decided_at, v.created_at,
           e.full_name, e.nickname, e.color, e.preferred_department_id
    FROM vacation_requests v JOIN employees e ON e.personnel_number = v.employee_number
    WHERE 1 = 1 ${scopeSql}
  `).all(...scopeParams).map((row) => ({ ...row, status: publicRequestStatus(row.status), kind: "vacation", decisions: requestDecisionHistory("vacation", row.id) }));
  const timeScopeSql = scoped ? "AND COALESCE(t.location_id, e.home_location_id) = ?" : "";
  const timeOffRequests = db.prepare(`
    SELECT t.id, t.employee_number, t.location_id, t.request_date,
           COALESCE(t.date_from, t.request_date) AS date_from, COALESCE(t.date_to, t.request_date) AS date_to, t.all_day,
           t.start_time, t.end_time, t.note,
           t.status, t.approval_type, t.approval_stage, t.traffic_light, t.check_reason,
           t.decision_note, t.local_approved_by, t.local_approved_at, t.hr_approved_by,
           t.hr_approved_at, t.decided_by, t.decided_at, t.created_at,
           e.full_name, e.nickname, e.color, e.preferred_department_id
    FROM time_off_requests t JOIN employees e ON e.personnel_number = t.employee_number
    WHERE 1 = 1 ${timeScopeSql}
  `).all(...scopeParams).map((row) => ({ ...row, status: publicRequestStatus(row.status), kind: "time_off", decisions: requestDecisionHistory("time_off", row.id) }));
  const changeScopeSql = scoped ? "AND e.home_location_id = ?" : "";
  const changeRequests = db.prepare(`
    SELECT c.id, c.employee_number, c.vacation_group_id, c.request_type,
           c.original_date_from, c.original_date_to, c.requested_date_from, c.requested_date_to,
           c.note, c.status, c.approval_stage, c.decision_note, c.local_approved_by,
           c.local_approved_at, c.hr_approved_by, c.hr_approved_at, c.decided_by, c.decided_at,
           c.created_at, e.full_name, e.nickname, e.color, e.home_location_id AS location_id, e.preferred_department_id
    FROM vacation_change_requests c JOIN employees e ON e.personnel_number = c.employee_number
    WHERE 1 = 1 ${changeScopeSql}
  `).all(...scopeParams).map((row) => ({ ...row, status: publicRequestStatus(row.status), kind: row.request_type === "cancel" ? "vacation_cancel" : "vacation_change", decisions: requestDecisionHistory("vacation_change", row.id) }));
  const timeOffChangeScopeSql = scoped ? "AND COALESCE(c.location_id, e.home_location_id) = ?" : "";
  const timeOffChangeRequests = db.prepare(`
    SELECT c.id, c.employee_number, c.location_id, c.original_request_id, c.request_type,
           c.requested_date_from, c.requested_date_to, c.requested_all_day,
           c.requested_start_time, c.requested_end_time, c.note, c.status,
           c.approval_type, c.approval_stage, c.decision_note, c.local_approved_by,
           c.local_approved_at, c.hr_approved_by, c.hr_approved_at, c.decided_by,
           c.decided_at, c.created_at, e.full_name, e.nickname, e.color,
           e.preferred_department_id, COALESCE(t.date_from, t.request_date) AS original_date_from,
           COALESCE(t.date_to, t.request_date) AS original_date_to, t.all_day AS original_all_day,
           t.start_time AS original_start_time, t.end_time AS original_end_time
    FROM time_off_change_requests c
    JOIN time_off_requests t ON t.id = c.original_request_id
    JOIN employees e ON e.personnel_number = c.employee_number
    WHERE 1 = 1 ${timeOffChangeScopeSql}
  `).all(...scopeParams).map((row) => ({
    ...row,
    status: publicRequestStatus(row.status),
    kind: row.request_type === "cancel" ? "time_off_cancel" : "time_off_change",
    decisions: requestDecisionHistory("time_off_change", row.id),
  }));
  let requests = [...vacationRequests, ...timeOffRequests, ...changeRequests, ...timeOffChangeRequests];
  if (session.role === "department_manager") {
    const departments = new Set((session.scopes || []).map((scope) => Number(scope.departmentId || 0)).filter(Boolean));
    requests = requests.filter((entry) => departments.has(Number(entry.preferred_department_id || 0)));
  }
  requests = requests
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || Number(b.id) - Number(a.id));
  const actionable = requests.filter((entry) => {
    if (!["pending_local", "preliminary_local", "pending_hr"].includes(entry.status)) return false;
    if (entry.approval_stage === "hr") return sessionCanApproveHr(session);
    return session.role !== "hr" || ["developer", "admin"].includes(session.role) || session.employeeNumber === "local";
  });
  response.json({
    requests,
    counts: {
      vacation: actionable.filter((entry) => !entry.kind.startsWith("time_off")).length,
      timeOff: actionable.filter((entry) => entry.kind.startsWith("time_off")).length,
      total: actionable.length,
    },
    vacationHrApprovalRequired: vacationHrApprovalRequired(),
  });
});

function finalizeVacationRequest(entry, actor, note) {
  const availability = evaluateVacationRequest(entry.employee_number, { dateFrom: entry.date_from, dateTo: entry.date_to });
  if (!availability.allowed) throw httpError(409, availability.reason, "REQUEST_BLACKOUT");
  const vacation = validateVacationEntry({ employeeNumber: entry.employee_number, dateFrom: entry.date_from, dateTo: entry.date_to, note: entry.note });
  const groupId = entry.vacation_group_id || createVacationGroupId();
  insertVacationEntries(vacation, groupId);
  db.prepare(`
    UPDATE vacation_requests SET status = 'approved', approval_stage = 'complete', decision_note = ?,
      decided_by = ?, decided_at = CURRENT_TIMESTAMP, vacation_group_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(note, actor, groupId, entry.id);
  return { vacationGroupId: groupId };
}

function finalizeTimeOffRequest(entry, actor, note) {
  const check = evaluateTimeOffRequest(entry.employee_number, {
    date: entry.date_from || entry.request_date,
    dateFrom: entry.date_from || entry.request_date,
    dateTo: entry.date_to || entry.request_date,
    allDay: Boolean(entry.all_day),
    startTime: entry.start_time,
    endTime: entry.end_time,
    excludeRequestId: entry.id,
  });
  if (!check.allowed) throw httpError(409, check.reason, "TIME_OFF_NOT_POSSIBLE");
  const optionId = insertApprovedTimeOff(entry);
  db.prepare(`
    UPDATE time_off_requests SET status = 'approved', approval_stage = 'complete', option_id = ?,
      traffic_light = ?, check_reason = ?, decision_note = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(optionId, check.trafficLight, check.reason, note, actor, entry.id);
  return { optionId };
}

function finalizeTimeOffChangeRequest(entry, actor, note) {
  let original = db.prepare("SELECT * FROM time_off_requests WHERE id = ? AND employee_number = ? AND status = 'approved'")
    .get(entry.original_request_id, entry.employee_number);
  if (!original) throw httpError(409, "Der ursprüngliche Zeitausgleich besteht nicht mehr.");
  let check = null;
  if (entry.request_type === "change") {
    check = evaluateTimeOffRequest(entry.employee_number, {
      date: entry.requested_date_from,
      dateFrom: entry.requested_date_from,
      dateTo: entry.requested_date_to,
      allDay: Boolean(entry.requested_all_day),
      startTime: entry.requested_start_time,
      endTime: entry.requested_end_time,
      excludeRequestId: original.id,
    });
    if (!check.allowed) throw httpError(409, check.reason, "TIME_OFF_NOT_POSSIBLE");
  }

  restoreApprovedTimeOff(original);
  if (entry.request_type === "cancel") {
    db.prepare(`UPDATE time_off_requests SET status = 'cancelled', approval_stage = 'complete', option_id = NULL,
      original_shifts_json = '[]', decision_note = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(note, actor, original.id);
  } else {
    const allDay = Boolean(entry.requested_all_day) || entry.requested_date_to !== entry.requested_date_from;
    db.prepare(`UPDATE time_off_requests SET request_date = ?, date_from = ?, date_to = ?, all_day = ?,
      start_time = ?, end_time = ?, note = CASE WHEN ? <> '' THEN ? ELSE note END,
      option_id = NULL, original_shifts_json = '[]', traffic_light = ?, check_reason = ?,
      decision_note = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).run(entry.requested_date_from, entry.requested_date_from, entry.requested_date_to,
      allDay ? 1 : 0, allDay ? "00:00" : entry.requested_start_time,
      allDay ? "23:59" : entry.requested_end_time, entry.note || "", entry.note || "",
      check.trafficLight, check.reason, note, actor, original.id);
    original = db.prepare("SELECT * FROM time_off_requests WHERE id = ?").get(original.id);
    const optionId = insertApprovedTimeOff(original);
    db.prepare("UPDATE time_off_requests SET option_id = ?, status = 'approved', approval_stage = 'complete', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(optionId, original.id);
  }
  db.prepare(`UPDATE time_off_change_requests SET status = 'approved', approval_stage = 'complete',
    decision_note = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(note, actor, entry.id);
  return { originalRequestId: original.id };
}

function finalizeVacationChangeRequest(entry, actor, note) {
  const current = approvedVacationsForEmployee(entry.employee_number, "1900-01-01").find((item) => item.groupId === entry.vacation_group_id);
  if (!current) throw httpError(409, "Der ursprüngliche Urlaub besteht nicht mehr.");
  let replacement = null;
  if (entry.request_type === "change") {
    const availability = evaluateVacationRequest(entry.employee_number, { dateFrom: entry.requested_date_from, dateTo: entry.requested_date_to });
    if (!availability.allowed) throw httpError(409, availability.reason, "REQUEST_BLACKOUT");
    replacement = validateVacationEntry({
      employeeNumber: entry.employee_number,
      dateFrom: entry.requested_date_from,
      dateTo: entry.requested_date_to,
      note: entry.note || current.note,
    }, entry.vacation_group_id);
  }
  deleteVacationGroup(entry.vacation_group_id);
  if (replacement) insertVacationEntries(replacement, entry.vacation_group_id);
  db.prepare(`
    UPDATE vacation_change_requests SET status = 'approved', approval_stage = 'complete', decision_note = ?,
      decided_by = ?, decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(note, actor, entry.id);
  if (entry.request_type === "change") {
    db.prepare(`UPDATE vacation_requests SET date_from = ?, date_to = ?, note = ?, updated_at = CURRENT_TIMESTAMP WHERE vacation_group_id = ?`)
      .run(entry.requested_date_from, entry.requested_date_to, entry.note || current.note, entry.vacation_group_id);
  } else {
    db.prepare(`UPDATE vacation_requests SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE vacation_group_id = ?`)
      .run(entry.vacation_group_id);
  }
  return {};
}

app.put("/api/portal/v1/absence-requests/:kind/:id/action", (request, response) => {
  const kind = String(request.params.kind || "");
  const permission = kind.startsWith("time_off") ? "time:review" : "vacation:approve";
  const session = requirePortalAdminOrLocal(request, permission);
  const table = kind === "time_off" ? "time_off_requests"
    : kind === "time_off_change" ? "time_off_change_requests"
      : kind === "vacation_change" ? "vacation_change_requests"
        : kind === "vacation" ? "vacation_requests" : "";
  if (!table) throw httpError(400, "Die Antragsart ist ungültig.");
  let entry = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(request.params.id));
  if (!entry) throw httpError(404, "Der Antrag wurde nicht gefunden.");
  if (!entry.location_id) entry.location_id = db.prepare("SELECT home_location_id FROM employees WHERE personnel_number = ?").get(entry.employee_number)?.home_location_id;
  assertRequestScope(session, entry);
  if (entry.approval_stage !== "hr" && session.role === "hr") {
    throw httpError(403, "Die Personalleitung darf die vorgelagerte Filialfreigabe nicht ersetzen.");
  }
  const action = String(request.body.action || "");
  const note = stripEmoji(String(request.body.note || "").trim()).slice(0, 500);
  const stage = actorStage(session, entry);
  if (entry.approval_stage === "hr" && stage !== "hr") throw httpError(403, "Dieser Antrag wartet auf die Personalleitung.");
  if (stage === "hr" && !sessionCanApproveHr(session)) throw httpError(403, "Für diese verbindliche Freigabe fehlt die Berechtigung.");
  if (entry.status === "approved" && entry.hr_approved_by && ["change", "cancel"].includes(action)
    && !sessionCanApproveHr(session)) {
    throw httpError(403, "Für die Änderung dieses verbindlichen Antrags fehlt die Berechtigung.");
  }
  let result = {};
  db.exec("BEGIN");
  try {
    if (action === "preliminary") {
      if (!["pending", "pending_local", "preliminary_local"].includes(entry.status) || stage !== "local") throw httpError(409, "Dieser Antrag kann nicht vorläufig genehmigt werden.");
      db.prepare(`UPDATE ${table} SET status = 'preliminary_local', approval_stage = 'local', decision_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(note, entry.id);
    } else if (action === "reject") {
      if (!["pending", "pending_local", "preliminary_local", "pending_hr"].includes(entry.status)) throw httpError(409, "Dieser Antrag ist bereits abgeschlossen.");
      db.prepare(`UPDATE ${table} SET status = 'rejected', approval_stage = 'complete', decision_note = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(note, session.employeeNumber, entry.id);
    } else if (action === "approve") {
      if (!["pending", "pending_local", "preliminary_local", "pending_hr"].includes(entry.status)) throw httpError(409, "Dieser Antrag ist bereits abgeschlossen.");
      if (stage === "local") {
        db.prepare(`UPDATE ${table} SET local_approved_by = ?, local_approved_at = CURRENT_TIMESTAMP WHERE id = ?`).run(session.employeeNumber, entry.id);
        const needsHr = kind.startsWith("time_off") ? entry.approval_type === "hr" : vacationHrApprovalRequired();
        if (needsHr) {
          db.prepare(`UPDATE ${table} SET status = 'pending_hr', approval_stage = 'hr', decision_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(note, entry.id);
        } else if (kind === "time_off") result = finalizeTimeOffRequest(entry, session.employeeNumber, note);
        else if (kind === "time_off_change") result = finalizeTimeOffChangeRequest(entry, session.employeeNumber, note);
        else if (kind === "vacation") result = finalizeVacationRequest(entry, session.employeeNumber, note);
        else result = finalizeVacationChangeRequest(entry, session.employeeNumber, note);
      } else {
        db.prepare(`UPDATE ${table} SET hr_approved_by = ?, hr_approved_at = CURRENT_TIMESTAMP WHERE id = ?`).run(session.employeeNumber, entry.id);
        if (kind === "time_off") result = finalizeTimeOffRequest(entry, session.employeeNumber, note);
        else if (kind === "time_off_change") result = finalizeTimeOffChangeRequest(entry, session.employeeNumber, note);
        else if (kind === "vacation") result = finalizeVacationRequest(entry, session.employeeNumber, note);
        else result = finalizeVacationChangeRequest(entry, session.employeeNumber, note);
      }
    } else if (action === "change" && entry.status === "approved") {
      if (kind === "time_off") {
        const dateFrom = String(request.body.dateFrom || request.body.date || "");
        const dateTo = String(request.body.dateTo || dateFrom);
        const allDay = request.body.allDay === true || Boolean(entry.all_day) || dateTo !== dateFrom;
        const startTime = allDay ? "00:00" : String(request.body.startTime || "");
        const endTime = allDay ? "23:59" : String(request.body.endTime || "");
        if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateTo < dateFrom
          || (!allDay && (!isTime(startTime) || !isTime(endTime) || endTime <= startTime))) {
          throw httpError(400, "Bitte einen gültigen neuen ZA-Zeitraum eingeben.");
        }
        restoreApprovedTimeOff(entry);
        db.prepare(`UPDATE time_off_requests SET request_date = ?, date_from = ?, date_to = ?, all_day = ?, start_time = ?, end_time = ?, note = CASE WHEN ? <> '' THEN ? ELSE note END, option_id = NULL, original_shifts_json = '[]', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(dateFrom, dateFrom, dateTo, allDay ? 1 : 0, startTime, endTime, note, note, entry.id);
        entry = db.prepare("SELECT * FROM time_off_requests WHERE id = ?").get(entry.id);
        result = finalizeTimeOffRequest(entry, session.employeeNumber, note);
      } else if (kind === "vacation") {
        const dateFrom = String(request.body.dateFrom || "");
        const dateTo = String(request.body.dateTo || "");
        if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateTo < dateFrom) throw httpError(400, "Bitte einen gültigen neuen Urlaubszeitraum eingeben.");
        deleteVacationGroup(entry.vacation_group_id);
        db.prepare(`UPDATE vacation_requests SET date_from = ?, date_to = ?, note = CASE WHEN ? <> '' THEN ? ELSE note END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(dateFrom, dateTo, note, note, entry.id);
        entry = db.prepare("SELECT * FROM vacation_requests WHERE id = ?").get(entry.id);
        result = finalizeVacationRequest(entry, session.employeeNumber, note);
      } else throw httpError(409, "Dieser Vorgang kann nicht direkt geändert werden.");
    } else if (action === "cancel" && entry.status === "approved") {
      if (kind === "time_off") restoreApprovedTimeOff(entry);
      else if (kind === "vacation") deleteVacationGroup(entry.vacation_group_id);
      else throw httpError(409, "Dieser Vorgang kann nicht direkt storniert werden.");
      db.prepare(`UPDATE ${table} SET status = 'cancelled', approval_stage = 'complete', decision_note = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(note, session.employeeNumber, entry.id);
    } else {
      throw httpError(400, "Bitte eine gültige Entscheidung auswählen.");
    }
    recordRequestDecision(kind, entry.id, stage, action, session.employeeNumber, note);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  auditPortal(session.employeeNumber, `${kind}.${action}`, `${kind}_request`, String(entry.id), note);
  const updated = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(entry.id);
  resolveRequestReviewNotifications(kind, entry.id);
  if (updated.status === "pending_hr") notifyRequestReviewers(updated, kind, "hr", session.employeeNumber);
  notifyRequestDecision(updated, kind, updated.status, session.employeeNumber);
  response.json({ ok: true, request: { ...updated, status: publicRequestStatus(updated.status) }, ...result });
});

app.put("/api/portal/v1/time-off-requests/:id/decision", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "time:review");
  const decision = String(request.body.decision || "");
  if (!["approved", "rejected"].includes(decision)) throw httpError(400, "Bitte genehmigen oder ablehnen.");
  const entry = db.prepare("SELECT * FROM time_off_requests WHERE id = ? AND status IN ('pending','pending_local','preliminary_local')").get(Number(request.params.id));
  if (!entry) throw httpError(404, "Der offene ZA-Antrag wurde nicht gefunden.");
  assertRequestScope(session, entry);
  if (session.role === "hr") throw httpError(403, "Die Personalleitung darf die vorgelagerte Filialfreigabe nicht ersetzen.");
  if (entry.approval_type === "hr") throw httpError(409, "Dieser ZA muss über den zweistufigen Freigabeworkflow bearbeitet werden.");
  let optionId = null;
  if (decision === "approved") {
    const check = evaluateTimeOffRequest(entry.employee_number, {
      date: entry.date_from || entry.request_date,
      dateFrom: entry.date_from || entry.request_date,
      dateTo: entry.date_to || entry.request_date,
      allDay: Boolean(entry.all_day),
      startTime: entry.start_time,
      endTime: entry.end_time,
      excludeRequestId: entry.id,
    });
    if (!check.allowed) throw httpError(409, check.reason, "TIME_OFF_NOT_POSSIBLE");
    db.exec("BEGIN");
    try {
      optionId = insertApprovedTimeOff(entry);
      db.prepare(`
        UPDATE time_off_requests SET status = 'approved', option_id = ?, traffic_light = ?, check_reason = ?,
          decided_by = ?, decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(optionId, check.trafficLight, check.reason, session.employeeNumber, entry.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } else {
    db.prepare(`
      UPDATE time_off_requests SET status = 'rejected', decided_by = ?, decided_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(session.employeeNumber, entry.id);
  }
  auditPortal(session.employeeNumber, `time_off.request.${decision}`, "time_off_request", String(entry.id));
  recordRequestDecision("time_off", entry.id, "local", decision === "approved" ? "approve" : "reject", session.employeeNumber, "");
  notifyRequestDecision(entry, "time_off", decision, session.employeeNumber);
  response.json({ ok: true, id: entry.id, status: decision, optionId });
});

app.put("/api/portal/v1/vacation-change-requests/:id/decision", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "vacation:approve");
  const decision = String(request.body.decision || "");
  if (!["approved", "rejected"].includes(decision)) throw httpError(400, "Bitte genehmigen oder ablehnen.");
  const entry = db.prepare("SELECT * FROM vacation_change_requests WHERE id = ? AND status IN ('pending','pending_local','preliminary_local')").get(Number(request.params.id));
  if (!entry) throw httpError(404, "Der offene Änderungs- oder Stornoantrag wurde nicht gefunden.");
  entry.location_id = db.prepare("SELECT home_location_id FROM employees WHERE personnel_number = ?").get(entry.employee_number)?.home_location_id;
  assertRequestScope(session, entry);
  if (session.role === "hr") throw httpError(403, "Die Personalleitung darf die vorgelagerte Filialfreigabe nicht ersetzen.");
  if (vacationHrApprovalRequired()) throw httpError(409, "Dieser Antrag muss über den zweistufigen Freigabeworkflow bearbeitet werden.");
  if (decision === "approved") {
    const current = approvedVacationsForEmployee(entry.employee_number, "1900-01-01").find((item) => item.groupId === entry.vacation_group_id);
    if (!current) throw httpError(409, "Der ursprüngliche Urlaub besteht nicht mehr.");
    let replacement = null;
    if (entry.request_type === "change") {
      const availability = evaluateVacationRequest(entry.employee_number, { dateFrom: entry.requested_date_from, dateTo: entry.requested_date_to });
      if (!availability.allowed) throw httpError(409, availability.reason, "REQUEST_BLACKOUT");
      replacement = validateVacationEntry({
        employeeNumber: entry.employee_number,
        dateFrom: entry.requested_date_from,
        dateTo: entry.requested_date_to,
        note: entry.note || current.note,
      }, entry.vacation_group_id);
    }
    db.exec("BEGIN");
    try {
      deleteVacationGroup(entry.vacation_group_id);
      if (replacement) insertVacationEntries(replacement, entry.vacation_group_id);
      db.prepare(`
        UPDATE vacation_change_requests SET status = 'approved', decided_by = ?, decided_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(session.employeeNumber, entry.id);
      if (entry.request_type === "change") {
        db.prepare(`
          UPDATE vacation_requests SET date_from = ?, date_to = ?, note = ?, updated_at = CURRENT_TIMESTAMP
          WHERE vacation_group_id = ?
        `).run(entry.requested_date_from, entry.requested_date_to, entry.note || current.note, entry.vacation_group_id);
      } else {
        db.prepare(`
          UPDATE vacation_requests SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
          WHERE vacation_group_id = ?
        `).run(entry.vacation_group_id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } else {
    db.prepare(`
      UPDATE vacation_change_requests SET status = 'rejected', decided_by = ?, decided_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(session.employeeNumber, entry.id);
  }
  auditPortal(session.employeeNumber, `vacation.${entry.request_type}.${decision}`, "vacation_change_request", String(entry.id));
  recordRequestDecision("vacation_change", entry.id, "local", decision === "approved" ? "approve" : "reject", session.employeeNumber, "");
  notifyRequestDecision(entry, "vacation_change", decision, session.employeeNumber);
  response.json({ ok: true, id: entry.id, status: decision });
});

app.get("/api/portal/v1/request-blackouts", (request, response) => {
  const actor = requirePortalAdminOrLocal(request, "vacation:read");
  response.json({ blackouts: getRequestBlackoutsForSession(actor, false) });
});

app.post("/api/portal/v1/request-blackouts", (request, response) => {
  const actor = requirePortalAdminOrLocal(request, "vacation:approve");
  const blackout = validateRequestBlackout(request.body);
  assertSessionContextScope(actor, { locationId: blackout.locationId, departmentId: blackout.departmentId });
  const result = db.prepare(`
    INSERT INTO request_blackouts
      (location_id, department_id, date_from, date_to, block_vacation, block_time_off, reason, active, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(blackout.locationId, blackout.departmentId, blackout.dateFrom, blackout.dateTo,
    blackout.blockVacation ? 1 : 0, blackout.blockTimeOff ? 1 : 0, blackout.reason, blackout.active ? 1 : 0, actor.employeeNumber);
  auditPortal(actor.employeeNumber, "request_blackout.create", "request_blackout", String(result.lastInsertRowid));
  response.status(201).json({ blackouts: getRequestBlackoutsForSession(actor, false) });
});

app.put("/api/portal/v1/request-blackouts/:id", (request, response) => {
  const actor = requirePortalAdminOrLocal(request, "vacation:approve");
  const id = Number(request.params.id);
  const existing = db.prepare("SELECT location_id, department_id FROM request_blackouts WHERE id = ?").get(id);
  if (!existing) throw httpError(404, "Die Antragssperre wurde nicht gefunden.");
  assertSessionContextScope(actor, { locationId: existing.location_id, departmentId: existing.department_id });
  const blackout = validateRequestBlackout(request.body, id);
  assertSessionContextScope(actor, { locationId: blackout.locationId, departmentId: blackout.departmentId });
  db.prepare(`
    UPDATE request_blackouts SET location_id = ?, department_id = ?, date_from = ?, date_to = ?,
      block_vacation = ?, block_time_off = ?, reason = ?, active = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(blackout.locationId, blackout.departmentId, blackout.dateFrom, blackout.dateTo,
    blackout.blockVacation ? 1 : 0, blackout.blockTimeOff ? 1 : 0, blackout.reason, blackout.active ? 1 : 0, id);
  auditPortal(actor.employeeNumber, "request_blackout.update", "request_blackout", String(id));
  response.json({ blackouts: getRequestBlackoutsForSession(actor, false) });
});

app.delete("/api/portal/v1/request-blackouts/:id", (request, response) => {
  const actor = requirePortalAdminOrLocal(request, "vacation:approve");
  const existing = db.prepare("SELECT location_id, department_id FROM request_blackouts WHERE id = ?").get(Number(request.params.id));
  if (!existing) throw httpError(404, "Die Antragssperre wurde nicht gefunden.");
  assertSessionContextScope(actor, { locationId: existing.location_id, departmentId: existing.department_id });
  const result = db.prepare("DELETE FROM request_blackouts WHERE id = ?").run(Number(request.params.id));
  if (!result.changes) throw httpError(404, "Die Antragssperre wurde nicht gefunden.");
  auditPortal(actor.employeeNumber, "request_blackout.delete", "request_blackout", request.params.id);
  response.status(204).end();
});

app.get("/api/portal/v1/me/wifi-automation", (request, response) => {
  const session = requirePortalSession(request, "own_time:read");
  response.json(wifiAutomationEmployeePayload(session, new Date()));
});

app.put("/api/portal/v1/me/wifi-automation", (request, response) => {
  const session = requirePortalSession(request, "own_time:read");
  assertPortalCsrf(request);
  if (typeof request.body?.enabled !== "boolean") {
    throw httpError(400, "Bitte die WLAN-Automatik eindeutig ein- oder ausschalten.", "WIFI_PREFERENCE_INVALID");
  }
  if (request.body.enabled) {
    const current = wifiAutomationEmployeePayload(session, new Date());
    if (!current.canEnable) throw httpError(409, current.availabilityReason || "Die WLAN-Automatik ist noch nicht verfügbar.", "WIFI_AUTOMATION_UNAVAILABLE");
  }
  setWifiAutomationPreference(session, request.body.enabled);
  response.json(wifiAutomationEmployeePayload(session, new Date()));
});

app.post("/api/portal/v1/me/wifi-suggestions/:id/confirm", (request, response) => {
  const session = requirePortalSession(request, "own_time:write");
  assertPortalCsrf(request);
  confirmWifiSuggestionBatch(session, [{ id: request.params.id, ...(request.body || {}) }], new Date());
  response.json(wifiAutomationEmployeePayload(session, new Date()));
});

app.post("/api/portal/v1/me/wifi-suggestions/confirm-week", (request, response) => {
  const session = requirePortalSession(request, "own_time:write");
  assertPortalCsrf(request);
  confirmWifiSuggestionWeek(session, request.body || {}, new Date());
  response.json(wifiAutomationEmployeePayload(session, new Date()));
});

app.post("/api/portal/v1/me/wifi-suggestions/:id/reject", (request, response) => {
  const session = requirePortalSession(request, "own_time:write");
  assertPortalCsrf(request);
  rejectWifiSuggestion(session, request.params.id, request.body?.reason || "");
  response.json(wifiAutomationEmployeePayload(session, new Date()));
});

app.get("/api/mobile/v1/me/time-entries", (request, response) => {
  const session = requireMobileSession(request, "own_time:read");
  const dateValue = String(request.query.date || "");
  if (dateValue && !isIsoDate(dateValue)) {
    throw httpError(400, "Bitte ein gültiges Datum auswählen.", "TIME_ENTRY_DATE_INVALID");
  }
  const date = dateValue || viennaTodayIso();
  const context = employeeRequestContext(session.employeeNumber, date);
  const access = timeTrackingRequestAccess(request, validateLocationExists(context.locationId));
  const status = timeTrackingDayStatus(session.employeeNumber, date, new Date(), { access });
  if (!session.permissions.includes("own_time:write")) status.allowedActions = [];
  response.json({ status });
});

app.post("/api/mobile/v1/me/time-entries", (request, response) => {
  const session = requireMobileSession(request, "own_time:write");
  const now = new Date();
  const context = employeeRequestContext(session.employeeNumber, viennaTodayIso(now));
  const access = timeTrackingRequestAccess(request, validateLocationExists(context.locationId));
  const result = bookTimeEntry(session.employeeNumber, String(request.body?.type || ""), now, {
    access,
    source: "mobile",
    clientRequestId: request.body?.clientRequestId,
    mobileSessionId: session.mobileSessionId,
    returnMeta: true,
  });
  response.status(result.replayed ? 200 : 201).json(result);
});

app.get("/api/portal/v1/me/time-entries", (request, response) => {
  const session = requirePortalSession(request, "own_time:read");
  const date = isIsoDate(request.query.date) ? String(request.query.date) : viennaTodayIso();
  const context = employeeRequestContext(session.employeeNumber, date);
  const access = timeTrackingRequestAccess(request, validateLocationExists(context.locationId));
  response.json({ status: timeTrackingDayStatus(session.employeeNumber, date, new Date(), { access }) });
});

app.post("/api/portal/v1/me/time-entries", (request, response) => {
  const session = requirePortalSession(request, "own_time:write");
  assertPortalCsrf(request);
  const context = employeeRequestContext(session.employeeNumber, viennaTodayIso());
  const access = timeTrackingRequestAccess(request, validateLocationExists(context.locationId));
  response.status(201).json({ status: bookTimeEntry(session.employeeNumber, String(request.body?.type || ""), new Date(), { access }) });
});

app.get("/api/portal/v1/me/time-summary", (request, response) => {
  const session = requirePortalSession(request, "own_time:read");
  response.json({ summary: ownTimeSummary(session.employeeNumber, String(request.query.period || "week"), String(request.query.anchor || "")) });
});

app.get("/api/portal/v1/me/time-corrections", (request, response) => {
  const session = requirePortalSession(request, "own_time:correction_request");
  response.json({ corrections: timeCorrectionRows("WHERE c.employee_number = ?", [session.employeeNumber]) });
});

app.post("/api/portal/v1/me/time-corrections", (request, response) => {
  const session = requirePortalSession(request, "own_time:correction_request");
  assertPortalCsrf(request);
  response.status(201).json({ correction: createOwnTimeCorrection(session, request.body || {}) });
});

app.put("/api/portal/v1/me/time-corrections/:id", (request, response) => {
  const session = requirePortalSession(request, "own_time:correction_request");
  assertPortalCsrf(request);
  response.json({ correction: updateOwnTimeCorrection(session, request.params.id, request.body || {}) });
});

app.delete("/api/portal/v1/me/time-corrections/:id", (request, response) => {
  const session = requirePortalSession(request, "own_time:correction_request");
  assertPortalCsrf(request);
  withdrawOwnTimeCorrection(session, request.params.id);
  response.status(204).end();
});

app.get("/api/portal/v1/time-summary", (request, response) => {
  const session = requirePortalReadOrLocal(request, "time:read");
  const context = resolvePlanningContext(request.query || {});
  assertSessionContextScope(session, context);
  const dateFrom = String(request.query.from || "");
  const dateTo = String(request.query.to || "");
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateTo < dateFrom || daysBetweenInclusive(dateFrom, dateTo) > 370) {
    throw httpError(400, "Bitte einen gültigen Auswertungszeitraum von höchstens 370 Tagen wählen.", "TIME_SUMMARY_RANGE_INVALID");
  }
  const departmentActivity = context.departmentId ? db.prepare(`
    SELECT 1
    WHERE EXISTS (
      SELECT 1 FROM shifts s
      WHERE s.employee_number = ? AND s.shift_date BETWEEN ? AND ? AND s.department_id = ?
    ) OR EXISTS (
      SELECT 1 FROM time_entries t
      WHERE t.employee_number = ? AND t.work_date BETWEEN ? AND ? AND t.department_id = ? AND t.voided_at IS NULL
    )
  `) : null;
  const employees = db.prepare(`
    SELECT personnel_number, full_name, nickname, color, preferred_department_id
    FROM employees WHERE active = 1 AND home_location_id = ?
    ORDER BY CAST(personnel_number AS INTEGER), personnel_number
  `).all(context.locationId)
    .filter((employee) => !context.departmentId
      || Number(employee.preferred_department_id || 0) === Number(context.departmentId)
      || Boolean(departmentActivity.get(
        employee.personnel_number, dateFrom, dateTo, context.departmentId,
        employee.personnel_number, dateFrom, dateTo, context.departmentId,
      )))
    .map((employee) => {
      const summary = timeSummaryForEmployee(employee.personnel_number, dateFrom, dateTo, "range", new Date(), context.departmentId);
      return {
        employeeNumber: employee.personnel_number,
        fullName: employee.full_name,
        nickname: employee.nickname,
        color: employee.color,
        plannedMinutes: summary.plannedMinutes,
        actualMinutes: summary.actualMinutes,
        differenceMinutes: summary.differenceMinutes,
        plannedValuedMinutes: summary.plannedValuedMinutes,
        actualValuedMinutes: summary.actualValuedMinutes,
        valuedDifferenceMinutes: summary.valuedDifferenceMinutes,
        breakMinutes: summary.breakMinutes,
        saturdayBonusMinutes: summary.saturdayBonusMinutes,
        incompleteDays: summary.incompleteDays,
        issueDays: summary.issueDays,
        reviewedDays: summary.reviewedDays,
      };
    });
  response.json({ summary: { period: "range", from: dateFrom, to: dateTo, dateFrom, dateTo, context, employees } });
});

app.get("/api/portal/v1/time-day-evaluations", (request, response) => {
  const session = requirePortalReadOrLocal(request, "time:read");
  const context = resolvePlanningContext(request.query || {});
  const date = isIsoDate(request.query.date) ? String(request.query.date) : viennaTodayIso();
  response.json({ dayReview: timeDayEvaluationsForContext(session, context, date) });
});

app.put("/api/portal/v1/time-day-reviews/:employeeNumber/:date", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "time:review");
  const context = resolvePlanningContext(request.body || {});
  const employeeNumber = String(request.params.employeeNumber || "").trim();
  response.json({
    evaluation: setTimeDayReview(session, context, employeeNumber, String(request.params.date || ""), request.body || {}),
  });
});

app.get("/api/portal/v1/time-corrections", (request, response) => {
  const session = requirePortalReadOrLocal(request, "time:review");
  const context = resolvePlanningContext(request.query || {});
  assertSessionContextScope(session, context);
  const status = String(request.query.status || "pending").trim();
  const allowedStatuses = new Set(["pending", "approved", "rejected", "withdrawn", "all"]);
  if (!allowedStatuses.has(status)) throw httpError(400, "Dieser Korrekturstatus ist ungültig.");
  const where = [`c.location_id = ?`];
  const values = [context.locationId];
  if (context.departmentId) {
    where.push("c.department_id = ?");
    values.push(context.departmentId);
  }
  if (status !== "all") {
    where.push("c.status = ?");
    values.push(status);
  }
  const corrections = timeCorrectionRows(`WHERE ${where.join(" AND ")}`, values)
    .filter((correction) => {
      try {
        assertSessionContextScope(session, correction);
        return true;
      } catch {
        return false;
      }
    });
  response.json({ corrections });
});

app.put("/api/portal/v1/time-corrections/:id/decision", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "time:review");
  response.json({ correction: decideTimeCorrection(session, request.params.id, request.body || {}) });
});

app.get("/api/portal/v1/mobile-layout", (request, response) => {
  const session = requirePortalReadOrLocal(request, "own_time:read");
  response.json(mobileLayoutPayload(session));
});

app.put("/api/portal/v1/mobile-layout", (request, response) => {
  const session = requireAdminHrOrLocal(request, "rights:write");
  const layouts = validateMobileLeadershipLayouts(request.body?.layouts);
  db.prepare(`
    INSERT INTO portal_settings (key, value, updated_at) VALUES ('mobile_leadership_layouts', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(JSON.stringify(layouts));
  auditPortal(session.employeeNumber, "mobile.layout.update", "portal_settings", "mobile_leadership_layouts", JSON.stringify(layouts));
  response.json(mobileLayoutPayload(session));
});

app.get("/api/portal/v1/leadership/overview", (request, response) => {
  const session = requirePortalReadOrLocal(request, "time:read");
  const context = resolvePlanningContext(request.query || {});
  assertSessionContextScope(session, context);
  response.json({ overview: leadershipOverviewForContext(session, context) });
});

app.post("/api/portal/v1/time-corrections/resolve-stale", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "time:review");
  const employeeNumber = String(request.body?.employeeNumber || "").trim();
  response.status(201).json({
    status: resolveStaleTimeEntry(
      session,
      employeeNumber,
      String(request.body?.workDate || ""),
      String(request.body?.clockOutTime || ""),
    ),
  });
});

app.get("/api/portal/v1/time-presence", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "time:read");
  const context = resolvePlanningContext(request.query || {});
  const date = isIsoDate(request.query.date) ? String(request.query.date) : viennaTodayIso();
  response.json({ presence: timePresenceForContext(session, context, date) });
});

function usbProvisioningAvailability(request = null) {
  return evaluateUsbProvisioningAccess({
    platform: process.platform,
    operationMode: configuredOperationMode,
    deploymentKind,
    requestPresent: Boolean(request),
    socketAddress: request?.socket?.remoteAddress || "",
    clientAddress: request?.ip || request?.socket?.remoteAddress || "",
    proxyChainPresent: Array.isArray(request?.ips) && request.ips.length > 0,
  });
}

function usbProvisioningOriginAllowed(request) {
  const origin = String(request.headers.origin || "").trim();
  const fetchSite = String(request.headers["sec-fetch-site"] || "").trim().toLowerCase();
  if (!origin || (fetchSite && fetchSite !== "same-origin")) return false;
  if (serverModeActive) return requestOriginAllowed(request, origin);
  const host = String(request.headers.host || "").trim();
  if (!host || /[\r\n]/.test(host)) return false;
  const protocol = request.secure ? "https" : "http";
  const normalizedOrigin = normalizeHttpOrigin(origin);
  const expectedOrigin = normalizeHttpOrigin(`${protocol}://${host}`);
  return Boolean(normalizedOrigin && expectedOrigin && normalizedOrigin === expectedOrigin);
}

function assertUsbProvisioningRequest(request, { mutation = false } = {}) {
  const availability = usbProvisioningAvailability(request);
  if (!availability.available) {
    throw httpError(
      403,
      availability.reason || "Der USB-Stick-Assistent ist an diesem Ort nicht verfügbar.",
      availability.reasonCode || "USB_HOST_CONSOLE_REQUIRED",
    );
  }
  const portalEnabled = getPortalStatus().portalEnabled;
  let session = request.portalSession || null;
  if (portalEnabled) {
    session ||= requirePortalSession(request, "usb:provision");
    if (!USB_PROVISIONING_ROLES.has(session.role) || !session.permissions.includes("usb:provision")) {
      throw httpError(403, "Diese Aktion ist nur für Developer, IT-Admin oder Admin verfügbar.", "PORTAL_PERMISSION_DENIED");
    }
    if (mutation) assertPortalCsrf(request);
    request.portalSession = session;
  }
  if (request.get("X-Grabenplaner-USB-Action") !== "provisioning") {
    throw httpError(403, "Die lokale Sicherheitsbestätigung für den USB-Vorgang fehlt.", "USB_ACTION_HEADER_REQUIRED");
  }
  const fetchSite = String(request.headers["sec-fetch-site"] || "").trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin") {
    throw httpError(403, "Der USB-Vorgang muss direkt aus der Grabenplaner-Oberfläche gestartet werden.", "USB_ORIGIN_REQUIRED");
  }
  if (mutation && !usbProvisioningOriginAllowed(request)) {
    throw httpError(403, "Der USB-Vorgang muss direkt aus der Grabenplaner-Oberfläche gestartet werden.", "USB_ORIGIN_REQUIRED");
  }
  return { ...availability, session };
}

function usbCreatorCandidates(session = null) {
  const candidates = db.prepare(`
    SELECT u.employee_number, u.role, e.full_name, e.nickname, e.home_location_id, p.name AS position_name
    FROM portal_users u
    JOIN employees e ON e.personnel_number = u.employee_number
    LEFT JOIN positions p ON p.id = e.position_id
    WHERE u.active = 1 AND e.active = 1 AND TRIM(u.password_hash) <> ''
      AND u.role IN ('developer', 'it_admin', 'admin')
    ORDER BY CAST(u.employee_number AS INTEGER), u.employee_number
  `).all().map((row) => ({
    employeeNumber: row.employee_number,
    role: row.role,
    fullName: row.full_name,
    nickname: row.nickname,
    positionName: row.position_name || "",
    homeLocationId: row.home_location_id || "",
    assignableRoleIds: [...(PORTAL_ROLE_ASSIGNMENTS[row.role] || new Set(["employee"]))],
  }));
  if (!session) return candidates;
  return candidates.filter((candidate) => candidate.employeeNumber === session.employeeNumber);
}

async function verifyUsbCreator(request, employeeNumber, password) {
  const number = String(employeeNumber || "").trim();
  if (getPortalStatus().portalEnabled) {
    const session = request.portalSession || requirePortalSession(request, "usb:provision");
    if (session.employeeNumber !== number) {
      throw httpError(403, "Im Netzwerk- oder Serverbetrieb muss das angemeldete Administratorkonto den USB-Stick erstellen.", "USB_CREATOR_SESSION_MISMATCH");
    }
  }
  const now = Date.now();
  const ipKey = loginRateKey(request);
  const rateKey = `${ipKey}:${number || "unknown"}`;
  if (usbCreatorGlobalRateLimits.get(ipKey, now).length >= 24 || usbCreatorAuthRateLimits.get(rateKey, now).length >= 8) {
    throw httpError(429, "Zu viele fehlgeschlagene Freigaben. Bitte 15 Minuten warten.", "USB_CREATOR_RATE_LIMITED");
  }
  const row = db.prepare(`
    SELECT u.employee_number, u.password_hash, u.role,
           e.personnel_number, e.full_name, e.nickname, e.color, e.contracted_hours,
           e.preferred_day_off, e.fixed_workdays, e.position_id, e.time_confirmation_level,
           e.home_location_id, e.preferred_department_id, e.active
    FROM portal_users u
    JOIN employees e ON e.personnel_number = u.employee_number
    WHERE u.employee_number = ? AND u.active = 1 AND e.active = 1
  `).get(number);
  const allowed = Boolean(row && USB_PROVISIONING_ROLES.has(row.role) && row.password_hash);
  const passwordMatches = await verifyPortalPassword(password, allowed ? row.password_hash : DUMMY_PORTAL_PASSWORD_HASH);
  if (!allowed || !passwordMatches) {
    usbCreatorAuthRateLimits.record(rateKey, now);
    usbCreatorGlobalRateLimits.record(ipKey, now);
    throw httpError(403, "Das Passwort des Erstellerkontos ist nicht korrekt.", "USB_CREATOR_AUTH_FAILED");
  }
  usbCreatorAuthRateLimits.clear(rateKey);
  return {
    personnelNumber: row.employee_number,
    role: row.role,
    passwordHash: row.password_hash,
    employee: row,
  };
}

function usbCandidateOptions() {
  let externalBackupDrive = "";
  try {
    externalBackupDrive = String(backupDirectoryFromSettings(getSettings())).match(/^[a-z]:/i)?.[0] || "";
  } catch {}
  return {
    appPath: __dirname,
    dataPath: dataDirectory,
    excludedDriveLetters: externalBackupDrive ? [externalBackupDrive] : [],
    allowMultiPartition: false,
  };
}

async function usbDriveChoices() {
  const result = await enumerateSafeUsbCandidates(usbCandidateOptions());
  return {
    drives: result.candidates.map((candidate) => ({
      token: createSelectionToken(candidate, usbProvisioningTokenSecret, { candidateOptions: usbCandidateOptions() }),
      driveLetter: candidate.driveLetter,
      label: candidate.label,
      fileSystem: candidate.fileSystem,
      sizeBytes: candidate.sizeBytes,
      freeBytes: candidate.freeBytes,
      model: candidate.diskFriendlyName || "USB-Datenträger",
      expectedConfirmation: expectedFormatConfirmation(candidate.driveLetter),
    })),
    rejectedCount: result.rejected.length,
  };
}

const usbFeatureAliases = Object.freeze({
  planning: "schedule",
  schedule: "schedule",
  vacations: "vacation",
  vacation: "vacation",
  absence_requests: "requests",
  requests: "requests",
  employee_portal: "employeePortal",
  employeePortal: "employeePortal",
  time_tracking: "timeTracking",
  timeTracking: "timeTracking",
  sickness_amu: "sicknessAmu",
  sicknessAmu: "sicknessAmu",
  wifi_time_suggestions: "wifiSuggestions",
  wifiSuggestions: "wifiSuggestions",
});

function validateUsbFeatures(body = {}) {
  const profile = String(body.profile || "custom");
  let submitted = Array.isArray(body.enabledFeatures) ? body.enabledFeatures : [];
  if (profile === "full") submitted = defaultInstallationFeatures;
  if (profile === "planning-vacation") submitted = ["schedule", "vacation", "requests"];
  const enabled = new Set(submitted.map((feature) => usbFeatureAliases[feature] || feature).filter((feature) => installationFeatureIds.has(feature)));
  enabled.add("schedule");
  if (enabled.has("wifiSuggestions")) enabled.add("timeTracking");
  if (enabled.has("sicknessAmu")) enabled.add("requests");
  if (enabled.has("timeTracking") || enabled.has("sicknessAmu") || enabled.has("wifiSuggestions")) enabled.add("employeePortal");
  return [...enabled];
}

function validateUsbSelectedLocations(value) {
  const selected = [...new Set((Array.isArray(value) ? value : []).map((id) => normalizeLocationId(id)))];
  if (!selected.length) throw httpError(400, "Bitte mindestens einen Standort für den Stick auswählen.", "USB_LOCATION_REQUIRED");
  for (const locationId of selected) validateLocationExists(locationId);
  return selected;
}

function validateUsbBrandings(body = {}) {
  const primaryKitId = String(body.primaryBrandingKitId || "neutral").trim();
  const primaryKit = readBrandingKitManifest(primaryKitId);
  const additionalIds = [...new Set((Array.isArray(body.additionalBrandingKitIds) ? body.additionalBrandingKitIds : [])
    .map((kitId) => String(kitId || "").trim()).filter(Boolean))];
  if (additionalIds.length > 30) throw httpError(400, "Es können höchstens 30 zusätzliche Branding-Kits mitgegeben werden.", "USB_BRANDING_LIMIT");
  const kitIds = [...new Set([primaryKitId, ...additionalIds])];
  for (const kitId of kitIds) readBrandingKitManifest(kitId);
  return { primaryKitId, primaryKit, kitIds };
}

function usbRoleAllowedForCreator(creatorRole, requestedRole) {
  if (requestedRole === "employee") return true;
  return Boolean(PORTAL_ROLE_ASSIGNMENTS[creatorRole]?.has(requestedRole));
}

async function validateUsbEmployees(inputEmployees, selectedLocations, creator) {
  const inputs = Array.isArray(inputEmployees) ? inputEmployees.slice(0, 250) : [];
  const result = [];
  const seen = new Set();
  for (const input of inputs) {
    const sourceNumber = String(input.sourcePersonnelNumber || "").trim();
    const personnelNumber = String(input.personnelNumber || sourceNumber || "").trim();
    if (!/^\d{1,12}$/.test(personnelNumber)) throw httpError(400, "Eine Personalnummer im USB-Team ist ungültig.", "USB_EMPLOYEE_INVALID");
    if (personnelNumber === creator.personnelNumber || seen.has(personnelNumber)) continue;
    seen.add(personnelNumber);
    let employee;
    if (sourceNumber) {
      employee = db.prepare(`
        SELECT personnel_number, full_name, nickname, color, contracted_hours, preferred_day_off,
               fixed_workdays, position_id, time_confirmation_level, home_location_id,
               preferred_department_id, active
        FROM employees WHERE personnel_number = ?
      `).get(sourceNumber);
      if (!employee) throw httpError(404, `Teammitglied ${sourceNumber} wurde nicht gefunden.`, "USB_EMPLOYEE_NOT_FOUND");
      employee = { ...employee, personnel_number: personnelNumber };
    } else {
      const fullName = String(input.fullName || "").trim();
      const nickname = String(input.nickname || "").trim();
      const color = String(input.color || "#0b84c6").trim().toLowerCase();
      const contractedHours = Number(input.contractedHours ?? 38.5);
      const positionId = String(input.positionId || "verkaufsmitarbeiter").trim();
      const homeLocationId = String(input.homeLocationId || selectedLocations[0]).trim();
      const preferredDepartmentId = Number(input.preferredDepartmentId || 0) || null;
      if (!fullName || fullName.length > 100 || !nickname || nickname.length > 40 || !/^#[0-9a-f]{6}$/.test(color)
        || !Number.isFinite(contractedHours) || contractedHours < 0 || contractedHours > 80) {
        throw httpError(400, `Die Stammdaten für Personalnummer ${personnelNumber} sind unvollständig.`, "USB_EMPLOYEE_INVALID");
      }
      if (!db.prepare("SELECT 1 FROM positions WHERE id = ?").get(positionId)) throw httpError(400, "Die gewählte Position wurde nicht gefunden.", "USB_EMPLOYEE_POSITION_INVALID");
      if (!selectedLocations.includes(homeLocationId)) throw httpError(400, "Der Standort eines Teammitglieds ist nicht für den Stick ausgewählt.", "USB_EMPLOYEE_LOCATION_INVALID");
      if (preferredDepartmentId) validateDepartmentExists(preferredDepartmentId, homeLocationId);
      employee = {
        personnel_number: personnelNumber,
        full_name: fullName,
        nickname,
        color,
        contracted_hours: contractedHours,
        preferred_day_off: null,
        fixed_workdays: "",
        position_id: positionId,
        time_confirmation_level: "C",
        home_location_id: homeLocationId,
        preferred_department_id: preferredDepartmentId,
        active: 1,
      };
    }
    if (!selectedLocations.includes(String(employee.home_location_id || ""))) {
      throw httpError(400, `Der Standort von ${personnelNumber} ist nicht für den Stick ausgewählt.`, "USB_EMPLOYEE_LOCATION_INVALID");
    }
    const role = String(input.role || "employee").trim();
    if (role === "developer" || !getPortalRoles().some((entry) => entry.id === role) || !usbRoleAllowedForCreator(creator.role, role)) {
      throw httpError(403, `Die Rolle für Personalnummer ${personnelNumber} darf vom Ersteller nicht vergeben werden.`, "USB_EMPLOYEE_ROLE_DENIED");
    }
    if (role === "department_manager") {
      const departmentId = Number(employee.preferred_department_id || 0);
      if (!departmentId) {
        throw httpError(400, `Für die Abteilungsleitung ${personnelNumber} muss eine Abteilung ausgewählt sein.`, "USB_EMPLOYEE_DEPARTMENT_REQUIRED");
      }
      validateDepartmentExists(departmentId, String(employee.home_location_id || ""));
    }
    const password = String(input.startPassword || "");
    const additionalPermissions = [...new Set((Array.isArray(input.additionalPermissions) ? input.additionalPermissions : [])
      .map(String).filter((permission) => delegablePortalPermissions.has(permission)))];
    result.push({
      ...employee,
      personnelNumber,
      role,
      passwordHash: password ? await hashPortalPassword(password) : "",
      additionalPermissions,
    });
  }
  return result;
}

function usbPrimaryBranding(brandingSelection) {
  const raw = brandingSelection.primaryKit.branding || brandingSelection.primaryKit;
  const branding = brandingFromSettings(raw);
  return {
    kitId: brandingSelection.primaryKitId,
    ...branding,
    primaryColor: raw.primaryColor || raw.primary_color || raw.colors?.primary,
    secondaryColor: raw.secondaryColor || raw.secondary_color || raw.colors?.secondary,
    accentColor: raw.accentColor || raw.accent_color || raw.colors?.accent,
    textColor: raw.textColor || raw.text_color || raw.colors?.text,
    backgroundColor: raw.backgroundColor || raw.background_color || raw.colors?.background,
  };
}

function usbFirstStepsSpec(body, primaryBranding, enabledFeatures) {
  const guide = body.firstSteps && typeof body.firstSteps === "object" ? body.firstSteps : {};
  const steps = [];
  if (guide.includeStartup !== false) steps.push({ title: "Grabenplaner starten und sicher beenden", text: "Öffnen Sie im Hauptverzeichnis des USB-Sticks die Datei „Grabenplaner starten.cmd“. Der Browser öffnet sich automatisch. Verwenden Sie zum Beenden den Befehl „Beenden“ im linken Menü und warten Sie, bis Grabenplaner den lokalen Webserver geschlossen hat." });
  if (guide.includePdf !== false) steps.push({ title: "PDFs ablegen", text: "Der Ordner „PDF-Exporte“ im Hauptverzeichnis ist für fertige Dienst- und Urlaubspläne vorbereitet." });
  if (guide.includeBackup !== false) steps.push({ title: "Backups sichern", text: "Mit „Backup erstellen.cmd“ wird eine Sicherung erstellt. Bewahren Sie regelmäßig eine zusätzliche Kopie auf einem zweiten Datenträger auf." });
  if (String(guide.notes || "").trim()) steps.push({ title: "Hinweise für diese Installation", text: String(guide.notes) });
  const labels = installationFeatureCatalog.filter((feature) => enabledFeatures.includes(feature.id)).map((feature) => feature.label);
  return {
    title: guide.title,
    introduction: guide.introduction,
    steps,
    features: guide.includeModules === false ? [] : labels,
    contact: guide.contact,
    closingNote: "Änderungen an Team, Rechten, Branding und Funktionsumfang sind nur für berechtigte Administrationsrollen vorgesehen.",
    versionLabel: APP_VERSION_LABEL,
    branding: {
      ...primaryBranding,
      logo: localAssetPathFromUrl(primaryBranding.logoUrl),
    },
  };
}

function initializeUsbStageDatabase(appDirectory) {
  const targetDatabase = path.join(appDirectory, "data", "dienstplan.db");
  const runtimeNode = path.join(appDirectory, "runtime", "node.exe");
  const nodeExecutable = fs.existsSync(runtimeNode) ? runtimeNode : process.execPath;
  const initializer = path.join(appDirectory, "scripts", "initialize-portable-db.js");
  const result = childProcess.spawnSync(nodeExecutable, [initializer, targetDatabase, appDirectory], {
    cwd: appDirectory,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw httpError(500, `Die frische USB-Datenbank konnte nicht erstellt werden: ${String(result.stderr || result.error?.message || "Unbekannter Fehler").trim().slice(0, 800)}`, "USB_DATABASE_INITIALIZE_FAILED");
  }
  return targetDatabase;
}

function copyUsbBrandingKits(kitIds, appDirectory) {
  const targetRoot = path.join(appDirectory, "data", "branding-kits");
  fs.mkdirSync(targetRoot, { recursive: true });
  for (const kitId of kitIds) {
    if (kitId === "neutral") continue;
    const source = path.resolve(brandingKitsDirectory, kitId);
    const libraryRoot = path.resolve(brandingKitsDirectory);
    if (!source.startsWith(`${libraryRoot}${path.sep}`) || !fs.existsSync(path.join(source, "manifest.json"))) {
      throw httpError(404, `Branding-Kit ${kitId} wurde nicht gefunden.`, "USB_BRANDING_NOT_FOUND");
    }
    fs.cpSync(source, path.join(targetRoot, kitId), { recursive: true, force: true });
  }
}

function protectUsbProgramFiles(appDirectory) {
  const safeApp = path.resolve(appDirectory).replaceAll("'", "''");
  runPowerShell(`
$ErrorActionPreference = 'Stop'
$app = '${safeApp}'
$roots = @('lib','node_modules','public','runtime','scripts','docs')
foreach ($name in $roots) {
  $target = Join-Path $app $name
  if (Test-Path -LiteralPath $target) { Get-ChildItem -LiteralPath $target -Recurse -Force -File | ForEach-Object { $_.IsReadOnly = $true } }
}
Get-ChildItem -LiteralPath $app -Force -File | Where-Object { $_.Name -ne 'portable-layout.json' } | ForEach-Object { $_.IsReadOnly = $true }
`);
}

function consumeUsbTokenOnce(payload) {
  const now = Date.now();
  for (const [nonce, expiresAt] of consumedUsbProvisioningTokens) if (expiresAt < now) consumedUsbProvisioningTokens.delete(nonce);
  if (consumedUsbProvisioningTokens.has(payload.nonce)) throw httpError(409, "Diese USB-Auswahl wurde bereits verwendet.", "USB_TOKEN_ALREADY_USED");
  consumedUsbProvisioningTokens.set(payload.nonce, payload.expiresAt);
}

function normalizeUsbProvisioningError(error) {
  if (error.status) return error;
  const status = /TOKEN|SELECTION|CONFIRM|VOLUME|DRIVE|PATH|LAYOUT|SOURCE/.test(String(error.code || "")) ? 400
    : /POWERSHELL|FORMAT|HIDE/.test(String(error.code || "")) ? 403 : 500;
  const normalized = httpError(status, error.message || "Der USB-Stick konnte nicht vorbereitet werden.", error.code || "USB_PROVISIONING_FAILED");
  if (error.details) normalized.details = error.details;
  return normalized;
}

app.get("/api/usb-provisioning/status", async (request, response) => {
  const access = assertUsbProvisioningRequest(request);
  const { session, ...availability } = access;
  let driveData = { drives: [], rejectedCount: 0 };
  let driveWarning = "";
  try { driveData = await usbDriveChoices(); }
  catch (error) { driveWarning = error.message; }
  response.json({
    ...availability,
    ...driveData,
    driveWarning,
    creators: usbCreatorCandidates(session),
    featureCatalog: installationFeatureCatalog,
    profiles: {
      full: defaultInstallationFeatures,
      "planning-vacation": ["schedule", "vacation", "requests"],
    },
  });
});

app.get("/api/usb-provisioning/drives", async (request, response) => {
  assertUsbProvisioningRequest(request);
  response.json(await usbDriveChoices());
});

app.post("/api/usb-provisioning/first-steps.pdf", async (request, response) => {
  assertUsbProvisioningRequest(request, { mutation: true });
  const enabledFeatures = validateUsbFeatures(request.body || {});
  const brandingSelection = validateUsbBrandings(request.body || {});
  const primaryBranding = usbPrimaryBranding(brandingSelection);
  const buffer = await renderFirstStepsPdf(usbFirstStepsSpec(request.body || {}, primaryBranding, enabledFeatures));
  response.type("application/pdf").setHeader("Content-Disposition", "inline; filename=Erste-Schritte.pdf");
  response.send(buffer);
});

app.put("/api/usb-provisioning/branding/import", express.raw({ type: ["application/zip", "application/json", "application/octet-stream"], limit: "25mb" }), (request, response) => {
  assertUsbProvisioningRequest(request, { mutation: true });
  if (!Buffer.isBuffer(request.body) || request.body.length < 2) throw httpError(400, "Bitte eine Branding-Kit-Datei auswählen.", "USB_BRANDING_IMPORT_INVALID");
  const fileName = decodeURIComponent(request.get("X-Branding-Filename") || "branding-kit.zip");
  if (/\.json$/i.test(fileName)) {
    const kit = JSON.parse(request.body.toString("utf8").replace(/^\uFEFF/, ""));
    const installedKit = installBrandingKit(kit, { fileName });
    response.json({ ok: true, kit: installedKit, kits: listBrandingKits() });
    return;
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-usb-branding-"));
  try {
    const zipPath = path.join(tempRoot, "branding.zip");
    const extractPath = path.join(tempRoot, "extract");
    fs.writeFileSync(zipPath, request.body);
    fs.mkdirSync(extractPath, { recursive: true });
    extractZipArchive(zipPath, extractPath);
    const jsonFile = findKitJsonFile(extractPath);
    if (!jsonFile) throw httpError(400, "In der ZIP-Datei wurde keine Branding-Kit-JSON gefunden.");
    const kit = JSON.parse(fs.readFileSync(jsonFile, "utf8").replace(/^\uFEFF/, ""));
    const installedKit = installBrandingKit(kit, { extractPath, fileName });
    response.json({ ok: true, kit: installedKit, kits: listBrandingKits() });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

app.post("/api/usb-provisioning/create", async (request, response) => {
  const access = assertUsbProvisioningRequest(request, { mutation: true });
  if (usbProvisioningActive) throw httpError(409, "Ein USB-Stick wird bereits vorbereitet.", "USB_PROVISIONING_BUSY");
  usbProvisioningActive = true;
  let stage = null;
  try {
    const body = request.body || {};
    const creator = await verifyUsbCreator(request, body.creatorEmployeeNumber, body.creatorPassword);
    const enabledFeatures = validateUsbFeatures(body);
    const selectedLocations = validateUsbSelectedLocations(body.selectedLocationIds);
    const brandingSelection = validateUsbBrandings(body);
    const primaryBranding = usbPrimaryBranding(brandingSelection);
    const employees = await validateUsbEmployees(body.employees, selectedLocations, creator);
    const firstStepsSpec = usbFirstStepsSpec(body, primaryBranding, enabledFeatures);
    const installationName = validateBrandOptionalText(body.installationName, 80);
    const selectionValidatedAt = Date.now();
    const tokenPayload = verifyTokenEnvelope(body.selectionToken, usbProvisioningTokenSecret, { now: selectionValidatedAt });
    const earlyEnumeration = await enumerateSafeUsbCandidates(usbCandidateOptions());
    const currentCandidate = earlyEnumeration.candidates.find((candidate) => candidate.driveLetter === tokenPayload.identity.driveLetter);
    if (!currentCandidate) throw httpError(409, "Der ausgewählte USB-Stick ist nicht mehr verfügbar.", "USB_SELECTION_NOT_FOUND");
    verifySelectionToken(body.selectionToken, currentCandidate, usbProvisioningTokenSecret, { now: selectionValidatedAt });
    assertFormatConfirmation(body.confirmation, currentCandidate.driveLetter);

    stage = await stagePortableInstallation({
      sourceAppDirectory: __dirname,
      copyOptions: { directories: ["docs", "lib", "node_modules", "public", "runtime", "scripts"] },
      manifestMetadata: {
        appVersion: packageMetadata.version,
        installationName,
        creator: creator.personnelNumber,
        enabledFeatures,
        primaryBrandingKitId: brandingSelection.primaryKitId,
      },
      prepareApp: async ({ stageRoot, appDirectory }) => {
        fs.writeFileSync(path.join(stageRoot, "Backup erstellen.cmd"), "@echo off\r\ncd /d \"%~dp0app\"\r\ncall \"Backup erstellen.cmd\"\r\n", "latin1");
        const targetDatabase = initializeUsbStageDatabase(appDirectory);
        copyUsbBrandingKits(brandingSelection.kitIds, appDirectory);
        fs.writeFileSync(path.join(appDirectory, "portable-layout.json"), `${JSON.stringify({
          format: "grabenplaner-portable-layout",
          version: 1,
          createdAt: new Date().toISOString(),
          installationName,
          hideProgramFolder: body.hideProgramFolder !== false,
          protectProgramFiles: body.protectProgramFiles !== false,
          enabledFeatures,
        }, null, 2)}\n`, "utf8");
        populateUsbProfileDatabase({
          sourceDatabase: db,
          targetDatabasePath: targetDatabase,
          selectedLocationIds: selectedLocations,
          employees,
          creator,
          primaryBranding,
          enabledFeatures,
          permissionCatalog: [...delegablePortalPermissions],
        });
      },
      generateFirstStepsPdf: async () => renderFirstStepsPdf(firstStepsSpec),
    });

    const result = await provisionUsbStick({
      stage,
      selectionToken: body.selectionToken,
      tokenSecret: usbProvisioningTokenSecret,
      confirmation: body.confirmation,
      candidateOptions: usbCandidateOptions(),
      consumeToken: consumeUsbTokenOnce,
      now: selectionValidatedAt,
      hideApp: async (appDirectory) => {
        if (body.protectProgramFiles !== false) protectUsbProgramFiles(appDirectory);
        if (body.hideProgramFolder !== false) await hidePortableAppDirectory(appDirectory);
      },
    });
    auditPortal(access.session?.employeeNumber || creator.personnelNumber, "usb.provision", "volume", result.driveLetter, JSON.stringify({
      installationName,
      employees: employees.length + 1,
      locations: selectedLocations,
      enabledFeatures,
      primaryBrandingKitId: brandingSelection.primaryKitId,
    }));
    response.json({
      ...result,
      installationName,
      creator: creator.personnelNumber,
      employeeCount: employees.length + 1,
      locationCount: selectedLocations.length,
      brandingCount: brandingSelection.kitIds.length,
      enabledFeatures,
      manifestSha256: sha256(JSON.stringify(stage.manifest)),
    });
  } catch (error) {
    throw normalizeUsbProvisioningError(error);
  } finally {
    usbProvisioningActive = false;
    if (stage?.stageRoot) fs.rmSync(stage.stageRoot, { recursive: true, force: true });
  }
});

app.get("/api/settings", (request, response) => {
  if (getPortalStatus().portalEnabled && !request.portalSession?.permissions?.includes("settings:write")) {
    throw httpError(403, "Für die Grundeinstellungen fehlt die Berechtigung.", "PORTAL_PERMISSION_DENIED");
  }
  const context = resolvePlanningContext(request.query || {});
  assertSessionContextScope(request.portalSession, context);
  response.json(settingsForLocation(context.locationId));
});

app.get("/api/branding/export", (request, response) => {
  requirePortalAdminOrLocal(request, "branding:read");
  const kit = brandingKitForExport(request.query);
  response.setHeader("Content-Disposition", contentDispositionHeader("grabenplaner-branding-kit.json"));
  response.json(kit);
});

app.get("/api/branding/export.zip", (request, response) => {
  requirePortalAdminOrLocal(request, "branding:read");
  const kit = brandingKitForExport(request.query);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-branding-zip-"));
  const zipPath = path.join(tempRoot, "grabenplaner-branding-kit.zip");
  let exportRoot = null;
  try {
    exportRoot = writeBrandingKitZip(kit, zipPath);
  } catch (error) {
    if (exportRoot) fs.rmSync(exportRoot, { recursive: true, force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
  response.setHeader("Content-Disposition", contentDispositionHeader("grabenplaner-branding-kit.zip"));
  response.sendFile(zipPath, (error) => {
    if (exportRoot) fs.rmSync(exportRoot, { recursive: true, force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (error && !response.headersSent) response.status(500).json({ error: "Branding-Kit konnte nicht exportiert werden." });
  });
});

app.get("/api/branding/kits", (request, response) => {
  requirePortalAdminOrLocal(request, "branding:read");
  const context = resolvePlanningContext(request.query || {});
  response.json(listBrandingKits(context.locationId));
});

app.get("/api/branding/assignments", (request, response) => {
  requirePortalAdminOrLocal(request, "branding:read");
  response.json({ assignments: locationBrandingAssignments() });
});

app.put("/api/branding/assignments", (request, response) => {
  const actor = requirePortalAdminOrLocal(request, "branding:write");
  const submittedAssignments = Array.isArray(request.body.assignments) ? request.body.assignments : null;
  if (submittedAssignments) {
    if (!submittedAssignments.length || submittedAssignments.length > 250) {
      throw httpError(400, "Bitte mindestens eine und hoechstens 250 Standortzuordnungen uebermitteln.", "BRANDING_ASSIGNMENTS_INVALID");
    }
    const validated = submittedAssignments.map(validateBrandingAssignmentInput);
    if (new Set(validated.map((item) => item.locationId)).size !== validated.length) {
      throw httpError(400, "Jeder Standort darf pro Speichervorgang nur einmal enthalten sein.", "BRANDING_ASSIGNMENTS_DUPLICATE");
    }
    const results = [];
    db.exec("BEGIN");
    try {
      for (const assignment of submittedAssignments) {
        results.push(applyBrandingAssignment(assignment, actor, { manageTransaction: false }));
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    response.json({ ok: true, results, assignments: locationBrandingAssignments(), kits: listBrandingKits() });
    return;
  }
  const result = applyBrandingAssignment(request.body, actor);
  response.json({ ...result, assignments: locationBrandingAssignments(), kits: listBrandingKits(result.locationId) });
});

app.get("/api/branding/preference", (request, response) => {
  requirePortalAdminOrLocal(request, "branding:read");
  response.json(managementBrandingPreference());
});

app.put("/api/branding/preference", (request, response) => {
  const actor = requirePortalAdminOrLocal(request, "branding:write");
  const kitId = String(request.body.kitId || "neutral").trim();
  let brandingInput;
  if (kitId === "custom") brandingInput = request.body.branding || request.body;
  else {
    const kit = readBrandingKitManifest(kitId);
    brandingInput = kit.branding || kit;
  }
  const preference = saveManagementBrandingPreference(kitId, brandingInput, actor.employeeNumber);
  response.json({ ok: true, ...preference, kits: listBrandingKits() });
});

app.delete("/api/branding/kits/:kitId", (request, response) => {
  const actor = requirePortalAdminOrLocal(request, "branding:write");
  const deleted = deleteInstalledBrandingKit(request.params.kitId, actor.employeeNumber);
  response.json({ ok: true, deleted, kits: listBrandingKits(String(request.query.locationId || "")) });
});

app.post("/api/branding/kits/:kitId/apply", (request, response) => {
  const actor = requirePortalAdminOrLocal(request, "branding:write");
  const kit = readBrandingKitManifest(request.params.kitId);
  const context = resolvePlanningContext(request.body || {});
  response.json({
    ...applyBrandingKit(kit, context, actor.employeeNumber),
    kits: listBrandingKits(context.locationId),
  });
});

app.put("/api/branding/import", (request, response) => {
  const actor = requirePortalAdminOrLocal(request, "branding:write");
  const kit = request.body?.kit || request.body || {};
  const installedKit = installBrandingKit(kit, { fileName: request.get("X-Branding-Filename") || "branding-kit.json" });
  const context = resolvePlanningContext(request.body || {});
  response.json({
    ...applyBrandingKit(installedKit, context, actor.employeeNumber),
    kit: installedKit,
    kits: listBrandingKits(context.locationId),
  });
});

app.put("/api/branding/import.zip", express.raw({ type: ["application/zip", "application/x-zip-compressed", "application/octet-stream"], limit: "25mb" }), (request, response) => {
  const actor = requirePortalAdminOrLocal(request, "branding:write");
  if (!Buffer.isBuffer(request.body) || request.body.length < 128) {
    throw httpError(400, "Bitte eine gültige Branding-ZIP-Datei auswählen.");
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-branding-import-"));
  const zipPath = path.join(tempRoot, "branding-kit.zip");
  const extractPath = path.join(tempRoot, "extract");
  try {
    fs.writeFileSync(zipPath, request.body);
    fs.mkdirSync(extractPath, { recursive: true });
    extractZipArchive(zipPath, extractPath);
    const jsonFile = findKitJsonFile(extractPath);
    if (!jsonFile) throw httpError(400, "In der ZIP-Datei wurde keine Branding-Kit-JSON gefunden.");
    const kit = JSON.parse(fs.readFileSync(jsonFile, "utf8").replace(/^\uFEFF/, ""));
    const installedKit = installBrandingKit(kit, {
      extractPath,
      fileName: decodeURIComponent(request.get("X-Branding-Filename") || "branding-kit.zip"),
    });
    const context = resolvePlanningContext(request.query || {});
    response.json({
      ...applyBrandingKit(installedKit, context, actor.employeeNumber),
      kit: installedKit,
      kits: listBrandingKits(context.locationId),
    });
  } catch (error) {
    if (error.status) throw error;
    if (error instanceof SyntaxError) throw httpError(400, "Die Branding-Kit-JSON in der ZIP-Datei ist ungültig.");
    throw error;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function requestHasPermission(request, permission) {
  if (!getPortalStatus().portalEnabled && isLoopbackRequest(request)) return true;
  return Boolean(request.portalSession?.permissions?.includes(permission));
}

function assertRequestPermission(request, permission) {
  if (!requestHasPermission(request, permission)) {
    throw httpError(403, "Für diese Aktion fehlt die Berechtigung.", "PORTAL_PERMISSION_DENIED");
  }
}

function validateOperationModeRequest(requestedMode) {
  const mode = String(requestedMode || DEFAULT_OPERATION_MODE);
  if (!["local", "lan", "server"].includes(mode)) throw httpError(400, "Der ausgewählte Betriebsmodus ist ungültig.");
  if (mode === "server" && !serverModeActive) {
    throw httpError(409, "Der öffentliche Serverbetrieb wird ausschließlich über die geschützte Serverkonfiguration aktiviert.", "SERVER_CONFIGURATION_REQUIRED");
  }
  if (mode === "lan" && getPortalStatus().adminSetupState !== "configured") {
    throw httpError(409, "Bitte zuerst die Admin-Ersteinrichtung abschließen.", "PORTAL_ADMIN_SETUP_REQUIRED");
  }
  return mode;
}

app.put("/api/operation-mode", (request, response) => {
  assertRequestPermission(request, "operation_mode:write");
  const requestedOperationMode = validateOperationModeRequest(request.body.operationMode);
  const update = db.prepare("INSERT INTO settings (key, value) VALUES ('operation_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  update.run(requestedOperationMode);
  const currentRuntimeMode = configuredOperationMode;
  const restartRequired = !serverModeActive && currentRuntimeMode !== requestedOperationMode;
  if (restartRequired) writeRuntimeConfig({ operationMode: requestedOperationMode });
  auditPortal(request.portalSession?.employeeNumber || "local", "operation_mode.update", "settings", "operation_mode", requestedOperationMode);
  response.json({ operationMode: requestedOperationMode, restartRequired, networkUrls: requestedOperationMode === "lan" ? getLanUrls(PORT) : [] });
});

app.put("/api/settings", (request, response) => {
  const body = request.body;
  const currentSettings = getSettings();
  const requestedOperationMode = validateOperationModeRequest(body.operationMode || currentSettings.operation_mode);
  if (requestedOperationMode !== currentSettings.operation_mode) assertRequestPermission(request, "operation_mode:write");
  const scheduleContext = resolvePlanningContext(body);
  const vacationContext = resolvePlanningContext({ ...body, departmentId: null, department: null });
  const scheduleDefaults = defaultSchedulePdfSettings(scheduleContext);
  const vacationDefaults = defaultVacationPdfSettings(vacationContext);
  const pdfTitle = validatePdfText(body.pdfTitle || scheduleDefaults.pdf_title, "den Dienstplan-PDF-Titel");
  const pdfFilenamePrefix = validatePdfText(body.pdfFilenamePrefix || scheduleDefaults.pdf_filename_prefix, "der Dienstplan-PDF-Dateiname", { min: 5, max: 80 });
  const vacationPdfTitle = validatePdfText(body.vacationPdfTitle || vacationDefaults.vacation_pdf_title, "den Urlaubsplaner-PDF-Titel");
  const vacationPdfFilenamePrefix = validatePdfText(body.vacationPdfFilenamePrefix || vacationDefaults.vacation_pdf_filename_prefix, "der Urlaubsplaner-PDF-Dateiname", { min: 5, max: 80 });
  const externalBackupEnabled = body.externalBackupEnabled !== false;
  const backupDirectory = externalBackupEnabled
    ? validateBackupDirectory(body.backupDirectory || defaultBackupDirectorySetting)
    : { stored: String(body.backupDirectory || defaultBackupDirectorySetting).trim() || defaultBackupDirectorySetting };
  const backupIntervalHours = Number(body.backupIntervalHours || 2);
  const vacationPdfCalendarStyle = ["bars", "dots"].includes(String(body.vacationPdfCalendarStyle))
    ? String(body.vacationPdfCalendarStyle)
    : "bars";
  const breakAfterMinutes = Number(body.breakAfterMinutes);
  const breakDurationMinutes = Number(body.breakDurationMinutes);
  const saturdayBonusFrom = String(body.saturdayBonusFrom || "");
  const saturdayBonusFactor = Number(body.saturdayBonusFactor);
  const toastDuration = ["short", "medium", "long"].includes(String(body.toastDuration))
    ? String(body.toastDuration)
    : "medium";
  const brandingValues = brandingValuesFromBody(body.branding || body);
  const brandingSubmitted = Boolean(body.branding);
  if (brandingSubmitted && !(request.portalSession?.permissions?.includes("branding:write") || (!getPortalStatus().portalEnabled && isLoopbackRequest(request)))) {
    throw httpError(403, "Für die Branding-Verwaltung fehlt die Berechtigung.", "PORTAL_PERMISSION_DENIED");
  }
  const currentWeekLockMode = body.currentWeekLockMode === "manual" ? "manual" : "closing";
  const currentWeekLockDay = ["friday", "saturday", "sunday"].includes(String(body.currentWeekLockDay)) ? String(body.currentWeekLockDay) : "saturday";
  const currentWeekLockTime = String(body.currentWeekLockTime || "17:00");
  const rememberLastScheduleOverallPlan = body.rememberLastScheduleOverallPlan === undefined
    ? currentSettings.remember_last_schedule_overall_plan !== "0"
    : body.rememberLastScheduleOverallPlan !== false;
  const rememberLastVacationOverallPlan = body.rememberLastVacationOverallPlan === undefined
    ? currentSettings.remember_last_vacation_overall_plan !== "0"
    : body.rememberLastVacationOverallPlan !== false;

  if (!Number.isInteger(backupIntervalHours) || backupIntervalHours < 1 || backupIntervalHours > 6) {
    throw httpError(400, "Das Backup-Intervall muss zwischen 1 und 6 Stunden liegen.");
  }
  if (!Number.isInteger(breakAfterMinutes) || breakAfterMinutes < 0 || breakAfterMinutes > 1440) {
    throw httpError(400, "Die Pausengrenze ist ungültig.");
  }
  if (!Number.isInteger(breakDurationMinutes) || breakDurationMinutes < 0 || breakDurationMinutes > 240) {
    throw httpError(400, "Die Pausendauer ist ungültig.");
  }
  if (!isTime(saturdayBonusFrom)) throw httpError(400, "Die Startzeit für den Samstagsfaktor ist ungültig.");
  if (!Number.isFinite(saturdayBonusFactor) || saturdayBonusFactor < 1 || saturdayBonusFactor > 5) {
    throw httpError(400, "Der Samstagsfaktor muss zwischen 1 und 5 liegen.");
  }
  if (!isTime(currentWeekLockTime)) throw httpError(400, "Der Sperrzeitpunkt ist ungültig.");
  const lockOrder = { friday: 5, saturday: 6, sunday: 7 }[currentWeekLockDay] * 1440 + timeToMinutes(currentWeekLockTime);
  if (currentWeekLockMode === "manual" && (lockOrder < 5 * 1440 + 18 * 60 || lockOrder > 7 * 1440 + 23 * 60)) {
    throw httpError(400, "Der manuelle Sperrzeitpunkt muss zwischen Freitag 18:00 Uhr und Sonntag 23:00 Uhr liegen.");
  }
  const backupChanged = String(currentSettings.external_backup_enabled || "1") !== (externalBackupEnabled ? "1" : "0")
    || String(currentSettings.backup_directory || "") !== backupDirectory.stored
    || String(currentSettings.backup_interval_hours || "2") !== String(backupIntervalHours);
  if (backupChanged) assertRequestPermission(request, "backup:write");
  const managementViewSettingsChanged = currentSettings.remember_last_schedule_overall_plan !== (rememberLastScheduleOverallPlan ? "1" : "0")
    || currentSettings.remember_last_vacation_overall_plan !== (rememberLastVacationOverallPlan ? "1" : "0");
  if (managementViewSettingsChanged) requireAdminHrOrLocal(request, "hr:settings");

  const values = {
    operation_mode: requestedOperationMode,
    toast_duration: toastDuration,
    show_inactive_personnel: body.showInactivePersonnel === true ? "1" : "0",
    show_saturday_service_stats: body.showSaturdayServiceStats === false ? "0" : "1",
    external_backup_enabled: externalBackupEnabled ? "1" : "0",
    backup_directory: backupDirectory.stored,
    backup_interval_hours: String(backupIntervalHours),
    vacation_count_saturday: body.vacationCountSaturday === true ? "1" : "0",
    vacation_pdf_size: "A4",
    allow_past_week_editing: body.allowPastWeekEditing === true ? "1" : "0",
    current_week_auto_lock: body.currentWeekAutoLock === false ? "0" : "1",
    current_week_lock_mode: currentWeekLockMode,
    current_week_lock_day: currentWeekLockDay,
    current_week_lock_time: currentWeekLockTime,
    break_rule_enabled: body.breakRuleEnabled === false ? "0" : "1",
    break_after_minutes: String(breakAfterMinutes),
    break_duration_minutes: String(breakDurationMinutes),
    saturday_bonus_enabled: body.saturdayBonusEnabled === false ? "0" : "1",
    saturday_bonus_from: saturdayBonusFrom,
    saturday_bonus_factor: String(saturdayBonusFactor),
    show_sunday: body.showSunday === true ? "1" : "0",
    remember_last_schedule_overall_plan: rememberLastScheduleOverallPlan ? "1" : "0",
    remember_last_vacation_overall_plan: rememberLastVacationOverallPlan ? "1" : "0",
  };
  const update = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  db.exec("BEGIN");
  try {
    for (const [key, value] of Object.entries(values)) update.run(key, value);
    if (brandingSubmitted) saveLocationBrandingSnapshot(scheduleContext.locationId, "custom", brandingValues, request.portalSession?.employeeNumber || "local");
    saveScopedPdfSettings("schedule", scheduleContext, {
      pdf_title: pdfTitle,
      pdf_filename_prefix: pdfFilenamePrefix,
      pdf_filename_include_kw: body.pdfFilenameIncludeKw === false ? "0" : "1",
      pdf_filename_include_timestamp: body.pdfFilenameIncludeTimestamp === true ? "1" : "0",
    });
    saveScopedPdfSettings("vacation", vacationContext, {
      vacation_pdf_title: vacationPdfTitle,
      vacation_pdf_filename_prefix: vacationPdfFilenamePrefix,
      vacation_pdf_filename_include_period: body.vacationPdfFilenameIncludePeriod === false ? "0" : "1",
      vacation_pdf_filename_include_timestamp: body.vacationPdfFilenameIncludeTimestamp === true ? "1" : "0",
      vacation_pdf_show_balance: body.vacationPdfShowBalance === false ? "0" : "1",
      vacation_pdf_balance_show_entitlement: body.vacationPdfBalanceShowEntitlement === false ? "0" : "1",
      vacation_pdf_balance_show_planned: body.vacationPdfBalanceShowPlanned === false ? "0" : "1",
      vacation_pdf_balance_show_consumed: body.vacationPdfBalanceShowConsumed === true ? "1" : "0",
      vacation_pdf_calendar_style: vacationPdfCalendarStyle,
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  scheduleAutomaticBackups();
  db.prepare(`
    INSERT INTO portal_settings (key, value, updated_at) VALUES ('login_required', '1', CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = CURRENT_TIMESTAMP
  `).run();
  const currentRuntimeMode = configuredOperationMode;
  const restartRequired = !serverModeActive && currentRuntimeMode !== requestedOperationMode;
  if (restartRequired) writeRuntimeConfig({ operationMode: requestedOperationMode });
  response.json({ ...settingsForLocation(scheduleContext.locationId), restartRequired, networkUrls: requestedOperationMode === "lan" ? getLanUrls(PORT) : [] });
});

app.post("/api/shifts", (request, response) => {
  const shift = validateShift(request.body);
  const locationId = db.prepare("SELECT home_location_id FROM employees WHERE personnel_number = ?").get(shift.employeeNumber)?.home_location_id;
  assertSessionContextScope(request.portalSession, { locationId, departmentId: shift.departmentId });
  const result = db.prepare(`
    INSERT INTO shifts (employee_number, department_id, shift_date, start_time, end_time, area, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(shift.employeeNumber, shift.departmentId, shift.shiftDate, shift.startTime, shift.endTime, shift.area, shift.note);
  invalidateTimeDayReview(shift.employeeNumber, shift.shiftDate);
  refreshSicknessStaffingAfterPlanningChange();
  response.status(201).json({ id: Number(result.lastInsertRowid), ...shift });
});

app.put("/api/shifts/:id", (request, response) => {
  const id = Number(request.params.id);
  const existing = db.prepare("SELECT s.employee_number, s.shift_date, s.department_id, e.home_location_id FROM shifts s JOIN employees e ON e.personnel_number = s.employee_number WHERE s.id = ?").get(id);
  if (!existing) throw httpError(404, "Der Dienst wurde nicht gefunden.");
  assertSessionContextScope(request.portalSession, { locationId: existing.home_location_id, departmentId: existing.department_id });
  assertDateEditable(existing.shift_date, settingsForLocation(existing.home_location_id));
  const shift = validateShift(request.body);
  const nextLocationId = db.prepare("SELECT home_location_id FROM employees WHERE personnel_number = ?").get(shift.employeeNumber)?.home_location_id;
  assertSessionContextScope(request.portalSession, { locationId: nextLocationId, departmentId: shift.departmentId });
  const result = db.prepare(`
    UPDATE shifts
    SET employee_number = ?, department_id = ?, shift_date = ?, start_time = ?, end_time = ?, area = ?, note = ?
    WHERE id = ?
  `).run(shift.employeeNumber, shift.departmentId, shift.shiftDate, shift.startTime, shift.endTime, shift.area, shift.note, id);
  if (!result.changes) throw httpError(404, "Der Dienst wurde nicht gefunden.");
  invalidateTimeDayReview(existing.employee_number, existing.shift_date);
  invalidateTimeDayReview(shift.employeeNumber, shift.shiftDate);
  refreshSicknessStaffingAfterPlanningChange();
  response.json({ id, ...shift });
});

app.delete("/api/shifts/:id", (request, response) => {
  const id = Number(request.params.id);
  const existing = db.prepare("SELECT s.employee_number, s.shift_date, s.department_id, e.home_location_id FROM shifts s JOIN employees e ON e.personnel_number = s.employee_number WHERE s.id = ?").get(id);
  if (!existing) throw httpError(404, "Der Dienst wurde nicht gefunden.");
  assertSessionContextScope(request.portalSession, { locationId: existing.home_location_id, departmentId: existing.department_id });
  assertDateEditable(existing.shift_date, settingsForLocation(existing.home_location_id));
  const result = db.prepare("DELETE FROM shifts WHERE id = ?").run(id);
  if (!result.changes) throw httpError(404, "Der Dienst wurde nicht gefunden.");
  invalidateTimeDayReview(existing.employee_number, existing.shift_date);
  refreshSicknessStaffingAfterPlanningChange();
  response.status(204).end();
});

app.delete("/api/schedule", (request, response) => {
  const weekStart = getMonday(isIsoDate(request.query.week) ? request.query.week : undefined);
  const weekEnd = addDays(weekStart, 6);
  const context = resolvePlanningContext(request.query);
  assertSessionContextScope(request.portalSession, context);
  assertWeekEditable(weekStart, settingsForLocation(context.locationId));
  const departmentFilter = context.departmentId ? "AND department_id = ?" : "";
  const params = context.departmentId
    ? [weekStart, weekEnd, context.locationId, context.departmentId]
    : [weekStart, weekEnd, context.locationId];
  const result = db.prepare(`
    DELETE FROM shifts
    WHERE shift_date BETWEEN ? AND ?
      AND employee_number IN (SELECT personnel_number FROM employees WHERE home_location_id = ?)
      ${departmentFilter}
  `).run(...params);
  invalidateTimeDayReviewsForRange(context.locationId, weekStart, weekEnd, context.departmentId);
  refreshSicknessStaffingAfterPlanningChange();
  response.json({ deleted: Number(result.changes), weekStart, weekEnd });
});

app.post("/api/week-options", (request, response) => {
  const option = validateWeekOption(request.body);
  assertSessionEmployeeScope(request.portalSession, option.employeeNumber);
  const result = db.prepare(`
    INSERT INTO week_options
      (employee_number, group_id, week_start, date_from, date_to, option_type, note, credited_minutes_per_day, all_day, start_time, end_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    option.employeeNumber,
    option.groupId,
    option.weekStart,
    option.dateFrom,
    option.dateTo,
    option.optionType,
    option.note,
    option.creditedMinutesPerDay,
    option.allDay,
    option.startTime,
    option.endTime,
  );
  for (let date = option.dateFrom; date <= option.dateTo; date = addDays(date, 1)) invalidateTimeDayReview(option.employeeNumber, date);
  response.status(201).json({ id: Number(result.lastInsertRowid), ...option });
});

app.put("/api/week-options/:id", (request, response) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, "Die Planungsoption ist ungültig.");
  const existing = db.prepare("SELECT group_id, week_start, employee_number, date_from, date_to FROM week_options WHERE id = ?").get(id);
  if (!existing) {
    throw httpError(404, "Die Planungsoption wurde nicht gefunden.");
  }
  assertSessionEmployeeScope(request.portalSession, existing.employee_number);
  const existingLocation = db.prepare("SELECT home_location_id FROM employees WHERE personnel_number = ?").get(existing.employee_number)?.home_location_id;
  assertWeekEditable(existing.week_start, settingsForLocation(existingLocation));
  const option = validateWeekOption({
    ...request.body,
    groupId: request.body.groupId === undefined ? existing.group_id : request.body.groupId,
  }, id);
  assertSessionEmployeeScope(request.portalSession, option.employeeNumber);
  db.prepare(`
    UPDATE week_options
    SET employee_number = ?, group_id = ?, week_start = ?, date_from = ?, date_to = ?,
        option_type = ?, note = ?, credited_minutes_per_day = ?, all_day = ?, start_time = ?, end_time = ?
    WHERE id = ?
  `).run(
    option.employeeNumber,
    option.groupId,
    option.weekStart,
    option.dateFrom,
    option.dateTo,
    option.optionType,
    option.note,
    option.creditedMinutesPerDay,
    option.allDay,
    option.startTime,
    option.endTime,
    id,
  );
  for (let date = existing.date_from; date <= existing.date_to; date = addDays(date, 1)) invalidateTimeDayReview(existing.employee_number, date);
  for (let date = option.dateFrom; date <= option.dateTo; date = addDays(date, 1)) invalidateTimeDayReview(option.employeeNumber, date);
  response.json({ id, ...option });
});

app.delete("/api/week-options/:id", (request, response) => {
  const id = Number(request.params.id);
  const existing = db.prepare("SELECT week_start, employee_number, date_from, date_to FROM week_options WHERE id = ?").get(id);
  if (!existing) throw httpError(404, "Die Planungsoption wurde nicht gefunden.");
  assertSessionEmployeeScope(request.portalSession, existing.employee_number);
  const existingLocation = db.prepare("SELECT home_location_id FROM employees WHERE personnel_number = ?").get(existing.employee_number)?.home_location_id;
  assertWeekEditable(existing.week_start, settingsForLocation(existingLocation));
  const result = db.prepare("DELETE FROM week_options WHERE id = ?").run(id);
  if (!result.changes) throw httpError(404, "Die Planungsoption wurde nicht gefunden.");
  for (let date = existing.date_from; date <= existing.date_to; date = addDays(date, 1)) invalidateTimeDayReview(existing.employee_number, date);
  response.status(204).end();
});

app.post("/api/global-day-blocks", (request, response) => {
  const block = validateGlobalDayBlock(request.body);
  assertSessionContextScope(request.portalSession, { locationId: block.locationId });
  const result = db.prepare(`
    INSERT INTO global_day_blocks (location_id, week_start, block_date, reason, is_public_holiday)
    VALUES (?, ?, ?, ?, ?)
  `).run(block.locationId, block.weekStart, block.blockDate, block.reason, block.isPublicHoliday);
  response.status(201).json({ id: Number(result.lastInsertRowid), ...block, schedule: getSchedule(block.weekStart, { locationId: block.locationId }, request.portalSession) });
});

app.put("/api/global-day-blocks/:id", (request, response) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, "Der Sperrtag ist ungültig.");
  const existing = db.prepare("SELECT week_start, location_id FROM global_day_blocks WHERE id = ?").get(id);
  if (!existing) throw httpError(404, "Der Sperrtag wurde nicht gefunden.");
  assertSessionContextScope(request.portalSession, { locationId: existing.location_id });
  assertWeekEditable(existing.week_start, settingsForLocation(existing.location_id));
  const block = validateGlobalDayBlock(request.body, id);
  assertSessionContextScope(request.portalSession, { locationId: block.locationId });
  db.prepare(`
    UPDATE global_day_blocks
    SET location_id = ?, week_start = ?, block_date = ?, reason = ?, is_public_holiday = ?
    WHERE id = ?
  `).run(block.locationId, block.weekStart, block.blockDate, block.reason, block.isPublicHoliday, id);
  response.json({ id, ...block, schedule: getSchedule(block.weekStart, { locationId: block.locationId }, request.portalSession) });
});

app.delete("/api/global-day-blocks/:id", (request, response) => {
  const id = Number(request.params.id);
  const existing = db.prepare("SELECT week_start, location_id FROM global_day_blocks WHERE id = ?").get(id);
  if (!existing) throw httpError(404, "Der Sperrtag wurde nicht gefunden.");
  assertSessionContextScope(request.portalSession, { locationId: existing.location_id });
  assertWeekEditable(existing.week_start, settingsForLocation(existing.location_id));
  const result = db.prepare("DELETE FROM global_day_blocks WHERE id = ?").run(id);
  if (!result.changes) throw httpError(404, "Der Sperrtag wurde nicht gefunden.");
  response.status(204).end();
});

app.get("/api/vacations", (request, response) => {
  response.json(getVacationPlan(request.query.year, request.query, request.portalSession));
});

app.put("/api/vacation-entitlements", (request, response) => {
  const year = validateYear(request.body.year);
  const entries = Array.isArray(request.body.entries) ? request.body.entries : [];
  const employeeExists = db.prepare("SELECT 1 FROM employees WHERE personnel_number = ?");
  const upsert = db.prepare(`
    INSERT INTO vacation_entitlements (employee_number, year, days, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number, year)
    DO UPDATE SET days = excluded.days, updated_at = CURRENT_TIMESTAMP
  `);

  db.exec("BEGIN");
  try {
    for (const entry of entries) {
      const employeeNumber = String(entry.employeeNumber || "").trim();
      const days = Number(entry.days || 0);
      if (!employeeExists.get(employeeNumber)) {
        throw httpError(404, "Ein ausgewähltes Teammitglied wurde nicht gefunden.");
      }
      assertSessionEmployeeScope(request.portalSession, employeeNumber);
      if (!Number.isFinite(days) || days < 0 || days > 365) {
        throw httpError(400, "Der Jahresurlaub muss zwischen 0 und 365 Tagen liegen.");
      }
      upsert.run(employeeNumber, year, days);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  response.json(getVacationPlan(year, request.body, request.portalSession));
});

app.post("/api/vacations", (request, response) => {
  const vacation = validateVacationEntry(request.body);
  assertSessionEmployeeScope(request.portalSession, vacation.employeeNumber);
  const result = createVacationEntries(vacation);
  response.status(201).json({
    groupId: result.groupId,
    plan: getVacationPlan(new Date(`${vacation.dateFrom}T12:00:00Z`).getUTCFullYear(), request.body, request.portalSession),
  });
});

app.put("/api/vacations/:groupId", (request, response) => {
  const groupId = String(request.params.groupId || "").trim();
  if (!groupId || !vacationGroupExists(groupId)) {
    throw httpError(404, "Der Urlaubseintrag wurde nicht gefunden.");
  }
  const existingEmployee = db.prepare("SELECT employee_number FROM week_options WHERE group_id = ? LIMIT 1").get(groupId)?.employee_number;
  assertSessionEmployeeScope(request.portalSession, existingEmployee);
  const vacation = validateVacationEntry(request.body, groupId);
  assertSessionEmployeeScope(request.portalSession, vacation.employeeNumber);
  const result = replaceVacationGroup(groupId, vacation);
  response.json({
    groupId: result.groupId,
    plan: getVacationPlan(new Date(`${vacation.dateFrom}T12:00:00Z`).getUTCFullYear(), request.body, request.portalSession),
  });
});

app.delete("/api/vacations/:groupId", (request, response) => {
  const existingEmployee = db.prepare("SELECT employee_number FROM week_options WHERE group_id = ? LIMIT 1").get(request.params.groupId)?.employee_number;
  if (!existingEmployee) throw httpError(404, "Der Urlaubseintrag wurde nicht gefunden.");
  assertSessionEmployeeScope(request.portalSession, existingEmployee);
  const result = deleteVacationGroup(request.params.groupId);
  if (!result) throw httpError(404, "Der Urlaubseintrag wurde nicht gefunden.");
  response.status(204).end();
});

function minutesToTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function shiftCoversPeriod(shift, from, to) {
  return shift.start_time <= from && shift.end_time >= to;
}

function findBestAutomaticShift(employeeNumber, date, remainingMinutes, settings, requiredTo = null) {
  const hours = operatingHours(date, settings);
  if (!hours) return null;
  const start = timeToMinutes(hours.start);
  const end = timeToMinutes(hours.end);
  const minimumEnd = requiredTo ? Math.max(start + 60, timeToMinutes(requiredTo)) : start + 60;
  let best = null;

  for (let candidateEnd = minimumEnd; candidateEnd <= end; candidateEnd += 1) {
    const shift = {
      employee_number: employeeNumber,
      shift_date: date,
      start_time: minutesToTime(start),
      end_time: minutesToTime(candidateEnd),
    };
    const metrics = shiftMetrics(shift, settings);
    const difference = Math.abs(metrics.counted_minutes - remainingMinutes);
    if (!best || difference < best.difference) best = { shift, metrics, difference };
  }
  return best;
}

app.post("/api/schedule/auto", (request, response) => {
  const weekStart = getMonday(isIsoDate(request.body.weekStart) ? request.body.weekStart : undefined);
  const weekEnd = addDays(weekStart, 6);
  const replaceExisting = request.body.replaceExisting === true;
  const context = resolvePlanningContext(request.body);
  assertSessionContextScope(request.portalSession, context);
  const settings = settingsForLocation(context.locationId);
  const employeeFilter = employeeLocationFilterSql(context, "e");
  assertWeekEditable(weekStart, settings);
  const globalDayBlocks = getGlobalDayBlocksForRange(weekStart, weekEnd, context.locationId);
  const globalBlockDates = new Set(globalDayBlocks.map((block) => block.block_date));
  const employees = db.prepare(`
    SELECT e.personnel_number, e.contracted_hours, e.preferred_day_off, e.fixed_workdays, e.home_location_id, e.preferred_department_id
    FROM employees e
    WHERE e.active = 1 AND ${employeeFilter.sql}
    ORDER BY CAST(e.personnel_number AS INTEGER), e.personnel_number
  `).all(...employeeFilter.values);
  const insertShift = db.prepare(`
    INSERT INTO shifts (employee_number, department_id, shift_date, start_time, end_time, area, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN");
  try {
    if (replaceExisting) {
      const departmentFilter = context.departmentId ? "AND department_id = ?" : "";
      const params = context.departmentId
        ? [weekStart, weekEnd, context.locationId, context.departmentId]
        : [weekStart, weekEnd, context.locationId];
      db.prepare(`
        DELETE FROM shifts
        WHERE shift_date BETWEEN ? AND ?
          AND employee_number IN (SELECT personnel_number FROM employees WHERE home_location_id = ?)
          ${departmentFilter}
      `).run(...params);
    }

    const shiftDepartmentFilter = context.departmentId ? "AND s.department_id = ?" : "";
    const existingShiftValues = context.departmentId
      ? [weekStart, weekEnd, context.locationId, context.departmentId]
      : [weekStart, weekEnd, context.locationId];
    const existingShifts = db.prepare(`
      SELECT s.employee_number, s.department_id, s.shift_date, s.start_time, s.end_time
      FROM shifts s
      JOIN employees e ON e.personnel_number = s.employee_number
      WHERE s.shift_date BETWEEN ? AND ?
        AND e.home_location_id = ?
        ${shiftDepartmentFilter}
    `).all(...existingShiftValues);
    const options = db.prepare(`
      SELECT o.employee_number, o.date_from, o.date_to, o.option_type,
             o.credited_minutes_per_day, o.all_day, o.start_time, o.end_time,
             e.contracted_hours
      FROM week_options o
      JOIN employees e ON e.personnel_number = o.employee_number
      WHERE o.week_start = ? AND ${employeeFilter.sql}
    `).all(weekStart, ...employeeFilter.values);
    const occupied = new Set(existingShifts.map((shift) => `${shift.employee_number}|${shift.shift_date}`));
    const unavailable = new Set();
    for (const option of options) {
      for (let date = option.date_from; date <= option.date_to; date = addDays(date, 1)) {
        unavailable.add(`${option.employee_number}|${date}`);
      }
    }
    for (let date = weekStart; date <= weekEnd; date = addDays(date, 1)) {
      for (const employeeNumber of activeSicknessEmployeeNumbers(date)) {
        unavailable.add(`${employeeNumber}|${date}`);
      }
    }

    const totals = Object.fromEntries(employees.map((employee) => [employee.personnel_number, 0]));
    const dayLoads = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [addDays(weekStart, index), 0]));
    for (const shift of existingShifts) {
      totals[shift.employee_number] =
        (totals[shift.employee_number] || 0) + shiftMetrics(shift, settings).counted_minutes;
      if (dayLoads[shift.shift_date] !== undefined) dayLoads[shift.shift_date] += 1;
    }
    for (const option of options) {
      totals[option.employee_number] =
        (totals[option.employee_number] || 0) +
        optionMinutesPerDay(option, option.contracted_hours) * countCreditedOptionDays(option, settings, context.locationId);
    }
    const creditedHolidayDates = new Set();
    for (const holiday of publicHolidaysForRange(weekStart, weekEnd)) {
      if ([0, 6].includes(new Date(`${holiday.date}T12:00:00Z`).getUTCDay())) continue;
      for (const employee of employees) {
        if (hasNonVacationCreditOnDate(options, employee.personnel_number, holiday.date)) continue;
        totals[employee.personnel_number] =
          (totals[employee.personnel_number] || 0) + holidayCreditMinutes(employee);
      }
      creditedHolidayDates.add(holiday.date);
    }
    for (const block of globalDayBlocks) {
      if (!block.is_public_holiday || creditedHolidayDates.has(block.block_date)) continue;
      if ([0, 6].includes(new Date(`${block.block_date}T12:00:00Z`).getUTCDay())) continue;
      for (const employee of employees) {
        if (hasNonVacationCreditOnDate(options, employee.personnel_number, block.block_date)) continue;
        totals[employee.personnel_number] =
          (totals[employee.personnel_number] || 0) + holidayCreditMinutes(employee);
      }
    }

    let created = 0;
    const warnings = [];
    const remainingByEmployee = Object.fromEntries(
      employees.map((employee) => [
        employee.personnel_number,
        Math.max(0, Number(employee.contracted_hours) * 60 - (totals[employee.personnel_number] || 0)),
      ]),
    );
    const automaticDepartmentId = (employee) => context.departmentId || employee.preferred_department_id || null;

    for (let dayIndex = 0; dayIndex < 6; dayIndex += 1) {
      const date = addDays(weekStart, dayIndex);
      if (globalBlockDates.has(date)) continue;
      const config = dayConfiguration(date, settings, context);
      let coverage = existingShifts.filter(
        (shift) => shift.shift_date === date && shiftCoversPeriod(shift, config.minFrom, config.minTo),
      ).length;

      while (coverage < config.minStaff) {
        const candidates = employees
          .filter((employee) => !occupied.has(`${employee.personnel_number}|${date}`))
          .filter((employee) => !unavailable.has(`${employee.personnel_number}|${date}`))
          .filter((employee) => employeeCanWorkOnDate(employee, date))
          .sort((a, b) => {
            const aPreferred = a.preferred_day_off === config.key ? 1 : 0;
            const bPreferred = b.preferred_day_off === config.key ? 1 : 0;
            if (aPreferred !== bPreferred) return aPreferred - bPreferred;
            return remainingByEmployee[b.personnel_number] - remainingByEmployee[a.personnel_number];
          });
        const employee = candidates[0];
        if (!employee) break;
        const candidate = findBestAutomaticShift(
          employee.personnel_number,
          date,
          remainingByEmployee[employee.personnel_number],
          settings,
          config.minTo,
        );
        if (!candidate) break;
        insertShift.run(
          employee.personnel_number,
          automaticDepartmentId(employee),
          date,
          candidate.shift.start_time,
          candidate.shift.end_time,
          "Mindestbesetzung",
          "Automatisch erstellt",
        );
        occupied.add(`${employee.personnel_number}|${date}`);
        existingShifts.push(candidate.shift);
        created += 1;
        coverage += 1;
        dayLoads[date] += 1;
        remainingByEmployee[employee.personnel_number] = Math.max(
          0,
          remainingByEmployee[employee.personnel_number] - candidate.metrics.counted_minutes,
        );
      }
      if (coverage < config.minStaff) {
        warnings.push(
          `${date}: Mindestbesetzung ${config.minStaff} von ${config.minFrom} bis ${config.minTo} nicht erreichbar.`,
        );
      }
    }

    employees.forEach((employee, employeeIndex) => {
      let remaining = remainingByEmployee[employee.personnel_number];
      const availableDates = Array.from({ length: 6 }, (_, index) => addDays(weekStart, index))
        .filter((date) => !globalBlockDates.has(date))
        .filter((date) => !occupied.has(`${employee.personnel_number}|${date}`))
        .filter((date) => !unavailable.has(`${employee.personnel_number}|${date}`))
        .filter((date) => employeeCanWorkOnDate(employee, date));

      while (remaining >= 30 && availableDates.length) {
        availableDates.sort((a, b) => {
          const preferredDifference =
            Number(dayKeyForDate(a) === employee.preferred_day_off) -
            Number(dayKeyForDate(b) === employee.preferred_day_off);
          if (preferredDifference) return preferredDifference;
          const loadDifference = dayLoads[a] - dayLoads[b];
          if (loadDifference) return loadDifference;
          const rotatedA = (Number(a.slice(-2)) + employeeIndex) % 6;
          const rotatedB = (Number(b.slice(-2)) + employeeIndex) % 6;
          return rotatedA - rotatedB;
        });
        const date = availableDates.shift();
        const candidate = findBestAutomaticShift(employee.personnel_number, date, remaining, settings);
        if (!candidate) continue;
        insertShift.run(
          employee.personnel_number,
          automaticDepartmentId(employee),
          date,
          candidate.shift.start_time,
          candidate.shift.end_time,
          "Automatisch geplant",
          "Automatisch erstellt",
        );
        created += 1;
        occupied.add(`${employee.personnel_number}|${date}`);
        dayLoads[date] += 1;
        remaining = Math.max(0, remaining - candidate.metrics.counted_minutes);
      }
      if (remaining >= 30) {
        warnings.push(`${employee.personnel_number}: ${formatHours(remaining)} konnten nicht eingeplant werden.`);
      }
    });

    invalidateTimeDayReviewsForRange(context.locationId, weekStart, weekEnd, context.departmentId);
    db.exec("COMMIT");
    refreshSicknessStaffingAfterPlanningChange();
    response.json({ created, warnings, schedule: getSchedule(weekStart, context, request.portalSession) });
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
});

function formatDateGerman(isoDate, withYear = true) {
  return new Intl.DateTimeFormat("de-AT", {
    day: "2-digit",
    month: "2-digit",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

function formatHours(minutes) {
  return `${(minutes / 60).toLocaleString("de-AT", { minimumFractionDigits: 1, maximumFractionDigits: 2 })} h`;
}

function formatPdfTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("de-AT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Vienna",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${value("day")}.${value("month")}.${value("year")}, ${value("hour")}:${value("minute")}`;
}

function formatFilenameTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("de-AT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Vienna",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}_${value("hour")}-${value("minute")}`;
}

function sanitizeFilenamePart(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function buildPdfFilename(schedule, createdAt = new Date()) {
  const prefix = sanitizeFilenamePart(schedule.settings.pdf_filename_prefix || schedule.settings.pdf_title || "Dienstplan");
  const parts = [prefix || "Dienstplan"];
  if (settingEnabled(schedule.settings, "pdf_filename_include_kw")) parts.push(`KW${schedule.calendarWeek}`);
  if (settingEnabled(schedule.settings, "pdf_filename_include_timestamp")) parts.push(formatFilenameTimestamp(createdAt));
  return `${parts.join(" ")}.pdf`;
}

function contentDispositionHeader(filename) {
  const fallback = sanitizeFilenamePart(
    filename.normalize("NFKD").replace(/[^\x20-\x7E]/g, ""),
  ).replace(/"/g, "") || "Dienstplan.pdf";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function optionLabel(type) {
  return {
    vacation: "Urlaub",
    sick: "Krank",
    branch: "Andere Filiale",
    vocational_school: "Berufsschule",
    school: "Schulung",
    time_off: "Zeitausgleich",
    special_leave: "Sonderurlaub",
    external_appointment: "Außer-Haus-Termin",
    team_meeting: "Teamsitzung",
    other: "Sonstiges",
  }[type] || type;
}

function hexToRgb(hex) {
  const normalized = hex.replace("#", "");
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
}

function contrastColor(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (r * 299 + g * 587 + b * 114) / 1000 > 155 ? "#15202f" : "#ffffff";
}

function formatOptionDateRange(option) {
  return option.date_from === option.date_to
    ? formatDateGerman(option.date_from, false)
    : `${formatDateGerman(option.date_from, false)}–${formatDateGerman(option.date_to, false)}`;
}

function formatOptionTimeRange(option) {
  return optionIsAllDay(option) ? "ganztägig" : `${option.start_time}–${option.end_time}`;
}

function optionRemarkColumn(option) {
  if (["vacation", "time_off", "special_leave"].includes(option.option_type)) return "leave";
  if (["vocational_school", "school"].includes(option.option_type)) return "school";
  return "other";
}

function optionRemarkText(option) {
  if (option.global_day) {
    return `Alle: ${option.reason || option.holiday_name || "Tag gesperrt"} · ${formatDateGerman(option.block_date, false)}${
      option.is_public_holiday ? " · Feiertag" : ""
    }`;
  }
  return `${option.nickname}: ${optionLabel(option.option_type)} · ${formatOptionDateRange(option)} · ${formatOptionTimeRange(option)}${
    option.note ? ` · ${option.note}` : ""
  }`;
}

function monthName(monthNumber, format = "long") {
  return new Intl.DateTimeFormat("de-AT", { month: format, timeZone: "UTC" }).format(
    new Date(Date.UTC(2026, monthNumber - 1, 1, 12)),
  );
}

function vacationSelectionFromQuery(query) {
  const year = validateYear(query.year);
  const view = ["year", "quarter", "month", "employees"].includes(String(query.view)) ? String(query.view) : "year";
  let start = `${year}-01-01`;
  let end = `${year}-12-31`;
  let title = `Jahresübersicht ${year}`;
  let months = Array.from({ length: 12 }, (_item, index) => index + 1);

  if (view === "employees") {
    title = `Teamübersicht ${year}`;
  }

  if (view === "quarter") {
    const quarter = Math.min(4, Math.max(1, Number.parseInt(query.quarter, 10) || 1));
    const startMonth = (quarter - 1) * 3 + 1;
    start = monthStart(year, startMonth - 1);
    end = monthEnd(year, startMonth + 1);
    title = `${quarter}. Quartal ${year}`;
    months = [startMonth, startMonth + 1, startMonth + 2];
  }

  if (view === "month") {
    const month = Math.min(12, Math.max(1, Number.parseInt(query.month, 10) || 1));
    start = monthStart(year, month - 1);
    end = monthEnd(year, month - 1);
    title = `${monthName(month)} ${year}`;
    months = [month];
  }

  return { year, view, start, end, title, months };
}

function buildVacationPdfFilename(settings, selection, createdAt = new Date()) {
  const prefix = sanitizeFilenamePart(settings.vacation_pdf_filename_prefix || settings.vacation_pdf_title || "Urlaubsplanung");
  const parts = [prefix || "Urlaubsplanung"];
  if (settingEnabled(settings, "vacation_pdf_filename_include_period")) {
    parts.push(selection.view === "year" ? `Jahr ${selection.year}` : selection.title);
  }
  if (settingEnabled(settings, "vacation_pdf_filename_include_timestamp")) {
    parts.push(formatFilenameTimestamp(createdAt));
  }
  return `${parts.join(" ")}.pdf`;
}

function filteredVacationsForSelection(plan, selection) {
  return plan.vacations
    .filter((vacation) => overlapDateRange(vacation.date_from, vacation.date_to, selection.start, selection.end))
    .map((vacation) => {
      const clippedFrom = vacation.date_from < selection.start ? selection.start : vacation.date_from;
      const clippedTo = vacation.date_to > selection.end ? selection.end : vacation.date_to;
      return {
        ...vacation,
        selection_days: vacationDayCount(clippedFrom, clippedTo, plan.settings, plan.context?.locationId),
        selection_from: clippedFrom,
        selection_to: clippedTo,
      };
    });
}

function vacationDateRangeText(from, to, withYear = false) {
  return from === to
    ? formatDateGerman(from, withYear)
    : `${formatDateGerman(from, withYear)}–${formatDateGerman(to, withYear)}`;
}

function formatVacationDays(days) {
  return `${Number(days || 0).toLocaleString("de-AT", { minimumFractionDigits: days % 1 ? 1 : 0, maximumFractionDigits: 1 })} T`;
}

function formatVacationDaysLong(days) {
  const value = Number(days || 0);
  const formatted = value.toLocaleString("de-AT", {
    minimumFractionDigits: value % 1 ? 1 : 0,
    maximumFractionDigits: 1,
  });
  return `${formatted} ${value === 1 ? "Tag" : "Tage"}`;
}

function formatShortDateGerman(date = new Date()) {
  return new Intl.DateTimeFormat("de-AT", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
    timeZone: "Europe/Vienna",
  }).format(date);
}

function vacationWeeksText(days) {
  const value = Math.max(0, Number(days || 0));
  const weeks = Math.floor(value / 5);
  const remainder = value - weeks * 5;
  const dayText = formatVacationDaysLong(remainder);
  return `${weeks} ${weeks === 1 ? "Woche" : "Wochen"} ${dayText}`;
}

function formatVacationDaysWithWeeks(days) {
  return `${formatVacationDaysLong(days)} (${vacationWeeksText(days)})`;
}

function monthCalendarRange(year, monthNumber) {
  const first = monthStart(year, monthNumber - 1);
  const last = monthEnd(year, monthNumber - 1);
  const start = getMonday(first);
  const end = addDays(getMonday(last), 6);
  return { start, end };
}

function vacationsOnDate(vacations, date) {
  return vacations.filter((vacation) => date >= vacation.date_from && date <= vacation.date_to);
}

function drawVacationBars(doc, plan, vacations, monthFrom, monthTo, cells, compact) {
  const laneEmployees = compact
    ? [...new Set(vacations.map((vacation) => vacation.employee_number))]
    : plan.employees.map((employee) => employee.personnel_number);
  const employeeIndex = Object.fromEntries(laneEmployees.map((employeeNumber, index) => [employeeNumber, index]));
  const laneCount = Math.max(1, compact ? laneEmployees.length : Math.min(plan.employees.length, 8));
  const sampleCell = Object.values(cells)[0];
  const availableLaneHeight = Math.max(6, (sampleCell?.height || (compact ? 18 : 36)) - (compact ? 13 : 17));
  const barGap = compact ? 0.55 : 1.2;
  const barHeight = compact
    ? Math.max(1.15, Math.min(2.6, availableLaneHeight / laneCount - barGap))
    : Math.max(3.4, Math.min(6.2, availableLaneHeight / Math.max(1, laneCount) - barGap));
  const topOffset = compact ? 10.5 : 13.5;

  for (const vacation of vacations) {
    const clippedFrom = vacation.date_from < monthFrom ? monthFrom : vacation.date_from;
    const clippedTo = vacation.date_to > monthTo ? monthTo : vacation.date_to;
    if (clippedTo < clippedFrom) continue;
    const lane = (employeeIndex[vacation.employee_number] ?? 0) % laneCount;
    let segmentStart = clippedFrom;
    while (segmentStart <= clippedTo) {
      const segmentWeekEnd = addDays(getMonday(segmentStart), 6);
      const segmentEnd = segmentWeekEnd < clippedTo ? segmentWeekEnd : clippedTo;
      const startCell = cells[segmentStart];
      const endCell = cells[segmentEnd];
      if (startCell && endCell) {
        const barX = startCell.x + 2;
        const barY = startCell.y + topOffset + lane * (barHeight + barGap);
        const barWidth = endCell.x + endCell.width - startCell.x - 4;
        if (barWidth > 2 && barY + barHeight < startCell.y + startCell.height - 2) {
          doc.save();
          doc.fillOpacity(0.92).fillColor(vacation.color).roundedRect(barX, barY, barWidth, barHeight, barHeight / 2).fill();
          doc.fillOpacity(1);
          if (!compact && barWidth > 34) {
            doc.fillColor(contrastColor(vacation.color)).font("Helvetica-Bold").fontSize(4.7).text(vacation.nickname, barX + 3, barY + 0.65, {
              width: barWidth - 6,
              ellipsis: true,
              lineBreak: false,
            });
          }
          doc.restore();
        }
      }
      segmentStart = addDays(segmentEnd, 1);
    }
  }
}

function drawVacationPdfHeader(doc, title, selection, left, width, size) {
  doc.fillColor("#142033").font("Helvetica-Bold").fontSize(size === "A3" ? 19 : 15.5).text(
    `${title} · ${selection.title}`,
    left,
    20,
    { width },
  );
  doc
    .fillColor("#6b7684")
    .font("Helvetica")
    .fontSize(7.2)
    .text(`Zeitraum ${vacationDateRangeText(selection.start, selection.end, true)}`, left, 42, { width });
}

function drawVacationPdfFooter(doc, left, pageWidth, pageHeight, createdAt, settings = getSettings()) {
  doc
    .fillColor("#6b7684")
    .font("Helvetica-Bold")
    .fontSize(5.7)
    .text(`Urlaubsplanung erstellt mit: ${APP_NAME} ${APP_VERSION_LABEL}`, left, pageHeight - 24);
  doc
    .font("Helvetica")
    .text(
      pdfFooterContact(settings, createdAt),
      pageWidth - 310,
      pageHeight - 24,
      { width: 284, align: "right" },
    );
}

function vacationBalanceParts(settings, totals) {
  const parts = [`Rest ${formatVacationDays(totals.remaining)}`];
  if (settingEnabled(settings, "vacation_pdf_balance_show_entitlement")) {
    parts.push(`Jahr ${formatVacationDays(totals.entitlement)}`);
  }
  if (settingEnabled(settings, "vacation_pdf_balance_show_planned")) {
    parts.push(`geplant ${formatVacationDays(totals.planned ?? totals.used)}`);
  }
  if (settingEnabled(settings, "vacation_pdf_balance_show_consumed")) {
    parts.push(`konsumiert ${formatVacationDays(totals.consumed)}`);
  }
  return parts;
}

function drawVacationBalanceSummary(doc, plan, x, y, width, createdAt = new Date()) {
  if (!settingEnabled(plan.settings, "vacation_pdf_show_balance")) return y;
  const employees = plan.employees || [];
  if (!employees.length) return y;
  const columns = employees.length >= 8 ? 4 : Math.min(3, Math.max(1, employees.length));
  const gap = 7;
  const cardWidth = (width - gap * (columns - 1)) / columns;
  const cardHeight = 70;
  const rows = Math.ceil(employees.length / columns);
  const titleHeight = 15;
  const createdLabel = formatShortDateGerman(createdAt);
  const totalHeight = titleHeight + rows * cardHeight + gap * Math.max(0, rows - 1);

  doc.fillColor("#142033").font("Helvetica-Bold").fontSize(7.8).text("Resturlaub je Teammitglied", x, y, { width });

  employees.forEach((employee, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const cardX = x + column * (cardWidth + gap);
    const cardY = y + titleHeight + row * (cardHeight + gap);
    const totals = plan.totals[employee.personnel_number] || { entitlement: 0, planned: 0, used: 0, consumed: 0, remaining: 0 };
    const planned = Number(totals.planned ?? totals.used ?? 0);
    const consumed = Number(totals.consumed || 0);
    const plannedOpen = Math.max(0, planned - consumed);
    const rowsToShow = [];
    if (settingEnabled(plan.settings, "vacation_pdf_balance_show_entitlement")) {
      rowsToShow.push([`Jahresurlaub mit 1.1.${plan.year}`, formatVacationDaysWithWeeks(totals.entitlement), false]);
    }
    rowsToShow.push([`Resturlaub mit ${createdLabel}`, formatVacationDaysWithWeeks(totals.remaining), true]);
    if (settingEnabled(plan.settings, "vacation_pdf_balance_show_planned")) {
      rowsToShow.push([`geplanter Urlaub ${plan.year}`, formatVacationDaysWithWeeks(planned), false]);
      rowsToShow.push([`geplant, noch nicht konsumiert mit ${createdLabel}`, formatVacationDaysWithWeeks(plannedOpen), false]);
    }
    if (settingEnabled(plan.settings, "vacation_pdf_balance_show_consumed")) {
      rowsToShow.push([`bereits konsumierter Urlaub mit ${createdLabel}`, formatVacationDaysWithWeeks(consumed), false]);
    }

    doc.roundedRect(cardX, cardY, cardWidth, cardHeight, 7).fillAndStroke("#ffffff", "#dce2df");
    doc.fillColor(employee.color).roundedRect(cardX, cardY, cardWidth, 14, 7).fill();
    doc.fillColor(contrastColor(employee.color)).font("Helvetica-Bold").fontSize(6.2).text(`${employee.personnel_number} ${employee.nickname}`, cardX + 7, cardY + 4.1, {
      width: cardWidth - 14,
      ellipsis: true,
      lineBreak: false,
    });
    const rowHeight = Math.min(9.2, (cardHeight - 20) / Math.max(1, rowsToShow.length));
    let textY = cardY + 19;
    for (const [label, value, important] of rowsToShow) {
      doc.fillColor("#53615b").font(important ? "Helvetica-Bold" : "Helvetica").fontSize(4.6).text(label, cardX + 7, textY, {
        width: cardWidth * 0.49,
        ellipsis: true,
        lineBreak: false,
      });
      doc.fillColor("#25313d").font(important ? "Helvetica-Bold" : "Helvetica").fontSize(4.7).text(value, cardX + cardWidth * 0.54, textY, {
        width: cardWidth * 0.42,
        ellipsis: true,
        lineBreak: false,
      });
      textY += rowHeight;
    }
  });
  return y + totalHeight + 9;
}

function vacationHolidayPdfLabel(holiday, selection, compact) {
  if (!holiday) return "";
  if (selection.view === "year" || compact) return "FT";
  if (selection.view === "quarter") return "Feiertag";
  return holiday.name || "Feiertag";
}

function drawVacationMonthCalendar(doc, plan, vacations, selection, monthNumber, x, y, width, height, compact = false) {
  const monthFirst = monthStart(selection.year, monthNumber - 1);
  const monthLast = monthEnd(selection.year, monthNumber - 1);
  const monthFrom = monthFirst < selection.start ? selection.start : monthFirst;
  const monthTo = monthLast > selection.end ? selection.end : monthLast;
  const calendarRange = monthCalendarRange(selection.year, monthNumber);
  const weekdayNames = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  const titleHeight = compact ? 18 : 24;
  const gridTop = y + titleHeight;
  const weekRows = Math.floor((new Date(`${calendarRange.end}T12:00:00Z`) - new Date(`${calendarRange.start}T12:00:00Z`)) / 604800000) + 1;
  const rowCount = 1 + weekRows;
  const colWidth = width / 8;
  const rowHeight = (height - titleHeight) / rowCount;
  const useBars = String(plan.settings.vacation_pdf_calendar_style || "bars") !== "dots";
  const cells = {};

  doc.roundedRect(x, y, width, height, 7).fillAndStroke("#ffffff", "#dce2df");
  doc.fillColor("#e5edf4").roundedRect(x, y, width, titleHeight, 7).fill();
  doc.fillColor("#142033").font("Helvetica-Bold").fontSize(compact ? 7.4 : 9.5).text(monthName(monthNumber), x + 8, y + (compact ? 5.5 : 8), {
    width: width - 16,
  });

  doc.fillColor("#f7f8f5").rect(x, gridTop, width, rowHeight).fill();
  doc.fillColor("#65716c").font("Helvetica-Bold").fontSize(compact ? 4.8 : 6.3).text("KW", x, gridTop + rowHeight / 2 - 2.5, {
    width: colWidth,
    align: "center",
  });
  weekdayNames.forEach((day, index) => {
    doc.text(day, x + colWidth * (index + 1), gridTop + rowHeight / 2 - 2.5, {
      width: colWidth,
      align: "center",
    });
  });

  let weekStart = calendarRange.start;
  let row = 1;
  while (weekStart <= calendarRange.end) {
    const rowY = gridTop + row * rowHeight;
    doc.fillColor("#f7f8f5").rect(x, rowY, colWidth, rowHeight).fill();
    doc.fillColor("#72807a").font("Helvetica-Bold").fontSize(compact ? 4.8 : 6).text(String(getIsoWeek(weekStart)), x, rowY + rowHeight / 2 - 2.5, {
      width: colWidth,
      align: "center",
    });
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const date = addDays(weekStart, dayIndex);
      const cellX = x + colWidth * (dayIndex + 1);
      const inRange = date >= monthFrom && date <= monthTo;
      const dayVacations = inRange ? vacationsOnDate(vacations, date) : [];
      const holiday = inRange ? (plan.publicHolidays || []).find((item) => item.date === date) : null;
      if (inRange) cells[date] = { x: cellX, y: rowY, width: colWidth, height: rowHeight };
      doc.fillColor(inRange ? "#ffffff" : "#f7f8f5").rect(cellX, rowY, colWidth, rowHeight).fill();
      doc.fillColor(inRange ? "#293640" : "#a4afaa").font("Helvetica-Bold").fontSize(compact ? 4.9 : 6.2).text(String(Number(date.slice(-2))), cellX + 2, rowY + 2, {
        width: colWidth - 4,
      });
      if (holiday) {
        const holidayLabel = vacationHolidayPdfLabel(holiday, selection, compact);
        doc.fillColor("#fff1e2").roundedRect(cellX + colWidth * 0.32, rowY + 2, colWidth * 0.64 - 2, compact ? 6.4 : 8, 2).fill();
        doc.fillColor("#8b5537").font("Helvetica-Bold").fontSize(compact ? 3.8 : 4.7).text(holidayLabel, cellX + colWidth * 0.32 + 2, rowY + (compact ? 3.2 : 3.7), {
          width: colWidth * 0.64 - 6,
          ellipsis: true,
          lineBreak: false,
        });
      }
      if (useBars) continue;
      const visibleVacations = dayVacations.slice(0, compact ? 4 : 3);
      if (compact) {
        visibleVacations.forEach((vacation, index) => {
          doc.fillColor(vacation.color).circle(cellX + 5 + index * 5.2, rowY + rowHeight - 5, 2).fill();
        });
        if (dayVacations.length > visibleVacations.length) {
          doc.fillColor("#6f7b80").font("Helvetica-Bold").fontSize(4.5).text(`+${dayVacations.length - visibleVacations.length}`, cellX + 5 + visibleVacations.length * 5.2, rowY + rowHeight - 7, {
            width: colWidth - 4,
          });
        }
      } else {
        let tagY = rowY + 11;
        visibleVacations.forEach((vacation) => {
          const tagHeight = Math.min(8, Math.max(6, rowHeight / 5));
          if (tagY + tagHeight > rowY + rowHeight - 2) return;
          doc.fillColor(vacation.color).roundedRect(cellX + 2, tagY, colWidth - 4, tagHeight, 2).fill();
          doc.fillColor(contrastColor(vacation.color)).font("Helvetica-Bold").fontSize(Math.min(5.3, tagHeight - 1.5)).text(vacation.nickname, cellX + 4, tagY + 1.3, {
            width: colWidth - 8,
            ellipsis: true,
          });
          tagY += tagHeight + 1.5;
        });
        if (dayVacations.length > visibleVacations.length) {
          doc.fillColor("#6f7b80").font("Helvetica-Bold").fontSize(5).text(`+${dayVacations.length - visibleVacations.length}`, cellX + 3, tagY, {
            width: colWidth - 6,
          });
        }
      }
    }
    weekStart = addDays(weekStart, 7);
    row += 1;
  }

  if (useBars) {
    drawVacationBars(doc, plan, vacations, monthFrom, monthTo, cells, compact);
  }

  doc.strokeColor("#edf0ee").lineWidth(0.35);
  for (let col = 0; col <= 8; col += 1) {
    const lineX = x + col * colWidth;
    doc.moveTo(lineX, gridTop).lineTo(lineX, y + height).stroke();
  }
  for (let lineRow = 0; lineRow <= rowCount; lineRow += 1) {
    const lineY = gridTop + lineRow * rowHeight;
    doc.moveTo(x, lineY).lineTo(x + width, lineY).stroke();
  }
}

function drawVacationEmployeeOverviewPdf(doc, plan, selection, vacations, layout, createdAt) {
  const { left, availableWidth, pageHeight, pageWidth, title, size } = layout;
  const y = 62;
  const columnGap = 10;
  const columns = 2;
  const columnWidth = (availableWidth - columnGap) / columns;
  const rowGap = 9;
  let column = 0;
  let cardY = y;

  for (const employee of plan.employees) {
    const employeeVacations = vacations
      .filter((vacation) => vacation.employee_number === employee.personnel_number)
      .sort((a, b) => a.date_from.localeCompare(b.date_from));
    const cardHeight = 62 + Math.max(1, employeeVacations.length) * 11;
    if (cardY + cardHeight > pageHeight - 42) {
      if (column === 0) {
        column = 1;
        cardY = y;
      } else {
        drawVacationPdfFooter(doc, left, pageWidth, pageHeight, createdAt, plan.settings);
        doc.addPage({ size, layout: "landscape", margin: 0 });
        drawVacationPdfHeader(doc, title, selection, left, availableWidth, size);
        column = 0;
        cardY = 62;
      }
    }
    const x = left + column * (columnWidth + columnGap);
    doc.roundedRect(x, cardY, columnWidth, cardHeight, 8).fillAndStroke("#ffffff", "#dce2df");
    doc.fillColor(employee.color).roundedRect(x, cardY, columnWidth, 24, 8).fill();
    doc.fillColor(contrastColor(employee.color)).font("Helvetica-Bold").fontSize(8.8).text(`${employee.personnel_number} ${employee.nickname}`, x + 9, cardY + 7.5, {
      width: columnWidth - 18,
      ellipsis: true,
    });
    const totals = plan.totals[employee.personnel_number] || { entitlement: 0, planned: 0, consumed: 0, remaining: 0 };
    doc.fillColor("#25313d").font("Helvetica-Bold").fontSize(6.8).text(`Resturlaub: ${formatVacationDaysLong(totals.remaining)}`, x + 9, cardY + 30, {
      width: columnWidth - 18,
    });
    doc.fillColor("#53615b").font("Helvetica").fontSize(5.9).text(`Geplant: ${formatVacationDaysLong(totals.planned ?? totals.used)} · Konsumiert: ${formatVacationDaysLong(totals.consumed)}`, x + 9, cardY + 41, {
      width: columnWidth - 18,
      ellipsis: true,
    });
    let itemY = cardY + 54;
    if (!employeeVacations.length) {
      doc.fillColor("#98a29e").font("Helvetica").fontSize(6.5).text("Keine Urlaube eingetragen", x + 9, itemY, {
        width: columnWidth - 18,
      });
    } else {
      for (const vacation of employeeVacations) {
        const clippedFrom = vacation.selection_from || (vacation.date_from < selection.start ? selection.start : vacation.date_from);
        const clippedTo = vacation.selection_to || (vacation.date_to > selection.end ? selection.end : vacation.date_to);
        doc.fillColor(employee.color).roundedRect(x + 9, itemY + 1, 6, 6, 1.5).fill();
        doc.fillColor("#25313d").font("Helvetica").fontSize(6.2).text(
          `${vacationDateRangeText(clippedFrom, clippedTo, true)} · ${formatVacationDays(vacationDayCount(clippedFrom, clippedTo, plan.settings, plan.context?.locationId))}${vacation.note ? ` · ${vacation.note}` : ""}`,
          x + 19,
          itemY,
          { width: columnWidth - 28, ellipsis: true, lineBreak: false },
        );
        itemY += 12;
      }
    }
    cardY += cardHeight + rowGap;
  }
}

function drawVacationPdf(plan, selection, response, createdAt = new Date()) {
  const size = "A4";
  const title = plan.settings.vacation_pdf_title || "Urlaubsplanung";
  const doc = new PDFDocument({
    size,
    layout: "landscape",
    margin: 0,
    info: {
      Title: `${title} · ${selection.title}`,
      Subject: `${size} Querformat · ${APP_NAME} ${APP_VERSION_LABEL}`,
    },
  });
  doc.pipe(response);

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const left = 26;
  const right = 26;
  const vacations = filteredVacationsForSelection(plan, selection);
  const availableWidth = pageWidth - left - right;

  drawVacationPdfHeader(doc, title, selection, left, availableWidth, size);

  if (selection.view === "employees") {
    drawVacationEmployeeOverviewPdf(doc, plan, selection, vacations, {
      left,
      availableWidth,
      pageWidth,
      pageHeight,
      title,
      size,
    }, createdAt);
    drawVacationPdfFooter(doc, left, pageWidth, pageHeight, createdAt, plan.settings);
    doc.end();
    return;
  }

  const calendarTop = drawVacationBalanceSummary(doc, plan, left, 58, availableWidth, createdAt);
  const top = calendarTop === 58 ? 62 : calendarTop;
  const bottom = pageHeight - 37;
  const monthCount = selection.months.length;
  const columns = monthCount === 1 ? 1 : monthCount <= 3 ? 3 : 4;
  const rows = Math.ceil(monthCount / columns);
  const gap = monthCount === 1 ? 0 : 8;
  const cardWidth = (availableWidth - gap * (columns - 1)) / columns;
  const cardHeight = (bottom - top - gap * (rows - 1)) / rows;
  const compact = selection.view === "year";

  selection.months.forEach((month, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = left + column * (cardWidth + gap);
    const y = top + row * (cardHeight + gap);
    drawVacationMonthCalendar(doc, plan, vacations, selection, month, x, y, cardWidth, cardHeight, compact);
  });

  drawVacationPdfFooter(doc, left, pageWidth, pageHeight, createdAt, plan.settings);

  doc.end();
}

function scheduleNoteFontName(note) {
  if (note.bold && note.italic) return "Helvetica-BoldOblique";
  if (note.bold) return "Helvetica-Bold";
  if (note.italic) return "Helvetica-Oblique";
  return "Helvetica";
}

function scheduleNoteFontSize(note) {
  return { small: 5.7, medium: 6.4, large: 7.2 }[note.font_size] || 6.4;
}

function scheduleNoteStyleFont(style) {
  if (style.bold && style.italic) return "Helvetica-BoldOblique";
  if (style.bold) return "Helvetica-Bold";
  if (style.italic) return "Helvetica-Oblique";
  return "Helvetica";
}

function scheduleNoteStyleSize(style) {
  return { small: 5.7, normal: 6.4, large: 7.2 }[style?.size || "normal"] || 6.4;
}

function parseScheduleNoteRichSegments(note) {
  const source = note.note_html ? sanitizeScheduleNoteHtml(note.note_html) : "";
  if (!source) {
    return [
      {
        text: stripEmoji(note.note_text || ""),
        bold: Boolean(note.bold),
        italic: Boolean(note.italic),
        underline: Boolean(note.underline),
        size: note.font_size === "large" ? "large" : note.font_size === "small" ? "small" : "normal",
      },
    ];
  }
  const segments = [];
  const style = { bold: false, italic: false, underline: false, size: "normal" };
  const stack = [];
  const parts = source.split(/(<[^>]+>)/g).filter((part) => part !== "");
  function pushText(text) {
    const decoded = stripEmoji(decodeBasicEntities(text).replace(/\u00a0/g, " "));
    if (!decoded) return;
    segments.push({ text: decoded, ...style });
  }
  function pushBreak() {
    if (segments.length && segments[segments.length - 1].text === "\n") return;
    segments.push({ text: "\n", ...style });
  }
  for (const part of parts) {
    if (!part.startsWith("<")) {
      pushText(part);
      continue;
    }
    const tag = part.toLowerCase();
    if (tag === "<br>" || tag === "</div>" || tag === "</p>") {
      pushBreak();
      continue;
    }
    if (tag === "<div>" || tag === "<p>") continue;
    if (tag === "<b>" || tag === "<strong>") { stack.push({ ...style }); style.bold = true; continue; }
    if (tag === "<i>" || tag === "<em>") { stack.push({ ...style }); style.italic = true; continue; }
    if (tag === "<u>") { stack.push({ ...style }); style.underline = true; continue; }
    if (tag.startsWith("<span")) {
      stack.push({ ...style });
      style.size = tag.match(/data-size="(small|normal|large)"/)?.[1] || style.size;
      continue;
    }
    if (["</b>", "</strong>", "</i>", "</em>", "</u>", "</span>"].includes(tag)) {
      const previous = stack.pop();
      if (previous) Object.assign(style, previous);
    }
  }
  return segments.filter((segment, index) =>
    segment.text !== "\n" || (index > 0 && index < segments.length - 1),
  );
}

function drawScheduleNoteRichText(doc, note, x, y, width, height) {
  const segments = parseScheduleNoteRichSegments(note);
  const maxY = y + height;
  let cursorX = x;
  let cursorY = y;
  const lineGap = 1.2;
  function lineHeightFor(size) {
    const lineHeight = scheduleNoteStyleSize({ size }) * 1.35 + lineGap;
    return Number.isFinite(lineHeight) ? lineHeight : 9.8;
  }
  function nextLine(size = "normal") {
    cursorX = x;
    cursorY += lineHeightFor(size);
    return cursorY <= maxY;
  }
  for (const segment of segments) {
    const tokens = segment.text === "\n" ? ["\n"] : segment.text.split(/(\s+)/).filter((token) => token !== "");
    for (const token of tokens) {
      const size = scheduleNoteStyleSize(segment);
      if (token === "\n") {
        if (!nextLine(segment.size)) return;
        continue;
      }
      doc.font(scheduleNoteStyleFont(segment)).fontSize(size);
      const measuredWidth = doc.widthOfString(token);
      const tokenWidth = Number.isFinite(measuredWidth) ? measuredWidth : 0;
      if (cursorX > x && cursorX + tokenWidth > x + width) {
        if (!nextLine(segment.size)) return;
      }
      if (cursorY + size > maxY) return;
      if (![cursorX, cursorY, size].every(Number.isFinite)) return;
      doc
        .fillColor("#1e252b")
        .font(scheduleNoteStyleFont(segment))
        .fontSize(size)
        .text(token, cursorX, cursorY, {
          width: Math.max(1, tokenWidth + 1),
          lineBreak: false,
          underline: Boolean(segment.underline),
        });
      cursorX += tokenWidth;
    }
  }
}

function drawSchedulePdf(schedule, response, createdAt = new Date()) {
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margin: 0,
    info: {
      Title: `${schedule.settings.pdf_title} · KW ${schedule.calendarWeek}`,
      Subject: `A4 Querformat · ${APP_NAME} ${APP_VERSION_LABEL}`,
    },
  });
  doc.pipe(response);

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const left = 22;
  const right = 22;
  const timeWidth = 35;
  const gridLeft = left + timeWidth;
  const gridWidth = pageWidth - gridLeft - right;
  const dayCount = settingEnabled(schedule.settings, "show_sunday") ? 7 : 6;
  const dayGap = 3;
  const dayWidth = (gridWidth - dayGap * (dayCount - 1)) / dayCount;
  const dayX = (dayIndex) => gridLeft + dayIndex * (dayWidth + dayGap);
  const titleY = 18;
  const dayHeaderY = 45;
  const dayHeaderHeight = 20;
  const employeeHeaderY = dayHeaderY + dayHeaderHeight;
  const employeeHeaderHeight = 28;
  const gridTop = employeeHeaderY + employeeHeaderHeight + 10;
  const gridBottom = 438;
  const gridHeight = gridBottom - gridTop;
  const timedOptionStarts = schedule.weekOptions
    .filter((option) => !optionIsAllDay(option) && isTime(option.start_time))
    .map((option) => timeToMinutes(option.start_time));
  const timedOptionEnds = schedule.weekOptions
    .filter((option) => !optionIsAllDay(option) && isTime(option.end_time))
    .map((option) => timeToMinutes(option.end_time));
  const startMinutes = Math.min(
    ...planningDays.map(([day]) => timeToMinutes(schedule.settings[`${day}_start_time`])),
    ...schedule.shifts.map((shift) => timeToMinutes(shift.start_time)),
    ...timedOptionStarts,
  );
  const endMinutes = Math.max(
    ...planningDays.map(([day]) => timeToMinutes(schedule.settings[`${day}_end_time`])),
    ...schedule.shifts.map((shift) => timeToMinutes(shift.end_time)),
    ...timedOptionEnds,
  );
  const rangeMinutes = endMinutes - startMinutes;
  const employees = schedule.employees;
  const employeeCount = Math.max(1, employees.length);
  const employeeWidth = dayWidth / employeeCount;

  doc
    .fillColor("#142033")
    .font("Helvetica-Bold")
    .fontSize(15)
    .text(
      `${schedule.settings.pdf_title} · Woche ab ${formatDateGerman(schedule.weekStart)} · KW ${schedule.calendarWeek}`,
      left,
      titleY,
      { width: pageWidth - left - right },
    );

  doc.fillColor("#142033").font("Helvetica-Bold").fontSize(7).text("Zeit", left, employeeHeaderY + 10, {
    width: timeWidth - 5,
    align: "center",
  });

  const weekdayNames = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  for (let dayIndex = 0; dayIndex < dayCount; dayIndex += 1) {
    const date = addDays(schedule.weekStart, dayIndex);
    const x = dayX(dayIndex);
    doc
      .fillColor(dayIndex === 6 ? "#d6d6d6" : "#e5edf4")
      .rect(x, dayHeaderY, dayWidth, dayHeaderHeight)
      .fill();
    doc.strokeColor("#aab6c2").lineWidth(0.45).rect(x, dayHeaderY, dayWidth, dayHeaderHeight).stroke();
    doc
      .fillColor("#111820")
      .font("Helvetica-Bold")
      .fontSize(8)
      .text(`${weekdayNames[dayIndex]} ${formatDateGerman(date, false)}`, x, dayHeaderY + 6, {
        width: dayWidth,
        align: "center",
      });

    employees.forEach((employee, employeeIndex) => {
      const employeeX = x + employeeIndex * employeeWidth;
      doc.fillColor(employee.color).rect(employeeX, employeeHeaderY, employeeWidth, employeeHeaderHeight).fill();
      doc
        .fillColor(contrastColor(employee.color))
        .font("Helvetica-Bold")
        .fontSize(Math.max(4.2, Math.min(5.8, employeeWidth / 7)))
        .text(employee.nickname, employeeX + 1, employeeHeaderY + 11, {
          width: employeeWidth - 2,
          align: "center",
          ellipsis: true,
        });
    });
  }

  doc.fillColor("#ffffff").rect(gridLeft, gridTop, gridWidth, gridHeight).fill();
  for (let dayIndex = 0; dayIndex < dayCount; dayIndex += 1) {
    const date = addDays(schedule.weekStart, dayIndex);
    const hours = operatingHours(date, schedule.settings);
    const x = dayX(dayIndex);
    if (!hours) {
      doc.fillColor("#eeeeee").rect(x, gridTop, dayWidth, gridHeight).fill();
      continue;
    }
    const dayStart = timeToMinutes(hours.start);
    const dayEnd = timeToMinutes(hours.end);
    if (dayStart > startMinutes) {
      const closedHeight = ((dayStart - startMinutes) / rangeMinutes) * gridHeight;
      doc.fillColor("#eeeeee").rect(x, gridTop, dayWidth, closedHeight).fill();
    }
    if (dayEnd < endMinutes) {
      const closedY = gridTop + ((dayEnd - startMinutes) / rangeMinutes) * gridHeight;
      doc.fillColor("#eeeeee").rect(x, closedY, dayWidth, gridBottom - closedY).fill();
    }
    const config = dayConfiguration(date, schedule.settings);
    if (config.lunchEnabled) {
      const lunchY = gridTop + ((timeToMinutes(config.lunchStart) - startMinutes) / rangeMinutes) * gridHeight;
      const lunchHeight =
        ((timeToMinutes(config.lunchEnd) - timeToMinutes(config.lunchStart)) / rangeMinutes) * gridHeight;
      doc.fillColor("#e6e6e6").rect(x, lunchY, dayWidth, lunchHeight).fill();
      doc
        .fillColor("#737a7d")
        .font("Helvetica-Bold")
        .fontSize(5)
        .text("Mittagspause", x, lunchY + lunchHeight / 2 - 3, { width: dayWidth, align: "center" });
    }
    const globalBlock = (schedule.globalDayBlocks || []).find((block) => block.block_date === date);
    if (globalBlock) {
      doc.save();
      doc.fillColor("#e1e4e4").rect(x, gridTop, dayWidth, gridHeight).fill();
      doc.rect(x, gridTop, dayWidth, gridHeight).clip();
      doc.strokeColor("#9aa2a4").lineWidth(0.5);
      for (let offset = -gridHeight; offset < dayWidth + gridHeight; offset += 8) {
        doc.moveTo(x + offset, gridBottom).lineTo(x + offset + gridHeight, gridTop).stroke();
      }
      doc.restore();
      doc.strokeColor("#7f8789").lineWidth(0.55).rect(x, gridTop, dayWidth, gridHeight).stroke();
      doc
        .fillColor("#41484b")
        .font("Helvetica-Bold")
        .fontSize(7)
        .text(globalBlock.reason || globalBlock.holiday_name || "Tag gesperrt", x + 4, gridTop + gridHeight / 2 - 5, {
          width: dayWidth - 8,
          align: "center",
          ellipsis: true,
        });
    }
  }

  for (let minute = startMinutes; minute <= endMinutes; minute += 60) {
    const y = gridTop + ((minute - startMinutes) / rangeMinutes) * gridHeight;
    const label = `${String(Math.floor(minute / 60)).padStart(2, "0")}:00`;
    doc
      .fillColor("#263240")
      .font("Helvetica")
      .fontSize(6.5)
      .text(label, left, y - 3, { width: timeWidth - 6, align: "center" });
    for (let dayIndex = 0; dayIndex < dayCount; dayIndex += 1) {
      const x = dayX(dayIndex);
      doc.strokeColor("#bbc5ce").lineWidth(0.35).moveTo(x, y).lineTo(x + dayWidth, y).stroke();
    }
  }

  for (let dayIndex = 0; dayIndex < dayCount; dayIndex += 1) {
    const dayStartX = dayX(dayIndex);
    doc.strokeColor("#aab6c2").lineWidth(0.45).rect(dayStartX, gridTop, dayWidth, gridHeight).stroke();
    for (let employeeIndex = 1; employeeIndex < employeeCount; employeeIndex += 1) {
      const x = dayStartX + employeeIndex * employeeWidth;
      doc.strokeColor("#c6ced5").lineWidth(0.3).moveTo(x, gridTop).lineTo(x, gridBottom).stroke();
    }
  }

  for (const option of schedule.weekOptions) {
    const employeeIndex = employees.findIndex(
      (employee) => employee.personnel_number === option.employee_number,
    );
    if (employeeIndex < 0) continue;

    for (let date = option.date_from; date <= option.date_to; date = addDays(date, 1)) {
      const dayIndex = Math.round(
        (new Date(`${date}T12:00:00Z`) - new Date(`${schedule.weekStart}T12:00:00Z`)) / 86400000,
      );
      if (dayIndex < 0 || dayIndex >= dayCount) continue;

      const x = dayX(dayIndex) + employeeIndex * employeeWidth + 0.5;
      const width = Math.max(2, employeeWidth - 1);
      const range = optionTimeRange(option);
      const optionStart = Math.max(startMinutes, timeToMinutes(range.start));
      const optionEnd = Math.min(endMinutes, timeToMinutes(range.end));
      if (optionEnd <= optionStart) continue;
      const y = gridTop + ((optionStart - startMinutes) / rangeMinutes) * gridHeight;
      const height = ((optionEnd - optionStart) / rangeMinutes) * gridHeight;
      doc.save();
      doc.fillColor("#e3e5e5").rect(x, y, width, height).fill();
      doc.rect(x, y, width, height).clip();
      doc.strokeColor("#9da3a5").lineWidth(0.45);
      for (let offset = -height; offset < width + height; offset += 6) {
        doc.moveTo(x + offset, y + height).lineTo(x + offset + height, y).stroke();
      }
      doc.restore();
      doc.strokeColor("#7e8588").lineWidth(0.4).rect(x, y, width, height).stroke();
      const label = optionLabel(option.option_type);
      const labelFontSize = Math.max(4.2, Math.min(5.2, height / 7));
      doc.save();
      doc
        .fillColor("#41484b")
        .font("Helvetica-Bold")
        .fontSize(labelFontSize)
        .rotate(-90, { origin: [x + width / 2, y + height / 2] })
        .text(
          label,
          x + width / 2 - height / 2,
          y + height / 2 - labelFontSize / 2,
          {
            width: height,
            align: "center",
            lineBreak: false,
          },
        );
      doc.restore();
    }
  }

  for (const shift of schedule.shifts) {
    const dayIndex = Math.round(
      (new Date(`${shift.shift_date}T12:00:00Z`) - new Date(`${schedule.weekStart}T12:00:00Z`)) / 86400000,
    );
    const employeeIndex = employees.findIndex(
      (employee) => employee.personnel_number === shift.employee_number,
    );
    if (dayIndex < 0 || dayIndex >= dayCount || employeeIndex < 0) continue;

    const shiftStart = Math.max(startMinutes, timeToMinutes(shift.start_time));
    const shiftEnd = Math.min(endMinutes, timeToMinutes(shift.end_time));
    if (shiftEnd <= shiftStart) continue;
    const x = dayX(dayIndex) + employeeIndex * employeeWidth + 1;
    const y = gridTop + ((shiftStart - startMinutes) / rangeMinutes) * gridHeight;
    const height = ((shiftEnd - shiftStart) / rangeMinutes) * gridHeight;
    const width = Math.max(2, employeeWidth - 2);
    const employee = employees[employeeIndex];
    doc.fillColor(employee.color).rect(x, y, width, height).fill();
    doc.strokeColor("#25313d").lineWidth(0.35).rect(x, y, width, height).stroke();
    if (!schedule.context.departmentId && shift.department_name && height > 14 && width > 8) {
      doc
        .fillColor(contrastColor(employee.color))
        .font("Helvetica-Bold")
        .fontSize(Math.max(3.6, Math.min(4.8, width / 5)))
        .text(shift.department_name, x + 1, y + 2, {
          width: width - 2,
          height: Math.min(10, height - 2),
          align: "center",
          ellipsis: true,
        });
    }
  }

  for (let dayIndex = 0; dayIndex < dayCount; dayIndex += 1) {
    const date = addDays(schedule.weekStart, dayIndex);
    const config = dayConfiguration(date, schedule.settings);
    if (!config?.lunchEnabled) continue;
    const x = dayX(dayIndex);
    const lunchY = gridTop + ((timeToMinutes(config.lunchStart) - startMinutes) / rangeMinutes) * gridHeight;
    const lunchHeight =
      ((timeToMinutes(config.lunchEnd) - timeToMinutes(config.lunchStart)) / rangeMinutes) * gridHeight;
    doc.save();
    doc.fillOpacity(0.78).fillColor("#d8dada").rect(x, lunchY, dayWidth, lunchHeight).fill();
    doc.fillOpacity(1);
    doc
      .fillColor("#555e5b")
      .font("Helvetica-Bold")
      .fontSize(5.4)
      .text("Mittagspause · geschlossen", x, lunchY + lunchHeight / 2 - 3, {
        width: dayWidth,
        align: "center",
      });
    doc.restore();
  }

  const remarksY = 454;
  const remarkColumns = [
    { key: "leave", title: "Urlaube / Zeitausgleich" },
    { key: "school", title: "Schule / Schulungen" },
    { key: "other", title: "Bemerkungen / Sonderfälle" },
  ];
  const scheduleNote = schedule.scheduleNote?.note_text?.trim() ? schedule.scheduleNote : null;
  const remarkGap = 12;
  const remarkColumnCount = scheduleNote ? 4 : 3;
  const remarkColumnWidth = (pageWidth - left - right - remarkGap * (remarkColumnCount - 1)) / remarkColumnCount;
  const groupedOptions = Object.fromEntries(remarkColumns.map((column) => [column.key, []]));
  for (const option of schedule.weekOptions) groupedOptions[optionRemarkColumn(option)].push(option);
  for (const block of schedule.globalDayBlocks || []) {
    groupedOptions.other.push({ ...block, global_day: true, color: "#9aa2a4" });
  }

  remarkColumns.forEach((column, columnIndex) => {
    const x = left + columnIndex * (remarkColumnWidth + remarkGap);
    doc.fillColor("#142033").font("Helvetica-Bold").fontSize(8.3).text(column.title, x, remarksY, {
      width: remarkColumnWidth,
    });
    const options = groupedOptions[column.key];
    if (!options.length) {
      doc.fillColor("#9aa5a1").font("Helvetica").fontSize(6.2).text("—", x, remarksY + 15, {
        width: remarkColumnWidth,
      });
      return;
    }
    let y = remarksY + 15;
    for (const option of options) {
      if (y > 556) {
        doc.fillColor("#6f7b80").font("Helvetica").fontSize(5.8).text("…", x, y, { width: remarkColumnWidth });
        break;
      }
      doc.fillColor(option.color || "#9aa2a4").roundedRect(x, y + 1.2, 6, 6, 1.4).fill();
      doc
        .fillColor("#25313d")
        .font("Helvetica")
        .fontSize(5.95)
        .text(optionRemarkText(option), x + 9, y, {
          width: remarkColumnWidth - 9,
          height: 16,
          ellipsis: true,
        });
      y += 15;
    }
  });

  if (scheduleNote) {
    const x = left + 3 * (remarkColumnWidth + remarkGap);
    const boxY = remarksY;
    const boxHeight = 101;
    doc.roundedRect(x, boxY, remarkColumnWidth, boxHeight, 6).fillAndStroke("#fff6cf", "#111111");
    doc.fillColor("#142033").font("Helvetica-Bold").fontSize(8.1).text("Besondere Bemerkung", x + 8, boxY + 8, {
      width: remarkColumnWidth - 16,
    });
    drawScheduleNoteRichText(doc, scheduleNote, x + 8, boxY + 23, remarkColumnWidth - 16, boxHeight - 31);
  }

  doc
    .fillColor("#6b7684")
    .font("Helvetica-Bold")
    .fontSize(5.7)
    .text(`Dienstplan erstellt mit: ${APP_NAME} ${APP_VERSION_LABEL}`, left, pageHeight - 24);
  doc
    .font("Helvetica")
    .text(
      pdfFooterContact(schedule.settings, createdAt),
      pageWidth - 300,
      pageHeight - 24,
      { width: 278, align: "right" },
    );

  doc.end();
}

app.get("/api/schedule.pdf", (request, response) => {
  const schedule = getSchedule(request.query.week, request.query, request.portalSession);
  const createdAt = new Date();
  const filename = buildPdfFilename(schedule, createdAt);
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader("Content-Disposition", contentDispositionHeader(filename));
  drawSchedulePdf(schedule, response, createdAt);
});

app.get("/api/vacations.pdf", (request, response) => {
  const selection = vacationSelectionFromQuery(request.query);
  const plan = getVacationPlan(selection.year, request.query, request.portalSession);
  const createdAt = new Date();
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader("Content-Disposition", contentDispositionHeader(buildVacationPdfFilename(plan.settings, selection, createdAt)));
  drawVacationPdf(plan, selection, response, createdAt);
});

app.get("/api/schedule-preview.pdf", (request, response) => {
  const schedule = getSchedule(request.query.week, request.query, request.portalSession);
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader("Content-Disposition", "inline");
  drawSchedulePdf(schedule, response, new Date());
});

app.get("/api/vacations-preview.pdf", (request, response) => {
  const selection = vacationSelectionFromQuery(request.query);
  const plan = getVacationPlan(selection.year, request.query, request.portalSession);
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader("Content-Disposition", "inline");
  drawVacationPdf(plan, selection, response, new Date());
});

app.use((error, request, response, _next) => {
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
  const requestId = request.grabenplanerRequestId || crypto.randomUUID();
  if (status >= 500) console.error(`[${requestId}] ${request.method} ${request.originalUrl || request.path}`, error);
  if (response.headersSent) {
    _next(error);
    return;
  }
  response.setHeader("X-Request-Id", requestId);
  if (error.retryAfter) response.setHeader("Retry-After", String(error.retryAfter));
  if (request.path.startsWith("/api/mobile/")) {
    const mobileError = {
      code: status >= 500 ? "INTERNAL_ERROR" : (error.code || "REQUEST_FAILED"),
      message: status >= 500 ? "Die Aktion konnte nicht ausgeführt werden." : (error.message || "Die Aktion konnte nicht ausgeführt werden."),
      requestId,
    };
    if (status < 500 && error.details?.fieldErrors && typeof error.details.fieldErrors === "object" && !Array.isArray(error.details.fieldErrors)) {
      mobileError.fieldErrors = Object.fromEntries(Object.entries(error.details.fieldErrors)
        .filter(([field]) => String(field).trim())
        .map(([field, message]) => [String(field), String(message || "Ungültige Eingabe.")]));
    }
    response.status(status).json({ error: mobileError });
    return;
  }
  const payload = {
    error: status >= 500 ? "Die Aktion konnte nicht ausgeführt werden." : (error.message || "Die Aktion konnte nicht ausgeführt werden."),
    requestId,
  };
  if (status >= 500) payload.code = "INTERNAL_ERROR";
  else if (error.code) payload.code = error.code;
  if (status < 500 && error.details && typeof error.details === "object") payload.details = error.details;
  response.status(status).json(payload);
});

let shutdownStarted = false;
let databaseClosed = false;
let server = null;

function acquireInstanceLock() {
  if (!instanceLockPath || instanceLockHeld) return;
  instanceLockHandle = acquireDatabaseLock({ databasePath, kind: "app", appVersion: packageMetadata.version });
  instanceLockHeld = Boolean(instanceLockHandle);
}

function releaseInstanceLock() {
  if (!instanceLockPath || !instanceLockHeld) return;
  releaseDatabaseLock(instanceLockHandle);
  instanceLockHandle = null;
  instanceLockHeld = false;
}

function releaseInstanceLockForTests() {
  releaseInstanceLock();
}

function validateServerStartup(portalStatus) {
  if (serverModeActive) {
    let parsedPublicUrl = null;
    try { parsedPublicUrl = new URL(publicUrl); } catch {}
    if (!parsedPublicUrl || parsedPublicUrl.protocol !== "https:" || parsedPublicUrl.username || parsedPublicUrl.password || parsedPublicUrl.pathname !== "/" || parsedPublicUrl.search || parsedPublicUrl.hash) {
      throw new Error("Serverbetrieb abgebrochen: GRABENPLANER_PUBLIC_URL muss eine gültige öffentliche HTTPS-Adresse enthalten.");
    }
    if (portalStatus.adminSetupState !== "configured") {
      throw new Error("Serverbetrieb abgebrochen: Zuerst im Lokal- oder LAN-Betrieb einen Admin-Zugang einrichten.");
    }
    if (serviceControlToken.length < 32) {
      throw new Error("Serverbetrieb abgebrochen: GRABENPLANER_SERVICE_CONTROL_TOKEN muss als geheimer Dienststeuerungs-Token gesetzt sein.");
    }
    if (!amuStorage) {
      throw new Error(`Serverbetrieb abgebrochen: Der geschützte AUM-Speicher ist nicht verfügbar${amuStorageStartupError ? `: ${amuStorageStartupError}` : "."}`);
    }
    return;
  }
  if (!loopbackHosts.has(HOST.toLowerCase()) && (getSettings().operation_mode !== "lan" || !portalStatus.portalEnabled || portalStatus.adminSetupState !== "configured")) {
    throw new Error("LAN-Bindung abgebrochen: Der LAN-Modus und ein Admin-Zugang müssen aktiviert sein.");
  }
}

function startServer() {
  if (server) return server;
  const portalStatus = getPortalStatus();
  validateServerStartup(portalStatus);
  acquireInstanceLock();
  server = app.listen(PORT, HOST, () => {
    const address = server.address();
    const listeningPort = typeof address === "object" && address ? address.port : PORT;
    console.log(`${APP_NAME} läuft auf http://localhost:${listeningPort}`);
    if (serverModeActive) {
      console.log(`Öffentlicher Serverbetrieb über Reverse Proxy: ${publicUrl}`);
    } else if (portalStatus.portalEnabled) {
      for (const url of getLanUrls(listeningPort)) console.log(`LAN-Zugriff: ${url}`);
    }
    scheduleAutomaticBackups();
    try { reconcileOrphanAmuBlobs(); } catch (error) { console.error("AUM-Abgleich fehlgeschlagen:", error); }
    try { purgeExpiredAmuDocuments(); } catch (error) { console.error("AUM-Aufbewahrungsprüfung fehlgeschlagen:", error); }
    try { purgeExpiredSicknessData(); } catch (error) { console.error("Krankmeldungs-Aufbewahrungsprüfung fehlgeschlagen:", error); }
    try { runSicknessEscalationSweep(); } catch (error) { console.error("Krankmeldungs-Fristenprüfung fehlgeschlagen:", error); }
    processOutboundNotificationJobs().catch((error) => console.error("Externe Warnmeldungen konnten nicht verarbeitet werden:", error));
    retentionInterval = setInterval(() => {
      try { purgeExpiredAmuDocuments(); } catch (error) { console.error("AUM-Aufbewahrungsprüfung fehlgeschlagen:", error); }
      try { purgeExpiredSicknessData(); } catch (error) { console.error("Krankmeldungs-Aufbewahrungsprüfung fehlgeschlagen:", error); }
    }, 24 * 60 * 60 * 1000);
    retentionInterval.unref();
    sicknessSweepInterval = setInterval(() => {
      try { runSicknessEscalationSweep(); } catch (error) { console.error("Krankmeldungs-Fristenprüfung fehlgeschlagen:", error); }
    }, 60 * 1000);
    sicknessSweepInterval.unref();
    notificationDispatchInterval = setInterval(() => {
      processOutboundNotificationJobs().catch((error) => console.error("Externe Warnmeldungen konnten nicht verarbeitet werden:", error));
    }, 60 * 1000);
    notificationDispatchInterval.unref();
    if (serverModeActive) {
      rateLimitCleanupInterval = setInterval(() => {
        const now = Date.now();
        loginRateLimits.prune(now);
        loginBrandingRateLimits.prune(now);
        mobileRefreshRateLimits.prune(now);
        usbCreatorAuthRateLimits.prune(now);
        usbCreatorGlobalRateLimits.prune(now);
      }, 5 * 60 * 1000);
      rateLimitCleanupInterval.unref();
    }
    if (serverModeActive && amuStorage) {
      scannerProbeInterval = setInterval(() => {
        amuScannerProbe = amuStorage.probeScanner().catch((error) => {
          console.error("AUM-Virenscanner ist nicht betriebsbereit:", error.message);
          return null;
        });
      }, 5 * 60 * 1000);
      scannerProbeInterval.unref();
    }
    setTimeout(() => {
      try {
        const backup = createDatabaseBackup("startup");
        if (backup) console.log(`Backup erstellt: ${backup.path}`);
      } catch (error) {
        console.error("Backup konnte nicht erstellt werden:", error);
      }
    }, 1500);
  });
  server.once("error", () => releaseInstanceLock());
  return server;
}

function shutdown({ reason = "signal", skipBackup = false, exitCode = 0 } = {}) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  let finished = false;
  let serverClosed = !server;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (!databaseClosed) {
      try {
        if (!skipBackup) createDatabaseBackup(`shutdown-${reason}`);
      } catch (error) {
        console.error("Backup beim Dienststopp konnte nicht erstellt werden:", error);
      }
      try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
      try { db.close(); } finally { databaseClosed = true; }
    }
    releaseInstanceLock();
    process.exit(exitCode);
  };
  if (backupInterval) clearInterval(backupInterval);
  if (retentionInterval) clearInterval(retentionInterval);
  if (scannerProbeInterval) clearInterval(scannerProbeInterval);
  if (sicknessSweepInterval) clearInterval(sicknessSweepInterval);
  if (notificationDispatchInterval) clearInterval(notificationDispatchInterval);
  if (rateLimitCleanupInterval) clearInterval(rateLimitCleanupInterval);
  if (!server) {
    finish();
    return;
  }
  const tryFinish = () => {
    if (serverClosed && amuMutationInProgress === 0) finish();
  };
  const waitForUploads = setInterval(tryFinish, 100);
  waitForUploads.unref();
  const forceExit = setTimeout(() => {
    clearInterval(waitForUploads);
    if (amuMutationInProgress > 0) console.error("Dienststopp nach 45 Sekunden erzwungen; ein AUM-Vorgang war noch aktiv.");
    finish();
  }, 45000);
  forceExit.unref();
  server.close(() => {
    serverClosed = true;
    tryFinish();
  });
}

if (require.main === module) {
  process.on("exit", releaseInstanceLock);
  process.on("SIGINT", () => shutdown({ reason: "SIGINT" }));
  process.on("SIGTERM", () => shutdown({ reason: "SIGTERM" }));
  try { startServer(); } catch (error) { releaseInstanceLock(); throw error; }
}

module.exports = {
  app,
  db,
  startServer,
  get server() { return server; },
  getPortalStatus,
  getPortalRoles,
  hashPortalPassword,
  verifyPortalPassword,
  ipMatchesNetwork,
  isPrivateNetworkIp,
  timeTrackingRequestAccess,
  parseTimeEntrySequence,
  actualDayMetrics,
  evaluateTimeDay,
  validateProposedTimeEntries,
  timeTrackingDayStatus,
  bookTimeEntry,
  resolveStaleTimeEntry,
  timePresenceForContext,
  serverDiagnostics,
  migrateProtectedPersonnelRecords,
  parseProtectedJson,
  purgeExpiredSicknessData,
  runSicknessEscalationSweep,
  installationFeatures,
  installationFeaturesForApiPath,
  minimizedPayrollApiPayload,
  reconcileInterruptedIntegrationDeliveries,
  integrationConnectionConfigurationFingerprint,
  revalidateSqlPersonnelPreviewConnection,
  sqlInspectionFromResult,
  sqlSourceConfiguration,
  assertPersonnelImportProfileSource,
  validateUsbFeatures,
  validateUsbEmployees,
  usbProvisioningAvailability,
  releaseInstanceLockForTests,
};
