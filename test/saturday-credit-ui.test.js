"use strict";
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function fixture(api) {
  const fields = new Map();
  const control = id => {
    if (!fields.has(id)) fields.set(id, { value: '', disabled: false, textContent: '', children: [], classes: new Set(),
      classList: { add(name) { fields.get(id).classes.add(name); }, toggle(name, yes) { if (yes) fields.get(id).classes.add(name); else fields.get(id).classes.delete(name); } },
      replaceChildren() { this.children = []; }, append(child) { this.children.push(child); } });
    return fields.get(id);
  };
  const state = {}, messages = [];
  const context = vm.createContext({ state, api, Date, document: { querySelector: control, createElement: () => ({ textContent: '' }) },
    toIsoDate: () => '2026-09-07', formatDate: value => value, showToast: (...args) => messages.push(args) });
  const from = app.indexOf('async function loadEmployeeSaturdayCredit('), to = app.indexOf('async function saveEmployee(event)', from);
  assert.ok(from > 0 && to > from); vm.runInContext(app.slice(from, to), context);
  return { state, control, messages, load: context.loadEmployeeSaturdayCredit, save: context.saveEmployeeSaturdayCredit };
}
const data = { cutoverDate: '2026-09-07', assignment: { activity: 'retail_sales' }, canAssign: true, canConfigure: true,
  history: [{ id: 'first', effectiveDate: '2026-09-07', activity: 'retail_sales', reason: '<script>synthetic</script>' }] };
test('employee form displays the explicit sales decision and saves its date and history precondition', async () => {
  const calls = [], f = fixture(async (url, options) => { calls.push({ url, options }); return data; });
  await f.load({ personnel_number: '419' }, true);
  assert.equal(f.control('#employeeSalesActivity').value, 'retail_sales');
  assert.equal(f.control('#employeeSalesSave').disabled, false);
  assert.match(f.control('#employeeSalesHistory').children[0].textContent, /<script>synthetic/);
  f.control('#employeeSalesActivity').value = 'other'; f.control('#employeeSalesReason').value = 'Activity changed';
  await f.save();
  assert.deepEqual(JSON.parse(calls[1].options.body), { effectiveDate: '2026-09-07', activity: 'other', reason: 'Activity changed', expectedPreviousId: 'first' });
  assert.equal(calls[1].url, '/api/employees/419/saturday-credit');
});
test('read-only personnel access cannot save; stale responses cannot overwrite another employee', async () => {
  let calls = 0; const f = fixture(async () => { calls++; return { ...data, canAssign: false }; });
  await f.load({ personnel_number: '419' }, true); await f.save(); assert.equal(calls, 1);
  assert.equal(f.control('#employeeSalesSave').disabled, true);
  const pending = []; const race = fixture(() => new Promise(resolve => pending.push(resolve)));
  const first = race.load({ personnel_number: '419' }, true), second = race.load({ personnel_number: '420' }, true);
  pending[1]({ ...data, assignment: { activity: 'other' } }); await second;
  pending[0](data); await first;
  assert.equal(race.state.employeeSaturdayCredit.employeeNumber, '420'); assert.equal(race.control('#employeeSalesActivity').value, 'other');
  await race.load(null, true); assert.equal(race.control('#employeeSalesSave').disabled, true);
});
