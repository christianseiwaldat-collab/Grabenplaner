'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createTradeInsightJobs}=require('../lib/persistence/repositories/trade-insight-jobs');
const M=require('../public/trade-insight-results');
function queue(f,extra={}){return createTradeInsightJobs({access:f.app.provider,vault:f.vault,runtime:f.runtime,resolvePrincipal:async()=>({...f.state.session,id:undefined}),pageSize:50,...extra});}
async function complete(jobs,session){for(let n=0;n<10;n++){await jobs.tick();if(!(await jobs.list(session)).some(r=>['queued','running'].includes(r.status)))return;}throw Error('Queue did not finish');}

test('all result columns sort by raw values, dates and natural identifiers; nulls stay last',()=>{
 const rows=[{articleNumber:'a10',ordered:'100.5',date:'2026-01-01'},{articleNumber:'A2',ordered:'9.9',date:'2025-12-31'},{articleNumber:'a1',ordered:null,date:null}];
 const cols=M.columns('purchasing');
 assert.deepEqual(M.sortRows(rows,cols,'articleNumber').map(r=>r.articleNumber),['a1','A2','a10']);
 assert.deepEqual(M.sortRows(rows,cols,'ordered','asc').map(r=>r.ordered),['9.9','100.5',null]);
 assert.deepEqual(M.sortRows(rows,cols,'ordered','desc').map(r=>r.ordered),['100.5','9.9',null]);
 assert.deepEqual(M.sortRows(rows,cols,'date').map(r=>r.date),['2025-12-31','2026-01-01',null]);
 const large=[{ordered:'9007199254740993.01'},{ordered:'9007199254740992.99'}];assert.equal(M.sortRows(large,cols,'ordered')[0],large[1]);
 assert.equal(rows[0].articleNumber,'a10');
});
