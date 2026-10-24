"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const repository = path.resolve(__dirname, "..");
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const native = process.platform === "linux" && process.getuid?.() === 0;

test("native PostgreSQL preservation dispatcher requires explicit retention and an exclusive inherited FD9", { skip: !native }, async t => {
  // No host account, GP service, product path or database is contacted. Only
  // the service-state probe and operations payload are controlled fixtures;
  // shell dispatch, ownership checks and both kernel flock descriptions run.
  // CI runners may own or write /opt. Privileged Node verification also
  // checks ancestors, so keep the positive fixture below verified /root.
  const parent = "/root";
  for (const directory of ["/", parent]) {
    const info = fs.lstatSync(directory);
    assert(info.isDirectory() && !info.isSymbolicLink());
    assert.equal(info.uid, 0); assert.equal(info.mode & 0o022, 0);
    assert.equal(fs.realpathSync(directory), directory);
  }
  const root = fs.mkdtempSync(path.join(parent, "gp-pg-backup-preserve-"));
  fs.chmodSync(root, 0o700);
  const created = fs.lstatSync(root);
  t.after(() => {
    const current = fs.lstatSync(root);
    assert(current.isDirectory() && !current.isSymbolicLink());
    assert.equal(current.uid, 0); assert.equal(current.mode & 0o077, 0);
    assert.equal(current.dev, created.dev); assert.equal(current.ino, created.ino);
    assert.equal(path.dirname(fs.realpathSync(root)), parent);
    assert.match(path.basename(root), /^gp-pg-backup-preserve-[A-Za-z0-9]+$/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  // Root copies can retain the source owner through libuv. Hosted Node
  // installations belong to the runner, so reproduce that ownership here.
  const foreignRuntime = path.join(root, "foreign-owned-source-node"), runtime = path.join(root, "node");
  const nativeBytes = fs.readFileSync(process.execPath), nativeSha256 = crypto.createHash("sha256").update(nativeBytes).digest("hex");
  assert.deepEqual(nativeBytes.subarray(0, 4), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  fs.copyFileSync(process.execPath, foreignRuntime); fs.chownSync(foreignRuntime, 65534, 65534); fs.chmodSync(foreignRuntime, 0o755);
  const foreignInfo = fs.lstatSync(foreignRuntime);
  assert(foreignInfo.isFile() && !foreignInfo.isSymbolicLink());
  assert.equal(foreignInfo.uid, 65534); assert.equal(foreignInfo.gid, 65534); assert.equal(foreignInfo.nlink, 1);
  assert.equal(foreignInfo.mode & 0o022, 0);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(foreignRuntime)).digest("hex"), nativeSha256);
  fs.copyFileSync(foreignRuntime, runtime); fs.chownSync(runtime, 0, 0); fs.chmodSync(runtime, 0o755);
  const runtimeInfo = fs.lstatSync(runtime);
  assert(runtimeInfo.isFile() && !runtimeInfo.isSymbolicLink());
  assert.equal(runtimeInfo.uid, 0); assert.equal(runtimeInfo.gid, 0); assert.equal(runtimeInfo.nlink, 1);
  assert.equal(runtimeInfo.mode & 0o022, 0);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(runtime)).digest("hex"), nativeSha256);
  const common = path.join(root, "common.sh"), dispatcher = path.join(root, "postgresql-maintenance.sh");
  for (const [target, relative] of [[common, "common.sh"], [dispatcher, "postgresql-maintenance.sh"]]) {
    fs.writeFileSync(target, fs.readFileSync(path.join(repository, "server-tools/linux/lib", relative), "utf8").replace(/\r\n/g, "\n"));
  }
  function fixture(options = {}) {
    const directory = path.join(root, crypto.randomUUID()), app = path.join(directory, "app"), data = path.join(directory, "data"), backups = path.join(directory, "backups");
    for (const relative of ["server-tools/linux/lib", "node_modules", "lib"]) fs.mkdirSync(path.join(app, relative), { recursive: true, mode: 0o755 });
    fs.mkdirSync(path.join(data, "data"), { recursive: true, mode: 0o755 }); fs.mkdirSync(backups, { mode: 0o755 });
    const anchor = path.join(data, "data/postgresql-pair.json"), events = path.join(directory, "events");
    fs.writeFileSync(anchor, "{}"); fs.writeFileSync(path.join(backups, "needed-old-point"), "unchanged synthetic old recovery point");
    fs.writeFileSync(path.join(app, "lib/backup-workspace.js"), `
const fs=require('node:fs');const file=process.argv[3]+'.backup-workspace.lock';
fs.writeFileSync(file,'',{flag:'wx',mode:0o600});process.stdout.write(file);
`, { mode: 0o644 });
    fs.writeFileSync(path.join(app, "server-tools/linux/lib/postgresql-operations.js"), `
const fs=require('node:fs');const action=process.argv[2];
require('node:assert/strict').ok(process.execArgv.includes('--no-global-search-paths'));
for(const key of ['NODE_OPTIONS','NODE_REDIRECT_WARNINGS','NODE_V8_COVERAGE','PRIVATE_SENTINEL'])
 require('node:assert/strict').equal(process.env[key],undefined);
fs.appendFileSync(${JSON.stringify(events)},action+'\\n');
if(!['check-paths','backup-preserve','backup','prune'].includes(action))process.exit(42);
process.stdout.write(JSON.stringify({verified:true,action}));
`, { mode: 0o644 });
    const lock = path.join(directory, "maintenance.lock"), wrongLock = path.join(directory, "wrong.lock");
    fs.writeFileSync(lock, ""); fs.writeFileSync(wrongLock, "");
    const preload = path.join(directory, "preload.cjs"), marker = path.join(directory, "forbidden-preload");
    fs.writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');`);
    const script = ["set -Eeuo pipefail", "IFS=$'\\n\\t'", "source " + quote(common), "source " + quote(dispatcher),
      "app_arg=" + quote(app), "data_arg=" + quote(data), "backup_arg=" + quote(backups),
      "node_arg=" + quote(options.node ?? runtime), "database_arg=''", "service=grabenplaner.service",
      "keep_arg=" + quote(options.keep ?? "1000"), "preserve_existing_backups=" + (options.preserve ?? 1),
      "finish_deferred=" + (options.finish ?? 0), "defer_archive=" + (options.defer ?? 0),
      "lock_already_held=" + (options.inherited ?? 1), "GP_DEFAULT_MAINTENANCE_LOCK=" + quote(lock),
      "gp_require_systemd_unit() { :; }",
      'systemctl() { if [[ "$1" == show ]]; then printf "0\\n"; else return 3; fi; }',
      options.lock === "competing" ? "exec 8<>" + quote(lock) + "; flock --exclusive 8" : ":",
      options.lock === "fd6" ? "exec 6<>" + quote(lock) + "; flock --exclusive 6" : ":",
      "exec 9<>" + quote(["wrong", "fd6"].includes(options.lock) ? wrongLock : lock),
      options.lock === "competing" ? ":" : "flock --exclusive 9",
      "gp_postgresql_backup",
    ].join("\n");
    const file = path.join(directory, "run.sh"); fs.writeFileSync(file, script);
    return { directory, events, marker, backups, execute() {
      return spawnSync("/usr/bin/bash", ["--noprofile", "--norc", file], { encoding: "utf8", timeout: 30000,
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", HOME: root, LANG: "C.UTF-8",
          NODE_OPTIONS: "--require=" + preload, NODE_REDIRECT_WARNINGS: path.join(directory, "warnings"),
          NODE_V8_COVERAGE: path.join(directory, "coverage"), PRIVATE_SENTINEL: "synthetic-private-value" } });
    } };
  }
  await t.test("preserve reaches only backup-preserve and never changes an existing point", () => {
    const foreign = fixture({ node: foreignRuntime }), rejected = foreign.execute();
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Die privilegierte Node-Laufzeit ist nicht root-geschuetzt/);
    assert.equal(fs.existsSync(foreign.events), false); assert.equal(fs.existsSync(foreign.marker), false);
    assert.equal(fs.readFileSync(path.join(foreign.backups, "needed-old-point"), "utf8"), "unchanged synthetic old recovery point");
    const item = fixture(), result = item.execute();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(item.events, "utf8"), "check-paths\nbackup-preserve\n");
    assert.equal(fs.readFileSync(path.join(item.backups, "needed-old-point"), "utf8"), "unchanged synthetic old recovery point");
    assert.equal(fs.existsSync(item.marker), false);
    for (const name of ["warnings", "coverage"]) assert.equal(fs.existsSync(path.join(item.directory, name)), false);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private-value/);
  });
  for (const [name, options] of Object.entries({ "no inherited lease": { inherited: 0 }, "wrong keep": { keep: "999" },
    "implicit keep": { keep: "" }, "finish mixed": { finish: 1 }, "deferred mixed": { defer: 1 },
    "wrong fd9": { lock: "wrong" }, "only fd6": { lock: "fd6" }, "competing kernel lease": { lock: "competing" } })) {
    await t.test(name + " cannot create or prune a recovery point", () => {
      const item = fixture(options), result = item.execute();
      assert.notEqual(result.status, 0, result.stdout);
      const events = fs.existsSync(item.events) ? fs.readFileSync(item.events, "utf8") : "";
      assert.doesNotMatch(events, /(?:^|\n)(?:backup|backup-preserve|prune)(?:\n|$)/);
      if (options.lock) {
        assert.equal(events, "check-paths\n", "the negative lease case must reach the real inherited-FD check");
        assert.match(result.stderr, /Die uebernommene Wartungssperre fehlt/);
      } else {
        assert.equal(events, "");
        assert.match(result.stderr, /Der erhaltende Sicherungsauftrag benoetigt/);
      }
      assert.equal(fs.existsSync(item.marker), false);
      assert.equal(fs.readFileSync(path.join(item.backups, "needed-old-point"), "utf8"), "unchanged synthetic old recovery point");
    });
  }
  await t.test("ordinary retention and deferred prune remain explicit separate actions", () => {
    for (const finish of [0, 1]) {
      const item = fixture({ preserve: 0, keep: "20", finish }), result = item.execute();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.readFileSync(item.events, "utf8"), "check-paths\n" + (finish ? "prune\n" : "backup\n"));
    }
  });
  for (const unsafe of ["foreign-owned", "writable"]) {
    await t.test("a root-owned Node file under a " + unsafe + " ancestor is refused before helper execution", () => {
      const ancestor = fs.mkdtempSync(path.join(root, "unsafe-node-")), file = path.join(ancestor, "node");
      fs.copyFileSync(runtime, file); fs.chownSync(file, 0, 0); fs.chmodSync(file, 0o755);
      const info = fs.lstatSync(file);
      assert(info.isFile() && !info.isSymbolicLink()); assert.equal(info.uid, 0); assert.equal(info.gid, 0); assert.equal(info.nlink, 1);
      assert.equal(info.mode & 0o022, 0);
      if (unsafe === "foreign-owned") fs.chownSync(ancestor, 65534, 65534);
      else fs.chmodSync(ancestor, 0o777);
      const item = fixture({ node: file }), result = item.execute();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Die privilegierte Node-Laufzeit ist nicht root-geschuetzt/);
      assert.equal(fs.existsSync(item.events), false); assert.equal(fs.existsSync(item.marker), false);
      assert.equal(fs.readFileSync(path.join(item.backups, "needed-old-point"), "utf8"), "unchanged synthetic old recovery point");
    });
  }
  await t.test("a writable or foreign-owned app dependency is refused before helper execution", () => {
    for (const unsafe of ["owner", "mode"]) {
      const item = fixture(), file = path.join(item.directory, "app/node_modules/untrusted.cjs");
      fs.writeFileSync(file, "throw Error('must not execute');", { mode: 0o644 });
      if (unsafe === "owner") fs.chownSync(file, 65534, 65534);
      else fs.chmodSync(file, 0o666);
      const result = item.execute();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Der App- und Abhaengigkeitsbaum ist nicht root-geschuetzt/);
      assert.equal(fs.existsSync(item.events), false);
      assert.equal(fs.existsSync(item.marker), false);
    }
  });
});
