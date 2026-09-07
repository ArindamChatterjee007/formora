'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const cloudSource = fs.readFileSync(path.join(root, 'js/cloud.js'), 'utf8');
const socialSource = fs.readFileSync(path.join(root, 'js/mod/social.js'), 'utf8');
const owner = '11111111-1111-4111-8111-111111111111';
const peer = '22222222-2222-4222-8222-222222222222';
const postId = '33333333-3333-4333-8333-333333333333';

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function response(status, rows) {
  return { ok: status >= 200 && status < 300, status, json: async () => rows };
}

function harness() {
  const state = { uid: owner, requests: [], token: 'fixture-owner-token' };
  const context = vm.createContext({
    console, URL, AbortController, setTimeout, clearTimeout, crypto: webcrypto,
    SUPABASE_URL: 'https://fixture.invalid', SUPABASE_ANON_KEY: 'fixture-key', USE_SUPABASE_AUTH: true,
    SupaAuth: { active: () => true, uid: () => state.uid, bearer: () => state.token, token: async () => state.token },
    fetch: async (url, options) => {
      state.requests.push({ url, options });
      return response(201, [{ ...JSON.parse(options.body), ts: '2026-09-06T12:00:00Z' }]);
    },
  });
  context.window = context;
  vm.runInContext(cloudSource + '\nglobalThis.cloud = Cloud;', context);
  const cloud = context.cloud;
  cloud.base = 'https://fixture.invalid/rest/v1'; cloud.key = 'fixture-key'; cloud.me = 'stale_email_slug';
  return { context, cloud, state };
}

test('DEF-065: post creation awaits its exact owned representation', async () => {
  const { context, cloud, state } = harness();
  const pending = deferred(), started = deferred();
  context.fetch = (url, options) => { state.requests.push({ url, options }); started.resolve(); return pending.promise; };
  let settled = false;
  const creating = cloud.addPost({ id: postId, text: 'Kept until acknowledged' }).then(result => { settled = true; return result; });
  await started.promise;
  assert.equal(settled, false);
  const request = state.requests[0], row = JSON.parse(request.options.body);
  assert.equal(row.id, postId);
  assert.equal(row.author, owner);
  assert.equal(request.options.headers.Authorization, 'Bearer fixture-owner-token');
  assert.equal(request.options.headers.Prefer, 'resolution=ignore-duplicates,return=representation');
  pending.resolve(response(201, [{ ...row, ts: '2026-09-06T12:00:00Z' }]));
  const receipt = await creating;
  assert.equal(receipt.id, postId);
  assert.equal(receipt.author, owner);
  assert.equal(receipt.text, 'Kept until acknowledged');
});

test('DEF-065: rejected, missing, malformed and foreign post receipts are failures', async () => {
  for (const failure of [403, 503, 'offline', 'empty', 'object', 'wrong-id', 'foreign', 'wrong-payload', 'duplicate']) {
    const { context, cloud } = harness();
    context.fetch = async (url, options) => {
      if (failure === 'offline') throw new Error('offline');
      if (typeof failure === 'number') return response(failure, []);
      const row = JSON.parse(options.body);
      if (failure === 'empty') return response(200, []);
      if (failure === 'object') return response(200, row);
      if (failure === 'wrong-id') row.id = 'other-post';
      if (failure === 'foreign') row.author = peer;
      if (failure === 'wrong-payload') row.data.text = 'Unrelated caption';
      return response(200, failure === 'duplicate' ? [row, row] : [row]);
    };
    assert.equal(await cloud.addPost({ id: postId, text: 'Private draft' }), false, String(failure));
  }
});

test('DEF-065: new post IDs use CSPRNG UUIDs, never a time-based identity', async () => {
  const { cloud } = harness();
  const first = await cloud.addPost({ text: 'One' });
  const second = await cloud.addPost({ text: 'Two' });
  assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first.id, second.id);
});

test('DEF-065: direct post creation rejects foreign owners and missing secure identity', async () => {
  const { cloud, state, context } = harness();
  assert.equal(await cloud.addPost({ author: peer, text: 'Forged' }), false);
  for (const uid of [null, '', 'email_derived_slug']) {
    state.uid = uid;
    assert.equal(await cloud.addPost({ text: 'No valid owner' }), false);
  }
  state.uid = owner; state.token = null;
  assert.equal(await cloud.addPost({ text: 'No token' }), false);
  context.SupaAuth.active = () => false;
  assert.equal(await cloud.addPost({ text: 'No anonymous fallback' }), false);
  assert.equal(state.requests.length, 0);
});

test('DEF-065: identity changes while reading a receipt cannot acknowledge a post', async () => {
  const { cloud, context, state } = harness();
  context.fetch = async (url, options) => ({ ok: true, json: async () => {
    state.uid = peer;
    return [JSON.parse(options.body)];
  } });
  assert.equal(await cloud.addPost({ text: 'Original owner only' }), false);
});

for (const kind of ['post', 'message']) {
  test(`${kind} create retries reconcile only the identical owned row after a lost acknowledgement`, async () => {
    const { cloud, context, state } = harness();
    const stored = new Map();
    context.fetch = async (url, options) => {
      state.requests.push({ url, options });
      if (options.method === 'GET') return response(200, [...stored.values()]);
      const row = JSON.parse(options.body);
      if (stored.has(row.id)) return response(409, {});
      stored.set(row.id, { ...row, ts: '2026-09-06T12:00:00Z' });
      throw new Error('response lost after server commit');
    };
    const create = () => kind === 'post' ? cloud.addPost({ id: postId, text: 'One logical write', music: { title: 'Fixture', id: 'song' } }) : cloud.sendMessage(peer, 'One logical write', postId);
    assert.equal(await create(), false);
    const row = stored.get(postId);
    if (row.data) row.data = Object.fromEntries(Object.entries(row.data).reverse().map(([key, value]) => [key, key === 'music' ? { id: value.id, title: value.title } : value]));
    const receipt = await create();
    assert.equal(receipt.id, postId);
    assert.equal(stored.size, 1);
    assert.equal(state.requests.length, 3);
    const read = new URL(state.requests[2].url);
    assert.equal(read.searchParams.get('id'), 'eq.' + postId);
    assert.equal(read.searchParams.get(kind === 'post' ? 'author' : 'from_uid'), 'eq.' + owner);
    if (kind === 'message') assert.equal(read.searchParams.get('to_uid'), 'eq.' + peer);
    assert.ok(state.requests.every(request => !request.options.headers.Prefer.includes('merge-duplicates')));
  });

  for (const invalid of ['empty', 'foreign', 'wrong-id', 'payload', 'multiple', 'denied']) {
    test(`${kind} conflict reconciliation rejects ${invalid} without claiming success`, async () => {
      const { cloud, context } = harness();
      let original;
      context.fetch = async (url, options) => {
        if (options.method !== 'GET') { original = JSON.parse(options.body); return response(409, {}); }
        if (invalid === 'empty') return response(200, []);
        if (invalid === 'denied') return response(403, []);
        if (invalid === 'foreign') original[kind === 'post' ? 'author' : 'from_uid'] = peer;
        if (invalid === 'wrong-id') original.id = 'unknown';
        if (invalid === 'payload') { if (kind === 'post') original.data.text = 'Different'; else original.body = 'Different'; }
        return response(200, invalid === 'multiple' ? [original, original] : [original]);
      };
      assert.equal(await (kind === 'post' ? cloud.addPost({ id: postId, text: 'Expected' }) : cloud.sendMessage(peer, 'Expected', postId)), false);
    });
  }
}

for (const method of ['editMessage', 'deleteMessage']) {
  test(`DEF-064: ${method} uses native owner and recipient filters, requiring an exact row`, async () => {
    const { cloud, context, state } = harness();
    context.fetch = async (url, options) => { state.requests.push({ url, options }); return response(200, [{ id: 'legacy-message', from_uid: owner, to_uid: peer, body: 'Edited' }]); };
    const result = method === 'editMessage' ? await cloud.editMessage('legacy-message', 'Edited', peer) : await cloud.deleteMessage('legacy-message', peer);
    assert.equal(result, true);
    const request = state.requests[0], url = new URL(request.url);
    assert.equal(url.searchParams.get('id'), 'eq.legacy-message');
    assert.equal(url.searchParams.get('from_uid'), 'eq.' + owner);
    assert.equal(url.searchParams.get('to_uid'), 'eq.' + peer);
    assert.equal(request.options.headers.Prefer, 'return=representation');
    assert.equal(request.options.method, method === 'editMessage' ? 'PATCH' : 'DELETE');
    assert.deepEqual(request.options.body && JSON.parse(request.options.body), method === 'editMessage' ? { body: 'Edited' } : undefined);
  });

  test(`DEF-064: ${method} rejects 404, empty, malformed, foreign, and wrong-target receipts`, async () => {
    for (const failure of [403, 404, 503, 'offline', [], {}, null, [null], [{ id: postId }], [{ id: postId, from_uid: peer, to_uid: owner }]]) {
      const { cloud, context, state } = harness();
      context.fetch = async (url, options) => {
        state.requests.push({ url, options });
        if (failure === 'offline') throw new Error('offline');
        return response(typeof failure === 'number' ? failure : 200, failure);
      };
      assert.equal(await (method === 'editMessage' ? cloud.editMessage(postId, 'Edited', peer) : cloud.deleteMessage(postId, peer)), false);
      assert.equal(state.requests.length, 1, 'an absent row never proves an unsend');
    }
  });
}

test('DEF-064: secure message recipients must be actual UUIDs; configured legacy mode stays compatible', async () => {
  const { cloud, context, state } = harness();
  for (const target of ['peer_example_test', 'me', '', null, 'bad /?uid']) assert.equal(await cloud.sendMessage(target, 'Private'), false);
  assert.equal(state.requests.length, 0);
  context.SupaAuth.active = () => false;
  assert.equal(await cloud.sendMessage(peer, 'No auth fallback'), false);
  context.USE_SUPABASE_AUTH = false;
  cloud.me = 'legacy_owner';
  cloud.notify = () => {};
  assert.equal((await cloud.sendMessage('legacy_peer', 'Legacy configuration')).from, 'legacy_owner');
});

test('publishing reset aborts timed requests and rejects a late same-account receipt', async () => {
  const { cloud, context, state } = harness();
  const pending = deferred(), started = deferred();
  context.fetch = (url, options) => { state.requests.push({ url, options }); started.resolve(); return pending.promise; };
  const creating = cloud.addPost({ id: postId, text: 'Old session' });
  await started.promise;
  cloud.resetPublishing();
  assert.equal(state.requests[0].options.signal.aborted, true);
  pending.resolve(response(201, [JSON.parse(state.requests[0].options.body)]));
  assert.equal(await creating, false);
});

function socialHarness() {
  const harnessed = harness();
  const { context, state, cloud } = harnessed;
  const elements = new Map([
    ['post-text', { value: '  A private draft  ' }],
    ['post-publish', { disabled: false, textContent: 'Post' }],
  ]);
  const storage = new Map();
  Object.assign(state, { toasts: [], events: [], renders: 0, closes: 0 });
  Object.assign(context, {
    document: { getElementById: id => elements.get(id) || null },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
    Store: { state: { profile: { name: 'Owner', verified: true } } },
    App: { toast: text => state.toasts.push(text), closeModal: () => { state.closes++; }, ic: () => '', sendIcon: () => '', emptyState: () => '' },
    Track: { event: (...args) => state.events.push(args) },
    confirm: () => true, alert: text => state.toasts.push(text),
    esc: value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])),
  });
  vm.runInContext(socialSource + '\nglobalThis.social = Social;', context);
  const social = context.social;
  cloud.me = owner; cloud.notify = () => {};
  social.key = 'formora_social_owner';
  social.state = { seeded: true, posts: [], crew: [], challenges: [], chats: {}, following: [] };
  social.render = () => { state.renders++; };
  social.haptic = () => {};
  social.pendingPhotos = ['data:image/jpeg;base64,fixture'];
  social.pendingVideo = 'https://fixture.invalid/already-uploaded.webm';
  social.pendingMusic = { id: 'sound', title: 'Fixture', src: '/fixture.mp3' };
  return { ...harnessed, social, elements, storage };
}

test('DEF-065: UI commits once after acknowledgement and retains all draft media while pending', async () => {
  const { social, context, state, elements, storage } = socialHarness();
  const pending = deferred(), started = deferred();
  context.fetch = (url, options) => { state.requests.push({ url, options }); started.resolve(); return pending.promise; };
  const creating = social.publishPost();
  assert.equal(await social.publishPost(), false);
  await started.promise;
  assert.equal(social.cloud.feed.length, 0);
  assert.equal(elements.get('post-text').value, '  A private draft  ');
  assert.equal(social.pendingPhotos.length, 1);
  assert.ok(social.pendingVideo && social.pendingMusic);
  assert.equal(elements.get('post-publish').disabled, true);
  assert.equal(storage.size, 0);
  assert.deepEqual(state.events, []);
  pending.resolve(response(201, [JSON.parse(state.requests[0].options.body)]));
  assert.equal(await creating, true);
  assert.equal(social.cloud.feed.length, 1);
  assert.equal(elements.get('post-text').value, '');
  assert.equal(social.pendingPhotos.length, 0);
  assert.equal(social.pendingVideo, null);
  assert.equal(social.pendingMusic, null);
  assert.equal(elements.get('post-publish').disabled, false);
  assert.equal(state.events.length, 1);
  assert.deepEqual(state.toasts, ['Flex posted']);
});

for (const failure of [403, 404, 503, 'offline', 'malformed']) {
  test(`DEF-065: UI retains text, photos, video and retry ID after ${failure}`, async () => {
    const { social, context, state, elements } = socialHarness();
    const fetch = context.fetch;
    context.fetch = async (url, options) => {
      state.requests.push({ url, options });
      if (failure === 'offline') throw new Error('offline');
      return response(typeof failure === 'number' ? failure : 200, {});
    };
    const before = JSON.stringify([social.pendingPhotos, social.pendingVideo, social.pendingMusic]);
    assert.equal(await social.publishPost(), false);
    assert.equal(social.cloud.feed.length, 0);
    assert.equal(elements.get('post-text').value, '  A private draft  ');
    assert.equal(JSON.stringify([social.pendingPhotos, social.pendingVideo, social.pendingMusic]), before);
    assert.equal(state.events.length, 0);
    assert.equal(elements.get('post-publish').textContent, 'Retry post');
    assert.match(state.toasts[0], /could not confirm/i);
    const id = social._postRequest.id;
    context.fetch = fetch;
    assert.equal(await social.publishPost(), true);
    assert.equal(social.cloud.feed[0].id, id);
    assert.equal(state.requests.filter(request => request.options.method === 'POST').length, 2);
  });
}

test('DEF-065: a late receipt retains newer typing and attachments without closing another modal', async () => {
  const { social, context, state, elements } = socialHarness();
  const pending = deferred(), started = deferred();
  context.fetch = (url, options) => { state.requests.push({ url, options }); started.resolve(); return pending.promise; };
  const creating = social.publishPost();
  await started.promise;
  elements.get('post-text').value = 'A newer caption';
  social.pendingPhotos.push('new-photo');
  social.pendingVideo = 'new-video';
  pending.resolve(response(201, [JSON.parse(state.requests[0].options.body)]));
  assert.equal(await creating, true);
  assert.equal(elements.get('post-text').value, 'A newer caption');
  assert.equal(social._postText, 'A newer caption');
  assert.equal(social.pendingPhotos.length, 2);
  assert.equal(social.pendingVideo, 'new-video');
  assert.equal(state.closes, 0);
});

test('DEF-065: session reset drops private RAM requests and prevents late same-account draft mutation', async () => {
  const { social, context, state, elements, storage } = socialHarness();
  const pending = deferred(), started = deferred();
  context.fetch = (url, options) => { state.requests.push({ url, options }); started.resolve(); return pending.promise; };
  const creating = social.publishPost();
  await started.promise;
  const previousId = social._postRequest.id;
  social.resetSession();
  elements.get('post-text').value = 'New session draft';
  pending.resolve(response(201, [JSON.parse(state.requests[0].options.body)]));
  assert.equal(await creating, false);
  assert.equal(social._postRequest, null);
  assert.equal(social.pendingPhotos.length, 0);
  assert.equal(social.cloud.feed.length, 0);
  assert.equal(elements.get('post-text').value, 'New session draft');
  assert.equal(storage.size, 0);
  assert.deepEqual(state.toasts, []);
  context.fetch = async (url, options) => response(201, [JSON.parse(options.body)]);
  assert.equal(await social.publishPost(), true);
  assert.notEqual(social.cloud.feed[0].id, previousId);
});

test('DEF-065: denied verification and in-flight media keep drafts without a write', async () => {
  const { social, context, state } = socialHarness();
  context.Mailer = { canSendCodes: () => true };
  context.Store.state.profile.verified = false;
  assert.equal(await social.publishPost(), false);
  context.Store.state.profile.verified = true;
  social.pendingVideoUploading = true;
  assert.equal(await social.publishPost(), false);
  assert.equal(state.requests.length, 0);
  assert.equal(social.pendingPhotos.length, 1);
});

test('DEF-068: saved-button state comes from the owned list even with misleading body text', () => {
  const { social, storage } = socialHarness();
  const post = { id: 'saved-post', author: owner, text: 'Saved aria-pressed="true"', comments: [] };
  assert.match(social.postCard(post), /aria-pressed="false"/);
  storage.set(social._listKey('fm_saved'), JSON.stringify(['saved-post']));
  assert.match(social.postCard(post), /aria-pressed="true"/);
  storage.set(social._listKey('fm_saved'), '{}');
  assert.match(social.postCard(post), /aria-pressed="false"/);
});

function dmHarness() {
  const fixture = socialHarness();
  const { social, context, elements, state } = fixture;
  social.sub = 'chat'; social._dmWith = peer; social._dmInboxLoaded = true;
  social._dmMsgs = [
    { id: 'incoming', from: peer, to: owner, body: 'Peer history', ts: 1 },
    { id: 'own-message', from: owner, to: peer, body: 'Original message', ts: 2 },
  ];
  social._editMsg = { id: 'own-message', body: 'Original message', draft: '  Revised message  ' };
  elements.set('dm-text', { value: '  Outgoing draft  ' });
  elements.set('dm-edit', { value: '  Revised message  ' });
  elements.set('dm-send', { disabled: false }); elements.set('dm-save', { disabled: false });
  context.fetch = async (url, options) => {
    state.requests.push({ url, options });
    if (options.method === 'POST') return response(201, [JSON.parse(options.body)]);
    return response(200, [{ id: new URL(url).searchParams.get('id').slice(3), from_uid: owner, to_uid: peer, body: options.body ? JSON.parse(options.body).body : 'Original message' }]);
  };
  return fixture;
}

const dmActions = [
  { name: 'send', run: social => social.sendDM(), toast: 'Message sent', count: 3 },
  { name: 'edit', run: social => social.saveEditMsg(), toast: 'Message edited', count: 2 },
  { name: 'unsend', run: social => social.unsendMsg('own-message'), toast: 'Message unsent', count: 1 },
];

for (const action of dmActions) {
  test(`DEF-064: ${action.name} changes a thread only once after its exact acknowledgement`, async () => {
    const { social, context, state, elements } = dmHarness();
    const pending = deferred(), started = deferred(), originalFetch = context.fetch;
    const before = JSON.stringify(social._dmMsgs);
    context.fetch = (url, options) => { state.requests.push({ url, options }); started.resolve(); return pending.promise; };
    const operation = action.run(social);
    await started.promise;
    assert.equal(await action.run(social), false);
    assert.equal(state.requests.length, 1);
    assert.equal(JSON.stringify(social._dmMsgs), before);
    assert.deepEqual(state.toasts, []);
    assert.equal(elements.get('dm-text').value, '  Outgoing draft  ');
    assert.equal(elements.get('dm-edit').value, '  Revised message  ');
    const request = state.requests[0];
    pending.resolve(await originalFetch(request.url, request.options));
    assert.equal(await operation, true);
    assert.equal(social._dmMsgs.length, action.count);
    assert.equal(social._dmMsgs[0].body, 'Peer history');
    assert.deepEqual(state.toasts, [action.toast]);
    if (action.name === 'send') assert.equal(elements.get('dm-text').value, '');
    if (action.name === 'edit') { assert.equal(social._dmMsgs[1].body, 'Revised message'); assert.equal(social._editMsg, null); }
  });

  for (const failure of [403, 404, 503, 'offline', 'empty', 'malformed', 'wrong-id']) {
    test(`DEF-064: ${action.name} preserves the thread and draft on ${failure}, then retries`, async () => {
      const { social, context, state, elements, storage } = dmHarness();
      const originalFetch = context.fetch, before = JSON.stringify(social._dmMsgs);
      context.fetch = async (url, options) => {
        state.requests.push({ url, options });
        if (failure === 'offline') throw new Error('offline');
        return response(typeof failure === 'number' ? failure : 200, failure === 'empty' ? [] : failure === 'wrong-id' ? [{ id: 'wrong', from_uid: owner, to_uid: peer, body: 'Revised message' }] : {});
      };
      assert.equal(await action.run(social), false);
      assert.equal(JSON.stringify(social._dmMsgs), before);
      assert.equal(elements.get('dm-text').value, '  Outgoing draft  ');
      assert.equal(elements.get('dm-edit').value, '  Revised message  ');
      assert.ok(social._editMsg);
      assert.equal(storage.size, 0);
      assert.match(state.toasts.at(-1), /could not.*try again/i);
      const sentId = social._dmDraft().request?.id;
      context.fetch = originalFetch;
      assert.equal(await action.run(social), true);
      assert.equal(social._dmMsgs.length, action.count);
      assert.equal(state.toasts.at(-1), action.toast);
      if (sentId) assert.equal(social._dmMsgs.at(-1).id, sentId);
    });
  }
}

test('DEF-064: editing cannot clear newer typing or a replacement editor', async () => {
  for (const replacement of [false, true]) {
    const { social, context, state, elements } = dmHarness();
    const pending = deferred(), started = deferred(), originalFetch = context.fetch;
    context.fetch = (url, options) => { state.requests.push({ url, options }); started.resolve(); return pending.promise; };
    const editing = social.saveEditMsg();
    await started.promise;
    if (replacement) { social._editMsg = { id: 'incoming', draft: 'Different editor' }; elements.set('dm-edit', { value: 'Different editor' }); }
    else elements.get('dm-edit').value = 'Newer typing';
    pending.resolve(await originalFetch(state.requests[0].url, state.requests[0].options));
    assert.equal(await editing, true);
    assert.equal(elements.get('dm-edit').value, replacement ? 'Different editor' : 'Newer typing');
    assert.equal(social._editMsg.draft, replacement ? 'Different editor' : 'Newer typing');
    assert.equal(state.closes, 0);
  }
});

test('DEF-064: other threads and sessions keep their own drafts on late message acknowledgements', async () => {
  for (const reset of [false, true]) {
    const { social, context, state, elements } = dmHarness();
    const pending = deferred(), started = deferred();
    context.fetch = (url, options) => { state.requests.push({ url, options }); started.resolve(); return pending.promise; };
    const sending = social.sendDM();
    await started.promise;
    if (reset) social.resetSession();
    social._dmWith = owner;
    social._dmMsgs = [{ id: 'another-thread', body: 'Unchanged' }];
    elements.set('dm-text', { value: 'Different thread draft' });
    pending.resolve(response(201, [JSON.parse(state.requests[0].options.body)]));
    assert.equal(await sending, !reset);
    assert.equal(social._dmMsgs.length, 1);
    assert.equal(social._dmMsgs[0].id, 'another-thread');
    assert.equal(elements.get('dm-text').value, 'Different thread draft');
    if (reset) { assert.equal(social._dmDrafts.size, 0); assert.deepEqual(state.toasts, []); }
  }
});

test('DEF-064: foreign cached messages cannot be edited or unsent, even through direct handlers', async () => {
  const { social, state } = dmHarness();
  social._editMsg.id = 'incoming';
  assert.equal(await social.saveEditMsg(), false);
  assert.equal(await social.unsendMsg('incoming'), false);
  assert.equal(await social.unsendMsg('unknown-id'), false);
  assert.equal(state.requests.length, 0);
});

test('DEF-064: an absent polling row never proves that a failed unsend succeeded', async () => {
  const { social, context, state } = dmHarness();
  context.fetch = async () => response(503, []);
  assert.equal(await social.unsendMsg('own-message'), false);
  const rows = social._dmRows([social._dmMsgs[0]], peer);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].body, 'Original message');
  context.fetch = async () => response(200, []);
  assert.equal(await social.unsendMsg('own-message'), false);
  assert.equal(social._dmMsgs.length, 2);
  assert.ok(state.toasts.every(text => text !== 'Message unsent'));
});

for (const failure of [403, 404, 503, 'offline', 'malformed']) {
  test(`DEF-064: a ${failure} history refresh retains exact cached messages and draft`, async () => {
    const { social, context, elements } = dmHarness();
    context.fetch = async () => { if (failure === 'offline') throw new Error('offline'); return response(typeof failure === 'number' ? failure : 200, {}); };
    const before = JSON.stringify(social._dmMsgs);
    await social.refreshDM();
    assert.equal(JSON.stringify(social._dmMsgs), before);
    assert.equal(elements.get('dm-text').value, '  Outgoing draft  ');
    assert.equal(social._dmReadError, true);
  });
}

test('DM reads refresh the token, bind native owner filters, and discard unrelated rows', async () => {
  const { cloud, context, state } = harness();
  context.fetch = async (url, options) => {
    state.requests.push({ url, options });
    return response(200, [
      { id: 'peer-history', from_uid: peer, to_uid: owner, body: 'Visible', ts: 1 },
      { id: 'foreign-history', from_uid: peer, to_uid: postId, body: 'Private', ts: 2 },
    ]);
  };
  const rows = await cloud.getMessages(peer);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'peer-history');
  assert.match(new URL(state.requests[0].url).searchParams.get('or'), new RegExp(owner));
  assert.doesNotMatch(state.requests[0].url, /stale_email_slug/);
  assert.equal(state.requests[0].options.headers.Authorization, 'Bearer fixture-owner-token');
});

for (const action of ['post', 'send', 'edit', 'unsend', 'history']) {
  test(`${action} response parsing stays under the same abort deadline as the request`, async () => {
    const { cloud, context } = harness();
    const timers = [], cleared = [], started = deferred();
    context.setTimeout = (callback, delay) => { assert.equal(delay, 6000); timers.push(callback); return timers.length; };
    context.clearTimeout = timer => cleared.push(timer);
    context.fetch = async (url, options) => ({ ok: true, status: 200, json: () => {
      started.resolve();
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    } });
    const run = action === 'post' ? cloud.addPost({ text: 'Draft' }) : action === 'send' ? cloud.sendMessage(peer, 'Draft')
      : action === 'edit' ? cloud.editMessage(postId, 'Draft', peer) : action === 'unsend' ? cloud.deleteMessage(postId, peer) : cloud.getMessages(peer);
    await started.promise;
    assert.equal(cleared.length, 0);
    timers[0]();
    assert.equal(await run, action === 'history' ? null : false);
    assert.equal(cleared.length, 1);
  });
}

test('DEF-065: reset fences photo processing and late video uploads without deleting media', async () => {
  const { social, cloud, context, state } = socialHarness();
  const photo = deferred(), video = deferred(), started = deferred();
  context.resizeImage = () => photo.promise;
  const attaching = social.attachPhoto({ type: 'image/jpeg' });
  context.fetch = (url, options) => { state.requests.push({ url, options }); started.resolve(); return video.promise; };
  const uploading = social.postVideo({ target: { files: [{ type: 'video/webm', size: 10 }] } });
  await started.promise;
  social.resetSession();
  photo.resolve('private-photo'); video.resolve(response(200, {}));
  await Promise.all([attaching, uploading]);
  assert.equal(social.pendingPhotos.length, 0);
  assert.equal(social.pendingVideo, null);
  assert.equal(social.pendingVideoUploading, false);
  assert.ok(state.requests.every(request => request.options.method === 'POST'));
  assert.equal(cloud._publishingControllers.size, 0);
});

test('DEF-064: bulk unsend removes only acknowledged messages and retains peer history', async () => {
  const { social, context, state } = dmHarness();
  social._dmMsgs.push({ id: 'second-own', from: owner, to: peer, body: 'Keep on failure', ts: 3 });
  const originalFetch = context.fetch;
  context.fetch = (url, options) => new URL(url).searchParams.get('id') === 'eq.second-own' ? response(503, []) : originalFetch(url, options);
  assert.equal(await social.clearMyMessages(peer), false);
  assert.deepEqual(Array.from(social._dmMsgs, message => message.id), ['incoming', 'second-own']);
  assert.match(state.toasts.at(-1), /some messages could not/i);
});

test('adjacent reshares retain counts until exact create and undo acknowledgements', async () => {
  const { social, context, state } = socialHarness();
  const original = { id: 'peer-post', author: peer, text: 'Peer update', likes: {} };
  social.cloud.feed = [original];
  const pending = deferred(), started = deferred();
  context.fetch = (url, options) => { state.requests.push({ url, options }); started.resolve(); return pending.promise; };
  const resharing = social.resharePost(original.id);
  await started.promise;
  assert.equal(await social.resharePost(original.id), false);
  assert.equal(social._cloudPost(original).reshares, 0);
  assert.equal(social.cloud.feed.length, 1);
  pending.resolve(response(201, [JSON.parse(state.requests[0].options.body)]));
  assert.equal(await resharing, true);
  assert.equal(social._cloudPost(original).reshares, 1);
  assert.equal(social.cloud.feed[0].id, 'rs_' + owner + '__peer-post');
  context.fetch = async () => response(503, []);
  assert.equal(await social.resharePost(original.id), false);
  assert.equal(social._cloudPost(original).reshares, 1);
  const reshareId = social.cloud.feed[0].id;
  context.fetch = async () => response(200, [{ id: reshareId }]);
  assert.equal(await social.resharePost(original.id), true);
  assert.equal(social._cloudPost(original).reshares, 0);
});

test('a secure publishing upload never falls back to the anonymous key', async () => {
  const { cloud, context, state } = harness();
  context.SupaAuth.active = () => false;
  assert.equal(await cloud.uploadMedia({ type: 'video/webm', size: 10 }, 'videos'), null);
  assert.equal(state.requests.length, 0);
});

for (const action of dmActions) {
  test(`DEF-064: stale history cannot undo an acknowledged ${action.name}`, async () => {
    const { social, cloud } = dmHarness();
    const pending = deferred(), snapshot = JSON.parse(JSON.stringify(social._dmMsgs));
    cloud.getMessages = () => pending.promise;
    const reading = social.refreshDM();
    assert.equal(await action.run(social), true);
    const acknowledged = JSON.stringify(social._dmMsgs);
    pending.resolve(snapshot); await reading;
    assert.equal(JSON.stringify(social._dmMsgs), acknowledged);
  });
}

test('DEF-064: initial thread loading refetches history after an intervening send acknowledgement', async () => {
  const { social, cloud } = dmHarness();
  const pending = deferred(), history = JSON.parse(JSON.stringify(social._dmMsgs));
  social._editMsg = null;
  let reads = 0, current;
  cloud.getMessages = () => ++reads === 1 ? pending.promise : Promise.resolve(current);
  const opening = social.openDM(peer);
  assert.equal(await social.sendDM(), true);
  current = [...history, ...social._dmMsgs];
  pending.resolve(history); await opening;
  assert.equal(reads, 2);
  assert.equal(social._dmThreadLoading, false);
  assert.equal(social._dmMsgs.length, 3);
  assert.equal(social._dmMsgs[0].body, 'Peer history');
  assert.equal(social._dmMsgs.at(-1).body, 'Outgoing draft');
});