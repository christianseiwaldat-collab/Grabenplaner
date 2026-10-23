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
  const DASHBOARD_IDS = Object.freeze(['dashboard-1', 'dashboard-2', 'dashboard-3']);
  const CUSTOM_FIELD_LIMIT = 20;
  const empty = () => ({version:1, fields:{}});
  const object = value => value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  const keys = (value, allowed) => Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.includes(key));
  const denseArray = value => Array.isArray(value) && Reflect.ownKeys(value).length === value.length + 1
    && Array.from({length:value.length}, (_, index) => Object.hasOwn(value, index)).every(Boolean);
  const customId = id => typeof id === 'string' && /^custom:[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id);
  function validateCustomFields(value, invalid = () => { throw new TypeError('Die eigenen Dashboard-Felder sind ungültig.'); }) {
    if (!Array.isArray(value) || value.length > CUSTOM_FIELD_LIMIT || !denseArray(value)) invalid();
    const ids = new Set();
    return value.map(source => {
      if (!object(source) || !keys(source, ['id', 'title', 'text']) || !customId(source.id) || ids.has(source.id)
        || typeof source.title !== 'string' || !source.title.trim() || source.title.trim().length > 120
        || /[\u0000-\u001f\u007f]/.test(source.title) || typeof source.text !== 'string' || source.text.length > 2000
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source.text)) invalid();
      ids.add(source.id);
      return {id:source.id, title:source.title.trim(), text:source.text.trim()};
    });
  }
  function validateBoard(value) {
    const invalid = () => { throw new TypeError('Die persönlichen Dashboard-Einstellungen sind ungültig.'); };
    if (!object(value) || value.version !== 1 || !object(value.fields)
      || !keys(value, ['version', 'fields', 'customFields'])) invalid();
    const customFields = Object.hasOwn(value, 'customFields') ? validateCustomFields(value.customFields, invalid) : [];
    const ids = [...IDS, ...customFields.map(field => field.id)];
    const fields = {};
    for (const [id, source] of Object.entries(value.fields)) {
      if (!ids.includes(id) || !object(source)
        || !keys(source, ['title','description','geometry','hidden','color'])) invalid();
      const field = {};
      if (Object.hasOwn(source,'color')) {
        if (!COLORS.includes(source.color)) invalid();
        field.color = source.color;
      }
      if (Object.hasOwn(source,'hidden')) {
        if (typeof source.hidden !== 'boolean') invalid();
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
        if (!object(g) || Object.keys(g).length !== 4 || !keys(g, Object.keys(LIMITS))) invalid();
        const geometry = {};
        for (const [key, [min,max]] of Object.entries(LIMITS)) {
          if (!Number.isInteger(g[key]) || g[key] < min || g[key] > max) invalid();
          geometry[key] = g[key] === 0 ? 0 : g[key];
        }
        field.geometry = geometry;
      }
      if (Object.keys(field).length) fields[id] = field;
    }
    if (Reflect.ownKeys(value.fields).some(key => typeof key !== 'string')) invalid();
    return {version:1, fields, ...(Object.hasOwn(value, 'customFields') ? {customFields} : {})};
  }
  function createDashboardModel(options) {
    const invalid = () => { throw new TypeError('Die persönlichen Dashboard-Tabs sind ungültig.'); };
    const board = options.validateBoard;
    const validName = name => typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 60
      && !/[\u0000-\u001f\u007f]/.test(name);
    function record(id, name, value) {
      const clean = board(value);
      return {id, name, ...(clean.order ? {order:clean.order} : {}), fields:clean.fields, customFields:clean.customFields || []};
    }
    function validateDocument(value) {
      if (!object(value) || value.version !== 2 || !keys(value, ['version', 'activeDashboard', 'dashboards'])
        || !DASHBOARD_IDS.includes(value.activeDashboard) || !Array.isArray(value.dashboards)
        || value.dashboards.length !== DASHBOARD_IDS.length || !denseArray(value.dashboards)) invalid();
      const seen = new Set(), dashboards = value.dashboards.map(source => {
        if (!object(source) || !keys(source, options.order ? ['id','name','order','fields','customFields'] : ['id','name','fields','customFields'])
          || !DASHBOARD_IDS.includes(source.id) || seen.has(source.id) || !validName(source.name)
          || !Object.hasOwn(source, 'customFields')) invalid();
        seen.add(source.id);
        return record(source.id, source.name.trim(), {version:1, fields:source.fields, customFields:source.customFields,
          ...(options.order && Object.hasOwn(source, 'order') ? {order:source.order} : {})});
      });
      return {version:2, activeDashboard:value.activeDashboard, dashboards:DASHBOARD_IDS.map(id => dashboards.find(item => item.id === id))};
    }
    function toDocument(value) {
      if (value?.version === 2) return validateDocument(value);
      const first = board(value);
      return validateDocument({version:2, activeDashboard:DASHBOARD_IDS[0], dashboards:DASHBOARD_IDS.map((id, index) =>
        record(id, options.names[index], index === 0 ? first : options.empty()))});
    }
    function getBoard(value) {
      if (value?.version !== 2) {
        const clean = board(value);
        return {...clean, customFields:clean.customFields || []};
      }
      const document = validateDocument(value), active = document.dashboards.find(item => item.id === document.activeDashboard);
      return board({version:1, ...(active.order ? {order:active.order} : {}), fields:active.fields, customFields:active.customFields});
    }
    function setBoard(value, next) {
      const document = toDocument(value), clean = board(next);
      return validateDocument({...document, dashboards:document.dashboards.map(item => item.id === document.activeDashboard
        ? record(item.id, item.name, clean) : item)});
    }
    function selectDashboard(value, id) {
      if (!DASHBOARD_IDS.includes(id)) invalid();
      return {...toDocument(value), activeDashboard:id};
    }
    function renameDashboard(value, id, name) {
      if (!DASHBOARD_IDS.includes(id) || !validName(name)) invalid();
      const document = toDocument(value);
      return {...document, dashboards:document.dashboards.map(item => item.id === id ? {...item, name:name.trim()} : item)};
    }
    function addCustomField(value, source) {
      const current = getBoard(value), customFields = validateCustomFields([...current.customFields, source], invalid);
      return board({...current, customFields, ...(current.order ? {order:[...current.order, source.id]} : {})});
    }
    function removeCustomField(value, id) {
      const current = getBoard(value);
      if (!current.customFields.some(field => field.id === id)) invalid();
      const fields = {...current.fields};
      delete fields[id];
      return board({...current, fields, customFields:current.customFields.filter(field => field.id !== id),
        ...(current.order ? {order:current.order.filter(fieldId => fieldId !== id)} : {})});
    }
    const isFieldId = (id, value = options.empty()) => options.ids.includes(id) || getBoard(value).customFields.some(field => field.id === id);
    return {DASHBOARD_IDS, CUSTOM_FIELD_LIMIT, validateDocument, toDocument, getBoard, setBoard, selectDashboard,
      renameDashboard, addCustomField, removeCustomField, isFieldId};
  }
  const dashboards = createDashboardModel({validateBoard, empty, ids:IDS, names:['Startdashboard', 'Dashboard 2', 'Dashboard 3']});
  function validate(value) { return value?.version === 2 ? dashboards.validateDocument(value) : validateBoard(value); }
  function normalize(value) { try { return validate(value); } catch { return empty(); } }
  return {KEY, IDS, COLORS, LIMITS, empty, validate, normalize, createDashboardModel, validateCustomFields, denseArray, ...dashboards};
});
