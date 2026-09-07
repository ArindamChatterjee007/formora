{
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/entitlements.js'), 'utf8');
const now = Date.parse('2026-09-05T12:00:00Z');

function setup() {
  const context = vm.createContext({
    Cloud: { me: 'account-a', base: 'https://example.test/rest/v1', active: () => true, _headers: () => ({}) },
    Date: class extends Date { static now() { return now; } },
    AbortController, setTimeout, clearTimeout,
    fetch: async () => ({ ok: true, json: async () => [] })
  });
  vm.runInContext(source + '\nglobalThis.entitlements = Entitlements;', context);
  const reply = rows => { context.fetch = async () => ({ ok: true, json: async () => rows }); };
  return { context, entitlements: context.entitlements, reply };
}
const paid = end => ({ tier: 'elite', status: 'active', current_period_end: end });

test('Valid future entitlement unlocks the recorded tier', async () => {
  const { entitlements, reply } = setup();
  reply([paid('2026-09-06T12:00:00Z')]);
  await entitlements.load();
  assert.equal(entitlements.isElite(), true);
  assert.equal(entitlements.isPro(), true);
});

test('Expired, boundary and invalid expiry never unlock paid access', async () => {
  for (const expiry of ['2026-09-04T12:00:00Z', '2026-09-05T12:00:00Z', 'invalid']) {
    const { entitlements, reply } = setup();
    reply([paid(expiry)]); await entitlements.load();
    assert.equal(entitlements.isElite(), false, expiry);
    assert.equal(entitlements.isPro(), false, expiry);
    assert.equal(entitlements.tier(), 'free', expiry);
  }
});

test('Legacy undated access is preserved pending an approved access-period migration', async () => {
  const { entitlements, reply } = setup();
  reply([paid(null)]); await entitlements.load();
  assert.equal(entitlements.isElite(), true);
});

test('Account change fails closed immediately, before the next lookup', async () => {
  const { entitlements, context, reply } = setup();
  reply([paid(null)]); await entitlements.load();
  context.Cloud.me = 'account-b';
  assert.equal(entitlements.isElite(), false);
  assert.equal(entitlements.tier(), 'free');
  reply([]); await entitlements.load();
  assert.equal(entitlements.isElite(), false);
  context.Cloud.me = 'account-a';
  assert.equal(entitlements.isElite(), false);
});

test('Empty, malformed, rejected and offline reads clear previous access', async () => {
  const responses = [
    async () => ({ ok: true, json: async () => [] }),
    async () => ({ ok: true, json: async () => ({ tier: 'elite' }) }),
    async () => ({ ok: true, json: async () => [null] }),
    async () => ({ ok: false, status: 403 }),
    async () => { throw new Error('offline'); }
  ];
  for (const fetch of responses) {
    const { entitlements, context, reply } = setup();
    reply([paid(null)]); await entitlements.load();
    context.fetch = fetch; await entitlements.load();
    assert.equal(entitlements.isPro(), false);
    assert.equal(entitlements.tier(), 'free');
  }
});

test('Logging out or disabling cloud clears entitlement access', async () => {
  const { entitlements, context, reply } = setup();
  reply([paid(null)]); await entitlements.load();
  context.Cloud.me = ''; await entitlements.load();
  assert.equal(entitlements.isElite(), false);
  context.Cloud.me = 'account-a'; reply([paid(null)]); await entitlements.load();
  context.Cloud.active = () => false; await entitlements.load();
  assert.equal(entitlements.isElite(), false);
});

test('A late request for the previous account cannot unlock the current one', async () => {
  const { entitlements, context, reply } = setup();
  let resolve;
  context.fetch = () => new Promise(done => { resolve = done; });
  const oldRequest = entitlements.load();
  context.Cloud.me = 'account-b'; reply([]); await entitlements.load();
  resolve({ ok: true, json: async () => [paid(null)] }); await oldRequest;
  assert.equal(entitlements.isElite(), false);
});

test('A late request for the same account cannot overwrite a newer denial', async () => {
  const { entitlements, context, reply } = setup();
  let resolve;
  context.fetch = () => new Promise(done => { resolve = done; });
  const oldRequest = entitlements.load();
  reply([]); await entitlements.load();
  resolve({ ok: true, json: async () => [paid(null)] }); await oldRequest;
  assert.equal(entitlements.isElite(), false);
});

test('Unknown tiers and inactive statuses never unlock paid features', async () => {
  for (const row of [{ tier: 'elite', status: 'cancelled' }, { tier: 'admin', status: 'active' }]) {
    const { entitlements, reply } = setup(); reply([row]); await entitlements.load();
    assert.equal(entitlements.isPro(), false); assert.equal(entitlements.tier(), 'free');
  }
});
}

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'js/entitlements.js'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const free = { tier: 'free', status: 'inactive' };
const elite = { tier: 'elite', status: 'active', current_period_end: '2099-01-01T00:00:00Z' };

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function harness() {
  const state = { uid: 'member-A', token: 'fresh-token', requests: [], response: [elite] };
  const context = vm.createContext({
    console, URL, URLSearchParams, AbortController, Date,
    setTimeout, clearTimeout,
    SupaAuth: { active: () => true, uid: () => state.uid, email: () => 'member@example.test', token: async () => state.token },
    Cloud: { active: () => true, me: 'legacy_member', base: 'https://fixture.invalid/rest/v1', _headers: () => ({ Authorization: 'Bearer ' + state.token }) },
    fetch: async (url, options) => { state.requests.push({ url, options }); return { ok: true, json: async () => state.response }; }
  });
  vm.runInContext(source + '\nglobalThis.subject = Entitlements;', context);
  return { context, state, ent: context.subject };
}

test('membership waits for fresh credentials and uses the authenticated UUID on first load', async () => {
  const { context, state, ent } = harness();
  const refresh = deferred();
  state.token = 'expired-token';
  context.SupaAuth.token = async () => { await refresh.promise; state.token = 'fresh-token'; return state.token; };
  const loading = ent.load();
  await Promise.resolve();
  assert.equal(state.requests.length, 0, 'Do not send an expired-token entitlement request');
  refresh.resolve();
  await loading;
  assert.match(state.requests[0].url, /uid=eq\.member-A/);
  assert.equal(state.requests[0].options.headers.Authorization, 'Bearer fresh-token');
  assert.equal(ent.isElite(), true);
});

test('an empty result for another account cannot retain the previous paid tier', async () => {
  const { ent, state } = harness();
  await ent.load();
  assert.equal(ent.isElite(), true);
  state.uid = 'member-B';
  state.response = [];
  await ent.load();
  assert.equal(ent.isElite(), false);
  assert.equal(ent.tier(), 'free');
});

test('a tier read during a new account lookup cannot cancel that lookup', async () => {
  const { context, ent, state } = harness();
  await ent.load();
  const response = deferred();
  context.fetch = () => response.promise;
  state.uid = 'member-B';
  const loading = ent.load();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(ent.tier(), 'free');
  response.resolve({ ok: true, json: async () => [{ tier: 'pro', status: 'active', current_period_end: '2099-01-01T00:00:00Z' }] });
  await loading;
  assert.equal(ent.tier(), 'pro');
});

test('failed reads fail closed rather than retaining an old paid tier', async () => {
  const { ent, context } = harness();
  await ent.load();
  context.fetch = async () => ({ ok: false, status: 401 });
  await ent.load();
  assert.equal(ent.isPro(), false);
  assert.equal(ent.tier(), 'free');
});

test('known expiry is enforced; legacy null-expiry records remain active until migration', () => {
  const { ent } = harness();
  ent._e = { ...elite, current_period_end: '2000-01-01T00:00:00Z' };
  assert.equal(ent.isElite(), false);
  ent._e = { ...elite, current_period_end: 'not-a-date' };
  assert.equal(ent.isElite(), false);
  ent._e = { ...elite, current_period_end: null };
  assert.equal(ent.isElite(), true, 'Do not revoke historical null-expiry purchases by inventing a term');
});

test('late account-A response cannot override account-B membership', async () => {
  const { context, state, ent } = harness();
  const first = deferred();
  context.fetch = async url => String(url).includes('member-A') ? first.promise : { ok: true, json: async () => [free] };
  const loadingA = ent.load();
  await Promise.resolve(); await Promise.resolve();
  state.uid = 'member-B';
  await ent.load();
  first.resolve({ ok: true, json: async () => [elite] });
  await loadingA;
  assert.equal(ent.tier(), 'free');
});

test('logout reset invalidates outstanding membership requests', async () => {
  const { context, ent } = harness();
  const reply = deferred();
  context.fetch = () => reply.promise;
  const loading = ent.load();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(typeof ent.reset, 'function');
  ent.reset();
  reply.resolve({ ok: true, json: async () => [elite] });
  await loading;
  assert.equal(ent.tier(), 'free');
});

test('first visible app render uses the loaded membership without a refresh', async () => {
  const { context, ent } = harness();
  const elements = new Map();
  function element(id) {
    if (id === 'membership-status' && !elements.has(id)) return null;
    if (!elements.has(id)) {
      const classes = new Set(id === 'app-shell' ? ['hidden'] : []);
      elements.set(id, { textContent: '', classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) } });
    }
    return elements.get(id);
  }
  const account = { id: 'local-A', email: 'member@example.test' };
  context.document = { addEventListener() {}, getElementById: element, documentElement: { setAttribute() {} } };
  context.window = {};
  context.localStorage = { setItem() {}, removeItem() {} };
  context.Auth = { currentUser: () => account };
  context.Store = { load() {}, save() {}, state: { profile: { onboarded: true } } };
  context.Social = { load() {} };
  vm.runInContext(appSource + '\nglobalThis.appSubject = App;', context);
  const app = context.appSubject;
  const membership = deferred(), seen = [];
  Object.assign(app, {
    isBanned: () => false, applyAccount() {}, ensureUsername() {},
    syncAccountFromCloud: async () => {}, bindTabs() {}, renderChips() {},
    initCloud: async () => { await membership.promise; await ent.load(); },
    applyTierTheme() { seen.push(ent.isElite() ? 'elite' : 'free'); },
    selectTab() { seen.push('visible:' + ent.tier()); }
  });
  const entering = app.enterApp();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(element('app-shell').classList.contains('hidden'), true, 'Do not show the default Free shell before membership settles');
  membership.resolve();
  await entering;
  assert.equal(element('app-shell').classList.contains('hidden'), false);
  assert.deepEqual(seen, ['elite', 'visible:elite']);
});