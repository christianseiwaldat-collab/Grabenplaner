"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PassThrough } = require("node:stream");

const PDFDocument = require("pdfkit");
const sharp = require("sharp");

const MAX_LOGO_BYTES = 15 * 1024 * 1024;
const SUPPORTED_LOGO_FORMATS = new Set(["svg", "png", "jpeg", "webp"]);
const DEFAULT_COLORS = Object.freeze({
  primary: "#245a4a",
  secondary: "#e8f1ed",
  accent: "#f2c14e",
  text: "#17212f",
  background: "#f7f4ed",
});

const DEFAULT_CONTENT = Object.freeze({
  title: "Erste Schritte mit Grabenplaner",
  introduction: "Diese Kurzanleitung begleitet Sie durch den sicheren Start und zeigt die wichtigsten freigeschalteten Funktionen.",
  steps: [
    { title: "Grabenplaner starten", text: "Öffnen Sie im Hauptverzeichnis des USB-Sticks die Datei „Grabenplaner starten.cmd“ und warten Sie, bis sich der Browser öffnet." },
    { title: "Mit den Stammdaten beginnen", text: "Prüfen Sie Team, Standorte, Abteilungen und Zuständigkeiten, bevor Sie den ersten Plan erstellen." },
    { title: "Daten regelmäßig sichern", text: "Verwenden Sie den sichtbaren Backup-Ordner und bewahren Sie zusätzliche Sicherungen auf einem zweiten Datenträger auf." },
  ],
  features: ["Dienstplanung", "Urlaubsplanung"],
  closingNote: "Weitere Funktionen können später durch eine berechtigte Administration freigeschaltet werden.",
});

function sanitizePlainText(value, maximumLength, { multiline = false } = {}) {
  let text = String(value ?? "").normalize("NFC");
  text = text
    .replace(/\p{Extended_Pictographic}|\uFE0F/gu, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[<>]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\u00A0/g, " ");

  if (multiline) {
    text = text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/[\t ]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } else {
    text = text.replace(/\s+/g, " ").trim();
  }

  return text.slice(0, maximumLength).trim();
}

function normalizedColor(value, fallback) {
  const candidate = String(value || "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(candidate) ? candidate : fallback;
}

function normalizedContact(input) {
  if (typeof input === "string") {
    return {
      label: "Hilfe und Kontakt",
      name: "",
      email: "",
      phone: "",
      text: sanitizePlainText(input, 500, { multiline: true }),
    };
  }
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    label: sanitizePlainText(source.label || "Hilfe und Kontakt", 60) || "Hilfe und Kontakt",
    name: sanitizePlainText(source.name, 100),
    email: sanitizePlainText(source.email, 254),
    phone: sanitizePlainText(source.phone, 80),
    text: sanitizePlainText(source.text || source.note, 500, { multiline: true }),
  };
}

function normalizeFirstStepsSpec(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const brandingSource = source.branding && typeof source.branding === "object" ? source.branding : {};
  const contentSource = source.content && typeof source.content === "object" ? source.content : source;
  const stepsProvided = Array.isArray(contentSource.steps);
  const rawSteps = stepsProvided ? contentSource.steps : DEFAULT_CONTENT.steps;
  const featuresProvided = Array.isArray(contentSource.features);
  const rawFeatures = featuresProvided ? contentSource.features : DEFAULT_CONTENT.features;
  const steps = rawSteps.slice(0, 8).map((entry, index) => {
    const step = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : { text: entry };
    return {
      title: sanitizePlainText(step.title || `Schritt ${index + 1}`, 80) || `Schritt ${index + 1}`,
      text: sanitizePlainText(step.text || step.description, 2400, { multiline: true }),
    };
  }).filter((step) => step.title || step.text);
  const features = rawFeatures.slice(0, 16)
    .map((feature) => sanitizePlainText(
      feature && typeof feature === "object" ? feature.label || feature.name : feature,
      120,
    ))
    .filter(Boolean);

  return {
    title: sanitizePlainText(contentSource.title || DEFAULT_CONTENT.title, 120) || DEFAULT_CONTENT.title,
    introduction: sanitizePlainText(
      contentSource.introduction || contentSource.intro || DEFAULT_CONTENT.introduction,
      1400,
      { multiline: true },
    ),
    steps: stepsProvided ? steps : DEFAULT_CONTENT.steps.map((step) => ({ ...step })),
    features: featuresProvided ? features : [...DEFAULT_CONTENT.features],
    contact: normalizedContact(contentSource.contact),
    closingNote: sanitizePlainText(
      contentSource.closingNote || contentSource.finalNote || DEFAULT_CONTENT.closingNote,
      1000,
      { multiline: true },
    ),
    versionLabel: sanitizePlainText(source.versionLabel || contentSource.versionLabel, 60),
    branding: {
      companyName: sanitizePlainText(
        brandingSource.companyName || brandingSource.company_name || "",
        120,
      ),
      logoAlt: sanitizePlainText(
        brandingSource.logoAlt || brandingSource.logo_alt || brandingSource.companyName || "Grabenplaner",
        120,
      ) || "Grabenplaner",
      logo: brandingSource.logoBuffer || brandingSource.logoPath || brandingSource.logo || null,
      colors: {
        primary: normalizedColor(
          brandingSource.primaryColor || brandingSource.primary_color || brandingSource.colors?.primary,
          DEFAULT_COLORS.primary,
        ),
        secondary: normalizedColor(
          brandingSource.secondaryColor || brandingSource.secondary_color || brandingSource.colors?.secondary,
          DEFAULT_COLORS.secondary,
        ),
        accent: normalizedColor(
          brandingSource.accentColor || brandingSource.accent_color || brandingSource.colors?.accent,
          DEFAULT_COLORS.accent,
        ),
        text: normalizedColor(
          brandingSource.textColor || brandingSource.text_color || brandingSource.colors?.text,
          DEFAULT_COLORS.text,
        ),
        background: normalizedColor(
          brandingSource.backgroundColor || brandingSource.background_color || brandingSource.colors?.background,
          DEFAULT_COLORS.background,
        ),
      },
    },
  };
}

function logoError(message) {
  const error = new Error(message);
  error.code = "FIRST_STEPS_LOGO_INVALID";
  return error;
}

async function readLogoInput(input) {
  if (!input) return null;
  if (Buffer.isBuffer(input)) return Buffer.from(input);
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (typeof input !== "string") throw logoError("Das Branding-Logo hat ein nicht unterstütztes Eingabeformat.");
  if (/^(?:https?:|data:|file:)/i.test(input.trim())) {
    throw logoError("Das Branding-Logo muss als lokale Datei oder Dateiinhalt vorliegen.");
  }
  try {
    return await fs.promises.readFile(input);
  } catch {
    throw logoError("Das Branding-Logo konnte nicht gelesen werden.");
  }
}

function assertSafeSvg(buffer) {
  const source = buffer.toString("utf8");
  if (!/<svg\b/i.test(source)) return;
  const unsafeReference = [...source.matchAll(/\b(?:href|xlink:href)\s*=\s*(["'])(.*?)\1/gi)]
    .some((match) => !String(match[2] || "").trim().startsWith("#"));
  const unsafeCssUrl = [...source.matchAll(/\burl\s*\(([^)]*)\)/gi)]
    .some((match) => !String(match[1] || "").trim().replace(/^["']|["']$/g, "").startsWith("#"));
  if (/<!doctype|<!entity|<(?:[A-Za-z_][\w.-]*:)?(?:script|foreignObject|image|iframe)\b|\bon[a-z]+\s*=|@import\b/i.test(source)
    || unsafeReference || unsafeCssUrl) {
    throw logoError("Das SVG-Logo enthält nicht erlaubte aktive oder externe Inhalte.");
  }
}

async function prepareLogoBuffer(input) {
  const source = await readLogoInput(input);
  if (!source) return null;
  if (!source.length || source.length > MAX_LOGO_BYTES) {
    throw logoError("Das Branding-Logo ist leer oder größer als 15 MB.");
  }
  assertSafeSvg(source);

  try {
    const image = sharp(source, { failOn: "warning", limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    if (!SUPPORTED_LOGO_FORMATS.has(metadata.format)) {
      throw logoError("Das Branding-Logo muss SVG, PNG, JPG oder WebP sein.");
    }
    return await image
      .rotate()
      .resize({ width: 1200, height: 360, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
  } catch (error) {
    if (error?.code === "FIRST_STEPS_LOGO_INVALID") throw error;
    throw logoError("Das Branding-Logo konnte nicht sicher für die PDF aufbereitet werden.");
  }
}

function hexRgb(hex) {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

function contrastTextColor(hex) {
  const { r, g, b } = hexRgb(hex);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness > 155 ? "#17212f" : "#ffffff";
}

function renderDocument(spec, logoBuffer) {
  return new Promise((resolve, reject) => {
    const output = new PassThrough();
    const chunks = [];
    output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    output.once("error", reject);
    output.once("end", () => resolve(Buffer.concat(chunks)));

    const doc = new PDFDocument({
      size: "A4",
      layout: "portrait",
      margin: 0,
      compress: true,
      autoFirstPage: true,
      info: {
        Title: spec.title,
        Author: "Grabenplaner",
        Subject: `Erste Schritte${spec.versionLabel ? ` - ${spec.versionLabel}` : ""}`,
      },
    });
    doc.once("error", reject);
    doc.pipe(output);

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const left = 46;
    const contentWidth = pageWidth - left * 2;
    const footerTop = pageHeight - 47;
    const colors = spec.branding.colors;
    const headerText = contrastTextColor(colors.primary);
    let pageNumber = 1;
    let cursorY = 0;

    function drawPageChrome(firstPage = false) {
      doc.rect(0, 0, pageWidth, pageHeight).fill(colors.background);
      if (!firstPage) {
        doc.rect(0, 0, pageWidth, 48).fill(colors.primary);
        doc.fillColor(headerText).font("Helvetica-Bold").fontSize(11)
          .text(spec.title, left, 17, { width: contentWidth - 90, lineBreak: false, ellipsis: true });
      }
      doc.moveTo(left, footerTop).lineTo(pageWidth - left, footerTop).lineWidth(0.7).strokeColor(colors.secondary).stroke();
      doc.fillColor("#66717a").font("Helvetica").fontSize(7.5)
        .text(`Grabenplaner${spec.versionLabel ? ` ${spec.versionLabel}` : ""}`, left, footerTop + 13, { width: contentWidth / 2 });
      doc.text(`Seite ${pageNumber}`, pageWidth - left - 100, footerTop + 13, { width: 100, align: "right" });
    }

    function addContentPage() {
      doc.addPage({ size: "A4", layout: "portrait", margin: 0 });
      pageNumber += 1;
      drawPageChrome(false);
      cursorY = 72;
    }

    function ensureSpace(height) {
      if (cursorY + height > footerTop - 15) addContentPage();
    }

    function sectionTitle(title) {
      ensureSpace(35);
      doc.fillColor(colors.primary).font("Helvetica-Bold").fontSize(14)
        .text(title, left, cursorY, { width: contentWidth });
      cursorY += 25;
    }

    function paragraphCard(label, text) {
      if (!text) return;
      doc.font("Helvetica").fontSize(10);
      const textHeight = doc.heightOfString(text, { width: contentWidth - 32, lineGap: 2 });
      const labelHeight = label ? 20 : 0;
      const height = textHeight + labelHeight + 28;
      ensureSpace(height + 12);
      doc.roundedRect(left, cursorY, contentWidth, height, 9).fill(colors.secondary);
      let textY = cursorY + 14;
      if (label) {
        doc.fillColor(colors.primary).font("Helvetica-Bold").fontSize(9.5)
          .text(label, left + 16, textY, { width: contentWidth - 32 });
        textY += labelHeight;
      }
      doc.fillColor(colors.text).font("Helvetica").fontSize(10)
        .text(text, left + 16, textY, { width: contentWidth - 32, lineGap: 2 });
      cursorY += height + 12;
    }

    drawPageChrome(true);
    doc.roundedRect(0, 0, pageWidth, 154, 0).fill(colors.primary);
    const logoBoxX = left;
    const logoBoxY = 28;
    const logoBoxWidth = 178;
    const logoBoxHeight = 88;
    doc.roundedRect(logoBoxX, logoBoxY, logoBoxWidth, logoBoxHeight, 10).fill("#ffffff");
    if (logoBuffer) {
      doc.image(logoBuffer, logoBoxX + 12, logoBoxY + 12, {
        fit: [logoBoxWidth - 24, logoBoxHeight - 24],
        align: "center",
        valign: "center",
      });
    } else {
      doc.fillColor(colors.primary).font("Helvetica-Bold").fontSize(17)
        .text("Grabenplaner", logoBoxX + 12, logoBoxY + 34, { width: logoBoxWidth - 24, align: "center" });
    }
    doc.fillColor(headerText).font("Helvetica-Bold").fontSize(23)
      .text(spec.title, 248, 34, { width: pageWidth - 248 - left, height: 68, ellipsis: true });
    const companyLine = spec.branding.companyName || "Grabenplaner";
    doc.fillColor(headerText).font("Helvetica").fontSize(10)
      .text(companyLine, 248, 110, { width: pageWidth - 248 - left, lineBreak: false, ellipsis: true });

    cursorY = 180;
    paragraphCard("Willkommen", spec.introduction);

    if (spec.steps.length) sectionTitle("Ihr schneller Einstieg");
    spec.steps.forEach((step, index) => {
      doc.font("Helvetica").fontSize(9.5);
      const textHeight = step.text
        ? doc.heightOfString(step.text, { width: contentWidth - 76, lineGap: 1.5 })
        : 0;
      const height = Math.max(62, 35 + textHeight);
      ensureSpace(height + 10);
      doc.roundedRect(left, cursorY, contentWidth, height, 9).fill("#ffffff");
      doc.circle(left + 25, cursorY + 25, 14).fill(colors.accent);
      doc.fillColor(contrastTextColor(colors.accent)).font("Helvetica-Bold").fontSize(11)
        .text(String(index + 1), left + 16, cursorY + 20, { width: 18, align: "center" });
      doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(10.5)
        .text(step.title, left + 52, cursorY + 14, { width: contentWidth - 68 });
      if (step.text) {
        doc.fillColor(colors.text).font("Helvetica").fontSize(9.5)
          .text(step.text, left + 52, cursorY + 33, { width: contentWidth - 68, lineGap: 1.5 });
      }
      cursorY += height + 10;
    });

    if (spec.features.length) sectionTitle("Freigeschalteter Funktionsumfang");
    for (let index = 0; index < spec.features.length; index += 2) {
      ensureSpace(43);
      const gap = 10;
      const itemWidth = (contentWidth - gap) / 2;
      for (let offset = 0; offset < 2; offset += 1) {
        const feature = spec.features[index + offset];
        if (!feature) continue;
        const x = left + offset * (itemWidth + gap);
        doc.roundedRect(x, cursorY, itemWidth, 33, 8).fill(colors.secondary);
        doc.circle(x + 17, cursorY + 16.5, 5).fill(colors.primary);
        doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(9)
          .text(feature, x + 31, cursorY + 11, { width: itemWidth - 42, lineBreak: false, ellipsis: true });
      }
      cursorY += 43;
    }

    const contactLines = [spec.contact.name, spec.contact.email, spec.contact.phone, spec.contact.text].filter(Boolean);
    if (contactLines.length) paragraphCard(spec.contact.label, contactLines.join("\n"));
    if (spec.closingNote) paragraphCard("Zum Abschluss", spec.closingNote);

    doc.end();
  });
}

async function renderFirstStepsPdf(input = {}) {
  const spec = normalizeFirstStepsSpec(input);
  const logoBuffer = await prepareLogoBuffer(spec.branding.logo);
  return renderDocument(spec, logoBuffer);
}

async function writeFirstStepsPdfAtomically(outputPath, input = {}) {
  const targetPath = path.resolve(String(outputPath || ""));
  if (!outputPath || path.basename(targetPath) === "." || path.extname(targetPath).toLowerCase() !== ".pdf") {
    const error = new Error("Für die Erste-Schritte-PDF ist ein gültiger PDF-Zielpfad erforderlich.");
    error.code = "FIRST_STEPS_OUTPUT_INVALID";
    throw error;
  }
  const directory = path.dirname(targetPath);
  await fs.promises.mkdir(directory, { recursive: true });
  const buffer = await renderFirstStepsPdf(input);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let handle = null;
  try {
    handle = await fs.promises.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporaryPath, targetPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return { path: targetPath, bytes: buffer.length };
}

module.exports = {
  DEFAULT_COLORS,
  MAX_LOGO_BYTES,
  normalizeFirstStepsSpec,
  prepareLogoBuffer,
  renderFirstStepsPdf,
  writeFirstStepsPdfAtomically,
};
