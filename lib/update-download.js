"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const tls = require("node:tls");

const MAX_UPDATE_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const UPDATE_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
let systemCertificateAuthoritiesConfigured = false;

function configureSystemCertificateAuthorities() {
  if (systemCertificateAuthoritiesConfigured || process.platform !== "win32") return systemCertificateAuthoritiesConfigured;
  if (typeof tls.getCACertificates !== "function" || typeof tls.setDefaultCACertificates !== "function") return false;
  const certificates = [...new Set([
    ...tls.getCACertificates("default"),
    ...tls.getCACertificates("system"),
  ])];
  if (!certificates.length) return false;
  tls.setDefaultCACertificates(certificates);
  systemCertificateAuthoritiesConfigured = true;
  return true;
}

function updateDownloadError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function trustedGitHubAssetUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    throw updateDownloadError("UPDATE_ASSET_URL_INVALID", "Die Release-Adresse ist ungültig.");
  }
  const hostname = parsed.hostname.toLowerCase();
  const trustedHost = hostname === "github.com" || hostname.endsWith(".githubusercontent.com");
  if (parsed.protocol !== "https:" || !trustedHost || parsed.username || parsed.password) {
    throw updateDownloadError("UPDATE_ASSET_URL_UNTRUSTED", "Die Release-Adresse stammt nicht von einem erlaubten GitHub-Host.");
  }
  return parsed;
}

function portableAssetFileName(rawName) {
  const name = String(rawName || "").trim();
  if (!name || name !== path.basename(name) || !/windows-portable\.zip$/i.test(name)) {
    throw updateDownloadError("UPDATE_ASSET_NAME_INVALID", "Das erwartete Windows-Portable-ZIP wurde nicht gefunden.");
  }
  return name;
}

function expectedSha256(rawDigest) {
  if (!rawDigest) return "";
  const match = String(rawDigest).trim().match(/^sha256:([a-f0-9]{64})$/i);
  if (!match) throw updateDownloadError("UPDATE_ASSET_DIGEST_INVALID", "Die von GitHub gemeldete Prüfsumme ist ungültig.");
  return match[1].toLowerCase();
}

function expectedByteSize(rawSize, maximumBytes = MAX_UPDATE_DOWNLOAD_BYTES) {
  if (rawSize === undefined || rawSize === null || rawSize === "") return 0;
  const size = Number(rawSize);
  if (!Number.isSafeInteger(size) || size <= 0 || size > maximumBytes) {
    throw updateDownloadError("UPDATE_ASSET_SIZE_INVALID", "Die von GitHub gemeldete Dateigröße ist ungültig.");
  }
  return size;
}

async function downloadGitHubReleaseAsset({
  asset,
  destinationDirectory,
  userAgent = "Grabenplaner-Updater",
  fetchImpl = globalThis.fetch,
  maximumBytes = MAX_UPDATE_DOWNLOAD_BYTES,
  timeoutMs = UPDATE_DOWNLOAD_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw updateDownloadError("UPDATE_FETCH_UNAVAILABLE", "HTTPS-Downloads sind in dieser Laufzeit nicht verfügbar.");
  }
  const fileName = portableAssetFileName(asset?.name);
  const sourceUrl = trustedGitHubAssetUrl(asset?.url);
  const declaredSize = expectedByteSize(asset?.size, maximumBytes);
  const declaredSha256 = expectedSha256(asset?.digest);
  fs.mkdirSync(destinationDirectory, { recursive: true });
  const targetPath = path.join(destinationDirectory, fileName);
  const partialPath = `${targetPath}.part`;
  fs.rmSync(partialPath, { force: true });
  fs.rmSync(targetPath, { force: true });

  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  let response;
  try {
    if (fetchImpl === globalThis.fetch) configureSystemCertificateAuthorities();
    response = await fetchImpl(sourceUrl, {
      headers: {
        Accept: "application/octet-stream",
        "User-Agent": userAgent,
      },
      redirect: "follow",
      signal: timeoutController.signal,
    });
    if (!response?.ok || !response.body) {
      throw updateDownloadError("UPDATE_DOWNLOAD_HTTP_FAILED", `GitHub-Download fehlgeschlagen (HTTP ${response?.status || 0}).`);
    }
    trustedGitHubAssetUrl(response.url || sourceUrl.href);
    const responseLength = expectedByteSize(response.headers?.get?.("content-length"), maximumBytes);
    if (declaredSize && responseLength && declaredSize !== responseLength) {
      throw updateDownloadError("UPDATE_ASSET_SIZE_MISMATCH", "GitHub meldet widersprüchliche Dateigrößen für das Update.");
    }

    let byteSize = 0;
    const hash = crypto.createHash("sha256");
    const verifier = new Transform({
      transform(chunk, _encoding, callback) {
        byteSize += chunk.length;
        if (byteSize > maximumBytes) {
          callback(updateDownloadError("UPDATE_DOWNLOAD_TOO_LARGE", "Das Update überschreitet die zulässige Maximalgröße."));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), verifier, fs.createWriteStream(partialPath, { flags: "wx" }));
    const sha256 = hash.digest("hex");
    if (declaredSize && byteSize !== declaredSize) {
      throw updateDownloadError("UPDATE_ASSET_SIZE_MISMATCH", "Die geladene Update-Datei hat nicht die erwartete Größe.");
    }
    if (declaredSha256 && sha256 !== declaredSha256) {
      throw updateDownloadError("UPDATE_ASSET_INTEGRITY_FAILED", "Die SHA-256-Prüfsumme des Updates stimmt nicht mit GitHub überein.");
    }
    if (byteSize <= 0) throw updateDownloadError("UPDATE_DOWNLOAD_EMPTY", "Die geladene Update-Datei ist leer.");
    fs.renameSync(partialPath, targetPath);
    return {
      fileName,
      filePath: targetPath,
      byteSize,
      sha256,
      integritySource: declaredSha256 ? "github-sha256" : "download-sha256",
      sourceUrl: sourceUrl.href,
      finalUrl: response.url || sourceUrl.href,
    };
  } catch (error) {
    fs.rmSync(partialPath, { force: true });
    fs.rmSync(targetPath, { force: true });
    if (error?.name === "AbortError") {
      throw updateDownloadError("UPDATE_DOWNLOAD_TIMEOUT", "Der GitHub-Download hat zu lange gedauert.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  MAX_UPDATE_DOWNLOAD_BYTES,
  UPDATE_DOWNLOAD_TIMEOUT_MS,
  configureSystemCertificateAuthorities,
  downloadGitHubReleaseAsset,
  expectedByteSize,
  expectedSha256,
  portableAssetFileName,
  trustedGitHubAssetUrl,
};
