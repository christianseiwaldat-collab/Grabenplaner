"use strict";

const crypto = require("node:crypto");

const SALES_ANALYTICS_REPORT_SERIES_MAX_REPORTS = 24;
const SERIES_ADDITIVE_METRICS = Object.freeze([
  "quantity",
  "netRevenue",
  "customerCount",
]);
const SERIES_OPTIONAL_ADDITIVE_METRICS = Object.freeze(["grossMargin"]);

class SalesAnalyticsReportSeriesError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "SalesAnalyticsReportSeriesError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function seriesError(code, details = {}) {
  return new SalesAnalyticsReportSeriesError(code, details);
}

function deepFreeze(value, visited = new Set()) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  if (visited.has(value)) return value;
  visited.add(value);
  for (const child of Object.values(value)) deepFreeze(child, visited);
  return Object.freeze(value);
}

function isoDayNumber(value) {
  const input = String(value || "");
  const match = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw seriesError("SALES_ANALYTICS_REPORT_SERIES_DATE_INVALID");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.getUTCFullYear() !== Number(match[1])
    || date.getUTCMonth() !== Number(match[2]) - 1
    || date.getUTCDate() !== Number(match[3])) {
    throw seriesError("SALES_ANALYTICS_REPORT_SERIES_DATE_INVALID");
  }
  return Math.trunc(date.getTime() / 86_400_000);
}

function isoFromDayNumber(value) {
  return new Date(value * 86_400_000).toISOString().slice(0, 10);
}

function normalizedPeriod(value, reason) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw seriesError("SALES_ANALYTICS_REPORT_SERIES_REPORT_INVALID", { reason });
  }
  const start = String(value.start || "");
  const end = String(value.end || "");
  const startDay = isoDayNumber(start);
  const endDay = isoDayNumber(end);
  if (startDay > endDay) {
    throw seriesError("SALES_ANALYTICS_REPORT_SERIES_REPORT_INVALID", { reason });
  }
  return Object.freeze({ start, end, startDay, endDay, days: endDay - startDay + 1 });
}

function reportPeriod(report, kind = "period") {
  const nested = report?.periods?.[kind];
  if (nested) return normalizedPeriod(nested, kind);
  const prefix = kind === "comparison" ? "comparison" : "period";
  return normalizedPeriod({
    start: report?.[`${prefix}Start`],
    end: report?.[`${prefix}End`],
  }, kind);
}

function salesAnalyticsReportPeriodsOverlap(left, right) {
  const leftPeriod = normalizedPeriod(left, "left");
  const rightPeriod = normalizedPeriod(right, "right");
  return leftPeriod.startDay <= rightPeriod.endDay
    && rightPeriod.startDay <= leftPeriod.endDay;
}

function normalizeSalesAnalyticsReportSeriesIds(value) {
  if (!Array.isArray(value)
    || value.length < 1
    || value.length > SALES_ANALYTICS_REPORT_SERIES_MAX_REPORTS) {
    throw seriesError("SALES_ANALYTICS_REPORT_SERIES_SELECTION_INVALID", {
      maximumReports: SALES_ANALYTICS_REPORT_SERIES_MAX_REPORTS,
    });
  }
  const ids = value.map((entry) => String(entry || "").trim());
  if (ids.some((id) => !/^[a-f0-9]{64}$/.test(id)) || new Set(ids).size !== ids.length) {
    throw seriesError("SALES_ANALYTICS_REPORT_SERIES_SELECTION_INVALID", {
      maximumReports: SALES_ANALYTICS_REPORT_SERIES_MAX_REPORTS,
    });
  }
  return Object.freeze(ids);
}

function decimal4Units(value, reason) {
  const input = String(value ?? "");
  if (!/^-?(?:0|[1-9]\d{0,19})\.\d{4}$/.test(input)) {
    throw seriesError("SALES_ANALYTICS_REPORT_SERIES_VALUE_INVALID", { reason });
  }
  const negative = input.startsWith("-");
  const [integer, fraction] = (negative ? input.slice(1) : input).split(".");
  const units = BigInt(`${integer}${fraction}`);
  return negative ? -units : units;
}

function decimal4FromUnits(value) {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(5, "0");
  const result = `${digits.slice(0, -4)}.${digits.slice(-4)}`;
  return negative && value !== 0n ? `-${result}` : result;
}

function roundedDivide(numerator, denominator) {
  if (denominator <= 0n) return null;
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const result = (absolute + denominator / 2n) / denominator;
  return negative ? -result : result;
}

function emptyAccumulator(metricIds) {
  const accumulator = {};
  for (const metricId of metricIds) {
    accumulator[metricId] = { current: 0n, comparison: 0n };
  }
  return accumulator;
}

function addMetric(accumulator, metric, metricIds, reason) {
  for (const metricId of metricIds) {
    for (const side of ["current", "comparison"]) {
      accumulator[metricId][side] += decimal4Units(
        metric?.[metricId]?.[side],
        `${reason}.${metricId}.${side}`,
      );
    }
  }
}

function metricFromAccumulator(accumulator, metricIds) {
  const metric = {};
  for (const metricId of metricIds) {
    metric[metricId] = {
      current: decimal4FromUnits(accumulator[metricId].current),
      comparison: decimal4FromUnits(accumulator[metricId].comparison),
    };
  }
  metric.revenuePerCustomer = {};
  for (const side of ["current", "comparison"]) {
    const customerCount = accumulator.customerCount[side];
    const revenue = accumulator.netRevenue[side];
    const ratio = roundedDivide(revenue * 10_000n, customerCount);
    metric.revenuePerCustomer[side] = ratio === null ? null : decimal4FromUnits(ratio);
  }
  return metric;
}

function dailyMetric(metric, metricIds, currentDays, comparisonDays) {
  const result = {};
  for (const metricId of metricIds) {
    result[metricId] = {};
    for (const [side, days] of [["current", currentDays], ["comparison", comparisonDays]]) {
      const units = decimal4Units(metric[metricId][side], `daily.${metricId}.${side}`);
      const average = roundedDivide(units, BigInt(days));
      result[metricId][side] = decimal4FromUnits(average ?? 0n);
    }
  }
  return result;
}

function normalizedBundle(bundle, index) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)
    || !bundle.report || !Array.isArray(bundle.productGroups)
    || !bundle.totals?.period) {
    throw seriesError("SALES_ANALYTICS_REPORT_SERIES_REPORT_INVALID", { index });
  }
  const report = bundle.report;
  const id = String(report.id || "");
  if (!/^[a-f0-9]{64}$/.test(id)) {
    throw seriesError("SALES_ANALYTICS_REPORT_SERIES_REPORT_INVALID", { index });
  }
  const locationId = String(report.locationId || "").trim();
  const sourceSystem = String(report.sourceSystem || "").trim();
  const reportKind = String(report.reportKind || "").trim();
  const currency = String(report.currency || "").trim();
  if (!locationId || !sourceSystem || !reportKind || !/^[A-Z]{3}$/.test(currency)) {
    throw seriesError("SALES_ANALYTICS_REPORT_SERIES_REPORT_INVALID", { index });
  }
  if (bundle.productGroups.length > 2_000) {
    throw seriesError("SALES_ANALYTICS_REPORT_SERIES_REPORT_INVALID", { index });
  }
  return Object.freeze({
    bundle,
    report,
    id,
    locationId,
    sourceSystem,
    reportKind,
    currency,
    period: reportPeriod(report, "period"),
    comparison: reportPeriod(report, "comparison"),
  });
}

function overlapDetails(entries, periodKey) {
  const sorted = [...entries].sort((left, right) => (
    left[periodKey].startDay - right[periodKey].startDay
    || left[periodKey].endDay - right[periodKey].endDay
    || left.id.localeCompare(right.id)
  ));
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (current[periodKey].startDay <= previous[periodKey].endDay) {
      return Object.freeze({
        leftReportId: previous.id,
        rightReportId: current.id,
        left: Object.freeze({ start: previous[periodKey].start, end: previous[periodKey].end }),
        right: Object.freeze({ start: current[periodKey].start, end: current[periodKey].end }),
      });
    }
  }
  return null;
}

function coverage(entries, periodKey) {
  const sorted = [...entries].sort((left, right) => (
    left[periodKey].startDay - right[periodKey].startDay
    || left[periodKey].endDay - right[periodKey].endDay
    || left.id.localeCompare(right.id)
  ));
  const first = sorted[0][periodKey];
  const last = sorted[sorted.length - 1][periodKey];
  const coverageDays = sorted.reduce((sum, entry) => sum + entry[periodKey].days, 0);
  const spanDays = last.endDay - first.startDay + 1;
  const gaps = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1][periodKey];
    const current = sorted[index][periodKey];
    if (current.startDay > previous.endDay + 1) {
      gaps.push(Object.freeze({
        start: isoFromDayNumber(previous.endDay + 1),
        end: isoFromDayNumber(current.startDay - 1),
        days: current.startDay - previous.endDay - 1,
      }));
    }
  }
  return Object.freeze({
    period: Object.freeze({ start: first.start, end: last.end }),
    coverageDays,
    spanDays,
    gapDays: spanDays - coverageDays,
    gaps: Object.freeze(gaps),
    status: gaps.length ? "gapped" : "contiguous",
  });
}

function classifySalesAnalyticsReportArchive(reports) {
  if (!Array.isArray(reports) || reports.length > 500) {
    throw seriesError("SALES_ANALYTICS_REPORT_ARCHIVE_INVALID");
  }
  const entries = reports.map((report, index) => {
    const id = String(report?.id || "");
    if (!/^[a-f0-9]{64}$/.test(id)) {
      throw seriesError("SALES_ANALYTICS_REPORT_ARCHIVE_INVALID", { index });
    }
    return Object.freeze({
      id,
      report,
      period: reportPeriod(report, "period"),
      key: [
        String(report.locationId || ""),
        String(report.sourceSystem || ""),
        String(report.reportKind || ""),
        String(report.currency || ""),
      ].join("\u0000"),
    });
  });
  const result = {};
  for (const entry of entries) {
    const overlapReportIds = entries
      .filter((candidate) => candidate.id !== entry.id
        && candidate.key === entry.key
        && entry.period.startDay <= candidate.period.endDay
        && candidate.period.startDay <= entry.period.endDay)
      .map((candidate) => candidate.id)
      .sort();
    result[entry.id] = Object.freeze({
      durationDays: entry.period.days,
      overlapCount: overlapReportIds.length,
      overlapReportIds: Object.freeze(overlapReportIds.slice(0, 12)),
      overlapIdsTruncated: overlapReportIds.length > 12,
      coverageStatus: overlapReportIds.length ? "overlap" : "standalone",
    });
  }
  return deepFreeze(result);
}

function aggregateSalesAnalyticsReportSeries(input) {
  if (!Array.isArray(input)
    || input.length < 1
    || input.length > SALES_ANALYTICS_REPORT_SERIES_MAX_REPORTS) {
    throw seriesError("SALES_ANALYTICS_REPORT_SERIES_SELECTION_INVALID", {
      maximumReports: SALES_ANALYTICS_REPORT_SERIES_MAX_REPORTS,
    });
  }
  const entries = input.map(normalizedBundle);
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw seriesError("SALES_ANALYTICS_REPORT_SERIES_SELECTION_INVALID");
  }
  const baseline = entries[0];
  if (entries.some((entry) => entry.locationId !== baseline.locationId)) {
    throw seriesError("SALES_ANALYTICS_REPORT_SERIES_MIXED_LOCATION");
  }
  if (entries.some((entry) => entry.sourceSystem !== baseline.sourceSystem
    || entry.reportKind !== baseline.reportKind
    || entry.currency !== baseline.currency)) {
    throw seriesError("SALES_ANALYTICS_REPORT_SERIES_MIXED_SOURCE");
  }
  const currentOverlap = overlapDetails(entries, "period");
  if (currentOverlap) {
    throw seriesError("SALES_ANALYTICS_REPORT_SERIES_OVERLAP", currentOverlap);
  }
  const comparisonOverlap = overlapDetails(entries, "comparison");
  if (comparisonOverlap) {
    throw seriesError("SALES_ANALYTICS_REPORT_SERIES_COMPARISON_OVERLAP", comparisonOverlap);
  }

  const sorted = [...entries].sort((left, right) => (
    left.period.startDay - right.period.startDay
    || left.period.endDay - right.period.endDay
    || left.id.localeCompare(right.id)
  ));
  const currentCoverage = coverage(sorted, "period");
  const comparisonCoverage = coverage(sorted, "comparison");
  const includeGrossMargin = entries.every((entry) => (
    entry.bundle.rights?.grossMargin === true
    && entry.bundle.totals.period.grossMargin
  ));
  const metricIds = [
    ...SERIES_ADDITIVE_METRICS,
    ...(includeGrossMargin ? SERIES_OPTIONAL_ADDITIVE_METRICS : []),
  ];
  const totalAccumulator = emptyAccumulator(metricIds);
  const groups = new Map();
  const points = [];

  for (const entry of sorted) {
    addMetric(totalAccumulator, entry.bundle.totals.period, metricIds, `report.${entry.id}.total`);
    const pointAccumulator = emptyAccumulator(metricIds);
    addMetric(pointAccumulator, entry.bundle.totals.period, metricIds, `report.${entry.id}.point`);
    const pointMetric = metricFromAccumulator(pointAccumulator, metricIds);
    points.push(Object.freeze({
      reportId: entry.id,
      period: Object.freeze({ start: entry.period.start, end: entry.period.end }),
      comparison: Object.freeze({ start: entry.comparison.start, end: entry.comparison.end }),
      durationDays: entry.period.days,
      comparisonDurationDays: entry.comparison.days,
      totals: deepFreeze(pointMetric),
      dailyAverages: deepFreeze(dailyMetric(
        pointMetric,
        metricIds,
        entry.period.days,
        entry.comparison.days,
      )),
    }));

    const seenGroupIds = new Set();
    for (const group of entry.bundle.productGroups) {
      const id = String(group?.externalProductGroupId || "").trim();
      const label = String(group?.label || "").trim();
      if (!id || id.length > 80 || !label || label.length > 240 || seenGroupIds.has(id)
        || !group?.horizons?.period) {
        throw seriesError("SALES_ANALYTICS_REPORT_SERIES_REPORT_INVALID", {
          reportId: entry.id,
        });
      }
      seenGroupIds.add(id);
      if (!groups.has(id)) {
        groups.set(id, {
          externalProductGroupId: id,
          label,
          labels: new Set(),
          reportCount: 0,
          accumulator: emptyAccumulator(metricIds),
        });
      }
      const target = groups.get(id);
      target.label = label;
      target.labels.add(label);
      target.reportCount += 1;
      addMetric(
        target.accumulator,
        group.horizons.period,
        metricIds,
        `report.${entry.id}.group.${id}`,
      );
    }
  }

  const totalMetric = metricFromAccumulator(totalAccumulator, metricIds);
  const productGroups = [...groups.values()]
    .sort((left, right) => left.externalProductGroupId.localeCompare(
      right.externalProductGroupId,
      "de",
      { numeric: true },
    ))
    .map((group) => Object.freeze({
      externalProductGroupId: group.externalProductGroupId,
      label: group.label,
      labelVariants: Object.freeze([...group.labels].sort((left, right) => left.localeCompare(right, "de"))),
      reportCount: group.reportCount,
      horizons: Object.freeze({
        period: deepFreeze(metricFromAccumulator(group.accumulator, metricIds)),
      }),
    }));
  const ids = sorted.map((entry) => entry.id);
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(ids)).digest("hex");
  const selection = {
    fingerprint,
    reportIds: Object.freeze(ids),
    reportCount: sorted.length,
    locationId: baseline.locationId,
    sourceSystem: baseline.sourceSystem,
    reportKind: baseline.reportKind,
    currency: baseline.currency,
    period: currentCoverage.period,
    comparison: comparisonCoverage.period,
    coverageDays: currentCoverage.coverageDays,
    spanDays: currentCoverage.spanDays,
    gapDays: currentCoverage.gapDays,
    gaps: currentCoverage.gaps,
    coverageStatus: currentCoverage.status,
    comparisonCoverageDays: comparisonCoverage.coverageDays,
    comparisonSpanDays: comparisonCoverage.spanDays,
    comparisonGapDays: comparisonCoverage.gapDays,
    comparisonGaps: comparisonCoverage.gaps,
    comparisonCoverageStatus: comparisonCoverage.status,
    comparisonAligned: sorted.every((entry) => entry.period.days === entry.comparison.days),
  };
  return deepFreeze({
    report: {
      id: fingerprint,
      sourceSystem: baseline.sourceSystem,
      reportKind: "pdf_report_series",
      locationId: baseline.locationId,
      currency: baseline.currency,
      periods: {
        period: currentCoverage.period,
        comparison: comparisonCoverage.period,
      },
      productGroupCount: productGroups.length,
      reportCount: sorted.length,
    },
    selection,
    productGroups: Object.freeze(productGroups),
    totals: Object.freeze({ period: deepFreeze(totalMetric) }),
    dailyAverages: Object.freeze({
      period: deepFreeze(dailyMetric(
        totalMetric,
        metricIds,
        currentCoverage.coverageDays,
        comparisonCoverage.coverageDays,
      )),
    }),
    points: Object.freeze(points),
    rights: Object.freeze({ grossMargin: includeGrossMargin }),
  });
}

module.exports = {
  SALES_ANALYTICS_REPORT_SERIES_MAX_REPORTS,
  SalesAnalyticsReportSeriesError,
  aggregateSalesAnalyticsReportSeries,
  classifySalesAnalyticsReportArchive,
  normalizeSalesAnalyticsReportSeriesIds,
  salesAnalyticsReportPeriodsOverlap,
};
