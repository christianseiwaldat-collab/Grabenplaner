"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CRM_CUSTOMER_COLUMN_IDS,
  CRM_CUSTOMER_SORT_KEYS,
  CRM_DEFAULT_PREFERENCES,
  CRM_PREFERENCE_KEYS,
  CrmValidationError,
  normalizeCrmCustomerInput,
  normalizeCrmCustomerSearch,
  normalizeCrmPreferences,
} = require("../lib/crm-customers");

function customerInput(overrides = {}) {
  return {
    customerNumber: null,
    customerType: "private",
    companyName: "",
    firstName: "Ada",
    lastName: "Lovelace",
    street: "Testgasse 1",
    addressSupplement: "",
    postalCode: "6020",
    city: "Innsbruck",
    country: "Österreich",
    phone: "+43 512 123",
    email: "ada@example.test",
    website: "https://example.test/portfolio",
    vatId: "",
    birthDate: "1815-12-10",
    customFields: [],
    ...overrides,
  };
}

function assertCrmError(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof CrmValidationError, true);
    assert.equal(error.code, code);
    assert.equal(error.status, 400);
    return true;
  });
}

function assertCrmBadRequest(fn, acceptedCodes) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof CrmValidationError, true);
    assert.equal(error.status, 400);
    assert.ok(acceptedCodes.includes(error.code), `Unerwarteter CRM-Fehlercode: ${error.code}`);
    return true;
  });
}

test('Eine Kunden-Kontonummer genügt ohne Namen, Typ, Telefonnummer oder andere optionale Angaben', () => {
  const customer = normalizeCrmCustomerInput({ accountNumber: '  000419  ' });
  assert.equal(customer.accountNumber, '000419'); assert.equal(customer.customerNumber, null);
  for (const key of ['firstName', 'lastName', 'companyName', 'phone', 'email', 'street']) assert.equal(customer[key], '');
  assert.equal(customer.customerType, 'unknown'); assert.equal(customer.birthDate, null);
  assertCrmError(() => normalizeCrmCustomerInput({}), 'CRM_NAME_REQUIRED');
  assertCrmError(() => normalizeCrmCustomerInput({ accountNumber: '000419', email: 'invalid' }), 'CRM_EMAIL_INVALID');
});

test("Kundennummer bleibt bis zum späteren Bestandsimport nullable", () => {
  const missingNumber = normalizeCrmCustomerInput(customerInput());
  assert.equal(missingNumber.customerNumber, null);

  const blankNumber = normalizeCrmCustomerInput(customerInput({ customerNumber: "   " }));
  assert.equal(blankNumber.customerNumber, null);

  const importedNumber = normalizeCrmCustomerInput(customerInput({ customerNumber: "  K-00419  " }));
  assert.equal(importedNumber.customerNumber, "K-00419");
});

test("Kundenstamm validiert Typ, Kontaktangaben, UID und Geburtstag strikt", () => {
  assert.equal(normalizeCrmCustomerInput(customerInput({
    customerType: " BUSINESS ",
    companyName: "Lovelace Photography",
    vatId: "at u12345678",
  })).vatId, "ATU12345678");

  assertCrmError(
    () => normalizeCrmCustomerInput(customerInput({ customerType: "public" })),
    "CRM_INPUT_INVALID",
  );
  assertCrmError(
    () => normalizeCrmCustomerInput(customerInput({ email: "invalid@example" })),
    "CRM_EMAIL_INVALID",
  );
  assertCrmError(
    () => normalizeCrmCustomerInput(customerInput({ website: "javascript:alert(1)" })),
    "CRM_WEBSITE_INVALID",
  );
  assertCrmError(
    () => normalizeCrmCustomerInput(customerInput({ vatId: "ATU123" })),
    "CRM_VAT_ID_INVALID",
  );
  assertCrmError(
    () => normalizeCrmCustomerInput(customerInput({ birthDate: "2026-02-30" })),
    "CRM_INPUT_INVALID",
  );
  assertCrmError(
    () => normalizeCrmCustomerInput(customerInput({ firstName: "", lastName: "", companyName: "" })),
    "CRM_NAME_REQUIRED",
  );
});

test("Eigene Textfelder bewahren Titel, Inhalt und Reihenfolge mit klaren Grenzen", () => {
  const customer = normalizeCrmCustomerInput(customerInput({
    customFields: [
      { id: "equipment", title: "Ausrüstung", value: "  Mittelformatkamera  " },
      { id: null, title: "Hinweis", value: "Problem mit Blitzanlage" },
    ],
  }));
  assert.deepEqual(customer.customFields, [
    { id: "equipment", title: "Ausrüstung", value: "Mittelformatkamera", sortOrder: 0 },
    { id: null, title: "Hinweis", value: "Problem mit Blitzanlage", sortOrder: 1 },
  ]);
  assert.equal(Object.isFrozen(customer.customFields), true);

  assertCrmError(
    () => normalizeCrmCustomerInput(customerInput({
      customFields: [
        { id: "duplicate", title: "A", value: "1" },
        { id: "duplicate", title: "B", value: "2" },
      ],
    })),
    "CRM_CUSTOM_FIELDS_INVALID",
  );
  assertCrmError(
    () => normalizeCrmCustomerInput(customerInput({
      customFields: Array.from({ length: 51 }, (_, index) => ({
        id: `field-${index}`,
        title: `Feld ${index}`,
        value: "Wert",
      })),
    })),
    "CRM_CUSTOM_FIELDS_INVALID",
  );
});

test("Änderungen verlangen eine positive erwartete Revision", () => {
  const updated = normalizeCrmCustomerInput(customerInput({ expectedRevision: 7 }), { update: true });
  assert.equal(updated.expectedRevision, 7);
  assertCrmError(
    () => normalizeCrmCustomerInput(customerInput({ expectedRevision: 0 }), { update: true }),
    "CRM_REVISION_INVALID",
  );
  assertCrmError(
    () => normalizeCrmCustomerInput(customerInput(), { update: true }),
    "CRM_REVISION_INVALID",
  );
});

test("Kundensuche verlangt query und begrenzt Sortierung sowie Pagination serverseitig", () => {
  const search = normalizeCrmCustomerSearch({
    query: "  Ada_100%!  ",
    customerType: "private",
    sort: "lastName",
    direction: "DESC",
    limit: "100",
    offset: "900",
  });
  assert.deepEqual(search, {
    query: "Ada_100%!",
    likeQuery: "%Ada!_100!%!!%",
    customerType: "private",
    sort: "lastName",
    direction: "desc",
    limit: 100,
    offset: 900,
  });

  assertCrmBadRequest(
    () => normalizeCrmCustomerSearch({ query: "" }),
    ["CRM_QUERY_INVALID", "CRM_QUERY_REQUIRED"],
  );
  assertCrmBadRequest(
    () => normalizeCrmCustomerSearch({}),
    ["CRM_QUERY_INVALID", "CRM_QUERY_REQUIRED"],
  );
  assertCrmError(
    () => normalizeCrmCustomerSearch({ query: "Ada", sort: "last_name; DROP TABLE crm_customers" }),
    "CRM_INPUT_INVALID",
  );
  assertCrmError(
    () => normalizeCrmCustomerSearch({ query: "Ada", direction: "sideways" }),
    "CRM_INPUT_INVALID",
  );
  assertCrmError(
    () => normalizeCrmCustomerSearch({ query: "Ada", limit: 101 }),
    "CRM_INPUT_INVALID",
  );
  assertCrmError(
    () => normalizeCrmCustomerSearch({ query: "Ada", offset: -1 }),
    "CRM_INPUT_INVALID",
  );
  assert.ok(CRM_CUSTOMER_SORT_KEYS.includes("customerNumber"));
  assert.ok(CRM_CUSTOMER_SORT_KEYS.includes("lastName"));
});

test("Spalten- und Sortierpräferenzen akzeptieren nur eindeutige Katalogwerte", () => {
  assert.equal(CRM_PREFERENCE_KEYS.COLUMNS, "crm_customer_columns_v1");
  assert.equal(CRM_PREFERENCE_KEYS.SORT, "crm_customer_sort_v1");
  assert.ok(CRM_DEFAULT_PREFERENCES.columns.length > 0);

  const normalized = normalizeCrmPreferences({
    columns: ["photo", "name", "customerNumber", "email"],
    sort: { key: "customerNumber", direction: "desc" },
  });
  assert.deepEqual(normalized.columns, ["photo", "name", "customerNumber", "email"]);
  assert.deepEqual(normalized.sort, { key: "customerNumber", direction: "desc" });

  assertCrmError(
    () => normalizeCrmPreferences({ columns: ["name", "name"], sort: { key: "lastName", direction: "asc" } }),
    "CRM_PREFERENCES_INVALID",
  );
  assertCrmError(
    () => normalizeCrmPreferences({ columns: ["name", "passwordHash"], sort: { key: "lastName", direction: "asc" } }),
    "CRM_PREFERENCES_INVALID",
  );
  assert.ok(CRM_CUSTOMER_COLUMN_IDS.includes("photo"));
});
