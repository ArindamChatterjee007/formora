'use strict';
const { test, before, beforeEach, after } = require('node:test');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { PGlite } = require('@electric-sql/pglite');
const root = path.resolve(__dirname, '..');
const reporter = '11111111-1111-4111-8111-111111111111', author = '22222222-2222-4222-8222-222222222222', moderator = '33333333-3333-4333-8333-333333333333';
let browser, server, base, db;
const endpoints = {
  submit_report: ['p_request_id','p_kind','p_target_id','p_reason'],
  my_report_receipts: ['p_before','p_before_id'], can_review_reports: [],
  moderation_queue: ['p_status','p_before','p_before_id'], report_decision_history: ['p_id','p_before_version'], review_report: ['p_id','p_version','p_status','p_note','p_request_id']
};
before(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; GRANT USAGE ON SCHEMA public,auth TO authenticated;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE TABLE posts(id text PRIMARY KEY, author text); CREATE TABLE comments(id text PRIMARY KEY, author text); CREATE TABLE profiles(uid text PRIMARY KEY);
    INSERT INTO posts VALUES ('reported-post','${author}'); INSERT INTO profiles VALUES ('${author}');`);
  await db.exec(fs.readFileSync(path.join(root,'supabase/moderation-receipts.sql'),'utf8'));
  await db.query('INSERT INTO report_moderators(uid) VALUES($1)', [moderator]);
  server = http.createServer((request,response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url,'http://localhost').pathname); } catch (_) { response.writeHead(404).end(); return; }
    if (pathname === '/') pathname = '/index.html';
    const allowed = /^\/(index\.html|legal\.html|version\.txt|manifest\.webmanifest)$/.test(pathname) || /^\/(js|css|assets|icons)\/[\w/-]+\.(js|css|json|png|svg|jpe?g|webp|ico|woff2)$/.test(pathname);
    const file = path.resolve(root,'.'+pathname);
    if (!allowed || !['GET','HEAD'].includes(request.method) || !file.startsWith(root+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile() || fs.realpathSync(file)!==file) { response.writeHead(404).end(); return; }
    let content = fs.readFileSync(file);
    if (pathname === '/js/config.js') content = Buffer.from(content + `\nObject.assign(window,{SUPABASE_URL:${JSON.stringify(base)},SUPABASE_ANON_KEY:'fixture',MODERATION_RECEIPTS:true,POSTHOG_KEY:'',GOOGLE_CLIENT_ID:'',EMAILJS_PUBLIC_KEY:''});`);
    response.writeHead(200, {'Cache-Control':'no-store','Content-Type':{'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.svg':'image/svg+xml'}[path.extname(file)]||'application/octet-stream'}); response.end(content);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); base='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true});
});
after(async()=>{ await browser?.close(); await db?.close(); if(server) await new Promise(resolve=>server.close(resolve)); });
beforeEach(async()=>{ await db.exec('TRUNCATE report_case_actions, report_cases'); await db.query('UPDATE report_moderators SET enabled=true'); });

async function seedCase(status = 'received', version = 1, reason = 'Private report fixture') {
  return (await db.query("INSERT INTO report_cases(reporter,request_id,kind,target_id,reported_uid,reason,status,version) VALUES($1,$2,'post','reported-post',$3,$4,$5,$6) RETURNING id",[reporter,randomUUID(),author,reason,status,version])).rows[0].id;
}

async function pageFor(context, uid) {
  const browserContext = await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce',serviceWorkers:'block'});
  const fault = { loseReply:false, loseDecision:false, hold:null, started:null, replies:0, replySeen:null, requests:[] };
  await browserContext.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==base) return route.abort('blockedbyclient');
    const name=url.pathname.split('/').at(-1);
    if(Object.hasOwn(endpoints,name)) {
      try {
        const body=request.postDataJSON(),keys=endpoints[name];
        const token = request.headers().authorization || '';
        const authenticated = new Map([reporter, author, moderator].map(owner => ['Bearer fixture-' + owner, owner]));
        if (!authenticated.has(token) || request.headers().apikey !== 'fixture') return route.fulfill({status:401,json:{message:'Invalid fixture bearer'}});
        const requestOwner = authenticated.get(token);
        fault.requests.push({name,owner:requestOwner,body});
        const result=await db.transaction(async transaction=>{
          await transaction.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[requestOwner]);
          await transaction.exec('SET LOCAL ROLE authenticated');
          return (await transaction.query('SELECT public.'+name+'('+keys.map((key,index)=>'$'+(index+1)).join(',')+') AS result',keys.map(key=>body[key]??null))).rows[0].result;
        });
        if(fault.loseReply&&name==='submit_report'){fault.loseReply=false;return route.abort('internetdisconnected');}
        if(fault.loseDecision&&name==='review_report'){fault.loseDecision=false;return route.abort('internetdisconnected');}
        if(fault.hold&&name==='review_report'){fault.started();await fault.hold;}
        await route.fulfill({json:result}); if(name==='review_report') { fault.replies++; fault.replySeen?.(); } return;
      } catch(error) { return route.fulfill({status:/^PT\d{3}$/.test(error.code)?Number(error.code.slice(2)):400,json:{message:error.message}}); }
    }
    if(url.pathname.startsWith('/rest/v1/')) {
      if(name==='get_state')return route.fulfill({json:{users:{[author]:{uid:author,name:'Other member',username:'member'}},posts:{'reported-post':{id:'reported-post',author,text:'Fixture post',likes:{},ts:Date.now()}},comments:{},requests:{},stories:{}}});
      return route.fulfill({json:[]});
    }
    if(url.pathname.startsWith('/auth/v1/'))return route.fulfill({json:{}});
    return route.continue();
  });
  await browserContext.addInitScript(uid=>{
    if(!localStorage.getItem('fixture')){
      localStorage.setItem('fixture','1');localStorage.setItem('fm_dl_x','1');
      localStorage.setItem('formora_supa_session',JSON.stringify({uid,email:uid+'@example.test',access_token:'fixture-'+uid,refresh_token:'unused',expires_at:Math.floor(Date.now()/1000)+3600}));
      localStorage.setItem('gymcoach_auth',JSON.stringify({accounts:[{id:uid,email:uid+'@example.test',name:'Reporter',emailVerified:true}],currentUserId:uid}));
      localStorage.setItem('gymcoach_v1_'+uid,JSON.stringify({profile:{name:'Reporter',email:uid+'@example.test',username:'fixture',onboarded:true},workoutLog:[],foodLog:[],weightLog:[],restDays:[]}));
    }
  },uid);
  const page=await browserContext.newPage(),errors=[]; page.setDefaultTimeout(8000); page.on('pageerror',error=>errors.push(error.message));
  context.after(async()=>{await browserContext.close();assert.deepEqual(errors,[]);});
  await page.goto(base,{waitUntil:'domcontentloaded'}); await page.locator('#app-shell:not(.hidden)').waitFor();
  return {page,fault};
}

test('real UI and SQL keep one receipt after lost acknowledgement, authorize moderator review and show updated private status',async context=>{
  const member=await pageFor(context,reporter); member.fault.loseReply=true;
  await member.page.locator('.post-more').click(); await member.page.getByRole('button',{name:'Report post',exact:true}).click();
  await member.page.getByRole('button',{name:'Spam or scam',exact:true}).click();
  await member.page.waitForFunction(()=>document.getElementById('toast')?.textContent.includes('Could not confirm'));
  await member.page.reload({waitUntil:'domcontentloaded'});await member.page.locator('.post-more').waitFor();
  await member.page.locator('.post-more').click();await member.page.getByRole('button',{name:'Report post',exact:true}).click();await member.page.getByRole('button',{name:'Spam or scam',exact:true}).click();
  await member.page.waitForFunction(()=>document.getElementById('toast')?.textContent.startsWith('Report sent'));
  assert.equal((await db.query('SELECT count(*)::int AS count FROM report_cases')).rows[0].count,1);
  await member.page.locator('#tabbar [data-tab="profile"]').click(); await member.page.getByRole('button',{name:'Your reports',exact:true}).click();
  await member.page.getByText('Received',{exact:true}).waitFor();
  assert.equal(await member.page.getByRole('button',{name:'Moderation queue',exact:true}).count(),0);
  const admin=await pageFor(context,moderator);await admin.page.evaluate(()=>Reports.open(true));
  await admin.page.getByRole('button',{name:'Review case',exact:true}).click();
  await admin.page.locator('#report-note').fill('Checked source content; investigation started');
  await admin.page.getByRole('button',{name:'Save decision',exact:true}).click();
  await admin.page.getByText('Under review',{exact:true}).waitFor();
  await admin.page.getByRole('button',{name:'Review case',exact:true}).click();
  await admin.page.locator('#report-history').getByText('Checked source content; investigation started',{exact:true}).waitFor();
  assert.ok((await admin.page.locator('#report-history').innerText()).includes(moderator));
  await member.page.getByRole('button',{name:'Refresh reports',exact:true}).click(); await member.page.getByText('Under review',{exact:true}).waitFor();
  assert.doesNotMatch(await member.page.locator('#report-content').innerText(),/Checked source content|Spam or scam/);
  const other=await pageFor(context,author);await other.page.evaluate(()=>Reports.open());await other.page.getByText('No reports yet.',{exact:true}).waitFor();
});

test('a late moderator acknowledgement does not reopen a closed modal',async context=>{
  const caseId = await seedCase('under_review',2);
  const admin=await pageFor(context,moderator);await admin.page.evaluate(()=>Reports.open(true));
  await admin.page.getByRole('button',{name:'Review case',exact:true}).click();await admin.page.locator('#report-note').fill('No action after review');
  await admin.page.locator('#report-decision').selectOption('no_action');
  let release,started;admin.fault.hold=new Promise(resolve=>{release=resolve;});const seen=new Promise(resolve=>{started=resolve;});admin.fault.started=started;
  await admin.page.getByRole('button',{name:'Save decision',exact:true}).click();await seen;
  const replied = new Promise(resolve=>{admin.fault.replySeen=resolve;});
  await admin.page.locator('#modal').getByRole('button',{name:'Close',exact:true}).click();release();await replied;
  await admin.page.waitForFunction(()=>Reports._requests.size===0);
  assert.equal(await admin.page.locator('#modal').isVisible(),false);
  assert.equal(await admin.page.locator('#modal-card').innerHTML(),'');
  assert.equal(await admin.page.evaluate(()=>Reports._rows.length),0);
  assert.deepEqual((await db.query('SELECT status,version FROM report_cases WHERE id=$1',[caseId])).rows[0],{status:'no_action',version:3});
  assert.equal((await db.query('SELECT count(*)::int AS count FROM report_case_actions WHERE case_id=$1',[caseId])).rows[0].count,1);
});

test('missing and substituted bearer tokens use the server identity, never the page identity',async context=>{
  await seedCase(); const member=await pageFor(context,reporter);
  const result=await member.page.evaluate(async moderator=>{
    const base = Cloud.base + '/rpc/';
    const missing = await fetch(base+'my_report_receipts',{method:'POST',headers:{apikey:'fixture','Content-Type':'application/json'},body:'{}'});
    const authorizedOther = await fetch(base+'my_report_receipts',{method:'POST',headers:{apikey:'fixture',Authorization:'Bearer fixture-'+moderator,'Content-Type':'application/json'},body:'{}'});
    const deniedQueue = await fetch(base+'moderation_queue',{method:'POST',headers:Cloud._headers(),body:'{}'});
    return {missing:missing.status,other:await authorizedOther.json(),queue:deniedQueue.status};
  },moderator);
  assert.deepEqual(result,{missing:401,other:[],queue:403});
});

test('account invalidation erases private queue DOM, cached owner and failed retry identity',async context=>{
  await seedCase(); const admin=await pageFor(context,moderator);await admin.page.evaluate(()=>Reports.open(true));
  await admin.page.getByText('Private report fixture',{exact:true}).waitFor();
  await admin.page.evaluate(()=>{localStorage.setItem('fm_report_request_fixture','private');App.closeModal();App._invalidateAccount();});
  const state=await admin.page.evaluate(()=>({html:document.getElementById('modal-card').innerHTML,rows:Reports._rows.length,owner:Reports._rowOwner,stored:Object.keys(localStorage).filter(key=>key.startsWith('fm_report_request_'))}));
  assert.deepEqual(state,{html:'',rows:0,owner:null,stored:[]});
});

test('closing a moderator queue erases private content without requiring logout',async context=>{
  await seedCase();const admin=await pageFor(context,moderator);await admin.page.evaluate(()=>Reports.open(true));
  await admin.page.getByText('Private report fixture',{exact:true}).waitFor();
  await admin.page.locator('#modal').getByRole('button',{name:'Close',exact:true}).click();
  assert.equal(await admin.page.locator('#modal-card').innerHTML(),'');
  assert.deepEqual(await admin.page.evaluate(()=>({rows:Reports._rows.length,owner:Reports._rowOwner})),{rows:0,owner:null});
});

test('receipt and history load-more traverse 51 records without leaking moderator history to a reporter',async context=>{
  for(let index=0;index<51;index++) await seedCase();
  await db.exec("UPDATE report_cases SET created_at='2026-09-01T10:00:00.123456Z'");
  const member=await pageFor(context,reporter);await member.page.evaluate(()=>Reports.open());
  await member.page.getByRole('button',{name:'Load more',exact:true}).click();
  await member.page.waitForFunction(()=>document.querySelectorAll('[data-report-id]').length===51);
  assert.equal(new Set(await member.page.locator('[data-report-id]').evaluateAll(rows=>rows.map(row=>row.dataset.reportId))).size,51);
  const caseId=(await db.query('SELECT id FROM report_cases LIMIT 1')).rows[0].id;
  await db.query("INSERT INTO report_case_actions(case_id,actor,request_id,from_status,to_status,previous_version,note) SELECT $1,$2,gen_random_uuid(),'under_review','no_action',version,'Private decision '||version FROM generate_series(1,51) AS version",[caseId,moderator]);
  const admin=await pageFor(context,moderator);await admin.page.evaluate(()=>Reports.open(true));
  await admin.page.getByRole('button',{name:'Load more',exact:true}).click();
  await admin.page.waitForFunction(()=>document.querySelectorAll('[data-report-id]').length===51);
  await admin.page.locator(`[data-report-id="${caseId}"]`).getByRole('button',{name:'Review case',exact:true}).click();
  await admin.page.getByRole('button',{name:'Load earlier decisions',exact:true}).click();
  await admin.page.waitForFunction(()=>document.querySelectorAll('[data-action-id]').length===51);
  assert.ok((await admin.page.locator('[data-action-id]').first().innerText()).includes('Private decision 51'));
  assert.ok((await admin.page.locator('[data-action-id]').last().innerText()).includes('Private decision 1'));
  assert.doesNotMatch(await member.page.locator('#modal-card').innerText(),/Private decision|Reviewer/);
});

test('a lost decision acknowledgement replays once and a revoked moderator cannot read its history',async context=>{
  const caseId=await seedCase();const admin=await pageFor(context,moderator);await admin.page.evaluate(()=>Reports.open(true));
  await admin.page.getByRole('button',{name:'Review case',exact:true}).click();await admin.page.locator('#report-note').fill('Investigating fixture');
  admin.fault.loseDecision=true;await admin.page.getByRole('button',{name:'Save decision',exact:true}).click();
  await admin.page.locator('#report-error').getByText('Could not confirm the request. Retry when online.',{exact:true}).waitFor();
  await admin.page.getByRole('button',{name:'Save decision',exact:true}).click();await admin.page.getByText('Under review',{exact:true}).waitFor();
  assert.equal((await db.query('SELECT count(*)::int AS count FROM report_case_actions WHERE case_id=$1',[caseId])).rows[0].count,1);
  const requests=admin.fault.requests.filter(request=>request.name==='review_report');assert.equal(requests[0].body.p_request_id,requests[1].body.p_request_id);
  await db.query('UPDATE report_moderators SET enabled=false');
  await admin.page.getByRole('button',{name:'Review case',exact:true}).click();
  await admin.page.getByText('You do not have permission for this action.',{exact:true}).waitFor();
  assert.doesNotMatch(await admin.page.locator('#modal-card').innerText(),/Private report fixture|Investigating fixture/);
});