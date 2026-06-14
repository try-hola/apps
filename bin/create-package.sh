#!/usr/bin/env bash
set -euo pipefail

# Scaffold a new Hola app package under src/<name>/ in the loose-layer format
# the Hola server consumes (compose.yaml + manifest.json).
#
# Usage: ./bin/create-package.sh <package-name>

[ -n "${1:-}" ] || { echo "Usage: $0 <package-name>" >&2; exit 1; }

NAME="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
DIR="$REPO_ROOT/src/$NAME"

[ -d "$DIR" ] && { echo "Error: package '$NAME' already exists at $DIR" >&2; exit 1; }
mkdir -p "$DIR/src"

cat > "$DIR/package.json" <<EOF
{
  "name": "$NAME",
  "version": "0.1.0",
  "description": "$NAME — Hola app package",
  "license": "UNLICENSED",
  "oci": {
    "annotations": {
      "org.opencontainers.image.title": "$NAME",
      "org.opencontainers.image.description": "$NAME",
      "org.opencontainers.image.version": "\${npm_package_version}"
    }
  }
}
EOF

# Hola-friendly compose: prebuilt image, NO host ports (Traefik-only ingress),
# named volumes declared at the top level.
cat > "$DIR/src/compose.yaml" <<EOF
services:
  $NAME:
    image: nginx:1.27
    restart: unless-stopped
    volumes:
      - ${NAME}-data:/data
volumes:
  ${NAME}-data:
EOF

cat > "$DIR/src/manifest.json" <<EOF
{
  "name": "$NAME",
  "version": "0.1.0",
  "title": "$NAME",
  "description": "$NAME",
  "icon": "📦",
  "ingress": { "service": "$NAME", "port": 80 },
  "defaultEnv": [],
  "defaults": {
    "ports": [ { "container": 80, "protocol": "tcp" } ],
    "volumes": [ { "containerPath": "/data" } ]
  }
}
EOF

cat > "$DIR/README.md" <<EOF
# $NAME

Hola app package. Publish with:

\`\`\`bash
./bin/push-oci-package.sh $NAME ghcr.io/try-hola apps
\`\`\`
EOF

echo "Created src/$NAME (compose.yaml + manifest.json). Edit it, then publish with bin/push-oci-package.sh."
