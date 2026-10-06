(function(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GpWindowPreferences = api;
})(typeof window === 'object' ? window : this, function() {
  'use strict';
  const KEY = 'gp_windows_v1', MAX_WINDOWS = 128;
  const fields = ['x', 'y', 'width', 'height', 'minimized'];
  const limits = {x:[0,16384], y:[0,16384], width:[200,4096], height:[80,4096]};
  const plain = value => value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  const safeId = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9:._-]{0,119}$/.test(value)
    && !['constructor', 'prototype', '__proto__'].includes(value);
  const empty = () => ({version:1, windows:{}});
  function geometry(value) {
    if (!plain(value) || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value,key))
      || Object.keys(value).some(key => !fields.includes(key)) || typeof value.minimized !== 'boolean') {
      throw new TypeError('Bitte gültige GP-Fenstereinstellungen übermitteln.');
    }
    for (const [key,[min,max]] of Object.entries(limits)) {
      if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) {
        throw new TypeError('Bitte gültige GP-Fenstereinstellungen übermitteln.');
      }
    }
    return Object.fromEntries(fields.map(key => [key,value[key] === 0 ? 0 : value[key]]));
  }
  function validate(value) {
    if (!plain(value) || value.version !== 1 || Object.keys(value).length !== 2
      || !Object.hasOwn(value,'windows') || !plain(value.windows) || Object.keys(value.windows).length > MAX_WINDOWS) {
      throw new TypeError('Bitte gültige GP-Fenstereinstellungen übermitteln.');
    }
    const result = empty();
    for (const [id,item] of Object.entries(value.windows)) {
      if (!safeId(id)) throw new TypeError('Bitte eine gültige GP-Fensterkennung verwenden.');
      result.windows[id] = geometry(item);
    }
    return result;
  }
  function normalize(value) {
    const result = empty();
    if (!plain(value) || !plain(value.windows)) return result;
    for (const [id,item] of Object.entries(value.windows).slice(0,MAX_WINDOWS)) {
      if (!safeId(id)) continue;
      try {result.windows[id] = geometry(item);} catch {}
    }
    return result;
  }
  return Object.freeze({KEY, MAX_WINDOWS, fields:Object.freeze(fields), limits, safeId, empty, geometry, validate, normalize});
});
