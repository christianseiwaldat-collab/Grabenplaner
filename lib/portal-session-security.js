"use strict";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PRIVILEGED_ROLES = Object.freeze(["developer", "admin", "it_admin"]);
// Administrative capability grants count even when the role name is ordinary.
const PRIVILEGED_PERMISSIONS = Object.freeze([
  "*", "rights:write", "users:write", "portal_users:write", "roles:write",
  "settings:write", "backup:write", "system:write", "system:offsite:configure",
  "system:recovery:run", "system:diagnostics:technical", "security_audits:manage",
]);

function instant(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : NaN;
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value !== "string") return NaN;
  // Legacy SQLite CURRENT_TIMESTAMP is UTC, never browser/host local time.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(" ", "T") + ".000Z" : value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(normalized)) return NaN;
  const result = Date.parse(normalized);
  if (!Number.isFinite(result)) return NaN;
  return new Date(result).toISOString().replace(".000Z", "Z") === normalized.replace(".000Z", "Z") ? result : NaN;
}

function invalidTime() {
  return Object.assign(new Error("Sitzung ist abgelaufen oder hat ungültige Zeitgrenzen."), { code: "PORTAL_SESSION_TIME_INVALID" });
}

function isPrivilegedSession({ role = "", permissions = [] } = {}) {
  return PRIVILEGED_ROLES.includes(role)
    || (Array.isArray(permissions) && permissions.some(permission => PRIVILEGED_PERMISSIONS.includes(permission)));
}

function browserSessionLifetime({ now = new Date(), role, permissions, idleMinutes = 480, authenticatedAt, absoluteExpiresAt } = {}) {
  const current = instant(now), privileged = isPrivilegedSession({ role, permissions });
  const configured = Number(idleMinutes);
  const idle = privileged ? 30 : Math.min(1440, Math.max(15, Number.isFinite(configured) ? configured : 480));
  const renewing = authenticatedAt !== undefined || absoluteExpiresAt !== undefined;
  const origin = renewing ? instant(authenticatedAt) : current;
  const policyEnd = origin + (privileged ? 8 : 12) * HOUR;
  const absolute = renewing ? Math.min(instant(absoluteExpiresAt), policyEnd) : policyEnd;
  if (![current, origin, absolute].every(Number.isFinite) || origin > current || absolute <= current || absolute <= origin) return null;
  return Object.freeze({
    authenticatedAt: new Date(origin).toISOString(),
    absoluteExpiresAt: new Date(absolute).toISOString(),
    expiresAt: new Date(Math.min(current + idle * 60000, absolute)).toISOString(),
    idleMinutes: idle,
    privileged,
  });
}

function clampMobileAccessExpiry(now, refreshExpiresAt) {
  const current = instant(now), absolute = instant(refreshExpiresAt);
  if (![current, absolute].every(Number.isFinite) || absolute <= current) throw invalidTime();
  return new Date(Math.min(current + 15 * 60000, absolute)).toISOString();
}

function mobileSessionLifetime({ now = new Date(), role, permissions } = {}) {
  const current = instant(now);
  if (!Number.isFinite(current)) throw invalidTime();
  const privileged = isPrivilegedSession({ role, permissions });
  const refreshExpiresAt = new Date(current + (privileged ? 8 * HOUR : 30 * DAY)).toISOString();
  return Object.freeze({ authenticatedAt: new Date(current).toISOString(), refreshExpiresAt,
    accessExpiresAt: clampMobileAccessExpiry(current, refreshExpiresAt), privileged, idleMinutes: privileged ? 30 : null });
}

function isSessionTimeValid(session, now = new Date()) {
  const values = [now, session?.authenticated_at, session?.expires_at, session?.absolute_expires_at].map(instant);
  const [current, origin, idle, absolute] = values;
  return values.every(Number.isFinite) && origin <= current && origin < absolute && current < idle && current < absolute;
}

module.exports = { PRIVILEGED_ROLES, PRIVILEGED_PERMISSIONS, instant, isPrivilegedSession,
  browserSessionLifetime, mobileSessionLifetime, clampMobileAccessExpiry, isSessionTimeValid };
