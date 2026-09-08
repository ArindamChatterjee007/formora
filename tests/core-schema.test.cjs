'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.resolve(__dirname, '..');
const bootstrap = fs.readFileSync(path.join(root, 'supabase/core-schema.sql'), 'utf8');
const security = fs.readFileSync(path.join(root, 'supabase/security.sql'), 'utf8');
const requestActions = fs.readFileSync(path.join(root, 'supabase/request-actions.sql'), 'utf8');
const owner = '11111111-1111-4111-8111-111111111111';
const peer = '22222222-2222-4222-8222-222222222222';
const stranger = '33333333-3333-4333-8333-333333333333';
let database;

async function freshCore({ requests = true } = {}) {
  const instance = new PGlite();
  try {
    await instance.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO authenticated;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`);
    await instance.exec(bootstrap);
    await instance.exec('BEGIN;\n' + security + '\nCOMMIT;');
    if (requests) await instance.exec(requestActions);
    return instance;
  } catch (error) { await instance.close(); throw error; }
}

test.before(async () => { database = await freshCore(); });
test.after(async () => { await database?.close(); });

async function asMember(uid) {
  await database.exec('RESET ROLE');
  await database.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [uid]);
  await database.exec('SET ROLE authenticated');
}

test('Fresh core installation reuses the canonical security migration and starts with no member data', async () => {
  const rows = (await database.query("SELECT relname, relrowsecurity FROM pg_class JOIN pg_namespace ON pg_namespace.oid=pg_class.relnamespace WHERE nspname='public' AND relkind='r' ORDER BY relname")).rows;
  assert.equal(rows.length, 11);
  assert.ok(rows.every(row => row.relrowsecurity));
  for (const row of rows) assert.equal((await database.query('SELECT count(*)::int AS count FROM public.' + row.relname)).rows[0].count, 0);
  await database.exec('SET ROLE anon');
  for (const table of ['accounts', 'profiles', 'messages', 'notifications', 'entitlements', 'billing_events']) {
    await assert.rejects(database.query('SELECT * FROM public.' + table), { code: '42501' });
  }
  await assert.rejects(database.query('SELECT public.get_state()'), { code: '42501' });
  await database.exec('RESET ROLE');
  const grants = (await database.query("SELECT has_function_privilege('anon','public.get_state()','EXECUTE') AS anonymous, has_function_privilege('authenticated','public.get_state()','EXECUTE') AS member")).rows[0];
  assert.deepEqual(grants, { anonymous: false, member: true });
});

test('Canonical account ownership, private messages and entitlement reads work on a fresh core', async () => {
  await asMember(owner);
  await database.query('INSERT INTO accounts(uid,data) VALUES($1,$2)', [owner, { profile: { name: 'Synthetic QAT owner' } }]);
  await database.query('INSERT INTO profiles(uid,data,updated_at) VALUES($1,$2,now())', [owner, { name: 'Synthetic QAT owner' }]);
  await database.query('INSERT INTO posts(id,author,data) VALUES($1,$2,$3)', ['core-post', owner, { text: 'Synthetic fixture' }]);
  await database.query('INSERT INTO messages(id,from_uid,to_uid,body) VALUES($1,$2,$3,$4)', ['core-message', owner, peer, 'Synthetic private fixture']);
  assert.equal((await database.query('SELECT * FROM entitlements')).rows.length, 0);
  await assert.rejects(database.query('INSERT INTO entitlements(uid,tier) VALUES($1,$2)', [owner, 'elite']), { code: '42501' });
  await assert.rejects(database.query('INSERT INTO posts(id,author) VALUES($1,$2)', ['spoofed-post', peer]), { code: '42501' });
  const feed = (await database.query('SELECT get_state() AS data')).rows[0].data;
  assert.deepEqual(Object.keys(feed).sort(), ['comments', 'posts', 'requests', 'stories', 'users']);
  assert.ok(Number.isFinite(feed.posts['core-post'].ts));
  assert.ok(feed.users[owner]);
  await asMember(peer);
  assert.deepEqual((await database.query('SELECT * FROM accounts')).rows, []);
  assert.equal((await database.query("UPDATE accounts SET data='{}' WHERE uid=$1 RETURNING uid", [owner])).rows.length, 0);
  assert.equal((await database.query('SELECT body FROM messages')).rows[0].body, 'Synthetic private fixture');
  await asMember(stranger);
  assert.deepEqual((await database.query('SELECT * FROM messages')).rows, []);
  await asMember(owner);
  assert.equal((await database.query('SELECT data FROM accounts WHERE uid=$1', [owner])).rows[0].data.profile.name, 'Synthetic QAT owner');
  await database.exec('RESET ROLE');
});

test('Connection requests acknowledge recipient acceptance and participant removal', async () => {
  const requestId = owner + '__' + peer;
  await asMember(owner);
  await database.query('INSERT INTO requests(id,from_uid,to_uid,status) VALUES($1,$2,$3,$4)',
    [requestId, owner, peer, 'pending']);
  const visible = (await database.query('SELECT get_state() AS data')).rows[0].data.requests[requestId];
  assert.equal(visible.id, requestId);
  assert.equal(visible.from, owner);
  assert.equal(visible.to, peer);
  assert.equal(visible.status, 'pending');
  await asMember(peer);
  assert.deepEqual((await database.query("UPDATE requests SET status='accepted' WHERE id=$1 RETURNING id,status", [requestId])).rows,
    [{ id: requestId, status: 'accepted' }]);
  await asMember(stranger);
  assert.deepEqual((await database.query('SELECT * FROM requests WHERE id=$1', [requestId])).rows, []);
  assert.equal((await database.query('SELECT get_state() AS data')).rows[0].data.requests[requestId], undefined);
  assert.deepEqual((await database.query('DELETE FROM requests WHERE id=$1 RETURNING id', [requestId])).rows, []);
  await asMember(owner);
  assert.deepEqual((await database.query('DELETE FROM requests WHERE id=$1 RETURNING id', [requestId])).rows, [{ id: requestId }]);
  await database.exec('RESET ROLE');
});

test('Connection requests reject actor and ID spoofing, self-acceptance and identity changes', async () => {
  const requestId = owner + '__' + peer;
  await asMember(owner);
  for (const payload of [
    [stranger + '__' + peer, stranger, peer, 'pending'],
    [stranger + '__' + peer, owner, peer, 'pending'],
    [owner + '__' + owner, owner, owner, 'pending'],
    [requestId, owner, peer, 'accepted']
  ]) await assert.rejects(database.query('INSERT INTO requests(id,from_uid,to_uid,status) VALUES($1,$2,$3,$4)', payload), { code: '42501' });
  await database.query('INSERT INTO requests(id,from_uid,to_uid,status) VALUES($1,$2,$3,$4)', [requestId, owner, peer, 'pending']);
  assert.deepEqual((await database.query("UPDATE requests SET status='accepted' WHERE id=$1 RETURNING id", [requestId])).rows, []);
  await asMember(stranger);
  assert.deepEqual((await database.query("UPDATE requests SET status='accepted' WHERE id=$1 RETURNING id", [requestId])).rows, []);
  await asMember(peer);
  for (const column of ['id', 'from_uid', 'to_uid']) {
    await assert.rejects(database.query('UPDATE requests SET ' + column + '=$1 WHERE id=$2', [stranger, requestId]), { code: '42501' });
  }
  await assert.rejects(database.query('UPDATE requests SET ts=now() WHERE id=$1', [requestId]), { code: '42501' });
  await assert.rejects(database.query("UPDATE requests SET status='pending' WHERE id=$1", [requestId]), { code: '42501' });
  assert.deepEqual((await database.query('DELETE FROM requests WHERE id=$1 RETURNING id', [requestId])).rows, [{ id: requestId }]);
  await database.exec('RESET ROLE');
});

test('Connection request retries do not reset an accepted connection or require identity updates', async () => {
  const requestId = owner + '__' + peer;
  const insert = 'INSERT INTO requests(id,from_uid,to_uid,status) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING RETURNING id';
  const payload = [requestId, owner, peer, 'pending'];
  await asMember(owner);
  assert.deepEqual((await database.query(insert, payload)).rows, [{ id: requestId }]);
  assert.deepEqual((await database.query(insert, payload)).rows, []);
  await asMember(peer);
  await database.query("UPDATE requests SET status='accepted' WHERE id=$1", [requestId]);
  await asMember(owner);
  assert.deepEqual((await database.query(insert, payload)).rows, []);
  assert.equal((await database.query('SELECT status FROM requests WHERE id=$1', [requestId])).rows[0].status, 'accepted');
  await database.query('DELETE FROM requests WHERE id=$1', [requestId]);
  await database.exec('RESET ROLE');
});

test('The request migration refuses unknown or already-applied policy baselines without changes', async () => {
  await database.exec('RESET ROLE');
  const before = (await database.query("SELECT policyname,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' AND tablename='requests' ORDER BY policyname")).rows;
  await assert.rejects(database.exec(requestActions), { code: '55000' });
  await database.exec('ROLLBACK');
  assert.deepEqual((await database.query("SELECT policyname,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' AND tablename='requests' ORDER BY policyname")).rows, before);
  assert.equal((await database.query("SELECT has_table_privilege('authenticated','public.requests','UPDATE') AS broad")).rows[0].broad, false);
});

for (const incompatible of ['security-definer feed', 'legacy request identity']) {
  test('The request migration refuses ' + incompatible + ' without rewriting it', async context => {
    const instance = await freshCore({ requests: false });
    context.after(() => instance.close());
    if (incompatible === 'security-definer feed') await instance.exec('ALTER FUNCTION public.get_state() SECURITY DEFINER');
    else await instance.query('INSERT INTO public.requests(id,from_uid,to_uid,status) VALUES($1,$2,$3,$4)', ['legacy-row', 'old-email-slug', peer, 'pending']);
    const rows = (await instance.query('SELECT * FROM public.requests')).rows;
    const policies = (await instance.query("SELECT policyname,qual,with_check FROM pg_policies WHERE tablename='requests' ORDER BY policyname")).rows;
    await assert.rejects(instance.exec(requestActions), { code: '55000' });
    await instance.exec('ROLLBACK');
    assert.deepEqual((await instance.query('SELECT * FROM public.requests')).rows, rows);
    assert.deepEqual((await instance.query("SELECT policyname,qual,with_check FROM pg_policies WHERE tablename='requests' ORDER BY policyname")).rows, policies);
    if (incompatible === 'security-definer feed') {
      assert.equal((await instance.query("SELECT prosecdef FROM pg_proc WHERE oid='public.get_state()'::regprocedure")).rows[0].prosecdef, true);
    }
  });
}

test('The legacy support form accepts owned tickets and never exposes them to another member', async () => {
  await asMember(owner);
  const submitted = (await database.query('INSERT INTO support_tickets(uid,subject,message) VALUES($1,$2,$3) RETURNING id', [owner, 'Synthetic subject', 'Synthetic request'])).rows[0];
  assert.ok(submitted.id);
  await asMember(peer);
  assert.deepEqual((await database.query('SELECT * FROM support_tickets')).rows, []);
  await assert.rejects(database.query('INSERT INTO support_tickets(uid,subject,message) VALUES($1,$2,$3)', [owner, 'Forged', 'Forged']), { code: '42501' });
  await database.exec('RESET ROLE');
});

test('A repeated bootstrap refuses existing tables and leaves rows and policies intact', async () => {
  const before = (await database.query('SELECT uid,data FROM accounts')).rows;
  const policies = (await database.query("SELECT tablename,policyname FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname")).rows;
  await assert.rejects(database.exec(bootstrap), { code: '55000' });
  await database.exec('ROLLBACK');
  assert.deepEqual((await database.query('SELECT uid,data FROM accounts')).rows, before);
  assert.deepEqual((await database.query("SELECT tablename,policyname FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname")).rows, policies);
});