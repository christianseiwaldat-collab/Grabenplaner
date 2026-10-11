'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const start = require('../public/start-dashboard-workspace-preferences');
const personnel = require('../public/personnel-dashboard-workspace-preferences');
const {createStore} = require('../public/start-dashboard-workspace');
const models = [['Start', start, 'group:branch', 'Startdashboard'], ['Personal', personnel, 'card:requests', 'Personaldashboard']];
const note = (index = 1) => ({id:'custom:note-' + index, title:'  Eigene Notiz ' + index + '  ', text:'Text\nmit zweiter Zeile'});
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};

for (const [name, model, id, firstName] of models) {
  test(name + ': three independent named dashboards migrate legacy field settings without mutation', () => {
    const legacy = model.empty();
    legacy.fields[id] = {title:'Mein Feld', color:'blue', hidden:true, geometry:{x:42, y:53, width:350, height:260}};
    if (name === 'Personal') legacy.fields[id].content = ['absence.timeOff'];
    const original = structuredClone(legacy), document = model.toDocument(legacy);
    assert.equal(document.version, 2);
    assert.equal(document.activeDashboard, 'dashboard-1');
    assert.deepEqual(document.dashboards.map(item => item.id), ['dashboard-1', 'dashboard-2', 'dashboard-3']);
    assert.deepEqual(document.dashboards.map(item => item.name), [firstName, 'Dashboard 2', 'Dashboard 3']);
    assert.deepEqual(model.getBoard(document).fields, legacy.fields);
    assert.deepEqual(model.getBoard(model.selectDashboard(document, 'dashboard-2')).fields, {});
    assert.deepEqual(document.dashboards.map(item => item.customFields), [[], [], []]);
    document.dashboards[0].fields[id].geometry.width = 500;
    assert.deepEqual(legacy, original);
    assert.deepEqual(model.validate(legacy), original);
    assert.deepEqual(model.toDocument(model.toDocument(legacy)), model.toDocument(legacy));
  });

  test(name + ': tab selection, naming, notes and field edits preserve all other dashboard snapshots', () => {
    const first = model.toDocument(model.empty());
    first.dashboards[0].fields[id] = {title:'First', hidden:true};
    let changed = model.renameDashboard(model.selectDashboard(first, 'dashboard-2'), 'dashboard-2', '  Mein Arbeitsblick  ');
    const third = structuredClone(changed.dashboards[2]);
    const board = model.addCustomField(model.getBoard(changed), note());
    board.fields[id] = {title:'Second', color:'sage'};
    board.fields['custom:note-1'] = {color:'rose', hidden:true, geometry:{x:1, y:2, width:200, height:120}};
    changed = model.setBoard(changed, board);
    assert.equal(changed.activeDashboard, 'dashboard-2');
    assert.equal(changed.dashboards[1].name, 'Mein Arbeitsblick');
    assert.deepEqual(changed.dashboards[0], first.dashboards[0]);
    assert.deepEqual(changed.dashboards[2], third);
    assert.equal(first.dashboards[1].name, 'Dashboard 2');
    assert.deepEqual(first.dashboards[1].fields, {});
    assert.equal(model.getBoard(changed).customFields[0].title, 'Eigene Notiz 1');
    assert.equal(model.isFieldId('custom:note-1', model.getBoard(changed)), true);
    assert.equal(model.isFieldId('custom:unknown', model.getBoard(changed)), false);
    assert.equal(model.isFieldId(id), true);
    const copy = model.validate(JSON.parse(JSON.stringify(changed)));
    assert.deepEqual(copy, changed);
    copy.dashboards[1].customFields[0].text = 'Changed externally';
    assert.notEqual(model.getBoard(changed).customFields[0].text, 'Changed externally');
    const removed = model.removeCustomField(model.getBoard(changed), 'custom:note-1');
    assert.deepEqual(removed.customFields, []);
    assert.equal(Object.hasOwn(removed.fields, 'custom:note-1'), false);
    if (removed.order) assert.equal(removed.order.includes('custom:note-1'), false);
    assert.equal(model.getBoard(changed).customFields.length, 1);
  });

  test(name + ': strict three-dashboard document rejects duplicate IDs, unknown properties and malformed names', () => {
    const original = model.toDocument(model.empty()), cases = [];
    const malformed = edit => {const value = structuredClone(original); edit(value); cases.push(value);};
    malformed(value => {value.activeDashboard = 'dashboard-4';});
    malformed(value => {value.dashboards.pop();});
    malformed(value => {value.dashboards.push(structuredClone(value.dashboards[0]));});
    malformed(value => {value.dashboards[1].id = 'dashboard-1';});
    malformed(value => {value.dashboards[0].name = '';});
    malformed(value => {value.dashboards[0].name = 'x'.repeat(61);});
    malformed(value => {value.dashboards[0].name = 'x\ny';});
    malformed(value => {value.dashboards[0].owner = 'other-account';});
    malformed(value => {value.dashboards[0].fields = {'custom:missing':{title:'Unknown'}};});
    malformed(value => {delete value.dashboards[0].customFields;});
    malformed(value => {value.extra = true;});
    malformed(value => {delete value.dashboards[0];});
    malformed(value => {value.dashboards[0] = Object.assign(Object.create({inherited:true}), value.dashboards[0]);});
    malformed(value => {value[Symbol('hidden')] = true;});
    for (const value of cases) assert.throws(() => model.validate(value), TypeError);
    for (const title of ['', ' ', 'x'.repeat(61), 'Name\nMore']) assert.throws(() => model.renameDashboard(original, 'dashboard-1', title));
    assert.throws(() => model.renameDashboard(original, 'dashboard-4', 'Name'));
    assert.throws(() => model.selectDashboard(original, 'dashboard-4'));
    const reversed = {...original, dashboards:[...original.dashboards].reverse()};
    assert.deepEqual(model.validate(reversed), original);
    assert.deepEqual(model.renameDashboard(original, 'dashboard-1', 'x'.repeat(60)).dashboards[0].name, 'x'.repeat(60));
    assert.deepEqual(model.normalize(cases[0]), model.empty());
  });

  test(name + ': own fields are bounded text records, with no executable/embed/account properties', () => {
    const board = model.empty(), cases = [];
    for (const id of ['custom:', 'custom:../file', 'custom:<script>', '__proto__', 'group:branch', 'custom:' + 'a'.repeat(65)]) cases.push({...note(), id});
    for (const text of ['x'.repeat(2001), 'bad\u0000text', 1, null]) cases.push({...note(), text});
    for (const title of ['', ' ', 'x'.repeat(121), 'x\ny']) cases.push({...note(), title});
    for (const key of ['html', 'url', 'api', 'source', 'permissions', 'owner', '__proto__']) {
      const value = {...note()};
      Object.defineProperty(value, key, {value:'unsafe', enumerable:true});
      cases.push(value);
    }
    for (const value of cases) assert.throws(() => model.addCustomField(board, value), TypeError);
    let full = board;
    for (let index = 1; index <= model.CUSTOM_FIELD_LIMIT; index++) full = model.addCustomField(full, note(index));
    assert.equal(full.customFields.length, 20);
    assert.throws(() => model.addCustomField(full, note(21)), TypeError);
    assert.throws(() => model.addCustomField(full, note(1)), TypeError);
    assert.throws(() => model.removeCustomField(full, 'custom:unknown'), TypeError);
    assert.throws(() => model.validate({...board, customFields:new Array(1)}), TypeError);
    assert.throws(() => model.validate({...board, fields:JSON.parse('{"__proto__":{"title":"x"}}')}), TypeError);
    const literal = model.addCustomField(board, {...note(), title:'<script>alert(1)</script>', text:'<b>Only literal text</b>'});
    assert.equal(literal.customFields[0].text, '<b>Only literal text</b>');
    assert.deepEqual(model.empty(), board);
  });
}

test('Personal custom order preserves all static fields and legacy layout/content use only the active board', () => {
  let document = personnel.toDocument(personnel.empty());
  let board = personnel.addCustomField(personnel.getBoard(document), note());
  board.order = ['custom:note-1', ...personnel.IDS.slice().reverse()];
  board.fields['card:requests'] = {content:['absence.timeOff'], hidden:true};
  document = personnel.setBoard(document, board);
  assert.deepEqual(personnel.layout(document).order, personnel.IDS.slice().reverse().map(id => id.slice(5)));
  assert.deepEqual(personnel.layout(document).hidden, ['requests']);
  assert.deepEqual(personnel.content(document, 'card:requests'), ['absence.timeOff']);
  assert.deepEqual(personnel.layout(personnel.selectDashboard(document, 'dashboard-2')), personnel.layout(personnel.empty()));
  assert.equal(personnel.content(personnel.selectDashboard(document, 'dashboard-2'), 'card:requests').length, 4);
  assert.deepEqual(personnel.migrate(document, {order:['positions'], hidden:['employees']}), document);
  assert.throws(() => personnel.validate({...board, order:personnel.IDS}), TypeError);
  const sparse = personnel.empty(); delete sparse.order[0];
  assert.throws(() => personnel.validate(sparse), TypeError);
  const sparseContents = personnel.empty(); sparseContents.fields['card:requests'] = {content:new Array(1)};
  assert.throws(() => personnel.validate(sparseContents), TypeError);
});

for (const [name, model, id] of models) {
  test(name + ': serialized three-board saves preserve prior board settings and immutable snapshots during rapid tab changes', async () => {
    const first = deferred(), writes = [], property = name === 'Start' ? 'startDashboardWorkspace' : 'personnelDashboardWorkspace';
    const store = createStore({model, property, boards:true, canUse:() => true, key:() => 'A', error:assert.fail,
      ...(name === 'Personal' ? {extraPreferences:value => ({personnelDashboardLayout:model.layout(value)})} : {}),
      api:async (_url, options) => {if (options.method !== 'PUT') return {[property]:model.empty()};
        writes.push(JSON.parse(options.body)); if (writes.length === 1) await first.promise; return {};}});
    await store.activate(); assert.equal(store.document.version, 2); assert.equal(store.value.version, 1);
    const firstBoard = store.value; firstBoard.fields[id] = {title:'First board', color:'blue'};
    const saveFirst = store.change(firstBoard); firstBoard.fields[id].title = 'External mutation';
    const selectSecond = store.change(model.selectDashboard(store.document, 'dashboard-2'));
    const secondBoard = model.addCustomField(store.value, note()); secondBoard.fields[id] = {title:'Second board', hidden:true};
    const saveSecond = store.change(secondBoard), returnFirst = store.change(model.selectDashboard(store.document, 'dashboard-1'));
    await tick(); assert.equal(writes.length, 1); assert.equal(store.saving, true);
    assert.equal(store.value.fields[id].title, 'First board');
    assert.equal(store.document.dashboards[1].fields[id].title, 'Second board');
    first.resolve(); assert.deepEqual(await Promise.all([saveFirst, selectSecond, saveSecond, returnFirst]), [true, true, true, true]);
    assert.equal(store.saving, false); assert.equal(store.saveFailed, false); assert.equal(writes.length, 4);
    assert.equal(writes[0][property].dashboards[0].fields[id].title, 'First board');
    assert.deepEqual(writes.at(-1)[property], store.document);
    assert.equal(writes.at(-1)[property].dashboards[1].customFields.length, 1);
    if (name === 'Personal') assert.deepEqual(writes.at(-1).personnelDashboardLayout, model.layout(store.value));
  });

  test(name + ': failed v2 save is honest, retains draft and stable note ID, and latest-document retry persists once', async () => {
    const property = name === 'Start' ? 'startDashboardWorkspace' : 'personnelDashboardWorkspace', writes = [], errors = [];
    let fail = true;
    const store = createStore({model, property, boards:true, canUse:() => true, key:() => 'A', error:error => errors.push(error.message),
      api:async (_url, options) => {if (options.method !== 'PUT') return {[property]:model.empty()};
        writes.push(JSON.parse(options.body)); if (fail) {fail = false; throw Error('synthetic save failure');} return {};}});
    await store.activate();
    const next = model.addCustomField(store.value, note()); next.fields[id] = {hidden:true};
    assert.equal(await store.change(next), false); assert.equal(store.saveFailed, true); assert.equal(store.saving, false);
    assert.equal(store.value.customFields.length, 1); assert.equal(store.value.fields[id].hidden, true);
    assert.equal(await store.change(store.document), true); assert.equal(store.saveFailed, false);
    assert.equal(store.value.customFields.length, 1); assert.deepEqual(writes[1][property], writes[0][property]);
    assert.deepEqual(errors, ['synthetic save failure']);
  });
}

test('v2 actor and session replacement invalidates old reads, pending/queued writes and all prior dashboard notes', async () => {
  const oldRead = deferred(), oldWrite = deferred(), requests = [], errors = [];
  let actor = 'A', session = {}, oldGet = true;
  const store = createStore({model:start, boards:true, canUse:() => true, key:() => actor, sessionReference:() => session,
    error:error => errors.push(error), api:async (_url, options) => {requests.push(options);
      if (options.method === 'PUT') {await oldWrite.promise; return {};}
      if (oldGet) {oldGet = false; return oldRead.promise;} return {startDashboardWorkspace:start.toDocument(start.empty())};}});
  const stale = store.activate(); actor = 'B'; session = {}; const fresh = store.activate();
  const wrong = start.setBoard(start.toDocument(start.empty()), start.addCustomField(start.empty(), note()));
  oldRead.resolve({startDashboardWorkspace:wrong}); await Promise.all([stale, fresh]);
  assert.equal(requests[0].signal.aborted, true); assert.deepEqual(store.document, start.toDocument(start.empty()));
  const board = start.addCustomField(store.value, note()), first = store.change(board);
  const queued = store.change(start.selectDashboard(store.document, 'dashboard-2')); await tick();
  session = {}; assert.equal(store.ready, false); assert.deepEqual(store.document, start.toDocument(start.empty()));
  await store.activate(); oldWrite.resolve(); assert.deepEqual(await Promise.all([first, queued]), [false, false]);
  assert.equal(requests.filter(request => request.method === 'PUT').length, 1);
  assert.deepEqual(store.document, start.toDocument(start.empty())); assert.equal(store.saving, false); assert.deepEqual(errors, []);
});
