'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/mod/measurement.js'), 'utf8');
const configSource = fs.readFileSync(path.join(__dirname, '../js/config.js'), 'utf8');
const analyticsPath = path.join(__dirname, '../js/analytics.js');
const trackSource = fs.existsSync(analyticsPath) ? fs.readFileSync(analyticsPath, 'utf8')
  : configSource.slice(configSource.indexOf('window.Track = {'), configSource.indexOf('// tasteful, athletic'));
const owner = '12345678-1234-4234-8234-123456789abc';
const otherOwner = '87654321-4321-4321-8321-cba987654321';
const version = 'billing-analytics-v1';
const supabaseUrl = 'https://measurement.invalid';
const permission = {
  label: 'Optional test measurement', description: 'Fixture copy, not an approved production permission.',
  effectiveDate: '2026-01-01', reviewStatus: 'approved', scopes: ['billing', 'checkout_started', 'membership_synced']
};

function token(uid = owner, extra = {}) {
  return Buffer.from('{"alg":"HS256"}').toString('base64url') + '.' + Buffer.from(JSON.stringify({
    sub: uid, role: 'authenticated', aud: 'authenticated', iss: supabaseUrl + '/auth/v1',
    exp: Math.floor(Date.now() / 1000) + 3600, ...extra
  })).toString('base64url') + '.fixture';
}

function response(consentState = 'unset', changes = {}) {
  return {
    granted: consentState === 'granted', version, consent_state: consentState,
    choice_version: consentState === 'unset' ? null : consentState === 'stale_version' ? 'old-version' : version,
    revision: consentState === 'unset' ? null : otherOwner,
    captured_at: consentState === 'unset' ? null : '2026-01-01T00:00:00+00:00', ...changes
  };
}

function streamedResponse(value) {
  let cancelled = false, sent = false;
  return new Response(new ReadableStream({
    async pull(controller) {
      if (sent) return;
      sent = true;
      const result = await value;
      if (cancelled) return;
      controller.enqueue(new TextEncoder().encode(JSON.stringify(result)));
      controller.close();
    },
    cancel() { cancelled = true; }
  }));
}

function fixture(options = {}) {
  const captures = [], requests = [], scripts = [];
  const Clock = options.now === undefined ? Date : class extends Date {
    constructor(...values) { super(...(values.length ? values : [options.now])); }
    static now() { return Date.parse(options.now); }
  };
  let current = { owner, jwt: token(owner, { exp: Math.floor(Clock.now() / 1000) + 3600 }), generation: 1 };
  let handler = async () => Response.json(response());
  const context = vm.createContext({ Date: Clock, URL, AbortController, TextDecoder, setTimeout, clearTimeout, atob,
    document: { createElement: () => ({}), head: { appendChild: element => scripts.push(element) } },
    SupaAuth: { active: () => true, uid: () => current?.owner || '' },
    POSTHOG_KEY: 'fixture-public-key', posthog: { capture: (...args) => captures.push(args) }
  });
  context.window = context;
  vm.runInContext(trackSource, context, { filename: 'actual-Track' });
  context.Track._sdk = true;
  vm.runInContext(source, context, { filename: 'measurement.js' });
  const client = context.Measurement.create({ enabled: true, supabaseUrl, publishableKey: 'fixture-public-key',
    getSession: () => current, track: context.Track, permissions: { [version]: permission },
    fetch: (...args) => { requests.push(args); return handler(...args); }, ...options
  });
  return { client, context, requests, captures, scripts, setSession: value => { current = value; },
    respond: value => { handler = typeof value === 'function' ? value : async () => Response.json(value); } };
}

function checkout(changes = {}) {
  return { owner, generation: 1, tier: 'pro', rail: 'upi', source: 'razorpay_order_sdk_ready', ...changes };
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }

function pendingStore() {
  const values = new Map(), writes = [];
  return { values, writes, getItem: key => values.get(key) || null,
    setItem(key, value) { values.set(key, value); writes.push([key, value]); },
    removeItem(key) { values.delete(key); writes.push([key, null]); } };
}

function finalizationPayload(changes = {}) {
  return { requestId: otherOwner, workoutDate: new Date().toISOString().slice(0, 10), ...changes };
}

const pendingRequestId = index => '10000000-0000-4000-8000-' + String(index).padStart(12, '0');
const storedRequests = subject => JSON.parse(subject.userStore.values.get('fm_activation_pending_' + owner)).requests;

function accountAcknowledgement(changes = {}) {
  const payload = finalizationPayload();
  return { owner, generation: 1, acknowledged: true, snapshot: { draftSession: null, restDays: [],
    workoutLog: [{ date: payload.workoutDate, finalizationRequestId: payload.requestId,
      exercises: [{ sets: [{ reps: 5, weight: 0 }] }], health: 'do-not-duplicate' }] }, ...changes };
}

function finalizationReceipt(changes = {}) {
  return { request_id: otherOwner, confirmed: true, status: 'recorded', recorded_at: new Date().toISOString(), ...changes };
}

async function activationFixture(options = {}) {
  const userStore = options.userStore || pendingStore();
  const subject = fixture({ permissions: { [version]: { ...permission, scopes: [...permission.scopes, 'activation'] } },
    userStore, ...options });
  subject.respond(response('granted'));
  await subject.client.load();
  return { ...subject, userStore };
}

test('Fixed-clock local September 6 while UTC is September 5 accepts only the adjacent UTC dates', async () => {
  const now = '2026-09-05T19:00:00Z';
  const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Calcutta',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  assert.equal(localDay, '2026-09-06');
  for (const [workoutDate, accepted] of [['2026-09-03', false], ['2026-09-04', true],
    ['2026-09-05', true], [localDay, true], ['2026-09-07', false]]) {
    const subject = await activationFixture({ now });
    const payload = finalizationPayload({ workoutDate });
    assert.equal(subject.client.scheduleWorkoutFinalization(payload), accepted, workoutDate);
    const expected = finalizationReceipt({ recorded_at: now });
    subject.respond(expected);
    const result = await subject.client.recordWorkoutFinalization(payload, accountAcknowledgement());
    assert.equal(result.confirmed, accepted, workoutDate);
    assert.equal(result.recorded_at, accepted ? now : null);
    assert.equal(subject.requests.length, accepted ? 2 : 1);
    assert.doesNotMatch(JSON.stringify(subject.userStore.writes), /workoutDate|recorded_at|\d{4}-\d{2}-\d{2}/);
  }
});

test('Finalization queues only with explicit activation permission and sends only after a same-generation account acknowledgement', async () => {
  const subject = await activationFixture();
  const payload = finalizationPayload();
  assert.equal(subject.client.scheduleWorkoutFinalization(payload), true);
  assert.equal(subject.requests.length, 1);
  for (const ack of [undefined, accountAcknowledgement({ acknowledged: false }), accountAcknowledgement({ acknowledged: undefined }),
    accountAcknowledgement({ owner: otherOwner }), accountAcknowledgement({ generation: 2 })]) {
    assert.equal((await subject.client.recordWorkoutFinalization(payload, ack)).confirmed, false);
    assert.deepEqual(plain(await subject.client.flushWorkoutFinalizations(ack)), []);
  }
  assert.equal(subject.requests.length, 1);
  const expected = finalizationReceipt();
  subject.respond(expected);
  assert.deepEqual(plain(await subject.client.recordWorkoutFinalization(payload, accountAcknowledgement())), { ...expected, queued: false });
  const [url, init] = subject.requests.at(-1);
  assert.equal(url, supabaseUrl + '/rest/v1/rpc/record_workout_finalization');
  assert.deepEqual(JSON.parse(init.body), { p_request_id: payload.requestId, p_workout_date: payload.workoutDate,
    p_consent_version: version, p_consent_revision: otherOwner });
  assert.equal(init.headers.Authorization, subject.requests[0][1].headers.Authorization);
  assert.equal(init.credentials, 'omit');
  assert.equal(init.redirect, 'error');
  assert.equal(init.cache, 'no-store');
  assert.deepEqual(plain(await subject.client.recordWorkoutFinalization(payload, accountAcknowledgement())), { ...expected, queued: false });
  assert.equal(subject.requests.length, 2);
  assert.deepEqual(subject.captures, []);
  assert.doesNotMatch(JSON.stringify(subject.userStore.writes), /workoutDate|workoutLog|exercises|health|jwt|Bearer|recorded_at|\d{4}-\d{2}-\d{2}/);
});

test('Finalization remains inert while disabled, signed out, unconsented or missing the activation scope', async () => {
  for (const scenario of ['off', 'signed_out', 'billing_only', 'declined', 'pending_policy']) {
    const userStore = pendingStore();
    const subject = fixture({ enabled: scenario !== 'off', userStore,
      permissions: { [version]: { ...permission, reviewStatus: scenario === 'pending_policy' ? 'pending' : 'approved',
        scopes: scenario === 'billing_only' ? permission.scopes : [...permission.scopes, 'activation'] } } });
    if (scenario === 'signed_out') subject.setSession(null);
    subject.respond(response(scenario === 'declined' ? 'declined' : 'granted'));
    await subject.client.load();
    const before = subject.requests.length, writes = userStore.writes.length;
    assert.equal(subject.client.scheduleWorkoutFinalization(finalizationPayload()), false, scenario);
    assert.equal((await subject.client.recordWorkoutFinalization(finalizationPayload(), accountAcknowledgement())).confirmed, false);
    assert.deepEqual(plain(await subject.client.flushWorkoutFinalizations(accountAcknowledgement())), []);
    assert.equal(subject.requests.length, before);
    assert.equal(userStore.writes.length, writes);
  }
});

test('Opaque pending IDs survive reload but flush only matching acknowledged logs, never drafts, rest or unrelated entries', async () => {
  const subject = await activationFixture();
  assert.equal(subject.client.scheduleWorkoutFinalization(finalizationPayload()), true);
  const reloaded = await activationFixture({ userStore: subject.userStore });
  reloaded.respond(finalizationReceipt());
  for (const snapshot of [{}, { draftSession: {}, workoutLog: accountAcknowledgement().snapshot.workoutLog, restDays: [] },
    { ...accountAcknowledgement().snapshot, restDays: [finalizationPayload().workoutDate] },
    { ...accountAcknowledgement().snapshot, workoutLog: [...accountAcknowledgement().snapshot.workoutLog,
      ...accountAcknowledgement().snapshot.workoutLog] }]) {
    assert.deepEqual(plain(await reloaded.client.flushWorkoutFinalizations(accountAcknowledgement({ snapshot }))), []);
  }
  assert.equal(reloaded.requests.length, 1);
  const results = await reloaded.client.flushWorkoutFinalizations(accountAcknowledgement());
  assert.equal(results.length, 1);
  assert.equal(results[0].confirmed, true);
  assert.equal(reloaded.requests.length, 2);
});

test('Uncertain finalization is retried only by an explicit acknowledged flush and is capped across reloads', async () => {
  let subject = await activationFixture({ timeoutMs: 15 });
  subject.client.scheduleWorkoutFinalization(finalizationPayload());
  for (let attempt = 1; attempt <= 3; attempt++) {
    subject.respond(async () => streamedResponse(new Promise(() => {})));
    const result = await subject.client.recordWorkoutFinalization(finalizationPayload(), accountAcknowledgement());
    assert.equal(result.confirmed, false);
    assert.equal(result.status, 'timeout');
    assert.equal(result.queued, attempt < 3);
    assert.equal(subject.requests.length, 2);
    assert.equal(subject.requests.at(-1)[1].signal.aborted, true);
    subject = await activationFixture({ timeoutMs: 15, userStore: subject.userStore });
  }
  assert.equal((await subject.client.recordWorkoutFinalization(finalizationPayload(), accountAcknowledgement())).status, 'retry_limit');
  assert.deepEqual(plain(await subject.client.flushWorkoutFinalizations(accountAcknowledgement())), []);
  assert.equal(subject.requests.length, 1);
  assert.equal(subject.client.scheduleWorkoutFinalization(finalizationPayload()), false);
});

test('Late finalize responses are fenced by owner, JWT and generation changes and are never cached for another account', async () => {
  for (const changed of [null, { owner: otherOwner, jwt: token(otherOwner), generation: 2 },
    { owner, jwt: token(), generation: 3 }, { owner, jwt: token(owner, { exp: 1 }), generation: 1 }]) {
    const subject = await activationFixture();
    subject.client.scheduleWorkoutFinalization(finalizationPayload());
    let finish;
    const body = new Promise(resolve => { finish = resolve; });
    subject.respond(async () => streamedResponse(body));
    const recording = subject.client.recordWorkoutFinalization(finalizationPayload(), accountAcknowledgement());
    await Promise.resolve();
    subject.setSession(changed);
    finish(finalizationReceipt());
    assert.equal((await recording).status, 'account_changed');
    assert.deepEqual(subject.captures, []);
    assert.equal((await subject.client.recordWorkoutFinalization(finalizationPayload(), accountAcknowledgement())).confirmed, false);
    assert.equal(subject.requests.length, 2);
  }
});

test('Withdrawal cancels an in-flight finalization and erases queued identifiers before a server response', async () => {
  const subject = await activationFixture({ timeoutMs: 20 });
  subject.client.scheduleWorkoutFinalization(finalizationPayload());
  subject.respond(async () => streamedResponse(new Promise(() => {})));
  const recording = subject.client.recordWorkoutFinalization(finalizationPayload(), accountAcknowledgement());
  subject.respond(response('declined'));
  const withdrawal = subject.client.setConsent(false);
  assert.equal(subject.userStore.values.size, 0);
  assert.equal((await recording).confirmed, false);
  assert.equal((await withdrawal).denialAcknowledgement, 'confirmed');
  assert.deepEqual(plain(await subject.client.flushWorkoutFinalizations(accountAcknowledgement())), []);
});

test('Malformed or negative finalize responses never claim confirmation or disclose unapproved server fields', async () => {
  const invalid = [finalizationReceipt({ request_id: owner }), finalizationReceipt({ confirmed: false }),
    finalizationReceipt({ recorded_at: 'not-a-date' }), finalizationReceipt({ health: 'private-server-value' }),
    finalizationReceipt({ recorded_at: '2999-01-01T00:00:00Z' }), { confirmed: true }];
  for (const value of invalid) {
    const subject = await activationFixture();
    subject.client.scheduleWorkoutFinalization(finalizationPayload());
    subject.respond(value);
    const result = await subject.client.recordWorkoutFinalization(finalizationPayload(), accountAcknowledgement());
    assert.equal(result.confirmed, false);
    assert.equal(result.status, 'invalid_response');
    assert.doesNotMatch(JSON.stringify(result), /private-server-value|health/);
  }
  for (const status of ['not_enrolled', 'consent_required', 'incomplete_history', 'disabled', 'not_ready']) {
    const subject = await activationFixture();
    subject.client.scheduleWorkoutFinalization(finalizationPayload());
    subject.respond(finalizationReceipt({ confirmed: false, status, recorded_at: null }));
    const result = await subject.client.recordWorkoutFinalization(finalizationPayload(), accountAcknowledgement());
    assert.equal(result.confirmed, false);
    assert.equal(result.queued, status === 'not_ready');
    const requests = subject.requests.length;
    if (status !== 'not_ready') {
      assert.deepEqual(plain(await subject.client.flushWorkoutFinalizations(accountAcknowledgement())), []);
      assert.equal(subject.requests.length, requests);
    }
  }
});

test('Concurrent duplicate finalizations share one request; unscheduled IDs and invalid dates cannot send', async () => {
  const subject = await activationFixture();
  assert.equal((await subject.client.recordWorkoutFinalization(finalizationPayload(), accountAcknowledgement())).status, 'not_scheduled');
  for (const changes of [{ requestId: 'not-a-uuid' }, { workoutDate: '2026-02-30' }, { workoutDate: '1900-01-01' },
    { workoutDate: '2999-01-01' }, { workoutDate: ['2026-09-05'] }]) {
    assert.equal(subject.client.scheduleWorkoutFinalization(finalizationPayload(changes)), false);
  }
  subject.client.scheduleWorkoutFinalization(finalizationPayload());
  let finish;
  const body = new Promise(resolve => { finish = resolve; });
  subject.respond(async () => streamedResponse(body));
  const first = subject.client.recordWorkoutFinalization(finalizationPayload(), accountAcknowledgement());
  const duplicate = subject.client.recordWorkoutFinalization(finalizationPayload(), accountAcknowledgement());
  assert.equal(first, duplicate);
  assert.equal(subject.requests.length, 2);
  finish(finalizationReceipt());
  assert.equal((await first).confirmed, true);
  assert.equal((await duplicate).confirmed, true);
});

test('Policy revisions discard queued work and account-scoped reloads cannot use a previous generation acknowledgement', async () => {
  const subject = await activationFixture();
  subject.client.scheduleWorkoutFinalization(finalizationPayload());
  const changed = await activationFixture({ userStore: subject.userStore });
  changed.respond(response('granted', { revision: owner }));
  await changed.client.load();
  assert.equal(changed.userStore.values.size, 0);
  assert.deepEqual(plain(await changed.client.flushWorkoutFinalizations(accountAcknowledgement())), []);
  assert.equal(changed.requests.length, 2);

  const scoped = await activationFixture();
  scoped.client.scheduleWorkoutFinalization(finalizationPayload());
  scoped.client.reset();
  scoped.setSession({ owner: otherOwner, jwt: token(otherOwner), generation: 2 });
  scoped.respond(response('granted'));
  await scoped.client.load();
  assert.deepEqual(plain(await scoped.client.flushWorkoutFinalizations(accountAcknowledgement({ owner: otherOwner, generation: 2 }))), []);
  scoped.client.reset();
  scoped.setSession({ owner, jwt: token(), generation: 3 });
  await scoped.client.load();
  assert.deepEqual(plain(await scoped.client.flushWorkoutFinalizations(accountAcknowledgement())), []);
  assert.equal(scoped.requests.length, 3);
  scoped.respond(finalizationReceipt());
  const result = await scoped.client.flushWorkoutFinalizations(accountAcknowledgement({ generation: 3 }));
  assert.equal(result[0].confirmed, true);
});

test('Queue capacity is bounded, corrupt persisted data fails closed, and storage failure never prevents local-only scheduling', async () => {
  const subject = await activationFixture();
  for (let index = 1; index <= 8; index++) {
    assert.equal(subject.client.scheduleWorkoutFinalization(finalizationPayload({
      requestId: '10000000-0000-4000-8000-' + String(index).padStart(12, '0') })), true);
  }
  assert.equal(subject.client.scheduleWorkoutFinalization(finalizationPayload()), false);
  assert.equal(subject.requests.length, 1);
  for (const raw of ['not json', JSON.stringify({ format: 1, version, revision: otherOwner, requests: [], health: 'private' }),
    JSON.stringify({ format: 1, version, revision: otherOwner, requests: [
      { requestId: otherOwner, attempts: -1, terminal: false }] })]) {
    const userStore = pendingStore();
    userStore.values.set('fm_activation_pending_' + owner, raw);
    const corrupted = await activationFixture({ userStore });
    assert.equal(userStore.values.size, 0);
    assert.deepEqual(plain(await corrupted.client.flushWorkoutFinalizations(accountAcknowledgement())), []);
    assert.equal(corrupted.requests.length, 1);
  }
  const unavailable = await activationFixture({ userStore: { getItem() { throw Error('quota'); },
    setItem() { throw Error('quota'); }, removeItem() { throw Error('quota'); } } });
  assert.equal(unavailable.client.scheduleWorkoutFinalization(finalizationPayload()), true);
  unavailable.respond(finalizationReceipt());
  assert.equal((await unavailable.client.recordWorkoutFinalization(finalizationPayload(), accountAcknowledgement())).confirmed, true);
});

test('Eight terminal successes or permanent denials yield one slot for a ninth new request after reload', async () => {
  const subject = await activationFixture();
  for (let index = 1; index <= 8; index++) {
    const payload = finalizationPayload({ requestId: pendingRequestId(index) });
    assert.equal(subject.client.scheduleWorkoutFinalization(payload), true);
    subject.respond(finalizationReceipt({ request_id: payload.requestId, confirmed: index === 1,
      status: index === 1 ? 'recorded' : 'already_recorded', recorded_at: index === 1 ? new Date().toISOString() : null }));
    const result = await subject.client.recordWorkoutFinalization(payload, accountAcknowledgement());
    assert.equal(result.queued, false);
  }
  assert.equal(storedRequests(subject).length, 8);
  assert.ok(storedRequests(subject).every(entry => entry.terminal && entry.attempts === 1));
  const reloaded = await activationFixture({ userStore: subject.userStore });
  assert.equal(reloaded.client.scheduleWorkoutFinalization(finalizationPayload({ requestId: pendingRequestId(1) })), false);
  assert.equal(reloaded.client.scheduleWorkoutFinalization(finalizationPayload()), true);
  assert.equal(reloaded.requests.length, 1);
  const saved = storedRequests(reloaded);
  assert.equal(saved.length, 8);
  assert.equal(saved.some(entry => entry.requestId === pendingRequestId(1)), false);
  assert.equal(saved.filter(entry => entry.terminal && entry.attempts === 1).length, 7);
  assert.deepEqual(saved.at(-1), { requestId: otherOwner, attempts: 0, terminal: false });
});

test('Eight orphan IDs are pruned only from an acknowledged cleared snapshot and are never rebuilt from restored logs', async () => {
  const subject = await activationFixture();
  for (let index = 1; index <= 8; index++) {
    assert.equal(subject.client.scheduleWorkoutFinalization(finalizationPayload({ requestId: pendingRequestId(index) })), true);
  }
  assert.equal(subject.client.scheduleWorkoutFinalization(finalizationPayload()), false);
  const cleared = accountAcknowledgement({ snapshot: { draftSession: null, restDays: [],
    workoutLog: [{ date: finalizationPayload().workoutDate, exercises: [{ sets: [{ reps: 5, weight: 0 }] }] }] } });
  assert.deepEqual(plain(await subject.client.flushWorkoutFinalizations(cleared)), []);
  assert.deepEqual(storedRequests(subject), []);
  assert.equal(subject.requests.length, 1);
  const reloaded = await activationFixture({ userStore: subject.userStore });
  const restored = accountAcknowledgement({ snapshot: { ...accountAcknowledgement().snapshot,
    workoutLog: Array.from({ length: 8 }, (_, index) => ({ date: finalizationPayload().workoutDate,
      finalizationRequestId: pendingRequestId(index + 1) })) } });
  assert.deepEqual(plain(await reloaded.client.flushWorkoutFinalizations(restored)), []);
  assert.deepEqual(storedRequests(reloaded), []);
  assert.equal(reloaded.requests.length, 1);
  assert.equal(reloaded.client.scheduleWorkoutFinalization(finalizationPayload()), true);
  reloaded.respond(finalizationReceipt());
  assert.equal((await reloaded.client.flushWorkoutFinalizations(accountAcknowledgement()))[0].confirmed, true);
  assert.doesNotMatch(JSON.stringify(subject.userStore.writes), /workoutDate|workoutLog|exercises|health|recorded_at|\d{4}-\d{2}-\d{2}/);
});

test('All eight live IDs refuse capacity until resolution; partial drafts and unconfirmed snapshots cannot prune them', async () => {
  const subject = await activationFixture();
  for (let index = 1; index <= 8; index++) {
    assert.equal(subject.client.scheduleWorkoutFinalization(finalizationPayload({ requestId: pendingRequestId(index) })), true);
  }
  const before = storedRequests(subject);
  const emptySnapshot = { draftSession: null, workoutLog: [], restDays: [] };
  for (const acknowledgement of [undefined, accountAcknowledgement({ acknowledged: false, snapshot: emptySnapshot }),
    accountAcknowledgement({ owner: otherOwner, snapshot: emptySnapshot }),
    accountAcknowledgement({ generation: 2, snapshot: emptySnapshot }),
    accountAcknowledgement({ snapshot: { ...emptySnapshot, draftSession: { session: { items: [] } } } }),
    accountAcknowledgement({ snapshot: { ...emptySnapshot, draftSession: undefined } }),
    accountAcknowledgement({ snapshot: { ...emptySnapshot, restDays: null } })]) {
    assert.deepEqual(plain(await subject.client.flushWorkoutFinalizations(acknowledgement)), []);
    assert.deepEqual(storedRequests(subject), before);
    assert.equal(subject.client.scheduleWorkoutFinalization(finalizationPayload()), false);
  }
  const matching = accountAcknowledgement({ snapshot: { ...emptySnapshot, restDays: [finalizationPayload().workoutDate],
    workoutLog: before.map(entry => ({ date: finalizationPayload().workoutDate, finalizationRequestId: entry.requestId })) } });
  assert.deepEqual(plain(await subject.client.flushWorkoutFinalizations(matching)), []);
  assert.deepEqual(storedRequests(subject), before);
  assert.equal(subject.requests.length, 1);
  subject.respond(finalizationReceipt({ request_id: pendingRequestId(4), confirmed: false,
    status: 'already_recorded', recorded_at: null }));
  assert.equal((await subject.client.recordWorkoutFinalization(finalizationPayload({ requestId: pendingRequestId(4) }),
    accountAcknowledgement())).status, 'already_recorded');
  assert.equal(subject.client.scheduleWorkoutFinalization(finalizationPayload()), true);
  assert.deepEqual(storedRequests(subject).filter(entry => entry.requestId !== otherOwner),
    before.filter(entry => entry.requestId !== pendingRequestId(4)));
});

test('Unknown server responses and not_ready exhaust three attempts without freeing or resetting eight live IDs', async () => {
  let subject = await activationFixture();
  for (let index = 1; index <= 8; index++) {
    subject.client.scheduleWorkoutFinalization(finalizationPayload({ requestId: pendingRequestId(index) }));
  }
  const acknowledgement = accountAcknowledgement({ snapshot: { ...accountAcknowledgement().snapshot,
    workoutLog: storedRequests(subject).map(entry => ({ date: finalizationPayload().workoutDate,
      finalizationRequestId: entry.requestId })) } });
  for (let attempt = 1; attempt <= 3; attempt++) {
    subject.respond(async (url, init) => Response.json(finalizationReceipt({
      request_id: JSON.parse(init.body).p_request_id, confirmed: false,
      status: attempt === 2 ? 'not_ready' : 'unknown_server_status', recorded_at: null })));
    const results = await subject.client.flushWorkoutFinalizations(acknowledgement);
    assert.equal(results.length, 8);
    assert.ok(results.every(result => result.status === (attempt === 2 ? 'not_ready' : 'invalid_response')
      && !result.confirmed && result.queued === (attempt < 3)));
    assert.equal(subject.requests.length, 9);
    assert.ok(storedRequests(subject).every(entry => entry.attempts === attempt && !entry.terminal));
    subject = await activationFixture({ userStore: subject.userStore });
    assert.equal(subject.client.scheduleWorkoutFinalization(finalizationPayload()), false);
  }
  assert.deepEqual(plain(await subject.client.flushWorkoutFinalizations(acknowledgement)), []);
  for (let index = 1; index <= 8; index++) {
    const payload = finalizationPayload({ requestId: pendingRequestId(index) });
    assert.equal(subject.client.scheduleWorkoutFinalization(payload), false);
    assert.equal((await subject.client.recordWorkoutFinalization(payload, acknowledgement)).status, 'retry_limit');
  }
  assert.ok(storedRequests(subject).every(entry => entry.attempts === 3 && !entry.terminal));
  assert.equal(subject.requests.length, 1);
});

test('An acknowledged missing marker cannot prune its still-in-flight request', async () => {
  const subject = await activationFixture();
  subject.client.scheduleWorkoutFinalization(finalizationPayload());
  let finish;
  const body = new Promise(resolve => { finish = resolve; });
  subject.respond(async () => streamedResponse(body));
  const recording = subject.client.recordWorkoutFinalization(finalizationPayload(), accountAcknowledgement());
  assert.deepEqual(plain(await subject.client.flushWorkoutFinalizations(accountAcknowledgement({
    snapshot: { draftSession: null, workoutLog: [], restDays: [] } }))), []);
  assert.deepEqual(storedRequests(subject), [{ requestId: otherOwner, attempts: 1, terminal: false }]);
  finish(finalizationReceipt());
  assert.equal((await recording).confirmed, true);
  assert.equal(storedRequests(subject)[0].terminal, true);
  assert.deepEqual(plain(await subject.client.flushWorkoutFinalizations(accountAcknowledgement({
    snapshot: { draftSession: null, workoutLog: [], restDays: [] } }))), []);
  assert.deepEqual(storedRequests(subject), []);
});

test('Reload intentionally rebinds an opaque pending ID from an acknowledged log without persisting its date', async () => {
  const now = '2026-09-05T19:00:00Z';
  const subject = await activationFixture({ now });
  const original = finalizationPayload({ workoutDate: '2026-09-05' });
  const changed = finalizationPayload({ workoutDate: '2026-09-06' });
  assert.equal(subject.client.scheduleWorkoutFinalization(original), true);
  assert.equal(subject.client.scheduleWorkoutFinalization(changed), false);
  assert.equal((await subject.client.recordWorkoutFinalization(changed, accountAcknowledgement())).status, 'request_conflict');
  const reloaded = await activationFixture({ now, userStore: subject.userStore });
  const acknowledgement = accountAcknowledgement({ snapshot: { draftSession: null, restDays: [],
    workoutLog: [{ date: changed.workoutDate, finalizationRequestId: changed.requestId }] } });
  reloaded.respond(finalizationReceipt({ recorded_at: now }));
  assert.equal((await reloaded.client.flushWorkoutFinalizations(acknowledgement))[0].confirmed, true);
  assert.equal(JSON.parse(reloaded.requests.at(-1)[1].body).p_workout_date, changed.workoutDate);
  assert.equal((await reloaded.client.recordWorkoutFinalization(original, acknowledgement)).status, 'request_conflict');
  assert.doesNotMatch(JSON.stringify(subject.userStore.writes), /workoutDate|recorded_at|\d{4}-\d{2}-\d{2}/);
});

test('Reset aborts finalization body consumption, preserves only opaque pending metadata, and never resumes without a new acknowledgement', async () => {
  const subject = await activationFixture();
  subject.client.scheduleWorkoutFinalization(finalizationPayload());
  subject.respond(async () => streamedResponse(new Promise(() => {})));
  const recording = subject.client.recordWorkoutFinalization(finalizationPayload(), accountAcknowledgement());
  subject.client.reset();
  assert.equal((await recording).status, 'account_changed');
  assert.equal(subject.requests.at(-1)[1].signal.aborted, true);
  assert.equal(subject.userStore.values.size, 1);
  subject.respond(response('granted'));
  await subject.client.load();
  assert.equal(subject.requests.length, 3);
  assert.equal((await subject.client.recordWorkoutFinalization(finalizationPayload())).status, 'account_not_acknowledged');
  assert.equal(subject.requests.length, 3);
});

test('The actual module defaults OFF and does not load consent, prompt, persist or bootstrap an SDK', async () => {
  const subject = fixture({ enabled: undefined });
  await subject.client.load();
  await subject.client.setConsent(true);
  assert.equal(subject.client.checkoutStarted(checkout()), false);
  assert.equal(subject.client.descriptor().phase, 'disabled');
  assert.equal(subject.requests.length, 0);
  assert.equal(subject.scripts.length, 0);
  assert.equal(subject.captures.length, 0);
});

test('Own lookup is explicit, token-bound and read-only; unset/declined/stale versions never auto-prompt or grant', async () => {
  const subject = fixture();
  assert.equal(subject.requests.length, 0);
  for (const state of ['unset', 'declined', 'stale_version']) {
    subject.respond(response(state));
    const result = await subject.client.load();
    assert.equal(result.consentState, state);
    assert.equal(result.granted, false);
    assert.equal(subject.client.checkoutStarted(checkout()), false);
  }
  for (const [url, init] of subject.requests) {
    assert.equal(url, supabaseUrl + '/rest/v1/rpc/get_billing_analytics_consent');
    assert.deepEqual(JSON.parse(init.body), {});
    assert.match(init.headers.Authorization, /^Bearer /);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
  }
  assert.equal(subject.scripts.length, 0);
});

test('Only an acknowledged current choice permits qualified enum-only checkout properties, preserving legacy Track', async () => {
  const subject = fixture();
  await subject.client.load();
  subject.respond(response('granted'));
  const saving = subject.client.setConsent(true);
  assert.equal(subject.client.checkoutStarted(checkout()), false);
  subject.context.Track.event('checkout_started', { tier: 'pro', rail: 'upi' });
  assert.equal(subject.captures.length, 0);
  assert.equal((await saving).granted, true);
  assert.deepEqual(JSON.parse(subject.requests.at(-1)[1].body), { p_granted: true, p_version: version });
  assert.equal(subject.client.checkoutStarted(checkout({ email: 'private', workout_contents: [1], uid: otherOwner })), true);
  assert.deepEqual(plain(subject.captures), [['checkout_started', { tier: 'pro', rail: 'upi' }]]);
  for (const change of [{ tier: 'free' }, { rail: 'wallet' }, { source: 'click' }, { owner: otherOwner }, { generation: 2 }]) {
    assert.equal(subject.client.checkoutStarted(checkout(change)), false);
  }
  assert.equal(subject.client.checkoutStarted(checkout({ rail: 'card', source: 'authenticated_hosted_checkout' })), true);
  subject.context.Track.event('app_opened');
  assert.equal(subject.captures.at(-1)[0], 'app_opened');
});

test('Policy version and permission text are supplied by configuration, not hardcoded approval or a fallback version', async () => {
  const subject = fixture();
  subject.respond(response('unset', { version: 'reviewed-v2' }));
  await subject.client.load();
  await subject.client.setConsent(true);
  assert.equal(subject.requests.length, 1);
  assert.equal(subject.client.descriptor().permission, null);
  const pending = fixture({ permissions: { [version]: { ...permission, reviewStatus: 'pending' } } });
  pending.respond(response('granted'));
  assert.equal((await pending.client.load()).granted, false);
  assert.equal(pending.client.checkoutStarted(checkout()), false);
  const approved = fixture({ permissions: { 'reviewed-v2': permission } });
  approved.respond(response('unset', { version: 'reviewed-v2' }));
  await approved.client.load();
  approved.respond(response('granted', { version: 'reviewed-v2', choice_version: 'reviewed-v2' }));
  assert.equal((await approved.client.setConsent(true)).granted, true);
  assert.equal(JSON.parse(approved.requests.at(-1)[1].body).p_version, 'reviewed-v2');
});

test('A withdrawal disables immediately and needs a real negative acknowledgement, not HTTP success alone', async () => {
  const subject = fixture();
  subject.respond(response('granted'));
  await subject.client.load();
  const denied = subject.client.setConsent(false);
  assert.equal(subject.client.descriptor().denialAcknowledgement, 'pending');
  assert.equal(subject.context.Track.measurementConsent(), false);
  assert.equal((await denied).denialAcknowledgement, 'unconfirmed');
  assert.equal(subject.client.descriptor().granted, false);
  await subject.client.load();
  assert.equal(subject.client.descriptor().granted, false);
  subject.respond(response('declined'));
  const confirmed = await subject.client.setConsent(false);
  assert.equal(confirmed.denialAcknowledgement, 'confirmed');
  assert.equal(confirmed.consentState, 'declined');
});

test('The deadline includes stalled response bodies and never replays a choice automatically', async () => {
  const subject = fixture({ timeoutMs: 15 });
  await subject.client.load();
  subject.respond(async () => streamedResponse(new Promise(() => {})));
  const result = await subject.client.setConsent(false);
  assert.equal(result.error, 'timeout');
  assert.equal(result.denialAcknowledgement, 'unconfirmed');
  assert.equal(subject.requests.at(-1)[1].signal.aborted, true);
  assert.equal(subject.requests.length, 2);
});

test('Streaming responses accept exactly 8 KiB and cancel larger bodies without trusting content length', async () => {
  const subject = fixture();
  subject.respond(async () => new Response(JSON.stringify(response('granted')).padEnd(8192, ' '),
    { headers: { 'Content-Length': '1' } }));
  assert.equal((await subject.client.load()).granted, true);
  let reads = 0, cancelled = false;
  subject.respond(async () => new Response(new ReadableStream({
    pull(controller) {
      reads++;
      controller.enqueue(new Uint8Array(reads === 1 ? 4096 : 4097).fill(32));
    },
    cancel() { cancelled = true; }
  }, { highWaterMark: 0 }), { headers: { 'Content-Length': '1' } }));
  const result = await subject.client.load();
  assert.equal(result.error, 'invalid_response');
  assert.equal(result.granted, false);
  assert.equal(reads, 2);
  assert.equal(cancelled, true);
  assert.deepEqual(subject.captures, []);
});

test('Malformed JSON, invalid UTF-8 and JSON-only transport doubles fail closed without returning body contents', async () => {
  for (const transport of [() => new Response('{"private":"unclosed'),
    () => new Response(new Uint8Array([255])), () => ({ ok: true, json: async () => response('granted') })]) {
    const subject = fixture();
    subject.respond(async () => transport());
    const result = await subject.client.load();
    assert.equal(result.error, 'invalid_response');
    assert.equal(result.granted, false);
    assert.doesNotMatch(JSON.stringify(result), /unclosed|UTF-8|SyntaxError/);
  }
});

test('Oversized finalization acknowledgements are not confirmed and keep the consumed attempt budget', async () => {
  const subject = await activationFixture();
  subject.client.scheduleWorkoutFinalization(finalizationPayload());
  subject.respond(async () => new Response(JSON.stringify(finalizationReceipt()).padEnd(8193, ' ')));
  const result = await subject.client.recordWorkoutFinalization(finalizationPayload(), accountAcknowledgement());
  assert.equal(result.status, 'invalid_response');
  assert.equal(result.confirmed, false);
  assert.equal(result.recorded_at, null);
  assert.equal(result.queued, true);
  assert.deepEqual(storedRequests(subject), [{ requestId: otherOwner, attempts: 1, terminal: false }]);
});

test('The deadline cancels a stalled stream reader even when the injected transport ignores abort', async () => {
  const subject = fixture({ timeoutMs: 15 });
  let cancelled = false;
  subject.respond(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  const result = await subject.client.load();
  assert.equal(result.error, 'timeout');
  assert.equal(result.granted, false);
  assert.equal(cancelled, true);
  assert.equal(subject.requests[0][1].signal.aborted, true);
});

test('Owner, JWT, expiry and generation changes fence late responses, including A to B to A', async () => {
  for (const changed of [
    { owner: otherOwner, jwt: token(otherOwner), generation: 2 },
    { owner, jwt: token(owner, { exp: 1 }), generation: 1 },
    { owner, jwt: token(), generation: 3 },
    { owner, jwt: token(otherOwner), generation: 1 },
    null
  ]) {
    const subject = fixture();
    let resolveBody;
    const body = new Promise(resolve => { resolveBody = resolve; });
    subject.respond(async () => streamedResponse(body));
    const loading = subject.client.load();
    await Promise.resolve();
    subject.setSession(changed);
    resolveBody(response('granted'));
    assert.equal((await loading).granted, false);
    assert.equal(subject.context.Track.measurementConsent(), false);
    assert.equal(subject.client.checkoutStarted(checkout()), false);
  }
});

test('Malformed server states, anonymous JWTs and cross-owner tokens fail closed without leaking raw error bodies', async () => {
  const subject = fixture();
  for (const invalid of [{ granted: true }, response('granted', { consent_state: 'unset' }),
    response('granted', { revision: null }), response('granted', { health: 'private' }),
    response('unset', { version: null }), response('unset', { version: undefined })]) {
    subject.respond(invalid);
    assert.equal((await subject.client.load()).error, 'invalid_response');
    assert.equal(subject.client.descriptor().granted, false);
  }
  for (const extra of [{ role: 'anon' }, { iss: 'https://wrong.invalid/auth/v1' }, { aud: 'service_role' }, { exp: 1 }]) {
    const blocked = fixture();
    blocked.setSession({ owner, jwt: token(owner, extra), generation: 1 });
    await blocked.client.load();
    assert.equal(blocked.requests.length, 0);
  }
});

test('An explicit decline during an in-flight grant blocks locally, then requires a separate acknowledged withdrawal', async () => {
  const subject = fixture();
  await subject.client.load();
  let resolveBody;
  const body = new Promise(resolve => { resolveBody = resolve; });
  subject.respond(async () => streamedResponse(body));
  const granting = subject.client.setConsent(true);
  await Promise.resolve();
  const declining = subject.client.setConsent(false);
  resolveBody(response('granted'));
  await Promise.all([granting, declining]);
  assert.equal(subject.requests.length, 2);
  assert.equal(subject.client.descriptor().granted, false);
  assert.equal(subject.client.descriptor().denialAcknowledgement, 'unconfirmed');
  subject.respond(response('declined'));
  assert.equal((await subject.client.setConsent(false)).denialAcknowledgement, 'confirmed');
});

test('Reset cancels pending body reads and drops only the new Track queue; pre-consent events are never backfilled', async () => {
  const subject = fixture();
  subject.context.Track._sdk = false;
  assert.equal(subject.client.checkoutStarted(checkout()), false);
  subject.respond(response('granted'));
  await subject.client.load();
  subject.client.checkoutStarted(checkout());
  subject.context.Track._q.push(['legacy_event', { kept: true }]);
  assert.equal(subject.context.Track._q.length, 2);
  subject.respond(async () => streamedResponse(new Promise(() => {})));
  const loading = subject.client.load();
  subject.client.reset();
  await loading;
  assert.deepEqual(plain(subject.context.Track._q), [['legacy_event', { kept: true }]]);
  assert.equal(subject.client.descriptor().granted, false);
});

test('The actual legacy SDK flush rechecks generation and JWT even without another module API call', async () => {
  for (const changed of [
    { owner, jwt: token(), generation: 3 },
    { owner, jwt: token(owner, { exp: 1 }), generation: 1 }
  ]) {
    const subject = fixture();
    subject.context.Track._sdk = false;
    subject.context.posthog.init = () => {};
    subject.context.Track.event('app_opened');
    subject.respond(response('granted'));
    await subject.client.load();
    subject.client.checkoutStarted(checkout());
    assert.equal(subject.context.Track._q.length, 2);
    subject.setSession(changed);
    subject.scripts[0].onload();
    assert.deepEqual(plain(subject.captures), [['app_opened', {}]]);
  }
});

test('One scoped Track controller is allowed; disposal restores the original gate and keeps legacy event methods intact', async () => {
  const subject = fixture();
  const originalEvent = subject.context.Track.event;
  assert.throws(() => subject.context.Measurement.create({ track: subject.context.Track }), /One controller/);
  subject.respond(response('granted'));
  await subject.client.load();
  subject.client.dispose();
  assert.equal(subject.client.descriptor().phase, 'disabled');
  assert.equal(subject.context.Track.event, originalEvent);
  assert.equal(subject.context.Track.measurementConsent(), false);
  assert.doesNotThrow(() => subject.context.Measurement.create({ track: subject.context.Track }));
});

test('Real settings checkbox, keyboard command, withdrawal retry and safe copy render on mobile and desktop without egress', async context => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const browserContext = await browser.newContext({ serviceWorkers: 'block' });
  const externalRequests = [], errors = [];
  await browserContext.route('**/*', route => { externalRequests.push(route.request().url()); return route.abort('blockedbyclient'); });
  const page = await browserContext.newPage();
  page.on('pageerror', problem => errors.push(problem.message));
  await page.setContent('<main id="settings"></main>');
  await page.evaluate(({ owner, jwt, initial }) => {
    window.runtime = { owner, jwt, generation: 1 };
    window.SupaAuth = { active: () => true, uid: () => window.runtime?.owner || '' };
    window.POSTHOG_KEY = 'fixture-public-key';
    window.posthog = { capture() {} };
    window.serverChoice = initial;
    window.commands = [];
    window.ignoreWithdrawal = false;
  }, { owner, jwt: token(), initial: response() });
  await page.addScriptTag({ content: trackSource });
  await page.addScriptTag({ content: source });
  await page.evaluate(({ permission, version, supabaseUrl, revision }) => {
    window.Track._sdk = true;
    window.client = Measurement.create({ enabled: true, supabaseUrl, publishableKey: 'fixture-public-key',
      getSession: () => window.runtime, track: window.Track,
      permissions: { [version]: { ...permission, label: 'Measurement <img id="injected" src="bad">',
        description: 'Fixture only <script>bad()</script>' } },
      fetch: async (url, init) => {
        const body = JSON.parse(init.body);
        window.commands.push({ url, body });
        if (Object.hasOwn(body, 'p_granted') && !(window.ignoreWithdrawal && body.p_granted === false)) {
          window.serverChoice = { granted: body.p_granted, consent_state: body.p_granted ? 'granted' : 'declined',
            version, choice_version: version, revision, captured_at: new Date().toISOString() };
        }
        return Response.json(window.serverChoice);
      }
    });
    window.unmount = window.client.mountSettings(document.getElementById('settings'));
  }, { permission, version, supabaseUrl, revision: otherOwner });
  const checkbox = page.getByRole('checkbox');
  assert.equal(await checkbox.isChecked(), false);
  assert.equal(await checkbox.isDisabled(), true);
  assert.equal(await page.evaluate(() => window.commands.length), 0);
  await page.evaluate(() => window.client.load());
  assert.equal(await checkbox.isDisabled(), false);
  assert.equal(await checkbox.evaluate(element => element.labels.length), 1);
  assert.ok(await checkbox.getAttribute('aria-describedby'));
  assert.equal(await page.locator('#injected').count(), 0);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('label').evaluate(element => element.getBoundingClientRect().height >= 44), true);
  }
  await checkbox.focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.client.descriptor().granted);
  assert.equal(await checkbox.isChecked(), true);
  assert.equal(await checkbox.getAttribute('checked'), null);
  await page.evaluate(() => { window.ignoreWithdrawal = true; });
  await checkbox.uncheck();
  await page.waitForFunction(() => window.client.descriptor().denialAcknowledgement === 'unconfirmed');
  assert.equal(await checkbox.isChecked(), false);
  assert.match(await page.getByRole('status').textContent(), /Server withdrawal is not confirmed/);
  assert.equal(await page.evaluate(() => window.commands.length), 3);
  await page.evaluate(() => { window.ignoreWithdrawal = false; });
  await page.getByRole('button', { name: 'Retry withdrawal' }).click();
  await page.waitForFunction(() => window.client.descriptor().denialAcknowledgement === 'confirmed');
  assert.match(await page.getByRole('status').textContent(), /Choice saved: off/);
  await page.evaluate(() => window.unmount());
  assert.equal(await checkbox.count(), 0);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(errors, []);
});