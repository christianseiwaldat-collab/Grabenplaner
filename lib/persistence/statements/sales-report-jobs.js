'use strict';
const { definePersistenceStatement: define } = require('../contract');
const row = { id: 'text', owner: 'text', scope: 'text', status: 'text', revision: 'safe_integer', created: 'utc_timestamp', updated: 'utc_timestamp', lease: 'safe_integer', worker: 'text', payload: 'text' };
const def = (id, operation, parameters, columns = {}) => define({ id: 'sales-report-jobs.' + id, operation, parameters, columns });
const S = Object.freeze({
  list: def('list', 'queryAll', { owner: 'text', scope: 'text' }, row),
  get: def('get', 'queryOne', { id: 'text', scope: 'text' }, row),
  next: def('next', 'queryOne', { scope: 'text', now: 'safe_integer', worker: 'text' }, row),
  insert: def('insert', 'execute', row),
  update: def('update', 'execute', row),
  remove: def('remove', 'execute', { id: 'text', scope: 'text', owner: 'text', revision: 'safe_integer' }),
});
module.exports = { SALES_REPORT_JOB_STATEMENTS: S, SALES_REPORT_JOB_COLUMNS: row };
