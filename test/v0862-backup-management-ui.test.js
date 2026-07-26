"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("v0.86.2: Offsite-Ordnerverwaltung ist auf die drei Rollen und das technische Recht begrenzt", () => {
  const client = read("public/app.js");
  const permissionFunction = client.match(/function canManageOffsiteFolders\(\)[\s\S]*?\n}/)?.[0] || "";
  assert.match(permissionFunction, /operationMode === "server"/);
  assert.match(permissionFunction, /\["admin", "it_admin", "developer"\]\.includes\(role\)/);
  assert.match(permissionFunction, /permissions\.includes\("system:offsite:configure"\)/);
  assert.doesNotMatch(permissionFunction, /backup:write/);
  assert.match(client, /serverGoogleDriveManagementCard\?\.classList\.toggle\("hidden", !offsiteFolderManagementAccess\)/);
  assert.match(
    client,
    /manageGoogleDriveFolderButton\.disabled = !offsiteFolderManagementAccess[\s\S]*?state\.offsiteFoldersLoadState !== "ready"/,
  );
});

test("v0.86.2: Dialog zeigt nur verwaltete Labels und bestätigt den Zielwechsel ausdrücklich", () => {
  const html = read("public/index.html");
  const dialog = html.match(/<dialog class="modal offsite-folder-modal"[\s\S]*?<\/dialog>/)?.[0] || "";
  assert.match(dialog, /id="offsiteFolderActiveLabel"/);
  assert.match(dialog, /id="offsiteManagedFolderList"/);
  assert.match(dialog, /id="offsiteActiveFolderSelection"/);
  assert.match(dialog, /id="offsiteNewFolderLabel" maxlength="48" pattern=/);
  assert.match(dialog, /id="offsiteCreateCurrentPassword" type="password" autocomplete="current-password"/);
  assert.match(dialog, /id="offsiteActivateCurrentPassword" type="password" autocomplete="current-password"/);
  assert.match(dialog, /id="offsiteFolderActivationConfirmation" type="checkbox"/);
  assert.match(dialog, /alte Repository bleibt als Rückfallpunkt erhalten/);
  assert.match(dialog, /Recovery-Set für den Offline-Transfer/);
  assert.match(dialog, /Pfade oder Drive-Links werden nicht angenommen/);
  assert.doesNotMatch(dialog, /type="file"|id="[^"]*(?:path|directory)[^"]*"/i);
});

test("v0.86.2: Ordneraktionen verwenden exakte geschützte und redigierte API-Verträge", () => {
  const client = read("public/app.js");
  const server = read("server.js");
  const targetClient = read("lib/offsite-target-client.js");
  assert.match(client, /api\("\/api\/backup\/offsite-folders"\)/);
  assert.match(client, /api\("\/api\/backup\/offsite-folders", \{\s*method: "POST"/);
  assert.match(client, /confirmation: "CREATE_MANAGED_OFFSITE_FOLDER",\s*folderLabel,\s*currentPassword,/);
  assert.match(client, /api\("\/api\/backup\/offsite-folders\/active", \{\s*method: "PUT"/);
  assert.match(client, /confirmation: "ACTIVATE_MANAGED_OFFSITE_FOLDER",\s*folderLabel,\s*currentPassword,/);
  assert.match(client, /Recovery-Set für Offline-Transfer\/-Prüfung vorbereitet; altes Repository bleibt Rückfallpunkt\./);
  assert.match(client, /recoverySetState !== "pending-offline-transfer-and-verification"/);
  assert.match(client, /result\.fallbackPreserved !== true/);
  assert.match(server, /migrationMode: result\.migrationMode,[\s\S]*recoverySetState: result\.recoverySetState,[\s\S]*fallbackPreserved: result\.fallbackPreserved === true/);
  assert.match(server, /code === "ALREADY_ACTIVE"[\s\S]*"OFFSITE_FOLDER_ALREADY_ACTIVE"/);
  assert.match(server, /code === "LIMIT_REACHED"[\s\S]*"OFFSITE_FOLDER_LIMIT_REACHED"/);
  assert.match(client, /OFFSITE_FOLDER_ALREADY_ACTIVE/);
  assert.match(client, /OFFSITE_FOLDER_LIMIT_REACHED/);
  assert.match(targetClient, /DEFAULT_ACTIVATION_TIMEOUT_MS = 31 \* 60 \* 1000/);
  assert.doesNotMatch(targetClient, /RECOVERY_SET_REFRESH_REQUIRED/);
  assert.match(client, /function clearOffsiteFolderPasswords\(\)[\s\S]*offsiteCreateCurrentPassword\.value = ""[\s\S]*offsiteActivateCurrentPassword\.value = ""/);
  assert.ok((client.match(/finally \{\s*clearOffsiteFolderPasswords\(\);/g) || []).length >= 2);
});

test("v0.86.2: Ordnerdialog bleibt responsiv und warnt auch im dunklen Modus", () => {
  const styles = read("public/styles.css");
  assert.match(styles, /\.offsite-folder-modal \{ width:min\(760px,calc\(100vw - 28px\)\); \}/);
  assert.match(styles, /\.offsite-folder-change-warning/);
  assert.match(styles, /html\[data-active-page-theme="dark"\] \.offsite-folder-modal/);
  assert.match(styles, /@media \(max-width: 620px\)[\s\S]*\.offsite-managed-folder-list,\.offsite-folder-action-fields \{ grid-template-columns:1fr; \}/);
});
