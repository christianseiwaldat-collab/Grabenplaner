(function (root) {
  "use strict";
  const BASE = "/api/portal/v1/passkeys";
  const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
  const contextError = () => Object.assign(new Error("Der Zugang wurde geändert. Bitte die aktuelle Ansicht verwenden."), { name: "AbortError" });
  const dateText = value => value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat("de-AT", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Noch nicht verwendet";

  function mount(host) {
    const doc = host.ownerDocument, $ = selector => host.querySelector(selector), lifecycle = root.GrabenplanerSessionLifecycle;
    const registerForm = $("#passkeysRegisterForm"), fields = $("#passkeysRegisterFields"), list = $("#passkeysCredentials");
    const dialog = $("#passkeysRevokeDialog"), revokeForm = $("#passkeysRevokeForm"), status = $("#passkeysStatus");
    const refresh = $("#passkeysRefresh"), loginLink = $("#passkeysLoginLink");
    const params = new URL(root.location.href).searchParams, targets = params.getAll("accountId");
    const accountId = targets.length ? targets[0] : null;
    const validTarget = targets.length <= 1 && (accountId === null || uuid(accountId));
    const targetBody = accountId === null ? {} : { accountId };
    const state = { generation: 0, controller: null, ready: false, busy: false, enrollmentAllowed: false, credentials: [], selected: null, target: null };
    const current = generation => generation === state.generation;
    const csrf = () => {
      const value = String(doc.cookie || "").split(";").map(item => item.trim()).find(item => item.startsWith("grabenplaner_csrf="));
      if (!value) return "";
      try { return decodeURIComponent(value.slice("grabenplaner_csrf=".length)); } catch { return ""; }
    };
    function message(text, error = false, node = status) { node.textContent = text; node.dataset.error = String(error); }
    function clearSecrets() { for (const input of host.querySelectorAll('input[type="password"]')) input.value = ""; }
    function closeRevoke() {
      clearSecrets(); state.selected = null;
      if (dialog.open) dialog.close();
      message("", false, $("#passkeysRevokeStatus"));
    }
    function controls() {
      const supports = root.isSecureContext && root.PublicKeyCredential && root.navigator?.credentials?.create
        && typeof root.SimpleWebAuthnBrowser?.startRegistration === "function";
      fields.disabled = !state.ready || state.busy || !state.enrollmentAllowed || !supports || state.credentials.length >= 10;
      refresh.disabled = state.busy;
      for (const button of list.querySelectorAll("button")) button.disabled = !state.ready || state.busy;
      $("#passkeysRevoke").disabled = !state.ready || state.busy;
      $("#passkeysRevokeCancel").disabled = state.busy;
      $("#passkeysRevokePassword").disabled = !state.ready || state.busy;
      registerForm.setAttribute("aria-busy", String(state.busy));
      return Boolean(supports);
    }
    function clearView() {
      state.ready = false; state.credentials = []; list.replaceChildren();
      state.target = null; state.enrollmentAllowed = false;
      $("#passkeysTarget").textContent = "Der Zugang wird geprüft …";
      $("#passkeysOrganizationNote").hidden = true;
      $("#passkeysLabel").value = "";
      $("#passkeysCredentialsSection").hidden = true; $("#passkeysRegistrationSection").hidden = true;
      closeRevoke(); controls();
    }
    async function request(url, { method = "GET", body, signal = state.controller?.signal } = {}) {
      const generation = lifecycle?.generation;
      let options = { method, credentials: "same-origin", cache: "no-store", signal,
        headers: { Accept: "application/json", ...(!["GET", "HEAD"].includes(method) ? { "Content-Type": "application/json", "X-CSRF-Token": csrf() } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
      options = lifecycle?.credentialOptions?.(url, options) || options;
      const response = await root.fetch(url, options); lifecycle?.observeCredentialResponse?.(response);
      let value;
      try { value = await response.json(); } catch { throw new Error("Die Antwort konnte nicht gelesen werden. Bitte die Ansicht aktualisieren."); }
      if (generation !== lifecycle?.generation) throw contextError();
      if (!response.ok) throw Object.assign(new Error(typeof value?.error === "string" ? value.error : "Die Aktion konnte nicht abgeschlossen werden."), { status: response.status, code: value?.code });
      return value;
    }
    function renderCredentials(credentials) {
      list.replaceChildren();
      for (const credential of credentials) {
        const item = doc.createElement("li"), copy = doc.createElement("div"), name = doc.createElement("strong"), dates = doc.createElement("small"), button = doc.createElement("button");
        name.textContent = credential.label;
        dates.textContent = `Hinzugefügt: ${dateText(credential.createdAt)} · Zuletzt verwendet: ${dateText(credential.lastUsedAt)}`;
        button.type = "button"; button.textContent = "Widerrufen"; button.setAttribute("aria-label", `Passkey „${credential.label}“ widerrufen`);
        button.addEventListener("click", () => {
          if (!state.ready || state.busy) return;
          closeRevoke(); state.selected = credential;
          $("#passkeysRevokeDescription").textContent = `„${credential.label}“ für ${state.target.displayName} widerrufen?`;
          dialog.showModal(); $("#passkeysRevokePassword").focus();
        });
        copy.append(name, dates); item.append(copy, button); list.append(item);
      }
      $("#passkeysEmpty").hidden = credentials.length > 0;
    }
    async function load() {
      const generation = ++state.generation;
      state.controller?.abort(); state.controller = new root.AbortController();
      root.SimpleWebAuthnBrowser?.WebAuthnAbortService?.cancelCeremony?.();
      clearView(); loginLink.hidden = true; message("Der Zugang und die Passkeys werden geprüft …");
      if (!validTarget) { message("Der Link enthält keine gültige Kontozuordnung. Bitte den Zugang erneut aus der Kontoverwaltung öffnen.", true); return null; }
      try {
        const [availability, session] = await Promise.all([request(`${BASE}/status`), request("/api/portal/v1/session")]);
        if (!current(generation)) return null;
        if (!session?.authenticated) {
          loginLink.hidden = false; message("Bitte zuerst mit deinem persönlichen GP-Zugang anmelden."); return null;
        }
        if (session.user?.mustChangePassword) {
          loginLink.hidden = false; message("Bitte zuerst im Mitarbeiterportal das persönliche Startpasswort ändern."); return null;
        }
        if (accountId === null && (session.user?.sessionKind === "organization" || session.user?.isEmployee === false)) {
          message("Passkeys für Filial- und Terminalkonten werden durch die zuständige Filialleitung oder Administration mit einem persönlichen Zugang verwaltet."); return null;
        }
        if (availability?.available !== true || availability.origin !== root.location.origin) {
          message("Passkeys sind unter dieser GP-Adresse derzeit nicht verfügbar. Die Anmeldung mit Passwort bleibt möglich."); return null;
        }
        const result = await request(`${BASE}/credentials${accountId === null ? "" : `?accountId=${encodeURIComponent(accountId)}`}`);
        if (!current(generation)) return null;
        if (result.available !== true || !Array.isArray(result.credentials) || result.credentials.length > 100
          || !result.target || !["employee", "organization"].includes(result.target.kind)
          || (accountId === null ? result.target.kind !== "employee" : result.target.kind !== "organization")
          || typeof result.target.displayName !== "string"
          || result.credentials.some(item => !uuid(item.id) || typeof item.label !== "string" || !Number.isSafeInteger(item.revision) || item.revision < 1)) {
          throw new Error("Die Kontozuordnung konnte nicht sicher geprüft werden. Bitte die Ansicht aktualisieren.");
        }
        state.target = result.target; state.credentials = result.credentials; state.ready = true;
        state.enrollmentAllowed = result.target.enrollmentAllowed !== false;
        $("#passkeysTarget").textContent = `${result.target.kind === "organization" ? "Filial- oder Terminalkonto" : "Persönlicher Zugang"} · ${result.target.displayName}`;
        $("#passkeysOrganizationNote").hidden = result.target.kind !== "organization";
        for (const node of host.querySelectorAll("[data-passkeys-password-label]")) node.textContent = result.target.kind === "organization" ? "Dein persönliches Passwort" : "Aktuelles Passwort";
        renderCredentials(state.credentials); $("#passkeysCredentialsSection").hidden = false; $("#passkeysRegistrationSection").hidden = false;
        const supported = controls();
        message(!state.enrollmentAllowed ? "Für diesen Zugang kann derzeit kein weiterer Passkey eingerichtet werden. Vorhandene Passkeys kannst du weiterhin ansehen und widerrufen."
          : state.credentials.length >= 10 ? "Für diesen Zugang sind zehn Passkeys hinterlegt. Widerrufe zuerst einen nicht mehr benötigten Passkey."
          : supported ? "Du kannst einen Passkey hinzufügen oder einen vorhandenen widerrufen."
            : "Dieser Browser kann keinen Passkey einrichten. Vorhandene Passkeys kannst du hier weiterhin ansehen und widerrufen.");
        return generation;
      } catch (error) {
        if (!current(generation) || error.name === "AbortError") return null;
        clearView(); loginLink.hidden = ![401, 403].includes(error.status);
        message(error.message || "Die Passkeys konnten nicht geladen werden.", true); return null;
      }
    }
    async function mutate(operation, success) {
      if (!state.ready || state.busy || !lifecycle?.credentials) {
        clearSecrets(); if (!lifecycle?.credentials) message("Dieser Browser kann die Sicherheitsfreigabe nicht sicher abstimmen. Bitte einen aktuellen Browser verwenden.", true); return;
      }
      const generation = state.generation, originalCsrf = csrf();
      state.busy = true; controls(); message("Bitte die Sicherheitsfreigabe am Gerät abschließen …");
      let error = null, completed = false;
      try {
        await lifecycle.credentials(async () => { if (!current(generation)) throw contextError(); await operation(generation); });
        completed = true;
      } catch (value) { error = value; }
      finally {
        clearSecrets(); state.busy = false;
        if (completed || lifecycle.credentialChanged || csrf() !== originalCsrf) lifecycle.publish();
        if (current(generation)) {
          const refreshed = await load();
          if (refreshed !== null && current(refreshed)) message(completed ? success
            : ["NotAllowedError", "AbortError"].includes(error?.name) ? "Die Passkey-Einrichtung wurde abgebrochen. Es wurde keine weitere Anmeldung gestartet."
              : error?.message || "Die Sicherheitsfreigabe konnte nicht abgeschlossen werden.", !completed && !["NotAllowedError", "AbortError"].includes(error?.name));
        }
        controls();
      }
    }
    registerForm.addEventListener("submit", event => {
      event.preventDefault();
      if (!registerForm.reportValidity() || fields.disabled) return;
      let password = $("#passkeysRegisterPassword").value;
      const label = $("#passkeysLabel").value.trim(); clearSecrets();
      void mutate(async generation => {
        try {
          const result = await request(`${BASE}/register/options`, { method: "POST", body: { ...targetBody, label, currentPassword: password } });
          password = ""; if (!current(generation)) throw contextError();
          const response = await root.SimpleWebAuthnBrowser.startRegistration({ optionsJSON: result.options });
          if (!current(generation)) throw contextError();
          await request(`${BASE}/register/verify`, { method: "POST", body: { ...targetBody, challengeId: result.challengeId, response } });
          if (!current(generation)) throw contextError();
          $("#passkeysLabel").value = "";
        } finally { password = ""; }
      }, "Der Passkey wurde hinzugefügt.");
    });
    revokeForm.addEventListener("submit", event => {
      event.preventDefault(); if (!state.selected || !revokeForm.reportValidity()) return;
      const selected = state.selected; let password = $("#passkeysRevokePassword").value; clearSecrets();
      void mutate(async generation => {
        try {
          await request(`${BASE}/credentials/${encodeURIComponent(selected.id)}/revoke`, { method: "POST", body: { ...targetBody, revision: selected.revision, currentPassword: password } });
          if (!current(generation)) throw contextError();
        } finally { password = ""; }
      }, "Der Passkey wurde widerrufen.");
    });
    $("#passkeysRevokeCancel").addEventListener("click", () => { if (!state.busy) closeRevoke(); });
    dialog.addEventListener("cancel", event => { if (state.busy) event.preventDefault(); else closeRevoke(); });
    refresh.addEventListener("click", () => { if (!state.busy) void load(); });
    lifecycle?.listen?.(() => { void load(); });
    root.addEventListener("pagehide", () => {
      state.generation++; state.controller?.abort(); clearView();
      root.SimpleWebAuthnBrowser?.WebAuthnAbortService?.cancelCeremony?.();
    });
    void load();
    return Object.freeze({ refresh: load });
  }
  root.GPPasskeys = Object.freeze({ mount });
  if (root.document?.querySelector("#passkeyPage")) mount(root.document.querySelector("#passkeyPage"));
})(typeof window === "undefined" ? globalThis : window);
