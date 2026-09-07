'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const cloudSource = fs.readFileSync(path.join(root, 'js/cloud.js'), 'utf8');
const socialSource = fs.readFileSync(path.join(root, 'js/mod/social.js'), 'utf8');

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function response(status = 200, rows = [{ id: 'post-1' }]) {
  return { ok: status >= 200 && status < 300, status, json: async () => rows };
}

function harness() {
  const storage = new Map();
  const elements = new Map([
    ['edit-cap', { value: '  Revised caption  ', disabled: false }],
    ['edit-cap-save', { disabled: false, textContent: 'Save changes' }]
  ]);
  const state = { requests: [], toasts: [], confirms: [], renders: 0, closes: 0, haptics: 0 };
  const context = vm.createContext({
    console, URL, AbortController, setTimeout, clearTimeout,
    SUPABASE_URL: 'https://fixture.invalid', SUPABASE_ANON_KEY: 'fixture-key',
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    },
    document: { getElementById: id => elements.get(id) || null },
    confirm: message => { state.confirms.push(message); return true; },
    App: {
      toast: message => state.toasts.push(message),
      closeModal: () => { state.closes++; },
      openSheet: (title, actions) => { state.sheet = { title, actions }; }
    },
    fetch: async (url, options) => { state.requests.push({ url, options }); return response(); }
  });
  context.window = context;
  vm.runInContext(cloudSource + '\nglobalThis.cloud = Cloud;', context);
  vm.runInContext(socialSource + '\nglobalThis.social = Social;', context);
  const cloud = context.cloud, social = context.social;
  cloud.base = 'https://fixture.invalid/rest/v1';
  cloud.key = 'fixture-key';
  cloud.me = 'account-a';
  social.key = 'formora_social_account-a';
  social.state = { seeded: true, posts: [], crew: [], following: [], chats: {}, challenges: [] };
  social.cloud.feed = [{ id: 'post-1', author: 'account-a', text: 'Original caption', photo: 'photo.jpg', likes: {} }];
  social.cloud.comments = [{ id: 'comment-1', post_id: 'post-1', author: 'account-a', body: 'Original comment' }];
  social.render = () => { state.renders++; };
  social.haptic = () => { state.haptics++; };
  return { context, cloud, social, state, storage, elements };
}

test('caption save preserves content and editor until acknowledgement, ignoring duplicate clicks', async () => {
  const { context, social, state, elements } = harness();
  const pending = deferred();
  context.fetch = (url, options) => { state.requests.push({ url, options }); return pending.promise; };
  const saving = social.saveEditPost('post-1');
  const duplicate = social.saveEditPost('post-1');
  assert.equal(social.cloud.feed[0].text, 'Original caption');
  assert.equal(elements.get('edit-cap').value, '  Revised caption  ');
  assert.equal(state.closes, 0);
  assert.deepEqual(state.toasts, []);
  assert.equal(state.requests.length, 1);
  pending.resolve(response());
  await Promise.all([saving, duplicate]);
  assert.equal(social.cloud.feed[0].text, 'Revised caption');
  assert.equal(state.closes, 1);
  assert.deepEqual(state.toasts, ['Caption updated']);
});

for (const failure of [403, 500, 'offline']) {
  test(`caption save preserves draft on ${failure} and permits an explicit retry`, async () => {
    const { context, social, state, elements } = harness();
    context.fetch = async () => {
      if (failure === 'offline') throw new Error('offline');
      return response(failure);
    };
    await social.saveEditPost('post-1');
    assert.equal(social.cloud.feed[0].text, 'Original caption');
    assert.equal(elements.get('edit-cap').value, '  Revised caption  ');
    assert.equal(state.closes, 0);
    assert.match(state.toasts.at(-1), /could not.*try again/i);
    context.fetch = async () => response();
    await social.saveEditPost('post-1');
    assert.equal(social.cloud.feed[0].text, 'Revised caption');
    assert.equal(state.toasts.at(-1), 'Caption updated');
    assert.equal(state.closes, 1);
  });
}

const ownedActions = [
  { name: 'editPost', table: 'posts', method: 'PATCH' },
  { name: 'deletePost', table: 'posts', method: 'DELETE' },
  { name: 'deleteComment', table: 'comments', method: 'DELETE' }
];

for (const action of ownedActions) {
  test(`Cloud.${action.name} waits for the exact owner-filtered row acknowledgement`, async () => {
    const { context, cloud, state } = harness();
    const pending = deferred();
    const targetId = 'target /?&1';
    cloud.me = 'owner /?&2';
    context.fetch = (url, options) => { state.requests.push({ url, options }); return pending.promise; };
    let completed = false;
    const saving = cloud[action.name](targetId, { text: 'changed' }).then(result => { completed = true; return result; });
    await Promise.resolve();
    assert.equal(completed, false);
    const request = state.requests[0], url = new URL(request.url);
    assert.equal(url.pathname, `/rest/v1/${action.table}`);
    assert.equal(url.searchParams.get('id'), 'eq.' + targetId);
    assert.equal(url.searchParams.get('author'), 'eq.' + cloud.me);
    assert.equal(url.searchParams.get('select'), 'id');
    assert.equal(request.options.method, action.method);
    assert.equal(request.options.headers.Prefer, 'return=representation');
    if (action.method === 'PATCH') assert.deepEqual(JSON.parse(request.options.body), { data: { text: 'changed' } });
    pending.resolve(response(200, [{ id: targetId }]));
    assert.equal(await saving, true);
  });

  test(`Cloud.${action.name} rejects HTTP errors, offline, empty and malformed acknowledgements`, async () => {
    const { context, cloud } = harness();
    const replies = [
      response(403), response(500), response(200, []), response(200, {}),
      response(200, null), response(200, [null]), response(200, [{ id: 'another-post' }]),
      { ok: true, status: 204, json: async () => { throw new SyntaxError('empty body'); } },
      new Error('offline')
    ];
    for (const reply of replies) {
      context.fetch = async () => { if (reply instanceof Error) throw reply; return reply; };
      assert.equal(await cloud[action.name]('post-1', { text: 'changed' }), false);
    }
  });
}

test('Cloud.report waits for a successful write and returns false for every rejected write', async () => {
  const { context, cloud, state } = harness();
  const pending = deferred();
  context.fetch = (url, options) => { state.requests.push({ url, options }); return pending.promise; };
  let completed = false;
  const reporting = cloud.report('post', 'post-1', 'Spam or scam', 'other-account').then(result => { completed = true; return result; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.deepEqual(JSON.parse(state.requests[0].options.body), {
    kind: 'post', target_id: 'post-1', reported_uid: 'other-account', reason: 'Spam or scam', reporter: 'account-a', status: 'open'
  });
  pending.resolve(response(201));
  assert.equal(await reporting, true);
  for (const failure of [403, 500, 'offline']) {
    context.fetch = async () => { if (failure === 'offline') throw new Error('offline'); return response(failure); };
    assert.equal(await cloud.report('post', 'post-1', 'Spam or scam'), false);
  }
});

test('Cloud actions use the authenticated UUID, and do not fall back to a stale identity after logout', async () => {
  const { context, cloud, state } = harness();
  let authUid = 'authenticated-owner';
  context.SupaAuth = { active: () => true, uid: () => authUid, bearer: () => 'fixture-jwt', token: async () => 'fixture-jwt' };
  for (const action of ownedActions) {
    assert.equal(await cloud[action.name]('post-1', {}), true);
    assert.equal(new URL(state.requests.at(-1).url).searchParams.get('author'), 'eq.authenticated-owner');
    assert.equal(state.requests.at(-1).options.headers.Authorization, 'Bearer fixture-jwt');
  }
  assert.equal(await cloud.report('post', 'post-1', 'Spam or scam'), true);
  assert.equal(JSON.parse(state.requests.at(-1).options.body).reporter, 'authenticated-owner');
  authUid = null;
  const before = state.requests.length;
  for (const action of ownedActions) assert.equal(await cloud[action.name]('post-1', {}), false);
  assert.equal(await cloud.report('post', 'post-1', 'Spam or scam'), false);
  assert.equal(state.requests.length, before);
});

test('Cloud actions fail closed for missing targets or inactive cloud', async () => {
  const { context, cloud, state } = harness();
  for (const action of ownedActions) assert.equal(await cloud[action.name]('', {}), false);
  assert.equal(await cloud.report('post', '', 'Spam or scam'), false);
  context.SUPABASE_URL = '';
  for (const action of ownedActions) assert.equal(await cloud[action.name]('post-1', {}), false);
  assert.equal(await cloud.report('post', 'post-1', 'Spam or scam'), false);
  assert.equal(state.requests.length, 0);
});

const socialActions = [
  { name: 'removePost', id: 'post-1', args: [], success: /^Post deleted$/, changed: social => !social.cloud.feed.length },
  { name: 'deleteComment', id: 'comment-1', args: [], success: /^Comment deleted$/, changed: social => !social.cloud.comments.length },
  { name: '_doReport', id: 'post-1', args: ['Spam or scam'], success: /^Report sent\./, changed: social => social.isHidden('post-1') && social._list('fm_reported').includes('post-1') },
  { name: 'reportComment', id: 'comment-1', args: [], success: /^Report sent\./, changed: social => social._list('fm_hidden_cmt').includes('comment-1') },
  { name: 'reportUser', id: 'other-account', args: [], success: /^Report sent\./, changed: () => true }
];

for (const action of socialActions) {
  test(`Social.${action.name} acknowledges success once and ignores duplicate in-flight clicks`, async () => {
    const { context, social, state, storage } = harness();
    const pending = deferred();
    const beforeContent = JSON.stringify([social.cloud.feed, social.cloud.comments]);
    const beforeStorage = [...storage];
    context.fetch = (url, options) => { state.requests.push({ url, options }); return pending.promise; };
    const sending = social[action.name](action.id, ...action.args);
    const duplicate = social[action.name](action.id, ...action.args);
    assert.equal(JSON.stringify([social.cloud.feed, social.cloud.comments]), beforeContent);
    assert.deepEqual([...storage], beforeStorage);
    assert.deepEqual(state.toasts, []);
    assert.equal(state.renders, 0);
    assert.equal(state.haptics, 0);
    assert.equal(state.requests.length, 1);
    assert.ok(state.confirms.length <= 1);
    pending.resolve(response(200, [{ id: action.id }]));
    assert.deepEqual(await Promise.all([sending, duplicate]), [true, false]);
    assert.equal(state.toasts.length, 1);
    assert.match(state.toasts[0], action.success);
    assert.equal(action.changed(social), true);
  });

  for (const failure of [403, 500, 'offline']) {
    test(`Social.${action.name} preserves content on ${failure}, shows failure and allows retry`, async () => {
      const { context, social, state, storage } = harness();
      const beforeContent = JSON.stringify([social.cloud.feed, social.cloud.comments]);
      const beforeStorage = [...storage];
      context.fetch = async () => { if (failure === 'offline') throw new Error('offline'); return response(failure); };
      assert.equal(await social[action.name](action.id, ...action.args), false);
      assert.equal(JSON.stringify([social.cloud.feed, social.cloud.comments]), beforeContent);
      assert.deepEqual([...storage], beforeStorage);
      assert.equal(state.renders, 0);
      assert.equal(state.haptics, 0);
      assert.equal(state.toasts.length, 1);
      assert.match(state.toasts[0], /could not.*try again/i);
      assert.doesNotMatch(state.toasts[0], /report sent|caption updated|post deleted|comment deleted/i);
      context.fetch = async () => response(200, [{ id: action.id }]);
      assert.equal(await social[action.name](action.id, ...action.args), true);
      assert.match(state.toasts.at(-1), action.success);
      assert.equal(action.changed(social), true);
    });
  }
}

test('non-owners and the local me placeholder cannot edit or delete cloud content', async () => {
  for (const author of ['other-account', 'me']) {
    const { social, state } = harness();
    social.cloud.feed[0].author = author;
    social.cloud.comments[0].author = author;
    social.editPost('post-1');
    assert.equal(await social.saveEditPost('post-1'), false);
    assert.equal(await social.removePost('post-1'), false);
    assert.equal(await social.deleteComment('comment-1'), false);
    assert.equal(social.cloud.feed[0].text, 'Original caption');
    assert.equal(social.cloud.comments.length, 1);
    assert.equal(state.requests.length, 0);
    assert.equal(state.confirms.length, 0);
    assert.deepEqual(state.toasts, []);
  }
});

test('cancelling a destructive confirmation performs no write or local change', async () => {
  const { context, social, state } = harness();
  context.confirm = () => false;
  assert.equal(await social.removePost('post-1'), false);
  assert.equal(await social.deleteComment('comment-1'), false);
  assert.equal(social.cloud.feed.length, 1);
  assert.equal(social.cloud.comments.length, 1);
  assert.equal(state.requests.length, 0);
  assert.deepEqual(state.toasts, []);
});

test('reports without cloud never say sent or hide local content', async () => {
  const { context, social, state, storage } = harness();
  context.SUPABASE_URL = '';
  for (const action of socialActions.filter(action => action.success.source.includes('Report'))) {
    assert.equal(await social[action.name](action.id, ...action.args), false);
    assert.match(state.toasts.at(-1), /could not.*try again/i);
  }
  assert.equal(state.requests.length, 0);
  assert.equal(storage.size, 0);
  assert.equal(social.cloud.feed.length, 1);
  assert.equal(social.cloud.comments.length, 1);
});

const personalLists = ['fm_hidden', 'fm_hidden_cmt', 'fm_notint', 'fm_blocked', 'fm_reported', 'fm_saved', 'fm_muted'];

test('mute and unmute are account scoped, preserve failure state and permit retry', () => {
  const { social, cloud, context, state } = harness();
  social.chatDetails = () => {};
  assert.equal(social.toggleMute('peer'), true);
  assert.equal(social.isMuted('peer'), true);
  cloud.me = 'account-b';
  assert.equal(social.isMuted('peer'), false);
  cloud.me = 'account-a';
  const save = context.localStorage.setItem;
  context.localStorage.setItem = () => { throw new Error('quota'); };
  assert.equal(social.toggleMute('peer'), false);
  assert.equal(social.isMuted('peer'), true);
  assert.match(state.toasts.at(-1), /could not.*try again/i);
  context.localStorage.setItem = save;
  assert.equal(social.toggleMute('peer'), true);
  assert.equal(social.isMuted('peer'), false);
});

test('legacy device preferences require explicit ownership confirmation and import to only one account', () => {
  const { social, storage, cloud, context } = harness();
  social.showLegacyPreferences = () => {};
  storage.set('fm_blocked', JSON.stringify(['peer']));
  storage.set('fm_saved', JSON.stringify(['saved-post']));
  assert.equal(social.isBlocked('peer'), false);
  assert.equal(social._legacyPreferences().length, 2);
  context.confirm = () => false;
  assert.equal(social.restoreLegacyPreferences(), false);
  assert.equal(storage.has('fm_blocked'), true);
  context.confirm = () => true;
  assert.equal(social.restoreLegacyPreferences(), true);
  assert.equal(social.isBlocked('peer'), true);
  assert.equal(social.isSaved('saved-post'), true);
  assert.equal(storage.has('fm_blocked'), false);
  cloud.me = 'account-b';
  assert.equal(social.isBlocked('peer'), false);
  assert.equal(social.isSaved('saved-post'), false);
  assert.equal(social._legacyPreferences().length, 0);
});

test('legacy preference import failure retains source data and cannot be claimed by a different account', () => {
  const { social, storage, cloud, context } = harness();
  social.showLegacyPreferences = () => {};
  storage.set('fm_blocked', JSON.stringify(['peer']));
  storage.set('fm_saved', JSON.stringify(['saved-post']));
  const save = context.localStorage.setItem;
  context.localStorage.setItem = (key, value) => { if (key === social._listKey('fm_blocked')) throw new Error('quota'); save(key, value); };
  assert.equal(social.restoreLegacyPreferences(), false);
  assert.equal(storage.has('fm_blocked'), true);
  assert.equal(storage.has('fm_saved'), true);
  cloud.me = 'account-b';
  assert.equal(social._legacyPreferences().length, 0);
  cloud.me = 'account-a';
  context.localStorage.setItem = save;
  assert.equal(social.restoreLegacyPreferences(), true);
  assert.deepEqual(Array.from(social._list('fm_saved')), ['saved-post']);
});

test('action writes refresh credentials and never send after an identity switch during refresh', async () => {
  for (const switched of [false, true]) {
    const { context, cloud, state } = harness();
    const refresh = deferred();
    let uid = 'account-a';
    context.SupaAuth = { active: () => true, uid: () => uid, bearer: () => 'expired', token: async () => { await refresh.promise; return 'renewed'; } };
    const saving = cloud.editPost('post-1', { text: 'changed' });
    assert.equal(state.requests.length, 0);
    if (switched) uid = 'account-b';
    refresh.resolve();
    assert.equal(await saving, !switched);
    if (switched) assert.equal(state.requests.length, 0);
    else assert.equal(state.requests[0].options.headers.Authorization, 'Bearer renewed');
  }
});

test('hidden and deleted parent comments do not silently remove other members replies', async () => {
  for (const action of ['hide', 'block', 'delete']) {
    const { social, context } = harness();
    social.cloud.comments.push({ id: 'reply-1', post_id: 'post-1', parent_id: 'comment-1', author: 'account-b', body: 'Surviving reply' });
    if (action === 'hide') social._addTo('fm_hidden_cmt', 'comment-1');
    if (action === 'block') social._addTo('fm_blocked', 'account-a');
    if (action === 'delete') {
      context.fetch = async () => response(200, [{ id: 'comment-1' }]);
      assert.equal(await social.deleteComment('comment-1'), true);
    }
    social.commentNode = comment => comment.body;
    assert.equal(social.commentCount('post-1'), 1);
    assert.equal(social.renderCommentThread('post-1'), 'Surviving reply');
  }
});

test('thread rows include every descendant and orphan once without unbounded nesting', () => {
  const { social } = harness();
  social.cloud.comments.push(
    { id: 'reply-1', post_id: 'post-1', parent_id: 'comment-1', author: 'account-b', body: 'Reply' },
    { id: 'reply-2', post_id: 'post-1', parent_id: 'reply-1', author: 'account-c', body: 'Deep reply' }
  );
  assert.deepEqual(Array.from(social.commentRows('post-1'), row => row.comment.id), ['comment-1', 'reply-1', 'reply-2']);
  social._addTo('fm_hidden_cmt', 'comment-1');
  assert.deepEqual(Array.from(social.commentRows('post-1'), row => row.comment.id), ['reply-1', 'reply-2']);
  social.cloud.comments = [
    { id: 'cycle-1', post_id: 'post-1', parent_id: 'cycle-2' },
    { id: 'cycle-2', post_id: 'post-1', parent_id: 'cycle-1' }
  ];
  assert.equal(social.commentRows('post-1').length, 2);
});

test('all personal curation lists are account scoped and never adopt unattributed legacy lists', () => {
  const { cloud, social, storage } = harness();
  for (const name of personalLists) {
    storage.set(name, '["legacy-value"]');
    assert.equal(social._list(name).length, 0);
    social._addTo(name, 'account-a-value');
  }
  cloud.me = 'account-b';
  for (const name of personalLists) {
    assert.equal(social._list(name).length, 0, name);
    social._addTo(name, 'account-b-value');
  }
  cloud.me = 'account-a';
  for (const name of personalLists) {
    assert.deepEqual(Array.from(social._list(name)), ['account-a-value'], name);
    assert.equal(storage.get(name), '["legacy-value"]', 'Leave legacy data untouched');
  }
});

test('local-only accounts have separate personal lists', () => {
  const { context, social } = harness();
  context.SUPABASE_URL = '';
  for (const name of personalLists) social._addTo(name, 'account-a-value');
  social.key = 'formora_social_account-b';
  for (const name of personalLists) assert.equal(social._list(name).length, 0, name);
  social.key = 'formora_social_account-a';
  for (const name of personalLists) assert.deepEqual(Array.from(social._list(name)), ['account-a-value'], name);
});

test('curation follows the authenticated UUID and does not expose the last account after logout', () => {
  const { context, cloud, social } = harness();
  let authUid = 'authenticated-a';
  context.SupaAuth = { active: () => true, uid: () => authUid };
  social._setSaved('post-1');
  cloud.me = 'different-stale-slug';
  assert.equal(social.isSaved('post-1'), true);
  authUid = 'authenticated-b';
  assert.equal(social.isSaved('post-1'), false);
  authUid = null;
  assert.equal(social.isSaved('post-1'), false);
  authUid = 'authenticated-a';
  assert.equal(social.isSaved('post-1'), true);
});

test('save toggling and the saved-post view use the same account scope', () => {
  const { cloud, social, state, elements, storage } = harness();
  elements.set('modal-card', { innerHTML: '' });
  elements.set('modal', { classList: { remove() {} } });
  social.postCard = post => `<article>${post.id}</article>`;
  social._cloudPost = post => post;
  social.toggleSave('post-1');
  assert.equal(social.isSaved('post-1'), true);
  social.openSaved();
  assert.match(elements.get('modal-card').innerHTML, /<article>post-1<\/article>/);
  cloud.me = 'account-b';
  social.openSaved();
  assert.doesNotMatch(elements.get('modal-card').innerHTML, /<article>/);
  assert.equal(social._setSaved('post-1'), true);
  assert.equal(social._setSaved('post-1'), false);
  cloud.me = 'account-a';
  assert.equal(social.isSaved('post-1'), true);
  assert.equal(storage.has('fm_saved'), false);
  assert.equal(state.requests.length, 0);
});

test('hide, not interested, block and unblock stay local and describe their limits truthfully', () => {
  const { cloud, social, state } = harness();
  assert.equal(social.notInterested('post-1'), true);
  assert.equal(social._list('fm_notint').includes('account-a'), true);
  assert.equal(social.hidePost('post-2'), true);
  assert.equal(social.blockUser('other-account'), true);
  assert.equal(social.blockFromProfile('second-account'), true);
  for (const message of state.confirms) {
    assert.match(message, /this account on this device/i);
    assert.match(message, /can still see your content and contact you/i);
    assert.doesNotMatch(message, /won't see yours|cannot see yours/i);
  }
  cloud.me = 'account-b';
  assert.equal(social.isHidden('post-1'), false);
  assert.equal(social.isHidden('post-2'), false);
  assert.equal(social.isBlocked('other-account'), false);
  social._addTo('fm_blocked', 'other-account');
  assert.equal(social.unblockUser('other-account'), true);
  cloud.me = 'account-a';
  assert.equal(social.isBlocked('other-account'), true);
  assert.equal(social.unblockUser('other-account'), true);
  assert.equal(social.isBlocked('other-account'), false);
  assert.equal(state.requests.length, 0);
});

test('malformed personal lists are safely treated as empty arrays', () => {
  const { social, storage } = harness();
  for (const value of ['null', '{}', '"not a list"', '42', '[']) {
    for (const name of personalLists) {
      storage.set(social._listKey(name), value);
      assert.equal(social._list(name).length, 0, name);
    }
    assert.equal(social.isHidden('post-1'), false);
    assert.equal(social.isSaved('post-1'), false);
    assert.equal(social.isBlocked('account-a'), false);
    assert.equal(social.commentsFor('post-1').length, 1);
  }
});

test('local storage failures retain the actual saved/block state and offer retry', () => {
  const { context, social, state, storage } = harness();
  storage.set(social._listKey('fm_saved'), '["post-1"]');
  storage.set(social._listKey('fm_blocked'), '["existing-block"]');
  context.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.equal(social._setSaved('post-1'), true, 'Unsave failure must still return saved for reel callers');
  assert.equal(social._setSaved('post-2'), false);
  assert.equal(social.hidePost('post-1'), false);
  assert.equal(social.notInterested('post-1'), false);
  assert.equal(social.blockUser('other-account'), false);
  assert.equal(social.unblockUser('existing-block'), false);
  assert.equal(social.isSaved('post-1'), true);
  assert.equal(social.isHidden('post-1'), false);
  assert.equal(social.isBlocked('other-account'), false);
  assert.equal(social.isBlocked('existing-block'), true);
  assert.equal(state.haptics, 0);
  assert.equal(state.requests.length, 0);
  for (const message of state.toasts) assert.match(message, /could not.*try again/i);
});

test('an acknowledged report stays truthful when local hiding fails', async () => {
  const { context, social, state } = harness();
  context.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.equal(await social._doReport('post-1', 'Spam or scam'), true);
  assert.equal(social.isHidden('post-1'), false);
  assert.equal(state.requests.length, 1);
  assert.match(state.toasts.at(-1), /^Report sent\. Could not hide this item on this device\.$/);
});

const acknowledgedActions = [{ name: 'saveEditPost', id: 'post-1', args: [] }, ...socialActions];

test('late acknowledgements or failures cannot mutate a switched, logged-out or reloaded account', async () => {
  for (const action of acknowledgedActions) {
    for (const change of ['switch', 'logout', 'reload']) {
      for (const status of [200, 403]) {
        const { context, cloud, social, state, storage, elements } = harness();
        const pending = deferred();
        context.fetch = () => pending.promise;
        const sending = social[action.name](action.id, ...action.args);
        if (change === 'switch') cloud.me = 'account-b';
        else if (change === 'logout') cloud.me = null;
        else social.state = { ...social.state };
        social.cloud.feed = [{ id: 'post-1', author: cloud.me, text: 'Current account caption', likes: {} }];
        social.cloud.comments = [{ id: 'comment-1', post_id: 'post-1', author: cloud.me, body: 'Current account comment' }];
        elements.get('edit-cap').value = 'Current account draft';
        const before = JSON.stringify([social.cloud.feed, social.cloud.comments]);
        pending.resolve(response(status, [{ id: action.id }]));
        assert.equal(await sending, false, `${action.name}: ${change}, ${status}`);
        assert.equal(JSON.stringify([social.cloud.feed, social.cloud.comments]), before);
        assert.equal(elements.get('edit-cap').value, 'Current account draft');
        assert.equal(storage.size, 0);
        assert.equal(state.closes, 0);
        assert.equal(state.renders, 0);
        assert.deepEqual(state.toasts, []);
        assert.equal(social._pendingActions.size, 0);
      }
    }
  }
});

test('pending actions are keyed per account and cannot block or overwrite another account', async () => {
  const { context, cloud, social, state } = harness();
  const pending = deferred();
  context.fetch = () => pending.promise;
  const reportingA = social._doReport('post-1', 'Spam or scam');
  cloud.me = 'account-b';
  context.fetch = async () => response(201);
  assert.equal(await social._doReport('post-1', 'Something else'), true);
  assert.equal(social.isHidden('post-1'), true);
  assert.equal(state.toasts.length, 1);
  pending.resolve(response(201));
  assert.equal(await reportingA, false);
  assert.equal(state.toasts.length, 1);
  cloud.me = 'account-a';
  assert.equal(social.isHidden('post-1'), false);
});

test('different targets can be in flight together without weakening same-target duplicate protection', async () => {
  const { context, social, state } = harness();
  const first = deferred(), second = deferred();
  context.fetch = (url, options) => {
    state.requests.push({ url, options });
    return JSON.parse(options.body).target_id === 'user-1' ? first.promise : second.promise;
  };
  const sendingFirst = social.reportUser('user-1');
  const sendingSecond = social.reportUser('user-2');
  assert.equal(await social.reportUser('user-1'), false);
  assert.equal(state.requests.length, 2);
  second.resolve(response(201));
  assert.equal(await sendingSecond, true);
  first.resolve(response(403));
  assert.equal(await sendingFirst, false);
  assert.deepEqual(state.toasts.slice(0, 1), ['Report sent.']);
  assert.match(state.toasts[1], /could not.*try again/i);
});

test('caption acknowledgement preserves newer typing and updates the current polled post object only', async () => {
  const { context, social, state, elements } = harness();
  const pending = deferred();
  context.fetch = (url, options) => { state.requests.push({ url, options }); return pending.promise; };
  const saving = social.saveEditPost('post-1');
  assert.equal(elements.get('edit-cap-save').disabled, true);
  assert.equal(elements.get('edit-cap-save').textContent, 'Saving...');
  assert.equal(JSON.parse(state.requests[0].options.body).data.photo, 'photo.jpg');
  elements.get('edit-cap').value = 'An even newer draft';
  social.cloud.feed = [{ id: 'post-1', author: 'account-a', text: 'Original caption', likes: { friend: true } }];
  pending.resolve(response());
  assert.equal(await saving, true);
  assert.equal(social.cloud.feed[0].text, 'Revised caption');
  assert.deepEqual(social.cloud.feed[0].likes, { friend: true });
  assert.equal(elements.get('edit-cap').value, 'An even newer draft');
  assert.equal(elements.get('edit-cap-save').disabled, false);
  assert.equal(elements.get('edit-cap-save').textContent, 'Save changes');
  assert.equal(state.closes, 0);
  context.fetch = async () => response();
  assert.equal(await social.saveEditPost('post-1'), true);
  assert.equal(social.cloud.feed[0].text, 'An even newer draft');
  assert.equal(state.closes, 1);
});

test('a late caption acknowledgement does not close a replacement modal', async () => {
  const { context, social, state, elements } = harness();
  const pending = deferred();
  context.fetch = () => pending.promise;
  const saving = social.saveEditPost('post-1');
  elements.set('edit-cap', { value: 'Another editor' });
  pending.resolve(response());
  assert.equal(await saving, true);
  assert.equal(state.closes, 0);
  assert.equal(elements.get('edit-cap').value, 'Another editor');
});

test('every acknowledged action times out without losing content and releases its retry guard', async () => {
  for (const action of acknowledgedActions) {
    const { context, social, state, elements } = harness();
    let expire, cleared = 0;
    context.setTimeout = (callback, delay) => { assert.equal(delay, 6000); expire = callback; return 'fixture-timer'; };
    context.clearTimeout = timer => { assert.equal(timer, 'fixture-timer'); cleared++; };
    context.fetch = (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('AbortError')), { once: true });
    });
    const before = JSON.stringify([social.cloud.feed, social.cloud.comments]);
    const sending = social[action.name](action.id, ...action.args);
    assert.equal(typeof expire, 'function');
    expire();
    assert.equal(await sending, false, action.name);
    assert.equal(JSON.stringify([social.cloud.feed, social.cloud.comments]), before);
    assert.equal(elements.get('edit-cap').value, '  Revised caption  ');
    assert.equal(elements.get('edit-cap-save').disabled, false);
    assert.equal(social._pendingActions.size, 0);
    assert.equal(cleared, 1);
    assert.match(state.toasts.at(-1), /could not.*try again/i);
    context.fetch = async () => response(200, [{ id: action.id }]);
    assert.equal(await social[action.name](action.id, ...action.args), true, action.name);
    assert.equal(cleared, 2);
  }
});

test('missing or throwing Cloud action implementations fail safely and leave retry available', async () => {
  for (const action of acknowledgedActions) {
    const method = { saveEditPost: 'editPost', removePost: 'deletePost', deleteComment: 'deleteComment' }[action.name] || 'report';
    const { cloud, social, state } = harness();
    const before = JSON.stringify([social.cloud.feed, social.cloud.comments]);
    for (const implementation of [undefined, () => { throw new Error('write failed'); }, async () => { throw new Error('rejected'); }]) {
      cloud[method] = implementation;
      assert.equal(await social[action.name](action.id, ...action.args), false, action.name);
      assert.equal(JSON.stringify([social.cloud.feed, social.cloud.comments]), before);
      assert.match(state.toasts.at(-1), /could not.*try again/i);
    }
    cloud[method] = async () => true;
    assert.equal(await social[action.name](action.id, ...action.args), true, action.name);
  }
});

test('zero-row HTTP successes do not change Social captions or remove posts and comments', async () => {
  for (const action of acknowledgedActions.slice(0, 3)) {
    const { context, social, state } = harness();
    const before = JSON.stringify([social.cloud.feed, social.cloud.comments]);
    context.fetch = async () => response(200, []);
    assert.equal(await social[action.name](action.id, ...action.args), false);
    assert.equal(JSON.stringify([social.cloud.feed, social.cloud.comments]), before);
    assert.match(state.toasts.at(-1), /could not.*try again/i);
  }
});

test('local-only owner caption editing and deletion retain their existing behavior', async () => {
  const { context, social, state } = harness();
  context.SUPABASE_URL = '';
  social.state.posts = [{ id: 'local-post', author: 'me', text: 'Original caption' }];
  assert.equal(await social.saveEditPost('local-post'), true);
  assert.equal(social.state.posts[0].text, 'Revised caption');
  assert.equal(await social.removePost('local-post'), true);
  assert.equal(social.state.posts.length, 0);
  assert.equal(state.requests.length, 0);
});

test('post ownership alone does not authorize deleting another member comment', async () => {
  const { social, state } = harness();
  social.cloud.comments[0].author = 'other-account';
  assert.equal(await social.deleteComment('comment-1'), false);
  assert.equal(social.cloud.comments.length, 1);
  assert.equal(state.requests.length, 0);
  assert.equal(state.confirms.length, 0);
});

test('stale or logged-out handlers with no local state perform no writes', async () => {
  const { context, cloud, social, state } = harness();
  cloud.me = null;
  context.SupaAuth = { active: () => true, uid: () => null };
  social.state = null;
  social.cloud.feed = [];
  social.cloud.comments = [];
  social.editPost('missing-post');
  assert.equal(await social.saveEditPost('missing-post'), false);
  assert.equal(await social.removePost('missing-post'), false);
  assert.equal(await social.deleteComment('missing-comment'), false);
  assert.equal(await social._doReport('missing-post', 'Spam or scam'), false);
  assert.equal(await social.reportComment('missing-comment'), false);
  assert.equal(await social.reportUser('other-account'), false);
  assert.equal(state.requests.length, 0);
});