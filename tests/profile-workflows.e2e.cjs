'use strict';
/* Browser reproductions for the app-owned parts of DEF-060, DEF-061, DEF-062,
   DEF-063, DEF-066, DEF-067 and DEF-068.

   Everything runs against the real index.html/js sources from a loopback fixture
   server. Every request to any other origin is aborted, the authentication and
   REST endpoints are scripted, and no real account, provider or member data is
   used. The post-author row and the feed Save toggle belong to js/mod/social.js
   (another owner) and are deliberately out of scope here. */
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

const savedProfile = {
  name: 'Saved Member', email: 'member@example.test', username: 'saved_member', onboarded: true,
  gender: 'male', dob: '1995-04-02', age: 31, heightCm: 178, startWeightKg: 80, targetWeightKg: 76,
  activityFactor: 1.55, physique: 'lean_aesthetic', physiqueChosen: true, unit: 'kg', diet: 'veg', tier: 'free',
};
const accountState = {
  profile: savedProfile,
  weightLog: [{ date: '2026-09-05', kg: 80 }],
  workoutLog: [{ date: '2026-09-05', split: 'push', exercises: [{ id: 'bench_press', sets: [{ reps: 8, weight: 60 }] }] }],
  foodLog: [], restDays: [], updatedAt: 1,
};

const alertOwner = '11111111-1111-4111-8111-111111111111';
const alertPeer = '22222222-2222-4222-8222-222222222222';
const keyboardActivity = {
  users: { [alertPeer]: { uid: alertPeer, name: 'Other member', username: 'other_member', privacy: 'public', colors: ['#111', '#222'] } },
  posts: { 'keyboard-post': { id: 'keyboard-post', author: alertOwner, text: 'Keyboard notification target', privacy: 'public', likes: {}, ts: 1 } },
  notifs: [{ id: 'notif-1', uid: alertOwner, type: 'like', actor: alertPeer, post_id: 'keyboard-post', ts: '2026-09-05T12:00:00Z', read: false }],
};

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch (_) { res.writeHead(404).end(); return; }
    if (pathname === '/') pathname = '/index.html';
    const allowed = /^\/(index\.html|legal\.html|version\.txt|manifest\.webmanifest|favicon\.ico)$/.test(pathname)
      || /^\/(js|css|assets|icons)\/[a-zA-Z0-9_/-]+\.(js|css|json|png|jpe?g|webp|gif|svg|ico|woff2|mp4|webm|mp3)$/.test(pathname);
    const file = path.resolve(root, '.' + pathname);
    if (!allowed || !file.startsWith(root + path.sep) || !['GET', 'HEAD'].includes(req.method)
      || !fs.existsSync(file) || !fs.statSync(file).isFile() || fs.realpathSync(file) !== file) { res.writeHead(404).end(); return; }
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
      '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.txt': 'text/plain' }[path.extname(file)] || 'application/octet-stream';
    let body = fs.readFileSync(file);
    if (file.endsWith('/js/config.js')) {
      body = Buffer.from(body.toString()
        + `\nwindow.SUPABASE_URL=${JSON.stringify(origin)};window.SUPABASE_ANON_KEY="fixture-public";`
        + `window.GOOGLE_CLIENT_ID="";window.POSTHOG_KEY="";window.EMAILJS_PUBLIC_KEY="";window.USE_SUPABASE_AUTH=true;`);
    }
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

async function setup(t, { signedIn = true, viewport = { width: 390, height: 844 }, ownerUid = 'member-A', activity = null } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', hasTouch: true });
  const state = { authRequests: [], authStatus: 200, authGate: null, blocked: [], notifWrites: [], activity: structuredClone(activity || { users: {}, posts: {}, notifs: [] }) };
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { state.blocked.push(url.href); await route.abort('blockedbyclient'); return; }
    if (url.pathname.startsWith('/auth/v1/')) {
      state.authRequests.push({ path: url.pathname, grant: url.searchParams.get('grant_type'), method: request.method() });
      if (state.authGate) await state.authGate.promise;
      if (state.authStatus !== 200) {
        await route.fulfill({ status: state.authStatus, json: { error: state.authStatus === 401 ? 'Invalid credentials' : 'Service unavailable' } });
        return;
      }
      await route.fulfill({ status: 200, json: { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, user: { id: ownerUid, email: 'member@example.test' } } });
      return;
    }
    if (url.pathname.startsWith('/rest/v1/')) {
      if (url.pathname.endsWith('/entitlements')) { await route.fulfill({ json: [{ tier: 'free', status: 'active', current_period_end: '2099-01-01T00:00:00Z' }] }); return; }
      if (url.pathname.endsWith('/accounts') && request.method() === 'GET') { await route.fulfill({ json: [{ data: accountState }] }); return; }
      if (url.pathname.endsWith('/rpc/get_state')) { await route.fulfill({ json: { users: state.activity.users, posts: state.activity.posts, requests: {}, comments: {}, stories: {} } }); return; }
      if (url.pathname.endsWith('/notifications')) {
        const rows = state.activity.notifs.filter(row => url.searchParams.get('uid') === 'eq.' + row.uid);
        if (request.method() === 'GET') { await route.fulfill({ json: rows }); return; }
        if (request.method() === 'PATCH') {
          const body = request.postDataJSON();
          state.notifWrites.push({ query: Object.fromEntries(url.searchParams), body, prefer: request.headers().prefer, authorization: request.headers().authorization });
          const acknowledged = rows.filter(row => url.searchParams.get('id') === 'in.(' + row.id + ')' && body.read === true);
          acknowledged.forEach(row => { row.read = true; });
          await route.fulfill({ json: acknowledged.map(({ id, uid, read }) => ({ id, uid, read })) });
          return;
        }
      }
      await route.fulfill({ json: [] });
      return;
    }
    await route.continue();
  });
  await context.addInitScript(({ stored, signedIn, ownerUid }) => {
    if (signedIn) {
      localStorage.setItem('formora_supa_session', JSON.stringify({ uid: ownerUid, email: 'member@example.test', access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600 }));
      localStorage.setItem('gymcoach_auth', JSON.stringify({ accounts: [{ id: 'local-A', email: 'member@example.test', name: 'Saved Member', provider: 'supabase', emailVerified: true }], currentUserId: 'local-A' }));
      localStorage.setItem('gymcoach_v1_local-A', JSON.stringify(stored));
    }
    localStorage.setItem('fm_dl_x', '1');
  }, { stored: accountState, signedIn, ownerUid });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => {
    await context.close();
    assert.deepEqual(errors, [], 'No uncaught app exception');
    // index.html links Google Fonts; every off-origin request is aborted, and none may carry data.
    assert.deepEqual(state.blocked.filter(url => !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url)), [],
      'The fixture never contacts a third-party data or provider origin');
  });
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  if (signedIn) await page.locator('#app-shell:not(.hidden)').waitFor();
  else await page.evaluate(() => App.showAuth('login'));
  return { page, state, errors };
}

const openProfile = async page => {
  await page.locator('#tabbar [data-tab="profile"]').click();
  await page.locator('#p-name').waitFor();
};

test('Profile drafts survive same-tab refreshes but not a successful save or reset',async t=>{
  const {page}=await setup(t);await openProfile(page);
  await page.locator('#p-name').fill('Unsaved same-tab draft');
  await page.evaluate(()=>App.renderProfile());
  assert.equal(await page.locator('#p-name').inputValue(),'Unsaved same-tab draft');
  await page.evaluate(()=>App.selectTab('profile'));
  assert.equal(await page.locator('#p-name').inputValue(),'Unsaved same-tab draft');
  await page.locator('#view-profile button[onclick="App.saveProfile()"]').click();
  assert.equal(await page.evaluate(()=>App._profileDraft),null);
  assert.equal(await page.locator('#p-name').inputValue(),'Unsaved same-tab draft');
  await page.locator('#p-name').fill('Must not return after reset');
  page.once('dialog',dialog=>dialog.accept());await page.evaluate(()=>App.resetAll());
  await openProfile(page);assert.notEqual(await page.locator('#p-name').inputValue(),'Must not return after reset');
});

test('choosing a physique updates gender without restoring an obsolete draft field',async t=>{
  const {page}=await setup(t);await openProfile(page);
  await page.locator('#p-name').fill('Unrelated unsaved name');
  await page.evaluate(()=>App.openPhysiquePicker());
  await page.getByRole('button',{name:'Women',exact:true}).click();
  await page.getByRole('button',{name:'Use this as my goal'}).click();
  assert.equal(await page.locator('#p-gender').inputValue(),'female');
  assert.equal(await page.locator('#p-name').inputValue(),'Unrelated unsaved name');
  await page.locator('#view-profile button[onclick="App.saveProfile()"]').click();
  assert.equal(await page.evaluate(()=>Store.state.profile.gender),'female');
  assert.equal(await page.evaluate(()=>Store.state.profile.physique),'toned_lean');
});

// ------------------------------------------------------------------ DEF-061

for (const invalid of [
  { name: 'negative height', selector: '#p-h', value: '-1', field: 'heightCm' },
  { name: 'negative target weight', selector: '#p-tw', value: '-5', field: 'targetWeightKg' },
  { name: 'future date of birth', selector: '#p-dob', value: '2099-01-01', field: 'dob' },
]) {
  test(`DEF-061: saving a ${invalid.name} leaves the stored profile untouched`, async t => {
    const { page } = await setup(t);
    await openProfile(page);
    const dialogs = [];
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    const before = await page.evaluate(field => ({
      memory: Store.state.profile[field],
      persisted: JSON.parse(localStorage.getItem(Store.key)).profile[field],
    }), invalid.field);

    await page.locator(invalid.selector).fill(invalid.value);
    await page.locator('#view-profile button[onclick="App.saveProfile()"]').click();

    const after = await page.evaluate(field => ({
      memory: Store.state.profile[field],
      persisted: JSON.parse(localStorage.getItem(Store.key)).profile[field],
      alerts: [...document.querySelectorAll('#view-profile [role=alert],#view-profile [aria-invalid=true]')].map(element => element.textContent),
      invalidFields: [...document.querySelectorAll('#view-profile [aria-invalid=true]')].map(element => element.id),
      typed: document.querySelector('#p-h').value + '|' + document.querySelector('#p-tw').value + '|' + document.querySelector('#p-dob').value,
    }), invalid.field);

    assert.deepEqual({ memory: after.memory, persisted: after.persisted }, before, 'Invalid input never replaces saved profile data');
    assert.ok(after.alerts.length > 0, 'The member gets actionable field feedback');
    assert.ok(after.invalidFields.length > 0, 'The offending field is marked invalid');
    assert.ok(after.typed.includes(invalid.value), 'The rejected entry stays on screen so it can be corrected');
    assert.deepEqual(dialogs, [], 'Validation does not depend on a blocking browser dialog');
  });
}

test('DEF-061 control: valid Profile values still save to memory and storage', async t => {
  const { page } = await setup(t);
  await openProfile(page);
  await page.locator('#p-name').fill('QA Valid Profile');
  await page.locator('#p-h').fill('180');
  await page.locator('#p-tw').fill('76');
  await page.locator('#view-profile button[onclick="App.saveProfile()"]').click();
  await page.locator('#p-name').waitFor();

  const saved = await page.evaluate(() => {
    const persisted = JSON.parse(localStorage.getItem(Store.key)).profile;
    return { name: persisted.name, height: persisted.heightCm, goal: persisted.targetWeightKg,
      memoryName: Store.state.profile.name,
      alerts: document.querySelectorAll('#view-profile [role=alert]').length };
  });
  assert.deepEqual(saved, { name: 'QA Valid Profile', height: 180, goal: 76, memoryName: 'QA Valid Profile', alerts: 0 });
});

// ------------------------------------------------------------------ DEF-062

test('DEF-062: an unsaved Profile edit survives a short trip to another tab', async t => {
  const { page } = await setup(t);
  await openProfile(page);
  const draft = 'Unsaved QA member name';
  await page.locator('#p-name').fill(draft);
  await page.locator('#p-bio').fill('Unsaved bio draft');
  await page.locator('#tabbar [data-tab="home"]').click();
  await openProfile(page);

  assert.equal(await page.locator('#p-name').inputValue(), draft, 'The typed name is still there');
  assert.equal(await page.locator('#p-bio').inputValue(), 'Unsaved bio draft');
  assert.equal(await page.evaluate(() => Store.state.profile.name), 'Saved Member', 'An unsaved draft is not silently persisted');
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => /draft/i.test(key)).length), 0, 'Drafts stay in memory only');
});

test('DEF-062: saving replaces the draft, and logging out discards it entirely', async t => {
  const { page } = await setup(t);
  await openProfile(page);
  await page.locator('#p-name').fill('QA Saved Then Left');
  await page.locator('#view-profile button[onclick="App.saveProfile()"]').click();
  await page.locator('#p-name').waitFor();
  assert.equal(await page.evaluate(() => App._profileDraft), null, 'A saved value is the truth, not a leftover draft');

  await page.locator('#tabbar [data-tab="home"]').click();
  await openProfile(page);
  assert.equal(await page.locator('#p-name').inputValue(), 'QA Saved Then Left', 'The saved value is what comes back');

  await page.locator('#p-name').fill('Draft after saving');
  await page.locator('#tabbar [data-tab="home"]').click();
  assert.ok(await page.evaluate(() => !!App._profileDraft), 'The new unsaved edit is held');
  await page.evaluate(() => App.logout());
  await page.locator('#a-email').waitFor();
  assert.equal(await page.evaluate(() => App._profileDraft), null, 'Signing out discards the in-memory draft');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gymcoach_v1_local-A')).profile.name), 'QA Saved Then Left', 'An abandoned draft is never persisted');
});

// ------------------------------------------------------------------ DEF-063

test('DEF-063: an Alerts row can be focused and activated from the keyboard', async t => {
  const { page, state } = await setup(t, { viewport: { width: 1366, height: 900 }, ownerUid: alertOwner, activity: keyboardActivity });
  await page.locator('#view-feed [data-saved-post="keyboard-post"]').waitFor();
  await page.locator('#tabbar [data-tab="alerts"]').click();
  await page.evaluate(() => App.pollNotifs());
  const row = page.locator('#view-alerts .notif-item[data-notif-id="notif-1"]');
  await row.waitFor();
  const initialOpen = await page.evaluate(() => App._notifOpen || 0);

  const semantics = await row.evaluate(element => ({ tag: element.tagName, role: element.getAttribute('role'), tabIndex: element.tabIndex, nestedLinks: element.querySelectorAll('a,button').length }));
  assert.equal(semantics.role, 'button', 'The clickable row exposes an action role');
  assert.ok(semantics.tabIndex >= 0, 'The row is in the normal focus order');
  assert.equal(semantics.nestedLinks, 0, 'No second nested action is introduced');

  assert.ok(await row.evaluate(element => { element.focus(); return document.activeElement === element; }), 'The row actually receives focus');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => App.curTab === 'home' && !App._notifReadPending && Social.cloud.notifs.some(notification => notification.id === 'notif-1' && notification.read));
  assert.equal(await page.evaluate(() => document.activeElement?.querySelector('[data-saved-post]')?.dataset.savedPost), 'keyboard-post', 'Enter focuses the referenced post through the real notification action');
  assert.equal(await page.evaluate(() => App._notifOpen), initialOpen + 1, 'Enter dispatches exactly once');
  assert.deepEqual(state.notifWrites, [{ query: { uid: 'eq.' + alertOwner, id: 'in.(notif-1)', select: 'id,uid,read' }, body: { read: true }, prefer: 'return=representation', authorization: 'Bearer fixture-access' }]);

  await page.locator('#tabbar [data-tab="alerts"]').click();
  await row.evaluate(element => element.focus());
  await page.keyboard.press(' ');
  await page.waitForFunction(() => App.curTab === 'home' && document.activeElement?.querySelector('[data-saved-post]')?.dataset.savedPost === 'keyboard-post');
  assert.equal(await page.evaluate(() => App._notifOpen), initialOpen + 2, 'Space activates the real row too, exactly once');
  assert.equal(state.notifWrites.length, 1, 'Reopening an acknowledged row does not issue another read write');
});

// ------------------------------------------------------------------ DEF-068

test('DEF-068: the selected tab and the result toast are exposed programmatically', async t => {
  const { page } = await setup(t);
  await openProfile(page);
  const selected = await page.locator('#tabbar .tab.active').evaluate(element => ({
    tab: element.dataset.tab, ariaCurrent: element.getAttribute('aria-current'), ariaSelected: element.getAttribute('aria-selected'),
  }));
  assert.equal(selected.tab, 'profile');
  assert.equal(selected.ariaCurrent, 'page', 'The selected navigation item is programmatically identified');
  assert.equal(selected.ariaSelected, null, 'Plain nav buttons do not claim tablist semantics');
  assert.equal(await page.locator('#tabbar .tab[aria-current]').count(), 1, 'Exactly one navigation item is current');

  await page.locator('#tabbar [data-tab="home"]').click();
  assert.equal(await page.locator('#tabbar [data-tab="profile"]').getAttribute('aria-current'), null, 'The previous tab drops the state');

  await page.evaluate(() => App.toast('Profile saved'));
  const toast = await page.locator('#toast').evaluate(element => ({ role: element.getAttribute('role'), live: element.getAttribute('aria-live'), text: element.textContent }));
  assert.deepEqual(toast, { role: 'status', live: 'polite', text: 'Profile saved' });

  const subnav = await page.evaluate(() => { App.goTab('progress'); return [...document.querySelectorAll('#coach-subnav .ssub')].map(button => ({ current: button.getAttribute('aria-current'), active: button.classList.contains('active') })); });
  assert.equal(subnav.filter(item => item.current === 'page').length, 1, 'The Coach sub-view marks its current item');
  assert.deepEqual(subnav.filter(item => item.active).length, 1);
});

// ------------------------------------------------------------------ DEF-067

test('DEF-067: a confirmed reset clears the logs and lands on a refreshed screen', async t => {
  const { page } = await setup(t);
  await openProfile(page);
  const before = await page.evaluate(() => Store.state.workoutLog.length);
  assert.ok(before > 0, 'The fixture needs logs to erase');

  const dialogs = [];
  page.once('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.accept(); });
  await page.locator('#view-profile button[onclick="App.resetAll()"]').click();
  await page.waitForFunction(() => App.curTab === 'coach');

  const after = await page.evaluate(() => ({
    logs: { weight: Store.state.weightLog.length, workouts: Store.state.workoutLog.length, food: Store.state.foodLog.length },
    tab: App.curTab, coachSub: App.coachSub,
    profileInputName: document.getElementById('p-name') ? document.getElementById('p-name').value : undefined,
    profileName: Store.state.profile.name,
    todayVisible: document.getElementById('view-today').style.display !== 'none',
  }));
  assert.deepEqual(dialogs, ['confirm'], 'The erase still requires one explicit confirmation');
  assert.deepEqual(after.logs, { weight: 0, workouts: 0, food: 0 }, 'The confirmed erase happened');
  assert.equal(after.tab, 'coach');
  assert.equal(after.coachSub, 'today', 'Reset lands on Today through the Coach hub');
  assert.ok(after.todayVisible, 'The Today view is the visible screen');
  assert.equal(after.profileInputName, after.profileName, 'No stale profile value is left on screen');
});

test('DEF-067 control: dismissing the reset confirmation changes nothing', async t => {
  const { page } = await setup(t);
  await openProfile(page);
  const before = await page.evaluate(() => JSON.stringify({ weight: Store.state.weightLog, workouts: Store.state.workoutLog, food: Store.state.foodLog }));
  page.once('dialog', async dialog => dialog.dismiss());
  await page.locator('#view-profile button[onclick="App.resetAll()"]').click();
  const after = await page.evaluate(() => JSON.stringify({ weight: Store.state.weightLog, workouts: Store.state.workoutLog, food: Store.state.foodLog }));
  assert.equal(after, before, 'Cancel never mutates saved logs');
  assert.equal(await page.evaluate(() => App.curTab), 'profile', 'Cancel does not navigate away');
});

// ------------------------------------------------------------- DEF-060/066

test('DEF-060: pressing Enter in the password field submits the login form once', async t => {
  const { page, state } = await setup(t, { signedIn: false });
  state.authStatus = 401;
  await page.locator('#a-email').waitFor();
  assert.ok(await page.evaluate(() => !!document.getElementById('a-pass').form), 'The rendered login controls are inside a real form');

  await page.locator('#a-email').fill('unregistered.qa@example.test');
  await page.locator('#a-pass').fill('Fixture-Only-Password42!');
  await Promise.all([
    page.waitForResponse(response => response.url().includes('/auth/v1/token')),
    page.locator('#a-pass').press('Enter'),
  ]);
  await page.waitForFunction(() => document.getElementById('auth-err').textContent.trim().length > 0);

  const tokenRequests = state.authRequests.filter(request => request.grant === 'password');
  assert.equal(tokenRequests.length, 1, 'Enter submits exactly one login attempt');
  assert.equal(page.url().split('#')[0].split('?')[0], origin + '/index.html', 'Submitting never navigates the page away');
  assert.match(await page.locator('#auth-err').innerText(), /incorrect email or password/i);
});

test('DEF-060: a second activation during a pending login cannot start another request', async t => {
  const { page, state } = await setup(t, { signedIn: false });
  state.authStatus = 503;
  state.authGate = deferred();
  await page.locator('#a-email').fill('qa.pending@example.test');
  await page.locator('#a-pass').fill('Fixture-Only-Password42!');
  const submit = page.locator('#auth-card button[onclick="App.doLogin()"]');
  try {
    await Promise.all([page.waitForRequest(request => request.url().includes('/auth/v1/token')), submit.click()]);
    const pendingControl = await submit.evaluate(element => ({ disabled: element.disabled, busy: element.getAttribute('aria-busy'), text: element.textContent.trim() }));
    assert.ok(pendingControl.disabled || pendingControl.busy === 'true' || /signing in/i.test(pendingControl.text), 'Pending authentication is visible and programmatic');
    assert.equal(pendingControl.busy, 'true');

    await page.evaluate(() => { App.doLogin(); App.submitLogin({ preventDefault() {} }); });
    await page.waitForTimeout(400);
    assert.equal(state.authRequests.filter(request => request.grant === 'password').length, 1, 'Repeated activation never starts a second concurrent request');
  } finally { state.authGate.resolve(); }

  await page.waitForFunction(() => document.getElementById('auth-err').textContent.trim().length > 0);
  assert.equal(await submit.evaluate(element => element.disabled), false, 'The control is released once the attempt settles');
});

for (const status of [401, 503]) {
  test(`DEF-066: a ${status} login failure never requests account creation`, async t => {
    const { page, state } = await setup(t, { signedIn: false });
    state.authStatus = status;
    assert.equal(await page.evaluate(() => !!Auth.findByEmail('unregistered.qa@example.test')), false, 'The attempt must not target a legacy local account');

    await page.locator('#a-email').fill('unregistered.qa@example.test');
    await page.locator('#a-pass').fill('Fixture-Only-Password42!');
    await page.locator('#auth-card button[onclick="App.doLogin()"]').click();
    await page.waitForFunction(() => document.getElementById('auth-err').textContent.trim().length > 0);

    const message = await page.locator('#auth-err').innerText();
    assert.ok(!state.authRequests.some(request => request.path.endsWith('/signup')),
      'An explicit Log in attempt never silently requests account creation: ' + JSON.stringify(state.authRequests));
    assert.equal(await page.evaluate(() => document.getElementById('app-shell').classList.contains('hidden')), true, 'A failed login never enters the app');
    if (status === 401) assert.match(message, /incorrect email or password/i);
    else {
      assert.match(message, /unavailable|retry|try again|connection|network/i, 'A service outage gets retryable feedback');
      assert.doesNotMatch(message, /incorrect email or password/i, 'A service outage never blames the password');
    }
  });
}
