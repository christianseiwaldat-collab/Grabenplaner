'use strict';
// Explicit opt-in full-app browser probe; fresh synthetic SQLite data only.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
async function main() {
  const output = path.resolve(process.argv[2] || ''), repo = path.resolve(__dirname, '../..');
  if (!process.argv[2] || !path.isAbsolute(process.argv[2]) || output === repo || output.startsWith(repo + path.sep)) throw new Error('An absolute output directory outside the repository is required.');
  fs.mkdirSync(output, { recursive:true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-security-ui-probe-'));
  for (const name of Object.keys(process.env)) if (name.startsWith('GRABENPLANER_') || ['DB_PROVIDER','DB_PATH','DATABASE_URL','BACKUP_DIR'].includes(name)) delete process.env[name];
  Object.assign(process.env, { DB_PROVIDER:'sqlite', DB_PATH:path.join(temp,'synthetic.db'), BACKUP_DIR:path.join(temp,'backups'), GRABENPLANER_DATA_DIR:path.join(temp,'data'), GRABENPLANER_HOST:'127.0.0.1', GRABENPLANER_FORCE_PORTAL:'1', GRABENPLANER_SEED_DEMO:'1', NODE_ENV:'test', TZ:'Europe/Vienna' });
  let application, server, browser;
  const observations = [], errors = [];
  try {
    application = require('../../server');
    const { app, db, initializeApplicationPersistence } = application;
    await initializeApplicationPersistence();
    const employee = 'audit-ui-synthetic', token = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(24).toString('hex');
    const location = db.prepare('SELECT id,cost_center_id FROM locations LIMIT 1').get();
    db.prepare("INSERT INTO employees(personnel_number,full_name,nickname,color,contracted_hours,target_workdays_per_week,home_location_id,cost_center_id,active) VALUES (?,'Audit Testkonto','Audit','#25705d',38.5,5,?,?,1)").run(employee,location.id,location.cost_center_id);
    db.prepare("INSERT INTO portal_users(employee_number,password_hash,role,active,must_change_password,password_changed_at) VALUES (?,'synthetic','developer',1,0,CURRENT_TIMESTAMP)").run(employee);
    db.prepare("INSERT INTO portal_sessions(id,employee_number,token_hash,expires_at) VALUES (?,?,?,'2099-12-31T23:59:59.000Z')").run(crypto.randomUUID(),employee,crypto.createHash('sha256').update(token).digest('hex'));
    server = app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || 'playwright');
    browser = await chromium.launch({ headless:true, ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath:process.env.GP_BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport:{width:1440,height:1050}, locale:'de-AT', timezoneId:'Europe/Vienna' });
    await context.addCookies([{name:'grabenplaner_session',value:token,url,httpOnly:true,sameSite:'Strict'},{name:'grabenplaner_csrf',value:csrf,url,sameSite:'Strict'}]);
    const page = await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>new URL(route.request().url()).origin===url ? route.continue() : route.abort());
    await page.goto(url,{waitUntil:'networkidle'});
    await page.locator('#privacyOrganizationToggle').click();
    await page.locator('#securityAuditsNavButton').click();
    const host = page.locator('#securityAuditsWorkspaceHost');
    await host.locator('.security-audits-empty').waitFor(); observations.push('Empty authorized register rendered in full GP navigation');
    const report = process.argv[3] ? JSON.parse(fs.readFileSync(path.resolve(process.argv[3]),'utf8')) : require('../security-audit-fixture').syntheticRun();
    await host.locator('[data-sa-action="import"]').click();
    await host.locator('input[type="file"]').setInputFiles({name:'audit-report.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(report))});
    await host.locator('[data-sa-dialog] button[type="submit"]').click();
    await host.locator('[data-sa-dialog]').waitFor({state:'hidden'});
    await host.locator('[data-sa-panel="findings"]').waitFor();
    assert.equal(await host.locator('tbody tr').count(), report.findings.length); observations.push('JSON preview and explicit import saved and rendered expected findings');
    await page.screenshot({path:path.join(output,'security-audits-desktop.png'),fullPage:false});
    await host.locator('.security-audits-run-details summary').click();
    assert.ok((await host.locator('.security-audits-run-details').innerText()).includes('18.10.2026'));
    await host.locator('.security-audits-run-details summary').click(); observations.push('Valid report calendar date shown');
    await host.locator(`[data-sa-action="finding"][data-sa-id="${report.findings[0].id}"]`).click();
    assert.ok((await host.locator('[data-sa-dialog]').innerText()).includes(report.findings[0].title));
    await page.screenshot({path:path.join(output,'security-audits-finding.png'),fullPage:false});
    await host.locator('[data-sa-dialog] [data-gp-window-close]').click();
    await host.locator('[data-sa-dialog]').waitFor({state:'hidden'}); observations.push('Native GP window close control closes details');
    await host.locator(`[data-sa-action="finding"][data-sa-id="${report.findings[0].id}"]`).click();
    await host.locator('[data-sa-action="edit"]').click();
    await host.locator('[name="status"]').selectOption('in_progress');
    await host.locator('[name="owner"]').fill('Synthetic browser reviewer');
    await host.locator('[name="note"]').fill('Synthetic temporary UI verification; no real remediation.');
    let confirmed = false;
    page.once('dialog', async nativeDialog => { confirmed = true; await nativeDialog.dismiss(); });
    await host.locator('[data-sa-dialog] [data-gp-window-close]').click();
    assert.ok(confirmed); assert.equal(await host.locator('[data-sa-dialog]').isVisible(),true);
    assert.equal(await host.locator('[name="note"]').inputValue(),'Synthetic temporary UI verification; no real remediation.');
    observations.push('Native GP close preserves dirty edits when discard is declined');
    await host.locator('[data-sa-dialog] button[type="submit"]').click();
    await host.locator('[data-sa-dialog]').waitFor({state:'hidden'});
    await host.locator(`[data-sa-action="finding"][data-sa-id="${report.findings[0].id}"]`).click();
    assert.ok((await host.locator('[data-sa-dialog]').innerText()).includes('Synthetic temporary UI verification'));
    await page.keyboard.press('Escape'); observations.push('Finding update saved with visible audit history in temporary fixture');
    await host.locator('[data-sa-panel="checks"]').click();
    await host.locator('[data-sa-filter="checkStatus"]').selectOption('failed');
    assert.equal(await host.locator('tbody tr').count(),report.checks.filter(row=>row.status==='failed').length); observations.push('ASVS failed filter uses canonical catalogue');
    await page.screenshot({path:path.join(output,'security-audits-checks.png'),fullPage:false});
    await host.locator('[data-sa-panel="findings"]').click();
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:path.join(output,'security-audits-mobile.png'),fullPage:false});
    const overflow = await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+2);
    if (overflow) fs.writeFileSync(path.join(output,'ui-overflow.json'),JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('#privacyOrganizationView, #privacyOrganizationView *')].map(el=>({tag:el.tagName,id:el.id,cls:typeof el.className==='string'?el.className:'',w:el.getBoundingClientRect().width,x:el.getBoundingClientRect().x,sw:el.scrollWidth,min:getComputedStyle(el).minWidth,display:getComputedStyle(el).display})).filter(el=>el.w>390)),null,2));
    assert.equal(overflow,false,'Page must not overflow mobile viewport'); observations.push('390px mobile layout has no page-level horizontal overflow');
    await page.setViewportSize({width:1440,height:1050});
    const theme = page.locator('#sidebarDarkmodeToggle');
    if (await theme.count()) { await theme.click(); await page.screenshot({path:path.join(output,'security-audits-dark.png'),fullPage:false}); observations.push('Dark theme rendered'); }
    await page.reload({waitUntil:'networkidle'});
    // Navigation may restore the last view; use the visible module parent when required.
    if (!await host.isVisible()) { if (!await page.locator('#securityAuditsNavButton').isVisible()) await page.locator('#privacyOrganizationToggle').click(); await page.locator('#securityAuditsNavButton').click(); }
    await host.locator('[data-sa-panel="findings"]').waitFor(); assert.equal(await host.locator('tbody tr').count(),report.findings.length); observations.push('Encrypted report survives page reload');
    db.prepare('UPDATE portal_users SET must_change_password=1 WHERE employee_number=?').run(employee);
    await host.locator('[data-sa-action="refresh"]').click();
    await page.waitForFunction(()=>!document.querySelector('#securityAuditsWorkspaceHost [data-sa-table]'));
    assert.ok(!(await host.innerText()).includes(report.findings[0].title)); observations.push('Server 428 clears prior confidential report');
    assert.deepEqual(errors,[],'No browser JavaScript errors');
    console.log(JSON.stringify({passed:observations.length,observations,errors},null,2));
  } catch (failure) { if (browser) { const page=browser.contexts()[0]?.pages()[0]; if(page) { await page.screenshot({path:path.join(output,'security-audits-failure.png'),fullPage:false}).catch(()=>{}); fs.writeFileSync(path.join(output,'ui-failure-text.txt'),await page.locator('body').innerText().catch(()=>'')); } } throw failure; }
  finally { await browser?.close(); if(server) await new Promise(resolve=>server.close(resolve)); try{application?.db.close();}catch{} application?.releaseInstanceLockForTests(); assert.equal(path.dirname(temp),os.tmpdir()); assert.ok(path.basename(temp).startsWith('gp-security-ui-probe-')); fs.rmSync(temp,{recursive:true,force:true,maxRetries:8,retryDelay:100}); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
