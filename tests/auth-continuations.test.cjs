'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
function deferred(){let resolve,reject;const promise=new Promise((accept,deny)=>{resolve=accept;reject=deny;});return {promise,resolve,reject};}
function fixture(){
  const calls=[],state={uid:'owner-a',email:'a@example.test'};
  const context=vm.createContext({document:{addEventListener(){},getElementById:id=>({value:id==='o-code'?'123456':'password'})},window:{},
    SupaAuth:{active:()=>true,uid:()=>state.uid,email:()=>state.email,signup:async()=>({}),login:async()=>{calls.push('fallback');return {};},setPasswordWithToken:async()=>({email:state.email})},
    Auth:{verifyOtp:()=>{},supabaseSignIn:user=>calls.push(user),findByEmail:()=>({}),validEmail:email=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/app.js'),'utf8')+'\nglobalThis.app=App;',context);
  context.app.enterApp=()=>calls.push('enter');context.app.authErr=message=>calls.push({error:message});context.app.toast=()=>{};
  context.app.signupDraft={email:state.email,pass:'password',name:'Fixture'};context.app._recoverTokens={access_token:'fixture'};
  return {app:context.app,context,calls,state};
}
test('cancelled OTP authentication never falls through to login or adopts an account',async()=>{
  const {app,context,calls}=fixture();context.SupaAuth.signup=async()=>{throw {code:'AUTH_ATTEMPT_CANCELLED'};};
  await app.doVerifyOtp();assert.deepEqual(calls,[]);
});
test('late OTP and password-recovery replies cannot adopt a superseded auth intent',async()=>{
  for(const method of ['doVerifyOtp','doResetPassword']){
    const {app,context,calls}=fixture(),pending=deferred();
    context.SupaAuth[method==='doVerifyOtp'?'signup':'setPasswordWithToken']=()=>pending.promise;
    const work=app[method]();app._beginAuthIntent('b@example.test');pending.resolve({email:'a@example.test'});await work;
    assert.deepEqual(calls,[]);assert.ok(app._recoverTokens);
  }
});
test('OTP confirmation requirement and absent authenticated owner do not create a local account',async()=>{
  for(const kind of ['confirmation','no-owner']){
    const {app,context,calls,state}=fixture();context.SupaAuth.signup=async()=>kind==='confirmation'?{needsConfirm:true}:{};
    if(kind==='no-owner')state.uid=null;await app.doVerifyOtp();
    assert.equal(calls.length,1);assert.ok(calls[0].error);
  }
});
test('valid OTP and password recovery adopt only the verified current session',async()=>{
  for(const method of ['doVerifyOtp','doResetPassword']){
    const {app,calls}=fixture();await app[method]();assert.equal(calls[0].email,'a@example.test');assert.equal(calls[1],'enter');
  }
});
test('native initialization is part of the auth intent and cannot reopen login after cancellation',async()=>{
  const {app,context,calls}=fixture(),pending=deferred();
  context.Capacitor=context.window.Capacitor={Plugins:{SocialLogin:{login:async()=>calls.push('plugin-login')}}};
  app._initSocialLogin=()=>pending.promise;
  const work=app.goGoogleNative();app._authIntent=null;pending.resolve(true);await work;assert.deepEqual(calls,[]);
});

function sessionFixture(){
  const {app,context,calls}=fixture(),stored=new Map(),listeners=new Map();
  let currentUser={id:'local-a',email:'a@example.test',name:'Member A'};
  Object.assign(context,{
    Event,Store:{key:'gymcoach_v1_local-a',state:{profile:{}},_syncReady:true},
    setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},
    localStorage:{getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,String(value)),removeItem:key=>stored.delete(key)},
    fetch:async()=>{throw new Error('Unexpected network request');},
  });
  context.document.documentElement={setAttribute(){}};
  context.document.getElementById=id=>({value:id==='a-email'?'b@example.test':'password',classList:{add(){},remove(){}}});
  Object.assign(context.window,{
    USE_SUPABASE_AUTH:true,SUPABASE_URL:'https://auth.invalid',SUPABASE_ANON_KEY:'offline-fixture',
    addEventListener:(type,listener)=>listeners.set(type,listener),
    dispatchEvent:event=>{listeners.get(event.type)?.(event);return true;},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/supaauth.js'),'utf8')+'\nglobalThis.SupaAuth=SupaAuth;',context);
  const auth=context.SupaAuth;
  const sessionBody=(owner,email,token=owner)=>({access_token:'access-'+token,refresh_token:'refresh-'+token,expires_in:3600,user:{id:owner,email}});
  auth._store(sessionBody('owner-a','a@example.test'));
  Object.assign(context.Auth,{
    load(){},currentUser:()=>currentUser,findByEmail:email=>({id:'local-'+email.split('@')[0],email,name:'Member'}),
    supabaseSignIn:user=>{currentUser={id:'local-'+user.email.split('@')[0],...user};calls.push({adopt:user.email});return currentUser;},
    loginWithGoogle:user=>{currentUser={id:'local-'+user.email.split('@')[0],...user};calls.push({google:user.email});return currentUser;},
    login:async()=>calls.push('local-password-fallback'),logout:()=>calls.push('logout'),
  });
  for(const method of ['spawnParticles','applySky','guardImages','bindSwipe','_bindModalA11y','_watchCloudReads','updateNotifBadge','closeModal','closeSheet'])app[method]=()=>{};
  app._checkRecovery=()=>false;
  app.enterApp=()=>{app._authUid=auth.uid();calls.push('enter');};
  app.init();calls.length=0;
  return {app,context,calls,auth,sessionBody,stored};
}

test('adjacent auth: a newer native intent survives an older password success with the actual session listener',async()=>{
  const {app,context,calls,auth,sessionBody}=sessionFixture();
  const password=deferred(),initialization=deferred(),requests=[];
  context.fetch=async url=>{
    requests.push(url);
    if(url.endsWith('grant_type=password'))return password.promise;
    if(url.endsWith('grant_type=id_token'))return {ok:true,json:async()=>sessionBody('owner-native','native@example.test')};
    throw new Error('Unexpected authentication fallback');
  };
  context.Capacitor=context.window.Capacitor={Plugins:{SocialLogin:{
    initialize:()=>initialization.promise,
    login:async()=>{calls.push('plugin-login');return {result:{idToken:'offline-token',profile:{email:'native@example.test',name:'Native Member'}}};},
  }}};
  const login=app.doLogin(),native=app.goGoogleNative(),newestIntent=app._authIntent;
  password.resolve({ok:true,json:async()=>sessionBody('owner-b','b@example.test')});
  await login;await Promise.resolve();
  const beforeNative={uid:auth.uid(),email:auth.email(),intentCurrent:app._authIntentCurrent(newestIntent),calls:[...calls]};
  initialization.resolve();await native;await Promise.resolve();
  assert.deepEqual(beforeNative,{uid:'owner-a',email:'a@example.test',intentCurrent:true,calls:[]});
  assert.deepEqual(calls,['plugin-login',{adopt:'native@example.test'},'enter']);
  assert.equal(auth.uid(),'owner-native');
  assert.equal(requests.length,2);
  assert.ok(requests.every(url=>!url.includes('/signup')));
});

test('adjacent auth: cancelling an auth attempt preserves the session and an in-flight benign refresh',async()=>{
  const {app,context,calls,auth,sessionBody,stored}=sessionFixture();
  const password=deferred(),refresh=deferred();
  context.fetch=async()=>password.promise;
  auth._timedFetch=()=>refresh.promise;
  const login=auth.login('b@example.test','password');
  const cancelled=assert.rejects(login,error=>error.code==='AUTH_ATTEMPT_CANCELLED');
  const refreshing=auth.refresh(),session=auth.session,revision=auth._revision,epoch=auth._authEpoch,timer=auth._timer,serialized=stored.get(auth.KEY);
  app._beginAuthIntent('native@example.test');
  assert.equal(auth.session,session);assert.equal(auth._revision,revision);assert.equal(auth._authEpoch,epoch);
  assert.equal(auth._timer,timer);assert.equal(stored.get(auth.KEY),serialized);assert.deepEqual(calls,[]);
  refresh.resolve({ok:true,status:200,body:sessionBody('owner-a','a@example.test','rotated-a')});
  await refreshing;
  password.resolve({ok:true,json:async()=>sessionBody('owner-b','b@example.test')});await cancelled;
  assert.equal(auth.uid(),'owner-a');assert.equal(auth.bearer(),'access-rotated-a');
  assert.equal(auth._authEpoch,epoch);assert.deepEqual(calls,[]);
});

/* ---- DEF-060 (login submission contract) and DEF-066 (login intent) ------
   These drive the real doLogin/submitLogin against the real js/supaauth.js with a scripted
   token endpoint. The keyboard/browser reproduction lives in tests/profile-workflows.e2e.cjs. */

function loginFixture({email='unregistered.qa@example.test',local=null}={}){
  const base=sessionFixture(),{app,context,calls}=base,elements=new Map();
  const make=(id,value='')=>{const element={id,value,textContent:'',disabled:false,attributes:{},
    setAttribute(name,next){this.attributes[name]=String(next);},
    getAttribute(name){return name in this.attributes?this.attributes[name]:null;},
    removeAttribute(name){delete this.attributes[name];},
    focus(){},classList:{add(){},remove(){}}};
    elements.set(id,element);return element;};
  base.email=make('a-email',email);
  base.password=make('a-pass','Fixture-Only-Password42!');
  base.submit=make('login-submit');base.submit.textContent='Log in';
  base.error=make('auth-err');
  context.document.getElementById=id=>elements.get(id)||null;
  app.authErr=message=>{base.error.textContent=message;calls.push({error:message});};
  context.Auth.findByEmail=()=>local;
  app._authUid=null;   // the login form is only reachable while signed out
  base.requests=[];
  base.respond=handler=>{context.fetch=async url=>{base.requests.push(new URL(String(url)).pathname);return handler(String(url));};};
  base.respond(()=>({ok:false,status:401,json:async()=>({error:'Invalid credentials'})}));
  return base;
}
const legacyAccount={id:'local-legacy',email:'legacy@example.test',name:'Legacy Member',provider:'email',hash:'stored-hash'};

test('DEF-060: Enter and the button share one submission handler that never navigates',async()=>{
  const {app}=loginFixture();
  let prevented=0,submissions=0;
  app.doLogin=async()=>{submissions++;};
  const returned=app.submitLogin({preventDefault(){prevented++;}});
  assert.equal(prevented,1,'Form submission is handled in-page');
  assert.equal(returned,false);
  assert.equal(submissions,1,'Enter runs exactly the same login attempt as the button');
});

test('DEF-060: an in-flight login exposes pending state and refuses a duplicate request',async()=>{
  const {app,requests,submit,calls,respond}=loginFixture();
  const held=deferred();
  respond(()=>held.promise);
  const first=app.doLogin();
  await Promise.resolve();
  assert.equal(requests.length,1,'One activation starts one token request');
  assert.equal(submit.disabled,true,'The control reports that work is in progress');
  assert.equal(submit.getAttribute('aria-busy'),'true');
  assert.match(submit.textContent,/signing in/i);

  assert.equal(await app.doLogin(),false,'A second activation is refused while the first is pending');
  assert.equal(requests.length,1,'No duplicate concurrent token request is sent');

  held.resolve({ok:false,status:401,json:async()=>({error:'Invalid credentials'})});
  await first;
  assert.equal(submit.disabled,false,'The control is released once the attempt settles');
  assert.equal(submit.getAttribute('aria-busy'),'false');
  assert.equal(submit.textContent,'Log in');
  assert.ok(calls.some(entry=>entry&&entry.error),'The finished attempt reports its outcome');
});

test('DEF-060: a newer explicit Google intent releases the login guard instead of wedging it',async()=>{
  const {app,submit,respond}=loginFixture();
  const held=deferred();
  respond(()=>held.promise);
  const login=app.doLogin();
  await Promise.resolve();
  assert.equal(submit.disabled,true);
  app._beginAuthIntent('native@example.test');          // the member chose Continue with Google
  assert.equal(app._loginBusy(),false,'The superseded attempt no longer blocks a new sign-in');
  assert.equal(submit.disabled,false);
  held.resolve({ok:false,status:401,json:async()=>({error:'Invalid credentials'})});
  await login;
});

test('DEF-060: obviously invalid input is reported without starting a request',async()=>{
  for(const [address,secret,expected] of [['not-an-email','password',/valid email/i],['member@example.test','',/password/i]]){
    const {app,requests,email,password,calls,submit}=loginFixture();
    email.value=address;password.value=secret;
    assert.equal(await app.doLogin(),false);
    assert.deepEqual(requests,[],'Client-side validation precedes any network call');
    assert.match(calls.at(-1).error,expected);
    assert.equal(submit.disabled,false,'A rejected submission never leaves the button stuck');
  }
});

for(const status of [401,503]){
  test(`DEF-066: a failed ${status} login never requests account creation for a non-legacy address`,async()=>{
    const {app,requests,calls,respond}=loginFixture();
    respond(()=>({ok:false,status,json:async()=>({error:status===401?'Invalid credentials':'Service unavailable'})}));
    assert.equal(await app.doLogin(),false);
    assert.ok(!requests.some(path=>path.endsWith('/signup')),'Logging in is not consent to create an account: '+JSON.stringify(requests));
    assert.deepEqual(calls.filter(entry=>entry==='enter'),[],'A failed login never enters the app');
    const message=calls.at(-1).error;
    if(status===401)assert.match(message,/incorrect email or password/i);
    else{
      assert.match(message,/unavailable|try again|connection|network/i,'An outage gets retryable service feedback');
      assert.doesNotMatch(message,/incorrect email or password/i,'An outage never blames the password');
    }
  });
}

test('DEF-066: an unreadable failure stays honest instead of asserting a wrong password',async()=>{
  const {app,requests,calls,respond}=loginFixture();
  respond(()=>({ok:false,status:503,json:async()=>({})}));   // no server detail at all
  assert.equal(await app.doLogin(),false);
  assert.ok(!requests.some(path=>path.endsWith('/signup')));
  assert.match(calls.at(-1).error,/try again/i);
  assert.doesNotMatch(calls.at(-1).error,/incorrect email or password/i);
});

test('DEF-066: a network failure is service feedback, not a credential rejection',async()=>{
  const {app,context,calls,requests}=loginFixture();
  context.fetch=async()=>{const failure=new TypeError('Failed to fetch');throw failure;};
  assert.equal(await app.doLogin(),false);
  assert.deepEqual(requests,[]);
  assert.match(calls.at(-1).error,/unavailable|try again|connection|network/i);
});

test('DEF-066 control: an eligible legacy account still migrates after its stored password verifies',async()=>{
  const {app,context,calls,requests,sessionBody,email,respond}=loginFixture({email:'legacy@example.test',local:legacyAccount});
  respond(url=>url.includes('/signup')
    ?{ok:true,status:200,json:async()=>sessionBody('owner-legacy','legacy@example.test')}
    :{ok:false,status:401,json:async()=>({error:'Invalid credentials'})});
  assert.equal(email.value,'legacy@example.test');
  assert.equal(await app.doLogin(),true);
  assert.ok(requests.some(path=>path.endsWith('/signup')),'Authorized migration is preserved: '+JSON.stringify(requests));
  assert.ok(calls.includes('local-password-fallback'),'Migration only happens after the local password is verified');
  assert.deepEqual(calls.filter(entry=>entry&&entry.adopt),[{adopt:'legacy@example.test'}]);
  assert.equal(calls.at(-1),'enter');
});

test('DEF-066: a legacy account whose stored password fails is rejected, never migrated',async()=>{
  const {app,context,calls,requests}=loginFixture({email:'legacy@example.test',local:legacyAccount});
  context.Auth.login=async()=>{throw new Error('Incorrect email or password.');};
  assert.equal(await app.doLogin(),false);
  assert.ok(!requests.some(path=>path.endsWith('/signup')));
  assert.match(calls.at(-1).error,/incorrect email or password/i);
});

test('DEF-066: a legacy account is not migrated during a service outage',async()=>{
  const {app,calls,requests,respond}=loginFixture({email:'legacy@example.test',local:legacyAccount});
  respond(()=>({ok:false,status:503,json:async()=>({error:'Service unavailable'})}));
  assert.equal(await app.doLogin(),false);
  assert.ok(!requests.some(path=>path.endsWith('/signup')),'An outage is not evidence that the account is missing');
  assert.match(calls.at(-1).error,/unavailable|try again|connection|network/i);
});

test('an unlabelled outage or unknown rejection never migrates a legacy account',async()=>{
  for(const status of [500,502,503,429,422]){
    const {app,calls,requests,respond}=loginFixture({email:'legacy@example.test',local:legacyAccount});
    respond(()=>({ok:false,status,json:async()=>({})}));
    assert.equal(await app.doLogin(),false);
    assert.equal(requests.some(path=>path.endsWith('/signup')),false);
    assert.equal(calls.includes('local-password-fallback'),false);
    assert.doesNotMatch(calls.at(-1).error,/incorrect email or password/i);
  }
});