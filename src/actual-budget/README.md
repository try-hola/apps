# actual-budget

[Actual Budget](https://actualbudget.org) — local-first personal finance and budgeting.

- **Image:** `actualbudget/actual-server:26.6.0`
- **Ingress:** port 5006
- **Data:** persisted in the `actual-budget-data` volume (`/data`).
- **`ACTUAL_OPENID_SERVER_HOSTNAME`** — set to `https://actual.<your HOLA_BASE_DOMAIN>`
  (Actual builds its OIDC redirect, `/openid/callback`, from this base URL).

## Auth

`native-oidc` (env injection): when `HOLA_AUTH_MODE=authentik`, Hola provisions an
OpenID client and injects `ACTUAL_OPENID_DISCOVERY_URL` / `_CLIENT_ID` /
`_CLIENT_SECRET`. Actual derives its own redirect URI from `ACTUAL_OPENID_SERVER_HOSTNAME`,
so no literal redirect-URI env is needed (Hola's `oidc.env.redirectUri` is optional).

Password login stays available as a fallback (`ACTUAL_OPENID_ENFORCE` is left unset),
so Actual still works on a Hola install without Authentik.

## Publish

```bash
./bin/push-oci-package.sh actual-budget ghcr.io/try-hola apps
```
