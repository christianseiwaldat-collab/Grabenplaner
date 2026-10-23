'use strict';
// Explicit opt-in synthetic observation probe. Executes the unchanged global middleware
// from server.js with explicit stubs; it does not start or initialize the GP app.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerSalesReportJobRoutes } = require('../../lib/sales-report-jobs-routes');
const source = fs.readFileSync(path.resolve(__dirname, '../../server.js'), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('app.use((request, response, next) => {\n  const embeddedPdfPreview');
const end = source.indexOf('\napp.use(express.json({ limit: "1mb" }));', start);
assert.ok(start >= 0 && end > start, 'exact middleware boundaries');
function middleware() {
  let handler;
  vm.runInNewContext(source.slice(start, end), {app:{use(value){handler=value;}}, serverModeActive:true,
    voiceAssistantConfig:()=>({enabled:false}), productionBootstrapActive:false, isLoopbackRequest:()=>false,
    publicUrl:'https://gp-audit.invalid', requestOriginAllowed:(_request,origin)=>origin==='https://gp-audit.invalid'});
  return handler;
}
async function fixture(t) {
  const app=express(); app.set('trust proxy','loopback'); app.use(middleware());
  app.get('/probe',(_request,response)=>response.type('html').send('<!doctype html><title>Synthetic audit</title>'));
  app.get('/api/schedule-preview.pdf',(_request,response)=>response.type('pdf').send('%PDF-1.7 synthetic'));
  const session={accountId:'audit-account',employeeNumber:'audit-employee',permissions:['sales:workspace:access','sales:analytics:company:read','sales:history:read']};
  // Use the projection's own exact permission names, with a synthetic personal account.
  const {SALES_ANALYTICS_PERMISSIONS:P}=require('../../lib/sales-analytics-access');
  session.permissions=[P.ACCESS,P.COMPANY_READ,'sales:history:read'];
  registerSalesReportJobRoutes(app,{jobs:{download:async(_session,id)=>id==='pdf'?Buffer.from('%PDF-1.7 synthetic'):'<html><body>Synthetic report</body></html>'},
    requireSession:()=>session,refreshSession:async()=>session,assertCsrf:()=>{throw new Error('unexpected mutation');}});
  require('../../lib/sales-article-image-routes').registerSalesArticleImageRoutes(app,{
    catalog:{getByArticleNumber:async()=>({productId:'synthetic-product'})},images:{content:async()=>({buffer:Buffer.from('synthetic WebP bytes')})},
    sessionFor:()=>session,assertFresh:async()=>{},assertCsrf:()=>{throw Error('unexpected mutation');},privateHeaders:()=>{},
  });
  const server=app.listen(0,'127.0.0.1');
  await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return route=>fetch('http://127.0.0.1:'+server.address().port+route,{headers:{'X-Forwarded-Proto':'https'}});
}
test('ops: normal HTTPS response supplies HSTS nosniff referrer COOP and frame restrictions',async t=>{
  const get=await fixture(t), response=await get('/probe'); assert.equal(response.status,200);
  assert.equal(response.headers.get('strict-transport-security'),'max-age=31536000; includeSubDomains');
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.equal(response.headers.get('referrer-policy'),'no-referrer');
  assert.equal(response.headers.get('cross-origin-opener-policy'),'same-origin');
  assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
});
test('ops: global CSP supplies the ASVS base-uri/object-src minimum',async t=>{
  const get=await fixture(t), response=await get('/probe'), csp=response.headers.get('content-security-policy');
  assert.match(csp,/base-uri 'none'/); assert.match(csp,/object-src 'none'/); assert.doesNotMatch(csp,/base-uri 'self'/);
});
test('ops: explicit same-origin PDF preview exception is retained',async t=>{
  const get=await fixture(t), response=await get('/api/schedule-preview.pdf');
  assert.equal(response.status,200); assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'self'/);
});
test('ops: attachment HTML retains sandbox and explicit minimum/frame restrictions',async t=>{
  const get=await fixture(t), response=await get('/api/sales-report-jobs/audit-id/download');
  assert.equal(response.status,200,await response.clone().text());
  assert.match(response.headers.get('content-type'),/^text\/html/);
  assert.match(response.headers.get('content-disposition'),/^attachment;/);
  const csp=response.headers.get('content-security-policy'); assert.match(csp,/sandbox/);
  assert.match(csp,/frame-ancestors 'none'/); assert.match(csp,/base-uri 'none'/); assert.match(csp,/object-src 'none'/);
  assert.equal(response.headers.get('x-frame-options'),'DENY');
});

test('ops: attachment PDF and inline image keep minimum policy and their previous sandbox intent',async t=>{
  const get=await fixture(t);
  for(const [route,type,download] of [['/api/sales-report-jobs/pdf/download','application/pdf',true],['/api/sales/articles/image?articleNumber=123','image/webp',false]]) {
    const response=await get(route);assert.equal(response.status,200,await response.clone().text());
    assert.ok(response.headers.get('content-type').startsWith(type));
    const csp=response.headers.get('content-security-policy');
    for(const directive of ["object-src 'none'","base-uri 'none'","frame-ancestors 'none'",'sandbox'])assert.ok(csp.includes(directive));
    assert.equal(csp.includes('allow-downloads'),download);
    assert.match(response.headers.get('content-disposition'),download?/^attachment;/:/^inline;/);
  }
});

test('ops: every explicit route CSP preserves the minimum; saved HTML meta has effective document directives',()=>{
  const files=['branch-sales-routes','sales-article-image-routes','sales-article-tools-routes','sales-bwl-abc-routes','sales-bwl-actions-routes','sales-bwl-simulation-routes','sales-price-labels-routes','sales-report-jobs-routes','trade-insight-job-routes'];
  let policies=0;
  for(const file of files) {
    const text=fs.readFileSync(path.resolve(__dirname,'../../lib/'+file+'.js'),'utf8');
    const values=[...text.matchAll(/default-src 'none';[^\n]*?sandbox(?: allow-downloads)?/g)];
    assert.ok(values.length,file);for(const [value] of values){policies++;for(const directive of ["object-src 'none'","base-uri 'none'","frame-ancestors 'none'"])assert.ok(value.includes(directive),file);}
  }
  assert.equal(policies,10);
  const html=require('../../lib/sales-report-document').renderSalesReportDocument({title:'Synthetic',query:{dateFrom:'2026-10-01',dateTo:'2026-10-18'},completedAt:'2026-10-18',result:{analysis:{processed:0},coverage:{metricState:'verified'},days:[],totals:{}}});
  assert.match(html,/<meta http-equiv="Content-Security-Policy" content="default-src 'none'; object-src 'none'; base-uri 'none'; style-src 'unsafe-inline'">/);
  assert.doesNotMatch(html,/frame-ancestors/,'framing belongs in HTTP headers, not an ineffective meta directive');
});
