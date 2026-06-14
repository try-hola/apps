# n8n

[n8n](https://n8n.io) — source-available workflow automation / iPaaS.

- **Image:** `n8nio/n8n:2.26.3`
- **Ingress:** port 5678
- **Data:** persisted in the `n8n-data` volume (`/home/node/.n8n`), including the
  auto-generated encryption key — back this up.
- **`N8N_HOST`** — set to `n8n.<your HOLA_BASE_DOMAIN>` (no scheme).
- **`WEBHOOK_URL`** — set to `https://n8n.<your HOLA_BASE_DOMAIN>/` (must match `N8N_HOST`);
  inbound webhook URLs are built from this.

Behind Traefik, `N8N_PROXY_HOPS=1` lets n8n trust the `X-Forwarded-Proto`/`-For`
headers (so HTTPS detection and secure cookies work) and `N8N_PROTOCOL=https`
advertises the correct scheme.

## Auth

`none`: n8n's OIDC/SAML SSO is an Enterprise feature, and its **webhook endpoints
must stay publicly reachable** (a forward-auth gate would break inbound webhooks —
n8n's core purpose). n8n has its own built-in user management; create the owner
account on first load.

## Publish

```bash
./bin/push-oci-package.sh n8n ghcr.io/try-hola apps
```
