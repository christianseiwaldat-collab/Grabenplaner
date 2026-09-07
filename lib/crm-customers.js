"use strict";

const CRM_CUSTOMER_TYPES = Object.freeze(["private", "business", "unknown"]);
const CRM_CUSTOMER_SORT_KEYS = Object.freeze([
  "accountNumber", "customerNumber", "lastName", "firstName", "customerType", "companyName",
  "postalCode", "city", "country", "phone", "email", "website", "vatId", "birthDate",
]);
const CRM_CUSTOMER_COLUMN_IDS = Object.freeze([
  "photo", "accountNumber", "customerNumber", "name", "customerType", "companyName", "address",
  "postalCode", "city", "country", "phone", "email", "website", "vatId", "birthDate",
]);
const CRM_DEFAULT_CUSTOMER_COLUMNS = Object.freeze([
  "accountNumber", "customerNumber", "name", "customerType", "companyName", "city", "phone", "email",
]);
const CRM_PREFERENCE_KEYS = Object.freeze({
  COLUMNS: "crm_customer_columns_v1",
  SORT: "crm_customer_sort_v1",
});

const CUSTOMER_FIELDS = Object.freeze([
  "accountNumber", "customerNumber", "customerType", "companyName", "firstName", "lastName", "street",
  "addressSupplement", "postalCode", "city", "country", "phone", "email", "website",
  "vatId", "birthDate", "customFields",
]);

const FIELD_LIMITS = Object.freeze({
  accountNumber: 80,
  customerNumber: 80,
  companyName: 200,
  firstName: 120,
  lastName: 120,
  street: 240,
  addressSupplement: 160,
  postalCode: 32,
  city: 120,
  country: 120,
  phone: 80,
  email: 254,
  website: 500,
  vatId: 32,
});

class CrmValidationError extends Error {
  constructor(message, code = "CRM_INPUT_INVALID", status = 400) {
    super(message);
    this.name = "CrmValidationError";
    this.code = code;
    this.status = status;
  }
}

function invalid(message, code = "CRM_INPUT_INVALID") {
  throw new CrmValidationError(message, code);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, allowed, message) {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    invalid(message);
  }
}

function normalizedText(value, key, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") invalid(`Das Feld ${key} ist ungültig.`);
  const result = value.trim();
  if (result.length > FIELD_LIMITS[key] || /[\u0000-\u001f\u007f]/.test(result)) {
    invalid(`Das Feld ${key} ist zu lang oder enthält ungültige Zeichen.`);
  }
  return result || (nullable ? null : "");
}

function normalizedDate(value, key) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") invalid(`Das Feld ${key} ist ungültig.`);
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) invalid(`Das Feld ${key} muss ein gültiges ISO-Datum enthalten.`);
  const candidate = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (candidate.getUTCFullYear() !== Number(match[1])
    || candidate.getUTCMonth() !== Number(match[2]) - 1
    || candidate.getUTCDate() !== Number(match[3])) {
    invalid(`Das Feld ${key} muss ein gültiges ISO-Datum enthalten.`);
  }
  const today = new Date();
  const currentUtcDate = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (candidate.getTime() > currentUtcDate) {
    invalid(`Das Feld ${key} darf nicht in der Zukunft liegen.`, "CRM_BIRTH_DATE_FUTURE");
  }
  return value;
}

function normalizedEmail(value) {
  const email = normalizedText(value, "email");
  if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.includes(".."))) {
    invalid("Die E-Mail-Adresse ist ungültig.", "CRM_EMAIL_INVALID");
  }
  return email;
}

function normalizedWebsite(value) {
  const website = normalizedText(value, "website");
  if (!website) return "";
  try {
    const parsed = new URL(website);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
      throw new Error("invalid");
    }
  } catch {
    invalid("Die Website muss eine vollständige HTTP- oder HTTPS-Adresse sein.", "CRM_WEBSITE_INVALID");
  }
  return website;
}

function normalizedVatId(value) {
  const raw = normalizedText(value, "vatId").toUpperCase();
  if (!raw) return "";
  const vatId = raw.replace(/[\s.-]/g, "");
  if (vatId.length > FIELD_LIMITS.vatId
    || !/^[A-Z]{2}[A-Z0-9]{2,12}$/.test(vatId)
    || (vatId.startsWith("AT") && !/^ATU\d{8}$/.test(vatId))) {
    invalid("Die UID-Nummer ist ungültig.", "CRM_VAT_ID_INVALID");
  }
  return vatId;
}

function normalizedCustomFields(value) {
  const fields = value === undefined ? [] : value;
  if (!Array.isArray(fields) || fields.length > 50) {
    invalid("Es sind höchstens 50 eigene Textfelder zulässig.", "CRM_CUSTOM_FIELDS_INVALID");
  }
  const seenIds = new Set();
  let totalLength = 0;
  return Object.freeze(fields.map((field, index) => {
    assertExactKeys(field, ["id", "title", "value", "sortOrder"], "Ein eigenes Textfeld ist ungültig.");
    const id = field.id === undefined || field.id === null || field.id === ""
      ? null
      : String(field.id).trim();
    if (id && (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(id) || seenIds.has(id))) {
      invalid("Die Kennung eines eigenen Textfeldes ist ungültig.", "CRM_CUSTOM_FIELDS_INVALID");
    }
    if (id) seenIds.add(id);
    if (typeof field.title !== "string" || typeof field.value !== "string") {
      invalid("Titel und Inhalt eigener Textfelder müssen Text sein.", "CRM_CUSTOM_FIELDS_INVALID");
    }
    if (field.sortOrder !== undefined
      && (!Number.isSafeInteger(field.sortOrder) || field.sortOrder !== index)) {
      invalid("Die Reihenfolge eines eigenen Textfeldes ist ungültig.", "CRM_CUSTOM_FIELDS_INVALID");
    }
    const title = field.title.trim();
    const text = field.value.trim();
    totalLength += title.length + text.length;
    if (!title || title.length > 120 || text.length > 10000 || totalLength > 100000
      || /[\u0000-\u001f\u007f]/.test(title)
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      invalid("Ein eigenes Textfeld ist zu lang oder ungültig.", "CRM_CUSTOM_FIELDS_INVALID");
    }
    return Object.freeze({ id, title, value: text, sortOrder: index });
  }));
}

function normalizeCrmCustomerInput(value, { update = false } = {}) {
  const allowed = update ? [...CUSTOMER_FIELDS, "expectedRevision"] : CUSTOMER_FIELDS;
  assertExactKeys(value, allowed, "Die Kundendaten enthalten unbekannte Felder.");
  const customerType = String(value.customerType || "unknown").trim().toLowerCase();
  if (!CRM_CUSTOMER_TYPES.includes(customerType)) invalid("Die Kundenart ist ungültig.");
  const result = {
    accountNumber: normalizedText(value.accountNumber, "accountNumber", { nullable: true }),
    customerNumber: normalizedText(value.customerNumber, "customerNumber", { nullable: true }),
    customerType,
    companyName: normalizedText(value.companyName, "companyName"),
    firstName: normalizedText(value.firstName, "firstName"),
    lastName: normalizedText(value.lastName, "lastName"),
    street: normalizedText(value.street, "street"),
    addressSupplement: normalizedText(value.addressSupplement, "addressSupplement"),
    postalCode: normalizedText(value.postalCode, "postalCode"),
    city: normalizedText(value.city, "city"),
    country: normalizedText(value.country, "country"),
    phone: normalizedText(value.phone, "phone"),
    email: normalizedEmail(value.email),
    website: normalizedWebsite(value.website),
    vatId: normalizedVatId(value.vatId),
    birthDate: normalizedDate(value.birthDate, "birthDate"),
    customFields: normalizedCustomFields(value.customFields),
  };
  if (!update && !result.accountNumber && !result.companyName && !result.firstName && !result.lastName) {
    invalid("Bitte eine eindeutige Kunden-Kontonummer oder einen Namen angeben.", "CRM_NAME_REQUIRED");
  }
  if (update) {
    if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1) {
      invalid("Die erwartete Revision ist ungültig.", "CRM_REVISION_INVALID");
    }
    result.expectedRevision = value.expectedRevision;
    // Omitted fields in an update remain unchanged; explicit empty values are
    // validated against the complete card inside the write transaction.
    for (const field of CUSTOMER_FIELDS) if (!Object.hasOwn(value, field)) delete result[field];
  }
  return Object.freeze(result);
}

function normalizeCrmCustomerSearch(value) {
  assertExactKeys(value, ["query", "customerType", "sort", "direction", "limit", "offset"], "Die Suchparameter sind ungültig.");
  if (typeof value.query !== "string" || !value.query.trim()) {
    invalid("Bitte einen Suchbegriff angeben.", "CRM_QUERY_REQUIRED");
  }
  const query = value.query.trim();
  try { require("./flexible-search").terms(query); } catch (error) { invalid(error.message, "CRM_QUERY_INVALID"); }
  if (query.length < 2 || query.length > 120 || /[\u0000-\u001f\u007f]/.test(query)) {
    invalid("Der Suchbegriff muss zwischen 2 und 120 Zeichen lang sein.", "CRM_QUERY_INVALID");
  }
  const customerType = String(value.customerType || "").trim().toLowerCase();
  if (customerType && !CRM_CUSTOMER_TYPES.includes(customerType)) invalid("Die Kundenart ist ungültig.");
  const sort = String(value.sort || "lastName").trim();
  if (!CRM_CUSTOMER_SORT_KEYS.includes(sort)) invalid("Die Sortierung ist ungültig.");
  const direction = String(value.direction || "asc").trim().toLowerCase();
  if (!["asc", "desc"].includes(direction)) invalid("Die Sortierrichtung ist ungültig.");
  const limit = value.limit === undefined || value.limit === "" ? 50 : Number(value.limit);
  const offset = value.offset === undefined || value.offset === "" ? 0 : Number(value.offset);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000) {
    invalid("Der Suchausschnitt ist ungültig.");
  }
  const escapedQuery = query.replace(/([!%_])/g, "!$1");
  return Object.freeze({
    query,
    likeQuery: `%${escapedQuery}%`,
    customerType: customerType || null,
    sort,
    direction,
    limit,
    offset,
  });
}

function normalizeCrmPreferences(value) {
  assertExactKeys(value, ["columns", "sort"], "Die CRM-Anzeigeoptionen enthalten unbekannte Felder.");
  const columns = value.columns;
  if (!Array.isArray(columns) || !columns.length || columns.length > CRM_CUSTOMER_COLUMN_IDS.length
    || columns.some((column) => !CRM_CUSTOMER_COLUMN_IDS.includes(column))
    || new Set(columns).size !== columns.length) {
    invalid("Die CRM-Spaltenauswahl ist ungültig.", "CRM_PREFERENCES_INVALID");
  }
  assertExactKeys(value.sort, ["key", "direction"], "Die CRM-Sortierung ist ungültig.");
  const key = String(value.sort.key || "");
  const direction = String(value.sort.direction || "").toLowerCase();
  if (!CRM_CUSTOMER_SORT_KEYS.includes(key) || !["asc", "desc"].includes(direction)) {
    invalid("Die CRM-Sortierung ist ungültig.", "CRM_PREFERENCES_INVALID");
  }
  return Object.freeze({
    columns: Object.freeze([...columns]),
    sort: Object.freeze({ key, direction }),
  });
}

const CRM_DEFAULT_PREFERENCES = Object.freeze({
  columns: CRM_DEFAULT_CUSTOMER_COLUMNS,
  sort: Object.freeze({ key: "lastName", direction: "asc" }),
});

module.exports = {
  CRM_CUSTOMER_COLUMN_IDS,
  CRM_CUSTOMER_SORT_KEYS,
  CRM_CUSTOMER_TYPES,
  CRM_DEFAULT_CUSTOMER_COLUMNS,
  CRM_DEFAULT_PREFERENCES,
  CRM_PREFERENCE_KEYS,
  CrmValidationError,
  normalizeCrmCustomerInput,
  normalizeCrmCustomerSearch,
  normalizeCrmPreferences,
};
