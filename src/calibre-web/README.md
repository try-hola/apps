# calibre-web

[Calibre-Web](https://github.com/janeczku/calibre-web) — a clean web front-end for
browsing, reading, and downloading books from a [Calibre](https://calibre-ebook.com/)
ebook library. Packaged for Hola from the
[LinuxServer.io image](https://docs.linuxserver.io/images/docker-calibre-web/).

Reachable at `https://calibre-web.<HOLA_BASE_DOMAIN>` once installed.

- **One container** (`calibre-web`) on port **8083**, plus a `calibre-web-init`
  sidecar that runs once at deploy and exits (see [First run](#first-run)).
- **No host ports** — Hola routes ingress through Traefik to container port **8083**.
- **Two data dirs**: `/config` (Calibre-Web's own `app.db` — users, settings, Kobo
  sync tokens) and `/books` (the Calibre library itself: `metadata.db` plus the
  book files). Both bind-mounted under the app's data root.

## Reader connectivity

This is the part that needed a Traefik carve-out.

Calibre-Web has no generic OIDC support — upstream only implements Google and GitHub
OAuth ([#2965](https://github.com/janeczku/calibre-web/issues/2965)), and its LDAP
support is configured through the web UI rather than env vars, so Hola's `native-ldap`
mode can't drive it either. That leaves `forward-auth`: Hola gates the route with
Authentik's embedded outpost and login happens before Calibre-Web ever sees the
request.

That works fine for browsers and breaks every e-reader. OPDS clients (Moon+ Reader,
KyBook, FBReader, KOReader) and Kobo devices authenticate with a credential they hold
directly — they cannot follow an SSO redirect to a login page. Behind an unqualified
forward-auth gate they just fail.

So the manifest exempts the two reader paths — but as `protectedBypassPaths`, not the
plain `bypassPaths` other packages use for a path an app already guards with its own
credential:

```jsonc
"auth": {
  "mode": "forward-auth",
  "forwardAuth": {
    "protectedBypassPaths": ["/opds", "/kobo/"],
    "bypassAuthPasswordEnv": "OPDS_BYPASS_PASSWORD"
  }
}
```

The difference matters here. Kobo's per-device sync token identifies *a* user, but
it's not something an operator can hand to a device out of band before that user's
account even exists, and Calibre-Web's own OPDS auth becomes optional the moment
anonymous browsing is on (see below) — so neither one is a credential Hola can rely on
to keep these two paths from being reachable by anyone on the internet. `bypassPaths`
would leave them wide open; `protectedBypassPaths` instead puts a shared credential in
front of them at Traefik, via one `basicAuth` middleware Hola emits for the deployment.
Same higher-priority router mechanism as plain `bypassPaths` (try-hola/hola#356), just
gated instead of open.

That credential is an ordinary generated secret, not something Hola invents just for
this — `bypassAuthPasswordEnv` names the `OPDS_BYPASS_PASSWORD` entry declared below in
this package's own `defaultEnv` (`isSecret: true` + a `generate` recipe, auto-filled at
install time exactly like a database password would be). Hola resolves its value at
deploy time and feeds it to Traefik; nothing new is generated or stored on its own.

**Retrieving the credential.** Same as any other generated secret on this app: open its
**Configuration** tab in the Hola web UI and reveal `OPDS_BYPASS_PASSWORD` (masked by
default, click the eye icon), or `hola config <deploymentId> --json` from the CLI.

The fixed username is `hola`; that value is the password. Configure your OPDS reader or
`Kobo eReader.conf` with `https://hola:<the password>@calibre-web.<HOLA_BASE_DOMAIN>/...`
— most OPDS clients and Kobo's firmware both accept credentials embedded in the URL
this way.

**What's still per-user underneath that gate:**

| Path | Once past the Traefik credential | Verified upstream behavior |
| --- | --- | --- |
| `/opds` | Optional HTTP Basic against a real Calibre-Web account — send it for that user's own library view/permissions, omit it for the Guest role's | Basic auth is optional (not required) once anonymous browsing is on — `requires_basic_auth_if_no_ano` |
| `/kobo/<token>/` | Per-user secret sync token in the URL path, checked independently of anonymous browsing | `401` for an invalid token, regardless of the anonymous-browsing setting |

So the Traefik credential is the thing standing between these paths and the open
internet; Calibre-Web's own per-user auth underneath it is unaffected and still
personalizes access for anyone who supplies their own account credentials.

One caveat worth knowing: every Authentik user who can reach the app still gets
whatever Calibre-Web account they log into (or the shared Guest role, with anonymous
browsing on). Forward-auth gates the door; it doesn't map identities into Calibre-Web's
user table.

### Anonymous browsing (no more double login)

This package sets `config_anonbrowse = 1` by default — Calibre-Web's own login screen
is skipped for browser users, who already passed Authentik's SSO gate to get here.
Anyone wanting their own account (uploads, personal shelves, admin) still logs in via
the link in the UI; unauthenticated visitors get the Guest role's permissions instead
(configurable under **Admin → User Management → Guest**).

This is only safe *because* `/opds` and `/kobo/` are `protectedBypassPaths`, not plain
`bypassPaths` — see above. If you ever change that (or remove Traefik from in front of
this app), turn anonymous browsing back off first: it also makes Basic auth on `/opds`
optional, and without the Traefik credential in front of it, an open `/opds` would be
one unauthenticated request away from serving your whole library to anyone.

### Kobo sync

Kobo sync is **enabled by default** by this package, along with the two settings that
make it work behind a reverse proxy — these are the ones people get wrong
([#1891](https://github.com/janeczku/calibre-web/issues/1891),
[#1873](https://github.com/janeczku/calibre-web/issues/1873)):

- `config_kobo_sync = 1` — the feature itself.
- `config_external_port = 443` — Calibre-Web builds the download URLs it hands the
  device from this. Left at 8083 the device gets unreachable links.
- `config_kobo_proxy = 0` — "proxy unknown requests to the Kobo store" is off, which
  is what makes sync reliable behind a proxy.

Traefik already sends the `X-Forwarded-Proto` / `X-Forwarded-Host` headers Calibre-Web
needs to work out that it's behind HTTPS.

To connect a device: log in, go to **Account → Kobo Sync Token → Create/View**, and put
the generated URL in `.kobo/Kobo/Kobo eReader.conf` on the device as `api_endpoint`.

EPUB→KEPUB conversion (which Kobo devices prefer) works out of the box —
`kepubify` ships in the image and LinuxServer's init points Calibre-Web at it
automatically. It does **not** need the format-conversion option below.

### OPDS

Point any OPDS reader at `https://calibre-web.<HOLA_BASE_DOMAIN>/opds` and give it your
Calibre-Web username and password.

## First run

Calibre-Web can only *read* an existing Calibre library — it never creates one. Both
`check_valid_db` and `setup_db` in `cps/db.py` bail out when `metadata.db` is missing,
and it's been that way for years
([#269](https://github.com/janeczku/calibre-web/issues/269)). On a fresh Hola install
the books directory starts empty, so out of the box the app would come up stuck on its
`/admin/dbconfig` setup page with nothing to point it at.

The `calibre-web-init` sidecar fixes that before the app starts. It runs the app's own
image (nothing extra to pull) with the s6 entrypoint overridden, so it seeds and exits:

1. If `/books/metadata.db` is absent, it writes an **empty Calibre library** there —
   upstream's own `library/metadata.db` template, embedded in `compose.yaml` as a
   gzip+base64 blob so a fresh install needs no network beyond the image pull. The
   library UUID is regenerated so each install has its own identity.
2. It drops a script into LinuxServer's `/custom-cont-init.d` hook. That runs inside
   the app container after `init-calibre-web-config` creates `app.db` and before the
   server starts, and writes the first-run defaults (library path `/books`, plus the
   Kobo settings above).

Both steps are guarded: an existing library is never touched, and the settings are only
written while the library path is still unset, so anything you change later in the UI
survives restarts and redeploys.

The result is that the app boots straight to a login page. Sign in with the
LinuxServer default — **`admin` / `admin123`** — and change the password immediately.

Upload books through **Admin → Upload** (the `+` button).

## Pushing your own library

> **Needs Hola 0.10.0 or newer** on the host. `hola app data push` and the server
> endpoints behind it landed in 0.10.0; against an older host the command fails
> because those endpoints don't exist. Nothing else in this package depends on
> it — everything below is the *alternative* to uploading book by book, not a
> requirement. On an older host, upload through the UI (above) or upgrade with
> `hola update --host …`.

If you already curate a Calibre library on your own machine, push the whole thing
instead of uploading book by book — this package declares it as a push target:

```bash
hola app data push calibre-web-<id> --list
hola app data push calibre-web-<id> library ~/Calibre\ Library --host me@server
```

Hola stops the app, mirrors the library into `books` (so deletions on your side
propagate), fixes ownership to the app's PUID/PGID, and starts it again — the
restart is what makes a replaced `metadata.db` visible, since Calibre-Web caches
its database connection.

It's rsync, so re-running it after adding books or fixing metadata in desktop
Calibre only transfers what changed. The push is one-way: your machine is the
source of truth, and the server copy is a replica — `mode: mirror` means files
you deleted locally are deleted on the server too.

## Install-time settings

| Setting | Default | Notes |
| --- | --- | --- |
| Timezone | `UTC` | Used for timestamps. |
| Enable ebook format conversion | off | Installs Calibre's CLI tools at container start (`DOCKER_MODS=linuxserver/mods:universal-calibre`) so Calibre-Web can convert formats on download. Adds ~a minute to first boot and several hundred MB, and is **x86-64 only**. Not needed for Kobo. |
| User ID (PUID) / Group ID (PGID) | `1000` | Advanced. Ownership of the library and config files. |

## Upgrading

The image is pinned by digest and watched by Renovate. Calibre-Web migrates `app.db`
on start; the Calibre library format is upstream Calibre's and is not touched by
version bumps.
