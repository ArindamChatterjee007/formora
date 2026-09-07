'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const branches = Object.freeze({ dev: 'dev', qat: 'release', beta: 'beta' });
const entries = ['index.html', 'legal.html', 'manifest.webmanifest', 'version.txt', 'push-worker.js', 'js', 'css', 'assets', 'icons', 'guides'];
const policy = "default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'";

function stageConfig(stage, commit, origin) {
  if (!Object.hasOwn(branches, stage)) throw new Error('Only dev, qat and beta test sites can be built.');
  if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('A full candidate commit is required.');
  const url = new URL(origin);
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.pages\.dev$/.test(url.hostname)
      || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Test sites require a separate HTTPS Cloudflare Pages origin.');
  }
  return { schemaVersion: 1, stage, branch: branches[stage], commit, origin: url.origin,
    mode: 'offline-preview', backendConfigured: false, paymentEnabled: false, acceptance: 'pending' };
}

function guardSource(config) {
  const locked = {
    FORMORA_STAGE: config, SUPABASE_URL: '', SUPABASE_ANON_KEY: '', USE_SUPABASE_AUTH: false,
    SHEETS_API: '', SOCIAL_API: '', GOOGLE_CLIENT_ID: '', GOOGLE_IOS_CLIENT_ID: '',
    PEXELS_KEY: '', EMAIL_FN_URL: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '',
    POSTHOG_KEY: '', POSTHOG_HOST: '', FORMORA_WEB_PUSH: false, FORMORA_PUSH_VAPID_PUBLIC_KEY: '',
    LAUNCH_OFFER: false, FOUNDING: { on: false },
    RAZORPAY: { enabled: false }, LEMONSQUEEZY: { testMode: true, buy: {} }, MUSIC: { tracks: [] }
  };
  return '(function(){"use strict";const values=' + JSON.stringify(locked) + ';'
    + 'function freeze(value){if(value&&typeof value==="object"){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}'
    + 'for(const [key,value] of Object.entries(values)){const locked=freeze(value);Object.defineProperty(window,key,{get:()=>locked,set(){},configurable:false});}'
    + '})();\n';
}

async function transformHtml(source, config) {
  const { parse, serialize, parseFragment } = await import('parse5');
  const document = parse(source);
  const html = document.childNodes.find(node => node.tagName === 'html');
  const head = html.childNodes.find(node => node.tagName === 'head');
  const attr = (node, name) => node.attrs?.find(item => item.name === name)?.value;
  head.childNodes = head.childNodes.filter(node => !(node.tagName === 'meta'
      && (attr(node, 'http-equiv')?.toLowerCase() === 'content-security-policy' || ['robots', 'google-site-verification'].includes(attr(node, 'name'))))
    && !(node.tagName === 'link' && ['canonical', 'preconnect', 'dns-prefetch'].includes(attr(node, 'rel'))));
  const fragment = parseFragment('<meta http-equiv="Content-Security-Policy" content="' + policy + '">'
    + '<meta name="robots" content="noindex,nofollow,noarchive">'
    + '<script src="/__formora/stage.js"></script>');
  for (const node of fragment.childNodes) node.parentNode = head;
  head.childNodes.unshift(...fragment.childNodes);
  const title = head.childNodes.find(node => node.tagName === 'title');
  if (title) title.childNodes = [{ nodeName: '#text', value: 'Formora | ' + config.stage.toUpperCase()
    + ' offline | ' + config.commit.slice(0, 7), parentNode: title }];
  return serialize(document);
}

function inputFiles(root) {
  const files = [];
  function visit(relative) {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error('Symlink is not a publishable app asset: ' + relative);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(absolute).sort()) {
        if (child === '.DS_Store') continue;
        if (child.startsWith('.')) throw new Error('Hidden app asset requires review: ' + relative + '/' + child);
        visit(relative + '/' + child);
      }
    } else if (stat.isFile()) {
      if (stat.size > 25 * 1024 * 1024) throw new Error('Asset exceeds the free Pages per-file limit: ' + relative);
      files.push(relative);
    } else throw new Error('Unsupported app asset: ' + relative);
  }
  for (const entry of entries) visit(entry);
  return files.sort();
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function buildStageSite({ root, output, stage, commit, origin }) {
  const config = stageConfig(stage, commit, origin);
  const relative = path.relative(path.resolve(root), path.resolve(output));
  if (!relative.startsWith('dist' + path.sep)) throw new Error('Stage output must be a new directory below dist/.');
  root = fs.realpathSync(root);
  output = path.join(root, relative);
  for (let parent = output; parent !== root; parent = path.dirname(parent)) {
    if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) throw new Error('Stage output cannot traverse a symlink.');
  }
  if (fs.existsSync(output)) throw new Error('Stage output already exists; use a fresh candidate directory.');
  const inputs = inputFiles(root).map(file => ({ file, bytes: fs.readFileSync(path.join(root, file)) }));
  const manifest = [];
  fs.mkdirSync(output, { recursive: true });
  try {
  for (const { file, bytes } of inputs) {
    const content = file.endsWith('.html') ? Buffer.from(await transformHtml(bytes.toString('utf8'), config)) : bytes;
    fs.mkdirSync(path.dirname(path.join(output, file)), { recursive: true });
    fs.writeFileSync(path.join(output, file), content, { flag: 'wx' });
    manifest.push({ file, sourceSha256: hash(bytes), publishedSha256: hash(content) });
  }
  for (const { file, bytes } of inputs) {
    if (!fs.readFileSync(path.join(root, file)).equals(bytes)) throw new Error('Source changed while packaging: ' + file);
  }
  fs.mkdirSync(path.join(output, '__formora'));
  const generated = {
    '__formora/stage.js': guardSource(config),
    'robots.txt': 'User-agent: *\nDisallow: /\n',
    '_headers': '/*\n  Content-Security-Policy: ' + policy + "; frame-ancestors 'none'\n"
    + '  Cache-Control: no-store\n  X-Robots-Tag: noindex, nofollow, noarchive\n  Referrer-Policy: no-referrer\n'
    + '  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  X-Formora-Stage: ' + stage + '\n'
    + '  Permissions-Policy: payment=(), geolocation=()\n',
    '404.html': '<!doctype html><html lang="en"><title>Not found</title><body>Not found</body></html>\n'
  };
  const controls = Object.entries(generated).map(([file, content]) => {
    fs.writeFileSync(path.join(output, file), content, { flag: 'wx' });
    return { file, publishedSha256: hash(content) };
  });
  const sourceDigest = hash(JSON.stringify({ files: manifest, controls }));
  fs.writeFileSync(path.join(output, '__formora/candidate.json'), JSON.stringify({ ...config, sourceDigest, files: manifest, controls }, null, 2) + '\n', { flag: 'wx' });
  return { ...config, output, assetCount: manifest.length, sourceDigest };
  } catch (error) {
    fs.rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const [stage, commit, origin, destination] = process.argv.slice(2);
  const root = path.resolve(__dirname, '..');
  const config = stageConfig(stage, commit, origin);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  if (git(['rev-parse', 'HEAD']) !== commit) throw new Error('Requested candidate does not match checkout HEAD.');
  const branch = process.env.GITHUB_ACTIONS === 'true' ? process.env.GITHUB_REF_NAME : git(['branch', '--show-current']);
  if (branch !== config.branch) throw new Error('The stage must match its branch.');
  const checked = [...entries, 'tools/build-stage-site.cjs', 'package.json', 'package-lock.json'];
  if (git(['status', '--porcelain', '--untracked-files=all', '--', ...checked])) throw new Error('Stage publication requires a clean app checkout.');
  const result = await buildStageSite({ root, stage, commit, origin, output: path.resolve(root, destination || 'dist/stages/' + stage + '-' + commit) });
  if (git(['rev-parse', 'HEAD']) !== commit || git(['status', '--porcelain', '--untracked-files=all', '--', ...checked])) throw new Error('Candidate changed during packaging.');
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { branches, entries, policy, stageConfig, guardSource, transformHtml, inputFiles, buildStageSite };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });