'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const scope = require('../scripts/public-test-scope.cjs');
const runner = require('../scripts/run-functional-checks.cjs');

const root = path.resolve(__dirname, '..');
const guardFile = 'tests/public-test-scope.test.cjs';
const helperFile = 'tests/product-lifecycle-independent.test.cjs';
const commentFile = 'tests/comment-publishing.test.cjs';
const readerFiles = ['tests/measurement-alerts-qa.test.cjs', 'tests/story-banner-independent.test.cjs'];
const catalogFiles = scope.EXCLUDED_TESTS.map(entry => entry.file);
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

function discover(directory = root) {
  return fs.readdirSync(path.join(directory, 'tests'), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(cjs|js)$/.test(entry.name))
    .map(entry => path.relative(directory, path.join(entry.parentPath, entry.name))).sort();
}

function scratch(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'formora-public-independent-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'tests'));
  return directory;
}

function put(directory, relative, bytes) {
  const filename = path.join(directory, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, bytes);
}

function actualGuard(directory, selectedScope = scope) {
  const registrations = new Map();
  const register = (title, callback) => registrations.set(title, callback);
  vm.runInNewContext(read(guardFile), {
    __dirname: path.join(directory, 'tests'),
    require(name) {
      if (name === 'node:test') return register;
      if (name === '../scripts/public-test-scope.cjs') return selectedScope;
      if (name === '../scripts/run-functional-checks.cjs') return runner;
      assert.ok(['node:assert/strict', 'node:fs', 'node:os', 'node:path', 'node:child_process'].includes(name), 'Review new guard dependency: ' + name);
      return require(name);
    },
  }, { filename: path.join(root, guardFile), timeout: 1000 });
  const callback = registrations.get('no unlisted suite reads a private office record');
  assert.equal(typeof callback, 'function');
  return callback;
}

function copiedPublic(context) {
  const directory = scratch(context);
  const files = scope.classifyCandidateFiles(discover()).publicFiles;
  for (const relative of [...files, 'scripts/public-test-scope.cjs', 'scripts/run-functional-checks.cjs']) {
    put(directory, relative, fs.readFileSync(path.join(root, relative)));
  }
  return { directory, files };
}

test('DEF-126 independent: actual recursive scan and discovery retain full scope and exactly exclude the catalog', context => {
  const discovered = discover();
  assert.equal(catalogFiles.length, 26);
  assert.equal(new Set(catalogFiles).size, 26);
  actualGuard(root)();
  const full = runner.suites(root, scope.FULL_SCOPE).flatMap(suite => suite.files);
  const defaults = runner.suites(root).flatMap(suite => suite.files);
  const publicSuites = runner.suites(root, scope.PUBLIC_SCOPE);
  const publicFiles = publicSuites.flatMap(suite => suite.files);
  assert.deepEqual(full, defaults);
  assert.deepEqual(full.sort(), discovered.filter(file => /\.(test|e2e)\.cjs$/.test(file) && path.dirname(file) === 'tests'));
  const presentCatalog = catalogFiles.filter(file => discovered.includes(file));
  assert.deepEqual(full.filter(file => !publicFiles.includes(file)).sort(), presentCatalog);
  for (const file of readerFiles) {
    assert.equal(full.includes(file), discovered.includes(file));
    assert.ok(!publicFiles.includes(file));
    assert.ok(publicSuites.flatMap(suite => suite.excluded).some(entry => entry.file === file && entry.present === discovered.includes(file)));
  }
  const classification = scope.classifyCandidateFiles([...readerFiles, helperFile, commentFile]);
  assert.deepEqual(classification.privateFiles.map(entry => entry.file), readerFiles);
  assert.deepEqual(classification.publicFiles, [commentFile, helperFile]);
  assert.deepEqual(classification.unreviewedFiles, []);
  assert.ok(publicFiles.includes(helperFile) && publicFiles.includes(commentFile));
  context.diagnostic(JSON.stringify({ recursiveCodeFiles: discovered.length, full: full.length, public: publicFiles.length,
    excluded: catalogFiles.length, privateRecordReaders: scope.expectedPrivateRecordTests(discovered).length,
    presentExclusions: presentCatalog.length, absentExclusionsUnverified: catalogFiles.length - presentCatalog.length,
    nestedHelpers: discovered.filter(file => path.dirname(file) !== 'tests') }));
});

test('DEF-126 independent: in-memory predecessor reproduces the unchanged guard failure with two readers and one literal', context => {
  const precedingCatalog = scope.EXCLUDED_TESTS.filter(entry => !readerFiles.includes(entry.file));
  assert.equal(precedingCatalog.length, 24);
  const preceding = { ...scope, EXCLUDED_TESTS: precedingCatalog,
    FIXTURE_ONLY_OFFICE_LITERALS: scope.FIXTURE_ONLY_OFFICE_LITERALS.filter(file => file !== helperFile),
    expectedPrivateRecordTests: discovered => precedingCatalog
      .filter(entry => entry.category === 'private-office-record' && discovered.includes(entry.file))
      .map(entry => entry.file).sort() };
  let observed;
  const reproduce = directory => assert.throws(actualGuard(directory, preceding), error => {
    assert.equal(error.code, 'ERR_ASSERTION');
    observed = Array.from(error.actual).filter(file => !error.expected.includes(file));
    assert.deepEqual(observed, [...readerFiles, helperFile].sort());
    assert.deepEqual(Array.from(error.expected).filter(file => !error.actual.includes(file)), []);
    return true;
  });
  const realSourceReproductionExecuted = readerFiles.every(file => discover().includes(file));
  if (realSourceReproductionExecuted) reproduce(root);
  const { directory } = copiedPublic(context);
  for (const file of readerFiles) {
    const records = scope.EXCLUDED_TESTS.find(entry => entry.file === file).records;
    put(directory, file, records.map(record => 'require("node:fs").readFileSync(' + JSON.stringify(record) + ', "utf8");').join('\n'));
  }
  actualGuard(directory)();
  reproduce(directory);
  context.diagnostic(JSON.stringify({ expectedFailure: true, assertion: 'ERR_ASSERTION', catalogEntries: precedingCatalog.length,
    uncatalogued: observed, actualPrivateReaders: readerFiles, literalOnly: helperFile, diskCatalogMutated: false,
    realSourceReproductionExecuted, absentPrivateSourceSemantics: 'unverified', syntheticReaderControlExecuted: true }));
});

test('DEF-126 independent: a copied public checkout keeps all absent exclusions unverified and runs its real drift guard', context => {
  const { directory, files } = copiedPublic(context);
  const copiedScope = require(path.join(directory, 'scripts/public-test-scope.cjs'));
  const copiedRunner = require(path.join(directory, 'scripts/run-functional-checks.cjs'));
  const suites = copiedRunner.suites(directory, copiedScope.PUBLIC_SCOPE);
  const excluded = suites.flatMap(suite => suite.excluded);
  const description = copiedScope.describe(excluded);
  assert.equal(description.excludedTestCount, 26);
  assert.equal(description.excludedPrivateOfficeRecordTests, 25);
  assert.equal(description.excludedOfficeToolingTests, 1);
  assert.equal(description.excludedFilesPresent, 0);
  assert.equal(description.excludedFilesAbsent, 26);
  assert.deepEqual(description.absentFiles, catalogFiles);
  assert.ok(description.catalog.every(entry => entry.present === false && typeof entry.unverified === 'string' && entry.unverified.length > 10));
  assert.ok(description.catalog.every(entry => !Object.hasOwn(entry, 'passed') && entry.result !== 'passed'));
  assert.match(description.absenceSemantics, /unverified, not passing/);
  assert.match(description.headline, /NOT full candidate approval and NOT release acceptance/);
  for (const entry of copiedScope.EXCLUDED_TESTS) {
    for (const relative of [entry.file, ...entry.records]) assert.equal(fs.existsSync(path.join(directory, relative)), false, relative);
  }
  assert.deepEqual(copiedScope.reviewExclusions(discover(directory)), { present: [], absent: catalogFiles });
  assert.deepEqual(copiedScope.expectedPrivateRecordTests(discover(directory)), []);
  assert.ok(suites.every(suite => suite.files.length > 0));
  assert.ok(suites.flatMap(suite => suite.files).includes(helperFile));
  assert.ok(files.some(file => path.dirname(file) !== 'tests'));
  actualGuard(directory, copiedScope)();
  context.diagnostic(JSON.stringify({ copiedPublicCodeFiles: files.length, absentCatalogEntries: 26, privateRecordEntries: 25,
    toolingEntries: 1, helperPresent: true, guardExecuted: true, fullSuiteExecuted: false }));
});

test('DEF-126 independent: an unknown nested private reader still fails the unmodified filesystem guard', context => {
  const { directory } = copiedPublic(context);
  const unknown = 'tests/helpers/independent-unreviewed-reader.cjs';
  const record = scope.EXCLUDED_TESTS.find(entry => entry.file === readerFiles[0]).records[0];
  put(directory, unknown, 'require("node:fs").readFileSync(' + JSON.stringify(record) + ', "utf8");\n');
  assert.throws(actualGuard(directory), error => {
    assert.equal(error.code, 'ERR_ASSERTION');
    assert.deepEqual(Array.from(error.actual), [unknown]);
    assert.deepEqual(Array.from(error.expected), []);
    return true;
  });
  assert.deepEqual(scope.classifyCandidateFiles([unknown]).publicFiles, [unknown]);
  context.diagnostic(JSON.stringify({ unknownReaderRejectedByGuard: true, classifierAloneIsNotStagingBoundary: true,
    syntheticReaderExecuted: false, guardSourceUnmodified: true }));
});

test('DEF-126 independent: all catalog inputs stay outside the public fingerprint while helper, comment, App and CI bytes matter', context => {
  const directory = scratch(context);
  execFileSync('git', ['init', '-q'], { cwd: directory });
  const publicInputs = [helperFile, commentFile, 'js/app.js', '.github/workflows/ci.yml'];
  const privateInputs = [...new Set(scope.EXCLUDED_TESTS.flatMap(entry => [entry.file, ...entry.records]))];
  for (const relative of publicInputs) put(directory, relative, fs.readFileSync(path.join(root, relative)));
  for (const relative of privateInputs) put(directory, relative, 'synthetic private fingerprint input\n');
  const publicBefore = runner.sourceFingerprint(directory, scope.PUBLIC_SCOPE);
  const fullBefore = runner.sourceFingerprint(directory, scope.FULL_SCOPE);
  for (const relative of privateInputs) put(directory, relative, 'changed synthetic private fingerprint input\n');
  assert.equal(runner.sourceFingerprint(directory, scope.PUBLIC_SCOPE), publicBefore);
  assert.notEqual(runner.sourceFingerprint(directory, scope.FULL_SCOPE), fullBefore);
  for (const relative of publicInputs) {
    const before = runner.sourceFingerprint(directory, scope.PUBLIC_SCOPE);
    fs.appendFileSync(path.join(directory, relative), '\n');
    assert.notEqual(runner.sourceFingerprint(directory, scope.PUBLIC_SCOPE), before, relative);
  }
  const publicSpecs = runner.pathspecs(scope.PUBLIC_SCOPE);
  for (const relative of catalogFiles) assert.ok(publicSpecs.includes(':(exclude)' + relative));
  context.diagnostic(JSON.stringify({ catalogInputs: catalogFiles.length, syntheticPrivateInputs: privateInputs.length,
    publicFingerprintUnaffectedByPrivateEdits: true, fullFingerprintDetectsPrivateEdits: true, sensitivePublicInputs: publicInputs }));
});

test('DEF-126 independent: the shared snapshot helper defaults to public inputs and reads a private report only when its caller supplies one', context => {
  const directory = scratch(context);
  const helperSource = read(helperFile);
  const commentSource = read(commentFile);
  assert.ok(scope.FIXTURE_ONLY_OFFICE_LITERALS.includes(helperFile));
  assert.ok(!catalogFiles.includes(helperFile));
  assert.match(helperSource, /excludedFromRuntimeComparison:/);
  assert.ok(!commentSource.includes(scope.PRIVATE_PATH_PREFIXES[0]));
  for (const directoryName of ['js', 'css', 'tests', 'assets', 'icons', 'guides', 'supabase', 'node_modules/playwright', 'node_modules/playwright-core']) {
    fs.mkdirSync(path.join(directory, directoryName), { recursive: true });
  }
  put(directory, helperFile, helperSource);
  put(directory, 'js/app.js', 'const syntheticPublicInput = true;\n');
  const outputDirectory = path.join(directory, scope.PRIVATE_PATH_PREFIXES.find(prefix => prefix.startsWith('dist')));
  fs.mkdirSync(outputDirectory);
  const accesses = [];
  const watchedFs = new Proxy(fs, { get(target, key) {
    if (['lstatSync', 'statSync', 'existsSync', 'readdirSync', 'readFileSync', 'readlinkSync'].includes(key)) return (filename, ...args) => {
      const absolute = path.resolve(filename);
      assert.ok(absolute.startsWith(directory + path.sep), 'Helper reads must remain in the disposable fixture');
      accesses.push(path.relative(directory, absolute));
      return target[key](filename, ...args);
    };
    return target[key];
  } });
  const fixtureModule = { exports: {} };
  const neverRun = () => { throw new Error('No browser or test registration is permitted in this helper check'); };
  vm.runInNewContext(helperSource, {
    __dirname: path.join(directory, 'tests'), module: fixtureModule,
    process: { env: {}, execArgv: [] },
    require(name) {
      if (name === 'node:fs') return watchedFs;
      if (name === 'node:test') return { test: neverRun, before: neverRun, after: neverRun };
      if (name === 'playwright') return { chromium: { launch: neverRun } };
      assert.ok(['node:assert/strict', 'node:path', 'node:module', 'node:crypto'].includes(name), 'Review new helper dependency: ' + name);
      return require(name);
    },
  }, { filename: path.join(directory, helperFile), timeout: 1000 });
  const snapshot = fixtureModule.exports.snapshot(outputDirectory, 'default');
  const privatePrefix = scope.PRIVATE_PATH_PREFIXES[0];
  assert.ok(snapshot.excludedFromRuntimeComparison.some(relative => relative.startsWith(privatePrefix)));
  assert.deepEqual(accesses.filter(relative => relative.startsWith(privatePrefix)), []);
  assert.ok(!Object.keys(snapshot.files).some(relative => relative.startsWith(privatePrefix)));
  const explicitRecord = scope.EXCLUDED_TESTS.find(entry => entry.file === readerFiles[1]).records[0];
  put(directory, explicitRecord, '{"synthetic":true}\n');
  accesses.length = 0;
  const explicit = fixtureModule.exports.snapshot(outputDirectory, 'explicit', [explicitRecord]);
  assert.ok(accesses.includes(explicitRecord));
  assert.ok(Object.hasOwn(explicit.files, explicitRecord));
  context.diagnostic(JSON.stringify({ defaultPrivateReads: 0, callerExplicitPrivateReadObserved: true,
    privateBytesSynthetic: true, realPrivateRecordsRead: false, browserExecutions: 0, commentSuitePrivateLiteral: false }));
});