'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const session = owner => ({ access_token: 'fixture-' + owner, refresh_token: 'fixture-refresh-' + owner,
  expires_in: 3600, user: { id: owner, email: owner.toLowerCase() + '@example.test' } });

function pending() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function authFixture() {
  const storage = new Map();
  const context = vm.createContext({
    Date, AbortController, setTimeout, clearTimeout,
    window: { USE_SUPABASE_AUTH: true, SUPABASE_URL: 'https://fixture.invalid', SUPABASE_ANON_KEY: 'fixture-public' },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    fetch: async () => { throw new Error('Unconfigured fixture request'); }
  });
  vm.runInContext(source('js/supaauth.js') + '\nglobalThis.auth = SupaAuth;', context);
  context.auth._scheduleRefresh = () => {};
  return { context, auth: context.auth };
}

for (const method of ['password', 'google']) {
  for (const boundary of ['logout', 'newer account']) {
    test(`QA safety: delayed ${method} login cannot undo ${boundary}`, async () => {
      const { auth, context } = authFixture();
      const response = pending();
      context.fetch = () => response.promise;
      const signingIn = method === 'password'
        ? auth.login('a@example.test', 'fixture-only-password')
        : auth.signInWithGoogle('fixture-only-id-token');
      if (boundary === 'logout') auth.clear();
      else auth._store(session('B'));
      response.resolve({ ok: true, json: async () => session('A') });
      await signingIn.catch(() => null);
      assert.equal(auth.uid(), boundary === 'logout' ? '' : 'B', 'A stale response must not replace the current authentication state');
    });
  }
}

test('QA safety: delayed avatar resize cannot write to the next account', async () => {
  const response = pending();
  const saves = [];
  const alerts = [];
  const context = vm.createContext({
    window: {}, document: { addEventListener() {} }, setTimeout, clearTimeout,
    alert: message => alerts.push(message),
    Store: { key: 'store-A', state: { profile: { avatar: 'avatar-A' } },
      save() { saves.push({ key: this.key, avatar: this.state.profile.avatar }); } }
  });
  vm.runInContext(source('js/app.js') + '\nglobalThis.app = App;', context);
  context.resizeImage = () => response.promise;
  context.app._entry = 1;
  context.app.renderProfile = () => {};
  context.app.uploadAvatar({ target: { files: [{ name: 'a.jpg', type: 'image/jpeg' }] } });
  context.app._entry++;
  context.Store.key = 'store-B';
  context.Store.state = { profile: { avatar: 'avatar-B' } };
  response.resolve('data:image/jpeg;base64,YXZhdGFyLUE=');
  await response.promise;
  await Promise.resolve();
  assert.deepEqual(alerts, [], 'The resize fixture must complete normally before evaluating account isolation');
  assert.equal(context.Store.state.profile.avatar, 'avatar-B', 'The current account must not receive the previous account image');
  assert.equal(saves.length, 0);
});

test('QA safety: malformed backup is rejected before replacing account storage', () => {
  const original = JSON.stringify({ profile: { name: 'Member A' }, workoutLog: [{ date: '2026-09-05', volume: 1200 }] });
  const storage = new Map([['gymcoach_v1_A', original]]);
  const account = { id: 'A', name: 'Member A', email: 'a@example.test' };
  const context = vm.createContext({
    window: {}, document: { addEventListener() {} },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    Auth: { data: { accounts: [account] }, load() {}, setCurrent() {} }
  });
  vm.runInContext(source('js/app.js') + '\nglobalThis.app = App;', context);
  context.app.enterApp = () => {};
  let rejected = false;
  try { context.app.importData(JSON.stringify({ app: 'formora', v: 1, account, data: 1 })); }
  catch (_) { rejected = true; }
  assert.equal(storage.get('gymcoach_v1_A'), original, 'Malformed input must leave the existing logs intact');
  assert.ok(rejected, 'Malformed backup must be rejected explicitly');
});

test('QA safety: cloud merge preserves two separately logged servings of the same meal', () => {
  const context = vm.createContext({ structuredClone, setTimeout, clearTimeout, DEFAULT_PROFILE: {} });
  vm.runInContext(source('js/storage.js') + '\nglobalThis.store = Store;', context);
  const meal = { text: 'Rice', kcal: 250, protein: 5 };
  const state = (count, updatedAt) => ({ profile: { name: 'Member A' }, weightLog: [], workoutLog: [], restDays: [],
    foodLog: [{ date: '2026-09-06', items: Array.from({ length: count }, () => ({ ...meal })) }], updatedAt });
  context.store.state = state(2, 2);
  const result = context.store.merge(state(1, 1));
  assert.equal(result.foodLog[0].items.length, 2, 'Restoring an older cloud copy must not remove the second logged serving');
  assert.equal(result.foodLog[0].items.reduce((sum, item) => sum + item.kcal, 0), 500);
});

for (const method of ['password', 'google']) {
  test(`QA control: ordinary ${method} login still establishes the intended account`, async () => {
    const { auth, context } = authFixture();
    context.fetch = async () => ({ ok: true, json: async () => session('A') });
    if (method === 'password') await auth.login('a@example.test', 'fixture-only-password');
    else await auth.signInWithGoogle('fixture-only-id-token');
    assert.equal(auth.uid(), 'A');
    assert.equal(auth.email(), 'a@example.test');
  });
}

test('QA control: cloud merge retains two different meal entries', () => {
  const context = vm.createContext({ structuredClone, setTimeout, clearTimeout, DEFAULT_PROFILE: {} });
  vm.runInContext(source('js/storage.js') + '\nglobalThis.store = Store;', context);
  const state = text => ({ profile: { name: 'Member A' }, weightLog: [], workoutLog: [], restDays: [],
    foodLog: [{ date: '2026-09-06', items: [{ text, kcal: 250, protein: 5 }] }] });
  context.store.state = state('Rice');
  assert.equal(context.store.merge(state('Paneer')).foodLog[0].items.length, 2);
});