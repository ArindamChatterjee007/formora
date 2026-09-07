'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PGlite } = require('@electric-sql/pglite');

const owner = '12345678-1234-4234-8234-123456789abc';
const otherOwner = '87654321-4321-4321-8321-cba987654321';
const version = 'billing-analytics-v1';
const sql = name => fs.readFileSync(path.join(__dirname, '../supabase', name), 'utf8');

async function database(context, { activation = true } = {}) {
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
    CREATE TABLE auth.users (
      id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      email_confirmed_at timestamptz, phone_confirmed_at timestamptz,
      deleted_at timestamptz, is_anonymous boolean NOT NULL DEFAULT false,
      raw_app_meta_data jsonb NOT NULL DEFAULT '{}', raw_user_meta_data jsonb NOT NULL DEFAULT '{}'
    );
    CREATE TABLE public.accounts (uid text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz);
    ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
    GRANT SELECT, INSERT, UPDATE ON public.accounts TO authenticated;
    CREATE POLICY accounts_read ON public.accounts FOR SELECT USING (auth.uid()::text = uid);
    CREATE POLICY accounts_ins ON public.accounts FOR INSERT WITH CHECK (auth.uid()::text = uid);
    CREATE POLICY accounts_upd ON public.accounts FOR UPDATE USING (auth.uid()::text = uid);
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
  await subject.exec(sql('analytics-outbox.sql'));
  if (activation) await subject.exec(sql('activation-events.sql'));
  return subject;
}

async function asOwner(subject, uid, command, values = []) {
  await subject.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [uid]);
  await subject.exec('SET ROLE authenticated');
  try { return await subject.query(command, values); }
  finally { await subject.exec('RESET ROLE'); }
}

async function consent(subject, uid = owner, granted = true, policy = version) {
  return (await asOwner(subject, uid,
    'SELECT public.set_billing_analytics_consent($1, $2) AS result', [granted, policy])).rows[0].result;
}

async function lookup(subject, uid = owner) {
  return (await asOwner(subject, uid,
    'SELECT public.get_billing_analytics_consent() AS result')).rows[0].result;
}

test('Consent lookup distinguishes unset, granted, declined and stale policy without creating a choice', async context => {
  const subject = await database(context);
  assert.deepEqual(await lookup(subject), {
    granted: false, version, choice_version: null, consent_state: 'unset', revision: null, captured_at: null
  });
  assert.equal((await subject.query('SELECT count(*)::integer AS count FROM public.billing_analytics_consent')).rows[0].count, 0);
  const granted = await consent(subject);
  assert.equal(granted.consent_state, 'granted');
  assert.equal(granted.choice_version, version);
  assert.equal(granted.granted, true);
  assert.deepEqual(await consent(subject), granted);
  assert.equal((await consent(subject, owner, false)).consent_state, 'declined');
  await subject.exec("UPDATE public.analytics_delivery_config SET consent_version = 'reviewed-v2'");
  const stale = await lookup(subject);
  assert.equal(stale.consent_state, 'stale_version');
  assert.equal(stale.version, 'reviewed-v2');
  assert.equal(stale.choice_version, version);
  assert.equal(stale.granted, false);
  await assert.rejects(consent(subject), { code: '22023' });
  assert.equal((await consent(subject, owner, false)).consent_state, 'declined');
});

test('Consent RPCs are authenticated own-lookups with no client owner or timestamp parameter', async context => {
  const subject = await database(context);
  await consent(subject);
  assert.equal((await lookup(subject, otherOwner)).consent_state, 'unset');
  await consent(subject, otherOwner, false);
  assert.equal((await lookup(subject)).consent_state, 'granted');
  await assert.rejects(lookup(subject, ''), { code: '42501' });
  await assert.rejects(asOwner(subject, otherOwner,
    'SELECT * FROM public.billing_analytics_consent'), { code: '42501' });
  await subject.exec('SET ROLE anon');
  await assert.rejects(subject.exec('SELECT public.get_billing_analytics_consent()'), { code: '42501' });
  await subject.exec('RESET ROLE');
});

async function enable(subject) {
  await subject.query(`UPDATE public.activation_config SET collection_enabled = true, export_enabled = true,
    source_mode = 'local_test', consent_version = $1, permission_approved = true,
    source_verified = true, exclusions_verified = true`, [version]);
}

async function authFixture(subject, uid = owner, { priorConsent = true, cohort = 'production', history = 'native_only',
  confirmed = true, createdAt = null, anonymous = false, userMetadata = {} } = {}) {
  if (priorConsent) await subject.query(`INSERT INTO public.billing_analytics_consent (uid, granted, version)
    VALUES ($1, true, $2) ON CONFLICT (uid) DO NOTHING`, [uid, version]);
  await subject.query(`INSERT INTO auth.users (id, created_at, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
    VALUES ($1, COALESCE($2::timestamptz, clock_timestamp()), CASE WHEN $3 THEN clock_timestamp() END, $4::jsonb, $5::jsonb, $6)`,
  [uid, createdAt, confirmed, JSON.stringify({ activation: { cohort, history } }), JSON.stringify(userMetadata), anonymous]);
}

function account(workoutLog = [], changes = {}) {
  return { workoutLog, restDays: [], draftSession: null, profile: { health: 'never-export', email: 'never-export@example.test' }, ...changes };
}

function workout(date = new Date().toISOString().slice(0, 10), requestId = otherOwner) {
  return { date, ...(requestId ? { finalizationRequestId: requestId } : {}),
    split: 'push', exercises: [{ id: 'fixture', name: 'Private exercise', muscle: 'private',
    sets: [{ reps: 1, weight: 1 }] }], volume: 1 };
}

async function saveAccount(subject, data, uid = owner, caller = uid) {
  return asOwner(subject, caller, `INSERT INTO public.accounts (uid, data, updated_at) VALUES ($1, $2::jsonb, '1900-01-01Z')
    ON CONFLICT (uid) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`, [uid, JSON.stringify(data)]);
}

async function members(subject) {
  return (await subject.query('SELECT * FROM public.activation_members ORDER BY uid')).rows;
}

async function finalizeWorkout(subject, requestId = otherOwner, workoutDate = workout().date, uid = owner, choice = null) {
  const permission = choice || await lookup(subject, uid);
  return (await asOwner(subject, uid,
    'SELECT public.record_workout_finalization($1::uuid, $2::date, $3::text, $4::uuid) AS result',
    [requestId, workoutDate, permission.version, permission.revision])).rows[0].result;
}

async function registrationStatus(subject, uid = owner) {
  return (await asOwner(subject, uid, 'SELECT public.get_activation_registration() AS result')).rows[0].result;
}

const utcDayOffset = offset => new Date(Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z')
  + offset * 86400000).toISOString().slice(0, 10);

test('Explicit finalization counts Save and Continue then Finish once, never the draft-clear write alone', async context => {
  const subject = await database(context);
  await enable(subject);
  await authFixture(subject);
  await saveAccount(subject, account());
  const logged = workout(undefined, null);
  await saveAccount(subject, account([logged], { draftSession: { date: logged.date, session: { items: [] } } }));
  assert.equal((await members(subject))[0].first_workout_at, null);
  await saveAccount(subject, account([{ ...logged, finalizationRequestId: otherOwner }]));
  assert.equal((await members(subject))[0].first_workout_at, null);
  const receipt = await finalizeWorkout(subject, otherOwner, logged.date);
  assert.equal(receipt.confirmed, true);
  assert.equal(receipt.status, 'recorded');
  assert.equal(receipt.request_id, otherOwner);
  assert.ok(Number.isFinite(Date.parse(receipt.recorded_at)));
  assert.equal((await members(subject))[0].history_state, 'observing');
  assert.equal((await members(subject))[0].first_workout_at.toISOString(), new Date(receipt.recorded_at).toISOString());
  assert.deepEqual(await finalizeWorkout(subject, otherOwner, logged.date), receipt);
});

test('Registration status is bound to actual auth created_at and exposes the post-opt-in decision gate without enrollment', async context => {
  const subject = await database(context);
  assert.deepEqual(await registrationStatus(subject), { confirmed: false, status: 'disabled', registered_at: null });
  await enable(subject);
  await authFixture(subject);
  const actual = (await subject.query('SELECT created_at FROM auth.users WHERE id = $1', [owner])).rows[0].created_at;
  const status = await registrationStatus(subject);
  assert.equal(status.confirmed, true);
  assert.equal(status.status, 'registered');
  assert.equal(new Date(status.registered_at).toISOString(), actual.toISOString());
  await authFixture(subject, otherOwner, { priorConsent: false });
  assert.equal((await registrationStatus(subject, otherOwner)).status, 'consent_required');
  await consent(subject, otherOwner);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(await registrationStatus(subject, otherOwner),
      { confirmed: false, status: 'prior_consent_required', registered_at: null });
  }
  await saveAccount(subject, account(), otherOwner);
  await saveAccount(subject, account([workout()]), otherOwner);
  assert.equal((await finalizeWorkout(subject, otherOwner, workout().date, otherOwner)).status, 'not_enrolled');
  assert.equal((await members(subject)).length, 1);
  assert.equal((await cohort(subject)).activation_eligible, null);
  await assert.rejects(registrationStatus(subject, ''), { code: '42501' });
  await assert.rejects(asOwner(subject, owner, 'SELECT public.get_activation_registration($1::uuid)', [otherOwner]), { code: '42883' });
});

test('Finalize requires an authenticated caller and the exact request UUID on that caller own latest saved row', async context => {
  const subject = await database(context);
  await enable(subject);
  await authFixture(subject);
  const permission = await lookup(subject);
  await assert.rejects(finalizeWorkout(subject, otherOwner, workout().date, '', permission), { code: '42501' });
  for (const role of ['anon', 'service_role']) {
    await subject.exec('SET ROLE ' + role);
    await assert.rejects(subject.query('SELECT public.record_workout_finalization($1, $2, $3, $4)',
      [otherOwner, workout().date, version, permission.revision]), { code: '42501' });
    await assert.rejects(subject.query('SELECT public.get_activation_registration()'), { code: '42501' });
    await subject.exec('RESET ROLE');
  }
  assert.equal((await finalizeWorkout(subject)).status, 'not_ready');
  await saveAccount(subject, account());
  await saveAccount(subject, account([workout()]));
  assert.equal((await finalizeWorkout(subject, owner)).status, 'not_ready');
  assert.equal((await finalizeWorkout(subject, otherOwner, utcDayOffset(-1))).status, 'not_candidate');
  await authFixture(subject, otherOwner);
  await saveAccount(subject, account(), otherOwner);
  assert.equal((await finalizeWorkout(subject, otherOwner, workout().date, otherOwner)).status, 'not_candidate');
  await assert.rejects(saveAccount(subject, account([workout()]), owner, otherOwner), { code: '42501' });
  for (const invalid of [[null, workout().date, version, permission.revision],
    [otherOwner, null, version, permission.revision], [otherOwner, 'infinity', version, permission.revision],
    [otherOwner, workout().date, null, permission.revision], [otherOwner, workout().date, version, null]]) {
    await assert.rejects(asOwner(subject, owner,
      'SELECT public.record_workout_finalization($1, $2, $3, $4)', invalid), { code: '22023' });
  }
  await assert.rejects(asOwner(subject, owner,
    'SELECT public.record_workout_finalization($1::uuid, $2::date, $3::text, $4::uuid, $5::timestamptz)',
    [otherOwner, workout().date, version, permission.revision, '1900-01-01Z']), { code: '42883' });
  const first = await finalizeWorkout(subject);
  assert.equal(first.confirmed, true);
  await saveAccount(subject, account([workout()]), otherOwner);
  assert.equal((await finalizeWorkout(subject, otherOwner, workout().date, otherOwner)).confirmed, true);
  assert.equal((await subject.query('SELECT count(*)::integer AS count FROM public.activation_finalization_receipts')).rows[0].count, 2);
  assert.doesNotMatch(JSON.stringify(first), /uid|workout_date|revision|health|exercises|weight/);
});

test('Completed-set validation rejects empty, nonpositive, malformed and duplicate logs but permits bodyweight work', async context => {
  const subject = await database(context);
  await enable(subject);
  const scenarios = [
    { sets: [{ reps: 0, weight: 1 }], accepted: false },
    { sets: [{ reps: -1, weight: 1 }], accepted: false },
    { sets: [{ reps: 1, weight: -1 }], accepted: false },
    { sets: [{ reps: '1', weight: 1 }], accepted: false, reason: 'invalid_document' },
    { sets: [], accepted: false, reason: 'invalid_document' },
    { sets: [null], accepted: false, reason: 'invalid_document' },
    { sets: [{ reps: 5, weight: 0 }], accepted: true },
    { sets: [{ reps: 1, weight: 1 }], duplicate: true, accepted: false, reason: 'invalid_document' }
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const uid = fixtureUid(index + 1);
    await authFixture(subject, uid);
    await saveAccount(subject, account(), uid);
    const logged = workout();
    logged.exercises[0].sets = scenario.sets;
    await saveAccount(subject, account(scenario.duplicate ? [logged, logged] : [logged]), uid);
    const result = await finalizeWorkout(subject, otherOwner, logged.date, uid);
    assert.equal(result.confirmed, scenario.accepted, JSON.stringify(scenario));
    if (scenario.reason) assert.equal((await members(subject)).find(member => member.uid === uid).incomplete_reason, scenario.reason);
  }
});

test('Finalization accepts adjacent UTC dates including plus one, rejects plus two in both SQL gates, and keeps server receipt time', async context => {
  const subject = await database(context);
  await enable(subject);
  await subject.exec("SET TIME ZONE 'Asia/Calcutta'");
  for (const [index, offset] of [-2, -1, 0, 1, 2].entries()) {
    const uid = fixtureUid(index + 1);
    const { day, before } = (await subject.query(`SELECT clock_timestamp() AS before,
      to_char((clock_timestamp() AT TIME ZONE 'UTC')::date + $1::integer, 'YYYY-MM-DD') AS day`, [offset])).rows[0];
    await authFixture(subject, uid);
    await saveAccount(subject, account(), uid);
    await saveAccount(subject, account([workout(day)]), uid);
    const result = await finalizeWorkout(subject, otherOwner, day, uid);
    assert.equal(result.confirmed, Math.abs(offset) <= 1, 'UTC offset ' + offset);
    if (result.confirmed) {
      assert.equal((await subject.query(`SELECT recorded_at BETWEEN $2::timestamptz AND clock_timestamp() AS server_timed
        FROM public.activation_finalization_receipts WHERE uid = $1`, [uid, before.toISOString()])).rows[0].server_timed, true);
      assert.deepEqual(await finalizeWorkout(subject, otherOwner, day, uid), result);
      const otherDay = new Date(Date.parse(day + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
      assert.equal((await finalizeWorkout(subject, otherOwner, otherDay, uid)).status, 'request_conflict');
    } else {
      assert.equal(result.status, 'incomplete_history');
      assert.equal((await members(subject)).find(member => member.uid === uid).incomplete_reason, 'untrusted_log_date');
      await subject.query(`UPDATE public.activation_members SET history_state = 'observing', incomplete_reason = NULL,
        pending_workout_date = $2::date WHERE uid = $1`, [uid, day]);
      assert.equal((await finalizeWorkout(subject, otherOwner, day, uid)).status, 'date_out_of_range');
      assert.equal((await members(subject)).find(member => member.uid === uid).first_workout_at, null);
    }
  }
  assert.equal((await subject.query('SELECT count(*)::integer AS count FROM public.activation_finalization_receipts')).rows[0].count, 3);
});

test('Malformed current JSON and drafts return a denial before array expansion even when the history flag is observing', async context => {
  const subject = await database(context);
  await enable(subject);
  const day = (await subject.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day")).rows[0].day;
  const malformed = [account(null), account({ unexpected: true }), account(42), account(false), account('private'),
    account([workout(day)], { restDays: {} }), account([workout(day)], { draftSession: [] }),
    account([workout(day)], { draftSession: 'private' }), account([workout(day)], { draftSession: {} }),
    account([workout(day)], { draftSession: { date: day, session: null } }),
    account([workout(day)], { draftSession: { date: '2026-02-30', session: { items: [] } } })];
  const scenarios = [...malformed.map(data => ({ data, status: 'incomplete_history' })),
    { data: account([workout(day)], { draftSession: { date: day, session: { items: [] } } }), status: 'not_ready' }];
  for (const [index, scenario] of scenarios.entries()) {
    const uid = fixtureUid(index + 1);
    await authFixture(subject, uid);
    await saveAccount(subject, account(), uid);
    await saveAccount(subject, account([workout(day)]), uid);
    await saveAccount(subject, scenario.data, uid);
    await subject.query(`UPDATE public.activation_members SET history_state = 'observing', incomplete_reason = NULL,
      pending_workout_date = $2::date WHERE uid = $1`, [uid, day]);
    const result = await finalizeWorkout(subject, otherOwner, day, uid);
    assert.deepEqual(result, { request_id: otherOwner, confirmed: false, status: scenario.status, recorded_at: null });
    assert.equal((await members(subject)).find(member => member.uid === uid).first_workout_at, null);
    assert.deepEqual((await subject.query('SELECT data FROM public.accounts WHERE uid = $1', [uid])).rows[0].data, scenario.data);
  }
  assert.equal((await subject.query('SELECT count(*)::integer AS count FROM public.activation_finalization_receipts')).rows[0].count, 0);
});

test('Stale finalize delivery cannot count a replaced request marker and later edits never create a second first event', async context => {
  const subject = await database(context);
  await enable(subject);
  await authFixture(subject);
  await saveAccount(subject, account());
  await saveAccount(subject, account([workout()]));
  await saveAccount(subject, account([workout(undefined, owner)]));
  assert.equal((await finalizeWorkout(subject)).status, 'not_ready');
  assert.equal((await members(subject))[0].first_workout_at, null);
  const receipt = await finalizeWorkout(subject, owner);
  assert.equal(receipt.confirmed, true);
  const edit = workout(undefined, null);
  edit.exercises[0].sets[0].reps = 2;
  await saveAccount(subject, account([edit]));
  assert.deepEqual(await finalizeWorkout(subject, owner), receipt);
  assert.equal((await finalizeWorkout(subject)).status, 'already_recorded');
  assert.equal((await subject.query('SELECT count(*)::integer AS count FROM public.activation_finalization_receipts')).rows[0].count, 1);
});

test('Bulk imports and a preceding unresolved workout keep first-ever history incomplete', async context => {
  const subject = await database(context);
  await enable(subject);
  await authFixture(subject);
  await saveAccount(subject, account());
  await saveAccount(subject, account([workout(utcDayOffset(-1)), workout()]));
  assert.equal((await finalizeWorkout(subject)).status, 'incomplete_history');
  assert.equal((await members(subject))[0].incomplete_reason, 'initial_import');
  await authFixture(subject, otherOwner);
  await saveAccount(subject, account(), otherOwner);
  await saveAccount(subject, account([workout(utcDayOffset(-1), null)]), otherOwner);
  await saveAccount(subject, account([workout(utcDayOffset(-1), null), workout()]), otherOwner);
  assert.equal((await finalizeWorkout(subject, otherOwner, workout().date, otherOwner)).status, 'incomplete_history');
  assert.equal((await members(subject)).find(member => member.uid === otherOwner).incomplete_reason, 'unfinalized_history');
});

test('Disabled collection, consent revisions, server policy changes and source epochs gate even receipt replay', async context => {
  const subject = await database(context);
  await enable(subject);
  await authFixture(subject);
  await saveAccount(subject, account());
  await saveAccount(subject, account([workout()]));
  const permission = await lookup(subject);
  assert.equal((await finalizeWorkout(subject, otherOwner, workout().date, owner, { ...permission, revision: owner })).status, 'consent_required');
  const receipt = await finalizeWorkout(subject);
  assert.equal(receipt.confirmed, true);
  await subject.exec("UPDATE public.analytics_delivery_config SET consent_version = 'reviewed-v2'");
  assert.equal((await finalizeWorkout(subject, otherOwner, workout().date, owner, permission)).status, 'consent_required');
  await subject.query('UPDATE public.analytics_delivery_config SET consent_version = $1', [version]);
  await subject.exec('UPDATE public.activation_config SET collection_enabled = false, export_enabled = false');
  assert.equal((await finalizeWorkout(subject)).status, 'disabled');
  await enable(subject);
  assert.equal((await finalizeWorkout(subject)).status, 'not_enrolled');
  assert.equal((await subject.query('SELECT count(*)::integer AS count FROM public.activation_finalization_receipts')).rows[0].count, 1);
});

test('The SQL install is one-shot and a rejected rerun preserves existing receipts and operational data atomically', async context => {
  const subject = await database(context);
  await enable(subject);
  await authFixture(subject);
  await saveAccount(subject, account());
  await saveAccount(subject, account([workout()]));
  const receipt = await finalizeWorkout(subject);
  const saved = (await subject.query('SELECT data FROM public.accounts')).rows;
  await assert.rejects(subject.exec(sql('activation-events.sql')), /Activation already exists/);
  await subject.exec('ROLLBACK');
  assert.deepEqual((await subject.query('SELECT data FROM public.accounts')).rows, saved);
  assert.deepEqual(await finalizeWorkout(subject), receipt);
});

test('Activation migration is inert, preserves existing accounts, and does not collect operational analytics while OFF', async context => {
  const subject = await database(context, { activation: false });
  await authFixture(subject);
  await saveAccount(subject, account([workout()]));
  const before = (await subject.query('SELECT * FROM public.accounts')).rows;
  await subject.exec(sql('activation-events.sql'));
  assert.deepEqual((await subject.query('SELECT * FROM public.accounts')).rows, before);
  await authFixture(subject, otherOwner);
  await saveAccount(subject, account([workout()]), otherOwner);
  assert.deepEqual(await members(subject), []);
  assert.deepEqual((await subject.query('SELECT collection_enabled, export_enabled, source_mode FROM public.activation_config')).rows,
    [{ collection_enabled: false, export_enabled: false, source_mode: 'unreviewed' }]);
  assert.equal((await subject.query('SELECT count(*)::integer AS count FROM public.analytics_outbox')).rows[0].count, 0);
});

test('The real auth.users trigger captures first registration, never signup clicks or post-registration opt-in backfill', async context => {
  const subject = await database(context);
  await enable(subject);
  await authFixture(subject, owner, { userMetadata: { uid: otherOwner, created_at: '1900-01-01Z', signup_started: true } });
  const registered = (await members(subject))[0];
  const actual = (await subject.query('SELECT created_at FROM auth.users WHERE id = $1', [owner])).rows[0];
  assert.equal(registered.uid, owner);
  assert.deepEqual(registered.registered_at, actual.created_at);
  assert.equal(registered.source_mode, 'local_test');
  assert.equal(registered.first_workout_at, null);
  await subject.query('UPDATE auth.users SET email_confirmed_at = clock_timestamp() WHERE id = $1', [owner]);
  assert.equal((await members(subject)).length, 1);
  await authFixture(subject, otherOwner, { priorConsent: false });
  await consent(subject, otherOwner);
  await subject.query('UPDATE auth.users SET email_confirmed_at = clock_timestamp() WHERE id = $1', [otherOwner]);
  await saveAccount(subject, account(), otherOwner);
  await saveAccount(subject, account([workout()]), otherOwner);
  assert.equal((await members(subject)).length, 1);
  await assert.rejects(asOwner(subject, owner, 'INSERT INTO auth.users(id) VALUES ($1)', [otherOwner]), { code: '42501' });
});

test('Only explicit finalization of a persisted completed log counts once per verified owner at server time', async context => {
  const subject = await database(context);
  await enable(subject);
  await authFixture(subject);
  await saveAccount(subject, account());
  const before = Date.now();
  const data = account([workout()], { uid: otherOwner, completed_at: '1900-01-01Z', updatedAt: 0 });
  await saveAccount(subject, data);
  assert.equal((await members(subject))[0].first_workout_at, null);
  const receipt = await finalizeWorkout(subject);
  assert.equal(receipt.confirmed, true);
  const first = (await members(subject))[0];
  assert.ok(first.first_workout_at.getTime() >= before - 1000);
  assert.ok(first.first_workout_at.getTime() <= Date.now() + 1000);
  assert.equal(first.history_state, 'observing');
  await saveAccount(subject, data);
  data.workoutLog[0].exercises[0].sets[0].reps = 2;
  await saveAccount(subject, data);
  assert.deepEqual(await finalizeWorkout(subject), receipt);
  assert.equal((await finalizeWorkout(subject, owner)).status, 'already_recorded');
  assert.deepEqual((await members(subject))[0].first_workout_at, first.first_workout_at);
  assert.doesNotMatch(JSON.stringify(await members(subject)), /never-export|health|Private exercise|muscle|weight|volume|completed_at/);
  await assert.rejects(saveAccount(subject, account(), owner, otherOwner), { code: '42501' });
  assert.deepEqual((await members(subject))[0].first_workout_at, first.first_workout_at);
});

test('Drafts, partial saves, cancellation and rest days cannot claim finalized activation', async context => {
  const subject = await database(context);
  await enable(subject);
  await authFixture(subject);
  await saveAccount(subject, account());
  const logged = workout(undefined, null);
  const partial = account([logged], { draftSession: { date: logged.date, session: { items: [] } } });
  await saveAccount(subject, partial);
  assert.equal((await members(subject))[0].first_workout_at, null);
  assert.equal((await finalizeWorkout(subject)).status, 'not_ready');
  await saveAccount(subject, account([logged]));
  assert.equal((await members(subject))[0].first_workout_at, null);
  assert.equal((await members(subject))[0].history_state, 'observing');
  assert.equal((await finalizeWorkout(subject)).status, 'not_ready');
  await authFixture(subject, otherOwner);
  await saveAccount(subject, account(), otherOwner);
  await saveAccount(subject, account([logged], { restDays: [logged.date] }), otherOwner);
  assert.equal((await finalizeWorkout(subject, otherOwner, logged.date, otherOwner)).confirmed, false);
  assert.equal((await members(subject)).find(member => member.uid === otherOwner).first_workout_at, null);
});

test('A first account write containing a finished workout is an incomplete import, not proof of first-ever completion', async context => {
  const subject = await database(context);
  await enable(subject);
  await authFixture(subject);
  await saveAccount(subject, account([workout()]));
  assert.equal((await members(subject))[0].incomplete_reason, 'initial_import');
  assert.equal((await members(subject))[0].first_workout_at, null);
  await saveAccount(subject, account());
  await saveAccount(subject, account([workout()]));
  assert.equal((await finalizeWorkout(subject)).status, 'incomplete_history');
  assert.equal((await members(subject))[0].first_workout_at, null);
});

test('Internal, test, bot, unclassified, anonymous, unconfirmed and future-dated identities are excluded', async context => {
  for (const scenario of [{ cohort: 'internal' }, { cohort: 'test' }, { cohort: 'bot' }, { cohort: 'unknown' },
    { anonymous: true }, { confirmed: false }, { createdAt: '2999-01-01Z' }]) {
    const subject = await database(context);
    await enable(subject);
    await authFixture(subject, owner, scenario);
    await saveAccount(subject, account());
    await saveAccount(subject, account([workout()]));
    assert.deepEqual(await members(subject), [], JSON.stringify(scenario));
  }
});

test('Finalize failure rolls back the receipt and first event without losing the already saved workout', async context => {
  const subject = await database(context);
  await enable(subject);
  await authFixture(subject);
  await saveAccount(subject, account());
  await subject.exec('ALTER TABLE public.activation_members ADD CONSTRAINT reject_fixture CHECK (first_workout_at IS NULL) NOT VALID');
  const saved = account([workout()]);
  await saveAccount(subject, saved);
  await assert.rejects(finalizeWorkout(subject), { code: '23514' });
  assert.deepEqual((await subject.query('SELECT data FROM public.accounts')).rows[0].data, saved);
  assert.equal((await subject.query('SELECT count(*)::integer AS count FROM public.activation_finalization_receipts')).rows[0].count, 0);
  assert.equal((await members(subject))[0].first_workout_at, null);
  await subject.exec('ALTER TABLE public.activation_members DROP CONSTRAINT reject_fixture');
  const receipt = await finalizeWorkout(subject);
  assert.equal(receipt.confirmed, true);
  const first = (await members(subject))[0].first_workout_at;
  assert.deepEqual(await finalizeWorkout(subject), receipt);
  assert.deepEqual((await members(subject))[0].first_workout_at, first);
  assert.equal((await subject.query('SELECT count(*)::integer AS count FROM public.activation_finalization_receipts')).rows[0].count, 1);
});

test('Consent withdrawal atomically deletes private activation linkage without touching operational account data', async context => {
  const subject = await database(context);
  await enable(subject);
  await authFixture(subject);
  await saveAccount(subject, account());
  await saveAccount(subject, account([workout()]));
  assert.equal((await finalizeWorkout(subject)).confirmed, true);
  const granted = await lookup(subject);
  const before = (await subject.query('SELECT * FROM public.accounts')).rows;
  assert.equal((await consent(subject, owner, false)).consent_state, 'declined');
  assert.deepEqual(await members(subject), []);
  assert.deepEqual((await subject.query('SELECT * FROM public.activation_finalization_receipts')).rows, []);
  assert.equal((await finalizeWorkout(subject, otherOwner, workout().date, owner, granted)).status, 'consent_required');
  assert.deepEqual((await subject.query('SELECT * FROM public.accounts')).rows, before);
  await consent(subject);
  await saveAccount(subject, account([workout()]));
  assert.equal((await finalizeWorkout(subject)).status, 'not_enrolled');
  assert.deepEqual(await members(subject), []);
});

test('Auth metadata refresh preserves first registration and workout; an actual legacy-history attestation marks them incomplete', async context => {
  const subject = await database(context);
  await enable(subject);
  await authFixture(subject);
  await saveAccount(subject, account());
  await saveAccount(subject, account([workout()]));
  assert.equal((await finalizeWorkout(subject)).confirmed, true);
  const before = (await members(subject))[0];
  await subject.query('UPDATE auth.users SET raw_app_meta_data = raw_app_meta_data WHERE id = $1', [owner]);
  assert.deepEqual((await members(subject))[0], before);
  await subject.query(`UPDATE auth.users SET raw_app_meta_data = jsonb_set(raw_app_meta_data,
    '{activation,history}', '"legacy"') WHERE id = $1`, [owner]);
  const legacy = (await members(subject))[0];
  assert.equal(legacy.history_state, 'incomplete');
  assert.equal(legacy.incomplete_reason, 'legacy_or_unknown_history');
  assert.deepEqual(legacy.registered_at, before.registered_at);
  assert.deepEqual(legacy.first_workout_at, before.first_workout_at);
});

test('Out-of-order snapshots cannot create another first event or restore complete first-occurrence history', async context => {
  const subject = await database(context);
  await enable(subject);
  await authFixture(subject);
  await saveAccount(subject, account());
  await saveAccount(subject, account([workout()]));
  const receipt = await finalizeWorkout(subject);
  assert.equal(receipt.confirmed, true);
  const first = (await members(subject))[0].first_workout_at;
  await saveAccount(subject, account());
  await saveAccount(subject, account([workout()]));
  const final = (await members(subject))[0];
  assert.deepEqual(final.first_workout_at, first);
  assert.equal(final.incomplete_reason, 'history_rewrite');
  assert.equal((await members(subject)).length, 1);
  assert.deepEqual(await finalizeWorkout(subject), receipt);
});

test('Malformed workout shape, untrusted historical dates and privileged imports remain incomplete', async context => {
  for (const scenario of ['malformed', 'date', 'privileged']) {
    const subject = await database(context);
    await enable(subject);
    await authFixture(subject);
    await saveAccount(subject, account());
    const data = account([workout(scenario === 'date' ? '1900-01-01' : undefined)]);
    if (scenario === 'malformed') data.workoutLog[0].exercises[0].sets = [null];
    if (scenario === 'privileged') {
      await subject.query("SELECT set_config('request.jwt.claim.sub', '', false)");
      await subject.query('UPDATE public.accounts SET data = $1::jsonb WHERE uid = $2', [JSON.stringify(data), owner]);
    } else await saveAccount(subject, data);
    const row = (await members(subject))[0];
    assert.equal(row.first_workout_at, null);
    assert.equal(row.incomplete_reason, { malformed: 'invalid_document', date: 'untrusted_log_date', privileged: 'untrusted_write' }[scenario]);
  }
});

test('A non-existent auth owner cannot synthesize registration with an accounts write or a caller-supplied timestamp', async context => {
  const subject = await database(context);
  await enable(subject);
  await consent(subject);
  await saveAccount(subject, account());
  await saveAccount(subject, account([workout()], { registered_at: '2026-01-01Z', first_workout_at: '2026-01-02Z' }));
  assert.deepEqual(await members(subject), []);
});

test('Collection epochs do not backfill off-period events and billing consent does not implicitly approve activation', async context => {
  const subject = await database(context);
  await assert.rejects(subject.exec('UPDATE public.activation_config SET collection_enabled = true'), { code: '23514' });
  await enable(subject);
  await authFixture(subject);
  const epoch = (await members(subject))[0].source_epoch;
  await subject.exec('UPDATE public.activation_config SET collection_enabled = false, export_enabled = false');
  await authFixture(subject, otherOwner);
  await saveAccount(subject, account(), owner);
  await saveAccount(subject, account([workout()]), owner);
  assert.equal((await members(subject))[0].first_workout_at, null);
  await enable(subject);
  const newEpoch = (await subject.query('SELECT source_epoch FROM public.activation_config')).rows[0].source_epoch;
  assert.notEqual(newEpoch, epoch);
  await saveAccount(subject, account([workout()]));
  await subject.query('UPDATE auth.users SET raw_app_meta_data = raw_app_meta_data WHERE id = $1', [otherOwner]);
  assert.equal((await members(subject)).length, 1);
  assert.equal((await members(subject))[0].first_workout_at, null);
  await subject.exec("UPDATE public.analytics_delivery_config SET consent_version = 'reviewed-v2'");
  await saveAccount(subject, account([workout()]));
  assert.equal((await members(subject))[0].first_workout_at, null);
});

test('A registration trigger failure rolls back the actual auth insert without synthesizing registration', async context => {
  const subject = await database(context);
  await enable(subject);
  await subject.query(`ALTER TABLE public.activation_members ADD CONSTRAINT reject_auth_fixture
    CHECK (uid <> '${owner}'::uuid) NOT VALID`);
  await assert.rejects(authFixture(subject), { code: '23514' });
  assert.deepEqual((await subject.query('SELECT id FROM auth.users')).rows, []);
  assert.deepEqual(await members(subject), []);
  await subject.exec('ALTER TABLE public.activation_members DROP CONSTRAINT reject_auth_fixture');
  await authFixture(subject);
  assert.equal((await members(subject)).length, 1);
});

const hour = 3600000;
const signupDay = new Date(Date.now() - 20 * 24 * hour).toISOString().slice(0, 10);
const signupStart = Date.parse(signupDay + 'T00:00:00Z');
const atHour = offset => new Date(signupStart + offset * hour).toISOString();
const fixtureUid = index => '10000000-0000-4000-8000-' + String(index).padStart(12, '0');

async function historicalClockFixture(subject, { production = false } = {}) {
  await subject.query(`UPDATE public.activation_config SET collection_enabled = true, export_enabled = true,
    source_mode = $1, consent_version = $2, permission_approved = true, source_verified = true,
    exclusions_verified = true, registration_flow_approved = $3, retention_approved = $3`,
  [production ? 'production' : 'local_test', version, production]);
  await subject.exec('ALTER TABLE public.activation_config DISABLE TRIGGER activation_config_epoch');
  await subject.query('UPDATE public.activation_config SET enabled_at = $1', [atHour(-1)]);
  await subject.exec('ALTER TABLE public.activation_config ENABLE TRIGGER activation_config_epoch');
}

async function cohortMemberFixture(subject, index, registeredHour, firstWorkoutHour = null, options = {}) {
  const uid = fixtureUid(index);
  await subject.query(`INSERT INTO public.billing_analytics_consent (uid, granted, version, captured_at)
    VALUES ($1, true, $2, $3)`, [uid, version, atHour(-2)]);
  await authFixture(subject, uid, { ...options, priorConsent: false, createdAt: atHour(registeredHour) });
  if (firstWorkoutHour !== null) {
    await subject.query(`UPDATE public.activation_members SET first_workout_at = $1, history_state = 'observing'
      WHERE uid = $2`, [atHour(firstWorkoutHour), uid]);
  }
  return uid;
}

async function watermark(subject, registration = 200, completion = registration) {
  await subject.query(`UPDATE public.activation_config SET registrations_complete_through = $1,
    workouts_complete_through = $2`, [registration === null ? null : atHour(registration), completion === null ? null : atHour(completion)]);
}

async function cohort(subject, publish = false, day = signupDay) {
  await subject.exec('SET ROLE service_role');
  try { return (await subject.query('SELECT public.get_activation_cohort($1::date, $2) AS result', [day, publish])).rows[0].result; }
  finally { await subject.exec('RESET ROLE'); }
}

test('Private SQL cohort arithmetic uses the same mature UTC signup cohort, includes non-activators and excludes the 168h boundary', async context => {
  const subject = await database(context);
  await historicalClockFixture(subject);
  await cohortMemberFixture(subject, 1, 0, 0);
  await cohortMemberFixture(subject, 2, 0, 168);
  await cohortMemberFixture(subject, 3, 1, 25);
  await cohortMemberFixture(subject, 4, 0, null);
  await cohortMemberFixture(subject, 5, 0, null, { cohort: 'internal' });
  await watermark(subject, 168);
  await subject.exec("SET TIME ZONE 'Asia/Kolkata'");
  const result = await cohort(subject);
  assert.equal(result.signup_day, signupDay);
  assert.equal(result.timezone, 'UTC');
  assert.equal(result.registered_members, 4);
  assert.equal(result.activation_eligible, 3);
  assert.equal(result.activation_completed, 1);
  assert.equal(result.activation_7d, 33.33);
  assert.equal(result.d1_return, null);
  assert.equal(result.d7_return, null);
  assert.equal(result.provider_verified_workout, false);
  assert.equal(result.workout_timestamp_source, 'server_acknowledgement');
  assert.equal(result.source_mode, 'local_test');
  assert.equal(result.publication, 'private_qa');
  assert.match(result.complete_through, /Z$/);
  assert.equal((await cohort(subject, true)).activation_7d, null);
});

test('Cohort reports server acknowledgement time and never substitutes the untrusted workout date at the 168h boundary', async context => {
  const subject = await database(context);
  assert.equal((await cohort(subject)).workout_timestamp_source, 'server_acknowledgement');
  await historicalClockFixture(subject);
  const inside = await cohortMemberFixture(subject, 1, 0, 167);
  const outside = await cohortMemberFixture(subject, 2, 0, 168);
  for (const [uid, dateHour, recordedHour] of [[inside, 168, 167], [outside, 144, 168]]) {
    await subject.query(`INSERT INTO public.activation_finalization_receipts (uid, request_id, workout_date, recorded_at)
      VALUES ($1, $2, $3::date, $4::timestamptz)`, [uid, otherOwner, atHour(dateHour).slice(0, 10), atHour(recordedHour)]);
  }
  await watermark(subject, 200);
  const result = await cohort(subject);
  assert.equal(result.workout_source, 'accounts.authenticated_finalization_receipt');
  assert.equal(result.workout_timestamp_source, 'server_acknowledgement');
  assert.equal(result.provider_verified_workout, false);
  assert.equal(result.activation_eligible, 2);
  assert.equal(result.activation_completed, 1);
  assert.equal(result.activation_7d, 50);
  assert.deepEqual(Object.keys(result).sort(), ['signup_day', 'timezone', 'source_mode', 'registration_source',
    'workout_source', 'workout_timestamp_source', 'provider_verified_workout', 'publication', 'status', 'complete_through',
    'registered_members', 'activation_eligible', 'activation_completed', 'activation_7d', 'd1_return', 'd7_return',
    'retention_source_status'].sort());
  const suppressed = await cohort(subject, true);
  assert.equal(suppressed.workout_timestamp_source, 'server_acknowledgement');
  assert.equal(suppressed.activation_7d, null);
});

test('Local-test source mode still requires the synthetic production cohort attestation and can never publish it', async context => {
  const subject = await database(context);
  await historicalClockFixture(subject);
  await cohortMemberFixture(subject, 1, 0, null, { cohort: 'local_test' });
  await cohortMemberFixture(subject, 2, 0, 1, { cohort: 'production' });
  await cohortMemberFixture(subject, 3, 0, null, { cohort: 'test',
    userMetadata: { activation: { cohort: 'production', history: 'native_only' } } });
  const enrolled = await members(subject);
  assert.equal(enrolled.length, 1);
  assert.equal(enrolled[0].uid, fixtureUid(2));
  assert.equal(enrolled[0].source_mode, 'local_test');
  await watermark(subject, 200);
  const privateResult = await cohort(subject);
  assert.equal(privateResult.source_mode, 'local_test');
  assert.equal(privateResult.activation_eligible, 1);
  assert.equal(privateResult.activation_completed, 1);
  const published = await cohort(subject, true);
  assert.equal(published.publication, 'suppressed');
  assert.equal(published.activation_eligible, null);
  assert.equal(published.activation_completed, null);
});

test('Missing feeds, incomplete first history, incomplete signup-day coverage and zero mature denominators do not become fake rates', async context => {
  const subject = await database(context);
  await historicalClockFixture(subject);
  await cohortMemberFixture(subject, 1, 1, 2);
  for (const [registration, completion] of [[null, 200], [200, null], [10, 200]]) {
    await watermark(subject, registration, completion);
    const result = await cohort(subject);
    assert.equal(result.status, 'incomplete');
    assert.equal(result.activation_completed, null);
    assert.equal(result.activation_eligible, null);
    assert.equal(result.activation_7d, null);
  }
  await watermark(subject, 168);
  const immature = await cohort(subject);
  assert.equal(immature.activation_eligible, 0);
  assert.equal(immature.activation_completed, 0);
  assert.equal(immature.activation_7d, null);
  await watermark(subject, 200);
  await subject.exec("UPDATE public.activation_members SET history_state = 'incomplete', incomplete_reason = 'initial_import'");
  assert.equal((await cohort(subject)).activation_completed, null);
  assert.equal((await cohort(subject, false, new Date(signupStart - 24 * hour).toISOString().slice(0, 10))).registered_members, null);
  await assert.rejects(subject.query('UPDATE public.activation_config SET workouts_complete_through = $1',
    [new Date(Date.now() + hour).toISOString()]), { code: '22023' });
});

test('Publication thresholds apply to same-source aggregates; small and complementary cells are suppressed', async context => {
  const subject = await database(context);
  await historicalClockFixture(subject, { production: true });
  for (let index = 1; index <= 30; index++) await cohortMemberFixture(subject, index, 0, index <= 8 ? 1 : null);
  await watermark(subject, 200);
  const result = await cohort(subject, true);
  assert.equal(result.registered_members, 30);
  assert.equal(result.activation_eligible, 30);
  assert.equal(result.activation_completed, 8);
  assert.equal(result.activation_7d, 26.67);
  assert.equal(result.publication, 'publishable');
  assert.doesNotMatch(JSON.stringify(result), /10000000|revision|uid|workoutLog|email/);
  await subject.query('UPDATE public.activation_members SET source_epoch = gen_random_uuid() WHERE uid = $1', [fixtureUid(30)]);
  const distinctSource = await cohort(subject, true);
  assert.equal(distinctSource.activation_eligible, 29);
  assert.equal(distinctSource.activation_7d, null);
  await subject.exec('UPDATE public.activation_members SET first_workout_at = registered_at');
  const complement = await cohort(subject, true);
  assert.equal(complement.activation_completed, null);
  assert.equal(complement.activation_7d, null);
});

test('Only the service aggregate RPC is granted; members cannot read rows, enroll a different uid, or set clocks and rollout flags', async context => {
  const subject = await database(context);
  for (const table of ['activation_config', 'activation_members', 'activation_finalization_receipts']) {
    await assert.rejects(asOwner(subject, owner, 'SELECT * FROM public.' + table), { code: '42501' });
    await subject.exec('SET ROLE service_role');
    await assert.rejects(subject.exec('SELECT * FROM public.' + table), { code: '42501' });
    await subject.exec('RESET ROLE');
  }
  await assert.rejects(asOwner(subject, owner, 'SELECT public.get_activation_cohort($1::date)', [signupDay]), { code: '42501' });
  await assert.rejects(asOwner(subject, owner, 'SELECT public._activation_verified_account($1::uuid)', [otherOwner]), { code: '42501' });
  await assert.rejects(asOwner(subject, owner, 'UPDATE public.activation_config SET collection_enabled = true'), { code: '42501' });
  assert.equal((await cohort(subject)).activation_completed, null);
  await assert.rejects(subject.exec(`UPDATE public.activation_config SET source_mode = 'production',
    collection_enabled = true, consent_version = 'billing-analytics-v1', permission_approved = true,
    source_verified = true, exclusions_verified = true`), { code: '23514' });
});

test('An unsafe prerequisite schema causes an atomic migration rejection without widening accounts access', async context => {
  const subject = await database(context, { activation: false });
  await subject.exec('ALTER TABLE public.accounts DISABLE ROW LEVEL SECURITY');
  await assert.rejects(subject.exec(sql('activation-events.sql')), /Expected private accounts/);
  await subject.exec('ROLLBACK');
  assert.equal((await subject.query("SELECT to_regclass('public.activation_config') AS object")).rows[0].object, null);
  assert.equal((await subject.query("SELECT has_table_privilege('anon', 'public.accounts', 'SELECT') AS allowed")).rows[0].allowed, false);
});

test('Actual client queues Save and Continue, finalizes after PGlite account acknowledgement, and never backfills signup', async context => {
  const subject = await database(context);
  await enable(subject);
  await authFixture(subject, owner, { priorConsent: false });
  const supabaseUrl = 'https://activation-fixture.invalid';
  const tokenExpiresAt = Math.floor(Date.now() / 1000) + 3600;
  const fixtureToken = uid => Buffer.from('{"alg":"HS256"}').toString('base64url') + '.'
    + Buffer.from(JSON.stringify({ sub: uid, role: 'authenticated', aud: 'authenticated',
      iss: supabaseUrl + '/auth/v1', exp: tokenExpiresAt })).toString('base64url') + '.fixture';
  const tokens = new Map([owner, otherOwner].map(uid => ['Bearer ' + fixtureToken(uid), uid]));
  let session = { owner, jwt: fixtureToken(owner), generation: 1 };
  const requests = [];
  const environment = vm.createContext({ URL, atob, AbortController, TextDecoder, setTimeout, clearTimeout });
  environment.window = environment;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/mod/measurement.js'), 'utf8'), environment);
  const client = environment.Measurement.create({ enabled: true, supabaseUrl, publishableKey: 'fixture-public-key',
    getSession: () => session,
    permissions: { [version]: { label: 'Fixture permission', description: 'Local SQL fixture only.',
      effectiveDate: '2026-01-01', reviewStatus: 'approved', scopes: ['billing', 'activation'] } },
    fetch: async (url, init) => {
      const uid = tokens.get(init.headers.Authorization);
      assert.ok(uid, 'Only registered synthetic JWTs can authenticate this offline fixture');
      assert.equal(init.headers.apikey, 'fixture-public-key');
      const body = JSON.parse(init.body);
      const method = new URL(url).pathname.split('/').at(-1);
      assert.ok(['get_billing_analytics_consent', 'set_billing_analytics_consent', 'record_workout_finalization'].includes(method));
      assert.deepEqual(Object.keys(body).sort(), method === 'record_workout_finalization'
        ? ['p_consent_revision', 'p_consent_version', 'p_request_id', 'p_workout_date']
        : method.startsWith('set_') ? ['p_granted', 'p_version'] : []);
      requests.push({ uid, method });
      const result = method === 'record_workout_finalization'
        ? await finalizeWorkout(subject, body.p_request_id, body.p_workout_date, uid,
          { version: body.p_consent_version, revision: body.p_consent_revision })
        : method.startsWith('set_') ? await consent(subject, uid, body.p_granted, body.p_version) : await lookup(subject, uid);
      return Response.json(result);
    }
  });
  assert.equal((await client.load()).consentState, 'unset');
  assert.equal((await client.setConsent(false)).denialAcknowledgement, 'confirmed');
  assert.equal((await client.setConsent(true)).granted, true);
  await saveAccount(subject, account());
  const finished = account([workout()]);
  const payload = { requestId: otherOwner, workoutDate: finished.workoutLog[0].date };
  assert.equal(client.scheduleWorkoutFinalization(payload), true);
  await saveAccount(subject, finished);
  const excluded = await client.flushWorkoutFinalizations({ owner, generation: 1, acknowledged: true, snapshot: finished });
  assert.equal(excluded[0].status, 'not_enrolled');
  assert.equal(excluded[0].confirmed, false);
  assert.equal((await registrationStatus(subject)).status, 'prior_consent_required');
  assert.deepEqual(await members(subject), []);
  assert.equal((await cohort(subject)).activation_eligible, null);
  await authFixture(subject, otherOwner);
  await saveAccount(subject, account(), otherOwner);
  client.reset();
  session = { owner: otherOwner, jwt: fixtureToken(otherOwner), generation: 2 };
  assert.equal((await client.load()).granted, true);
  const partial = account([workout(undefined, null)], { draftSession: { date: payload.workoutDate, session: { items: [] } } });
  await saveAccount(subject, partial, otherOwner);
  assert.equal((await members(subject))[0].first_workout_at, null);
  assert.equal(client.scheduleWorkoutFinalization(payload), true);
  assert.equal((await client.flushWorkoutFinalizations({ owner: otherOwner, generation: 2,
    acknowledged: true, snapshot: partial })).length, 0);
  let acknowledge;
  const acknowledgement = new Promise(resolve => { acknowledge = resolve; });
  const uploading = (async () => {
    const acknowledged = await acknowledgement;
    return client.flushWorkoutFinalizations({ owner: otherOwner, generation: 2, acknowledged, snapshot: finished });
  })();
  await saveAccount(subject, finished, otherOwner);
  assert.equal((await members(subject))[0].first_workout_at, null);
  assert.equal(requests.filter(request => request.method === 'record_workout_finalization').length, 1);
  assert.equal((await client.flushWorkoutFinalizations({ owner: otherOwner, generation: 2,
    acknowledged: false, snapshot: finished })).length, 0);
  acknowledge(true);
  const accepted = await uploading;
  assert.equal(accepted[0].confirmed, true);
  assert.equal((await client.flushWorkoutFinalizations({ owner: otherOwner, generation: 2,
    acknowledged: true, snapshot: finished })).length, 0);
  const registered = (await members(subject))[0];
  assert.ok(registered.first_workout_at);
  assert.deepEqual(Object.keys(registered).sort(), ['uid', 'source_epoch', 'source_mode', 'consent_version',
    'consent_revision', 'consent_captured_at', 'registered_at', 'first_workout_at', 'pending_workout_date',
    'history_state', 'incomplete_reason'].sort());
  assert.equal((await client.setConsent(false)).denialAcknowledgement, 'confirmed');
  assert.deepEqual(await members(subject), []);
  assert.deepEqual((await subject.query('SELECT * FROM public.activation_finalization_receipts')).rows, []);
  assert.equal((await lookup(subject, owner)).consent_state, 'granted');
  assert.deepEqual(requests.map(request => request.uid), [owner, owner, owner, owner, otherOwner, otherOwner, otherOwner]);
  client.reset();
  session = null;
  assert.equal((await client.load()).granted, false);
  assert.equal(requests.length, 7);
});