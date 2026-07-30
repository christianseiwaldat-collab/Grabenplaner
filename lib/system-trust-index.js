"use strict";

const CHECK_STATES = Object.freeze({
  PASS: "pass",
  FAIL: "fail",
  UNKNOWN: "unknown",
  NOT_APPLICABLE: "not_applicable",
});

const INDEX_SCHEMA_VERSION = 1;
const DEFAULT_BACKUP_MAXIMUM_AGE_HOURS = 6;
const DEFAULT_RECOVERY_MAXIMUM_AGE_HOURS = 24 * 100;
const DEFAULT_HOST_SECURITY_MAXIMUM_AGE_HOURS = 36;
const DISCLAIMER = "Der technische Vertrauensindex ist keine Verfügbarkeitsgarantie. Er fasst ausschließlich aktuell nachgewiesene technische Prüfpunkte zusammen.";

const CARD_DEFINITIONS = Object.freeze([
  { id: "server", label: "Server", points: 12 },
  { id: "database", label: "Datenbank", points: 15 },
  { id: "backup", label: "Backup", points: 18 },
  { id: "recovery", label: "Recovery", points: 25 },
  { id: "tls", label: "TLS & HTTPS", points: 10 },
  { id: "notifications", label: "Benachrichtigungen", points: 5 },
  { id: "storage", label: "Speicher", points: 10 },
  { id: "updates", label: "Updates", points: 5 },
]);

const CARD_SUMMARIES = Object.freeze({
  server: {
    pass: "Serverlaufzeit und interne Erreichbarkeit sind nachgewiesen.",
    fail: "Mindestens eine Serverprüfung ist fehlgeschlagen.",
    unknown: "Für mindestens eine Serverprüfung fehlt ein aktueller Nachweis.",
    not_applicable: "Die Serverprüfungen sind in diesem Betriebsmodus nicht anwendbar.",
  },
  database: {
    pass: "Die vorhandenen Datenbankprüfungen sind erfolgreich.",
    fail: "Mindestens eine Datenbankprüfung ist fehlgeschlagen.",
    unknown: "Für mindestens eine Datenbankprüfung fehlt ein aktueller Nachweis.",
    not_applicable: "Die Datenbankprüfungen sind nicht anwendbar.",
  },
  backup: {
    pass: "Lokale und externe Sicherungsnachweise sind aktuell.",
    fail: "Mindestens ein Sicherungsnachweis ist fehlgeschlagen.",
    unknown: "Für mindestens einen Sicherungsbereich fehlt ein aktueller Nachweis.",
    not_applicable: "Dieser Sicherungsbereich ist nicht eingerichtet.",
  },
  recovery: {
    pass: "Signaturkette, Wiederherstellung und Anwendungsprüfung sind nachgewiesen.",
    fail: "Mindestens eine Wiederherstellungsprüfung ist fehlgeschlagen.",
    unknown: "Die Wiederherstellung ist noch nicht vollständig bis zum Anwendungsstart nachgewiesen.",
    not_applicable: "Recovery Assurance ist in diesem Betriebsmodus nicht eingerichtet.",
  },
  tls: {
    pass: "Die vorhandenen HTTPS- und Zertifikatsprüfungen sind erfolgreich.",
    fail: "Mindestens eine HTTPS- oder Zertifikatsprüfung ist fehlgeschlagen.",
    unknown: "Für mindestens eine HTTPS-Prüfung fehlt ein aktueller Nachweis.",
    not_applicable: "TLS ist in diesem Betriebsmodus nicht anwendbar.",
  },
  notifications: {
    pass: "Konfiguration und eine reale Testzustellung sind nachgewiesen.",
    fail: "Der konfigurierte Benachrichtigungsweg ist fehlerhaft.",
    unknown: "Der Versandweg ist geladen, eine reale Testzustellung ist jedoch nicht nachgewiesen.",
    not_applicable: "Externe Benachrichtigungen sind nicht eingerichtet und werden nicht bewertet.",
  },
  storage: {
    pass: "Schreibbarkeit und Speicherplatzpruefung sind erfolgreich.",
    fail: "Mindestens eine Speicherpruefung ist fehlgeschlagen.",
    unknown: "Für mindestens eine Speicherprüfung fehlt ein aktueller Nachweis.",
    not_applicable: "Die Speicherprüfungen sind nicht anwendbar.",
  },
  updates: {
    pass: "App- und Host-Aktualisierungsstatus sind geprüft.",
    fail: "Mindestens eine Aktualisierung oder ein Neustart ist offen.",
    unknown: "Für mindestens einen Aktualisierungsbereich fehlt ein aktueller Nachweis.",
    not_applicable: "Die Aktualisierungsprüfungen sind nicht anwendbar.",
  },
});

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asObject(value) {
  return isObject(value) ? value : {};
}

function hasFiniteNumber(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function mergedDiagnostics(input) {
  const technical = asObject(input.diagnostics);
  const status = asObject(input.status);
  const technicalBackups = asObject(technical.backups);
  const statusBackups = asObject(status.backups);
  const internal = asObject(statusBackups.internal);
  const external = asObject(statusBackups.external);
  const backups = {
    ...statusBackups,
    ...technicalBackups,
    latestApp: technicalBackups.latestApp || (internal.available ? {
      committed: internal.committed,
      verified: internal.verified,
      modifiedAt: internal.createdAt,
    } : undefined),
    latestAppTimestampValid: technicalBackups.latestAppTimestampValid ?? internal.timestampValid,
    latestAppAgeHours: technicalBackups.latestAppAgeHours ?? internal.ageHours,
    externalEnabled: technicalBackups.externalEnabled ?? external.enabled,
    externalWritable: technicalBackups.externalWritable ?? external.writable,
    latestExternal: technicalBackups.latestExternal || (external.available ? {
      committed: external.committed,
      verified: external.verified,
      modifiedAt: external.createdAt,
    } : undefined),
    latestExternalTimestampValid: technicalBackups.latestExternalTimestampValid ?? external.timestampValid,
    latestExternalAgeHours: technicalBackups.latestExternalAgeHours ?? external.ageHours,
    freshnessHours: technicalBackups.freshnessHours ?? statusBackups.freshnessHours,
    offsite: { ...asObject(statusBackups.offsite), ...asObject(technicalBackups.offsite) },
  };
  return {
    ...status,
    ...technical,
    mode: technical.mode ?? status.mode,
    publicUrl: technical.publicUrl ?? status.publicUrl,
    alerts: Array.isArray(technical.alerts) ? technical.alerts : status.alerts,
    productionChecks: Array.isArray(technical.productionChecks)
      ? technical.productionChecks : Array.isArray(status.checks) ? status.checks : [],
    backups,
    monitor: { ...asObject(status.monitor), ...asObject(technical.monitor) },
    hostSecurity: { ...asObject(status.hostSecurity), ...asObject(technical.hostSecurity) },
    recoveryAssurance: { ...asObject(status.recoveryAssurance), ...asObject(technical.recoveryAssurance) },
    recovery: { ...asObject(status.recovery), ...asObject(technical.recovery) },
  };
}

function normalizeNow(value) {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(String(value || ""));
  return new Date(Number.isFinite(milliseconds) ? milliseconds : Date.now()).toISOString();
}

function normalizeTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function evidenceAgeHours(timestamp, now) {
  const observedMs = Date.parse(String(timestamp || ""));
  const nowMs = Date.parse(String(now || ""));
  if (!Number.isFinite(observedMs) || !Number.isFinite(nowMs) || observedMs > nowMs + 5 * 60 * 1000) return null;
  return Math.max(0, (nowMs - observedMs) / 3600000);
}

function freshnessState(timestamp, now, maximumAgeHours) {
  const ageHours = evidenceAgeHours(timestamp, now);
  return Number.isFinite(ageHours) && Number.isFinite(Number(maximumAgeHours))
    && ageHours <= Number(maximumAgeHours) ? CHECK_STATES.PASS : CHECK_STATES.UNKNOWN;
}

function check({ id, label, points, state, reasonCode, observedAt = null, critical = false }) {
  const normalizedState = Object.values(CHECK_STATES).includes(state) ? state : CHECK_STATES.UNKNOWN;
  return {
    id,
    label,
    state: normalizedState,
    points,
    earnedPoints: normalizedState === CHECK_STATES.PASS ? points : 0,
    critical: critical === true,
    reasonCode: String(reasonCode || "EVIDENCE_UNAVAILABLE"),
    observedAt: normalizeTimestamp(observedAt),
  };
}

function stateFromBoolean(value, { unavailable = CHECK_STATES.UNKNOWN } = {}) {
  if (value === true) return CHECK_STATES.PASS;
  if (value === false) return CHECK_STATES.FAIL;
  return unavailable;
}

function stateFromAll(values) {
  if (values.some((value) => value === false)) return CHECK_STATES.FAIL;
  if (values.length && values.every((value) => value === true)) return CHECK_STATES.PASS;
  return CHECK_STATES.UNKNOWN;
}

function reasonFor(state, prefix) {
  if (state === CHECK_STATES.PASS) return `${prefix}_PASSED`;
  if (state === CHECK_STATES.FAIL) return `${prefix}_FAILED`;
  if (state === CHECK_STATES.NOT_APPLICABLE) return `${prefix}_NOT_APPLICABLE`;
  return `${prefix}_UNKNOWN`;
}

function productionCheck(diagnostics, id) {
  const entry = Array.isArray(diagnostics.productionChecks)
    ? diagnostics.productionChecks.find((candidate) => candidate?.id === id)
    : null;
  return entry && typeof entry.ok === "boolean" ? entry.ok : undefined;
}

function serverModeActive(diagnostics) {
  return diagnostics.mode === "server";
}

function monitorEvidence(diagnostics) {
  const monitor = asObject(diagnostics.monitor);
  const configured = monitor.configured === true;
  const available = monitor.statusAvailable === true;
  const ageKnown = Number.isFinite(Number(monitor.ageHours));
  const current = configured && available && ageKnown && Number(monitor.ageHours) <= 1
    && monitor.complete === true && monitor.state === "ok";
  let state = CHECK_STATES.UNKNOWN;
  if (configured && available && monitor.state === "error") state = CHECK_STATES.FAIL;
  else if (current) state = CHECK_STATES.PASS;
  return {
    monitor,
    state,
    observedAt: monitor.generatedAt || null,
  };
}

function monitoredCheck(monitorEvidenceValue, id) {
  const value = monitorEvidenceValue.monitor?.checks?.[id];
  if (monitorEvidenceValue.state !== CHECK_STATES.PASS) {
    if (value === false && monitorEvidenceValue.monitor?.statusAvailable === true) return CHECK_STATES.FAIL;
    return CHECK_STATES.UNKNOWN;
  }
  return stateFromBoolean(value);
}

function explicitEvidenceState(value) {
  if (!isObject(value)) return CHECK_STATES.UNKNOWN;
  if (Object.values(CHECK_STATES).includes(value.state)) return value.state;
  if (value.ok === true) return CHECK_STATES.PASS;
  if (value.ok === false) return CHECK_STATES.FAIL;
  return CHECK_STATES.UNKNOWN;
}

function applicationSmokeEvidence(input, recoveryAssurance, now, maximumAgeHours) {
  const explicit = asObject(input.applicationSmoke);
  if (Object.keys(explicit).length) {
    const observedAt = explicit.checkedAt || explicit.observedAt || null;
    const state = explicitEvidenceState(explicit);
    return {
      state: state === CHECK_STATES.PASS && freshnessState(observedAt, now, maximumAgeHours) !== CHECK_STATES.PASS
        ? CHECK_STATES.UNKNOWN : state,
      observedAt,
    };
  }
  const event = Array.isArray(recoveryAssurance.events)
    ? recoveryAssurance.events.find((candidate) => [
      "application-smoke-passed", "application-smoke-failed", "application-smoke-not-run",
    ].includes(candidate?.eventType))
    : null;
  if (event?.eventType === "application-smoke-passed") return {
    state: freshnessState(event.occurredAt, now, maximumAgeHours),
    observedAt: event.occurredAt,
  };
  if (event?.eventType === "application-smoke-failed") return { state: CHECK_STATES.FAIL, observedAt: event.occurredAt };
  return { state: CHECK_STATES.UNKNOWN, observedAt: event?.occurredAt || null };
}

function buildServerChecks(input, context) {
  const { diagnostics, serverMode, now, monitor } = context;
  if (!serverMode) {
    return [check({ id: "server_mode", label: "Serverbetrieb", points: 12, state: CHECK_STATES.NOT_APPLICABLE, reasonCode: "SERVER_MODE_NOT_APPLICABLE" })];
  }
  const definitions = [
    ["runtime", "Produktionslaufzeit", 3, true],
    ["listener", "Interne Bindung", 2, true],
    ["proxy", "Proxy-Vertrauen", 2, true],
  ];
  const checks = definitions.map(([id, label, points, critical]) => {
    const state = stateFromBoolean(productionCheck(diagnostics, id));
    return check({ id: `server_${id}`, label, points, state, critical, reasonCode: reasonFor(state, `SERVER_${id.toUpperCase()}`), observedAt: now });
  });
  checks.push(check({
    id: "server_monitor_current", label: "Monitor aktuell und vollständig", points: 1,
    state: monitor.state, reasonCode: reasonFor(monitor.state, "SERVER_MONITOR"), observedAt: monitor.observedAt,
  }));
  for (const [id, label, points, critical] of [
    ["appService", "Anwendungsdienst", 2, true],
    ["live", "Live-Pruefung", 1, true],
    ["proxyService", "Proxy-Dienst", 1, true],
  ]) {
    const state = monitoredCheck(monitor, id);
    checks.push(check({ id: `server_monitor_${id}`, label, points, state, critical, reasonCode: reasonFor(state, `SERVER_MONITOR_${id.toUpperCase()}`), observedAt: monitor.observedAt }));
  }
  return checks;
}

function buildDatabaseChecks(input, context) {
  const { diagnostics, monitor } = context;
  const database = asObject(diagnostics.database);
  const startupState = database.integrity === "ok" ? CHECK_STATES.PASS
    : typeof database.integrity === "string" && database.integrity ? CHECK_STATES.FAIL : CHECK_STATES.UNKNOWN;
  const monitoredState = monitoredCheck(monitor, "sqlite");
  const foreignKeysState = stateFromBoolean(database.foreignKeys);
  return [
    check({ id: "database_startup_integrity", label: "Integrität beim Anwendungsstart", points: 6, state: startupState, critical: true, reasonCode: reasonFor(startupState, "DATABASE_STARTUP_INTEGRITY"), observedAt: diagnostics.process?.startedAt }),
    check({ id: "database_monitor_integrity", label: "Aktuelle SQLite-Prüfung", points: 7, state: monitoredState, critical: true, reasonCode: reasonFor(monitoredState, "DATABASE_MONITOR_INTEGRITY"), observedAt: monitor.observedAt }),
    check({ id: "database_foreign_keys", label: "Referenzintegrität", points: 2, state: foreignKeysState, critical: true, reasonCode: reasonFor(foreignKeysState, "DATABASE_FOREIGN_KEYS"), observedAt: context.now }),
  ];
}

function buildBackupChecks(input, context) {
  const { diagnostics, serverMode, monitor, now } = context;
  const backups = asObject(diagnostics.backups);
  const latestApp = asObject(backups.latestApp);
  const maximumAgeHours = hasFiniteNumber(backups.freshnessHours)
    ? Math.max(1, Number(backups.freshnessHours)) : DEFAULT_BACKUP_MAXIMUM_AGE_HOURS;
  const internalFresh = (hasFiniteNumber(backups.latestAppAgeHours)
    ? Number(backups.latestAppAgeHours) <= maximumAgeHours
    : freshnessState(latestApp.modifiedAt, now, maximumAgeHours) === CHECK_STATES.PASS) || undefined;
  const internalState = stateFromAll([
    Boolean(backups.latestApp),
    latestApp.committed,
    latestApp.verified,
    backups.latestAppTimestampValid,
    internalFresh,
  ]);
  const externalState = serverMode
    ? CHECK_STATES.NOT_APPLICABLE
    : backups.externalEnabled === true
      ? stateFromAll([
        backups.externalWritable,
        Boolean(backups.latestExternal),
        backups.latestExternal?.committed,
        backups.latestExternal?.verified,
        backups.latestExternalTimestampValid,
        (hasFiniteNumber(backups.latestExternalAgeHours)
          ? Number(backups.latestExternalAgeHours) <= maximumAgeHours
          : freshnessState(backups.latestExternal?.modifiedAt, now, maximumAgeHours) === CHECK_STATES.PASS) || undefined,
      ])
      : CHECK_STATES.NOT_APPLICABLE;
  const offsite = asObject(backups.offsite);
  const offsiteApplicable = serverMode || offsite.applicable === true || offsite.configured === true;
  const providerPolicyBlocked = offsiteApplicable
    && offsite.providerPolicy?.systemCenterOk !== true;
  const offsiteSnapshotState = !offsiteApplicable ? CHECK_STATES.NOT_APPLICABLE
    : providerPolicyBlocked ? CHECK_STATES.FAIL
      : offsite.configured !== true || offsite.statusAvailable === false ? CHECK_STATES.UNKNOWN
      : offsite.state === "error" || offsite.unresolvedFailures?.backup === true ? CHECK_STATES.FAIL
        : offsite.state === "ok" && Number.isFinite(offsite.agesHours?.backup) ? CHECK_STATES.PASS : CHECK_STATES.UNKNOWN;
  const repositoryState = !offsiteApplicable ? CHECK_STATES.NOT_APPLICABLE
    : providerPolicyBlocked ? CHECK_STATES.FAIL
      : offsite.configured !== true || offsite.statusAvailable === false ? CHECK_STATES.UNKNOWN
      : offsite.unresolvedFailures?.fullCheck === true ? CHECK_STATES.FAIL
        : offsite.state === "ok" && Number.isFinite(offsite.agesHours?.repositoryCheck)
          && Number.isFinite(offsite.agesHours?.fullCheck) ? CHECK_STATES.PASS : CHECK_STATES.UNKNOWN;
  return [
    check({ id: "backup_internal", label: "Interne Sicherung", points: 4, state: internalState, reasonCode: reasonFor(internalState, "BACKUP_INTERNAL"), observedAt: latestApp.modifiedAt }),
    check({ id: "backup_external", label: "Getrennte lokale Sicherung", points: 5, state: externalState, reasonCode: reasonFor(externalState, "BACKUP_EXTERNAL"), observedAt: backups.latestExternal?.modifiedAt }),
    check({ id: "backup_offsite_snapshot", label: "Verschlüsselter Offsite-Snapshot", points: 5, state: offsiteSnapshotState, critical: offsiteSnapshotState === CHECK_STATES.FAIL, reasonCode: reasonFor(offsiteSnapshotState, "BACKUP_OFFSITE_SNAPSHOT"), observedAt: offsite.lastSuccessAt }),
    check({ id: "backup_repository_check", label: "Repository- und Vollprüfung", points: 4, state: repositoryState, critical: repositoryState === CHECK_STATES.FAIL, reasonCode: reasonFor(repositoryState, "BACKUP_REPOSITORY_CHECK"), observedAt: offsite.lastFullCheckAt || offsite.lastRepositoryCheckAt || monitor.observedAt }),
  ];
}

function buildRecoveryChecks(input, context) {
  const { diagnostics, serverMode, now } = context;
  const assurance = asObject(diagnostics.recoveryAssurance);
  const recovery = asObject(diagnostics.recovery);
  if (!serverMode && assurance.configured !== true) {
    return [check({ id: "recovery_mode", label: "Recovery Assurance", points: 25, state: CHECK_STATES.NOT_APPLICABLE, reasonCode: "RECOVERY_NOT_APPLICABLE" })];
  }
  const chainState = assurance.configured !== true || assurance.statusAvailable !== true ? CHECK_STATES.UNKNOWN
    : stateFromBoolean(assurance.integrityVerified);
  const maximumAgeHours = hasFiniteNumber(assurance.maximumAgeHours)
    ? Number(assurance.maximumAgeHours) : DEFAULT_RECOVERY_MAXIMUM_AGE_HOURS;
  const runAgeFresh = hasFiniteNumber(assurance.ageHours)
    ? Number(assurance.ageHours) <= maximumAgeHours
    : freshnessState(assurance.generatedAt, now, maximumAgeHours) === CHECK_STATES.PASS;
  const runFresh = assurance.stale !== true && runAgeFresh;
  const runState = assurance.configured !== true || assurance.statusAvailable !== true ? CHECK_STATES.UNKNOWN
    : assurance.state === "ok" && runFresh ? CHECK_STATES.PASS
      : assurance.state === "error" ? CHECK_STATES.FAIL : CHECK_STATES.UNKNOWN;
  const restoreFailure = diagnostics.backups?.offsite?.unresolvedFailures?.restoreTest === true;
  const restoreAgeHours = recovery.isolatedRestoreTestAgeHours;
  const restoreFresh = hasFiniteNumber(restoreAgeHours)
    ? Number(restoreAgeHours) <= maximumAgeHours
    : freshnessState(recovery.isolatedRestoreTestAt, now, maximumAgeHours) === CHECK_STATES.PASS;
  const restoreState = restoreFailure ? CHECK_STATES.FAIL
    : recovery.isolatedRestoreTestPending === false && Boolean(recovery.isolatedRestoreTestAt) && restoreFresh ? CHECK_STATES.PASS
      : CHECK_STATES.UNKNOWN;
  const appSmoke = applicationSmokeEvidence(input, assurance, now, maximumAgeHours);
  const automation = asObject(input.automationStatus);
  const automationState = automation.state === "healthy" ? CHECK_STATES.PASS
    : automation.state === "critical" ? CHECK_STATES.FAIL : CHECK_STATES.UNKNOWN;
  return [
    check({ id: "recovery_signed_history", label: "Signierte Prüfhistorie", points: 7, state: chainState, critical: true, reasonCode: reasonFor(chainState, "RECOVERY_SIGNED_HISTORY"), observedAt: assurance.checkedAt || assurance.generatedAt }),
    check({ id: "recovery_full_run", label: "Vollständiger Assurance-Lauf", points: 2, state: runState, critical: runState === CHECK_STATES.FAIL, reasonCode: reasonFor(runState, "RECOVERY_FULL_RUN"), observedAt: assurance.generatedAt }),
    check({ id: "recovery_nightly_automation", label: "Nächtliche Recovery-Automatik", points: 3, state: automationState, critical: automationState === CHECK_STATES.FAIL, reasonCode: automation.reasonCode || reasonFor(automationState, "RECOVERY_AUTOMATION"), observedAt: automation.lastRunAt || assurance.generatedAt }),
    check({ id: "recovery_isolated_restore", label: "Isolierter Test-Restore", points: 8, state: restoreState, critical: restoreState === CHECK_STATES.FAIL, reasonCode: reasonFor(restoreState, "RECOVERY_ISOLATED_RESTORE"), observedAt: recovery.isolatedRestoreTestAt }),
    check({ id: "recovery_application_smoke", label: "Anwendungsstart nach Restore", points: 5, state: appSmoke.state, critical: appSmoke.state === CHECK_STATES.FAIL, reasonCode: reasonFor(appSmoke.state, "RECOVERY_APPLICATION_SMOKE"), observedAt: appSmoke.observedAt }),
  ];
}

function buildTlsChecks(input, context) {
  const { diagnostics, serverMode, monitor } = context;
  if (!serverMode) {
    return [check({ id: "tls_mode", label: "TLS im Serverbetrieb", points: 10, state: CHECK_STATES.NOT_APPLICABLE, reasonCode: "TLS_NOT_APPLICABLE" })];
  }
  const configurationState = stateFromBoolean(/^https:\/\//i.test(String(diagnostics.publicUrl || "")));
  const publicState = monitoredCheck(monitor, "publicReady");
  const certificateState = monitoredCheck(monitor, "tlsCertificate");
  const hstsState = monitoredCheck(monitor, "hsts");
  return [
    check({ id: "tls_https_configuration", label: "HTTPS-Konfiguration", points: 1, state: configurationState, critical: true, reasonCode: reasonFor(configurationState, "TLS_HTTPS_CONFIGURATION"), observedAt: context.now }),
    check({ id: "tls_public_ready", label: "Öffentliche HTTPS-Prüfung", points: 1, state: publicState, critical: true, reasonCode: reasonFor(publicState, "TLS_PUBLIC_READY"), observedAt: monitor.observedAt }),
    check({ id: "tls_certificate", label: "TLS-Zertifikat", points: 6, state: certificateState, critical: true, reasonCode: reasonFor(certificateState, "TLS_CERTIFICATE"), observedAt: monitor.observedAt }),
    check({ id: "tls_hsts", label: "HSTS-Schutz", points: 2, state: hstsState, critical: true, reasonCode: reasonFor(hstsState, "TLS_HSTS"), observedAt: monitor.observedAt }),
  ];
}

function buildNotificationChecks(input, context) {
  const notificationStatus = asObject(input.notificationStatus);
  const providerRoot = isObject(notificationStatus.providers) ? notificationStatus.providers
    : Object.keys(notificationStatus).length ? notificationStatus : asObject(input.notificationProviders);
  const provider = asObject(providerRoot).email;
  if (!isObject(provider) || provider.configured !== true) {
    return [check({ id: "notifications_not_configured", label: "Externe Benachrichtigungen", points: 5, state: CHECK_STATES.NOT_APPLICABLE, reasonCode: "NOTIFICATIONS_NOT_CONFIGURED" })];
  }
  const providerState = provider.valid === false ? CHECK_STATES.FAIL
    : provider.valid === true && provider.available === true ? CHECK_STATES.PASS : CHECK_STATES.UNKNOWN;
  const deliveryRoot = isObject(notificationStatus.deliveries) ? notificationStatus.deliveries
    : asObject(input.notificationDelivery);
  const delivery = asObject(deliveryRoot).email;
  const deliveryState = explicitEvidenceState(delivery);
  return [
    check({ id: "notifications_provider", label: "Versandweg konfiguriert", points: 2, state: providerState, reasonCode: reasonFor(providerState, "NOTIFICATIONS_PROVIDER"), observedAt: context.now }),
    check({ id: "notifications_delivery", label: "Reale Testzustellung", points: 3, state: deliveryState, reasonCode: reasonFor(deliveryState, "NOTIFICATIONS_DELIVERY"), observedAt: delivery?.checkedAt || delivery?.observedAt }),
  ];
}

function buildStorageChecks(input, context) {
  const { diagnostics, monitor, serverMode } = context;
  const dataState = stateFromBoolean(diagnostics.storage?.data?.writable);
  const externalApplicable = !serverMode && diagnostics.backups?.externalEnabled === true;
  const externalState = externalApplicable
    ? stateFromBoolean(diagnostics.backups?.externalWritable)
    : CHECK_STATES.NOT_APPLICABLE;
  const diskState = monitoredCheck(monitor, "diskSpace");
  return [
    check({ id: "storage_data_writable", label: "Geschützte Datenbereiche", points: 4, state: dataState, critical: true, reasonCode: reasonFor(dataState, "STORAGE_DATA_WRITABLE"), observedAt: context.now }),
    check({ id: "storage_external_writable", label: "Getrenntes Sicherungsziel", points: 2, state: externalState, critical: externalState === CHECK_STATES.FAIL, reasonCode: reasonFor(externalState, "STORAGE_EXTERNAL_WRITABLE"), observedAt: context.now }),
    check({ id: "storage_disk_space", label: "Freier Speicherplatz", points: 4, state: diskState, critical: diskState === CHECK_STATES.FAIL, reasonCode: reasonFor(diskState, "STORAGE_DISK_SPACE"), observedAt: monitor.observedAt }),
  ];
}

function buildUpdateChecks(input, context) {
  const { diagnostics, serverMode, now } = context;
  const update = asObject(input.updateStatus);
  const reachableState = update.ok === true ? CHECK_STATES.PASS
    : update.ok === false ? CHECK_STATES.FAIL : CHECK_STATES.UNKNOWN;
  const currentState = typeof update.updateAvailable === "boolean"
    ? stateFromBoolean(!update.updateAvailable) : CHECK_STATES.UNKNOWN;
  const hostSecurity = asObject(diagnostics.hostSecurity);
  const hostConfigured = serverMode && hostSecurity.configured === true;
  const hostCurrent = hostConfigured && hostSecurity.statusAvailable === true
    && hostSecurity.state === "ok" && hasFiniteNumber(hostSecurity.ageHours)
    && Number(hostSecurity.ageHours) <= DEFAULT_HOST_SECURITY_MAXIMUM_AGE_HOURS;
  const automaticState = !serverMode ? CHECK_STATES.NOT_APPLICABLE
    : !hostConfigured || hostSecurity.statusAvailable !== true ? CHECK_STATES.UNKNOWN
      : hostSecurity.checks?.automaticUpdates === false ? CHECK_STATES.FAIL
        : hostCurrent ? stateFromBoolean(hostSecurity.checks?.automaticUpdates) : CHECK_STATES.UNKNOWN;
  const restartState = !serverMode ? CHECK_STATES.NOT_APPLICABLE
    : !hostConfigured || hostSecurity.statusAvailable !== true ? CHECK_STATES.UNKNOWN
      : hostSecurity.rebootRequired === true || hostSecurity.pendingConfirmation === true ? CHECK_STATES.FAIL
        : hostCurrent ? stateFromAll([hostSecurity.rebootRequired === false, hostSecurity.pendingConfirmation === false])
          : CHECK_STATES.UNKNOWN;
  return [
    check({ id: "updates_release_check", label: "GitHub-Aktualisierungscheck", points: 2, state: reachableState, reasonCode: reasonFor(reachableState, "UPDATES_RELEASE_CHECK"), observedAt: update.checkedAt || now }),
    check({ id: "updates_app_current", label: "App-Version aktuell", points: 1, state: currentState, reasonCode: reasonFor(currentState, "UPDATES_APP_CURRENT"), observedAt: update.checkedAt || now }),
    check({ id: "updates_host_automatic", label: "Automatische Host-Updates", points: 1, state: automaticState, reasonCode: reasonFor(automaticState, "UPDATES_HOST_AUTOMATIC"), observedAt: hostSecurity.checkedAt }),
    check({ id: "updates_restart_clear", label: "Kein offener Sicherheitsneustart", points: 1, state: restartState, reasonCode: reasonFor(restartState, "UPDATES_RESTART_CLEAR"), observedAt: hostSecurity.checkedAt }),
  ];
}

const CARD_BUILDERS = Object.freeze({
  server: buildServerChecks,
  database: buildDatabaseChecks,
  backup: buildBackupChecks,
  recovery: buildRecoveryChecks,
  tls: buildTlsChecks,
  notifications: buildNotificationChecks,
  storage: buildStorageChecks,
  updates: buildUpdateChecks,
});

function summarizeCard(definition, checks) {
  const applicable = checks.filter((entry) => entry.state !== CHECK_STATES.NOT_APPLICABLE);
  const possiblePoints = applicable.reduce((sum, entry) => sum + entry.points, 0);
  const earnedPoints = applicable.reduce((sum, entry) => sum + entry.earnedPoints, 0);
  const knownPoints = applicable.filter((entry) => [CHECK_STATES.PASS, CHECK_STATES.FAIL].includes(entry.state))
    .reduce((sum, entry) => sum + entry.points, 0);
  let state = CHECK_STATES.PASS;
  if (!possiblePoints) state = CHECK_STATES.NOT_APPLICABLE;
  else if (applicable.some((entry) => entry.state === CHECK_STATES.FAIL)) state = CHECK_STATES.FAIL;
  else if (applicable.some((entry) => entry.state === CHECK_STATES.UNKNOWN)) state = CHECK_STATES.UNKNOWN;
  const timestamps = applicable.map((entry) => entry.observedAt).filter(Boolean).map(Date.parse).filter(Number.isFinite);
  return {
    id: definition.id,
    label: definition.label,
    state,
    earnedPoints,
    possiblePoints,
    coverage: possiblePoints ? Math.round((knownPoints / possiblePoints) * 100) : null,
    evidenceAt: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
    summary: CARD_SUMMARIES[definition.id][state],
    checks,
  };
}

function indexCap({ criticalCheck, criticalAlert, coverage }) {
  if (criticalCheck) return { cap: 49, reason: "CRITICAL_CHECK_FAILED" };
  if (criticalAlert) return { cap: 49, reason: "CRITICAL_ALERT_PRESENT" };
  if (coverage < 60) return { cap: 49, reason: "EVIDENCE_COVERAGE_BELOW_60" };
  if (coverage < 80) return { cap: 69, reason: "EVIDENCE_COVERAGE_BELOW_80" };
  if (coverage < 90) return { cap: 84, reason: "EVIDENCE_COVERAGE_BELOW_90" };
  return { cap: 100, reason: null };
}

function buildSystemTrustIndex(input = {}) {
  const normalizedInput = asObject(input);
  const diagnostics = mergedDiagnostics(normalizedInput);
  const now = normalizeNow(normalizedInput.now);
  const context = {
    diagnostics,
    now,
    serverMode: serverModeActive(diagnostics),
    monitor: monitorEvidence(diagnostics),
  };
  const cards = CARD_DEFINITIONS.map((definition) => summarizeCard(
    definition,
    CARD_BUILDERS[definition.id](normalizedInput, context),
  ));
  const allChecks = cards.flatMap((card) => card.checks);
  const applicableChecks = allChecks.filter((entry) => entry.state !== CHECK_STATES.NOT_APPLICABLE);
  const possiblePoints = applicableChecks.reduce((sum, entry) => sum + entry.points, 0);
  const earnedPoints = applicableChecks.reduce((sum, entry) => sum + entry.earnedPoints, 0);
  const knownPoints = applicableChecks.filter((entry) => [CHECK_STATES.PASS, CHECK_STATES.FAIL].includes(entry.state))
    .reduce((sum, entry) => sum + entry.points, 0);
  const rawScore = possiblePoints ? Math.round((earnedPoints / possiblePoints) * 100) : 0;
  const coverage = possiblePoints ? Math.round((knownPoints / possiblePoints) * 100) : 0;
  const criticalCheck = applicableChecks.some((entry) => entry.critical && entry.state === CHECK_STATES.FAIL);
  const alerts = Array.isArray(diagnostics.alerts) ? diagnostics.alerts : [];
  const criticalAlert = alerts.some((entry) => entry?.severity === "critical");
  const warningAlert = alerts.some((entry) => entry?.severity === "warning");
  const cap = indexCap({ criticalCheck, criticalAlert, coverage });
  const score = Math.min(rawScore, cap.cap);
  const hasAttention = warningAlert || allChecks.some((entry) => [CHECK_STATES.FAIL, CHECK_STATES.UNKNOWN].includes(entry.state));
  let state = "healthy";
  let label = "Hoher technischer Vertrauensstand";
  if (criticalCheck || criticalAlert) {
    state = "critical";
    label = "Kritische Prüfung offen";
  } else if (coverage < 60) {
    state = "unverified";
    label = "Nachweise unvollständig";
  } else if (hasAttention || score < 90) {
    state = "attention";
    label = score >= 75 ? "Solide mit offenen Prüfpunkten" : "Aufmerksamkeit erforderlich";
  }
  return {
    score,
    rawScore,
    coverage,
    state,
    label,
    capReason: cap.reason,
    disclaimer: DISCLAIMER,
    cards,
  };
}

module.exports = {
  CARD_DEFINITIONS,
  CHECK_STATES,
  DISCLAIMER,
  INDEX_SCHEMA_VERSION,
  DEFAULT_BACKUP_MAXIMUM_AGE_HOURS,
  DEFAULT_HOST_SECURITY_MAXIMUM_AGE_HOURS,
  DEFAULT_RECOVERY_MAXIMUM_AGE_HOURS,
  buildSystemTrustIndex,
};
