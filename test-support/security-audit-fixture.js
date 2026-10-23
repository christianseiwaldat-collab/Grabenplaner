'use strict';
function syntheticRun() {
  return { id: 'synthetic-audit-001', title: 'PRIVATE-SYNTHETIC-AUDIT', standardVersion: '5.0.0',
    performedAt: '2026-10-18', auditor: 'Synthetic tester', scope: 'Synthetic local fixture only',
    target: { commit: 'a'.repeat(40), version: '0.0.0-test', environment: 'test' },
    limitations: ['Synthetic fixture, no production assessment'],
    checks: [
      { requirementId: 'v5.0.0-7.3.2', status: 'failed', method: 'automated_test', note: 'Synthetic observation only',
        evidence: [{ kind: 'test', reference: 'synthetic/test-only', summary: 'Synthetic failed case' }] },
      { requirementId: 'v5.0.0-7.4.1', status: 'partial', method: 'code_review', note: 'Only one synthetic path inspected',
        evidence: [{ kind: 'source', reference: 'synthetic/source-only', summary: 'Partial synthetic review' }] },
    ],
    findings: [{ id: 'SYN-001', title: 'PRIVATE-SYNTHETIC-FINDING', priority: 'P2', severity: 'medium', status: 'open', confidence: 'hypothesis',
      requirementIds: ['v5.0.0-7.3.2'], description: 'Synthetic observation', impact: 'Synthetic impact',
      recommendation: 'Synthetic recommendation', acceptance: 'Synthetic retest only', owner: '', dueDate: '', note: '', retestEvidence: '' }],
  };
}
module.exports = { syntheticRun };
