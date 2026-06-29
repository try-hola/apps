# 🛩️ Hangar

[Hangar](https://github.com/get2knowio/hangar) — a self-hosted, single-operator
**fleet control plane** for your git repositories. It aggregates the repos across one
or more provider connections (GitHub today, Gitea designed-for) into one dashboard,
scores each repo against a declarative best-practice **policy**, and lets you remediate
hygiene drift in place — every content change delivered as a **pull request, never a
push**. Packaged for Hola.

Reachable at `https://hangar.<HOLA_BASE_DOMAIN>` once installed.

## Stack

- **Single container** (`hangar`) — Python 3.12 + FastAPI backend that also serves the
  built React SPA, on port **8000**. State is SQLite in the `data` volume (`/data`).
- **No host ports** — Hola routes ingress through Traefik to container port **8000**.
- A tiny one-shot `hangar-init` chowns the bind-mounted `/data` to Hangar's non-root
  user (uid 10001) before the app starts, so it can create the SQLite database.

## Authentication

Hangar has **no user system of its own** — it is *fail-closed* and designed to sit
behind a forward-auth reverse proxy. This package ships `auth.mode: forward-auth`, so
Hola gates the route with Authentik's embedded outpost and forwards the authenticated
identity (`X-authentik-username`) to Hangar, which records it as the operator in its
audit log. No per-app OIDC client is provisioned and Hangar never sees a password.

## Configuration

The install wizard collects:

- **`HANGAR_SECRET_KEY`** (required, secret) — a [Fernet](https://cryptography.io/en/latest/fernet/)
  key used to encrypt provider credentials (GitHub App private key, webhook secrets,
  tokens) at rest. Hangar boots without it, but you must set it before connecting a
  provider. Generate one with:

  ```bash
  python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
  ```

Everything else uses safe defaults (SQLite persistence, a 5-minute poll interval). After
install, connect a provider from Hangar's *Providers* screen to start watching real
repositories; until then the dashboard is empty. As of upstream **0.3.0** you can use the
one-click **"Connect with GitHub"** flow (this package sets `HANGAR_BASE_URL` to your
Hola URL so the GitHub App callbacks resolve correctly), pick a per-connection host for
**GitHub Enterprise Server / GHEC**, or paste GitHub App credentials manually. To explore
with sample data instead, you can set `HANGAR_SEED_DEMO_DATA=true`.

### Postgres (optional)

Hangar defaults to SQLite, which is plenty for a single-operator homelab. To run against
an external Postgres instead, set the discrete `HANGAR_POSTGRES_*` environment variables
(`HANGAR_POSTGRES_HOST` switches Hangar to Postgres and takes precedence over the SQLite
default).

## Deploy

```bash
hola bundle deploy -p src/hangar/src --app-id hangar --port 8000
```

Or install it from the Hola web catalog once published.
