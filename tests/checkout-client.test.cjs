'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');

function harness() {
  const state = { uid: 'member-a', token: 'fresh-token', requests: [], checkouts: [], messages: [], closes: 0 };
  const context = vm.createContext({
    document: { addEventListener() {} }, setTimeout, clearTimeout, AbortController, AbortSignal, URL,
    SupaAuth: { active: () => true, uid: () => state.uid, token: async () => state.token },
    Auth: { currentUser: () => ({ email: 'member@example.test' }) },
    Entitlements: { isPro: () => false, isElite: () => false },
    Cloud: { me: 'legacy-wrong-id' },
    RAZORPAY: { enabled: true }, window: { RAZORPAY: { enabled: true }, SUPABASE_URL: 'https://fixture.invalid', SUPABASE_ANON_KEY: 'public-fixture' },
    fetch: async (url, options) => {
      state.requests.push({ url, options });
      return { ok: true, json: async () => ({ order_id: 'order_fixture', amount: 100, currency: 'INR', key_id: 'provider-public-fixture' }) };
    },
    Razorpay: class { constructor(options) { this.options = options; } open() { state.checkouts.push(this.options); } }
  });
  vm.runInContext(source + '\nglobalThis.app = App;', context);
  const app = context.app;
  app.toast = message => state.messages.push(message);
  app._loadRzp = async () => {};
  app.closeModal = () => { state.closes++; };
  return { app, state, context };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('Checkout sends a fresh bearer token with the verified UUID and no editable payment notes', async () => {
  const { app, state } = harness();
  await app.choosePlan('pro', 'upi');
  assert.equal(state.requests[0].options.headers.Authorization, 'Bearer fresh-token');
  assert.equal(JSON.parse(state.requests[0].options.body).uid, 'member-a');
  assert.equal(state.checkouts.length, 1);
  assert.equal(state.checkouts[0].notes, undefined);
  assert.equal(state.checkouts[0].amount, 100);
});

test('Missing credentials or unsupported tiers never open checkout', async () => {
  const { app, state } = harness(); state.token = null;
  await app.choosePlan('pro', 'upi');
  assert.equal(state.requests.length, 0); assert.equal(state.checkouts.length, 0);
  state.token = 'fresh-token';
  for (const tier of ['free', 'eliteplus', '__proto__']) await app.choosePlan(tier, 'upi');
  assert.equal(state.requests.length, 0);
});

test('Repeated clicks share one in-flight order request', async () => {
  const { app, state, context } = harness(), token = deferred();
  context.SupaAuth.token = () => token.promise;
  const first = app.choosePlan('pro', 'upi'), second = app.choosePlan('pro', 'upi');
  token.resolve('fresh-token'); await Promise.all([first, second]);
  assert.equal(state.requests.length, 1); assert.equal(state.checkouts.length, 1);
});

test('Account switch while creating the order cannot open the previous account checkout', async () => {
  const { app, state, context } = harness(), pending = deferred();
  let requested;
  const requestSeen = new Promise(resolve => { requested = resolve; });
  context.fetch = async () => { requested(); return pending.promise; };
  const opening = app.choosePlan('elite', 'upi');
  await requestSeen; state.uid = 'member-b';
  pending.resolve({ ok: true, json: async () => ({ order_id: 'order_a', amount: 100, key_id: 'public', currency: 'INR' }) });
  await opening;
  assert.equal(state.checkouts.length, 0);
});

test('HTTP denial or malformed order cannot open checkout and can be retried', async () => {
  const { app, state, context } = harness(), original = context.fetch;
  context.fetch = async () => ({ ok: false, status: 403, json: async () => ({ order_id: 'unexpected' }) });
  await app.choosePlan('pro', 'upi'); assert.equal(state.checkouts.length, 0);
  context.fetch = async () => ({ ok: true, json: async () => ({ order_id: 'wrong-amount', amount: -1, key_id: 'public', currency: 'USD' }) });
  await app.choosePlan('pro', 'upi'); assert.equal(state.checkouts.length, 0);
  context.fetch = original; await app.choosePlan('pro', 'upi'); assert.equal(state.checkouts.length, 1);
});

test('Late checkout success after switching accounts does not run another account unlock UI', async () => {
  const { app, state } = harness(); let upgrades = 0;
  app._afterUpgrade = () => { upgrades++; };
  await app.choosePlan('elite', 'upi'); state.uid = 'member-b';
  state.checkouts[0].handler({ razorpay_payment_id: 'pay_fixture' });
  assert.equal(upgrades, 0);
});

test('Global checkout uses authenticated server creation, not editable hosted-link parameters', async () => {
  const { app, state, context } = harness(), navigations = [];
  context.window.LEMONSQUEEZY = { buy: { pro: 'https://formora.lemonsqueezy.com/checkout/buy/unsigned' } };
  context.window.location = { assign: url => navigations.push(url) };
  context.fetch = async (url, options) => {
    state.requests.push({ url, options });
    return { ok: true, json: async () => ({ url: 'https://formora.lemonsqueezy.com/checkout/secure' }) };
  };
  await app.choosePlan('pro');
  assert.match(state.requests[0].url, /\/functions\/v1\/create-checkout$/);
  assert.equal(state.requests[0].options.headers.Authorization, 'Bearer fresh-token');
  assert.deepEqual(JSON.parse(state.requests[0].options.body), { tier: 'pro' });
  assert.deepEqual(navigations, ['https://formora.lemonsqueezy.com/checkout/secure']);
  assert.equal(state.closes, 0);
});

test('Global checkout rejects untrusted URLs, denied orders and account-switch responses', async () => {
  for (const url of ['javascript:alert(1)', 'https://lemonsqueezy.com.attacker.test/pay', 'https://user:pass@formora.lemonsqueezy.com/pay', 'http://formora.lemonsqueezy.com/pay']) {
    const { app, context } = harness(), navigations = [];
    context.window.LEMONSQUEEZY = { buy: { pro: 'configured' } }; context.window.location = { assign: value => navigations.push(value) };
    context.fetch = async () => ({ ok: true, json: async () => ({ url }) });
    await app.choosePlan('pro'); assert.deepEqual(navigations, [], url);
  }
  const { app, state, context } = harness(), navigations = [];
  context.window.LEMONSQUEEZY = { buy: { pro: 'configured' } }; context.window.location = { assign: url => navigations.push(url) };
  context.fetch = async () => ({ ok: false, json: async () => ({ url: 'https://formora.lemonsqueezy.com/checkout/test' }) });
  await app.choosePlan('pro'); assert.deepEqual(navigations, []);
  context.fetch = async () => {
    state.uid = 'member-b';
    return { ok: true, json: async () => ({ url: 'https://formora.lemonsqueezy.com/checkout/test' }) };
  };
  await app.choosePlan('pro'); assert.deepEqual(navigations, []);
});