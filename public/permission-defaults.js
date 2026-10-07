/* Integrated through app.js; the page uses the existing authenticated API. */
function initializePermissionDefaults({ api, toast, dependencyRules, refreshRights, identity = () => '', actorKey = identity, canUse = () => true }) {
  const byId = id => document.getElementById(id);
  const card = byId('permissionDefaultsCard'), target = byId('permissionDefaultsTarget');
  const list = byId('permissionDefaultsPermissions'), hint = byId('permissionDefaultsHint');
  const inherit = byId('permissionDefaultsInheritance'), save = byId('permissionDefaultsSave');
  let payload = null, drafts = new Map(), saveContext = null, table = null;
  let enabled = false, actor = '', loadGeneration = 0, loadController = null;
  const key = entry => entry.kind + ':' + entry.id;
  const selected = () => payload?.entries.find(entry => key(entry) === target.value);
  function draft(entry) {
    if (!drafts.has(key(entry))) drafts.set(key(entry), {
      permissions: new Set(entry.permissions || []), inherit: entry.permissions === null, reset: false, dirty: false, revision: entry.revision,
    });
    return drafts.get(key(entry));
  }
  const allowed = () => enabled && canUse() && actor === actorKey();
  const busy = () => Boolean(saveContext);
  function clear() {
    payload = null; drafts.clear(); saveContext = null;
    table?.destroy(); table = null; list.replaceChildren(); target.replaceChildren();
    byId('permissionDefaultsSearch').value = ''; hint.textContent = ''; save.disabled = true;
    target.disabled = false; inherit.disabled = true; byId('permissionDefaultsReset').disabled = true;
  }
  function mountTable() {
    if (table || !window.RightsSettingsTable) return;
    const text = (row, field, doc) => {
      const span = doc.createElement('span'); span.textContent = row[field] || '–'; return span;
    };
    table = window.RightsSettingsTable.mount({
      host: list, tableId: 'rights:defaults:catalog', identity, canUse: allowed,
      searchInput: byId('permissionDefaultsSearch'), searchLabel: 'Recht suchen',
      searchText: row => [row.id, row.label, row.group, row.description].join(' '),
      emptyText: 'Keine passenden Rechte.', rows: [],
      columns: [
        { id: 'selected', label: 'Erlaubt', width: 90, mandatory: true, numeric: true,
          sortValue: row => Number(draft(selected()).permissions.has(row.id)),
          cell: (row, doc) => {
            const input = doc.createElement('input'), entry = selected(), value = draft(entry);
            input.type = 'checkbox'; input.value = row.id; input.checked = value.permissions.has(row.id);
            input.disabled = entry.protected || busy() || (entry.kind === 'position' && value.inherit);
            input.setAttribute('aria-label', (row.label || row.id) + ' erlauben');
            input.addEventListener('change', changePermission); return input;
          } },
        { id: 'label', label: 'Recht', width: 310, mandatory: true, cell: (row, doc) => text(row, 'label', doc), sortValue: row => row.label || row.id },
        { id: 'group', label: 'Bereich', width: 185, cell: (row, doc) => text(row, 'group', doc), sortValue: row => row.group || 'Weitere Rechte' },
        { id: 'description', label: 'Beschreibung', width: 340, cell: (row, doc) => text(row, 'description', doc), sortValue: row => row.description || '' },
        { id: 'id', label: 'Berechtigung', width: 220, visible: false, cell: (row, doc) => text(row, 'id', doc), sortValue: row => row.id },
      ],
    });
  }
  function render() {
    const entry = selected(); if (!entry || !allowed()) return;
    const value = draft(entry);
    byId('permissionDefaultsInheritanceRow').classList.toggle('hidden', entry.kind !== 'position');
    inherit.checked = value.inherit; inherit.disabled = entry.protected || busy(); target.disabled = busy();
    mountTable(); table?.setRows(payload.catalog);
    save.disabled = entry.protected || busy() || !value.dirty;
    byId('permissionDefaultsReset').disabled = entry.protected || busy() || (entry.kind === 'role' && !entry.builtinPermissions);
    byId('permissionDefaultsReset').textContent = entry.kind === 'position' ? 'App-Rollenstandard verwenden' : 'Eingebauten Standard laden';
    hint.textContent = entry.protected ? 'Der Developer behält garantierten Vollzugriff.'
      : `${value.dirty ? 'Ungespeicherte Änderungen. ' : ''}${value.dirty && value.revision !== entry.revision ? 'Der gespeicherte Standard wurde inzwischen geändert; dein Entwurf bleibt erhalten. ' : ''}${entry.affected} aktive Zugänge sind zugeordnet. Speichern wirkt sofort; betroffene Zugänge müssen sich erneut anmelden. Persönliche Abweichungen werden berücksichtigt.`;
  }
  async function load(isEnabled) {
    loadController?.abort(); const generation = ++loadGeneration;
    if (actor !== actorKey()) { clear(); actor = actorKey(); }
    enabled = Boolean(isEnabled) && canUse(); card.classList.toggle('hidden', !enabled);
    if (!enabled) { clear(); return; }
    if (busy()) { render(); return; }
    const openingActor = actor, controller = new AbortController(); loadController = controller;
    const current = () => generation === loadGeneration && openingActor === actorKey() && allowed();
    try {
      const result = await api('/api/portal/v1/rights/defaults', { signal: controller.signal });
      if (!current()) return;
      payload = result;
      const present = new Set(payload.entries.map(key));
      for (const [entryKey, value] of drafts) if (!present.has(entryKey) || !value.dirty) drafts.delete(entryKey);
      const previous = target.value; target.replaceChildren();
      for (const [kind, title] of [['role','App-Rollen'],['position','Positionen']]) {
        const group = document.createElement('optgroup'); group.label = title;
        for (const entry of payload.entries.filter(entry => entry.kind === kind)) { const option = document.createElement('option'); option.value = key(entry); option.textContent = entry.name + (entry.protected ? ' · Vollzugriff' : ''); group.append(option); }
        target.append(group);
      }
      if (payload.entries.some(entry => key(entry) === previous)) target.value = previous;
      else target.value = 'role:employee';
      render();
    } catch (error) {
      if (!current() || controller.signal.aborted) return;
      if (error.status === 401 || error.status === 403) { clear(); enabled = false; card.classList.add('hidden'); }
      save.disabled = true; hint.textContent = error.message;
    } finally { if (loadController === controller) loadController = null; }
  }
  target.addEventListener('change', render);
  inherit.addEventListener('change', () => {
    const entry = selected(); if (!allowed() || busy() || !entry || entry.protected) return;
    const value = draft(entry); value.inherit = inherit.checked; value.dirty = true;
    render();
  });
  function changePermission(event) {
    const input = event.target, entry = selected();
    if (!allowed() || busy() || !entry || entry.protected || input.disabled || !input.matches('input[type="checkbox"]')
      || !payload.catalog.some(permission => permission.id === input.value)) return;
    const value = draft(entry); if (entry.kind === 'position' && value.inherit) return;
    value.dirty = true; value.reset = false;
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
    const restoreFocus = document.activeElement === input;
    render();
    if (restoreFocus) [...list.querySelectorAll('input[type="checkbox"]')].find(box => box.value === input.value)?.focus({ preventScroll: true });
    hint.textContent = 'Ungespeicherte Änderungen. Abhängige Rechte wurden mit angepasst.';
  }
  byId('permissionDefaultsReset').addEventListener('click', () => {
    const entry = selected(); if (!allowed() || busy() || !entry || entry.protected || (entry.kind === 'role' && !entry.builtinPermissions)) return;
    const value = draft(entry); value.permissions = new Set(entry.builtinPermissions || []);
    value.inherit = entry.kind === 'position'; value.reset = true; value.dirty = true; value.revision = entry.revision; render();
  });
  save.addEventListener('click', async () => {
    const entry = selected(); if (!allowed() || busy() || !entry || entry.protected) return;
    const value = draft(entry); if (!value.dirty) return;
    loadController?.abort(); loadGeneration += 1;
    const context = { actor, entryKey: key(entry) }; saveContext = context; render();
    const current = () => saveContext === context && context.actor === actorKey() && allowed();
    try {
      const result = await api(`/api/portal/v1/rights/defaults/${entry.kind}/${encodeURIComponent(entry.id)}`, {
        method: 'PUT', body: JSON.stringify({ revision: value.revision, permissions: [...value.permissions], reset: entry.kind === 'position' ? value.inherit : value.reset }),
      });
      if (!current()) return;
      payload = result; drafts.delete(key(entry));
      await refreshRights();
      if (!current()) return;
      toast(`Standard gespeichert. ${result.affected} Zugänge wurden aktualisiert.`);
    } catch (error) { if (current()) toast(error.message, true); }
    finally { if (saveContext === context) { saveContext = null; render(); } }
  });
  return { load };
}
