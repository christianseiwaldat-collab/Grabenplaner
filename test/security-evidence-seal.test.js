'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), zlib = require('node:zlib');
const { seal, FORMAT } = require('../scripts/security/seal-evidence.cjs');
test('Private diagnostics remain confidential and authenticated, and unrelated files are excluded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-evidence-'));
  try {
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
    const publicFile = path.join(root, 'recipient.pem'), output = path.join(root, 'sealed.gpe');
    fs.writeFileSync(publicFile, keys.publicKey.export({ type: 'spki', format: 'pem' }));
    const profiles = ['common', 'express', 'script_tag', 'express_property', 'express_response'];
    fs.writeFileSync(path.join(root, 'gate-result.json'), JSON.stringify({ sensitive: 'synthetic private finding', exitCode: 1, commands: profiles.map(name => ({ label: 'semgrep-' + name, exitCode: 1 })) }));
    for (const name of profiles) fs.writeFileSync(path.join(root, 'sast-' + name + '.json'), JSON.stringify({ syntheticProfile: name }));
    fs.writeFileSync(path.join(root, '.env'), 'must never enter the archive');
    const receipt = seal(root, output, publicFile, { commit: 'a'.repeat(40) });
    assert.equal(receipt.fileCount, 6);
    assert.ok(!fs.readFileSync(output, 'utf8').includes('synthetic'));
    const envelope = JSON.parse(fs.readFileSync(output));
    function open(value, privateKey = keys.privateKey) {
      const dataKey = crypto.privateDecrypt({ key: privateKey, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(value.wrappedKey, 'base64'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, Buffer.from(value.iv, 'base64'));
      decipher.setAAD(Buffer.from(JSON.stringify({ format: value.format, recipientSha256: value.recipientSha256 })));
      decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
      return JSON.parse(zlib.gunzipSync(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()])));
    }
    assert.equal(envelope.format, FORMAT);
    const result = open(envelope);
    assert.deepEqual(result.metadata, { commit: 'a'.repeat(40) });
    assert.equal(result.files.length, 6);
    for (const file of result.files) {
      const recovered = Buffer.from(file.content, 'base64');
      assert.equal(crypto.createHash('sha256').update(recovered).digest('hex'), file.sha256);
      assert.deepEqual(recovered, fs.readFileSync(path.join(root, file.name)));
    }
    assert.deepEqual(result.files.map(file => file.name).sort(), ['gate-result.json', ...profiles.map(name => 'sast-' + name + '.json')].sort());
    assert.equal(JSON.parse(Buffer.from(result.files[0].content, 'base64')).sensitive, 'synthetic private finding');
    assert.throws(() => open({ ...envelope, recipientSha256: '0'.repeat(64) }));
    const changed = Buffer.from(envelope.ciphertext, 'base64'); changed[0] ^= 1;
    assert.throws(() => open({ ...envelope, ciphertext: changed.toString('base64') }));
    assert.throws(() => open(envelope, crypto.generateKeyPairSync('rsa', { modulusLength: 3072 }).privateKey));
    assert.throws(() => seal(root, output, publicFile));
    fs.unlinkSync(path.join(root, 'sast-express_property.json'));
    assert.throws(() => seal(root, path.join(root, 'incomplete.gpe'), publicFile), /profile result is missing/);
    fs.unlinkSync(path.join(root, 'gate-result.json'));
    assert.throws(() => seal(root, path.join(root, 'missing.gpe'), publicFile), /missing/);
  } finally { assert.ok(path.basename(root).startsWith('gp-evidence-')); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Evidence sealing and publication preserve the same commit, run, attempt and exact file bytes', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-evidence-upload-'));
  try {
    const source = path.join(root, 'raw'), published = path.join(root, 'public');
    fs.mkdirSync(source); fs.mkdirSync(published);
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
    const keyFile = path.join(root, 'recipient.pem');
    fs.writeFileSync(keyFile, keys.publicKey.export({ type: 'spki', format: 'pem' }));
    const metadata = { commit: 'a'.repeat(40), runId: '123', attempt: '2' };
    const rawReceipt = Buffer.from(JSON.stringify({ gate: 'sca', sensitive: 'PRIVATE-SYNTHETIC-DETAIL', exitCode: 1, complete: true, passed: false, status: 'findings' }));
    fs.writeFileSync(path.join(source, 'gate-result.json'), rawReceipt);
    fs.writeFileSync(path.join(published, 'gate-summary.json'), JSON.stringify({ schemaVersion: 1, gate: 'sca', complete: true, passed: false, status: 'findings', exitCode: 1, privateReceiptSha256: crypto.createHash('sha256').update(rawReceipt).digest('hex') }));
    seal(source, path.join(published, 'private-evidence.gpe'), keyFile, metadata);
    const run = spawnSync(process.env.PYTHON || 'python', [path.resolve(__dirname, '../scripts/security/prepare_upload.py'), '--gate', 'sca', '--input', source, '--public', published, '--key', keyFile], {
      encoding: 'utf8', env: { ...process.env, GITHUB_SHA: metadata.commit, GITHUB_RUN_ID: metadata.runId, GITHUB_RUN_ATTEMPT: metadata.attempt }
    });
    assert.ifError(run.error); assert.equal(run.status, 0, run.stderr + run.stdout);
    const manifest = JSON.parse(fs.readFileSync(path.join(published, 'upload-manifest.json')));
    for (const key of ['commit', 'runId', 'attempt']) assert.equal(manifest[key], metadata[key]);
    for (const file of manifest.files) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(published, file.name))).digest('hex'), file.sha256);
    const envelope = JSON.parse(fs.readFileSync(path.join(published, 'private-evidence.gpe')));
    const dataKey = crypto.privateDecrypt({ key: keys.privateKey, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(envelope.wrappedKey, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from(JSON.stringify({ format: envelope.format, recipientSha256: envelope.recipientSha256 })));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const recovered = JSON.parse(zlib.gunzipSync(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()])));
    assert.deepEqual(recovered.metadata, metadata);
    assert.deepEqual(Buffer.from(recovered.files[0].content, 'base64'), rawReceipt);
    assert.ok(!fs.readFileSync(path.join(published, 'upload-manifest.json'), 'utf8').includes('PRIVATE-SYNTHETIC'));
  } finally { assert.ok(path.basename(root).startsWith('gp-evidence-upload-')); fs.rmSync(root, { recursive: true, force: true }); }
});
