"use strict";
function validatePersonalNotificationContactRows(rows) {
  const issues = [];
  const fingerprintValid = (value) => value === "" || /^[0-9a-f]{64}$/.test(String(value || ""));
  for (const row of rows) {
    const employeeNumber = String(row.employee_number || "");
    const prefix = employeeNumber ? `row:${employeeNumber}` : "row:missing_employee";
    if (!employeeNumber) issues.push(prefix);
    if (!fingerprintValid(row.email_target_fingerprint)) issues.push(`${prefix}:email_fingerprint`);
    if (!fingerprintValid(row.phone_target_fingerprint)) issues.push(`${prefix}:phone_fingerprint`);
    if (!fingerprintValid(row.verification_target_fingerprint)) issues.push(`${prefix}:verification_fingerprint`);
    if (row.email_verified_at && !row.email_target_fingerprint) issues.push(`${prefix}:email_verification_without_target`);
    if (row.phone_verified_at && !row.phone_target_fingerprint) issues.push(`${prefix}:phone_verification_without_target`);
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(row.earliest_time || ""))) {
      issues.push(`${prefix}:earliest_time`);
    }
    const pending = Boolean(row.verification_target);
    if (pending) {
      const expectedFingerprint = row.verification_target === "email"
        ? row.email_target_fingerprint : row.phone_target_fingerprint;
      const channelMatches = row.verification_target === "email"
        ? row.verification_channel === "email"
        : ["sms", "whatsapp"].includes(row.verification_channel);
      if (!channelMatches || !row.verification_target_fingerprint
        || row.verification_target_fingerprint !== expectedFingerprint
        || !row.verification_generation || !row.verification_hash || !row.verification_salt
        || !row.verification_expires_at) {
        issues.push(`${prefix}:verification_state`);
      }
    } else if (row.verification_channel || row.verification_target_fingerprint
      || row.verification_generation || row.verification_hash || row.verification_salt
      || row.verification_expires_at || Number(row.verification_attempts || 0) !== 0) {
      issues.push(`${prefix}:orphaned_verification_state`);
    }
  }
  return Object.freeze({
    valid: issues.length === 0,
    count: rows.length,
    issues: Object.freeze(issues),
  });
}
module.exports = { validatePersonalNotificationContactRows };
