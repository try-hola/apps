# remo

[Remo](https://github.com/get2knowio/remo) — spin up persistent, secure remote
development instances (Dev Containers, long-running AI agents). This package ships
**remo-web**, its browser terminal: one web UI that discovers every Remo-managed
instance and opens a terminal to it over SSH. Packaged for Hola.

Reachable at `https://remo.<HOLA_BASE_DOMAIN>` once installed.

- **Single container** (`remo-web`) — FastAPI backend that also serves the React
  SPA, on port **8080** (a browser terminal broker over WebSockets).
- **No host ports** — Hola routes ingress through Traefik to container port **8080**.
- **No database or extra services.** remo-web reaches your instances by **SSH**
  (and AWS SSM where configured); it holds no state of its own beyond what you seed.

> **Tracking a release candidate.** This package pins
> `ghcr.io/get2knowio/remo-web:2.2.0-rc1`. Bump it to the stable tag/digest once
> remo-web ships a final release.

## Authentication

remo-web has **no user system of its own** and is designed for a trusted network.
This package ships `auth.mode: forward-auth`, so Hola gates the route with
Authentik's embedded outpost — **any authenticated Authentik user** may open a
terminal. Because that grants SSH access to every managed instance, restrict who
can log in to your Authentik application, or add an allowed-group restriction (see
below) if you want to narrow it further.

## Post-install setup (required)

remo-web needs two things from you, delivered through the app's data dir — Hola
mounts them **read-only** into the container:

| Seed into | Mounted at | What it is |
|---|---|---|
| `<app-data>/config/` | `/home/remo/.config/remo` | Your Remo registry (instance/project discovery data from `remo`). |
| `<app-data>/ssh/` | `/home/remo/.ssh` | An SSH key (e.g. `id_ed25519`), plus optional `config` / `known_hosts`. |

After installing, on the Hola host:

```bash
# <app-data> is this deployment's data root under the Hola data directory.
install -d -o 1000 -g 1000 <app-data>/config <app-data>/ssh

# Registry: copy your ~/.config/remo contents (or run `remo` to generate it).
cp -a ~/.config/remo/. <app-data>/config/

# SSH key remo-web uses to reach instances (must be owned by uid 1000, mode 600).
cp ~/.ssh/id_ed25519 <app-data>/ssh/id_ed25519
chown -R 1000:1000 <app-data>/config <app-data>/ssh
chmod 600 <app-data>/ssh/id_ed25519
```

Then restart the deployment. Until the registry and key are present, remo-web's
startup check fails and the container stays unhealthy (it opens no terminals to
nothing). If any instance uses AWS SSM, also seed `<app-data>/aws/` and mount it —
or bake credentials into the environment your instances expect.

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
