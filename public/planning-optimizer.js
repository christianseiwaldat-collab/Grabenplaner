(function (root) {
  "use strict";
  const names = { stable: "Wenige Änderungen", balanced: "Ausgewogene Planung", wishes: "Wünsche bevorzugen" };
  function mount(host, { api, onApplied = async () => {} }) {
    const doc = host.ownerDocument, node = (tag, text, className) => { const e = doc.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; };
    let generation = 0, context = null, result = null, busy = false, controller = null;
    const panel = node("details"), summary = node("summary", "Planvorschläge und Ersatzpersonal"), status = node("p"), form = node("form"), modeLabel = node("label"), mode = node("select"), personLabel = node("label"), person = node("select");
    status.setAttribute("role", "status"); mode.setAttribute("aria-label", "Art des Planvorschlags"); person.setAttribute("aria-label", "Ausfallende Person");
    for (const [value, label] of [["optimize", "Wochenplan optimieren"], ["replacement", "Ersatzperson finden"]]) { const option = node("option", label); option.value = value; mode.append(option); }
    modeLabel.append(node("span", "Aufgabe"), mode); personLabel.append(node("span", "Ausfallende Person"), person); personLabel.hidden = true;
    const calculate = node("button", "Vorschläge berechnen", "primary-button"), cancel = node("button", "Vorschläge verwerfen", "secondary-button"); calculate.type = "submit"; cancel.type = "button"; cancel.hidden = true;
    const controls = node("div", undefined, "planning-assistant-actions"); controls.append(calculate, cancel);
    form.append(modeLabel, personLabel, controls);
    const scenarios = node("div", undefined, "planning-optimizer-scenarios");
    panel.append(summary, node("p", "Die Berechnung läuft lokal. Vergleiche Dienste, Wünsche und Wochenstunden. Ein Vorschlag wird erst durch deine ausdrückliche Bestätigung übernommen."), form, status, scenarios);
    host.replaceChildren(panel); host.hidden = true;
    function lock(value, applying = false) {
      busy = value; for (const e of host.querySelectorAll("input,select,button")) e.disabled = value;
      for (const card of scenarios.querySelectorAll("article")) {
        const check = card.querySelector('input[type="checkbox"]'), apply = card.querySelector("button");
        if (apply) apply.disabled = value || !check?.checked;
      }
      cancel.disabled = applying;
    }
    function clear() { generation++; controller?.abort(); result = null; scenarios.replaceChildren(); cancel.hidden = true; status.textContent = ""; lock(false); }
    function reset() { clear(); context = null; host.hidden = true; }
    function render() {
      scenarios.replaceChildren();
      for (const scenario of result.scenarios) {
        const card = node("article", undefined, "planning-optimizer-scenario"), stats = scenario.metrics;
        card.append(node("h3", names[scenario.profile]), node("p", `${scenario.changes.length} Änderungen · ${stats.targetDeviationMinutes} Minuten Abweichung vom Wochensoll · Wunsch-Abweichungen: ${stats.preferencePenalty} · Samstagsdifferenz: ${stats.saturdaySpread}`));
        card.append(node("p", scenario.status === "OPTIMAL" ? "Für diese Auswahl und Gewichtung optimal berechnet." : "Gültiger Vorschlag innerhalb des Zeitlimits; ein besseres Ergebnis kann existieren."));
        const changes = node("ul");
        for (const change of scenario.changes) changes.append(node("li", `${change.kind === "remove" ? "Entfällt" : "Neu"}: ${change.employeeName} · ${change.date} · ${change.startTime}–${change.endTime}${change.departmentId ? ` · Abteilung ${change.departmentId}` : ""}`));
        if (!scenario.changes.length) changes.append(node("li", "Keine Dienständerungen erforderlich."));
        card.append(changes);
        const complete = node("details"), full = node("ul"); complete.append(node("summary", "Vollständigen Vorschlag anzeigen"), full);
        for (const shift of scenario.shifts) full.append(node("li", `${shift.date} · ${shift.employeeName} · ${shift.startTime}–${shift.endTime}`));
        card.append(complete);
        if (scenario.review.findings.length) {
          const review = node("details"), messages = node("ul"); review.append(node("summary", `GP-Prüfung: ${scenario.review.findings.length} Hinweise`), messages);
          for (const finding of scenario.review.findings) messages.append(node("li", `${finding.title}: ${finding.message}`));
          card.append(review);
        }
        const confirmation = node("label", undefined, "planning-optimizer-confirmation"), check = node("input"); check.type = "checkbox";
        confirmation.append(check, node("span", "Ich habe die Änderungen und GP-Prüfhinweise geprüft und bestätige die Übernahme dieses Vorschlags."));
        const apply = node("button", "Diesen Vorschlag verbindlich übernehmen", "primary-button"); apply.type = "button"; apply.disabled = true;
        check.addEventListener("change", () => { apply.disabled = busy || !check.checked; });
        apply.addEventListener("click", async () => {
          if (busy || !check.checked || !result || !context) return;
          const token = ++generation, proposal = result; lock(true, true); status.textContent = "Aktuelle GP-Prüfung und Übernahme laufen …";
          try {
            const response = await api("/api/schedule/assistant/apply", { method: "POST", body: JSON.stringify({ proposalId: proposal.id, scenarioId: scenario.id, confirmationToken: proposal.confirmationToken, confirmed: true }) });
            if (token !== generation) return;
            clear(); status.textContent = `Vorschlag übernommen: ${response.changedShifts} Änderungen.`;
            await onApplied();
          } catch (error) {
            if (token !== generation) return;
            lock(false); check.checked = false; apply.disabled = true; status.textContent = error.message;
            if (["OPTIMIZER_PLAN_CHANGED", "OPTIMIZER_PROPOSAL_EXPIRED", "OPTIMIZER_REVALIDATION_FAILED"].includes(error.code)) { result = null; scenarios.replaceChildren(); }
          }
        });
        if (scenario.changes.length) card.append(confirmation, apply);
        scenarios.append(card);
      }
    }
    form.addEventListener("submit", async event => {
      event.preventDefault(); if (busy || !context) return;
      clear(); const token = ++generation, current = context; controller = new AbortController(); lock(true); cancel.hidden = false; status.textContent = "Lokale Planvorschläge werden berechnet und durch den GP geprüft …";
      try {
        const payload = await api("/api/schedule/assistant/proposals", { method: "POST", signal: controller.signal,
          body: JSON.stringify({ week: current.week, locationId: current.locationId, departmentId: current.departmentId, mode: mode.value, absentEmployeeNumber: mode.value === "replacement" ? person.value : "" }) });
        if (token !== generation || context !== current) return;
        result = payload; lock(false); render();
        status.textContent = payload.scenarios.length ? `${payload.scenarios.length} Vorschläge. Der gespeicherte Dienstplan ist unverändert.`
          : "Kein durch den GP bestätigter Vorschlag gefunden. Besetzung, Verfügbarkeit und Regeln prüfen.";
        if (!payload.scenarios.length) for (const reason of [...new Set(payload.discarded.flatMap(item => item.reasons || []))].slice(0, 8)) scenarios.append(node("p", reason));
      } catch (error) { if (token === generation && error.name !== "AbortError") { lock(false); status.textContent = "Berechnung nicht verfügbar: " + error.message; } }
    });
    mode.addEventListener("change", () => { clear(); personLabel.hidden = mode.value !== "replacement"; }); person.addEventListener("change", clear); cancel.addEventListener("click", clear);
    return { reset, synchronize(report, data) {
      clear();
      if (!report.canOptimize) { context = null; host.hidden = !report.optimizer; status.textContent = report.optimizer?.message || "Für Planvorschläge fehlen die erforderlichen Rechte."; form.hidden = true; return; }
      host.hidden = false; form.hidden = false; context = { week: data.weekStart, locationId: data.context.locationId, departmentId: data.context.departmentId || null };
      person.replaceChildren(); for (const employee of report.choices.employees) { const option = node("option", employee.label); option.value = employee.id; person.append(option); }
      status.textContent = "Der lokale Planungsdienst ist bereit. Qualifikationen werden aus den bestehenden Lernanforderungen geprüft.";
    } };
  }
  root.GpPlanningOptimizer = Object.freeze({ mount });
})(window);
