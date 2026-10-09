'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const UI=require('../public/sales-bwl');
test('ABC table sorting preserves decimal precision, nulls last, source identities and backend classes',()=>{
 const rows=[{id:'a',netRevenue:'99999999999999999999.99',class:'A'},{id:'b',netRevenue:'99999999999999999999.98',class:'B'},{id:'c',netRevenue:null,class:null}];
 assert.deepEqual(UI.sortedRows(rows,'netRevenue','desc').map(r=>r.id),['a','b','c']);assert.deepEqual(UI.sortedRows(rows,'netRevenue','asc').map(r=>r.id),['b','a','c']);
 assert.equal(UI.compareDecimal('-1.000','-0.999'),-1);assert.equal(UI.compareDecimal('0001.20','1.2'),0);assert.equal(rows[0].class,'A');assert.match(UI.format('99999999999999999999.99','netRevenue'),/99\.999\.999\.999\.999\.999\.999,99/);
});
test('criteria equality ignores property and filial order but detects changed boundaries or metric',()=>{
 const a={dateFrom:'2026-01-01',dateTo:'2026-10-09',metric:'netRevenue',aLimit:80,bLimit:95,locationIds:['05','18']};
 const b={locationIds:['18','05'],bLimit:95,aLimit:80,metric:'netRevenue',dateTo:'2026-10-09',dateFrom:'2026-01-01'};
 assert.equal(UI.sameQuery(a,b),true);assert.equal(UI.sameQuery(a,{...b,aLimit:70}),false);assert.equal(UI.sameQuery(a,{...b,metric:'grossMargin'}),false);assert.equal(UI.sameQuery(a,null),false);
});
test('real app BWL access guard requires authenticated active personal history access',()=>{
 const app=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),start=app.indexOf('function canReadSalesBwl('),end=app.indexOf('\nfunction ',start+1),context={state:{portalSession:{authenticated:true,user:{employeeNumber:'42',isEmployee:true,active:true,salesHistory:{read:true}}}}};
 vm.createContext(context);vm.runInContext(app.slice(start,end),context);assert.equal(context.canReadSalesBwl(),true);
 for(const change of [{active:false},{isEmployee:false},{mustChangePassword:true},{employeeNumber:''},{salesHistory:{read:false}}]){const original=structuredClone(context.state.portalSession.user);Object.assign(context.state.portalSession.user,change);assert.equal(context.canReadSalesBwl(),false);context.state.portalSession.user=original;}
 context.state.portalSession.authenticated=false;assert.equal(context.canReadSalesBwl(),false);
});
