(function (root) {
  "use strict";
  function mount(host, { api, canUse, key }) {
    const doc = host.ownerDocument, node = (tag, text, className) => {
      const item = doc.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item;
    };
    let active = false, actor = "", data = null, generation = 0, page = "voice.assistants", busy = false;
    host.classList.add("voice-settings");
    const header = node("header"), title = node("h2"), description = node("p"), status = node("p", "", "voice-settings-status");
    status.setAttribute("role", "status"); header.append(title, description);
    const general = node("form"), portal = node("form"), inputs = {};
    const field = (form, name, label, type, min, max) => {
      const wrapper = node("label"), input = node("input"); input.type = type; input.name = name;
      if (min !== undefined) { input.min = String(min); input.max = String(max); input.step = "1"; }
      wrapper.append(node("span", label), input); form.append(wrapper); inputs[name] = input; return input;
    };
    field(general, "enabled", "Sprachassistenten freigeben", "checkbox");
    field(general, "maxSessionSeconds", "Maximale Gesprächsdauer im Portal (Sekunden)", "number", 60, 1800);
    field(general, "maxConversations", "Gleichzeitige GP-Gespräche", "number", 1, 50);
    general.append(node("p", "Die Dauer beendet Gespräche im regulären Portal. Kostenkontrolle erfolgt zusätzlich über das OpenAI-Projekt und die Nutzungsüberwachung."));
    const runtime = node("dl"); general.append(runtime);
    general.append(node("p", "API-Schlüssel: GRABENPLANER_OPENAI_API_KEY in der Serverkonfiguration hinterlegen. Die Umgebungsvariable GRABENPLANER_VOICE_ASSISTANT_ENABLED=0 sperrt den Betrieb unabhängig von diesen Einstellungen."));
    field(portal, "portalEnabled", "MA-Sprachassistent im Mitarbeiterportal freigeben", "checkbox");
    field(portal, "adminOnly", "Testbetrieb nur für Administratoren, IT-Admin und Developer", "checkbox");
    const pilot = field(portal, "pilotEmployeeNumbers", "Pilotzugänge (Personalnummern, durch Komma getrennt)", "text");
    pilot.maxLength = 4099; pilot.autocomplete = "off";
    portal.append(node("p", "Mit eingetragenen Personalnummern sind ausschließlich diese persönlichen Zugänge freigegeben. Leer gilt die oben gewählte Rollengruppe. Vorhandene Rechte und serverseitige Einschränkungen bleiben verbindlich."));
    const pilotStatus = node("p"); portal.append(pilotStatus);
    portal.append(node("p", "Eigene Urlaubs- und ZA-Salden, eigener Dienstplan, Antragsstatus sowie bestätigungspflichtige Entwürfe. Die vorhandenen GP-Rechte und Freigaben gelten bei jedem Aufruf."));
    portal.append(node("p", "Anträge werden erst mit der ausdrücklichen Schaltfläche im authentifizierten Portal eingereicht. Sprachaufnahmen und Gesprächsprotokolle werden im GP nicht dauerhaft gespeichert. Für Sprach- und Textbetrieb werden die erforderlichen Inhalte an OpenAI übertragen."));
    const link = node("a", "Mitarbeiterportal öffnen"); link.href = "/portal.html"; link.target = "_blank"; link.rel = "noopener"; portal.append(link);
    for (const [form, section] of [[general, "general"], [portal, "portal"]]) {
      const actions = node("div", undefined, "voice-settings-actions"), save = node("button", "Einstellungen speichern", "primary-button"), reload = node("button", "Neu laden", "secondary-button");
      save.type = "submit"; reload.type = "button"; actions.append(save, reload); form.append(actions);
      reload.addEventListener("click", () => { if (allowed() && !busy) load(); });
      form.addEventListener("submit", event => { event.preventDefault(); saveSettings(section); });
    }
    host.replaceChildren(header, status, general, portal);
    const allowed = () => active && canUse() && String(key() || "") === actor && Boolean(actor);
    function lock(value) { busy = value; for (const control of host.querySelectorAll("input,button")) control.disabled = value || !data; }
    function show() {
      host.hidden = !allowed(); general.hidden = page !== "voice.assistants"; portal.hidden = page !== "portal.assistant";
      title.textContent = page;
      description.textContent = page === "voice.assistants" ? "Grundeinstellungen für die Sprachassistenten dieser GP-Installation." : "MA-Sprachassistent · zusätzliche Bedienung der bestehenden Portal-Funktionen.";
    }
    function fill(section = "all") {
      if (!data) return;
      if (section !== "portal") { inputs.enabled.checked = data.settings.enabled; inputs.maxSessionSeconds.value = data.settings.maxSessionSeconds; inputs.maxConversations.value = data.settings.maxConversations; }
      if (section !== "general") { inputs.portalEnabled.checked = data.settings.portal.enabled; inputs.adminOnly.checked = data.settings.portal.adminOnly; inputs.pilotEmployeeNumbers.value = (data.settings.portal.pilotEmployeeNumbers || []).join(", "); }
      const serverPilot = data.runtime.environmentPilotEmployeeNumbers;
      pilotStatus.textContent = serverPilot === null ? "Die serverseitige Pilotfreigabe ist ungültig; der Assistent bleibt gesperrt."
        : serverPilot?.length ? "Serverseitig zusätzlich auf folgende Personalnummern begrenzt: " + serverPilot.join(", ") : "";
      runtime.replaceChildren();
      for (const [label, value] of [["Betrieb", data.runtime.enabled ? "Freigegeben" : "Deaktiviert"], ["API-Schlüssel", data.runtime.apiKeyConfigured ? "Serverseitig hinterlegt" : "Fehlt auf dem Server"], ["Sprachmodell", data.runtime.liveModel], ["Textverarbeitung", data.runtime.backendModel], ["Zeitzone", data.runtime.timeZone]]) runtime.append(node("dt", label), node("dd", value));
      if (data.runtime.environmentDisabled) status.textContent = "Der Betrieb ist durch die Serverkonfiguration gesperrt.";
    }
    async function load() {
      const token = ++generation; lock(true); status.textContent = "Einstellungen werden geladen …";
      try {
        const result = await api("/api/portal/v1/developer/voice-assistants");
        if (token !== generation || !allowed()) return;
        data = result; status.textContent = "Aktueller Stand geladen."; fill();
      } catch (error) { if (token === generation && allowed()) { data = null; status.textContent = error.message; } }
      finally { if (token === generation) lock(false); }
    }
    async function saveSettings(section) {
      if (!allowed() || busy || !data) return;
      const token = ++generation, settings = structuredClone(data.settings);
      if (section === "general") Object.assign(settings, { enabled: inputs.enabled.checked, maxSessionSeconds: Number(inputs.maxSessionSeconds.value), maxConversations: Number(inputs.maxConversations.value) });
      else settings.portal = { enabled: inputs.portalEnabled.checked, adminOnly: inputs.adminOnly.checked,
        pilotEmployeeNumbers: inputs.pilotEmployeeNumbers.value.trim() ? inputs.pilotEmployeeNumbers.value.split(",").map(id => id.trim()) : [] };
      lock(true); status.textContent = "Einstellungen werden gespeichert …";
      try {
        const result = await api("/api/portal/v1/developer/voice-assistants", { method: "PUT", body: JSON.stringify({ revision: data.revision, settings }) });
        if (token !== generation || !allowed()) return;
        data = result; status.textContent = "Gespeichert. Die Freigaben gelten ab dem nächsten Portal-Aufruf."; fill(section);
      } catch (error) { if (token === generation && allowed()) status.textContent = error.message; }
      finally { if (token === generation) lock(false); }
    }
    function reset() { generation++; data = null; actor = ""; active = false; busy = false; runtime.replaceChildren(); status.textContent = ""; pilotStatus.textContent = "";
      for (const input of Object.values(inputs)) { input.value = ""; input.checked = false; } show(); lock(false); }
    return { activate(value) { const next = String(key() || ""); if (!canUse() || !next) { reset(); return; }
      if (next !== actor) reset(); actor = next; page = value; active = true; show(); if (!data && !busy) load(); },
    suspend() { active = false; generation++; if (busy) data = null; busy = false; show(); lock(false); },
    synchronize() { if (!canUse() || String(key() || "") !== actor) reset(); }, reset };
  }
  root.GpVoiceAssistantSettings = Object.freeze({ mount });
})(window);
