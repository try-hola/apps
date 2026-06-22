# webtop

[Ubuntu Webtop](https://docs.linuxserver.io/images/docker-webtop/) — a full Ubuntu
Linux desktop environment (KDE) you reach from your browser, built and maintained by
the [LinuxServer.io](https://www.linuxserver.io/) project — packaged for Hola.

This package ships the **Ubuntu KDE** flavor. LinuxServer also publishes XFCE, MATE
and i3 flavors (`ubuntu-xfce`, `ubuntu-mate`, `ubuntu-i3`); swap the `image:` tag in
`compose.yaml` to use one of those.

## Layout (Hola app package format)

```
src/webtop/
├── package.json        # name + version + OCI annotations
└── src/
    ├── compose.yaml    # Traefik-only: pinned image, no host ports, bind-mounted /config
    └── manifest.json   # Hola defaults (ingress port, default env, volume, auth)
```

- **Single container.** The desktop's home/state lives in `/config`, bind-mounted
  under `${HOLA_APP_DATA}/config`.
- **No host ports** — Hola routes ingress through Traefik. `manifest.ingress.port`
  (**3000**, the HTTP web UI) is the container port Traefik forwards to; the
  validator rejects any `ports:` host publishing. (The image also serves HTTPS on
  3001, which Hola does not use — TLS is terminated at Traefik.)
- **Pinned image tag.** `lscr.io/linuxserver/webtop:ubuntu-kde-f0194e9c-ls167` — a
  specific immutable LinuxServer build, not the rolling `ubuntu-kde`/`latest` tag.
  Bump it to a newer `ubuntu-kde-<hash>-ls<n>` tag to update.

## Configuration

- `PUID` / `PGID` (default `1000`/`1000`) — the UID/GID the desktop runs as and that
  owns files in `/config`. Set these to match the host user that owns the app data
  directory so file ownership stays sane.
- `TZ` (default `Etc/UTC`) — timezone for the desktop, e.g. `America/New_York`.

### Desktop GUI compatibility

- **`shm_size: "1gb"`** is set in `compose.yaml`. Desktop images (KasmVNC-based) and
  browsers like Chromium running inside the desktop need a larger `/dev/shm` or they
  crash; the default 64 MB is not enough.
- Some modern GUI apps trip Docker's default **seccomp** syscall filter. If an app
  inside the desktop misbehaves, uncomment the `security_opt: [seccomp:unconfined]`
  block in `compose.yaml`. It is left commented by default because it relaxes the
  container's syscall sandbox — only enable it if you need it.

## Authentication — forward-auth is the security boundary (read this)

A browser-accessible desktop is effectively a **shell on your server**: anyone who
reaches it can run arbitrary commands, install software, and read/write everything
the container can touch. **It must never be exposed without authentication.**

This package sets `manifest.auth.mode = "forward-auth"`, so Traefik (via Authentik's
embedded outpost) gates **every request before it ever reaches the desktop**. Sign-in
happens at the SSO layer; only authenticated Hola users get through.

- **Do not** remove the `forward-auth` auth block or route this app around Traefik.
  Doing so leaves an unauthenticated remote desktop open to the internet.
- **Defense-in-depth (optional).** You may also set the built-in HTTP Basic auth via
  the `CUSTOM_USER` / `PASSWORD` env vars (a second login *behind* the SSO gate).
  This is optional — the forward-auth gate is the real boundary; leave them blank to
  rely solely on SSO.

## Deploy

```bash
hola bundle deploy -p src/webtop/src --app-id webtop --port 3000
```

Or install it from the Hola web catalog once published.
