#!/usr/bin/env node
// Moves apps.lock.json to each app's latest upstream release.
//
//   node scripts/update.mjs                 every app not on hold → its latest release
//   node scripts/update.mjs --revert a,b    put apps a and b back to the pin in git HEAD
//                                           (used when a new release fails the smoke test)
//
// The pin is the web zip's own sha256 as GitHub reports it for the release
// asset; build.mjs refuses a download that doesn't match it. An app with a
// `hold` keeps its pin until someone removes the hold by hand — that is how a
// known-broken upstream web build is kept out (see the hold's `reason`).
//
// Prints a markdown summary of what changed to stdout (the PR body uses it)
// and writes nothing when nothing changed.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LINEUP = JSON.parse(readFileSync(join(ROOT, 'lineup.json'), 'utf8'));
const LOCK_PATH = join(ROOT, 'apps.lock.json');
const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));

async function gh(path) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function latestPin(id) {
  const rel = await gh(`/repos/${LINEUP.org}/${id}/releases/latest`);
  const asset = rel.assets.find((a) => /-web-.*\.zip$/.test(a.name));
  if (!asset) throw new Error(`${id} ${rel.tag_name}: no *-web-*.zip asset`);
  if (!asset.digest?.startsWith('sha256:')) throw new Error(`${id} ${rel.tag_name}: GitHub reports no sha256 for ${asset.name}`);
  return {
    version: rel.tag_name.replace(/^v/, ''),
    tag: rel.tag_name,
    released: rel.published_at.slice(0, 10),
    url: asset.browser_download_url,
    sha256: asset.digest.slice('sha256:'.length),
  };
}

const args = process.argv.slice(2);
const changes = [];

if (args[0] === '--revert') {
  const ids = (args[1] ?? '').split(',').filter(Boolean);
  const head = JSON.parse(execFileSync('git', ['show', 'HEAD:images/craft-apps/apps.lock.json'], { cwd: ROOT, encoding: 'utf8' }));
  for (const id of ids) {
    if (!head.apps[id]) throw new Error(`--revert ${id}: not in HEAD's lock`);
    if (lock.apps[id].version !== head.apps[id].version) {
      changes.push(`- **${id}**: ${lock.apps[id].version} failed the smoke test — kept at ${head.apps[id].version}`);
      lock.apps[id] = head.apps[id];
    }
  }
} else {
  for (const { id } of LINEUP.apps) {
    const cur = lock.apps[id];
    if (cur?.hold) {
      changes.push(`- **${id}**: held at ${cur.version} — ${cur.hold}`);
      continue;
    }
    const next = await latestPin(id);
    if (cur?.version === next.version && cur?.sha256 === next.sha256) continue;
    changes.push(`- **${id}**: ${cur?.version ?? '(new)'} → ${next.version} ([release](https://github.com/${LINEUP.org}/${id}/releases/tag/${next.tag}))`);
    lock.apps[id] = next;
  }
}

const changed = changes.some((c) => !c.includes('held at'));
if (changed) writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2) + '\n');
console.log(changes.join('\n') || '- no changes');
process.exitCode = 0;
