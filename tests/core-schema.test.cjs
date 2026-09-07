'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.resolve(__dirname, '..');
const bootstrap = fs.readFileSync(path.join(root, 'supabase/core-schema.sql'), 'utf8');
const security = fs.readFileSync(path.join(root, 'supabase/security.sql'), 'utf8');
const owner = '11111111-1111-4111-8111-111111111111';
const peer = '22222222-2222-4222-8222-222222222222';
const stranger = '33333333-3333-4333-8333-333333333333';
let database;

test.before(async () => {
  database = new PGlite();
  await database.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO authenticated;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`);
  await database.exec(bootstrap);
  await database.exec('BEGIN;\n' + security + '\nCOMMIT;');
});
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