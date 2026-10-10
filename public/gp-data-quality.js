(function attach(host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (host) host.GrabenplanerDataQuality = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function dataQualityModule() {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const text = value => typeof value === 'string' ? value.slice(0, 300) : '';
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const own = (object, key) => object != null && Object.hasOwn(object, key);
  function sourceDate(value, kind, now) {
    if (typeof value !== 'string' || value.length > 80) return null;
    const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    if ((dayOnly && kind === 'upload') || (!dayOnly && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))) return null;
    if (!dayOnly && (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59)) return null;
    const day = Date.parse(value.slice(0, 10) + 'T00:00:00Z');
    if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
    const timestamp = Date.parse(value);
    const today = dayOnly ? Date.parse(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now)) + 'T00:00:00Z') : now;
    if (!Number.isFinite(timestamp) || timestamp > today) return null;
    const label = new Intl.DateTimeFormat('de-AT', { dateStyle: 'medium', ...(dayOnly ? { timeZone: 'UTC' } : { timeStyle: 'short' }) }).format(new Date(timestamp));
    return { value, label, ageDays: Math.floor((today - timestamp) / 86400000) };
  }
  function sourceInfo(quality, fallback = null) {
    return own(quality, 'uploadedAt') ? { kind: 'upload', timestamp: quality.uploadedAt } : { kind: 'snapshot', timestamp: fallback };
  }
  function normalize(input = {}, { now = Date.now() } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
    const clock = Number.isFinite(now) ? now : Date.now();
    const kind = input.source?.kind === 'upload' ? 'upload' : 'snapshot';
    const entries = items => (Array.isArray(items) ? items : []).slice(0, 32).map(item => ({ label: text(item?.label), count: count(item?.count) })).filter(item => item.label);
    return { title: text(input.title) || 'Datenqualität', sourceKind: kind, source: sourceDate(input.source?.timestamp, kind, clock),
      counts: entries(input.counts), issues: entries(input.issues), complete: input.complete === true ? true : input.complete === false ? false : null,
      calendarUnknown: input.calendarUnknown === true, coverage: text(input.coverage), note: text(input.note), overlap: input.overlap === true };
  }
  function render(input, options) {
    const value = normalize(input, options), n = number => number === null ? 'nicht bekannt' : number.toLocaleString('de-AT');
    const label = value.sourceKind === 'upload' ? 'Hochgeladen am' : 'Quellstand';
    const source = value.source ? `<time datetime="${escape(value.source.value)}">${escape(value.source.label)}</time> · ${value.source.ageDays ? `vor ${n(value.source.ageDays)} ${value.source.ageDays === 1 ? 'Tag' : 'Tagen'}` : 'weniger als einen Tag alt'}` : 'Datum und Alter nicht bekannt';
    const scope = value.complete === true ? 'Auswahl vollständig verarbeitet' : value.complete === false ? 'Auswahl noch nicht vollständig verarbeitet' : '';
    return `<section class="gp-data-quality" aria-label="${escape(value.title)}"><header><h3>${escape(value.title)}</h3>${scope ? `<span class="gp-data-quality-scope">${scope}</span>` : ''}</header>
      <p class="gp-data-quality-source"><strong>${label}:</strong> ${source}</p>
      ${value.counts.length ? `<dl class="gp-data-quality-counts">${value.counts.map(item => `<div><dt>${escape(item.label)}</dt><dd>${n(item.count)}</dd></div>`).join('')}</dl>` : ''}
      ${value.coverage ? `<p>${escape(value.coverage)}</p>` : ''}${value.calendarUnknown ? '<p>Die Vollständigkeit des Kalenderzeitraums ist nicht nachgewiesen. Fehlende Tage bleiben unbekannt.</p>' : ''}
      ${value.issues.length ? `<details class="gp-data-quality-issues"><summary>Prüfpunkte anzeigen · ${value.issues.length} ${value.issues.length === 1 ? 'Kategorie' : 'Kategorien'}</summary><dl>${value.issues.map(item => `<div><dt>${escape(item.label)}</dt><dd>${n(item.count)}</dd></div>`).join('')}</dl>${value.overlap ? '<p>Prüffälle können sich überschneiden; die Zahlen werden nicht zu einer Gesamtzahl addiert.</p>' : ''}</details>` : ''}
      ${value.note ? `<p class="gp-data-quality-note">${escape(value.note)}</p>` : ''}</section>`;
  }
  function stock(result = {}, projection = {}) {
    const totals = result.totals || {}, labels = { missingArticle: 'Ohne Artikelstamm', missingQuantity: 'Ohne Bestandsmenge', ambiguous: 'Mehrdeutige Zuordnung', negative: 'Negativer Bestand', unclassified: 'Artikelart ungeklärt', excluded: 'Ausgeschlossene Positionen' };
    if (projection.costs === true) Object.assign(labels, { missingCost: 'Ohne gültigen Einkaufspreis', zeroCost: 'Einkaufspreis gleich 0' });
    return { title: 'Datengrundlage · Filialbestand', source: sourceInfo(result.sourceQuality, result.sourceDate), complete: result.complete,
      counts: own(totals, 'positions') ? [{ label: 'Quellpositionen', count: totals.positions }] : [],
      issues: Object.entries(labels).filter(([key]) => own(totals, key)).map(([key, label]) => ({ label, count: totals[key] })), overlap: true,
      note: 'Gespeicherter Quellstand, keine Live-Bestandsführung. Bei offenen Prüffällen ist der Warenwert nur ein bekannter Teilwert.' };
  }
  function history(result = {}) {
    const coverage = result.coverage || {}, counts = coverage.counts || {}, unresolved = { article: 'Artikelzuordnung offen', location: 'Filialzuordnung offen', lineSeller: 'Positionsverkäufer offen', headerSeller: 'Belegverkäufer offen' };
    return { title: 'Datengrundlage · Kassenhistorie', source: sourceInfo(result.sourceQuality), complete: coverage.complete, calendarUnknown: true,
      counts: Object.entries({ records: 'Importierte Positionen', checked: 'Geprüft', review: 'Prüfung offen' }).filter(([key]) => own(counts, key)).map(([key, label]) => ({ label, count: counts[key] })),
      issues: Object.entries(unresolved).filter(([key]) => own(coverage.unresolved, key)).map(([key, label]) => ({ label, count: coverage.unresolved[key] })), overlap: true };
  }
  function abc(snapshot = {}) {
    const labels = { review: 'Prüfung offen', 'unidentified-article': 'Artikelzuordnung offen' };
    return { title: 'Datengrundlage · ABC-Analyse', source: sourceInfo(snapshot.sourceQuality, snapshot.sourceAt), calendarUnknown: snapshot.coverage?.periodCompleteness !== 'confirmed',
      coverage: snapshot.coverage?.basis === 'verified-import' ? 'Basis: geprüfte importierte Kassenpositionen.' : '',
      issues: (snapshot.buckets || []).filter(item => own(labels, item.id)).map(item => ({ label: labels[item.id], count: item.positions })),
      note: 'Geprüfte importierte Positionen. Historische Daten werden durch ihr Alter nicht automatisch fehlerhaft.' };
  }
  return Object.freeze({ normalize, render, sourceInfo, stock, history, abc });
}));
