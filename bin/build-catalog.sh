#!/usr/bin/env bash
set -euo pipefail

# Generate the root catalog.json index the Hola server consumes via HOLA_CATALOG_URL.
#
# Walks src/<name>/, reading package.json (name + version) and src/manifest.json
# (title/description/icon/category/tags), and emits a catalog.json whose shape
# matches the server's RemoteCatalog reader (try-hola/hola packages/server/src/
# services/core/catalog.ts). Each app's OCI ref is ghcr.io/<org>/<name>:<version>,
# i.e. the loose-layer artifact published by bin/push-oci-package.sh.
#
# Usage:
#   ./bin/build-catalog.sh [org] [output]
# Defaults: org=try-hola, output=<repo root>/catalog.json

ORG=${1:-try-hola}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
OUTPUT=${2:-"$REPO_ROOT/catalog.json"}

command -v jq >/dev/null 2>&1 || { echo "Error: jq is required" >&2; exit 1; }

cd "$REPO_ROOT"

apps=()
for pkg_dir in src/*/; do
  name_dir="$(basename "$pkg_dir")"
  pkg_json="$pkg_dir/package.json"
  manifest="$pkg_dir/src/manifest.json"

  # A publishable package needs package.json + the loose-layer files.
  [ -f "$pkg_json" ] || { echo "skip $name_dir: no package.json" >&2; continue; }
  [ -f "$pkg_dir/src/compose.yaml" ] || { echo "skip $name_dir: no src/compose.yaml" >&2; continue; }
  [ -f "$manifest" ] || { echo "skip $name_dir: no src/manifest.json" >&2; continue; }

  name="$(jq -r '.name // empty' "$pkg_json")"
  [ -n "$name" ] || name="$name_dir"
  version="$(jq -r '.version // empty' "$pkg_json")"
  [ -n "$version" ] || { echo "skip $name_dir: no version in package.json" >&2; continue; }

  oci="ghcr.io/$ORG/$name:$version"

  # Prefer manifest metadata; fall back to package.json / sensible defaults.
  # mapApp() on the server defaults missing fields, but we emit them explicitly.
  app_json="$(jq -n \
    --arg id "$name" \
    --arg name "$(jq -r '.title // .name // empty' "$manifest")" \
    --arg desc "$(jq -r '.description // empty' "$manifest")" \
    --arg pkgdesc "$(jq -r '.description // empty' "$pkg_json")" \
    --arg icon "$(jq -r '.icon // empty' "$manifest")" \
    --arg category "$(jq -r '.category // empty' "$manifest")" \
    --argjson tags "$(jq -c '(.tags // [])' "$manifest")" \
    --arg version "$version" \
    --arg oci "$oci" \
    '{
      id: $id,
      name: (if $name != "" then $name else $id end),
      description: (if $desc != "" then $desc else $pkgdesc end),
      icon: (if $icon != "" then $icon else "📦" end),
      category: (if $category != "" then $category else "apps" end),
      tags: $tags,
      versions: [ { version: $version, refs: { oci: $oci } } ]
    }')"
  apps+=("$app_json")
done

if [ "${#apps[@]}" -eq 0 ]; then
  printf '{\n  "apps": []\n}\n' > "$OUTPUT"
else
  printf '%s\n' "${apps[@]}" | jq -s '{ apps: . }' > "$OUTPUT"
fi

echo "Wrote $OUTPUT (${#apps[@]} app(s))"
