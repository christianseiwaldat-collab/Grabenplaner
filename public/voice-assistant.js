(function (global) {
  "use strict";
  const BASE = "/api/portal/v1/me/assistant";
  function mount({ api, getSession, onSubmitted = () => {} }) {
    const byId = id => document.getElementById(id);
    const el = Object.fromEntries(["voiceAssistantLaunch", "voiceAssistantPanel", "voiceAssistantStatus", "voiceAssistantMic",
      "voiceAssistantEnd", "voiceAssistantLog", "voiceAssistantForm", "voiceAssistantInput", "voiceAssistantSend",
      "voiceAssistantDraft", "voiceAssistantDraftSummary", "voiceAssistantConfirm", "voiceAssistantDiscard", "voiceAssistantAudio", "voiceAssistantScope"]
      .map(id => [id.replace("voiceAssistant", ""), byId(id)]));
    if (!el.Launch || !el.Panel) return null;
    let session = null, epoch = 0, statusEpoch = 0, settings = null, conversationId = "", transport = null,
      draft = null, busy = false, inputVersion = 0, controller = null, remainingTimer = null;
    function status(text) { el.Status.textContent = text; }
    function controls() {
      el.Mic.disabled = busy || Boolean(transport) || !settings?.configured;
      el.End.disabled = !conversationId && !transport && !busy;
      el.Send.disabled = busy || !settings?.configured;
      el.Input.disabled = busy;
      el.Confirm.disabled = busy || !draft?.confirmationToken || !draft.check?.submissionAllowed;
      el.Discard.disabled = busy;
    }
    function log(role, text) {
      if (!text) return;
      const line = document.createElement("p"), label = document.createElement("strong"), content = document.createElement("span");
      label.textContent = role + ": "; content.textContent = text;
      line.append(label, content); el.Log.append(line);
      while (el.Log.childElementCount > 40) el.Log.firstElementChild.remove();
      el.Log.scrollTop = el.Log.scrollHeight;
    }
    function invalidateDraft() {
      if (draft) draft.confirmationToken = "";
      controls();
    }
    function showDraft(value) {
      draft = value || null;
      el.Draft.classList.toggle("hidden", !draft);
      el.DraftSummary.replaceChildren();
      if (draft) {
        const text = document.createElement("p");
        text.textContent = `${draft.kind === "vacation" ? "Urlaub" : "Zeitausgleich"}: ${draft.dateFrom} bis ${draft.dateTo} · ${draft.allDay ? "ganztägig" : draft.startTime + "–" + draft.endTime + " Uhr"}${Number.isFinite(draft.days) ? " · " + draft.days + " Urlaubstage" : ""}${Number.isFinite(draft.minutes) ? " · voraussichtlich " + new Intl.NumberFormat("de-AT", { maximumFractionDigits: 2 }).format(draft.minutes / 60) + " Stunden" : ""}`;
        el.DraftSummary.append(text);
        for (const warning of [draft.check?.reason, ...(draft.assumptions || []), ...(draft.warnings || [])].filter(Boolean)) {
          const paragraph = document.createElement("p"); paragraph.textContent = warning; el.DraftSummary.append(paragraph);
        }
        if (draft.workDates?.length) {
          const dates = document.createElement("details"), title = document.createElement("summary"), content = document.createElement("p");
          title.textContent = "Ermittelte Tage anzeigen"; content.textContent = draft.workDates.join(", ");
          dates.append(title, content); el.DraftSummary.append(dates);
        }
        const expiry = document.createElement("p"); expiry.textContent = "Entwurf · noch nicht eingereicht. Gültig bis " + new Intl.DateTimeFormat("de-AT", { timeZone: "Europe/Vienna", timeStyle: "short" }).format(new Date(draft.expiresAt)) + " Uhr.";
        el.DraftSummary.append(expiry);
      }
      controls();
    }
    function sendSpeech(text, delegationId = null) {
      const connection = transport;
      if (!connection?.ready || connection.stopping || connection.events.readyState !== "open") return;
      // Live append commands have a 500-token limit. A 400-byte UTF-8 bound
      // stays below it even for names containing non-Latin characters.
      // also keep GP payloads and confirmation capabilities out of the voice model.
      const words = String(text).split(/\s+/), encoder = new TextEncoder(); let chunk = "";
      function send() {
        if (chunk) connection.events.send(JSON.stringify({ type: "session.commentary.append", event_id: crypto.randomUUID(), delegation_id: delegationId, content: chunk }));
        chunk = "";
      }
      for (const word of words) {
        const candidate = chunk + (chunk ? " " : "") + word;
        if (encoder.encode(candidate).length <= 400) { chunk = candidate; continue; }
        send();
        if (encoder.encode(word).length <= 400) chunk = word;
        else for (const character of word) {
          if (encoder.encode(chunk + character).length > 400) send();
          chunk += character;
        }
      }
      send();
    }
    function cleanup(connection) {
      if (!connection) return;
      // getUserMedia can resolve after the user has already ended startup.
      connection.microphone?.getTracks().forEach(track => track.stop());
      if (connection.cleaned) return;
      connection.cleaned = true;
      clearTimeout(connection.closeTimer); clearTimeout(connection.delegationTimer); clearTimeout(connection.answerTimer); clearTimeout(connection.startTimer);
      connection.events?.close(); connection.peer?.close();
      if (transport === connection) { transport = null; el.Audio.srcObject = null; controls(); }
    }
    function stopMedia() {
      const connection = transport;
      if (!connection) return;
      connection.stopping = true;
      // Microphone capture stops immediately, including during finalization.
      connection.microphone?.getTracks().forEach(track => track.stop());
      clearTimeout(connection.delegationTimer);
      if (connection.ready && connection.events?.readyState === "open") {
        connection.events.send(JSON.stringify({ type: "session.close", event_id: crypto.randomUUID() }));
        connection.closeTimer = setTimeout(() => cleanup(connection), 4000);
      } else cleanup(connection);
    }
    function deleteConversation(id) {
      if (id) void api(`${BASE}/conversations/${encodeURIComponent(id)}`, { method: "DELETE", body: "{}" }).catch(() => {});
    }
    function end({ clear = false } = {}) {
      epoch++; inputVersion++;
      controller?.abort(); controller = null;
      clearTimeout(remainingTimer); remainingTimer = null;
      const id = conversationId; conversationId = "";
      stopMedia(); deleteConversation(id);
      busy = false; showDraft(null);
      if (clear) el.Log.replaceChildren();
      status("Gespräch beendet · Mikrofon aus"); controls();
    }
    async function ensureTextConversation() {
      if (conversationId) return;
      const generation = epoch;
      const result = await api(BASE + "/conversations", { method: "POST", body: "{}" });
      if (generation !== epoch) { deleteConversation(result.conversationId); throw new Error("Gespräch beendet."); }
      conversationId = result.conversationId;
      remainingTimer = setTimeout(() => end(), result.maxSessionSeconds * 1000);
    }
    async function processText(text, { delegationId = null, operationId = crypto.randomUUID() } = {}) {
      if (!text.trim() || busy) return;
      const generation = epoch, version = inputVersion;
      busy = true; invalidateDraft(); status("Verarbeiten"); controls();
      if (!delegationId) log("Du", text);
      try {
        await ensureTextConversation();
        const result = await api(`${BASE}/conversations/${conversationId}/messages`, {
          method: "POST", body: JSON.stringify({ text: text.trim(), operationId }),
        });
        if (generation !== epoch || version !== inputVersion) return;
        log("GP", result.text);
        if (Object.hasOwn(result, "draft")) showDraft(result.draft);
        sendSpeech(result.text, delegationId);
        status(transport?.ready ? "Zuhören" : "Bereit · Mikrofon aus");
      } catch (error) {
        if (generation !== epoch) return;
        status(error.message);
        sendSpeech("Die GP-Abfrage konnte nicht ausgeführt werden. Es wurde nichts automatisch abgesendet. Bitte die Texteingabe verwenden oder erneut fragen.", delegationId);
        if ([401, 403, 428].includes(error.status)) end({ clear: true });
      } finally { if (generation === epoch) { busy = false; controls(); } }
    }
    function scheduleDelegation(connection) {
      clearTimeout(connection.delegationTimer);
      connection.delegationTimer = setTimeout(async () => {
        if (transport !== connection || connection.stopping) return;
        if (busy) { scheduleDelegation(connection); return; }
        const item = connection.pendingDelegations.shift();
        if (!item) return;
        const fragments = connection.input.splice(0);
        const text = fragments.map(fragment => fragment.delta).join("").trim();
        if (!text) sendSpeech("Bitte wiederhole die Frage oder nutze die Texteingabe.", item.id);
        else await processText(text, { delegationId: item.id, operationId: item.operationId });
        if (connection.pendingDelegations.length) scheduleDelegation(connection);
      }, 1000);
    }
    async function startVoice() {
      if (busy || transport || !settings?.configured) return;
      if (!global.isSecureContext || !navigator.mediaDevices?.getUserMedia || !global.RTCPeerConnection) {
        status("Sprache benötigt HTTPS, Mikrofonzugriff und einen aktuellen Browser. Die Texteingabe ist verfügbar."); return;
      }
      if (conversationId) end({ clear: true });
      const generation = epoch;
      busy = true; status("Mikrofon und Verbindung vorbereiten"); controls();
      const connection = { peer: new RTCPeerConnection(), ready: false, stopping: false, input: [], pendingDelegations: [], seenDelegations: new Set(), outputNode: null };
      transport = connection;
      controller = new AbortController();
      try {
        connection.microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (generation !== epoch) { cleanup(connection); return; }
        for (const track of connection.microphone.getAudioTracks()) connection.peer.addTrack(track, connection.microphone);
        connection.peer.addEventListener("track", event => {
          if (transport !== connection || connection.stopping) return;
          el.Audio.srcObject = new MediaStream([event.track]);
          void el.Audio.play().catch(() => status("Bitte auf Wiedergabe tippen, um die Antwort zu hören."));
        });
        connection.events = connection.peer.createDataChannel("oai-events");
        connection.events.addEventListener("message", ({ data }) => {
          let event; try { event = JSON.parse(data); } catch { return; }
          if (event.type === "session.closed") { cleanup(connection); if (transport === null && generation === epoch) end(); return; }
          if (transport !== connection || connection.stopping || generation !== epoch) return;
          if (event.type === "session.started") { connection.ready = true; clearTimeout(connection.startTimer); status("Zuhören"); controls(); }
          else if (event.type === "session.input_transcript.delta" && typeof event.delta === "string") {
            inputVersion++; invalidateDraft(); connection.outputNode = null;
            if (!connection.inputNode) { const line = document.createElement("p"), title = document.createElement("strong"), text = document.createElement("span"); title.textContent = "Du: "; line.append(title, text); el.Log.append(line); connection.inputNode = text; }
            connection.inputNode.textContent = (connection.inputNode.textContent + event.delta).slice(-6000);
            connection.input.push({ delta: event.delta, start: event.start_ms, end: event.end_ms });
            if (connection.input.map(item => item.delta).join("").length > 1600) { connection.input = []; status("Die Äußerung war zu lang. Bitte kurz erneut fragen."); }
            if (connection.pendingDelegations.length) scheduleDelegation(connection);
          } else if (event.type === "session.output_transcript.delta" && typeof event.delta === "string") {
            connection.inputNode = null;
            if (!connection.outputNode) { const line = document.createElement("p"), title = document.createElement("strong"), text = document.createElement("span"); title.textContent = "Assistent: "; line.append(title, text); el.Log.append(line); connection.outputNode = text; }
            connection.outputNode.textContent = (connection.outputNode.textContent + event.delta).slice(-6000);
            while (el.Log.childElementCount > 40) el.Log.firstElementChild.remove();
            status(busy ? "Verarbeiten" : "Antworten");
            clearTimeout(connection.answerTimer); connection.answerTimer = setTimeout(() => { if (!busy && transport === connection) status("Zuhören"); }, 1500);
          } else if (event.type === "session.delegation.created" && event.delegation?.target === "client" && typeof event.delegation.id === "string") {
            const id = event.delegation.id;
            if (connection.seenDelegations.has(id)) return;
            if (connection.seenDelegations.size >= 80) { end(); return; }
            connection.seenDelegations.add(id);
            connection.pendingDelegations.push({ id, offset: event.offset_ms, operationId: crypto.randomUUID() });
            scheduleDelegation(connection);
          } else if (event.type === "error") { status("Die Sprachverbindung meldet einen Fehler. Bitte neu starten oder Text verwenden."); end(); }
        });
        connection.events.addEventListener("close", () => { if (!connection.cleaned && transport === connection) { end(); cleanup(connection); status("Sprachverbindung unterbrochen · Mikrofon aus. Bitte neu starten."); } });
        connection.peer.addEventListener("connectionstatechange", () => { if (transport === connection && ["failed", "disconnected"].includes(connection.peer.connectionState)) { end(); cleanup(connection); status("Sprachverbindung unterbrochen · Mikrofon aus. Bitte neu starten."); } });
        await connection.peer.setLocalDescription(await connection.peer.createOffer());
        if (connection.peer.iceGatheringState !== "complete") await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { connection.peer.removeEventListener("icegatheringstatechange", check); reject(new Error("Die Sprachverbindung konnte nicht vorbereitet werden.")); }, 10000);
          function check() { if (connection.peer.iceGatheringState === "complete") { clearTimeout(timer); connection.peer.removeEventListener("icegatheringstatechange", check); resolve(); } }
          connection.peer.addEventListener("icegatheringstatechange", check); check();
        });
        if (generation !== epoch) { cleanup(connection); return; }
        const result = await api(BASE + "/conversations", { method: "POST", body: JSON.stringify({ sdp: connection.peer.localDescription.sdp }), signal: controller.signal });
        if (generation !== epoch) { deleteConversation(result.conversationId); cleanup(connection); return; }
        conversationId = result.conversationId;
        remainingTimer = setTimeout(() => { end(); status("Das Gesprächslimit ist erreicht · Mikrofon aus. Du kannst erneut starten."); }, result.maxSessionSeconds * 1000);
        connection.startTimer = setTimeout(() => { end(); status("Die Sprachverbindung konnte nicht hergestellt werden. Bitte erneut starten oder Text verwenden."); }, 20000);
        await connection.peer.setRemoteDescription({ type: "answer", sdp: result.transport.sdp });
      } catch (error) {
        if (generation === epoch) { end(); status(error.name === "NotAllowedError" ? "Der Mikrofonzugriff wurde nicht erlaubt. Die Texteingabe ist verfügbar." : error.message); }
        cleanup(connection);
      } finally { if (generation === epoch) { busy = false; controls(); } }
    }
    async function synchronize() {
      const next = getSession(), generation = ++statusEpoch;
      if (session !== next) { end({ clear: true }); session = next; }
      if (!session?.authenticated || session.user?.isEmployee === false || session.user?.mustChangePassword) { el.Launch.classList.add("hidden"); el.Panel.classList.add("hidden"); return; }
      try {
        const result = await api(BASE + "/status");
        if (generation !== statusEpoch || session !== getSession()) return;
        settings = result; el.Launch.classList.toggle("hidden", !result.enabled);
        if (el.Scope) el.Scope.textContent = result.adminOnly ? "Administrator-Testbetrieb" : "Mitarbeiterportal";
        if (!result.enabled) { end({ clear: true }); el.Panel.classList.add("hidden"); }
        status(result.configured ? "Bereit · Mikrofon aus" : "Der Administrator muss den serverseitigen OpenAI-Schlüssel einrichten."); controls();
      } catch { if (generation === statusEpoch) { el.Launch.classList.add("hidden"); el.Panel.classList.add("hidden"); } }
    }
    el.Launch.addEventListener("click", () => { el.Panel.classList.toggle("hidden"); el.Launch.setAttribute("aria-expanded", String(!el.Panel.classList.contains("hidden"))); if (el.Panel.classList.contains("hidden")) end(); else { el.Panel.scrollIntoView({ block: "start" }); el.Mic.focus({ preventScroll: true }); } });
    el.Mic.addEventListener("click", () => { void startVoice(); });
    el.End.addEventListener("click", () => end());
    el.Form.addEventListener("submit", event => { event.preventDefault(); if (busy) return; const text = el.Input.value.trim(); if (!text) return; el.Input.value = ""; inputVersion++; void processText(text); });
    el.Confirm.addEventListener("click", async () => {
      if (busy || !draft?.confirmationToken || !draft.check?.submissionAllowed) return;
      const selected = draft, generation = epoch, version = inputVersion;
      busy = true; status("Antrag verbindlich einreichen"); controls();
      try {
        const result = await api(`${BASE}/conversations/${conversationId}/confirm`, { method: "POST", body: JSON.stringify({ draftId: selected.id, confirmationToken: selected.confirmationToken, confirmation: "submit" }) });
        if (generation !== epoch) return;
        showDraft(null); log("GP", result.text); sendSpeech(result.text); status("Antrag eingereicht · Freigabe offen");
        void onSubmitted();
      } catch (error) {
        if (generation !== epoch) return;
        // A lost response may follow a successful commit. Keep the same token
        // for an idempotent retry; never issue a new submit operation automatically.
        status(error.message + (error.status ? "" : " Bitte den Antragsverlauf prüfen oder die Bestätigung erneut betätigen."));
        if (error.code === "ASSISTANT_PREVIEW_CHANGED") {
          invalidateDraft();
          try {
            const updated = await api(`${BASE}/conversations/${conversationId}/draft`);
            if (generation === epoch && version === inputVersion) showDraft(updated.draft);
          } catch { /* The old capability remains invalid until a new preview is available. */ }
        }
        else if ([401, 403, 428].includes(error.status)) end({ clear: true });
        else if (version !== inputVersion || ["ASSISTANT_DRAFT_EXPIRED", "ASSISTANT_CONFIRMATION_REQUIRED"].includes(error.code)) invalidateDraft();
      } finally { if (generation === epoch) { busy = false; controls(); } }
    });
    el.Discard.addEventListener("click", async () => {
      if (busy || !conversationId) return;
      const generation = epoch;
      inputVersion++; invalidateDraft(); busy = true; controls();
      try {
        await api(`${BASE}/conversations/${conversationId}/draft`, { method: "DELETE", body: "{}" });
        if (generation === epoch) { showDraft(null); log("GP", "Der Entwurf wurde verworfen."); status("Entwurf verworfen · bereit"); }
      } catch (error) { if (generation === epoch) status(error.message); }
      finally { if (generation === epoch) { busy = false; controls(); } }
    });
    global.addEventListener("pagehide", () => end({ clear: true }));
    return { synchronize, end, reset() { statusEpoch++; end({ clear: true }); settings = null; session = null; el.Launch.classList.add("hidden"); el.Panel.classList.add("hidden"); } };
  }
  global.GpVoiceAssistant = { mount };
})(window);
