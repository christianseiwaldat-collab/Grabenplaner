(function initializePrivacyOrganization(root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.GrabenplanerPrivacyOrganization = api;
})(typeof globalThis === "object" ? globalThis : this, function createPrivacyOrganization(root) {
  "use strict";

  const ENDPOINT = "/api/privacy-organization";
  const TABS = Object.freeze([
    { id: "overview", label: "Überblick", kind: "organization" },
    { id: "data-map", label: "Datenlandkarte / VVT", kind: "activity" },
    { id: "dpia", label: "DSFA", kind: "dpia" },
    { id: "breaches", label: "Datenpannen", kind: "breach" },
    { id: "agreements", label: "Betriebsvereinbarungen", kind: "works_agreement" },
  ]);
  const TAB_PRESENTATION = Object.freeze({
    overview: { icon: "shield", description: "Zuständigkeiten, Prüfungen und offene Aufgaben an einem Ort." },
    "data-map": { icon: "layers", description: "Verarbeitungen, Datenkategorien und Datenflüsse nachvollziehbar erfassen." },
    dpia: { icon: "assessment", description: "Vorprüfung, Risiken und Maßnahmen mit der geprüften VVT-Fassung verbinden." },
    breaches: { icon: "alert", description: "Ab Kenntnis unverzüglich intern eskalieren. Externe Meldungen mit Nachweis dokumentieren." },
    agreements: { icon: "document", description: "Geltungsbereich, Beteiligung und Zustimmungen je Verfahren prüfen." },
  });
  const FIELD_SECTIONS = Object.freeze({
    organization: [
      ["Organisation", ["controllerName", "controllerRole", "controllerContact", "worksCouncil"]],
      ["Datenschutz und Zuständigkeiten", ["dpoName", "dpoContact", "dpoEmployeeNumber", "privacyOwnerEmployeeNumber"]],
      ["Erreichbarkeit und Prüfung", ["responseContact", "reviewOn", "notes"]],
    ],
    activity: [
      ["Verarbeitung und Verantwortung", ["title", "ownerEmployeeNumber", "purpose", "systemScope"]],
      ["Personen- und Datenkategorien", ["dataSubjects", "dataCategories", "specialCategories", "specialLegalBasis"]],
      ["Empfänger, Speicher und Übermittlungen", ["recipients", "processors", "storageLocations", "transfers", "transferDetails"]],
      ["Rechtsgrundlagen, Löschung und Schutz", ["legalBasis", "retention", "toms"]],
      ["Belege und nächste Prüfung", ["sourceRefs", "reviewOn"]],
    ],
    dpia: [
      ["Prüfung und VVT-Grundlage", ["title", "activityId", "activitySha256"]],
      ["Vorprüfung", ["screening", "screeningReasons", "screeningSourceRefs"]],
      ["Verarbeitung, Risiken und Maßnahmen", ["assessmentSummary", "necessity", "risks", "mitigations", "residualRisk"]],
      ["Beratung und Behördenkonsultation", ["dpoAdvice", "consultation", "consultationReference", "consultationOutcome", "reviewOn"]],
    ],
    breach: [
      ["Vorfall und Kenntniszeitpunkte", ["title", "ownerEmployeeNumber", "roleInIncident", "discoveredAt", "controllerAwareAt", "processorAwareAt"]],
      ["Einordnung und Umfang", ["breachConfirmed", "classificationReason", "breachTypes", "dataCategories", "affectedGroups", "approxPeople", "approxRecords"]],
      ["Folgen, Sofortmaßnahmen und Risiko", ["consequences", "containment", "remediation", "riskAssessment", "risk"]],
      ["Meldeentscheidungen und Anlaufstelle", ["authorityDecision", "authorityReason", "subjectDecision", "subjectReason", "subjectException", "contact", "lateReason"]],
      ["Nachverfolgung und Abschluss", ["followUpStatus", "followUpReason", "remediationComplete", "evidenceRefs"]],
    ],
    works_agreement: [
      ["Geltungsbereich und VVT-Grundlage", ["title", "activityId", "activitySha256", "scope", "worksCouncil"]],
      ["Arbeitsrecht und Datenschutz", ["assessment", "assessmentReason", "gdprBasis"]],
      ["Rechtsinstrument und Wirksamkeit", ["agreementStatus", "legalInstrument", "instrumentReference", "validFrom", "validTo", "signatoriesConfirmed"]],
      ["Zustimmungsabdeckung und Prüfung", ["consentCoverage", "consentEvidenceReference", "withdrawalProcess", "reviewOn"]],
    ],
  });
  const WIDE_FIELDS = new Set(["activitySha256", "notes", "screeningReasons", "classificationReason", "assessmentReason", "followUpReason", "withdrawalProcess"]);
  const SHARED_FIELD_HELP = "Nur Prozessmetadaten; keine Personenlisten, Diagnosen, Zugangsdaten oder Rohdaten.";
  function icon(name) {
    const paths = {
      shield: '<path d="M12 3 4.5 6v5.2c0 4.5 3.1 7.8 7.5 9.8 4.4-2 7.5-5.3 7.5-9.8V6L12 3Z"/><path d="m8.5 12 2.3 2.3 4.7-4.7"/>',
      layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',
      assessment: '<path d="M7 3h10v4H7zM7 5H5v16h14V5h-2M8 11h8M8 15h5"/>',
      alert: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5M12 17h.01"/>',
      document: '<path d="M14 3H5v18h14V8l-5-5Z"/><path d="M14 3v5h5M8 12h8M8 16h6"/>',
      refresh: '<path d="M20 11a8 8 0 0 0-14-5L3 9m0-6v6h6M4 13a8 8 0 0 0 14 5l3-3m0 6v-6h-6"/>',
      arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      check: '<path d="m5 12 4 4L19 6"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      close: '<path d="m6 6 12 12M18 6 6 18"/>',
    };
    return `<svg class="privacy-org-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name] || paths.document}</svg>`;
  }
  function fieldSections(kind, fields) {
    let remaining = [...fields];
    const groups = [];
    for (const [label, keys] of FIELD_SECTIONS[kind] || []) {
      const selected = remaining.filter(field => keys.includes(field.key));
      if (selected.length) groups.push({ label, fields: selected });
      remaining = remaining.filter(field => !keys.includes(field.key));
    }
    if (remaining.length) groups.push({ label: groups.length ? "Weitere Angaben" : "Angaben", fields: remaining });
    return groups;
  }
  function groupedFieldsMarkup(kind, fields, renderField, readOnly = false) {
    return fieldSections(kind, fields).map((group, index) => `<details class="privacy-org-field-section" ${index === 0 || readOnly ? "open" : ""}><summary><span class="privacy-org-section-number">${String(index + 1).padStart(2, "0")}</span><span><strong>${escape(group.label)}</strong><small>${group.fields.length} Angaben</small></span></summary><${readOnly ? "dl" : "div"} class="${readOnly ? "privacy-org-detail" : "privacy-org-fields"}">${group.fields.map(renderField).join("")}</${readOnly ? "dl" : "div"}></details>`).join("");
  }
  const STATUSES = Object.freeze({ draft: "Entwurf", submitted: "Zur Prüfung", approved: "Fachlich freigegeben", returned: "Zur Ergänzung", closed: "Abgeschlossen", archived: "Archiviert" });
  const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
  const RESERVED_KEYS = new Set(["constructor", "prototype", "__proto__"]);
  const clone = value => JSON.parse(JSON.stringify(value ?? {}));
  function escape(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  }
  function normalizeTab(value) { return TABS.some(tab => tab.id === value) ? value : "overview"; }
  function accessAllowed(user, permission = "privacy_organization:read") {
    const number = String(user?.employeeNumber ?? "").trim();
    return ["hr", "admin", "developer"].includes(user?.role)
      && !!number && number.toLowerCase() !== "local"
      && user?.isEmployee === true && user?.accountType === "employee" && user?.sessionKind === "employee"
      && user?.localSystem !== true && user?.sessionKind !== "local"
      && Array.isArray(user?.permissions) && user.permissions.includes(permission);
  }
  function safeSourceUrl(value) {
    try {
      const parsed = new URL(String(value));
      return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.href : "";
    } catch { return ""; }
  }
  function formatInstant(value) {
    if (!value || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(String(value))) return "Zeitpunkt noch ungeklärt";
    const timestamp = new Date(value);
    return Number.isFinite(timestamp.getTime())
      ? new Intl.DateTimeFormat("de-AT", { timeZone: "Europe/Vienna", dateStyle: "medium", timeStyle: "short" }).format(timestamp) + " · Wien"
      : "Zeitpunkt noch ungeklärt";
  }
  function fieldOptions(field) {
    return (Array.isArray(field?.options) ? field.options : []).map(option => typeof option === "string" ? { value: option, label: option } : option)
      .filter(option => option && typeof option.value === "string" && typeof option.label === "string");
  }
  function catalogFields(kind) {
    return (Array.isArray(kind?.fields) ? kind.fields : []).filter(field => field && FIELD_KEY.test(field.key) && !RESERVED_KEYS.has(field.key)
      && ["text", "textarea", "enum", "date", "instant", "boolean", "number", "list", "listrefs"].includes(field.type));
  }
  function readFormPayload(fields, getValue, original = {}) {
    const payload = clone(original);
    for (const field of catalogFields({ fields })) {
      const raw = getValue(field.key, field.type);
      if (field.type === "boolean") payload[field.key] = raw === true;
      else if (field.type === "number") {
        const value = String(raw ?? "").trim();
        if (value && (!Number.isFinite(Number(value)) || (field.integer !== false && !Number.isSafeInteger(Number(value))))) throw new Error(`${field.label}: Bitte eine gültige Zahl eingeben.`);
        payload[field.key] = value ? Number(value) : null;
      } else if (["list", "listrefs"].includes(field.type)) payload[field.key] = String(raw ?? "").split(/[\n,]+/).map(value => value.trim()).filter(Boolean);
      else {
        const value = String(raw ?? "").trim();
        if (field.type === "instant" && value && (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(new Date(value).getTime()))) throw new Error(`${field.label}: ISO-Zeitpunkt mit Z oder UTC-Offset angeben, z. B. 2026-10-03T14:30:00+02:00.`);
        payload[field.key] = field.type === "instant" ? value || null : field.type === "enum" && !value && fieldOptions(field).some(option => option.value === "unknown") ? "unknown" : value;
      }
    }
    return payload;
  }
  function renderReadiness(readiness = {}, { title = "Prüfstand", compact = false } = {}) {
    const issues = Array.isArray(readiness.issues) ? readiness.issues : [];
    const warnings = Array.isArray(readiness.warnings) ? readiness.warnings : [];
    const label = readiness.ready === true ? "Bereit für die fachliche Prüfung" : "Angaben / Prüfung offen";
    const lists = `${issues.length ? `<ul>${issues.map(issue => `<li>${escape(typeof issue === "string" ? issue : issue.message || issue.code || "Angabe offen")}</li>`).join("")}</ul>` : ""}${warnings.length ? `<ul class="privacy-org-warnings">${warnings.map(warning => `<li>${escape(typeof warning === "string" ? warning : warning.message || warning.code || "Prüfhinweis")}</li>`).join("")}</ul>` : ""}`;
    return `<div class="privacy-org-readiness ${readiness.ready === true ? "is-ready" : "is-open"} ${compact ? "is-compact" : ""}"><div class="privacy-org-readiness-heading">${icon(readiness.ready === true ? "check" : "assessment")}<div><span>${escape(title)}</span><strong>${escape(label)}</strong></div></div>${lists && compact ? `<details class="privacy-org-readiness-details"><summary>${issues.length ? `${issues.length} offene ${issues.length === 1 ? "Angabe" : "Angaben"}` : ""}${issues.length && warnings.length ? " · " : ""}${warnings.length ? `${warnings.length} ${warnings.length === 1 ? "Prüfhinweis" : "Prüfhinweise"}` : ""}</summary>${lists}</details>` : lists}</div>`;
  }
  function renderDeadlines(record, { evaluatedAt = null } = {}) {
    if (record?.kind !== "breach") return "";
    const deadlines = record.deadlines || record.readiness?.deadlines || {};
    const state = deadlines.authorityState || "unknown";
    const labels = { unknown: "Meldebewertung / Frist noch ungeklärt", not_required: "Keine Behördenmeldung erforderlich · Entscheidung dokumentiert", pending: "Behördenmeldung offen", due: "Behördenmeldung fällig", overdue: "Behördenfrist überschritten", recorded: "Behördenmeldung als versendet dokumentiert", recorded_late: "Versand nach Frist dokumentiert", controller_responsibility: "Behördenmeldung liegt beim Verantwortlichen" };
    const processLabels = { unknown: "Noch ungeklärt", not_applicable: "Nicht anwendbar", not_required: "Begründet nicht erforderlich", pending_immediate: "Unverzüglich erforderlich · offen", pending_public_notice: "Öffentliche Information erforderlich · offen", recorded: "Versand dokumentiert", recorded_public_notice: "Öffentliche Information dokumentiert", documented_exemption: "Konkrete Ausnahme dokumentiert", controller_responsibility: "Liegt beim Verantwortlichen" };
    const remaining = ["pending", "due", "overdue"].includes(state) && typeof deadlines.hoursRemaining === "number" && Number.isFinite(deadlines.hoursRemaining) ? `${Math.abs(deadlines.hoursRemaining).toFixed(1)} Stunden ${deadlines.hoursRemaining < 0 ? "überschritten" : "verbleibend"}` : "";
    const authorityLabel = state === "not_required" && record.status !== "approved" && record.status !== "closed" ? "Vorgesehene Entscheidung: keine Behördenmeldung · Fachprüfung offen" : labels[state] || labels.unknown;
    return `<div class="privacy-org-deadline ${["overdue", "recorded_late"].includes(state) ? "is-urgent" : ""}"><strong>${escape(authorityLabel)}</strong>${deadlines.effectiveControllerAwareAt ? `<span>Fristauslösende Kenntnis: ${escape(formatInstant(deadlines.effectiveControllerAwareAt))}</span>` : ""}${deadlines.authorityDueAt ? `<span>72-Stunden-Ziel: ${escape(formatInstant(deadlines.authorityDueAt))}</span>` : ""}${remaining ? `<span>${escape(remaining)}</span>` : ""}${deadlines.processorState ? `<span>Auftragsverarbeitung: ${escape(processLabels[deadlines.processorState] || processLabels.unknown)}</span>` : ""}${deadlines.subjectsState ? `<span>Betroffeneninformation: ${escape(processLabels[deadlines.subjectsState] || processLabels.unknown)}</span>` : ""}${evaluatedAt ? `<small>Stand der Auswertung: ${escape(formatInstant(evaluatedAt))}</small>` : ""}</div>`;
  }
  function fieldDisplay(field, value) {
    if (field.type === "boolean") return value === true ? "Ja" : "Nein / nicht bestätigt";
    if (field.type === "instant") return formatInstant(value);
    if (field.type === "enum") return fieldOptions(field).find(option => option.value === value)?.label || String(value || "Noch offen");
    if (Array.isArray(value)) return value.length ? value.join(" · ") : "Noch offen";
    return value === null || value === undefined || value === "" ? "Noch offen" : String(value);
  }
  function fieldMarkup(field, payload = {}, { activities = [], suppressSharedHelp = false } = {}) {
    const value = payload[field.key];
    const attributes = `data-po-field="${escape(field.key)}" name="${escape(field.key)}"`;
    const multiline = ["textarea", "list", "listrefs"].includes(field.type);
    const wide = WIDE_FIELDS.has(field.key);
    if (field.key === "activitySha256") return `<div class="privacy-org-field wide"><input type="hidden" ${attributes} value="${escape(value || "")}"><details class="privacy-org-history"><summary>Beleg zur geprüften VVT-Fassung</summary><p>Die gewählte VVT-Fassung wird über ihre Inhaltsprüfsumme gebunden. Eine geänderte VVT-Fassung erfordert eine erneute Prüfung.</p><code data-po-linked-sha>${escape(value || "Noch keine VVT-Fassung gewählt")}</code></details></div>`;
    let input;
    if (field.key === "activityId") input = `<select ${attributes} data-po-linked-activity><option value="">Fachlich freigegebene VVT-Fassung wählen</option>${value && !activities.some(record => record.id === value) ? `<option value="${escape(value)}" selected>Vorherige Zuordnung · aktuelle Freigabe prüfen</option>` : ""}${activities.map(record => `<option value="${escape(record.id)}" ${record.id === value ? "selected" : ""}>${escape(record.title || record.payload?.title || record.id)} · Fassung ${escape(record.revision)}</option>`).join("")}</select>`;
    else if (field.type === "boolean") input = `<input type="checkbox" ${attributes} ${value === true ? "checked" : ""}>`;
    else if (field.type === "enum") input = `<select ${attributes}>${fieldOptions(field).some(option => option.value === "unknown") ? "" : '<option value="">Noch offen</option>'}${fieldOptions(field).map(option => `<option value="${escape(option.value)}" ${option.value === (value ?? field.default) ? "selected" : ""}>${escape(option.label)}</option>`).join("")}</select>`;
    else if (multiline) input = `<textarea ${attributes} rows="${field.type === "textarea" ? 3 : 2}" maxlength="${Number.isInteger(field.maxLength) ? field.maxLength : 4000}">${escape(Array.isArray(value) ? value.join("\n") : value || "")}</textarea>`;
    else input = `<input ${attributes} type="${field.type === "date" ? "date" : field.type === "number" ? "number" : "text"}" value="${escape(value ?? "")}" ${field.type === "number" ? `step="${field.integer === false ? "any" : "1"}" min="0" max="1000000000"` : `maxlength="${Number.isInteger(field.maxLength) ? field.maxLength : field.type === "instant" ? 40 : 240}"`} ${field.type === "instant" ? 'placeholder="2026-10-03T14:30:00+02:00" autocomplete="off"' : ""} ${field.key === "activitySha256" ? "readonly" : ""}>`;
    return `<label class="privacy-org-field ${wide ? "wide" : ""} ${field.type === "boolean" ? "checkbox-field" : ""}"><span>${escape(field.label || field.key)}${field.requiredOnReview ? ' <small class="privacy-org-required">bei Prüfung erforderlich</small>' : ""}</span>${input}${field.help && !(suppressSharedHelp && field.help === SHARED_FIELD_HELP) ? `<small>${escape(field.help)}</small>` : ""}${field.type === "instant" ? "<small>ISO-Zeitpunkt mit Z oder UTC-Offset. Die Anzeige erfolgt für Wien.</small>" : ""}${["list", "listrefs"].includes(field.type) ? "<small>Eine Angabe je Zeile. Nur sachliche Referenzen, keine betroffenen Personen oder Rohdaten.</small>" : ""}</label>`;
  }
  function recordActions(record, capabilities = {}) {
    const active = !["closed", "archived"].includes(record?.status);
    const actions = [{ id: "read", label: "Ansehen" }];
    if (capabilities.manage && active) actions.push({ id: "edit", label: "Neue Arbeitsfassung" });
    if (capabilities.manage && ["draft", "returned"].includes(record?.status)) actions.push({ id: "submit", label: "Zur Prüfung einreichen" });
    if (capabilities.approve && record?.status === "submitted" && !capabilities.currentActorIsAuthor) actions.push({ id: "approve", label: "Fachlich freigeben" });
    if (capabilities.manage && record?.status === "submitted") actions.push({ id: "return", label: "Ergänzung anfordern" });
    if (capabilities.manage && record?.kind === "breach" && active) actions.push({ id: "record_notification", label: "Versand dokumentieren" });
    if (capabilities.manage && record?.kind === "breach" && record.status === "approved") actions.push({ id: "close", label: "Fall abschließen" });
    if (capabilities.manage && record?.status !== "archived" && record?.kind !== "organization" && (record?.kind !== "breach" || record.status === "closed" || record.payload?.breachConfirmed === "no")) actions.push({ id: "archive", label: "Archivieren" });
    return actions;
  }
  function renderSources(sources = []) {
    if (!Array.isArray(sources) || !sources.length) return "";
    return `<details class="privacy-org-sources"><summary>Versionierte Rechts- und Prozessquellen (${sources.length})</summary><ul>${sources.map(source => {
      const url = safeSourceUrl(source.url);
      return `<li>${url ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(source.title || source.id)}</a>` : `<strong>${escape(source.title || source.id)}</strong>`}${source.version || source.retrievedOn ? `<small>${escape([source.version, source.retrievedOn ? "Abruf " + source.retrievedOn : ""].filter(Boolean).join(" · "))}</small>` : ""}${source.summary ? `<p>${escape(source.summary)}</p>` : ""}</li>`;
    }).join("")}</ul></details>`;
  }

  function mount(host, options = {}) {
    if (!host || typeof options.api !== "function") return null;
    let disposed = false, active = false, generation = 0, controller = null, loading = null, payload = null;
    let tab = "overview", editor = null, dirty = false, busy = false, decision = null, decisionDirty = false, editorOrigin = null;
    const currentUser = () => typeof options.user === "function" ? options.user() : options.user;
    const key = () => typeof options.accessKey === "function" ? String(options.accessKey()) : String(options.accessKey || JSON.stringify([currentUser()?.employeeNumber, currentUser()?.role, currentUser()?.permissions]));
    const actorKey = key();
    const current = () => !disposed && key() === actorKey && accessAllowed(currentUser());
    const el = selector => host.querySelector(selector);
    const status = message => { const node = el("[data-po-notice]"); if (node) node.textContent = message; };
    const kindCatalog = kind => payload?.catalog?.kinds?.find(item => item.id === kind) || { id: kind, label: kind, fields: [] };
    const capabilities = () => ({
      read: current() && payload?.capabilities?.read === true,
      manage: current() && accessAllowed(currentUser(), "privacy_organization:manage") && payload?.capabilities?.manage === true,
      approve: current() && accessAllowed(currentUser(), "privacy_organization:approve") && payload?.capabilities?.approve === true,
    });
    const recordCapabilities = record => ({ ...capabilities(), currentActorIsAuthor: [record?.lastAuthor, record?.submittedBy].includes(currentUser()?.employeeNumber) });
    function markup() {
      host.innerHTML = `<div class="privacy-org-workspace"><div class="privacy-org-toolbar"><nav class="privacy-org-tabs" aria-label="Datenschutzbereiche">${TABS.map(item => `<button type="button" data-po-tab="${item.id}" aria-pressed="${item.id === tab}">${icon(TAB_PRESENTATION[item.id].icon)}<span>${item.label}</span></button>`).join("")}</nav><button type="button" class="secondary-button privacy-org-refresh" data-po-action="refresh">${icon("refresh")}<span>Aktualisieren</span></button></div><p class="privacy-org-notice" data-po-notice role="status" aria-live="polite"></p><section data-po-panel aria-live="polite"></section><dialog data-po-editor class="privacy-org-editor" aria-label="Datenschutz: Angaben und Arbeitsfassung" hidden></dialog><dialog class="privacy-org-dialog" data-po-decision aria-label="Datenschutz: fachlicher Vorgang"></dialog></div>`;
    }
    function cancelRead() { generation++; controller?.abort(); controller = null; loading = null; }
    function clearSensitive() {
      cancelRead(); payload = null; editor = null; decision = null; dirty = false; decisionDirty = false; editorOrigin = null;
      el("[data-po-editor]")?.close?.();
      el("[data-po-decision]")?.close?.(); host.replaceChildren();
    }
    function selectTab() {
      host.querySelectorAll("[data-po-tab]").forEach(button => {
        const selected = button.dataset.poTab === tab;
        button.classList.toggle("active", selected); button.setAttribute("aria-pressed", String(selected));
      });
    }
    function guideMarkup() {
      const guides = payload?.guides || payload?.catalog?.guides;
      const guideId = ({ "data-map": "vvt", breaches: "breach", agreements: "works-agreement" })[tab] || tab;
      const guide = Array.isArray(guides) ? guides.find(item => item.tab === tab || item.kind === TABS.find(item => item.id === tab).kind || item.id === guideId) : guides?.[tab];
      if (!guide) return "";
      const steps = Array.isArray(guide.steps) ? guide.steps : [];
      return `<details class="privacy-org-guide"><summary>${escape(guide.title || "Prozedere und nächste Schritte")}</summary>${guide.summary ? `<p>${escape(guide.summary)}</p>` : ""}${steps.length ? `<ol>${steps.map(step => `<li>${escape(typeof step === "string" ? step : step.title || step.text || step.label || "")} ${typeof step === "object" && step.description ? `<p>${escape(step.description)}</p>` : ""}</li>`).join("")}</ol>` : ""}</details>`;
    }
    function recordCard(record) {
      const definition = kindCatalog(record.kind), value = record.payload || {};
      const name = record.title || value.title || definition.label;
      const review = record.readiness || {};
      const approvedCurrent = record.status === "approved" && review.releaseReady === true;
      const statusLabel = record.status === "approved" && !approvedCurrent ? "Freigabe erneut prüfen" : STATUSES[record.status] || "Ungeklärt";
      const metadataKeys = ({ organization: ["controllerName", "dpoName", "worksCouncil"], activity: ["ownerEmployeeNumber", "reviewOn"], dpia: ["screening", "residualRisk", "reviewOn"], breach: ["roleInIncident", "risk"], works_agreement: ["worksCouncil", "legalInstrument", "reviewOn"] })[record.kind] || [];
      const facts = metadataKeys.map(key => catalogFields(definition).find(field => field.key === key)).filter(Boolean);
      const summary = value.purpose || value.scope || "";
      const actions = recordActions(record, recordCapabilities(record));
      return `<article class="privacy-org-record" data-po-record-status="${escape(record.status || "unknown")}"><header><div class="privacy-org-record-title"><h3>${escape(name)}</h3><small>Fassung ${escape(record.revision ?? "")}<span aria-hidden="true"> · </span>${escape(record.updatedAt ? formatInstant(record.updatedAt) : "Noch nicht bearbeitet")}</small></div><span class="privacy-org-status ${approvedCurrent ? "is-approved" : record.status === "submitted" ? "is-submitted" : ["closed", "archived"].includes(record.status) ? "is-neutral" : "is-open"}">${escape(statusLabel)}</span></header>${summary ? `<p class="privacy-org-record-description">${escape(summary)}</p>` : ""}${facts.length ? `<dl class="privacy-org-record-facts">${facts.map(field => `<div><dt>${escape(field.label)}</dt><dd>${escape(fieldDisplay(field, value[field.key]))}</dd></div>`).join("")}</dl>` : ""}${renderDeadlines(record, { evaluatedAt: payload?.evaluatedAt })}${renderReadiness(review, { compact: true })}<footer>${actions.map(action => `<button type="button" class="privacy-org-action ${action.id === "read" ? "is-read" : ["approve", "submit"].includes(action.id) ? "is-primary" : action.id === "archive" ? "is-muted" : ""}" data-po-action="${action.id}" data-po-id="${escape(record.id)}">${escape(action.label)}</button>`).join("")}</footer>${record.kind === "works_agreement" ? '<p class="privacy-org-small">Die fachliche GP-Freigabe ersetzt weder eine erforderliche Betriebsratszustimmung oder Unterzeichnung noch individuelle Zustimmungen ohne Betriebsrat gemäß AVRAG § 10.</p>' : ""}</article>`;
    }
    function emptyState(kind) {
      const tabDefinition = TABS.find(item => item.kind === kind), presentation = TAB_PRESENTATION[tabDefinition?.id || "overview"];
      return `<div class="privacy-org-empty"><span class="privacy-org-empty-icon">${icon(presentation.icon)}</span><h3>Noch keine Einträge erfasst</h3><p>${capabilities().manage ? "Erfasse den ersten Eintrag oder nutze eine passende Arbeitsvorlage. Neue Einträge beginnen als Entwurf." : "Erfasste Verarbeitungstätigkeiten und Prüfungen erscheinen hier nach ihrer Anlage."}</p></div>`;
    }
    function renderOverview() {
      const records = payload?.records || [];
      const organization = records.find(record => record.kind === "organization");
      const totals = TABS.filter(item => item.id !== "overview").map(item => ({ ...item, count: records.filter(record => record.kind === item.kind && record.status !== "archived").length, open: records.filter(record => record.kind === item.kind && !["closed", "archived"].includes(record.status) && !(record.status === "approved" && record.readiness?.releaseReady === true)).length }));
      const legacyLinks = typeof options.onLegacyNavigate === "function" ? `${payload.legacyAccess?.dataRequests === true ? `<button type="button" class="secondary-button" data-po-legacy="requests">Datenanfragen ${icon("arrow")}</button>` : ""}${payload.legacyAccess?.retention === true ? `<button type="button" class="secondary-button" data-po-legacy="retention">Aufbewahrung und Schutzsperren ${icon("arrow")}</button>` : ""}` : "";
      return `<div class="privacy-org-overview"><div class="privacy-org-section-heading"><div><span class="privacy-org-kicker">Überblick</span><h2>Datenschutzorganisation</h2><p>${escape(TAB_PRESENTATION.overview.description)}</p></div><span class="privacy-org-register-meta">Registerstand ${escape(payload.revision ?? "")}</span></div><div class="privacy-org-summary">${totals.map(item => `<button type="button" class="privacy-org-summary-card" data-po-tab="${item.id}"><span class="privacy-org-summary-head">${icon(TAB_PRESENTATION[item.id].icon)}<strong>${item.count}</strong></span><span class="privacy-org-summary-label">${item.label}</span><span class="privacy-org-summary-foot"><small>${item.open} offene ${item.open === 1 ? "Prüfung" : "Prüfungen"}</small>${icon("arrow")}</span></button>`).join("")}</div><div class="privacy-org-overview-grid"><section class="privacy-org-organization"><div class="privacy-org-block-heading"><h3>Organisation und Zuständigkeiten</h3><p>Verantwortliche, Kontaktwege und betriebliche Rahmenbedingungen.</p></div>${organization ? recordCard(organization) : emptyState("organization")}</section><aside class="privacy-org-overview-aside" aria-label="Betrieblicher Prüfstand"><div class="privacy-org-support-card"><h3>Betrieblicher Prüfstand</h3><p>Offene Angaben und erforderliche Nachweise bleiben sichtbar.</p>${renderReadiness(payload.readiness || organization?.readiness || {}, { title: "Organisationsstand", compact: true })}</div>${legacyLinks ? `<div class="privacy-org-support-card"><h3>Weitere Datenschutzprozesse</h3><div class="privacy-org-legacy">${legacyLinks}</div></div>` : ""}</aside></div>${renderSources(payload.catalog?.sources || payload.sources)}</div>`;
    }
    function render() {
      if (!current()) return clearSensitive();
      selectTab();
      const panel = el("[data-po-panel]"); if (!panel) return;
      if (!payload || !capabilities().read) { panel.innerHTML = '<p>Für diesen Bereich ist eine persönliche Datenschutzberechtigung erforderlich.</p>'; return; }
      if (tab === "overview") panel.innerHTML = renderOverview();
      else {
        const selected = TABS.find(item => item.id === tab), definition = kindCatalog(selected.kind), presentation = TAB_PRESENTATION[tab];
        const records = (payload.records || []).filter(record => record.kind === selected.kind);
        const templates = selected.kind === "activity" ? payload.catalog?.activityTemplates || [] : [];
        const guide = guideMarkup();
        const templateMarkup = capabilities().manage && templates.length ? `<details class="privacy-org-templates"><summary>VVT-Arbeitsvorlagen <span>${templates.length}</span></summary><p>Vorlagen enthalten sachliche Kategorien. Verantwortliche, Rechtsgrundlage und Fristen sind betrieblich zu prüfen.</p><div class="privacy-org-template-list">${templates.map(template => `<button type="button" class="privacy-org-template" data-po-template="${escape(template.id)}">${icon("plus")}<span>${escape(template.title || template.id)}</span></button>`).join("")}</div></details>` : "";
        panel.innerHTML = `<div class="privacy-org-section-heading"><div><span class="privacy-org-kicker">${selected.kind === "activity" ? "Verarbeitungsverzeichnis" : selected.kind === "dpia" ? "Risiko und Maßnahmen" : selected.kind === "breach" ? "Vorfallmanagement" : "Betriebliche Zustimmungen"}</span><h2>${escape(selected.label)}</h2><p>${escape(presentation.description)}</p></div>${capabilities().manage ? `<button type="button" class="primary-button" data-po-action="new" data-po-kind="${selected.kind}">${icon("plus")}${escape(definition.newLabel || "Eintrag erfassen")}</button>` : ""}</div><div class="privacy-org-register-layout ${guide || templateMarkup ? "has-support" : ""}"><section class="privacy-org-register" aria-label="${escape(selected.label)}: Einträge"><div class="privacy-org-list-heading"><h3>Erfasste ${selected.kind === "breach" ? "Vorfälle" : selected.kind === "activity" ? "Verarbeitungen" : "Verfahren"}</h3><span>${records.length} ${records.length === 1 ? "Eintrag" : "Einträge"}</span></div><div class="privacy-org-record-list">${records.map(recordCard).join("") || emptyState(selected.kind)}</div></section>${guide || templateMarkup ? `<aside class="privacy-org-register-support" aria-label="Arbeitshilfen">${templateMarkup}${guide}</aside>` : ""}</div>`;
      }
      if (editor && String(editor.expectedRevision) !== String(payload.revision)) status("Der Registerstand hat sich geändert. Deine Arbeitsfassung bleibt erhalten; vor dem Speichern den aktuellen Stand prüfen.");
    }
    async function load() {
      if (!current()) { clearSensitive(); return false; }
      if (loading) return loading;
      if (!el("[data-po-panel]")) markup();
      const ticket = generation, requestKey = key();
      controller = typeof AbortController === "function" ? new AbortController() : null;
      status("Datenschutzorganisation wird geladen …");
      const operation = (async () => {
        try {
          const result = await options.api(ENDPOINT, controller ? { signal: controller.signal } : {});
          if (!current() || ticket !== generation || requestKey !== key()) return false;
          payload = result; render();
          if (!editor) status(capabilities().manage ? "Register geladen. Änderungen werden nachvollziehbar versioniert." : "Register geladen · Lesezugriff.");
          return true;
        } catch (error) {
          if (!current() || ticket !== generation || error?.name === "AbortError") return false;
          status(error?.message || "Das Register konnte nicht geladen werden."); return false;
        } finally { if (ticket === generation) { loading = null; controller = null; } }
      })();
      loading = operation;
      return operation;
    }
    function closeEditor({ force = false } = {}) {
      if (dirty && !force && (typeof root.confirm !== "function" || !root.confirm("Ungespeicherte Arbeitsfassung verwerfen?"))) return false;
      editor = null; dirty = false;
      const target = el("[data-po-editor]"); if (target) { target.close?.(); target.hidden = true; target.replaceChildren(); }
      if (current() && editorOrigin?.isConnected !== false) editorOrigin?.focus?.({ preventScroll: true });
      editorOrigin = null;
      return true;
    }
    function openEditor(record = null, template = null, kind = null, readOnly = false) {
      if (!current() || !payload || (!readOnly && !capabilities().manage)) return;
      const origin = host.ownerDocument?.activeElement;
      if (!closeEditor()) return;
      const recordKind = record?.kind || kind || "activity", definition = kindCatalog(recordKind), target = el("[data-po-editor]");
      const value = clone(record?.payload || template?.payload || {}), fields = catalogFields(definition);
      for (const field of fields) if (!Object.hasOwn(value, field.key)) value[field.key] = Object.hasOwn(field, "default") ? field.default : field.type === "boolean" ? false : ["number", "instant"].includes(field.type) ? null : ["list", "listrefs"].includes(field.type) ? [] : "";
      const activities = (payload.records || []).filter(item => item.kind === "activity" && item.status === "approved" && item.readiness?.releaseReady === true);
      if (!target || !fields.length) { status("Die Felddefinition für diesen Bereich ist derzeit nicht verfügbar."); return; }
      editor = { record, kind: recordKind, payload: value, expectedRevision: payload.revision, fields, readOnly };
      editorOrigin = origin;
      target.hidden = false;
      const heading = `<header class="privacy-org-editor-heading"><div><span class="privacy-org-kicker">${escape(definition.label)}${record ? ` · Fassung ${escape(record.revision)}` : ""}</span><h2>${readOnly ? "Fassung ansehen" : record ? "Neue Arbeitsfassung" : "Eintrag erfassen"}</h2>${value.title || record?.title ? `<p class="privacy-org-editor-title">${escape(value.title || record.title)}</p>` : ""}</div><button type="button" class="privacy-org-close" data-po-close-editor aria-label="Arbeitsfassung schließen">${icon("close")}</button></header>`;
      const footer = `<footer class="privacy-org-editor-actions"><span>${readOnly ? "Gespeicherte Fassung und Prüfhistorie" : "Speichern legt eine Arbeitsfassung an."}</span><div><button type="button" class="secondary-button" data-po-close-editor>${readOnly ? "Schließen" : "Abbrechen"}</button>${readOnly ? "" : '<button type="submit" class="primary-button">Arbeitsfassung speichern</button>'}</div></footer>`;
      const sections = groupedFieldsMarkup(recordKind, fields, field => readOnly ? `<div class="${WIDE_FIELDS.has(field.key) ? "wide" : ""}"><dt>${escape(field.label || field.key)}</dt><dd>${escape(fieldDisplay(field, value[field.key]))}</dd></div>` : fieldMarkup(field, value, { activities, suppressSharedHelp: true }), readOnly);
      const content = `<div class="privacy-org-editor-body" tabindex="0" aria-label="Angaben und Prüfhinweise">${record ? renderReadiness(record.readiness, { compact: true }) : ""}${readOnly ? "" : `<p class="privacy-org-data-hint">${icon("shield")}<span>${escape(SHARED_FIELD_HELP)} Als Entwurf kannst du unvollständige Angaben speichern.</span></p>`}${sections}${readOnly ? renderHistory(record) : '<p data-po-form-status role="status" aria-live="polite" tabindex="-1"></p>'}</div>`;
      target.innerHTML = readOnly ? `<div class="privacy-org-dialog-shell">${heading}${content}${footer}</div>` : `<form data-po-edit-form class="privacy-org-dialog-shell" autocomplete="off">${heading}${content}${footer}</form>`;
      target.showModal?.();
      (target.querySelector("input, select, textarea") || target.querySelector("[data-po-close-editor]"))?.focus?.({ preventScroll: true });
    }
    function revealProblemFields(form, details = [], message = "") {
      const issues = Array.isArray(details) ? details : [];
      const keys = issues.map(item => item?.field || item?.key).filter(key => typeof key === "string" && FIELD_KEY.test(key));
      const matched = editor?.fields.find(field => message.startsWith(`${field.label}:`));
      if (matched) keys.push(matched.key);
      let first;
      for (const key of keys) {
        const input = form?.elements.namedItem(key), section = input?.closest?.(".privacy-org-field-section");
        if (section) section.open = true;
        if (input && input.type !== "hidden" && !first) first = input;
      }
      if (first) first.focus?.();
      else {
        form?.querySelectorAll(".privacy-org-field-section").forEach(section => { section.open = true; });
        const notice = form?.querySelector("[data-po-form-status]");
        notice?.setAttribute("tabindex", "-1"); notice?.focus?.();
      }
    }
    function renderHistory(record) {
      const history = Array.isArray(record?.history) ? record.history : [];
      const notifications = Array.isArray(record?.notifications) ? record.notifications : [];
      return `${notifications.length ? `<details class="privacy-org-history"><summary>Dokumentierte Meldungen (${notifications.length})</summary><ul>${notifications.map(item => `<li>${escape(({ authority: "Behörde", subjects: "Betroffene", controller: "Verantwortlicher" })[item.channel] || item.channel)} · ${escape(formatInstant(item.sentAt))} · Nachweis: ${escape(item.evidenceReference || "offen")}</li>`).join("")}</ul></details>` : ""}${history.length ? `<details class="privacy-org-history"><summary>Prüfhistorie (${history.length})</summary><ol>${history.map(item => `<li>${escape(STATUSES[item.status] || item.action || "Fassung")} · ${escape(formatInstant(item.at || item.updatedAt || item.timestamp))}${item.reason || item.decision?.reason ? `<p>${escape(item.reason || item.decision.reason)}</p>` : ""}</li>`).join("")}</ol></details>` : ""}`;
    }
    async function command(body, { form = null, closeAfter = false } = {}) {
      if (!current() || busy) return false;
      busy = true;
      const ticket = generation, requestKey = key();
      const buttons = [...host.querySelectorAll("button[type='submit']")]; buttons.forEach(button => { button.disabled = true; });
      const message = text => { const node = form?.querySelector("[data-po-form-status]"); if (node) node.textContent = text; else status(text); };
      message("Vorgang wird gespeichert …");
      try {
        const result = await options.api(ENDPOINT + "/commands", { method: "POST", body: JSON.stringify(body) });
        if (!current() || ticket !== generation || requestKey !== key()) return false;
        if (closeAfter) closeEditor({ force: true });
        el("[data-po-decision]")?.close?.(); decision = null; decisionDirty = false;
        if (result && Array.isArray(result.records)) { payload = result; render(); }
        else await load();
        status("Vorgang dokumentiert. Fachliche und externe Voraussetzungen bleiben im Prüfstand sichtbar.");
        if (current()) host.focus?.({ preventScroll: true });
        return true;
      } catch (error) {
        if (!current() || ticket !== generation) return false;
        const stale = error?.code === "STALE_REVISION" || error?.code === "REVISION_CONFLICT" || /revision|stale|zwischenzeitlich|registerstand.*geändert/i.test(String(error?.message));
        const issues = Array.isArray(error?.details) ? error.details.map(item => typeof item === "string" ? item : item?.message || "").filter(Boolean).join(" ") : "";
        message(stale ? "Der Registerstand hat sich geändert. Deine Eingaben bleiben erhalten. Register aktualisieren und die Arbeitsfassung mit dem neuen Stand abgleichen; anschließend bewusst neu öffnen." : [error?.message || "Der Vorgang konnte nicht gespeichert werden.", issues].filter(Boolean).join(" "));
        if (!stale) revealProblemFields(form, error?.details, String(error?.message || ""));
        return false;
      } finally { busy = false; if (current()) buttons.forEach(button => { if (button.isConnected !== false) button.disabled = false; }); }
    }
    function openDecision(record, action) {
      if (!current() || !recordActions(record, recordCapabilities(record)).some(item => item.id === action)) return;
      const target = el("[data-po-decision]"); if (!target) return;
      if (decisionDirty && (typeof root.confirm !== "function" || !root.confirm("Ungespeicherte Fachentscheidung verwerfen?"))) return;
      const name = recordActions(record, recordCapabilities(record)).find(item => item.id === action)?.label || "Vorgang dokumentieren";
      decision = { record, action, expectedRevision: payload.revision }; decisionDirty = false;
      target.innerHTML = `<form data-po-decision-form autocomplete="off"><header><h2>${escape(name)}</h2><button type="button" class="close-button" data-po-close-decision aria-label="Vorgang schließen">×</button></header><p>${escape(record.title || record.payload?.title || kindCatalog(record.kind).label)}</p>${action === "record_notification" ? '<p>Hier wird ein bereits erfolgter externer Versand dokumentiert. Der GP sendet keine Meldung.</p><div class="privacy-org-fields"><label class="privacy-org-field"><span>Empfängergruppe</span><select name="channel" required><option value="authority">Aufsichtsbehörde</option><option value="subjects">Betroffene</option><option value="controller">Verantwortlicher</option></select></label><label class="privacy-org-field"><span>Meldephase</span><select name="phase"><option value="initial">Erstmeldung</option><option value="follow_up">Nachmeldung</option><option value="public_notice">Öffentliche Mitteilung</option></select></label><label class="privacy-org-field wide"><span>Versandt am · mit UTC-Offset</span><input name="sentAt" type="text" placeholder="2026-10-03T14:30:00+02:00" required></label><label class="privacy-org-field wide"><span>Nachweisreferenz</span><input name="evidenceReference" maxlength="300" required></label><label class="privacy-org-field wide"><span>Sachlicher Vermerk (optional)</span><textarea name="details" rows="2" maxlength="2000"></textarea></label><label class="privacy-org-field wide"><span>Verzögerungsbegründung bei verspäteter Erstmeldung</span><textarea name="lateReason" rows="2" maxlength="4000"></textarea></label></div>' : '<label class="privacy-org-field"><span>Fachliche Begründung</span><textarea name="reason" rows="3" maxlength="3000" required></textarea></label><label class="privacy-org-field"><span>Nachweisreferenz (optional)</span><input name="evidenceReference" maxlength="300"></label>'}${action === "approve" && record.kind === "works_agreement" ? '<p>Diese Freigabe dokumentiert eine unabhängige fachliche Prüfung im GP. Erforderliche Betriebsratszustimmungen, Unterschriften oder individuelle Zustimmungen ohne Betriebsrat gemäß AVRAG § 10 sind gesondert nachzuweisen.</p>' : ""}<p data-po-form-status role="status" aria-live="polite"></p><footer><button type="button" class="secondary-button" data-po-close-decision>Abbrechen</button><button type="submit" class="primary-button">${escape(name)}</button></footer></form>`;
      target.showModal?.(); target.querySelector("input,textarea,select")?.focus?.();
    }
    async function click(event) {
      if (!current()) return clearSensitive();
      if (event.target.closest("[data-po-close-editor]")) return closeEditor();
      if (event.target.closest("[data-po-close-decision]")) {
        if (decisionDirty && (typeof root.confirm !== "function" || !root.confirm("Ungespeicherte Fachentscheidung verwerfen?"))) return;
        el("[data-po-decision]")?.close?.(); decision = null; decisionDirty = false; return;
      }
      const tabButton = event.target.closest("[data-po-tab]");
      if (tabButton) { await activate(tabButton.dataset.poTab); return; }
      const legacy = event.target.closest("[data-po-legacy]");
      if (legacy) { if ((legacy.dataset.poLegacy === "requests" && payload?.legacyAccess?.dataRequests === true) || (legacy.dataset.poLegacy === "retention" && payload?.legacyAccess?.retention === true)) options.onLegacyNavigate?.(legacy.dataset.poLegacy); return; }
      const templateButton = event.target.closest("[data-po-template]");
      if (templateButton) { const template = payload?.catalog?.activityTemplates?.find(item => item.id === templateButton.dataset.poTemplate); if (template) openEditor(null, template, "activity"); return; }
      const button = event.target.closest("[data-po-action]"); if (!button || busy) return;
      const action = button.dataset.poAction;
      if (action === "refresh") return load();
      if (action === "new") return openEditor(null, null, button.dataset.poKind);
      const record = payload?.records?.find(item => item.id === button.dataset.poId); if (!record) return;
      if (action === "read") return openEditor(record, null, null, true);
      if (action === "edit") return openEditor(record);
      if (action === "submit") {
        if (!capabilities().manage) return;
        return command({ expectedRevision: payload.revision, action, id: record.id });
      }
      if (["approve", "return", "close", "archive", "record_notification"].includes(action)) return openDecision(record, action);
    }
    async function submit(event) {
      const form = event.target;
      if (!form.matches?.("[data-po-edit-form],[data-po-decision-form]")) return;
      event.preventDefault();
      if (!current() || busy) return;
      try {
        if (form.matches("[data-po-edit-form]")) {
          if (!editor || editor.readOnly || !capabilities().manage) return;
          const value = readFormPayload(editor.fields, (name, type) => { const field = form.elements.namedItem(name); return type === "boolean" ? field?.checked : field?.value; }, editor.payload);
          return await command({ expectedRevision: editor.expectedRevision, action: editor.record ? "update" : "create", ...(editor.record ? { id: editor.record.id } : { kind: editor.kind }), payload: value }, { form, closeAfter: true });
        }
        if (!decision || !recordActions(decision.record, recordCapabilities(decision.record)).some(item => item.id === decision.action)) return;
        const value = name => String(form.elements.namedItem(name)?.value || "").trim();
        const detail = decision.action === "record_notification" ? { channel: value("channel"), phase: value("phase"), sentAt: value("sentAt"), evidenceReference: value("evidenceReference"), details: value("details"), ...(value("lateReason") ? { lateReason: value("lateReason") } : {}) } : { reason: value("reason"), ...(value("evidenceReference") ? { evidenceReference: value("evidenceReference") } : {}) };
        if (decision.action === "record_notification" && (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(detail.sentAt) || !Number.isFinite(new Date(detail.sentAt).getTime()))) throw new Error("Versandzeitpunkt mit Z oder UTC-Offset angeben.");
        return await command({ expectedRevision: decision.expectedRevision, action: decision.action, id: decision.record.id, decision: detail }, { form });
      } catch (error) { const message = form.querySelector("[data-po-form-status]"); if (message) message.textContent = error.message; revealProblemFields(form, error?.details, String(error?.message || "")); }
    }
    function changed(event) {
      if (editor && !editor.readOnly && event.target.closest?.("[data-po-edit-form]")) dirty = true;
      if (decision && event.target.closest?.("[data-po-decision-form]")) decisionDirty = true;
      if (editor && event.target.matches?.("[data-po-linked-activity]")) {
        const activity = payload?.records?.find(record => record.kind === "activity" && record.status === "approved" && record.readiness?.releaseReady === true && record.id === event.target.value);
        const field = el("[data-po-edit-form]")?.elements.namedItem("activitySha256"); if (field) field.value = activity?.contentSha256 || "";
        const receipt = el("[data-po-linked-sha]"); if (receipt) receipt.textContent = activity?.contentSha256 || "Noch keine VVT-Fassung gewählt";
      }
    }
    async function activate(value = tab, { notify = true } = {}) {
      if (!current()) { clearSensitive(); return false; }
      active = true; tab = normalizeTab(value);
      if (!el("[data-po-panel]")) markup();
      if (payload) render();
      await load();
      if (!current()) return false;
      if (editor && !el("[data-po-editor]")?.open) el("[data-po-editor]")?.showModal?.();
      if (decision && decisionDirty && !el("[data-po-decision]")?.open) el("[data-po-decision]")?.showModal?.();
      if (notify) options.onTabChange?.(tab);
      return true;
    }
    const beforeUnload = event => { if ((dirty || decisionDirty) && current()) { event.preventDefault(); event.returnValue = ""; } };
    const cancelDecision = event => {
      if (event.target.matches?.("[data-po-editor]")) { event.preventDefault(); closeEditor(); return; }
      if (!event.target.matches?.("[data-po-decision]")) return;
      if (decisionDirty && (typeof root.confirm !== "function" || !root.confirm("Ungespeicherte Fachentscheidung verwerfen?"))) { event.preventDefault(); return; }
      decision = null; decisionDirty = false;
    };
    host.addEventListener("click", click); host.addEventListener("submit", submit); host.addEventListener("input", changed); host.addEventListener("change", changed);
    host.addEventListener("cancel", cancelDecision, true);
    root.addEventListener?.("beforeunload", beforeUnload);
    return {
      activate, load, normalizeTab, getTab: () => tab, hasUnsavedChanges: () => dirty || decisionDirty,
      suspend() { active = false; cancelRead(); el("[data-po-editor]")?.close?.(); el("[data-po-decision]")?.close?.(); },
      destroy() {
        disposed = true; active = false; clearSensitive();
        host.removeEventListener("click", click); host.removeEventListener("submit", submit); host.removeEventListener("input", changed); host.removeEventListener("change", changed);
        host.removeEventListener("cancel", cancelDecision, true);
        root.removeEventListener?.("beforeunload", beforeUnload);
      },
    };
  }
  return Object.freeze({ TABS, STATUSES, normalizeTab, accessAllowed, escape, safeSourceUrl, fieldSections, formatInstant, catalogFields, fieldOptions, readFormPayload, fieldMarkup, fieldDisplay, recordActions, renderReadiness, renderDeadlines, renderSources, mount });
});
