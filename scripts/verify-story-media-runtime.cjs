'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const deno = process.env.STORY_MEDIA_DENO || (fs.existsSync('/opt/homebrew/bin/deno') ? '/opt/homebrew/bin/deno' : 'deno');
const ffmpeg = process.env.STORY_MEDIA_FFMPEG || (fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
const cleanEnv = { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', LANG: 'C',
  DENO_DIR: process.env.STORY_MEDIA_DENO_DIR || path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/deno' : '.cache/deno') };
const runtimeFiles = ['supabase/functions/validate-story-media/index.ts', 'supabase/functions/validate-story-media/deno.json',
  'supabase/functions/validate-story-media/deno.lock', 'scripts/verify-story-media-runtime.ts', 'scripts/verify-story-media-runtime.cjs'];
const runtimeFingerprint = () => Object.fromEntries(runtimeFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const runtimeArguments = ['run', '--no-prompt', '--frozen', '--cached-only', '--deny-net', '--allow-env', '--allow-read',
  '--config', path.join(root, 'supabase/functions/validate-story-media/deno.json'), path.join(root, 'scripts/verify-story-media-runtime.ts')];

async function createFixtures(options = {}) {
  const parent = path.join(root, 'dist/story-media');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(parent) !== parent) throw new Error('Fixture directory may not be a symlink');
  const directory = fs.mkdtempSync(path.join(parent, 'fixtures-'));
  const formats = [
    ['photo.jpg', ['-frames:v', '1', '-c:v', 'mjpeg']],
    ['photo.png', ['-frames:v', '1', '-c:v', 'png']],
    ['clip.mp4', ['-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']],
    ['clip.webm', ['-t', '1', '-c:v', 'libvpx-vp9', '-deadline', 'realtime']],
    ['long.mp4', ['-t', '31', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']]
  ];
  for (const [filename, encoding] of formats) {
    const result = spawnSync(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n',
      '-filter_threads', '1', '-filter_complex_threads', '1', '-f', 'lavfi', '-i', 'color=c=0x48a878:s=16x16:r=10',
      ...encoding, '-threads', '1', path.join(directory, filename)],
    { env: cleanEnv, timeout: 10000, maxBuffer: 65536, encoding: 'utf8', shell: false });
    if (result.status !== 0) throw new Error('FFmpeg prerequisite or synthetic fixture generation failed: ' + filename + ': ' + (result.error?.code || result.stderr));
    const bytes = fs.readFileSync(path.join(directory, filename));
    fs.writeFileSync(path.join(directory, 'truncated-' + filename), bytes.subarray(0, Math.floor(bytes.length / 2)), { mode: 0o600, flag: 'wx' });
  }
  const browser = await chromium.launch({ headless: true, args: ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND'] });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    const data = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
      const drawing = canvas.getContext('2d'); drawing.fillStyle = '#48a878'; drawing.fillRect(0, 0, 16, 16);
      return canvas.toDataURL('image/webp');
    });
    if (!data.startsWith('data:image/webp;base64,')) throw new Error('WebP fixture encoder unavailable');
    const bytes = Buffer.from(data.split(',')[1], 'base64');
    fs.writeFileSync(path.join(directory, 'photo.webp'), bytes, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(path.join(directory, 'truncated-photo.webp'), bytes.subarray(0, Math.floor(bytes.length / 2)), { mode: 0o600, flag: 'wx' });
  } finally { await browser.close(); }
  const fake = fs.readFileSync(path.join(directory, 'long.mp4'));
  const movieHeader = fake.indexOf(Buffer.from('mvhd'));
  if (movieHeader < 0 || fake[movieHeader + 4] !== 0) throw new Error('Unexpected synthetic MP4 header');
  fake.writeUInt32BE(1, movieHeader + 20);
  fs.writeFileSync(path.join(directory, 'fake-duration.mp4'), fake, { mode: 0o600, flag: 'wx' });
  if (options.large) {
    const original = fs.readFileSync(path.join(directory, 'clip.mp4')), large = Buffer.alloc(26214400);
    original.copy(large); large.writeUInt32BE(large.length - original.length, original.length); large.write('free', original.length + 4, 'ascii');
    fs.writeFileSync(path.join(directory, 'clip-large.mp4'), large, { mode: 0o600, flag: 'wx' });
  }
  const files = fs.readdirSync(directory).sort().map(filename => {
    const bytes = fs.readFileSync(path.join(directory, filename));
    return { filename, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ synthetic: true, files }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return directory;
}

function assertRuntimeReport(report) {
  if (!report || !Array.isArray(report.cases) || !report.cases.length || report.cases.length > 256 || report.network !== 'denied'
    || typeof report.runtime?.deno !== 'string' || report.cases.some(item => typeof item.name !== 'string' || !item.name || typeof item.passed !== 'boolean')
    || new Set(report.cases.map(item => item.name)).size !== report.cases.length) throw new Error('Actual runtime report is missing or malformed');
  const passed = report.cases.filter(item => item.passed).length, failed = report.cases.length - passed;
  if (report.passed !== passed || report.failed !== failed || report.result !== (failed ? 'failed' : 'passed')) throw new Error('Actual runtime case counts do not match parsed results');
  return report;
}
function runRuntime(directory) {
  const fingerprints = runtimeFingerprint();
  const result = spawnSync(deno, [...runtimeArguments, directory],
  { env: cleanEnv, cwd: root, timeout: 30000, maxBuffer: 1024 * 1024, encoding: 'utf8', shell: false });
  if (result.error) throw new Error('Real Deno execution is required, never skipped: ' + result.error.code + '. Provide Deno and the frozen cached dependencies; STORY_MEDIA_DENO may specify its executable.');
  let report;
  try { report = assertRuntimeReport(JSON.parse(result.stdout)); }
  catch (error) { throw new Error(error.message + ': ' + result.stderr); }
  Object.assign(report, { actualRuntimeExecuted: true, processExitCode: result.status, fingerprints,
    sourceUnchanged: JSON.stringify(fingerprints) === JSON.stringify(runtimeFingerprint()) });
  fs.writeFileSync(path.join(directory, 'runtime-evidence.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  if (result.status !== 0 || report.failed !== 0 || !report.sourceUnchanged) throw new Error('Offline runtime verification failed: '
    + path.relative(root, path.join(directory, 'runtime-evidence.json')) + ': ' + JSON.stringify(report.cases.filter(item => !item.passed)));
  return { ...report, evidence: path.relative(root, path.join(directory, 'runtime-evidence.json')) };
}
function runMemory(directory) {
  if (process.platform !== 'darwin') throw new Error('This local RSS measurement requires macOS /usr/bin/time -l; no Edge Runtime memory claim is implied');
  const fingerprints = runtimeFingerprint();
  const result = spawnSync('/usr/bin/time', ['-l', deno, ...runtimeArguments, '--memory', directory],
    { env: cleanEnv, cwd: root, timeout: 30000, maxBuffer: 65536, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error('Local cold memory probe failed: ' + result.stdout + result.stderr);
  const report = JSON.parse(result.stdout), peak = /^\s*(\d+)\s+maximum resident set size\s*$/m.exec(result.stderr);
  if (!peak || report.result !== 'passed' || report.inputBytes !== 26214400) throw new Error('Local cold memory evidence is incomplete');
  Object.assign(report, { maximumResidentSetBytes: Number(peak[1]), measurement: 'macOS /usr/bin/time -l child-process maximum RSS',
    referenceBudgetBytes: 268435456, belowReferenceBudget: Number(peak[1]) < 268435456,
    scope: 'Cold local Deno process, one 25 MiB synthetic MP4 with a legal free box, real parser worker and owned-buffer transfer. Not hosted Edge Runtime, network buffer or full codec decode memory.',
    hostedMemoryAcceptance: false, fingerprints, sourceUnchanged: JSON.stringify(fingerprints) === JSON.stringify(runtimeFingerprint()) });
  fs.writeFileSync(path.join(directory, 'memory-evidence.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { ...report, evidence: path.relative(root, path.join(directory, 'memory-evidence.json')) };
}
function startRuntimeBridge(network) {
  const child = spawn(deno, [...runtimeArguments, '--bridge'],
  { cwd: root, env: cleanEnv, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', sequence = 0, diagnostic = ''; const pending = new Map();
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4096); });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 40000000) { child.kill(); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      if (message.type === 'result') {
        const held = pending.get(message.id); pending.delete(message.id); if (held) { clearTimeout(held.timer); held.resolve(message); }
      } else if (message.type === 'fetch') {
        Promise.resolve(network(message)).then(response => send({ type: 'response', id: message.id, status: response.status,
          headers: response.headers || { 'content-type': 'application/json' },
          body: (Buffer.isBuffer(response.body) ? response.body : Buffer.from(JSON.stringify(response.body))).toString('base64') }))
          .catch(() => send({ type: 'response', id: message.id, status: 503, headers: { 'content-type': 'application/json' }, body: Buffer.from('{}').toString('base64') }));
      }
    }
  });
  child.on('error', error => { for (const held of pending.values()) { clearTimeout(held.timer); held.reject(error); } pending.clear(); });
  child.on('exit', () => { for (const held of pending.values()) { clearTimeout(held.timer); held.reject(new Error('Fixture Deno worker exited: ' + diagnostic)); } pending.clear(); });
  return {
    validate(authorization, body) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Fixture Deno bridge deadline')); child.kill(); }, 32000);
        pending.set(id, { resolve, reject, timer }); send({ type: 'validate', id, authorization, body });
      });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode) return;
      child.stdin.end();
      await new Promise(resolve => { const timer = setTimeout(() => child.kill(), 2000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    }
  };
}
module.exports = { createFixtures, cleanEnv, root, runRuntime, startRuntimeBridge, assertRuntimeReport, runMemory };
if (require.main === module) {
  if (process.argv.length !== 3 || !['--fixtures', '--memory'].includes(process.argv[2])) throw new Error('Only --fixtures or --memory is supported; no endpoint or credentials accepted');
  createFixtures({ large: process.argv[2] === '--memory' }).then(directory => {
    console.log(JSON.stringify(process.argv[2] === '--memory' ? runMemory(directory) : runRuntime(directory), null, 2));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}