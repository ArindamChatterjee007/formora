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
  const context = vm.createContext({ crypto:webcrypto, URL, AbortController, setTimeout,clearTimeout,
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