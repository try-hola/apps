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
#
# --- Release channels (try-hola/hola ADR 0005) --------------------------------
#
# Each versions[] entry carries a `channel` marker; the Hola server reads it to
# decide which versions a deployment following that channel is offered. `stable`
# is the floor every channel includes, so a stable release is offered to
# everyone and a pre-release only to deployments that asked for its channel.
# This script emits the marker explicitly on every entry (including `stable`,
# which the server would default anyway) so the file says what it means.
#
# Where the set of versions comes from:
#
#   stable        src/<name>/package.json — the repo is the source of truth. A
#                 release tag that exists in the registry but not in package.json
#                 is NOT listed (reverting a bad release in git must retire it
#                 from the catalog, even though the registry keeps the tag).
#   pre-releases  the tags of ghcr.io/<org>/<name>, via `oras repo tags`. A
#                 pre-release bundle is published from a PULL REQUEST and its
#                 version is never merged into main's package.json, so the
#                 registry is the only place it can be discovered from.
#
# Retention: the newest stable, plus every pre-release strictly newer than it by
# semver precedence (1.3.0 > 1.3.0-rc.10 > 1.3.0-rc.9). An rc is therefore
# retired automatically the moment it graduates — the stable release that
# supersedes it is newer, so it drops out on the next regeneration. To retire an
# rc that will never graduate, delete that version of the GHCR package. Each
# version is emitted exactly once (the server keeps the first occurrence of a
# repeated version string and warns about the rest).
#
# Channel names: a pre-release's channel is the alphabetic prefix of its first
# prerelease identifier, lower-cased — `0.11.0-rc.1` → `rc`, `2.0.0-beta.3` →
# `beta`. Every emitted name is asserted against the server's grammar
# (^[a-z][a-z0-9-]{0,31}$) and a violation fails this script: the server DROPS a
# malformed entry rather than defaulting it to stable, so a bad marker must
# never reach catalog.json.
#
# Env:
#   CATALOG_PRERELEASES=auto|require|skip   (default: auto)
#     auto     Discover pre-releases when the ORAS CLI is installed; warn loudly
#              and emit a stable-only catalog when it isn't (local runs).
#     require  Discovery is mandatory; a missing ORAS CLI or a failed tag
#              listing is a hard error. CI uses this on main, so a registry
#              hiccup fails the workflow instead of quietly retiring every
#              published pre-release.
#     skip     Never contact the registry; emit stable entries only.
#   In auto and require, a tag listing that fails for any reason other than "this
#   package has never been published" is fatal — a partial listing would silently
#   drop versions from the public index.

ORG=${1:-try-hola}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
OUTPUT=${2:-"$REPO_ROOT/catalog.json"}
PRERELEASES=${CATALOG_PRERELEASES:-auto}

# Mirrors isValidChannelName() in try-hola/hola packages/shared/src/index.ts.
CHANNEL_NAME_RE='^[a-z][a-z0-9-]{0,31}$'
SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'

die() {
  echo "Error: $1" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || die "jq is required"

# Resolve the discovery mode once, up front: whether pre-releases are listed is a
# property of the run, never of an individual app.
DISCOVER=true
case "$PRERELEASES" in
  skip)
    DISCOVER=false
    ;;
  auto)
    if ! command -v oras >/dev/null 2>&1; then
      echo "Warning: ORAS CLI not installed — emitting STABLE versions only." >&2
      echo "         Pre-release (channel) entries are read from the registry;" >&2
      echo "         install oras (https://oras.land/docs/installation) or set" >&2
      echo "         CATALOG_PRERELEASES=skip to make a stable-only build explicit." >&2
      DISCOVER=false
    fi
    ;;
  require)
    command -v oras >/dev/null 2>&1 \
      || die "CATALOG_PRERELEASES=require but the ORAS CLI is not installed — refusing to emit a catalog without pre-release discovery"
    ;;
  *)
    die "unknown CATALOG_PRERELEASES='$PRERELEASES' (expected auto, require or skip)"
    ;;
esac

# Print the registry tags of one OCI repository, one per line.
list_registry_tags() { # list_registry_tags <repo-ref>
  local ref=$1 out status
  set +e
  out=$(oras repo tags "$ref" 2>&1)
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    # A package that has never been published has no tags — normal for an app
    # added in the same commit that first regenerates the catalog. Anything else
    # (auth, network, registry error) is fatal: an empty listing is
    # indistinguishable from "every pre-release was retired", and acting on it
    # would drop live versions out of the public index.
    if grep -qiE 'not found|name unknown|repository name not known' <<<"$out"; then
      echo "note: $ref has no published tags yet" >&2
      return 0
    fi
    echo "$out" >&2
    die "failed to list tags for $ref (oras exit $status) — refusing to emit a partial catalog"
  fi
  printf '%s\n' "$out"
}

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
  [[ "$version" =~ $SEMVER_RE ]] \
    || die "$name_dir: version '$version' in package.json is not semver (major.minor.patch[-prerelease]); channel resolution needs semver precedence"

  oci_repo="ghcr.io/$ORG/$name"

  # Pre-release tags live only in the registry (published from a PR, never
  # merged into package.json), so listing them is the only way to see them.
  tags_json='[]'
  if [ "$DISCOVER" = true ]; then
    tags_json="$(list_registry_tags "$oci_repo" \
      | { grep -E "$SEMVER_RE" || true; } \
      | jq -R . | jq -s -c .)"
  fi

  # Resolve versions[]: the repo's stable, plus every registry pre-release newer
  # than it, newest first, each tagged with its channel.
  versions_result="$(jq -n \
    --arg repo_version "$version" \
    --argjson tags "$tags_json" \
    --arg oci_repo "$oci_repo" '
    def parse:
      capture("^(?<maj>[0-9]+)\\.(?<min>[0-9]+)\\.(?<pat>[0-9]+)(?:-(?<pre>[0-9A-Za-z.-]+))?$");
    # Semver precedence as a comparable jq array. A release outranks any
    # pre-release of the same number (flag 1 > 0); within a pre-release,
    # identifiers compare element-wise — numeric ones numerically and below
    # alphanumeric ones (jq orders numbers before strings), and a shorter
    # identifier list below a longer one sharing its prefix.
    def key:
      parse
      | [ (.maj | tonumber), (.min | tonumber), (.pat | tonumber),
          (if .pre == null then 1 else 0 end),
          (if .pre == null then []
           else (.pre | split(".") | map(if test("^[0-9]+$") then tonumber else . end))
           end) ];
    def is_pre: parse | .pre != null;
    # Channel = the alphabetic prefix of the first prerelease identifier,
    # lower-cased: 0.11.0-rc.1 -> rc, 2.0.0-Beta.3 -> beta. An identifier with no
    # alphabetic prefix (1.0.0-1) yields "", which the caller rejects.
    def channel_of:
      parse | .pre | split(".")[0] | ([scan("^[A-Za-z]+")] | .[0] // "") | ascii_downcase;

    ([$repo_version] + $tags
      | map(select(test("^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$")))
      | unique) as $all
    # The repo decides stable. Only when package.json itself holds a pre-release
    # (an rc merged to main) does the newest released registry tag stand in.
    | (if ($repo_version | is_pre | not) then $repo_version
       else ($all | map(select(is_pre | not)) | sort_by(key) | last)
       end) as $stable
    | if $stable == null then { error: "no released version to list as stable" }
      else
        ($all
          | map(select(is_pre))
          | map(select(key > ($stable | key)))
          | sort_by(key) | reverse) as $prereleases
        | { versions: ([$stable] + $prereleases
            | map({ version: .,
                    channel: (if is_pre then channel_of else "stable" end),
                    refs: { oci: ($oci_repo + ":" + .) } })) }
      end')"

  err="$(jq -r '.error // empty' <<<"$versions_result")"
  [ -z "$err" ] \
    || die "$name: $err — package.json pins the pre-release '$version' and $oci_repo publishes no release tag. Publish a release, or restore a released version in package.json."

  # The server drops a malformed channel (it never defaults it to stable), so a
  # bad marker would silently make the version invisible on every host. Assert
  # the grammar here, where it fails loudly instead.
  while IFS= read -r channel; do
    [[ "$channel" =~ $CHANNEL_NAME_RE ]] \
      || die "$name: derived channel '$channel' does not match the channel grammar $CHANNEL_NAME_RE (a prerelease identifier with no alphabetic prefix?)"
  done < <(jq -r '.versions[].channel' <<<"$versions_result")

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
    --argjson versions "$(jq -c '.versions' <<<"$versions_result")" \
    '{
      id: $id,
      name: (if $name != "" then $name else $id end),
      description: (if $desc != "" then $desc else $pkgdesc end),
      icon: (if $icon != "" then $icon else "📦" end),
      category: (if $category != "" then $category else "apps" end),
      tags: $tags,
      versions: $versions
    }')"
  apps+=("$app_json")
done

if [ "${#apps[@]}" -eq 0 ]; then
  printf '{\n  "apps": []\n}\n' > "$OUTPUT"
else
  printf '%s\n' "${apps[@]}" | jq -s '{ apps: . }' > "$OUTPUT"
fi

echo "Wrote $OUTPUT (${#apps[@]} app(s))"
