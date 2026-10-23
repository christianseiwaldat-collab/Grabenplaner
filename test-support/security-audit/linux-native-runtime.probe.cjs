'use strict';

// Opt-in, synthetic-only: node test-support/security-audit/linux-native-runtime.probe.cjs
// Optional --output /absolute/new-report.json (parent directory must exist).
// No application startup, database file, network, OCR or vulnerability scan.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const GROUPS = ['inventory', 'codecs-and-gp', 'svg-and-rejections', 'canvas'];
const CHILD_TIMEOUT_MS = 30000;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function platformInventory() {
  const { header } = process.report.getReport();
  return { platform: process.platform, arch: process.arch, node: process.version,
    nodeAbi: process.versions.modules, napi: process.versions.napi,
    openssl: process.versions.openssl, zlib: process.versions.zlib,
    glibcRuntime: header.glibcVersionRuntime || null, glibcCompiler: header.glibcVersionCompiler || null };
}

function requireLinux() {
  const runtime = platformInventory();
  assert.equal(runtime.platform, 'linux', 'This acceptance probe requires a real Linux process');
  assert.equal(runtime.arch, 'x64', 'The GP Linux acceptance target is x64');
  assert.match(runtime.glibcRuntime || '', /^\d+\.\d+/, 'A glibc runtime is required; musl is a different target');
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert.ok(major > 22 || major === 22 && minor >= 13, 'GP requires Node >=22.13.0');
  return runtime;
}

function elfInventory(filename) {
  const realPath = fs.realpathSync(filename), bytes = fs.readFileSync(realPath);
  assert.equal(bytes.subarray(0, 4).toString('hex'), '7f454c46', `Expected ELF: ${realPath}`);
  assert.equal(bytes[4], 2, 'Expected 64-bit ELF');
  assert.equal(bytes[5], 1, 'Expected little-endian ELF');
  assert.equal(bytes.readUInt16LE(18), 62, 'Expected x86-64 machine');
  const result = spawnSync('ldd', [realPath], { encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024 });
  const ldd = result.error?.code === 'ENOENT' ? { available: false }
    : { available: true, status: result.status, output: `${result.stdout || ''}${result.stderr || ''}`.trim() };
  if (ldd.available) {
    assert.ifError(result.error);
    assert.equal(result.status, 0, `ldd failed for ${realPath}: ${ldd.output}`);
    assert.doesNotMatch(ldd.output, /not found/i, 'A native dependency is unresolved');
  }
  return { path: realPath, bytes: bytes.length, sha256: sha256(bytes), elfClass: 64, machine: 'x86_64', ldd };
}

function nativeSharp() {
  const sharp = require('sharp');
  const bindings = Object.keys(require.cache).filter(file => file.endsWith('.node') && /sharp-linux-x64/.test(file));
  assert.equal(bindings.length, 1, 'Exactly one loaded Linux x64 sharp .node binding is required, not WASM');
  assert.equal(sharp.versions.sharp, require(path.join(ROOT, 'package.json')).dependencies.sharp);
  const libraries = process.report.getReport().sharedObjects.filter(file => /libvips[^/]*\.so/.test(file));
  assert.ok(libraries.length > 0, 'A loaded native libvips shared object is required');
  return { sharp, bindings, libraries };
}

function canvasModule() {
  return createRequire(require.resolve('pdfjs-dist/package.json'))('@napi-rs/canvas');
}

async function worker(group) {
  requireLinux();
  const { sharp, bindings, libraries } = nativeSharp();
  sharp.concurrency(1);
  sharp.cache(false);
  if (group === 'inventory') {
    canvasModule();
    const canvasEntry = createRequire(require.resolve('pdfjs-dist/package.json')).resolve('@napi-rs/canvas');
    const canvasVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(canvasEntry), 'package.json'), 'utf8')).version;
    const canvasBindings = Object.keys(require.cache).filter(file => file.endsWith('.node') && /canvas-linux-x64-gnu/.test(file));
    assert.equal(canvasBindings.length, 1, 'Exactly one loaded Linux glibc canvas binding is required');
    const { openSqliteApplicationPersistence } = require('../../lib/persistence/sqlite/provider');
    const { SQLITE_APPLICATION_CATALOG } = require('../../lib/persistence/sqlite/application-catalog');
    const app = openSqliteApplicationPersistence({ databasePath: ':memory:', catalog: SQLITE_APPLICATION_CATALOG });
    let sqlite;
    try { sqlite = { builtIn: true, productionProvider: true, ...app.database.prepare('SELECT sqlite_version() AS version').get(),
      compileOptions: app.database.prepare('PRAGMA compile_options').all().map(row => row.compile_options) }; }
    finally { await app.provider.close(); app.database.close(); }
    return { runtime: platformInventory(), sqlite, canvasVersion, sharpVersions: sharp.versions,
      sharpFormats: Object.fromEntries(['jpeg', 'png', 'webp', 'tiff', 'heif', 'svg'].map(format => [format, sharp.format[format]])),
      loadedNative: [...new Set([process.execPath, ...bindings, ...libraries, ...canvasBindings])].map(elfInventory),
      cpuFlags: fs.readFileSync('/proc/cpuinfo', 'utf8').match(/^flags\s*:\s*(.*)$/m)?.[1] || null,
      osRelease: fs.readFileSync('/etc/os-release', 'utf8'),
      sourceHashes: Object.fromEntries(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
        'lib/loan-photo.js', 'lib/sales-article-image.js', 'lib/amu-processing.js',
        'lib/candidate-evaluation-pdf.js', 'test-support/security-audit/linux-native-runtime.probe.cjs']
        .map(file => [file, sha256(fs.readFileSync(path.join(ROOT, file)))])),
      exclusions: ['No OCR/WASM execution', 'No PostgreSQL connection', 'No production or deployment verification'] };
  }

  const createImage = format => sharp({ create: { width: 16, height: 12, channels: 3, background: '#337755' } })
    .toFormat(format, format === 'tiff' ? { compression: 'lzw' } : {}).toBuffer();
  const verifyRaster = async (buffer, expectedFormat) => {
    const metadata = await sharp(buffer).metadata();
    assert.equal(metadata.format, expectedFormat);
    const { data, info } = await sharp(buffer, { failOn: 'warning', limitInputPixels: 100000 })
      .removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 16); assert.equal(info.height, 12); assert.equal(info.channels, 3);
    assert.equal(data.length, 16 * 12 * 3);
    [51, 119, 85].forEach((expected, index) => assert.ok(Math.abs(data[index] - expected) < 12, 'Decoded pixel differs'));
    return { format: metadata.format, width: info.width, height: info.height, bytes: buffer.length };
  };
  const verifyPdf = buffer => {
    assert.equal(buffer.subarray(0, 5).toString('ascii'), '%PDF-');
    assert.match(buffer.subarray(-80).toString('ascii'), /%%EOF/);
    assert.ok(buffer.length > 500 && buffer.length < 2 * 1024 * 1024);
  };
  if (group === 'codecs-and-gp') {
    const { prepareLoanPhoto } = require('../../lib/loan-photo');
    const { prepareSalesArticleImage } = require('../../lib/sales-article-image');
    const { prepareAmuDocument } = require('../../lib/amu-processing');
    const observations = [];
    for (const format of ['jpeg', 'png', 'webp', 'tiff', 'avif']) {
      const input = await createImage(format), decoded = await verifyRaster(input, format === 'avif' ? 'heif' : format);
      const loan = await prepareLoanPhoto({ buffer: input, originalName: `synthetic.${format}` });
      assert.equal(loan.mime, 'image/jpeg'); await verifyRaster(loan.buffer, 'jpeg');
      const paths = ['native encode/decode', 'prepareLoanPhoto -> JPEG'];
      if (['jpeg', 'png', 'webp'].includes(format)) {
        const article = await prepareSalesArticleImage(input);
        assert.equal(article.mime, 'image/webp'); await verifyRaster(article.buffer, 'webp');
        assert.ok(article.buffer.length <= 50 * 1024); paths.push('prepareSalesArticleImage -> WebP');
      }
      if (format !== 'avif') {
        const pdf = await prepareAmuDocument({ buffer: input, originalName: `synthetic.${format}` });
        assert.equal(pdf.detectedMime, 'application/pdf'); verifyPdf(pdf.buffer); paths.push('prepareAmuDocument -> A4 PDF');
      }
      observations.push({ input: format, decoded, paths });
    }
    return observations;
  }
  if (group === 'svg-and-rejections') {
    const { prepareLoanPhoto } = require('../../lib/loan-photo');
    const { prepareCandidatePhoto } = require('../../lib/candidate-photo');
    const { prepareSalesArticleImage } = require('../../lib/sales-article-image');
    const { createCandidateEvaluationPdf } = require('../../lib/candidate-evaluation-pdf');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="12"><rect width="16" height="12" fill="#337755"/></svg>');
    await verifyRaster(await sharp(svg).png().toBuffer(), 'png');
    const pdf = logoBuffer => createCandidateEvaluationPdf({ candidateName: 'Synthetic native probe',
      evaluationSummary: { criteria: [] }, branding: { companyName: 'Synthetic', logoBuffer },
      exportOptions: { includeLogo: true, applyBranding: true, showGeneratedAt: false } });
    verifyPdf(await pdf(svg));
    await assert.rejects(pdf(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="void(0)" width="16" height="12"/>')),
      { code: 'CANDIDATE_EVALUATION_PDF_LOGO_INVALID' });
    await assert.rejects(prepareLoanPhoto({ buffer: svg }), { code: 'LOAN_PHOTO_FORMAT_UNSUPPORTED' });
    await assert.rejects(prepareSalesArticleImage(svg), { code: 'ARTICLE_IMAGE_FORMAT' });
    for (const format of ['avif', 'tiff']) await assert.rejects(prepareSalesArticleImage(await createImage(format)), { code: 'ARTICLE_IMAGE_FORMAT' });
    await assert.rejects(prepareCandidatePhoto({ buffer: await createImage('avif') }), { code: 'CANDIDATE_PHOTO_FORMAT_UNSUPPORTED' });
    const truncated = (await createImage('png')).subarray(0, 24);
    await assert.rejects(sharp(truncated, { failOn: 'warning' }).raw().toBuffer());
    await assert.rejects(prepareLoanPhoto({ buffer: truncated }), { code: 'LOAN_PHOTO_INVALID' });
    await assert.rejects(prepareSalesArticleImage(truncated), { code: 'ARTICLE_IMAGE_INVALID' });
    return { svgBackend: 'native PNG rasterization and branded GP PDF', rejected: [
      'active SVG logo', 'SVG loan photo', 'SVG/TIFF/AVIF sales article', 'AVIF candidate photo',
      'truncated PNG: raw decoder, loan photo, sales article'], childTimeoutMs: CHILD_TIMEOUT_MS };
  }
  if (group === 'canvas') {
    const { createCanvas, loadImage } = canvasModule();
    const loaded = Object.keys(require.cache).filter(file => file.endsWith('.node') && /canvas-linux-x64-gnu/.test(file));
    assert.equal(loaded.length, 1, 'Canvas must use the native Linux glibc binding');
    const source = createCanvas(16, 12), context = source.getContext('2d');
    context.fillStyle = '#337755'; context.fillRect(0, 0, 16, 12);
    const buffer = source.toBuffer('image/png'), image = await loadImage(buffer), target = createCanvas(16, 12);
    assert.equal(image.width, 16); assert.equal(image.height, 12);
    target.getContext('2d').drawImage(image, 0, 0);
    assert.deepEqual(Array.from(target.getContext('2d').getImageData(0, 0, 1, 1).data), [51, 119, 85, 255]);
    await verifyRaster(buffer, 'png');
    return { nativeBinding: loaded[0], pngBytes: buffer.length, drawEncodeDecodePixels: 'passed' };
  }
  throw new Error('Unknown worker group');
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--worker') {
    assert.equal(args.length, 2); assert.ok(GROUPS.includes(args[1]));
    const result = await worker(args[1]);
    process.stdout.write(JSON.stringify({ status: 'passed', result }) + '\n');
    return;
  }
  let output;
  const report = { format: 'gp-linux-native-runtime-v1', generatedAt: new Date().toISOString(),
    status: 'failed', runtime: platformInventory(), groups: [], limits: 'Synthetic native runtime acceptance; not a CVE scan, PostgreSQL proof, OCR proof or production audit.' };
  try {
    assert.ok(args.length === 0 || args.length === 2 && args[0] === '--output', 'Usage: [--output /absolute/new-report.json]');
    if (args.length) { output = args[1]; assert.ok(path.isAbsolute(output)); assert.equal(fs.existsSync(output), false, 'Output must be new'); }
    requireLinux();
    for (const group of GROUPS) {
      const started = Date.now();
      const child = spawnSync(process.execPath, ['--max-old-space-size=256', __filename, '--worker', group], {
        cwd: ROOT, encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, NODE_OPTIONS: '', NODE_V8_COVERAGE: '', VIPS_CONCURRENCY: '1' },
      });
      let result;
      try { result = JSON.parse(child.stdout); } catch { result = { status: 'failed', error: 'Worker did not return valid JSON' }; }
      const passed = child.status === 0 && !child.error && result.status === 'passed';
      report.groups.push({ group, durationMs: Date.now() - started,
        exitCode: child.status, signal: child.signal, error: child.error?.code || null,
        stderr: (child.stderr || '').slice(0, 4096), ...result, status: passed ? 'passed' : 'failed' });
    }
    report.status = report.groups.length === GROUPS.length && report.groups.every(group => group.status === 'passed') ? 'passed' : 'failed';
  } catch (error) { report.error = { code: error.code || null, message: error.message }; }
  if (output) {
    try { fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { report.status = 'failed'; report.outputError = error.message; }
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.status !== 'passed') process.exitCode = 1;
}

main().catch(error => { process.stdout.write(JSON.stringify({ status: 'failed', error: { code: error.code || null, message: error.message } }) + '\n'); process.exitCode = 1; });
