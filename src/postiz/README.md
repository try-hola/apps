# 📅 Postiz

[Postiz](https://github.com/gitroomhq/postiz-app) — an open-source social media
scheduling tool with a set of AI features. Schedule posts across many social
networks from one place.

Reachable at `https://postiz.<HOLA_BASE_DOMAIN>` once installed.

## Stack

Postiz's scheduling engine runs on **Temporal**, so this package deploys five
containers:

| Service | Image | Role |
| --- | --- | --- |
| `postiz` | `ghcr.io/gitroomhq/postiz-app:v2.21.9` | The app (frontend + API, port 5000) |
| `postiz-postgres` | `postgres:17-alpine` | Postiz's database |
| `postiz-redis` | `redis:7.2-alpine` | Cache / queues |
| `temporal` | `temporalio/auto-setup:1.28.1` | Scheduling workflows |
| `temporal-postgres` | `postgres:16-alpine` | Temporal persistence + visibility |

### Why no Elasticsearch?

Upstream's compose runs Temporal with Elasticsearch for workflow *visibility*
(search/listing). Temporal supports Postgres-backed visibility just as well, so
we point Temporal at its own Postgres and **omit Elasticsearch entirely**
(`ENABLE_ES` unset) — dropping a ~512MB–1GB container with no loss of scheduling
functionality. Advanced ES visibility could become an opt-in once Hola supports
per-app compose profiles ([try-hola/hola#162](https://github.com/try-hola/hola/issues/162)).

## Configuration

The install wizard collects:

- **`JWT_SECRET`** (required, secret) — a unique random string used to sign
  sessions. Generate one with `openssl rand -hex 32`.
- **`DISABLE_REGISTRATION`** (default `false`) — set to `true` after you've
  created your account to stop further sign-ups.

The public URLs (`MAIN_URL`, `FRONTEND_URL`, `NEXT_PUBLIC_BACKEND_URL`) are
derived automatically from the app's Traefik host. Connecting social accounts
(X, LinkedIn, Mastodon, …) is done from Postiz's own settings; add the relevant
provider API keys there or via additional environment variables (see the
[Postiz configuration reference](https://docs.postiz.com)).

## Authentication

Postiz has its own account system, so this package ships with `auth.mode: none`.
After creating your account, set `DISABLE_REGISTRATION=true`. Putting Postiz
behind Authentik (forward-auth, or Postiz's built-in generic OAuth /
`POSTIZ_GENERIC_OAUTH`) is a possible future enhancement.

## First run

Temporal runs database migrations on first boot, and Postiz waits for Temporal
to report healthy, so the **initial start can take a couple of minutes**. Once
up, open the app and create your account.
