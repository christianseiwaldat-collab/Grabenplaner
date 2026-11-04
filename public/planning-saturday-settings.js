"use strict";
window.createPlanningSaturdaySettings = function ({ api, canWrite, capture, isCurrent, onSaved, onError }) {
  const controls = [...document.querySelectorAll('[data-saturday-planning]')];
  const pending = new Set(); let editorEpoch = 0;
  const label = id => document.querySelector('[data-saturday-location-label="' + id + '"]');
  function paint(control, locationId, enabled, ready = true) {
    control.dataset.locationId = locationId || ''; control.checked = enabled; control.dataset.confirmed = String(enabled);
    control.disabled = !ready || !locationId || pending.has(locationId) || !canWrite(locationId);
  }
  function render(locationId, enabled, name) {
    for (const control of controls.filter(c => c.dataset.saturdayPlanning !== 'editor')) paint(control, locationId, enabled);
    if (label('settings')) label('settings').textContent = name || locationId || 'Bitte Standort wählen';
  }
  async function editLocation(locationId) {
    const epoch = ++editorEpoch, control = controls.find(c => c.dataset.saturdayPlanning === 'editor'); if (!control) return;
    paint(control, locationId, true, false); const ticket = capture();
    const hint = document.getElementById('locationSaturdayPlanningHint');
    if (hint) hint.textContent = locationId ? 'Standortweite Planung · Änderungen werden sofort gespeichert.' : 'Für neue Standorte standardmäßig aktiv. Nach dem Anlegen hier änderbar.';
    if (!locationId) return;
    try { const saved = await api('/api/portal/v1/planning-saturday-settings/' + encodeURIComponent(locationId)); if (epoch === editorEpoch && isCurrent(ticket)) paint(control, locationId, saved.enabled); }
    catch (error) { if (epoch === editorEpoch && isCurrent(ticket)) onError(error); }
  }
  for (const control of controls) control.addEventListener('change', async () => {
    const locationId = control.dataset.locationId, enabled = control.checked, previous = control.dataset.confirmed === 'true', ticket = capture();
    if (!locationId || pending.has(locationId) || !canWrite(locationId)) { control.checked = previous; return; }
    pending.add(locationId); controls.filter(c => c.dataset.locationId === locationId).forEach(c => { c.disabled = true; });
    try {
      const saved = await api('/api/portal/v1/planning-saturday-settings/' + encodeURIComponent(locationId), { method: 'PUT', body: JSON.stringify({ enabled }) });
      if (!isCurrent(ticket)) return;
      controls.filter(c => c.dataset.locationId === locationId).forEach(c => paint(c, locationId, saved.enabled));
      await onSaved(locationId, saved.enabled);
    } catch (error) {
      if (isCurrent(ticket)) { controls.filter(c => c.dataset.locationId === locationId).forEach(c => paint(c, locationId, previous)); onError(error); }
    } finally {
      pending.delete(locationId);
      if (isCurrent(ticket)) controls.filter(c => c.dataset.locationId === locationId).forEach(c => { c.disabled = !canWrite(locationId); });
    }
  });
  return { render, editLocation };
};
