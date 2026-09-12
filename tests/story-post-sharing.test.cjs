'use strict';
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const createStories = require('../js/mod/stories.js');
const { database, identity, rpc, owner, peer, policy } = require('./story-media-sql.test.cjs');
const migrationFile = path.join(__dirname, '../supabase/story-post-sharing.sql');
const postStamp = '2026-09-13T00:00:00+00:00';
const publish = (db, request, id = 'source-post', author = owner, stamp = postStamp) =>
  rpc(db, 'publish_post_story', [request, id, author, stamp]);

async function fixture(context, enabled = true) {
  const db = await database(context, false, false);
  await db.exec('CREATE TABLE public.posts(id text PRIMARY KEY,author text NOT NULL,data jsonb NOT NULL,likes jsonb,ts timestamptz)');
  if (fs.existsSync(migrationFile)) await db.exec(fs.readFileSync(migrationFile, 'utf8'));
  await db.query('INSERT INTO public.posts VALUES($1,$2,$3,$4,$5)', ['source-post', owner,
    { text: 'Original caption', photo: 'data:image/jpeg;base64,AQIDBA==', private_note: 'never-copy-this' }, {}, postStamp]);
  if (enabled) await db.query(`UPDATE public.story_settings SET enabled=true,permission_policy_approved=true,
    media_audience_approved=true,public_media_approved=true,retention_approved=true,operator_policy_ref=$1,
    media_origin='https://fixture.supabase.co',public_bucket='media'`, [policy]);
  return db;
}

test('Post-to-Story stores one reference with exact replay and never copies media', async context => {
  const db = await fixture(context);
  await identity(db, peer);
  const request = randomUUID(), receipt = await publish(db, request);
  assert.equal(receipt.author, peer); assert.equal(receipt.post_id, 'source-post');
  assert.equal(receipt.committed, true); assert.equal(receipt.action, 'publish_post');
  const replay = await publish(db, request);
  assert.equal(replay.id, receipt.id); assert.equal(replay.duplicate, true);
  await assert.rejects(publish(db, request, 'different-post'), { code: 'PT409' });
  const row = await rpc(db, 'get_story', [receipt.id]);
  assert.equal(row.kind, 'post'); assert.equal(row.photo, null); assert.equal(row.post_id, 'source-post');
  assert.equal((await rpc(db, 'story_feed')).items.find(item => item.id === receipt.id)?.post_id, 'source-post');
  const preview = await rpc(db, 'get_shareable_story_post', ['source-post']);
  assert.equal(preview.id, 'source-post'); assert.equal(preview.author, owner); assert.equal(preview.text, 'Original caption');
  assert.doesNotMatch(JSON.stringify(preview), /private_note|never-copy-this/);
  await db.exec('RESET ROLE');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM stories_v2')).rows[0].count, 1);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM story_content')).rows[0].count, 0);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM storage.objects')).rows[0].count, 0);
});

test('Shared-post Stories recheck source deletion, privacy and reciprocal blocks', async context => {
  const db = await fixture(context);
  await identity(db, peer);
  const receipt = await publish(db, randomUUID());
  await db.exec('RESET ROLE');
  await db.query("UPDATE profiles SET data=jsonb_set(data,'{privacy}','\"friends\"') WHERE uid=$1", [owner]);
  await identity(db, peer);
  await assert.rejects(rpc(db, 'get_story', [receipt.id]), { code: 'PT404' });
  await assert.rejects(rpc(db, 'get_shareable_story_post', ['source-post']), { code: 'PT404' });
  await assert.rejects(publish(db, randomUUID()), { code: 'PT404' });
  await db.exec('RESET ROLE');
  await db.query("UPDATE profiles SET data=jsonb_set(data,'{privacy}','\"public\"') WHERE uid=$1", [owner]);
  await db.query('INSERT INTO story_blocks VALUES($1,$2)', [owner, peer]);
  await identity(db, peer);
  await assert.rejects(rpc(db, 'get_story', [receipt.id]), { code: 'PT404' });
  await db.exec('RESET ROLE; DELETE FROM story_blocks; DELETE FROM posts');
  await identity(db, peer);
  await assert.rejects(rpc(db, 'get_story', [receipt.id]), { code: 'PT404' });
  assert.equal((await publish(db, receipt.request_id)).id, receipt.id);
});

test('Post-to-Story retains disabled policy, direct-table denial and bounded post IDs', async context => {
  const db = await fixture(context, false);
  await identity(db, peer);
  await assert.rejects(publish(db, randomUUID()), { code: 'PT503' });
  await assert.rejects(db.query("INSERT INTO stories_v2(owner,kind,post_id,audience,created_at,expires_at) VALUES($1,'post','source-post','authenticated',now(),now()+interval '24 hours')", [peer]), { code: '42501' });
  await db.exec('RESET ROLE');
  await db.query(`UPDATE story_settings SET enabled=true,permission_policy_approved=true,media_audience_approved=true,
    public_media_approved=true,retention_approved=true,operator_policy_ref=$1,media_origin='https://fixture.supabase.co',public_bucket='media'`, [policy]);
  await identity(db, peer);
  for (const invalid of ['', 'x'.repeat(256), 'post\nforged', null]) {
    await assert.rejects(publish(db, randomUUID(), invalid), { code: '22023' });
  }
});

test('Story client validates post previews and publishes only an acknowledged source reference', async context => {
  const db = await fixture(context);
  await identity(db, peer);
  const requests = [], stored = new Map();
  const api = createStories({ host: { STORY_INTERACTIONS: true, performance, setTimeout, clearTimeout, crypto: globalThis.crypto,
    localStorage: { get length() { return stored.size; }, key: index => [...stored.keys()][index] ?? null,
      getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) } },
    auth: { active: () => true, uid: () => peer, token: async () => 'synthetic-token' },
    cloud: { me: peer, key: 'public-fixture-key', base: 'https://fixture.supabase.co/rest/v1' },
    fetch: async (url, options) => {
      const name = new URL(url).pathname.split('/').at(-1), body = JSON.parse(options.body);
      requests.push({ name, body });
      const args = name === 'get_shareable_story_post' ? [body.p_post_id]
        : name === 'publish_post_story' ? [body.p_request_id, body.p_post_id, body.p_post_author, body.p_post_created_at] : [body.p_id];
      return Response.json(await rpc(db, name, args));
    } });
  context.after(() => api.destroy());
  const post = await api.shareablePost('source-post');
  assert.equal(post.text, 'Original caption');
  assert.deepEqual(Object.keys(post).sort(), ['author', 'created_at', 'has_video', 'id', 'name', 'photo', 'photo_status', 'text', 'username']);
  const result = await api.publishPost(post.id, randomUUID(), post);
  assert.equal(result.receipt.committed, true); assert.equal(result.row.kind, 'post');
  const publication = requests.find(entry => entry.name === 'publish_post_story');
  assert.deepEqual(Object.keys(publication.body).sort(), ['p_post_author', 'p_post_created_at', 'p_post_id', 'p_request_id']);
  assert.doesNotMatch(JSON.stringify(publication.body), /caption|data:|photo|private_note/);
});

test('A reused source ID or source-author block cannot rebind or keep distributing a shared Story', async context => {
  const db = await fixture(context), third = randomUUID();
  await db.query('INSERT INTO public.profiles VALUES($1,$2)', [third, { name: 'Third member', privacy: 'public' }]);
  await identity(db, peer);
  const request = randomUUID(), receipt = await publish(db, request);
  await db.exec('RESET ROLE');
  await db.query('INSERT INTO story_blocks VALUES($1,$2)', [owner, peer]);
  for (const actor of [owner, peer, third]) {
    await identity(db, actor);
    await assert.rejects(rpc(db, 'get_story', [receipt.id]), { code: 'PT404' });
  }
  await db.exec('RESET ROLE; DELETE FROM story_blocks; DELETE FROM posts');
  await db.query('INSERT INTO posts VALUES($1,$2,$3,$4,$5)', ['source-post', third, { text: 'Replacement' }, {}, postStamp]);
  await identity(db, peer);
  await assert.rejects(rpc(db, 'get_story', [receipt.id]), { code: 'PT404' });
  await assert.rejects(publish(db, randomUUID()), { code: 'PT404' });
  assert.equal((await publish(db, request)).id, receipt.id);
  await db.exec('RESET ROLE');
  await db.query("UPDATE posts SET author=$1,ts=ts+interval '1 second'", [owner]);
  await identity(db, peer);
  await assert.rejects(rpc(db, 'get_story', [receipt.id]), { code: 'PT404' });
  assert.equal((await rpc(db, 'delete_story', [receipt.id, randomUUID()])).author, peer);
});

test('Bounded large photo previews survive the transport while excess or unsafe media is explicit', async context => {
  const db = await fixture(context), stored = new Map();
  const large = 'data:image/jpeg;base64,' + 'A'.repeat(600000);
  await db.query("UPDATE posts SET data=jsonb_build_object('text','Real-size preview','photo',$1::text)", [large]);
  await identity(db, peer);
  const api = createStories({ host: { STORY_INTERACTIONS: true, performance, setTimeout, clearTimeout, crypto: globalThis.crypto,
    localStorage: { get length() { return stored.size; }, key: index => [...stored.keys()][index] ?? null,
      getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) } },
    auth: { active: () => true, uid: () => peer, token: async () => 'synthetic-token' },
    cloud: { me: peer, key: 'public-fixture-key', base: 'https://fixture.supabase.co/rest/v1' },
    fetch: async () => Response.json(await rpc(db, 'get_shareable_story_post', ['source-post'])) });
  context.after(() => api.destroy());
  assert.equal((await api.shareablePost('source-post')).photo, large);
  assert.equal(api.limits.responseBytes, 262144, 'Other RPC response limits must not grow');
  await assert.rejects(api._body(Response.json({ bytes: large })), { status: 502 });
  for (const photo of ['data:image/jpeg;base64,' + 'A'.repeat(2097152), 'data:image/svg+xml;base64,AAAA',
    'https://other.supabase.co/storage/v1/object/public/media/image.jpg',
    'https://fixture.supabase.co/storage/v1/object/public/media/../secret.jpg']) {
    await db.exec('RESET ROLE'); await db.query("UPDATE posts SET data=jsonb_build_object('photo',$1::text)", [photo]);
    await identity(db, peer);
    const preview = await api.shareablePost('source-post');
    assert.equal(preview.photo, null); assert.equal(preview.photo_status, 'unavailable');
  }
});

test('Post sharing co-installs with media validation without weakening either gate', async context => {
  for (const mediaFirst of [true, false]) {
    const db = await database(context, false, mediaFirst);
    await db.exec('CREATE TABLE public.posts(id text PRIMARY KEY,author text,data jsonb,likes jsonb,ts timestamptz)');
    await db.exec(fs.readFileSync(migrationFile, 'utf8'));
    if (!mediaFirst) await db.exec(fs.readFileSync(path.join(__dirname, '../supabase/story-media.sql'), 'utf8'));
    const media = (await db.query('SELECT enabled,publication_required FROM story_media_settings')).rows[0];
    assert.equal(media.enabled, false); assert.equal(media.publication_required, false);
    assert.equal((await db.query("SELECT count(*)::int AS count FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'story_media%'")).rows[0].count, 5);
    assert.ok((await db.query("SELECT public FROM storage.buckets WHERE id LIKE 'story-media%'")).rows.every(bucket => bucket.public === false));
    await identity(db, peer);
    await assert.rejects(publish(db, randomUUID()), { code: 'PT503' });
    await assert.rejects(rpc(db, 'reserve_story_media', [randomUUID(), 'photo', 'image/jpeg', 4]), { code: 'PT503' });
  }
});