"use strict";

const crypto = require("node:crypto");
const {
  SALES_ANALYTICS_MODEL_VERSION,
} = require("../../sales-analytics-model");
const {
  assertSalesImportPreview,
  normalizeSalesImportProfile,
  salesImportProfileFingerprint,
} = require("../../sales-analytics-import");
const {
  TRADEFOTO_REPORT_EXTRACTIONS,
  TRADEFOTO_REPORT_SOURCE_SYSTEM,
  assertTradeFotoReportPreview,
} = require("../../sales-analytics-tradefoto-report");
const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceAccess,
} = require("../contract");
const {
  SALES_ANALYTICS_PERSISTENCE_STATEMENTS: S,
} = require("../statements/sales-analytics");

const REPOSITORIES = new WeakSet();

function invalidInput(operation) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, { operation });
}

function retryable(operation) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.RETRYABLE_TRANSACTION, { operation });
}

function contractViolation(operation) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.CONTRACT_VIOLATION, { operation });
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys, operation) {
  if (!isPlainRecord(value)) throw invalidInput(operation);
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw invalidInput(operation);
}

function normalizedText(value, operation, maximumLength, pattern = null) {
  const result = String(value ?? "").trim();
  if (!result || result.length > maximumLength || /[\u0000-\u001f\u007f]/.test(result)
    || (pattern && !pattern.test(result))) {
    throw invalidInput(operation);
  }
  return result;
}

function normalizedActor(value, operation) {
  return normalizedText(value, operation, 120);
}

function normalizedIdentifier(value, operation, maximumLength = 80) {
  return normalizedText(value, operation, maximumLength, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
}

function normalizedSha256(value, operation) {
  return normalizedText(value, operation, 64, /^[a-f0-9]{64}$/);
}

function normalizedUtcTimestamp(value, operation) {
  const timestamp = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)) {
    throw invalidInput(operation);
  }
  try {
    if (new Date(timestamp).toISOString() !== timestamp) throw new Error("invalid");
  } catch {
    throw invalidInput(operation);
  }
  return timestamp;
}

function normalizedDate(value, operation) {
  const date = String(value || "");
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw invalidInput(operation);
  const candidate = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (candidate.getUTCFullYear() !== Number(match[1])
    || candidate.getUTCMonth() !== Number(match[2]) - 1
    || candidate.getUTCDate() !== Number(match[3])) {
    throw invalidInput(operation);
  }
  return date;
}

function positiveInteger(value, operation) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalidInput(operation);
  return value;
}

function nonNegativeInteger(value, operation) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidInput(operation);
  return value;
}

function normalizedDecimal4(value, operation, nullable = false) {
  if (value === null && nullable) return null;
  const result = String(value || "");
  if (!/^-?(?:0|[1-9]\d{0,19})\.\d{4}$/.test(result)) throw invalidInput(operation);
  return result;
}

function executionSucceeded(result, operation) {
  if (result.rowsAffected !== 1) throw retryable(operation);
  return result;
}

function primitiveOperations(access) {
  return Object.freeze({
    queryOne(statement, parameters) {
      return access.queryOne(statement, parameters);
    },
    queryAll(statement, parameters) {
      return access.queryAll(statement, parameters);
    },
    execute(statement, parameters) {
      return access.execute(statement, parameters);
    },
  });
}

function frozenResult(value) {
  return Object.freeze(value);
}

const createSalesAnalyticsPersistenceRepository = Object.freeze(
  function createSalesAnalyticsPersistenceRepository(access) {
    assertPersistenceAccess(access);
    const direct = primitiveOperations(access);

    function atomic(work) {
      if (typeof access.transaction !== "function") return work(direct);
      return access.transaction((executor) => work(primitiveOperations(executor)));
    }

    async function profileResult(operations, profileId, revision) {
      const profile = await operations.queryOne(S.getProfile, { id: profileId });
      const profileRevision = await operations.queryOne(
        S.getProfileRevision,
        { profileId, revision },
      );
      if (!profile || !profileRevision) throw contractViolation("sales-profile-result");
      return frozenResult({ profile, revision: profileRevision });
    }

    async function writeProfileRevision(operations, {
      profile,
      revision,
      actor,
      timestamp,
    }) {
      const profileSha256 = salesImportProfileFingerprint(profile);
      await operations.execute(S.insertProfileRevision, {
        profileId: profile.id,
        revision,
        contractVersion: profile.contractVersion,
        modelVersion: SALES_ANALYTICS_MODEL_VERSION,
        sourceSchemaSha256: profile.sourceSchemaSha256,
        profileSha256,
        profile,
        actor,
        timestamp,
      });
      return profileSha256;
    }

    const repository = {
      async listProfiles({ activeOnly = true } = {}) {
        if (typeof activeOnly !== "boolean") throw invalidInput("listProfiles");
        return direct.queryAll(S.listProfiles, { activeOnly });
      },

      async getProfile(id) {
        return direct.queryOne(S.getProfile, {
          id: normalizedIdentifier(id, "getProfile"),
        });
      },

      async getProfileRevision(profileId, revision) {
        return direct.queryOne(S.getProfileRevision, {
          profileId: normalizedIdentifier(profileId, "getProfileRevision"),
          revision: positiveInteger(revision, "getProfileRevision"),
        });
      },

      async listProfileRevisions(profileId) {
        return direct.queryAll(S.listProfileRevisions, {
          profileId: normalizedIdentifier(profileId, "listProfileRevisions"),
        });
      },

      async createProfile(value) {
        const operation = "createProfile";
        exactKeys(value, ["profile", "actor", "timestamp"], operation);
        let profile;
        try {
          profile = normalizeSalesImportProfile(value.profile);
        } catch {
          throw invalidInput(operation);
        }
        const actor = normalizedActor(value.actor, operation);
        const timestamp = normalizedUtcTimestamp(value.timestamp, operation);
        return atomic(async (operations) => {
          await operations.execute(S.insertProfile, {
            id: profile.id,
            name: profile.name,
            entityId: profile.entityId,
            active: true,
            actor,
            timestamp,
          });
          await writeProfileRevision(operations, {
            profile,
            revision: 1,
            actor,
            timestamp,
          });
          executionSucceeded(await operations.execute(S.activateProfileRevision, {
            id: profile.id,
            name: profile.name,
            revision: 1,
            expectedRevision: null,
            actor,
            timestamp,
          }), operation);
          return profileResult(operations, profile.id, 1);
        });
      },

      async appendProfileRevision(value) {
        const operation = "appendProfileRevision";
        exactKeys(value, ["profile", "expectedRevision", "actor", "timestamp"], operation);
        let profile;
        try {
          profile = normalizeSalesImportProfile(value.profile);
        } catch {
          throw invalidInput(operation);
        }
        const expectedRevision = positiveInteger(value.expectedRevision, operation);
        const actor = normalizedActor(value.actor, operation);
        const timestamp = normalizedUtcTimestamp(value.timestamp, operation);
        return atomic(async (operations) => {
          const header = await operations.queryOne(S.getProfile, { id: profile.id });
          if (!header || header.entityId !== profile.entityId) throw invalidInput(operation);
          if (header.activeRevision !== expectedRevision) throw retryable(operation);
          const revision = expectedRevision + 1;
          await writeProfileRevision(operations, {
            profile,
            revision,
            actor,
            timestamp,
          });
          executionSucceeded(await operations.execute(S.activateProfileRevision, {
            id: profile.id,
            name: profile.name,
            revision,
            expectedRevision,
            actor,
            timestamp,
          }), operation);
          return profileResult(operations, profile.id, revision);
        });
      },

      async getRun(id) {
        return direct.queryOne(S.getRun, {
          id: normalizedSha256(id, "getRun"),
        });
      },

      async getRunByIdempotencyKey(idempotencyKey) {
        return direct.queryOne(S.getRunByIdempotencyKey, {
          idempotencyKey: normalizedSha256(idempotencyKey, "getRunByIdempotencyKey"),
        });
      },

      async listRuns({ profileId = null, limit = 100 } = {}) {
        if (profileId !== null) profileId = normalizedIdentifier(profileId, "listRuns");
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
          throw invalidInput("listRuns");
        }
        return direct.queryAll(S.listRuns, { profileId, limit });
      },

      async recordPreview(value) {
        const operation = "recordPreview";
        exactKeys(value, [
          "preview",
          "profileRevision",
          "actor",
          "startedAt",
          "completedAt",
          "expiresAt",
        ], operation);
        let preview;
        try {
          preview = assertSalesImportPreview(value.preview);
        } catch {
          throw invalidInput(operation);
        }
        const profileRevision = positiveInteger(value.profileRevision, operation);
        const actor = normalizedActor(value.actor, operation);
        const startedAt = normalizedUtcTimestamp(value.startedAt, operation);
        const completedAt = normalizedUtcTimestamp(value.completedAt, operation);
        const expiresAt = normalizedUtcTimestamp(value.expiresAt, operation);
        if (!(startedAt <= completedAt && completedAt < expiresAt)) throw invalidInput(operation);

        return atomic(async (operations) => {
          const revision = await operations.queryOne(S.getProfileRevision, {
            profileId: preview.profile.id,
            revision: profileRevision,
          });
          if (!revision
            || revision.profileSha256 !== preview.profile.fingerprintSha256
            || revision.profile?.entityId !== preview.profile.entityId
            || revision.sourceSchemaSha256 !== preview.source.sourceSchemaSha256) {
            throw contractViolation(operation);
          }

          const existing = await operations.queryOne(S.getRunByIdempotencyKey, {
            idempotencyKey: preview.idempotencyKey,
          });
          if (existing) {
            if (existing.profileId !== preview.profile.id
              || existing.profileRevision !== profileRevision
              || existing.profileSha256 !== preview.profile.fingerprintSha256
              || existing.contentSha256 !== preview.source.contentSha256) {
              throw contractViolation(operation);
            }
            return frozenResult({ created: false, run: existing });
          }

          const needsReview = preview.summary.needsReview > 0
            || preview.summary.rejected > 0
            || preview.summary.duplicate > 0
            || preview.unresolvedDecisionIds.length > 0;
          await operations.execute(S.insertRun, {
            id: preview.idempotencyKey,
            idempotencyKey: preview.idempotencyKey,
            profileId: preview.profile.id,
            profileRevision,
            entityId: preview.profile.entityId,
            profileSha256: preview.profile.fingerprintSha256,
            contentSha256: preview.source.contentSha256,
            sourceSchemaSha256: preview.source.sourceSchemaSha256,
            snapshotAt: preview.source.snapshotAt,
            status: needsReview ? "needs_review" : "previewed",
            totalCount: preview.summary.total,
            acceptedCount: preview.summary.accepted,
            needsReviewCount: preview.summary.needsReview,
            rejectedCount: preview.summary.rejected,
            duplicateCount: preview.summary.duplicate,
            unresolvedDecisionIds: preview.unresolvedDecisionIds,
            actor,
            startedAt,
            completedAt,
            expiresAt,
          });
          for (const record of preview.records) {
            const retainCanonicalData = ["accepted", "needs_review"].includes(record.status);
            await operations.execute(S.insertStagingRecord, {
              runId: preview.idempotencyKey,
              rowNumber: record.rowNumber,
              entityId: preview.profile.entityId,
              recordFingerprint: retainCanonicalData ? record.fingerprint : null,
              status: record.status,
              canonicalData: retainCanonicalData ? record.data : {},
              issues: record.issues,
              createdAt: completedAt,
              expiresAt,
            });
          }
          const run = await operations.queryOne(S.getRun, { id: preview.idempotencyKey });
          if (!run) throw contractViolation(operation);
          return frozenResult({ created: true, run });
        });
      },

      async listStagingRecords(runId) {
        return direct.queryAll(S.listStagingRecords, {
          runId: normalizedSha256(runId, "listStagingRecords"),
        });
      },

      async purgeExpiredStaging(before) {
        return direct.execute(S.purgeExpiredStaging, {
          before: normalizedUtcTimestamp(before, "purgeExpiredStaging"),
        });
      },

      async getBranchMappingRevision(sourceSystem, externalBranchId, revision) {
        return direct.queryOne(S.getBranchMappingRevision, {
          sourceSystem: normalizedIdentifier(sourceSystem, "getBranchMappingRevision"),
          externalBranchId: normalizedText(externalBranchId, "getBranchMappingRevision", 80),
          revision: positiveInteger(revision, "getBranchMappingRevision"),
        });
      },

      async listBranchMappingRevisions(sourceSystem, externalBranchId) {
        return direct.queryAll(S.listBranchMappingRevisions, {
          sourceSystem: normalizedIdentifier(sourceSystem, "listBranchMappingRevisions"),
          externalBranchId: normalizedText(externalBranchId, "listBranchMappingRevisions", 80),
        });
      },

      async listActiveBranchMappings(sourceSystem) {
        return direct.queryAll(S.listActiveBranchMappings, {
          sourceSystem: normalizedIdentifier(sourceSystem, "listActiveBranchMappings"),
        });
      },

      async getBranchMappingHead(sourceSystem, externalBranchId) {
        return direct.queryOne(S.getBranchMappingHead, {
          sourceSystem: normalizedIdentifier(sourceSystem, "getBranchMappingHead"),
          externalBranchId: normalizedText(externalBranchId, "getBranchMappingHead", 80),
        });
      },

      async appendBranchMappingRevision(value) {
        const operation = "appendBranchMappingRevision";
        exactKeys(value, [
          "sourceSystem",
          "externalBranchId",
          "locationId",
          "status",
          "validFrom",
          "validTo",
          "evidenceId",
          "expectedRevision",
          "actor",
          "timestamp",
        ], operation);
        const sourceSystem = normalizedIdentifier(value.sourceSystem, operation);
        const externalBranchId = normalizedText(value.externalBranchId, operation, 80);
        if (!['approved', 'rejected'].includes(value.status)) throw invalidInput(operation);
        const status = value.status;
        const locationId = status === "approved"
          ? normalizedIdentifier(value.locationId, operation)
          : null;
        if (status === "rejected" && value.locationId !== null) throw invalidInput(operation);
        const validFrom = normalizedDate(value.validFrom, operation);
        const validTo = value.validTo === null ? null : normalizedDate(value.validTo, operation);
        if (validTo !== null && validTo < validFrom) throw invalidInput(operation);
        const evidenceId = normalizedIdentifier(value.evidenceId, operation, 120);
        const expectedRevision = value.expectedRevision === null
          ? null
          : positiveInteger(value.expectedRevision, operation);
        const actor = normalizedActor(value.actor, operation);
        const timestamp = normalizedUtcTimestamp(value.timestamp, operation);
        const mappingSha256 = crypto.createHash("sha256").update(JSON.stringify({
          sourceSystem,
          externalBranchId,
          locationId,
          status,
          validFrom,
          validTo,
          evidenceId,
        })).digest("hex");

        return atomic(async (operations) => {
          let head = await operations.queryOne(S.getBranchMappingHead, {
            sourceSystem,
            externalBranchId,
          });
          if (!head) {
            if (expectedRevision !== null) throw retryable(operation);
            await operations.execute(S.insertBranchMappingHead, {
              sourceSystem,
              externalBranchId,
              actor,
              timestamp,
            });
            head = { activeRevision: null };
          } else if (head.activeRevision !== expectedRevision) {
            throw retryable(operation);
          }
          const revision = (head.activeRevision || 0) + 1;
          await operations.execute(S.insertBranchMappingRevision, {
            sourceSystem,
            externalBranchId,
            revision,
            locationId,
            status,
            validFrom,
            validTo,
            evidenceId,
            mappingSha256,
            actor,
            timestamp,
          });
          executionSucceeded(await operations.execute(S.activateBranchMappingRevision, {
            sourceSystem,
            externalBranchId,
            revision,
            expectedRevision,
            actor,
            timestamp,
          }), operation);
          const saved = await operations.queryOne(S.getBranchMappingRevision, {
            sourceSystem,
            externalBranchId,
            revision,
          });
          if (!saved) throw contractViolation(operation);
          return saved;
        });
      },

      async listReports({ locationId = null, limit = 100 } = {}) {
        if (locationId !== null) locationId = normalizedIdentifier(locationId, "listReports");
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
          throw invalidInput("listReports");
        }
        return direct.queryAll(S.listReports, { locationId, limit });
      },

      async getReport(id) {
        return direct.queryOne(S.getReport, {
          id: normalizedSha256(id, "getReport"),
        });
      },

      async getReportBundle(id) {
        const reportId = normalizedSha256(id, "getReportBundle");
        const [report, productGroupMetrics, totals] = await Promise.all([
          direct.queryOne(S.getReport, { id: reportId }),
          direct.queryAll(S.listReportProductGroupMetrics, { reportId }),
          direct.queryAll(S.listReportTotalMetrics, { reportId }),
        ]);
        if (!report) return null;
        return frozenResult({
          report,
          productGroupMetrics: Object.freeze(productGroupMetrics),
          totals: Object.freeze(totals),
        });
      },

      async recordConfirmedTradeFotoReport(value) {
        const operation = "recordConfirmedTradeFotoReport";
        exactKeys(value, [
          "preview",
          "locationId",
          "currency",
          "confirmed",
          "actor",
          "timestamp",
        ], operation);
        let preview;
        try {
          preview = assertTradeFotoReportPreview(value.preview);
        } catch {
          throw invalidInput(operation);
        }
        if (value.confirmed !== true
          || !["match", "within_tolerance"].includes(preview.reconciliation?.status)
          || preview.issues.some((issue) => issue.severity === "error")
          || !preview.totals) {
          throw invalidInput(operation);
        }
        const extraction = preview.source.extraction;
        const ocrReviewed = extraction === TRADEFOTO_REPORT_EXTRACTIONS.OCR
          && preview.source.ocrReviewed === true
          && preview.confirmation?.ocrReviewed === true;
        if (![TRADEFOTO_REPORT_EXTRACTIONS.TEXT, TRADEFOTO_REPORT_EXTRACTIONS.OCR]
          .includes(extraction)
          || (extraction === TRADEFOTO_REPORT_EXTRACTIONS.OCR && !ocrReviewed)) {
          throw invalidInput(operation);
        }
        const reviewMethod = ocrReviewed ? "ocr_human_confirmed" : "source_text_confirmed";
        const locationId = normalizedIdentifier(value.locationId, operation);
        const currency = String(value.currency || "").trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency)) throw invalidInput(operation);
        const actor = normalizedActor(value.actor, operation);
        const timestamp = normalizedUtcTimestamp(value.timestamp, operation);
        const sourceFileSha256 = normalizedSha256(preview.source.contentSha256, operation);
        const externalBranchId = normalizedText(
          preview.report.externalBranchId,
          operation,
          80,
        );
        const reportKind = normalizedIdentifier(preview.report.kind, operation);
        const periodStart = normalizedDate(preview.report.periods.period.start, operation);
        const periodEnd = normalizedDate(preview.report.periods.period.end, operation);
        const comparisonStart = normalizedDate(preview.report.periods.comparison.start, operation);
        const comparisonEnd = normalizedDate(preview.report.periods.comparison.end, operation);
        const yearToDateStart = normalizedDate(
          preview.report.periods.yearToDate.start,
          operation,
        );
        const yearToDateComparisonStart = normalizedDate(
          preview.report.periods.yearToDateComparison.start,
          operation,
        );
        const reportId = crypto.createHash("sha256")
          .update(JSON.stringify({
            sourceSystem: TRADEFOTO_REPORT_SOURCE_SYSTEM,
            reportKind,
            externalBranchId,
            locationId,
            currency,
            periodStart,
            periodEnd,
            comparisonStart,
            comparisonEnd,
            yearToDateStart,
            yearToDateComparisonStart,
          }))
          .digest("hex");

        function metricParameters(reportIdValue, horizon, metric, extra = {}) {
          return {
            reportId: reportIdValue,
            horizon,
            currentQuantity: normalizedDecimal4(metric.current.quantity, operation),
            comparisonQuantity: normalizedDecimal4(metric.comparison.quantity, operation),
            currentNetRevenue: normalizedDecimal4(metric.current.netRevenue, operation),
            comparisonNetRevenue: normalizedDecimal4(metric.comparison.netRevenue, operation),
            currentGrossMargin: normalizedDecimal4(metric.current.grossMargin, operation),
            comparisonGrossMargin: normalizedDecimal4(metric.comparison.grossMargin, operation),
            currentCustomerCount: normalizedDecimal4(metric.current.customerCount, operation),
            comparisonCustomerCount: normalizedDecimal4(metric.comparison.customerCount, operation),
            currentRevenuePerCustomer: normalizedDecimal4(
              metric.current.revenuePerCustomer,
              operation,
              true,
            ),
            comparisonRevenuePerCustomer: normalizedDecimal4(
              metric.comparison.revenuePerCustomer,
              operation,
              true,
            ),
            ...extra,
          };
        }

        return atomic(async (operations) => {
          const existing = await operations.queryOne(S.getReportBySourceSha256, {
            sourceFileSha256,
          });
          if (existing) {
            if (existing.sourceSystem !== TRADEFOTO_REPORT_SOURCE_SYSTEM
              || existing.reportKind !== reportKind
              || existing.externalBranchId !== externalBranchId
              || existing.locationId !== locationId
              || existing.currency !== currency
              || existing.periodStart !== periodStart
              || existing.periodEnd !== periodEnd
              || existing.comparisonStart !== comparisonStart
              || existing.comparisonEnd !== comparisonEnd
              || existing.yearToDateStart !== yearToDateStart
              || existing.yearToDateComparisonStart !== yearToDateComparisonStart
              || existing.extraction !== extraction
              || existing.reviewMethod !== reviewMethod) {
              throw contractViolation("tradefoto-report-reuse-conflict");
            }
            return frozenResult({ created: false, report: existing });
          }

          const existingReportPeriod = await operations.queryOne(S.getReport, { id: reportId });
          if (existingReportPeriod) {
            throw contractViolation("tradefoto-report-period-conflict");
          }

          let mappingHead = await operations.queryOne(S.getBranchMappingHead, {
            sourceSystem: TRADEFOTO_REPORT_SOURCE_SYSTEM,
            externalBranchId,
          });
          if (!mappingHead) {
            await operations.execute(S.insertBranchMappingHead, {
              sourceSystem: TRADEFOTO_REPORT_SOURCE_SYSTEM,
              externalBranchId,
              actor,
              timestamp,
            });
            mappingHead = { activeRevision: null };
          }
          if (mappingHead.activeRevision !== null) {
            const activeMapping = await operations.queryOne(S.getBranchMappingRevision, {
              sourceSystem: TRADEFOTO_REPORT_SOURCE_SYSTEM,
              externalBranchId,
              revision: mappingHead.activeRevision,
            });
            if (!activeMapping
              || activeMapping.status !== "approved"
              || activeMapping.locationId !== locationId) {
              throw retryable("tradefoto-branch-mapping-conflict");
            }
          } else {
            const revision = 1;
            const evidenceId = `pdf:${sourceFileSha256}`;
            const validFrom = normalizedDate(preview.report.periods.period.start, operation);
            const mappingSha256 = crypto.createHash("sha256").update(JSON.stringify({
              sourceSystem: TRADEFOTO_REPORT_SOURCE_SYSTEM,
              externalBranchId,
              locationId,
              status: "approved",
              validFrom,
              validTo: null,
              evidenceId,
            })).digest("hex");
            await operations.execute(S.insertBranchMappingRevision, {
              sourceSystem: TRADEFOTO_REPORT_SOURCE_SYSTEM,
              externalBranchId,
              revision,
              locationId,
              status: "approved",
              validFrom,
              validTo: null,
              evidenceId,
              mappingSha256,
              actor,
              timestamp,
            });
            executionSucceeded(await operations.execute(S.activateBranchMappingRevision, {
              sourceSystem: TRADEFOTO_REPORT_SOURCE_SYSTEM,
              externalBranchId,
              revision,
              expectedRevision: null,
              actor,
              timestamp,
            }), operation);
          }

          await operations.execute(S.insertReport, {
            id: reportId,
            sourceSystem: TRADEFOTO_REPORT_SOURCE_SYSTEM,
            sourceFileSha256,
            parserVersion: positiveInteger(preview.parserVersion, operation),
            extraction,
            reviewMethod,
            reportKind,
            externalBranchId,
            locationId,
            currency,
            periodStart,
            periodEnd,
            comparisonStart,
            comparisonEnd,
            yearToDateStart,
            yearToDateComparisonStart,
            generatedOn: preview.report.generatedOn === null
              ? null
              : normalizedDate(preview.report.generatedOn, operation),
            pageCount: positiveInteger(preview.source.pageCount, operation),
            productGroupCount: positiveInteger(preview.productGroups.length, operation),
            issueCount: nonNegativeInteger(preview.issues.length, operation),
            reconciliationStatus: preview.reconciliation.status,
            actor,
            timestamp,
          });

          for (const group of preview.productGroups) {
            for (const [horizon, sourceHorizon] of [
              ["period", "period"],
              ["year_to_date", "yearToDate"],
            ]) {
              await operations.execute(S.insertReportProductGroupMetric, metricParameters(
                reportId,
                horizon,
                group.horizons[sourceHorizon],
                {
                  externalProductGroupId: normalizedText(
                    group.externalProductGroupId,
                    operation,
                    80,
                  ),
                  productGroupLabel: normalizedText(group.label, operation, 240),
                  sourcePage: positiveInteger(group.source.page, operation),
                  sourceOrdinate: normalizedDecimal4(group.source.ordinate, operation),
                },
              ));
            }
          }
          for (const [horizon, sourceHorizon] of [
            ["period", "period"],
            ["year_to_date", "yearToDate"],
          ]) {
            await operations.execute(S.insertReportTotalMetric, metricParameters(
              reportId,
              horizon,
              preview.totals.horizons[sourceHorizon],
              { sourcePage: positiveInteger(preview.totals.source.page, operation) },
            ));
          }
          const saved = await operations.queryOne(S.getReport, { id: reportId });
          if (!saved) throw contractViolation(operation);
          return frozenResult({ created: true, report: saved });
        }).catch((error) => {
          if (error?.code === PERSISTENCE_ERROR_CODES.UNIQUE_VIOLATION) {
            throw contractViolation("tradefoto-report-period-conflict");
          }
          throw error;
        });
      },

      transaction(work) {
        if (typeof work !== "function" || typeof access.transaction !== "function") {
          throw invalidInput("transaction");
        }
        return access.transaction((executor) => (
          work(createSalesAnalyticsPersistenceRepository(executor))
        ));
      },
    };

    const frozen = Object.freeze(repository);
    REPOSITORIES.add(frozen);
    return frozen;
  },
);

function assertSalesAnalyticsPersistenceRepository(repository) {
  if (!REPOSITORIES.has(repository)) throw contractViolation("sales-analytics-repository");
  return repository;
}

module.exports = {
  assertSalesAnalyticsPersistenceRepository,
  createSalesAnalyticsPersistenceRepository,
};
