"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceAccess,
} = require("../contract");
const {
  SYSTEM_CENTER_METRICS_STATEMENTS,
} = require("../statements/system-center-metrics");

const REPOSITORIES = new WeakSet();

function invalidInput(operation) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, { operation });
}

function positiveSafeInteger(value, operation) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalidInput(operation);
  return value;
}

function executorMethods(executor) {
  return Object.freeze({
    listSamples(limit) {
      return executor.queryAll(SYSTEM_CENTER_METRICS_STATEMENTS.listSamples, {
        limit: positiveSafeInteger(limit, "listSamples"),
      });
    },
    insertSample(sample) {
      if (!sample || typeof sample !== "object" || Array.isArray(sample)) {
        throw invalidInput("insertSample");
      }
      return executor.execute(SYSTEM_CENTER_METRICS_STATEMENTS.insertSample, sample);
    },
    deleteBefore(cutoff) {
      return executor.execute(SYSTEM_CENTER_METRICS_STATEMENTS.deleteBefore, { cutoff });
    },
    overflowCount(maximumSamples) {
      return executor.queryOne(SYSTEM_CENTER_METRICS_STATEMENTS.overflowCount, {
        maximumSamples: positiveSafeInteger(maximumSamples, "overflowCount"),
      });
    },
    oldestIntervalKeys(limit) {
      return executor.queryAll(SYSTEM_CENTER_METRICS_STATEMENTS.oldestIntervalKeys, {
        limit: positiveSafeInteger(limit, "oldestIntervalKeys"),
      });
    },
    deleteByIntervalKey(intervalKey) {
      return executor.execute(SYSTEM_CENTER_METRICS_STATEMENTS.deleteByIntervalKey, {
        intervalKey,
      });
    },
    listReadinessEvidence() {
      return executor.queryAll(SYSTEM_CENTER_METRICS_STATEMENTS.listReadinessEvidence);
    },
    insertReadinessEvidence(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw invalidInput("insertReadinessEvidence");
      }
      return executor.execute(SYSTEM_CENTER_METRICS_STATEMENTS.insertReadinessEvidence, {
        id: value.id,
        checkId: value.checkId,
        outcome: value.outcome,
        payloadJson: JSON.stringify(value),
        receiptSha256: value.receiptSha256,
        observedBy: value.observedBy,
        observedAt: value.observedAt,
        createdAt: value.createdAt,
      });
    },
    listReadinessAcceptances() {
      return executor.queryAll(SYSTEM_CENTER_METRICS_STATEMENTS.listReadinessAcceptances);
    },
    insertReadinessAcceptance(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw invalidInput("insertReadinessAcceptance");
      }
      return executor.execute(SYSTEM_CENTER_METRICS_STATEMENTS.insertReadinessAcceptance, {
        id: value.id,
        discipline: value.discipline,
        decision: value.decision,
        releaseVersion: value.releaseVersion,
        basisSha256: value.basisSha256,
        payloadJson: JSON.stringify(value),
        receiptSha256: value.receiptSha256,
        decidedBy: value.decidedBy,
        decidedAt: value.decidedAt,
      });
    },
    listRecoveryNotifications() {
      return executor.queryAll(SYSTEM_CENTER_METRICS_STATEMENTS.listRecoveryNotifications);
    },
    closeRecoveryNotification(id) {
      return executor.execute(SYSTEM_CENTER_METRICS_STATEMENTS.closeRecoveryNotification, { id });
    },
    latestRecoveryNotification() {
      return executor.queryOne(SYSTEM_CENTER_METRICS_STATEMENTS.latestRecoveryNotification);
    },
  });
}

function createSystemCenterMetricsRepository(access) {
  assertPersistenceAccess(access);
  const methods = executorMethods(access);
  const repository = Object.freeze({
    ...methods,
    ...(typeof access.transaction === "function" ? { transaction(work) {
      if (typeof work !== "function") throw invalidInput("transaction");
      return access.transaction((executor) => work(executorMethods(executor)));
    } } : {}),
  });
  REPOSITORIES.add(repository);
  return repository;
}

function assertSystemCenterMetricsRepository(repository) {
  if (!REPOSITORIES.has(repository)) {
    throw new TypeError("Ein System-Center-Metrics-Repository wird benoetigt.");
  }
  return repository;
}

module.exports = {
  assertSystemCenterMetricsRepository,
  createSystemCenterMetricsRepository,
};
