(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.PersonnelDashboardInfo = value;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";
  const labels = { loading: "Wird geladen", succeeded: "Geladen", partial: "Teilstand", denied: "Nicht freigegeben", failed: "Quelle nicht verfügbar", idle: "Noch nicht geladen" };
  const sourceLabels = { onboarding: "Onboarding", offboarding: "Offboarding", absence: "Urlaub & Zeitausgleich", amu: "AMU-Meldungen", sickness: "Krankenstände" };
  const number = value => Number.isSafeInteger(value) && value >= 0;
  const metric = (label, value) => ({ label, value });
  function list(value) {
    if (!Array.isArray(value)) throw new Error("Ungültige Datenquelle");
    return value;
  }
  function denied(value, capability) {
    if (value?.capabilities?.[capability] !== true) throw Object.assign(new Error("Nicht freigegeben"), { status: 403 });
  }
  function summarize(type, value, scope = {}) {
    let metrics = [], caption = "Freigegebener Bereich", status = "succeeded";
    if (type === "employees" || type === "positions" || type === "costCenters") {
      const rows = list(type === "employees" ? value?.employees : type === "costCenters" ? value?.costCenters : value);
      const known = rows.filter(row => typeof row?.active === "boolean");
      metrics = [metric("Gesamtbestand", rows.length), metric("Aktiv", known.filter(row => row.active).length), metric("Archiviert / inaktiv", known.filter(row => !row.active).length)];
      if (known.length !== rows.length) {
        status = "partial";
        metrics = [metric("Geladene Datensätze", rows.length), metric("Status nicht bekannt", rows.length - known.length)];
      }
      caption = type === "employees" ? "Zentrales Personalverzeichnis · einschließlich inaktiver Personen" : "Freigegebenes Register · einschließlich inaktiver Einträge";
    } else if (type === "candidates") {
      denied(value, "canReadCandidates");
      const rows = list(value.candidates), page = value.pagination;
      if (!page || page.offset !== 0 || page.limit !== 50 || typeof page.hasMore !== "boolean" || rows.length > 50) throw new Error("Ungültige Bewerbungsstichprobe");
      const complete = !page.hasMore;
      const total = number(page.total) && page.total >= rows.length ? page.total : complete ? rows.length : null;
      if (page.total !== undefined && total !== page.total) throw new Error("Ungültiger Gesamtbestand");
      status = page.hasMore ? "partial" : "succeeded";
      metrics = [metric("Gesamtbestand", total), metric("Geladene Personen", rows.length)];
      caption = complete ? "Freigegebener Bestand · ohne archivierte Personen" : "Erste 50 Personen · ohne archivierte Personen; Gesamtbestand nicht vollständig geladen";
    } else if (type === "learning") {
      denied(value, "canRead");
      list(value.modules);
      for (const id of ["visible", "published", "drafts"]) if (!number(value.summary?.[id])) throw new Error("Ungültige Katalogzahlen");
      metrics = [metric("Prozessvorlagen", value.summary.visible), metric("Veröffentlicht", value.summary.published), metric("Mit Entwurf", value.summary.drafts)];
      caption = "Gesamter freigegebener Prozesskatalog · Vorlagen mit Entwurf können zugleich veröffentlicht sein";
    } else if (type === "workflows") {
      denied(value, "canRead");
      const rows = list(value.instances);
      if (rows.some(row => !["open", "resolved"].includes(row.status))) throw new Error("Ungültiger Instanzstatus");
      metrics = [metric("Instanzen", rows.length), metric("Offene Instanzen", rows.filter(row => row.status === "open").length)];
      caption = "Freigegebene Prozessinstanzen · unabhängig von Vorlagen und einzelnen Aufgaben";
    } else if (type === "onboarding" || type === "offboarding") {
      denied(value, type === "onboarding" ? "canReadOnboardingTasks" : "canReadOffboardingTasks");
      const rows = list(value.tasks);
      const keys = rows.map(row => `${row?.runId || ""}:${row?.stepId || ""}`);
      if (rows.some(row => !row?.runId || !row?.stepId) || new Set(keys).size !== rows.length) throw new Error("Ungültige Aufgabenprojektion");
      metrics = [metric(type === "onboarding" ? "Onboarding-Schritte" : "Offboarding-Schritte", rows.length)];
      caption = "Aktive, dir persönlich zugewiesene Schritte";
    } else if (type === "absence") {
      list(value.requests);
      const counts = value.counts;
      if (![counts?.vacation, counts?.timeOff, counts?.total].every(number) || counts.total !== counts.vacation + counts.timeOff) throw new Error("Ungültige Antragszahlen");
      metrics = [metric("Urlaub: entscheidbar", counts.vacation), metric("Zeitausgleich: entscheidbar", counts.timeOff)];
      caption = "Aktuell von dir entscheidbare Anträge · kein Jahres- oder Quartalswert";
    } else if (type === "amu" || type === "sickness") {
      list(type === "amu" ? value.reports : value.cases);
      if (!number(value.pendingCount)) throw new Error("Ungültige Meldungszahlen");
      if (value.available === false || value.access?.available === false) throw Object.assign(new Error("Nicht freigegeben"), { status: 403 });
      metrics = [metric(type === "amu" ? "Dir zugewiesene offene AMU-Meldungen" : "Offene Krankenstände", value.pendingCount)];
      caption = type === "amu" ? "Aktuelle offene AMU-Meldungen in deiner persönlichen Zuständigkeit · kein Gesamtbestand des Bereichs" : "Aktuelle offene Krankenstände im freigegebenen Bereich · getrennt von Abwesenheitsanträgen";
    } else if (type === "timeTracking") {
      const p = value?.presence;
      if (!p || p.date !== scope.date || String(p.locationId) !== scope.locationId || String(p.departmentId || "") !== scope.departmentId) throw new Error("Fremder Anwesenheitsbereich");
      const rows = list(p.employees);
      metrics = [metric("Personen im Tagesbereich", rows.length)];
      caption = `${scope.date} · ${p.locationName || scope.locationId}${p.departmentName ? " · " + p.departmentName : ""} · Tagesbestand, keine Stundensumme`;
    } else if (type === "ruleDrafts") {
      list(value.drafts);
      for (const id of ["drafts", "pendingReview", "active"]) if (!number(value.summary?.[id])) throw new Error("Ungültige Regelzahlen");
      metrics = [metric("Regelentwürfe", value.summary.drafts), metric("In Prüfung / freigegeben", value.summary.pendingReview), metric("Aktive Zuordnungen", value.summary.active)];
      caption = "Freigegebener Regelbestand · Entwürfe und wirksame Zuordnungen sind getrennt";
    } else if (type === "collectiveAgreements") {
      const rows = list(value.agreements);
      metrics = [metric("Kollektivverträge", rows.length), metric("Quellenfassungen", rows.reduce((sum, row) => sum + list(row.versions).length, 0))];
      caption = value.scopeLabel || "Freigegebener Registerbereich";
    } else if (type === "vacations") {
      if (value?.year !== scope.year) throw new Error("Fremdes Urlaubsjahr");
      const rows = list(value.vacations);
      if (rows.some(row => !String(row.employee_number || ""))) throw new Error("Ungültige Urlaubszuordnung");
      metrics = [metric("Urlaubseinträge", rows.length), metric("Personen mit Urlaub", new Set(rows.map(row => row.employee_number)).size)];
      caption = `Urlaubsjahr ${scope.year} · gesamter freigegebener Jahresbestand, einschließlich Direktbuchungen`;
    } else throw new Error("Unbekannte Informationsquelle");
    return { status, metrics, caption };
  }
  function create({ sources, capture, current, active, onChange, api }) {
    let records = {}, ticket = null, signature = null, request = null, generation = 0;
    const notify = () => onChange?.(records);
    function clear() {
      generation++; request?.abort(); request = null; ticket = null; signature = null; records = {}; notify();
    }
    function sync({ force = false } = {}) {
      if (!active()) { if (ticket || Object.keys(records).length) clear(); return Promise.resolve(); }
      const specs = sources(), next = JSON.stringify(specs.map(s => [s.id, s.url, s.allowed, s.scope]));
      if (!force && ticket && current(ticket) && signature === next) return request?.pending || Promise.resolve();
      clear(); signature = next; ticket = capture();
      const own = ticket, revision = generation, controller = new AbortController(); request = controller;
      const valid = () => generation === revision && active() && current(own)
        && JSON.stringify(sources().map(s => [s.id, s.url, s.allowed, s.scope])) === next;
      for (const spec of specs) records[spec.id] = { id: spec.id, card: spec.card, status: spec.allowed ? "loading" : "denied", metrics: [], caption: spec.note || "Kennzahlen sind für dieses Konto nicht freigegeben." };
      notify();
      controller.pending = Promise.all(specs.filter(s => s.allowed).map(async spec => {
        try {
          const value = await api(spec.url, { signal: controller.signal });
          if (!valid()) return;
          records[spec.id] = { id: spec.id, card: spec.card, ...summarize(spec.type, value, spec.scope) };
        } catch (error) {
          if (!valid()) return;
          records[spec.id] = { id: spec.id, card: spec.card, status: error.status === 403 || error.status === 401 ? "denied" : "failed", metrics: [], caption: error.status === 403 || error.status === 401 ? "Kennzahlen sind für dieses Konto nicht freigegeben." : "Diese Quelle konnte nicht geladen werden. Bitte erneut laden." };
        }
        if (valid()) notify();
      }));
      return controller.pending;
    }
    return { sync, clear, get records() { return records; } };
  }
  return { summarize, create, labels, sourceLabels };
});
