# homepage

[Homepage](https://gethomepage.dev) — a highly customizable application dashboard / start page.

- **Image:** `ghcr.io/gethomepage/homepage:v1.13.2`
- **Ingress:** port 3000
- **Config:** persisted in the `homepage-config` volume (`/app/config`).
- **`HOMEPAGE_ALLOWED_HOSTS`** is required (since v1.0) — set it to `homepage.<your HOLA_BASE_DOMAIN>`.

## Auth

`forward-auth`: Homepage has no usable native authentication, so Hola gates it
behind Authentik's forward-auth proxy. Requires `HOLA_AUTH_MODE=authentik` on the
Hola host.

## Publish

```bash
./bin/push-oci-package.sh homepage ghcr.io/try-hola apps
```
