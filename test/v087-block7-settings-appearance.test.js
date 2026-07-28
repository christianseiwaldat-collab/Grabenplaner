const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const projectRoot = path.join(__dirname, "..");

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(url, child, stderr, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Testserver wurde vorzeitig mit Code ${child.exitCode} beendet.\n${stderr()}`);
    }
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Testserver wurde nicht rechtzeitig bereit.\n${stderr()}`);
}

async function waitForExit(child, timeoutMs = 12000) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Testserver wurde nicht rechtzeitig beendet.")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function startServer(root, databasePath) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let stderr = "";
  const child = spawn(process.execPath, [path.join(projectRoot, "server.js")], {
    cwd: projectRoot,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: databasePath,
      BACKUP_DIR: path.join(root, "backups"),
      GRABENPLANER_DATA_DIR: path.join(root, "app-data"),
      GRABENPLANER_HOST: "127.0.0.1",
      GRABENPLANER_OPERATION_MODE: "local",
      GRABENPLANER_SEED_DEMO: "1",
      NODE_ENV: "test",
      TZ: "Europe/Vienna",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  await waitForHealth(url, child, () => stderr);
  return { child, url, stderr: () => stderr };
}

async function stopServer(instance) {
  const response = await fetch(`${instance.url}/api/system/exit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(await waitForExit(instance.child), 0, instance.stderr());
}

test("v0.87 Block 7: Grundeinstellungen verwenden Accordions und eine globale numerische Schriftvorschau", () => {
  const html = fs.readFileSync(path.join(projectRoot, "public", "index.html"), "utf8");
  const script = fs.readFileSync(path.join(projectRoot, "public", "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(projectRoot, "public", "styles.css"), "utf8");

  assert.doesNotMatch(html, /data-settings-tab="(?:branding|pdf)"/);
  assert.doesNotMatch(html, /id="operationModeSettingsCard"|name="operationMode"/);
  assert.doesNotMatch(script, /\/api\/operation-mode|desiredOperationMode|saveOperationMode/);

  for (const id of ["loanSettingsCard", "brandingSettings", "pdfSettings"]) {
    assert.match(html, new RegExp(`<details[^>]+id="${id}"`));
    assert.doesNotMatch(html, new RegExp(`<details[^>]+id="${id}"[^>]*\\sopen(?:\\s|=|>)`));
  }
  assert.ok(html.indexOf('id="loanSettingsCard"') < html.indexOf('id="brandingSettings"'));
  assert.ok(html.indexOf('id="brandingSettings"') < html.indexOf('id="pdfSettings"'));
  const viewSettingsMarkup = html.slice(
    html.indexOf('id="viewBehaviorSettingsCard"'),
    html.indexOf('id="loanSettingsCard"'),
  );
  assert.match(viewSettingsMarkup, /id="toastDuration"/);
  assert.match(viewSettingsMarkup, /id="decreaseAppFontScale"/);
  assert.match(viewSettingsMarkup, /id="appFontScalePercent"[^>]+min="75"[^>]+max="150"[^>]+step="5"/);
  assert.match(viewSettingsMarkup, /id="increaseAppFontScale"/);
  assert.match(viewSettingsMarkup, /sofort[\s\S]*Vorschau[\s\S]*erst mit „Einstellungen speichern“/);

  assert.match(script, /--app-font-scale/);
  assert.match(script, /--app-font-scale-inverse/);
  assert.doesNotMatch(script, /--app-font-scale-(?:width|min-height)/);
  assert.match(script, /state\.persistedAppFontScalePercent/);
  assert.match(script, /if \(!silent && canSaveGeneralSettings && elements\.appFontScalePercent\)/);
  assert.match(script, /if \(!silent && canSaveBranding && state\.brandingFormDirty\)/);
  assert.match(styles, /body\s*\{[^}]*font-family:[^;}]*sans-serif[^}]*zoom:\s*var\(--app-font-scale\)/);
  assert.match(styles, /min-width:\s*calc\(320px \* var\(--app-font-scale-inverse\)\)/);
  assert.match(styles, /\.settings-two-column\s*\{[^}]*grid-auto-rows:\s*max-content[^}]*align-items:\s*start/);
  assert.match(styles, /\.settings-accordion-grid\s*\{[^}]*grid-auto-rows:\s*max-content[^}]*align-items:\s*start/);
  assert.doesNotMatch(styles, /--app-font-scale-(?:width|min-height)/);
});

test("v0.87 Block 7: Legacy-Schriftwerte und Betriebsmodus-Reste werden idempotent migriert", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v087-block7-migration-"));
  const databasePath = path.join(root, "dienstplan.db");
  let instance;
  try {
    instance = await startServer(root, databasePath);
    await stopServer(instance);
    instance = null;

    const database = new DatabaseSync(databasePath);
    try {
      database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
      database.prepare("DELETE FROM schema_migrations WHERE id = 'v0.87-block7-settings-appearance'").run();
      for (const [employeeNumber, fullName] of [
        ["b7-compact", "Kompakte Ansicht"],
        ["b7-standard", "Standard Ansicht"],
        ["b7-large", "Große Ansicht"],
        ["b7-existing", "Bestehende Ansicht"],
      ]) {
        database.prepare(`
          INSERT INTO employees (personnel_number, full_name, nickname, active)
          VALUES (?, ?, ?, 1)
        `).run(employeeNumber, fullName, fullName);
        database.prepare(`
          INSERT INTO portal_users
            (employee_number, password_hash, role, active, must_change_password, password_changed_at)
          VALUES (?, 'test-only', 'employee', 1, 0, CURRENT_TIMESTAMP)
        `).run(employeeNumber);
      }
      for (const [employeeNumber, value] of [
        ["b7-compact", "compact"],
        ["b7-standard", "standard"],
        ["b7-large", "large"],
        ["b7-existing", "compact"],
      ]) {
        database.prepare(`
          INSERT INTO portal_user_preferences (employee_number, preference_key, value)
          VALUES (?, 'dashboard_font_size', ?)
        `).run(employeeNumber, value);
      }
      database.prepare(`
        INSERT INTO portal_user_preferences (employee_number, preference_key, value)
        VALUES ('b7-existing', 'app_font_scale_percent', '130')
      `).run();
      database.prepare(`
        INSERT INTO portal_roles (id, name, description, builtin, permissions, sort_order)
        VALUES ('b7-custom', 'Block-7-Testrolle', '', 0, '["audit:read","operation_mode:write"]', 999)
      `).run();
      database.prepare(`
        INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
        VALUES ('b7-compact', 'operation_mode:write', 'test')
      `).run();
      database.prepare(`
        INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
        VALUES ('b7-standard', 'operation_mode:write', 'test')
      `).run();
      database.prepare(`
        INSERT INTO settings (key, value) VALUES ('operation_mode', 'lan')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run();
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch {}
      throw error;
    } finally {
      database.close();
    }

    instance = await startServer(root, databasePath);
    await stopServer(instance);
    instance = null;

    const verified = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const preferences = verified.prepare(`
        SELECT employee_number, preference_key, value
        FROM portal_user_preferences
        WHERE employee_number LIKE 'b7-%'
        ORDER BY employee_number, preference_key
      `).all().map((row) => ({ ...row }));
      assert.deepEqual(preferences, [
        { employee_number: "b7-compact", preference_key: "app_font_scale_percent", value: "85" },
        { employee_number: "b7-existing", preference_key: "app_font_scale_percent", value: "130" },
        { employee_number: "b7-large", preference_key: "app_font_scale_percent", value: "115" },
        { employee_number: "b7-standard", preference_key: "app_font_scale_percent", value: "100" },
      ]);
      assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM settings WHERE key = 'operation_mode'").get().count, 0);
      assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM portal_permission_grants WHERE permission = 'operation_mode:write'").get().count, 0);
      assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM portal_permission_denials WHERE permission = 'operation_mode:write'").get().count, 0);
      assert.deepEqual(
        JSON.parse(verified.prepare("SELECT permissions FROM portal_roles WHERE id = 'b7-custom'").get().permissions),
        ["audit:read"],
      );
      assert.equal(
        verified.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = 'v0.87-block7-settings-appearance'").get().count,
        1,
      );
    } finally {
      verified.close();
    }
  } finally {
    if (instance?.child?.exitCode === null) instance.child.kill();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
