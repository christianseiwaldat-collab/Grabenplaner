"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createAmuStorage } = require("../lib/amu-storage");
const {
  createPersonnelLifecycleRepository,
} = require("../lib/persistence/repositories/personnel-lifecycle");
const {
  createOrganizationPersonnelRepository,
} = require("../lib/persistence/repositories/organization-personnel");
const {
  SQLITE_APPLICATION_CATALOG,
} = require("../lib/persistence/sqlite/application-catalog");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");
const {
  candidateConversionProtectionContext,
  createPersonnelLifecycleService,
} = require("../lib/personnel-lifecycle");
const { canonicalSha256 } = require("../lib/work-rules/receipt");

async function fixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_APPLICATION_CATALOG,
  });
  ensureSqliteApplicationSchema(application.database);
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-conversion-domain-"));
  const storage = createAmuStorage({
    rootDirectory: storageRoot,
    encryptionKeys: {
      test: crypto.createHash("sha256").update("personnel-conversion-domain-test-key").digest(),
    },
    activeKeyId: "test",
    scanner: async () => true,
  });
  const serviceFor = (repository, options = {}) => createPersonnelLifecycleService(repository, {
    protectJson: (value, context) => storage.protectRecord(JSON.stringify(value), context),
    parseProtectedJson: (value, context) => JSON.parse(storage.unprotectRecord(value, context)),
    ...options,
  });
  const repository = createPersonnelLifecycleRepository(application.provider);
  return {
    ...application,
    repository,
    service: serviceFor(repository),
    serviceFor,
    storage,
    async close() {
      try {
        await application.provider.close();
      } finally {
        application.database.close();
        fs.rmSync(storageRoot, { recursive: true, force: true });
      }
    },
  };
}

async function candidateAtPreboarding(service, suffix = "") {
  const candidate = await service.createCandidate({
    profile: {
      firstName: `Ada${suffix}`,
      lastName: "Beispiel",
      email: `ada${suffix || "test"}@example.invalid`,
      phone: "+43 660 1234567",
      address: {
        street: "Testweg 1",
        postalCode: "6020",
        city: "Innsbruck",
        country: "Österreich",
      },
    },
    application: {
      desiredRoleTitle: "Verkauf",
      employmentType: "Teilzeit",
      internalNotes: "vertraulicher Ausgangssnapshot",
    },
  }, "hr-100");
  let application = candidate.applications[0];
  for (const status of [
    "screening",
    "first_interview",
    "further_interview",
    "offer",
    "accepted",
    "preboarding",
  ]) {
    application = await service.transitionApplication(
      candidate.id,
      application.id,
      { status, revision: application.revision },
      "hr-100",
    );
  }
  return service.getCandidate(candidate.id);
}

function conversionInput(candidate, employeeNumber, id) {
  const application = candidate.applications[0];
  const employee = {
    nickname: candidate.profile.firstName,
    contractedHours: 30,
    targetWorkdaysPerWeek: 5,
  };
  return {
    id,
    employeeNumber,
    candidateRevision: candidate.revision,
    applicationRevision: application.revision,
    employee,
    requestSha256: canonicalSha256({
      schemaVersion: 1,
      candidateId: candidate.id,
      applicationId: application.id,
      employeeNumber,
      candidateRevision: candidate.revision,
      applicationRevision: application.revision,
      employee,
    }),
  };
}

async function convertInProviderTransaction(context, candidate, input, insertEmployee) {
  return context.provider.transaction(async (executor) => {
    const repository = createPersonnelLifecycleRepository(executor);
    const organization = createOrganizationPersonnelRepository(executor);
    const service = context.serviceFor(repository);
    return service.convertCandidateInTransaction(
      candidate.id,
      candidate.applications[0].id,
      input,
      "hr-100",
      (proposal, source) => insertEmployee(proposal, source, organization),
    );
  });
}

test("M3-Domäne: Umwandlung ist atomar, minimal projiziert und dauerhaft idempotent", async () => {
  const context = await fixture();
  try {
    const candidate = await candidateAtPreboarding(context.service);
    const input = conversionInput(
      candidate,
      "E-900",
      "3f15d60c-8a8e-4a7e-9b38-cd23147795db",
    );
    let callbackCalls = 0;
    const created = await convertInProviderTransaction(
      context,
      candidate,
      input,
      async (proposal, source, organization) => {
        callbackCalls += 1;
        assert.equal(source.candidate.revision, candidate.revision);
        assert.equal(source.application.revision, candidate.applications[0].revision);
        assert.equal(source.application.status, "preboarding");
        assert.equal(proposal.nickname, "Ada");
        const employee = {
          personnelNumber: input.employeeNumber,
          fullName: `${source.candidate.profile.firstName} ${source.candidate.profile.lastName}`,
          nickname: proposal.nickname,
          color: "#0b84c6",
          contractedHours: proposal.contractedHours,
          targetWorkdaysPerWeek: proposal.targetWorkdaysPerWeek,
          preferredDayOff: null,
          fixedWorkdays: "",
          positionId: "verkaufsmitarbeiter",
          timeConfirmationLevel: "C",
          sicknessWithoutAumEnabled: false,
          homeLocationId: null,
          preferredDepartmentId: null,
          costCenterId: null,
          active: true,
          personnelRecord: {
            privateEmail: source.candidate.profile.email,
            address: source.candidate.profile.address,
          },
        };
        await organization.insertEmployee(employee);
        return employee;
      },
    );

    assert.equal(callbackCalls, 1);
    assert.equal(created.replayed, false);
    assert.equal(created.candidate.state, "archived");
    assert.equal(created.candidate.revision, candidate.revision + 1);
    assert.equal(created.candidate.applications[0].status, "converted");
    assert.equal(
      created.candidate.applications[0].revision,
      candidate.applications[0].revision + 1,
    );
    assert.deepEqual(Object.keys(created.conversion).sort(), [
      "actorEmployeeNumber",
      "applicationId",
      "candidateId",
      "createdAt",
      "employeeNumber",
      "id",
    ]);
    assert.equal(created.conversion.employeeNumber, "E-900");
    assert.equal(created.candidate.conversion.id, created.conversion.id);
    assert.equal(Object.hasOwn(created.conversion, "protectedPayload"), false);
    assert.equal(Object.hasOwn(created.conversion, "requestSha256"), false);
    assert.equal(Object.hasOwn(created.conversion, "receiptSha256"), false);

    const stored = context.database.prepare("SELECT * FROM candidate_conversions").get();
    const protectedSnapshot = JSON.parse(context.storage.unprotectRecord(
      stored.protected_payload,
      candidateConversionProtectionContext(stored),
    ));
    assert.deepEqual(protectedSnapshot.policies, {
      documentTransfer: "none",
      onboarding: "deferred",
      portalAccess: "none",
    });
    assert.equal(protectedSnapshot.requestSha256, input.requestSha256);
    assert.equal(protectedSnapshot.source.candidate.revision, candidate.revision);
    assert.equal(protectedSnapshot.source.application.status, "preboarding");
    assert.equal(protectedSnapshot.target.employee.personnelNumber, "E-900");
    assert.equal(protectedSnapshot.target.employee.personnelRecord.privateEmail, "adatest@example.invalid");

    const eventCount = context.database.prepare(`
      SELECT COUNT(*) AS count FROM candidate_events WHERE candidate_id = ?
    `).get(candidate.id).count;
    const replayed = await convertInProviderTransaction(
      context,
      candidate,
      input,
      async () => {
        throw new Error("Der Replay-Pfad darf die Mitarbeiteranlage nicht aufrufen.");
      },
    );
    assert.equal(replayed.replayed, true);
    assert.deepEqual(replayed.conversion, created.conversion);
    assert.equal(context.database.prepare("SELECT COUNT(*) AS count FROM employees WHERE personnel_number = 'E-900'").get().count, 1);
    assert.equal(context.database.prepare("SELECT COUNT(*) AS count FROM candidate_conversions").get().count, 1);
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS count FROM candidate_events WHERE candidate_id = ?
    `).get(candidate.id).count, eventCount);

    await assert.rejects(
      convertInProviderTransaction(
        context,
        candidate,
        { ...input, requestSha256: "f".repeat(64) },
        async () => {
          throw new Error("Auch der Konfliktpfad darf die Mitarbeiteranlage nicht aufrufen.");
        },
      ),
      (error) => error.code === "PERSONNEL_LIFECYCLE_CONVERSION_IDEMPOTENCY_CONFLICT",
    );
    assert.equal((await context.service.verifyIntegrity()).candidates, 1);
  } finally {
    await context.close();
  }
});

test("M3-Domäne: ungültiger Callback-Zielbeleg rollt alle Schreibschritte zurück", async () => {
  const context = await fixture();
  try {
    const candidate = await candidateAtPreboarding(context.service, "rollback");
    const input = conversionInput(
      candidate,
      "E-901",
      "a7f7bc60-5d86-4f4e-96ea-90ca7387b2fb",
    );
    const eventsBefore = context.database.prepare(`
      SELECT COUNT(*) AS count FROM candidate_events WHERE candidate_id = ?
    `).get(candidate.id).count;
    await assert.rejects(
      convertInProviderTransaction(context, candidate, input, async (proposal, source, organization) => {
        await organization.insertEmployee({
          personnelNumber: input.employeeNumber,
          fullName: `${source.candidate.profile.firstName} Beispiel`,
          nickname: proposal.nickname,
          color: "#0b84c6",
          contractedHours: proposal.contractedHours,
          targetWorkdaysPerWeek: proposal.targetWorkdaysPerWeek,
          preferredDayOff: null,
          fixedWorkdays: "",
          positionId: "verkaufsmitarbeiter",
          timeConfirmationLevel: "C",
          sicknessWithoutAumEnabled: false,
          homeLocationId: null,
          preferredDepartmentId: null,
          costCenterId: null,
          active: true,
        });
        return { personnelNumber: "ANDERE-NUMMER" };
      }),
      (error) => error.code === "PERSONNEL_LIFECYCLE_CONVERSION_EMPLOYEE_INTEGRITY_FAILED",
    );
    const unchanged = await context.service.getCandidate(candidate.id);
    assert.equal(unchanged.state, "active");
    assert.equal(unchanged.applications[0].status, "preboarding");
    assert.equal(unchanged.conversion, null);
    assert.equal(context.database.prepare("SELECT COUNT(*) AS count FROM employees WHERE personnel_number = 'E-901'").get().count, 0);
    assert.equal(context.database.prepare("SELECT COUNT(*) AS count FROM candidate_conversions").get().count, 0);
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS count FROM candidate_events WHERE candidate_id = ?
    `).get(candidate.id).count, eventsBefore);
  } finally {
    await context.close();
  }
});

test("M3-Domäne: Statusautomat und weitere offene Bewerbungen sperren die Mitarbeiteranlage", async () => {
  const context = await fixture();
  try {
    const newCandidate = await context.service.createCandidate({
      profile: {
        firstName: "Noch",
        lastName: "Nichtbereit",
        email: "nichtbereit@example.invalid",
      },
      application: { desiredRoleTitle: "Verkauf" },
    }, "hr-100");
    const invalidStatusInput = conversionInput(
      newCandidate,
      "E-902",
      "1349cb93-7910-4dcb-9914-7c6dd6fce26e",
    );
    let callbackCalls = 0;
    await assert.rejects(
      convertInProviderTransaction(context, newCandidate, invalidStatusInput, async () => {
        callbackCalls += 1;
        return { personnelNumber: "E-902" };
      }),
      (error) => error.code === "PERSONNEL_LIFECYCLE_CONVERSION_STATUS_INVALID",
    );
    await assert.rejects(
      context.service.transitionApplication(
        newCandidate.id,
        newCandidate.applications[0].id,
        { status: "converted", revision: newCandidate.applications[0].revision },
        "hr-100",
      ),
      (error) => error.code === "PERSONNEL_LIFECYCLE_CONVERSION_NOT_AVAILABLE",
    );

    const ready = await candidateAtPreboarding(context.service, "open");
    await context.service.addApplication(ready.id, { desiredRoleTitle: "Zweite Bewerbung" }, "hr-100");
    const withOpenApplication = await context.service.getCandidate(ready.id);
    const target = withOpenApplication.applications.find(({ status }) => status === "preboarding");
    const targetView = { ...withOpenApplication, applications: [target] };
    const openInput = conversionInput(
      targetView,
      "E-903",
      "94147503-d9f6-4462-9346-35bfaf848677",
    );
    await assert.rejects(
      convertInProviderTransaction(context, targetView, openInput, async () => {
        callbackCalls += 1;
        return { personnelNumber: "E-903" };
      }),
      (error) => error.code === "PERSONNEL_LIFECYCLE_CONVERSION_OTHER_APPLICATION_OPEN",
    );
    assert.equal(callbackCalls, 0);
    assert.equal(context.database.prepare("SELECT COUNT(*) AS count FROM employees WHERE personnel_number IN ('E-902','E-903')").get().count, 0);
  } finally {
    await context.close();
  }
});

test("M3-Domäne: Integritätsprüfung weist einen neu signierten unzulässigen Policy-Snapshot ab", async () => {
  const context = await fixture();
  try {
    const candidate = await candidateAtPreboarding(context.service, "tamper");
    const input = conversionInput(
      candidate,
      "E-904",
      "9a57b2cb-9117-410e-a902-e73af79bdb65",
    );
    await convertInProviderTransaction(context, candidate, input, async (proposal, source, organization) => {
      const employee = {
        personnelNumber: input.employeeNumber,
        fullName: `${source.candidate.profile.firstName} ${source.candidate.profile.lastName}`,
        nickname: proposal.nickname,
        color: "#0b84c6",
        contractedHours: proposal.contractedHours,
        targetWorkdaysPerWeek: proposal.targetWorkdaysPerWeek,
        preferredDayOff: null,
        fixedWorkdays: "",
        positionId: "verkaufsmitarbeiter",
        timeConfirmationLevel: "C",
        sicknessWithoutAumEnabled: false,
        homeLocationId: null,
        preferredDepartmentId: null,
        costCenterId: null,
        active: true,
      };
      await organization.insertEmployee(employee);
      return employee;
    });

    const stored = context.database.prepare("SELECT * FROM candidate_conversions").get();
    const protectionContext = candidateConversionProtectionContext(stored);
    const snapshot = JSON.parse(context.storage.unprotectRecord(stored.protected_payload, protectionContext));
    snapshot.policies.onboarding = "started";
    const protectedPayload = context.storage.protectRecord(JSON.stringify(snapshot), protectionContext);
    const receiptSha256 = canonicalSha256({
      schemaVersion: 1,
      id: stored.id,
      candidateId: stored.candidate_id,
      applicationId: stored.application_id,
      employeeNumber: stored.employee_number,
      requestSha256: stored.request_sha256,
      protectedPayload,
      actorEmployeeNumber: stored.actor_employee_number,
      createdAt: stored.created_at,
    });
    context.database.exec("DROP TRIGGER trg_candidate_conversions_immutable_update");
    context.database.prepare(`
      UPDATE candidate_conversions
      SET protected_payload = ?, receipt_sha256 = ?
      WHERE id = ?
    `).run(protectedPayload, receiptSha256, stored.id);
    await assert.rejects(
      context.service.verifyIntegrity(),
      (error) => error.code === "PERSONNEL_LIFECYCLE_CONVERSION_INTEGRITY_FAILED",
    );
  } finally {
    await context.close();
  }
});

test("M3-Domäne: Integritätsprüfung bindet öffentliche Konversionsmetadaten an den Beleg", async () => {
  const context = await fixture();
  try {
    const candidate = await candidateAtPreboarding(context.service, "metadata");
    const input = conversionInput(
      candidate,
      "E-905",
      "bd0c88d1-ae42-441d-84b7-047681d11514",
    );
    await convertInProviderTransaction(context, candidate, input, async (proposal, source, organization) => {
      const employee = {
        personnelNumber: input.employeeNumber,
        fullName: `${source.candidate.profile.firstName} ${source.candidate.profile.lastName}`,
        nickname: proposal.nickname,
        color: "#0b84c6",
        contractedHours: proposal.contractedHours,
        targetWorkdaysPerWeek: proposal.targetWorkdaysPerWeek,
        preferredDayOff: null,
        fixedWorkdays: "",
        positionId: "verkaufsmitarbeiter",
        timeConfirmationLevel: "C",
        sicknessWithoutAumEnabled: false,
        homeLocationId: null,
        preferredDepartmentId: null,
        costCenterId: null,
        active: true,
      };
      await organization.insertEmployee(employee);
      return employee;
    });

    const candidateRow = context.database.prepare(`
      SELECT archived_at, updated_at, updated_by FROM candidates WHERE id = ?
    `).get(candidate.id);
    const applicationRow = context.database.prepare(`
      SELECT status_changed_at, updated_at, updated_by
      FROM candidate_applications WHERE id = ?
    `).get(candidate.applications[0].id);
    const mutations = [
      ["candidates", "archived_at", candidateRow.archived_at, candidate.id, "2099-01-01T00:00:00.000Z"],
      ["candidates", "updated_at", candidateRow.updated_at, candidate.id, "2099-01-01T00:00:00.000Z"],
      ["candidates", "updated_by", candidateRow.updated_by, candidate.id, "tampered-actor"],
      ["candidate_applications", "status_changed_at", applicationRow.status_changed_at,
        candidate.applications[0].id, "2099-01-01T00:00:00.000Z"],
      ["candidate_applications", "updated_at", applicationRow.updated_at,
        candidate.applications[0].id, "2099-01-01T00:00:00.000Z"],
      ["candidate_applications", "updated_by", applicationRow.updated_by,
        candidate.applications[0].id, "tampered-actor"],
    ];
    for (const [table, column, original, id, tampered] of mutations) {
      const update = context.database.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`);
      update.run(tampered, id);
      await assert.rejects(
        context.service.verifyIntegrity(),
        (error) => error.code === "PERSONNEL_LIFECYCLE_CONVERSION_INTEGRITY_FAILED",
      );
      update.run(original, id);
      assert.equal((await context.service.verifyIntegrity()).candidates, 1);
    }
  } finally {
    await context.close();
  }
});

test("M3-Domäne: M2-Read-only-Modus fragt Conversion-Daten nicht ab und sperrt Mutationen", async () => {
  const context = await fixture();
  try {
    context.database.exec("DROP TABLE candidate_conversions");
    const repository = createPersonnelLifecycleRepository(context.provider);
    const service = context.serviceFor(repository, { conversionAvailable: false });
    const candidate = await service.createCandidate({
      profile: {
        firstName: "M2",
        lastName: "Import",
        email: "m2@example.invalid",
      },
    });
    assert.equal(candidate.conversion, null);
    assert.equal((await service.verifyIntegrity()).candidates, 1);
    await assert.rejects(
      service.convertCandidateInTransaction(
        candidate.id,
        "application-does-not-matter",
        {},
        "system",
        async () => {
          throw new Error("nicht erreichbar");
        },
      ),
      (error) => error.code === "PERSONNEL_LIFECYCLE_CONVERSION_NOT_AVAILABLE",
    );
  } finally {
    await context.close();
  }
});

test("M3-Domaene: reservierter Systemprinzipal wird vor der Mitarbeiteranlage abgewiesen", async () => {
  const context = await fixture();
  try {
    const candidate = await candidateAtPreboarding(context.service, "reserved-local");
    const input = conversionInput(
      candidate,
      "LoCaL",
      "6fb12fd3-e369-40e4-882a-1ff76e77d60b",
    );
    let callbackCalls = 0;

    await assert.rejects(
      convertInProviderTransaction(context, candidate, input, async () => {
        callbackCalls += 1;
        throw new Error("Der reservierte Systemprinzipal darf die Mitarbeiteranlage nicht erreichen.");
      }),
      (error) => error.code === "PERSONNEL_LIFECYCLE_CONVERSION_EMPLOYEE_RESERVED",
    );

    assert.equal(callbackCalls, 0);
    assert.equal(
      context.database.prepare(`
        SELECT COUNT(*) AS count
        FROM employees
        WHERE LOWER(TRIM(personnel_number)) = 'local'
      `).get().count,
      0,
    );
    assert.equal(context.database.prepare("SELECT COUNT(*) AS count FROM candidate_conversions").get().count, 0);
    const unchanged = await context.service.getCandidate(candidate.id);
    assert.equal(unchanged.state, "active");
    assert.equal(unchanged.applications[0].status, "preboarding");
  } finally {
    await context.close();
  }
});
