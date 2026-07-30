"use strict";

const { createHash } = require("node:crypto");
const {
  assertPersistenceStatement,
} = require("../contract");

const POSTGRESQL_DIALECT_COMPILER_VERSION = 2;
const POSTGRESQL_DIALECT_STRATEGIES = Object.freeze([
  "portable-generated",
  "requires-override",
]);

const CLAUSE_TERMINATORS = new Set([
  "except",
  "fetch",
  "for",
  "groups",
  "intersect",
  "limit",
  "offset",
  "range",
  "returning",
  "rows",
  "union",
  "window",
]);

function invalidCompilerInput(message) {
  return new TypeError(message);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowedKeys, label) {
  if (!isPlainRecord(value)) {
    throw invalidCompilerInput(`${label} muss ein einfaches Objekt sein.`);
  }
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalidCompilerInput(`${label} enthält unbekannte Felder.`);
  }
}

function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex");
}

function consumeQuoted(sql, start, delimiter, escapedDelimiter) {
  let index = start + 1;
  while (index < sql.length) {
    if (sql.startsWith(escapedDelimiter, index)) {
      index += escapedDelimiter.length;
      continue;
    }
    if (sql[index] === delimiter) return index + 1;
    index += 1;
  }
  throw invalidCompilerInput("Das SQL enthält ein nicht abgeschlossenes Literal oder Identifier.");
}

function consumeBracketIdentifier(sql, start) {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === "]" && sql[index + 1] === "]") {
      index += 2;
      continue;
    }
    if (sql[index] === "]") return index + 1;
    index += 1;
  }
  throw invalidCompilerInput("Das SQL enthält einen nicht abgeschlossenen Klammer-Identifier.");
}

function consumeBlockComment(sql, start) {
  let index = start + 2;
  let depth = 1;
  while (index < sql.length) {
    if (sql[index] === "/" && sql[index + 1] === "*") {
      depth += 1;
      index += 2;
      continue;
    }
    if (sql[index] === "*" && sql[index + 1] === "/") {
      depth -= 1;
      index += 2;
      if (depth === 0) return index;
      continue;
    }
    index += 1;
  }
  throw invalidCompilerInput("Das SQL enthält einen nicht abgeschlossenen Blockkommentar.");
}

function tokenizeSql(sql) {
  const tokens = [];
  let index = 0;

  function push(type, end) {
    tokens.push(Object.freeze({
      type,
      text: sql.slice(index, end),
      start: index,
      end,
    }));
    index = end;
  }

  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (/\s/.test(character)) {
      let end = index + 1;
      while (/\s/.test(sql[end] || "")) end += 1;
      push("whitespace", end);
      continue;
    }
    if (character === "-" && next === "-") {
      let end = index + 2;
      while (end < sql.length && sql[end] !== "\n") end += 1;
      push("comment", end);
      continue;
    }
    if (character === "/" && next === "*") {
      push("comment", consumeBlockComment(sql, index));
      continue;
    }
    if (character === "'") {
      push("string", consumeQuoted(sql, index, "'", "''"));
      continue;
    }
    if (character === "\"") {
      push("quoted-identifier", consumeQuoted(sql, index, "\"", "\"\""));
      continue;
    }
    if (character === "`") {
      push("sqlite-quoted-identifier", consumeQuoted(sql, index, "`", "``"));
      continue;
    }
    if (character === "[") {
      push("sqlite-quoted-identifier", consumeBracketIdentifier(sql, index));
      continue;
    }
    if (character === "$") {
      let quoteEnd = index + 1;
      while (/[A-Za-z0-9_]/.test(sql[quoteEnd] || "")) quoteEnd += 1;
      if (sql[quoteEnd] === "$") {
        throw invalidCompilerInput("PostgreSQL-Dollar-Quotes sind im Dialektkatalog nicht erlaubt.");
      }
      if (/[0-9]/.test(next || "")) {
        throw invalidCompilerInput("Rohe positionale PostgreSQL-Parameter sind nicht erlaubt.");
      }
      if (!/[A-Za-z]/.test(next || "")) {
        throw invalidCompilerInput("Ein Dollarzeichen muss einen benannten Parameter einleiten.");
      }
      let end = index + 2;
      while (/[A-Za-z0-9_]/.test(sql[end] || "")) end += 1;
      push("parameter", end);
      continue;
    }
    if (character === "?") {
      throw invalidCompilerInput("Fragezeichen-Parameter sind im PostgreSQL-Dialekt nicht erlaubt.");
    }
    if ((character === ":" || character === "@") && /[A-Za-z]/.test(next || "")) {
      throw invalidCompilerInput("Nur benannte Dollar-Parameter sind erlaubt.");
    }
    if (character === ":" && next === ":") {
      push("symbol", index + 2);
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      let end = index + 1;
      while (/[A-Za-z0-9_]/.test(sql[end] || "")) end += 1;
      push("word", end);
      continue;
    }
    if (/[0-9]/.test(character)) {
      let end = index + 1;
      while (/[0-9.]/.test(sql[end] || "")) end += 1;
      push("number", end);
      continue;
    }
    push("symbol", index + 1);
  }

  return Object.freeze(tokens);
}

function significantTokenIndexes(tokens) {
  return tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => token.type !== "whitespace" && token.type !== "comment")
    .map(({ index }) => index);
}

function lowerToken(token) {
  return token?.type === "word" ? token.text.toLowerCase() : "";
}

function tokenIsSymbol(token, symbol) {
  return token?.type === "symbol" && token.text === symbol;
}

function functionCallAt(tokens, significant, position, name) {
  const token = tokens[significant[position]];
  const next = tokens[significant[position + 1]];
  return lowerToken(token) === name && tokenIsSymbol(next, "(");
}

function matchingParenthesisPosition(tokens, significant, openPosition) {
  let depth = 0;
  for (let position = openPosition; position < significant.length; position += 1) {
    const token = tokens[significant[position]];
    if (tokenIsSymbol(token, "(")) depth += 1;
    if (tokenIsSymbol(token, ")")) {
      depth -= 1;
      if (depth === 0) return position;
    }
  }
  return -1;
}

function detectBlockingFeatures(tokens, significant) {
  const features = new Set();

  if (tokens.some((token) => token.type === "sqlite-quoted-identifier")) {
    features.add("sqlite.quoted-identifier");
  }

  for (let position = 0; position < significant.length; position += 1) {
    const token = tokens[significant[position]];
    const word = lowerToken(token);
    const nextWord = lowerToken(tokens[significant[position + 1]]);
    const afterNextWord = lowerToken(tokens[significant[position + 2]]);

    if (word === "insert" && nextWord === "or" && afterNextWord === "ignore") {
      features.add("sqlite.insert-or-ignore");
    }
    if (word === "insert" && nextWord === "or" && afterNextWord === "replace") {
      features.add("sqlite.insert-or-replace");
    }
    if (word === "collate" && nextWord === "nocase") {
      features.add("sqlite.collate-nocase");
    }
    if (word === "like") features.add("sqlite.like-operator");
    if (word === "glob") features.add("sqlite.glob-operator");
    if (word === "rowid") features.add("sqlite.rowid-pseudocolumn");
    if (word === "autoincrement") features.add("sqlite.autoincrement");
    if (word === "pragma") features.add("sqlite.pragma");
    if (["sqlite_master", "sqlite_schema", "sqlite_sequence"].includes(word)) {
      features.add("sqlite.schema-catalog");
    }

    if ((word === "json" || word.startsWith("json_"))
      && functionCallAt(tokens, significant, position, word)) {
      features.add("sqlite.json-functions");
    }
    if (["date", "datetime", "strftime", "time"].includes(word)
      && functionCallAt(tokens, significant, position, word)) {
      features.add("sqlite.date-time-functions");
    }
    if (word === "julianday" && functionCallAt(tokens, significant, position, word)) {
      features.add("sqlite.julianday-function");
    }
    if (word === "pragma_table_info" && functionCallAt(tokens, significant, position, word)) {
      features.add("sqlite.schema-catalog");
    }
    if (word === "group_concat" && functionCallAt(tokens, significant, position, word)) {
      features.add("sqlite.group-concat");
    }
    if (word === "instr" && functionCallAt(tokens, significant, position, word)) {
      features.add("sqlite.instr-function");
    }
    if (word === "char" && functionCallAt(tokens, significant, position, word)) {
      features.add("sqlite.char-function");
    }
    if (word === "raise" && functionCallAt(tokens, significant, position, word)) {
      features.add("sqlite.raise-function");
    }

    if (word === "cast" && functionCallAt(tokens, significant, position, word)) {
      const closePosition = matchingParenthesisPosition(tokens, significant, position + 1);
      if (closePosition < 0) {
        throw invalidCompilerInput("Ein CAST-Ausdruck ist nicht abgeschlossen.");
      }
      for (let inner = position + 2; inner + 1 < closePosition; inner += 1) {
        if (lowerToken(tokens[significant[inner]]) === "as"
          && lowerToken(tokens[significant[inner + 1]]) === "integer") {
          features.add("sqlite.cast-integer");
        }
      }
    }
  }

  return features;
}

function validatedParameterOrder(statement, tokens) {
  const expected = Object.keys(statement.parameters).sort();
  const actual = new Set();
  for (const token of tokens) {
    if (token.type === "parameter") actual.add(token.text.slice(1));
  }
  const actualSorted = [...actual].sort();
  if (JSON.stringify(expected) !== JSON.stringify(actualSorted)) {
    throw invalidCompilerInput(
      "SQL-Parameter und Statementvertrag müssen exakt übereinstimmen.",
    );
  }
  return Object.freeze(expected);
}

function sqlStringValue(token) {
  if (token?.type !== "string"
    || token.text.length < 2
    || token.text[0] !== "'"
    || token.text[token.text.length - 1] !== "'") {
    throw invalidCompilerInput("Der JSON-Pfad muss ein statisches SQL-Textliteral sein.");
  }
  return token.text.slice(1, -1).replace(/''/g, "'");
}

function jsonPathSegments(path) {
  if (path === "$") return Object.freeze([]);
  if (typeof path !== "string" || !path.startsWith("$")) {
    throw invalidCompilerInput("Der JSON-Pfad muss bei der Wurzel beginnen.");
  }
  const segments = [];
  let offset = 1;
  while (offset < path.length) {
    const property = /^\.([A-Za-z_][A-Za-z0-9_]*)/.exec(path.slice(offset));
    if (property) {
      if (["__proto__", "constructor", "prototype"].includes(property[1])) {
        throw invalidCompilerInput("Der JSON-Pfad enthält ein gesperrtes Segment.");
      }
      segments.push(property[1]);
      offset += property[0].length;
      continue;
    }
    const arrayIndex = /^\[(\d+)\]/.exec(path.slice(offset));
    if (arrayIndex) {
      const index = Number(arrayIndex[1]);
      if (!Number.isSafeInteger(index)) {
        throw invalidCompilerInput("Der JSON-Pfad enthält einen ungültigen Index.");
      }
      segments.push(index);
      offset += arrayIndex[0].length;
      continue;
    }
    throw invalidCompilerInput("Der JSON-Pfad verwendet eine nicht unterstützte Syntax.");
  }
  return Object.freeze(segments);
}

function frozenParameterBinding(parameter, source, path = []) {
  return Object.freeze({
    parameter,
    source,
    path: Object.freeze([...path]),
  });
}

function jsonFunctionCompilation(tokens, significant, statement, parameterOrder) {
  const functions = [];
  for (let position = 0; position < significant.length; position += 1) {
    const name = lowerToken(tokens[significant[position]]);
    if ((name === "json" || name.startsWith("json_"))
      && functionCallAt(tokens, significant, position, name)) {
      functions.push({ name, position });
    }
  }
  if (functions.length === 0) return null;

  const supportedNames = new Set(["json_extract", "json_object", "json_type"]);
  if (functions.some(({ name }) => !supportedNames.has(name))) {
    return Object.freeze({ supported: false });
  }

  const replacements = new Map();
  const skippedTokenIndexes = new Set();
  const specialBindings = [];
  let usesJsonObject = false;
  let usesJsonExtract = false;
  let usesJsonType = false;

  for (const { name, position } of functions) {
    const nameTokenIndex = significant[position];
    if (name === "json_object") {
      replacements.set(nameTokenIndex, "jsonb_build_object");
      usesJsonObject = true;
      continue;
    }

    const closePosition = matchingParenthesisPosition(tokens, significant, position + 1);
    if (closePosition < 0) {
      throw invalidCompilerInput("Eine JSON-Funktion ist nicht abgeschlossen.");
    }
    const argumentsList = significant.slice(position + 2, closePosition);
    const expectedLength = name === "json_extract" ? 3 : [1, 3];
    if ((Array.isArray(expectedLength) && !expectedLength.includes(argumentsList.length))
      || (!Array.isArray(expectedLength) && argumentsList.length !== expectedLength)
      || tokens[argumentsList[0]]?.type !== "parameter"
      || (argumentsList.length === 3
        && (!tokenIsSymbol(tokens[argumentsList[1]], ",")
          || tokens[argumentsList[2]]?.type !== "string"))) {
      throw invalidCompilerInput("Die JSON-Funktion verwendet keine statische Parameterbindung.");
    }
    const parameter = tokens[argumentsList[0]].text.slice(1);
    if (statement.parameters[parameter]?.kind !== "json") {
      throw invalidCompilerInput("JSON-Funktionen benötigen einen JSON-Vertragsparameter.");
    }
    const path = argumentsList.length === 3
      ? jsonPathSegments(sqlStringValue(tokens[argumentsList[2]]))
      : Object.freeze([]);
    const source = name === "json_extract" ? "json-extract" : "json-type";
    specialBindings.push({
      nameTokenIndex,
      closeTokenIndex: significant[closePosition],
      parameter,
      path,
      source,
    });
    if (name === "json_extract") usesJsonExtract = true;
    else usesJsonType = true;
  }

  for (const binding of specialBindings) {
    for (let index = binding.nameTokenIndex; index <= binding.closeTokenIndex; index += 1) {
      skippedTokenIndexes.add(index);
    }
  }

  const directParameterNames = new Set();
  tokens.forEach((token, index) => {
    if (token.type === "parameter" && !skippedTokenIndexes.has(index)) {
      directParameterNames.add(token.text.slice(1));
    }
  });
  const parameterBindings = [];
  const directParameterPositions = new Map();
  for (const parameter of parameterOrder) {
    if (!directParameterNames.has(parameter)) continue;
    parameterBindings.push(frozenParameterBinding(parameter, "value"));
    directParameterPositions.set(parameter, parameterBindings.length);
  }
  specialBindings.sort((left, right) => left.nameTokenIndex - right.nameTokenIndex);
  const specialBindingPositions = new Map();
  for (const binding of specialBindings) {
    const bindingKey = JSON.stringify([
      binding.parameter,
      binding.source,
      binding.path,
    ]);
    let bindingPosition = specialBindingPositions.get(bindingKey);
    if (!bindingPosition) {
      parameterBindings.push(frozenParameterBinding(
        binding.parameter,
        binding.source,
        binding.path,
      ));
      bindingPosition = parameterBindings.length;
      specialBindingPositions.set(bindingKey, bindingPosition);
    }
    const placeholder = `$${bindingPosition}`;
    replacements.set(
      binding.nameTokenIndex,
      binding.source === "json-type"
        ? `(${placeholder}::text)`
        : binding.path.length === 0
          ? `(${placeholder}::jsonb)`
          : placeholder,
    );
    skippedTokenIndexes.delete(binding.nameTokenIndex);
  }
  const representedParameters = [...new Set(
    parameterBindings.map((binding) => binding.parameter),
  )].sort();
  if (JSON.stringify(representedParameters) !== JSON.stringify([...parameterOrder])) {
    throw invalidCompilerInput("Nicht alle Vertragsparameter besitzen eine PostgreSQL-Bindung.");
  }

  return Object.freeze({
    supported: true,
    directParameterPositions,
    parameterBindings: Object.freeze(parameterBindings),
    replacements,
    skippedTokenIndexes,
    usesJsonExtract,
    usesJsonObject,
    usesJsonType,
  });
}

function castContextPositions(tokens, significant) {
  const positions = new Set();
  const stack = [];
  for (let position = 0; position < significant.length; position += 1) {
    const token = tokens[significant[position]];
    if (tokenIsSymbol(token, "(")) {
      stack.push(lowerToken(tokens[significant[position - 1]]) || "");
      continue;
    }
    if (tokenIsSymbol(token, ")")) {
      stack.pop();
      continue;
    }
    if (stack.includes("cast")) positions.add(position);
  }
  return positions;
}

function aliasReplacements(tokens, significant) {
  const replacements = new Map();
  const castPositions = castContextPositions(tokens, significant);
  for (let position = 0; position + 1 < significant.length; position += 1) {
    if (lowerToken(tokens[significant[position]]) !== "as" || castPositions.has(position)) {
      continue;
    }
    const aliasIndex = significant[position + 1];
    const alias = tokens[aliasIndex];
    if (alias.type !== "word"
      || !/[a-z]/.test(alias.text)
      || !/[A-Z]/.test(alias.text)) {
      continue;
    }
    replacements.set(aliasIndex, `"${alias.text}"`);
  }
  return replacements;
}

function depthBeforeSignificantTokens(tokens, significant) {
  const depths = [];
  let depth = 0;
  for (let position = 0; position < significant.length; position += 1) {
    const token = tokens[significant[position]];
    depths[position] = depth;
    if (tokenIsSymbol(token, "(")) depth += 1;
    if (tokenIsSymbol(token, ")")) depth -= 1;
    if (depth < 0) throw invalidCompilerInput("Das SQL enthält eine unerwartete schließende Klammer.");
  }
  if (depth !== 0) throw invalidCompilerInput("Das SQL enthält nicht ausgeglichene Klammern.");
  return depths;
}

function orderItemInsertion(tokens, significant, start, end) {
  if (start >= end) return { ambiguous: true };
  const positions = significant.slice(start, end);
  const words = positions.map((index) => lowerToken(tokens[index]));
  const nullsPositions = words
    .map((word, index) => ({ word, index }))
    .filter(({ word }) => word === "nulls");
  if (nullsPositions.length > 0) {
    const nullsPosition = nullsPositions[nullsPositions.length - 1].index;
    if (nullsPositions.length !== 1
      || nullsPosition !== words.length - 2
      || !["first", "last"].includes(words[words.length - 1])) {
      return { ambiguous: true };
    }
    return { tokenIndex: null, insertion: "" };
  }
  if (words.includes("using")) return { ambiguous: true };

  const lastTokenIndex = positions[positions.length - 1];
  const lastToken = tokens[lastTokenIndex];
  if (lastToken.type === "symbol"
    && ![")", "]"].includes(lastToken.text)) {
    return { ambiguous: true };
  }
  const descending = lowerToken(lastToken) === "desc";
  return {
    tokenIndex: lastTokenIndex,
    insertion: descending ? " NULLS LAST" : " NULLS FIRST",
  };
}

function orderByInsertions(tokens, significant) {
  const insertions = new Map();
  const depths = depthBeforeSignificantTokens(tokens, significant);
  let foundOrderBy = false;
  let ambiguous = false;

  function finalizeItem(start, end) {
    const result = orderItemInsertion(tokens, significant, start, end);
    if (result.ambiguous) {
      ambiguous = true;
      return;
    }
    if (result.tokenIndex !== null) {
      insertions.set(
        result.tokenIndex,
        `${insertions.get(result.tokenIndex) || ""}${result.insertion}`,
      );
    }
  }

  for (let position = 0; position + 1 < significant.length; position += 1) {
    if (lowerToken(tokens[significant[position]]) !== "order"
      || lowerToken(tokens[significant[position + 1]]) !== "by"
      || depths[position] !== depths[position + 1]) {
      continue;
    }
    foundOrderBy = true;
    const baseDepth = depths[position];
    let itemStart = position + 2;
    let cursor = itemStart;
    for (; cursor < significant.length; cursor += 1) {
      const token = tokens[significant[cursor]];
      const word = lowerToken(token);
      if ((tokenIsSymbol(token, ")") && depths[cursor] === baseDepth)
        || depths[cursor] < baseDepth
        || (depths[cursor] === baseDepth && CLAUSE_TERMINATORS.has(word))
        || (depths[cursor] === baseDepth && tokenIsSymbol(token, ";"))) {
        break;
      }
      if (depths[cursor] === baseDepth && tokenIsSymbol(token, ",")) {
        finalizeItem(itemStart, cursor);
        itemStart = cursor + 1;
      }
    }
    finalizeItem(itemStart, cursor);
    position += 1;
  }

  return {
    insertions,
    foundOrderBy,
    ambiguous,
  };
}

function renderPortableSql(
  tokens,
  parameterPositions,
  replacements,
  insertions,
  skippedTokenIndexes = new Set(),
) {
  let sql = "";
  for (let index = 0; index < tokens.length; index += 1) {
    if (skippedTokenIndexes.has(index)) continue;
    const token = tokens[index];
    if (replacements.has(index)) {
      sql += replacements.get(index);
    } else if (token.type === "parameter") {
      const position = parameterPositions.get(token.text.slice(1));
      if (!position) {
        throw invalidCompilerInput("Ein SQL-Parameter besitzt keine Positionsbindung.");
      }
      sql += `$${position}`;
    } else {
      sql += token.text;
    }
    sql += insertions.get(index) || "";
  }
  return sql;
}

function compilePostgresqlDialectEntry(options = {}) {
  exactKeys(options, ["statement", "sql", "returning"], "PostgreSQL-Dialekteintrag");
  const statement = assertPersistenceStatement(options.statement);
  if (typeof options.sql !== "string" || !options.sql.trim()) {
    throw invalidCompilerInput("Der Dialekteintrag benötigt SQL.");
  }
  if (typeof options.returning !== "boolean") {
    throw invalidCompilerInput("Der Dialekteintrag benötigt eine Returning-Angabe.");
  }
  const hasColumns = Object.keys(statement.columns).length > 0;
  if ((statement.operation !== "execute" && options.returning)
    || (statement.operation === "execute" && options.returning !== hasColumns)) {
    throw invalidCompilerInput("Statementvertrag und Returning-Angabe widersprechen einander.");
  }

  const tokens = tokenizeSql(options.sql);
  const significant = significantTokenIndexes(tokens);
  const parameterOrder = validatedParameterOrder(statement, tokens);
  const blockingFeatures = detectBlockingFeatures(tokens, significant);
  const jsonCompilation = jsonFunctionCompilation(
    tokens,
    significant,
    statement,
    parameterOrder,
  );
  if (jsonCompilation?.supported) {
    blockingFeatures.delete("sqlite.json-functions");
  }
  const sourceSqlFingerprint = fingerprint(options.sql);

  if (blockingFeatures.size > 0) {
    return Object.freeze({
      compilerVersion: POSTGRESQL_DIALECT_COMPILER_VERSION,
      statement,
      strategy: "requires-override",
      sourceSqlFingerprint,
      compiledSql: null,
      compiledSqlFingerprint: null,
      parameterOrder,
      coveredFeatures: Object.freeze([]),
      blockingFeatures: Object.freeze([...blockingFeatures].sort()),
      returning: options.returning,
    });
  }

  const replacements = aliasReplacements(tokens, significant);
  if (jsonCompilation?.supported) {
    for (const [index, replacement] of jsonCompilation.replacements) {
      if (replacements.has(index)) {
        throw invalidCompilerInput("Zwei PostgreSQL-Transformationen überlappen.");
      }
      replacements.set(index, replacement);
    }
  }
  const orderBy = orderByInsertions(tokens, significant);
  if (orderBy.ambiguous) {
    return Object.freeze({
      compilerVersion: POSTGRESQL_DIALECT_COMPILER_VERSION,
      statement,
      strategy: "requires-override",
      sourceSqlFingerprint,
      compiledSql: null,
      compiledSqlFingerprint: null,
      parameterOrder,
      coveredFeatures: Object.freeze([]),
      blockingFeatures: Object.freeze(["postgresql.order-by-ambiguous"]),
      returning: options.returning,
    });
  }

  const coveredFeatures = [];
  if (parameterOrder.length > 0) {
    coveredFeatures.push("postgresql.named-parameter-binding");
  }
  if (replacements.size > 0) {
    coveredFeatures.push("postgresql.camelcase-alias-quoting");
  }
  if (orderBy.foundOrderBy) {
    coveredFeatures.push("postgresql.sqlite-null-ordering");
  }
  if (jsonCompilation?.usesJsonExtract) {
    coveredFeatures.push("postgresql.sqlite-json-parameter-binding");
  }
  if (jsonCompilation?.usesJsonObject) {
    coveredFeatures.push("postgresql.jsonb-object-construction");
  }
  if (jsonCompilation?.usesJsonType) {
    coveredFeatures.push("postgresql.sqlite-json-type-binding");
  }
  coveredFeatures.sort();

  const parameterBindings = jsonCompilation?.supported
    ? jsonCompilation.parameterBindings
    : Object.freeze(parameterOrder.map((parameter) => (
      frozenParameterBinding(parameter, "value")
    )));
  const parameterPositions = jsonCompilation?.supported
    ? jsonCompilation.directParameterPositions
    : new Map(parameterOrder.map((name, index) => [name, index + 1]));
  const compiledSql = renderPortableSql(
    tokens,
    parameterPositions,
    replacements,
    orderBy.insertions,
    jsonCompilation?.supported
      ? jsonCompilation.skippedTokenIndexes
      : undefined,
  );
  return Object.freeze({
    compilerVersion: POSTGRESQL_DIALECT_COMPILER_VERSION,
    statement,
    strategy: "portable-generated",
    sourceSqlFingerprint,
    compiledSql,
    compiledSqlFingerprint: fingerprint(compiledSql),
    parameterOrder,
    parameterBindings,
    coveredFeatures: Object.freeze(coveredFeatures),
    blockingFeatures: Object.freeze([]),
    returning: options.returning,
  });
}

module.exports = {
  POSTGRESQL_DIALECT_COMPILER_VERSION,
  POSTGRESQL_DIALECT_STRATEGIES,
  compilePostgresqlDialectEntry,
};
