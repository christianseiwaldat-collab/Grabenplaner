'use strict';
const crypto = require('node:crypto');
const FORMAT = 'grabenplaner-vps-storage-v1';
const ACTIONS = Object.freeze(['status', 'inspect', 'cleanup', 'retire-imports', 'settings']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const DEFAULTS = Object.freeze({ warningGiB: 5, orphanAgeDays: 7 });
function validateSettings(value) {
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'orphanAgeDays,warningGiB'
      || !Number.isInteger(value.warningGiB) || value.warningGiB < 2 || value.warningGiB > 50
      || !Number.isInteger(value.orphanAgeDays) || value.orphanAgeDays < 7 || value.orphanAgeDays > 90) {
    throw new Error('VPS_STORAGE_SETTINGS_INVALID');
  }
  return { warningGiB: value.warningGiB, orphanAgeDays: value.orphanAgeDays };
}
function validateRequest(value) {
  const keys = ['format', 'action', 'requestId'];
  if (['cleanup', 'retire-imports'].includes(value?.action)) keys.push('planSha256');
  if (value?.action === 'settings') keys.push('settings');
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys.sort().join(',')
      || value.format !== FORMAT || !ACTIONS.includes(value.action) || !UUID.test(value.requestId || '')
      || keys.includes('planSha256') && !SHA.test(value.planSha256 || '')) throw new Error('VPS_STORAGE_REQUEST_INVALID');
  if (value.action === 'settings') validateSettings(value.settings);
  return value;
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function requireActor(actor, write = false) {
  if (!actor || !['developer', 'it_admin', 'admin'].includes(actor.role)
      || !actor.permissions?.includes('system:diagnostics:technical')
      || write && !actor.permissions.includes('system:write')) {
    throw Object.assign(new Error('Für VPS-Speicher fehlt die technische Berechtigung.'), { code: 'VPS_STORAGE_FORBIDDEN', status: 403 });
  }
  return actor;
}
module.exports = { FORMAT, ACTIONS, DEFAULTS, UUID, SHA, validateSettings, validateRequest, digest, requireActor };
