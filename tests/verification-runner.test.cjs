'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/run-functional-checks.cjs'), 'utf8');
const { EXCLUDED_TESTS, PUBLIC_SCOPE } = require('../scripts/public-test-scope.cjs');

function fixture({ aborted = false, status = 0, scope, privateSuitesPresent = true } = {}) {
  const files = new Map([['/reports/verification.json', JSON.stringify({ result: 'passed' })]]), written = [];
  const gitQueries = [], logs = [];
  const discovered = [...new Set([...(privateSuitesPresent ? EXCLUDED_TESTS.map(entry => entry.file.replace('tests/', '')) : []), 'one.test.cjs', 'one.e2e.cjs'])];
  const memoryFs = {
    mkdirSync() {}, mkdtempSync: () => '/reports/run-new',
    readdirSync: () => discovered,
    existsSync: () => false,
    writeFileSync(file, content) { files.set(file, content); written.push({ file, content }); }
  };
  const main = {};
  const fakeRequire = name => name === 'node:fs' ? memoryFs : name === './public-test-scope.cjs' ? require('../scripts/public-test-scope.cjs') : name === 'node:child_process' ? {
    execFileSync(command, args) {
      gitQueries.push(args);
      if (args[0] === 'ls-files') return 'index.html\0';
      if (args[0] === 'status') return '';
      return args.includes('HEAD') ? 'fixture-sha\n' : 'dev\n';
    },
    spawnSync() {
      assert.equal(JSON.parse(files.get('/reports/verification.json')).result, 'incomplete');
      assert.equal(JSON.parse(files.get('/reports/run-new/verification.json')).result, 'incomplete');
      if (aborted) throw new Error('fixture abort');
      return { status };
    }
  } : require(name);
  fakeRequire.main = main;
  const process = { env: { FORMORA_QA_OUTPUT: '/reports', ...(scope ? { FORMORA_QA_SCOPE: scope } : {}) }, version: 'fixture-node', platform: 'fixture', execPath: '/node', exitCode: undefined };
  vm.runInNewContext(source, { require: fakeRequire, module: main, __dirname: path.resolve(__dirname, '../scripts'), console: { log: line => logs.push(line), error: line => logs.push(line) }, process });
  return { files, written, process, gitQueries, logs };
}

test('verification invalidates old passing evidence before starting any test process', () => {
  const { written, files, process } = fixture();
  assert.equal(JSON.parse(written[0].content).result, 'incomplete');
  const record = JSON.parse(files.get('/reports/verification.json'));
  assert.equal(record.result, 'passed');
  assert.equal(record.runDirectory, 'run-new');
  assert.equal(record.releaseApproval, 'pending');
  assert.equal(record.suites.length, 2);
  assert.equal(process.exitCode, 0);
});

test('failed or interrupted execution cannot retain an earlier passing result', () => {
  for (const options of [{ status: 1 }, { aborted: true }]) {
    const { files, process } = fixture(options);
    assert.equal(JSON.parse(files.get('/reports/verification.json')).result, 'failed');
    assert.equal(process.exitCode, 1);
  }
});

test('verification fingerprints the public assets and native packaging inputs used by the tests', () => {
  const { gitQueries, files } = fixture();
  assert.equal(JSON.parse(files.get('/reports/verification.json')).scope, 'full');
  for (const query of gitQueries.filter(args => args[0] === 'ls-files')) {
    for (const file of ['legal.html', 'manifest.webmanifest', 'assets', 'icons', 'guides', 'tools/sync-www.sh', 'capacitor.config.json',
      'android', 'ios', 'office', 'push-worker.js', 'PIPELINE.md', 'tools/build-stage-site.cjs', 'hosting/stages']) {
      assert.ok(query.includes(file), file + ' must be included in the verified source scope');
    }
  }
});

test('the opt-in public scope excludes private office suites loudly and never reads private records', () => {
  const { files, logs, gitQueries, process } = fixture({ scope: PUBLIC_SCOPE });
  const record = JSON.parse(files.get('/reports/verification.json'));
  assert.equal(process.exitCode, 0);
  assert.equal(record.result, 'passed');
  assert.equal(record.scope, PUBLIC_SCOPE);
  assert.equal(record.releaseApproval, 'pending');
  assert.equal(record.excludedTestCount, EXCLUDED_TESTS.length);
  assert.equal(record.publicScope.excludedFilesPresent, EXCLUDED_TESTS.length);
  assert.equal(record.publicScope.excludedFilesAbsent, 0);
  assert.match(record.evidenceScope, /NOT full candidate approval/);
  assert.match(record.evidenceScope, new RegExp(EXCLUDED_TESTS.length + ' private-office-dependent test files were excluded'));
  assert.deepEqual(record.excludedTests.map(entry => entry.file).sort(), EXCLUDED_TESTS.map(entry => entry.file).sort());
  assert.ok(record.excludedTests.every(entry => entry.reason && entry.unverified && entry.present === true));
  assert.ok(record.suites.every(suite => suite.files.every(file => !EXCLUDED_TESTS.some(entry => entry.file === file))));
  const printed = logs.join('\n');
  assert.match(printed, /These did NOT run and are NOT passing/);
  for (const entry of EXCLUDED_TESTS) assert.match(printed, new RegExp(entry.file.replace(/[.]/g, '[.]')));
  for (const query of gitQueries.filter(args => args[0] === 'ls-files' || args[0] === 'status')) {
    assert.equal(query.includes('office'), false, 'Public runs must not list private office records');
    assert.ok(query.includes(':(exclude)office'));
    assert.ok(query.includes(':(exclude)scripts/office-server.cjs') && query.includes('tests'));
    for (const entry of EXCLUDED_TESTS) assert.ok(query.includes(':(exclude)' + entry.file), entry.file + ' must be excluded from the public fingerprint');
  }
});

test('a public checkout without the private suites still passes and records them as absent and unverified', () => {
  const { files, logs, process } = fixture({ scope: PUBLIC_SCOPE, privateSuitesPresent: false });
  const record = JSON.parse(files.get('/reports/verification.json'));
  assert.equal(process.exitCode, 0);
  assert.equal(record.result, 'passed');
  assert.equal(record.excludedTestCount, EXCLUDED_TESTS.length);
  assert.equal(record.publicScope.excludedFilesAbsent, EXCLUDED_TESTS.length);
  assert.equal(record.publicScope.excludedFilesPresent, 0);
  assert.deepEqual(record.publicScope.absentFiles.sort(), EXCLUDED_TESTS.map(entry => entry.file).sort());
  assert.ok(record.excludedTests.every(entry => entry.present === false && entry.reason && entry.unverified));
  assert.match(record.evidenceScope, new RegExp(EXCLUDED_TESTS.length + ' of them are absent from this checkout'));
  const printed = logs.join('\n');
  assert.match(printed, /absent from this checkout/);
  assert.match(printed, /unverified, not passing/);
});