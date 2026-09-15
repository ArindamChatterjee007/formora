'use strict';
// Full-app integration probe for the parent's App layer over the two independently accepted
// modules: js/mod/account-rights.js + supabase/account-rights.sql and js/mod/support-receipts.js
// + supabase/support-receipts.sql. The real index.html runs in a browser; every Supabase call is
// answered by the real SQL in PGlite behind a fixture GoTrue that mints signed JWT claims and maps
// the bearer to the database actor. Nothing here proves hosted RLS, grants, staffing, retention or
// any released policy; it only exercises the App wiring the modules were never accepted through.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID, createHmac } = require('node:crypto');
const { chromium } = require('playwright');
const { PGlite } = require('@electric-sql/pglite');

const root = path.resolve(__dirname, '..');
const evidenceDir = path.join(root, 'dist/rights-support');
const ownerA = '11111111-1111-4111-8111-111111111111';
const ownerB = '22222222-2222-4222-8222-222222222222';
const owners = [ownerA, ownerB];
const policyRef = '44444444-4444-4444-8444-444444444444';
// Fixture-only literals. No real credential, key or secret is read, stored or transmitted here.
const secret = 'rights-support-fixture-signing-key';
const passwords = { [ownerA]: 'fixture-password-a', [ownerB]: 'fixture-password-b' };
const emailFor = uid => uid + '@example.test';

const rpcArgs = {
  submit_account_rights_request: ['p_request_id', 'p_kind', 'p_payload'],
  my_account_rights_request: ['p_id'],
  my_account_rights_requests: ['p_before', 'p_before_id', 'p_limit'],
  cancel_account_rights_request: ['p_id', 'p_version', 'p_operation_id'],
  my_account_rights_history: ['p_id', 'p_before_version', 'p_limit'],
  prepare_account_rights_export: ['p_id', 'p_version', 'p_operation_id'],
  read_account_rights_export: ['p_id', 'p_offset', 'p_limit'],
  release_my_account_rights_export: ['p_id', 'p_version', 'p_operation_id'],
  support_settings: [],
  submit_support_case: ['p_request_id', 'p_subject', 'p_body', 'p_evidence'],
  my_support_cases: ['p_before', 'p_before_id'],
  support_thread: ['p_case_id', 'p_before', 'p_before_id'],
  add_support_reply: ['p_case_id', 'p_request_id', 'p_body', 'p_evidence'],
};
const httpFor = { PT401: 401, PT403: 403, PT404: 404, PT409: 409, PT413: 413, PT422: 422, PT429: 429, PT503: 503, 42501: 403, 22023: 400 };
const evidence = { startedAt: new Date().toISOString(), scope: 'Local App-layer integration over real module SQL in PGlite; not hosted RLS, staffing, retention or release approval', cases: [] };
let browser, server, base, db;

const b64url = value => Buffer.from(value).toString('base64url');
function mint(uid, authAgeSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ sub: uid, email: emailFor(uid), role: 'authenticated', exp: now + 3600,
    amr: [{ method: 'password', timestamp: now - authAgeSeconds }] }));
  return header + '.' + claims + '.' + createHmac('sha256', secret).update(header + '.' + claims).digest('base64url');
}
function readToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest('base64url') !== parts[2]) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch (_) { return null; }
  return owners.includes(claims.sub) && claims.exp * 1000 > Date.now() ? claims : null;
}
const sessionFor = (uid, authAgeSeconds = 0) => ({ access_token: mint(uid, authAgeSeconds), refresh_token: 'fixture-refresh',
  token_type: 'bearer', expires_in: 3600, user: { id: uid, email: emailFor(uid), aud: 'authenticated' } });

async function runRpc(name, body, claims) {
  const values = rpcArgs[name].map(key => {
    const value = body?.[key];
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : (value ?? null);
  });
  return db.transaction(async transaction => {
    await transaction.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [claims.sub]);
    await transaction.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims)]);
    await transaction.exec('SET LOCAL ROLE authenticated');
    const placeholders = values.map((_, index) => '$' + (index + 1)).join(',');
    return (await transaction.query('SELECT public.' + name + '(' + placeholders + ') AS result', values)).rows[0].result;
  });
}
async function asService(query, values = []) {
  await db.exec('RESET ROLE');
  await db.exec('SET ROLE service_role');
  try { return (await db.query(query, values)).rows; } finally { await db.exec('RESET ROLE'); }
}
const count = async (table, where = '', values = []) =>
  (await db.query('SELECT count(*)::int AS total FROM public.' + table + (where ? ' WHERE ' + where : ''), values)).rows[0].total;

before(async () => {
  fs.mkdirSync(evidenceDir, { recursive: true });
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
    CREATE TABLE auth.users(id uuid PRIMARY KEY, email text, created_at timestamptz DEFAULT clock_timestamp());
    CREATE TABLE public.accounts(uid text PRIMARY KEY, data jsonb, updated_at timestamptz DEFAULT clock_timestamp());
    CREATE TABLE public.profiles(uid text PRIMARY KEY, data jsonb);
    CREATE TABLE public.report_cases(id uuid PRIMARY KEY, reporter uuid, reported_uid text, reason text);
    CREATE TABLE public.report_evidence_holds(case_id uuid, hold_ref uuid);`);
  await db.exec(fs.readFileSync(path.join(root, 'supabase/account-rights.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(root, 'supabase/support-receipts.sql'), 'utf8'));
  // ~8 KB of owned state so a verified archive is one 32 KB chunk, not a paging soak test.
  const stateA = { profile: { name: 'Owner A', email: emailFor(ownerA), heightCm: 178, weightKg: 69, onboarded: true },
    weightLog: Array.from({ length: 40 }, (_, index) => ({ date: '2026-08-' + String((index % 28) + 1).padStart(2, '0'), kg: 69 + index / 100 })),
    workoutLog: [{ date: '2026-09-01', split: 'push', volume: 4200, exercises: [{ id: 'bench_press', name: 'Bench Press', muscle: 'chest', sets: [{ reps: 8, weight: 60 }] }] }],
    foodLog: [{ date: '2026-09-01', items: [{ id: 'i1', text: 'Owner A private meal note', kcal: 520, protein: 40 }] }], restDays: ['2026-09-02'] };
  await db.query('INSERT INTO auth.users(id,email) VALUES ($1,$2),($3,$4)', [ownerA, emailFor(ownerA), ownerB, emailFor(ownerB)]);
  await db.query('INSERT INTO public.accounts(uid,data) VALUES ($1,$2),($3,$4)',
    [ownerA, JSON.stringify(stateA), ownerB, JSON.stringify({ profile: { name: 'Owner B' }, private: 'untouched-other-account' })]);
  await db.query('INSERT INTO public.profiles(uid,data) VALUES ($1,$2),($3,$4)',
    [ownerA, JSON.stringify({ name: 'Owner A', username: 'owner-a' }), ownerB, JSON.stringify({ name: 'Owner B', bio: 'not-for-export' })]);

  server = http.createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); } catch (_) { response.writeHead(404).end(); return; }
    if (pathname === '/') pathname = '/index.html';
    const allowed = /^\/(index\.html|legal\.html|version\.txt|manifest\.webmanifest)$/.test(pathname)
      || /^\/(js|css|assets|icons)\/[\w/-]+\.(js|css|json|png|svg|jpe?g|webp|ico|woff2)$/.test(pathname);
    const file = path.resolve(root, '.' + pathname);
    if (!allowed || !['GET', 'HEAD'].includes(request.method) || !file.startsWith(root + path.sep)
      || !fs.existsSync(file) || !fs.statSync(file).isFile() || fs.realpathSync(file) !== file) { response.writeHead(404).end(); return; }
    let content = fs.readFileSync(file);
    if (pathname === '/js/config.js') content = Buffer.from(content + `\nObject.assign(window,{SUPABASE_URL:${JSON.stringify(base)},`
      + `SUPABASE_ANON_KEY:'fixture',USE_SUPABASE_AUTH:true,ACCOUNT_RIGHTS:false,SUPPORT_RECEIPTS:false,`
      + `POSTHOG_KEY:'',GOOGLE_CLIENT_ID:'',EMAILJS_PUBLIC_KEY:'',FORMORA_WEB_PUSH:false},window.__fixtureFlags||{});`);
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': { '.js': 'text/javascript', '.css': 'text/css',
      '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream' });
    response.end(content);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await db?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  evidence.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
});

beforeEach(async () => {
  await db.exec('RESET ROLE');
  await db.exec(`TRUNCATE public.account_rights_actions, public.account_rights_exports, public.account_rights_holds,
    public.account_rights_previews, public.account_rights_requests, public.support_case_actions,
    public.support_messages, public.support_cases CASCADE`);
  // Intake open with an operator-recorded approval reference but NO published response time or
  // staffed contact: the app must not invent either one.
  await asService('SELECT public.configure_support_policy($1,$2,$3,$4,$5,$6,$7)', [true, null, null, false, null, false, policyRef]);
});

async function pageFor(context, uid, flags) {
  const browserContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce',
    serviceWorkers: 'block', acceptDownloads: true });
  const fixture = { calls: [], lose: new Set(), hold: null };
  await browserContext.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) return route.abort('blockedbyclient');   // machine-wide network stays out
    const claims = readToken((request.headers().authorization || '').replace(/^Bearer /, ''));
    if (url.pathname === '/auth/v1/token') {
      const grant = url.searchParams.get('grant_type'), body = request.postDataJSON() || {};
      if (grant !== 'password') return route.fulfill({ json: sessionFor(uid, 0) });
      const target = owners.find(owner => emailFor(owner) === String(body.email || '').toLowerCase());
      fixture.calls.push({ name: 'auth:password', owner: target || null, accepted: !!target && body.password === passwords[target] });
      if (!target || body.password !== passwords[target]) return route.fulfill({ status: 401, json: { error: 'invalid_grant', error_description: 'Invalid login credentials' } });
      return route.fulfill({ json: sessionFor(target, 0) });
    }
    if (url.pathname === '/auth/v1/user') {
      return claims ? route.fulfill({ json: { id: claims.sub, email: claims.email, aud: 'authenticated' } })
        : route.fulfill({ status: 401, json: { message: 'Invalid fixture bearer' } });
    }
    if (url.pathname.startsWith('/auth/v1/')) return route.fulfill({ json: {} });
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.slice('/rest/v1/rpc/'.length);
      if (name === 'get_state') return route.fulfill({ json: { users: {}, posts: {}, requests: {}, comments: {}, stories: {} } });
      if (!Object.hasOwn(rpcArgs, name)) return route.fulfill({ json: {} });
      if (request.headers().apikey !== 'fixture' || !claims) return route.fulfill({ status: 401, json: { message: 'Invalid fixture bearer' } });
      const body = request.postDataJSON() || {};
      fixture.calls.push({ name, owner: claims.sub, body });
      let result;
      try { result = await runRpc(name, body, claims); }
      catch (error) { return route.fulfill({ status: httpFor[error.code] || 400, json: { message: error.message, code: error.code } }); }
      if (fixture.lose.has(name)) { fixture.lose.delete(name); return route.abort('internetdisconnected'); }
      if (fixture.hold?.name === name) { const hold = fixture.hold; fixture.hold = null; hold.started(); await hold.wait; }
      try { await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result ?? null) }); } catch (_) {}
      return;
    }
    if (url.pathname.startsWith('/rest/v1/')) {
      fixture.calls.push({ name: 'rest:' + url.pathname, method: request.method() });
      return route.fulfill({ status: request.method() === 'GET' ? 200 : 201, contentType: 'application/json', body: '[]' });
    }
    return route.continue();
  });
  await browserContext.addInitScript(([owner, token, pageFlags]) => {
    window.__fixtureFlags = pageFlags;
    if (localStorage.getItem('fixture')) return;
    localStorage.setItem('fixture', '1'); localStorage.setItem('fm_dl_x', '1');
    localStorage.setItem('formora_supa_session', JSON.stringify({ uid: owner, email: owner + '@example.test',
      access_token: token, refresh_token: 'fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600 }));
    localStorage.setItem('gymcoach_auth', JSON.stringify({ accounts: [{ id: owner, email: owner + '@example.test',
      name: 'Fixture Owner', emailVerified: true, provider: 'supabase' }], currentUserId: owner }));
    localStorage.setItem('gymcoach_v1_' + owner, JSON.stringify({ profile: { name: 'Fixture Owner',
      email: owner + '@example.test', username: 'fixture', onboarded: true }, workoutLog: [], foodLog: [], weightLog: [], restDays: [] }));
    // The seeded session carries a stale amr claim: erasure must require a fresh reauthentication.
  }, [uid, mint(uid, 3600), flags]);
  const page = await browserContext.newPage(), errors = [];
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  context.after(async () => { await browserContext.close(); assert.deepEqual(errors, []); });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('#app-shell:not(.hidden)').waitFor();
  await page.locator('#tabbar [data-tab="profile"]').click();
  await page.locator('.about-card').waitFor();
  return { page, fixture, errors };
}

const rightsButton = page => page.locator('.about-card').getByRole('button', { name: 'Account rights', exact: true });
const supportButton = page => page.locator('.about-card').getByRole('button', { name: /Help & support/ });
const named = (fixture, name) => fixture.calls.filter(call => call.name === name);
async function shot(page, name) {
  const file = path.join(evidenceDir, name + '.png');
  await page.screenshot({ path: file });
  return path.relative(root, file);
}
function record(name, data) { evidence.cases.push({ name, at: new Date().toISOString(), ...data }); }

test('default flags keep both surfaces off and send no rights or support request', { timeout: 30000 }, async context => {
  const { page, fixture } = await pageFor(context, ownerA, {});
  assert.equal(await rightsButton(page).count(), 0);
  await supportButton(page).click();
  const support = page.locator('.support');
  await support.waitFor();
  assert.equal(await support.getByRole('button', { name: /Your support requests/ }).count(), 0);
  assert.match(await support.locator('.sp-lead').innerText(), /response times vary/i);
  assert.deepEqual(await page.evaluate(async () => {
    App.closeModal();
    await App.openAccountRights();
    App.openSupportReceipts();
    return { rights: document.querySelectorAll('.account-rights').length, instance: !!App._accountRights,
      receipts: document.querySelectorAll('#support-content').length,
      open: !document.getElementById('modal').classList.contains('hidden'),
      toast: document.getElementById('toast')?.textContent || '' };
  }), { rights: 0, instance: false, receipts: 0, open: false, toast: 'Support receipts are unavailable.' });
  const reached = fixture.calls.filter(call => Object.hasOwn(rpcArgs, call.name) || call.name === 'rest:/rest/v1/support_tickets');
  assert.deepEqual(reached, []);
  record('flags-off-control', { rightsButtons: 0, receiptButtons: 0, moduleCalls: 0, screenshot: await shot(page, 'flags-off-support') });
});

test('the Account rights control opens the module against real SQL and records an owned export receipt', { timeout: 30000 }, async context => {
  const { page, fixture } = await pageFor(context, ownerA, { ACCOUNT_RIGHTS: true, SUPPORT_RECEIPTS: true });
  await rightsButton(page).click();
  await page.locator('.account-rights').waitFor();
  await page.getByRole('button', { name: 'Request export', exact: true }).click();
  await page.locator('.account-rights [role="status"]').getByText(/Request received\. Reference/).waitFor();
  const rows = (await db.query('SELECT id, owner_id, kind, status, version FROM public.account_rights_requests')).rows;
  assert.equal(rows.length, 1);
  assert.deepEqual({ owner_id: rows[0].owner_id, kind: rows[0].kind, status: rows[0].status, version: rows[0].version },
    { owner_id: ownerA, kind: 'export', status: 'received', version: 1 });
  await page.locator('.account-rights section[data-request-id="' + rows[0].id + '"]').waitFor();
  const panel = await page.locator('.account-rights').innerText();
  assert.match(panel, /Request received does not mean account deleted/);
  assert.equal(await page.evaluate(() => document.getElementById('app-shell').inert), true);

  await page.getByRole('button', { name: 'Contact support', exact: true }).click();
  await page.locator('.support').waitFor();
  assert.equal(await page.locator('.account-rights').count(), 0);
  const lead = await page.locator('.sp-lead').innerText();
  assert.doesNotMatch(lead, /founder-operated|response times vary/i);
  await page.getByRole('button', { name: /Your support requests/ }).click();
  await page.getByText("You haven't sent a support request yet.", { exact: true }).waitFor();
  const receipts = await page.locator('#support-content').innerText();
  assert.equal(await page.locator('#support-note').count(), 0);
  assert.doesNotMatch(receipts, /within|hours|guarantee|24|SLA/i);
  record('rights-and-support-open', { requestId: rows[0].id, settingsPublished: (await db.query('SELECT response_expectation, contact_channel FROM public.support_policy')).rows[0],
    rightsCalls: named(fixture, 'submit_account_rights_request').length, screenshot: await shot(page, 'rights-panel') });
});

test('an owner downloads a verified archive of only their own account data', { timeout: 30000 }, async context => {
  const { page, fixture } = await pageFor(context, ownerA, { ACCOUNT_RIGHTS: true });
  await rightsButton(page).click();
  await page.getByRole('button', { name: 'Request export', exact: true }).click();
  await page.locator('.account-rights section[data-request-id]').waitFor();
  const requestId = await page.locator('.account-rights section[data-request-id]').first().getAttribute('data-request-id');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download export', exact: true }).click(),
  ]);
  assert.equal(download.suggestedFilename(), 'formora-account-' + requestId + '.json');
  const saved = path.join(evidenceDir, 'export-owner-a.json');
  await download.saveAs(saved);
  const text = fs.readFileSync(saved, 'utf8'), archive = JSON.parse(text);
  assert.equal(archive.requester, ownerA);
  assert.equal(archive.request_ref, requestId);
  assert.equal(archive.data.identity.id, ownerA);
  assert.equal(archive.data.account.state.profile.name, 'Owner A');
  assert.equal(archive.data.account.state.weightLog.length, 40);
  assert.equal(archive.data.account.state.foodLog[0].items[0].text, 'Owner A private meal note');
  assert.equal(text.includes(ownerB), false);
  assert.equal(/untouched-other-account|not-for-export/.test(text), false);
  const stored = (await db.query('SELECT total_bytes, sha256 FROM public.account_rights_exports WHERE request_ref=$1', [requestId])).rows[0];
  assert.equal(stored.total_bytes, Buffer.byteLength(text));
  assert.equal(named(fixture, 'read_account_rights_export').length, 1);   // one 32 KB chunk, not a paging soak
  await page.locator('.account-rights [role="status"]').getByText('Verified archive download started.').waitFor();
  record('owner-export-download', { requestId, bytes: stored.total_bytes, sha256: stored.sha256,
    chunks: 1, savedTo: path.relative(root, saved), screenshot: await shot(page, 'rights-export-ready') });
});

test('erasure needs a confirmed password reauthentication and records a request, not a deletion', { timeout: 30000 }, async context => {
  const { page, fixture } = await pageFor(context, ownerA, { ACCOUNT_RIGHTS: true });
  await rightsButton(page).click();
  await page.getByRole('button', { name: 'Request erasure', exact: true }).click();
  await page.locator('#rights-password').waitFor();
  await page.locator('#rights-password').fill('not-the-password');
  await page.getByRole('button', { name: /Confirm sign-in/ }).click();
  await page.waitForFunction(() => (document.getElementById('rights-auth-error')?.textContent || '').length > 0);
  const refusal = await page.locator('#rights-auth-error').innerText();
  assert.equal(await page.locator('#rights-password').inputValue(), '');
  assert.equal(await page.locator('.account-rights-reauth').count(), 1);   // the form is kept, not thrown away
  assert.equal(await count('account_rights_requests'), 0);
  assert.deepEqual(named(fixture, 'submit_account_rights_request'), []);

  await page.locator('#rights-password').fill(passwords[ownerA]);
  await page.getByRole('button', { name: /Confirm sign-in/ }).click();
  await page.locator('.account-rights input[type="checkbox"]').waitFor();
  assert.equal(await page.locator('.account-rights-reauth').count(), 0);
  await page.locator('.account-rights input[type="checkbox"]').check();
  await page.getByRole('button', { name: 'Confirm erasure request', exact: true }).click();
  await page.locator('.account-rights [role="status"]').getByText(/Account erasure has not been executed/).waitFor();
  const erasure = (await db.query("SELECT owner_id, kind, status FROM public.account_rights_requests WHERE kind='erasure'")).rows;
  assert.deepEqual(erasure, [{ owner_id: ownerA, kind: 'erasure', status: 'received' }]);
  assert.equal(await count('accounts', 'uid=$1', [ownerA]), 1);
  assert.equal(await count('profiles', 'uid=$1', [ownerA]), 1);
  assert.equal(await count('accounts', 'uid=$1', [ownerB]), 1);
  assert.equal((await db.query('SELECT count(*)::int AS total FROM auth.users')).rows[0].total, 2);
  record('erasure-reauth', { wrongPasswordMessage: refusal, submittedAfterWrongPassword: 0,
    passwordAttempts: named(fixture, 'auth:password').map(call => call.accepted), status: erasure[0].status,
    accountRowsIntact: true, screenshot: await shot(page, 'rights-erasure-received') });
});

test('a different signed-in account can neither see nor download the first owner export', { timeout: 30000 }, async context => {
  const first = await pageFor(context, ownerA, { ACCOUNT_RIGHTS: true });
  await rightsButton(first.page).click();
  await first.page.getByRole('button', { name: 'Request export', exact: true }).click();
  await first.page.locator('.account-rights section[data-request-id]').waitFor();
  const requestId = await first.page.locator('.account-rights section[data-request-id]').first().getAttribute('data-request-id');
  await Promise.all([first.page.waitForEvent('download'), first.page.getByRole('button', { name: 'Download export', exact: true }).click()]);

  const second = await pageFor(context, ownerB, { ACCOUNT_RIGHTS: true });
  await rightsButton(second.page).click();
  await second.page.getByText('No requests yet.', { exact: true }).waitFor();
  assert.equal(await second.page.getByRole('button', { name: 'Download export', exact: true }).count(), 0);
  const denied = await second.page.evaluate(async id => {
    const attempt = async run => { try { await run(); return 'unexpected-success'; } catch (error) { return error.message; } };
    return { download: await attempt(() => App._accountRights.downloadExport(id)),
      read: await attempt(() => App._accountRights.getRequest(id)) };
  }, requestId);
  assert.equal(denied.download, 'This request is unavailable.');
  assert.equal(denied.read, 'This request is unavailable.');
  assert.equal(await count('account_rights_requests', 'owner_id=$1', [ownerB]), 0);
  assert.equal(await count('account_rights_exports'), 1);
  // the client stops at the ownership check, so no byte of another owner's archive is ever requested
  assert.deepEqual(named(second.fixture, 'read_account_rights_export'), []);
  assert.deepEqual(named(second.fixture, 'prepare_account_rights_export'), []);
  assert.equal((await db.query('SELECT status FROM public.account_rights_requests WHERE id=$1', [requestId])).rows[0].status, 'export_ready');
  record('cross-account-denial', { requestId, deniedMessages: denied, otherOwnerRequests: 0, screenshot: await shot(second.page, 'rights-other-owner') });
});

test('closing during a stalled export chunk stops the client and restores the page', { timeout: 30000 }, async context => {
  const { page, fixture } = await pageFor(context, ownerA, { ACCOUNT_RIGHTS: true });
  await rightsButton(page).click();
  await page.getByRole('button', { name: 'Request export', exact: true }).click();
  await page.locator('.account-rights section[data-request-id]').waitFor();
  const requestId = await page.locator('.account-rights section[data-request-id]').first().getAttribute('data-request-id');
  let release, started;
  const reached = new Promise(resolve => { started = resolve; });
  fixture.hold = { name: 'read_account_rights_export', started, wait: new Promise(resolve => { release = resolve; }) };
  await page.getByRole('button', { name: 'Download export', exact: true }).click();
  await reached;
  await page.locator('.account-rights').getByRole('button', { name: 'Close', exact: true }).click();
  release();
  await page.waitForFunction(() => document.getElementById('modal').classList.contains('hidden'));
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#modal-card').innerHTML(), '');
  assert.equal(await page.locator('.account-rights').count(), 0);
  assert.deepEqual(await page.evaluate(() => ({ inert: document.getElementById('app-shell').inert,
    hidden: document.getElementById('app-shell').getAttribute('aria-hidden'),
    focused: document.activeElement?.textContent?.trim() || '' })),
    { inert: false, hidden: null, focused: 'Account rights' });
  assert.equal((await db.query('SELECT status FROM public.account_rights_requests WHERE id=$1', [requestId])).rows[0].status, 'export_ready');
  record('cancel-during-stalled-chunk', { requestId, cardCleared: true, focusReturnedTo: 'Account rights',
    serverStatus: 'export_ready', screenshot: await shot(page, 'rights-cancelled') });
});

test('a lost support acknowledgement never duplicates a case and never falls back to the legacy table', { timeout: 30000 }, async context => {
  const { page, fixture } = await pageFor(context, ownerA, { SUPPORT_RECEIPTS: true });
  const subject = 'Payment not unlocked', message = 'I paid but Pro is still missing.';
  await supportButton(page).click();
  await page.locator('#sp-subj').fill(subject);
  await page.locator('#sp-msg').fill(message);
  fixture.lose.add('submit_support_case');
  await page.locator('#sp-send').click();
  await page.waitForFunction(() => (document.getElementById('toast')?.textContent || '').includes("Couldn't confirm"));
  assert.equal(await page.locator('#sp-msg').inputValue(), message);   // the draft survives an unconfirmed write
  assert.equal(await page.locator('#modal').isVisible(), true);
  assert.equal(await count('support_cases'), 1);   // written server-side, acknowledgement lost

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#app-shell:not(.hidden)').waitFor();
  await page.locator('#tabbar [data-tab="profile"]').click();
  await supportButton(page).click();
  await page.locator('#sp-subj').fill(subject);
  await page.locator('#sp-msg').fill(message);
  const before = named(fixture, 'submit_support_case').length;
  await page.evaluate(() => { App.submitTicket(); App.submitTicket(); });   // exactly one in-flight submit per owner
  await page.waitForFunction(() => (document.getElementById('toast')?.textContent || '').startsWith('Support request received'));
  assert.equal(named(fixture, 'submit_support_case').length - before, 1);
  assert.equal(await count('support_cases'), 1);
  assert.equal(await count('support_messages'), 1);
  assert.deepEqual(fixture.calls.filter(call => call.name.includes('support_tickets')), []);
  const caseRow = (await db.query('SELECT id, owner, status FROM public.support_cases')).rows[0];
  assert.equal(caseRow.owner, ownerA);

  await supportButton(page).click();
  await page.getByRole('button', { name: /Your support requests/ }).click();
  await page.locator('#support-content [data-support-id="' + caseRow.id + '"]').waitFor();
  assert.match(await page.locator('#support-content').innerText(), new RegExp('Reference ' + caseRow.id));
  assert.equal(await page.locator('#support-note').count(), 0);
  assert.deepEqual(await page.evaluate(() => { App.closeModal(); return { rows: SupportReceipts._rows.length, card: document.getElementById('modal-card').innerHTML }; }),
    { rows: 0, card: '' });
  record('support-lost-acknowledgement', { caseId: caseRow.id, cases: 1, messages: 1, legacyWrites: 0,
    submitCalls: named(fixture, 'submit_support_case').length, screenshot: await shot(page, 'support-receipts') });
});

test('signing out resets both modules and leaves no queued module traffic', { timeout: 30000 }, async context => {
  const { page, fixture } = await pageFor(context, ownerA, { ACCOUNT_RIGHTS: true, SUPPORT_RECEIPTS: true });
  await rightsButton(page).click();
  await page.getByRole('button', { name: 'Request export', exact: true }).click();
  await page.locator('.account-rights section[data-request-id]').waitFor();
  await page.evaluate(() => App.closeModal());
  await supportButton(page).click();
  await page.locator('#sp-subj').fill('Signed out mid-thread');
  await page.locator('#sp-msg').fill('Checking that logging out clears private state.');
  await page.locator('#sp-send').click();
  await page.waitForFunction(() => (document.getElementById('toast')?.textContent || '').startsWith('Support request received'));

  const mark = fixture.calls.length;
  const after = await page.evaluate(() => {
    App.logout();
    const card = document.getElementById('modal-card');
    return { rightsOwner: App._accountRights.owner(), rows: SupportReceipts._rows.length,
      retryKeys: Object.keys(localStorage).filter(key => key.startsWith('fm_support_')),
      modalHidden: document.getElementById('modal').classList.contains('hidden'),
      uid: SupaAuth.uid(),
      // the App-rendered support form is not owned by either module: measure what it still holds
      staleForm: { subject: document.getElementById('sp-subj')?.value ?? null, message: document.getElementById('sp-msg')?.value ?? null },
      staleCardBytes: card.innerHTML.length };
  });
  await page.waitForTimeout(500);
  assert.deepEqual({ rightsOwner: after.rightsOwner, rows: after.rows, retryKeys: after.retryKeys, modalHidden: after.modalHidden, uid: after.uid },
    { rightsOwner: '', rows: 0, retryKeys: [], modalHidden: true, uid: '' });
  assert.deepEqual(after.staleForm, { subject: null, message: null });
  assert.equal(after.staleCardBytes, 0);
  await page.locator('#auth-overlay:not(.hidden)').waitFor();
  assert.deepEqual(fixture.calls.slice(mark).filter(call => Object.hasOwn(rpcArgs, call.name)), []);
  const caseId = (await db.query('SELECT id FROM public.support_cases')).rows[0].id;
  assert.equal((await page.locator('#modal-card').innerHTML()).includes(caseId), false);
  assert.equal(await count('support_cases'), 1);
  assert.equal(await count('account_rights_requests'), 1);
  record('logout-reset', { queuedModuleCallsAfterLogout: 0, retainedRetryKeys: 0, serverReferenceInStaleCard: false,
    staleSupportForm: after.staleForm, staleCardBytes: after.staleCardBytes, screenshot: await shot(page, 'logout-clean') });
});
