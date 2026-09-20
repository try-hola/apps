# dozzle

[Dozzle](https://dozzle.dev) — a live log viewer for every app running on the host.
Open it and you get a searchable, streaming tail of any container's output, grouped
by the app it belongs to.

Reachable at `https://dozzle.<HOLA_BASE_DOMAIN>` once installed.

- **One container** on port **8080**, plus the `hola-docker-proxy` sidecar Hola
  injects for it (see below) — nothing to configure.
- **No host ports** — Hola routes ingress through Traefik to container port 8080.
- **One small data dir**: `/data` holds user display preferences. Dozzle stores no
  log data of its own; it streams from the Docker API and keeps nothing.

## Container logs

This is the first package to use the **`container-logs@1`** capability contract, and
it exists as much to exercise that mechanism as to view logs.

A log viewer normally needs the Docker socket:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock:ro   # NOT what this package does
```

That mount hands one container the ability to read every other container's
environment variables, mounts and networking, and to start, stop or exec into
anything on the host — including Hola's own server. `:ro` doesn't help: it restricts
the filesystem node, not the API spoken over it. Hola's compose validator rejects the
mount outright, so no catalog app can do this.

Instead the manifest declares:

```jsonc
"provides": ["container-logs@1"]
```

At install the operator is asked to consent to that grant. When they do, Hola injects
a `hola-docker-proxy` sidecar — running **Hola's own image**, not Dozzle's — which
holds the socket read-only and exposes a deliberately narrow slice of the Docker API:

| Allowed (GET only) | What it's for |
| --- | --- |
| `/containers/json` | the container list, with each app's `sh.hola.*` labels |
| `/containers/{id}/logs` | the logs themselves |
| `/events` | live start/stop, so the list stays current |
| `/containers/{id}/json` | inspect, **rebuilt** without `Config.Env`, `Cmd`, `Entrypoint`, `HostConfig`, `Mounts` or `NetworkSettings` |
| `/_ping`, `/version` | connection probes |

Everything else — every write, every other path — answers `403 not permitted by the
container-logs grant`. Hola then points `DOCKER_HOST` at that proxy on every service
in this deployment, unconditionally.

The result: **Dozzle needs no knowledge of Hola at all.** It reads `DOCKER_HOST` the
way it would anywhere else; what changed is only what's on the other end of it. That
is the point of a *provisioned* contract — the platform wires up a scoped connection
and steps out, rather than asking the app to implement anything.

### What you don't get, and why

Two Dozzle features need Docker API access the grant deliberately withholds, so both
are disabled in this package rather than left to fail in the UI:

| Feature | Needs | Status |
| --- | --- | --- |
| Container actions (start/stop/restart) | `POST /containers/{id}/…` | off — `DOZZLE_ENABLE_ACTIONS=false` |
| Shell into a container | `POST /exec` | off — `DOZZLE_ENABLE_SHELL=false` |

Per-container CPU and memory stats (`GET /containers/{id}/stats`) and host info
(`GET /info`) are also outside the grant today. Dozzle degrades rather than breaking:
you get logs, not resource graphs.

### Grouping by app

Hola labels every app container it runs with `sh.hola.app`, `sh.hola.deployment` and
`sh.hola.name`, and those come through the container list. Use the **Container filter**
setting to scope the view, e.g. `label=sh.hola.app=calibre-web` to watch one app.

## Who can see it

`auth.mode: forward-auth` — Authentik gates the door, so only users your Hola instance
authorizes reach Dozzle at all. Dozzle is then configured with its `forward-proxy`
auth provider reading Authentik's identity headers, so the person who signed in is the
person Dozzle shows, rather than every visitor sharing one anonymous session.

**Worth being clear about the blast radius:** anyone who can open Dozzle can read the
logs of *every* app on the host, and logs routinely contain more than their authors
intended — tokens in URLs, email addresses, stack traces with data in them. The
`container-logs@1` grant is disclosed at install for exactly this reason. Treat access
to this app as equivalent to read access across the whole instance.
