"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {createGroups} = require("../public/sidebar-layout");
const {FUNCTION_SEARCH_CATALOG,validateFunctionSearchCatalog} = require("../public/function-search-catalog");
const html=fs.readFileSync(path.join(__dirname,"../public/index.html"),"utf8");
test("privacy main section follows logistics and offers every privacy workflow",()=>{
  const navigation=html.slice(html.indexOf('id="logisticsNav"'),html.indexOf('</nav>',html.indexOf('id="logisticsNav"')));
  assert.ok(navigation.indexOf('id="privacyOrganizationNav"')>navigation.indexOf('id="logisticsNav"'));
  for(const tab of ["overview","data-map","dpia","breaches","agreements"]) assert.match(navigation,new RegExp(`data-privacy-organization-tab="${tab}"`));
  assert.ok(html.indexOf('src="/privacy-organization.js"')<html.indexOf('src="/app.js"'));
});
test("privacy browser destination opens its own sidebar group",()=>{
  const groups=createGroups(); groups.sync("privacy:breaches","privacyOrganization");
  assert.equal(groups.isOpen("privacyOrganization"),true);
  assert.equal(groups.isOpen("logistics"),false);
});
test("function search exposes only the five supported privacy destinations",()=>{
  assert.deepEqual(validateFunctionSearchCatalog(),{valid:true,errors:[]});
  const entries=FUNCTION_SEARCH_CATALOG.filter(e=>e.target.view==="privacyOrganization");
  assert.equal(entries.length,5);
  assert.deepEqual(entries.map(e=>e.target.privacyOrganizationTab).sort(),["agreements","breaches","data-map","dpia","overview"]);
  assert.ok(entries.every(e=>e.access.gateIds.every(id=>html.includes(`id="${id}"`))));
});
