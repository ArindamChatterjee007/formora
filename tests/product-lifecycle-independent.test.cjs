'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const exactLifecycle = 'UI signup -> onboarding -> delivered OTP -> meal -> confirmed logout -> login -> reload';
const guard = "if (location.origin !== 'null') localStorage.setItem('fm_dl_x', '1');";
const initialMarker = 'DEF124_DELIBERATE_INITIAL_DOCUMENT_ERROR';
const applicationMarker = 'DEF124_DELIBERATE_APPLICATION_ERROR';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function writeJSON(filename, value) {
  fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n');
}

function freshEvidence(label) {
  const parent = path.join(root, 'dist', 'independent-qa-2026-09-07');
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, label + '-'));
}

function snapshot(directory, label, extraFiles = []) {
  const files = {};
  const treeScopes = ['js', 'css', 'tests', 'assets', 'icons', 'guides', 'supabase',
    'node_modules/playwright', 'node_modules/playwright-core'];
  const skipped = new Set(['.DS_Store', 'node_modules', '.git', '.temp']);
  function visit(relative, top = false) {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      files[relative] = { kind: 'symlink', target: fs.readlinkSync(absolute), sha256: sha256(fs.readlinkSync(absolute)) };
    } else if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolute).sort()) {
        if (!skipped.has(entry)) visit(path.join(relative, entry));
      }
    } else if (stat.isFile()) {
      files[relative] = { bytes: stat.size, sha256: sha256(fs.readFileSync(absolute)) };
    }
  }
  for (const scope of treeScopes) visit(scope, true);
  const standalone = ['index.html', 'legal.html', 'manifest.webmanifest', 'push-worker.js', 'version.txt',
    'capacitor.config.json', 'package.json', 'package-lock.json', 'node_modules/.package-lock.json', ...extraFiles];
  for (const relative of [...new Set(standalone)].sort()) if (fs.existsSync(path.join(root, relative))) visit(relative);
  const sortedFiles = Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
  const aggregate = sha256(JSON.stringify(sortedFiles));
  const trees = Object.fromEntries(treeScopes.map(scope => {
    const entries = Object.entries(sortedFiles).filter(([relative]) => relative.startsWith(scope + '/'));
    return [scope, { files: entries.length, sha256: sha256(JSON.stringify(entries)) }];
  }));
  const result = { capturedAt: new Date().toISOString(), aggregate, fileCount: Object.keys(sortedFiles).length,
    treeScopes, trees, files: sortedFiles, excludedFromRuntimeComparison: ['office/board.json', 'office/qa-review-2026-09-07.json', 'dist/'] };
  const filename = path.join(directory, label + '.json');
  writeJSON(filename, result);
  return { ...result, manifest: path.relative(root, filename), manifestSha256: sha256(fs.readFileSync(filename)) };
}

function snapshotSummary(value) {
  const required = ['index.html', 'css/styles.css', 'js/app.js', 'js/cloud.js', 'js/mod/social.js', 'js/mod/stories.js',
    'js/supaauth.js', 'js/auth.js', 'js/mod/profile.js', 'js/config.js', 'package.json', 'package-lock.json',
    'node_modules/.package-lock.json', 'node_modules/playwright/package.json', 'node_modules/playwright-core/package.json',
    'node_modules/playwright-core/browsers.json', 'tests/product-lifecycle.e2e.cjs', 'tests/product-lifecycle-independent.test.cjs',
    'tests/story-independent-review.test.cjs', 'tests/story-geometry-qa.test.cjs'];
  return { manifest: value.manifest, manifestSha256: value.manifestSha256, aggregate: value.aggregate,
    fileCount: value.fileCount, trees: value.trees,
    files: Object.fromEntries(required.filter(relative => value.files[relative]).map(relative => [relative, value.files[relative].sha256])),
    excludedFromRuntimeComparison: value.excludedFromRuntimeComparison };
}

function loadFixture(relative, replacements = {}) {
  const filename = path.join(root, relative);
  const source = fs.readFileSync(filename, 'utf8');
  const registrations = { tests: [], before: [], after: [] };
  const fixtureModule = new Module(filename, module);
  fixtureModule.filename = filename;
  fixtureModule.paths = Module._nodeModulePaths(path.dirname(filename));
  const requireOriginal = fixtureModule.require.bind(fixtureModule);
  fixtureModule.require = name => {
    if (name === 'node:test') return {
      test: (title, options, callback) => registrations.tests.push({ title, options: typeof options === 'function' ? {} : options,
        callback: typeof options === 'function' ? options : callback }),
      before: callback => registrations.before.push(callback),
      after: callback => registrations.after.push(callback),
    };
    return Object.hasOwn(replacements, name) ? replacements[name] : requireOriginal(name);
  };
  const appendix = relative === 'tests/product-lifecycle.e2e.cjs'
    ? '\nmodule.exports = { setup, fixtureBackend };\n' : '\nmodule.exports = { browserFixture };\n';
  fixtureModule._compile(source + appendix, filename);
  return { ...registrations, ...fixtureModule.exports, sourceSha256: sha256(source),
    executedSha256: sha256(source + appendix), appendix };
}

function serializedError(error) {
  return { name: error.name, message: error.message, stack: error.stack || null };
}

async function observedChromium(options, getRecord, configureContext) {
  const browser = await chromium.launch({ ...options, args: [...new Set([...(options.args || []),
    '--disable-background-networking', '--disable-component-update', '--disable-domain-reliability',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'])] });
  const originalNewContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await originalNewContext(...args);
    const record = getRecord();
    record.contexts ||= [];
    const observation = { observerAttachedBeforeNewPage: true, errors: [], routes: [], pageCreation: false };
    record.contexts.push(observation);
    context.on('weberror', event => observation.errors.push({ ...serializedError(event.error()),
      url: event.page()?.url() || null, duringNewPage: observation.pageCreation }));
    const originalNewPage = context.newPage.bind(context);
    context.newPage = async (...pageArgs) => {
      observation.pageCreation = true;
      try { return await originalNewPage(...pageArgs); }
      finally { observation.pageCreation = false; }
    };
    const originalRoute = context.route.bind(context);
    context.route = (pattern, handler, routeOptions) => originalRoute(pattern, async (route, request) => {
      const observedRoute = new Proxy(route, {
        get(target, key) {
          if (['continue', 'fulfill', 'abort', 'fallback'].includes(key)) return async (...actionArgs) => {
            const url = new URL(target.request().url());
            observation.routes.push({ url: url.href, method: target.request().method(),
              type: target.request().resourceType(), action: key });
            if (key === 'continue') assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Only loopback transport may continue');
            return target[key](...actionArgs);
          };
          const value = target[key];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return handler(observedRoute, request);
    }, routeOptions);
    if (configureContext) await configureContext(context, record);
    return context;
  };
  browser.independentVersion = browser.version();
  return browser;
}

function runLifecycleAcceptance() {
  const directory = freshEvidence('core-paid');
  const records = [];
  let currentRecord;
  let sourceBefore;
  let browserVersion;
  const executable = process.env.OFFICE_BROWSER_EXECUTABLE || chromium.executablePath();
  const browserExecutableBefore = sha256(fs.readFileSync(executable));
  const command = "node --test --test-concurrency=1 --test-timeout=120000 --test-name-pattern='^DEF-124 independent:' tests/product-lifecycle-independent.test.cjs";
  process.env.APP_QA_SCREENSHOTS = path.join(directory, 'images');
  const observedAssert = new Proxy(assert, {
    get(target, key) {
      if (key === 'deepEqual') return (actual, expected, message) => {
        if (currentRecord && typeof message === 'string' && ['No uncaught JavaScript errors', 'No unexpected console errors',
          'All backend calls must have an explicit isolated fixture'].includes(message)) {
          currentRecord.fixtureAssertions ||= [];
          currentRecord.fixtureAssertions.push({ message, actual: structuredClone(actual), expected: structuredClone(expected) });
        }
        return target.deepEqual(actual, expected, message);
      };
      return target[key];
    },
  });
  const fixture = loadFixture('tests/product-lifecycle.e2e.cjs', {
    'node:assert/strict': observedAssert,
    playwright: { chromium: { launch: async options => {
      const browser = await observedChromium(options, () => currentRecord, async (context, record) => {
        if (record.mode === 'omit-guard') {
          const originalAdd = context.addInitScript.bind(context);
          context.addInitScript = async (script, ...args) => {
            const original = typeof script === 'function' ? script.toString() : '';
            if (!original.includes(guard)) return originalAdd(script, ...args);
            assert.equal(original.split(guard).length, 2, 'Mutate precisely the existing fixture storage guard');
            const modified = original.replace(guard, "localStorage.setItem('fm_dl_x', '1');");
            record.initScriptMutation = { originalSha256: sha256(original), executedSha256: sha256(modified),
              original, executed: modified, scope: 'In-memory fixture guard omission only; no disk or application edit' };
            return originalAdd({ content: '(' + modified + ')();' });
          };
        }
        if (record.mode === 'initial-error') await context.addInitScript(() => {
          if (location.origin === 'null') throw new Error('DEF124_DELIBERATE_INITIAL_DOCUMENT_ERROR');
        });
      });
      browserVersion = browser.independentVersion;
      return browser;
    } } },
  });
  const original = fixture.tests.filter(candidate => candidate.title === exactLifecycle);
  assert.equal(original.length, 1, 'Select the exact current lifecycle once');
  writeJSON(path.join(directory, 'invocation.json'), { command, cwd: root, executable: process.execPath,
    execArgv: process.execArgv, argv: process.argv, source: 'tests/product-lifecycle.e2e.cjs',
    sourceSha256: fixture.sourceSha256, executedSha256: fixture.executedSha256,
    appendedExports: fixture.appendix, originalTest: exactLifecycle, originalTestExecutions: 1,
    originalAssertionsPreserved: true, registration: 'Capture existing callbacks in memory; execute only the exact named callback; controls reuse current setup and teardown',
    requestedModel: 'GPT-6 Astra (copilot)', verifiedRuntimeModel: null });

  before(async () => {
    sourceBefore = snapshot(directory, 'source-before');
    for (const callback of fixture.before) await callback();
  });
  after(async () => {
    try { for (const callback of fixture.after) await callback(); }
    finally {
      const sourceAfter = snapshot(directory, 'source-after');
      const browserExecutableAfter = sha256(fs.readFileSync(executable));
      const sourceUnchanged = sourceBefore.aggregate === sourceAfter.aggregate && browserExecutableBefore === browserExecutableAfter;
      const evidence = { date: '2026-09-07', command, node: process.version, playwright: require('playwright/package.json').version,
        chromium: browserVersion, executable, browserExecutableBefore, browserExecutableAfter,
        sourceHashesBefore: snapshotSummary(sourceBefore), sourceHashesAfter: snapshotSummary(sourceAfter), sourceUnchanged,
        originalLifecycleExecutions: 1, cases: records,
        network: 'One Chromium instance; all browser routes recorded, non-loopback continue forbidden; fixture synthetic auth; websocket fixture rejection retained',
        outputDirectory: path.relative(root, directory) };
      writeJSON(path.join(directory, 'evidence.json'), evidence);
      console.log('Independent lifecycle evidence: ' + path.relative(root, path.join(directory, 'evidence.json')));
      assert.equal(sourceUnchanged, true, 'Source, fixture and installed dependency trees must remain unchanged during this window');
    }
  });

  test('DEF-124 independent: exact unchanged lifecycle once with earliest observer', { timeout: 60000 }, async testContext => {
    currentRecord = { name: exactLifecycle, mode: 'positive', originalCallbackExecuted: true };
    records.push(currentRecord);
    await original[0].callback(testContext);
    currentRecord.bodyPassed = true;
  });

  for (const [mode, title, expected] of [
    ['omit-guard', 'guard omission exposes original SecurityError and fails real fixture assertion', /SecurityError.*localStorage|Failed to read the 'localStorage' property/s],
    ['initial-error', 'deliberate initial document throw reaches fixture errors and fails real fixture assertion', new RegExp(initialMarker)],
    ['application-error', 'positive origin guard does not swallow an application document error', new RegExp(applicationMarker)],
  ]) {
    test('DEF-124 independent: ' + title, { timeout: 30000 }, async () => {
      currentRecord = { name: title, mode };
      records.push(currentRecord);
      const backend = fixture.fixtureBackend();
      const cleanups = [];
      let cleanupExecuted = false;
      try {
        const { page, context } = await fixture.setup({ after: callback => cleanups.push(callback) }, { backend });
        currentRecord.document = await page.evaluate(() => ({ url: location.href, origin: location.origin,
          guardStorage: localStorage.getItem('fm_dl_x'), applicationLoaded: typeof App === 'object' }));
        assert.equal(currentRecord.document.guardStorage, '1', 'The non-opaque application document still receives fixture storage');
        if (mode === 'application-error') {
          assert.deepEqual(backend.errors, [], 'Positive guard alone has no fixture errors');
          const received = context.waitForEvent('weberror', { predicate: event => event.error().message.includes(applicationMarker), timeout: 6000 });
          await page.evaluate(() => { setTimeout(() => { throw new Error('DEF124_DELIBERATE_APPLICATION_ERROR'); }, 0); });
          await received;
        }
        currentRecord.fixtureErrors = [...backend.errors];
        assert.equal(backend.errors.length, 1, 'Exactly one deliberate control error reaches the original fixture collection');
        assert.match(backend.errors[0], expected);
        const observed = currentRecord.contexts.flatMap(contextRecord => contextRecord.errors);
        assert.equal(observed.length, 1, 'The earliest independent observer sees the same single control error');
        assert.match(observed[0].stack || observed[0].message, expected);
        assert.equal(observed[0].url === 'about:blank', mode !== 'application-error');
        if (mode !== 'application-error') assert.equal(observed[0].duringNewPage, true);
        assert.equal(cleanups.length, 1);
        cleanupExecuted = true;
        await assert.rejects(cleanups[0](), error => {
          currentRecord.observedFixtureFailure = { ...serializedError(error), code: error.code, actual: error.actual, expected: error.expected };
          assert.equal(error.code, 'ERR_ASSERTION');
          assert.match(error.message, /No uncaught JavaScript errors/);
          assert.deepEqual(error.actual, backend.errors);
          return true;
        });
        assert.deepEqual(backend.unexpected, []);
        assert.deepEqual(backend.consoleErrors, []);
        currentRecord.bodyPassed = true;
      } finally {
        if (!cleanupExecuted) for (const cleanup of cleanups) {
          try { await cleanup(); } catch (error) { currentRecord.cleanupFailure = serializedError(error); }
        }
      }
    });
  }
}

module.exports = { root, sha256, writeJSON, freshEvidence, snapshot, snapshotSummary, loadFixture, observedChromium };
const reviewRequested = process.env.PRODUCT_LIFECYCLE_REVIEW_BROWSER === '1'
  || process.execArgv.some(argument => argument.startsWith('--test-name-pattern=') && argument.includes('DEF-124 independent:'));
if (require.main === module && reviewRequested) runLifecycleAcceptance();