'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const actor = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const migration = fs.readFileSync(path.join(__dirname, '../supabase/reaction-actors.sql'), 'utf8');

async function fixture(context, source = migration) {
  const db = new PGlite(); context.after(() => db.close());
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE public_only;
    CREATE ROLE anon_child IN ROLE anon; CREATE ROLE auth_child IN ROLE authenticated;
    CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth,public TO PUBLIC;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE TABLE public.posts(id text PRIMARY KEY, author text, likes jsonb, data jsonb);
    INSERT INTO public.posts VALUES ('fixture-post','${other}','{"${other}":true}','{"text":"Preserved"}');
    ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
    CREATE FUNCTION public.like_post(text,text) RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT $$;
    CREATE FUNCTION public.unlike_post(text,text) RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT $$;
    GRANT EXECUTE ON FUNCTION public.like_post(text,text),public.unlike_post(text,text) TO anon;`);
  await db.exec(source);
  return db;
}

async function identity(db, role, uid) {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [uid || '']);
  await db.exec('SET ROLE ' + role);
}

test('reaction functions reject anonymous, PUBLIC-only and inherited anonymous execution', async context => {
  const db = await fixture(context);
  for (const role of ['anon', 'anon_child', 'public_only']) {
    await identity(db, role, null);
    for (const name of ['like_post','unlike_post']) await assert.rejects(db.query(`SELECT public.${name}($1,$2)`, ['fixture-post',actor]), {code:'42501'});
  }
  await identity(db, 'authenticated', null);
  await assert.rejects(db.query('SELECT public.like_post($1,$2)', ['fixture-post',actor]), {code:'PT401'});
});

test('the verified actor alone can like and unlike without changing other likes or post data', async context => {
  const db = await fixture(context);
  await identity(db, 'auth_child', actor);
  await assert.rejects(db.query('SELECT public.like_post($1,$2)', ['fixture-post',other]), {code:'PT403'});
  await assert.rejects(db.query('SELECT public.unlike_post($1,$2)', ['fixture-post',other]), {code:'PT403'});
  await db.query('SELECT public.like_post($1,$2)', ['fixture-post',actor]);
  await db.query('SELECT public.like_post($1,NULL)', ['fixture-post']);
  await db.exec('RESET ROLE');
  assert.deepEqual((await db.query('SELECT likes,data FROM public.posts')).rows[0], {likes:{[other]:true,[actor]:true},data:{text:'Preserved'}});
  await identity(db, 'authenticated', actor);
  await db.query('SELECT public.unlike_post($1,$2)', ['fixture-post',actor]);
  await db.query('SELECT public.unlike_post($1,NULL)', ['fixture-post']);
  await assert.rejects(db.query('SELECT public.like_post($1,NULL)', ['']), {code:'22023'});
  await db.exec('RESET ROLE');
  assert.deepEqual((await db.query('SELECT likes FROM public.posts')).rows[0].likes, {[other]:true});
});

test('the additive reaction migration is repeatable and keeps effective grants and search paths restricted', async context => {
  const db = await fixture(context); await db.exec(migration);
  for (const name of ['like_post','unlike_post']) {
    const info = (await db.query("SELECT prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure", ['public.'+name+'(text,text)'])).rows[0];
    assert.equal(info.prosecdef,true); assert.ok(info.proconfig.includes('search_path=""'));
    for (const role of ['anon','anon_child','public_only','authenticated','auth_child']) {
      assert.equal((await db.query('SELECT has_function_privilege($1,$2,$3) AS allowed', [role,'public.'+name+'(text,text)','EXECUTE'])).rows[0].allowed, ['authenticated','auth_child'].includes(role));
    }
  }
  const bootstrap = fs.readFileSync(path.join(__dirname,'../supabase/security.sql'),'utf8');
  assert.doesNotMatch(bootstrap,/coalesce\(auth\.uid\(\)::text,\s*p_uid\)/i);
  assert.match(bootstrap,/revoke all on function public\.like_post\(text,text\), public\.unlike_post\(text,text\) from public, anon, authenticated;/i);
});

test('bootstrap and standalone reaction definitions execute equivalent actor and privilege contracts', async context => {
  const bootstrap = fs.readFileSync(path.join(__dirname, '../supabase/security.sql'), 'utf8');
  const start = bootstrap.indexOf('create or replace function public.like_post(');
  const grant = 'grant execute on function public.like_post(text,text), public.unlike_post(text,text) to authenticated;';
  const end = bootstrap.indexOf(grant, start);
  assert.ok(start >= 0 && end > start);
  const outcomes = [];
  for (const source of [migration, bootstrap.slice(start, end + grant.length)]) {
    const db = await fixture(context, source), observed = [];
    for (const role of ['public_only', 'anon', 'anon_child', 'authenticated', 'auth_child']) {
      for (const uid of [null, actor]) {
        await identity(db, role, uid);
        for (const name of ['like_post', 'unlike_post']) {
          for (const supplied of [other, null, actor]) {
            for (const post of ['fixture-post', '', 'x'.repeat(256), 'missing-post']) {
              try { await db.query(`SELECT public.${name}($1,$2)`, [post, supplied]); observed.push('accepted'); }
              catch (error) { observed.push(error.code); }
            }
          }
        }
      }
    }
    await db.exec('RESET ROLE');
    observed.push((await db.query('SELECT * FROM public.posts ORDER BY id')).rows);
    observed.push((await db.query(`SELECT proname,proargnames,prosecdef,proconfig,pg_get_function_result(oid) AS result,
      has_function_privilege('anon',oid,'EXECUTE') AS anonymous,
      has_function_privilege('public_only',oid,'EXECUTE') AS public_only,
      has_function_privilege('auth_child',oid,'EXECUTE') AS member
      FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('like_post','unlike_post') ORDER BY proname`)).rows);
    outcomes.push(observed);
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.ok(outcomes[0].includes('PT401') && outcomes[0].includes('PT403') && outcomes[0].includes('22023') && outcomes[0].includes('42501'));
});