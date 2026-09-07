'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sourceFingerprint, suites, pathspecs } = require('../scripts/run-functional-checks.cjs');
const scopeModule = require('../scripts/public-test-scope.cjs');
const { PUBLIC_SCOPE, FULL_SCOPE, EXCLUDED_TESTS, FIXTURE_ONLY_OFFICE_LITERALS } = scopeModule;

const root = path.resolve(__dirname, '..');
const officeReference = /['"`](?:\.{1,2}\/)?office\//;
const catalogFiles = EXCLUDED_TESTS.map(entry => entry.file);

// Discovery must be provable on a clean public checkout, where the private suites are deliberately absent.
function checkout(context, files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'formora-checkout-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'tests'));
  for (const file of files) fs.writeFileSync(path.join(directory, file), '// fixture\n');
  return directory;
}

const publicOnly = ['tests/app-startup.e2e.cjs', 'tests/preferences.test.cjs'];

test('the default scope keeps running every discovered suite, including private office tests', context => {
  assert.equal(scopeModule.resolveScope(undefined), FULL_SCOPE);
  assert.equal(scopeModule.resolveScope(FULL_SCOPE), FULL_SCOPE);
  const directory = checkout(context, [...publicOnly, ...catalogFiles]);
  const [unit, browser] = suites(directory);
  assert.ok(unit.files.includes('tests/office-dashboard.test.cjs'));
  assert.ok(browser.files.includes('tests/office-dashboard.e2e.cjs'));
  assert.deepEqual([...unit.files, ...browser.files].sort(), [...publicOnly, ...catalogFiles].sort());
  assert.deepEqual([...unit.excluded, ...browser.excluded], []);
  assert.deepEqual(pathspecs(FULL_SCOPE), pathspecs(undefined));
  assert.ok(pathspecs(FULL_SCOPE).includes('office'), 'Default fingerprint scope must be unchanged');
});

test('the public scope drops exactly the reviewed private office suites and nothing else', context => {
  const directory = checkout(context, [...publicOnly, ...catalogFiles]);
  const full = suites(directory, FULL_SCOPE), scoped = suites(directory, PUBLIC_SCOPE);
  const dropped = [], kept = [];
  for (const [index, suite] of scoped.entries()) {
    kept.push(...suite.files);
    dropped.push(...full[index].files.filter(file => !suite.files.includes(file)));
    for (const entry of suite.excluded) assert.equal(entry.present, full[index].files.includes(entry.file));
  }
  assert.deepEqual(dropped.sort(), [...catalogFiles].sort());
  assert.equal(scoped.flatMap(suite => suite.excluded).length, EXCLUDED_TESTS.length);
  assert.deepEqual(kept.sort(), [...publicOnly].sort());
  assert.ok(scoped.every(suite => suite.files.length), 'Neither public suite may become empty');
});

test('a clean public checkout without the private suites still reports the whole catalog and does not fail', context => {
  const directory = checkout(context, publicOnly);
  const scoped = suites(directory, PUBLIC_SCOPE);
  const excluded = scoped.flatMap(suite => suite.excluded);
  assert.deepEqual(excluded.map(entry => entry.file).sort(), [...catalogFiles].sort());
  assert.ok(excluded.every(entry => entry.present === false));
  assert.deepEqual(scoped.flatMap(suite => suite.files).sort(), [...publicOnly].sort());
  const evidence = scopeModule.describe(excluded);
  assert.equal(evidence.excludedTestCount, EXCLUDED_TESTS.length);
  assert.equal(evidence.excludedFilesAbsent, EXCLUDED_TESTS.length);
  assert.equal(evidence.excludedFilesPresent, 0);
  assert.match(evidence.absenceSemantics, /unverified, not passing/);
  assert.deepEqual(scopeModule.reviewExclusions(publicOnly), { present: [], absent: [...catalogFiles] });
  assert.deepEqual(scopeModule.expectedPrivateRecordTests(publicOnly), []);
});

test('every exclusion is documented and reported as unverified rather than passing, present or absent', () => {
  const partial = [{ file: catalogFiles[0], present: true }];
  const evidence = scopeModule.describe(partial);
  assert.equal(evidence.excludedTestCount, EXCLUDED_TESTS.length);
  assert.equal(evidence.excludedPrivateOfficeRecordTests + evidence.excludedOfficeToolingTests, EXCLUDED_TESTS.length);
  assert.equal(evidence.excludedFilesPresent, 1);
  assert.deepEqual(evidence.absentFiles, catalogFiles.slice(1));
  assert.match(evidence.headline, /NOT full candidate approval/);
  assert.deepEqual(scopeModule.describe().catalog.map(entry => entry.file), catalogFiles);
  for (const entry of EXCLUDED_TESTS) {
    assert.ok(entry.reason.length > 20 && entry.gap.length > 10, entry.file + ' needs a reason and a coverage gap');
    assert.ok(evidence.coverageGaps.includes(entry.gap));
    assert.ok(evidence.fingerprintExcludes.includes(entry.file), entry.file + ' must be kept out of the public fingerprint');
  }
  assert.throws(() => scopeModule.resolveScope('public'), /Unknown FORMORA_QA_SCOPE/);
});

test('no unlisted suite reads a private office record', () => {
  const discovered = fs.readdirSync(path.join(root, 'tests')).map(file => 'tests/' + file);
  const detected = discovered
    .filter(file => /\.(test|e2e)\.cjs$/.test(file) && officeReference.test(fs.readFileSync(path.join(root, file), 'utf8')));
  for (const fixtureOnly of FIXTURE_ONLY_OFFICE_LITERALS) {
    if (discovered.includes(fixtureOnly)) assert.ok(detected.includes(fixtureOnly), fixtureOnly + ' no longer mentions office/; drop the allowance');
  }
  // Intersected with discovery: an absent private suite is a documented gap, a newly detected reader is a failure.
  assert.deepEqual(detected.filter(file => !FIXTURE_ONLY_OFFICE_LITERALS.includes(file)).sort(),
    scopeModule.expectedPrivateRecordTests(discovered));
});

test('the public fingerprint ignores private office changes but still detects application changes', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'formora-scope-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), content);
  };
  execFileSync('git', ['init', '-q'], { cwd: directory });
  const shipped = ['index.html', 'js/app.js', 'css/styles.css', 'tests/app.test.cjs', 'scripts/run-qa-audit.cjs',
    'supabase/schema.sql', 'tools/sync-www.sh', '.github/workflows/ci.yml', 'push-worker.js', 'PIPELINE.md',
    'tools/build-stage-site.cjs', 'hosting/stages/dev.json'];
  const privateInputs = ['office/board.json', 'office/dashboard.js', 'scripts/office-server.cjs', '.github/agents/eng.agent.md',
    'tests/office-dashboard.test.cjs', 'tests/office-server.test.cjs', 'tests/stories-client.test.cjs'];
  for (const file of [...shipped, ...privateInputs]) write(file, 'v1 ' + file);

  const baselineFull = sourceFingerprint(directory, FULL_SCOPE), baselinePublic = sourceFingerprint(directory, PUBLIC_SCOPE);
  assert.notEqual(baselineFull, baselinePublic);
  for (const priv of privateInputs) {
    write(priv, 'private edit');
    assert.equal(sourceFingerprint(directory, PUBLIC_SCOPE), baselinePublic, priv + ' must not move the public fingerprint');
  }
  assert.notEqual(sourceFingerprint(directory, FULL_SCOPE), baselineFull, 'The full fingerprint must still cover office and every excluded suite');

  for (const file of shipped) {
    const before = sourceFingerprint(directory, PUBLIC_SCOPE);
    write(file, 'app edit ' + file);
    assert.notEqual(sourceFingerprint(directory, PUBLIC_SCOPE), before, file + ' must be covered by the public fingerprint');
  }
});

test('candidate files are classified allowlist-first without touching git', () => {
  const { publicFiles, privateFiles, unreviewedFiles } = scopeModule.classifyCandidateFiles(['js/app.js', 'office/board.json',
    'scripts/gen-agents.js', 'backups/private.json', '.github/workflows/ci.yml', 'tests/office-dashboard.test.cjs',
    'push-worker.js', 'hosting/stages/dev.json']);
  assert.deepEqual(publicFiles, ['.github/workflows/ci.yml', 'hosting/stages/dev.json', 'js/app.js', 'push-worker.js']);
  assert.deepEqual(privateFiles.map(entry => entry.file), ['backups/private.json', 'office/board.json', 'scripts/gen-agents.js', 'tests/office-dashboard.test.cjs']);
  assert.ok(privateFiles.every(entry => entry.reason.length > 10));
  assert.deepEqual(unreviewedFiles, []);
  for (const entry of EXCLUDED_TESTS) {
    assert.deepEqual(scopeModule.classifyCandidateFiles([entry.file]).publicFiles, [], entry.file + ' must never be listed as public');
  }
  assert.deepEqual(scopeModule.classifyCandidateFiles(['js/app.js']), scopeModule.classifyCandidateFiles(['js/app.js']));
});

test('unsafe and unknown candidate paths are rejected instead of assumed publishable', () => {
  const unsafe = ['../outside.js', 'js/../../etc/passwd', '/etc/passwd', 'C:\\Windows\\win.ini', 'js\\app.js', '.env',
    'supabase/.env.local', 'ios/App/App.mobileprovision', 'keys/service-account.pem', 'js//app.js', './js/app.js', 'js/', '', 'js/a\u0000b.js'];
  const { publicFiles, privateFiles, unreviewedFiles } = scopeModule.classifyCandidateFiles([...unsafe, 'unknown-root-file.sh', 'random/dir/file.js']);
  assert.deepEqual(publicFiles, []);
  assert.deepEqual(privateFiles, []);
  assert.equal(unreviewedFiles.length, unsafe.length + 2);
  assert.ok(unreviewedFiles.every(entry => entry.reason.length > 10));
  assert.equal(scopeModule.candidateRejection('js/app.js'), null);
  assert.match(scopeModule.candidateRejection('../secret.js'), /traversal/);
  assert.match(scopeModule.candidateRejection('/etc/passwd'), /Absolute/);
  assert.match(scopeModule.candidateRejection('config/prod.key'), /secret-like/);
  assert.match(scopeModule.classifyCandidateFiles(['random/dir/file.js']).unreviewedFiles[0].reason, /defaults to deny/);
});
