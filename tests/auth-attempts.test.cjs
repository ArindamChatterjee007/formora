'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/supaauth.js'), 'utf8');
const localAuthSource = fs.readFileSync(path.join(__dirname, '../js/auth.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
const session = (owner, version = 'initial') => ({
  access_token: `fixture-access-${owner}-${version}`,
  refresh_token: `fixture-refresh-${owner}-${version}`,
  expires_in: 3600,
  user: { id: owner, email: `${owner.toLowerCase()}@example.test` }
});

function pending() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function setup() {
  const storage = new Map(), requests = [], events = [];
  const requestSeen = pending();
  const context = vm.createContext({
    Date, Event, AbortController, setTimeout, clearTimeout, atob,
    document: { addEventListener() {} },
    window: {
      USE_SUPABASE_AUTH: true,
      SUPABASE_URL: 'https://fixture.invalid',
      SUPABASE_ANON_KEY: 'fixture-public',
      dispatchEvent: event => events.push(event.type)
    },
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    fetch: (url, options) => {
      const response = pending();
      requests.push({ url, options, response });
      requestSeen.resolve();
      return response.promise;
    }
  });
  vm.runInContext(source + '\n' + localAuthSource + '\nglobalThis.subject = SupaAuth; globalThis.localAuth = Auth;', context);
  const auth = context.subject;
  auth._scheduleRefresh = () => {};
  context.localAuth.load();
  return { auth, localAuth: context.localAuth, context, storage, requests, events, requestSeen };
}

function start(auth, method, owner = 'A') {
  if (method === 'password') return auth.login(`${owner.toLowerCase()}@example.test`, 'fixture-only-password');
  if (method === 'signup') return auth.signup(`${owner.toLowerCase()}@example.test`, 'fixture-only-password', { name: owner });
  if (method === 'recovery') return auth.setPasswordWithToken('fixture-recovery-access', 'fixture-recovery-refresh', 3600, 'fixture-new-password');
  return auth.signInWithGoogle('fixture-only-id-token');
}

function respond(request, body, status = 200) {
  request.response.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
}

function cancelled(error) {
  assert.equal(error.name, 'AbortError');
  assert.equal(error.code, 'AUTH_ATTEMPT_CANCELLED');
  assert.equal(error.cancelled, true);
  assert.deepEqual(Object.keys(error).sort(), ['cancelled', 'code', 'name']);
  assert.doesNotMatch(error.message, /@|fixture-|private-owner|late provider detail/);
  return true;
}

for (const method of ['password', 'google']) {
  for (const boundary of ['clear', 'newer account']) {
    test(`DEF-035: delayed ${method} cannot undo ${boundary}`, async () => {
      const { auth, requests, storage, events } = setup();
      const signingIn = start(auth, method);
      if (boundary === 'clear') auth.clear();
      else auth._store(session('B'));
      const stored = storage.get(auth.KEY), eventCount = events.length;
      respond(requests[0], session('A'));
      await assert.rejects(signingIn, cancelled);
      assert.equal(auth.uid(), boundary === 'clear' ? '' : 'B');
      assert.equal(storage.get(auth.KEY), stored);
      assert.equal(events.length, eventCount);
    });
  }

  test(`DEF-035 control: ordinary ${method} returns the real current session`, async () => {
    const { auth, requests, storage } = setup();
    const signingIn = start(auth, method);
    respond(requests[0], session('A'));
    const result = await signingIn;
    assert.equal(result, auth.session);
    assert.deepEqual(Object.keys(result).sort(), ['access_token', 'email', 'expires_at', 'refresh_token', 'uid']);
    assert.equal(auth.uid(), 'A');
    assert.equal(auth.email(), 'a@example.test');
    assert.equal(JSON.parse(storage.get(auth.KEY)).uid, 'A');
  });
}

for (const method of ['password', 'google', 'signup', 'recovery']) {
  test(`DEF-035: delayed ${method} cannot undo an actual logout`, async () => {
    const { auth, requests, storage } = setup();
    auth._store(session('B'));
    const signingIn = start(auth, method);
    const loggingOut = auth.logout();
    assert.equal(auth.session, null);
    assert.equal(storage.has(auth.KEY), false);
    respond(requests[0], method === 'recovery' ? session('A').user : session('A'));
    await assert.rejects(signingIn, cancelled);
    respond(requests[1], {}, 204);
    await loggingOut;
    assert.equal(auth.uid(), '');
    assert.equal(storage.has(auth.KEY), false);
    assert.equal(requests.length, 2);
  });

  test(`DEF-035: ${method} reads a replacement owner from storage before committing`, async () => {
    const { auth, requests, storage } = setup();
    auth._store(session('A'));
    const signingIn = start(auth, method);
    const replacement = { uid: 'B', email: 'b@example.test', access_token: 'fixture-B', refresh_token: 'fixture-refresh-B', expires_at: Math.floor(Date.now() / 1000) + 3600 };
    storage.set(auth.KEY, JSON.stringify(replacement));
    respond(requests[0], method === 'recovery' ? session('A').user : session('A'));
    await assert.rejects(signingIn, cancelled);
    assert.equal(auth.uid(), 'B');
    assert.equal(storage.get(auth.KEY), JSON.stringify(replacement));
  });

  for (const outcome of ['401', 'network error']) {
    test(`DEF-035: late ${method} ${outcome} is cancelled without exposing or clearing the new owner`, async () => {
      const { auth, requests, storage, events } = setup();
      const signingIn = start(auth, method);
      auth._store(session('private-owner'));
      const stored = storage.get(auth.KEY), eventCount = events.length;
      if (outcome === '401') respond(requests[0], { error_description: 'late provider detail' }, 401);
      else requests[0].response.reject(new Error('late provider detail'));
      await assert.rejects(signingIn, cancelled);
      assert.equal(auth.uid(), 'private-owner');
      assert.equal(storage.get(auth.KEY), stored);
      assert.equal(events.length, eventCount);
      assert.equal(requests.length, 1);
    });
  }

  for (const order of ['old first', 'new first']) {
    test(`DEF-035: ${method} same-account attempts are unique and latest intent wins (${order})`, async () => {
      const { auth, requests, storage } = setup();
      auth._store(session('A'));
      const first = start(auth, method), firstId = auth._authAttempt;
      const second = start(auth, method);
      assert.notEqual(auth._authAttempt, firstId);
      const firstRejected = assert.rejects(first, cancelled);
      const newestBody = method === 'recovery' ? session('A').user : session('A', 'newest');
      if (order === 'old first') {
        const stored = storage.get(auth.KEY);
        respond(requests[0], method === 'recovery' ? session('A').user : session('A', 'obsolete'));
        await firstRejected;
        assert.equal(storage.get(auth.KEY), stored);
      }
      respond(requests[1], newestBody);
      const newest = await second, stored = storage.get(auth.KEY);
      if (order === 'new first') {
        respond(requests[0], method === 'recovery' ? session('A').user : session('A', 'obsolete'));
        await firstRejected;
      }
      assert.equal(newest, auth.session);
      assert.equal(auth.uid(), 'A');
      assert.equal(storage.get(auth.KEY), stored);
    });
  }
}

for (const method of ['password', 'google']) {
  test(`DEF-035: a later failed ${method} attempt still invalidates the older success`, async () => {
    const { auth, requests, storage } = setup();
    auth._store(session('B'));
    const first = start(auth, method), second = start(auth, method);
    const firstRejected = assert.rejects(first, cancelled), secondRejected = assert.rejects(second, /Current attempt denied/);
    const stored = storage.get(auth.KEY);
    respond(requests[1], { error_description: 'Current attempt denied' }, 401);
    await secondRejected;
    respond(requests[0], session('A'));
    await firstRejected;
    assert.equal(auth.uid(), 'B');
    assert.equal(storage.get(auth.KEY), stored);
  });

  test(`DEF-035: ${method} checks cancellation after a delayed JSON body`, async () => {
    const { auth, requests } = setup();
    const body = pending(), bodySeen = pending();
    const signingIn = start(auth, method);
    requests[0].response.resolve({ ok: true, status: 200, json: () => { bodySeen.resolve(); return body.promise; } });
    await bodySeen.promise;
    auth.clear();
    body.resolve(session('A'));
    await assert.rejects(signingIn, cancelled);
    assert.equal(auth.uid(), '');
  });

  test(`DEF-035: ${method} cannot overwrite an explicit same-owner session replacement`, async () => {
    const { auth, requests, storage } = setup();
    auth._store(session('A'));
    const signingIn = start(auth, method);
    auth._store(session('A', 'explicit-replacement'));
    const stored = storage.get(auth.KEY);
    respond(requests[0], session('A', 'obsolete'));
    await assert.rejects(signingIn, cancelled);
    assert.equal(storage.get(auth.KEY), stored);
  });

  for (const order of ['refresh first', 'auth first']) {
    for (const outcome of ['success', 'failure']) {
      test(`DEF-035 refresh: ${method} ${outcome}, ${order}, preserves legitimate same-owner refresh`, async () => {
        const { auth, requests } = setup();
        auth._store(session('A'));
        const revision = auth._revision, epoch = auth._authEpoch;
        const refreshing = auth.refresh();
        const signingIn = start(auth, method);
        const settled = outcome === 'failure' ? assert.rejects(signingIn, /Current attempt denied/) : signingIn;
        assert.equal(auth._revision, revision);
        assert.equal(auth._refreshing.promise, refreshing);
        assert.equal(new URL(requests[0].url).searchParams.get('grant_type'), 'refresh_token');
        assert.deepEqual(Object.keys(JSON.parse(requests[0].options.body)), ['refresh_token']);
        const renewed = session('A', 'refreshed'), signedIn = session('A', 'new-login');
        if (order === 'refresh first') {
          respond(requests[0], renewed);
          assert.equal(await refreshing, auth.session);
          assert.equal(auth._authEpoch, epoch);
          assert.ok(auth._revision > revision);
        }
        respond(requests[1], outcome === 'success' ? signedIn : { error_description: 'Current attempt denied' }, outcome === 'success' ? 200 : 401);
        await settled;
        if (order === 'auth first') {
          respond(requests[0], renewed);
          await refreshing;
        }
        assert.equal(auth.uid(), 'A');
        assert.ok(auth.session.access_token === (outcome === 'success' ? signedIn : renewed).access_token, 'The current successful operation supplies the stored credentials');
        assert.equal(auth._refreshing, null);
        assert.equal(requests.length, 2);
      });
    }
  }

  test(`DEF-035 refresh: a late 401 cannot clear a real same-account ${method} login`, async () => {
    const { auth, requests, storage } = setup();
    auth._store(session('A'));
    const refreshing = auth.refresh(), signingIn = start(auth, method);
    respond(requests[1], session('A', 'new-login'));
    const current = await signingIn, stored = storage.get(auth.KEY);
    respond(requests[0], { error: 'Old refresh rejected' }, 401);
    await refreshing;
    assert.equal(auth.session, current);
    assert.equal(storage.get(auth.KEY), stored);
  });
}

for (const firstMethod of ['password', 'google']) {
  test(`DEF-035: a newer provider attempt supersedes ${firstMethod}`, async () => {
    const { auth, requests } = setup();
    const first = start(auth, firstMethod);
    const second = start(auth, firstMethod === 'password' ? 'google' : 'password', 'B');
    const rejected = assert.rejects(first, cancelled);
    respond(requests[1], session('B'));
    const newest = await second;
    respond(requests[0], session('A'));
    await rejected;
    assert.equal(auth.session, newest);
    assert.equal(auth.uid(), 'B');
  });
}

for (const method of ['password', 'google', 'signup']) {
  test(`DEF-035 schema: ${method} rejects malformed successes without inheriting the previous owner`, async () => {
    const invalidBodies = [null, {}, session('A').user, { access_token: 'fixture-partial' },
      { ...session('A'), refresh_token: '' }, { ...session('A'), user: { email: 'a@example.test' } },
      { ...session('A'), user: { id: 'A' } }, { ...session('A'), user: { id: 1, email: 'a@example.test' } },
      { ...session('A'), expires_in: 'bad' }];
    for (const body of invalidBodies) {
      const { auth, requests, storage, localAuth } = setup();
      auth._store(session('B'));
      const stored = storage.get(auth.KEY), signingIn = start(auth, method);
      respond(requests[0], body);
      await assert.rejects(signingIn, { code: 'AUTH_INVALID_RESPONSE' });
      assert.equal(auth.uid(), 'B');
      assert.equal(storage.get(auth.KEY), stored);
      assert.equal(localAuth.currentUser(), null);
      assert.equal(requests.length, 1);
    }
  });
}

test('DEF-035 schema: password and signup reject a different returned email', async () => {
  for (const method of ['password', 'signup']) {
    const { auth, requests } = setup();
    const signingIn = start(auth, method);
    respond(requests[0], session('B'));
    await assert.rejects(signingIn, { code: 'AUTH_INVALID_RESPONSE' });
    assert.equal(auth.session, null);
  }
});

test('DEF-035 signup: confirmed-off signup establishes the actual session with default metadata', async () => {
  const { auth, requests } = setup();
  const signingIn = auth.signup('a@example.test', 'fixture-only-password');
  assert.equal(new URL(requests[0].url).pathname, '/auth/v1/signup');
  assert.deepEqual(JSON.parse(requests[0].options.body), { email: 'a@example.test', password: 'fixture-only-password', data: {} });
  respond(requests[0], session('A'));
  const result = await signingIn;
  assert.equal(result, auth.session);
  assert.equal(result.uid, 'A');
  assert.equal(result.needsConfirm, undefined);
  assert.equal(requests.length, 1);
});

test('DEF-035 signup: only an explicit pending confirmation keeps the needsConfirm return shape', async () => {
  for (const shape of ['raw user', 'wrapped user']) {
    const { auth, requests, storage, localAuth } = setup();
    auth._store(session('B'));
    const stored = storage.get(auth.KEY), signingIn = start(auth, 'signup');
    const user = { ...session('A').user, confirmation_sent_at: '2026-09-06T12:00:00Z', email_confirmed_at: null };
    respond(requests[0], shape === 'raw user' ? user : { user, session: null });
    const result = await signingIn;
    assert.deepEqual(Object.keys(result).sort(), ['email', 'needsConfirm']);
    assert.equal(result.needsConfirm, true);
    assert.equal(result.email, 'a@example.test');
    assert.equal(auth.uid(), 'B');
    assert.equal(storage.get(auth.KEY), stored);
    assert.equal(localAuth.currentUser(), null);
    assert.equal(requests.length, 1);
  }
});

test('DEF-035 signup: a late confirmation response is cancelled after clear', async () => {
  const { auth, requests } = setup();
  const signingIn = start(auth, 'signup');
  auth.clear();
  respond(requests[0], { ...session('A').user, confirmation_sent_at: '2026-09-06T12:00:00Z' });
  await assert.rejects(signingIn, cancelled);
});

test('DEF-035 recovery: valid user response establishes the recovered session, incomplete responses do not', async () => {
  const { auth, requests } = setup();
  const recovering = start(auth, 'recovery');
  assert.equal(requests[0].options.method, 'PUT');
  assert.equal(new URL(requests[0].url).pathname, '/auth/v1/user');
  assert.deepEqual(Object.keys(JSON.parse(requests[0].options.body)), ['password']);
  respond(requests[0], session('A').user);
  const result = await recovering;
  assert.equal(result, auth.session);
  assert.equal(result.uid, 'A');
  const malformed = start(auth, 'recovery');
  respond(requests[1], {});
  await assert.rejects(malformed, { code: 'AUTH_INVALID_RESPONSE' });
  assert.equal(auth.session, result);
});

for (const method of ['password', 'web Google', 'native Google']) {
  test(`DEF-035 app control: ${method} reaches real Auth.currentUser through its public handler`, async () => {
    const { auth, localAuth, context, requests, requestSeen } = setup();
    const entered = [], errors = [];
    const credential = 'fixture.' + Buffer.from(JSON.stringify({ name: 'Member A', email: 'a@example.test' })).toString('base64url') + '.signature';
    context.document.getElementById = id => ({ value: id === 'a-email' ? 'a@example.test' : 'fixture-only-password' });
    context.Capacitor = { Plugins: { SocialLogin: {
      initialize: async () => {},
      login: async () => ({ result: { idToken: credential, profile: { name: 'Member A', email: 'a@example.test' } } })
    } } };
    context.window.Capacitor = context.Capacitor;
    vm.runInContext(appSource + '\nglobalThis.app = App;', context);
    context.app.enterApp = () => entered.push(localAuth.currentUser());
    context.app.authErr = message => errors.push(message);
    const signingIn = method === 'password' ? context.app.doLogin()
      : method === 'web Google' ? context.app.onGoogleCredential({ credential }) : context.app.goGoogleNative();
    await requestSeen.promise;
    const request = requests[0], body = JSON.parse(request.options.body);
    assert.equal(request.options.method, 'POST');
    assert.equal(new URL(request.url).searchParams.get('grant_type'), method === 'password' ? 'password' : 'id_token');
    assert.deepEqual(Object.keys(body).sort(), method === 'password' ? ['email', 'password'] : ['id_token', 'provider']);
    if (method !== 'password') assert.equal(body.provider, 'google');
    respond(request, session('A'));
    await signingIn;
    assert.deepEqual(errors, []);
    assert.equal(entered.length, 1);
    assert.equal(entered[0], localAuth.currentUser());
    assert.equal(localAuth.currentUser().email, auth.email());
    assert.equal(auth.uid(), 'A');
    assert.equal(requests.length, 1);
  });
}