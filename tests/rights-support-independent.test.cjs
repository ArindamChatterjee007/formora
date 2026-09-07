'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const appSource = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
const authSource = fs.readFileSync(path.join(__dirname, '../js/supaauth.js'), 'utf8');
const supportSource = fs.readFileSync(path.join(__dirname, '../js/mod/support-receipts.js'), 'utf8');
const ownerA = '11111111-1111-4111-8111-111111111111';
const ownerB = '22222222-2222-4222-8222-222222222222';
const fixtureUrl = 'http://127.0.0.1/rights-support-independent';
let browser;

before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function appFixture(context, options = {}) {
  const browserContext = await browser.newContext({ reducedMotion: 'reduce', serviceWorkers: 'block' });
  await browserContext.route('**/*', route => route.request().url() === fixtureUrl
    ? route.fulfill({ contentType: 'text/html', body: '<main id="app-shell"></main><div id="modal" class="hidden"><div id="modal-card"></div></div>' })
    : route.abort('blockedbyclient'));
  const page = await browserContext.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  context.after(async () => { await browserContext.close(); assert.deepEqual(errors, []); });
  await page.goto(fixtureUrl, { waitUntil: 'load' });
  if (options.clock) await page.clock.install();
  await page.evaluate(() => {
    window.fixture = { messages: [], calls: [], holdPath: null };
    window.USE_SUPABASE_AUTH = true;
    window.SUPABASE_URL = location.origin;
    window.SUPABASE_ANON_KEY = 'fixture';
    window.SUPPORT_RECEIPTS = true;
    window.Auth = { currentUser: () => ({ id: SupaAuth.uid(), email: SupaAuth.email() }), logout() {} };
    window.Cloud = {
      base: location.origin + '/rest/v1', key: 'fixture', active: () => true,
      _actionUid: () => SupaAuth.uid(), _headers: extra => ({ apikey: 'fixture', ...extra }), stop() {},
      _writeAction: async () => { fixture.calls.push({ path: 'legacy' }); return true; }
    };
    window.Entitlements = { tier: () => 'free', reset() {} };
    window.Store = {};
    window.fetch = async (url, options = {}) => {
      const pathname = new URL(url, location.href).pathname;
      const body = JSON.parse(options.body || '{}');
      const owner = SupaAuth.uid();
      fixture.calls.push({ path: pathname, body, owner });
      const response = () => new Response(JSON.stringify(pathname === '/auth/v1/token'
        ? { access_token: 'fixture-token-' + owner, refresh_token: 'fixture-refresh', expires_in: 3600,
          user: { id: owner, email: owner + '@example.test' } }
        : pathname === '/rest/v1/rpc/submit_support_case'
          ? { id: '33333333-3333-4333-8333-333333333333', request_id: body.p_request_id,
            status: 'open', version: 1, created_at: new Date().toISOString() }
          : {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (fixture.holdPath === pathname) {
        fixture.holdPath = null;
        return new Promise((resolve, reject) => {
          fixture.release = () => resolve(response());
          fixture.reject = () => reject(new TypeError('Fixture response lost'));
        });
      }
      return response();
    };
  });
  await page.addScriptTag({ content: [authSource, supportSource, appSource].join('\n') });
  await page.evaluate(owner => {
    fixture.setSession = nextOwner => SupaAuth._store({
      access_token: 'fixture-token-' + nextOwner, refresh_token: 'fixture-refresh', expires_in: 3600,
      user: { id: nextOwner, email: nextOwner + '@example.test' }
    });
    fixture.setSession(owner);
    App._entry = 1;
    App.toast = message => fixture.messages.push(message);
    App._syncModal = () => {};
    App.closeSheet = () => {};
    App.updateNotifBadge = () => {};
    App.showAuth = () => {};
  }, ownerA);
  return page;
}

test('independent: closing support removes its private App-owned form', { timeout: 15000 }, async context => {
  const page = await appFixture(context);
  const result = await page.evaluate(() => {
    App.openSupport();
    const subject = document.getElementById('sp-subj'), message = document.getElementById('sp-msg');
    subject.value = 'Private subject';
    message.value = 'Private message';
    App.closeModal();
    const privateForm = document.getElementById('sp-msg')?.value ?? null;
    const card = document.getElementById('modal-card');
    card.innerHTML = '<h2>Unrelated modal</h2><input id="unrelated-draft">';
    const markup = card.innerHTML, unrelated = document.getElementById('unrelated-draft');
    unrelated.value = 'Unrelated draft';
    document.getElementById('modal').classList.remove('hidden');
    App.closeModal();
    return {
      hidden: document.getElementById('modal').classList.contains('hidden'),
      privateForm, subject: subject.value, message: message.value,
      detached: !subject.isConnected && !message.isConnected,
      unrelatedPreserved: card.innerHTML === markup && document.getElementById('unrelated-draft') === unrelated,
      unrelatedDraft: unrelated.value
    };
  });
  assert.deepEqual(result, { hidden: true, privateForm: null, subject: '', message: '', detached: true,
    unrelatedPreserved: true, unrelatedDraft: 'Unrelated draft' });
});

test('independent: reauthentication scrubs the password during a stalled and cancelled sign-in', { timeout: 15000 }, async context => {
  const page = await appFixture(context);
  await page.evaluate(() => {
    fixture.holdPath = '/auth/v1/token';
    fixture.reauth = App.reauthenticateAccountRights(SupaAuth.uid());
    fixture.password = document.getElementById('rights-password');
    fixture.password.value = 'fixture-password';
    fixture.submitted = App._rightsReauth.form.onsubmit(new Event('submit', { cancelable: true }));
  });
  await page.waitForFunction(() => typeof fixture.release === 'function');
  const result = await page.evaluate(async () => {
    const whilePending = fixture.password.value;
    document.getElementById('rights-auth-cancel').click();
    const authenticated = await fixture.reauth;
    const afterCancel = fixture.password.value;
    fixture.reject();
    await fixture.submitted;
    return { whilePending, afterCancel, afterLateFailure: fixture.password.value, authenticated,
      connected: fixture.password.isConnected, pending: App._rightsReauth };
  });
  assert.deepEqual(result, { whilePending: '', afterCancel: '', afterLateFailure: '', authenticated: false,
    connected: false, pending: null });
});

test('independent: close, replacement and account invalidation settle the rights promise once', { timeout: 15000 }, async context => {
  const page = await appFixture(context);
  const result = await page.evaluate(async otherOwner => {
    const settled = [];
    let resolutions = 0;
    const first = App.reauthenticateAccountRights(SupaAuth.uid()).then(value => { resolutions++; return value; });
    const replacement = App.reauthenticateAccountRights(SupaAuth.uid());
    settled.push(await first);
    const replacementSurvived = !!App._rightsReauth && document.querySelectorAll('.account-rights-reauth').length === 1;
    App.closeModal();
    settled.push(await replacement);
    const invalidated = App.reauthenticateAccountRights(SupaAuth.uid());
    App._invalidateAccount();
    settled.push(await invalidated);
    const previousOwner = SupaAuth.uid();
    fixture.setSession(otherOwner);
    settled.push(await App.reauthenticateAccountRights(previousOwner));
    return { settled, resolutions, replacementSurvived, card: document.getElementById('modal-card').innerHTML,
      pending: App._rightsReauth };
  }, ownerB);
  assert.deepEqual(result, { settled: [false, false, false, false], resolutions: 1, replacementSurvived: true,
    card: '', pending: null });
});

test('independent: reauthentication timeout settles false without waiting in real time', { timeout: 15000 }, async context => {
  const page = await appFixture(context, { clock: true });
  await page.evaluate(() => {
    fixture.reauth = App.reauthenticateAccountRights(SupaAuth.uid());
  });
  await page.clock.fastForward(25000);
  const result = await page.evaluate(async () => ({
    authenticated: await fixture.reauth,
    pending: App._rightsReauth,
    formCount: document.querySelectorAll('.account-rights-reauth').length,
    requests: fixture.calls.length
  }));
  assert.deepEqual(result, { authenticated: false, pending: null, formCount: 0, requests: 0 });
});

test('independent: an old sign-in completion cannot settle a new owners reauthentication', { timeout: 15000 }, async context => {
  const page = await appFixture(context);
  await page.evaluate(() => {
    fixture.holdPath = '/auth/v1/token';
    fixture.previousReauth = App.reauthenticateAccountRights(SupaAuth.uid());
    document.getElementById('rights-password').value = 'fixture-password';
    fixture.submitted = App._rightsReauth.form.onsubmit(new Event('submit', { cancelable: true }));
  });
  await page.waitForFunction(() => typeof fixture.release === 'function');
  const result = await page.evaluate(async nextOwner => {
    App.logout();
    fixture.setSession(nextOwner);
    const currentReauth = App.reauthenticateAccountRights(nextOwner);
    const currentPending = App._rightsReauth;
    document.getElementById('rights-password').value = 'new-owner-draft';
    fixture.release();
    await fixture.submitted;
    const result = { previousAuthenticated: await fixture.previousReauth,
      owner: SupaAuth.uid(), currentPreserved: App._rightsReauth === currentPending,
      currentPassword: document.getElementById('rights-password').value };
    App.closeModal();
    result.currentAuthenticated = await currentReauth;
    return result;
  }, ownerB);
  assert.deepEqual(result, { previousAuthenticated: false, owner: ownerB, currentPreserved: true,
    currentPassword: 'new-owner-draft', currentAuthenticated: false });
});

test('independent: flag-on support preserves a newer draft through a single acknowledged submission', { timeout: 15000 }, async context => {
  const page = await appFixture(context);
  await page.evaluate(() => {
    App.openSupport();
    document.getElementById('sp-subj').value = 'Original subject';
    document.getElementById('sp-msg').value = 'Original message';
    fixture.holdPath = '/rest/v1/rpc/submit_support_case';
    fixture.first = App.submitTicket();
    fixture.second = App.submitTicket();
  });
  await page.waitForFunction(() => typeof fixture.release === 'function');
  const result = await page.evaluate(async () => {
    document.getElementById('sp-subj').value = 'New subject';
    document.getElementById('sp-msg').value = 'New message';
    fixture.release();
    await Promise.all([fixture.first, fixture.second]);
    return {
      submissions: fixture.calls.filter(call => call.path === '/rest/v1/rpc/submit_support_case').length,
      legacy: fixture.calls.filter(call => call.path === 'legacy').length,
      subject: document.getElementById('sp-subj').value,
      message: document.getElementById('sp-msg').value,
      visible: !document.getElementById('modal').classList.contains('hidden'),
      disabled: document.getElementById('sp-send').disabled,
      pending: App._supportPending.size,
      acknowledged: fixture.messages.at(-1).startsWith('Support request received. Reference ')
    };
  });
  assert.deepEqual(result, { submissions: 1, legacy: 0, subject: 'New subject', message: 'New message',
    visible: true, disabled: false, pending: 0, acknowledged: true });
});

async function supportAcrossLogin(context, nextOwner) {
  const page = await appFixture(context);
  await page.evaluate(() => {
    App.openSupport();
    document.getElementById('sp-subj').value = 'Previous session';
    document.getElementById('sp-msg').value = 'Previous session private message';
    SupaAuth.session.expires_at = Math.floor(Date.now() / 1000) + 1;
    localStorage.setItem(SupaAuth.KEY, JSON.stringify(SupaAuth.session));
    fixture.holdPath = '/auth/v1/token';
    fixture.previous = App.submitTicket();
  });
  await page.waitForFunction(() => typeof fixture.release === 'function');
  return page.evaluate(async owner => {
    App.logout();
    fixture.setSession(owner);
    App.openSupport();
    document.getElementById('sp-subj').value = 'Current session';
    document.getElementById('sp-msg').value = 'Current session message';
    await App.submitTicket();
    fixture.release();
    await fixture.previous;
    return fixture.calls.filter(call => call.path === '/rest/v1/rpc/submit_support_case')
      .map(call => ({ owner: call.owner, message: call.body.p_body }));
  }, nextOwner);
}

test('independent: logout and same-owner sign-in cannot revive the previous support submission', { timeout: 15000 }, async context => {
  const submitted = await supportAcrossLogin(context, ownerA);
  assert.deepEqual(submitted, [{ owner: ownerA, message: 'Current session message' }]);
});

test('independent: switching to a different owner rejects the old token continuation', { timeout: 15000 }, async context => {
  const submitted = await supportAcrossLogin(context, ownerB);
  assert.deepEqual(submitted, [{ owner: ownerB, message: 'Current session message' }]);
});

test('independent: close during token refresh isolates a reopened same-owner submission', { timeout: 15000 }, async context => {
  const page = await appFixture(context);
  await page.evaluate(() => {
    App.openSupport();
    document.getElementById('sp-subj').value = 'Closed subject';
    document.getElementById('sp-msg').value = 'Closed private message';
    SupaAuth.session.expires_at = Math.floor(Date.now() / 1000) + 1;
    localStorage.setItem(SupaAuth.KEY, JSON.stringify(SupaAuth.session));
    fixture.holdPath = '/auth/v1/token';
    fixture.previous = App.submitTicket();
    fixture.previousPending = App._supportPending;
  });
  await page.waitForFunction(() => typeof fixture.release === 'function');
  await page.evaluate(() => {
    const releaseToken = fixture.release;
    fixture.release = null;
    App.closeModal();
    App.openSupport();
    document.getElementById('sp-subj').value = 'Reopened subject';
    document.getElementById('sp-msg').value = 'Reopened message';
    fixture.holdPath = '/rest/v1/rpc/submit_support_case';
    fixture.current = App.submitTicket();
    fixture.currentPending = App._supportPending;
    releaseToken();
  });
  await page.waitForFunction(() => typeof fixture.release === 'function'
    && fixture.calls.some(call => call.path === '/rest/v1/rpc/submit_support_case'));
  const result = await page.evaluate(async () => {
    await fixture.previous;
    await App.submitTicket();
    const result = {
      entry: App._entry, owner: SupaAuth.uid(), pendingReplaced: fixture.previousPending !== fixture.currentPending,
      oldPending: fixture.previousPending.size, currentPending: fixture.currentPending.size,
      disabled: document.getElementById('sp-send').disabled,
      message: document.getElementById('sp-msg').value, messages: [...fixture.messages],
      submitted: fixture.calls.filter(call => call.path === '/rest/v1/rpc/submit_support_case')
        .map(call => ({ owner: call.owner, subject: call.body.p_subject, message: call.body.p_body })),
      legacy: fixture.calls.filter(call => call.path === 'legacy').length
    };
    fixture.release();
    await fixture.current;
    result.hiddenAfterAck = document.getElementById('modal').classList.contains('hidden');
    result.pendingAfterAck = App._supportPending.size;
    result.acknowledgements = fixture.messages.filter(message => message.startsWith('Support request received. Reference ')).length;
    return result;
  });
  assert.deepEqual(result, { entry: 1, owner: ownerA, pendingReplaced: true, oldPending: 0, currentPending: 1,
    disabled: true, message: 'Reopened message', messages: [],
    submitted: [{ owner: ownerA, subject: 'Reopened subject', message: 'Reopened message' }], legacy: 0,
    hiddenAfterAck: true, pendingAfterAck: 0, acknowledgements: 1 });
});

test('independent: late support success or failure cannot affect a reopened same-owner draft', { timeout: 15000 }, async context => {
  const page = await appFixture(context);
  for (const outcome of ['success', 'failure']) {
    await page.evaluate(() => {
      App.openSupport();
      document.getElementById('sp-subj').value = 'Closed subject';
      document.getElementById('sp-msg').value = 'Closed message';
      fixture.release = null;
      fixture.messages = [];
      fixture.holdPath = '/rest/v1/rpc/submit_support_case';
      fixture.previous = App.submitTicket();
    });
    await page.waitForFunction(() => typeof fixture.release === 'function');
    const result = await page.evaluate(async completion => {
      App.closeModal();
      App.openSupport();
      const subject = document.getElementById('sp-subj'), message = document.getElementById('sp-msg');
      subject.value = 'Current subject';
      message.value = 'Current private draft';
      if (completion === 'success') fixture.release(); else fixture.reject();
      await fixture.previous;
      return {
        owner: SupaAuth.uid(), entry: App._entry, subject: subject.value, message: message.value,
        originalNodes: document.getElementById('sp-subj') === subject && document.getElementById('sp-msg') === message,
        visible: !document.getElementById('modal').classList.contains('hidden'),
        disabled: document.getElementById('sp-send').disabled, pending: App._supportPending.size,
        messages: fixture.messages, legacy: fixture.calls.filter(call => call.path === 'legacy').length
      };
    }, outcome);
    assert.deepEqual(result, { owner: ownerA, entry: 1, subject: 'Current subject', message: 'Current private draft',
      originalNodes: true, visible: true, disabled: false, pending: 0, messages: [], legacy: 0 }, outcome);
  }
});

test('independent: rights cancellation erases unsubmitted secrets and isolates a same-owner late failure', { timeout: 15000 }, async context => {
  const page = await appFixture(context, { clock: true });
  for (const cancellation of ['cancel', 'close', 'replacement', 'invalidation', 'timeout']) {
    await page.evaluate(reason => {
      fixture.reauth = App.reauthenticateAccountRights(SupaAuth.uid());
      fixture.password = document.getElementById('rights-password');
      fixture.password.value = 'Unsubmitted fixture secret';
      if (reason === 'cancel') document.getElementById('rights-auth-cancel').click();
      if (reason === 'close') App.closeModal();
      if (reason === 'replacement') fixture.replacement = App.reauthenticateAccountRights(SupaAuth.uid());
      if (reason === 'invalidation') App._invalidateAccount();
    }, cancellation);
    if (cancellation === 'timeout') await page.clock.fastForward(25000);
    const result = await page.evaluate(async () => {
      const result = { authenticated: await fixture.reauth, password: fixture.password.value,
        connected: fixture.password.isConnected, requests: fixture.calls.length };
      App.closeModal();
      return result;
    });
    assert.deepEqual(result, { authenticated: false, password: '', connected: false, requests: 0 }, cancellation);
  }
  await page.evaluate(() => {
    fixture.holdPath = '/auth/v1/token';
    fixture.previousReauth = App.reauthenticateAccountRights(SupaAuth.uid());
    fixture.password = document.getElementById('rights-password');
    fixture.password.value = 'Submitted fixture secret';
    fixture.submitted = App._rightsReauth.form.onsubmit(new Event('submit', { cancelable: true }));
    fixture.clearedSynchronously = fixture.password.value === '';
  });
  await page.waitForFunction(() => typeof fixture.release === 'function');
  const result = await page.evaluate(async () => {
    document.getElementById('rights-auth-cancel').click();
    fixture.replacement = App.reauthenticateAccountRights(SupaAuth.uid());
    const pending = App._rightsReauth, password = document.getElementById('rights-password');
    password.value = 'Current fixture secret';
    fixture.reject();
    await fixture.submitted;
    const result = { previousAuthenticated: await fixture.previousReauth, clearedSynchronously: fixture.clearedSynchronously,
      oldPassword: fixture.password.value, currentPassword: password.value, currentPreserved: App._rightsReauth === pending,
      currentError: document.getElementById('rights-auth-error').textContent,
      currentDisabled: pending.form.querySelector('button[type="submit"]').disabled };
    App.closeModal();
    result.currentAuthenticated = await fixture.replacement;
    result.currentPasswordAfterClose = password.value;
    return result;
  });
  assert.deepEqual(result, { previousAuthenticated: false, clearedSynchronously: true, oldPassword: '',
    currentPassword: 'Current fixture secret', currentPreserved: true, currentError: '', currentDisabled: false,
    currentAuthenticated: false, currentPasswordAfterClose: '' });
});

test('independent: a failed receipt ACK retains the current edited draft and permits its retry', { timeout: 15000 }, async context => {
  const page = await appFixture(context);
  await page.evaluate(() => {
    App.openSupport();
    document.getElementById('sp-subj').value = 'Sent subject';
    document.getElementById('sp-msg').value = 'Sent message';
    fixture.holdPath = '/rest/v1/rpc/submit_support_case';
    fixture.submitted = App.submitTicket();
  });
  await page.waitForFunction(() => typeof fixture.release === 'function');
  const result = await page.evaluate(async () => {
    const subject = document.getElementById('sp-subj'), message = document.getElementById('sp-msg');
    subject.value = 'Current subject';
    message.value = 'Current edited draft';
    fixture.reject();
    await fixture.submitted;
    const result = { subject: subject.value, message: message.value,
      originalNodes: document.getElementById('sp-subj') === subject && document.getElementById('sp-msg') === message,
      visible: !document.getElementById('modal').classList.contains('hidden'),
      disabled: document.getElementById('sp-send').disabled, pending: App._supportPending.size,
      failureMessages: [...fixture.messages] };
    await App.submitTicket();
    result.submitted = fixture.calls.filter(call => call.path === '/rest/v1/rpc/submit_support_case')
      .map(call => ({ subject: call.body.p_subject, message: call.body.p_body }));
    result.legacy = fixture.calls.filter(call => call.path === 'legacy').length;
    result.hiddenAfterRetry = document.getElementById('modal').classList.contains('hidden');
    result.acknowledgements = fixture.messages.filter(message => message.startsWith('Support request received. Reference ')).length;
    return result;
  });
  assert.equal(result.failureMessages.length, 1);
  assert.match(result.failureMessages[0], /retry|try again|not confirmed/i);
  delete result.failureMessages;
  assert.deepEqual(result, { subject: 'Current subject', message: 'Current edited draft', originalNodes: true,
    visible: true, disabled: false, pending: 0,
    submitted: [{ subject: 'Sent subject', message: 'Sent message' }, { subject: 'Current subject', message: 'Current edited draft' }],
    legacy: 0, hiddenAfterRetry: true, acknowledgements: 1 });
});