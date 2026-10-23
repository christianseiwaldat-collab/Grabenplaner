"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const lock = require("../lib/database-lock");
const supported = process.platform === "linux" && ["x64", "arm64"].includes(process.arch);
const linux = { skip: !supported };
const roots = [];
function fixture(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `gp-ofd-lock-${label}-`));
  roots.push(root); return path.join(root, "postgresql-pair.json");
}
function attempt(databasePath, module = path.resolve(__dirname, "../lib/database-lock")) {
  return spawnSync(process.execPath, ["-e", `try {const m=require(${JSON.stringify(module)});const h=m.acquireDatabaseLock({databasePath:${JSON.stringify(databasePath)}});m.releaseDatabaseLock(h);process.stdout.write("acquired");} catch(e) {process.stdout.write(e.code || "FAILED");process.exitCode=1;}`], { encoding: "utf8", timeout: 15000 });
}
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

test("PostgreSQL server lock fails closed outside supported Linux", { skip: supported }, () => {
  assert.throws(() => lock.acquireDatabaseLock({ databasePath: fixture("platform") }), { code: "DATABASE_LOCK_PLATFORM_UNSUPPORTED" });
});
test("no in-memory or missing path can disable the server singleton", () => {
  for (const databasePath of [undefined, "", ":memory:"]) assert.throws(() => lock.acquireDatabaseLock({ databasePath }), { code: "DATABASE_LOCK_PATH_REQUIRED" });
});
test("kernel lock remains held after acquisition helper exits and excludes same and other processes", linux, () => {
  const databasePath=fixture("exclusive"), first=lock.acquireDatabaseLock({databasePath});
  try {
    assert.throws(()=>lock.acquireDatabaseLock({databasePath}),{code:"DATABASE_IN_USE"});
    const result=attempt(databasePath);assert.equal(result.status,1,result.stderr);assert.equal(result.stdout,"DATABASE_IN_USE");
    assert.equal(lock.releaseDatabaseLock({...first}),false);
    assert.equal(lock.releaseDatabaseLock({...first,ownerToken:"forged"}),false);
    assert.equal(attempt(databasePath).status,1);
  } finally { assert.equal(lock.releaseDatabaseLock(first),true); }
  assert.equal(lock.releaseDatabaseLock(first),false);
  assert.equal(attempt(databasePath).status,0);
});
test("new OFD lock blocks the exact old SQLite lock without modifying or deleting legacy content", linux, () => {
  const databasePath=fixture("new-old");
  const legacy=require("../test-support/database-lock-legacy-v09293.cjs");
  // Produce a real old-format file, then prove an unchanged copy survives.
  const old=legacy.acquireDatabaseLock({databasePath});assert.equal(legacy.releaseDatabaseLock(old),true);
  const oldFile=legacy.lockPathForDatabase(databasePath), bytes=fs.readFileSync(oldFile);
  const current=lock.acquireDatabaseLock({databasePath});
  try { const result=attempt(databasePath,path.resolve(__dirname,"../test-support/database-lock-legacy-v09293.cjs"));assert.equal(result.status,1,result.stderr);assert.equal(result.stdout,"DATABASE_IN_USE"); }
  finally { lock.releaseDatabaseLock(current); }
  assert.deepEqual(fs.readFileSync(oldFile),bytes);
  assert.equal(attempt(databasePath,path.resolve(__dirname,"../test-support/database-lock-legacy-v09293.cjs")).status,0);
});
test("exact old SQLite lock blocks new OFD acquisition during upgrade and rollback", linux, () => {
  const databasePath=fixture("old-new"),legacy=require("../test-support/database-lock-legacy-v09293.cjs");
  const old=legacy.acquireDatabaseLock({databasePath});
  try {const result=attempt(databasePath);assert.equal(result.status,1,result.stderr);assert.equal(result.stdout,"DATABASE_IN_USE");}
  finally {legacy.releaseDatabaseLock(old);}
  assert.equal(attempt(databasePath).status,0);
});
test("kernel releases both descriptions after parent SIGKILL without stale-file reclamation", linux, async () => {
  const databasePath=fixture("crash"),module=path.resolve(__dirname,"../lib/database-lock");
  const child=spawn(process.execPath,["-e",`require(${JSON.stringify(module)}).acquireDatabaseLock({databasePath:${JSON.stringify(databasePath)}});process.stdout.write("ready");setInterval(()=>{},60000);`],{stdio:["ignore","pipe","pipe"]});
  const output=await once(child.stdout,"data");assert.equal(String(output[0]),"ready");
  const entry=fs.statSync(lock.lockPathForDatabase(databasePath));
  assert.equal(attempt(databasePath).status,1);
  const exited=once(child,"exit");child.kill("SIGKILL");await exited;
  assert.equal(attempt(databasePath).status,0);
  assert.equal(fs.statSync(lock.lockPathForDatabase(databasePath)).ino,entry.ino);
});
test("helper absence or crash fails closed and releases partial acquisition", linux, () => {
  for(const scenario of ["missing","crash"]){
    const databasePath=fixture("helper-"+scenario),directory=path.dirname(databasePath),module=path.join(directory,"database-lock.js");
    fs.copyFileSync(path.resolve(__dirname,"../lib/database-lock.js"),module);
    if(scenario==="crash")fs.writeFileSync(path.join(directory,"database-lock-linux.py"),
      fs.readFileSync(path.resolve(__dirname,"../lib/database-lock-linux.py"),"utf8")
        .replace("acquire(4, 0x40000000, 512)","os.kill(os.getpid(), 9)"));
    const result=attempt(databasePath,module);assert.equal(result.status,1,result.stderr);assert.equal(result.stdout,"DATABASE_LOCK_HELPER_UNAVAILABLE");
    assert.equal(attempt(databasePath).status,0);
  }
});
test("symlinks, hardlinks and writable lock directories cannot bypass the singleton", linux, () => {
  for(const kind of ["symlink","hardlink","directory"]){
    const databasePath=fixture(kind),root=path.dirname(databasePath),file=lock.lockPathForDatabase(databasePath),target=path.join(root,"owned");
    fs.writeFileSync(target,"preserve");
    if(kind==="symlink")fs.symlinkSync(target,file);
    if(kind==="hardlink")fs.linkSync(target,file);
    if(kind==="directory")fs.chmodSync(root,0o777);
    assert.throws(()=>lock.acquireDatabaseLock({databasePath}));
    assert.equal(fs.readFileSync(target,"utf8"),"preserve");
    if(kind==="directory")fs.chmodSync(root,0o700);
  }
});
test("historical live PID lock is respected and stale record is never deleted", linux, () => {
  const databasePath=fixture("pid"),file=lock.legacyLockPathForDatabase(databasePath);
  fs.writeFileSync(file,JSON.stringify({pid:process.pid}));
  assert.throws(()=>lock.acquireDatabaseLock({databasePath}),{code:"DATABASE_IN_USE"});
  const stale=JSON.stringify({pid:2147483647});fs.writeFileSync(file,stale);
  const acquired=lock.acquireDatabaseLock({databasePath});lock.releaseDatabaseLock(acquired);
  assert.equal(fs.readFileSync(file,"utf8"),stale);
});
test("an unreadable historical owner record fails closed instead of guessing that it is stale", linux, () => {
  const databasePath=fixture("invalid-pid"),file=lock.legacyLockPathForDatabase(databasePath);
  for(const text of ["invalid-json", "{}", '{"pid":0}']) {
    fs.writeFileSync(file,text);
    assert.throws(()=>lock.acquireDatabaseLock({databasePath}),{code:"DATABASE_LOCK_PATH_UNSAFE"});
    assert.equal(fs.readFileSync(file,"utf8"),text);
    assert.equal(fs.existsSync(lock.lockPathForDatabase(databasePath)),false);
  }
});
test("root maintenance and an unprivileged application share ownership and exclude each other", {
  skip: !supported || process.getuid?.() !== 0, timeout: 30000,
}, async () => {
  const databasePath=fixture("cross-account"),directory=path.dirname(databasePath);
  const account=spawnSync("/usr/bin/id",["-u","nobody"],{encoding:"utf8"});
  assert.equal(account.status,0,account.stderr);
  const uid=Number(account.stdout.trim()),group=spawnSync("/usr/bin/id",["-g","nobody"],{encoding:"utf8"});
  assert.equal(group.status,0,group.stderr);const gid=Number(group.stdout.trim());
  assert.ok(uid>0 && gid>0);
  fs.chownSync(directory,uid,gid);
  for(const name of ["database-lock.js","database-lock-linux.py"])fs.copyFileSync(path.resolve(__dirname,"../lib",name),path.join(directory,name));
  const module=path.join(directory,"database-lock.js");
  // Test runners may install Node under a private home directory. Copy only the
  // current executable into this owned fixture instead of widening that home.
  const executable=path.join(directory,"node");fs.copyFileSync(process.execPath,executable);fs.chmodSync(executable,0o755);
  function asApplication(script){return spawnSync("/usr/sbin/runuser",["--user","nobody","--",executable,"-e",script],{encoding:"utf8",timeout:15000});}
  const acquireScript=`const m=require(${JSON.stringify(module)});try{const h=m.acquireDatabaseLock({databasePath:${JSON.stringify(databasePath)}});m.releaseDatabaseLock(h);process.stdout.write("acquired");}catch(e){process.stdout.write(e.code);process.exitCode=1;}`;
  const first=lock.acquireDatabaseLock({databasePath});
  try {
    for(const file of [lock.lockPathForDatabase(databasePath),lock.sqliteCompatibilityLockPathForDatabase(databasePath)])assert.equal(fs.statSync(file).uid,uid);
    const blocked=asApplication(acquireScript);assert.equal(blocked.status,1,blocked.stderr);assert.equal(blocked.stdout,"DATABASE_IN_USE");
  } finally {lock.releaseDatabaseLock(first);}
  assert.equal(asApplication(acquireScript).status,0);
  const child=spawn("/usr/sbin/runuser",["--user","nobody","--",executable,"-e",`require(${JSON.stringify(module)}).acquireDatabaseLock({databasePath:${JSON.stringify(databasePath)}});process.stdout.write(String(process.pid));setInterval(()=>{},60000);`],{stdio:["ignore","pipe","pipe"]});
  const [output]=await once(child.stdout,"data"),pid=Number(String(output));assert.ok(pid>0);
  try {assert.throws(()=>lock.acquireDatabaseLock({databasePath}),{code:"DATABASE_IN_USE"});}
  finally {const exited=once(child,"exit");process.kill(pid,"SIGKILL");await exited;}
  const final=lock.acquireDatabaseLock({databasePath});lock.releaseDatabaseLock(final);
  assert.equal(asApplication(acquireScript).status,0);
  for(const file of [lock.lockPathForDatabase(databasePath),lock.sqliteCompatibilityLockPathForDatabase(databasePath)])assert.equal(fs.statSync(file).uid,uid);

  const unsafe=path.join(directory,"wrong-owner.json"),unsafeLock=lock.lockPathForDatabase(unsafe);
  fs.writeFileSync(unsafeLock,"preserve-root-owner",{mode:0o600});
  assert.throws(()=>lock.acquireDatabaseLock({databasePath:unsafe}),{code:"DATABASE_LOCK_PATH_UNSAFE"});
  assert.equal(fs.statSync(unsafeLock).uid,0);
  assert.equal(fs.readFileSync(unsafeLock,"utf8"),"preserve-root-owner");
});
