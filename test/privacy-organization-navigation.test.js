"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {parseDocument} = require("htmlparser2");
const {createGroups} = require("../public/sidebar-layout");
const {FUNCTION_SEARCH_CATALOG,validateFunctionSearchCatalog} = require("../public/function-search-catalog");
const html=fs.readFileSync(path.join(__dirname,"../public/index.html"),"utf8");
const app=fs.readFileSync(path.join(__dirname,"../public/app.js"),"utf8");
test("privacy main section follows logistics and offers every privacy workflow",()=>{
  const navigation=html.slice(html.indexOf('id="logisticsNav"'),html.indexOf('</nav>',html.indexOf('id="logisticsNav"')));
  assert.ok(navigation.indexOf('id="privacyOrganizationNav"')>navigation.indexOf('id="logisticsNav"'));
  for(const tab of ["overview","data-map","dpia","breaches","agreements","dataRequests"]) assert.match(navigation,new RegExp(`data-privacy-organization-tab="${tab}"`));
  assert.ok(html.indexOf('src="/privacy-organization.js"')<html.indexOf('src="/app.js"'));
});
test("privacy browser destination opens its own sidebar group",()=>{
  const groups=createGroups(); groups.sync("privacy:breaches","privacyOrganization");
  assert.equal(groups.isOpen("privacyOrganization"),true);
  assert.equal(groups.isOpen("logistics"),false);
});
test("function search exposes the organization destinations and independent data requests",()=>{
  assert.deepEqual(validateFunctionSearchCatalog(),{valid:true,errors:[]});
  const entries=FUNCTION_SEARCH_CATALOG.filter(e=>e.target.view==="privacyOrganization");
  assert.equal(entries.length,6);
  assert.deepEqual(entries.map(e=>e.target.privacyOrganizationTab).sort(),["agreements","breaches","data-map","dataRequests","dpia","overview"]);
  assert.ok(entries.every(e=>e.access.gateIds.every(id=>html.includes(`id="${id}"`))));
  const requests=entries.find(e=>e.target.privacyOrganizationTab==="dataRequests");
  assert.deepEqual(requests.path,["Datenschutz","Datenanfragen"]);
  assert.deepEqual(requests.access.gateIds,["dataSubjectRequestsNavButton"]);
});

function source(name) {
  const start=app.indexOf(`function ${name}(`);
  assert.ok(start>=0,name);
  return app.slice(start,app.indexOf('\n}',start)+2);
}

test("data requests live only under privacy in both navigation and content",()=>{
  const nodes=[];
  const visit=node=>{nodes.push(node); for(const child of node.children||[])visit(child);};
  visit(parseDocument(html));
  const byId=id=>nodes.find(node=>node.attribs?.id===id);
  const inAncestor=(node,id)=>{for(let parent=node.parent;parent;parent=parent.parent)if(parent.attribs?.id===id)return true;return false;};
  assert.equal(inAncestor(byId("dataSubjectRequestsNavButton"),"privacyOrganizationNav"),true);
  assert.equal(inAncestor(byId("dataSubjectRequestsSection"),"privacyOrganizationView"),true);
  assert.equal(byId("dataSubjectRequestsTab"),undefined);
  assert.equal(nodes.filter(node=>node.attribs?.["data-personnel-administration-route"]==="dataRequests").length,0);
});

test("privacy visibility keeps DSAR independent and chooses an accessible main destination",()=>{
  const nodes=new Map();
  const node=(id,dataset={})=>{
    const classes=new Set();
    const value={dataset,classes,replaceChildren(){},classList:{toggle(name,on){on?classes.add(name):classes.delete(name);}}};
    nodes.set(id,value); return value;
  };
  const routes=["overview","data-map","dpia","breaches","agreements","dataRequests"].map(tab=>node(tab,{privacyOrganizationTab:tab}));
  const nav=node("privacyOrganizationNav");nav.querySelectorAll=()=>routes;
  const main=node("privacyOrganizationNavButton");
  const user={employeeNumber:"SYNTHETIC-DSAR",role:"hr",isEmployee:true,accountType:"employee",sessionKind:"employee",permissions:["data_subject_requests:read"]};
  const context={state:{currentView:"startDashboard",portalStatus:{portalEnabled:true},portalSession:{user}},document:{getElementById:id=>nodes.get(id)},
    window:{GrabenplanerPrivacyOrganization:require("../public/privacy-organization")},
    privacyOrganizationActorKey:"actor",privacyOrganizationAccessKey:()=>"actor",
  };
  vm.createContext(context);
  vm.runInContext(["hasGovernancePermission","canReadDataSubjectRequests","canReadPrivacyOrganizationWorkspace","canAccessPrivacyOrganization","firstAccessiblePrivacyOrganizationTab","canOpenPrivacyOrganizationTab","syncPrivacyOrganizationAccess"].map(source).join('\n'),context);
  context.syncPrivacyOrganizationAccess();
  assert.equal(nav.classes.has("hidden"),false);
  assert.equal(main.dataset.privacyOrganizationTab,"dataRequests");
  assert.equal(routes.at(-1).classes.has("hidden"),false);
  assert.ok(routes.slice(0,-1).every(route=>route.classes.has("hidden")));
  user.permissions=["privacy_organization:read"];
  context.syncPrivacyOrganizationAccess();
  assert.equal(main.dataset.privacyOrganizationTab,"overview");
  assert.equal(routes.at(-1).classes.has("hidden"),true);
  assert.ok(routes.slice(0,-1).every(route=>!route.classes.has("hidden")));
  user.permissions=[];
  context.syncPrivacyOrganizationAccess();
  assert.equal(nav.classes.has("hidden"),true);
});

test("price label overview tile and sidebar always use the same fresh access decision",()=>{
  const nodes=new Map(["salesPriceLabelsNavButton","salesPriceLabelsDashboardCard"].map(id=>[id,{hidden:true,classList:{toggle(name,on){nodes.get(id).hidden=on;}}}]));
  const context={document:{getElementById:id=>nodes.get(id)},canUseSalesPriceLabels:()=>true};
  vm.createContext(context);vm.runInContext(source("syncSalesPriceLabelsNavigation"),context);
  for(const allowed of [true,false,true]) {
    context.canUseSalesPriceLabels=()=>allowed;context.syncSalesPriceLabelsNavigation();
    for(const item of nodes.values())assert.equal(item.hidden,!allowed);
  }
  assert.match(html,/<button(?=[^>]*id="salesPriceLabelsDashboardCard")(?=[^>]*data-sales-dashboard-view="priceLabels")[^>]*>/);
});
