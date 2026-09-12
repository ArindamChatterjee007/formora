'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const password = 'Cover-Fixture-Only42!';
const publicKey = 'cover-fixture-public';
const members = {
  A: { id: '11111111-1111-4111-8111-111111111111', email: 'cover.a@example.test', name: 'Cover Alpha', username: 'cover_alpha' },
  B: { id: '22222222-2222-4222-8222-222222222222', email: 'cover.b@example.test', name: 'Cover Beta', username: 'cover_beta' },
};
const blankImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=', 'base64');
const mimeTypes = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.gif': 'image/gif',
  '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.txt': 'text/plain',
};
let server, browser, origin;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function assetPath(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded === '/') decoded = '/index.html';
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(segment => segment.startsWith('.'))) return null;
  const allowed = /^\/(index\.html|version\.txt|manifest\.webmanifest|favicon\.ico)$/.test(decoded)
    || /^\/js\/[a-zA-Z0-9_/-]+\.js$/.test(decoded)
    || /^\/css\/[a-zA-Z0-9_/-]+\.css$/.test(decoded)
    || /^\/(assets|icons)\/[a-zA-Z0-9_/-]+\.(json|png|jpe?g|webp|gif|svg|ico|woff2|mp4|webm|mp3)$/.test(decoded);
  if (!allowed) return null;
  const resolved = path.resolve(root, '.' + decoded);
  try {
    if (!resolved.startsWith(root + path.sep) || !fs.statSync(resolved).isFile() || fs.realpathSync(resolved) !== resolved) return null;
  } catch { return null; }
  return resolved;
}

before(async () => {
  server = http.createServer((request, response) => {
    const file = assetPath(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!file || !['GET', 'HEAD'].includes(request.method)) { response.writeHead(404).end(); return; }
    let body = fs.readFileSync(file);
    if (file === path.join(root, 'js/config.js')) body = Buffer.from(body.toString() + `\nObject.assign(window, {
      SUPABASE_URL: ${JSON.stringify(origin)}, SUPABASE_ANON_KEY: ${JSON.stringify(publicKey)}, USE_SUPABASE_AUTH: true,
      GOOGLE_CLIENT_ID: '', GOOGLE_IOS_CLIENT_ID: '', POSTHOG_KEY: '', EMAILJS_PUBLIC_KEY: '',
      EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAIL_FN_URL: '', SHEETS_API: '', SOCIAL_API: '', PEXELS_KEY: ''
    });\n`);
    response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.OFFICE_BROWSER_EXECUTABLE || undefined,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-domain-reliability',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'] });
});

after(async () => {
  try { if (browser) await browser.close(); }
  finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
});

function originalUrl(member) {
  return origin + '/storage/v1/object/public/media/covers/' + member.id + '/original.png';
}

function accountState(member) {
  return {
    profile: { ...member, email: member.email, onboarded: true, verified: true, gender: 'male', dob: '1995-01-01',
      heightCm: 178, startWeightKg: 80, targetWeightKg: 78, activityFactor: 1.55, physique: 'lean_aesthetic',
      physiqueChosen: true, unit: 'kg', diet: 'veg', tier: 'free', privacy: 'public',
      cover: originalUrl(member), coverUrl: originalUrl(member), coverPending: false },
    weightLog: [{ date: '2026-09-04', kg: 80 }],
    workoutLog: [{ date: '2026-09-04', split: 'push', exercises: [], volume: 0 }],
    foodLog: [{ date: '2026-09-04', items: [{ text: 'Fixture oats', kcal: 100, protein: 3 }] }],
    restDays: ['2026-09-03'], updatedAt: 1,
  };
}

function fixtureBackend() {
  const fixture = {
    tokens: new Map(), refreshTokens: new Map(), serial: 0, profiles: new Map(), accounts: new Map(), media: new Map(),
    requests: [], gates: [], faults: [], unexpected: [], allowRejections: false,
  };
  for (const member of Object.values(members)) {
    fixture.profiles.set(member.id, { uid: member.id, data: { name: member.name, username: member.username,
      privacy: 'public', tier: 'free', following: [], verified: true, cover: originalUrl(member) } });
    fixture.accounts.set(member.id, { uid: member.id, data: accountState(member) });
    fixture.media.set(new URL(originalUrl(member)).pathname, { bytes: blankImage, type: 'image/png' });
  }
  fixture.issueSession = member => {
    const serial = ++fixture.serial;
    const accessToken = `cover-fixture-access-${member.id}-${serial}`;
    const refreshToken = `cover-fixture-refresh-${member.id}-${serial}`;
    fixture.tokens.set(accessToken, member.id);
    fixture.refreshTokens.set(refreshToken, member.id);
    return { access_token: accessToken, refresh_token: refreshToken, expires_in: 3600, token_type: 'bearer',
      user: { id: member.id, email: member.email, user_metadata: { name: member.name } } };
  };
  fixture.hold = phase => {
    const gate = { phase, seen: deferred(), release: deferred(), used: false };
    fixture.gates.push(gate);
    return gate;
  };
  fixture.fail = (phase, outcome) => {
    const fault = { phase, outcome, used: false };
    fixture.faults.push(fault);
    return fault;
  };
  fixture.handle = async (route, client) => {
    const request = route.request(), url = new URL(request.url()), headers = request.headers();
    let body = null;
    if (headers['content-type']?.includes('application/json') && request.postData()) body = request.postDataJSON();
    const token = (headers.authorization || '').replace(/^Bearer /, '');
    const uid = fixture.tokens.get(token);
    const record = { pathname: url.pathname, method: request.method(), client, uid, body, status: null,
      authorization: headers.authorization, injectedFailure: false };
    fixture.requests.push(record);
    const send = (status, json) => {
      record.status = status;
      if (fixture.allowRejections && [401, 403, 404, 405].includes(status)) record.injectedFailure = true;
      return route.fulfill({ status, json: structuredClone(json) });
    };
    const interrupt = async phase => {
      const gate = fixture.gates.find(candidate => !candidate.used && candidate.phase === phase);
      if (gate) { gate.used = true; gate.seen.resolve(record); await gate.release.promise; }
      const fault = fixture.faults.find(candidate => !candidate.used && candidate.phase === phase);
      if (!fault) return false;
      fault.used = true; record.injectedFailure = true;
      if (fault.outcome === 'offline') { record.status = 'offline'; await route.abort('internetdisconnected'); }
      else await send(fault.outcome, { error: 'Injected cover fixture failure' });
      return true;
    };
    if (url.pathname.startsWith('/storage/v1/object/public/media/')) {
      if (record.method !== 'GET') return send(405, { error: 'Public media is read-only' });
      const object = fixture.media.get(url.pathname);
      if (!object) return send(404, { error: 'Unknown fixture image' });
      record.status = 200;
      return route.fulfill({ status: 200, contentType: object.type, body: object.bytes });
    }
    if (headers.apikey !== publicKey) return send(401, { error: 'Fixture public key required' });
    if (url.pathname === '/auth/v1/token' && record.method === 'POST') {
      const grant = url.searchParams.get('grant_type');
      const member = Object.values(members).find(candidate => grant === 'refresh_token'
        ? fixture.refreshTokens.get(body?.refresh_token) === candidate.id
        : grant === 'password' && body?.email === candidate.email && body?.password === password);
      return member ? send(200, fixture.issueSession(member)) : send(401, { error: 'Invalid fixture credentials' });
    }
    if (!uid) return send(401, { error: 'Issued fixture bearer token required' });
    if (url.pathname === '/auth/v1/logout' && record.method === 'POST') {
      fixture.tokens.delete(token);
      return send(200, {});
    }
    if (url.pathname === '/auth/v1/user' && record.method === 'GET') {
      const member = Object.values(members).find(candidate => candidate.id === uid);
      return send(200, { id: uid, email: member.email });
    }
    if (url.pathname.startsWith('/storage/v1/object/media/')) {
      if (record.method !== 'POST') return send(405, { error: 'Only fixture uploads are supported' });
      if (!url.pathname.startsWith('/storage/v1/object/media/covers/' + uid + '/')) return send(403, { error: 'Storage owner mismatch' });
      if (headers['content-type'] !== 'image/jpeg' || !request.postDataBuffer()?.length) return send(403, { error: 'JPEG bytes required' });
      if (await interrupt('upload')) return;
      const publicPath = url.pathname.replace('/object/media/', '/object/public/media/');
      fixture.media.set(publicPath, { bytes: request.postDataBuffer(), type: headers['content-type'] });
      return send(201, { Key: publicPath });
    }
    if (url.pathname === '/rest/v1/profiles') {
      if (record.method === 'GET') {
        const username = url.searchParams.get('data->>username')?.replace(/^eq\./, '');
        const requested = url.searchParams.get('uid');
        return send(200, [...fixture.profiles.values()].filter(row => (!username || row.data.username === username)
          && (!requested || (requested.startsWith('eq.') ? row.uid === requested.slice(3) : row.uid !== requested.slice(4)))));
      }
      if (record.method === 'POST') {
        if (body?.uid !== uid) return send(403, { error: 'Profile owner mismatch' });
        if (/data:|base64,/i.test(JSON.stringify(body))) return send(403, { error: 'Profile must not contain image bytes' });
        if (body.data?.cover) {
          let cover;
          try { cover = new URL(body.data.cover); } catch { return send(403, { error: 'Cover URL required' }); }
          if (cover.origin !== origin || !cover.pathname.startsWith('/storage/v1/object/public/media/covers/' + uid + '/')
            || !fixture.media.has(cover.pathname)) return send(403, { error: 'Owned fixture image required' });
        }
        if (body.data?.cover && !body.data.cover.endsWith('/original.png') && await interrupt('profile')) return;
        fixture.profiles.set(uid, structuredClone(body));
        return send(201, []);
      }
    }
    if (['/rest/v1/accounts', '/rest/v1/entitlements', '/rest/v1/notifications'].includes(url.pathname)) {
      if ((record.method === 'GET' || record.method === 'PATCH') && url.searchParams.get('uid') !== 'eq.' + uid) {
        return send(403, { error: 'Private read owner mismatch' });
      }
      if (url.pathname === '/rest/v1/accounts') {
        if (record.method === 'GET') return send(200, [fixture.accounts.get(uid)]);
        if (record.method === 'POST') {
          if (body?.uid !== uid) return send(403, { error: 'Account owner mismatch' });
          fixture.accounts.set(uid, structuredClone(body));
          return send(201, []);
        }
      } else if (record.method === 'GET' || (url.pathname.endsWith('/notifications') && record.method === 'PATCH')) return send(200, []);
    }
    if (url.pathname === '/rest/v1/rpc/get_state' && record.method === 'POST') {
      return send(200, { users: Object.fromEntries([...fixture.profiles].map(([owner, row]) => [owner, { ...row.data, uid: owner }])),
        posts: {}, requests: {}, comments: {}, stories: {} });
    }
    fixture.unexpected.push({ pathname: record.pathname, method: record.method });
    return send(501, { error: 'Endpoint outside the cover fixture' });
  };
  return fixture;
}

async function setup(testContext, { fixture = fixtureBackend(), width = 390, client = 'A-browser' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width < 760,
    isMobile: width < 760, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const errors = [], consoleErrors = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) {
      if (request.resourceType() === 'stylesheet') return route.fulfill({ contentType: 'text/css', body: '' });
      if (request.resourceType() === 'image') return route.fulfill({ contentType: 'image/png', body: blankImage });
      fixture.unexpected.push({ external: url.href, method: request.method() });
      return route.abort('blockedbyclient');
    }
    if (/^\/(auth|rest|storage|functions)\//.test(url.pathname)) return fixture.handle(route, client);
    return route.continue();
  });
  await context.routeWebSocket('**/*', socket => { fixture.unexpected.push({ websocket: socket.url() }); socket.close(); });
  await context.addInitScript(() => { localStorage.setItem('fm_dl_x', '1'); });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  page.setDefaultNavigationTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const expected = message.text().startsWith('Failed to load resource:') && fixture.requests.some(record =>
      record.injectedFailure && message.location().url?.startsWith(origin + record.pathname));
    if (!expected) consoleErrors.push(message.text());
  });
  testContext.after(async () => {
    for (const gate of fixture.gates) gate.release.resolve();
    await context.close();
    assert.deepEqual(fixture.unexpected, [], 'No unimplemented backend, payment, email or external requests');
    assert.deepEqual(errors, [], 'No uncaught app errors');
    assert.deepEqual(consoleErrors, [], 'No unexpected console errors');
    assert.ok(fixture.faults.every(fault => fault.used), 'Injected faults must be exercised');
  });
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  await page.locator('#a-email').waitFor();
  await page.evaluate(() => {
    window.coverResults = [];
    window.coverMessages = [];
    const upload = App.uploadCover, toast = App.toast;
    App.uploadCover = function(event) {
      const promise = upload.call(this, event);
      promise.then(result => window.coverResults.push(result));
      return promise;
    };
    App.toast = function(message) { window.coverMessages.push(message); return toast.call(this, message); };
  });
  return { page, context, fixture };
}

async function login(page, member = members.A) {
  await page.locator('#a-email').fill(member.email);
  await page.locator('#a-pass').fill(password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.locator('#app-shell:not(.hidden)').waitFor();
  await page.waitForFunction(uid => Entitlements.ready() && SupaAuth.uid() === uid && Cloud.me === uid, member.id);
  await page.locator('#tabbar [data-tab="profile"]').click();
  await page.locator('.ph-cover-edit input').waitFor({ state: 'attached' });
}

async function logout(page) {
  await page.locator('.ph-logout-ic').click();
  await page.getByRole('dialog', { name: 'Log out of Formora?' }).getByRole('button', { name: 'Log out', exact: true }).click();
  await page.locator('#a-email').waitFor();
  assert.equal(await page.evaluate(() => SupaAuth.uid()), '');
}

async function chooseCover(page, color = '#278a7d') {
  const image = await page.evaluate(fill => {
    const canvas = document.createElement('canvas');
    canvas.width = 1400; canvas.height = 560;
    const drawing = canvas.getContext('2d');
    drawing.fillStyle = fill; drawing.fillRect(0, 0, 700, 560);
    drawing.fillStyle = '#edb347'; drawing.fillRect(700, 0, 700, 560);
    return canvas.toDataURL('image/png').split(',')[1];
  }, color);
  await page.locator('.ph-cover-edit input[type="file"]').setInputFiles({
    name: 'fixture-cover.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64'),
  });
}

async function coverState(page) {
  return page.evaluate(() => ({ cover: Store.state.profile.cover, url: Store.state.profile.coverUrl,
    pending: Store.state.profile.coverPending, key: Store.key, uid: Cloud.me, profile: structuredClone(Store.state.profile),
    logs: { weightLog: Store.state.weightLog, workoutLog: Store.state.workoutLog, foodLog: Store.state.foodLog, restDays: Store.state.restDays } }));
}

async function assertCoverImage(page, selector, url, expectedWidth) {
  const background = await page.locator(selector).evaluate(element => getComputedStyle(element).backgroundImage);
  assert.ok(background.includes(url), 'The actual cover background references the persisted URL');
  const dimensions = await page.evaluate(async source => {
    const image = new Image(); image.src = source;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  }, url);
  assert.ok(dimensions.width > 0 && dimensions.height > 0, 'The displayed cover object decodes successfully');
  if (expectedWidth) assert.equal(dimensions.width, expectedWidth);
}

test('the in-memory cover fixture rejects forged tokens, cross-owner writes, inline image data and deletion', { timeout: 30000 }, async testContext => {
  const { page, fixture } = await setup(testContext, { client: 'B-browser' });
  await login(page, members.B);
  const profiles = structuredClone([...fixture.profiles]), mediaCount = fixture.media.size;
  const cases = [
    { pathname: '/rest/v1/profiles', method: 'GET', auth: 'none', status: 401 },
    { pathname: '/rest/v1/profiles', method: 'GET', auth: 'forged', status: 401 },
    { pathname: '/rest/v1/accounts?uid=eq.' + members.A.id, method: 'GET', status: 403 },
    { pathname: '/rest/v1/profiles?uid=eq.' + members.A.id, method: 'GET', status: 200 },
    { pathname: '/rest/v1/profiles', method: 'POST', body: { uid: members.A.id, data: { cover: originalUrl(members.A) } }, status: 403 },
    { pathname: '/rest/v1/profiles', method: 'POST', body: { uid: members.B.id, data: { cover: originalUrl(members.A) } }, status: 403 },
    { pathname: '/rest/v1/profiles', method: 'POST', body: { uid: members.B.id, data: { cover: 'data:image/jpeg;base64,bmV3' } }, status: 403 },
    { pathname: '/storage/v1/object/media/covers/' + members.A.id + '/forged.jpg', method: 'POST', binary: true, status: 403 },
    { pathname: new URL(originalUrl(members.A)).pathname, method: 'GET', auth: 'none', status: 200 },
    { pathname: new URL(originalUrl(members.B)).pathname, method: 'DELETE', status: 405 },
  ];
  fixture.allowRejections = true;
  for (const request of cases) {
    const status = await page.evaluate(async candidate => {
      const headers = { apikey: window.SUPABASE_ANON_KEY };
      if (candidate.auth !== 'none') headers.Authorization = 'Bearer ' + (candidate.auth === 'forged' ? 'not-an-issued-fixture-token' : SupaAuth.bearer());
      let body;
      if (candidate.binary) { headers['Content-Type'] = 'image/jpeg'; body = new Uint8Array([255, 216, 255, 217]); }
      else if (candidate.body) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(candidate.body); }
      return (await fetch(candidate.pathname, { method: candidate.method, headers, body })).status;
    }, request);
    assert.equal(status, request.status, request.method + ' ' + request.pathname);
  }
  fixture.allowRejections = false;
  assert.deepEqual([...fixture.profiles], profiles);
  assert.equal(fixture.media.size, mediaCount);
});

for (const phase of ['upload', 'profile']) {
  test(`a newer real cover selection waits for the pending ${phase} and becomes the final decoded image`, { timeout: 30000 }, async testContext => {
    const { page, fixture } = await setup(testContext);
    await login(page);
    const original = await coverState(page), gate = fixture.hold(phase);
    await chooseCover(page);
    await gate.seen.promise;
    await chooseCover(page, '#934da1');
    await page.waitForFunction(() => App._coverDraft?.version === App._coverVersion);
    const pending = await coverState(page);
    const uploadCount = fixture.requests.filter(record => record.pathname.startsWith('/storage/v1/object/media/') && record.method === 'POST').length;
    gate.release.resolve();
    await page.waitForFunction(() => window.coverResults.length === 2 && !App._coverSync);
    const saved = await coverState(page);
    assert.equal(pending.cover, original.cover);
    assert.equal(uploadCount, 1, 'The replacement must wait for the earlier operation');
    assert.deepEqual(await page.evaluate(() => window.coverResults), [false, true]);
    assert.equal(saved.cover, saved.url);
    assert.equal(fixture.profiles.get(members.A.id).data.cover, saved.url);
    assert.equal(fixture.profiles.get(members.B.id).data.cover, originalUrl(members.B));
    assert.deepEqual(saved.logs, original.logs);
    const pixel = await page.evaluate(async url => {
      const image = new Image(); image.src = url; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
      const drawing = canvas.getContext('2d'); drawing.drawImage(image, 0, 0);
      return Array.from(drawing.getImageData(0, 0, 1, 1).data);
    }, saved.url);
    for (const [index, expected] of [147, 77, 161].entries()) assert.ok(Math.abs(pixel[index] - expected) < 10, 'The newest file pixels must win');
    assert.equal(await page.evaluate(() => window.coverMessages.filter(message => message === 'Cover synced').length), 1);
  });
}

test('Cloud.me drift alone during a real upload cannot register the image under another profile key', { timeout: 30000 }, async testContext => {
  const { page, fixture } = await setup(testContext);
  await login(page);
  const original = await coverState(page), gate = fixture.hold('upload');
  await chooseCover(page);
  await gate.seen.promise;
  await page.evaluate(uid => { Cloud.me = uid; }, members.B.id);
  gate.release.resolve();
  await page.waitForFunction(() => window.coverResults.length === 1);
  await page.evaluate(uid => { Cloud.me = uid; }, members.A.id);
  const saved = await coverState(page);
  assert.deepEqual(await page.evaluate(() => window.coverResults), [false]);
  assert.equal(saved.cover, original.cover);
  assert.equal(saved.url, original.url);
  assert.equal(fixture.requests.filter(record => record.pathname === '/rest/v1/profiles' && record.method === 'POST'
    && record.body.data.cover !== original.url).length, 0);
  assert.equal(fixture.profiles.get(members.B.id).data.cover, originalUrl(members.B));
  assert.equal(await page.evaluate(() => window.coverMessages.some(message => message === 'Cover synced')), false);
});

test('cover asset server exposes only app assets, never metadata, tests, backups or traversal', async () => {
  for (const pathname of ['/.git/config', '/.env', '/package.json', '/office/board.json', '/backups/data.json',
    '/tests/cover-photo.test.cjs', '/js/%2e%2e/.git/config', '/assets/%2e%2e/office/board.json', '/js/%00app.js']) {
    assert.equal((await fetch(origin + pathname)).status, 404, pathname);
  }
  assert.equal((await fetch(origin + '/index.html')).status, 200);
  assert.equal((await fetch(origin + '/index.html', { method: 'POST', body: 'denied' })).status, 404);
});

for (const width of [390, 1280]) {
  test(`real ${width}px cover upload stays unchanged until acknowledged; fresh B retrieves A's URL and decoded image`, { timeout: 30000 }, async testContext => {
    const { page, fixture } = await setup(testContext, { width });
    await login(page);
    const original = await coverState(page);
    const gate = fixture.hold('profile');
    await chooseCover(page);
    await gate.seen.promise;
    const pending = await coverState(page);
    gate.release.resolve();
    await page.waitForFunction(() => window.coverResults.length === 1);
    const saved = await coverState(page);
    assert.equal(pending.cover, original.cover, 'No premature local cover replacement');
    assert.equal(pending.url, original.url);
    assert.equal(saved.pending, false);
    assert.notEqual(saved.url, original.url);
    assert.equal(saved.cover, saved.url);
    assert.deepEqual(saved.logs, original.logs);
    assert.equal(fixture.profiles.get(members.A.id).data.cover, saved.url);
    const writes = fixture.requests.filter(record => record.pathname === '/rest/v1/profiles' && record.method === 'POST');
    assert.ok(writes.length > 0);
    for (const write of writes) {
      assert.doesNotMatch(JSON.stringify(write.body), /data:|base64,/i);
      assert.equal(write.uid, write.body.uid);
    }
    const object = fixture.media.get(new URL(saved.url).pathname);
    assert.equal(object.type, 'image/jpeg');
    assert.ok(object.bytes.length > 500);
    await assertCoverImage(page, '.ph-cover', saved.url, 900);
    const other = await setup(testContext, { fixture, width, client: 'fresh-B-browser' });
    assert.equal(await other.page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('gymcoach_v1_'))), false);
    await login(other.page, members.B);
    await other.page.waitForFunction(uid => Social.cloud.users.some(user => user.uid === uid), members.A.id);
    await other.page.locator('#tabbar [data-tab="search"]').click();
    await other.page.locator(`#view-feed [onclick*="Social.viewProfile"][onclick*="${members.A.id}"]`).first().click();
    await other.page.locator('.vp-hero.has-cover').waitFor();
    assert.equal(await other.page.evaluate(uid => Social.cloudUser(uid).cover, members.A.id), saved.url);
    await assertCoverImage(other.page, '.vp-hero.has-cover', saved.url, 900);
    assert.ok(fixture.requests.some(record => record.client === 'fresh-B-browser' && record.pathname === new URL(saved.url).pathname
      && record.method === 'GET' && record.status === 200));
    assert.equal(fixture.profiles.get(members.B.id).data.cover, originalUrl(members.B));
    if (process.env.COVER_PHOTO_SCREENSHOTS) {
      fs.mkdirSync(process.env.COVER_PHOTO_SCREENSHOTS, { recursive: true });
      await other.page.screenshot({ path: path.join(process.env.COVER_PHOTO_SCREENSHOTS, `cover-${width}.png`), animations: 'disabled' });
    }
  });
}

for (const phase of ['upload', 'profile']) {
  for (const outcome of [403, 500, 'offline']) {
    test(`cover ${phase} ${outcome} retains the original UI and persisted cover, then the real retry succeeds`, { timeout: 30000 }, async testContext => {
      const { page, fixture } = await setup(testContext);
      await login(page);
      const original = await coverState(page);
      fixture.fail(phase, outcome);
      await chooseCover(page);
      await page.waitForFunction(() => window.coverResults.length === 1 && !App._coverSync);
      const failed = await coverState(page);
      assert.equal(failed.cover, original.cover);
      assert.equal(failed.url, original.url);
      assert.deepEqual(failed.logs, original.logs);
      assert.equal(fixture.profiles.get(members.A.id).data.cover, original.url);
      assert.deepEqual(await page.evaluate(() => window.coverResults), [false]);
      const messages = await page.evaluate(() => window.coverMessages);
      assert.match(messages.at(-1), /could not|couldn't/i);
      assert.match(messages.at(-1), /retry|try again/i);
      assert.equal(messages.some(message => /cover synced|success/i.test(message)), false);
      await assertCoverImage(page, '.ph-cover', original.url);
      const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), original.key);
      assert.equal(stored.profile.cover, original.cover);
      const retry = page.getByRole('button', { name: 'Retry cover sync', exact: true });
      assert.equal(await retry.isEnabled(), true);
      await retry.click();
      await page.waitForFunction(() => Store.state.profile.coverPending === false && !App._coverSync);
      const saved = await coverState(page);
      assert.notEqual(saved.url, original.url);
      assert.equal(saved.cover, saved.url);
      assert.equal(fixture.profiles.get(members.A.id).data.cover, saved.url);
      assert.equal(await retry.count(), 0);
      assert.deepEqual(saved.logs, original.logs);
    });
  }
}

for (const phase of ['resize', 'upload', 'profile']) {
  for (const action of ['logout', 'switch']) {
    test(`${action} during real cover ${phase} cannot apply A's image or profile to B`, { timeout: 30000 }, async testContext => {
      const { page, fixture } = await setup(testContext);
      await login(page);
      const original = await coverState(page);
      const gate = phase === 'resize' ? null : fixture.hold(phase);
      if (phase === 'resize') await page.evaluate(() => {
        const resize = resizeImage;
        window.coverResizeReady = false;
        resizeImage = async (...args) => {
          const data = await resize(...args);
          window.coverResizeReady = true;
          await new Promise(resolve => { window.releaseCoverResize = resolve; });
          return data;
        };
      });
      await chooseCover(page);
      if (gate) await gate.seen.promise;
      else await page.waitForFunction(() => window.coverResizeReady);
      await logout(page);
      if (action === 'switch') await login(page, members.B);
      const beforeRelease = await coverState(page);
      const profileB = structuredClone(fixture.profiles.get(members.B.id));
      if (gate) gate.release.resolve();
      else await page.evaluate(() => window.releaseCoverResize());
      await page.waitForFunction(() => window.coverResults.length === 1);
      const afterRelease = await coverState(page);
      assert.deepEqual(afterRelease, beforeRelease);
      assert.deepEqual(fixture.profiles.get(members.B.id), profileB);
      assert.deepEqual(await page.evaluate(() => window.coverResults), [false]);
      assert.equal(await page.evaluate(() => window.coverMessages.some(message => /cover synced/i.test(message))), false);
      for (const record of fixture.requests.filter(request => request.method === 'POST' && request.pathname === '/rest/v1/profiles')) {
        assert.equal(record.uid, record.body.uid, 'Profile key must match the request bearer owner');
        if (record.body.uid === members.B.id) assert.equal(record.body.data.cover, originalUrl(members.B));
      }
      const storedA = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), original.key);
      assert.equal(storedA.profile.cover, original.cover);
      assert.equal(storedA.profile.coverUrl, original.url);
      if (action === 'switch') {
        assert.equal(afterRelease.uid, members.B.id);
        assert.equal(afterRelease.cover, originalUrl(members.B));
        await assertCoverImage(page, '.ph-cover', originalUrl(members.B));
      } else assert.equal(await page.locator('#app-shell').isVisible(), false);
    });
  }
}