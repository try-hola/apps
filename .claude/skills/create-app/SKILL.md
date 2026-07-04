---
name: create-app
description: >-
  Add a new app to the Hola catalog, or edit an existing app's compose.yaml /
  manifest.json. Use when asked to package a new self-hosted app for Hola,
  add typed install-wizard fields to an app's defaultEnv, wire up SSO
  (native-oidc/forward-auth/native-ldap), or add upgrade/backup metadata.
  Covers the full authoring loop: scaffold, compose rules, the typed
  manifest schema, validation, and publishing.
---

# Creating / editing a Hola catalog app

Hola apps are Docker Compose stacks published from this repo as OCI loose-layer
packages. This skill is the authoring reference — read `README.md` for the
canonical field docs; this skill condenses it into a task-oriented workflow
and centers on the typed `defaultEnv` schema, which is the part with the most
tribal knowledge.

## 1. When to use this

- Packaging a brand-new app for the catalog.
- Editing an existing app's `compose.yaml` or `manifest.json` (new env var,
  SSO wiring, upgrade/backup metadata).
- Turning a plain-string `defaultEnv` entry into a typed one so the install
  wizard renders a proper control (checkbox, dropdown, number input, etc.)
  instead of a text box.

## 2. Scaffold

```bash
./bin/create-package.sh <name>
```

Creates `src/<name>/{package.json,src/compose.yaml,src/manifest.json,README.md}`
in the loose-layer format the server expects (`compose.yaml` + `manifest.json`
at the bundle root — no tarball). Edit from there; nothing else needs
touching to register the package (CI publishes on merge, see §8).

**The scaffolded `compose.yaml` uses a named volume as a placeholder — you
must change it to a bind mount under `${HOLA_APP_DATA}` (see below) before
this passes real review.** It's left as a minimal placeholder rather than a
fully-compliant example so the scaffold has zero moving parts to get wrong.

## 3. Compose rules

`@hola/shared/compose-validate` rejects a package that violates these (CI runs
it at deploy time via the server, not directly in this repo's CI, but a
violation means the app will never actually run — check yourself):

- **Prebuilt image, pinned immutably.** Either a digest pin
  (`image: foo/bar:1.2.3@sha256:...`) or an explicit non-mutable tag (no
  `latest`, `stable`, `edge`, `main`, `rc`, etc. — those are rejected even
  without a digest). Digest pins are preferred; Renovate (`renovate.json`)
  watches them and opens a PR when upstream publishes a new tag — you still
  bump the **Hola bundle version** yourself (see §7) and review before
  merging Renovate's PR.
- **No host ports, ever.** No `ports:` on any service — ingress is
  Traefik-only, via `manifest.json`'s `ingress.service`/`ingress.port`. Use
  `expose:` if you need to document a port for readability.
- **No `network_mode: host`.** Same reasoning as host ports — it defeats the
  no-host-ports rule entirely.
- **Persistent storage must be a bind mount under `${HOLA_APP_DATA}`**, e.g.
  `${HOLA_APP_DATA}/data:/data`. Named Docker volumes are rejected outright —
  Hola's backup/restore and the `apps-data` cross-app primitive both operate
  on the app's data root on the host, so state has to live there, not in a
  Docker-managed volume. `type: tmpfs` is exempt (it's not persistent).
- **Platform tokens** are substituted in compose YAML *content* (not in
  `.env` values, other than `HOLA_USER_EMAIL`): `${HOLA_APP_HOST}` (this
  app's public hostname, `<app>.<base-domain>`), `${HOLA_BASE_DOMAIN}`, and
  `${HOLA_APP_DATA}` (this app's data root). An unrecognized `${HOLA_*}` token
  is flagged as a likely typo.

## 4. `manifest.json` reference

Full field table is in `README.md`; the parts most authors get wrong are the
typed `defaultEnv[]` entries, which are the centerpiece of this section.

### 4.1 Top-level shape

`name`, `version`, `title`, `description` are required; `icon` (emoji or
icon URL), `category`, `tags[]` are optional. `ingress.service` (**must** name
a real `compose.yaml` service — required whenever the web-facing service
isn't named after the app id or isn't listed first) and `ingress.port` are
required. See `schemas/manifest.schema.json` for the exact, enforced shape —
CI rejects anything it doesn't recognize (see §5).

### 4.2 `defaultEnv[]` — typed parameters

Each entry is one env var surfaced in the install wizard. `key`, `value`,
`isSecret` are required; everything else is optional and purely additive —
an entry with only those three fields still works exactly as before (renders
as a plain text/secret box).

| Field | Type | Applies to | Meaning |
|---|---|---|---|
| `key` | string | all | Env var name. |
| `value` | string | all | Default value (empty string for "no sensible default"). |
| `isSecret` | boolean | all | Masked in the UI, orthogonal to `type` — a secret can be any type (usually `string`). |
| `description` | string | all | Help text shown under the field. |
| `label` | string | all | Display name; falls back to `key` if absent. |
| `type` | enum | all | One of `string`, `integer`, `port`, `boolean`, `enum`, `url`, `email`, `timezone`. Omitted = plain string. |
| `required` | boolean (tri-state) | all | See §4.3. |
| `advanced` | boolean | all | Collapses the field under an "Advanced" section instead of the main form. |
| `placeholder` | string | all | Input placeholder text. |
| `pattern` | string | `string` | Regex the value must match. |
| `minLength` / `maxLength` | integer | `string` | Length bounds. |
| `min` / `max` | integer | `integer`, `port` | Value bounds (`port` implies 1–65535 unless narrowed). |
| `options[]` | `{value, label?, description?}[]` | `enum` | Required, non-empty, for `enum` type. `value` is what gets written to the env var. |
| `trueValue` / `falseValue` | string | `boolean` | What gets written for on/off (default `"true"`/`"false"`). Must differ from each other. |
| `httpsOnly` | boolean | `url` | Rejects `http://` defaults/input. |
| `generate` | `{kind, length?}` | any, only meaningful when `isSecret: true` | Secret-generation recipe — see §4.4. |

### 4.3 The `required` tri-state (back-compat critical)

- `true` — empty value is a hard error, always.
- `false` — empty value is fine, **even for a secret**. This is the
  back-compat-breaking fix for the old behavior where any empty secret
  blocked install; use this for genuinely optional secrets (e.g. an admin
  password you can set later via the app's own CLI).
- **absent (the default)** — legacy rule: `isSecret` implies required. Only
  set `required` explicitly when you need to *diverge* from that (i.e. set
  `required: false` on an optional secret, or `required: true` on a
  non-secret that must not be empty).

### 4.4 `generate` recipes

Only meaningful when `isSecret: true`. `length` is in bytes (default 32).

- **`hex`** — arbitrary secret tokens, output length is `2 * length` hex
  chars. Use when upstream just wants "a long random string" — e.g. Gitea's
  runner registration token, which upstream refuses to accept below 32
  characters (pair with `minLength: 32`).
- **`base64`** — general-purpose secrets (session/signing keys) where a
  compact, mixed-case token is idiomatic — e.g. a JWT signing secret.
- **`fernet`** — exactly 32 raw bytes, base64url-encoded, for apps that
  specifically need a [Fernet](https://cryptography.io/en/latest/fernet/)
  key (Python `cryptography` library's symmetric encryption format) — e.g. an
  app that encrypts credentials at rest with Fernet. Don't use this unless
  upstream's docs say "Fernet key" specifically; for everything else, prefer
  `hex` or `base64`.

### 4.5 Worked examples

```jsonc
// URL field, HTTPS-only, required (e.g. a public callback URL)
{
  "key": "APP_PUBLIC_URL",
  "value": "https://${HOLA_APP_HOST}",
  "isSecret": false,
  "type": "url",
  "httpsOnly": true,
  "required": true,
  "label": "Public URL",
  "description": "Must be reachable over HTTPS — used to build OAuth redirect URIs."
}
```

```jsonc
// Boolean with custom on/off values (some apps don't use literal "true"/"false")
{
  "key": "DISABLE_REGISTRATION",
  "value": "no",
  "isSecret": false,
  "type": "boolean",
  "trueValue": "yes",
  "falseValue": "no",
  "advanced": true,
  "description": "Block further sign-ups once your account exists."
}
```

```jsonc
// Enum (radio group if <=4 options, dropdown otherwise)
{
  "key": "LOG_LEVEL",
  "value": "info",
  "isSecret": false,
  "type": "enum",
  "advanced": true,
  "options": [
    { "value": "error" },
    { "value": "warn" },
    { "value": "info", "label": "Info (default)" },
    { "value": "debug" }
  ]
}
```

```jsonc
// Generated secret with a minimum length upstream enforces (Gitea-style)
{
  "key": "APP_RUNNER_TOKEN",
  "value": "",
  "isSecret": true,
  "required": true,
  "minLength": 32,
  "generate": { "kind": "hex", "length": 32 },
  "description": "Shared secret for the bundled worker to self-register. MUST be at least 32 characters."
}
```

```jsonc
// Fernet key (Hangar-style — a Python cryptography.Fernet key)
{
  "key": "APP_SECRET_KEY",
  "value": "",
  "isSecret": true,
  "required": true,
  "generate": { "kind": "fernet" },
  "description": "Fernet key that signs sessions and encrypts credentials at rest."
}
```

## 5. Validate before opening a PR

```bash
node bin/validate-manifest.mjs src/<name>/src/manifest.json   # one app
node bin/validate-manifest.mjs                                # every app
```

This runs `schemas/manifest.schema.json` (structural checks — unknown fields,
wrong types, typos; **the same schema CI enforces**) plus semantic checks a
JSON Schema can't express: `enum` default must be one of `options[].value`,
`min`/`minLength` <= `max`/`maxLength`, `pattern` must compile, `generate`
requires `isSecret: true`, boolean `trueValue`/`falseValue` must differ and
the default must match one of them, and `ingress.service` must name a real
`compose.yaml` service. Treat both files as the source of truth over this
skill if they ever disagree.

## 6. Auth-mode decision tree

Set `manifest.json`'s `auth.mode`; the server provisions Authentik
accordingly at deploy time. Look at a couple of real manifests for the exact
shape before writing your own (`src/gitea/src/manifest.json` and
`src/mealie/src/manifest.json` for `native-oidc`, `src/paperless-ngx/src/manifest.json`
or `src/homepage/src/manifest.json` for `forward-auth`).

- **`native-oidc`** — the app has its own OIDC/OAuth2 client support (env vars,
  a config file, or a CLI/admin command to register a provider). Prefer this
  whenever upstream supports it: users get a native login experience, and
  mobile/API clients that can't follow a proxy redirect (Immich's mobile app)
  keep working. Needs at least one of `oidc.env` (env-var names Hola injects
  issuer/clientId/clientSecret into), `oidc.setup` (a post-deploy CLI command,
  for apps that only accept OAuth config via CLI/DB — see Gitea's
  `admin auth add-oauth`), or `oidc.credentialsFile` (apps that read OAuth
  config from a file Hola writes, e.g. Immich).
- **`forward-auth`** — the app has no OIDC support at all, so Hola gates it
  behind Traefik + Authentik's outpost (login happens before the app ever
  sees the request). Simplest to wire (just `{"mode": "forward-auth"}`, no
  sub-block required) but every request pays a proxy hop and it doesn't work
  for API/mobile clients that need to authenticate directly. Use this as the
  fallback when `native-oidc` isn't feasible.
- **`native-ldap`** — the app only supports LDAP/LDAP-bind auth (no OIDC, and
  a proxy gate would be wrong because the app itself needs to look up
  users/groups). Hola provisions a per-app LDAP bind account against
  Authentik's LDAP outpost; declare `auth.ldap.env` naming the env vars for
  `host`, `port`, `bindDn`, `bindPassword`, `baseDn` (all required — the
  block is dropped entirely if any is missing).
- **`none`** — no SSO integration (app handles its own users, or SSO isn't
  supported/desired). This is also what you get by omitting `auth` entirely.
- Any mode can add a sibling `"fallback": "forward-auth"` to *also* gate the
  app behind a proxy login in front of its native auth — rarely needed.

## 7. `upgrade` / `backup` blocks

Both are optional and documented in full in `README.md` — condensed here:

- **`upgrade`** (declare on the version being upgraded *to*): `breaking`
  (operator must confirm before promoting), `minFromVersion` (server-enforced
  floor — promoting from below it is rejected), `waypoints[]`
  (server-enforced — must promote through these one at a time, no skipping),
  `upgradeNotesUrl` (shown in the promote dialog), `preUpgradeBackup`
  (`"required"` fails the upgrade if a pre-upgrade snapshot can't be taken;
  `"recommended"`/`"none"` are advisory only). Only set `minFromVersion` /
  `waypoints` when upstream genuinely requires it.
- **`backup`**: `preHook`/`postHook`, each `{service, command}` (exec-form
  argv against a real compose service, run via `docker compose exec`) — for
  apps with a live SQL database that need a `pg_dump`-style quiesce before a
  file-level snapshot (which is crash-consistent, not transaction-consistent).
  The dump **must** land under a path bind-mounted from `${HOLA_APP_DATA}`
  (the snapshot only sees the app's data root) using the *container-side*
  path. `postHook` always runs (even after a failed capture) to clean up; a
  `preHook` failure is fail-closed only when `upgrade.preUpgradeBackup` is
  `"required"`.

## 8. Verify → publish

1. `node bin/validate-manifest.mjs src/<name>/src/manifest.json` (§5).
2. `./bin/build-catalog.sh` — regenerates `catalog.json` locally so you can
   eyeball the entry; CI regenerates it for real on merge to `main`, so you
   don't need to commit your local regeneration.
3. Open a PR (branch + PR, don't push to `main` — this repo squash-merges).
   CI's `verify-packages` job re-runs the layout + manifest-schema checks on
   your changed package(s).
4. On merge, CI publishes `ghcr.io/try-hola/<name>:<version>` (+ `:latest`)
   automatically. Manual/out-of-band publish (rare — e.g. re-publishing an
   unchanged version): `./bin/push-oci-package.sh <name> ghcr.io/try-hola apps`
   (needs `oras login ghcr.io`; newly published GHCR packages default to
   **private** — flip visibility to public once in package settings or the
   Hola server can't pull it without credentials).
5. Bump `version` in both `package.json` and `manifest.json` for *any* change
   that reaches a deployed app (env, compose, auth) — Hola's version
   describes impact on the Hola user, not upstream's version number.
