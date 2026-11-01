#!/usr/bin/env node
// Validate the generated catalog.json against schemas/catalog.schema.json
// (shape + the release-channel grammar) plus the semantic rules a JSON Schema
// can't express — the ones the Hola server resolves silently, where a mistake
// costs a version rather than an error.
//
// Usage:
//   node bin/validate-catalog.mjs                 # <repo root>/catalog.json
//   node bin/validate-catalog.mjs path/to/catalog.json
//
// Exits non-zero with actionable "app/field: problem" messages on any failure.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const SCHEMA_PATH = join(REPO_ROOT, 'schemas', 'catalog.schema.json');

// Mirrors isValidChannelName() in try-hola/hola packages/shared/src/index.ts.
const CHANNEL_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const STABLE_CHANNEL = 'stable';

function runAjv(catalogPath) {
  const result = spawnSync(
    'npx',
    [
      '--yes',
      'ajv-cli',
      'validate',
      '-s',
      SCHEMA_PATH,
      '-d',
      catalogPath,
      '--spec=draft2020',
      '--strict=false',
    ],
    { encoding: 'utf8' }
  );
  const ok = result.status === 0;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok, output };
}

/** The tag of an OCI reference: `ghcr.io/try-hola/remo:0.11.0-rc.1` → `0.11.0-rc.1`. */
function ociTag(ref) {
  const withoutDigest = ref.split('@')[0];
  const lastSlash = withoutDigest.lastIndexOf('/');
  const lastColon = withoutDigest.lastIndexOf(':');
  return lastColon > lastSlash ? withoutDigest.slice(lastColon + 1) : '';
}

function checkApp(app, index, issues) {
  const label = app?.id ?? `apps[${index}]`;
  const versions = Array.isArray(app?.versions) ? app.versions : [];
  const seen = new Set();

  for (const entry of versions) {
    const version = entry?.version ?? '(missing version)';
    const path = (field) => `${label}/versions[${version}].${field}`;

    // The server keeps the FIRST occurrence of a repeated version string and
    // warns about the rest, so a duplicate is a silently-ignored entry — and if
    // the two disagree on channel, the losing one is the intended listing.
    if (seen.has(version)) {
      issues.push(`${path('version')}: listed more than once (the server keeps the first entry and drops the rest)`);
    }
    seen.add(version);

    // The schema enforces the grammar; this catches the case the schema can't
    // see as an error — a channel that is well-formed but names the floor while
    // the version string says otherwise, or a pre-release listed as stable.
    const channel = entry?.channel ?? STABLE_CHANNEL;
    if (channel === null || channel === undefined || channel === STABLE_CHANNEL) {
      if (typeof version === 'string' && version.includes('-')) {
        issues.push(
          `${path('channel')}: pre-release version listed on '${STABLE_CHANNEL}' — stable is the floor every channel is offered, so this would make a pre-release the default for every install`
        );
      }
    } else if (typeof channel === 'string' && !CHANNEL_NAME_RE.test(channel)) {
      // Unreachable while the schema pattern holds; kept so this file states the
      // whole contract rather than half of it.
      issues.push(`${path('channel')}: '${channel}' does not match ${CHANNEL_NAME_RE} — the server drops the entry`);
    }

    const oci = entry?.refs?.oci;
    if (typeof oci === 'string' && typeof version === 'string') {
      const tag = ociTag(oci);
      if (tag && tag !== version) {
        issues.push(`${path('refs.oci')}: reference is tagged '${tag}' but the entry declares version '${version}'`);
      }
    }
  }

  // An app with no stable entry at all is allowed: one launching on a
  // pre-release channel. Hola lists it with no version, routes its Install to
  // that channel, and shows it only to operators enrolled in pre-releases
  // (spec 005 FR-015; try-hola/hola#568).
}

function main() {
  const arg = process.argv[2];
  const catalogPath = arg ? resolve(process.cwd(), arg) : join(REPO_ROOT, 'catalog.json');

  if (!existsSync(catalogPath)) {
    console.error(`${catalogPath}: file not found`);
    process.exitCode = 1;
    return;
  }

  const issues = [];
  const { ok, output } = runAjv(catalogPath);
  if (!ok) issues.push(`schema validation failed\n${output}`);

  let catalog;
  try {
    catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  } catch (err) {
    console.error(`FAIL ${relative(REPO_ROOT, catalogPath)}`);
    console.error(`  - failed to parse JSON (${err.message})`);
    process.exitCode = 1;
    return;
  }

  const apps = Array.isArray(catalog?.apps) ? catalog.apps : [];
  const ids = new Set();
  apps.forEach((app, index) => {
    if (typeof app?.id === 'string') {
      if (ids.has(app.id)) issues.push(`${app.id}: duplicate app id (the server resolves the first entry only)`);
      ids.add(app.id);
    }
    checkApp(app, index, issues);
  });

  const rel = relative(REPO_ROOT, catalogPath);
  if (issues.length > 0) {
    console.error(`FAIL ${rel}`);
    for (const issue of issues) console.error(`  - ${issue}`);
  } else {
    console.log(`OK   ${rel} (${apps.length} app(s))`);
  }

  // Set the code and let the event loop drain naturally — `process.exit()` can
  // truncate buffered output on a pipe (CI).
  process.exitCode = issues.length > 0 ? 1 : 0;
}

main();
