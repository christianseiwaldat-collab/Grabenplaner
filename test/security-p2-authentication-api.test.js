'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const childProvider = process.env.GP_SECURITY_P2_HTTP_CHILD;
const GOOD_PASSWORD = 'Synthetic-Login-Concurrency-2026!';
const BAD_PASSWORD = 'Synthetic-Wrong-Concurrent-2026!';

if (!childProvider) {
  for (const [provider,mode] of [['sqlite','server'],['postgresql','server'],['sqlite','local'],['sqlite','lan'],['sqlite','production']]) {
    test(`P2 authentication HTTP: ${provider}/${mode} real password verification, account locks and sessions`, {
      skip: provider === 'postgresql' && !process.env.GP_CORE_MIGRATOR_URL,
      timeout: 180000,
    }, async t => {
      const environment = { ...process.env, GP_SECURITY_P2_HTTP_CHILD: provider, GP_SECURITY_P2_OPERATION_MODE: mode };
      delete environment.NODE_TEST_CONTEXT;
      const child = spawn(process.execPath, ['--test', '--test-concurrency=1', __filename], {
        cwd: path.resolve(__dirname, '..'),
        env: environment,
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { output += data; });
      t.after(() => { if (child.exitCode === null) child.kill(); });
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      assert.equal(code, 0, output);
      assert.match(output, /HTTP_P2_VERIFIED/);
      t.diagnostic(output.trim());
    });
  }
} else {
  assert.ok(['sqlite', 'postgresql'].includes(childProvider));
  const gates = new Map();
  const realScrypt = crypto.scrypt;
  // Keep native scrypt and timingSafeEqual intact. Only callback delivery is
  // held, after the real computation, so every request has read its login row.
  crypto.scrypt = function gatedScrypt(password, ...args) {
    const callback = args.pop();
    return realScrypt(password, ...args, (error, key) => {
      const gate = gates.get(String(password));
      if (!gate) return callback(error, key);
      gate.callbacks.push(() => callback(error, key));
      if (gate.callbacks.length === gate.count) gate.ready();
    });
  };
  function barrier(password, count) {
    assert.equal(gates.has(password), false);
    let ready, reject;
    const pending = new Promise((resolve, fail) => { ready = resolve; reject = fail; });
    const gate = { count, callbacks: [], ready };
    const timer = setTimeout(() => reject(new Error(`Only ${gate.callbacks.length}/${count} real scrypt results reached the barrier`)), 15000);
    gates.set(password, gate);
    return {
      pending,
      release() { clearTimeout(timer); gates.delete(password); for (const callback of gate.callbacks.splice(0)) callback(); },
    };
  }

  test(`${childProvider}: HTTP session rotation, policy transition and expiry`, { timeout: 150000 }, async t => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-p2-http-'));
    const configuration = require('../lib/persistence/configuration');
    const originalConfiguration = configuration.resolvePersistenceConfiguration;
    let subject, server, browserProxy;
    const productionConfiguration = process.env.GP_SECURITY_P2_OPERATION_MODE === 'production';
    Object.assign(process.env, {
      NODE_ENV: productionConfiguration ? 'production' : 'test', TZ: 'Europe/Vienna', DB_PROVIDER: 'sqlite', DATABASE_URL: '',
      DB_PATH: path.join(temporaryRoot, 'fixture.db'), BACKUP_DIR: path.join(temporaryRoot, 'backups'),
      GRABENPLANER_DATA_DIR: path.join(temporaryRoot, 'data'), GRABENPLANER_HOST: '127.0.0.1',
      GRABENPLANER_FORCE_PORTAL: productionConfiguration ? '' : '1', GRABENPLANER_SEED_DEMO: productionConfiguration ? '' : '1',
      GRABENPLANER_OPERATION_MODE: productionConfiguration ? 'server' : process.env.GP_SECURITY_P2_OPERATION_MODE || 'server', GRABENPLANER_PUBLIC_URL: 'https://plan.example.test',
      GRABENPLANER_TRUST_PROXY: 'loopback', GRABENPLANER_DEPLOYMENT_KIND: productionConfiguration ? 'production' : 'codespaces-test',
      GRABENPLANER_AMU_KEY_ID: 'synthetic-concurrency', GRABENPLANER_AMU_KEY: Buffer.alloc(32, 71).toString('base64'),
      GRABENPLANER_INTEGRATION_KEY_ID: 'synthetic-migration', GRABENPLANER_INTEGRATION_KEY: Buffer.alloc(32, 78).toString('base64'),
      GRABENPLANER_WIFI_WEBHOOK_SECRET: 'synthetic-concurrency-wifi-secret-2026',
      GRABENPLANER_SERVICE_CONTROL_TOKEN: 'synthetic-concurrency-service-secret-2026',
      GRABENPLANER_TEST_AMU_SCANNER: productionConfiguration ? '' : 'clean',
    });
    async function exercise(fixture) {
      if(childProvider==='sqlite'&&process.env.GP_SECURITY_P2_OPERATION_MODE==='server'&&process.env.GP_SECURITY_AUTH_BROWSER_TEST==='1') {
        // A throwaway certificate and a loopback TLS reverse proxy provide the
        // configured HTTPS origin; no Origin/CSRF guard is disabled or rewritten.
        const key=path.join(temporaryRoot,'browser-key.pem'),cert=path.join(temporaryRoot,'browser-cert.pem');
        const generated=require('node:child_process').spawnSync(process.env.GP_BROWSER_OPENSSL||'openssl',
          ['req','-x509','-newkey','rsa:2048','-nodes','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-days','1','-keyout',key,'-out',cert],
          {windowsHide:true,stdio:'ignore',timeout:15000});
        assert.equal(generated.status,0,'the opt-in live browser requires a local OpenSSL executable');
        browserProxy=require('node:https').createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)});
        await new Promise(resolve=>browserProxy.listen(0,'127.0.0.1',resolve));
        process.env.GRABENPLANER_PUBLIC_URL='https://127.0.0.1:'+browserProxy.address().port;
      }
      if (fixture) {
        configuration.resolvePersistenceConfiguration = () => Object.freeze({
          providerId: 'postgresql', databasePath: path.join(temporaryRoot, 'core.postgresql'), databaseUrlConfigured: true,
          coreUrl: process.env.GP_CORE_APP_URL, salesUrl: process.env.GP_SALES_APP_URL,
          readers: { coreUrl: process.env.GP_CORE_READER_URL, salesUrl: process.env.GP_SALES_READER_URL },
          rehearsal: true, productActivation: false,
        });
      }
      subject = require('../server');
      await subject.initializeApplicationPersistence();
      const query = fixture ? async (sql, values = []) => {
        let parameter = 0;
        return (await fixture.core.migrator.query(sql.replace(/\?/g, () => '$' + (++parameter)), values)).rows;
      } : async (sql, values = []) => /^\s*SELECT\b/i.test(sql)
        ? subject.db.prepare(sql).all(...values) : (subject.db.prepare(sql).run(...values), []);
      if (fixture) await fixture.core.migrator.query('SET ROLE gp_core_owner; SET search_path=pg_catalog,gp');
      await query("UPDATE settings SET value='5' WHERE key='max_failed_login_attempts'");
      server = await new Promise(resolve => { const listener = subject.app.listen(0, '127.0.0.1', () => resolve(listener)); });
      const base = 'http://127.0.0.1:' + server.address().port;
      const salt = Buffer.alloc(16, 81);
      const hash = 'scrypt-v1$' + salt.toString('base64url') + '$' + crypto.scryptSync(GOOD_PASSWORD, salt, 64).toString('base64url');
      const location = (await query('SELECT id FROM locations ORDER BY id LIMIT 1'))[0].id;
      async function seed(id, organization = false) {
        if (organization) {
          await query("INSERT INTO portal_organization_accounts(id,login_name,display_name,account_type,password_hash,active,must_change_password) VALUES(?,?,?,'branch',?,1,0)", [id, id, 'Synthetic concurrency branch', hash]);
          await query('INSERT INTO portal_organization_account_scopes(account_id,location_id) VALUES(?,?)', [id, location]);
        } else {
          await query('INSERT INTO employees(personnel_number,full_name,nickname,home_location_id,active) VALUES(?,?,?,?,1)', [id, 'Synthetic concurrency employee', 'Synthetic', location]);
          await query("INSERT INTO portal_users(employee_number,password_hash,role,active,must_change_password) VALUES(?,?,'employee',1,0)", [id, hash]);
        }
      }
      async function login(id, password, channel, ip, installationId = 'synthetic-' + crypto.randomUUID()) {
        const mobile = channel === 'mobile';
        const response = await fetch(base + (mobile ? '/api/mobile/v1/auth/login' : '/api/portal/v1/auth/login'), {
          method: 'POST', signal: AbortSignal.timeout(30000),
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': ip },
          body: JSON.stringify({ employeeNumber: id, password, ...(mobile ? { device: {
            installationId, platform: 'android', label: 'Synthetic device', appVersion: '1.0.0',
          } } : {}) }),
        });
        return { status: response.status, body: await response.json(), cookies: response.headers.getSetCookie() };
      }
      async function state(id, organization) {
        const table = organization ? 'portal_organization_accounts' : 'portal_users';
        const column = organization ? 'id' : 'employee_number';
        const row = (await query(`SELECT failed_login_attempts,locked_until FROM ${table} WHERE ${column}=?`, [id]))[0];
        return { ...row, failed_login_attempts: Number(row.failed_login_attempts) };
      }
      function credentials(result) {
        return { cookie: result.cookies.map(value => value.split(';')[0]).join('; '),
          csrf: decodeURIComponent(result.cookies.find(value => value.startsWith('grabenplaner_csrf='))?.split(';')[0].slice('grabenplaner_csrf='.length) || '') };
      }
      async function request(route, { auth, method='GET', body, csrf, activity=false, ip='198.51.100.90' } = {}) {
        const response = await fetch(base + route, { method, signal: AbortSignal.timeout(30000), headers: {
          'Content-Type':'application/json','X-Forwarded-Proto':'https','X-Forwarded-For':ip,
          ...(activity?{'X-GP-User-Activity':'1'}:{}),
          ...(auth ? { Cookie:auth.cookie, 'X-CSRF-Token':csrf ?? auth.csrf } : {}) },
          ...(body ? {body:JSON.stringify(body)} : {}) });
        return {status:response.status, body:await response.json(),cookies:response.headers.getSetCookie()};
      }
      const info = auth => request('/api/portal/v1/session',{auth});
      const change = (auth,currentPassword,newPassword,csrf) => request('/api/portal/v1/me/password',{
        method:'PUT',auth,csrf,body:{currentPassword,newPassword}});
      async function mobileRequest(route, { token, body, ip='198.51.100.130' } = {}) {
        const response=await fetch(base+route,{method:body?'POST':'GET',signal:AbortSignal.timeout(30000),headers:{
          'Content-Type':'application/json','X-Forwarded-Proto':'https','X-Forwarded-For':ip,
          ...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
        return {status:response.status,body:await response.json(),cookies:response.headers.getSetCookie()};
      }
      const refresh=(token,installationId)=>mobileRequest('/api/mobile/v1/auth/refresh',{body:{refreshToken:token,
        device:{installationId,platform:'android',label:'Synthetic device',appVersion:'1.0.0'}}});
      const mobileChange=(token,currentPassword,newPassword)=>mobileRequest('/api/mobile/v1/me/password',{token,body:{currentPassword,newPassword}});
      const mobileInfo=token=>mobileRequest('/api/mobile/v1/me/settings',{token});
      const passwordHash = value => 'scrypt-v1$' + salt.toString('base64url') + '$' + crypto.scryptSync(value,salt,64).toString('base64url');
      async function seedPersonal(id,password=GOOD_PASSWORD,role='employee',mustChange=0) {
        await seed(id);
        await query('UPDATE portal_users SET password_hash=?,role=?,must_change_password=? WHERE employee_number=?',[passwordHash(password),role,mustChange,id]);
      }
      async function sessionRow(id) { return (await query('SELECT * FROM portal_sessions WHERE employee_number=? AND revoked_at IS NULL',[id]))[0]; }
      if (process.env.GP_SECURITY_P2_OPERATION_MODE !== 'server') {
        await t.test('local, LAN and production configurations use the same 15-codepoint policy with unchanged legacy verification',async()=>{
          const id='syn-p2-mode'; await seedPersonal(id,'old123');
          const entered=await login(id,'old123','browser','198.51.100.110');assert.equal(entered.status,200,JSON.stringify(entered.body));
          if (productionConfiguration) {
            assert.equal(process.env.NODE_ENV,'production');assert.equal(entered.body.status.deploymentKind,'production');
            assert.equal(entered.body.status.operationMode,'server');assert.equal(entered.body.user.mustChangePassword,true);
          }
          assert.equal(entered.body.status.passwordMinLength,15);const auth=credentials(entered);
          assert.equal((await change(auth,'old123','qV7^pR3&kT8!zN')).status,400);
          const changed=await change(auth,'old123','qV7^pR3&kT8!zNm');assert.equal(changed.status,200,JSON.stringify(changed.body));
          assert.equal((await login(id,'qV7^pR3&kT8!zNm','browser','198.51.100.110')).status,200);
        });
        console.log('HTTP_P2_VERIFIED '+JSON.stringify({provider:childProvider,mode:process.env.GP_SECURITY_P2_OPERATION_MODE,groups:1,syntheticOnly:true}));
        return;
      }
      let completed=0;
      await t.test('legacy personal login is restricted; change rotates cookie+CSRF and preserves absolute origin',async()=>{
        const id='syn-p2-legacy'; await seedPersonal(id,'old123','admin');
        const entered=await login(id,'old123','browser','198.51.100.91'); assert.equal(entered.status,200,JSON.stringify(entered.body));
        assert.equal(entered.body.user.mustChangePassword,true);
        const old=credentials(entered), before=await sessionRow(id);
        assert.equal((await request('/api/portal/v1/me/schedule',{auth:old})).status,428);
        assert.equal((await change(old,'old123','short')).status,400);
        for(const [candidate,code] of [['123456789012345','PORTAL_PASSWORD_COMMON'],['abcdefghijklmnopqrstuvwxyz','PORTAL_PASSWORD_COMPROMISED'],[{},'PORTAL_PASSWORD_TYPE_INVALID']]) {
          const rejected=await change(old,'old123',candidate);assert.equal(rejected.status,400);assert.equal(rejected.body.code,code);
        }
        const changed=await change(old,'old123',GOOD_PASSWORD+'-legacy'); assert.equal(changed.status,200,JSON.stringify(changed.body));
        const fresh=credentials(changed); assert.notEqual(fresh.cookie,old.cookie); assert.notEqual(fresh.csrf,old.csrf);
        assert.equal(changed.body.user.mustChangePassword,false);
        const after=await sessionRow(id); assert.notEqual(after.id,before.id); assert.equal(after.authenticated_at,before.authenticated_at);
        assert.equal(after.absolute_expires_at,before.absolute_expires_at);
        assert.equal((await info(old)).body.authenticated,false); assert.equal((await info(fresh)).body.authenticated,true);
        assert.equal((await change(fresh,GOOD_PASSWORD+'-legacy',GOOD_PASSWORD+'-invalid',old.csrf)).status,403);
        assert.equal((await info(fresh)).cookies.length,0,'ordinary response must not reissue old cookie');
        const record=(await query('SELECT password_policy_version,must_change_password FROM portal_users WHERE employee_number=?',[id]))[0];
        assert.equal(Number(record.password_policy_version),1); assert.equal(Number(record.must_change_password),0); completed++;
      });
      await t.test('suitable legacy passwords qualify, existing forced-change remains, weak organization uses managed reset',async()=>{
        for(const force of [0,1]) { const id='syn-p2-suitable-'+force; await seedPersonal(id,GOOD_PASSWORD,'employee',force);
          const response=await login(id,GOOD_PASSWORD,'browser','198.51.100.'+(93+force)); assert.equal(response.status,200,JSON.stringify(response.body));
          assert.equal(response.body.user.mustChangePassword,Boolean(force));
          assert.equal(Number((await query('SELECT password_policy_version FROM portal_users WHERE employee_number=?',[id]))[0].password_policy_version),1);
        }
        const org='syn-p2-org'; await seed(org,true); await query('UPDATE portal_organization_accounts SET password_hash=? WHERE id=?',[passwordHash('old123'),org]);
        const weak=await login(org,'old123','browser','198.51.100.95'); assert.equal(weak.status,428,JSON.stringify(weak.body));
        assert.equal(weak.body.code,'PORTAL_ORGANIZATION_PASSWORD_POLICY_REQUIRED'); assert.equal(weak.cookies.length,0);
        const manager='syn-p2-reset-manager';await seedPersonal(manager,GOOD_PASSWORD,'developer');
        const managerLogin=await login(manager,GOOD_PASSWORD,'browser','198.51.100.117');assert.equal(managerLogin.status,200);
        const reset=await request('/api/portal/v1/branch-accounts/'+org+'/password',{auth:credentials(managerLogin),method:'PUT',body:{password:GOOD_PASSWORD}});
        assert.equal(reset.status,200,JSON.stringify(reset.body));
        assert.equal((await login(org,GOOD_PASSWORD,'browser','198.51.100.95')).status,200); completed++;
      });
      await t.test('parallel password changes have one winner and invalidate reset links plus all old sessions',async()=>{
        const id='syn-p2-race'; await seedPersonal(id);
        const entered=await login(id,GOOD_PASSWORD,'browser','198.51.100.96'); assert.equal(entered.status,200);
        await query('INSERT INTO portal_password_reset_tokens(id,employee_number,token_hash,email_fingerprint,expires_at) VALUES(?,?,?,?,?)',
          ['syn-reset-race',id,'synthetic-reset-token-hash','synthetic-email-fingerprint',new Date(Date.now()+3600000).toISOString()]);
        const auth=credentials(entered), gate=barrier(GOOD_PASSWORD,2);
        const first=change(auth,GOOD_PASSWORD,GOOD_PASSWORD+'-winner-a'),second=change(auth,GOOD_PASSWORD,GOOD_PASSWORD+'-winner-b');
        try { await gate.pending; gate.release(); const results=await Promise.all([first,second]);
          assert.equal(results.filter(v=>v.status===200).length,1,JSON.stringify(results.map(v=>({status:v.status,body:v.body}))));
          assert.ok(results.filter(v=>v.status!==200).every(v=>[401,403,409].includes(v.status)));
          assert.equal((await info(auth)).body.authenticated,false);
          assert.equal(Number((await query('SELECT COUNT(*) count FROM portal_sessions WHERE employee_number=? AND revoked_at IS NULL',[id]))[0].count),1);
          assert.ok((await query('SELECT revoked_at FROM portal_password_reset_tokens WHERE id=?',['syn-reset-race']))[0].revoked_at);
        } finally {gate.release(); await Promise.allSettled([first,second]);} completed++;
      });
      await t.test('actual administrator reset and self-change serialize both winning orders without overwriting a newer password or forced-change flag',async()=>{
        const manager='syn-p2-admin-race-manager';await seedPersonal(manager,GOOD_PASSWORD,'developer');
        const managerLogin=await login(manager,GOOD_PASSWORD,'browser','198.51.100.118');assert.equal(managerLogin.status,200);
        const managerAuth=credentials(managerLogin);
        for(const adminWins of [true,false]) {
          const id='syn-p2-admin-race-'+Number(adminWins),adminPassword=GOOD_PASSWORD+'-admin-'+Number(adminWins),selfPassword=GOOD_PASSWORD+'-self-'+Number(adminWins);
          await seedPersonal(id);const entered=await login(id,GOOD_PASSWORD,'browser','198.51.100.119');assert.equal(entered.status,200);
          const auth=credentials(entered),resetId='reset-'+id;
          await query('INSERT INTO portal_password_reset_tokens(id,employee_number,token_hash,email_fingerprint,expires_at) VALUES(?,?,?,?,?)',
            [resetId,id,'token-'+id,'synthetic-email-fingerprint',new Date(Date.now()+3600000).toISOString()]);
          const adminReset=()=>request('/api/portal/v1/users/'+id,{method:'PUT',auth:managerAuth,
            body:{role:'employee',active:true,password:adminPassword,mustChangePassword:true}});
          const gate=barrier(adminWins?GOOD_PASSWORD:adminPassword,1);
          const held=adminWins?change(auth,GOOD_PASSWORD,selfPassword):adminReset();
          let winner,loser;
          try {
            await gate.pending;
            winner=adminWins?await adminReset():await change(auth,GOOD_PASSWORD,selfPassword);
            assert.equal(winner.status,200,JSON.stringify(winner.body));gate.release();loser=await held;
            assert.ok([401,403,409].includes(loser.status),JSON.stringify(loser.body));assert.equal(loser.cookies.length,0);
            const stored=(await query('SELECT password_hash,must_change_password,password_policy_version FROM portal_users WHERE employee_number=?',[id]))[0];
            const winningPassword=adminWins?adminPassword:selfPassword;
            assert.equal(await subject.verifyPortalPassword(winningPassword,stored.password_hash),true);
            assert.equal(await subject.verifyPortalPassword(adminWins?selfPassword:adminPassword,stored.password_hash),false);
            assert.equal(Number(stored.must_change_password),Number(adminWins));assert.equal(Number(stored.password_policy_version),1);
            assert.ok((await query('SELECT revoked_at FROM portal_password_reset_tokens WHERE id=?',[resetId]))[0].revoked_at);
            assert.equal((await info(auth)).body.authenticated,false);
            const active=Number((await query('SELECT COUNT(*) count FROM portal_sessions WHERE employee_number=? AND revoked_at IS NULL',[id]))[0].count);
            assert.equal(active,adminWins?0:1);
            if(!adminWins)assert.equal((await info(credentials(winner))).body.authenticated,true);
            const relogin=await login(id,winningPassword,'browser','198.51.100.119');assert.equal(relogin.status,200,JSON.stringify(relogin.body));
            assert.equal(relogin.body.user.mustChangePassword,adminWins);
          } finally {gate.release();await Promise.allSettled([held]);}
        }
        completed++;
      });
      await t.test('password verification cannot resurrect a session revoked while scrypt is running',async()=>{
        const id='syn-p2-revoked'; await seedPersonal(id); const entered=await login(id,GOOD_PASSWORD,'browser','198.51.100.97');
        const auth=credentials(entered),gate=barrier(GOOD_PASSWORD,1),pending=change(auth,GOOD_PASSWORD,GOOD_PASSWORD+'-forbidden');
        try {await gate.pending;await query("UPDATE portal_sessions SET revoked_at=? WHERE employee_number=?",[new Date().toISOString(),id]);gate.release();
          const result=await pending;assert.ok([401,403].includes(result.status),JSON.stringify(result.body));
          assert.equal((await query('SELECT password_hash FROM portal_users WHERE employee_number=?',[id]))[0].password_hash,hash);
          assert.equal(result.cookies.length,0);
        }finally{gate.release();await Promise.allSettled([pending]);} completed++;
      });
      await t.test('absolute deadline, idle deadline, malformed and future origins fail closed on real HTTP',async()=>{
        for(const [index,scenario] of ['absolute','idle','malformed','future','privileged-idle'].entries()) {
          const id='syn-p2-time-'+index;await seedPersonal(id,GOOD_PASSWORD,scenario==='privileged-idle'?'admin':'employee');
          const entered=await login(id,GOOD_PASSWORD,'browser','198.51.100.'+(100+index));assert.equal(entered.status,200,JSON.stringify(entered.body));
          const auth=credentials(entered),now=Date.now(),past=new Date(now-1000).toISOString(),future=new Date(now+3600000).toISOString();
          if(scenario==='absolute')await query('UPDATE portal_sessions SET absolute_expires_at=?,expires_at=? WHERE employee_number=?',[past,future,id]);
          if(scenario==='idle')await query('UPDATE portal_sessions SET expires_at=? WHERE employee_number=?',[past,id]);
          if(scenario==='malformed')await query('UPDATE portal_sessions SET authenticated_at=? WHERE employee_number=?',['invalid',id]);
          if(scenario==='future')await query('UPDATE portal_sessions SET authenticated_at=? WHERE employee_number=?',[future,id]);
          if(scenario==='privileged-idle')await query('UPDATE portal_sessions SET authenticated_at=?,last_seen_at=?,expires_at=? WHERE employee_number=?',[new Date(now-3600000).toISOString(),new Date(now-1800000).toISOString(),future,id]);
          assert.equal((await info(auth)).body.authenticated,false,scenario);assert.equal((await change(auth,GOOD_PASSWORD,GOOD_PASSWORD+'-denied')).status,401,scenario);
        } completed++;
      });
      await t.test('polling does not renew idle; active requests never move absolute deadline; deactivation rejects session',async()=>{
        const id='syn-p2-touch';await seedPersonal(id);const entered=await login(id,GOOD_PASSWORD,'browser','198.51.100.107');const auth=credentials(entered);
        const now=Date.now(),absolute=new Date(now+240000).toISOString(),idle=new Date(now+90000).toISOString();
        await query('UPDATE portal_sessions SET expires_at=?,absolute_expires_at=? WHERE employee_number=?',[idle,absolute,id]);
        assert.equal((await info(auth)).body.authenticated,true); assert.equal((await sessionRow(id)).expires_at,idle);
        await request('/api/portal/v1/me/schedule',{auth});assert.equal((await sessionRow(id)).expires_at,idle,'background reads do not renew');
        await request('/api/portal/v1/me/schedule',{auth,activity:true}); const after=await sessionRow(id);assert.equal(after.absolute_expires_at,absolute);assert.equal(after.expires_at,absolute);
        await query('UPDATE portal_users SET active=0 WHERE employee_number=?',[id]);assert.equal((await info(auth)).body.authenticated,false);completed++;
      });
      await t.test('Unicode code points and exact raw spaces survive password set and subsequent login',async()=>{
        const id='syn-p2-unicode';await seedPersonal(id);const entered=await login(id,GOOD_PASSWORD,'browser','198.51.100.108');const auth=credentials(entered);
        assert.equal((await change(auth,GOOD_PASSWORD,'🦉'.repeat(14))).status,400);
        const exact='  '+ '🦉🌲🫧🛶🪶'.repeat(13)+'  ';
        const changed=await change(auth,GOOD_PASSWORD,exact);assert.equal(changed.status,200,JSON.stringify(changed.body));
        assert.equal((await login(id,exact.trim(),'browser','198.51.100.108')).status,401);
        assert.equal((await login(id,exact,'browser','198.51.100.108')).status,200);completed++;
      });
      await t.test('mobile legacy transition rotates access and refresh under the same database authorization guard',async()=>{
        const id='syn-p2-mobile';await seedPersonal(id,'old123');
        const entered=await login(id,'old123','mobile','198.51.100.109');assert.equal(entered.status,201,JSON.stringify(entered.body));
        const before=entered.body.tokenSet;assert.ok(before.accessToken);
        async function mobile(route,token,body){const response=await fetch(base+route,{method:body?'POST':'GET',headers:{
          'Content-Type':'application/json','X-Forwarded-Proto':'https','X-Forwarded-For':'198.51.100.109',Authorization:'Bearer '+token},
          ...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,body:await response.json()};}
        const changed=await mobile('/api/mobile/v1/me/password',before.accessToken,{currentPassword:'old123',newPassword:GOOD_PASSWORD+'-mobile'});
        assert.equal(changed.status,200,JSON.stringify(changed.body));const after=changed.body.tokenSet;
        assert.notEqual(after.accessToken,before.accessToken);assert.notEqual(after.refreshToken,before.refreshToken);
        assert.ok(Number.isFinite(Date.parse(before.refreshTokenExpiresAt)));
        assert.equal(after.refreshTokenExpiresAt,before.refreshTokenExpiresAt);
        assert.equal((await mobile('/api/mobile/v1/me/settings',before.accessToken)).status,401);
        assert.equal((await mobile('/api/mobile/v1/me/settings',after.accessToken)).status,200);
        await query('UPDATE mobile_sessions SET refresh_expires_at=?,access_expires_at=? WHERE employee_number=?',
          [new Date(Date.now()-1000).toISOString(),new Date(Date.now()+3600000).toISOString(),id]);
        assert.equal((await mobile('/api/mobile/v1/me/settings',after.accessToken)).status,401);completed++;
      });
      await t.test('personal and organization names are checked during legacy qualification; privilege grants cap initial lifetime',async()=>{
        const personal='syn-p2-context',name='Synthetic Context Identity';await seedPersonal(personal,name);
        await query('UPDATE employees SET full_name=? WHERE personnel_number=?',[name,personal]);
        const entered=await login(personal,name,'browser','198.51.100.111');assert.equal(entered.status,200,JSON.stringify(entered.body));
        assert.equal(entered.body.user.mustChangePassword,true);
        const org='syn-p2-context-org';await seed(org,true);await query('UPDATE portal_organization_accounts SET display_name=?,password_hash=? WHERE id=?',[name,passwordHash(name),org]);
        assert.equal((await login(org,name,'browser','198.51.100.112')).status,428);
        const granted='syn-p2-privilege-grant';await seedPersonal(granted);
        await query("INSERT INTO portal_permission_grants(employee_number,permission) VALUES(?,'settings:write')",[granted]);
        const privileged=await login(granted,GOOD_PASSWORD,'browser','198.51.100.113');assert.equal(privileged.status,200,JSON.stringify(privileged.body));
        const row=await sessionRow(granted);assert.equal(Date.parse(row.absolute_expires_at)-Date.parse(row.authenticated_at),8*3600000);
        assert.equal(Date.parse(row.expires_at)-Date.parse(row.authenticated_at),30*60000);completed++;
      });
      await t.test('reset link completes with logged-in foreign browser and commits audit, revocations and policy together',async()=>{
        const id='syn-p2-reset-target',foreign='syn-p2-reset-foreign';await seedPersonal(id);await seedPersonal(foreign);
        const entered=await login(foreign,GOOD_PASSWORD,'browser','198.51.100.114');assert.equal(entered.status,200);
        const auth=credentials(entered),token=crypto.randomBytes(32).toString('base64url'),fingerprint='synthetic-reset-email';
        await query('INSERT INTO personal_notification_contacts(employee_number,email_target_fingerprint,email_verified_at) VALUES(?,?,?)',[id,fingerprint,new Date().toISOString()]);
        await query('INSERT INTO portal_password_reset_tokens(id,employee_number,token_hash,email_fingerprint,expires_at) VALUES(?,?,?,?,?)',
          ['syn-p2-reset',id,crypto.createHash('sha256').update(token).digest('hex'),fingerprint,new Date(Date.now()+3600000).toISOString()]);
        const reset=await request('/api/portal/v1/auth/password-reset/confirm',{method:'POST',auth,ip:'198.51.100.114',
          body:{token,newPassword:GOOD_PASSWORD+'-reset',repeatPassword:GOOD_PASSWORD+'-reset'}});
        assert.equal(reset.status,200,JSON.stringify(reset.body));assert.equal((await info(auth)).body.authenticated,false);
        assert.equal(Number((await query('SELECT password_policy_version FROM portal_users WHERE employee_number=?',[id]))[0].password_policy_version),1);
        assert.equal((await login(id,GOOD_PASSWORD+'-reset','browser','198.51.100.115')).status,200);
        const replay=await request('/api/portal/v1/auth/password-reset/confirm',{method:'POST',ip:'198.51.100.116',
          body:{token,newPassword:GOOD_PASSWORD+'-reset-again',repeatPassword:GOOD_PASSWORD+'-reset-again'}});
        assert.equal(replay.status,410);completed++;
      });
      await t.test('real logout and refresh requests cannot resurrect an in-flight password change or a revoked credential',async()=>{
        const id='syn-p2-logout-race';await seedPersonal(id);
        const browser=await login(id,GOOD_PASSWORD,'browser','198.51.100.131');assert.equal(browser.status,200);
        const auth=credentials(browser),gate=barrier(GOOD_PASSWORD,1),pending=change(auth,GOOD_PASSWORD,GOOD_PASSWORD+'-logout-loser');
        try {
          await gate.pending;
          const logout=await request('/api/portal/v1/auth/logout',{auth,method:'POST',body:{}});assert.equal(logout.status,200,JSON.stringify(logout.body));
          gate.release();const rejected=await pending;assert.ok([401,403,409].includes(rejected.status),JSON.stringify(rejected.body));
          assert.equal(rejected.cookies.length,0);assert.equal((await info(auth)).body.authenticated,false);
          assert.equal((await query('SELECT password_hash FROM portal_users WHERE employee_number=?',[id]))[0].password_hash,hash);
        } finally {gate.release();await Promise.allSettled([pending]);}
        const refreshId='syn-p2-refresh-race',device='synthetic-refresh-password-race';await seedPersonal(refreshId);
        const entered=await login(refreshId,GOOD_PASSWORD,'mobile','198.51.100.132',device);assert.equal(entered.status,201);
        const old=entered.body.tokenSet,mobileGate=barrier(GOOD_PASSWORD,1),held=mobileChange(old.accessToken,GOOD_PASSWORD,GOOD_PASSWORD+'-refresh-loser');
        let current;
        try {
          await mobileGate.pending;const rotated=await refresh(old.refreshToken,device);assert.equal(rotated.status,200,JSON.stringify(rotated.body));current=rotated.body.tokenSet;
          mobileGate.release();const rejected=await held;assert.ok([401,403,409].includes(rejected.status),JSON.stringify(rejected.body));
          assert.equal(rejected.body.tokenSet,undefined);assert.equal(rejected.cookies.length,0);
          assert.equal((await query('SELECT password_hash FROM portal_users WHERE employee_number=?',[refreshId]))[0].password_hash,hash);
          assert.equal((await mobileInfo(old.accessToken)).status,401);assert.equal((await mobileInfo(current.accessToken)).status,200);
        } finally {mobileGate.release();await Promise.allSettled([held]);}
        // A browser change that started before a mobile refresh must revoke the
        // refreshed credential as well; the original family cannot return later.
        const browserAgain=await login(refreshId,GOOD_PASSWORD,'browser','198.51.100.133');assert.equal(browserAgain.status,200);
        const browserGate=barrier(GOOD_PASSWORD,1),browserChange=change(credentials(browserAgain),GOOD_PASSWORD,GOOD_PASSWORD+'-refresh-winner');
        try {
          await browserGate.pending;const rotated=await refresh(current.refreshToken,device);assert.equal(rotated.status,200,JSON.stringify(rotated.body));
          browserGate.release();const changed=await browserChange;assert.equal(changed.status,200,JSON.stringify(changed.body));
          assert.equal((await mobileInfo(rotated.body.tokenSet.accessToken)).status,401);
          assert.equal((await refresh(rotated.body.tokenSet.refreshToken,device)).status,401);
          assert.equal((await info(credentials(changed))).body.authenticated,true);
        } finally {browserGate.release();await Promise.allSettled([browserChange]);}
        assert.equal((await state(refreshId,false)).failed_login_attempts,0);completed++;
      });
      await t.test('parallel real HTTP refresh has one winner and replay revokes the entire token family',async()=>{
        const id='syn-p2-parallel-refresh',device='synthetic-parallel-refresh';await seedPersonal(id);
        const entered=await login(id,GOOD_PASSWORD,'mobile','198.51.100.134',device);assert.equal(entered.status,201);
        const original=entered.body.tokenSet;
        const results=await Promise.all([refresh(original.refreshToken,device),refresh(original.refreshToken,device)]);
        assert.equal(results.filter(r=>r.status===200).length,1,JSON.stringify(results));
        const winner=results.find(r=>r.status===200),loser=results.find(r=>r.status!==200);
        assert.equal(loser.status,401,JSON.stringify(loser.body));assert.equal(loser.body.tokenSet,undefined);
        assert.equal(winner.body.tokenSet.refreshTokenExpiresAt,original.refreshTokenExpiresAt);
        const replay=await refresh(original.refreshToken,device);assert.equal(replay.status,401);
        assert.equal((await mobileInfo(original.accessToken)).status,401);
        assert.equal((await mobileInfo(winner.body.tokenSet.accessToken)).status,401);
        assert.equal((await refresh(winner.body.tokenSet.refreshToken,device)).status,401);
        assert.equal(Number((await query('SELECT COUNT(*) count FROM mobile_sessions WHERE employee_number=? AND revoked_at IS NULL',[id]))[0].count),0);completed++;
      });
      await t.test('real audit and deferred-commit failures roll back browser and mobile password changes without emitting credentials',async()=>{
        const ddl=sql=>fixture?fixture.core.migrator.query(sql):subject.db.exec(sql);
        const schema=fixture?'gp.':'';
        for(const channel of ['browser','mobile'])for(const stage of ['audit','commit']) {
          const id='syn-p2-fault-'+channel+'-'+stage,action=channel==='browser'?'portal.password.change':'mobile.password.change';
          await seedPersonal(id,GOOD_PASSWORD,'employee',1);
          const entered=await login(id,GOOD_PASSWORD,channel,'198.51.100.135');assert.equal(entered.status,channel==='browser'?200:201);
          const resetId='reset-'+id;await query('INSERT INTO portal_password_reset_tokens(id,employee_number,token_hash,email_fingerprint,expires_at) VALUES(?,?,?,?,?)',
            [resetId,id,'token-'+id,'synthetic-email-fingerprint',new Date(Date.now()+3600000).toISOString()]);
          const snapshot=async()=>({
            user:(await query('SELECT password_hash,password_policy_version,must_change_password,failed_login_attempts,locked_until FROM portal_users WHERE employee_number=?',[id]))[0],
            browser:await query('SELECT id,token_hash,revoked_at FROM portal_sessions WHERE employee_number=? ORDER BY id',[id]),
            mobile:await query('SELECT id,access_token_hash,refresh_token_hash,refresh_expires_at,revoked_at,revoked_reason FROM mobile_sessions WHERE employee_number=? ORDER BY id',[id]),
            reset:await query('SELECT id,used_at,revoked_at FROM portal_password_reset_tokens WHERE id=?',[resetId]),
            audit:await query('SELECT id FROM audit_log WHERE actor=? AND action=? ORDER BY id',[id,action]),
          });
          const before=await snapshot();
          // The commit case inserts a real deferred FK violation during the audit
          // insert. All statements succeed until the production provider COMMIT.
          try {
            if(stage==='commit') {
              await ddl(`CREATE TABLE ${schema}gp_p2_fault_parent(id INTEGER PRIMARY KEY)`);
              await ddl(`CREATE TABLE ${schema}gp_p2_fault_child(id INTEGER REFERENCES ${schema}gp_p2_fault_parent(id) DEFERRABLE INITIALLY DEFERRED)`);
              if(fixture)await ddl('GRANT INSERT ON gp.gp_p2_fault_child TO gp_core_app');
              else assert.equal(Number(subject.db.prepare('PRAGMA foreign_keys').get().foreign_keys),1);
            }
            if(fixture) {
              await ddl(`CREATE FUNCTION gp.gp_p2_fault_audit() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN IF NEW.actor='${id}' AND NEW.action='${action}' THEN ${stage==='audit'?"RAISE EXCEPTION 'synthetic P2 audit failure';":'INSERT INTO gp.gp_p2_fault_child(id) VALUES(991);'} END IF; RETURN NEW; END $body$`);
              await ddl('CREATE TRIGGER gp_p2_fault_audit BEFORE INSERT ON gp.audit_log FOR EACH ROW EXECUTE FUNCTION gp.gp_p2_fault_audit()');
            } else await ddl(`CREATE TRIGGER gp_p2_fault_audit BEFORE INSERT ON audit_log WHEN NEW.actor='${id}' AND NEW.action='${action}' BEGIN ${stage==='audit'?"SELECT RAISE(ABORT,'synthetic P2 audit failure');":'INSERT INTO gp_p2_fault_child(id) VALUES(991);'} END`);
            const rejected=channel==='browser'?await change(credentials(entered),GOOD_PASSWORD,GOOD_PASSWORD+'-not-committed')
              :await mobileChange(entered.body.tokenSet.accessToken,GOOD_PASSWORD,GOOD_PASSWORD+'-not-committed');
            assert.ok(rejected.status>=400,JSON.stringify(rejected.body));assert.equal(rejected.cookies.length,0);
            assert.equal(rejected.body.tokenSet,undefined);assert.equal(rejected.body.sessionChanged,undefined);
            assert.deepEqual(await snapshot(),before,channel+'/'+stage);
            if(stage==='commit')assert.equal(Number((await query(`SELECT COUNT(*) count FROM ${schema}gp_p2_fault_child`))[0].count),0);
          } finally {
            await ddl(`DROP TRIGGER IF EXISTS gp_p2_fault_audit${fixture?' ON gp.audit_log':''}`);
            if(fixture)await ddl('DROP FUNCTION IF EXISTS gp.gp_p2_fault_audit()');
            if(stage==='commit') {await ddl(`DROP TABLE IF EXISTS ${schema}gp_p2_fault_child`);await ddl(`DROP TABLE IF EXISTS ${schema}gp_p2_fault_parent`);}
          }
          const succeeded=channel==='browser'?await change(credentials(entered),GOOD_PASSWORD,GOOD_PASSWORD+'-after-rollback')
            :await mobileChange(entered.body.tokenSet.accessToken,GOOD_PASSWORD,GOOD_PASSWORD+'-after-rollback');
          assert.equal(succeeded.status,200,JSON.stringify(succeeded.body));
        }
        completed++;
      });
      await t.test('administrative reactivation and managed terminal reset require fresh credentials and provide a path without reset email',async()=>{
        const manager='syn-p2-lifecycle-manager';await seedPersonal(manager,GOOD_PASSWORD,'developer');
        const managerLogin=await login(manager,GOOD_PASSWORD,'browser','198.51.100.136');assert.equal(managerLogin.status,200);const managerAuth=credentials(managerLogin);
        const id='syn-p2-lifecycle';await seedPersonal(id,'old123');
        const entered=await login(id,'old123','browser','198.51.100.137'),mobile=await login(id,'old123','mobile','198.51.100.138');
        assert.equal(entered.status,200);assert.equal(mobile.status,201);const auth=credentials(entered);
        assert.equal(Number((await query('SELECT COUNT(*) count FROM personal_notification_contacts WHERE employee_number=?',[id]))[0].count),0);
        const update=body=>request('/api/portal/v1/users/'+id,{auth:managerAuth,method:'PUT',body:{role:'employee',...body}});
        const disabled=await update({active:false});assert.equal(disabled.status,200,JSON.stringify(disabled.body));
        assert.equal((await info(auth)).body.authenticated,false);assert.equal((await mobileInfo(mobile.body.tokenSet.accessToken)).status,401);
        assert.equal((await login(id,'old123','browser','198.51.100.137')).status,401);
        const restored=await update({active:true,password:GOOD_PASSWORD+'-reactivated',mustChangePassword:true});assert.equal(restored.status,200,JSON.stringify(restored.body));
        assert.equal((await info(auth)).body.authenticated,false);assert.equal((await mobileInfo(mobile.body.tokenSet.accessToken)).status,401);
        assert.equal((await login(id,'old123','browser','198.51.100.137')).status,401);
        const fresh=await login(id,GOOD_PASSWORD+'-reactivated','browser','198.51.100.137');assert.equal(fresh.status,200);assert.equal(fresh.body.user.mustChangePassword,true);
        const changed=await change(credentials(fresh),GOOD_PASSWORD+'-reactivated',GOOD_PASSWORD+'-reactivation-final');assert.equal(changed.status,200,JSON.stringify(changed.body));
        assert.equal(changed.body.user.mustChangePassword,false);
        const terminal='syn-p2-terminal';await seed(terminal,true);await query("UPDATE portal_organization_accounts SET account_type='terminal',password_hash=? WHERE id=?",[passwordHash('old123'),terminal]);
        const weak=await login(terminal,'old123','browser','198.51.100.139');assert.equal(weak.status,428);assert.equal(weak.body.code,'PORTAL_ORGANIZATION_PASSWORD_POLICY_REQUIRED');assert.equal(weak.cookies.length,0);
        const catalogue=await request('/api/portal/v1/organization-accounts',{auth:managerAuth});assert.equal(catalogue.status,200);
        const permitted=catalogue.body.permissionCatalog.find(item=>!Array.isArray(item.accountTypes)||item.accountTypes.includes('terminal'));assert.ok(permitted);
        const terminalUpdate=body=>request('/api/portal/v1/organization-accounts/'+terminal,{auth:managerAuth,method:'PUT',body:{
          displayName:'Synthetic supervised terminal',accountType:'terminal',permissions:[permitted.id],scopes:[{locationId:location}],active:true,...body}});
        const reset=await terminalUpdate({password:GOOD_PASSWORD+'-terminal'});assert.equal(reset.status,200,JSON.stringify(reset.body));
        const terminalLogin=await login(terminal,GOOD_PASSWORD+'-terminal','browser','198.51.100.139');assert.equal(terminalLogin.status,200,JSON.stringify(terminalLogin.body));
        assert.equal(terminalLogin.body.user.mustChangePassword,false);const terminalAuth=credentials(terminalLogin);
        const forbidden=await change(terminalAuth,GOOD_PASSWORD+'-terminal',GOOD_PASSWORD+'-terminal-self');assert.equal(forbidden.status,403);
        assert.equal(forbidden.body.code,'PORTAL_ORGANIZATION_PASSWORD_MANAGED');
        assert.equal((await terminalUpdate({active:false})).status,200);assert.equal((await info(terminalAuth)).body.authenticated,false);
        assert.equal((await terminalUpdate({active:true})).status,200);assert.equal((await info(terminalAuth)).body.authenticated,false);
        assert.equal((await login(terminal,GOOD_PASSWORD+'-terminal','browser','198.51.100.139')).status,200);
        const lastAdmin='syn-p2-last-admin';await seedPersonal(lastAdmin,GOOD_PASSWORD,'admin');
        const owners=await query("SELECT employee_number,active FROM portal_users WHERE role IN ('admin','developer') AND employee_number<>?",[lastAdmin]);
        try {
          await query("UPDATE portal_users SET active=0 WHERE role IN ('admin','developer') AND employee_number<>?",[lastAdmin]);
          const lastLogin=await login(lastAdmin,GOOD_PASSWORD,'browser','198.51.100.141');assert.equal(lastLogin.status,200);
          const denied=await request('/api/portal/v1/users/'+lastAdmin,{auth:credentials(lastLogin),method:'PUT',body:{role:'admin',active:false}});
          assert.equal(denied.status,409,JSON.stringify(denied.body));assert.match(denied.body.error,/Mindestens ein aktiver/);
          assert.equal(Number((await query('SELECT active FROM portal_users WHERE employee_number=?',[lastAdmin]))[0].active),1);
        }finally{for(const owner of owners)await query('UPDATE portal_users SET active=? WHERE employee_number=?',[owner.active,owner.employee_number]);}
        completed++;
      });
      await t.test('live Chrome uses the real legacy personal/admin flow and keeps a newer login after a delayed password response',{
        skip:childProvider!=='sqlite'||process.env.GP_SECURITY_AUTH_BROWSER_TEST!=='1',timeout:90000,
      },async()=>{
        const http=require('node:http'),{chromium}=require(process.env.GP_BROWSER_TEST_MODULE||'playwright');
        let heldResponse=null, loginRequests=0, passwordRequests=0;
        const proxy=browserProxy;assert.ok(proxy);
        proxy.on('request',(incoming,outgoing)=>{
          if(incoming.url==='/api/portal/v1/auth/login'&&incoming.method==='POST')loginRequests++;
          if(incoming.url==='/api/portal/v1/me/password'&&incoming.method==='PUT')passwordRequests++;
          const upstream=http.request({hostname:'127.0.0.1',port:server.address().port,path:incoming.url,method:incoming.method,
            headers:{...incoming.headers,'x-forwarded-proto':'https','x-forwarded-for':'198.51.100.140'}},response=>{
            const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{
              let sent=false;
              const send=()=>{if(sent||outgoing.destroyed)return;sent=true;outgoing.writeHead(response.statusCode,response.headers);outgoing.end(Buffer.concat(chunks));};
              if(heldResponse&&incoming.url===(heldResponse.route||'/api/portal/v1/me/password')&&incoming.method===(heldResponse.method||'PUT')){
                const held=heldResponse;heldResponse=null;held.release=send;held.ready(response.statusCode);
                outgoing.once('close',()=>held.closed?.());
              } else send();
            });
          });upstream.on('error',()=>{outgoing.writeHead(502);outgoing.end();});incoming.pipe(upstream);
        });
        const origin=process.env.GRABENPLANER_PUBLIC_URL;
        const browser=await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{})});
        let releaseDelayed=()=>{};
        try {
          async function contextFor(mode='web',suppressBroadcast=false) {
            const context=await browser.newContext({ignoreHTTPSErrors:true});
            if(suppressBroadcast)await context.addInitScript(()=>Object.defineProperty(BroadcastChannel.prototype,'onmessage',{configurable:true,set(){},get(){return null;}}));
            if(mode!=='web')await context.addInitScript(mode=>{
              Object.defineProperty(Navigator.prototype,'locks',{configurable:true,get:()=>undefined});
              if(mode==='blocked')Object.defineProperty(window,'indexedDB',{configurable:true,get:()=>({open(){throw new DOMException('synthetic blocked storage','SecurityError');}})});
              else {
                const transaction=IDBDatabase.prototype.transaction;
                IDBDatabase.prototype.transaction=function(...args){const value=transaction.apply(this,args);if(args[0]==='exclusive')window.__syntheticCredentialTransaction=value;return value;};
              }
            },mode);
            await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
            return context;
          }
          async function formLogin(page,id,password,navigate=true) {
            if(navigate)await page.goto(origin+'/portal.html',{waitUntil:'domcontentloaded'});
            await page.locator('#loginPersonnelNumber').fill(id);await page.locator('#loginPassword').fill(password);
            const response=page.waitForResponse(r=>r.url().endsWith('/api/portal/v1/auth/login')&&r.request().method()==='POST');
            await page.locator('#portalLoginForm button[type=submit]').click();await page.evaluate(()=>{window.__syntheticLoginSubmitted=true;});
            const result=await response;assert.equal(result.status(),200,await result.text());
          }
          async function formPassword(page,current,next) {
            await page.locator('#passwordDialog').waitFor({state:'visible'});
            await page.locator('#currentPassword').fill(current);await page.locator('#newPassword').fill(next);await page.locator('#repeatPassword').fill(next);
            await page.locator('#passwordForm button[type=submit]').click();
          }
          for(const role of ['employee','admin']) {
            const id='syn-p2-live-'+role;await seedPersonal(id,'old123',role);const context=await contextFor(),page=await context.newPage();
            try {
              await formLogin(page,id,'old123');await page.locator('#passwordDialog').waitFor({state:'visible'});
              const oldCookies=await context.cookies(origin),old={cookie:oldCookies.map(c=>c.name+'='+c.value).join('; ')};
              const changed=page.waitForResponse(r=>r.url().endsWith('/api/portal/v1/me/password')&&r.request().method()==='PUT');
              await formPassword(page,'old123',GOOD_PASSWORD+'-live-'+role);assert.equal((await changed).status(),200);
              await page.locator('#passwordDialog').waitFor({state:'hidden'});
              const session=await page.evaluate(()=>fetch('/api/portal/v1/session').then(r=>r.json()));
              assert.equal(session.authenticated,true);assert.equal(session.user.employeeNumber,id);assert.equal(session.user.mustChangePassword,false);
              assert.equal((await info(old)).body.authenticated,false);
              console.log('HTTP_P2_LIVE_BROWSER_LEGACY_VERIFIED '+JSON.stringify({role,syntheticOnly:true}));
            }finally{await context.close();}
          }
          for(const mode of ['web','idb','idb-abort']) {
            const first='syn-p2-live-delayed-'+mode,second='syn-p2-live-newer-'+mode;await seedPersonal(first,'old123');await seedPersonal(second);
            const context=await contextFor(mode),page=await context.newPage();
            try {
              await formLogin(page,first,'old123');
              let ready,closed;const committed=new Promise(resolve=>{ready=resolve;}),cancelled=new Promise(resolve=>{closed=resolve;});
              const held={ready,closed};heldResponse=held;
              const changed=mode==='idb-abort'?page.waitForEvent('requestfailed',{predicate:r=>r.url().endsWith('/api/portal/v1/me/password')})
                :page.waitForResponse(r=>r.url().endsWith('/api/portal/v1/me/password')&&r.request().method()==='PUT');
              await formPassword(page,'old123',GOOD_PASSWORD+'-delayed-'+mode);
              assert.equal(await committed,200);releaseDelayed=()=>held.release?.();
              const secondPage=await context.newPage();
              if(mode==='idb-abort') {
                await page.evaluate(()=>window.__syntheticCredentialTransaction.abort());
                await changed;await cancelled; // Confirm native fetch cancellation before the next login.
                await formLogin(secondPage,second,GOOD_PASSWORD);held.release();
              } else {
                const before=loginRequests,pendingLogin=formLogin(secondPage,second,GOOD_PASSWORD);
                await secondPage.waitForFunction(()=>window.__syntheticLoginSubmitted===true);
                await secondPage.waitForTimeout(100);
                assert.equal(loginRequests,before,'a queued second login must not reach the server before the password response is adopted');
                held.release();await changed;await pendingLogin;
              }
              const after=await secondPage.evaluate(()=>fetch('/api/portal/v1/session').then(r=>r.json()));
              assert.equal(after.user?.employeeNumber,second,'a delayed password response must not replace the newer account cookie');
              await secondPage.waitForFunction(id=>portalState.session?.user?.employeeNumber===id,second);
              const stored=await secondPage.evaluate(async()=>{
                const database=await new Promise((resolve,reject)=>{const request=indexedDB.open('grabenplaner-credentials-v1',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
                if(!database.objectStoreNames.contains('exclusive')){database.close();return 0;}
                try{return await new Promise((resolve,reject)=>{const request=database.transaction('exclusive').objectStore('exclusive').count();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}finally{database.close();}
              });
              assert.equal(stored,0,'coordination must not persist tokens, accounts or leases');
              console.log('HTTP_P2_LIVE_BROWSER_COORDINATION_VERIFIED '+JSON.stringify({mode,syntheticOnly:true}));
            }finally{releaseDelayed();await context.close();}
          }
          const blocked=await contextFor('blocked'),blockedPage=await blocked.newPage();
          try {
            await blockedPage.goto(origin+'/portal.html',{waitUntil:'domcontentloaded'});await blockedPage.locator('#loginPersonnelNumber').fill('syn-p2-live-newer-web');
            await blockedPage.locator('#loginPassword').fill(GOOD_PASSWORD);const before=loginRequests;
            await blockedPage.locator('#portalLoginForm button[type=submit]').click();
            await blockedPage.waitForFunction(()=>document.getElementById('loginError').textContent.includes('Browser'));
            assert.equal(loginRequests,before,'unavailable coordination fails before sending credentials');
            console.log('HTTP_P2_LIVE_BROWSER_BLOCKED_STORAGE_VERIFIED');
          }finally{await blocked.close();}
          for(const mode of ['web','idb']) {
            const first='syn-p2-queued-old-'+mode,second='syn-p2-queued-new-'+mode;await seedPersonal(first);await seedPersonal(second);
            const context=await contextFor(mode,true),page=await context.newPage(),other=await context.newPage();
            try {
              await other.goto(origin+'/portal.html',{waitUntil:'domcontentloaded'});await formLogin(page,first,GOOD_PASSWORD);
              let ready;const committed=new Promise(resolve=>{ready=resolve;});const held={ready,route:'/api/portal/v1/auth/login',method:'POST'};heldResponse=held;
              const pendingLogin=formLogin(other,second,GOOD_PASSWORD,false);assert.equal(await committed,200);releaseDelayed=()=>held.release?.();
              await page.evaluate(()=>openPasswordChangeDialog());const before=passwordRequests;
              await formPassword(page,GOOD_PASSWORD,GOOD_PASSWORD+'-must-not-apply');
              await page.waitForTimeout(100);assert.equal(passwordRequests,before);
              held.release();await pendingLogin;
              await page.waitForFunction(()=>document.getElementById('passwordMessage').textContent.includes('anderen Fenster'));
              assert.equal(passwordRequests,before,'queued old-account change must stop before HTTP even without a BroadcastChannel notification');
              for(const id of [first,second])assert.equal((await query('SELECT password_hash FROM portal_users WHERE employee_number=?',[id]))[0].password_hash,hash);
              assert.equal((await other.evaluate(()=>fetch('/api/portal/v1/session').then(r=>r.json()))).user.employeeNumber,second);
              console.log('HTTP_P2_QUEUED_OLD_ACTOR_REJECTED '+JSON.stringify({mode,broadcastDelivery:false}));
            }finally{releaseDelayed();await context.close();}
          }
        }finally{releaseDelayed();await browser.close();await new Promise(resolve=>{proxy.close(resolve);proxy.closeAllConnections();});}
      });
      assert.equal(completed,15,'all requested HTTP groups must finish');
      console.log('HTTP_P2_VERIFIED '+JSON.stringify({provider:childProvider,groups:completed,syntheticOnly:true}));
    }
    try {
      if (childProvider === 'postgresql') {
        for (const domain of ['CORE', 'SALES']) for (const purpose of ['APP', 'READER', 'MIGRATOR']) {
          const connection = new URL(process.env[`GP_${domain}_${purpose}_URL`]);
          assert.equal(connection.hostname, '127.0.0.1');
          assert.equal(connection.pathname, '/gp_migration_' + domain.toLowerCase());
        }
        await require('../test-support/postgresql-migration/report-fixture').withReportFixture(async fixture => {
          try { await exercise(fixture); }
          finally { if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); server = null; await subject?.closePersistenceForTests(); subject?.releaseInstanceLockForTests(); subject = null; }
        }, { warmWorkers: false });
      } else await exercise();
    } finally {
      crypto.scrypt = realScrypt;
      if(browserProxy?.listening)await new Promise(resolve=>{browserProxy.close(resolve);browserProxy.closeAllConnections();});
      if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      // All production-mode HTTP observations are complete; the existing test-only
      // shutdown API is used solely to release this owned synthetic fixture.
      if (productionConfiguration) process.env.NODE_ENV='test';
      await subject?.closePersistenceForTests(); subject?.releaseInstanceLockForTests();
      configuration.resolvePersistenceConfiguration = originalConfiguration;
      assert.equal(path.dirname(fs.realpathSync(temporaryRoot)), fs.realpathSync(os.tmpdir()));
      fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
