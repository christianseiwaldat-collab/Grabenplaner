"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { execFileSync } = require("node:child_process");
const { createDatabaseSizeHistory } = require("../lib/database-size-history");
const { createPairedSnapshot } = require("../lib/persistence/postgresql/operations/paired-backup");
const broker = require("../server-tools/linux/offsite/lib/maintenance-schedule-broker");
const { markdownReport } = require("../lib/recovery-assurance-report");
const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
function directory(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp719-")); fs.chmodSync(root, 0o700); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }

test("split history survives reopening, deduplicates slots, prunes and fails closed on corruption", t => {
  const file = path.join(directory(t), "sizes.json"), store = createDatabaseSizeHistory(file);
  const data = { core: { bytes: 200 }, sales: { bytes: 11000 } }, now = Date.parse("2026-09-22T12:00:00Z");
  assert.equal(store.record(data, now - 190 * 86400000), true);
  assert.equal(store.record(data, now), true);
  assert.equal(store.record(data, now + 1000), false);
  const reopened = createDatabaseSizeHistory(file).read();
  assert.equal(reopened.points.length, 1); assert.equal(reopened.points[0].salesBytes, 11000);
  const raw = JSON.parse(fs.readFileSync(file)); raw.points[0].salesBytes = 1; fs.writeFileSync(file, JSON.stringify(raw));
  assert.equal(store.read().integrityVerified, false); assert.equal(store.record(data, now + 86400000), false);
});

test("backup hourly schedules round-trip and reject dangerous minute intervals", () => {
  const task = broker.TASKS.find(t => t.id === "complete-backup");
  for (const minutes of [360, 720]) {
    const submitted = broker.defaultSchedules().map(s => s.id === task.id ? { ...s, cadence: "hours", weekdays: [], intervalMinutes: minutes, time: "03:00" } : s);
    const value = broker.normalizeSchedules(submitted).find(s => s.id === task.id);
    const expression = broker.calendarExpression(value);
    assert.deepEqual(broker.scheduleFromCalendar(expression, task, true), value);
    submitted.find(s => s.id === task.id).intervalMinutes = 5;
    assert.throws(() => broker.normalizeSchedules(submitted), /MAINTENANCE_SCHEDULE_INVALID/);
  }
});

test("an asynchronous snapshot connection failure cannot crash or seal a backup", async t => {
  const root = directory(t), clients = [];
  const domains = ["core", "sales"].map(domain => {
    const c = new EventEmitter(); clients.push(c); c.release = error => { c.released = true; c.releaseError = error; };
    c.query = async sql => ({ rows: sql.includes("current_database") ? [{ name: domain }]
      : sql.includes("pg_tables") ? [{ schemaname: "gp", tablename: "synthetic" }]
        : sql.includes("pg_export_snapshot") ? [{ id: "AB-12" }] : [] });
    return { domain, database: domain, ownerRole: "gp_owner", pool: { connect: async () => c } };
  });
  let captures = 0;
  await assert.rejects(createPairedSnapshot({ backupDirectory: root, domains,
    withQuiescedWrites: work => work({ active: true, pendingMutations: 0 }),
    readCheckpoint: async () => ({}), runDump: async () => { clients[0].emit("error", new Error("57P01")); },
    captureRecoveryFiles: async () => { captures++; },
  }), /PG_PAIR_CONNECTION_LOST/);
  assert.equal(captures, 0); assert.ok(clients.every(c => c.released));
  assert.ok(clients[0].releaseError); assert.equal(clients[0].listenerCount("error"), 0);
  assert.equal(fs.readdirSync(root).some(n => n.endsWith("complete.json")), false);
});

test("failed report differentiates preparation, upload and unexecuted phases", () => {
  const report = markdownReport({ runId: "synthetic", status: "failed", trigger: "scheduled-nightly", startedAt: "2026-09-22T01:00:00Z", completedAt: "2026-09-22T01:08:00Z", durationSeconds: 480, errorCode: "PREPARE_FAILED", phases: [{ id: "backup", status: "failed" }, { id: "restore-test", status: "pending" }] }, "2026-09-22T18:00:00Z");
  assert.match(report, /8 Min\. 0 Sek\./); assert.match(report, /keinen Uploadfehler und kein Zeitlimit/);
  assert.match(report, /Isolierter Daten-Restore: Nicht ausgeführt/);
});

test("report route requires technical permission, a valid identifier and a verified matching run", () => {
  const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const start = server.indexOf('app.get("/api/portal/v1/system-center/recovery-assurance/reports/:filename"');
  const end = server.indexOf('\napp.post(', start);
  let handler, permitted = false, history = { statusAvailable: false, integrityVerified: false };
  const context = vm.createContext({ app: { get: (_route, fn) => { handler = fn; } }, serverModeActive: true,
    requirePortalAnyPermission: (_request, permissions) => { assert.deepEqual([...permissions], ["system:diagnostics:technical"]); if (!permitted) throw new Error("403"); },
    readRecoveryAssuranceStatus: () => history, httpError: status => new Error(String(status)),
    contentDispositionHeader: name => name, require: () => ({ markdownReport: () => "verified report" }),
  });
  vm.runInContext(server.slice(start, end), context);
  const id = "a".repeat(64), request = { params: { filename: id + ".md" } };
  const response = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, type() { return this; }, send(value) { this.value = value; } };
  assert.throws(() => handler(request, response), /403/); permitted = true;
  assert.throws(() => handler({ params: { filename: "../secrets.md" } }, response), /400/);
  assert.throws(() => handler(request, response), /503/);
  history = { statusAvailable: true, integrityVerified: true, recentRuns: [] };
  assert.throws(() => handler(request, response), /404/);
  history.recentRuns = [{ reportId: id, runIdPrefix: "12345678" }]; handler(request, response);
  assert.equal(response.value, "verified report"); assert.equal(response.headers["Cache-Control"], "private, no-store");
});

test("trend selection uses time spacing, exact values, persisted period and keyboard navigation", () => {
  const saved = new Map([["grabenplaner-system-center-days", "7"]]);
  const context = vm.createContext({ Date, Number, Array, JSON, Math, localStorage: { getItem: k => saved.get(k) },
    escapeHtml: text => String(text).replaceAll('"', '&quot;'), diagnosticTimestamp: String });
  vm.runInContext(source.slice(source.indexOf("function systemCenterTrendDays("), source.indexOf("function productReadinessStateCopy(")), context);
  assert.equal(context.systemCenterTrendDays(), 7);
  saved.set("grabenplaner-system-center-days", "91"); assert.equal(context.systemCenterTrendDays(), 180);
  const html = context.renderSystemCenterSparkline([{ at: "2026-09-01T00:00:00Z", coreBytes: 100 }, { at: "2026-09-02T00:00:00Z", coreBytes: 200 }, { at: "2026-09-11T00:00:00Z", coreBytes: 300 }], { key: "coreBytes", label: "Core", formatter: String, colorClass: "database" });
  const series = JSON.parse(html.match(/data-trend-series="([^"]+)"/)[1].replaceAll("&quot;", '"'));
  assert.equal(series[1].x, 38.4); assert.match(series[1].text, /200 Byte/);
  const output = {}, marker = { setAttribute() {} }, svg = { dataset: { trendSeries: JSON.stringify(series), trendIndex: "2" }, setAttribute() {}, querySelector: () => marker, closest: () => ({ querySelector: () => output }), getBoundingClientRect: () => ({ left: 0, width: 320 }) };
  context.inspectSystemCenterTrend({ type: "pointermove", target: { closest: () => svg }, clientX: 40 });
  assert.equal(svg.dataset.trendIndex, "1"); assert.match(output.textContent, /200 Byte/);
  context.inspectSystemCenterTrend({ type: "keydown", key: "ArrowRight", preventDefault() {}, target: { closest: () => svg } });
  assert.equal(svg.dataset.trendIndex, "2");
});

test("APT and backup share an exclusive lock, and needrestart defers jobs but not database services", { skip: process.platform !== "linux" }, () => {
  const script = path.join(__dirname, "../server-tools/linux/hardening/apt-maintenance-lock.py");
  execFileSync("python3", ["-c", `
import importlib.util, sys, tempfile, fcntl, subprocess
from pathlib import Path
spec=importlib.util.spec_from_file_location('apt_lock',sys.argv[1]); m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as root:
    lock=Path(root)/'maintenance.lock'; lock.touch()
    with lock.open('r+') as held:
        fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
        assert subprocess.run(['flock','--exclusive','--nonblock',str(lock),'true']).returncode==1
    assert subprocess.run(['flock','--exclusive','--nonblock',str(lock),'true']).returncode==0
assert '--wait 21600' in m.dropin('install')
perl='our %nrconf; '+m.NEEDRESTART_TEXT+'''
my ($re)=keys %{$nrconf{override_rc}};
for my $unit ('grabenplaner-offsite-assurance@scheduled-nightly.service','grabenplaner-offsite-restore-test.service','grabenplaner-host-control@123.service') {die $unit unless $unit =~ $re;}
for my $unit ('grabenplaner.service','grabenplaner-postgresql.service','postgresql@18-main.service','grabenplaner-test.service') {die $unit if $unit =~ $re;}
'''
subprocess.run(['perl','-e',perl],check=True)
`, script], { stdio: "pipe" });
});
