function inspectTradeFotoArticleImportPayloadBeforeBatching(decoded) {
  const { sourceFileSha256, safeFileName, payload } = decoded;
  let workUnits = payload.articles.length * TRADEFOTO_ARTICLE_IMPORT_WORK_UNITS_PER_ROW;
  for (let index = 0; index < payload.articles.length; index += 1) {
    const sourceEntry = payload.articles[index];
    assertSourceRowSchema(sourceEntry, index + 1);
    workUnits += sourceEntry.aliasRows.length;
    if (workUnits > TRADEFOTO_ARTICLE_IMPORT_MAX_WORK_UNITS) {
      throw importError(
        "Der Import überschreitet das sichere Arbeitsbudget von 750.000 Prüfeinheiten.",
        "SALES_ARTICLE_IMPORT_WORK_BUDGET_EXCEEDED",
        413,
      );
    }
  }
  const adaptedArticles = [];
  const identityRows = [];
  const aliasIdentityRows = [];
  const rows = [];
  const findings = [];
  let identifierCount = 0;
  let priceCount = 0;

  for (let index = 0; index < payload.articles.length; index += 1) {
    const rowNumber = index + 1;
    const sourceEntry = payload.articles[index];
    const rawSourceKey = sourceEntry.articleRow.EAN;
    if (typeof rawSourceKey === "string" && /^\d{13}$/u.test(rawSourceKey)) {
      const numericSourceKey = BigInt(rawSourceKey);
      if (numericSourceKey >= 1n && numericSourceKey <= 999999n) {
        identityRows.push(Object.freeze({
          rowNumber,
          sourceArticleKey: rawSourceKey,
          articleNumber: numericSourceKey.toString().padStart(6, "0"),
        }));
      }
    }
    for (const alias of sourceEntry.aliasRows) {
      if (alias.EAN !== rawSourceKey
        || alias.ZweitEAN === rawSourceKey
        || typeof alias.ZweitEAN !== "string"
        || !Number.isSafeInteger(alias.Rang)
        || alias.Rang < 0
        || alias.Rang > 255) continue;
      try {
        const identifier = normalizeSalesArticleIdentifier({
          identifierValue: alias.ZweitEAN,
          isPrimary: false,
          sourceField: "ZweitEAN.ZweitEAN",
          sourceRank: alias.Rang,
        });
        aliasIdentityRows.push(Object.freeze({
          rowNumber,
          canonicalGtin14: identifier.canonicalGtin14,
        }));
      } catch {}
    }
    let adapted;
    try {
      adapted = adaptTradeFotoArticleSourceRow({
        articleRow: sourceEntry.articleRow,
        aliasRows: sourceEntry.aliasRows,
        currency: payload.currency,
      });
    } catch (error) {
      const code = sourceProfileIssueCode(error);
      const sourceKey = typeof sourceEntry.articleRow?.EAN === "string"
        && /^\d{13}$/u.test(sourceEntry.articleRow.EAN)
        ? sourceEntry.articleRow.EAN : "";
      const articleNumber = sourceKey ? BigInt(sourceKey).toString().padStart(6, "0") : null;
      appendFinding(findings, finding(rowNumber, articleNumber, code));
      rows.push(Object.freeze({
        rowNumber,
        articleNumber,
        description: typeof sourceEntry.articleRow?.Artikelbezeichnung === "string"
          ? sourceEntry.articleRow.Artikelbezeichnung.trim().slice(0, 300) : "",
        action: "blocked",
        issueCodes: Object.freeze([code]),
        identifierCount: 0,
        priceCount: 0,
      }));
      payload.articles[index] = null;
      continue;
    }

    const article = activeArticle(adapted.importRow);
    const rowIssues = [
      ...adapted.quarantine.identifiers.map(() => ({ code: "invalid_identifier", pair: null })),
      ...adapted.quarantine.prices.map(() => ({ code: "negative_price", pair: null })),
      ...grossNetGateIssues(sourceEntry.articleRow),
    ];
    if (adapted.ignoredAliases.length) {
      appendFinding(findings, finding(
        rowNumber,
        article.articleNumber,
        "ignored_alias",
        [...new Set(adapted.ignoredAliases.map(({ code }) => String(code || "ignored")))]
          .sort().join(","),
      ));
    }
    const issueCodes = [...new Set(rowIssues.map(({ code }) => code))];
    for (const code of issueCodes) {
      appendFinding(findings, finding(
        rowNumber,
        article.articleNumber,
        code,
        [...new Set(rowIssues.filter((issue) => issue.code === code)
          .map((issue) => issue.pair || ""))].sort().join(","),
      ));
    }
    identifierCount += article.identifiers.length;
    priceCount += article.prices.length;
    rows.push(Object.freeze({
      rowNumber,
      articleNumber: article.articleNumber,
      description: article.description,
      action: issueCodes.length ? "blocked" : "ready",
      issueCodes: Object.freeze(issueCodes),
      identifierCount: article.identifiers.length,
      priceCount: article.prices.length,
    }));
    adaptedArticles.push(Object.freeze({
      rowNumber,
      article,
      hasRowIssues: issueCodes.length > 0,
    }));
    payload.articles[index] = null;
  }

  const duplicateCodesByRow = new Map();
  const addDuplicateCode = (rowNumber, code) => {
    if (!duplicateCodesByRow.has(rowNumber)) duplicateCodesByRow.set(rowNumber, new Set());
    duplicateCodesByRow.get(rowNumber).add(code);
  };
  const quarantineDuplicateOwners = (groups, code) => {
    for (const rowNumbers of groups.values()) {
      const distinctRows = [...new Set(rowNumbers)];
      if (distinctRows.length < 2) continue;
      for (const rowNumber of distinctRows) addDuplicateCode(rowNumber, code);
    }
  };
  const sourceOwners = new Map();
  const numberOwners = new Map();
  const identifierOwners = new Map();
  const registerOwner = (groups, value, rowNumber) => {
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(rowNumber);
  };
  for (const identity of identityRows) {
    registerOwner(sourceOwners, identity.sourceArticleKey, identity.rowNumber);
    registerOwner(numberOwners, identity.articleNumber, identity.rowNumber);
  }
  for (const identity of aliasIdentityRows) {
    registerOwner(identifierOwners, identity.canonicalGtin14, identity.rowNumber);
  }
  quarantineDuplicateOwners(sourceOwners, "duplicate_source_key");
  quarantineDuplicateOwners(numberOwners, "duplicate_article_number");
  quarantineDuplicateOwners(identifierOwners, "duplicate_gtin");

  for (const [rowNumber, codes] of duplicateCodesByRow) {
    const candidate = rows[rowNumber - 1];
    for (const code of [...codes].sort()) {
      appendFinding(findings, finding(rowNumber, candidate?.articleNumber, code));
    }
  }

  const finalRows = rows.map((row) => {
    const duplicateCodes = duplicateCodesByRow.get(row.rowNumber);
    if (!duplicateCodes?.size) return row;
    const issueCodes = [...new Set([...row.issueCodes, ...duplicateCodes])].sort();
    return Object.freeze({
      ...row,
      action: "blocked",
      issueCodes: Object.freeze(issueCodes),
    });
  });
  const normalizedArticles = adaptedArticles
    .filter(({ rowNumber, hasRowIssues }) => (
      !hasRowIssues && !duplicateCodesByRow.has(rowNumber)
    ))
    .map(({ article }) => article);
  identifierCount = normalizedArticles.reduce(
    (sum, article) => sum + article.identifiers.length,
    0,
  );
  priceCount = normalizedArticles.reduce((sum, article) => sum + article.prices.length, 0);

  return Object.freeze({
    source: Object.freeze({
      fileName: safeFileName,
      fileSha256: sourceFileSha256,
      snapshotAt: payload.snapshotAt,
      articleCount: finalRows.length,
    }),
    sourceSystem: payload.sourceSystem,
    sourceProfileVersion: payload.sourceProfileVersion,
    sourceSchemaSha256: payload.sourceSchemaSha256,
    currency: payload.currency,
    normalizedArticles: Object.freeze(normalizedArticles),
    rows: Object.freeze(finalRows),
    findings: Object.freeze(findings),
    counts: Object.freeze({ identifierCount, priceCount }),
  });
}
