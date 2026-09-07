'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { createHmac, webcrypto } = require('node:crypto');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const password = 'Fixture-Only-Password42!';
const members = {
  A: { id: '11111111-1111-4111-8111-111111111111', email: 'lifecycle.a@example.test', name: 'Lifecycle Alpha' },
  B: { id: '22222222-2222-4222-8222-222222222222', email: 'lifecycle.b@example.test', name: 'Lifecycle Beta' },
};
const edgeEnvironment = {
  SUPABASE_URL: 'https://auth-fixture.invalid', SUPABASE_ANON_KEY: 'fixture-public-anon',
  SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role-not-a-real-token',
  RAZORPAY_KEY_ID: 'rzp_test_fixture', RAZORPAY_KEY_SECRET: 'fixture-provider-secret',
  LEMONSQUEEZY_API_KEY: 'fixture-provider-api-key', LS_WEBHOOK_SECRET: 'fixture-signing-secret-not-production',
  LS_STORE_ID: '42', LS_VARIANT_PRO: '101', LS_VARIANT_ELITE: '102',
  LS_RETURN_URL: 'https://return-fixture.invalid/completed', LS_TEST_MODE: 'true',
};
const edgeSources = new Map();
const tierScenarios = [
  { name: 'Free', tier: 'free', effective: 'free', paid: false, elite: false },
  { name: 'Pro', tier: 'pro', effective: 'pro', paid: true, elite: false },
  { name: 'Elite', tier: 'elite', effective: 'elite', paid: true, elite: true },
  { name: 'Expired Elite', tier: 'elite', effective: 'free', paid: false, elite: false, end: '2001-01-01T00:00:00Z' },
];
const mimeTypes = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.txt': 'text/plain',
};
const blankImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=', 'base64');
let server, browser, origin;

function assetPath(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded === '/') decoded = '/index.html';
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(segment => segment.startsWith('.'))) return null;
  const allowed = /^\/(index\.html|legal\.html|manifest\.webmanifest|version\.txt|favicon\.ico)$/.test(decoded)
    || /^\/js\/[a-zA-Z0-9_/-]+\.js$/.test(decoded)
    || /^\/css\/[a-zA-Z0-9_/-]+\.css$/.test(decoded)
    || /^\/(assets|icons)\/[a-zA-Z0-9_/-]+\.(json|png|jpe?g|webp|gif|svg|ico|woff2|mp4|webm|mp3)$/.test(decoded);
  if (!allowed) return null;
  const resolved = path.resolve(root, '.' + decoded);
  try {
    if (!fs.statSync(resolved).isFile() || fs.realpathSync(resolved) !== resolved) return null;
  } catch { return null; }
  return resolved.startsWith(root + path.sep) ? resolved : null;
}

function configOverrides() {
  return `\nObject.assign(window, {
    SUPABASE_URL: ${JSON.stringify(origin)}, SUPABASE_ANON_KEY: 'fixture-public-anon',
    USE_SUPABASE_AUTH: true, GOOGLE_CLIENT_ID: '', GOOGLE_IOS_CLIENT_ID: '',
    POSTHOG_KEY: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '',
    EMAIL_FN_URL: '', SHEETS_API: '', SOCIAL_API: '', PEXELS_KEY: '', MOD_TOKEN: ''
  });
  if (window.Currency) Object.assign(Currency, { ready: true, cur: 'INR', rate: 83, country: 'IN' });\n`;
}

function edgeHandler(name, fetch) {
  const filename = path.join(root, 'supabase/functions', name, 'index.ts');
  if (!edgeSources.has(name)) edgeSources.set(name, stripTypeScriptTypes(fs.readFileSync(filename, 'utf8'), { mode: 'strip' }));
  let handler;
  vm.runInNewContext(edgeSources.get(name), {
    Deno: { serve: callback => { handler = callback; }, env: { get: key => edgeEnvironment[key] } },
    Request, Response, URL, Headers, AbortController, AbortSignal, TextEncoder, TextDecoder, Uint8Array,
    crypto: webcrypto, btoa, fetch,
  }, { filename, timeout: 1000 });
  assert.equal(typeof handler, 'function');
  return handler;
}

before(async () => {
  server = http.createServer((request, response) => {
    const file = assetPath(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!file || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404, { 'Cache-Control': 'no-store' }).end();
      return;
    }
    let body = fs.readFileSync(file);
    if (file === path.join(root, 'js/config.js')) body = Buffer.from(body.toString() + configOverrides());
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OFFICE_BROWSER_EXECUTABLE || undefined,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-domain-reliability',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
});

after(async () => {
  try { if (browser) await browser.close(); }
  finally {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
});

function fixtureBackend() {
  const fixture = {
    users: new Map(), tokens: new Map(), refreshTokens: new Map(), serial: 0,
    entitlements: new Map(), accounts: new Map(), profiles: new Map(), requests: [], unexpected: [],
    external: [], assets: [], errors: [], consoleErrors: [], expectedConsoleErrors: [], faults: [], gates: [],
    supportTickets: [], posts: new Map(), comments: new Map(), reports: [], media: new Map(),
    orders: [], checkouts: [], capturedPayments: [], serverRequests: [], issuedCheckoutURLs: new Set(),
    handlers: new Map(), checkoutURLOverride: null, rejections: [],
    events: new EventEmitter(),
  };
  fixture.waitFor = (predicate, label, timeout = 6000) => {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); fixture.events.off('change', check); };
      const check = () => { if (predicate()) { cleanup(); resolve(); } };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Fixture timeout: ' + label)); }, timeout);
      fixture.events.on('change', check);
    });
  };
  fixture.holdNext = predicate => {
    let resolve;
    const gate = { predicate, started: false, promise: new Promise(done => { resolve = done; }), resolve: () => resolve() };
    fixture.gates.push(gate);
    return gate;
  };
  fixture.failNext = (method, pathname, status, targetId) => {
    const fault = { method, pathname, status, targetId, used: false };
    fixture.faults.push(fault);
    return fault;
  };
  fixture.expectRejection = (method, pathname, status) => {
    fixture.rejections.push({ method, pathname, status, seen: false });
  };
  fixture.issueSession = member => {
    const serial = ++fixture.serial;
    const accessToken = `fixture-access-${member.id}-${serial}`;
    const refreshToken = `fixture-refresh-${member.id}-${serial}`;
    fixture.tokens.set(accessToken, member.id);
    fixture.refreshTokens.set(refreshToken, member.id);
    return { access_token: accessToken, refresh_token: refreshToken, expires_in: 3600,
      token_type: 'bearer', user: { id: member.id, email: member.email, user_metadata: { name: member.name } } };
  };
  fixture.identity = request => fixture.tokens.get((request.headers().authorization || '').replace(/^Bearer /, ''));
  fixture.grant = (member, tier, end = '2099-01-01T00:00:00Z') => {
    fixture.entitlements.set(member.id, { uid: member.id, tier, status: 'active', current_period_end: end });
  };
  fixture.seedSocial = () => {
    for (const member of Object.values(members)) {
      fixture.profiles.set(member.id, { uid: member.id, data: { name: member.name, username: member.id === members.A.id ? 'alpha' : 'beta',
        privacy: 'public', tier: 'free', verified: true, following: [] } });
    }
    for (const [id, member, text] of [
      ['post-a', members.A, 'Alpha original caption'], ['post-b', members.B, 'Beta original caption'],
      ['post-b-extra', members.B, 'Another Beta update'],
    ]) fixture.posts.set(id, { id, author: member.id, data: { text, tag: 'Fixture training', photo: null }, likes: {}, ts: Date.now() - 60000 });
    for (const [id, member, body, parentId] of [
      ['comment-a', members.A, 'Alpha original comment', null],
      ['comment-b', members.B, 'Beta fixture comment', null],
      ['comment-reply-b', members.B, 'Threaded fixture reply', 'comment-a'],
    ]) fixture.comments.set(id, { id, author: member.id, post_id: 'post-a', body, parent_id: parentId, mentions: [], ts: Date.now() - 30000 });
  };
  fixture.serverFetch = async (input, options = {}) => {
    const url = new URL(input), headers = new Headers(options.headers);
    const body = options.body ? JSON.parse(options.body) : null;
    fixture.serverRequests.push({ url: url.href, method: options.method || 'GET', authorization: headers.get('authorization'), body });
    if (url.origin === edgeEnvironment.SUPABASE_URL) {
      if (url.pathname === '/auth/v1/user') {
        const uid = fixture.tokens.get((headers.get('authorization') || '').replace(/^Bearer /, ''));
        const member = fixture.users.get(uid);
        return member ? Response.json({ id: member.id, email: member.email }) : Response.json({ error: 'invalid_fixture_token' }, { status: 401 });
      }
      if (url.pathname === '/rest/v1/entitlements' && headers.get('authorization') === 'Bearer ' + edgeEnvironment.SUPABASE_SERVICE_ROLE_KEY) {
        const row = fixture.entitlements.get(url.searchParams.get('uid')?.slice(3));
        return Response.json(row ? [row] : []);
      }
    }
    if (url.href === 'https://api.razorpay.com/v1/orders' && options.method === 'POST') {
      const expected = 'Basic ' + Buffer.from(edgeEnvironment.RAZORPAY_KEY_ID + ':' + edgeEnvironment.RAZORPAY_KEY_SECRET).toString('base64');
      if (headers.get('authorization') !== expected) return Response.json({ error: 'bad_fixture_provider_credentials' }, { status: 401 });
      const order = { ...body, id: 'order_fixture_' + (fixture.orders.length + 1), status: 'created' };
      fixture.orders.push(order);
      return Response.json({ id: order.id, amount: order.amount, currency: order.currency });
    }
    if (url.href === 'https://api.lemonsqueezy.com/v1/checkouts' && options.method === 'POST') {
      if (headers.get('authorization') !== 'Bearer ' + edgeEnvironment.LEMONSQUEEZY_API_KEY) return Response.json({ error: 'bad_fixture_provider_credentials' }, { status: 401 });
      const id = 'cccccccc-cccc-4ccc-8ccc-' + String(fixture.checkouts.length + 1).padStart(12, '0');
      const checkout = { id, payload: body, url: fixture.checkoutURLOverride || 'https://fixture-store.lemonsqueezy.com/checkout/custom/' + id };
      fixture.checkouts.push(checkout);
      return Response.json({ data: { type: 'checkouts', id, attributes: {
        url: checkout.url, store_id: Number(body.data.relationships.store.data.id),
        variant_id: Number(body.data.relationships.variant.data.id), test_mode: body.data.attributes.test_mode,
      } } });
    }
    fixture.unexpected.push({ serverFetch: url.href, method: options.method || 'GET' });
    return Response.json({ error: 'unimplemented_fixture_provider' }, { status: 501 });
  };
  fixture.capturePayment = id => {
    const order = fixture.orders.find(candidate => candidate.id === id);
    assert.ok(order, 'Only an issued fixture order can be captured');
    assert.equal(order.status, 'created');
    order.status = 'captured';
    fixture.capturedPayments.push({ order_id: order.id, uid: order.notes.uid, amount: order.amount, tier: order.notes.tier });
    fixture.grant({ id: order.notes.uid }, order.notes.tier);
  };
  fixture.handle = async route => {
    const request = route.request(), url = new URL(request.url());
    let body = null;
    if (request.postData()) {
      try { body = request.postDataJSON(); } catch { body = request.postData(); }
    }
    const record = { pathname: url.pathname, query: url.search, method: request.method(),
      authorization: request.headers().authorization || '', uid: fixture.identity(request), body };
    fixture.requests.push(record);
    const send = async (status, json) => {
      const response = structuredClone(json);
      const expected = fixture.rejections.find(rejection => !rejection.seen && rejection.method === record.method
        && rejection.pathname === record.pathname && rejection.status === status);
      if (expected) { expected.seen = true; record.injectedFailure = true; }
      const gate = fixture.gates.find(candidate => !candidate.started && candidate.predicate(record));
      if (gate) {
        gate.started = true;
        fixture.events.emit('change');
        await gate.promise;
      }
      record.status = status;
      fixture.events.emit('change');
      return route.fulfill({ status, json: response });
    };
    if (url.pathname.startsWith('/storage/v1/object/public/media/')) {
      const object = fixture.media.get(url.pathname);
      if (!object) return send(404, { error: 'Unknown fixture media' });
      record.status = 200; fixture.events.emit('change');
      return route.fulfill({ status: 200, contentType: object.type, body: object.bytes });
    }
    if (url.pathname.startsWith('/storage/v1/object/media/') && request.method() === 'POST') {
      if (!record.uid || !url.pathname.startsWith('/storage/v1/object/media/covers/' + record.uid + '/')) return send(403, { error: 'Fixture upload owner mismatch' });
      const fault = fixture.faults.find(candidate => !candidate.used && candidate.method === 'POST' && url.pathname.startsWith(candidate.pathname));
      if (fault) {
        fault.used = true; record.injectedFailure = true;
        return send(fault.status, { error: 'Fixture upload failed' });
      }
      const publicPath = url.pathname.replace('/object/media/', '/object/public/media/');
      fixture.media.set(publicPath, { bytes: request.postDataBuffer(), type: request.headers()['content-type'] });
      return send(201, { Key: publicPath });
    }
    if (url.pathname.startsWith('/functions/v1/')) {
      const name = url.pathname.slice('/functions/v1/'.length);
      if (['razorpay-create-order', 'create-checkout'].includes(name)) {
        if (!fixture.handlers.has(name)) fixture.handlers.set(name, edgeHandler(name, fixture.serverFetch));
        const response = await fixture.handlers.get(name)(new Request(url.href, {
          method: request.method(), headers: request.headers(), body: request.postData() || undefined,
        }));
        const result = await response.json();
        if (name === 'create-checkout' && response.ok) fixture.issuedCheckoutURLs.add(result.url);
        return send(response.status, result);
      }
    }
    if (url.pathname.startsWith('/auth/v1/')) {
      const endpoint = url.pathname.slice('/auth/v1/'.length);
      if (endpoint === 'signup') {
        const member = Object.values(members).find(candidate => candidate.email === body?.email);
        if (!member || body.password !== password) return send(400, { msg: 'Unknown fixture signup' });
        if (fixture.users.has(member.id)) return send(422, { msg: 'Fixture member already registered' });
        fixture.users.set(member.id, { ...member, password: body.password });
        return send(200, fixture.issueSession(member));
      }
      if (endpoint === 'token') {
        const grant = url.searchParams.get('grant_type');
        const member = grant === 'refresh_token'
          ? fixture.users.get(fixture.refreshTokens.get(body?.refresh_token))
          : [...fixture.users.values()].find(candidate => candidate.email === body?.email && candidate.password === body?.password);
        if (!member) return send(401, { error_description: 'Invalid fixture credentials' });
        return send(200, fixture.issueSession(member));
      }
      if (!record.uid) return send(401, { msg: 'Fixture Bearer token required' });
      const member = fixture.users.get(record.uid);
      const publicUser = member ? { id: member.id, email: member.email, user_metadata: { name: member.name } } : null;
      if (endpoint === 'user') return send(200, publicUser);
      if (endpoint === 'session') return send(200, { user: publicUser });
      if (endpoint === 'logout') return send(200, {});
    }
    if (url.pathname.startsWith('/rest/v1/')) {
      if (!record.uid) return send(401, { message: 'Fixture RLS requires authentication' });
      const requestedUid = url.searchParams.get('uid');
      if (requestedUid?.startsWith('eq.') && requestedUid.slice(3) !== record.uid) return send(200, []);
      if (body?.uid && body.uid !== record.uid) return send(403, { message: 'Fixture RLS owner mismatch' });
      if (body?.author && body.author !== record.uid) return send(403, { message: 'Fixture RLS author mismatch' });
      if (body?.reporter && body.reporter !== record.uid) return send(403, { message: 'Fixture RLS reporter mismatch' });
      if (['PATCH', 'DELETE'].includes(record.method) && url.searchParams.has('author') && url.searchParams.get('author') !== 'eq.' + record.uid) {
        return send(403, { message: 'Fixture RLS caller must match token' });
      }
      const fault = fixture.faults.find(candidate => !candidate.used && candidate.method === record.method
        && candidate.pathname === record.pathname && (!candidate.targetId || url.searchParams.get('id') === 'eq.' + candidate.targetId));
      if (fault) {
        fault.used = true;
        record.injectedFailure = true;
        if (fault.status === 'offline') {
          record.status = 'offline';
          fixture.events.emit('change');
          return route.abort('internetdisconnected');
        }
        return send(fault.status, { message: 'Deliberately injected fixture write failure' });
      }
      if (url.pathname === '/rest/v1/support_tickets') {
        if (request.method() === 'POST' && body?.uid === record.uid) {
          fixture.supportTickets.push({ ...structuredClone(body), id: 'fixture-ticket-' + (fixture.supportTickets.length + 1) });
          return send(201, []);
        }
        if (request.method() === 'GET') return send(200, fixture.supportTickets.filter(ticket => ticket.uid === record.uid));
      }
      if (['/rest/v1/posts', '/rest/v1/comments'].includes(url.pathname)) {
        const table = url.pathname.endsWith('/posts') ? fixture.posts : fixture.comments;
        const id = url.searchParams.get('id')?.slice(3);
        if (request.method() === 'GET') return send(200, [...table.values()].filter(row => !id || row.id === id));
        if (request.method() === 'POST') {
          if (!body?.id || body.author !== record.uid || (table.has(body.id) && table.get(body.id).author !== record.uid)) {
            return send(403, { message: 'Fixture RLS insert requires the token owner' });
          }
          table.set(body.id, { ...structuredClone(body), ts: Date.now() });
          return send(201, [{ id: body.id }]);
        }
        const row = table.get(id);
        if (!row) return send(200, []);
        if (row.author !== record.uid) return send(403, { message: 'Fixture RLS cannot mutate another author' });
        if (request.method() === 'PATCH') {
          table.set(id, { ...row, ...structuredClone(body), id, author: record.uid });
          return send(200, [{ id }]);
        }
        if (request.method() === 'DELETE') {
          table.delete(id);
          return send(200, [{ id }]);
        }
      }
      if (url.pathname === '/rest/v1/content_reports') {
        if (request.method() === 'POST') {
          const target = body.kind === 'post' ? fixture.posts.get(body.target_id)
            : body.kind === 'comment' ? fixture.comments.get(body.target_id) : fixture.profiles.get(body.target_id);
          if (!target || body.reporter !== record.uid || (target.author || target.uid) !== body.reported_uid) {
            return send(403, { message: 'Fixture report identity or target mismatch' });
          }
          fixture.reports.push({ ...structuredClone(body), id: 'fixture-report-' + (fixture.reports.length + 1) });
          return send(201, []);
        }
        if (request.method() === 'GET') return send(200, fixture.reports.filter(report => report.reporter === record.uid));
      }
      if (url.pathname === '/rest/v1/entitlements' && request.method() === 'GET') {
        const row = fixture.entitlements.get(record.uid);
        return send(200, row ? [row] : []);
      }
      if (url.pathname === '/rest/v1/accounts') {
        if (request.method() === 'GET') return send(200, fixture.accounts.has(record.uid) ? [fixture.accounts.get(record.uid)] : []);
        if (request.method() === 'POST' && body?.uid === record.uid) {
          fixture.accounts.set(record.uid, structuredClone(body));
          return send(201, []);
        }
      }
      if (url.pathname === '/rest/v1/profiles') {
        if (request.method() === 'POST' && body?.uid === record.uid) {
          fixture.profiles.set(record.uid, structuredClone(body));
          return send(201, []);
        }
        if (request.method() === 'GET') {
          const username = url.searchParams.get('data->>username')?.slice(3);
          const excluded = url.searchParams.get('uid')?.startsWith('neq.') ? url.searchParams.get('uid').slice(4) : null;
          return send(200, [...fixture.profiles.values()].filter(row => row.uid !== excluded && (!username || row.data.username === username)));
        }
      }
      if (url.pathname === '/rest/v1/rpc/get_state') return send(200, {
        users: Object.fromEntries([...fixture.profiles].map(([uid, row]) => [uid, { ...row.data, uid }])),
        posts: Object.fromEntries([...fixture.posts].map(([id, row]) => [id, { ...row.data, id, author: row.author, likes: row.likes, ts: row.ts }])),
        comments: Object.fromEntries(fixture.comments), requests: {}, stories: {},
      });
      if (url.pathname === '/rest/v1/notifications' && ['GET', 'PATCH'].includes(request.method())) return send(200, []);
    }
    fixture.unexpected.push(record);
    return send(501, { message: 'Unimplemented isolated fixture endpoint', path: url.pathname });
  };
  return fixture;
}

async function setup(testContext, { width = 390, height = 844, backend = null } = {}) {
  const fixture = backend || fixtureBackend();
  const context = await browser.newContext({
    viewport: { width, height }, hasTouch: true, isMobile: width < 760,
    reducedMotion: 'reduce', serviceWorkers: 'block', permissions: ['camera', 'microphone'],
  });
  testContext.after(async () => {
    for (const gate of fixture.gates) gate.resolve();
    await context.close();
    assert.deepEqual(fixture.unexpected, [], 'All backend calls must have an explicit isolated fixture');
    assert.deepEqual(fixture.errors, [], 'No uncaught JavaScript errors');
    assert.deepEqual(fixture.consoleErrors, [], 'No unexpected console errors');
    assert.ok(fixture.faults.every(fault => fault.used), 'Every requested failure must actually be exercised');
    assert.ok(fixture.rejections.every(rejection => rejection.seen), 'Every expected owner/auth rejection must actually occur');
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) {
      fixture.external.push({ url: request.url(), type: request.resourceType() });
      if (fixture.issuedCheckoutURLs.has(url.href) && url.hostname === 'fixture-store.lemonsqueezy.com' && request.resourceType() === 'document') {
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>Isolated checkout fixture</title><link rel="icon" href="data:,"></head><body><h1>Isolated provider checkout</h1></body></html>' });
      }
      if (request.resourceType() === 'stylesheet') return route.fulfill({ contentType: 'text/css', body: '' });
      if (request.resourceType() === 'image') return route.fulfill({ contentType: 'image/png', body: blankImage });
      fixture.unexpected.push({ external: request.url(), method: request.method() });
      return route.abort('blockedbyclient');
    }
    if (/^\/(auth|rest|functions|storage)\//.test(url.pathname)) return fixture.handle(route);
    fixture.assets.push(url.pathname);
    return route.continue();
  });
  await context.routeWebSocket('**/*', socket => {
    fixture.unexpected.push({ websocket: socket.url() });
    socket.close();
  });
  await context.addInitScript(() => {
    localStorage.setItem('fm_dl_x', '1');
    window.__fixtureMail = [];
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  page.setDefaultNavigationTimeout(10000);
  page.on('pageerror', error => fixture.errors.push(error.stack || error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const location = message.location().url || '';
    const expected = message.text().startsWith('Failed to load resource:')
      && fixture.requests.some(request => request.injectedFailure && location.startsWith(origin + request.pathname));
    if (expected) fixture.expectedConsoleErrors.push(message.text());
    else fixture.consoleErrors.push(message.text());
  });
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  await page.locator('#a-email').waitFor();
  return { context, page, fixture };
}

async function signup(page, fixture, member = members.A) {
  await page.evaluate(() => {
    Mailer.canSendCodes = () => true;
    Mailer.sendCode = async (to, code, name) => {
      window.__fixtureMail.push({ to, code, name });
      return { sent: true, via: 'in-memory-fixture' };
    };
  });
  await page.getByText('Create an account', { exact: true }).click();
  await page.locator('#s-name').fill(member.name);
  await page.locator('#s-email').fill(member.email);
  await page.locator('#s-pass').fill(password);
  await page.locator('#s-pass2').fill(password);
  await page.locator('button[onclick="App.doSignupStart()"]').click();
  await page.locator('#d-dob').fill('1995-01-01');
  await page.locator('#d-h').fill(member.id === members.A.id ? '178' : '165');
  await page.locator('#d-w').fill(member.id === members.A.id ? '80' : '60');
  await page.locator('#d-tw').fill(member.id === members.A.id ? '76' : '64');
  await page.locator('#d-exp').selectOption('intermediate');
  await page.locator('#d-diet').selectOption('veg');
  await page.locator('#d-physique').selectOption('lean_aesthetic');
  await page.getByRole('button', { name: 'Create my account', exact: true }).click();
  await page.locator('#o-code').waitFor();
  const delivery = await page.evaluate(() => ({
    code: Auth.pending.otp, delivered: Auth.pending.delivered,
    mail: window.__fixtureMail.at(-1), user: Auth.currentUser(),
  }));
  assert.equal(delivery.delivered, true, 'Auth must acknowledge the mock mailer');
  assert.equal(delivery.mail.to, member.email);
  assert.equal(delivery.mail.code, delivery.code);
  assert.equal(delivery.user, null, 'OTP must precede the local signed-in state');
  assert.equal(fixture.users.has(member.id), false, 'No backend signup before OTP verification');
  assert.equal(await page.locator('.otp-demo').count(), 0, 'Delivered code must not be displayed as demo OTP');
  await page.locator('#o-code').fill(delivery.code === '000000' ? '111111' : '000000');
  await page.getByRole('button', { name: 'Verify & continue', exact: true }).click();
  assert.notEqual(await page.locator('#auth-err').innerText(), '');
  assert.equal(fixture.users.has(member.id), false, 'Incorrect OTP must not create a backend user');
  await page.locator('#o-code').fill(delivery.code);
  await page.getByRole('button', { name: 'Verify & continue', exact: true }).click();
  await page.locator('#app-shell:not(.hidden)').waitFor();
  await page.waitForFunction(uid => Entitlements.ready() && SupaAuth.uid() === uid, member.id);
  if (await page.locator('#modal:not(.hidden)').isVisible()) {
    await page.locator('#modal-card [onclick="App.closeModal()"]').first().click();
  }
  assert.equal(await page.evaluate(() => Store.state.profile.onboarded), true);
  assert.equal(await page.evaluate(() => Auth.currentUser().emailVerified), true);
  assert.equal(fixture.users.has(member.id), true);
}

async function login(page, member = members.A) {
  await page.locator('#a-email').fill(member.email);
  await page.locator('#a-pass').fill(password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.locator('#app-shell:not(.hidden)').waitFor();
  await page.waitForFunction(uid => Entitlements.ready() && SupaAuth.uid() === uid, member.id);
}

async function logout(page, member = members.A) {
  await page.locator('#tabbar [data-tab="profile"]').click();
  await page.locator('.ph-logout-ic').click();
  await page.getByRole('dialog', { name: 'Log out of Formora?' }).waitFor();
  assert.equal(await page.evaluate(() => SupaAuth.uid()), member.id);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('.sheet-wrap').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => SupaAuth.uid()), member.id, 'Cancel keeps the session');
  await page.locator('.ph-logout-ic').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Log out', exact: true }).click();
  await page.locator('#a-email').waitFor();
  assert.equal(await page.locator('#app-shell').isVisible(), false);
  assert.equal(await page.evaluate(() => localStorage.getItem('formora_supa_session')), null);
}

async function nutrition(page) {
  await page.locator('#tabbar [data-tab="coach"]').click();
  await page.locator('#coach-subnav button').filter({ hasText: /Meals|Nutrition/ }).click();
  await page.locator('#f-text').waitFor();
}

async function progress(page) {
  await page.locator('#tabbar [data-tab="coach"]').click();
  await page.locator('#coach-subnav button').filter({ hasText: 'Progress' }).click();
  await page.locator('#w-input').waitFor();
}

async function reviewWeight(page, current = 78) {
  await progress(page);
  await page.locator('#w-input').fill(String(current));
  await page.locator('button[onclick="App.saveWeight()"]').click();
}

async function chooseCover(page) {
  await page.locator('#tabbar [data-tab="profile"]').click();
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 240;
    const context = canvas.getContext('2d');
    context.fillStyle = '#278a7d'; context.fillRect(0, 0, 300, 240);
    context.fillStyle = '#edb347'; context.fillRect(300, 0, 300, 240);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.locator('.ph-cover-edit input[type="file"]').setInputFiles({ name: 'fixture-cover.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
}

test('cover upload publishes only an image URL and a fresh second account retrieves the same object', { timeout: 45000 }, async testContext => {
  const { page, fixture } = await setup(testContext);
  await signup(page, fixture);
  await chooseCover(page);
  await page.waitForFunction(() => Store.state.profile.coverUrl || /Could not|could not/.test(document.getElementById('toast')?.textContent || ''));
  const coverState = await page.evaluate(() => ({ pending: Store.state.profile.coverPending, url: Store.state.profile.coverUrl,
    local: Store.state.profile.cover?.slice(0, 30), message: document.getElementById('toast')?.textContent,
    current: App._isCurrentEntry(App._entry, Auth.currentUser()), key: Store.key, sync: !!App._coverSync }));
  assert.ok(coverState.url && !coverState.pending, JSON.stringify({ coverState, errors: fixture.consoleErrors, requests: fixture.requests.slice(-5).map(request => ({ path: request.pathname, status: request.status })) }));
  const publicUrl = await page.evaluate(() => Store.state.profile.coverUrl);
  assert.equal(fixture.profiles.get(members.A.id).data.cover, publicUrl);
  assert.doesNotMatch(JSON.stringify(fixture.profiles.get(members.A.id)), /data:image/);
  const media = fixture.media.get(new URL(publicUrl).pathname);
  assert.ok(media.bytes.length > 500 && media.type === 'image/jpeg');
  const other = await setup(testContext, { backend: fixture });
  await signup(other.page, fixture, members.B);
  await other.page.waitForFunction(uid => Social.cloud.users.some(user => user.uid === uid), members.A.id);
  await other.page.evaluate(uid => Social.viewProfile(uid), members.A.id);
  await fixture.waitFor(() => fixture.requests.some(request => request.pathname === new URL(publicUrl).pathname && request.method === 'GET' && request.status === 200), 'second-user public cover retrieval');
  assert.ok((await other.page.locator('.vp-hero.has-cover').evaluate(element => getComputedStyle(element).backgroundImage)).includes(publicUrl));
  const decoded = await other.page.evaluate(async url => { const image = new Image(); image.src = url; await image.decode(); return { width: image.naturalWidth, height: image.naturalHeight }; }, publicUrl);
  assert.deepEqual(decoded, { width: 600, height: 240 });
  await screenshot(testContext, other.page, 'cover-second-account-390');
});

for (const failure of ['upload', 'profile']) {
  test(`cover ${failure} failure keeps the local image and a working retry`, { timeout: 30000 }, async testContext => {
    const { page, fixture } = await setup(testContext);
    await signup(page, fixture);
    const fault = fixture.failNext('POST', failure === 'upload' ? '/storage/v1/object/media/covers/' : '/rest/v1/profiles', 503);
    await chooseCover(page);
    await fixture.waitFor(() => fault.used, 'cover failure');
    const retry = page.getByRole('button', { name: 'Retry cover sync', exact: true });
    await retry.waitFor();
    await page.waitForFunction(() => !App._coverSync);
    assert.match(await page.evaluate(() => JSON.parse(localStorage.getItem('fm_cover_pending_' + SupaAuth.uid())).data), /^data:image\/jpeg/);
    assert.doesNotMatch(await page.evaluate(() => JSON.stringify(Store.state.profile)), /data:image/);
    assert.equal(await page.evaluate(() => Store.state.profile.coverUrl || ''), '');
    assert.equal(fixture.profiles.get(members.A.id).data.cover, '');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#app-shell:not(.hidden)').waitFor();
    await page.locator('#tabbar [data-tab="profile"]').click();
    await retry.click();
    await page.waitForFunction(() => Store.state.profile.coverUrl && !Store.state.profile.coverPending);
    assert.equal(fixture.profiles.get(members.A.id).data.cover, await page.evaluate(() => Store.state.profile.coverUrl));
    assert.equal(await retry.count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('fm_cover_pending_' + SupaAuth.uid())), null);
  });
}

test('a late cover upload never publishes to the next account', { timeout: 45000 }, async testContext => {
  const { page, fixture } = await setup(testContext);
  await signup(page, fixture);
  const gate = fixture.holdNext(request => request.pathname.startsWith('/storage/v1/object/media/covers/'));
  await chooseCover(page);
  await fixture.waitFor(() => gate.started, 'cover upload in flight');
  await logout(page);
  await signup(page, fixture, members.B);
  gate.resolve();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => Store.state.profile.cover || ''), '');
  assert.equal(await page.evaluate(() => Store.state.profile.coverUrl || ''), '');
  assert.equal(fixture.profiles.get(members.B.id).data.cover, '');
});

async function seedReviewPhotos(page, first = 30, last = 220) {
  await page.evaluate(({ first, last }) => {
    const photo = shade => {
      const canvas = document.createElement('canvas');
      canvas.width = 40; canvas.height = 56;
      const context = canvas.getContext('2d');
      context.fillStyle = `rgb(${shade}, ${shade}, ${shade})`;
      context.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    };
    window.__fixturePhotoTime ||= Date.now();
    localStorage.setItem(App._progKey(), JSON.stringify([
      { id: 'fixture-before', ts: window.__fixturePhotoTime - 14 * 86400000, url: photo(first),
        weightKg: Store.state.profile.startWeightKg, bodyFat: Engine.stats().bodyFat },
      { id: 'fixture-after', ts: window.__fixturePhotoTime, url: photo(last),
        weightKg: Store.latestWeight(), bodyFat: Engine.stats().bodyFat },
    ]));
  }, { first, last });
}

async function holdReviewImages(page) {
  await page.evaluate(() => {
    const NativeImage = window.Image;
    const gate = window.__reviewImageGate = { pending: [] };
    window.Image = function (...args) {
      const image = new NativeImage(...args);
      Object.defineProperty(image, 'onload', {
        set(callback) { image.addEventListener('load', event => gate.pending.push(() => callback.call(image, event)), { once: true }); },
      });
      return image;
    };
    window.Image.prototype = NativeImage.prototype;
    Object.setPrototypeOf(window.Image, NativeImage);
  });
}

async function releaseReviewImages(page, start = 0, count = 2) {
  const released = await page.evaluate(async ({ start, count }) => {
    const pending = window.__reviewImageGate.pending.splice(start, count);
    pending.forEach(callback => callback());
    await Promise.resolve();
    await Promise.resolve();
    return pending.length;
  }, { start, count });
  assert.equal(released, count, 'Release only the expected real decoded-image callbacks');
}

async function checkoutMocks(page) {
  await page.evaluate(() => {
    window.__razorpay = [];
    window.__upgradeOwners = [];
    window.Razorpay = class {
      constructor(options) { this.options = options; this.opened = false; window.__razorpay.push(this); }
      open() { this.opened = true; }
    };
    const choose = App.choosePlan;
    App.choosePlan = function (...args) {
      const result = choose.apply(this, args);
      window.__lastCheckoutPromise = result;
      return result;
    };
    const afterUpgrade = App._afterUpgrade;
    App._afterUpgrade = function (tier, owner) {
      window.__upgradeOwners.push({ tier, owner });
      return afterUpgrade.call(this, tier, owner);
    };
  });
}

async function pricing(page) {
  await page.locator('#tabbar [data-tab="profile"]').click();
  const entry = page.locator('#view-profile [onclick*="App.openPricing()"]').first();
  if (await entry.count()) await entry.click();
  else await page.evaluate(() => App.openPricing());
  await page.locator('#modal:not(.hidden) .pricing').waitFor();
}

function planCard(page, tier) {
  return page.locator('.ptier').filter({ has: page.locator('.pt-name').filter({ hasText: new RegExp('^' + (tier === 'elite' ? 'Elite' : 'Pro') + '$') }) });
}

async function checkout(page, tier = 'pro', rail = 'upi') {
  await pricing(page);
  await planCard(page, tier).getByRole('button', { name: rail === 'upi' ? 'Pay with UPI' : 'Choose ' + (tier === 'elite' ? 'Elite' : 'Pro'), exact: true }).click();
}

async function paymentCallback(page) {
  await page.evaluate(() => {
    const options = window.__razorpay[0].options;
    options.handler({ razorpay_order_id: options.order_id, razorpay_payment_id: 'pay_fixture_only', razorpay_signature: 'fixture_callback_not_a_webhook_signature' });
  });
}

async function closeModal(page) {
  await page.locator('#modal-card [onclick="App.closeModal()"]').first().click();
  await page.locator('#modal').waitFor({ state: 'hidden' });
}

async function walkTabs(page, fixture) {
  for (const tab of ['home', 'search', 'flex', 'coach', 'alerts', 'profile']) {
    await page.locator(`#tabbar [data-tab="${tab}"]`).click();
    assert.equal(await page.evaluate(() => App.curTab), tab);
    assert.equal(await page.locator('#wrap > .view.active').count(), 1);
  }
  assert.deepEqual(fixture.errors, [], 'All six tabs must have zero uncaught JavaScript errors');
  assert.deepEqual(fixture.consoleErrors, [], 'All six tabs must have zero console errors');
}

function postCard(page, id) {
  return page.locator('.post').filter({ has: page.locator(`button[onclick="Social.postMenu('${id}')"]`) });
}

async function postMenu(page, id, action) {
  await postCard(page, id).locator('.post-more').click();
  if (action) await page.getByRole('dialog').getByRole('button', { name: action, exact: true }).click();
}

async function confirmedClick(page, locator, message) {
  const prompt = page.waitForEvent('dialog');
  await Promise.all([
    prompt.then(async dialog => {
      assert.match(dialog.message(), message);
      await dialog.accept();
    }),
    locator.click(),
  ]);
}

async function socialReload(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#app-shell:not(.hidden)').waitFor();
  await page.waitForFunction(() => Social.cloud.feed.some(post => post.id === 'post-b'));
}

async function reportPost(page, id) {
  await postMenu(page, id, 'Report post');
  await page.getByRole('dialog', { name: 'Why are you reporting this?' }).getByRole('button', { name: 'Spam or scam', exact: true }).click();
}

async function deletePost(page, id) {
  await postMenu(page, id);
  await confirmedClick(page, page.getByRole('dialog').getByRole('button', { name: 'Delete post', exact: true }), /Delete this post/);
}

async function openComments(page) {
  if (!await page.locator('#cmts-post-a').isVisible()) {
    await page.locator('button[onclick="Social.toggleComments(\'post-a\')"]').click();
  }
  await page.locator('#ci-post-a').waitFor();
}

function commentMore(page, id) {
  return page.locator(`button[onclick="Social.commentMenu('${id}')"]`);
}

async function commentGeometry(page) {
  const more = commentMore(page, 'comment-b');
  await more.scrollIntoViewIfNeeded();
  return more.evaluate(button => {
    const bounds = element => {
      const rectangle = element.getBoundingClientRect();
      return { left: rectangle.left, top: rectangle.top, width: rectangle.width, height: rectangle.height,
        right: rectangle.right, bottom: rectangle.bottom };
    };
    const visual = bounds(button), reply = bounds(button.parentElement.querySelector('.cmt2-reply'));
    let target = { ...visual }, pseudo = null;
    for (const selector of ['::before', '::after']) {
      const style = getComputedStyle(button, selector);
      if (style.content === 'none' || style.content === 'normal' || style.display === 'none' || style.position !== 'absolute') continue;
      const width = Number.parseFloat(style.width), height = Number.parseFloat(style.height);
      if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
      const matrix = new DOMMatrix(style.transform === 'none' ? undefined : style.transform);
      const left = visual.left + Number.parseFloat(style.left) + matrix.m41;
      const top = visual.top + Number.parseFloat(style.top) + matrix.m42;
      if (!Number.isFinite(left) || !Number.isFinite(top)) continue;
      pseudo = { selector, width, height, left, top };
      target = { left: Math.min(target.left, left), top: Math.min(target.top, top),
        right: Math.max(target.right, left + width), bottom: Math.max(target.bottom, top + height) };
      target.width = target.right - target.left;
      target.height = target.bottom - target.top;
    }
    const overlap = Math.max(0, Math.min(target.right, reply.right) - Math.max(target.left, reply.left))
      * Math.max(0, Math.min(target.bottom, reply.bottom) - Math.max(target.top, reply.top));
    return { visual, target, pseudo, reply, overlap, viewport: { width: innerWidth, height: innerHeight } };
  });
}

async function commentAction(page, action) {
  const id = action === 'delete' ? 'comment-a' : 'comment-b';
  await openComments(page);
  await commentMore(page, id).click();
  if (action === 'delete') {
    await confirmedClick(page, page.getByRole('dialog').getByRole('button', { name: 'Delete comment', exact: true }), /Delete this comment/);
  } else await page.getByRole('dialog').getByRole('button', { name: 'Report comment', exact: true }).click();
}

async function openCamera(page) {
  await page.locator('#tabbar [data-tab="home"]').click();
  await page.locator('button[onclick="Social.pickPhotos()"]').click();
  await page.getByRole('button', { name: /Formora Camera \+ filters/ }).click();
  await page.locator('#cam-shutter').waitFor();
  await page.waitForFunction(() => {
    const video = document.getElementById('cam-video');
    return Camera.stream && video?.readyState >= 2 && video.videoWidth > 0;
  });
}

async function capture(page, index, mode, allowed) {
  await openCamera(page);
  await page.locator('.cam-filter').nth(index).click();
  const preview = await page.evaluate(() => {
    const expected = document.createElement('video');
    expected.style.filter = Camera.cssFilter();
    return { selected: Camera.filterIdx, id: Camera.FILTERS[Camera.filterIdx].id,
      expected: expected.style.filter, actual: document.getElementById('cam-video').style.filter };
  });
  assert.equal(preview.selected, index, mode + ': clicking the thumbnail must select the requested filter');
  assert.notEqual(preview.expected, '', 'The filter must be valid CSS');
  assert.equal(preview.actual, preview.expected, mode + ': preview CSS for ' + preview.id);
  assert.equal(await page.locator('#cam-lock-bar').evaluate(element => element.classList.contains('show')), !allowed);
  await page.locator('#cam-mode-' + mode).click();
  await page.locator('#cam-shutter').click();
  if (!allowed) {
    await page.locator('#modal:not(.hidden) .pricing').waitFor();
    assert.equal(await page.locator('#camera-ov').count(), 0);
    assert.deepEqual(await page.evaluate(() => ({ draft: Camera._draft, stream: Camera.stream, recording: Camera.recording })),
      { draft: null, stream: null, recording: false }, 'Locked capture must produce no media or active recorder');
    await closeModal(page);
    return;
  }
  if (mode === 'video') {
    await page.waitForFunction(() => Camera.recording && Camera.recorder.state === 'recording');
    const started = await page.locator('#cam-video').evaluate(video => video.currentTime);
    await page.waitForFunction(start => document.getElementById('cam-video').currentTime > start + 0.2, started);
    await page.locator('#cam-shutter').click();
    await page.waitForFunction(() => Camera._draft?.isVid && Camera._draft.blob.size > 0);
  } else {
    await page.locator('#cam-edit-media').waitFor();
    await page.waitForFunction(() => document.getElementById('cam-edit-media')?.naturalWidth > 0);
    const media = await page.evaluate(() => ({ size: Camera._draft.blob.size, type: Camera._draft.blob.type,
      width: document.getElementById('cam-edit-media').naturalWidth, stream: Camera.stream }));
    assert.ok(media.size > 1000, 'Real fake-device image must be encoded');
    assert.equal(media.type, 'image/jpeg');
    assert.ok(media.width >= 640);
    assert.equal(media.stream, null, 'Capture must stop the live camera tracks');
  }
  await page.locator('#camera-ov button[aria-label="Close"]').click();
}

async function screenshot(testContext, page, name) {
  let filename;
  if (process.env.APP_QA_SCREENSHOTS) {
    const directory = path.resolve(root, process.env.APP_QA_SCREENSHOTS);
    fs.mkdirSync(directory, { recursive: true });
    filename = path.join(directory, 'product-' + name + '.png');
  }
  const capture = await page.screenshot({ path: filename, type: 'png', fullPage: false, animations: 'disabled' });
  assert.deepEqual([...capture.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(capture.length > 1000, name + ' must contain a fresh rendered capture');
  assert.ok(capture.readUInt32BE(16) >= page.viewportSize().width);
  assert.ok(capture.readUInt32BE(20) >= page.viewportSize().height);
  if (filename) testContext.diagnostic('Screenshot: ' + path.relative(root, filename));
}

test('isolated assets and token-owned entitlement reads fail closed', { timeout: 30000 }, async testContext => {
  const { page, fixture } = await setup(testContext);
  for (const denied of ['/backups/private.json', '/.git/config', '/office/board.json', '/tests/app-startup.e2e.cjs', '/package.json',
    '/js/.private.js', '/assets/.private.png', '/%2eenv', '/supabase/functions/create-checkout/index.ts', '/js/%2e%2e/backups/private.json']) {
    const response = await fetch(origin + denied);
    assert.equal(response.status, 404, denied + ' must not be served');
  }
  assert.equal((await fetch(origin + '/index.html', { method: 'POST' })).status, 404, 'Static server never accepts writes');
  fixture.grant(members.A, 'elite');
  const result = await page.evaluate(async ({ member, password }) => {
    await SupaAuth.signup(member.email, password, { name: member.name });
    Cloud._ensureIdentity(member.email);
    await Entitlements.load();
    return { tier: Entitlements.tier(), ready: Entitlements.ready(), owner: Entitlements._owner, uid: SupaAuth.uid(), token: SupaAuth.bearer() };
  }, { member: members.A, password });
  assert.equal(result.tier, 'elite');
  assert.equal(result.ready, true);
  assert.equal(result.owner, members.A.id);
  const read = fixture.requests.find(request => request.pathname === '/rest/v1/entitlements');
  assert.equal(read.authorization, 'Bearer ' + result.token);
  assert.equal(read.uid, members.A.id);
  assert.equal(new URLSearchParams(read.query).get('uid'), 'eq.' + members.A.id);
  assert.equal(fixture.external.some(request => request.type !== 'image' && request.type !== 'stylesheet'), false);
  testContext.diagnostic('Node ' + process.version + '; Chromium ' + browser.version() + '; loopback-only server ' + origin);
  testContext.diagnostic('Simulated backend acceptance only; no hosted RLS or provider security certification.');
});

test('UI signup -> onboarding -> delivered OTP -> meal -> confirmed logout -> login -> reload', { timeout: 45000 }, async testContext => {
  const { page, fixture } = await setup(testContext);
  await signup(page, fixture);
  assert.equal(await page.evaluate(() => Store.state.profile.heightCm), 178);
  assert.equal(await page.evaluate(() => Store.latestWeight()), 80);
  assert.equal(await page.evaluate(() => Store.state.profile.targetWeightKg), 76);
  for (const tab of ['home', 'search', 'flex', 'coach', 'alerts', 'profile']) {
    await page.locator(`#tabbar [data-tab="${tab}"]`).click();
    assert.equal(await page.evaluate(() => App.curTab), tab);
    assert.equal(await page.locator('#wrap > .view.active').count(), 1);
  }
  assert.deepEqual(fixture.consoleErrors, [], 'All six navigation tabs must produce zero console errors');
  await nutrition(page);
  await page.locator('#f-text').fill('200 ml milk');
  await page.getByRole('button', { name: 'Estimate', exact: true }).click();
  await page.locator('#e-kcal').fill('240');
  await page.locator('#e-pro').fill('16');
  await page.getByRole('button', { name: /Log this meal/ }).click();
  const food = await page.evaluate(() => Store.foodOn(todayISO()).items);
  assert.equal(food.length, 1);
  assert.equal(food[0].kcal, 240);
  assert.equal(food[0].protein, 16);
  assert.match(food[0].text, /Milk/);
  await fixture.waitFor(() => fixture.accounts.get(members.A.id)?.data.foodLog.some(day => day.items?.length === 1), 'acknowledged meal backup');
  assert.equal(fixture.accounts.get(members.A.id).data.profile.heightCm, 178);
  await screenshot(testContext, page, 'meal-mobile-390');
  await page.setViewportSize({ width: 1366, height: 900 });
  await screenshot(testContext, page, 'meal-desktop');
  await logout(page);
  await login(page);
  await nutrition(page);
  assert.deepEqual(await page.evaluate(() => Store.foodOn(todayISO()).items), food);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#app-shell:not(.hidden)').waitFor();
  await nutrition(page);
  assert.deepEqual(await page.evaluate(() => Store.foodOn(todayISO()).items), food);
  assert.equal(await page.locator('.food-log .meal-log').count(), 1);
  assert.equal(await page.evaluate(() => SupaAuth.uid()), members.A.id);
  assert.deepEqual(fixture.consoleErrors, [], 'Lifecycle must not introduce JavaScript or resource errors');
});

for (const scenario of tierScenarios) {
  test(`${scenario.name}: successful membership load, six tabs, program gate and meal quota`, { timeout: 45000 }, async testContext => {
    const { page, fixture } = await setup(testContext);
    fixture.grant(members.A, scenario.tier, scenario.end);
    await signup(page, fixture);
    assert.deepEqual(await page.evaluate(() => ({ tier: Entitlements.tier(), ready: Entitlements.ready(), error: Entitlements.error,
      owner: Entitlements._owner, pro: Entitlements.isPro(), elite: Entitlements.isElite() })),
    { tier: scenario.effective, ready: true, error: null, owner: members.A.id, pro: scenario.paid, elite: scenario.elite });
    assert.equal(await page.locator('html').getAttribute('data-tier'), scenario.effective);
    assert.ok(fixture.requests.some(request => request.pathname === '/rest/v1/entitlements' && request.status === 200 && request.uid === members.A.id));
    await walkTabs(page, fixture);
    await screenshot(testContext, page, 'tier-' + scenario.name.toLowerCase().replaceAll(' ', '-') + '-390');
    await page.locator('#tabbar [data-tab="coach"]').click();
    const entry = page.locator('#view-home .program-cta');
    if (scenario.paid) await entry.locator('.slidebtn').press('Enter');
    else await entry.getByRole('button', { name: /Go Pro/ }).click();
    if (scenario.paid) {
      await page.locator('#modal:not(.hidden) .program').waitFor();
      assert.equal(await page.locator('.pg-weeks .pw-tab').count(), 4);
      assert.ok(await page.locator('.program .pg-ex').count() > 0, 'Paid program contains actual exercises');
      assert.equal(await page.evaluate(() => App._program.weeks.length), 4);
    } else {
      await page.locator('#modal:not(.hidden) .pricing').waitFor();
      assert.equal(await page.locator('.program').count(), 0);
      assert.equal(await page.evaluate(() => !!App._program), false);
      await page.evaluate(() => App.openProgram());
      assert.equal(await page.locator('.program').count(), 0, 'The direct program handler is also gated');
    }
    await closeModal(page);
    await nutrition(page);
    const allowedGenerations = scenario.paid ? 5 : 3;
    for (let attempt = 1; attempt <= allowedGenerations; attempt++) {
      await page.locator('#plan-text').fill('High protein vegetarian menu ' + attempt);
      await page.getByRole('button', { name: 'Generate my menu', exact: true }).click();
      assert.equal(await page.locator('.day-plan .plan-row:not(.addon)').count(), 4);
      assert.equal(await page.evaluate(() => App.planSeed), attempt);
      assert.equal(await page.locator('#modal:not(.hidden)').count(), 0);
    }
    if (!scenario.paid) {
      const previous = await page.evaluate(() => App.dayPlan);
      await page.locator('#plan-text').fill('Keep this fourth request');
      await page.getByRole('button', { name: 'Generate my menu', exact: true }).click();
      await page.locator('#modal:not(.hidden) .pricing').waitFor();
      assert.deepEqual(await page.evaluate(() => App.dayPlan), previous, 'Quota failure must preserve the generated menu');
      assert.equal(await page.locator('#plan-text').inputValue(), 'Keep this fourth request');
      assert.equal(await page.evaluate(() => localStorage.getItem('fm_plan_gens')), '3');
    } else assert.equal(await page.evaluate(() => localStorage.getItem('fm_plan_gens')), null, 'Pro/Elite do not consume the Free quota');
    assert.deepEqual(fixture.consoleErrors, []);
  });

  test(`${scenario.name}: real CameraLoader, 30/89/13 filters, photo/video capture and frame gates`, { timeout: 90000 }, async testContext => {
    const { page, fixture } = await setup(testContext);
    fixture.grant(members.A, scenario.tier, scenario.end);
    await signup(page, fixture);
    assert.equal(await page.evaluate(() => typeof Camera), 'undefined', 'Camera must remain genuinely lazy');
    await openCamera(page);
    const catalogue = await page.evaluate(() => {
      const counts = { free: 0, pro: 0, elite: 0 }, examples = {};
      Camera.FILTERS.forEach((filter, index) => {
        const tier = Camera.filterTier(index);
        counts[tier]++;
        if (!(tier in examples)) examples[tier] = index;
      });
      return { counts, examples, liveTracks: Camera.stream.getTracks().map(track => track.readyState) };
    });
    assert.deepEqual(catalogue.counts, { free: 30, pro: 89, elite: 13 });
    assert.equal(await page.locator('.cam-filter').count(), 132);
    assert.equal(await page.locator('.cam-filter-lk').count(), scenario.elite ? 0 : scenario.paid ? 13 : 102);
    assert.ok(catalogue.liveTracks.every(state => state === 'live'));
    await page.locator('#camera-ov button[aria-label="Close"]').click();
    for (const tier of ['free', 'pro', 'elite']) {
      for (const mode of ['photo', 'video']) {
        await capture(page, catalogue.examples[tier], mode, tier === 'free' || (tier === 'pro' ? scenario.paid : scenario.elite));
      }
    }
    await openCamera(page);
    await page.locator('#cam-shutter').click();
    await page.waitForFunction(() => document.getElementById('cam-edit-media')?.naturalWidth > 0);
    await page.getByRole('button', { name: 'Frames', exact: true }).click();
    if (scenario.elite) {
      await page.locator('#cam-frames:not(.hidden)').waitFor();
      await page.locator('.cam-frame-chip[data-f="gold"]').click();
      const pixels = await page.evaluate(() => {
        const canvas = document.getElementById('cam-frame-ov');
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let opaque = 0;
        for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) opaque++;
        return { frame: Camera._frame, opaque, width: canvas.width, height: canvas.height };
      });
      assert.equal(pixels.frame, 'gold');
      assert.ok(pixels.opaque > 100, 'The selected frame must draw real canvas pixels');
      assert.ok(pixels.width > 0 && pixels.height > 0);
      await screenshot(testContext, page, 'elite-camera-frame-390');
      await page.evaluate(() => {
        const image = document.getElementById('cam-edit-media');
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 1080 / Math.max(image.naturalWidth, image.naturalHeight));
        canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        window.__unframedCapture = { width: canvas.width, height: canvas.height,
          pixels: canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data };
      });
      await page.locator('#camera-ov button[onclick="Camera.finish()"]').click();
      await page.waitForFunction(() => Social.pendingPhotos?.length === 1);
      const exported = await page.evaluate(async () => {
        const image = new Image(); image.src = Social.pendingPhotos[0]; await image.decode();
        const baseline = window.__unframedCapture;
        const canvas = document.createElement('canvas'); canvas.width = baseline.width; canvas.height = baseline.height;
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        const difference = (x, y) => {
          const offset = (Math.floor(y * canvas.height) * canvas.width + Math.floor(x * canvas.width)) * 4;
          return [0, 1, 2].reduce((sum, channel) => sum + Math.abs(pixels[offset + channel] - baseline.pixels[offset + channel]), 0) / 3;
        };
        const borders = [0.2, 0.4, 0.6, 0.8].flatMap(position => [difference(0.005, position), difference(0.995, position), difference(position, 0.005), difference(position, 0.995)]);
        return { width: image.naturalWidth, height: image.naturalHeight,
          borderDifference: borders.reduce((sum, value) => sum + value, 0) / borders.length,
          centerDifference: difference(0.5, 0.5), type: Social.pendingPhotos[0].slice(0, 23),
          cameraClosed: !document.getElementById('camera-ov') };
      });
      assert.equal(exported.type, 'data:image/jpeg;base64,');
      assert.equal(exported.cameraClosed, true);
      assert.ok(exported.width >= 640 && exported.height > 0);
      assert.ok(exported.borderDifference > 20, JSON.stringify(exported));
      assert.ok(exported.centerDifference < 15, 'Frame export preserves the original center: ' + JSON.stringify(exported));
    } else {
      await page.locator('#modal:not(.hidden) .pricing').waitFor();
      assert.equal(await page.locator('#camera-ov').count(), 0);
      assert.equal(await page.evaluate(() => Camera._frame), 'none');
    }
    assert.equal(fixture.assets.filter(asset => asset === '/js/mod/camera.js').length, 1, 'Repeated opens reuse the actual CameraLoader');
    assert.deepEqual(fixture.consoleErrors, []);
  });
}

test('advanced analytics renders measured volume and strength only for active paid tiers', { timeout: 45000 }, async testContext => {
  const { page, fixture } = await setup(testContext);
  await signup(page, fixture);
  await page.evaluate(() => {
    const earlier = new Date(); earlier.setDate(earlier.getDate() - 7);
    const previous = Engine._iso(earlier);
    for (const [date, weight] of [[previous, 50], [todayISO(), 60]]) {
      Store.logWorkout({ date, split: 'push', exercises: [{ id: 'bench_press', name: 'Barbell Bench Press', muscle: 'Chest', sets: [{ reps: 12, weight }] }], volume: 12 * weight });
    }
  });
  for (const scenario of tierScenarios) {
    fixture.grant(members.A, scenario.tier, scenario.end);
    await page.evaluate(() => Entitlements.load());
    await progress(page);
    if (scenario.paid) {
      await page.locator('#vol-chart .cols').waitFor();
      const output = await page.evaluate(() => ({ volume: Engine.volumeTrend(8).slice(-2), lift: Engine.liftProgress(5)[0] }));
      assert.deepEqual(output.volume.map(week => week.volume), [600, 720]);
      assert.equal(output.lift.e1rm, 84);
      assert.equal(output.lift.delta, 14);
      assert.equal(await page.locator('#vol-chart .col').count(), 8);
      assert.equal(await page.locator('#vol-chart .col-bar').last().evaluate(element => element.style.height), '100%');
      assert.match(await page.locator('.lift-row').first().innerText(), /Barbell Bench Press.*84.*14/s);
      assert.equal(await page.locator('button[onclick="App.addProgressPhoto()"]').count(), 1);
      assert.equal(await page.locator('#view-progress .upgrade-card').count(), 0);
    } else {
      assert.equal(await page.locator('#vol-chart').count(), 0);
      assert.equal(await page.locator('.lift-row').count(), 0);
      assert.equal(await page.locator('button[onclick="App.addProgressPhoto()"]').count(), 0);
      assert.equal(await page.locator('#view-progress .upgrade-card').count(), 1);
    }
  }
});

test('a refreshed token and newer membership result supersede an older same-owner response', { timeout: 30000 }, async testContext => {
  const { page, fixture } = await setup(testContext);
  fixture.grant(members.A, 'pro');
  await signup(page, fixture);
  const stale = fixture.holdNext(request => request.pathname === '/rest/v1/entitlements');
  await page.evaluate(() => { window.__oldMembership = Entitlements.load(); });
  await fixture.waitFor(() => stale.started, 'old membership request');
  fixture.grant(members.A, 'elite');
  const previousToken = await page.evaluate(() => {
    const previous = SupaAuth.bearer();
    SupaAuth.session.expires_at = Math.floor(Date.now() / 1000) - 1;
    localStorage.setItem(SupaAuth.KEY, JSON.stringify(SupaAuth.session));
    return previous;
  });
  await page.evaluate(() => Entitlements.load());
  stale.resolve();
  await page.evaluate(() => window.__oldMembership);
  assert.equal(await page.evaluate(() => Entitlements.tier()), 'elite');
  assert.equal(await page.evaluate(() => Entitlements._owner), members.A.id);
  const token = await page.evaluate(() => SupaAuth.bearer());
  assert.notEqual(token, previousToken);
  assert.ok(fixture.requests.some(request => request.pathname === '/auth/v1/token' && request.query.includes('refresh_token')));
  const reads = fixture.requests.filter(request => request.pathname === '/rest/v1/entitlements');
  assert.equal(reads.at(-1).authorization, 'Bearer ' + token);
  assert.equal(reads.at(-1).uid, members.A.id);
});

test('late account A membership cannot unlock newly signed-up account B', { timeout: 45000 }, async testContext => {
  const { page, fixture } = await setup(testContext);
  fixture.grant(members.A, 'elite');
  await signup(page, fixture);
  const stale = fixture.holdNext(request => request.pathname === '/rest/v1/entitlements');
  await page.evaluate(() => { window.__oldMembership = Entitlements.load(); });
  await fixture.waitFor(() => stale.started, 'held account A membership');
  await logout(page);
  await signup(page, fixture, members.B);
  stale.resolve();
  await page.evaluate(() => window.__oldMembership);
  assert.deepEqual(await page.evaluate(() => ({ uid: SupaAuth.uid(), owner: Entitlements._owner, tier: Entitlements.tier(), ready: Entitlements.ready() })),
    { uid: members.B.id, owner: members.B.id, tier: 'free', ready: true });
  assert.equal(await page.evaluate(() => Store.state.profile.heightCm), 165);
  assert.equal(await page.evaluate(() => Store.latestWeight()), 60);
  assert.equal(await page.locator('html').getAttribute('data-tier'), 'free');
});

for (const failure of [403, 500, 'offline']) {
  test(`support ${failure}: failed save preserves exact draft, then retry acknowledges the owner`, { timeout: 30000 }, async testContext => {
    const { page, fixture } = await setup(testContext);
    await signup(page, fixture);
    await page.locator('#tabbar [data-tab="profile"]').click();
    await page.locator('#view-profile button[onclick="App.openSupport()"]').last().click();
    const subject = 'Fixture receipt ' + failure;
    const message = 'Missing receipt.\nKeep this exact draft <not HTML> & its details.';
    await page.locator('#sp-subj').fill(subject);
    await page.locator('#sp-msg').fill(message);
    const fault = fixture.failNext('POST', '/rest/v1/support_tickets', failure);
    await page.locator('#sp-send').click();
    await fixture.waitFor(() => fault.used, 'support failure ' + failure);
    await page.waitForFunction(() => !document.getElementById('sp-send').disabled);
    assert.equal(await page.locator('#modal:not(.hidden) .support').isVisible(), true);
    assert.equal(await page.locator('#sp-subj').inputValue(), subject);
    assert.equal(await page.locator('#sp-msg').inputValue(), message);
    assert.equal(fixture.supportTickets.length, 0, 'Rejected request must not be committed');
    await page.locator('#sp-send').click();
    await fixture.waitFor(() => fixture.supportTickets.length === 1, 'support retry committed');
    await page.locator('#modal').waitFor({ state: 'hidden' });
    const ticket = fixture.supportTickets[0];
    assert.equal(ticket.uid, members.A.id);
    assert.equal(ticket.email, members.A.email);
    assert.equal(ticket.subject, subject);
    assert.equal(ticket.message, message);
    assert.equal(ticket.tier, 'free');
    const writes = fixture.requests.filter(request => request.pathname === '/rest/v1/support_tickets');
    assert.equal(writes.length, 2);
    assert.ok(writes.every(request => request.uid === members.A.id && request.body.uid === request.uid));
  });
}

test('support acknowledgement cannot discard a newer draft typed during the request', { timeout: 30000 }, async testContext => {
  const { page, fixture } = await setup(testContext);
  await signup(page, fixture);
  await page.locator('#tabbar [data-tab="profile"]').click();
  await page.locator('#view-profile button[onclick="App.openSupport()"]').last().click();
  await page.locator('#sp-subj').fill('First subject');
  await page.locator('#sp-msg').fill('First submitted message');
  const gate = fixture.holdNext(request => request.pathname === '/rest/v1/support_tickets');
  await page.locator('#sp-send').click();
  await fixture.waitFor(() => gate.started, 'pending support acknowledgement');
  assert.equal(await page.locator('#sp-send').isDisabled(), true);
  await page.locator('#sp-msg').fill('Newer unsaved draft');
  gate.resolve();
  await page.waitForFunction(() => !document.getElementById('sp-send').disabled);
  assert.equal(await page.locator('#sp-msg').inputValue(), 'Newer unsaved draft');
  assert.equal(await page.locator('#modal').isVisible(), true);
  assert.equal(fixture.supportTickets[0].message, 'First submitted message');
  await page.locator('#sp-send').click();
  await page.locator('#modal').waitFor({ state: 'hidden' });
  assert.equal(fixture.supportTickets.length, 2);
  assert.equal(fixture.supportTickets[1].message, 'Newer unsaved draft');
});

for (const failure of [403, 500, 'offline']) {
  test(`post edit ${failure}: keep caption and draft, retry then reload the acknowledged change`, { timeout: 30000 }, async testContext => {
    const { page, fixture } = await setup(testContext);
    fixture.seedSocial();
    await signup(page, fixture);
    await postMenu(page, 'post-a', 'Edit caption');
    const draft = '  Revised <b>fixture</b> & a "quoted" caption  ';
    await page.locator('#edit-cap').fill(draft);
    const fault = fixture.failNext('PATCH', '/rest/v1/posts', failure, 'post-a');
    await page.locator('#edit-cap-save').click();
    await fixture.waitFor(() => fault.used, 'caption failure ' + failure);
    await page.waitForFunction(() => !Social._actionPending('edit-post', 'post-a'));
    assert.equal(await page.locator('#edit-cap').inputValue(), draft);
    assert.equal(await page.locator('#edit-cap-save').isEnabled(), true);
    assert.equal(await postCard(page, 'post-a').locator('.post-text').innerText(), 'Alpha original caption');
    assert.equal(fixture.posts.get('post-a').data.text, 'Alpha original caption');
    await page.locator('#edit-cap-save').click();
    await page.locator('#modal').waitFor({ state: 'hidden' });
    assert.equal(fixture.posts.get('post-a').data.text, draft.trim());
    await socialReload(page);
    assert.equal(await postCard(page, 'post-a').locator('.post-text').innerText(), draft.trim());
    assert.equal(await postCard(page, 'post-a').locator('.post-text b').count(), 0, 'User caption stays text, not HTML');
    const writes = fixture.requests.filter(request => request.pathname === '/rest/v1/posts' && request.method === 'PATCH');
    assert.equal(writes.length, 2);
    for (const write of writes) {
      assert.equal(write.uid, members.A.id);
      assert.equal(new URLSearchParams(write.query).get('author'), 'eq.' + members.A.id);
    }
  });

  test(`post report ${failure}: no premature hide, retry persists report and local hide across reload`, { timeout: 30000 }, async testContext => {
    const { page, fixture } = await setup(testContext);
    fixture.seedSocial();
    await signup(page, fixture);
    const draft = 'Keep my unpublished composer draft';
    await page.locator('#post-text').fill(draft);
    const fault = fixture.failNext('POST', '/rest/v1/content_reports', failure);
    await reportPost(page, 'post-b');
    await fixture.waitFor(() => fault.used, 'report failure ' + failure);
    await page.waitForFunction(() => !Social._actionPending('report-post', 'post-b'));
    assert.equal(await page.locator('#post-text').inputValue(), draft);
    assert.equal(await postCard(page, 'post-b').locator('.post-text').innerText(), 'Beta original caption');
    assert.equal(await page.evaluate(() => Social.isHidden('post-b')), false);
    assert.deepEqual(await page.evaluate(() => Social._list('fm_reported')), []);
    assert.equal(fixture.reports.length, 0);
    await reportPost(page, 'post-b');
    await postCard(page, 'post-b').waitFor({ state: 'detached' });
    assert.equal(fixture.reports.length, 1);
    assert.deepEqual({ reporter: fixture.reports[0].reporter, target: fixture.reports[0].target_id, reason: fixture.reports[0].reason },
      { reporter: members.A.id, target: 'post-b', reason: 'Spam or scam' });
    assert.equal(fixture.posts.has('post-b'), true, 'Reporting is not server-side deletion');
    await socialReload(page);
    assert.equal(await postCard(page, 'post-b').count(), 0);
    assert.equal(await page.evaluate(() => Social._list('fm_reported').includes('post-b')), true);
  });

  test(`post delete ${failure}: keep content and composer, then delete only the acknowledged owner row`, { timeout: 30000 }, async testContext => {
    const { page, fixture } = await setup(testContext);
    fixture.seedSocial();
    await signup(page, fixture);
    await page.locator('#post-text').fill('Unpublished draft survives failed delete');
    const fault = fixture.failNext('DELETE', '/rest/v1/posts', failure, 'post-a');
    await deletePost(page, 'post-a');
    await fixture.waitFor(() => fault.used, 'delete failure ' + failure);
    await page.waitForFunction(() => !Social._actionPending('delete-post', 'post-a'));
    assert.equal(await postCard(page, 'post-a').locator('.post-text').innerText(), 'Alpha original caption');
    assert.equal(await page.locator('#post-text').inputValue(), 'Unpublished draft survives failed delete');
    assert.equal(fixture.posts.has('post-a'), true);
    await deletePost(page, 'post-a');
    await postCard(page, 'post-a').waitFor({ state: 'detached' });
    assert.equal(fixture.posts.has('post-a'), false);
    assert.equal(fixture.posts.has('post-b'), true, 'Another owner must not be deleted');
    await socialReload(page);
    assert.equal(await postCard(page, 'post-a').count(), 0);
    assert.equal(await postCard(page, 'post-b').count(), 1);
  });

  for (const action of ['delete', 'report']) {
    test(`comment ${action} ${failure}: preserve thread and input until acknowledgement, then survive reload`, { timeout: 30000 }, async testContext => {
      const { page, fixture } = await setup(testContext);
      fixture.seedSocial();
      await signup(page, fixture);
      await openComments(page);
      await page.locator('#ci-post-a').fill('Keep my pending reply draft');
      const id = action === 'delete' ? 'comment-a' : 'comment-b';
      const fault = fixture.failNext(action === 'delete' ? 'DELETE' : 'POST',
        action === 'delete' ? '/rest/v1/comments' : '/rest/v1/content_reports', failure, action === 'delete' ? id : undefined);
      await commentAction(page, action);
      await fixture.waitFor(() => fault.used, 'comment ' + action + ' failure ' + failure);
      await page.waitForFunction(({ action, id }) => !Social._actionPending(action + '-comment', id), { action, id });
      assert.equal(await commentMore(page, id).count(), 1);
      assert.equal(await page.locator('#ci-post-a').inputValue(), 'Keep my pending reply draft');
      assert.equal(fixture.comments.has(id), true);
      assert.equal(fixture.reports.length, 0);
      assert.deepEqual(await page.evaluate(() => Social._list('fm_hidden_cmt')), []);
      await commentAction(page, action);
      await commentMore(page, id).waitFor({ state: 'detached' });
      if (action === 'delete') assert.equal(fixture.comments.has(id), false);
      else {
        assert.equal(fixture.comments.has(id), true);
        assert.equal(fixture.reports[0].target_id, id);
        assert.equal(fixture.reports[0].reporter, members.A.id);
        assert.equal(fixture.reports[0].kind, 'comment');
      }
      await socialReload(page);
      await openComments(page);
      assert.equal(await commentMore(page, id).count(), 0);
      assert.equal(await commentMore(page, 'comment-reply-b').count(), 1, 'An unrelated reply survives parent deletion or another report');
    });
  }
}

test('personal saved items, hides and blocks persist for A but are never inherited by B', { timeout: 45000 }, async testContext => {
  const { page, fixture } = await setup(testContext);
  fixture.seedSocial();
  await signup(page, fixture);
  await postMenu(page, 'post-a', 'Save post');
  await page.waitForFunction(() => Social.isSaved('post-a'));
  await postMenu(page, 'post-b', 'Hide this post');
  await postCard(page, 'post-b').waitFor({ state: 'detached' });
  await postMenu(page, 'post-b-extra');
  await confirmedClick(page, page.getByRole('dialog').getByRole('button', { name: /Block @beta/ }), /They can still see your content and contact you/);
  await postCard(page, 'post-b-extra').waitFor({ state: 'detached' });
  const keys = await page.evaluate(() => ({ hidden: Social._listKey('fm_hidden'), blocked: Social._listKey('fm_blocked'), saved: Social._listKey('fm_saved') }));
  assert.equal(fixture.posts.size, 3, 'Personal preferences do not erase shared content');
  await socialReload(page);
  assert.equal(await postCard(page, 'post-b').count(), 0);
  assert.equal(await postCard(page, 'post-b-extra').count(), 0);
  assert.equal(await page.evaluate(() => Social.isSaved('post-a')), true);
  await logout(page);
  await signup(page, fixture, members.B);
  assert.equal(await postCard(page, 'post-b').count(), 1);
  assert.equal(await postCard(page, 'post-b-extra').count(), 1);
  assert.deepEqual(await page.evaluate(() => ({ blocked: Social._list('fm_blocked'), hidden: Social._list('fm_hidden'), saved: Social._list('fm_saved') })),
    { blocked: [], hidden: [], saved: [] });
  assert.notEqual(await page.evaluate(() => Social._listKey('fm_hidden')), keys.hidden);
  await logout(page, members.B);
  await login(page);
  assert.equal(await page.evaluate(() => Social.isHidden('post-b')), true);
  assert.equal(await page.evaluate(uid => Social.isBlocked(uid), members.B.id), true);
  assert.equal(await page.evaluate(() => Social.isSaved('post-a')), true);
  assert.equal(await page.evaluate(() => Store.state.profile.heightCm), 178);
  assert.equal(await postCard(page, 'post-b').count(), 0);
});

test('sheets replace one node, trap Tab/Shift+Tab and restore focus after Escape/backdrop', { timeout: 30000 }, async testContext => {
  const { page, fixture } = await setup(testContext, { width: 1366, height: 900 });
  fixture.seedSocial();
  await signup(page, fixture);
  const trigger = postCard(page, 'post-b').locator('.post-more');
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: members.B.name });
  assert.equal(await dialog.getAttribute('aria-modal'), 'true');
  assert.equal(await page.locator('.sheet-wrap').count(), 1);
  const controls = dialog.getByRole('button'), count = await controls.count();
  assert.ok(count > 3);
  for (let index = 0; index < count; index++) {
    assert.equal(await controls.nth(index).evaluate(element => element === document.activeElement), true, 'Tab focus at option ' + index);
    await page.keyboard.press('Tab');
  }
  assert.equal(await controls.first().evaluate(element => element === document.activeElement), true, 'Tab wraps to first');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await controls.last().evaluate(element => element === document.activeElement), true, 'Shift+Tab wraps to last');
  await page.keyboard.press('Escape');
  await page.locator('.sheet-wrap').waitFor({ state: 'detached' });
  assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
  await page.locator('#post-text').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('button[onclick="Social.pickPhotos()"]').evaluate(element => element === document.activeElement), true,
    'After closing, Tab returns to native page navigation');
  await trigger.click();
  const firstNode = await page.locator('.sheet-wrap').elementHandle();
  await dialog.getByRole('button', { name: 'Report post', exact: true }).click();
  await page.getByRole('dialog', { name: 'Why are you reporting this?' }).waitFor();
  assert.equal(await page.locator('.sheet-wrap').count(), 1, 'Action-driven replacement removes the closing sheet immediately');
  assert.equal(await firstNode.evaluate(element => element.isConnected), false);
  const secondNode = await page.locator('.sheet-wrap').elementHandle();
  await page.evaluate(() => Social.postMenu('post-b'));
  assert.equal(await page.locator('.sheet-wrap').count(), 1, 'Replacing a still-live sheet cannot duplicate nodes');
  assert.equal(await secondNode.evaluate(element => element.isConnected), false);
  const returnTarget = await page.evaluate(() => ({ tag: App._sheetReturn?.tagName,
    action: App._sheetReturn?.getAttribute('onclick'), connected: App._sheetReturn?.isConnected }));
  await page.locator('.sheet-back').click({ position: { x: 10, y: 10 } });
  await page.locator('.sheet-wrap').waitFor({ state: 'detached' });
  const active = await page.evaluate(() => ({ tag: document.activeElement.tagName, id: document.activeElement.id,
    action: document.activeElement.getAttribute('onclick') }));
  testContext.diagnostic('Backdrop focus: ' + JSON.stringify({ returnTarget, active }));
  assert.deepEqual(await page.evaluate(() => ({ key: App._sheetKey, items: App._sheetItems, closing: App._sheetClosing })),
    { key: null, items: null, closing: null });
  assert.equal(fixture.reports.length, 0, 'Opening and dismissing a report sheet must not submit a report');
  await screenshot(testContext, page, 'sheet-backdrop-desktop');
  assert.equal(await trigger.evaluate(element => element === document.activeElement), true,
    'Backdrop dismissal must return focus to the original post overflow button, not ' + active.tag);
});

for (const width of [320, 390]) {
  test(`touch ${width}: comment overflow reserves a real 44px target`, { timeout: 30000 }, async testContext => {
    const { page, fixture } = await setup(testContext, { width });
    fixture.seedSocial();
    await signup(page, fixture);
    await openComments(page);
    const geometry = await commentGeometry(page);
    testContext.diagnostic('Hit geometry: ' + JSON.stringify(geometry));
    await screenshot(testContext, page, 'comment-overflow-' + width);
    assert.ok(geometry.target.width >= 44 && geometry.target.height >= 44, 'Overflow touch target must be at least 44 x 44 CSS px');
    const point = { x: geometry.target.right - 2, y: geometry.target.top + geometry.target.height / 2 };
    assert.ok(point.x >= 0 && point.x < geometry.viewport.width && point.y >= 0 && point.y < geometry.viewport.height);
    if (geometry.pseudo) assert.ok(point.x > geometry.visual.right, 'Probe the expanded area, not just the visible icon button');
    await page.touchscreen.tap(point.x, point.y);
    await page.getByRole('dialog', { name: members.B.name }).waitFor();
    assert.equal(await page.getByRole('dialog').getByRole('button', { name: 'Report comment', exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => Social._replyTo || null), null, 'Overflow tap must not start a reply');
    await page.keyboard.press('Escape');
    await page.locator('.sheet-wrap').waitFor({ state: 'detached' });
    assert.equal(await commentMore(page, 'comment-b').evaluate(element => element === document.activeElement), true);
  });

  test(`touch ${width}: Reply remains independent of the comment overflow target`, { timeout: 30000 }, async testContext => {
    const { page, fixture } = await setup(testContext, { width });
    fixture.seedSocial();
    await signup(page, fixture);
    await openComments(page);
    const geometry = await commentGeometry(page);
    testContext.diagnostic('Reply geometry: ' + JSON.stringify(geometry));
    assert.ok(geometry.reply.width >= 44 && geometry.reply.height >= 44,
      'Reply must reserve its own minimum 44 x 44 CSS px target');
    const point = { x: geometry.reply.right - 2, y: geometry.reply.top + geometry.reply.height / 2 };
    await page.touchscreen.tap(point.x, point.y);
    await page.waitForFunction(() => Social._replyTo?.parentId === 'comment-b');
    assert.equal(await page.locator('#sheet-wrap').count(), 0, 'Reply tap must not open the overflow sheet');
    assert.equal(await page.locator('#ci-post-a').inputValue(), '@beta ');
    assert.equal(await page.locator('#ci-post-a').evaluate(element => element === document.activeElement), true);
    await screenshot(testContext, page, 'comment-reply-' + width);
    assert.equal(geometry.overlap, 0, 'Expanded overflow hit area must not overlap Reply: ' + JSON.stringify(geometry));
    assert.equal(await page.evaluate(() => App.curTab), 'home', 'A touch tap must not trigger the tab-swipe pager');
  });

  test(`touch ${width}: adjacent short comments keep independent overflow targets`, { timeout: 30000 }, async testContext => {
    const { page, fixture } = await setup(testContext, { width });
    fixture.seedSocial();
    for (const comment of fixture.comments.values()) comment.body = 'Short';
    await signup(page, fixture);
    await openComments(page);
    for (const id of ['comment-a', 'comment-reply-b', 'comment-b']) {
      const button = commentMore(page, id);
      await button.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
      const bounds = await button.boundingBox();
      assert.ok(bounds.width >= 44 && bounds.height >= 44);
      const hit = await button.evaluate((element, point) => {
        const target = document.elementFromPoint(point.x, point.y);
        return { correct: target?.closest('button') === element, tag: target?.tagName, className: target?.getAttribute('class') };
      }, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height - 2 });
      assert.equal(hit.correct, true, JSON.stringify({ id, bounds, hit }));
      await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height - 2);
      await page.locator('#sheet-wrap').waitFor();
      assert.equal(await page.evaluate(() => App._sheetReturn?.getAttribute('onclick')), `Social.commentMenu('${id}')`);
      await page.keyboard.press('Escape');
      await page.locator('.sheet-wrap').waitFor({ state: 'detached' });
    }
  });
}

test('profile controls fit long names at mobile and desktop widths', { timeout: 30000 }, async testContext => {
  const { page, fixture } = await setup(testContext);
  fixture.grant(members.A, 'elite');
  await signup(page, fixture);
  await page.locator('#tabbar [data-tab="profile"]').click();
  await page.evaluate(() => {
    Store.state.profile.name = 'AlexandriaMontgomeryLongUnbrokenName';
    Store.state.profile.username = 'long_profile_handle_fixture';
    App.renderProfile();
  });
  for (const viewport of [{ width: 320, height: 844 }, { width: 390, height: 844 }, { width: 1366, height: 900 }]) {
    await page.setViewportSize(viewport);
    const layout = await page.locator('.profile-hero').evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const controls = [...element.querySelectorAll('.ph-socials input,.ph-actions button')].map(control => {
        const rect = control.getBoundingClientRect();
        return { name: control.getAttribute('aria-label') || control.textContent.trim(), width: rect.width, height: rect.height,
          inside: rect.left >= bounds.left && rect.right <= bounds.right, fits: control.scrollWidth <= control.clientWidth,
          background: getComputedStyle(control).backgroundColor };
      });
      const avatar = element.querySelector('.ph-avatar .av'), avatarRect = avatar.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(avatar);
      const text = range.getBoundingClientRect();
      return { fits: element.scrollWidth <= element.clientWidth, controls,
        nameTop: element.querySelector('.ph-name').getBoundingClientRect().top,
        coverBottom: element.querySelector('.ph-cover').getBoundingClientRect().bottom,
        initialsOffset: Math.abs(text.left + text.width / 2 - avatarRect.left - avatarRect.width / 2),
        pageFits: document.documentElement.scrollWidth <= innerWidth };
    });
    assert.equal(layout.fits, true, JSON.stringify(layout));
    assert.equal(layout.pageFits, true);
    assert.ok(layout.nameTop >= layout.coverBottom + 8, 'All name lines must stay below the cover: ' + JSON.stringify(layout));
    assert.ok(layout.initialsOffset <= 2, JSON.stringify(layout));
    for (const control of layout.controls) {
      assert.ok(control.width >= 44 && control.height >= 44, JSON.stringify(control));
      assert.ok(control.inside && control.fits, JSON.stringify(control));
      assert.notEqual(control.background, 'rgb(255, 255, 255)', control.name);
    }
    await screenshot(testContext, page, 'profile-spacing-' + viewport.width);
  }
});

test('short landscape sheets keep controls reachable and tier text contrast readable', { timeout: 45000 }, async testContext => {
  const { page, fixture } = await setup(testContext);
  await signup(page, fixture);
  for (const tier of ['free', 'pro', 'elite']) {
    fixture.grant(members.A, tier);
    await page.evaluate(async () => { await Entitlements.load(); App.applyTierTheme(); });
    for (const viewport of [{ width: 667, height: 220 }, { width: 320, height: 256 }]) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => App.openSheet('Account options', [
        { label: 'Saved items', icon: 'bookmark' },
        { label: 'Selected option', on: true, icon: 'user' },
        { label: 'Remove item', danger: true, icon: 'trash' },
        { label: 'Another option', icon: 'copy' }
      ]));
      const sheet = page.locator('#sheet-wrap .sheet');
      const ratios = await sheet.evaluate(element => {
        const luminance = value => {
          const channels = value.match(/[\d.]+/g).slice(0, 3).map(channel => Number(channel) / 255);
          const linear = channels.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
          return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
        };
        const background = luminance(getComputedStyle(element).backgroundColor);
        return [...element.querySelectorAll('.sheet-opt')].map(button => {
          const foreground = luminance(getComputedStyle(button).color);
          return { text: button.textContent, ratio: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
            fits: button.scrollWidth <= button.clientWidth };
        });
      });
      for (const sample of ratios) {
        assert.ok(sample.ratio >= 4.5, `${tier} ${sample.text}: ${sample.ratio}`);
        assert.equal(sample.fits, true);
      }
      const cancel = sheet.getByRole('button', { name: 'Cancel', exact: true });
      await cancel.scrollIntoViewIfNeeded();
      const bounds = await cancel.boundingBox();
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height, JSON.stringify(bounds));
      assert.ok(bounds.height >= 44 && bounds.width >= 44);
      assert.equal(await sheet.evaluate(element => element.scrollWidth <= element.clientWidth), true);
      await screenshot(testContext, page, `sheet-${tier}-${viewport.width}x${viewport.height}`);
      await cancel.click();
      await page.locator('.sheet-wrap').waitFor({ state: 'detached' });
    }
  }
});

test('review uses UI-logged weight arithmetic, not the composite score, and real local luminance', { timeout: 45000 }, async testContext => {
  const { page, fixture } = await setup(testContext);
  fixture.grant(members.A, 'elite');
  await signup(page, fixture);
  await reviewWeight(page);
  assert.equal(await page.evaluate(() => Store.latestWeight()), 78);
  for (const [first, last, lighting] of [[30, 220, /noticeably brighter/], [220, 30, /noticeably darker/], [100, 110, /similar average brightness/]]) {
    await seedReviewPhotos(page, first, last);
    await page.locator('button[onclick="EliteReview.open()"]').click();
    await page.locator('.er-photo').waitFor();
    const result = await page.evaluate(() => ({ data: EliteReview.build(), composite: Engine.goalProgress().overall }));
    assert.equal(result.data.weight.pct, 50, '(78 - 80) / (76 - 80) is 50%');
    assert.equal(result.data.weight.toGo, -2);
    assert.equal(result.data.overall, Math.round(result.composite));
    assert.notEqual(result.data.overall, result.data.weight.pct, 'Fixture must discriminate the two percentages');
    assert.equal(await page.locator('.er-ring span').innerText(), String(result.data.overall));
    const trajectory = await page.locator('.er-sec').filter({ has: page.locator('.er-t', { hasText: /^Trajectory$/ }) }).innerText();
    assert.match(trajectory, /weight alone you're 50%/);
    assert.match(trajectory, /14 days/);
    assert.match(trajectory, /logged weight went down 2 kg \(-1 kg\/week\)/);
    assert.match(await page.locator('.er-photo').innerText(), lighting);
    assert.match(await page.locator('.er-intro').innerText(), /rules-based/);
    assert.match(await page.locator('.er-intro').innerText(), /nothing is measured from the images/);
    assert.equal(fixture.requests.some(request => JSON.stringify(request.body).includes('data:image/')), false, 'Progress image pixels never leave local storage');
    if (first === 30) await screenshot(testContext, page, 'logged-review-mobile-390');
    await closeModal(page);
  }
});

test('review weight arithmetic handles gain, loss, overshoot, hold and missing target without fabricated percentages', { timeout: 30000 }, async testContext => {
  const { page, fixture } = await setup(testContext);
  fixture.grant(members.A, 'elite');
  await signup(page, fixture);
  for (const sample of [
    { start: 60, current: 62, target: 68, pct: 25, toGo: 6 },
    { start: 80, current: 78, target: 76, pct: 50, toGo: -2 },
    { start: 80, current: 74, target: 76, pct: 100, toGo: 2 },
    { start: 80, current: 82, target: 76, pct: 0, toGo: -6 },
    { start: 80, current: 80, target: 80, pct: 100, toGo: 0 },
    { start: 80, current: 81, target: 80, pct: 0, toGo: -1 },
    { start: 80, current: 78, target: null, pct: null },
  ]) {
    const result = await page.evaluate(sample => {
      Store.state.profile.startWeightKg = sample.start;
      Store.state.profile.targetWeightKg = sample.target;
      Store.logWeight(sample.current);
      EliteReview.open();
      return { weight: EliteReview.build().weight, text: document.getElementById('modal-card').innerText };
    }, sample);
    if (sample.pct === null) {
      assert.equal(result.weight, null);
      assert.match(result.text, /Log a starting weight, a current weight and a target weight/);
    } else {
      assert.equal(result.weight.pct, sample.pct, JSON.stringify(sample));
      assert.equal(result.weight.toGo, sample.toGo);
    }
    assert.doesNotMatch(result.text, /NaN|Infinity|\[object Object\]/);
  }
});

test('review is gated for Free, Pro and expired grants after a successful load', { timeout: 30000 }, async testContext => {
  const { page, fixture } = await setup(testContext);
  await signup(page, fixture);
  for (const scenario of tierScenarios.filter(candidate => !candidate.elite)) {
    fixture.grant(members.A, scenario.tier, scenario.end);
    await page.evaluate(() => Entitlements.load());
    assert.equal(await page.evaluate(() => Entitlements.ready()), true);
    await progress(page);
    if (scenario.paid) await page.getByRole('button', { name: /Progress review.*Elite/ }).click();
    else await page.evaluate(() => EliteReview.open());
    await page.locator('#modal:not(.hidden) .pricing').waitFor();
    assert.equal(await page.locator('.er-intro').count(), 0);
    await closeModal(page);
  }
});

test('late review luminance callbacks must not replace pricing', { timeout: 30000 }, async testContext => {
  const { page, fixture } = await setup(testContext);
  fixture.grant(members.A, 'elite');
  await signup(page, fixture);
  await reviewWeight(page);
  await seedReviewPhotos(page);
  await holdReviewImages(page);
  await page.locator('button[onclick="EliteReview.open()"]').click();
  await page.waitForFunction(() => window.__reviewImageGate.pending.length === 2);
  await closeModal(page);
  await page.evaluate(() => App.openPricing());
  const pricing = await page.locator('#modal-card').innerHTML();
  await releaseReviewImages(page);
  assert.equal(await page.locator('#modal-card').innerHTML(), pricing, 'Late luminance must not overwrite the newer pricing view');
  assert.equal(await page.locator('.pricing').isVisible(), true);
});

test('review render versions reject older lighting even when both initial review DOMs match', { timeout: 30000 }, async testContext => {
  const { page, fixture } = await setup(testContext);
  fixture.grant(members.A, 'elite');
  await signup(page, fixture);
  await reviewWeight(page);
  await seedReviewPhotos(page, 30, 220);
  await holdReviewImages(page);
  await page.locator('button[onclick="EliteReview.open()"]').click();
  await page.waitForFunction(() => window.__reviewImageGate.pending.length === 2);
  const initial = await page.locator('#modal-card').innerHTML();
  await closeModal(page);
  await seedReviewPhotos(page, 220, 30);
  await page.locator('button[onclick="EliteReview.open()"]').click();
  await page.waitForFunction(() => window.__reviewImageGate.pending.length === 4);
  assert.equal(await page.locator('#modal-card').innerHTML(), initial, 'Only the asynchronous lighting differs between versions');
  await releaseReviewImages(page);
  assert.equal(await page.locator('#modal-card').innerHTML(), initial, 'Older lighting callback must not render into the identical newer DOM');
  await releaseReviewImages(page);
  await page.locator('.er-photo').waitFor();
  assert.match(await page.locator('.er-photo').innerText(), /noticeably darker/);
});

test('late account A review callbacks cannot populate account B or replace its support draft', { timeout: 45000 }, async testContext => {
  const { page, fixture } = await setup(testContext);
  fixture.grant(members.A, 'elite');
  fixture.grant(members.B, 'elite');
  await signup(page, fixture);
  await reviewWeight(page);
  await seedReviewPhotos(page);
  await holdReviewImages(page);
  await page.locator('button[onclick="EliteReview.open()"]').click();
  await page.waitForFunction(() => window.__reviewImageGate.pending.length === 2);
  const owner = await page.evaluate(() => Store.key);
  await closeModal(page);
  await logout(page);
  await signup(page, fixture, members.B);
  assert.notEqual(await page.evaluate(() => Store.key), owner);
  assert.deepEqual(await page.evaluate(() => App.progressPhotos()), []);
  await page.locator('#tabbar [data-tab="profile"]').click();
  await page.locator('#view-profile button[onclick="App.openSupport()"]').last().click();
  await page.locator('#sp-msg').fill('Private support draft for Beta');
  await releaseReviewImages(page);
  assert.equal(await page.locator('#sp-msg').inputValue(), 'Private support draft for Beta');
  assert.equal(await page.locator('.er-intro').count(), 0);
  assert.equal(await page.evaluate(() => SupaAuth.uid()), members.B.id);
});

for (const tier of ['pro', 'elite']) {
  test(`Razorpay ${tier}: authenticated real edge handler, 100 paise, immutable identity and same-owner tier poll`, { timeout: 45000 }, async testContext => {
    const { page, fixture } = await setup(testContext);
    const upgradeExpiry = '2099-03-04T12:30:00.000Z';
    if (tier === 'elite') fixture.grant(members.A, 'pro', upgradeExpiry);
    await signup(page, fixture);
    await checkoutMocks(page);
    await checkout(page, tier);
    await page.waitForFunction(() => window.__razorpay[0]?.opened);
    await page.evaluate(() => window.__lastCheckoutPromise);
    const record = fixture.requests.find(request => request.pathname === '/functions/v1/razorpay-create-order');
    assert.equal(record.authorization, 'Bearer ' + await page.evaluate(() => SupaAuth.bearer()));
    assert.deepEqual(record.body, { tier, uid: members.A.id, upgrade: tier === 'elite' });
    const order = fixture.orders[0];
    assert.equal(order.amount, 100, 'The real edge handler must request the authorized 100-paise offer');
    assert.equal(order.currency, 'INR');
    assert.deepEqual(order.notes, { uid: members.A.id, tier, email: members.A.email,
      identity_source: 'supabase_auth_v1', access_until: tier === 'elite' ? upgradeExpiry : '' });
    const options = await page.evaluate(() => {
      const options = window.__razorpay[0].options;
      return { amount: options.amount, order_id: options.order_id, currency: options.currency, notesPresent: Object.hasOwn(options, 'notes') };
    });
    assert.deepEqual(options, { amount: 100, order_id: order.id, currency: 'INR', notesPresent: false });
    assert.equal(fixture.external.some(request => /razorpay/.test(request.url)), false, 'No Razorpay SDK or API network request from the browser');
    const start = fixture.requests.length;
    const firstPoll = fixture.holdNext(request => request.pathname === '/rest/v1/entitlements');
    await paymentCallback(page);
    await fixture.waitFor(() => firstPoll.started, 'first post-payment tier poll', 8000);
    assert.deepEqual(await page.evaluate(() => window.__upgradeOwners), [{ tier, owner: members.A.id }]);
    fixture.capturePayment(order.id);
    firstPoll.resolve();
    await page.waitForFunction(tier => App._upgradeCelebrated && Entitlements.tier() === tier, tier, { timeout: 12000 });
    assert.equal(await page.locator('html').getAttribute('data-tier'), tier);
    await page.locator(`.member-card[data-tier="${tier}"]`).waitFor();
    const reads = fixture.requests.slice(start).filter(request => request.pathname === '/rest/v1/entitlements');
    assert.ok(reads.length >= 2, 'Delayed fixture capture must require a genuine subsequent poll');
    assert.ok(reads.every(request => request.uid === order.notes.uid && new URLSearchParams(request.query).get('uid') === 'eq.' + order.notes.uid));
    assert.deepEqual(fixture.capturedPayments, [{ order_id: order.id, uid: members.A.id, amount: 100, tier }]);
    await screenshot(testContext, page, tier + '-after-fixture-payment-390');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#app-shell:not(.hidden)').waitFor();
    assert.equal(await page.evaluate(() => Entitlements.tier()), tier);
  });
}

test('global checkout executes server-signed identity creation and navigates only to the issued fixture page', { timeout: 30000 }, async testContext => {
  const { page, fixture } = await setup(testContext);
  await signup(page, fixture);
  await page.evaluate(() => Object.assign(Currency, { cur: 'USD', rate: 1, ready: true }));
  await checkout(page, 'pro', 'card');
  await page.getByRole('heading', { name: 'Isolated provider checkout', exact: true }).waitFor();
  const request = fixture.requests.find(record => record.pathname === '/functions/v1/create-checkout');
  assert.equal(request.status, 200);
  assert.equal(request.uid, members.A.id);
  assert.equal(fixture.tokens.get(request.authorization.replace(/^Bearer /, '')), members.A.id);
  assert.deepEqual(request.body, { tier: 'pro' }, 'Browser cannot supply editable UID, email, variant or notes');
  assert.equal(fixture.checkouts.length, 1);
  const created = fixture.checkouts[0];
  const custom = created.payload.data.attributes.checkout_data.custom;
  const proof = createHmac('sha256', edgeEnvironment.LS_WEBHOOK_SECRET)
    .update(JSON.stringify(['lemonsqueezy-checkout-v1', members.A.id, edgeEnvironment.LS_VARIANT_PRO])).digest('hex');
  assert.deepEqual(custom, { uid: members.A.id, variant: edgeEnvironment.LS_VARIANT_PRO, identity_proof: proof });
  assert.equal(created.payload.data.attributes.checkout_data.email, members.A.email);
  assert.deepEqual(created.payload.data.attributes.product_options.enabled_variants, [101]);
  assert.equal(page.url(), created.url);
  assert.equal(new URL(page.url()).searchParams.has('checkout[custom][uid]'), false);
  assert.equal(fixture.orders.length, 0);
  assert.equal(fixture.external.filter(record => record.type === 'document').length, 1, 'Only the explicitly issued fixture document may navigate');
  testContext.diagnostic('Actual checkout handlers and HMAC ran with fixture secrets; Auth, providers, capture and hosted policies remain simulated.');
});

test('Razorpay late order response after A -> B cannot open checkout for the old owner', { timeout: 45000 }, async testContext => {
  const { page, fixture } = await setup(testContext);
  await signup(page, fixture);
  await checkoutMocks(page);
  const pending = fixture.holdNext(request => request.pathname === '/functions/v1/razorpay-create-order');
  await checkout(page, 'elite');
  await fixture.waitFor(() => pending.started, 'pending owner A order');
  await closeModal(page);
  await logout(page);
  await signup(page, fixture, members.B);
  pending.resolve();
  await page.evaluate(() => window.__lastCheckoutPromise);
  assert.equal(await page.evaluate(() => window.__razorpay.length), 0);
  assert.equal(await page.evaluate(() => SupaAuth.uid()), members.B.id);
  assert.equal(fixture.orders[0].notes.uid, members.A.id);
  assert.equal(fixture.orders[0].status, 'created');
  assert.equal(fixture.capturedPayments.length, 0);
});

test('Razorpay late payment callback cannot close B draft or poll/grant B with A purchase', { timeout: 45000 }, async testContext => {
  const { page, fixture } = await setup(testContext);
  await signup(page, fixture);
  await checkoutMocks(page);
  await checkout(page, 'elite');
  await page.waitForFunction(() => window.__razorpay[0]?.opened);
  await page.evaluate(() => window.__lastCheckoutPromise);
  await logout(page);
  await signup(page, fixture, members.B);
  await page.locator('#tabbar [data-tab="profile"]').click();
  await page.locator('#view-profile button[onclick="App.openSupport()"]').last().click();
  await page.locator('#sp-msg').fill('Do not close Beta draft for Alpha payment');
  const before = fixture.requests.length;
  fixture.capturePayment(fixture.orders[0].id);
  await paymentCallback(page);
  assert.deepEqual(await page.evaluate(() => window.__upgradeOwners), [], 'A stale provider callback must not invoke the upgrade polling controller');
  assert.equal(await page.locator('#sp-msg').inputValue(), 'Do not close Beta draft for Alpha payment');
  assert.equal(await page.evaluate(() => Entitlements.tier()), 'free');
  assert.equal(await page.evaluate(() => SupaAuth.uid()), members.B.id);
  assert.equal(fixture.requests.slice(before).filter(request => request.pathname === '/rest/v1/entitlements').length, 0);
  assert.equal(fixture.entitlements.get(members.A.id).tier, 'elite');
  assert.equal(fixture.entitlements.has(members.B.id), false);
});

test('global checkout rejects a provider response from the previous account', { timeout: 45000 }, async testContext => {
  const { page, fixture } = await setup(testContext);
  await signup(page, fixture);
  await checkoutMocks(page);
  await page.evaluate(() => Object.assign(Currency, { cur: 'USD', rate: 1, ready: true }));
  const pending = fixture.holdNext(request => request.pathname === '/functions/v1/create-checkout');
  await checkout(page, 'pro', 'card');
  await fixture.waitFor(() => pending.started, 'pending owner A global checkout');
  await closeModal(page);
  await logout(page);
  await signup(page, fixture, members.B);
  pending.resolve();
  await page.evaluate(() => window.__lastCheckoutPromise);
  assert.equal(new URL(page.url()).origin, origin);
  assert.equal(await page.evaluate(() => SupaAuth.uid()), members.B.id);
  assert.equal(fixture.external.filter(request => request.type === 'document').length, 0);
});

test('global checkout rejects untrusted provider URLs and leaves pricing retryable', { timeout: 30000 }, async testContext => {
  const { page, fixture } = await setup(testContext);
  await signup(page, fixture);
  await checkoutMocks(page);
  await page.evaluate(() => Object.assign(Currency, { cur: 'USD', rate: 1, ready: true }));
  for (const url of [
    'http://fixture-store.lemonsqueezy.com/checkout/custom/cccccccc-cccc-4ccc-8ccc-000000000001',
    'https://lemonsqueezy.com.attacker.invalid/pay',
    'https://user:password@fixture-store.lemonsqueezy.com/pay',
  ]) {
    fixture.checkoutURLOverride = url;
    fixture.expectRejection('POST', '/functions/v1/create-checkout', 503);
    if (!await page.locator('#modal:not(.hidden) .pricing').count()) await pricing(page);
    await planCard(page, 'pro').getByRole('button', { name: 'Choose Pro', exact: true }).click();
    await page.evaluate(() => window.__lastCheckoutPromise);
    assert.equal(new URL(page.url()).origin, origin);
    assert.equal(await page.locator('.pricing').isVisible(), true);
    assert.equal(await page.evaluate(() => App._checkoutBusy), false);
  }
  assert.equal(fixture.issuedCheckoutURLs.size, 0);
  assert.equal(fixture.external.some(request => request.type === 'document'), false);
});

test('fixture acceptance enforces per-token private records and rejects forged caller IDs in real checkout handlers', { timeout: 30000 }, async testContext => {
  const { page, fixture } = await setup(testContext);
  fixture.seedSocial();
  await signup(page, fixture);
  await fixture.waitFor(() => fixture.accounts.has(members.A.id), 'owner A private account backup');
  const privateProfile = structuredClone(fixture.accounts.get(members.A.id).data.profile);
  fixture.users.set(members.B.id, { ...members.B, password });
  const tokenB = fixture.issueSession(members.B).access_token;
  const tokenA = await page.evaluate(() => SupaAuth.bearer());
  const request = async (token, method, pathname, body) => page.evaluate(async ({ token, method, pathname, body }) => {
    const response = await fetch(pathname, { method, headers: { Authorization: 'Bearer ' + token,
      apikey: window.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  }, { token, method, pathname, body });
  assert.equal((await request(tokenA, 'GET', '/auth/v1/user')).body.id, members.A.id);
  assert.equal((await request(tokenB, 'GET', '/auth/v1/user')).body.id, members.B.id);
  assert.equal((await request(tokenB, 'GET', '/auth/v1/session')).body.user.id, members.B.id);
  assert.deepEqual((await request(tokenB, 'GET', '/rest/v1/accounts?uid=eq.' + members.A.id)).body, []);
  assert.deepEqual((await request(tokenB, 'GET', '/rest/v1/accounts?select=*')).body, []);
  const forbidden = [
    ['GET', '/rest/v1/entitlements', null, 401, 'fixture-public-anon'],
    ['POST', '/rest/v1/accounts', { uid: members.A.id, data: { profile: { name: 'Forged owner' } } }, 403, tokenB],
    ['POST', '/rest/v1/posts', { id: 'forged-post', author: members.A.id, data: { text: 'Forged' } }, 403, tokenB],
    ['PATCH', '/rest/v1/posts?id=eq.post-a&author=eq.' + members.B.id, { data: { text: 'Forged edit' } }, 403, tokenB],
    ['DELETE', '/rest/v1/comments?id=eq.comment-a&author=eq.' + members.B.id, null, 403, tokenB],
    ['POST', '/rest/v1/content_reports', { kind: 'post', target_id: 'post-a', reporter: members.A.id, reported_uid: members.A.id }, 403, tokenB],
    ['POST', '/rest/v1/support_tickets', { uid: members.A.id, message: 'Forged support request' }, 403, tokenB],
    ['POST', '/functions/v1/razorpay-create-order', { tier: 'elite', uid: members.A.id }, 403, tokenB],
    ['POST', '/functions/v1/create-checkout', { tier: 'pro', uid: members.A.id }, 403, tokenB],
  ];
  for (const [method, pathname, body, expected, token] of forbidden) {
    fixture.expectRejection(method, pathname.split('?')[0], expected);
    const response = await request(token, method, pathname, body);
    assert.equal(response.status, expected, method + ' ' + pathname);
  }
  const own = await request(tokenB, 'POST', '/rest/v1/posts', { id: 'own-b-post', author: members.B.id, data: { text: 'Legitimate Beta write' } });
  assert.equal(own.status, 201, 'Fixture RLS must allow legitimate writes, not just reject everything');
  assert.equal(fixture.posts.get('own-b-post').author, members.B.id);
  assert.equal(fixture.posts.get('post-a').data.text, 'Alpha original caption');
  assert.equal(fixture.comments.has('comment-a'), true);
  assert.deepEqual(fixture.accounts.get(members.A.id).data.profile, privateProfile, 'Rejected caller IDs cannot mutate any private profile field');
  assert.equal(fixture.orders.length, 0);
  assert.equal(fixture.checkouts.length, 0);
  testContext.diagnostic('These are fixture RLS acceptance checks, not evidence about deployed Supabase policies.');
});