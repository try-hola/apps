# 🗂️ Directus

[Directus](https://directus.io) — an open-source **headless CMS & data platform**.
It layers a realtime **REST/GraphQL API** and a no-code **admin app** on top of any
SQL database, so you manage content and data models through a friendly UI while your
apps consume them over the API. Packaged for Hola.

Reachable at `https://directus.<HOLA_BASE_DOMAIN>` once installed.

## Stack

- **`directus`** — the Directus app (API + admin), Node.js, on port **8055**. File
  uploads live in the `uploads` volume (`/directus/uploads`); custom extensions in
  `extensions` (`/directus/extensions`).
- **`directus-postgres`** — PostgreSQL, the recommended production database. Internal
  only (no host port); data in the `postgres` volume. Uses
  [`pgautoupgrade`](https://github.com/pgautoupgrade/docker-pgautoupgrade) so the
  cluster migrates across Postgres majors in place on boot.
- **`directus-init`** — a one-shot that chowns the bind-mounted `uploads`/`extensions`
  dirs to Directus's non-root user (uid 1000) before the app starts, so uploads work.
- **No host ports** — Hola routes ingress through Traefik to container port **8055**.

On the **first boot** against an empty database the image runs `directus bootstrap`,
which applies migrations and creates the first admin account from `ADMIN_EMAIL` /
`ADMIN_PASSWORD`. Both carry a default so a fresh install goes **straight to the login
screen** (with the SSO button) rather than Directus's browser "create admin"
onboarding. Every later start just re-runs migrations.

## Configuration

Collected by the install wizard:

- **`KEY`** / **`SECRET`** — unique per-install random strings. `SECRET` signs access
  tokens; `KEY` is the project identifier used for caching/signing. Keep them stable
  across restarts (a changed `SECRET` invalidates all issued tokens). Generate each
  with `openssl rand -hex 32`.
- **`ADMIN_EMAIL`** — the first admin account's email. **Set it to your own Authentik/SSO
  email** and the "Sign in with Authentik" button logs you straight into that account
  (SSO users are matched by email). Left at the default (`admin@example.com`) it's just
  a local break-glass admin, and you invite your SSO users afterwards.
- **`ADMIN_PASSWORD`** — optional. Leave it blank and it defaults to your `SECRET` (a
  strong, unique per-install value), so the break-glass admin is secure without you
  managing another password. Set one only if you want a memorable local login.

The PostgreSQL password is internal and self-contained (`POSTGRES_PASSWORD` defaults
in-compose); no input required unless you expose the DB.

## Authentication

This package ships `auth.mode: native-oidc`. Hola provisions a per-app Authentik OIDC
client and injects it as Directus's `authentik` OpenID provider, so the login screen
shows a **"Sign in with Authentik"** button alongside Directus's built-in
email/password login.

- **Local admin** always works — the `ADMIN_EMAIL` account is a full local login,
  independent of SSO. If SSO is ever misconfigured you can still get in.
- **SSO users** sign in with the Authentik button. Public self-registration is **off**
  (Directus needs a default-role UUID that doesn't exist until the project is seeded),
  so a Directus user must exist whose **email** matches the Authentik identity
  (`AUTH_AUTHENTIK_IDENTIFIER_KEY`). Two ways to get there:
  - **Easiest:** set `ADMIN_EMAIL` to *your* Authentik email at install — the
    bootstrapped admin *is* you, so "Sign in with Authentik" logs straight into it.
  - **Otherwise:** log in as the local break-glass admin and invite your SSO users from
    **Settings → Access Control**.

  The OIDC callback is `https://directus.<HOLA_BASE_DOMAIN>/auth/login/authentik/callback`.

Directus wants the provider's OpenID **discovery** URL, so the compose appends
`.well-known/openid-configuration` to the issuer Hola injects.

## Backups

The manifest declares a `pg_dump` pre-backup hook (and a post-hook cleanup) against
`directus-postgres`, so Hola's pre-upgrade / backrest snapshots capture a consistent
SQL dump under the app data root alongside the uploaded files.
