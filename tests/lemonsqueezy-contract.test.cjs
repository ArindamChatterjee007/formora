'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { webcrypto, createHmac, createHash } = require('node:crypto');

const accountId = '12345678-1234-4234-8234-123456789abc';
const otherId = '87654321-4321-4321-8321-cba987654321';
const checkoutId = '5e8b546c-c561-4a2c-a586-40c18bb2a195';
const checkoutUrl = 'https://formora.lemonsqueezy.com/checkout/custom/' + checkoutId + '?expires=1790000000&signature=fixture';
const portalUrl = 'https://formora.lemonsqueezy.com/billing?expires=1790000000&signature=fixture';
const secret = 'ls-webhook-fixture';
const proofFor = (uid = accountId, variant = '101') => createHmac('sha256', secret)
  .update(JSON.stringify(['lemonsqueezy-checkout-v1', uid, variant])).digest('hex');

function edge(name, overrides = {}) {
  const requests = [];
  const env = {
    SUPABASE_URL: 'https://database.example.test', SUPABASE_ANON_KEY: 'anon-fixture',
    SUPABASE_SERVICE_ROLE_KEY: 'service-fixture', LEMONSQUEEZY_API_KEY: 'ls-api-fixture',
    LS_STORE_ID: '42', LS_VARIANT_PRO: '101', LS_VARIANT_ELITE: '202',
    LS_WEBHOOK_SECRET: secret, LS_RETURN_URL: 'https://app.example.test/billing',
    ...overrides.env,
  };
  let handler;
  const defaultFetch = async (url, options) => {
    if (url === env.SUPABASE_URL + '/auth/v1/user') return Response.json({ id: accountId, email: 'verified@example.test' });
    if (url === 'https://api.lemonsqueezy.com/v1/checkouts') {
      const payload = JSON.parse(options.body).data;
      return Response.json({ data: { type: 'checkouts', id: checkoutId, attributes: {
        store_id: Number(payload.relationships.store.data.id),
        variant_id: Number(payload.relationships.variant.data.id),
        test_mode: payload.attributes.test_mode, url: checkoutUrl,
      } } });
    }
    if (url === env.SUPABASE_URL + '/rest/v1/rpc/apply_billing_event') return Response.json({ applied: true, duplicate: false });
    if (url.startsWith(env.SUPABASE_URL + '/rest/v1/entitlements?')) {
      return Response.json([{ uid: accountId, provider: 'lemonsqueezy', subscription_id: '303' }]);
    }
    if (url === 'https://api.lemonsqueezy.com/v1/subscriptions/303') {
      return Response.json({ data: { type: 'subscriptions', id: '303', attributes: {
        store_id: 42, test_mode: env.LS_TEST_MODE === 'true', user_email: 'verified@example.test', urls: { customer_portal: portalUrl },
      } } });
    }
    throw new Error('Unexpected hermetic fetch: ' + url);
  };
  const context = vm.createContext({
    Request, Response, Headers, URL, URLSearchParams, TextEncoder, TextDecoder,
    Date: class extends Date { static now() { return Date.parse('2026-09-06T12:00:00Z'); } },
    AbortController, AbortSignal, setTimeout, clearTimeout, crypto: webcrypto,
    Deno: { env: { get: key => env[key] }, serve: callback => { handler = callback; } },
    fetch: async (input, options = {}) => {
      const url = String(input);
      requests.push({ url, options });
      return overrides.fetch ? overrides.fetch(url, options, defaultFetch) : defaultFetch(url, options);
    },
  });
  const source = fs.readFileSync(path.join(__dirname, '../supabase/functions', name, 'index.ts'), 'utf8');
  assert.doesNotMatch(source, /^\s*import\b/m, 'Edge handlers must boot without remote imports');
  vm.runInContext(stripTypeScriptTypes(source), context, { filename: name + '.ts' });
  assert.equal(typeof handler, 'function');
  return { requests, context, env, invoke: request => handler(request) };
}

const checkoutRequest = (body = { tier: 'pro' }, headers = {}) => new Request('https://edge.example.test/checkout', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer user-fixture', ...headers },
  body: JSON.stringify(body),
});
const checkoutCalls = subject => subject.requests.filter(request => request.url === 'https://api.lemonsqueezy.com/v1/checkouts');

test('Checkout verifies bearer with anon key, derives identity, binds the chosen variant and server return URL', async () => {
  for (const [tier, variant] of [['pro', '101'], ['elite', '202']]) {
    const subject = edge('create-checkout');
    const response = await subject.invoke(checkoutRequest({ tier, uid: accountId.toUpperCase(), email: 'spoof@example.test' }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { url: checkoutUrl });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const auth = subject.requests[0];
    assert.equal(auth.url, subject.env.SUPABASE_URL + '/auth/v1/user');
    assert.equal(auth.options.headers.apikey, 'anon-fixture');
    assert.equal(auth.options.headers.Authorization, 'Bearer user-fixture');
    const call = checkoutCalls(subject)[0];
    const payload = JSON.parse(call.options.body).data;
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.headers.Authorization, 'Bearer ls-api-fixture');
    assert.equal(call.options.headers['Content-Type'], 'application/vnd.api+json');
    assert.deepEqual(payload.attributes.checkout_data, {
      email: 'verified@example.test', custom: { uid: accountId, variant, identity_proof: proofFor(accountId, variant) },
    });
    assert.deepEqual(payload.attributes.product_options, { redirect_url: subject.env.LS_RETURN_URL, enabled_variants: [Number(variant)] });
    assert.deepEqual(payload.relationships, {
      store: { data: { type: 'stores', id: '42' } }, variant: { data: { type: 'variants', id: variant } },
    });
    assert.equal(payload.attributes.test_mode, false);
    for (const request of subject.requests) {
      assert.ok(request.options.signal instanceof AbortSignal);
      assert.equal(request.options.redirect, 'error');
    }
  }
});

test('Checkout requires authentication and rejects a spoofed uid', async () => {
  for (const authorization of ['', 'Basic fixture', 'Bearer', 'Bearer first second']) {
    const subject = edge('create-checkout');
    assert.equal((await subject.invoke(checkoutRequest({ tier: 'pro' }, { Authorization: authorization }))).status, 401);
    assert.equal(subject.requests.length, 0);
  }
  for (const uid of [otherId, 'legacy_email_slug', '', null, 123, {}]) {
    const subject = edge('create-checkout');
    assert.equal((await subject.invoke(checkoutRequest({ tier: 'pro', uid }))).status, 403);
    assert.equal(checkoutCalls(subject).length, 0);
  }
  const subject = edge('create-checkout');
  assert.equal((await subject.invoke(checkoutRequest())).status, 200);
});

test('Checkout handles methods, malformed JSON and the strict paid-tier request schema', async () => {
  const subject = edge('create-checkout');
  assert.equal((await subject.invoke(new Request('https://edge.example.test', { method: 'OPTIONS' }))).status, 200);
  assert.equal((await subject.invoke(new Request('https://edge.example.test'))).status, 405);
  assert.equal(subject.requests.length, 0);
  for (const body of [null, [], 'pro', {}, ...['free', 'eliteplus', '__proto__', 'constructor', 'PRO', '', null].map(tier => ({ tier }))]) {
    assert.equal((await subject.invoke(checkoutRequest(body))).status, 400);
  }
  for (const field of ['return_url', 'test_mode', 'variant', 'variant_id', 'custom', 'identity_proof', 'store_id']) {
    assert.equal((await subject.invoke(checkoutRequest({ tier: 'pro', [field]: 'untrusted' }))).status, 400, field);
  }
  assert.equal((await subject.invoke(new Request('https://edge.example.test', {
    method: 'POST', headers: { Authorization: 'Bearer user-fixture' }, body: '{bad',
  }))).status, 400);
  assert.equal((await subject.invoke(checkoutRequest({ tier: 'pro', email: 'x'.repeat(5000) }))).status, 413);
  assert.equal(subject.requests.length, 0);
});

test('Checkout fails closed on missing or unsafe server configuration', async () => {
  const configurations = [
    ...['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'LEMONSQUEEZY_API_KEY', 'LS_WEBHOOK_SECRET', 'LS_STORE_ID',
      'LS_VARIANT_PRO', 'LS_VARIANT_ELITE', 'LS_RETURN_URL'].map(key => ({ [key]: '' })),
    ...['javascript:alert(1)', 'http://app.example.test', '//app.example.test', 'https://user:pass@app.example.test',
      'https://app.example.test:444', ' https://app.example.test', 'https://app.example.test\\@evil.test'].map(LS_RETURN_URL => ({ LS_RETURN_URL })),
    { LS_VARIANT_PRO: '0' }, { LS_VARIANT_PRO: '1e3' }, { LS_VARIANT_ELITE: '101' },
    { LS_VARIANT_PRO: '9007199254740992' }, { LS_TEST_MODE: 'yes' }, { SUPABASE_URL: 'https://database.example.test/other' },
  ];
  for (const env of configurations) {
    const subject = edge('create-checkout', { env });
    assert.equal((await subject.invoke(checkoutRequest())).status, 503, JSON.stringify(env));
    assert.equal(subject.requests.length, 0);
  }
});

test('Checkout does not trust invalid auth responses and exposes service failures without provider calls', async () => {
  const cases = [
    [() => new Response('denied', { status: 401 }), 401], [() => new Response('denied', { status: 403 }), 401],
    [() => new Response('unavailable', { status: 503 }), 503], [() => new Response('not-json'), 503],
    [() => Response.json({ id: 'email_slug', email: 'verified@example.test' }), 401],
    [() => Response.json({ id: accountId }), 401], [() => Response.json({ id: accountId, email: 'invalid' }), 401],
    [() => { throw new Error('private upstream details'); }, 503],
    [() => { throw new DOMException('Timed out', 'TimeoutError'); }, 503],
  ];
  for (const [reply, expected] of cases) {
    const subject = edge('create-checkout', { fetch: reply });
    const response = await subject.invoke(checkoutRequest());
    assert.equal(response.status, expected);
    assert.doesNotMatch(await response.text(), /private upstream/);
    assert.equal(checkoutCalls(subject).length, 0);
  }
});

test('Checkout sandbox mode requires an explicit server opt-in', async () => {
  const subject = edge('create-checkout', { env: { LS_TEST_MODE: 'true' } });
  assert.equal((await subject.invoke(checkoutRequest())).status, 200);
  assert.equal(JSON.parse(checkoutCalls(subject)[0].options.body).data.attributes.test_mode, true);
});

test('Checkout refuses unsafe, substituted or malformed provider checkout responses', async () => {
  const patches = [
    ...['', 'javascript:alert(1)', 'http://formora.lemonsqueezy.com/checkout/custom/' + checkoutId,
      'https://evil.test/checkout/custom/' + checkoutId, 'https://formora.lemonsqueezy.com.evil.test/checkout/custom/' + checkoutId,
      'https://user@formora.lemonsqueezy.com/checkout/custom/' + checkoutId, checkoutUrl + '#fragment',
      'https://formora.lemonsqueezy.com/checkout/buy/' + checkoutId,
      'https://formora.lemonsqueezy.com/checkout/custom/' + otherId].map(url => ({ url })),
    { variant_id: 202 }, { store_id: 999 }, { test_mode: true }, { test_mode: 'false' },
  ];
  for (const patch of patches) {
    const subject = edge('create-checkout', { fetch: async (url, options, fallback) => {
      if (!url.endsWith('/v1/checkouts')) return fallback(url, options);
      const body = await (await fallback(url, options)).json();
      Object.assign(body.data.attributes, patch);
      return Response.json(body);
    } });
    assert.equal((await subject.invoke(checkoutRequest())).status, 503, JSON.stringify(patch));
  }
  for (const reply of [() => new Response('denied', { status: 422 }), () => new Response('invalid-json'),
    () => Response.json({}), () => { throw new DOMException('Timed out', 'TimeoutError'); }]) {
    const subject = edge('create-checkout', { fetch: (url, options, fallback) => url.endsWith('/v1/checkouts') ? reply() : fallback(url, options) });
    assert.equal((await subject.invoke(checkoutRequest())).status, 503);
  }
});

const occurredAt = '2026-09-05T12:00:00.000000Z';
const periodEnd = '2026-10-05T12:00:00.000000Z';
function subscriptionEvent() {
  return {
    meta: { event_name: 'subscription_created', custom_data: { uid: accountId, variant: '101', identity_proof: proofFor() } },
    data: { type: 'subscriptions', id: '303', attributes: {
      store_id: 42, variant_id: 101, status: 'active', cancelled: false, test_mode: false,
      created_at: occurredAt, updated_at: occurredAt, renews_at: periodEnd, ends_at: null, trial_ends_at: null,
    } },
  };
}
function signedRaw(raw, signature = createHmac('sha256', secret).update(raw).digest('hex')) {
  return new Request('https://edge.example.test/webhook', { method: 'POST', headers: { 'x-signature': signature }, body: raw });
}
const signed = (event, signature) => signedRaw(JSON.stringify(event), signature);
const rpcCalls = subject => subject.requests.filter(request => request.url.endsWith('/rest/v1/rpc/apply_billing_event'));

test('Future provider timestamps cannot poison the billing cursor', async () => {
  const subject = edge('billing-webhook'), event = subscriptionEvent();
  event.data.attributes.updated_at = '9999-01-01T00:00:00Z';
  event.data.attributes.renews_at = '9999-02-01T00:00:00Z';
  assert.equal((await subject.invoke(signed(event))).status, 400);
  assert.equal(rpcCalls(subject).length, 0);
});

test('Webhook verifies the raw signature before parsing and rejects malformed signed JSON', async () => {
  const subject = edge('billing-webhook');
  assert.equal((await subject.invoke(new Request('https://edge.example.test'))).status, 405);
  for (const signature of ['', 'invalid', 'a'.repeat(63), 'a'.repeat(65), '0'.repeat(64), 'gg'.repeat(32)]) {
    assert.equal((await subject.invoke(signed(subscriptionEvent(), signature))).status, 401);
  }
  const original = JSON.stringify(subscriptionEvent());
  const signature = createHmac('sha256', secret).update(original).digest('hex');
  assert.equal((await subject.invoke(signedRaw(original + ' ', signature))).status, 401);
  for (const raw of ['{bad-json', 'null', '[]', '"string"', '{}', '{"meta":[]}', '{"meta":{"event_name":42}}', '{"meta":{"event_name":""}}']) {
    assert.equal((await subject.invoke(signedRaw(raw))).status, 400, raw);
  }
  assert.equal((await subject.invoke(signedRaw(Buffer.from([0xff, 0xfe])))).status, 400);
  assert.equal((await subject.invoke(signedRaw(' '.repeat(262145)))).status, 413);
  assert.equal(subject.requests.length, 0);
  const unconfigured = edge('billing-webhook', { env: { LS_WEBHOOK_SECRET: '' } });
  assert.equal((await unconfigured.invoke(signed(subscriptionEvent()))).status, 503);
  assert.equal(unconfigured.requests.length, 0);
});

test('Webhook uses Web Crypto HMAC verification for both signature and checkout proof', async () => {
  const subject = edge('billing-webhook');
  const verifications = [];
  subject.context.crypto = { subtle: {
    importKey: (...args) => webcrypto.subtle.importKey(...args),
    digest: (...args) => webcrypto.subtle.digest(...args),
    verify: (...args) => { verifications.push(args); return webcrypto.subtle.verify(...args); },
  } };
  const event = subscriptionEvent();
  const raw = JSON.stringify(event);
  const signature = createHmac('sha256', secret).update(raw).digest('hex').toUpperCase();
  assert.equal((await subject.invoke(signedRaw(raw, signature))).status, 200);
  assert.equal(verifications.length, 2);
  assert.equal(verifications[0][0], 'HMAC');
  assert.equal(Buffer.from(verifications[0][3]).toString(), raw);
  assert.equal(Buffer.from(verifications[1][3]).toString(), JSON.stringify(['lemonsqueezy-checkout-v1', accountId, '101']));
});

test('Webhook persists exactly one service-only atomic RPC with the full signed provider contract', async () => {
  const subject = edge('billing-webhook');
  const event = subscriptionEvent();
  const raw = JSON.stringify(event);
  const response = await subject.invoke(signedRaw(raw));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { applied: true, duplicate: false });
  assert.equal(subject.requests.length, 1);
  const request = rpcCalls(subject)[0];
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.apikey, 'service-fixture');
  assert.equal(request.options.headers.Authorization, 'Bearer service-fixture');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.equal(request.options.redirect, 'error');
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(request.options.body), {
    p_provider: 'lemonsqueezy', p_event_id: createHash('sha256').update(raw).digest('hex'), p_uid: accountId,
    p_event_type: 'subscription_created', p_occurred_at: occurredAt, p_reference: '303',
    p_tier: 'pro', p_status: 'active', p_period_end: periodEnd, p_raw: event,
  });
});

test('Webhook accepts the proof actually minted by checkout and never trusts a custom tier', async () => {
  for (const tier of ['pro', 'elite']) {
    const checkout = edge('create-checkout');
    assert.equal((await checkout.invoke(checkoutRequest({ tier }))).status, 200);
    const custom = JSON.parse(checkoutCalls(checkout)[0].options.body).data.attributes.checkout_data.custom;
    const event = subscriptionEvent();
    event.meta.custom_data = { ...custom, tier: tier === 'pro' ? 'elite' : 'pro' };
    event.data.attributes.variant_id = Number(custom.variant);
    const subject = edge('billing-webhook');
    assert.equal((await subject.invoke(signed(event))).status, 200);
    assert.equal(JSON.parse(rpcCalls(subject)[0].options.body).p_tier, tier);
  }
});

test('Webhook ignores unsupported events including invoice success without any provider or DB requests', async () => {
  for (const name of ['subscription_payment_success', 'subscription_payment_failed', 'subscription_payment_recovered',
    'subscription_payment_refunded', 'order_created', 'order_refunded', 'customer_updated', 'license_key_created', 'unknown_event']) {
    const event = subscriptionEvent();
    event.meta.event_name = name;
    event.data = { type: 'subscription-invoices', id: '999999', attributes: { subscription_id: '303', status: 'paid' },
      links: { self: 'https://evil.example.test/subscriptions/303' } };
    const subject = edge('billing-webhook');
    const response = await subject.invoke(signed(event));
    assert.equal(response.status, 200, name);
    assert.deepEqual(await response.json(), { ignored: true, reason: 'unsupported_event' });
    assert.equal(subject.requests.length, 0);
  }
});

test('Webhook rejects incorrect subscription resource types and identifiers', async () => {
  const invalidData = [undefined, null, [], {}, { type: 'subscription-invoices', id: '303', attributes: {} },
    ...['', 'sub_303', '../303', 0, '9007199254740992', {}].map(id => ({ type: 'subscriptions', id, attributes: {} }))];
  for (const data of invalidData) {
    const event = subscriptionEvent();
    event.data = data;
    const subject = edge('billing-webhook');
    assert.equal((await subject.invoke(signed(event))).status, 400);
    assert.equal(subject.requests.length, 0);
  }
});

test('Webhook denies sandbox events in production, conflicts and missing or nonboolean mode labels', async () => {
  for (const [attributeMode, metaMode, expected] of [[true, true, 403], [true, undefined, 403], [false, true, 403],
    [true, false, 403], [undefined, false, 400], [null, undefined, 400], ['false', false, 400], [false, 'false', 400]]) {
    const subject = edge('billing-webhook');
    const event = subscriptionEvent();
    event.data.attributes.test_mode = attributeMode;
    event.meta.test_mode = metaMode;
    assert.equal((await subject.invoke(signed(event))).status, expected);
    assert.equal(subject.requests.length, 0);
  }
  const staging = edge('billing-webhook', { env: { LS_TEST_MODE: 'true' } });
  const sandbox = subscriptionEvent();
  sandbox.meta.test_mode = true;
  sandbox.data.attributes.test_mode = true;
  assert.equal((await staging.invoke(signed(sandbox))).status, 200);
  assert.equal((await staging.invoke(signed(subscriptionEvent()))).status, 403);
  assert.equal(staging.requests.length, 1);
});

test('Webhook proofless legacy events require reconciliation and leave historical entitlements untouched', async () => {
  for (const custom of [undefined, null, {}, { uid: 'legacy_slug', tier: 'elite' },
    { uid: accountId, variant: '101' }, { uid: accountId, variant: '101', identity_proof: '' }]) {
    const historical = { uid: accountId, tier: 'elite', subscription_id: 'old-subscription', provider: 'lemonsqueezy' };
    const before = structuredClone(historical);
    const subject = edge('billing-webhook', { fetch: () => { historical.tier = 'free'; throw new Error('Unexpected legacy write'); } });
    const event = subscriptionEvent();
    event.meta.custom_data = custom;
    const response = await subject.invoke(signed(event));
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'legacy_checkout_reconciliation_required' });
    assert.equal(subject.requests.length, 0);
    assert.deepEqual(historical, before);
  }
});

test('Webhook rejects forged identity proofs, cross-account copies and variant substitution', async () => {
  for (const patch of [{ identity_proof: '0'.repeat(64) }, { identity_proof: 123 }, { identity_proof: {} },
    { identity_proof: 'not-hex' }, { identity_proof: proofFor(accountId, '202') }, { uid: otherId },
    { uid: 'legacy_slug' }, { variant: '202' }, { variant: 101 }, { variant: '0101' }]) {
    const event = subscriptionEvent();
    Object.assign(event.meta.custom_data, patch);
    const subject = edge('billing-webhook');
    assert.equal((await subject.invoke(signed(event))).status, 403, JSON.stringify(patch));
    assert.equal(subject.requests.length, 0);
  }
  const substituted = subscriptionEvent();
  substituted.data.attributes.variant_id = 202;
  const subject = edge('billing-webhook');
  assert.equal((await subject.invoke(signed(substituted))).status, 403);
  assert.equal(subject.requests.length, 0);
});

test('Webhook never defaults unknown variants to Pro and rejects foreign stores', async () => {
  for (const variant of [undefined, '', null, 0, 999, '1e2', {}, '9007199254740992']) {
    const event = subscriptionEvent();
    event.data.attributes.variant_id = variant;
    event.meta.custom_data.variant = String(variant);
    event.meta.custom_data.identity_proof = proofFor(accountId, String(variant));
    const subject = edge('billing-webhook');
    assert.equal((await subject.invoke(signed(event))).status, 400, String(variant));
    assert.equal(subject.requests.length, 0);
  }
  const event = subscriptionEvent();
  event.data.attributes.store_id = 999;
  const subject = edge('billing-webhook');
  assert.equal((await subject.invoke(signed(event))).status, 403);
  assert.equal(subject.requests.length, 0);
});

test('Webhook normalizes authoritative subscription status, finite trials and paid-through cancellations', async () => {
  const expired = '2026-09-01T12:00:00.000000Z';
  const trialEnd = '2026-09-12T12:00:00.000000Z';
  const cases = [
    [{ status: 'active' }, 'active', 'pro', periodEnd],
    [{ status: 'active', renews_at: expired }, 'inactive', 'free', expired],
    [{ status: 'active', renews_at: occurredAt }, 'inactive', 'free', occurredAt],
    [{ status: 'active', ends_at: expired }, 'inactive', 'free', expired],
    [{ status: 'on_trial', trial_ends_at: trialEnd }, 'trialing', 'pro', trialEnd],
    [{ status: 'on_trial', trial_ends_at: expired }, 'inactive', 'free', expired],
    [{ status: 'cancelled', cancelled: true, ends_at: trialEnd }, 'active', 'pro', trialEnd],
    [{ status: 'cancelled', cancelled: true, ends_at: expired }, 'canceled', 'free', expired],
    [{ status: 'cancelled', cancelled: true, ends_at: occurredAt }, 'canceled', 'free', occurredAt],
    [{ status: 'expired', cancelled: true, ends_at: expired }, 'inactive', 'free', expired],
    [{ status: 'expired', ends_at: periodEnd }, 'inactive', 'free', periodEnd],
    [{ status: 'past_due' }, 'inactive', 'free', periodEnd],
    [{ status: 'unpaid' }, 'inactive', 'free', periodEnd],
    [{ status: 'paused' }, 'inactive', 'free', periodEnd],
    [{ status: 'unpaid', renews_at: null }, 'inactive', 'free', null],
  ];
  for (const [patch, status, tier, end] of cases) {
    const event = subscriptionEvent();
    event.meta.event_name = 'subscription_updated';
    Object.assign(event.data.attributes, patch);
    const subject = edge('billing-webhook');
    assert.equal((await subject.invoke(signed(event))).status, 200, JSON.stringify(patch));
    const body = JSON.parse(rpcCalls(subject)[0].options.body);
    assert.equal(body.p_status, status, JSON.stringify(patch));
    assert.equal(body.p_tier, tier);
    assert.equal(body.p_period_end, end);
  }
  for (const name of ['subscription_resumed', 'subscription_unpaused', 'subscription_paused', 'subscription_cancelled', 'subscription_expired']) {
    const event = subscriptionEvent();
    event.meta.event_name = name;
    Object.assign(event.data.attributes, { status: 'expired', ends_at: expired });
    const subject = edge('billing-webhook');
    assert.equal((await subject.invoke(signed(event))).status, 200);
    assert.equal(JSON.parse(rpcCalls(subject)[0].options.body).p_tier, 'free', name);
  }
});

test('Webhook requires a known finite expiry before paid access and does not invent a provider timestamp', async () => {
  const patches = [
    { renews_at: null }, { renews_at: undefined }, { status: 'on_trial', trial_ends_at: null },
    { status: 'cancelled', cancelled: true, ends_at: null }, { status: 'expired', ends_at: null },
    ...[undefined, null, 'infinity', '2026-09-05', 1790000000, '2026-02-30T12:00:00Z',
      '2026-13-01T12:00:00Z', '2026-09-05T24:00:00Z', 'invalid'].map(updated_at => ({ updated_at })),
    ...['infinity', '', 1790000000, '2026-02-30T12:00:00Z'].map(renews_at => ({ renews_at })),
    { status: 'unknown' }, { status: 'cancelled', cancelled: false, ends_at: periodEnd },
    { status: 'active', cancelled: true, ends_at: periodEnd }, { cancelled: 'false' },
  ];
  for (const patch of patches) {
    const event = subscriptionEvent();
    Object.assign(event.data.attributes, patch);
    const subject = edge('billing-webhook');
    assert.equal((await subject.invoke(signed(event))).status, 400, JSON.stringify(patch));
    assert.equal(subject.requests.length, 0);
  }
  const event = subscriptionEvent();
  event.data.attributes.updated_at = '2026-09-05T14:00:00.123456+02:00';
  const subject = edge('billing-webhook');
  assert.equal((await subject.invoke(signed(event))).status, 200);
  assert.equal(JSON.parse(rpcCalls(subject)[0].options.body).p_occurred_at, event.data.attributes.updated_at, 'Preserve signed microsecond precision for SQL ordering');
});

test('Webhook retries preserve byte-based event identity and RPC input even across expiry', async () => {
  const receipts = new Map();
  const subject = edge('billing-webhook', { fetch: (url, options) => {
    assert.ok(url.endsWith('/rpc/apply_billing_event'));
    const body = JSON.parse(options.body);
    if (receipts.has(body.p_event_id)) {
      assert.equal(options.body, receipts.get(body.p_event_id), 'Same raw event must never change its ledger input');
      return Response.json({ applied: false, duplicate: true });
    }
    receipts.set(body.p_event_id, options.body);
    return Response.json({ applied: true, duplicate: false });
  } });
  const event = subscriptionEvent();
  event.meta.event_name = 'subscription_cancelled';
  Object.assign(event.data.attributes, { status: 'cancelled', cancelled: true, ends_at: periodEnd });
  vm.runInContext('Date.now = () => Date.parse("2026-09-05T12:00:00Z")', subject.context);
  assert.deepEqual(await (await subject.invoke(signed(event))).json(), { applied: true, duplicate: false });
  vm.runInContext('Date.now = () => Date.parse("2027-09-05T12:00:00Z")', subject.context);
  assert.deepEqual(await (await subject.invoke(signed(event))).json(), { applied: false, duplicate: true });
  assert.equal(rpcCalls(subject).length, 2);
  const first = JSON.parse(rpcCalls(subject)[0].options.body);
  assert.equal(first.p_period_end, periodEnd, 'Readers enforce this finite cutoff even on a delayed delivery');
  assert.equal(first.p_status, 'active');
  const raw = JSON.stringify(event) + '\n';
  assert.equal((await subject.invoke(signedRaw(raw))).status, 200);
  assert.equal(JSON.parse(rpcCalls(subject)[2].options.body).p_event_id, createHash('sha256').update(raw).digest('hex'));
  assert.notEqual(JSON.parse(rpcCalls(subject)[2].options.body).p_event_id, first.p_event_id);
});

test('Webhook returns 503 on HTTP, JSON, timeout or malformed RPC acknowledgements instead of losing events', async () => {
  const replies = [
    ...[400, 401, 403, 409, 500, 503].map(status => () => Response.json({ applied: true, duplicate: false }, { status })),
    () => new Response(null, { status: 204 }), () => new Response('not-json'),
    ...[null, [], {}, { applied: true }, { duplicate: false }, { applied: 'true', duplicate: false },
      { applied: false, duplicate: 'true' }, { applied: true, duplicate: true }].map(body => () => Response.json(body)),
    () => { throw new Error('private DB details'); }, () => { throw new DOMException('Timed out', 'TimeoutError'); },
  ];
  for (const reply of replies) {
    const subject = edge('billing-webhook', { fetch: reply });
    const response = await subject.invoke(signed(subscriptionEvent()));
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /private DB details/);
    assert.equal(subject.requests.length, 1);
  }
  const skipped = edge('billing-webhook', { fetch: () => Response.json({ applied: false, duplicate: false, reason: 'out_of_order' }) });
  const response = await skipped.invoke(signed(subscriptionEvent()));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { applied: false, duplicate: false, reason: 'out_of_order' });
});

test('Webhook fails closed without valid variant, store or service-only persistence configuration', async () => {
  for (const env of [{ LS_VARIANT_PRO: '' }, { LS_VARIANT_ELITE: '101' }, { LS_STORE_ID: '' }, { LS_TEST_MODE: 'TRUE' },
    { SUPABASE_SERVICE_ROLE_KEY: '' }, { SUPABASE_URL: '' }, { SUPABASE_URL: 'http://database.example.test' },
    { SUPABASE_URL: 'https://user:pass@database.example.test' }, { SUPABASE_URL: 'https://database.example.test/other' }]) {
    const subject = edge('billing-webhook', { env });
    assert.equal((await subject.invoke(signed(subscriptionEvent()))).status, 503, JSON.stringify(env));
    assert.equal(subject.requests.length, 0);
  }
});

test('Portal authenticates the caller and looks up only their own LS entitlement subscription', async () => {
  for (const body of [{}, { uid: accountId }, { uid: accountId.toUpperCase() }]) {
    const subject = edge('billing-portal');
    const response = await subject.invoke(checkoutRequest(body));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { url: portalUrl });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(subject.requests.length, 3);
    const [auth, entitlement, provider] = subject.requests;
    assert.equal(auth.url, subject.env.SUPABASE_URL + '/auth/v1/user');
    assert.equal(auth.options.headers.apikey, 'anon-fixture');
    assert.equal(auth.options.headers.Authorization, 'Bearer user-fixture');
    const query = new URL(entitlement.url);
    assert.equal(query.pathname, '/rest/v1/entitlements');
    assert.deepEqual(Object.fromEntries(query.searchParams), { select: 'uid,provider,subscription_id', uid: 'eq.' + accountId, provider: 'eq.lemonsqueezy', limit: '2' });
    assert.equal(entitlement.options.headers.apikey, 'service-fixture');
    assert.equal(entitlement.options.headers.Authorization, 'Bearer service-fixture');
    assert.equal(provider.url, 'https://api.lemonsqueezy.com/v1/subscriptions/303');
    assert.equal(provider.options.headers.Authorization, 'Bearer ls-api-fixture');
    for (const request of subject.requests) {
      assert.ok(request.options.signal instanceof AbortSignal);
      assert.equal(request.options.redirect, 'error');
      assert.ok(!request.options.method || request.options.method === 'GET', 'Portal never writes');
    }
  }
});

test('Portal denies missing auth, body identity spoofing and injected subscription ids before accessing entitlements', async () => {
  for (const authorization of ['', 'Basic fixture', 'Bearer', 'Bearer first second']) {
    const subject = edge('billing-portal');
    assert.equal((await subject.invoke(checkoutRequest({}, { Authorization: authorization }))).status, 401);
    assert.equal(subject.requests.length, 0);
  }
  for (const uid of [otherId, '', null, 123, {}, 'legacy_slug']) {
    const subject = edge('billing-portal');
    assert.equal((await subject.invoke(checkoutRequest({ uid }))).status, 403);
    assert.equal(subject.requests.length, 1);
    assert.ok(subject.requests[0].url.endsWith('/auth/v1/user'));
  }
  for (const body of [{ subscription_id: '999' }, { return_url: 'https://evil.test' }, { uid: accountId, email: 'spoof@example.test' }, null, [], 'uid']) {
    const subject = edge('billing-portal');
    assert.equal((await subject.invoke(checkoutRequest(body))).status, 400);
    assert.equal(subject.requests.length, 0);
  }
});

test('Portal handles methods, malformed bodies and auth-service failures explicitly', async () => {
  const subject = edge('billing-portal');
  const options = await subject.invoke(new Request('https://edge.example.test', { method: 'OPTIONS' }));
  assert.equal(options.status, 200);
  assert.equal(options.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal((await subject.invoke(new Request('https://edge.example.test'))).status, 405);
  assert.equal((await subject.invoke(new Request('https://edge.example.test', {
    method: 'POST', headers: { Authorization: 'Bearer user-fixture' }, body: '{bad-json',
  }))).status, 400);
  assert.equal((await subject.invoke(checkoutRequest({ uid: 'x'.repeat(5000) }))).status, 413);
  assert.equal(subject.requests.length, 0);
  for (const [reply, status] of [
    [() => new Response('denied', { status: 401 }), 401], [() => new Response('denied', { status: 403 }), 401],
    [() => new Response('unavailable', { status: 503 }), 503], [() => new Response('invalid-json'), 503],
    [() => Response.json({ id: 'slug', email: 'verified@example.test' }), 401], [() => Response.json({ id: accountId }), 401],
    [() => { throw new DOMException('Timed out', 'TimeoutError'); }, 503],
  ]) {
    const failed = edge('billing-portal', { fetch: reply });
    assert.equal((await failed.invoke(checkoutRequest({}))).status, status);
    assert.equal(failed.requests.length, 1);
  }
});

test('Portal never exposes another users subscription even if an entitlement lookup returns a mismatched row', async () => {
  for (const [rows, expected] of [
    [[{ uid: otherId, provider: 'lemonsqueezy', subscription_id: '999' }], 403],
    [[{ uid: accountId, provider: 'razorpay', subscription_id: '303' }], 403],
    [[{ uid: accountId, provider: 'lemonsqueezy', subscription_id: '../999' }], 409],
    [[{ uid: accountId, provider: 'lemonsqueezy', subscription_id: null }], 409],
    [[{ uid: accountId, provider: 'lemonsqueezy', subscription_id: 'sub_legacy' }], 409],
    [[], 404], [{ subscription_id: '303' }, 503], [[null], 503], [[{}, {}], 503],
  ]) {
    const subject = edge('billing-portal', { fetch: (url, options, fallback) => url.includes('/entitlements?') ? Response.json(rows) : fallback(url, options) });
    assert.equal((await subject.invoke(checkoutRequest({}))).status, expected, JSON.stringify(rows));
    assert.equal(subject.requests.length, 2);
    assert.equal(subject.requests.some(request => request.url.includes('api.lemonsqueezy.com')), false);
  }
});

test('Portal cross-checks provider subscription identity, store, mode and verified email', async () => {
  for (const patch of [{ store_id: 999 }, { test_mode: true }, { test_mode: 'false' },
    { user_email: 'other@example.test' }, { user_email: null }]) {
    const subject = edge('billing-portal', { fetch: async (url, options, fallback) => {
      const response = await fallback(url, options);
      if (!url.includes('/v1/subscriptions/')) return response;
      const body = await response.json();
      Object.assign(body.data.attributes, patch);
      return Response.json(body);
    } });
    const response = await subject.invoke(checkoutRequest({}));
    assert.equal(response.status, 403, JSON.stringify(patch));
    assert.doesNotMatch(await response.text(), /signature=/);
  }
  const subject = edge('billing-portal', { fetch: async (url, options, fallback) => {
    const response = await fallback(url, options);
    if (!url.includes('/v1/subscriptions/')) return response;
    const body = await response.json();
    body.data.id = '999';
    return Response.json(body);
  } });
  assert.equal((await subject.invoke(checkoutRequest({}))).status, 403);
  const staging = edge('billing-portal', { env: { LS_TEST_MODE: 'true' } });
  assert.equal((await staging.invoke(checkoutRequest({}))).status, 200);
});

test('Portal does not return empty or unsafe portal URLs', async () => {
  for (const url of [null, '', 'javascript:alert(1)', 'http://formora.lemonsqueezy.com/billing', 'https://evil.test/billing',
    'https://formora.lemonsqueezy.com.evil.test/billing', 'https://user:pass@formora.lemonsqueezy.com/billing',
    'https://formora.lemonsqueezy.com:444/billing', portalUrl + '#fragment', checkoutUrl, 'https://formora.lemonsqueezy.com/billing/999/update']) {
    const subject = edge('billing-portal', { fetch: async (input, options, fallback) => {
      const response = await fallback(input, options);
      if (!input.includes('/v1/subscriptions/')) return response;
      const body = await response.json();
      body.data.attributes.urls.customer_portal = url;
      return Response.json(body);
    } });
    assert.equal((await subject.invoke(checkoutRequest({}))).status, 503, String(url));
  }
});

test('Portal DB and provider failures are retryable errors, not empty success responses', async () => {
  for (const endpoint of ['/entitlements?', '/v1/subscriptions/']) {
    for (const reply of [...[401, 403, 500, 503].map(status => () => new Response('private service details', { status })),
      () => new Response('invalid-json'), () => { throw new Error('private network details'); },
      () => { throw new DOMException('Timed out', 'TimeoutError'); }]) {
      const subject = edge('billing-portal', { fetch: (url, options, fallback) => url.includes(endpoint) ? reply() : fallback(url, options) });
      const response = await subject.invoke(checkoutRequest({}));
      assert.equal(response.status, 503);
      assert.doesNotMatch(await response.text(), /private/);
      assert.equal(subject.requests.length, endpoint === '/entitlements?' ? 2 : 3);
    }
  }
  for (const body of [null, {}, { data: [] }, { data: { type: 'subscription-invoices', id: '303' } }]) {
    const subject = edge('billing-portal', { fetch: (url, options, fallback) => url.includes('/v1/subscriptions/') ? Response.json(body) : fallback(url, options) });
    assert.equal((await subject.invoke(checkoutRequest({}))).status, 503);
  }
  const missing = edge('billing-portal', { fetch: (url, options, fallback) => url.includes('/v1/subscriptions/') ? new Response('missing', { status: 404 }) : fallback(url, options) });
  assert.equal((await missing.invoke(checkoutRequest({}))).status, 409);
});

test('Portal requires complete service configuration and never falls back to an anon entitlement lookup', async () => {
  for (const env of [...['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'LEMONSQUEEZY_API_KEY', 'LS_STORE_ID'].map(key => ({ [key]: '' })),
    { LS_TEST_MODE: 'yes' }, { SUPABASE_URL: 'http://database.example.test' }, { SUPABASE_URL: 'https://database.example.test/path' }]) {
    const subject = edge('billing-portal', { env });
    assert.equal((await subject.invoke(checkoutRequest({}))).status, 503, JSON.stringify(env));
    assert.equal(subject.requests.length, 0);
  }
});