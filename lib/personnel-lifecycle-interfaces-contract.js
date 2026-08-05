"use strict";

const crypto = require("node:crypto");
const { types: utilTypes } = require("node:util");

const PERSONNEL_LIFECYCLE_INTERFACE_CONTRACT_VERSION = "o6-v0.1";
const PERSONNEL_LIFECYCLE_INTERFACE_SCHEMA_VERSION = "personnel-lifecycle-interface-command/v1";

const PERSONNEL_LIFECYCLE_INTERFACE_DOMAINS = Object.freeze({
  TRAINING: "training",
  ASSET: "asset",
  ACCESS: "access",
});

const PERSONNEL_LIFECYCLE_INTERFACE_DOMAIN_IDS = Object.freeze(
  Object.values(PERSONNEL_LIFECYCLE_INTERFACE_DOMAINS),
);

const PERSONNEL_LIFECYCLE_INTERFACE_OPERATIONS = Object.freeze({
  TRAINING_ASSIGN: "training_assign",
  TRAINING_STATUS: "training_status",
  TRAINING_EVIDENCE: "training_evidence",
  ASSET_ISSUE: "asset_issue",
  ASSET_RETURN: "asset_return",
  ACCESS_GRANT: "access_grant",
  ACCESS_CHANGE: "access_change",
  ACCESS_REVOKE: "access_revoke",
});

const O = PERSONNEL_LIFECYCLE_INTERFACE_OPERATIONS;
const PERSONNEL_LIFECYCLE_INTERFACE_DOMAIN_OPERATIONS = Object.freeze({
  training: Object.freeze([O.TRAINING_ASSIGN, O.TRAINING_STATUS, O.TRAINING_EVIDENCE]),
  asset: Object.freeze([O.ASSET_ISSUE, O.ASSET_RETURN]),
  access: Object.freeze([O.ACCESS_GRANT, O.ACCESS_CHANGE, O.ACCESS_REVOKE]),
});

const PERSONNEL_LIFECYCLE_INTERFACE_OPERATION_IDS = Object.freeze(
  Object.values(PERSONNEL_LIFECYCLE_INTERFACE_OPERATIONS),
);

const PERSONNEL_LIFECYCLE_INTERFACE_ACTIONABLE_TASK_STATUSES = Object.freeze([
  "pending",
  "active",
]);

const PERSONNEL_LIFECYCLE_INTERFACE_PERMISSIONS = Object.freeze({
  TRAINING_READ: "personnel:lifecycle:interfaces:training:read",
  TRAINING_MANAGE: "personnel:lifecycle:interfaces:training:manage",
  TRAINING_DISPATCH: "personnel:lifecycle:interfaces:training:dispatch",
  TRAINING_RECONCILE: "personnel:lifecycle:interfaces:training:reconcile",
  ASSET_READ: "personnel:lifecycle:interfaces:asset:read",
  ASSET_MANAGE: "personnel:lifecycle:interfaces:asset:manage",
  ASSET_DISPATCH: "personnel:lifecycle:interfaces:asset:dispatch",
  ASSET_RECONCILE: "personnel:lifecycle:interfaces:asset:reconcile",
  ACCESS_READ: "personnel:lifecycle:interfaces:access:read",
  ACCESS_MANAGE: "personnel:lifecycle:interfaces:access:manage",
  ACCESS_DISPATCH: "personnel:lifecycle:interfaces:access:dispatch",
  ACCESS_RECONCILE: "personnel:lifecycle:interfaces:access:reconcile",
});

const PERSONNEL_LIFECYCLE_INTERFACE_PERMISSION_IDS = Object.freeze(
  Object.values(PERSONNEL_LIFECYCLE_INTERFACE_PERMISSIONS),
);

const PERSONNEL_LIFECYCLE_INTERFACE_ROLE_GRANTS = Object.freeze({});

const COMMON_PROVIDER_FIELDS = Object.freeze([
  "schemaVersion",
  "commandId",
  "orderId",
  "operation",
]);

// `maximumProjectionFields` is the O1 input ceiling. `defaultPayloadFields` is
// intentionally not its subset: it adds the technical command envelope and
// names the explicit dueAt/executeAt -> effectiveAt boundary mapping.
const PERSONNEL_LIFECYCLE_INTERFACE_PROVIDER_FIELDS = Object.freeze({
  training: Object.freeze({
    maximumProjectionFields: Object.freeze([
      "orderId", "displayName", "locationId", "departmentId", "module", "dueAt",
      "evidenceStatus", "status",
    ]),
    defaultPayloadFields: Object.freeze([
      ...COMMON_PROVIDER_FIELDS, "module", "dueAt", "evidenceStatus",
    ]),
    optionalProviderFields: Object.freeze(["locationId", "departmentId", "displayName"]),
  }),
  asset: Object.freeze({
    maximumProjectionFields: Object.freeze([
      "orderId", "displayName", "locationId", "assetIdentifier", "action", "dueAt",
      "status",
    ]),
    defaultPayloadFields: Object.freeze([
      ...COMMON_PROVIDER_FIELDS, "assetIdentifier", "locationId", "effectiveAt",
    ]),
    optionalProviderFields: Object.freeze(["displayName"]),
  }),
  access: Object.freeze({
    maximumProjectionFields: Object.freeze([
      "orderId", "displayName", "businessIdentifier", "targetSystem", "action", "executeAt",
      "status",
    ]),
    defaultPayloadFields: Object.freeze([
      ...COMMON_PROVIDER_FIELDS, "businessIdentifier", "targetSystem", "effectiveAt",
    ]),
    optionalProviderFields: Object.freeze(["displayName"]),
  }),
});

const PERSONNEL_LIFECYCLE_INTERFACE_BLOCKERS = Object.freeze({
  PROVIDER_TARGET_IDENTIFIER_MISSING: "provider_target_identifier_missing",
  COMMAND_IDENTIFIER_MISSING: "command_identifier_missing",
  COMMAND_IDENTIFIER_INVALID: "command_identifier_invalid",
  ORDER_IDENTIFIER_MISSING: "order_identifier_missing",
  TASK_STATUS_NOT_ACTIONABLE: "task_status_not_actionable",
  MODULE_IDENTIFIER_MISSING: "module_identifier_missing",
  ASSET_IDENTIFIER_MISSING: "asset_identifier_missing",
  LOCATION_IDENTIFIER_MISSING: "location_identifier_missing",
  BUSINESS_IDENTIFIER_MISSING: "business_identifier_missing",
  TARGET_SYSTEM_IDENTIFIER_MISSING: "target_system_identifier_missing",
  TARGET_SYSTEM_NOT_ALLOWED: "target_system_not_allowed",
  DUE_AT_MISSING: "due_at_missing",
  EFFECTIVE_AT_MISSING: "effective_at_missing",
  EVIDENCE_STATUS_MISSING: "evidence_status_missing",
  ALLOWLIST_NOT_FOUND: "allowlist_not_found",
  ALLOWLIST_AMBIGUOUS: "allowlist_ambiguous",
  ALLOWLIST_STALE: "allowlist_stale",
  ALLOWLIST_INACTIVE: "allowlist_inactive",
  DOMAIN_NOT_ALLOWED: "domain_not_allowed",
  ACTION_NOT_ALLOWED: "action_not_allowed",
  SCOPE_NOT_ALLOWED: "scope_not_allowed",
  PROVIDER_FIELD_NOT_ALLOWLISTED: "provider_field_not_allowlisted",
  PROVIDER_FIELD_VALUE_MISSING: "provider_field_value_missing",
});

const PERSONNEL_LIFECYCLE_INTERFACE_DEFAULT_PROVIDER_REGISTRY = Object.freeze([]);
const RESERVED_PROVIDER_TARGET_IDS = new Set(["managed_accesses"]);

const PERSONNEL_LIFECYCLE_INTERFACE_RUNTIME_GATES = Object.freeze({
  networkDispatch: false,
  persistence: false,
  outbox: false,
  externalMutation: false,
});

const PROVIDER_INPUT_KEYS = new Set([
  "targetId", "active", "revision", "domain", "operation", "scope", "allowedFields",
]);
const PROVIDER_RECORD_KEYS = new Set([...PROVIDER_INPUT_KEYS, "fingerprint"]);
const PREFLIGHT_KEYS = new Set([
  "registry", "providerTargetId", "providerRevision", "providerFingerprint", "scope",
  "domain", "operation", "commandId", "projection", "providerFields",
]);
const SCOPE_KEYS = new Set(["type", "id"]);
const SCOPE_TYPES = new Set(["global", "location", "department"]);

function contractError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function assertExactRecord(value, keys, label, requiredKeys = keys) {
  if (utilTypes.isProxy(value) || !value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw contractError("O6_RECORD_INVALID", `${label} must be a plain record.`);
  }
  const actualKeys = Reflect.ownKeys(value);
  for (const key of actualKeys) {
    const descriptor = typeof key === "string"
      ? Object.getOwnPropertyDescriptor(value, key)
      : null;
    if (typeof key !== "string" || !keys.has(key) || !descriptor
      || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw contractError("O6_FIELDS_INVALID", `${label} contains an unknown or dynamic field.`);
    }
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw contractError("O6_FIELDS_INVALID", `${label} is missing ${key}.`);
    }
  }
}

function plainArrayValues(value, label, maximumLength) {
  if (utilTypes.isProxy(value) || !Array.isArray(value) || value.length > maximumLength) {
    throw contractError("O6_VALUE_INVALID", `${label} must be an array.`);
  }
  const expectedKeys = new Set([
    "length",
    ...Array.from({ length: value.length }, (_, index) => String(index)),
  ]);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === "string"
      ? Object.getOwnPropertyDescriptor(value, key)
      : null;
    if (typeof key !== "string" || !expectedKeys.has(key) || !descriptor
      || !("value" in descriptor)
      || (key !== "length" && descriptor.enumerable !== true)) {
      throw contractError("O6_VALUE_INVALID", `${label} must contain plain values.`);
    }
  }
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) {
      throw contractError("O6_VALUE_INVALID", `${label} must not contain gaps.`);
    }
    return descriptor.value;
  });
}

function assertString(value, label, { nonEmpty = true, maxLength = 512 } = {}) {
  if (typeof value !== "string" || value.length > maxLength || /[\0\r\n]/.test(value)
    || (nonEmpty && value.trim() === "")) {
    throw contractError("O6_VALUE_INVALID", `${label} must be a string.`);
  }
  return value;
}

function assertStringArray(value, label, { unique = true } = {}) {
  const values = plainArrayValues(value, label, 100);
  const result = values.map((entry, index) => (
    assertString(entry, `${label}[${index}]`, { maxLength: 128 })
  ));
  if (unique && new Set(result).size !== result.length) {
    throw contractError("O6_VALUE_INVALID", `${label} must not contain duplicates.`);
  }
  return result;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function normalizeScope(value, label = "scope") {
  assertExactRecord(value, SCOPE_KEYS, label);
  const type = assertString(value.type, `${label}.type`, { maxLength: 32 });
  if (!SCOPE_TYPES.has(type)) {
    throw contractError("O6_SCOPE_INVALID", `${label}.type is not supported.`);
  }
  const id = value.id;
  if ((type === "global" && id !== null)
    || (type !== "global" && (typeof id !== "string" || id.trim() === ""
      || id.length > 128 || /[\0\r\n]/.test(id)))) {
    throw contractError("O6_SCOPE_INVALID", `${label}.id does not match its type.`);
  }
  return Object.freeze({ type, id });
}

function providerFingerprintContent(target) {
  return {
    active: target.active,
    allowedFields: target.allowedFields,
    domain: target.domain,
    operation: target.operation,
    revision: target.revision,
    scope: target.scope,
    targetId: target.targetId,
  };
}

function fingerprintProviderTarget(target) {
  return crypto.createHash("sha256")
    .update(canonicalJson(providerFingerprintContent(target)), "utf8")
    .digest("hex");
}

function normalizeProviderTargetInput(input) {
  assertExactRecord(input, PROVIDER_INPUT_KEYS, "Provider target");
  const targetId = assertString(input.targetId, "targetId", { maxLength: 128 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(targetId)) {
    throw contractError("O6_VALUE_INVALID", "targetId must be an opaque identifier.");
  }
  if (RESERVED_PROVIDER_TARGET_IDS.has(targetId.toLowerCase())) {
    throw contractError("O6_VALUE_INVALID", "targetId is reserved and cannot identify a provider.");
  }
  if (typeof input.active !== "boolean") {
    throw contractError("O6_VALUE_INVALID", "active must be a boolean.");
  }
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw contractError("O6_VALUE_INVALID", "revision must be a positive integer.");
  }
  const domain = assertString(input.domain, "domain", { maxLength: 32 });
  if (!PERSONNEL_LIFECYCLE_INTERFACE_DOMAIN_IDS.includes(domain)) {
    throw contractError("O6_DOMAIN_INVALID", "domain is not supported.");
  }
  const operation = assertString(input.operation, "operation", { maxLength: 64 });
  if (!PERSONNEL_LIFECYCLE_INTERFACE_DOMAIN_OPERATIONS[domain].includes(operation)) {
    throw contractError("O6_OPERATION_INVALID", "operation is not valid for domain.");
  }
  const scope = normalizeScope(input.scope, "Provider target scope");
  const allowedFields = assertStringArray(input.allowedFields, "allowedFields").sort();
  const fieldContract = PERSONNEL_LIFECYCLE_INTERFACE_PROVIDER_FIELDS[domain];
  const maximum = new Set([
    ...fieldContract.defaultPayloadFields,
    ...fieldContract.optionalProviderFields,
  ]);
  if (allowedFields.some((field) => !maximum.has(field))) {
    throw contractError("O6_PROVIDER_FIELDS_INVALID", "allowedFields exceeds the O6 boundary.");
  }
  return {
    targetId,
    active: input.active,
    revision: input.revision,
    domain,
    operation,
    scope,
    allowedFields: Object.freeze(allowedFields),
  };
}

function createPersonnelLifecycleInterfaceProviderTarget(input) {
  const target = normalizeProviderTargetInput(input);
  return deepFreeze({ ...target, fingerprint: fingerprintProviderTarget(target) });
}

function inspectProviderRecord(value) {
  assertExactRecord(value, PROVIDER_RECORD_KEYS, "Provider registry entry");
  const input = {};
  for (const key of PROVIDER_INPUT_KEYS) input[key] = value[key];
  const normalized = normalizeProviderTargetInput(input);
  const fingerprint = assertString(value.fingerprint, "fingerprint", {
    nonEmpty: false,
    maxLength: 64,
  });
  return {
    target: deepFreeze({ ...normalized, fingerprint }),
    stale: !/^[a-f0-9]{64}$/.test(fingerprint)
      || fingerprint !== fingerprintProviderTarget(normalized),
  };
}

function normalizeRegistry(value) {
  let values;
  try {
    values = plainArrayValues(value, "registry", 1000);
  } catch (error) {
    throw contractError("O6_REGISTRY_INVALID", "registry must be a bounded plain array.");
  }
  return values.map(inspectProviderRecord);
}

function projectionContract(domain) {
  return new Set(PERSONNEL_LIFECYCLE_INTERFACE_PROVIDER_FIELDS[domain].maximumProjectionFields);
}

function normalizeProjection(value, domain) {
  const allowed = projectionContract(domain);
  assertExactRecord(value, allowed, "projection", new Set());
  const result = Object.create(null);
  for (const key of Object.keys(value)) {
    const fieldValue = Object.getOwnPropertyDescriptor(value, key).value;
    if (fieldValue !== null && (typeof fieldValue !== "string" || fieldValue.length > 512
      || /[\0\r\n]/.test(fieldValue))) {
      throw contractError("O6_VALUE_INVALID", `projection.${key} must be a bounded string or null.`);
    }
    result[key] = fieldValue;
  }
  return Object.freeze(result);
}

function addMissing(blockers, value, code) {
  if (typeof value !== "string" || value.trim() === "") blockers.add(code);
}

function buildPayload(request) {
  const { domain, projection } = request;
  const payload = {
    schemaVersion: PERSONNEL_LIFECYCLE_INTERFACE_SCHEMA_VERSION,
    commandId: request.commandId,
    orderId: projection.orderId,
    operation: request.operation,
  };
  if (domain === PERSONNEL_LIFECYCLE_INTERFACE_DOMAINS.TRAINING) {
    payload.module = projection.module;
    payload.dueAt = projection.dueAt;
    payload.evidenceStatus = projection.evidenceStatus;
  } else if (domain === PERSONNEL_LIFECYCLE_INTERFACE_DOMAINS.ASSET) {
    payload.assetIdentifier = projection.assetIdentifier;
    payload.locationId = projection.locationId;
    payload.effectiveAt = projection.dueAt;
  } else {
    payload.businessIdentifier = projection.businessIdentifier;
    payload.targetSystem = projection.targetSystem;
    payload.effectiveAt = projection.executeAt;
  }
  for (const field of request.providerFields) payload[field] = projection[field];
  return deepFreeze(payload);
}

function blocked(blockers) {
  return deepFreeze({
    status: "blocked",
    blockerCodes: [...blockers],
    payloadPreview: null,
  });
}

function preflightPersonnelLifecycleInterfaceCommand(input) {
  assertExactRecord(input, PREFLIGHT_KEYS, "O6 preflight");
  const domain = assertString(input.domain, "domain", { maxLength: 32 });
  if (!PERSONNEL_LIFECYCLE_INTERFACE_DOMAIN_IDS.includes(domain)) {
    throw contractError("O6_DOMAIN_INVALID", "domain is not supported.");
  }
  const operation = assertString(input.operation, "operation", {
    nonEmpty: false,
    maxLength: 64,
  });
  const commandId = assertString(input.commandId, "commandId", {
    nonEmpty: false,
    maxLength: 36,
  });
  const providerTargetId = assertString(
    input.providerTargetId,
    "providerTargetId",
    { nonEmpty: false, maxLength: 128 },
  );
  if (!Number.isSafeInteger(input.providerRevision) || input.providerRevision < 0) {
    throw contractError("O6_VALUE_INVALID", "providerRevision must be a non-negative integer.");
  }
  const providerFingerprint = assertString(
    input.providerFingerprint,
    "providerFingerprint",
    { nonEmpty: false },
  );
  const scope = normalizeScope(input.scope, "Preflight scope");
  const projection = normalizeProjection(input.projection, domain);
  const providerFields = assertStringArray(input.providerFields, "providerFields");
  const registry = normalizeRegistry(input.registry);
  const request = {
    domain,
    operation,
    commandId,
    providerTargetId,
    providerRevision: input.providerRevision,
    providerFingerprint,
    scope,
    projection,
    providerFields,
  };
  const B = PERSONNEL_LIFECYCLE_INTERFACE_BLOCKERS;
  const blockers = new Set();
  addMissing(blockers, providerTargetId, B.PROVIDER_TARGET_IDENTIFIER_MISSING);
  addMissing(blockers, commandId, B.COMMAND_IDENTIFIER_MISSING);
  if (commandId !== ""
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(commandId)) {
    blockers.add(B.COMMAND_IDENTIFIER_INVALID);
  }
  addMissing(blockers, projection.orderId, B.ORDER_IDENTIFIER_MISSING);
  if (!PERSONNEL_LIFECYCLE_INTERFACE_ACTIONABLE_TASK_STATUSES.includes(projection.status)) {
    blockers.add(B.TASK_STATUS_NOT_ACTIONABLE);
  }
  if (!PERSONNEL_LIFECYCLE_INTERFACE_DOMAIN_OPERATIONS[domain].includes(operation)) {
    blockers.add(B.ACTION_NOT_ALLOWED);
  }
  if (domain === "training") {
    addMissing(blockers, projection.module, B.MODULE_IDENTIFIER_MISSING);
    addMissing(blockers, projection.dueAt, B.DUE_AT_MISSING);
    addMissing(blockers, projection.evidenceStatus, B.EVIDENCE_STATUS_MISSING);
  } else if (domain === "asset") {
    addMissing(blockers, projection.assetIdentifier, B.ASSET_IDENTIFIER_MISSING);
    addMissing(blockers, projection.locationId, B.LOCATION_IDENTIFIER_MISSING);
    addMissing(blockers, projection.dueAt, B.EFFECTIVE_AT_MISSING);
    if (projection.action !== operation) blockers.add(B.ACTION_NOT_ALLOWED);
  } else {
    addMissing(blockers, projection.businessIdentifier, B.BUSINESS_IDENTIFIER_MISSING);
    addMissing(blockers, projection.targetSystem, B.TARGET_SYSTEM_IDENTIFIER_MISSING);
    addMissing(blockers, projection.executeAt, B.EFFECTIVE_AT_MISSING);
    if (projection.action !== operation) blockers.add(B.ACTION_NOT_ALLOWED);
    if (projection.targetSystem !== providerTargetId
      || RESERVED_PROVIDER_TARGET_IDS.has(providerTargetId.toLowerCase())
      || RESERVED_PROVIDER_TARGET_IDS.has(String(projection.targetSystem || "").toLowerCase())) {
      blockers.add(B.TARGET_SYSTEM_NOT_ALLOWED);
    }
  }

  const matches = registry.filter(({ target }) => target.targetId === providerTargetId);
  if (matches.length === 0) blockers.add(B.ALLOWLIST_NOT_FOUND);
  if (matches.length > 1) blockers.add(B.ALLOWLIST_AMBIGUOUS);
  if (matches.length === 1) {
    const { target, stale } = matches[0];
    if (!target.active) blockers.add(B.ALLOWLIST_INACTIVE);
    if (stale || target.revision !== request.providerRevision
      || target.fingerprint !== request.providerFingerprint) {
      blockers.add(B.ALLOWLIST_STALE);
    }
    if (target.domain !== domain) blockers.add(B.DOMAIN_NOT_ALLOWED);
    if (target.operation !== operation) blockers.add(B.ACTION_NOT_ALLOWED);
    if (target.scope.type !== scope.type || target.scope.id !== scope.id) {
      blockers.add(B.SCOPE_NOT_ALLOWED);
    }
    if (scope.type === "location" && projection.locationId !== undefined
      && projection.locationId !== scope.id) {
      blockers.add(B.SCOPE_NOT_ALLOWED);
    }
    if (scope.type === "department" && projection.departmentId !== undefined
      && projection.departmentId !== scope.id) {
      blockers.add(B.SCOPE_NOT_ALLOWED);
    }
    const configuredFields = new Set(target.allowedFields);
    const fieldContract = PERSONNEL_LIFECYCLE_INTERFACE_PROVIDER_FIELDS[domain];
    const requestedFields = [...fieldContract.defaultPayloadFields, ...providerFields];
    if (requestedFields.some((field) => !configuredFields.has(field))
      || providerFields.some((field) => !fieldContract.optionalProviderFields.includes(field))) {
      blockers.add(B.PROVIDER_FIELD_NOT_ALLOWLISTED);
    }
    if (providerFields.some((field) => typeof projection[field] !== "string"
      || projection[field].trim() === "")) {
      blockers.add(B.PROVIDER_FIELD_VALUE_MISSING);
    }
  }
  if (blockers.size > 0) return blocked(blockers);
  return deepFreeze({
    status: "ready",
    blockerCodes: [],
    payloadPreview: buildPayload(request),
  });
}

const DOMAIN_LABELS = Object.freeze({
  training: "Schulung",
  asset: "Arbeitsmittel",
  access: "Zugang",
});

function personnelLifecycleInterfaceCatalog(
  visibleDomainIds = PERSONNEL_LIFECYCLE_INTERFACE_DOMAIN_IDS,
  registry = PERSONNEL_LIFECYCLE_INTERFACE_DEFAULT_PROVIDER_REGISTRY,
) {
  const domainIds = assertStringArray(visibleDomainIds, "visibleDomainIds");
  if (domainIds.some((id) => !PERSONNEL_LIFECYCLE_INTERFACE_DOMAIN_IDS.includes(id))) {
    throw contractError("O6_DOMAIN_INVALID", "visibleDomainIds contains an unknown domain.");
  }
  const inspectedRegistry = normalizeRegistry(registry);
  const providers = inspectedRegistry
    .filter(({ target }) => domainIds.includes(target.domain))
    .map(({ target, stale }) => ({ target, stale }));
  const domains = domainIds.map((id) => {
    const domainProviders = providers.filter(({ target }) => target.domain === id);
    return {
      id,
      label: DOMAIN_LABELS[id],
      status: "blocked",
      blockerCodes: Object.freeze([PERSONNEL_LIFECYCLE_INTERFACE_BLOCKERS.ALLOWLIST_NOT_FOUND]),
      operations: PERSONNEL_LIFECYCLE_INTERFACE_DOMAIN_OPERATIONS[id],
      maximumProjectionFields: PERSONNEL_LIFECYCLE_INTERFACE_PROVIDER_FIELDS[id]
        .maximumProjectionFields,
      defaultPayloadFields: PERSONNEL_LIFECYCLE_INTERFACE_PROVIDER_FIELDS[id]
        .defaultPayloadFields,
      optionalProviderFields: PERSONNEL_LIFECYCLE_INTERFACE_PROVIDER_FIELDS[id]
        .optionalProviderFields,
      providerCount: domainProviders.length,
      externalEffectsEnabled: false,
    };
  });
  return deepFreeze({
    contractVersion: PERSONNEL_LIFECYCLE_INTERFACE_CONTRACT_VERSION,
    registry: {
      providerCount: providers.length,
      activeProviderCount: providers.filter(({ target, stale }) => target.active && !stale).length,
      customerConfigured: providers.length > 0,
    },
    runtimeGates: { ...PERSONNEL_LIFECYCLE_INTERFACE_RUNTIME_GATES },
    domains,
  });
}

function assertPersonnelLifecycleInterfaceContract() {
  if (new Set(PERSONNEL_LIFECYCLE_INTERFACE_PERMISSION_IDS).size
    !== PERSONNEL_LIFECYCLE_INTERFACE_PERMISSION_IDS.length) {
    throw new Error("O6 contains duplicate permissions.");
  }
  if (Object.keys(PERSONNEL_LIFECYCLE_INTERFACE_ROLE_GRANTS).length !== 0) {
    throw new Error("O6 must not grant interface permissions to roles.");
  }
  if (PERSONNEL_LIFECYCLE_INTERFACE_DEFAULT_PROVIDER_REGISTRY.length !== 0) {
    throw new Error("O6 must start with an empty provider registry.");
  }
  if (Object.values(PERSONNEL_LIFECYCLE_INTERFACE_RUNTIME_GATES).some(Boolean)) {
    throw new Error("O6 must not enable external effects.");
  }
  return true;
}

assertPersonnelLifecycleInterfaceContract();

module.exports = {
  PERSONNEL_LIFECYCLE_INTERFACE_CONTRACT_VERSION,
  PERSONNEL_LIFECYCLE_INTERFACE_SCHEMA_VERSION,
  PERSONNEL_LIFECYCLE_INTERFACE_DOMAINS,
  PERSONNEL_LIFECYCLE_INTERFACE_DOMAIN_IDS,
  PERSONNEL_LIFECYCLE_INTERFACE_OPERATIONS,
  PERSONNEL_LIFECYCLE_INTERFACE_DOMAIN_OPERATIONS,
  PERSONNEL_LIFECYCLE_INTERFACE_OPERATION_IDS,
  PERSONNEL_LIFECYCLE_INTERFACE_ACTIONABLE_TASK_STATUSES,
  PERSONNEL_LIFECYCLE_INTERFACE_PERMISSIONS,
  PERSONNEL_LIFECYCLE_INTERFACE_PERMISSION_IDS,
  PERSONNEL_LIFECYCLE_INTERFACE_ROLE_GRANTS,
  PERSONNEL_LIFECYCLE_INTERFACE_PROVIDER_FIELDS,
  PERSONNEL_LIFECYCLE_INTERFACE_BLOCKERS,
  PERSONNEL_LIFECYCLE_INTERFACE_DEFAULT_PROVIDER_REGISTRY,
  PERSONNEL_LIFECYCLE_INTERFACE_RUNTIME_GATES,
  createPersonnelLifecycleInterfaceProviderTarget,
  preflightPersonnelLifecycleInterfaceCommand,
  personnelLifecycleInterfaceCatalog,
  assertPersonnelLifecycleInterfaceContract,
};
