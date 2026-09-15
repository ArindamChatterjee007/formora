'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { webcrypto, createHmac } = require('node:crypto');
const accountId = '12345678-1234-4234-8234-123456789abc';
const otherId = '87654321-4321-4321-8321-cba987654321';

function edge(name, overrides = {}) {
  const requests = [];
  const env = {
    SUPABASE_URL: 'https://database.example.test', SUPABASE_ANON_KEY: 'public-fixture',
    SUPABASE_SERVICE_ROLE_KEY: 'server-fixture', RAZORPAY_KEY_ID: 'provider-fixture',
    RAZORPAY_KEY_SECRET: 'provider-secret-fixture', RAZORPAY_WEBHOOK_SECRET: 'webhook-fixture'
  };
  let handler;
  const context = vm.createContext({
    Request, Response, Headers, URL, URLSearchParams, TextEncoder, TextDecoder,
    AbortController, AbortSignal, setTimeout, clearTimeout, crypto: webcrypto, btoa,
    Deno: { env: { get: key => env[key] }, serve: fn => { handler = fn; } },
    fetch: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith('/auth/v1/user')) return Response.json({ id: accountId, email: 'verified@example.test' });
      if (String(url).endsWith('/v1/orders')) return Response.json({ id: 'order_fixture', amount: 100, currency: 'INR' });
      if (String(url).endsWith('/orders/order_fixture')) return Response.json({ id: 'order_fixture', amount: 100, currency: 'INR', status: 'paid', notes: { uid: accountId, tier: 'pro', identity_source: 'supabase_auth_v1' } });
      if (String(url).endsWith('/payments/pay_fixture')) return Response.json({ id: 'pay_fixture', order_id: 'order_fixture', amount: 100, currency: 'INR', status: 'captured', amount_refunded: 0 });
      if (String(url).endsWith('/rpc/apply_billing_event')) return Response.json({ applied: true, duplicate: false });
      if (String(url).includes('/entitlements?')) return Response.json([]);
      return new Response('', { status: 201 });
    }, ...overrides
  });
  const source = fs.readFileSync(path.join(__dirname, '../supabase/functions', name, 'index.ts'), 'utf8');
  vm.runInContext(stripTypeScriptTypes(source), context, { filename: name + '.ts' });
  return { requests, context, env, invoke: request => handler(request) };
}
const checkout = (body = { tier: 'pro' }, headers = {}) => new Request('https://edge.example.test/order', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-fixture-token', ...headers }, body: JSON.stringify(body)
});
function signed(event, signature) {
  const body = JSON.stringify(event);
  return new Request('https://edge.example.test/webhook', { method: 'POST', headers: {
    'x-razorpay-signature': signature || createHmac('sha256', 'webhook-fixture').update(body).digest('hex')
  }, body });
}
const captured = { event: 'payment.captured', created_at: 1788600000, payload: { payment: { entity: {
  id: 'pay_fixture', order_id: 'order_fixture', amount: 100, currency: 'INR', status: 'captured', notes: { uid: accountId, tier: 'pro' }
} } } };

test('Checkout derives identity and email from a verified session without a payload uid', async () => {
  const subject = edge('razorpay-create-order');
  const response = await subject.invoke(checkout({ tier: 'pro', email: 'forged@example.test' }));
  assert.equal(response.status, 200);
  const identity = subject.requests.find(r => r.url.endsWith('/auth/v1/user'));
  assert.ok(identity, 'Verify the bearer with Supabase, not a local JWT decode');
  assert.equal(identity.options.headers.Authorization, 'Bearer valid-fixture-token');
  const order = JSON.parse(subject.requests.find(r => r.url.endsWith('/v1/orders')).options.body);
  assert.equal(order.notes.uid, accountId);
  assert.equal(order.notes.email, 'verified@example.test');
  assert.equal(order.notes.identity_source, 'supabase_auth_v1');
  assert.equal(order.amount, 100, 'Do not alter the approved launch offer');
});

test('Missing or invalid authentication cannot create an order', async () => {
  const missing = edge('razorpay-create-order');
  assert.equal((await missing.invoke(checkout({ tier: 'elite', uid: accountId }, { Authorization: '' }))).status, 401);
  assert.equal(missing.requests.filter(r => r.url.includes('razorpay.com')).length, 0);
  const denied = edge('razorpay-create-order');
  denied.context.fetch = async () => new Response('denied', { status: 401 });
  assert.equal((await denied.invoke(checkout({ tier: 'pro', uid: accountId }))).status, 401);
});

test('A payload user mismatch is rejected, not written to provider notes', async () => {
  const subject = edge('razorpay-create-order');
  assert.equal((await subject.invoke(checkout({ tier: 'pro', uid: otherId }))).status, 403);
  assert.equal(subject.requests.filter(r => r.url.includes('razorpay.com')).length, 0);
});

test('Only paid tiers are accepted and both retain the approved amount', async () => {
  for (const tier of ['free', 'eliteplus', '__proto__', 'constructor', '', null]) {
    const subject = edge('razorpay-create-order');
    assert.equal((await subject.invoke(checkout({ tier, uid: accountId }))).status, 400, String(tier));
  }
  for (const tier of ['pro', 'elite']) {
    const subject = edge('razorpay-create-order');
    const response = await subject.invoke(checkout({ tier, uid: accountId }));
    assert.equal((await response.json()).amount, 100);
  }
});

test('Authentication service failure is retryable and never creates a payment order', async () => {
  const subject = edge('razorpay-create-order');
  subject.context.fetch = async () => { throw new Error('offline'); };
  const response = await subject.invoke(checkout({ tier: 'pro', uid: accountId }));
  assert.equal(response.status, 503);
});

test('Webhook rejects bad signatures and malformed signed JSON without a crash', async () => {
  const subject = edge('razorpay-webhook');
  assert.equal((await subject.invoke(signed(captured, 'invalid'))).status, 401);
  const raw = '{not-json';
  const signature = createHmac('sha256', 'webhook-fixture').update(raw).digest('hex');
  assert.equal((await subject.invoke(new Request('https://edge.example.test/webhook', { method: 'POST', headers: { 'x-razorpay-signature': signature }, body: raw }))).status, 400);
});

test('Webhook never acknowledges a failed atomic entitlement/audit transaction', async () => {
  for (const failure of [403, 500, 503]) {
    const subject = edge('razorpay-webhook');
    const original = subject.context.fetch;
    subject.context.fetch = async (url, options) => String(url).endsWith('/rpc/apply_billing_event') ? new Response('', { status: failure }) : original(url, options);
    assert.equal((await subject.invoke(signed(captured))).status, 503, String(failure));
  }
});

test('Webhook network failures are retryable, not uncaught errors', async () => {
  const subject = edge('razorpay-webhook');
  subject.context.fetch = async () => { throw new Error('offline'); };
  assert.equal((await subject.invoke(signed(captured))).status, 503);
});

test('Subscription authentication alone cannot grant paid access', async () => {
  const subject = edge('razorpay-webhook');
  const event = { event: 'subscription.authenticated', payload: { subscription: { entity: { id: 'sub_fixture', notes: { uid: accountId, tier: 'elite' } } } } };
  assert.equal((await subject.invoke(signed(event))).status, 200);
  assert.equal(subject.requests.length, 0);
});

test('An older signed subscription activation cannot override a provider cancellation', async () => {
  const subject = edge('razorpay-webhook'), original = subject.context.fetch;
  subject.context.fetch = async (url, options) => String(url).includes('/subscriptions/')
    ? Response.json({ id: 'sub_fixture', status: 'cancelled', notes: { uid: accountId, tier: 'elite', identity_source: 'supabase_auth_v1' } })
    : original(url, options);
  const event = { event: 'subscription.activated', created_at: captured.created_at,
    payload: { subscription: { entity: { id: 'sub_fixture', status: 'active', current_end: 1893456000 } } } };
  const response = await subject.invoke(signed(event));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'not active');
  assert.equal(subject.requests.some(request => request.url.includes('/rpc/')), false);
});

test('Webhook ignores editable payment notes and uses the verified server order', async () => {
  const subject = edge('razorpay-webhook'), event = structuredClone(captured);
  event.payload.payment.entity.notes = { uid: otherId, tier: 'elite' };
  assert.equal((await subject.invoke(signed(event))).status, 200);
  const request = subject.requests.find(r => r.url.endsWith('/rpc/apply_billing_event'));
  const body = JSON.parse(request.options.body);
  assert.equal(body.p_uid, accountId); assert.equal(body.p_tier, 'pro');
  assert.equal(body.p_reference, 'order_fixture'); assert.equal(body.p_period_end, null);
  assert.equal(body.p_occurred_at, new Date(captured.created_at * 1000).toISOString());
  assert.equal(subject.requests.some(r => /\/rest\/v1\/(entitlements|billing_events)$/.test(r.url)), false);
});

test('Unverified legacy orders do not silently grant access from old client metadata', async () => {
  const subject = edge('razorpay-webhook'), original = subject.context.fetch;
  subject.context.fetch = async (url, options) => String(url).includes('/orders/') ? Response.json({ id: 'order_fixture', amount: 100, currency: 'INR', status: 'paid', notes: { uid: accountId, tier: 'elite' } }) : original(url, options);
  assert.equal((await subject.invoke(signed(captured))).status, 409);
  assert.equal(subject.requests.some(r => r.url.includes('/rpc/')), false);
});

test('Provider payment amount and currency must match its order and signed event', async () => {
  for (const patch of [{ amount: 200 }, { currency: 'USD' }]) {
    const subject = edge('razorpay-webhook'), original = subject.context.fetch;
    subject.context.fetch = async (url, options) => String(url).includes('/payments/') ? Response.json({ id: 'pay_fixture', order_id: 'order_fixture', amount: 100, currency: 'INR', status: 'captured', ...patch }) : original(url, options);
    assert.equal((await subject.invoke(signed(captured))).status, 400);
  }
});

test('An already-refunded payment cannot be reactivated by replaying capture', async () => {
  const subject = edge('razorpay-webhook'), original = subject.context.fetch;
  subject.context.fetch = async (url, options) => String(url).includes('/payments/') ? Response.json({ id: 'pay_fixture', order_id: 'order_fixture', amount: 100, currency: 'INR', status: 'refunded', amount_refunded: 100 }) : original(url, options);
  assert.equal((await subject.invoke(signed(captured))).status, 200);
  assert.equal(subject.requests.some(r => r.url.includes('/rpc/')), false);
});

test('A processed full refund uses the original order reference and cancels atomically', async () => {
  const subject = edge('razorpay-webhook'), original = subject.context.fetch;
  subject.context.fetch = async (url, options) => {
    if (String(url).includes('/refunds/')) return Response.json({ id: 'rfnd_fixture', payment_id: 'pay_fixture', status: 'processed' });
    if (String(url).includes('/payments/')) return Response.json({ id: 'pay_fixture', order_id: 'order_fixture', amount: 100, currency: 'INR', status: 'refunded', amount_refunded: 100 });
    return original(url, options);
  };
  const event = { event: 'refund.processed', created_at: captured.created_at + 1, payload: { refund: { entity: { id: 'rfnd_fixture' } } } };
  assert.equal((await subject.invoke(signed(event))).status, 200);
  const body = JSON.parse(subject.requests.find(r => r.url.includes('/rpc/')).options.body);
  assert.equal(body.p_status, 'canceled'); assert.equal(body.p_tier, 'free'); assert.equal(body.p_reference, 'order_fixture');
});

test('Replay uses a stable event id and accepts only a structured atomic acknowledgement', async () => {
  const subject = edge('razorpay-webhook');
  await subject.invoke(signed(captured)); await subject.invoke(signed(captured));
  const calls = subject.requests.filter(r => r.url.includes('/rpc/')).map(r => JSON.parse(r.options.body));
  assert.equal(calls[0].p_event_id, calls[1].p_event_id);
  const original = subject.context.fetch;
  subject.context.fetch = async (url, options) => String(url).includes('/rpc/') ? Response.json({ ok: true }) : original(url, options);
  assert.equal((await subject.invoke(signed(captured))).status, 503);
});

test('A prorated upgrade preserves its existing paid-through date in the grant', async () => {
  const subject = edge('razorpay-create-order'), original = subject.context.fetch;
  const expiry = new Date(Date.now() + 86400000).toISOString();
  subject.context.fetch = async (url, options) => String(url).includes('/entitlements?') ? Response.json([{ tier: 'pro', status: 'active', current_period_end: expiry }]) : original(url, options);
  assert.equal((await subject.invoke(checkout({ tier: 'elite', upgrade: true }))).status, 200);
  const order = JSON.parse(subject.requests.find(r => r.url.endsWith('/v1/orders')).options.body);
  assert.equal(order.notes.access_until, expiry); assert.equal(order.amount, 100);
  const webhook = edge('razorpay-webhook'), webhookFetch = webhook.context.fetch;
  webhook.context.fetch = async (url, options) => String(url).includes('/orders/') ? Response.json({ id: 'order_fixture', ...order, status: 'paid' }) : webhookFetch(url, options);
  assert.equal((await webhook.invoke(signed(captured))).status, 200);
  assert.equal(JSON.parse(webhook.requests.find(r => r.url.includes('/rpc/')).options.body).p_period_end, expiry);
});

test('Malformed or oversized webhook bodies fail before provider or database calls', async () => {
  for (const value of [[], null, true, 'text']) {
    const subject = edge('razorpay-webhook');
    assert.equal((await subject.invoke(signed(value))).status, 400);
    assert.equal(subject.requests.length, 0);
  }
  const subject = edge('razorpay-webhook'), body = 'x'.repeat(262145);
  const oversized = new Request('https://edge.example.test/webhook', { method: 'POST', headers: { 'x-razorpay-signature': '0'.repeat(64) }, body });
  assert.equal((await subject.invoke(oversized)).status, 413);
  assert.equal(subject.requests.length, 0);
});

test('Provider UUIDs are canonicalized and subscription periods must agree', async () => {
  const subject = edge('razorpay-create-order'), original = subject.context.fetch;
  subject.context.fetch = async (url, options) => String(url).endsWith('/auth/v1/user') ? Response.json({ id: accountId.toUpperCase(), email: 'verified@example.test' }) : original(url, options);
  assert.equal((await subject.invoke(checkout({ tier: 'pro', uid: accountId }))).status, 200);
  assert.equal(JSON.parse(subject.requests.find(r => r.url.endsWith('/v1/orders')).options.body).notes.uid, accountId);
  const webhook = edge('razorpay-webhook'), event = { event: 'subscription.charged', created_at: captured.created_at, payload: { subscription: { entity: { id: 'sub_fixture', status: 'active', current_end: 1900000000 } } } };
  webhook.context.fetch = async () => Response.json({ id: 'sub_fixture', status: 'active', current_end: 1900000100, notes: { uid: accountId, tier: 'pro', identity_source: 'supabase_auth_v1' } });
  assert.equal((await webhook.invoke(signed(event))).status, 409);
});