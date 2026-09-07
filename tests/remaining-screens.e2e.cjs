'use strict';

// T-61 / T-61-next — measured layout audit of the REMAINING product screens.
// Scope: Nutrition, Search, Alerts, DM thread, Profile settings, Program, Progress.
// This suite MEASURES the real rendered app (visible geometry, not source presence) and
// writes an evidence report + screenshots. It never edits app source and never touches a
// real account or network: every request is served by an ephemeral localhost fixture.
// Run both suites and all engines: node tests/remaining-screens.e2e.cjs --audit-matrix
// FORMORA_QA_BROWSER optionally selects chromium, firefox or webkit; FORMORA_QA_SUITES
// optionally selects remaining-screens or theme-accessibility. Each matrix run is isolated.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const browserName = process.env.FORMORA_QA_BROWSER || 'chromium';
const browserType = require('playwright')[browserName];
const { createHash } = require('node:crypto');
const { measureTapTargetsInPage } = require('./touch-targets.test.cjs');

const root = path.resolve(__dirname, '..');
const reportParent = path.resolve(root, process.env.FORMORA_QA_SCREEN_AUDIT_OUTPUT || 'dist/screen-audit');
let reportDirectory = process.env.FORMORA_QA_SCREEN_AUDIT_OUTPUT ? reportParent : null;
const REQUEST_TIMEOUT = 8000; // every request-owned wait stays under 10s
const MIN_TARGET = 44;
const CSS_BUDGET = 102400;
const stylesheet = fs.readFileSync(path.join(root, 'css/styles.css'));

if (process.argv.includes('--audit-matrix')) {
  const { spawnSync } = require('node:child_process');
  const suites = process.env.FORMORA_QA_SUITES ? process.env.FORMORA_QA_SUITES.split(',')
    : ['remaining-screens', 'theme-accessibility'];
  const engines = process.env.FORMORA_QA_BROWSER ? [browserName] : ['chromium', 'firefox', 'webkit'];
  assert.ok(suites.every(suite => ['remaining-screens', 'theme-accessibility'].includes(suite)));
  assert.ok(engines.every(engine => ['chromium', 'firefox', 'webkit'].includes(engine)));
  const owned = ['css/styles.css', 'tests/remaining-screens.e2e.cjs', 'tests/theme-accessibility.e2e.cjs']
    .map(relative => ({ path: relative, body: fs.readFileSync(path.join(root, relative)) }));
  const fingerprint = body => createHash('sha256').update(body).digest('hex');
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'dist/accessibility-matrix-'));
  const runs = [];
  const filters = process.argv.filter(argument => argument.startsWith('--test-name-pattern='));
  process.on('SIGINT', () => {});
  console.log('Accessibility matrix: ' + directory);
  for (const engine of engines) {
    for (const suite of suites) {
      const output = path.join(directory, engine, suite);
      fs.mkdirSync(output, { recursive: true });
      const logPath = path.join(output, 'test.tap');
      const log = fs.openSync(logPath, 'wx');
      console.log('Running ' + engine + ' / ' + suite);
      const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap',
        ...filters, path.join(root, 'tests', suite + '.e2e.cjs')], {
        cwd: root, detached: true, stdio: ['ignore', log, log],
        env: { ...process.env, FORMORA_QA_BROWSER: engine, FORMORA_QA_EXTENDED: '0',
          FORMORA_QA_SCREEN_AUDIT_OUTPUT: output, FORMORA_QA_THEME_AUDIT_OUTPUT: output },
      });
      fs.closeSync(log);
      const text = fs.readFileSync(logPath, 'utf8');
      const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped'].map(name =>
        [name, Number(text.match(new RegExp('^# ' + name + ' (\\d+)$', 'm'))?.[1] || 0)]));
      const result = { browser: engine, suite, exitCode: run.status, signal: run.signal,
        error: run.error?.message || null, ...counts, directory: path.relative(root, output) };
      runs.push(result);
      console.log(JSON.stringify(result));
      if (run.status !== 0) console.log(text.slice(-6000));
    }
  }
  const source = owned.map(entry => ({ path: entry.path, bytes: entry.body.length,
    sha256: fingerprint(entry.body), currentSha256: fingerprint(fs.readFileSync(path.join(root, entry.path))) }));
  const ownedSourcesUnchanged = source.every(entry => entry.sha256 === entry.currentSha256);
  const summary = { generatedAt: new Date().toISOString(), cssBytes: stylesheet.length, cssBudget: CSS_BUDGET,
    ownedSourcesUnchanged, source, runs, filtered: filters.length > 0,
    limits: ['Local offline fixtures only. Browser and suite processes run sequentially with test concurrency 1.',
      'Only the three owned files are checked for stability; concurrently edited application files are not claimed unchanged.'] };
  fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('Accessibility summary: ' + path.join(directory, 'summary.json'));
  process.exit(runs.every(run => run.exitCode === 0 && run.tests > 0 && run.fail === 0 && run.cancelled === 0)
    && ownedSourcesUnchanged && stylesheet.length <= CSS_BUDGET ? 0 : 1);
}

const member = { uid: '11111111-1111-4111-8111-111111111111', email: 'audit.primary@example.test', name: 'Audit Primary' };
const peer = { uid: '22222222-2222-4222-8222-222222222222', name: 'Audit Peer', username: 'audit_peer' };

let server, browser, origin;
const report = {
  generatedAt: null,
  browser: browserName,
  task: 'T-61 (subtask T-61-next) — continue the measured layout audit on the remaining screens',
  defect: 'DEF004 local touch-target repair; independent re-review still required',
  baseline: { screenViewportCases: 21, actionableControlsMeasured: 276, controlsBelow44: 171, distinctFindingGroups: 48, cssBytes: 102377 },
  stylesheet: { path: 'css/styles.css', bytes: stylesheet.length, budget: CSS_BUDGET, sha256: createHash('sha256').update(stylesheet).digest('hex') },
  scope: 'Local fixture browser measurement of the checked-in web build only. Not a deployed-environment, real-provider, physical-device or production acceptance.',
  method: {
    server: 'Ephemeral 127.0.0.1 HTTP server, public-asset allowlist, realpath equality check (no symlinks), no directory traversal, private/repo files denied.',
    network: 'All non-fixture origins aborted at the browser route layer plus a DNS blackhole; no external request is possible.',
    identity: 'Fixture-only Supabase session and local account on example.test. No real account, credential or logout path is exercised.',
    evidence: 'Visible geometry from getBoundingClientRect + getComputedStyle on the rendered DOM, plus innerText (rendered text only). Hidden markup and source strings are never asserted.',
    tapTargets: 'Legacy border-box counts retained for the 276-control baseline. Expanded coverage includes visible upload labels and checks every target at center plus four inset edge midpoints with elementFromPoint after scrolling into view. Edge actions settle finite animations and use real locator mouse/touch dispatch with rerender auto-waiting. Fixed navigation is not ignored; a real interception fails.',
    exceptions: 'Only the three Profile About legal links may use the measured 24px-circle spacing exception of WCAG 2.2 SC 2.5.8 (AA). This is not 44px enhanced/AAA conformance. Other standalone controls must be at least 44px in both dimensions.',
    requestTimeoutMs: REQUEST_TIMEOUT,
  },
  limits: [
    browserName + ' headless only; no real iOS/Android device, no real font fallback differences.',
    'The remote Google Fonts stylesheet is blocked by the offline policy, so text is measured with the local fallback face; glyph widths can differ slightly from production.',
    'Overlap detection reports pairs whose intersection exceeds 20% of the smaller text element; sub-threshold crowding is not reported.',
    'Tap-target measurement uses CSS pixel border boxes; it does not model platform touch slop.',
    'Unavailable meal swaps are tested with the real vegan meal pool: disabled appearance, hover invariance and hit ownership are measured. Enabled swaps use real non-vegetarian alternatives; no meal pool or enabled-state override is injected.',
    'No human or reviewer approval is represented anywhere in this report.',
  ],
  viewports: [],
  screens: [],
  cases: [],
  findings: [],
  acceptance: {},
};

const viewports = [
  { name: '375x812', width: 375, height: 812, touch: true },
  { name: '390x844', width: 390, height: 844, touch: true },
  { name: '1280x900', width: 1280, height: 900, touch: false },
];

// ---------------------------------------------------------------- fixture data

function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function accountState() {
  const workout = (date, weight) => ({
    date, split: 'push', volume: 40 * weight,
    exercises: [
      { id: 'bench_press', name: 'Barbell Bench Press', muscle: 'chest', sets: [{ reps: 8, weight }, { reps: 8, weight }, { reps: 6, weight: weight + 2.5 }] },
      { id: 'ohp', name: 'Overhead Press', muscle: 'shoulders', sets: [{ reps: 10, weight: 30 }, { reps: 10, weight: 30 }] },
    ],
  });
  return {
    profile: {
      name: 'Audit Primary', email: member.email, username: 'audit_primary', onboarded: true,
      gender: 'male', dob: '1995-03-28', heightCm: 178, startWeightKg: 80, targetWeightKg: 75,
      activityFactor: 1.55, physique: 'lean_aesthetic', physiqueChosen: true, unit: 'kg', diet: 'veg',
      tier: 'elite', privacy: 'public', verified: true, bio: 'Measured layout audit fixture account.',
      following: [], autoFollowed: [], socials: { instagram: '', linkedin: '', facebook: '' },
    },
    weightLog: [
      { date: isoDaysAgo(28), kg: 82 }, { date: isoDaysAgo(21), kg: 81.4 },
      { date: isoDaysAgo(14), kg: 81 }, { date: isoDaysAgo(7), kg: 80.4 }, { date: isoDaysAgo(0), kg: 80 },
    ],
    workoutLog: [workout(isoDaysAgo(16), 55), workout(isoDaysAgo(9), 57.5), workout(isoDaysAgo(2), 60)],
    foodLog: [{
      date: isoDaysAgo(0),
      items: [
        { text: 'Oats with milk, banana and whey', kcal: 520, protein: 38, estimated: true },
        { text: 'Paneer bhurji with two rotis and salad', kcal: 640, protein: 34, estimated: true },
      ],
    }],
    restDays: [isoDaysAgo(4)],
    updatedAt: 2,
  };
}

const notifications = [
  { id: 'n-1', uid: member.uid, type: 'like', actor: peer.uid, post_id: 'post-peer', body: '', ts: new Date(Date.now() - 240000).toISOString(), read: false },
  { id: 'n-2', uid: member.uid, type: 'comment', actor: peer.uid, post_id: 'post-peer', body: 'Solid session, what split is that?', ts: new Date(Date.now() - 900000).toISOString(), read: false },
  { id: 'n-3', uid: member.uid, type: 'accept', actor: peer.uid, post_id: null, body: '', ts: new Date(Date.now() - 3600000).toISOString(), read: true },
];

const messages = [
  { id: 'm-1', from_uid: peer.uid, to_uid: member.uid, body: 'Are you training push today or moving it to tomorrow?', ts: new Date(Date.now() - 600000).toISOString() },
  { id: 'm-2', from_uid: member.uid, to_uid: peer.uid, body: 'Push today. I want to keep the bench progression going before the deload week starts.', ts: new Date(Date.now() - 540000).toISOString() },
  { id: 'm-3', from_uid: peer.uid, to_uid: member.uid, body: 'Nice. Send the program screenshot when you get a chance.', ts: new Date(Date.now() - 300000).toISOString() },
];

function cloudState() {
  return {
    users: {
      [peer.uid]: { uid: peer.uid, name: peer.name, username: peer.username, privacy: 'public', physique: 'Lean Aesthetic', bio: 'Training partner fixture profile.', tier: 'pro', verified: true, following: [] },
      'audit-c-0000-4000-8000-000000000003': { uid: 'audit-c-0000-4000-8000-000000000003', name: 'Audit Newcomer', username: 'audit_newcomer', privacy: 'public', bio: 'Just joined the fixture crew.', tier: 'free', following: [] },
    },
    requests: {
      'r-1': { id: 'r-1', from: member.uid, to: peer.uid, status: 'accepted', ts: Date.now() - 86400000 },
    },
    posts: {
      'post-peer': { id: 'post-peer', author: peer.uid, data: { text: 'Deload week done, back to heavy pressing.', tag: 'Push day', gradient: ['#ef6548', '#ba4352'] }, likes: {}, ts: Date.now() - 120000 },
      'post-mine': { id: 'post-mine', author: member.uid, data: { text: 'Bench moved to 60kg for six clean reps.', tag: 'Progress', gradient: ['#306960', '#234d75'] }, likes: {}, ts: Date.now() - 200000 },
    },
    comments: {
      'c-1': { id: 'c-1', post_id: 'post-peer', author: member.uid, body: 'Great work, that top set looked fast.', parent_id: null, mentions: [], ts: Date.now() - 100000 },
    },
    stories: {},
  };
}

// ---------------------------------------------------------------- asset server

const mimeTypes = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.txt': 'text/plain',
};

function publicAsset(rawPathname) {
  let pathname;
  try { pathname = decodeURIComponent(rawPathname); } catch { return null; }
  if (pathname === '/') pathname = '/index.html';
  if (pathname.includes('\\') || pathname.includes('\0')) return null;
  if (pathname.split('/').some(segment => segment.startsWith('.'))) return null;
  const allowed = /^\/(index\.html|legal\.html|manifest\.webmanifest|version\.txt|favicon\.ico|robots\.txt)$/.test(pathname)
    || /^\/js\/[A-Za-z0-9_/-]+\.js$/.test(pathname)
    || /^\/css\/[A-Za-z0-9_/-]+\.css$/.test(pathname)
    || /^\/(assets|icons)\/[A-Za-z0-9_/-]+\.(json|png|jpe?g|webp|gif|svg|ico|woff2|mp4|webm|mp3)$/.test(pathname);
  if (!allowed) return null;
  const resolved = path.resolve(root, '.' + pathname);
  if (!resolved.startsWith(root + path.sep)) return null;
  try {
    if (!fs.statSync(resolved).isFile()) return null;
    if (fs.realpathSync(resolved) !== resolved) return null; // no symlink escapes
  } catch { return null; }
  return resolved;
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
  if (!reportDirectory) {
    fs.mkdirSync(reportParent, { recursive: true });
    reportDirectory = fs.mkdtempSync(path.join(reportParent, browserName + '-'));
  }
  fs.mkdirSync(reportDirectory, { recursive: true });
  server = http.createServer((request, response) => {
    const file = ['GET', 'HEAD'].includes(request.method)
      ? publicAsset(new URL(request.url, 'http://127.0.0.1').pathname) : null;
    if (!file) { response.writeHead(404, { 'Cache-Control': 'no-store' }).end(); return; }
    let body = fs.readFileSync(file);
    if (file === path.join(root, 'js', 'config.js')) body = Buffer.from(body.toString() + configOverrides());
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  assert.ok(browserType && ['chromium', 'firefox', 'webkit'].includes(browserName), 'Unknown QA browser engine');
  browser = await browserType.launch({
    headless: true,
    executablePath: browserName === 'chromium' ? process.env.OFFICE_BROWSER_EXECUTABLE || undefined : undefined,
    args: browserName === 'chromium' ? ['--disable-background-networking', '--disable-component-update', '--disable-domain-reliability',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'] : [],
  });
});

after(async () => {
  try { if (browser) await browser.close(); }
  finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
  writeReport();
  console.log('Screen evidence: ' + path.relative(root, path.join(reportDirectory, 'report.json')));
});

// ---------------------------------------------------------------- page harness

async function openApp(t, viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: viewport.touch, isMobile: false, reducedMotion: 'reduce', serviceWorkers: 'block',
  });
  const blockedExternal = [];
  const messageWrites = [];
  const sharedState = cloudState();
  const fixtureMessages = structuredClone(messages);
  const fontOrigins = new Set(['https://fonts.googleapis.com', 'https://fonts.gstatic.com']);
  await context.route('**/*', async route => {
    try {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        blockedExternal.push({ origin: url.origin, pathname: url.pathname, fontAsset: fontOrigins.has(url.origin) });
        await route.abort('blockedbyclient');
        return;
      }
      if (url.pathname.startsWith('/auth/v1/')) {
        await route.fulfill({ status: 200, json: { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, token_type: 'bearer', user: { id: member.uid, email: member.email, user_metadata: { name: member.name } } } });
        return;
      }
      if (url.pathname.startsWith('/rest/v1/')) {
        // get_state is an RPC POST, so it must be matched before the generic write branch
        if (url.pathname.endsWith('/rpc/get_state')) { await route.fulfill({ json: sharedState }); return; }
        if (request.method() !== 'GET') {
          if (url.pathname.endsWith('/messages') && request.method() === 'POST') {
            const message = { ...request.postDataJSON(), ts: new Date().toISOString() };
            assert.equal(message.from_uid, member.uid);
            assert.equal(message.to_uid, peer.uid);
            messageWrites.push(message);
            if (!fixtureMessages.some(row => row.id === message.id)) fixtureMessages.push(structuredClone(message));
            await route.fulfill({ status: 201, json: [message] }); return;
          }
          await route.fulfill({ status: 201, body: '' }); return;
        }
        if (url.pathname.endsWith('/entitlements')) {
          await route.fulfill({ json: [{ uid: member.uid, tier: 'elite', status: 'active', current_period_end: '2099-01-01T00:00:00Z' }] });
        } else if (url.pathname.endsWith('/accounts')) {
          await route.fulfill({ json: [{ uid: member.uid, data: accountState() }] });
        } else if (url.pathname.endsWith('/notifications')) {
          await route.fulfill({ json: structuredClone(notifications) });
        } else if (url.pathname.endsWith('/messages')) {
          await route.fulfill({ json: fixtureMessages });
        } else {
          await route.fulfill({ json: [] });
        }
        return;
      }
      await route.continue();
    } catch (error) {
      // the page can navigate or close while a route is in flight; never let that become
      // an unhandled rejection that tears down the whole test process
      if (!/closed|Target page|context or browser has been closed/i.test(error.message)) throw error;
    }
  });

  await context.addInitScript(seed => {
    const today = new Date();
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const state = seed.state;
    state.foodLog[0].date = iso(today);
    state.weightLog[state.weightLog.length - 1].date = iso(today);
    localStorage.setItem('formora_supa_session', JSON.stringify({ uid: seed.uid, email: seed.email, access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600 }));
    localStorage.setItem('gymcoach_auth', JSON.stringify({ accounts: [{ id: 'audit-local', email: seed.email, name: seed.name, provider: 'supabase', emailVerified: true }], currentUserId: 'audit-local' }));
    localStorage.setItem('gymcoach_v1_audit-local', JSON.stringify(state));
    localStorage.setItem('fm_dl_x', '1');
    localStorage.setItem('fm_tier', 'elite');
  }, { uid: member.uid, email: member.email, name: member.name, state: accountState() });

  const page = await context.newPage();
  page.setDefaultTimeout(REQUEST_TIMEOUT);
  page.setDefaultNavigationTimeout(REQUEST_TIMEOUT);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  t.after(async () => { await context.close().catch(() => {}); });

  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.locator('#app-shell:not(.hidden)').waitFor({ timeout: REQUEST_TIMEOUT });
  await page.locator('#launch').waitFor({ state: 'detached', timeout: REQUEST_TIMEOUT }).catch(() => {});
  await page.locator('#view-feed .social-subnav').waitFor({ timeout: REQUEST_TIMEOUT });
  // the social/notification polls are asynchronous; wait for the fixture state so every
  // screen is measured with real content rather than an empty first paint
  const readiness = { ready: false, state: null, error: null };
  try {
    await page.waitForFunction(() => typeof Social !== 'undefined'
      && Social.cloud && (Social.cloud.users || []).length > 0
      && (Social.cloud.connections || []).length > 0
      && (Social.cloud.notifs || []).length > 0
      && typeof Entitlements !== 'undefined' && Entitlements.isPro(), null, { timeout: REQUEST_TIMEOUT });
    readiness.ready = true;
  } catch (error) {
    readiness.error = error.message.split('\n')[0];
  }
  readiness.state = await page.evaluate(() => ({
    cloudActive: typeof Cloud !== 'undefined' && Cloud.active(), cloudMe: typeof Cloud !== 'undefined' ? Cloud.me : null,
    supaUid: typeof SupaAuth !== 'undefined' ? SupaAuth.uid() : null,
    users: (Social.cloud.users || []).length, connections: (Social.cloud.connections || []).length,
    notifs: (Social.cloud.notifs || []).length, feed: (Social.cloud.feed || []).length,
    pro: typeof Entitlements !== 'undefined' && Entitlements.isPro(),
  })).catch(() => null);
  return { page, pageErrors, blockedExternal, readiness, messageWrites };
}

// ---------------------------------------------------------------- measurement

const measureInPage = ({ rootSelector, panelSelector, minTarget }) => {
  const container = document.querySelector(rootSelector);
  if (!container) return { present: false };

  const style = el => getComputedStyle(el);
  const shown = el => {
    const s = style(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0.5 && r.height > 0.5;
  };
  const describe = el => {
    const part = node => node.tagName.toLowerCase()
      + (node.id ? '#' + node.id : '')
      + [...node.classList].slice(0, 2).map(c => '.' + c).join('');
    const chain = [];
    for (let node = el, depth = 0; node && node !== document.body && depth < 4; node = node.parentElement, depth++) chain.unshift(part(node));
    return chain.join(' > ');
  };
  const labelOf = el => (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.value || el.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 64);
  const round = n => Math.round(n * 10) / 10;

  const containerRect = container.getBoundingClientRect();
  const visibleText = (container.innerText || '').replace(/\s+/g, ' ').trim();
  const everything = [...container.querySelectorAll('*')];
  const visibleElements = everything.filter(shown);

  // includes div[onclick] rows (notification, DM and crew rows are tappable divs), because a
  // real tap target is whatever the user can actually press, not only semantic buttons
  const controlSelector = 'button,a[href],input:not([type=hidden]),select,textarea,label.photo-btn,[role="button"],[onclick]';
  const inScroller = el => {
    for (let node = el.parentElement; node; node = node.parentElement) {
      if (/auto|scroll/.test(style(node).overflowX)) return true;
    }
    return false;
  };
  const controls = [...container.querySelectorAll(controlSelector)].filter(shown)
    .filter(el => !el.querySelector(controlSelector))
    .map(el => {
      // a wrapping <label> is the real hit area for a checkbox or radio
      const wrapper = el.closest('label');
      const target = wrapper && wrapper !== el && wrapper.querySelectorAll(controlSelector).length === 1 ? wrapper : el;
      const r = target.getBoundingClientRect();
      const classes = el.classList;
      return {
        selector: describe(el), label: labelOf(el),
        width: round(r.width), height: round(r.height),
        targetSelector: target === el ? null : describe(target),
        primary: classes.contains('btn') && !classes.contains('sm'),
        semantic: /^(BUTTON|A|INPUT|SELECT|TEXTAREA|LABEL)$/.test(el.tagName) || el.getAttribute('role') === 'button',
        meetsTarget: r.width >= minTarget - 0.5 && r.height >= minTarget - 0.5,
      };
    });

  const documentOverflowPx = Math.round(document.documentElement.scrollWidth - window.innerWidth);
  let widestRight = 0, widestSelector = null;
  for (const el of visibleElements) {
    if (inScroller(el)) continue; // an intentional horizontal scroller is not clipped content
    const r = el.getBoundingClientRect();
    if (r.right > widestRight) { widestRight = r.right; widestSelector = describe(el); }
  }
  const clippedRightPx = Math.round(widestRight - window.innerWidth);

  const panels = [...container.querySelectorAll(panelSelector)].filter(shown);
  const panelOverflow = panels.map(panel => {
    const s = style(panel);
    const scrollable = /auto|scroll/.test(s.overflowX);
    const overflowPx = Math.round(panel.scrollWidth - panel.clientWidth);
    if (scrollable || overflowPx <= 1) return { scrollable, overflowPx };
    const panelRight = panel.getBoundingClientRect().right;
    let widest = null, widestRight = panelRight;
    for (const child of panel.querySelectorAll('*')) {
      if (!shown(child)) continue;
      const r = child.getBoundingClientRect();
      if (r.right > widestRight + 0.5) { widestRight = r.right; widest = child; }
    }
    return {
      selector: describe(panel), scrollable, overflowPx,
      heading: ((panel.querySelector('h1,h2,h3') || {}).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      widestChild: widest ? describe(widest) : null,
      widestChildWidth: widest ? round(widest.getBoundingClientRect().width) : null,
      widestChildOverhangPx: widest ? round(widestRight - panelRight) : null,
      panelInnerWidth: round(panel.clientWidth),
    };
  }).filter(entry => !entry.scrollable && entry.overflowPx > 1);

  // text overlap inside key panels: compare rendered text-leaf boxes
  const overlaps = [];
  for (const panel of panels) {
    const leaves = [...panel.querySelectorAll('*')].filter(el => {
      if (!shown(el)) return false;
      if (el.closest('svg')) return false;
      const s = style(el);
      if (s.position === 'fixed' || s.pointerEvents === 'none') return false;
      if (el.getAttribute('aria-hidden') === 'true') return false;
      const own = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (own.length < 2) return false;
      return ![...el.children].some(child => (child.innerText || '').replace(/\s+/g, ' ').trim().length >= 2);
    });
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        const a = leaves[i], b = leaves[j];
        if (a.contains(b) || b.contains(a)) continue;
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (w <= 0.5 || h <= 0.5) continue;
        const area = w * h;
        const smaller = Math.min(ra.width * ra.height, rb.width * rb.height);
        if (smaller <= 0 || area / smaller < 0.2) continue;
        overlaps.push({
          panel: describe(panel), a: describe(a), b: describe(b),
          aText: (a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 48),
          bText: (b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 48),
          overlapPx: round(area), coveredRatio: round(area / smaller),
        });
      }
    }
  }

  return {
    present: true,
    rect: { width: round(containerRect.width), height: round(containerRect.height) },
    visibleTextLength: visibleText.length,
    visibleTextSample: visibleText.slice(0, 160),
    visibleElements: visibleElements.length,
    controls, documentOverflowPx, clippedRightPx, widestSelector, panelCount: panels.length,
    panelOverflow, overlaps,
  };
};

async function measure(page, rootSelector, panelSelector) {
  return page.evaluate(measureInPage, { rootSelector, panelSelector, minTarget: MIN_TARGET });
}

async function screenshot(page, name) {
  const file = path.join(reportDirectory, name + '.png');
  await page.screenshot({ path: file, fullPage: false, animations: 'disabled' });
  return path.relative(root, file);
}

// ---------------------------------------------------------------- screen table

const screens = [
  {
    id: 'nutrition', label: 'Coach → Nutrition', rootSelector: '#view-nutrition', panelSelector: '.card',
    minText: 200,
    required: [{ selector: '.diet-toggle button', count: 4 }, { selector: '.cuisine-chip', count: 4 },
      { selector: '.mi-add', count: 3 }, { selector: '.mi-swap', count: 3 }, { selector: '.icon-btn', count: 2 }, { selector: 'label.photo-btn' }],
    async open(page) {
      await page.evaluate(() => App.goTab('nutrition'));
      await page.locator('#view-nutrition .meal-log').first().waitFor({ timeout: REQUEST_TIMEOUT });
    },
  },
  {
    id: 'search', label: 'Search → discover people', rootSelector: '#view-feed', panelSelector: '.card,.crew-card',
    minText: 120,
    required: [{ selector: '#member-search' }, { selector: '.ssub', count: 4 }, { selector: '.crew-cta .btn', count: 4 }],
    async open(page) {
      await page.evaluate(() => App.selectTab('search'));
      await page.locator('#member-search').waitFor({ timeout: REQUEST_TIMEOUT });
      await page.locator('#view-feed .crew-card').first().waitFor({ timeout: REQUEST_TIMEOUT });
    },
  },
  {
    id: 'alerts', label: 'Alerts → activity notifications', rootSelector: '#view-alerts', panelSelector: '.card,.notif-item',
    minText: 60,
    required: [{ selector: '.notif-item', count: 3 }],
    async open(page) {
      await page.evaluate(() => App.selectTab('alerts'));
      await page.locator('#view-alerts .notif-item').first().waitFor({ timeout: REQUEST_TIMEOUT });
    },
  },
  {
    id: 'dm', label: 'Direct message thread', rootSelector: '#view-feed', panelSelector: '.chat-card',
    minText: 100,
    required: [{ selector: '.ssub', count: 4 }, { selector: '.dm-head .icon-btn', count: 3 }, { selector: '.dm-head-u' },
      { selector: '.bubble [role=button]' }, { selector: '#dm-text' }, { selector: '.send-ico' }],
    async open(page) {
      await page.evaluate(uid => Social.openDM(uid), peer.uid);
      await page.locator('#chat-thread .bubble').first().waitFor({ timeout: REQUEST_TIMEOUT });
    },
  },
  {
    id: 'profile-settings', label: 'Profile → settings and account panels', rootSelector: '#view-profile', panelSelector: '.card',
    minText: 200,
    required: [{ selector: '.ph-logout-ic' }, { selector: '.ph-cover-edit' }, { selector: '.ph-avatar' },
      { selector: '#p-name' }, { selector: '#p-username' }, { selector: '#p-bio' }, { selector: '#p-h' }, { selector: '#p-tw' },
      { selector: '#p-privacy' }, { selector: '.pa', count: 5 }, { selector: '.about-legal a', count: 3 }],
    async open(page) {
      await page.evaluate(() => App.selectTab('profile'));
      await page.locator('#view-profile #p-name').waitFor({ timeout: REQUEST_TIMEOUT });
    },
  },
  {
    id: 'program', label: 'Training program modal (paid)', rootSelector: '#modal-card', panelSelector: '.pg-day,.program',
    minText: 200,
    required: [{ selector: '.pw-tab', count: 4 }, { selector: '.modal-head .icon-btn' }, { selector: '.pg-actions .btn' }],
    async open(page) {
      await page.evaluate(() => App.selectTab('coach'));
      await page.evaluate(() => App.openProgram());
      await page.locator('#modal-card .pg-day').first().waitFor({ timeout: REQUEST_TIMEOUT });
    },
    async close(page) { await page.evaluate(() => App.closeModal()); },
  },
  {
    id: 'progress', label: 'Coach → Progress', rootSelector: '#view-progress', panelSelector: '.card',
    minText: 200,
    required: [{ selector: '.goal-flex .ring' }, { selector: '#w-input' }, { selector: 'button.btn', count: 4 }],
    async open(page) {
      await page.evaluate(() => App.goTab('progress'));
      await page.locator('#view-progress .goal-card').waitFor({ timeout: REQUEST_TIMEOUT });
      await page.locator('#goal-ring svg').waitFor({ timeout: REQUEST_TIMEOUT }).catch(() => {});
    },
  },
];

function addFindings(screen, viewport, result, shot) {
  const findings = [];
  if (result.documentOverflowPx > 1) {
    findings.push({
      id: `${screen.id}-${viewport.name}-doc-overflow`, severity: 'major', screen: screen.id, viewport: viewport.name,
      kind: 'horizontal-overflow', selector: 'document', measurement: { documentOverflowPx: result.documentOverflowPx, widestSelector: result.widestSelector },
      screenshot: shot,
      candidateFix: 'Constrain the widest child (see widestSelector) with min-width:0 on its flex/grid parent, or wrap the offending row; do not add a global overflow-x:hidden that hides the real cause.',
    });
  }
  if (result.clippedRightPx > 1) {
    findings.push({
      id: `${screen.id}-${viewport.name}-clipped`, severity: 'minor', screen: screen.id, viewport: viewport.name,
      kind: 'content-past-viewport', selector: result.widestSelector, measurement: { clippedRightPx: result.clippedRightPx },
      screenshot: shot,
      candidateFix: 'Content extends past the viewport and is clipped by an ancestor overflow rule. Add min-width:0 / flex-wrap to the containing row, or allow the element to wrap.',
    });
  }
  for (const panel of result.panelOverflow) {
    findings.push({
      id: `${screen.id}-${viewport.name}-panel-overflow-${findings.length}`, severity: 'major', screen: screen.id, viewport: viewport.name,
      kind: 'panel-horizontal-overflow', selector: panel.selector, measurement: panel,
      screenshot: shot,
      candidateFix: `Panel "${panel.heading || panel.selector}" has scrollWidth ${panel.overflowPx}px wider than its ${panel.panelInnerWidth}px content box, with no overflow-x scroller, so ${panel.widestChild || 'its widest child'} is cut off. Smallest fix: let that row wrap or track-fit (flex-wrap / grid-template-columns: repeat(auto-fit, minmax(0, 1fr))) and add min-width:0 to its children; do not add overflow-x:hidden, which hides the cut instead of fixing it.`,
    });
  }
  for (const overlap of result.overlaps) {
    findings.push({
      id: `${screen.id}-${viewport.name}-overlap-${findings.length}`, severity: 'major', screen: screen.id, viewport: viewport.name,
      kind: 'text-overlap', selector: `${overlap.a}  ⟷  ${overlap.b}`, measurement: overlap,
      screenshot: shot,
      candidateFix: 'Two rendered text boxes overlap. Move the absolutely positioned element out of the text column or reserve padding on the text element equal to the overlay width.',
    });
  }
  for (const control of result.controls.filter(c => !c.meetsTarget)) {
    const target = result.tapTargets.controls.find(entry => entry.selector === (control.targetSelector || control.selector));
    const exception = target?.exception?.validated ? target.exception : null;
    findings.push({
      id: `${screen.id}-${viewport.name}-target-${findings.length}`, severity: exception ? 'observation' : 'major',
      screen: screen.id, viewport: viewport.name, kind: exception ? 'tap-target-spacing-exception' : 'tap-target-below-44',
      selector: control.targetSelector || control.selector,
      measurement: { width: control.width, height: control.height, label: control.label, primary: control.primary, semantic: control.semantic, measuredOn: control.targetSelector ? 'wrapping label' : 'control itself', spacingException: exception },
      screenshot: shot,
      candidateFix: exception ? 'Keep the measured spacing. This remains below 44px and is recorded as an AA spacing exception, not a repaired 44px target.'
        : 'Give the actual standalone hit area a 44px minimum in both dimensions; check wrapping and flex shrinking without resizing the glyph.',
    });
  }
  for (const control of result.tapTargets.controls) {
    if (!control.meetsTarget && !control.exception?.validated && !findings.some(finding => finding.selector === control.selector)) {
      findings.push({ id: `${screen.id}-${viewport.name}-expanded-target-${findings.length}`, severity: 'major',
        screen: screen.id, viewport: viewport.name, kind: 'tap-target-below-44', selector: control.selector,
        measurement: control, screenshot: shot, candidateFix: 'Enlarge this visible control or upload label to at least 44px in both dimensions.' });
    }
    if (!control.hitTest.passed) findings.push({ id: `${screen.id}-${viewport.name}-hit-${findings.length}`, severity: 'major',
      screen: screen.id, viewport: viewport.name, kind: 'tap-target-obstructed', selector: control.selector,
      measurement: control, screenshot: shot, candidateFix: 'Remove the measured interception or clipping. Fixed navigation must not be silently excluded from hit testing.' });
  }
  for (const overlap of result.tapTargets.overlaps) findings.push({ id: `${screen.id}-${viewport.name}-target-overlap-${findings.length}`, severity: 'major',
    screen: screen.id, viewport: viewport.name, kind: 'tap-target-overlap', selector: overlap.first,
    measurement: overlap, screenshot: shot, candidateFix: 'Separate these independent hit areas in the actual layout.' });
  for (const missing of result.tapTargets.missingRequired) findings.push({ id: `${screen.id}-${viewport.name}-missing-target-${findings.length}`, severity: 'major',
    screen: screen.id, viewport: viewport.name, kind: 'required-target-missing', selector: missing.selector,
    measurement: missing, screenshot: shot, candidateFix: 'Restore the required visible control; hiding it is not a target-size fix.' });
  report.findings.push(...findings);
  return findings;
}

// ---------------------------------------------------------------- audit tests

test('meal alternatives are disabled when the diet has no spare choices', { timeout: 60000 }, async testContext => {
  for (const viewport of viewports) {
    const { page, pageErrors } = await openApp(testContext, viewport);
    await page.evaluate(() => { App.goTab('nutrition'); App.setDiet('vegan'); App.setMealSlot('Lunch'); });
    const unavailable = page.locator('.mi-swap');
    assert.equal(await unavailable.count(), 1);
    assert.equal(await unavailable.isDisabled(), true);
    assert.equal(await unavailable.getAttribute('aria-label'), 'No other meals for this diet');
    await unavailable.scrollIntoViewIfNeeded();
    const appearance = element => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      const points = [center, { x: bounds.left + 3, y: center.y }, { x: bounds.right - 3, y: center.y },
        { x: center.x, y: bounds.top + 3 }, { x: center.x, y: bounds.bottom - 3 }];
      return { width: bounds.width, height: bounds.height, opacity: Number(style.opacity), cursor: style.cursor,
        pointerEvents: style.pointerEvents, color: style.color, borderColor: style.borderColor, transform: style.transform,
        hits: points.map(point => {
          const hit = document.elementFromPoint(point.x, point.y);
          return !!hit && (hit === element || element.contains(hit));
        }) };
    };
    const normal = await unavailable.evaluate(appearance);
    await unavailable.hover();
    await page.evaluate(() => document.getAnimations().forEach(animation => {
      if (animation.effect?.getComputedTiming().iterations !== Infinity) animation.finish();
    }));
    const hovered = await unavailable.evaluate(appearance);
    report.mealAlternatives = (report.mealAlternatives || []).concat([{ viewport: viewport.name, normal, hovered }]);
    assert.deepEqual(hovered, normal, 'Disabled meal swaps must not acquire enabled hover styling');
    assert.equal(normal.opacity, 0.45, 'An unavailable alternative is visibly disabled');
    assert.equal(normal.cursor, 'not-allowed');
    assert.notEqual(normal.pointerEvents, 'none', 'The disabled button still owns its hit area');
    assert.ok(normal.width >= MIN_TARGET && normal.height >= MIN_TARGET);
    assert.ok(normal.hits.every(Boolean), JSON.stringify(normal));
    await page.evaluate(() => App.setDiet('nonveg'));
    const original = await page.locator('.mi-name').first().innerText();
    await page.locator('.mi-swap').first().click();
    assert.notEqual(await page.locator('.mi-name').first().innerText(), original);
    assert.deepEqual(pageErrors, []);
    await page.context().close();
  }
});

test('DEF004 preserves the existing stylesheet budget', () => {
  const cssBytes = fs.readdirSync(path.join(root, 'css'), { recursive: true }).filter(file => file.endsWith('.css'))
    .reduce((total, file) => total + fs.statSync(path.join(root, 'css', file)).size, 0);
  assert.ok(cssBytes <= CSS_BUDGET, `CSS is ${cssBytes}/${CSS_BUDGET} bytes; do not raise or bypass the cap`);
});

for (const viewport of viewports) {
  test(`remaining screens render, fit and expose real targets at ${viewport.name}`, { timeout: 120000 }, async t => {
    const { page, pageErrors, blockedExternal, readiness } = await openApp(t, viewport);
    report.fixtureReadiness = (report.fixtureReadiness || []).concat([{ viewport: viewport.name, ...readiness }]);
    const problems = [];
    const check = (condition, screen, issue, detail) => {
      if (!condition) problems.push({ screen, viewport: viewport.name, issue, detail });
      return condition;
    };
    for (const screen of screens) {
      let opened = true, openError = null;
      try { await screen.open(page); } catch (error) { opened = false; openError = error.message; }
      const shot = opened ? await screenshot(page, `${screen.id}-${viewport.name}`) : null;
      const result = opened ? await measure(page, screen.rootSelector, screen.panelSelector) : { present: false };
      if (opened && result.present) result.tapTargets = await page.evaluate(measureTapTargetsInPage,
        { rootSelector: screen.rootSelector, required: screen.required, minTarget: MIN_TARGET });
      const nativeControls = opened && screen.id === 'profile-settings'
        ? await page.locator('#view-profile select,#view-profile label.photo-btn').evaluateAll(elements => elements.map(element => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return { selector: element.tagName.toLowerCase() + (element.id ? '#' + element.id : '.photo-btn'),
            width: box.width, height: box.height, cssHeight: style.height, minHeight: style.minHeight,
            appearance: style.appearance, fontSize: style.fontSize, padding: style.padding, transform: style.transform };
        })) : [];
      const findings = opened && result.present ? addFindings(screen, viewport, result, shot) : [];
      report.cases.push({
        screen: screen.id, label: screen.label, viewport: viewport.name,
        status: opened && result.present ? 'tested' : 'blocked',
        blockedReason: opened ? (result.present ? null : 'Screen root did not render') : openError,
        screenshot: shot,
        nativeControls,
        tapTargets: result.tapTargets || null,
        measured: opened && result.present ? {
          rect: result.rect, visibleTextLength: result.visibleTextLength, visibleTextSample: result.visibleTextSample,
          visibleElements: result.visibleElements, panelsMeasured: result.panelCount,
          actionableControls: result.controls.length,
          controlsAtOrAbove44: result.controls.filter(c => c.meetsTarget).length,
          controlsBelow44: result.controls.filter(c => !c.meetsTarget).length,
          primaryControls: result.controls.filter(c => c.primary).length,
          documentOverflowPx: result.documentOverflowPx, clippedRightPx: result.clippedRightPx,
          panelOverflowCount: result.panelOverflow.length, textOverlapCount: result.overlaps.length,
        } : null,
        findingIds: findings.map(f => f.id),
      });

      // every screen is measured before asserting, so one defect never hides the rest
      if (!check(opened, screen.id, 'screen-did-not-open', openError)) continue;
      if (!check(result.present, screen.id, 'screen-root-missing', screen.rootSelector)) continue;
      check(result.rect.width > 0 && result.rect.height > 0, screen.id, 'screen-root-has-no-box', result.rect);
      check(result.visibleTextLength >= screen.minText, screen.id, 'insufficient-visible-content',
        { visibleTextLength: result.visibleTextLength, expectedAtLeast: screen.minText });
      check(result.controls.length > 0, screen.id, 'no-visible-actionable-control', null);
      check(result.documentOverflowPx <= 1, screen.id, 'horizontal-overflow',
        { documentOverflowPx: result.documentOverflowPx, widestSelector: result.widestSelector });
      check(result.panelOverflow.length === 0, screen.id, 'key-panel-horizontal-overflow', result.panelOverflow);
      check(result.overlaps.length === 0, screen.id, 'text-overlap-in-key-panel', result.overlaps);
      const smallCommands = result.tapTargets.controls.filter(control => !control.meetsTarget && !control.exception?.validated);
      check(smallCommands.length === 0, screen.id, `standalone-control-below-${MIN_TARGET}px`, smallCommands);
      check(result.tapTargets.controls.length > 0, screen.id, 'no-hit-tested-controls', null);
      check(result.tapTargets.missingRequired.length === 0, screen.id, 'required-controls-not-visible', result.tapTargets.missingRequired);
      check(result.tapTargets.overlaps.length === 0, screen.id, 'overlapping-hit-areas', result.tapTargets.overlaps);
      const blockedHits = result.tapTargets.controls.filter(control => !control.hitTest.passed);
      check(blockedHits.length === 0, screen.id, 'intercepted-or-clipped-hit-area', blockedHits);
      if (screen.id === 'progress') {
        const ring = await page.locator('#view-progress .goal-flex .ring').boundingBox();
        check(ring && ring.width === 130 && ring.height === 130, screen.id, 'DEF003-progress-ring-changed', ring);
      }

      if (screen.close) await screen.close(page);
    }
    check(readiness.ready, 'all', 'fixture-state-not-ready', readiness);
    check(pageErrors.length === 0, 'all', 'uncaught-page-error', pageErrors);
    const nonFontExternal = blockedExternal.filter(entry => !entry.fontAsset);
    check(nonFontExternal.length === 0, 'all', 'external-data-request-attempted', nonFontExternal);
    report.externalRequestsBlocked = (report.externalRequestsBlocked || []).concat(blockedExternal.map(entry => ({ viewport: viewport.name, ...entry })));
    report.viewports.push({ name: viewport.name, width: viewport.width, height: viewport.height, touch: viewport.touch, pageErrors: pageErrors.length });
    assert.equal(problems.length, 0,
      `Measured layout defects at ${viewport.name} (see ${path.relative(root, reportDirectory)}):\n` + JSON.stringify(problems, null, 2));
  });
}

test('back navigation is retained after leaving each deep screen', { timeout: 120000 }, async t => {
  const { page, pageErrors } = await openApp(t, viewports[1]);
  const retained = [];

  // DM thread → back arrow returns to the message inbox, not the feed.
  await page.evaluate(uid => Social.openDM(uid), peer.uid);
  await page.locator('#chat-thread .bubble').first().waitFor({ timeout: REQUEST_TIMEOUT });
  await page.locator('#view-feed .dm-head .icon-btn').first().click();
  await page.locator('#view-feed .dm-list, #view-feed .dm-newrow').first().waitFor({ timeout: REQUEST_TIMEOUT });
  const afterDm = await page.evaluate(() => ({ sub: Social.sub, dmWith: Social._dmWith, tab: App.curTab, heading: (document.querySelector('#view-feed .card-head h2') || {}).innerText || '' }));
  assert.equal(afterDm.dmWith, null, 'Closing a DM must clear the open thread');
  assert.equal(afterDm.sub, 'chat', 'Closing a DM must stay on the Chat inbox, not jump tabs');
  assert.match(afterDm.heading, /Messages/, 'The inbox heading must be visible after leaving the thread');
  retained.push({ path: 'DM thread → inbox', result: afterDm });

  // Program modal → close returns to the same Coach tab and sub-view.
  await page.evaluate(() => App.goTab('progress'));
  await page.locator('#view-progress .goal-card').waitFor({ timeout: REQUEST_TIMEOUT });
  await page.evaluate(() => App.openProgram());
  await page.locator('#modal-card .pg-day').first().waitFor({ timeout: REQUEST_TIMEOUT });
  await page.locator('#modal-card .modal-head .icon-btn').click();
  await page.waitForFunction(() => document.getElementById('modal').classList.contains('hidden'), null, { timeout: REQUEST_TIMEOUT });
  const afterProgram = await page.evaluate(() => ({
    tab: App.curTab, coachSub: App.coachSub,
    progressVisible: getComputedStyle(document.getElementById('view-progress')).display !== 'none',
  }));
  assert.deepEqual(afterProgram, { tab: 'coach', coachSub: 'progress', progressVisible: true },
    'Closing the program modal must return to the screen it was opened from');
  retained.push({ path: 'Program modal → Coach/Progress', result: afterProgram });

  // Alerts → notification deep-links to Search → the Alerts tab still rebuilds its list.
  await page.evaluate(() => App.selectTab('alerts'));
  await page.locator('#view-alerts .notif-item').first().waitFor({ timeout: REQUEST_TIMEOUT });
  await page.evaluate(() => App.openNotif(document.querySelector('#view-alerts .notif-item').getAttribute('onclick').split("'")[1], 'accept'));
  await page.locator('#member-search').waitFor({ timeout: REQUEST_TIMEOUT });
  await page.locator('#tabbar [data-tab="alerts"]').click();
  await page.locator('#view-alerts .notif-item').first().waitFor({ timeout: REQUEST_TIMEOUT });
  const afterAlerts = await page.evaluate(() => ({ tab: App.curTab, items: document.querySelectorAll('#view-alerts .notif-item').length }));
  assert.equal(afterAlerts.tab, 'alerts');
  assert.ok(afterAlerts.items >= 3, 'Returning to Alerts must re-render the activity list');
  retained.push({ path: 'Alerts → Search → Alerts', result: afterAlerts });

  report.backNavigation = retained;
  assert.deepEqual(pageErrors, [], 'Uncaught page errors during back-navigation audit');
});

async function tapControl(page, locator, workflow, edge = 'bottom') {
  await locator.waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT });
  await locator.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
  await locator.click({ trial: true, timeout: REQUEST_TIMEOUT });
  await page.evaluate(() => document.getAnimations().forEach(animation => {
    if (animation.effect?.getComputedTiming().iterations !== Infinity) animation.finish();
  }));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const target = await locator.evaluate((element, edge) => {
    const box = element.getBoundingClientRect();
    const point = { x: box.left + box.width / 2, y: edge === 'top' ? box.top + 3 : box.bottom - 3 };
    const hit = document.elementFromPoint(point.x, point.y);
    const style = getComputedStyle(element);
    const position = { x: box.width / 2 - parseFloat(style.borderLeftWidth),
      y: (edge === 'top' ? 3 : box.height - 3) - parseFloat(style.borderTopWidth) };
    const ancestry = [];
    for (let node = element; node && ancestry.length < 5; node = node.parentElement) {
      const style = getComputedStyle(node);
      const bounds = node.getBoundingClientRect();
      ancestry.push({ selector: node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + '.' + [...node.classList].join('.'),
        top: bounds.top, bottom: bounds.bottom, height: bounds.height, clientHeight: node.clientHeight,
        width: bounds.width, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, scrollLeft: node.scrollLeft,
        scrollHeight: node.scrollHeight, scrollTop: node.scrollTop, minHeight: style.minHeight,
        paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, fontSize: style.fontSize,
        lineHeight: style.lineHeight, transform: style.transform, overflowX: style.overflowX, overflowY: style.overflowY });
    }
    return { label: element.getAttribute('aria-label') || element.getAttribute('title') || element.innerText || element.placeholder,
      width: box.width, height: box.height, point, position, owned: !!hit && (hit === element || element.contains(hit)),
      hit: hit && hit.tagName.toLowerCase() + '.' + [...hit.classList].join('.'), ancestry };
  }, edge);
  (workflow.attempts ||= []).push(target);
  assert.ok(target.width >= MIN_TARGET - 0.01 && target.height >= MIN_TARGET - 0.01, JSON.stringify(target));
  assert.equal(target.owned, true, 'The edge tap must hit its intended control: ' + JSON.stringify(target));
  if (workflow.input === 'touchscreen') await locator.tap({ position: target.position });
  else await locator.click({ position: target.position });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  target.afterDispatch = await page.evaluate(() => ({ tab: App.curTab, coachSub: App.coachSub,
    mealSlot: App.mealSlot, diet: Store.state.profile.diet }));
  workflow.taps.push(target);
}

for (const viewport of viewports) {
  test(`DEF004 enlarged edges dispatch real controls at ${viewport.name}`, { timeout: 90000 }, async testContext => {
    const { page, pageErrors, blockedExternal, readiness, messageWrites } = await openApp(testContext, viewport);
    assert.equal(readiness.ready, true);
    const workflow = { viewport: viewport.name, input: viewport.touch ? 'touchscreen' : 'mouse', status: 'incomplete', taps: [], outcomes: [] };
    report.touchWorkflows = (report.touchWorkflows || []).concat([workflow]);
    const tap = (locator, edge) => tapControl(page, locator, workflow, edge);

    await screens.find(screen => screen.id === 'nutrition').open(page);
    await page.evaluate(() => App.setMealSlot('Breakfast'));
    await tap(page.locator('.diet-toggle').getByRole('button', { name: 'Vegan', exact: true }));
    assert.equal(await page.evaluate(() => Store.state.profile.diet), 'vegan');
    for (const slot of ['Lunch', 'Dinner', 'Breakfast', 'Lunch']) {
      await tap(page.locator('.cuisine-row').getByRole('button', { name: new RegExp('^' + slot + '\\b') }));
      assert.match(await page.locator('.cuisine-chip.active').innerText(), new RegExp('^' + slot + '\\b'));
      const beforeClick = workflow.attempts.at(-1).ancestry.find(ancestor => ancestor.selector === 'div.cuisine-row');
      const scroll = await page.locator('.cuisine-row').evaluate(element => ({
        slot: App.mealSlot, left: element.scrollLeft, width: element.clientWidth, scrollWidth: element.scrollWidth,
        height: element.clientHeight, overflowX: getComputedStyle(element).overflowX,
      }));
      (workflow.cuisineScroll ||= []).push({ beforeClick, afterClick: scroll });
      assert.equal(scroll.slot, slot);
      assert.equal(scroll.overflowX, 'auto', 'Meal choices retain native horizontal scrolling');
      assert.ok(scroll.height >= 64, JSON.stringify(scroll));
      if (viewport.touch && slot === 'Dinner') assert.ok(beforeClick.scrollWidth > beforeClick.clientWidth && beforeClick.scrollLeft > 0,
        'The last mobile meal chip must be revealed by horizontal scrolling');
    }
    await tap(page.locator('.diet-toggle').getByRole('button', { name: 'Non-veg', exact: true }));
    assert.equal(await page.evaluate(() => Store.state.profile.diet), 'nonveg');
    assert.ok(await page.evaluate(() => App.mealPool(App.mealSlot).length > 3), 'Swap fixture must contain spare alternatives');
    const previousMeal = await page.locator('.meal-grid .mi-name').first().innerText();
    await tap(page.locator('.mi-swap').first());
    assert.notEqual(await page.locator('.meal-grid .mi-name').first().innerText(), previousMeal);
    const previousLogs = await page.locator('#view-nutrition .meal-log').count();
    await tap(page.locator('.mi-add').first());
    assert.equal(await page.locator('#view-nutrition .meal-log').count(), previousLogs + 1);
    workflow.outcomes.push('Diet, meal slot, alternative and logged meal changed through edge taps.');

    await screens.find(screen => screen.id === 'search').open(page);
    await tap(page.locator('#member-search'));
    assert.equal(await page.locator('#member-search').evaluate(element => element === document.activeElement), true);
    await page.keyboard.type('No such fixture member');
    await page.waitForFunction(() => document.getElementById('member-search').closest('.card').querySelectorAll('.crew-card').length === 0);
    assert.match(await page.locator('.card:has(#member-search)').innerText(), /No one matches your search/);
    await page.locator('#member-search').fill('Audit Newcomer');
    await page.waitForFunction(() => document.getElementById('member-search').closest('.card').querySelectorAll('.crew-card').length === 1);
    assert.match(await page.locator('.card:has(#member-search) .crew-card').innerText(), /Audit Newcomer/);
    workflow.outcomes.push('The enlarged member input focused and filtered the rendered member list.');

    await screens.find(screen => screen.id === 'dm').open(page);
    await tap(page.locator('.dm-head-u'));
    await page.locator('#modal:not(.hidden) .chat-details').waitFor();
    await tap(page.locator('#modal-card .modal-head .icon-btn'));
    await tap(page.locator('.dm-head-actions [title="Search messages"]'));
    await page.locator('#dm-q').fill('bench');
    assert.equal(await page.locator('#chat-thread .bubble').count(), 1);
    await tap(page.locator('.dm-search .icon-btn'));
    await tap(page.locator('.bubble [role=button]').first());
    await tap(page.getByRole('button', { name: 'Edit', exact: true }));
    await page.waitForFunction(() => document.getElementById('dm-edit')?.value.includes('bench'));
    await tap(page.locator('.chat-input .icon-btn[title="Cancel"]'));
    const message = `DEF004 edge tap ${viewport.name}`;
    await page.locator('#dm-text').fill(message);
    const [sent] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/rest/v1/messages' && response.request().method() === 'POST'),
      tap(page.locator('.send-ico')),
    ]);
    assert.equal(sent.status(), 201);
    assert.ok(messageWrites.some(write => write.body === message && write.to_uid === peer.uid && write.from_uid === member.uid));
    await page.waitForFunction(text => [...document.querySelectorAll('#chat-thread .bubble.me')].some(element => element.innerText.includes(text)), message);
    assert.equal(await page.locator('#dm-text').inputValue(), '');
    const [refreshed] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/rest/v1/messages' && response.request().method() === 'GET'),
      page.evaluate(() => Social.refreshDM()),
    ]);
    assert.ok((await refreshed.json()).some(entry => entry.body === message && entry.from_uid === member.uid));
    await page.waitForFunction(text => [...document.querySelectorAll('#chat-thread .bubble.me')].some(element => element.innerText.includes(text)), message);
    await tap(page.locator('.dm-head > .icon-btn'));
    assert.equal(await page.evaluate(() => Social._dmWith), null);
    assert.equal(await page.evaluate(() => Social.sub), 'chat');
    workflow.outcomes.push('DM details, search, options, edit cancellation, fixture-accepted POST and return to inbox succeeded. No live delivery is claimed.');

    await screens.find(screen => screen.id === 'profile-settings').open(page);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), tap(page.locator('.ph-cover-edit'), 'top')]);
    await chooser.setFiles([]);
    await tap(page.locator('.ph-logout-ic'));
    await page.locator('#sheet-wrap').waitFor();
    assert.equal(await page.evaluate(() => Auth.isLoggedIn()), true);
    await tap(page.getByRole('button', { name: 'Cancel', exact: true }));
    await page.locator('#sheet-wrap').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => Auth.isLoggedIn()), true);
    workflow.outcomes.push('The expanded cover-label edge opened the file chooser; logout opened confirmation and Cancel preserved the session.');

    await screens.find(screen => screen.id === 'program').open(page);
    const phase = await page.locator('.pg-phase').innerText();
    await tap(page.locator('.pw-tab').nth(1));
    assert.equal(await page.locator('.pw-tab.active').innerText(), 'W2');
    assert.notEqual(await page.locator('.pg-phase').innerText(), phase);
    await tap(page.locator('#modal-card .modal-head .icon-btn'));
    await page.waitForFunction(() => document.getElementById('modal').classList.contains('hidden'));
    workflow.outcomes.push('Week 2 changed the rendered program phase and the enlarged close control returned to Coach.');

    await screens.find(screen => screen.id === 'progress').open(page);
    await page.locator('#w-input').fill('80.5');
    await tap(page.locator('#view-progress .food-add .btn'));
    assert.equal(await page.evaluate(() => Store.latestWeight()), 80.5);
    workflow.outcomes.push('Weight logging saved the entered value.');
    workflow.screenshot = await screenshot(page, `def004-edge-taps-${viewport.name}`);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(blockedExternal.filter(entry => !entry.fontAsset), []);
    workflow.status = 'passed';
  });
}

// ---------------------------------------------------------------- report write

function writeReport() {
  report.generatedAt = new Date().toISOString();
  const tested = report.cases.filter(c => c.status === 'tested');
  const blocked = report.cases.filter(c => c.status === 'blocked');
  const tapTargets = tested.flatMap(entry => entry.tapTargets?.controls || []);
  report.spacingExceptions = tested.flatMap(entry => (entry.tapTargets?.controls || []).filter(control => control.exception?.validated)
    .map(control => ({ screen: entry.screen, viewport: entry.viewport, ...control })));
  report.screens = screens.map(screen => {
    const own = report.cases.filter(c => c.screen === screen.id);
    return {
      screen: screen.id, label: screen.label, rootSelector: screen.rootSelector,
      viewportsTested: own.filter(c => c.status === 'tested').map(c => c.viewport),
      viewportsBlocked: own.filter(c => c.status === 'blocked').map(c => ({ viewport: c.viewport, reason: c.blockedReason })),
      findings: report.findings.filter(f => f.screen === screen.id).length,
    };
  });
  report.findingGroups = Object.values(report.findings.reduce((groups, finding) => {
    const leaf = finding.selector.split(' > ').pop();
    const key = `${finding.kind}|${leaf}|${finding.measurement.label || ''}`;
    if (!groups[key]) {
      groups[key] = {
        kind: finding.kind, control: leaf, label: finding.measurement.label || null,
        severity: finding.severity, occurrences: 0, screens: [], viewports: [],
        smallestMeasured: finding.measurement.width != null ? `${finding.measurement.width} x ${finding.measurement.height}` : null,
        exampleScreenshot: finding.screenshot, candidateFix: finding.candidateFix,
      };
    }
    const group = groups[key];
    group.occurrences++;
    if (!group.screens.includes(finding.screen)) group.screens.push(finding.screen);
    if (!group.viewports.includes(finding.viewport)) group.viewports.push(finding.viewport);
    if (finding.severity === 'major') group.severity = 'major';
    return groups;
  }, {})).sort((a, b) => (a.severity === b.severity ? b.occurrences - a.occurrences : a.severity === 'major' ? -1 : 1));
  report.acceptance = {
    screensInScope: screens.length,
    viewportsInScope: viewports.length,
    screenViewportCasesExpected: screens.length * viewports.length,
    screenViewportCasesTested: tested.length,
    screenViewportCasesBlocked: blocked.length,
    uncaughtPageErrors: report.viewports.reduce((sum, v) => sum + v.pageErrors, 0),
    externalRequestsAttempted: (report.externalRequestsBlocked || []).length,
    externalDataRequestsAttempted: (report.externalRequestsBlocked || []).filter(entry => !entry.fontAsset).length,
    actionableControlsMeasured: tested.reduce((sum, c) => sum + c.measured.actionableControls, 0),
    controlsAtOrAbove44: tested.reduce((sum, c) => sum + c.measured.controlsAtOrAbove44, 0),
    controlsBelow44: tested.reduce((sum, c) => sum + c.measured.controlsBelow44, 0),
    expandedTargetsMeasured: tapTargets.length,
    expandedTargetsAtOrAbove44: tapTargets.filter(control => control.meetsTarget).length,
    expandedTargetsBelow44: tapTargets.filter(control => !control.meetsTarget).length,
    validatedSpacingExceptions: report.spacingExceptions.length,
    standaloneTargetsBelow44: tapTargets.filter(control => !control.meetsTarget && !control.exception?.validated).length,
    hitTestFailures: tapTargets.filter(control => !control.hitTest.passed).length,
    overlappingTargetPairs: tested.reduce((sum, entry) => sum + (entry.tapTargets?.overlaps.length || 0), 0),
    missingRequiredControls: tested.reduce((sum, entry) => sum + (entry.tapTargets?.missingRequired.length || 0), 0),
    edgeTapWorkflowsExpected: viewports.length,
    edgeTapWorkflowsPassed: (report.touchWorkflows || []).filter(workflow => workflow.status === 'passed').length,
    edgeTapsDispatched: (report.touchWorkflows || []).reduce((total, workflow) => total + workflow.taps.length, 0),
    stylesheetUnchangedDuringRun: stylesheet.equals(fs.readFileSync(path.join(root, 'css/styles.css'))),
    cssBytes: stylesheet.length,
    cssBudget: CSS_BUDGET,
    horizontalOverflowCases: tested.filter(c => c.measured.documentOverflowPx > 1).length,
    textOverlapCases: tested.filter(c => c.measured.textOverlapCount > 0).length,
    findingsMajor: report.findings.filter(f => f.severity === 'major').length,
    findingsMinor: report.findings.filter(f => f.severity === 'minor').length,
    findingsObservations: report.findings.filter(f => f.severity === 'observation').length,
    distinctFindingGroups: report.findingGroups.length,
    approval: 'none — this file records measurements only; no reviewer, human or release approval is claimed',
  };
  fs.mkdirSync(reportDirectory, { recursive: true });
  fs.writeFileSync(path.join(reportDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}

if (process.env.FORMORA_QA_EXTENDED === '1') {
  require('./qa-ui-ux-probes.cjs')({ test, after, openApp, browserName, root });
}
