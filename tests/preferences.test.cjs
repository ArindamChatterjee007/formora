'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = file => fs.readFileSync(path.join(__dirname,'..',file),'utf8');

function fixture(enabled = true) {
  const calls = [], state = { owner:'owner-a', jwt:'token-a', ok:true, pending:false }, captured = {};
  const measurement = { load:async()=>calls.push('load'), reset:()=>calls.push('reset'), checkoutStarted:payload=>(calls.push(payload),true),
    scheduleWorkoutFinalization:payload=>(calls.push(payload),true), flushWorkoutFinalizations:async payload=>(calls.push(payload),[]) };
  const push = { refresh:async()=>calls.push('push-refresh'), suspendLocal:async()=>calls.push('suspend'), beforeAccountChange:()=>{calls.push('before-change');return new Promise(()=>{});}, getState:()=>({canRevokeDevice:false}) };
  const context = vm.createContext({ crypto:webcrypto, TextEncoder, URL, AbortController, setTimeout,clearTimeout,
    window:{SERVER_MEASUREMENT:enabled,FORMORA_WEB_PUSH:false,SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_ANON_KEY:'public',MEASUREMENT_PERMISSIONS:{}},
    Measurement:{create:options=>(captured.measurement=options,measurement)}, FormoraPush:{create:options=>(captured.push=options,push)},
    localStorage:{getItem(){},setItem(){},removeItem(){}},
    SupaAuth:{active:()=>true,uid:()=>state.owner,bearer:()=>state.jwt,token:async()=>state.jwt},
    document:{addEventListener(){},getElementById:()=>({querySelector:()=>null})},
    fetch:async(url,options)=>{captured.request={url,body:JSON.parse(options.body)}; if(state.pending)await new Promise(resolve=>{state.release=resolve;});return {ok:state.ok};} });
  vm.runInContext(source('js/mod/preferences.js')+'\nglobalThis.preferences=Preferences;',context);
  vm.runInContext(source('js/cloud.js')+'\nglobalThis.cloud=Cloud;',context);
  context.cloud.base='https://fixture.supabase.co/rest/v1';context.cloud.key='public';context.cloud.me=state.owner;
  return {context,preferences:context.preferences,cloud:context.cloud,calls,state,captured};
}

test('disabled measurement never creates a controller and feature import never prompts', async()=>{
  const {preferences,captured,calls}=fixture(false);assert.deepEqual(calls,[]);await preferences.resume();
  assert.equal(captured.measurement,undefined);assert.deepEqual(calls,['push-refresh']);
  assert.equal(preferences.prepareWorkoutFinalization('2026-09-05'),null);
});

test('measurement uses the current token and generation, and stale checkout handoffs are rejected',async()=>{
  const {preferences,captured,calls,state}=fixture();await preferences.resume();
  assert.deepEqual(JSON.parse(JSON.stringify(captured.measurement.getSession())),{owner:'owner-a',jwt:'token-a',generation:0});
  assert.equal(preferences.checkoutStarted('pro','upi','owner-a',0),true);
  preferences.reset();state.owner='owner-b';state.jwt='token-b';
  assert.equal(preferences.checkoutStarted('pro','upi','owner-a',0),false);
  assert.equal(captured.measurement.getSession().generation,1);assert.ok(calls.includes('suspend'));
  preferences.beforeAccountChange();assert.ok(calls.includes('before-change'));
});

test('only acknowledged same-owner account snapshots can trigger finalization flush',async()=>{
  const {preferences,cloud,calls,state,captured}=fixture();await preferences.resume();calls.length=0;
  const snapshot={profile:{},workoutLog:[{date:'2026-09-05',finalizationRequestId:webcrypto.randomUUID()}],draftSession:null,restDays:[]};
  assert.equal(await cloud.pushAccount(snapshot),true);
  const ack=calls.find(call=>call.acknowledged);assert.equal(ack.owner,'owner-a');assert.deepEqual(JSON.parse(JSON.stringify(ack.snapshot)),captured.request.body.data);
  calls.length=0;state.ok=false;assert.equal(await cloud.pushAccount(snapshot),false);assert.equal(calls.length,0);
  state.ok=true;state.pending=true;const saving=cloud.pushAccount(snapshot);
  await new Promise(resolve=>setImmediate(resolve));state.owner='owner-b';state.release();
  assert.equal(await saving,false);assert.equal(calls.length,0);
});

test('server-backed mode cannot be bypassed using the legacy diagnostics checkbox',()=>{
  const {context}=fixture();context.window.Track={setMeasurementConsent(){throw Error('Legacy consent must not be used');}};
  vm.runInContext(source('js/app.js')+'\nglobalThis.app=App;',context);
  assert.equal(context.app.renderCheckoutDiagnostics(),'');assert.doesNotThrow(()=>context.app.setCheckoutDiagnostics(true));
});

function registrationFixture() {
  const fixtureState=fixture(false), {context,preferences,state,captured}=fixtureState;
  state.owner='';
  Object.assign(context.window,{REGISTRATION_CONSENT:true,SUPABASE_URL:'https://wospznckvryiihfzwwtn.supabase.co',
    FORMORA_STAGE:{stage:'qat',mode:'isolated-backend',backendProjectRef:'wospznckvryiihfzwwtn',backendOrigin:'https://wospznckvryiihfzwwtn.supabase.co'}});
  context.SupaAuth._hdr=extra=>({apikey:'public','Content-Type':'application/json',...extra});
  context.SupaAuth._timedFetch=async(url,options)=>{
    captured.registration={url,options,body:JSON.parse(options.body)};
    const body=captured.registration.body,capturedAt=Date.now();
    return {ok:true,body:{proof:'a'.repeat(64),version:body.p_version,notice_sha256:body.p_notice_sha256,
      captured_at:new Date(capturedAt).toISOString(),expires_at:new Date(capturedAt+900000).toISOString()}};
  };
  return {...fixtureState,draft:async()=>({name:'Synthetic member',email:' Person@Example.test ',registrationConsent:{
    version:preferences._registrationNotice.version,notice_sha256:await preferences.registrationHash(preferences._registrationNotice.text)}})};
}

test('pre-signup client sends only an explicitly chosen notice and salted email commitment before signup',async()=>{
  const {preferences,captured,draft}=registrationFixture();
  const input=await draft(),meta=await preferences.registrationMetadata(input,()=>{});
  assert.equal(meta.registration_consent_proof,'a'.repeat(64));
  assert.match(meta.registration_consent_binding,/^[a-f0-9]{64}$/);
  assert.equal(captured.registration.body.p_identity_hash,await preferences.registrationHash(meta.registration_consent_binding+':person@example.test'));
  assert.deepEqual(Object.keys(captured.registration.body).sort(),['p_granted','p_identity_hash','p_notice_sha256','p_version']);
  assert.equal(JSON.stringify(captured.registration.body).includes('person@example.test'),false);
  assert.equal(JSON.stringify(captured.registration.body).includes(meta.registration_consent_binding),false);
  assert.equal(captured.registration.options.headers.Authorization,'Bearer public');
  assert.equal(captured.registration.options.redirect,'error');
});

for(const boundary of ['unchecked','production stage','production backend','flag off','signed in','notice changed']) {
  test('pre-signup client '+boundary+' performs no consent request',async()=>{
    const {preferences,context,state,captured,draft}=registrationFixture(),input=await draft();
    if(boundary==='unchecked') input.registrationConsent=null;
    if(boundary==='production stage') context.window.FORMORA_STAGE.stage='production';
    if(boundary==='production backend') context.window.SUPABASE_URL='https://ptukgtxpigdkdzsewuvz.supabase.co';
    if(boundary==='flag off') context.window.REGISTRATION_CONSENT=false;
    if(boundary==='signed in') state.owner='other';
    if(boundary==='notice changed') input.registrationConsent.notice_sha256='0'.repeat(64);
    const meta=await preferences.registrationMetadata(input,()=>{});
    assert.deepEqual(JSON.parse(JSON.stringify(meta)),{name:'Synthetic member'});
    assert.equal(captured.registration,undefined);
  });
}

test('pre-signup client optional receipt failure leaves signup metadata usable but cancellation propagates',async()=>{
  const {preferences,context,draft}=registrationFixture();
  context.SupaAuth._timedFetch=async()=>{throw Error('Unavailable');};
  assert.deepEqual(JSON.parse(JSON.stringify(await preferences.registrationMetadata(await draft(),()=>{}))),{name:'Synthetic member'});
  await assert.rejects(preferences.registrationMetadata(await draft(),()=>{throw Error('Auth changed');}),/Auth changed/);
});

test('pre-signup QAT consent reuses the withdrawal controller without approving billing or checkout measurement',async()=>{
  const {preferences,captured,state}=registrationFixture();state.owner='owner-a';
  await preferences.resume();
  const permission=captured.measurement.permissions[preferences._registrationNotice.version];
  assert.equal(permission.reviewStatus,'pending');assert.deepEqual(Array.from(permission.scopes),['activation']);
  assert.equal(preferences.available(),true);
  assert.equal(preferences.prepareWorkoutFinalization('2026-09-09'),null);
  assert.equal(preferences.checkoutStarted('pro','upi','owner-a',0),false);
});