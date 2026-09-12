'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { prepareStoryParser, inputs } = require('./prepare-story-parser.cjs');
const { createFixtures, cleanEnv, assertRuntimeReport } = require('./verify-story-media-runtime.cjs');
const root = path.resolve(__dirname, '..');
const deno = process.env.STORY_MEDIA_DENO || 'deno';
const env = { ...cleanEnv, PATH: process.env.PATH, DENO_DIR: process.env.STORY_MEDIA_DENO_DIR || process.env.DENO_DIR || cleanEnv.DENO_DIR };
const config = path.join(root, 'supabase/functions/parse-story-media/deno.json');
const verifier = path.join(root, 'scripts/verify-story-parser-service.ts');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const tracked = [...inputs, 'scripts/prepare-story-parser.cjs', 'scripts/verify-story-parser-service.ts',
  'scripts/verify-story-parser-runtime.cjs', 'scripts/verify-story-media-runtime.cjs'];
const fingerprint = () => Object.fromEntries(tracked.map(file => [file, sha256(fs.readFileSync(path.join(root, file)))]));

function execute(args) {
  const result = spawnSync(deno, args, { cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024, shell: false });
  if (result.error) throw new Error('Deno verification could not execute: ' + result.error.code);
  if (result.signal) throw new Error('Deno verification terminated by signal: ' + result.signal);
  return result;
}

async function run(fixtureDirectory) {
  const fingerprints = fingerprint();
  const parent = path.join(root, 'dist/story-parser');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  assert.equal(fs.realpathSync(parent), parent);
  const directory = fs.mkdtempSync(path.join(parent, 'run-'));
  const packageDirectory = path.join(directory, 'package');
  const report = { result: 'incomplete', cases: [], providerWrites: 0, sourceUnchanged: false, fingerprints,
    scope: 'Offline packaged runtime and tampering controls, not hosted Storage, capacity or callee termination acceptance' };
  try {
    const located = execute(['eval', '--frozen', '--cached-only', '--config', config,
      'console.log(import.meta.resolve("npm:mediainfo.js@0.3.7/MediaInfoModule.wasm"))']);
    assert.equal(located.status, 0, located.stderr);
    const prepared = prepareStoryParser(packageDirectory, fileURLToPath(located.stdout.trim()));
    assert.throws(() => prepareStoryParser(packageDirectory, fileURLToPath(located.stdout.trim())), /Use a new parser package directory/);
    report.cases.push({ name: 'Reviewed package builds once and refuses an existing output', passed: true });
    const checked = execute(['check', '--frozen', '--cached-only', '--config', config, verifier,
      path.join(root, 'supabase/functions/validate-story-media/index.ts'), path.join(root, 'supabase/functions/parse-story-media/index.ts'),
      path.join(packageDirectory, 'supabase/functions/parse-story-media/index.ts')]);
    assert.equal(checked.status, 0, checked.stderr);
    report.cases.push({ name: 'Source and packaged entrypoints pass Deno type checking', passed: true });
    const fixtures = fixtureDirectory ? path.resolve(fixtureDirectory) : await createFixtures({ large: true });
    report.fixtures = path.relative(root, fixtures);
    const argumentsFor = (folder, deny = true) => ['run', '--no-prompt', '--frozen', '--cached-only', ...(deny ? ['--deny-net'] : []),
      '--allow-read', '--allow-env', '--config', config, verifier, folder, fixtures];
    const result = execute(argumentsFor(packageDirectory));
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const runtime = assertRuntimeReport(JSON.parse(result.stdout));
    assert.equal(runtime.failed, 0); assert.equal(runtime.sourceUnchanged, true); assert.equal(runtime.packageUnchanged, true);
    report.cases.push(...runtime.cases); report.runtime = runtime.runtime;
    report.packageHashes = prepared.packageHashes;
    report.package = path.relative(root, packageDirectory);
    for (const [filename, expected] of [['parser-module.js', /identity\.module\.sha256/], ['handler.ts', /Package differs from source/]]) {
      const altered = path.join(directory, 'tampered-' + filename.replace('.', '-'));
      fs.cpSync(packageDirectory, altered, { recursive: true, errorOnExist: true, force: false });
      const file = 'supabase/functions/parse-story-media/' + filename;
      fs.appendFileSync(path.join(altered, file), '\nvoid 0;\n');
      const evidenceFile = path.join(altered, 'package-evidence.json');
      const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
      evidence.packageHashes[file] = sha256(fs.readFileSync(path.join(altered, file)));
      if (filename === 'parser-module.js') evidence.parserModuleSha256 = evidence.packageHashes[file];
      fs.writeFileSync(evidenceFile, JSON.stringify(evidence), { mode: 0o600 });
      const refused = execute(argumentsFor(altered));
      assert.notEqual(refused.status, 0); assert.match(refused.stderr, expected);
      report.cases.push({ name: filename + ' tampering fails even after its package hash is rewritten', passed: true });
    }
    const permissions = execute(argumentsFor(packageDirectory, false));
    assert.notEqual(permissions.status, 0); assert.match(permissions.stderr, /Network must be explicitly denied/);
    report.cases.push({ name: 'Missing network-denial permission is rejected before parser execution', passed: true });
    for (const [file, hash] of Object.entries(prepared.packageHashes)) assert.equal(sha256(fs.readFileSync(path.join(packageDirectory, file))), hash);
    report.result = 'passed';
  } catch (error) {
    report.result = 'failed'; report.error = error.message;
  } finally {
    report.sourceUnchanged = JSON.stringify(fingerprints) === JSON.stringify(fingerprint());
    if (!report.sourceUnchanged) report.result = 'failed';
    report.passed = report.cases.filter(item => item.passed).length;
    report.failed = report.result === 'passed' ? 0 : 1;
    report.network = 'denied';
    fs.writeFileSync(path.join(directory, 'verification.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  const evidence = path.relative(root, path.join(directory, 'verification.json'));
  if (report.result !== 'passed') throw new Error('Parser package verification failed: ' + evidence + ': ' + report.error);
  return { result: report.result, passed: report.passed, failed: report.failed, package: report.package,
    sourceUnchanged: report.sourceUnchanged, fixtures: report.fixtures, evidence };
}

module.exports = { run };
if (require.main === module) {
  assert.ok(process.argv.length <= 3, 'Only an optional existing synthetic fixture directory is accepted');
  run(process.argv[2]).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}