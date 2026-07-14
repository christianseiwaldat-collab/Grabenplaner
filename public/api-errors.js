(function initializeApiErrors(globalScope) {
  "use strict";

  const STARTUP_STATUSES = new Set([502, 503, 504]);

  function isCodespacesHostname(hostname) {
    return String(hostname || "").toLowerCase().endsWith(".app.github.dev");
  }

  function codespacesResponseMessage(status) {
    if ([401, 403].includes(Number(status))) {
      return "Die GitHub-Codespaces-Anmeldung ist abgelaufen. Bitte Port 3000 in GitHub im Bereich „PORTS“ erneut mit „Open in Browser“ öffnen.";
    }
    if (STARTUP_STATUSES.has(Number(status))) {
      return "Der Codespace wird gerade gestartet oder ist vorübergehend nicht erreichbar. Bitte kurz warten und Port 3000 danach im Bereich „PORTS“ erneut mit „Open in Browser“ öffnen.";
    }
    return "Der GitHub-Codespaces-Proxy hat keine gültige App-Antwort geliefert. Bitte Port 3000 im Bereich „PORTS“ erneut mit „Open in Browser“ öffnen.";
  }

  async function fromResponse(response, options = {}) {
    const fallback = String(options.fallback || "Die Aktion konnte nicht ausgeführt werden.");
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (payload && typeof payload.error === "string" && payload.error.trim()) {
      return { message: payload.error, code: String(payload.code || "") };
    }
    if (isCodespacesHostname(options.hostname)) {
      return { message: codespacesResponseMessage(response.status), code: "CODESPACES_PROXY_RESPONSE" };
    }
    return { message: `${fallback} (HTTP ${Number(response.status) || "unbekannt"}).`, code: "" };
  }

  function fromNetwork(error, options = {}) {
    if (!isCodespacesHostname(options.hostname)) {
      return error instanceof Error ? error : new Error("Die Verbindung zur Anwendung ist fehlgeschlagen.");
    }
    const mapped = new Error("Der Codespace wird gerade gestartet oder ist vorübergehend nicht erreichbar. Bitte kurz warten und Port 3000 danach im Bereich „PORTS“ erneut mit „Open in Browser“ öffnen.");
    mapped.code = "CODESPACES_PROXY_UNREACHABLE";
    return mapped;
  }

  const api = Object.freeze({ fromNetwork, fromResponse, isCodespacesHostname });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (globalScope) globalScope.GrabenplanerApiErrors = api;
})(typeof window !== "undefined" ? window : globalThis);
