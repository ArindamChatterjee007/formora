'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');

function setup() {
  const state = { secure: true, calls: [], token: 'provider-id-token', errors: [] };
  const plugin = { login: async () => ({ result: { idToken: state.token, profile: { email: 'unverified@example.test', name: 'Native member' } } }) };
  const context = vm.createContext({
    document: { addEventListener() {} }, window: {}, atob,
    Capacitor: { Plugins: { SocialLogin: plugin } },
    SupaAuth: {
      active: () => state.secure, uid: () => 'verified-id', email: () => 'verified@example.test',
      signInWithGoogle: async token => { state.calls.push({ method: 'exchange', token }); }
    },
    Auth: { loginWithGoogle: user => state.calls.push({ method: 'local', user }) }
  });
  context.window.Capacitor = context.Capacitor;
  vm.runInContext(source + '\nglobalThis.app = App;', context);
  context.app._initSocialLogin = async () => true;
  context.app.enterApp = () => state.calls.push({ method: 'enter' });
  context.app.authErr = message => state.errors.push(message);
  return { app: context.app, context, state };
}

test('Native Google verifies its ID token before entering secure app state', async () => {
  const { app, state } = setup(); await app.goGoogleNative();
  assert.deepEqual(state.calls.map(call => call.method), ['exchange', 'local', 'enter']);
  assert.equal(state.calls[0].token, 'provider-id-token');
  assert.equal(state.calls[1].user.email, 'verified@example.test');
});

test('Native Google missing or rejected tokens never create a local signed-in account', async () => {
  for (const failure of ['missing', 'rejected']) {
    const { app, state, context } = setup();
    if (failure === 'missing') state.token = '';
    else context.SupaAuth.signInWithGoogle = async () => { throw new Error('Invalid token'); };
    await app.goGoogleNative();
    assert.equal(state.calls.some(call => call.method === 'local' || call.method === 'enter'), false);
    assert.equal(state.errors.length, 1);
  }
});

test('Legacy nonsecure native sign-in preserves its existing behavior', async () => {
  const { app, state } = setup(); state.secure = false;
  await app.goGoogleNative();
  assert.deepEqual(state.calls.map(call => call.method), ['local', 'enter']);
});