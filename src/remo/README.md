# remo

[Remo](https://github.com/get2knowio/remo) — spin up persistent, secure remote
development instances (Dev Containers, long-running AI agents). This package ships
**remo-web**, its browser terminal: one web UI that discovers every Remo-managed
instance and opens a terminal to it over SSH. Packaged for Hola.

Reachable at `https://remo.<HOLA_BASE_DOMAIN>` once installed.

- **Single container** (`remo-web`) — FastAPI backend that also serves the React
  SPA, on port **8080** (a browser terminal broker over WebSockets).
- **No host ports** — Hola routes ingress through Traefik to container port **8080**.
- **One writable data dir, no extra services.** remo-web reaches your instances
  by **SSH** (and AWS SSM where configured). It generates its own service SSH
  identity and stores the registry you push into its config dir (see setup below).

## Authentication

remo-web has **no user system of its own** and is designed for a trusted network.
This package ships `auth.mode: forward-auth`, so Hola gates the route with
Authentik's embedded outpost — **any authenticated Authentik user** may open a
terminal. Because that grants SSH access to every managed instance, restrict who
can log in to your Authentik application, or add an allowed-group restriction (see
below) if you want to narrow it further.

## Post-install setup: adopt the service

This package runs remo-web in **adopted mode** (get2knowio/remo `011-web-adopt`):
nothing is seeded from your workstation. On install it boots **unconfigured**,
generates its own service SSH identity in the config dir, and sits in a healthy
**"awaiting adoption"** state (the browser page shows no instances yet). You then
adopt it from a workstation that has a working `remo` CLI + registry with
[`remo web adopt`](https://github.com/get2knowio/remo), which pushes your registry
and instance host keys into the service and authorizes the service's **own**
public key on each instance — your personal SSH private key never leaves your
workstation. Push later registry changes with `remo web push`.

Adopt it over the normal public URL — no SSH tunnel needed. This package declares
`auth.forwardAuth.bypassPaths: ["/api/v1/setup/"]`, so Hola exempts the adoption
**setup API** from Authentik forward-auth (the rest of the app stays gated). The
setup path is reachable at `https://remo.<HOLA_BASE_DOMAIN>` and is protected by
`REMO_WEB_API_TOKEN`, which the app enforces itself. (Requires Hola with
forward-auth `bypassPaths` — try-hola/hola#356.)

**1. Get the token.** Hola generates `REMO_WEB_API_TOKEN` at install. Reveal and
copy it from the deployment's **Configuration** tab in the dashboard (it's the
"Adoption API Token" secret row), or via `hola` config.

**2. Adopt from a workstation** with a working `remo` CLI + registry:

```bash
REMO_API_TOKEN=<token> remo web adopt https://remo.<HOLA_BASE_DOMAIN>
```

Adoption is a one-time step; after it, open `https://remo.<HOLA_BASE_DOMAIN>` and
sign in through Authentik to use the terminals. If any instance uses AWS SSM,
supply the credentials the way remo expects for those targets.

## Configuration

Set automatically by this package:

- `REMO_WEB_ALLOWED_HOSTS` / `REMO_WEB_ALLOWED_ORIGINS` — pinned to your Hola app
  host (`${HOLA_APP_HOST}`) so the SPA and WebSockets work behind Traefik.

Optional overrides (add to `environment:` if needed): `REMO_WEB_SSH_IDENTITY_FILE`
(non-default key path), and the discovery/terminal tunables (`REMO_WEB_DISCOVERY_*`,
`REMO_WEB_TERMINAL_CAP_*`). Do **not** override `REMO_WEB_FRONTEND_DIST_DIR` — the
SPA is baked into the image.

### Restrict access to a group (optional)

To allow only a named Authentik group, set in `manifest.json`:

```json
"auth": { "mode": "forward-auth", "forwardAuth": { "allowedGroups": ["admins"] } }
```

Hola creates the group empty and it **fails closed** until you add members.

## Deploy

```bash
hola bundle deploy -p src/remo/src --app-id remo --port 8080
```

Or install it from the Hola web catalog once published.
