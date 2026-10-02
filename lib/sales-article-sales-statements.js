'use strict';
const { definePersistenceStatement } = require('./persistence/contract');
const searchArticle = definePersistenceStatement({ id: 'sales-article-sales.search', operation: 'queryAll',
  parameters: { publicationId: 'text', datasetSlot: 'safe_integer', articleKey: 'bytes', locationId: { kind: 'text', nullable: true },
    unassigned: 'boolean', includeZero: 'boolean', dateFrom: 'date', dateTo: 'date', afterDate: 'date', afterRow: 'safe_integer', limit: 'safe_integer' },
  columns: { sourceRow: 'safe_integer', businessDate: 'date',parentRow:'safe_integer',locationKey:{kind:'bytes',nullable:true} } });
const articleSourceLinks = definePersistenceStatement({ id: 'sales-article-sales.source-links',operation: 'queryAll',
  parameters: { productId: 'text',sourceSystem: 'text',limit: 'safe_integer' },columns: { sourceArticleKey: 'text' } });
module.exports = { searchArticle,articleSourceLinks };
