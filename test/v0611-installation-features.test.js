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
  installationFeaturesForApiPath,
  releaseInstanceLockForTests,
  validateUsbEmployees,
  validateUsbFeatures,
} = require("../server");

test.after(() => {
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.61.1 Funktionsprofil: direkte Planungs- und PDF-Routen bleiben serverseitig gesperrt", () => {
  assert.deepEqual(installationFeaturesForApiPath("/schedule-note/2026-07-20"), ["schedule"]);
  assert.deepEqual(installationFeaturesForApiPath("/schedule-preview.pdf"), ["schedule"]);
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
      { personnelNumber: "999999", role: "admin" },
    ),
    { code: "USB_EMPLOYEE_DEPARTMENT_REQUIRED" },
  );
});
