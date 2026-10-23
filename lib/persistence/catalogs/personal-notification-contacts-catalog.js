"use strict";

const {
  PERSONAL_NOTIFICATION_CONTACT_STATEMENTS: S,
} = require("../statements/personal-notification-contacts");

const SQLITE_PERSONAL_NOTIFICATION_CONTACTS_CATALOG = Object.freeze([
  Object.freeze({
    statement: S.get,
    sql: `
      SELECT
        employee_number AS employeeNumber,
        email_target_fingerprint AS emailTargetFingerprint,
        phone_target_fingerprint AS phoneTargetFingerprint,
        email_verified_at AS emailVerifiedAt,
        phone_verified_at AS phoneVerifiedAt,
        email_enabled AS emailEnabled,
        sms_enabled AS smsEnabled,
        whatsapp_enabled AS whatsappEnabled,
        earliest_time AS earliestTime,
        verification_target AS verificationTarget,
        verification_channel AS verificationChannel,
        verification_target_fingerprint AS verificationTargetFingerprint,
        verification_hash AS verificationHash,
        verification_salt AS verificationSalt,
        verification_generation AS verificationGeneration,
        verification_expires_at AS verificationExpiresAt,
        verification_attempts AS verificationAttempts,
        verification_sent_at AS verificationSentAt,
        verification_rate_window_started_at AS verificationRateWindowStartedAt,
        verification_rate_count AS verificationRateCount,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM personal_notification_contacts
      WHERE employee_number = $employeeNumber
      LIMIT 1
    `,
    returning: false,
  }),
  Object.freeze({
    statement: S.reconcileTargets,
    sql: `
      INSERT INTO personal_notification_contacts (
        employee_number,
        email_target_fingerprint,
        phone_target_fingerprint,
        updated_at
      ) VALUES (
        $employeeNumber,
        $emailTargetFingerprint,
        $phoneTargetFingerprint,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(employee_number) DO UPDATE SET
        email_verified_at = CASE
          WHEN personal_notification_contacts.email_target_fingerprint = excluded.email_target_fingerprint
            THEN personal_notification_contacts.email_verified_at
          ELSE NULL
        END,
        phone_verified_at = CASE
          WHEN personal_notification_contacts.phone_target_fingerprint = excluded.phone_target_fingerprint
            THEN personal_notification_contacts.phone_verified_at
          ELSE NULL
        END,
        verification_target = CASE
          WHEN personal_notification_contacts.verification_target = 'email'
            AND personal_notification_contacts.verification_target_fingerprint <> excluded.email_target_fingerprint
            THEN ''
          WHEN personal_notification_contacts.verification_target = 'phone'
            AND personal_notification_contacts.verification_target_fingerprint <> excluded.phone_target_fingerprint
            THEN ''
          ELSE personal_notification_contacts.verification_target
        END,
        verification_channel = CASE
          WHEN personal_notification_contacts.verification_target = 'email'
            AND personal_notification_contacts.verification_target_fingerprint <> excluded.email_target_fingerprint
            THEN ''
          WHEN personal_notification_contacts.verification_target = 'phone'
            AND personal_notification_contacts.verification_target_fingerprint <> excluded.phone_target_fingerprint
            THEN ''
          ELSE personal_notification_contacts.verification_channel
        END,
        verification_target_fingerprint = CASE
          WHEN personal_notification_contacts.verification_target = 'email'
            AND personal_notification_contacts.verification_target_fingerprint <> excluded.email_target_fingerprint
            THEN ''
          WHEN personal_notification_contacts.verification_target = 'phone'
            AND personal_notification_contacts.verification_target_fingerprint <> excluded.phone_target_fingerprint
            THEN ''
          ELSE personal_notification_contacts.verification_target_fingerprint
        END,
        verification_generation = CASE
          WHEN (personal_notification_contacts.verification_target = 'email'
            AND personal_notification_contacts.verification_target_fingerprint <> excluded.email_target_fingerprint)
            OR (personal_notification_contacts.verification_target = 'phone'
            AND personal_notification_contacts.verification_target_fingerprint <> excluded.phone_target_fingerprint)
            THEN '' ELSE personal_notification_contacts.verification_generation END,
        verification_hash = CASE
          WHEN (personal_notification_contacts.verification_target = 'email'
            AND personal_notification_contacts.verification_target_fingerprint <> excluded.email_target_fingerprint)
            OR (personal_notification_contacts.verification_target = 'phone'
            AND personal_notification_contacts.verification_target_fingerprint <> excluded.phone_target_fingerprint)
            THEN '' ELSE personal_notification_contacts.verification_hash END,
        verification_salt = CASE
          WHEN (personal_notification_contacts.verification_target = 'email'
            AND personal_notification_contacts.verification_target_fingerprint <> excluded.email_target_fingerprint)
            OR (personal_notification_contacts.verification_target = 'phone'
            AND personal_notification_contacts.verification_target_fingerprint <> excluded.phone_target_fingerprint)
            THEN '' ELSE personal_notification_contacts.verification_salt END,
        verification_expires_at = CASE
          WHEN (personal_notification_contacts.verification_target = 'email'
            AND personal_notification_contacts.verification_target_fingerprint <> excluded.email_target_fingerprint)
            OR (personal_notification_contacts.verification_target = 'phone'
            AND personal_notification_contacts.verification_target_fingerprint <> excluded.phone_target_fingerprint)
            THEN NULL ELSE personal_notification_contacts.verification_expires_at END,
        verification_attempts = CASE
          WHEN (personal_notification_contacts.verification_target = 'email'
            AND personal_notification_contacts.verification_target_fingerprint <> excluded.email_target_fingerprint)
            OR (personal_notification_contacts.verification_target = 'phone'
            AND personal_notification_contacts.verification_target_fingerprint <> excluded.phone_target_fingerprint)
            THEN 0 ELSE personal_notification_contacts.verification_attempts END,
        email_target_fingerprint = excluded.email_target_fingerprint,
        phone_target_fingerprint = excluded.phone_target_fingerprint,
        updated_at = CASE
          WHEN personal_notification_contacts.email_target_fingerprint = excluded.email_target_fingerprint
            AND personal_notification_contacts.phone_target_fingerprint = excluded.phone_target_fingerprint
            THEN personal_notification_contacts.updated_at
          ELSE CURRENT_TIMESTAMP
        END
    `,
    returning: false,
  }),
  Object.freeze({
    statement: S.updatePreferences,
    sql: `
      INSERT INTO personal_notification_contacts (
        employee_number,
        email_enabled,
        sms_enabled,
        whatsapp_enabled,
        earliest_time,
        updated_at
      ) VALUES (
        $employeeNumber,
        $emailEnabled,
        $smsEnabled,
        $whatsappEnabled,
        $earliestTime,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(employee_number) DO UPDATE SET
        email_enabled = excluded.email_enabled,
        sms_enabled = excluded.sms_enabled,
        whatsapp_enabled = excluded.whatsapp_enabled,
        earliest_time = excluded.earliest_time,
        updated_at = CURRENT_TIMESTAMP
    `,
    returning: false,
  }),
  Object.freeze({
    statement: S.setVerification,
    sql: `
      UPDATE personal_notification_contacts
      SET
        verification_target = $verificationTarget,
        verification_channel = $verificationChannel,
        verification_target_fingerprint = $verificationTargetFingerprint,
        verification_generation = $verificationGeneration,
        verification_hash = $verificationHash,
        verification_salt = $verificationSalt,
        verification_expires_at = $verificationExpiresAt,
        verification_attempts = 0,
        verification_sent_at = $verificationSentAt,
        verification_rate_window_started_at = $verificationRateWindowStartedAt,
        verification_rate_count = $verificationRateCount,
        updated_at = CURRENT_TIMESTAMP
      WHERE employee_number = $employeeNumber
        AND email_target_fingerprint = $expectedEmailTargetFingerprint
        AND phone_target_fingerprint = $expectedPhoneTargetFingerprint
        AND verification_generation = $expectedVerificationGeneration
        AND COALESCE(verification_sent_at, '') = $expectedVerificationSentAt
        AND COALESCE(verification_rate_window_started_at, '') = $expectedVerificationRateWindowStartedAt
        AND verification_rate_count = $expectedVerificationRateCount
        AND (($verificationTarget = 'email'
          AND email_target_fingerprint = $verificationTargetFingerprint)
          OR ($verificationTarget = 'phone'
          AND phone_target_fingerprint = $verificationTargetFingerprint))
        AND $verificationTargetFingerprint <> ''
    `,
    returning: false,
  }),
  Object.freeze({
    statement: S.resetVerification,
    sql: `
      UPDATE personal_notification_contacts
      SET
        verification_target = '',
        verification_channel = '',
        verification_target_fingerprint = '',
        verification_generation = '',
        verification_hash = '',
        verification_salt = '',
        verification_expires_at = NULL,
        verification_attempts = 0,
        updated_at = CURRENT_TIMESTAMP
      WHERE employee_number = $employeeNumber
        AND verification_target_fingerprint = $verificationTargetFingerprint
        AND verification_generation = $verificationGeneration
    `,
    returning: false,
  }),
  Object.freeze({
    statement: S.incrementVerificationAttempts,
    sql: `
      UPDATE personal_notification_contacts
      SET verification_attempts = verification_attempts + 1, updated_at = CURRENT_TIMESTAMP
      WHERE employee_number = $employeeNumber
        AND verification_target = $verificationTarget
        AND verification_channel = $verificationChannel
        AND verification_target_fingerprint = $verificationTargetFingerprint
        AND verification_generation = $verificationGeneration
        AND verification_hash = $verificationHash
        AND verification_salt = $verificationSalt
        AND verification_expires_at = $verificationExpiresAt
        AND verification_expires_at > $verificationNow
        AND verification_attempts < $maxAttempts
    `,
    returning: false,
  }),
  Object.freeze({
    statement: S.confirmVerification,
    sql: `
      UPDATE personal_notification_contacts
      SET
        email_verified_at = CASE WHEN $verificationTarget = 'email'
          THEN $verifiedAt ELSE email_verified_at END,
        phone_verified_at = CASE WHEN $verificationTarget = 'phone'
          THEN $verifiedAt ELSE phone_verified_at END,
        verification_target = '',
        verification_channel = '',
        verification_target_fingerprint = '',
        verification_generation = '',
        verification_hash = '',
        verification_salt = '',
        verification_expires_at = NULL,
        verification_attempts = 0,
        updated_at = CURRENT_TIMESTAMP
      WHERE employee_number = $employeeNumber
        AND verification_target = $verificationTarget
        AND verification_channel = $verificationChannel
        AND verification_target_fingerprint = $verificationTargetFingerprint
        AND verification_generation = $verificationGeneration
        AND verification_hash = $verificationHash
        AND verification_salt = $verificationSalt
        AND verification_expires_at = $verificationExpiresAt
        AND verification_expires_at > $verifiedAt
        AND verification_attempts < $maxAttempts
        AND (($verificationTarget = 'email'
          AND email_target_fingerprint = $verificationTargetFingerprint)
          OR ($verificationTarget = 'phone'
          AND phone_target_fingerprint = $verificationTargetFingerprint))
    `,
    returning: false,
  }),
  Object.freeze({
    statement: S.recordAudit,
    sql: `
      INSERT INTO audit_log (actor, action, entity_type, entity_id, detail)
      VALUES ($actor, $action, $entityType, $entityId, substr($detail, 1, 2000))
    `,
    returning: false,
  }),
]);

module.exports = {
  SQLITE_PERSONAL_NOTIFICATION_CONTACTS_CATALOG,
};
