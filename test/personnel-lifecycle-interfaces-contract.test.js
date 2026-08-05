"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PERSONNEL_LIFECYCLE_INTERFACE_CONTRACT_VERSION,
  PERSONNEL_LIFECYCLE_INTERFACE_SCHEMA_VERSION,
  PERSONNEL_LIFECYCLE_INTERFACE_DOMAIN_IDS,
  PERSONNEL_LIFECYCLE_INTERFACE_OPERATIONS: O,
  PERSONNEL_LIFECYCLE_INTERFACE_DOMAIN_OPERATIONS,
  PERSONNEL_LIFECYCLE_INTERFACE_OPERATION_IDS,
  PERSONNEL_LIFECYCLE_INTERFACE_ACTIONABLE_TASK_STATUSES,
  PERSONNEL_LIFECYCLE_INTERFACE_PERMISSIONS: P,
  PERSONNEL_LIFECYCLE_INTERFACE_PERMISSION_IDS,
  PERSONNEL_LIFECYCLE_INTERFACE_ROLE_GRANTS,
  PERSONNEL_LIFECYCLE_INTERFACE_PROVIDER_FIELDS,
  PERSONNEL_LIFECYCLE_INTERFACE_BLOCKERS: B,
  PERSONNEL_LIFECYCLE_INTERFACE_DEFAULT_PROVIDER_REGISTRY,
  PERSONNEL_LIFECYCLE_INTERFACE_RUNTIME_GATES,
  createPersonnelLifecycleInterfaceProviderTarget,
  preflightPersonnelLifecycleInterfaceCommand,
  personnelLifecycleInterfaceCatalog,
  assertPersonnelLifecycleInterfaceContract,
} = require("../lib/personnel-lifecycle-interfaces-contract");

const GLOBAL_SCOPE = Object.freeze({ type: "global", id: null });
const COMMAND_ID = "00000000-0000-4000-8000-000000000001";

function defaultAllowedFields(domain, optionalFields = []) {
  return [
    ...PERSONNEL_LIFECYCLE_INTERFACE_PROVIDER_FIELDS[domain].defaultPayloadFields,
    ...optionalFields,
  ];
}

function provider(overrides = {}) {
  const domain = overrides.domain || "training";
  const operation = overrides.operation || O.TRAINING_ASSIGN;
  return createPersonnelLifecycleInterfaceProviderTarget({
    targetId: "provider-a",
    active: true,
    revision: 1,
    domain,
    operation,
    scope: GLOBAL_SCOPE,
    allowedFields: defaultAllowedFields(domain),
    ...overrides,
  });
}

function trainingRequest(target, overrides = {}) {
  return {
    registry: [target],
    providerTargetId: target.targetId,
    providerRevision: target.revision,
    providerFingerprint: target.fingerprint,
    scope: GLOBAL_SCOPE,
    domain: "training",
    operation: O.TRAINING_ASSIGN,
    commandId: COMMAND_ID,
    projection: {
      orderId: "order-1",
      displayName: "Erika Beispiel",
      locationId: "location-1",
      departmentId: "department-1",
      module: "safety-basics",
      dueAt: "2026-09-01T08:00:00.000Z",
      evidenceStatus: "open",
      status: "pending",
    },
    providerFields: [],
    ...overrides,
  };
}

test("O6-Vertrag trennt drei Domaenen und je vier Rechte ohne Rollengrant", () => {
  assert.equal(PERSONNEL_LIFECYCLE_INTERFACE_CONTRACT_VERSION, "o6-v0.1");
  assert.equal(PERSONNEL_LIFECYCLE_INTERFACE_SCHEMA_VERSION,
    "personnel-lifecycle-interface-command/v1");
  assert.deepEqual(PERSONNEL_LIFECYCLE_INTERFACE_DOMAIN_IDS, [
    "training", "asset", "access",
  ]);
  assert.deepEqual(PERSONNEL_LIFECYCLE_INTERFACE_DOMAIN_OPERATIONS, {
    training: ["training_assign", "training_status", "training_evidence"],
    asset: ["asset_issue", "asset_return"],
    access: ["access_grant", "access_change", "access_revoke"],
  });
  assert.equal(PERSONNEL_LIFECYCLE_INTERFACE_OPERATION_IDS.length, 8);
  assert.deepEqual(PERSONNEL_LIFECYCLE_INTERFACE_ACTIONABLE_TASK_STATUSES, [
    "pending", "active",
  ]);
  assert.deepEqual(P, {
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
  assert.deepEqual(PERSONNEL_LIFECYCLE_INTERFACE_PERMISSION_IDS, Object.values(P));
  assert.deepEqual(PERSONNEL_LIFECYCLE_INTERFACE_ROLE_GRANTS, {});
  assert.deepEqual(PERSONNEL_LIFECYCLE_INTERFACE_DEFAULT_PROVIDER_REGISTRY, []);
  assert.equal(Object.values(PERSONNEL_LIFECYCLE_INTERFACE_RUNTIME_GATES).some(Boolean), false);
  assert.equal(assertPersonnelLifecycleInterfaceContract(), true);
});

test("datenarmer Katalog startet providerlos und bleibt tief eingefroren", () => {
  const catalog = personnelLifecycleInterfaceCatalog();
  assert.deepEqual(catalog, {
    contractVersion: "o6-v0.1",
    registry: {
      providerCount: 0,
      activeProviderCount: 0,
      customerConfigured: false,
    },
    runtimeGates: {
      networkDispatch: false,
      persistence: false,
      outbox: false,
      externalMutation: false,
    },
    domains: [
      {
        id: "training",
        label: "Schulung",
        status: "blocked",
        blockerCodes: [B.ALLOWLIST_NOT_FOUND],
        operations: [O.TRAINING_ASSIGN, O.TRAINING_STATUS, O.TRAINING_EVIDENCE],
        maximumProjectionFields: [
          "orderId", "displayName", "locationId", "departmentId", "module", "dueAt",
          "evidenceStatus", "status",
        ],
        defaultPayloadFields: [
          "schemaVersion", "commandId", "orderId", "operation", "module", "dueAt",
          "evidenceStatus",
        ],
        optionalProviderFields: ["locationId", "departmentId", "displayName"],
        providerCount: 0,
        externalEffectsEnabled: false,
      },
      {
        id: "asset",
        label: "Arbeitsmittel",
        status: "blocked",
        blockerCodes: [B.ALLOWLIST_NOT_FOUND],
        operations: [O.ASSET_ISSUE, O.ASSET_RETURN],
        maximumProjectionFields: [
          "orderId", "displayName", "locationId", "assetIdentifier", "action", "dueAt",
          "status",
        ],
        defaultPayloadFields: [
          "schemaVersion", "commandId", "orderId", "operation", "assetIdentifier",
          "locationId", "effectiveAt",
        ],
        optionalProviderFields: ["displayName"],
        providerCount: 0,
        externalEffectsEnabled: false,
      },
      {
        id: "access",
        label: "Zugang",
        status: "blocked",
        blockerCodes: [B.ALLOWLIST_NOT_FOUND],
        operations: [O.ACCESS_GRANT, O.ACCESS_CHANGE, O.ACCESS_REVOKE],
        maximumProjectionFields: [
          "orderId", "displayName", "businessIdentifier", "targetSystem", "action", "executeAt",
          "status",
        ],
        defaultPayloadFields: [
          "schemaVersion", "commandId", "orderId", "operation", "businessIdentifier",
          "targetSystem", "effectiveAt",
        ],
        optionalProviderFields: ["displayName"],
        providerCount: 0,
        externalEffectsEnabled: false,
      },
    ],
  });
  assert.equal(Object.isFrozen(catalog), true);
  assert.equal(Object.isFrozen(catalog.registry), true);
  assert.equal(Object.isFrozen(catalog.runtimeGates), true);
  assert.equal(Object.isFrozen(catalog.domains), true);
  assert.equal(Object.isFrozen(catalog.domains[0].operations), true);
  for (const domain of catalog.domains) {
    assert.equal(domain.defaultPayloadFields.includes("schemaVersion"), true);
    assert.equal(domain.maximumProjectionFields.includes("schemaVersion"), false);
  }
  assert.equal(
    catalog.domains.find(({ id }) => id === "asset").defaultPayloadFields.includes("effectiveAt"),
    true,
  );
  assert.equal(
    catalog.domains.find(({ id }) => id === "asset").maximumProjectionFields.includes("dueAt"),
    true,
  );
  assert.deepEqual(personnelLifecycleInterfaceCatalog(["access"]).domains.map(({ id }) => id), [
    "access",
  ]);
  const hiddenAccessProvider = provider({
    targetId: "hidden-access-provider",
    domain: "access",
    operation: O.ACCESS_REVOKE,
  });
  assert.deepEqual(
    personnelLifecycleInterfaceCatalog(["training"], [hiddenAccessProvider]).registry,
    { providerCount: 0, activeProviderCount: 0, customerConfigured: false },
  );
  assert.throws(
    () => personnelLifecycleInterfaceCatalog(["access", "access"]),
    { code: "O6_VALUE_INVALID" },
  );
  assert.throws(
    () => personnelLifecycleInterfaceCatalog(["payroll"]),
    { code: "O6_DOMAIN_INVALID" },
  );
});

test("Providerziel ist explizit, revisioniert, gefingerprinted und ohne Endpunkt oder Secret", () => {
  const target = provider();
  assert.match(target.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(target), true);
  assert.equal(Object.isFrozen(target.scope), true);
  assert.equal(Object.isFrozen(target.allowedFields), true);
  assert.throws(
    () => createPersonnelLifecycleInterfaceProviderTarget({
      targetId: "provider-a",
      active: true,
      revision: 1,
      domain: "training",
      operation: O.TRAINING_ASSIGN,
      scope: GLOBAL_SCOPE,
      allowedFields: defaultAllowedFields("training"),
      endpoint: "https://example.invalid",
    }),
    { code: "O6_FIELDS_INVALID" },
  );
  assert.throws(
    () => provider({
      allowedFields: [...defaultAllowedFields("training"), "employeeNumber"],
    }),
    { code: "O6_PROVIDER_FIELDS_INVALID" },
  );
  assert.throws(
    () => provider({ secret: "must-not-exist" }),
    { code: "O6_FIELDS_INVALID" },
  );
});

test("Getter, Symbole und nicht sichtbare Zusatzfelder werden ohne Auswertung verworfen", () => {
  let getterRead = false;
  const dynamicProvider = {
    targetId: "provider-a",
    active: true,
    revision: 1,
    domain: "training",
    operation: O.TRAINING_ASSIGN,
    scope: GLOBAL_SCOPE,
    allowedFields: defaultAllowedFields("training"),
  };
  Object.defineProperty(dynamicProvider, "allowedFields", {
    enumerable: true,
    configurable: true,
    get() {
      getterRead = true;
      return defaultAllowedFields("training");
    },
  });
  assert.throws(
    () => createPersonnelLifecycleInterfaceProviderTarget(dynamicProvider),
    { code: "O6_FIELDS_INVALID" },
  );
  assert.equal(getterRead, false);

  const dynamicFields = defaultAllowedFields("training");
  Object.defineProperty(dynamicFields, "0", {
    enumerable: true,
    configurable: true,
    get() {
      getterRead = true;
      return "schemaVersion";
    },
  });
  assert.throws(
    () => provider({ allowedFields: dynamicFields }),
    { code: "O6_VALUE_INVALID" },
  );
  assert.equal(getterRead, false);

  const target = provider();
  const dynamicRegistry = [target];
  Object.defineProperty(dynamicRegistry, "0", {
    enumerable: true,
    configurable: true,
    get() {
      getterRead = true;
      return target;
    },
  });
  assert.throws(
    () => preflightPersonnelLifecycleInterfaceCommand(trainingRequest(target, {
      registry: dynamicRegistry,
    })),
    { code: "O6_REGISTRY_INVALID" },
  );
  assert.equal(getterRead, false);

  const hiddenProjection = trainingRequest(target);
  Object.defineProperty(hiddenProjection.projection, "secret", {
    value: "must-not-pass",
    enumerable: false,
  });
  assert.throws(
    () => preflightPersonnelLifecycleInterfaceCommand(hiddenProjection),
    { code: "O6_FIELDS_INVALID" },
  );

  const symbolicProjection = trainingRequest(target);
  symbolicProjection.projection[Symbol("secret")] = "must-not-pass";
  assert.throws(
    () => preflightPersonnelLifecycleInterfaceCommand(symbolicProjection),
    { code: "O6_FIELDS_INVALID" },
  );

  let proxyTrapRead = false;
  const proxiedProvider = new Proxy({
    targetId: "provider-a",
    active: true,
    revision: 1,
    domain: "training",
    operation: O.TRAINING_ASSIGN,
    scope: GLOBAL_SCOPE,
    allowedFields: defaultAllowedFields("training"),
  }, {
    ownKeys(value) {
      proxyTrapRead = true;
      return Reflect.ownKeys(value);
    },
    getOwnPropertyDescriptor(value, key) {
      proxyTrapRead = true;
      return Reflect.getOwnPropertyDescriptor(value, key);
    },
  });
  assert.throws(
    () => createPersonnelLifecycleInterfaceProviderTarget(proxiedProvider),
    { code: "O6_RECORD_INVALID" },
  );
  assert.equal(proxyTrapRead, false);

  const proxiedRegistry = new Proxy([target], {
    ownKeys(value) {
      proxyTrapRead = true;
      return Reflect.ownKeys(value);
    },
    getOwnPropertyDescriptor(value, key) {
      proxyTrapRead = true;
      return Reflect.getOwnPropertyDescriptor(value, key);
    },
  });
  assert.throws(
    () => preflightPersonnelLifecycleInterfaceCommand(trainingRequest(target, {
      registry: proxiedRegistry,
    })),
    { code: "O6_REGISTRY_INVALID" },
  );
  assert.equal(proxyTrapRead, false);

  const trapProxy = (value) => new Proxy(value, {
    get(targetValue, key, receiver) {
      proxyTrapRead = true;
      return Reflect.get(targetValue, key, receiver);
    },
    getPrototypeOf(targetValue) {
      proxyTrapRead = true;
      return Reflect.getPrototypeOf(targetValue);
    },
    ownKeys(targetValue) {
      proxyTrapRead = true;
      return Reflect.ownKeys(targetValue);
    },
    getOwnPropertyDescriptor(targetValue, key) {
      proxyTrapRead = true;
      return Reflect.getOwnPropertyDescriptor(targetValue, key);
    },
  });
  const assertProxyRejectedWithoutTrap = (operation, code) => {
    proxyTrapRead = false;
    assert.throws(operation, { code });
    assert.equal(proxyTrapRead, false);
  };

  assertProxyRejectedWithoutTrap(
    () => preflightPersonnelLifecycleInterfaceCommand(trapProxy(trainingRequest(target))),
    "O6_RECORD_INVALID",
  );
  assertProxyRejectedWithoutTrap(
    () => preflightPersonnelLifecycleInterfaceCommand(trainingRequest(target, {
      projection: trapProxy(trainingRequest(target).projection),
    })),
    "O6_RECORD_INVALID",
  );
  assertProxyRejectedWithoutTrap(
    () => provider({ scope: trapProxy(GLOBAL_SCOPE) }),
    "O6_RECORD_INVALID",
  );
  assertProxyRejectedWithoutTrap(
    () => preflightPersonnelLifecycleInterfaceCommand(trainingRequest(target, {
      registry: [trapProxy(target)],
    })),
    "O6_RECORD_INVALID",
  );
  assertProxyRejectedWithoutTrap(
    () => provider({ allowedFields: trapProxy(defaultAllowedFields("training")) }),
    "O6_VALUE_INVALID",
  );
  assertProxyRejectedWithoutTrap(
    () => preflightPersonnelLifecycleInterfaceCommand(trainingRequest(target, {
      providerFields: trapProxy([]),
    })),
    "O6_VALUE_INVALID",
  );
  assertProxyRejectedWithoutTrap(
    () => personnelLifecycleInterfaceCatalog(trapProxy(["training"])),
    "O6_VALUE_INVALID",
  );
});

test("Training-Standardpayload ist minimal und enthaelt keine HR- oder Laufzeitkennungen", () => {
  const target = provider();
  const result = preflightPersonnelLifecycleInterfaceCommand(trainingRequest(target));
  assert.equal(result.status, "ready");
  assert.deepEqual(result.blockerCodes, []);
  assert.deepEqual(result.payloadPreview, {
    schemaVersion: PERSONNEL_LIFECYCLE_INTERFACE_SCHEMA_VERSION,
    commandId: COMMAND_ID,
    orderId: "order-1",
    operation: O.TRAINING_ASSIGN,
    module: "safety-basics",
    dueAt: "2026-09-01T08:00:00.000Z",
    evidenceStatus: "open",
  });
  for (const forbidden of [
    "caseId", "runId", "stepId", "employeeNumber", "displayName", "locationId",
    "departmentId",
  ]) {
    assert.equal(Object.hasOwn(result.payloadPreview, forbidden), false, forbidden);
  }
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.blockerCodes), true);
  assert.equal(Object.isFrozen(result.payloadPreview), true);
});

test("displayName und Organisationsscope erscheinen nur nach expliziter Provider-Positivliste", () => {
  const target = provider({
    allowedFields: defaultAllowedFields("training", [
      "displayName", "locationId", "departmentId",
    ]),
  });
  const defaultResult = preflightPersonnelLifecycleInterfaceCommand(trainingRequest(target));
  assert.equal(Object.hasOwn(defaultResult.payloadPreview, "displayName"), false);
  assert.equal(Object.hasOwn(defaultResult.payloadPreview, "locationId"), false);

  const explicitResult = preflightPersonnelLifecycleInterfaceCommand(trainingRequest(target, {
    providerFields: ["locationId", "departmentId", "displayName"],
  }));
  assert.equal(explicitResult.status, "ready");
  assert.deepEqual(explicitResult.payloadPreview, {
    schemaVersion: PERSONNEL_LIFECYCLE_INTERFACE_SCHEMA_VERSION,
    commandId: COMMAND_ID,
    orderId: "order-1",
    operation: O.TRAINING_ASSIGN,
    module: "safety-basics",
    dueAt: "2026-09-01T08:00:00.000Z",
    evidenceStatus: "open",
    locationId: "location-1",
    departmentId: "department-1",
    displayName: "Erika Beispiel",
  });

  const notAllowlisted = preflightPersonnelLifecycleInterfaceCommand(trainingRequest(provider(), {
    providerFields: ["displayName"],
  }));
  assert.equal(notAllowlisted.status, "blocked");
  assert.ok(notAllowlisted.blockerCodes.includes(B.PROVIDER_FIELD_NOT_ALLOWLISTED));
  assert.equal(notAllowlisted.payloadPreview, null);
});

test("Asset und Zugang nutzen ausdrueckliche Operationen und minimierte Zeitabbildung", () => {
  const assetTarget = provider({
    domain: "asset",
    operation: O.ASSET_RETURN,
    allowedFields: defaultAllowedFields("asset"),
  });
  const assetResult = preflightPersonnelLifecycleInterfaceCommand({
    registry: [assetTarget],
    providerTargetId: assetTarget.targetId,
    providerRevision: assetTarget.revision,
    providerFingerprint: assetTarget.fingerprint,
    scope: GLOBAL_SCOPE,
    domain: "asset",
    operation: O.ASSET_RETURN,
    commandId: "00000000-0000-4000-8000-000000000002",
    projection: {
      orderId: "order-asset",
      assetIdentifier: "asset-42",
      locationId: "location-1",
      action: O.ASSET_RETURN,
      dueAt: "2026-09-02T12:00:00.000Z",
      status: "pending",
    },
    providerFields: [],
  });
  assert.deepEqual(assetResult.payloadPreview, {
    schemaVersion: PERSONNEL_LIFECYCLE_INTERFACE_SCHEMA_VERSION,
    commandId: "00000000-0000-4000-8000-000000000002",
    orderId: "order-asset",
    operation: O.ASSET_RETURN,
    assetIdentifier: "asset-42",
    locationId: "location-1",
    effectiveAt: "2026-09-02T12:00:00.000Z",
  });

  const accessTarget = provider({
    targetId: "directory-a",
    domain: "access",
    operation: O.ACCESS_REVOKE,
    allowedFields: defaultAllowedFields("access"),
  });
  const accessResult = preflightPersonnelLifecycleInterfaceCommand({
    registry: [accessTarget],
    providerTargetId: accessTarget.targetId,
    providerRevision: accessTarget.revision,
    providerFingerprint: accessTarget.fingerprint,
    scope: GLOBAL_SCOPE,
    domain: "access",
    operation: O.ACCESS_REVOKE,
    commandId: "00000000-0000-4000-8000-000000000003",
    projection: {
      orderId: "order-access",
      businessIdentifier: "user-17",
      targetSystem: "directory-a",
      action: O.ACCESS_REVOKE,
      executeAt: "2026-09-03T16:00:00.000Z",
      status: "active",
    },
    providerFields: [],
  });
  assert.deepEqual(accessResult.payloadPreview, {
    schemaVersion: PERSONNEL_LIFECYCLE_INTERFACE_SCHEMA_VERSION,
    commandId: "00000000-0000-4000-8000-000000000003",
    orderId: "order-access",
    operation: O.ACCESS_REVOKE,
    businessIdentifier: "user-17",
    targetSystem: "directory-a",
    effectiveAt: "2026-09-03T16:00:00.000Z",
  });
});

test("leere, inaktive, falsche und unvollstaendige Positivlisten sperren fail-closed", () => {
  const target = provider();
  const noTarget = preflightPersonnelLifecycleInterfaceCommand(trainingRequest(target, {
    registry: [],
  }));
  assert.deepEqual(noTarget.blockerCodes, [B.ALLOWLIST_NOT_FOUND]);
  assert.equal(noTarget.payloadPreview, null);

  const inactive = provider({ active: false });
  const inactiveResult = preflightPersonnelLifecycleInterfaceCommand(trainingRequest(inactive));
  assert.ok(inactiveResult.blockerCodes.includes(B.ALLOWLIST_INACTIVE));

  const wrongActionTarget = provider({ operation: O.TRAINING_STATUS });
  const wrongAction = preflightPersonnelLifecycleInterfaceCommand(trainingRequest(wrongActionTarget));
  assert.ok(wrongAction.blockerCodes.includes(B.ACTION_NOT_ALLOWED));

  const locationTarget = provider({ scope: { type: "location", id: "location-2" } });
  const wrongScope = preflightPersonnelLifecycleInterfaceCommand(trainingRequest(locationTarget, {
    scope: { type: "location", id: "location-1" },
  }));
  assert.ok(wrongScope.blockerCodes.includes(B.SCOPE_NOT_ALLOWED));

  const incomplete = provider({
    allowedFields: defaultAllowedFields("training").filter((field) => field !== "module"),
  });
  const incompleteResult = preflightPersonnelLifecycleInterfaceCommand(trainingRequest(incomplete));
  assert.ok(incompleteResult.blockerCodes.includes(B.PROVIDER_FIELD_NOT_ALLOWLISTED));
  assert.equal(incompleteResult.payloadPreview, null);
});

test("fehlende Kennungen werden feldgenau blockiert und nie als Vorschau ausgegeben", () => {
  const target = provider();
  const result = preflightPersonnelLifecycleInterfaceCommand(trainingRequest(target, {
    providerTargetId: "",
    commandId: "",
    projection: {
      orderId: "",
      module: "",
      dueAt: "",
      evidenceStatus: "",
      status: "pending",
    },
  }));
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blockerCodes, [
    B.PROVIDER_TARGET_IDENTIFIER_MISSING,
    B.COMMAND_IDENTIFIER_MISSING,
    B.ORDER_IDENTIFIER_MISSING,
    B.MODULE_IDENTIFIER_MISSING,
    B.DUE_AT_MISSING,
    B.EVIDENCE_STATUS_MISSING,
    B.ALLOWLIST_NOT_FOUND,
  ]);
  assert.equal(result.payloadPreview, null);
});

test("reale null-Werte der O1-Arbeitsmittelprojektion werden fachlich statt strukturell gesperrt", () => {
  const target = provider({
    domain: "asset",
    operation: O.ASSET_ISSUE,
    allowedFields: defaultAllowedFields("asset"),
  });
  const result = preflightPersonnelLifecycleInterfaceCommand({
    registry: [target],
    providerTargetId: target.targetId,
    providerRevision: target.revision,
    providerFingerprint: target.fingerprint,
    scope: GLOBAL_SCOPE,
    domain: "asset",
    operation: O.ASSET_ISSUE,
    commandId: "00000000-0000-4000-8000-000000000004",
    projection: {
      orderId: "order-asset-null",
      displayName: "Erika Beispiel",
      locationId: null,
      assetIdentifier: null,
      action: O.ASSET_ISSUE,
      dueAt: null,
      status: "pending",
    },
    providerFields: [],
  });
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blockerCodes, [
    B.ASSET_IDENTIFIER_MISSING,
    B.LOCATION_IDENTIFIER_MISSING,
    B.EFFECTIVE_AT_MISSING,
  ]);
  assert.equal(result.payloadPreview, null);
});

test("nur aktuell bearbeitbare Aufgaben duerfen die interne Vorpruefung passieren", () => {
  const target = provider();
  for (const status of [undefined, null, "open", "completed", "cancelled", ""]) {
    const request = trainingRequest(target);
    if (status === undefined) delete request.projection.status;
    else request.projection.status = status;
    const result = preflightPersonnelLifecycleInterfaceCommand(request);
    assert.equal(result.status, "blocked");
    assert.ok(result.blockerCodes.includes(B.TASK_STATUS_NOT_ACTIONABLE), String(status));
    assert.equal(result.payloadPreview, null);
  }
});

test("geerbte Prototype-Werte koennen keine fehlende Aufgabenprojektion ersetzen", () => {
  const target = provider();
  const pollutedValues = {
    orderId: "inherited-order",
    module: "inherited-module",
    dueAt: "2026-09-01T08:00:00.000Z",
    evidenceStatus: "open",
    status: "pending",
  };
  for (const key of Object.keys(pollutedValues)) {
    assert.equal(Object.hasOwn(Object.prototype, key), false, key);
  }
  try {
    for (const [key, value] of Object.entries(pollutedValues)) {
      Object.defineProperty(Object.prototype, key, {
        value,
        configurable: true,
        enumerable: false,
        writable: true,
      });
    }
    const result = preflightPersonnelLifecycleInterfaceCommand(trainingRequest(target, {
      projection: {},
    }));
    assert.equal(result.status, "blocked");
    assert.ok(result.blockerCodes.includes(B.ORDER_IDENTIFIER_MISSING));
    assert.ok(result.blockerCodes.includes(B.MODULE_IDENTIFIER_MISSING));
    assert.ok(result.blockerCodes.includes(B.DUE_AT_MISSING));
    assert.ok(result.blockerCodes.includes(B.EVIDENCE_STATUS_MISSING));
    assert.ok(result.blockerCodes.includes(B.TASK_STATUS_NOT_ACTIONABLE));
    assert.equal(result.payloadPreview, null);
  } finally {
    for (const key of Object.keys(pollutedValues)) delete Object.prototype[key];
  }
});

test("bestehende O5-Freitext- und Sammelzielwerte bleiben nicht dispatchfaehig", () => {
  assert.throws(
    () => provider({
      targetId: "managed_accesses",
      domain: "access",
      operation: O.ACCESS_REVOKE,
      allowedFields: defaultAllowedFields("access"),
    }),
    { code: "O6_VALUE_INVALID" },
  );

  const target = provider({
    targetId: "directory-a",
    domain: "access",
    operation: O.ACCESS_REVOKE,
    allowedFields: defaultAllowedFields("access"),
  });
  const result = preflightPersonnelLifecycleInterfaceCommand({
    registry: [target],
    providerTargetId: target.targetId,
    providerRevision: target.revision,
    providerFingerprint: target.fingerprint,
    scope: GLOBAL_SCOPE,
    domain: "access",
    operation: O.ACCESS_REVOKE,
    commandId: "00000000-0000-4000-8000-000000000005",
    projection: {
      orderId: "order-o5-access",
      businessIdentifier: "user-17",
      targetSystem: "managed_accesses",
      action: "Alle verwalteten Zugaenge sperren",
      executeAt: "2026-09-03T16:00:00.000Z",
      status: "pending",
    },
    providerFields: [],
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockerCodes.includes(B.TARGET_SYSTEM_NOT_ALLOWED));
  assert.ok(result.blockerCodes.includes(B.ACTION_NOT_ALLOWED));
  assert.equal(result.payloadPreview, null);

  const matchingPlaceholder = preflightPersonnelLifecycleInterfaceCommand({
    registry: [],
    providerTargetId: "managed_accesses",
    providerRevision: 0,
    providerFingerprint: "",
    scope: GLOBAL_SCOPE,
    domain: "access",
    operation: O.ACCESS_REVOKE,
    commandId: "00000000-0000-4000-8000-000000000006",
    projection: {
      orderId: "order-o5-access-collision",
      businessIdentifier: "user-17",
      targetSystem: "managed_accesses",
      action: O.ACCESS_REVOKE,
      executeAt: "2026-09-03T16:00:00.000Z",
      status: "pending",
    },
    providerFields: [],
  });
  assert.equal(matchingPlaceholder.status, "blocked");
  assert.ok(matchingPlaceholder.blockerCodes.includes(B.TARGET_SYSTEM_NOT_ALLOWED));
  assert.ok(matchingPlaceholder.blockerCodes.includes(B.ALLOWLIST_NOT_FOUND));
  assert.equal(matchingPlaceholder.payloadPreview, null);
});

test("ungueltige Kommandokennung und ungebundene Eingaben bleiben fail-closed", () => {
  const target = provider();
  const invalidCommand = preflightPersonnelLifecycleInterfaceCommand(trainingRequest(target, {
    commandId: "command-1",
  }));
  assert.deepEqual(invalidCommand.blockerCodes, [B.COMMAND_IDENTIFIER_INVALID]);
  assert.equal(invalidCommand.payloadPreview, null);

  assert.throws(
    () => preflightPersonnelLifecycleInterfaceCommand(trainingRequest(target, {
      projection: {
        orderId: "order-1",
        module: `unsafe\nmodule`,
        dueAt: "2026-09-01T08:00:00.000Z",
        evidenceStatus: "open",
      },
    })),
    { code: "O6_VALUE_INVALID" },
  );
  assert.throws(
    () => provider({ targetId: "x".repeat(129) }),
    { code: "O6_VALUE_INVALID" },
  );
  assert.throws(
    () => provider({ scope: { type: "location", id: `location\r\ninjected` } }),
    { code: "O6_SCOPE_INVALID" },
  );
});

test("Revisiondrift und mehrdeutige Registry bleiben gesperrt", () => {
  const oldTarget = provider({ revision: 1 });
  const currentTarget = provider({ revision: 2 });
  const stale = preflightPersonnelLifecycleInterfaceCommand(trainingRequest(currentTarget, {
    providerRevision: oldTarget.revision,
    providerFingerprint: oldTarget.fingerprint,
  }));
  assert.deepEqual(stale.blockerCodes, [B.ALLOWLIST_STALE]);

  const secondTarget = provider({ revision: 2 });
  const ambiguous = preflightPersonnelLifecycleInterfaceCommand(trainingRequest(oldTarget, {
    registry: [oldTarget, secondTarget],
  }));
  assert.deepEqual(ambiguous.blockerCodes, [B.ALLOWLIST_AMBIGUOUS]);
  assert.equal(ambiguous.payloadPreview, null);

  const tampered = { ...oldTarget, active: false };
  const tamperedResult = preflightPersonnelLifecycleInterfaceCommand(trainingRequest(oldTarget, {
    registry: [tampered],
  }));
  assert.ok(tamperedResult.blockerCodes.includes(B.ALLOWLIST_INACTIVE));
  assert.ok(tamperedResult.blockerCodes.includes(B.ALLOWLIST_STALE));
});

test("Titel, Codes und Freitext koennen weder Domaene noch Aktion heuristisch setzen", () => {
  const target = provider();
  const missingDomain = trainingRequest(target);
  delete missingDomain.domain;
  missingDomain.title = "Zugang sofort sperren";
  assert.throws(
    () => preflightPersonnelLifecycleInterfaceCommand(missingDomain),
    { code: "O6_FIELDS_INVALID" },
  );

  assert.throws(
    () => preflightPersonnelLifecycleInterfaceCommand(trainingRequest(target, {
      projection: {
        orderId: "order-1",
        title: "Notebook zurueckholen",
        module: "safety-basics",
        dueAt: "2026-09-01T08:00:00.000Z",
        evidenceStatus: "open",
      },
    })),
    { code: "O6_FIELDS_INVALID" },
  );

  const arbitraryOperation = preflightPersonnelLifecycleInterfaceCommand(trainingRequest(target, {
    operation: "Aus dem Titel ableiten",
  }));
  assert.equal(arbitraryOperation.status, "blocked");
  assert.ok(arbitraryOperation.blockerCodes.includes(B.ACTION_NOT_ALLOWED));
  assert.equal(arbitraryOperation.payloadPreview, null);
});
