'use strict';
/* DEF-039 gate: the shared #modal must expose real dialog semantics, take and trap
   focus, close on Escape, return focus to whatever opened it and make the background
   inert — without breaking the action sheets, and without stealing focus from a field
   while the card re-renders. Runs the real app from a local fixture server with all
   external traffic blocked. Set FORMORA_QA_BROWSER to chromium | firefox | webkit. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const browserName = process.env.FORMORA_QA_BROWSER || 'chromium';
const browserType = require('playwright')[browserName];
const root = path.resolve(__dirname, '..');
const reportDirectory = path.resolve(root, process.env.FORMORA_MODAL_A11Y_OUTPUT || 'dist/modal-a11y-2026-09-06/' + browserName);
const TIMEOUT = 20000;

const member = { uid: 'a11y-a-0000-4000-8000-000000000001', email: 'modal.primary@example.test', name: 'Modal Primary' };
const findings = {
  observedAt: null, browser: browserName,
  scope: 'Local rendered dialog keyboard/semantics fixture with external traffic blocked. Not a physical screen-reader or assistive-technology acceptance.',
  cases: [],
};

let server, browser, origin;

const mimeTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain' };

function publicAsset(rawPathname) {
  let pathname;
  try { pathname = decodeURIComponent(rawPathname); } catch { return null; }
  if (pathname === '/') pathname = '/index.html';
  if (pathname.includes('\\') || pathname.includes('\0')) return null;
  if (pathname.split('/').some(segment => segment.startsWith('.'))) return null;
  const allowed = /^\/(index\.html|legal\.html|manifest\.webmanifest|version\.txt|favicon\.ico|robots\.txt)$/.test(pathname)
    || /^\/js\/[A-Za-z0-9_/-]+\.js$/.test(pathname)
    || /^\/css\/[A-Za-z0-9_/-]+\.css$/.test(pathname)
    || /^\/(assets|icons)\/[A-Za-z0-9_/-]+\.(json|png|jpe?g|webp|svg|ico)$/.test(pathname);
  if (!allowed) return null;
  const resolved = path.resolve(root, '.' + pathname);
  if (!resolved.startsWith(root + path.sep)) return null;
  try {
    if (!fs.statSync(resolved).isFile()) return null;
    if (fs.realpathSync(resolved) !== resolved) return null;
  } catch { return null; }
  return resolved;
}

function accountState() {
  const iso = days => { const d = new Date(); d.setDate(d.getDate() - days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  return {
    profile: {
      name: 'Modal Primary', email: member.email, username: 'modal_primary', onboarded: true,
      gender: 'male', dob: '1995-03-28', heightCm: 178, startWeightKg: 80, targetWeightKg: 75,
      activityFactor: 1.55, physique: 'lean_aesthetic', physiqueChosen: true, unit: 'kg', diet: 'veg',
      privacy: 'public', verified: true, bio: 'Dialog accessibility fixture account.',
      following: [], autoFollowed: [], socials: { instagram: '', linkedin: '', facebook: '' },
    },
    weightLog: [{ date: iso(7), kg: 80.4 }, { date: iso(0), kg: 80 }],
    workoutLog: [], foodLog: [], restDays: [], updatedAt: 1,
  };
}

function configOverrides() {
  return `\nObject.assign(window, {
    SUPABASE_URL: ${JSON.stringify(origin)}, SUPABASE_ANON_KEY: 'fixture-public-anon', USE_SUPABASE_AUTH: true,
    GOOGLE_CLIENT_ID: '', GOOGLE_IOS_CLIENT_ID: '', POSTHOG_KEY: '', EMAILJS_PUBLIC_KEY: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAIL_FN_URL: '', SHEETS_API: '', SOCIAL_API: '',
    PEXELS_KEY: '', MOD_TOKEN: ''
  });
  if (window.Currency) Object.assign(window.Currency, { ready: true, cur: 'INR', rate: 83, country: 'IN' });\n`;
}

before(async () => {
  fs.mkdirSync(reportDirectory, { recursive: true });
  server = http.createServer((request, response) => {
    const file = ['GET', 'HEAD'].includes(request.method) ? publicAsset(new URL(request.url, 'http://127.0.0.1').pathname) : null;
    if (!file) { response.writeHead(404, { 'Cache-Control': 'no-store' }).end(); return; }
    let body = fs.readFileSync(file);
    if (file === path.join(root, 'js', 'config.js')) body = Buffer.from(body.toString() + configOverrides());
    response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  assert.ok(browserType && ['chromium', 'firefox', 'webkit'].includes(browserName), 'Unknown QA browser engine');
  browser = await browserType.launch({ headless: true });
});

after(async () => {
  try { if (browser) await browser.close(); }
  finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    findings.observedAt = new Date().toISOString();
    fs.writeFileSync(path.join(reportDirectory, 'findings.json'), JSON.stringify(findings, null, 2) + '\n');
  }
});

async function openApp(t, viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: !!viewport.touch, reducedMotion: 'reduce', serviceWorkers: 'block',
  });
  await context.route('**/*', async route => {
    try {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { await route.abort('blockedbyclient'); return; }
      if (url.pathname.startsWith('/auth/v1/')) {
        await route.fulfill({ status: 200, json: { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, token_type: 'bearer', user: { id: member.uid, email: member.email } } });
        return;
      }
      if (url.pathname.startsWith('/rest/v1/')) {
        if (url.pathname.endsWith('/rpc/get_state')) { await route.fulfill({ json: { users: {}, posts: {}, requests: {}, comments: {}, stories: {} } }); return; }
        if (route.request().method() !== 'GET') { await route.fulfill({ status: 201, body: '' }); return; }
        if (url.pathname.endsWith('/accounts')) { await route.fulfill({ json: [{ uid: member.uid, data: accountState() }] }); return; }
        if (url.pathname.endsWith('/entitlements')) { await route.fulfill({ json: [{ uid: member.uid, tier: 'free', status: 'active', current_period_end: '2099-01-01T00:00:00Z' }] }); return; }
        await route.fulfill({ json: [] });
        return;
      }
      await route.continue();
    } catch (error) {
      if (!/closed|Target page|context or browser has been closed/i.test(error.message)) throw error;
    }
  });
  await context.addInitScript(seed => {
    localStorage.setItem('formora_supa_session', JSON.stringify({ uid: seed.uid, email: seed.email, access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600 }));
    localStorage.setItem('gymcoach_auth', JSON.stringify({ accounts: [{ id: 'a11y-local', email: seed.email, name: seed.name, provider: 'supabase', emailVerified: true }], currentUserId: 'a11y-local' }));
    localStorage.setItem('gymcoach_v1_a11y-local', JSON.stringify(seed.state));
    localStorage.setItem('fm_dl_x', '1');
  }, { uid: member.uid, email: member.email, name: member.name, state: accountState() });

  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  t.after(async () => { await context.close().catch(() => {}); });
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.locator('#app-shell:not(.hidden)').waitFor({ timeout: TIMEOUT });
  await page.locator('#launch').waitFor({ state: 'detached', timeout: TIMEOUT }).catch(() => {});
  await page.evaluate(() => App.selectTab('profile'));
  await page.locator('#p-name').waitFor({ timeout: TIMEOUT });
  return { page, pageErrors };
}

function record(name, viewport, observations, failures) {
  findings.cases.push({ name, viewport, observations, failures, result: failures.length ? 'failed' : 'passed' });
}

const active = page => page.evaluate(() => (document.activeElement ? document.activeElement.outerHTML.slice(0, 160) : null));
const modalOpen = page => page.evaluate(() => !document.getElementById('modal').classList.contains('hidden'));

const viewports = [{ width: 320, height: 640, touch: true }, { width: 390, height: 844, touch: true }, { width: 1366, height: 900, touch: false }];

for (const viewport of viewports) {
  for (const kind of ['pricing', 'support']) {
    test(`DEF-039: ${kind} dialog semantics, focus and Escape at ${viewport.width}px [${browserName}]`, { timeout: 90000 }, async t => {
      const { page, pageErrors } = await openApp(t, viewport);
      const failures = [];
      const check = (condition, expected, actual) => { if (!condition) failures.push({ expected, actual }); };

      const opener = page.locator('#view-profile button[onclick="App.openSupport()"]').last();
      await opener.focus();
      if (kind === 'support') await opener.click();
      else await page.evaluate(() => App.openPricing());
      await page.locator('#modal-card').waitFor({ state: 'visible' });

      const opened = await page.evaluate(() => {
        const modal = document.getElementById('modal');
        const card = document.getElementById('modal-card');
        const labelledBy = modal.getAttribute('aria-labelledby');
        const target = labelledBy ? document.getElementById(labelledBy) : null;
        const heading = card.querySelector('h1,h2,h3');
        const clean = text => (text || '').replace(/\s+/g, ' ').trim();
        return {
          role: modal.getAttribute('role'), ariaModal: modal.getAttribute('aria-modal'),
          labelledBy, ariaLabel: modal.getAttribute('aria-label'),
          accessibleName: target ? clean(target.textContent) : clean(modal.getAttribute('aria-label')),
          headingText: clean(heading && heading.textContent),
          focusInside: modal.contains(document.activeElement),
          shellInert: document.getElementById('app-shell').inert === true,
          authInert: document.getElementById('auth-overlay').inert === true,
          modalInert: modal.inert === true,
        };
      });
      check(opened.role === 'dialog' && opened.ariaModal === 'true', 'The shared modal exposes dialog semantics', opened);
      check(!!opened.headingText && opened.accessibleName === opened.headingText,
        "The dialog is named by the open view's own heading", opened);
      check(!!opened.labelledBy || !!opened.ariaLabel, 'The dialog exposes an accessible name', opened);
      check(opened.focusInside, 'Focus enters the dialog when it opens', await active(page));
      check(opened.shellInert && opened.authInert, 'Background regions are inert while the dialog is open', opened);
      check(!opened.modalInert, 'The dialog itself is never made inert', opened);

      // backwards from the first control, and forwards from the last: both stay inside
      const close = page.locator('#modal .modal-head button[onclick="App.closeModal()"]').first();
      await close.focus();
      await page.keyboard.press('Shift+Tab');
      check(await page.evaluate(() => document.getElementById('modal').contains(document.activeElement)),
        'Shift+Tab from the first control stays inside the dialog', await active(page));
      const wrapped = await page.evaluate(async () => {
        const items = App._modalFocusables();
        items[items.length - 1].focus();
        return items.length;
      });
      await page.keyboard.press('Tab');
      check(wrapped > 1 && await page.evaluate(() => document.getElementById('modal').contains(document.activeElement)),
        'Tab from the last control wraps back into the dialog', { focusables: wrapped, active: await active(page) });

      await page.keyboard.press('Escape');
      check(!await modalOpen(page), 'Escape closes the dialog', 'Modal still open');
      const closed = await page.evaluate(() => ({
        shellInert: document.getElementById('app-shell').inert === true,
        authInert: document.getElementById('auth-overlay').inert === true,
      }));
      check(!closed.shellInert && !closed.authInert, 'Closing restores the background to an interactive state', closed);
      check(await opener.evaluate(element => element === document.activeElement),
        'Closing returns focus to the control that opened the dialog', await active(page));
      check(pageErrors.length === 0, 'No uncaught application errors', pageErrors);

      record(`${kind} dialog ${viewport.width}`, viewport, { opened, closed, focusables: wrapped }, failures);
      assert.deepEqual(failures, [], `${kind} dialog at ${viewport.width}px`);
    });
  }
}

test(`DEF-039: a card re-render never steals focus from a field being used [${browserName}]`, { timeout: 90000 }, async t => {
  const { page, pageErrors } = await openApp(t, viewports[1]);
  const failures = [];
  await page.evaluate(() => App.openSupport());
  await page.locator('#sp-msg').waitFor({ state: 'visible' });
  await page.locator('#sp-msg').fill('Half-written support request');
  // a live subtree change (image load, preview swap, gallery injection) must not reset focus
  await page.evaluate(() => document.getElementById('modal-card').insertAdjacentHTML('beforeend', '<span data-qa-mutation="1"></span>'));
  await page.waitForTimeout(120);
  const state = await page.evaluate(() => ({ id: document.activeElement?.id, value: document.getElementById('sp-msg').value }));
  if (state.id !== 'sp-msg') failures.push({ expected: 'Focus stays in the field being typed in', actual: state });
  if (state.value !== 'Half-written support request') failures.push({ expected: 'The draft is untouched by the re-render', actual: state });
  if (pageErrors.length) failures.push({ expected: 'No uncaught application errors', actual: pageErrors });
  record('re-render focus stability', viewports[1], state, failures);
  assert.deepEqual(failures, [], 're-render focus stability');
});

test(`DEF-039: action sheets keep their own keyboard handling on top of a dialog [${browserName}]`, { timeout: 90000 }, async t => {
  const { page, pageErrors } = await openApp(t, viewports[1]);
  const failures = [];
  await page.evaluate(() => App.openSupport());
  await page.locator('#sp-subj').waitFor({ state: 'visible' });
  await page.evaluate(() => App.openSheet('QA options', [{ icon: 'copy', label: 'A fixture option', fn: () => {} }]));
  await page.locator('#sheet-wrap .sheet-opt').first().waitFor();
  const withSheet = await page.evaluate(() => ({
    sheetHasFocus: document.getElementById('sheet-wrap').contains(document.activeElement),
    sheetIsDialog: document.querySelector('#sheet-wrap .sheet')?.getAttribute('role'),
  }));
  if (!withSheet.sheetHasFocus || withSheet.sheetIsDialog !== 'dialog') failures.push({ expected: 'The action sheet still owns focus and its own dialog role', actual: withSheet });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
  const afterFirst = await page.evaluate(() => ({ sheet: !!document.getElementById('sheet-wrap'), modal: !document.getElementById('modal').classList.contains('hidden') }));
  if (afterFirst.sheet || !afterFirst.modal) failures.push({ expected: 'Escape closes only the sheet and leaves the dialog open', actual: afterFirst });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
  const afterSecond = await page.evaluate(() => ({ modal: !document.getElementById('modal').classList.contains('hidden'), shellInert: document.getElementById('app-shell').inert === true }));
  if (afterSecond.modal || afterSecond.shellInert) failures.push({ expected: 'A second Escape closes the dialog and clears the background inertness', actual: afterSecond });
  if (pageErrors.length) failures.push({ expected: 'No uncaught application errors', actual: pageErrors });
  record('sheet over dialog', viewports[1], { withSheet, afterFirst, afterSecond }, failures);
  assert.deepEqual(failures, [], 'sheet over dialog');
});

test(`DEF-039: the dialog layer never rewrites the markup a feature rendered [${browserName}]`, { timeout: 90000 }, async t => {
  const { page, pageErrors } = await openApp(t, viewports[1]);
  const failures = [];
  // feature modules compare their own rendered card before applying async updates,
  // so applying dialog semantics must not mutate #modal-card
  const captured = await page.evaluate(() => { App.openSupport(); return document.getElementById('modal-card').innerHTML; });
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => document.getElementById('modal-card').innerHTML);
  if (after !== captured) failures.push({ expected: 'The rendered card is byte-identical after the dialog is prepared', actual: { length: after.length, captured: captured.length } });
  const named = await page.evaluate(() => document.getElementById('modal').getAttribute('aria-label') || document.getElementById('modal').getAttribute('aria-labelledby'));
  if (!named) failures.push({ expected: 'The dialog still has an accessible name', actual: named });
  if (pageErrors.length) failures.push({ expected: 'No uncaught application errors', actual: pageErrors });
  record('card markup stability', viewports[1], { named, unchanged: after === captured }, failures);
  assert.deepEqual(failures, [], 'card markup stability');
});

test(`DEF-040: rendered authentication, onboarding, support and profile labels are associated [${browserName}]`, { timeout: 90000 }, async t => {
  const { page, pageErrors } = await openApp(t, viewports[1]);
  const failures = [];
  const screens = [
    { name: 'profile', root: '#view-profile', action: () => App.selectTab('profile'), ready: '#view-profile #p-name' },
    { name: 'support', root: '#modal-card', action: () => App.openSupport() },
    { name: 'login', root: '#auth-card', action: () => { App.closeModal(); App.showAuth('login'); } },
    { name: 'signup', root: '#auth-card', action: () => App.showAuth('signup') },
    { name: 'onboarding', root: '#auth-card', action: () => App.showAuth('details') },
  ];
  const observed = [];
  for (const screen of screens) {
    await page.evaluate(screen.action);
    // Profile paints asynchronously behind a placeholder, so a fixed pause is not proof it rendered.
    if (screen.ready) await page.locator(screen.ready).waitFor();
    await page.waitForTimeout(60);
    const result = await page.locator(screen.root).evaluate(element => {
      const controls = [...element.querySelectorAll('input:not([type=hidden]):not([type=file]),select,textarea')].filter(control => control.checkVisibility());
      return {
        total: controls.length,
        unnamed: controls.filter(control => !control.labels?.length && !control.getAttribute('aria-label') && !control.getAttribute('aria-labelledby'))
          .map(control => ({ id: control.id, placeholder: control.placeholder || '' })),
        // a visible label must actually point at a control, otherwise clicking it does nothing
        danglingLabels: [...element.querySelectorAll('label[for]')].filter(label => !document.getElementById(label.htmlFor)).map(label => label.htmlFor),
      };
    });
    observed.push({ screen: screen.name, ...result });
    if (result.total === 0) failures.push({ expected: screen.name + ' renders its form controls', actual: result });
    if (result.unnamed.length) failures.push({ expected: screen.name + ': every visible control has an accessible name', actual: result.unnamed });
    if (result.danglingLabels.length) failures.push({ expected: screen.name + ': no label points at a missing control', actual: result.danglingLabels });
  }
  // clicking the visible label must move focus into its control
  await page.evaluate(() => {
    App.closeModal();
    document.getElementById('auth-overlay').classList.add('hidden');
    document.getElementById('app-shell').classList.remove('hidden');
    App.selectTab('profile');
  });
  await page.locator('#p-name').waitFor();
  await page.locator('#view-profile label[for="p-name"]').click();
  const focused = await page.evaluate(() => document.activeElement?.id);
  if (focused !== 'p-name') failures.push({ expected: 'Clicking the Name label focuses the Name field', actual: focused });
  if (pageErrors.length) failures.push({ expected: 'No uncaught application errors', actual: pageErrors });
  record('form label association', viewports[1], { screens: observed, labelClickFocus: focused }, failures);
  assert.deepEqual(failures, [], 'form label association');
});
