"use strict";

const { createHash } = require("node:crypto");

const SETTING_KEY = "portal_location_functions_v1";
const FUNCTIONS = Object.freeze({
  scheduleRead: "schedule:read",
  scheduleWrite: "schedule:write",
  vacationPlanning: "absence_entries:write",
  branchOrders: "branch_orders:manage",
  locationSettings: "locations:operational:write",
});

function normalizeAccess(value, activeLocations = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !Object.hasOwn(FUNCTIONS, key))) {
    throw new TypeError("Bitte gültige Rechte je Funktion und Filiale übermitteln.");
  }
  const access = {};
  for (const feature of Object.keys(FUNCTIONS)) {
    if (!Object.hasOwn(value, feature)) continue;
    const selection = value[feature];
    if (feature === "vacationPlanning" && selection === "all") {
      access[feature] = selection;
      continue;
    }
    if (!Array.isArray(selection) || selection.length > 100
      || selection.some(id => typeof id !== "string" || !/^[0-9]{2}$/.test(id)
        || (activeLocations && !activeLocations.has(id)))) {
      throw new TypeError("Bitte je Funktion gültige aktive Filialen auswählen.");
    }
    access[feature] = [...new Set(selection)].sort();
  }
  if (Object.hasOwn(access, "scheduleRead") !== Object.hasOwn(access, "scheduleWrite")
    || access.scheduleWrite?.some(id => !access.scheduleRead.includes(id))) {
    throw new TypeError("Jede Filiale mit Dienstplan-Bearbeitung benötigt auch Leserecht.");
  }
  return access;
}

function readAssignments(rows) {
  const stored = rows.find(row => row.key === SETTING_KEY);
  const assignments = new Map();
  if (!stored) return assignments;
  const records = JSON.parse(stored.value);
  if (!records || typeof records !== "object" || Array.isArray(records)) {
    throw new TypeError("Die hinterlegten Filialrechte sind ungültig.");
  }
  for (const [employeeNumber, access] of Object.entries(records)) {
    assignments.set(employeeNumber, normalizeAccess(access));
  }
  return assignments;
}

function revision(access) {
  return createHash("sha256").update(JSON.stringify(access)).digest("hex");
}

function activeLocationIds(selection, locations) {
  return locations.filter(location => Boolean(Number(location.active))
    && (selection === "all" || selection.includes(String(location.id)))).map(location => String(location.id));
}

function actorForFeature(actor, access, feature, locations) {
  if (!Object.hasOwn(access, feature)) return null;
  const selected = activeLocationIds(access[feature], locations);
  const permissions = new Set([...(actor.permissions || []), FUNCTIONS[feature]]);
  if (feature === "scheduleWrite") permissions.add(FUNCTIONS.scheduleRead);
  return {
    ...actor,
    locationFunction: feature,
    scopes: selected.map(locationId => ({ locationId, departmentId: null })),
    permissions: [...permissions],
  };
}

function planningFeatureForRoute(path, method) {
  const read = ["GET", "HEAD", "OPTIONS"].includes(method);
  if (/^\/vacations(?:-preview\.pdf|\.pdf)?(?:\/|$)/i.test(path)) return "vacationPlanning";
  if (/^\/(?:schedule(?:-preview\.pdf|\.pdf|-note)?|shifts|week-options|global-day-blocks)(?:\/|$)/i.test(path)) {
    return read ? "scheduleRead" : "scheduleWrite";
  }
  if (method === "PUT" && /^\/locations\/[^/]+\/?$/i.test(path)) return "locationSettings";
  return null;
}

module.exports = { SETTING_KEY, activeLocationIds, actorForFeature, normalizeAccess, planningFeatureForRoute, readAssignments, revision };
