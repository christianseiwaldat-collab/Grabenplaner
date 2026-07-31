"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  SCALEWAY_TEM_PROVIDER_ID,
  SCALEWAY_TEM_SMTP_HOST,
  SCALEWAY_TEM_SMTP_PORT,
  emailConfigurationFromEnvironment,
} = require("../lib/email-provider-configuration");
const { createExternalNotificationAdapter } = require("../lib/external-notifications");

const COMPLETE_SCALEWAY_ENVIRONMENT = Object.freeze({
  GRABENPLANER_EMAIL_PROVIDER: "scaleway-tem",
  GRABENPLANER_EMAIL_FROM: "Grabenplaner <benachrichtigung@grabenplaner.eu>",
  GRABENPLANER_SCALEWAY_TEM_PROJECT_ID: "project-id",
  GRABENPLANER_SCALEWAY_TEM_SECRET_KEY: "scaleway-secret",
});

test("Scaleway TEM verwendet einen festen TLS-SMTP-Endpunkt und verlangt Authentifizierung", () => {
  const configuration = emailConfigurationFromEnvironment(COMPLETE_SCALEWAY_ENVIRONMENT);
  assert.deepEqual(configuration, {
    enabled: true,
    valid: true,
    providerId: SCALEWAY_TEM_PROVIDER_ID,
    dispatchEnabled: false,
    senderApproved: false,
    allowedEvents: [],
    authenticationRequired: true,
    host: SCALEWAY_TEM_SMTP_HOST,
    port: SCALEWAY_TEM_SMTP_PORT,
    secure: false,
    user: "project-id",
    password: "scaleway-secret",
    from: "Grabenplaner <benachrichtigung@grabenplaner.eu>",
  });
});

test("Scaleway TEM bleibt ohne ausdrückliche Versand- und Ereignisfreigabe gesperrt", async () => {
  const adapter = createExternalNotificationAdapter({
    environment: COMPLETE_SCALEWAY_ENVIRONMENT,
    smtpTransport: { async sendMail() { throw new Error("must not send"); } },
  });
  const status = adapter.getProviderStatus().email;
  assert.deepEqual(status, {
    configured: true,
    valid: true,
    available: false,
    transport: "smtp",
    provider: "scaleway-tem",
    dispatchEnabled: false,
    senderApproved: false,
    enabledEvents: [],
    issueCode: "dispatch_disabled",
  });
  assert.doesNotMatch(JSON.stringify(status), /project-id|scaleway-secret|benachrichtigung@/);
  assert.equal(adapter.canSendEvent("email", "staffing_warning"), false);
  await assert.rejects(
    adapter.sendStaffingAlert({ channel: "email", recipient: "leitung@example.test" }),
    { code: "EXTERNAL_NOTIFICATION_DISPATCH_DISABLED" },
  );
});

test("Scaleway TEM versendet ausschließlich ausdrücklich freigegebene Ereignisse", async () => {
  const sent = [];
  const adapter = createExternalNotificationAdapter({
    environment: {
      ...COMPLETE_SCALEWAY_ENVIRONMENT,
      GRABENPLANER_EMAIL_DISPATCH_ENABLED: "1",
      GRABENPLANER_EMAIL_SENDER_APPROVED: "1",
      GRABENPLANER_EMAIL_ALLOWED_EVENTS: "staffing_warning",
    },
    smtpTransport: { async sendMail(message) { sent.push(message); return { accepted: [message.to] }; } },
  });
  assert.equal(adapter.canSendEvent("email", "staffing_warning"), true);
  assert.equal(adapter.canSendEvent("email", "process_notification"), false);
  await adapter.sendStaffingAlert({ channel: "email", recipient: "leitung@example.test" });
  await assert.rejects(
    adapter.sendProcessAlert({ channel: "email", recipient: "leitung@example.test" }),
    { code: "EXTERNAL_NOTIFICATION_EVENT_DISABLED" },
  );
  assert.equal(sent.length, 1);
});

test("Scaleway TEM verlangt die ausdrückliche Freigabe des Absenders auch bei direktem Versand", async () => {
  let deliveryAttempts = 0;
  const adapter = createExternalNotificationAdapter({
    environment: {
      ...COMPLETE_SCALEWAY_ENVIRONMENT,
      GRABENPLANER_EMAIL_DISPATCH_ENABLED: "1",
      GRABENPLANER_EMAIL_ALLOWED_EVENTS: "staffing_warning",
    },
    smtpTransport: {
      async sendMail() { deliveryAttempts += 1; return { accepted: true }; },
    },
  });
  assert.equal(adapter.getProviderStatus().email.issueCode, "sender_not_approved");
  assert.equal(adapter.canSendEvent("email", "staffing_warning"), false);
  await assert.rejects(
    adapter.sendStaffingAlert({ channel: "email", recipient: "leitung@example.test" }),
    { code: "EXTERNAL_NOTIFICATION_SENDER_NOT_APPROVED" },
  );
  assert.equal(deliveryAttempts, 0);
});

test("Unbekannte Anbieter und Ereignisse werden fail-closed abgewiesen", () => {
  assert.equal(emailConfigurationFromEnvironment({
    GRABENPLANER_EMAIL_PROVIDER: "unknown-provider",
  }).valid, false);
  assert.equal(emailConfigurationFromEnvironment({
    ...COMPLETE_SCALEWAY_ENVIRONMENT,
    GRABENPLANER_EMAIL_ALLOWED_EVENTS: "staffing_warning,unknown_event",
  }).valid, false);
});
