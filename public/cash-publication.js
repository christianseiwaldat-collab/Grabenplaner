(function attach(root, factory) { 'use strict'; const api = factory(); if (typeof module === 'object' && module.exports) module.exports = api; if (root) root.GrabenplanerCashPublication = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const names = { FILIALEN: 'Filiale', MITARBEITER: 'Verkäufer', KUNDEN: 'Kunde', ARTIKEL_STAMM: 'Artikel' };
  function renderMappings(items) { return items.map((m, i) => `<li>${escape(names[m.kind])} ${escape(m.sourceId)} → GP ${escape(m.targetId)}${m.historical ? ' (historisch)' : ''} <button type="button" data-c-remove="${i}" aria-label="Zuordnung entfernen">Entfernen</button></li>`).join(''); }
  function mount(root, { api, source, confirmAction = message => globalThis.confirm(message) }) {
    let disposed = false, generation = 0, formRevision = 0, context, mappings = [], prepared = null, working = false, referenceCursor = null;
    const controller = new AbortController(), el = name => root.querySelector(`[data-c="${name}"]`);
    const post = (action, body) => api('/api/data-import/cash/' + action, { method: 'POST', body: JSON.stringify(body), signal: controller.signal });
    const message = value => { if (el('message')) el('message').textContent = value; };
    const invalidate = () => { formRevision++; prepared = null; if (el('activate')) el('activate').disabled = true; };
    async function load() {
      const ticket = ++generation; root.textContent = 'Kassenstand wird geladen …';
      try {
        const result = await post('context', { sourceId: source.id }); if (disposed || ticket !== generation) return; context = result;
        root.innerHTML = `<h3>Kassenstand für Auswertungen</h3><p>Aktuell verwendet: ${escape(context.state.active?.label || 'Noch kein Kassenstand')}.</p>
          <p>Alle Zeiträume bleiben erhalten. Ein neuer Datenstand wird erst mit „Aktivieren“ verwendet. Bestehende Dienstplan- und Personaldaten werden dabei nicht ersetzt.</p>
          <label>Bezeichnung<input data-c="label" maxlength="160" value="Kasse · ${escape(source.createdAt.slice(0, 10))}"></label>
          <label>Geprüfte Rechenregeln<select data-c="policy">${context.policies.map(p => `<option value="${escape(p.id)}">${escape(p.label)}</option>`).join('')}</select></label>
          ${!context.policies.length ? '<p>Für diesen Dateistand fehlt noch ein bestätigtes Regelprofil. Die Quelldaten bleiben erhalten.</p>' : ''}
          <p>Quellnummern werden ausdrücklich GP-Zielen zugeordnet. Nicht zugeordnete Filialen bleiben außerhalb der regulären Standortauswertung.</p>
          <div class="data-import-form"><label>Bereich<select data-c="kind">${context.mappingProjection.tables.filter(t => t.write).map(t => `<option value="${t.table}">${escape(t.label)}</option>`).join('')}</select></label>
          <label>Quellnummer<input data-c="source" maxlength="255" autocomplete="off"></label><label>GP-Ziel<input data-c="target" maxlength="128" autocomplete="off" list="cash-publication-targets"></label>
          <datalist id="cash-publication-targets" data-c="targets"></datalist><label><input type="checkbox" data-c="historical">Historisches / inaktives Ziel ausdrücklich verwenden</label>
          <button type="button" data-c-add>Zuordnung hinzufügen</button><button type="button" data-c-references>Quellnummern anzeigen</button><button type="button" data-c-targets>GP-Ziele anzeigen</button></div>
          <p data-c="references"></p><button type="button" data-c-reference-next hidden>Weitere Quellnummern</button><ul data-c="mappings"></ul>
          <label><input type="checkbox" data-c="articles" ${context.mappingProjection.tables.some(t => t.table === 'ARTIKEL_STAMM' && t.write) ? 'checked' : 'disabled'}>Vorhandene bestätigte Artikelbindungen verwenden; keine neuen Artikel anlegen</label>
          <div class="data-import-actions"><button type="button" data-c-preview ${!context.available || !context.projection.apply || !context.policies.length ? 'disabled' : ''}>Aktivierung prüfen</button>
          <button type="button" data-c="activate" disabled>Geprüften Kassenstand aktivieren</button>
          <button type="button" data-c-rollback ${!context.available || !context.projection.undo || !context.state.previous ? 'disabled' : ''}>Zum vorherigen Kassenstand zurückkehren</button></div>
          <p data-c="message" role="status" aria-live="polite"></p>`;
      } catch (error) { if (!disposed && ticket === generation) root.textContent = error.message || 'Der Kassenstand ist nicht verfügbar.'; }
    }
    async function click(event) {
      const button = event.target.closest?.('button'); if (!button) return; event.stopPropagation(); if (working) return;
      const ticket = generation;
      try {
        if (button.hasAttribute('data-c-add')) {
          const m = { kind: el('kind').value, sourceId: el('source').value.trim(), targetId: el('target').value.trim(), historical: el('historical').checked };
          if (!m.sourceId || !m.targetId) { message('Bitte Quellnummer und GP-Ziel auswählen.'); return; }
          mappings.push(m); el('mappings').innerHTML = renderMappings(mappings); invalidate(); return;
        }
        if (button.hasAttribute('data-c-remove')) { mappings.splice(Number(button.dataset.cRemove), 1); el('mappings').innerHTML = renderMappings(mappings); invalidate(); return; }
        working = true;
        if (button.hasAttribute('data-c-references') || button.hasAttribute('data-c-reference-next')) {
          const result = await post('references', { sourceId: source.id, kind: el('kind').value, ...(button.hasAttribute('data-c-reference-next') && referenceCursor ? { after: referenceCursor } : {}) });
          if (disposed || ticket !== generation) return;
          referenceCursor = result.next; el('references').textContent = 'Quellnummern: ' + result.items.map(r => r.sourceId).join(', ');
          root.querySelector('[data-c-reference-next]').hidden = !referenceCursor;
        } else if (button.hasAttribute('data-c-targets')) {
          const table = el('kind').value;
          if (!['FILIALEN', 'MITARBEITER'].includes(table)) { message('Bitte die ID der ausdrücklich ausgewählten vorhandenen Kundenkarte oder Artikelbindung eintragen.'); return; }
          const result = await api('/api/data-import/mappings/targets', { method: 'POST', body: JSON.stringify({ table, query: el('target').value.trim(), limit: 100 }), signal: controller.signal });
          if (disposed || ticket !== generation) return;
          el('targets').innerHTML = result.items.map(r => `<option value="${escape(r.id)}">${escape(r.label)}${r.active ? '' : ' (inaktiv)'}</option>`).join('');
          message(result.items.map(r => `${r.id}: ${r.label}${r.active ? '' : ' (inaktiv)'}`).join(' · ') || 'Kein passendes GP-Ziel.');
        } else if (button.hasAttribute('data-c-preview')) {
          invalidate(); const request = { sourceId: source.id, expectedRevision: context.state.revision, label: el('label').value.trim(), policyId: el('policy').value,
            mappings: mappings.map(m => ({ ...m })), resolveArticles: el('articles').checked };
          const checkedFormRevision = formRevision;
          message('Zuordnungen und Datenstand werden geprüft …'); const result = await post('preview', { request });
          if (disposed || ticket !== generation) return;
          if (checkedFormRevision !== formRevision) { message('Die Eingaben wurden während der Prüfung geändert. Bitte die Aktivierung erneut prüfen.'); return; }
          prepared = { request, planHash: result.planHash }; el('activate').disabled = false;
          message(`${result.bindings} Zuordnungen geprüft. ${result.message}`);
        } else if (button === el('activate')) {
          if (!prepared || !confirmAction('Diesen geprüften Kassenstand jetzt für Auswertungen aktivieren? Der bisherige Stand bleibt erhalten.')) return;
          const result = await post('activate', prepared); if (disposed || ticket !== generation) return;
          mappings = []; prepared = null; await load(); message(`„${result.label}“ ist jetzt für Auswertungen ausgewählt. Eine bereits offene Auswertung bitte neu starten.`);
        } else if (button.hasAttribute('data-c-rollback')) {
          const check = await post('rollback-preview', { expectedRevision: context.state.revision });
          if (disposed || ticket !== generation || !confirmAction(`Wieder „${check.label}“ für neue Auswertungen verwenden?`)) return;
          const result = await post('rollback', { expectedRevision: check.revision, planHash: check.planHash });
          if (disposed || ticket !== generation) return; await load(); message(`Wieder ausgewählt: ${result.label}.`);
        }
      } catch (error) { if (!disposed && ticket === generation) message(error.message); }
      finally { working = false; }
    }
    function changed(event) { event.stopPropagation(); invalidate(); if (event.target === el('kind')) { referenceCursor = null; el('references').textContent = ''; el('targets').replaceChildren(); } }
    root.addEventListener('click', click); root.addEventListener('input', changed); void load();
    return { destroy() { disposed = true; generation++; controller.abort(); root.removeEventListener('click', click); root.removeEventListener('input', changed); root.replaceChildren(); mappings = []; prepared = null; } };
  }
  return { mount, renderMappings };
}));
