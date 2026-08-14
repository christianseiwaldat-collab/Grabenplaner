"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  SMTP_OPTIONAL_PACKAGE,
  PASSWORD_RESET_SUBJECT,
  PROCESS_ALERT_TEXT,
  STAFFING_ALERT_SUBJECT,
  STAFFING_ALERT_TEXT,
  createExternalNotificationAdapter,
  validateHttpsWebhookUrl,
} = require("../lib/external-notifications");

function enabledSmtp(event, overrides = {}) {
  return {
    enabled: true,
    host: "smtp.example.test",
    port: 587,
    from: "Grabenplaner <app@example.test>",
    user: "mailer",
    password: "smtp-secret",
    dispatchEnabled: true,
    senderApproved: true,
    allowedEvents: [event],
    ...overrides,
  };
}

function enabledWebhook(channel, event, overrides = {}) {
  return {
    enabled: true,
    url: `https://notify.example.test/${channel}`,
    token: `${channel}-secret`,
    sender: channel === "email"
      ? "Grabenplaner <app@example.test>"
      : `approved-${channel}-sender`,
    dispatchEnabled: true,
    senderApproved: true,
    allowedEvents: [event],
    ...overrides,
  };
}

test("Webhook-Adressen müssen HTTPS verwenden und dürfen keine Zugangsdaten enthalten", () => {
  assert.equal(validateHttpsWebhookUrl("https://notify.example.test/hook"), "https://notify.example.test/hook");
  assert.throws(() => validateHttpsWebhookUrl("http://notify.example.test/hook"), {
    code: "EXTERNAL_NOTIFICATION_WEBHOOK_URL_INVALID",
  });
  assert.throws(() => validateHttpsWebhookUrl("https://user:secret@notify.example.test/hook"), {
    code: "EXTERNAL_NOTIFICATION_WEBHOOK_URL_INVALID",
  });
});

test("Provider-Status enthält weder Konfigurationsgeheimnisse noch Empfänger", () => {
  const adapter = createExternalNotificationAdapter({
    configuration: {
      email: enabledSmtp("staffing_warning"),
      sms: enabledWebhook("sms", "staffing_warning"),
      whatsapp: enabledWebhook("whatsapp", "staffing_warning", { url: "http://unsafe.example.test" }),
    },
    smtpTransport: { sendMail: async () => ({ accepted: true }) },
    fetchImplementation: async () => ({ ok: true }),
  });
  const serialized = JSON.stringify(adapter.getProviderStatus());
  assert.doesNotMatch(serialized, /smtp-secret|sms-secret|wa-secret|smtp\.example|notify\.example|unsafe\.example/);
  assert.deepEqual(adapter.getProviderStatus().email, {
    configured: true, valid: true, available: true, transport: "smtp", issueCode: null,
    provider: "custom-smtp",
    dispatchEnabled: true,
    senderApproved: true,
    enabledEvents: ["staffing_warning"],
  });
  assert.equal(adapter.getProviderStatus().whatsapp.valid, false);
  assert.equal(adapter.getProviderStatus().whatsapp.available, false);
});

test("Direkte send*-Aufrufe umgehen bei keinem Kanal die vier Versand-Gates", async (t) => {
  const channels = ["email", "sms", "whatsapp"];
  const gateCases = [
    {
      name: "credentials",
      mutate(configuration, channel) {
        if (channel === "email") configuration.password = "";
        else configuration.token = "";
      },
      code: "EXTERNAL_NOTIFICATION_PROVIDER_NOT_CONFIGURED",
    },
    {
      name: "sender approval",
      mutate(configuration) { configuration.senderApproved = false; },
      code: "EXTERNAL_NOTIFICATION_SENDER_NOT_APPROVED",
    },
    {
      name: "dispatch switch",
      mutate(configuration) { configuration.dispatchEnabled = false; },
      code: "EXTERNAL_NOTIFICATION_DISPATCH_DISABLED",
    },
    {
      name: "event allowlist",
      mutate(configuration) { configuration.allowedEvents = ["process_notification"]; },
      code: "EXTERNAL_NOTIFICATION_EVENT_DISABLED",
    },
    {
      name: "missing event allowlist",
      mutate(configuration) { delete configuration.allowedEvents; },
      code: "EXTERNAL_NOTIFICATION_EVENT_DISABLED",
    },
  ];

  for (const channel of channels) {
    for (const gateCase of gateCases) {
      await t.test(`${channel}: ${gateCase.name}`, async () => {
        let deliveryAttempts = 0;
        const channelConfiguration = channel === "email"
          ? enabledSmtp("staffing_warning")
          : enabledWebhook(channel, "staffing_warning");
        gateCase.mutate(channelConfiguration, channel);
        const adapter = createExternalNotificationAdapter({
          configuration: channel === "email"
            ? { email: channelConfiguration }
            : { [channel]: channelConfiguration },
          smtpTransport: {
            async sendMail() { deliveryAttempts += 1; return { accepted: true }; },
          },
          fetchImplementation: async () => {
            deliveryAttempts += 1;
            return { ok: true };
          },
        });

        assert.equal(adapter.canSendEvent(channel, "staffing_warning"), false);
        await assert.rejects(
          adapter.sendStaffingAlert({
            channel,
            recipient: channel === "email" ? "leitung@example.test" : "+436601234567",
          }),
          { code: gateCase.code },
        );
        assert.equal(deliveryAttempts, 0);
      });
    }
  }
});

test("SMS- und WhatsApp-Webhooks erhalten ausschließlich den neutralen Besetzungswarnungstext", async () => {
  const calls = [];
  const adapter = createExternalNotificationAdapter({
    configuration: {
      sms: enabledWebhook("sms", "staffing_warning"),
      whatsapp: enabledWebhook("whatsapp", "staffing_warning"),
    },
    fetchImplementation: async (url, options) => {
      calls.push({ url, options });
      return { ok: true };
    },
  });
  await adapter.sendStaffingAlert({
    channel: "sms",
    recipient: "+431234567",
    message: "Diese Person ist krank",
    employeeNumber: "252",
    diagnosis: "darf niemals übertragen werden",
  });
  await adapter.sendStaffingAlert({ channel: "whatsapp", recipient: "+439876543" });

  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    event: "staffing_warning",
    channel: "sms",
    sender: "approved-sms-sender",
    recipient: "+431234567",
    message: STAFFING_ALERT_TEXT,
  });
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    event: "staffing_warning",
    channel: "whatsapp",
    sender: "approved-whatsapp-sender",
    recipient: "+439876543",
    message: STAFFING_ALERT_TEXT,
  });
  assert.equal(calls[0].options.headers.authorization, "Bearer sms-secret");
  assert.equal(calls[0].options.redirect, "error");
});

test("Eigene Prozesse versenden extern nur den neutralen Anmeldehinweis", async () => {
  const calls = [];
  const adapter = createExternalNotificationAdapter({
    configuration: { sms: enabledWebhook("sms", "process_notification") },
    fetchImplementation: async (url, options) => { calls.push({ url, options }); return { ok: true }; },
  });
  await adapter.sendProcessAlert({
    channel: "sms",
    recipient: "+436601234567",
    processTitle: "Vertraulicher Notfallprozess",
    employeeNumber: "252",
  });
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    event: "process_notification",
    channel: "sms",
    sender: "approved-sms-sender",
    recipient: "+436601234567",
    message: PROCESS_ALERT_TEXT,
  });
  assert.doesNotMatch(calls[0].options.body, /Notfallprozess|252/);
});

test("Zielbestätigung sendet nur Einmalcode und neutralen Verifizierungstext", async () => {
  const calls = [];
  const adapter = createExternalNotificationAdapter({
    configuration: { sms: enabledWebhook("sms", "destination_verification") },
    fetchImplementation: async (url, options) => { calls.push({ url, options }); return { ok: true }; },
  });
  await adapter.sendVerificationCode({
    channel: "sms",
    recipient: "+436601234567",
    code: "042815",
    employeeNumber: "252",
    illness: "darf nicht übertragen werden",
  });
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.event, "destination_verification");
  assert.equal(payload.code, "042815");
  assert.equal(payload.recipient, "+436601234567");
  assert.match(payload.message, /042815/);
  assert.doesNotMatch(calls[0].options.body, /252|illness|krank/i);
  assert.doesNotMatch(JSON.stringify(calls[0].options.headers), /042815/);
});

test("Passwortreset versendet nur einen HTTPS-Fragmentlink mit 32-Byte-Token", async () => {
  let mail;
  const token = Buffer.alloc(32, 7).toString("base64url");
  const adapter = createExternalNotificationAdapter({
    configuration: { email: enabledSmtp("password_reset") },
    smtpTransport: {
      async sendMail(value) {
        mail = value;
        return { accepted: [value.to] };
      },
    },
  });

  await adapter.sendPasswordReset({
    recipient: "verified@example.test",
    resetUrl: `https://beta.grabenplaner.eu/portal.html#password-reset=${token}`,
  });
  assert.equal(mail.to, "verified@example.test");
  assert.equal(mail.subject, PASSWORD_RESET_SUBJECT);
  assert.ok(mail.text.includes(`#password-reset=${token}`));
  assert.match(mail.text, /30 Minuten/);
  assert.doesNotMatch(mail.text, /\?password-reset=|\?token=/);

  const notExplicitlyAllowed = createExternalNotificationAdapter({
    configuration: { email: enabledSmtp("branch_order") },
    smtpTransport: { async sendMail() { throw new Error("must not send"); } },
  });
  assert.equal(notExplicitlyAllowed.canSendEvent("email", "password_reset"), false);
  await assert.rejects(
    notExplicitlyAllowed.sendPasswordReset({
      recipient: "verified@example.test",
      resetUrl: `https://beta.grabenplaner.eu/portal.html#password-reset=${token}`,
    }),
    { code: "EXTERNAL_NOTIFICATION_EVENT_DISABLED" },
  );

  for (const resetUrl of [
    `http://beta.grabenplaner.eu/portal.html#password-reset=${token}`,
    `https://beta.grabenplaner.eu/portal.html?token=${token}`,
    `https://user:secret@beta.grabenplaner.eu/portal.html#password-reset=${token}`,
    `https://beta.grabenplaner.eu/other.html#password-reset=${token}`,
    "https://beta.grabenplaner.eu/portal.html#password-reset=too-short",
  ]) {
    await assert.rejects(
      adapter.sendPasswordReset({ recipient: "verified@example.test", resetUrl }),
      { code: "EXTERNAL_NOTIFICATION_PASSWORD_RESET_URL_INVALID" },
    );
  }
});

test("SMTP-Versand nutzt TLS-Zeitlimits und nur den neutralen Nachrichtentext", async () => {
  let transportOptions;
  let mail;
  const adapter = createExternalNotificationAdapter({
    timeoutMs: 250,
    configuration: {
      email: {
        ...enabledSmtp("staffing_warning"),
      },
    },
    loadSmtpModule: () => ({
      createTransport(options) {
        transportOptions = options;
        return { async sendMail(value) { mail = value; return { accepted: true }; } };
      },
    }),
  });
  await adapter.sendStaffingAlert({
    channel: "email",
    recipient: "leitung@example.test",
    body: "Personaldaten dürfen nicht übernommen werden",
  });
  assert.equal(transportOptions.requireTLS, true);
  assert.equal(transportOptions.connectionTimeout, 250);
  assert.equal(transportOptions.greetingTimeout, 250);
  assert.equal(transportOptions.socketTimeout, 250);
  assert.equal(transportOptions.tls.minVersion, "TLSv1.2");
  assert.deepEqual(mail, {
    from: "Grabenplaner <app@example.test>",
    to: "leitung@example.test",
    subject: STAFFING_ALERT_SUBJECT,
    text: STAFFING_ALERT_TEXT,
  });
});

test("Filialbestellungen verwenden nur den abgeleiteten Grabenplaner-No-Reply-Absender", async () => {
  let mail;
  const adapter = createExternalNotificationAdapter({
    configuration: { email: enabledSmtp("branch_order") },
    smtpTransport: {
      async sendMail(value) {
        mail = value;
        return { accepted: true };
      },
    },
  });

  await adapter.sendBranchOrder({
    sender: "fil18-noreply@grabenplaner.eu",
    recipient: "lager@example.test",
    replyTo: "fil18@example.test",
    subject: "Filialbestellung",
    text: "Testbestellung",
  });
  assert.equal(mail.from, "fil18-noreply@grabenplaner.eu");
  assert.equal(mail.replyTo, "fil18@example.test");
  await assert.rejects(
    adapter.sendBranchOrder({
      sender: "frei-waehlbar@example.test",
      recipient: "lager@example.test",
      replyTo: "fil18@example.test",
      subject: "Filialbestellung",
      text: "Testbestellung",
    }),
    { code: "EXTERNAL_NOTIFICATION_SENDER_INVALID" },
  );
});

test("Leihbelege werden nur per SMTP und als PDF-Anhang versendet", async () => {
  let mail;
  const pdf = Buffer.from("%PDF-1.7\nTest");
  const adapter = createExternalNotificationAdapter({
    configuration: {
      email: enabledSmtp("loan_document"),
    },
    smtpTransport: {
      async sendMail(value) {
        mail = value;
        return { accepted: true };
      },
    },
  });

  const delivered = await adapter.sendLoanDocument({
    recipient: "belege@example.test",
    subject: "Grabenplaner · Ausgabebeleg",
    text: "Der Beleg ist beigefügt.",
    filename: "Leihbeleg-Ausgabe.pdf",
    buffer: pdf,
  });

  assert.deepEqual(delivered, { delivered: true, channel: "email" });
  assert.equal(mail.to, "belege@example.test");
  assert.equal(mail.subject, "Grabenplaner · Ausgabebeleg");
  assert.equal(mail.attachments.length, 1);
  assert.equal(mail.attachments[0].filename, "Leihbeleg-Ausgabe.pdf");
  assert.equal(mail.attachments[0].contentType, "application/pdf");
  assert.deepEqual(mail.attachments[0].content, pdf);
});

test("Leihbelege verwenden keinen E-Mail-Webhook und begrenzen die Anhanggröße", async () => {
  const adapter = createExternalNotificationAdapter({
    configuration: {
      emailWebhook: {
        enabled: true,
        url: "https://notify.example.test/email",
      },
    },
    fetchImplementation: async () => ({ ok: true }),
  });
  await assert.rejects(
    adapter.sendLoanDocument({
      recipient: "belege@example.test",
      buffer: Buffer.from("%PDF"),
    }),
    { code: "EXTERNAL_NOTIFICATION_SMTP_REQUIRED" },
  );
  await assert.rejects(
    adapter.sendLoanDocument({
      recipient: "belege@example.test",
      buffer: Buffer.alloc((8 * 1024 * 1024) + 1),
    }),
    { code: "EXTERNAL_NOTIFICATION_ATTACHMENT_INVALID" },
  );
});

test("SMTP wird bei fehlender Konfiguration nicht geladen", () => {
  let loads = 0;
  const adapter = createExternalNotificationAdapter({
    configuration: {},
    loadSmtpModule: () => { loads += 1; throw new Error("should not load"); },
  });
  assert.equal(loads, 0);
  assert.equal(adapter.getProviderStatus().email.configured, false);
  assert.equal(adapter.getProviderStatus().email.available, false);
});

test("E-Mail-HTTPS-Fallback erscheint im Provider-Status als betriebsbereit", () => {
  const adapter = createExternalNotificationAdapter({
    configuration: {
      emailWebhook: enabledWebhook("email", "staffing_warning", { token: "email-webhook-secret" }),
    },
    fetchImplementation: async () => ({ ok: true }),
  });
  assert.deepEqual(adapter.getProviderStatus().email, {
    configured: true,
    valid: true,
    available: true,
    transport: "https-webhook",
    provider: "https-webhook",
    dispatchEnabled: true,
    senderApproved: true,
    enabledEvents: ["staffing_warning"],
    issueCode: null,
  });
});

test("E-Mail-HTTPS-Fallback sendet einen datensparsamen Payload mit Secret-Header", async () => {
  const calls = [];
  const adapter = createExternalNotificationAdapter({
    configuration: {
      emailWebhook: enabledWebhook("email", "staffing_warning", { token: "email-webhook-secret" }),
    },
    fetchImplementation: async (url, options) => {
      calls.push({ url, options });
      return { ok: true };
    },
  });
  await adapter.sendStaffingAlert({
    channel: "email",
    recipient: "leitung@example.test",
    employeeNumber: "252",
    employeeName: "Darf nicht übertragen werden",
    illness: "Darf nicht übertragen werden",
    message: "Darf nicht übertragen werden",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://notify.example.test/email");
  assert.equal(calls[0].options.headers.authorization, "Bearer email-webhook-secret");
  assert.equal(calls[0].options.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    event: "staffing_warning",
    channel: "email",
    sender: "Grabenplaner <app@example.test>",
    recipient: "leitung@example.test",
    message: STAFFING_ALERT_TEXT,
  });
  assert.doesNotMatch(calls[0].options.body, /252|Darf nicht|illness|employee/i);
});

test("E-Mail-HTTPS-Fallback bereinigt Transportfehler vollständig", async () => {
  const secret = "email-webhook-ultra-secret";
  const recipient = "leitung@example.test";
  const adapter = createExternalNotificationAdapter({
    configuration: {
      emailWebhook: enabledWebhook("email", "staffing_warning", { token: secret }),
    },
    fetchImplementation: async () => {
      throw new Error(`Webhook rejected ${secret} for ${recipient}`);
    },
  });

  await assert.rejects(
    adapter.sendStaffingAlert({ channel: "email", recipient }),
    (error) => error.code === "EXTERNAL_NOTIFICATION_DELIVERY_FAILED"
      && error.message === "Die E-Mail-Benachrichtigung konnte nicht zugestellt werden."
      && !error.stack.includes(secret)
      && !error.stack.includes(recipient),
  );
});

test("Fehlendes optionales SMTP-Paket wird nur als neutraler Provider-Status gemeldet", async () => {
  const adapter = createExternalNotificationAdapter({
    configuration: { email: enabledSmtp("staffing_warning") },
    loadSmtpModule: () => { throw new Error(`Cannot find ${SMTP_OPTIONAL_PACKAGE} with smtp-secret`); },
  });
  assert.equal(adapter.getProviderStatus().email.available, false);
  assert.equal(adapter.getProviderStatus().email.issueCode, "optional_package_missing_or_transport_unavailable");
  await assert.rejects(
    adapter.sendStaffingAlert({ channel: "email", recipient: "leitung@example.test" }),
    (error) => error.code === "EXTERNAL_NOTIFICATION_PROVIDER_NOT_CONFIGURED"
      && !/smtp-secret|leitung@example/.test(error.message),
  );
});

test("Transportfehler geben weder Geheimnisse noch Empfänger zurück", async () => {
  const adapter = createExternalNotificationAdapter({
    configuration: { sms: enabledWebhook("sms", "staffing_warning", { token: "ultra-secret" }) },
    fetchImplementation: async () => { throw new Error("ultra-secret for +431234567"); },
  });
  await assert.rejects(
    adapter.sendStaffingAlert({ channel: "sms", recipient: "+431234567" }),
    (error) => error.code === "EXTERNAL_NOTIFICATION_DELIVERY_FAILED"
      && !/ultra-secret|431234567/.test(`${error.message} ${error.stack}`),
  );
});

test("Harte Zeitüberschreitung bricht Webhooks ab", async () => {
  let aborted = false;
  const adapter = createExternalNotificationAdapter({
    timeoutMs: 20,
    configuration: { whatsapp: enabledWebhook("whatsapp", "staffing_warning") },
    fetchImplementation: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("internal destination must stay hidden"));
      }, { once: true });
    }),
  });
  await assert.rejects(
    adapter.sendStaffingAlert({ channel: "whatsapp", recipient: "+439876543" }),
    { code: "EXTERNAL_NOTIFICATION_TIMEOUT" },
  );
  assert.equal(aborted, true);
});

test("Harte Zeitüberschreitung beendet auch einen hängenden SMTP-Transport", async () => {
  let closed = false;
  const adapter = createExternalNotificationAdapter({
    timeoutMs: 20,
    configuration: { email: enabledSmtp("staffing_warning") },
    smtpTransport: {
      sendMail: async () => new Promise(() => {}),
      close() { closed = true; },
    },
  });
  await assert.rejects(
    adapter.sendStaffingAlert({ channel: "email", recipient: "leitung@example.test" }),
    { code: "EXTERNAL_NOTIFICATION_TIMEOUT" },
  );
  assert.equal(closed, true);
});
