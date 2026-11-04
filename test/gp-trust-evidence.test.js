'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const evidence = require('../public/gp-trust-evidence.js');
const NOW = '2026-10-10T02:00:00Z';

test('missing evidence never becomes zero; valid numeric zero stays zero', () => {
  for (const value of [null, undefined, '', false, '0', NaN]) {
    assert.equal(evidence.index({score: value}).score, null);
    assert.equal(evidence.check({points: 5, earnedPoints: value}).deduction, null);
  }
  assert.equal(evidence.index({score: 0}).score, 0);
  assert.equal(evidence.check({state: 'fail', points: 5, earnedPoints: 0}).deduction, 5);
  assert.equal(evidence.check({points: 2, earnedPoints: 3}).points, null);
});

test('not applicable removes deduction; unknown is an unconfirmed proof, failure stays visible', () => {
  assert.equal(evidence.check({state: 'not_applicable', points: 5, earnedPoints: 0}).deduction, 0);
  assert.match(evidence.check({state: 'not_applicable'}).pointsText, /kein Punktabzug/);
  assert.match(evidence.check({state: 'unknown', points: 4, earnedPoints: 0}).pointsText, /4 Punkte nicht bestätigt/);
  const failed = evidence.check({state: 'fail', critical: true, points: 5, earnedPoints: 0, reasonCode: 'RECOVERY_AUTOMATION_FAILED_LATER_PROOF'});
  assert.equal(failed.critical, true);
  assert.match(failed.reason, /fehlgeschlagene Automatik bleibt sichtbar/);
  assert.equal(evidence.check({state: 'pass', critical: true}).critical, false);
});

test('cap remains separate from backend raw score and single deductions', () => {
  const original = {rawScore: 97, score: 49, coverage: 100, capReason: 'CRITICAL_CHECK_FAILED'};
  const result = evidence.index(original);
  assert.equal(result.rawScore, 97); assert.equal(result.score, 49);
  assert.match(result.reason, /kritischen Prüfung/);
  assert.deepEqual(original, {rawScore: 97, score: 49, coverage: 100, capReason: 'CRITICAL_CHECK_FAILED'});
  for (const coverage of [60,80,90]) assert.match(evidence.index({capReason: `EVIDENCE_COVERAGE_BELOW_${coverage}`}).reason, new RegExp(`${coverage} %`));
});

test('invalid dates, future dates and unreviewed reason codes are not presented as proof', () => {
  for (const value of ['2026-02-30T00:00:00Z', '2026-10-09T24:00:00Z', '2026-10-09T20:60:00Z', '2026-10-09T20:00:60Z', '2026-10-10', '2026-10-11T00:00:00Z', 'tomorrow']) assert.equal(evidence.timestamp(value, NOW), null);
  assert.equal(evidence.timestamp('2026-10-09T12:00:00+02:00', NOW), '2026-10-09T12:00:00+02:00');
  assert.equal(evidence.check({reasonCode: '<img onerror=alert(1)>'}).reasonCode, null);
});

test('deploy explanations preserve the original recovery proof and distinguish a timely start from success', () => {
  const observedAt = '2026-10-08T14:00:00Z';
  for (const reasonCode of ['RECOVERY_FULL_RUN_DEPLOY_DEFERRED', 'RECOVERY_ISOLATED_RESTORE_DEPLOY_DEFERRED', 'RECOVERY_APPLICATION_SMOKE_DEPLOY_DEFERRED']) {
    const input = {state: 'pass', points: 5, earnedPoints: 5, observedAt, reasonCode};
    const result = evidence.check(input, NOW);
    assert.equal(result.observedAt, observedAt);
    assert.equal(result.state, 'pass');
    assert.equal(result.deduction, 0);
    assert.match(result.reason, /bei Fälligkeit noch aktuell/);
    assert.match(result.reason, /Drei-Stunden-Frist/);
    assert.match(result.reason, /Nachweiszeitpunkt bleibt unverändert/);
    assert.deepEqual(input, {state: 'pass', points: 5, earnedPoints: 5, observedAt, reasonCode});
  }
  assert.match(evidence.check({state: 'pass', reasonCode: 'AUTOMATION_DEPLOY_DEFERRED'}).reason, /nachweislich aktiven Deployments pausiert/);
  const running = evidence.check({state: 'pass', reasonCode: 'AUTOMATION_DEPLOY_CATCHUP_RUNNING'});
  assert.match(running.reason, /innerhalb der Drei-Stunden-Frist begonnen/);
  assert.match(running.reason, /erfolgreicher Wiederherstellungstest ist damit noch nicht belegt/);
});

test('expired and interrupted deploy explanations keep critical failures and deductions visible', () => {
  for (const [reasonCode, explanation] of [
    ['AUTOMATION_DEPLOY_DEFERRAL_EXPIRED', /Frist ist abgelaufen/],
    ['AUTOMATION_DEPLOY_ABORTED', /Deployment wurde abgebrochen/],
    ['AUTOMATION_DEPLOY_ABANDONED', /nicht mehr nachweislich aktiv/]
  ]) {
    const result = evidence.check({state: 'fail', points: 5, earnedPoints: 0, critical: true, reasonCode});
    assert.match(result.reason, explanation);
    assert.equal(result.state, 'fail');
    assert.equal(result.critical, true);
    assert.equal(result.deduction, 5);
  }
});
