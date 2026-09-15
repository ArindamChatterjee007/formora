'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const identity = require('../supabase/functions/parse-story-media/identity.json');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const inputs = ['supabase/functions/validate-story-media/index.ts', 'supabase/functions/validate-story-media/deno.json',
  'supabase/functions/validate-story-media/deno.lock', 'supabase/functions/parse-story-media/index.ts',
  'supabase/functions/parse-story-media/handler.ts', 'supabase/functions/parse-story-media/resource.ts',
  'supabase/functions/parse-story-media/resource-data.ts', 'supabase/functions/parse-story-media/parser-module.js',
  'supabase/functions/parse-story-media/deno.json', 'supabase/functions/parse-story-media/identity.json'];

function prepareStoryParser(output, wasmFile) {
  output = path.resolve(output);
  assert.ok(output.startsWith(path.join(root, 'dist') + path.sep), 'Parser packages belong under dist');
  assert.equal(fs.existsSync(output), false, 'Use a new parser package directory');
  for (let current = path.dirname(output); current !== root; current = path.dirname(current)) {
    if (fs.existsSync(current)) assert.equal(fs.lstatSync(current).isSymbolicLink(), false);
  }
  for (const directory of ['parse-story-media', 'validate-story-media']) {
    const prefix = 'supabase/functions/' + directory + '/';
    assert.deepEqual(fs.readdirSync(path.join(root, prefix)).map(file => prefix + file).sort(),
      inputs.filter(file => file.startsWith(prefix)).sort(), 'Unexpected or omitted parser source');
  }
  const wasm = fs.readFileSync(wasmFile);
  assert.equal(wasm.length, identity.wasm.bytes, 'Unexpected WASM size');
  assert.equal(sha256(wasm), identity.wasm.sha256, 'Unexpected WASM identity');
  const browserModule = fs.readFileSync(path.join(path.dirname(wasmFile), 'esm-bundle/index.js'));
  assert.equal(browserModule.length, identity.module.bytes, 'Unexpected parser module size');
  assert.equal(sha256(browserModule), identity.module.sha256, 'Unexpected parser module identity');
  const sources = inputs.map(file => {
    assert.equal(fs.lstatSync(path.join(root, file)).isSymbolicLink(), false);
    return { file, bytes: fs.readFileSync(path.join(root, file)) };
  });
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  try {
    for (const source of sources) {
      fs.mkdirSync(path.dirname(path.join(output, source.file)), { recursive: true });
      fs.writeFileSync(path.join(output, source.file), source.bytes, { flag: 'wx' });
    }
    const compressed = gzipSync(wasm, { level: 9 });
    assert.ok(compressed.length <= 1048576);
    const payload = 'supabase/functions/parse-story-media/resource-data.ts';
    fs.writeFileSync(path.join(output, payload), 'export default ' + JSON.stringify(compressed.toString('base64')) + ';\n');
    fs.writeFileSync(path.join(output, 'supabase/functions/parse-story-media/parser-module.js'), browserModule);
    const license = fs.readFileSync(path.resolve(path.dirname(wasmFile), '../LICENSE.txt'));
    assert.equal(sha256(license), identity.license.sha256, 'Unexpected parser license identity');
    fs.writeFileSync(path.join(output, 'supabase/functions/parse-story-media/MediaInfo.LICENSE.txt'), license, { flag: 'wx' });
    fs.writeFileSync(path.join(output, 'supabase/config.toml'), 'project_id = "formora-story-parser"\n\n[functions.parse-story-media]\nverify_jwt = true\nentrypoint = "./functions/parse-story-media/index.ts"\nimport_map = "./functions/parse-story-media/deno.json"\n\n[functions.validate-story-media]\nverify_jwt = true\nentrypoint = "./functions/validate-story-media/index.ts"\nimport_map = "./functions/validate-story-media/deno.json"\n', { flag: 'wx' });
    const record = { result: 'prepared_not_deployed', wasm: { bytes: wasm.length, sha256: sha256(wasm), gzipBytes: compressed.length },
      sourceHashes: Object.fromEntries(sources.map(source => [source.file, sha256(source.bytes)])),
      packageHashes: Object.fromEntries([...inputs, 'supabase/config.toml', 'supabase/functions/parse-story-media/MediaInfo.LICENSE.txt']
        .map(file => [file, sha256(fs.readFileSync(path.join(output, file)))])),
      payloadSha256: sha256(fs.readFileSync(path.join(output, payload))), parserModuleSha256: sha256(browserModule), licenseSha256: sha256(license),
      sourceUnchanged: sources.every(source => sha256(fs.readFileSync(path.join(root, source.file))) === sha256(source.bytes)),
      flagsEnabled: false, providerWrites: 0 };
    assert.equal(record.sourceUnchanged, true);
    fs.writeFileSync(path.join(output, 'package-evidence.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return record;
  } catch (error) { fs.rmSync(output, { recursive: true, force: true }); throw error; }
}

if (require.main === module) {
  const output = process.argv[2];
  assert.ok(output, 'Specify a new package directory below dist');
  const resolved = execFileSync(process.env.STORY_MEDIA_DENO || 'deno', ['eval', '--frozen', '--cached-only',
    '--config', path.join(root, 'supabase/functions/validate-story-media/deno.json'),
    'console.log(import.meta.resolve("npm:mediainfo.js@0.3.7/MediaInfoModule.wasm"))'], { cwd: root, encoding: 'utf8' }).trim();
  console.log(JSON.stringify({ ...prepareStoryParser(output, fileURLToPath(resolved)), output: path.relative(root, path.resolve(output)) }));
}
module.exports = { prepareStoryParser, inputs, identity };