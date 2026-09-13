"use strict";
const C = require('./data-import-contract');
const H = require('./tradefoto-history-profiles');
const policies = new WeakSet();
const coverages = new WeakSet();
const STATUS_FIELDS = Object.freeze(['AStorno', 'BStorno', 'Ret', 'R', 'N', 'ZR', 'set', 'SonderartikelS', 'Beratung']);
const FILTER_FIELDS = Object.freeze(['productGroups', 'vatCodes', 'articleNumbers']);
const SCALE = 324, UNIT = 10n ** 324n;
function decimal(value) {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d{0,19})(?:\.\d{1,324})?$/u.test(value)) C.fail('IMPORT_SALES_DECIMAL_INVALID');
  const negative = value.startsWith('-'), [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return BigInt(whole + fraction.padEnd(SCALE, '0')) * (negative ? -1n : 1n);
}
const abs = value => value < 0n ? -value : value;
function divide(numerator, denominator) {
  if (denominator <= 0n) C.fail('IMPORT_SALES_DIVISOR_INVALID');
  const magnitude = abs(numerator), quotient = magnitude / denominator, remainder = magnitude % denominator;
  return (quotient + (remainder * 2n >= denominator ? 1n : 0n)) * (numerator < 0n ? -1n : 1n);
}
function format(value, places) {
  const sign = value < 0n ? '-' : '', digits = abs(value).toString().padStart(places + 1, '0');
  return sign + (places ? digits.slice(0, -places) + '.' + digits.slice(-places) : digits);
}
function minor(value, scale) { return divide(decimal(value), 10n ** BigInt(SCALE - scale)); }
function validateFilters(filters) {
  for (const key of FILTER_FIELDS) if (filters[key] !== undefined) {
    if (!Array.isArray(filters[key]) || !filters[key].length || filters[key].length > 100 || new Set(filters[key]).size !== filters[key].length) C.fail('IMPORT_SALES_STATUS_RULES');
    filters[key].forEach(value => C.text(value, 32));
  }
}
function matchesFilters(row, filters) {
  return (!filters.productGroups || filters.productGroups.includes(String(row.Sortiment)))
    && (!filters.vatCodes || filters.vatCodes.includes(row.MWST))
    && (!filters.articleNumbers || filters.articleNumbers.includes(row.EAN));
}
// No production policy is supplied. This factory is for trusted, evidence-backed
// composition only, never for a raw HTTP body or a guessed AStorno convention.
function defineTradeFotoSalesPolicy(input) {
  C.exact(input, ['id', 'version', 'scopeId', 'sourceInstance', 'schemaSha256', 'evidenceSha256', 'approvedBy', 'approvedAt',
    'currency', 'minorUnits', 'priceBasis', 'priceMeaning', 'headerBasis', 'rounding', 'vatRates', 'statusRules', 'headerToleranceMinor', 'headerZeroMeaning', 'zeroPriceVatCodes', 'zeroPriceVatExceptions', 'headerBasisOverrides']);
  for (const key of ['id', 'scopeId', 'sourceInstance', 'approvedBy']) C.id(input[key]);
  C.integer(input.version, 1, 10000); C.sha(input.schemaSha256); C.sha(input.evidenceSha256); C.utc(input.approvedAt);
  if (input.schemaSha256 !== H.profileFor('cash', 'Umsatz_KASSE').schemaSha256) C.fail('IMPORT_SALES_POLICY_SCHEMA');
  if (typeof input.currency !== 'string' || !/^[A-Z]{3}$/u.test(input.currency)) C.fail('IMPORT_SALES_CURRENCY');
  C.integer(input.minorUnits, 0, 4); C.integer(input.headerToleranceMinor, 0, 100);
  if (input.headerZeroMeaning !== undefined && !['amount', 'unavailable'].includes(input.headerZeroMeaning)) C.fail('IMPORT_SALES_POLICY_INVALID');
  if (!['gross', 'net'].includes(input.priceBasis) || !['gross', 'net'].includes(input.headerBasis)
    || !['final_unit', 'final_line'].includes(input.priceMeaning) || input.rounding !== 'half_away_from_zero') C.fail('IMPORT_SALES_POLICY_INVALID');
  if (!C.plain(input.vatRates) || !Object.keys(input.vatRates).length || Object.keys(input.vatRates).length > 100) C.fail('IMPORT_SALES_VAT_INVALID');
  for (const [code, rate] of Object.entries(input.vatRates)) { C.text(code, 32); const value = decimal(rate); if (value < 0n || value > 100n * UNIT) C.fail('IMPORT_SALES_VAT_INVALID'); }
  if (input.zeroPriceVatCodes !== undefined && (!Array.isArray(input.zeroPriceVatCodes) || input.zeroPriceVatCodes.some(code => !Object.hasOwn(input.vatRates, code)))) C.fail('IMPORT_SALES_VAT_INVALID');
  if (input.zeroPriceVatExceptions !== undefined) {
    if (!Array.isArray(input.zeroPriceVatExceptions) || !input.zeroPriceVatExceptions.length || input.zeroPriceVatExceptions.length > 10) C.fail('IMPORT_SALES_VAT_INVALID');
    for (const filter of input.zeroPriceVatExceptions) {
      C.exact(filter, FILTER_FIELDS); validateFilters(filter);
      if (!filter.vatCodes || !filter.productGroups && !filter.articleNumbers
        || filter.vatCodes.some(code => !input.zeroPriceVatCodes?.includes(code))) C.fail('IMPORT_SALES_VAT_INVALID');
    }
  }
  if (input.headerBasisOverrides !== undefined) {
    if (!Array.isArray(input.headerBasisOverrides) || input.headerBasisOverrides.length > 1000) C.fail('IMPORT_SALES_POLICY_INVALID');
    const seen = new Set();
    for (const item of input.headerBasisOverrides) {
      C.exact(item, ['receiptFingerprint', 'basis']); C.sha(item.receiptFingerprint);
      if (!['gross', 'net'].includes(item.basis) || seen.has(item.receiptFingerprint)) C.fail('IMPORT_SALES_POLICY_INVALID');
      seen.add(item.receiptFingerprint);
    }
  }
  if (!Array.isArray(input.statusRules) || !input.statusRules.length || input.statusRules.length > 100) C.fail('IMPORT_SALES_STATUS_RULES');
  const ruleIds = new Set();
  for (const rule of input.statusRules) {
    C.exact(rule, ['id', 'status', 'flags', 'quantitySign', 'productGroups', 'vatCodes', 'articleNumbers', 'except']); C.id(rule.id);
    if (ruleIds.has(rule.id)) C.fail('IMPORT_SALES_STATUS_RULES'); ruleIds.add(rule.id);
    if (!['sale', 'return', 'adjustment', 'deposit', 'payment', 'voucher_issue', 'uid_clearing', 'excluded'].includes(rule.status) || !['positive', 'negative', 'zero', 'any'].includes(rule.quantitySign)) C.fail('IMPORT_SALES_STATUS_RULES');
    validateFilters(rule);
    if (rule.except !== undefined) {
      if (!Array.isArray(rule.except) || !rule.except.length || rule.except.length > 10) C.fail('IMPORT_SALES_STATUS_RULES');
      for (const filter of rule.except) {
        C.exact(filter, FILTER_FIELDS);
        if (!FILTER_FIELDS.some(key => filter[key] !== undefined)) C.fail('IMPORT_SALES_STATUS_RULES');
        validateFilters(filter);
      }
    }
    C.exact(rule.flags, STATUS_FIELDS);
    if (STATUS_FIELDS.some(field => !Object.hasOwn(rule.flags, field) || ![true, false, null].includes(rule.flags[field]))) C.fail('IMPORT_SALES_STATUS_RULES');
  }
  const data = JSON.parse(C.canonical(input)), policy = C.freeze({ ...data, fingerprint: C.fingerprint(data) }); policies.add(policy); return policy;
}
function checkPolicy(policy, { scopeId, sourceInstance }) {
  if (!policy) return 'SALES_SEMANTICS_UNCONFIRMED';
  if (!policies.has(policy)) C.fail('IMPORT_SALES_POLICY_UNTRUSTED');
  if (policy.scopeId !== scopeId || policy.sourceInstance !== sourceInstance) C.fail('IMPORT_SALES_POLICY_SCOPE');
  return '';
}
function sourceFingerprint(table, row) {
  return C.fingerprint(C.normalizeDataImportRow(H.profileFor('cash', table), row).source);
}
// Receipt membership must come from the COMPLETE, independently reconciled source
// read (Block 6 composition), not from a page of already imported GP lines. A
// matching amount alone cannot prove coverage: omitted zero/void rows still matter.
function defineTradeFotoReceiptCoverage(input) {
  C.exact(input, ['scopeId', 'sourceInstance', 'fileSha256', 'schemaSha256', 'evidenceSha256', 'expectedSourceRows', 'verifiedSourceRows', 'head', 'lines']);
  C.id(input.scopeId); C.id(input.sourceInstance); C.sha(input.fileSha256); C.sha(input.schemaSha256); C.sha(input.evidenceSha256);
  if (input.schemaSha256 !== H.profileFor('cash', 'Umsatz_KASSE').schemaSha256) C.fail('IMPORT_SALES_COVERAGE_SCHEMA');
  C.integer(input.expectedSourceRows); C.integer(input.verifiedSourceRows);
  if (input.expectedSourceRows !== input.verifiedSourceRows || !Array.isArray(input.lines) || input.lines.length > 1000
    || input.lines.length > input.verifiedSourceRows) C.fail('IMPORT_SALES_COVERAGE_INCOMPLETE');
  const head = C.normalizeDataImportRow(H.profileFor('cash', 'Umsatz_KASSE'), input.head).source;
  const lines = input.lines.map(row => C.normalizeDataImportRow(H.profileFor('cash', 'Umsatz_Kasse_Details'), row).source);
  if (new Set(lines.map(row => row.RepID)).size !== lines.length || lines.some(row => ['Bonnr', 'Filialid', 'Kassenid', 'Bondatum'].some(field => row[field] !== head[field]))) C.fail('IMPORT_SALES_COVERAGE_LINES');
  const proof = { scopeId: input.scopeId, sourceInstance: input.sourceInstance, fileSha256: input.fileSha256,
    schemaSha256: input.schemaSha256, evidenceSha256: input.evidenceSha256, expectedSourceRows: input.expectedSourceRows,
    headHash: sourceFingerprint('Umsatz_KASSE', head), lineHashes: lines.map(row => sourceFingerprint('Umsatz_Kasse_Details', row)).sort() };
  const coverage = C.freeze({ ...proof, fingerprint: C.fingerprint(proof) }); coverages.add(coverage); return coverage;
}
function checkCoverage(coverage, { scopeId, sourceInstance, head, lines }) {
  if (!coverage) return 'RECEIPT_SOURCE_COVERAGE_UNCONFIRMED';
  if (!coverages.has(coverage)) C.fail('IMPORT_SALES_COVERAGE_UNTRUSTED');
  if (coverage.scopeId !== scopeId || coverage.sourceInstance !== sourceInstance) C.fail('IMPORT_SALES_COVERAGE_SCOPE');
  const actual = lines.map(line => sourceFingerprint('Umsatz_Kasse_Details', line.source)).sort();
  if (coverage.headHash !== sourceFingerprint('Umsatz_KASSE', head) || !C.equal(coverage.lineHashes, actual)) return 'RECEIPT_SOURCE_COVERAGE_MISMATCH';
  return '';
}
function classifyLine(row, policy) {
  const quantity = decimal(row.VKMenge), sign = quantity > 0n ? 'positive' : quantity < 0n ? 'negative' : 'zero';
  const rules = policy.statusRules.filter(rule => (rule.quantitySign === 'any' || rule.quantitySign === sign)
    && matchesFilters(row, rule) && !rule.except?.some(filter => matchesFilters(row, filter))
    && STATUS_FIELDS.every(field => row[field] === rule.flags[field]));
  if (rules.length !== 1) return { issue: rules.length ? 'STATUS_RULE_AMBIGUOUS' : 'STATUS_REVIEW_REQUIRED' };
  const rule = rules[0];
  if ((rule.status === 'sale' && sign !== 'positive') || (rule.status === 'return' && sign !== 'negative')) return { issue: 'QUANTITY_STATUS_CONFLICT' };
  if (rule.status === 'excluded') return { issue: '', status: 'excluded', ruleId: rule.id, gross: 0n, net: 0n };
  if (['payment', 'voucher_issue', 'uid_clearing'].includes(rule.status)) {
    if (decimal(row.VK_Preis) < 0n) return { issue: 'NEGATIVE_UNIT_PRICE_REVIEW' };
    return { issue: '', status: rule.status, ruleId: rule.id, gross: 0n, net: 0n };
  }
  const price = decimal(row.VK_Preis), code = row.MWST;
  if (!Object.hasOwn(policy.vatRates, code)) return { issue: 'VAT_CODE_UNKNOWN' };
  if (policy.zeroPriceVatCodes?.includes(code) && price !== 0n
    && !policy.zeroPriceVatExceptions?.some(filter => matchesFilters(row, filter))) return { issue: 'VAT_CODE_UNKNOWN' };
  if (price < 0n && policy.priceMeaning === 'final_unit') return { issue: 'NEGATIVE_UNIT_PRICE_REVIEW' };
  const unitDivisor = 10n ** BigInt(SCALE - policy.minorUnits);
  // VK_Preis must be confirmed as the final price. Discounts are retained as
  // evidence, NEVER silently subtracted a second time from a final price.
  const amount = policy.priceMeaning === 'final_unit' ? divide(price * quantity, UNIT * unitDivisor) : divide(price, unitDivisor);
  if ((rule.status === 'sale' && amount < 0n) || (rule.status === 'return' && amount > 0n)) return { issue: 'AMOUNT_STATUS_CONFLICT' };
  const rate = decimal(policy.vatRates[code]), taxBase = 100n * UNIT;
  const gross = policy.priceBasis === 'gross' ? amount : divide(amount * (taxBase + rate), taxBase);
  const net = policy.priceBasis === 'net' ? amount : divide(amount * taxBase, taxBase + rate);
  return { issue: '', status: rule.status, ruleId: rule.id, gross, net };
}
function reconcileTradeFotoReceipt({ head, lines, headRevision, snapshotDate, policy = null, coverage = null, scopeId, sourceInstance }) {
  const gate = checkPolicy(policy, { scopeId, sourceInstance });
  if (!Array.isArray(lines) || lines.length > 1000) C.fail('IMPORT_SALES_LINES_LIMIT');
  const issues = new Set(gate ? [gate] : []), counts = { lines: lines.length, sales: 0, returns: 0, excluded: 0, review: 0 };
  const coverageIssue = checkCoverage(coverage, { scopeId, sourceInstance, head, lines }); if (coverageIssue) issues.add(coverageIssue);
  C.integer(headRevision, 1, Number.MAX_SAFE_INTEGER);
  if (!lines.length) issues.add('RECEIPT_WITHOUT_LINES');
  if (lines.some(line => line.parentRevision !== headRevision)) issues.add('STALE_RECEIPT_PARENT_REVISION');
  if (typeof head.Bondatum !== 'string' || head.Bondatum.slice(0, 10) > snapshotDate) issues.add('BUSINESS_DATE_REVIEW_REQUIRED');
  if (typeof head.Bonzeit === 'string' && !head.Bonzeit.startsWith('1899-12-30T') && head.Bonzeit.slice(0, 10) !== head.Bondatum?.slice(0, 10)) issues.add('BUSINESS_TIME_REVIEW_REQUIRED');
  if (gate) return { canAggregate: false, issues: [...issues].sort(), counts, totals: null, policy: null };
  let gross = 0n, net = 0n;
  const positions = [];
  for (const line of lines) {
    if (['Bonnr', 'Filialid', 'Kassenid', 'Bondatum'].some(field => line.source[field] !== head[field])) { issues.add('RECEIPT_LINE_KEY_MISMATCH'); counts.review++; continue; }
    let result;
    try { result = classifyLine(line.source, policy); }
    catch (error) { if (!(error instanceof C.DataImportError)) throw error; result = { issue: error.code }; }
    if (result.issue) { issues.add(result.issue); counts.review++; continue; }
    const countKey = result.status === 'sale' ? 'sales' : result.status === 'return' ? 'returns' : result.status === 'adjustment' ? 'adjustments' : result.status === 'deposit' ? 'deposits' : result.status === 'payment' ? 'payments' : result.status === 'voucher_issue' ? 'voucherIssues' : result.status === 'uid_clearing' ? 'uidClearings' : 'excluded';
    counts[countKey] = (counts[countKey] || 0) + 1;
    gross += result.gross; net += result.net;
    positions.push({ key: line.source.RepID, status: result.status, gross: format(result.gross, policy.minorUnits),
      net: format(result.net, policy.minorUnits), tax: format(result.gross - result.net, policy.minorUnits) });
  }
  let header = null, difference = null, headerStatus = 'checked', headerBasis = policy.headerBasis;
  if (!coverageIssue && policy.headerBasisOverrides?.length) {
    const fingerprint = C.fingerprint([coverage.headHash, coverage.lineHashes]);
    headerBasis = policy.headerBasisOverrides.find(item => item.receiptFingerprint === fingerprint)?.basis || headerBasis;
  }
  try { header = minor(head.RechnungsBetrag, policy.minorUnits);
    // Verified legacy cash heads may contain a placeholder zero even for paid
    // receipts. This opt-in belongs to a trusted evidence-backed source policy;
    // absence of the option preserves the strict amount check. The source value
    // and all zero-price lines remain untouched and source coverage is mandatory.
    if (decimal(head.RechnungsBetrag) === 0n && policy.headerZeroMeaning === 'unavailable') headerStatus = 'unavailable_zero_placeholder';
    else { difference = (headerBasis === 'gross' ? gross : net) - header;
      if (abs(difference) > BigInt(policy.headerToleranceMinor)) issues.add('RECEIPT_AMOUNT_MISMATCH'); } }
  catch (error) { if (!(error instanceof C.DataImportError)) throw error; issues.add('RECEIPT_AMOUNT_INVALID'); }
  return { canAggregate: !issues.size, issues: [...issues].sort(), counts, policy: { id: policy.id, version: policy.version, fingerprint: policy.fingerprint },
    coverage: coverage ? { fingerprint: coverage.fingerprint, fileSha256: coverage.fileSha256, verified: !coverageIssue } : null,
    totals: !issues.size ? { currency: policy.currency, gross: format(gross, policy.minorUnits), net: format(net, policy.minorUnits), tax: format(gross - net, policy.minorUnits) } : null,
    positions: !issues.size ? positions : null,
    // A mismatching/partial result has no usable revenue total.
    reconciliation: { headerBasis, headerStatus, difference: difference === null ? null : format(difference, policy.minorUnits), toleranceMinor: policy.headerToleranceMinor } };
}
module.exports = { STATUS_FIELDS, defineTradeFotoSalesPolicy, defineTradeFotoReceiptCoverage, reconcileTradeFotoReceipt };
