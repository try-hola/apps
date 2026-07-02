# paperless-ngx

[Paperless-ngx](https://docs.paperless-ngx.com/) — a community-supported,
self-hosted document management system that scans, OCRs, indexes, and archives
your paper documents — packaged for Hola.

## Layout (Hola app package format)

```
src/paperless-ngx/
├── package.json        # name + version + OCI annotations
├── README.md
└── src/
    ├── compose.yaml    # Traefik-only: pinned images, no host ports, bind mounts
    └── manifest.json   # Hola defaults (ingress port, default env, volumes, auth)
```

## Stack

Three containers:

- **webserver** — `ghcr.io/paperless-ngx/paperless-ngx:2.20.4`, the web UI and
  background workers. Listens on container port **8000**.
- **db** — `postgres:16-alpine`, document metadata and the search index state.
- **broker** — `redis:7.4-alpine`, the task queue used for consumption/OCR jobs.

### No host ports — Traefik only

Hola routes ingress through Traefik. `manifest.ingress.port` (**8000**) is the
container port Traefik forwards to; the validator rejects any `ports:` host
publishing. The internal Postgres/Redis services are reachable only on the
compose network.

### Persistence

All state is bind-mounted under `${HOLA_APP_DATA}` (no top-level named volumes):

| Host path                  | Container path                  | Purpose                          |
| -------------------------- | ------------------------------- | -------------------------------- |
| `${HOLA_APP_DATA}/data`    | `/usr/src/paperless/data`       | index, classifier model, etc.    |
| `${HOLA_APP_DATA}/media`   | `/usr/src/paperless/media`      | original + archived documents    |
| `${HOLA_APP_DATA}/export`  | `/usr/src/paperless/export`     | `document_exporter` output       |
| `${HOLA_APP_DATA}/consume` | `/usr/src/paperless/consume`    | drop folder — files placed here are ingested |
| `${HOLA_APP_DATA}/pgdata`  | `/var/lib/postgresql/data`      | PostgreSQL data                  |
| `${HOLA_APP_DATA}/redis`   | `/data`                         | Redis persistence                |

## Required configuration

- **`PAPERLESS_SECRET_KEY`** (secret) — a unique per-install signing key. Generate
  one with `openssl rand -hex 32`. Paperless will not start securely without it.
- Database credentials are fixed internal defaults (`paperless`/`paperless` on the
  private compose network); they are never exposed to the host.

`PAPERLESS_URL` is set to `https://${HOLA_APP_HOST}` automatically from the public
hostname Hola injects, so `ALLOWED_HOSTS` / `CSRF_TRUSTED_ORIGINS` are correct
behind the proxy.

## Authentication (SSO via forward-auth + trusted header)

This package uses Hola's Traefik **`forward-auth`** gate (`manifest.auth.mode`),
so every request to paperless first passes through Authentik's embedded outpost.
Unauthenticated users are bounced to the Authentik login before they ever reach
the app.

On top of the gate, the package wires **trusted-header (remote user) auth** so
paperless logs you in as the SSO user automatically — no second login:

- `PAPERLESS_ENABLE_HTTP_REMOTE_USER=true` — trust the authenticated username from
  a request header.
- `PAPERLESS_HTTP_REMOTE_USER_HEADER_NAME=HTTP_X_AUTHENTIK_USERNAME` — Authentik's
  outpost sets the `X-authentik-username` header; Django exposes incoming headers
  as `HTTP_<UPPER_SNAKE>`, so the value paperless reads is `HTTP_X_AUTHENTIK_USERNAME`.
- `PAPERLESS_LOGOUT_REDIRECT_URL` points at Authentik's `/outpost.goauthentik.io/sign_out`
  so logging out of paperless also clears the SSO session (otherwise the gate would
  immediately log you back in).

> **Security note.** Trusted-header auth is only safe behind a reverse proxy that
> sets/overwrites the header — which is exactly the Hola + Traefik forward-auth
> setup. Never expose paperless directly to the internet with this enabled, or a
> client could forge the header and bypass authentication.

First SSO login auto-provisions the paperless user, but a brand-new account is a
**regular user**, not staff/superuser. To grant admin rights:

### Getting an initial admin

A fallback local superuser is created on first start from `PAPERLESS_ADMIN_USER` /
`PAPERLESS_ADMIN_PASSWORD` (set them in the install wizard). Its email is stamped
automatically from the installing dashboard user (Hola's `${HOLA_USER_EMAIL}` token)
when you install while SSO-logged-in — handy for notifications; login itself is via
forward-auth by username, so the email is cosmetic. Log in with that account via
Django admin (`/admin/`) to promote your SSO user to staff/superuser.

If you leave `PAPERLESS_ADMIN_PASSWORD` blank, no superuser is auto-created —
create one manually on the Hola host instead:

```bash
docker exec -it <paperless-webserver-container> \
  python3 manage.py createsuperuser
```

Then promote your SSO-provisioned user from the Django admin, or
`python3 manage.py manage_superuser` / the user-edit screen.

## Deploy

Once a Hola server is running, deploy this package with the CLI:

```bash
hola bundle deploy -p src/paperless-ngx/src --app-id paperless-ngx --port 8000
```
