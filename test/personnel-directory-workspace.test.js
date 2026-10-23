"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {read,section}=require("../test-support/learning-workspace-ui");
test("Personal-Unterseiten sind elf eindeutig benannte Regionen; fachliche Tabs und Formfelder bleiben eigenständig",()=>{
  const html=read("index.html"),personal=section("personnelAdministrationView"),app=read("app.js");
  assert.doesNotMatch(personal,/personnel-administration-tabs|data-personnel-administration-tab|role="tabpanel"[^>]*aria-labelledby="(?:personnelDirectory|positionManagement|candidatePreboarding|workflowCenter|personnelLearning|personnelTasks|costCenters|customWorkRules|collectiveAgreements|centralVacations)Tab"/);
  const regions=[...personal.matchAll(/<section\b[^>]*class="personnel-administration-section[^>]*role="region"[^>]*aria-labelledby="([^"]+)"/g)];
  assert.equal(regions.length,11);
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length);
  for(const [,id]of regions){assert.match(personal,new RegExp('<h2\\b[^>]*id="'+id+'"'));assert.equal(ids.filter(x=>x===id).length,1);}
  assert.match(html,/<input id="personnelLearningTitle"/);
  assert.match(personal,/<h2 id="personnelLearningSectionTitle">/);
  assert.match(personal,/class="employee-profile-tabs" role="tablist"/);
  assert.match(personal,/data-learning-area="processes"/);
  assert.doesNotMatch(app,/document\.querySelectorAll\("\[data-personnel-administration-tab\]"\)/);
  assert.match(html,/data-personnel-administration-route="employees"/);
});
test("Mitarbeitendenbereich erhält einen eigenen Trefferstatus und verwendet weiter dieselben Profil-, Spalten- und Sortierverträge",()=>{
  const personal=section("personnelDirectorySection"),app=read("app.js"),css=read("personnel-directory-workspace.css");
  assert.match(personal,/role="search" aria-label="Mitarbeitende filtern"/);
  for(const id of ["personnelDisplayColumnsButton","personnelDirectorySearch","personnelDirectoryCostCenterFilter","personnelDirectoryStatusFilter","personnelDirectoryTable","personnelDirectoryBody","employeeProfileWorkspace"])assert.match(personal,new RegExp('id="'+id+'"'));
  assert.match(personal,/id="personnelDirectoryResultCount" role="status" aria-live="polite"/);
  assert.match(app,/const rows = source.status === "succeeded" \? sortedEmployeesForDisplay\(filteredPersonnelDirectory\(\)\)/);
  assert.match(css,/@media\(max-width:1180px\)[\s\S]*personnel-directory-table \{ min-width:0/);
});
