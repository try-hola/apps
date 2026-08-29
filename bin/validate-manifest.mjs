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
 * Backup hooks (#121) run via `docker compose exec <service>`, so a hook naming
 * a service that doesn't exist fails at snapshot time — the least convenient
 * moment. Same cross-check `ingress.service` already gets.
 */
function checkBackupHooks(app, manifest, manifestPath, issues) {
  const hooks = [
    ['backup.preHook.service', manifest?.backup?.preHook?.service],
    ['backup.postHook.service', manifest?.backup?.postHook?.service],
  ].filter(([, service]) => typeof service === 'string' && service);
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
};

/** Manifest fields that take a bare string or an array of them. */
function refList(raw) {
  if (typeof raw === 'string') return [raw];
  return Array.isArray(raw) ? raw.filter((r) => typeof r === 'string') : [];
}

/**
 * Images that mean "this app runs a database server" — the case where a
 * file-level copy is crash-consistent at best and hooks are usually wanted.
 * Caches (redis/valkey) are deliberately absent: every app here uses them as
 * rebuildable state, so warning on them would be noise.
 */
const DATABASE_IMAGE = /image:\s*\S*(postgres|pgautoupgrade|timescale|mysql|mariadb|percona|mongo|cockroach|mssql|sql-server)/i;

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
    if (def.impliedByBlock) continue;
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
  if (!DATABASE_IMAGE.test(composeText)) return;

  if (!accepts.includes('backup@1')) {
    warnings.push(
      `${app}/accepts: runs a database server but accepts nothing — Hola will report it as UNCOVERED. Declare "backup@1" (with hooks) or say why not.`
    );
  } else if (manifest?.backup === undefined) {
    warnings.push(
      `${app}/backup: accepts "backup@1" and runs a database server, but declares no hooks — the snapshot will copy live database files, which is crash-consistent at best.`
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
