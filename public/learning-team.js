(function () {
  "use strict";
  const base = "/api/portal/v1/personnel-learning";
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]));
  const labels = {fulfilled:"Erfüllt", dueSoon:"Bald fällig", expired:"Abgelaufen", missing:"Fehlt", lowerLevel:"Stufe fehlt", otherVersion:"Andere Fassung", notPassed:"Nachschulung", inProgress:"In Durchführung", notApplicable:"Nicht erforderlich"};
  function mount(host, {api}) {
    let options, current, generation = 0, offset = 0, dialog = null;
    function clear() { generation++; dialog?.close(); dialog?.remove(); dialog = null; options = current = null; host.replaceChildren(); }
    const query = () => { const p = new URLSearchParams(new FormData(host.querySelector("form[data-filters]"))); p.set("offset", String(offset)); return p; };
    const choices = (rows, empty) => `<option value="">${empty}</option>` + rows.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("");
    function error(message) { const target = host.querySelector("[data-error]"); if (target) target.textContent = message; }
    async function results() {
      const ticket = ++generation, queryString = query().toString();
      error(""); host.querySelector("[data-result]").setAttribute("aria-busy", "true");
      try {
        const value = await api(base + "/team?" + queryString); if (ticket !== generation) return;
        current = value;
        const s = value.summary, start = value.people.length ? value.offset + 1 : 0;
        host.querySelector("[data-result]").innerHTML = `<p aria-live="polite"><strong>${s.percent === null ? "Keine Anforderungen" : s.percent + " % erfüllt"}</strong> · Diese Seite: ${s.fulfilled} von ${s.required} Anforderungen erfüllt · ${s.open} offen · ${s.dueSoon} bald fällig</p>
          <div class="learning-team-table" tabindex="0" role="region" aria-label="Soll und Ist im Team, bei Bedarf seitlich scrollen"><table><thead><tr><th scope="col">Mitarbeiter/in</th>${value.rules.map(r => `<th scope="col">${esc(r.payload.title)}<small>${r.payload.type === "skill" ? "Soll: Stufe " + r.payload.minLevel : "Pflichtschulung"} · Fassung ${r.payload.moduleVersionNumber}</small></th>`).join("")}</tr></thead><tbody>${value.people.map(p => `<tr><th scope="row">${esc(p.fullName)}<small>${esc(p.employeeNumber)} · ${esc(p.locationName)}<br>${esc(p.positionName)}${p.roleName ? " · " + esc(p.roleName) : ""}</small></th>${p.cells.map(c => `<td><span class="learning-team-status" data-status="${esc(c.status)}">${esc(labels[c.status])}</span>${c.actual != null ? `<small>Ist: Stufe ${c.actual}</small>` : ""}${c.until ? `<small>Gültig bis ${esc(c.until)}</small>` : ""}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${value.rules.length + 1}">Keine Personen im gewählten Bereich.</td></tr>`}</tbody></table></div>
          ${!value.rules.length ? "<p>Für diese Ansicht sind noch keine aktiven Anforderungen hinterlegt.</p>" : ""}
          <div class="learning-team-pagination"><button type="button" data-prev ${value.offset === 0 ? "disabled" : ""}>Zurück</button><span>${start}–${value.offset + value.people.length} von ${value.total} Personen</span><button type="button" data-next ${value.offset + value.pageSize >= value.total ? "disabled" : ""}>Weiter</button><a href="${base}/team.csv?${esc(queryString)}" download>Diese Seite als CSV</a></div>`;
      } catch (e) { if (ticket === generation) error(e.message); }
      finally { if (ticket === generation) host.querySelector("[data-result]")?.removeAttribute("aria-busy"); }
    }
    function ruleList() {
      host.querySelector("[data-rules]").innerHTML = options.rules.map(r => `<div class="learning-team-rule"><span><strong>${esc(r.payload.title)}</strong> · ${r.payload.active ? "Aktiv" : "Archiviert"}<small>${esc(r.payload.scope.label || r.payload.scope.departmentName || r.payload.scope.locationName || "Gesamte Organisation")} · ${r.payload.type === "skill" ? "Soll-Stufe " + r.payload.minLevel : "Pflichtschulung"} · Fassung ${r.payload.moduleVersionNumber}${r.payload.validMonths ? " · " + r.payload.validMonths + " Monate gültig" : " · ohne Ablauf"}</small></span>${r.canManage ? `<button type="button" data-edit="${esc(r.id)}">Bearbeiten</button>` : ""}</div>`).join("") || "<p>Noch keine Anforderungen festgelegt.</p>";
    }
    async function edit(id) {
      const old = options.rules.find(r => r.id === id), value = old?.payload;
      dialog?.remove(); dialog = document.createElement("dialog"); dialog.className = "learning-team-dialog";
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
        form.elements.moduleId.innerHTML = options.modules.filter(m => m.type === form.elements.type.value).map(m => `<option value="${esc(m.id)}">${esc(m.title)} · Fassung ${m.version}</option>`).join("");
        if (value && !options.modules.some(m => m.id === value.moduleId)) form.elements.moduleId.add(new Option("Bisherige Fassung (nur archivieren)", value.moduleId));
        if (value && [...form.elements.moduleId.options].some(o=>o.value===value.moduleId)) form.elements.moduleId.value = value.moduleId;
        dialog.querySelector("[data-level]").hidden = form.elements.type.value !== "skill";
      }
      function scopesForModule() {
        const module = options.modules.find(m=>m.id===form.elements.moduleId.value), previousScope=form.elements.scope.value;
        const compatible=s=>!module || module.scope.type==="organization" || module.scope.locationId===s.locationId && (module.scope.type==="location" || s.type==="department" && Number(module.scope.departmentId)===Number(s.departmentId));
        form.elements.scope.innerHTML=options.scopes.map((s,i)=>({s,i})).filter(({s})=>compatible(s)).map(({s,i})=>`<option value="${i}">${esc(s.label)}</option>`).join("");
        if([...form.elements.scope.options].some(o=>o.value===previousScope))form.elements.scope.value=previousScope;
        dialog.querySelector('[data-module-caption]').textContent=module?`${module.title} · Fassung ${module.version}`:'Bisherige Fassung bleibt beim Archivieren erhalten.';
      }
      modules(); scopesForModule(); form.elements.type.addEventListener("change", ()=>{modules();scopesForModule();});
      form.elements.moduleId.addEventListener("change",scopesForModule);
      if (value) form.elements.scope.value = String(options.scopes.findIndex(s => s.type === value.scope.type && String(s.locationId || "") === String(value.scope.locationId || "") && Number(s.departmentId || 0) === Number(value.scope.departmentId || 0)));
      dialog.querySelector("[data-close]").onclick = () => dialog.close();
      form.onsubmit = async event => {
        event.preventDefault(); const ticket = generation, target = dialog; const button = form.querySelector('[type="submit"]'); button.disabled = true;
        try {
          const body = Object.fromEntries(new FormData(form)); body.scope = options.scopes[Number(body.scope)]; body.active = body.active === "true"; body.expectedReceipt = old?.receiptSha256 || "";
          await api(base + "/requirements" + (old ? "/" + encodeURIComponent(old.id) : ""), {method:old ? "PUT" : "POST", body:JSON.stringify(body)});
          if (ticket !== generation) return;
          target.close(); const loaded = await api(base + "/team/options"); if (ticket !== generation) return; options = loaded; ruleList(); await results();
        } catch (e) { if (ticket === generation) target.querySelector("[data-dialog-error]").textContent = e.message; }
        finally { button.disabled = false; }
      };
      dialog.showModal();
    }
    async function load() {
      const ticket = ++generation;
      try {
        const loaded = await api(base + "/team/options"); if (ticket !== generation) return; options = loaded;
        host.innerHTML = `<h3>Team · Soll und Ist</h3><p>Dokumentierte Kompetenzen und Pflichtschulungen. Jede Anforderung gilt für ihre festgelegte Fassung.</p><form data-filters class="learning-team-filters">
          <label>Name oder Personalnummer<input name="search" maxlength="150" type="search"></label>
          <label>Filiale<select name="locationId">${choices(options.locations, "Alle freigegebenen Filialen")}</select></label>
          <label>Position<select name="positionId">${choices(options.positions, "Alle Positionen")}</select></label>
          <label>Rolle<select name="roleId">${choices(options.roles, "Alle Rollen")}</select></label>
          <label>Ansicht<select name="kind"><option value="">Alle Anforderungen</option><option value="skill">Kompetenzen</option><option value="training">Pflichtschulungen</option></select></label>
          <label>Personen pro Seite<select name="pageSize"><option>10</option><option selected>25</option><option>50</option></select></label><button type="submit">Anzeigen</button></form>
          <p role="alert" data-error></p><div data-result></div><details class="learning-team-requirements"><summary><strong>Anforderungen verwalten</strong></summary>${options.canManage ? '<button type="button" data-new>Anforderung festlegen</button>' : ""}<div data-rules></div></details>`;
        host.querySelector("[data-filters]").onsubmit = event => { event.preventDefault(); offset = 0; results(); };
        offset = 0; ruleList(); await results();
      } catch (e) { if (ticket === generation) host.textContent = e.message; }
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
