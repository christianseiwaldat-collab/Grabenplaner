"use strict";

const test = require("node:test"), assert = require("node:assert/strict");

// This suite must never acquire an ordinary local or configured application DB.
// The CI bridge owns disposable paired PostgreSQL databases and changes only
// fixture setup/assertions; the HTTP handlers use the native app repositories.
if (process.env.GP_PG_API_FIXTURE_BRIDGE !== "1") {
  test("Emma HTTP requests require the explicitly owned native PostgreSQL fixture", {
    skip: "Run through the guarded PostgreSQL CI fixture, not an application database.",
  }, () => {});
} else {
  require("../test-support/postgresql-api/guard").assertSyntheticEnvironment();
  const crypto = require("node:crypto"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const { sessionCsrf } = require("../test-support/portal-session-fixture");
  const { prepareLocationFixture } = require("../test-support/postgresql-api/location-fixture");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-emma-absence-native-"));
  Object.assign(process.env, {
    DB_PATH: path.join(root, "fixture.postgresql"), BACKUP_DIR: path.join(root, "backups"),
    GRABENPLANER_DATA_DIR: path.join(root, "data"), GRABENPLANER_HOST: "127.0.0.1",
    GRABENPLANER_FORCE_PORTAL: "1", GRABENPLANER_SEED_DEMO: "1",
    GRABENPLANER_TEST_TODAY: "2031-04-01", NODE_ENV: "test", TZ: "Europe/Vienna",
  });
  const subject = require("../server"), { app, db } = subject;
  const LOCATION = "91", PERSON = "emma-self", ZA = "emma-za", OTHER = "emma-other", MANAGER = "emma-review";
  const PREFIX = "/api/portal/v1/emma/absence-requests";
  const sessions = new Map();
  let server, base;

  function session(number) {
    const token = crypto.randomBytes(32).toString("hex"), csrf = sessionCsrf(token);
    db.prepare(`INSERT INTO portal_sessions(id,employee_number,token_hash,expires_at,authenticated_at,absolute_expires_at)
      VALUES(?,?,?,'2099-12-31T23:59:59.000Z',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now','+8 hours'))`)
      .run(crypto.randomUUID(), number, crypto.createHash("sha256").update(token).digest("hex"));
    return { cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf };
  }
  async function api(route, { actor = "Emma", body, csrf = true, binary = false } = {}) {
    const auth = sessions.get(actor), headers = { Accept: binary ? "application/pdf" : "application/json" };
    if (auth) headers.Cookie = auth.cookie;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      if (csrf && auth) headers["X-CSRF-Token"] = auth.csrf;
    }
    const response = await fetch(base + route, { method: body === undefined ? "GET" : "POST", headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = binary && response.ok ? Buffer.from(await response.arrayBuffer()) : await response.json();
    return { status: response.status, data, headers: response.headers };
  }
  const period = date => ({ dateFrom: date, dateTo: date, allDay: true, startTime: null, endTime: null });
  const request = (date, kind = "vacation", employeeNumber = PERSON, note = "Synthetic own request") =>
    ({ employeeNumber, kind, periods: [period(date)], note });
  const post = (action, body, options = {}) => api(`${PREFIX}/${action}`, { ...options, body });
  const count = (table, employee = PERSON) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE employee_number=?`).get(employee).n;
  const schedule = () => api(`/api/schedule?week=2031-04-07&location=${LOCATION}&fast=1`);

  // This native trigger makes a successful insert itself prove the transaction
  // isolation. It neither mocks BEGIN nor reads a separate connection's state.
  function nativeTrigger(name, table, code) {
    const fn = name + "_fn";
    db.postgresqlFixtureDdl("core", `CREATE FUNCTION gp."${fn}"() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,gp AS '${code.replaceAll("'", "''")}'`);
    try { db.postgresqlFixtureDdl("core", `CREATE TRIGGER "${name}" BEFORE INSERT ON gp."${table}" FOR EACH ROW EXECUTE FUNCTION gp."${fn}"()`); }
    catch (error) { db.postgresqlFixtureDdl("core", `DROP FUNCTION gp."${fn}"()`); throw error; }
    return () => {
      db.postgresqlFixtureDdl("core", `DROP TRIGGER "${name}" ON gp."${table}"`);
      db.postgresqlFixtureDdl("core", `DROP FUNCTION gp."${fn}"()`);
    };
  }

  test.before(async () => {
    assert.equal(db.postgresqlTestFixture, true, "the ordinary fixture facade must be native PostgreSQL");
    assert.match(db.postgresqlCatalogQuery("core", "SELECT version() AS version")[0].version, /^PostgreSQL 18\.4\b/);
    const days = JSON.stringify(Object.fromEntries(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
      .map(day => [day, { open: true, start: "09:00", end: "18:00", minStaff: 99, minFrom: "09:00", minTo: "18:00", lunchEnabled: false }])));
    prepareLocationFixture(db, "INSERT INTO locations(id,name,min_staff,day_settings_json,active) VALUES(?,?,99,?,1)")
      .run(LOCATION, "Synthetic Emma branch", days);
    prepareLocationFixture(db, "INSERT INTO locations(id,name,min_staff,day_settings_json,active) VALUES(?,?,0,?,1)")
      .run("92", "Synthetic outside branch", days);
    for (const [number, role, location] of [["Emma", "employee", LOCATION], [PERSON, "employee", LOCATION],
      [ZA, "employee", LOCATION], [OTHER, "employee", "92"], [MANAGER, "manager", LOCATION]]) {
      db.prepare(`INSERT INTO employees(personnel_number,full_name,nickname,color,contracted_hours,home_location_id,active)
        VALUES(?,?,?,'#287a67',38.5,?,1)`).run(number, `Synthetic ${number}`, number, location);
      db.prepare(`INSERT INTO portal_users(employee_number,password_hash,role,active,must_change_password,password_changed_at)
        VALUES(?,'test-only',?,1,0,CURRENT_TIMESTAMP)`).run(number, role);
      sessions.set(number, session(number));
    }
    for (const number of ["Emma", MANAGER]) for (const right of ["schedule:read", "schedule:write", "absence_entries:write"])
      db.prepare("INSERT INTO portal_permission_grants(employee_number,permission,granted_by) VALUES(?,?,'synthetic-fixture')").run(number, right);
    for (const number of ["Emma", MANAGER])
      db.prepare("INSERT INTO portal_access_scopes(employee_number,location_id,assigned_by) VALUES(?,?,'synthetic-fixture')").run(number, LOCATION);
    db.prepare(`INSERT INTO shifts(employee_number,location_id,shift_date,start_time,end_time)
      VALUES(?,?,'2031-04-08','09:00','18:00')`).run(ZA, LOCATION);
    db.prepare("INSERT INTO settings(key,value) VALUES('pdf_schedule_design_ids',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify(["timeline", "matrix"]));
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  test.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await db.close(); subject.releaseInstanceLockForTests();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("gp-emma-absence-native-"));
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("HTTP authentication, CSRF, current actor and subject scope prevent unauthorized native requests", async () => {
    assert.equal((await api(`${PREFIX}/capabilities`, { actor: null })).status, 401);
    assert.equal((await api(`${PREFIX}/capabilities`, { actor: PERSON })).status, 403);
    assert.equal((await api(`${PREFIX}/capabilities`, { actor: MANAGER })).status, 403,
      "another scoped actor with all three API permissions is still not Emma");
    const capabilities = await api(`${PREFIX}/capabilities`);
    assert.equal(capabilities.status, 200, JSON.stringify(capabilities.data));
    assert.equal(capabilities.data.pendingOnly, true);
    assert.equal(capabilities.data.conflictPolicy, "submit_with_warning");
    assert.equal((await post("submit", request("2031-04-20"), { csrf: false })).status, 403);
    assert.equal((await post("submit", request("2031-04-20", "vacation", OTHER))).status, 403);
    assert.equal((await post("submit", { ...request("2031-04-20"), status: "approved" })).status, 400);
    assert.equal(count("vacation_requests"), 0);
    assert.equal(count("vacation_requests", OTHER), 0);
  });

  test("native red staffing saves only pending rows, reviewer notices and submit decisions inside SERIALIZABLE", async () => {
    const before = await schedule(); assert.equal(before.status, 200, JSON.stringify(before.data));
    const shifts = db.prepare("SELECT * FROM shifts ORDER BY id").all();
    const remove = nativeTrigger("test_emma_serializable", "vacation_requests",
      "BEGIN IF current_setting('transaction_isolation') <> 'serializable' THEN RAISE EXCEPTION 'synthetic isolation violation'; END IF; RETURN NEW; END");
    let saved;
    try {
      const body = request("2031-04-08");
      const checked = await post("check", body);
      assert.equal(checked.status, 200, JSON.stringify(checked.data));
      assert.equal(checked.data.checks[0].trafficLight, "red"); assert.equal(checked.data.submissionAllowed, true);
      saved = await post("submit", body);
      assert.equal(saved.status, 201, JSON.stringify(saved.data));
      assert.equal(saved.data.requests.length, 1); assert.equal(saved.data.conflicts.length, 1);
    } finally { remove(); }
    const row = saved.data.requests[0], native = db.prepare("SELECT * FROM vacation_requests WHERE id=?").get(row.id);
    assert.equal(row.employeeNumber, PERSON); assert.equal(native.employee_number, PERSON);
    assert.equal(row.status, "pending"); assert.equal(native.status, "pending_local");
    const decision = db.prepare("SELECT * FROM request_decisions WHERE request_kind='vacation' AND request_id=?").get(row.id);
    assert.equal(decision.actor_employee_number, "Emma"); assert.equal(decision.action, "submit");
    assert(db.prepare("SELECT 1 FROM portal_notifications WHERE recipient_employee_number=? AND entity_type='vacation' AND entity_id=?").get(MANAGER, String(row.id)));
    const audit = db.prepare("SELECT * FROM audit_log WHERE action='vacation.request.create' AND entity_id=?").get(String(row.id));
    assert.equal(audit.actor, "Emma"); assert.equal(JSON.parse(audit.detail).subject, PERSON);
    assert.deepEqual(db.prepare("SELECT * FROM shifts ORDER BY id").all(), shifts);
    const read = await post("read", { employeeNumber: PERSON, kind: "vacation", ids: [row.id] });
    assert.equal(read.status, 200, JSON.stringify(read.data)); assert.equal(read.data.requests[0].status, "pending");
    assert.equal((await post("read", { employeeNumber: ZA, kind: "vacation", ids: [row.id] })).status, 404);
    const after = await schedule(); assert.equal(after.status, 200, JSON.stringify(after.data));
    const projected = after.data.weekOptions.find(item => item.id === `pending-vacation-${row.id}`);
    assert(projected, "saved native request must appear in the current schedule");
    assert(after.data.employees.some(person => person.personnel_number === PERSON));
    assert.equal(projected.soft_pending, true); assert.equal(projected.credited_minutes_per_day, 0);
    assert.equal(typeof before.data.optionCreditTotals[PERSON], "number");
    assert.equal(typeof before.data.totals[PERSON], "number");
    assert.equal(after.data.optionCreditTotals[PERSON], before.data.optionCreditTotals[PERSON]);
    assert.equal(after.data.totals[PERSON], before.data.totals[PERSON]);
    const pdf = await api(`/api/schedule.pdf?week=2031-04-07&location=${LOCATION}&design=matrix`, { binary: true });
    assert.equal(pdf.status, 200); assert.match(pdf.headers.get("content-type"), /application\/pdf/);
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = getDocument({ data: Uint8Array.from(pdf.data), disableWorker: true, isEvalSupported: false, useSystemFonts: true });
    const document = await loading.promise;
    try {
      let text = "";
      for (let i = 1; i <= document.numPages; i++) {
        const page = await document.getPage(i); text += (await page.getTextContent()).items.map(item => item.str).join(" "); page.cleanup();
      }
      assert.match(text, /Urlaub beantragt/);
    } finally { await loading.destroy(); }
    const duplicate = await post("submit", request("2031-04-08"));
    assert.equal(duplicate.status, 201, JSON.stringify(duplicate.data));
    assert.equal(duplicate.data.status, "blocked"); assert.equal(duplicate.data.requests.length, 0);
    assert.equal(count("vacation_requests"), 1, "repeating the same pending period cannot create another native request");
  });

  test("native ZA staffing warnings remain pending and repeated periods do not dispatch another request", async () => {
    const body = request("2031-04-08", "time_off", ZA);
    const checked = await post("check", body); assert.equal(checked.status, 200, JSON.stringify(checked.data));
    assert.equal(checked.data.checks[0].trafficLight, "red"); assert.equal(checked.data.submissionAllowed, true);
    const remove = nativeTrigger("test_emma_za_serializable", "time_off_requests",
      "BEGIN IF current_setting('transaction_isolation') <> 'serializable' THEN RAISE EXCEPTION 'synthetic isolation violation'; END IF; RETURN NEW; END");
    let saved;
    try { saved = await post("submit", body); } finally { remove(); }
    assert.equal(saved.status, 201, JSON.stringify(saved.data)); assert.equal(saved.data.requests.length, 1);
    const row = db.prepare("SELECT * FROM time_off_requests WHERE id=?").get(saved.data.requests[0].id);
    assert.equal(row.employee_number, ZA); assert.equal(row.status, "pending_local"); assert.equal(row.all_day, 1);
    assert.equal(row.approval_type, "local");
    const duplicate = await post("submit", body); assert.equal(duplicate.status, 201, JSON.stringify(duplicate.data));
    assert.equal(duplicate.data.requests.length, 0); assert.equal(count("time_off_requests", ZA), 1);
  });

  test("current hard blocks reject their own period and preserve eligible siblings without historical writes", async () => {
    db.prepare("INSERT INTO request_blackouts(location_id,date_from,date_to,block_vacation,reason) VALUES(?,'2031-04-10','2031-04-10',1,'Synthetic hard blackout')").run(LOCATION);
    const body = { ...request("2031-04-09"), periods: [period("2031-04-09"), period("2031-04-10"), period("2031-04-12")] };
    const saved = await post("submit", body); assert.equal(saved.status, 201, JSON.stringify(saved.data));
    assert.deepEqual(saved.data.requests.map(row => row.inputIndex), [0, 2]); assert.equal(saved.data.blocked.length, 1);
    assert.match(saved.data.blocked[0].reason, /Synthetic hard blackout/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM vacation_requests WHERE employee_number=? AND date_from='2031-04-10'").get(PERSON).n, 0);
    const before = count("vacation_requests");
    assert.equal((await post("submit", request("2031-03-31"))).status, 400);
    assert.equal(count("vacation_requests"), before);
  });

  test("revocation after check and inside the native write transaction prevents persistence and all notices", async () => {
    const body = request("2031-04-22");
    assert.equal((await post("check", body)).status, 200);
    db.prepare("INSERT INTO portal_permission_denials(employee_number,permission,denied_by) VALUES(?,'own_vacation:request','synthetic-fixture')").run(PERSON);
    try { assert.equal((await post("submit", body)).status, 403); }
    finally { db.prepare("DELETE FROM portal_permission_denials WHERE employee_number=? AND permission='own_vacation:request'").run(PERSON); }
    const before = {
      rows: count("vacation_requests"),
      decisions: db.prepare("SELECT COUNT(*) AS n FROM request_decisions").get().n,
      notices: db.prepare("SELECT COUNT(*) AS n FROM portal_notifications").get().n,
    };
    const remove = nativeTrigger("test_emma_late_revoke", "vacation_requests",
      `BEGIN IF NEW.note = 'Synthetic transaction revocation' THEN INSERT INTO gp.portal_permission_denials(employee_number,permission,denied_by) VALUES(NEW.employee_number,'own_vacation:request','synthetic-fixture'); END IF; RETURN NEW; END`);
    try {
      const failed = await post("submit", request("2031-04-23", "vacation", PERSON, "Synthetic transaction revocation"));
      assert.equal(failed.status, 403, JSON.stringify(failed.data));
    } finally { remove(); }
    assert.equal(count("vacation_requests"), before.rows);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM request_decisions").get().n, before.decisions);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM portal_notifications").get().n, before.notices);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM portal_permission_denials WHERE employee_number=? AND permission='own_vacation:request'").get(PERSON).n, 0,
      "the injected late denial must roll back with its failed request");
  });
}
