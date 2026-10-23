'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),test=require('node:test');
const vm=require('node:vm'),model=require('../public/start-dashboard-workspace-preferences');
const root=path.join(__dirname,'..'),app=fs.readFileSync(path.join(root,'public/app.js'),'utf8'),html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
test('Start and Personnel activate the shared multi-dashboard controller in production markup',()=>{
  const start=app.slice(app.indexOf('function syncStartDashboardWorkspace()'),app.indexOf('function canReadStartDashboardVps()'));
  const personnel=app.slice(app.indexOf('function syncPersonnelDashboardWorkspace()'),app.indexOf('function canUsePersonnelDashboardInformation()'));
  for(const source of[start,personnel])assert.match(source,/boards:\s*true/);
  assert.match(start,/closeHidesField:\s*true/);assert.match(start,/hideable:\s*\(\)\s*=>\s*true/);
  assert.ok(html.indexOf('src="/gp-dashboard-boards.js"')<html.indexOf('src="/start-dashboard-workspace.js"'));
  assert.match(html,/href="\/gp-dashboard-boards.css"/);
});
test('production Start migration copies legacy hiding into the first board and keeps explicit workspace choices',()=>{
  const state={startDashboardPreferences:{hidden:['vacation'],hiddenWidgets:['branchAbsences']}};
  const context={state,window:{StartDashboardWorkspacePreferences:model},normalizeStartDashboardPreferences:value=>value};vm.createContext(context);
  const start=app.indexOf('function migrateStartDashboardWorkspace(');vm.runInContext(app.slice(start,app.indexOf('\n}',start)+2),context);
  const old={version:1,fields:{'card:schedule':{title:'Mein Plan'},'card:vacation':{hidden:false}}};
  const migrated=context.migrateStartDashboardWorkspace(old);
  assert.equal(migrated.fields['card:vacation'].hidden,false);assert.equal(migrated.fields['widget:branchAbsences'].hidden,true);
  assert.equal(migrated.fields['card:schedule'].title,'Mein Plan');assert.equal(old.fields['widget:branchAbsences'],undefined);
  const document=model.toDocument(JSON.parse(JSON.stringify(migrated)));
  document.activeDashboard='dashboard-2';assert.deepEqual(context.migrateStartDashboardWorkspace(document),document);
  assert.deepEqual(model.getBoard(document).fields,{});
});
