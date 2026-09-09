'use strict';
const { definePersistenceStatement } = require('../contract');
const nullable = kind => ({ kind, nullable: true });
const META = { articleNumber: 'text', revision: 'text', mime: nullable('text'), width: 'safe_integer', height: 'safe_integer', byteSize: 'safe_integer', updatedAt: 'utc_timestamp' };
const parameters = { ...META, content: nullable('bytes'), sha256: nullable('text'), actor: 'text' };
const define = (id, operation, parameters, columns) => definePersistenceStatement({ id: 'sales-article-images.' + id, operation, parameters, ...(columns ? { columns } : {}) });
const S = Object.freeze({
  metadata: define('metadata', 'queryOne', { articleNumber: 'text' }, META),
  content: define('content', 'queryOne', { articleNumber: 'text' }, { ...META, content: nullable('bytes'), sha256: nullable('text') }),
  insert: define('insert', 'execute', parameters),
  replace: define('replace', 'execute', { ...parameters, expectedRevision: 'text' }),
});
module.exports = { SALES_ARTICLE_IMAGE_STATEMENTS: S };
