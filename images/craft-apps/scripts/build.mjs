#!/usr/bin/env node
// Assembles the static site the craft-apps image serves, into dist/:
//
//   dist/index.html          the landing page (landing/index.html, rendered)
//   dist/_craft/             its stylesheet, script, fonts, app icons, build manifest
//   dist/<app>/              each app's upstream web build, unmodified
//
// Every app comes from the web zip pinned in apps.lock.json, and a download
// whose sha256 doesn't match the pin is refused. Downloads are cached in
// .cache/ so a rebuild doesn't fetch 250 MB again.
//
// Text assets get a .gz beside them (nginx `gzip_static on`); each .wasm is
// replaced by its .gz (`gzip_static always` + `gunzip on` in nginx.conf),
// which keeps the image near the size of the zips. Files an upstream build
// already precompressed, and PhotoCraft's gzip parts, are left alone.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, renameSync,
} from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const CACHE = join(ROOT, '.cache');
const LINEUP = JSON.parse(readFileSync(join(ROOT, 'lineup.json'), 'utf8'));
const LOCK = JSON.parse(readFileSync(join(ROOT, 'apps.lock.json'), 'utf8')).apps;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function fetchCached(url, name) {
  const path = join(CACHE, name);
  if (existsSync(path)) return readFileSync(path);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(path, buf);
  return buf;
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
// "PhotoCraft" → Photo<b>Craft</b>, "Craft Anything" → <b>Craft</b> Anything
const wordmark = (name) => escapeHtml(name).replace('Craft', '<b>Craft</b>');

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, '_craft', 'icons'), { recursive: true });
mkdirSync(CACHE, { recursive: true });

// --- the apps ----------------------------------------------------------------
for (const { id } of LINEUP.apps) {
  const pin = LOCK[id];
  if (!pin) throw new Error(`${id}: in lineup.json but not in apps.lock.json — run scripts/update.mjs`);
  const zip = await fetchCached(pin.url, `${id}-${pin.version}.zip`);
  const got = sha256(zip);
  if (got !== pin.sha256) {
    rmSync(join(CACHE, `${id}-${pin.version}.zip`));
    throw new Error(`${id} ${pin.version}: sha256 ${got} does not match the pin ${pin.sha256}`);
  }
  const tmp = join(CACHE, `unpack-${id}`);
  rmSync(tmp, { recursive: true, force: true });
  execFileSync('unzip', ['-q', join(CACHE, `${id}-${pin.version}.zip`), '-d', tmp]);
  // Each zip holds one folder, <id>-web-<version>/; the app is served from /<id>/.
  const [top, ...rest] = readdirSync(tmp);
  if (rest.length || !statSync(join(tmp, top)).isDirectory()) throw new Error(`${id}: expected one top-level folder in the zip`);
  if (!existsSync(join(tmp, top, 'index.html'))) throw new Error(`${id}: the web build has no index.html`);
  renameSync(join(tmp, top), join(DIST, id));
  rmSync(tmp, { recursive: true, force: true });

  // The app icons are MIT OR Apache-2.0 like the code (assets/app-icon/ in each repo).
  const icon = await fetchCached(
    `https://raw.githubusercontent.com/${LINEUP.org}/${id}/${pin.tag}/assets/app-icon/hicolor/256x256/apps/ai.storyteller.${id}.png`,
    `${id}-${pin.version}-icon.png`,
  );
  writeFileSync(join(DIST, '_craft', 'icons', `${id}.png`), icon);
  console.log(`${id} ${pin.version}${pin.hold ? ' (held)' : ''}`);
}

// --- the landing page ----------------------------------------------------------
const apps = LINEUP.apps.map((a, i) => ({ ...a, ...LOCK[a.id], n: String(i + 1).padStart(2, '0') }));
const style = (a) => `--app:${a.app};--app-ink:${a.ink};--app-ink-dark:${a.inkDark}`;

const shelf = apps.map((a) => `
        <li><a class="shelf-app" href="${a.id}/" style="${style(a)}">
          <img src="_craft/icons/${a.id}.png" alt="" width="80" height="80">
          <span>${escapeHtml(a.name)}</span>
        </a></li>`).join('');

const cards = apps.map((a) => `
      <li class="card" style="${style(a)}">
        <div class="card-head"><span class="num">${a.n}</span><span class="cat">${escapeHtml(a.category)}</span></div>
        <img class="card-icon" src="_craft/icons/${a.id}.png" alt="" width="72" height="72" loading="lazy">
        <h3 class="wordmark">${wordmark(a.name)}</h3>
        <p class="blurb">${escapeHtml(a.blurb)}</p>
        <ul class="chips">
          <li class="chip status">${escapeHtml(a.status)}</li>
          <li class="chip">v${escapeHtml(a.version)}</li>
          <li class="chip">${fmtDate(a.released)}</li>${a.hold ? `
          <li class="chip held" title="${escapeHtml(a.hold)}">Pinned</li>` : ''}
        </ul>
        <div class="card-foot">
          <a class="open" href="${a.id}/">Open ${escapeHtml(a.name)}</a>
          <a class="source" href="https://github.com/${LINEUP.org}/${a.id}/releases/tag/${a.tag}" rel="noopener">Release ↗</a>
        </div>
      </li>`).join('');

const built = new Date().toISOString().slice(0, 10);
const page = readFileSync(join(ROOT, 'landing', 'index.html'), 'utf8')
  .replace('{{SHELF}}', shelf)
  .replace('{{CARDS}}', cards)
  .replaceAll('{{COUNT}}', String(apps.length))
  .replaceAll('{{BUILT}}', fmtDate(built));
if (/\{\{[A-Z]+\}\}/.test(page)) throw new Error(`landing/index.html: unrendered placeholder ${page.match(/\{\{[A-Z]+\}\}/)[0]}`);
writeFileSync(join(DIST, 'index.html'), page);
for (const f of ['craft.css', 'craft.js', 'mark.svg']) cpSync(join(ROOT, 'landing', f), join(DIST, '_craft', f));
cpSync(join(ROOT, 'landing', 'fonts'), join(DIST, '_craft', 'fonts'), { recursive: true });
writeFileSync(join(DIST, '_craft', 'build.json'), JSON.stringify({
  built,
  apps: Object.fromEntries(apps.map((a) => [a.id, { version: a.version, sha256: a.sha256, ...(a.hold ? { hold: a.hold } : {}) }])),
}, null, 2) + '\n');

// --- precompression --------------------------------------------------------------
const TEXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.md', '.ttf', '.otf', '.webmanifest', '.ico']);
let before = 0;
let after = 0;
for (const file of walk(DIST)) {
  const ext = extname(file);
  if (ext === '.gz' || ext === '.br' || existsSync(`${file}.gz`)) continue;
  if (ext !== '.wasm' && !TEXT.has(ext)) continue;
  const raw = readFileSync(file);
  if (ext !== '.wasm' && raw.length < 1024) continue;
  const gz = gzipSync(raw, { level: 9 });
  writeFileSync(`${file}.gz`, gz);
  if (ext === '.wasm') {
    rmSync(file); // served from the .gz alone (nginx: gzip_static always)
    before += raw.length;
    after += gz.length;
  }
}
// An upstream .wasm that already had a .gz beside it (LightCraft) goes the same way.
for (const file of walk(DIST)) {
  if (extname(file) === '.wasm' && existsSync(`${file}.gz`)) {
    before += statSync(file).size;
    after += statSync(`${file}.gz`).size;
    rmSync(file);
  }
}
const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
console.log(`wasm: ${mb(before)} → ${mb(after)} gzipped; site total ${mb(walk(DIST).reduce((s, f) => s + statSync(f).size, 0))}`);
