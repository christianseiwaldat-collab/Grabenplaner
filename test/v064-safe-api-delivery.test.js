"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const test = require("node:test");

const {
  canonicalJson,
  createIdempotencyKey,
  createSafeApiDelivery,
  isBlockedApiAddress,
  normalizeDeliveryHeaders,
  payloadSha256,
  resolveApiEndpoint,
  validateApiEndpoint,
} = require("../lib/safe-api-delivery");

function fakeRequestFactory({ statusCode = 200, chunks = ["ok"], onRequest = null, neverRespond = false } = {}) {
  return (options, callback) => {
    const request = new EventEmitter();
    const written = [];
    request.write = (chunk) => { written.push(Buffer.from(chunk)); return true; };
    request.end = () => {
      onRequest?.({ options: { ...options, headers: { ...options.headers } }, body: Buffer.concat(written) });
      if (neverRespond) return;
      queueMicrotask(() => {
        const response = Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
        response.statusCode = statusCode;
        response.headers = {};
        callback(response);
      });
    };
    request.destroy = (error) => {
      if (error) queueMicrotask(() => request.emit("error", error));
    };
    return request;
  };
}

function fakeTlsFactory({ onConnect = null, authorized = true, protocol = "TLSv1.3", neverSecure = false, error = null } = {}) {
  return (options) => {
    const socket = new EventEmitter();
    socket.authorized = authorized;
    socket.authorizationError = authorized ? null : "CERTIFICATE_VERIFY_FAILED";
    socket.getProtocol = () => protocol;
    socket.destroy = (destroyError) => {
      if (destroyError) queueMicrotask(() => socket.emit("error", destroyError));
    };
    onConnect?.({ options: { ...options }, socket });
    if (error) queueMicrotask(() => socket.emit("error", error));
    else if (!neverSecure) queueMicrotask(() => socket.emit("secureConnect"));
    return socket;
  };
}

test("v0.64 Safe-API: kanonisches JSON, Payload-Hash und Idempotenz sind stabil", () => {
  const first = { rows: [{ minutes: 480, date: "2030-07-01" }], period: { to: "2030-07-31", from: "2030-07-01" } };
  const second = { period: { from: "2030-07-01", to: "2030-07-31" }, rows: [{ date: "2030-07-01", minutes: 480 }] };

  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(payloadSha256(first), payloadSha256(second));
  const key = createIdempotencyKey({ connectorId: "c-1", profileId: "p-1", fingerprint: "abc123", scope: "location:18" });
  assert.equal(key, createIdempotencyKey({ fingerprint: "abc123", scope: "location:18", profileId: "p-1", connectorId: "c-1" }));
  assert.notEqual(key, createIdempotencyKey({ connectorId: "c-1", profileId: "p-1", fingerprint: "changed", scope: "location:18" }));
  assert.match(key, /^gp-[A-Za-z0-9_-]{43}$/);
  assert.throws(() => canonicalJson({ invalid: Number.NaN }), { code: "API_DELIVERY_PAYLOAD_INVALID" });
});

test("v0.64 Safe-API: nur sichere HTTPS-Adressen ohne Credentials oder Fragmente werden akzeptiert", () => {
  assert.equal(validateApiEndpoint("https://api.example.com/v1/payroll?tenant=7").toString(), "https://api.example.com/v1/payroll?tenant=7");
  assert.throws(() => validateApiEndpoint("http://api.example.com/v1"), { code: "API_DELIVERY_HTTPS_REQUIRED" });
  assert.throws(() => validateApiEndpoint("https://user:secret@api.example.com/v1"), { code: "API_DELIVERY_URL_CREDENTIALS_FORBIDDEN" });
  assert.throws(() => validateApiEndpoint("https://api.example.com/v1#secret"), { code: "API_DELIVERY_URL_FRAGMENT_FORBIDDEN" });
  assert.throws(() => validateApiEndpoint("https://localhost/v1"), { code: "API_DELIVERY_HOST_BLOCKED" });
  assert.throws(() => validateApiEndpoint("https://payroll.internal/v1"), { code: "API_DELIVERY_HOST_BLOCKED" });
});

test("v0.64 Safe-API: private, Loopback-, Link-local-, Multicast-, reservierte und Metadata-Ziele sind gesperrt", async () => {
  for (const address of [
    "0.0.0.1", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.1.1",
    "192.168.1.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1",
    "::1", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1", "2002:0a00:0001::1", "3fff::1",
  ]) assert.equal(isBlockedApiAddress(address), true, `${address} muss gesperrt sein`);
  for (const address of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isBlockedApiAddress(address), false, `${address} muss als öffentlich gelten`);
  }

  const endpoint = validateApiEndpoint("https://api.example.test/payroll");
  await assert.rejects(resolveApiEndpoint(endpoint, async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }]), {
    code: "API_DELIVERY_ADDRESS_BLOCKED",
  });
  await assert.rejects(resolveApiEndpoint(endpoint, async () => [{ address: "169.254.169.254", family: 4 }]), {
    code: "API_DELIVERY_ADDRESS_BLOCKED",
  });
  await assert.rejects(resolveApiEndpoint(validateApiEndpoint("https://[::1]/payroll")), {
    code: "API_DELIVERY_ADDRESS_BLOCKED",
  });
});

test("v0.64 Safe-API: Header-Allowlist sperrt Host-, Proxy-, Cookie- und CRLF-Manipulation", () => {
  assert.deepEqual(normalizeDeliveryHeaders({ Authorization: "Bearer secret", "X-Client-Id": "client-7" }), {
    authorization: "Bearer secret",
    "x-client-id": "client-7",
  });
  for (const name of ["Host", "Content-Length", "Proxy-Authorization", "Cookie", "X-Forwarded-For", "Connection"]) {
    assert.throws(() => normalizeDeliveryHeaders({ [name]: "value" }), { code: "API_DELIVERY_HEADER_FORBIDDEN" });
  }
  assert.throws(() => normalizeDeliveryHeaders({ "X-Not-Allowlisted": "value" }), { code: "API_DELIVERY_HEADER_FORBIDDEN" });
  assert.throws(() => normalizeDeliveryHeaders({ Authorization: "Bearer secret\r\nX-Evil: yes" }), { code: "API_DELIVERY_HEADER_VALUE_INVALID" });
});

test("v0.64 Safe-API: DNS wird vollständig geprüft und die freigegebene IP im TLS-Request gepinnt", async () => {
  let captured;
  const delivery = createSafeApiDelivery({
    dnsResolver: async (hostname) => {
      assert.equal(hostname, "api.example.test");
      return [{ address: "93.184.216.34", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }];
    },
    requestFactory: fakeRequestFactory({
      statusCode: 202,
      chunks: ["accepted"],
      onRequest: (request) => { captured = request; },
    }),
  });
  const payload = { schemaVersion: "grabenplaner-payroll-api-v1", rows: [{ personnelNumber: "007", minutes: 480 }] };
  const idempotencyKey = createIdempotencyKey({ connectorId: "c-1", profileId: "p-1", fingerprint: "f-1" });
  const result = await delivery.deliver({
    url: "https://api.example.test/v1/payroll",
    payload,
    idempotencyKey,
    headers: { Authorization: "Bearer test-secret", "X-Client-Id": "grabenplaner" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 202);
  assert.equal(result.payloadSha256, payloadSha256(payload));
  assert.equal(result.pinnedAddressFamily, 4);
  assert.equal(captured.options.hostname, "api.example.test");
  assert.equal(captured.options.servername, "api.example.test");
  assert.equal(captured.options.rejectUnauthorized, true);
  assert.equal(captured.options.minVersion, "TLSv1.2");
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers["idempotency-key"], idempotencyKey);
  assert.equal(captured.body.toString("utf8"), canonicalJson(payload));

  const pinned = await new Promise((resolve, reject) => {
    captured.options.lookup("api.example.test", { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses));
  });
  assert.deepEqual(pinned, [{ address: "93.184.216.34", family: 4 }]);
});

test("v0.64 Safe-API: Probe prüft DNS und gepinntes TLS ohne einen HTTP-Request zu senden", async () => {
  let capturedTls;
  let httpRequests = 0;
  const client = createSafeApiDelivery({
    dnsResolver: async (hostname) => {
      assert.equal(hostname, "api.example.test");
      return [{ address: "93.184.216.34", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }];
    },
    tlsFactory: fakeTlsFactory({ onConnect: (connection) => { capturedTls = connection; } }),
    requestFactory: () => {
      httpRequests += 1;
      throw new Error("probe must not create an HTTP request");
    },
  });

  const result = await client.probe({ url: "https://api.example.test/v1/payroll" });

  assert.equal(result.ok, true);
  assert.equal(result.tlsProtocol, "TLSv1.3");
  assert.equal(result.pinnedAddressFamily, 4);
  assert.equal(httpRequests, 0);
  assert.equal(capturedTls.options.host, "93.184.216.34");
  assert.equal(capturedTls.options.port, 443);
  assert.equal(capturedTls.options.family, 4);
  assert.equal(capturedTls.options.servername, "api.example.test");
  assert.equal(capturedTls.options.rejectUnauthorized, true);
  assert.equal(capturedTls.options.minVersion, "TLSv1.2");
  assert.equal(Object.hasOwn(capturedTls.options, "path"), false);
  assert.equal(Object.hasOwn(capturedTls.options, "method"), false);
  assert.equal(Object.hasOwn(capturedTls.options, "headers"), false);
});

test("v0.64 Safe-API: Probe scheitert geschlossen bei SSRF, Zertifikatsfehlern und Timeout", async () => {
  let tlsConnections = 0;
  const blocked = createSafeApiDelivery({
    dnsResolver: async () => [{ address: "169.254.169.254", family: 4 }],
    tlsFactory: () => { tlsConnections += 1; throw new Error("must not connect"); },
  });
  await assert.rejects(blocked.probe({ url: "https://api.example.test/payroll" }), {
    code: "API_DELIVERY_ADDRESS_BLOCKED",
  });
  assert.equal(tlsConnections, 0);

  const certificateRejected = createSafeApiDelivery({
    dnsResolver: async () => [{ address: "93.184.216.34", family: 4 }],
    tlsFactory: fakeTlsFactory({ authorized: false }),
  });
  await assert.rejects(certificateRejected.probe({ url: "https://api.example.test/payroll" }), {
    code: "API_PROBE_CERTIFICATE_REJECTED",
  });

  const timedOut = createSafeApiDelivery({
    timeoutMs: 10,
    dnsResolver: async () => [{ address: "93.184.216.34", family: 4 }],
    tlsFactory: fakeTlsFactory({ neverSecure: true }),
  });
  await assert.rejects(timedOut.probe({ url: "https://api.example.test/payroll" }), {
    code: "API_PROBE_TIMEOUT",
  });
});

test("v0.64 Safe-API: Redirects sowie Request-, Response- und Zeitlimits scheitern geschlossen", async () => {
  const common = { dnsResolver: async () => [{ address: "93.184.216.34", family: 4 }] };
  const payload = { rows: [{ minutes: 60 }] };

  const redirect = createSafeApiDelivery({ ...common, requestFactory: fakeRequestFactory({ statusCode: 302, chunks: [] }) });
  await assert.rejects(redirect.deliver({ url: "https://api.example.test/send", payload }), {
    code: "API_DELIVERY_REDIRECT_REJECTED",
  });

  const requestLimited = createSafeApiDelivery({ ...common, maxRequestBytes: 16, requestFactory: fakeRequestFactory() });
  await assert.rejects(requestLimited.deliver({ url: "https://api.example.test/send", payload }), {
    code: "API_DELIVERY_REQUEST_TOO_LARGE",
  });

  const responseLimited = createSafeApiDelivery({ ...common, maxResponseBytes: 4, requestFactory: fakeRequestFactory({ chunks: ["12345"] }) });
  await assert.rejects(responseLimited.deliver({ url: "https://api.example.test/send", payload }), {
    code: "API_DELIVERY_RESPONSE_TOO_LARGE",
  });

  const timedOut = createSafeApiDelivery({ ...common, timeoutMs: 15, requestFactory: fakeRequestFactory({ neverRespond: true }) });
  await assert.rejects(timedOut.deliver({ url: "https://api.example.test/send", payload }), {
    code: "API_DELIVERY_TIMEOUT",
  });

  let requestStarted = false;
  const dnsTimedOut = createSafeApiDelivery({
    timeoutMs: 10,
    dnsResolver: async () => new Promise(() => {}),
    requestFactory: fakeRequestFactory({ onRequest: () => { requestStarted = true; } }),
  });
  await assert.rejects(dnsTimedOut.deliver({ url: "https://api.example.test/send", payload }), {
    code: "API_DELIVERY_DNS_TIMEOUT",
  });
  assert.equal(requestStarted, false);
});
