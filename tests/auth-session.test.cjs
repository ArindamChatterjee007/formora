'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/supaauth.js'), 'utf8');

function pending() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  const storage = new Map();
  const context = vm.createContext({
    console, Date, AbortController, setTimeout, clearTimeout,
    window: { USE_SUPABASE_AUTH: true, SUPABASE_URL: 'https://fixture.invalid', SUPABASE_ANON_KEY: 'public-fixture-key' },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    fetch: async () => ({ ok: true, json: async () => ({}) })
  });
  vm.runInContext(source + '\nglobalThis.subject = SupaAuth;', context);
  const auth = context.subject;
  auth._scheduleRefresh = () => {};
  auth._store({ access_token: 'old-A', refresh_token: 'refresh-A', expires_in: -60, user: { id: 'A', email: 'a@example.test' } });
  return { context, auth, storage };
}
const renewed = { access_token: 'renewed-A', refresh_token: 'rotated-A', expires_in: 3600, user: { id: 'A', email: 'a@example.test' } };

test('concurrent token users share one refresh request', async () => {
  const { context, auth } = setup();
  const response = pending();
  let calls = 0;
  context.fetch = () => { calls++; return response.promise; };
  const first = auth.token(), second = auth.token();
  assert.equal(calls, 1);
  response.resolve({ ok: true, json: async () => renewed });
  assert.deepEqual(await Promise.all([first, second]), ['renewed-A', 'renewed-A']);
});

test('logout clears local credentials before the network responds', async () => {
  const { context, auth, storage } = setup();
  const response = pending();
  context.fetch = () => response.promise;
  const loggingOut = auth.logout();
  assert.equal(auth.session, null);
  assert.equal(storage.has(auth.KEY), false);
  response.resolve({ ok: true });
  await loggingOut;
});

test('a delayed refresh cannot restore credentials after logout', async () => {
  const { context, auth } = setup();
  const response = pending();
  context.fetch = url => String(url).includes('refresh_token') ? response.promise : Promise.resolve({ ok: true });
  const refreshing = auth.refresh();
  await auth.logout();
  response.resolve({ ok: true, json: async () => renewed });
  await refreshing;
  assert.equal(auth.session, null);
});

test('an old logout response cannot clear a new login', async () => {
  const { context, auth } = setup();
  const response = pending();
  context.fetch = () => response.promise;
  const loggingOut = auth.logout();
  auth._store({ access_token: 'new-B', refresh_token: 'refresh-B', user: { id: 'B', email: 'b@example.test' } });
  response.resolve({ ok: true });
  await loggingOut;
  assert.equal(auth.uid(), 'B');
});

test('a rejected old refresh cannot clear a newer stored session', async () => {
  const { context, auth } = setup();
  const response = pending();
  context.fetch = () => response.promise;
  const refreshing = auth.refresh();
  auth._store({ access_token: 'new-B', refresh_token: 'refresh-B', user: { id: 'B', email: 'b@example.test' } });
  response.resolve({ ok: false, status: 401, json: async () => ({}) });
  await refreshing;
  assert.equal(auth.uid(), 'B');
});

test('failed refresh never hands an already expired bearer to callers', async () => {
  const { context, auth } = setup();
  context.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  assert.equal(await auth.token(), null);
  assert.ok(auth.session, 'Keep recoverable credentials on a transient failure');
});

test('a stalled refresh is aborted and releases the single-flight guard', async () => {
  const { context, auth } = setup();
  const timers = [];
  context.setTimeout = (callback, milliseconds) => { assert.equal(milliseconds, 10000); timers.push(callback); return timers.length; };
  context.clearTimeout = () => {};
  context.fetch = (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const refreshing = auth.token();
  timers[0]();
  assert.equal(await refreshing, null);
  assert.equal(auth._refreshing, null);
});

test('the refresh timeout also bounds a stalled response body', async () => {
  const { context, auth } = setup();
  const timer = pending(), bodyStarted = pending();
  context.setTimeout = callback => { timer.resolve(callback); return 1; };
  context.clearTimeout = () => {};
  context.fetch = async (url, options) => ({ ok: true, json: () => {
    bodyStarted.resolve();
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted body'))));
  } });
  const refreshing = auth.token();
  await bodyStarted.promise;
  (await timer.promise)();
  assert.equal(await refreshing, null);
  assert.equal(auth._refreshing, null);
});