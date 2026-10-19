'use strict';
// Only encrypted diagnostics leave the runner; the decryption key stays offline.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const FORMAT = 'gp-security-evidence-v1';
const MAX_BYTES = 128 * 1024 * 1024;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function seal(source, destination, publicKeyFile, metadata = {}) {
  const key = crypto.createPublicKey(fs.readFileSync(publicKeyFile));
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 3072) throw Error('An RSA recipient of at least 3072 bits is required');
  const keySha256 = hash(key.export({ type: 'spki', format: 'der' }));
  const files = [], root = fs.realpathSync(source);
  let bytes = 0;
  // No source trees, package installations, credentials or runner environment.
  for (const name of fs.readdirSync(root).sort()) {
    if (!/^(?:[a-z][a-z0-9.-]*\.json|semgrep-version\.stdout)$/.test(name)) continue;
    const file = path.join(root, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Unexpected evidence file type');
    bytes += stat.size;
    if (bytes > MAX_BYTES) throw Error('Evidence exceeds the bounded archive size');
    const content = fs.readFileSync(file);
    files.push({ name, sha256: hash(content), content: content.toString('base64') });
  }
  if (!files.some(file => file.name === 'gate-result.json')) throw Error('The scanner receipt is missing');
  const plaintext = zlib.gzipSync(Buffer.from(JSON.stringify({ metadata, files })));
  const dataKey = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const header = { format: FORMAT, recipientSha256: keySha256 };
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = { ...header, wrappedKey: crypto.publicEncrypt({ key, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, dataKey).toString('base64'),
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  dataKey.fill(0);
  fs.writeFileSync(destination, JSON.stringify(envelope) + '\n', { flag: 'wx', mode: 0o600 });
  return { fileCount: files.length, recipientSha256: keySha256, envelopeSha256: hash(fs.readFileSync(destination)) };
}
if (require.main === module) {
  try {
    const [source, destination, publicKeyFile] = process.argv.slice(2);
    if (!source || !destination || !publicKeyFile) throw Error('Missing argument');
    const receipt = seal(source, destination, publicKeyFile, { commit: process.env.GITHUB_SHA || '', runId: process.env.GITHUB_RUN_ID || '', attempt: process.env.GITHUB_RUN_ATTEMPT || '' });
    console.log(JSON.stringify(receipt));
  } catch { console.error('Private evidence could not be sealed.'); process.exitCode = 1; }
}
module.exports = { seal, FORMAT };
