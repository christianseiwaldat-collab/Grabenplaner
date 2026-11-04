#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

# Privileged tools may load only the PostgreSQL dependency closure independently
# installed from the original ZIP. Build-user caches and lifecycle hooks are
# never part of this trust boundary.
trusted_file() {
  local value="$1" candidate mode
  [[ "$value" == /* ]] || return 1
  candidate="$(readlink -f -- "$value")" || return 1
  [[ -f "$candidate" && ! -L "$candidate" && "$(stat -c '%u:%h' -- "$candidate")" == '0:1' ]] || return 1
  value="$candidate"
  while :; do
    [[ ! -L "$value" && "$(stat -c '%u' -- "$value")" == 0 ]] || return 1
    mode="$(stat -c '%a' -- "$value")"
    (( (8#$mode & 022) == 0 )) || return 1
    [[ "$value" != / ]] || break
    value="$(dirname -- "$value")"
  done
  printf '%s\n' "$candidate"
}

[[ "${EUID:-$(id -u)}" == 0 && $# -ge 4 && $# -le 5 ]] || exit 1
helper="$(trusted_file "${BASH_SOURCE[0]}")" || exit 1
common="$(trusted_file "$(dirname -- "$helper")/common.sh")" || exit 1
# shellcheck source=server-tools/linux/lib/common.sh
source "$common"
package="$1" app="$2"
node="$(gp_assert_root_node "$3")" || gp_die 'Das privilegierte native Node-Binary ist nicht root-geschuetzt.'
manager_path="$4"
shift 4
[[ $# == 0 || ( $# == 1 && "$1" == pnpm ) ]] || gp_die 'Unerwarteter Paketmanager-Aufruf.'
manager_arguments=("$@")
manager="$(gp_assert_root_package_manager "$manager_path" "${1:-}")" \
  || gp_die 'Die vollstaendige Paketmanager-Installation ist nicht root-geschuetzt.'
gp_verify_sealed_zip "$package" "$app" 1 || gp_die 'Der privilegierte Abhaengigkeitsaufbau benoetigt unveraenderte Original-ZIP-Bytes.'
parent="$(dirname -- "$app")"
[[ "$(realpath -e -- "$parent")" == "$parent" && "$(stat -c '%u' -- "$parent")" == 0 ]] || exit 1
mode="$(stat -c '%a' -- "$parent")"
(( (8#$mode & 022) == 0 )) || exit 1
work="$(mktemp --directory --tmpdir="$parent" .root-pgdeps.XXXXXXXX)"
chmod 0700 -- "$work"
trap 'rm -rf --one-file-system -- "$work"' EXIT
umask 077
mkdir -m 0700 -- "$work/home" "$work/store" "$work/source" "$work/config" "$work/cache" "$work/data"
touch -- "$work/home/empty.npmrc" "$work/home/empty-global.npmrc"

# Only data inputs to the frozen install are extracted. In particular no
# .npmrc, .pnpmfile, application JS, or build user's node_modules is copied.
/usr/bin/python3 -I - "$package" "$work/source" <<'PY'
import json, os, stat, sys, zipfile
from pathlib import Path
package, target = map(Path, sys.argv[1:])
required = {'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'}
found = set()
with zipfile.ZipFile(package) as archive:
    for entry in archive.infolist():
        name = entry.filename.removeprefix('./').rstrip('/')
        if entry.is_dir() or not (name in required or name.startswith('lib/vendor-patches/') and name.endswith('.patch')):
            continue
        parts = name.split('/')
        assert all(p and p not in ('.', '..') for p in parts) and '\\' not in name
        assert not stat.S_ISLNK(entry.external_attr >> 16) and name not in found
        found.add(name)
        file = target.joinpath(*parts)
        file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with file.open('xb') as output, archive.open(entry) as source:
            while chunk := source.read(1024 * 1024):
                output.write(chunk)
assert required <= found
metadata = json.loads((target / 'package.json').read_text())
assert metadata['packageManager'] == 'pnpm@11.7.0' and metadata['dependencies']['pg'] == '8.22.0'
PY

clean=(/usr/bin/env -i HOME="$work/home" XDG_CONFIG_HOME="$work/config" XDG_CACHE_HOME="$work/cache"
  XDG_DATA_HOME="$work/data" PNPM_HOME="$work/home/pnpm" COREPACK_HOME="$work/home/corepack"
  NPM_CONFIG_USERCONFIG="$work/home/empty.npmrc" NPM_CONFIG_GLOBALCONFIG="$work/home/empty-global.npmrc"
  PATH="$(dirname -- "$node"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  LANG=C.UTF-8 NODE_ENV=production CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0)
version="$(cd -- "$work/source" && "${clean[@]}" "$node" --no-global-search-paths "$manager" "${manager_arguments[@]}" --version)"
[[ "$version" == 11.7.0 ]] || gp_die 'Der privilegierte Install benoetigt exakt pnpm 11.7.0.'
# Install the original frozen graph, including optional data packages. pnpm
# 11.7's hoisted --no-optional path can drop snapshots still referenced by the
# hoister. No lifecycle code runs, and only the reviewed PG closure is copied.
(cd -- "$work/source" && "${clean[@]}" "$node" --no-global-search-paths "$manager" "${manager_arguments[@]}" install --prod \
  --frozen-lockfile --ignore-scripts --ignore-pnpmfile --verify-store-integrity \
  --config.side-effects-cache=false --config.node-linker=hoisted \
  --registry=https://registry.npmjs.org --store-dir "$work/store" --package-import-method=copy \
  --reporter=append-only) >&2

# Frozen means no metadata rewrite, even if a package-manager configuration
# changes behavior. A mismatch is a hard failure, never a lock regeneration.
/usr/bin/python3 -I - "$package" "$work/source" <<'PY'
import sys, zipfile
from pathlib import Path
source = Path(sys.argv[2])
with zipfile.ZipFile(sys.argv[1]) as archive:
    for entry in archive.infolist():
        name = entry.filename.removeprefix('./').rstrip('/')
        if not entry.is_dir() and (name in ('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml') or name.startswith('lib/vendor-patches/') and name.endswith('.patch')):
            assert source.joinpath(*name.split('/')).read_bytes() == archive.read(entry)
PY

# Discover dependencies by JSON and Node's own lookup directories, without
# importing package code. Preserve nested/peer layouts and clear optional
# modules absent from the independently verified installation, so a build
# cannot supply a malicious pg-native/other optional fallback.
"${clean[@]}" "$node" --no-global-search-paths - "$work/source" "$app" <<'NODE'
'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const source = fs.realpathSync(process.argv[2]), target = fs.realpathSync(process.argv[3]);
const group = fs.lstatSync(target).gid, selected = new Map(), absent = [];
const moduleName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const inside = (root, value) => value === root || value.startsWith(root + path.sep);
function regular(file) {
  const info = fs.lstatSync(file);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === 0 && info.nlink === 1 && !(info.mode & 0o022), file);
  return info;
}
function directories(from, name) {
  assert.match(name, moduleName);
  return createRequire(path.join(from, 'package.json')).resolve.paths(name) || [];
}
function locate(from, name) {
  for (const base of directories(from, name)) {
    const folder = path.join(base, name), file = path.join(folder, 'package.json');
    if (!fs.existsSync(file)) continue;
    assert.ok(inside(path.join(source, 'node_modules'), folder), 'dependency escaped private install');
    assert.equal(fs.realpathSync(folder), folder);
    regular(file);
    const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(metadata.name, name);
    return { folder, metadata };
  }
  return null;
}
const first = locate(source, 'pg');
assert.ok(first); assert.equal(first.metadata.version, '8.22.0');
const pending = [first];
while (pending.length) {
  const item = pending.shift();
  if (selected.has(item.folder)) continue;
  selected.set(item.folder, item);
  const dependencies = { ...item.metadata.peerDependencies, ...item.metadata.optionalDependencies, ...item.metadata.dependencies };
  for (const name of Object.keys(dependencies || {})) {
    const optional = Object.hasOwn(item.metadata.optionalDependencies || {}, name)
      || item.metadata.peerDependenciesMeta?.[name]?.optional === true;
    const dependency = locate(item.folder, name);
    if (dependency) pending.push(dependency);
    else { assert.ok(optional, 'missing dependency ' + name); absent.push({ from: item.folder, name }); }
  }
}
function copyPackage(from, to, inventory, relative = '') {
  const info = fs.lstatSync(from);
  assert.ok(info.uid === 0 && !info.isSymbolicLink() && !(info.mode & 0o022));
  if (info.isDirectory()) {
    fs.mkdirSync(to, { recursive: true, mode: 0o750 }); fs.chownSync(to, 0, group); fs.chmodSync(to, 0o750);
    for (const entry of fs.readdirSync(from).sort()) if (entry !== 'node_modules') {
      copyPackage(path.join(from, entry), path.join(to, entry), inventory, path.posix.join(relative, entry));
    }
  } else {
    regular(from);
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); fs.chownSync(to, 0, group);
    fs.chmodSync(to, info.mode & 0o111 ? 0o750 : 0o640);
    const original = fs.readFileSync(from), copied = fs.readFileSync(to);
    assert.ok(original.equals(copied));
    inventory.push([relative, crypto.createHash('sha256').update(copied).digest('hex')]);
  }
}
const receipt = [];
for (const item of [...selected.values()].sort((a, b) => a.folder.split(path.sep).length - b.folder.split(path.sep).length || a.folder.localeCompare(b.folder))) {
  const relative = path.relative(source, item.folder), destination = path.join(target, relative);
  assert.ok(inside(path.join(target, 'node_modules'), destination));
  fs.rmSync(destination, { recursive: true, force: true });
  const inventory = []; copyPackage(item.folder, destination, inventory);
  receipt.push({ name: item.metadata.name, version: item.metadata.version, relative, files: inventory.length,
    sha256: crypto.createHash('sha256').update(JSON.stringify(inventory)).digest('hex') });
}
for (const item of absent) {
  const from = path.join(target, path.relative(source, item.from));
  for (const base of directories(from, item.name)) {
    const candidate = path.join(base, item.name);
    if (inside(path.join(target, 'node_modules'), candidate)) fs.rmSync(candidate, { recursive: true, force: true });
  }
}
// Every selected edge must resolve to the same metadata/relative package path
// as the verified private installation, before any privileged driver import.
for (const item of selected.values()) {
  const from = path.join(target, path.relative(source, item.folder));
  for (const name of Object.keys({ ...item.metadata.peerDependencies, ...item.metadata.optionalDependencies, ...item.metadata.dependencies })) {
    const expected = locate(item.folder, name);
    const actual = directories(from, name).map(base => path.join(base, name)).find(folder => fs.existsSync(path.join(folder, 'package.json')));
    if (!expected) assert.equal(actual, undefined, 'untrusted optional dependency shadow ' + name);
    else assert.equal(actual, path.join(target, path.relative(source, expected.folder)));
  }
}
console.log(JSON.stringify({ format: 'gp-root-postgresql-dependencies-v1', packages: receipt,
  absentOptional: [...new Set(absent.map(item => item.name))].sort() }));
NODE
gp_verify_sealed_zip "$package" "$app" 1 || gp_die 'Der privilegierte PG-Install hat urspruengliche Paketdateien veraendert.'
