'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Registry=require('../public/gp-definitions-registry');
const repo=path.resolve(__dirname,'..'),app=fs.readFileSync(path.join(repo,'public/app.js'),'utf8'),html=fs.readFileSync(path.join(repo,'public/index.html'),'utf8');
function appFunction(name){const start=app.indexOf('function '+name+'(');assert.ok(start>=0,name);const end=app.indexOf('\nfunction ',start+1);return app.slice(start,end<0?app.length:end);}

test('registry provides eight stable, immutable standards and existing implementation references',()=>{
  assert.equal(Registry.VERSION,8);assert.equal(Registry.UPDATED,'2026-10-15');
  assert.deepEqual(Registry.topics.map(topic=>topic.id),['sidebar','dashboard','windows','print','tables','views','design','galleries']);
  assert.ok(Object.isFrozen(Registry.topics));
  for(const topic of Registry.topics){
    assert.ok(Object.isFrozen(topic)&&Object.isFrozen(topic.rules));assert.equal(topic.rules.length,['dashboard','print','sidebar'].includes(topic.id)?9:['galleries','windows'].includes(topic.id)?7:6);
    for(const rule of topic.rules)assert.ok(rule.title&&rule.text&&Object.isFrozen(rule));
    for(const reference of topic.references)assert.ok(fs.existsSync(path.join(repo,reference)),reference);
  }
  assert.throws(()=>Registry.topics[0].rules.push({title:'x',text:'y'}),TypeError);
});

test('dashboard standard defines named views, reversible hiding, group docking, safe notes, chosen contents and protected saves',()=>{
  const dashboard=Registry.topics.find(topic=>topic.id==='dashboard'),rules=dashboard.rules.map(rule=>rule.text).join(' ');
  assert.equal(dashboard.title,'GP-dashboard');
  for(const term of ['Startdashboard','Personaldashboard','drei unabhängig','frei wählbaren Namen','je angemeldetem Konto','ausgeblendete Felder','wieder einblenden','alle acht Ränder','ursprüngliche Gruppe','wieder integriert','Notizfelder','HTML, Skripte','Zeitausgleich statt Urlaub','leere Auswahl','keine zusätzlichen Rechte','Desktop-Positionen','Pfeiltasten und Escape','Späte Antworten','Speicherfehler'])assert.ok(rules.includes(term),term);
  assert.deepEqual(Registry.select({query:'dashboard notizfelder'}).map(topic=>topic.id),['dashboard']);
  assert.deepEqual(Registry.select({topic:'dashboard',query:'ursprüngliche Gruppe'}).map(topic=>topic.id),['dashboard']);
});

test('sidebar standard explains ancestor navigation, personal disclosures, current destination, rights and mobile drawer',()=>{
  const sidebar=Registry.topics.find(topic=>topic.id==='sidebar'),rules=sidebar.rules.map(rule=>rule.text).join(' ');
  assert.equal(sidebar.title,'GP-sidebar');
  for(const term of ['Unterpunkt','Zurück','Vorwärts','aria-current','aria-expanded','je angemeldetem Konto','Hintergrundaktualisierung','Rechtewechsel','mobile Menüfläche','44 Pixel','13 Pixel','GP-Standards','BWL-Tools'])assert.ok((rules+' '+sidebar.example).includes(term),term);
  assert.deepEqual(Registry.select({query:'sidebar mobile'}).map(topic=>topic.id),['sidebar']);
});

test('definition search is accent-insensitive, uses all words, and respects topic scope',()=>{
  assert.deepEqual(Registry.select({query:'grossenanderung sidebar'}).map(topic=>topic.id),['windows']);
  assert.deepEqual(Registry.select({query:'PDF Bytes'}).map(topic=>topic.id),['print']);
  assert.deepEqual(Registry.select({topic:'tables',query:'konto'}).map(topic=>topic.id),['tables']);
  assert.equal(Registry.select({topic:'windows',query:'Dateiname'}).length,0);
  assert.equal(Registry.select({query:'<script>alert(1)</script>'}).length,0);
  assert.equal(Registry.select({topic:'unknown'}).length,0);
});

test('Developer access excludes unauthenticated, branch, inactive, password-gated and other role sessions',()=>{
  const session={authenticated:true,user:{role:'developer',employeeNumber:'252',isEmployee:true,active:true,mustChangePassword:false}};
  assert.equal(Registry.canAccess(session),true);
  assert.equal(Registry.canAccess(null),false);assert.equal(Registry.canAccess({...session,authenticated:false}),false);
  for(const change of [{role:'admin'},{role:'it_admin'},{role:'hr'},{role:'manager'},{role:'employee'},{isEmployee:false},{active:false},{mustChangePassword:true}])assert.equal(Registry.canAccess({...session,user:{...session.user,...change}}),false,JSON.stringify(change));
});

test('actual application helper delegates to the current authenticated session',()=>{
  const context={window:{GpDefinitionsRegistry:Registry},state:{portalSession:{authenticated:true,user:{role:'developer',isEmployee:true}}}};
  vm.createContext(context);vm.runInContext(appFunction('canUseGpDefinitions'),context);
  assert.equal(context.canUseGpDefinitions(),true);
  context.state.portalSession.user.role='manager';assert.equal(context.canUseGpDefinitions(),false);
  context.state.portalSession.user.role='developer';context.state.portalSession.user.mustChangePassword=true;assert.equal(context.canUseGpDefinitions(),false);
  delete context.window.GpDefinitionsRegistry;assert.equal(context.canUseGpDefinitions(),false);
});

test('new view is connected to the real Developer button, URL guard and access reconciliation',()=>{
  assert.match(html,/<button[^>]*id="gpDefinitionsNavButton"[^>]*type="button"[^>]*hidden>Developer<\/button>/);
  assert.match(html,/<section id="gpDefinitionsView" class="view gp-definitions-view"/);
  assert.ok(html.indexOf('/gp-definitions-registry.js')<html.indexOf('/gp-definitions.js'));
  assert.ok(html.indexOf('/gp-definitions.js')<html.indexOf('/app.js'));
  assert.match(appFunction('pageViewElement'),/gpDefinitions: document\.getElementById\('gpDefinitionsView'\)/);
  assert.match(appFunction('setView'),/view === 'gpDefinitions' && !canUseGpDefinitions\(\)/);
  assert.match(appFunction('applyRequestedView'),/"gpDefinitions"/);
  assert.match(appFunction('renderSidebarSession'),/renderGpDefinitionsAccess\(\)/);
  assert.match(appFunction('renderGpDefinitionsAccess'),/!allowed && state\.currentView === 'gpDefinitions'.*setView\('startDashboard'\)/);
});

test('scope note does not claim all older workspaces already implement the standards',()=>{
  const client=fs.readFileSync(path.join(repo,'public/gp-definitions.js'),'utf8');
  assert.match(client,/Ältere Bereiche werden bei ihrer Überarbeitung an diesen Standard angepasst/);
  assert.ok(!client.includes('innerHTML'),'Registry and search values render through textContent');
});
