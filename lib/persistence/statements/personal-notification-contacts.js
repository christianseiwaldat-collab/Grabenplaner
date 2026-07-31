"use strict";

const { definePersistenceStatement } = require("../contract");

const CONTACT_COLUMNS = Object.freeze({
  employeeNumber: "text",
  emailTargetFingerprint: "text",
  phoneTargetFingerprint: "text",
  emailVerifiedAt: { kind: "text", nullable: true },
  phoneVerifiedAt: { kind: "text", nullable: true },
  emailEnabled: "safe_integer",
  smsEnabled: "safe_integer",
  whatsappEnabled: "safe_integer",
  earliestTime: "text",
  verificationTarget: "text",
  verificationChannel: "text",
  verificationTargetFingerprint: "text",
  verificationHash: "text",
  verificationSalt: "text",
  verificationGeneration: "text",
  verificationExpiresAt: { kind: "text", nullable: true },
  verificationAttempts: "safe_integer",
  verificationSentAt: { kind: "text", nullable: true },
  verificationRateWindowStartedAt: { kind: "text", nullable: true },
  verificationRateCount: "safe_integer",
  createdAt: "text",
  updatedAt: "text",
});

const PERSONAL_NOTIFICATION_CONTACT_STATEMENTS = Object.freeze({
  get: definePersistenceStatement({
    id: "personal-notification-contacts.get",
    operation: "queryOne",
    parameters: { employeeNumber: "text" },
    columns: CONTACT_COLUMNS,
  }),
  reconcileTargets: definePersistenceStatement({
    id: "personal-notification-contacts.reconcile-targets",
    operation: "execute",
    parameters: {
      employeeNumber: "text",
      emailTargetFingerprint: "text",
      phoneTargetFingerprint: "text",
    },
  }),
  updatePreferences: definePersistenceStatement({
    id: "personal-notification-contacts.update-preferences",
    operation: "execute",
    parameters: {
      employeeNumber: "text",
      emailEnabled: "safe_integer",
      smsEnabled: "safe_integer",
      whatsappEnabled: "safe_integer",
      earliestTime: "text",
    },
  }),
  setVerification: definePersistenceStatement({
    id: "personal-notification-contacts.set-verification",
    operation: "execute",
    parameters: {
      employeeNumber: "text",
      expectedEmailTargetFingerprint: "text",
      expectedPhoneTargetFingerprint: "text",
      expectedVerificationGeneration: "text",
      expectedVerificationSentAt: "text",
      expectedVerificationRateWindowStartedAt: "text",
      expectedVerificationRateCount: "safe_integer",
      verificationTarget: "text",
      verificationChannel: "text",
      verificationTargetFingerprint: "text",
      verificationGeneration: "text",
      verificationHash: "text",
      verificationSalt: "text",
      verificationExpiresAt: "text",
      verificationSentAt: "text",
      verificationRateWindowStartedAt: "text",
      verificationRateCount: "safe_integer",
    },
  }),
  resetVerification: definePersistenceStatement({
    id: "personal-notification-contacts.reset-verification",
    operation: "execute",
    parameters: {
      employeeNumber: "text",
      verificationTargetFingerprint: "text",
      verificationGeneration: "text",
    },
  }),
  incrementVerificationAttempts: definePersistenceStatement({
    id: "personal-notification-contacts.increment-verification-attempts",
    operation: "execute",
    parameters: {
      employeeNumber: "text",
      verificationTarget: "text",
      verificationChannel: "text",
      verificationTargetFingerprint: "text",
      verificationGeneration: "text",
      verificationHash: "text",
      verificationSalt: "text",
      verificationExpiresAt: "text",
      verificationNow: "text",
      maxAttempts: "safe_integer",
    },
  }),
  confirmVerification: definePersistenceStatement({
    id: "personal-notification-contacts.confirm-verification",
    operation: "execute",
    parameters: {
      employeeNumber: "text",
      verificationTarget: "text",
      verificationChannel: "text",
      verificationTargetFingerprint: "text",
      verificationGeneration: "text",
      verificationHash: "text",
      verificationSalt: "text",
      verificationExpiresAt: "text",
      verifiedAt: "text",
      maxAttempts: "safe_integer",
    },
  }),
  recordAudit: definePersistenceStatement({
    id: "personal-notification-contacts.record-audit",
    operation: "execute",
    parameters: {
      actor: "text",
      action: "text",
      entityType: "text",
      entityId: "text",
      detail: "text",
    },
  }),
});

module.exports = {
  PERSONAL_NOTIFICATION_CONTACT_STATEMENTS,
};
