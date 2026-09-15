'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('Native web bundle contains legal, icons, guides and lazy modules, not private office data', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'formora-native-fixture-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = ['index.html', 'legal.html', 'manifest.webmanifest', 'version.txt', 'push-worker.js', 'js/app.js', 'js/mod/review.js', 'css/styles.css', 'assets/exercise.jpg', 'icons/icon-192.png', 'guides/index.html', 'office/board.json', 'backups/private.json'];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), 'fixture-' + file);
  }
  fs.mkdirSync(path.join(directory, 'tools'));
  fs.copyFileSync(path.join(__dirname, '../tools/sync-www.sh'), path.join(directory, 'tools/sync-www.sh'));
  execFileSync('bash', [path.join(directory, 'tools/sync-www.sh')], { cwd: directory });
  for (const file of files.filter(file => !/^(office|backups)\//.test(file))) {
    assert.equal(fs.readFileSync(path.join(directory, 'www', file), 'utf8'), 'fixture-' + file);
  }
  assert.equal(fs.existsSync(path.join(directory, 'www/office')), false);
  assert.equal(fs.existsSync(path.join(directory, 'www/backups')), false);
});