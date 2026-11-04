"use strict";
// This estimate is used only by schedule consumers. Actual time evaluation keeps
// the dated work-rule service and its exact pause/assignment requirements.
const { allocateSaturdayMinutes } = require('./work-rules/saturday-credit-time');
const PREFIX = 'planning_saturday_worst_case:';
const WRITE_PERMISSIONS = ['schedule:write', 'settings:write', 'locations:write', 'locations:operational:write'];
function settingKey(locationId) { return PREFIX + locationId; }
function enabled(settings, locationId) { return settings[settingKey(locationId)] !== '0'; }
function planningMetrics(shift, base, groups = []) {
  const allocated = allocateSaturdayMinutes(groups).at(-1) || { eligibleMinutes: 0, bonusMinutes: 0 };
  return { ...base, bonus_minutes: allocated.bonusMinutes, counted_minutes: base.raw_minutes - base.break_minutes + allocated.bonusMinutes,
    saturday_eligible_minutes: allocated.eligibleMinutes, saturday_credit_status: 'planning_estimate' };
}
function registerRoutes(app, { authorize, scope, validateLocation, read, write, error }) {
  const route = '/api/portal/v1/planning-saturday-settings/:locationId';
  const location = req => { const id = String(req.params.locationId || ''); if (!/^\d{2}$/.test(id)) throw error(400, 'Die Filiale ist ungültig.'); return id; };
  app.get(route, async (req, res) => {
    const actor = authorize(req, [...WRITE_PERMISSIONS, 'schedule:read']); const id = location(req); scope(actor, id);
    await validateLocation(id); res.set('Cache-Control', 'private, no-store'); res.json({ locationId: id, enabled: await read(id) });
  });
  app.put(route, async (req, res) => {
    const actor = authorize(req, WRITE_PERMISSIONS, { csrf: true }); const id = location(req); scope(actor, id);
    if (!req.body || Object.keys(req.body).some(k => k !== 'enabled') || typeof req.body.enabled !== 'boolean') throw error(400, 'Bitte den Samstagszuschlag ein- oder ausschalten.');
    await validateLocation(id); await write(actor, id, req.body.enabled); res.set('Cache-Control', 'private, no-store'); res.json({ locationId: id, enabled: await read(id) });
  });
}
module.exports = { PREFIX, WRITE_PERMISSIONS, settingKey, enabled, planningMetrics, registerRoutes };
