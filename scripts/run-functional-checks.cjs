'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const publicScope = require('./public-test-scope.cjs');

const root = path.resolve(__dirname, '..');
// push-worker.js, PIPELINE.md and the stage-bundle controls are runtime-meaningful, so they are fingerprinted in every
// scope. tools/build-stage-site.cjs and hosting/stages do not exist yet; an unmatched pathspec contributes nothing.
// Historical note: the last full fingerprint produced by the previous scope list was
// 8db06e281c9da091e49e742ade7a21a4bf245e326f4445b55aff5161364c5596; earlier full fingerprints are not comparable to new ones.
const scope = ['index.html', 'legal.html', 'manifest.webmanifest', 'push-worker.js', 'version.txt', 'PIPELINE.md', 'js', 'css', 'assets', 'icons', 'guides', 'tests', 'scripts', 'supabase', 'office', 'package.json', 'package-lock.json', 'tools/sync-www.sh', 'tools/build-stage-site.cjs', 'hosting/stages', 'capacitor.config.json', 'android', 'ios', '.github/workflows'];

function pathspecs(scopeName) {
  return publicScope.resolveScope(scopeName) === publicScope.PUBLIC_SCOPE ? publicScope.publicPathspecs(scope) : scope;
}

function sourceFingerprint(directory = root, scopeName) {
  const files = [...new Set([...execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...pathspecs(scopeName)], { cwd: directory, encoding: 'utf8' }).split('\0').filter(Boolean), 'tools/sync-www.sh'])].sort();
  const digest = createHash('sha256');
  for (const file of files) {
    const absolute = path.join(directory, file);
    if (file.startsWith('supabase/.temp/')) continue;
    digest.update(file + '\0');
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) digest.update(fs.readFileSync(absolute));
    else digest.update('missing');
    digest.update('\0');
  }
  return digest.digest('hex');
}

function suites(directory = root, scopeName) {
  const files = fs.readdirSync(path.join(directory, 'tests')).sort();
  const discovered = files.map(file => 'tests/' + file);
  return [
    { name: 'unit', suffix: '.test.cjs' },
    { name: 'browser', suffix: '.e2e.cjs' }
  ].map(({ name, suffix }) => {
    const selection = publicScope.partition(discovered.filter(file => file.endsWith(suffix)), scopeName, suffix);
    return { name, files: selection.files, excluded: selection.excluded };
  });
}

function testArguments(files, report) {
  return ['--experimental-vm-modules', '--test', '--test-concurrency=1', '--test-reporter=spec', '--test-reporter=junit',
    '--test-reporter-destination=stdout', '--test-reporter-destination=' + report, ...files];
}

function run() {
  const startedAt = new Date().toISOString();
  const scopeName = publicScope.resolveScope(process.env.FORMORA_QA_SCOPE);
  const isPublic = scopeName === publicScope.PUBLIC_SCOPE;
  const outputRoot = path.resolve(process.env.FORMORA_QA_OUTPUT || path.join(os.tmpdir(), 'formora-qa'));
  fs.mkdirSync(outputRoot, { recursive: true });
  const output = fs.mkdtempSync(path.join(outputRoot, 'run-'));
  const pointer = path.join(outputRoot, 'verification.json');
  fs.writeFileSync(pointer, JSON.stringify({ startedAt, result: 'incomplete', completedAt: null, runDirectory: path.basename(output), releaseApproval: 'pending' }, null, 2) + '\n');
  const fingerprint = sourceFingerprint(root, scopeName);
  const selected = suites(root, scopeName);
  const excluded = selected.flatMap(suite => suite.excluded);
  const scopeEvidence = isPublic ? publicScope.describe(excluded) : null;
  const record = {
    startedAt, completedAt: null, stage: process.env.FORMORA_QA_STAGE || 'local', scope: scopeName,
    evidenceScope: (isPublic ? scopeEvidence.headline + ' ' + scopeEvidence.excludedTestCount + ' private-office-dependent test files were excluded and are unverified here ('
      + scopeEvidence.excludedFilesAbsent + ' of them are absent from this checkout, which is also unverified, not passing). ' : '')
      + 'Local or CI fixtures only; not deployed-environment, real-provider, physical-device or production acceptance',
    publicScope: scopeEvidence, excludedTestCount: isPublic ? scopeEvidence.excludedTestCount : 0,
    excludedTests: isPublic ? scopeEvidence.catalog : [],
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirty: !!execFileSync('git', ['status', '--porcelain', '--', ...pathspecs(scopeName)], { cwd: root, encoding: 'utf8' }).trim(),
    node: process.version, platform: process.platform, sourceFingerprint: fingerprint,
    sourceUnchanged: false, result: 'incomplete', runDirectory: path.basename(output), releaseApproval: 'pending', suites: []
  };
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(record, null, 2) + '\n');
  if (isPublic) reportScope(record);
  let exitCode = 0;
  try {
    for (const suite of selected) {
      const report = path.join(output, suite.name + '.xml');
      const args = testArguments(suite.files, report);
      if (!suite.files.length) throw new Error('No ' + suite.name + ' tests discovered');
      const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: process.env });
      const code = Number.isInteger(result.status) ? result.status : 1;
      record.suites.push({ name: suite.name, files: suite.files, excludedFiles: suite.excluded.map(entry => entry.file),
        report: path.basename(report), exitCode: code, error: result.error?.message || null, signal: result.signal || null });
      if (code !== 0) { exitCode = code; break; }
    }
  } catch (error) {
    record.error = error.message;
    exitCode = 1;
  } finally {
    record.sourceUnchanged = sourceFingerprint(root, scopeName) === fingerprint;
    if (!record.sourceUnchanged) { console.error('Source changed during verification; rerun the affected checks.'); exitCode = 1; }
    record.completedAt = new Date().toISOString();
    record.result = exitCode === 0 ? 'passed' : 'failed';
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(record, null, 2) + '\n');
    fs.writeFileSync(pointer, JSON.stringify(record, null, 2) + '\n');
    if (isPublic) reportScope(record);
    console.log('Verification reports: ' + output);
  }
  process.exitCode = exitCode;
}

function reportScope(record) {
  const lines = ['', '=== FORMORA QA SCOPE: ' + record.scope + ' ===', record.publicScope.headline,
    'Excluded ' + record.excludedTestCount + ' test files ('
      + record.publicScope.excludedPrivateOfficeRecordTests + ' private-office-record dependent, '
      + record.publicScope.excludedOfficeToolingTests + ' office-only tooling; '
      + record.publicScope.excludedFilesPresent + ' present in this checkout, '
      + record.publicScope.excludedFilesAbsent + ' absent). These did NOT run and are NOT passing:'];
  for (const entry of record.excludedTests) lines.push('  - ' + entry.file + (entry.present ? '' : ' [absent from this checkout]') + ' — ' + entry.reason);
  lines.push(record.publicScope.absenceSemantics,
    'Unverified in this scope:', ...record.publicScope.coverageGaps.map(gap => '  - ' + gap),
    'Fingerprint omits: ' + record.publicScope.fingerprintExcludes.join(', '),
    'Run the default full scope (no FORMORA_QA_SCOPE) for candidate-level evidence.', '');
  console.log(lines.join('\n'));
}

if (require.main === module) run();
module.exports = { sourceFingerprint, suites, testArguments, pathspecs, publicScope };