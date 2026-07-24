"use strict";

const https = require("node:https");
const net = require("node:net");
const {
  SafeApiDeliveryError,
  resolveApiEndpoint,
  validateApiEndpoint,
} = require("./safe-api-delivery");

const ARTICLE_NUMBER_PATTERN = /^\d{6}$/;
const BARCODE_LENGTHS = new Set([8, 12, 13, 14]);
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;

class ArticleCatalogError extends Error {
  constructor(message, code, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "ArticleCatalogError";
    this.code = code;
  }
}

function catalogError(message, code, cause = null) {
  return new ArticleCatalogError(message, code, cause);
}

function normalizeArticleNumber(value) {
  const articleNumber = String(value ?? "").trim();
  if (!ARTICLE_NUMBER_PATTERN.test(articleNumber)) {
    throw catalogError(
      "Die Artikelnummer muss genau aus sechs Ziffern bestehen.",
      "ARTICLE_NUMBER_INVALID",
    );
  }
  return articleNumber;
}

function hasValidGtinChecksum(value) {
  const digits = String(value || "");
  if (!/^\d+$/.test(digits) || !BARCODE_LENGTHS.has(digits.length)) return false;
  const checkDigit = Number(digits.at(-1));
  let sum = 0;
  for (let index = digits.length - 2, position = 0; index >= 0; index -= 1, position += 1) {
    sum += Number(digits[index]) * (position % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === checkDigit;
}

function barcodeType(value) {
  const length = String(value || "").length;
  if (length === 8) return "ean8";
  if (length === 12) return "upca";
  if (length === 13) return "ean13";
  return "gtin14";
}

function normalizeArticleIdentifier(value) {
  const identifier = String(value ?? "").trim();
  if (ARTICLE_NUMBER_PATTERN.test(identifier)) {
    return Object.freeze({ type: "internal", value: identifier });
  }
  if (!/^\d+$/.test(identifier) || !BARCODE_LENGTHS.has(identifier.length)) {
    throw catalogError(
      "Bitte eine sechsstellige Artikelnummer oder einen gültigen EAN-/GTIN-Barcode eingeben.",
      "ARTICLE_IDENTIFIER_INVALID",
    );
  }
  if (!hasValidGtinChecksum(identifier)) {
    throw catalogError(
      "Die Prüfziffer des EAN-/GTIN-Barcodes ist ungültig.",
      "ARTICLE_IDENTIFIER_CHECKSUM_INVALID",
    );
  }
  return Object.freeze({ type: barcodeType(identifier), value: identifier });
}

function decodeHtmlEntities(value) {
  const named = {
    amp: "&",
    apos: "'",
    quot: "\"",
    lt: "<",
    gt: ">",
    nbsp: " ",
    auml: "ä",
    Auml: "Ä",
    ouml: "ö",
    Ouml: "Ö",
    uuml: "ü",
    Uuml: "Ü",
    szlig: "ß",
  };
  return String(value || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity.startsWith("#x")) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      return Number.isInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    if (entity.startsWith("#")) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    return Object.hasOwn(named, entity) ? named[entity] : match;
  });
}

function plainHtmlText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function storefrontBaseUrl(value) {
  let endpoint;
  try {
    endpoint = validateApiEndpoint(value);
  } catch (error) {
    if (error instanceof SafeApiDeliveryError) {
      throw catalogError(
        "Die Adresse der Artikelsuche ist nicht zulässig. Bitte eine öffentliche HTTPS-Shopadresse verwenden.",
        "ARTICLE_LOOKUP_URL_INVALID",
        error,
      );
    }
    throw error;
  }
  endpoint.search = "";
  endpoint.hash = "";
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "") || "/";
  return endpoint;
}

function shopwareSuggestUrl(baseUrl, identifier) {
  const normalized = normalizeArticleIdentifier(identifier);
  const base = storefrontBaseUrl(baseUrl);
  const basePath = base.pathname === "/" ? "" : base.pathname;
  base.pathname = `${basePath}/suggest`;
  base.searchParams.set("search", normalized.value);
  return base;
}

function candidateProductNumber(block, href) {
  const altMatch = String(block || "").match(/\balt\s*=\s*["'](\d{6,20})["']/i);
  if (altMatch) return altMatch[1];
  try {
    const lastSegment = new URL(href).pathname.split("/").filter(Boolean).at(-1) || "";
    return /^\d{6,20}$/.test(lastSegment) ? lastSegment : "";
  } catch {
    return "";
  }
}

function candidateMatchesArticle(productNumber, articleNumber) {
  return /^\d{6,20}$/.test(productNumber)
    && productNumber.slice(-6) === articleNumber;
}

function parseShopwareSuggestHtml(html, identifier, baseUrl) {
  const normalized = normalizeArticleIdentifier(identifier);
  const source = storefrontBaseUrl(baseUrl);
  const blocks = String(html || "").split(/<li\b/i).slice(1);
  for (const fragment of blocks) {
    const block = fragment.split(/<\/li\s*>/i, 1)[0] || "";
    if (!/\bsearch-suggest-product\b/i.test(block)) continue;
    const anchor = block.match(/<a\b([^>]*)>/i);
    if (!anchor) continue;
    const hrefMatch = anchor[1].match(/\bhref\s*=\s*["']([^"']+)["']/i);
    const titleMatch = anchor[1].match(/\btitle\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    let productUrl;
    try {
      productUrl = new URL(decodeHtmlEntities(hrefMatch[1]), source);
    } catch {
      continue;
    }
    if (productUrl.origin !== source.origin) continue;
    const sourceProductNumber = candidateProductNumber(block, productUrl.href);
    if (!sourceProductNumber) continue;
    const articleNumber = sourceProductNumber.slice(-6);
    if (!ARTICLE_NUMBER_PATTERN.test(articleNumber)) continue;
    if (normalized.type === "internal"
      && !candidateMatchesArticle(sourceProductNumber, normalized.value)) continue;
    const nameMatch = block.match(/<div\b[^>]*class\s*=\s*["'][^"']*\bsearch-suggest-product-name\b[^"']*["'][^>]*>([\s\S]*?)<\/div\s*>/i);
    const description = plainHtmlText(titleMatch?.[1] || nameMatch?.[1] || "");
    if (!description) continue;
    return Object.freeze({
      articleNumber,
      description: description.slice(0, 300),
      sourceProvider: "shopware_storefront",
      sourceProductNumber,
      sourceUrl: productUrl.href,
    });
  }
  return null;
}

function parseShopwareProductBarcode(html) {
  const source = String(html || "");
  const candidates = [
    source.match(/<meta\b[^>]*\bitemprop\s*=\s*["']gtin(?:8|12|13|14)?["'][^>]*\bcontent\s*=\s*["'](\d{8,14})["'][^>]*>/i)?.[1],
    source.match(/<meta\b[^>]*\bcontent\s*=\s*["'](\d{8,14})["'][^>]*\bitemprop\s*=\s*["']gtin(?:8|12|13|14)?["'][^>]*>/i)?.[1],
    source.match(/["']productEAN["']\s*:\s*["'](\d{8,14})["']/i)?.[1],
    source.match(/\bitemprop\s*=\s*["']gtin["'][^>]*>\s*(\d{8,14})\s*</i)?.[1],
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const normalized = normalizeArticleIdentifier(candidate);
      if (normalized.type !== "internal") return normalized;
    } catch {}
  }
  return null;
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

function requestHtml(endpoint, address, options = {}) {
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const maxResponseBytes = Number(options.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES);
  const requestFactory = options.requestFactory || https.request;
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    let response;
    const chunks = [];
    let responseBytes = 0;
    const finish = (error, result = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      const error = catalogError("Die externe Artikelsuche hat zu lange gedauert.", "ARTICLE_LOOKUP_TIMEOUT");
      finish(error);
      try { response?.destroy?.(); } catch {}
      try { request?.destroy?.(error); } catch {}
    }, timeoutMs);
    const hostname = endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const requestOptions = {
      protocol: "https:",
      hostname,
      port: endpoint.port || 443,
      path: `${endpoint.pathname}${endpoint.search}`,
      method: "GET",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": "de-AT,de;q=0.9",
        "user-agent": "Grabenplaner-Artikelabgleich/1.0",
      },
      lookup: pinnedLookup(address),
      ...(net.isIP(hostname) ? {} : { servername: hostname }),
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    };
    try {
      request = requestFactory(requestOptions, (incoming) => {
        response = incoming;
        const statusCode = Number(incoming.statusCode || 0);
        if (statusCode >= 300 && statusCode < 400) {
          finish(catalogError(
            "Weiterleitungen sind bei der Artikelsuche nicht zulässig.",
            "ARTICLE_LOOKUP_REDIRECT_REJECTED",
          ));
          incoming.resume();
          return;
        }
        if (statusCode !== 200) {
          finish(catalogError(
            "Der externe Artikelkatalog ist derzeit nicht erreichbar.",
            "ARTICLE_LOOKUP_HTTP_ERROR",
          ));
          incoming.resume();
          return;
        }
        const contentType = String(incoming.headers["content-type"] || "").toLowerCase();
        if (!contentType.includes("text/html")) {
          finish(catalogError(
            "Der externe Artikelkatalog hat ein unerwartetes Antwortformat geliefert.",
            "ARTICLE_LOOKUP_CONTENT_TYPE_INVALID",
          ));
          incoming.resume();
          return;
        }
        incoming.on("data", (chunk) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          responseBytes += buffer.length;
          if (responseBytes > maxResponseBytes) {
            const error = catalogError(
              "Die Antwort der Artikelsuche ist zu groß.",
              "ARTICLE_LOOKUP_RESPONSE_TOO_LARGE",
            );
            finish(error);
            incoming.destroy(error);
            request.destroy(error);
            return;
          }
          chunks.push(buffer);
        });
        incoming.once("error", (error) => finish(catalogError(
          "Die Antwort der Artikelsuche konnte nicht gelesen werden.",
          "ARTICLE_LOOKUP_NETWORK_ERROR",
          error,
        )));
        incoming.once("end", () => finish(null, Buffer.concat(chunks).toString("utf8")));
      });
      request.once("error", (error) => finish(error instanceof ArticleCatalogError
        ? error
        : catalogError(
          "Der externe Artikelkatalog konnte nicht sicher erreicht werden.",
          "ARTICLE_LOOKUP_NETWORK_ERROR",
          error,
        )));
      request.end();
    } catch (error) {
      finish(error instanceof ArticleCatalogError
        ? error
        : catalogError(
          "Der externe Artikelkatalog konnte nicht sicher erreicht werden.",
          "ARTICLE_LOOKUP_NETWORK_ERROR",
          error,
        ));
    }
  });
}

async function fetchHtmlSafely(endpoint, options = {}) {
  let addresses;
  try {
    addresses = await resolveApiEndpoint(endpoint, options.dnsResolver);
  } catch (error) {
    if (error instanceof SafeApiDeliveryError) {
      throw catalogError(
        "Der externe Artikelkatalog konnte nicht sicher aufgelöst werden.",
        "ARTICLE_LOOKUP_DNS_FAILED",
        error,
      );
    }
    throw error;
  }
  return requestHtml(endpoint, addresses[0], options);
}

async function fetchShopwareArticle(baseUrl, identifier, options = {}) {
  const normalized = normalizeArticleIdentifier(identifier);
  const endpoint = shopwareSuggestUrl(baseUrl, normalized.value);
  const html = await fetchHtmlSafely(endpoint, options);
  const article = parseShopwareSuggestHtml(html, normalized.value, endpoint.origin);
  if (!article) {
    throw catalogError(
      "Zu dieser Artikelnummer oder EAN wurde im verbundenen Shop kein eindeutiger Artikel gefunden.",
      "ARTICLE_LOOKUP_NOT_FOUND",
    );
  }
  if (normalized.type === "internal") return article;

  const productEndpoint = storefrontBaseUrl(article.sourceUrl);
  if (productEndpoint.origin !== endpoint.origin) {
    throw catalogError(
      "Der gefundene Artikel verweist auf eine unerwartete Shopadresse.",
      "ARTICLE_LOOKUP_URL_INVALID",
    );
  }
  const productHtml = await fetchHtmlSafely(productEndpoint, options);
  const verifiedBarcode = parseShopwareProductBarcode(productHtml);
  if (!verifiedBarcode || verifiedBarcode.value !== normalized.value) {
    throw catalogError(
      "Der EAN-/GTIN-Barcode konnte am gefundenen Artikel nicht eindeutig bestätigt werden.",
      "ARTICLE_LOOKUP_BARCODE_MISMATCH",
    );
  }
  return Object.freeze({
    ...article,
    barcodeType: verifiedBarcode.type,
    barcode: verifiedBarcode.value,
  });
}

module.exports = {
  ARTICLE_NUMBER_PATTERN,
  ArticleCatalogError,
  barcodeType,
  candidateMatchesArticle,
  fetchShopwareArticle,
  hasValidGtinChecksum,
  normalizeArticleIdentifier,
  normalizeArticleNumber,
  parseShopwareProductBarcode,
  parseShopwareSuggestHtml,
  shopwareSuggestUrl,
  storefrontBaseUrl,
};
