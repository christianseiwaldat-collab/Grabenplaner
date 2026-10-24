"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repository = path.resolve(__dirname, "..");
const builder = fs.readFileSync(path.join(repository, "server-tools/package/New-GrabenplanerLinuxServerPackage.ps1"), "utf8");
const definition = name => {
  const body = builder.match(new RegExp(`^function ${name}\\([^]*?^\\}`, "m"))?.[0];
  assert.ok(body, name);
  return body;
};
const guard = definition("Assert-BundledPasswordPolicy");
const check = guard.match(/\$check = @'\r?\n([\s\S]*?)\r?\n'@/)?.[1];
assert.ok(check, "the actual builder corpus check must be extracted");
const files = ["lib/portal-password-policy.js", "lib/password-policy/manifest.json",
  "lib/password-policy/common-sha256.txt", "lib/password-policy/breached-sha256.bin"];
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "gp-password-package-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(parent)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const source = path.join(parent, "source");
  for (const relative of files) {
    const target = path.join(source, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repository, relative), target, fs.constants.COPYFILE_EXCL);
  }
  return { parent, source, common: path.join(source, files[2]), breached: path.join(source, files[3]) };
}

function runCheck(root) {
  const result = spawnSync(process.execPath, ["--no-global-search-paths", "-e", check, root], {
    encoding: "utf8", timeout: 15000, maxBuffer: 128 * 1024, windowsHide: true,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      TEMP: os.tmpdir(), TMP: os.tmpdir() },
  });
  assert.ifError(result.error);
  return result;
}

function rejected(root) {
  const result = runCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Bundled password corpus is unavailable or fails its integrity contract/);
  assert.equal(result.stdout, "");
}

test("hash-bound common corpus retains its canonical LF bytes on Windows checkouts", () => {
  const relative = files[2], bytes = fs.readFileSync(path.join(repository, relative));
  const expected = JSON.parse(fs.readFileSync(path.join(repository, files[1]), "utf8")).artifacts.common;
  assert.equal(bytes.length, expected.bytes);
  assert.equal(hash(bytes), expected.sha256);
  assert.equal(bytes.includes(13), false);
  const attributes = spawnSync("git", ["check-attr", "text", "--", relative], {
    cwd: repository, encoding: "utf8", windowsHide: true, timeout: 10000,
  });
  assert.ifError(attributes.error);
  assert.equal(attributes.status, 0, attributes.stderr);
  assert.equal(attributes.stdout.trim(), `${relative}: text: unset`);
});

test("Linux builder checks the actual corpus before ZIP and after extraction in fresh Node processes", () => {
  assert.match(guard, /& \$Node --no-global-search-paths -e \$check \$Root/);
  assert.match(guard, /if \(\$LASTEXITCODE -ne 0\)/);
  const before = builder.indexOf("Assert-BundledPasswordPolicy -Root $buildRoot -Node $inventoryNode");
  const zip = builder.indexOf("Write-DeterministicZip -SourceRoot $buildRoot -ArchivePath $archivePath");
  const extract = builder.indexOf("[IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $roundtripRoot)");
  const after = builder.indexOf("Assert-BundledPasswordPolicy -Root $roundtripRoot -Node $inventoryNode");
  assert.ok(before >= 0 && before < zip && zip < extract && extract < after);
  assert.equal((builder.match(/Assert-BundledPasswordPolicy -Root /g) || []).length, 2);
});

test("the actual package guard accepts the LF corpus without loading the application server", t => {
  const f = fixture(t), result = runCheck(f.source);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("the actual package guard rejects a CRLF-converted common corpus without normalizing it", t => {
  const f = fixture(t);
  const altered = Buffer.from(fs.readFileSync(f.common, "ascii").replace(/\n/g, "\r\n"), "ascii");
  assert.equal(altered.length, 198000);
  fs.writeFileSync(f.common, altered);
  rejected(f.source);
  assert.equal(hash(fs.readFileSync(f.common)), hash(altered));
});

for (const name of ["common", "breached"]) test(`the actual package guard rejects same-length tampering of the ${name} corpus`, t => {
  const f = fixture(t), file = f[name], altered = fs.readFileSync(file);
  altered[0] ^= 1;
  fs.writeFileSync(file, altered);
  rejected(f.source);
  assert.equal(hash(fs.readFileSync(file)), hash(altered));
});

test("Windows builder Copy-Item and ZIP roundtrip preserve bytes and reject the observed CRLF defect", {
  skip: process.platform !== "win32", timeout: 30000,
}, t => {
  const f = fixture(t);
  const copy = builder.match(/^    foreach \(\$relative in \$trackedFiles\) \{[\s\S]*?^    \}/m)?.[0];
  assert.ok(copy, "the actual builder copy loop must be exercised");
  const quote = value => "'" + value.replace(/'/g, "''") + "'";
  const script = `$ErrorActionPreference = 'Stop'
${["Test-ExcludedRelativePath", "Test-AllowedTrackedRuntimePath", "Write-DeterministicZip", "Assert-BundledPasswordPolicy"].map(definition).join("\n")}
function Expect-CorpusRejection([string]$Root) {
  $ErrorActionPreference = 'Continue'
  try { Assert-BundledPasswordPolicy -Root $Root -Node $inventoryNode }
  catch { if ($_.Exception.Message -match 'Bundled password corpus|Kennwortkorpus') { return }; throw }
  throw 'A damaged corpus unexpectedly passed the actual builder guard.'
}
$sourceRoot = ${quote(f.source)}
$buildRoot = ${quote(path.join(f.parent, "copied-lf"))}
$inventoryNode = ${quote(process.execPath)}
$trackedFiles = @(${files.map(quote).join(",")})
try {
$phase = 'LF Copy-Item'
${copy}
Assert-BundledPasswordPolicy -Root $buildRoot -Node $inventoryNode
$archivePath = ${quote(path.join(f.parent, "fixture.zip"))}
$roundtripRoot = ${quote(path.join(f.parent, "roundtrip"))}
Write-DeterministicZip -SourceRoot $buildRoot -ArchivePath $archivePath
[IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $roundtripRoot)
$phase = 'ZIP roundtrip'
Assert-BundledPasswordPolicy -Root $roundtripRoot -Node $inventoryNode
$roundtripCommon = Join-Path $roundtripRoot 'lib/password-policy/common-sha256.txt'
$changed = [IO.File]::ReadAllBytes($roundtripCommon); $changed[0] = $changed[0] -bxor 1
[IO.File]::WriteAllBytes($roundtripCommon, $changed)
$phase = 'roundtrip tamper rejection'
Expect-CorpusRejection -Root $roundtripRoot
$sourceCommon = Join-Path $sourceRoot 'lib/password-policy/common-sha256.txt'
[IO.File]::WriteAllText($sourceCommon, [IO.File]::ReadAllText($sourceCommon).Replace("\`n", "\`r\`n"), [Text.UTF8Encoding]::new($false))
$buildRoot = ${quote(path.join(f.parent, "copied-crlf"))}
${copy}
$copiedCommon = Join-Path $buildRoot 'lib/password-policy/common-sha256.txt'
if ([IO.File]::ReadAllBytes($copiedCommon).Length -ne 198000) { throw 'CRLF fixture was not copied unchanged.' }
$phase = 'copied CRLF rejection'
Expect-CorpusRejection -Root $buildRoot
@{ copiedLf = $true; zipRoundtrip = $true; roundtripTamperRejected = $true; copiedCrLfRejected = $true } | ConvertTo-Json -Compress
} catch { throw "Corpus fixture phase $phase : $($_.Exception.Message)" }
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    encoding: "utf8", windowsHide: true, timeout: 25000, maxBuffer: 128 * 1024,
    // PowerShell needs PATHEXT to dispatch the actual Node executable and bind
    // LASTEXITCODE; do not inherit NODE_OPTIONS or other parent injections.
    env: { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, ComSpec: process.env.ComSpec,
      SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      TEMP: os.tmpdir(), TMP: os.tmpdir() },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { copiedLf: true, zipRoundtrip: true, roundtripTamperRejected: true, copiedCrLfRejected: true });
});
