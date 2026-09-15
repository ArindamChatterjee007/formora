'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const source = file => fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const day = '2026-09-05';
function fixture() {
  const context = vm.createContext({structuredClone,Map,Date,clearTimeout,setTimeout,
    todayISO:()=>day,DEFAULT_PROFILE:{},EXERCISES:{},localStorage:{getItem(){},setItem(){}},
    document:{addEventListener(){}},window:{},Preferences:{prepareWorkoutFinalization(){throw Error('An edit must not mint another receipt');}}});
  vm.runInContext(source('js/storage.js')+'\nglobalThis.store=Store;',context);
  vm.runInContext(source('js/app.js')+'\nglobalThis.app=App;',context);
  vm.runInContext('todayISO = () => "2026-09-05";',context);
  context.store.state={profile:{},workoutLog:[],weightLog:[],foodLog:[],restDays:[]};
  context.store.save=()=>{};
  for(const name of ['renderToday','renderChips','toast','celebrate'])context.app[name]=()=>{};
  context.app._fromKg=value=>value;context.app._toKg=value=>Number(value);
  return {store:context.store,app:context.app};
}
const entry = (extra={})=>({date:day,split:'Push',volume:100,exercises:[{id:'fixture',name:'Fixture',muscle:'Chest',sets:[{reps:10,weight:10}]}],...extra});
const plain = value=>JSON.parse(JSON.stringify(value));

test('cloud partial plus local finalization merge preserves one calendar workout and its nonce',()=>{
  const {store}=fixture(),request=randomUUID();store.state.workoutLog=[entry({finalizationRequestId:request})];
  store.merge({profile:{},workoutLog:[entry()]});
  assert.equal(store.state.workoutLog.length,1);assert.equal(store.workoutOn(day).finalizationRequestId,request);
  store.merge({profile:{},workoutLog:[entry({date:'2026-09-04'})]});
  assert.equal(store.state.workoutLog.length,2);
});

test('cloud finalization beats stale partial but local edits to the same finalized day survive',()=>{
  const {store}=fixture(),request=randomUUID();store.state.workoutLog=[entry()];
  store.merge({profile:{},workoutLog:[entry({finalizationRequestId:request})]});
  assert.equal(store.state.workoutLog.length,1);assert.equal(store.workoutOn(day).finalizationRequestId,request);
  store.state.workoutLog=[entry({finalizationRequestId:request,volume:200})];
  store.merge({profile:{},workoutLog:[entry({finalizationRequestId:request,volume:100})]});
  assert.equal(store.workoutOn(day).volume,200);
});

test('editing, saving progress and finishing retain the original finalization request identity',()=>{
  const {store,app}=fixture(),request=randomUUID();store.state.workoutLog=[entry({finalizationRequestId:request})];
  app.editSession();assert.equal(app.session.finalizationRequestId,request);
  app._buildEntry=()=>({exercises:plain(entry().exercises),volume:150});
  app.saveProgress();assert.equal(store.workoutOn(day).finalizationRequestId,request);
  app.finishSession();assert.equal(store.workoutOn(day).finalizationRequestId,request);
  assert.equal(store.state.workoutLog.length,1);assert.equal(store.state.draftSession,null);
});