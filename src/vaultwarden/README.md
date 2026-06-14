# vaultwarden

[Vaultwarden](https://github.com/dani-garcia/vaultwarden) — a lightweight, self-hosted
server compatible with the Bitwarden clients — packaged for Hola.

- **Single container**, SQLite-backed, data in the `vaultwarden-data` volume (`/data`).
- **No host ports** — Hola routes ingress through Traefik to container port **80**.
  The Bitwarden WebSocket/notifications run on the same port (Vaultwarden ≥ 1.29).
- **HTTPS is required** by the Bitwarden clients — Traefik terminates TLS, so set
  `DOMAIN` to `https://vaultwarden.<your HOLA_BASE_DOMAIN>/`.
- Set `SIGNUPS_ALLOWED=false` after creating your account.

## Deploy

```bash
hola bundle deploy -p src/vaultwarden/src --app-id vaultwarden --port 80
```

Or install it from the Hola web catalog once published.
