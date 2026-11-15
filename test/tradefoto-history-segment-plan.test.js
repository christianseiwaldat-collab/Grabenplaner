'use strict';
// Independent semantic tests only. No database, VM, source data or timing benchmark.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const candidate = require('../lib/tradefoto-history-segment-plan');
const repo = path.resolve(__dirname, '..');
const H = require(path.join(repo, 'lib/tradefoto-history-profiles'));
const C = require(path.join(repo, 'lib/data-import-contract'));

function reference(table, profile, data) {
  const groups = new Map();
  for (const field of profile.fields) {
    const dataClass = table.columns.find(c => c.name === field.source)?.dataClass || 'internal_business';
    if (!groups.has(dataClass)) groups.set(dataClass, {});
    groups.get(dataClass)[field.target] = data[field.target];
  }
  return [...groups].map(([dataClass, values]) => ({dataClass, data: values}));
}
const field = (source, target) => Object.freeze({source, target});
const column = (name, dataClass) => Object.freeze({name, dataClass});
const frozenProfile = fields => Object.freeze({fields: Object.freeze(fields), fingerprint: 'synthetic-same-fingerprint'});
const frozenTable = columns => Object.freeze({columns: Object.freeze(columns)});
function projectorFor(state, {trusted = true} = {}) {
  const counters = {table: 0, profile: 0};
  const fakeH = {
    tableFor(source, name) { counters.table++; if (state.tableError) throw state.tableError; return state.table; },
    profileFor(source, name, hash) { counters.profile++; if (state.profileError) throw state.profileError; return state.profile; },
  };
  const fakeC = {...C, assertProfile(value) {
    if (!trusted || value !== state.profile) throw new Error('UNTRUSTED_SYNTHETIC_PROFILE');
    return value;
  }};
  return {serialize: candidate.createSegmentProjector(fakeH, fakeC), counters};
}
function compareFactory(factory, options) {
  const expected = factory(), actual = factory();
  const got = projectorFor(actual, options).serialize('synthetic', 'table', actual.data, 'synthetic-hash');
  const wanted = reference(expected.table, expected.profile, expected.data);
  assert.deepStrictEqual(got, wanted);
  assert.deepStrictEqual(actual.events || [], expected.events || []);
  return {got, wanted};
}

test('real trusted 14/44/85-field profiles preserve exact values, key order and canonical bytes', () => {
  const project = candidate.createSegmentProjector(H, C);
  const profiles = [
    ['BestellVerteilung', 14, ['internal_business']],
    ['Rechnungsdetails_Z', 44, ['internal_business', 'customer_restricted', 'catalog_costs', 'personnel_restricted']],
    ['Rechnung_Z', 85, ['internal_business', 'personnel_restricted', 'customer_restricted', 'restricted_finance']],
  ];
  for (const [name, count, classes] of profiles) {
    const table = H.tableFor('trade', name), profile = H.profileFor('trade', name);
    assert.equal(profile.fields.length, count);
    for (const mode of ['sparse', 'mixed', 'wide-text']) {
      const source = {};
      for (const [index, f] of profile.fields.entries()) {
        let value;
        if (f.source === '_source_snapshot_sha256') value = 'a'.repeat(64);
        else if (f.source === '_source_row') value = 1;
        else if (mode === 'sparse' && f.nullable && !profile.keyFields.includes(f.source)) value = null;
        else switch (f.type) {
          case 'identifier': value = String(index + 1).padStart(8, '0'); break;
          case 'integer': value = index % 13 - 6; break;
          case 'boolean': value = index % 2 === 0; break;
          case 'source_decimal': value = index % 2 ? '-1.125000' : '0.0008333333333333334'; break;
          case 'decimal': value = '1' + (f.scale ? '.' + '2'.padEnd(f.scale, '0') : ''); break;
          case 'source_text': value = mode === 'wide-text' ? ('Synthetic\tline\r\nÃƒâ€žÃ¤Â¸Â­Ã°Å¸â„¢â€š '.repeat(32 + index % 5)) : 'Synthetic ' + index; break;
          case 'text': value = 'Synthetic ' + index; break;
          case 'civil_datetime': value = '2026-11-11T12:00:00.000'; break;
          case 'date': value = '2026-11-11'; break;
          case 'time': value = '12:00:00'; break;
          case 'guid': value = '11111111-2222-3333-4444-555555555555'; break;
          default: assert.fail('Unqualified synthetic type ' + f.type);
        }
        source[f.source] = value;
      }
      const normalized = C.normalizeDataImportRow(profile, source, true);
      const expected = reference(table, profile, normalized.data);
      assert.deepStrictEqual(expected.map(s => s.dataClass), classes);
      for (const entries of [
        Object.entries(normalized.data),
        Object.entries(normalized.data).reverse(),
        Object.entries(normalized.data).filter((_, i) => i % 2 === 0).concat(Object.entries(normalized.data).filter((_, i) => i % 2)),
      ]) {
        const data = Object.fromEntries(entries);
        const before = C.canonical(data), got = project('trade', name, data, profile.fingerprint);
        assert.deepStrictEqual(got, expected, name + '/' + mode);
        assert.equal(C.canonical(got), C.canonical(expected));
        assert.equal(C.canonical(data), before);
        for (let i = 0; i < got.length; i++) assert.deepStrictEqual(Reflect.ownKeys(got[i].data), Reflect.ownKeys(expected[i].data));
      }
    }
  }
});

test('duplicate column names preserve FIRST match and falsy FIRST class falls back', () => {
  for (const first of ['first', undefined, null, '', 0, false]) {
    const {got} = compareFactory(() => ({
      table: frozenTable([column('x', first), column('x', 'later')]),
      profile: frozenProfile([field('x', 'f0')]), data: {f0: 7},
    }));
    assert.equal(got[0].dataClass, first || 'internal_business');
  }
});

test('unknown source and case mismatch use internal_business; class/field order is not sorted', () => {
  const {got} = compareFactory(() => ({
    table: frozenTable([column('x', 'z-last'), column('y', 'a-first')]),
    profile: frozenProfile([field('x', 'f2'), field('missing', 'f1'), field('y', 'f0'), field('X', 'f3'), field('x', 'f4')]),
    data: {f0: 0, f1: null, f2: 2, f3: false, f4: 4},
  }));
  assert.deepStrictEqual(got.map(s => s.dataClass), ['z-last', 'internal_business', 'a-first']);
  assert.deepStrictEqual(Object.keys(got[0].data), ['f2', 'f4']);
  assert.deepStrictEqual(Object.keys(got[1].data), ['f1', 'f3']);
});

test('multiple fields sharing a target preserve overwrite and interleaved getter order', () => {
  compareFactory(() => {
    const events = []; let value = 0;
    const data = Object.defineProperty({}, 'shared', {enumerable: true, get() { events.push('shared'); return ++value; }});
    return {events, data,
      table: frozenTable([column('x', 'A'), column('y', 'B'), column('z', 'A')]),
      profile: frozenProfile([field('x', 'shared'), field('y', 'shared'), field('z', 'shared')])};
  });
});

test('data getters retain global A/B/A read order even if field plan groups classes', () => {
  compareFactory(() => {
    const events = [], data = {};
    for (const key of ['f0', 'f1', 'f2']) Object.defineProperty(data, key, {
      enumerable: true, get() { events.push(key); return events.length; },
    });
    return {events, data, table: frozenTable([column('x', 'A'), column('y', 'B'), column('z', 'A')]),
      profile: frozenProfile([field('x', 'f0'), field('y', 'f1'), field('z', 'f2')])};
  });
});

test('table and profile lookup are fresh on each call, even with identical fingerprint labels', () => {
  const state = {table: frozenTable([column('x', 'A'), column('y', 'B')]),
    profile: frozenProfile([field('x', 'f0')])};
  const {serialize, counters} = projectorFor(state);
  assert.equal(serialize('s', 'n', {f0: 1, f1: 2}, 'same')[0].dataClass, 'A');
  state.table = frozenTable([column('x', 'C'), column('y', 'D')]);
  assert.equal(serialize('s', 'n', {f0: 3, f1: 4}, 'same')[0].dataClass, 'C');
  state.profile = frozenProfile([field('y', 'f1')]);
  assert.deepStrictEqual(serialize('s', 'n', {f0: 5, f1: 6}, 'same'), [{dataClass: 'D', data: {f1: 6}}]);
  assert.deepStrictEqual(counters, {table: 3, profile: 3});
});

test('all mutable metadata levels reflect mutation rather than retain a stale plan', () => {
  const factories = [
    () => { const table = {columns: Object.freeze([column('x', 'A'), column('y', 'B')])};
      return {table, profile: frozenProfile([field('x', 'f0')]), mutate() { table.columns = Object.freeze([column('x', 'B')]); }}; },
    () => { const columns = [column('x', 'A')];
      return {table: Object.freeze({columns}), profile: frozenProfile([field('x', 'f0')]), mutate() { columns[0] = column('x', 'B'); }}; },
    () => { const col = {name: 'x', dataClass: 'A'};
      return {table: frozenTable([col]), profile: frozenProfile([field('x', 'f0')]), mutate() { col.dataClass = 'B'; }}; },
    () => { const profile = {fields: Object.freeze([field('x', 'f0')])};
      return {table: frozenTable([column('x', 'A'), column('y', 'B')]), profile, mutate() { profile.fields = Object.freeze([field('y', 'f1')]); }}; },
    () => { const fields = [field('x', 'f0')];
      return {table: frozenTable([column('x', 'A'), column('y', 'B')]), profile: Object.freeze({fields}), mutate() { fields[0] = field('y', 'f1'); }}; },
    () => { const mutableField = {source: 'x', target: 'f0'};
      return {table: frozenTable([column('x', 'A'), column('y', 'B')]), profile: frozenProfile([mutableField]), mutate() { mutableField.source = 'y'; mutableField.target = 'f1'; }}; },
  ];
  for (const make of factories) {
    const state = make(), {serialize} = projectorFor(state), data = {f0: 1, f1: 2};
    assert.deepStrictEqual(serialize('s', 'n', data, 'h'), reference(state.table, state.profile, data));
    state.mutate();
    assert.deepStrictEqual(serialize('s', 'n', data, 'h'), reference(state.table, state.profile, data));
  }
});

test('frozen accessor metadata falls back without adding getter observations', () => {
  for (const location of ['table.columns', 'column.name', 'column.dataClass', 'profile.fields', 'field.source', 'field.target']) {
    compareFactory(() => {
      const events = [], col = {name: 'x', dataClass: 'A'}, f = {source: 'x', target: 'f0'};
      const columns = [col], fields = [f], table = {columns}, profile = {fields}, data = {f0: 9};
      const options = {
        'table.columns': [table, 'columns', columns], 'column.name': [col, 'name', 'x'],
        'column.dataClass': [col, 'dataClass', 'A'], 'profile.fields': [profile, 'fields', fields],
        'field.source': [f, 'source', 'x'], 'field.target': [f, 'target', 'f0'],
      };
      const [object, key, value] = options[location];
      Object.defineProperty(object, key, {enumerable: true, get() { events.push(location); return value; }});
      Object.freeze(col); Object.freeze(f); Object.freeze(columns); Object.freeze(fields); Object.freeze(table); Object.freeze(profile);
      return {events, table, profile, data};
    });
  }
});

test('frozen columns with a custom find method retain the original method semantics', () => {
  compareFactory(() => {
    const events = [], columns = [column('x', 'numeric-column')];
    Object.defineProperty(columns, 'find', {value(predicate) {
      events.push('custom-find');
      return column('x', 'custom-find-result');
    }});
    return {events, table: frozenTable(columns), profile: frozenProfile([field('x', 'f0')]), data: {f0: 1}};
  });
});

test('columns custom iterator must not replace Array.find indexed semantics', () => {
  compareFactory(() => {
    const events = [], columns = [column('x', 'indexed-column')];
    Object.defineProperty(columns, Symbol.iterator, {value: function* () {
      events.push('columns-iterator');
      yield column('x', 'iterator-only-column');
    }});
    return {events, table: frozenTable(columns), profile: frozenProfile([field('x', 'f0')]), data: {f0: 1}};
  });
});

test('frozen fields with a dynamic iterator preserve repeated calls and iterator observations', () => {
  function fixture() {
    const events = [], fields = [field('x', 'f0'), field('y', 'f1')];
    let sequence = 0;
    Object.defineProperty(fields, Symbol.iterator, {value: function* () {
      events.push('fields-iterator');
      yield sequence++ % 2 ? fields[1] : fields[0];
    }});
    return {events, table: frozenTable([column('x', 'A'), column('y', 'B')]),
      profile: frozenProfile(fields), data: {f0: 1, f1: 2}};
  }
  const expected = fixture(), actual = fixture(), {serialize} = projectorFor(actual);
  for (let i = 0; i < 2; i++) {
    assert.deepStrictEqual(serialize('s', 'n', actual.data, 'h'),
      reference(expected.table, expected.profile, expected.data));
    assert.deepStrictEqual(actual.events, expected.events);
  }
});

test('frozen arrays with a custom prototype retain inherited find and iterator semantics', () => {
  compareFactory(() => {
    const events = [], columns = [column('x', 'indexed-column')];
    const prototype = Object.create(Array.prototype, {find: {value() {
      events.push('inherited-find');
      return column('x', 'prototype-find-result');
    }}});
    Object.setPrototypeOf(columns, prototype);
    return {events, table: frozenTable(columns), profile: frozenProfile([field('x', 'f0')]), data: {f0: 1}};
  });
  compareFactory(() => {
    const events = [], fields = [field('x', 'f0')];
    const prototype = Object.create(Array.prototype, {[Symbol.iterator]: {value: function* () {
      events.push('inherited-fields-iterator');
      yield field('y', 'f1');
    }}});
    Object.setPrototypeOf(fields, prototype);
    return {events, table: frozenTable([column('x', 'A'), column('y', 'B')]),
      profile: frozenProfile(fields), data: {f0: 1, f1: 2}};
  });
});

test('changed array intrinsics cannot reuse an older cached plan', () => {
  const state = {table: frozenTable([column('x', 'A'), column('y', 'B')]),
    profile: frozenProfile([field('x', 'f0')])};
  const {serialize} = projectorFor(state), data = {f0: 1, f1: 2};
  serialize('s', 'n', data, 'h');
  const originalFind = Array.prototype.find;
  try {
    Array.prototype.find = function (...args) {
      return this === state.table.columns ? column('x', 'changed-intrinsic') : originalFind.apply(this, args);
    };
    assert.deepStrictEqual(serialize('s', 'n', data, 'h'), reference(state.table, state.profile, data));
  } finally { Array.prototype.find = originalFind; }
  const originalIterator = Array.prototype[Symbol.iterator];
  try {
    Array.prototype[Symbol.iterator] = function () {
      return this === state.profile.fields ? [field('y', 'f1')][Symbol.iterator]() : originalIterator.call(this);
    };
    assert.deepStrictEqual(serialize('s', 'n', data, 'h'), reference(state.table, state.profile, data));
  } finally { Array.prototype[Symbol.iterator] = originalIterator; }
});

test('untrusted profiles preserve reference behavior without escaping into cache authority', () => {
  compareFactory(() => ({table: frozenTable([column('x', 'A')]),
    profile: frozenProfile([field('x', 'f0'), field('x', 'f0')]), data: {f0: 'value'}}), {trusted: false});
});

test('each result is fresh; mutable data values and value aliases are never cached or frozen', () => {
  const state = {table: frozenTable([column('x', 'A')]), profile: frozenProfile([field('x', 'f0')])};
  const {serialize} = projectorFor(state);
  const alias = {n: 1}, data = {f0: alias};
  const first = serialize('s', 'n', data, 'h');
  assert.strictEqual(first[0].data.f0, alias);
  assert.equal(Object.isFrozen(alias), false);
  first[0].data.f0 = 'changed result container';
  alias.n = 2;
  const second = serialize('s', 'n', data, 'h');
  assert.notStrictEqual(second, first);
  assert.notStrictEqual(second[0], first[0]);
  assert.notStrictEqual(second[0].data, first[0].data);
  assert.strictEqual(second[0].data.f0, alias);
  data.f0 = 0;
  assert.deepStrictEqual(serialize('s', 'n', data, 'h'), [{dataClass: 'A', data: {f0: 0}}]);
  assert.equal(data.f0, 0);
});

test('reference errors on malformed arrays, missing data and lookup failures remain errors', () => {
  for (const state of [
    {table: frozenTable([null]), profile: frozenProfile([field('x', 'f0')]), data: {f0: 1}},
    {table: frozenTable([undefined]), profile: frozenProfile([field('x', 'f0')]), data: {f0: 1}},
    {table: frozenTable(Object.freeze(new Array(1))), profile: frozenProfile([field('x', 'f0')]), data: {f0: 1}},
    {table: frozenTable([column('x', 'A')]), profile: frozenProfile([null]), data: {f0: 1}},
    {table: frozenTable([column('x', 'A')]), profile: frozenProfile([field('x', 'f0')]), data: null},
  ]) {
    let expected;
    try { reference(state.table, state.profile, state.data); } catch (error) { expected = error; }
    assert.ok(expected);
    assert.throws(() => projectorFor(state).serialize('s', 'n', state.data, 'h'), error => error.name === expected.name && error.message === expected.message);
  }
  for (const place of ['tableError', 'profileError']) {
    const state = {table: frozenTable([]), profile: frozenProfile([]), [place]: new Error('Synthetic lookup error')};
    assert.throws(() => projectorFor(state).serialize('s', 'n', {}, 'h'), error => error === state[place]);
  }
});

test('real registry profile/table failures retain their error codes', () => {
  const project = candidate.createSegmentProjector(H, C);
  const argsList = [
    ['synthetic-unknown-source', 'Rechnung_Z', {}, undefined],
    ['trade', 'synthetic-unknown-table', {}, undefined],
    ['trade', 'Rechnung_Z', {}, '0'.repeat(64)],
  ];
  for (const args of argsList) {
    let expected;
    try { reference(H.tableFor(args[0], args[1]), H.profileFor(args[0], args[1], args[3]), args[2]); }
    catch (error) { expected = error; }
    assert.ok(expected);
    assert.throws(() => project(...args), error => error.code === expected.code && error.name === expected.name && error.message === expected.message);
  }
});
