'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const express = require('express');
const { seedWorkspace } = require('../test-support/sales-article-workspace-fixture');
const { createSalesArticleCatalogRepository } = require('../lib/persistence/repositories/sales-article-catalog');
const { salesArticleImportContentSha256 } = require('../lib/sales-article-catalog');
const { createSalesArticleLocalNotesRepository } = require('../lib/persistence/repositories/sales-article-local-notes');
const { registerSalesArticleLocalNotesRoutes } = require('../lib/sales-article-local-notes-routes');
const N = require('../lib/sales-article-local-notes');
const makeRepository = f => createSalesArticleLocalNotesRepository({ access: f.app.provider, vault: f.vault });
const add = (repo, extra = {}) => repo.add({ articleNumber: '005479', text: 'Eigene dauerhafte Notiz',
  actor: '42', mutationId: crypto.randomUUID(), expectedRevision: 0, ...extra });

test('Own notes use the existing native PostgreSQL encrypted business annotation catalog', () => {
  const { A } = require('../lib/persistence/statements/trade-annotations');
  const catalog = require('../lib/persistence/postgresql/core/trade-annotations').CATALOG;
  for (const statement of [A.get, A.insert, A.update]) {
    const entry = catalog.find(item => item.statement === statement);
    assert.ok(entry); assert.match(entry.sql, /gp\.trade_annotations/);
    assert.ok(entry.parameterOrder.includes('scopeId'));
  }
});
