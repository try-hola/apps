# mealie

[Mealie](https://mealie.io) ([source](https://github.com/mealie-recipes/mealie)) —
a self-hosted recipe manager and meal planner with a REST API backend and a
reactive Vue frontend — packaged for Hola.

## Layout (Hola app package format)

```
src/mealie/
├── package.json        # name + version + OCI annotations
└── src/
    ├── compose.yaml    # Traefik-only: prebuilt images, no host ports, bind mounts
    └── manifest.json   # Hola defaults (ingress port, default env, volumes, auth)
```

- **No host ports** — Hola routes ingress through Traefik. `manifest.ingress.port`
  (9000) is the container port Traefik forwards to; the validator rejects any
  `ports:` host publishing. The web UI port is documented with `expose:`.
- **Pinned images** — `ghcr.io/mealie-recipes/mealie:v3.19.2` (latest stable at
  packaging time) and `postgres:17-alpine`.
- **Persistence** — bind-mounted under `${HOLA_APP_DATA}`: Mealie's `/app/data`
  (recipes, images, backups) and the Postgres data dir.

## Datastore: PostgreSQL

This package runs **PostgreSQL** (`postgres:17-alpine`), the upstream-recommended
database for production installs, rather than the single-container SQLite option.
The DB password is collected by the Hola install wizard
(`manifest.defaultEnv` → `POSTGRES_PASSWORD`); the user/database name are both
`mealie`, and the server is reached at the internal hostname `mealie-postgres`.
Mealie waits on a Postgres healthcheck via `depends_on: condition: service_healthy`.

### Required env

| Variable | Source | Purpose |
|----------|--------|---------|
| `BASE_URL` | Hola (`https://${HOLA_APP_HOST}`) | Public URL Mealie generates links against |
| `POSTGRES_PASSWORD` | install wizard (secret) | Mealie DB password (shared by both services) |

Mealie does not require a separate session/signing secret in env — it manages its
own `.secret` under `/app/data`, which persists across restarts via the bind mount.

## Authentication (native OIDC / Authentik)

This package provisions OIDC via `manifest.auth` (`mode: native-oidc`, env style —
like Postiz, not the CLI setup-command style of Gitea). At deploy time Hola
provisions an Authentik OIDC client and injects the credentials as env vars, which
the compose maps onto Mealie's `OIDC_*` variables:

- `OIDC_AUTH_ENABLED=true` — turns on the "Login with Authentik" button.
- `OIDC_CONFIGURATION_URL` — Mealie wants the provider's **discovery** URL. Hola
  injects the base `issuer` as `${OIDC_ISSUER_URL}`, and the compose builds
  `${OIDC_ISSUER_URL}.well-known/openid-configuration` from it (Authentik issuer
  URLs end with a trailing slash).
- `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` — provisioned by Hola.
- `OIDC_PROVIDER_NAME=Authentik` — label on the sign-in button.
- `OIDC_SIGNUP_ENABLED=true` — first OIDC login auto-creates the Mealie user.
- `OIDC_ADMIN_GROUP=hola-admins` + `OIDC_GROUPS_CLAIM=groups` — members of Hola's
  `hola-admins` group become Mealie admins (re-evaluated on each SSO login). Hola
  seeds your superuser(s) into `hola-admins`, so your first SSO login lands you as
  an admin with no extra steps. The same group governs Hola dashboard admin, so
  admin is consistent across the platform.
- `OIDC_AUTO_REDIRECT=false` — keeps the login page visible (so local admin login
  remains reachable) rather than bouncing straight to Authentik.
- `OIDC_REMEMBER_ME=true` — allows extended SSO sessions.

Scopes requested: `openid profile email` (plus the groups claim).

> The exact `OIDC_*` variable names were verified against Mealie's
> [OIDC docs](https://docs.mealie.io/documentation/getting-started/authentication/oidc/)
> and [Backend Configuration](https://docs.mealie.io/documentation/getting-started/installation/backend-config/).
> `OIDC_CONFIGURATION_URL` expects the full `.well-known/openid-configuration` path.

### First admin / emergency access

Mealie creates a default local admin (`changeme@example.com` / `MyPassword`) on
first boot — change or disable it after your SSO admin works. Local login stays
available (auto-redirect is off), so you retain a non-SSO path if OIDC is
misconfigured.

## Deploy

Once a Hola server is running, deploy this package with the CLI:

```bash
hola bundle deploy -p src/mealie/src --app-id mealie --port 9000
```
