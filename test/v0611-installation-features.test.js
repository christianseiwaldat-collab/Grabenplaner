"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v0611-features-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.NODE_ENV = "test";

const {
  db,
  installationFeatures,
  installationFeaturesForApiPath,
  releaseInstanceLockForTests,
  validateUsbEmployees,
  validateUsbFeatures,
} = require("../server");
const {
  PERSONNEL_LEARNING_PERMISSIONS,
} = require("../lib/personnel-learning-access");
const {
  CROSS_LOCATION_SCHEDULE_PERMISSION_IDS,
  CROSS_LOCATION_SCHEDULE_OPERATIONAL_PERMISSION_IDS,
} = require("../lib/cross-location-schedule-access");

test.after(() => {
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.61.1 Funktionsprofil: direkte Planungs- und PDF-Routen bleiben serverseitig gesperrt", () => {
  assert.deepEqual(installationFeaturesForApiPath("/schedule-note/2026-07-20"), ["schedule"]);
  assert.deepEqual(installationFeaturesForApiPath("/schedule-preview.pdf"), ["schedule"]);
  assert.deepEqual(installationFeaturesForApiPath("/portal/v1/cross-location-schedules"), ["schedule"]);
  assert.deepEqual(installationFeaturesForApiPath("/vacations-preview.pdf"), ["vacation"]);
  assert.deepEqual(installationFeaturesForApiPath("/VACATIONS"), ["vacation"]);
});

test("v0.61.1 Funktionsprofil: Portal-Routen benoetigen alle betroffenen Module", () => {
  assert.deepEqual(
    new Set(installationFeaturesForApiPath("/portal/v1/me/vacation-requests")),
    new Set(["requests", "vacation", "employeePortal"]),
  );
  assert.deepEqual(
    new Set(installationFeaturesForApiPath("/portal/v1/me/time-entries")),
    new Set(["timeTracking", "employeePortal"]),
  );
  assert.deepEqual(
    new Set(installationFeaturesForApiPath("/portal/v1/me/amu-reports")),
    new Set(["sicknessAmu", "employeePortal"]),
  );
});

test("v0.61.1 Funktionsprofil: AUM aktiviert seine notwendigen Abhaengigkeiten", () => {
  assert.deepEqual(
    new Set(validateUsbFeatures({ enabledFeatures: ["sicknessAmu"] })),
    new Set(["schedule", "sicknessAmu", "requests", "employeePortal"]),
  );
});

test("Personal-Lebenszyklus: Fundament bleibt standardmaessig und in der USB-Bereitstellung gesperrt", () => {
  assert.equal(installationFeatures({ installation_features: JSON.stringify(["schedule"]) }).personnelLifecycle, false);
  assert.equal(
    installationFeatures({ installation_features: JSON.stringify(["schedule", "personnelLifecycle"]) }).personnelLifecycle,
    true,
  );
  assert.deepEqual(
    installationFeaturesForApiPath("/portal/v1/personnel-lifecycle/candidates"),
    ["personnelLifecycle"],
  );
  assert.equal(validateUsbFeatures({ enabledFeatures: ["personnelLifecycle"] }).includes("personnelLifecycle"), false);
});

test("v0.61.1 USB-Rollen: Abteilungsleitung benoetigt zwingend eine gueltige Abteilung", async () => {
  const employee = db.prepare(`
    SELECT personnel_number, home_location_id
    FROM employees
    WHERE active = 1 AND home_location_id IS NOT NULL AND preferred_department_id IS NULL
    ORDER BY personnel_number LIMIT 1
  `).get();
  assert.ok(employee);
  await assert.rejects(
    validateUsbEmployees(
      [{ sourcePersonnelNumber: employee.personnel_number, role: "department_manager" }],
      [employee.home_location_id],
      {
        personnelNumber: "999999",
        role: "admin",
        permissions: [PERSONNEL_LEARNING_PERMISSIONS.DELEGATE],
      },
    ),
    { code: "USB_EMPLOYEE_DEPARTMENT_REQUIRED" },
  );
});

test("Learning-Rechte: IT-Admin und Admin ohne Delegate können USB-Profile nicht ausweiten", async () => {
  const employee = db.prepare(`
    SELECT personnel_number, home_location_id
    FROM employees
    WHERE active = 1 AND home_location_id IS NOT NULL
    ORDER BY personnel_number LIMIT 1
  `).get();
  assert.ok(employee);
  for (const creator of [
    { personnelNumber: "999998", role: "it_admin", permissions: [] },
    { personnelNumber: "999997", role: "admin", permissions: [] },
  ]) {
    for (const role of ["manager", "department_manager", "hr", "admin"]) {
      await assert.rejects(
        validateUsbEmployees(
          [{
            sourcePersonnelNumber: employee.personnel_number,
            role,
            startPassword: "Nicht-Uebernehmen-2026!",
          }],
          [employee.home_location_id],
          creator,
        ),
        { code: "USB_EMPLOYEE_ROLE_DENIED" },
      );
    }
    await assert.rejects(
      validateUsbEmployees(
        [{
          sourcePersonnelNumber: employee.personnel_number,
          role: "employee",
          additionalPermissions: [PERSONNEL_LEARNING_PERMISSIONS.CATALOG_READ],
        }],
        [employee.home_location_id],
        creator,
      ),
      { code: "USB_EMPLOYEE_PERMISSION_DENIED" },
    );
  }
  await assert.rejects(
    validateUsbEmployees(
      [{
        sourcePersonnelNumber: employee.personnel_number,
        role: "employee",
        additionalPermissions: [PERSONNEL_LEARNING_PERMISSIONS.CATALOG_READ],
      }],
      [employee.home_location_id],
      {
        personnelNumber: "999996",
        role: "admin",
        permissions: [PERSONNEL_LEARNING_PERMISSIONS.DELEGATE],
      },
    ),
    { code: "PERSONNEL_LEARNING_PERMISSION_ROLE_RESTRICTED" },
  );
});

test("v0.80 USB-Rechte: entzogenes Dienstplan-Leserecht entzieht auch das Schreibrecht", async () => {
  const employee = db.prepare(`
    SELECT personnel_number, home_location_id
    FROM employees
    WHERE active = 1 AND home_location_id IS NOT NULL
    ORDER BY personnel_number LIMIT 1
  `).get();
  assert.ok(employee);
  const [validated] = await validateUsbEmployees(
    [{
      sourcePersonnelNumber: employee.personnel_number,
      role: "manager",
      deniedPermissions: ["schedule:read"],
    }],
    [employee.home_location_id],
    {
      personnelNumber: "999999",
      role: "admin",
      permissions: [PERSONNEL_LEARNING_PERMISSIONS.DELEGATE],
    },
  );
  assert.deepEqual(
    validated.deniedPermissions.filter((permission) => permission.startsWith("schedule:")).sort(),
    ["schedule:cross_location:read", "schedule:read", "schedule:write"],
  );
  assert.deepEqual(
    validated.deniedPermissions.filter(
      (permission) => CROSS_LOCATION_SCHEDULE_PERMISSION_IDS.includes(permission),
    ).sort(),
    [...CROSS_LOCATION_SCHEDULE_OPERATIONAL_PERMISSION_IDS].sort(),
  );
  assert.deepEqual(validated.scopes, [{ locationId: employee.home_location_id, departmentId: null }]);
});

test("v0.80 USB-Rechte: Dienstplan-Zusatzrecht ohne gueltigen Bereich wird abgewiesen", async () => {
  const employee = db.prepare(`
    SELECT personnel_number, home_location_id
    FROM employees
    WHERE active = 1 AND home_location_id IS NOT NULL AND preferred_department_id IS NULL
    ORDER BY personnel_number LIMIT 1
  `).get();
  assert.ok(employee);
  await assert.rejects(
    validateUsbEmployees(
      [{
        sourcePersonnelNumber: employee.personnel_number,
        role: "employee",
        additionalPermissions: ["schedule:read"],
      }],
      [employee.home_location_id],
      { personnelNumber: "999999", role: "admin" },
    ),
    { code: "USB_EMPLOYEE_SCOPE_REQUIRED" },
  );
});
