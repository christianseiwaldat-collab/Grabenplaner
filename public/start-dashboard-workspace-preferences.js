(function(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StartDashboardWorkspacePreferences = api;
})(typeof window === 'object' ? window : this, function() {
  'use strict';
  const KEY = 'start_dashboard_workspace_v1';
  const IDS = Object.freeze([
    'control:center', 'control:vps', 'group:branch', 'group:personnel', 'group:sales',
    'card:schedule', 'card:vacation', 'card:loans', 'card:branchOrders', 'card:personnel', 'card:sales',
    'widget:branchOnDuty', 'widget:branchAbsences', 'widget:personnelTeam', 'widget:personnelRequests', 'widget:salesKpis', 'widget:salesTopGroups',
  ]);
  const COLORS = Object.freeze(['sage', 'blue', 'sand', 'rose', 'lavender', 'peach']);
  const LIMITS = Object.freeze({x:[0,16384], y:[0,16384], width:[200,4096], height:[80,4096]});
  const empty = () => ({version:1, fields:{}});
  const object = value => value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  function validate(value) {
    const invalid = () => { throw new TypeError('Die persönlichen Dashboard-Einstellungen sind ungültig.'); };
    if (!object(value) || value.version !== 1 || !object(value.fields)
      || Object.keys(value).some(key => !['version','fields'].includes(key))) invalid();
    const fields = {};
    for (const [id, source] of Object.entries(value.fields)) {
      if (!IDS.includes(id) || !object(source)
        || Object.keys(source).some(key => !['title','description','geometry','hidden','color'].includes(key))) invalid();
      const field = {};
      if (Object.hasOwn(source,'color')) {
        if (!COLORS.includes(source.color)) invalid();
        field.color = source.color;
      }
      if (Object.hasOwn(source,'hidden')) {
        if (!['control:center','control:vps'].includes(id) || typeof source.hidden !== 'boolean') invalid();
        field.hidden = source.hidden;
      }
      if (Object.hasOwn(source,'title')) {
        if (typeof source.title !== 'string' || !source.title.trim() || source.title.trim().length > 120
          || /[\u0000-\u001f\u007f]/.test(source.title)) invalid();
        field.title = source.title.trim();
      }
      if (Object.hasOwn(source,'description')) {
        if (typeof source.description !== 'string' || source.description.length > 400
          || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source.description)) invalid();
        field.description = source.description.trim();
      }
      if (Object.hasOwn(source,'geometry')) {
        const g = source.geometry;
        if (!object(g) || Object.keys(g).length !== 4) invalid();
        const geometry = {};
        for (const [key, [min,max]] of Object.entries(LIMITS)) {
          if (!Number.isInteger(g[key]) || g[key] < min || g[key] > max) invalid();
          geometry[key] = g[key] === 0 ? 0 : g[key];
        }
        field.geometry = geometry;
      }
      if (Object.keys(field).length) fields[id] = field;
    }
    return {version:1, fields};
  }
  function normalize(value) { try { return validate(value); } catch { return empty(); } }
  return {KEY, IDS, COLORS, LIMITS, empty, validate, normalize};
});
