'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {historyDefaults}=require('../public/sales-article-tools');
const {validRange}=require('../public/trade-period');

test('Article history defaults use the server day, 90 inclusive days and a real previous-year calendar date',()=>{
 const movement=historyDefaults('movements','2026-10-03');
 assert.equal(movement.dateTo,'2026-10-03');
 assert.equal((Date.parse(movement.dateTo)-Date.parse(movement.dateFrom))/86400000,89);
 assert.deepEqual(historyDefaults('sales','2026-10-03'),{dateFrom:'2025-10-03',dateTo:'2026-10-03'});
 assert.deepEqual(historyDefaults('sales','2024-02-29'),{dateFrom:'2023-02-28',dateTo:'2024-02-29'});
 assert.deepEqual(historyDefaults('sales','2025-02-28'),{dateFrom:'2024-02-28',dateTo:'2025-02-28'});
 for(const kind of ['sales','movements'])assert.ok(validRange(...Object.values(historyDefaults(kind,'2024-02-29')),'2024-02-29'));
 for(const value of ['2026-02-29','not-a-date',null])assert.throws(()=>historyDefaults('sales',value),TypeError);
 assert.equal(validRange('2024-02-29','2024-03-01','2024-02-29'),false,'Calendar and direct entry share the server maximum');
});
