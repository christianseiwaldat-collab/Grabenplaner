"use strict";

const { parseDocument } = require("htmlparser2");
const DEFAULT_SIZE = 10;
const LEGACY_SIZES = Object.freeze({ small: 5.7, normal: 6.4, medium: 6.4, large: 7.2 });
const BLOCKED = new Set(["script", "style", "svg", "math", "iframe", "object", "template", "noscript"]);
const escape = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const stripEmoji = value => String(value || "").replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "").replace(/[\u2600-\u27BF]/gu, "").replace(/\uFEFF/g, "");
class ScheduleNoteValidationError extends Error {
  constructor(message) { super(message); this.name = "ScheduleNoteValidationError"; this.code = "SCHEDULE_NOTE_FORMAT_INVALID"; }
}

function pointSize(value) {
  if (Object.hasOwn(LEGACY_SIZES, value)) return LEGACY_SIZES[value];
  const text = String(value ?? "").trim();
  if (!/^\d{1,2}(?:\.\d)?(?:pt)?$/i.test(text)) return null;
  const size = Number(text.replace(/pt$/i, ""));
  return Number.isFinite(size) && size >= 4 && size <= 72 ? size : null;
}

function nodeSize(node) {
  const attributes = node.attribs || {};
  if (Object.hasOwn(attributes, "data-size")) return pointSize(attributes["data-size"]);
  const classes = String(attributes.class || "").split(/\s+/);
  for (const name of classes) {
    const numeric = /^ql-size-(\d{1,2}(?:_\d)?)pt$/.exec(name);
    if (numeric) return pointSize(numeric[1].replace("_", "."));
    const legacy = /^ql-size-(small|normal|large)$/.exec(name);
    if (legacy) return pointSize(legacy[1]);
  }
  const size = String(attributes.style || "").match(/(?:^|;)\s*font-size\s*:\s*(\d{1,2}(?:\.\d)?pt)\s*(?:;|$)/i);
  return size ? pointSize(size[1]) : null;
}

function sanitizedHtml(input) {
  // The text limit is checked by the existing endpoint. Bound markup as well:
  // 900 individually formatted characters still fit comfortably in this cap.
  const source = String(input || "");
  if (source.length > 128 * 1024) throw new ScheduleNoteValidationError("Die Formatierung der Bemerkung ist zu umfangreich.");
  const document = parseDocument(source, { decodeEntities: true });
  function render(node, depth) {
    if (depth > 100) throw new ScheduleNoteValidationError("Die Formatierung der Bemerkung ist zu tief verschachtelt.");
    if (node.type === "text") return escape(stripEmoji(node.data));
    const tag = node.name?.toLowerCase();
    if (BLOCKED.has(tag) || /(?:^|\s)ql-cursor(?:\s|$)/.test(node.attribs?.class || "")) return "";
    const body = (node.children || []).map(child => render(child, depth + 1)).join("");
    if (tag === "br") return "<br>";
    const size = nodeSize(node);
    const content = size === null ? body : `<span data-size="${size}">${body}</span>`;
    if (["div", "p"].includes(tag)) return "<div>" + content + "</div>";
    if (["b", "strong"].includes(tag)) return "<b>" + content + "</b>";
    if (["i", "em"].includes(tag)) return "<i>" + content + "</i>";
    if (tag === "u") return "<u>" + content + "</u>";
    return content;
  }
  return (document.children || []).map(node => render(node, 0)).join("").trim();
}

function storedHtml(note = {}) {
  try {
    const html = sanitizedHtml(note.note_html || "");
    if (html && !html.replace(/<[^>]*>/g, "").trim() && String(note.note_text || "").trim())
      return escape(stripEmoji(note.note_text)).replace(/\n/g, "<br>");
    return html;
  }
  catch (error) {
    if (!(error instanceof ScheduleNoteValidationError) || String(note.note_text || "").length > 900) throw error;
    // A damaged historical format must not break the complete schedule PDF.
    // Its full, independently stored plain text remains the fallback, without
    // accepting the malformed markup as a new editable representation.
    return escape(stripEmoji(note.note_text || "")).replace(/\n/g, "<br>");
  }
}

function richSegments(note = {}) {
  const source = storedHtml(note);
  if (!source) return [{ text: stripEmoji(note.note_text || ""), bold: Boolean(note.bold), italic: Boolean(note.italic),
    underline: Boolean(note.underline), size: pointSize(note.font_size) ?? DEFAULT_SIZE }];
  const document = parseDocument(source, { decodeEntities: true });
  const segments = [];
  function push(text, style) {
    if (!text) return;
    const previous = segments.at(-1);
    if (previous && ["bold", "italic", "underline", "size"].every(key => previous[key] === style[key])) previous.text += text;
    else segments.push({ text, ...style });
  }
  function walk(node, inherited) {
    if (node.type === "text") { push(node.data.replace(/\u00a0/g, " "), inherited); return; }
    const tag = node.name?.toLowerCase();
    if (tag === "br") { push("\n", inherited); return; }
    const style = { ...inherited };
    if (tag === "b") style.bold = true;
    if (tag === "i") style.italic = true;
    if (tag === "u") style.underline = true;
    const size = nodeSize(node); if (size !== null) style.size = size;
    if (tag === "div" && segments.length && !segments.at(-1).text.endsWith("\n")) push("\n", inherited);
    for (const child of node.children || []) walk(child, style);
    if (tag === "div" && (!segments.length || !segments.at(-1).text.endsWith("\n"))) push("\n", inherited);
  }
  for (const node of document.children || []) walk(node, { bold: false, italic: false, underline: false, size: DEFAULT_SIZE });
  while (segments.length && /^\n+$/.test(segments[0].text)) segments.shift();
  if (segments.length) segments[0].text = segments[0].text.replace(/^\n+/, "");
  while (segments.length && /^\n+$/.test(segments.at(-1).text)) segments.pop();
  if (segments.length) segments[segments.length - 1].text = segments.at(-1).text.replace(/\n+$/, "");
  return segments.filter(segment => segment.text);
}

function plainText(html) {
  return richSegments({ note_html: html }).map(segment => segment.text).join("").trim();
}

function font(style) {
  return style.bold ? (style.italic ? "Helvetica-BoldOblique" : "Helvetica-Bold") : (style.italic ? "Helvetica-Oblique" : "Helvetica");
}

function layout(doc, note, width) {
  if (!Number.isFinite(width) || width < 1) throw new RangeError("Invalid schedule note width");
  const lines = []; let runs = [], lineWidth = 0;
  function flush(explicit = false) {
    while (runs.length && /^\s+$/.test(runs.at(-1).text)) { lineWidth -= runs.at(-1).width; runs.pop(); }
    if (runs.length || explicit) {
      const size = runs.length ? Math.max(...runs.map(run => run.size)) : DEFAULT_SIZE;
      const ascent = Math.max(size * .8, ...runs.map(run => run.ascent));
      const descent = Math.max(size * .2, ...runs.map(run => run.descent));
      lines.push({ runs, width: lineWidth, ascent, height: ascent + descent + Math.max(2, size * .18) });
    }
    runs = []; lineWidth = 0;
  }
  function append(text, style) {
    const size = pointSize(style.size) ?? DEFAULT_SIZE;
    doc.font(font(style)).fontSize(size);
    const measured = doc.widthOfString(text);
    // Standard Helvetica's ascender (718) is lower than its accented glyph
    // bounding box (up to 962). Reserve the full box and keep PDFKit's text
    // baseline offset separate so large German accents never cross a row.
    const baselineOffset = doc._font.ascender / 1000 * size;
    const ascent = Math.max(doc._font.ascender, doc._font.bbox?.[3] || 0) / 1000 * size;
    const descent = -Math.min(doc._font.descender, doc._font.bbox?.[1] || 0) / 1000 * size;
    if (runs.length && lineWidth + measured > width + .001) flush();
    if (!runs.length && /^\s+$/.test(text)) return;
    if (measured > width && [...text].length > 1) {
      for (const character of text) append(character, style);
      return;
    }
    runs.push({ ...style, text, size, width: measured, baselineOffset, ascent, descent }); lineWidth += measured;
  }
  for (const segment of richSegments(note)) {
    for (const token of segment.text.split(/(\n|[^\S\n]+)/).filter(Boolean)) {
      if (token === "\n") flush(true); else append(token, segment);
    }
  }
  flush();
  return { lines, width };
}

function paginate(lines, firstHeight, continuationHeight) {
  const pages = [[]]; let height = 0, limit = firstHeight;
  for (const line of lines) {
    if (line.height > limit && pages.length === 1 && !pages[0].length) { pages.push([]); limit = continuationHeight; height = 0; }
    if (height + line.height > limit + .001 && pages.at(-1).length) { pages.push([]); height = 0; limit = continuationHeight; }
    if (line.height > limit) throw new RangeError("Schedule note line cannot fit continuation page");
    pages.at(-1).push(line); height += line.height;
  }
  return pages;
}

function draw(doc, lines, x, y) {
  let top = y;
  for (const line of lines) {
    let cursor = x;
    for (const run of line.runs) {
      doc.fillColor("#1e252b").font(font(run)).fontSize(run.size).text(run.text, cursor, top + line.ascent - run.baselineOffset,
        { lineBreak: false, width: Math.max(1, run.width + .05), underline: Boolean(run.underline) });
      cursor += run.width;
    }
    top += line.height;
  }
  return top;
}

module.exports = { DEFAULT_SIZE, LEGACY_SIZES, ScheduleNoteValidationError, pointSize, sanitizedHtml, storedHtml, richSegments, plainText, font, layout, paginate, draw, escape };
