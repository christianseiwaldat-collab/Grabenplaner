"use strict";

const crypto = require("node:crypto");

class IntegrationCacheError extends Error {
  constructor(message, code = "INTEGRATION_SESSION_INVALID", status = 404) {
    super(message);
    this.name = "IntegrationCacheError";
    this.code = code;
    this.status = status;
  }
}

class IntegrationCache {
  constructor(options = {}) {
    this.ttlMs = Math.max(60_000, Number(options.ttlMs || 15 * 60_000));
    this.maxEntries = Math.max(1, Number(options.maxEntries || 25));
    this.maxEntriesPerActor = Math.max(1, Number(options.maxEntriesPerActor || 5));
    this.entries = new Map();
  }

  prune(now = Date.now()) {
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        if (entry.timer) clearTimeout(entry.timer);
        this.entries.delete(id);
      }
    }
  }

  create(actor, kind, value) {
    this.prune();
    const normalizedActor = String(actor || "");
    const actorEntries = [...this.entries.values()].filter((entry) => entry.actor === normalizedActor);
    if (this.entries.size >= this.maxEntries || actorEntries.length >= this.maxEntriesPerActor) {
      throw new IntegrationCacheError("Bitte einen bestehenden Import abschlie\u00dfen oder verwerfen, bevor ein weiterer gestartet wird.", "INTEGRATION_SESSION_LIMIT", 429);
    }
    const id = crypto.randomUUID();
    const expiresAt = Date.now() + this.ttlMs;
    const entry = { id, actor: normalizedActor, kind: String(kind), value, expiresAt, consumed: false, timer: null };
    entry.timer = setTimeout(() => {
      if (this.entries.get(id) === entry) this.entries.delete(id);
    }, this.ttlMs);
    entry.timer.unref?.();
    this.entries.set(id, entry);
    return { id, expiresAt: new Date(expiresAt).toISOString() };
  }

  get(id, actor, expectedKind = "") {
    this.prune();
    const entry = this.entries.get(String(id || ""));
    if (!entry || entry.consumed || entry.actor !== String(actor || "") || (expectedKind && entry.kind !== expectedKind)) {
      throw new IntegrationCacheError("Die Importvorschau ist abgelaufen. Bitte die Datei erneut pr\u00fcfen.", "INTEGRATION_SESSION_EXPIRED", 410);
    }
    return entry;
  }

  consume(id, actor, expectedKind = "") {
    const entry = this.get(id, actor, expectedKind);
    entry.consumed = true;
    if (entry.timer) clearTimeout(entry.timer);
    this.entries.delete(entry.id);
    return entry.value;
  }

  delete(id, actor) {
    const entry = this.entries.get(String(id || ""));
    if (!entry || entry.actor !== String(actor || "")) return false;
    if (entry.timer) clearTimeout(entry.timer);
    return this.entries.delete(entry.id);
  }

  deleteKind(actor, kind) {
    const normalizedActor = String(actor || "");
    const normalizedKind = String(kind || "");
    let deleted = 0;
    for (const [id, entry] of this.entries) {
      if (entry.actor === normalizedActor && entry.kind === normalizedKind) {
        if (entry.timer) clearTimeout(entry.timer);
        this.entries.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  clear() {
    for (const entry of this.entries.values()) if (entry.timer) clearTimeout(entry.timer);
    this.entries.clear();
  }
}

module.exports = { IntegrationCache, IntegrationCacheError };
