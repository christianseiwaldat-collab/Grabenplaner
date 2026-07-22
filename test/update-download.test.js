"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  configureSystemCertificateAuthorities,
  downloadGitHubReleaseAsset,
  expectedSha256,
  portableAssetFileName,
  trustedGitHubAssetUrl,
} = require("../lib/update-download");

function githubResponse(content) {
  const response = new Response(content, {
    status: 200,
    headers: { "content-length": String(content.length), "content-type": "application/zip" },
  });
  Object.defineProperty(response, "url", {
    value: "https://release-assets.githubusercontent.com/github-production-release-asset/update.zip",
  });
  return response;
}

test("Updater: akzeptiert ausschließlich vertrauenswürdige GitHub-HTTPS-Adressen und Portable-ZIPs", () => {
  assert.equal(typeof configureSystemCertificateAuthorities(), "boolean");
  assert.equal(trustedGitHubAssetUrl("https://github.com/example/project/releases/download/v1/app.zip").hostname, "github.com");
  assert.equal(trustedGitHubAssetUrl("https://release-assets.githubusercontent.com/file").hostname, "release-assets.githubusercontent.com");
  assert.throws(() => trustedGitHubAssetUrl("http://github.com/file"), { code: "UPDATE_ASSET_URL_UNTRUSTED" });
  assert.throws(() => trustedGitHubAssetUrl("https://githubusercontent.com.example.org/file"), { code: "UPDATE_ASSET_URL_UNTRUSTED" });
  assert.equal(portableAssetFileName("Grabenplaner-v0.68.1-beta-windows-portable.zip"), "Grabenplaner-v0.68.1-beta-windows-portable.zip");
  assert.throws(() => portableAssetFileName("../windows-portable.zip"), { code: "UPDATE_ASSET_NAME_INVALID" });
});

test("Updater: lädt das Release ohne GitHub CLI und prüft Größe sowie SHA-256", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-update-download-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const content = Buffer.from("portable-zip-test-content");
  const digest = crypto.createHash("sha256").update(content).digest("hex");
  let requestedUrl = "";
  const result = await downloadGitHubReleaseAsset({
    asset: {
      name: "Grabenplaner-v0.68.1-beta-windows-portable.zip",
      url: "https://github.com/example/project/releases/download/v0.68.1/app-windows-portable.zip",
      size: content.length,
      digest: `sha256:${digest}`,
    },
    destinationDirectory: root,
    fetchImpl: async (url, options) => {
      requestedUrl = String(url);
      assert.equal(options.redirect, "follow");
      assert.equal(options.headers.Accept, "application/octet-stream");
      return githubResponse(content);
    },
  });
  assert.match(requestedUrl, /^https:\/\/github\.com\//);
  assert.equal(result.sha256, digest);
  assert.equal(result.byteSize, content.length);
  assert.equal(result.integritySource, "github-sha256");
  assert.deepEqual(fs.readFileSync(result.filePath), content);
  assert.equal(fs.existsSync(`${result.filePath}.part`), false);
});

test("Updater: verwirft manipulierte Downloads vor der Installation", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-update-integrity-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const content = Buffer.from("not-the-expected-update");
  await assert.rejects(() => downloadGitHubReleaseAsset({
    asset: {
      name: "Grabenplaner-v0.68.1-beta-windows-portable.zip",
      url: "https://github.com/example/project/releases/download/v0.68.1/app-windows-portable.zip",
      size: content.length,
      digest: `sha256:${"0".repeat(64)}`,
    },
    destinationDirectory: root,
    fetchImpl: async () => githubResponse(content),
  }), { code: "UPDATE_ASSET_INTEGRITY_FAILED" });
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(expectedSha256(`sha256:${"A".repeat(64)}`), "a".repeat(64));
});

test("Updater: Update-Endpunkt und Installationshelfer benötigen keine GitHub CLI", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const endpoint = serverSource.slice(
    serverSource.indexOf('app.post("/api/update-apply"'),
    serverSource.indexOf('app.post("/api/backup"'),
  );
  assert.match(endpoint, /downloadGitHubReleaseAsset/);
  assert.match(endpoint, /Get-FileHash[^\n]+SHA256/);
  assert.doesNotMatch(endpoint, /findGhExecutable|release download|GitHub CLI/);
});

test("Updater: schützt nur Datenordner an der Paketwurzel und bestätigt den Neustart", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const endpoint = serverSource.slice(
    serverSource.indexOf('app.post("/api/update-apply"'),
    serverSource.indexOf('app.post("/api/backup"'),
  );
  assert.match(endpoint, /\$protectedRootNames = @\('\.git', 'data', 'backups', 'release', 'usb-backups'\)/);
  assert.match(endpoint, /New-Item -ItemType Directory -Path \$protectedSourceDirectory/);
  assert.match(endpoint, /\$excludedSourceDirectories \+= \$protectedSourceDirectory/);
  assert.match(endpoint, /robocopy @robocopyArguments/);
  assert.doesNotMatch(endpoint, /robocopy \$source \$appDir \/MIR \/XD '\.git' 'data'/);
  assert.match(endpoint, /Assert-PortableRuntime \$source/);
  assert.match(endpoint, /Assert-PortableRuntime \$appDir/);
  assert.match(endpoint, /Invoke-WebRequest[^\n]+\$healthUrl/);
  assert.match(endpoint, /GRABENPLANER_UPDATE_RESTART/);
  assert.ok(endpoint.indexOf("Invoke-WebRequest") < endpoint.indexOf('Write-UpdateLog "Update erfolgreich abgeschlossen."'));

  const startFile = fs.readFileSync(path.join(__dirname, "..", "Grabenplaner v0.76 Beta starten.cmd"), "utf8");
  assert.match(startFile, /set "UPDATE_RESTART=%GRABENPLANER_UPDATE_RESTART%"/);
  assert.match(startFile, /if \/I "%UPDATE_RESTART%"=="1" exit \/b 1/);
});
