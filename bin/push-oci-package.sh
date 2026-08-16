#!/usr/bin/env bash
set -euo pipefail

# Publish a Hola app package to an OCI registry as LOOSE FILE LAYERS.
#
# Each top-level file under src/<package>/src/ (compose.yaml, manifest.json,
# icon, …) is pushed as its own OCI layer, titled by its bare filename. A
# consumer therefore gets the files directly with `oras pull -o <dir>` — no
# tarball to unpack. This matches what the Hola server's bundle reader expects
# (compose.yaml + manifest.json at the bundle root).
#
# Usage:
#   ./bin/push-oci-package.sh <package-name> <registry-path> [repository] [tag]
# Example:
#   ./bin/push-oci-package.sh gitea ghcr.io/try-hola apps latest

if [ $# -lt 2 ]; then
  echo "Usage: $0 <package-name> <registry-path> [repository] [tag]" >&2
  echo "Example: $0 gitea ghcr.io/try-hola apps latest" >&2
  exit 1
fi

PACKAGE_NAME=$1
REGISTRY_PATH=$2
REPOSITORY=${3:-}
TAG=${4:-latest}

die() { echo "Error: $1" >&2; exit 1; }

command -v oras >/dev/null 2>&1 || die "ORAS CLI not installed — https://oras.land/docs/installation"
command -v jq >/dev/null 2>&1 || die "jq is required"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

PKG_DIR="src/$PACKAGE_NAME"
SRC_DIR="$PKG_DIR/src"
[ -d "$SRC_DIR" ] || die "package '$PACKAGE_NAME' not found ($SRC_DIR missing)"
[ -f "$PKG_DIR/package.json" ] || die "missing $PKG_DIR/package.json"
[ -f "$SRC_DIR/compose.yaml" ] || die "missing $SRC_DIR/compose.yaml (Hola requires compose.yaml)"
[ -f "$SRC_DIR/manifest.json" ] || die "missing $SRC_DIR/manifest.json (Hola requires manifest.json)"

VERSION=$(jq -r .version "$PKG_DIR/package.json")
[ "$VERSION" != "null" ] && [ -n "$VERSION" ] || die "unable to read version from $PKG_DIR/package.json"

GITHUB_ORG=$(echo "$REGISTRY_PATH" | awk -F'/' '{print $2}')

# Reproducibility: oras stamps org.opencontainers.image.created with the wall
# clock unless we set it, so pushing byte-identical content twice produces two
# different manifest digests under the same tag — a re-published tag that looks
# like a real change to anything comparing digests. (ORAS 1.2.3 does NOT honour
# SOURCE_DATE_EPOCH; an explicit --annotation is the only override.) Pin it to
# the commit that last touched the files that actually go into the bundle, so
# the digest is a pure function of the content. An explicit SOURCE_DATE_EPOCH in
# the environment still wins, for callers that want a fixed value.
if [ -n "${SOURCE_DATE_EPOCH:-}" ]; then
  CREATED=$(date -u -d "@$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)
else
  # Needs full history to be accurate — a shallow clone whose HEAD didn't touch
  # these paths falls back to HEAD, then to the epoch.
  CREATED=$(TZ=UTC git log -1 --format=%cd --date=format-local:%Y-%m-%dT%H:%M:%SZ \
    -- "$SRC_DIR" "$PKG_DIR/package.json" 2>/dev/null || true)
  [ -n "$CREATED" ] || CREATED=$(TZ=UTC git log -1 --format=%cd --date=format-local:%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)
fi
[ -n "$CREATED" ] || CREATED="1970-01-01T00:00:00Z"

# Base + package.json annotations (substituting ${npm_package_version}). The base
# keys (version, source, created) are set here; we exclude them from the
# package.json pass so oras never sees a duplicate annotation key (it errors on
# duplicates, and package.json templates commonly repeat
# org.opencontainers.image.version).
ANNOTATIONS=(
  --annotation "org.opencontainers.image.version=$VERSION"
  --annotation "org.opencontainers.image.created=$CREATED"
)
if [ -n "$REPOSITORY" ] && [ -n "$GITHUB_ORG" ]; then
  ANNOTATIONS+=(--annotation "org.opencontainers.image.source=https://github.com/$GITHUB_ORG/$REPOSITORY")
fi
if jq -e '.oci.annotations' "$PKG_DIR/package.json" >/dev/null 2>&1; then
  while IFS="=" read -r key value; do
    value=${value//\$\{npm_package_version\}/$VERSION}
    ANNOTATIONS+=(--annotation "$key=$value")
  done < <(jq -r '
    .oci.annotations
    | to_entries[]
    | select(.key != "org.opencontainers.image.version"
             and .key != "org.opencontainers.image.source"
             and .key != "org.opencontainers.image.created")
    | "\(.key)=\(.value)"' "$PKG_DIR/package.json")
fi

# Sensible media type per extension (consumers key off the layer title, but a
# correct media type keeps the artifact self-describing).
media_type() {
  case "$1" in
    *.yaml | *.yml) echo "application/yaml" ;;
    *.json) echo "application/json" ;;
    *.png) echo "image/png" ;;
    *.svg) echo "image/svg+xml" ;;
    *.md) echo "text/markdown" ;;
    *) echo "application/octet-stream" ;;
  esac
}

# Collect top-level files as loose layers, titled by bare filename (cwd = SRC_DIR).
cd "$SRC_DIR"
LAYERS=()
for f in *; do
  [ -f "$f" ] || continue   # top-level files only (no build contexts — use prebuilt images)
  LAYERS+=("$f:$(media_type "$f")")
done
[ "${#LAYERS[@]}" -gt 0 ] || die "no files to publish in $SRC_DIR"

echo "Publishing $PACKAGE_NAME v$VERSION to $REGISTRY_PATH/$PACKAGE_NAME"
echo "  layers:  ${LAYERS[*]}"
echo "  created: $CREATED (pinned — identical content republishes to the same digest)"

push() { # push <tag>
  oras push "$REGISTRY_PATH/$PACKAGE_NAME:$1" "${LAYERS[@]}" "${ANNOTATIONS[@]}" --disable-path-validation
}

push "$VERSION"
if [ "$TAG" = "latest" ]; then
  push latest
fi

echo "Done: $REGISTRY_PATH/$PACKAGE_NAME:$VERSION (+ latest)"
