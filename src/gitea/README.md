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

### Admin via OIDC group claim

The provisioned OAuth source maps an Authentik **group** to Gitea **site admin**,
so you don't need the CLI to bootstrap an admin:

- `--group-claim-name groups` — read group names from the token's `groups` claim.
  Authentik's default `profile` scope mapping (which Hola attaches) emits the
  user's group names there.
- `--admin-group "authentik Admins"` — members of Authentik's built-in admin
  group become Gitea site admins. Gitea re-evaluates this on every SSO login.

Since the Authentik operator account is in `authentik Admins` by default, your
first SSO login lands you as a Gitea admin with no extra steps. To use a
dedicated group instead, change `--admin-group` to that group's name and add your
user to it in Authentik.

**Emergency access.** Even if OIDC/groups are misconfigured, the instance keeps
`INSTALL_LOCK=true`, so the CLI still works:

```bash
# on the Hola host
docker exec -u git <gitea-container> gitea admin user create --admin ...
```

> Note: the group→admin flags are applied when the OAuth source is *created*.
> Deployments from before this version (or that already have an `authentik`
> source) need a re-provision, or a one-off
> `gitea admin auth update-oauth --id <n> --group-claim-name groups --admin-group "authentik Admins"`.

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
