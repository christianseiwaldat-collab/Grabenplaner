(function initializeSecurityAudits(root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.GrabenplanerSecurityAudits = api;
})(typeof globalThis === "object" ? globalThis : this, function createSecurityAudits(root) {
  "use strict";

  const ENDPOINT = "/api/security-audits";
  const MAX_IMPORT_BYTES = 900 * 1024;
  const CHECK_STATUSES = Object.freeze({ passed: "Bestanden", failed: "Nicht bestanden", partial: "Teilweise geprüft", not_tested: "Nicht geprüft", not_applicable: "Nicht anwendbar", blocked: "Blockiert", out_of_scope: "Außerhalb Zielprofil" });
  const FINDING_STATUSES = Object.freeze({ open: "Offen", in_progress: "In Bearbeitung", mitigated: "Eingedämmt", fixed: "Behoben / nachgeprüft", risk_accepted: "Risiko akzeptiert" });
  const DISPLAY_FINDING_STATUSES = Object.freeze({ ...FINDING_STATUSES, risk_acceptance_expired: "Risikoakzeptanz abgelaufen" });
  const findingStatusOf = finding => finding?.effectiveStatus || finding?.status;
  const METHODS = Object.freeze({ code_review: "Quellcodeprüfung", automated_test: "Automatisierter Test", manual_test: "Manueller Test", configuration_review: "Konfigurationsprüfung", none: "Keine Prüfung" });
  const CONFIDENCE = Object.freeze({ code_review: "Statisch belegt", reproduced: "Reproduziert", hypothesis: "Prüfhypothese" });
  const SEVERITIES = Object.freeze({ critical: "Kritisch", high: "Hoch", medium: "Mittel", low: "Niedrig", info: "Hinweis" });
  const escape = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const list = value => Array.isArray(value) ? value : [];
  function accessAllowed(user, permission = "security_audits:read") {
    const number = String(user?.employeeNumber || "").trim();
    return ["admin", "it_admin", "developer"].includes(user?.role)
      && !!number && number.toLowerCase() !== "local" && user?.isEmployee === true
      && user?.accountType === "employee" && user?.sessionKind === "employee"
      && user?.localSystem !== true && user?.mustChangePassword !== true
      && Array.isArray(user?.permissions) && user.permissions.includes("security_audits:read")
      && user.permissions.includes(permission);
  }
  function safeSourceUrl(value) {
    try { const url = new URL(String(value)); return url.protocol === "https:" && !url.username && !url.password ? url.href : ""; } catch { return ""; }
  }
  function formatInstant(value) {
    if (!value || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(String(value))) return "Zeitpunkt nicht belegt";
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("de-AT", { timeZone: "Europe/Vienna", dateStyle: "medium", timeStyle: "short" }).format(date) + " · Wien" : "Zeitpunkt nicht belegt";
  }
  function formatAuditDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return "Prüfdatum nicht belegt";
    const date = new Date(String(value) + "T12:00:00Z");
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return "Prüfdatum ungültig";
    return new Intl.DateTimeFormat("de-AT", { timeZone: "Europe/Vienna", dateStyle: "medium" }).format(date);
  }
  function canonicalChecks(run, catalog, targetLevel = 2) {
    const checks = new Map(list(run?.checks).map(check => [check.requirementId, check]));
    return list(catalog).map(requirement => {
      const check = checks.get(requirement.id), inScope = Number(requirement.level) <= targetLevel || !!check;
      return { ...requirement, requirementId: requirement.id, inScope, status: check?.status || (inScope ? "not_tested" : "out_of_scope"), method: check?.method || "none", note: check?.note || "", evidence: list(check?.evidence) };
    });
  }
  function parseImport(text, size) {
    const measured = typeof TextEncoder === "function" ? new TextEncoder().encode(String(text)).length : String(text).length * 3;
    if ((Number.isFinite(size) && size > MAX_IMPORT_BYTES) || measured > MAX_IMPORT_BYTES) throw new Error("Die JSON-Datei darf höchstens 900 KiB groß sein. Größere Berichte vor dem Import aufteilen oder kürzen.");
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error("Die Datei enthält kein gültiges JSON."); }
    const run = parsed?.run ?? parsed;
    if (!run || typeof run !== "object" || Array.isArray(run) || typeof run.id !== "string" || !run.id.trim() || typeof run.title !== "string" || !run.title.trim() || !Array.isArray(run.checks) || !Array.isArray(run.findings)) throw new Error("Erwartet wird ein Auditbericht mit id, title, checks und findings. Der Server prüft anschließend den vollständigen Inhalt.");
    return run;
  }
  function findingChanges(form) {
    const value = name => String(form.elements.namedItem(name)?.value || "").trim();
    const changes = { status: value("status"), owner: value("owner"), dueDate: value("dueDate"), note: value("note"), retestEvidence: value("retestEvidence") };
    if (!Object.hasOwn(FINDING_STATUSES, changes.status)) throw new Error("Bitte einen gültigen Maßnahmenstatus wählen.");
    if (!changes.note) throw new Error("Bitte die Änderung oder Risikoentscheidung in der Begründung dokumentieren.");
    if (changes.status === "fixed" && !changes.retestEvidence) throw new Error("Für „Behoben / nachgeprüft“ ist ein konkreter Nachprüfungsbeleg erforderlich.");
    if (changes.status === "risk_accepted") {
      const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Vienna", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
      const today = ["year", "month", "day"].map(type => date.find(part => part.type === type).value).join("-");
      if (!changes.owner || !/^\d{4}-\d{2}-\d{2}$/.test(changes.dueDate) || changes.dueDate <= today) throw new Error("Eine Risikoakzeptanz benötigt eine verantwortliche Person und ein zukünftiges Zieldatum. Die Befristung wird zusätzlich vom Server geprüft.");
    }
    return changes;
  }
  function evidenceMarkup(evidence) {
    return list(evidence).length ? `<ul class="security-audits-evidence">${evidence.map(item => `<li><strong>${escape(item.kind || "Beleg")}</strong><code>${escape(item.reference || "Keine Referenz")}</code>${item.summary ? `<p>${escape(item.summary)}</p>` : ""}</li>`).join("")}</ul>` : '<p class="security-audits-muted">Kein Beleg erfasst.</p>';
  }
  function findingMarkup(finding) {
    const fields = [["Beobachtung", finding.description], ["Auswirkung", finding.impact], ["Empfohlene Verbesserung", finding.recommendation], ["Abnahmekriterium", finding.acceptance], ["Verantwortung", finding.owner], ["Zieldatum", finding.dueDate], ["Begründung / Verlaufshinweis", finding.note], ["Nachprüfungsbeleg", finding.retestEvidence]];
    const history = list(finding.history);
    const historyMarkup = history.length ? `<details class="security-audits-run-details"><summary>Änderungsverlauf (${history.length})</summary><ol>${history.map(entry => `<li><strong>${escape(formatInstant(entry.at))} · ${escape(FINDING_STATUSES[entry.status] || entry.status)}</strong><p>Dokumentiert von ${escape(entry.actor || "Unbekannt")} · Registerstand ${escape(entry.revision)}</p><p class="security-audits-preserve">${escape(entry.note || "Kein Vermerk")}</p>${entry.retestEvidence ? `<p class="security-audits-preserve">Nachprüfung: ${escape(entry.retestEvidence)}</p>` : ""}</li>`).join("")}</ol></details>` : "";
    return `<div class="security-audits-labels"><span>${escape(finding.priority || "Ungeklärt")}</span><span>${escape(SEVERITIES[finding.severity] || "Schwere ungeklärt")}</span><span>${escape(CONFIDENCE[finding.confidence] || "Belegstärke ungeklärt")}</span><span${finding.riskAcceptanceExpired ? ' class="security-audits-warning"' : ""}>${escape(DISPLAY_FINDING_STATUSES[findingStatusOf(finding)] || "Ungeklärt")}</span></div>${finding.riskAcceptanceExpired ? '<p class="security-audits-warning">Die befristete Risikoakzeptanz ist abgelaufen. Der Befund erfordert erneut eine verantwortliche Entscheidung oder Behebung.</p>' : finding.overdue ? '<p class="security-audits-warning">Das dokumentierte Zieldatum ist überschritten.</p>' : ""}<p class="security-audits-muted">Anforderungen: ${escape(list(finding.requirementIds).join(", ") || "Keine Zuordnung")}</p><dl class="security-audits-detail">${fields.map(([label, value]) => `<div><dt>${label}</dt><dd>${escape(value || "Noch nicht erfasst")}</dd></div>`).join("")}</dl><h3>Belege</h3>${evidenceMarkup(finding.evidence)}${historyMarkup}`;
  }
  function mount(host, options = {}) {
    if (!host || typeof options.api !== "function") return null;
    let disposed = false, active = false, generation = 0, controller = null, loading = null, payload = null;
    let selectedRunId = "", selectedPanel = "findings", table = null, dialog = null, dialogDirty = false, busy = false, fileTicket = 0, focusOrigin = null;
    let checkStatus = "", chapter = "", profile = "target", findingStatus = "", priority = "";
    const currentUser = () => typeof options.user === "function" ? options.user() : options.user;
    const key = () => typeof options.accessKey === "function" ? String(options.accessKey()) : String(options.accessKey || JSON.stringify([currentUser()?.employeeNumber, currentUser()?.accountId, currentUser()?.role, currentUser()?.permissions]));
    const actorKey = key(), current = () => !disposed && key() === actorKey && accessAllowed(currentUser());
    const readable = () => current() && payload?.capabilities?.read === true;
    const manageable = () => readable() && accessAllowed(currentUser(), "security_audits:manage") && payload?.capabilities?.manage === true;
    const el = selector => host.querySelector(selector);
    const status = message => { const node = el("[data-sa-notice]"); if (node) node.textContent = message; };
    const run = () => list(payload?.runs).find(item => item.id === selectedRunId) || null;
    const rows = () => canonicalChecks(run(), payload?.catalog, Number(payload?.standard?.targetLevel) || 2);
    const cancelRead = () => { generation++; controller?.abort(); controller = null; loading = null; };
    function clearSensitive() {
      cancelRead(); fileTicket++; payload = null; dialog = null; dialogDirty = false; busy = false; selectedRunId = "";
      table?.destroy(); table = null; el("[data-sa-dialog]")?.close?.(); host.replaceChildren();
    }
    function denyAccess(message = "Der Zugriff auf das Auditregister wurde verweigert. Bitte die aktuellen Berechtigungen prüfen.") {
      clearSensitive();
      if (active && current()) { markup(); status(message); }
    }
    function markup() {
      host.innerHTML = '<div class="security-audits-workspace"><div class="security-audits-heading"><div><span class="privacy-org-kicker">Datenschutz · Technische Sicherheit</span><h2>Security Audits</h2><p>Prüfstände, Nachweise und Verbesserungen nachvollziehbar verwalten.</p></div><div class="security-audits-actions"><button type="button" class="secondary-button" data-sa-action="refresh">Aktualisieren</button><button type="button" class="primary-button" data-sa-action="import" hidden>Prüfbericht importieren</button></div></div><p class="security-audits-boundary">Jeder Prüfstand gilt ausschließlich für seinen dokumentierten Umfang und Systemstand. Quellcodeprüfung, isolierte Tests und Produktivnachweise werden getrennt bewertet. Die Anzeige ist keine allgemeine Sicherheitsfreigabe.</p><p data-sa-notice role="status" aria-live="polite" class="security-audits-notice"></p><section data-sa-content></section><dialog class="privacy-org-editor security-audits-dialog" data-sa-dialog data-gp-window-id="security-audits:dialog" aria-label="Security Audit: Details und Bearbeitung" hidden></dialog></div>';
    }
    function metadataMarkup(item) {
      const source = safeSourceUrl(payload?.standard?.sourceUrl), standard = payload?.standard || {};
      return `<details class="security-audits-run-details"><summary>Prüfumfang und Herkunft</summary><dl class="security-audits-detail"><div><dt>Prüfdatum</dt><dd>${escape(formatAuditDate(item.performedAt))}</dd></div><div><dt>Prüfende Person / Stelle</dt><dd>${escape(item.auditor || "Nicht erfasst")}</dd></div><div><dt>Version / Commit</dt><dd>${escape(item.target?.version || "Nicht erfasst")}<code>${escape(item.target?.commit || "Kein Commit gebunden")}</code></dd></div><div><dt>Geprüfte Umgebung</dt><dd>${escape(item.target?.environment || "Nicht erfasst")}</dd></div><div><dt>Prüfumfang</dt><dd>${escape(item.scope || "Nicht erfasst")}</dd></div><div><dt>Berichtsidentität</dt><dd>${escape(item.id)}<code>${escape(item.contentSha256 || "Kein Inhaltsbeleg verfügbar")}</code></dd></div></dl>${list(item.limitations).length ? `<h3>Grenzen dieser Prüfung</h3><ul>${item.limitations.map(value => `<li>${escape(value)}</li>`).join("")}</ul>` : '<p>Keine Einschränkungen dokumentiert. Dies ersetzt keine ausdrückliche Umfangsprüfung.</p>'}<p class="security-audits-muted">Standard: ${source ? `<a href="${escape(source)}" target="_blank" rel="noopener noreferrer">${escape(standard.name || "Prüfstandard")} ${escape(standard.version || "")}</a>` : escape([standard.name, standard.version].filter(Boolean).join(" "))} · Zielprofil Level ${escape(standard.targetLevel || 2)} · ${escape(standard.license || "Lizenz laut Quelle")}. Die Anforderungstitel bleiben in der offiziellen englischen Fassung.</p></details>`;
    }
    function renderSummary(item) {
      const summary = item.summary || {}, entries = [["inScope", "Im Prüfprofil"], ["assessed", "Abschließend bewertet"], ["passed", "Bestanden"], ["failed", "Nicht bestanden"], ["partial", "Teilweise geprüft"], ["notTested", "Nicht geprüft"], ["blocked", "Blockiert"], ["notApplicable", "Nicht anwendbar"]];
      return `<div class="security-audits-summary" aria-label="Prüfabdeckung">${entries.map(([id, label]) => `<div><strong>${escape(Number.isFinite(summary[id]) ? summary[id] : "–")}</strong><span>${label}</span></div>`).join("")}</div><p class="security-audits-muted">Bewertete Anforderungen sind kein Sicherheitsprozentsatz. Offene Anforderungen und Prüfgrenzen bleiben Teil der Beurteilung.</p>`;
    }
    function optionMarkup(values, selected, placeholder) {
      return `<option value="">${placeholder}</option>${Object.entries(values).map(([value, label]) => `<option value="${escape(value)}"${selected === value ? " selected" : ""}>${escape(label)}</option>`).join("")}`;
    }
    function tableRows() {
      if (selectedPanel === "checks") return rows().filter(row => (profile === "all" || row.inScope) && (!checkStatus || row.status === checkStatus) && (!chapter || row.chapterId === chapter));
      return list(run()?.findings).filter(finding => (!findingStatus || findingStatusOf(finding) === findingStatus) && (!priority || finding.priority === priority));
    }
    function actionCell(action, id, label, doc) {
      const button = doc.createElement("button"); button.type = "button"; button.className = "security-audits-row-action";
      button.dataset.saAction = action; button.dataset.saId = id; button.textContent = label; return button;
    }
    function renderTable() {
      table?.destroy(); table = null;
      const target = el("[data-sa-table]");
      const factory = options.tableFactory || root.RightsSettingsTable?.mount;
      if (!target || !factory) { if (target) target.textContent = "Die Tabellenansicht konnte nicht geladen werden. Bitte die Seite neu laden."; return; }
      const checkColumns = [
        { id: "requirementId", label: "Anforderung", mandatory: true, width: 135, cell: (row, doc) => actionCell("check", row.id, row.id, doc) },
        { id: "title", label: "Anforderungstitel", width: 400 }, { id: "chapter", label: "Kapitel", width: 210 }, { id: "level", label: "Level", width: 80, numeric: true },
        { id: "status", label: "Prüfergebnis", cell: row => CHECK_STATUSES[row.status] || "Ungeklärt", sortValue: row => CHECK_STATUSES[row.status] || row.status },
        { id: "method", label: "Methode", cell: row => METHODS[row.method] || "Ungeklärt" }, { id: "note", label: "Prüfvermerk", visible: false },
      ];
      const findingColumns = [
        { id: "id", label: "Befund", mandatory: true, width: 150, cell: (row, doc) => actionCell("finding", row.id, row.id, doc) },
        { id: "title", label: "Titel", width: 320 }, { id: "priority", label: "Priorität", width: 85 },
        { id: "status", label: "Maßnahmenstatus", sortValue: row => DISPLAY_FINDING_STATUSES[findingStatusOf(row)] || "Ungeklärt", cell: (row, doc) => { const label = doc.createElement("span"); label.textContent = DISPLAY_FINDING_STATUSES[findingStatusOf(row)] || "Ungeklärt"; if (row.riskAcceptanceExpired) label.className = "security-audits-warning"; return label; } },
        { id: "confidence", label: "Belegstärke", cell: row => CONFIDENCE[row.confidence] || "Ungeklärt" },
        { id: "severity", label: "Technische Schwere", cell: row => SEVERITIES[row.severity] || "Ungeklärt", visible: false },
        { id: "owner", label: "Verantwortung" }, { id: "dueDate", label: "Zieldatum" },
      ];
      table = factory({ host: target, tableId: "security-audits-" + selectedPanel, identity: () => JSON.stringify([currentUser()?.accountId || "", currentUser()?.employeeNumber || ""]), canUse: () => active && readable(), columns: selectedPanel === "checks" ? checkColumns : findingColumns, rows: tableRows(), label: selectedPanel === "checks" ? "ASVS-Prüfabdeckung" : "Sicherheitsbefunde und Maßnahmen", searchLabel: selectedPanel === "checks" ? "Anforderungen durchsuchen" : "Befunde durchsuchen", emptyText: selectedPanel === "checks" ? "Keine Anforderungen für diese Filter." : "Keine Befunde für diese Filter. Das ist keine Bestätigung vollständiger Sicherheit.", searchText: row => selectedPanel === "checks" ? [row.id, row.title, row.chapter, row.note].join(" ") : [row.id, row.title, row.description, row.owner].join(" ") });
    }
    function renderPanel() {
      const panel = el("[data-sa-results]"); if (!panel || !run()) return;
      const chapters = Object.fromEntries(list(payload.catalog).map(item => [item.chapterId, item.chapter]));
      panel.innerHTML = `<div class="security-audits-panel-tabs" aria-label="Auditansicht"><button type="button" data-sa-panel="findings" aria-pressed="${selectedPanel === "findings"}">Befunde und Maßnahmen (${list(run().findings).length})</button><button type="button" data-sa-panel="checks" aria-pressed="${selectedPanel === "checks"}">Prüfabdeckung</button></div><div class="security-audits-filters">${selectedPanel === "checks" ? `<label class="field"><span>Ergebnis</span><select data-sa-filter="checkStatus">${optionMarkup(CHECK_STATUSES, checkStatus, "Alle Ergebnisse")}</select></label><label class="field"><span>Kapitel</span><select data-sa-filter="chapter">${optionMarkup(chapters, chapter, "Alle Kapitel")}</select></label><label class="field"><span>Umfang</span><select data-sa-filter="profile"><option value="target"${profile === "target" ? " selected" : ""}>Zielprofil und zusätzliche Prüfungen</option><option value="all"${profile === "all" ? " selected" : ""}>Gesamter Katalog</option></select></label>` : `<label class="field"><span>Maßnahmenstatus</span><select data-sa-filter="findingStatus">${optionMarkup(DISPLAY_FINDING_STATUSES, findingStatus, "Alle Maßnahmen")}</select></label><label class="field"><span>Priorität</span><select data-sa-filter="priority">${optionMarkup({ P0: "P0 – Akut", P1: "P1 – Hoch", P2: "P2 – Mittel", P3: "P3 – Planbar" }, priority, "Alle Prioritäten")}</select></label>`}</div><div data-sa-table></div>`;
      renderTable();
    }
    function render() {
      if (!current()) { clearSensitive(); return; }
      if (!el("[data-sa-content]")) markup();
      const importButton = el('[data-sa-action="import"]'); if (importButton) importButton.hidden = !manageable();
      const content = el("[data-sa-content]");
      if (!readable()) { content.textContent = "Für diesen Bereich ist eine persönliche Security-Audit-Berechtigung erforderlich."; return; }
      const runs = list(payload.runs).slice().sort((a, b) => String(b.performedAt).localeCompare(String(a.performedAt)));
      if (!runs.some(item => item.id === selectedRunId)) selectedRunId = runs[0]?.id || "";
      const item = run();
      if (!item) { table?.destroy(); table = null; content.innerHTML = '<div class="security-audits-empty"><h3>Noch kein Auditbericht erfasst</h3><p>Hier erscheinen nachvollziehbare Prüfstände und Maßnahmen. Berechtigte Verantwortliche können einen lokal vorbereiteten JSON-Bericht importieren.</p><p>Beim Öffnen werden keine Scans oder Prüfaktionen ausgelöst.</p></div>'; return; }
      content.innerHTML = `<label class="field security-audits-run-picker"><span>Prüfstand auswählen</span><select data-sa-run>${runs.map(entry => `<option value="${escape(entry.id)}"${entry.id === selectedRunId ? " selected" : ""}>${escape(entry.title)} · ${escape(formatAuditDate(entry.performedAt))}</option>`).join("")}</select></label>${renderSummary(item)}${metadataMarkup(item)}<section data-sa-results></section>`;
      renderPanel();
    }
    async function load() {
      if (!current()) { clearSensitive(); return false; }
      if (!active) return false;
      if (loading) return loading;
      if (!el("[data-sa-content]")) markup();
      const ticket = generation;
      controller = typeof AbortController === "function" ? new AbortController() : null;
      status("Auditregister wird geladen …");
      loading = (async () => {
        try {
          const result = await options.api(ENDPOINT, controller ? { signal: controller.signal } : {});
          if (!current()) { clearSensitive(); return false; }
          if (!active || ticket !== generation) return false;
          if (result?.capabilities?.read !== true) { denyAccess(); return false; }
          payload = result; render(); status("Prüfstände geladen. Produktivnachweise gelten nur für die ausdrücklich dokumentierte Installation."); return true;
        } catch (error) {
          if (!current()) { clearSensitive(); return false; }
          if (ticket !== generation || !active) return false;
          if ([401, 403, 428].includes(error?.status)) { denyAccess(error.status === 428 ? "Bitte zuerst das persönliche Startpasswort ändern. Vertrauliche Prüfstände und Arbeitsfassungen wurden geschlossen." : undefined); return false; }
          status(error?.message || "Die Prüfstände konnten nicht geladen werden."); return false;
        } finally { if (ticket === generation) { loading = null; controller = null; } }
      })();
      return loading;
    }
    function closeDialog({ force = false } = {}) {
      if (!force && busy) return false;
      if (!force && dialogDirty && (typeof root.confirm !== "function" || !root.confirm("Ungespeicherte Audit-Angaben verwerfen?"))) return false;
      fileTicket++; dialog = null; dialogDirty = false;
      const target = el("[data-sa-dialog]"); target?.close?.(); if (target) { target.hidden = true; target.replaceChildren(); }
      if (focusOrigin?.isConnected) focusOrigin.focus?.({ preventScroll: true }); focusOrigin = null; return true;
    }
    function showDialog(title, body, { form = "", submitLabel = "Speichern" } = {}) {
      const target = el("[data-sa-dialog]"); if (!target) return;
      focusOrigin = host.ownerDocument?.activeElement || null;
      const shell = `<div class="privacy-org-editor-heading dialog-heading"><div><span class="privacy-org-kicker">Security Audits</span><h2>${escape(title)}</h2></div><button type="button" class="privacy-org-close" data-sa-action="close" aria-label="Dialog schließen">×</button></div><div class="privacy-org-editor-body">${body}<p data-sa-form-status role="status" aria-live="polite"></p></div><div class="privacy-org-editor-actions"><span>Nur für berechtigte persönliche Konten.</span><div><button type="button" class="secondary-button" data-sa-action="close">${form ? "Abbrechen" : "Schließen"}</button>${form ? `<button type="submit" class="primary-button">${submitLabel}</button>` : ""}</div></div>`;
      target.innerHTML = form ? `<form data-sa-form="${form}" class="privacy-org-dialog-shell" autocomplete="off">${shell}</form>` : `<div class="privacy-org-dialog-shell">${shell}</div>`;
      target.hidden = false; target.showModal?.();
    }
    function openImport() {
      if (!manageable() || !closeDialog()) return;
      dialog = { kind: "import", expectedRevision: payload.revision, run: null }; dialogDirty = false;
      showDialog("Prüfbericht importieren", '<p>Wähle einen lokal vorbereiteten JSON-Bericht. Der Import speichert ausschließlich diesen Prüfstand und führt keine Scans aus.</p><label class="field"><span>JSON-Datei · höchstens 900 KiB</span><input type="file" accept=".json,application/json" data-sa-file /></label><p class="security-audits-muted">Keine Passwörter, Tokens, personenbezogenen Rohdaten oder unbereinigten Logdateien aufnehmen. Große Berichte kürzen; der Server begrenzt den gesamten Request auf 1 MiB.</p><div data-sa-import-preview>Bitte eine Datei auswählen. Vor dem Speichern wird eine Vorschau angezeigt.</div>', { form: "import", submitLabel: "Prüfbericht speichern" });
    }
    function openFinding(id, edit = false) {
      const finding = list(run()?.findings).find(item => item.id === id);
      if (!readable() || !finding || (edit && !manageable()) || !closeDialog()) return;
      dialog = { kind: edit ? "edit" : "finding", runId: selectedRunId, findingId: id, expectedRevision: payload.revision };
      if (!edit) { showDialog(finding.id + " · " + finding.title, findingMarkup(finding) + (manageable() ? `<button type="button" class="primary-button" data-sa-action="edit" data-sa-id="${escape(id)}">Maßnahme bearbeiten</button>` : "")); return; }
      const text = (name, label, value, multiline = false, required = false) => `<label class="field"><span>${label}${required ? " *" : ""}</span>${multiline ? `<textarea name="${name}" rows="4"${required ? " required" : ""}>${escape(value || "")}</textarea>` : `<input name="${name}" type="${name === "dueDate" ? "date" : "text"}" value="${escape(value || "")}" />`}</label>`;
      showDialog("Maßnahme bearbeiten · " + finding.id, `<p>${escape(finding.title)}</p><label class="field"><span>Maßnahmenstatus</span><select name="status">${Object.entries(FINDING_STATUSES).map(([value, label]) => `<option value="${value}"${finding.status === value ? " selected" : ""}>${label}</option>`).join("")}</select></label>${text("owner", "Verantwortung", finding.owner)}${text("dueDate", "Zieldatum", finding.dueDate)}${text("note", "Begründung der Änderung / Risikoentscheidung", "", true, true)}${text("retestEvidence", "Nachprüfungsbeleg", finding.retestEvidence, true)}<p class="security-audits-muted">„Behoben / nachgeprüft“ benötigt einen konkreten Beleg mit geprüftem Stand und Ergebnis. Eine Risikoakzeptanz beseitigt die Schwachstelle nicht. Produktivwirksamkeit gesondert dokumentieren. Eine Statusänderung schreibt die ursprünglichen Prüfergebnisse nicht um.</p>`, { form: "edit" });
    }
    function openCheck(id) {
      const check = rows().find(item => item.id === id);
      if (!readable() || !check || !closeDialog()) return;
      dialog = { kind: "check" };
      showDialog(check.id + " · Level " + check.level, `<p>${escape(check.title)}</p><div class="security-audits-labels"><span>${escape(CHECK_STATUSES[check.status] || "Ungeklärt")}</span><span>${escape(METHODS[check.method] || "Ungeklärt")}</span></div><h3>Prüfvermerk</h3><p class="security-audits-preserve">${escape(check.note || "Kein Prüfvermerk erfasst.")}</p><h3>Nachweise</h3>${evidenceMarkup(check.evidence)}`);
    }
    async function chooseFile(input) {
      if (!manageable() || dialog?.kind !== "import" || busy) return;
      const targetDialog = dialog, ticket = ++fileTicket, file = input.files?.[0]; targetDialog.run = null; dialogDirty = !!file;
      const message = el("[data-sa-form-status]"), preview = el("[data-sa-import-preview]");
      if (message) message.textContent = ""; if (preview) preview.textContent = file ? "Datei wird gelesen …" : "Bitte eine Datei auswählen.";
      if (!file) return;
      try {
        if (file.size > MAX_IMPORT_BYTES) throw new Error("Die JSON-Datei darf höchstens 900 KiB groß sein.");
        const text = await file.text();
        if (!current()) { clearSensitive(); return; }
        if (!active || dialog !== targetDialog || ticket !== fileTicket) return;
        const imported = parseImport(text, file.size); targetDialog.run = imported;
        preview.innerHTML = `<div class="security-audits-import-preview"><h3>${escape(imported.title)}</h3><p>${escape(imported.id)} · ${escape(imported.target?.environment || "Umgebung nicht erfasst")}</p><p>${imported.checks.length} erfasste Prüfungen · ${imported.findings.length} Befunde</p><p>Stand: ${escape(imported.target?.version || "Nicht erfasst")} · ${escape(imported.target?.commit || "Kein Commit")}</p><p>Der Bericht wird erst mit „Prüfbericht speichern“ übertragen.</p></div>`;
      } catch (error) { if (current() && dialog === targetDialog && ticket === fileTicket) { targetDialog.run = null; if (message) message.textContent = error.message; if (preview) preview.textContent = "Keine importierbare Datei ausgewählt."; } }
    }
    async function submit(event) {
      const form = event.target.closest?.("[data-sa-form]"); if (!form) return;
      event.preventDefault(); if (!manageable() || busy || !dialog) return;
      const targetDialog = dialog, ticket = generation, message = form.querySelector("[data-sa-form-status]");
      let body;
      try {
        if (dialog.kind === "import") {
          if (!dialog.run) throw new Error("Bitte zuerst eine gültige JSON-Datei auswählen und die Vorschau prüfen.");
          body = { action: "import", expectedRevision: dialog.expectedRevision, run: dialog.run };
          if (new TextEncoder().encode(JSON.stringify(body)).length > 1000 * 1024) throw new Error("Der vorbereitete Import ist zu groß für den Server. Bitte den Bericht kürzen.");
        } else body = { action: "update_finding", expectedRevision: dialog.expectedRevision, runId: dialog.runId, findingId: dialog.findingId, changes: findingChanges(form) };
      } catch (error) { message.textContent = error.message; return; }
      busy = true; dialogDirty = true;
      const controls = form.querySelectorAll("input,select,textarea,button"); controls.forEach(control => { control.disabled = true; }); message.textContent = "Wird gespeichert …";
      try {
        const result = await options.api(ENDPOINT + "/commands", { method: "POST", body: JSON.stringify(body) });
        if (!current()) { clearSensitive(); return; }
        if (ticket !== generation || !active || dialog !== targetDialog) {
          if (dialog === targetDialog) message.textContent = "Die Speicherantwort traf nach dem Bereichswechsel ein. Den aktuellen Registerstand prüfen, bevor du diese Arbeitsfassung erneut speicherst.";
          return;
        }
        if (result?.capabilities?.read !== true) { denyAccess(); return; }
        payload = result; if (body.action === "import") selectedRunId = body.run.id;
        closeDialog({ force: true }); render(); el("[data-sa-run]")?.focus?.({ preventScroll: true }); status("Gespeichert. Der dokumentierte Prüfstand und die Maßnahmen wurden aktualisiert.");
      } catch (error) {
        if (!current()) { clearSensitive(); return; }
        if (ticket !== generation || dialog !== targetDialog) return;
        if ([401, 403, 428].includes(error?.status)) { denyAccess(error.status === 428 ? "Bitte zuerst das persönliche Startpasswort ändern. Vertrauliche Prüfstände und Arbeitsfassungen wurden geschlossen." : undefined); return; }
        message.textContent = error?.status === 409 ? "Der Registerstand hat sich geändert. Deine Eingaben bleiben erhalten. Aktuellen Stand prüfen und die Bearbeitung anschließend neu öffnen." : error?.message || "Speichern fehlgeschlagen. Die Eingaben bleiben erhalten.";
      } finally { if (current() && dialog === targetDialog) controls.forEach(control => { control.disabled = false; }); busy = false; }
    }
    async function click(event) {
      if (!current()) { clearSensitive(); return; }
      const panelButton = event.target.closest?.("[data-sa-panel]");
      if (panelButton) { selectedPanel = panelButton.dataset.saPanel === "checks" ? "checks" : "findings"; renderPanel(); return; }
      const button = event.target.closest?.("[data-sa-action]"); if (!button || button.disabled) return;
      switch (button.dataset.saAction) {
        case "refresh": await load(); break;
        case "import": openImport(); break;
        case "close": closeDialog(); break;
        case "finding": openFinding(button.dataset.saId); break;
        case "edit": openFinding(button.dataset.saId, true); break;
        case "check": openCheck(button.dataset.saId); break;
      }
    }
    async function changed(event) {
      if (!current()) { clearSensitive(); return; }
      if (event.target.matches?.("[data-sa-file]")) { await chooseFile(event.target); return; }
      if (event.target.closest?.("[data-sa-form]")) dialogDirty = true;
      if (event.target.matches?.("[data-sa-run]")) { selectedRunId = event.target.value; render(); return; }
      const filter = event.target.dataset?.saFilter;
      if (filter) {
        const value = event.target.value;
        if (filter === "checkStatus") checkStatus = value; else if (filter === "chapter") chapter = value; else if (filter === "profile") profile = value;
        else if (filter === "findingStatus") findingStatus = value; else if (filter === "priority") priority = value;
        table?.setRows(tableRows());
      }
    }
    const beforeUnload = event => { if ((dialogDirty || busy) && current()) { event.preventDefault(); event.returnValue = ""; } };
    const cancel = event => { if (event.target.matches?.("[data-sa-dialog]")) { event.preventDefault(); closeDialog(); } };
    host.addEventListener("click", click); host.addEventListener("submit", submit); host.addEventListener("change", changed); host.addEventListener("input", changed); host.addEventListener("cancel", cancel, true);
    root.addEventListener?.("beforeunload", beforeUnload);
    return {
      async activate() {
        if (!current()) { clearSensitive(); return false; }
        active = true; if (payload) render(); const loaded = await load();
        if (current() && active && dialog) { const target = el("[data-sa-dialog]"); if (target && !target.open) target.showModal?.(); }
        return loaded;
      },
      load, hasUnsavedChanges: () => dialogDirty || busy,
      suspend() { active = false; cancelRead(); fileTicket++; table?.destroy(); table = null; el("[data-sa-dialog]")?.close?.(); },
      destroy() { disposed = true; active = false; clearSensitive(); host.removeEventListener("click", click); host.removeEventListener("submit", submit); host.removeEventListener("change", changed); host.removeEventListener("input", changed); host.removeEventListener("cancel", cancel, true); root.removeEventListener?.("beforeunload", beforeUnload); },
    };
  }
  return Object.freeze({ ENDPOINT, MAX_IMPORT_BYTES, CHECK_STATUSES, FINDING_STATUSES, METHODS, CONFIDENCE, SEVERITIES, accessAllowed, escape, safeSourceUrl, formatInstant, formatAuditDate, canonicalChecks, parseImport, findingChanges, evidenceMarkup, findingMarkup, mount });
});
