"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");
const { verifyCommittedBackup } = require("../lib/backup-commit");

const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "grabenplaner-v087-block8-cost-center-migration-"),
);
const databasePath = path.join(temporaryRoot, "dienstplan.db");
const dataRoot = path.join(temporaryRoot, "app-data");
const internalBackupDirectory = path.join(dataRoot, "backups");
const environment = {
  ...process.env,
  DB_PATH: databasePath,
  BACKUP_DIR: path.join(temporaryRoot, "external-backups"),
  GRABENPLANER_DATA_DIR: dataRoot,
  GRABENPLANER_HOST: "127.0.0.1",
  GRABENPLANER_FORCE_PORTAL: "1",
  GRABENPLANER_SEED_DEMO: "1",
  GRABENPLANER_DEMO_PROFILE: "sporthandel",
  GRABENPLANER_TEST_AMU_SCANNER: "clean",
  NODE_ENV: "test",
  TZ: "Europe/Vienna",
};

const assignmentTriggerNames = [
  "trg_employees_assignment_position_insert",
  "trg_employees_assignment_position_update",
  "trg_employees_assignment_location_insert",
  "trg_employees_assignment_location_update",
  "trg_employees_assignment_department_insert",
  "trg_employees_assignment_department_update",
];
const conflictEmployeeNumbers = [
  "B8-CONFLICT-BRANCH",
  "B8-CONFLICT-NONBRANCH",
];

function runServerInitialization() {
  const result = spawnSync(process.execPath, ["-e", `
    const server = require("./server");
    server.db.close();
    server.releaseInstanceLockForTests();
  `], {
    cwd: path.join(__dirname, ".."),
    env: environment,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(
    result.status,
    0,
    [result.error?.stack, result.stdout, result.stderr].filter(Boolean).join("\n"),
  );
}

function withDatabase(filePath, callback, options = undefined) {
  const database = options ? new DatabaseSync(filePath, options) : new DatabaseSync(filePath);
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

function plainRows(rows) {
  return rows.map((row) => ({ ...row }));
}

function committedBackupMarkers() {
  if (!fs.existsSync(internalBackupDirectory)) return [];
  return fs.readdirSync(internalBackupDirectory)
    .filter((name) => name.endsWith(".complete.json"))
    .sort();
}

function employeeRows(database) {
  return plainRows(database.prepare(
    "SELECT * FROM employees ORDER BY personnel_number",
  ).all());
}

function costCenterRows(database) {
  return plainRows(database.prepare(
    "SELECT * FROM cost_centers ORDER BY id",
  ).all());
}

function conflictAssignments(database) {
  return plainRows(database.prepare(`
    SELECT personnel_number, cost_center_id, home_location_id, preferred_department_id
    FROM employees
    WHERE personnel_number IN (?, ?)
    ORDER BY personnel_number
  `).all(...conflictEmployeeNumbers));
}

function reconciliationAuditRows(database) {
  return plainRows(database.prepare(`
    SELECT id, actor, action, entity_type, entity_id, detail, created_at
    FROM audit_log
    WHERE action = 'employee.cost-center.reconcile'
      AND entity_id IN (?, ?)
    ORDER BY id
  `).all(...conflictEmployeeNumbers));
}

function databaseIntegrity(database) {
  return {
    quickCheck: database.prepare("PRAGMA quick_check").all()
      .map((row) => Object.values(row)[0]),
    foreignKeys: plainRows(database.prepare("PRAGMA foreign_key_check").all()),
  };
}

function assertIntegrityClean(database) {
  const integrity = databaseIntegrity(database);
  assert.deepEqual(integrity.quickCheck, ["ok"]);
  assert.deepEqual(integrity.foreignKeys, []);
}

function expectedReconciledEmployees(before, expectedAssignments) {
  return before.map((employee) => {
    const expected = expectedAssignments.get(employee.personnel_number);
    return expected ? {
      ...employee,
      home_location_id: expected.homeLocationId,
      preferred_department_id: expected.preferredDepartmentId,
    } : employee;
  });
}

test.after(() => {
  fs.rmSync(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  });
});

test("v0.87 Block 8 repariert bestehende Kostenstellenkonflikte verlustfrei, gesichert und idempotent", () => {
  runServerInitialization();
  assert.deepEqual(
    committedBackupMarkers(),
    [],
    "Die erstmalige Initialisierung einer neuen Testdatenbank darf kein Pre-Migration-Backup vortaeuschen.",
  );

  let employeesBefore;
  let costCentersBefore;
  let assignmentsBefore;
  let expectedAssignments;
  let triggerNamesBefore;

  withDatabase(databasePath, (database) => {
    database.exec("PRAGMA foreign_keys = ON");

    const migrationIds = database.prepare(`
      SELECT id
      FROM schema_migrations
      WHERE id IN ('v0.87-cost-center-types', 'v0.87-employee-cost-center-assignment')
      ORDER BY id
    `).all().map((row) => row.id);
    assert.deepEqual(migrationIds, [
      "v0.87-cost-center-types",
      "v0.87-employee-cost-center-assignment",
    ]);

    const branchLocations = plainRows(database.prepare(`
      SELECT
        l.id AS location_id,
        l.cost_center_id,
        (
          SELECT d.id
          FROM departments d
          WHERE d.location_id = l.id AND d.active = 1
          ORDER BY d.sort_order, d.id
          LIMIT 1
        ) AS department_id
      FROM locations l
      JOIN cost_centers c ON c.id = l.cost_center_id AND c.active = 1
      JOIN cost_center_types cct
        ON cct.id = c.cost_center_type_id AND cct.active = 1 AND cct.is_branch = 1
      WHERE l.active = 1
        AND EXISTS (
          SELECT 1 FROM departments d
          WHERE d.location_id = l.id AND d.active = 1
        )
      ORDER BY l.id
      LIMIT 2
    `).all());
    assert.equal(branchLocations.length, 2, "Das Testprofil benoetigt zwei Filialen mit Abteilungen.");
    const [derivedBranch, contradictoryBranch] = branchLocations;

    const branchPosition = database.prepare(`
      SELECT cctp.position_id
      FROM cost_centers c
      JOIN cost_center_type_positions cctp
        ON cctp.cost_center_type_id = c.cost_center_type_id
      WHERE c.id = ?
      ORDER BY cctp.sort_order, cctp.position_id
      LIMIT 1
    `).get(derivedBranch.cost_center_id);
    assert.ok(branchPosition?.position_id, "Der Filialtyp benoetigt mindestens eine erlaubte Position.");

    const nonBranch = database.prepare(`
      SELECT c.id AS cost_center_id, cctp.position_id
      FROM cost_centers c
      JOIN cost_center_types cct
        ON cct.id = c.cost_center_type_id AND cct.active = 1 AND cct.is_branch = 0
      JOIN cost_center_type_positions cctp
        ON cctp.cost_center_type_id = c.cost_center_type_id
      WHERE c.active = 1
      ORDER BY c.sort_order, c.code, cctp.sort_order, cctp.position_id
      LIMIT 1
    `).get();
    assert.ok(nonBranch?.cost_center_id, "Das Testprofil benoetigt eine aktive Nicht-Filialkostenstelle.");
    assert.ok(nonBranch?.position_id, "Der Nicht-Filialtyp benoetigt mindestens eine erlaubte Position.");

    triggerNamesBefore = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name
    `).all().map((row) => row.name);
    for (const name of assignmentTriggerNames) {
      assert.ok(triggerNamesBefore.includes(name), `Der erwartete Assignment-Trigger ${name} fehlt.`);
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      for (const name of assignmentTriggerNames) {
        database.exec(`DROP TRIGGER "${name}"`);
      }
      const insertEmployee = database.prepare(`
        INSERT INTO employees
          (personnel_number, full_name, nickname, color, contracted_hours,
           target_workdays_per_week, preferred_day_off, fixed_workdays, position_id,
           time_confirmation_level, sickness_without_aum_enabled, home_location_id,
           preferred_department_id, cost_center_id, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertEmployee.run(
        conflictEmployeeNumbers[0],
        "Block 8 Filialkonflikt",
        "B8 Filiale",
        "#13579b",
        31.25,
        4,
        "tuesday",
        "monday,thursday",
        branchPosition.position_id,
        "B",
        1,
        contradictoryBranch.location_id,
        contradictoryBranch.department_id,
        derivedBranch.cost_center_id,
        1,
        "2020-01-02 03:04:05",
      );
      insertEmployee.run(
        conflictEmployeeNumbers[1],
        "Block 8 Nichtfilialkonflikt",
        "B8 Verwaltung",
        "#97531b",
        17.5,
        3,
        "friday",
        "tuesday,wednesday",
        nonBranch.position_id,
        "A",
        0,
        derivedBranch.location_id,
        derivedBranch.department_id,
        nonBranch.cost_center_id,
        0,
        "2020-02-03 04:05:06",
      );
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch {}
      throw error;
    }

    const remainingTriggers = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name
    `).all().map((row) => row.name);
    assert.deepEqual(
      remainingTriggers,
      triggerNamesBefore.filter((name) => !assignmentTriggerNames.includes(name)),
      "Nur die sechs Mitarbeiter-Assignment-Trigger duerfen fuer das Konfliktfixture fehlen.",
    );
    assert.deepEqual(
      database.prepare(`
        SELECT id
        FROM schema_migrations
        WHERE id IN ('v0.87-cost-center-types', 'v0.87-employee-cost-center-assignment')
        ORDER BY id
      `).all().map((row) => row.id),
      migrationIds,
      "Die v0.87-Marker muessen trotz bestehender Datenkonflikte erhalten bleiben.",
    );
    assert.deepEqual(
      reconciliationAuditRows(database),
      [],
      "Das Testfixture darf selbst keine Reconciliation-Auditzeilen schreiben.",
    );
    assertIntegrityClean(database);

    employeesBefore = employeeRows(database);
    costCentersBefore = costCenterRows(database);
    assignmentsBefore = conflictAssignments(database);
    expectedAssignments = new Map([
      [conflictEmployeeNumbers[0], {
        costCenterId: derivedBranch.cost_center_id,
        homeLocationId: derivedBranch.location_id,
        preferredDepartmentId: null,
      }],
      [conflictEmployeeNumbers[1], {
        costCenterId: nonBranch.cost_center_id,
        homeLocationId: null,
        preferredDepartmentId: null,
      }],
    ]);
  });

  assert.equal(assignmentsBefore.length, 2);
  assert.equal(
    assignmentsBefore[0].home_location_id === expectedAssignments.get(
      assignmentsBefore[0].personnel_number,
    ).homeLocationId,
    false,
  );
  assert.equal(
    assignmentsBefore[1].home_location_id === expectedAssignments.get(
      assignmentsBefore[1].personnel_number,
    ).homeLocationId,
    false,
  );

  runServerInitialization();

  const firstRestartMarkers = committedBackupMarkers();
  assert.equal(
    firstRestartMarkers.length,
    1,
    "Der erste Neustart mit vorhandenen Konflikten muss genau ein internes Pre-Migration-Backup erzeugen.",
  );
  const verifiedBackup = verifyCommittedBackup(
    internalBackupDirectory,
    firstRestartMarkers[0],
  );
  assert.equal(verifiedBackup.committed, true);
  assert.equal(verifiedBackup.verified, true);

  withDatabase(verifiedBackup.databasePath, (backupDatabase) => {
    assert.deepEqual(
      employeeRows(backupDatabase),
      employeesBefore,
      "Das verifizierte Sicherungsabbild muss den vollstaendigen Stand vor der Reparatur enthalten.",
    );
    assert.deepEqual(costCenterRows(backupDatabase), costCentersBefore);
    assert.deepEqual(conflictAssignments(backupDatabase), assignmentsBefore);
    assert.deepEqual(
      reconciliationAuditRows(backupDatabase),
      [],
      "Das Pre-Migration-Backup muss zeitlich vor den Reconciliation-Auditzeilen liegen.",
    );
    assertIntegrityClean(backupDatabase);
  }, { readOnly: true });

  let firstRestartEmployees;
  let firstRestartAudits;
  withDatabase(databasePath, (database) => {
    firstRestartEmployees = employeeRows(database);
    assert.deepEqual(
      firstRestartEmployees,
      expectedReconciledEmployees(employeesBefore, expectedAssignments),
      "Ausser den beiden abgeleiteten Assignment-Feldern duerfen keine Personendaten veraendert werden.",
    );
    assert.deepEqual(
      costCenterRows(database),
      costCentersBefore,
      "Die Reconciliation darf keine Kostenstelle veraendern oder entfernen.",
    );

    const assignmentsAfter = conflictAssignments(database);
    assert.equal(assignmentsAfter.length, 2);
    for (const assignment of assignmentsAfter) {
      const expected = expectedAssignments.get(assignment.personnel_number);
      assert.deepEqual(assignment, {
        personnel_number: assignment.personnel_number,
        cost_center_id: expected.costCenterId,
        home_location_id: expected.homeLocationId,
        preferred_department_id: expected.preferredDepartmentId,
      });
    }

    firstRestartAudits = reconciliationAuditRows(database);
    assert.equal(firstRestartAudits.length, 2, "Jede korrigierte Person benoetigt genau eine Auditzeile.");
    const auditByEmployee = new Map(firstRestartAudits.map((row) => [row.entity_id, row]));
    const assignmentBeforeByEmployee = new Map(
      assignmentsBefore.map((row) => [row.personnel_number, row]),
    );
    for (const employeeNumber of conflictEmployeeNumbers) {
      const audit = auditByEmployee.get(employeeNumber);
      assert.ok(audit, `Auditzeile fuer ${employeeNumber} fehlt.`);
      assert.equal(audit.actor, "system");
      assert.equal(audit.action, "employee.cost-center.reconcile");
      assert.equal(audit.entity_type, "employee");
      const detail = JSON.parse(audit.detail);
      const before = assignmentBeforeByEmployee.get(employeeNumber);
      const expected = expectedAssignments.get(employeeNumber);
      assert.equal(detail.costCenterId, expected.costCenterId);
      assert.deepEqual(detail.homeLocationId, {
        before: before.home_location_id,
        after: expected.homeLocationId,
      });
      assert.deepEqual(detail.preferredDepartmentId, {
        before: before.preferred_department_id,
        after: expected.preferredDepartmentId,
      });
    }

    const restoredAssignmentTriggers = database.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'trigger'
        AND name IN (?, ?, ?, ?, ?, ?)
      ORDER BY name
    `).all(...assignmentTriggerNames).map((row) => row.name);
    assert.deepEqual(restoredAssignmentTriggers, [...assignmentTriggerNames].sort());

    const inconsistent = database.prepare(`
      SELECT e.personnel_number
      FROM employees e
      JOIN cost_centers c ON c.id = e.cost_center_id
      JOIN cost_center_types cct ON cct.id = c.cost_center_type_id
      WHERE NOT EXISTS (
        SELECT 1
        FROM cost_center_type_positions cctp
        WHERE cctp.cost_center_type_id = c.cost_center_type_id
          AND cctp.position_id = e.position_id
      )
        OR COALESCE(e.home_location_id, '') <> COALESCE(
          CASE WHEN cct.is_branch = 1
            THEN (
              SELECT l.id FROM locations l
              WHERE l.cost_center_id = c.id
              ORDER BY l.id
              LIMIT 1
            )
            ELSE NULL
          END,
          ''
        )
        OR (
          e.preferred_department_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM departments d
            WHERE d.id = e.preferred_department_id
              AND d.location_id = e.home_location_id
          )
        )
      ORDER BY e.personnel_number
    `).all();
    assert.deepEqual(inconsistent, []);
    assertIntegrityClean(database);
  });

  runServerInitialization();

  assert.deepEqual(
    committedBackupMarkers(),
    firstRestartMarkers,
    "Ein konfliktfreier zweiter Neustart darf kein weiteres internes Backup erzeugen.",
  );
  withDatabase(databasePath, (database) => {
    assert.deepEqual(
      employeeRows(database),
      firstRestartEmployees,
      "Der zweite Neustart muss fuer alle Personendaten idempotent sein.",
    );
    assert.deepEqual(costCenterRows(database), costCentersBefore);
    assert.deepEqual(
      reconciliationAuditRows(database),
      firstRestartAudits,
      "Der zweite Neustart darf keine zusaetzlichen Reconciliation-Auditzeilen schreiben.",
    );
    assertIntegrityClean(database);
  });
});
