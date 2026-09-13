'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('Caddy checks can repeat in the preserved assurance runtime directory', { skip: process.platform !== 'linux' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-caddy-repeat-'));
  try {
    const source = fs.readFileSync(path.join(__dirname, '../server-tools/linux/test-grabenplaner-server.sh'), 'utf8');
    const section = source.slice(source.indexOf('caddy_validation_ok=0'), source.indexOf('\nif [[ "${GRABENPLANER_OFFSITE_CONFIGURED', source.indexOf('caddy_validation_ok=0')));
    fs.writeFileSync(path.join(directory, 'caddy-validation.json'), '{"retained":true}');
    const script = `set -Eeuo pipefail
node="$GP_TEST_NODE"
caddyfile=/unused/test/Caddyfile
caddy() {
  if [[ "$1" == adapt ]]; then printf '%s' '{"logging":{"logs":{"default":{"writer":{"output":"file","filename":"/protected/log"}}}}}';
  else "$node" -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));if(d.logging.logs.default.writer)process.exit(1)' "$3"; fi
}
check_ok() { printf 'VALIDATED\\n'; }
check_fail() { exit 1; }
${section}
`;
    for (let run = 0; run < 2; run++) {
      const result = spawnSync('/usr/bin/bash', ['-s'], { input: script, encoding: 'utf8', env: { ...process.env, GP_TEST_NODE: process.execPath, RUNTIME_DIRECTORY: directory } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /VALIDATED/);
    }
    assert.equal(fs.readFileSync(path.join(directory, 'caddy-validation.json'), 'utf8'), '{"retained":true}');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Offsite writers include the optional PostgreSQL backup paths while cluster files remain read only', () => {
  for (const unit of ['grabenplaner-offsite-prepare.service.in', 'grabenplaner-offsite-assurance@.service.in']) {
    const source = fs.readFileSync(path.join(__dirname, '../server-tools/linux/offsite/systemd', unit), 'utf8');
    assert.match(source, /^ProtectSystem=strict$/m);
    assert.match(source, /^ReadWritePaths=-\/var\/lib\/grabenplaner-postgresql -\/var\/backups\/grabenplaner-postgresql$/m);
    assert.match(source, /^ReadOnlyPaths=-\/var\/lib\/grabenplaner-postgresql\/data$/m);
  }
});
