"use strict";

// An explicit, package-bound Core 5 -> 6 bridge. This helper does not change
// installed files, database contents, credentials, units or module receipts.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const OLD_FINGERPRINT = "21f541a85b74ced5e5b6ec84ff2561badcd6635ad1fceb7438cb32350392cd8c";
const NEW_FINGERPRINT = "f9c09a999f5d6b30c0df35e714d0a5ddf0ca17880ad9190ff4bc5c068c3d95fc";
const REVIEWED_MSAL_PATCH = Object.freeze({ package: "@azure/msal-node@5.4.0", path: "lib/vendor-patches/@azure__msal-node@5.4.0.patch",
  sha256: "bbdf16bb0cf6a18ab384b515bd8a378cc5c736698c486881c60c1cbb1cbeda01" });
// These are the qualified Core 5 checkout/package bytes, including the CRLF
// monitor timer prescribed by the versioned .gitattributes, not git-archive LF.
const OLD_FILES = Object.freeze({
  "server-tools/linux/Caddyfile.in": "faaeae73a0f5303cd6d78396d0a694c2d17225266e9eea41cc5f78882a12eebd",
  "server-tools/linux/grabenplaner-bootstrap-admin.sh.in": "df1a00add79a38710036b6ecb0fa27a013deb457aa7d7a98514a2618d9bab7f1",
  "server-tools/linux/grabenplaner-bootstrap.service.in": "86607aa99f594b87ee8e78e984a0872359b36615f651a05801c295aea826056c",
  "server-tools/linux/grabenplaner.env.example": "7327185db60a9611a17403f470941200c7288fdebad033c42d94fcb85ae780ff",
  "server-tools/linux/grabenplaner-monitor.service.in": "9b7f178b166092070a217cb0a141f210d005a049e8ff3f474321d89eea12ab64",
  "server-tools/linux/grabenplaner-monitor.timer.in": "2de083b0509c4ecc35dd2520996ee40f47046ccaa584d5c8218ff639be77d85d",
  "server-tools/linux/grabenplaner.service.in": "5c4573b3bb91dff0fc6ca4efe4eea3c24755f7efb0a1490d188b4852e7ba9605",
  "server-tools/linux/host-control/lib/host-reboot-broker.js": "2300e0fee92fdda44c864ce8e017613eef3b7485ddbf21b3bb73bb6deac59c15",
  "server-tools/linux/host-control/systemd/grabenplaner-host-control.socket.in": "fadd81279279a3bb83de2a91446656aa8ac9a484760227a6ba9fcf29be0abcec",
  "server-tools/linux/host-control/systemd/grabenplaner-host-control@.service.in": "ae395a80cfa502e2a88c4f7ee607e6f5dd27d547d52bcbb30d3fc5e9b9de9d8b",
  "server-tools/linux/host-control/systemd/grabenplaner-host-reboot.service.in": "fa8dbf18bd933a0e856e02d8b5fd3dc1927196678f9df390acf2ec43e9711490",
});
const NEW_FILES = Object.freeze({ ...OLD_FILES,
  "server-tools/linux/grabenplaner-bootstrap-admin.sh.in": "8046e5f813958241ab60cacfe9857624a20da6c728a250da868fa607879ab5be",
  "server-tools/linux/grabenplaner.env.example": "80f1134a0429e34fb39f54c5cd53d789fccf60d01413a55fe4201250b0449309",
});
const PROTECTED_FILES = Object.freeze({
  environmentSha256: "/etc/grabenplaner/grabenplaner.env",
  applicationSha256: "/etc/grabenplaner/postgresql-application.json",
  operationsSha256: "/etc/grabenplaner/postgresql-operations.json",
  pairSha256: "/var/lib/grabenplaner/data/postgresql-pair.json",
  installedOffsiteReceiptSha256: "/etc/grabenplaner/offsite/installed-contract.json",
  bootstrapCommandSha256: "/usr/local/sbin/grabenplaner-bootstrap-admin",
  repositorySha256: "/etc/grabenplaner/offsite/repository",
  repositoryIdSha256: "/etc/grabenplaner/offsite/repository-id",
  installationIdSha256: "/etc/grabenplaner/offsite/installation-id",
  resticPasswordSha256: "/etc/grabenplaner/offsite/restic-password",
  rclonePasswordSha256: "/etc/grabenplaner/offsite/rclone-config-password",
});
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function read(root, relative) {
  assert(relative && !path.isAbsolute(relative) && !relative.split(/[\\/]/).includes(".."));
  const file = path.join(root, relative), stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  assert.equal(fs.realpathSync(file), path.resolve(file));
  return fs.readFileSync(file);
}
function fingerprint(files) {
  return hash(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([name, digest]) => `${name}\0${digest}\n`).join(""));
}
function validateTransition(oldRoot, candidateRoot) {
  const schema = "server-tools/linux/runtime-schema.json";
  const before = JSON.parse(read(oldRoot, schema)), after = JSON.parse(read(candidateRoot, schema));
  assert.deepEqual(Object.keys(before).sort(), ["deploymentSchemaVersion", "format", "managedArtifacts", "migrationPolicy", "schemaVersion"]);
  assert.equal(before.format, "grabenplaner-linux-runtime-contract");
  assert.equal(before.schemaVersion, 1);
  assert.equal(before.deploymentSchemaVersion, 5);
  assert.equal(after.deploymentSchemaVersion, 6);
  assert.equal(before.migrationPolicy, "explicit-maintenance");
  assert.deepEqual({ ...before, deploymentSchemaVersion: 6 }, after);
  assert.deepEqual([...before.managedArtifacts].sort(), Object.keys(OLD_FILES).sort());
  assert.equal(fingerprint(OLD_FILES), OLD_FINGERPRINT);
  assert.equal(fingerprint(NEW_FILES), NEW_FINGERPRINT);
  for (const relative of Object.keys(OLD_FILES)) {
    assert.equal(hash(read(oldRoot, relative)), OLD_FILES[relative], "Unapproved installed Core 5 bytes: " + relative);
    assert.equal(hash(read(candidateRoot, relative)), NEW_FILES[relative], "Unapproved Core 6 delta: " + relative);
  }
  const oldOffsite = JSON.parse(read(oldRoot, "server-tools/linux/offsite/module-schema.json"));
  const newOffsite = JSON.parse(read(candidateRoot, "server-tools/linux/offsite/module-schema.json"));
  assert.equal(oldOffsite.moduleVersion, 12);
  assert.equal(newOffsite.moduleVersion, 13);
  assert.deepEqual({ ...oldOffsite, moduleVersion: 13 }, newOffsite);
  return { fromSchema: 5, toSchema: 6, providerId: "postgresql", installedFingerprint: OLD_FINGERPRINT,
    candidateFingerprint: NEW_FINGERPRINT, offsiteInstalledRequired: 13, unitsUnchanged: true };
}
function protectedDigest(file) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === 0 && (stat.mode & 0o022) === 0);
  assert.equal(fs.realpathSync(file), file);
  return hash(fs.readFileSync(file));
}
function protectedBindings() {
  return Object.fromEntries(Object.entries(PROTECTED_FILES).map(([key, file]) => [key, protectedDigest(file)]));
}
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
function trustedDependencyBinLink(file, dependencyRoot, requireRoot) {
  // Resolve each raw component before accepting it. A path which leaves this
  // dependency tree and subsequently points back in must never be trusted.
  const inside = target => target === dependencyRoot || (!path.relative(dependencyRoot, target).startsWith(".." + path.sep)
    && path.relative(dependencyRoot, target) !== ".." && !path.isAbsolute(path.relative(dependencyRoot, target)));
  const metadata = s => [s.dev, s.ino, s.uid, s.gid, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(":");
  const regular = target => {
    const s = fs.lstatSync(target);
    assert(!s.isSymbolicLink() && (!requireRoot || s.uid === 0) && (s.mode & 0o022) === 0
      && (s.isDirectory() || (s.isFile() && s.nlink === 1)) && fs.realpathSync(target) === target,
    "Unsafe dependency command target");
    return s;
  };
  const first = fs.lstatSync(file);
  let cursor = dependencyRoot, firstDestination;
  regular(cursor);
  for (const part of path.relative(dependencyRoot, path.dirname(file)).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    assert(regular(cursor).isDirectory(), "Unsafe dependency command parent");
  }
  let pending = [path.basename(file)];
  const links = new Set();
  while (pending.length) {
    const part = pending.shift();
    if (!part || part === ".") continue;
    if (part === "..") {
      cursor = path.dirname(cursor);
      assert(inside(cursor) && regular(cursor).isDirectory(), "Dependency command left its tree");
      continue;
    }
    const target = path.join(cursor, part), s = fs.lstatSync(target);
    if (s.isSymbolicLink()) {
      assert(inside(target) && path.basename(path.dirname(target)) === ".bin"
        && path.basename(path.dirname(path.dirname(target))) === "node_modules"
        && (!requireRoot || s.uid === 0) && s.nlink === 1 && !links.has(target) && links.size < 64,
      "Unsafe dependency command link");
      links.add(target);
      const destination = fs.readlinkSync(target);
      assert(destination && metadata(fs.lstatSync(target)) === metadata(s), "Dependency command link changed");
      if (target === file) firstDestination = destination;
      if (path.isAbsolute(destination)) {
        assert(destination.startsWith(dependencyRoot + path.sep), "Dependency command left its tree");
        cursor = dependencyRoot;
        pending = destination.slice(dependencyRoot.length + 1).split(path.sep).concat(pending);
      } else pending = destination.split(path.sep).concat(pending);
    } else {
      cursor = target;
      const checked = regular(cursor);
      assert(!pending.length || checked.isDirectory(), "Unsafe dependency command traversal");
    }
  }
  assert(inside(cursor) && regular(cursor).isFile(), "Dependency command is not an internal regular file");
  assert(firstDestination && metadata(fs.lstatSync(file)) === metadata(first)
    && fs.readlinkSync(file) === firstDestination, "Dependency command changed during resolution");
  return { rawTarget: firstDestination, resolvedTarget: cursor };
}
function dependencyInventory(directory, requireRoot) {
  directory = path.resolve(directory);
  const files = [];
  let regularFileCount = 0, symbolicLinkCount = 0;
  const metadata = s => [s.dev, s.ino, s.uid, s.gid, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(":");
  function digestRegular(file) {
    const before = fs.lstatSync(file);
    assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && fs.realpathSync(file) === file);
    if (requireRoot) assert(before.uid === 0 && (before.mode & 0o022) === 0);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      assert.equal(metadata(fs.fstatSync(fd)), metadata(before));
      const digest = hash(fs.readFileSync(fd));
      assert.equal(metadata(fs.fstatSync(fd)), metadata(before));
      assert.equal(metadata(fs.lstatSync(file)), metadata(before));
      return digest;
    } finally { fs.closeSync(fd); }
  }
  function visit(file, relative = "") {
    const info = fs.lstatSync(file);
    if (info.isSymbolicLink()) {
      const link = trustedDependencyBinLink(file, directory, requireRoot);
      // A typed record prevents a regular file containing the link text from
      // impersonating a link. Both the literal link and final bytes are bound.
      files.push([relative, "symlink:" + hash(Buffer.from(JSON.stringify([
        link.rawTarget, path.relative(directory, link.resolvedTarget), digestRegular(link.resolvedTarget)
      ]), "utf8"))]);
      symbolicLinkCount++;
      return;
    }
    assert.equal(fs.realpathSync(file), path.resolve(file));
    assert(!info.isSymbolicLink() && (info.isFile() || info.isDirectory()));
    if (requireRoot) assert(info.uid === 0 && (info.mode & 0o022) === 0);
    if (info.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), relative ? relative + "/" + name : name);
    } else {
      assert.equal(info.nlink, 1); files.push([relative, digestRegular(file)]); regularFileCount++;
    }
  }
  visit(directory);
  assert(files.length > 0);
  return { sha256: hash(files.map(([name, digest]) => name + "\0" + digest + "\n").join("")),
    fileCount: files.length, regularFileCount, symbolicLinkCount };
}
function verifyDependencyContinuity(oldRoot, candidateRoot, { requireRoot = process.platform === "linux" } = {}) {
  for (const root of [oldRoot, candidateRoot]) for (const relative of ["package.json", "pnpm-lock.yaml"]) {
    const file = path.join(root, relative), info = fs.lstatSync(file);
    assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && fs.realpathSync(file) === path.resolve(file));
    if (requireRoot) assert(info.uid === 0 && (info.mode & 0o022) === 0);
  }
  const previous = JSON.parse(read(oldRoot, "package.json")), candidate = JSON.parse(read(candidateRoot, "package.json"));
  assert.deepEqual(read(oldRoot, "pnpm-lock.yaml"), read(candidateRoot, "pnpm-lock.yaml"), "The Core6 bridge requires the exact installed frozen lock bytes");
  for (const key of ["packageManager", "dependencies", "optionalDependencies", "peerDependencies", "pnpm"]) {
    assert.equal(canonical(previous[key]), canonical(candidate[key]), "Runtime dependency metadata changed: " + key);
  }
  assert.equal(previous.dependencies?.pg, candidate.dependencies?.pg);
  assert(typeof previous.dependencies?.pg === "string" && previous.packageManager?.startsWith("pnpm@"));
  const original = dependencyInventory(path.join(oldRoot, "node_modules"), requireRoot);
  const target = path.join(candidateRoot, "node_modules");
  const copied = fs.existsSync(target) ? dependencyInventory(target, requireRoot) : null;
  if (copied) assert.deepEqual(copied, original, "Copied runtime dependencies differ from the qualified installed tree");
  return { exactLock: true, packageManager: previous.packageManager, lockSha256: hash(read(oldRoot, "pnpm-lock.yaml")),
    dependencySource: "qualified-root-owned-installed-tree", ...original, copiedTreeVerified: Boolean(copied) };
}
function verifyFrozenDependencyPlan(oldRoot, candidateRoot, { requireRoot = process.platform === "linux" } = {}) {
  const metadata = root => {
    const files = {};
    for (const relative of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
      const file = path.join(root, relative), info = fs.lstatSync(file);
      assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && fs.realpathSync(file) === path.resolve(file));
      if (requireRoot) assert(info.uid === 0 && (info.mode & 0o022) === 0);
      files[relative] = read(root, relative);
    }
    return { package: JSON.parse(files["package.json"]), packageSha256: hash(files["package.json"]), lockSha256: hash(files["pnpm-lock.yaml"]),
      workspace: files["pnpm-workspace.yaml"], workspaceSha256: hash(files["pnpm-workspace.yaml"]) };
  };
  const previous = metadata(oldRoot), candidate = metadata(candidateRoot);
  for (const key of ["packageManager", "dependencies", "optionalDependencies", "peerDependencies", "pnpm"]) {
    assert.equal(canonical(previous.package[key]), canonical(candidate.package[key]), "Unqualified dependency metadata changed: " + key);
  }
  assert.equal(candidate.package.packageManager, "pnpm@11.7.0");
  assert.equal(candidate.package.dependencies?.pg, "8.22.0");
  const withoutReviewedWorkspaceDeltas = bytes => {
    const text = bytes.toString("utf8"), remaining = [];
    assert(Buffer.from(text, "utf8").equals(bytes));
    let section = null, bodyParser = null, msalPatch = null, canvas = null;
    const seenSections = new Set();
    const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const value = line.replace(/\r?\n$/, "");
      if (value === "overrides:" || value === "patchedDependencies:") {
        assert(!seenSections.has(value)); seenSections.add(value); section = value;
      } else if (/^[^\s#]/.test(value)) section = null;
      if (value === "  # Reviewed CVE-2026-111181 security fix; keep the Express major unchanged.") {
        assert(section === "overrides:" && lines[index + 1]?.replace(/\r?\n$/, "") === "  body-parser: 2.4.0");
      } else if (value === "  body-parser: 2.4.0") {
        assert(section === "overrides:" && bodyParser === null, "Body-parser override must occur once inside overrides");
        bodyParser = "2.4.0";
      } else if (value === "  # Native parser/encoder fixes and platform SBOM; qualify PDF/OCR before release.") {
        assert(section === "overrides:" && lines[index + 1]?.replace(/\r?\n$/, "") === "  'pdfjs-dist>@napi-rs/canvas': 1.0.13");
      } else if (value === "  'pdfjs-dist>@napi-rs/canvas': 1.0.13") {
        assert(section === "overrides:" && canvas === null, "The reviewed Canvas override must occur once inside overrides");
        canvas = "1.0.13";
      } else if (value === "  '@azure/msal-node@5.4.0': lib/vendor-patches/@azure__msal-node@5.4.0.patch") {
        assert(section === "patchedDependencies:" && msalPatch === null, "The reviewed MSAL patch must occur once inside patchedDependencies");
        msalPatch = REVIEWED_MSAL_PATCH.sha256;
      } else remaining.push(line);
    }
    return { bytes: Buffer.from(remaining.join(""), "utf8"), bodyParser, msalPatch, canvas };
  };
  const before = withoutReviewedWorkspaceDeltas(previous.workspace), after = withoutReviewedWorkspaceDeltas(candidate.workspace);
  assert(before.bytes.equals(after.bytes), "Unqualified pnpm workspace metadata changed");
  assert(before.bodyParser === after.bodyParser || after.bodyParser === "2.4.0", "Only the reviewed body-parser security override is permitted");
  assert(before.canvas === after.canvas || after.canvas === "1.0.13", "Removing the reviewed Canvas override is not permitted");
  assert(before.msalPatch === after.msalPatch || after.msalPatch === REVIEWED_MSAL_PATCH.sha256, "Removing the reviewed MSAL security patch is not permitted");
  for (const [root, workspace] of [[oldRoot, before], [candidateRoot, after]]) if (workspace.msalPatch) {
    const file = path.join(root, REVIEWED_MSAL_PATCH.path), info = fs.lstatSync(file);
    if (requireRoot) assert(info.uid === 0 && (info.mode & 0o022) === 0);
    assert.equal(hash(read(root, REVIEWED_MSAL_PATCH.path)), REVIEWED_MSAL_PATCH.sha256, "Unqualified MSAL patch bytes changed");
  }
  const original = dependencyInventory(path.join(oldRoot, "node_modules"), requireRoot);
  return { format: "grabenplaner-runtime-v6-frozen-dependency-plan", schemaVersion: 1,
    predecessorRoot: path.resolve(oldRoot), predecessor: { packageSha256: previous.packageSha256, lockSha256: previous.lockSha256, workspaceSha256: previous.workspaceSha256, ...original },
    candidate: { packageSha256: candidate.packageSha256, lockSha256: candidate.lockSha256, workspaceSha256: candidate.workspaceSha256, packageManager: candidate.package.packageManager },
    reviewedBodyParserOverride: { previous: before.bodyParser ?? null, candidate: after.bodyParser ?? null },
    reviewedCanvasOverride: { previous: before.canvas, candidate: after.canvas },
    reviewedMsalPatch: { package: REVIEWED_MSAL_PATCH.package, path: REVIEWED_MSAL_PATCH.path, previous: before.msalPatch, candidate: after.msalPatch },
    requirements: { originalZipByteBinding: true, unprivilegedFrozenProductionBuild: true,
      freshRootPostgresqlClosureBeforePreflight: true, freshRootPostgresqlClosureAfterBuild: true } };
}
function validateInvocation({ transitionFile, marker, script, packageSha256, uid = process.getuid?.() }) {
  assert.equal(uid, 0);
  const parent = path.dirname(marker);
  assert.match(parent, /^\/opt\/grabenplaner\/\.runtime-v6-migration\.[A-Za-z0-9]+$/);
  assert.equal(marker, path.join(parent, "updater-commit.json"));
  assert.equal(transitionFile, path.join(parent, "transition.json"));
  assert.equal(script, path.join(parent, "extract/server-tools/linux/update-grabenplaner-server.sh"));
  for (let directory = parent; ; directory = path.dirname(directory)) {
    const info = fs.lstatSync(directory);
    assert(info.isDirectory() && !info.isSymbolicLink() && info.uid === 0 && (info.mode & 0o022) === 0);
    if (directory === parent) assert.equal(info.mode & 0o777, 0o711);
    if (directory === "/") break;
  }
  const stat = fs.lstatSync(transitionFile);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === 0 && (stat.mode & 0o777) === 0o600);
  const value = JSON.parse(fs.readFileSync(transitionFile, "utf8"));
  assert.equal(value.format, "grabenplaner-runtime-v6-transition");
  assert.equal(value.schemaVersion, 2);
  assert.equal(value.providerId, "postgresql");
  assert.equal(value.packageSha256, packageSha256);
  assert.match(packageSha256, /^[a-f0-9]{64}$/);
  assert.equal(value.candidateRoot, path.join(parent, "extract"));
  assert.equal(value.installedFingerprint, OLD_FINGERPRINT);
  assert.equal(value.candidateFingerprint, NEW_FINGERPRINT);
  assert.equal(value.dependencyPlan?.predecessorRoot, "/opt/grabenplaner/app");
  assert.deepEqual(value.dependencyPlan, verifyFrozenDependencyPlan("/opt/grabenplaner/app", value.candidateRoot));
  assert.deepEqual(value.bindings, protectedBindings());
  assert.equal(JSON.parse(fs.readFileSync(PROTECTED_FILES.installedOffsiteReceiptSha256, "utf8")).moduleVersion, 13);
  return value;
}
module.exports = { OLD_FILES, NEW_FILES, OLD_FINGERPRINT, NEW_FINGERPRINT, PROTECTED_FILES,
  validateTransition, validateInvocation, protectedBindings, verifyDependencyContinuity, verifyFrozenDependencyPlan };
if (require.main === module) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "verify") console.log(JSON.stringify(validateTransition(...args)));
    else if (command === "invocation") {
      const [transitionFile, marker, script, packageSha256] = args;
      console.log(JSON.stringify(validateInvocation({ transitionFile, marker, script, packageSha256 })));
    } else if (command === "dependencies") {
      assert.equal(process.getuid?.(), 0);
      console.log(JSON.stringify(verifyDependencyContinuity(...args)));
    } else if (command === "dependency-plan") {
      assert.equal(process.getuid?.(), 0);
      console.log(JSON.stringify(verifyFrozenDependencyPlan(...args)));
    } else if (command === "create") {
      const [oldRoot, candidateRoot, packageSha256, output] = args;
      assert.equal(process.getuid?.(), 0); assert.match(packageSha256, /^[a-f0-9]{64}$/);
      const delta = validateTransition(oldRoot, candidateRoot);
      const value = { format: "grabenplaner-runtime-v6-transition", schemaVersion: 2, providerId: "postgresql", candidateRoot,
        packageSha256, installedFingerprint: delta.installedFingerprint, candidateFingerprint: delta.candidateFingerprint,
        dependencyPlan: verifyFrozenDependencyPlan(oldRoot, candidateRoot), bindings: protectedBindings() };
      fs.writeFileSync(output, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
    } else throw new Error("Unsupported command");
  } catch (error) { console.error("Runtime-v6 transition rejected: " + error.message); process.exitCode = 1; }
}
