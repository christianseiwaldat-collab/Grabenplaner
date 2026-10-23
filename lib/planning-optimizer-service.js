"use strict";
const { spawn } = require("node:child_process");
const path = require("node:path"), fs = require("node:fs");
const fail = (message, code, status = 503) => Object.assign(new Error(message), { status, code });
function pythonPath() {
  return process.env.GRABENPLANER_PLANNING_PYTHON || path.join(__dirname, "..", ".venv-planning", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
}
function createOptimizerService({ python = pythonPath, timeoutMs = 15000, script = path.join(__dirname, "..", "services", "planning-optimizer", "service.py") } = {}) {
  let busy = false, cached = null;
  async function run(payload, { signal } = {}) {
    if (process.env.GRABENPLANER_PLANNING_OPTIMIZER_ENABLED === "0") throw fail("Lokale Planvorschläge sind in der Serverkonfiguration deaktiviert.", "OPTIMIZER_DISABLED");
    if (busy) throw fail("Der lokale Planungsdienst ist beschäftigt. Bitte kurz darauf erneut versuchen.", "OPTIMIZER_BUSY", 429);
    const executable = typeof python === "function" ? python() : python;
    if (!fs.existsSync(executable)) throw fail("Die Python-Umgebung des Planungsdienstes fehlt. Bitte die dokumentierte Einrichtung ausführen.", "OPTIMIZER_UNAVAILABLE");
    const input = JSON.stringify(payload);
    if (Buffer.byteLength(input) > 2_000_000) throw fail("Der Planungsumfang ist zu groß.", "OPTIMIZER_SCOPE_LIMIT", 422);
    if (signal?.aborted) throw fail("Die Optimierung wurde abgebrochen.", "OPTIMIZER_CANCELLED", 499);
    busy = true;
    try { return await new Promise((resolve, reject) => {
      // Do not give the numerical service API keys or other GP credentials.
      const env = Object.fromEntries(["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP", "LANG"].filter(k => process.env[k]).map(k => [k, process.env[k]]));
      const child = spawn(executable, ["-I", "-u", script], { windowsHide: true, shell: false, env, stdio: ["pipe", "pipe", "pipe"] });
      let output = "", settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); child.kill(); error ? reject(error) : resolve(value); };
      const abort = () => finish(fail("Die Optimierung wurde abgebrochen.", "OPTIMIZER_CANCELLED", 499));
      const timer = setTimeout(() => finish(fail("Der lokale Planungsdienst hat sein Zeitlimit erreicht.", "OPTIMIZER_TIMEOUT", 504)), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      child.on("error", () => finish(fail("Der lokale Planungsdienst konnte nicht gestartet werden.", "OPTIMIZER_UNAVAILABLE")));
      child.stderr.on("data", () => {});
      child.stdin.on("error", () => {});
      child.stdout.on("data", chunk => { output += chunk.toString("utf8"); if (output.length > 1_000_000) finish(fail("Ungültige Antwort des Planungsdienstes.", "OPTIMIZER_OUTPUT_INVALID")); });
      child.on("close", code => { if (settled) return; try { const value = JSON.parse(output.trim()); if (code !== 0 || value.error || value.schemaVersion !== 2) throw new Error(); finish(null, value); }
        catch { finish(fail("Der lokale Planungsdienst ist nicht betriebsbereit. Bitte Python und OR-Tools prüfen.", "OPTIMIZER_UNAVAILABLE")); } });
      child.stdin.end(input + "\n");
    }); } finally { busy = false; }
  }
  async function health() {
    if (process.env.GRABENPLANER_PLANNING_OPTIMIZER_ENABLED === "0") return { available: false, code: "OPTIMIZER_DISABLED", message: "Lokale Planvorschläge sind in der Serverkonfiguration deaktiviert." };
    if (cached && Date.now() - cached.at < 60000) return cached.value;
    try { const value = { available: true, ...await run({ action: "health" }) }; cached = { at: Date.now(), value }; return value; }
    catch (error) { return { available: false, code: error.code, message: error.message }; }
  }
  return { run, health };
}
module.exports = { createOptimizerService, pythonPath };
