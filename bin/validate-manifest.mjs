#!/usr/bin/env node
// Validate one or more manifest.json files against schemas/manifest.schema.json
// (structural/typo checks) plus semantic checks that JSON Schema can't express
// (mirrors `validateParamSpec` in the Hola server's shared param-validate module).
//
// Usage:
//   node bin/validate-manifest.mjs                                   # every src/*/src/manifest.json
//   node bin/validate-manifest.mjs src/gitea/src/manifest.json ...    # specific file(s)
//
// Exits non-zero with actionable "app/field: problem" messages on any failure.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const SCHEMA_PATH = join(REPO_ROOT, 'schemas', 'manifest.schema.json');

function discoverManifests() {
  const srcDir = join(REPO_ROOT, 'src');
  if (!existsSync(srcDir)) return [];
  return readdirSync(srcDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(srcDir, d.name, 'src', 'manifest.json'))
    .filter((p) => existsSync(p));
}

function appLabel(manifestPath) {
  const rel = relative(REPO_ROOT, manifestPath);
  const match = rel.match(/^src\/([^/]+)\/src\/manifest\.json$/);
  return match ? match[1] : rel;
}

function runAjv(manifestPath) {
  const result = spawnSync(
    'npx',
    [
      '--yes',
      'ajv-cli',
      'validate',
      '-s',
      SCHEMA_PATH,
      '-d',
      manifestPath,
      '--spec=draft2020',
      '--strict=false',
    ],
    { encoding: 'utf8' }
  );
  const ok = result.status === 0;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok, output };
}

// --- Semantic checks beyond JSON Schema (mirrors validateParamSpec) ---

function checkParamSpec(app, entry, issues) {
  const key = entry.key ?? '(missing key)';
  const path = (field) => `${app}/defaultEnv[${key}].${field}`;

  if (entry.type === 'enum') {
    if (!Array.isArray(entry.options) || entry.options.length === 0) {
      issues.push(`${path('options')}: type "enum" requires a non-empty options[] array`);
    }
  }

  if (Array.isArray(entry.options) && entry.options.length > 0 && entry.value) {
    const values = entry.options.map((o) => o.value);
    if (!values.includes(entry.value)) {
      issues.push(
        `${path('value')}: default value "${entry.value}" is not one of options[].value (${values.join(', ')})`
      );
    }
  }

  if (typeof entry.min === 'number' && typeof entry.max === 'number' && entry.min > entry.max) {
    issues.push(`${path('min')}: min (${entry.min}) is greater than max (${entry.max})`);
  }

  if (
    typeof entry.minLength === 'number' &&
    typeof entry.maxLength === 'number' &&
    entry.minLength > entry.maxLength
  ) {
    issues.push(
      `${path('minLength')}: minLength (${entry.minLength}) is greater than maxLength (${entry.maxLength})`
    );
  }

  if (typeof entry.pattern === 'string') {
    try {
      // eslint-disable-next-line no-new
      new RegExp(entry.pattern);
    } catch (err) {
      issues.push(`${path('pattern')}: does not compile as a RegExp (${err.message})`);
    }
  }

  if (entry.generate != null && entry.isSecret !== true) {
    issues.push(`${path('generate')}: "generate" requires "isSecret": true`);
  }

  if (
    entry.trueValue != null &&
    entry.falseValue != null &&
    entry.trueValue === entry.falseValue
  ) {
    issues.push(`${path('trueValue')}: trueValue and falseValue must differ`);
  }

  if (entry.type === 'boolean' && entry.value) {
    const trueValue = entry.trueValue ?? 'true';
    const falseValue = entry.falseValue ?? 'false';
    if (entry.value !== trueValue && entry.value !== falseValue) {
      issues.push(
        `${path('value')}: boolean default "${entry.value}" must equal trueValue ("${trueValue}") or falseValue ("${falseValue}")`
      );
    }
  }
}

/** Whether `service` is declared as a top-level service in the compose file. */
function serviceExists(composeText, service) {
  const escaped = service.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^  ${escaped}:`, 'm').test(composeText);
}

/** Read the app's compose.yaml, or record why it couldn't be read. */
function readCompose(app, manifestPath, field, issues) {
  const composePath = join(dirname(manifestPath), 'compose.yaml');
  if (!existsSync(composePath)) {
    issues.push(`${app}/${field}: compose.yaml not found alongside manifest.json`);
    return undefined;
  }
  return readFileSync(composePath, 'utf8');
}

function checkIngressService(app, manifest, manifestPath, issues) {
  const service = manifest?.ingress?.service;
  if (!service) return; // schema already requires this; avoid double-reporting

  const composeText = readCompose(app, manifestPath, 'ingress.service', issues);
  if (composeText === undefined) return;

  if (!serviceExists(composeText, service)) {
    issues.push(
      `${app}/ingress.service: "${service}" does not name a service in compose.yaml`
    );
  }
}

/**
 * The `backup` block, normalised to a list of participations — the catalog-side
 * twin of `backupParticipations()` in try-hola/hola @hola/shared/contracts.
 *
 * Acceptor participation is plural (spec 004, FR-001/005): an app with two
 * stateful services declares two participations, each with its own `id` and
 * hooks. The singular object stays valid and normalises to one participation
 * named `default`, exactly as the server does it, so no existing bundle has to
 * change.
 *
 * Returns `[{ id, index, preHook, postHook }]`; `index` is the array position
 * (or `undefined` for the singular form) so an error can point at the entry.
 */
function backupParticipations(block) {
  if (block === undefined || block === null) return [];
  if (Array.isArray(block)) {
    return block
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry, index) => ({ id: entry.id, index, preHook: entry.preHook, postHook: entry.postHook }));
  }
  if (typeof block !== 'object') return [];
  return [{ id: 'default', index: undefined, preHook: block.preHook, postHook: block.postHook }];
}

/** `backup` / `backup[2]` — how to name a participation in an error message. */
function participationField(part, suffix) {
  const base = part.index === undefined ? 'backup' : `backup[${part.index}]`;
  return suffix ? `${base}.${suffix}` : base;
}

/**
 * Backup hooks (#121) run via `docker compose exec <service>`, so a hook naming
 * a service that doesn't exist fails at snapshot time — the least convenient
 * moment. Same cross-check `ingress.service` already gets.
 *
 * Also enforces what the JSON Schema can't about the plural form: every
 * participation needs a non-empty `id`, and no two may share one. The server
 * keys hook ordering and reporting on that id, so a duplicate makes two
 * different databases indistinguishable in a failure message.
 */
function checkBackupHooks(app, manifest, manifestPath, issues) {
  const parts = backupParticipations(manifest?.backup);
  if (parts.length === 0) return;

  if (Array.isArray(manifest?.backup)) {
    const seen = new Set();
    for (const part of parts) {
      if (typeof part.id !== 'string' || part.id.trim() === '') {
        issues.push(`${app}/${participationField(part, 'id')}: a plural backup participation needs a non-empty id`);
        continue;
      }
      if (seen.has(part.id)) {
        issues.push(`${app}/${participationField(part, 'id')}: duplicate participation id "${part.id}" — ids identify which database a hook failure was about`);
      }
      seen.add(part.id);
    }
  }

  const hooks = parts.flatMap((part) => [
    [participationField(part, 'preHook.service'), part.preHook?.service],
    [participationField(part, 'postHook.service'), part.postHook?.service],
  ]).filter(([, service]) => typeof service === 'string' && service);
  if (hooks.length === 0) return;

  const composeText = readCompose(app, manifestPath, 'backup', issues);
  if (composeText === undefined) return;

  for (const [field, service] of hooks) {
    if (!serviceExists(composeText, service)) {
      issues.push(`${app}/${field}: "${service}" does not name a service in compose.yaml`);
    }
  }
}

// --- Capability contracts (ADR 0004) ---

/**
 * The contract table, mirroring CONTRACTS in try-hola/hola
 * packages/shared/src/contracts.ts. `schemas/manifest.schema.json` enumerates the
 * same refs; this copy adds what a JSON Schema enum can't express — which block
 * an acceptor's details live in, and whether acceptance means anything without it.
 */
const CONTRACTS = {
  // Acceptance IS the auth block: `accepts: ["auth@1"]` with no mode declared
  // asks Hola to provision nothing, and a manifest carrying an `auth` block is
  // unambiguously participating. auth@1 and push@1 are pre-existing integrations
  // that ADR 0004 §8 re-labelled as contracts without changing their behavior,
  // so their blocks stay self-declaring and the catalog needs no churn.
  'auth@1': { block: 'auth', blockRequired: true, appProvided: false, impliedByBlock: true },
  // backup@1 is the one where the block can't carry the fact. `blockRequired` is
  // deliberately false: a hook-free app (SQLite, flat-file) accepting backup@1
  // with no block is the positive claim "safe to copy as it sits", which has to
  // be distinguishable from an app nobody considered. That third state is why
  // acceptance must be declared here and can't be derived (ADR 0004 §2).
  'backup@1': { block: 'backup', blockRequired: false, appProvided: true, impliedByBlock: false },
  // Same as auth: the declared targets are the participation.
  'push@1': { block: 'push', blockRequired: true, appProvided: false, impliedByBlock: true },
  // The one contract with no acceptor side at all (ADR 0004 §11): a log
  // collector reads from underneath every app via the platform-injected Docker
  // façade, so there is nothing for a subject to opt into or implement. The
  // server drops an `accepts` naming it with a warning; here it is an error, so
  // a manifest saying something meaningless fails CI rather than deploying.
  'container-logs@1': { block: null, blockRequired: false, appProvided: true, impliedByBlock: false, acceptable: false },
};

/** Manifest fields that take a bare string or an array of them. */
function refList(raw) {
  if (typeof raw === 'string') return [raw];
  return Array.isArray(raw) ? raw.filter((r) => typeof r === 'string') : [];
}

/**
 * Images that mean "this service IS a database server" — the case where a
 * file-level copy is crash-consistent at best and hooks are usually wanted.
 * Caches (redis/valkey) are deliberately absent: every app here uses them as
 * rebuildable state, so warning on them would be noise.
 *
 * This is the twin of DATABASE_IMAGE_FAMILIES in try-hola/hola
 * packages/shared/src/contracts.ts, and the two MUST name the same families:
 * this one decides whether an author is warned, that one decides whether the
 * operator's dashboard judges the app's coverage at all. A family only this
 * side knows means a needless warning; a family only that side knows means an
 * app ships with no hooks and no warning. (A family NEITHER side knew is how
 * `pgautoupgrade` — the Postgres image four catalog apps run — ended up
 * rendering as fully quiesced on the dashboard; see try-hola/hola#470.)
 *
 * Matching mirrors `isDatabaseImage`: the last path segment of the image ref,
 * minus tag and digest, matched exactly or as `family-*` / `*-family`, unless
 * the remaining words name a companion role. It used to be a substring regex
 * over the whole `image:` line, which could not tell WHICH service was the
 * database — and per-service is exactly what the plural-participation warning
 * below needs.
 */
const DATABASE_IMAGE_FAMILIES = [
  'postgres', 'postgresql', 'pgautoupgrade', 'pgvector', 'postgis', 'timescaledb',
  'mysql', 'mariadb', 'percona', 'mongo', 'mongodb', 'mssql', 'cockroachdb', 'couchdb',
];

/** Words that make a family name something that TALKS to a database, not one. */
const COMPANION_ROLE_WORDS = new Set([
  'adminer', 'admin', 'agent', 'backup', 'backups', 'cli', 'client', 'dump',
  'exporter', 'express', 'init', 'operator', 'proxy', 'restore', 'ui', 'web',
]);

function namesACompanionRole(remainder) {
  return remainder.split('-').some((word) => COMPANION_ROLE_WORDS.has(word));
}

function isDatabaseImage(imageRef) {
  if (typeof imageRef !== 'string' || imageRef.trim().length === 0) return false;
  const withoutDigest = imageRef.split('@')[0] ?? '';
  const lastSlash = withoutDigest.lastIndexOf('/');
  const afterSlash = lastSlash >= 0 ? withoutDigest.slice(lastSlash + 1) : withoutDigest;
  const segment = (withoutTagOf(afterSlash) ?? '').toLowerCase().trim();
  if (!segment) return false;
  return DATABASE_IMAGE_FAMILIES.some((family) => {
    if (segment === family) return true;
    if (segment.startsWith(`${family}-`)) return !namesACompanionRole(segment.slice(family.length + 1));
    if (segment.endsWith(`-${family}`)) return !namesACompanionRole(segment.slice(0, -(family.length + 1)));
    return false;
  });
}

function withoutTagOf(segment) {
  return segment.split(':')[0];
}

/**
 * Service name -> image, for every top-level service in compose.yaml.
 *
 * Line-based rather than a YAML parse, for the same reason `serviceExists` is:
 * this script has no dependencies beyond the ajv it spawns, and every compose
 * in this catalog is uniformly two-space indented under a single top-level
 * `services:` key. A service whose image is set some other way (build:, an
 * anchor) simply doesn't appear, which costs a warning, never a false one.
 */
function composeServiceImages(composeText) {
  const out = new Map();
  let inServices = false;
  let current;
  for (const line of composeText.split('\n')) {
    if (/^services:\s*$/.test(line)) { inServices = true; continue; }
    if (/^\S/.test(line)) { inServices = false; current = undefined; continue; }
    if (!inServices) continue;
    const service = line.match(/^ {2}([A-Za-z0-9][A-Za-z0-9._-]*):\s*$/);
    if (service) { current = service[1]; continue; }
    if (!current) continue;
    const image = line.match(/^ {4}image:\s*["']?([^"'\s]+)["']?\s*$/);
    if (image) { out.set(current, image[1]); current = undefined; }
  }
  return out;
}

/** Every compose service whose image names a recognised database family. */
function databaseServices(composeText) {
  return [...composeServiceImages(composeText)]
    .filter(([, image]) => isDatabaseImage(image))
    .map(([service]) => service);
}

/**
 * The two halves of a contract have to agree, and neither the JSON Schema nor the
 * server can enforce that here: the server's coercion is deliberately
 * forward-compatible (it drops what it doesn't recognize and reports a block
 * declared without its `accepts`, rather than failing), which is right at runtime
 * and useless as an authoring gate. This is the gate.
 */
function checkContracts(app, manifest, manifestPath, issues, warnings) {
  const accepts = refList(manifest?.accepts);
  const provides = refList(manifest?.provides);

  for (const ref of accepts) {
    const def = CONTRACTS[ref];
    if (!def) {
      issues.push(
        `${app}/accepts: "${ref}" is not a known capability contract (${Object.keys(CONTRACTS).join(', ')})`
      );
      continue;
    }
    if (def.acceptable === false) {
      issues.push(
        `${app}/accepts: "${ref}" has no acceptor side — every install is already a subject by virtue of running, so Hola drops this declaration. Remove it.`
      );
      continue;
    }
    if (def.blockRequired && manifest?.[def.block] === undefined) {
      issues.push(
        `${app}/accepts: "${ref}" requires a "${def.block}" block — accepting it without one declares participation the app can't deliver`
      );
    }
  }

  for (const ref of provides) {
    const def = CONTRACTS[ref];
    if (!def) {
      issues.push(
        `${app}/provides: "${ref}" is not a known capability contract (${Object.keys(CONTRACTS).join(', ')})`
      );
      continue;
    }
    if (!def.appProvided) {
      issues.push(
        `${app}/provides: "${ref}" is provided by the Hola platform itself, not by a catalog app — remove it`
      );
    }
  }

  // A typed block without the declaration, for the contracts where the block
  // can't stand in for it. Reported rather than repaired: inferring acceptance
  // from the block is exactly the derivation ADR 0004 §2 rejects, and opting an
  // app into a contract on its author's behalf is the opposite of what the
  // declaration is for.
  for (const [ref, def] of Object.entries(CONTRACTS)) {
    if (def.impliedByBlock || !def.block) continue;
    if (manifest?.[def.block] !== undefined && !accepts.includes(ref)) {
      issues.push(
        `${app}/accepts: a "${def.block}" block is declared but "${ref}" is missing from accepts[] — the block says HOW the app participates, accepts[] says WHETHER it does`
      );
    }
  }

  // Coverage warnings. Not errors: whether an app is backed up is the bundle
  // author's call to make, and a new app shouldn't be blocked from merging over
  // it. But it should never be an accident, so say so out loud.
  const composePath = join(dirname(manifestPath), 'compose.yaml');
  if (!existsSync(composePath)) return;
  const composeText = readFileSync(composePath, 'utf8');
  const databases = databaseServices(composeText);
  if (databases.length === 0) return;

  if (!accepts.includes('backup@1')) {
    warnings.push(
      `${app}/accepts: runs a database server (${databases.join(', ')}) but accepts nothing — Hola will report it as UNCOVERED. Declare "backup@1" (with hooks) or say why not.`
    );
    return;
  }

  // Per DATABASE SERVICE, not per app. An app-level check passes the moment ONE
  // hook exists, which is how postiz shipped with its second Postgres
  // (temporal-postgres) never quiesced — the one case plural participations
  // exist for. The pre-hook is the quiesce, so that is what has to name it.
  const quiesced = new Set(
    backupParticipations(manifest?.backup)
      .map((part) => part.preHook?.service)
      .filter((service) => typeof service === 'string' && service)
  );
  const unquiesced = databases.filter((service) => !quiesced.has(service));
  if (unquiesced.length === 0) return;

  if (quiesced.size === 0) {
    warnings.push(
      `${app}/backup: accepts "backup@1" and runs a database server (${unquiesced.join(', ')}), but declares no pre-hook for it — the snapshot will copy live database files, which is crash-consistent at best.`
    );
  } else {
    warnings.push(
      `${app}/backup: no participation's preHook names ${unquiesced.map((s) => `"${s}"`).join(', ')} — that database is copied live while the rest of the app is quiesced. Hola renders this app as PARTIALLY covered. Add a participation for it.`
    );
  }
}

/**
 * Push targets (#409). The schema already enforces the shape; these are the
 * semantic rules it can't express — unique ids, a path that stays inside the
 * app's data root, and a postHook naming a real compose service.
 *
 * The server re-checks containment against the real data root (and follows
 * symlinks) before it will push anything, so this is about catching a broken
 * manifest at PR time rather than at push time.
 */
function checkPush(app, manifest, manifestPath, issues) {
  if (!Array.isArray(manifest?.push)) return; // non-array is an ajv failure already

  const seen = new Set();
  let composeText;
  let composeRead = false;

  for (const [i, target] of manifest.push.entries()) {
    if (!target || typeof target !== 'object') continue; // ajv reports the shape
    const at = `${app}/push[${i}]`;

    if (typeof target.id === 'string' && target.id) {
      if (seen.has(target.id)) {
        issues.push(`${at}.id: duplicate push target id "${target.id}"`);
      }
      seen.add(target.id);
    }

    const path = target.path;
    if (typeof path === 'string' && path) {
      if (path.startsWith('/')) {
        issues.push(`${at}.path: "${path}" must be relative to the app data root, not absolute`);
      }
      if (path.split('/').includes('..')) {
        issues.push(`${at}.path: "${path}" must not contain ".." — it would escape the app data root`);
      }
      if (/\s/.test(path)) {
        issues.push(`${at}.path: "${path}" must not contain whitespace`);
      }
    }

    const hookService = target?.postHook?.service;
    if (typeof hookService === 'string' && hookService) {
      if (!composeRead) {
        composeText = readCompose(app, manifestPath, 'push', issues);
        composeRead = true;
      }
      if (composeText !== undefined && !serviceExists(composeText, hookService)) {
        issues.push(`${at}.postHook.service: "${hookService}" does not name a service in compose.yaml`);
      }
    }
  }
}

function validateManifest(manifestPath) {
  const app = appLabel(manifestPath);
  const issues = [];
  const warnings = [];

  const { ok, output } = runAjv(manifestPath);
  if (!ok) {
    issues.push(`${app}: schema validation failed\n${output}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    issues.push(`${app}: failed to parse JSON (${err.message})`);
    return { issues, warnings };
  }

  // `defaultEnv` should be an array; a non-array (e.g. `{}`) is already an ajv
  // failure, so just skip the semantic loop rather than throwing
  // "not iterable" and aborting every remaining manifest in the run.
  if (Array.isArray(manifest.defaultEnv)) {
    for (const entry of manifest.defaultEnv) {
      checkParamSpec(app, entry, issues);
    }
  }

  checkIngressService(app, manifest, manifestPath, issues);
  checkBackupHooks(app, manifest, manifestPath, issues);
  checkPush(app, manifest, manifestPath, issues);
  checkContracts(app, manifest, manifestPath, issues, warnings);

  return { issues, warnings };
}

function main() {
  const args = process.argv.slice(2);
  const manifestPaths = args.length > 0 ? args.map((p) => resolve(process.cwd(), p)) : discoverManifests();

  if (manifestPaths.length === 0) {
    console.error('No manifest.json files found to validate.');
    process.exit(1);
  }

  let hadFailure = false;

  for (const manifestPath of manifestPaths) {
    if (!existsSync(manifestPath)) {
      console.error(`${manifestPath}: file not found`);
      hadFailure = true;
      continue;
    }

    const { issues, warnings } = validateManifest(manifestPath);
    const app = appLabel(manifestPath);

    if (issues.length > 0) {
      hadFailure = true;
      console.error(`FAIL ${app}`);
      for (const issue of issues) {
        console.error(`  - ${issue}`);
      }
    } else {
      console.log(`OK   ${app} (${relative(REPO_ROOT, manifestPath)})`);
    }

    // Warnings never set the exit code — they flag a judgement call the author
    // should confirm, not a broken manifest. Printed after the verdict so they
    // read as advice on it either way.
    for (const warning of warnings) {
      console.error(`WARN ${app}`);
      console.error(`  - ${warning}`);
    }
  }

  // Set the code and let the event loop drain naturally — `process.exit()` can
  // truncate buffered stdout/stderr on a pipe (CI), dropping the tail of the
  // per-app FAIL detail even though the exit code is correct.
  process.exitCode = hadFailure ? 1 : 0;
}

main();
