'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { testArguments } = require('../scripts/run-functional-checks.cjs');

test('the actual spawned test command enables VM modules for isolated edge-function imports', () => {
  const args = testArguments(['tests/push-delivery.test.cjs'], '/tmp/fixture-junit.xml');
  assert.equal(args[0], '--experimental-vm-modules');
  assert.equal(args.at(-1), 'tests/push-delivery.test.cjs');
  assert.ok(args.includes('--test-reporter-destination=/tmp/fixture-junit.xml'));
  const available = execFileSync(process.execPath, [args[0], '-e', 'process.stdout.write(typeof require("node:vm").SourceTextModule)'], {encoding:'utf8'});
  assert.equal(available,'function');
  const scripts = JSON.parse(fs.readFileSync(path.join(__dirname,'../package.json'),'utf8')).scripts;
  assert.match(scripts['test:unit'], /node --experimental-vm-modules --test /);
});