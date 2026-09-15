'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const owner = '12345678-1234-4234-8234-123456789abc';
const otherOwner = '87654321-4321-4321-8321-cba987654321';
const version = 'billing-analytics-v1';
const sql = name => fs.readFileSync(path.join(__dirname, '../supabase', name), 'utf8');

async function database(context, { outbox = true } = {}) {
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
    CREATE TABLE public.entitlements (
      uid text PRIMARY KEY, tier text NOT NULL, status text NOT NULL,
      provider text, subscription_id text, current_period_end timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.billing_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), uid text NOT NULL,
      type text NOT NULL, raw jsonb NOT NULL, created_at timestamptz DEFAULT now()
    );
  `);
  await subject.exec(sql('billing-events.sql'));
  if (outbox) await subject.exec(sql('analytics-outbox.sql'));
  return subject;
}

async function enable(subject, mode = 'live') {
  await subject.exec(`UPDATE public.analytics_delivery_config
    SET collection_enabled = true, delivery_enabled = true WHERE singleton`);
  await subject.query(`INSERT INTO public.analytics_billing_sources
    (provider, account_id, billing_mode, verified_at, enabled)
    VALUES ('razorpay', 'acc_fixture', $1, clock_timestamp(), true)`, [mode]);
}

async function consent(subject, granted = true, uid = owner, policy = version) {
  await subject.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [uid]);
  await subject.exec('SET ROLE authenticated');
  try {
    return (await subject.query('SELECT public.set_billing_analytics_consent($1, $2) AS result',
      [granted, policy])).rows[0].result;
  } finally { await subject.exec('RESET ROLE'); }
}

function event(overrides = {}) {
  const created = Math.floor(Date.now() / 1000) + 2;
  const input = {
    provider: 'razorpay', eventId: 'evt_fixture', uid: owner,
    eventType: 'payment.captured', occurredAt: new Date(created * 1000).toISOString(),
    reference: 'order_fixture', tier: 'pro', status: 'active', periodEnd: null,
    raw: { account_id: 'acc_fixture', event: 'payment.captured', created_at: created,
      payload: { payment: { entity: { id: 'pay_fixture', order_id: 'order_fixture',
        amount: 100, currency: 'INR', status: 'captured', captured: true, method: 'upi',
        amount_refunded: 0, created_at: created,
        email: 'must-not-export@example.test', notes: { name: 'Private', health: 'private' }
      } } } },
    ...overrides
  };
  return input;
}

async function apply(subject, input = event()) {
  return (await subject.query(`SELECT public.apply_billing_event(
    $1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9::timestamptz, $10::jsonb
  ) AS result`, [input.provider, input.eventId, input.uid, input.eventType,
    input.occurredAt, input.reference, input.tier, input.status, input.periodEnd,
    JSON.stringify(input.raw)])).rows[0].result;
}

async function counts(subject) {
  return (await subject.query(`SELECT
    (SELECT count(*)::integer FROM public.entitlements) AS entitlements,
    (SELECT count(*)::integer FROM public.billing_events) AS audits,
    (SELECT count(*)::integer FROM public.billing_event_receipts) AS receipts,
    (SELECT count(*)::integer FROM public.analytics_outbox) AS outbox
  `)).rows[0];
}

test('The dependent migration preserves billing and defaults collection and delivery OFF', async context => {
  const subject = await database(context, { outbox: false });
  await apply(subject);
  const before = (await subject.query('SELECT * FROM public.entitlements')).rows;
  await subject.exec(sql('analytics-outbox.sql'));
  assert.deepEqual((await subject.query('SELECT * FROM public.entitlements')).rows, before);
  assert.deepEqual((await subject.query(`SELECT collection_enabled, delivery_enabled
    FROM public.analytics_delivery_config`)).rows, [{ collection_enabled: false, delivery_enabled: false }]);
  await apply(subject, event({ eventId: 'evt_after_migration' }));
  assert.deepEqual(await counts(subject), { entitlements: 1, audits: 2, receipts: 2, outbox: 0 });
});

test('A consented verified capture atomically inserts a minimal receipt-linked event without changing INR1/null expiry', async context => {
  const subject = await database(context);
  await enable(subject);
  const choice = await consent(subject);
  const input = event();
  assert.deepEqual(await apply(subject, input), { applied: true, duplicate: false });
  assert.deepEqual(await counts(subject), { entitlements: 1, audits: 1, receipts: 1, outbox: 1 });
  const stored = (await subject.query('SELECT * FROM public.analytics_outbox')).rows[0];
  assert.match(stored.event_id, /^[a-f0-9-]{36}$/);
  assert.equal(stored.receipt_event_id, input.eventId);
  assert.equal(stored.consent_revision, choice.revision);
  assert.equal(stored.event_name, 'purchase_confirmed');
  assert.equal(stored.amount_minor, 100);
  assert.equal(stored.currency, 'INR');
  assert.equal(stored.price_class, 'other_or_unknown');
  assert.equal(stored.charge_kind, 'unknown');
  assert.equal(stored.billing_mode, 'live');
  assert.equal(stored.state, 'pending');
  assert.equal(/must-not-export|Private|health|pay_fixture|order_fixture/.test(JSON.stringify(stored)), false);
  assert.equal((await subject.query('SELECT current_period_end FROM public.entitlements')).rows[0].current_period_end, null);
});

test('An outbox insert failure rolls back entitlement, audit and receipt; exact retry succeeds once', async context => {
  const subject = await database(context);
  await enable(subject);
  await consent(subject);
  await subject.exec(`ALTER TABLE public.analytics_outbox ADD CONSTRAINT reject_fixture
    CHECK (amount_minor <> 100) NOT VALID`);
  const input = event();
  await assert.rejects(apply(subject, input), { code: '23514' });
  assert.deepEqual(await counts(subject), { entitlements: 0, audits: 0, receipts: 0, outbox: 0 });
  await subject.exec('ALTER TABLE public.analytics_outbox DROP CONSTRAINT reject_fixture');
  await apply(subject, input);
  assert.deepEqual(await apply(subject, input), { applied: false, duplicate: true });
  assert.deepEqual(await counts(subject), { entitlements: 1, audits: 1, receipts: 1, outbox: 1 });
});

test('Canonical charge dedupe survives webhook aliases and retries with a stable event UUID', async context => {
  const subject = await database(context);
  await enable(subject);
  await consent(subject);
  const input = event();
  await apply(subject, input);
  const original = (await subject.query('SELECT event_id FROM public.analytics_outbox')).rows[0].event_id;
  const alias = structuredClone(input);
  alias.eventId = 'evt_alias'; alias.eventType = 'order.paid'; alias.raw.event = 'order.paid';
  assert.deepEqual(await apply(subject, alias), { applied: true, duplicate: false });
  assert.deepEqual(await apply(subject, alias), { applied: false, duplicate: true });
  assert.deepEqual((await subject.query('SELECT event_id FROM public.analytics_outbox')).rows, [{ event_id: original }]);
  assert.deepEqual(await counts(subject), { entitlements: 1, audits: 2, receipts: 2, outbox: 1 });
});

test('Missing consent, unverified/test sources, trials and access-only events cannot synthesize purchases', async context => {
  for (const scenario of ['no-consent', 'unverified', 'test', 'trial', 'subscription', 'lemonsqueezy']) {
    const subject = await database(context);
    await enable(subject, scenario === 'test' ? 'test' : 'live');
    if (scenario !== 'no-consent') await consent(subject);
    if (scenario === 'unverified') await subject.exec('UPDATE public.analytics_billing_sources SET enabled = false');
    const input = event();
    if (scenario === 'trial') input.status = 'trialing';
    if (scenario === 'subscription') input.eventType = 'subscription.activated';
    if (scenario === 'lemonsqueezy') { input.provider = 'lemonsqueezy'; input.eventType = 'subscription_created'; }
    assert.equal((await apply(subject, input)).applied, true, scenario);
    assert.equal((await counts(subject)).outbox, 0, scenario);
  }
});

test('Server consent is owner-bound, versioned, captured server-side and revocation suppresses queued work permanently', async context => {
  const subject = await database(context);
  await enable(subject);
  await assert.rejects(consent(subject, true, '', version), { code: '42501' });
  await assert.rejects(consent(subject, true, owner, 'old-policy'), { code: '22023' });
  const before = Date.now();
  const choice = await consent(subject);
  assert.equal(choice.granted, true);
  assert.equal(choice.version, version);
  assert.ok(Date.parse(choice.captured_at) >= before - 1000);
  await apply(subject);
  await consent(subject, false, otherOwner);
  assert.equal((await subject.query('SELECT state FROM public.analytics_outbox')).rows[0].state, 'pending');
  await consent(subject, false, owner, 'old-policy');
  assert.equal((await subject.query('SELECT state FROM public.analytics_outbox')).rows[0].state, 'suppressed');
  const renewed = await consent(subject);
  assert.notEqual(renewed.revision, choice.revision);
  assert.equal((await subject.query('SELECT state FROM public.analytics_outbox')).rows[0].state, 'suppressed');
});

async function claim(subject, limit = 10) {
  return (await subject.query('SELECT public.claim_analytics_events($1) AS result', [limit])).rows[0].result;
}

async function authorize(subject, lease) {
  return (await subject.query('SELECT public.authorize_analytics_delivery($1, $2) AS result',
    [lease.event_id, lease.lease_token])).rows[0].result;
}

async function finish(subject, lease, outcome = 'delivered', error = null) {
  return (await subject.query('SELECT public.finish_analytics_delivery($1, $2, $3, $4) AS result',
    [lease.event_id, lease.lease_token, outcome, error])).rows[0].result;
}

function refundFor(input, { id = 'rfnd_fixture', amount = 100, offset = 1 } = {}) {
  const created = input.raw.created_at + offset;
  return event({ eventId: `evt_${id}`, occurredAt: new Date(created * 1000).toISOString(),
    eventType: 'refund.processed', status: 'canceled', tier: 'free', reference: input.reference,
    raw: { account_id: input.raw.account_id, event: 'refund.processed', created_at: created,
      payload: { refund: { entity: { id, payment_id: input.raw.payload.payment.entity.id,
        status: 'processed', amount, currency: 'INR', created_at: created } } } }
  });
}

test('Captures derive the actual allowlisted payment rail and refunds inherit it, including unknown methods', async context => {
  for (const method of ['upi', 'card', 'netbanking', 'wallet', undefined, null, 'cash', 'UPI', ['card']]) {
    const subject = await database(context);
    await enable(subject); await consent(subject);
    const input = event();
    input.raw.payload.payment.entity.method = method;
    const expected = ['upi', 'card', 'netbanking', 'wallet'].includes(method) ? method : 'unknown';
    assert.equal((await apply(subject, input)).applied, true);
    const purchaseLease = (await claim(subject))[0];
    assert.equal((await authorize(subject, purchaseLease)).properties.rail, expected);
    await finish(subject, purchaseLease);
    assert.equal((await apply(subject, refundFor(input))).applied, true);
    const refundLease = (await claim(subject))[0];
    assert.equal((await authorize(subject, refundLease)).properties.rail, expected);
    assert.deepEqual((await subject.query('SELECT rail FROM public.analytics_outbox')).rows,
      [{ rail: expected }, { rail: expected }]);
    await assert.rejects(subject.exec("UPDATE public.analytics_outbox SET rail = 'cash'"), { code: '23514' });
  }
});

test('A valid lease authorizes exactly one attempt and exposes only the measurement allowlist', async context => {
  const subject = await database(context);
  await enable(subject); await consent(subject); await apply(subject);
  const leases = await claim(subject, 1);
  assert.equal(leases.length, 1);
  assert.deepEqual(Object.keys(leases[0]).sort(), ['event_id', 'lease_token']);
  assert.deepEqual(await claim(subject), []);
  assert.equal(await authorize(subject, { ...leases[0], lease_token: otherOwner }), null);
  const delivery = await authorize(subject, leases[0]);
  assert.deepEqual(Object.keys(delivery).sort(), ['event_id', 'event_name', 'occurred_at', 'properties']);
  assert.deepEqual(delivery.properties, { tier: 'pro', rail: 'upi', currency: 'INR', amount_minor: 100,
    price_class: 'other_or_unknown', billing_mode: 'live', charge_kind: 'unknown' });
  assert.equal(await authorize(subject, leases[0]), null);
  assert.deepEqual(await finish(subject, { ...leases[0], lease_token: otherOwner }), { accepted: false });
  assert.deepEqual(await finish(subject, leases[0]), { accepted: true, state: 'delivered' });
  assert.deepEqual(await claim(subject), []);
  assert.deepEqual(await finish(subject, leases[0]), { accepted: false });
});

test('Expired in-flight leases are reclaimed with a new token, not a new event identity', async context => {
  const subject = await database(context);
  await enable(subject); await consent(subject); await apply(subject);
  const first = (await claim(subject))[0];
  await authorize(subject, first);
  await subject.exec("UPDATE public.analytics_outbox SET lease_until = clock_timestamp() - interval '1 second'");
  const next = (await claim(subject))[0];
  assert.equal(next.event_id, first.event_id);
  assert.notEqual(next.lease_token, first.lease_token);
  assert.equal(await authorize(subject, first), null);
  assert.deepEqual(await finish(subject, first), { accepted: false });
  assert.ok(await authorize(subject, next));
  assert.deepEqual(await finish(subject, next, 'retry', 'network'), { accepted: true, state: 'retry' });
  assert.deepEqual(await claim(subject), []);
  const stored = (await subject.query('SELECT attempts, available_at FROM public.analytics_outbox')).rows[0];
  assert.equal(stored.attempts, 2);
  assert.ok(stored.available_at.getTime() >= Date.now() + 55000);
});

test('Retries and crash-only reclaims are capped, and batches are strictly bounded', async context => {
  const subject = await database(context);
  await enable(subject); await consent(subject); await apply(subject);
  for (const limit of [0, -1, 21, null]) await assert.rejects(claim(subject, limit), { code: '22023' });
  for (let attempt = 1; attempt <= 6; attempt++) {
    await subject.exec('UPDATE public.analytics_outbox SET available_at = clock_timestamp()');
    const lease = (await claim(subject))[0];
    assert.ok(lease);
    await authorize(subject, lease);
    assert.deepEqual(await finish(subject, lease, 'retry', 'timeout'), {
      accepted: true, state: attempt === 6 ? 'dead' : 'retry'
    });
  }
  assert.deepEqual(await claim(subject), []);
  const input = event({ eventId: 'evt_crashes', reference: 'order_crashes' });
  input.raw.payload.payment.entity.id = 'pay_crashes';
  input.raw.payload.payment.entity.order_id = input.reference;
  await apply(subject, input);
  for (let attempt = 0; attempt < 6; attempt++) {
    assert.equal((await claim(subject)).length, 1);
    await subject.exec("UPDATE public.analytics_outbox SET lease_until = clock_timestamp() - interval '1 second' WHERE state = 'leased'");
  }
  assert.deepEqual(await claim(subject), []);
  assert.equal((await subject.query("SELECT count(*)::integer AS total FROM public.analytics_outbox WHERE state = 'dead'")).rows[0].total, 2);
});

test('Revoke fences both leased and already-authorized events and regrant never resurrects either', async context => {
  const subject = await database(context);
  await enable(subject);
  for (const sending of [false, true]) {
    const choice = await consent(subject);
    assert.equal((await consent(subject)).revision, choice.revision, 'Repeated opt-in is idempotent');
    const input = event({ eventId: `evt_revoke_${sending}`, reference: `order_revoke${sending}` });
    input.raw.payload.payment.entity.id = `pay_revoke${sending}`;
    input.raw.payload.payment.entity.order_id = input.reference;
    await apply(subject, input);
    const lease = (await claim(subject))[0];
    if (sending) await authorize(subject, lease);
    await consent(subject, false);
    assert.equal(await authorize(subject, lease), null);
    assert.deepEqual(await finish(subject, lease), sending ? { accepted: true, state: 'suppressed' } : { accepted: false });
    await consent(subject);
    assert.deepEqual(await claim(subject), []);
  }
});

test('Revoked sending rows retain ambiguous authorization and accept only their original late acknowledgement without billing changes', async context => {
  for (const outcome of ['delivered', 'retry']) {
    const subject = await database(context);
    await enable(subject); await consent(subject); await apply(subject);
    const audits = (await subject.query('SELECT * FROM public.billing_events')).rows;
    const receipts = (await subject.query('SELECT * FROM public.billing_event_receipts')).rows;
    const entitlements = (await subject.query('SELECT * FROM public.entitlements')).rows;
    const lease = (await claim(subject))[0];
    await authorize(subject, lease);
    await consent(subject, false);
    const revoked = (await subject.query('SELECT * FROM public.analytics_outbox')).rows[0];
    assert.equal(revoked.state, 'suppressed');
    assert.equal(revoked.last_error, 'in_flight_ineligible');
    assert.ok(revoked.delivery_authorized_at);
    assert.equal(revoked.provider_acknowledged_at, null);
    assert.equal(revoked.delivered_at, null);
    assert.equal(revoked.lease_token, lease.lease_token);
    await consent(subject);
    await subject.exec("UPDATE public.analytics_outbox SET lease_until = clock_timestamp() - interval '1 second'");
    assert.deepEqual(await claim(subject), []);
    assert.equal(await authorize(subject, lease), null);
    assert.deepEqual(await finish(subject, { ...lease, lease_token: otherOwner }), { accepted: false });
    assert.deepEqual(await finish(subject, lease, outcome, outcome === 'retry' ? 'network' : null),
      { accepted: true, state: 'suppressed' });
    const acknowledged = (await subject.query('SELECT * FROM public.analytics_outbox')).rows[0];
    assert.equal(Boolean(acknowledged.provider_acknowledged_at), outcome === 'delivered');
    assert.equal(acknowledged.delivered_at, null);
    assert.equal(acknowledged.last_error, 'in_flight_ineligible');
    assert.equal(acknowledged.lease_token, null);
    assert.deepEqual(await finish(subject, lease), { accepted: false });
    assert.deepEqual((await subject.query('SELECT * FROM public.billing_events')).rows, audits);
    assert.deepEqual((await subject.query('SELECT * FROM public.billing_event_receipts')).rows, receipts);
    assert.deepEqual((await subject.query('SELECT * FROM public.entitlements')).rows, entitlements);
  }
});

test('Delivery rechecks source attestation and consent policy after claiming', async context => {
  for (const change of [
    "UPDATE public.analytics_delivery_config SET consent_version = 'billing-analytics-v2'",
    'UPDATE public.analytics_billing_sources SET enabled = false'
  ]) {
    const subject = await database(context);
    await enable(subject); await consent(subject); await apply(subject);
    const lease = (await claim(subject))[0];
    await subject.exec(change);
    assert.equal(await authorize(subject, lease), null);
    assert.equal((await subject.query('SELECT state FROM public.analytics_outbox')).rows[0].state, 'suppressed');
  }
});

test('Collection off/on preserves admitted backlog and billing audits without backfilling paused captures', async context => {
  const subject = await database(context);
  await enable(subject); await consent(subject); await apply(subject);
  const original = (await subject.query('SELECT event_id FROM public.analytics_outbox')).rows[0].event_id;
  await subject.exec('UPDATE public.analytics_delivery_config SET collection_enabled = false');
  assert.deepEqual(await claim(subject), []);
  const paused = event({ eventId: 'evt_paused' });
  paused.raw.payload.payment.entity.id = 'pay_paused';
  assert.equal((await apply(subject, paused)).applied, true);
  assert.deepEqual(await counts(subject), { entitlements: 1, audits: 2, receipts: 2, outbox: 1 });
  await subject.exec('UPDATE public.analytics_delivery_config SET collection_enabled = true');
  assert.equal((await subject.query(`SELECT queued.created_at < settings.enabled_at AS older
    FROM public.analytics_outbox AS queued CROSS JOIN public.analytics_delivery_config AS settings`)).rows[0].older, true);
  const resumed = (await claim(subject))[0];
  assert.equal(resumed.event_id, original);
  assert.ok(await authorize(subject, resumed));
  assert.deepEqual(await finish(subject, resumed), { accepted: true, state: 'delivered' });
  paused.eventId = 'evt_paused_alias'; paused.eventType = 'order.paid'; paused.raw.event = 'order.paid';
  await apply(subject, paused);
  assert.deepEqual(await counts(subject), { entitlements: 1, audits: 3, receipts: 3, outbox: 1 });
});

test('Operational pauses release unsent leases without consuming attempts and retain acknowledgements already in flight', async context => {
  for (const gate of ['collection_enabled', 'delivery_enabled']) {
    const subject = await database(context);
    await enable(subject); await consent(subject); await apply(subject);
    const lease = (await claim(subject))[0];
    await subject.exec(`UPDATE public.analytics_delivery_config SET ${gate} = false`);
    assert.equal(await authorize(subject, lease), null);
    assert.deepEqual((await subject.query(`SELECT state, attempts, lease_token, last_error
      FROM public.analytics_outbox`)).rows, [{ state: 'pending', attempts: 0, lease_token: null, last_error: null }]);
    await subject.exec(`UPDATE public.analytics_delivery_config SET ${gate} = true`);
    const resumed = (await claim(subject))[0];
    assert.equal(resumed.event_id, lease.event_id);
    assert.ok(await authorize(subject, resumed));
    await subject.exec(`UPDATE public.analytics_delivery_config SET ${gate} = false`);
    assert.deepEqual(await finish(subject, resumed), { accepted: true, state: 'delivered' });
    assert.ok((await subject.query('SELECT delivered_at FROM public.analytics_outbox')).rows[0].delivered_at);
    assert.deepEqual(await claim(subject), []);
  }
});

test('Pausing after claim releases unsent leases before they can exhaust the delivery attempt budget', async context => {
  for (const gate of ['collection_enabled', 'delivery_enabled']) {
    const subject = await database(context);
    await enable(subject); await consent(subject); await apply(subject);
    await subject.exec("UPDATE public.analytics_outbox SET state = 'retry', attempts = 5");
    const interrupted = (await claim(subject))[0];
    await subject.exec(`UPDATE public.analytics_delivery_config SET ${gate} = false`);
    assert.deepEqual((await subject.query('SELECT state, attempts, lease_token FROM public.analytics_outbox')).rows,
      [{ state: 'retry', attempts: 5, lease_token: null }]);
    await subject.exec(`UPDATE public.analytics_delivery_config SET ${gate} = true`);
    assert.equal(await authorize(subject, interrupted), null);
    const resumed = (await claim(subject))[0];
    assert.equal(resumed.event_id, interrupted.event_id);
    assert.notEqual(resumed.lease_token, interrupted.lease_token);
    assert.ok(await authorize(subject, resumed));
    assert.deepEqual(await finish(subject, resumed), { accepted: true, state: 'delivered' });
  }
});

test('An in-flight transient failure during collection pause keeps its retry and immutable identity', async context => {
  const subject = await database(context);
  await enable(subject); await consent(subject); await apply(subject);
  const lease = (await claim(subject))[0];
  const payload = await authorize(subject, lease);
  await subject.exec('UPDATE public.analytics_delivery_config SET collection_enabled = false');
  assert.deepEqual(await finish(subject, lease, 'retry', 'network'), { accepted: true, state: 'retry' });
  assert.deepEqual(await claim(subject), []);
  await subject.exec(`UPDATE public.analytics_delivery_config SET collection_enabled = true;
    UPDATE public.analytics_outbox SET available_at = clock_timestamp()`);
  const resumed = (await claim(subject))[0];
  assert.deepEqual(await authorize(subject, resumed), payload);
  assert.deepEqual(await finish(subject, resumed), { accepted: true, state: 'delivered' });
});

test('Processed refunds retain the original tier/class, dedupe individually and cannot exceed captured value', async context => {
  const subject = await database(context);
  await enable(subject); await consent(subject);
  const purchase = event({ tier: 'elite' });
  await apply(subject, purchase);
  const first = refundFor(purchase, { id: 'rfnd_first', amount: 40 });
  await apply(subject, first); await apply(subject, first);
  await apply(subject, refundFor(purchase, { id: 'rfnd_second', amount: 60, offset: 2 }));
  await apply(subject, refundFor(purchase, { id: 'rfnd_excess', amount: 1, offset: 3 }));
  const rows = (await subject.query(`SELECT event_name, tier, amount_minor, price_class, purchase_event_id
    FROM public.analytics_outbox ORDER BY occurred_at`)).rows;
  assert.deepEqual(rows.map(row => [row.event_name, row.amount_minor]),
    [['purchase_confirmed', 100], ['refund_confirmed', 40], ['refund_confirmed', 60]]);
  assert.ok(rows.every(row => row.tier === 'elite' && row.price_class === 'other_or_unknown'));
  assert.ok(rows[1].purchase_event_id && rows[1].purchase_event_id === rows[2].purchase_event_id);
  context.diagnostic('The normalizer handles accepted partial receipts; the existing webhook still ignores partial refunds before the RPC.');
});

test('Refunds after regrant or policy renewal use new consent independently of a delivered purchase', async context => {
  for (const policy of [version, 'billing-analytics-v2']) {
    const subject = await database(context);
    await enable(subject);
    const originalChoice = await consent(subject);
    const purchase = event({ tier: 'elite' });
    purchase.raw.payload.payment.entity.method = 'card';
    await apply(subject, purchase);
    const purchaseLease = (await claim(subject))[0];
    await authorize(subject, purchaseLease); await finish(subject, purchaseLease);
    const original = (await subject.query('SELECT * FROM public.analytics_outbox')).rows[0];
    await consent(subject, false);
    if (policy !== version) await subject.query('UPDATE public.analytics_delivery_config SET consent_version = $1', [policy]);
    const renewed = await consent(subject, true, owner, policy);
    assert.notEqual(renewed.revision, originalChoice.revision);
    const refund = refundFor(purchase);
    assert.equal((await apply(subject, refund)).applied, true);
    const rows = (await subject.query('SELECT * FROM public.analytics_outbox ORDER BY occurred_at')).rows;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], original, 'The delivered purchase is neither rewritten nor sent again');
    assert.equal(rows[1].purchase_event_id, original.event_id);
    assert.equal(rows[1].consent_revision, renewed.revision);
    assert.equal(rows[1].consent_version, policy);
    assert.equal(rows[1].rail, 'card');
    const leases = await claim(subject);
    assert.deepEqual(leases.map(lease => lease.event_id), [rows[1].event_id]);
    assert.equal((await authorize(subject, leases[0])).event_name, 'refund_confirmed');
    assert.deepEqual(await finish(subject, leases[0]), { accepted: true, state: 'delivered' });
    assert.deepEqual(await counts(subject), { entitlements: 1, audits: 2, receipts: 2, outbox: 2 });
  }
});

test('Freshly consented refunds never resurrect a suppressed purchase or old suppressed refunds', async context => {
  const subject = await database(context);
  await enable(subject); await consent(subject);
  const purchase = event();
  await apply(subject, purchase);
  const oldRefund = refundFor(purchase, { id: 'rfnd_old', amount: 40 });
  await apply(subject, oldRefund);
  await consent(subject, false);
  const suppressed = (await subject.query('SELECT * FROM public.analytics_outbox ORDER BY occurred_at')).rows;
  assert.ok(suppressed.every(row => row.state === 'suppressed'));
  const renewed = await consent(subject);
  oldRefund.eventId = 'evt_old_alias';
  await apply(subject, oldRefund);
  const refund = refundFor(purchase, { id: 'rfnd_new', amount: 60, offset: 2 });
  assert.equal((await apply(subject, refund)).applied, true);
  const rows = (await subject.query('SELECT * FROM public.analytics_outbox ORDER BY occurred_at')).rows;
  assert.deepEqual(rows.slice(0, 2), suppressed);
  assert.equal(rows.length, 3);
  assert.equal(rows[2].consent_revision, renewed.revision);
  assert.equal(rows[2].purchase_event_id, rows[0].event_id);
  assert.equal(rows[2].amount_minor, 60);
  assert.deepEqual((await claim(subject)).map(lease => lease.event_id), [rows[2].event_id]);
  assert.deepEqual(await counts(subject), { entitlements: 1, audits: 4, receipts: 4, outbox: 3 });
});

test('Out-of-order and stale-reference receipts never enqueue, including a refund after a newer order', async context => {
  const subject = await database(context);
  await enable(subject); await consent(subject);
  const earlier = event();
  await apply(subject, earlier);
  const newer = structuredClone(earlier);
  newer.eventId = 'evt_newer'; newer.reference = 'order_newer'; newer.tier = 'elite';
  newer.raw.payload.payment.entity.id = 'pay_newer'; newer.raw.payload.payment.entity.order_id = newer.reference;
  newer.raw.created_at += 2; newer.occurredAt = new Date(newer.raw.created_at * 1000).toISOString();
  await apply(subject, newer);
  assert.equal((await apply(subject, refundFor(earlier, { offset: 4 }))).reason, 'reference_mismatch');
  const stale = structuredClone(earlier); stale.eventId = 'evt_stale'; stale.raw.payload.payment.entity.id = 'pay_stale';
  assert.equal((await apply(subject, stale)).reason, 'out_of_order');
  assert.equal((await counts(subject)).outbox, 2);
  assert.equal((await subject.query('SELECT tier FROM public.entitlements')).rows[0].tier, 'elite');
});

test('Cancellation wins at a tied timestamp and pending/unlinked refund data is not monetary evidence', async context => {
  const subject = await database(context);
  await enable(subject); await consent(subject);
  const purchase = event();
  const cancel = refundFor(purchase, { offset: 0 });
  assert.equal((await apply(subject, cancel)).applied, true);
  assert.equal((await apply(subject, purchase)).reason, 'cancellation_wins');
  assert.equal((await counts(subject)).outbox, 0);
  const pending = refundFor(purchase, { id: 'rfnd_pending', offset: 2 });
  pending.raw.payload.refund.entity.status = 'pending';
  await apply(subject, pending);
  assert.equal((await counts(subject)).outbox, 0);
});

test('Historical aliases and pre-consent occurrences are not backfilled after an opt-in', async context => {
  const subject = await database(context);
  await enable(subject);
  const beforeConsent = event();
  await apply(subject, beforeConsent);
  await consent(subject);
  const alias = structuredClone(beforeConsent);
  alias.eventId = 'evt_later_alias'; alias.eventType = 'order.paid'; alias.raw.event = 'order.paid';
  alias.raw.created_at += 1; alias.occurredAt = new Date(alias.raw.created_at * 1000).toISOString();
  await apply(subject, alias);
  assert.equal((await counts(subject)).outbox, 0);
  const old = event({ eventId: 'evt_historical', uid: otherOwner });
  await consent(subject, true, otherOwner);
  old.raw.created_at -= 600; old.raw.payload.payment.entity.created_at -= 600;
  old.raw.payload.payment.entity.id = 'pay_historical';
  old.occurredAt = new Date(old.raw.created_at * 1000).toISOString();
  await apply(subject, old);
  assert.equal((await counts(subject)).outbox, 0);
});

test('Raw amounts, metadata, missing mode proof and price-looking values are handled conservatively', async context => {
  const subject = await database(context);
  await enable(subject); await consent(subject);
  const patches = [
    payment => { payment.amount = 0; }, payment => { payment.amount = '100'; },
    payment => { payment.amount = 1.5; }, payment => { payment.amount = 9007199254740992; },
    payment => { payment.currency = 'USD'; }, payment => { payment.status = 'authorized'; },
    payment => { payment.amount_refunded = 100; }, payment => { payment.test_mode = true; },
    payment => { delete payment.created_at; }, payment => { payment.order_id = 'order_wrong'; }
  ];
  for (const [index, patch] of patches.entries()) {
    const input = event({ eventId: `evt_invalid${index}` });
    input.raw.payload.payment.entity.id = `pay_invalid${index}`;
    patch(input.raw.payload.payment.entity);
    await apply(subject, input);
  }
  for (const [index, rawPatch] of [{ test_mode: true }, { livemode: false }, { account_id: 'acc_other' }].entries()) {
    const input = event({ eventId: `evt_badsource${index}` });
    input.raw.payload.payment.entity.id = `pay_badsource${index}`; Object.assign(input.raw, rawPatch);
    await apply(subject, input);
  }
  assert.equal((await counts(subject)).outbox, 0);
  const standardLooking = event({ eventId: 'evt_standard' });
  standardLooking.raw.payload.payment.entity.id = 'pay_standard';
  standardLooking.raw.payload.payment.entity.amount = 29900;
  standardLooking.raw.payload.payment.entity.notes = { price_class: 'standard', internal_qa: false };
  await apply(subject, standardLooking);
  assert.equal((await subject.query('SELECT price_class FROM public.analytics_outbox')).rows[0].price_class, 'other_or_unknown');
});

test('Missing payment entities and non-INR captures or refunds remain audited without synthesizing analytics', async context => {
  for (const scenario of ['missing-payment', 'foreign-capture', 'foreign-refund']) {
    const subject = await database(context);
    await enable(subject); await consent(subject);
    let input = event();
    if (scenario === 'missing-payment') {
      input.eventType = 'order.paid'; input.raw.event = 'order.paid';
      input.raw.payload = { order: { entity: { id: input.reference, status: 'paid', amount: 100, currency: 'INR' } } };
    } else if (scenario === 'foreign-refund') {
      await apply(subject, input);
      input = refundFor(input); input.raw.payload.refund.entity.currency = 'USD';
    } else input.raw.payload.payment.entity.currency = 'USD';
    assert.equal((await apply(subject, input)).applied, true);
    assert.deepEqual(await counts(subject), { entitlements: 1, audits: scenario === 'foreign-refund' ? 2 : 1,
      receipts: scenario === 'foreign-refund' ? 2 : 1, outbox: scenario === 'foreign-refund' ? 1 : 0 });
  }
});

test('Sub-second RPC times use the signed provider second for analytics and preserve exact billing timestamps', async context => {
  for (const milliseconds of [375, 999, 1000]) {
    const subject = await database(context);
    await enable(subject); await consent(subject);
    const input = event();
    input.occurredAt = new Date(input.raw.created_at * 1000 + milliseconds).toISOString();
    assert.equal((await apply(subject, input)).applied, true);
    const rows = (await subject.query('SELECT occurred_at FROM public.analytics_outbox')).rows;
    assert.equal(rows.length, milliseconds < 1000 ? 1 : 0);
    assert.equal((await subject.query('SELECT occurred_at FROM public.billing_event_receipts')).rows[0].occurred_at.toISOString(),
      input.occurredAt);
    if (rows.length) {
      assert.equal(rows[0].occurred_at.getTime(), input.raw.created_at * 1000);
      const refund = refundFor(input);
      refund.occurredAt = new Date(refund.raw.created_at * 1000 + milliseconds).toISOString();
      assert.equal((await apply(subject, refund)).applied, true);
      assert.equal((await subject.query("SELECT occurred_at FROM public.analytics_outbox WHERE event_name = 'refund_confirmed'"))
        .rows[0].occurred_at.getTime(), refund.raw.created_at * 1000);
    }
  }
});

test('Sub-second RPC precision cannot move a signed pre-consent refund past the consent boundary', async context => {
  const subject = await database(context);
  await enable(subject); await consent(subject);
  const purchase = event();
  await apply(subject, purchase);
  const refund = refundFor(purchase);
  await subject.query('UPDATE public.billing_analytics_consent SET captured_at = to_timestamp($1)', [refund.raw.created_at + 0.5]);
  refund.occurredAt = new Date(refund.raw.created_at * 1000 + 750).toISOString();
  assert.equal((await apply(subject, refund)).applied, true);
  assert.deepEqual(await counts(subject), { entitlements: 1, audits: 2, receipts: 2, outbox: 1 });
});

test('An enclosing transaction rolls back all four effects with no phantom delivery record', async context => {
  const subject = await database(context);
  await enable(subject); await consent(subject);
  await assert.rejects(subject.transaction(async transaction => {
    await apply(transaction);
    assert.equal((await counts(transaction)).outbox, 1);
    throw new Error('fixture transaction rollback');
  }), /fixture transaction rollback/);
  assert.deepEqual(await counts(subject), { entitlements: 0, audits: 0, receipts: 0, outbox: 0 });
});

test('Client roles cannot read/write private analytics tables or dispatch; service role cannot bypass the wrapper', async context => {
  const subject = await database(context);
  const tables = ['analytics_delivery_config', 'analytics_billing_sources', 'billing_analytics_consent', 'analytics_outbox'];
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await subject.exec(`SET ROLE ${role}`);
    for (const table of tables) {
      await assert.rejects(subject.query(`SELECT * FROM public.${table}`), { code: '42501' });
      await assert.rejects(subject.query(`DELETE FROM public.${table}`), { code: '42501' });
    }
    if (role !== 'service_role') await assert.rejects(claim(subject), { code: '42501' });
    else assert.deepEqual(await claim(subject), []);
    await assert.rejects(subject.query(`SELECT public._apply_billing_event_without_analytics(
      'razorpay', 'evt_bypass', $1, 'payment.captured', now(), 'order_fixture', 'pro', 'active', NULL, '{}')`, [owner]), { code: '42501' });
    await subject.exec('RESET ROLE');
  }
  await subject.exec('SET ROLE anon');
  await assert.rejects(subject.query('SELECT public.set_billing_analytics_consent(true, $1)', [version]), { code: '42501' });
  await subject.exec('RESET ROLE');
  const definitions = (await subject.query(`SELECT proname, prosecdef, proconfig FROM pg_proc
    JOIN pg_namespace ON pg_namespace.oid = pronamespace WHERE nspname = 'public'
      AND proname IN ('apply_billing_event', 'claim_analytics_events', 'authorize_analytics_delivery',
        'finish_analytics_delivery', 'set_billing_analytics_consent')`)).rows;
  assert.equal(definitions.length, 5);
  assert.ok(definitions.every(definition => definition.prosecdef && definition.proconfig.includes('search_path=""')));
});

test('The outbox migration fails atomically and explicitly when the billing prerequisite is missing', async context => {
  const subject = new PGlite();
  context.after(() => subject.close());
  await assert.rejects(subject.exec(sql('analytics-outbox.sql')), /billing-events.sql before analytics-outbox.sql/);
  await subject.exec('ROLLBACK');
  assert.equal((await subject.query("SELECT to_regclass('public.analytics_outbox') AS relation")).rows[0].relation, null);
});

test('Migration locks billing tables in writer order before index builds and requests a transactional schema reload', async context => {
  const subject = await database(context, { outbox: false });
  const migration = sql('analytics-outbox.sql');
  const lockStatement = 'LOCK TABLE public.billing_event_receipts, public.entitlements, public.billing_events\n  IN SHARE ROW EXCLUSIVE MODE;';
  assert.ok(migration.includes(lockStatement));
  assert.ok(migration.indexOf(lockStatement) < migration.indexOf('CREATE INDEX analytics_prior_captures'));
  assert.ok(migration.indexOf(lockStatement) < migration.indexOf('CREATE INDEX analytics_prior_refunds'));
  assert.match(migration, /NOTIFY pgrst, 'reload schema';\s+COMMIT;\s*$/);
  assert.doesNotMatch(migration, /\bDROP\s+(?:FUNCTION|TABLE)|\bCASCADE\b/i);
  await subject.exec(migration.slice(0, migration.lastIndexOf('COMMIT;')));
  assert.deepEqual((await subject.query(`SELECT relation.relname FROM pg_catalog.pg_locks AS lock
    JOIN pg_catalog.pg_class AS relation ON relation.oid = lock.relation
    WHERE lock.mode = 'ShareRowExclusiveLock' AND lock.granted
      AND relation.relname IN ('billing_event_receipts', 'entitlements', 'billing_events')
    ORDER BY relation.relname`)).rows.map(row => row.relname), ['billing_event_receipts', 'billing_events', 'entitlements']);
  assert.equal((await subject.query('SHOW lock_timeout')).rows[0].lock_timeout, '5s');
  await subject.exec('COMMIT');
  const signatures = (await subject.query(`SELECT proname, pronargs, pronargdefaults, proargnames
    FROM pg_catalog.pg_proc AS routine JOIN pg_catalog.pg_namespace AS schema ON schema.oid = routine.pronamespace
    WHERE schema.nspname = 'public' AND proname IN ('apply_billing_event', 'finish_analytics_delivery')
    ORDER BY proname`)).rows;
  assert.equal(signatures.length, 2);
  assert.equal(signatures[0].pronargs, 10);
  assert.equal(signatures[1].pronargs, 4);
  assert.equal(signatures[1].pronargdefaults, 1);
  assert.deepEqual(signatures[1].proargnames, ['p_event_id', 'p_lease_token', 'p_outcome', 'p_error']);
  assert.deepEqual((await subject.query('SELECT collection_enabled, delivery_enabled FROM public.analytics_delivery_config')).rows,
    [{ collection_enabled: false, delivery_enabled: false }]);
});

test('An existing acknowledgement signature blocks migration without dropping the function or changing billing records', async context => {
  for (const signature of ['uuid, uuid, text', 'uuid, uuid, text, text', 'uuid, uuid, text, text, boolean']) {
    const subject = await database(context, { outbox: false });
    await apply(subject);
    await subject.exec(`CREATE FUNCTION public.finish_analytics_delivery(${signature}) RETURNS jsonb
      LANGUAGE sql AS 'SELECT ''{"legacy":true}''::jsonb'`);
    const before = (await subject.query(`SELECT oid, pg_get_functiondef(oid) AS definition FROM pg_catalog.pg_proc
      WHERE proname IN ('apply_billing_event', 'finish_analytics_delivery') ORDER BY proname`)).rows;
    const audits = (await subject.query('SELECT * FROM public.billing_events')).rows;
    await assert.rejects(subject.exec(sql('analytics-outbox.sql')), /separately reviewed forward migration/);
    await subject.exec('ROLLBACK');
    assert.deepEqual((await subject.query(`SELECT oid, pg_get_functiondef(oid) AS definition FROM pg_catalog.pg_proc
      WHERE proname IN ('apply_billing_event', 'finish_analytics_delivery') ORDER BY proname`)).rows, before);
    assert.deepEqual((await subject.query('SELECT * FROM public.billing_events')).rows, audits);
    assert.equal((await subject.query("SELECT to_regclass('public.analytics_outbox') AS relation")).rows[0].relation, null);
  }
});

test('Reapplying this fresh-install migration fails closed without changing an existing queue or its approvals', async context => {
  const subject = await database(context);
  await enable(subject); await consent(subject); await apply(subject);
  const queued = (await subject.query('SELECT * FROM public.analytics_outbox')).rows;
  const approvals = (await subject.query('SELECT * FROM public.analytics_delivery_config')).rows;
  await assert.rejects(subject.exec(sql('analytics-outbox.sql')), /separately reviewed forward migration/);
  await subject.exec('ROLLBACK');
  assert.deepEqual((await subject.query('SELECT * FROM public.analytics_outbox')).rows, queued);
  assert.deepEqual((await subject.query('SELECT * FROM public.analytics_delivery_config')).rows, approvals);
  assert.equal((await claim(subject)).length, 1);
});

test('The rollout record keeps all activation approvals OFF and names the unimplemented integration boundaries', () => {
  const rollout = JSON.parse(sql('analytics-rollout.json'));
  for (const gate of ['production_authorized', 'external_calls_authorized', 'collection_enabled', 'delivery_enabled', 'deployed']) {
    assert.equal(rollout[gate], false, gate);
  }
  assert.deepEqual(rollout.existing_sources_changed, []);
  assert.deepEqual(rollout.pricing_and_access.approved_amount_minor_inr, { pro: 100, elite: 100 });
  assert.equal(rollout.pricing_and_access.ordinary_launch_expiry, null);
  assert.ok(rollout.migration.order.indexOf('supabase/billing-events.sql')
    < rollout.migration.order.indexOf('supabase/analytics-outbox.sql'));
  assert.deepEqual(rollout.source_provenance.rail_allowlist, ['upi', 'card', 'netbanking', 'wallet', 'unknown']);
  assert.deepEqual(rollout.dispatcher.payload_property_allowlist,
    ['tier', 'rail', 'currency', 'amount_minor', 'price_class', 'billing_mode', 'charge_kind']);
  assert.deepEqual(rollout.migration.write_lock_order,
    ['public.billing_event_receipts', 'public.entitlements', 'public.billing_events']);
  assert.equal(rollout.migration.schema_reload_statement, "NOTIFY pgrst, 'reload schema';");
  assert.match(rollout.migration.rollback_policy, /backlog survives/);
  assert.match(rollout.dispatcher.deployment_coupling, /exactly seven/);
  assert.equal(rollout.provider_acknowledgement.activation_blocking, true);
  assert.equal(rollout.provider_acknowledgement.externally_verified, false);
  assert.deepEqual(rollout.provider_acknowledgement.accepted_response_examples, [1, { status: 1 }]);
  assert.ok(rollout.provider_acknowledgement.official_docs.includes('https://posthog.com/docs/api/capture'));
  assert.match(rollout.provider_acknowledgement.documentation_evidence, /do not specify/);
  assert.equal(rollout.retention.policy_approved, false);
  assert.equal(rollout.retention.purge_installed, false);
  assert.match(rollout.retention.parent_purchase_dependency, /original analytics_outbox purchase row/);
  assert.match(rollout.retention.refund_sum_dependency, /suppressed\/dead/);
  assert.equal(rollout.verification.production_delivery_verified, false);
  assert.equal(rollout.verification.actual_customers_or_revenue, null);
  assert.match(rollout.consent.client_integration, /Not implemented/);
  assert.match(rollout.review.independent_review, /pending/);
  for (const filename of rollout.new_files) assert.ok(fs.existsSync(path.join(__dirname, '..', filename)), filename);
});