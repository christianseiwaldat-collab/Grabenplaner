(function () {
  "use strict";
  const base = "/api/portal/v1/personnel-learning";
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]));
  const labels = {fulfilled:"Erfüllt", dueSoon:"Bald fällig", expired:"Abgelaufen", missing:"Fehlt", lowerLevel:"Stufe fehlt", otherVersion:"Andere Fassung", notPassed:"Nachschulung", inProgress:"In Durchführung", notApplicable:"Nicht erforderlich"};
  function mount(host, {api}) {
    let options, current, generation = 0, optionsGeneration = 0, resultGeneration = 0, offset = 0, dialog = null, editingId = null;
    function clear() { generation++; optionsGeneration++; resultGeneration++; dialog?.close(); dialog?.remove(); dialog = null; editingId = null; offset = 0; options = current = null; host.replaceChildren(); }
    const query = () => { const p = new URLSearchParams(new FormData(host.querySelector("form[data-filters]"))); p.set("offset", String(offset)); return p; };
    const choices = (rows, empty) => `<option value="">${empty}</option>` + rows.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("");
    function error(message) { const target = host.querySelector("[data-error]"); if (target) target.textContent = message; }
    async function results() {
      const ticket = ++resultGeneration, owner = generation, context = globalThis.GpWindow?.captureContext(document), queryString = query().toString();
      const valid = () => ticket === resultGeneration && owner === generation && (!context || globalThis.GpWindow.currentContext(context));
      error(""); host.querySelector("[data-result]").setAttribute("aria-busy", "true");
      try {
        const value = await api(base + "/team?" + queryString); if (!valid()) return;
        current = value;
        const s = value.summary, start = value.people.length ? value.offset + 1 : 0;
        const cellMarkup = c => `<span class="learning-team-status" data-status="${esc(c.status)}">${esc(labels[c.status])}</span>${c.actual != null ? `<small>Ist: Stufe ${esc(c.actual)}</small>` : ""}${c.until ? `<small>Gültig bis ${esc(c.until)}</small>` : ""}`;
        host.querySelector("[data-result]").innerHTML = `<div class="learning-team-page-summary" aria-live="polite"><strong>Diese Seite · ${s.percent === null ? "Keine Anforderungen" : s.percent + " % erfüllt"}</strong><p>Auswertung der ${value.people.length} angezeigten Personen; ${s.required} Anforderungen insgesamt auf dieser Seite.</p><div class="learning-team-metrics">${[["Erfüllt",s.fulfilled],["Anforderungen",s.required],["Offen",s.open],["Bald fällig",s.dueSoon]].map(([label,count])=>`<article><span>${label}</span><strong>${count}</strong></article>`).join("")}</div></div>
          <div class="learning-team-table" tabindex="0" role="region" aria-label="Soll und Ist im Team, bei Bedarf seitlich scrollen"><table><thead><tr><th scope="col">Mitarbeiter/in</th>${value.rules.map(r => `<th scope="col">${esc(r.payload.title)}<small>${r.payload.type === "skill" ? "Soll: Stufe " + r.payload.minLevel : "Pflichtschulung"} · Fassung ${r.payload.moduleVersionNumber}</small></th>`).join("")}</tr></thead><tbody>${value.people.map(p => `<tr><th scope="row">${esc(p.fullName)}<small>${esc(p.employeeNumber)} · ${esc(p.locationName)}<br>${esc(p.positionName)}${p.roleName ? " · " + esc(p.roleName) : ""}</small></th>${p.cells.map(c => `<td>${cellMarkup(c)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${value.rules.length + 1}">Keine Personen im gewählten Bereich.</td></tr>`}</tbody></table></div>
          <div class="learning-team-people" aria-label="Soll und Ist je Person">${value.people.map(p=>`<article class="learning-team-person"><header><h4>${esc(p.fullName)}</h4><small>${esc(p.employeeNumber)} · ${esc(p.locationName)}</small><small>${esc(p.positionName)}${p.roleName ? " · "+esc(p.roleName):""}</small></header><dl>${p.cells.map((c,i)=>`<div><dt>${esc(value.rules[i]?.payload.title)}<small>${value.rules[i]?.payload.type === "skill" ? "Soll: Stufe "+value.rules[i]?.payload.minLevel : "Pflichtschulung"} · Fassung ${value.rules[i]?.payload.moduleVersionNumber}</small></dt><dd>${cellMarkup(c)}</dd></div>`).join("")}</dl></article>`).join("") || "<p>Keine Personen im gewählten Bereich.</p>"}</div>
          ${!value.rules.length ? "<p>Für diese Ansicht sind noch keine aktiven Anforderungen hinterlegt.</p>" : ""}
          <div class="learning-team-pagination"><button type="button" data-prev ${value.offset === 0 ? "disabled" : ""}>Zurück</button><span>${start}–${value.offset + value.people.length} von ${value.total} Personen</span><button type="button" data-next ${value.offset + value.pageSize >= value.total ? "disabled" : ""}>Weiter</button><a href="${base}/team.csv?${esc(queryString)}" download>Diese Seite als CSV</a></div>`;
      } catch (e) { if (valid()) error(e.message); }
      finally { if (valid()) host.querySelector("[data-result]")?.removeAttribute("aria-busy"); }
    }
    function ruleList() {
      host.querySelector("[data-rules]").innerHTML = options.rules.map(r => `<div class="learning-team-rule"><span><strong>${esc(r.payload.title)}</strong> · ${r.payload.active ? "Aktiv" : "Archiviert"}<small>${esc(r.payload.scope.label || r.payload.scope.departmentName || r.payload.scope.locationName || "Gesamte Organisation")} · ${r.payload.type === "skill" ? "Soll-Stufe " + r.payload.minLevel : "Pflichtschulung"} · Fassung ${r.payload.moduleVersionNumber}${r.payload.validMonths ? " · " + r.payload.validMonths + " Monate gültig" : " · ohne Ablauf"}</small></span>${r.canManage ? `<button type="button" data-edit="${esc(r.id)}">Bearbeiten</button>` : ""}</div>`).join("") || "<p>Noch keine Anforderungen festgelegt.</p>";
    }
    async function edit(id) {
      const old = options.rules.find(r => r.id === id), value = old?.payload;
      if (!options.canManage || id && !old?.canManage) return;
      // An open draft keeps the scope mapping and revision it was started with.
      // A refreshed options list must never silently rebase an unsaved requirement.
      const editorOptions = options;
      editingId = id || "";
      dialog?.remove(); dialog = document.createElement("dialog"); dialog.className = "learning-team-dialog";
      dialog.dataset.gpWindowMode = "workspace";dialog.dataset.gpWindowId = "learning-team-requirement";
      dialog.setAttribute("aria-labelledby", "learningTeamRuleTitle");
      dialog.innerHTML = `<form><h3 id="learningTeamRuleTitle">${old ? "Anforderung bearbeiten" : "Anforderung festlegen"}</h3><div class="learning-team-fields">
        <label>Titel<input name="title" required minlength="3" maxlength="160" value="${esc(value?.title)}"></label>
        <label>Art<select name="type"><option value="skill">Soll-Kompetenz</option><option value="training">Pflichtschulung</option></select></label>
        <label>Veröffentlichte Fassung<select name="moduleId" required></select><small data-module-caption></small></label>
        <label>Geltungsbereich<select name="scope" required>${options.scopes.map((s, i) => `<option value="${i}">${esc(s.label)}</option>`).join("")}</select></label>
        <label>Position<select name="positionId">${choices(options.positions, "Alle Positionen")}</select></label>
        <label>Rolle<select name="roleId">${choices(options.roles, "Alle Rollen")}</select></label>
        <label data-level>Soll-Stufe<input name="minLevel" type="number" min="1" max="10" value="${value?.minLevel || 1}"></label>
        <label>Gültigkeit ab Nachweis (Monate)<input name="validMonths" type="number" min="0" max="120" value="${value?.validMonths || 0}"><small>0 = ohne Ablauf</small></label>
        <label>Status<select name="active"><option value="true">Aktiv</option><option value="false">Archiviert</option></select></label>
        </div><p>Position und Rolle gelten gemeinsam. Speichern bindet die aktuell veröffentlichte Fassung. Eine neue Fassung übernimmt frühere Abschlüsse nicht automatisch. Archivieren bewahrt die bisherige Zuordnung.</p>
        <p role="alert" data-dialog-error></p><div class="learning-team-pagination"><button type="button" data-close>Abbrechen</button><button type="submit">Speichern</button></div></form>`;
      document.body.append(dialog); const form = dialog.querySelector("form");
      for (const name of ["type", "positionId", "roleId", "active"]) if (value) form.elements[name].value = String(value[name]);
      function modules() {
        form.elements.moduleId.innerHTML = editorOptions.modules.filter(m => m.type === form.elements.type.value).map(m => `<option value="${esc(m.id)}">${esc(m.title)} · Fassung ${m.version}</option>`).join("");
        if (value && !editorOptions.modules.some(m => m.id === value.moduleId)) form.elements.moduleId.add(new Option("Bisherige Fassung (nur archivieren)", value.moduleId));
        if (value && [...form.elements.moduleId.options].some(o=>o.value===value.moduleId)) form.elements.moduleId.value = value.moduleId;
        dialog.querySelector("[data-level]").hidden = form.elements.type.value !== "skill";
      }
      function scopesForModule() {
        const module = editorOptions.modules.find(m=>m.id===form.elements.moduleId.value), previousScope=form.elements.scope.value;
        const compatible=s=>!module || module.scope.type==="organization" || module.scope.locationId===s.locationId && (module.scope.type==="location" || s.type==="department" && Number(module.scope.departmentId)===Number(s.departmentId));
        form.elements.scope.innerHTML=editorOptions.scopes.map((s,i)=>({s,i})).filter(({s})=>compatible(s)).map(({s,i})=>`<option value="${i}">${esc(s.label)}</option>`).join("");
        if([...form.elements.scope.options].some(o=>o.value===previousScope))form.elements.scope.value=previousScope;
        dialog.querySelector('[data-module-caption]').textContent=module?`${module.title} · Fassung ${module.version}`:'Bisherige Fassung bleibt beim Archivieren erhalten.';
      }
      modules(); scopesForModule(); form.elements.type.addEventListener("change", ()=>{modules();scopesForModule();});
      form.elements.moduleId.addEventListener("change",scopesForModule);
      if (value) form.elements.scope.value = String(editorOptions.scopes.findIndex(s => s.type === value.scope.type && String(s.locationId || "") === String(value.scope.locationId || "") && Number(s.departmentId || 0) === Number(value.scope.departmentId || 0)));
      dialog.querySelector("[data-close]").onclick = () => dialog.close();
      form.onsubmit = async event => {
        event.preventDefault(); const ticket = generation, target = dialog;
        const windowTicket = globalThis.GpWindow?.capture(target), contextTicket = globalThis.GpWindow?.captureContext(document);
        const currentContext = () => ticket === generation && target === dialog && options?.canManage
          && (!contextTicket || globalThis.GpWindow.currentContext(contextTicket));
        const currentEditor = () => currentContext() && target.open && (!windowTicket || globalThis.GpWindow.current(windowTicket));
        if (!currentEditor()) return;
        const button = form.querySelector('[type="submit"]'); button.disabled = true;
        // Keep the submitted draft stable while its revision is being stored.
        const fields = [...form.querySelectorAll('input,select,textarea')];
        const restoreFields = fields.map(field => field.disabled);
        try {
          const body = Object.fromEntries(new FormData(form)); body.scope = editorOptions.scopes[Number(body.scope)]; body.active = body.active === "true"; body.expectedReceipt = old?.receiptSha256 || "";
          fields.forEach(field => { field.disabled = true; });
          await api(base + "/requirements" + (old ? "/" + encodeURIComponent(old.id) : ""), {method:old ? "PUT" : "POST", body:JSON.stringify(body)});
          if (!currentEditor()) return;
          target.close(); editingId = null; await load();
        } catch (e) { if (currentEditor()) target.querySelector("[data-dialog-error]").textContent = e.message; }
        finally { if (target === dialog) { button.disabled = false; fields.forEach((field,i)=>{field.disabled=restoreFields[i];}); } }
      };
      globalThis.GpWindow?.prepare(dialog);dialog.showModal();
    }
    async function load() {
      const ticket = ++optionsGeneration, owner = generation, context = globalThis.GpWindow?.captureContext(document);
      const valid = () => ticket === optionsGeneration && owner === generation && (!context || globalThis.GpWindow.currentContext(context));
      try {
        const loaded = await api(base + "/team/options"); if (!valid()) return; options = loaded;
        const existingFilters = host.querySelector("form[data-filters]");
        if (!existingFilters) host.innerHTML = `<h3>Kompetenzmatrix</h3><p>Vergleiche die dokumentierten Fähigkeiten und Pflichtschulungen mit den festgelegten Anforderungen. Jede Anforderung gilt für ihre gespeicherte Fassung.</p><form data-filters class="learning-team-filters">
          <label>Name oder Personalnummer<input name="search" maxlength="150" type="search"></label>
          <label>Filiale<select name="locationId">${choices(options.locations, "Alle freigegebenen Filialen")}</select></label>
          <label>Position<select name="positionId">${choices(options.positions, "Alle Positionen")}</select></label>
          <label>Rolle<select name="roleId">${choices(options.roles, "Alle Rollen")}</select></label>
          <label>Ansicht<select name="kind"><option value="">Alle Anforderungen</option><option value="skill">Kompetenzen</option><option value="training">Pflichtschulungen</option></select></label>
          <label>Personen pro Seite<select name="pageSize"><option>10</option><option selected>25</option><option>50</option></select></label><button type="submit">Anzeigen</button></form>
          <p role="alert" data-error></p><div data-result></div><details class="learning-team-requirements"><summary><strong>Anforderungen verwalten</strong></summary><span data-create-rule></span><div data-rules></div></details>`;
        const filters = host.querySelector("form[data-filters]");
        if (existingFilters) for (const [name, rows, label] of [["locationId", options.locations, "Alle freigegebenen Filialen"], ["positionId", options.positions, "Alle Positionen"], ["roleId", options.roles, "Alle Rollen"]]) {
          const field = filters.elements[name], previous = field.value;
          field.innerHTML = choices(rows, label);
          field.value = rows.some(row => String(row.id) === previous) ? previous : "";
          if (field.value !== previous) offset = 0;
        }
        host.querySelector("[data-create-rule]").innerHTML = options.canManage ? '<button type="button" data-new>Anforderung festlegen</button>' : "";
        if (dialog?.open && (!options.canManage || editingId && !options.rules.some(rule => rule.id === editingId && rule.canManage))) {
          dialog.close(); dialog.remove(); dialog = null; editingId = null;
        }
        host.querySelector("[data-filters]").onsubmit = event => { event.preventDefault(); offset = 0; results(); };
        ruleList(); await results();
      } catch (e) { if (valid()) { if (host.querySelector("form[data-filters]")) error(e.message); else host.textContent = e.message; } }
    }
    host.addEventListener("click", event => {
      const button = event.target.closest("button"); if (!button || button.disabled) return;
      if (button.hasAttribute("data-prev")) { offset = Math.max(0, offset - current.pageSize); results(); }
      if (button.hasAttribute("data-next")) { offset += current.pageSize; results(); }
      if (button.hasAttribute("data-new")) edit();
      if (button.dataset.edit) edit(button.dataset.edit);
    });
    return {load, clear};
  }
  globalThis.GrabenplanerLearningTeam = {mount};
})();
