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

  const { ok, output } = runAjv(manifestPath);
  if (!ok) {
    issues.push(`${app}: schema validation failed\n${output}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    issues.push(`${app}: failed to parse JSON (${err.message})`);
    return issues;
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

  return issues;
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

    const issues = validateManifest(manifestPath);
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
  }

  // Set the code and let the event loop drain naturally — `process.exit()` can
  // truncate buffered stdout/stderr on a pipe (CI), dropping the tail of the
  // per-app FAIL detail even though the exit code is correct.
  process.exitCode = hadFailure ? 1 : 0;
}

main();
