'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'gp-price-label-http-'));
Object.assign(process.env,{DB_PATH:path.join(root,'test.db'),BACKUP_DIR:path.join(root,'backups'),GRABENPLANER_DATA_DIR:path.join(root,'data'),GRABENPLANER_HOST:'127.0.0.1',GRABENPLANER_FORCE_PORTAL:'1',GRABENPLANER_SEED_DEMO:'1',GRABENPLANER_INTEGRATION_KEY_ID:'price-label-http',GRABENPLANER_INTEGRATION_KEY:crypto.randomBytes(32).toString('base64'),NODE_ENV:'test'});
const subject=require('../server'),{app,db}=subject;let server,url;const clients={};
test.before(async()=>{
  db.prepare("INSERT OR IGNORE INTO locations(id,name,active) VALUES('93','Testfiliale',1)").run();
  db.prepare("INSERT INTO employees(personnel_number,full_name,nickname,color,contracted_hours,home_location_id,active) VALUES('price-vk','Verkaufsmitarbeiter','VK','#215345',38.5,'93',1)").run();
  db.prepare("INSERT INTO portal_users(employee_number,password_hash,role,active,must_change_password) VALUES('price-vk','synthetic-no-password','employee',1,0)").run();
  for(const permission of ['sales:articles:access','sales:articles:read','sales:articles:prices:read'])db.prepare('INSERT INTO portal_permission_grants(employee_number,permission) VALUES(?,?)').run('price-vk',permission);
  for(const actor of ['employee','branch']){
    const token=crypto.randomBytes(32).toString('hex'),csrf=crypto.randomBytes(24).toString('hex');clients[actor]={Cookie:`grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`,'X-CSRF-Token':csrf};
    if(actor==='employee')db.prepare("INSERT INTO portal_sessions(id,employee_number,token_hash,expires_at) VALUES(?,'price-vk',?,'2099-12-31T00:00:00.000Z')").run(crypto.randomUUID(),crypto.createHash('sha256').update(token).digest('hex'));
    else{
      db.prepare("INSERT INTO portal_organization_accounts(id,login_name,display_name,account_type,password_hash,active,must_change_password) VALUES('price-fil93','fil93','Filialkonto93','branch','synthetic-no-password',1,0)").run();
      db.prepare("INSERT INTO portal_organization_account_permissions(account_id,permission) VALUES('price-fil93','branch_articles:read')").run();
      db.prepare("INSERT INTO portal_organization_account_scopes(account_id,location_id) VALUES('price-fil93','93')").run();
      db.prepare("INSERT INTO portal_organization_sessions(id,account_id,token_hash,expires_at) VALUES(?,'price-fil93',?,'2099-12-31T00:00:00.000Z')").run(crypto.randomUUID(),crypto.createHash('sha256').update(token).digest('hex'));
    }
  }
  await new Promise(resolve=>{server=app.listen(0,'127.0.0.1',resolve);});url='http://127.0.0.1:'+server.address().port;
});
test.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));try{db.close();}catch{}subject.releaseInstanceLockForTests();fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
const request=(actor,route,body,csrf=true)=>fetch(url+route,{method:body?'POST':'GET',headers:{...clients[actor],...(!csrf?{'X-CSRF-Token':''}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
test('real API admits normal salesperson and branch account without scheduling rights, preserving personal catalog boundaries',async()=>{
  for(const actor of ['employee','branch']){
    const response=await request(actor,'/api/sales/price-labels/branding');assert.equal(response.status,200,await response.clone().text());assert.ok((await response.json()).kits.some(row=>row.id==='neutral'));
    const library=await request(actor,'/api/sales/price-labels/library');assert.equal(library.status,200,await library.clone().text());assert.equal((await library.json()).ownBranch.id,'93');
  }
  assert.equal((await request('branch','/api/sales/articles/detail?articleNumber=107014')).status,403);
});
test('real branch defaults save without employee foreign key, require CSRF, and are immediately disabled when branch permission is revoked',async()=>{
  const body={options:{color:'#123456'},filenameOptions:{stamp:'date',position:'after',separator:'_',suffix:''}};
  assert.equal((await request('branch','/api/sales/price-labels/templates',body,false)).status,403);
  const saved=await request('branch','/api/sales/price-labels/templates',body);assert.equal(saved.status,200,await saved.clone().text());
  assert.equal((await (await request('branch','/api/sales/price-labels/templates')).json()).options.color,'#123456');
  assert.equal(db.prepare("SELECT count(*) n FROM portal_user_preferences WHERE employee_number LIKE 'account:%'").get().n,0);
  db.prepare("DELETE FROM portal_organization_account_permissions WHERE account_id='price-fil93' AND permission='branch_articles:read'").run();
  assert.equal((await request('branch','/api/sales/price-labels/branding')).status,403);
});
