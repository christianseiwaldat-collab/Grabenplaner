(function (root) {
  "use strict";
  const severityLabels = { error: "Konflikt", warning: "Warnung", unknown: "Nicht prüfbar", info: "Hinweis" };
  function mount(host, { api, onApplied = async () => {} }) {
    const doc = host.ownerDocument, node = (tag, text, className) => { const item = doc.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; };
    let source = null, actor = null, result = null, generation = 0, controller = null, busy = false, limit = 40, dirty = false, draftRevision = null;
    host.className = "planning-assistant"; host.hidden = true;
    const heading = node("header"), headingText = node("div"), status = node("p", "Dienstplanprüfung wird vorbereitet …", "planning-assistant-status");
    status.setAttribute("role", "status"); headingText.append(node("h2", "Planungsassistent"), status);
    const refresh = node("button", "Erneut prüfen", "secondary-button"); refresh.type = "button"; heading.append(headingText, refresh);
    const caption = node("p", "Lokale Prüfung des gespeicherten Wochenplans. Vorschläge ändern keine Dienste."), details = node("details"), summary = node("summary", "Konflikte und Hinweise"), filterBar = node("label", undefined, "planning-assistant-filter"), filter = node("select");
    filter.setAttribute("aria-label", "Hinweise nach Schweregrad filtern");
    for (const [id, text] of [["all", "Alle Schweregrade"], ...Object.entries(severityLabels)]) { const option = node("option", text); option.value = id; filter.append(option); }
    filterBar.append(node("span", "Anzeige"), filter);
    const list = node("div", undefined, "planning-assistant-list"), more = node("button", "Weitere Hinweise anzeigen", "secondary-button"); more.type = "button";
    details.append(summary, filterBar, list, more);
    const settings = node("details", undefined, "planning-assistant-settings"), form = node("form"), settingsStatus = node("p"); settingsStatus.setAttribute("role", "status");
    settings.append(node("summary", "Prüfeinstellungen für diesen Bereich"), form); settings.hidden = true;
    const toleranceLabel = node("label"), tolerance = node("input"); tolerance.name = "weeklyToleranceMinutes"; tolerance.type = "number"; tolerance.min = "0"; tolerance.max = "600"; tolerance.step = "1"; tolerance.required = true;
    toleranceLabel.append(node("span", "Toleranz beim Wochensoll (Minuten)"), tolerance);
    const positions = node("fieldset"), rows = node("div"), addPosition = node("button", "Position hinzufügen", "secondary-button"); addPosition.type = "button";
    positions.append(node("legend", "Erforderliche Positionen"), node("p", "Mindestanzahl im bestehenden Besetzungsfenster. Eine Position ersetzt keinen Fachnachweis."), rows, addPosition);
    const keyPeople = node("fieldset"), people = node("div", undefined, "planning-key-people"); keyPeople.append(node("legend", "Schlüsselpersonen"), node("p", "Mindestens eine ausgewählte Person muss während des Besetzungsfensters verfügbar sein. Ohne Auswahl gilt keine zusätzliche Vorgabe."), people);
    const save = node("button", "Prüfeinstellungen speichern", "primary-button"), reloadSettings = node("button", "Eingaben verwerfen und neu laden", "secondary-button"); save.type = "submit"; reloadSettings.type = "button";
    const settingsActions = node("div", undefined, "planning-assistant-actions"); settingsActions.append(save, reloadSettings);
    form.append(node("p", "Öffnungs-, Pausen- und Mindestbesetzungszeiten stammen aus den Filialeinstellungen. Gesetzliche Grenzen stammen aus den bestehenden Arbeitsregelprofilen."), toleranceLabel, positions, keyPeople, settingsStatus, settingsActions);
    const optimizerHost = node("div");
    const optimizer = root.GpPlanningOptimizer?.mount(optimizerHost, { api, onApplied });
    host.replaceChildren(heading, caption, details, optimizerHost, settings);
    function lock(value) { busy = value; refresh.disabled = value || !source; for (const item of form.querySelectorAll("input,select,button")) item.disabled = value; }
    function clearResult() { optimizer?.reset(); result = null; list.replaceChildren(); details.hidden = true; settings.hidden = true; if (!dirty) { form.reset(); rows.replaceChildren(); people.replaceChildren(); settingsStatus.textContent = ""; } more.hidden = true; }
    function reset() { generation++; controller?.abort(); source = null; actor = null; dirty = false; draftRevision = null; clearResult(); lock(false); host.hidden = true; }
    function markDirty() { if (!dirty && result) draftRevision = result.configuration.revision; dirty = true; }
    function renderFindings() {
      list.replaceChildren(); if (!result) return;
      const entries = result.assessment.findings.filter(item => filter.value === "all" || item.severity === filter.value);
      for (const entry of entries.slice(0, limit)) {
        const card = node("article", undefined, "planning-assistant-finding"); card.dataset.severity = entry.severity;
        const meta = [severityLabels[entry.severity], entry.date && new Intl.DateTimeFormat("de-AT", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(entry.date + "T12:00:00Z")), entry.startTime && `${entry.startTime}–${entry.endTime}`].filter(Boolean).join(" · ");
        card.append(node("small", meta), node("h3", entry.title));
        if (entry.people?.length) card.append(node("p", entry.people.map(person => person.label).join(", ")));
        card.append(node("p", entry.message), node("p", entry.suggestion, "planning-assistant-suggestion"));
        list.append(card);
      }
      if (!entries.length) list.append(node("p", "Für diesen Filter liegen keine Hinweise vor."));
      more.hidden = entries.length <= limit; more.textContent = `Weitere Hinweise anzeigen (${Math.max(0, entries.length - limit)})`;
    }
    function positionRow(value = {}) {
      const row = node("div", undefined, "planning-position-row"), select = node("select"), count = node("input"), remove = node("button", "Entfernen", "secondary-button");
      select.setAttribute("aria-label", "Erforderliche Position"); select.required = true; const placeholder = node("option", "Position wählen"); placeholder.value = ""; select.append(placeholder);
      const choices = [...result.choices.positions]; if (value.positionId && !choices.some(item => item.id === value.positionId)) choices.push({ id: value.positionId, name: value.positionId + " (nicht mehr aktiv)" });
      for (const item of choices) { const option = node("option", item.name); option.value = item.id; select.append(option); }
      select.value = value.positionId || ""; count.type = "number"; count.min = "1"; count.max = "99"; count.step = "1"; count.required = true; count.value = value.count || 1; count.setAttribute("aria-label", "Mindestanzahl");
      remove.type = "button"; remove.addEventListener("click", () => { markDirty(); row.remove(); }); row.append(select, count, remove); rows.append(row);
    }
    function renderSettings() {
      settings.hidden = !result.canConfigure; if (!result.canConfigure) { dirty = false; draftRevision = null; rows.replaceChildren(); people.replaceChildren(); return; } if (dirty) return;
      tolerance.value = result.configuration.configuration.weeklyToleranceMinutes; rows.replaceChildren(); people.replaceChildren();
      for (const item of result.configuration.configuration.requiredPositions) positionRow(item);
      const selected = result.configuration.configuration.keyPersonNumbers, choices = [...result.choices.employees];
      for (const id of selected) if (!choices.some(item => item.id === id)) choices.push({ id, label: id + " (nicht mehr im Bereich)" });
      for (const item of choices) { const label = node("label"), input = node("input"); input.type = "checkbox"; input.value = item.id; input.checked = selected.includes(item.id); label.append(input, node("span", item.label)); people.append(label); }
    }
    async function load() {
      if (!source) return;
      const token = ++generation, expectedSource = source; controller?.abort(); controller = new AbortController();
      clearResult(); lock(true); status.textContent = "Gespeicherten Dienstplan lokal prüfen …";
      const query = new URLSearchParams({ week: source.weekStart, locationId: source.context.locationId, ...(source.context.departmentId ? { departmentId: source.context.departmentId } : {}) });
      try {
        const payload = await api("/api/schedule/assistant?" + query, { signal: controller.signal });
        if (token !== generation || source !== expectedSource) return;
        result = payload; const counts = payload.assessment.counts;
        status.textContent = `${counts.error} ${counts.error === 1 ? "Konflikt" : "Konflikte"} · ${counts.warning} ${counts.warning === 1 ? "Warnung" : "Warnungen"} · ${counts.unknown} nicht prüfbar · ${counts.info} ${counts.info === 1 ? "Hinweis" : "Hinweise"}`;
        const dateText = value => new Intl.DateTimeFormat("de-AT", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value + "T12:00:00Z"));
        caption.textContent = `Gespeicherter Plan ${dateText(payload.assessment.period.from)} bis ${dateText(payload.assessment.period.to)} · ${payload.assessment.context.departmentName || payload.assessment.context.locationName}. Lokal geprüft; Vorschläge ändern keine Dienste.`;
        details.hidden = false; summary.textContent = `Konflikte und Hinweise (${payload.assessment.findings.length})`; renderFindings(); renderSettings(); optimizer?.synchronize(payload, source);
      } catch (error) { if (token === generation && error.name !== "AbortError") status.textContent = "Prüfung nicht verfügbar: " + error.message; }
      finally { if (token === generation) lock(false); }
    }
    form.addEventListener("submit", async event => {
      event.preventDefault(); if (busy || !source || !result?.canConfigure) return;
      const token = ++generation, context = source.context;
      const configuration = { weeklyToleranceMinutes: Number(tolerance.value), requiredPositions: [...rows.children].map(row => ({ positionId: row.querySelector("select").value, count: Number(row.querySelector("input").value) })),
        keyPersonNumbers: [...people.querySelectorAll("input:checked")].map(item => item.value) };
      lock(true); settingsStatus.textContent = "Prüfeinstellungen werden gespeichert …";
      try {
        await api("/api/settings/planning-assistant", { method: "PUT", body: JSON.stringify({ locationId: context.locationId, departmentId: context.departmentId, week: source.weekStart, revision: dirty ? draftRevision : result.configuration.revision, configuration }) });
        if (token !== generation) return;
        dirty = false; draftRevision = null;
        await load(); if (source?.context === context && result) settingsStatus.textContent = "Prüfeinstellungen gespeichert und Plan erneut geprüft.";
      } catch (error) { if (token === generation) { settingsStatus.textContent = error.message; lock(false); } }
    });
    form.addEventListener("input", markDirty); form.addEventListener("change", markDirty);
    reloadSettings.addEventListener("click", () => { dirty = false; draftRevision = null; load(); });
    refresh.addEventListener("click", load); addPosition.addEventListener("click", () => { if (!busy && result && rows.children.length < 20) { markDirty(); positionRow(); } });
    filter.addEventListener("change", () => { limit = 40; renderFindings(); }); more.addEventListener("click", () => { limit += 40; renderFindings(); });
    return { reset, synchronize({ data, session, allowed }) {
      if (!allowed || !data?.context?.locationId) { reset(); return; }
      if (session !== actor) { reset(); actor = session; } host.hidden = false;
      if (source === data) return;
      if (source && JSON.stringify([source.weekStart, source.context]) !== JSON.stringify([data.weekStart, data.context])) { dirty = false; draftRevision = null; }
      generation++; controller?.abort(); source = data; clearResult(); lock(false);
      if (data.enrichmentPending) { status.textContent = "Arbeitsregelprüfung wird geladen …"; return; }
      load();
    } };
  }
  root.GpPlanningAssistant = Object.freeze({ mount });
})(window);
