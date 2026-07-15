"use strict";

const SMTP_OPTIONAL_PACKAGE = "nodemailer";
const DEFAULT_TIMEOUT_MS = 8_000;
const MIN_TIMEOUT_MS = 10;
const MAX_TIMEOUT_MS = 30_000;
const STAFFING_ALERT_SUBJECT = "Besetzungswarnung in der App";
const STAFFING_ALERT_TEXT = "Dringende Besetzungswarnung in der App. Bitte anmelden.";
const DESTINATION_VERIFICATION_SUBJECT = "Grabenplaner: Kontakt bestätigen";
const WEBHOOK_CHANNELS = new Set(["sms", "whatsapp"]);

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

function validEmailAddress(value) {
  const address = String(value || "").trim();
  if (!address || address.length > 320 || containsHeaderBreak(address)) return false;
  const match = address.match(/(?:^|<)([^<>\s]+@[^<>\s]+)(?:>|$)/);
  return Boolean(match && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(match[1]));
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
  if (!enabled) return { enabled: false, configured: false, valid: true };

  const host = String(input.host || "").trim();
  const port = Number(input.port ?? 587);
  const from = String(input.from || "").trim();
  const user = String(input.user || "").trim();
  const password = String(input.password || "");
  const credentialsComplete = Boolean(user) === Boolean(password);
  if (
    !host
    || host.length > 253
    || containsHeaderBreak(host)
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
    || !validEmailAddress(from)
    || !credentialsComplete
  ) {
    return { enabled: true, configured: false, valid: false };
  }
  return {
    enabled: true,
    configured: true,
    valid: true,
    host,
    port,
    secure: input.secure === true,
    from,
    user,
    password,
  };
}

function normalizeWebhookConfiguration(input = {}) {
  const enabled = input.enabled === true || (input.enabled !== false && Boolean(input.url));
  if (!enabled) return { enabled: false, configured: false, valid: true };
  try {
    const url = validateHttpsWebhookUrl(input.url);
    const headers = normalizeHeaders(input.headers);
    const token = String(input.token || "").trim();
    if (token && (token.length > 4_096 || containsHeaderBreak(token))) {
      throw notificationError(
        "Die Webhook-Konfiguration ist ungültig.",
        "EXTERNAL_NOTIFICATION_WEBHOOK_TOKEN_INVALID",
      );
    }
    return { enabled: true, configured: true, valid: true, url, headers, token };
  } catch {
    return { enabled: true, configured: false, valid: false };
  }
}

function configurationFromEnvironment(environment = process.env) {
  const booleanValue = (value) => ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
  return {
    email: {
      enabled: Boolean(environment.GRABENPLANER_SMTP_HOST || environment.GRABENPLANER_SMTP_FROM),
      host: environment.GRABENPLANER_SMTP_HOST,
      port: environment.GRABENPLANER_SMTP_PORT || 587,
      secure: booleanValue(environment.GRABENPLANER_SMTP_SECURE),
      user: environment.GRABENPLANER_SMTP_USER,
      password: environment.GRABENPLANER_SMTP_PASSWORD,
      from: environment.GRABENPLANER_SMTP_FROM,
    },
    emailWebhook: {
      enabled: Boolean(environment.GRABENPLANER_EMAIL_WEBHOOK_URL),
      url: environment.GRABENPLANER_EMAIL_WEBHOOK_URL,
      token: environment.GRABENPLANER_EMAIL_WEBHOOK_TOKEN,
    },
    sms: {
      enabled: Boolean(environment.GRABENPLANER_SMS_WEBHOOK_URL),
      url: environment.GRABENPLANER_SMS_WEBHOOK_URL,
      token: environment.GRABENPLANER_SMS_WEBHOOK_TOKEN,
    },
    whatsapp: {
      enabled: Boolean(environment.GRABENPLANER_WHATSAPP_WEBHOOK_URL),
      url: environment.GRABENPLANER_WHATSAPP_WEBHOOK_URL,
      token: environment.GRABENPLANER_WHATSAPP_WEBHOOK_TOKEN,
    },
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
    email: normalizeWebhookConfiguration(configuration.emailWebhook),
    sms: normalizeWebhookConfiguration(configuration.sms),
    whatsapp: normalizeWebhookConfiguration(configuration.whatsapp),
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
    const statusForWebhook = (configurationForChannel) => ({
      configured: configurationForChannel.configured,
      valid: configurationForChannel.valid,
      available: Boolean(configurationForChannel.configured && typeof fetchImplementation === "function"),
      transport: "https-webhook",
      issueCode: !configurationForChannel.valid
        ? "invalid_configuration"
        : configurationForChannel.configured && typeof fetchImplementation !== "function"
          ? "transport_unavailable"
          : null,
    });
    return {
      email: {
        configured: smtp.configured || webhooks.email.configured,
        valid: smtp.valid && webhooks.email.valid,
        available: Boolean((smtp.configured && smtpTransport) || (webhooks.email.configured && typeof fetchImplementation === "function")),
        transport: smtp.configured ? "smtp" : "https-webhook",
        issueCode: !smtp.valid || !webhooks.email.valid
          ? "invalid_configuration"
          : smtp.configured && smtpTransportUnavailable && !webhooks.email.configured
            ? "optional_package_missing_or_transport_unavailable"
            : webhooks.email.configured && typeof fetchImplementation !== "function"
              ? "transport_unavailable"
            : null,
      },
      sms: statusForWebhook(webhooks.sms),
      whatsapp: statusForWebhook(webhooks.whatsapp),
    };
  }

  async function sendEmail(recipient, content) {
    if (smtp.configured && smtpTransport) {
      try {
        await hardTimeout(() => smtpTransport.sendMail({
          from: smtp.from,
          to: recipient,
          subject: content.subject,
          text: content.text,
        }), timeoutMs, () => smtpTransport.close?.());
        return;
      } catch (error) {
        if (error instanceof ExternalNotificationError && error.code === "EXTERNAL_NOTIFICATION_TIMEOUT") throw error;
        throw safeDeliveryError("email");
      }
    }
    if (webhooks.email.configured && typeof fetchImplementation === "function") {
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
    if (!webhook?.configured || typeof fetchImplementation !== "function") {
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
          recipient,
          message: content.text,
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

  return Object.freeze({
    getProviderStatus: providerStatus,
    sendStaffingAlert,
    sendVerificationCode,
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DESTINATION_VERIFICATION_SUBJECT,
  ExternalNotificationError,
  SMTP_OPTIONAL_PACKAGE,
  STAFFING_ALERT_SUBJECT,
  STAFFING_ALERT_TEXT,
  configurationFromEnvironment,
  createExternalNotificationAdapter,
  validateHttpsWebhookUrl,
};
