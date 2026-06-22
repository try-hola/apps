# immich

[Immich](https://immich.app) — a high-performance, self-hosted photo and video
management solution (a self-hosted alternative to Google Photos, with mobile apps,
automatic backup from your phone, facial recognition, and smart search) — packaged
for Hola.

## Layout (Hola app package format)

```
src/immich/
├── package.json        # name + version + OCI annotations
├── README.md
└── src/
    ├── compose.yaml    # Traefik-only: pinned images, no host ports, bind mounts
    └── manifest.json   # Hola defaults (ingress port, default env, volumes, auth)
```

- **No host ports** — Hola routes ingress through Traefik. `manifest.ingress.port`
  (**2283**) is the container port Traefik forwards to (Immich's web UI + API on
  the `immich-server` service); the validator rejects any `ports:` host publishing.
- **Pinned images** — every container pins a specific tag (the four runtime
  services on Immich release `v2.7.5`, plus the `immich-oidc-init` SSO sidecar on
  `mikefarah/yq:4.44.6`); the Postgres and Valkey images are pinned by digest
  exactly as Immich ships them. No `latest`.
- **Persistence** is bind-mounted under `${HOLA_APP_DATA}` (no top-level named
  volumes).

## Datastores

Immich is a multi-container stack:

- **`immich-server`** — the web UI + API (the ingress service, port 2283). The
  photo/video library lives in `${HOLA_APP_DATA}/library` (`/data`).
- **`immich-machine-learning`** — facial recognition and smart-search inference;
  its model cache lives in `${HOLA_APP_DATA}/model-cache`.
- **`immich-postgres`** — Postgres with the vector extension (VectorChord +
  pgvecto.rs) that Immich requires for smart search. Data in
  `${HOLA_APP_DATA}/postgres`.
- **`immich-redis`** — a Valkey (Redis-compatible) cache/queue, data in
  `${HOLA_APP_DATA}/redis`.

## Required configuration

| Env | Required | Notes |
| --- | --- | --- |
| `DB_PASSWORD` | yes (secret) | Password for the internal Postgres database. Generate one, e.g. `openssl rand -hex 32` (alphanumeric only). |

Everything else (DB host/user/name, Redis host) is wired internally in
`compose.yaml` and needs no input.

## Authentication (SSO via Immich's native OIDC — automatic)

This package uses `auth: { "mode": "native-oidc", … }`. When you deploy on a Hola
server with SSO enabled (Authentik, the default), Hola **provisions Immich's OAuth
client automatically and wires it in** — no clicking through the admin UI:

- Hola creates an Authentik OAuth2 application for Immich and registers all three
  redirect URIs Immich needs: the web login (`/auth/login`), web account-linking
  (`/user-settings`), and the **mobile** callback (`app.immich:///oauth-callback`).
  So SSO works in the **web app and the mobile apps** alike.
- Because Immich reads OAuth **only from a config file** (it has no OAuth env vars,
  and the admin UI is read-only while a config file is present), the wiring is a
  two-step, bundle-owned render: Hola drops the provisioned creds as a generic
  `${HOLA_APP_DATA}/oidc.json` (`auth.oidc.credentialsFile`), and the
  **`immich-oidc-init` sidecar** in this package renders them into
  `${HOLA_APP_DATA}/config/immich.json` **before `immich-server` starts**
  (`depends_on: service_completed_successfully`). Hola also injects
  `IMMICH_CONFIG_FILE` (via `auth.oidc.staticEnv`) only when SSO is provisioned.
  A **"Login with Authentik"** button then appears on the Immich sign-in page, and
  first-time SSO users are auto-registered. Keeping the Immich-specific config
  format in a bundle sidecar (not in Hola) follows the same pattern as Homepage's
  registry renderer (ADR 0002).
- This is **native OIDC, not a reverse-proxy forward-auth gate** — deliberately. A
  proxy auth gate would block Immich's mobile apps, public API, and external
  sharing. Native OIDC keeps all of those working (Immich issues its own
  session/API tokens after the OIDC login) and is the upstream-recommended SSO
  approach.

> **First admin.** The Immich admin is the *first* account on the instance, created
> via the normal email/password signup (OAuth auto-registers regular users). After
> deploy, open Immich once and create the admin account, then everyone else signs
> in with the **Login with Authentik** button. Promoting an SSO user to admin by
> group claim (`roleClaim`) is a planned enhancement.

### Without an SSO backend

If Hola is running with no auth backend, the OAuth client isn't provisioned: the
config file is never written and `IMMICH_CONFIG_FILE` stays unset, so Immich simply
falls back to its own email/password login with a fully editable settings UI. To
wire OIDC by hand in that case, see the upstream
[OAuth docs](https://docs.immich.app/administration/oauth/).

## Deploy

Once a Hola server is running, deploy this package with the CLI:

```bash
hola bundle deploy -p src/immich/src --app-id immich --port 2283
```

Or install it from the Hola web catalog once published.
