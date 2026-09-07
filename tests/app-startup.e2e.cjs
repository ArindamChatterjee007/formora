'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
let server, browser, origin;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const profile = { name: 'Startup tester', email: 'member@example.test', username: 'startup_test', onboarded: true, gender: 'male', dob: '1995-01-01', age: 31, heightCm: 178, startWeightKg: 80, targetWeightKg: 78, activityFactor: 1.55, physique: 'lean_aesthetic', physiqueChosen: true, unit: 'kg', diet: 'veg', tier: 'elite' };
const accountState = { profile, weightLog: [{ date: '2026-09-05', kg: 80 }], workoutLog: [], foodLog: [], restDays: [], updatedAt: 1 };

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch (_) { res.writeHead(404).end(); return; }
    if (pathname === '/') pathname = '/index.html';
    const allowed = /^\/(index\.html|legal\.html|version\.txt|manifest\.webmanifest|favicon\.ico)$/.test(pathname)
      || /^\/(js|css|assets|icons)\/[a-zA-Z0-9_/-]+\.(js|css|json|png|jpe?g|webp|gif|svg|ico|woff2|mp4|webm|mp3)$/.test(pathname);
    const file = path.resolve(root, '.' + pathname);
    if (!allowed || !file.startsWith(root + path.sep) || !['GET', 'HEAD'].includes(req.method) || !fs.existsSync(file) || !fs.statSync(file).isFile() || fs.realpathSync(file) !== file) { res.writeHead(404).end(); return; }
    const ext = path.extname(file);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.txt': 'text/plain' }[ext] || 'application/octet-stream';
    let body = fs.readFileSync(file);
    if (file.endsWith('/js/config.js')) body = Buffer.from(body.toString() + `\nwindow.SUPABASE_URL=${JSON.stringify(origin)};window.SUPABASE_ANON_KEY="fixture-public";window.GOOGLE_CLIENT_ID="";window.POSTHOG_KEY="";window.EMAILJS_PUBLIC_KEY="";`);
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.OFFICE_BROWSER_EXECUTABLE || undefined });
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(done => server.close(done));
});

test('startup asset server never exposes workspace metadata, backups or traversal paths', async () => {
  for (const pathname of ['/.git/config', '/.env', '/backups/data.json', '/package.json', '/office/board.json', '/tests/auth-session.test.cjs', '/js/%2e%2e/.git/config']) {
    const response = await fetch(origin + pathname);
    assert.equal(response.status, 404, pathname);
  }
  assert.equal((await fetch(origin + '/index.html')).status, 200);
});

async function setup(t, { localProfile = true, expired = true, viewport = { width: 390, height: 844 } } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', hasTouch: true });
  const state = { uid: 'member-A', token: 'fresh-A', tier: 'elite', membershipStatus: 200, accountStatus: 200, accountRecord: accountState, refreshStatus: 200, refreshCalls: 0, reads: [], writes: [], notifs: [], notifGate: null, refreshGate: null, membershipGate: null, accountGate: null, refreshSeen: deferred(), membershipSeen: deferred(), accountSeen: deferred(), notifSeen: deferred() };
  Object.assign(state, { posts: [], comments: [], reports: [], actionStatus: 200, actionGate: null, actionSeen: deferred() });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) { await route.abort('blockedbyclient'); return; }
    if (url.pathname.startsWith('/auth/v1/')) {
      if (url.searchParams.get('grant_type') === 'refresh_token') {
        state.refreshCalls++; state.refreshSeen.resolve();
        if (state.refreshGate) await state.refreshGate.promise;
      }
      await route.fulfill({ status: url.searchParams.get('grant_type') === 'refresh_token' ? state.refreshStatus : 200, json: { access_token: state.token, refresh_token: 'fixture-refresh', expires_in: 3600, user: { id: state.uid, email: state.uid === 'member-A' ? 'member@example.test' : 'free@example.test' } } });
      return;
    }
    if (url.pathname.startsWith('/rest/v1/')) {
      state.reads.push({ path: url.pathname, query: url.search, authorization: req.headers().authorization });
      if (req.method() !== 'GET') state.writes.push({ path: url.pathname, method: req.method(), body: req.postData() ? req.postDataJSON() : null });
      if (url.pathname.endsWith('/entitlements')) {
        const membershipStatus = state.membershipStatus, tier = state.tier;
        state.membershipSeen.resolve();
        if (state.membershipGate) await state.membershipGate.promise;
        await route.fulfill({ status: membershipStatus, json: membershipStatus === 200 ? [{ tier, status: 'active', current_period_end: '2099-01-01T00:00:00Z' }] : { error: 'fixture_failure' } });
      } else if (url.pathname.endsWith('/accounts') && req.method() === 'GET') {
        const records = state.uid === 'member-A' ? [{ data: state.accountRecord }] : [];
        state.accountSeen.resolve();
        if (state.accountGate) await state.accountGate.promise;
        await route.fulfill({ status: state.accountStatus, json: state.accountStatus === 200 ? records : { error: 'fixture_account_failure' } });
      } else if (url.pathname.endsWith('/notifications') && req.method() === 'GET') {
        const records = structuredClone(state.notifs);
        state.notifSeen.resolve();
        if (state.notifGate) await state.notifGate.promise;
        await route.fulfill({ json: records });
      } else if (url.pathname.endsWith('/rpc/get_state')) {
        await route.fulfill({ json: { users: { 'member-B': { uid: 'member-B', name: 'Other member', username: 'other_member', privacy: 'public' } }, requests: {}, posts: Object.fromEntries(state.posts.map(post => [post.id, post])), comments: Object.fromEntries(state.comments.map(comment => [comment.id, comment])), stories: {} } });
      } else if (['PATCH', 'DELETE'].includes(req.method()) && /\/(posts|comments)$/.test(url.pathname)) {
        const collection = url.pathname.endsWith('/posts') ? 'posts' : 'comments';
        const id = url.searchParams.get('id')?.replace(/^eq\./, '');
        const owner = url.searchParams.get('author')?.replace(/^eq\./, '');
        const record = state[collection].find(item => item.id === id && item.author === owner);
        const status = state.actionStatus;
        state.actionSeen.resolve();
        if (state.actionGate) await state.actionGate.promise;
        if (status !== 200) await route.fulfill({ status, json: { error: 'fixture_action_denied' } });
        else {
          if (record && req.method() === 'DELETE') state[collection] = state[collection].filter(item => item !== record);
          if (record && req.method() === 'PATCH') Object.assign(record, req.postDataJSON().data);
          await route.fulfill({ json: record ? [{ id }] : [] });
        }
      } else if (url.pathname.endsWith('/content_reports') && req.method() === 'POST') {
        const status = state.actionStatus, report = req.postDataJSON();
        state.actionSeen.resolve();
        if (state.actionGate) await state.actionGate.promise;
        if (status === 200) state.reports.push(report);
        await route.fulfill({ status: status === 200 ? 201 : status, body: '' });
      } else await route.fulfill({ json: [] });
      return;
    }
    await route.continue();
  });
  await context.addInitScript(({ stored, localProfile, expired }) => {
    if (!localStorage.getItem('fixture-seeded')) {
    localStorage.setItem('formora_supa_session', JSON.stringify({ uid: 'member-A', email: 'member@example.test', access_token: expired ? 'expired-A' : 'fresh-A', refresh_token: 'fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + (expired ? -60 : 3600) }));
    localStorage.setItem('gymcoach_auth', JSON.stringify({ accounts: [{ id: 'local-A', email: 'member@example.test', name: 'Startup tester', provider: 'email', emailVerified: true }], currentUserId: 'local-A' }));
    if (localProfile) localStorage.setItem('gymcoach_v1_local-A', JSON.stringify(stored));
    localStorage.setItem('fm_dl_x', '1');
    localStorage.setItem('fm_tier', 'elite');
    localStorage.setItem('fixture-seeded', '1');
    }
    window.firstVisibleTiers = [];
    document.addEventListener('DOMContentLoaded', () => {
      const shell = document.getElementById('app-shell');
      new MutationObserver(() => {
        if (!shell.classList.contains('hidden')) window.firstVisibleTiers.push(document.documentElement.getAttribute('data-tier'));
      }).observe(shell, { attributes: true, attributeFilter: ['class'] });
    });
  }, { stored: accountState, localProfile, expired });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(8000);
  page.on('pageerror', e => errors.push(e.message));
  t.after(async () => { await context.close(); assert.deepEqual(errors, [], 'No unexpected app exceptions'); });
  return { page, state };
}

async function signInFree(page, state) {
  state.uid = 'member-B'; state.token = 'fresh-B'; state.tier = 'free';
  await page.evaluate(async () => {
    await SupaAuth.login('free@example.test', 'fixture-password');
    Auth.supabaseSignIn({ email: 'free@example.test', name: 'Free tester' });
    const user = Auth.currentUser();
    Store.load('gymcoach_v1_' + user.id);
    Object.assign(Store.state.profile, { onboarded: true, username: 'free_tester', name: 'Free tester' });
    Store.save();
    await App.enterApp();
  });
}

async function screenshot(page, name) {
  if (!process.env.APP_QA_SCREENSHOTS) return;
  fs.mkdirSync(process.env.APP_QA_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: path.join(process.env.APP_QA_SCREENSHOTS, name + '.png'), fullPage: false, animations: 'disabled' });
}

function socialRecords(state) {
  state.posts = [
    { id: 'post-1', author: 'member-A', text: 'Original caption', privacy: 'public', gradient: ['#ef6548', '#ba4352'], likes: {}, ts: Date.now() },
    { id: 'post-2', author: 'member-B', text: 'Another member post', privacy: 'public', gradient: ['#306960', '#234d75'], likes: {}, ts: Date.now() - 1000 }
  ];
  state.comments = [
    { id: 'comment-1', post_id: 'post-1', author: 'member-A', body: 'Parent comment', ts: Date.now() },
    { id: 'reply-1', post_id: 'post-1', author: 'member-B', parent_id: 'comment-1', body: 'Surviving reply', ts: Date.now() + 1 }
  ];
}

async function postMenu(page, id, label) {
  await page.locator(`#view-feed button[onclick="Social.postMenu('${id}')"]`).click();
  await page.locator('#sheet-wrap').getByRole('button', { name: label, exact: true }).click();
}

test('social UI keeps caption drafts and posts until acknowledged and persists the fixture result on reload', async t => {
  const { page, state } = await setup(t, { expired: false });
  socialRecords(state);
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.locator('#view-feed .post').first().waitFor();
  await postMenu(page, 'post-1', 'Edit caption');
  await page.locator('#edit-cap').fill('Saved through the real editor');
  state.actionStatus = 403;
  await page.locator('#edit-cap-save').click();
  await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Could not update caption'));
  assert.equal(await page.locator('#edit-cap').inputValue(), 'Saved through the real editor');
  assert.equal(state.posts[0].text, 'Original caption');
  state.actionStatus = 200; state.actionGate = deferred(); state.actionSeen = deferred();
  await page.locator('#edit-cap-save').click();
  await state.actionSeen.promise;
  assert.equal(await page.locator('#edit-cap-save').isDisabled(), true);
  assert.equal(state.posts[0].text, 'Original caption');
  state.actionGate.resolve();
  await page.locator('#modal').waitFor({ state: 'hidden' });
  assert.equal(state.posts[0].text, 'Saved through the real editor');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('Saved through the real editor', { exact: true }).waitFor();
  state.actionGate = null; state.actionStatus = 500;
  page.once('dialog', dialog => dialog.accept());
  await postMenu(page, 'post-1', 'Delete post');
  await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Could not delete post'));
  assert.equal(state.posts.length, 2);
  assert.equal(await page.locator('#view-feed .post').count(), 2);
  state.actionStatus = 200;
  page.once('dialog', dialog => dialog.accept());
  await postMenu(page, 'post-1', 'Delete post');
  await page.waitForFunction(() => document.getElementById('toast')?.textContent === 'Post deleted');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#view-feed .post').waitFor();
  assert.equal(await page.locator('#view-feed .post').count(), 1);
  assert.equal(state.posts[0].id, 'post-2');
});

test('social UI comment deletion preserves replies across reload and report failure permits retry', async t => {
  const { page, state } = await setup(t, { expired: false });
  socialRecords(state);
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  const commentsButton = page.locator(`button[onclick="Social.toggleComments('post-1')"]`);
  await commentsButton.click();
  await page.locator(`button[onclick="Social.commentMenu('comment-1')"]`).click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#sheet-wrap').getByRole('button', { name: 'Delete comment', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('toast')?.textContent === 'Comment deleted');
  assert.equal(state.comments.length, 1);
  assert.match(await page.locator('#cmts-post-1').innerText(), /Surviving reply/);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await commentsButton.click();
  assert.match(await page.locator('#cmts-post-1').innerText(), /Surviving reply/);
  state.actionStatus = 503;
  await postMenu(page, 'post-2', 'Report post');
  await page.locator('#sheet-wrap').getByRole('button', { name: 'Spam or scam', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Could not confirm the report'));
  assert.equal(state.reports.length, 0);
  assert.equal(await page.evaluate(() => Social.isHidden('post-2')), false);
  state.actionStatus = 200;
  await postMenu(page, 'post-2', 'Report post');
  await page.locator('#sheet-wrap').getByRole('button', { name: 'Spam or scam', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('toast')?.textContent.startsWith('Report sent.'));
  assert.equal(state.reports.length, 1);
  assert.equal(state.reports[0].reporter, 'member-A');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#app-shell:not(.hidden)').waitFor();
  assert.equal(await page.evaluate(() => Social.isHidden('post-2')), true);
});

test('feed and Flex agree on orphaned and deep replies before and after reload', async t => {
  const { page, state } = await setup(t, { expired: false });
  socialRecords(state);
  state.comments.push({ id: 'reply-2', post_id: 'post-1', parent_id: 'reply-1', author: 'member-B', body: 'Nested surviving reply', ts: Date.now() + 2 });
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.locator(`button[onclick="Social.toggleComments('post-1')"]`).click();
  assert.equal(await page.locator('#cmts-post-1 .cmt2').count(), 3);
  await page.evaluate(() => App.openReelComments('post-1'));
  assert.equal(await page.locator('#rc-list .cmt2').count(), 3);
  await page.evaluate(() => App.closeReelComments());
  page.once('dialog', dialog => dialog.accept());
  await page.evaluate(() => Social.deleteComment('comment-1'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#view-feed .post').first().waitFor();
  await page.evaluate(() => App.openReelComments('post-1'));
  assert.equal(await page.locator('#rc-list .cmt2').count(), 2);
  assert.match(await page.locator('#rc-list').innerText(), /Nested surviving reply/);
  assert.equal(await page.locator('#reel-comments .rc-title').innerText(), '2 comments');
});

test('legacy curation is visibly offered, explicitly restored and never inherited by the next account', async t => {
  const { page, state } = await setup(t, { expired: false });
  socialRecords(state);
  await page.context().addInitScript(() => {
    if (!localStorage.getItem('fixture-legacy')) {
      localStorage.setItem('fm_blocked', JSON.stringify(['member-B']));
      localStorage.setItem('fm_saved', JSON.stringify(['post-1']));
      localStorage.setItem('fixture-legacy', '1');
    }
  });
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.locator('#legacy-preferences-status').waitFor();
  assert.equal(await page.evaluate(() => Social.isBlocked('member-B')), false);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#legacy-preferences-status button').click();
  await page.locator('#legacy-preferences-status').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => Social.isBlocked('member-B')), true);
  assert.equal(await page.evaluate(() => Social.isSaved('post-1')), true);
  await page.evaluate(() => App.logout());
  await signInFree(page, state);
  assert.equal(await page.evaluate(() => Social.isBlocked('member-B')), false);
  assert.equal(await page.evaluate(() => Social.isSaved('post-1')), false);
  assert.equal(await page.locator('#legacy-preferences-status').count(), 0);
});

test('cold open waits for refresh and resolves Elite before first visible render', async t => {
  const { page, state } = await setup(t);
  state.refreshGate = deferred(); state.membershipGate = deferred();
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await state.refreshSeen.promise;
  assert.equal(await page.locator('#app-shell').getAttribute('class'), 'app-shell hidden');
  assert.equal(state.reads.some(r => r.path.endsWith('/entitlements')), false);
  state.refreshGate.resolve();
  await state.membershipSeen.promise;
  assert.equal(await page.locator('#app-shell').getAttribute('class'), 'app-shell hidden');
  state.membershipGate.resolve();
  await page.locator('#app-shell:not(.hidden)').waitFor();
  assert.equal(await page.locator('html').getAttribute('data-tier'), 'elite');
  assert.deepEqual(await page.evaluate(() => window.firstVisibleTiers), ['elite']);
  assert.equal(state.refreshCalls, 1);
  const membership = state.reads.find(r => r.path.endsWith('/entitlements'));
  assert.match(membership.query, /uid=eq\.member-A/);
  assert.equal(membership.authorization, 'Bearer fresh-A');
  await page.locator('#tabbar [data-tab="profile"]').click();
  await page.locator('#view-profile .member-card[data-tier="elite"]').waitFor();
  assert.equal(await page.locator('#view-profile .upgrade-card').count(), 0);
  await screenshot(page, 'elite-mobile');
  await page.setViewportSize({ width: 1366, height: 900 });
  await screenshot(page, 'elite-desktop');
});

test('fresh browser restores cloud-only onboarded profile with expired credentials', async t => {
  const { page, state } = await setup(t, { localProfile: false });
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.locator('#app-shell:not(.hidden)').waitFor();
  assert.equal(await page.locator('html').getAttribute('data-tier'), 'elite');
  const accountRead = state.reads.find(r => r.path.endsWith('/accounts'));
  assert.equal(accountRead.authorization, 'Bearer fresh-A');
  assert.equal(await page.evaluate(() => Store.state.profile.onboarded), true);
  assert.equal(await page.evaluate(() => Store.state.profile.heightCm), profile.heightCm);
  assert.equal(await page.evaluate(() => Store.state.profile.targetWeightKg), profile.targetWeightKg);
  assert.deepEqual(await page.evaluate(() => Store.state.weightLog), accountState.weightLog);
});

test('a slow account restore cannot upload defaults before cloud data is merged', async t => {
  const { page, state } = await setup(t, { localProfile: false, expired: false });
  await page.clock.install();
  state.accountGate = deferred();
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await state.accountSeen.promise;
  await page.clock.runFor(1400);
  const earlyWrites = state.writes.filter(write => write.path.endsWith('/accounts'));
  state.accountGate.resolve();
  await page.locator('#app-shell:not(.hidden)').waitFor();
  assert.equal(earlyWrites.length, 0, 'Do not upsert local defaults during hydration');
  assert.equal(await page.evaluate(() => Store.state.profile.heightCm), profile.heightCm);
});

test('a failed account read cannot seed or debounce an account overwrite', async t => {
  const { page, state } = await setup(t, { expired: false });
  await page.clock.install();
  state.accountStatus = 503;
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.locator('#app-shell:not(.hidden)').waitFor();
  await page.clock.runFor(1400);
  assert.equal(state.writes.filter(write => write.path.endsWith('/accounts')).length, 0);
});

test('startup metadata cannot make stale profile fields newer after a failed restore', async t => {
  const { page, state } = await setup(t, { expired: false });
  state.accountRecord = { ...accountState, updatedAt: 2, profile: { ...profile, heightCm: 182, targetWeightKg: 85 } };
  state.accountStatus = 503;
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.locator('#membership-status button').waitFor();
  assert.equal(await page.evaluate(() => Store.state.updatedAt), 1);
  state.accountStatus = 200;
  await page.locator('#membership-status button').click();
  await page.locator('#membership-status').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => Store.state.profile.heightCm), 182);
  assert.equal(await page.evaluate(() => Store.state.profile.targetWeightKg), 85);
  assert.deepEqual(await page.evaluate(() => Store.state.weightLog), accountState.weightLog);
});

test('a stored identity switch during refresh cannot upload account A under B', async t => {
  const { page, state } = await setup(t);
  state.refreshGate = deferred();
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await state.refreshSeen.promise;
  await page.evaluate(() => localStorage.setItem('formora_supa_session', JSON.stringify({ uid: 'member-B', email: 'free@example.test', access_token: 'fresh-B', refresh_token: 'refresh-B', expires_at: Math.floor(Date.now() / 1000) + 3600 })));
  state.uid = 'member-B'; state.token = 'fresh-B'; state.tier = 'free';
  state.refreshGate.resolve();
  await page.waitForFunction(() => App.authView === 'details' || !document.getElementById('app-shell').classList.contains('hidden'));
  assert.equal(state.writes.some(write => write.path.endsWith('/accounts') && write.body.uid === 'member-B' && write.body.data.profile.email === 'member@example.test'), false);
  assert.notEqual(await page.evaluate(() => Store.key), 'gymcoach_v1_local-A');
});

test('failed membership shows retry, preserves recorded plan and recovers without reload', async t => {
  const { page, state } = await setup(t, { expired: false });
  state.membershipStatus = 503;
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.locator('#membership-status').waitFor();
  await page.locator('#app-shell:not(.hidden)').waitFor();
  assert.equal(await page.evaluate(() => Entitlements.isElite()), false);
  assert.equal(await page.evaluate(() => Store.state.profile.tier), 'elite');
  assert.equal(state.writes.filter(w => w.path.endsWith('/profiles')).some(w => w.body.data.tier === 'free'), false);
  await page.locator('#tabbar [data-tab="profile"]').click();
  assert.equal(await page.locator('#view-profile .upgrade-card').count(), 0);
  await page.setViewportSize({ width: 320, height: 640 });
  assert.equal(await page.locator('#membership-status').evaluate(element => element.scrollWidth <= element.clientWidth), true);
  await screenshot(page, 'membership-unavailable-mobile');
  state.membershipStatus = 200;
  await page.locator('#membership-status button').click();
  await page.locator('#view-profile .member-card[data-tier="elite"]').waitFor();
  await page.locator('#membership-status').waitFor({ state: 'detached' });
  assert.equal(await page.locator('html').getAttribute('data-tier'), 'elite');
});

test('logging out Elite and signing in Free never carries over the paid tier', async t => {
  const { page, state } = await setup(t, { expired: false, viewport: { width: 1366, height: 900 } });
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.locator('#app-shell:not(.hidden)').waitFor();
  await page.evaluate(() => App.logout());
  assert.equal(await page.evaluate(() => localStorage.getItem('formora_supa_session')), null);
  assert.equal(await page.evaluate(() => Entitlements.tier()), 'free');
  state.uid = 'member-B'; state.token = 'fresh-B'; state.tier = 'free';
  await page.evaluate(async () => {
    await SupaAuth.login('free@example.test', 'fixture-password');
    Auth.supabaseSignIn({ email: 'free@example.test', name: 'Free tester' });
    const user = Auth.currentUser();
    Store.load('gymcoach_v1_' + user.id);
    Object.assign(Store.state.profile, { onboarded: true, username: 'free_tester', name: 'Free tester' });
    Store.save();
    await App.enterApp();
  });
  assert.equal(await page.locator('html').getAttribute('data-tier'), 'free');
  await page.locator('#tabbar [data-tab="profile"]').click();
  assert.equal(await page.locator('#view-profile .member-card').count(), 0);
  assert.equal(await page.evaluate(() => Entitlements.isPro()), false);
});

test('private notifications clear at logout and late responses cannot enter the next account', async t => {
  const { page, state } = await setup(t, { expired: false });
  state.notifs = [{ id: 'private-A', type: 'message', actor: 'sender-A', body: 'Private message for A', read: false, ts: '2026-09-05T12:00:00Z' }];
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.locator('#app-shell:not(.hidden)').waitFor();
  await page.waitForFunction(() => Social.cloud.notifs.length === 1);
  const gate = state.notifGate = deferred();
  state.notifSeen = deferred();
  await page.evaluate(() => { window.oldNotification = App.pollNotifs(); });
  await state.notifSeen.promise;
  await page.evaluate(() => App.logout());
  assert.deepEqual(await page.evaluate(() => Social.cloud.notifs), []);
  state.notifGate = null; state.notifs = [];
  await signInFree(page, state);
  await page.evaluate(() => App.pollNotifs());
  gate.resolve();
  await page.evaluate(() => window.oldNotification);
  assert.deepEqual(await page.evaluate(() => Social.cloud.notifs), []);
  await page.locator('#tabbar [data-tab="alerts"]').click();
  assert.doesNotMatch(await page.locator('#view-alerts').innerText(), /Private message for A/);
});

test('a previous account retry cannot disable or overwrite the new account retry', async t => {
  const { page, state } = await setup(t, { expired: false });
  state.membershipStatus = 503;
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.locator('#membership-status button').waitFor();
  const gate = state.membershipGate = deferred();
  state.membershipSeen = deferred();
  await page.evaluate(() => { window.oldRetry = App.retryMembership(); });
  await state.membershipSeen.promise;
  await page.evaluate(() => App.logout());
  state.membershipGate = null;
  await signInFree(page, state);
  assert.equal(await page.locator('#membership-status button').isEnabled(), true);
  gate.resolve();
  await page.evaluate(() => window.oldRetry);
  assert.equal(await page.locator('#membership-status button').isEnabled(), true);
  state.membershipStatus = 200;
  await page.locator('#membership-status button').click();
  await page.locator('#membership-status').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => Entitlements.tier()), 'free');
});

test('mid-session credential rejection hides private UI without publishing Free', async t => {
  const { page, state } = await setup(t, { expired: false });
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.locator('#app-shell:not(.hidden)').waitFor();
  state.refreshStatus = 401;
  const start = state.writes.length;
  await page.evaluate(() => SupaAuth.refresh());
  await page.locator('#auth-overlay:not(.hidden)').waitFor();
  assert.equal(await page.locator('#app-shell').isVisible(), false);
  assert.equal(await page.evaluate(() => Auth.currentUser()), null);
  assert.equal(await page.evaluate(() => Store._syncReady), false);
  assert.equal(state.writes.slice(start).some(write => write.path.endsWith('/profiles') && write.body.data.tier === 'free'), false);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gymcoach_v1_local-A')).profile.tier), 'elite');
});

test('paid feature entry during a retry never opens a purchase paywall', async t => {
  const { page, state } = await setup(t, { expired: false });
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.locator('#app-shell:not(.hidden)').waitFor();
  state.membershipGate = deferred(); state.membershipSeen = deferred();
  await page.evaluate(() => { window.pendingMembership = App.retryMembership(); });
  await state.membershipSeen.promise;
  await page.evaluate(() => App.openProgram());
  assert.equal(await page.locator('#modal').isVisible(), false);
  state.membershipGate.resolve();
  await page.evaluate(() => window.pendingMembership);
  assert.equal(await page.evaluate(() => Entitlements.isElite()), true);
});

test('combined restore and membership failure never consumes Free credits or offers an upgrade', async t => {
  const { page, state } = await setup(t, { expired: false });
  state.accountStatus = 503; state.membershipStatus = 503;
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.locator('#membership-status button').waitFor();
  const notice = await page.locator('#membership-status').innerText();
  assert.match(notice, /Cloud restore unavailable/);
  assert.match(notice, /Paid features are temporarily locked/);
  await page.evaluate(() => App.goTab('overview'));
  assert.equal(await page.locator('#view-home .program-cta').count(), 0);
  await page.evaluate(() => App.goTab('progress'));
  assert.equal(await page.locator('#view-progress .upgrade-card').count(), 0);
  await page.evaluate(() => App.goTab('nutrition'));
  const credits = await page.evaluate(() => localStorage.getItem('fm_plan_gens'));
  await page.evaluate(() => App.generatePlan());
  assert.equal(await page.evaluate(() => localStorage.getItem('fm_plan_gens')), credits);
  await page.evaluate(() => App.addProgressPhoto());
  assert.equal(await page.locator('#modal').isVisible(), false);
  state.accountStatus = 200; state.membershipStatus = 200;
  await page.locator('#membership-status button').click();
  await page.locator('#membership-status').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => Entitlements.isElite()), true);
});

test('two tabs share refresh-token rotation and both open with Elite', async t => {
  const { page, state } = await setup(t);
  state.refreshGate = deferred();
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await state.refreshSeen.promise;
  const second = await page.context().newPage();
  const errors = [];
  second.on('pageerror', error => errors.push(error.message));
  await second.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  state.refreshGate.resolve();
  await Promise.all([page.locator('#app-shell:not(.hidden)').waitFor(), second.locator('#app-shell:not(.hidden)').waitFor()]);
  assert.equal(state.refreshCalls, 1);
  assert.equal(await second.locator('html').getAttribute('data-tier'), 'elite');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#app-shell:not(.hidden)').waitFor();
  assert.equal(await page.evaluate(() => Entitlements.isElite()), true);
  assert.deepEqual(errors, []);
});