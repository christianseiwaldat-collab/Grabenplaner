"use strict";
// Authority and cleanup for this test's private Unix-socket PostgreSQL clone.
// This is deliberately not a production process manager or a generic PID API.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const BIN = "/usr/lib/postgresql/18/bin";

function privateRestoreClone(root) {
  if (process.platform !== "linux" || process.getuid() === 0) throw Error("PASSKEY_CLONE_TEST_SCOPE");
  const resolved = fs.realpathSync(root), parent = fs.realpathSync(os.tmpdir()), uid = process.getuid();
  const original = fs.lstatSync(resolved);
  if (resolved !== root || path.dirname(root) !== parent || !/^gp-passkey-restore-native-[A-Za-z0-9]+$/.test(path.basename(root))
    || !original.isDirectory() || original.uid !== uid || (original.mode & 0o077)) throw Error("PASSKEY_CLONE_TEST_SCOPE");
  const data = path.join(root, "cluster"), pidFile = path.join(data, "postmaster.pid");
  const selfStart = fs.readFileSync("/proc/self/stat", "utf8").split(") ")[1].trim().split(/\s+/)[19];
  let bound;
  function authority() {
    const current = fs.lstatSync(root);
    if (current.dev !== original.dev || current.ino !== original.ino || current.uid !== uid || !current.isDirectory()
      || current.isSymbolicLink() || (current.mode & 0o077)
      || fs.realpathSync(root) !== root) throw Error("PASSKEY_CLONE_AUTHORITY_CHANGED");
    if (fs.existsSync(data)) {
      const info = fs.lstatSync(data);
      if (!info.isDirectory() || info.uid !== uid || info.isSymbolicLink() || fs.realpathSync(data) !== data)
        throw Error("PASSKEY_CLONE_AUTHORITY_CHANGED");
    }
  }
  function processIdentity(pid) {
    try {
      const directory = "/proc/" + pid, info = fs.statSync(directory);
      if (info.uid !== uid) throw Error("PASSKEY_CLONE_PID_AUTHORITY");
      const fields = fs.readFileSync(directory + "/stat", "utf8").split(") ")[1].trim().split(/\s+/);
      const start = fields[19];
      if (BigInt(start) < BigInt(selfStart) || fs.realpathSync(directory + "/cwd") !== data
        || fs.realpathSync(directory + "/exe") !== path.join(BIN, "postgres")) throw Error("PASSKEY_CLONE_PID_AUTHORITY");
      return { pid, start };
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes(error.code)) return null;
      throw error;
    }
  }
  function bind() {
    authority();
    if (!fs.existsSync(pidFile)) return null;
    const info = fs.lstatSync(pidFile);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid) throw Error("PASSKEY_CLONE_PID_AUTHORITY");
    const text = fs.readFileSync(pidFile, "utf8").split("\n")[0];
    if (!/^[1-9][0-9]{1,9}$/.test(text)) throw Error("PASSKEY_CLONE_PID_AUTHORITY");
    const identity = processIdentity(Number(text));
    if (!identity) return null;
    if (bound && (identity.pid !== bound.pid || identity.start !== bound.start)) throw Error("PASSKEY_CLONE_PID_REUSED");
    bound = identity;
    return identity;
  }
  function command(name, args, timeout) {
    authority();
    const executable = path.join(BIN, name), info = fs.lstatSync(executable);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)
      || fs.realpathSync(executable) !== executable) throw Error("PASSKEY_CLONE_TOOL_AUTHORITY");
    const result = spawnSync(executable, args, { cwd: root, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      encoding: "utf8", timeout, maxBuffer: 128 * 1024 });
    if (result.error || result.signal) throw Error("PASSKEY_CLONE_TOOL_FAILED");
    return result;
  }
  function assertStopped() {
    authority();
    if (!fs.existsSync(data)) return { started: false, stopped: true };
    if (bind()) throw Error("PASSKEY_CLONE_STILL_RUNNING");
    // No descendant with this exact private data directory may remain after
    // the postmaster PID file disappears. Never signal a PID from this scan.
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^[0-9]+$/.test(entry)) continue;
      try {
        if (fs.statSync("/proc/" + entry).uid === uid && fs.realpathSync("/proc/" + entry + "/cwd") === data
          && fs.realpathSync("/proc/" + entry + "/exe") === path.join(BIN, "postgres"))
          throw Error("PASSKEY_CLONE_STILL_RUNNING");
      } catch (error) { if (!["ENOENT", "ESRCH", "EACCES"].includes(error.code)) throw error; }
    }
    const status = command("pg_ctl", ["-D", data, "status"], 5000);
    if (status.status !== 3 || fs.existsSync(pidFile)) throw Error("PASSKEY_CLONE_STOP_UNPROVEN");
    const control = command("pg_controldata", [data], 5000);
    if (control.status !== 0 || !/^Database cluster state:\s+shut down\s*$/m.test(control.stdout))
      throw Error("PASSKEY_CLONE_CONTROL_NOT_SHUT_DOWN");
    return { started: true, stopped: true, pidBound: !!bound, statusExitCode: 3, controlState: "shut down" };
  }
  function stopAndVerify() {
    authority();
    const identity = bind();
    if (identity) {
      const stopped = command("pg_ctl", ["-D", data, "-m", "fast", "-w", "-t", "50", "stop"], 60000);
      if (stopped.status !== 0) throw Error("PASSKEY_CLONE_STOP_FAILED");
    }
    return assertStopped();
  }
  return Object.freeze({ bind, stopAndVerify, assertStopped });
}
module.exports = { privateRestoreClone };
