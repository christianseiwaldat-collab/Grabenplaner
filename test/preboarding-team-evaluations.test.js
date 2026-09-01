"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createAmuStorage } = require("../lib/amu-storage");
const {
  CandidateEvaluationPdfError,
  createCandidateEvaluationPdf,
  normalizeCandidateEvaluationPdfOptions,
} = require("../lib/candidate-evaluation-pdf");
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
    const sizes = [];
    const items = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str).join(" "));
      sizes.push({ width: viewport.width, height: viewport.height });
      items.push(content.items.map((item) => ({ text: item.str, x: item.transform?.[4] || 0 })));
      page.cleanup();
    }
    return { pageCount: document.numPages, pages, sizes, items };
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

test("Bewerbungsbewertung-PDF zeigt Übersicht und vollständige Kommentare auf zwei A4-Seiten", async () => {
  const criteria = Array.from({ length: 9 }, (_, index) => ({
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
  assert.equal(inspected.pageCount, 2);
  assert.match(inspected.pages[0], /Bewerbungsbewertung/);
  assert.match(inspected.pages[0], /Synthetische Kandidatin/);
  assert.match(inspected.pages[0], /FL-BEWERTUNG/);
  assert.match(inspected.pages[0], /MA-BEWERTUNG/);
  assert.match(inspected.pages[0], /MA \+ FL/);
  assert.match(inspected.pages[0], /Bewertungskriterium 1/);
  assert.match(inspected.pages[0], /Bewertungskriterium 9/);
  assert.match(inspected.pages[0], /1\s+2\s+3\s+4\s+5/);
  assert.doesNotMatch(inspected.pages[0], /Weitere .* Kriterien/);
  assert.match(inspected.pages[1], /Bewertungen und Kommentare im Detail/);
  assert.match(inspected.pages[1], /FL-Kommentar 1/);
  assert.match(inspected.pages[1], /FL-Kommentar 9/);
  assert.match(inspected.pages[1], /MA-Kommentar 1/);
  assert.match(inspected.pages[1], /MA-Kommentar 9/);
  assert.match(inspected.pages[1], /Testmitarbeiterin/);
  const detailCommentPositions = inspected.items[1]
    .filter((item) => item.text.includes("FL-Kommentar"))
    .map((item) => item.x);
  assert.ok(detailCommentPositions.some((x) => x < inspected.sizes[1].width / 2));
  assert.ok(detailCommentPositions.some((x) => x > inspected.sizes[1].width / 2));
});

test("Bewerbungsbewertung-PDF unterstützt ein- und zweiseitig in Hoch- und Querformat", async () => {
  const criteria = Array.from({ length: 6 }, (_, index) => ({
    id: `matrix-${index + 1}`,
    label: `Matrixkriterium ${index + 1}`,
    flRating: 4,
    flComment: `FL-Hinweis ${index + 1}`,
    employeeAverage: 3,
    combinedAverage: 3.5,
    reviewerRatings: [{
      employeeNumber: "MA-MATRIX",
      rating: 3,
      comment: `MA-Hinweis ${index + 1}`,
    }],
  }));
  for (const pageMode of ["single", "two"]) {
    for (const orientation of ["portrait", "landscape"]) {
      const inspected = await pdfTextAndPages(await createCandidateEvaluationPdf({
        candidateName: "Matrix Kandidatin",
        desiredRoleTitle: "Verkauf",
        evaluationSummary: {
          flOverall: 4,
          employeeOverall: 3,
          combinedOverall: 3.5,
          assignedCount: 1,
          completedCount: 1,
          criteria,
        },
        reviewerNames: { "MA-MATRIX": "Matrix Teammitglied" },
        exportOptions: {
          pageMode,
          orientation,
          colorRgb: [104, 63, 132],
        },
      }));
      assert.equal(inspected.pageCount, pageMode === "single" ? 1 : 2);
      assert.ok(inspected.sizes.every(({ width, height }) => (
        orientation === "portrait" ? width < height : width > height
      )));
      const fullText = inspected.pages.join(" ");
      assert.match(fullText, /Matrixkriterium 6/);
      assert.match(fullText, /FL-Hinweis 6/);
      assert.match(fullText, /MA-Hinweis 6/);
    }
  }
});

test("Bewerbungsbewertung-PDF wendet Bereichsbranding und auswählbare Inhalte an", async () => {
  const logo = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#683f84"/><text x="8" y="26" fill="white">TEST</text></svg>');
  const inspected = await pdfTextAndPages(await createCandidateEvaluationPdf({
    candidateName: "Branding Test",
    desiredRoleTitle: "Verkauf",
    evaluationSummary: {
      flOverall: 4,
      employeeOverall: 3,
      combinedOverall: 3.5,
      assignedCount: 1,
      completedCount: 1,
      criteria: [{
        id: "branding",
        label: "Auftreten",
        flRating: 4,
        flComment: "Nicht exportierter FL-Kommentar",
        employeeAverage: 3,
        combinedAverage: 3.5,
        reviewerRatings: [{
          employeeNumber: "MA-BRANDING",
          rating: 3,
          comment: "Exportierter MA-Kommentar",
        }],
      }],
    },
    reviewerNames: { "MA-BRANDING": "Nicht exportierter Name" },
    branding: {
      companyName: "Musterbereich GmbH",
      logoBuffer: logo,
      colors: { primary: "#683f84" },
    },
    exportOptions: {
      pageMode: "two",
      orientation: "portrait",
      applyBranding: true,
      includeLogo: true,
      showFlComments: false,
      showEmployeeComments: true,
      showReviewerNames: false,
      showRoleTitle: false,
      showGeneratedAt: false,
    },
  }));
  const fullText = inspected.pages.join(" ");
  assert.equal(inspected.pageCount, 2);
  assert.match(fullText, /Musterbereich GmbH/);
  assert.match(fullText, /Exportierter MA-Kommentar/);
  assert.doesNotMatch(fullText, /Nicht exportierter FL-Kommentar/);
  assert.doesNotMatch(fullText, /Nicht exportierter Name/);
  assert.doesNotMatch(fullText, /Erstellt:/);
  assert.deepEqual(
    normalizeCandidateEvaluationPdfOptions({ colorRgb: [104, 63, 132] }).colorRgb,
    [104, 63, 132],
  );
});

test("Einseitenexport meldet Überlauf, statt Bewertungen oder Kommentare abzuschneiden", async () => {
  const criteria = Array.from({ length: 20 }, (_, index) => ({
    id: `overflow-${index + 1}`,
    label: `Sehr umfangreiches Kriterium ${index + 1}`,
    flRating: 4,
    flComment: `Vollständiger FL-Langtext ${index + 1} `.repeat(18),
    reviewerRatings: [{
      employeeNumber: "MA-OVERFLOW",
      rating: 3,
      comment: `Vollständiger MA-Langtext ${index + 1} `.repeat(18),
    }],
  }));
  await assert.rejects(
    createCandidateEvaluationPdf({
      candidateName: "Überlauf Test",
      evaluationSummary: { criteria },
      exportOptions: { pageMode: "single", orientation: "portrait" },
    }),
    (error) => error instanceof CandidateEvaluationPdfError
      && error.code === "CANDIDATE_EVALUATION_PDF_SINGLE_PAGE_OVERFLOW",
  );
});

test("Bewerbungsbewertung-PDF kürzt auch bei vielen Kriterien keine Detailkommentare still", async () => {
  const criteria = Array.from({ length: 20 }, (_, index) => ({
    id: `criterion-${index + 1}`,
    label: `Bewertungskriterium ${index + 1}`,
    flRating: 4,
    flComment: `Vollständiger FL-Kommentar ${index + 1}`,
    employeeAverage: 3,
    combinedAverage: 3.5,
    reviewerRatings: [{
      employeeNumber: "MA-1",
      rating: 3,
      comment: `Vollständiger MA-Kommentar ${index + 1}`,
    }],
  }));
  const inspected = await pdfTextAndPages(await createCandidateEvaluationPdf({
    candidateName: "Umfangreiche Testbewerbung",
    desiredRoleTitle: "Verkauf",
    evaluationSummary: {
      flOverall: 4,
      employeeOverall: 3,
      combinedOverall: 3.5,
      assignedCount: 1,
      completedCount: 1,
      criteria,
    },
    reviewerNames: { "MA-1": "Testmitarbeiterin" },
  }));
  assert.ok(inspected.pageCount >= 3);
  assert.match(inspected.pages[0], /Bewertungskriterium 20/);
  const detailText = inspected.pages.slice(1).join(" ");
  assert.match(detailText, /Vollständiger FL-Kommentar 20/);
  assert.match(detailText, /Vollständiger MA-Kommentar 20/);
  assert.doesNotMatch(detailText, /weitere Kommentare im Grabenplaner/i);
});

test("Preboarding-UI nutzt Vollbreitenliste, reduzierte Bewertungsfläche und Bewertungs-PDF", () => {
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
  assert.match(app, /Bewertungs-PDF exportieren/);
  assert.match(app, /PDF-Exportoptionen/);
  assert.match(app, /Diese Einstellungen gelten nur für das aktuell angemeldete Konto/);
  assert.match(app, /keine vollständig speicherplatzsparende Vektor-PDF möglich/);
  assert.match(app, /JJMMTT_/);
  assert.match(app, /Die Dienstplan- und Urlaubsplan-PDF-Einstellungen werden dadurch nicht verändert/);
  assert.match(styles, /\.personnel-candidate-pdf-options-panel/);

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
  assert.match(server, /createCandidateEvaluationPdfArtifact/);
  assert.match(server, /candidate_evaluation_pdf_v1/);
  assert.match(server, /candidateEvaluationPdfPreferencesForActor/);
});
