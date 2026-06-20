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

### Git over HTTPS (use a token, not a password)

Gitea is `native-oidc`, **not** forward-auth — its Traefik route has no Authentik
gate, so Gitea applies its own auth per request. Git clone/push and the API are
**not** redirected into the SSO browser flow; they keep using Gitea's HTTP Basic
auth (which stays enabled — only the *web* login form is hidden).

But SSO users have no Gitea password, so authenticate git with a **personal
access token** as the password:

```bash
# Gitea UI → Settings → Applications → Generate New Token (repo scopes)
git clone https://<your-username>:<token>@gitea.<HOLA_BASE_DOMAIN>/owner/repo.git
# or omit the token and paste it when git prompts for a password
```

The `tea` CLI authenticates the same way (token over HTTPS). Note that SSH isn't
exposed (Traefik is HTTP-only; the validator forbids host ports), so **HTTPS +
token is the only remote git transport**.

### Admin via OIDC group claim

The provisioned OAuth source maps an Authentik **group** to Gitea **site admin**,
so you don't need the CLI to bootstrap an admin:

- `--group-claim-name groups` — read group names from the token's `groups` claim.
  Authentik's default `profile` scope mapping (which Hola attaches) emits the
  user's group names there.
- `--admin-group "hola-admins"` — members of the Hola-owned **`hola-admins`**
  group become Gitea site admins. Gitea re-evaluates this on every SSO login.

Hola provisions the `hola-admins` group and seeds your superuser(s) into it, so
your first SSO login lands you as a Gitea admin with no extra steps. The same
group governs dashboard admin (`HOLA_OIDC_ADMIN_GROUP`), so admin is consistent
across the platform. To use a different group, change `--admin-group` and add
your user to that group in your IdP.

**Emergency access.** Even if OIDC/groups are misconfigured, the instance keeps
`INSTALL_LOCK=true`, so the CLI still works:

```bash
# on the Hola host
docker exec -u git <gitea-container> gitea admin user create --admin ...
```

> Note: the group→admin flags are applied when the OAuth source is *created*.
> Deployments from before this version (or that already have an `authentik`
> source) need a re-provision, or a one-off
> `gitea admin auth update-oauth --id <n> --group-claim-name groups --admin-group "hola-admins"`.
> The `hola-admins` group is provisioned by the Hola server (≥ the release with
> try-hola/hola#168); on older servers, create the group and add your user in
> Authentik, or point `--admin-group` at an existing group.

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
