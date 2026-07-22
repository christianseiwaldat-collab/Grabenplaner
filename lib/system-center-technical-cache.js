"use strict";

function normalizeTtl(value, fallback) {
  return Number.isSafeInteger(value) ? Math.max(100, Math.min(value, 30_000)) : fallback;
}

function createSystemCenterTechnicalCache(options = {}) {
  if (typeof options.load !== "function" || typeof options.fingerprint !== "function") {
    throw new TypeError("System-Center-Cache benoetigt Loader und Fingerprint.");
  }
  const ttlMs = normalizeTtl(options.ttlMs, 2_000);
  const now = typeof options.now === "function" ? options.now : Date.now;
  let cached = null;
  let inFlight = null;
  let generation = 0;

  async function read() {
    const fingerprint = String(options.fingerprint());
    const timestamp = Number(now());
    if (cached && cached.fingerprint === fingerprint && cached.expiresAt > timestamp) {
      return cached.value;
    }
    if (inFlight) {
      if (inFlight.fingerprint === fingerprint && inFlight.generation === generation) return inFlight.promise;
      try { await inFlight.promise; } catch {}
      return read();
    }

    const readGeneration = generation;
    const promise = Promise.resolve().then(() => options.load());
    inFlight = { fingerprint, generation: readGeneration, promise };
    try {
      const value = await promise;
      const fingerprintAfterRead = String(options.fingerprint());
      if (generation === readGeneration && fingerprintAfterRead === fingerprint) {
        cached = {
          fingerprint,
          expiresAt: Number(now()) + ttlMs,
          value,
        };
      }
      return value;
    } finally {
      if (inFlight?.promise === promise) inFlight = null;
    }
  }

  function invalidate() {
    generation += 1;
    cached = null;
  }

  return { read, invalidate };
}

module.exports = { createSystemCenterTechnicalCache };
