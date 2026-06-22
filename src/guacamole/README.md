# 🖥️ Apache Guacamole

[Apache Guacamole](https://guacamole.apache.org/) — a **clientless remote
desktop gateway**. It speaks RDP, VNC and SSH and renders them in your browser
over HTML5, so you can reach machines with nothing but a web browser. Packaged
for Hola.

Reachable at `https://guacamole.<HOLA_BASE_DOMAIN>` once installed.

## Layout (Hola app package format)

```
src/guacamole/
├── package.json        # name + version + OCI annotations
└── src/
    ├── compose.yaml    # Traefik-only: prebuilt images, no host ports, bind mounts
    └── manifest.json   # Hola defaults (ingress port, default env, volume, auth)
```

## No host ports / Traefik routing

Hola routes ingress through Traefik — there are **no host ports**; the validator
rejects any `ports:` host publishing. `manifest.ingress.port` (**8080**) is the
container port Traefik forwards to (the Tomcat web app).

By default the Guacamole web app serves under the context path `/guacamole/`.
This package sets **`WEBAPP_CONTEXT=ROOT`** so it serves at `/` instead — that
way Traefik routing the app host **root** (`https://guacamole.<domain>/`) lands
directly on the Guacamole UI with no redirect or sub-path rewriting.

## Stack

This package deploys three long-running containers plus one one-shot init job:

| Service | Image | Role |
| --- | --- | --- |
| `guacd` | `guacamole/guacd:1.6.0` | The proxy daemon that speaks RDP/VNC/SSH (internal `:4822`, no web port) |
| `guacamole` | `guacamole/guacamole:1.6.0` | The Tomcat web app / UI (port 8080) |
| `postgres` | `postgres:16-alpine` | Guacamole's auth + connection database |
| `guacamole-init` | `guacamole/guacamole:1.6.0` | One-shot: generates the DB schema once, then exits |

`guacd` and `guacamole` are pinned to the **same** Guacamole version (1.6.0, the
current stable release).

### Database schema initialization (unattended + idempotent)

Guacamole's PostgreSQL database needs its schema loaded exactly once. This
package does it with **no manual steps** and in a way that's safe to re-deploy:

1. **`guacamole-init`** (one-shot) runs the Guacamole image's
   `/opt/guacamole/bin/initdb.sh --postgresql` to **write** the schema SQL to
   `${HOLA_APP_DATA}/initdb/initdb.sql` — but **only if that file doesn't
   already exist**, so re-deploys never regenerate it.
2. **`postgres`** mounts `${HOLA_APP_DATA}/initdb` at
   `/docker-entrypoint-initdb.d` (read-only). The official `postgres` image runs
   `*.sql` from that directory **only when it first initializes an empty data
   dir** — so on every subsequent boot (the data dir already exists under
   `${HOLA_APP_DATA}/postgres`) the schema files are ignored.
3. `depends_on` ordering guarantees the flow: `guacamole-init` completes →
   `postgres` starts and (on first boot) applies the schema → `postgres` reports
   healthy → `guacamole` starts.

That gives **two independent idempotency guards** (the init script skips an
existing file; Postgres skips init scripts on a non-empty data dir), so the
initialized database is never clobbered on re-deploy.

## Default credentials — change them immediately

Guacamole's database ships with a single default administrator:

| Username | Password |
| --- | --- |
| `guacadmin` | `guacadmin` |

**Log in and change this password (or create a new admin and delete
`guacadmin`) immediately.** This is the account that can add remote-desktop
connections and manage users, so it must not stay on the default credentials.

## Configuration

The install wizard collects:

- **`POSTGRES_PASSWORD`** (required, secret) — the password for Guacamole's
  internal PostgreSQL database. Generate one with `openssl rand -hex 32`. It is
  used by both the database and the web app and is never exposed outside the
  stack.

Remote-desktop connections (RDP/VNC/SSH targets) are added from within
Guacamole's own admin UI after first login — see the
[Guacamole manual](https://guacamole.apache.org/doc/gug/).

## Authentication (forward-auth gate + local admin)

This package uses **`auth.mode: forward-auth`**: Traefik gates the app host
behind Authentik's embedded outpost, so reaching Guacamole requires a valid Hola
SSO session **and** Guacamole's own database login (`guacadmin` / your new
password). You get SSO at the door and Guacamole's native account model behind
it.

### Why forward-auth rather than `native-oidc`?

Guacamole *does* have an OpenID Connect extension, but it doesn't map cleanly to
what Hola injects for `native-oidc`:

- Guacamole OIDC uses the **implicit flow** and **does not use a client secret**;
  the IdP client must be configured as a public/implicit client. Hola's
  `native-oidc` provisioning issues a confidential client (with a secret), which
  is the wrong shape.
- Guacamole requires **discrete endpoints**, including a
  **`OPENID_JWKS_ENDPOINT`**, which Hola does **not** inject (Hola provides
  `issuer`, `authUrl`, `tokenUrl`, `userinfoUrl`, `clientId`, `clientSecret` —
  no JWKS URL). The `oidc.env` name-mapping mechanism therefore can't supply
  everything Guacamole needs.

Given that, forward-auth is the robust, fully-automated choice: SSO is enforced
at the edge with zero per-app OIDC wiring, and Guacamole keeps its own
battle-tested DB auth and fine-grained connection permissions.

### Optional: wire up Guacamole's native OpenID manually

If you'd rather have Guacamole itself do OIDC (so its users map to your IdP
identities), you can add the OpenID extension env vars to the `guacamole`
service and create a **public / implicit** client in Authentik with a JWKS
endpoint. The relevant variables are:

```yaml
OPENID_AUTHORIZATION_ENDPOINT: "https://auth.<domain>/application/o/authorize/"
OPENID_JWKS_ENDPOINT:          "https://auth.<domain>/application/o/guacamole/jwks/"
OPENID_ISSUER:                 "https://auth.<domain>/application/o/guacamole/"
OPENID_CLIENT_ID:              "<your client id>"
OPENID_REDIRECT_URI:           "https://${HOLA_APP_HOST}/"
OPENID_USERNAME_CLAIM_TYPE:    "preferred_username"
OPENID_SCOPE:                  "openid profile email"
```

`OPENID_REDIRECT_URI` must be the app host root (`https://${HOLA_APP_HOST}/`),
matching the `WEBAPP_CONTEXT=ROOT` setting. (Exact endpoint paths depend on your
IdP; the above are Authentik's shape.) If you do this, you may want to drop the
forward-auth gate so users aren't prompted twice.

## Deploy

Once a Hola server is running, deploy this package with the CLI:

```bash
hola bundle deploy -p src/guacamole/src --app-id guacamole --port 8080
```
