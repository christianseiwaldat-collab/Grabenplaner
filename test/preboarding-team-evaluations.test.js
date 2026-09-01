"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createAmuStorage } = require("../lib/amu-storage");
const { createCandidateEvaluationPdf } = require("../lib/candidate-evaluation-pdf");
const {
  createPersonnelLifecycleRepository,
} = require("../lib/persistence/repositories/personnel-lifecycle");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  SQLITE_PERSONNEL_LIFECYCLE_CATALOG,
} = require("../lib/persistence/sqlite/personnel-lifecycle-catalog");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");
const {
  createPersonnelLifecycleService,
} = require("../lib/personnel-lifecycle");

const root = path.resolve(__dirname, "..");

async function serviceFixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_PERSONNEL_LIFECYCLE_CATALOG,
  });
  ensureSqliteApplicationSchema(application.database);
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-team-evaluation-"));
  const storage = createAmuStorage({
    rootDirectory: storageRoot,
    encryptionKeys: {
      test: crypto.createHash("sha256").update("team-evaluation-test-key").digest(),
    },
    activeKeyId: "test",
    scanner: async () => true,
  });
  const repository = createPersonnelLifecycleRepository(application.provider);
  const service = createPersonnelLifecycleService(repository, {
    protectJson: (value, context) => storage.protectRecord(JSON.stringify(value), context),
    parseProtectedJson: (value, context) => JSON.parse(storage.unprotectRecord(value, context)),
  });
  return {
    ...application,
    service,
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

async function pdfTextAndPages(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: Uint8Array.from(buffer),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const document = await loadingTask.promise;
  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str).join(" "));
      page.cleanup();
    }
    return { pageCount: document.numPages, pages };
  } finally {
    await loadingTask.destroy();
  }
}

test("Preboarding-MA-Bewertungen bleiben eigentümergebunden, revisionssicher und getrennt auswertbar", async () => {
  const fixture = await serviceFixture();
  try {
    const candidate = await fixture.service.createCandidate({
      dataProcessingAuthorizationConfirmed: true,
      profile: {
        firstName: "Synthetisch",
        lastName: "Kandidatin",
        email: "candidate-secret@example.invalid",
      },
      application: {
        desiredRoleTitle: "Verkauf",
        competencyRatings: [
          { id: "professional", label: "Fachliche Eignung", rating: 4, note: "FL vertraulich" },
          { id: "team", label: "Zusammenarbeit", rating: 2, note: "FL zweiter Hinweis" },
        ],
      },
    }, "FL-1");
    let application = candidate.applications[0];

    application = await fixture.service.assignTeamEvaluators(
      candidate.id,
      application.id,
      {
        revision: application.revision,
        employeeNumbers: ["MA-1", "FL-2"],
      },
      "FL-1",
      { eligibleEmployeeNumbers: ["MA-1", "FL-2"] },
    );
    assert.equal(application.teamEvaluations.length, 2);
    assert.deepEqual(application.evaluationSummary, {
      assignedCount: 2,
      completedCount: 0,
      pendingCount: 2,
      flOverall: 3,
      employeeOverall: null,
      combinedOverall: null,
      criteria: [
        {
          id: "professional",
          label: "Fachliche Eignung",
          flRating: 4,
          flComment: "FL vertraulich",
          employeeAverage: null,
          combinedAverage: null,
          reviewerRatings: [],
        },
        {
          id: "team",
          label: "Zusammenarbeit",
          flRating: 2,
          flComment: "FL zweiter Hinweis",
          employeeAverage: null,
          combinedAverage: null,
          reviewerRatings: [],
        },
      ],
    });

    const [assignment] = await fixture.service.listTeamEvaluationAssignments("MA-1");
    assert.deepEqual(Object.keys(assignment).sort(), [
      "applicationRevision",
      "assignedAt",
      "candidateName",
      "criteria",
      "desiredRoleTitle",
      "id",
      "trialAppointment",
    ]);
    assert.deepEqual(assignment.criteria, [
      { id: "professional", label: "Fachliche Eignung" },
      { id: "team", label: "Zusammenarbeit" },
    ]);
    const employeeProjection = JSON.stringify(assignment);
    assert.doesNotMatch(employeeProjection, /candidate-secret|FL vertraulich|flRating|employeeNumber/);

    application = await fixture.service.updateApplication(
      candidate.id,
      application.id,
      {
        revision: application.revision,
        competencyRatings: [
          { id: "professional", label: "Fachliche Eignung aktualisiert", rating: 5 },
          { id: "team", label: "Zusammenarbeit aktualisiert", rating: 1 },
        ],
      },
      "FL-1",
    );
    const [snapshotAssignment] = await fixture.service.listTeamEvaluationAssignments("MA-1");
    assert.deepEqual(snapshotAssignment.criteria, assignment.criteria);

    await assert.rejects(
      fixture.service.submitTeamEvaluation(
        snapshotAssignment.id,
        {
          revision: snapshotAssignment.applicationRevision,
          criteria: [
            { id: "professional", rating: 5, comment: "Fremde Abgabe" },
            { id: "team", rating: 5, comment: "Fremde Abgabe" },
          ],
        },
        "FL-2",
      ),
      (error) => error?.code === "PERSONNEL_LIFECYCLE_TEAM_EVALUATION_NOT_FOUND",
    );

    const submitted = await fixture.service.submitTeamEvaluation(
      snapshotAssignment.id,
      {
        revision: snapshotAssignment.applicationRevision,
        criteria: [
          { id: "professional", rating: 2, comment: "Sachliche Teambeobachtung" },
          { id: "team", rating: 4, comment: "Gute Zusammenarbeit" },
        ],
      },
      "MA-1",
    );
    assert.equal(submitted.id, snapshotAssignment.id);
    assert.match(submitted.submittedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(await fixture.service.listTeamEvaluationAssignments("MA-1"), []);
    await assert.rejects(
      fixture.service.submitTeamEvaluation(
        snapshotAssignment.id,
        { revision: snapshotAssignment.applicationRevision, criteria: [] },
        "MA-1",
      ),
      (error) => error?.code === "PERSONNEL_LIFECYCLE_TEAM_EVALUATION_NOT_FOUND",
    );

    const reread = await fixture.service.getCandidate(candidate.id);
    application = reread.applications[0];
    assert.equal(application.evaluationSummary.assignedCount, 2);
    assert.equal(application.evaluationSummary.completedCount, 1);
    assert.equal(application.evaluationSummary.pendingCount, 1);
    assert.equal(application.evaluationSummary.flOverall, 3);
    assert.equal(application.evaluationSummary.employeeOverall, 3);
    assert.equal(application.evaluationSummary.combinedOverall, 3);
    assert.deepEqual(
      application.evaluationSummary.criteria.map((criterion) => ({
        id: criterion.id,
        fl: criterion.flRating,
        employees: criterion.employeeAverage,
        combined: criterion.combinedAverage,
      })),
      [
        { id: "professional", fl: 5, employees: 2, combined: 3.5 },
        { id: "team", fl: 1, employees: 4, combined: 2.5 },
      ],
    );
    assert.equal(
      application.evaluationSummary.criteria[0].reviewerRatings[0].comment,
      "Sachliche Teambeobachtung",
    );

    await assert.rejects(
      fixture.service.assignTeamEvaluators(
        candidate.id,
        application.id,
        { revision: application.revision, employeeNumbers: ["FL-1"] },
        "FL-1",
        { eligibleEmployeeNumbers: ["FL-1"] },
      ),
      (error) => error?.code === "PERSONNEL_LIFECYCLE_TEAM_EVALUATOR_INVALID",
    );
  } finally {
    await fixture.close();
  }
});

test("Bewerbungsbewertung-PDF bleibt bei umfangreichen Bewertungen eine A4-Einzelseite", async () => {
  const criteria = Array.from({ length: 20 }, (_, index) => ({
    id: `criterion-${index + 1}`,
    label: `Bewertungskriterium ${index + 1}`,
    flRating: 4,
    flComment: `FL-Kommentar ${index + 1}`,
    employeeAverage: 3.5,
    combinedAverage: 3.75,
    reviewerRatings: [{
      employeeNumber: "MA-1",
      rating: 3,
      comment: `MA-Kommentar ${index + 1}`,
    }],
  }));
  const buffer = await createCandidateEvaluationPdf({
    candidateName: "Synthetische Kandidatin",
    desiredRoleTitle: "Verkauf",
    evaluationSummary: {
      flOverall: 4,
      employeeOverall: 3.5,
      combinedOverall: 3.75,
      assignedCount: 2,
      completedCount: 1,
      criteria,
    },
    reviewerNames: { "MA-1": "Testmitarbeiterin" },
    generatedAt: new Date("2026-09-01T09:00:00.000Z"),
  });
  assert.equal(buffer.subarray(0, 5).toString("ascii"), "%PDF-");
  const inspected = await pdfTextAndPages(buffer);
  assert.equal(inspected.pageCount, 1);
  assert.match(inspected.pages[0], /Bewerbungsbewertung/);
  assert.match(inspected.pages[0], /Synthetische Kandidatin/);
  assert.match(inspected.pages[0], /FL-BEWERTUNG/);
  assert.match(inspected.pages[0], /MA-BEWERTUNG/);
  assert.match(inspected.pages[0], /MA \+ FL/);
  assert.match(inspected.pages[0], /Weitere 6 Kriterien/);
});

test("Preboarding-UI nutzt Vollbreitenliste, reduzierte Bewertungsfläche und Einseitenexport", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const portal = fs.readFileSync(path.join(root, "public", "portal.js"), "utf8");
  const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  const evaluationHtml = fs.readFileSync(
    path.join(root, "public", "candidate-evaluation.html"),
    "utf8",
  );
  const evaluationScript = fs.readFileSync(
    path.join(root, "public", "candidate-evaluation.js"),
    "utf8",
  );
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

  assert.match(html, /id="personnelCandidateSort"/);
  assert.match(html, /personnel-candidate-workspace-full/);
  assert.match(app, /personnelCandidateSort === "name_asc"/);
  assert.match(app, /personnel-candidate-list-header/);
  assert.match(styles, /\.personnel-candidate-workspace\.personnel-candidate-workspace-full \{ grid-template-columns:minmax\(0,1fr\); \}/);
  assert.match(app, /Bewertung zuweisen/);
  assert.match(app, /Durchschnitt im Detail/);
  assert.match(app, /Einseitiges PDF exportieren/);

  assert.doesNotMatch(evaluationHtml, /<nav|Abmelden|logout/i);
  assert.match(evaluationHtml, /candidate-evaluation\.js/);
  assert.match(evaluationScript, /★/);
  assert.match(evaluationScript, /Kommentar/);
  assert.match(evaluationScript, /\/api\/portal\/v1\/me\/candidate-evaluations/);
  assert.match(portal, /redirectToPendingCandidateEvaluation/);
  assert.match(app, /redirectAdministrationToCandidateEvaluation/);

  assert.match(server, /\/team-evaluations"/);
  assert.match(server, /\/evaluators"/);
  assert.match(server, /\/candidate-evaluations\/:evaluationId"/);
  assert.match(server, /\/evaluation\.pdf"/);
  assert.match(server, /createCandidateEvaluationPdf/);
});
