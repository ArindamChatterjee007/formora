'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { webcrypto, randomUUID, createHmac } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');

const eventId = '12345678-1234-4234-8234-123456789abc';
const leaseToken = '87654321-4321-4321-8321-cba987654321';
const dispatchSecret = 'dispatch-fixture-not-a-real-secret-123456';
const endpoint = 'https://us.i.posthog.com/capture/';
const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/deliver-analytics/index.ts'), 'utf8');

function eventPayload(id = eventId) {
  return { event_id: id, event_name: 'purchase_confirmed', occurred_at: new Date().toISOString(),
    properties: { tier: 'pro', rail: 'upi', currency: 'INR', amount_minor: 100,
      price_class: 'other_or_unknown', billing_mode: 'live', charge_kind: 'unknown' } };
}

function edge({ environment = {}, respond, timerCap, date = Date, functionName = 'deliver-analytics' } = {}) {
  const requests = [], logs = [], timers = [];
  const env = { ANALYTICS_DISPATCH_SECRET: dispatchSecret, ANALYTICS_DELIVERY_ENABLED: 'true',
    ANALYTICS_POSTHOG_ENDPOINT: endpoint, ANALYTICS_POSTHOG_KEY: 'phc_abcdefghijklmnopqrstuvwxyz123456',
    SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-fixture-not-real',
    ...environment };
  let handler;
  const defaults = async (url, options) => {
    if (url.endsWith('/claim_analytics_events')) return Response.json([{ event_id: eventId, lease_token: leaseToken }]);
    if (url.endsWith('/authorize_analytics_delivery')) return Response.json(eventPayload(JSON.parse(options.body).p_event_id));
    if (url.endsWith('/finish_analytics_delivery')) return Response.json({ accepted: true, state: JSON.parse(options.body).p_outcome });
    if ([endpoint, 'https://eu.i.posthog.com/capture/'].includes(url)) return Response.json({ status: 1 });
    throw new Error('Unexpected fixture request; real network is forbidden');
  };
  const context = vm.createContext({ Request, Response, Headers, URL, TextEncoder, TextDecoder,
    AbortController, AbortSignal, crypto: webcrypto, Date: date, btoa,
    setTimeout: (callback, duration) => {
      timers.push(duration); return setTimeout(callback, timerCap === undefined ? duration : Math.min(duration, timerCap));
    }, clearTimeout,
    console: Object.fromEntries(['log', 'info', 'error', 'warn', 'debug'].map(method => [method, (...args) => logs.push(args)])),
    Deno: { env: { get: key => env[key] }, serve: callback => { handler = callback; } },
    fetch: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      return respond ? respond(String(url), options, defaults) : defaults(String(url), options);
    },
  });
  const code = functionName === 'deliver-analytics' ? source : fs.readFileSync(
    path.join(__dirname, '../supabase/functions', functionName, 'index.ts'), 'utf8');
  vm.runInContext(stripTypeScriptTypes(code), context, { filename: functionName + '.ts' });
  return { requests, logs, timers, env, invoke: (request = new Request('https://edge.example.test/deliver', {
    method: 'POST', headers: { Authorization: 'Bearer ' + dispatchSecret },
  })) => handler(request) };
}

const providerCalls = subject => subject.requests.filter(request => request.url === endpoint);
const finishes = subject => subject.requests.filter(request => request.url.endsWith('/finish_analytics_delivery'))
  .map(request => JSON.parse(request.options.body));

test('The authenticated dispatcher sends only fixed, minimal PostHog properties and a stable provider insertion UUID', async () => {
  const subject = edge();
  const response = await subject.invoke();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { claimed: 1, delivered: 1, retry: 0, dead: 0, skipped: 0, uncertain: 0 });
  assert.equal(subject.requests.length, 4);
  const request = providerCalls(subject)[0];
  const body = JSON.parse(request.options.body);
  assert.equal(body.event, 'purchase_confirmed');
  assert.equal(body.uuid, eventId);
  assert.equal(body.properties.$insert_id, eventId);
  assert.equal(body.properties.distinct_id, eventId);
  assert.equal(body.properties.$process_person_profile, false);
  assert.equal(body.properties.$geoip_disable, true);
  assert.equal(body.properties.$ip, null);
  assert.deepEqual(Object.keys(body.properties).sort(), [...Object.keys(eventPayload().properties),
    'distinct_id', '$insert_id', '$process_person_profile', '$geoip_disable', '$ip'].sort());
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(request.options.body.includes(subject.env.SUPABASE_SERVICE_ROLE_KEY), false);
  assert.equal(request.options.body.includes(dispatchSecret), false);
  assert.ok(subject.requests.every(request => request.options.redirect === 'error' && request.options.signal));
  assert.deepEqual(subject.logs, []);
});

test('The dispatcher preserves every actual rail and the explicit unknown value on the wire', async () => {
  for (const rail of ['upi', 'card', 'netbanking', 'wallet', 'unknown']) {
    const payload = eventPayload();
    payload.properties.rail = rail;
    const subject = edge({ respond: (url, options, defaults) => url.endsWith('/authorize_analytics_delivery')
      ? Response.json(payload) : defaults(url, options) });
    assert.equal((await subject.invoke()).status, 200);
    assert.equal(JSON.parse(providerCalls(subject)[0].options.body).properties.rail, rail);
    assert.equal(finishes(subject)[0].p_outcome, 'delivered');
  }
});

test('Missing/wrong scheduler authorization and non-POST requests make zero RPC or external requests', async () => {
  for (const authorization of ['', 'Bearer invalid', 'Bearer service-role-fixture-not-real']) {
    const subject = edge();
    assert.equal((await subject.invoke(new Request('https://edge.example.test/deliver', {
      method: 'POST', headers: { Authorization: authorization },
    }))).status, 401);
    assert.equal(subject.requests.length, 0);
  }
  const subject = edge();
  assert.equal((await subject.invoke(new Request('https://edge.example.test/deliver'))).status, 405);
  assert.equal(subject.requests.length, 0);
});

test('Delivery defaults OFF and missing secrets fail closed without any network attempt', async () => {
  for (const setting of [undefined, '', 'false', 'TRUE', '1']) {
    const subject = edge({ environment: { ANALYTICS_DELIVERY_ENABLED: setting } });
    assert.deepEqual(await (await subject.invoke()).json(), { enabled: false });
    assert.equal(subject.requests.length, 0);
  }
  for (const key of ['ANALYTICS_DISPATCH_SECRET', 'ANALYTICS_POSTHOG_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
    const subject = edge({ environment: { [key]: '' } });
    assert.equal((await subject.invoke()).status, 503);
    assert.equal(subject.requests.length, 0);
  }
});

test('Only exact configured US/EU ingestion URLs and a Supabase HTTPS origin are accepted', async () => {
  for (const value of ['https://evil.example.test/capture/', 'http://us.i.posthog.com/capture/',
    'https://us.i.posthog.com/capture/?token=leak', 'https://us.i.posthog.com/capture/#fragment',
    'https://us.i.posthog.com.evil.test/capture/', 'https://user@us.i.posthog.com/capture/',
    'https://us.i.posthog.com:443/capture/', 'https://us.i.posthog.com/capture',
    'https://us.i.posthog.com/../capture/', ' https://us.i.posthog.com/capture/']) {
    const subject = edge({ environment: { ANALYTICS_POSTHOG_ENDPOINT: value } });
    assert.equal((await subject.invoke()).status, 503, value);
    assert.equal(subject.requests.length, 0);
  }
  for (const value of ['http://localhost:54321', 'https://fixture.supabase.co/redirect',
    'https://fixture.supabase.co?url=evil', 'https://fixture.supabase.co.evil.test']) {
    const subject = edge({ environment: { SUPABASE_URL: value } });
    assert.equal((await subject.invoke()).status, 503);
    assert.equal(subject.requests.length, 0);
  }
  assert.equal((await edge({ environment: { ANALYTICS_POSTHOG_ENDPOINT: 'https://eu.i.posthog.com/capture/' } }).invoke()).status, 200);
});

test('A revoked or stale lease is rechecked before HTTP and sends nothing', async () => {
  const subject = edge({ respond: (url, options, defaults) => url.endsWith('/authorize_analytics_delivery')
    ? Response.json(null) : defaults(url, options) });
  assert.equal((await subject.invoke()).status, 200);
  assert.equal(providerCalls(subject).length, 0);
  assert.equal(finishes(subject).length, 0);
});

test('Transient HTTP failures schedule retries, while permanent rejections are dead-lettered', async () => {
  for (const status of [400, 401, 403, 408, 409, 425, 429, 500, 503]) {
    const subject = edge({ respond: (url, options, defaults) => url === endpoint
      ? new Response('secret or PII in an ignored provider error', { status }) : defaults(url, options) });
    const response = await subject.invoke();
    assert.equal(response.status, 200);
    assert.equal(finishes(subject)[0].p_outcome, [408, 425, 429, 500, 503].includes(status) ? 'retry' : 'dead');
    assert.equal(finishes(subject)[0].p_error, 'provider_http');
    assert.equal(JSON.stringify(await response.json()).includes('PII'), false);
    assert.deepEqual(subject.logs, []);
  }
});

test('Provider network exceptions are retried without logging exception messages or secrets', async () => {
  const subject = edge({ respond: (url, options, defaults) => {
    if (url === endpoint) throw new Error('secret-in-network-error');
    return defaults(url, options);
  } });
  assert.equal((await subject.invoke()).status, 200);
  assert.equal(finishes(subject)[0].p_error, 'network');
  assert.equal(finishes(subject)[0].p_outcome, 'retry');
  assert.deepEqual(subject.logs, []);
});

test('Provisional numeric acknowledgement formats pass locally while external acceptance remains a blocking gate', async () => {
  const rollout = JSON.parse(fs.readFileSync(path.join(__dirname, '../supabase/analytics-rollout.json'), 'utf8'));
  assert.equal(rollout.provider_acknowledgement.activation_blocking, true);
  assert.equal(rollout.provider_acknowledgement.externally_verified, false);
  for (const body of rollout.provider_acknowledgement.accepted_response_examples) {
    const subject = edge({ respond: (url, options, defaults) => url === endpoint
      ? Response.json(body) : defaults(url, options) });
    assert.equal((await subject.invoke()).status, 200);
    assert.equal(finishes(subject)[0].p_outcome, 'delivered');
  }
});

test('Successful HTTP without a positive provider body acknowledgement is not recorded as delivered', async () => {
  for (const body of ['not-json', '{"status":0}', '{"status":"Ok"}', '{"status":"1"}', '{"status":true}',
    '[1]', 'true', '{"success":true}', 'null', '']) {
    const subject = edge({ respond: (url, options, defaults) => url === endpoint
      ? new Response(body) : defaults(url, options) });
    await subject.invoke();
    assert.equal(finishes(subject)[0].p_outcome, 'retry');
    assert.equal(finishes(subject)[0].p_error, 'provider_rejected');
  }
});

test('A hanging provider response body is timed out, canceled and retried, including a non-resolving cancel', async () => {
  let canceled = false;
  const subject = edge({ timerCap: 20, respond: (url, options, defaults) => url === endpoint
    ? new Response(new ReadableStream({ cancel() { canceled = true; return new Promise(() => {}); } }))
    : defaults(url, options) });
  assert.equal((await subject.invoke()).status, 200);
  assert.equal(finishes(subject)[0].p_error, 'timeout');
  assert.ok(canceled);
  assert.ok(subject.timers.every(duration => duration > 0 && duration <= 4000));
  assert.ok(providerCalls(subject)[0].options.signal.aborted);
});

test('An unresolved fetch is bounded even when the mocked transport ignores abort', async () => {
  const subject = edge({ timerCap: 20, respond: (url, options, defaults) => url === endpoint
    ? new Promise(() => {}) : defaults(url, options) });
  assert.equal((await subject.invoke()).status, 200);
  assert.equal(finishes(subject)[0].p_error, 'timeout');
});

test('Unsafe event properties, test-mode rows and mismatched identities never reach PostHog', async () => {
  for (const change of [
    payload => { payload.properties.email = 'private@example.test'; },
    payload => { payload.properties.reason = 'private'; },
    payload => { payload.properties.tier = ['pro']; },
    payload => { payload.properties.rail = ['card']; },
    payload => { payload.properties.rail = null; },
    payload => { payload.properties.rail = 'cash'; },
    payload => { payload.event_name = ['purchase_confirmed']; },
    payload => { payload.properties.billing_mode = 'test'; },
    payload => { payload.properties.amount_minor = '100'; },
    payload => { payload.properties.amount_minor = 9007199254740992; },
    payload => { payload.properties.price_class = 'standard'; },
    payload => { payload.event_id = randomUUID(); },
    payload => { payload.event_name = 'membership_synced'; },
    payload => { payload.occurred_at = 'email@example.test'; },
  ]) {
    const payload = eventPayload(); change(payload);
    const subject = edge({ respond: (url, options, defaults) => url.endsWith('/authorize_analytics_delivery')
      ? Response.json(payload) : defaults(url, options) });
    await subject.invoke();
    assert.equal(providerCalls(subject).length, 0);
    assert.equal(finishes(subject)[0].p_outcome, 'dead');
    assert.equal(finishes(subject)[0].p_error, 'invalid_payload');
  }
});

test('Malformed, duplicate or oversized claim batches fail closed before any provider call', async () => {
  for (const value of [null, {}, [{ event_id: 'not-a-uuid', lease_token: leaseToken }],
    [{ event_id: eventId, lease_token: leaseToken, uid: 'private' }],
    Array.from({ length: 11 }, () => ({ event_id: randomUUID(), lease_token: randomUUID() })),
    Array.from({ length: 2 }, () => ({ event_id: eventId, lease_token: leaseToken }))]) {
    const subject = edge({ respond: (url, options, defaults) => url.endsWith('/claim_analytics_events')
      ? Response.json(value) : defaults(url, options) });
    assert.equal((await subject.invoke()).status, 503);
    assert.equal(providerCalls(subject).length, 0);
  }
});

test('Database request/body failures are bounded at claim, authorization and acknowledgement', async () => {
  for (const rpc of ['claim_analytics_events', 'authorize_analytics_delivery', 'finish_analytics_delivery']) {
    for (const failure of ['http', 'body', 'fetch']) {
      const subject = edge({ timerCap: 20, respond: (url, options, defaults) => {
        if (!url.endsWith('/' + rpc)) return defaults(url, options);
        if (failure === 'http') return new Response('private database details', { status: 503 });
        if (failure === 'fetch') return new Promise(() => {});
        return new Response(new ReadableStream());
      } });
      const response = await subject.invoke();
      assert.equal(response.status, 503, rpc + '/' + failure);
      assert.equal(providerCalls(subject).length, rpc === 'finish_analytics_delivery' ? 1 : 0);
      assert.equal((await response.text()).includes('private'), false);
      assert.deepEqual(subject.logs, []);
    }
  }
});

test('Oversized declared and streamed provider bodies are bounded without retaining the response text', async () => {
  for (const headers of [{ 'Content-Length': '16385' }, {}]) {
    const subject = edge({ respond: (url, options, defaults) => url === endpoint
      ? new Response('x'.repeat(16385), { headers }) : defaults(url, options) });
    await subject.invoke();
    assert.equal(finishes(subject)[0].p_outcome, 'retry');
    assert.equal(finishes(subject)[0].p_error, 'provider_rejected');
  }
});

test('The dispatcher does not follow redirects or consume request-controlled endpoints/properties', async () => {
  const subject = edge({ respond: (url, options, defaults) => url === endpoint
    ? new Response('', { status: 307, headers: { Location: 'https://evil.example.test/' } }) : defaults(url, options) });
  await subject.invoke(new Request('https://edge.example.test/deliver?endpoint=https://evil.example.test', {
    method: 'POST', headers: { Authorization: 'Bearer ' + dispatchSecret },
    body: JSON.stringify({ endpoint: 'https://evil.example.test', uid: 'private', batch_size: 99999 }),
  }));
  assert.equal(providerCalls(subject).length, 1);
  assert.ok(subject.requests.every(request => !request.url.includes('evil')));
  assert.equal(finishes(subject)[0].p_outcome, 'dead');
});

test('A ten-item batch stops at its total deadline and leaves unprocessed leases reclaimable', async () => {
  let clock = Date.now();
  class Clock extends Date { static now() { return clock; } }
  const leases = Array.from({ length: 10 }, () => ({ event_id: randomUUID(), lease_token: randomUUID() }));
  const subject = edge({ date: Clock, respond: (url, options, defaults) => {
    clock += 4000;
    if (url.endsWith('/claim_analytics_events')) return Response.json(leases);
    return defaults(url, options);
  } });
  assert.equal((await subject.invoke()).status, 503);
  assert.ok(subject.requests.length <= 7);
  assert.ok(providerCalls(subject).length < 10);
});

async function serverConsent(subject, granted) {
  return subject.transaction(async transaction => {
    await transaction.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [eventId]);
    await transaction.exec('SET LOCAL ROLE authenticated');
    return transaction.query("SELECT public.set_billing_analytics_consent($1, 'billing-analytics-v1')", [granted]);
  });
}

async function database(context) {
  const subject = new PGlite();
  context.after(() => subject.close());
  await subject.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS
      'SELECT nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
    CREATE TABLE public.entitlements (uid text PRIMARY KEY, tier text NOT NULL, status text NOT NULL,
      provider text, subscription_id text, current_period_end timestamptz, updated_at timestamptz DEFAULT now());
    CREATE TABLE public.billing_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), uid text NOT NULL,
      type text NOT NULL, raw jsonb NOT NULL, created_at timestamptz DEFAULT now());
  `);
  for (const name of ['billing-events.sql', 'analytics-outbox.sql']) {
    await subject.exec(fs.readFileSync(path.join(__dirname, '../supabase', name), 'utf8'));
  }
  await subject.exec(`UPDATE public.analytics_delivery_config SET collection_enabled = true, delivery_enabled = true;
    INSERT INTO public.analytics_billing_sources (provider, account_id, billing_mode, verified_at, enabled)
      VALUES ('razorpay', 'acc_fixture', 'live', clock_timestamp(), true)`);
  await serverConsent(subject, true);
  return subject;
}

function billingInput() {
  const created = Math.floor(Date.now() / 1000) + 2;
  return { p_provider: 'razorpay', p_event_id: 'evt_fixture', p_uid: eventId,
    p_event_type: 'payment.captured', p_occurred_at: new Date(created * 1000).toISOString(),
    p_reference: 'order_fixture', p_tier: 'pro', p_status: 'active', p_period_end: null,
    p_raw: { account_id: 'acc_fixture', event: 'payment.captured', created_at: created,
      payload: { payment: { entity: { id: 'pay_fixture', order_id: 'order_fixture', status: 'captured',
        amount: 100, currency: 'INR', amount_refunded: 0, captured: true, method: 'upi', created_at: created,
        email: 'private@example.test', notes: { uid: 'forged', tier: 'elite', health: 'private' } } } } } };
}

async function databaseRpc(subject, name, body) {
  const definitions = {
    apply_billing_event: ['p_provider', 'p_event_id', 'p_uid', 'p_event_type', 'p_occurred_at',
      'p_reference', 'p_tier', 'p_status', 'p_period_end', 'p_raw'],
    claim_analytics_events: ['p_limit'],
    authorize_analytics_delivery: ['p_event_id', 'p_lease_token'],
    finish_analytics_delivery: ['p_event_id', 'p_lease_token', 'p_outcome', 'p_error'],
  };
  assert.ok(Object.hasOwn(definitions, name), 'Unexpected RPC is not routed to any real service');
  const parameters = definitions[name];
  return subject.transaction(async transaction => {
    await transaction.exec('SET LOCAL ROLE service_role');
    const result = await transaction.query(`SELECT public.${name}(${parameters.map((parameter, index) => '$' + (index + 1)).join(',')}) AS result`,
      parameters.map(parameter => parameter === 'p_raw' ? JSON.stringify(body[parameter]) : body[parameter]));
    return Response.json(result.rows[0].result);
  });
}

function databaseTransport(subject, provider = () => Response.json({ status: 1 })) {
  return async (url, options) => {
    if (url.startsWith('https://fixture.supabase.co/rest/v1/rpc/')) {
      return databaseRpc(subject, url.split('/').at(-1), JSON.parse(options.body));
    }
    if (url === endpoint) return provider(url, options);
    throw new Error('Unexpected mock destination; no external calls permitted');
  };
}

test('The actual verified webhook, SQL transaction and dispatcher run end-to-end with mock external transport only', async context => {
  const subject = await database(context);
  const input = billingInput();
  input.p_raw.payload.payment.entity.method = 'card';
  const transport = databaseTransport(subject);
  const webhook = edge({ functionName: 'razorpay-webhook', environment: {
    RAZORPAY_WEBHOOK_SECRET: 'webhook-fixture', RAZORPAY_KEY_ID: 'rzp_live_fixture', RAZORPAY_KEY_SECRET: 'provider-secret-fixture',
  }, respond: (url, options) => {
    if (url.endsWith('/payments/pay_fixture')) return Response.json(input.p_raw.payload.payment.entity);
    if (url.endsWith('/orders/order_fixture')) return Response.json({ id: 'order_fixture', amount: 100,
      currency: 'INR', status: 'paid', notes: { uid: eventId, tier: 'pro', identity_source: 'supabase_auth_v1' } });
    return transport(url, options);
  } });
  const raw = JSON.stringify(input.p_raw);
  const signature = createHmac('sha256', 'webhook-fixture').update(raw).digest('hex');
  const request = () => new Request('https://edge.example.test/webhook', { method: 'POST',
    headers: { 'x-razorpay-signature': signature }, body: raw });
  assert.equal((await webhook.invoke(request())).status, 200);
  assert.equal((await webhook.invoke(request())).status, 200);
  assert.equal((await subject.query('SELECT count(*)::integer AS total FROM public.analytics_outbox')).rows[0].total, 1);
  const dispatcher = edge({ respond: transport });
  assert.equal((await dispatcher.invoke()).status, 200);
  assert.equal((await dispatcher.invoke()).status, 200);
  assert.equal(providerCalls(dispatcher).length, 1);
  const body = JSON.parse(providerCalls(dispatcher)[0].options.body);
  assert.equal(body.properties.tier, 'pro', 'Use verified order tier, never editable payment notes');
  assert.equal(body.properties.rail, 'card', 'The verified card capture must not be labelled as UPI');
  assert.equal(/private|forged|health/.test(JSON.stringify(body)), false);
  assert.notEqual(body.properties.distinct_id, eventId, 'No member UUID goes to analytics');
  assert.equal((await subject.query('SELECT state FROM public.analytics_outbox')).rows[0].state, 'delivered');
});

test('Real SQL retries preserve the exact PostHog insertion identity and immutable event payload', async context => {
  const subject = await database(context);
  await databaseRpc(subject, 'apply_billing_event', billingInput());
  let attempts = 0;
  const dispatcher = edge({ respond: databaseTransport(subject, () => {
    attempts++; return attempts === 1 ? new Response('', { status: 503 }) : Response.json(1);
  }) });
  assert.equal((await dispatcher.invoke()).status, 200);
  assert.equal((await subject.query('SELECT state FROM public.analytics_outbox')).rows[0].state, 'retry');
  await dispatcher.invoke();
  assert.equal(providerCalls(dispatcher).length, 1, 'Backoff is enforced by SQL');
  await subject.exec('UPDATE public.analytics_outbox SET available_at = clock_timestamp()');
  assert.equal((await dispatcher.invoke()).status, 200);
  assert.equal(providerCalls(dispatcher).length, 2);
  assert.deepEqual(JSON.parse(providerCalls(dispatcher)[0].options.body), JSON.parse(providerCalls(dispatcher)[1].options.body));
  assert.equal((await subject.query('SELECT attempts FROM public.analytics_outbox')).rows[0].attempts, 2);
});

test('Lost database acknowledgements are honestly uncertain; reclaim may repeat HTTP but not its insertion UUID', async context => {
  for (const commitBeforeLoss of [false, true]) {
    const subject = await database(context);
    await databaseRpc(subject, 'apply_billing_event', billingInput());
    const transport = databaseTransport(subject);
    let failOnce = true;
    const dispatcher = edge({ respond: async (url, options) => {
      if (failOnce && url.endsWith('/finish_analytics_delivery')) {
        failOnce = false;
        if (commitBeforeLoss) await transport(url, options);
        return new Response('', { status: 503 });
      }
      return transport(url, options);
    } });
    const first = await dispatcher.invoke();
    assert.equal(first.status, 503);
    assert.equal((await first.json()).uncertain, 1);
    await subject.exec("UPDATE public.analytics_outbox SET lease_until = clock_timestamp() - interval '1 second' WHERE state = 'sending'");
    assert.equal((await dispatcher.invoke()).status, 200);
    const posts = providerCalls(dispatcher);
    assert.equal(posts.length, commitBeforeLoss ? 1 : 2);
    assert.equal(new Set(posts.map(request => JSON.parse(request.options.body).properties.$insert_id)).size, 1);
    assert.equal((await subject.query('SELECT state FROM public.analytics_outbox')).rows[0].state, 'delivered');
  }
});

test('Revocation before authorize prevents HTTP; revocation during HTTP suppresses all later attempts but cannot retract the request', async context => {
  for (const duringHttp of [false, true]) {
    const subject = await database(context);
    await databaseRpc(subject, 'apply_billing_event', billingInput());
    const transport = databaseTransport(subject);
    let revokeOnce = true;
    const dispatcher = edge({ respond: async (url, options) => {
      if (revokeOnce && (duringHttp ? url === endpoint : url.endsWith('/authorize_analytics_delivery'))) {
        revokeOnce = false; await serverConsent(subject, false);
      }
      return transport(url, options);
    } });
    const response = await dispatcher.invoke();
    assert.equal(response.status, duringHttp ? 503 : 200);
    assert.equal(providerCalls(dispatcher).length, duringHttp ? 1 : 0);
    const totals = await response.json();
    assert.equal(totals.uncertain, duringHttp ? 1 : 0);
    assert.equal(totals.skipped, duringHttp ? 0 : 1);
    const stored = (await subject.query(`SELECT state, last_error, delivery_authorized_at, provider_acknowledged_at,
      delivered_at FROM public.analytics_outbox`)).rows[0];
    assert.equal(stored.state, 'suppressed');
    assert.equal(stored.last_error, duringHttp ? 'in_flight_ineligible' : 'consent_revoked');
    assert.equal(Boolean(stored.delivery_authorized_at), duringHttp);
    assert.equal(Boolean(stored.provider_acknowledged_at), duringHttp);
    assert.equal(stored.delivered_at, null);
    await serverConsent(subject, true);
    await dispatcher.invoke();
    assert.equal(providerCalls(dispatcher).length, duringHttp ? 1 : 0);
  }
});

test('An acknowledgement after source or policy invalidation is retained and reported uncertain, never skipped', async context => {
  for (const change of [
    "UPDATE public.analytics_delivery_config SET consent_version = 'billing-analytics-v2'",
    'UPDATE public.analytics_billing_sources SET enabled = false'
  ]) {
    const subject = await database(context);
    await databaseRpc(subject, 'apply_billing_event', billingInput());
    const dispatcher = edge({ respond: databaseTransport(subject, async () => {
      await subject.exec(change);
      return Response.json({ status: 1 });
    }) });
    const response = await dispatcher.invoke();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { claimed: 1, delivered: 0, retry: 0, dead: 0, skipped: 0, uncertain: 1 });
    const stored = (await subject.query('SELECT * FROM public.analytics_outbox')).rows[0];
    assert.equal(stored.state, 'suppressed');
    assert.equal(stored.last_error, 'in_flight_ineligible');
    assert.ok(stored.provider_acknowledged_at);
    assert.equal(stored.delivered_at, null);
    await dispatcher.invoke();
    assert.equal(providerCalls(dispatcher).length, 1);
  }
});

test('Revocation during a transport failure retains ambiguity without inventing provider acceptance', async context => {
  const subject = await database(context);
  await databaseRpc(subject, 'apply_billing_event', billingInput());
  const dispatcher = edge({ respond: databaseTransport(subject, async () => {
    await serverConsent(subject, false);
    throw new Error('Fixture lost response; remote acceptance is unknown');
  }) });
  const response = await dispatcher.invoke();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).uncertain, 1);
  const stored = (await subject.query('SELECT * FROM public.analytics_outbox')).rows[0];
  assert.equal(stored.state, 'suppressed');
  assert.equal(stored.last_error, 'in_flight_ineligible');
  assert.ok(stored.delivery_authorized_at);
  assert.equal(stored.provider_acknowledged_at, null);
  await serverConsent(subject, true);
  await dispatcher.invoke();
  assert.equal(providerCalls(dispatcher).length, 1);
});

test('Overlapping dispatcher invocations cannot acquire the same live lease in PGlite', async context => {
  const subject = await database(context);
  await databaseRpc(subject, 'apply_billing_event', billingInput());
  const dispatcher = edge({ respond: databaseTransport(subject) });
  const responses = await Promise.all([dispatcher.invoke(), dispatcher.invoke()]);
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(providerCalls(dispatcher).length, 1);
  context.diagnostic('PGlite serializes database transactions; real multi-session SKIP LOCKED contention remains a staging gate.');
});