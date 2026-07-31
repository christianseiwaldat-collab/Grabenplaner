"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceAccess,
} = require("../contract");
const {
  PERSONAL_NOTIFICATION_CONTACT_STATEMENTS: S,
} = require("../statements/personal-notification-contacts");

function invalidInput(operation) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, { operation });
}

function identifier(value, operation) {
  if (typeof value !== "string") throw invalidInput(operation);
  const normalized = value.trim();
  if (!normalized || normalized.length > 255 || normalized.includes("\0")) {
    throw invalidInput(operation);
  }
  return normalized;
}

function text(value, operation) {
  if (typeof value !== "string" || value.includes("\0")) throw invalidInput(operation);
  return value;
}

function safeInteger(value, operation) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > 100) {
    throw invalidInput(operation);
  }
  return normalized;
}

function booleanInteger(value, operation) {
  const normalized = safeInteger(value, operation);
  if (![0, 1].includes(normalized)) throw invalidInput(operation);
  return normalized;
}

function createPersonalNotificationContactsRepository(access) {
  assertPersistenceAccess(access);
  return Object.freeze({
    get(employeeNumber) {
      return access.queryOne(S.get, {
        employeeNumber: identifier(employeeNumber, "get"),
      });
    },
    reconcileTargets({ employeeNumber, emailTargetFingerprint, phoneTargetFingerprint } = {}) {
      return access.execute(S.reconcileTargets, {
        employeeNumber: identifier(employeeNumber, "reconcileTargets"),
        emailTargetFingerprint: text(emailTargetFingerprint, "reconcileTargets"),
        phoneTargetFingerprint: text(phoneTargetFingerprint, "reconcileTargets"),
      });
    },
    updatePreferences({
      employeeNumber,
      emailEnabled,
      smsEnabled,
      whatsappEnabled,
      earliestTime,
    } = {}) {
      return access.execute(S.updatePreferences, {
        employeeNumber: identifier(employeeNumber, "updatePreferences"),
        emailEnabled: booleanInteger(emailEnabled, "updatePreferences"),
        smsEnabled: booleanInteger(smsEnabled, "updatePreferences"),
        whatsappEnabled: booleanInteger(whatsappEnabled, "updatePreferences"),
        earliestTime: text(earliestTime, "updatePreferences"),
      });
    },
    setVerification(input = {}) {
      const operation = "setVerification";
      return access.execute(S.setVerification, {
        employeeNumber: identifier(input.employeeNumber, operation),
        expectedEmailTargetFingerprint: text(input.expectedEmailTargetFingerprint, operation),
        expectedPhoneTargetFingerprint: text(input.expectedPhoneTargetFingerprint, operation),
        expectedVerificationGeneration: text(input.expectedVerificationGeneration, operation),
        expectedVerificationSentAt: text(input.expectedVerificationSentAt, operation),
        expectedVerificationRateWindowStartedAt: text(
          input.expectedVerificationRateWindowStartedAt,
          operation,
        ),
        expectedVerificationRateCount: safeInteger(input.expectedVerificationRateCount, operation),
        verificationTarget: text(input.verificationTarget, operation),
        verificationChannel: text(input.verificationChannel, operation),
        verificationTargetFingerprint: text(input.verificationTargetFingerprint, operation),
        verificationGeneration: text(input.verificationGeneration, operation),
        verificationHash: text(input.verificationHash, operation),
        verificationSalt: text(input.verificationSalt, operation),
        verificationExpiresAt: text(input.verificationExpiresAt, operation),
        verificationSentAt: text(input.verificationSentAt, operation),
        verificationRateWindowStartedAt: text(input.verificationRateWindowStartedAt, operation),
        verificationRateCount: safeInteger(input.verificationRateCount, operation),
      });
    },
    resetVerification(input = {}) {
      const operation = "resetVerification";
      return access.execute(S.resetVerification, {
        employeeNumber: identifier(input.employeeNumber, operation),
        verificationTargetFingerprint: text(input.verificationTargetFingerprint, operation),
        verificationGeneration: text(input.verificationGeneration, operation),
      });
    },
    incrementVerificationAttempts(input = {}) {
      const operation = "incrementVerificationAttempts";
      return access.execute(S.incrementVerificationAttempts, {
        employeeNumber: identifier(input.employeeNumber, operation),
        verificationTarget: text(input.verificationTarget, operation),
        verificationChannel: text(input.verificationChannel, operation),
        verificationTargetFingerprint: text(input.verificationTargetFingerprint, operation),
        verificationGeneration: text(input.verificationGeneration, operation),
        verificationHash: text(input.verificationHash, operation),
        verificationSalt: text(input.verificationSalt, operation),
        verificationExpiresAt: text(input.verificationExpiresAt, operation),
        verificationNow: text(input.verificationNow, operation),
        maxAttempts: safeInteger(input.maxAttempts, operation),
      });
    },
    confirmVerification(input = {}) {
      const operation = "confirmVerification";
      return access.execute(S.confirmVerification, {
        employeeNumber: identifier(input.employeeNumber, operation),
        verificationTarget: text(input.verificationTarget, operation),
        verificationChannel: text(input.verificationChannel, operation),
        verificationTargetFingerprint: text(input.verificationTargetFingerprint, operation),
        verificationGeneration: text(input.verificationGeneration, operation),
        verificationHash: text(input.verificationHash, operation),
        verificationSalt: text(input.verificationSalt, operation),
        verificationExpiresAt: text(input.verificationExpiresAt, operation),
        verifiedAt: text(input.verifiedAt, operation),
        maxAttempts: safeInteger(input.maxAttempts, operation),
      });
    },
    recordAudit({ actor, action, entityType = "", entityId = "", detail = "" } = {}) {
      return access.execute(S.recordAudit, {
        actor: identifier(actor, "recordAudit"),
        action: identifier(action, "recordAudit"),
        entityType: text(entityType, "recordAudit"),
        entityId: text(entityId, "recordAudit"),
        detail: text(detail, "recordAudit"),
      });
    },
    ...(typeof access.transaction === "function" ? {
      transaction(work) {
        if (typeof work !== "function") throw invalidInput("transaction");
        return access.transaction((executor) => (
          work(createPersonalNotificationContactsRepository(executor))
        ));
      },
    } : {}),
  });
}

module.exports = {
  createPersonalNotificationContactsRepository,
};
