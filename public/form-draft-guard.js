(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GrabenplanerFormDraftGuard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  // RAM only: passwords, file inputs and disabled controls are never retained.
  function create(root) {
    const drafts = new Map();
    const value = node => /^(checkbox|radio)$/i.test(node.type) ? node.checked : node.value;
    const eligible = node => node?.id && /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName)
      && !node.disabled && !/^(password|file|hidden|submit|button)$/i.test(node.type);
    function record(event) { if (eligible(event.target)) drafts.set(event.target.id, value(event.target)); }
    root?.addEventListener('input', record); root?.addEventListener('change', record);
    function restore(scope=root) {
      for (const [id, draft] of drafts) {
        const node = root?.ownerDocument.getElementById(id);
        if (scope!==root && node && !scope?.contains(node)) continue;
        if (!node || !root.contains(node) || !eligible(node)) { drafts.delete(id); continue; }
        if (/^(checkbox|radio)$/i.test(node.type)) node.checked = draft; else node.value = draft;
      }
    }
    const snapshot=(scope=root)=>new Map([...drafts].filter(([id])=>{const node=root?.ownerDocument.getElementById(id);return node&&scope?.contains(node);}));
    return {restore, snapshot,record:node=>record({target:node}),hasDraft:scope=>snapshot(scope).size>0,
      clear(scope=root) { if(scope===root) drafts.clear(); else for(const id of snapshot(scope).keys()) drafts.delete(id); },
      acknowledge(sent) { for (const [id, draft] of sent) if (drafts.get(id) === draft) drafts.delete(id); },
      dispose() { root?.removeEventListener('input', record); root?.removeEventListener('change', record); drafts.clear(); }};
  }
  return {create};
});
