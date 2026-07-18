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

> **Tracking a release candidate.** This package pins
> `ghcr.io/get2knowio/remo-web:2.2.0-rc3`. Bump it to the stable tag/digest once
> remo-web ships a final release. (rc3+ is required — its entrypoint self-heals
> the config-dir ownership, so no chown sidecar is needed.)

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

**1. Get the adoption token.** Hola generates `REMO_WEB_API_TOKEN` at install (it
gates the setup API). Retrieve it with `hola credentials --host <hola-host>`, or
read it from the app's environment in the dashboard.

**2. Adopt.** The public route (`https://remo.<HOLA_BASE_DOMAIN>`) is behind
Authentik **forward-auth**, which the CLI can't complete — so the adoption call
must reach remo-web's port **directly**, bypassing Traefik. Tunnel to the
container on the Hola host (e.g. `remo web adopt --via <hola-host>`, which opens
`ssh -N -L <local>:127.0.0.1:8080 <hola-host>`; adjust to how the container's
`8080` is reachable on your host), then:

```bash
REMO_API_TOKEN=<the token from step 1> remo web adopt <tunnel-url>
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
