'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/billing-events.sql'), 'utf8');
const rpc = `SELECT public.apply_billing_event(
  $1::text, $2::text, $3::text, $4::text, $5::timestamptz,
  $6::text, $7::text, $8::text, $9::timestamptz, $10::jsonb
) AS result`;
const occurredAt = '2026-01-02T12:00:00.000Z';
const earlierAt = '2026-01-01T12:00:00.000Z';
const laterAt = '2026-01-03T12:00:00.000Z';

async function database(context, { applyMigration = true, auditId = 'uuid' } = {}) {
  const subject = new PGlite();
  context.after(() => subject.close());
  const auditIdDefinition = auditId === 'uuid'
    ? 'uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid()'
    : 'bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY';
  await subject.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    CREATE TABLE public.entitlements (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      uid text NOT NULL UNIQUE,
      tier text NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'elite')),
      status text NOT NULL DEFAULT 'inactive' CHECK (status IN ('active', 'trialing', 'canceled', 'inactive')),
      provider text,
      subscription_id text,
      current_period_end timestamptz,
      updated_at timestamptz DEFAULT pg_catalog.now()
    );
    CREATE TABLE public.billing_events (
      id ${auditIdDefinition},
      uid text NOT NULL,
      type text NOT NULL,
      raw jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
    );
    ALTER TABLE public.entitlements ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.billing_events ENABLE ROW LEVEL SECURITY;
    GRANT SELECT ON public.entitlements TO authenticated;
  `);
  if (applyMigration) await subject.exec(migration);
  return subject;
}

function event(overrides = {}) {
  return {
    provider: 'razorpay', eventId: 'evt_fixture', uid: 'member_fixture',
    eventType: 'payment.captured', occurredAt, reference: 'order_fixture',
    tier: 'pro', status: 'active', periodEnd: null, raw: { fixture: true },
    ...overrides
  };
}

function parameters(input) {
  return [input.provider, input.eventId, input.uid, input.eventType, input.occurredAt,
    input.reference, input.tier, input.status, input.periodEnd,
    input.raw === undefined ? null : JSON.stringify(input.raw)];
}

async function apply(subject, input = event()) {
  const { rows } = await subject.query(rpc, parameters(input));
  return rows[0].result;
}

async function entitlement(subject, uid = 'member_fixture') {
  const { rows } = await subject.query('SELECT * FROM public.entitlements WHERE uid = $1', [uid]);
  return rows[0];
}

async function counts(subject) {
  const { rows } = await subject.query(`SELECT
    (SELECT count(*)::integer FROM public.entitlements) AS entitlements,
    (SELECT count(*)::integer FROM public.billing_events) AS audits,
    (SELECT count(*)::integer FROM public.billing_event_receipts) AS receipts
  `);
  return rows[0];
}

test('The actual SQL atomically writes a paid entitlement, audit, and private receipt', async context => {
  const subject = await database(context);
  const input = event();
  assert.deepEqual(await apply(subject, input), { applied: true, duplicate: false });
  const stored = await entitlement(subject);
  assert.equal(stored.tier, 'pro');
  assert.equal(stored.status, 'active');
  assert.equal(stored.provider, 'razorpay');
  assert.equal(stored.subscription_id, input.reference);
  assert.equal(stored.current_period_end, null);
  assert.equal(stored.updated_at.toISOString(), occurredAt);
  assert.deepEqual(await counts(subject), { entitlements: 1, audits: 1, receipts: 1 });
  const { rows: audits } = await subject.query('SELECT uid, type, raw FROM public.billing_events');
  assert.deepEqual(audits, [{ uid: input.uid, type: input.eventType, raw: input.raw }]);
  const { rows: receipts } = await subject.query('SELECT applied, reason FROM public.billing_event_receipts');
  assert.deepEqual(receipts, [{ applied: true, reason: null }]);
});

test('Identical provider event replay has no further writes', async context => {
  const subject = await database(context);
  await apply(subject);
  const before = await entitlement(subject);
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.deepEqual(await apply(subject), { applied: false, duplicate: true });
  }
  assert.deepEqual(await entitlement(subject), before);
  assert.deepEqual(await counts(subject), { entitlements: 1, audits: 1, receipts: 1 });
});

test('Future event timestamps cannot prevent subsequent valid revocations', async context => {
  const subject = await database(context);
  await assert.rejects(apply(subject, event({ occurredAt: '9999-01-01T00:00:00Z', periodEnd: '9999-02-01T00:00:00Z' })), { code: '22023' });
  assert.deepEqual(await counts(subject), { entitlements: 0, audits: 0, receipts: 0 });
  await apply(subject);
  await apply(subject, event({ eventId: 'valid_cancel', occurredAt: laterAt, status: 'canceled' }));
  assert.equal((await entitlement(subject)).tier, 'free');
});

test('An audit failure rolls back an entitlement update and receipt; the exact retry succeeds once', async context => {
  const subject = await database(context);
  await apply(subject, event({ eventId: 'evt_previous', occurredAt: earlierAt }));
  const before = await entitlement(subject);
  await subject.exec(`ALTER TABLE public.billing_events
    ADD CONSTRAINT reject_fixture_audit CHECK (type <> 'payment.captured') NOT VALID`);
  const input = event({ tier: 'elite' });
  await assert.rejects(apply(subject, input), { code: '23514' });
  assert.deepEqual(await entitlement(subject), before);
  assert.deepEqual(await counts(subject), { entitlements: 1, audits: 1, receipts: 1 });
  await subject.exec('ALTER TABLE public.billing_events DROP CONSTRAINT reject_fixture_audit');
  assert.deepEqual(await apply(subject, input), { applied: true, duplicate: false });
  assert.equal((await entitlement(subject)).tier, 'elite');
  assert.deepEqual(await apply(subject, input), { applied: false, duplicate: true });
  assert.deepEqual(await counts(subject), { entitlements: 1, audits: 2, receipts: 2 });
});

test('Older paid and revocation events are audited once without overwriting newer state', async context => {
  const subject = await database(context);
  for (const provider of ['razorpay', 'lemonsqueezy']) {
    const input = event({ provider, uid: `member_${provider}`, occurredAt: laterAt, tier: 'elite' });
    await apply(subject, input);
    const before = await entitlement(subject, input.uid);
    for (const status of ['active', 'trialing', 'canceled', 'inactive']) {
      const older = { ...input, eventId: `evt_older_${status}`, occurredAt, status, tier: 'pro' };
      assert.deepEqual(await apply(subject, older), {
        applied: false, duplicate: false, reason: 'out_of_order'
      });
      assert.deepEqual(await apply(subject, older), { applied: false, duplicate: true });
      assert.deepEqual(await entitlement(subject, input.uid), before);
    }
  }
  assert.deepEqual(await counts(subject), { entitlements: 2, audits: 10, receipts: 10 });
});

test('Same-time cancellation and refund beat active and trialing in both arrival orders', async context => {
  const subject = await database(context);
  for (const provider of ['razorpay', 'lemonsqueezy']) {
    for (const paidStatus of ['active', 'trialing']) {
      for (const revokedStatus of ['canceled', 'inactive']) {
        for (const revokeFirst of [true, false]) {
          const uid = `tie_${provider}_${paidStatus}_${revokedStatus}_${revokeFirst}`;
          const paid = event({ provider, uid, eventId: `${uid}_paid`, status: paidStatus, tier: 'elite' });
          const revoked = event({ provider, uid, eventId: `${uid}_revoked`, status: revokedStatus,
            eventType: provider === 'razorpay' ? 'refund.processed' : 'order_refunded' });
          const arrivals = revokeFirst ? [revoked, paid] : [paid, revoked];
          assert.deepEqual(await apply(subject, arrivals[0]), { applied: true, duplicate: false });
          assert.deepEqual(await apply(subject, arrivals[1]), revokeFirst
            ? { applied: false, duplicate: false, reason: 'cancellation_wins' }
            : { applied: true, duplicate: false });
          const stored = await entitlement(subject, uid);
          assert.equal(stored.tier, 'free');
          assert.equal(stored.status, revokedStatus);
          assert.equal(stored.subscription_id, paid.reference);
          assert.equal(stored.updated_at.toISOString(), occurredAt);
        }
      }
    }
  }
  assert.deepEqual(await counts(subject), { entitlements: 16, audits: 32, receipts: 32 });
});

test('A later refund of an old reference cannot revoke a newer purchase or advance its cursor', async context => {
  const subject = await database(context);
  await apply(subject, event({ eventId: 'evt_old_order', reference: 'order_old', occurredAt: earlierAt }));
  await apply(subject, event({ eventId: 'evt_new_order', reference: 'order_new', tier: 'elite' }));
  const before = await entitlement(subject);
  const refund = event({ eventId: 'evt_old_refund', reference: 'order_old', occurredAt: laterAt,
    eventType: 'refund.processed', status: 'inactive' });
  assert.deepEqual(await apply(subject, refund), {
    applied: false, duplicate: false, reason: 'reference_mismatch'
  });
  assert.deepEqual(await apply(subject, refund), { applied: false, duplicate: true });
  assert.deepEqual(await entitlement(subject), before);
  assert.deepEqual(await apply(subject, event({ eventId: 'evt_new_update', reference: 'order_new',
    occurredAt: '2026-01-02T18:00:00.000Z', tier: 'elite' })), { applied: true, duplicate: false });
  assert.deepEqual(await apply(subject, event({ eventId: 'evt_old_reactivation', reference: 'order_old',
    occurredAt: laterAt })), { applied: false, duplicate: false, reason: 'cancellation_wins' });
  assert.equal((await entitlement(subject)).subscription_id, 'order_new');
  assert.deepEqual(await counts(subject), { entitlements: 1, audits: 5, receipts: 5 });
});

test('Same-time cancellation priority is scoped to the reference, not a different new purchase', async context => {
  const subject = await database(context);
  for (const cancelFirst of [true, false]) {
    const uid = `reference_tie_${cancelFirst}`;
    await apply(subject, event({ uid, eventId: `${uid}_previous`, reference: 'order_previous', occurredAt: earlierAt }));
    const cancel = event({ uid, eventId: `${uid}_cancel`, reference: 'order_previous', status: 'canceled',
      eventType: 'subscription.cancelled' });
    const purchase = event({ uid, eventId: `${uid}_new`, reference: 'order_new', tier: 'elite' });
    for (const input of cancelFirst ? [cancel, purchase] : [purchase, cancel]) await apply(subject, input);
    const stored = await entitlement(subject, uid);
    assert.equal(stored.tier, 'elite');
    assert.equal(stored.status, 'active');
    assert.equal(stored.subscription_id, 'order_new');
  }
});

test('A newer purchase survives an older-reference refund in every delivery order and replay', async context => {
  const subject = await database(context);
  const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (const provider of ['razorpay', 'lemonsqueezy']) {
    for (const order of permutations) {
      const uid = `refund_order_${provider}_${order.join('')}`;
      const events = [
        event({ uid, provider, eventId: `${uid}_old`, reference: 'old_purchase', occurredAt: earlierAt }),
        event({ uid, provider, eventId: `${uid}_new`, reference: 'new_purchase', occurredAt, tier: 'elite' }),
        event({ uid, provider, eventId: `${uid}_refund`, reference: 'old_purchase', occurredAt: laterAt,
          eventType: provider === 'razorpay' ? 'refund.processed' : 'order_refunded', status: 'inactive' })
      ];
      for (const index of order) await apply(subject, events[index]);
      const current = await entitlement(subject, uid);
      assert.equal(current.tier, 'elite', `${provider} delivery ${order}`);
      assert.equal(current.status, 'active');
      assert.equal(current.subscription_id, 'new_purchase');
      for (const input of events) assert.deepEqual(await apply(subject, input), { applied: false, duplicate: true });
      assert.deepEqual(await entitlement(subject, uid), current);
    }
  }
  assert.deepEqual(await counts(subject), { entitlements: 12, audits: 36, receipts: 36 });
});

test('Revoking a pre-ledger purchase retains its paid cursor against delayed older purchases', async context => {
  const subject = await database(context);
  for (const provider of ['razorpay', 'lemonsqueezy']) {
    for (const olderProvider of ['razorpay', 'lemonsqueezy']) {
      for (const refundFirst of [true, false]) {
        const uid = `legacy_cursor_${provider}_${olderProvider}_${refundFirst}`;
        await subject.query(`INSERT INTO public.entitlements
          (uid, tier, status, provider, subscription_id, updated_at)
          VALUES ($1, 'elite', 'active', $2, 'new_purchase', $3)`, [uid, provider, occurredAt]);
        const refund = event({ uid, provider, eventId: `${uid}_refund`, reference: 'new_purchase',
          occurredAt: laterAt, eventType: provider === 'razorpay' ? 'refund.processed' : 'order_refunded', status: 'inactive' });
        const older = event({ uid, provider: olderProvider, eventId: `${uid}_older`, reference: 'old_purchase', occurredAt: earlierAt });
        for (const input of refundFirst ? [refund, older] : [older, refund]) await apply(subject, input);
        const current = await entitlement(subject, uid);
        assert.equal(current.status, 'inactive', uid);
        assert.equal(current.tier, 'free', uid);
        assert.equal(current.subscription_id, 'new_purchase');
        for (const input of [refund, older]) assert.deepEqual(await apply(subject, input), { applied: false, duplicate: true });
        assert.deepEqual(await entitlement(subject, uid), current);
      }
    }
  }
});

test('Provider namespaces separate event identifiers and prevent cross-provider revocation', async context => {
  const subject = await database(context);
  await apply(subject, event({ eventId: 'shared_event_id', reference: 'shared_reference' }));
  const newer = event({ provider: 'lemonsqueezy', eventId: 'shared_event_id', reference: 'shared_reference',
    eventType: 'subscription_updated', occurredAt: laterAt, tier: 'elite' });
  assert.deepEqual(await apply(subject, newer), { applied: true, duplicate: false });
  const before = await entitlement(subject);
  const refund = event({ eventId: 'evt_other_rail_refund', reference: 'shared_reference', occurredAt: laterAt,
    eventType: 'refund.processed', status: 'inactive' });
  assert.deepEqual(await apply(subject, refund), {
    applied: false, duplicate: false, reason: 'reference_mismatch'
  });
  assert.deepEqual(await entitlement(subject), before);
  assert.deepEqual(await counts(subject), { entitlements: 1, audits: 3, receipts: 3 });
});

test('The additive migration preserves legacy rows; only their matching reference may cancel them', async context => {
  const subject = await database(context, { applyMigration: false });
  await subject.query(`INSERT INTO public.entitlements
    (uid, tier, status, provider, subscription_id, current_period_end, updated_at)
    VALUES ('legacy_email_slug', 'elite', 'active', 'razorpay', 'order_legacy', NULL, $1),
      ('untouched_member', 'pro', 'active', 'lemonsqueezy', 'sub_untouched', NULL, $1)`, [earlierAt]);
  await subject.exec(`INSERT INTO public.billing_events (uid, type, raw)
    VALUES ('legacy_email_slug', 'payment.captured', '{"legacy":true}')`);
  const before = await entitlement(subject, 'legacy_email_slug');
  const untouched = await entitlement(subject, 'untouched_member');
  const beforeAudit = (await subject.query('SELECT * FROM public.billing_events')).rows;
  await subject.exec(migration);
  assert.deepEqual(await entitlement(subject, 'legacy_email_slug'), before);
  assert.deepEqual((await subject.query('SELECT * FROM public.billing_events')).rows, beforeAudit);
  assert.deepEqual(await counts(subject), { entitlements: 2, audits: 1, receipts: 0 });
  const wrongReference = event({ uid: 'legacy_email_slug', eventId: 'evt_legacy_stale_ref',
    reference: 'order_older', occurredAt: laterAt, eventType: 'refund.processed', status: 'inactive' });
  assert.deepEqual(await apply(subject, wrongReference), {
    applied: false, duplicate: false, reason: 'reference_mismatch'
  });
  assert.deepEqual(await entitlement(subject, 'legacy_email_slug'), before);
  const matching = event({ uid: 'legacy_email_slug', eventId: 'evt_legacy_cancel', reference: 'order_legacy',
    eventType: 'subscription.cancelled', status: 'canceled' });
  assert.deepEqual(await apply(subject, matching), { applied: true, duplicate: false });
  const canceled = await entitlement(subject, 'legacy_email_slug');
  assert.equal(canceled.uid, before.uid);
  assert.equal(canceled.id, before.id);
  assert.equal(canceled.tier, 'free');
  assert.equal(canceled.current_period_end, null);
  assert.deepEqual(await entitlement(subject, 'untouched_member'), untouched);
});

test('The existing entitlement timestamp protects pre-ledger purchases against older events', async context => {
  const subject = await database(context);
  await subject.query(`INSERT INTO public.entitlements
    (uid, tier, status, provider, subscription_id, updated_at)
    VALUES ('member_fixture', 'elite', 'active', 'razorpay', 'order_fixture', $1)`, [laterAt]);
  const before = await entitlement(subject);
  for (const status of ['active', 'canceled']) {
    assert.deepEqual(await apply(subject, event({ eventId: `evt_legacy_older_${status}`, status })), {
      applied: false, duplicate: false, reason: 'out_of_order'
    });
    assert.deepEqual(await entitlement(subject), before);
  }
});

test('Paid pro and elite support active and trialing, preserving null or explicit expiry exactly', async context => {
  const subject = await database(context, { auditId: 'bigint' });
  const explicitEnd = '2026-02-14T09:37:00.000Z';
  for (const provider of ['razorpay', 'lemonsqueezy']) {
    for (const tier of ['pro', 'elite']) {
      for (const status of ['active', 'trialing']) {
        for (const periodEnd of [null, explicitEnd]) {
          const uid = `expiry_${provider}_${tier}_${status}_${periodEnd === null}`;
          assert.deepEqual(await apply(subject, event({ provider, uid, eventId: uid, tier, status, periodEnd })), {
            applied: true, duplicate: false
          });
          const stored = await entitlement(subject, uid);
          assert.equal(stored.tier, tier);
          assert.equal(stored.status, status);
          assert.equal(stored.current_period_end?.toISOString() ?? null, periodEnd);
        }
      }
    }
  }
  assert.deepEqual(await counts(subject), { entitlements: 16, audits: 16, receipts: 16 });
});

test('Concurrent arrivals hold the per-uid transaction advisory lock and converge without duplicate audits', async context => {
  const subject = await database(context);
  await subject.exec(`
    CREATE FUNCTION public.assert_fixture_billing_lock() RETURNS trigger
    LANGUAGE plpgsql SET search_path = '' AS $fixture$
    DECLARE required_key bigint;
    BEGIN
      required_key := pg_catalog.hashtextextended('public.apply_billing_event:' || NEW.uid, 0);
      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_locks AS held
        WHERE held.locktype = 'advisory' AND held.mode = 'ExclusiveLock'
          AND held.granted AND held.pid = pg_catalog.pg_backend_pid()
          AND held.classid = ((required_key >> 32) & 4294967295)::oid
          AND held.objid = (required_key & 4294967295)::oid AND held.objsubid = 1
      ) THEN
        RAISE EXCEPTION 'Missing transaction advisory lock for %', NEW.uid;
      END IF;
      RETURN NEW;
    END;
    $fixture$;
    CREATE TRIGGER fixture_receipt_lock BEFORE INSERT OR UPDATE ON public.billing_event_receipts
      FOR EACH ROW EXECUTE FUNCTION public.assert_fixture_billing_lock();
    SET ROLE service_role;
  `);
  for (const reverse of [false, true]) {
    const uid = `concurrent_${reverse}`;
    const oldest = event({ uid, eventId: `${uid}_oldest`, occurredAt: earlierAt });
    const paid = event({ uid, eventId: `${uid}_paid`, tier: 'elite', occurredAt: laterAt });
    const canceled = event({ uid, eventId: `${uid}_canceled`, status: 'canceled', occurredAt: laterAt,
      eventType: 'subscription.cancelled' });
    const pending = [oldest, paid, canceled, oldest, paid, canceled];
    const results = await Promise.all((reverse ? pending.reverse() : pending).map(input => apply(subject, input)));
    assert.equal(results.filter(result => result.duplicate).length, 3);
  }
  await subject.exec('RESET ROLE');
  for (const uid of ['concurrent_false', 'concurrent_true']) {
    const stored = await entitlement(subject, uid);
    assert.equal(stored.status, 'canceled');
    assert.equal(stored.tier, 'free');
    assert.equal(stored.updated_at.toISOString(), laterAt);
  }
  assert.deepEqual(await counts(subject), { entitlements: 2, audits: 6, receipts: 6 });
  const { rows } = await subject.query(`SELECT count(*)::integer AS held FROM pg_catalog.pg_locks
    WHERE locktype = 'advisory' AND pid = pg_catalog.pg_backend_pid()`);
  assert.equal(rows[0].held, 0);
  context.diagnostic('PGlite queues one backend: lock ownership/release and arrival permutations are checked; multi-session blocking needs staging PostgreSQL.');
});

test('Entitlement, audit-insert, and receipt-finalization failures each roll back all new rows', async context => {
  const subject = await database(context);
  const failures = [
    ['entitlements', "CHECK (tier <> 'elite')"],
    ['billing_events', "CHECK (type <> 'payment.captured')"],
    ['billing_event_receipts', 'CHECK (NOT applied)']
  ];
  for (const [table, constraint] of failures) {
    const before = await counts(subject);
    const input = event({ uid: `failure_${table}`, eventId: `evt_failure_${table}`, tier: 'elite' });
    await subject.exec(`ALTER TABLE public.${table} ADD CONSTRAINT reject_fixture_write ${constraint} NOT VALID`);
    await assert.rejects(apply(subject, input), { code: '23514' });
    assert.deepEqual(await counts(subject), before);
    assert.equal(await entitlement(subject, input.uid), undefined);
    await subject.exec(`ALTER TABLE public.${table} DROP CONSTRAINT reject_fixture_write`);
    assert.deepEqual(await apply(subject, input), { applied: true, duplicate: false });
    assert.deepEqual(await apply(subject, input), { applied: false, duplicate: true });
    assert.deepEqual(await counts(subject), {
      entitlements: before.entitlements + 1, audits: before.audits + 1, receipts: before.receipts + 1
    });
  }
});

test('An enclosing transaction can roll back the complete billing operation', async context => {
  const subject = await database(context);
  await assert.rejects(subject.transaction(async transaction => {
    assert.deepEqual(await apply(transaction), { applied: true, duplicate: false });
    throw new Error('fixture outer rollback');
  }), /fixture outer rollback/);
  assert.deepEqual(await counts(subject), { entitlements: 0, audits: 0, receipts: 0 });
  assert.deepEqual(await apply(subject), { applied: true, duplicate: false });
});

test('Malformed server-bound inputs fail without changing any billing table', async context => {
  const subject = await database(context);
  const invalidInputs = [
    { provider: null }, { provider: '' }, { provider: 'stripe' }, { provider: 'Razorpay' },
    { eventId: null }, { eventId: '' }, { eventId: ' ' }, { eventId: 'evt\nfixture' },
    { eventId: 'identifier'.repeat(58) },
    { uid: null }, { uid: '' }, { uid: ' member_fixture' }, { uid: 'member\tfixture' },
    { uid: 'member'.repeat(43) },
    { eventType: null }, { eventType: '' }, { eventType: 'payment captured' },
    { eventType: 'payment..captured' }, { eventType: 'Payment.captured' },
    { eventType: 'event'.repeat(33) },
    { occurredAt: null }, { occurredAt: 'not-a-timestamp' }, { occurredAt: 'infinity' },
    { occurredAt: '-infinity' },
    { reference: null }, { reference: '' }, { reference: 'order fixture' },
    { reference: 'order\rfixture' }, { reference: 'reference'.repeat(58) },
    { tier: null }, { tier: '' }, { tier: 'eliteplus' }, { tier: '__proto__' },
    { tier: 'free', status: 'active' }, { tier: 'free', status: 'trialing' },
    { status: null }, { status: '' }, { status: 'paid' }, { status: 'cancelled' },
    { status: 'past_due' },
    { periodEnd: 'not-a-timestamp' }, { periodEnd: 'infinity' }, { periodEnd: '-infinity' },
    { raw: undefined }, { raw: null }, { raw: [] }, { raw: 'not-an-object' },
    { raw: 42 }, { raw: true }
  ];
  for (const [index, invalid] of invalidInputs.entries()) {
    await assert.rejects(apply(subject, event({ eventId: `evt_invalid_${index}`, ...invalid })),
      error => ['22023', '22007', '22008'].includes(error.code), JSON.stringify(invalid));
  }
  assert.deepEqual(await counts(subject), { entitlements: 0, audits: 0, receipts: 0 });
});

test('Canceled and inactive always write free, including an explicitly free input tier', async context => {
  const subject = await database(context);
  for (const tier of ['free', 'pro', 'elite']) {
    for (const status of ['canceled', 'inactive']) {
      const uid = `revoked_${tier}_${status}`;
      assert.deepEqual(await apply(subject, event({ uid, eventId: uid, tier, status,
        eventType: 'refund.processed' })), { applied: true, duplicate: false });
      const stored = await entitlement(subject, uid);
      assert.equal(stored.tier, 'free');
      assert.equal(stored.status, status);
      assert.equal(stored.current_period_end, null);
    }
  }
});

test('A provider event identifier cannot be rebound to different server inputs', async context => {
  const subject = await database(context);
  await apply(subject);
  const before = await entitlement(subject);
  const conflictingInputs = [
    { uid: 'another_member' }, { reference: 'order_another' }, { tier: 'elite' },
    { status: 'trialing' }, { occurredAt: laterAt }, { periodEnd: laterAt },
    { eventType: 'subscription.activated' }, { raw: { fixture: false } }
  ];
  for (const changed of conflictingInputs) {
    await assert.rejects(apply(subject, event(changed)), { code: '22023' });
  }
  assert.deepEqual(await entitlement(subject), before);
  assert.deepEqual(await counts(subject), { entitlements: 1, audits: 1, receipts: 1 });
  await assert.rejects(subject.exec(`INSERT INTO public.billing_event_receipts
    SELECT * FROM public.billing_event_receipts`), { code: '23505' });
});

test('Concurrent reuse of one provider event for different users has only one winner', async context => {
  const subject = await database(context);
  const outcomes = await Promise.allSettled([
    apply(subject, event({ uid: 'race_member_first' })),
    apply(subject, event({ uid: 'race_member_second' }))
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(outcome => outcome.status === 'rejected');
  assert.equal(rejected.reason.code, '22023');
  assert.deepEqual(await counts(subject), { entitlements: 1, audits: 1, receipts: 1 });
});

test('Replay matching is independent of session time zone and JSON object key order', async context => {
  const subject = await database(context);
  const input = event({ periodEnd: '2026-02-01T12:00:00.000Z', raw: { alpha: 1, nested: { omega: true, delta: 'data' } } });
  await apply(subject, input);
  await subject.exec("SET TIME ZONE 'Asia/Kolkata'");
  assert.deepEqual(await apply(subject, { ...input,
    occurredAt: '2026-01-02T17:30:00+05:30', periodEnd: '2026-02-01T17:30:00+05:30',
    raw: { nested: { delta: 'data', omega: true }, alpha: 1 }
  }), { applied: false, duplicate: true });
  assert.deepEqual(await counts(subject), { entitlements: 1, audits: 1, receipts: 1 });
});

test('The catalog exposes exactly the requested SECURITY DEFINER API with an empty search path', async context => {
  const subject = await database(context);
  const { rows } = await subject.query(`SELECT routine.proargnames AS names,
    pg_catalog.oidvectortypes(routine.proargtypes) AS types,
    pg_catalog.format_type(routine.prorettype, NULL) AS result_type,
    routine.prosecdef AS definer, routine.proconfig AS config,
    routine.pronargdefaults AS defaults, routine.provolatile AS volatility
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'public' AND routine.proname = 'apply_billing_event'`);
  assert.deepEqual(rows, [{
    names: ['p_provider', 'p_event_id', 'p_uid', 'p_event_type', 'p_occurred_at', 'p_reference',
      'p_tier', 'p_status', 'p_period_end', 'p_raw'],
    types: 'text, text, text, text, timestamp with time zone, text, text, text, timestamp with time zone, jsonb',
    result_type: 'jsonb', definer: true, config: ['search_path=""'], defaults: 0, volatility: 'v'
  }]);
  const { rows: tables } = await subject.query(`SELECT tablename FROM pg_catalog.pg_tables
    WHERE schemaname = 'public' ORDER BY tablename`);
  assert.deepEqual(tables.map(row => row.tablename), ['billing_event_receipts', 'billing_events', 'entitlements']);
  const { rows: privileges } = await subject.query(`SELECT privilege.grantee
    FROM pg_catalog.pg_proc AS routine
    CROSS JOIN LATERAL pg_catalog.aclexplode(routine.proacl) AS privilege
    WHERE routine.oid = 'public.apply_billing_event(text,text,text,text,timestamptz,text,text,text,timestamptz,jsonb)'::regprocedure
      AND privilege.grantee = 0`);
  assert.deepEqual(privileges, []);
});

test('Client roles cannot execute the RPC or access receipts; service_role can call and read', async context => {
  const subject = await database(context);
  const signature = 'public.apply_billing_event(text,text,text,text,timestamptz,text,text,text,timestamptz,jsonb)';
  for (const role of ['anon', 'authenticated']) {
    const { rows } = await subject.query(`SELECT
      pg_catalog.has_function_privilege($1, $2, 'EXECUTE') AS can_execute,
      pg_catalog.has_table_privilege($1, 'public.billing_event_receipts', 'SELECT') AS can_read`, [role, signature]);
    assert.deepEqual(rows, [{ can_execute: false, can_read: false }]);
    await subject.exec(`SET ROLE ${role}`);
    try {
      await assert.rejects(apply(subject), { code: '42501' });
      await assert.rejects(subject.query('SELECT * FROM public.billing_event_receipts'), { code: '42501' });
      await assert.rejects(subject.exec('DELETE FROM public.billing_event_receipts'), { code: '42501' });
      await assert.rejects(subject.exec('UPDATE public.billing_event_receipts SET applied = true'), { code: '42501' });
      await assert.rejects(subject.exec(`INSERT INTO public.billing_event_receipts
        (provider, event_id, uid, occurred_at, reference, status, input_digest)
        VALUES ('razorpay', 'forged', 'member_fixture', now(), 'forged', 'active', '\\x00')`), { code: '42501' });
    } finally {
      await subject.exec('RESET ROLE');
    }
  }
  assert.deepEqual(await counts(subject), { entitlements: 0, audits: 0, receipts: 0 });
  await subject.exec('SET ROLE service_role');
  try {
    assert.deepEqual(await apply(subject), { applied: true, duplicate: false });
    const { rows } = await subject.query('SELECT uid, applied FROM public.billing_event_receipts');
    assert.deepEqual(rows, [{ uid: 'member_fixture', applied: true }]);
  } finally {
    await subject.exec('RESET ROLE');
  }
  assert.deepEqual(await counts(subject), { entitlements: 1, audits: 1, receipts: 1 });
});

test('Receipt RLS remains default-deny even if client SELECT is accidentally granted', async context => {
  const subject = await database(context);
  await apply(subject);
  const { rows } = await subject.query(`SELECT relrowsecurity FROM pg_catalog.pg_class
    WHERE oid = 'public.billing_event_receipts'::regclass`);
  assert.equal(rows[0].relrowsecurity, true);
  await subject.exec('GRANT SELECT ON public.billing_event_receipts TO anon, authenticated');
  for (const role of ['anon', 'authenticated']) {
    await subject.exec(`SET ROLE ${role}`);
    assert.deepEqual((await subject.query('SELECT * FROM public.billing_event_receipts')).rows, []);
    await subject.exec('RESET ROLE');
  }
});

test('Caller search paths and temporary table names cannot redirect SECURITY DEFINER writes', async context => {
  const subject = await database(context);
  await subject.exec(`CREATE TEMP TABLE entitlements (uid text);
    CREATE TEMP TABLE billing_events (uid text);
    CREATE TEMP TABLE billing_event_receipts (uid text);
    SET search_path = pg_temp, public;
    SET ROLE service_role;`);
  assert.deepEqual(await apply(subject), { applied: true, duplicate: false });
  await subject.exec('RESET ROLE');
  assert.deepEqual(await counts(subject), { entitlements: 1, audits: 1, receipts: 1 });
  for (const table of ['entitlements', 'billing_events', 'billing_event_receipts']) {
    assert.deepEqual((await subject.query(`SELECT * FROM pg_temp.${table}`)).rows, []);
  }
});