'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/support-receipts.sql'), 'utf8');
const memberA = '11111111-1111-4111-8111-111111111111';
const memberB = '22222222-2222-4222-8222-222222222222';
const staff = '33333333-3333-4333-8333-333333333333';
const policyRef = '44444444-4444-4444-8444-444444444444';

async function database(context) {
  const db = new PGlite();
  context.after(() => db.close());
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE ROLE public_probe;
    CREATE SCHEMA auth; GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role, public_probe;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`);
  await db.exec(migration);
  await db.query('INSERT INTO public.support_staff(uid) VALUES ($1)', [staff]);
  return db;
}

async function identity(db, role = 'service_role', uid = null) {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [uid || '']);
  await db.exec('SET ROLE ' + role);
}

async function configure(db, options = {}) {
  const policy = { collection: false, response: null, contact: null, retention: false, days: null, erasure: false, ref: null, ...options };
  return (await db.query('SELECT public.configure_support_policy($1,$2,$3,$4,$5,$6,$7) AS result',
    [policy.collection, policy.response, policy.contact, policy.retention, policy.days, policy.erasure, policy.ref])).rows[0].result;
}

async function openIntake(db, options = {}) {
  await identity(db);
  await configure(db, { collection: true, ref: policyRef, ...options });
}

async function submit(db, options = {}) {
  const request = { request: randomUUID(), subject: 'Payment not unlocked', body: 'I paid but Pro is missing.', evidence: null, ...options };
  return (await db.query('SELECT public.submit_support_case($1,$2,$3,$4) AS result',
    [request.request, request.subject, request.body, request.evidence])).rows[0].result;
}

async function reply(db, caseId, options = {}) {
  const request = { request: randomUUID(), body: 'Here is the receipt id.', evidence: null, ...options };
  return (await db.query('SELECT public.add_support_reply($1,$2,$3,$4) AS result',
    [caseId, request.request, request.body, request.evidence])).rows[0].result;
}

async function decide(db, caseId, options = {}) {
  const request = { version: 1, status: null, reply: null, note: null, request: randomUUID(), ...options };
  return (await db.query('SELECT public.staff_update_support_case($1,$2,$3,$4,$5,$6) AS result',
    [caseId, request.version, request.status, request.reply, request.note, request.request])).rows[0].result;
}

async function thread(db, caseId, cursor = {}) {
  return (await db.query('SELECT public.support_thread($1,$2,$3) AS result',
    [caseId, cursor.before || null, cursor.beforeId || null])).rows[0].result;
}

async function counts(db) {
  await db.exec('RESET ROLE');
  return (await db.query(`SELECT (SELECT count(*)::int FROM public.support_cases) AS cases,
    (SELECT count(*)::int FROM public.support_messages) AS messages,
    (SELECT count(*)::int FROM public.support_case_actions) AS actions`)).rows[0];
}

test('intake starts closed and no response time or staffed contact is published without an approval reference', async context => {
  const db = await database(context);
  await identity(db);
  const policy = (await db.query('SELECT * FROM public.support_policy')).rows[0];
  assert.equal(policy.collection_enabled, false);
  assert.equal(policy.response_expectation, null);
  assert.equal(policy.contact_channel, null);
  assert.equal(policy.retention_approved, false);
  assert.equal(policy.retention_days, null);
  assert.equal(policy.erasure_approved, false);

  await assert.rejects(configure(db, { collection: true }), { code: '23514' });
  await assert.rejects(configure(db, { response: 'We reply within an hour', ref: null }), { code: '23514' });
  await assert.rejects(configure(db, { contact: 'support@example.test', ref: null }), { code: '23514' });
  await assert.rejects(configure(db, { retention: true, ref: policyRef }), { code: '23514' });
  await assert.rejects(configure(db, { days: 30, ref: policyRef }), { code: '23514' });
  await assert.rejects(configure(db, { erasure: true, ref: null }), { code: '23514' });

  await identity(db, 'authenticated', memberA);
  const closed = (await db.query('SELECT public.support_settings() AS result')).rows[0].result;
  assert.deepEqual(closed, { collection_enabled: false, response_expectation: null, contact_channel: null, staff: false });
  await assert.rejects(submit(db), { code: 'PT503' });

  await openIntake(db, { response: 'Founder-operated; replies vary.' });
  await identity(db, 'authenticated', memberA);
  const open = (await db.query('SELECT public.support_settings() AS result')).rows[0].result;
  assert.equal(open.collection_enabled, true);
  assert.equal(open.response_expectation, 'Founder-operated; replies vary.');
  assert.equal(open.contact_channel, null);
  assert.equal((await counts(db)).cases, 0);
});

test('anonymous callers, other members and non-staff cannot read or change support data', async context => {
  const db = await database(context);
  await openIntake(db);
  await identity(db, 'authenticated', memberA);
  const receipt = await submit(db);

  await identity(db, 'anon');
  for (const table of ['support_policy', 'support_limits', 'support_staff', 'support_cases', 'support_messages', 'support_case_actions']) {
    await assert.rejects(db.query('SELECT * FROM public.' + table), { code: '42501' });
  }
  for (const call of ['public.support_settings()', 'public.can_staff_support()', 'public.my_support_cases()',
    `public.support_thread('${receipt.id}')`, 'public.support_queue()']) {
    await assert.rejects(db.query('SELECT ' + call), { code: '42501' });
  }
  await assert.rejects(configure(db), { code: '42501' });

  await identity(db, 'authenticated', memberB);
  assert.deepEqual((await db.query('SELECT public.my_support_cases() AS result')).rows[0].result, []);
  await assert.rejects(thread(db, receipt.id), { code: 'PT404' });
  await assert.rejects(reply(db, receipt.id), { code: 'PT404' });
  await assert.rejects(db.query('SELECT public.support_queue() AS result'), { code: 'PT403' });
  await assert.rejects(db.query('SELECT public.support_case_history($1) AS result', [receipt.id]), { code: 'PT403' });
  await assert.rejects(decide(db, receipt.id, { status: 'closed' }), { code: 'PT403' });
  await assert.rejects(configure(db, { collection: true, ref: policyRef }), { code: '42501' });
  for (const table of ['support_cases', 'support_messages', 'support_policy']) {
    await assert.rejects(db.query('SELECT * FROM public.' + table), { code: '42501' });
  }
  assert.deepEqual((await counts(db)), { cases: 1, messages: 1, actions: 0 });
});

test('a replayed request id returns the same receipt while a changed payload is a conflict', async context => {
  const db = await database(context);
  await openIntake(db);
  await identity(db, 'authenticated', memberA);
  const request = randomUUID();
  const first = await submit(db, { request });
  const replay = await submit(db, { request });
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.id, first.id);
  assert.equal(replay.request_id, request);
  assert.equal(replay.status, 'open');
  assert.equal(replay.version, 1);
  assert.equal('subject' in replay, false);
  assert.equal('body' in replay, false);

  await assert.rejects(submit(db, { request, body: 'A deliberately different message.' }), { code: 'PT409' });
  await assert.rejects(submit(db, { request, subject: 'A different subject' }), { code: 'PT409' });
  await assert.rejects(submit(db, { request, evidence: ['order-1'] }), { code: 'PT409' });
  assert.deepEqual(await counts(db), { cases: 1, messages: 1, actions: 0 });

  await identity(db, 'authenticated', memberB);
  const other = await submit(db, { request });
  assert.notEqual(other.id, first.id);
  assert.deepEqual(await counts(db), { cases: 2, messages: 2, actions: 0 });
});

test('a request id used for one action is never reused for a different kind of write', async context => {
  const db = await database(context);
  await openIntake(db);
  await identity(db, 'authenticated', memberA);
  const submitRequest = randomUUID();
  const receipt = await submit(db, { request: submitRequest });
  await assert.rejects(reply(db, receipt.id, { request: submitRequest }), { code: 'PT409' });

  const replyRequest = randomUUID();
  await reply(db, receipt.id, { request: replyRequest, body: 'Adding one more detail.' });
  await assert.rejects(submit(db, { request: replyRequest }), { code: 'PT409' });
  assert.deepEqual(await counts(db), { cases: 1, messages: 2, actions: 1 });
});

test('a failing message write rolls the whole submission back and leaves no orphan case', async context => {
  const db = await database(context);
  await openIntake(db);
  await db.exec('RESET ROLE');
  await db.exec(`CREATE FUNCTION public.support_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$;
    CREATE TRIGGER support_test_fail BEFORE INSERT ON public.support_messages FOR EACH ROW EXECUTE FUNCTION public.support_test_fail();`);
  await identity(db, 'authenticated', memberA);
  const request = randomUUID();
  await assert.rejects(submit(db, { request }), /injected failure/);
  assert.deepEqual(await counts(db), { cases: 0, messages: 0, actions: 0 });

  await db.exec('DROP TRIGGER support_test_fail ON public.support_messages');
  await identity(db, 'authenticated', memberA);
  const receipt = await submit(db, { request });
  assert.equal(receipt.duplicate, false);
  assert.deepEqual(await counts(db), { cases: 1, messages: 1, actions: 0 });
});

test('owner receipts page by a stable keyset cursor through created_at ties without gaps or leaks', async context => {
  const db = await database(context);
  await openIntake(db);
  await db.exec('RESET ROLE');
  const owned = [];
  for (let index = 0; index < 60; index++) {
    const id = randomUUID();
    owned.push(id);
    await db.query(`INSERT INTO public.support_cases(id, owner, request_id, subject, payload_digest, created_at, updated_at, message_count)
      VALUES ($1,$2,$3,$4,$5, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1)`,
    [id, memberA, randomUUID(), 'Tied case ' + index, id.replace(/-/g, '')]);
  }
  await db.query(`INSERT INTO public.support_cases(id, owner, request_id, subject, payload_digest, created_at, updated_at)
    VALUES ($1,$2,$3,'Other member case',$4, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  [randomUUID(), memberB, randomUUID(), memberB.replace(/-/g, '')]);

  await identity(db, 'authenticated', memberA);
  const first = (await db.query('SELECT public.my_support_cases() AS result')).rows[0].result;
  assert.equal(first.length, 50);
  const last = first.at(-1);
  const second = (await db.query('SELECT public.my_support_cases($1,$2) AS result', [last.created_at, last.id])).rows[0].result;
  assert.equal(second.length, 10);
  const seen = [...first, ...second].map(row => row.id);
  assert.equal(new Set(seen).size, 60);
  assert.deepEqual([...seen].sort(), [...owned].sort());
  const descending = seen.every((id, index) => index === 0 || seen[index - 1] > id);
  assert.equal(descending, true, 'ties must resolve by a descending id so no row repeats or disappears');
  const third = (await db.query('SELECT public.my_support_cases($1,$2) AS result',
    [second.at(-1).created_at, second.at(-1).id])).rows[0].result;
  assert.deepEqual(third, []);
  await assert.rejects(db.query('SELECT public.my_support_cases($1,NULL) AS result', [last.created_at]), { code: '22023' });
});

test('internal notes stay isolated from the member thread while staff see the whole case', async context => {
  const db = await database(context);
  await openIntake(db);
  await identity(db, 'authenticated', memberA);
  const receipt = await submit(db, { evidence: ['order-9001'] });

  await identity(db, 'authenticated', staff);
  await decide(db, receipt.id, { version: 1, status: 'waiting_customer', reply: 'Could you send the payment id?', note: 'Checked the ledger; no matching row.' });

  await identity(db, 'authenticated', memberA);
  const memberView = await thread(db, receipt.id);
  assert.equal(memberView.case.status, 'waiting_customer');
  assert.equal(memberView.case.owner, null);
  assert.equal(memberView.messages.length, 2);
  assert.equal(memberView.messages.every(message => message.visibility === 'thread'), true);
  assert.equal(memberView.messages.every(message => message.author === null), true);
  assert.deepEqual(memberView.messages.map(message => message.author_role), ['member', 'staff']);
  assert.deepEqual(memberView.messages[0].evidence, ['order-9001']);
  assert.equal(JSON.stringify(memberView).includes('Checked the ledger'), false);

  await identity(db, 'authenticated', staff);
  const staffView = await thread(db, receipt.id);
  assert.equal(staffView.messages.length, 3);
  assert.equal(staffView.case.owner, memberA);
  assert.equal(staffView.messages.filter(message => message.visibility === 'internal').length, 1);
  assert.equal(staffView.messages.at(-1).author, staff);

  await identity(db, 'authenticated', memberB);
  await assert.rejects(thread(db, receipt.id), { code: 'PT404' });
});

test('staff decisions are version checked and only the allowed status moves are accepted', async context => {
  const db = await database(context);
  await openIntake(db);
  await identity(db, 'authenticated', memberA);
  const receipt = await submit(db);

  await identity(db, 'authenticated', staff);
  await assert.rejects(decide(db, receipt.id, { version: 1, status: 'open', reply: null, note: null }), { code: '22023' });
  await assert.rejects(decide(db, receipt.id, { version: 1, status: 'archived', note: 'x' }), { code: '22023' });
  await assert.rejects(decide(db, receipt.id, { version: 2, status: 'in_progress', note: 'stale' }), { code: 'PT409' });

  let version = 1;
  for (const [from, to, allowed] of [['open', 'resolved', true], ['resolved', 'waiting_customer', false],
    ['resolved', 'in_progress', true], ['in_progress', 'waiting_customer', true],
    ['waiting_customer', 'open', false], ['waiting_customer', 'closed', true],
    ['closed', 'resolved', false], ['closed', 'in_progress', true]]) {
    const current = (await db.query('SELECT public.support_thread($1) AS result', [receipt.id])).rows[0].result.case;
    assert.equal(current.status, from);
    assert.equal(current.version, version);
    if (!allowed) {
      await assert.rejects(decide(db, receipt.id, { version, status: to, note: 'blocked move' }), { code: '22023' });
      continue;
    }
    const result = await decide(db, receipt.id, { version, status: to, note: 'moving to ' + to });
    assert.equal(result.status, to);
    assert.equal(result.version, version + 1);
    version += 1;
  }

  const history = (await db.query('SELECT public.support_case_history($1) AS result', [receipt.id])).rows[0].result;
  assert.equal(history.length, 5);
  assert.deepEqual(history.map(action => action.previous_version), [5, 4, 3, 2, 1]);
  assert.equal(history.every(action => action.actor === staff && action.actor_role === 'staff'), true);
  assert.equal(JSON.stringify(history).includes('moving to'), false, 'history must not republish note prose');
});

test('a member reply reopens a waiting case, is idempotent, and a closed case needs a new request', async context => {
  const db = await database(context);
  await openIntake(db);
  await identity(db, 'authenticated', memberA);
  const receipt = await submit(db);

  await identity(db, 'authenticated', staff);
  await decide(db, receipt.id, { version: 1, status: 'waiting_customer', reply: 'Send the payment id please.' });

  await identity(db, 'authenticated', memberA);
  const request = randomUUID();
  const reopened = await reply(db, receipt.id, { request });
  assert.equal(reopened.status, 'in_progress');
  assert.equal(reopened.version, 3);
  assert.equal(reopened.duplicate, false);
  const replay = await reply(db, receipt.id, { request });
  assert.deepEqual(replay, { id: receipt.id, status: 'in_progress', version: 3, duplicate: true });
  await assert.rejects(reply(db, receipt.id, { request, body: 'A different follow-up message.' }), { code: 'PT409' });
  assert.deepEqual(await counts(db), { cases: 1, messages: 3, actions: 2 });

  await identity(db, 'authenticated', memberA);
  const stillOpen = await reply(db, receipt.id, { body: 'One more detail.' });
  assert.equal(stillOpen.status, 'in_progress', 'a reply on an active case must not invent a status change');

  await identity(db, 'authenticated', staff);
  await decide(db, receipt.id, { version: 4, status: 'closed', note: 'resolved on the call' });
  await identity(db, 'authenticated', memberA);
  await assert.rejects(reply(db, receipt.id), { code: 'PT409' });
});

test('revoking staff membership denies the next action even mid-workflow', async context => {
  const db = await database(context);
  await openIntake(db);
  await identity(db, 'authenticated', memberA);
  const receipt = await submit(db);

  await identity(db, 'authenticated', staff);
  assert.equal((await db.query('SELECT public.can_staff_support() AS result')).rows[0].result, true);
  const queue = (await db.query('SELECT public.support_queue($1) AS result', ['open'])).rows[0].result;
  assert.equal(queue.length, 1);
  await decide(db, receipt.id, { version: 1, status: 'in_progress', note: 'starting' });

  await db.exec('RESET ROLE');
  await db.query('UPDATE public.support_staff SET enabled = false WHERE uid = $1', [staff]);
  await identity(db, 'authenticated', staff);
  assert.equal((await db.query('SELECT public.can_staff_support() AS result')).rows[0].result, false);
  await assert.rejects(db.query('SELECT public.support_queue() AS result'), { code: 'PT403' });
  await assert.rejects(db.query('SELECT public.support_case_history($1) AS result', [receipt.id]), { code: 'PT403' });
  await assert.rejects(decide(db, receipt.id, { version: 2, status: 'closed', note: 'after revocation' }), { code: 'PT403' });
  await assert.rejects(thread(db, receipt.id), { code: 'PT404' });
  assert.deepEqual(await counts(db), { cases: 1, messages: 2, actions: 1 });
});

test('payload size, evidence shape and message rates stay bounded per requester and case', async context => {
  const db = await database(context);
  await openIntake(db);
  await identity(db, 'authenticated', memberA);
  await assert.rejects(submit(db, { body: '   ' }), { code: '22023' });
  await assert.rejects(submit(db, { subject: 'x'.repeat(121) }), { code: '22023' });
  await assert.rejects(submit(db, { body: 'x'.repeat(2001) }), { code: '22023' });
  await assert.rejects(submit(db, { evidence: ['a', 'b', 'c', 'd', 'e', 'f'] }), { code: '22023' });
  await assert.rejects(submit(db, { evidence: ['  '] }), { code: '22023' });
  await assert.rejects(submit(db, { evidence: ['x'.repeat(121)] }), { code: '22023' });
  await assert.rejects(submit(db, { evidence: [null] }), { code: '22023' });
  assert.deepEqual(await counts(db), { cases: 0, messages: 0, actions: 0 });

  await identity(db, 'authenticated', memberA);
  const receipt = await submit(db, { evidence: ['  order-1  ', 'txn-2'] });
  const stored = await thread(db, receipt.id);
  assert.deepEqual(stored.messages[0].evidence, ['order-1', 'txn-2']);

  await db.exec('RESET ROLE');
  await db.query('UPDATE public.support_limits SET owner_messages_per_minute = 3, case_messages_total = 4');
  await identity(db, 'authenticated', memberA);
  await reply(db, receipt.id, { body: 'Reply one' });
  await reply(db, receipt.id, { body: 'Reply two' });
  await assert.rejects(reply(db, receipt.id, { body: 'Reply three' }), { code: 'PT429' });

  await db.exec('RESET ROLE');
  await db.query('UPDATE public.support_limits SET owner_cases_per_day = 1');
  await identity(db, 'authenticated', memberA);
  await assert.rejects(submit(db), { code: 'PT429' });
  assert.equal((await counts(db)).cases, 1);
});

test('a replayed staff request id never repeats a decision and a changed decision conflicts', async context => {
  const db = await database(context);
  await openIntake(db);
  await identity(db, 'authenticated', memberA);
  const receipt = await submit(db);

  await identity(db, 'authenticated', staff);
  const request = randomUUID();
  const decision = { version: 1, status: 'in_progress', reply: 'Looking into this now.', note: 'ledger check pending', request };
  const first = await decide(db, receipt.id, decision);
  const replay = await decide(db, receipt.id, decision);
  assert.equal(first.duplicate, false);
  assert.deepEqual(replay, { id: receipt.id, status: 'in_progress', version: 2, duplicate: true });
  await assert.rejects(decide(db, receipt.id, { ...decision, note: 'a different note' }), { code: 'PT409' });
  await assert.rejects(decide(db, receipt.id, { ...decision, status: 'closed' }), { code: 'PT409' });
  assert.deepEqual(await counts(db), { cases: 1, messages: 3, actions: 1 });

  await identity(db, 'authenticated', memberA);
  const memberView = await thread(db, receipt.id);
  assert.equal(memberView.messages.length, 2);
  assert.equal(memberView.case.version, 2);
});

const closure = migration.match(/DO \$permissions\$[\s\S]*?\$permissions\$;/)[0];
const memberCalls = ['add_support_reply', 'can_staff_support', 'my_support_cases', 'staff_update_support_case',
  'submit_support_case', 'support_case_history', 'support_queue', 'support_settings', 'support_thread'];
const helperCalls = ['support_clean_evidence', 'support_digest', 'support_intake_guard'];
const serviceCalls = ['configure_support_policy'];
const serviceTables = { support_policy: 'SELECT,UPDATE', support_limits: 'SELECT,UPDATE',
  support_staff: 'SELECT,INSERT,UPDATE,DELETE', support_cases: 'SELECT', support_messages: 'SELECT', support_case_actions: 'SELECT' };

test('every support RPC and table is denied to PUBLIC and to every role the grants did not name', async context => {
  const db = await database(context);
  await db.exec('RESET ROLE');
  const everyCall = [...memberCalls, ...helperCalls, ...serviceCalls];
  const everyTable = Object.keys(serviceTables);
  const functions = (await db.query(
    "SELECT oid, proname, proconfig FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname = ANY($1) ORDER BY proname", [everyCall])).rows;
  const tables = (await db.query(
    "SELECT oid, relname, relrowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname = ANY($1) ORDER BY relname", [everyTable])).rows;
  assert.equal(memberCalls.length, 9, 'exactly nine RPCs are meant to be callable by a signed-in member');
  assert.equal(functions.length, everyCall.length, 'the migration must define every function this gate names');
  assert.equal(tables.length, everyTable.length);

  for (const role of ['public_probe', 'anon', 'authenticated', 'service_role']) {
    for (const entry of functions) {
      const granted = (await db.query("SELECT has_function_privilege($1,$2::oid,'EXECUTE') AS granted", [role, entry.oid])).rows[0].granted;
      assert.equal(granted, (role === 'authenticated' && memberCalls.includes(entry.proname))
        || (role === 'service_role' && serviceCalls.includes(entry.proname)), role + ':' + entry.proname);
      assert.ok(entry.proconfig.includes('search_path=""'), entry.proname + ' must pin an empty search_path');
    }
    for (const table of tables) {
      assert.equal(table.relrowsecurity, true, table.relname + ' must enable row level security');
      assert.equal((await db.query('SELECT count(*)::int AS policies FROM pg_policy WHERE polrelid=$1::oid', [table.oid])).rows[0].policies, 0);
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        const granted = (await db.query('SELECT has_table_privilege($1,$2::oid,$3) AS granted', [role, table.oid, privilege])).rows[0].granted;
        assert.equal(granted, role === 'service_role' && serviceTables[table.relname].includes(privilege), role + ':' + table.relname + ':' + privilege);
      }
      if (role !== 'service_role') {
        assert.equal((await db.query("SELECT has_any_column_privilege($1,$2::oid,'SELECT,INSERT,UPDATE,REFERENCES') AS granted",
          [role, table.oid])).rows[0].granted, false, role + ' must hold no column privilege on ' + table.relname);
      }
    }
  }
  const publicGrants = (await db.query(
    `SELECT proname AS name FROM pg_proc, aclexplode(coalesce(proacl, acldefault('f', proowner)))
       WHERE pronamespace='public'::regnamespace AND proname = ANY($1) AND grantee = 0
     UNION ALL
     SELECT relname FROM pg_class, aclexplode(coalesce(relacl, acldefault('r', relowner)))
       WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname = ANY($2) AND grantee = 0`,
    [everyCall, everyTable])).rows;
  assert.deepEqual(publicGrants, [], 'no support object may keep a PUBLIC grantee entry');
  await db.exec(closure);
});

test('inherited privilege escalation aborts the migration transaction', async context => {
  const db = await database(context);
  await openIntake(db);
  await identity(db, 'authenticated', memberA);
  const receipt = await submit(db);
  const policyCall = 'public.configure_support_policy(boolean,text,text,boolean,integer,boolean,uuid)';
  const memberCall = 'public.my_support_cases(timestamptz,uuid)';
  const executes = async (role, call) => (await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS granted", [role, call])).rows[0].granted;

  await db.exec('RESET ROLE; GRANT service_role TO authenticated');
  await assert.rejects(db.exec(closure), { code: '42501' });
  assert.equal(await executes('authenticated', policyCall), true,
    'the escalation really does confer the service RPC, so aborting the migration is the control here, not a second code check');

  await db.exec('RESET ROLE; REVOKE service_role FROM authenticated; GRANT authenticated TO anon');
  await assert.rejects(db.exec(closure), { code: '42501' });
  assert.equal(await executes('anon', memberCall), true);
  assert.equal(await executes('anon', policyCall), false);

  await db.exec(`RESET ROLE; REVOKE authenticated FROM anon; CREATE ROLE support_inherited;
    GRANT support_inherited TO authenticated;
    GRANT SELECT ON public.support_cases, public.support_messages TO support_inherited`);
  await assert.rejects(db.exec(closure), { code: '42501' });
  assert.equal((await db.query("SELECT has_table_privilege('authenticated','public.support_messages','SELECT') AS granted")).rows[0].granted, true);

  await db.exec(`RESET ROLE; REVOKE SELECT ON public.support_cases, public.support_messages FROM support_inherited;
    REVOKE support_inherited FROM authenticated`);
  await db.exec(closure);
  await identity(db, 'authenticated', memberA);
  assert.equal((await thread(db, receipt.id)).case.id, receipt.id, 'the intended member path still works once the gate passes');
});
