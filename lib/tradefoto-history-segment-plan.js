'use strict';
// Compile immutable history schemas once, preserving the original projection.
// Cache immutable schema descriptions only; never records or projected values.
function oldSerialize(table, profile, data) {
  const groups = new Map();
  for (const field of profile.fields) {
    const dataClass = table.columns.find(c => c.name === field.source)?.dataClass || 'internal_business';
    if (!groups.has(dataClass)) groups.set(dataClass, {});
    groups.get(dataClass)[field.target] = data[field.target];
  }
  return [...groups].map(([dataClass, values]) => ({ dataClass, data: values }));
}

const plainFrozen = value => value && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.isFrozen(value);
const ownData = (value, key) => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor : null;
};
const arrayFind = Array.prototype.find, arrayIterator = Array.prototype[Symbol.iterator];
function standardArrayIntrinsics() {
  return ownData(Array.prototype, 'find')?.value === arrayFind
    && ownData(Array.prototype, Symbol.iterator)?.value === arrayIterator;
}
function immutableArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || !Object.isFrozen(value)
    || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let i = 0; i < value.length; i++) if (!ownData(value, String(i))) return false;
  return true;
}
function buildPlan(table, profile, isTrustedProfile) {
  // Accessors, mutable descriptors, array holes and foreign profiles retain the
  // original path, including its exceptions and observable property-read order.
  if (!plainFrozen(table) || !plainFrozen(profile) || !isTrustedProfile(profile)) return null;
  const columnsProperty = ownData(table, 'columns'), fieldsProperty = ownData(profile, 'fields');
  if (!columnsProperty || !fieldsProperty) return null;
  const columns = columnsProperty.value, fields = fieldsProperty.value;
  if (!immutableArray(columns) || !immutableArray(fields)) return null;
  const first = new Map();
  for (const column of columns) {
    if (!plainFrozen(column)) return null;
    const name = ownData(column, 'name'), dc = ownData(column, 'dataClass');
    if (!name || typeof name.value !== 'string' || !dc && 'dataClass' in column) return null;
    const value = dc?.value;
    if (value && typeof value !== 'string') return null;
    // Array.find uses FIRST matching column, including a falsy first class.
    if (!first.has(name.value)) first.set(name.value, value || 'internal_business');
  }
  const classes = [], indices = new Map(), planFields = [];
  for (const field of fields) {
    if (!plainFrozen(field)) return null;
    const source = ownData(field, 'source'), target = ownData(field, 'target');
    if (!source || typeof source.value !== 'string' || !target
      || target.value !== null && typeof target.value !== 'string') return null;
    const dataClass = first.get(source.value) || 'internal_business';
    if (!indices.has(dataClass)) { indices.set(dataClass, classes.length); classes.push(dataClass); }
    planFields.push(Object.freeze({ target: target.value, classIndex: indices.get(dataClass) }));
  }
  return Object.freeze({ classes: Object.freeze(classes), fields: Object.freeze(planFields) });
}
function createCachedSerializer({ isTrustedProfile = () => false } = {}) {
  const profiles = new WeakMap();
  let built = 0, projected = 0, fallback = 0;
  function serialize(table, profile, data) {
    if (!standardArrayIntrinsics()) { fallback++; return oldSerialize(table, profile, data); }
    let tables = profile && typeof profile === 'object' ? profiles.get(profile) : null;
    let plan = table && typeof table === 'object' ? tables?.get(table) : null;
    if (!plan) {
      try { plan = buildPlan(table, profile, isTrustedProfile); }
      catch { plan = null; }
      if (!plan) { fallback++; return oldSerialize(table, profile, data); }
      if (!tables) { tables = new WeakMap(); profiles.set(profile, tables); }
      tables.set(table, plan); built++;
    }
    const groups = plan.classes.map(dataClass => ({ dataClass, data: {} }));
    // Preserve the original FIELD read order, also for data getters and repeated
    // targets. Grouping by class first would alter observable property reads.
    for (const field of plan.fields) groups[field.classIndex].data[field.target] = data[field.target];
    projected++;
    return groups;
  }
  serialize.stats = () => Object.freeze({ built, projected, fallback });
  return serialize;
}
function createSegmentProjector(H, C) {
  const serialize = createCachedSerializer({ isTrustedProfile(profile) {
    try { return C.assertProfile(profile) === profile; } catch { return false; }
  } });
  const project = (source, name, data, profileHash) => {
    // Exact original lookups and their errors remain before schema-plan use.
    const table = H.tableFor(source, name), profile = H.profileFor(source, name, profileHash);
    return serialize(table, profile, data);
  };
  project.stats = serialize.stats;
  return project;
}
module.exports = { oldSerialize, createCachedSerializer, createSegmentProjector };
