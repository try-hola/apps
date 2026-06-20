# gitea

[Gitea](https://gitea.com) — a lightweight, self-hosted Git service — packaged for Hola.

## Layout (Hola app package format)

```
src/gitea/
├── package.json        # name + version + OCI annotations
└── src/
    ├── compose.yaml    # Traefik-only: prebuilt image, no host ports, named volume
    └── manifest.json   # Hola defaults (ingress port, default env, volumes)
```

- **No host ports** — Hola routes ingress through Traefik. `manifest.ingress.port`
  (3000) is the container port Traefik forwards to; the validator rejects any
  `ports:` host publishing.
- **SQLite** keeps it a single container. Swap to PostgreSQL by adding a `db`
  service and the matching `GITEA__database__*` env.
- `GITEA__server__DOMAIN` / `ROOT_URL` default to `gitea.example.com`; set them to
  `gitea.<your HOLA_BASE_DOMAIN>` at deploy time.

## Authentication (SSO-only)

This package provisions OIDC (Authentik) via `manifest.auth` and locks the
instance down to SSO:

- `GITEA__service__DISABLE_REGISTRATION=true` — no self-service sign-ups.
- `GITEA__service__ENABLE_PASSWORD_SIGNIN_FORM=false` — the local
  username/password login form is hidden, so the only sign-in is the **OIDC
  (Authentik)** button ([go-gitea/gitea#32687](https://github.com/go-gitea/gitea/pull/32687),
  needs Gitea ≥ 1.23.1 — hence the `1.26` image pin).
- `GITEA__oauth2_client__ENABLE_AUTO_REGISTRATION=true` — the first OIDC login
  creates the user automatically.

**Caveat — promoting an admin / emergency access.** With the password form
hidden, you can't log into the web UI as a local admin. The first OIDC user is a
normal user; grant admin out-of-band via the CLI (the instance keeps
`INSTALL_LOCK=true`, so `gitea admin …` works):

```bash
# on the Hola host
docker exec -u git <gitea-container> gitea admin user change-password ...   # or
docker exec -u git <gitea-container> gitea admin user create --admin ...
```

So you're never fully locked out even if OIDC is misconfigured.

## Publish

```bash
./bin/push-oci-package.sh gitea ghcr.io/try-hola apps
# → ghcr.io/try-hola/gitea:1.0.0 (+ :latest) as loose OCI file layers
```

## Deploy

Once a Hola server is running, deploy this package with the CLI (works today,
reads `compose.yaml` directly):

```bash
hola bundle deploy -p src/gitea/src --app-id gitea --port 3000
```
