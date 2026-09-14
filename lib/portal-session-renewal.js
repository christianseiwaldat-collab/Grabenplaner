'use strict';

// Rights and expiry are read afresh for every request. Only the optional expiry
// write is coalesced, so parallel page resources do not queue identical writes.
function createPortalSessionRenewal() {
  const pending = new Map();
  return async function renew({ session, kind, now, expiresAt, timeoutMinutes, write }) {
    const expires = Date.parse(session.expires_at);
    const next = Date.parse(expiresAt);
    const interval = Math.min(60000, Number(timeoutMinutes) * 60000 / 4);
    if (!Number.isFinite(expires) || expires <= now || next - expires < interval) return session.expires_at;
    const key = kind + ':' + session.id;
    if (!pending.has(key)) {
      const job = Promise.resolve().then(() => write({ id: session.id, expiresAt }))
        .then(() => expiresAt).finally(() => pending.delete(key));
      pending.set(key, job);
    }
    try { return await pending.get(key); }
    catch (error) {
      // A still-valid session may finish a request without extending its life.
      // An expired or revoked session is rejected by the fresh database lookup.
      if (!['PERSISTENCE_BUSY', 'PERSISTENCE_TIMEOUT', 'PERSISTENCE_CONNECTION_UNAVAILABLE'].includes(error?.code)) throw error;
      return session.expires_at;
    }
  };
}
module.exports = { createPortalSessionRenewal };
