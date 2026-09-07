"use strict";
const crypto = require('node:crypto');
const { assertPersistenceAccess } = require('../contract');
const { SATURDAY_CREDIT_STATEMENTS: S } = require('../statements/saturday-credit');
const { canonicalSha256 } = require('../../work-rules/receipt');
const { SATURDAY_CREDIT_POLICY: POLICY, evaluateCompanySaturdayCredit } = require('../../work-rules/saturday-credit');
const dateValid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
function fail(code, message, status = 409) { throw Object.assign(new Error(message), { code: 'SATURDAY_CREDIT_' + code, status }); }
function text(value, maximum = 160) { return typeof value === 'string' && value.trim() && value.length <= maximum; }
function signed(value) { return { ...value, sha256: canonicalSha256(value) }; }
function verify(row) {
  if (!row) return null;
  const { sha256, ...value } = row.payload || {};
  if (canonicalSha256(value) !== sha256 || value.id !== row.id || value.employeeNumber !== row.employeeNumber
    || value.effectiveDate !== row.effectiveDate || value.createdBy !== row.createdBy || value.createdAt !== row.createdAt) {
    fail('RECEIPT_INVALID', 'Der gespeicherte Nachweis der Samstagsregel ist ungueltig.');
  }
  return row.payload;
}
function createSaturdayCreditService({ access, clock = () => new Date().toISOString(), today }) {
  assertPersistenceAccess(access);
  if (typeof today !== 'function') throw new TypeError('A local calendar is required');
  const get = async (id, executor = access) => verify(await executor.queryOne(S.get, { id }));
  async function insert(executor, kind, value) {
    const payload = signed(value);
    await executor.execute(S.insert, { id: value.id, kind, employeeNumber: value.employeeNumber,
      effectiveDate: value.effectiveDate, payload, createdBy: value.createdBy, createdAt: value.createdAt });
    const stored = await get(value.id, executor);
    if (stored.sha256 !== payload.sha256) fail('CONCURRENT_CHANGE', 'Der Bewertungsstand wurde zwischenzeitlich geaendert.');
    return stored;
  }
  async function status(employeeNumber, date = today(), executor = access) {
    if (!text(employeeNumber) || !dateValid(date)) fail('INPUT_INVALID', 'Personalnummer oder Datum ungueltig.', 400);
    const cutover = await get('saturday-credit-cutover', executor);
    const assignment = verify(await executor.queryOne(S.assignment, { employeeNumber, effectiveDate: date }));
    return { cutover, assignment, date, policy: POLICY };
  }
  return Object.freeze({
    status,
    importedDay: (employeeNumber, workDate) => access.queryAll(S.importedDay, { employeeNumber, workDate }),
    async initialize({ effectiveDate, legacySettings, actor = 'system-release', authorize, existingEmployees }) {
      if (!dateValid(effectiveDate) || !legacySettings || !text(actor)) fail('CUTOVER_INVALID', 'Ein gueltiger Stichtag fehlt.', 400);
      return access.transaction(async tx => {
        if (authorize) {
          actor = await authorize(tx);
          if (!text(actor)) fail('FORBIDDEN', 'Die Umstellung ist nicht freigegeben.', 403);
        }
        const existing = await get('saturday-credit-cutover', tx);
        if (existing) {
          if (authorize && existing.effectiveDate !== effectiveDate) fail('CUTOVER_FIXED', 'Der bestehende Umstellungsstichtag bleibt unveraendert.');
          return existing;
        }
        const employees = existingEmployees ? await existingEmployees(tx) : [];
        if (!Array.isArray(employees) || employees.some(number => !text(number)) || new Set(employees).size !== employees.length) fail('ROLLOUT_INVALID', 'Der Personalbestand fuer die Umstellung ist ungueltig.');
        const createdAt = clock();
        const cutover = await insert(tx, 'cutover', { id: 'saturday-credit-cutover', employeeNumber: '', effectiveDate,
          policyId: POLICY.id, policyVersion: POLICY.version, legacySettings,
          initialSalesAssignmentCount: employees.length, createdBy: actor, createdAt });
        for (const employeeNumber of employees) await insert(tx, 'assignment', {
          id: crypto.randomUUID(), employeeNumber, effectiveDate, activity: 'retail_sales',
          reason: 'Freigegebene Verkaufszuordnung des vorhandenen Personalbestands beim Umstieg.', previousId: '',
          policyId: POLICY.id, policyVersion: POLICY.version, applicabilityConfirmed: true, createdBy: actor, createdAt });
        return cutover;
      }, { isolation: 'serializable' });
    },
    async history(employeeNumber) {
      const current = await status(employeeNumber);
      return { ...current, history: (await access.queryAll(S.history, { employeeNumber })).map(verify) };
    },
    async assign(input, authorize) {
      const { employeeNumber, activity, effectiveDate, reason, expectedPreviousId = '' } = input || {};
      if (!text(employeeNumber) || !['retail_sales', 'other'].includes(activity) || !dateValid(effectiveDate)
        || !text(reason, 500) || typeof expectedPreviousId !== 'string' || typeof authorize !== 'function') {
        fail('ASSIGNMENT_INVALID', 'Bitte Verkaufstaetigkeit, Datum und Begruendung angeben.', 400);
      }
      return access.transaction(async tx => {
        // Recheck the live actor and employee scope inside this transaction.
        const actor = await authorize(tx, employeeNumber);
        if (!text(actor)) fail('FORBIDDEN', 'Die Verkaufszuordnung ist nicht freigegeben.', 403);
        const current = await status(employeeNumber, effectiveDate, tx);
        if (!current.cutover) fail('CUTOVER_REQUIRED', 'Die Umstellung ist noch nicht eingerichtet.');
        if (effectiveDate < current.cutover.effectiveDate) fail('BEFORE_CUTOVER', 'Die Zuordnung darf nicht vor dem Umstellungsstichtag beginnen.');
        const history = (await tx.queryAll(S.history, { employeeNumber })).map(verify);
        if ((history[0]?.id || '') !== expectedPreviousId) fail('CONCURRENT_CHANGE', 'Die Zuordnung wurde geaendert. Bitte neu laden.');
        if (history.length >= 200) fail('HISTORY_LIMIT', 'Bitte die Zuordnungshistorie pruefen.');
        const createdAt = clock();
        if (history[0] && createdAt <= history[0].createdAt) fail('CONCURRENT_CHANGE', 'Bitte die Zuordnung nochmals speichern.');
        return insert(tx, 'assignment', { id: crypto.randomUUID(), employeeNumber, effectiveDate, activity,
          reason: reason.trim(), previousId: expectedPreviousId, policyId: POLICY.id, policyVersion: POLICY.version,
          applicabilityConfirmed: true, createdBy: actor, createdAt });
      }, { isolation: 'serializable' });
    },
    async evaluate({ employeeNumber, workDate, source, segments, dayComplete, breaksResolved,
      publicHoliday, premiumReviewComplete = true, legacy, persist = false }) {
      const context = await status(employeeNumber, workDate);
      if (!context.cutover || workDate < context.cutover.effectiveDate) return { ...legacy, saturdayCreditStatus: 'legacy', saturdayCreditReceipt: null };
      const saturday = new Date(workDate + 'T00:00:00Z').getUTCDay() === 6;
      const workedMinutes = Number(legacy.workedMinutes || 0);
      if (!saturday || workedMinutes === 0 || (dayComplete === true && breaksResolved === true && Array.isArray(segments) && segments.length > 0 && segments.every(s => s.endMinute <= 780))) return { ...legacy, saturdayBonusMinutes: 0, saturdayEligibleMinutes: 0,
        valuedMinutes: workedMinutes, saturdayCreditStatus: 'not_applicable', saturdayCreditReceipt: null };
      const assignment = context.assignment;
      if (assignment?.activity === 'other') return { ...legacy, saturdayBonusMinutes: 0, saturdayEligibleMinutes: 0,
        valuedMinutes: workedMinutes, saturdayCreditStatus: 'not_sales', saturdayCreditReceipt: assignment.sha256 };
      if (!assignment) return { ...legacy, saturdayBonusMinutes: 0, saturdayEligibleMinutes: 0,
        valuedMinutes: workedMinutes, saturdayCreditStatus: 'review_required', saturdayCreditIssues: ['sales_assignment_required'], saturdayCreditReceipt: null };
      const result = evaluateCompanySaturdayCredit({ employeeNumber, workDate, cutoverDate: context.cutover.effectiveDate,
        assignment: { id: assignment.id, employeeNumber, policyId: POLICY.id, policyVersion: POLICY.version,
          receiptId: assignment.sha256, confirmedBy: assignment.createdBy, applicabilityConfirmed: true,
          activity: assignment.activity, validFrom: assignment.effectiveDate },
        segments, dayComplete, breaksResolved, premiumReviewComplete, publicHoliday });
      if (!result.calculationReady) return { ...legacy, saturdayBonusMinutes: 0, saturdayEligibleMinutes: 0,
        valuedMinutes: workedMinutes, saturdayCreditStatus: 'review_required', saturdayCreditIssues: result.issues, saturdayCreditReceipt: null };
      const id = 'saturday-valuation-' + canonicalSha256({ employeeNumber, workDate, source, receipt: result.receiptSha256 });
      let receipt = await get(id);
      if (!receipt && persist) receipt = await access.transaction(async tx => await get(id, tx) || insert(tx, 'valuation', { id, employeeNumber, effectiveDate: workDate,
        source, calculation: result, createdBy: 'time-evaluation', createdAt: clock() }), { isolation: 'serializable' });
      return { ...legacy, saturdayBonusMinutes: result.bonusMinutes, saturdayEligibleMinutes: result.eligibleMinutes,
        valuedMinutes: workedMinutes + result.bonusMinutes, saturdayCreditStatus: 'calculated',
        saturdayCreditReceipt: result.receiptSha256, saturdayCreditRecordId: receipt?.id || null };
    },
  });
}
module.exports = { createSaturdayCreditService };
