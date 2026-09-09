'use strict';

const sharp = require('sharp');
const https = require('node:https');
const net = require('node:net');
const { validateApiEndpoint, resolveApiEndpoint, SafeApiDeliveryError } = require('./safe-api-delivery');

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_EDGE = 1280;
class SalesArticleImageError extends Error {
  constructor(message, code, status = 400) { super(message); this.code = code; this.status = status; }
}
const fail = (message, code, status) => { throw new SalesArticleImageError(message, code, status); };

// Reject document/vector decoders before handing untrusted bytes to the image library.
function rasterSignature(buffer) {
  return buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    || buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP');
}
async function prepareSalesArticleImage(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) fail('Bitte eine Bilddatei auswählen.', 'ARTICLE_IMAGE_EMPTY');
  if (buffer.length > MAX_INPUT_BYTES) fail('Das Bild darf höchstens 10 MB groß sein.', 'ARTICLE_IMAGE_TOO_LARGE', 413);
  if (!rasterSignature(buffer)) fail('Bitte ein JPG-, PNG- oder WebP-Bild verwenden.', 'ARTICLE_IMAGE_FORMAT', 415);
  try {
    const source = sharp(buffer, { failOn: 'warning', limitInputPixels: 24_000_000 });
    const metadata = await source.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages || 1) !== 1) {
      fail('Bitte ein einzelnes JPG-, PNG- oder WebP-Bild verwenden.', 'ARTICLE_IMAGE_FORMAT', 415);
    }
    let rendered;
    for (const [edge, quality] of [[MAX_EDGE, 84], [MAX_EDGE, 72], [960, 68], [768, 60]]) {
      rendered = await source.clone().rotate().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .webp({ quality }).timeout({ seconds: 10 }).toBuffer({ resolveWithObject: true });
      if (rendered.data.length <= MAX_OUTPUT_BYTES) break;
    }
    if (rendered.data.length > MAX_OUTPUT_BYTES) fail('Das Bild lässt sich nicht ausreichend verkleinern.', 'ARTICLE_IMAGE_TOO_LARGE', 413);
    return { buffer: rendered.data, width: rendered.info.width, height: rendered.info.height, mime: 'image/webp' };
  } catch (error) {
    if (error instanceof SalesArticleImageError) throw error;
    fail('Die Bilddatei ist beschädigt, zu groß aufgelöst oder nicht lesbar.', 'ARTICLE_IMAGE_INVALID', 415);
  }
}

function imageEndpoint(value) {
  if (typeof value !== 'string' || value.length > 4000) fail('Bitte eine direkte HTTPS-Bildadresse eingeben.', 'ARTICLE_IMAGE_URL');
  const endpoint = validateApiEndpoint(value);
  if (endpoint.port && endpoint.port !== '443') fail('Die Bildadresse muss den normalen HTTPS-Port verwenden.', 'ARTICLE_IMAGE_URL');
  return endpoint;
}
function requestImage(endpoint, address, { requestFactory, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let request, incoming, settled = false, bytes = 0;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value);
      // Also stop rejected/redirected bodies; do not drain an unbounded response.
      incoming?.destroy(); request?.destroy();
    };
    const timer = setTimeout(() => finish(new SalesArticleImageError('Die Bildadresse antwortet zu langsam.', 'ARTICLE_IMAGE_TIMEOUT', 504)), timeoutMs);
    const hostname = endpoint.hostname.replace(/^\[|\]$/g, '');
    const options = {
      protocol: 'https:', hostname, port: 443, path: endpoint.pathname + endpoint.search, method: 'GET', agent: false,
      headers: { accept: 'image/jpeg,image/png,image/webp', 'accept-encoding': 'identity', 'user-agent': 'Grabenplaner-Artikelbild/1.0' },
      lookup(_host, opts, callback) {
        const done = typeof opts === 'function' ? opts : callback;
        if (opts?.all) done(null, [address]); else done(null, address.address, address.family);
      },
      ...(net.isIP(hostname) ? {} : { servername: hostname }), rejectUnauthorized: true, minVersion: 'TLSv1.2',
    };
    try {
      request = requestFactory(options, response => {
        incoming = response;
        response.on('error', () => finish(new SalesArticleImageError('Das Bild konnte nicht vollständig geladen werden.', 'ARTICLE_IMAGE_DOWNLOAD', 502)));
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          finish(null, { redirect: response.headers.location }); return;
        }
        const mime = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (response.statusCode !== 200) { finish(new SalesArticleImageError('Unter dieser Adresse ist kein Bild erreichbar.', 'ARTICLE_IMAGE_DOWNLOAD', 502)); return; }
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime) || !['', 'identity'].includes(String(response.headers['content-encoding'] || '').toLowerCase())) {
          finish(new SalesArticleImageError('Die Adresse muss direkt auf ein JPG-, PNG- oder WebP-Bild zeigen.', 'ARTICLE_IMAGE_FORMAT', 415)); return;
        }
        if (Number(response.headers['content-length']) > MAX_INPUT_BYTES) { finish(new SalesArticleImageError('Das Bild darf höchstens 10 MB groß sein.', 'ARTICLE_IMAGE_TOO_LARGE', 413)); return; }
        response.on('data', chunk => {
          if (settled) return;
          const part = Buffer.from(chunk); bytes += part.length;
          if (bytes > MAX_INPUT_BYTES) { finish(new SalesArticleImageError('Das Bild darf höchstens 10 MB groß sein.', 'ARTICLE_IMAGE_TOO_LARGE', 413)); return; }
          chunks.push(part);
        });
        response.on('end', () => finish(null, { buffer: Buffer.concat(chunks) }));
        response.on('aborted', () => finish(new SalesArticleImageError('Die Bildübertragung wurde unterbrochen.', 'ARTICLE_IMAGE_DOWNLOAD', 502)));
      });
      request.on('error', () => finish(new SalesArticleImageError('Das Bild konnte nicht sicher geladen werden.', 'ARTICLE_IMAGE_DOWNLOAD', 502)));
      request.end();
    } catch { finish(new SalesArticleImageError('Das Bild konnte nicht geladen werden.', 'ARTICLE_IMAGE_DOWNLOAD', 502)); }
  });
}
async function fetchSalesArticleImage(value, { dnsResolver, requestFactory = https.request, timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  try {
    let endpoint = imageEndpoint(value);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const remaining = () => Math.max(1, deadline - Date.now());
      let timer;
      const addresses = await Promise.race([
        resolveApiEndpoint(endpoint, dnsResolver),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new SalesArticleImageError('Die Bildadresse antwortet zu langsam.', 'ARTICLE_IMAGE_TIMEOUT', 504)), remaining()); }),
      ]).finally(() => clearTimeout(timer));
      if (Date.now() >= deadline) fail('Die Bildadresse antwortet zu langsam.', 'ARTICLE_IMAGE_TIMEOUT', 504);
      const result = await requestImage(endpoint, addresses[0], { requestFactory, timeoutMs: remaining() });
      if (result.buffer) return result.buffer;
      if (!result.redirect || redirects === 3) fail('Die Bildadresse leitet zu oft oder ungültig weiter.', 'ARTICLE_IMAGE_REDIRECT');
      endpoint = imageEndpoint(new URL(result.redirect, endpoint).href);
    }
  } catch (error) {
    if (error instanceof SalesArticleImageError) throw error;
    if (error instanceof SafeApiDeliveryError) fail('Bitte eine öffentlich erreichbare HTTPS-Bildadresse ohne Zugangsdaten verwenden.', 'ARTICLE_IMAGE_URL');
    fail('Die Bildadresse konnte nicht geladen werden.', 'ARTICLE_IMAGE_DOWNLOAD', 502);
  }
}
module.exports = { MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, MAX_EDGE, SalesArticleImageError, prepareSalesArticleImage, fetchSalesArticleImage };
