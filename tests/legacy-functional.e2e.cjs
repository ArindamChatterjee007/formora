'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const root = fs.realpathSync(path.resolve(__dirname, '..'));
const harnessPath = path.join(__dirname, 'formora_tests.js');
const mimeTypes = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.webmanifest': 'application/manifest+json',
};
const configOverride = `
Object.assign(window, {
  SUPABASE_URL: '', SUPABASE_ANON_KEY: '', USE_SUPABASE_AUTH: false,
  GOOGLE_CLIENT_ID: '', GOOGLE_IOS_CLIENT_ID: '', POSTHOG_KEY: '',
  EMAILJS_PUBLIC_KEY: '', EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '',
  EMAIL_FN_URL: '', SHEETS_API: '', SOCIAL_API: '', PEXELS_KEY: ''
});
`;

function allowedFile(pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (relative.split('/').some(segment => !segment || segment.startsWith('.')) || relative.includes('\\')) return null;
  const extension = path.extname(relative);
  const allowed = ['index.html', 'legal.html', 'manifest.webmanifest'].includes(relative)
    || (/^js\//.test(relative) && extension === '.js')
    || (/^css\//.test(relative) && extension === '.css')
    || (/^(assets|icons)\//.test(relative) && ['.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif', '.woff', '.woff2', '.mp4', '.webm', '.mp3'].includes(extension));
  if (!allowed) return null;
  const filename = path.resolve(root, relative);
  try {
    return filename.startsWith(root + path.sep) && fs.realpathSync(filename) === filename && fs.statSync(filename).isFile() ? filename : null;
  } catch { return null; }
}

async function fixture(testContext) {
  const requests = { blockedExternal: 0, unexpectedLocal: [], externalResponses: [] };
  let browser, context;
  const server = http.createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
    catch { response.writeHead(400).end(); return; }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
    if (pathname === '/version.txt') { response.writeHead(200, { 'Content-Type': 'text/plain' }).end('0'); return; }
    const filename = allowedFile(pathname);
    if (!filename) { response.writeHead(404).end(); return; }
    let body = fs.readFileSync(filename);
    if (filename === path.join(root, 'js', 'config.js')) body = Buffer.from(body.toString() + configOverride);
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filename)],
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  testContext.after(async () => {
    try { if (context) await context.close(); }
    finally {
      try { if (browser) await browser.close(); }
      finally {
        server.closeAllConnections();
        if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, timeout: 15000, executablePath: process.env.OFFICE_BROWSER_EXECUTABLE || undefined });
  context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 1280, height: 900 } });
  context.on('response', response => { if (new URL(response.url()).origin !== origin) requests.externalResponses.push(response.url()); });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { requests.blockedExternal++; await route.abort('blockedbyclient'); return; }
    if (!['GET', 'HEAD'].includes(request.method()) || (url.pathname !== '/version.txt' && !allowedFile(decodeURIComponent(url.pathname)))) {
      requests.unexpectedLocal.push(`${request.method()} ${url.pathname}`);
      await route.abort('blockedbyclient'); return;
    }
    await route.continue();
  });
  await context.routeWebSocket('**/*', socket => { requests.blockedExternal++; socket.close(); });
  await context.addInitScript(() => {
    Object.defineProperty(window, '__FORMORA_TEST_ISOLATED__', { value: true });
    const RealDate = Date, fixedTime = RealDate.parse('2026-09-05T12:00:00Z');
    const fixedNow = () => fixedTime;
    window.Date = new Proxy(RealDate, {
      construct: (target, args, constructor) => Reflect.construct(target, args.length ? args : [fixedTime], constructor),
      apply: () => new RealDate(fixedTime).toString(),
      get: (target, property, receiver) => property === 'now' ? fixedNow : Reflect.get(target, property, receiver),
    });
    const pending = { timeouts: new Map(), intervals: new Set(), frames: new Set() };
    const scheduleTimeout = window.setTimeout, cancelTimeout = window.clearTimeout;
    const scheduleInterval = window.setInterval, cancelInterval = window.clearInterval;
    const scheduleFrame = window.requestAnimationFrame, cancelFrame = window.cancelAnimationFrame;
    window.setTimeout = (callback, delay, ...args) => {
      const timer = scheduleTimeout(() => { pending.timeouts.delete(timer); callback(...args); }, delay);
      pending.timeouts.set(timer, { delay, stack: new Error().stack }); return timer;
    };
    window.clearTimeout = timer => { pending.timeouts.delete(timer); cancelTimeout(timer); };
    window.setInterval = (callback, delay, ...args) => {
      const timer = scheduleInterval(callback, delay, ...args); pending.intervals.add(timer); return timer;
    };
    window.clearInterval = timer => { pending.intervals.delete(timer); cancelInterval(timer); };
    window.requestAnimationFrame = callback => {
      const frame = scheduleFrame(time => { pending.frames.delete(frame); callback(time); }); pending.frames.add(frame); return frame;
    };
    window.cancelAnimationFrame = frame => { pending.frames.delete(frame); cancelFrame(frame); };
    window.__legacyPendingWork = () => Object.fromEntries(Object.entries(pending).map(([kind, handles]) => [kind, [...handles.keys()]]));
    window.__legacyTimeoutInfo = timer => pending.timeouts.get(timer);
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, options = {}) => nativeFetch(input, {
      ...options,
      signal: AbortSignal.any([AbortSignal.timeout(4000), options.signal || (input instanceof Request && input.signal)].filter(Boolean)),
    });
    localStorage.setItem('fm_dl_x', '1');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:') && !message.text().includes('Content Security Policy')) errors.push(message.text());
  });
  page.on('dialog', dialog => dialog.dismiss());
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof App !== 'undefined' && typeof Social !== 'undefined');
  await bounded(page.evaluate(async () => { await CameraLoader.ensure(); await ChartsLoader.ensure(); }), 'Load lazy modules');
  await page.addScriptTag({ path: harnessPath });
  return { page, context, origin, requests, errors };
}

async function seedAndWatch(page) {
  await page.evaluate(() => {
    Auth.data = { accounts: [{ id: 'legacy-baseline', email: 'baseline@example.test', name: 'Baseline', provider: 'email', emailVerified: true }], currentUserId: 'legacy-baseline' };
    Auth.save();
    Store.load('gymcoach_v1_legacy-baseline');
    Store.state.profile.name = 'Baseline';
    Store.save();
    Social.load('legacy-baseline');
    Cloud.me = 'baseline_uid';
    App.session = { split: 'push', items: [], fixture: 'restore me' };
    App.onboardMode = 'baseline';
    App.pexelsCache = { baseline: { url: 'fixture' } };
    for (const [key, value] of Object.entries({
      gymcoach_restore_probe: 'original gymcoach value',
      formora_restore_probe: 'original formora value',
      fm_restore_probe: 'original fm value',
      fm_hidden_cloud_u_me: '["P1"]',
      fm_muted_cloud_u_me: '["baseline-muted"]',
      unrelated_fixture: 'must survive too',
    })) localStorage.setItem(key, value);
    sessionStorage.setItem('fm_restore_probe', 'original session value');

    const storageSnapshot = storage => Object.fromEntries(Object.keys(storage).sort().map(key => [key, storage.getItem(key)]));
    const localBefore = storageSnapshot(localStorage), sessionBefore = storageSnapshot(sessionStorage);
    const workBefore = window.__legacyPendingWork();
    const bodyBefore = [...document.body.childNodes];
    const attributesBefore = [document.documentElement, document.body].map(element => [...element.attributes].map(attribute => [attribute.name, attribute.value]));
    const records = new Map();
    const watch = (target, label, deep = true) => {
      if (!target || typeof target !== 'object' || records.has(target)) return;
      const prototype = Object.getPrototypeOf(target);
      if (deep && ![Object.prototype, Array.prototype, Map.prototype, Set.prototype, null].includes(prototype)) return;
      const descriptors = Object.getOwnPropertyDescriptors(target);
      const entries = target instanceof Map ? [...target.entries()] : target instanceof Set ? [...target] : null;
      records.set(target, { label, descriptors, entries });
      if (!deep) return;
      for (const [key, descriptor] of Object.entries(descriptors)) watch(descriptor.value, `${label}.${key}`);
      if (entries) entries.forEach((entry, index) => target instanceof Map ? entry.forEach((value, field) => watch(value, `${label}[${index}][${field}]`)) : watch(entry, `${label}[${index}]`));
    };
    window.__legacyRestorationChanges = () => {
      const changes = [];
      if (JSON.stringify(storageSnapshot(localStorage)) !== JSON.stringify(localBefore)) changes.push('localStorage (all keys)');
      if (JSON.stringify(storageSnapshot(sessionStorage)) !== JSON.stringify(sessionBefore)) changes.push('sessionStorage (all keys)');
      const workAfter = window.__legacyPendingWork();
      for (const kind of Object.keys(workBefore)) {
        const added = workAfter[kind].filter(handle => !workBefore[kind].includes(handle));
        if (added.length) changes.push(`pending ${kind}: ${JSON.stringify(kind === 'timeouts' ? added.map(window.__legacyTimeoutInfo) : added)}`);
      }
      if (document.body.childNodes.length !== bodyBefore.length || bodyBefore.some((node, index) => document.body.childNodes[index] !== node)) changes.push('original DOM nodes');
      const attributesAfter = [document.documentElement, document.body].map(element => [...element.attributes].map(attribute => [attribute.name, attribute.value]));
      if (JSON.stringify(attributesAfter) !== JSON.stringify(attributesBefore)) changes.push('document/body attributes');
      for (const [target, { label, descriptors, entries }] of records) {
        const current = Object.getOwnPropertyDescriptors(target);
        for (const key of new Set([...Reflect.ownKeys(descriptors), ...Reflect.ownKeys(current)])) {
          const before = descriptors[key], after = current[key];
          if (!before || !after || Reflect.ownKeys(before).some(field => !Object.is(before[field], after[field]))) changes.push(`${label}.${String(key)}`);
        }
        if (entries) {
          const after = target instanceof Map ? [...target.entries()] : [...target];
          if (after.length !== entries.length || after.some((entry, index) => target instanceof Map ? entry.some((value, field) => !Object.is(value, entries[index][field])) : !Object.is(entry, entries[index]))) changes.push(`${label} entries`);
        }
      }
      return changes;
    };
    watch(window, 'window', false);
    watch(Storage.prototype, 'Storage.prototype', false);
    watch(EventTarget.prototype, 'EventTarget.prototype', false);
    for (const [label, target] of Object.entries({ App, Auth, Store, Social, Cloud, SupaAuth, Entitlements, Exercises, Camera, Engine, FoodEstimator, MealPlanner, Currency: window.Currency, Track: window.Track, CameraLoader, ChartsLoader })) watch(target, label);
  });
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded 15000ms`)), 15000); })]);
  } finally { clearTimeout(timer); }
}

function checkResult(result) {
  assert.deepEqual(Object.keys(result).sort(), ['all', 'failed', 'failures', 'passed', 'total']);
  assert.ok(Number.isInteger(result.total) && result.total > 0);
  assert.ok(Number.isInteger(result.passed) && Number.isInteger(result.failed));
  assert.equal(result.total, result.passed + result.failed);
  assert.equal(result.all.length, result.total);
  assert.equal(result.failures.length, result.failed);
  assert.ok(result.all.every(entry => typeof entry === 'string'));
  assert.ok(result.failures.every(entry => typeof entry === 'string'));
  assert.equal(result.all.filter(entry => entry.startsWith('\u2713 ')).length, result.passed);
  assert.equal(result.all.filter(entry => entry.startsWith('\u2717 ')).length, result.failed);
}

test('legacy functional assertions are repeatable and restore every modified state and storage key', { timeout: 90000 }, async testContext => {
  const { page, context, origin, requests, errors } = await fixture(testContext);
  for (const denied of ['/backups/test.json', '/.git/config', '/.env', '/office/board.json', '/package.json', '/tests/formora_tests.js', '/js/../backups/test.js', '/assets/%2e%2e/.env']) {
    const response = await fetch(origin + denied, { signal: AbortSignal.timeout(4000) });
    assert.equal(response.status, 404, `Asset server denies ${denied}`);
  }
  assert.equal((await fetch(origin + '/', { method: 'POST', signal: AbortSignal.timeout(4000) })).status, 405);
  await seedAndWatch(page);
  const problems = [];
  const results = [];
  for (let run = 1; run <= 2; run++) {
    const result = await bounded(page.evaluate(() => window.runFormoraTests()), `Legacy run ${run}`);
    checkResult(result);
    results.push(result);
    testContext.diagnostic(`Legacy run ${run}: ${result.passed}/${result.total} passed; ${result.failed} failed`);
    assert.ok(result.total >= 284, 'At least all 284 original assertions remain reachable: ' + result.failures.join('\n'));
    assert.match(result.all.at(-1), /finished workout is saved once$/, 'The final original assertion is reached');
    problems.push(...result.failures.map(failure => `Run ${run}: ${failure}`));
    problems.push(...(await page.evaluate(() => window.__legacyRestorationChanges())).map(change => `Run ${run} leaked ${change}`));
  }
  assert.deepEqual(results[0], results[1], 'Both runs reach identical assertions and outcomes');
  assert.deepEqual(requests.unexpectedLocal, [], 'No unhandled local API requests');
  assert.deepEqual(requests.externalResponses, [], 'No external network responses');
  assert.deepEqual(errors, [], 'No unhandled JavaScript exceptions');
  testContext.diagnostic(`External requests blocked: ${requests.blockedExternal}; live writes: 0 (all external traffic intercepted)`);
  await context.close();
  assert.deepEqual(problems, []);
});

test('a forced asynchronous failure is reported and restores globals, all storage, DOM, and scheduled work', { timeout: 30000 }, async testContext => {
  const { page, requests, errors } = await fixture(testContext);
  await seedAndWatch(page);
  const result = await bounded(page.evaluate(async () => {
    const originalHash = Auth.hash;
    Auth.hash = async () => {
      localStorage.setItem('fm_restore_probe', 'changed');
      localStorage.setItem('fm_added_by_failure', 'remove me');
      localStorage.removeItem('unrelated_fixture');
      sessionStorage.setItem('fm_added_by_failure', 'remove me');
      window.fetch = async () => { throw new Error('temporary fetch'); };
      window.confirm = () => true;
      window.__temporaryHarnessGlobal = true;
      Storage.prototype.setItem = () => { throw new Error('temporary storage failure'); };
      App.session = { fixture: 'changed during failure' };
      const lateMutation = () => { localStorage.setItem('fm_late_failure', 'leaked'); };
      setTimeout(lateMutation, 1000);
      setInterval(lateMutation, 1000);
      requestAnimationFrame(lateMutation);
      window.addEventListener('legacy-after-restore', lateMutation);
      throw new Error('injected asynchronous failure');
    };
    try { return await window.runFormoraTests(); }
    finally { Auth.hash = originalHash; }
  }), 'Failure restoration probe');
  checkResult(result);
  assert.equal(result.failed, 1);
  assert.match(result.failures[0], /EXCEPTION.*injected asynchronous failure/);
  await page.evaluate(() => window.dispatchEvent(new Event('legacy-after-restore')));
  assert.deepEqual(await page.evaluate(() => window.__legacyRestorationChanges()), []);
  assert.deepEqual(requests.unexpectedLocal, []);
  assert.deepEqual(requests.externalResponses, []);
  assert.deepEqual(errors, []);
});

test('an expected rejection cannot turn a timed-out operation into a passing harness result', { timeout: 30000 }, async testContext => {
  const { page, requests, errors } = await fixture(testContext);
  await seedAndWatch(page);
  const result = await bounded(page.evaluate(async () => {
    const originalLogin = Auth.login;
    Auth.login = function (credentials) {
      return credentials.password === 'wrong' ? new Promise(() => {}) : originalLogin.call(this, credentials);
    };
    try { return await window.runFormoraTests(); }
    finally { Auth.login = originalLogin; }
  }), 'Hung rejection probe');
  checkResult(result);
  assert.equal(result.failed, 1, result.failures.join('\n'));
  assert.match(result.failures[0], /Harness deadline exceeded.*6000ms/);
  assert.match(result.all.at(-1), /finished workout is saved once$/);
  assert.deepEqual(await page.evaluate(() => window.__legacyRestorationChanges()), []);
  assert.deepEqual(requests.unexpectedLocal, []);
  assert.deepEqual(requests.externalResponses, []);
  assert.deepEqual(errors, []);
});

test('service configuration is inert before boot and attempted external writes cannot leave the context', { timeout: 30000 }, async testContext => {
  const { page, requests, errors } = await fixture(testContext);
  assert.deepEqual(await page.evaluate(() => ({
    supabase: SUPABASE_URL, key: SUPABASE_ANON_KEY, google: GOOGLE_CLIENT_ID,
    analytics: POSTHOG_KEY, email: EMAILJS_PUBLIC_KEY, cloudActive: Cloud.active(), authActive: SupaAuth.active(),
  })), { supabase: '', key: '', google: '', analytics: '', email: '', cloudActive: false, authActive: false });
  const outcomes = await bounded(page.evaluate(async () => {
    const endpoints = [
      'https://fixture.supabase.co/rest/v1/posts',
      'https://api.razorpay.com/v1/orders',
      'https://api.emailjs.com/api/v1.0/email/send',
      'https://us.i.posthog.com/capture/',
    ];
    return Promise.all(endpoints.map(async url => {
      try { await fetch(url, { method: 'POST', body: '{}' }); return 'escaped'; }
      catch { return 'blocked'; }
    }));
  }), 'External request probes');
  assert.deepEqual(outcomes, ['blocked', 'blocked', 'blocked', 'blocked']);
  assert.ok(requests.blockedExternal >= 4, 'Service requests reached interception, not live endpoints');
  assert.deepEqual(requests.externalResponses, []);
  assert.deepEqual(requests.unexpectedLocal, []);
  assert.deepEqual(errors, []);
});