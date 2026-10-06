'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {parseDocument} = require('htmlparser2');
const project = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(project, 'public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(project, 'public/index.html'), 'utf8');
function source(name, text = app) {
  const match = text.match(new RegExp('(?:async )?function ' + name + '\\('));
  assert.ok(match, name);
  return text.slice(match.index, text.indexOf('\n}', match.index) + 2);
}
function load(context, names) {
  vm.createContext(context);
  vm.runInContext(names.map(name => source(name)).join('\n'), context);
  return context;
}
function node(dataset = {}, classes = '') {
  const attrs = new Map(), list = new Set(classes.split(/\s+/).filter(Boolean)), queries = new Map();
  return {
    dataset, hidden:false, disabled:false, value:'', textContent:'', innerHTML:'', open:false, handlers:new Map(), children:[],
    classList:{contains:value => list.has(value), toggle(value, on) { if(on)list.add(value);else list.delete(value); },
      add:value => list.add(value), remove:value => list.delete(value)},
    setAttribute(key, value) { attrs.set(key, String(value)); }, getAttribute:key => attrs.get(key) ?? null,
    hasAttribute:key => attrs.has(key),
    removeAttribute:key => attrs.delete(key),
    addEventListener(key, handler) { this.handlers.set(key,handler); }, removeEventListener(key) { this.handlers.delete(key); },
    querySelector(selector) { if(!queries.has(selector))queries.set(selector,node());return queries.get(selector); },
    querySelectorAll:() => [], closest() { return null; }, scrollIntoView() {}, focus() {}, reset() {},
    append(...children) { this.children.push(...children); }, remove() {},
    replaceChildren(...children) { this.children=children;this.innerHTML='';this.textContent=''; },
    close() { this.open=false; }, showModal() { this.open=true; },
  };
}
const ids = new Map();
function visit(element) {
  if(element.attribs?.id)ids.set(element.attribs.id,element);
  (element.children || []).forEach(visit);
}
visit(parseDocument(html));
const SETTINGS = ['general','schedule','personnel','access','rights','dataProtection','backup','systemCenter'];
function tabsFixture() {
  let records=0, profileClosed=0;
  const settings = [...ids.values()].filter(item => item.attribs?.['data-settings-tab']).map(item => {
    const button=node({settingsTab:item.attribs['data-settings-tab']},item.attribs.class);
    button.id=item.attribs.id;button.closest=selector => selector.includes('data-settings-tab') ? button : null;return button;
  });
  const team = [...ids.values()].filter(item => item.attribs?.['data-personnel-tab']).map(item => {
    const button=node({personnelTab:item.attribs['data-personnel-tab']},item.attribs.class);
    button.id=item.attribs.id;button.closest=selector => selector.includes('data-personnel-tab') ? button : null;return button;
  });
  const elements = Object.fromEntries(['generalSettings','scheduleSettings','personnelSettings','accessSettings','rightsSettings',
    'dataProtectionSettings','backupSettings','systemCenterPanel','employeeSettings','locationSettings','saveSettingsButton',
    'teamDisplayColumnsButton','pdfSettings','brandingSettings','filialTeamsNavButton'].map(id => [id,node()]));
  elements.generalSettings.classList.add('active');elements.employeeSettings.classList.add('active');
  const body=node();
  for(const element of [...settings,...team,...Object.values(elements)])element.parentElement=body;
  elements.pdfSettings.parentElement=elements.scheduleSettings;elements.pdfSettings.tagName='DETAILS';
  const context = {
    state:{portalStatus:{portalEnabled:true},portalSession:{user:{permissions:['settings:write','employees:read']}},
      currentView:'settings',personnelTab:'employees',employeeProfileHost:'team'},
    elements, schedulePdfSettingsWritePermission:'schedule:pdf:settings:write',
    canReadSystemCenter:() => true, canAccessTeamManagement:() => true, canManageLoanSettings:() => false,
    canManageMaintenanceSchedules:() => false, canManageOffsiteFolders:() => false, employeeProfileIsOpen:() => false,
    closeEmployeeProfile:() => {profileClosed++;}, window:{setTimeout:callback => callback()},
    pauseEmployeeProfile:() => {profileClosed++;}, resumeEmployeeProfile:() => {},
    document:{
      body,activeElement:null, getElementById:id => elements[id] || [...settings,...team].find(button => button.id === id) || null,
      querySelectorAll:selector => selector === '[data-settings-tab]' ? settings : selector === '[data-personnel-tab]' ? team : [],
      querySelector(selector) {
        const match=selector.match(/data-settings-tab="([^"]*)"/);
        return match ? settings.find(button => button.dataset.settingsTab === match[1]) : null;
      },
    },
    grabenplanerNavigation:{record:() => {records++;}},
    restoreRememberedOverallContext:() => false, planningContextNeedsReload:() => false,
  };
  for(const name of ['clearUsbProvisioningPasswords','loadLoanSettings','loadPortalUsers','loadOrganizationAccounts','loadAmuSettings',
    'loadAmuAccessPolicy','loadGreetingSettings','loadBirthdayPresentationSettings','loadWorkflowSettings','loadApprovalDelegations',
    'loadRightsManagement','loadSystemCenter','loadIntegrations','loadRetentionGovernance','loadWifiAutomationSettings',
    'refreshServerDiagnostics','loadMaintenanceSchedules','loadManagedOffsiteFolders','loadTrustLevelSettings',
    'loadManagementBrandingPreference','loadBrandingAssignments','renderSettings','scheduleAllSettingsPackedGrids',
    'canManageMobilePortalLocationDisplay','loadMobilePortalLocationDisplay']) context[name]=() => Promise.resolve();
  context.setView=view => {context.state.currentView=view;};
  for(const button of [...settings,...team])button.focus=() => {context.document.activeElement=button;};
  load(context,['visibleManagedTabButtons','syncManagedTabSelection','setManagedTabPanel','reconcileManagedTabs',
    'handleManagedTabKeydown','setSettingsTab','setPersonnelTab','functionSearchSettingsTabButton','applyFunctionSearchNavigationState']);
  const key=(kind,button,value) => {
    let prevented=false;
    context.handleManagedTabKeydown({target:button,key:value,preventDefault(){prevented=true;}},kind);
    return prevented;
  };
  return {context,settings,team,key,get records(){return records;},get profileClosed(){return profileClosed;}};
}
function selected(buttons) { return buttons.filter(button => button.getAttribute('aria-selected') === 'true'); }

test('Both real tablists bind each tab to one labelled panel and one initial keyboard stop',() => {
  for(const kind of ['settings','personnel']) {
    const buttons=[...ids.values()].filter(item => item.attribs?.['data-' + kind + '-tab']);
    assert.equal(buttons.length,kind === 'settings' ? 8 : 2);
    assert.equal(buttons.filter(button => button.attribs['aria-selected'] === 'true').length,1);
    assert.equal(buttons.filter(button => button.attribs.tabindex === '0').length,1);
    for(const button of buttons) {
      assert.equal(button.attribs.role,'tab');
      const panel=ids.get(button.attribs['aria-controls']);
      assert.ok(panel);assert.equal(panel.attribs.role,'tabpanel');
      assert.equal(panel.attribs['aria-labelledby'],button.attribs.id);
    }
  }
});

test('Settings arrows wrap and Home/End skip hidden and disabled tabs while updating panels and roving state',() => {
  const f=tabsFixture(), c=f.context;
  f.settings.find(button => button.dataset.settingsTab === 'personnel').disabled=true;
  c.setSettingsTab('general');
  assert.equal(f.key('settings',f.settings[0],'ArrowRight'),true);
  assert.equal(selected(f.settings)[0].dataset.settingsTab,'schedule');
  assert.equal(c.elements.scheduleSettings.classList.contains('active'),true);assert.equal(c.elements.generalSettings.classList.contains('active'),false);
  f.key('settings',f.settings[1],'ArrowRight');assert.equal(selected(f.settings)[0].dataset.settingsTab,'access');
  f.key('settings',c.document.activeElement,'End');assert.equal(selected(f.settings)[0].dataset.settingsTab,'backup');
  f.key('settings',c.document.activeElement,'ArrowRight');assert.equal(selected(f.settings)[0].dataset.settingsTab,'general');
  f.key('settings',c.document.activeElement,'ArrowLeft');assert.equal(selected(f.settings)[0].dataset.settingsTab,'backup');
  f.key('settings',c.document.activeElement,'Home');assert.equal(selected(f.settings)[0].dataset.settingsTab,'general');
  assert.equal(f.settings.filter(button => button.tabIndex === 0).length,1);
  assert.equal(f.key('settings',f.settings[5],'ArrowRight'),false);
  assert.equal(f.key('settings',f.settings[0],'Enter'),false);
});

test('Settings revocation replaces a hidden active tab and denied direct selection cannot expose hidden panels',() => {
  const f=tabsFixture(), c=f.context;
  c.setSettingsTab('rights');f.settings[4].classList.add('hidden');c.reconcileManagedTabs('settings');
  assert.equal(selected(f.settings)[0].dataset.settingsTab,'general');assert.equal(c.elements.rightsSettings.classList.contains('active'),false);
  c.setSettingsTab('dataProtection');assert.equal(selected(f.settings)[0].dataset.settingsTab,'general');
  f.settings.forEach(button => {button.hidden=true;});c.reconcileManagedTabs('settings');
  assert.equal(selected(f.settings).length,0);assert.equal(f.settings.filter(button => button.tabIndex === 0).length,0);
  for(const id of ['generalSettings','scheduleSettings','rightsSettings','systemCenterPanel'])assert.equal(c.elements[id].classList.contains('active'),false);
});

test('Team keyboard navigation respects location visibility, profile close, access denial and history',() => {
  const f=tabsFixture(), c=f.context;
  c.employeeProfileIsOpen=() => true;c.setPersonnelTab('employees');
  f.key('personnel',f.team[0],'ArrowRight');assert.equal(c.state.personnelTab,'locations');assert.equal(f.profileClosed,1);
  assert.equal(c.elements.locationSettings.classList.contains('active'),true);assert.equal(c.elements.employeeSettings.classList.contains('active'),false);
  f.team[1].classList.add('hidden');c.reconcileManagedTabs('personnel');
  assert.equal(c.state.personnelTab,'employees');assert.equal(c.elements.locationSettings.classList.contains('active'),false);
  f.key('personnel',f.team[0],'End');assert.equal(c.state.personnelTab,'employees');
  c.setPersonnelTab('locations');assert.equal(c.state.personnelTab,'employees');
  c.canAccessTeamManagement=() => false;c.setPersonnelTab('locations');assert.equal(c.state.personnelTab,'employees');
  assert.ok(f.records>0);
});

test('PDF search needs the schedule gate and reaches the actual schedule panel without the general gate',() => {
  const {FUNCTION_SEARCH_CATALOG,functionSearchEntryIsAvailable}=require('../public/function-search-catalog');
  const {functionSearchDomGateIsAvailable,presentFunctionSearchTarget}=require('../public/function-search-navigation');
  const entry=FUNCTION_SEARCH_CATALOG.find(item => item.id === 'settings.pdf');
  assert.equal(entry.target.settingsTab,'schedule');assert.equal(entry.path[1],'Dienstplanung');
  assert.equal(functionSearchEntryIsAvailable(entry,{authenticated:true,availableGateIds:['settingsGeneralTab','pdfSettings']}),false);
  assert.equal(functionSearchEntryIsAvailable(entry,{authenticated:true,availableGateIds:['settingsScheduleTab','pdfSettings']}),true);
  const f=tabsFixture(), c=f.context;c.setSettingsTab('general');
  const available=() => functionSearchEntryIsAvailable(entry,{authenticated:true,
    isGateAvailable:id => functionSearchDomGateIsAvailable(id,{document:c.document})});
  assert.equal(c.elements.scheduleSettings.classList.contains('active'),false);assert.equal(available(),true);
  f.settings[0].classList.add('hidden');assert.equal(available(),true);
  assert.equal(f.context.applyFunctionSearchNavigationState(entry.target),true);
  assert.equal(c.elements.scheduleSettings.classList.contains('active'),true);assert.equal(c.elements.generalSettings.classList.contains('active'),false);
  assert.equal(selected(f.settings)[0].dataset.settingsTab,'schedule');
  assert.equal(presentFunctionSearchTarget(entry.target,{document:c.document,setTimeout:callback => callback()}).ok,true);
  assert.equal(c.elements.pdfSettings.open,true);
  c.elements.pdfSettings.classList.add('hidden');assert.equal(available(),false);
});
test('Location search stays available from the inactive location panel and opens only when its tab is permitted',() => {
  const {FUNCTION_SEARCH_CATALOG,functionSearchEntryIsAvailable}=require('../public/function-search-catalog');
  const {functionSearchDomGateIsAvailable}=require('../public/function-search-navigation');
  const entry=FUNCTION_SEARCH_CATALOG.find(item => item.target.personnelTab === 'locations'), f=tabsFixture(), c=f.context;
  c.setPersonnelTab('employees');
  const available=() => functionSearchEntryIsAvailable(entry,{authenticated:true,
    isGateAvailable:id => functionSearchDomGateIsAvailable(id,{document:c.document})});
  assert.equal(c.elements.locationSettings.classList.contains('active'),false);assert.equal(available(),true);
  assert.equal(c.applyFunctionSearchNavigationState(entry.target),true);
  assert.equal(c.elements.locationSettings.classList.contains('active'),true);
  f.team[1].classList.add('hidden');assert.equal(available(),false);
});

const LEARNING_RIGHTS=['personnel:learning:catalog:read','personnel:learning:catalog:manage',
  'personnel:learning:catalog:publish','personnel:learning:assignments:write'];
function learningFixture() {
  const cleared={knowledge:0,assessment:0,team:0};
  const context={
    state:{portalStatus:{portalEnabled:true},portalSession:{authenticated:true,user:{employeeNumber:'SYNTHETIC-ONE',
      isEmployee:true,role:'manager',homeLocationId:'93',preferredDepartmentId:1,
      permissions:[...LEARNING_RIGHTS],scopes:[{locationId:'93',departmentId:1}],permissionScopes:[]}}},
    personnelKnowledgeLibrary:{clear(){cleared.knowledge++;}},
    personnelLearningAssessmentPanel:{clear(){cleared.assessment++;}},personnelLearningTeam:{clear(){cleared.team++;}},
  };
  load(context,['hasGovernancePermission','canReadPersonnelLearningCatalog','canWritePersonnelLearningCompetencies',
    'currentPersonnelLearningAccessSnapshot','syncPersonnelLearningAccessState']);
  context.syncPersonnelLearningAccessState();
  for(const key of Object.keys(cleared))cleared[key]=0;
  return {context,cleared};
}
test('Stable learning access, permission order, unrelated rights and unrelated scope grants preserve open views',() => {
  const f=learningFixture(), user=f.context.state.portalSession.user;
  user.permissions.reverse();user.permissions.push('sales:articles:write');
  user.permissionScopes.push({permission:'sales:articles:write',locationId:'94',departmentId:2});
  user.fullName='Changed display name';
  f.context.syncPersonnelLearningAccessState();f.context.syncPersonnelLearningAccessState();
  assert.deepEqual(f.cleared,{knowledge:0,assessment:0,team:0});
});
test('Actor and effective learning scopes invalidate views, but equivalent scope order and attribution do not',() => {
  const f=learningFixture(), user=f.context.state.portalSession.user;
  user.permissionScopes=[{permission:LEARNING_RIGHTS[0],locationId:'93',departmentId:1,approvedBy:'FIRST'}];
  f.context.syncPersonnelLearningAccessState();
  for(const key of Object.keys(f.cleared))f.cleared[key]=0;
  user.permissionScopes[0].approvedBy='SECOND';user.scopes.push({...user.scopes[0]});
  f.context.syncPersonnelLearningAccessState();assert.deepEqual(f.cleared,{knowledge:0,assessment:0,team:0});
  user.scopes[0].departmentId=2;f.context.syncPersonnelLearningAccessState();
  assert.deepEqual(f.cleared,{knowledge:1,assessment:1,team:1});
  user.employeeNumber='SYNTHETIC-TWO';f.context.syncPersonnelLearningAccessState();
  assert.deepEqual(f.cleared,{knowledge:2,assessment:2,team:2});
});
test('Catalog revocation clears once, while assignment revocation clears only the separate team area',() => {
  const f=learningFixture(), user=f.context.state.portalSession.user;
  user.permissions=user.permissions.filter(permission => permission !== 'personnel:learning:assignments:write');
  f.context.syncPersonnelLearningAccessState();f.context.syncPersonnelLearningAccessState();
  assert.deepEqual(f.cleared,{knowledge:0,assessment:0,team:1});
  user.permissions=[];f.context.syncPersonnelLearningAccessState();f.context.syncPersonnelLearningAccessState();
  assert.deepEqual(f.cleared,{knowledge:1,assessment:1,team:1});
});

test('Learning role, home location and preferred department changes clear each area once while equivalent values remain stable',() => {
  for(const change of [user => {user.role='department_manager';},user => {user.homeLocationId='94';},
    user => {user.preferredDepartmentId=2;}]) {
    const f=learningFixture();change(f.context.state.portalSession.user);
    f.context.syncPersonnelLearningAccessState();f.context.syncPersonnelLearningAccessState();
    assert.deepEqual(f.cleared,{knowledge:1,assessment:1,team:1});
  }
  const f=learningFixture(), user=f.context.state.portalSession.user;
  user.role=' MANAGER ';user.homeLocationId=' 93 ';user.preferredDepartmentId='1';
  f.context.syncPersonnelLearningAccessState();assert.deepEqual(f.cleared,{knowledge:0,assessment:0,team:0});
});
test('Logout, unauthenticated, organizational and required-password sessions invalidate learning dialogs',() => {
  for(const change of [c => {c.state.portalSession=null;},c => {c.state.portalSession.authenticated=false;},
    c => {c.state.portalSession.user.mustChangePassword=true;},c => {c.state.portalSession.user.isEmployee=false;}]) {
    const f=learningFixture();change(f.context);f.context.syncPersonnelLearningAccessState();
    assert.deepEqual(f.cleared,{knowledge:1,assessment:1,team:1});
  }
  assert.match(source('showLoginGate'),/state\.portalSession = null;\s*syncPersonnelLearningAccessState\(\)/);
  assert.match(source('applyRoleVisibility'),/syncPersonnelLearningAccessState\(\)/);
});
test('Real knowledge, assessment and team generation guards discard late reads after actor or learning context changes',async() => {
  for(const change of [user => {user.employeeNumber='SYNTHETIC-TWO';},user => {user.role='department_manager';},
    user => {user.homeLocationId='94';},user => {user.preferredDepartmentId=2;}]) {
    const f=learningFixture(), c=f.context, waiting=[];
    c.api=() => new Promise(resolve => waiting.push(resolve));
    c.document={body:node(),createElement:() => node(),addEventListener(){}};
    const knowledge=node(), team=node();
    vm.runInContext(fs.readFileSync(path.join(project,'public/learning-library.js'),'utf8'),c);
    vm.runInContext(fs.readFileSync(path.join(project,'public/learning-assessment.js'),'utf8'),c);
    vm.runInContext(fs.readFileSync(path.join(project,'public/learning-team.js'),'utf8'),c);
    c.personnelKnowledgeLibrary=c.GrabenplanerLearningLibrary.mount(knowledge,{api:c.api});
    c.personnelLearningAssessmentPanel=c.GrabenplanerLearningAssessment.init({api:c.api});
    c.personnelLearningTeam=c.GrabenplanerLearningTeam.mount(team,{api:c.api});
    const reads=[c.personnelKnowledgeLibrary.load(),c.personnelLearningAssessmentPanel.open('SYNTHETIC-ASSIGNMENT'),
      c.personnelLearningTeam.load()];
    assert.equal(waiting.length,3);
    change(c.state.portalSession.user);c.syncPersonnelLearningAccessState();
    waiting.forEach(resolve => resolve({sensitive:'OLD ACTOR',modules:[],scopes:[]}));
    await Promise.all(reads);
    assert.equal(knowledge.querySelector('[data-knowledge-status]').textContent,'');
    assert.equal(team.innerHTML,'');assert.equal(team.textContent,'');
    const dialog=c.document.body.children[0];assert.equal(dialog.open,false);assert.equal(dialog.innerHTML,'');
  }
});

function teardownContext(workspace, priceRoot) {
  const c={state:{portalSession:null,currentView:'startDashboard'},salesHistoryActorKey:'previous',
    salesPriceLabelsWorkspace:workspace,window:{},document:{getElementById:id => id === 'salesPriceLabelsWorkspace' ? priceRoot : null},
    elements:{},syncPrivacyOrganizationAccess(){},syncSalesPriceLabelsNavigation(){},canUseSalesPriceLabels:() => false,
    canAccessTradeInsights:() => false,canReadTradeMovements:() => false,canReadSalesArticles:() => false};
  for(const name of ['tradeInsightsWorkspace','salesReportJobUi','receiptSearchWorkspace','salesHistoryWorkspace',
    'dataImportWorkspace','importMappingWorkspace','crmPurchaseWorkspace'])c[name]=null;
  return load(c,['syncSalesHistoryAccess']);
}
test('Actor teardown destroys the real price workspace once, aborts pending reads and never suspends removed DOM',async() => {
  const Editor=require('../public/sales-price-labels');
  const fixtureSource=fs.readFileSync(path.join(__dirname,'sales-article-price-labels.test.js'),'utf8');
  const fixture=new Function('Editor','require',source('editorFixture',fixtureSource)+'\nreturn editorFixture;')(Editor,require);
  let pending, signal;
  const f=fixture(async (url,options) => {
    if(url.endsWith('/templates')) {signal=options.signal;return new Promise(resolve => {pending=resolve;});}
    if(url.endsWith('/branding'))return {kits:[]};
    return {templates:[],capabilities:{create:true},recipients:[]};
  });
  let removed=false, destroys=0, suspends=0;
  const query=f.root.querySelector.bind(f.root);
  f.root.querySelector=selector => removed ? null : query(selector);
  f.root.replaceChildren=() => {removed=true;};
  const realDestroy=f.workspace.destroy, realSuspend=f.workspace.suspend;
  f.workspace.destroy=() => {destroys++;realDestroy();};
  f.workspace.suspend=() => {suspends++;realSuspend();};
  const read=f.workspace.load(), c=teardownContext(f.workspace,f.root);
  assert.doesNotThrow(() => c.syncSalesHistoryAccess());
  assert.equal(destroys,1);assert.equal(suspends,0);assert.equal(c.salesPriceLabelsWorkspace,null);assert.equal(signal.aborted,true);
  pending({options:{...Editor.defaults},filenameOptions:{}});await read;
  assert.equal(removed,true);assert.doesNotThrow(() => c.syncSalesHistoryAccess());assert.equal(destroys,1);
});
test('Older suspend-only price workspaces retain a single teardown fallback',() => {
  let suspends=0;
  const c=teardownContext({suspend(){suspends++;}},node());
  c.syncSalesHistoryAccess();c.syncSalesHistoryAccess();assert.equal(suspends,1);assert.equal(c.salesPriceLabelsWorkspace,null);
});
