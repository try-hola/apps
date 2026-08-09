# running-man

[Running Man](https://github.com/get2knowio/running-man) — provision and manage
pools of self-hosted GitHub Actions runners from a web UI — packaged for Hola.

## Layout (Hola app package format)

```
src/running-man/
├── package.json        # name + version + OCI annotations
└── src/
    ├── compose.yaml    # running-man + a Docker-in-Docker sidecar
    └── manifest.json   # Hola defaults (ingress port, default env, auth)
```

- **No host ports** — Traefik routes to `manifest.ingress.port` (3000); the
  validator rejects any `ports:` host publishing.
- **`GITHUB_TOKEN`** is the only required setting: a PAT with `manage_runners:org`
  (org pools) or repo admin rights (repo pools). It also gates the app's own
  forward-auth support (see below) — without it, requests get no session at all.
- **SQLite** keeps pool definitions in `${HOLA_APP_DATA}/data`, a single
  container, no external DB dependency.

## Docker access — why there's a second service

running-man's entire job is spawning containers (GitHub Actions runners) via
the Docker API. Upstream does that by mounting the **host's**
`/var/run/docker.sock` — but Hola's compose validator rejects any bind mount
outside `${HOLA_APP_DATA}`, including that one (the same wall Gitea's Actions
runner hit; see `src/gitea/README.md`).

The fix is the same: a **Docker-in-Docker** sidecar, `running-man-dind`
(`privileged: true`), running its own isolated `dockerd`. running-man's
`DOCKER_SOCKET` env var — upstream's own override for where it looks for the
*default/local* Docker host (`src/docker/client.ts`) — points at that sidecar
instead of a host socket, so pools created without an explicit remote Docker
host land there transparently, no extra UI configuration needed.

**What this means in practice:** runner containers this app provisions run
inside the sidecar's isolated engine, not the real host's. They still register
with GitHub and execute real jobs — they just don't share state (images,
volumes, other containers) with the Hola host's own Docker.

**Remote Docker hosts still work as designed.** running-man natively supports
pointing an individual pool at `tcp://host:port` (optionally with mutual TLS) —
that's unaffected by any of this; use it to target actual home-lab machines
when you want runners with host-level access on hardware you control.

> **Trust note.** `privileged: true` is a meaningful grant — code that escapes
> the sidecar's dockerd can reach the host. Treat every pool like any CI
> executor: only run workflows you trust. This is still more isolated than the
> host-socket pattern upstream ships by default, which would hand every runner
> full control of the Hola host's own Docker.

## Authentication

`auth.mode: forward-auth` — running-man's own forward-auth support (built for
"a home lab proxy like Authelia, Authentik, oauth2-proxy" per its
`.env.example`) is wired directly to Authentik's outpost identity header
(`X-authentik-username`), so there's no separate GitHub OAuth app to register.
Traefik + Authentik gate the request before running-man ever sees it.

## Publish

```bash
./bin/push-oci-package.sh running-man ghcr.io/try-hola apps
# → ghcr.io/try-hola/running-man:0.1.0 (+ :latest) as loose OCI file layers
```

## Deploy

Once a Hola server is running, deploy this package with the CLI:

```bash
hola bundle deploy -p src/running-man/src --app-id running-man --port 3000
```
