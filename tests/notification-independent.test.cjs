'use strict';
/* Independent retest of the T-108 legacy Alerts slice (office/notification-lifecycle-rollout.json).
   Written without reusing the implementation owner's fixtures: every probe drives the real
   js/cloud.js + js/app.js (and js/mod/social.js for the Story-context catch) inside an isolated
   VM with a recording transport. No server, no browser, no hosted request, no product edit.
   Probes are deliberately adversarial: they assert the failure direction first and keep a
   positive control so a permanently-false implementation cannot pass. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PEER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TS = '2026-09-06T10:00:00.000Z';

const ok = (rows, code = 200) => ({ ok: code >= 200 && code < 300, status: code, json: async () => rows });
const flush = () => new Promise(resolve => setImmediate(resolve));
const alert = (id, extra = {}) => ({ id, uid: OWNER, actor: PEER, type: 'message', post_id: null, ts: TS, read: false, ...extra });

// ----------------------------------------------------------------- cloud transport probes

function cloudProbe() {
  const timers = [];
  const state = { uid: OWNER, token: 'fresh-jwt', net: [] };
  const context = vm.createContext({
    window: { SUPABASE_URL: 'https://probe.invalid', SUPABASE_ANON_KEY: 'anon-probe', USE_SUPABASE_AUTH: true },
    SupaAuth: { active: () => true, uid: () => state.uid, token: async () => state.token, bearer: () => 'stale-anon-bearer' },
    console, crypto: webcrypto, AbortController, URL, TextEncoder,
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cleared = true; },
    setInterval: () => 0, clearInterval: () => {},
    fetch: async (url, init) => { state.net.push({ url, init }); return ok([]); },
  });
  vm.runInContext(read('js/cloud.js') + '\nglobalThis.__cloud = Cloud;', context);
  const cloud = context.__cloud;
  Object.assign(cloud, { me: OWNER, key: 'anon-probe', base: 'https://probe.invalid/rest/v1' });
  const fireDeadline = () => {
    const live = timers.filter(timer => !timer.cleared);
    assert.equal(live.length, 1, 'exactly one live deadline is expected');
    assert.equal(live[0].ms, 6000, 'the notification deadline must stay at the recorded 6000ms');
    live[0].fn();
  };
  return { context, cloud, state, timers, fireDeadline };
}

test('the 6000ms deadline settles a token that ignores abort, and the late token can never issue a request', async () => {
  const { context, cloud, state, fireDeadline } = cloudProbe();
  let releaseToken;
  context.SupaAuth.token = () => new Promise(resolve => { releaseToken = resolve; });
  const listing = cloud.getNotifications();
  await flush();
  assert.deepEqual(state.net, [], 'no request may be issued before a fresh token');
  fireDeadline();
  assert.equal(await listing, null, 'a stalled token must resolve as a listing failure, not an empty page');
  releaseToken('token-that-arrived-too-late');
  await flush(); await flush();
  assert.deepEqual(state.net, [], 'a token resolved after the deadline must not start a notification request');
});

test('a response body that ignores abort is also bounded, and its late rows are discarded', async () => {
  const { context, cloud, state, fireDeadline } = cloudProbe();
  let releaseBody;
  context.fetch = async (url, init) => {
    state.net.push({ url, init });
    return { ok: true, status: 200, json: () => new Promise(resolve => { releaseBody = resolve; }) };
  };
  const listing = cloud.getNotifications();
  await flush(); await flush();
  assert.equal(state.net.length, 1);
  fireDeadline();
  assert.equal(await listing, null);
  releaseBody([alert('n1_late')]);
  await flush(); await flush();
  assert.equal(state.net.length, 1, 'a late body must not trigger a dependent read');
});

test('an exact read is acknowledged only by a complete, owned, read:true representation', async () => {
  const { context, cloud } = cloudProbe();
  const ids = ['n1_alpha', 'n1_beta'];
  const receipt = ids.map(id => ({ id, uid: OWNER, read: true }));
  const rejected = [
    [],
    receipt.slice(0, 1),
    [...receipt, { id: 'n1_arrival', uid: OWNER, read: true }],
    [receipt[0], receipt[0]],
    receipt.map(row => ({ ...row, uid: PEER })),
    receipt.map(row => ({ ...row, read: false })),
    receipt.map(row => ({ ...row, read: 'true' })),
    receipt.map(({ id, read }) => ({ id, read })),
    [{ ...receipt[0] }, { id: 'n1_gamma', uid: OWNER, read: true }],
    'not-an-array',
    null,
  ];
  for (const rows of rejected) {
    context.fetch = async () => ok(rows);
    assert.equal(await cloud.markNotifsRead(ids), false, 'accepted a bad receipt: ' + JSON.stringify(rows));
  }
  context.fetch = async () => ({ ok: true, status: 204, json: async () => { throw new SyntaxError('no content'); } });
  assert.equal(await cloud.markNotifsRead(ids), false, 'a 204 with no representation is not an acknowledgement');
  context.fetch = async () => ok(receipt, 201);
  assert.equal(await cloud.markNotifsRead(ids), true, 'positive control: the exact owned representation acknowledges');
});

test('the read request is owner-filtered, id-exact, carries a fresh JWT and never filters on read=false', async () => {
  const { context, cloud, state } = cloudProbe();
  context.fetch = async (url, init) => {
    state.net.push({ url, init });
    return ok([{ id: 'n1_alpha', uid: OWNER, read: true }]);
  };
  assert.equal(await cloud.markNotifsRead(['n1_alpha']), true);
  const query = new URL(state.net[0].url).searchParams;
  assert.equal(state.net[0].init.method, 'PATCH');
  assert.equal(query.get('uid'), 'eq.' + OWNER);
  assert.equal(query.get('id'), 'in.(n1_alpha)');
  assert.equal(query.get('select'), 'id,uid,read');
  assert.equal(query.has('read'), false, 'a read=eq.false filter would make a lost-ACK retry unrecoverable');
  assert.equal(state.net[0].init.headers.Prefer, 'return=representation');
  assert.equal(state.net[0].init.headers.Authorization, 'Bearer fresh-jwt');
  assert.notEqual(state.net[0].init.headers.Authorization, 'Bearer stale-anon-bearer');
  assert.deepEqual(JSON.parse(state.net[0].init.body), { read: true });
});

test('hostile or unbounded read sets are rejected before any request reaches the transport', async () => {
  const { cloud, state } = cloudProbe();
  const hostile = [
    undefined, null, 'n1_alpha', [], [''], ['n1_a', 'n1_a'], ['n1_a,n1_b'], ['n1_a"'], ['n1 a'], ['(n1_a)'],
    [{ id: 'n1_a' }], [null], ['x'.repeat(256)], ['.leading'], Array.from({ length: 61 }, (_, i) => 'n1_' + i),
  ];
  for (const ids of hostile) assert.equal(await cloud.markNotifsRead(ids), false, 'accepted hostile ids: ' + JSON.stringify(ids));
  assert.deepEqual(state.net, [], 'no hostile read set may reach the network');
  assert.equal(await cloud.markNotifsRead(['x'.repeat(255)]), false, 'a 255-char id is well-formed but was not acknowledged here');
  assert.equal(state.net.length, 1, 'positive control: a well-formed id is allowed to reach the transport');
});

test('a listing rejects an over-length or malformed page and never carries prose into the app', async () => {
  const { context, cloud } = cloudProbe();
  const row = (id, extra = {}) => ({ id, uid: OWNER, actor: PEER, type: 'comment', post_id: 'post-1', ts: TS, read: false, ...extra });
  context.fetch = async () => ok(Array.from({ length: 61 }, (_, index) => row('n1_' + index)));
  assert.equal(await cloud.getNotifications(), null, '61 rows exceeds the declared page and must fail closed, not truncate');
  for (const bad of [{ ts: -1 }, { ts: 'yesterday' }, { ts: true }, { ts: null }, { type: 'Like' }, { type: '' }, { post_id: 'a b' }, { read: 1 }, { actor: '' }, { uid: PEER }])
    { context.fetch = async () => ok([row('n1_x', bad)]); assert.equal(await cloud.getNotifications(), null, 'accepted a malformed row: ' + JSON.stringify(bad)); }
  context.fetch = async () => ok([row('n1_x'), row('n1_x')]);
  assert.equal(await cloud.getNotifications(), null, 'duplicate ids must fail closed');
  context.fetch = async () => ok([row('n1_x', { body: 'PRIVATE PROSE', message: 'PRIVATE', preview: 'PRIVATE', actor_email: 'PRIVATE' })]);
  const rows = await cloud.getNotifications();
  assert.deepEqual(Object.keys(rows[0]).sort(), ['actor', 'id', 'post_id', 'read', 'ts', 'type', 'uid']);
  assert.equal(JSON.stringify(rows).includes('PRIVATE'), false, 'no notification prose may survive projection');
  context.fetch = async () => ok([row('n1_x', { ts: 1757152800000 })]);
  assert.equal((await cloud.getNotifications())[0].ts, 1757152800000, 'positive control: a numeric epoch is a valid timestamp');
});

test('a like alert is one canonical identity per post and is written only when the stored post and like agree', async () => {
  const { context, cloud } = cloudProbe();
  const postId = 'post-canonical';
  const post = { id: postId, author: PEER, likes: { [OWNER]: true } };
  const writes = [];
  context.fetch = async (url, init) => {
    if (new URL(url).pathname.endsWith('/posts')) return ok([post]);
    writes.push({ url, init, body: JSON.parse(init.body) });
    return ok([]);
  };
  assert.equal(await cloud.notify(PEER, 'like', postId, 'PRIVATE CAPTION TEXT', postId), true);
  delete post.likes[OWNER];
  assert.equal(await cloud.notify(PEER, 'like', postId, undefined, postId), false, 'no alert without the stored actor like');
  post.likes[OWNER] = true;
  post.author = OTHER;
  assert.equal(await cloud.notify(PEER, 'like', postId, undefined, postId), false, 'no alert when the stored author is not the recipient');
  post.author = PEER;
  assert.equal(await cloud.notify(PEER, 'like', postId, undefined, postId), true, 'positive control: a relike is dispatched');
  assert.equal(writes.length, 2, 'only the two verified dispatches may write');
  assert.equal(writes[0].body.id, writes[1].body.id, 'an unlike/relike cycle must reuse one identity');
  assert.equal(writes[0].body.id, 'n1_' + createHash('sha256').update(JSON.stringify([OWNER, PEER, 'like', postId])).digest('hex'));
  assert.deepEqual(Object.keys(writes[0].body).sort(), ['actor', 'id', 'post_id', 'type', 'uid']);
  assert.equal(JSON.stringify(writes.map(write => write.body)).includes('PRIVATE CAPTION'), false);
  assert.equal(new URL(writes[0].url).searchParams.get('on_conflict'), 'id');
  assert.match(writes[0].init.headers.Prefer, /resolution=ignore-duplicates/);
  assert.equal(await cloud.notify(OWNER, 'like', postId, undefined, postId), false, 'an actor cannot alert itself');
});

test('a legacy four-argument dispatch stays compatible, drops prose and takes a fresh opaque id', async () => {
  const { context, cloud } = cloudProbe();
  const writes = [];
  context.fetch = async (url, init) => { writes.push(JSON.parse(init.body)); return ok([]); };
  assert.equal(await cloud.notify(PEER, 'connect', null, 'PRIVATE REQUEST NOTE'), true);
  assert.equal(await cloud.notify(PEER, 'connect', null, 'PRIVATE REQUEST NOTE'), true);
  assert.equal(writes.length, 2);
  assert.notEqual(writes[0].id, writes[1].id, 'legacy dispatch is documented as not server-deduplicated');
  for (const body of writes) {
    assert.deepEqual(Object.keys(body).sort(), ['actor', 'id', 'post_id', 'type', 'uid']);
    assert.equal(JSON.stringify(body).includes('PRIVATE'), false);
  }
});

test('an acknowledged message retry reuses one alert identity and never copies the message body', async () => {
  // Deterministic re-check of the invariant the owner's tests/notification-lifecycle.test.cjs:31
  // case asserts with a single setImmediate; that case is timing-flaky under load (finding F-3),
  // so this probe settles on the actual write instead of on a tick count.
  const { context, cloud } = cloudProbe();
  const messageId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const message = { id: messageId, from_uid: OWNER, to_uid: PEER, body: 'PRIVATE MESSAGE BODY', ts: TS };
  const writes = [], waiters = [];
  const nextWrite = () => new Promise(resolve => { waiters.push(resolve); });
  context.fetch = async (url, init) => {
    if (new URL(url).pathname.endsWith('/messages')) return ok([message]);
    writes.push(JSON.parse(init.body));
    const waiter = waiters.shift();
    if (waiter) waiter();
    if (writes.length === 1) throw new TypeError('alert committed, acknowledgement lost');
    return ok([]);
  };
  let settled = nextWrite();
  assert.equal((await cloud.sendMessage(PEER, message.body, messageId)).id, messageId);
  await settled;
  settled = nextWrite();
  assert.equal((await cloud.sendMessage(PEER, message.body, messageId)).id, messageId, 'an idempotent retry still reconciles the same row');
  await settled;
  await flush();
  assert.equal(writes.length, 2);
  assert.equal(writes[0].id, writes[1].id, 'a retried acknowledged message must reuse one alert identity');
  assert.equal(writes[0].id, 'n1_' + createHash('sha256').update(JSON.stringify([OWNER, PEER, 'message', messageId])).digest('hex'));
  for (const body of writes) {
    assert.deepEqual(Object.keys(body).sort(), ['actor', 'id', 'post_id', 'type', 'uid']);
    assert.equal(JSON.stringify(body).includes('PRIVATE MESSAGE BODY'), false, 'no message prose may reach the alert row');
  }
});

test('an account boundary voids an in-flight read receipt and a pending dispatch, including a same-UID relogin', async () => {
  const readProbe = cloudProbe();
  let releaseReceipt;
  readProbe.context.fetch = async () => new Promise(resolve => { releaseReceipt = resolve; });
  const pendingRead = readProbe.cloud.markNotifsRead(['n1_alpha']);
  await flush();
  readProbe.cloud.resetNotifications();               // logout / login as the same UID
  releaseReceipt(ok([{ id: 'n1_alpha', uid: OWNER, read: true }]));
  assert.equal(await pendingRead, false, 'a receipt that lands after the boundary must not acknowledge');

  const dispatchProbe = cloudProbe();
  const writes = [];
  let releasePost;
  const postAsked = new Promise(resolve => {
    dispatchProbe.context.fetch = async (url, init) => {
      if (new URL(url).pathname.endsWith('/posts')) return new Promise(hold => { releasePost = hold; resolve(); });
      writes.push(JSON.parse(init.body));
      return ok([]);
    };
  });
  const pendingDispatch = dispatchProbe.cloud.notify(PEER, 'like', 'post-9', undefined, 'post-9');
  await postAsked;                                    // the identity digest resolves before the read
  dispatchProbe.cloud.resetNotifications();
  releasePost(ok([{ id: 'post-9', author: PEER, likes: { [OWNER]: true } }]));
  assert.equal(await pendingDispatch, false);
  await flush();
  assert.deepEqual(writes, [], 'a dispatch verified before the boundary must not post after it');
});

// ----------------------------------------------------------------- app surface probes

function node(tag = 'div') {
  return {
    tag, dataset: {}, listeners: {}, disabled: false, tabIndex: 0, textContent: '',
    style: {}, className: '',
    classList: { _set: new Set(), add(name) { this._set.add(name); }, remove(name) { this._set.delete(name); }, contains(name) { return this._set.has(name); } },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    focus() {}, scrollIntoView() {}, remove() {},
    click() { (this.listeners.click || []).forEach(fn => fn()); },
    press(key) { (this.listeners.keydown || []).forEach(fn => fn({ key, currentTarget: this, target: this, preventDefault() {} })); },
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
  };
}

function notifListNode() {
  const element = node();
  element._html = '';
  element._rows = [];
  element._actions = [];
  Object.defineProperty(element, 'innerHTML', {
    configurable: true,
    get() { return element._html; },
    set(value) {
      element._html = value;
      element._rows = Array.from(value.matchAll(/data-notif-id="([^"]*)"/g)).map(match => { const row = node(); row.dataset.notifId = match[1]; return row; });
      element._actions = Array.from(value.matchAll(/data-notif-action="([^"]*)"([^>]*)>/g)).map(match => { const button = node('button'); button.dataset.notifAction = match[1]; button.disabled = /\sdisabled/.test(match[2]); return button; });
    },
  });
  element.querySelectorAll = selector => selector === '[data-notif-id]' ? element._rows : selector === '[data-notif-action]' ? element._actions : [];
  return element;
}

function appProbe() {
  const list = notifListNode(), badge = node(), feed = node(), shell = node();
  const elements = { 'notif-list': list, 'tab-notif-badge': badge, 'view-feed': feed, 'app-shell': shell };
  const net = [], toasts = [], calls = { openDM: [], viewProfile: [], selectTab: [] };
  const routes = { notifications: async () => ok([]), patch: async () => ok([]), messages: async () => ok([]), posts: async () => ok([]) };
  const context = vm.createContext({
    window: { SUPABASE_URL: 'https://probe.invalid', SUPABASE_ANON_KEY: 'anon-probe', USE_SUPABASE_AUTH: true },
    SupaAuth: { active: () => true, uid: () => OWNER, token: async () => 'fresh-jwt', bearer: () => 'stale-anon-bearer' },
    console, crypto: webcrypto, AbortController, URL, TextEncoder,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    document: {
      addEventListener() {}, getElementById: id => elements[id] || null,
      querySelector: () => null, querySelectorAll: () => [], createElement: () => node(),
      activeElement: { dataset: {} }, documentElement: node(),
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async (url, init = {}) => {
      const pathname = new URL(url).pathname, method = init.method || 'GET';
      net.push({ pathname, method, url, init });
      if (pathname.endsWith('/notifications')) return method === 'PATCH' ? routes.patch(url, init) : routes.notifications(url, init);
      if (pathname.endsWith('/messages')) return routes.messages(url, init);
      if (pathname.endsWith('/posts')) return routes.posts(url, init);
      return ok([]);
    },
    Auth: { currentUser: () => ({ id: 'local-account', email: 'probe@example.test' }) },
    Store: { key: 'gymcoach_v1_local', state: { profile: {} }, save() {} },
  });
  vm.runInContext(read('js/cloud.js') + '\n' + read('js/app.js') + '\nglobalThis.__cloud = Cloud; globalThis.__app = App;', context);
  const cloud = context.__cloud, app = context.__app;
  Object.assign(cloud, { me: OWNER, key: 'anon-probe', base: 'https://probe.invalid/rest/v1' });
  context.Social = {
    cloud: { notifs: [], feed: [], connections: [], users: [], comments: [] },
    _pinged: new Set(), sub: null, _dmWith: null, _dmReadError: false, _dmThreadLoading: false,
    isMuted: () => false, msgSoundOff: () => true, playPing() {},
    isBlocked: () => false, _isBanned: () => false,
    cloudUser: uid => ({ uid, name: 'Peer <img src=x onerror="alert(1)">', colors: ['#111111', '#222222'] }),
    avatar: () => '<span class="av"></span>', timeAgo: () => 'now', _canSeePost: () => true,
    openDM: async uid => { calls.openDM.push(uid); }, viewProfile: uid => { calls.viewProfile.push(uid); },
    resetSession() {}, syncAutoFollow() {}, render() {},
  };
  app._entry = 1;
  app.curTab = 'alerts';
  app.selectTab = tab => { calls.selectTab.push(tab); };
  app.toast = message => { toasts.push(message); };
  app.closeModal = () => {};
  app.closeSheet = () => {};
  return { context, cloud, app, list, badge, feed, net, toasts, calls, routes, Social: context.Social };
}

test('a poll never acknowledges a read and never speculatively zeroes the badge', async () => {
  const probe = appProbe();
  probe.routes.notifications = async () => ok([alert('n1_a'), alert('n1_b', { read: true }), alert('n1_c')]);
  assert.equal(await probe.app.pollNotifs(), true);
  assert.equal(probe.badge.textContent, '2');
  assert.equal(probe.Social.cloud.notifs.filter(row => !row.read).length, 2);
  await probe.app.pollNotifs();
  await probe.app.pollNotifs();
  assert.deepEqual(probe.net.filter(entry => entry.method !== 'GET'), [], 'polling must issue no write of any kind');
  assert.equal(probe.badge.textContent, '2', 'repeated polling must not clear unread activity');
});

test('a listing failure retains prior rows, unread state and a Retry control; an acknowledged empty page clears', async () => {
  const probe = appProbe();
  probe.routes.notifications = async () => ok([alert('n1_a'), alert('n1_b')]);
  await probe.app.pollNotifs();
  assert.equal(probe.badge.textContent, '2');

  probe.routes.notifications = async () => { throw new TypeError('offline'); };
  assert.equal(await probe.app.pollNotifs(), false);
  assert.equal(probe.Social.cloud.notifs.length, 2, 'a failed listing must not discard known activity');
  assert.equal(probe.badge.textContent, '2', 'a failed listing must not zero the badge');
  assert.match(probe.list.innerHTML, /Could not refresh activity/);
  assert.ok(probe.list._actions.some(button => button.dataset.notifAction === 'refresh'));

  probe.routes.notifications = async () => ok([]);
  assert.equal(await probe.app.pollNotifs(), true);
  assert.equal(probe.Social.cloud.notifs.length, 0, 'an acknowledged empty page is distinct from a failure');
  assert.equal(probe.badge.textContent, '0');
  assert.equal(probe.badge.style.display, 'none');
});

test('mark-displayed reads exactly the rendered unread set; a later arrival stays unread and retry reuses the original set', async () => {
  const probe = appProbe();
  probe.routes.notifications = async () => ok([alert('n1_a'), alert('n1_b')]);
  await probe.app.pollNotifs();

  let patched = [];
  probe.routes.patch = async (url, init) => { patched.push({ url, init }); return ok([], 500); };
  probe.list._actions.find(button => button.dataset.notifAction === 'mark').click();
  await flush(); await flush();
  assert.equal(patched.length, 1);
  assert.equal(new URL(patched[0].url).searchParams.get('id'), 'in.(n1_a,n1_b)');
  assert.equal(probe.Social.cloud.notifs.every(row => !row.read), true, 'a failed read must leave every row unread');
  assert.equal(probe.badge.textContent, '2');
  assert.match(probe.list.innerHTML, /Read status not confirmed/);
  assert.deepEqual(probe.toasts, [], 'the Alerts tab shows an inline retry instead of a toast');

  probe.routes.notifications = async () => ok([alert('n1_late'), alert('n1_a'), alert('n1_b')]);
  await probe.app.pollNotifs();
  assert.equal(probe.badge.textContent, '3');

  patched = [];
  probe.routes.patch = async (url, init) => { patched.push({ url, init }); return ok([{ id: 'n1_a', uid: OWNER, read: true }, { id: 'n1_b', uid: OWNER, read: true }]); };
  probe.list._actions.find(button => button.dataset.notifAction === 'retry-read').click();
  await flush(); await flush();
  assert.equal(patched.length, 1);
  assert.equal(new URL(patched[0].url).searchParams.get('id'), 'in.(n1_a,n1_b)', 'retry must reuse the original exact set, never the arrival');
  assert.equal(probe.Social.cloud.notifs.find(row => row.id === 'n1_late').read, false, 'a late arrival must remain unread');
  assert.equal(probe.badge.textContent, '1');
  assert.doesNotMatch(probe.list.innerHTML, /Read status not confirmed/);
});

test('an acknowledged read is not undone by a stale replica page', async () => {
  const probe = appProbe();
  probe.routes.notifications = async () => ok([alert('n1_a')]);
  await probe.app.pollNotifs();
  probe.routes.patch = async () => ok([{ id: 'n1_a', uid: OWNER, read: true }]);
  probe.list._actions.find(button => button.dataset.notifAction === 'mark').click();
  await flush(); await flush();
  assert.equal(probe.badge.textContent, '0');
  probe.routes.notifications = async () => ok([alert('n1_a', { read: false })]);
  await probe.app.pollNotifs();
  assert.equal(probe.Social.cloud.notifs[0].read, true, 'a confirmed read must survive an older listing');
  assert.equal(probe.badge.textContent, '0');
});

test('post activity opens only a current, visible feed card and never falls back to an unrelated profile', async () => {
  const probe = appProbe();
  probe.routes.notifications = async () => ok([alert('n1_post', { type: 'like', post_id: 'post-1' })]);
  await probe.app.pollNotifs();

  assert.equal(await probe.app.openNotif('n1_post'), false, 'a post that is not in the current feed is unavailable');
  assert.deepEqual(probe.calls.viewProfile, [], 'an unavailable post must never redirect to a profile');
  assert.deepEqual(probe.net.filter(entry => entry.method === 'PATCH'), [], 'an unavailable target must not be marked read');
  assert.equal(probe.toasts.length, 1);

  probe.Social.cloud.feed = [{ id: 'post-1', author: PEER, text: 'visible' }];
  probe.Social._canSeePost = () => false;
  assert.equal(await probe.app.openNotif('n1_post'), false, 'a post the member cannot see is unavailable');
  probe.Social._canSeePost = () => true;
  probe.Social.cloudUser = () => null;
  assert.equal(await probe.app.openNotif('n1_post'), false, 'an unknown author is unavailable');
  probe.Social.cloudUser = uid => ({ uid, name: 'Peer', colors: ['#111111', '#222222'] });

  assert.equal(await probe.app.openNotif('n1_post'), false, 'a visible post with no rendered card is still unavailable');
  assert.deepEqual(probe.calls.viewProfile, []);
  assert.equal(probe.net.filter(entry => entry.method === 'PATCH').length, 0);
  // REGRESSION for finding F-1 (now fixed): Home is still selected before the card lookup, but
  // the defensive branch now restores the tab the member was actually on before it reports
  // "unavailable", so the toast is no longer delivered on a tab they did not choose.
  assert.deepEqual(probe.calls.selectTab, ['home', 'alerts'],
    'the failed activation returns the member to the tab they started on');
  assert.equal(probe.app.curTab, 'alerts');

  const card = node();
  const control = node('button');
  control.dataset.savedPost = 'post-1';
  control.closest = selector => selector === '.post' ? card : null;
  probe.feed.querySelectorAll = selector => selector === '[data-saved-post]' ? [control] : [];
  probe.routes.patch = async () => ok([{ id: 'n1_post', uid: OWNER, read: true }]);
  assert.equal(await probe.app.openNotif('n1_post'), true, 'positive control: an existing visible card is opened and read');
  assert.deepEqual(probe.calls.selectTab, ['home', 'alerts', 'home'], 'a successful activation stays on the feed');
  assert.equal(probe.net.filter(entry => entry.method === 'PATCH').length, 1);
});

test('message activity requires a proven incoming message and a clean thread open before the read', async () => {
  const probe = appProbe();
  probe.routes.notifications = async () => ok([alert('n1_msg')]);
  await probe.app.pollNotifs();

  probe.routes.messages = async () => ok([]);
  assert.equal(await probe.app.openNotif('n1_msg'), false, 'an unproven message target must not open a thread');
  assert.deepEqual(probe.calls.openDM, []);
  assert.equal(probe.net.filter(entry => entry.method === 'PATCH').length, 0);

  probe.routes.messages = async () => ok([{ id: 'msg-1', from_uid: OWNER, to_uid: PEER }]);
  assert.equal(await probe.app.openNotif('n1_msg'), false, 'a reversed participant pair must not satisfy the check');

  probe.routes.messages = async () => ok([{ id: 'msg-1', from_uid: PEER, to_uid: OWNER }]);
  probe.Social.openDM = async uid => { probe.calls.openDM.push(uid); probe.Social._dmWith = uid; probe.Social._dmReadError = true; };
  assert.equal(await probe.app.openNotif('n1_msg'), false, 'a thread that failed to load must not acknowledge the read');
  assert.deepEqual(probe.calls.openDM, [PEER]);
  assert.equal(probe.net.filter(entry => entry.method === 'PATCH').length, 0);

  probe.Social.openDM = async uid => { probe.calls.openDM.push(uid); probe.Social._dmWith = uid; probe.Social._dmReadError = false; };
  probe.routes.patch = async () => ok([{ id: 'n1_msg', uid: OWNER, read: true }]);
  assert.equal(await probe.app.openNotif('n1_msg'), true, 'positive control: a proven, cleanly opened thread reads exactly its row');
  assert.equal(new URL(probe.net.filter(entry => entry.method === 'PATCH')[0].url).searchParams.get('id'), 'in.(n1_msg)');
});

test('an accept alert is not a relationship receipt and cannot synthesize a connection or follow', async () => {
  const probe = appProbe();
  probe.routes.notifications = async () => ok([alert('n1_accept', { type: 'accept' })]);
  await probe.app.pollNotifs();
  probe.routes.patch = async () => ok([{ id: 'n1_accept', uid: OWNER, read: true }]);
  assert.equal(await probe.app.openNotif('n1_accept'), true);
  assert.equal(probe.Social.cloud.connections.length, 0, 'opening an accept alert must not write relationship state');
  assert.deepEqual(probe.calls.viewProfile, []);
  assert.deepEqual(probe.calls.selectTab, ['search']);
});

test('an ambiguous legacy openNotif(actor, type) call fails closed', async () => {
  const probe = appProbe();
  probe.routes.notifications = async () => ok([alert('n1_one', { type: 'like', post_id: 'post-1' }), alert('n1_two', { type: 'like', post_id: 'post-2' })]);
  await probe.app.pollNotifs();
  assert.equal(await probe.app.openNotif(PEER, 'like'), false, 'two rows share the actor/type pair, so the destination is ambiguous');
  assert.equal(probe.net.filter(entry => entry.method === 'PATCH').length, 0);
  assert.equal(await probe.app.openNotif('n1_missing'), false);
  assert.equal(await probe.app.openNotif(undefined), false);
});

test('rendered rows bind listeners instead of inline handlers, escape actor names and label the bounded page honestly', async () => {
  const probe = appProbe();
  probe.routes.notifications = async () => ok(Array.from({ length: 59 }, (_, index) => alert('n1_' + index)));
  await probe.app.pollNotifs();
  assert.equal(probe.list.innerHTML.includes('onclick='), false, 'no notification row may carry an inline executable handler');
  assert.equal(probe.list.innerHTML.includes('<img src=x onerror="alert(1)">'), false, 'a hostile actor name must never survive as live markup');
  assert.equal(/<[a-z]+[^>]*\son[a-z]+=/i.test(probe.list.innerHTML), false, 'no rendered element may carry an event attribute');
  assert.match(probe.list.innerHTML, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/, 'the hostile name is rendered as inert escaped text');
  assert.equal(probe.list._rows.length, 59);
  assert.ok(probe.list._rows.every(row => row.listeners.click?.length === 1 && row.listeners.keydown?.length === 1));
  assert.doesNotMatch(probe.list.innerHTML, /Latest 60 alerts/, 'a partial page must not claim the bounded label');

  probe.routes.notifications = async () => ok(Array.from({ length: 60 }, (_, index) => alert('n1_' + index)));
  await probe.app.pollNotifs();
  assert.match(probe.list.innerHTML, /Latest 60 alerts/, 'a full page must disclose that it is only the latest 60');
  assert.equal(probe.list.innerHTML.includes('Load older'), false, 'no older-page control is claimed by this bounded surface');
});

test('keyboard activation of an exact row uses the same guarded path as a pointer press', async () => {
  const probe = appProbe();
  probe.routes.notifications = async () => ok([alert('n1_kbd', { type: 'accept' })]);
  await probe.app.pollNotifs();
  probe.routes.patch = async () => ok([{ id: 'n1_kbd', uid: OWNER, read: true }]);
  probe.list._rows[0].press('Enter');
  await flush(); await flush(); await flush();
  assert.deepEqual(probe.calls.selectTab, ['search']);
  assert.equal(probe.net.filter(entry => entry.method === 'PATCH').length, 1);
  assert.match(probe.list.innerHTML, /role="button"/);
  assert.match(probe.list.innerHTML, /tabindex="0"/);
});

test('an account change while a read is pending emits no toast and leaves the next account untouched', async () => {
  const probe = appProbe();
  probe.routes.notifications = async () => ok([alert('n1_a')]);
  await probe.app.pollNotifs();
  let releaseReceipt;
  probe.routes.patch = async () => new Promise(resolve => { releaseReceipt = resolve; });
  probe.list._actions.find(button => button.dataset.notifAction === 'mark').click();
  await flush();

  probe.app._invalidateAccount();
  assert.equal(probe.app._notifReadPending, null);
  assert.equal(probe.app._notifReadRetry, null);
  assert.equal(Array.from(probe.app._notifReadAcks).length, 0);
  assert.equal(probe.badge.textContent, '0');

  releaseReceipt(ok([{ id: 'n1_a', uid: OWNER, read: true }]));
  await flush(); await flush();
  assert.deepEqual(probe.toasts, [], 'a superseded read must not toast on the next signed-in account');
  assert.equal(Array.from(probe.app._notifReadAcks).length, 0, 'an old-account acknowledgement must not seed the new account overlay');
  assert.equal(probe.badge.textContent, '0');
});

// ----------------------------------------------------------------- adjacent checks (reported separately)

function socialProbe() {
  const stored = new Map();
  const context = vm.createContext({
    window: { STORY_INTERACTIONS: true }, console, setTimeout, clearTimeout,
    document: { getElementById: () => null, createElement: () => node() },
    localStorage: {
      getItem: key => (stored.has(key) ? stored.get(key) : null),
      setItem: (key, value) => { stored.set(key, String(value)); },
      removeItem: key => { stored.delete(key); },
    },
  });
  vm.runInContext(read('js/mod/social.js') + '\nglobalThis.__social = Social;', context);
  return { context, social: context.__social, stored };
}

test('DEF-097 probe: a late Story activation failure toasts only on the account that started it', async () => {
  const { context, social } = socialProbe();
  const toasts = [];
  context.App = { toast: message => toasts.push(message), ic: () => '' };
  context.Cloud = { me: OWNER, _actionUid: () => OWNER };
  context.SupaAuth = { active: () => true, uid: () => OWNER };
  context.Stories = { enabled: () => true, owner: () => OWNER, open: async () => { throw new Error('LATE STORY FAILURE'); } };
  social.key = 'social-A';
  social.sub = 'chat';
  social._dmWith = PEER;
  social._session = 1;
  social._storyContextReady = () => true;
  social._checkStoryContext = async () => 'story-1';

  assert.equal(await social.openStoryContext('message-1'), false);
  assert.deepEqual(toasts, ['LATE STORY FAILURE'], 'control: the originating account is told');

  toasts.length = 0;
  context.Stories.open = () => new Promise((resolve, reject) => { context.__rejectOpen = reject; });
  const pending = social.openStoryContext('message-2');
  await flush();
  social._session = 2;                                   // the next account signs in
  context.__rejectOpen(new Error('LATE STORY FAILURE'));
  assert.equal(await pending, false);
  assert.deepEqual(toasts, [], 'a failure resolved after the boundary must not surface on the next account');
});

// Message sound. My round-1 characterisation asserted the raw device key was NEVER read;
// the repaired implementation deliberately DOES read it, read-only, as a conservative
// fallback. That characterisation is obsolete and is replaced by the behaviour I want to
// hold: silence may be inherited, an explicit owner choice always wins, and no account can
// see or change another account's choice. Probes drive the actual js/mod/social.js in a VM.

function soundProbe(owner = OWNER) {
  const probe = socialProbe();
  probe.context.App = { toast: () => {}, ic: () => '' };
  probe.context.Cloud = { me: owner, active: () => true, _actionUid: () => owner };
  probe.context.SupaAuth = { active: () => true, uid: () => owner };
  probe.social.key = 'formora_social_' + owner;
  probe.social.chatDetails = () => {};
  probe.social.playPing = () => {};
  return probe;
}
const scopedKey = uid => 'fm_msgsound_cloud_' + uid;

test('the legacy device sound key is read as silence but is never copied, rewritten or removed', () => {
  const { social, stored } = soundProbe();
  assert.equal(social.msgSoundOff(), false, 'control: with nothing stored the chime is on');

  stored.set('fm_msgsound', 'off');
  assert.equal(social.msgSoundOff(), true, 'an older device silence is honoured instead of silently reverting');
  const before = new Map(stored);
  social.msgSoundOff(); social.msgSoundOff();
  assert.deepEqual([...stored], [...before], 'reading the legacy value writes nothing anywhere');

  assert.equal(social.toggleMsgSound(), true);
  assert.equal(stored.get(scopedKey(OWNER)), 'on', 'the choice is recorded only under this account');
  assert.equal(stored.get('fm_msgsound'), 'off', 'the legacy device value is left exactly as it was');
  assert.equal(social.msgSoundOff(), false, 'an explicit "on" for this account overrides the legacy value');
});

test('an explicit account choice is authoritative in both directions and no legacy value can override it', () => {
  const { social, stored } = soundProbe();
  stored.set('fm_msgsound', 'off');
  stored.set(scopedKey(OWNER), 'on');
  assert.equal(social.msgSoundOff(), false);
  stored.set(scopedKey(OWNER), 'off');
  assert.equal(social.msgSoundOff(), true);
  stored.delete('fm_msgsound');
  assert.equal(social.msgSoundOff(), true, 'removing the legacy value does not resurrect the chime');
  assert.equal(social.toggleMsgSound(), true);
  assert.equal(stored.get(scopedKey(OWNER)), 'on');
  assert.equal(stored.has('fm_msgsound'), false, 'toggling never recreates the unattributed device key');
});

test('no account inherits, reads or mutates another account\u2019s message-sound choice', () => {
  const first = soundProbe(OWNER);
  first.social.toggleMsgSound();                                   // OWNER explicitly chooses off->on
  first.stored.set(scopedKey(OWNER), 'off');                       // then explicitly silences
  assert.equal(first.social.msgSoundOff(), true);

  const second = soundProbe(PEER);
  for (const [key, value] of first.stored) second.stored.set(key, value);   // same device, next member
  assert.equal(second.social.msgSoundOff(), false, 'the other account\u2019s silence is not inherited');
  assert.equal(second.social.toggleMsgSound(), true);
  assert.equal(second.stored.get(scopedKey(PEER)), 'off');
  assert.equal(second.stored.get(scopedKey(OWNER)), 'off', 'the first account\u2019s key is untouched');

  first.stored.set(scopedKey(PEER), 'off');
  assert.equal(first.social.msgSoundOff(), true, 'and the first account still reads only its own key');
});

test('the sound preference fails closed to silence when no account owns the device state', () => {
  const { social, context, stored } = soundProbe();
  stored.set(scopedKey(OWNER), 'on');
  context.Cloud._actionUid = () => null;
  assert.equal(social.msgSoundOff(), true, 'a signed-out or unresolved account is silent, not noisy');
  assert.equal(social.toggleMsgSound(), false, 'and cannot record a choice');
  context.Cloud._actionUid = () => OWNER;
  social.key = '';
  assert.equal(social.msgSoundOff(), true);
  social.key = 'formora_social_' + OWNER;
  const original = context.localStorage.getItem;
  context.localStorage.getItem = () => { throw new Error('storage unavailable'); };
  try { assert.equal(social.msgSoundOff(), true, 'unreadable storage is silent, not noisy'); }
  finally { context.localStorage.getItem = original; }
});

