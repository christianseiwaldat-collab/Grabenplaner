'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-branch-windows-'));
Object.assign(process.env, {DB_PATH:path.join(root,'demo.db'), BACKUP_DIR:path.join(root,'backups'),
  GRABENPLANER_DATA_DIR:path.join(root,'data'), GRABENPLANER_HOST:'127.0.0.1', GRABENPLANER_FORCE_PORTAL:'1',
  GRABENPLANER_SEED_DEMO:'1', GRABENPLANER_INTEGRATION_KEY_ID:'branch-window-test',
  GRABENPLANER_INTEGRATION_KEY:Buffer.alloc(32,91).toString('base64'), NODE_ENV:'test'});
const {app,db,releaseInstanceLockForTests} = require('../server');
const endpoint = '/api/portal/v1/branch-window-preferences';
const geometry = (x=12) => ({x,y:23,width:610,height:480,minimized:true});
const windows = (x=12) => ({version:1,windows:{'price-label-search':geometry(x)}});
let server,url,admin;
async function request(route, {session,method='GET',body,csrf=true}={}) {
  const response = await fetch(url+route,{method,headers:{'Content-Type':'application/json',
    ...(session?{Cookie:session.cookie}:{}), ...(session && csrf?{'X-CSRF-Token':session.csrf}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,data:await response.json(),headers:response.headers};
}
const account = name => ({loginName:name,displayName:'Synthetic branch',accountType:'branch',active:true,
  password:'Windows-Synthetic-Test!',permissions:[],scopes:[{locationId:'93'}]});
async function login(name) {
  const result=await request('/api/portal/v1/auth/login',{method:'POST',body:{loginName:name,password:account(name).password}});
  assert.equal(result.status,200,JSON.stringify(result.data));
  const cookies=result.headers.getSetCookie().map(value=>value.split(';',1)[0]);
  return {cookie:cookies.join('; '),csrf:decodeURIComponent(cookies.find(v=>v.startsWith('grabenplaner_csrf=')).split('=')[1])};
}
async function create(name,permissions=[]) {
  const result=await request('/api/portal/v1/organization-accounts',{session:admin,method:'POST',body:{...account(name),permissions}});
  assert.equal(result.status,201,JSON.stringify(result.data));
  return result.data.account.id;
}
test.before(async()=>{
  db.prepare('INSERT INTO locations (id,name,min_staff,active) VALUES (?,?,0,1)').run('93','Synthetic 93');
  db.exec("INSERT INTO employees (personnel_number,full_name,nickname,color,contracted_hours,home_location_id,active) VALUES ('window-admin','Synthetic admin','Admin','#287a67',38.5,'93',1)");
  db.exec("INSERT INTO portal_users (employee_number,password_hash,role,active,must_change_password) VALUES ('window-admin','test-only','hr',1,0)");
  const token=crypto.randomBytes(32).toString('hex'),csrf=crypto.randomBytes(24).toString('hex');
  db.prepare("INSERT INTO portal_sessions (id,employee_number,token_hash,expires_at) VALUES (?,'window-admin',?,'2099-12-31T23:59:59.000Z')")
    .run(crypto.randomUUID(),crypto.createHash('sha256').update(token).digest('hex'));
  admin={cookie:`grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`,csrf};
  await new Promise(resolve=>{server=app.listen(0,'127.0.0.1',resolve);});url='http://127.0.0.1:'+server.address().port;
});
test.after(async()=>{
  if(server)await new Promise(resolve=>server.close(resolve));db.close();releaseInstanceLockForTests();
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('gp-branch-windows-'));
  fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
});
test('real branch HTTP geometry is encrypted, account-separated, persistent and CAS protected',async t=>{
  const idA=await create('branch-window-a');await create('branch-window-b');
  let a=await login('branch-window-a'),b=await login('branch-window-b');
  await t.test('authentication, account type and employee UI-preferences boundary stay closed',async()=>{
    assert.equal((await request(endpoint)).status,401);
    assert.equal((await request(endpoint,{session:admin})).status,403);
    assert.equal((await request('/api/portal/v1/ui-preferences',{session:a})).status,403);
    assert.deepEqual((await request(endpoint,{session:a})).data,{revision:0,gpWindows:{version:1,windows:{}}});
  });
  const input={revision:0,gpWindows:windows()};
  await t.test('CSRF and geometry-only allowlist are mandatory',async()=>{
    assert.equal((await request(endpoint,{session:a,method:'PUT',body:input,csrf:false})).status,403);
    for(const body of [{...input,employeeNumber:'window-admin'}, {...input,gpWindows:{...windows(),text:'private'}},
      {...input,gpWindows:{version:1,windows:{search:{...geometry(),width:99}}}},
      {...input,gpWindows:{version:1,windows:{search:{...geometry(),text:'private'}}}},
      {...input,gpWindows:{version:1,windows:Object.fromEntries(Array.from({length:129},(_,i)=>['w'+i,geometry()]))}}]) {
      assert.equal((await request(endpoint,{session:a,method:'PUT',body})).status,422);
    }
  });
  await t.test('save, lost ACK retry, fresh login/reload and another account preserve separate settings',async()=>{
    const saved=await request(endpoint,{session:a,method:'PUT',body:input});assert.equal(saved.status,200,JSON.stringify(saved.data));
    assert.deepEqual(saved.data,{revision:1,gpWindows:windows()});
    assert.deepEqual((await request(endpoint,{session:a,method:'PUT',body:input})).data,saved.data);
    const conflict=await request(endpoint,{session:a,method:'PUT',body:{...input,gpWindows:windows(99)}});
    assert.equal(conflict.status,409);assert.equal(conflict.data.code,'BRANCH_WINDOWS_CONFLICT');
    a=await login('branch-window-a');assert.deepEqual((await request(endpoint,{session:a})).data,saved.data);
    assert.deepEqual((await request(endpoint,{session:b})).data,{revision:0,gpWindows:{version:1,windows:{}}});
    assert.equal((await request(endpoint,{session:b,method:'PUT',body:{revision:0,gpWindows:windows(72)}})).status,200);
    assert.deepEqual((await request(endpoint,{session:a})).data,saved.data);
    const rows=db.prepare("SELECT payload FROM trade_annotations WHERE kind='branch-window-preferences'").all();assert.equal(rows.length,2);
    for(const row of rows){assert.doesNotMatch(row.payload,/price-label-search|\"gpWindows\"|\"610\"/);}
  });
  await t.test('password requirement is rechecked on an existing session',async()=>{
    const changed=await request('/api/portal/v1/organization-accounts/'+idA,{session:admin,method:'PUT',
      body:{...account('branch-window-a'),password:'',mustChangePassword:true}});
    assert.equal(changed.status,200,JSON.stringify(changed.data));
    const result=await request(endpoint,{session:a});assert.ok([401,428].includes(result.status),JSON.stringify(result));
    assert.equal((await request('/api/portal/v1/ui-preferences',{session:b})).status,403);
  });
});
test('actual portal adapter persists branch window position, size and minimization across browser reload',
  {skip:process.env.GP_WINDOW_BROWSER_TEST!=='1',timeout:60000},async()=>{
  await create('branch-window-browser',['branch_articles:read']);
  const session=await login('branch-window-browser');
  const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE || 'playwright');
  const browser=await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{}),args:['--no-first-run']});
  try{
    const context=await browser.newContext(),page=await context.newPage(),requests=[];
    await context.addCookies(session.cookie.split('; ').map(part=>{const split=part.indexOf('=');return{name:part.slice(0,split),value:part.slice(split+1),url};}));
    page.on('request',request=>{if(request.url().includes('window-preferences') || request.url().includes('/ui-preferences'))requests.push({url:request.url(),method:request.method()});});
    await page.goto(url+'/portal.html');
    await page.waitForFunction(()=>portalState.session?.authenticated && portalWindowManager);
    assert.equal(await page.evaluate(()=>typeof window.GrabenplanerTableLayout?.attach),'function');
    await page.evaluate(()=>setTab('branchPriceLabels'));
    await page.waitForFunction(()=>branchPriceLabelsWorkspaceActive);
    await page.evaluate(()=>portalWindowManager.preferences.activate());
    assert.equal(await page.evaluate(()=>portalWindowManager.preferences.ready),true,
      JSON.stringify(await page.evaluate(()=>({active:portalState.activeTab,status:document.getElementById('portalLogoutStatus')?.textContent,identity:portalUser()?.accountType}))));
    const changed=await page.evaluate(value=>portalWindowManager.preferences.change('price-label-search',value),geometry(45));
    assert.equal(changed,true);
    assert.deepEqual((await request(endpoint,{session})).data,{revision:1,gpWindows:windows(45)});
    await page.locator('[data-pl="search"]').click();
    const search=page.locator('.spl-search-window');await search.waitFor({state:'visible'});
    assert.deepEqual(await search.evaluate(node=>({x:parseFloat(node.style.left),y:parseFloat(node.style.top),width:parseFloat(node.style.width),height:parseFloat(node.style.height)})),
      {x:45,y:23,width:610,height:480});
    await page.locator('[data-spl-search-min]').click();
    await page.waitForFunction(()=>portalWindowManager.preferences.value.windows['price-label-search'].minimized);
    // Await the real serialized PUT using a harmless unchanged snapshot.
    assert.equal(await page.evaluate(()=>portalWindowManager.preferences.change('price-label-search',portalWindowManager.preferences.value.windows['price-label-search'])),true);
    await page.reload();await page.waitForFunction(()=>portalState.session?.authenticated && portalWindowManager);
    await page.evaluate(()=>setTab('branchPriceLabels'));await page.waitForFunction(()=>branchPriceLabelsWorkspaceActive);
    await page.evaluate(()=>portalWindowManager.preferences.activate());
    assert.deepEqual(await page.evaluate(()=>portalWindowManager.preferences.value.windows['price-label-search']),geometry(45));
    await page.locator('[data-pl="search"]').click();await search.waitFor({state:'visible'});
    assert.deepEqual(await search.evaluate(node=>({x:parseFloat(node.style.left),y:parseFloat(node.style.top),width:parseFloat(node.style.width),height:parseFloat(node.style.height)})),
      {x:45,y:23,width:610,height:480});
    assert.ok(requests.filter(route=>route.url.endsWith('/branch-window-preferences') && route.method==='GET').length>=2);
    assert.ok(requests.some(route=>route.url.endsWith('/branch-window-preferences') && route.method==='PUT'));
    // The legacy mobile layout loader still tries an employee-only GET and uses
    // its documented fallback. Geometry writes must never use that endpoint.
    assert.ok(!requests.some(route=>route.url.endsWith('/ui-preferences') && route.method==='PUT'));
  }finally{await browser.close();}
});
