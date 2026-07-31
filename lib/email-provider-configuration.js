"use strict";

const CUSTOM_SMTP_PROVIDER_ID = "custom-smtp";
const SCALEWAY_TEM_PROVIDER_ID = "scaleway-tem";
const SCALEWAY_TEM_SMTP_HOST = "smtp.tem.scaleway.com";
const SCALEWAY_TEM_SMTP_PORT = 587;

const SUPPORTED_EMAIL_EVENTS = Object.freeze([
  "destination_verification",
  "loan_document",
  "process_notification",
  "staffing_warning",
]);

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function normalizeAllowedEmailEvents(value, { defaultToAll = false } = {}) {
  const raw = String(value || "").trim();
  if (!raw) {
    return {
      valid: true,
      values: defaultToAll ? [...SUPPORTED_EMAIL_EVENTS] : [],
      unknown: [],
    };
  }
  const requested = [...new Set(raw.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
  const supported = new Set(SUPPORTED_EMAIL_EVENTS);
  const unknown = requested.filter((entry) => !supported.has(entry));
  return {
    valid: unknown.length === 0,
    values: requested.filter((entry) => supported.has(entry)),
    unknown,
  };
}

function customSmtpConfiguration(environment) {
  const enabled = Boolean(
    environment.GRABENPLANER_SMTP_HOST
    || environment.GRABENPLANER_SMTP_FROM
    || environment.GRABENPLANER_SMTP_USER
    || environment.GRABENPLANER_SMTP_PASSWORD,
  );
  const policy = normalizeAllowedEmailEvents(
    environment.GRABENPLANER_EMAIL_ALLOWED_EVENTS,
  );
  return {
    enabled,
    valid: policy.valid,
    providerId: CUSTOM_SMTP_PROVIDER_ID,
    dispatchEnabled: booleanValue(environment.GRABENPLANER_EMAIL_DISPATCH_ENABLED, false),
    senderApproved: booleanValue(environment.GRABENPLANER_EMAIL_SENDER_APPROVED, false),
    allowedEvents: policy.values,
    authenticationRequired: true,
    host: environment.GRABENPLANER_SMTP_HOST,
    port: environment.GRABENPLANER_SMTP_PORT || 587,
    secure: booleanValue(environment.GRABENPLANER_SMTP_SECURE),
    user: environment.GRABENPLANER_SMTP_USER,
    password: environment.GRABENPLANER_SMTP_PASSWORD,
    from: environment.GRABENPLANER_SMTP_FROM,
  };
}

function scalewayTemConfiguration(environment) {
  const policy = normalizeAllowedEmailEvents(environment.GRABENPLANER_EMAIL_ALLOWED_EVENTS);
  return {
    enabled: true,
    valid: policy.valid,
    providerId: SCALEWAY_TEM_PROVIDER_ID,
    dispatchEnabled: booleanValue(environment.GRABENPLANER_EMAIL_DISPATCH_ENABLED, false),
    senderApproved: booleanValue(environment.GRABENPLANER_EMAIL_SENDER_APPROVED, false),
    allowedEvents: policy.values,
    authenticationRequired: true,
    host: SCALEWAY_TEM_SMTP_HOST,
    port: SCALEWAY_TEM_SMTP_PORT,
    secure: false,
    user: environment.GRABENPLANER_SCALEWAY_TEM_PROJECT_ID,
    password: environment.GRABENPLANER_SCALEWAY_TEM_SECRET_KEY,
    from: environment.GRABENPLANER_EMAIL_FROM,
  };
}

function emailConfigurationFromEnvironment(environment = process.env) {
  const providerId = String(environment.GRABENPLANER_EMAIL_PROVIDER || "").trim().toLowerCase();
  if (!providerId || providerId === CUSTOM_SMTP_PROVIDER_ID) {
    return customSmtpConfiguration(environment);
  }
  if (providerId === SCALEWAY_TEM_PROVIDER_ID) {
    return scalewayTemConfiguration(environment);
  }
  return {
    enabled: true,
    valid: false,
    providerId,
    dispatchEnabled: false,
    senderApproved: false,
    allowedEvents: [],
  };
}

module.exports = {
  CUSTOM_SMTP_PROVIDER_ID,
  SCALEWAY_TEM_PROVIDER_ID,
  SCALEWAY_TEM_SMTP_HOST,
  SCALEWAY_TEM_SMTP_PORT,
  SUPPORTED_EMAIL_EVENTS,
  emailConfigurationFromEnvironment,
  normalizeAllowedEmailEvents,
};
