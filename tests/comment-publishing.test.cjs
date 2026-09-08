'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const owner = '11111111-1111-4111-8111-111111111111';
const peer = '22222222-2222-4222-8222-222222222222';
const mentioned = '33333333-3333-4333-8333-333333333333';
const commentId = '44444444-4444-4444-8444-444444444444';
const timestamp = '2026-09-07T02:00:00.000Z';
const privateBody = 'Private comment draft @peer @mentioned';
const postId = 'post-1';

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

function harness() {
  const state = { uid: owner, token: 'current-owner-token', requests: [], comments: new Map(), alerts: new Map() };
  const context = vm.createContext({
    console, URL, TextEncoder, AbortController, crypto: webcrypto, setTimeout, clearTimeout,
    SUPABASE_URL: 'https://comment-publishing.invalid', SUPABASE_ANON_KEY: 'fixture-key', USE_SUPABASE_AUTH: true,
    SupaAuth: { active: () => true, uid: () => state.uid, bearer: () => 'stale-token', token: async () => state.token },
    fetch: async (address, options = {}) => {
      const url = new URL(address);
      assert.equal(url.origin, 'https://comment-publishing.invalid');
      const request = { url, method: options.method || 'GET', body: options.body === undefined ? undefined : JSON.parse(options.body), options };
      state.requests.push(request);
      return state.handle(request);
    },
  });
  context.window = context;
  const cloud = vm.runInContext(source('js/cloud.js') + '\n;Cloud;', context);
  Object.assign(cloud, { me: owner, key: 'fixture-key', base: context.SUPABASE_URL + '/rest/v1' });
  state.handle = async request => {
    const { url, method, body, options } = request;
    if (url.pathname === '/rest/v1/comments') {
      if (method === 'GET') {
        assert.equal(body, undefined);
        const row = state.comments.get(url.searchParams.get('id')?.slice(3));
        const found = row && url.searchParams.get('author') === 'eq.' + row.author;
        const columns = url.searchParams.get('select').split(',');
        return Response.json(found ? [Object.fromEntries(columns.map(column => [column, row[column]]))] : []);
      }
      assert.equal(method, 'POST');
      assert.equal(url.searchParams.get('on_conflict'), 'id');
      assert.equal(options.headers.Prefer, 'resolution=ignore-duplicates,return=representation');
      if (state.comments.has(body.id)) return Response.json([], { status: 201 });
      const row = { ...body, ts: timestamp };
      state.comments.set(row.id, row);
      return Response.json([row], { status: 201 });
    }
    assert.equal(url.pathname, '/rest/v1/rpc/admit_social_notification');
    assert.equal(method, 'POST');
    assert.deepEqual(Object.keys(body).sort(), ['p_event_id','p_post_id','p_recipient','p_type']);
    const event = state.comments.get(body.p_event_id);
    if (!event || event.author !== state.uid || event.post_id !== body.p_post_id) return Response.json(false);
    const key = JSON.stringify(body);
    if (!state.alerts.has(key)) state.alerts.set(key, { ...body, read: false });
    return Response.json(true);
  };
  return { context, cloud, state };
}

function createComment(fixture, changes = {}) {
  const input = { postId, body: privateBody, parentId: null, mentions: [], postAuthor: peer, parentAuthor: null, id: commentId, ...changes };
  return fixture.cloud.addComment(input.postId, input.body, input.parentId, input.mentions, input.postAuthor, input.parentAuthor, input.id);
}

const writes = (state, table) => state.requests.filter(request => request.method === 'POST'
  && request.url.pathname === '/rest/v1/' + (table === 'notifications' ? 'rpc/admit_social_notification' : table));

test('Comment ACK: exact persisted row precedes checked reference-only alert fanout', async () => {
  const fixture = harness(), { state } = fixture;
  const row = await createComment(fixture);
  assert.deepEqual(row, state.comments.get(commentId));
  assert.equal(row.ts, timestamp);
  assert.deepEqual(state.requests.map(request => [request.method, request.url.pathname]), [
    ['POST', '/rest/v1/comments'], ['POST', '/rest/v1/rpc/admit_social_notification'],
  ]);
  assert.ok(state.requests.every(request => request.options.headers.Authorization === 'Bearer current-owner-token'));
  assert.equal(state.alerts.size, 1);
  const alert = writes(state, 'notifications')[0].body;
  assert.deepEqual(alert, { p_type:'comment',p_recipient:peer,p_post_id:postId,p_event_id:commentId });
  assert.equal(JSON.stringify(alert).includes(privateBody), false);
});

for (const failure of [403, 503, 'offline', 'empty-body', 'no-content']) {
  test(`Comment ACK: ${failure} returns failure without a comment or alert`, async () => {
    const fixture = harness();
    fixture.state.handle = async () => {
      if (failure === 'offline') throw new TypeError('offline');
      return new Response(null, { status: typeof failure === 'number' ? failure : failure === 'no-content' ? 204 : 201 });
    };
    assert.equal(await createComment(fixture), false);
    assert.equal(fixture.state.requests.length, 1);
    assert.equal(fixture.state.comments.size, 0);
    assert.equal(fixture.state.alerts.size, 0);
  });
}

for (const phase of ['write', 'reconcile']) {
  test(`Comment ACK: ${phase} rejects missing, malformed, forged and mismatched rows`, async () => {
    const variants = [
      () => [], () => null, row => row, () => [null], row => [row, row],
      ...['id', 'author', 'post_id', 'body', 'parent_id', 'mentions'].map(key => row => { delete row[key]; return [row]; }),
      ...Object.entries({ id: 'different-id', author: peer, post_id: 'different-post', body: 'different-body', parent_id: 'different-parent', mentions: [peer] })
        .map(([key, value]) => row => [{ ...row, [key]: value }]),
    ];
    for (const [index, variant] of variants.entries()) {
      const fixture = harness();
      let submitted;
      fixture.state.handle = async request => {
        assert.equal(request.url.pathname, '/rest/v1/comments', 'No invalid receipt may reach notification admission');
        if (request.method === 'POST') submitted = { ...request.body, ts: timestamp };
        if (phase === 'reconcile' && request.method === 'POST') return Response.json({ code: '23505' }, { status: 409 });
        return Response.json(variant({ ...submitted }), { status: 200 });
      };
      assert.equal(await createComment(fixture), false, phase + ' variant ' + index);
      assert.equal(writes(fixture.state, 'notifications').length, 0);
    }
  });
}

test('Comment ACK: pending submissions share one request and reject same-ID content changes', async () => {
  const fixture = harness(), { state, cloud } = fixture;
  const gate = deferred(), started = deferred(), handle = state.handle;
  state.handle = async request => {
    if (request.method === 'POST' && request.url.pathname.endsWith('/comments')) { started.resolve(); await gate.promise; }
    return handle(request);
  };
  const first = createComment(fixture), duplicate = createComment(fixture);
  let settled = false;
  first.then(() => { settled = true; });
  await started.promise;
  assert.equal(settled, false);
  assert.equal(await createComment(fixture, { body: 'Edited while pending' }), false);
  assert.equal(writes(state, 'comments').length, 1);
  assert.equal(state.alerts.size, 0);
  gate.resolve();
  const results = await Promise.all([first, duplicate]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(state.comments.size, 1);
  assert.equal(state.alerts.size, 1);
  assert.equal(cloud._commentWrites.size, 0);
});

for (const conflict of [201, 409]) {
  test(`Comment ACK: unknown write ACK reconciles the same ID after ${conflict} without overwriting`, async () => {
    const fixture = harness(), { state } = fixture;
    const handle = state.handle;
    state.handle = async request => {
      if (request.method === 'POST' && request.url.pathname.endsWith('/comments')) {
        if (state.comments.has(request.body.id)) return Response.json(conflict === 409 ? {} : [], { status: conflict });
        await handle(request);
        throw new TypeError('Committed; acknowledgement lost');
      }
      return handle(request);
    };
    assert.equal(await createComment(fixture), false);
    assert.equal(state.comments.size, 1);
    assert.equal(state.alerts.size, 0);
    const original = { ...state.comments.get(commentId) };
    assert.deepEqual(await createComment(fixture), original);
    assert.equal(state.comments.size, 1);
    assert.equal(state.alerts.size, 1);
    assert.equal(await createComment(fixture, { body: 'Cannot overwrite original' }), false);
    assert.deepEqual(state.comments.get(commentId), original);
    assert.ok(writes(state, 'comments').every(request => request.body.id === commentId));
    const reads = state.requests.filter(request => request.method === 'GET');
    assert.ok(reads.every(request => request.url.searchParams.get('id') === 'eq.' + commentId
      && request.url.searchParams.get('author') === 'eq.' + owner));
    assert.equal(writes(state, 'notifications').length, 1);
  });
}

test('Comment ACK: duplicate reply and mention recipients get one stable alert each, never self', async () => {
  const fixture = harness(), { state } = fixture;
  const input = { parentId: 'parent-1', parentAuthor: peer, postAuthor: mentioned, mentions: [peer, peer, owner, mentioned] };
  const row = await createComment(fixture, input);
  assert.equal(row.parent_id, 'parent-1');
  assert.deepEqual(row.mentions, input.mentions);
  assert.deepEqual(writes(state, 'notifications').map(request => [request.body.p_recipient, request.body.p_type]), [[peer, 'reply']]);
  input.postAuthor = owner;
  assert.ok(await createComment(fixture, input));
  assert.deepEqual(writes(state, 'notifications').slice(1).map(request => [request.body.p_recipient, request.body.p_type]), [[peer, 'reply'], [mentioned, 'mention']]);
  assert.equal(state.alerts.size, 2);
  for (const request of writes(state, 'notifications')) {
    assert.notEqual(request.body.p_recipient, owner);
    assert.equal(request.body.p_event_id, commentId);
    assert.equal(Object.hasOwn(request.body, 'body'), false);
  }
});

test('Comment ACK: notification failure retains durable comment and retry cannot duplicate or mark it unread', async () => {
  const fixture = harness(), { state } = fixture;
  const handle = state.handle;
  state.handle = async request => {
    const response = await handle(request);
    if (request.url.pathname.endsWith('/admit_social_notification') && writes(state, 'notifications').length === 1) throw new TypeError('Alert committed; acknowledgement lost');
    return response;
  };
  assert.deepEqual(await createComment(fixture), state.comments.get(commentId));
  const alert = [...state.alerts.values()][0];
  alert.read = true;
  assert.ok(await createComment(fixture));
  assert.equal(state.comments.size, 1);
  assert.equal(state.alerts.size, 1);
  assert.equal(alert.read, true);
  assert.deepEqual(writes(state, 'notifications')[0].body, writes(state, 'notifications')[1].body);
});

test('Comment ACK: denied source admission does not undo the durable comment', async () => {
  const fixture = harness(), handle = fixture.state.handle;
  fixture.state.handle = request => request.url.pathname.endsWith('/admit_social_notification') ? Response.json(false) : handle(request);
  assert.ok(await createComment(fixture));
  assert.equal(fixture.state.comments.size, 1);
  assert.equal(writes(fixture.state, 'notifications').length, 1);
  assert.equal(fixture.state.alerts.size, 0);
});

test('Comment ACK: calls without an ID mint crypto IDs; unauthenticated, stale-owner and invalid inputs fail closed', async () => {
  const fixture = harness(), { context, cloud, state } = fixture;
  const first = await createComment(fixture, { id: undefined }), second = await createComment(fixture, { id: undefined });
  assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first.id, second.id);
  state.requests.length = 0;
  for (const input of [{ id: '' }, { postId: '' }, { body: ' ' }, { body: {} }, { mentions: {} }, { mentions: [null] }, { parentId: "bad'parent" }]) {
    assert.equal(await createComment(fixture, input), false);
  }
  cloud.me = peer;
  assert.equal(await createComment(fixture), false);
  cloud.me = owner; state.token = null;
  assert.equal(await createComment(fixture), false);
  state.uid = null;
  assert.equal(await createComment(fixture), false);
  context.SupaAuth.active = () => false;
  assert.equal(await createComment(fixture), false);
  assert.equal(state.requests.length, 0);
});

for (const phase of ['write-token', 'write-json', 'reconcile-json', 'notification-token', 'notification-json']) {
  test(`Comment ACK: owner/session fence rejects delayed ${phase}, including same-account return`, { timeout: 2000 }, async () => {
    const fixture = harness(), { context, cloud, state } = fixture;
    const started = deferred(), gate = deferred(), handle = state.handle;
    let tokenCalls = 0;
    context.SupaAuth.token = async () => {
      tokenCalls++;
      if ((phase === 'write-token' && tokenCalls === 1) || (phase === 'notification-token' && tokenCalls === 2)) {
        started.resolve(); await gate.promise;
      }
      return state.token;
    };
    state.handle = async request => {
      if (phase === 'reconcile-json' && request.method === 'POST') {
        await handle(request);
        return Response.json({}, { status: 409 });
      }
      const response = await handle(request);
      if ((phase === 'write-json' && request.url.pathname.endsWith('/comments') && request.method === 'POST')
        || (phase === 'reconcile-json' && request.method === 'GET')
        || (phase === 'notification-json' && request.url.pathname.endsWith('/admit_social_notification'))) {
        const json = response.json.bind(response);
        response.json = async () => { started.resolve(); await gate.promise; return json(); };
      }
      return response;
    };
    const pending = createComment(fixture);
    await started.promise;
    cloud.resetPublishing();
    state.uid = peer; cloud.me = peer;
    state.uid = owner; cloud.me = owner;
    gate.resolve();
    assert.equal(await pending, false);
    assert.equal(writes(state, 'notifications').length, phase === 'notification-json' ? 1 : 0);
    assert.ok(writes(state, 'notifications').every(request => request.body.p_recipient === peer));
    if (phase === 'write-token') assert.equal(state.requests.length, 0);
    assert.equal(cloud._publishingControllers.size, 0);
  });
}

test('Comment ACK: a last-moment notification token owner change cannot send as the next owner', async () => {
  const fixture = harness(), { context, cloud, state } = fixture;
  let tokens = 0;
  context.SupaAuth.token = async () => {
    if (++tokens === 2) { state.uid = peer; cloud.me = peer; }
    return 'new-session-token';
  };
  assert.equal(await createComment(fixture), false);
  assert.equal(state.comments.get(commentId).author, owner);
  assert.equal(writes(state, 'notifications').length, 0);
});

test('Comment ACK: delayed reconciliation body cannot resolve or notify before its exact row arrives', async () => {
  const fixture = harness(), { state } = fixture, handle = fixture.state.handle;
  const started = deferred(), gate = deferred();
  state.handle = async request => {
    const response = await handle(request);
    if (request.method === 'POST' && request.url.pathname.endsWith('/comments')) return Response.json([], { status: 201 });
    if (request.method === 'GET' && request.url.searchParams.get('select').includes('body')) {
      const json = response.json.bind(response);
      response.json = async () => { started.resolve(); await gate.promise; return json(); };
    }
    return response;
  };
  let settled = false;
  const pending = createComment(fixture).then(row => { settled = true; return row; });
  await started.promise;
  assert.equal(settled, false);
  assert.equal(writes(state, 'notifications').length, 0);
  gate.resolve();
  assert.deepEqual(await pending, state.comments.get(commentId));
  assert.equal(state.alerts.size, 1);
});

test('Comment ACK: denied notification writes do not invalidate a durable comment or claim delivery', async () => {
  const fixture = harness(), { state } = fixture, handle = fixture.state.handle;
  state.handle = request => request.url.pathname.endsWith('/admit_social_notification') ? Response.json({}, { status: 403 }) : handle(request);
  const receipt = await createComment(fixture);
  assert.deepEqual(receipt, state.comments.get(commentId));
  assert.equal(Object.hasOwn(receipt, 'delivered'), false);
  assert.equal(state.alerts.size, 0);
  state.handle = handle;
  assert.ok(await createComment(fixture));
  assert.equal(state.comments.size, 1);
  assert.equal(state.alerts.size, 1);
  assert.deepEqual(writes(state, 'notifications')[0].body, writes(state, 'notifications')[1].body);
});

function element(value = '') {
  const attributes = new Map(), classes = new Set();
  return {
    value, style: {}, innerHTML: '', textContent: '', disabled: false, isConnected: true,
    setAttribute: (key, value) => attributes.set(key, String(value)),
    getAttribute: key => attributes.get(key) ?? null,
    removeAttribute: key => attributes.delete(key),
    classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) },
    focus() {}, querySelector: () => null, querySelectorAll: () => [],
  };
}

function feedHarness() {
  const fixture = harness(), { context, state } = fixture;
  const input = element('  ' + privateBody + '  '), button = element(), panel = element(), thread = element(), count = element();
  panel.style.display = 'block';
  const elements = new Map([['ci-' + postId, input], ['cmts-' + postId, panel]]);
  input.parentElement = { querySelector: selector => selector === '.send-ico' ? button : null };
  panel.querySelector = selector => selector === '.comment-thread' ? thread : null;
  panel.closest = () => ({ querySelector: selector => selector === '[data-comment-count]' ? count : null });
  const storage = new Map();
  Object.assign(state, { toasts: [], renders: 0, saves: 0 });
  Object.assign(context, {
    document: { getElementById: id => elements.get(id) || null, querySelector: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
    App: { _entry: 5, curTab: 'home', toast: text => state.toasts.push(text), ic: () => '', sendIcon: () => '' },
    Store: { state: { profile: { name: 'Owner', username: 'owner', verified: true } } },
    esc: value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])),
  });
  const social = vm.runInContext(source('js/mod/social.js') + '\n;Social;', context);
  social.key = 'formora_social_owner'; social._session = 1; social._openCmt = postId; social.sub = 'feed';
  social.state = { seeded: true, posts: [], crew: [], challenges: [], chats: {}, following: [] };
  social.cloud.feed = [{ id: postId, author: peer }];
  social.cloud.users = [{ uid: peer, name: 'Peer', username: 'peer' }, { uid: mentioned, name: 'Mentioned', username: 'mentioned' }];
  social.render = () => { state.renders++; input.value = ''; };
  return { ...fixture, social, input, button, panel, thread, count, elements };
}

function holdComment(fixture) {
  const gate = deferred(), started = deferred(), handle = fixture.state.handle;
  fixture.state.handle = async request => {
    if (request.method === 'POST' && request.url.pathname.endsWith('/comments')) { started.resolve(); await gate.promise; }
    return handle(request);
  };
  return { started: started.promise, release: gate.resolve };
}

for (const failure of [403, 503, 'offline']) {
  test(`Feed comment: ${failure} keeps the draft and makes no local comment, success toast or alert`, async () => {
    const fixture = feedHarness(), original = fixture.input.value;
    fixture.state.handle = async () => {
      if (failure === 'offline') throw new TypeError('offline');
      return Response.json({}, { status: failure });
    };
    assert.equal(await fixture.social.submitComment(postId), false);
    assert.equal(fixture.input.value, original);
    assert.equal(fixture.social.cloud.comments.length, 0);
    assert.equal(fixture.state.renders, 0);
    assert.equal(fixture.state.toasts.filter(text => /posted/i.test(text)).length, 0);
    assert.match(fixture.state.toasts[0], /draft.*kept/i);
    assert.equal(fixture.state.alerts.size, 0);
    assert.equal(fixture.button.disabled, false);
    assert.equal(fixture.input.getAttribute('aria-busy'), null);
  });
}

test('Feed comment: one pending intent commits only after ACK without a whole-feed rerender', async () => {
  const fixture = feedHarness(), { social, state, input, button, thread, count } = fixture;
  const gate = holdComment(fixture), original = input.value;
  const pending = social.submitComment(postId);
  assert.equal(await social.submitComment(postId), false);
  await gate.started;
  assert.equal(input.value, original);
  assert.equal(input.getAttribute('aria-busy'), 'true');
  assert.equal(button.disabled, true);
  assert.equal(social.cloud.comments.length, 0);
  assert.equal(state.toasts.length, 0);
  assert.equal(writes(state, 'comments').length, 1);
  gate.release();
  assert.equal(await pending, true);
  assert.equal(input.value, '');
  assert.equal(button.disabled, false);
  assert.equal(input.getAttribute('aria-busy'), null);
  assert.equal(social.cloud.comments.length, 1);
  assert.equal(social.cloud.comments[0].ts, Date.parse(timestamp));
  assert.equal(count.textContent, '1');
  assert.match(thread.innerHTML, /Private comment draft/);
  assert.equal(state.renders, 0);
  assert.deepEqual(state.toasts, ['Comment posted']);
});

test('Feed comment: a new draft and changed reply target survive the previous ACK', async () => {
  const fixture = feedHarness(), { social, input } = fixture;
  social.startReply(postId, 'parent-original', peer); input.value = privateBody;
  const gate = holdComment(fixture), pending = social.submitComment(postId);
  await gate.started;
  social.startReply(postId, 'parent-next', mentioned);
  const nextReply = social._replyTo;
  input.value = privateBody;
  gate.release();
  assert.equal(await pending, true);
  assert.equal(input.value, privateBody, 'An explicit reply-target change is a new draft even when text is identical');
  assert.equal(social._replyTo, nextReply);
  assert.equal(social.cloud.comments[0].parent_id, 'parent-original');
});

test('Feed comment: text typed while pending is not cleared or lost on success', async () => {
  const fixture = feedHarness(), gate = holdComment(fixture);
  const pending = fixture.social.submitComment(postId);
  await gate.started;
  fixture.input.value = 'Newer unsent draft';
  gate.release();
  assert.equal(await pending, true);
  assert.equal(fixture.input.value, 'Newer unsent draft');
});

test('Feed comment: unknown ACK retries the retained ID; explicitly edited content gets a new ID', async () => {
  const fixture = feedHarness(), { social, state, input } = fixture, handle = fixture.state.handle;
  state.handle = async request => {
    const response = await handle(request);
    if (request.method === 'POST' && request.url.pathname.endsWith('/comments') && writes(state, 'comments').length === 1) throw new TypeError('Unknown ACK after commit');
    return response;
  };
  const original = input.value;
  assert.equal(await social.submitComment(postId), false);
  assert.equal(input.value, original);
  assert.equal(state.comments.size, 1);
  assert.equal(social.cloud.comments.length, 0);
  assert.equal(await social.submitComment(postId), true);
  const posted = writes(state, 'comments');
  assert.equal(posted[0].body.id, posted[1].body.id);
  assert.equal(state.comments.size, 1);
  state.handle = async () => Response.json({}, { status: 503 });
  input.value = 'Next comment';
  assert.equal(await social.submitComment(postId), false);
  const failedId = writes(state, 'comments').at(-1).body.id;
  input.value = 'Explicitly edited next comment';
  state.handle = handle;
  assert.equal(await social.submitComment(postId), true);
  assert.notEqual(writes(state, 'comments').at(-1).body.id, failedId);
  assert.equal(state.comments.size, 2);
});

for (const change of ['close-reopen', 'different-feed', 'entry', 'session', 'account-aba']) {
  test(`Feed comment: ${change} fences late UI updates and releases reopened pending state`, async () => {
    const fixture = feedHarness(), { social, input, button, panel, state, context, cloud } = fixture;
    const gate = holdComment(fixture), pending = social.submitComment(postId);
    await gate.started;
    if (change === 'close-reopen') {
      social.toggleComments(postId); social.toggleComments(postId);
      assert.equal(button.disabled, false);
      assert.equal(input.getAttribute('aria-busy'), null);
    } else if (change === 'different-feed') { social.sub = 'crew'; context.App.curTab = 'search'; }
    else if (change === 'entry') context.App._entry++;
    else {
      social.resetSession();
      if (change === 'account-aba') { state.uid = peer; cloud.me = peer; state.uid = owner; cloud.me = owner; }
    }
    input.value = 'New view draft';
    gate.release();
    assert.equal(await pending, false);
    assert.equal(input.value, 'New view draft');
    assert.equal(social.cloud.comments.length, 0);
    assert.equal(state.toasts.length, 0);
    assert.equal(state.renders, 0);
    assert.equal(panel.innerHTML, '');
    if (['session', 'account-aba'].includes(change)) assert.equal(state.alerts.size, 0);
  });
}

test('Feed comment: session reset clears reply and retry intentions; the real demo path stays local', async () => {
  const fixture = feedHarness(), { social, cloud, context, state, input, panel } = fixture;
  social._replyTo = { postId, parentId: 'parent', parentAuthor: peer };
  social.resetSession();
  assert.equal(social._replyTo, null);
  assert.equal(social._openCmt, null);
  assert.equal(social._commentRequests.size, 0);
  context.USE_SUPABASE_AUTH = false;
  context.SupaAuth.active = () => false;
  cloud.active = () => false;
  social.state.posts = [{ id: postId, author: 'me', comments: [] }];
  input.value = 'Local demo comment'; panel.style.display = 'block';
  await social.submitComment(postId);
  assert.equal(social.state.posts[0].comments.length, 1);
  assert.equal(social.state.posts[0].comments[0].text, 'Local demo comment');
  assert.equal(state.requests.length, 0);
});

for (const destination of ['reply', 'post']) {
  test(`Feed comment: changed ${destination} destination starts a new intent even with identical text`, async () => {
    const fixture = feedHarness(), { social, state, input } = fixture, handle = fixture.state.handle;
    input.value = 'Destination-bound comment';
    state.handle = async () => Response.json({}, { status: 503 });
    assert.equal(await social.submitComment(postId), false);
    const originalId = writes(state, 'comments')[0].body.id;
    if (destination === 'reply') social.startReply(postId, 'changed-parent', peer);
    else social.cloud.feed[0].author = mentioned;
    input.value = 'Destination-bound comment'; state.handle = handle;
    assert.equal(await social.submitComment(postId), true);
    assert.notEqual(writes(state, 'comments').at(-1).body.id, originalId);
    assert.deepEqual(writes(state, 'notifications').map(request => [request.body.p_recipient, request.body.p_type]), [destination === 'reply' ? [peer, 'reply'] : [mentioned, 'comment']]);
  });
}

function flexHarness() {
  const fixture = feedHarness(), { context, elements, state } = fixture;
  const overlay = element();
  elements.set('reel-comments', overlay);
  elements.set('rcnt-' + postId, element());
  elements.set('app-shell', element());
  let markup = '';
  Object.defineProperty(overlay, 'innerHTML', {
    get: () => markup,
    set(value) {
      markup = value;
      for (const id of ['rc-input', 'rc-list', 'rc-title', 'rc-send']) {
        const previous = elements.get(id); if (previous) previous.isConnected = false;
        elements.delete(id);
      }
      if (value.includes('id="rc-input"')) {
        const input = element(), button = element();
        input.parentElement = { querySelector: selector => selector === '.send-ico' ? button : null };
        elements.set('rc-input', input); elements.set('rc-send', button);
        elements.set('rc-list', element()); elements.set('rc-title', element());
      }
    },
  });
  Object.assign(context.document, {
    addEventListener() {}, documentElement: element(),
    querySelector: selector => selector === '#reel-comments .rc-title' ? elements.get('rc-title') || null : null,
  });
  context.clearInterval = clearInterval;
  context.Auth = { currentUser: () => ({ id: 'fixture-owner', email: 'owner@example.test' }), logout() {} };
  const app = vm.runInContext(source('js/app.js') + '\n;App;', context);
  Object.assign(app, { _entry: 5, _authUid: owner, curTab: 'flex', toast: text => state.toasts.push(text),
    closeModal() {}, closeSheet() {}, updateNotifBadge() {}, showAuth() {} });
  app.openReelComments(postId);
  elements.get('rc-input').value = privateBody;
  return { ...fixture, app, overlay };
}

for (const failure of [403, 503, 'offline']) {
  test(`Flex comment: ${failure} retains input without inserting a comment or alert`, async () => {
    const fixture = flexHarness(), { app, social, state, elements } = fixture;
    state.handle = async () => {
      if (failure === 'offline') throw new TypeError('offline');
      return Response.json({}, { status: failure });
    };
    assert.equal(await app.submitReelComment(postId), false);
    assert.equal(elements.get('rc-input').value, privateBody);
    assert.equal(elements.get('rc-send').disabled, false);
    assert.equal(elements.get('rc-input').getAttribute('aria-busy'), null);
    assert.equal(social.cloud.comments.length, 0);
    assert.equal(state.alerts.size, 0);
    assert.match(state.toasts[0], /draft.*kept/i);
  });
}

test('Flex comment: single flight waits for exact ACK and preserves newly typed input', async () => {
  const fixture = flexHarness(), { app, social, elements, state } = fixture;
  const gate = holdComment(fixture), input = elements.get('rc-input');
  const pending = app.submitReelComment(postId);
  assert.equal(await app.submitReelComment(postId), false);
  await gate.started;
  assert.equal(writes(state, 'comments').length, 1);
  assert.equal(input.value, privateBody);
  assert.equal(elements.get('rc-send').disabled, true);
  assert.equal(social.cloud.comments.length, 0);
  input.value = 'Next unsent Flex comment';
  gate.release();
  assert.equal(await pending, true);
  assert.equal(input.value, 'Next unsent Flex comment');
  assert.equal(elements.get('rc-send').disabled, false);
  assert.equal(elements.get('rc-title').textContent, '1 comment');
  assert.equal(String(elements.get('rcnt-' + postId).textContent), '1');
  assert.match(elements.get('rc-list').innerHTML, /Private comment draft/);
  assert.equal(social.cloud.comments.length, 1);
});

test('Flex comment: unknown ACK retains the ID across same-owner close/reopen; changed content starts a new intent', async () => {
  const fixture = flexHarness(), { app, state, elements, social } = fixture, handle = fixture.state.handle;
  state.handle = async request => {
    const response = await handle(request);
    if (request.method === 'POST' && request.url.pathname.endsWith('/comments') && writes(state, 'comments').length === 1) throw new TypeError('Unknown ACK after commit');
    return response;
  };
  assert.equal(await app.submitReelComment(postId), false);
  assert.equal(elements.get('rc-input').value, privateBody);
  app.closeReelComments(); app.openReelComments(postId);
  assert.equal(elements.get('rc-send').disabled, false);
  elements.get('rc-input').value = privateBody;
  assert.equal(await app.submitReelComment(postId), true);
  assert.equal(writes(state, 'comments')[0].body.id, writes(state, 'comments')[1].body.id);
  assert.equal(state.comments.size, 1);
  assert.equal(elements.get('rc-input').value, '');
  elements.get('rc-input').value = 'Edited Flex comment';
  assert.equal(await app.submitReelComment(postId), true);
  assert.notEqual(writes(state, 'comments').at(-1).body.id, writes(state, 'comments')[0].body.id);
  assert.equal(social.cloud.comments.length, 2);
});

for (const change of ['close-reopen', 'other-post', 'other-tab', 'session', 'logout', 'account-aba']) {
  test(`Flex comment: ${change} blocks stale insert, draft clearing and count updates`, async () => {
    const fixture = flexHarness(), { app, social, state, elements, cloud } = fixture;
    const gate = holdComment(fixture), pending = app.submitReelComment(postId);
    await gate.started;
    if (change === 'close-reopen') { app.closeReelComments(); app.openReelComments(postId); }
    else if (change === 'other-post') { social.cloud.feed.push({ id: 'post-2', author: peer }); app.openReelComments('post-2'); }
    else if (change === 'other-tab') app.curTab = 'home';
    else {
      if (change === 'logout') app.logout(); else social.resetSession();
      assert.equal(app._reelCmtId, null);
      assert.equal(elements.get('rc-input'), undefined, 'Session reset must remove the old private draft from the overlay');
      if (change === 'account-aba') { state.uid = peer; cloud.me = peer; state.uid = owner; cloud.me = owner; }
      app.openReelComments(postId);
    }
    const currentInput = elements.get('rc-input');
    currentInput.value = 'New sheet draft';
    const title = elements.get('rc-title').textContent, list = elements.get('rc-list').innerHTML;
    gate.release();
    assert.equal(await pending, false);
    assert.equal(currentInput.value, 'New sheet draft');
    assert.equal(social.cloud.comments.length, 0);
    assert.equal(elements.get('rc-title').textContent, title);
    assert.equal(elements.get('rc-list').innerHTML, list);
    assert.equal(state.toasts.length, 0);
    if (change !== 'other-tab') assert.equal(elements.get('rc-send').disabled, false);
    if (['session', 'logout', 'account-aba'].includes(change)) assert.equal(state.alerts.size, 0);
  });
}

test('Flex comment: original flat reply/mention behavior remains and a wrong destination cannot submit', async () => {
  const fixture = flexHarness(), { app, elements, state, social } = fixture;
  app.reelReply(peer);
  elements.get('rc-input').value += 'A reply';
  assert.equal(await app.submitReelComment('not-the-open-post'), false);
  assert.equal(state.requests.length, 0);
  assert.equal(await app.submitReelComment(postId), true);
  assert.equal(social.cloud.comments[0].parent_id, null);
  assert.deepEqual(Array.from(social.cloud.comments[0].mentions), [peer]);
  assert.equal(writes(state, 'notifications').length, 1);
  assert.equal(writes(state, 'notifications')[0].body.p_type, 'comment');
});

if (process.env.COMMENT_PUBLISHING_BROWSER === '1') test('Comment browser: actual Feed and Flex draft, retry and stale-sheet flow', { timeout: 18000 }, async context => {
  const Module = require('node:module'), filename = path.join(root, 'tests/social-publishing.e2e.cjs');
  const hooks = { before: [], after: [] }, cleanups = [];
  const suite = new Module(filename, module);
  suite.filename = filename; suite.paths = Module._nodeModulePaths(path.dirname(filename));
  suite.require = name => name === 'node:test' ? { test() {}, before: callback => hooks.before.push(callback), after: callback => hooks.after.push(callback) } : require(name);
  suite._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports = { openApp };', filename);
  const comments = new Map(), alerts = new Map(), commentWrites = [], alertWrites = [], checkedReads = [], gates = [];
  const hold = () => { const started = deferred(), released = deferred(); const gate = { started, released }; gates.push(gate); return gate; };
  try {
    for (const start of hooks.before) await start();
    const client = await suite.exports.openApp({ after: callback => cleanups.push(callback) }, { width: 390, height: 844 });
    const { page, state } = client;
    await page.route('**/rest/v1/comments**', async route => {
      try {
        const request = route.request(), url = new URL(request.url());
        assert.equal(url.origin, new URL(page.url()).origin);
        assert.equal(request.headers().authorization, 'Bearer fixture-owner-token');
        if (request.method() === 'GET') {
          assert.equal(request.postData(), null);
          assert.equal(url.searchParams.get('author'), 'eq.' + owner);
          const row = comments.get(url.searchParams.get('id')?.slice(3));
          checkedReads.push({ id: row?.id || null, select: url.searchParams.get('select') });
          return route.fulfill({ status: 200, json: row ? [Object.fromEntries(url.searchParams.get('select').split(',').map(column => [column, row[column]]))] : [] });
        }
        assert.equal(request.method(), 'POST');
        const body = request.postData() ? request.postDataJSON() : undefined;
        assert.equal(body.author, owner);
        assert.equal(request.headers().prefer, 'resolution=ignore-duplicates,return=representation');
        commentWrites.push(body);
        const gate = gates.shift();
        let mode;
        if (gate) { gate.started.resolve(body); mode = await gate.released.promise; }
        if (mode === 503) return route.fulfill({ status: 503, json: { error: 'fixture_rejection' } });
        if (comments.has(body.id)) return route.fulfill({ status: 201, json: [] });
        const row = { ...body, ts: timestamp }; comments.set(row.id, row);
        if (mode === 'lost') return route.abort('failed');
        return route.fulfill({ status: 201, json: [row] });
      } catch (error) { state.unexpected.push(error.message); await route.abort().catch(() => {}); }
    });
    await page.route('**/rest/v1/rpc/admit_social_notification', async route => {
      try {
        const request = route.request();
        assert.equal(request.method(), 'POST');
        const body = request.postData() ? request.postDataJSON() : undefined;
        assert.equal(body.p_recipient, peer);
        assert.deepEqual(Object.keys(body).sort(), ['p_event_id','p_post_id','p_recipient','p_type']);
        const event = comments.get(body.p_event_id);
        assert.equal(event?.author, owner);
        assert.equal(event.post_id, body.p_post_id);
        const key = JSON.stringify(body);
        alertWrites.push(body); if (!alerts.has(key)) alerts.set(key, body);
        return route.fulfill({ status: 200, json: true });
      } catch (error) { state.unexpected.push(error.message); await route.abort().catch(() => {}); }
    });
    await page.evaluate(() => Cloud.setPaused(true));
    await page.locator('button[onclick="Social.toggleComments(\'post-peer\')"]').click();
    const input = page.locator('#ci-post-peer'), send = page.locator('#cmts-post-peer .send-ico');
    const body = 'Browser private comment @fixture_peer';
    await input.fill(body);
    const denied = hold();
    await send.click();
    const first = await denied.started.promise;
    await input.press('Enter');
    assert.equal(commentWrites.length, 1);
    assert.equal(await input.inputValue(), body);
    assert.equal(await send.isDisabled(), true);
    assert.equal(await page.locator('#cmts-post-peer .cmt2').count(), 0);
    assert.equal(alerts.size, 0);
    denied.released.resolve(503);
    await page.waitForFunction(() => !document.querySelector('#cmts-post-peer .send-ico').disabled);
    assert.equal(await input.inputValue(), body);
    assert.equal(await page.locator('#cmts-post-peer .cmt2').count(), 0);
    const lost = hold();
    await send.click();
    assert.equal((await lost.started.promise).id, first.id);
    lost.released.resolve('lost');
    await page.waitForFunction(() => !document.querySelector('#cmts-post-peer .send-ico').disabled);
    assert.equal(await input.inputValue(), body);
    assert.equal(comments.size, 1); assert.equal(alerts.size, 0);
    await send.click();
    await page.waitForFunction(() => document.getElementById('ci-post-peer').value === '');
    assert.equal(commentWrites.length, 3);
    assert.ok(commentWrites.every(row => row.id === first.id));
    assert.equal(comments.size, 1); assert.equal(alerts.size, 1);
    assert.equal(await page.locator('#cmts-post-peer .cmt2').count(), 1);
    assert.equal(await page.locator('.post').filter({ has: page.locator('#cmts-post-peer') }).locator('[data-comment-count]').innerText(), '1');

    await page.evaluate(() => { App.selectTab('flex'); App.openReelComments('post-peer'); });
    const flex = page.locator('#rc-input');
    await flex.fill('Late Flex comment');
    const delayed = hold();
    await page.locator('#reel-comments .send-ico').click();
    const late = await delayed.started.promise;
    await page.locator('#reel-comments .rc-head .icon-btn').click();
    await page.evaluate(() => App.openReelComments('post-peer'));
    await flex.fill('New sheet draft');
    assert.equal(await page.locator('#reel-comments .send-ico').isDisabled(), false);
    delayed.released.resolve('ok');
    await page.waitForFunction(() => !Cloud._commentWrites.size && !Social._pendingActions.size);
    assert.equal(await flex.inputValue(), 'New sheet draft');
    assert.equal(await page.locator('#rc-list .cmt2').count(), 1);
    assert.equal(comments.size, 2);
    await flex.fill('Late Flex comment');
    await page.locator('#reel-comments .send-ico').click();
    await page.waitForFunction(() => document.getElementById('rc-input').value === '');
    assert.equal(commentWrites.at(-1).id, late.id);
    assert.equal(comments.size, 2);
    assert.equal(alerts.size, 2);
    assert.equal(alertWrites.at(-1).id, alertWrites.at(-2).id);
    assert.equal(await page.locator('#rc-list .cmt2').count(), 2);
    assert.equal(await page.locator('#reel-comments .rc-title').innerText(), '2 comments');
    await flex.fill('Must disappear on logout');
    await page.evaluate(() => App.logout());
    assert.equal(await page.locator('#rc-input').count(), 0);
    assert.equal(await page.locator('#reel-comments').innerHTML(), '');
    assert.ok(checkedReads.every(read => read.id));
    assert.deepEqual(await page.evaluate(() => [SERVER_MEASUREMENT, FORMORA_WEB_PUSH, STORY_INTERACTIONS, STORY_MEDIA_VALIDATION]), [false, false, false, false]);
    assert.deepEqual(state.pageErrors, []);
    context.diagnostic(JSON.stringify({ commentWrites: commentWrites.length, durableComments: comments.size, alertWrites: alertWrites.length,
      distinctAlerts: alerts.size, checkedReads: checkedReads.length, pageErrors: state.pageErrors.length,
      unexpectedRequests: state.unexpected.length, externalAttempts: state.external, flagsUnchanged: true,
      scope: 'One actual App flow at 390px; Feed and Flex comment sheets only, not playable Flex media or hosted delivery' }));
  } finally {
    gates.forEach(gate => gate.released.resolve(503));
    try { for (const cleanup of cleanups.reverse()) await cleanup(); }
    finally { for (const stop of hooks.after.reverse()) await stop(); }
  }
});