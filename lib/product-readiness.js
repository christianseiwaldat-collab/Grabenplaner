"use strict";

const crypto = require("node:crypto");

const PRODUCT_READINESS_SCHEMA_VERSION = 1;
const PRODUCT_READINESS_STANDARD = Object.freeze({
  accessibility: {
    id: "wcag-2.2",
    label: "WCAG 2.2",
    url: "https://www.w3.org/TR/WCAG22/",
  },
  security: {
    id: "owasp-asvs-5.0.0",
    label: "OWASP ASVS 5.0.0",
    url: "https://owasp.org/www-project-application-security-verification-standard/",
  },
});

const PRODUCT_READINESS_CHECKS = Object.freeze([
  {
    id: "desktop_planning_pdf",
    gate: "pilot",
    label: "Desktop: Dienstplanung und PDF",
    description: "Wochenplanung bearbeiten, speichern und als PDF exportieren.",
  },
  {
    id: "desktop_admin_workflows",
    gate: "pilot",
    label: "Desktop: Verwaltungsabläufe",
    description: "Personal, Anträge und Einstellungen in einem unterstützten Desktop-Browser prüfen.",
  },
  {
    id: "mobile_portal_core",
    gate: "mobile",
    label: "Mobil: Portal-Kernabläufe",
    description: "Login, Zeiterfassung, Dienstplan sowie Urlaub und ZA im mobilen Browser prüfen.",
  },
  {
    id: "mobile_uploads",
    gate: "mobile",
    label: "Mobil: Kamera- und Datei-Uploads",
    description: "AUM per Kamera und bestehender Datei hochladen; Rückkehr in den richtigen Ablauf prüfen.",
  },
  {
    id: "keyboard_navigation",
    gate: "accessibility",
    label: "Tastaturbedienung",
    description: "Kernabläufe ohne Maus bedienen; Fokus bleibt sichtbar und nachvollziehbar.",
    standard: PRODUCT_READINESS_STANDARD.accessibility,
  },
  {
    id: "zoom_200",
    gate: "accessibility",
    label: "200-%-Zoom und Umbruch",
    description: "Kernseiten bei 200 % ohne verdeckte Bedienung und unnötiges horizontales Scrollen prüfen.",
    standard: PRODUCT_READINESS_STANDARD.accessibility,
  },
  {
    id: "accessible_names",
    gate: "accessibility",
    label: "Beschriftungen und Statusmeldungen",
    description: "Bedienelemente, Dialoge und dynamische Meldungen besitzen verständliche Namen.",
    standard: PRODUCT_READINESS_STANDARD.accessibility,
  },
  {
    id: "contrast_review",
    gate: "accessibility",
    label: "Kontrastprüfung Hell und Dunkel",
    description: "Text, Zustände, Fokus und Tabellen in beiden Darstellungen visuell prüfen.",
    standard: PRODUCT_READINESS_STANDARD.accessibility,
  },
  {
    id: "performance_desktop",
    gate: "performance",
    label: "Desktop-Ladezeit",
    description: "Gemessener Seitenstart im Pilotnetz; Budget höchstens 3.000 ms.",
    budgetMs: 3_000,
  },
  {
    id: "performance_mobile",
    gate: "performance",
    label: "Mobile Ladezeit",
    description: "Gemessener Seitenstart im realen Mobilbrowser; Budget höchstens 5.000 ms.",
    budgetMs: 5_000,
  },
]);

const PRODUCT_READINESS_CHECK_IDS = new Set(PRODUCT_READINESS_CHECKS.map(({ id }) => id));
const ACCEPTANCE_DISCIPLINES = new Set(["technical", "operational"]);
const EVIDENCE_OUTCOMES = new Set(["pass", "fail"]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function normalizedInstant(value, fallback = new Date()) {
  const parsed = new Date(value || fallback);
  if (!Number.isFinite(parsed.getTime())) {
    const error = new Error("Der Prüfzeitpunkt ist ungültig.");
    error.code = "PRODUCT_READINESS_TIMESTAMP_INVALID";
    throw error;
  }
  return parsed.toISOString();
}

function normalizedObservedAt(value, now) {
  const observedAt = normalizedInstant(value, now);
  const distanceMs = Math.abs(Date.parse(observedAt) - new Date(now).getTime());
  if (distanceMs > 15 * 60 * 1_000) {
    const error = new Error("Der Prüfzeitpunkt muss zum aktuell protokollierten Pilotlauf gehören.");
    error.code = "PRODUCT_READINESS_OBSERVED_AT_OUT_OF_RANGE";
    throw error;
  }
  return observedAt;
}

function shortText(value, maximum, label) {
  const text = String(value || "").trim();
  if (text.length > maximum) {
    const error = new Error(`${label} ist zu lang.`);
    error.code = "PRODUCT_READINESS_INPUT_TOO_LONG";
    throw error;
  }
  return text;
}

function normalizedEnvironment(input = {}) {
  const environment = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const width = Number(environment.viewportWidth);
  const height = Number(environment.viewportHeight);
  return {
    platform: shortText(environment.platform, 80, "Die Plattform"),
    browser: shortText(environment.browser, 80, "Der Browser"),
    browserVersion: shortText(environment.browserVersion, 40, "Die Browserversion"),
    userAgent: shortText(environment.userAgent, 500, "Der Browserhinweis"),
    viewportWidth: Number.isSafeInteger(width) && width >= 240 && width <= 16_384 ? width : null,
    viewportHeight: Number.isSafeInteger(height) && height >= 240 && height <= 16_384 ? height : null,
    colorScheme: ["light", "dark"].includes(environment.colorScheme) ? environment.colorScheme : "",
  };
}

function normalizedMeasurement(check, input = {}) {
  const measurement = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (!check.budgetMs) return null;
  const durationMs = Number(measurement.durationMs);
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 600_000) {
    const error = new Error("Für die Performance-Prüfung ist eine gültige Dauer erforderlich.");
    error.code = "PRODUCT_READINESS_MEASUREMENT_INVALID";
    throw error;
  }
  return {
    durationMs: Math.round(durationMs),
    budgetMs: check.budgetMs,
  };
}

function assertMatchingFormFactor(check, environment) {
  const desktop = check.id.startsWith("desktop_") || check.id === "performance_desktop";
  const mobile = check.id.startsWith("mobile_") || check.id === "performance_mobile";
  if (!desktop && !mobile) return;
  const width = environment.viewportWidth;
  if (!Number.isSafeInteger(width)) {
    const error = new Error("Für Desktop- und Mobilprüfungen muss die aktuelle Viewport-Breite erfasst werden.");
    error.code = "PRODUCT_READINESS_VIEWPORT_REQUIRED";
    throw error;
  }
  if (desktop && width < 900) {
    const error = new Error("Diese Prüfung muss in einer Desktop-Ansicht mit mindestens 900 CSS-Pixeln Breite erfolgen.");
    error.code = "PRODUCT_READINESS_DESKTOP_VIEWPORT_REQUIRED";
    throw error;
  }
  if (mobile && width > 899) {
    const error = new Error("Diese Prüfung muss in einer mobilen Ansicht mit höchstens 899 CSS-Pixeln Breite erfolgen.");
    error.code = "PRODUCT_READINESS_MOBILE_VIEWPORT_REQUIRED";
    throw error;
  }
}

function createProductReadinessEvidence(input = {}, {
  id = `readiness-evidence:${crypto.randomUUID()}`,
  actor = "system",
  releaseVersion = "",
  now = new Date(),
} = {}) {
  const checkId = String(input.checkId || "").trim();
  const check = PRODUCT_READINESS_CHECKS.find((entry) => entry.id === checkId);
  if (!check || !PRODUCT_READINESS_CHECK_IDS.has(checkId)) {
    const error = new Error("Die ausgewählte Pilotprüfung ist unbekannt.");
    error.code = "PRODUCT_READINESS_CHECK_INVALID";
    throw error;
  }
  const outcome = String(input.outcome || "").trim();
  if (!EVIDENCE_OUTCOMES.has(outcome)) {
    const error = new Error("Das Prüfergebnis muss bestanden oder fehlgeschlagen sein.");
    error.code = "PRODUCT_READINESS_OUTCOME_INVALID";
    throw error;
  }
  const measurement = normalizedMeasurement(check, input.measurement);
  if (measurement && outcome === "pass" && measurement.durationMs > measurement.budgetMs) {
    const error = new Error("Eine Messung über dem festgelegten Budget kann nicht als bestanden protokolliert werden.");
    error.code = "PRODUCT_READINESS_BUDGET_EXCEEDED";
    throw error;
  }
  const environment = normalizedEnvironment(input.environment);
  assertMatchingFormFactor(check, environment);
  const normalizedReleaseVersion = shortText(releaseVersion, 80, "Die Release-Version");
  if (!normalizedReleaseVersion) {
    const error = new Error("Der Pilotnachweis muss an eine Release-Version gebunden sein.");
    error.code = "PRODUCT_READINESS_RELEASE_VERSION_REQUIRED";
    throw error;
  }
  const payload = {
    schemaVersion: PRODUCT_READINESS_SCHEMA_VERSION,
    id: String(id),
    releaseVersion: normalizedReleaseVersion,
    checkId,
    outcome,
    environment,
    measurement,
    note: shortText(input.note, 1_000, "Die Prüfnotiz"),
    observedBy: String(actor || "system"),
    observedAt: normalizedObservedAt(input.observedAt, now),
    createdAt: normalizedInstant(now),
  };
  return Object.freeze({ ...payload, receiptSha256: sha256(payload) });
}

function verifyProductReadinessEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { receiptSha256, ...payload } = value;
  return /^[a-f0-9]{64}$/.test(String(receiptSha256 || ""))
    && PRODUCT_READINESS_CHECK_IDS.has(String(value.checkId || ""))
    && EVIDENCE_OUTCOMES.has(String(value.outcome || ""))
    && String(value.releaseVersion || "").length > 0
    && sha256(payload) === receiptSha256;
}

function latestEvidenceByCheck(evidence, releaseVersion) {
  const latest = new Map();
  for (const entry of Array.isArray(evidence) ? evidence : []) {
    if (!verifyProductReadinessEvidence(entry)) {
      const error = new Error("Ein gespeicherter Pilotnachweis besitzt keine gültige Prüfsumme.");
      error.code = "PRODUCT_READINESS_EVIDENCE_INTEGRITY_FAILED";
      throw error;
    }
    if (entry.releaseVersion !== releaseVersion) continue;
    const current = latest.get(entry.checkId);
    if (!current || Date.parse(entry.observedAt) > Date.parse(current.observedAt)
      || (entry.observedAt === current.observedAt && entry.id > current.id)) {
      latest.set(entry.checkId, entry);
    }
  }
  return latest;
}

function gateState(requiredCheckIds, latest) {
  const evidence = requiredCheckIds.map((id) => latest.get(id) || null);
  if (evidence.some((entry) => entry?.outcome === "fail")) return "fail";
  if (evidence.every((entry) => entry?.outcome === "pass")) return "pass";
  return "pending";
}

function technicalCardState(trustIndex, id) {
  const card = Array.isArray(trustIndex?.cards)
    ? trustIndex.cards.find((entry) => entry?.id === id) : null;
  const state = String(card?.state || card?.status || "");
  if (["pass", "healthy", "ok"].includes(state)) return "pass";
  if (["fail", "critical", "error"].includes(state)) return "fail";
  return "pending";
}

function createAcceptance(input = {}, {
  id = `readiness-acceptance:${crypto.randomUUID()}`,
  actor = "system",
  releaseVersion,
  basisSha256,
  now = new Date(),
} = {}) {
  const discipline = String(input.discipline || "").trim();
  if (!ACCEPTANCE_DISCIPLINES.has(discipline)) {
    const error = new Error("Die Abnahmeart ist unbekannt.");
    error.code = "PRODUCT_READINESS_ACCEPTANCE_DISCIPLINE_INVALID";
    throw error;
  }
  const decision = String(input.decision || "").trim();
  if (!["approved", "rejected"].includes(decision)) {
    const error = new Error("Die Abnahmeentscheidung ist ungültig.");
    error.code = "PRODUCT_READINESS_ACCEPTANCE_DECISION_INVALID";
    throw error;
  }
  if (!/^[a-f0-9]{64}$/.test(String(basisSha256 || ""))) {
    const error = new Error("Der Abnahme fehlt ein gültiger Prüfstand.");
    error.code = "PRODUCT_READINESS_BASIS_INVALID";
    throw error;
  }
  const payload = {
    schemaVersion: PRODUCT_READINESS_SCHEMA_VERSION,
    id: String(id),
    discipline,
    decision,
    releaseVersion: String(releaseVersion || ""),
    basisSha256: String(basisSha256),
    note: shortText(input.note, 1_000, "Die Abnahmenotiz"),
    decidedBy: String(actor || "system"),
    decidedAt: normalizedInstant(now),
  };
  return Object.freeze({ ...payload, receiptSha256: sha256(payload) });
}

function verifyAcceptance(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { receiptSha256, ...payload } = value;
  return /^[a-f0-9]{64}$/.test(String(receiptSha256 || ""))
    && ACCEPTANCE_DISCIPLINES.has(String(value.discipline || ""))
    && sha256(payload) === receiptSha256;
}

function latestAcceptanceByDiscipline(acceptances) {
  const latest = new Map();
  for (const entry of Array.isArray(acceptances) ? acceptances : []) {
    if (!verifyAcceptance(entry)) {
      const error = new Error("Eine gespeicherte Abnahme besitzt keine gültige Prüfsumme.");
      error.code = "PRODUCT_READINESS_ACCEPTANCE_INTEGRITY_FAILED";
      throw error;
    }
    const current = latest.get(entry.discipline);
    if (!current || Date.parse(entry.decidedAt) > Date.parse(current.decidedAt)
      || (entry.decidedAt === current.decidedAt && entry.id > current.id)) {
      latest.set(entry.discipline, entry);
    }
  }
  return latest;
}

function buildProductReadiness({
  evidence = [],
  acceptances = [],
  trustIndex = {},
  recovery = {},
  releaseVersion = "",
  generatedAt = new Date(),
} = {}) {
  const latest = latestEvidenceByCheck(evidence, String(releaseVersion || ""));
  const manualGates = [
    {
      id: "pilot",
      label: "Desktop-Pilot",
      checkIds: ["desktop_planning_pdf", "desktop_admin_workflows"],
    },
    {
      id: "mobile",
      label: "Mobiler Browser",
      checkIds: ["mobile_portal_core", "mobile_uploads"],
    },
    {
      id: "accessibility",
      label: "Barrierearme Bedienung",
      checkIds: ["keyboard_navigation", "zoom_200", "accessible_names", "contrast_review"],
      standard: PRODUCT_READINESS_STANDARD.accessibility,
    },
    {
      id: "performance",
      label: "Performance-Budgets",
      checkIds: ["performance_desktop", "performance_mobile"],
    },
  ].map((gate) => ({
    ...gate,
    state: gateState(gate.checkIds, latest),
    checks: gate.checkIds.map((id) => {
      const definition = PRODUCT_READINESS_CHECKS.find((entry) => entry.id === id);
      return { ...definition, latest: latest.get(id) || null };
    }),
  }));

  const securityParts = ["server", "database", "tls"].map((id) => technicalCardState(trustIndex, id));
  const securityState = securityParts.some((state) => state === "fail") ? "fail"
    : securityParts.every((state) => state === "pass") ? "pass" : "pending";
  const recoveryState = technicalCardState(trustIndex, "recovery") === "pass"
    && recovery?.applicationSmokeState === "passed" ? "pass"
    : technicalCardState(trustIndex, "recovery") === "fail"
      || recovery?.applicationSmokeState === "failed" ? "fail" : "pending";
  const technicalGates = [
    {
      id: "security",
      label: "Security-Audit",
      state: securityState,
      standard: PRODUCT_READINESS_STANDARD.security,
      detail: "Server, Datenbank und HTTPS müssen aktuell technisch bestätigt sein.",
    },
    {
      id: "recovery",
      label: "Recovery-Drill",
      state: recoveryState,
      detail: "Isolierter Restore und anschließender Anwendungsstart müssen nachgewiesen sein.",
    },
  ];
  const gates = [...manualGates, ...technicalGates];
  const basis = {
    schemaVersion: PRODUCT_READINESS_SCHEMA_VERSION,
    releaseVersion: String(releaseVersion || ""),
    gates: gates.map(({ id, state, checks }) => ({
      id,
      state,
      evidenceReceipts: (checks || []).map((check) => check.latest?.receiptSha256 || null),
    })),
  };
  const basisSha256 = sha256(basis);
  const latestAcceptances = latestAcceptanceByDiscipline(acceptances);
  const acceptance = ["technical", "operational"].map((discipline) => {
    const value = latestAcceptances.get(discipline) || null;
    const current = value?.basisSha256 === basisSha256 && value?.releaseVersion === releaseVersion;
    return {
      discipline,
      label: discipline === "technical" ? "Technische Abnahme" : "Fachliche Abnahme",
      state: current ? (value.decision === "approved" ? "pass" : "fail") : "pending",
      latest: value,
      current,
    };
  });
  const allGatesPass = gates.every((gate) => gate.state === "pass");
  const accepted = allGatesPass && acceptance.every((entry) => entry.state === "pass");
  const failed = gates.some((gate) => gate.state === "fail")
    || acceptance.some((entry) => entry.state === "fail");
  return {
    schemaVersion: PRODUCT_READINESS_SCHEMA_VERSION,
    generatedAt: normalizedInstant(generatedAt),
    releaseVersion: String(releaseVersion || ""),
    state: accepted ? "accepted" : failed ? "blocked" : allGatesPass ? "ready_for_acceptance" : "in_review",
    basisSha256,
    gates,
    acceptance,
    counts: {
      passed: gates.filter((gate) => gate.state === "pass").length,
      failed: gates.filter((gate) => gate.state === "fail").length,
      pending: gates.filter((gate) => gate.state === "pending").length,
      total: gates.length,
    },
    disclaimer: "Diese Pilot- und Abnahmedokumentation ist keine pauschale Rechts-, Sicherheits- oder Barrierefreiheitsgarantie.",
    standards: PRODUCT_READINESS_STANDARD,
  };
}

module.exports = {
  ACCEPTANCE_DISCIPLINES,
  PRODUCT_READINESS_CHECKS,
  PRODUCT_READINESS_SCHEMA_VERSION,
  PRODUCT_READINESS_STANDARD,
  buildProductReadiness,
  canonicalJson,
  createAcceptance,
  createProductReadinessEvidence,
  verifyAcceptance,
  verifyProductReadinessEvidence,
};
