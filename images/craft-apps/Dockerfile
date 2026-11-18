# Craft Apps: the upstream web builds of the storytold "Craft" apps plus a landing
# page, served as static files by unprivileged nginx (uid 101, port 8080).
# Build context is this directory after `node scripts/build.mjs` has filled dist/.
FROM nginxinc/nginx-unprivileged:1.31-alpine@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e

LABEL org.opencontainers.image.title="craft-apps-web" \
      org.opencontainers.image.description="Official web builds of the open-source Craft apps (MIT OR Apache-2.0), served by nginx" \
      org.opencontainers.image.source="https://github.com/try-hola/apps" \
      org.opencontainers.image.licenses="MIT OR Apache-2.0"

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY dist/ /usr/share/nginx/html/

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
