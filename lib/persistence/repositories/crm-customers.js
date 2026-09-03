"use strict";

const crypto = require("node:crypto");
const {
  normalizeCrmCustomerInput,
  normalizeCrmCustomerSearch,
} = require("../../crm-customers");
const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceAccess,
} = require("../contract");
const {
  CRM_CUSTOMER_STATEMENTS: S,
} = require("../statements/crm-customers");

function invalidInput(operation) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, { operation });
}

function retryable(operation) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.RETRYABLE_TRANSACTION, { operation });
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, operation) {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw invalidInput(operation);
  }
}

function normalizedIdentifier(value, operation, maximumLength = 120) {
  const result = String(value || "").trim();
  if (!result || result.length > maximumLength || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(result)) {
    throw invalidInput(operation);
  }
  return result;
}

function normalizedTimestamp(value, operation) {
  const result = String(value || "");
  try {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)
      || new Date(result).toISOString() !== result) throw new Error("invalid");
  } catch {
    throw invalidInput(operation);
  }
  return result;
}

function primitiveOperations(access) {
  return Object.freeze({
    queryOne(statement, parameters) {
      return access.queryOne(statement, parameters);
    },
    queryAll(statement, parameters) {
      return access.queryAll(statement, parameters);
    },
    execute(statement, parameters) {
      return access.execute(statement, parameters);
    },
  });
}

function customerWriteParameters(customer, actor, timestamp) {
  return {
    customerNumber: customer.customerNumber,
    customerType: customer.customerType,
    companyName: customer.companyName,
    firstName: customer.firstName,
    lastName: customer.lastName,
    street: customer.street,
    addressSupplement: customer.addressSupplement,
    postalCode: customer.postalCode,
    city: customer.city,
    country: customer.country,
    phone: customer.phone,
    email: customer.email,
    website: customer.website,
    vatId: customer.vatId,
    birthDate: customer.birthDate,
    actor,
    timestamp,
  };
}

async function replaceCustomFields(operations, customerId, customFields, revision, actor, timestamp) {
  await operations.execute(S.deleteCustomFields, { customerId });
  for (const field of customFields) {
    await operations.execute(S.insertCustomField, {
      id: field.id || crypto.randomUUID(),
      customerId,
      title: field.title,
      value: field.value,
      sortOrder: field.sortOrder,
      revision,
      actor,
      timestamp,
    });
  }
}

async function audit(operations, { actor, action, entityId, detail, timestamp }) {
  await operations.execute(S.insertAudit, {
    actor,
    action,
    entityType: "crm_customer",
    entityId,
    detail: JSON.stringify(detail),
    timestamp,
  });
}

function normalizedPhoto(value, operation) {
  exactKeys(value, [
    "storageKey", "contentSha256", "byteSize", "mediaType", "originalFilename",
  ], operation);
  const storageKey = String(value.storageKey || "").trim().toLowerCase();
  const contentSha256 = String(value.contentSha256 || "").trim().toLowerCase();
  const originalFilename = String(value.originalFilename || "").trim();
  if (!/^[0-9a-f]{2}\/[0-9a-f-]{36}\.amu$/.test(storageKey)
    || !/^[0-9a-f]{64}$/.test(contentSha256)
    || !Number.isSafeInteger(value.byteSize) || value.byteSize < 1 || value.byteSize > 512 * 1024
    || value.mediaType !== "image/jpeg"
    || !originalFilename || originalFilename.length > 160
    || /[\u0000-\u001f\u007f]/.test(originalFilename)) {
    throw invalidInput(operation);
  }
  return Object.freeze({
    storageKey,
    contentSha256,
    byteSize: value.byteSize,
    mediaType: value.mediaType,
    originalFilename,
  });
}

const createCrmCustomersRepository = Object.freeze(function createCrmCustomersRepository(access) {
  assertPersistenceAccess(access);
  const direct = primitiveOperations(access);

  function atomic(work) {
    if (typeof access.transaction !== "function") return work(direct);
    return access.transaction((executor) => work(primitiveOperations(executor)));
  }

  return Object.freeze({
    async search(value) {
      let input;
      try {
        input = normalizeCrmCustomerSearch(value);
      } catch {
        throw invalidInput("crm-customer-search");
      }
      const parameters = {
        likeQuery: input.likeQuery,
        customerType: input.customerType,
        sort: input.sort,
        direction: input.direction,
        limit: input.limit,
        offset: input.offset,
      };
      const [items, count] = await Promise.all([
        direct.queryAll(S.search, parameters),
        direct.queryOne(S.countSearch, {
          likeQuery: input.likeQuery,
          customerType: input.customerType,
        }),
      ]);
      return Object.freeze({
        items,
        total: count?.total || 0,
        limit: input.limit,
        offset: input.offset,
        sort: input.sort,
        direction: input.direction,
      });
    },

    get(id) {
      return direct.queryOne(S.get, {
        id: normalizedIdentifier(id, "crm-customer-get", 80),
      });
    },

    async create(value) {
      const operation = "crm-customer-create";
      exactKeys(value, ["customer", "actor", "timestamp"], operation);
      let customer;
      try {
        customer = normalizeCrmCustomerInput(value.customer);
      } catch {
        throw invalidInput(operation);
      }
      const actor = normalizedIdentifier(value.actor, operation);
      const timestamp = normalizedTimestamp(value.timestamp, operation);
      const id = crypto.randomUUID();
      return atomic(async (operations) => {
        await operations.execute(S.insert, {
          id,
          ...customerWriteParameters(customer, actor, timestamp),
        });
        await replaceCustomFields(operations, id, customer.customFields, 1, actor, timestamp);
        await audit(operations, {
          actor,
          action: "crm.customer.create",
          entityId: id,
          detail: { revision: 1, customFieldCount: customer.customFields.length },
          timestamp,
        });
        return operations.queryOne(S.get, { id });
      });
    },

    async update(value) {
      const operation = "crm-customer-update";
      exactKeys(value, ["id", "customer", "expectedRevision", "actor", "timestamp"], operation);
      const id = normalizedIdentifier(value.id, operation, 80);
      const actor = normalizedIdentifier(value.actor, operation);
      const timestamp = normalizedTimestamp(value.timestamp, operation);
      let customer;
      try {
        customer = normalizeCrmCustomerInput({
          ...value.customer,
          expectedRevision: value.expectedRevision,
        }, { update: true });
      } catch {
        throw invalidInput(operation);
      }
      return atomic(async (operations) => {
        const before = await operations.queryOne(S.get, { id });
        if (!before) return null;
        const result = await operations.execute(S.update, {
          id,
          expectedRevision: customer.expectedRevision,
          ...customerWriteParameters(customer, actor, timestamp),
        });
        if (result.rowsAffected !== 1) throw retryable(operation);
        const revision = customer.expectedRevision + 1;
        await replaceCustomFields(operations, id, customer.customFields, revision, actor, timestamp);
        const changedFields = [
          "customerNumber", "customerType", "companyName", "firstName", "lastName", "street",
          "addressSupplement", "postalCode", "city", "country", "phone", "email", "website",
          "vatId", "birthDate",
        ].filter((key) => before[key] !== customer[key]);
        if (JSON.stringify(before.customFields) !== JSON.stringify(customer.customFields)) {
          changedFields.push("customFields");
        }
        await audit(operations, {
          actor,
          action: "crm.customer.update",
          entityId: id,
          detail: { revision, changedFields, customFieldCount: customer.customFields.length },
          timestamp,
        });
        return operations.queryOne(S.get, { id });
      });
    },

    getPhoto(customerId) {
      return direct.queryOne(S.getPhoto, {
        customerId: normalizedIdentifier(customerId, "crm-customer-photo-get", 80),
      });
    },

    async replacePhoto(value) {
      const operation = "crm-customer-photo-replace";
      exactKeys(value, ["customerId", "photo", "actor", "timestamp"], operation);
      const customerId = normalizedIdentifier(value.customerId, operation, 80);
      const photo = normalizedPhoto(value.photo, operation);
      const actor = normalizedIdentifier(value.actor, operation);
      const timestamp = normalizedTimestamp(value.timestamp, operation);
      return atomic(async (operations) => {
        const customer = await operations.queryOne(S.get, { id: customerId });
        if (!customer) return null;
        const previous = await operations.queryOne(S.getPhoto, { customerId });
        await operations.execute(S.upsertPhoto, {
          customerId,
          ...photo,
          actor,
          timestamp,
        });
        const stored = await operations.queryOne(S.getPhoto, { customerId });
        await audit(operations, {
          actor,
          action: previous ? "crm.customer.photo.replace" : "crm.customer.photo.create",
          entityId: customerId,
          detail: { revision: stored.revision, byteSize: stored.byteSize },
          timestamp,
        });
        return Object.freeze({
          photo: stored,
          previousStorageKey: previous?.storageKey || null,
        });
      });
    },

    async deletePhoto(value) {
      const operation = "crm-customer-photo-delete";
      exactKeys(value, ["customerId", "actor", "timestamp"], operation);
      const customerId = normalizedIdentifier(value.customerId, operation, 80);
      const actor = normalizedIdentifier(value.actor, operation);
      const timestamp = normalizedTimestamp(value.timestamp, operation);
      return atomic(async (operations) => {
        const customer = await operations.queryOne(S.get, { id: customerId });
        if (!customer) return null;
        const previous = await operations.queryOne(S.getPhoto, { customerId });
        if (!previous) return Object.freeze({ deleted: false, storageKey: null });
        const result = await operations.execute(S.deletePhoto, { customerId });
        if (result.rowsAffected !== 1) throw retryable(operation);
        await audit(operations, {
          actor,
          action: "crm.customer.photo.delete",
          entityId: customerId,
          detail: { revision: previous.revision },
          timestamp,
        });
        return Object.freeze({ deleted: true, storageKey: previous.storageKey });
      });
    },
  });
});

module.exports = {
  createCrmCustomersRepository,
};
