"use strict";

// Reviewed text comparisons only. SQLite's explicit NOCASE collation affects
// both operands, whereas wrapping just the collated operand changes equality.
// Keep the frozen DDL compiler untouched; application extensions and explicit
// test seeds opt into this token rewrite before the historical expression pass.
const S = require("./sql");
const operators = new Set(["=", "!=", "<>", "<", ">", "<=", ">=", "IS"]);
const arithmetic = new Set(["+", "-", "*", "/", "%", "||"]);
const upper = value => String(value || "").toUpperCase();

function scalarEnd(tokens, start) {
  if (["+", "-"].includes(tokens[start])) return scalarEnd(tokens, start + 1);
  if (tokens[start] === "(") return S.matching(tokens, start);
  let end = start;
  while (tokens[end + 1] === "." && tokens[end + 2]) end += 2;
  if (tokens[end + 1] === "(") end = S.matching(tokens, end + 1);
  return end;
}

function normalizeAsciiNoCaseComparisons(sql) {
  const tokens = S.tokens(String(sql));
  for (let index = 0; index < tokens.length; index++) {
    if (!operators.has(upper(tokens[index]))) continue;
    let operationEnd = index;
    if (upper(tokens[index]) === "IS" && upper(tokens[index + 1]) === "NOT") operationEnd++;
    const operation = tokens.slice(index, operationEnd + 1);
    let leftEnd = index - 1;
    const leftCollation = upper(tokens[leftEnd - 1]) === "COLLATE" ? upper(tokens[leftEnd]) : null;
    if (leftCollation) leftEnd -= 2;
    if (leftEnd < 0 || operationEnd + 1 >= tokens.length) continue;
    const leftStart = S.atomStart(tokens, leftEnd);
    const rightStart = operationEnd + 1;
    const rightEnd = scalarEnd(tokens, rightStart);
    const rightCollation = upper(tokens[rightEnd + 1]) === "COLLATE" ? upper(tokens[rightEnd + 2]) : null;
    if (leftCollation !== "NOCASE" && rightCollation !== "NOCASE") continue;
    if (leftCollation && leftCollation !== "NOCASE" || rightCollation && rightCollation !== "NOCASE") {
      throw new Error("PG_ASCII_NOCASE_CONFLICTING_COLLATIONS");
    }
    if (arithmetic.has(tokens[leftStart - 1]) || arithmetic.has(tokens[rightEnd + (rightCollation ? 3 : 1)])) {
      throw new Error("PG_ASCII_NOCASE_REQUIRES_BOUNDED_SCALARS");
    }
    const end = rightEnd + (rightCollation ? 2 : 0);
    const left = tokens.slice(leftStart, leftEnd + 1), right = tokens.slice(rightStart, rightEnd + 1);
    const replacement = ["gp", ".", "ascii_fold", "(", ...left, ")", "COLLATE", '"C"', ...operation,
      "gp", ".", "ascii_fold", "(", ...right, ")", "COLLATE", '"C"'];
    tokens.splice(leftStart, end - leftStart + 1, ...replacement);
    index = leftStart + replacement.length - 1;
  }
  return S.text(tokens);
}

module.exports = { normalizeAsciiNoCaseComparisons };
