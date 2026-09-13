(function attach(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GrabenplanerImportMappings = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function mappingModule() {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fields = { firstName: 'Vorname', lastName: 'Nachname', street: 'Straße', addressSupplement: 'Adresszusatz', postalCode: 'PLZ',
    city: 'Ort', country: 'Land', phone: 'Telefon', email: 'E-Mail', vatId: 'UID', birthDate: 'Geburtstag (JJJJ-MM-TT)' };
  const status = row => row.binding ? row.binding.sourceChanged ? 'Quelle geändert' : row.binding.historical ? 'Historisch zugeordnet' : 'Zugeordnet' : 'Zuordnung offen';
  const option = (id, label) => '<option value="' + esc(id) + '">' + esc(label) + '</option>';
  function renderRows(rows, sort = { key: 'number', direction: 1 }) {
    return '<div class="data-import-scroll" tabindex="0"><table><caption>Sortierung der aktuellen Seite</caption><thead><tr>'
      + [['number', 'Quellnummer'], ['label', 'Bezeichnung / Name']].map(([key, label]) => '<th scope="col" aria-sort="' + (sort.key === key ? sort.direction === 1 ? 'ascending' : 'descending' : 'none') + '"><button type="button" data-m-sort="' + key + '">' + label + '</button></th>').join('')
      + '<th scope="col">Zuordnung</th><th scope="col">Aktion</th></tr></thead><tbody>'
      + [...rows].sort((a, b) => String(a[sort.key] || '').localeCompare(String(b[sort.key] || ''), 'de-AT', { numeric: true }) * sort.direction)
        .map(row => '<tr><td>' + esc(row.number) + '</td><td>' + esc(row.label || 'Ohne Bezeichnung') + '</td><td>' + esc(status(row)) + (row.binding ? ' · ' + esc(row.binding.targetId) : '')
          + '</td><td><button type="button" class="text-button" data-m-select="' + esc(row.id) + '">Prüfen</button></td></tr>').join('')
      + (rows.length ? '' : '<tr><td colspan="4">Keine passenden übernommenen Stammsätze. Die geschützte Importvorschau allein legt noch keine Stammdaten an.</td></tr>') + '</tbody></table></div>';
  }
  function renderEditor(row, grant, enabled) {
    const customer = row.table === 'KUNDEN', bound = !!row.binding, editable = grant.write && (customer || !bound);
    return '<h3>' + esc(row.number) + ' · ' + esc(row.label || 'Ohne Bezeichnung') + '</h3><p>Quellrevision ' + row.revision + ' · ' + esc(status(row)) + '</p>'
      + '<p>Es wird nichts anhand gleicher Namen oder Nummern automatisch verbunden. Eine Zuordnung ändert keine Personalrechte, Sollstunden, Standorteinstellungen oder aktuellen Artikelpreise.</p>'
      + (editable ? '<form data-m="edit"><div class="import-mapping-fields">'
        + (customer
          ? '<p class="import-mapping-wide">Kunden-Kontonummer: ' + esc(row.number) + '. Name, Kundenart und Kontaktdaten dürfen fehlen.</p><label>Kundentyp (optional)<select data-m="type">' + option('unknown', 'Nicht angegeben') + option('private', 'Privat') + option('business', 'Gewerblich') + '</select></label><label>Firmenname<input data-m="company" maxlength="160"></label>'
            + Object.entries(fields).map(([key, label]) => '<label>' + label + '<input data-m-field="' + key + '" value="' + esc(row.customer?.[key] || '') + '" maxlength="500"></label>').join('')
            + (!bound && row.candidate ? '<label class="import-mapping-wide"><input type="checkbox" data-m="existing"> Vorhandene CRM-Karte ausdrücklich verbinden: ' + esc(row.candidate.label) + ' · ' + esc(row.candidate.id) + '</label>' : '')
            + '<p class="import-mapping-wide">Korrekturen gelten nur für die CRM-Karte; die Originalwerte bleiben erhalten. Manuelle Website, Fotos und eigene Textfelder bleiben unberührt.</p>'
          : row.table === 'ARTIKEL_STAMM'
            ? '<p class="import-mapping-wide">' + (row.candidate ? 'Bestehende zentrale Artikelbindung: ' + esc(row.candidate.articleNumber) + ' · ' + esc(row.candidate.id) : 'Noch keine geprüfte Quellbindung im zentralen Artikelstamm. Keine ersatzweise Neuanlage.') + '</p>'
            : '<div class="import-mapping-wide"><label>GP-Nummer / Standort-ID (exakt, leer für Liste)<input data-m="target-query" maxlength="120"></label><button type="button" data-m="targets">GP-Ziele suchen</button><button type="button" data-m="targets-next" hidden>Weitere GP-Ziele</button><label>GP-Ziel bewusst auswählen<select data-m="target" required>' + option('', 'Bitte zuerst GP-Ziele laden') + '</select></label></div>')
        + (!customer ? '<label><input type="checkbox" data-m="historical"> Historische Zuordnung (auch inaktives GP-Ziel)</label><label>Begründung<input data-m="reason" maxlength="1000" required></label>' : '')
        + '</div><button type="submit" class="secondary-button">Zuordnung prüfen</button></form>' : '')
      + '<div data-m="preview"></div><button type="button" data-m="apply" class="primary-button" hidden' + (!enabled ? ' disabled' : '') + '>Geprüfte Zuordnung bestätigen</button>'
      + (row.undoEventId && grant.undo ? '<button type="button" data-m="undo" class="secondary-button"' + (!enabled ? ' disabled' : '') + '>Eigene letzte Zuordnung zurücknehmen</button>' : '');
  }
  function mount(root, { api, confirm = message => globalThis.confirm(message) }) {
    const body = root.querySelector('[data-mapping-body]');
    let disposed = false, generation = 0, controller, loaded = false, context, rows = [], next = null, selected = null, plan = null, request = null, targetsNext = null;
    let sort = { key: 'number', direction: 1 }, busy = false, writing = false;
    const el = name => body.querySelector('[data-m="' + name + '"]');
    const grant = () => context.projection.tables.find(t => t.table === el('table').value);
    function abort() { generation++; controller?.abort(); controller = null; busy = false; }
    function invalidate() { plan = request = null; if (el('apply')) el('apply').hidden = true; if (el('preview')) el('preview').textContent = ''; }
    function clear() { abort(); invalidate(); rows = []; selected = null; next = null;
      if (el('rows')) el('rows').replaceChildren(); if (el('editor')) el('editor').replaceChildren(); if (el('next')) el('next').hidden = true; }
    async function call(action, input, accept) {
      if (busy || disposed) return;
      busy = true; const ticket = ++generation; controller = new AbortController(); body.setAttribute?.('aria-busy', 'true');
      writing = ['apply', 'undo'].includes(action);
      const controls = writing ? [...body.querySelectorAll('input,select,button')].map(element => ({ element, disabled: element.disabled })) : [];
      for (const { element } of controls) element.disabled = true;
      try {
        const result = await api('/api/data-import/mappings/' + action, { method: 'POST', body: JSON.stringify(input), signal: controller.signal });
        if (!disposed && ticket === generation) accept(result);
      } catch (error) {
        if (!disposed && ticket === generation) { invalidate(); el('message').textContent = error.message || 'Die Zuordnung konnte nicht geprüft werden.'; }
      } finally { for (const { element, disabled } of controls) element.disabled = disabled;
        if (!disposed && ticket === generation) { busy = false; writing = false; body.removeAttribute?.('aria-busy'); } }
    }
    function search(more = false) {
      const input = { table: el('table').value, key: el('key').value.trim(), status: el('status').value, after: more ? next : '' };
      invalidate(); selected = null; el('editor').replaceChildren();
      return call('search', input, result => { rows = result.items; next = result.next; el('rows').innerHTML = renderRows(rows, sort); el('next').hidden = !next; el('message').textContent = rows.length + ' Stammsätze auf dieser Seite.'; });
    }
    function buildRequest() {
      const value = { recordId: selected.id, expectedSourceRevision: selected.revision };
      if (selected.table === 'KUNDEN') {
        const corrections = {};
        for (const [key] of Object.entries(fields)) {
          const raw = body.querySelector('[data-m-field="' + key + '"]').value;
          if (raw !== String(selected.customer?.[key] || '')) corrections[key] = key === 'birthDate' && !raw ? null : raw;
        }
        value.decision = { customerType: el('type').value, companyName: el('company').value, corrections };
        if (el('existing')?.checked) Object.assign(value, { targetId: selected.candidate.id, expectedTargetRevision: selected.candidate.revision });
      } else Object.assign(value, { targetId: selected.table === 'ARTIKEL_STAMM' ? selected.candidate?.id : el('target').value,
        historical: el('historical').checked, reason: el('reason').value.trim() });
      return value;
    }
    async function onClick(event) {
      const button = event.target.closest('button'); if (!button || !body.contains(button) || busy) return;
      if (button.dataset.mSort) { const key = button.dataset.mSort; sort = { key, direction: sort.key === key ? -sort.direction : 1 }; el('rows').innerHTML = renderRows(rows, sort); return; }
      if (button.dataset.mSelect) {
        selected = rows.find(r => r.id === button.dataset.mSelect); if (!selected) return;
        invalidate(); targetsNext = null; el('editor').innerHTML = renderEditor(selected, grant(), context.activationEnabled); return;
      }
      const action = button.dataset.m;
      if (action === 'next') return search(true);
      if (['targets', 'targets-next'].includes(action)) {
        invalidate();
        const query = el('target-query').value.trim(), after = action === 'targets-next' ? targetsNext : '';
        return call('targets', { table: selected.table, query, after }, result => {
          el('target').innerHTML = option('', 'Bitte auswählen') + result.items.map(t => option(t.id, t.id + ' · ' + t.label + (t.active ? '' : ' · inaktiv'))).join('');
          targetsNext = result.next; el('targets-next').hidden = !targetsNext;
        });
      }
      if (action === 'apply' && plan && request) {
        if (!confirm('Diese geprüfte Zuordnung jetzt verbindlich speichern?')) return;
        return call('apply', { table: selected.table, request, planHash: plan.planHash }, result => {
          invalidate(); selected = null; rows = []; el('editor').replaceChildren(); el('rows').replaceChildren(); el('next').hidden = true;
          el('message').textContent = 'Zuordnung gespeichert. Prüfprotokoll: ' + result.eventId + '. Bitte die Liste neu laden.';
        });
      }
      if (action === 'undo' && selected?.undoEventId && confirm('Eigene letzte Zuordnung zurücknehmen? Spätere Änderungen und abhängige Historie werden erneut geprüft.')) {
        return call('undo', { table: selected.table, eventId: selected.undoEventId }, () => {
          invalidate(); rows = []; selected = null; el('editor').replaceChildren(); el('rows').replaceChildren(); el('next').hidden = true; el('message').textContent = 'Zuordnung zurückgenommen. Bitte die Liste neu laden.';
        });
      }
    }
    function onSubmit(event) {
      event.preventDefault(); if (busy) return;
      if (event.target === el('search')) { void search(); return; }
      if (event.target === el('edit') && selected) {
        invalidate(); request = buildRequest();
        void call('preview', { table: selected.table, request }, result => {
          plan = result; el('preview').textContent = 'Geprüfte Aktion: ' + ({ create: 'CRM-Karte anlegen', link: 'Vorhandene CRM-Karte verbinden', sync: 'Quellfelder abgleichen' }[result.action] || 'GP-Referenz verbinden')
            + ' · Ziel: ' + (result.targetId || 'Neue CRM-Karte') + (result.changedFields?.length ? ' · Felder: ' + result.changedFields.join(', ') : '');
          el('apply').hidden = false; el('apply').disabled = !context.activationEnabled;
        });
      }
    }
    function onInput(event) {
      if (writing) return;
      if (el('search')?.contains(event.target)) clear();
      else { abort(); invalidate(); if (event.target === el('target-query')) { targetsNext = null; el('targets-next').hidden = true; el('target').innerHTML = option('', 'Bitte GP-Ziele erneut suchen'); } }
    }
    const containers=[];
    for(let node=root.parentElement;node;node=node.parentElement) if(node.matches?.('.view,.settings-section,details')) containers.push(node);
    const visible=()=>root.open && !globalThis.document?.hidden && containers.every(node=>!node.classList.contains('hidden')
      && (node.matches('details')?node.open:node.classList.contains('active')));
    async function load() {
      if (loaded || disposed || !visible()) return; loaded = true; const ticket = ++generation; controller = new AbortController();
      body.textContent = 'Zuordnungsrechte werden geprüft …';
      try {
        const response = await api('/api/data-import/mappings/context', { signal: controller.signal });
        if (disposed || ticket !== generation) return;
        context = response;
        if (!context.projection?.read) { body.textContent = 'Keine freigegebene Stammdaten-Zuordnung.'; return; }
        body.innerHTML = '<p>' + esc(context.message) + '</p>' + (!context.activationEnabled ? '<p class="sales-history-review">Produktive Zuordnungen sind noch nicht freigegeben. Prüfen verändert keine GP-Stammdaten.</p>' : '')
          + '<form data-m="search" class="import-mapping-fields"><label>Bereich<select data-m="table">' + context.projection.tables.map(t => option(t.table, t.label)).join('')
          + '</select></label><label>Quellnummer (exakt, führende Nullen erhalten)<input data-m="key" maxlength="256" autocomplete="off"></label><label>Status<select data-m="status">'
          + option('unlinked', 'Zuordnung offen') + option('linked', 'Bereits zugeordnet') + option('all', 'Alle') + '</select></label><button type="submit" class="secondary-button">Stammsätze suchen</button></form>'
          + '<p data-m="message" role="status" aria-live="polite">Zuerst einen Bereich und bei Bedarf eine Quellnummer auswählen.</p><div data-m="rows"></div><button type="button" data-m="next" hidden>Weitere Stammsätze</button><section data-m="editor"></section>';
      } catch (error) { if (!disposed && ticket === generation) { body.textContent = error.message || 'Zuordnung nicht verfügbar.'; loaded = false; } }
    }
    function onToggle() { if (visible()) void load(); else { clear(); loaded = false; body.replaceChildren(); } }
    function onVisibility() { onToggle(); }
    const observer=containers.length&&globalThis.MutationObserver?new MutationObserver(onVisibility):null;
    for(const container of containers) observer?.observe(container,{attributes:true,attributeFilter:['class','open']});
    body.addEventListener('click', onClick); body.addEventListener('submit', onSubmit); body.addEventListener('input', onInput);
    root.addEventListener('toggle', onToggle); globalThis.document?.addEventListener('visibilitychange', onVisibility);
    if (root.open) void load();
    return { destroy() { disposed = true; abort(); observer?.disconnect(); rows = []; selected = plan = request = context = null; body.replaceChildren();
      body.removeEventListener('click', onClick); body.removeEventListener('submit', onSubmit); body.removeEventListener('input', onInput);
      root.removeEventListener('toggle', onToggle); globalThis.document?.removeEventListener('visibilitychange', onVisibility); } };
  }
  return { mount, renderRows, renderEditor };
}));
