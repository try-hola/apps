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
