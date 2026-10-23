'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const library = require.resolve('../lib/security-release-inventory');
const cli = path.resolve(__dirname, '../scripts/security-release-inventory.js');
const fixed = { sourceCommit: '1'.repeat(40), createdAt: '2026-10-22T10:00:00Z' };

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-inventory-runtime-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'app');
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'synthetic-gp', version: '0.0.1-test', dependencies: {} }));
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'allowBuilds: {}\n');
  return { directory, root };
}

// Evaluate the complete real library with only subprocess results controlled.
// Native-probe counts establish that runtime drift is rejected before loading.
function controlled() {
  const calls = [], realRequire = createRequire(library), module = { exports: {} };
  let pnpm = { status: 0, stdout: '11.7.0\n', stderr: '' };
  function spawn(command, args, options) {
    calls.push({ command, args, options });
    if (args[0] === library && args[1] === '--native-worker') {
      return { status: 0, stdout: JSON.stringify({ status: 'observed', components: {}, loadedBindings: [] }) };
    }
    return command === 'pnpm' || command === process.execPath ? pnpm : { status: 0, stdout: 'synthetic-tool-1\n', stderr: '' };
  }
  const load = name => name === 'node:child_process' ? { spawnSync: spawn } : realRequire(name);
  vm.runInNewContext(fs.readFileSync(library, 'utf8'), { require: load, module, __filename: library, __dirname: path.dirname(library), process, console }, { filename: library });
  return { inventory: module.exports, calls, setPnpm(value) { pnpm = value; }, clear() { calls.length = 0; } };
}

const plain = value => JSON.parse(JSON.stringify(value));
const nativeCalls = calls => calls.filter(call => call.args[1] === '--native-worker');

test('runtime grants only default pnpm fifteen seconds; operating tools and native probes retain their limits', t => {
  const { root } = fixture(t), { inventory, calls } = controlled();
  inventory.generate(root, fixed);
  assert.equal(calls.find(call => call.command === 'pnpm').options.timeout, 15000);
  const tools = calls.filter(call => call.command !== 'pnpm' && call.command !== process.execPath);
  assert.equal(tools.length, 10);
  for (const call of tools) {
    assert.equal(call.options.timeout, 5000);
    assert.equal(call.options.maxBuffer, 32768);
    assert.equal(call.options.env.COREPACK_ENABLE_NETWORK, '0');
    assert.equal(call.options.env.COREPACK_ENABLE_DOWNLOAD_PROMPT, '0');
  }
  assert.equal(nativeCalls(calls).length, 1);
  assert.equal(nativeCalls(calls)[0].options.timeout, 30000);
});

test('explicit pnpm CLI receives the same private budget without changing its Node invocation', t => {
  const { directory, root } = fixture(t), state = controlled(), pnpmCli = path.join(directory, 'pnpm.cjs');
  const report = state.inventory.generate(root, { ...fixed, pnpmCli });
  const calls = state.calls.filter(call => call.command === process.execPath && call.args[0] === pnpmCli);
  assert.equal(calls.length, 1);
  assert.deepEqual(plain(calls[0].args), [pnpmCli, '--version']);
  assert.equal(calls[0].options.timeout, 15000);
  assert.deepEqual(plain(report.observedRuntime.pnpm), { status: 'observed', version: '11.7.0' });
});

test('pnpm timeouts, missing executables and failed exits remain explicit and are never retried', t => {
  const { root } = fixture(t);
  for (const [result, expected] of [
    [{ error: { code: 'ETIMEDOUT' } }, { status: 'error', version: null, error: 'ETIMEDOUT' }],
    [{ error: { code: 'ENOENT' } }, { status: 'unavailable', version: null, error: 'ENOENT' }],
    [{ status: 2, stdout: '', stderr: 'failure' }, { status: 'error', version: null, exitCode: 2 }],
  ]) {
    const state = controlled(); state.setPnpm(result);
    const report = state.inventory.generate(root, fixed);
    assert.deepEqual(plain(report.observedRuntime.pnpm), expected);
    assert.equal(state.calls.filter(call => call.command === 'pnpm').length, 1);
  }
});

test('changed pnpm version or timeout status fails strict verification before any native probe', t => {
  const { root } = fixture(t);
  const observed = version => ({ status: 0, stdout: version + '\n', stderr: '' });
  const timeout = { error: { code: 'ETIMEDOUT' } };
  for (const [before, after] of [[observed('11.7.0'), observed('11.7.1')], [timeout, observed('11.7.0')], [observed('11.7.0'), timeout]]) {
    const state = controlled(); state.setPnpm(before);
    const report = state.inventory.generate(root, fixed);
    state.clear(); state.setPnpm(after);
    assert.throws(() => state.inventory.verify(root, report), /INVENTORY_CONTENT_MISMATCH/);
    assert.equal(state.calls.filter(call => call.command === 'pnpm').length, 1);
    assert.equal(nativeCalls(state.calls).length, 0);
  }
});

test('real CLI generates and verifies an observed pnpm version after a six-second cold start', { timeout: 90000 }, t => {
  const { directory, root } = fixture(t), pnpmCli = path.join(directory, 'cold-pnpm.cjs'), calls = path.join(directory, 'pnpm-calls.jsonl');
  fs.writeFileSync(pnpmCli, `'use strict';\nconst fs=require('node:fs');\nif(process.argv.slice(2).join(' ')!=='--version')process.exit(2);\nfs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({pid:process.pid,args:process.argv.slice(2)})+'\\n');\nsetTimeout(()=>process.stdout.write('11.7.0\\n'),6000);\n`);
  const output = path.join(directory, 'inventory.json');
  const run = args => spawnSync(process.execPath, [cli, ...args, '--pnpm-cli', pnpmCli], {
    cwd: root, encoding: 'utf8', timeout: 40000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
  });
  const generated = run(['generate', '--root', root, '--mode', 'installed', '--output', output, '--source-commit', fixed.sourceCommit, '--created-at', fixed.createdAt]);
  assert.equal(generated.error, undefined, generated.error?.message);
  assert.equal(generated.status, 0, generated.stderr);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual(report.observedRuntime.pnpm, { status: 'observed', version: '11.7.0' });
  const verified = run(['verify', '--root', root, '--input', output]);
  assert.equal(verified.error, undefined, verified.error?.message);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).verified, true);
  const invocations = fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(invocations.length, 2, 'generation and verification must each invoke pnpm once');
  assert.ok(invocations.every(call => call.args.length === 1 && call.args[0] === '--version'));
});
