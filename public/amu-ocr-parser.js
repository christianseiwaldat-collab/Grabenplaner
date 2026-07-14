(function attachAmuOcrParser(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") root.GrabenplanerAmuOcrParser = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function createAmuOcrParser() {
  "use strict";

  const OCR_DIGIT_CLASS = "0-9OoQqIl|!SsBb";
  const DATE_WITH_SEPARATOR = new RegExp(
    `(^|[^${OCR_DIGIT_CLASS}])([${OCR_DIGIT_CLASS}]{1,2})\\s*[.\\/-]\\s*([${OCR_DIGIT_CLASS}]{1,2})\\s*[.\\/-]\\s*([${OCR_DIGIT_CLASS}]{2}|[${OCR_DIGIT_CLASS}]{4})(?![${OCR_DIGIT_CLASS}])`,
    "g",
  );
  const DATE_WITH_SPACES = new RegExp(
    `(^|[^${OCR_DIGIT_CLASS}])([${OCR_DIGIT_CLASS}]{1,2})\\s+([${OCR_DIGIT_CLASS}]{1,2})\\s+([${OCR_DIGIT_CLASS}]{2}|[${OCR_DIGIT_CLASS}]{4})(?![${OCR_DIGIT_CLASS}])`,
    "g",
  );

  const START_LABELS = [
    { pattern: /\barbeitsunfaehig(?:keit)?\s+(?:ab|seit|von|vom)\b/g, weight: 78 },
    { pattern: /\bbeginn(?:\s+der)?\s+arbeitsunfaehigkeit\b/g, weight: 78 },
    { pattern: /\berster\s+tag(?:\s+der)?\s+arbeitsunfaehigkeit\b/g, weight: 76 },
    { pattern: /\bkrank(?:en)?stand\s+(?:ab|seit|von|vom)\b/g, weight: 66 },
    { pattern: /\bunfaehig\s+(?:ab|seit|von|vom)\b/g, weight: 62 },
  ];
  const END_LABELS = [
    { pattern: /\bvoraussichtlich(?:e[rsn]?)?(?:\s+arbeitsunfaehig)?\s+bis\b/g, weight: 82 },
    { pattern: /\barbeitsunfaehig(?:keit)?\s+bis\b/g, weight: 78 },
    { pattern: /\bletzter\s+tag(?:\s+der)?\s+arbeitsunfaehigkeit\b/g, weight: 78 },
    { pattern: /\bende(?:\s+der)?\s+arbeitsunfaehigkeit\b/g, weight: 76 },
    { pattern: /\bbis\s+einschliesslich\b/g, weight: 74 },
  ];
  const NEGATIVE_LABEL = /\b(?:geburtsdatum|geburts\s*datum|ausstellungsdatum|ausgestellt\s+am|datum\s+der\s+ausstellung|untersuchungsdatum|aufnahmedatum|druckdatum)\b/;
  const AUM_CONTEXT = /\b(?:arbeitsunfaehig(?:keit)?|krank(?:en)?stand|voraussichtlich)\b/;
  const CANONICAL_WORDS = [
    "arbeitsunfaehig",
    "arbeitsunfaehigkeit",
    "voraussichtlich",
    "einschliesslich",
  ];

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function foldText(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/ß/g, "ss")
      .toLowerCase();
  }

  function levenshtein(left, right) {
    if (left === right) return 0;
    if (!left.length) return right.length;
    if (!right.length) return left.length;
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
      const current = [leftIndex + 1];
      for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
        current.push(Math.min(
          current[rightIndex] + 1,
          previous[rightIndex + 1] + 1,
          previous[rightIndex] + (left[leftIndex] === right[rightIndex] ? 0 : 1),
        ));
      }
      previous = current;
    }
    return previous[right.length];
  }

  function canonicalizeWord(word) {
    const prepared = word.replace(/0/g, "o").replace(/1/g, "i");
    for (const canonical of CANONICAL_WORDS) {
      const allowedDistance = canonical.length >= 18 ? 3 : 2;
      if (Math.abs(prepared.length - canonical.length) <= allowedDistance
          && levenshtein(prepared, canonical) <= allowedDistance) return canonical;
    }
    return prepared;
  }

  function canonicalizeLine(value) {
    return foldText(value)
      .replace(/arbeitsunf[^a-z0-9]{1,3}hig(?:keit)?/g, (match) => (match.endsWith("keit") ? "arbeitsunfaehigkeit" : "arbeitsunfaehig"))
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(canonicalizeWord)
      .join(" ");
  }

  function ocrDigits(value) {
    return String(value || "")
      .replace(/[OoQq]/g, "0")
      .replace(/[Il|!]/g, "1")
      .replace(/[Ss]/g, "5")
      .replace(/[Bb]/g, "8");
  }

  function referenceYear(options) {
    const reference = options && options.referenceDate ? new Date(options.referenceDate) : new Date();
    return Number.isFinite(reference.getTime()) ? reference.getUTCFullYear() : new Date().getUTCFullYear();
  }

  function expandedYear(value, yearReference) {
    const parsed = Number(ocrDigits(value));
    if (!Number.isInteger(parsed)) return null;
    if (String(value).length === 4) return parsed;
    let year = (Math.floor(yearReference / 100) * 100) + parsed;
    if (year > yearReference + 20) year -= 100;
    if (year < yearReference - 80) year += 100;
    return year;
  }

  function validIsoDate(dayValue, monthValue, yearValue, yearReference) {
    const day = Number(ocrDigits(dayValue));
    const month = Number(ocrDigits(monthValue));
    const effectiveReferenceYear = Number.isInteger(Number(yearReference))
      ? Number(yearReference)
      : new Date().getUTCFullYear();
    const year = expandedYear(yearValue, effectiveReferenceYear);
    if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) return "";
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function collectMatches(pattern, value, weight) {
    const matches = [];
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(value))) {
      matches.push({ index: match.index, end: match.index + match[0].length, weight });
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
    return matches;
  }

  function labelMatches(line, definitions, kind) {
    const matches = definitions.flatMap((definition) => collectMatches(definition.pattern, line, definition.weight));
    if (AUM_CONTEXT.test(line)) {
      const generic = kind === "start" ? /\b(?:ab|seit|von|vom)\b/g : /\bbis\b/g;
      matches.push(...collectMatches(generic, line, kind === "start" ? 46 : 48));
    }
    return matches;
  }

  function dateCandidatesFromLine(rawLine, foldedLine, lineIndex, yearReference) {
    const candidates = [];
    const patterns = [{ regex: DATE_WITH_SEPARATOR, quality: 13 }];
    if (AUM_CONTEXT.test(foldedLine)) patterns.push({ regex: DATE_WITH_SPACES, quality: 7 });
    for (const { regex, quality } of patterns) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(rawLine))) {
        const iso = validIsoDate(match[2], match[3], match[4], yearReference);
        if (iso) {
          const index = match.index + match[1].length;
          candidates.push({ iso, lineIndex, index, end: index + match[0].length - match[1].length, quality });
        }
        if (match[0].length === 0) regex.lastIndex += 1;
      }
    }
    const unique = new Map();
    for (const candidate of candidates) {
      const key = `${candidate.lineIndex}:${candidate.index}:${candidate.iso}`;
      const previous = unique.get(key);
      if (!previous || candidate.quality > previous.quality) unique.set(key, candidate);
    }
    return [...unique.values()];
  }

  function distanceFromReference(iso, options) {
    const reference = options && options.referenceDate ? new Date(options.referenceDate) : new Date();
    if (!Number.isFinite(reference.getTime())) return 0;
    const target = new Date(`${iso}T00:00:00Z`);
    return Math.round((target.getTime() - reference.getTime()) / 86400000);
  }

  function plausibilityScore(candidate, options) {
    const distance = distanceFromReference(candidate.iso, options);
    if (distance < -730 || distance > 730) return -16;
    if (distance < -180 || distance > 365) return -7;
    if (distance >= -90 && distance <= 120) return 6;
    return 1;
  }

  function scoreCandidate(candidate, kind, lineInfo, options) {
    let best = candidate.quality + plausibilityScore(candidate, options);
    let labeled = false;
    for (let lineOffset = 0; lineOffset <= 2; lineOffset += 1) {
      const labelLineIndex = candidate.lineIndex - lineOffset;
      if (labelLineIndex < 0) continue;
      const info = lineInfo[labelLineIndex];
      const labels = kind === "start" ? info.startLabels : info.endLabels;
      for (const label of labels) {
        let positional = 0;
        let spatiallyRelated = false;
        if (lineOffset === 0) {
          if (candidate.index >= label.end) {
            const oppositeLabels = kind === "start" ? info.endLabels : info.startLabels;
            const crossedOppositeLabel = oppositeLabels.some((opposite) => opposite.end > label.end && opposite.end <= candidate.index);
            positional = crossedOppositeLabel
              ? -32
              : 17 - Math.min(10, Math.floor((candidate.index - label.end) / 12));
            spatiallyRelated = !crossedOppositeLabel;
          } else positional = -18;
        } else {
          positional = 11 - (lineOffset * 4);
          spatiallyRelated = true;
        }
        const score = label.weight + positional + candidate.quality + plausibilityScore(candidate, options);
        if (score > best) best = score;
        if (spatiallyRelated) labeled = true;
      }
    }
    if (lineInfo[candidate.lineIndex].negative) best -= 58;
    return { ...candidate, score: best, labeled };
  }

  function choosePair(starts, ends) {
    let best = null;
    for (const start of starts) {
      for (const end of ends) {
        if (start.lineIndex === end.lineIndex && start.index === end.index) continue;
        if (end.iso < start.iso) continue;
        let score = start.score + end.score;
        if (start.lineIndex === end.lineIndex && start.index < end.index) score += 8;
        if (end.lineIndex >= start.lineIndex && end.lineIndex - start.lineIndex <= 3) score += 4;
        if (!best || score > best.score) best = { start, end, score };
      }
    }
    return best;
  }

  function hasInvalidExplicitInlinePeriod(rawLine, candidates) {
    const folded = foldText(rawLine);
    const startLabel = /\b(?:arbeitsunf(?:a|ae)hig(?:keit)?|krank(?:en)?stand)\s+(?:ab|seit|von|vom)\b/.exec(folded);
    if (!startLabel) return false;
    const afterStart = startLabel.index + startLabel[0].length;
    const endLabelRelative = /\bbis\b/.exec(folded.slice(afterStart));
    if (!endLabelRelative) return false;
    const endLabelIndex = afterStart + endLabelRelative.index;
    const first = candidates.find((candidate) => candidate.index >= afterStart && candidate.index < endLabelIndex);
    const second = candidates.find((candidate) => candidate.index >= endLabelIndex + endLabelRelative[0].length);
    return Boolean(first && second && second.iso < first.iso);
  }

  function confidenceFor(candidate) {
    if (!candidate) return 0;
    return Number(clamp((candidate.score - 25) / 78, 0, 1).toFixed(2));
  }

  function extractAumDates(ocrInput, options = {}) {
    const rawText = typeof ocrInput === "string" ? ocrInput : String(ocrInput && ocrInput.text || "");
    const rawLines = rawText.replace(/\r/g, "").split("\n").slice(0, 500);
    const yearReference = referenceYear(options);
    const lineInfo = rawLines.map((raw) => {
      const folded = canonicalizeLine(raw);
      return {
        folded,
        negative: NEGATIVE_LABEL.test(folded),
        startLabels: labelMatches(folded, START_LABELS, "start"),
        endLabels: labelMatches(folded, END_LABELS, "end"),
      };
    });
    const candidates = rawLines.flatMap((line, lineIndex) => dateCandidatesFromLine(
      line,
      lineInfo[lineIndex].folded,
      lineIndex,
      yearReference,
    ));
    const invalidExplicitChronology = rawLines.some((line, lineIndex) => hasInvalidExplicitInlinePeriod(
      line,
      candidates.filter((candidate) => candidate.lineIndex === lineIndex),
    ));
    if (invalidExplicitChronology) {
      return {
        dateFrom: "",
        dateTo: "",
        confidence: 0,
        fieldConfidence: { dateFrom: 0, dateTo: 0 },
        autoFillFields: { dateFrom: false, dateTo: false },
        complete: false,
        autoFill: false,
        requiresConfirmation: true,
        warnings: ["chronology_invalid"],
      };
    }
    const starts = candidates.map((candidate) => scoreCandidate(candidate, "start", lineInfo, options))
      .sort((left, right) => right.score - left.score || left.lineIndex - right.lineIndex || left.index - right.index);
    const ends = candidates.map((candidate) => scoreCandidate(candidate, "end", lineInfo, options))
      .sort((left, right) => right.score - left.score || left.lineIndex - right.lineIndex || left.index - right.index);
    const pair = choosePair(starts, ends);
    let start = pair ? pair.start : starts.find((candidate) => candidate.labeled && candidate.score >= 58) || null;
    let end = pair ? pair.end : ends.find((candidate) => candidate.labeled && candidate.score >= 58) || null;

    if (start && end && end.iso < start.iso) end = null;
    const dateFromConfidence = confidenceFor(start);
    const dateToConfidence = confidenceFor(end);
    const complete = Boolean(start && end);
    const autoFillFields = {
      dateFrom: Boolean(start && start.labeled && dateFromConfidence >= 0.72),
      dateTo: Boolean(end && end.labeled && dateToConfidence >= 0.72),
    };
    const autoFill = complete && autoFillFields.dateFrom && autoFillFields.dateTo;
    const warnings = [];
    if (!candidates.length) warnings.push("no_date_detected");
    else if (!complete) warnings.push("period_incomplete");
    else if (!autoFill) warnings.push("manual_confirmation_recommended");

    // Deliberately return only derived dates and scores. OCR text and document
    // fragments must remain transient and are never part of the result object.
    return {
      dateFrom: start ? start.iso : "",
      dateTo: end ? end.iso : "",
      confidence: complete ? Number(Math.min(dateFromConfidence, dateToConfidence).toFixed(2)) : 0,
      fieldConfidence: {
        dateFrom: dateFromConfidence,
        dateTo: dateToConfidence,
      },
      autoFillFields,
      complete,
      autoFill,
      requiresConfirmation: true,
      warnings,
    };
  }

  return Object.freeze({
    extractAumDates,
    parseDateParts: validIsoDate,
  });
}));
