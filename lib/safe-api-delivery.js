"use strict";

const crypto = require("node:crypto");
const dns = require("node:dns");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REQUEST_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_DNS_ADDRESSES = 32;
const MAX_CANONICAL_DEPTH = 50;

const DEFAULT_ALLOWED_HEADERS = new Set([
  "accept",
  "authorization",
  "content-type",
  "idempotency-key",
  "user-agent",
  "x-api-key",
  "x-client-id",
  "x-request-id",
]);

const FORBIDDEN_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "forwarded",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

const BLOCKED_HOSTNAMES = new Set([
  "instance-data",
  "instance-data.ec2.internal",
  "localhost",
  "metadata",
  "metadata.aws.internal",
  "metadata.azure.internal",
  "metadata.google.internal",
]);

const BLOCKED_IPV4_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

const BLOCKED_IPV6_CIDRS = [
  "::/96",
  "::1/128",
  "::ffff:0:0/96",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
];

class SafeApiDeliveryError extends Error {
  constructor(message, code, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "SafeApiDeliveryError";
    this.code = code;
  }
}

function deliveryError(message, code, cause = null) {
  return new SafeApiDeliveryError(message, code, cause);
}

function normalizePositiveInteger(value, fallback, minimum, maximum, code) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw deliveryError("Die Sicherheitsgrenze der API-Auslieferung ist ungültig.", code);
  }
  return number;
}

function validateApiEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(String(value || "").trim());
  } catch (error) {
    throw deliveryError("Die API-Adresse ist ungültig.", "API_DELIVERY_URL_INVALID", error);
  }
  if (endpoint.protocol !== "https:") {
    throw deliveryError("Für API-Auslieferungen ist ausschließlich HTTPS zulässig.", "API_DELIVERY_HTTPS_REQUIRED");
  }
  if (endpoint.username || endpoint.password) {
    throw deliveryError("Zugangsdaten dürfen nicht Bestandteil der API-Adresse sein.", "API_DELIVERY_URL_CREDENTIALS_FORBIDDEN");
  }
  if (endpoint.hash) {
    throw deliveryError("Fragmente sind in API-Adressen nicht zulässig.", "API_DELIVERY_URL_FRAGMENT_FORBIDDEN");
  }
  const hostname = endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")
    || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw deliveryError("Dieses API-Ziel ist aus Sicherheitsgründen nicht zulässig.", "API_DELIVERY_HOST_BLOCKED");
  }
  return endpoint;
}

function endpointHostname(endpoint) {
  return String(endpoint?.hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function parseIp(value) {
  const address = String(value || "").trim().replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  const version = net.isIP(address);
  if (version === 4) {
    return {
      address,
      version,
      bits: 32,
      value: address.split(".").reduce((result, part) => (result << 8n) + BigInt(Number(part)), 0n),
    };
  }
  if (version !== 6) return null;
  let ipv6 = address;
  if (ipv6.includes(".")) {
    const separator = ipv6.lastIndexOf(":");
    const ipv4 = parseIp(ipv6.slice(separator + 1));
    if (!ipv4 || ipv4.version !== 4) return null;
    const high = Number((ipv4.value >> 16n) & 0xffffn).toString(16);
    const low = Number(ipv4.value & 0xffffn).toString(16);
    ipv6 = `${ipv6.slice(0, separator)}:${high}:${low}`;
  }
  const halves = ipv6.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const words = [...left, ...Array(missing).fill("0"), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return null;
  return {
    address,
    version,
    bits: 128,
    value: words.reduce((result, word) => (result << 16n) + BigInt(parseInt(word, 16)), 0n),
  };
}

function ipMatchesCidr(parsedIp, cidr) {
  const [networkText, prefixText] = cidr.split("/");
  const network = parseIp(networkText);
  const prefix = Number(prefixText);
  if (!parsedIp || !network || parsedIp.version !== network.version || !Number.isInteger(prefix)
    || prefix < 0 || prefix > parsedIp.bits) return false;
  if (prefix === 0) return true;
  const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(parsedIp.bits - prefix);
  return (parsedIp.value & mask) === (network.value & mask);
}

function isBlockedApiAddress(value) {
  const parsed = parseIp(value);
  if (!parsed) return true;
  const ranges = parsed.version === 4 ? BLOCKED_IPV4_CIDRS : BLOCKED_IPV6_CIDRS;
  return ranges.some((cidr) => ipMatchesCidr(parsed, cidr));
}

function normalizeDnsResults(results) {
  const entries = Array.isArray(results) ? results : [results];
  if (!entries.length || entries.length > MAX_DNS_ADDRESSES) {
    throw deliveryError("Das API-Ziel konnte nicht eindeutig aufgelöst werden.", "API_DELIVERY_DNS_RESULT_INVALID");
  }
  const normalized = [];
  for (const entry of entries) {
    const address = String(typeof entry === "string" ? entry : entry?.address || "").trim();
    const family = net.isIP(address);
    if (!family || (entry?.family && Number(entry.family) !== family && String(entry.family).toLowerCase() !== `ipv${family}`.toLowerCase())) {
      throw deliveryError("Das API-Ziel lieferte eine ungültige Netzwerkadresse.", "API_DELIVERY_DNS_RESULT_INVALID");
    }
    if (isBlockedApiAddress(address)) {
      throw deliveryError("Das API-Ziel verweist auf ein gesperrtes Netzwerk.", "API_DELIVERY_ADDRESS_BLOCKED");
    }
    if (!normalized.some((item) => item.address === address && item.family === family)) normalized.push({ address, family });
  }
  if (!normalized.length) {
    throw deliveryError("Das API-Ziel konnte nicht aufgelöst werden.", "API_DELIVERY_DNS_EMPTY");
  }
  return normalized;
}

async function defaultDnsResolver(hostname) {
  return dns.promises.lookup(hostname, { all: true, order: "verbatim" });
}

async function resolveApiEndpoint(endpoint, resolver = defaultDnsResolver) {
  const hostname = endpointHostname(endpoint);
  const ipFamily = net.isIP(hostname);
  if (ipFamily) return normalizeDnsResults([{ address: hostname, family: ipFamily }]);
  let results;
  try {
    results = await resolver(hostname);
  } catch (error) {
    if (error instanceof SafeApiDeliveryError) throw error;
    throw deliveryError("Das API-Ziel konnte nicht sicher aufgelöst werden.", "API_DELIVERY_DNS_FAILED", error);
  }
  return normalizeDnsResults(results);
}

function normalizeAllowedHeaders(value) {
  if (value !== undefined && !Array.isArray(value) && !(value instanceof Set)) {
    throw deliveryError("Die Header-Allowlist ist ungültig.", "API_DELIVERY_HEADER_ALLOWLIST_INVALID");
  }
  const submitted = value === undefined ? DEFAULT_ALLOWED_HEADERS : new Set(value);
  const result = new Set();
  for (const item of submitted) {
    const name = String(item || "").trim().toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || FORBIDDEN_HEADERS.has(name)) {
      throw deliveryError("Die Header-Allowlist ist ungültig.", "API_DELIVERY_HEADER_ALLOWLIST_INVALID");
    }
    result.add(name);
  }
  return result;
}

function normalizeDeliveryHeaders(value = {}, options = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw deliveryError("Die API-Header sind ungültig.", "API_DELIVERY_HEADERS_INVALID");
  }
  const allowed = normalizeAllowedHeaders(options.allowedHeaders);
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = String(rawName || "").trim().toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || FORBIDDEN_HEADERS.has(name) || !allowed.has(name)) {
      throw deliveryError("Dieser API-Header ist nicht zulässig.", "API_DELIVERY_HEADER_FORBIDDEN");
    }
    if (Array.isArray(rawValue) || rawValue === null || rawValue === undefined) {
      throw deliveryError("Der Wert eines API-Headers ist ungültig.", "API_DELIVERY_HEADER_VALUE_INVALID");
    }
    const headerValue = String(rawValue);
    if (!headerValue || headerValue.length > 4096 || /[\r\n\0]/.test(headerValue)) {
      throw deliveryError("Der Wert eines API-Headers ist ungültig.", "API_DELIVERY_HEADER_VALUE_INVALID");
    }
    headers[name] = headerValue;
  }
  return headers;
}

function canonicalize(value, state, depth = 0) {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw deliveryError("Die API-Nutzdaten sind zu tief verschachtelt.", "API_DELIVERY_PAYLOAD_INVALID");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw deliveryError("Die API-Nutzdaten enthalten eine ungültige Zahl.", "API_DELIVERY_PAYLOAD_INVALID");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw deliveryError("Die API-Nutzdaten enthalten einen nicht unterstützten Wert.", "API_DELIVERY_PAYLOAD_INVALID");
  }
  if (state.seen.has(value)) {
    throw deliveryError("Die API-Nutzdaten enthalten einen Kreisbezug.", "API_DELIVERY_PAYLOAD_INVALID");
  }
  state.seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, state, depth + 1));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw deliveryError("Die API-Nutzdaten enthalten ein nicht unterstütztes Objekt.", "API_DELIVERY_PAYLOAD_INVALID");
    }
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) {
        throw deliveryError("Die API-Nutzdaten enthalten einen nicht definierten Wert.", "API_DELIVERY_PAYLOAD_INVALID");
      }
      result[key] = canonicalize(value[key], state, depth + 1);
    }
    return result;
  } finally {
    state.seen.delete(value);
  }
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value, { seen: new Set() }));
}

function prepareJsonPayload(payload, maxBytes = DEFAULT_MAX_REQUEST_BYTES) {
  const body = Buffer.from(canonicalJson(payload), "utf8");
  if (!body.length || body.length > maxBytes) {
    body.fill(0);
    throw deliveryError("Die API-Nutzdaten überschreiten die zulässige Größe.", "API_DELIVERY_REQUEST_TOO_LARGE");
  }
  return {
    body,
    sha256: crypto.createHash("sha256").update(body).digest("hex"),
  };
}

function payloadSha256(payload) {
  return crypto.createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

function createIdempotencyKey(input = {}) {
  const normalized = {
    schemaVersion: String(input.schemaVersion || "grabenplaner-payroll-api-v1").trim(),
    connectorId: String(input.connectorId || "").trim(),
    profileId: String(input.profileId || "").trim(),
    fingerprint: String(input.fingerprint || "").trim(),
    scope: String(input.scope || "").trim(),
  };
  if (!normalized.schemaVersion || !normalized.connectorId || !normalized.profileId || !normalized.fingerprint
    || Object.values(normalized).some((value) => value.length > 256)) {
    throw deliveryError("Die Idempotenzangaben sind unvollständig.", "API_DELIVERY_IDEMPOTENCY_INPUT_INVALID");
  }
  const digest = crypto.createHash("sha256").update(canonicalJson(normalized), "utf8").digest("base64url");
  return `gp-${digest}`;
}

function validateIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(key)) {
    throw deliveryError("Die Idempotenzkennung ist ungültig.", "API_DELIVERY_IDEMPOTENCY_KEY_INVALID");
  }
  return key;
}

function pinnedLookup(address) {
  return (_hostname, options, callback) => {
    const actualOptions = typeof options === "object" && options ? options : {};
    const done = typeof options === "function" ? options : callback;
    if (typeof done !== "function") throw new TypeError("lookup callback required");
    if (actualOptions.all) done(null, [{ address: address.address, family: address.family }]);
    else done(null, address.address, address.family);
  };
}

function performPinnedHttpsRequest({ requestOptions, body, timeoutMs, maxResponseBytes, requestFactory = https.request }) {
  return new Promise((resolve, reject) => {
    let request;
    let response = null;
    let settled = false;
    let responseBytes = 0;
    const responseHash = crypto.createHash("sha256");
    const startedAt = Date.now();

    const finish = (error, result = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ ...result, durationMs: Math.max(0, Date.now() - startedAt) });
    };

    const timer = setTimeout(() => {
      const error = deliveryError("Die API-Auslieferung hat das Zeitlimit überschritten.", "API_DELIVERY_TIMEOUT");
      finish(error);
      try { response?.destroy?.(); } catch {}
      try { request?.destroy?.(error); } catch {}
    }, timeoutMs);

    try {
      request = requestFactory(requestOptions, (incoming) => {
        response = incoming;
        const statusCode = Number(incoming.statusCode || 0);
        if (statusCode >= 300 && statusCode < 400) {
          finish(deliveryError("Weiterleitungen sind bei API-Auslieferungen nicht zulässig.", "API_DELIVERY_REDIRECT_REJECTED"));
          try { incoming.resume?.(); } catch {}
          return;
        }
        incoming.on("data", (chunk) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          responseBytes += buffer.length;
          if (responseBytes > maxResponseBytes) {
            const error = deliveryError("Die Antwort des API-Ziels ist zu groß.", "API_DELIVERY_RESPONSE_TOO_LARGE");
            finish(error);
            try { incoming.destroy?.(); } catch {}
            try { request.destroy?.(error); } catch {}
            return;
          }
          responseHash.update(buffer);
        });
        incoming.on("error", (error) => {
          if (error instanceof SafeApiDeliveryError) finish(error);
          else finish(deliveryError("Die Antwort des API-Ziels konnte nicht sicher gelesen werden.", "API_DELIVERY_NETWORK_ERROR", error));
        });
        incoming.on("end", () => finish(null, {
          ok: statusCode >= 200 && statusCode < 300,
          statusCode,
          responseBytes,
          responseSha256: responseHash.digest("hex"),
        }));
      });
      request.once("error", (error) => {
        if (error instanceof SafeApiDeliveryError) finish(error);
        else finish(deliveryError("Das API-Ziel konnte nicht sicher erreicht werden.", "API_DELIVERY_NETWORK_ERROR", error));
      });
      request.write(body);
      request.end();
    } catch (error) {
      if (error instanceof SafeApiDeliveryError) finish(error);
      else finish(deliveryError("Das API-Ziel konnte nicht sicher erreicht werden.", "API_DELIVERY_NETWORK_ERROR", error));
    }
  });
}

function performPinnedTlsProbe({ endpoint, address, timeoutMs, tlsFactory = tls.connect }) {
  return new Promise((resolve, reject) => {
    const hostname = endpointHostname(endpoint);
    const startedAt = Date.now();
    let socket = null;
    let settled = false;

    const finish = (error, result = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ ...result, durationMs: Math.max(0, Date.now() - startedAt) });
    };

    const timer = setTimeout(() => {
      const error = deliveryError("Die sichere TLS-Prüfung hat das Zeitlimit überschritten.", "API_PROBE_TIMEOUT");
      finish(error);
      try { socket?.destroy?.(error); } catch {}
    }, timeoutMs);

    const tlsOptions = {
      host: address.address,
      port: Number(endpoint.port || 443),
      family: address.family,
      ...(net.isIP(hostname) ? {} : { servername: hostname }),
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    };

    try {
      socket = tlsFactory(tlsOptions);
      if (!socket || typeof socket.once !== "function") {
        throw new TypeError("TLS socket required");
      }
      socket.once("secureConnect", () => {
        if (socket.authorized !== true) {
          const error = deliveryError("Das TLS-Zertifikat des API-Ziels wurde abgelehnt.", "API_PROBE_CERTIFICATE_REJECTED");
          finish(error);
          try { socket.destroy?.(error); } catch {}
          return;
        }
        const protocol = String(socket.getProtocol?.() || "");
        if (protocol && !["TLSv1.2", "TLSv1.3"].includes(protocol)) {
          const error = deliveryError("Das API-Ziel verwendet keine ausreichend sichere TLS-Version.", "API_PROBE_TLS_VERSION_REJECTED");
          finish(error);
          try { socket.destroy?.(error); } catch {}
          return;
        }
        finish(null, { ok: true, tlsProtocol: protocol || null });
        try { socket.destroy?.(); } catch {}
      });
      socket.once("error", (error) => {
        if (error instanceof SafeApiDeliveryError) finish(error);
        else finish(deliveryError("Der sichere TLS-Handshake mit dem API-Ziel ist fehlgeschlagen.", "API_PROBE_TLS_FAILED", error));
      });
    } catch (error) {
      if (error instanceof SafeApiDeliveryError) finish(error);
      else finish(deliveryError("Der sichere TLS-Handshake mit dem API-Ziel ist fehlgeschlagen.", "API_PROBE_TLS_FAILED", error));
    }
  });
}

function withTimeout(promise, timeoutMs, message, code) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(deliveryError(message, code)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function createSafeApiDelivery(options = {}) {
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 10, 120_000, "API_DELIVERY_TIMEOUT_INVALID");
  const maxRequestBytes = normalizePositiveInteger(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, 1, 16 * 1024 * 1024, "API_DELIVERY_REQUEST_LIMIT_INVALID");
  const maxResponseBytes = normalizePositiveInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 0, 1024 * 1024, "API_DELIVERY_RESPONSE_LIMIT_INVALID");
  const dnsResolver = options.dnsResolver || defaultDnsResolver;
  const requestFactory = options.requestFactory || https.request;
  const tlsFactory = options.tlsFactory || tls.connect;
  const allowedHeaders = options.allowedHeaders;

  async function probe(input = {}) {
    const endpoint = validateApiEndpoint(input.url);
    const addresses = await withTimeout(
      resolveApiEndpoint(endpoint, dnsResolver),
      timeoutMs,
      "Die DNS-Prüfung des API-Ziels hat das Zeitlimit überschritten.",
      "API_DELIVERY_DNS_TIMEOUT",
    );
    const selectedAddress = addresses[0];
    const result = await performPinnedTlsProbe({
      endpoint,
      address: selectedAddress,
      timeoutMs,
      tlsFactory,
    });
    return Object.freeze({
      ...result,
      pinnedAddressFamily: selectedAddress.family,
    });
  }

  async function deliver(input = {}) {
    const endpoint = validateApiEndpoint(input.url);
    const prepared = prepareJsonPayload(input.payload, maxRequestBytes);
    let requestHeaders;
    try {
      requestHeaders = normalizeDeliveryHeaders(input.headers || {}, { allowedHeaders });
      requestHeaders.accept = requestHeaders.accept || "application/json";
      requestHeaders["content-type"] = "application/json; charset=utf-8";
      if (input.idempotencyKey !== undefined) requestHeaders["idempotency-key"] = validateIdempotencyKey(input.idempotencyKey);
      const addresses = await withTimeout(
        resolveApiEndpoint(endpoint, dnsResolver),
        timeoutMs,
        "Die DNS-Prüfung des API-Ziels hat das Zeitlimit überschritten.",
        "API_DELIVERY_DNS_TIMEOUT",
      );
      const selectedAddress = addresses[0];
      const hostname = endpointHostname(endpoint);
      requestHeaders["content-length"] = String(prepared.body.length);
      const requestOptions = {
        protocol: "https:",
        hostname,
        port: endpoint.port || 443,
        path: `${endpoint.pathname}${endpoint.search}`,
        method: "POST",
        headers: requestHeaders,
        lookup: pinnedLookup(selectedAddress),
        ...(net.isIP(hostname) ? {} : { servername: hostname }),
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
      };
      const result = await performPinnedHttpsRequest({
        requestOptions,
        body: prepared.body,
        timeoutMs,
        maxResponseBytes,
        requestFactory,
      });
      return Object.freeze({
        ...result,
        payloadSha256: prepared.sha256,
        pinnedAddressFamily: selectedAddress.family,
      });
    } finally {
      prepared.body.fill(0);
      if (requestHeaders) {
        for (const name of Object.keys(requestHeaders)) requestHeaders[name] = "";
      }
    }
  }

  return Object.freeze({ deliver, probe });
}

module.exports = {
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  SafeApiDeliveryError,
  canonicalJson,
  createIdempotencyKey,
  createSafeApiDelivery,
  isBlockedApiAddress,
  normalizeDeliveryHeaders,
  payloadSha256,
  performPinnedHttpsRequest,
  performPinnedTlsProbe,
  prepareJsonPayload,
  resolveApiEndpoint,
  validateApiEndpoint,
};
