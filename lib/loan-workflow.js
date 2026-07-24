"use strict";

const { normalizeArticleNumber } = require("./article-catalog");

const LOAN_CONDITIONS = Object.freeze([
  "good",
  "used",
  "damaged",
  "incomplete",
]);
const LOAN_CONDITION_SET = new Set(LOAN_CONDITIONS);
const MAX_LOAN_ITEMS = 5;

class LoanWorkflowError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "LoanWorkflowError";
    this.code = code;
  }
}

function workflowError(message, code) {
  return new LoanWorkflowError(message, code);
}

function normalizeLoanText(value, maximumLength, { required = false } = {}) {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (required && !normalized) {
    throw workflowError("Eine erforderliche Angabe fehlt.", "LOAN_TEXT_REQUIRED");
  }
  if (normalized.length > maximumLength) {
    throw workflowError(
      `Die Eingabe darf höchstens ${maximumLength} Zeichen lang sein.`,
      "LOAN_TEXT_TOO_LONG",
    );
  }
  return normalized;
}

function normalizeLoanCondition(value, { required = true } = {}) {
  const condition = String(value || "").trim();
  if (!condition && !required) return "";
  if (!LOAN_CONDITION_SET.has(condition)) {
    throw workflowError("Bitte einen gültigen Artikelzustand auswählen.", "LOAN_CONDITION_INVALID");
  }
  return condition;
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizeLoanDueDate(value, { minimum = "", maximum = "" } = {}) {
  const date = String(value || "").trim();
  if (!date) return null;
  if (!isIsoDate(date) || (minimum && date < minimum) || (maximum && date > maximum)) {
    throw workflowError(
      "Das geplante Rückgabedatum ist ungültig.",
      "LOAN_DUE_DATE_INVALID",
    );
  }
  return date;
}

function normalizeLoanIssueItems(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_LOAN_ITEMS) {
    throw workflowError(
      `Eine Leihe benötigt ein bis ${MAX_LOAN_ITEMS} Artikel.`,
      "LOAN_ITEMS_INVALID",
    );
  }
  return value.map((item, index) => {
    let articleNumber;
    try {
      articleNumber = normalizeArticleNumber(item?.articleNumber);
    } catch {
      throw workflowError(
        `Position ${index + 1}: Die Artikelnummer muss genau sechs Ziffern haben.`,
        "LOAN_ARTICLE_NUMBER_INVALID",
      );
    }
    return Object.freeze({
      position: index + 1,
      articleNumber,
      serialNumber: normalizeLoanText(item?.serialNumber, 100),
      conditionOut: normalizeLoanCondition(item?.conditionOut || "good"),
      note: normalizeLoanText(item?.note, 500),
    });
  });
}

function normalizeLoanReturnItems(value, storedItems) {
  const expected = Array.isArray(storedItems) ? storedItems : [];
  if (!expected.length || !Array.isArray(value) || value.length !== expected.length) {
    throw workflowError(
      "Die Rücknahme muss alle ausgeliehenen Artikel enthalten.",
      "LOAN_RETURN_ITEMS_INVALID",
    );
  }
  const byPosition = new Map();
  for (const item of value) {
    const position = Number(item?.position);
    if (!Number.isInteger(position) || byPosition.has(position)) {
      throw workflowError(
        "Die Rücknahmepositionen sind unvollständig oder doppelt.",
        "LOAN_RETURN_ITEMS_INVALID",
      );
    }
    byPosition.set(position, item);
  }
  return expected.map((stored) => {
    const position = Number(stored.position);
    const item = byPosition.get(position);
    if (!item) {
      throw workflowError(
        "Die Rücknahme muss alle ausgeliehenen Artikel enthalten.",
        "LOAN_RETURN_ITEMS_INVALID",
      );
    }
    return Object.freeze({
      position,
      conditionReturn: normalizeLoanCondition(item.conditionReturn),
      note: normalizeLoanText(item.note, 500),
    });
  });
}

module.exports = {
  LOAN_CONDITIONS,
  MAX_LOAN_ITEMS,
  LoanWorkflowError,
  normalizeLoanCondition,
  normalizeLoanDueDate,
  normalizeLoanIssueItems,
  normalizeLoanReturnItems,
  normalizeLoanText,
};
