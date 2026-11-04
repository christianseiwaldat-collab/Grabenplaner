'use strict';
const crypto = require('node:crypto');
const C = require('./vps-storage-contract');
const BASE = '/api/portal/v1/vps-storage';
function install(app, { actor, freshActor, csrf, eligible, audit, control = require('./vps-storage-control').requestControl }) {
  const deny = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
  const read = request => C.requireActor(actor(request));
  async function queue(request, response, action, extra = {}) {
    const write = action !== 'inspect';
    const before = C.requireActor(actor(request), write); csrf(request);
    if (!eligible()) throw deny('VPS_STORAGE_SERVER_REQUIRED', 'VPS-Speicher ist am eingerichteten Ubuntu-Server verfügbar.');
    const fresh = C.requireActor(await freshActor(request), write);
    if (fresh.employeeNumber !== before.employeeNumber || fresh.accountId !== before.accountId) throw deny('VPS_STORAGE_FORBIDDEN', 'Die Anmeldung hat sich geändert.', 403);
    const requestId = crypto.randomUUID();
    await audit(before, action, requestId);
    try {
      const result = await control({ action, requestId, ...extra });
      response.setHeader('Cache-Control', 'private, no-store');
      response.status(202).json({ ok: true, requestId, acceptedAt: result.acceptedAt });
    } catch (error) {
      const busy = error.message === 'VPS_STORAGE_MAINTENANCE_BUSY';
      throw deny(busy ? error.message : 'VPS_STORAGE_CONTROL_UNAVAILABLE', busy
        ? 'Eine Sicherung, Assurance oder andere Wartung läuft. Bitte nach deren Abschluss erneut prüfen.'
        : 'Die geschützte Speichersteuerung ist derzeit nicht verfügbar.', busy ? 409 : 503);
    }
  }
  app.get(BASE, async (request, response) => {
    const user = read(request); response.setHeader('Cache-Control', 'private, no-store');
    if (!eligible()) return response.json({ available: false, canWrite: false, reason: 'VPS-Speicher ist am eingerichteten Ubuntu-Server verfügbar.' });
    try {
      const { report } = await control({ action: 'status', requestId: crypto.randomUUID() });
      let canWrite = true; try { C.requireActor(user, true); } catch { canWrite = false; }
      response.json({ ...report, canWrite });
    } catch { throw deny('VPS_STORAGE_CONTROL_UNAVAILABLE', 'Die geschützte Speicherübersicht ist derzeit nicht verfügbar.', 503); }
  });
  app.post(BASE + '/inspect', async (request, response) => {
    if (request.body && (typeof request.body !== 'object' || Array.isArray(request.body) || Object.keys(request.body).length)) throw deny('VPS_STORAGE_REQUEST_INVALID', 'Die Speicherprüfung benötigt keine Dateipfade.', 400);
    return queue(request, response, 'inspect');
  });
  app.put(BASE + '/settings', async (request, response) => {
    let settings; try { settings = C.validateSettings(request.body); }
    catch { throw deny('VPS_STORAGE_SETTINGS_INVALID', 'Zusatzreserve: 2–50 GiB. Alter unvollständiger Sicherungsreste: 7–90 Tage.', 400); }
    return queue(request, response, 'settings', { settings });
  });
  for (const [action, confirmation] of [['cleanup', 'VPS_STORAGE_CLEANUP'], ['retire-imports', 'VPS_STORAGE_RETIRE_IMPORTS']]) {
    app.post(BASE + '/' + action, async (request, response) => {
      const body = request.body;
      if (!body || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'confirmation,planSha256'
          || body.confirmation !== confirmation || !C.SHA.test(body.planSha256 || '')) throw deny('VPS_STORAGE_CONFIRMATION_REQUIRED', 'Bitte zuerst den aktuellen Bereinigungsplan prüfen und bestätigen.', 400);
      return queue(request, response, action, { planSha256: body.planSha256 });
    });
  }
}
module.exports = { BASE, install };
