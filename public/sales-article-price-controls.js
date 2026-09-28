(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./branch-article-calculation'));
  else root.SalesArticlePriceControls = factory(root.GrabenplanerArticleCalculation);
})(typeof window === 'object' ? window : this, function (calculation) {
  'use strict';
  const numeric = value => value === null || value === undefined || value === '' || typeof value === 'boolean'
    || !Number.isFinite(Number(value)) ? null : Number(value);
  const editable = { gross: 'Brutto-VK', net: 'Netto-VK', marginPercent: 'Rohertrag in % vom Netto-VK', margin: 'Rohertrag in €' };
  function format(value) {
    if (value === null) return '';
    // Compensate binary arithmetic at half-cent boundaries (e.g. 2741.805).
    const magnitude = Math.abs(value);
    const rounded = Math.sign(value) * Math.round((magnitude + Number.EPSILON * Math.max(1, magnitude)) * 100) / 100;
    return (rounded === 0 ? 0 : rounded).toLocaleString('de-AT', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
  }

  function trialBasis(matrix) {
    const cost = matrix?.costsRead ? matrix.purchase?.find(c => c.id === 'average_purchase')?.current : null;
    const costNumber = cost && !cost.sourceValue && cost.currency === 'EUR' ? numeric(cost.amount) : null;
    const vat = numeric(matrix?.vatPercent);
    return {
      cost: costNumber !== null && costNumber >= 0 ? costNumber : null,
      factor: vat !== null && vat >= 0 && vat <= 100 ? 1 + vat / 100 : null,
      uvp: numeric(matrix?.sales?.find(c => c.id === 'upe')?.gross?.amount),
    };
  }
  function calculate(field, input, matrix) {
    const value = calculation.input(input), b = trialBasis(matrix);
    if (!Object.hasOwn(editable, field) || value === null) return { error: 'Bitte eine gültige Zahl eingeben, z. B. 100,00.' };
    if (b.factor === null) return { error: 'Für den Versuch fehlt ein bestätigter Umsatzsteuersatz.' };
    if (['margin', 'marginPercent'].includes(field) && b.cost === null)
      return { error: 'Für den Rohertrag fehlt ein bestätigter Ø EK netto.' };
    if (field === 'marginPercent' && (value >= 100 || b.cost === 0))
      return { error: b.cost === 0 ? 'Bei Ø EK 0 lässt sich der VK nicht aus einem Prozentsatz bestimmen.' : 'Der Rohertrag muss unter 100 % des Netto-VK liegen.' };
    const net = field === 'gross' ? value / b.factor : field === 'net' ? value
      : field === 'margin' ? b.cost + value : b.cost / (1 - value / 100);
    const gross = net * b.factor;
    if (!Number.isFinite(gross) || net < 0 || gross > 1e12)
      return { error: 'Die Eingabe muss einen VK zwischen 0 und 1 Billion Euro ergeben.' };
    // Keep full precision between calculations; round only for display. This is a local scenario, never a price write.
    const amount = b.cost === null ? null : net - b.cost;
    return { values: { gross, net, margin: amount === null ? null : Math.abs(amount) < 1e-9 ? 0 : amount,
      marginPercent: amount === null || net === 0 ? null : amount / net * 100,
      discountPercent: b.uvp > 0 ? (b.uvp - gross) / b.uvp * 100 : null } };
  }
  function normalizeColumns(ids, available) {
    const selected = Array.isArray(ids) ? available.filter(id => ids.includes(id)) : [];
    return selected.length ? selected : [...available];
  }
  function toggleColumn(ids, id, checked, available) {
    const current = normalizeColumns(ids, available);
    if (!available.includes(id)) return current;
    const next = checked ? available.filter(value => current.includes(value) || value === id) : current.filter(value => value !== id);
    return next.length ? next : current;
  }
  function mount(root, matrix, h, { preferenceKey, storage } = {}) {
    const card = root.querySelector('[data-sales-price-card]');
    if (!card || !matrix?.sales?.length) return;
    if (storage === undefined) { try { storage = window.localStorage; } catch {} }
    const available = matrix.sales.map(c => c.id);
    let saved;
    try { saved = JSON.parse(storage?.getItem(preferenceKey) || 'null'); } catch {}
    let selected = normalizeColumns(saved, available);
    const columnOptions = [...card.querySelectorAll('[data-price-column-option]')];
    function showColumns() {
      card.querySelectorAll('[data-price-column]').forEach(cell => { cell.hidden = !selected.includes(cell.dataset.priceColumn); });
      columnOptions.forEach(input => {
        input.checked = selected.includes(input.dataset.priceColumnOption);
        input.disabled = selected.length === 1 && input.checked;
      });
      card.querySelector('[data-price-trial-note]').hidden = !selected.includes('internet_5');
    }
    showColumns();
    const columnToggle = card.querySelector('[data-price-columns-toggle]');
    const choices = card.querySelector('.sales-article-price-columns');
    columnToggle.addEventListener('click', () => {
      choices.hidden = !choices.hidden;
      columnToggle.setAttribute('aria-expanded', String(!choices.hidden));
    });
    choices.addEventListener('keydown', event => {
      if (event.key === 'Escape') { choices.hidden = true; columnToggle.setAttribute('aria-expanded', 'false'); columnToggle.focus(); }
    });
    columnOptions.forEach(input => input.addEventListener('change', () => {
      selected = toggleColumn(selected, input.dataset.priceColumnOption, input.checked, available);
      showColumns();
      try { storage?.setItem(preferenceKey, JSON.stringify(selected)); } catch {}
    }));

    const trial = matrix.sales.find(c => c.id === 'internet_5');
    if (!trial) return;
    const basis = trialBasis(matrix), inputs = new Map(), originalCells = new Map();
    const trialCell = row => card.querySelector('[data-price-column="internet_5"][data-price-row="' + row + '"]');
    const hint = card.querySelector('#salesArticleTrialHint'), status = card.querySelector('#salesArticleTrialStatus');
    const reset = card.querySelector('[data-price-trial-reset]');
    hint.textContent = 'Versuch: frei rechnen, ohne Artikelpreise zu speichern.'
      + (basis.factor === null ? ' Umsatzsteuersatz fehlt.' : ' MwSt. ' + Number(matrix.vatPercent).toLocaleString('de-AT') + ' %.')
      + (matrix.costsRead && basis.cost === null ? ' Rohertrag nicht berechenbar: bestätigter Ø EK netto fehlt.' : '');
    for (const [field, label] of Object.entries(editable)) {
      const cell = trialCell(field);
      if (!cell) continue;
      const input = root.ownerDocument.createElement('input');
      input.type = 'text'; input.inputMode = 'decimal'; input.autocomplete = 'off';
      input.className = 'sales-article-trial-input'; input.dataset.priceTrialInput = field;
      input.setAttribute('aria-label', 'Versuch: ' + label);
      input.setAttribute('aria-describedby', 'salesArticleTrialHint salesArticleTrialStatus');
      input.value = format(numeric(field === 'marginPercent' ? trial[field] : trial[field]?.amount));
      input.disabled = basis.factor === null || (['margin', 'marginPercent'].includes(field) && basis.cost === null)
        || (field === 'marginPercent' && basis.cost === 0);
      if (input.disabled) input.title = basis.factor === null ? 'Bestätigter Umsatzsteuersatz fehlt.'
        : basis.cost === null ? 'Bestätigter Ø EK netto fehlt.' : 'Bei Ø EK 0 ist der VK aus dem Prozentsatz nicht bestimmbar.';
      cell.replaceChildren(input);
      inputs.set(field, input);
    }
    for (const field of ['discountPercent', 'date']) originalCells.set(field, trialCell(field)?.innerHTML);
    let values = null;
    reset.disabled = true;
    function update(input, field) {
      const result = calculate(field, input.value, matrix);
      values = result.values || null;
      reset.disabled = false;
      inputs.forEach((other, key) => {
        other.setAttribute('aria-invalid', String(other === input && Boolean(result.error)));
        if (other !== input) other.value = values ? format(values[key]) : '';
      });
      const discount = trialCell('discountPercent');
      if (discount) discount.textContent = values?.discountPercent == null ? '–' : format(values.discountPercent) + ' %';
      const date = trialCell('date');
      if (date) date.textContent = 'Simulation';
      status.textContent = result.error || (values.margin === null
        ? 'Brutto- und Netto-VK neu berechnet. Rohertrag ohne bestätigten Ø EK nicht verfügbar.'
        : 'Versuch neu berechnet. Rohertrag in % bezieht sich auf den Netto-VK.');
      status.classList.toggle('invalid', Boolean(result.error));
    }
    inputs.forEach((input, field) => {
      input.addEventListener('input', () => update(input, field));
      input.addEventListener('blur', () => { if (values && input.getAttribute('aria-invalid') !== 'true') input.value = format(values[field]); });
      input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); input.blur(); } });
    });
    reset.addEventListener('click', () => {
      values = null;
      inputs.forEach((input, field) => {
        input.value = format(numeric(field === 'marginPercent' ? trial[field] : trial[field]?.amount));
        input.removeAttribute('aria-invalid');
      });
      originalCells.forEach((html, field) => { if (trialCell(field)) trialCell(field).innerHTML = html; });
      status.textContent = 'Versuch auf die Ausgangswerte zurückgesetzt.'; status.classList.remove('invalid');
      reset.disabled = true;
    });
  }
  return { calculate, format, trialBasis, normalizeColumns, toggleColumn, mount };
});
