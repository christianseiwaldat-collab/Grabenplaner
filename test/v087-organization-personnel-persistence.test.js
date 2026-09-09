"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PERSISTENCE_ERROR_CODES,
} = require("../lib/persistence/contract");
const {
  createOrganizationPersonnelRepository,
} = require("../lib/persistence/repositories/organization-personnel");
const {
  SQLITE_ORGANIZATION_PERSONNEL_CATALOG,
} = require("../lib/persistence/sqlite/organization-personnel-catalog");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");

async function fixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_ORGANIZATION_PERSONNEL_CATALOG,
  });
  application.database.exec(`
    CREATE TABLE schedule_notes (
      location_id TEXT NOT NULL,
      department_key TEXT NOT NULL,
      week_start TEXT NOT NULL,
      note_text TEXT NOT NULL,
      note_html TEXT NOT NULL,
      font_size TEXT NOT NULL,
      bold INTEGER NOT NULL,
      italic INTEGER NOT NULL,
      underline INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (location_id, department_key, week_start)
    );
    CREATE TABLE schedule_manual_locks (
      location_id TEXT NOT NULL,
      week_start TEXT NOT NULL,
      locked INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (location_id, week_start)
    );
    CREATE TABLE cost_center_types (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      is_branch INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      builtin INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE positions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      builtin INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      employment_classification TEXT NOT NULL DEFAULT 'standard',
      sort_order INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      archived_by TEXT,
      archived_at TEXT
    );
    CREATE TABLE cost_center_type_positions (
      cost_center_type_id TEXT NOT NULL,
      position_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      PRIMARY KEY (cost_center_type_id, position_id)
    );
    CREATE TABLE cost_centers (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      cost_center_type_id TEXT,
      description TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE locations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cost_center_id TEXT,
      min_staff INTEGER NOT NULL DEFAULT 0,
      day_settings_json TEXT NOT NULL DEFAULT '{}',
      time_tracking_enabled INTEGER NOT NULL DEFAULT 0,
      time_tracking_access_mode TEXT NOT NULL DEFAULT 'anywhere',
      time_tracking_allowed_networks TEXT NOT NULL DEFAULT '',
      time_tracking_variance_minutes INTEGER NOT NULL DEFAULT 15,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE departments (
      id INTEGER PRIMARY KEY,
      location_id TEXT NOT NULL,
      name TEXT NOT NULL,
      min_staff INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (location_id, name)
    );
    CREATE TABLE shifts (
      id INTEGER PRIMARY KEY,
      department_id INTEGER
    );
    CREATE TABLE employees (
      personnel_number TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      nickname TEXT NOT NULL,
      color TEXT NOT NULL,
      contracted_hours REAL NOT NULL,
      target_workdays_per_week INTEGER NOT NULL,
      preferred_day_off TEXT,
      fixed_workdays TEXT NOT NULL DEFAULT '',
      position_id TEXT NOT NULL,
      time_confirmation_level TEXT NOT NULL,
      sickness_without_aum_enabled INTEGER NOT NULL DEFAULT 0,
      home_location_id TEXT,
      preferred_department_id INTEGER,
      cost_center_id TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE portal_roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      builtin INTEGER NOT NULL DEFAULT 1,
      permissions TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE portal_users (
      employee_number TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'employee',
      role_locked INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      last_login_at TEXT,
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE portal_permission_grants (
      employee_number TEXT NOT NULL,
      permission TEXT NOT NULL,
      granted_by TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (employee_number, permission)
    );
    CREATE TABLE portal_permission_denials (
      employee_number TEXT NOT NULL,
      permission TEXT NOT NULL,
      denied_by TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (employee_number, permission)
    );
    CREATE TABLE portal_access_scopes (
      employee_number TEXT NOT NULL,
      location_id TEXT NOT NULL,
      department_id INTEGER NOT NULL DEFAULT 0,
      assigned_by TEXT NOT NULL,
      PRIMARY KEY (employee_number, location_id, department_id)
    );
    CREATE TABLE personnel_field_permissions (
      role_id TEXT NOT NULL,
      field_key TEXT NOT NULL,
      access_level TEXT NOT NULL,
      updated_by TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (role_id, field_key)
    );
    CREATE TABLE amu_local_access_overrides (
      employee_number TEXT PRIMARY KEY,
      access_mode TEXT NOT NULL,
      updated_by TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE portal_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE portal_organization_accounts (
      id TEXT PRIMARY KEY,
      login_name TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      account_type TEXT NOT NULL,
      password_hash TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      last_login_at TEXT,
      password_changed_at TEXT,
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE portal_organization_account_permissions (
      account_id TEXT NOT NULL,
      permission TEXT NOT NULL,
      granted_by TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (account_id, permission)
    );
    CREATE TABLE portal_organization_account_scopes (
      account_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      department_id INTEGER NOT NULL DEFAULT 0,
      assigned_by TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (account_id, location_id, department_id)
    );
    CREATE TABLE portal_organization_sessions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE approval_delegations (
      id INTEGER PRIMARY KEY,
      location_id TEXT NOT NULL,
      delegate_employee_number TEXT NOT NULL,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE week_options (
      id INTEGER PRIMARY KEY,
      employee_number TEXT NOT NULL,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      option_type TEXT NOT NULL
    );
    CREATE TABLE portal_sessions (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE mobile_sessions (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      revoked_at TEXT,
      revoked_reason TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE personnel_sensitive_records (
      employee_number TEXT PRIMARY KEY,
      social_security_lookup TEXT NOT NULL UNIQUE,
      protected_payload TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      detail TEXT NOT NULL
    );
    INSERT INTO portal_roles (id, name, permissions, sort_order) VALUES
      ('employee', 'Mitarbeiter', '[]', 10),
      ('manager', 'Leitung', '["sickness:read"]', 20);
  `);
  require("../lib/persistence/sqlite/operations/portal-permission-defaults-schema").ensureSqlitePortalPermissionDefaultsSchema(application.database);
  return {
    ...application,
    repository: createOrganizationPersonnelRepository(application.provider),
    async close() {
      await application.provider.close();
      application.database.close();
    },
  };
}

test("Block 3/7: Organisation und Kostenstellen bleiben in einer Providertransaktion konsistent", async () => {
  const context = await fixture();
  try {
    await context.repository.transaction(async (organization) => {
      const sortOrder = await organization.nextPositionSortOrder();
      await organization.insertPosition({ id: "sales", name: "Verkauf" }, sortOrder);
      await organization.insertCostCenterType("branch", {
        code: "branch",
        name: "Filiale",
        description: "",
        isBranch: true,
        active: true,
        sortOrder: 10,
      }, "ADMIN");
      await organization.replaceCostCenterTypePositions("branch", ["sales"]);
      await organization.insertCostCenter("cc-01", {
        code: "FIL01",
        name: "Filiale 01",
        type: "branch",
        costCenterTypeId: "branch",
        description: "",
        active: true,
        sortOrder: 10,
      }, "ADMIN");
      await organization.insertLocation({
        id: "01",
        name: "Filiale 01",
        costCenterId: "cc-01",
        minStaff: 2,
        daySettingsJson: "{}",
        timeTrackingEnabled: false,
        timeTrackingAccessMode: "anywhere",
        timeTrackingAllowedNetworks: "",
        timeTrackingVarianceMinutes: 15,
        active: true,
      });
      const departmentSortOrder = await organization.nextDepartmentSortOrder("01");
      const departmentId = await organization.insertDepartment({
        locationId: "01",
        name: "Verkauf",
        minStaff: 1,
        active: true,
      }, departmentSortOrder);
      assert.equal(departmentId, 1);
    });

    await context.repository.upsertScheduleNote({
      locationId: "01",
      departmentKey: "1",
      weekStart: "2026-07-27",
      noteText: "Inventur",
      noteHtml: "Inventur",
      fontSize: "medium",
      bold: false,
      italic: false,
      underline: false,
    });
    assert.equal(context.database.prepare("SELECT note_text FROM schedule_notes").get().note_text, "Inventur");
    const locked = await context.repository.transaction(async (organization) => {
      const row = await organization.upsertScheduleManualLock({
        locationId: "01",
        weekStart: "2026-07-27",
        locked: true,
        expectedRevision: 0,
        actor: "ADMIN",
      });
      await organization.insertAudit(
        "ADMIN",
        "schedule.manual-lock.lock",
        "schedule_manual_lock",
        "01:2026-07-27",
        JSON.stringify({ revisionAfter: row.revision }),
      );
      return row;
    });
    assert.equal(locked.locked, true);
    assert.equal(locked.revision, 1);
    assert.equal((await context.repository.getScheduleManualLock("01", "2026-07-27")).updated_by, "ADMIN");
    assert.equal(await context.repository.upsertScheduleManualLock({
      locationId: "01",
      weekStart: "2026-07-27",
      locked: false,
      expectedRevision: 0,
      actor: "ADMIN",
    }), null);
    const unlocked = await context.repository.upsertScheduleManualLock({
      locationId: "01",
      weekStart: "2026-07-27",
      locked: false,
      expectedRevision: 1,
      actor: "ADMIN",
    });
    assert.equal(unlocked.locked, false);
    assert.equal(unlocked.revision, 2);
    assert.equal(
      context.database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'schedule.manual-lock.lock'").get().count,
      1,
    );
    assert.deepEqual(await context.repository.listCostCenterTypePositionIds("branch"), ["sales"]);
    assert.deepEqual(await context.repository.costCenterAssignments("cc-01"), {
      employees: 0,
      locations: 1,
    });
  } finally {
    await context.close();
  }
});

test("Block 3/7: Repository reicht Transaktionsoptionen an den Providervertrag weiter", async () => {
  const context = await fixture();
  try {
    await assert.rejects(
      context.repository.transaction(async (organization) => {
        await organization.insertPosition({ id: "read-only-write", name: "Nicht schreiben" }, 1);
      }, { readOnly: true }),
      (error) => error?.code === PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID,
    );
    assert.equal(
      context.database.prepare("SELECT COUNT(*) AS count FROM positions").get().count,
      0,
    );

    let callbackCalled = false;
    await assert.rejects(
      context.repository.transaction(async () => { callbackCalled = true; }, { unexpected: true }),
      (error) => error?.code === PERSISTENCE_ERROR_CODES.CONTRACT_VIOLATION,
    );
    assert.equal(callbackCalled, false);
  } finally {
    await context.close();
  }
});

test("Block 3/7: Personalstamm, Rechteprofil und Schutzdatensatz rollen gemeinsam zurueck", async () => {
  const context = await fixture();
  try {
    await context.repository.transaction(async (organization) => {
      await organization.insertPosition({ id: "sales", name: "Verkauf" }, 1);
      await organization.insertCostCenterType("branch", {
        code: "branch",
        name: "Filiale",
        description: "",
        isBranch: true,
        active: true,
        sortOrder: 10,
      }, "ADMIN");
      await organization.insertCostCenter("cc-01", {
        code: "FIL01",
        name: "Filiale 01",
        type: "branch",
        costCenterTypeId: "branch",
        description: "",
        active: true,
        sortOrder: 10,
      }, "ADMIN");
      await organization.insertLocation({
        id: "01",
        name: "Filiale 01",
        costCenterId: "cc-01",
        minStaff: 1,
        daySettingsJson: "{}",
        timeTrackingEnabled: false,
        timeTrackingAccessMode: "anywhere",
        timeTrackingAllowedNetworks: "",
        timeTrackingVarianceMinutes: 15,
        active: true,
      });
      const departmentId = await organization.insertDepartment({
        locationId: "01",
        name: "Verkauf",
        minStaff: 1,
        active: true,
      }, 1);
      await organization.insertEmployee({
        personnelNumber: "E1",
        fullName: "Erika Beispiel",
        nickname: "Erika",
        color: "#123456",
        contractedHours: 38.5,
        targetWorkdaysPerWeek: 5,
        preferredDayOff: null,
        fixedWorkdays: "",
        positionId: "sales",
        timeConfirmationLevel: "C",
        sicknessWithoutAumEnabled: false,
        homeLocationId: "01",
        preferredDepartmentId: departmentId,
        costCenterId: "cc-01",
        active: true,
      });
      await organization.applyAccessProfile(
        { employeeNumber: "ADMIN" },
        {
          employeeNumber: "E1",
          role: "manager",
          permissions: ["employees:read"],
          homeLocationId: "01",
          preferredDepartmentId: departmentId,
        },
      );
      await organization.upsertPersonnelSensitiveRecord({
        employeeNumber: "E1",
        socialSecurityLookup: "lookup-e1",
        protectedPayload: "protected-e1",
        actor: "ADMIN",
      });
    });

    const employee = (await context.repository.listEmployees())[0];
    assert.equal(employee.contracted_hours, 38.5);
    assert.deepEqual(await context.repository.getEmployeeIdentity("E1"), {
      personnel_number: "E1",
      full_name: "Erika Beispiel",
    });
    assert.equal(context.database.prepare(
      "SELECT role FROM portal_users WHERE employee_number = 'E1'",
    ).get().role, "manager");
    assert.equal(context.database.prepare(
      "SELECT protected_payload FROM personnel_sensitive_records WHERE employee_number = 'E1'",
    ).get().protected_payload, "protected-e1");

    await assert.rejects(
      context.repository.transaction(async (organization) => {
        await organization.updateEmployeeDisplay("E1", "#abcdef", "Rollback");
        await organization.insertPosition({ id: "sales", name: "Duplikat" }, 2);
      }),
    );
    assert.deepEqual(await context.repository.getEmployeeDisplay("E1"), {
      color: "#123456",
      nickname: "Erika",
    });
  } finally {
    await context.close();
  }
});

test("Block 3/7: Organisations- und Rechteprojektionen werden providerbasiert gelesen", async () => {
  const context = await fixture();
  try {
    await context.repository.transaction(async (organization) => {
      await organization.insertPosition({ id: "sales", name: "Verkauf" }, 1);
      await organization.insertCostCenterType("branch", {
        code: "branch",
        name: "Filiale",
        description: "",
        isBranch: true,
        active: true,
        sortOrder: 10,
      }, "ADMIN");
      await organization.replaceCostCenterTypePositions("branch", ["sales"]);
      await organization.insertCostCenter("cc-01", {
        code: "FIL01",
        name: "Filiale 01",
        type: "branch",
        costCenterTypeId: "branch",
        description: "",
        active: true,
        sortOrder: 10,
      }, "ADMIN");
      await organization.insertLocation({
        id: "01",
        name: "Filiale 01",
        costCenterId: "cc-01",
        minStaff: 2,
        daySettingsJson: "{}",
        timeTrackingEnabled: true,
        timeTrackingAccessMode: "network",
        timeTrackingAllowedNetworks: "10.0.0.0/24",
        timeTrackingVarianceMinutes: 10,
        active: true,
      });
      const departmentId = await organization.insertDepartment({
        locationId: "01",
        name: "Verkauf",
        minStaff: 1,
        active: true,
      }, 1);
      await organization.insertEmployee({
        personnelNumber: "E1",
        fullName: "Erika Beispiel",
        nickname: "Erika",
        color: "#123456",
        contractedHours: 38.5,
        targetWorkdaysPerWeek: 5,
        preferredDayOff: null,
        fixedWorkdays: "",
        positionId: "sales",
        timeConfirmationLevel: "C",
        sicknessWithoutAumEnabled: false,
        homeLocationId: "01",
        preferredDepartmentId: departmentId,
        costCenterId: "cc-01",
        active: true,
      });
      await organization.applyAccessProfile(
        { employeeNumber: "ADMIN" },
        {
          employeeNumber: "E1",
          role: "manager",
          permissions: ["employees:read"],
          homeLocationId: "01",
          preferredDepartmentId: departmentId,
        },
      );
      await organization.upsertPersonnelSensitiveRecord({
        employeeNumber: "E1",
        socialSecurityLookup: "lookup-e1",
        protectedPayload: "protected-e1",
        actor: "ADMIN",
      });
    });
    context.database.prepare(`
      INSERT INTO portal_permission_denials (employee_number, permission)
      VALUES ('E1', 'sickness:read')
    `).run();

    assert.equal((await context.repository.getPersonnelSensitiveRecord("E1")).social_security_lookup, "lookup-e1");
    assert.equal((await context.repository.getScheduleNote("01", "1", "2026-07-27")), null);
    assert.equal((await context.repository.listLocations(false))[0].time_tracking_enabled, true);
    assert.equal((await context.repository.listDepartments(false))[0].location_id, "01");
    assert.equal((await context.repository.listCostCenters(false))[0].cost_center_type_id, "branch");
    assert.deepEqual((await context.repository.listPositions())[0].cost_center_type_ids, "branch");
    assert.equal((await context.repository.getPortalRoleProjection("manager")).permissions, "[\"sickness:read\"]");
    assert.equal((await context.repository.listPortalUsersForAdmin())[0].role_permissions, "[\"sickness:read\"]");
    assert.deepEqual(await context.repository.listPortalPermissionGrants("E1"), ["employees:read"]);
    assert.deepEqual(await context.repository.listPortalPermissionDenials("E1"), ["sickness:read"]);
    assert.deepEqual(await context.repository.listPortalAccessScopes("E1"), [{
      location_id: "01",
      department_id: 0,
    }]);

    context.database.prepare(`
      UPDATE portal_permission_grants
      SET updated_at = '2026-01-02T03:04:05.000Z'
      WHERE employee_number = 'E1' AND permission = 'employees:read'
    `).run();
    await context.repository.transaction(async (organization) => {
      await organization.applyAccessProfile(
        { employeeNumber: "ADMIN" },
        {
          employeeNumber: "E1",
          role: "manager",
          permissions: ["employees:read"],
          homeLocationId: "01",
          preferredDepartmentId: 1,
        },
        {
          role: "manager",
          grantedPermissions: ["employees:read"],
        },
      );
    });
    assert.equal(context.database.prepare(`
      SELECT updated_at
      FROM portal_permission_grants
      WHERE employee_number = 'E1' AND permission = 'employees:read'
    `).get().updated_at, "2026-01-02T03:04:05.000Z");
    assert.deepEqual(await context.repository.listPortalPermissionDenials("E1"), ["sickness:read"]);
  } finally {
    await context.close();
  }
});

test("Block 3/7: Rechte- und Organisationskonto-Mutationen bleiben providergebunden", async () => {
  const context = await fixture();
  try {
    await context.repository.transaction(async (organization) => {
      await organization.insertOrganizationAccount({
        accountId: "branch-01",
        loginName: "fil01",
        displayName: "Filiale 01",
        accountType: "branch",
        passwordHash: "hash",
        active: true,
        mustChangePassword: true,
        passwordChanged: true,
        actor: "ADMIN",
      });
      await organization.insertOrganizationAccountPermission(
        "branch-01",
        "location:schedule:read",
        "ADMIN",
      );
      await organization.insertOrganizationAccountScope("branch-01", "01", "ADMIN");
      await organization.insertPersonnelFieldPermission(
        "manager",
        "phone",
        "read",
        "ADMIN",
      );
      await organization.upsertManagerAmuDefault(true);
      await organization.insertManagerAmuOverride("E1", "deny", "ADMIN");
    });

    const account = await context.repository.getOrganizationAccount("branch-01");
    assert.equal(account.login_name, "fil01");
    assert.deepEqual(JSON.parse(account.permissions_json), ["location:schedule:read"]);
    assert.deepEqual(JSON.parse(account.scopes_json), [{
      locationId: "01",
      departmentId: null,
    }]);
    assert.deepEqual(await context.repository.listPersonnelFieldPermissions("manager"), [{
      field_key: "phone",
      access_level: "read",
    }]);
    assert.equal(context.database.prepare(
      "SELECT value FROM portal_settings WHERE key = 'amu_manager_file_access'",
    ).get().value, "1");
    assert.equal(context.database.prepare(
      "SELECT access_mode FROM amu_local_access_overrides WHERE employee_number = 'E1'",
    ).get().access_mode, "deny");

    await context.repository.transaction(async (organization) => {
      await organization.deleteOrganizationAccountPermissions("branch-01");
      await organization.deleteOrganizationAccountScopes("branch-01");
      await organization.updateOrganizationAccount({
        accountId: "branch-01",
        displayName: "Filiale Eins",
        accountType: "terminal",
        passwordHash: "hash-2",
        active: false,
        passwordChanged: true,
        actor: "ADMIN",
      });
    });
    const updated = await context.repository.getOrganizationAccount("branch-01");
    assert.equal(updated.display_name, "Filiale Eins");
    assert.equal(updated.account_type, "terminal");
    assert.equal(updated.active, false);
    assert.deepEqual(JSON.parse(updated.permissions_json), []);
    assert.deepEqual(JSON.parse(updated.scopes_json), []);
  } finally {
    await context.close();
  }
});
