'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/moderation-receipts.sql'), 'utf8');
const reporter = '11111111-1111-4111-8111-111111111111';
const subject = '22222222-2222-4222-8222-222222222222';
const moderator = '33333333-3333-4333-8333-333333333333';

async function database(context) {
  const db = new PGlite(); context.after(() => db.close());
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE public.posts(id text PRIMARY KEY, author text); CREATE TABLE public.comments(id text PRIMARY KEY, author text);
    CREATE TABLE public.profiles(uid text PRIMARY KEY);
    INSERT INTO public.posts VALUES ('post-1','${subject}'); INSERT INTO public.comments VALUES ('comment-1','${subject}');
    INSERT INTO public.profiles VALUES ('${subject}');`);
  await db.exec(migration);
  await db.query('INSERT INTO report_moderators(uid) VALUES($1)', [moderator]);
  await identity(db, reporter);
  return db;
}
async function identity(db, uid, role = 'authenticated') {
  await db.exec('RESET ROLE'); await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [uid || '']);
  await db.exec('SET ROLE ' + role);
}
async function submit(db, request = randomUUID(), kind = 'post', target = 'post-1', reason = 'Spam or scam') {
  return (await db.query('SELECT submit_report($1,$2,$3,$4) AS result', [request, kind, target, reason])).rows[0].result;
}
async function rpc(db, name) { return (await db.query('SELECT ' + name + '() AS result')).rows[0].result; }
async function review(db, receipt, status, note = 'Evidence reviewed', request = randomUUID()) {
  return (await db.query('SELECT review_report($1,$2,$3,$4,$5) AS result', [receipt.id, receipt.version, status, note, request])).rows[0].result;
}

test('report retries return one owner-scoped receipt without exposing reporter or target details', async context => {
  const db = await database(context), request = randomUUID();
  const first = await submit(db, request);
  assert.deepEqual(await submit(db, request), first);
  assert.equal(first.status, 'received'); assert.equal(first.version, 1);
  assert.deepEqual(Object.keys(first).sort(), ['created_at','id','kind','request_id','status','updated_at','version'].sort());
  assert.equal((await rpc(db, 'my_report_receipts')).length, 1);
  await assert.rejects(submit(db, request, 'post','post-1','Changed payload'), { code: 'PT409' });
  await identity(db, subject); assert.deepEqual(await rpc(db, 'my_report_receipts'), []);
  await assert.rejects(db.query('SELECT * FROM report_cases'), { code: '42501' });
});

test('identity, target validation and server rate limits reject unsafe new reports but not exact retries', async context => {
  const db = await database(context), firstId = randomUUID();
  await identity(db, null); await assert.rejects(submit(db), { code: 'PT401' });
  await identity(db, null, 'anon'); await assert.rejects(submit(db), { code: '42501' });
  await identity(db, reporter);
  await assert.rejects(submit(db, randomUUID(), 'invalid'), { code: '22023' });
  await assert.rejects(submit(db, randomUUID(), 'post', 'missing'), { code: 'PT404' });
  await assert.rejects(submit(db, randomUUID(), 'post', 'post-1', ' '), { code: '22023' });
  const first = await submit(db, firstId);
  for (let index = 1; index < 10; index++) await submit(db);
  await assert.rejects(submit(db), { code: 'PT429' });
  assert.deepEqual(await submit(db, firstId), first);
});

test('only authorized moderators can perform versioned, audited, idempotent decisions', async context => {
  const db = await database(context), receipt = await submit(db);
  assert.equal(await rpc(db, 'can_review_reports'), false);
  await assert.rejects(rpc(db, 'moderation_queue'), { code: 'PT403' });
  await assert.rejects(review(db, receipt, 'under_review'), { code: 'PT403' });
  await identity(db, moderator); assert.equal(await rpc(db, 'can_review_reports'), true);
  const queue = await rpc(db, 'moderation_queue'); assert.equal(queue.length, 1); assert.equal(queue[0].reporter, undefined);
  await assert.rejects(review(db, receipt, 'closed'), { code: '22023' });
  const request = randomUUID(), updated = await review(db, receipt, 'under_review', 'Evidence checked', request);
  assert.equal(updated.version, 2);
  assert.equal((await review(db, receipt, 'under_review', 'Evidence checked', request)).duplicate, true);
  await assert.rejects(review(db, receipt, 'under_review'), { code: 'PT409' });
  await assert.rejects(review(db, receipt, 'under_review', 'Different', request), { code: 'PT409' });
  const decision = await review(db, updated, 'no_action'); const closed = await review(db, decision, 'closed');
  assert.equal(closed.version, 4);
  await identity(db, reporter); assert.equal((await rpc(db, 'my_report_receipts'))[0].status, 'closed');
  await db.exec('RESET ROLE');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM report_case_actions')).rows[0].count, 3);
});

test('moderator removal takes effect immediately and decision/audit writes roll back together', async context => {
  const db = await database(context), receipt = await submit(db);
  await identity(db, moderator);
  await db.exec("RESET ROLE; ALTER TABLE report_case_actions ADD CONSTRAINT reject_note CHECK (note <> 'fail')");
  await identity(db, moderator);
  await assert.rejects(review(db, receipt, 'under_review', 'fail'), { code: '23514' });
  assert.equal((await rpc(db, 'moderation_queue'))[0].version, 1);
  await db.exec(`RESET ROLE; UPDATE report_moderators SET enabled=false WHERE uid='${moderator}'`);
  await identity(db, moderator); await assert.rejects(rpc(db, 'moderation_queue'), { code: 'PT403' });
});

test('target limits apply across reporters, preserve exact retries and do not alter content', async context => {
  const db = await database(context), request = randomUUID();
  await assert.rejects(db.query('UPDATE report_limits SET target_per_minute=1'), { code: '42501' });
  await identity(db, null, 'service_role');
  await db.query('UPDATE report_limits SET target_per_minute=2, target_per_day=3');
  await identity(db, reporter); const first = await submit(db, request);
  await identity(db, moderator); await submit(db);
  await identity(db, randomUUID()); await assert.rejects(submit(db), { code: 'PT429' });
  await identity(db, reporter); assert.deepEqual(await submit(db, request), first);
  await db.exec("RESET ROLE; UPDATE report_cases SET created_at=clock_timestamp()-interval '2 minutes'");
  await identity(db, randomUUID()); await submit(db);
  await identity(db, randomUUID()); await assert.rejects(submit(db), { code: 'PT429' });
  assert.equal((await submit(db, randomUUID(), 'comment', 'comment-1')).kind, 'comment');
  await db.exec('RESET ROLE');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM posts')).rows[0].count, 1);
  await db.exec("UPDATE report_cases SET created_at=clock_timestamp()-interval '2 days'");
  await identity(db, randomUUID()); assert.equal((await submit(db)).status, 'received');
});

test('receipt and moderator pagination preserve tied timestamp precision and owner isolation', async context => {
  const db = await database(context);
  await db.exec('RESET ROLE');
  for (let index = 0; index < 51; index++) {
    await db.query("INSERT INTO report_cases(reporter,request_id,kind,target_id,reported_uid,reason,created_at) VALUES($1,$2,'post','post-1',$3,'Fixture','2026-09-01T10:00:00.123456Z')", [reporter, randomUUID(), subject]);
  }
  const expected = (await db.query('SELECT id FROM report_cases ORDER BY created_at DESC,id DESC')).rows.map(row => row.id);
  for (const [name, owner] of [['my_report_receipts', reporter], ['moderation_queue', moderator]]) {
    await identity(db, owner);
    const first = await rpc(db, name), last = first.at(-1);
    assert.equal(first.length, 50); assert.match(last.created_at, /\.123456/);
    const prefix = name === 'moderation_queue' ? 'NULL,' : '';
    const second = (await db.query('SELECT '+name+'('+prefix+'$1,$2) AS result', [last.created_at,last.id])).rows[0].result;
    assert.equal(second.length, 1); assert.deepEqual([...first,...second].map(row=>row.id),expected);
    await assert.rejects(db.query('SELECT '+name+'('+prefix+'$1,NULL)',[last.created_at]), { code:'22023' });
  }
  await identity(db, subject); assert.deepEqual(await rpc(db, 'my_report_receipts'), []);
});

test('decision history is moderator-only, paginated, retains actors and never exposes reporter identity', async context => {
  const db = await database(context), receipt = await submit(db);
  const history = async (before = null) => (await db.query('SELECT report_decision_history($1,$2) AS result', [receipt.id,before])).rows[0].result;
  await assert.rejects(history(), {code:'PT403'});
  await identity(db, subject); await assert.rejects(history(), {code:'PT403'});
  await identity(db, moderator); assert.deepEqual(await history(), []);
  let current = receipt;
  const next = {received:'under_review',under_review:'no_action',no_action:'closed',closed:'under_review'};
  for (let index = 0; index < 51; index++) current = await review(db,current,next[current.status],'Decision '+index);
  const first = await history(), last = first.at(-1), second = await history(last.previous_version);
  assert.equal(first.length,50); assert.equal(second.length,1);
  assert.equal(new Set([...first,...second].map(row=>row.id)).size,51);
  assert.ok(first.every(row=>row.actor===moderator && row.reporter===undefined && row.request_id===undefined));
  assert.equal(first[0].previous_version,51); assert.equal(second[0].previous_version,1);
  assert.equal(first[0].note,'Decision 50');
  await assert.rejects(history(0), {code:'22023'});
  await db.exec(`RESET ROLE; UPDATE report_moderators SET enabled=false WHERE uid='${moderator}'`);
  await identity(db,moderator); await assert.rejects(history(), {code:'PT403'});
});