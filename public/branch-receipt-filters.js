(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GrabenplanerReceiptFilters = api;
}(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const STOCK = Object.freeze(['05', '11', '13', '18', '77', '99']);
  const INTERNET = Object.freeze(['00', '03', '70', '90']);
  function location(value) {
    if (value == null || !/^\d{1,3}$/.test(String(value)) || Number(value) > 255) return null;
    return String(Number(value)).padStart(2, '0');
  }
  function seller(value) { return /^\d{1,20}$/.test(String(value ?? '')) ? String(value).replace(/^0+(?=\d)/, '') : null; }
  function sellers(value) {
    if (typeof value !== 'string' || value.length > 440) throw new Error('Bitte höchstens 20 Personalnummern durch Beistrich getrennt eingeben.');
    if (!value.trim()) return [];
    const values = value.split(',').map(v => seller(v.trim()));
    if (values.length > 20 || values.some(v => v === null)) throw new Error('Bitte nur vollständige Personalnummern eingeben, getrennt durch Beistriche.');
    return [...new Set(values)].sort((a, b) => a.localeCompare(b, 'de', { numeric: true }));
  }
  return { STOCK, INTERNET, location, seller, sellers };
}));
