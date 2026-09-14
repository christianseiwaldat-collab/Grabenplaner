(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GrabenplanerArticleCalculation = api;
}(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const number = value => value === null || value === undefined || value === '' || typeof value === 'boolean' ? null
    : /^-?\d+(?:\.\d+)?$/.test(String(value)) && Number.isFinite(Number(value)) ? Number(value) : null;
  function input(value) {
    const raw = String(value ?? '').trim().replace(/[\s\u00a0]/g, '');
    if (!/^-?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?$/.test(raw) && !/^-?\d+(?:\.\d+)?$/.test(raw)) return null;
    return number(raw.includes(',') || /^-?\d{1,3}(?:\.\d{3})+$/.test(raw) ? raw.replaceAll('.', '').replace(',', '.') : raw);
  }
  function basis(value) {
    const cost = number(value?.purchaseNet), vat = number(value?.vatPercent);
    return value?.available === true && cost !== null && cost >= 0 && vat !== null && vat >= 0 && vat <= 100 ? { cost, factor: 1 + vat / 100 } : null;
  }
  function margin(gross, calculation) {
    const b = basis(calculation), price = number(gross);
    if (!b || price === null || price < 0 || price > 1e12) return null;
    const net = price / b.factor, difference = net - b.cost, amount = Math.abs(difference) < 1e-9 ? 0 : difference;
    return { gross: price, net, amount, percent: net === 0 ? null : amount / net * 100 };
  }
  function sellingPrice(percent, calculation) {
    const b = basis(calculation), rate = number(percent);
    if (!b || rate === null || rate >= 100 || rate < -10000 || b.cost === 0) return null;
    // Round upward to a saleable cent so the requested minimum RE is preserved.
    const gross = Math.ceil((b.cost / (1 - rate / 100) * b.factor - 1e-9) * 100) / 100;
    return margin(gross, calculation);
  }
  return { input, margin, sellingPrice };
}));
