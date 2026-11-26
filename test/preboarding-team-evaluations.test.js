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
  createPersonnelLifecycleService,
} = require("../lib/personnel-lifecycle");

const root = path.resolve(__dirname, "..");


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
