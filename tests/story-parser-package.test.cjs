'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareStoryParser, inputs, identity } = require('../scripts/prepare-story-parser.cjs');
const root = path.resolve(__dirname, '..');

test('Parser packaging rejects unknown WASM bytes and unsafe destinations without creating a package', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'formora-wasm-invalid-'));
  const wasm = path.join(directory, 'MediaInfoModule.wasm');
  fs.writeFileSync(wasm, 'not the pinned parser');
  const output = path.join(root, 'dist/parser-refusal-' + path.basename(directory));
  try {
    assert.throws(() => prepareStoryParser(output, wasm), /Unexpected WASM size/);
    assert.equal(fs.existsSync(output), false);
    assert.throws(() => prepareStoryParser(path.join(directory, 'outside'), wasm), /belong under dist/);
    fs.mkdirSync(output, { recursive: true });
    assert.throws(() => prepareStoryParser(output, wasm), /Use a new parser package directory/);
  } finally { fs.rmSync(output, { recursive: true, force: true }); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('The normal source tree is default-off and contains no generated binary payload or provider secrets', () => {
  const source = fs.readFileSync(path.join(root, 'supabase/functions/parse-story-media/index.ts'), 'utf8');
  const resource = fs.readFileSync(path.join(root, 'supabase/functions/parse-story-media/resource.ts'), 'utf8');
  assert.match(source, /STORY_MEDIA_PARSER_ENABLED/);
  assert.match(source, /config\.enabled && !!parser/);
  assert.match(source, /if \(import\.meta\.main\)/);
  assert.equal(fs.readFileSync(path.join(root, 'supabase/functions/parse-story-media/resource-data.ts'), 'utf8').trim(), 'export default "";');
  assert.match(resource, /wasmIdentity\.sha256/);
  assert.match(resource, /Object\.freeze\(identity\.wasm\)/);
  assert.match(resource, /finally \{ URL\.revokeObjectURL\(url\)/);
  assert.doesNotMatch(resource, /Deno\.(read|write|makeTemp|remove)|node:fs/);
  assert.match(fs.readFileSync(path.join(root, 'supabase/functions/parse-story-media/parser-module.js'), 'utf8'), /parser_resource_missing/);
  assert.doesNotMatch(source + resource, /\/rest\/v1|\/storage\/v1|SUPABASE_SERVICE_ROLE_KEY/);
});

test('Frozen MediaInfo dependency identity remains consistent across validator and parser service', () => {
  const parser = JSON.parse(fs.readFileSync(path.join(root, 'supabase/functions/parse-story-media/deno.json'), 'utf8'));
  const validator = JSON.parse(fs.readFileSync(path.join(root, 'supabase/functions/validate-story-media/deno.json'), 'utf8'));
  assert.deepEqual(parser.imports, validator.imports);
  assert.equal(parser.lock, '../validate-story-media/deno.lock');
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'supabase/functions/validate-story-media/deno.lock'), 'utf8'));
  assert.equal(lock.specifiers['npm:mediainfo.js@0.3.7'], '0.3.7');
  assert.match(lock.npm['mediainfo.js@0.3.7'].integrity, /^sha512-/);
});

test('The package inventory covers both runtime directories and shares reviewed resource identities', () => {
  for (const directory of ['parse-story-media', 'validate-story-media']) {
    const prefix = 'supabase/functions/' + directory + '/';
    assert.deepEqual(fs.readdirSync(path.join(root, prefix)).map(file => prefix + file).sort(), inputs.filter(file => file.startsWith(prefix)).sort());
  }
  assert.equal(identity.wasm.bytes, 2565723);
  assert.equal(identity.wasm.sha256, '6a724ccf89a0ed239841443668e0a166dfc06eb4647de44e1375ebc887721d03');
  assert.equal(identity.module.bytes, 28179);
  assert.equal(identity.module.sha256, 'd1c91279979b2d24faf017145c9eb1d9152e29820a5bd67b9f4e248338bd3061');
  assert.equal(identity.license.sha256, '4997496865cae27ceba179fecb7c90fbe563f4e661fa17d038d3e2b008d2fdb5');
});