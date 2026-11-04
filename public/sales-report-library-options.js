(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SalesReportLibraryOptions = api;
})(typeof window === 'object' ? window : this, function () {
  'use strict';
  const COLUMNS = Object.freeze([
    { id: 'name', label: 'Name', width: 280 }, { id: 'type', label: 'Typ', width: 145 },
    { id: 'created', label: 'Erstellt am', width: 170 }, { id: 'updated', label: 'Geändert am', width: 170 },
    { id: 'createdBy', label: 'Erstellt von', width: 140 }, { id: 'status', label: 'Status', width: 130 },
    { id: 'period', label: 'Zeitraum', width: 220 }, { id: 'folder', label: 'Ordnerpfad', width: 240 }
  ]);
  const defaults = () => ({ view: 'icons', columns: ['name', 'type', 'created', 'createdBy', 'status'], widths: {}, sort: 'name', direction: 'asc' });
  function normalize(value) {
    const ids = COLUMNS.map(c => c.id);
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(k => !['view', 'columns', 'widths', 'sort', 'direction'].includes(k))
      || !['icons', 'details'].includes(value.view) || !Array.isArray(value.columns) || !value.columns.length
      || new Set(value.columns).size !== value.columns.length || value.columns.some(id => !ids.includes(id))
      || !value.widths || typeof value.widths !== 'object' || Array.isArray(value.widths)
      || Object.entries(value.widths).some(([id, width]) => !ids.includes(id) || !Number.isInteger(width) || width < 80 || width > 800)
      || !ids.includes(value.sort) || !['asc', 'desc'].includes(value.direction)) throw new TypeError('Invalid report library layout');
    return { view: value.view, columns: [...value.columns], widths: { ...value.widths }, sort: value.sort, direction: value.direction };
  }
  return { COLUMNS, defaults, normalize };
});
