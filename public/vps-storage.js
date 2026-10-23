(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VpsStorage = api;
})(typeof window === 'object' ? window : globalThis, function() {
  'use strict';
  const BASE = '/api/portal/v1/vps-storage';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const bytes = value => Number.isFinite(value) ? new Intl.NumberFormat('de-AT', { maximumFractionDigits: 1 }).format(value / 1024 ** 3) + ' GiB' : 'Nicht gemessen';
  const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('de-AT') : 'Noch nicht geprüft';
  const phases = { preparing:'Wartung wird vorbereitet', running:'Speicher wird geprüft', backup:'Sicherung vor der Bereinigung läuft', retiring:'Ersetzte Importkopien werden entfernt', compacting:'Importtabellen werden verdichtet', starting:'GP startet wieder', complete:'Abgeschlossen', failed:'Prüfung benötigt Aufmerksamkeit' };
  const running = report => report?.operation && !['complete', 'failed'].includes(report.operation.phase);
  function mount({ opener, dialog, api, key, canUse, active = () => true }) {
    let owner = key(), epoch = 0, report = null, request = null, timer = null, opened = false, pending = false, confirmation = null, tab = 'overview', destroyed = false;
    const doc = dialog.ownerDocument, win = doc.defaultView, content = dialog.querySelector('[data-storage-content]'), status = dialog.querySelector('[data-storage-status]');
    const removers = [], on = (node, type, handler) => { node.addEventListener(type, handler); removers.push(() => node.removeEventListener(type, handler)); };
    const valid = () => !destroyed && opened && canUse() && active() && owner === key();
    const cancel = () => { epoch++; request?.abort(); request = null; win.clearTimeout(timer); timer = null; pending = false; };
    function sync() {
      opener.hidden = !canUse();
      if (owner !== key() || !canUse() || !active()) { cancel(); owner = key(); report = null; confirmation = null; opened = false; content.innerHTML = ''; if (dialog.open) dialog.close(); }
    }
    const metric = (label, value, note = '') => `<article><small>${escape(label)}</small><strong>${escape(value)}</strong><span>${escape(note)}</span></article>`;
    const list = rows => `<dl class="vps-storage-list">${rows.map(([label, value, note]) => `<div><dt>${escape(label)}${note ? `<small>${escape(note)}</small>` : ''}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>`;
    function render() {
      if (!valid()) return;
      const existingForm = tab === 'settings' ? content.querySelector('[data-storage-settings]') : null;
      const settingsDraft = existingForm ? { warningGiB:existingForm.elements.warningGiB.value, orphanAgeDays:existingForm.elements.orphanAgeDays.value } : null;
      dialog.querySelectorAll('[data-storage-tab]').forEach(button => { const selected = button.dataset.storageTab === tab; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; });
      const busy = pending || running(report), writable = report?.canWrite === true;
      dialog.querySelector('[data-storage-inspect]').disabled = busy || report?.available === false;
      if (!report?.checkedAt) { content.innerHTML = `<div class="vps-storage-empty"><h3>Speicherzustand prüfen</h3><p>${escape(report?.reason || 'Die Prüfung misst Speicherbelegung, Sicherungspunkte und ersetzte Importstände.')}</p></div>`; return; }
      const enabled = available => !busy && writable && available;
      if (tab === 'overview') {
        const used = Math.max(0, Math.min(100, 100 * report.disk.usedBytes / report.disk.totalBytes));
        content.innerHTML = `<div class="vps-storage-metrics">${metric('Frei', bytes(report.disk.freeBytes), 'Für GP und Betriebssystem verfügbar')}${metric('Sales-Datenbank', bytes(report.databases.find(d => d.domain === 'sales')?.bytes), 'Daten und Indizes')}${metric('Reserve nach Restore-Plan', bytes(report.recovery.restoreMarginBytes), report.recovery.warning ? 'Unter der eingestellten Zusatzreserve' : 'Sicherungskopien und Restore berücksichtigt')}</div>
          <section class="vps-storage-section"><header><h3>VPS-Speicher</h3><span>${escape(bytes(report.disk.totalBytes))} gesamt</span></header><div class="vps-storage-meter" role="meter" aria-label="Speicher belegt" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(used)}"><i style="width:${used}%"></i></div>
          ${list([...report.categories.map(item => [item.label, bytes(item.bytes)]), ['Systemreserve', bytes(report.disk.reservedBytes), 'Vom Dateisystem reserviert']])}</section>
          <section class="vps-storage-section"><h3>Wiederherstellbarkeit</h3>${list([['Restore-Bedarf', bytes(report.recovery.requiredBytes)], ['Temporäre Sicherungskopien', bytes(report.recovery.temporaryBytes)], ['Zusätzliche Warnreserve', report.settings.warningGiB + ' GiB'], ['Lokale Sicherungspunkte', String(report.backups.points.length), 'Aufbewahrung: ' + (report.backups.keepCount ?? 'Tagesregel')]])}<p>Der Restore-Bedarf verwendet denselben Schutzwert wie die Assurance.</p></section>
          <section class="vps-storage-section"><h3>Daten und Suche</h3>${list([['Alle Sales-Indizes', bytes(report.indexBytes), 'Such-, Primärschlüssel- und Eindeutigkeitsindizes'], ['Import → GP-Zuordnungen', bytes(report.identityLinkBytes), 'Einschließlich eigener Indizes; kein zusätzlicher Indexbetrag']])}<details><summary>Größte Datenbankbereiche</summary>${list(report.relations.map(item => [item.schema + '.' + item.name, bytes(item.totalBytes), 'Daten ' + bytes(item.dataBytes) + ' · Indizes ' + bytes(item.indexBytes)]))}</details></section>
          <section class="vps-storage-section"><h3>VPS-Informationen</h3>${list([['System', report.host.system + ' ' + report.host.release], ['Prozessoren', String(report.host.cpuCount)], ['Arbeitsspeicher', bytes(report.host.memoryTotalBytes)], ['Laufzeit', Math.floor(report.host.uptimeSeconds / 3600) + ' Stunden']])}</section>`;
      } else if (tab === 'backups') {
        const candidates = report.backups.candidates;
        content.innerHTML = `<section class="vps-storage-section"><h3>Unvollständige Sicherungsreste</h3><p>Geprüft werden ausschließlich alte, unversiegelte Sicherungsverzeichnisse von GP. Unbekannte Dateien bleiben erhalten.</p>
          ${candidates.length ? list(candidates.map(item => [item.name, bytes(item.bytes), 'Letzte Änderung: ' + date(item.modifiedAt)])) : '<p class="vps-storage-good">Keine alten Sicherungsreste gefunden.</p>'}
          ${report.backups.unknownCount ? `<p>${report.backups.unknownCount} unbekannte oder jüngere Einträge werden nicht zur Bereinigung freigegeben.</p>` : ''}
          <button type="button" class="secondary-button" data-storage-review="cleanup" ${enabled(report.backups.canCleanup) ? '' : 'disabled'}>Bereinigung prüfen</button></section>
          <section class="vps-storage-section"><h3>Erhaltene Sicherungspunkte</h3>${list(report.backups.points.map(item => [date(item.createdAt), bytes(item.bytes), 'Versiegelter Sicherungspunkt']))}<p>Vor jeder Bereinigung werden mindestens zwei vollständige Sicherungspunkte einschließlich aller Dateiinhalte geprüft.</p></section>`;
      } else if (tab === 'imports') {
        const imports = report.imports;
        content.innerHTML = `<section class="vps-storage-section"><h3>Ersetzte Importstände</h3><p>Ein vollständig übernommener Folgeimport derselben Datenbank gibt seine Vorgänger zur Bereinigung frei. Entfernt werden Roh- und Prüfkopien, Rücknahmekopien und unbenutzte gemeinsame Speicherblöcke.</p>
          <p>Artikel, Belege, Bestellungen, Reparaturen, aktuelle Zuordnungen und Suchindizes bleiben erhalten. Kleine Herkunftsbelege bleiben bestehen, wenn aktuelle GP-Daten darauf verweisen.</p>
          ${imports.pairs.length ? list(imports.pairs.map(item => [item.label + ' · ' + date(item.createdAt), item.rows.toLocaleString('de-AT') + ' Importzeilen', 'Ersetzt durch: ' + date(item.successorCreatedAt)])) : '<p class="vps-storage-good">Keine freigegebenen Vorgänger vorhanden.</p>'}
          ${imports.blocked.map(item => `<p><b>${escape(item.label)}:</b> ${escape(item.reason)}</p>`).join('')}
          <p>Freigegeben: ${imports.rows.toLocaleString('de-AT')} Roh-/Prüfzeilen und ${imports.changes.toLocaleString('de-AT')} Rücknahmeeinträge. Die tatsächlich frei gewordene Größe wird danach neu gemessen.</p>
          <button type="button" class="secondary-button" data-storage-review="retire-imports" ${enabled(imports.canRetire) ? '' : 'disabled'}>Importbereinigung prüfen</button></section>`;
      } else {
        content.innerHTML = `<form data-storage-settings class="vps-storage-section"><h3>Speicheroptionen</h3><label class="field"><span>Warnung unter zusätzlicher Restore-Reserve (GiB)</span><input name="warningGiB" type="number" min="2" max="50" step="1" required value="${report.settings.warningGiB}"></label>
          <label class="field"><span>Unvollständige Sicherungsreste frühestens nach (Tagen)</span><input name="orphanAgeDays" type="number" min="7" max="90" step="1" required value="${report.settings.orphanAgeDays}"></label>
          <p>Die Warnreserve ergänzt den erforderlichen Restore-Platz. Die Mindestreserve der Assurance bleibt bestehen.</p><button class="primary-button" type="submit" ${enabled(true) ? '' : 'disabled'}>Optionen speichern</button></form>`;
      }
      if (confirmation) {
        const action = confirmation.action, imports = action === 'retire-imports';
        content.insertAdjacentHTML('beforeend', `<section class="vps-storage-confirm"><h3>Bereinigungsplan bestätigen</h3><p>${imports ? 'Die oben aufgeführten Vorgänger werden nach einer vollständig geprüften Sicherung entfernt. GP ist während der Sicherung und Verdichtung im Wartungsmodus; der aktuelle Import und die Geschäftsdaten bleiben verfügbar.' : 'Ausschließlich die oben aufgeführten unvollständigen Sicherungsreste werden entfernt. Die vollständigen Sicherungspunkte bleiben erhalten.'}</p><div><button type="button" class="secondary-button" data-storage-cancel>Abbrechen</button><button type="button" class="primary-button" data-storage-confirm ${busy ? 'disabled' : ''}>${imports ? 'Sichern und Importkopien entfernen' : 'Geprüfte Sicherungsreste entfernen'}</button></div></section>`);
      }
      if (settingsDraft) {
        const form = content.querySelector('[data-storage-settings]');
        if (form) for (const [name,value] of Object.entries(settingsDraft)) form.elements[name].value=value;
      }
    }
    async function read() {
      if (!valid() || request) return;
      const ticket = epoch, controller = new AbortController(); request = controller;
      try {
        const value = await api(BASE, { signal: controller.signal });
        if (!valid() || ticket !== epoch || controller.signal.aborted) return;
        const oldHash = confirmation?.sha;
        report = value;
        if (confirmation && oldHash !== (confirmation.action === 'cleanup' ? report.backups?.planSha256 : report.imports?.planSha256)) confirmation = null;
        status.textContent = running(report) ? phases[report.operation.phase] || 'Wartung läuft' : report.operation?.phase === 'failed'
          ? 'Die Prüfung wurde angehalten: ' + report.operation.code : 'Datenstand: ' + date(report.checkedAt);
        render();
      } catch (error) {
        if (valid() && ticket === epoch && !controller.signal.aborted) status.textContent = running(report)
          ? 'Wartung läuft. Die Verbindung wird nach dem GP-Start wieder geprüft.' : error.message;
      } finally {
        if (request === controller) request = null;
        if (valid() && (pending || running(report))) timer = win.setTimeout(read, 5000);
      }
    }
    async function queue(action, body = {}) {
      if (!valid() || pending || running(report)) return;
      pending = true; const ticket = epoch; confirmation = null; render(); status.textContent = 'Auftrag wird übergeben …';
      try {
        await api(BASE + '/' + action, { method: action === 'settings' ? 'PUT' : 'POST', body: JSON.stringify(body) });
        if (!valid() || ticket !== epoch) return;
        report = { ...report, operation: { action, phase: 'running' } }; status.textContent = 'Auftrag angenommen.';
      } catch (error) { if (valid() && ticket === epoch) status.textContent = error.message; }
      finally { if (valid() && ticket === epoch) { pending = false; render(); win.clearTimeout(timer); timer = win.setTimeout(read, 1000); } }
    }
    on(opener, 'click', () => { sync(); if (!canUse() || !active()) return; opened = true; tab = 'overview'; confirmation = null;
      win.GpWindow?.begin(dialog); win.GpWindow?.prepare(dialog); if (!dialog.open) dialog.showModal(); opener.setAttribute('aria-expanded','true'); render(); void read(); });
    on(dialog, 'close', () => { opened = false; cancel(); confirmation = null; opener.setAttribute('aria-expanded', 'false'); });
    on(dialog, 'click', event => {
      const button = event.target.closest('button'); if (!button || !valid()) return;
      if (button.hasAttribute('data-storage-close')) return dialog.close();
      if (button.dataset.storageTab) { tab = button.dataset.storageTab; confirmation = null; render(); return; }
      if (button.hasAttribute('data-storage-inspect')) return void queue('inspect');
      if (button.dataset.storageReview) { const action = button.dataset.storageReview;
        const plan = action === 'cleanup' ? report.backups : report.imports;
        if (!report.canWrite || running(report) || pending || !(action === 'cleanup' ? plan.canCleanup : plan.canRetire)) return;
        confirmation = { action, sha: plan.planSha256 }; render(); content.querySelector('[data-storage-confirm]')?.focus(); return;
      }
      if (button.hasAttribute('data-storage-cancel')) { confirmation = null; render(); return; }
      if (button.hasAttribute('data-storage-confirm') && confirmation) {
        const { action, sha } = confirmation;
        if (sha !== (action === 'cleanup' ? report.backups.planSha256 : report.imports.planSha256)) return;
        void queue(action, { planSha256: sha, confirmation: action === 'cleanup' ? 'VPS_STORAGE_CLEANUP' : 'VPS_STORAGE_RETIRE_IMPORTS' });
      }
    });
    on(dialog, 'submit', event => { if (!event.target.matches('[data-storage-settings]')) return; event.preventDefault();
      if (!report.canWrite || !event.target.reportValidity()) return;
      const form = event.target; void queue('settings', { warningGiB: Number(form.elements.warningGiB.value), orphanAgeDays: Number(form.elements.orphanAgeDays.value) });
    });
    on(dialog, 'keydown', event => {
      if (!event.target.matches('[data-storage-tab]') || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      const buttons = [...dialog.querySelectorAll('[data-storage-tab]')], index = buttons.indexOf(event.target);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      event.preventDefault(); buttons[next].click(); buttons[next].focus();
    });
    sync();
    return { sync, destroy() { cancel(); opened = false; destroyed = true; if (dialog.open) dialog.close(); content.innerHTML = ''; removers.forEach(remove => remove()); } };
  }
  return { mount, bytes, escape };
});
