'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const owner = '11111111-1111-4111-8111-111111111111', peer = '22222222-2222-4222-8222-222222222222';
const storyId = '33333333-3333-4333-8333-333333333333';
const media = 'https://fixture.supabase.co/storage/v1/object/public/media/stories/'+owner+'/story.jpg';
const read = file => fs.readFileSync(path.join(__dirname, '..', file),'utf8');
function deferred() { let resolve; const promise = new Promise(complete => { resolve = complete; }); return {promise,resolve}; }
function fixture() {
  const state = {owner,requests:[],toasts:[],uploads:0,confirmed:true};
  const button = {textContent:'Share',disabled:false};
  const preview = {querySelector:()=>button,remove(){state.removed=true;}};
  const context = vm.createContext({crypto:webcrypto,File,Blob,URL,AbortController,setTimeout,clearTimeout,atob,Uint8Array,
    window:{USE_SUPABASE_AUTH:true,SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_ANON_KEY:'public'},
    SupaAuth:{active:()=>true,uid:()=>state.owner,bearer:()=> 'token',token:async()=> 'token'},
    document:{getElementById:id=>id==='story-preview'?preview:null},
    confirm:()=>state.confirmed,alert:message=>state.toasts.push(message),
    App:{toast:message=>state.toasts.push(message)},
    fetch:async(url,options)=>{state.requests.push({url,options});return {ok:true,status:201,json:async()=>[{...JSON.parse(options.body),ts:new Date().toISOString()}]};},
    resizeImage:async()=> 'data:image/jpeg;base64,QQ=='});
  vm.runInContext(read('js/cloud.js')+'\nglobalThis.cloud=Cloud;',context);
  vm.runInContext(read('js/mod/social.js')+'\nglobalThis.social=Social;',context);
  const cloud=context.cloud,social=context.social;
  cloud.me=owner;cloud.base='https://fixture.supabase.co/rest/v1';cloud.key='public';
  cloud.uploadMedia=async()=>{state.uploads++;return media;};
  social.state={};social.cloud.stories=[];social.render=()=>{};
  social._actionScope=()=>state.owner;social.cloudActive=()=>!!state.owner;
  social._storyDraft={id:storyId,owner,scope:owner,isVid:false,file:new File(['photo'],'photo.jpg',{type:'image/jpeg'}),url:'blob:fixture'};
  return {state,context,cloud,social,button};
}
test('Story publication requires an exact owned server row and retains retry identity after a lost response',async()=>{
  const {cloud,context,state}=fixture();let saved;
  context.fetch=async(url,options)=>{state.requests.push({url,options});if(options.method==='GET')return {ok:true,json:async()=>[saved]};
    if(saved)return {ok:false,status:409};saved={...JSON.parse(options.body),ts:new Date().toISOString()};throw Error('Lost acknowledgement');};
  assert.equal(await cloud.addStory(media,'photo',storyId),false);
  const receipt=await cloud.addStory(media,'photo',storyId);
  assert.equal(receipt.id,storyId);assert.equal(receipt.author,owner);assert.equal(state.requests.length,3);
  assert.match(state.requests[2].url,/author=eq\./);
});
test('failed publication keeps its draft and uploaded media; duplicate clicks share one attempt',async()=>{
  const {social,cloud,state,button}=fixture(),pending=deferred(),started=deferred();
  cloud.addStory=()=>{started.resolve();return pending.promise;};
  const draft=social._storyDraft,first=social.shareStory();await started.promise;
  assert.equal(await social.shareStory(),false);assert.equal(button.disabled,true);
  pending.resolve(false);assert.equal(await first,false);assert.equal(social._storyDraft,draft);assert.equal(state.removed,undefined);
  cloud.addStory=async(url,kind,id)=>({id,author:owner,photo:url,kind,ts:Date.now()});
  assert.equal(await social.shareStory(),true);assert.equal(state.uploads,1);assert.equal(social.cloud.stories.length,1);
  assert.equal(social._storyDraft,null);assert.match(state.toasts.at(-1),/Story shared/);
  assert.equal(state.requests.some(request=>request.url.startsWith('data:')),false);
});
for(const boundary of ['account','cancel','new-draft'])test('a '+boundary+' boundary stops a late Story upload from publishing',async()=>{
  const {social,cloud,state}=fixture(),pending=deferred(),started=deferred();let writes=0;
  cloud.uploadMedia=()=>{started.resolve();return pending.promise;};cloud.addStory=async()=>{writes++;return false;};
  const sharing=social.shareStory();await started.promise;
  if(boundary==='account')state.owner=peer;else if(boundary==='cancel')social.cancelStory();else social._storyDraft={id:webcrypto.randomUUID()};
  pending.resolve(media);assert.equal(await sharing,false);assert.equal(writes,0);assert.equal(social.cloud.stories.length,0);
});
test('Story deletion is owner-filtered and failed or malformed acknowledgements preserve the Story',async()=>{
  for(const failure of ['denied','empty','foreign']){
    const {social,cloud,context,state}=fixture();social.cloud.stories=[{id:storyId,author:owner,photo:media}];
    context.fetch=async(url,options)=>{state.requests.push({url,options});return {ok:failure!=='denied',status:403,json:async()=>failure==='empty'?[]:[{id:storyId,author:peer}]};};
    assert.equal(await social.deleteStory(storyId),false);assert.equal(social.cloud.stories.length,1);
    assert.ok(state.requests[0].url.includes('author=eq.'+owner));
    context.fetch=async()=>({ok:true,json:async()=>[{id:storyId,author:owner}]});
    assert.equal(await social.deleteStory(storyId),true);assert.equal(social.cloud.stories.length,0);
  }
});
test('foreign or cancelled Story deletion and missing authenticated publication do not write',async()=>{
  const {social,cloud,state}=fixture();social.cloud.stories=[{id:storyId,author:peer}];
  assert.equal(await social.deleteStory(storyId),false);social.cloud.stories[0].author=owner;state.confirmed=false;
  assert.equal(await social.deleteStory(storyId),false);state.owner='legacy_slug';
  assert.equal(await cloud.addStory(media,'photo',storyId),false);assert.equal(state.requests.length,0);
});

test('flag-on Story publication uses the checked service only and cannot fall back to legacy writes',async()=>{
  const {social,cloud,context,state}=fixture();context.window.STORY_INTERACTIONS=true;
  let legacyWrites=0;cloud.addStory=async()=>{legacyWrites++;return false;};
  context.Stories={publish:async()=>{throw Object.assign(Error('Service unavailable'),{status:503});}};
  assert.equal(await social.shareStory(),false);assert.equal(legacyWrites,0);assert.ok(social._storyDraft);
  context.Stories.publish=async(url,kind,request)=>({receipt:{id:peer,request_id:request,author:owner,committed:true},row:{id:peer,author:owner,photo:url,kind}});
  assert.equal(await social.shareStory(),true);assert.equal(legacyWrites,0);assert.equal(social.cloud.stories.length,0);
  assert.equal(state.uploads,1);
});