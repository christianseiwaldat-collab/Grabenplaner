"use strict";

const {
  CUSTOM_SMTP_PROVIDER_ID,
  SUPPORTED_EMAIL_EVENTS,
  emailConfigurationFromEnvironment,
} = require("./email-provider-configuration");

const SMTP_OPTIONAL_PACKAGE = "nodemailer";
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 10;
const MAX_TIMEOUT_MS = 30_000;
const STAFFING_ALERT_SUBJECT = "Besetzungswarnung in der App";
const STAFFING_ALERT_TEXT = "Dringende Besetzungswarnung in der App. Bitte anmelden.";
const PROCESS_ALERT_SUBJECT = "Neue Prozessmeldung in der App";
const PROCESS_ALERT_TEXT = "Eine neue Prozessmeldung wartet in der App. Bitte anmelden.";
const DESTINATION_VERIFICATION_SUBJECT = "Grabenplaner: Kontakt bestätigen";
const WEBHOOK_CHANNELS = new Set(["sms", "whatsapp"]);
const SUPPORTED_NOTIFICATION_EVENTS = SUPPORTED_EMAIL_EVENTS;

class ExternalNotificationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ExternalNotificationError";
    this.code = code;
  }
}

function notificationError(message, code) {
  return new ExternalNotificationError(message, code);
}

function normalizeTimeout(value) {
  const timeout = value === undefined ? DEFAULT_TIMEOUT_MS : Number(value);
  if (!Number.isInteger(timeout) || timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS) {
    throw notificationError(
      "Das Zeitlimit für externe Benachrichtigungen ist ungültig.",
      "EXTERNAL_NOTIFICATION_TIMEOUT_INVALID",
    );
  }
  return timeout;
}

function containsHeaderBreak(value) {
  return /[\r\n]/.test(String(value || ""));
}

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function normalizeAllowedNotificationEvents(value) {
  if (value === undefined || value === null || value === "") {
    return { valid: true, values: [], unknown: [] };
  }
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : null;
  if (!entries) return { valid: false, values: [], unknown: [] };
  const requested = [...new Set(entries
    .map((entry) => String(entry || "").trim().toLowerCase())
    .filter(Boolean))];
  const supported = new Set(SUPPORTED_NOTIFICATION_EVENTS);
  const unknown = requested.filter((entry) => !supported.has(entry));
  return {
    valid: unknown.length === 0,
    values: requested.filter((entry) => supported.has(entry)),
    unknown,
  };
}

function validEmailAddress(value) {
  const address = String(value || "").trim();
  if (!address || address.length > 320 || containsHeaderBreak(address)) return false;
  const match = address.match(/(?:^|<)([^<>\s]+@[^<>\s]+)(?:>|$)/);
  return Boolean(match && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(match[1]));
}

function normalizedBranchOrderSender(value) {
  const sender = String(value || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{2,39}-noreply@grabenplaner\.eu$/.test(sender)) {
    throw notificationError(
      "Der Absender der Filialbestellung ist ungültig.",
      "EXTERNAL_NOTIFICATION_SENDER_INVALID",
    );
  }
  return sender;
}

function validWebhookSender(channel, value) {
  const sender = String(value || "").trim();
  if (channel === "email") return validEmailAddress(sender);
  return Boolean(sender && sender.length <= 160 && !containsHeaderBreak(sender));
}

function validateRecipient(channel, value) {
  const recipient = String(value || "").trim();
  const valid = channel === "email"
    ? validEmailAddress(recipient)
    : recipient.length > 0 && recipient.length <= 160 && !containsHeaderBreak(recipient);
  if (!valid) {
    throw notificationError(
      "Für diesen Benachrichtigungskanal fehlt ein gültiges Ziel.",
      "EXTERNAL_NOTIFICATION_RECIPIENT_INVALID",
    );
  }
  return recipient;
}

function validateHttpsWebhookUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw notificationError(
      "Die Webhook-Konfiguration ist ungültig.",
      "EXTERNAL_NOTIFICATION_WEBHOOK_URL_INVALID",
    );
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.hash
    || !parsed.hostname
  ) {
    throw notificationError(
      "Die Webhook-Konfiguration ist ungültig.",
      "EXTERNAL_NOTIFICATION_WEBHOOK_URL_INVALID",
    );
  }
  return parsed.toString();
}

function normalizeHeaders(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw notificationError(
      "Die Webhook-Konfiguration ist ungültig.",
      "EXTERNAL_NOTIFICATION_WEBHOOK_HEADERS_INVALID",
    );
  }
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = String(rawName || "").trim().toLowerCase();
    const headerValue = String(rawValue || "").trim();
    if (
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)
      || ["content-length", "host"].includes(name)
      || !headerValue
      || headerValue.length > 2_048
      || containsHeaderBreak(headerValue)
    ) {
      throw notificationError(
        "Die Webhook-Konfiguration ist ungültig.",
        "EXTERNAL_NOTIFICATION_WEBHOOK_HEADERS_INVALID",
      );
    }
    headers[name] = headerValue;
  }
  return headers;
}

function normalizeSmtpConfiguration(input = {}) {
  const enabled = input.enabled === true || (input.enabled !== false && Boolean(
    input.host || input.from || input.user || input.password,
  ));
  if (!enabled) {
    return {
      enabled: false,
      configured: false,
      valid: true,
      dispatchEnabled: false,
      senderApproved: false,
      allowedEvents: [],
    };
  }

  const providerId = String(input.providerId || CUSTOM_SMTP_PROVIDER_ID).trim().toLowerCase();
  const dispatchEnabled = input.dispatchEnabled === true;
  const senderApproved = input.senderApproved === true;
  const eventPolicy = normalizeAllowedNotificationEvents(input.allowedEvents);
  const allowedEvents = eventPolicy.values;
  const host = String(input.host || "").trim();
  const port = Number(input.port ?? 587);
  const from = String(input.from || "").trim();
  const user = String(input.user || "").trim();
  const password = String(input.password || "");
  const credentialsComplete = Boolean(user && password);
  if (
    input.valid === false
    || !eventPolicy.valid
    || !host
    || host.length > 253
    || containsHeaderBreak(host)
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
    || !validEmailAddress(from)
    || !credentialsComplete
  ) {
    return {
      enabled: true,
      configured: false,
      valid: false,
      providerId,
      dispatchEnabled,
      senderApproved,
      allowedEvents,
    };
  }
  return {
    enabled: true,
    configured: true,
    valid: true,
    providerId,
    dispatchEnabled,
    senderApproved,
    allowedEvents,
    host,
    port,
    secure: input.secure === true,
    from,
    user,
    password,
  };
}

function normalizeWebhookConfiguration(input = {}, channel = "sms") {
  const enabled = input.enabled === true || (input.enabled !== false && Boolean(
    input.url
    || input.token
    || input.sender
    || input.dispatchEnabled
    || input.senderApproved
    || input.allowedEvents,
  ));
  const dispatchEnabled = input.dispatchEnabled === true;
  const senderApproved = input.senderApproved === true;
  const eventPolicy = normalizeAllowedNotificationEvents(input.allowedEvents);
  const allowedEvents = eventPolicy.values;
  if (!enabled) {
    return {
      enabled: false,
      configured: false,
      valid: true,
      dispatchEnabled,
      senderApproved,
      allowedEvents,
    };
  }
  try {
    const url = validateHttpsWebhookUrl(input.url);
    const headers = normalizeHeaders(input.headers);
    const token = String(input.token || "").trim();
    const sender = String(input.sender || "").trim();
    if (
      input.valid === false
      || !eventPolicy.valid
      || !token
      || token.length > 4_096
      || containsHeaderBreak(token)
      || !validWebhookSender(channel, sender)
    ) {
      throw notificationError(
        "Die Webhook-Konfiguration ist ungültig.",
        "EXTERNAL_NOTIFICATION_WEBHOOK_TOKEN_INVALID",
      );
    }
    return {
      enabled: true,
      configured: true,
      valid: true,
      url,
      headers,
      token,
      sender,
      dispatchEnabled,
      senderApproved,
      allowedEvents,
    };
  } catch {
    return {
      enabled: true,
      configured: false,
      valid: false,
      dispatchEnabled,
      senderApproved,
      allowedEvents,
    };
  }
}

function webhookConfigurationFromEnvironment(environment, channel) {
  const prefix = `GRABENPLANER_${channel.toUpperCase()}`;
  const eventPolicy = normalizeAllowedNotificationEvents(environment[`${prefix}_ALLOWED_EVENTS`]);
  const url = environment[`${prefix}_WEBHOOK_URL`];
  const token = environment[`${prefix}_WEBHOOK_TOKEN`];
  const sender = channel === "email"
    ? environment.GRABENPLANER_EMAIL_FROM || environment.GRABENPLANER_SMTP_FROM
    : environment[`${prefix}_SENDER`];
  const enabled = channel === "email"
    ? Boolean(url || token)
    : Boolean(
      url
      || token
      || sender
      || environment[`${prefix}_DISPATCH_ENABLED`]
      || environment[`${prefix}_SENDER_APPROVED`]
      || environment[`${prefix}_ALLOWED_EVENTS`],
    );
  return {
    enabled,
    valid: eventPolicy.valid,
    url,
    token,
    sender,
    dispatchEnabled: booleanValue(environment[`${prefix}_DISPATCH_ENABLED`], false),
    senderApproved: booleanValue(environment[`${prefix}_SENDER_APPROVED`], false),
    allowedEvents: eventPolicy.values,
  };
}

function configurationFromEnvironment(environment = process.env) {
  return {
    email: emailConfigurationFromEnvironment(environment),
    emailWebhook: webhookConfigurationFromEnvironment(environment, "email"),
    sms: webhookConfigurationFromEnvironment(environment, "sms"),
    whatsapp: webhookConfigurationFromEnvironment(environment, "whatsapp"),
  };
}

function hardTimeout(task, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { onTimeout?.(); } catch {}
      reject(notificationError(
        "Die externe Benachrichtigung hat das Zeitlimit überschritten.",
        "EXTERNAL_NOTIFICATION_TIMEOUT",
      ));
    }, timeoutMs);
    Promise.resolve()
      .then(task)
      .then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }, (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

function safeDeliveryError(channel) {
  const label = channel === "email" ? "E-Mail" : "Webhook";
  return notificationError(
    `Die ${label}-Benachrichtigung konnte nicht zugestellt werden.`,
    "EXTERNAL_NOTIFICATION_DELIVERY_FAILED",
  );
}

function createExternalNotificationAdapter(options = {}) {
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const configuration = options.configuration || configurationFromEnvironment(options.environment);
  const smtp = normalizeSmtpConfiguration(configuration.email);
  const webhooks = {
    email: normalizeWebhookConfiguration(configuration.emailWebhook, "email"),
    sms: normalizeWebhookConfiguration(configuration.sms, "sms"),
    whatsapp: normalizeWebhookConfiguration(configuration.whatsapp, "whatsapp"),
  };
  const fetchImplementation = options.fetchImplementation || globalThis.fetch;
  const loadSmtpModule = options.loadSmtpModule || (() => require(SMTP_OPTIONAL_PACKAGE));
  let smtpTransport = options.smtpTransport || null;
  let smtpTransportUnavailable = false;

  if (smtp.configured && !smtpTransport) {
    try {
      const module = loadSmtpModule();
      if (!module || typeof module.createTransport !== "function") throw new Error("transport unavailable");
      smtpTransport = module.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        requireTLS: !smtp.secure,
        connectionTimeout: timeoutMs,
        greetingTimeout: timeoutMs,
        socketTimeout: timeoutMs,
        tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
        ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.password } } : {}),
      });
      if (!smtpTransport || typeof smtpTransport.sendMail !== "function") throw new Error("transport unavailable");
    } catch {
      smtpTransport = null;
      smtpTransportUnavailable = true;
    }
  }

  function providerStatus() {
    const statusForWebhook = (configurationForChannel) => {
      const available = Boolean(
        configurationForChannel.configured
        && configurationForChannel.valid
        && configurationForChannel.dispatchEnabled
        && configurationForChannel.senderApproved
        && configurationForChannel.allowedEvents.length
        && typeof fetchImplementation === "function",
      );
      return {
        configured: configurationForChannel.configured,
        valid: configurationForChannel.valid,
        available,
        transport: "https-webhook",
        provider: configurationForChannel.enabled ? "https-webhook" : null,
        dispatchEnabled: configurationForChannel.dispatchEnabled,
        senderApproved: configurationForChannel.senderApproved,
        enabledEvents: [...configurationForChannel.allowedEvents],
        issueCode: !configurationForChannel.valid
          ? "invalid_configuration"
          : configurationForChannel.configured && !configurationForChannel.dispatchEnabled
            ? "dispatch_disabled"
            : configurationForChannel.configured && !configurationForChannel.senderApproved
              ? "sender_not_approved"
              : configurationForChannel.configured && !configurationForChannel.allowedEvents.length
                ? "no_events_enabled"
                : configurationForChannel.configured && typeof fetchImplementation !== "function"
                  ? "transport_unavailable"
                  : null,
      };
    };
    const smtpTransportAvailable = Boolean(smtp.configured && smtpTransport);
    const emailWebhookAvailable = Boolean(
      !smtp.enabled
      && webhooks.email.configured
      && typeof fetchImplementation === "function",
    );
    const emailConfiguration = smtp.enabled ? smtp : webhooks.email;
    const emailTransportAvailable = smtp.enabled ? smtpTransportAvailable : emailWebhookAvailable;
    const emailDispatchEnabled = emailConfiguration.dispatchEnabled;
    const emailSenderApproved = emailConfiguration.senderApproved;
    const enabledEvents = [...emailConfiguration.allowedEvents];
    const emailAvailable = Boolean(
      emailConfiguration.configured
      && emailConfiguration.valid
      && emailTransportAvailable
      && emailDispatchEnabled
      && emailSenderApproved
      && enabledEvents.length,
    );
    return {
      email: {
        configured: emailConfiguration.configured,
        valid: emailConfiguration.valid,
        available: emailAvailable,
        transport: smtp.enabled ? "smtp" : "https-webhook",
        provider: smtp.enabled ? smtp.providerId : webhooks.email.enabled ? "https-webhook" : null,
        dispatchEnabled: emailDispatchEnabled,
        senderApproved: emailSenderApproved,
        enabledEvents,
        issueCode: !emailConfiguration.valid
          ? "invalid_configuration"
          : emailConfiguration.configured && !emailDispatchEnabled
            ? "dispatch_disabled"
            : emailConfiguration.configured && !emailSenderApproved
              ? "sender_not_approved"
              : emailConfiguration.configured && !enabledEvents.length
                ? "no_events_enabled"
                : smtp.configured && smtpTransportUnavailable
                  ? "optional_package_missing_or_transport_unavailable"
                  : webhooks.email.configured && typeof fetchImplementation !== "function"
                    ? "transport_unavailable"
                    : null,
      },
      sms: statusForWebhook(webhooks.sms),
      whatsapp: statusForWebhook(webhooks.whatsapp),
    };
  }

  function canSendEvent(channel, event) {
    const normalizedChannel = String(channel || "").trim().toLowerCase();
    const normalizedEvent = String(event || "").trim().toLowerCase();
    const status = providerStatus()[normalizedChannel];
    return Boolean(status?.available && status.enabledEvents.includes(normalizedEvent));
  }

  function assertDispatchPolicy(configurationForChannel, event) {
    if (!configurationForChannel?.configured || !configurationForChannel.valid) {
      throw notificationError(
        "Der externe Versand ist nicht betriebsbereit.",
        "EXTERNAL_NOTIFICATION_PROVIDER_NOT_CONFIGURED",
      );
    }
    if (!configurationForChannel.dispatchEnabled) {
      throw notificationError(
        "Der externe Versand ist administrativ deaktiviert.",
        "EXTERNAL_NOTIFICATION_DISPATCH_DISABLED",
      );
    }
    if (!configurationForChannel.senderApproved) {
      throw notificationError(
        "Der Absender ist nicht ausdrücklich freigegeben.",
        "EXTERNAL_NOTIFICATION_SENDER_NOT_APPROVED",
      );
    }
    if (!configurationForChannel.allowedEvents.includes(String(event || "").trim().toLowerCase())) {
      throw notificationError(
        "Diese externe Benachrichtigung ist nicht freigeschaltet.",
        "EXTERNAL_NOTIFICATION_EVENT_DISABLED",
      );
    }
  }

  async function sendEmail(recipient, content) {
    if (smtp.enabled) {
      assertDispatchPolicy(smtp, content.event);
      if (!smtpTransport) {
        throw notificationError(
          "Der E-Mail-Versand ist nicht betriebsbereit.",
          "EXTERNAL_NOTIFICATION_PROVIDER_NOT_CONFIGURED",
        );
      }
      try {
        await hardTimeout(() => smtpTransport.sendMail({
          from: content.from || smtp.from,
          to: recipient,
          subject: content.subject,
          text: content.text,
          ...(content.replyTo ? { replyTo: content.replyTo } : {}),
          ...(Array.isArray(content.attachments) && content.attachments.length
            ? { attachments: content.attachments }
            : {}),
        }), timeoutMs, () => smtpTransport.close?.());
        return;
      } catch (error) {
        if (error instanceof ExternalNotificationError && error.code === "EXTERNAL_NOTIFICATION_TIMEOUT") throw error;
        throw safeDeliveryError("email");
      }
    }
    if (webhooks.email.enabled) {
      await sendWebhook("email", recipient, content);
      return;
    }
    {
      throw notificationError(
        "Der E-Mail-Versand ist nicht betriebsbereit.",
        "EXTERNAL_NOTIFICATION_PROVIDER_NOT_CONFIGURED",
      );
    }
  }

  async function sendWebhook(channel, recipient, content) {
    const webhook = webhooks[channel];
    assertDispatchPolicy(webhook, content.event);
    if (typeof fetchImplementation !== "function") {
      throw notificationError(
        "Der Webhook-Versand ist nicht betriebsbereit.",
        "EXTERNAL_NOTIFICATION_PROVIDER_NOT_CONFIGURED",
      );
    }
    const controller = new AbortController();
    const headers = { ...webhook.headers, "content-type": "application/json" };
    if (webhook.token) headers.authorization = `Bearer ${webhook.token}`;
    try {
      const response = await hardTimeout(() => fetchImplementation(webhook.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          event: content.event,
          channel,
          sender: content.from || webhook.sender,
          recipient,
          message: content.text,
          ...(content.replyTo ? { replyTo: content.replyTo } : {}),
          ...(content.code ? { code: content.code } : {}),
        }),
        redirect: "error",
        signal: controller.signal,
      }), timeoutMs, () => controller.abort());
      if (!response || response.ok !== true) throw safeDeliveryError(channel);
    } catch (error) {
      if (error instanceof ExternalNotificationError) throw error;
      throw safeDeliveryError(channel);
    }
  }

  async function sendStaffingAlert(input = {}) {
    const channel = String(input.channel || "").trim().toLowerCase();
    if (channel !== "email" && !WEBHOOK_CHANNELS.has(channel)) {
      throw notificationError(
        "Der Benachrichtigungskanal ist ungültig.",
        "EXTERNAL_NOTIFICATION_CHANNEL_INVALID",
      );
    }
    const recipient = validateRecipient(channel, input.recipient);
    const content = { event: "staffing_warning", subject: STAFFING_ALERT_SUBJECT, text: STAFFING_ALERT_TEXT };
    if (channel === "email") await sendEmail(recipient, content);
    else await sendWebhook(channel, recipient, content);
    return { delivered: true, channel };
  }

  async function sendProcessAlert(input = {}) {
    const channel = String(input.channel || "").trim().toLowerCase();
    if (channel !== "email" && !WEBHOOK_CHANNELS.has(channel)) {
      throw notificationError(
        "Der Benachrichtigungskanal ist ungültig.",
        "EXTERNAL_NOTIFICATION_CHANNEL_INVALID",
      );
    }
    const recipient = validateRecipient(channel, input.recipient);
    const content = { event: "process_notification", subject: PROCESS_ALERT_SUBJECT, text: PROCESS_ALERT_TEXT };
    if (channel === "email") await sendEmail(recipient, content);
    else await sendWebhook(channel, recipient, content);
    return { delivered: true, channel };
  }

  async function sendVerificationCode(input = {}) {
    const channel = String(input.channel || "").trim().toLowerCase();
    if (channel !== "email" && !WEBHOOK_CHANNELS.has(channel)) {
      throw notificationError("Der Benachrichtigungskanal ist ungültig.", "EXTERNAL_NOTIFICATION_CHANNEL_INVALID");
    }
    const recipient = validateRecipient(channel, input.recipient);
    const code = String(input.code || "").trim();
    if (!/^\d{6}$/.test(code)) {
      throw notificationError("Der Bestätigungscode ist ungültig.", "EXTERNAL_NOTIFICATION_VERIFICATION_CODE_INVALID");
    }
    const content = {
      event: "destination_verification",
      subject: DESTINATION_VERIFICATION_SUBJECT,
      text: `Ihr Grabenplaner-Bestätigungscode lautet ${code}. Er ist zehn Minuten gültig.`,
      code,
    };
    if (channel === "email") await sendEmail(recipient, content);
    else await sendWebhook(channel, recipient, content);
    return { delivered: true, channel };
  }

  async function sendLoanDocument(input = {}) {
    const recipient = validateRecipient("email", input.recipient);
    const attachment = Buffer.isBuffer(input.buffer) ? Buffer.from(input.buffer) : Buffer.alloc(0);
    if (!attachment.length || attachment.length > 8 * 1024 * 1024) {
      throw notificationError(
        "Der Leihbeleg ist leer oder zu groß für den E-Mail-Versand.",
        "EXTERNAL_NOTIFICATION_ATTACHMENT_INVALID",
      );
    }
    if (!smtp.configured || !smtpTransport) {
      throw notificationError(
        "Für Leihbelege ist ein betriebsbereiter SMTP-Versand erforderlich.",
        "EXTERNAL_NOTIFICATION_SMTP_REQUIRED",
      );
    }
    const filename = String(input.filename || "Leihbeleg.pdf")
      .replace(/[\r\n"\\/:*?<>|]/g, "-")
      .slice(0, 160);
    await sendEmail(recipient, {
      event: "loan_document",
      subject: String(input.subject || "Grabenplaner · Leihbeleg").slice(0, 180),
      text: String(input.text || "Ein neuer Leihbeleg wurde im Grabenplaner erstellt.").slice(0, 4000),
      attachments: [{
        filename,
        content: attachment,
        contentType: "application/pdf",
      }],
    });
    return { delivered: true, channel: "email" };
  }

  async function sendBranchOrder(input = {}) {
    const recipient = validateRecipient("email", input.recipient);
    const replyTo = validateRecipient("email", input.replyTo);
    const sender = normalizedBranchOrderSender(input.sender);
    const subject = String(input.subject || "").trim();
    const text = String(input.text || "").trim();
    if (!subject || subject.length > 180 || containsHeaderBreak(subject)) {
      throw notificationError(
        "Der Betreff der Filialbestellung ist ungültig.",
        "EXTERNAL_NOTIFICATION_SUBJECT_INVALID",
      );
    }
    if (!text || text.length > 12_000) {
      throw notificationError(
        "Der Text der Filialbestellung ist ungültig.",
        "EXTERNAL_NOTIFICATION_MESSAGE_INVALID",
      );
    }
    await sendEmail(recipient, {
      event: "branch_order",
      subject,
      text,
      replyTo,
      from: sender,
    });
    return { delivered: true, channel: "email" };
  }

  return Object.freeze({
    canSendEvent,
    getProviderStatus: providerStatus,
    sendBranchOrder,
    sendLoanDocument,
    sendProcessAlert,
    sendStaffingAlert,
    sendVerificationCode,
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DESTINATION_VERIFICATION_SUBJECT,
  ExternalNotificationError,
  PROCESS_ALERT_SUBJECT,
  PROCESS_ALERT_TEXT,
  SMTP_OPTIONAL_PACKAGE,
  STAFFING_ALERT_SUBJECT,
  STAFFING_ALERT_TEXT,
  configurationFromEnvironment,
  createExternalNotificationAdapter,
  validateHttpsWebhookUrl,
};
