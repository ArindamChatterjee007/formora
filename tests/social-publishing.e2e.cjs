'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const owner = '11111111-1111-4111-8111-111111111111';
const peer = '22222222-2222-4222-8222-222222222222';
const members = new Map([
  [owner, { uid: owner, name: 'Fixture Owner', email: 'owner@example.test', username: 'fixture_owner', token: 'fixture-owner-token', refresh: 'fixture-owner-refresh' }],
  [peer, { uid: peer, name: 'Fixture Peer', email: 'peer@example.test', username: 'fixture_peer', token: 'fixture-peer-token', refresh: 'fixture-peer-refresh' }],
]);
const tokenOwners = new Map([...members].map(([uid, member]) => ['Bearer ' + member.token, uid]));
const initialBodies = ['Peer history first', 'Original sent message', 'Peer history last'];
let server, browser, origin;

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

function accountState(uid) {
  const member = members.get(uid);
  return {
    profile: { name: member.name, email: member.email, username: member.username, onboarded: true, verified: true,
      gender: 'male', dob: '1995-01-01', heightCm: 178, startWeightKg: 80, targetWeightKg: 75,
      activityFactor: 1.55, physique: 'lean_aesthetic', physiqueChosen: true, unit: 'kg', diet: 'veg',
      privacy: 'public', following: [], autoFollowed: [], socials: {}, tier: 'free' },
    weightLog: [], workoutLog: [], foodLog: [], restDays: [], updatedAt: 2,
  };
}

function publicAsset(raw) {
  let pathname;
  try { pathname = decodeURIComponent(raw); } catch { return null; }
  if (pathname === '/') pathname = '/index.html';
  if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(segment => segment.startsWith('.'))) return null;
  const allowed = /^\/(index\.html|legal\.html|manifest\.webmanifest|version\.txt|robots\.txt)$/.test(pathname)
    || /^\/js\/[A-Za-z0-9_/-]+\.js$/.test(pathname) || /^\/css\/[A-Za-z0-9_/-]+\.css$/.test(pathname)
    || /^\/(assets|icons)\/[A-Za-z0-9_/-]+\.(json|png|jpe?g|webp|gif|svg|ico|woff2|mp4|webm|mp3)$/.test(pathname);
  if (!allowed) return null;
  const file = path.resolve(root, '.' + pathname);
  try { return file.startsWith(root + path.sep) && fs.statSync(file).isFile() && fs.realpathSync(file) === file ? file : null; }
  catch { return null; }
}

before(async () => {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
    '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.txt': 'text/plain' };
  server = http.createServer((request, response) => {
    const file = ['GET', 'HEAD'].includes(request.method) && publicAsset(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!file) { response.writeHead(404).end(); return; }
    let body = fs.readFileSync(file);
    if (file === path.join(root, 'js/config.js')) body = Buffer.from(body.toString() + `\nObject.assign(window, {
      SUPABASE_URL: ${JSON.stringify(origin)}, SUPABASE_ANON_KEY: 'fixture-public-anon',
      GOOGLE_CLIENT_ID: '', GOOGLE_IOS_CLIENT_ID: '', POSTHOG_KEY: '', EMAILJS_PUBLIC_KEY: '',
      EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAIL_FN_URL: '', SHEETS_API: '', SOCIAL_API: '', PEXELS_KEY: ''
    }); if (window.Currency) Object.assign(window.Currency, { ready: true, cur: 'INR', rate: 83, country: 'IN' });\n`);
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, args: ['--disable-background-networking', '--disable-component-update',
    '--disable-domain-reliability', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'] });
});

after(async () => {
  try { if (browser) await browser.close(); }
  finally { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } }
});

async function openApp(testContext, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width < 600, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const state = {
    posts: new Map([
      ['post-owner', { id: 'post-owner', author: owner, data: { text: 'Owner post before publishing', tag: 'Progress' }, likes: {}, ts: '2026-09-01T12:00:00Z' }],
      ['post-peer', { id: 'post-peer', author: peer, data: { text: 'Peer post before publishing', tag: 'Training' }, likes: {}, ts: '2026-09-01T11:00:00Z' }],
    ]),
    messages: new Map([
      ['dm-first', { id: 'dm-first', from_uid: peer, to_uid: owner, body: initialBodies[0], ts: '2026-09-01T12:00:00Z' }],
      ['dm-own', { id: 'dm-own', from_uid: owner, to_uid: peer, body: initialBodies[1], ts: '2026-09-01T12:01:00Z' }],
      ['dm-last', { id: 'dm-last', from_uid: peer, to_uid: owner, body: initialBodies[2], ts: '2026-09-01T12:02:00Z' }],
    ]),
    accounts: new Map([...members.keys()].map(uid => [uid, accountState(uid)])),
    media: new Map(), mediaWrites: [],
    writes: [], reads: [], gates: [], activeGates: [], external: [], unexpected: [], pageErrors: [], consoleErrors: [],
  };
  state.hold = (table, method, id) => {
    const started = deferred(), released = deferred();
    const gate = { table, method, id, started: started.promise, release: released.resolve, begin: started.resolve, result: released.promise };
    state.gates.push(gate); state.activeGates.push(gate); return gate;
  };
  const reply = (route, status, json) => route.fulfill({ status, json });
  const select = (row, url) => {
    const columns = url.searchParams.get('select');
    return columns ? Object.fromEntries(columns.split(',').map(column => [column, row[column]])) : row;
  };
  await context.route('**/*', async route => {
    try {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (url.origin !== origin) {
        state.external.push(url.origin + url.pathname);
        if (url.hostname === 'fonts.googleapis.com') return route.fulfill({ contentType: 'text/css', body: '' });
        return route.abort('blockedbyclient');
      }
      const uid = tokenOwners.get(request.headers().authorization);
      if (url.pathname.startsWith('/auth/v1/')) {
        if (url.pathname.endsWith('/logout')) return route.fulfill({ status: 204, body: '' });
        const body = request.postData() ? request.postDataJSON() : {};
        const member = url.pathname.endsWith('/token')
          ? [...members.values()].find(candidate => body.refresh_token === candidate.refresh || (body.email === candidate.email && body.password === 'FixtureOnly-2026'))
          : members.get(uid);
        if (!member) return reply(route, 401, { error: 'fixture_auth_required' });
        return reply(route, 200, { access_token: member.token, refresh_token: member.refresh, expires_in: 3600, token_type: 'bearer', user: { id: member.uid, email: member.email, user_metadata: { name: member.name } } });
      }
      if (url.pathname.startsWith('/storage/v1/object/')) {
        const publicPrefix = '/storage/v1/object/public/media/';
        if (method === 'GET' && url.pathname.startsWith(publicPrefix)) {
          const asset = state.media.get(url.pathname.slice(publicPrefix.length));
          return asset ? route.fulfill({ status: 200, contentType: asset.type, body: asset.body }) : route.fulfill({ status: 404, body: '' });
        }
        const prefix = '/storage/v1/object/media/videos/' + uid + '/';
        if (!uid || method !== 'POST' || !url.pathname.startsWith(prefix)) return reply(route, 403, {});
        state.mediaWrites.push({ uid, method, path: url.pathname });
        state.media.set(url.pathname.slice('/storage/v1/object/media/'.length), { body: request.postDataBuffer(), type: request.headers()['content-type'] });
        return reply(route, 200, { Key: url.pathname });
      }
      if (!url.pathname.startsWith('/rest/v1/')) return route.continue();
      if (!uid) return reply(route, 401, { error: 'fixture_auth_required' });
      const table = url.pathname.slice('/rest/v1/'.length);
      if (table === 'rpc/get_state') return reply(route, 200, {
        users: Object.fromEntries([...members].map(([id]) => [id, { uid: id, ...state.accounts.get(id).profile }])),
        posts: Object.fromEntries([...state.posts].map(([id, row]) => [id, { id, author: row.author, ...row.data, likes: row.likes, ts: Date.parse(row.ts) }])),
        requests: { connection: { id: 'connection', from: owner, to: peer, status: 'accepted', ts: 1 } }, comments: {}, stories: {},
      });
      const body = request.postData() ? request.postDataJSON() : undefined;
      const id = url.searchParams.get('id')?.slice(3) || body?.id;
      if (method !== 'GET') state.writes.push({ table, method, id, uid, body, url: url.toString(), prefer: request.headers().prefer });
      else state.reads.push({ table, uid, url: url.toString() });
      const gateIndex = state.gates.findIndex(gate => gate.table === table && gate.method === method && (!gate.id || gate.id === id));
      let mode;
      if (gateIndex >= 0) {
        const gate = state.gates.splice(gateIndex, 1)[0]; gate.begin({ body, id, uid }); mode = await gate.result;
      }
      if (typeof mode === 'number' && mode >= 400) return reply(route, mode, { error: 'fixture_rejection' });
      if (mode === 'empty') return reply(route, 200, []);
      if (mode === 'malformed') return reply(route, 200, { id });
      if (mode === 'wrong-id') return reply(route, 200, [{ id: 'wrong-id', author: uid, from_uid: uid, to_uid: peer, body: body?.body }]);
      if (table === 'accounts') {
        if (method === 'GET') return reply(route, 200, url.searchParams.get('uid') === 'eq.' + uid ? [{ uid, data: state.accounts.get(uid) }] : []);
        if (body?.uid !== uid) return reply(route, 403, {});
        state.accounts.set(uid, structuredClone(body.data)); return route.fulfill({ status: 201, body: '' });
      }
      if (table === 'entitlements') return reply(route, 200, []);
      if (table === 'profiles') {
        if (method === 'GET') return reply(route, 200, []);
        if (body?.uid !== uid) return reply(route, 403, {});
        return route.fulfill({ status: 201, body: '' });
      }
      if (table === 'notifications') {
        if (method === 'GET') return reply(route, 200, []);
        if (method === 'POST' && body?.actor !== uid) return reply(route, 403, {});
        return route.fulfill({ status: 201, body: '' });
      }
      if (table !== 'posts' && table !== 'messages') { state.unexpected.push(method + ' ' + table); return reply(route, 501, {}); }
      const records = state[table], ownerField = table === 'posts' ? 'author' : 'from_uid';
      if (method === 'GET') {
        let rows = [...records.values()].filter(row => table === 'posts' || row.from_uid === uid || row.to_uid === uid);
        for (const column of ['id', ownerField, 'to_uid']) {
          const value = url.searchParams.get(column);
          if (value) rows = rows.filter(row => value === 'eq.' + row[column]);
        }
        rows.sort((first, second) => Date.parse(first.ts) - Date.parse(second.ts));
        if (url.searchParams.get('order') === 'ts.desc') rows.reverse();
        return reply(route, 200, rows.map(row => select(row, url)));
      }
      let row;
      if (method === 'POST') {
        if (body?.[ownerField] !== uid || (table === 'messages' && !members.has(body.to_uid))) return reply(route, 403, {});
        if (records.has(id)) return reply(route, 409, { error: 'fixture_unique_id' });
        row = { ...structuredClone(body), ts: new Date().toISOString() }; records.set(id, row);
      } else {
        row = records.get(id);
        if (!row || row[ownerField] !== uid || url.searchParams.get(ownerField) !== 'eq.' + uid
          || (url.searchParams.has('to_uid') && url.searchParams.get('to_uid') !== 'eq.' + row.to_uid)) return reply(route, 200, []);
        if (method === 'PATCH') Object.assign(row, structuredClone(body));
        else if (method === 'DELETE') records.delete(id);
        else return reply(route, 405, {});
      }
      if (mode === 'lost') return route.abort('failed');
      return reply(route, method === 'POST' ? 201 : 200, [select(row, url)]);
    } catch (error) {
      if (!/closed|Target page/i.test(error.message)) { state.unexpected.push(error.message); await route.abort().catch(() => {}); }
    }
  });
  await context.addInitScript(seed => {
    if (sessionStorage.getItem('publishing-fixture-seeded')) return;
    sessionStorage.setItem('publishing-fixture-seeded', '1');
    localStorage.setItem('formora_supa_session', JSON.stringify({ uid: seed.member.uid, email: seed.member.email, access_token: seed.member.token, refresh_token: seed.member.refresh, expires_at: Math.floor(Date.now() / 1000) + 3600 }));
    localStorage.setItem('gymcoach_auth', JSON.stringify({ accounts: [{ id: 'fixture-owner', email: seed.member.email, name: seed.member.name, provider: 'supabase', emailVerified: true }], currentUserId: 'fixture-owner' }));
    localStorage.setItem('gymcoach_v1_fixture-owner', JSON.stringify(seed.account));
    localStorage.setItem('fm_dl_x', '1'); localStorage.setItem('fm_msgsound', 'off');
  }, { member: members.get(owner), account: accountState(owner) });
  const page = await context.newPage();
  page.setDefaultTimeout(8000); page.setDefaultNavigationTimeout(8000);
  page.on('pageerror', error => state.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') state.consoleErrors.push(message.text()); });
  page.on('dialog', dialog => dialog.accept());
  testContext.after(async () => {
    state.activeGates.forEach(gate => gate.release(503));
    await context.close();
    assert.deepEqual(state.pageErrors, []);
    assert.deepEqual(state.unexpected, []);
    assert.ok(state.external.every(url => url.startsWith('https://fonts.googleapis.com/')), 'Only the blocked font stylesheet may request an external origin');
    assert.deepEqual(state.consoleErrors.filter(text => !/Failed to load resource|net::ERR_FAILED|net::ERR_ABORTED/i.test(text)), []);
  });
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await ready(page);
  return { page, state, context };
}

async function ready(page) {
  await page.locator('#app-shell:not(.hidden)').waitFor();
  await page.waitForFunction(() => typeof Social !== 'undefined' && Social.cloud.feed.length >= 2 && Social.cloud.users.length >= 1);
  await page.locator('#post-text').waitFor();
}

async function thread(page) {
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page.locator('.dm-row').filter({ hasText: 'Fixture Peer' }).click();
  await page.waitForFunction(() => !Social._dmThreadLoading);
}

async function bodies(page) {
  return page.locator('#chat-thread .bubble').evaluateAll(nodes => nodes.map(node => Array.from(node.childNodes)
    .filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join('').trim()));
}

test('DEF-065 browser: post pending, 503, same-ID retry and backend-persisted reload', async testContext => {
  const { page, state } = await openApp(testContext);
  const text = 'Publishing retry fixture';
  await page.locator('#post-text').fill(text);
  const gate = state.hold('posts', 'POST');
  await page.locator('#post-publish').click();
  const first = await gate.started;
  assert.equal(await page.locator('#post-text').inputValue(), text);
  assert.equal(await page.locator('#post-publish').isDisabled(), true);
  assert.equal(await page.locator('.post-text').filter({ hasText: text }).count(), 0);
  assert.equal(state.posts.size, 2);
  gate.release(503);
  await page.getByRole('button', { name: 'Retry post', exact: true }).waitFor();
  assert.equal(await page.locator('#post-text').inputValue(), text);
  assert.match(await page.locator('.toast').last().innerText(), /could not confirm/i);
  await page.getByRole('button', { name: 'Retry post', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('post-text').value === '');
  assert.equal(await page.locator('.post-text').filter({ hasText: text }).count(), 1);
  assert.equal(state.posts.size, 3);
  const writes = state.writes.filter(write => write.table === 'posts');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].id, first.id); assert.equal(writes[1].id, first.id);
  assert.equal(writes[0].body.author, owner);
  await page.reload({ waitUntil: 'domcontentloaded' }); await ready(page);
  assert.equal(await page.locator('.post-text').filter({ hasText: text }).count(), 1);
  assert.equal(state.posts.size, 3);
});

async function messageOption(page, label) {
  await page.locator('[data-message-id="dm-own"]').getByRole('button', { name: 'Message options' }).click();
  await page.locator('#modal').getByRole('button', { name: label, exact: true }).click();
}

test('DEF-064 browser send: pending and 503 retain peer history and draft; retry persists once', async testContext => {
  const { page, state } = await openApp(testContext, { width: 390, height: 844 });
  await thread(page);
  assert.deepEqual(await bodies(page), initialBodies);
  await page.locator('#dm-text').fill('Retryable outgoing message');
  const gate = state.hold('messages', 'POST');
  await page.locator('#dm-send').click();
  const first = await gate.started;
  assert.deepEqual(await bodies(page), initialBodies);
  assert.equal(await page.locator('#dm-text').inputValue(), 'Retryable outgoing message');
  assert.equal(await page.locator('#dm-send').isDisabled(), true);
  await page.locator('#dm-text').press('Enter');
  gate.release(503);
  await page.waitForFunction(() => !Social._pendingActions.size);
  assert.deepEqual(await bodies(page), initialBodies);
  assert.equal(await page.locator('#dm-text').inputValue(), 'Retryable outgoing message');
  assert.match(await page.locator('.toast').last().innerText(), /could not confirm/i);
  await page.getByRole('button', { name: 'Retry message', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('dm-text').value === '');
  assert.deepEqual(await bodies(page), [...initialBodies, 'Retryable outgoing message']);
  const writes = state.writes.filter(write => write.table === 'messages' && write.method === 'POST');
  assert.equal(writes.length, 2); assert.equal(writes[1].id, first.id);
  assert.equal(writes[0].body.from_uid, owner); assert.equal(writes[0].body.to_uid, peer);
  assert.equal(state.messages.size, 4);
  await page.reload({ waitUntil: 'domcontentloaded' }); await ready(page); await thread(page);
  assert.deepEqual(await bodies(page), [...initialBodies, 'Retryable outgoing message']);
});

test('DEF-064 browser edit: pending and 503 preserve original bubble and editor; retry persists', async testContext => {
  const { page, state } = await openApp(testContext);
  await thread(page); await messageOption(page, 'Edit');
  await page.locator('#dm-edit').fill('Edited after acknowledgement');
  const gate = state.hold('messages', 'PATCH', 'dm-own');
  await page.locator('#dm-save').click(); await gate.started;
  assert.deepEqual(await bodies(page), initialBodies);
  assert.equal(await page.locator('#dm-edit').inputValue(), 'Edited after acknowledgement');
  assert.equal(await page.locator('#dm-save').isDisabled(), true);
  assert.equal(await page.locator('[data-message-id="dm-own"]').getAttribute('aria-busy'), 'true');
  await page.locator('#dm-edit').press('Enter');
  gate.release(503);
  await page.waitForFunction(() => !Social._pendingActions.size);
  assert.deepEqual(await bodies(page), initialBodies);
  assert.equal(await page.locator('#dm-edit').inputValue(), 'Edited after acknowledgement');
  assert.match(await page.locator('.toast').last().innerText(), /could not edit/i);
  await page.locator('#dm-save').click();
  await page.locator('#dm-edit').waitFor({ state: 'detached' });
  const expected = [initialBodies[0], 'Edited after acknowledgement', initialBodies[2]];
  assert.deepEqual(await bodies(page), expected);
  assert.equal(await page.locator('[data-message-id="dm-own"] .msg-edited').innerText(), 'Edited');
  assert.equal(state.messages.get('dm-own').body, expected[1]);
  await page.reload({ waitUntil: 'domcontentloaded' }); await ready(page); await thread(page);
  assert.deepEqual(await bodies(page), expected);
});

test('DEF-064 browser unsend: pending and 503 retain the bubble; retry removes only the owned row', async testContext => {
  const { page, state } = await openApp(testContext, { width: 375, height: 812 });
  await thread(page);
  await page.locator('#dm-text').fill('Unrelated composing draft');
  const gate = state.hold('messages', 'DELETE', 'dm-own');
  await messageOption(page, 'Unsend'); await gate.started;
  assert.deepEqual(await bodies(page), initialBodies);
  assert.equal(await page.locator('[data-message-id="dm-own"]').getAttribute('aria-busy'), 'true');
  assert.equal(state.messages.size, 3);
  gate.release(503);
  await page.waitForFunction(() => !Social._pendingActions.size);
  assert.deepEqual(await bodies(page), initialBodies);
  assert.equal(await page.locator('[data-message-id="dm-own"]').getAttribute('aria-busy'), 'false');
  assert.equal(await page.locator('#dm-text').inputValue(), 'Unrelated composing draft');
  assert.match(await page.locator('.toast').last().innerText(), /could not confirm unsend/i);
  await messageOption(page, 'Unsend');
  await page.locator('[data-message-id="dm-own"]').waitFor({ state: 'detached' });
  assert.deepEqual(await bodies(page), [initialBodies[0], initialBodies[2]]);
  assert.equal(await page.locator('#dm-text').inputValue(), 'Unrelated composing draft');
  assert.equal(state.messages.size, 2);
  assert.deepEqual(state.writes.filter(write => write.table === 'messages').map(write => write.id), ['dm-own', 'dm-own']);
  await page.reload({ waitUntil: 'domcontentloaded' }); await ready(page); await thread(page);
  assert.deepEqual(await bodies(page), [initialBodies[0], initialBodies[2]]);
});

test('DEF-065 browser: 403, 404, empty and malformed receipts keep cached posts and draft', async testContext => {
  const { page, state } = await openApp(testContext);
  await page.locator('#post-text').fill('Draft through rejected replies');
  const before = await page.locator('#view-feed .post-text').allTextContents();
  for (const failure of [403, 404, 'empty', 'malformed', 'wrong-id']) {
    const gate = state.hold('posts', 'POST'); gate.release(failure);
    await page.locator('#post-publish').click(); await gate.started;
    await page.waitForFunction(() => !Social._pendingActions.size);
    assert.deepEqual(await page.locator('#view-feed .post-text').allTextContents(), before);
    assert.equal(await page.locator('#post-text').inputValue(), 'Draft through rejected replies');
    assert.equal(state.posts.size, 2);
    assert.match(await page.locator('.toast').last().innerText(), /could not confirm/i);
  }
  await page.locator('#post-publish').click();
  await page.waitForFunction(() => document.getElementById('post-text').value === '');
  assert.equal(state.posts.size, 3);
  assert.equal(new Set(state.writes.filter(write => write.table === 'posts').map(write => write.id)).size, 1);
});

async function attachFixturePhoto(page) {
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
    const drawing = canvas.getContext('2d'); drawing.fillStyle = '#27a183'; drawing.fillRect(0, 0, 32, 32);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.getByRole('button', { name: 'Photo', exact: true }).click();
  const choosing = page.waitForEvent('filechooser');
  await page.locator('#modal .sheet-btn').filter({ hasText: 'Choose from gallery' }).click();
  await (await choosing).setFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64') });
  await page.waitForFunction(() => document.querySelector('.composer-photos img')?.naturalWidth > 0);
}

test('DEF-065 browser: photo draft survives a lost ack and reconciles the same owned post after 409', async testContext => {
  const { page, state } = await openApp(testContext, { width: 390, height: 844 });
  await page.locator('#post-text').fill('Photo with one durable identity');
  await attachFixturePhoto(page);
  assert.equal(await page.locator('#post-text').inputValue(), 'Photo with one durable identity');
  const photo = await page.locator('.composer-photos img').getAttribute('src');
  const gate = state.hold('posts', 'POST'); gate.release('lost');
  await page.locator('#post-publish').click(); const first = await gate.started;
  await page.waitForFunction(() => !Social._pendingActions.size);
  assert.equal(state.posts.size, 3);
  assert.equal(await page.locator('.composer-photos img').getAttribute('src'), photo);
  assert.equal(await page.locator('#view-feed .post-text').filter({ hasText: 'Photo with one durable identity' }).count(), 0);
  await page.getByRole('button', { name: 'Retry post', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('post-text').value === '');
  assert.equal(state.posts.size, 3);
  assert.equal(await page.locator('.composer-photos').count(), 0);
  assert.equal(await page.locator('#view-feed .post-text').filter({ hasText: 'Photo with one durable identity' }).count(), 1);
  assert.equal(state.posts.get(first.id).data.photo, photo);
  const read = state.reads.find(entry => entry.table === 'posts');
  assert.equal(new URL(read.url).searchParams.get('author'), 'eq.' + owner);
  assert.equal(new URL(read.url).searchParams.get('id'), 'eq.' + first.id);
  await page.reload({ waitUntil: 'domcontentloaded' }); await ready(page);
  assert.equal(await page.locator('#view-feed .post-text').filter({ hasText: 'Photo with one durable identity' }).count(), 1);
});

test('DEF-064 browser: lost send acknowledgement reconciles one message without repeating peer history', async testContext => {
  const { page, state } = await openApp(testContext);
  await thread(page); await page.locator('#dm-text').fill('A message whose response was lost');
  const gate = state.hold('messages', 'POST'); gate.release('lost');
  await page.locator('#dm-send').click(); const first = await gate.started;
  await page.waitForFunction(() => !Social._pendingActions.size);
  assert.deepEqual(await bodies(page), initialBodies);
  assert.equal(state.messages.size, 4);
  await page.getByRole('button', { name: 'Retry message', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('dm-text').value === '');
  assert.deepEqual(await bodies(page), [...initialBodies, 'A message whose response was lost']);
  assert.equal(state.messages.size, 4);
  assert.equal(state.writes.filter(write => write.table === 'messages').at(-1).id, first.id);
  const reconciliation = state.reads.find(read => read.table === 'messages' && new URL(read.url).searchParams.has('id'));
  assert.equal(new URL(reconciliation.url).searchParams.get('from_uid'), 'eq.' + owner);
  assert.equal(new URL(reconciliation.url).searchParams.get('to_uid'), 'eq.' + peer);
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 812 }]) {
  test(`DEF-063/068 browser: author Enter/Space and true saved state at ${viewport.width}px`, async testContext => {
    const { page } = await openApp(testContext, viewport);
    const author = page.locator('#view-feed .post-author').filter({ hasText: 'Fixture Peer' });
    assert.equal(await author.getAttribute('role'), 'button');
    assert.equal(await author.getAttribute('tabindex'), '0');
    await author.focus(); await author.press('Enter');
    assert.match(await page.locator('#modal .vp-name').innerText(), /Fixture Peer/);
    await page.locator('#modal .modal-head button').last().click();
    await author.focus(); const scroll = await page.evaluate(() => window.scrollY);
    await author.press(' ');
    assert.match(await page.locator('#modal .vp-name').innerText(), /Fixture Peer/);
    assert.equal(await page.evaluate(() => window.scrollY), scroll);
    await page.locator('#modal .modal-head button').last().click();
    const save = page.locator('#view-feed [data-saved-post="post-peer"]');
    assert.equal(await save.getAttribute('aria-pressed'), 'false');
    await save.click();
    assert.equal(await save.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => Social.isSaved('post-peer')), true);
    await author.focus(); await author.press('Enter');
    const modalSave = page.locator('#modal [data-saved-post="post-peer"]');
    assert.equal(await modalSave.getAttribute('aria-pressed'), 'true');
    await modalSave.click();
    assert.equal(await modalSave.getAttribute('aria-pressed'), 'false');
    assert.equal(await save.getAttribute('aria-pressed'), 'false');
    assert.equal(await page.evaluate(() => Social.isSaved('post-peer')), false);
    assert.ok(await author.evaluate(element => element.scrollWidth <= element.clientWidth));
  });
}

test('DEF-064 browser: acknowledgement preserves newer editing and an unrelated open modal', async testContext => {
  const { page, state } = await openApp(testContext);
  await thread(page); await messageOption(page, 'Edit');
  await page.locator('#dm-edit').fill('Submitted edit');
  const gate = state.hold('messages', 'PATCH', 'dm-own');
  await page.locator('#dm-save').click(); await gate.started;
  await page.locator('#dm-edit').fill('Newer unsent edit');
  await page.getByRole('button', { name: 'Chat details', exact: true }).click();
  gate.release(200);
  await page.waitForFunction(() => !Social._pendingActions.size);
  assert.equal(await page.locator('#dm-edit').inputValue(), 'Newer unsent edit');
  assert.equal(await page.locator('#modal .modal-head h2').innerText(), 'Chat details');
  assert.deepEqual(await bodies(page), [initialBodies[0], 'Submitted edit', initialBodies[2]]);
  assert.equal(state.messages.get('dm-own').body, 'Submitted edit');
});

test('DEF-064 browser: a lost unsend followed by absence never announces a forged success', async testContext => {
  const { page, state } = await openApp(testContext);
  await thread(page);
  const gate = state.hold('messages', 'DELETE', 'dm-own'); gate.release('lost');
  await messageOption(page, 'Unsend'); await gate.started;
  await page.waitForFunction(() => !Social._pendingActions.size);
  assert.equal(state.messages.has('dm-own'), false);
  assert.deepEqual(await bodies(page), initialBodies);
  await messageOption(page, 'Unsend');
  await page.waitForFunction(() => !Social._pendingActions.size);
  assert.deepEqual(await bodies(page), initialBodies);
  assert.match(await page.locator('.toast').last().innerText(), /could not confirm unsend/i);
  await page.evaluate(() => Social.refreshDM());
  assert.deepEqual(await bodies(page), initialBodies);
});

test('DEF-064 browser: a 404 history read retains exact cached bubbles and retries successfully', async testContext => {
  const { page, state } = await openApp(testContext);
  await thread(page); await page.locator('#dm-text').fill('Draft during read failure');
  const gate = state.hold('messages', 'GET'); gate.release(404);
  await page.evaluate(() => Social.refreshDM());
  assert.deepEqual(await bodies(page), initialBodies);
  assert.equal(await page.locator('#dm-text').inputValue(), 'Draft during read failure');
  await page.locator('#chat-thread').getByRole('button', { name: 'Retry', exact: true }).click();
  await page.waitForFunction(() => !Social._dmReadError);
  assert.deepEqual(await bodies(page), initialBodies);
});

test('publishing browser: logout clears private drafts and the next account gets a fresh ID and owner', async testContext => {
  const { page, state } = await openApp(testContext);
  await page.locator('#post-text').fill('Private owner draft');
  const gate = state.hold('posts', 'POST');
  await page.locator('#post-publish').click(); const first = await gate.started;
  await page.locator('button[data-tab="profile"]').click();
  await page.locator('.ph-logout-ic').click();
  await page.getByRole('button', { name: 'Log out', exact: true }).last().click();
  await page.locator('#auth-overlay:not(.hidden)').waitFor();
  gate.release(503);
  await page.locator('#a-email').fill(members.get(peer).email);
  await page.locator('#a-pass').fill('FixtureOnly-2026');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await ready(page);
  assert.equal(await page.locator('#post-text').inputValue(), '');
  assert.equal(await page.evaluate(() => Social._postRequest), null);
  assert.equal(await page.evaluate(() => Social.pendingPhotos.length), 0);
  assert.equal(await page.evaluate(() => Cloud._publishingUid()), peer);
  await page.locator('#post-text').fill('A different account post');
  await page.locator('#post-publish').click();
  await page.waitForFunction(() => document.getElementById('post-text').value === '');
  const write = state.writes.filter(entry => entry.table === 'posts').at(-1);
  assert.notEqual(write.id, first.id); assert.equal(write.body.author, peer); assert.equal(write.uid, peer);
  assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('Private owner draft'))), false);
});

test('browser fixture rejects anonymous and forged native owners without registering accounts', async testContext => {
  const { page, state } = await openApp(testContext);
  const results = await page.evaluate(async ({ peer, owner }) => {
    const send = (headers, body) => fetch('/rest/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) }).then(response => response.status);
    return [await send({ 'Content-Type': 'application/json' }, { id: 'anon', from_uid: owner, to_uid: peer, body: 'Denied' }),
      await send({ 'Content-Type': 'application/json', Authorization: 'Bearer fixture-owner-token' }, { id: 'forged', from_uid: peer, to_uid: owner, body: 'Denied' })];
  }, { peer, owner });
  assert.deepEqual(results, [401, 403]);
  assert.equal(state.messages.size, 3);
  assert.equal(state.accounts.size, 2);
  assert.equal(publicAsset('/office/board.json'), null);
  assert.equal(publicAsset('/backups/private.json'), null);
  assert.equal(publicAsset('/tests/social-publishing.e2e.cjs'), null);
});

test('DEF-065 browser: video asset and caption survive a rejected post without another upload', async testContext => {
  const { page, state } = await openApp(testContext, { width: 390, height: 844 });
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
    const drawing = canvas.getContext('2d'), stream = canvas.captureStream(10), chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start(); drawing.fillStyle = '#27a183'; drawing.fillRect(0, 0, 32, 32);
    await new Promise(resolve => setTimeout(resolve, 150));
    recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop());
    return Array.from(new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer()));
  });
  assert.ok(bytes.length > 100);
  await page.locator('#post-text').fill('Caption with an uploaded video');
  await page.locator('#view-feed .composer-actions').getByRole('button', { name: 'Flex', exact: true }).click();
  const choosing = page.waitForEvent('filechooser');
  await page.locator('#modal .sheet-btn:not(.cancel)').last().click();
  await (await choosing).setFiles({ name: 'fixture.webm', mimeType: 'video/webm', buffer: Buffer.from(bytes) });
  await page.waitForFunction(() => document.querySelector('.composer-video video')?.videoWidth > 0);
  const source = await page.locator('.composer-video video').getAttribute('src');
  assert.equal(state.mediaWrites.length, 1);
  assert.equal(state.mediaWrites[0].uid, owner);
  const gate = state.hold('posts', 'POST'); gate.release(503);
  await page.locator('#post-publish').click(); const first = await gate.started;
  await page.waitForFunction(() => !Social._pendingActions.size);
  assert.equal(await page.locator('.composer-video video').getAttribute('src'), source);
  assert.equal(await page.locator('#post-text').inputValue(), 'Caption with an uploaded video');
  assert.equal(state.posts.size, 2);
  await page.getByRole('button', { name: 'Retry post', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('post-text').value === '');
  assert.equal(state.posts.get(first.id).data.video, source);
  assert.equal(state.posts.size, 3);
  assert.equal(state.mediaWrites.length, 1);
  assert.equal(await page.locator('.composer-video').count(), 0);
  await page.reload({ waitUntil: 'domcontentloaded' }); await ready(page);
  assert.equal(await page.locator('#view-feed .post-text').filter({ hasText: 'Caption with an uploaded video' }).count(), 1);
});