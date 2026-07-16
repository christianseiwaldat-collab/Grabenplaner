"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const sharp = require("sharp");

const {
  normalizeFirstStepsSpec,
  prepareLogoBuffer,
  renderFirstStepsPdf,
  writeFirstStepsPdfAtomically,
} = require("../lib/first-steps-pdf");

const SAFE_SVG = Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="320" height="100" viewBox="0 0 320 100">
    <rect width="320" height="100" rx="16" fill="#ffffff"/>
    <circle cx="48" cy="50" r="28" fill="#245a4a"/>
    <path d="M35 50h26M35 40h38M35 60h32" stroke="#ffffff" stroke-width="7" stroke-linecap="round"/>
    <text x="92" y="58" font-family="sans-serif" font-size="30" fill="#17212f">Musterfirma</text>
  </svg>
`, "utf8");

async function extractPdfText(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    useSystemFonts: true,
  });
  try {
    const document = await task.promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str).join(" "));
      page.cleanup();
    }
    await document.cleanup();
    return pages.join(" ").replace(/\s+/g, " ").trim();
  } finally {
    await task.destroy();
  }
}

function completeSpec(overrides = {}) {
  return {
    versionLabel: "v0.61.1 Beta",
    branding: {
      companyName: "Musterfirma Fotohandel",
      logoBuffer: SAFE_SVG,
      primaryColor: "#173f5f",
      secondaryColor: "#e6eff5",
      accentColor: "#f6c344",
      textColor: "#17212f",
      backgroundColor: "#f8f6ef",
    },
    content: {
      title: "Erste Schritte für das Planungsteam",
      introduction: "Willkommen im Grabenplaner. Diese Anleitung erklärt den sicheren Start.",
      steps: [
        { title: "Starten", text: "Öffnen Sie Grabenplaner starten.cmd im Hauptverzeichnis." },
        { title: "Planen", text: "Erstellen und prüfen Sie den Dienstplan für die gewünschte Woche." },
        { title: "Sichern", text: "Kopieren Sie Backups regelmäßig auf einen zweiten Datenträger." },
      ],
      features: ["Dienstplanung", "Urlaubsmanagement", "PDF-Ausgabe"],
      contact: {
        label: "Interne Unterstützung",
        name: "Alex Beispiel",
        email: "support@example.invalid",
        phone: "+43 1 555 0100",
        text: "Bei Fragen hilft die zuständige Administration.",
      },
      closingNote: "Nicht freigeschaltete Bereiche werden in dieser Installation nicht angezeigt.",
    },
    ...overrides,
  };
}

test("v0.61.1 Erste Schritte: rendert gebrandete, strukturierte Inhalte als PDF-Buffer", async () => {
  const buffer = await renderFirstStepsPdf(completeSpec());

  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length > 5_000);
  assert.equal(buffer.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.match(buffer.toString("latin1"), /\/Subtype \/Image/);

  const text = await extractPdfText(buffer);
  assert.match(text, /Erste Schritte für das Planungsteam/);
  assert.match(text, /Musterfirma Fotohandel/);
  assert.match(text, /Ihr schneller Einstieg/);
  assert.match(text, /Dienstplanung/);
  assert.match(text, /Urlaubsmanagement/);
  assert.match(text, /Interne Unterstützung/);
  assert.match(text, /support@example\.invalid/);
  assert.match(text, /v0\.61\.1 Beta/);
});

test("v0.61.1 Erste Schritte: normalisiert SVG, PNG, JPG und WebP mit sharp zu PNG", async () => {
  const raster = sharp({
    create: {
      width: 240,
      height: 80,
      channels: 4,
      background: { r: 36, g: 90, b: 74, alpha: 1 },
    },
  });
  const fixtures = [
    SAFE_SVG,
    await raster.clone().png().toBuffer(),
    await raster.clone().jpeg({ quality: 85 }).toBuffer(),
    await raster.clone().webp({ quality: 85 }).toBuffer(),
  ];

  for (const fixture of fixtures) {
    const normalized = await prepareLogoBuffer(fixture);
    const metadata = await sharp(normalized).metadata();
    assert.equal(metadata.format, "png");
    assert.ok(metadata.width <= 1200);
    assert.ok(metadata.height <= 360);
  }
});

test("v0.61.1 Erste Schritte: akzeptiert einen lokalen Logo-Pfad und lehnt URLs sowie aktive SVGs ab", async (context) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "grabenplaner-first-steps-logo-"));
  context.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const logoPath = path.join(directory, "logo.svg");
  await fs.promises.writeFile(logoPath, SAFE_SVG);

  const normalized = await prepareLogoBuffer(logoPath);
  assert.equal((await sharp(normalized).metadata()).format, "png");
  await assert.rejects(
    prepareLogoBuffer("https://example.invalid/logo.svg"),
    (error) => error.code === "FIRST_STEPS_LOGO_INVALID" && /lokale Datei/.test(error.message),
  );
  await assert.rejects(
    prepareLogoBuffer(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')),
    (error) => error.code === "FIRST_STEPS_LOGO_INVALID" && /nicht erlaubte/.test(error.message),
  );
  await assert.rejects(
    prepareLogoBuffer(Buffer.from(`${" ".repeat(5_000)}<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///C:/secret.png" /></svg>`)),
    (error) => error.code === "FIRST_STEPS_LOGO_INVALID" && /nicht erlaubte/.test(error.message),
  );
  await assert.rejects(
    prepareLogoBuffer(Buffer.from(`<!--${"x".repeat(5_000)}--><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)),
    (error) => error.code === "FIRST_STEPS_LOGO_INVALID" && /nicht erlaubte/.test(error.message),
  );
  await assert.rejects(
    prepareLogoBuffer(Buffer.from('<svg:svg xmlns:svg="http://www.w3.org/2000/svg"><svg:script>alert(1)</svg:script></svg:svg>')),
    (error) => error.code === "FIRST_STEPS_LOGO_INVALID" && /nicht erlaubte/.test(error.message),
  );
});

test("v0.61.1 Erste Schritte: behandelt Eingaben ausschließlich als begrenzten Klartext", () => {
  const normalized = normalizeFirstStepsSpec({
    versionLabel: "<b>v0.61.1</b> 😀",
    branding: {
      companyName: "<script>Firma</script>",
      primaryColor: "red",
    },
    content: {
      title: "<h1>Start</h1>",
      introduction: `<img src=x onerror=alert(1)>${"x".repeat(2_000)}`,
      steps: Array.from({ length: 12 }, (_, index) => ({
        title: `<b>Schritt ${index + 1}</b>`,
        text: "A".repeat(900),
      })),
      features: Array.from({ length: 20 }, (_, index) => `<i>Funktion ${index + 1}</i>`),
      contact: { text: "<a href='javascript:alert(1)'>Kontakt</a>" },
    },
  });

  const serialized = JSON.stringify(normalized);
  assert.doesNotMatch(serialized, /<\/?(?:script|h1|b|i|img|a)\b/i);
  assert.doesNotMatch(serialized, /😀/u);
  assert.equal(normalized.introduction.length, 1_400);
  assert.equal(normalized.steps.length, 8);
  assert.ok(normalized.steps.every((step) => step.text.length <= 2_400));
  assert.equal(normalized.features.length, 16);
  assert.equal(normalized.branding.colors.primary, "#245a4a");
  assert.equal(normalized.versionLabel, "v0.61.1");
});

test("v0.61.1 Erste Schritte: eine bewusst leere Kapitelwahl bleibt leer", async () => {
  const spec = completeSpec();
  spec.content.steps = [];
  spec.content.features = [];
  const normalized = normalizeFirstStepsSpec(spec);
  assert.deepEqual(normalized.steps, []);
  assert.deepEqual(normalized.features, []);
  const text = await extractPdfText(await renderFirstStepsPdf(spec));
  assert.doesNotMatch(text, /Ihr schneller Einstieg/);
  assert.doesNotMatch(text, /Freigeschaltete Bereiche/);
});

test("v0.61.1 Erste Schritte: schreibt im Zielordner atomisch und ersetzt eine vorhandene PDF", async (context) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "grabenplaner-first-steps-write-"));
  context.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const outputPath = path.join(directory, "Unterordner", "Erste Schritte.pdf");

  const first = await writeFirstStepsPdfAtomically(outputPath, completeSpec());
  assert.equal(first.path, path.resolve(outputPath));
  assert.equal(first.bytes, (await fs.promises.stat(outputPath)).size);

  const changed = completeSpec();
  changed.content.title = "Aktualisierte Kurzanleitung";
  const second = await writeFirstStepsPdfAtomically(outputPath, changed);
  const written = await fs.promises.readFile(outputPath);
  assert.equal(second.bytes, written.length);
  assert.equal(written.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.deepEqual(
    (await fs.promises.readdir(path.dirname(outputPath))).sort(),
    ["Erste Schritte.pdf"],
  );
  const text = await extractPdfText(written);
  assert.match(text, /Aktualisierte Kurzanleitung/);
  assert.doesNotMatch(text, /Erste Schritte für das Planungsteam/);
});

test("v0.61.1 Erste Schritte: weist einen nicht-PDF-Zielpfad zurück", async () => {
  await assert.rejects(
    writeFirstStepsPdfAtomically("Erste Schritte.txt", completeSpec()),
    (error) => error.code === "FIRST_STEPS_OUTPUT_INVALID",
  );
});
