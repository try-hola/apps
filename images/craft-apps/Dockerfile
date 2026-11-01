# Craft Apps: the upstream web builds of the storytold "Craft" apps plus a landing
# page, served as static files by unprivileged nginx (uid 101, port 8080).
# Build context is this directory after `node scripts/build.mjs` has filled dist/.
FROM nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6

LABEL org.opencontainers.image.title="craft-apps-web" \
      org.opencontainers.image.description="Official web builds of the open-source Craft apps (MIT OR Apache-2.0), served by nginx" \
      org.opencontainers.image.source="https://github.com/try-hola/apps" \
      org.opencontainers.image.licenses="MIT OR Apache-2.0"

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY dist/ /usr/share/nginx/html/

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
