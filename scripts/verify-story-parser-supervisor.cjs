'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { performance } = require('node:perf_hooks');
const { prepareStoryParser, inputs } = require('./prepare-story-parser.cjs');
const { createParserSupervisor, limits } = require('./story-parser-supervisor.cjs');

const root = path.resolve(__dirname, '..');
const deno = process.env.STORY_MEDIA_DENO || (fs.existsSync('/opt/homebrew/bin/deno') ? '/opt/homebrew/bin/deno' : path.join(os.homedir(), '.deno/bin/deno'));
const watchdog = process.env.STORY_MEDIA_TIMEOUT || (process.platform === 'darwin' ? '/opt/homebrew/bin/gtimeout' : '/usr/bin/timeout');
const cacheDirectory = process.env.STORY_MEDIA_DENO_DIR || process.env.DENO_DIR
  || path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/deno' : '.cache/deno');
const config = path.join(root, 'supabase/functions/parse-story-media/deno.json');
const entry = 'scripts/story-parser-process.ts';
const controls = 'tests/fixtures/story-parser-process-controls.ts';
const tracked = [...inputs, entry, 'scripts/prepare-story-parser.cjs', 'scripts/story-parser-supervisor.cjs',
  'scripts/verify-story-parser-supervisor.cjs', controls];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fingerprint = () => Object.fromEntries(tracked.map(file => [file, sha256(fs.readFileSync(path.join(root, file)))]));
const permissions = ['read', 'write', 'net', 'run', 'ffi', 'sys', 'import'];
const technicalLimits = { photo_bytes: 8388608, video_bytes: 26214400, video_ms: 30000, max_pixels: 16777216 };
const types = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm' };

async function verify(fixtureDirectory, mode) {
  assert.ok(['--photo', '--formats'].includes(mode));
  fixtureDirectory = path.resolve(fixtureDirectory);
  assert.ok(fixtureDirectory.startsWith(path.join(root, 'dist/story-media/fixtures-')));
  assert.equal(fs.realpathSync(fixtureDirectory), fixtureDirectory);
  const fixtureManifest = JSON.parse(fs.readFileSync(path.join(fixtureDirectory, 'manifest.json'), 'utf8'));
  assert.equal(fixtureManifest.synthetic, true);
  const parent = path.join(root, 'dist/story-parser-supervisor');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  assert.equal(fs.realpathSync(parent), parent);
  const directory = fs.mkdtempSync(path.join(parent, 'run-'));
  const before = fingerprint();
  const report = { result: 'incomplete', mode, cases: [], sourceHashes: before, node: process.version,
    platform: process.platform, architecture: process.arch, deadlineMilliseconds: limits.milliseconds,
    maximumInputBytes: limits.inputBytes, maximumOutputBytes: limits.outputBytes, maximumStderrBytes: limits.errorBytes,
    deniedPermissions: permissions, environment: 'Explicit nonsecret allowlist only; pinned debug dependency requires environment enumeration',
    providerWrites: 0, customerMediaEnabled: false, hostedHardStopVerified: false,
    memoryLimitEnforced: false, processEscapeContainmentVerified: false,
    scope: 'Local offline supervised parser. Process-group cleanup and fail-closed ACKs are not an OS memory sandbox or a hosted exact-deadline guarantee.' };
  try {
    const located = spawnSync(deno, ['eval', '--frozen', '--cached-only', '--config', config,
      'console.log(import.meta.resolve("npm:mediainfo.js@0.3.7/MediaInfoModule.wasm"))'], {
      env: { LANG: 'C', NO_COLOR: '1', DENO_DIR: cacheDirectory }, encoding: 'utf8', timeout: 10000,
      killSignal: 'SIGKILL', maxBuffer: 65536, shell: false,
    });
    assert.equal(located.error, undefined);
    assert.equal(located.status, 0, 'Frozen parser resource unavailable');
    const packageDirectory = path.join(directory, 'package');
    const prepared = prepareStoryParser(packageDirectory, fileURLToPath(located.stdout.trim()));
    fs.mkdirSync(path.join(packageDirectory, 'scripts'), { mode: 0o700 });
    fs.copyFileSync(path.join(root, entry), path.join(packageDirectory, entry), fs.constants.COPYFILE_EXCL);
    report.package = path.relative(root, packageDirectory);
    report.packageHashes = { ...prepared.packageHashes, [entry]: before[entry] };
    const fixtures = mode === '--photo' ? ['photo.jpg'] : ['photo.jpg', 'photo.png', 'photo.webp', 'clip.mp4', 'clip.webm',
      'clip-large.mp4', 'long.mp4', 'fake-duration.mp4', 'truncated-photo.jpg', 'truncated-photo.png',
      'truncated-photo.webp', 'truncated-clip.mp4', 'truncated-clip.webm', 'truncated-long.mp4'];
    for (const filename of fixtures) {
      const fixture = fixtureManifest.files.find(item => item.filename === filename);
      assert.ok(fixture, 'Missing synthetic fixture: ' + filename);
      const started = performance.now();
      const file = path.join(fixtureDirectory, filename);
      assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
      const input = fs.readFileSync(file);
      assert.equal(input.length, fixture.bytes);
      assert.equal(sha256(input), fixture.sha256);
      const contentType = types[filename.split('.').at(-1)];
      const request = { request_id: randomUUID(), declaration: { kind: contentType.startsWith('image/') ? 'photo' : 'video',
        content_type: contentType, declared_bytes: input.length }, limits: technicalLimits };
      const supervisor = createParserSupervisor({ watchdog, executable: deno, cacheDirectory,
        args: ['run', '--no-prompt', '--frozen', '--cached-only', '--allow-env', ...permissions.map(name => '--deny-' + name),
          '--v8-flags=--max-old-space-size=128', '--config', path.join(packageDirectory, 'supabase/functions/parse-story-media/deno.json'),
          path.join(packageDirectory, entry), JSON.stringify(request)] });
      const accepted = /^(photo|clip)\./.test(filename) || filename === 'clip-large.mp4';
      const record = { name: filename + (accepted ? ': accepted' : ': rejected'), passed: false,
        inputBytes: input.length, inputSha256: fixture.sha256 };
      let failed;
      try {
        const result = await supervisor.run(input, { deadline: started + limits.milliseconds });
        record.process = result.evidence;
        assert.equal(accepted, true, 'Invalid fixture returned successful output');
        const parsed = JSON.parse(result.output);
        assert.deepEqual(Object.keys(parsed).sort(), ['request_id', 'actual_bytes', 'content_type', 'width', 'height',
          'duration_ms', 'duration_verified', 'parser', 'library', 'sha256'].sort());
        assert.equal(parsed.request_id, request.request_id);
        assert.equal(parsed.actual_bytes, input.length);
        assert.equal(parsed.sha256, fixture.sha256);
        assert.equal(parsed.content_type, contentType);
        assert.equal(parsed.width, 16);
        assert.equal(parsed.height, 16);
        assert.equal(parsed.duration_ms, request.declaration.kind === 'video' ? 1000 : null);
        assert.equal(parsed.duration_verified, request.declaration.kind === 'video');
        assert.equal(parsed.parser, 'file-type@22.0.2+mediainfo.js@0.3.7');
        assert.ok(typeof parsed.library === 'string' && parsed.library.length > 0);
        assert.equal(result.evidence.closedBeforeDeadline, true);
        assert.equal(result.evidence.groupTerminationConfirmed, true);
        assert.ok(result.evidence.elapsedMs < limits.milliseconds);
        record.metadata = { width: parsed.width, height: parsed.height, duration_ms: parsed.duration_ms, library: parsed.library };
        record.passed = true;
      } catch (error) {
        record.error = error.code || error.name;
        if (!accepted && error.code === 'parser_failed' && error.evidence?.parserDiagnostic?.error === 'invalid_media'
          && error.evidence.parserDiagnostic.phase === 'inspection') record.passed = true;
        else failed = error;
      } finally {
        record.cleanup = await supervisor.cleanup;
        if (!record.cleanup?.groupTerminationConfirmed || supervisor.active) {
          record.passed = false;
          failed ||= new Error('Cleanup not confirmed');
        }
        record.elapsedMs = performance.now() - started;
        report.cases.push(record);
      }
      if (failed) throw failed;
    }
    for (const [file, hash] of Object.entries(report.packageHashes)) {
      assert.equal(sha256(fs.readFileSync(path.join(packageDirectory, file))), hash, 'Package changed');
    }
    report.result = 'passed';
  } catch (error) {
    report.result = 'failed';
    report.error = error.code || error.name;
  } finally {
    report.sourceUnchanged = JSON.stringify(before) === JSON.stringify(fingerprint());
    if (!report.sourceUnchanged) report.result = 'failed';
    report.passed = report.cases.filter(item => item.passed).length;
    report.failed = report.result === 'passed' ? 0 : Math.max(1, report.cases.length - report.passed);
    fs.writeFileSync(path.join(directory, 'verification.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  const result = { result: report.result, passed: report.passed, failed: report.failed,
    evidence: path.relative(root, path.join(directory, 'verification.json')), hostedHardStopVerified: false };
  if (report.result !== 'passed') process.exitCode = 1;
  return result;
}

async function verifyControls() {
  const parent = path.join(root, 'dist/story-parser-supervisor');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  assert.equal(fs.realpathSync(parent), parent);
  const directory = fs.mkdtempSync(path.join(parent, 'controls-'));
  const before = fingerprint();
  const report = { result: 'incomplete', cases: [], sourceHashes: before, platform: process.platform,
    architecture: process.arch, node: process.version, deadlineMilliseconds: limits.milliseconds,
    cleanupReserveFraction: limits.cleanupReserveFraction, providerWrites: 0, hostedHardStopVerified: false,
    osMemoryBoundVerified: false, processEscapeContainmentVerified: false,
    scope: 'Single local process with denied Deno APIs and measured WASM termination; not a hosted or real-time guarantee' };
  try {
    for (const mode of ['permissions', 'wasm']) {
      const supervisor = createParserSupervisor({ watchdog, executable: deno, cacheDirectory,
        args: ['run', '--no-prompt', '--frozen', '--cached-only', '--allow-env', ...permissions.map(name => '--deny-' + name),
          '--v8-flags=--max-old-space-size=128', '--config', config, path.join(root, controls), mode] });
      const record = { name: mode, passed: false };
      let expectedTimeout = false;
      try {
        const result = await supervisor.run(Uint8Array.of(1), { deadline: performance.now() + limits.milliseconds });
        assert.equal(mode, 'permissions', 'Non-yielding WASM must not return a successful ACK');
        assert.deepEqual(JSON.parse(result.output), { denied: ['read', 'write', 'net', 'run', 'ffi', 'sys'] });
        record.denied = JSON.parse(result.output).denied;
      } catch (error) {
        if (mode !== 'wasm' || error.code !== 'validation_timeout') throw error;
        expectedTimeout = true;
        assert.equal(Object.hasOwn(error, 'output'), false);
      } finally {
        record.process = await supervisor.cleanup;
        report.cases.push(record);
      }
      assert.equal(record.process?.groupTerminationConfirmed, true);
      assert.equal(record.process.closedBeforeDeadline, true);
      assert.ok(record.process.elapsedMs < limits.milliseconds, 'Measured cleanup exceeded the unchanged deadline');
      assert.equal(supervisor.active, false);
      if (mode === 'wasm') {
        assert.equal(expectedTimeout, true);
        assert.ok(record.process.stdoutBytes > 0, 'WASM must start before the watchdog fires');
        assert.ok(record.process.exitSignal === 'SIGKILL' || record.process.exitCode === 137);
      }
      record.passed = true;
    }
    report.result = 'passed';
  } catch (error) { report.result = 'failed'; report.error = error.code || error.name; }
  finally {
    report.sourceUnchanged = JSON.stringify(before) === JSON.stringify(fingerprint());
    if (!report.sourceUnchanged) report.result = 'failed';
    report.passed = report.cases.filter(item => item.passed).length;
    report.failed = report.result === 'passed' ? 0 : Math.max(1, report.cases.length - report.passed);
    fs.writeFileSync(path.join(directory, 'verification.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  if (report.result !== 'passed') process.exitCode = 1;
  return { result: report.result, passed: report.passed, failed: report.failed,
    evidence: path.relative(root, path.join(directory, 'verification.json')), hostedHardStopVerified: false };
}

module.exports = { verify, verifyControls };
if (require.main === module) {
  const controlMode = process.argv[2] === '--controls';
  assert.equal(process.argv.length, controlMode ? 3 : 4, 'Use --controls, or --photo/--formats with an existing fixture directory');
  (controlMode ? verifyControls() : verify(process.argv[3], process.argv[2])).then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.code || error.name); process.exitCode = 1; });
}