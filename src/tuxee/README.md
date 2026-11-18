# tuxee

[Tuxee](https://github.com/agent0ai/tuxee) is a small Debian (trixie-slim)
Linux container with a browser UI for files and **persistent terminals**:
terminals keep running after you log out or close the tab. It also has a file
manager with drag-and-drop upload, a code editor, a media viewer, and window
layouts for terminals and file browsers. GUI apps run through a built-in X
server. It is made by [Agent Zero](https://agent-zero.ai), released under the
MIT licence, and packaged here for Hola.

## Layout (Hola app package format)

```
src/tuxee/
├── package.json        # name + version + OCI annotations
└── src/
    ├── compose.yaml    # Traefik-only: pinned image, no host ports, bind mounts
    └── manifest.json   # ingress, generated root password, volumes, auth, backup
```

- **One container**, `agent0ai/tuxee`, pinned by tag **and** multi-arch index
  digest (amd64 + arm64). Upstream rebuilds each release tag every day to pick
  up Debian security updates, so the tag alone is not immutable. The digest is
  what keeps an install stable, and Renovate proposes digest bumps.
- **No host ports.** Traefik forwards to container port **80**, which is
  upstream's documented setup for a TLS-terminating proxy. Tuxee's own HTTPS/ACME
  listener on 443 is never routed, so it never receives traffic.
- **Persistence**, all under `${HOLA_APP_DATA}`:

  | Host (under the app data root) | Container | Holds |
  | --- | --- | --- |
  | `state/` | `/var/lib/tuxee` | Server state and Tuxee's own certificates |
  | `home/` | `/root` | Your files, shell settings, saved layouts |
  | `init/` | `/init` | Startup scripts (see below) |

## Signing in: two layers

1. **Hola SSO (forward-auth).** Traefik sends every request, WebSocket upgrades
   included, through Authentik before it reaches Tuxee.
2. **Tuxee's own login.** Tuxee authenticates against the container's Linux
   accounts through PAM. You sign in as **`root`** with the install's
   **Root password**. Hola generates it per install (`ROOT_PASSWORD`, 16 random
   bytes as hex). Read it from the app's configuration page in the dashboard.

Tuxee has no OIDC or header-trust mode, so it can't use the SSO identity. That
is why both layers are needed. Keep the forward-auth gate in place: Tuxee is a
root shell on a container, and its own login is a single shared password.

### The root password resets when the container is recreated

The image's entrypoint sets root's password with `chpasswd` only on the
**first start of each new container**. The account database lives in the
container layer, not in a volume. So any recreate, such as an upgrade or a
configuration change in Hola, sets root back to `ROOT_PASSWORD`, even if you
changed it with `passwd` inside Tuxee. To change it for good, change
**Root password** in Hola and let it redeploy.

## What survives an upgrade, and what doesn't

Only the three directories above persist. Anything you install with `apt`
lives in the container layer and is **gone after a recreate**. That includes
Tuxee's built-in `tuxee update`, which swaps the binary in place until the next
recreate brings back the pinned image. Running processes also end when the
container is recreated, persistent terminals included. Tuxee keeps them alive
across *its own* restarts, not across container restarts.

Use **`/init`** to make packages and services come back: Tuxee runs every
top-level `*.sh` in `/init` (as root, in parallel) on each container start. For
example, `init/packages.sh`:

```bash
#!/bin/bash
command -v jq >/dev/null || { apt-get update && apt-get install -y jq; }
```

See upstream's [startup-script guide](https://github.com/agent0ai/tuxee/blob/main/docker/init/README.md).
A bind mount hides the image's own `/init/README.md`, so the folder starts out
empty.

## Privileges

None beyond Hola's default hardening. The container runs as root, but it needs
no `privileged` mode, no added capabilities and no device access. Root doesn't
need setuid escalation, so Hola's `no-new-privileges` stays on and the manifest
declares **no** `security.elevated` grant (unlike `webtop`, whose desktop user
needs `sudo`). `apt` works as-is. This was tested under `no-new-privileges`.

Two consequences follow:

- Root here is root **in the container**, not on the host. Tuxee can't manage
  the Hola host or other apps. It sees only its own filesystem and the three
  bind mounts.
- If you add non-root Linux users inside Tuxee, `su`/`sudo` from those users
  won't work under `no-new-privileges`. Signing in to Tuxee as that user works.

## Backup

`accepts: ["backup@1"]` with no hooks. The state is plain files (no database),
so a file-level copy of the data root is a usable backup. A terminal writing
into `/root` while it is copied is captured crash-consistently.

## Deploy

```bash
hola bundle deploy -p src/tuxee/src --app-id tuxee --port 80
```

Or install it from the Hola web catalog once published.
