# uptime-kuma

[Uptime Kuma](https://github.com/louislam/uptime-kuma) — a self-hosted monitoring tool
(uptime checks + status pages), a fancy self-hosted UptimeRobot — packaged for Hola.

- **Single container**, data in the `uptimekuma-data` volume (`/app/data`).
- **No host ports** — Hola routes ingress through Traefik to container port **3001**.
- No required configuration — create the admin account on first visit.

## Deploy

```bash
hola bundle deploy -p src/uptime-kuma/src --app-id uptime-kuma --port 3001
```

Or install it from the Hola web catalog once published.
