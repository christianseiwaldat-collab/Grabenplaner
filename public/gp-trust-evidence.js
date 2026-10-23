(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GpTrustEvidence = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
  const code = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(value) ? value : null;

  function timestamp(value, now) {
    if (typeof value !== 'string' || value.length > 80 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
    if (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return null;
    const civil = Date.parse(value.slice(0, 10) + 'T00:00:00Z');
    if (!Number.isFinite(civil) || new Date(civil).toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
    const ms = Date.parse(value), current = Date.parse(now || '');
    return Number.isFinite(ms) && (!Number.isFinite(current) || ms <= current + 300000) ? value : null;
  }

  function check(value = {}, now) {
    const state = ['pass', 'fail', 'unknown', 'not_applicable'].includes(value.state) ? value.state : 'unknown';
    const points = number(value.points), earned = number(value.earnedPoints);
    const valid = points !== null && earned !== null && earned <= points;
    const deduction = state === 'not_applicable' ? 0 : valid ? points - earned : null;
    const reasonCode = code(value.reasonCode);
    const reasons = {
      RECOVERY_AUTOMATION_FAILED_LATER_PROOF: 'Ein neuerer Wiederherstellungsnachweis liegt vor; die zuvor fehlgeschlagene Automatik bleibt sichtbar.',
      AUTOMATION_DEPLOY_DEFERRED: 'Der Nachtlauf ist wegen eines nachweislich aktiven Deployments pausiert. Sein Start darf höchstens drei Stunden nach der ursprünglichen Fälligkeit liegen.',
      AUTOMATION_DEPLOY_CATCHUP_RUNNING: 'Der nachgeholte Nachtlauf hat nachweislich innerhalb der Drei-Stunden-Frist begonnen und läuft noch. Ein erfolgreicher Wiederherstellungstest ist damit noch nicht belegt.',
      AUTOMATION_DEPLOY_DEFERRAL_EXPIRED: 'Die Drei-Stunden-Frist ist abgelaufen. Ein rechtzeitig gestarteter, weiterhin gültiger Nachtlauf oder ein neuer erfolgreicher Gesamtnachweis fehlt.',
      AUTOMATION_DEPLOY_ABORTED: 'Das Deployment wurde abgebrochen, nachdem der Nachtlauf fällig war. Der Aufschub gilt nicht mehr; ein ausreichender neuer Nachweis fehlt.',
      AUTOMATION_DEPLOY_ABANDONED: 'Das Deployment ist nach Fälligkeit des Nachtlaufs nicht mehr nachweislich aktiv. Der Aufschub gilt nicht mehr; ein ausreichender neuer Nachweis fehlt.',
      RECOVERY_FULL_RUN_DEPLOY_DEFERRED: 'Der letzte vollständige Assurance-Nachweis war bei Fälligkeit noch aktuell. Er bleibt während des validierten Deploy-Aufschubs bis zu dessen Drei-Stunden-Frist gültig; sein Nachweiszeitpunkt bleibt unverändert.',
      RECOVERY_ISOLATED_RESTORE_DEPLOY_DEFERRED: 'Der letzte erfolgreiche Test-Restore war bei Fälligkeit noch aktuell. Er bleibt während des validierten Deploy-Aufschubs bis zu dessen Drei-Stunden-Frist gültig; sein Nachweiszeitpunkt bleibt unverändert.',
      RECOVERY_APPLICATION_SMOKE_DEPLOY_DEFERRED: 'Der letzte erfolgreiche Anwendungsstart nach Restore war bei Fälligkeit noch aktuell. Er bleibt während des validierten Deploy-Aufschubs bis zu dessen Drei-Stunden-Frist gültig; sein Nachweiszeitpunkt bleibt unverändert.',
      NOTIFICATIONS_NOT_CONFIGURED: 'Externe Benachrichtigungen sind nicht eingerichtet.',
      EVIDENCE_UNAVAILABLE: 'Für diese Prüfung liegt kein ausreichender Nachweis vor.'
    };
    const reason = reasons[reasonCode] || ({
      pass: 'Die Prüfung ist erfüllt.', fail: 'Die Prüfung ist fehlgeschlagen.',
      unknown: 'Ein aktueller, ausreichender Nachweis fehlt.',
      not_applicable: 'Diese Prüfung zählt in dieser Betriebsart nicht zur Bewertung.'
    }[state]);
    const loss = state === 'unknown' ? ' Punkte nicht bestätigt' : deduction === 1 ? ' Punkt Abzug' : ' Punkte Abzug';
    return {
      state, points: valid ? points : null, earned: valid ? earned : null, deduction,
      pointsText: state === 'not_applicable' ? 'Nicht erforderlich · kein Punktabzug'
        : valid ? earned + ' / ' + points + ' Punkte' + (deduction > 0 ? ' · ' + deduction + loss : ' · kein Punktabzug') : 'Punkte nicht verfügbar',
      reason, reasonCode, critical: value.critical === true && state === 'fail', observedAt: timestamp(value.observedAt, now)
    };
  }

  function index(value = {}) {
    const reasonCode = code(value.capReason);
    const reasons = {
      CRITICAL_CHECK_FAILED: 'Begrenzung wegen einer fehlgeschlagenen kritischen Prüfung.',
      CRITICAL_ALERT_PRESENT: 'Begrenzung wegen eines kritischen Systemhinweises.',
      EVIDENCE_COVERAGE_BELOW_60: 'Begrenzung: Weniger als 60 % der gewichteten Nachweise sind bekannt.',
      EVIDENCE_COVERAGE_BELOW_80: 'Begrenzung: Weniger als 80 % der gewichteten Nachweise sind bekannt.',
      EVIDENCE_COVERAGE_BELOW_90: 'Begrenzung: Weniger als 90 % der gewichteten Nachweise sind bekannt.'
    };
    return { rawScore: number(value.rawScore), score: number(value.score), coverage: number(value.coverage),
      reasonCode, reason: reasons[reasonCode] || (reasonCode ? 'Der technische Index ist begrenzt.' : null) };
  }
  return Object.freeze({ check, index, timestamp });
});
