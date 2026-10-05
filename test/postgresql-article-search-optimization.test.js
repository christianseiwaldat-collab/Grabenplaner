'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const W = require('../lib/persistence/statements/sales-article-workspace');
const { SALES_ARTICLE_CATALOG_STATEMENTS: A } = require('../lib/persistence/statements/sales-article-catalog');
const { CATALOG } = require('../lib/persistence/postgresql/reporting/sales-article-workspace-catalog');
const { compileSalesEntry } = require('../lib/persistence/postgresql/sales/catalog');
const { searchBase } = require('../lib/persistence/sqlite/sales-article-workspace-catalog');
const { relation } = require('../lib/persistence/postgresql/sales/layout');
const { normalizeSalesArticleSearch, salesArticleImportContentSha256 } = require('../lib/sales-article-catalog');
const { parameters } = require('../lib/flexible-search');
const { PRICE_SEARCH_FIELDS } = require('../lib/sales-article-table');

// Reference the existing portable predicate, including each term's independent
// alias EXISTS. This is deliberately independent of the optimized PG catalog.
function reference(statement, base) {
  const entry = compileSalesEntry({ statement: base, sql: searchBase(base), returning: false }, 8).providerEntry;
  const parameter = '$' + (entry.parameterBindings.length + 1);
  const membership = '(' + parameter + '::jsonb IS NULL OR article.product_id IN (SELECT a.product_id FROM '
    + relation('sales_articles') + " a WHERE a.source_system='tradefoto.artikel_stamm' AND a.source_article_key IN (SELECT value FROM jsonb_array_elements_text("
    + parameter + '::jsonb))))';
  return { ...entry, statement, sql: entry.sql.replace(/\bWHERE\b/i, 'WHERE ' + membership + ' AND'),
    parameterBindings: [...entry.parameterBindings, { parameter: 'orderKeys', source: 'value', path: [] }] };
}

const before = { search: reference(W.search, A.search), count: reference(W.count, A.countSearch) };
function bind(entry, values) {
  return entry.parameterBindings.map(binding => {
    assert.equal(binding.source, 'value');
    const value = values[binding.parameter] ?? null;
    return value !== null && entry.statement.parameters[binding.parameter].kind === 'json' ? JSON.stringify(value) : value;
  });
}
function searchParameters(input = {}, orderKeys = null) {
  const search = normalizeSalesArticleSearch(input);
  const filter = { ...parameters(search.query), identifierLike: search.identifierLike, active: search.active,
    sourceSystem: search.sourceSystem, orderKeys };
  return { filter, page: { ...filter, sort: search.sort, direction: search.direction, limit: search.limit, offset: search.offset } };
}
// The raw pg client leaves bigint revisions as strings; the provider validates
// and returns safe integers for this result column.
const columns = rows => rows.map(row => ({ ...row, active: Boolean(row.active), currentRevision: Number(row.currentRevision) }));
const numbers = rows => rows.map(row => row.articleNumber);

test('PostgreSQL workspace search preserves parameter and result contracts', () => {
  for (const [statement, original] of [[W.search, before.search], [W.count, before.count],
    [W.searchWithoutText, before.search], [W.countWithoutText, before.count]]) {
    const entry = CATALOG.find(candidate => candidate.statement === statement);
    assert.ok(entry);
    assert.deepEqual(new Set(entry.parameterBindings.map(binding => binding.parameter)),
      new Set(original.parameterBindings.map(binding => binding.parameter)));
    assert.deepEqual(entry.statement.columns, original.statement.columns);
    assert.equal(entry.returning, false);
    for (const binding of entry.parameterBindings) {
      assert.equal(binding.source, 'value');
      assert.ok(Object.hasOwn(statement.parameters, binding.parameter));
    }
    const input = searchParameters({ query: "Sony '); SELECT 1; --", status: 'all' });
    assert.doesNotThrow(() => bind(entry, statement.operation === 'queryAll' ? input.page : input.filter));
  }
});

function gtin12(base) {
  const digits = String(base).padStart(12, '0');
  const sum = [...digits].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0);
  return digits + String((10 - sum % 10) % 10);
}
function identifiers(values) {
  return values.map((value, index) => ({ identifierType: 'ean13', identifierValue: gtin12(value),
    isPrimary: index === 0, sourceField: 'EAN' + index, sourceRank: index + 1 }));
}
function article(number, overrides = {}) {
  return { sourceArticleKey: 'key-' + number, articleNumber: number, description: 'Kamera gleicher Name',
    active: true, sourceUpdatedAt: null, identifiers: [], prices: [], ...overrides };
}
function snapshot(sourceSystem, articles, version) {
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  return { snapshot: { sourceSystem, sourceProfileVersion: 'search-regression-v1',
    sourceSchemaSha256: hash('synthetic-article-search-schema'), sourceFileSha256: hash('synthetic-search-' + version),
    contentSha256: salesArticleImportContentSha256(articles), snapshotAt: `2026-10-05T00:0${version}:00.000Z`, articles },
    actor: '00001', timestamp: '2026-10-05T01:00:00.000Z' };
}

test('Workspace selects the cheap empty-text path after normalization, retaining filters and access checks', async t => {
  const f = await require('../test-support/trade-insights-sqlite').fixture(t);
  const { article: seeded } = await require('../test-support/sales-article-workspace-fixture').seedWorkspace({ access: f.app.provider, source: f });
  const { access, counts } = require('../test-support/measured-persistence').measuredPersistence(f.app.provider);
  const search = require('../lib/persistence/repositories/sales-article-workspace').searchSalesArticleWorkspace;
  const all = { read: true, pricesRead: true, costsRead: true };
  const run = (input = {}, extra = {}) => search({ access, vault: f.vault,
    search: normalizeSalesArticleSearch(input), projection: all, ...extra });
  const emptyQueries = ['', '  ', '*', '***', '?', '*?*', '- / . , ; ( )', '&#x20;'];
  for (const query of emptyQueries) {
    counts.clear();
    const actual = await run({ query });
    const { filter, page } = searchParameters({ query });
    assert.deepEqual(actual.items, await f.app.provider.queryAll(W.search, page), query);
    assert.equal(actual.total, (await f.app.provider.queryOne(W.count, filter)).total, query);
    assert.equal(counts.get(W.searchWithoutText.id), 1, query);
    assert.equal(counts.get(W.countWithoutText.id), 1, query);
    assert.equal(counts.has(W.search.id), false, query);
    assert.equal(counts.has(W.count.id), false, query);
  }
  for (const query of ['hama', '4006381333931', '%', '_', '!']) {
    counts.clear();
    await run({ query });
    assert.equal(counts.get(W.search.id), 1, query);
    assert.equal(counts.get(W.count.id), 1, query);
    assert.equal(counts.has(W.searchWithoutText.id), false, query);
  }
  for (const input of [{ identifier: '333931' }, { identifier: '04006381333931' },
    { sourceSystem: 'tradefoto.artikel_stamm' }, { status: 'inactive' }, { status: 'all', sort: 'description', direction: 'desc', limit: 1, offset: 1 }]) {
    counts.clear();
    const actual = await run({ query: '*', ...input });
    const { filter, page } = searchParameters({ query: '*', ...input });
    assert.deepEqual(actual.items, await f.app.provider.queryAll(W.search, page));
    assert.equal(actual.total, (await f.app.provider.queryOne(W.count, filter)).total);
    assert.equal(counts.get(W.searchWithoutText.id), 1);
  }
  for (const [orderNumber, expected] of [['H-5120', ['005479', '005480']], ['L-98765', ['005479']], ['missing', []]]) {
    counts.clear();
    const actual = await run({ query: '?' }, { orderNumber });
    assert.deepEqual(numbers(actual.items), expected);
    assert.equal(actual.total, expected.length);
    assert.equal(counts.get(W.searchWithoutText.id), 1);
    assert.equal(counts.get(W.countWithoutText.id), 1);
  }
  counts.clear();
  const pricesOnly = await run({ query: '*' }, { projection: { read: true, pricesRead: true } });
  assert.ok(pricesOnly.items.every(row => Object.hasOwn(row, 'retailGross') && !Object.hasOwn(row, 'purchaseNet') && !Object.hasOwn(row, 'purchaseGross')));
  for (const [input, projection] of [[{}, { read: false }], [{ sort: 'purchaseNet' }, { read: true, pricesRead: true }]]) {
    counts.clear();
    await assert.rejects(run(input, { projection }), { code: 'IMPORT_ARTICLE_ACCESS_DENIED' });
    assert.equal(counts.size, 0, 'Denied searches must not access the data');
  }
  f.app.database.prepare('INSERT INTO sales_article_search_dirty(product_id) VALUES(?)').run(seeded.productId);
  try {
    counts.clear();
    await assert.rejects(run({ query: '?' }), { code: 'IMPORT_ARTICLE_SEARCH_NOT_CURRENT' });
    assert.equal(counts.get(A.searchProjectionDirty.id), 1);
    assert.equal(counts.has(W.searchWithoutText.id), false);
    assert.equal(counts.has(W.countWithoutText.id), false);
  } finally {
    f.app.database.prepare('DELETE FROM sales_article_search_dirty WHERE product_id=?').run(seeded.productId);
    await access.close();
  }
});

test('Native PostgreSQL article search keeps aliases, filters, counts and every sort equivalent',
  { skip: !process.env.GP_SALES_MIGRATOR_URL || !process.env.GP_SALES_APP_URL }, async t => {
    await require('../test-support/postgresql-migration/sales-fixture').withSalesFixture(8, async f => {
      const repository = require('../lib/persistence/repositories/sales-article-catalog').createSalesArticleCatalogRepository(f.postgres);
      const currentAliases = [800333333333, 400111111111, 711222222222];
      const oldAlias = gtin12(999888777666);
      await repository.importSnapshot(snapshot('tradefoto.artikel_stamm', [
        article('ART-001', { description: 'Alte Beschreibung', identifiers: identifiers([999888777666]) }),
      ], 1));
      const articles = Array.from({ length: 24 }, (_, index) => article('ART-' + String(index + 1).padStart(3, '0'), {
        active: index % 5 !== 4,
        identifiers: index < 21 ? identifiers([610000000000 + index]) : [],
        prices: index < 21 ? PRICE_SEARCH_FIELDS.map((field, fieldIndex) => ({ priceType: field.type, priceBasis: field.basis,
          amount: ['9.9', '100', '2.000000000002', '2.000000000001', '0'][(index + fieldIndex) % 5],
          currency: 'EUR', qualityStatus: 'confirmed', sourceField: field.id })) : [],
      }));
      articles[0] = article('ART-001', { description: 'Sony A7 Kit ÉTUI CAFÉ 24-105mm', identifiers: identifiers(currentAliases), prices: articles[0].prices });
      articles[1].description = 'Ärmel und Ösen für Übergrößen';
      articles[2].description = 'Sonderzeichen Prozent % Unterstrich _ Rufzeichen !';
      await repository.importSnapshot(snapshot('tradefoto.artikel_stamm', articles, 2));
      await repository.importSnapshot(snapshot('manual.loan', [article('MAN-001', { sourceArticleKey: 'key-ART-001', description: 'Sony Kamera manuell' })], 3));
      assert.equal((await f.client.query('SELECT count(*)::int AS n FROM trade.sales_article_search_dirty')).rows[0].n, 0);

      async function verify(input = {}, orderKeys = null) {
        const { filter, page } = searchParameters(input, orderKeys);
        const expectedRows = columns((await f.client.query(before.search.sql, bind(before.search, page))).rows);
        const expectedTotal = Number((await f.client.query(before.count.sql, bind(before.count, filter))).rows[0].total);
        const withoutText = filter.query0 === '%';
        const actual = await f.postgres.queryAll(withoutText ? W.searchWithoutText : W.search, page);
        const count = await f.postgres.queryOne(withoutText ? W.countWithoutText : W.count, filter);
        const label = JSON.stringify({ ...input, orderKeys });
        assert.deepEqual(actual, expectedRows, label);
        assert.equal(count.total, expectedTotal, label);
        assert.equal(new Set(actual.map(row => row.productId)).size, actual.length, label + ': duplicate articles');
        return { items: actual, total: count.total };
      }

      await t.test('terms may match description and two different non-primary aliases', async () => {
        for (const query of ['sony 111111 222222', '111111 222222', '222222 sony 111111', 'sony sony 222222', 'son? 222*222']) {
          const found = await verify({ query, status: 'all' });
          assert.deepEqual(numbers(found.items), ['ART-001'], query);
          assert.equal(found.total, 1);
        }
        assert.equal((await verify({ query: 'sony 111111 unauffindbar', status: 'all' })).total, 0);
        assert.equal((await verify({ query: '111111 610000', status: 'all' })).total, 0,
          'Terms on different products must not be combined');
      });

      await t.test('old snapshot aliases never match query or dedicated identifier filters', async () => {
        assert.equal((await f.client.query('SELECT count(*)::int AS n FROM trade.sales_article_identifiers WHERE identifier_value=$1', [oldAlias])).rows[0].n, 1);
        assert.equal((await verify({ query: oldAlias, status: 'all' })).total, 0);
        assert.equal((await verify({ identifier: oldAlias, status: 'all' })).total, 0);
        for (const identifier of [gtin12(currentAliases[2]), '0' + gtin12(currentAliases[2]), '222222']) {
          assert.deepEqual(numbers((await verify({ identifier, status: 'all' })).items), ['ART-001']);
        }
      });

      await t.test('case, accents, punctuation, literal LIKE characters and application wildcards', async () => {
        const cases = [
          ['SONY', ['ART-001', 'MAN-001']], ['ÉTUI CAFÉ', ['ART-001']], ['105mm Sony A7 24', ['ART-001']],
          ['Sony A7*&#x32;4 -105mm', ['ART-001']], ['ärmel Ösen', ['ART-002']], ['&#xC4;rmel', ['ART-002']],
          ['ÜBERGRÖSSEN', ['ART-002']], ['%', ['ART-003']], ['_', ['ART-003']], ['!', ['ART-003']],
          ['unauffindbar', []], ["' OR 1=1 --", []],
        ];
        for (const [query, expected] of cases) assert.deepEqual(numbers((await verify({ query, status: 'all' })).items), expected, query);
        for (const query of ['', '  ', '***', '?', 'a', 'ar']) {
          await verify({ query, status: 'all', limit: 7, offset: 2 });
        }
        assert.equal((await verify({ query: '', status: 'all', limit: 7 })).total, 25);
        assert.deepEqual(numbers((await verify({ query: 'sony a7 kit etui cafe 24 105mm 111111 222222 333333', status: 'all' })).items), ['ART-001']);
      });

      await t.test('status, source and order membership remain conjunctive, including empty keys', async () => {
        for (const status of ['active', 'inactive', 'all']) {
          for (const sourceSystem of [null, 'tradefoto.artikel_stamm', 'manual.loan']) {
            await verify({ status, ...(sourceSystem ? { sourceSystem } : {}), limit: 100 });
          }
        }
        for (const orderKeys of [[], ['key-ART-001'], ['key-ART-001', 'key-ART-001'], ['key-ART-001', 'key-ART-005'], ['missing'], ["' OR 1=1 --"]]) {
          await verify({ status: 'all', limit: 100 }, orderKeys);
        }
        assert.equal((await verify({ status: 'all' }, [])).total, 0);
        assert.deepEqual(numbers((await verify({ query: 'sony', status: 'all' }, ['key-ART-001'])).items), ['ART-001']);
        assert.equal((await verify({ sourceSystem: 'manual.loan', status: 'all' }, ['key-ART-001'])).total, 0);
        assert.equal((await verify({ query: 'sony', identifier: oldAlias, status: 'all' }, ['key-ART-001'])).total, 0);
        assert.deepEqual(numbers((await verify({ query: 'sony 222222', identifier: gtin12(currentAliases[1]),
          sourceSystem: 'tradefoto.artikel_stamm', status: 'active' }, ['key-ART-001'])).items), ['ART-001']);
      });

      await t.test('every sort and direction is stable across pages, with exact counts and nulls last', async () => {
        for (const query of ['', 'kamera']) for (const sort of ['articleNumber', 'description', 'primaryIdentifier', 'status', 'sourceSystem', ...PRICE_SEARCH_FIELDS.map(field => field.id)]) {
          for (const direction of ['asc', 'desc']) {
            const input = { query, status: 'all', sort, direction };
            const whole = await verify({ ...input, limit: 100 });
            const paged = [];
            for (let offset = 0; offset < whole.total; offset += 7) {
              const page = await verify({ ...input, limit: 7, offset });
              assert.equal(page.total, whole.total);
              paged.push(...page.items);
            }
            assert.deepEqual(paged, whole.items, sort + '/' + direction);
            assert.equal(new Set(paged.map(row => row.productId)).size, whole.total);
            assert.equal((await verify({ ...input, limit: 7, offset: 1000 })).items.length, 0);
            if (sort === 'primaryIdentifier' || PRICE_SEARCH_FIELDS.some(field => field.id === sort)) {
              const firstNull = paged.findIndex(row => row[sort] === null);
              assert.ok(firstNull >= 0);
              assert.ok(paged.slice(firstNull).every(row => row[sort] === null));
            }
          }
        }
      });
    });
  });
