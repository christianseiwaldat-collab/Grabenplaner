'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),UI=require('../public/sales-bwl-simulation');
test('simulation presentation retains exact large decimal values and comparison differences',()=>{
 assert.equal(UI.difference('9007199254740993.01','9007199254740992.99'),'0.02');
 assert.equal(UI.difference('2','10.25'),'-8.25');assert.equal(UI.difference(null,'1'),null);
 assert.equal(UI.format(null,'money'),'—');assert.match(UI.format('9007199254740993.01','money'),/9\.007\.199\.254\.740\.993,01/);
});
