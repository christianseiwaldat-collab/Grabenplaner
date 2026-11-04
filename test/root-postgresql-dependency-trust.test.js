"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const repository = path.resolve(__dirname, ".."), read = name => fs.readFileSync(path.join(repository, name), "utf8").replaceAll("\r\n", "\n");

test("installer seals original ZIP bytes twice before loading the independently prepared privileged PG closure", () => {
  const source = read("server-tools/linux/install-grabenplaner-server.sh");
  const nodeGuard = source.indexOf('NODE_EXECUTABLE="$(gp_assert_root_node');
  const firstNode = source.indexOf("\nvalidate_node_version\n");
  assert.ok(nodeGuard > 0 && nodeGuard < firstNode);
  assert.ok(source.indexOf("unset NODE_OPTIONS NODE_PATH BASH_ENV") < nodeGuard);
  assert.match(source, /root_node\(\) \{\n  \/usr\/bin\/env -i/);
  assert.match(source.match(/^root_node\(\) \{[\s\S]*?^\}/m)?.[0] || "", /--no-global-search-paths/);
  assert.doesNotMatch(source, /\$SCRIPT_DIR\/postgresql\/preflight-install/);
  assert.doesNotMatch(source, /render_template "\$SCRIPT_DIR/);
  const extracted = source.indexOf('gp_seal_build_tree "$STAGE_ROOT/source-extracted-untrusted"');
  const initialProof = source.indexOf('gp_verify_sealed_zip "$STAGE_ROOT/package.zip" "$STAGE_ROOT/source" 0');
  const manifest = source.indexOf("\nvalidate_manifest\n", extracted);
  const documents = source.indexOf('root_node "$STAGE_ROOT/source/server-tools/linux/postgresql/preflight-install.js" documents', manifest);
  const identities = source.indexOf('getent group "$SERVICE_GROUP"', documents);
  assert.ok(manifest < documents && documents < identities);
  const build = source.indexOf('"${PNPM_COMMAND[@]}" install --prod', manifest);
  const ready = source.indexOf('gp_seal_build_tree "$STAGE_ROOT/source-built-untrusted"', build);
  const finalProof = source.indexOf('gp_verify_sealed_zip "$STAGE_ROOT/package.zip" "$STAGE_ROOT/source" 1', ready);
  const dependencies = source.indexOf('gp_prepare_root_pg_dependencies "$STAGE_ROOT/package.zip"', finalProof);
  const preflight = source.indexOf('"$STAGE_ROOT/source/server-tools/linux/postgresql/preflight-install.js" check', dependencies);
  assert.ok(extracted > 0 && extracted < initialProof && initialProof < manifest && manifest < build
    && build < ready && ready < finalProof && finalProof < dependencies && dependencies < preflight);
  assert.doesNotMatch(source.slice(build, preflight), /chown -hR root/);
});

test("privileged dependency preparation has no script, hook, stale-store or lockfile-regeneration fallback", () => {
  const source = read("server-tools/linux/lib/root-postgresql-dependencies.sh");
  for (const option of ["--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile", "--verify-store-integrity",
    "--config.side-effects-cache=false", "--package-import-method=copy", '--store-dir "$work/store"']) assert.ok(source.includes(option), option);
  assert.match(source, /env -i HOME="\$work\/home"/);
  assert.match(source, /version" == 11\.7\.0/);
  assert.doesNotMatch(source, /--(?:no-frozen-lockfile|fix-lockfile|update-checksums|force)\b/);
  assert.match(source, /peerDependencies/); assert.match(source, /optionalDependencies/);
  assert.match(source, /untrusted optional dependency shadow/);
  assert.equal(source.match(/"\$node" --no-global-search-paths/g)?.length, 3);
});

const native = process.platform === "linux" && process.getuid?.() === 0
  && process.env.GP_ROOT_PG_TRUST_FIXTURE;
test("native root PG preparation refuses builder source forgery and replaces every untrusted PG dependency edge", {
  skip: !native, timeout: 180000,
}, async t => {
  assert.equal(os.hostname(), "isolated-gp-postgresql-only");
  const base = path.resolve(process.env.GP_ROOT_PG_TRUST_FIXTURE);
  assert.match(base, /^\/opt\/gpcheck-root-pg-[a-f0-9-]{36}$/);
  assert.equal(fs.realpathSync(base), base);
  const owner = fs.statSync(base); assert.equal(owner.uid, 0); assert.equal(owner.mode & 0o022, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(base, "fixture.json"))), { format: "owned-root-pg-dependency-fixture-v1" });
  const clean = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", HOME: base, LANG: "C.UTF-8" };
  const run = (binary, args, options = {}) => spawnSync(binary, args, { env: clean, encoding: "utf8", timeout: 30000, ...options });
  const command = (binary, args, options) => { const result = run(binary, args, options); assert.equal(result.status, 0, result.stderr + result.stdout); return result; };
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  function fixture(mode = "normal") {
    const root = path.join(base, crypto.randomUUID()); fs.mkdirSync(root, { mode: 0o755 });
    const source = path.join(root, "build"), app = path.join(root, "app"), archive = path.join(root, "package.zip");
    fs.mkdirSync(source, { mode: 0o755 });
    const write = (relative, value) => { const file = path.join(source, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
    for (const file of ["common.sh", "root-postgresql-dependencies.sh"]) write("server-tools/linux/lib/" + file, read("server-tools/linux/lib/" + file));
    write("server-tools/linux/update-grabenplaner-server.sh", "#!/usr/bin/env bash\nexit 0\n");
    write("package.json", JSON.stringify({ name: "synthetic-root-pg", packageManager: "pnpm@11.7.0", dependencies: { pg: "8.22.0" },
      scripts: { preinstall: "node -e \"require('fs').writeFileSync('FORBIDDEN-HOOK','root')\"" } }));
    write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n"); write("pnpm-workspace.yaml", "packages: []\n");
    write("grabenplaner-server-manifest.json", JSON.stringify({ syntheticOriginal: true }));
    write("probe.js", "const assert=require('node:assert/strict'),pg=require('pg');assert.equal(pg.pool,'verified');assert.equal(pg.nested,'6');assert.throws(()=>pg.native(),/Cannot find module/);console.log('verified closure');\n");
    command("/usr/bin/python3", ["-I", "-c", "import sys,zipfile;from pathlib import Path;r=Path(sys.argv[1]);z=zipfile.ZipFile(sys.argv[2],'w');[z.write(p,p.relative_to(r).as_posix()) for p in r.rglob('*') if p.is_file()];z.close()", source, archive]);
    const marker = path.join(root, "FORBIDDEN-ROOT-EXEC"), calls = path.join(root, "manager-calls");
    const distribution = path.join(root, "pnpm-package"); fs.mkdirSync(distribution, { mode: 0o755 });
    fs.writeFileSync(path.join(distribution, "package.json"), JSON.stringify({ name: "pnpm", version: "11.7.0", bin: { pnpm: "bin/pnpm.mjs" } }));
    fs.mkdirSync(path.join(distribution, "bin")); fs.mkdirSync(path.join(distribution, "dist"));
    const manager = path.join(distribution, "bin/pnpm.mjs");
    fs.writeFileSync(manager, "import '../dist/pnpm.mjs';\n");
    const implementation = path.join(distribution, "dist/pnpm.mjs");
    fs.writeFileSync(implementation, `
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
const mode=${JSON.stringify(mode)},calls=${JSON.stringify(calls)},args=process.argv.slice(2);
fs.appendFileSync(calls,JSON.stringify(args)+'\\n');
if(JSON.stringify(args)==='["--version"]'){console.log('11.7.0');process.exit(0);}
for(const option of ['--ignore-scripts','--ignore-pnpmfile','--verify-store-integrity','--frozen-lockfile','--config.side-effects-cache=false','--package-import-method=copy'])assert.ok(args.includes(option));
for(const name of ['NODE_OPTIONS','NODE_PATH','BASH_ENV','NPM_CONFIG_REGISTRY'])assert.equal(process.env[name],undefined);
assert.ok(path.basename(path.dirname(process.env.HOME)).startsWith('.root-pgdeps.'));
const root=process.cwd();assert.equal(path.basename(root),'source');assert.ok(path.basename(path.dirname(root)).startsWith('.root-pgdeps.'));
function packageData(name,version,relative,code,extra={}){
 const folder=path.join(root,'node_modules',relative);fs.mkdirSync(path.join(folder,'lib'),{recursive:true});
 fs.writeFileSync(path.join(folder,'package.json'),JSON.stringify({name,version,main:'lib/index.js',...extra}));fs.writeFileSync(path.join(folder,'lib/index.js'),code);
}
packageData('pg','8.22.0','pg',"exports.pool=require('pg-pool');exports.nested=require('pg-types');exports.native=()=>require('pg-native');",{dependencies:{'pg-pool':'1','pg-types':'6'},peerDependencies:{'pg-native':'*'},peerDependenciesMeta:{'pg-native':{optional:true}}});
packageData('pg-pool','1','pg-pool',"module.exports='verified';",{peerDependencies:{pg:'*'},dependencies:{'pg-types':'5'}});
packageData('pg-types','5','pg-types',"module.exports='5';");
packageData('pg-types','6','pg/node_modules/pg-types',"module.exports='6';");
if(mode==='rewrite-lock')fs.writeFileSync(path.join(root,'pnpm-lock.yaml'),'unexpected rewrite');
`); fs.chmodSync(manager, 0o755);
    const shell = body => command("/usr/bin/bash", ["-c", "source " + quote(path.join(repository, "server-tools/linux/lib/common.sh")) + "; " + body]);
    return { root, source, app, archive, marker, calls, manager, implementation, write, shell,
      seal() { command("/usr/bin/chown", ["-R", "gpcheck:gpcheck", source]); shell("gp_seal_build_tree " + quote(source) + " " + quote(app) + " root"); },
      prepare(poison = false) { return run("/usr/bin/bash", ["-c", "source " + quote(path.join(repository, "server-tools/linux/lib/common.sh"))
        + "; gp_prepare_root_pg_dependencies " + [archive, app, "/usr/bin/node", manager].map(quote).join(" ")],
        { env: poison ? { ...clean, NODE_OPTIONS: "--require=" + path.join(app, "node_modules/untrusted-preload.js"),
          NODE_PATH: path.join(app, "node_modules"), NPM_CONFIG_REGISTRY: "https://untrusted.invalid" } : clean }); },
    };
  }
  await t.test("builder PG code, nested dependency and missing optional peer never execute as root", () => {
    const item = fixture();
    const evil = "require('fs').writeFileSync(" + JSON.stringify(item.marker) + ",'root');module.exports='untrusted';";
    for (const relative of ["node_modules/pg/index.js", "node_modules/pg/lib/node_modules/pg-pool/index.js", "node_modules/pg-native/index.js", "node_modules/untrusted-preload.js"]) item.write(relative, evil);
    item.seal(); const result = item.prepare(true); assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /gp-root-postgresql-dependencies-v1/);
    assert.match(command("/usr/bin/node", [path.join(item.app, "probe.js")]).stdout, /verified closure/);
    assert.equal(fs.existsSync(item.marker), false); assert.equal(fs.existsSync(path.join(item.app, "FORBIDDEN-HOOK")), false);
    assert.equal(fs.existsSync(path.join(item.app, "node_modules/pg-native")), false);
  });
  await t.test("changing both application source and its manifest fails before package-manager/root candidate execution", () => {
    const item = fixture(); item.write("probe.js", "require('fs').writeFileSync(" + JSON.stringify(item.marker) + ",'root')");
    item.write("grabenplaner-server-manifest.json", JSON.stringify({ forged: crypto.createHash("sha256").update(fs.readFileSync(path.join(item.source, "probe.js"))).digest("hex") }));
    item.seal(); assert.notEqual(item.prepare().status, 0); assert.equal(fs.existsSync(item.calls), false); assert.equal(fs.existsSync(item.marker), false);
  });
  await t.test("a build-owned package-manager entrypoint is refused before its version command", () => {
    const item = fixture(); item.seal(); command("/usr/bin/chown", ["gpcheck:gpcheck", item.manager]);
    assert.notEqual(item.prepare().status, 0); assert.equal(fs.existsSync(item.calls), false);
  });
  await t.test("a build-owned implementation sibling is refused before a protected package-manager entry executes", () => {
    const item = fixture(); item.seal();
    fs.writeFileSync(item.implementation, "import fs from 'node:fs';fs.writeFileSync(" + JSON.stringify(item.marker) + ",'root');");
    command("/usr/bin/chown", ["gpcheck:gpcheck", item.implementation]);
    assert.notEqual(item.prepare().status, 0); assert.equal(fs.existsSync(item.calls), false); assert.equal(fs.existsSync(item.marker), false);
  });
  await t.test("symlinked and group-writable package-manager siblings are refused before execution", () => {
    for (const mode of ["symlink", "writable"]) {
      const item = fixture(); item.seal();
      if (mode === "symlink") {
        const replacement = path.join(item.root, "outside.mjs");
        fs.renameSync(item.implementation, replacement); fs.symlinkSync(replacement, item.implementation);
      } else fs.chmodSync(item.implementation, 0o664);
      assert.notEqual(item.prepare().status, 0); assert.equal(fs.existsSync(item.calls), false);
    }
  });
  await t.test("an untrusted node is refused before its first version command and inherited preload is never executed", () => {
    const item = fixture();
    const binary = path.join(item.root, "node");
    fs.writeFileSync(binary, "#!/usr/bin/bash\nprintf forbidden > " + quote(item.marker) + "\n"); fs.chmodSync(binary, 0o755);
    command("/usr/bin/chown", ["gpcheck:gpcheck", binary]);
    const result = run("/usr/bin/bash", ["-c", "source " + quote(path.join(repository, "server-tools/linux/lib/common.sh"))
      + "; verified=$(gp_assert_root_node " + quote(binary) + ") && \"$verified\" --version"]);
    assert.notEqual(result.status, 0); assert.equal(fs.existsSync(item.marker), false);
    // Even a root-owned shell wrapper cannot serve as the privileged runtime.
    command("/usr/bin/chown", ["root:root", binary]);
    assert.notEqual(run("/usr/bin/bash", ["-c", "source " + quote(path.join(repository, "server-tools/linux/lib/common.sh")) + "; gp_assert_root_node " + quote(binary)]).status, 0);
    fs.copyFileSync("/usr/bin/node", binary); fs.chmodSync(binary, 0o755);
    command("/usr/bin/chown", ["gpcheck:gpcheck", binary]);
    assert.notEqual(run("/usr/bin/bash", ["-c", "source " + quote(path.join(repository, "server-tools/linux/lib/common.sh")) + "; gp_assert_root_node " + quote(binary)]).status, 0,
      "a native ELF also requires root ownership before its first version call");
    const preload = path.join(item.root, "preload.cjs");
    const preloadMarker = path.join(item.root, "PRELOAD-CONTROL");
    fs.writeFileSync(preload, "require('node:fs').writeFileSync(" + JSON.stringify(preloadMarker) + ",'root');");
    const poison = { ...clean, NODE_OPTIONS: "--require=" + preload, NODE_PATH: item.root };
    command("/usr/bin/node", ["-p", "process.arch"], { env: poison });
    assert.equal(fs.existsSync(preloadMarker), true, "positive control proves the preload would execute"); fs.unlinkSync(preloadMarker);
    const installer = read("server-tools/linux/install-grabenplaner-server.sh");
    const rootNode = installer.match(/^root_node\(\) \{[\s\S]*?^\}/m)?.[0]; assert.ok(rootNode);
    const version = run("/usr/bin/bash", ["-c", "source " + quote(path.join(repository, "server-tools/linux/lib/common.sh"))
      + "; NODE_EXECUTABLE=$(gp_assert_root_node /usr/bin/node) || exit 1; " + rootNode + "; root_node --version; root_node -p process.arch"],
      { env: poison });
    assert.equal(version.status, 0, version.stderr); assert.match(version.stdout, /^v\d+\./); assert.equal(fs.existsSync(item.marker), false);
    assert.equal(fs.existsSync(preloadMarker), false);
  });
  await t.test("unexpected lockfile rewriting fails without a fallback install", () => {
    const item = fixture("rewrite-lock"); item.seal(); assert.notEqual(item.prepare().status, 0);
    assert.equal(fs.readFileSync(item.calls, "utf8").trim().split("\n").length, 2);
  });
  await t.test("privileged Node excludes optional packages from an unrelated global HOME", () => {
    const home = path.join(base, crypto.randomUUID()); fs.mkdirSync(home, { mode: 0o755 });
    const folder = path.join(home, ".node_modules", "pg-native"); fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "index.js"), "module.exports='unverified-global-shadow';\n");
    const env = { ...clean, HOME: home };
    const control = command("/usr/bin/node", ["-e", "console.log(require('pg-native'))"], { env, cwd: home });
    assert.match(control.stdout, /unverified-global-shadow/);
    const protectedLookup = command("/usr/bin/node", ["--no-global-search-paths", "-e",
      "const a=require('node:assert/strict');a.throws(()=>require('pg-native'),e=>e.code==='MODULE_NOT_FOUND');a.deepEqual(require('node:module').globalPaths,[])"], { env, cwd: home });
    assert.equal(protectedLookup.stdout, "");
  });
});
