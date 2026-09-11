'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SalesReportControls = api;
})(typeof window === 'object' ? window : globalThis, function () {
  const pad = n => String(n).padStart(2, '0');
  function previousYear(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
    const [year, month, day] = value.split('-').map(Number), last = new Date(Date.UTC(year - 1, month, 0)).getUTCDate();
    return `${year - 1}-${pad(month)}-${pad(Math.min(day, last))}`;
  }
  function periodRange(mode, year, period, today) {
    year = Number(year); period = Number(period);
    if (!Number.isInteger(year) || year < 1900 || year > Number(today.slice(0, 4))) return null;
    if (!['month', 'quarter', 'year'].includes(mode)) return null;
    if (mode === 'month' && (!Number.isInteger(period) || period < 1 || period > 12)
      || mode === 'quarter' && (!Number.isInteger(period) || period < 1 || period > 4)) return null;
    const month = mode === 'year' ? 1 : mode === 'quarter' ? (period - 1) * 3 + 1 : period;
    const lastMonth = mode === 'year' ? 12 : mode === 'quarter' ? month + 2 : month;
    const from = `${year}-${pad(month)}-01`, end = `${year}-${pad(lastMonth)}-${pad(new Date(Date.UTC(year, lastMonth, 0)).getUTCDate())}`;
    return from > today ? null : { from, to: end > today ? today : end, partial: end > today };
  }
  const node = (tag, text, className) => { const n = document.createElement(tag); if (text) n.textContent = text; if (className) n.className = className; return n; };
  function periodPicker(host, { from, to, today, onChange }) {
    const legend = host.closest('fieldset').querySelector('legend').textContent;
    const mode = node('select'), year = node('input'), period = node('select'), note = node('small');
    for (const [id, label] of [['custom', 'Exaktes Datum'], ['month', 'Monat'], ['quarter', 'Quartal'], ['year', 'Jahr']]) mode.append(new Option(label, id));
    const label = (text, field) => { const n = node('label', text); field.setAttribute('aria-label', legend + ' · ' + text); n.append(field); return n; };
    const yearLabel = label('Jahr', year), periodLabel = label('Abschnitt', period);
    year.type = 'number'; year.min = '1900'; year.step = '1'; year.inputMode = 'numeric';
    host.append(label('Zeitraum wählen', mode), yearLabel, periodLabel, note);
    function sync(nextMode) {
      if (nextMode) mode.value = nextMode;
      const date = /^\d{4}-\d{2}-\d{2}$/.test(from.value) ? from.value : today();
      year.max = today().slice(0, 4); year.value = date.slice(0, 4);
      const month = Number(date.slice(5, 7));
      yearLabel.hidden = mode.value === 'custom'; periodLabel.hidden = !['month', 'quarter'].includes(mode.value);
      period.replaceChildren(...(mode.value === 'quarter' ? ['1. Quartal', '2. Quartal', '3. Quartal', '4. Quartal']
        : ['Jänner', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']).map((text, i) => new Option(text, String(i + 1))));
      period.value = String(mode.value === 'quarter' ? Math.floor((month - 1) / 3) + 1 : month);
      year.setCustomValidity(''); note.textContent = '';
    }
    function apply() {
      if (mode.value === 'custom') { onChange(); return; }
      const range = periodRange(mode.value, year.value, period.value, today());
      year.setCustomValidity(range ? '' : 'Bitte einen begonnenen Zeitraum zwischen 1900 und heute wählen.');
      note.textContent = !range ? 'Dieser Zeitraum liegt in der Zukunft oder ist ungültig.' : range.partial ? 'Laufender Zeitraum: bis heute.' : '';
      if (range) { from.value = range.from; to.value = range.to; onChange(); }
    }
    mode.addEventListener('change', () => { sync(); apply(); });
    year.addEventListener('input', apply); period.addEventListener('change', apply);
    for (const field of [from, to]) field.addEventListener('input', () => { sync('custom'); onChange(); });
    sync(); return { sync, mode: () => mode.value };
  }
  function transferPicker(host, options, selected = [], max = 10) {
    const title = host.closest('fieldset').querySelector('legend').textContent;
    const choices = new Map(options.map(o => [o.id, o])), values = new Set(selected), leftMarked = new Set(), rightMarked = new Set();
    const shell = node('div', '', 'sales-report-transfer'), available = node('div'), chosen = node('div'), actions = node('div', '', 'sales-report-transfer-actions');
    const search = node('input'), status = node('small', '', 'sales-report-transfer-status');
    search.type = 'search'; search.placeholder = 'Name oder Nummer suchen'; search.setAttribute('aria-label', title + ' durchsuchen');
    const list = (owner, label) => {
      owner.append(node('strong', label));
      const scroll = node('div', '', 'sales-report-transfer-scroll'), table = node('table'), body = node('tbody');
      table.setAttribute('aria-label', title + ' · ' + label); table.append(body); scroll.append(table); owner.append(scroll); return body;
    };
    available.append(search); const left = list(available, 'Verfügbar'), right = list(chosen, 'Für den Bericht');
    const button = (text, label, action) => { const b = node('button', text, 'text-button'); b.type = 'button'; b.setAttribute('aria-label', title + ' · ' + label); b.addEventListener('click', action); actions.append(b); return b; };
    const add = button('Hinzufügen →', 'Hinzufügen', () => {
      if (values.size + leftMarked.size > max) { status.textContent = `Höchstens ${max} auswählen. Noch ${max - values.size} Plätze frei.`; return; }
      for (const id of leftMarked) values.add(id); leftMarked.clear(); render();
    });
    const remove = button('← Entfernen', 'Entfernen', () => { for (const id of rightMarked) values.delete(id); rightMarked.clear(); render(); });
    const clear = button('Auswahl leeren', 'Auswahl leeren', () => { values.clear(); rightMarked.clear(); render(); });
    status.setAttribute('role', 'status'); shell.append(available, actions, chosen); host.replaceChildren(shell, status);
    const searchable = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('de-AT');
    function render() {
      left.replaceChildren(); right.replaceChildren();
      const query = searchable(search.value.trim());
      const row = (option, body, marked) => {
        const tr = node('tr'), td = node('td'), label = node('label'), check = node('input');
        check.type = 'checkbox'; check.checked = marked.has(option.id); check.value = option.id;
        check.setAttribute('aria-label', title + ' · ' + (body === left ? 'verfügbar: ' : 'ausgewählt: ') + option.label);
        check.addEventListener('change', () => { check.checked ? marked.add(option.id) : marked.delete(option.id); updateButtons(); });
        label.append(check, node('span', option.label)); td.append(label); tr.append(td); body.append(tr);
      };
      for (const option of options) if (!values.has(option.id) && searchable(option.label + ' ' + option.id).includes(query)) row(option, left, leftMarked);
      for (const id of values) row(choices.get(id) || { id, label: id }, right, rightMarked);
      for (const [body, message] of [[left, options.length ? 'Keine weiteren Treffer.' : 'Keine Bezeichnungen im eingelesenen Trade-Stand.'], [right, 'Keine Eingrenzung – alle berücksichtigen.']]) {
        if (!body.children.length) { const tr = node('tr'), td = node('td', message, 'sales-report-transfer-empty'); tr.append(td); body.append(tr); }
      }
      status.textContent = `${values.size} / ${max} ausgewählt · ${options.length} verfügbar`; updateButtons();
    }
    function updateButtons() { add.disabled = !leftMarked.size; remove.disabled = !rightMarked.size; clear.disabled = !values.size; }
    search.addEventListener('input', () => { leftMarked.clear(); render(); });
    render(); return values;
  }
  return { previousYear, periodRange, periodPicker, transferPicker };
});
