'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHmac, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const backend = 'https://preferences-fixture.supabase.co';
const owner = '12345678-1234-4234-8234-123456789abc';
const otherOwner = '87654321-4321-4321-8321-cba987654321';
const version = 'billing-analytics-v1';
const signingKey = randomBytes(32);
const permission = {
  label: 'Optional fixture measurement',
  description: 'Test-only permission for billing, checkout diagnostics and workout activation.',
  effectiveDate: '2026-01-01', reviewStatus: 'approved',
  scopes: ['billing', 'checkout_started', 'membership_synced', 'activation']
};
const profile = {
  name: 'Preferences tester', email: 'preferences@example.test', username: 'preferences_tester',
  onboarded: true, gender: 'male', dob: '1995-01-01', heightCm: 178,
  startWeightKg: 80, targetWeightKg: 78, activityFactor: 1.55,
  physique: 'lean_aesthetic', physiqueChosen: true, unit: 'kg', diet: 'veg', tier: 'elite'
};
const accountState = { profile, weightLog: [], workoutLog: [], foodLog: [], restDays: [], updatedAt: 1 };
const otherProfile = { ...profile, name: 'Other preferences tester', email: 'preferences.other@example.test', username: 'preferences_other' };
let server, browser, origin;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function holdResponse(state, name) {
  const gate = { ...deferred(), seen: deferred() };
  state.gates.set(name, gate);
  return gate;
}

async function waitAtGate(state, name) {
  const gate = state.gates.get(name);
  if (gate) { gate.seen.resolve(); await gate.promise; }
}

async function observed(gate) {
  let timer;
  try {
    await Promise.race([gate.seen.promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Expected backend request was not observed')), 8000);
    })]);
  } finally { clearTimeout(timer); }
}

function token(uid, email) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    sub: uid, email, role: 'authenticated', aud: 'authenticated', iss: backend + '/auth/v1',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600
  })).toString('base64url');
  const payload = header + '.' + claims;
  return payload + '.' + createHmac('sha256', signingKey).update(payload).digest('base64url');
}

function verifyToken(authorization, users) {
  assert.match(authorization || '', /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const jwt = authorization.slice(7);
  const [header, payload, signature] = jwt.split('.');
  const expected = createHmac('sha256', signingKey).update(header + '.' + payload).digest();
  const supplied = Buffer.from(signature, 'base64url');
  assert.equal(supplied.length, expected.length);
  assert.equal(timingSafeEqual(supplied, expected), true);
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  assert.equal(claims.iss, backend + '/auth/v1');
  assert.equal(claims.role, 'authenticated');
  assert.equal(claims.aud, 'authenticated');
  assert.ok(claims.exp > Date.now() / 1000);
  assert.equal(users.get(jwt)?.id, claims.sub, 'Fixture identity is bound to the signed token');
  return users.get(jwt);
}

function choice(consentState = 'unset') {
  return {
    granted: consentState === 'granted', version, consent_state: consentState,
    choice_version: consentState === 'unset' ? null : version,
    revision: consentState === 'unset' ? null : randomUUID(),
    captured_at: consentState === 'unset' ? null : new Date().toISOString()
  };
}

before(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch (_) { response.writeHead(404).end(); return; }
    if (pathname === '/') pathname = '/index.html';
    const allowed = /^\/(index\.html|legal\.html|version\.txt|manifest\.webmanifest|favicon\.ico)$/.test(pathname)
      || /^\/(js|css|assets|icons)\/[a-zA-Z0-9_/-]+\.(js|css|json|png|jpe?g|webp|gif|svg|ico|woff2|mp4|webm|mp3)$/.test(pathname);
    const file = path.resolve(root, '.' + pathname);
    if (!allowed || !file.startsWith(root + path.sep) || !['GET', 'HEAD'].includes(request.method)
      || !fs.existsSync(file) || !fs.statSync(file).isFile() || fs.realpathSync(file) !== file) {
      response.writeHead(404).end(); return;
    }
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
      '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain' };
    response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: process.env.PREFERENCES_E2E_HEADLESS === '1',
    executablePath: process.env.OFFICE_BROWSER_EXECUTABLE || undefined });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function setup(contextTest, { enabled = false, viewport = { width: 390, height: 844 }, timezoneId, checkoutSDK = false } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce',
    hasTouch: viewport.width < 760, serviceWorkers: 'block', timezoneId });
  const jwt = token(owner, profile.email);
  const otherJwt = token(otherOwner, otherProfile.email);
  const users = new Map([[jwt, { id: owner, email: profile.email }], [otherJwt, { id: otherOwner, email: otherProfile.email }]]);
  const state = {
    users, jwt, uid: owner, consent: new Map([[owner, choice()]]), requests: [], writes: [],
    accountReads: [], accounts: new Map(), external: [], fixtureErrors: [], consoleErrors: [], pageErrors: [],
    configLoads: 0, closing: false, gates: new Map(), consentStatus: 200, expectedHttpErrors: [], scripts: new Set(),
    accountWrites: [], accountStatus: 201, finalizations: [], timeline: [], tier: 'elite', checkoutStatus: 200
  };
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    try {
      if (url.origin === origin) {
        if (request.resourceType() === 'script') state.scripts.add(url.pathname);
        if (url.pathname === '/js/config.js') {
          state.configLoads++;
          const overrides = { SUPABASE_URL: backend, SUPABASE_ANON_KEY: 'fixture-public',
            GOOGLE_CLIENT_ID: '', GOOGLE_IOS_CLIENT_ID: '', POSTHOG_KEY: enabled ? 'fixture-public' : '',
            EMAILJS_PUBLIC_KEY: '', EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAIL_FN_URL: '',
            PEXELS_KEY: '', SHEETS_API: '', SOCIAL_API: '' };
          if (enabled) Object.assign(overrides, { SERVER_MEASUREMENT: true, FORMORA_WEB_PUSH: true,
            MEASUREMENT_PERMISSIONS: { [version]: permission }, FORMORA_PUSH_VAPID_PUBLIC_KEY: '' });
          const append = Object.entries(overrides).map(([key, value]) => `window[${JSON.stringify(key)}]=${JSON.stringify(value)};`).join('\n');
          await route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(root, 'js/config.js'), 'utf8') + '\n' + append });
        } else await route.continue();
        return;
      }
      if (url.origin !== backend) {
        state.external.push({ url: request.url(), type: request.resourceType() });
        await route.abort('blockedbyclient'); return;
      }
      if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
        assert.equal(request.method(), 'POST');
        assert.equal(request.headers().apikey, 'fixture-public');
        const body = request.postDataJSON();
        assert.equal(body.password, 'fixture-password');
        const entry = [...users.entries()].find(([, user]) => user.email === body.email);
        assert.ok(entry, 'Only explicitly seeded fixture users can log in');
        state.requests.push({ path: url.pathname, method: 'POST', owner: entry[1].id });
        await route.fulfill({ json: { access_token: entry[0], refresh_token: 'fixture-refresh',
          expires_in: 3600, token_type: 'bearer', user: entry[1] } });
        return;
      }
      const user = verifyToken(request.headers().authorization, users);
      const body = request.postData() ? request.postDataJSON() : null;
      const record = { path: url.pathname, query: url.search, method: request.method(), owner: user.id, body };
      state.requests.push(record);
      if (request.method() !== 'GET') state.writes.push(record);
      if (url.pathname === '/auth/v1/user' && request.method() === 'GET') {
        await route.fulfill({ json: user });
      } else if (url.pathname === '/auth/v1/logout' && request.method() === 'POST') {
        await route.fulfill({ status: 204 });
      } else if (url.pathname === '/rest/v1/rpc/get_billing_analytics_consent' && request.method() === 'POST') {
        assert.deepEqual(body, {});
        record.response = structuredClone(state.consent.get(user.id) || choice());
        await waitAtGate(state, 'getConsent');
        await route.fulfill({ json: record.response });
      } else if (url.pathname === '/rest/v1/rpc/set_billing_analytics_consent' && request.method() === 'POST') {
        assert.deepEqual(Object.keys(body).sort(), ['p_granted', 'p_version']);
        assert.equal(typeof body.p_granted, 'boolean');
        assert.equal(body.p_version, version);
        const status = state.consentStatus;
        record.response = status === 200 ? choice(body.p_granted ? 'granted' : 'declined') : { error: 'fixture_denied' };
        await waitAtGate(state, 'setConsent');
        if (status === 200) state.consent.set(user.id, record.response);
        else state.expectedHttpErrors.push({ url: request.url(), status });
        await route.fulfill({ status, json: record.response });
      } else if (url.pathname === '/rest/v1/rpc/get_push_subscription_state' && request.method() === 'POST') {
        assert.deepEqual(Object.keys(body), ['p_device_id']);
        assert.match(body.p_device_id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
        await route.fulfill({ json: { owner_id: user.id, revision: 0, registered_devices: 0,
          device_registered: false, binding_id: null, fingerprint: null, expires_at: null,
          registration_enabled: true, delivery_implemented: true, delivery_enabled: false,
          consent_version: 'push-generic-v1', vapid_public_key: '' } });
      } else if (url.pathname === '/rest/v1/entitlements' && request.method() === 'GET') {
        await route.fulfill({ json: [{ tier: state.tier, status: 'active', current_period_end: '2099-01-01T00:00:00Z' }] });
      } else if (url.pathname === '/rest/v1/accounts') {
        if (request.method() === 'GET') {
          assert.equal(url.searchParams.get('uid'), 'eq.' + user.id);
          const records = state.accounts.has(user.id) ? [{ data: structuredClone(state.accounts.get(user.id)) }] : [];
          state.accountReads.push({ owner: user.id, records });
          await route.fulfill({ json: records });
        } else {
          assert.equal(request.method(), 'POST');
          assert.equal(body.uid, user.id);
          const write = { owner: user.id, snapshot: structuredClone(body.data), acknowledged: false, status: state.accountStatus };
          state.accountWrites.push(write);
          state.timeline.push({ kind: 'account-request', write });
          const final = write.snapshot.draftSession == null && write.snapshot.workoutLog.some(entry => entry.finalizationRequestId);
          await waitAtGate(state, final ? 'finalAccount' : 'partialAccount');
          if (write.status >= 200 && write.status < 300) {
            state.accounts.set(user.id, structuredClone(write.snapshot));
            write.acknowledged = true;
            state.timeline.push({ kind: 'account-ack', write });
          } else state.expectedHttpErrors.push({ url: request.url(), status: write.status });
          await route.fulfill({ status: write.status, body: '' });
        }
      } else if (url.pathname === '/rest/v1/rpc/record_workout_finalization' && request.method() === 'POST') {
        assert.deepEqual(Object.keys(body).sort(), ['p_consent_revision', 'p_consent_version', 'p_request_id', 'p_workout_date']);
        assert.match(body.p_request_id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
        assert.equal(state.consent.get(user.id)?.granted, true);
        assert.equal(body.p_consent_version, version);
        assert.equal(body.p_consent_revision, state.consent.get(user.id).revision);
        const acknowledged = state.accountWrites.find(write => write.owner === user.id && write.acknowledged
          && write.snapshot.draftSession == null && !write.snapshot.restDays.includes(body.p_workout_date)
          && write.snapshot.workoutLog.some(entry => entry.date === body.p_workout_date && entry.finalizationRequestId === body.p_request_id));
        assert.ok(acknowledged, 'Finalization must follow a successful account write containing the same date and UUID');
        record.response = { request_id: body.p_request_id, confirmed: true, status: 'recorded', recorded_at: new Date().toISOString() };
        record.accountSnapshot = structuredClone(acknowledged.snapshot);
        state.finalizations.push(record);
        state.timeline.push({ kind: 'finalization', record });
        await waitAtGate(state, 'finalization');
        await route.fulfill({ json: record.response });
      } else if (url.pathname === '/functions/v1/razorpay-create-order' && request.method() === 'POST') {
        assert.deepEqual(Object.keys(body).sort(), ['tier', 'uid', 'upgrade']);
        assert.equal(body.uid, user.id);
        assert.ok(['pro', 'elite'].includes(body.tier));
        assert.equal(typeof body.upgrade, 'boolean');
        const status = state.checkoutStatus;
        record.response = { order_id: 'order_preferences_' + state.requests.length,
          key_id: 'rzp_test_preferences_fixture', amount: 100, currency: 'INR' };
        await waitAtGate(state, 'checkout');
        if (status !== 200) state.expectedHttpErrors.push({ url: request.url(), status });
        await route.fulfill({ status, json: status === 200 ? record.response : { error: 'fixture_order_unavailable' } });
      } else if (url.pathname === '/rest/v1/rpc/get_state' && request.method() === 'POST') {
        await route.fulfill({ json: { users: {}, posts: {}, requests: {}, comments: {}, stories: {} } });
      } else if (['/rest/v1/profiles', '/rest/v1/notifications', '/rest/v1/messages'].includes(url.pathname)) {
        await route.fulfill({ json: [] });
      } else {
        throw new Error(`Unhandled fixture request: ${request.method()} ${url.pathname}`);
      }
    } catch (error) {
      if (state.closing) return;
      state.fixtureErrors.push(error.message);
      await route.abort('failed').catch(() => {});
    }
  });
  await context.addInitScript(({ stored, jwt, uid, secondProfile, mockCheckout }) => {
    if (!localStorage.getItem('preferences-fixture-seeded')) {
      localStorage.setItem('formora_supa_session', JSON.stringify({ uid, email: stored.profile.email,
        access_token: jwt, refresh_token: 'fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600 }));
      localStorage.setItem('gymcoach_auth', JSON.stringify({ accounts: [{ id: 'local-preferences',
        email: stored.profile.email, name: stored.profile.name, provider: 'supabase', emailVerified: true },
      { id: 'local-other-preferences', email: secondProfile.email, name: secondProfile.name,
        provider: 'supabase', emailVerified: true }], currentUserId: 'local-preferences' }));
      localStorage.setItem('gymcoach_v1_local-preferences', JSON.stringify(stored));
      localStorage.setItem('gymcoach_v1_local-other-preferences', JSON.stringify({ ...stored, profile: secondProfile }));
      localStorage.setItem('fm_dl_x', '1');
      localStorage.setItem('fm_tier', 'elite');
      localStorage.setItem('fm_cur', JSON.stringify({ cur: 'INR', rate: 83, t: Date.now() }));
      localStorage.setItem('preferences-fixture-seeded', '1');
    }
    window.fixtureCheckouts = [];
    if (mockCheckout) window.Razorpay = class {
      constructor(options) { this.options = options; }
      open() { window.fixtureCheckouts.push(JSON.parse(JSON.stringify(this.options))); }
    };
    window.preferencePermissionCalls = 0;
    window.preferenceCspViolations = [];
    document.addEventListener('securitypolicyviolation', event => {
      window.preferenceCspViolations.push({ directive: event.effectiveDirective, uri: event.blockedURI });
    });
    if (window.Notification) Object.defineProperty(Notification, 'requestPermission', { configurable: true,
      value: async () => { window.preferencePermissionCalls++; return 'denied'; } });
  }, { stored: accountState, jwt, uid: owner, secondProfile: otherProfile, mockCheckout: checkoutSDK });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => state.pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') state.consoleErrors.push({ text: message.text(), url: message.location().url });
  });
  contextTest.after(async () => {
    const csp = page.isClosed() ? [] : await page.evaluate(() => window.preferenceCspViolations || []).catch(() => []);
    state.closing = true;
    for (const gate of state.gates.values()) gate.resolve();
    await context.close();
    const unexpectedConsole = state.consoleErrors.filter(message =>
      !(message.text.startsWith('Failed to load resource: net::ERR_BLOCKED_BY_CLIENT')
        && state.external.some(request => request.url === message.url))
      && !(message.text.startsWith('Failed to load resource: the server responded with a status of ')
        && state.expectedHttpErrors.some(response => response.url === message.url
          && message.text.includes('status of ' + response.status))));
    assert.deepEqual(state.fixtureErrors, [], 'All backend requests match the local fixture contract');
    assert.deepEqual(state.pageErrors, [], 'No app exceptions');
    assert.deepEqual(csp, [], 'Original CSP remains enforced');
    assert.deepEqual(unexpectedConsole, [], 'No unexpected browser console errors');
  });
  return { page, state };
}

async function enterApp(page) {
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await page.locator('#app-shell:not(.hidden)').waitFor();
  await page.locator('#tabbar [data-tab="profile"]').click();
  await page.locator('#view-profile.active').waitFor();
}

async function openPreferences(page, expected = 'Measurement is off.') {
  await page.getByRole('button', { name: 'Privacy & notifications', exact: true }).click();
  await page.locator('#privacy-options').waitFor();
  await measurementStatus(page, expected);
  await page.waitForFunction(() => document.querySelector('#push-options [role="status"]')?.textContent === 'Push registration is not configured.');
}

async function measurementStatus(page, text) {
  await page.waitForFunction(expected => document.querySelector('#measurement-options [role="status"]')?.textContent === expected, text);
}

async function diagnostics(page) {
  return page.evaluate(() => Track._q.filter(entry => Track._measurementEvent(entry[0])));
}

async function foregroundScreenshot(page, name) {
  await page.bringToFront();
  await page.waitForFunction(() => document.hasFocus() && !document.body.classList.contains('shot-guard'));
  fs.mkdirSync(path.join(root, 'dist/preferences'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'dist/preferences', name + '.png'), fullPage: false, animations: 'disabled' });
}

async function logoutThroughSheet(page) {
  await page.evaluate(() => App.confirmLogout());
  await page.locator('#sheet-wrap').getByRole('button', { name: 'Log out', exact: true }).click();
  await page.locator('#auth-overlay:not(.hidden)').waitFor();
  await page.locator('#a-email').waitFor();
}

async function signInOther(page) {
  await page.locator('#a-email').fill(otherProfile.email);
  await page.locator('#a-pass').fill('fixture-password');
  await page.locator('#auth-card').getByRole('button', { name: 'Log in', exact: true }).click();
  await page.locator('#app-shell:not(.hidden)').waitFor();
  await page.locator('#tabbar [data-tab="profile"]').click();
}

async function openWorkout(page) {
  await page.locator('#tabbar [data-tab="coach"]').click();
  await page.locator('#coach-subnav').getByRole('button', { name: 'Today', exact: true }).click();
  await page.getByRole('button', { name: 'Already trained? Type what you did', exact: true }).click();
  await page.locator('#tl-text').fill('Overhead Barbell Press 1x10 20kg');
  await page.locator('#modal-card button[onclick="App.commitTextLog()"]').click();
  await page.getByRole('button', { name: 'Save & continue later', exact: true }).waitFor();
}

async function finishWorkout(page) {
  const finish = page.locator('#view-today .slidebtn').filter({ hasText: 'Slide to finish workout' });
  await finish.scrollIntoViewIfNeeded();
  await finish.press('Enter');
  await page.locator('#view-today').getByText('Session complete', { exact: false }).waitFor();
}

async function chooseProUPI(page) {
  await page.evaluate(() => App.openPricing());
  await page.locator('#modal-card button[onclick="App.choosePlan(\'pro\',\'upi\')"]').click();
}

async function screenshotAndAudit(page, name) {
  await page.bringToFront();
  await page.waitForFunction(() => document.hasFocus() && !document.body.classList.contains('shot-guard'));
  const panel = page.locator('#modal-card');
  await panel.scrollIntoViewIfNeeded();
  const report = await panel.evaluate(card => {
    const faults = [], bounds = card.getBoundingClientRect();
    if (bounds.left < -1 || bounds.top < -1 || bounds.right > innerWidth + 1 || bounds.bottom > innerHeight + 1) faults.push('Panel outside viewport');
    if (card.scrollWidth > card.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1) faults.push('Horizontal overflow');
    const texts = [], walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode, element = node.parentElement;
      if (!node.textContent.trim() || !element || !element.checkVisibility()) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width < 1 || rect.height < 1) continue;
        if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1) faults.push('Text outside panel: ' + node.textContent.trim());
        texts.push({ text: node.textContent.trim(), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
      }
    }
    for (let first = 0; first < texts.length; first++) {
      for (let second = first + 1; second < texts.length; second++) {
        const left = texts[first], right = texts[second];
        if (Math.min(left.right, right.right) - Math.max(left.left, right.left) > 2
          && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 2) faults.push('Overlapping text: ' + left.text + ' / ' + right.text);
      }
    }
    const title = card.querySelector('h2').getBoundingClientRect();
    const close = card.querySelector('button[aria-label="Close"]').getBoundingClientRect();
    if (title.right > close.left + 1 && title.bottom > close.top + 1) faults.push('Title overlaps Close');
    for (const element of [card, ...card.querySelectorAll('h2,h3,label,p,button')]) {
      if (!element.checkVisibility()) continue;
      if (getComputedStyle(element).filter.includes('blur(')) faults.push('Blurred text');
      if (element.tagName === 'BUTTON' && element.scrollWidth > element.clientWidth + 1) faults.push('Button text does not fit');
    }
    return { faults, textFragments: texts.length };
  });
  await foregroundScreenshot(page, name);
  assert.ok(report.textFragments > 5, 'Visible preference text was measured');
  assert.deepEqual(report.faults, [], 'Responsive preference text fits without overlap or blur');
}

test('preferences asset fixture preserves the startup allowlist and original CSP', async () => {
  for (const pathname of ['/.git/config', '/.env', '/backups/data.json', '/package.json', '/office/board.json',
    '/tests/preferences.e2e.cjs', '/js/%2e%2e/.git/config', '/js/%252e%252e/.env']) {
    assert.equal((await fetch(origin + pathname)).status, 404, pathname);
  }
  assert.equal((await fetch(origin + '/js/config.js', { method: 'POST' })).status, 404);
  assert.equal(await (await fetch(origin + '/index.html')).text(), fs.readFileSync(path.join(root, 'index.html'), 'utf8'));
  assert.equal(await (await fetch(origin + '/js/config.js')).text(), fs.readFileSync(path.join(root, 'js/config.js'), 'utf8'));
});

test('default-off Profile keeps the legacy diagnostics checkbox and does not load server consent', async contextTest => {
  const { page, state } = await setup(contextTest);
  await enterApp(page);
  assert.deepEqual(await page.evaluate(() => [window.SERVER_MEASUREMENT, window.FORMORA_WEB_PUSH]), [false, false]);
  assert.equal(await page.locator('#checkout-diagnostics').isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'Privacy & notifications', exact: true }).count(), 0);
  await page.locator('#checkout-diagnostics').check();
  assert.equal(await page.evaluate(() => Track.measurementConsent()), true);
  await page.locator('#checkout-diagnostics').uncheck();
  assert.equal(await page.evaluate(() => Track.measurementConsent()), false);
  assert.equal(state.requests.filter(request => /billing_analytics_consent/.test(request.path)).length, 0);
  assert.equal(await page.evaluate(() => window.preferencePermissionCalls), 0);
});

test('enabled Profile mounts the real unset consent control without writes or permission prompts', async contextTest => {
  const { page, state } = await setup(contextTest, { enabled: true });
  await enterApp(page);
  await page.getByRole('button', { name: 'Privacy & notifications', exact: true }).click();
  const checkbox = page.locator('#measurement-options input[type="checkbox"]');
  await checkbox.waitFor();
  await page.waitForFunction(() => document.querySelector('#measurement-options input')?.disabled === false);
  assert.equal(await checkbox.isChecked(), false);
  assert.equal(await page.locator('#checkout-diagnostics').count(), 0);
  assert.match(await page.locator('#measurement-options').innerText(), /Optional fixture measurement/);
  assert.equal(await page.getByRole('button', { name: 'Enable notifications', exact: true }).isDisabled(), true);
  assert.equal(await page.evaluate(() => window.preferencePermissionCalls), 0);
  assert.ok(state.requests.some(request => request.path.endsWith('/get_billing_analytics_consent')));
  assert.equal(state.writes.filter(request => request.path.endsWith('/set_billing_analytics_consent')).length, 0);
  assert.deepEqual(state.accountReads[0].records, [], 'Cloud starts with no account history');
  assert.deepEqual(await page.evaluate(() => Store.state.workoutLog), []);
  assert.equal(await page.evaluate(() => Store.state.profile.onboarded), true);
  assert.ok(state.configLoads >= 1);
  for (const source of ['/js/app.js', '/js/cloud.js', '/js/storage.js', '/js/supaauth.js',
    '/js/mod/preferences.js', '/js/mod/measurement.js', '/js/mod/push.js']) assert.ok(state.scripts.has(source), source + ' loaded from the real app');
  assert.deepEqual(state.requests.find(request => request.path.endsWith('/get_billing_analytics_consent')).response,
    { granted: false, version, consent_state: 'unset', choice_version: null, revision: null, captured_at: null });
  contextTest.diagnostic(`Actual runtime timestamp: ${new Date().toISOString()}; isolated signed-token fixture, not hosted authentication.`);
});

for (const [name, viewport] of [['mobile', { width: 375, height: 812 }], ['desktop', { width: 1280, height: 900 }]]) {
  test(`${name}: explicit consent, reload and withdrawal retry use the real settings module`, { timeout: 40000 }, async contextTest => {
    const { page, state } = await setup(contextTest, { enabled: true, viewport });
    await enterApp(page);
    await openPreferences(page);
    const checkbox = page.locator('#measurement-options input[type="checkbox"]');
    assert.equal(await checkbox.isChecked(), false);
    assert.equal(state.writes.filter(request => request.path.endsWith('/set_billing_analytics_consent')).length, 0);
    assert.ok(state.requests.some(request => request.path === '/auth/v1/user' && request.owner === owner));
    assert.equal(await page.evaluate(() => Preferences._measurement.descriptor().version), version);
    assert.equal(await page.evaluate(() => Preferences._measurement.descriptor().choiceVersion), null);
    await page.evaluate(() => {
      App.setCheckoutDiagnostics(true);
      Track.setMeasurementConsent(true);
      Track.event('checkout_started', { tier: 'pro', rail: 'upi' });
    });
    assert.equal(await page.evaluate(() => Track.measurementConsent()), false, 'Legacy local opt-in cannot bypass server consent');
    assert.deepEqual(await diagnostics(page), []);
    await screenshotAndAudit(page, name + '-unset');

    const grant = holdResponse(state, 'setConsent');
    await checkbox.click();
    await observed(grant);
    assert.equal(await checkbox.isDisabled(), true);
    assert.equal(await page.evaluate(() => Track.measurementConsent()), false, 'No opt-in before acknowledgement');
    assert.equal(state.consent.get(owner).granted, false);
    grant.resolve();
    await measurementStatus(page, 'Choice saved: on.');
    assert.equal(await checkbox.isChecked(), true);
    assert.equal(await page.evaluate(() => Track.measurementConsent()), true);
    assert.equal(state.consent.get(owner).granted, true);
    assert.deepEqual(state.writes.find(request => request.path.endsWith('/set_billing_analytics_consent')).body,
      { p_granted: true, p_version: version });
    await screenshotAndAudit(page, name + '-granted');
    await page.locator('#modal-card button[aria-label="Close"]').click();
    assert.equal(await page.locator('#privacy-options').count(), 0);
    assert.equal(await page.locator('#modal').isVisible(), false);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#app-shell:not(.hidden)').waitFor();
    await page.locator('#tabbar [data-tab="profile"]').click();
    await openPreferences(page, 'Choice saved: on.');
    assert.equal(await checkbox.isChecked(), true, 'Server consent survives reload');
    assert.equal(await checkbox.count(), 1, 'No duplicate settings mount');
    assert.equal(state.writes.filter(request => request.path.endsWith('/set_billing_analytics_consent')).length, 1);
    await page.evaluate(() => Track.event('checkout_started', { tier: 'pro', rail: 'upi' }));
    assert.equal((await diagnostics(page)).length, 1, 'The real diagnostics queue is exercised');

    state.consentStatus = 403;
    const denial = holdResponse(state, 'setConsent');
    await checkbox.uncheck();
    await observed(denial);
    assert.equal(await page.evaluate(() => Track.measurementConsent()), false);
    assert.deepEqual(await diagnostics(page), [], 'Withdrawal clears already-queued diagnostics immediately');
    denial.resolve();
    await measurementStatus(page, 'Off here. Server withdrawal is not confirmed.');
    assert.equal(await checkbox.isChecked(), false);
    assert.equal(state.consent.get(owner).granted, true, 'Server denial is not misreported as a saved withdrawal');
    assert.equal(await page.getByRole('button', { name: 'Retry withdrawal', exact: true }).isEnabled(), true);
    await screenshotAndAudit(page, name + '-withdrawal-unconfirmed');
    state.consentStatus = 200;
    state.gates.delete('setConsent');
    await page.getByRole('button', { name: 'Retry withdrawal', exact: true }).click();
    await measurementStatus(page, 'Choice saved: off.');
    assert.equal(state.consent.get(owner).granted, false);
    assert.equal(await page.evaluate(() => Preferences._measurement.descriptor().denialAcknowledgement), 'confirmed');
    assert.equal(await page.getByRole('button', { name: 'Retry withdrawal', exact: true }).count(), 0);
    assert.deepEqual(await diagnostics(page), []);
    assert.equal(await page.evaluate(() => window.preferencePermissionCalls), 0);
    assert.equal(state.requests.filter(request => /\/(register_push_subscription|revoke_push_subscription|revoke_all_push_subscriptions)$/.test(request.path)).length, 0);
    await screenshotAndAudit(page, name + '-withdrawn');
    contextTest.diagnostic(`${name}: 4 foreground screenshots; zero text-fit, overlap, blur or unexpected browser errors.`);
  });
}

test('settings may open and close while startup consent is pending without duplicate or leftover content', async contextTest => {
  const { page, state } = await setup(contextTest, { enabled: true });
  const pending = holdResponse(state, 'getConsent');
  await enterApp(page);
  await observed(pending);
  await page.getByRole('button', { name: 'Privacy & notifications', exact: true }).click();
  await measurementStatus(page, 'Loading choice...');
  assert.equal(await page.locator('#measurement-options input').isDisabled(), true);
  assert.equal(await page.locator('#measurement-options input').count(), 1);
  assert.equal(state.writes.filter(request => request.path.endsWith('/set_billing_analytics_consent')).length, 0);
  await foregroundScreenshot(page, 'startup-pending');
  await page.locator('#modal-card button[aria-label="Close"]').click();
  assert.equal(await page.locator('#privacy-options').count(), 0);
  state.gates.delete('getConsent');
  pending.resolve();
  await page.waitForFunction(() => Preferences._measurement.descriptor().phase === 'ready');
  assert.equal(await page.locator('#modal').isVisible(), false);
  assert.equal(await page.locator('#modal-card').innerHTML(), '');
  await openPreferences(page);
  assert.equal(await page.locator('#measurement-options input').count(), 1);
  assert.deepEqual(await diagnostics(page), []);
});

test('real logout hides privacy immediately while external push cleanup remains unresolved', async contextTest => {
  const { page, state } = await setup(contextTest, { enabled: true });
  state.consent.set(owner, choice('granted'));
  await enterApp(page);
  await openPreferences(page, 'Choice saved: on.');
  await page.evaluate(() => {
    Track.event('checkout_started', { tier: 'pro', rail: 'upi' });
    const realPush = Preferences._push;
    window.fixturePushCleanup = { enteredOwner: null, resolved: false };
    Preferences._push = { ...realPush, beforeAccountChange() {
      window.fixturePushCleanup.enteredOwner = SupaAuth.uid();
      return new Promise(resolve => { window.releaseFixturePushCleanup = () => {
        window.fixturePushCleanup.resolved = true; resolve();
      }; });
    } };
  });
  assert.equal((await diagnostics(page)).length, 1);
  await logoutThroughSheet(page);
  assert.deepEqual(await page.evaluate(() => window.fixturePushCleanup), { enteredOwner: owner, resolved: false });
  assert.deepEqual(await page.evaluate(() => [Auth.isLoggedIn(), SupaAuth.uid(), Cloud.me, Store._syncReady]), [false, '', null, false]);
  assert.equal(await page.locator('#app-shell').isVisible(), false);
  assert.equal(await page.locator('#modal').isVisible(), false);
  assert.equal(await page.locator('#privacy-options').count(), 0);
  assert.equal(await page.locator('#modal-card').innerHTML(), '');
  assert.deepEqual(await diagnostics(page), []);
  await foregroundScreenshot(page, 'logout-cleanup-pending');
  await page.evaluate(() => window.releaseFixturePushCleanup());
  assert.equal(await page.locator('#privacy-options').count(), 0);
  assert.equal(await page.evaluate(() => Track.measurementConsent()), false);
});

test('a late consent acknowledgement cannot restore the old owner after logout and real login', async contextTest => {
  const { page, state } = await setup(contextTest, { enabled: true });
  await enterApp(page);
  await openPreferences(page);
  const oldGeneration = await page.evaluate(() => Preferences.generation);
  const pending = holdResponse(state, 'setConsent');
  await page.locator('#measurement-options input').click();
  await observed(pending);
  await logoutThroughSheet(page);
  assert.equal(await page.locator('#privacy-options').count(), 0);
  assert.deepEqual(await diagnostics(page), []);
  await signInOther(page);
  await openPreferences(page);
  state.gates.delete('setConsent');
  pending.resolve();
  await page.waitForFunction(() => Preferences._measurement.descriptor().phase === 'ready');
  assert.equal(await page.evaluate(() => SupaAuth.uid()), otherOwner);
  assert.ok(await page.evaluate(previous => Preferences.generation > previous, oldGeneration));
  assert.equal(await page.locator('#measurement-options input').isChecked(), false);
  assert.equal(await page.evaluate(() => Track.measurementConsent()), false);
  assert.deepEqual(await diagnostics(page), []);
  assert.equal(await page.locator('#measurement-options input').count(), 1);
  assert.equal(state.writes.filter(request => request.path.endsWith('/set_billing_analytics_consent') && request.owner === otherOwner).length, 0);
  assert.deepEqual(state.accountReads.find(request => request.owner === otherOwner).records, []);
  assert.deepEqual(await page.evaluate(() => Store.state.workoutLog), []);
  assert.equal(await page.evaluate(() => Store.state.profile.email), otherProfile.email);
  await screenshotAndAudit(page, 'other-owner-unset');
});

test('privacy controls have visible icon geometry, including the icon-only Close button', async contextTest => {
  const { page } = await setup(contextTest, { enabled: true });
  await enterApp(page);
  const blank = await page.getByRole('button', { name: 'Privacy & notifications', exact: true }).evaluate(button =>
    button.querySelector('svg')?.childElementCount ? [] : ['Profile privacy settings icon']);
  await openPreferences(page);
  blank.push(...await page.locator('#modal-card button').evaluateAll(buttons => buttons
    .filter(button => button.querySelector('svg') && !button.querySelector('svg').childElementCount)
    .map(button => button.getAttribute('aria-label') || button.textContent.trim())));
  await foregroundScreenshot(page, 'privacy-icon-regression');
  assert.deepEqual(blank, [], 'Each requested App.ic name must exist; icon-only Close must not be blank');
});

for (const [name, viewport] of [['mobile', { width: 375, height: 812 }], ['desktop', { width: 1280, height: 900 }]]) {
  test(`${name} UTC: real Save & continue and Finish wait for the matching account snapshot acknowledgement`, { timeout: 40000 }, async contextTest => {
    const { page, state } = await setup(contextTest, { enabled: true, viewport, timezoneId: 'UTC' });
    await enterApp(page);
    await openPreferences(page);
    await page.locator('#measurement-options input').click();
    await measurementStatus(page, 'Choice saved: on.');
    await page.locator('#modal-card button[aria-label="Close"]').click();
    assert.deepEqual(state.accountReads[0].records, []);
    assert.deepEqual(await page.evaluate(() => Store.state.workoutLog), []);
    await openWorkout(page);
    const partial = holdResponse(state, 'partialAccount');
    await page.getByRole('button', { name: 'Save & continue later', exact: true }).click();
    await observed(partial);
    const progress = state.accountWrites.at(-1).snapshot;
    assert.equal(progress.workoutLog.length, 1);
    assert.ok(progress.draftSession);
    assert.equal(Object.hasOwn(progress.workoutLog[0], 'finalizationRequestId'), false);
    assert.deepEqual(progress.workoutLog[0].exercises[0].sets, [{ reps: 10, weight: 20 }]);
    assert.equal(state.finalizations.length, 0, 'Save & continue is not a finalization');
    state.gates.delete('partialAccount');
    partial.resolve();
    await foregroundScreenshot(page, name + '-workout-saved-draft');

    const account = holdResponse(state, 'finalAccount');
    const receipt = holdResponse(state, 'finalization');
    await finishWorkout(page);
    const finished = await page.evaluate(() => ({ today: todayISO(), logs: Store.state.workoutLog, draft: Store.state.draftSession }));
    assert.equal(finished.logs.length, 1, 'Finish replaces the partial entry, not a duplicate workout');
    assert.equal(finished.draft, null);
    assert.match(finished.logs[0].finalizationRequestId || '', /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(finished.logs[0].date, finished.today);
    await observed(account);
    const submitted = state.accountWrites.at(-1);
    assert.equal(submitted.acknowledged, false);
    assert.equal(submitted.snapshot.draftSession, null);
    assert.deepEqual(submitted.snapshot.workoutLog, finished.logs);
    assert.equal(state.finalizations.length, 0, 'No RPC is sent while the real account write is pending');
    state.gates.delete('finalAccount');
    account.resolve();
    await observed(receipt);
    assert.equal(state.finalizations.length, 1);
    const recorded = state.finalizations[0];
    assert.deepEqual(recorded.body, { p_request_id: finished.logs[0].finalizationRequestId,
      p_workout_date: finished.today, p_consent_version: version, p_consent_revision: state.consent.get(owner).revision });
    assert.deepEqual(recorded.accountSnapshot, submitted.snapshot);
    assert.ok(state.timeline.indexOf(state.timeline.find(event => event.kind === 'account-ack' && event.write === submitted))
      < state.timeline.indexOf(state.timeline.find(event => event.kind === 'finalization')));
    assert.deepEqual(Object.keys(recorded.response).sort(), ['confirmed', 'recorded_at', 'request_id', 'status']);
    state.gates.delete('finalization');
    receipt.resolve();
    await page.waitForFunction(uid => JSON.parse(localStorage.getItem('fm_activation_pending_' + uid))?.requests?.[0]?.terminal === true, owner);
    const pending = await page.evaluate(uid => JSON.parse(localStorage.getItem('fm_activation_pending_' + uid)), owner);
    assert.deepEqual(Object.keys(pending).sort(), ['format', 'requests', 'revision', 'version']);
    assert.deepEqual(pending.requests, [{ requestId: recorded.response.request_id, attempts: 1, terminal: true }]);
    assert.deepEqual(await diagnostics(page), [], 'Finalization is not an SDK diagnostic event');
    await page.locator('#view-today .focus-banner').scrollIntoViewIfNeeded();
    await foregroundScreenshot(page, name + '-workout-finalized');
    contextTest.diagnostic(`Mock server receipt ${recorded.response.status} at ${recorded.response.recorded_at}; no hosted cohort/registration SQL claim.`);
  });
}

test('device-default local workout date receives a finalization UUID without changing the clock', async contextTest => {
  const { page, state } = await setup(contextTest, { enabled: true });
  state.consent.set(owner, choice('granted'));
  await enterApp(page);
  await openPreferences(page, 'Choice saved: on.');
  await page.locator('#modal-card button[aria-label="Close"]').click();
  await openWorkout(page);
  await finishWorkout(page);
  const value = await page.evaluate(() => ({ localDay: todayISO(), utcNow: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, entry: Store.state.workoutLog[0] }));
  contextTest.diagnostic(`Actual device-default date: ${value.localDay}, UTC: ${value.utcNow}, timezone: ${value.timezone}.`);
  await page.locator('#view-today .focus-banner').scrollIntoViewIfNeeded();
  await foregroundScreenshot(page, 'device-date-finalization');
  assert.match(value.entry.finalizationRequestId || '', /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    'A just-finished local-calendar workout must not lose activation because the UTC day differs');
});

test('actual UPI checkout delegates diagnostics only after server consent and a usable order', { timeout: 30000 }, async contextTest => {
  const { page, state } = await setup(contextTest, { enabled: true, checkoutSDK: true });
  state.tier = 'free';
  await enterApp(page);
  await openPreferences(page);
  await page.locator('#modal-card button[aria-label="Close"]').click();
  const withoutConsent = holdResponse(state, 'checkout');
  await chooseProUPI(page);
  await observed(withoutConsent);
  assert.equal(await page.evaluate(() => window.fixtureCheckouts.length), 0);
  assert.deepEqual(await diagnostics(page), []);
  state.gates.delete('checkout');
  withoutConsent.resolve();
  await page.waitForFunction(() => !App._checkoutBusy && window.fixtureCheckouts.length === 1);
  assert.deepEqual(await diagnostics(page), [], 'Checkout works without forcing measurement consent');

  await openPreferences(page);
  await page.locator('#measurement-options input').click();
  await measurementStatus(page, 'Choice saved: on.');
  await page.locator('#modal-card button[aria-label="Close"]').click();
  const consented = holdResponse(state, 'checkout');
  await chooseProUPI(page);
  await observed(consented);
  assert.equal(await page.evaluate(() => window.fixtureCheckouts.length), 1);
  assert.deepEqual(await diagnostics(page), [], 'No checkout diagnostic before the order acknowledgement');
  state.gates.delete('checkout');
  consented.resolve();
  await page.waitForFunction(() => !App._checkoutBusy && window.fixtureCheckouts.length === 2);
  assert.deepEqual(await diagnostics(page), [['checkout_started', { tier: 'pro', rail: 'upi' }, owner]]);
  const order = state.requests.filter(request => request.path.endsWith('/razorpay-create-order')).at(-1);
  const sdk = await page.evaluate(() => window.fixtureCheckouts.at(-1));
  assert.equal(sdk.order_id, order.response.order_id);
  assert.equal(sdk.key, order.response.key_id);
  assert.equal(sdk.amount, 100);
  assert.equal(sdk.prefill.email, profile.email);
  assert.equal(sdk.currency, 'INR');
  assert.equal(state.external.some(request => request.url.startsWith('https://checkout.razorpay.com')), false);

  state.checkoutStatus = 503;
  await chooseProUPI(page);
  await page.waitForFunction(() => !App._checkoutBusy && document.getElementById('toast').textContent === 'Checkout is unavailable. Please try again.');
  assert.equal(await page.evaluate(() => window.fixtureCheckouts.length), 2);
  assert.deepEqual(await diagnostics(page), [['checkout_started', { tier: 'pro', rail: 'upi' }, owner]]);
  await foregroundScreenshot(page, 'checkout-order-denied');
  contextTest.diagnostic('Only the external Razorpay SDK is stubbed; no payment, webhook, entitlement grant or hosted checkout was executed.');
});

test('a checkout order arriving after account replacement cannot emit diagnostics or open the provider', async contextTest => {
  const { page, state } = await setup(contextTest, { enabled: true, checkoutSDK: true });
  state.tier = 'free';
  state.consent.set(owner, choice('granted'));
  await enterApp(page);
  await openPreferences(page, 'Choice saved: on.');
  await page.locator('#modal-card button[aria-label="Close"]').click();
  const pending = holdResponse(state, 'checkout');
  await chooseProUPI(page);
  await observed(pending);
  await logoutThroughSheet(page);
  await signInOther(page);
  await openPreferences(page);
  state.gates.delete('checkout');
  pending.resolve();
  await page.waitForFunction(() => App._checkoutBusy === false);
  assert.equal(await page.evaluate(() => SupaAuth.uid()), otherOwner);
  assert.equal(await page.evaluate(() => window.fixtureCheckouts.length), 0);
  assert.equal(await page.locator('#measurement-options input').isChecked(), false);
  assert.deepEqual(await diagnostics(page), []);
});

test('a failed real account write cannot flush finalization; a later acknowledged profile save can', { timeout: 30000 }, async contextTest => {
  const { page, state } = await setup(contextTest, { enabled: true, timezoneId: 'UTC' });
  state.consent.set(owner, choice('granted'));
  await enterApp(page);
  await openPreferences(page, 'Choice saved: on.');
  await page.locator('#modal-card button[aria-label="Close"]').click();
  await openWorkout(page);
  state.accountStatus = 503;
  const failed = holdResponse(state, 'finalAccount');
  await finishWorkout(page);
  await observed(failed);
  const rejected = state.accountWrites.at(-1);
  assert.equal(rejected.acknowledged, false);
  const response = page.waitForResponse(response => response.url() === backend + '/rest/v1/accounts' && response.status() === 503);
  state.gates.delete('finalAccount');
  failed.resolve();
  assert.equal((await response).status(), 503);
  assert.equal(state.finalizations.length, 0);
  assert.equal(await page.evaluate(uid => JSON.parse(localStorage.getItem('fm_activation_pending_' + uid)).requests[0].attempts, owner), 0);

  state.accountStatus = 201;
  const receipt = holdResponse(state, 'finalization');
  await page.locator('#tabbar [data-tab="profile"]').click();
  await page.locator('#view-profile button[onclick="App.saveProfile()"]').click();
  await observed(receipt);
  assert.equal(rejected.acknowledged, false);
  assert.equal(state.finalizations.length, 1);
  assert.equal(state.finalizations[0].body.p_request_id, rejected.snapshot.workoutLog[0].finalizationRequestId);
  assert.equal(state.accountWrites.filter(write => write.acknowledged && write.snapshot.workoutLog.some(entry => entry.finalizationRequestId)).length, 1);
  state.gates.delete('finalization');
  receipt.resolve();
  await page.waitForFunction(uid => JSON.parse(localStorage.getItem('fm_activation_pending_' + uid)).requests[0].terminal === true, owner);
  assert.deepEqual(await diagnostics(page), []);
});