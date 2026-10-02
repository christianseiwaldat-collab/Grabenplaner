'use strict';
// Trade's master bindings and the accepted cash publication are two separate
// mapping stores. Reuse only an authenticated, published mapping; a matching
// number or branch label alone never grants access to another location.
function createTradeLocationResolver({ readMaster, readCash, readTarget }) {
  const cache = new Map();
  return async function resolve(value) {
    if (value === null || value === undefined || value === '') return null;
    const raw = String(value);
    if (cache.has(raw)) return cache.get(raw);
    const pending = (async () => {
      const keys = [...new Set([raw, ...(/^\d+$/.test(raw) ? [raw.replace(/^0+(?=\d)/, ''), raw.replace(/^0+(?=\d)/, '').padStart(2, '0')] : [])])];
      const masters = await Promise.all(keys.map(readMaster));
      const linked = masters.filter(ref => ref?.targetId && ['linked', 'historical_mapping'].includes(ref.status));
      if (linked.length) return new Set(linked.map(ref => String(ref.targetId))).size === 1 ? String(linked[0].targetId) : null;
      // An explicit stale/invalid binding is not replaced by a second store.
      if (masters.some(ref => ref && !['unassigned', 'missing_source', 'unlinked'].includes(ref.status))) return null;
      const refs = await Promise.all(keys.map(readCash));
      const targets = [...new Set(refs.filter(ref => ref?.targetId && ['linked', 'historical_mapping'].includes(ref.status)).map(ref => String(ref.targetId)))];
      if (targets.length !== 1) return null;
      const target = await readTarget(targets[0]);
      return target?.id === targets[0] ? targets[0] : null;
    })();
    cache.set(raw, pending);
    return pending;
  };
}
module.exports = { createTradeLocationResolver };
