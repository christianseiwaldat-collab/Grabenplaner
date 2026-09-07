"use strict";
const { definePersistenceStatement } = require('../contract');
const COLUMNS = Object.freeze({ id: 'text', kind: 'text', employeeNumber: 'text', effectiveDate: 'date', payload: 'json', createdBy: 'text', createdAt: 'utc_timestamp' });
const def = (id, operation, parameters, columns = {}) => definePersistenceStatement({ id: `saturday-credit.${id}`, operation, parameters, columns });
const SATURDAY_CREDIT_STATEMENTS = Object.freeze({
  get: def('get', 'queryOne', { id: 'text' }, COLUMNS),
  insert: def('insert', 'execute', COLUMNS),
  history: def('assignment-history', 'queryAll', { employeeNumber: 'text' }, COLUMNS),
  assignment: def('assignment-on-date', 'queryOne', { employeeNumber: 'text', effectiveDate: 'date' }, COLUMNS),
  importedDay: def('imported-day', 'queryAll', { employeeNumber: 'text', workDate: 'date' }, {
    importId: 'text', locationId: 'text', departmentId: 'safe_integer', actualMinutes: 'safe_integer', intervals: 'json' }),
});
module.exports = { SATURDAY_CREDIT_STATEMENTS, SATURDAY_CREDIT_COLUMNS: COLUMNS };
