'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseDocument } = require('htmlparser2');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function load(ctx, name, input = source) {
  let start = input.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Real renderer ${name} exists`);
  if (input.slice(start - 6, start) === 'async ') start -= 6;
  const rest = input.slice(start + 1);
  const next = rest.search(/\r?\n(?:async )?function /);
  vm.runInNewContext(input.slice(start, next < 0 ? undefined : start + next + 1), ctx);
}
function context(extra = {}) {
  const ctx = { URL, ...extra };
  for (const name of ['escapeHtml', 'escapeHtmlAttribute', 'safeCssColor', 'safeWorkRuleSourceUrl']) load(ctx, name);
  return ctx;
}
function nodes(root, predicate) {
  const found = [];
  function visit(node) { if (predicate(node)) found.push(node); for (const child of node.children || []) visit(child); }
  visit(root); return found;
}

test('real employee color cell rejects extra CSS declarations and attribute escapes', () => {
  const ctx = context({ employeeDisplayRawValue: employee => employee.color });
  load(ctx, 'employeeDisplayCell');
  for (const color of ['#ffffff;position:fixed;inset:0', '#ffffff" onmouseover="alert(1)', 'url(https://example.invalid/pixel)', null]) {
    const document = parseDocument(ctx.employeeDisplayCell({ color }, { id: 'color' }));
    const spans = nodes(document, node => node.name === 'span');
    assert.equal(spans.length, 1);
    assert.deepEqual(spans[0].attribs, { class: 'employee-color', style: 'background:#6b7b75' });
  }
  const valid = parseDocument(ctx.employeeDisplayCell({ color: '#Ab12ef' }, { id: 'color' }));
  assert.equal(nodes(valid, node => node.name === 'span')[0].attribs.style, 'background:#Ab12ef');
  assert.equal(ctx.safeCssColor('invalid', 'red;position:fixed'), '#0b84c6');
});

function agreementDocument(url) {
  const target = { innerHTML: '' };
  const ctx = context({
    elements: { collectiveAgreementDetail: target }, state: { selectedCollectiveAgreementId: 'agreement' },
    collectiveAgreementValidity: () => '2026', collectiveAgreementReviewLabel: () => 'Geprüft',
    collectiveAgreementDefinitionList: () => '', formatDate: value => value,
  });
  load(ctx, 'renderCollectiveAgreementDetail');
  ctx.renderCollectiveAgreementDetail({ agreements: [{ id: 'agreement', code: 'SYNTHETIC', title: 'Synthetic',
    jurisdiction: 'AT', currentVersionId: 'v1', versions: [{ id: 'v1', versionLabel: '2026',
      source: { url, title: 'Source "title" & data', sha256: 'a'.repeat(64), retrievedOn: '2026-10-18' } }] }] });
  return parseDocument(target.innerHTML);
}

test('real agreement renderer makes unsafe source schemes inert while preserving title and HTTPS link', () => {
  for (const url of ['javascript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,<svg onload=alert(1)>', '//example.invalid']) {
    const document = agreementDocument(url);
    assert.equal(nodes(document, node => node.name === 'a').length, 0);
    assert.ok(nodes(document, node => node.type === 'text').some(node => node.data === 'Source "title" & data'));
  }
  const document = agreementDocument('https://example.invalid/source?a=1&b=2');
  const anchors = nodes(document, node => node.name === 'a');
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].attribs.href, 'https://example.invalid/source?a=1&b=2');
  assert.equal(anchors[0].attribs.rel, 'noopener noreferrer');
});

test('real readiness renderer emits only HTTP(S) standard links', () => {
  const ctx = context({ productReadinessStateCopy: () => ({ state: 'ok', icon: '✓', label: 'Bestanden' }) });
  load(ctx, 'renderProductReadiness');
  function links(url) {
    const document = parseDocument(ctx.renderProductReadiness({ state: 'accepted', gates: [
      { id: 'security', state: 'ok', label: 'Security', standard: { label: 'ASVS', url } },
    ] }));
    return nodes(document, node => node.name === 'a');
  }
  assert.equal(links('javascript:alert(1)').length, 0);
  assert.equal(links('data:text/html,unsafe').length, 0);
  assert.equal(links('https://owasp.org/projects/asvs')[0].attribs.href, 'https://owasp.org/projects/asvs');
  assert.equal(links('https://owasp.org/projects/asvs')[0].attribs.rel, 'noopener noreferrer');
});

test('real portal renderers constrain employee and workspace launch colors', () => {
  const portal = fs.readFileSync(path.join(__dirname, '../public/portal.js'), 'utf8');
  const target = () => ({ innerHTML: '', classList: { toggle() {} } });
  for (const color of ['#ffffff;position:fixed', '#ffffff" onclick="unsafe', null, '#Ab12ef']) {
    const expected = color === '#Ab12ef' ? color : '#7b8983';
    const el = { leadershipPresenceSummary: target(), leadershipPresenceList: target(), mobileHomeTiles: target() };
    const ctx = { el, portalState: { activeTab: 'home' },
      leadershipPresence: () => ({ employees: [{ color, entries: [], nickname: 'Synthetic' }] }),
      timeStateLabels: {}, durationText: () => '0 h', isMobileUi: () => true,
      mobileHomeTilesForCurrentAccount: () => [], privatePortalWorkspaces: { launches: [
        { id: 'synthetic', launch: { color, label: 'Synthetic' } },
      ] },
    };
    for (const name of ['esc', 'safeCssColor', 'renderLeadershipPresence', 'renderMobileHome']) load(ctx, name, portal);
    ctx.renderLeadershipPresence(); ctx.renderMobileHome();
    const presence = nodes(parseDocument(el.leadershipPresenceList.innerHTML), node => node.attribs?.class === 'leadership-person-dot');
    assert.deepEqual(presence[0].attribs, { class: 'leadership-person-dot', style: `--person-color:${expected}` });
    const launch = nodes(parseDocument(el.mobileHomeTiles.innerHTML), node => node.name === 'button')[0];
    assert.equal(launch.attribs.style, `--private-launch-color:${expected};--mobile-home-tile-color:${expected}`);
    assert.equal(launch.attribs.onclick, undefined);
  }
});

test('real PDF export renderer encodes query values and quoted link attributes', () => {
  const elements = { pdfButton: { setAttribute() {} }, schedulePdfDesignMenu: { innerHTML: '' } };
  const weekStart = '2026-10-18" onclick="unsafe';
  const ctx = context({ elements, state: { weekStart }, schedulePdfDesignCatalog: () => [],
    schedulePdfDesignIdsFromSettings: () => ['one', 'two'], contextQuery: () => '&location=1', closeSchedulePdfDesignMenu() {},
  });
  load(ctx, 'renderSchedulePdfExportControl'); ctx.renderSchedulePdfExportControl();
  const anchors = nodes(parseDocument(elements.schedulePdfDesignMenu.innerHTML), node => node.name === 'a');
  assert.equal(anchors.length, 2);
  for (const anchor of anchors) {
    assert.equal(anchor.attribs.onclick, undefined);
    const parsed = new URL(anchor.attribs.href, 'https://example.invalid');
    assert.equal(parsed.pathname, '/api/schedule.pdf');
    assert.equal(parsed.searchParams.get('week'), weekStart);
    assert.equal(parsed.searchParams.get('location'), '1');
  }
});

test('real time presence and day review renderers keep unexpected state and CSS inert', () => {
  const elements = { timePresenceList: { innerHTML: '' }, timePresenceSummary: { innerHTML: '' },
    timePresenceUpdated: { textContent: '' }, timeDayReviewList: { innerHTML: '' }, timeDayReviewSummary: { innerHTML: '' } };
  const malicious = '<img src=x onerror=unsafe>';
  const ctx = context({ elements, state: {
    timePresence: { trackingEnabled: true, employees: [{ state: malicious, entries: [] }] },
    timeDayReview: { evaluations: [{ color: '#ffffff;position:fixed', issues: [] }] },
  }, personnelRecordAvailableInUi: () => false, formatClockTimestamp: () => '00:00', formatHours: () => '0', formatTimeDifference: () => '0' });
  for (const name of ['timeEvaluationIssues', 'renderTimePresence', 'renderTimeDayReview']) load(ctx, name);
  ctx.renderTimePresence(); ctx.renderTimeDayReview();
  assert.equal(nodes(parseDocument(elements.timePresenceList.innerHTML), node => node.name === 'img').length, 0);
  assert.ok(nodes(parseDocument(elements.timePresenceList.innerHTML), node => node.type === 'text').some(node => node.data === malicious));
  const colors = nodes(parseDocument(elements.timeDayReviewList.innerHTML), node => node.attribs?.class === 'employee-color');
  assert.equal(colors[0].attribs.style, 'background:#748087');
});

test('real department and delegation renderers preserve unusual identifiers as data attributes', async () => {
  const id = '123" onclick="unsafe';
  const elements = { timeTrackingLocation: { value: '1' }, timeTrackingDepartment: { innerHTML: '' },
    delegationList: { innerHTML: '' }, delegationLocation: { innerHTML: '' }, delegationSettingsCard: { classList: { toggle() {} } } };
  const ctx = context({ elements, state: { locations: [{ id: '1', name: 'Synthetic', departments: [{ id, name: 'Synthetic' }] }] },
    api: async () => ({ delegations: [{ id, location_name: 'Synthetic', date_from: '2026-10-18', date_to: '2026-10-19' }] }),
    refreshDelegationEmployees() {}, formatDate: value => value,
  });
  load(ctx, 'refreshTimePresenceDepartments'); load(ctx, 'loadApprovalDelegations');
  ctx.refreshTimePresenceDepartments(); await ctx.loadApprovalDelegations();
  const options = nodes(parseDocument(elements.timeTrackingDepartment.innerHTML), node => node.name === 'option');
  assert.equal(options[1].attribs.value, id); assert.equal(options[1].attribs.onclick, undefined);
  const rows = nodes(parseDocument(elements.delegationList.innerHTML), node => node.attribs?.class === 'delegation-row');
  assert.equal(rows[0].attribs['data-delegation-id'], id); assert.equal(rows[0].attribs.onclick, undefined);
});
