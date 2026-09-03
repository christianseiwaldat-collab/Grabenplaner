"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Startmarker fehlt: ${start}`);
  assert.notEqual(endIndex, -1, `Endmarker fehlt: ${end}`);
  return source.slice(startIndex, endIndex);
}

function route(method, routePath, nextMarker) {
  return between(server, `app.${method}("${routePath}"`, nextMarker);
}

test("CRM-Routen erzwingen getrennte Lese-/Schreibrechte und CSRF für jede Mutation", () => {
  const context = between(server, "function crmEmployeeSession", "function crmCustomerId");
  assert.match(context, /requireEmployeePortalSession\(request, permission\)/);
  assert.match(context, /buildCrmProjection\(session\)/);
  assert.match(context, /permission === CRM_PERMISSIONS\.ACCESS[\s\S]*projection\.workspace/);
  assert.match(context, /permission === CRM_PERMISSIONS\.CUSTOMERS_READ[\s\S]*projection\.read/);
  assert.match(context, /permission === CRM_PERMISSIONS\.CUSTOMERS_WRITE[\s\S]*projection\.write/);
  assert.match(context, /if \(!allowed\)[\s\S]*PORTAL_PERMISSION_DENIED/);
  assert.match(context, /if \(write\) assertPortalCsrf\(request\)/);

  const preferencesGet = route("get", "/api/crm/preferences", 'app.put("/api/crm/preferences"');
  assert.match(preferencesGet, /CRM_PERMISSIONS\.ACCESS/);

  const preferencesPut = route("put", "/api/crm/preferences", 'app.get("/api/crm/customers"');
  assert.match(preferencesPut, /CRM_PERMISSIONS\.ACCESS, \{ write: true \}/);

  const search = route("get", "/api/crm/customers", 'app.get("/api/crm/customers/:id"');
  assert.match(search, /CRM_PERMISSIONS\.CUSTOMERS_READ/);

  const detail = route("get", "/api/crm/customers/:id", 'app.post("/api/crm/customers"');
  assert.match(detail, /CRM_PERMISSIONS\.CUSTOMERS_READ/);

  const create = route("post", "/api/crm/customers", 'app.put("/api/crm/customers/:id"');
  assert.match(create, /CRM_PERMISSIONS\.CUSTOMERS_WRITE, \{ write: true \}/);

  const update = route("put", "/api/crm/customers/:id", 'app.get("/api/crm/customers/:id/photo"');
  assert.match(update, /CRM_PERMISSIONS\.CUSTOMERS_WRITE, \{ write: true \}/);

  const photoGet = route("get", "/api/crm/customers/:id/photo", 'app.put("/api/crm/customers/:id/photo"');
  assert.match(photoGet, /CRM_PERMISSIONS\.CUSTOMERS_READ/);

  const photoPut = route("put", "/api/crm/customers/:id/photo", 'app.delete("/api/crm/customers/:id/photo"');
  assert.match(photoPut, /CRM_PERMISSIONS\.CUSTOMERS_WRITE, \{ write: true \}/);

  const photoDelete = route("delete", "/api/crm/customers/:id/photo", "const SYSTEM_CENTER_UPDATE_CACHE_MS");
  assert.match(photoDelete, /CRM_PERMISSIONS\.CUSTOMERS_WRITE, \{ write: true \}/);
});

test("CRM-Suche verlangt query und übernimmt nur normalisierte Serverwerte", () => {
  const search = route("get", "/api/crm/customers", 'app.get("/api/crm/customers/:id"');
  assert.match(search, /normalizeCrmCustomerSearch\(\{/);
  for (const parameter of ["query", "customerType", "sort", "direction", "limit", "offset"]) {
    assert.match(search, new RegExp(`${parameter}: request\\.query\\?\\.${parameter}`));
    assert.match(search, new RegExp(`${parameter}: search\\.${parameter}`));
  }
  assert.doesNotMatch(search, /SELECT|ORDER BY|LIMIT\s+\$\{|request\.query[^\n]+(?:SELECT|ORDER BY)/i);
});

test("CRM-Antworten sind privat, nicht cachebar und Konflikte werden als 409 gemeldet", () => {
  const headers = between(server, "function setCrmPrivateHeaders", "function crmEmployeeSession");
  assert.match(headers, /"Cache-Control": "private, no-store, max-age=0"/);
  assert.match(headers, /Pragma: "no-cache"/);
  assert.match(headers, /"X-Content-Type-Options": "nosniff"/);

  const errors = between(server, "function crmRouteError", "async function crmPreferencesForActor");
  assert.match(errors, /isUniquePersistenceViolation\(error\)[\s\S]*409[\s\S]*"CRM_CUSTOMER_CONFLICT"/);
  assert.match(errors, /PERSISTENCE_RETRYABLE_TRANSACTION[\s\S]*409[\s\S]*"CRM_CUSTOMER_REVISION_CONFLICT"/);

  const update = route("put", "/api/crm/customers/:id", 'app.get("/api/crm/customers/:id/photo"');
  assert.match(update, /normalizeCrmCustomerInput\(request\.body \|\| \{\}, \{ update: true \}\)/);
  assert.match(update, /expectedRevision/);
});

test("CRM-Spaltenpräferenzen bleiben strikt beim angemeldeten Account", () => {
  const readPreferences = between(server, "async function crmPreferencesForActor", 'app.get("/api/crm/preferences"');
  assert.match(readPreferences, /uiPreferencesRepository\.get\(actor\.employeeNumber, CRM_PREFERENCE_KEYS\.COLUMNS\)/);
  assert.match(readPreferences, /uiPreferencesRepository\.get\(actor\.employeeNumber, CRM_PREFERENCE_KEYS\.SORT\)/);
  assert.doesNotMatch(readPreferences, /request\.|employeeNumber\s*:/);

  const writePreferences = route("put", "/api/crm/preferences", 'app.get("/api/crm/customers"');
  assert.match(writePreferences, /uiPreferencesRepository\.saveChanges\(actor\.employeeNumber/);
  assert.match(writePreferences, /JSON\.stringify\(preferences\.columns\)/);
  assert.match(writePreferences, /JSON\.stringify\(preferences\.sort\)/);
  assert.doesNotMatch(writePreferences, /request\.body\?\.employeeNumber|request\.body\.employeeNumber/);
});

test("Kundenfotos werden begrenzt, geprüft, neu gerendert und nur als Metadaten referenziert", () => {
  const multipart = between(server, "function parseCrmPhotoMultipart", "function sessionPortalAccessScopeProjection");
  assert.match(multipart, /MAX_CANDIDATE_PHOTO_INPUT_BYTES/);
  assert.match(multipart, /name !== "photo"/);
  assert.match(multipart, /CRM_PHOTO_TOO_LARGE/);
  assert.match(multipart, /CRM_PHOTO_TOO_MANY_FILES/);

  const photoPut = route("put", "/api/crm/customers/:id/photo", 'app.delete("/api/crm/customers/:id/photo"');
  assert.match(photoPut, /storage\.scanBuffer\(\{/);
  assert.match(photoPut, /prepareCandidatePhoto\(\{/);
  assert.match(photoPut, /storage\.saveBuffer\(\{/);
  assert.match(photoPut, /crmCustomersRepository\.replacePhoto\(\{[\s\S]*storageKey:[\s\S]*contentSha256:[\s\S]*byteSize:[\s\S]*mediaType:/);
  assert.doesNotMatch(photoPut, /crmCustomersRepository\.replacePhoto\(\{[\s\S]*?buffer:/);

  const photoGet = route("get", "/api/crm/customers/:id/photo", 'app.put("/api/crm/customers/:id/photo"');
  assert.match(photoGet, /readBuffer\(\{[\s\S]*sha256: photo\.contentSha256/);
  assert.match(photoGet, /"Content-Type": "image\/jpeg"/);
  assert.match(photoGet, /CRM_PHOTO_INTEGRITY_FAILED/);
});
