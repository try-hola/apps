#!/usr/bin/env node
// Loads the landing page and every app from a running craft-apps container in
// headless Chromium (software WebGL), and fails if any of them doesn't start.
//
//   node scripts/smoke.mjs http://localhost:8080 [outdir]
//
// "Started" means what a person would see: the app's canvas has been sized to
// the window, no loading screen is still showing, and none of its own files
// came back 4xx. Screenshots of each land in outdir (default smoke/). The ids
// of failing apps go to outdir/failures.txt, one per line, so the update job
// can hold them back.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.argv[2] ?? 'http://localhost:8080').replace(/\/$/, '');
const OUT = process.argv[3] ?? join(ROOT, 'smoke');
const APPS = JSON.parse(readFileSync(join(ROOT, 'lineup.json'), 'utf8')).apps.map((a) => a.id);
const SETTLE_MS = 30_000;
const CONCURRENCY = 3;
// Optional files an app probes for and is fine without.
const OPTIONAL = [/\/effectcraft\/effectcraft-config\.json$/, /\/fonts\/manifest\.txt$/];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const failures = [];

async function check(name, path, verdict) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const bad = [];
  const errors = [];
  page.on('response', (r) => {
    if (r.status() >= 400 && r.url().startsWith(BASE) && !OPTIONAL.some((re) => re.test(r.url()))) bad.push(`${r.status()} ${r.url().slice(BASE.length)}`);
  });
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: 'load', timeout: 60_000 });
    const problem = await verdict(page);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    const reasons = [problem, ...bad.slice(0, 3)].filter(Boolean);
    console.log(`${reasons.length ? 'FAIL' : 'PASS'} ${name}${reasons.length ? `: ${reasons.join('; ')}` : ''}${errors.length ? ` (page errors: ${errors.slice(0, 2).join(' | ')})` : ''}`);
    if (reasons.length) failures.push(name);
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`);
    failures.push(name);
  } finally {
    await page.close();
  }
}

await check('landing', '/', async (page) => {
  const r = await page.evaluate(() => ({
    cards: document.querySelectorAll('.card').length,
    shelf: [...document.querySelectorAll('.shelf img')].filter((i) => !i.naturalWidth).length,
  }));
  if (r.cards !== APPS.length) return `${r.cards} cards, expected ${APPS.length}`;
  if (r.shelf) return `${r.shelf} shelf icons failed to load`;
  return null;
});

const queue = [...APPS];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (let id = queue.shift(); id; id = queue.shift()) {
    await check(id, `/${id}/`, async (page) => {
      await page.waitForTimeout(SETTLE_MS);
      const r = await page.evaluate(() => {
        const c = document.querySelector('canvas');
        const loading = [...document.querySelectorAll('[id*="loading" i]')].filter((e) => e.offsetParent !== null).map((e) => e.id);
        return { canvas: c ? [c.width, c.height] : null, loading };
      });
      if (!r.canvas) return 'no canvas';
      if (r.canvas[0] <= 300 && r.canvas[1] <= 150) return `canvas never sized (${r.canvas.join('x')})`;
      if (r.loading.length) return `still loading (${r.loading.join(', ')})`;
      return null;
    });
  }
}));

await browser.close();
writeFileSync(join(OUT, 'failures.txt'), failures.filter((f) => f !== 'landing').join('\n') + (failures.length ? '\n' : ''));
console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : `\nall ${APPS.length} apps and the landing page started`);
process.exitCode = failures.length ? 1 : 0;
