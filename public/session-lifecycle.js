(function (root) {
  "use strict";
  let generation = 0, channel = null, refresh = null, activityAt = null;
  let credentialPending = 0, credentialController = null, refreshDeferred = false, credentialChanged = false;
  const credentialLockName = "grabenplaner-credentials-v1";
  const activityWindowMs = 30000;
  function advance() { generation += 1; activityAt = null; }
  function credentialError(message = "Dieser Browser kann Anmeldungen und Passwortänderungen nicht sicher zwischen Fenstern abstimmen. Bitte Browser-Speicher erlauben oder einen aktuellen Browser verwenden.") {
    return Object.assign(new Error(message), { code: "PORTAL_CREDENTIAL_COORDINATION_UNAVAILABLE" });
  }
  function refreshSession() {
    if (credentialPending) refreshDeferred = true;
    else refresh?.();
  }
  function indexedCredentialLock(run, lost) {
    return new Promise((resolve, reject) => {
      let opening, database, transaction, finished = false, started = false, result, failure;
      const fail = () => {
        if (finished) return;
        finished = true;
        if (started) lost();
        database?.close();
        reject(credentialError());
      };
      try { opening = root.indexedDB.open(credentialLockName, 1); } catch { fail(); return; }
      opening.onupgradeneeded = () => opening.result.createObjectStore("exclusive");
      opening.onerror = opening.onblocked = fail;
      opening.onsuccess = () => {
        database = opening.result;
        if (finished) { database.close(); return; }
        database.onversionchange = () => { try { transaction?.abort(); } catch {} fail(); };
        try { transaction = database.transaction("exclusive", "readwrite"); } catch { fail(); return; }
        transaction.onabort = transaction.onerror = fail;
        transaction.oncomplete = () => {
          if (finished) return;
          finished = true; database.close();
          if (failure) reject(failure); else resolve(result);
        };
        let done = false;
        function pump() {
          let request;
          try { request = transaction.objectStore("exclusive").get("lock"); } catch { fail(); return; }
          request.onerror = fail;
          request.onsuccess = () => {
            if (finished || done) return;
            // Queue synchronously in the active transaction, with no lease or
            // timer. No account, token or other value is written to the store.
            pump();
            if (!started) {
              started = true;
              Promise.resolve().then(run).then(value => { result = value; done = true; }, error => { failure = error; done = true; });
            }
          };
        }
        pump();
      };
    });
  }
  async function credentials(operation, { allowAccountChange = false, prepare } = {}) {
    const expectedGeneration = generation;
    const csrfCookie = () => String(root.document?.cookie || "").split(";").map(value => value.trim())
      .find(value => value.startsWith("grabenplaner_csrf=")) || "";
    const expectedCsrfCookie = csrfCookie();
    const controller = new root.AbortController();
    credentialPending += 1;
    const lost = () => { controller.abort(); advance(); };
    const run = async () => {
      if (!allowAccountChange && (generation !== expectedGeneration || csrfCookie() !== expectedCsrfCookie)) {
        throw credentialError("Die Anmeldung wurde in einem anderen Fenster geändert. Bitte die gewünschte Aktion erneut aufrufen.");
      }
      if (controller.signal.aborted) throw credentialError();
      credentialChanged = false;
      credentialController = controller;
      try {
        // Finish existing saves under the same cross-tab lock before their
        // response generation is invalidated by the credential transition.
        if (prepare) {
          const prepared = await prepare();
          if (controller.signal.aborted) throw credentialError();
          if (!allowAccountChange && (generation !== expectedGeneration || csrfCookie() !== expectedCsrfCookie)) {
            throw credentialError("Die Anmeldung wurde in einem anderen Fenster geändert. Bitte die gewünschte Aktion erneut aufrufen.");
          }
          if (prepared === false) return false;
        }
        advance();
        return await operation();
      }
      finally { if (credentialController === controller) credentialController = null; }
    };
    try {
      if (root.navigator?.locks?.request) {
        // An error from Web Locks never falls back to another coordination space.
        return await root.navigator.locks.request(credentialLockName, { mode: "exclusive" }, run);
      }
      if (!root.indexedDB?.open) throw credentialError();
      return await indexedCredentialLock(run, lost);
    } catch (error) {
      if (error?.code || error?.name === "AbortError") throw error;
      throw credentialError();
    } finally {
      credentialPending -= 1;
      if (!credentialPending && refreshDeferred) { refreshDeferred = false; refreshSession(); }
    }
  }
  function credentialOptions(url, options) {
    let pathname;
    try { pathname = new URL(url, root.location.href).pathname; } catch { return options; }
    const changesCredentials = /^\/api\/(?:portal\/v1\/(?:auth\/(?:login|logout|password-reset\/confirm|passkeys\/verify)|passkeys\/(?:register\/verify|credentials\/[a-f0-9-]+\/revoke)|setup\/admin|me\/password|server-monitor\/vps-reboot)|backup\/(?:database-download|offsite-folders(?:\/active)?))$/.test(pathname)
      && !["GET", "HEAD", "OPTIONS"].includes(String(options.method || "GET").toUpperCase());
    if (!credentialController) {
      if (changesCredentials) throw credentialError();
      return options;
    }
    // Follow-up session reads and response bodies must also abort if this
    // transition loses its lock, even though they do not change credentials.
    let signal = credentialController.signal;
    if (options.signal) {
      if (root.AbortSignal?.any) signal = root.AbortSignal.any([options.signal, signal]);
      else {
        const combined = new root.AbortController();
        for (const source of [options.signal, signal]) {
          if (source.aborted) combined.abort();
          else source.addEventListener("abort", () => combined.abort(), { once: true });
        }
        signal = combined.signal;
      }
    }
    return { ...options, signal };
  }
  function observeCredentialResponse(response) {
    if (credentialController && response?.headers?.get?.("X-GP-Session-Changed") === "1") credentialChanged = true;
  }
  function activityHeaders(url, authenticated = false) {
    if (!authenticated || activityAt === null) return {};
    const age = Date.now() - activityAt;
    if (age < 0 || age > activityWindowMs) { activityAt = null; return {}; }
    let target, origin;
    try {
      origin = new URL(root.location.href);
      target = new URL(url, origin);
    } catch { return {}; }
    // Authentication/status polling never represents a new interaction.
    if (target.origin !== origin.origin || !target.pathname.startsWith("/api/")
      || /\/(?:auth|session|status|bootstrap)(?:\/|$)/.test(target.pathname)) return {};
    activityAt = null;
    return { "X-GP-User-Activity": "1" };
  }
  for (const type of ["pointerdown", "keydown", "input"]) {
    root.addEventListener?.(type, event => {
      if (event.isTrusted === true) activityAt = Date.now();
    }, { capture: true, passive: true });
  }
  function connect() {
    if (channel || typeof root.BroadcastChannel !== "function") return;
    channel = new root.BroadcastChannel("grabenplaner-session-lifecycle-v1");
    channel.onmessage = event => {
      if (event.data?.type !== "session-changed") return;
      // A prior holder's message can arrive after this holder acquired the lock.
      // Do not invalidate its own in-flight authentication response.
      if (credentialController) { refreshDeferred = true; return; }
      advance();
      refreshSession();
    };
  }
  root.GrabenplanerSessionLifecycle = Object.freeze({
    get generation() { return generation; },
    advance,
    activityHeaders,
    credentials,
    credentialOptions,
    observeCredentialResponse,
    get credentialChanged() { return credentialChanged; },
    listen(callback) { refresh = callback; connect(); },
    publish() {
      connect();
      // Only an invalidation signal crosses tabs. Never a token or account ID.
      channel?.postMessage({ type: "session-changed" });
    },
  });
  root.addEventListener?.("pagehide", () => { channel?.close(); channel = null; });
  root.addEventListener?.("pageshow", event => {
    connect();
    if (event.persisted) { advance(); refreshSession(); }
  });
})(typeof window === "undefined" ? globalThis : window);
