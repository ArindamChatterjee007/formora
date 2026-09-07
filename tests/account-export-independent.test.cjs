'use strict';
// Independent review probes for the T-109 "account_server_personal_v2" export projection.
//
// Written by an independent reviewer. These are NOT a re-run of the author's suites
// (tests/account-rights.test.cjs, tests/account-rights-client.test.cjs,
// tests/account-rights-data-scope.test.cjs) and deliberately avoid duplicating them.
// Every probe below targets a claim the author's titles do not already pin.
//
// Harness disclosure: PGlite (in-process Postgres) running the UNMODIFIED canonical
// migrations plus explicitly-labelled legacy contract fixtures. This is local evidence
// only: it is not hosted RLS, GoTrue, provider, real-device or production acceptance.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const AccountRights = require('../js/mod/account-rights.js');

const root = path.resolve(__dirname, '..');
const SCOPE = 'account_server_personal_v2';
const V1_SCOPE = 'account_profile_logs_v1';
const COVERAGE = { all_personal_data: false, known_source_schemas_available: true,
  legacy_aliases: 'not_verified', ownership: 'canonical_auth_uid_only',
  snapshot: 'single_sql_statement_before_preparation', media: 'public_url_references_only_no_bytes' };
const OWNER = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';
const OWNER_EMAIL = 'owner.466@example.test';
const SLUG = 'owner_466_example_test';
const TS = '2026-09-01T00:00:00Z';
const ref = n => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
const CANONICAL = ['security.sql', 'moderation-receipts.sql', 'billing-events.sql', 'analytics-outbox.sql',
  'activation-events.sql', 'story-interactions.sql', 'support-receipts.sql'];

let db;

test.before(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
    CREATE TABLE auth.users(id uuid PRIMARY KEY, email text, created_at timestamptz DEFAULT '${TS}',
      encrypted_password text, confirmation_token text, phone text, email_confirmed_at timestamptz,
      phone_confirmed_at timestamptz, updated_at timestamptz, last_sign_in_at timestamptz,
      deleted_at timestamptz, is_anonymous boolean DEFAULT false, raw_app_meta_data jsonb DEFAULT '{}');
    CREATE TABLE public.accounts(uid text PRIMARY KEY, data jsonb, updated_at timestamptz DEFAULT '${TS}');
    CREATE TABLE public.profiles(uid text PRIMARY KEY, data jsonb);
    CREATE TABLE public.posts(id text PRIMARY KEY, author text, data jsonb, likes jsonb, ts timestamptz);
    CREATE TABLE public.comments(id text PRIMARY KEY, post_id text, author text, body text, parent_id text, mentions jsonb, ts timestamptz);
    CREATE TABLE public.messages(id text PRIMARY KEY, from_uid text NOT NULL, to_uid text NOT NULL, body text NOT NULL, ts timestamptz NOT NULL);
    CREATE TABLE public.requests(id text PRIMARY KEY, from_uid text, to_uid text, status text, ts timestamptz);
    CREATE TABLE public.notifications(id text PRIMARY KEY, uid text, type text, actor text, post_id text, body text, read boolean, ts timestamptz);
    CREATE TABLE public.stories(id text PRIMARY KEY, author text, photo text, kind text, ts timestamptz);
    CREATE TABLE public.entitlements(uid text PRIMARY KEY, tier text NOT NULL DEFAULT 'free', status text NOT NULL DEFAULT 'inactive',
      provider text, subscription_id text, current_period_end timestamptz, updated_at timestamptz DEFAULT now());
    CREATE TABLE public.billing_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), uid text NOT NULL, type text NOT NULL, raw jsonb NOT NULL, created_at timestamptz DEFAULT now());
    CREATE TABLE public.support_tickets(id uuid PRIMARY KEY, uid text, email text, subject text, message text, tier text, status text, created_at timestamptz);
    CREATE TABLE public.report_evidence_holds(case_id uuid, hold_ref uuid);`);
  for (const file of CANONICAL) await db.exec(fs.readFileSync(path.join(root, 'supabase', file), 'utf8'));
  await db.exec(fs.readFileSync(path.join(root, 'supabase/account-rights.sql'), 'utf8'));
  await seed();
});
test.after(async () => { if (db) await db.close(); });

async function identity(uid = OWNER, role = 'authenticated') {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [uid]);
  await db.query("SELECT set_config('request.jwt.claims',$1,false)",
    [JSON.stringify({ sub: uid, email: uid === OWNER ? OWNER_EMAIL : uid + '@example.test',
      amr: [{ method: 'password', timestamp: Date.now() / 1000 }] })]);
  await db.exec('SET ROLE ' + role);
}
async function rpc(name, args = []) {
  return (await db.query('SELECT public.' + name + '(' + args.map((_, i) => '$' + (i + 1)).join(',') + ') AS result', args)).rows[0].result;
}
async function insert(table, row, schema = 'public') {
  const keys = Object.keys(row);
  await db.query(`INSERT INTO ${schema}.${table}(${keys.map(k => '"' + k + '"').join(',')}) VALUES(${keys.map((_, i) => '$' + (i + 1)).join(',')})`,
    keys.map(k => (row[k] && typeof row[k] === 'object' && !(row[k] instanceof Uint8Array) ? JSON.stringify(row[k]) : row[k])));
}
async function submit(scope = SCOPE) {
  return rpc('submit_account_rights_request', [randomUUID(), 'export',
    JSON.stringify({ schema_version: scope === SCOPE ? 2 : 1, scope })]);
}
async function exported(receipt) {
  const operation = randomUUID();
  const header = await rpc('prepare_account_rights_export', [receipt.id, receipt.version, operation]);
  const chunks = []; let offset = 0;
  while (offset < header.total_bytes) {
    const page = await rpc('read_account_rights_export', [receipt.id, offset, 32768]);
    chunks.push(Buffer.from(page.chunk_base64, 'base64')); offset = page.next_offset;
  }
  const bytes = Buffer.concat(chunks);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), header.sha256, 'server digest covers the delivered bytes');
  return { header, bytes, content: JSON.parse(bytes.toString('utf8')), operation };
}

// Hostile-content sentinels. Each is stored verbatim in an OWNED row and must survive
// the dynamically-assembled single statement byte-for-byte without terminating it.
const HOSTILE = {
  caption: `'); DROP TABLE public.accounts; --`,
  comment: `$function$ SELECT 1 $function$ %L %I %s`,
  message: `" or 1=1 -- \\' ${'\u2028'}</script><img src=x onerror=alert(1)>`,
  key: `weird"key%s'`
};
const FOREIGN = 'FOREIGN-ONLY-SENTINEL';

async function seed() {
  await db.exec('RESET ROLE');
  for (const [uid, phone] of [[OWNER, '+10000000001'], [PEER, '+10000000002'], [THIRD, '+10000000003']]) {
    await insert('users', { id: uid, email: uid === OWNER ? OWNER_EMAIL : uid + '@example.test', encrypted_password: FOREIGN + '-password',
      confirmation_token: FOREIGN + '-token', phone, raw_app_meta_data: { secret: FOREIGN + '-meta' } }, 'auth');
  }
  await insert('accounts', { uid: OWNER, data: { profile: { name: 'Owner account' },
    weightLog: [{ date: '2026-09-01', kg: 70 }], [HOSTILE.key]: 'ignored-unknown-field' } });
  await insert('accounts', { uid: PEER, data: { profile: { name: FOREIGN + '-account' } } });
  // Legacy email-slug row: the historical client identity shape, retained on the server.
  await insert('accounts', { uid: SLUG, data: { profile: { name: 'LEGACY-SLUG-ACCOUNT' } } });
  await insert('profiles', { uid: OWNER, data: { name: 'Owner profile', bio: HOSTILE.caption } });
  await insert('profiles', { uid: PEER, data: { name: FOREIGN + '-profile' } });
  await insert('posts', { id: 'owner-post', author: OWNER, ts: TS, likes: { [OWNER]: true, [THIRD]: true },
    data: { text: HOSTILE.caption, photo: 'https://fixture.invalid/p.jpg' } });
  await insert('posts', { id: 'peer-post', author: PEER, ts: TS, likes: { [OWNER]: true }, data: { text: FOREIGN + '-post' } });
  await insert('comments', { id: 'owner-comment', post_id: 'peer-post', author: OWNER, body: HOSTILE.comment, ts: TS });
  await insert('comments', { id: 'peer-comment', post_id: 'owner-post', author: PEER, body: FOREIGN + '-comment', ts: TS });
  for (const [id, from, to, body] of [['m1', OWNER, PEER, HOSTILE.message], ['m2', PEER, OWNER, 'peer replied to owner'],
    ['m3', PEER, THIRD, FOREIGN + '-message']]) await insert('messages', { id, from_uid: from, to_uid: to, body, ts: TS });
  for (const [id, from, to] of [['r1', OWNER, PEER], ['r2', PEER, THIRD]]) {
    await insert('requests', { id, from_uid: from, to_uid: to, status: 'accepted', ts: TS });
  }
  await insert('notifications', { id: 'n1', uid: OWNER, type: 'comment', actor: THIRD, post_id: 'owner-post',
    body: FOREIGN + '-notification-prose', read: false, ts: TS });
  await insert('notifications', { id: 'n2', uid: PEER, type: 'like', actor: THIRD, post_id: 'peer-post', body: FOREIGN + '-prose', read: true, ts: TS });
  await insert('stories', { id: 's1', author: OWNER, photo: 'https://fixture.invalid/s1.jpg', kind: 'photo', ts: TS });
  await insert('stories', { id: 's2', author: PEER, photo: 'https://fixture.invalid/s2.jpg', kind: 'photo', ts: TS });
  for (const [id, uid] of [[ref(1), OWNER], [ref(2), PEER]]) {
    await insert('stories_v2', { id, owner: uid, kind: 'photo', audience: 'authenticated', created_at: TS, expires_at: '2026-09-02T00:00:00Z' });
    await insert('story_content', { story_id: id, media_url: 'https://fixture.invalid/' + id + '.jpg' });
  }
  await insert('story_interactions', { story_id: ref(2), viewer: OWNER, qualified_at: TS, liked: true });
  await insert('story_interactions', { story_id: ref(1), viewer: THIRD, qualified_at: TS, liked: true });
  await insert('story_blocks', { blocker: OWNER, blocked: PEER });
  await insert('story_notification_preferences', { uid: OWNER, likes: true });
  await insert('story_notifications', { id: ref(3), recipient: OWNER, actor: THIRD, story_id: ref(1), kind: 'like', request_id: ref(4) });
  await insert('story_reports', { id: ref(5), reporter: OWNER, story_id: ref(2), reported_uid: PEER, reason: 'owner concern' });
  await insert('story_reports', { id: ref(6), reporter: THIRD, story_id: ref(1), reported_uid: OWNER, reason: FOREIGN + '-story-report' });
  await insert('support_cases', { id: ref(7), owner: OWNER, request_id: ref(8), subject: 'Owner subject', payload_digest: 'a'.repeat(32) });
  await insert('support_cases', { id: ref(9), owner: PEER, request_id: ref(10), subject: FOREIGN + '-support', payload_digest: 'b'.repeat(32) });
  await insert('support_messages', { id: ref(11), case_id: ref(7), author: OWNER, author_role: 'member', visibility: 'thread',
    body: 'Owner support message', request_id: ref(111), case_version: 1 });
  await insert('support_messages', { id: ref(12), case_id: ref(7), author: THIRD, author_role: 'staff', visibility: 'internal',
    body: FOREIGN + '-internal-note', request_id: ref(112), case_version: 1 });
  await insert('support_tickets', { id: ref(13), uid: OWNER, email: OWNER + '@example.test', subject: 'Owner legacy',
    message: 'Owner legacy body', tier: 'free', status: 'open', created_at: TS });
  await insert('report_cases', { id: ref(14), reporter: OWNER, request_id: ref(15), kind: 'post', target_id: 'peer-post',
    reported_uid: PEER, reason: 'owner report reason' });
  // The owner is the SUBJECT of this report; it must never appear in the owner's export.
  await insert('report_cases', { id: ref(16), reporter: THIRD, request_id: ref(17), kind: 'post', target_id: 'owner-post',
    reported_uid: OWNER, reason: FOREIGN + '-subject-report' });
  await insert('analytics_billing_sources', { source_id: ref(18), provider: 'razorpay', account_id: 'acc_fixture' });
  let n = 20;
  for (const uid of [OWNER, PEER]) {
    const i = (n += 10);
    await insert('billing_analytics_consent', { uid, granted: true, version: 'v1', revision: ref(i), captured_at: TS });
    await insert('activation_members', { uid, source_epoch: ref(18), source_mode: 'local_test', consent_version: 'v1',
      consent_revision: ref(i), consent_captured_at: TS, registered_at: TS, history_state: 'observing' });
    await insert('activation_finalization_receipts', { uid, request_id: ref(i + 1), workout_date: '2026-09-02', recorded_at: '2026-09-02T00:00:00Z' });
    await insert('entitlements', { uid, tier: 'elite', status: 'active', provider: 'razorpay', subscription_id: 'order_' + i });
    await insert('billing_event_receipts', { provider: 'razorpay', event_id: 'evt_' + i, uid, occurred_at: TS,
      reference: 'order_' + i, status: 'active', input_digest: Uint8Array.of(1), applied: true });
    await insert('billing_events', { id: ref(i + 2), uid, type: 'payment.captured', raw: { secret: FOREIGN + '-webhook-secret' } });
    await insert('analytics_outbox', { event_id: ref(i + 3), uid, receipt_provider: 'razorpay', receipt_event_id: 'evt_' + i,
      source_id: ref(18), dedupe_key: Uint8Array.of(i), consent_revision: ref(i), consent_version: 'v1', consent_captured_at: TS,
      event_name: 'purchase_confirmed', occurred_at: TS, tier: 'elite', rail: 'upi', currency: 'INR', amount_minor: 100,
      billing_mode: 'live', state: 'leased', attempts: 1, lease_token: THIRD, lease_until: '2026-09-07T00:00:00Z' });
    await insert('story_action_receipts', { actor: uid, request_id: ref(i + 4), action: 'like', payload_digest: 'c'.repeat(64),
      response: { cached: FOREIGN + '-story-cached-response' } });
  }
  // Legacy slug-keyed entitlement, i.e. the historical uid the client used before the UUID cutover.
  await insert('entitlements', { uid: SLUG, tier: 'elite', status: 'active', provider: 'razorpay', subscription_id: 'order_legacy_slug' });
}

// --------------------------------------------------------------------------- probes

test('P1: a fully populated peer account contributes no byte, no join row and no subject-report to the owner archive', async () => {
  await identity();
  const { content, bytes } = await exported(await submit());
  const text = bytes.toString('utf8');

  assert.equal(content.source_inventory.length, 32);
  assert.equal(new Set(content.source_inventory.map(source => source.source)).size, 30,
    'the recorded 32-projection / 30-relation contract holds: auth.users and public.posts each back two projections');
  assert.deepEqual(content.coverage, COVERAGE);
  assert.doesNotMatch(text, new RegExp(FOREIGN), 'no foreign-only sentinel survives any of the 32 projections');

  // Join-shaped sources must not walk back out to the peer's parent rows.
  assert.deepEqual(content.data.story_content.map(row => row.story_id), [ref(1)]);
  assert.deepEqual(content.data.support_messages.map(row => row.id), [ref(11)]);
  assert.deepEqual(content.data.support_messages.map(row => row.visibility), ['thread']);
  assert.deepEqual(content.data.reports.map(row => row.id), [ref(14)], 'reports where the owner is only the SUBJECT are excluded');
  assert.equal(Object.hasOwn(content.data.story_reports[0], 'reported_uid'), false);
  assert.equal(Object.hasOwn(content.data.story_notifications[0], 'actor'), false);
  assert.equal(Object.hasOwn(content.data.notifications[0], 'actor'), false);
  assert.equal(Object.hasOwn(content.data.notifications[0], 'body'), false);
  assert.equal(content.source_inventory.find(source => source.id === 'story_actions').source, 'public.story_action_receipts');
  assert.deepEqual(content.projection.story_actions, { actor: 'uuid', request_id: 'uuid', action: 'string', created_at: 'timestamp' });
  assert.deepEqual(Object.keys(content.data.story_actions[0]).sort(), ['action', 'actor', 'created_at', 'request_id']);
  assert.doesNotMatch(JSON.stringify({ projection: content.projection, data: content.data }), /"(?:payload_digest|lease_token|archive_text|response)"\s*:/);

  // Participant sources keep only rows the owner could already read, both directions.
  assert.deepEqual(content.data.messages.map(row => row.id).sort(), ['m1', 'm2']);
  assert.deepEqual(content.data.connections.map(row => row.id), ['r1']);
  // post_reactions discloses the owner's own like on a peer post but no other liker and no post body.
  assert.deepEqual(content.data.post_reactions.map(row => row.post_id).sort(), ['owner-post', 'peer-post']);
  assert.ok(content.data.post_reactions.every(row => row.viewer === OWNER && row.liked === true));
  assert.deepEqual(Object.keys(content.data.post_reactions[0]).sort(), ['liked', 'post_id', 'viewer']);
});

test('P2: SQL metacharacters, dollar quotes and format specifiers stored in owned rows round-trip byte-exactly', async () => {
  await identity();
  const { content } = await exported(await submit());
  assert.equal(content.data.posts[0].data.text, HOSTILE.caption);
  assert.equal(content.data.profile[0].data.bio, HOSTILE.caption);
  assert.equal(content.data.comments[0].body, HOSTILE.comment);
  assert.equal(content.data.messages.find(row => row.id === 'm1').body, HOSTILE.message);
  // An unknown jsonb key whose NAME carries metacharacters is dropped by the allowlist, not executed.
  assert.equal(Object.hasOwn(content.data.account[0].state, HOSTILE.key), false);
  await db.exec('RESET ROLE');
  assert.equal((await db.query('SELECT count(*)::integer AS count FROM accounts')).rows[0].count, 3, 'no injected statement ran');
});

test('P3: a source replaced by a view or drifted column reports unavailable with null data, never an empty collection', async () => {
  await db.exec(`RESET ROLE;
    ALTER TABLE public.notifications RENAME TO notifications_backing;
    CREATE VIEW public.notifications AS SELECT * FROM public.notifications_backing;
    ALTER TABLE public.entitlements ALTER COLUMN current_period_end TYPE text USING current_period_end::text;`);
  try {
    await identity();
    const { content } = await exported(await submit());
    const view = content.source_inventory.find(s => s.id === 'notifications');
    const drift = content.source_inventory.find(s => s.id === 'entitlements');
    assert.equal(view.available, false);
    assert.equal(view.status, 'missing_table', 'a readable VIEW over the real rows is still reported as a missing table');
    assert.deepEqual(view.missing_columns, ['public.notifications']);
    assert.equal(view.matched_rows, null);
    assert.equal(content.data.notifications, null, 'unavailable is null, never [] (which would read as "you have none")');
    assert.equal(drift.status, 'schema_mismatch');
    assert.deepEqual(drift.missing_columns, ['public.entitlements.current_period_end']);
    assert.equal(content.data.entitlements, null);
    assert.deepEqual(content.coverage, { ...COVERAGE, known_source_schemas_available: false });
    // The owner's story_blocks row still exports, so this is a per-source, not whole-archive, downgrade.
    assert.equal(content.data.story_blocks.length, 1);
  } finally {
    await db.exec(`RESET ROLE; DROP VIEW public.notifications;
      ALTER TABLE public.notifications_backing RENAME TO notifications;
      ALTER TABLE public.entitlements ALTER COLUMN current_period_end TYPE timestamptz USING current_period_end::timestamptz;`);
  }
});

test('P4: the operator preview names the real Story action source without payload, lease or archive keys', async () => {
  await identity();
  const request = await rpc('submit_account_rights_request',
    [randomUUID(), 'erasure', JSON.stringify({ schema_version: 1, scope: 'account_erasure_review_v1', confirmed: true })]);
  await identity(OWNER, 'service_role');
  const preview = await rpc('preview_account_rights_erasure', [request.id, OWNER, randomUUID()]);
  const serialized = JSON.stringify(preview);

  const storyActions = preview.inventory.find(row => row.category === 'story_actions');
  assert.equal(storyActions.source, 'public.story_action_receipts');
  assert.equal(storyActions.available, true);
  assert.equal(storyActions.matched_rows, 1);
  assert.doesNotMatch(serialized, /payload_digest|lease_token|archive_text|response|cached/);
  assert.equal(preview.execution_allowed, false);
  assert.equal(preview.execution_blocker, 'approved_policy_specific_erasure_executor_not_implemented');
  assert.ok(preview.inventory.every(row => row.deletion_authorized === false && row.source_execution_allowed === false));
});

test('P5: schema availability can be true while email-matching legacy rows stay unverified and excluded', async () => {
  await identity();
  const { content, bytes } = await exported(await submit());
  assert.equal(content.data.identity[0].email, OWNER_EMAIL);
  assert.doesNotMatch(bytes.toString('utf8'), /LEGACY-SLUG-ACCOUNT|order_legacy_slug/);
  assert.equal(content.data.account.length, 1);
  assert.equal(content.data.account[0].uid, OWNER);
  assert.equal(content.data.entitlements.length, 1);
  assert.deepEqual(content.coverage, COVERAGE,
    'available schemas do not verify aliases or authorize email-derived ownership');
  await db.exec('RESET ROLE');
  assert.deepEqual((await db.query('SELECT (SELECT count(*)::integer FROM accounts WHERE uid=$1) AS accounts, (SELECT count(*)::integer FROM entitlements WHERE uid=$1) AS entitlements', [SLUG])).rows[0],
    { accounts: 1, entitlements: 1 }, 'email-matching rows remain stored without guessing they are owned');
  assert.ok(content.exclusions.some(line => /legacy aliases/.test(line)));
  assert.equal(content.source_inventory.some(source => /slug|alias/.test(source.id)), false);
});

test('P6: the cached archive is immutable, captures rights history before its own commit, and claims no erasure', async () => {
  await identity();
  const receipt = await submit();
  const before = await exported(receipt);
  const captured = before.content.data.rights_requests.find(row => row.id === receipt.id);
  assert.equal(captured.status, 'received');
  assert.equal(captured.snapshot_status, 'not_prepared');
  assert.ok(captured.version < before.header.receipt.version, 'the archive predates its own export_ready transition');
  assert.equal(before.content.data.rights_actions.some(row => row.request_ref === receipt.id && row.action === 'export_ready'), false);
  assert.ok(before.content.data.rights_requests.every(row => row.account_deleted === false && row.execution_allowed === false));

  await db.exec("RESET ROLE; UPDATE accounts SET data='{\"profile\":{\"name\":\"CHANGED AFTER PREPARE\"}}' WHERE uid='" + OWNER + "'");
  await db.exec("DELETE FROM messages WHERE id='m1'");
  await identity();
  // A retried preparation with the ORIGINAL operation id must return the same header, and
  // the chunks must still be the pre-edit bytes.
  assert.deepEqual(await rpc('prepare_account_rights_export', [receipt.id, receipt.version, before.operation]), before.header);
  const chunks = []; let offset = 0;
  while (offset < before.header.total_bytes) {
    const page = await rpc('read_account_rights_export', [receipt.id, offset, 32768]);
    chunks.push(Buffer.from(page.chunk_base64, 'base64')); offset = page.next_offset;
  }
  assert.deepEqual(Buffer.concat(chunks), before.bytes, 're-reading the same request returns the identical immutable bytes');
  assert.doesNotMatch(Buffer.concat(chunks).toString('utf8'), /CHANGED AFTER PREPARE/);
  await db.exec('RESET ROLE');
  await db.query('UPDATE accounts SET data=$2 WHERE uid=$1',
    [OWNER, JSON.stringify({ profile: { name: 'Owner account' }, weightLog: [{ date: '2026-09-01', kg: 70 }], [HOSTILE.key]: 'ignored-unknown-field' })]);
  await insert('messages', { id: 'm1', from_uid: OWNER, to_uid: PEER, body: HOSTILE.message, ts: TS });
});

test('P7: the real UI defaults to v1 and the v2 request version is chosen at runtime, not by SQL shape alone', async () => {
  const { document, container } = fakeDom();
  const calls = [];
  const api = AccountRights.create({
    enabled: true, url: 'https://fixture.invalid', anonKey: 'public-fixture-key',
    getAuth: () => ({ active: () => true, uid: () => OWNER, token: async () => 'synthetic-token' }),
    storage: memoryStorage(),
    fetch: async (url, options) => {
      if (url.endsWith('/auth/v1/user')) return json({ id: OWNER });
      const name = url.split('/').at(-1), body = JSON.parse(options.body);
      calls.push({ name, body });
      await identity();
      if (name === 'submit_account_rights_request') {
        return json(await rpc(name, [body.p_request_id, body.p_kind, JSON.stringify(body.p_payload)]));
      }
      if (name === 'my_account_rights_requests') return json(await rpc(name, [body.p_before, body.p_before_id, body.p_limit]));
      throw new Error('unexpected route ' + name);
    }
  });
  try {
    assert.equal(await api.open(container), true);
    const select = container.find(node => node.tag === 'select');
    assert.ok(select, 'the export scope control is rendered');
    assert.deepEqual(select.children.map(option => option.value), [V1_SCOPE, SCOPE]);
    assert.equal(select.value, V1_SCOPE, 'the default selection is the v1 scope');

    const request = container.find(node => node.tag === 'button' && node.text() === 'Request export');
    await request.click();
    const first = calls.filter(call => call.name === 'submit_account_rights_request').at(-1);
    assert.deepEqual(first.body.p_payload, { schema_version: 1, scope: V1_SCOPE });

    select.value = SCOPE;
    select.fire('change');
    await request.click();
    const second = calls.filter(call => call.name === 'submit_account_rights_request').at(-1);
    assert.deepEqual(second.body.p_payload, { schema_version: 2, scope: SCOPE },
      'the opt-in v2 request version travels from the actual control to the actual RPC body');
    assert.notEqual(second.body.p_request_id, first.body.p_request_id, 'each scope keeps its own retry identity');

    const before = calls.length;
    await assert.rejects(api.requestExport('account_all_data_v3'), error => error.code === 'invalid_request');
    assert.equal(calls.length, before, 'an unsupported scope never reaches the transport');
  } finally { api.destroy(); document.reset(); }
});

test('P8: the mounted v2 scope note discloses shared messages and IDs, canonical ownership and unverified aliases', async () => {
  await identity();
  const { content } = await exported(await submit());
  const peers = new Set();
  for (const row of content.data.messages) for (const uid of [row.from_uid, row.to_uid]) if (uid !== OWNER) peers.add(uid);
  for (const row of content.data.connections) for (const uid of [row.from_uid, row.to_uid]) if (uid !== OWNER) peers.add(uid);
  assert.deepEqual([...peers], [PEER], 'the archive carries another member identifier and their message bodies');
  assert.equal(content.data.messages.some(row => row.from_uid === PEER && row.body === 'peer replied to owner'), true);
  const { document, container } = fakeDom();
  const api = AccountRights.create({ enabled: true,
    getAuth: () => ({ active: () => true, uid: () => OWNER }), storage: memoryStorage() });
  try {
    assert.equal(api.mount(container), true);
    const select = container.find(node => node.tag === 'select');
    const scopeNote = container.find(node => node.tag === 'p' && node.textContent.startsWith('Export scope:'));
    const v1Note = scopeNote.textContent;
    assert.equal(select.value, V1_SCOPE);
    select.value = SCOPE; select.fire('change');
    assert.match(scopeNote.textContent, /canonical Auth UID only, not legacy aliases; alias ownership is not verified/);
    assert.match(scopeNote.textContent, /Schema availability recorded for each source does not mean complete data coverage/);
    assert.match(scopeNote.textContent, /Authorized shared conversations include other participants' messages and IDs/);
    assert.match(scopeNote.textContent, /not an export of all personal data/);
    assert.match(scopeNote.textContent, /restricted third-party records outside those shared conversations are excluded/);
    select.value = V1_SCOPE; select.fire('change');
    assert.equal(scopeNote.textContent, v1Note);
  } finally { api.destroy(); document.reset(); }
});

test('P9: the collector runs with definer rights, so an explicit owner filter is the only barrier left', async () => {
  await db.exec('RESET ROLE');
  const policies = (await db.query("SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='posts'")).rows;
  for (const row of policies) await db.exec('DROP POLICY "' + row.policyname + '" ON public.posts');
  await db.exec('ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY');
  try {
    await identity();
    const direct = await db.query('SELECT count(*)::integer AS count FROM public.posts');
    assert.equal(direct.rows[0].count, 0, 'control: with no policy the authenticated caller reads nothing directly');
    const { content } = await exported(await submit());
    assert.deepEqual(content.data.posts.map(row => row.id), ['owner-post'],
      'the export still returns owned posts: RLS is not, and cannot be, the backstop for these projections');
    assert.equal(content.source_inventory.find(source => source.id === 'posts').available, true);
  } finally {
    // Restore the fixture: this probe intentionally destroyed the canonical posts policies,
    // so leave RLS off rather than invent a replacement policy body.
    await db.exec('RESET ROLE; ALTER TABLE public.posts DISABLE ROW LEVEL SECURITY');
  }
});

// ------------------------------------------------------------------- tiny helpers

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function memoryStorage() {
  const store = new Map();
  return { getItem: key => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) };
}

// A deliberately small DOM: only what js/mod/account-rights.js actually touches.
function fakeDom() {
  const previous = { document: globalThis.document };
  const make = tag => {
    const node = {
      tag, children: [], listeners: {}, dataset: {}, style: { cssText: '' }, attributes: {},
      textContent: '', className: '', id: '', value: '', disabled: false, checked: false, nodeType: 1, parent: null,
      ownerDocument: null,
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; },
      append(...nodes) { for (const child of nodes) { if (child && child.nodeType) { child.parent = this; this.children.push(child); } } },
      replaceChildren(...nodes) { for (const child of this.children) child.parent = null; this.children = []; this.append(...nodes); },
      remove() { if (this.parent) { this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; } },
      focus() {},
      addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
      removeEventListener(type, handler) { this.listeners[type] = (this.listeners[type] || []).filter(entry => entry !== handler); },
      fire(type) { return (this.listeners[type] || []).map(handler => handler({ type, target: this, preventDefault() {} })); },
      async click() { const results = this.fire('click'); await Promise.all(results.map(value => Promise.resolve(value).catch(() => {}))); },
      descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); },
      find(predicate) { return this.descendants().find(predicate); },
      contains(node) { return node === this || this.descendants().includes(node); },
      querySelectorAll(selector) {
        const tags = selector.split(',').map(part => part.trim());
        return this.descendants().filter(child => tags.includes(child.tag));
      },
      text() { return this.textContent || this.descendants().map(child => child.textContent).join(''); }
    };
    return node;
  };
  const document = { createElement: make, body: make('body'), reset() { globalThis.document = previous.document; } };
  const container = make('div');
  container.ownerDocument = document;
  globalThis.document = document;
  return { document, container };
}
