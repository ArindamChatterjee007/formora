'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const Module = require('node:module');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const ownerSuite = path.join(root, 'tests/comment-publishing.test.cjs');
const browserSuite = path.join(root, 'tests/social-publishing.e2e.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const turn = () => new Promise(resolve => setImmediate(resolve));
const output = fs.mkdtempSync(path.join(process.env.COMMENT_QA_OUTPUT || os.tmpdir(),
  process.env.COMMENT_PUBLISHING_BROWSER === '1' ? 'comment-browser-' : 'comment-probes-'));
const publicInputs = ['index.html', 'legal.html', 'manifest.webmanifest', 'version.txt',
  'icons/apple-touch-icon.png', 'icons/favicon-32.png', 'icons/icon.svg'];
for (const icon of JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'))).icons) publicInputs.push(icon.src);
for (const directory of ['js', 'css']) {
  for (const relative of fs.readdirSync(path.join(root, directory), { recursive: true })) {
    const filename = path.join(root, directory, relative);
    if (fs.statSync(filename).isFile()) {
      assert.equal(fs.lstatSync(filename).isSymbolicLink(), false);
      publicInputs.push(directory + '/' + relative);
    }
  }
}
const inputs = [...new Set([...publicInputs, 'tests/comment-independent-qa.test.cjs',
  'tests/comment-publishing.test.cjs', 'tests/social-publishing.e2e.cjs'])].sort();
const snapshot = () => Object.fromEntries(inputs.map(relative => [relative, hash(fs.readFileSync(path.join(root, relative)))]));
const before = { capturedAt: new Date().toISOString(), sourceHashes: snapshot() };
const observations = [], servedFiles = new Map(), browserClients = [];
fs.writeFileSync(path.join(output, 'before.json'), JSON.stringify(before, null, 2) + '\n', { flag: 'wx' });
console.log('Independent comment evidence: ' + output);

test.after(() => {
  for (const client of browserClients) {
    const { state, commentDiagnostics } = client;
    const consoleErrors = state.consoleErrors.map(text => ({ text, classification:
      /status of 503/.test(text) && commentDiagnostics.responses.some(response => response.status === 503 && response.path === '/rest/v1/comments')
        ? 'injected_http_503' : /net::ERR_FAILED/.test(text) && commentDiagnostics.failures.some(request => request.path === '/rest/v1/comments')
          ? 'injected_lost_ack' : 'unclassified' }));
    observations.push({ control: 'browser_transport_and_console', consoleErrors, ...commentDiagnostics,
      pageErrors: state.pageErrors, unexpectedRequests: state.unexpected, externalAttempts: state.external,
      ownedPageClosed: client.page.isClosed(), ownedBrowserConnected: client.context.browser().isConnected() });
  }
  const after = { capturedAt: new Date().toISOString(), sourceHashes: snapshot() };
  const sourceUnchanged = JSON.stringify(before.sourceHashes) === JSON.stringify(after.sourceHashes);
  fs.writeFileSync(path.join(output, 'after.json'), JSON.stringify({ ...after, sourceUnchanged,
    servedFiles: Object.fromEntries(servedFiles), observations }, null, 2) + '\n', { flag: 'wx' });
  assert.equal(sourceUnchanged, true, 'Independent probe inputs changed after the durable before snapshot');
  for (const observation of observations.filter(item => item.control === 'browser_transport_and_console')) {
    assert.ok(observation.consoleErrors.every(error => error.classification !== 'unclassified'), 'Unclassified browser console error');
    assert.equal(observation.ownedPageClosed, true);
    assert.equal(observation.ownedBrowserConnected, false);
  }
});

function fixtures(extendBrowser) {
  const registered = [];
  const trackedFs = Object.create(fs);
  trackedFs.readFileSync = (filename, options) => {
    const bytes = fs.readFileSync(filename, options);
    const relative = path.relative(root, filename);
    if (publicInputs.includes(relative)) {
      assert.equal(hash(bytes), before.sourceHashes[relative], 'Served source changed: ' + relative);
      servedFiles.set(relative, hash(bytes));
    }
    return bytes;
  };
  class BrowserModule extends Module {
    _compile(content, filename) {
      if (filename === browserSuite && extendBrowser) {
        this.extendComments = extendBrowser;
        content += '\nconst originalOpenApp = module.exports.openApp; module.exports.openApp = async (...args) => { const client = await originalOpenApp(...args); await module.extendComments(client); return client; };';
      }
      return super._compile(content, filename);
    }
  }
  const suite = new Module(ownerSuite, module), localRequire = Module.createRequire(ownerSuite);
  suite.filename = ownerSuite;
  suite.paths = Module._nodeModulePaths(path.dirname(ownerSuite));
  suite.require = name => name === 'node:test'
    ? (name, options, callback) => registered.push({ name, options: typeof options === 'function' ? {} : options,
      callback: typeof options === 'function' ? options : callback })
    : name === 'node:module' ? BrowserModule : name === 'node:fs' ? trackedFs : localRequire(name);
  suite._compile(fs.readFileSync(ownerSuite, 'utf8')
    + '\nmodule.exports = { harness, feedHarness, flexHarness, createComment, deferred, writes, owner, peer, postId };', ownerSuite);
  return { ...suite.exports, registered };
}

function clock(context) {
  const timers = [];
  context.setTimeout = (callback, milliseconds) => {
    const timer = { callback, milliseconds, cleared: false, fired: false };
    timers.push(timer); return timer;
  };
  context.clearTimeout = timer => { if (timer) timer.cleared = true; };
  return {
    fire() {
      const active = timers.filter(timer => !timer.cleared && !timer.fired && timer.milliseconds === 6000);
      assert.equal(active.length, 1, 'Exactly one publishing deadline must exist');
      active[0].fired = true; active[0].callback();
    },
    created: () => timers.filter(timer => timer.milliseconds === 6000).length,
    pending: () => timers.filter(timer => timer.milliseconds === 6000 && !timer.cleared).length,
    clear() { timers.forEach(timer => { timer.cleared = true; }); },
  };
}

function lockedAuth(fixture, api) {
  const lock = api.deferred(), entered = api.deferred();
  const auth = vm.runInContext(fs.readFileSync(path.join(root, 'js/supaauth.js'), 'utf8') + '\n;SupaAuth;', fixture.context);
  const session = { uid: api.owner, email: 'owner@example.test', access_token: 'current-owner-token',
    refresh_token: 'synthetic-refresh', expires_at: Math.floor(Date.now() / 1000) + 30 };
  auth.session = session;
  fixture.context.localStorage.setItem(auth.KEY, JSON.stringify(session));
  fixture.context.navigator = { locks: { request(name, perform) {
    assert.equal(name, 'formora-session-refresh'); entered.resolve(); return lock.promise.then(perform);
  } } };
  const originalFetch = fixture.context.fetch;
  let refreshRequests = 0;
  fixture.context.fetch = (address, options) => {
    const url = new URL(address);
    if (url.pathname === '/auth/v1/token') {
      assert.equal(url.origin, 'https://comment-publishing.invalid');
      assert.equal(url.searchParams.get('grant_type'), 'refresh_token');
      refreshRequests++;
      return Promise.resolve(Response.json({ access_token: 'refreshed-owner-token', refresh_token: session.refresh_token,
        expires_in: 3600, user: { id: api.owner, email: session.email } }));
    }
    return originalFetch(address, options);
  };
  return { auth, lock, entered: entered.promise, refreshRequests: () => refreshRequests };
}

test('Comment independent: the old premature caller cannot admit alerts without a persisted source', { timeout: 2000 }, async context => {
  const api = fixtures(), fixture = api.harness(), pending = [], handle = fixture.state.handle;
  fixture.state.handle = request => request.url.pathname.endsWith('/comments')
    ? new Response(null, { status: 503 }) : handle(request);
  fixture.cloud.addComment = function (postId, body, parentId, mentions, postAuthor) {
    const id = this._newActionId();
    pending.push(this._write('/comments', { id, post_id: postId, author: this.me, body, parent_id: parentId, mentions }));
    pending.push(this.notify(postAuthor, 'comment', postId, body));
    return id;
  };
  fixture.cloud.addComment(api.postId, 'Synthetic private draft', null, [], api.peer);
  fixture.cloud.addComment(api.postId, 'Synthetic private draft', null, [], api.peer);
  await Promise.all(pending);
  const notifications = api.writes(fixture.state, 'notifications');
  assert.equal(api.writes(fixture.state, 'comments').length, 2);
  assert.equal(fixture.state.comments.size, 0);
  assert.equal(notifications.length, 2);
  assert.ok(notifications.every(request => request.body.p_event_id === null));
  assert.ok(notifications.every(request => Object.keys(request.body).sort().join(',') === 'p_event_id,p_post_id,p_recipient,p_type'));
  assert.equal(fixture.state.alerts.size, 0);
  const observation = { control: 'in_memory_old_caller_omission', commentResponses: [503, 503],
    persistedComments: 0, admissionAttempts: 2, persistedNotifications: 0, runtimeFilesModified: false };
  observations.push(observation); context.diagnostic(JSON.stringify(observation));
});

test('Comment independent: abort-aware comment fetch releases the draft at the virtual deadline', { timeout: 2000 }, async context => {
  const api = fixtures(), fixture = api.feedHarness(), started = api.deferred(), timers = clock(fixture.context);
  const original = fixture.input.value;
  fixture.state.handle = request => {
    assert.equal(request.url.pathname, '/rest/v1/comments');
    started.resolve();
    return new Promise((resolve, reject) => request.options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  };
  const work = fixture.social.submitComment(api.postId);
  await started.promise;
  timers.fire();
  assert.equal(await work, false);
  assert.equal(fixture.input.value, original);
  assert.equal(fixture.button.disabled, false);
  assert.equal(fixture.input.getAttribute('aria-busy'), null);
  assert.equal(fixture.social._pendingActions.size, 0);
  assert.equal(fixture.state.alerts.size, 0);
  const observation = { control: 'abort_aware_fetch', deadlineMs: 6000, settled: true, sendDisabled: false, draftRetained: true, notificationWrites: 0 };
  observations.push(observation); context.diagnostic(JSON.stringify(observation));
});

test('Comment independent: real auth refresh-lock wait must release Feed and Flex at the publishing deadline', { timeout: 2000 }, async context => {
  const api = fixtures(), results = [];
  for (const surface of ['feed', 'flex']) {
    const fixture = surface === 'feed' ? api.feedHarness() : api.flexHarness();
    const { social, state, cloud } = fixture, timers = clock(fixture.context), held = lockedAuth(fixture, api);
    const submit = () => surface === 'feed' ? social.submitComment(api.postId) : fixture.app.submitReelComment(api.postId);
    const input = surface === 'feed' ? fixture.input : fixture.elements.get('rc-input');
    const button = surface === 'feed' ? fixture.button : fixture.elements.get('rc-send');
    input.value = 'Unchanged ' + surface + ' draft after held refresh';
    const original = input.value;
    let settled = false, retry, reopened, observation;
    const work = submit().then(result => { settled = true; return result; });
    const intent = social._commentRequests.get(surface + ':' + api.postId);
    try {
      await held.entered;
      timers.fire(); await turn();
      observation = { surface, deadlineMs: 6000, settledAfterDeadline: settled, sendDisabled: button.disabled,
        ariaBusy: input.getAttribute('aria-busy'), draftRetained: input.value === original,
        pendingActions: social._pendingActions.size, commentWrites: api.writes(state, 'comments').length, refreshRequests: held.refreshRequests() };
      if (surface === 'feed') { social.toggleComments(api.postId); social.toggleComments(api.postId); }
      else { fixture.app.closeReelComments(); fixture.app.openReelComments(api.postId); }
      reopened = surface === 'feed' ? fixture.input : fixture.elements.get('rc-input');
      reopened.value = original;
      retry = submit();
      await turn();
      if (settled) timers.fire();
      observation.reopenedSubmit = await retry;
      observation.reopenedDraftRetained = reopened.value === original;
      observation.pendingAfterReopen = social._pendingActions.size;
      assert.equal(social._commentRequests.get(surface + ':' + api.postId), intent, 'Re-entering the unchanged draft must retain the original RAM intent');
      results.push(observation);
    } finally {
      held.lock.resolve();
      await held.auth._refreshing?.promise;
      assert.equal(await work, false);
      if (retry) assert.equal(await retry, false);
      await turn();
      assert.equal(api.writes(state, 'comments').length, 0);
      assert.equal(state.alerts.size, 0);
      assert.equal(social._pendingActions.size, 0);
      assert.equal(cloud._commentWrites.size, 0);
      assert.equal(cloud._publishingControllers.size, 0);
      assert.equal(timers.pending(), 0);
      timers.clear();
    }
    try {
      assert.equal(held.refreshRequests(), 1);
      assert.equal(reopened.value, original);
      assert.equal(await submit(), true, 'The same draft must actually succeed after the shared refresh lock is released');
      await turn();
      const posted = api.writes(state, 'comments'), notified = api.writes(state, 'notifications');
      assert.equal(posted.length, 1);
      assert.equal(new Set(posted.map(request => request.body.id)).size, 1);
      assert.equal(posted[0].body.id, intent.id);
      assert.equal(posted[0].options.headers.Authorization, 'Bearer refreshed-owner-token');
      assert.equal(state.comments.size, 1);
      assert.equal(state.comments.get(intent.id).body, original);
      assert.equal(notified.length, 1);
      assert.deepEqual(notified[0].body, { p_type:'comment',p_recipient:api.peer,p_post_id:api.postId,p_event_id:intent.id });
      assert.equal(state.alerts.size, 1);
      assert.equal(social.cloud.comments.length, 1);
      assert.equal(reopened.value, '');
      assert.equal(reopened.getAttribute('aria-busy'), null);
      assert.equal(reopened.parentElement.querySelector('.send-ico').disabled, false);
      assert.equal(social._pendingActions.size, 0);
      assert.equal(social._commentRequests.size, 0);
      assert.equal(cloud._commentWrites.size, 0);
      assert.equal(cloud._publishingControllers.size, 0);
      assert.equal(cloud._notificationControllers.size, 0);
      assert.equal(timers.created(), 4);
      assert.equal(timers.pending(), 0);
      Object.assign(observation, { successAfterRelease: true, sameIntentId: intent.id, durableComments: state.comments.size,
        finalCommentWrites: posted.length, finalNotificationWrites: notified.length, distinctNotificationIds: state.alerts.size,
        latePreviousWrites: 0, latePreviousNotifications: 0, deadlineTimersCreated: timers.created(), deadlineTimersPending: timers.pending() });
    } finally { timers.clear(); }
  }
  observations.push({ control: 'real_SupaAuth_token_refresh_lock', results });
  context.diagnostic(JSON.stringify({ control: 'real_SupaAuth_token_refresh_lock', results }));
  assert.ok(results.every(result => result.settledAfterDeadline && !result.sendDisabled && result.pendingActions === 0),
    'The 6000ms publishing deadline must settle the actual token wait and release both comment composers');
  assert.ok(results.every(result => result.ariaBusy === null && result.draftRetained && result.reopenedSubmit === false
    && result.reopenedDraftRetained && result.pendingAfterReopen === 0 && result.successAfterRelease));
});

test('Comment independent: omitting only the shared cancellation race restores locked Feed and Flex pending state', { timeout: 2000 }, async context => {
  const api = fixtures(), results = [];
  for (const surface of ['feed', 'flex']) {
    const fixture = surface === 'feed' ? api.feedHarness() : api.flexHarness();
    const { cloud, social, state } = fixture, timers = clock(fixture.context), held = lockedAuth(fixture, api);
    const helper = cloud._withDeadline.toString(), race = 'Promise.race([work(), cancelled])';
    assert.equal(helper.split(race).length, 2, 'Omit exactly the actual shared race and preserve all other guards');
    cloud._withDeadline = vm.runInContext('({' + helper.replace(race, 'work()') + '})._withDeadline', fixture.context);
    const submit = () => surface === 'feed' ? social.submitComment(api.postId) : fixture.app.submitReelComment(api.postId);
    const input = surface === 'feed' ? fixture.input : fixture.elements.get('rc-input');
    const button = input.parentElement.querySelector('.send-ico'), original = input.value;
    let settled = false;
    const work = submit().then(result => { settled = true; return result; });
    try {
      await held.entered;
      timers.fire(); await turn();
      assert.equal(settled, false);
      assert.equal(button.disabled, true);
      assert.equal(input.getAttribute('aria-busy'), 'true');
      assert.equal(input.value, original);
      assert.equal(social._pendingActions.size, 1);
      if (surface === 'feed') { social.toggleComments(api.postId); social.toggleComments(api.postId); }
      else { fixture.app.closeReelComments(); fixture.app.openReelComments(api.postId); }
      const reopened = surface === 'feed' ? fixture.input : fixture.elements.get('rc-input');
      reopened.value = original;
      assert.equal(await submit(), false);
      assert.equal(social._pendingActions.size, 1);
      assert.equal(held.refreshRequests(), 0);
      assert.equal(api.writes(state, 'comments').length, 0);
      assert.equal(state.alerts.size, 0);
      results.push({ surface, settledAfterDeadline: settled, sendDisabled: true, pendingAfterReopen: 1,
        commentWrites: 0, notificationWrites: 0, deadlineMs: 6000, deadlineTimersCreated: timers.created() });
    } finally {
      held.lock.resolve();
      await held.auth._refreshing?.promise;
      assert.equal(await work, false);
      await turn();
      assert.equal(api.writes(state, 'comments').length, 0);
      assert.equal(state.alerts.size, 0);
      assert.equal(social._pendingActions.size, 0);
      assert.equal(cloud._publishingControllers.size, 0);
      assert.equal(timers.pending(), 0);
      timers.clear();
    }
  }
  observations.push({ control: 'in_memory_shared_race_omission', runtimeFilesModified: false, results });
  context.diagnostic(JSON.stringify(observations.at(-1)));
});

for (const phase of ['response.json', 'reconcile.json']) {
  for (const boundary of ['deadline', 'owner-aba']) {
    test(`Comment independent: abort-ignoring ${phase} is fenced by ${boundary} on Feed and Flex`, { timeout: 2000 }, async context => {
      const api = fixtures(), results = [];
      for (const surface of ['feed', 'flex']) {
        const fixture = surface === 'feed' ? api.feedHarness() : api.flexHarness();
        const { social, cloud, state } = fixture, timers = clock(fixture.context), body = api.deferred(), entered = api.deferred();
        const handle = state.handle;
        let intercepted = false, lateRows, signal;
        state.handle = async request => {
          const response = await handle(request);
          if (!intercepted && phase === 'reconcile.json' && request.method === 'POST') return Response.json([], { status: 201 });
          if (!intercepted && request.url.pathname === '/rest/v1/comments'
            && request.method === (phase === 'response.json' ? 'POST' : 'GET')) {
            intercepted = true; lateRows = await response.json(); signal = request.options.signal;
            response.json = () => { entered.resolve(); return body.promise; };
          }
          return response;
        };
        const submit = () => surface === 'feed' ? social.submitComment(api.postId) : fixture.app.submitReelComment(api.postId);
        const input = surface === 'feed' ? fixture.input : fixture.elements.get('rc-input');
        input.value = 'Deferred body comment';
        const original = input.value;
        let currentInput = input, settled = false;
        const work = submit().then(result => { settled = true; return result; });
        const intent = social._commentRequests.get(surface + ':' + api.postId);
        try {
          await entered.promise;
          assert.equal(state.comments.size, 1);
          assert.equal(state.alerts.size, 0);
          assert.equal(timers.created(), 1);
          if (boundary === 'deadline') timers.fire();
          else {
            social.resetSession();
            state.uid = api.peer; cloud.me = api.peer; state.uid = api.owner; cloud.me = api.owner;
            if (surface === 'flex') { fixture.app.openReelComments(api.postId); currentInput = fixture.elements.get('rc-input'); }
            currentInput.value = 'Replacement owner draft';
          }
          await turn();
          assert.equal(settled, true, 'Cancellation must settle before the body is released');
          assert.equal(await work, false);
          assert.equal(signal.aborted, true);
          assert.equal(social._pendingActions.size, 0);
          assert.equal(cloud._commentWrites.size, 0);
          assert.equal(cloud._publishingControllers.size, 0);
          assert.equal(timers.pending(), 0);
          if (boundary === 'deadline') {
            assert.equal(currentInput.value, original);
            assert.equal(currentInput.getAttribute('aria-busy'), null);
            assert.equal(currentInput.parentElement.querySelector('.send-ico').disabled, false);
            assert.equal(social._commentRequests.get(surface + ':' + api.postId), intent);
          } else assert.equal(social._commentRequests.size, 0);
          const requestsAtCancellation = state.requests.length, toastsAtCancellation = state.toasts.length;
          body.resolve(lateRows); await turn();
          assert.equal(state.requests.length, requestsAtCancellation, 'Late receipt must not start reconciliation or notification requests');
          assert.equal(state.toasts.length, toastsAtCancellation);
          assert.equal(state.alerts.size, 0);
          assert.equal(social.cloud.comments.length, 0);
          assert.equal(currentInput.value, boundary === 'deadline' ? original : 'Replacement owner draft');
          if (boundary === 'deadline') {
            assert.equal(await submit(), true);
            assert.equal(state.comments.size, 1);
            const posted = api.writes(state, 'comments');
            assert.equal(posted.length, 2);
            assert.ok(posted.every(request => request.body.id === intent.id));
            assert.equal(api.writes(state, 'notifications').length, 1);
            assert.equal(state.alerts.size, 1);
            assert.equal(social.cloud.comments.length, 1);
            assert.equal(currentInput.value, '');
            assert.equal(timers.created(), 3);
          }
          assert.equal(timers.pending(), 0);
          assert.equal(cloud._publishingControllers.size, 0);
          assert.equal(cloud._notificationControllers?.size || 0, 0);
          results.push({ surface, phase, boundary, settledBeforeBodyRelease: settled, aborted: signal.aborted,
            originalIntentId: intent.id, durableComments: state.comments.size, lateDependentRequests: 0,
            successfulSameIdRetry: boundary === 'deadline', notificationWrites: api.writes(state, 'notifications').length,
            deadlineTimersCreated: timers.created(), deadlineTimersPending: timers.pending() });
        } finally { body.resolve(lateRows || []); await work; timers.clear(); }
      }
      observations.push({ control: 'abort_ignoring_comment_json', phase, boundary, results });
      context.diagnostic(JSON.stringify(observations.at(-1)));
    });
  }
}

test('Comment independent: shared notification deadline and reset retain null, current guards and timer cleanup', { timeout: 2000 }, async context => {
  const api = fixtures(), results = [];
  for (const phase of ['token', 'json', 'rejected-json']) {
    for (const boundary of ['deadline', 'reset-owner-aba']) {
      const fixture = api.harness(), { cloud, state } = fixture, timers = clock(fixture.context);
      const entered = api.deferred(), delayed = api.deferred(), originalToken = fixture.context.SupaAuth.token;
      let rejectLate, held = true, settled = false;
      const waiting = phase === 'rejected-json' ? new Promise((resolve, reject) => { rejectLate = reject; }) : delayed.promise;
      if (phase === 'token') fixture.context.SupaAuth.token = () => { entered.resolve(); return waiting; };
      state.handle = request => {
        assert.equal(request.url.pathname, '/rest/v1/notifications');
        assert.equal(request.method, 'GET');
        const response = Response.json([]);
        if (held && phase !== 'token') response.json = () => { entered.resolve(); return waiting; };
        return response;
      };
      const work = cloud.getNotifications().then(result => { settled = true; return result; });
      try {
        await entered.promise;
        assert.equal(cloud._notificationControllers.size, 1);
        assert.equal(timers.created(), 1);
        if (boundary === 'deadline') timers.fire();
        else {
          state.uid = api.peer; cloud.me = api.peer;
          cloud.resetPublishing(); cloud.resetNotifications();
          state.uid = api.owner; cloud.me = api.owner;
        }
        await turn();
        assert.equal(settled, true);
        assert.equal(await work, null, 'A cancelled listing is failure, never an empty successful page');
        assert.equal(cloud._notificationControllers.size, 0);
        assert.equal(timers.pending(), 0);
        const requestsAtCancellation = state.requests.length;
        if (rejectLate) rejectLate(new TypeError('Synthetic late body rejection'));
        else delayed.resolve(phase === 'token' ? 'late-token' : []);
        await turn(); await turn();
        assert.equal(state.requests.length, requestsAtCancellation);
        assert.equal(state.requests.length, phase === 'token' ? 0 : 1);
        held = false; fixture.context.SupaAuth.token = originalToken;
        assert.equal((await cloud.getNotifications()).length, 0);
        assert.equal(cloud._notificationControllers.size, 0);
        assert.equal(timers.created(), 2);
        assert.equal(timers.pending(), 0);
        results.push({ phase, boundary, cancelledResult: null, settledBeforeRelease: settled, lateDependentRequests: 0,
          emptySuccessAfterReset: true, deadlineTimersCreated: timers.created(), deadlineTimersPending: timers.pending() });
      } finally {
        if (rejectLate) rejectLate(new TypeError('Synthetic late body rejection')); else delayed.resolve([]);
        await work; timers.clear();
      }
    }
  }
  observations.push({ control: 'shared_notification_deadline', results });
  context.diagnostic(JSON.stringify(observations.at(-1)));
});

async function checkSharedRenderer(client) {
  const { page } = client;
  client.commentDiagnostics = { responses: [], failures: [] };
  browserClients.push(client);
  page.on('response', response => { if (response.status() >= 400) client.commentDiagnostics.responses.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  page.on('requestfailed', request => client.commentDiagnostics.failures.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }));
  const hostileName = 'QA <img src=x onerror="globalThis.__commentInjected=1"> & "header"';
  const hostileBody = '<script>globalThis.__commentInjected=1</script> @fixture_peer & "quoted"';
  await page.evaluate(({ hostileName, hostileBody }) => {
    Cloud.setPaused(true);
    window.__commentQaSaved = { comments: Social.cloud.comments, users: Social.cloud.users.map(user => ({ ...user })), viewProfile: Social.viewProfile };
    window.__commentQaClicks = [];
    Social.viewProfile = function (uid) {
      window.__commentQaClicks.push({ uid, sheetOpen: document.getElementById('reel-comments')?.classList.contains('open') || false });
      return window.__commentQaSaved.viewProfile.call(this, uid);
    };
    Social.cloud.users.find(user => user.uid === '22222222-2222-4222-8222-222222222222').name = hostileName;
    Social.cloud.comments = [
      { id: 'qa-root', post_id: 'post-peer', author: '22222222-2222-4222-8222-222222222222', body: hostileBody, parent_id: null, ts: 1 },
      { id: 'qa-child', post_id: 'post-peer', author: Cloud.me, body: 'Threaded child', parent_id: 'qa-root', ts: 2 },
      { id: 'qa-orphan', post_id: 'post-peer', author: '22222222-2222-4222-8222-222222222222', body: 'Visible orphan', parent_id: 'missing-parent', ts: 3 },
    ];
    Social._openCmt = 'post-peer'; Social.render('feed');
  }, { hostileName, hostileBody });
  const feed = page.locator('#cmts-post-peer');
  assert.equal(await feed.locator('.cmt2').count(), 3);
  assert.equal(await feed.locator('.cmt2.reply').count(), 1);
  assert.equal(await feed.locator('.cmt2-reply').count(), 3);
  assert.equal(await feed.locator('.cmt2-more').count(), 3);
  assert.equal(await feed.locator('.cmt2-body > b').first().innerText(), hostileName);
  assert.ok((await feed.locator('.cmt2-body').first().innerText()).includes(hostileBody));
  assert.equal(await feed.locator('script, img[onerror]').count(), 0);
  await feed.locator('.cmt2-body > b').first().click();
  await page.locator('#modal:not(.hidden) .view-profile').waitFor();
  await page.evaluate(() => App.closeModal());
  await page.evaluate(() => { App.selectTab('flex'); App.openReelComments('post-peer'); });
  assert.equal(await page.locator('#reel-comments .rc-title').innerText(), '3 comments');
  assert.equal(await page.locator('#rc-list .cmt2').count(), 3);
  assert.equal(await page.locator('#rc-list .cmt2.reply').count(), 1);
  assert.equal(await page.locator('#rc-list .cmt2-reply').count(), 2);
  assert.equal(await page.locator('#rc-list .cmt2-more').count(), 0);
  assert.equal(await page.locator('#rc-list .cmt2-body > b').first().innerText(), hostileName);
  assert.equal(await page.locator('#rc-list script, #rc-list img[onerror]').count(), 0);
  await page.locator('#rc-list .cmt2-av').first().click();
  await page.locator('#modal:not(.hidden) .view-profile').waitFor();
  assert.equal(await page.locator('#rc-input').count(), 0);
  assert.deepEqual(await page.evaluate(() => window.__commentQaClicks), [
    { uid: '22222222-2222-4222-8222-222222222222', sheetOpen: false },
    { uid: '22222222-2222-4222-8222-222222222222', sheetOpen: false },
  ]);
  await page.evaluate(() => { App.closeModal(); App.openReelComments('post-peer'); });
  await page.locator('#rc-list .cmt2-reply').first().click();
  assert.equal(await page.locator('#rc-input').inputValue(), '@fixture_peer ');
  assert.equal(await page.evaluate(() => Social._replyTo || null), null);
  await page.evaluate(() => { Social.cloud.comments = Social.cloud.comments.slice(0, 1); App.openReelComments('post-peer'); });
  assert.equal(await page.locator('#reel-comments .rc-title').innerText(), '1 comment');
  await page.evaluate(() => { Social.cloud.comments = []; App.openReelComments('post-peer'); });
  assert.equal(await page.locator('#reel-comments .rc-title').innerText(), '0 comments');
  assert.match(await page.locator('#rc-list').innerText(), /No comments/);
  assert.equal(await page.evaluate(() => window.__commentInjected || null), null);
  await page.evaluate(() => {
    App.closeReelComments(false);
    Social.cloud.comments = window.__commentQaSaved.comments; Social.cloud.users = window.__commentQaSaved.users;
    Social.viewProfile = window.__commentQaSaved.viewProfile;
    Social._openCmt = null; Social._replyTo = null;
    delete window.__commentQaSaved;
    App.selectTab('profile');
  });
  await page.locator('#view-profile #p-name').waitFor();
  assert.equal(await page.evaluate(() => !!window.AppProfile), true);
  assert.ok(servedFiles.has('js/mod/profile.js'), 'Actual lazy Profile source must be served and baseline-bound');
  assert.equal(await page.evaluate(() => innerWidth), 390);
  await page.evaluate(() => { document.getElementById('modal-card').replaceChildren(); App.selectTab('home'); Social._openCmt = null; Social.render('feed'); });
  observations.push({ control: 'actual_shared_renderer', feedRows: 3, flexRows: 3, threadedReplies: 1,
    feedReplyButtons: 3, flexReplyButtons: 2, feedMoreButtons: 3, flexMoreButtons: 0,
    escapedNameAndBody: true, executedInjectedMarkup: false, actualProfileCallbacks: 2,
    flexClosedBeforeProfile: true, initialHeaders: ['3 comments', '1 comment', '0 comments'],
    flatFlexReply: true, actualLazyProfileLoaded: true, viewportWidth: 390 });
}

if (process.env.COMMENT_PUBLISHING_BROWSER === '1') {
  const selected = fixtures(checkSharedRenderer).registered.filter(entry => entry.name.startsWith('Comment browser:'));
  assert.equal(selected.length, 1);
  for (const entry of selected) test(entry.name, entry.options, async context => {
    await entry.callback(context);
    context.diagnostic(JSON.stringify({ independentRenderer: observations, servedFiles: [...servedFiles.keys()],
      beforeArtifact: path.join(output, 'before.json'), afterArtifact: path.join(output, 'after.json') }));
  });
}