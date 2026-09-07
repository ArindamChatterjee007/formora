'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const fixtureFile = path.join(__dirname, 'moderation-receipts.e2e.cjs');
const fixtureRequire = createRequire(fixtureFile);
const fixtureModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(fixtureFile, 'utf8')
  + '\nmodule.exports = { pageFor, seedCase, reporter, author, moderator, database: () => db, browser: () => browser };', {
  require(name) {
    return name === 'node:test' ? { test() {}, before, beforeEach, after } : fixtureRequire(name);
  },
  module: fixtureModule, __dirname, __filename: fixtureFile, Buffer, URL, console,
  setTimeout, clearTimeout, setInterval, clearInterval
}, { filename: fixtureFile });
const fixture = fixtureModule.exports;

async function withActor(owner, action) {
  const cleanup = [];
  assert.equal(fixture.browser().contexts().length, 0);
  try {
    const actor = await fixture.pageFor({ after(callback) { cleanup.push(callback); } }, owner);
    assert.equal(fixture.browser().contexts().length, 1);
    return await action(actor);
  } finally {
    for (const callback of cleanup.reverse()) await callback();
    assert.equal(fixture.browser().contexts().length, 0);
  }
}

test('serial moderation: lost report ACK, private decision history and fresh-account receipt ownership', { timeout: 60000 }, async () => {
  await withActor(fixture.reporter, async member => {
    member.fault.loseReply = true;
    await member.page.locator('.post-more').click();
    await member.page.getByRole('button', { name: 'Report post', exact: true }).click();
    await member.page.getByRole('button', { name: 'Spam or scam', exact: true }).click();
    await member.page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Could not confirm'));
    await member.page.reload({ waitUntil: 'domcontentloaded' });
    await member.page.locator('.post-more').click();
    await member.page.getByRole('button', { name: 'Report post', exact: true }).click();
    await member.page.getByRole('button', { name: 'Spam or scam', exact: true }).click();
    await member.page.waitForFunction(() => document.getElementById('toast')?.textContent.startsWith('Report sent'));
    const submissions = member.fault.requests.filter(request => request.name === 'submit_report');
    assert.equal(submissions.length, 2);
    assert.equal(submissions[0].body.p_request_id, submissions[1].body.p_request_id);
    assert.equal((await fixture.database().query('SELECT count(*)::int AS count FROM report_cases')).rows[0].count, 1);
    await member.page.locator('#tabbar [data-tab="profile"]').click();
    await member.page.getByRole('button', { name: 'Your reports', exact: true }).click();
    await member.page.getByText('Received', { exact: true }).waitFor();
    assert.equal(await member.page.getByRole('button', { name: 'Moderation queue', exact: true }).count(), 0);
  });

  await withActor(fixture.moderator, async moderator => {
    await moderator.page.evaluate(() => Reports.open(true));
    await moderator.page.getByRole('button', { name: 'Review case', exact: true }).click();
    await moderator.page.locator('#report-note').fill('Private serial QA decision');
    await moderator.page.getByRole('button', { name: 'Save decision', exact: true }).click();
    await moderator.page.getByText('Under review', { exact: true }).waitFor();
    await moderator.page.getByRole('button', { name: 'Review case', exact: true }).click();
    await moderator.page.locator('#report-history').getByText('Private serial QA decision', { exact: true }).waitFor();
    assert.ok((await moderator.page.locator('#report-history').innerText()).includes(fixture.moderator));
  });

  await withActor(fixture.reporter, async member => {
    await member.page.evaluate(() => Reports.open());
    await member.page.getByText('Under review', { exact: true }).waitFor();
    await member.page.getByRole('button', { name: 'Refresh reports', exact: true }).click();
    await member.page.getByText('Under review', { exact: true }).waitFor();
    assert.doesNotMatch(await member.page.locator('#report-content').innerText(), /Private serial QA decision|Spam or scam|Reviewer/);
    assert.equal(member.fault.requests.some(request => request.name === 'report_decision_history'), false);
  });

  await withActor(fixture.author, async subject => {
    await subject.page.evaluate(() => Reports.open());
    await subject.page.getByText('No reports yet.', { exact: true }).waitFor();
    assert.doesNotMatch(await subject.page.locator('#report-content').innerText(), /Private serial QA decision|Spam or scam|Under review/);
  });
});

test('serial moderation: 51 tied receipts and 51 private decisions have no gaps, duplicates or reporter disclosure', { timeout: 60000 }, async () => {
  let selectedCase;
  for (let index = 0; index < 51; index++) selectedCase = await fixture.seedCase();
  await fixture.database().exec("UPDATE report_cases SET created_at='2026-09-01T10:00:00.123456Z'");
  await fixture.database().query("INSERT INTO report_case_actions(case_id,actor,request_id,from_status,to_status,previous_version,note) SELECT $1,$2,gen_random_uuid(),'under_review','no_action',version,'Private decision '||version FROM generate_series(1,51) AS version", [selectedCase, fixture.moderator]);
  const expectedCursor = (await fixture.database().query('SELECT to_json(created_at) AS cursor FROM report_cases LIMIT 1')).rows[0].cursor;

  await withActor(fixture.reporter, async member => {
    await member.page.evaluate(() => Reports.open());
    assert.equal(await member.page.locator('[data-report-id]').count(), 50);
    await member.page.getByRole('button', { name: 'Load more', exact: true }).click();
    await member.page.waitForFunction(() => document.querySelectorAll('[data-report-id]').length === 51);
    const identifiers = await member.page.locator('[data-report-id]').evaluateAll(rows => rows.map(row => row.dataset.reportId));
    assert.equal(new Set(identifiers).size, 51);
    const requests = member.fault.requests.filter(request => request.name === 'my_report_receipts');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].body.p_before, expectedCursor);
    assert.doesNotMatch(await member.page.locator('#modal-card').innerText(), /Private decision|Reviewer/);
    assert.equal(member.fault.requests.some(request => request.name === 'report_decision_history'), false);
  });

  await withActor(fixture.moderator, async moderator => {
    await moderator.page.evaluate(() => Reports.open(true));
    assert.equal(await moderator.page.locator('[data-report-id]').count(), 50);
    await moderator.page.getByRole('button', { name: 'Load more', exact: true }).click();
    await moderator.page.waitForFunction(() => document.querySelectorAll('[data-report-id]').length === 51);
    const identifiers = await moderator.page.locator('[data-report-id]').evaluateAll(rows => rows.map(row => row.dataset.reportId));
    assert.equal(new Set(identifiers).size, 51);
    await moderator.page.locator('[data-report-id="' + selectedCase + '"]').getByRole('button', { name: 'Review case', exact: true }).click();
    await moderator.page.locator('[data-action-id]').first().waitFor();
    assert.equal(await moderator.page.locator('[data-action-id]').count(), 50);
    await moderator.page.getByRole('button', { name: 'Load earlier decisions', exact: true }).click();
    await moderator.page.waitForFunction(() => document.querySelectorAll('[data-action-id]').length === 51);
    const actions = await moderator.page.locator('[data-action-id]').evaluateAll(rows => rows.map(row => row.dataset.actionId));
    assert.equal(new Set(actions).size, 51);
    assert.ok((await moderator.page.locator('[data-action-id]').first().innerText()).includes('Private decision 51'));
    assert.ok((await moderator.page.locator('[data-action-id]').last().innerText()).includes('Private decision 1'));
    const history = moderator.fault.requests.filter(request => request.name === 'report_decision_history');
    assert.equal(history.length, 2);
    assert.equal(history[1].body.p_before_version, 2);
  });
});