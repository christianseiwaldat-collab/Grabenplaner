(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GrabenplanerSecuritySast = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';
  const ENDPOINT = '/api/security-audits/sast';
  const DEADLINES = { current: 'Frist gültig', due_soon: 'In 14 Tagen fällig', expired: 'Abgelaufen' };
  const SOURCES = { matches: 'Prüfkontext stimmt überein', changed: 'Quellstand geändert', incomplete: 'Prüfkontext unvollständig' };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  function filtered(reviews, deadline, source, pending) {
    return (reviews || []).filter(row => (!deadline || row.deadlineState === deadline) && (!source || row.sourceState === source) && (!pending || row.requiresReview));
  }
  const searchText = row => [row.rule, row.path, row.reason, row.reviewer, row.fingerprint].join(' ');
  function detailMarkup(row) {
    const fields = [['Regel', row.rule], ['Fundstelle', `${row.path}:${row.start?.line}:${row.start?.column}`], ['Einordnung', 'Geprüfter Fehlalarm'],
      ['Priorität', row.priority], ['Frist', DEADLINES[row.deadlineState]], ['Quellbindung', SOURCES[row.sourceState]],
      ['Bewertet am', row.reviewedOn], ['Gültig bis einschließlich (UTC)', row.expiresOn], ['Prüfende Person / Stelle', row.reviewer],
      ['Begründung', row.reason], ['Fundstellenkennung', row.fingerprint], ['Bewerteter Datei-Hash', row.sourceSha256]];
    return `<dl class="security-audits-detail">${fields.map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl><h3>Gebundener Prüfkontext</h3><ul class="security-audits-evidence">${(row.context || []).map(item => `<li><code>${escape(item.path)}</code><strong>${escape({ matches: 'Unverändert', changed: 'Geändert – erneut prüfen', not_installed: 'In dieser Installation nicht vorhanden' }[item.state] || 'Ungeklärt')}</strong><p>${escape(item.reason)}</p><code>${escape(item.sha256)}</code></li>`).join('')}</ul>`;
  }
  function mount(host, options = {}) {
    if (!host || typeof options.api !== 'function') return null;
    let active = false, disposed = false, generation = 0, controller = null, payload = null, table = null, loading = null;
    let deadline = '', source = '', pending = false, focusOrigin = null;
    const user = () => typeof options.user === 'function' ? options.user() : options.user;
    const key = () => String(typeof options.accessKey === 'function' ? options.accessKey() : JSON.stringify(user()));
    const actorKey = key();
    const current = () => !disposed && key() === actorKey && root.GrabenplanerSecurityAudits?.accessAllowed(user()) === true;
    const el = selector => host.querySelector(selector);
    function clear() {
      generation++; controller?.abort(); controller = null; loading = null; payload = null;
      table?.destroy(); table = null; el('[data-sast-dialog]')?.close?.(); host.replaceChildren();
    }
    function status(text) { const target = el('[data-sast-status]'); if (target) target.textContent = text; }
    function closeDetail() { el('[data-sast-dialog]')?.close?.(); const dialog = el('[data-sast-dialog]'); if (dialog) { dialog.hidden = true; dialog.replaceChildren(); } if (focusOrigin?.isConnected) focusOrigin.focus?.(); focusOrigin = null; }
    function openDetail(row) {
      if (!active || !current()) return;
      const dialog = el('[data-sast-dialog]'); if (!dialog) return;
      focusOrigin = host.ownerDocument?.activeElement;
      dialog.innerHTML = `<div class="privacy-org-dialog-shell"><div class="privacy-org-editor-heading"><div><span class="privacy-org-kicker">Technische Sicherheit</span><h2>SAST-Bewertung</h2></div><button type="button" class="privacy-org-close" data-sast-action="close" aria-label="Bewertung schließen">×</button></div><div class="privacy-org-editor-body">${detailMarkup(row)}</div><div class="privacy-org-editor-actions"><span>Änderungen benötigen Quellprüfung und erneuten Scan.</span><button type="button" class="secondary-button" data-sast-action="close">Schließen</button></div></div>`;
      dialog.hidden = false; dialog.showModal?.();
    }
    function rows(includeSearch = false) {
      const result = filtered(payload?.reviews, deadline, source, pending);
      const query = includeSearch ? (el('[data-sast-table] input[type="search"]')?.value || '').trim().toLocaleLowerCase('de-AT') : '';
      return query ? result.filter(row => searchText(row).toLocaleLowerCase('de-AT').includes(query)) : result;
    }
    function renderTable() {
      table?.destroy(); table = null;
      const target = el('[data-sast-table]'); if (!target) return;
      const factory = options.tableFactory || root.RightsSettingsTable?.mount;
      if (typeof factory !== 'function') { target.textContent = 'Die Tabellenansicht konnte nicht geladen werden.'; return; }
      table = factory({ host: target, tableId: 'security-sast-reviews', identity: () => JSON.stringify([user()?.accountId || '', user()?.employeeNumber || '']),
        canUse: () => active && current(), rows: rows(), label: 'SAST-Bewertungen', searchLabel: 'Regel, Datei oder Begründung suchen',
        emptyText: 'Keine Bewertungen für diese Filter.', searchText,
        columns: [
          { id: 'rule', label: 'Regel / Bewertung', cell: (row, doc) => { const button = doc.createElement('button'); button.type = 'button'; button.className = 'security-audits-link'; button.textContent = row.rule; button.addEventListener('click', () => openDetail(row)); return button; } },
          { id: 'path', label: 'Datei', cell: row => `${row.path}:${row.start.line}` },
          { id: 'priority', label: 'Priorität' }, { id: 'deadlineState', label: 'Friststatus', cell: row => DEADLINES[row.deadlineState] || 'Ungeklärt' },
          { id: 'expiresOn', label: 'Gültig bis (UTC)' }, { id: 'sourceState', label: 'Quellbindung', cell: row => SOURCES[row.sourceState] || 'Ungeklärt' },
          { id: 'reviewedOn', label: 'Bewertet am', visible: false }, { id: 'reviewer', label: 'Prüfende Stelle', visible: false },
        ] });
    }
    function markup() {
      host.innerHTML = '<div class="security-audits-workspace"><div class="security-audits-heading"><div><span class="privacy-org-kicker">Technische Sicherheit</span><h2>SAST-Bewertungen</h2><p>Automatische Quellcodehinweise, ihre Einzelbewertung und fällige Nachprüfungen.</p></div><div class="security-audits-actions"><button type="button" class="secondary-button" data-sast-action="refresh">Aktualisieren</button><button type="button" class="secondary-button" data-sast-action="export" disabled>Prüfauftrag exportieren</button></div></div><p data-sast-status role="status" aria-live="polite"></p><div data-sast-content></div><dialog class="privacy-org-editor security-audits-dialog" data-sast-dialog data-gp-window-id="security-sast:detail" aria-label="SAST-Bewertung" hidden></dialog></div>';
    }
    function render() {
      const summary = payload.summary;
      el('[data-sast-content]').innerHTML = `<div class="security-audits-summary">${[['Bewertungen', summary.total], ['Abgelaufen', summary.expired], ['In 14 Tagen fällig', summary.dueSoon], ['Quellstand geändert', summary.sourceChanged], ['Prüfkontext unvollständig', summary.contextIncomplete]].map(([label, value]) => `<div class="security-audits-summary-card"><strong>${escape(value)}</strong><span>${escape(label)}</span></div>`).join('')}</div><details class="security-audits-run-details"><summary>Prüfstand und Vorgehen</summary><p>Die Einträge dokumentieren geprüfte Fehlalarme. Ihre Einstufung gilt nur innerhalb des angegebenen Umfangs.</p><ul>${payload.limits.map(text => `<li>${escape(text)}</li>`).join('')}</ul><p>Nächste Frist: <strong>${escape(summary.nextExpiry || 'Keine')}</strong>. Zuerst überfällige oder geänderte Einträge prüfen, Begründung und Regressionstests ergänzen und den vollständigen Scan erneut ausführen. Eine neue Bewertung wird mit dem geprüften Release übernommen.</p><p>Bewertungsdatei: <code>${escape(payload.policySha256)}</code></p></details><div class="security-audits-filters"><label class="field"><span>Friststatus</span><select data-sast-filter="deadline"><option value="">Alle</option>${Object.entries(DEADLINES).map(([value, label]) => `<option value="${value}"${deadline === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label><label class="field"><span>Quellbindung</span><select data-sast-filter="source"><option value="">Alle</option>${Object.entries(SOURCES).map(([value, label]) => `<option value="${value}"${source === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label><label class="switch-row"><span>Nur Nachprüfbedarf</span><input type="checkbox" data-sast-filter="pending"${pending ? ' checked' : ''}></label></div><div data-sast-table></div>`;
      el('[data-sast-action="export"]').disabled = false; renderTable();
    }
    async function load() {
      if (!active || !current()) { clear(); return false; }
      if (loading) return loading;
      if (!el('[data-sast-content]')) markup();
      const ticket = ++generation; controller = new AbortController(); status('Bewertungen werden geprüft und geladen …');
      loading = (async () => {
        try {
          const result = await options.api(ENDPOINT, { signal: controller.signal });
          if (!current() || !active || ticket !== generation) return false;
          if (result?.capabilities?.read !== true || !Array.isArray(result.reviews) || !result.summary || !Array.isArray(result.limits)) throw new Error('Unvollständiger Bewertungsstand.');
          payload = result; render(); status('Bewertungen geladen. Beim Öffnen wird kein Scan gestartet.'); return true;
        } catch (error) {
          if (!current() || !active || ticket !== generation) return false;
          payload = null; table?.destroy(); table = null; el('[data-sast-content]')?.replaceChildren(); closeDetail();
          const button = el('[data-sast-action="export"]'); if (button) button.disabled = true;
          status([401, 403, 428].includes(error.status) ? 'Zugriff nicht mehr möglich. Vertrauliche Bewertungen wurden geschlossen.' : error.message || 'Bewertungen konnten nicht geladen werden.'); return false;
        } finally { if (ticket === generation) { loading = null; controller = null; } }
      })();
      return loading;
    }
    function exportReview() {
      if (!active || !current() || !payload) return;
      const document = host.ownerDocument, blob = new Blob([JSON.stringify({ schemaVersion: 1, kind: 'sast-review-worklist', exportedAt: new Date().toISOString(), policySha256: payload.policySha256, reviews: rows(true), limits: payload.limits }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'SAST-Pruefauftrag.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    function click(event) { const action = event.target.closest('[data-sast-action]')?.dataset.sastAction; if (action === 'close') closeDetail(); else if (action === 'refresh') void load(); else if (action === 'export') exportReview(); }
    function change(event) { const filter = event.target.dataset?.sastFilter; if (filter === 'deadline') deadline = event.target.value; else if (filter === 'source') source = event.target.value; else if (filter === 'pending') pending = event.target.checked; else return; if (current() && payload) renderTable(); }
    function visibility() { if (host.ownerDocument?.hidden || !current()) { clear(); } else if (active) void load(); }
    host.addEventListener('click', click); host.addEventListener('change', change); host.ownerDocument?.addEventListener('visibilitychange', visibility);
    const guard = root.setInterval?.(() => { if (!current()) clear(); }, 1000); guard?.unref?.();
    return { async activate() { if (!current()) { clear(); return false; } active = true; return load(); },
      suspend() { active = false; clear(); }, destroy() { disposed = true; active = false; clear(); root.clearInterval?.(guard); host.removeEventListener('click', click); host.removeEventListener('change', change); host.ownerDocument?.removeEventListener('visibilitychange', visibility); } };
  }
  return { ENDPOINT, DEADLINES, SOURCES, filtered, detailMarkup, mount };
});
