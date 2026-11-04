'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {planningHistoryCoverage,weekIdentity}=require('../lib/schedule-history-coverage');
test('Missing weeks use the twelve fully past ISO weeks and preserve ISO years',()=>{
 const result=planningHistoryCoverage({weekStart:'2027-01-04'});
 assert.equal(result.weeks.length,12);assert.equal(result.weeks.at(-1).weekStart,'2026-12-28');assert.equal(result.weeks.at(-1).week,53);assert.equal(result.weeks.at(-1).year,2026);
 assert.deepEqual(weekIdentity('2027-01-01'),{week:53,year:2026});assert.equal(result.weeks.at(0).weekStart,'2026-10-12');
});
test('A week without Saturday duty or with recorded vacation is present without xoffi imports',()=>{
 const result=planningHistoryCoverage({weekStart:'2026-10-12',shifts:[{shift_date:'2026-10-06'}],options:[{date_from:'2026-09-28',date_to:'2026-10-04'}]});
 assert.equal(result.missing.length,10);assert.ok(!result.missing.some(w=>['2026-10-05','2026-09-28'].includes(w.weekStart)));
});
test('Whole blocked planning week is covered, one blocked day does not invent a whole plan',()=>{
 const blocks=Array.from({length:6},(_,i)=>({block_date:'2026-10-'+String(5+i).padStart(2,'0')}));
 const all=planningHistoryCoverage({weekStart:'2026-10-12',dayBlocks:blocks});assert.equal(all.missing.length,11);
 const single=planningHistoryCoverage({weekStart:'2026-10-12',dayBlocks:blocks.slice(0,1)});assert.equal(single.missing.length,12);
 assert.throws(()=>planningHistoryCoverage({weekStart:'2026-02-30'}));
});
