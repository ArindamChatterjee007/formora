'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/account-rights.sql'), 'utf8');
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const payloads = {
  export: { schema_version: 1, scope: 'account_profile_logs_v1' },
  erasure: { schema_version: 1, scope: 'account_erasure_review_v1', confirmed: true }
};
let db;

test.before(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE ROLE public_probe;
    CREATE SCHEMA auth; GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role, public_probe;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
    CREATE TABLE auth.users(id uuid PRIMARY KEY, email text, created_at timestamptz DEFAULT clock_timestamp(), encrypted_password text);
    CREATE TABLE public.accounts(uid text PRIMARY KEY, data jsonb, updated_at timestamptz DEFAULT clock_timestamp());
    CREATE TABLE public.profiles(uid text PRIMARY KEY, data jsonb);
    CREATE TABLE public.report_cases(id uuid PRIMARY KEY, reporter uuid, reported_uid text, reason text);
    CREATE TABLE public.report_evidence_holds(case_id uuid, hold_ref uuid);
    INSERT INTO public.accounts(uid,data) VALUES ('${owner}','{"profile":{"name":"Synthetic A"},"weightLog":[{"date":"2026-09-01","kg":70}]}'),
      ('${other}','{"profile":{"name":"Synthetic B"},"private":"untouched-other-account"}');
    INSERT INTO public.profiles VALUES ('${owner}','{"name":"Synthetic A","following":["${other}"]}'),
      ('${other}','{"name":"Synthetic B","bio":"not-for-export"}');`);
  await db.exec(migration);
});
test.after(async () => { if (db) await db.close(); });

async function identity(uid = owner, role = 'authenticated') {
  await db.exec('RESET ROLE');
  if (uid) await db.query("INSERT INTO auth.users(id,email,encrypted_password) VALUES ($1,$2,'never-export-credentials') ON CONFLICT DO NOTHING", [uid, uid + '@example.test']);
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [uid || '']);
  await db.query("SELECT set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: uid, amr: [{ method: 'password', timestamp: Date.now() / 1000 }] })]);
  await db.exec('SET ROLE ' + role);
}
async function rpc(name, args = []) {
  return (await db.query('SELECT public.' + name + '(' + args.map((value, index) => '$' + (index + 1)).join(',') + ') AS result', args)).rows[0].result;
}
async function submit(kind = 'export', request = randomUUID(), payload = payloads[kind]) {
  return rpc('submit_account_rights_request', [request, kind, JSON.stringify(payload)]);
}

test('owner-authenticated requests have durable UUID receipts, server identity/time and exact retries', async () => {
  await identity();
  const request = randomUUID(), before = Date.now(), first = await submit('export', request);
  assert.equal(first.requester, owner);
  assert.equal(first.request_id, request);
  assert.equal(first.kind, 'export');
  assert.equal(first.status, 'received');
  assert.equal(first.account_deleted, false);
  assert.equal(first.version, 1);
  assert.ok(Date.parse(first.created_at) >= before - 1000);
  assert.deepEqual(await submit('export', request), first);
  assert.deepEqual(await rpc('my_account_rights_request', [first.id]), first);
  await assert.rejects(submit('erasure', request), { code: 'PT409' });
  await db.exec('RESET ROLE');
  const actions = (await db.query('SELECT * FROM account_rights_actions WHERE request_ref=$1', [first.id])).rows;
  assert.equal(actions.length, 1);
  assert.equal(actions[0].actor_id, owner);
  assert.equal(actions[0].actor_role, 'authenticated');
});

test('public receipts keep their exact contract while internal report-hold epochs survive hold changes', async () => {
  const requestOwner = randomUUID(), caseId = randomUUID(), holdRef = randomUUID();
  const receiptKeys = ['id', 'request_id', 'requester', 'kind', 'scope', 'status', 'version', 'created_at', 'updated_at',
    'cancel_allowed', 'account_deleted', 'execution_allowed', 'snapshot_status', 'release_allowed', 'hold_status', 'hold_version'].sort();
  await identity(requestOwner);
  const first = await submit();
  assert.deepEqual(Object.keys(first).sort(), receiptKeys);
  await db.exec('RESET ROLE');
  const before = await rpc('account_rights_hold_state', [requestOwner]);
  assert.equal(before.report_hold_version, 0);
  await db.query('INSERT INTO report_cases(id,reporter,reported_uid) VALUES ($1,$2,$3)', [caseId, requestOwner, other]);
  await db.query('INSERT INTO report_evidence_holds(case_id,hold_ref) VALUES ($1,$2)', [caseId, holdRef]);
  const held = await rpc('account_rights_hold_state', [requestOwner]);
  assert.equal(held.hold_status, 'held');
  assert.ok(held.report_hold_version > before.report_hold_version);
  await identity(requestOwner);
  const publicHeld = await rpc('my_account_rights_request', [first.id]);
  assert.deepEqual(Object.keys(publicHeld).sort(), receiptKeys);
  assert.equal(publicHeld.hold_status, 'held');
  assert.equal(publicHeld.cancel_allowed, false);
  await db.exec('RESET ROLE');
  await db.query('DELETE FROM report_evidence_holds WHERE case_id=$1 AND hold_ref=$2', [caseId, holdRef]);
  const released = await rpc('account_rights_hold_state', [requestOwner]);
  assert.equal(released.hold_status, 'clear');
  assert.ok(released.report_hold_version > held.report_hold_version);
  await identity(requestOwner);
  const publicReleased = await rpc('my_account_rights_request', [first.id]);
  assert.deepEqual(Object.keys(publicReleased).sort(), receiptKeys);
  assert.equal(publicReleased.cancel_allowed, true);
});

test('PUBLIC and anonymous callers, missing identity and other owners cannot obtain private receipts', async () => {
  await identity(); const first = await submit('erasure');
  for (const role of ['public_probe', 'anon', 'service_role']) {
    await identity(owner, role);
    await assert.rejects(submit(), { code: '42501' });
    await assert.rejects(rpc('my_account_rights_request', [first.id]), { code: '42501' });
    await assert.rejects(db.query('SELECT * FROM account_rights_requests'), { code: '42501' });
  }
  await identity(null); await assert.rejects(submit(), { code: 'PT401' });
  await identity(other);
  await assert.rejects(rpc('my_account_rights_request', [first.id]), { code: 'PT404' });
  await assert.rejects(rpc('cancel_account_rights_request', [first.id, 1, randomUUID()]), { code: 'PT404' });
  assert.deepEqual((await rpc('my_account_rights_requests')).items, []);
  await assert.rejects(db.query('SELECT * FROM account_rights_actions'), { code: '42501' });
});

test('versioned server-personal requests do not relabel v1 receipts or reuse their retry identity', async () => {
  await identity(randomUUID());
  const legacy = await submit(), request = randomUUID();
  const expanded = { schema_version: 2, scope: 'account_server_personal_v2' };
  const current = await submit('export', request, expanded);
  assert.equal(current.scope, expanded.scope);
  assert.equal(current.execution_allowed, false);
  assert.deepEqual(await submit('export', request, expanded), current);
  assert.equal((await rpc('my_account_rights_request', [legacy.id])).scope, payloads.export.scope);
  await assert.rejects(submit('export', legacy.request_id, expanded), { code: 'PT409' });
  await assert.rejects(submit('export', request), { code: 'PT409' });
  for (const payload of [{ ...expanded, schema_version: 1 }, { ...payloads.export, schema_version: 2 },
    { ...expanded, all_personal_data: true }, { ...expanded, scope: 'account_all_data_v2' }]) {
    await assert.rejects(submit('export', randomUUID(), payload), { code: '22023' });
  }
});

test('malformed, oversized and forged JSON and unconfirmed erasure requests are rejected', async () => {
  await identity();
  for (const bad of [null, [], {}, { ...payloads.erasure, confirmed: false }, { ...payloads.erasure, confirmed: 'true' },
    { ...payloads.erasure, owner_id: other }, { ...payloads.erasure, created_at: '2000-01-01' },
    { ...payloads.erasure, notes: 'x'.repeat(3000) }]) {
    await assert.rejects(submit('erasure', randomUUID(), bad), { code: '22023' });
  }
  await assert.rejects(submit('delete', randomUUID(), {}), { code: '22023' });
  await assert.rejects(submit('export', 'not-a-uuid'), { code: '22P02' });
});

test('cancellation is same-owner, versioned, audited, retryable and never reports deletion', async () => {
  await identity(); const first = await submit('erasure'), operation = randomUUID();
  const cancelled = await rpc('cancel_account_rights_request', [first.id, first.version, operation]);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.version, 2);
  assert.equal(cancelled.cancel_allowed, false); assert.equal(cancelled.account_deleted, false);
  assert.deepEqual(await rpc('cancel_account_rights_request', [first.id, first.version, operation]), cancelled);
  assert.deepEqual(await submit('erasure', first.request_id), cancelled);
  await assert.rejects(rpc('cancel_account_rights_request', [first.id, first.version, randomUUID()]), { code: 'PT409' });
  await assert.rejects(rpc('cancel_account_rights_request', [first.id, 2, operation]), { code: 'PT409' });
});

test('bounded receipt pagination keeps timestamp precision, tied rows and owner isolation', async () => {
  const pageOwner = randomUUID();
  await identity(pageOwner);
  for (let index = 0; index < 7; index++) await submit();
  await db.exec('RESET ROLE');
  await db.query("UPDATE account_rights_requests SET created_at='2026-09-01T10:00:00.123456Z' WHERE owner_id=$1", [pageOwner]);
  const expected = (await db.query('SELECT id FROM account_rights_requests WHERE owner_id=$1 ORDER BY created_at DESC,id DESC', [pageOwner])).rows.map(row => row.id);
  await identity(pageOwner);
  const found = []; let cursor = null;
  do {
    const page = await rpc('my_account_rights_requests', [cursor?.created_at || null, cursor?.id || null, 2]);
    assert.equal(page.requester, pageOwner); assert.ok(page.items.length <= 2);
    assert.ok(page.items.every(row => row.created_at.includes('.123456')));
    found.push(...page.items.map(row => row.id)); cursor = page.next_cursor;
    assert.equal(page.has_more, cursor !== null);
  } while (cursor);
  assert.deepEqual(found, expected);
  for (const args of [[null, null, 0], [null, null, 51], ['infinity', randomUUID(), 2], [null, randomUUID(), 2]]) {
    await assert.rejects(rpc('my_account_rights_requests', args), { code: '22023' });
  }
});

test('new erasure requires recent server JWT authentication, while an exact committed retry remains readable', async () => {
  await identity(); const first = await submit('erasure');
  for (const amr of [null, {}, [], [{ method: 'token_refresh', timestamp: Date.now() / 1000 }],
    [{ method: 'password', timestamp: Date.now() / 1000 - 301 }], [{ method: 'password', timestamp: Date.now() / 1000 + 60 }],
    [{ method: 'password', timestamp: 'fresh' }]]) {
    await db.query("SELECT set_config('request.jwt.claims',$1,false)", [JSON.stringify({ amr })]);
    await assert.rejects(submit('erasure'), { code: 'PT401' });
    assert.deepEqual(await submit('erasure', first.request_id), first);
  }
  await identity(); assert.equal((await submit('erasure')).status, 'received');
});

test('owner history is paginated and excludes operator/subject identity and evidence payloads', async () => {
  await identity(); const first = await submit('erasure');
  await rpc('cancel_account_rights_request', [first.id, 1, randomUUID()]);
  const recent = await rpc('my_account_rights_history', [first.id, null, 1]);
  const earlier = await rpc('my_account_rights_history', [first.id, recent.next_before_version, 1]);
  assert.equal(recent.items[0].action, 'cancelled'); assert.equal(recent.has_more, true);
  assert.equal(earlier.items[0].action, 'received'); assert.equal(earlier.has_more, false);
  assert.deepEqual(Object.keys(recent.items[0]).sort(), ['action','created_at','from_status','id','to_status','version'].sort());
  await identity(other); await assert.rejects(rpc('my_account_rights_history', [first.id]), { code: 'PT404' });
});

async function archive(id, chunkSize = 32768) {
  let offset = 0, page; const chunks = [];
  do {
    page = await rpc('read_account_rights_export', [id, offset, chunkSize]);
    assert.equal(page.offset, offset); assert.ok(page.next_offset > offset);
    const chunk = Buffer.from(page.chunk_base64, 'base64');
    assert.equal(chunk.length, page.next_offset - offset); assert.ok(chunk.length <= chunkSize);
    chunks.push(chunk); offset = page.next_offset;
  } while (!page.complete);
  const bytes = Buffer.concat(chunks);
  assert.equal(bytes.length, page.total_bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), page.sha256);
  return { data: JSON.parse(bytes.toString('utf8')), bytes, pages: chunks.length };
}

test('actual SQL exports only owner Auth/profile/log projection with provenance and private complete history', async () => {
  await identity(); await submit('erasure');
  const first = await submit(), operation = randomUUID();
  const info = await rpc('prepare_account_rights_export', [first.id, 1, operation]);
  assert.equal(info.requester, owner); assert.equal(info.receipt.status, 'export_ready');
  assert.equal(info.schema_version, 1); assert.equal(info.max_chunk_bytes, 32768);
  assert.equal(info.operation_id, operation); assert.equal(info.operation_status, 'committed');
  const page = await rpc('read_account_rights_export', [first.id, 0, 1]);
  assert.equal(page.operation_id, operation); assert.equal(page.operation_status, 'committed');
  assert.deepEqual(page.receipt, info.receipt);
  assert.deepEqual(await rpc('prepare_account_rights_export', [first.id, 1, operation]), info);
  const result = await archive(first.id, 1024), data = result.data;
  assert.ok(result.pages > 1);
  assert.equal(data.schema, 'formora.account-rights'); assert.equal(data.schema_version, 1);
  assert.equal(data.requester, owner); assert.equal(data.data.identity.id, owner);
  assert.equal(data.data.identity.email, owner + '@example.test');
  assert.equal(data.data.account.state.profile.name, 'Synthetic A');
  assert.deepEqual(data.data.account.state.weightLog, [{ date: '2026-09-01', kg: 70 }]);
  assert.equal(data.data.profile.following, undefined);
  assert.ok(data.request_history.requests.length > 1);
  assert.ok(data.request_history.requests.every(row => row.requester === owner));
  assert.ok(data.provenance.account.includes('not unsynced'));
  assert.ok(data.exclusions.some(value => value.includes('messages')));
  assert.doesNotMatch(result.bytes.toString(), new RegExp(other + '|never-export-credentials|not-for-export|untouched-other-account'));
  await identity(other);
  await assert.rejects(rpc('prepare_account_rights_export', [first.id, 1, operation]), { code: 'PT404' });
  await assert.rejects(rpc('read_account_rights_export', [first.id]), { code: 'PT404' });
});

test('export snapshots retain UTF-8 bytes across pages and source changes, without log truncation', async () => {
  const exportOwner = randomUUID(); await identity(exportOwner); await db.exec('RESET ROLE');
  const logged = Array.from({ length: 301 }, (value, index) => ({ date: '2026-09-01', kg: 50 + index }));
  const name = 'Member ' + String.fromCodePoint(0x1f3cb, 0x1f3fd, 0x200d, 0x2640, 0xfe0f);
  await db.query('INSERT INTO accounts(uid,data) VALUES($1,$2)', [exportOwner, JSON.stringify({ profile: { name }, weightLog: logged,
    workoutLog: [{ date: '2026-09-01', split: 'push', exercises: [{ id: 'press', name: 'Press', sets: [{ reps: 8, weight: 20, private: other }] }], messages: [{ body: 'not-for-export' }] }],
    messages: [{ body: 'private-other-message', from_uid: other }], supportReports: [{ reason: 'private-report' }] })]);
  await identity(exportOwner); const first = await submit();
  await rpc('prepare_account_rights_export', [first.id, 1, randomUUID()]);
  await db.exec('RESET ROLE');
  await db.query("UPDATE accounts SET data='{}' WHERE uid=$1", [exportOwner]);
  await identity(exportOwner); const result = await archive(first.id, 997);
  assert.deepEqual(result.data.data.account.state.weightLog, logged);
  assert.equal(result.data.data.account.state.profile.name, name);
  assert.doesNotMatch(result.bytes.toString(), /private-other-message|private-report|not-for-export/);
  assert.doesNotMatch(result.bytes.toString(), new RegExp(other));
  assert.deepEqual((await archive(first.id)).bytes, result.bytes);
});

test('export limits and malformed stored logs fail atomically, not with partial or fake-complete archives', async () => {
  for (const state of [{ profile: { name: 'x'.repeat(8388609) } }, { profile: {}, weightLog: { not: 'an array' } }]) {
    const exportOwner = randomUUID(); await identity(exportOwner); await db.exec('RESET ROLE');
    await db.query('INSERT INTO accounts(uid,data) VALUES($1,$2)', [exportOwner, JSON.stringify(state)]);
    await identity(exportOwner); const first = await submit();
    await assert.rejects(rpc('prepare_account_rights_export', [first.id, 1, randomUUID()]), { code: state.weightLog ? 'PT422' : 'PT413' });
    assert.equal((await rpc('my_account_rights_request', [first.id])).status, 'received');
    assert.equal((await rpc('my_account_rights_history', [first.id])).items.length, 1);
    await db.exec('RESET ROLE');
    assert.equal((await db.query('SELECT count(*)::int AS count FROM account_rights_exports WHERE request_ref=$1', [first.id])).rows[0].count, 0);
  }
});

test('cancelled exports cannot be prepared or delivered, including replay of a committed preparation', async () => {
  await identity(); const first = await submit(), operation = randomUUID();
  const info = await rpc('prepare_account_rights_export', [first.id, 1, operation]);
  for (const args of [[first.id, -1, 4], [first.id, 0, 32769], [first.id, info.total_bytes + 1, 4]]) {
    await assert.rejects(rpc('read_account_rights_export', args), { code: '22023' });
  }
  await rpc('cancel_account_rights_request', [first.id, info.receipt.version, randomUUID()]);
  await assert.rejects(rpc('read_account_rights_export', [first.id]), { code: 'PT409' });
  await assert.rejects(rpc('prepare_account_rights_export', [first.id, 1, operation]), { code: 'PT409' });
  await identity(owner, 'anon');
  await assert.rejects(rpc('read_account_rights_export', [first.id]), { code: '42501' });
  await identity(); await assert.rejects(db.query('SELECT * FROM account_rights_exports'), { code: '42501' });
});

async function review(receipt, action, operation = randomUUID(), evidence = randomUUID(), related = null, expectedOwner = receipt.requester) {
  return rpc('review_account_rights_request', [receipt.id, expectedOwner, receipt.version, action, operation, evidence, related]);
}

test('operator authorization is service-only, owner-proved, versioned, audited and explicitly preparation-only', async () => {
  const requestOwner = randomUUID(); await identity(requestOwner); const first = await submit('erasure');
  await assert.rejects(review(first, 'review'), { code: '42501' });
  await identity(null, 'service_role');
  await assert.rejects(review(first, 'review', randomUUID(), randomUUID(), null, other), { code: 'PT404' });
  await assert.rejects(review(first, 'authorize'), { code: 'PT409' });
  const operation = randomUUID(), evidence = randomUUID(), reviewed = await review(first, 'review', operation, evidence);
  assert.equal(reviewed.status, 'under_review'); assert.equal(reviewed.version, 2);
  assert.deepEqual(await review(first, 'review', operation, evidence), reviewed);
  await assert.rejects(review(first, 'review', operation, randomUUID()), { code: 'PT409' });
  await assert.rejects(review(first, 'review'), { code: 'PT409' });
  const authorized = await review(reviewed, 'authorize');
  assert.equal(authorized.status, 'authorized'); assert.equal(authorized.account_deleted, false);
  assert.equal(authorized.execution_allowed, false);
  const history = await rpc('account_rights_operator_history', [first.id, requestOwner]);
  assert.equal(history.items.length, 3); assert.equal(history.items[0].actor_role, 'service_role');
  assert.equal(history.items[0].actor_id, null);
  assert.equal(history.items[1].payload.evidence_ref, evidence);
  const queue = await rpc('account_rights_operator_queue', [null, null, 2]);
  assert.equal(queue.items.length, 2); assert.equal(queue.has_more, true);
  await identity(requestOwner);
  assert.equal((await rpc('my_account_rights_request', [first.id])).status, 'authorized');
  const visible = JSON.stringify(await rpc('my_account_rights_history', [first.id]));
  assert.doesNotMatch(visible, new RegExp(evidence + '|actor_id|actor_role|evidence_ref'));
});

test('multiple holds deny supersession and cannot be bypassed with a fresh owner request', async () => {
  const requestOwner = randomUUID(); await identity(requestOwner);
  const first = await submit('erasure'), replacement = await submit('erasure');
  await identity(null, 'service_role');
  const holdOne = randomUUID(), holdTwo = randomUUID();
  let held = await review(first, 'hold', randomUUID(), holdOne);
  held = await review(held, 'hold', randomUUID(), holdTwo);
  await assert.rejects(review(held, 'authorize'), { code: 'PT409' });
  const reviewed = await review(replacement, 'review');
  await assert.rejects(review(reviewed, 'authorize'), { code: 'PT409' });
  await assert.rejects(review(held, 'supersede', randomUUID(), randomUUID(), replacement.id), { code: 'PT409' });
  const releasedOne = await review(held, 'release_hold', randomUUID(), holdOne);
  assert.equal(releasedOne.status, 'held');
  await assert.rejects(review(reviewed, 'authorize'), { code: 'PT409' });
  const releasedBoth = await review(releasedOne, 'release_hold', randomUUID(), holdTwo);
  const superseded = await review(releasedBoth, 'supersede', randomUUID(), randomUUID(), replacement.id);
  assert.equal(superseded.status, 'superseded');
  await assert.rejects(review(superseded, 'review'), { code: 'PT409' });
  const authorized = await review(reviewed, 'authorize'); assert.equal(authorized.status, 'authorized');
  await identity(requestOwner);
  const cancelled = await rpc('cancel_account_rights_request', [authorized.id, authorized.version, randomUUID()]);
  await identity(null, 'service_role');
  await assert.rejects(review(cancelled, 'authorize'), { code: 'PT409' });
  await assert.rejects(review(cancelled, 'review'), { code: 'PT409' });
});

test('supersession never links another owner, kind, self or a cancelled replacement', async () => {
  const requestOwner = randomUUID(); await identity(requestOwner);
  const first = await submit('erasure'), differentKind = await submit(), cancelled = await submit('erasure');
  await rpc('cancel_account_rights_request', [cancelled.id, 1, randomUUID()]);
  await identity(other); const otherRequest = await submit('erasure');
  await identity(null, 'service_role');
  for (const target of [otherRequest.id, differentKind.id, first.id, cancelled.id]) {
    await assert.rejects(review(first, 'supersede', randomUUID(), randomUUID(), target), { code: 'PT409' });
  }
  for (const action of ['execute', 'deleted', 'complete', 'refund']) {
    await assert.rejects(review(first, action), { code: '22023' });
  }
  await assert.rejects(review(first, 'review', randomUUID(), null), { code: '22023' });
});

test('operator preview performs a bounded inventory, audits exact retries and never enables destruction', async () => {
  const requestOwner = randomUUID(); await identity(requestOwner); const first = await submit('erasure');
  await assert.rejects(rpc('preview_account_rights_erasure', [first.id, requestOwner, randomUUID()]), { code: '42501' });
  await identity(null, 'service_role');
  const reviewed = await review(first, 'review'), authorized = await review(reviewed, 'authorize'), operation = randomUUID();
  const preview = await rpc('preview_account_rights_erasure', [first.id, requestOwner, operation]);
  assert.equal(preview.dry_run, true); assert.equal(preview.execution_allowed, false);
  assert.equal(preview.authorization_scope, 'preparation_only');
  assert.equal(preview.preparation_authorized_at_preview, true);
  assert.equal(preview.inventory.find(row => row.category === 'auth').matched_rows, 1);
  assert.equal(preview.inventory.find(row => row.category === 'media').available, false);
  assert.equal(preview.inventory.find(row => row.category === 'media').matched_rows, null);
  assert.equal(preview.inventory.find(row => row.category === 'story_interactions').available, false);
  assert.equal(preview.inventory.find(row => row.category === 'stories').source, 'public.stories_v2');
  assert.equal(preview.inventory.find(row => row.category === 'support_cases').source, 'public.support_cases');
  assert.ok(preview.inventory.every(row => row.source_execution_allowed === false));
  assert.equal(preview.inventory.find(row => row.category === 'story_actions').source, 'public.story_action_receipts');
  assert.doesNotMatch(JSON.stringify(preview), /payload_digest|lease_token|archive_text/);
  assert.ok(preview.inventory.every(row => row.deletion_authorized === false));
  assert.ok(preview.required_before_execution.some(value => value.includes('paid entitlements')));
  assert.deepEqual(await rpc('preview_account_rights_erasure', [first.id, requestOwner, operation]), preview);
  await assert.rejects(rpc('preview_account_rights_erasure', [first.id, other, operation]), { code: 'PT404' });
  await identity(requestOwner);
  await rpc('cancel_account_rights_request', [authorized.id, authorized.version, randomUUID()]);
  await identity(null, 'service_role');
  const current = await rpc('preview_account_rights_erasure', [first.id, requestOwner, randomUUID()]);
  assert.equal(current.observed_status, 'cancelled'); assert.equal(current.preparation_authorized_at_preview, false);
  await db.exec('RESET ROLE');
  const audit = (await db.query('SELECT * FROM account_rights_previews WHERE operation_id=$1', [operation])).rows;
  assert.equal(audit.length, 1); assert.equal(audit[0].actor_role, 'service_role');
});

test('service actions and holds roll back if their audit cannot commit; interrupted retries are safe', async () => {
  const requestOwner = randomUUID(); await identity(requestOwner); const first = await submit('erasure');
  await db.exec("RESET ROLE; ALTER TABLE account_rights_actions ADD CONSTRAINT qa_reject_hold CHECK (action <> 'hold') NOT VALID");
  await identity(null, 'service_role'); const operation = randomUUID(), evidence = randomUUID();
  await assert.rejects(review(first, 'hold', operation, evidence), { code: '23514' });
  await db.exec('RESET ROLE');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM account_rights_holds WHERE request_ref=$1', [first.id])).rows[0].count, 0);
  await db.exec('ALTER TABLE account_rights_actions DROP CONSTRAINT qa_reject_hold');
  await identity(null, 'service_role');
  const held = await review(first, 'hold', operation, evidence);
  assert.equal(held.version, 2); assert.deepEqual(await review(first, 'hold', operation, evidence), held);
});

test('existing moderation evidence holds block authorization and release restores review eligibility', async () => {
  const requestOwner = randomUUID(); await identity(requestOwner); const first = await submit('erasure');
  await db.exec(`RESET ROLE;
    CREATE TABLE public.messages(id text PRIMARY KEY, from_uid text, to_uid text, body text);
    CREATE TABLE public.entitlements(uid text PRIMARY KEY, tier text, current_period_end timestamptz);
    CREATE TABLE public.support_tickets(id uuid PRIMARY KEY, uid text, message text);`);
  const caseId = randomUUID();
  await db.query('INSERT INTO report_cases VALUES($1,$2,$3,$4)', [caseId, other, requestOwner, 'private-other-report']);
  await db.query('INSERT INTO report_evidence_holds VALUES($1,$2)', [caseId, randomUUID()]);
  await db.query("INSERT INTO messages VALUES('synthetic-shared',$1,$2,'private-incoming-message')", [other, requestOwner]);
  await db.query("INSERT INTO entitlements VALUES($1,'elite',NULL)", [requestOwner]);
  await db.query("INSERT INTO support_tickets VALUES($1,$2,'private-support-prose')", [randomUUID(), requestOwner]);
  const original = (await db.query('SELECT (SELECT jsonb_agg(report) FROM report_cases report) AS reports, (SELECT jsonb_agg(message) FROM messages message) AS messages, (SELECT jsonb_agg(entitlement) FROM entitlements entitlement) AS entitlements')).rows;
  await identity(null, 'service_role'); const reviewed = await review(first, 'review');
  await assert.rejects(review(reviewed, 'authorize'), { code: 'PT409' });
  const preview = await rpc('preview_account_rights_erasure', [first.id, requestOwner, randomUUID()]);
  assert.equal(preview.report_evidence_holds, 1); assert.equal(preview.execution_allowed, false);
  assert.equal(preview.inventory.find(row => row.category === 'received_messages').matched_rows, 1);
  assert.doesNotMatch(JSON.stringify(preview), new RegExp(other + '|private-other-report|private-incoming-message|private-support-prose'));
  await db.exec('RESET ROLE');
  await db.query('DELETE FROM report_evidence_holds WHERE case_id=$1', [caseId]);
  await identity(null, 'service_role'); assert.equal((await review(reviewed, 'authorize')).status, 'authorized');
  await db.exec('RESET ROLE');
  assert.deepEqual((await db.query('SELECT (SELECT jsonb_agg(report) FROM report_cases report) AS reports, (SELECT jsonb_agg(message) FROM messages message) AS messages, (SELECT jsonb_agg(entitlement) FROM entitlements entitlement) AS entitlements')).rows, original);
});

test('PUBLIC/default/effective role ACLs deny all direct tables and protect every RPC/helper', async () => {
  await db.exec('RESET ROLE');
  const functions = (await db.query("SELECT oid, proname, proconfig FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE '%account_rights%' ORDER BY proname")).rows;
  const tables = (await db.query("SELECT oid,relname,relrowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'account_rights_%' AND relkind='r'")).rows;
  const ownerFunctions = new Set(['submit_account_rights_request','my_account_rights_request','my_account_rights_requests','cancel_account_rights_request','my_account_rights_history','prepare_account_rights_export','read_account_rights_export','release_my_account_rights_export']);
  const serviceFunctions = new Set(['review_account_rights_request','preview_account_rights_erasure','account_rights_operator_queue','account_rights_operator_history','release_account_rights_export']);
  for (const role of ['public_probe', 'anon', 'authenticated', 'service_role']) {
    for (const entry of functions) {
      const granted = (await db.query("SELECT has_function_privilege($1,$2::oid,'EXECUTE') AS granted", [role, entry.oid])).rows[0].granted;
      assert.equal(granted, (role === 'authenticated' && ownerFunctions.has(entry.proname)) || (role === 'service_role' && serviceFunctions.has(entry.proname)), role + ':' + entry.proname);
      assert.ok(entry.proconfig.includes('search_path=""'));
    }
    for (const table of tables) {
      assert.equal(table.relrowsecurity, true);
      assert.equal((await db.query("SELECT has_table_privilege($1,$2::oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS granted", [role, table.oid])).rows[0].granted, false);
    }
  }
  const checks = migration.match(/DO \$permissions\$[\s\S]*?\$permissions\$;/)[0];
  await db.exec(checks);
});

test('inherited privilege escalation fails the migration gate and cannot bypass exact-role service guards', async () => {
  const checks = migration.match(/DO \$permissions\$[\s\S]*?\$permissions\$;/)[0];
  await db.exec('RESET ROLE; GRANT service_role TO authenticated');
  await assert.rejects(db.exec(checks), { code: '42501' });
  await identity(owner);
  await assert.rejects(rpc('account_rights_operator_queue'), { code: '42501' });
  await db.exec('RESET ROLE; REVOKE service_role FROM authenticated; GRANT authenticated TO anon');
  await assert.rejects(db.exec(checks), { code: '42501' });
  await identity(owner, 'anon'); await assert.rejects(submit(), { code: '42501' });
  await db.exec('RESET ROLE; REVOKE authenticated FROM anon; CREATE ROLE inherited_privileges; GRANT inherited_privileges TO authenticated; GRANT SELECT ON account_rights_exports TO inherited_privileges');
  await assert.rejects(db.exec(checks), { code: '42501' });
  await db.exec('REVOKE SELECT ON account_rights_exports FROM inherited_privileges; REVOKE inherited_privileges FROM authenticated');
  await db.exec(checks);
});

test('owner request quotas admit committed replays and deny fresh UUID floods without touching original data', async () => {
  const requestOwner = randomUUID(); await identity(requestOwner); const first = await submit('erasure');
  for (let index = 1; index < 20; index++) await submit('erasure');
  await assert.rejects(submit('erasure'), { code: 'PT429' });
  assert.deepEqual(await submit('erasure', first.request_id), first);
  await db.exec('RESET ROLE');
  assert.deepEqual((await db.query('SELECT data FROM accounts WHERE uid=$1', [other])).rows[0].data,
    { profile: { name: 'Synthetic B' }, private: 'untouched-other-account' });
  assert.deepEqual((await db.query('SELECT data FROM profiles WHERE uid=$1', [other])).rows[0].data,
    { name: 'Synthetic B', bio: 'not-for-export' });
});

test('QA: a held export refuses new and replayed delivery; release preserves bytes and supersession revokes access', async () => {
  const requestOwner = randomUUID(); await identity(requestOwner);
  const first = await submit(), replacement = await submit(), operation = randomUUID();
  const prepared = await rpc('prepare_account_rights_export', [first.id, first.version, operation]);
  const original = await archive(first.id);
  await identity(null, 'service_role'); const holdRef = randomUUID();
  const held = await review(prepared.receipt, 'hold', randomUUID(), holdRef);
  await identity(requestOwner);
  await assert.rejects(rpc('read_account_rights_export', [first.id]), { code: 'PT409' });
  await assert.rejects(rpc('prepare_account_rights_export', [first.id, first.version, operation]), { code: 'PT409' });
  await identity(null, 'service_role'); const released = await review(held, 'release_hold', randomUUID(), holdRef);
  assert.equal(released.status, 'export_ready');
  await identity(requestOwner); assert.deepEqual((await archive(first.id)).bytes, original.bytes);
  await identity(null, 'service_role'); await review(released, 'supersede', randomUUID(), randomUUID(), replacement.id);
  await identity(requestOwner);
  await assert.rejects(rpc('read_account_rights_export', [first.id]), { code: 'PT409' });
  await assert.rejects(rpc('prepare_account_rights_export', [first.id, first.version, operation]), { code: 'PT409' });
});

test('QA: cancellation is denied while any owner hold remains, without authorizing a replacement', async () => {
  const requestOwner = randomUUID(); await identity(requestOwner);
  const first = await submit('erasure'), replacement = await submit('erasure');
  await identity(null, 'service_role'); const holdRef = randomUUID();
  const held = await review(first, 'hold', randomUUID(), holdRef), reviewed = await review(replacement, 'review');
  await identity(requestOwner);
  await assert.rejects(rpc('cancel_account_rights_request', [held.id, held.version, randomUUID()]), { code: 'PT409' });
  assert.equal((await rpc('my_account_rights_request', [held.id])).cancel_allowed, false);
  await identity(null, 'service_role'); await assert.rejects(review(reviewed, 'authorize'), { code: 'PT409' });
  const released = await review(held, 'release_hold', randomUUID(), holdRef);
  await identity(requestOwner);
  const cancelled = await rpc('cancel_account_rights_request', [released.id, released.version, randomUUID()]);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.account_deleted, false);
  await identity(null, 'service_role');
  assert.equal((await review(reviewed, 'authorize')).status, 'authorized');
});

test('QA: replaying an old operator authorization after cancellation returns current status without revival', async () => {
  const requestOwner = randomUUID(); await identity(requestOwner); const first = await submit('erasure');
  await identity(null, 'service_role'); const reviewed = await review(first, 'review'), operation = randomUUID(), evidence = randomUUID();
  const authorized = await review(reviewed, 'authorize', operation, evidence);
  await identity(requestOwner); const cancelled = await rpc('cancel_account_rights_request', [authorized.id, authorized.version, randomUUID()]);
  await identity(null, 'service_role');
  assert.deepEqual(await review(reviewed, 'authorize', operation, evidence), cancelled);
  await assert.rejects(review(cancelled, 'authorize'), { code: 'PT409' });
});

test('QA: actual direct SELECT/INSERT/UPDATE/DELETE attempts are denied for every public-facing role', async () => {
  await db.exec('RESET ROLE');
  const tables = (await db.query("SELECT relation.relname, (SELECT attname FROM pg_attribute WHERE attrelid=relation.oid AND attnum>0 AND NOT attisdropped ORDER BY attnum LIMIT 1) AS first_column FROM pg_class relation WHERE relnamespace='public'::regnamespace AND relname LIKE 'account_rights_%' AND relkind='r'")).rows;
  for (const role of ['public_probe', 'anon', 'authenticated', 'service_role']) {
    await identity(owner, role);
    for (const table of tables) {
      for (const statement of ['SELECT * FROM public.' + table.relname,
        'INSERT INTO public.' + table.relname + ' SELECT * FROM public.' + table.relname + ' WHERE false',
        'UPDATE public.' + table.relname + ' SET ' + table.first_column + '=' + table.first_column + ' WHERE false',
        'DELETE FROM public.' + table.relname + ' WHERE false']) {
        await assert.rejects(db.query(statement), { code: '42501' }, role + ': ' + statement);
      }
    }
  }
});

test('QA: bounded snapshot count rejects new exports but not committed preparation retries', async () => {
  const requestOwner = randomUUID(); await identity(requestOwner); let first, firstOperation, firstInfo;
  for (let index = 0; index < 8; index++) {
    const requested = await submit(), operation = randomUUID();
    const info = await rpc('prepare_account_rights_export', [requested.id, 1, operation]);
    if (index === 0) { first = requested; firstOperation = operation; firstInfo = info; }
  }
  const excess = await submit();
  await assert.rejects(rpc('prepare_account_rights_export', [excess.id, 1, randomUUID()]), { code: 'PT429' });
  assert.equal((await rpc('my_account_rights_request', [excess.id])).status, 'received');
  assert.deepEqual(await rpc('prepare_account_rights_export', [first.id, 1, firstOperation]), firstInfo);
  await archive(first.id);
  const operation = randomUUID(), approval = randomUUID();
  await assert.rejects(rpc('release_account_rights_export', [first.id, requestOwner, firstInfo.receipt.version, operation, approval]), { code: '42501' });
  await identity(null, 'service_role');
  await assert.rejects(rpc('release_account_rights_export', [first.id, requestOwner, firstInfo.receipt.version, operation, null]), { code: '22023' });
  await assert.rejects(rpc('release_account_rights_export', [first.id, other, firstInfo.receipt.version, operation, approval]), { code: 'PT404' });
  const released = await rpc('release_account_rights_export', [first.id, requestOwner, firstInfo.receipt.version, operation, approval]);
  assert.equal(released.receipt.status, 'export_released'); assert.equal(released.source_data_deleted, false);
  assert.equal(released.released_bytes, firstInfo.total_bytes); assert.equal(released.operation_status, 'committed');
  assert.deepEqual(await rpc('release_account_rights_export', [first.id, requestOwner, firstInfo.receipt.version, operation, approval]), released);
  await assert.rejects(rpc('release_account_rights_export', [first.id, requestOwner, firstInfo.receipt.version, operation, randomUUID()]), { code: 'PT409' });
  const audit = (await rpc('account_rights_operator_history', [first.id, requestOwner])).items[0];
  assert.equal(audit.actor_role, 'service_role'); assert.equal(audit.actor_id, null);
  assert.deepEqual(audit.payload, { scope: 'cached_export_only', approval_ref: approval, released_bytes: firstInfo.total_bytes });
  await identity(requestOwner);
  const history = await rpc('my_account_rights_history', [first.id]);
  assert.equal(history.items[0].action, 'release_export');
  assert.doesNotMatch(JSON.stringify(history), new RegExp(approval + '|actor_role|actor_id|payload|archive_text|email|weightLog'));
  await assert.rejects(rpc('prepare_account_rights_export', [first.id, 1, firstOperation]), { code: 'PT409' });
  assert.equal((await rpc('prepare_account_rights_export', [excess.id, 1, randomUUID()])).receipt.status, 'export_ready');
  const nextArchive = await archive(excess.id);
  assert.ok(nextArchive.data.request_history.actions.some(action => action.action === 'release_export'));
  assert.doesNotMatch(nextArchive.bytes.toString(), new RegExp(approval + '|approval_ref|actor_role|actor_id|payload'));
});

test('QA: request and initial audit fail atomically and retry leaves unrelated original rows intact', async () => {
  const requestOwner = randomUUID(); await identity(requestOwner); const requestId = randomUUID();
  await db.exec("RESET ROLE; ALTER TABLE account_rights_actions ADD CONSTRAINT qa_reject_received CHECK (action <> 'received') NOT VALID");
  await identity(requestOwner); await assert.rejects(submit('export', requestId), { code: '23514' });
  assert.equal((await rpc('my_account_rights_requests')).items.length, 0);
  await db.exec('RESET ROLE; ALTER TABLE account_rights_actions DROP CONSTRAINT qa_reject_received');
  await identity(requestOwner); assert.equal((await submit('export', requestId)).request_id, requestId);
  await db.exec('RESET ROLE');
  assert.deepEqual((await db.query('SELECT data FROM accounts WHERE uid=$1', [owner])).rows[0].data,
    { profile: { name: 'Synthetic A' }, weightLog: [{ date: '2026-09-01', kg: 70 }] });
  assert.deepEqual((await db.query('SELECT data FROM profiles WHERE uid=$1', [owner])).rows[0].data,
    { name: 'Synthetic A', following: [other] });
});

test('R1: eight prepare-cancel cycles leave zero archives and admit a ninth preparation', async () => {
  const requestOwner = randomUUID();
  for (let index = 0; index < 8; index++) {
    await identity(requestOwner);
    const requested = await submit();
    const prepared = await rpc('prepare_account_rights_export', [requested.id, requested.version, randomUUID()]);
    const cancelled = await rpc('cancel_account_rights_request', [requested.id, prepared.receipt.version, randomUUID()]);
    assert.equal(cancelled.status, 'cancelled');
  }
  await db.exec('RESET ROLE');
  const retained = (await db.query(`SELECT count(*)::int AS count, coalesce(sum(exported.total_bytes),0)::int AS bytes
    FROM account_rights_exports exported JOIN account_rights_requests request ON request.id=exported.request_ref
    WHERE request.owner_id=$1`, [requestOwner])).rows[0];
  assert.deepEqual(retained, { count: 0, bytes: 0 });
  await identity(requestOwner);
  const ninth = await submit();
  assert.equal((await rpc('prepare_account_rights_export', [ninth.id, ninth.version, randomUUID()])).receipt.status, 'export_ready');
});

test('R1: an owner explicitly releases only their named cached snapshot and can export again after eight downloads', async () => {
  const requestOwner = randomUUID();
  await identity(requestOwner);
  let first, firstPreparation;
  for (let index = 0; index < 9; index++) {
    const requested = await submit(), preparation = randomUUID();
    const info = await rpc('prepare_account_rights_export', [requested.id, 1, preparation]);
    await archive(requested.id);
    const operation = randomUUID();
    if (!first) {
      first = requested; firstPreparation = preparation;
      await identity(other);
      await assert.rejects(rpc('release_my_account_rights_export', [requested.id, info.receipt.version, operation]), { code: 'PT404' });
      for (const role of ['public_probe', 'anon', 'service_role']) {
        await identity(requestOwner, role);
        await assert.rejects(rpc('release_my_account_rights_export', [requested.id, info.receipt.version, operation]), { code: '42501' });
      }
      await identity(requestOwner);
      await assert.rejects(rpc('release_my_account_rights_export', [requested.id, 1, operation]), { code: 'PT409' });
      await assert.rejects(rpc('release_my_account_rights_export', [requested.id, info.receipt.version, preparation]), { code: 'PT409' });
    }
    const released = await rpc('release_my_account_rights_export', [requested.id, info.receipt.version, operation]);
    assert.equal(released.receipt.status, 'export_released'); assert.equal(released.receipt.snapshot_status, 'released');
    assert.equal(released.receipt.cancel_allowed, false); assert.equal(released.receipt.release_allowed, false);
    assert.equal(released.receipt.version, info.receipt.version + 1); assert.equal(released.scope, 'cached_export_only');
    assert.equal(released.operation_id, operation); assert.equal(released.action, 'release_export');
    assert.deepEqual(await rpc('release_my_account_rights_export', [requested.id, info.receipt.version, operation]), released);
    await assert.rejects(rpc('release_my_account_rights_export', [requested.id, released.receipt.version, randomUUID()]), { code: 'PT409' });
    await assert.rejects(rpc('read_account_rights_export', [requested.id]), { code: 'PT409' });
  }
  await assert.rejects(rpc('prepare_account_rights_export', [first.id, 1, firstPreparation]), { code: 'PT409' });
  await db.exec('RESET ROLE');
  assert.equal((await db.query(`SELECT count(*)::int AS count FROM account_rights_exports exported
    JOIN account_rights_requests request ON request.id=exported.request_ref WHERE request.owner_id=$1`, [requestOwner])).rows[0].count, 0);
});

test('R1: service release purges a legacy terminal archive only after its hold is explicitly released', async () => {
  for (const terminal of ['cancelled', 'superseded']) {
    const requestOwner = randomUUID(); await identity(requestOwner);
    const requested = await submit();
    const prepared = await rpc('prepare_account_rights_export', [requested.id, 1, randomUUID()]);
    await db.exec('RESET ROLE');
    await db.query('UPDATE account_rights_requests SET status=$1 WHERE id=$2', [terminal, requested.id]);
    await identity(requestOwner);
    const legacy = await rpc('my_account_rights_request', [requested.id]);
    assert.equal(legacy.snapshot_status, 'available'); assert.equal(legacy.release_allowed, true);
    await identity(null, 'service_role');
    const holdRef = randomUUID(), held = await review(legacy, 'hold', randomUUID(), holdRef);
    assert.equal(held.status, terminal); assert.equal(held.hold_status, 'held');
    await assert.rejects(rpc('release_account_rights_export', [requested.id, requestOwner, held.version, randomUUID(), randomUUID()]), { code: 'PT409' });
    const clear = await review(held, 'release_hold', randomUUID(), holdRef);
    const released = await rpc('release_account_rights_export', [requested.id, requestOwner, clear.version, randomUUID(), randomUUID()]);
    assert.equal(released.receipt.status, terminal); assert.equal(released.receipt.snapshot_status, 'released');
    assert.equal(released.released_bytes, prepared.total_bytes); assert.equal(released.source_data_deleted, false);
    await db.exec('RESET ROLE');
    assert.equal((await db.query('SELECT count(*)::int AS count FROM account_rights_exports WHERE request_ref=$1', [requested.id])).rows[0].count, 0);
  }
});

test('R1: cancellation, supersession and both release paths roll back archive deletion when audit insertion fails', async () => {
  for (const mode of ['cancelled', 'supersede', 'owner_release', 'service_release']) {
    const requestOwner = randomUUID(); await identity(requestOwner);
    await db.exec('RESET ROLE');
    await db.query('INSERT INTO accounts(uid,data) VALUES($1,$2)', [requestOwner, JSON.stringify({ profile: { name: 'Synthetic immutable source' }, weightLog: [{ kg: 73 }] })]);
    await identity(requestOwner);
    const requested = await submit(), replacement = await submit();
    const prepared = await rpc('prepare_account_rights_export', [requested.id, 1, randomUUID()]);
    const operation = randomUUID(), approval = randomUUID(), action = mode.endsWith('_release') ? 'release_export' : mode;
    async function records() {
      await db.exec('RESET ROLE');
      return (await db.query(`SELECT
        (SELECT jsonb_agg(request ORDER BY id) FROM account_rights_requests request WHERE owner_id=$1) AS requests,
        (SELECT jsonb_agg(audit ORDER BY audit.id) FROM account_rights_actions audit JOIN account_rights_requests request ON request.id=audit.request_ref WHERE request.owner_id=$1) AS actions,
        (SELECT jsonb_agg(exported ORDER BY exported.request_ref) FROM account_rights_exports exported JOIN account_rights_requests request ON request.id=exported.request_ref WHERE request.owner_id=$1) AS exports,
        (SELECT jsonb_agg(account ORDER BY uid) FROM accounts account WHERE uid IN ($2,$3)) AS sources,
        (SELECT jsonb_agg(profile ORDER BY uid) FROM profiles profile WHERE uid=$3) AS profiles`, [requestOwner, requestOwner, other])).rows;
    }
    async function attempt() {
      if (mode === 'cancelled' || mode === 'owner_release') {
        await identity(requestOwner);
        return rpc(mode === 'cancelled' ? 'cancel_account_rights_request' : 'release_my_account_rights_export', [requested.id, prepared.receipt.version, operation]);
      }
      await identity(null, 'service_role');
      return mode === 'supersede' ? review(prepared.receipt, 'supersede', operation, approval, replacement.id)
        : rpc('release_account_rights_export', [requested.id, requestOwner, prepared.receipt.version, operation, approval]);
    }
    const before = await records();
    await db.exec("ALTER TABLE account_rights_actions ADD CONSTRAINT qa_release_atomic CHECK (action <> '" + action + "') NOT VALID");
    try {
      await assert.rejects(attempt(), { code: '23514' });
      assert.deepEqual(await records(), before, mode);
    } finally { await db.exec('RESET ROLE; ALTER TABLE account_rights_actions DROP CONSTRAINT qa_release_atomic'); }
    await attempt();
    const after = await records();
    assert.equal(after[0].exports, null); assert.deepEqual(after[0].sources, before[0].sources); assert.deepEqual(after[0].profiles, before[0].profiles);
    assert.equal(after[0].actions.length, before[0].actions.length + 1);
  }
});

test('R1: owner-wide holds fence cache mutations and reads and every reply exposes the observed hold version', async () => {
  const requestOwner = randomUUID(); await identity(requestOwner);
  const requested = await submit(), replacement = await submit(), unrelated = await submit('erasure');
  const prepared = await rpc('prepare_account_rights_export', [requested.id, 1, randomUUID()]);
  const initial = await rpc('read_account_rights_export', [requested.id, 0, 1]);
  assert.equal(initial.receipt.hold_status, 'clear'); assert.equal(initial.receipt.hold_version, 0);
  await identity(null, 'service_role'); const holdRef = randomUUID();
  const held = await review(unrelated, 'hold', randomUUID(), holdRef);
  await assert.rejects(review(prepared.receipt, 'supersede', randomUUID(), randomUUID(), replacement.id), { code: 'PT409' });
  await assert.rejects(rpc('release_account_rights_export', [requested.id, requestOwner, prepared.receipt.version, randomUUID(), randomUUID()]), { code: 'PT409' });
  await identity(requestOwner);
  const observed = await rpc('my_account_rights_request', [requested.id]);
  assert.equal(observed.version, prepared.receipt.version); assert.equal(observed.hold_version, 1);
  assert.equal(observed.hold_status, 'held'); assert.equal(observed.cancel_allowed, false); assert.equal(observed.release_allowed, false);
  for (const name of ['cancel_account_rights_request', 'release_my_account_rights_export']) {
    await assert.rejects(rpc(name, [requested.id, observed.version, randomUUID()]), { code: 'PT409' });
  }
  await assert.rejects(rpc('read_account_rights_export', [requested.id]), { code: 'PT409' });
  await identity(null, 'service_role'); await review(held, 'release_hold', randomUUID(), holdRef);
  await identity(requestOwner);
  const restored = await rpc('read_account_rights_export', [requested.id, 0, 1]);
  assert.equal(restored.receipt.hold_version, 2); assert.equal(restored.receipt.hold_status, 'clear');
  assert.equal(restored.sha256, initial.sha256); assert.equal(restored.chunk_base64, initial.chunk_base64);
});

test('R1: missing or mismapped moderation holds remain unknown and grant no cache removal or preparation privilege', async () => {
  const requestOwner = randomUUID(); await identity(requestOwner);
  const requested = await submit(), replacement = await submit(), erasure = await submit('erasure');
  const prepared = await rpc('prepare_account_rights_export', [requested.id, 1, randomUUID()]);
  await identity(null, 'service_role'); const reviewed = await review(erasure, 'review');
  for (const missing of ['table', 'column']) {
    await db.exec(missing === 'table' ? 'RESET ROLE; ALTER TABLE report_evidence_holds RENAME TO qa_hidden_holds'
      : 'RESET ROLE; ALTER TABLE report_evidence_holds RENAME COLUMN case_id TO qa_hidden_case_id');
    try {
      await identity(requestOwner);
      const observed = await rpc('my_account_rights_request', [requested.id]);
      assert.equal(observed.hold_status, 'unknown'); assert.equal(observed.cancel_allowed, false); assert.equal(observed.release_allowed, false);
      await assert.rejects(rpc('cancel_account_rights_request', [requested.id, observed.version, randomUUID()]), { code: 'PT409' });
      await assert.rejects(rpc('release_my_account_rights_export', [requested.id, observed.version, randomUUID()]), { code: 'PT409' });
      await assert.rejects(rpc('read_account_rights_export', [requested.id]), { code: 'PT409' });
      await assert.rejects(rpc('prepare_account_rights_export', [replacement.id, 1, randomUUID()]), { code: 'PT409' });
      await identity(null, 'service_role');
      await assert.rejects(rpc('release_account_rights_export', [requested.id, requestOwner, observed.version, randomUUID(), randomUUID()]), { code: 'PT409' });
      await assert.rejects(review(prepared.receipt, 'supersede', randomUUID(), randomUUID(), replacement.id), { code: 'PT409' });
      await assert.rejects(review(reviewed, 'authorize'), { code: 'PT409' });
      const preview = await rpc('preview_account_rights_erasure', [erasure.id, requestOwner, randomUUID()]);
      assert.equal(preview.report_evidence_holds, null); assert.equal(preview.preparation_authorized_at_preview, false); assert.equal(preview.execution_allowed, false);
    } finally {
      await db.exec(missing === 'table' ? 'RESET ROLE; ALTER TABLE qa_hidden_holds RENAME TO report_evidence_holds'
        : 'RESET ROLE; ALTER TABLE report_evidence_holds RENAME COLUMN qa_hidden_case_id TO case_id');
    }
  }
  await identity(requestOwner); assert.equal((await rpc('my_account_rights_request', [requested.id])).snapshot_status, 'available');
});

test('R1: pending exports have a separate owner-wide cap and committed retries never consume another slot', async () => {
  const requestOwner = randomUUID(); await identity(requestOwner); const first = await submit();
  for (let index = 1; index < 8; index++) await submit();
  await assert.rejects(submit(), { code: 'PT429' });
  assert.deepEqual(await submit('export', first.request_id), first);
  await rpc('cancel_account_rights_request', [first.id, first.version, randomUUID()]);
  assert.equal((await submit()).status, 'received');
  await identity(randomUUID()); assert.equal((await submit()).status, 'received');
});

test('R1: the 32 MiB owner cache cap rolls back new preparation and an approved release reclaims bytes', async () => {
  const requestOwner = randomUUID(); await identity(requestOwner); let first;
  for (let index = 0; index < 4; index++) {
    const requested = await submit();
    const prepared = await rpc('prepare_account_rights_export', [requested.id, 1, randomUUID()]);
    first ||= prepared.receipt;
  }
  const excess = await submit(), operation = randomUUID();
  await db.exec('RESET ROLE');
  await db.query(`UPDATE account_rights_exports SET archive_text=repeat(' ',8388606)||'{}', total_bytes=8388608,
    sha256=encode(sha256(convert_to(repeat(' ',8388606)||'{}','UTF8')),'hex')
    WHERE request_ref IN (SELECT id FROM account_rights_requests WHERE owner_id=$1)`, [requestOwner]);
  const old = (await db.query('SELECT request_ref,total_bytes,sha256 FROM account_rights_exports WHERE request_ref IN (SELECT id FROM account_rights_requests WHERE owner_id=$1) ORDER BY request_ref', [requestOwner])).rows;
  await identity(requestOwner);
  await assert.rejects(rpc('prepare_account_rights_export', [excess.id, 1, operation]), { code: 'PT429' });
  assert.deepEqual(await rpc('my_account_rights_request', [excess.id]), excess);
  assert.equal((await rpc('my_account_rights_history', [excess.id])).items.length, 1);
  await db.exec('RESET ROLE');
  assert.deepEqual((await db.query('SELECT request_ref,total_bytes,sha256 FROM account_rights_exports WHERE request_ref IN (SELECT id FROM account_rights_requests WHERE owner_id=$1) ORDER BY request_ref', [requestOwner])).rows, old);
  await identity(null, 'service_role');
  const released = await rpc('release_account_rights_export', [first.id, requestOwner, first.version, randomUUID(), randomUUID()]);
  assert.equal(released.released_bytes, 8388608);
  await identity(requestOwner);
  assert.equal((await rpc('prepare_account_rights_export', [excess.id, 1, operation])).receipt.status, 'export_ready');
});