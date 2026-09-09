/* Integrated through app.js; the page uses the existing authenticated API. */
function initializePermissionDefaults({ api, toast, dependencyRules, refreshRights }) {
  const byId = id => document.getElementById(id);
  const card = byId('permissionDefaultsCard'), target = byId('permissionDefaultsTarget');
  const list = byId('permissionDefaultsPermissions'), hint = byId('permissionDefaultsHint');
  const inherit = byId('permissionDefaultsInheritance'), save = byId('permissionDefaultsSave');
  let payload = null, drafts = new Map(), busy = false;
  const key = entry => entry.kind + ':' + entry.id;
  const selected = () => payload?.entries.find(entry => key(entry) === target.value);
  function draft(entry) {
    if (!drafts.has(key(entry))) drafts.set(key(entry), {
      permissions: new Set(entry.permissions || []), inherit: entry.permissions === null, reset: false, dirty: false,
    });
    return drafts.get(key(entry));
  }
  function filter() {
    const query = byId('permissionDefaultsSearch').value.trim().toLocaleLowerCase('de-AT');
    list.querySelectorAll('label').forEach(label => { label.hidden = !label.textContent.toLocaleLowerCase('de-AT').includes(query) && !label.querySelector('input').value.toLowerCase().includes(query); });
    list.querySelectorAll('details').forEach(group => {
      group.hidden = ![...group.querySelectorAll('label')].some(label => !label.hidden);
      if (query && !group.hidden) group.open = true;
    });
  }
  function render() {
    const entry = selected(); if (!entry) return;
    const value = draft(entry), locked = entry.protected || busy || (entry.kind === 'position' && value.inherit);
    byId('permissionDefaultsInheritanceRow').classList.toggle('hidden', entry.kind !== 'position');
    inherit.checked = value.inherit; inherit.disabled = busy;
    list.replaceChildren();
    const groups = new Map();
    for (const permission of payload.catalog) {
      const name = permission.group || 'Weitere Rechte';
      if (!groups.has(name)) {
        const group = document.createElement('details'), summary = document.createElement('summary'), rows = document.createElement('div');
        summary.textContent = name; rows.className = 'permission-defaults-rows'; group.append(summary, rows); list.append(group); groups.set(name, rows);
      }
      const label = document.createElement('label'), input = document.createElement('input'), copy = document.createElement('span'), title = document.createElement('strong');
      input.type = 'checkbox'; input.value = permission.id; input.checked = value.permissions.has(permission.id); input.disabled = locked;
      title.textContent = permission.label || permission.id; copy.append(title);
      if (permission.description) { const text = document.createElement('small'); text.textContent = permission.description; copy.append(text); }
      label.append(input, copy); groups.get(name).append(label);
    }
    save.disabled = entry.protected || busy || !value.dirty;
    byId('permissionDefaultsReset').disabled = entry.protected || busy || (entry.kind === 'role' && !entry.builtinPermissions);
    byId('permissionDefaultsReset').textContent = entry.kind === 'position' ? 'App-Rollenstandard verwenden' : 'Eingebauten Standard laden';
    hint.textContent = entry.protected ? 'Der Developer behält garantierten Vollzugriff.'
      : `${value.dirty ? 'Ungespeicherte Änderungen. ' : ''}${entry.affected} aktive Zugänge sind zugeordnet. Speichern wirkt sofort; betroffene Zugänge müssen sich erneut anmelden. Persönliche Abweichungen werden berücksichtigt.`;
    filter();
  }
  async function load(enabled) {
    card.classList.toggle('hidden', !enabled);
    if (!enabled) { payload = null; drafts.clear(); return; }
    try {
      payload = await api('/api/portal/v1/rights/defaults'); drafts.clear();
      const previous = target.value; target.replaceChildren();
      for (const [kind, title] of [['role','App-Rollen'],['position','Positionen']]) {
        const group = document.createElement('optgroup'); group.label = title;
        for (const entry of payload.entries.filter(entry => entry.kind === kind)) { const option = document.createElement('option'); option.value = key(entry); option.textContent = entry.name + (entry.protected ? ' · Vollzugriff' : ''); group.append(option); }
        target.append(group);
      }
      if (payload.entries.some(entry => key(entry) === previous)) target.value = previous;
      else target.value = 'role:employee';
      render();
    } catch (error) { list.replaceChildren(); save.disabled = true; hint.textContent = error.message; }
  }
  target.addEventListener('change', render);
  byId('permissionDefaultsSearch').addEventListener('input', filter);
  inherit.addEventListener('change', () => {
    const entry = selected(), value = draft(entry); value.inherit = inherit.checked; value.dirty = true;
    render();
  });
  list.addEventListener('change', event => {
    const input = event.target; if (!input.matches('input[type="checkbox"]')) return;
    const value = draft(selected()); value.dirty = true; value.reset = false;
    input.checked ? value.permissions.add(input.value) : value.permissions.delete(input.value);
    // Apply the same prerequisite graph as the personal rights editor.
    let changed = true;
    while (changed) {
      changed = false;
      for (const rule of dependencyRules) {
        if (!value.permissions.has(rule.permissionId) || value.permissions.has(rule.requiredPermissionId)) continue;
        if (input.checked) value.permissions.add(rule.requiredPermissionId);
        else value.permissions.delete(rule.permissionId);
        changed = true;
      }
    }
    list.querySelectorAll('input').forEach(box => { box.checked = value.permissions.has(box.value); });
    save.disabled = false; hint.textContent = 'Ungespeicherte Änderungen. Abhängige Rechte wurden mit angepasst.';
  });
  byId('permissionDefaultsReset').addEventListener('click', () => {
    const entry = selected(), value = draft(entry); value.permissions = new Set(entry.builtinPermissions || []);
    value.inherit = entry.kind === 'position'; value.reset = true; value.dirty = true; render();
  });
  save.addEventListener('click', async () => {
    const entry = selected(), value = draft(entry); if (busy || entry.protected) return;
    busy = true; save.disabled = true; target.disabled = true;
    inherit.disabled = true; byId('permissionDefaultsReset').disabled = true;
    list.querySelectorAll('input').forEach(input => { input.disabled = true; });
    try {
      const result = await api(`/api/portal/v1/rights/defaults/${entry.kind}/${encodeURIComponent(entry.id)}`, {
        method: 'PUT', body: JSON.stringify({ revision: entry.revision, permissions: [...value.permissions], reset: entry.kind === 'position' ? value.inherit : value.reset }),
      });
      payload = result; drafts.delete(key(entry));
      await refreshRights();
      toast(`Standard gespeichert. ${result.affected} Zugänge wurden aktualisiert.`);
    } catch (error) { toast(error.message, true); }
    finally { busy = false; target.disabled = false; render(); }
  });
  return { load };
}
