'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { PGlite } = require('@electric-sql/pglite');
const { randomUUID, randomBytes, createECDH, webcrypto } = require('node:crypto');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/push-subscriptions.sql'), 'utf8');
const senderSource = fs.readFileSync(path.join(__dirname, '../supabase/functions/send-push/index.ts'), 'utf8');
const firstOwner = '11111111-1111-4111-8111-111111111111';
const secondOwner = '22222222-2222-4222-8222-222222222222';

function publicKey() {
  const key = createECDH('prime256v1');
  key.generateKeys();
  return key.getPublicKey().toString('base64url');
}
const vapidKey = publicKey();

// ---------------------------------------------------------------- SQL probes

function subscription(overrides = {}) {
  return { request: randomUUID(), device: randomUUID(), revision: 0,
    endpoint: 'https://fcm.googleapis.com/fcm/send/' + randomBytes(48).toString('base64url'),
    p256dh: publicKey(), auth: randomBytes(16).toString('base64url'), vapid: vapidKey,
    consent: 'push-generic-v1', ...overrides };
}

async function identity(db, role = 'authenticated', owner = firstOwner) {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [owner || '']);
  await db.exec('SET ROLE ' + role);
}

async function database(context, delivery = true) {
  const db = new PGlite();
  context.after(() => db.close());
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('${firstOwner}'), ('${secondOwner}');`);
  await db.exec(migration);
  await identity(db, 'service_role', null);
  await db.query('SELECT public.configure_push_subscriptions(true, $1, 30, $2)', [vapidKey, delivery]);
  return db;
}

async function register(db, owner = firstOwner, record = subscription()) {
  await identity(db, 'authenticated', owner);
  const revision = (await db.query('SELECT public.get_push_subscription_state($1) AS result', [record.device])).rows[0].result.revision;
  const receipt = (await db.query('SELECT public.register_push_subscription($1,$2,$3,$4,$5,$6,$7,$8) AS result',
    [record.request, record.device, revision, record.endpoint, record.p256dh, record.auth, record.vapid, record.consent])).rows[0].result;
  await identity(db, 'service_role', null);
  return { ...record, binding_id: receipt.binding_id };
}

const enqueue = (db, owner = firstOwner, category = 'workout_reminder', key = 'day:2026-09-06', ttl = 360) =>
  db.query('SELECT public.enqueue_push_dispatch($1,$2,$3,$4) AS result', [owner, category, key, ttl])
    .then(response => response.rows[0].result);
const claim = (db, limit = 10) =>
  db.query('SELECT public.claim_push_dispatches($1) AS result', [limit]).then(response => response.rows[0].result);
const authorize = (db, lease) =>
  db.query('SELECT public.authorize_push_dispatch($1,$2) AS result', [lease.dispatch_id, lease.lease_token])
    .then(response => response.rows[0].result);
const finish = (db, lease, outcome, error = null) =>
  db.query('SELECT public.finish_push_dispatch($1,$2,$3,$4) AS result', [lease.dispatch_id, lease.lease_token, outcome, error])
    .then(response => response.rows[0].result);
const rows = async (db, sql) => {
  await db.exec('RESET ROLE');
  const result = (await db.query(sql)).rows;
  await identity(db, 'service_role', null);
  return result;
};

test('dispatch queue is service-only: members and anon cannot enqueue, claim, authorize, finish or read it', async context => {
  const db = await database(context);
  const device = await register(db);
  await enqueue(db);
  const [lease] = await claim(db);
  for (const [role, owner] of [['anon', null], ['authenticated', firstOwner], ['authenticated', secondOwner]]) {
    await identity(db, role, owner);
    for (const command of ['SELECT * FROM ', 'DELETE FROM ']) {
      await assert.rejects(db.query(command + 'public.push_dispatches'), { code: '42501' });
    }
    await assert.rejects(enqueue(db, owner || firstOwner), { code: '42501' });
    await assert.rejects(claim(db), { code: '42501' });
    await assert.rejects(authorize(db, lease), { code: '42501' });
    await assert.rejects(finish(db, lease, 'sent'), { code: '42501' });
    await assert.rejects(db.query('SELECT public._push_base64url($1)', [Buffer.from('x')]), { code: '42501' });
  }
  await identity(db, 'service_role', null);
  assert.equal((await authorize(db, lease)).endpoint, device.endpoint);
});

test('delivery is off by default and an approved category with a dedupe key is required to queue anything', async context => {
  const db = await database(context, false);
  await register(db);
  await assert.rejects(enqueue(db), { code: 'PT403' });
  assert.deepEqual(await claim(db), []);
  await db.query('SELECT public.configure_push_subscriptions(true, $1, 30, true)', [vapidKey]);
  for (const category of ['marketing', 'promotion', 'referral_offer', 'app_update', '', null]) {
    await assert.rejects(enqueue(db, firstOwner, category), { code: '22023' });
  }
  for (const key of ['Day:2026', 'day 2026', 'a'.repeat(81), '', null]) {
    await assert.rejects(enqueue(db, firstOwner, 'workout_reminder', key), { code: '22023' });
  }
  for (const ttl of [0, 4, 1441, null]) {
    await assert.rejects(enqueue(db, firstOwner, 'account_notice', 'notice:1', ttl), { code: '22023' });
  }
  assert.equal((await enqueue(db, firstOwner, 'account_notice', 'notice:1')).queued, 1);
});

test('queueing is per active device, deduplicated, budget bounded and never targets another account', async context => {
  const db = await database(context);
  await register(db);
  await register(db);
  await register(db, secondOwner);
  const queued = await enqueue(db);
  assert.deepEqual({ queued: queued.queued, devices: queued.eligible_devices }, { queued: 2, devices: 2 });
  assert.equal((await enqueue(db)).queued, 0);
  assert.equal((await enqueue(db, secondOwner)).queued, 1);
  assert.equal((await rows(db, 'SELECT count(*)::int AS count FROM public.push_dispatches'))[0].count, 3);
  for (let index = 0; index < 4; index++) await enqueue(db, firstOwner, 'account_notice', 'notice:' + index);
  await assert.rejects(enqueue(db, firstOwner, 'account_notice', 'notice:overflow'), { code: 'PT429' });
  assert.equal((await enqueue(db, secondOwner, 'account_notice', 'notice:allowed')).queued, 1);
});

test('claim leases bounded work and hands out no endpoint or key material', async context => {
  const db = await database(context);
  await register(db);
  await enqueue(db);
  for (const limit of [0, 21, null]) await assert.rejects(claim(db, limit), { code: '22023' });
  const leases = await claim(db);
  assert.equal(leases.length, 1);
  assert.deepEqual(Object.keys(leases[0]).sort(), ['dispatch_id', 'lease_token']);
  assert.doesNotMatch(JSON.stringify(leases), /fcm\.googleapis|endpoint|p256dh|auth|owner/);
  assert.deepEqual(await claim(db), []);
  const stored = (await rows(db, 'SELECT state, attempts FROM public.push_dispatches'))[0];
  assert.deepEqual(stored, { state: 'leased', attempts: 1 });
});

test('authorization is rechecked at dispatch time and returns nothing once consent, binding or lease changes', async context => {
  const db = await database(context);
  const device = await register(db);
  await enqueue(db);
  const [lease] = await claim(db);
  const authorized = await authorize(db, lease);
  assert.equal(authorized.endpoint, device.endpoint);
  assert.equal(authorized.binding_id, device.binding_id);
  assert.equal(authorized.vapid_public_key, vapidKey);
  assert.equal(authorized.ttl_seconds, 3600);
  assert.equal(authorized.p256dh, device.p256dh);
  assert.equal(authorized.auth, device.auth);
  assert.equal(await authorize(db, { dispatch_id: lease.dispatch_id, lease_token: randomUUID() }), null);
  await db.query('SELECT public.configure_push_subscriptions(true, $1, 30, false)', [vapidKey]);
  assert.equal(await authorize(db, lease), null);
  await db.query('SELECT public.configure_push_subscriptions(true, $1, 30, true)', [vapidKey]);
  await rows(db, "UPDATE public.push_subscriptions SET binding_id = gen_random_uuid()");
  assert.equal(await authorize(db, lease), null);
  await rows(db, "UPDATE public.push_dispatches SET leased_until = clock_timestamp() - interval '1 minute'");
  assert.equal(await authorize(db, lease), null);
});

test('receipts need the current lease, retries back off to a bounded attempt count and 410 removes the endpoint', async context => {
  const db = await database(context);
  await register(db);
  await enqueue(db);
  let lease = (await claim(db))[0];
  await assert.rejects(finish(db, lease, 'marketing_sent'), { code: '22023' });
  await assert.rejects(finish(db, lease, 'sent', 'endpoint https://fcm.googleapis.com/x'), { code: '22023' });
  assert.deepEqual(await finish(db, lease, 'retry', 'provider_busy'),
    { accepted: true, state: 'pending', removed_subscription: false });
  assert.equal((await finish(db, lease, 'retry', 'provider_busy')).accepted, false);
  assert.deepEqual(await claim(db), []);
  for (let attempt = 2; attempt <= 3; attempt++) {
    await rows(db, 'UPDATE public.push_dispatches SET not_before = clock_timestamp()');
    lease = (await claim(db))[0];
    assert.equal(lease === undefined, false, 'attempt ' + attempt);
    assert.equal((await finish(db, lease, 'retry', 'provider_busy')).state, attempt === 3 ? 'failed' : 'pending');
  }
  await rows(db, "UPDATE public.push_dispatches SET not_before = clock_timestamp(), state = 'pending', attempts = 0");
  lease = (await claim(db))[0];
  assert.deepEqual(await finish(db, lease, 'gone', 'provider_gone'),
    { accepted: true, state: 'failed', removed_subscription: true });
  assert.equal((await rows(db, 'SELECT count(*)::int AS count FROM public.push_subscriptions'))[0].count, 0);
  assert.equal((await rows(db, 'SELECT count(*)::int AS count FROM public.push_dispatches'))[0].count, 0);
});

test('expired jobs and settled receipts are pruned in bounded batches and never resend', async context => {
  const db = await database(context);
  await register(db);
  await enqueue(db);
  await enqueue(db, firstOwner, 'account_notice', 'notice:1');
  const [settled] = await claim(db, 1);
  await finish(db, settled, 'sent');
  await rows(db, `UPDATE public.push_dispatches SET created_at = clock_timestamp() - interval '2 hours',
    expires_at = clock_timestamp() - interval '1 minute' WHERE state = 'pending'`);
  await rows(db, `UPDATE public.push_dispatches SET created_at = clock_timestamp() - interval '2 days' WHERE state = 'sent'`);
  assert.deepEqual(await claim(db), []);
  assert.equal((await rows(db, 'SELECT count(*)::int AS count FROM public.push_dispatches'))[0].count, 0);
  assert.equal((await rows(db, 'SELECT count(*)::int AS count FROM public.push_subscriptions'))[0].count, 1);
});

test('dedupe receipts outlive job pruning, expiry and 410 removal so an approved trigger never repeats', async context => {
  const db = await database(context);
  const device = await register(db);
  assert.equal((await enqueue(db, firstOwner, 'workout_reminder', 'day:2026-09-05')).queued, 1);
  const [sent] = await claim(db);
  await finish(db, sent, 'sent');
  await rows(db, "UPDATE public.push_dispatches SET created_at = clock_timestamp() - interval '2 days'");
  await claim(db);
  assert.equal((await rows(db, 'SELECT count(*)::int AS count FROM public.push_dispatches'))[0].count, 0);
  assert.equal((await enqueue(db, firstOwner, 'workout_reminder', 'day:2026-09-05')).queued, 0);
  assert.equal((await enqueue(db, firstOwner, 'account_notice', 'notice:1')).queued, 1);
  const [stale] = await claim(db);
  assert.deepEqual(await finish(db, stale, 'gone', 'provider_gone'),
    { accepted: true, state: 'failed', removed_subscription: true });
  await register(db, firstOwner, { ...device, request: randomUUID() });
  assert.equal((await enqueue(db, firstOwner, 'workout_reminder', 'day:2026-09-05')).queued, 0);
  assert.equal((await enqueue(db, firstOwner, 'account_notice', 'notice:1')).queued, 0);
  const stored = await rows(db, 'SELECT * FROM public.push_dispatch_receipts');
  assert.deepEqual(Object.keys(stored[0]).sort(), ['category', 'created_at', 'dedupe_key', 'device_id', 'owner_id']);
  assert.doesNotMatch(JSON.stringify(stored), /fcm\.googleapis|endpoint|p256dh|binding|open formora/i);
});

test('the daily owner budget counts the whole future fanout under the owner lock before inserting anything', async context => {
  const db = await database(context);
  for (let index = 0; index < 3; index++) await register(db);
  const receipts = async () => (await rows(db, 'SELECT count(*)::int AS count FROM public.push_dispatch_receipts'))[0].count;
  for (const key of ['day:1', 'day:2', 'day:3']) {
    assert.equal((await enqueue(db, firstOwner, 'workout_reminder', key)).queued, 3);
  }
  assert.equal(await receipts(), 9);
  await assert.rejects(enqueue(db, firstOwner, 'workout_reminder', 'day:4'), { code: 'PT429' });
  assert.equal(await receipts(), 9);
  assert.equal((await rows(db, 'SELECT count(*)::int AS count FROM public.push_dispatches'))[0].count, 9);
  const repeat = await enqueue(db, firstOwner, 'workout_reminder', 'day:1');
  assert.deepEqual({ queued: repeat.queued, remaining: repeat.daily_budget_remaining }, { queued: 0, remaining: 1 });
  assert.equal(await receipts(), 9);
  await register(db, secondOwner);
  assert.equal((await enqueue(db, secondOwner, 'workout_reminder', 'day:4')).queued, 1);
});

test('the dedupe retention window is service-configurable and pruned in bounded batches', async context => {
  const db = await database(context);
  for (let index = 0; index < 3; index++) await register(db);
  await enqueue(db, firstOwner, 'workout_reminder', 'day:1');
  const configured = (await db.query('SELECT public.configure_push_subscriptions(true,$1,30,true,$2) AS result', [vapidKey, 3])).rows[0].result;
  assert.equal(configured.dedupe_retention_days, 3);
  assert.equal(configured.lease_days, 30);
  for (const invalid of [0, 31, null]) {
    await assert.rejects(db.query('SELECT public.configure_push_subscriptions(true,$1,30,true,$2)', [vapidKey, invalid]), { code: '22023' });
  }
  await rows(db, `UPDATE public.push_dispatches SET created_at = clock_timestamp() - interval '2 hours',
    expires_at = clock_timestamp() - interval '1 minute'`);
  await claim(db);
  await rows(db, "UPDATE public.push_dispatch_receipts SET created_at = clock_timestamp() - interval '4 days'");
  const remaining = async () => (await rows(db, 'SELECT count(*)::int AS count FROM public.push_dispatch_receipts'))[0].count;
  for (const expected of [2, 1, 0]) {
    assert.equal((await db.query('SELECT public.prune_expired_push_subscriptions(1) AS count')).rows[0].count, 0);
    assert.equal(await remaining(), expected);
  }
  assert.equal((await enqueue(db, firstOwner, 'workout_reminder', 'day:1')).queued, 3);
});

test('dedupe receipts are service-only, account-scoped and erased with the account', async context => {
  const db = await database(context);
  await register(db);
  await enqueue(db);
  for (const [role, owner] of [['anon', null], ['authenticated', firstOwner], ['authenticated', secondOwner], ['service_role', null]]) {
    await identity(db, role, owner);
    for (const command of ['SELECT * FROM ', 'DELETE FROM ']) {
      await assert.rejects(db.query(command + 'public.push_dispatch_receipts'), { code: '42501' });
    }
    await assert.rejects(db.query('SELECT public._push_prune_dedupe(NULL,1,1)'), { code: '42501' });
  }
  await identity(db, 'service_role', null);
  await register(db, secondOwner);
  assert.equal((await enqueue(db, secondOwner)).queued, 1);
  await db.exec('RESET ROLE');
  await db.query('DELETE FROM auth.users WHERE id = $1', [firstOwner]);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM public.push_dispatch_receipts')).rows[0].count, 1);
});

// -------------------------------------------------------------- sender probes
const dispatchSecret = 'push-dispatch-fixture-not-a-real-secret';
const vapidPublic = publicKey();
const vapidPrivate = randomBytes(32).toString('base64url');
const providerEndpoint = 'https://fcm.googleapis.com/fcm/send/' + randomBytes(48).toString('base64url');

function authorization(overrides = {}) {
  return { dispatch_id: overrides.dispatch_id || fixtureLease.dispatch_id, category: 'workout_reminder',
    binding_id: '33333333-3333-4333-8333-333333333333', endpoint: providerEndpoint,
    p256dh: publicKey(), auth: randomBytes(16).toString('base64url'),
    vapid_public_key: vapidPublic, ttl_seconds: 3600, ...overrides };
}
const fixtureLease = { dispatch_id: '44444444-4444-4444-8444-444444444444', lease_token: '55555555-5555-4555-8555-555555555555' };
const finishState = outcome => outcome === 'sent' ? 'sent' : outcome === 'retry' ? 'pending' : 'failed';

function edge({ environment = {}, respond, library } = {}) {
  const requests = [], generated = [], logs = [];
  const env = { PUSH_DISPATCH_SECRET: dispatchSecret, PUSH_DELIVERY_ENABLED: 'true',
    PUSH_VAPID_PUBLIC_KEY: vapidPublic, PUSH_VAPID_PRIVATE_KEY: vapidPrivate,
    PUSH_VAPID_SUBJECT: 'mailto:push@formora.test', SUPABASE_URL: 'https://fixture.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-fixture-not-real', ...environment };
  let handler;
  const defaults = async (url, options) => {
    if (url.endsWith('/claim_push_dispatches')) return Response.json([fixtureLease]);
    if (url.endsWith('/authorize_push_dispatch')) return Response.json(authorization());
    if (url.endsWith('/finish_push_dispatch')) {
      return Response.json({ accepted: true, state: finishState(JSON.parse(options.body).p_outcome), removed_subscription: false });
    }
    if (url === providerEndpoint) return new Response(null, { status: 201 });
    throw new Error('Unexpected fixture request; real network is forbidden: ' + url);
  };
  const generateRequestDetails = (subscriptionInput, payload, options) => {
    generated.push({ subscription: subscriptionInput, payload, options });
    return library ? library(subscriptionInput, payload, options) : { method: 'POST', endpoint: subscriptionInput.endpoint,
      headers: { TTL: String(options.TTL), 'Content-Encoding': 'aes128gcm', Authorization: 'vapid t=fixture,k=fixture' },
      body: Buffer.from('encrypted-fixture-body') };
  };
  const context = vm.createContext({ Request, Response, Headers, URL, TextEncoder, TextDecoder,
    AbortController, AbortSignal, crypto: webcrypto, Date, Buffer, ArrayBuffer, Uint8Array, setTimeout, clearTimeout,
    console: Object.fromEntries(['log', 'info', 'error', 'warn', 'debug'].map(method => [method, (...args) => logs.push(args)])),
    Deno: { env: { get: key => env[key] }, serve: callback => { handler = callback; } },
    fetch: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      return respond ? respond(String(url), options, defaults) : defaults(String(url), options);
    } });
  const script = new vm.Script(stripTypeScriptTypes(senderSource), { filename: 'send-push.ts',
    importModuleDynamically: async specifier => {
      assert.equal(specifier, 'npm:web-push@3.6.7');
      const mocked = new vm.SyntheticModule(['default'], function () {
        this.setExport('default', { generateRequestDetails });
      }, { context });
      await mocked.link(() => {});
      await mocked.evaluate();
      return mocked;
    } });
  script.runInContext(context);
  return { requests, generated, logs,
    provider: () => requests.filter(request => request.url === providerEndpoint),
    finishes: () => requests.filter(request => request.url.endsWith('/finish_push_dispatch')).map(request => JSON.parse(request.options.body)),
    invoke: (init = {}) => handler(new Request('https://edge.example.test/send-push', {
      method: 'POST', headers: { Authorization: 'Bearer ' + dispatchSecret }, ...init })) };
}

test('an authorized run sends one bounded encrypted request carrying only the generic app-update payload', async () => {
  const subject = edge();
  const response = await subject.invoke();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { claimed: 1, sent: 1, retry: 0, failed: 0, gone: 0, skipped: 0, uncertain: 0 });
  assert.deepEqual(subject.requests.map(request => request.url.replace('https://fixture.supabase.co/rest/v1/rpc/', '')),
    ['claim_push_dispatches', 'authorize_push_dispatch', providerEndpoint, 'finish_push_dispatch']);
  assert.deepEqual(JSON.parse(subject.generated[0].payload),
    { v: 1, kind: 'app_update', binding_id: '33333333-3333-4333-8333-333333333333' });
  assert.deepEqual({ ...subject.generated[0].options.vapidDetails },
    { subject: 'mailto:push@formora.test', publicKey: vapidPublic, privateKey: vapidPrivate });
  assert.equal(subject.generated[0].options.contentEncoding, 'aes128gcm');
  const sent = subject.provider()[0];
  assert.equal(sent.options.redirect, 'error');
  assert.equal(sent.options.credentials, 'omit');
  assert.equal(sent.options.headers.get('TTL'), '3600');
  assert.equal(Buffer.from(sent.options.body).toString(), 'encrypted-fixture-body');
  assert.doesNotMatch(JSON.stringify([subject.generated, subject.finishes()]),
    /workout_reminder|weight|kcal|streak|health|message|owner_id|service-role/);
  assert.deepEqual(subject.finishes()[0], { p_dispatch_id: fixtureLease.dispatch_id,
    p_lease_token: fixtureLease.lease_token, p_outcome: 'sent', p_error: null });
});

test('only a constant-time dispatch-secret POST is accepted and the service key is never a caller credential', async () => {
  const subject = edge();
  assert.equal((await subject.invoke({ method: 'GET', body: undefined })).status, 405);
  for (const header of ['', 'Bearer ', 'Bearer wrong-secret', dispatchSecret,
    'Bearer ' + dispatchSecret.slice(0, -1), 'Bearer service-role-fixture-not-real']) {
    assert.equal((await subject.invoke({ headers: { Authorization: header } })).status, 401);
  }
  assert.equal(subject.requests.length, 0);
  for (const environment of [{ PUSH_DISPATCH_SECRET: 'short' }, { PUSH_DISPATCH_SECRET: 'service-role-fixture-not-real', SUPABASE_SERVICE_ROLE_KEY: 'service-role-fixture-not-real' }]) {
    assert.equal((await edge({ environment }).invoke()).status, 503);
  }
});

test('delivery stays off until it is explicitly configured, and misconfiguration never sends', async () => {
  for (const environment of [{ PUSH_DELIVERY_ENABLED: undefined }, { PUSH_DELIVERY_ENABLED: 'false' },
    { PUSH_DELIVERY_ENABLED: 'TRUE' }, { PUSH_VAPID_PRIVATE_KEY: undefined }, { PUSH_VAPID_PRIVATE_KEY: 'not base64url' },
    { PUSH_VAPID_PUBLIC_KEY: 'AAAA' }, { PUSH_VAPID_SUBJECT: 'http://formora.test' },
    { PUSH_VAPID_SUBJECT: 'javascript:alert(1)' }, { SUPABASE_URL: 'https://fixture.supabase.co.evil.test' }]) {
    const subject = edge({ environment });
    const response = await subject.invoke();
    assert.equal(response.status, 503, JSON.stringify(environment));
    assert.equal(subject.requests.length, 0);
  }
});

test('key-material debug logging prevents queue claims and encryption without writing logs', async () => {
  const subject = edge({ environment: { ECE_KEYLOG: '1' } });
  const response = await subject.invoke();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'unsafe_debug_configuration' });
  assert.equal(subject.requests.length, 0);
  assert.equal(subject.generated.length, 0);
  assert.deepEqual(subject.logs, []);
});

test('endpoints outside the provider allowlist are rejected before any request leaves the function', async () => {
  const token = randomBytes(24).toString('base64url');
  const rejected = ['http://fcm.googleapis.com/fcm/send/' + token, 'https://127.0.0.1/fcm/send/' + token,
    'https://169.254.169.254/latest/meta-data/' + token, 'https://fcm.googleapis.com.evil.test/fcm/send/' + token,
    'https://fcm.googleapis.com@evil.test/fcm/send/' + token, 'https://user:pass@fcm.googleapis.com/fcm/send/' + token,
    'https://fcm.googleapis.com:443/fcm/send/' + token, 'https://FCM.GOOGLEAPIS.COM/fcm/send/' + token,
    'https://fcm.googleapis.com/fcm/send/' + token + '?redirect=https://evil.test',
    'https://fcm.googleapis.com/fcm/send/' + token + '#fragment', 'https://fcm.googleapis.com/other/' + token,
    'https://web.push.apple.com/' + token + '/extra', 'https://fcm.googleapis.com/fcm/send/' + 'a'.repeat(2100), '', null];
  for (const endpoint of rejected) {
    const subject = edge({ respond: (url, options, defaults) => url.endsWith('/authorize_push_dispatch')
      ? Response.json(authorization({ endpoint })) : defaults(url, options) });
    const response = await subject.invoke();
    assert.deepEqual(await response.json(), { claimed: 1, sent: 0, retry: 0, failed: 1, gone: 0, skipped: 0, uncertain: 0 });
    assert.equal(subject.provider().length, 0, String(endpoint));
    assert.equal(subject.requests.some(request => /evil\.test|127\.0\.0\.1|169\.254/.test(request.url)), false);
    assert.deepEqual(subject.finishes()[0].p_error, 'endpoint_rejected');
  }
});

test('a tampered authorization or library response fails closed instead of contacting an unexpected host', async () => {
  const foreign = 'https://web.push.apple.com/' + randomBytes(24).toString('base64url');
  const cases = [
    { authorized: { vapid_public_key: publicKey() }, error: 'authorization_rejected' },
    { authorized: { p256dh: 'AAAA' }, error: 'authorization_rejected' },
    { authorized: { auth: randomBytes(24).toString('base64url') }, error: 'authorization_rejected' },
    { authorized: { binding_id: 'not-a-uuid' }, error: 'authorization_rejected' },
    { authorized: { ttl_seconds: 999999 }, error: 'authorization_rejected' },
    { library: (input, payload, options) => ({ method: 'POST', endpoint: foreign, headers: { TTL: String(options.TTL) }, body: Buffer.from('x') }), error: 'library_rejected' },
    { library: () => ({ method: 'POST', endpoint: providerEndpoint, headers: { 'X-Forwarded-Host': 'evil.test' }, body: Buffer.from('x') }), error: 'library_rejected' },
    { library: () => ({ method: 'GET', endpoint: providerEndpoint, headers: {}, body: Buffer.from('x') }), error: 'library_rejected' },
    { library: () => ({ method: 'POST', endpoint: providerEndpoint, headers: {}, body: 'not-a-buffer' }), error: 'library_rejected' },
    { library: () => ({ method: 'POST', endpoint: providerEndpoint, headers: {}, body: Buffer.alloc(4097) }), error: 'library_rejected' }
  ];
  for (const scenario of cases) {
    const subject = edge({ library: scenario.library,
      respond: (url, options, defaults) => url.endsWith('/authorize_push_dispatch') && scenario.authorized
        ? Response.json(authorization(scenario.authorized)) : defaults(url, options) });
    assert.equal((await subject.invoke()).status, 200);
    assert.equal(subject.provider().length, 0, scenario.error);
    assert.equal(subject.requests.some(request => request.url === foreign), false);
    assert.equal(subject.finishes()[0].p_error, scenario.error);
  }
});

test('provider outcomes map to truthful retry, terminal failure and stale-endpoint removal', async () => {
  const expectations = [[201, 'sent', null], [200, 'sent', null], [410, 'gone', 'provider_gone'],
    [404, 'gone', 'provider_gone'], [429, 'retry', 'provider_busy'], [503, 'retry', 'provider_busy'],
    [408, 'retry', 'provider_busy'], [400, 'failed', 'provider_rejected'], [403, 'failed', 'provider_rejected'],
    ['network', 'retry', 'network']];
  for (const [status, outcome, error] of expectations) {
    const subject = edge({ respond: (url, options, defaults) => {
      if (url !== providerEndpoint) return defaults(url, options);
      if (status === 'network') throw new TypeError('redirect blocked');
      return new Response(null, { status });
    } });
    const totals = await (await subject.invoke()).json();
    assert.equal(subject.finishes()[0].p_outcome, outcome, String(status));
    assert.equal(subject.finishes()[0].p_error, error);
    assert.equal(totals[outcome === 'sent' ? 'sent' : outcome], 1, String(status));
  }
});

test('revoked consent between claim and send is skipped, and unacknowledged work is reported as uncertain', async () => {
  const skipped = edge({ respond: (url, options, defaults) => url.endsWith('/authorize_push_dispatch')
    ? Response.json(null) : defaults(url, options) });
  assert.deepEqual(await (await skipped.invoke()).json(),
    { claimed: 1, sent: 0, retry: 0, failed: 0, gone: 0, skipped: 1, uncertain: 0 });
  assert.equal(skipped.provider().length, 0);
  assert.equal(skipped.finishes().length, 0);
  const unacknowledged = edge({ respond: (url, options, defaults) => url.endsWith('/finish_push_dispatch')
    ? Response.json({ accepted: false, state: null }) : defaults(url, options) });
  const response = await unacknowledged.invoke();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { claimed: 1, sent: 0, retry: 0, failed: 0, gone: 0, skipped: 0, uncertain: 1 });
  for (const claimed of [[{ dispatch_id: fixtureLease.dispatch_id, lease_token: 'not-a-uuid' }], [{}], 'nope']) {
    const malformed = edge({ respond: (url, options, defaults) => url.endsWith('/claim_push_dispatches')
      ? Response.json(claimed) : defaults(url, options) });
    const failed = await malformed.invoke();
    assert.equal(failed.status, 503);
    assert.equal(malformed.provider().length, 0);
  }
});

test('an empty queue costs one control-plane call and never reaches a provider or the push library', async () => {
  const subject = edge({ respond: (url, options, defaults) => url.endsWith('/claim_push_dispatches')
    ? Response.json([]) : defaults(url, options) });
  assert.deepEqual(await (await subject.invoke()).json(),
    { claimed: 0, sent: 0, retry: 0, failed: 0, gone: 0, skipped: 0, uncertain: 0 });
  assert.equal(subject.requests.length, 1);
  assert.equal(subject.generated.length, 0);
});
