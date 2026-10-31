(function (root) {
  "use strict";
  const OPERATIONS = new Set(["database-download", "offsite-folder-create", "offsite-folder-activate", "vps-reboot", "password-change"]);
  const allowedChoices = new Map(), required = new WeakMap();
  let available = false, loginPending = false;
  const supported = () => Boolean(root.isSecureContext && root.PublicKeyCredential && root.navigator?.credentials?.get
    && typeof root.SimpleWebAuthnBrowser?.startAuthentication === "function");
  const choice = operation => root.document?.querySelector(`[data-gp-passkey-operation="${operation}"]`);
  function selected(operation) { return OPERATIONS.has(operation) && choice(operation)?.checked === true; }
  function syncChoices() {
    for (const toggle of root.document?.querySelectorAll("[data-gp-passkey-operation]") || []) {
      const enabled = available && supported() && allowedChoices.get(toggle.dataset.gpPasskeyOperation) !== false;
      const password = root.document.getElementById(toggle.dataset.gpPasskeyPassword);
      if (password && !required.has(password)) required.set(password, password.required);
      toggle.closest("[data-gp-passkey-choice]").hidden = !enabled;
      if (!enabled) toggle.checked = false;
      if (password) {
        if (toggle.checked) { password.value = ""; password.type = "password"; }
        password.required = toggle.checked ? false : required.get(password);
        const field = password.closest("label");
        if (field) { field.setAttribute("data-gp-passkey-password-field", ""); field.hidden = toggle.checked; }
      }
    }
  }
  function setChoiceEnabled(operation, enabled) { allowedChoices.set(operation, enabled === true); syncChoices(); }
  function authenticationError(error) {
    if (["NotAllowedError", "AbortError"].includes(error?.name)) {
      return Object.assign(new Error("Die Passkey-Bestätigung wurde abgebrochen. Bitte bei Bedarf erneut starten."), { name: "AbortError", code: "PASSKEY_CANCELLED" });
    }
    return error;
  }
  async function assertion(api, url, body) {
    if (!available || !supported()) throw new Error("Passkeys sind in diesem Browser oder unter dieser GP-Adresse nicht verfügbar.");
    const result = await api(url, { method: "POST", body: JSON.stringify(body) });
    try {
      const response = await root.SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: result.options });
      return { challengeId: result.challengeId, response };
    } catch (error) { throw authenticationError(error); }
  }
  async function login(api, complete) {
    if (loginPending) return;
    const lifecycle = root.GrabenplanerSessionLifecycle;
    if (!lifecycle?.credentials) throw new Error("Dieser Browser kann die Anmeldung nicht sicher abstimmen.");
    loginPending = true;
    for (const button of root.document.querySelectorAll("[data-gp-passkey-login]")) button.disabled = true;
    try {
      return await lifecycle.credentials(async () => {
        const csrfCookie = () => String(root.document?.cookie || "").split(";").map(value => value.trim())
          .find(value => value.startsWith("grabenplaner_csrf=")) || "";
        const originalCsrfCookie = csrfCookie();
        let published = false;
        try {
          const proof = await assertion(api, "/api/portal/v1/auth/passkeys/options", {});
          const result = await api("/api/portal/v1/auth/passkeys/verify", { method: "POST", body: JSON.stringify(proof) });
          published = true; lifecycle.publish();
          return complete(result);
        } finally {
          // Cookies may already have committed even when the response body was
          // lost. Invalidate other tabs before releasing the credential lock.
          if (!published && (lifecycle.credentialChanged || csrfCookie() !== originalCsrfCookie)) lifecycle.publish();
        }
      }, { allowAccountChange: true });
    } finally {
      loginPending = false;
      for (const button of root.document.querySelectorAll("[data-gp-passkey-login]")) button.disabled = false;
    }
  }
  // Called inside the caller's existing credentials()/withAdminReauthentication
  // lock. The assertion travels only on the original protected operation.
  async function authorization(api, operation) {
    if (!OPERATIONS.has(operation) || !selected(operation)) throw new Error("Bitte die Sicherheitsfreigabe erneut auswählen.");
    const toggle = choice(operation); toggle.disabled = true;
    try { return { passkey: await assertion(api, "/api/portal/v1/passkeys/reauthenticate/options", { operation }) }; }
    finally { toggle.disabled = false; }
  }
  function bindLogin(button, { api, complete, error, canUse = () => true }) {
    if (!button) return;
    button.addEventListener("click", () => {
      if (!canUse() || loginPending) return;
      void login(api, complete).catch(error);
    });
    void readiness.then(() => { button.hidden = !available || !supported(); });
  }
  const readiness = (async () => {
    try {
      const response = await root.fetch("/api/portal/v1/passkeys/status", { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
      const status = await response.json();
      available = response.ok && status.available === true && status.origin === root.location.origin;
    } catch { available = false; }
    syncChoices();
    return available;
  })();
  root.document?.addEventListener("change", event => { if (event.target.matches?.("[data-gp-passkey-operation]")) syncChoices(); });
  root.document?.addEventListener("reset", () => root.setTimeout(syncChoices, 0));
  root.addEventListener?.("pagehide", () => root.SimpleWebAuthnBrowser?.WebAuthnAbortService?.cancelCeremony?.());
  root.GPPasskeyAuth = Object.freeze({ selected, authorization, bindLogin, setChoiceEnabled, readiness });
})(typeof window === "undefined" ? globalThis : window);
