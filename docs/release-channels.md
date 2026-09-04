# Release channels

How this repository publishes a **pre-release** bundle — an `rc`, `beta` or `alpha` version
of an app that operators can install deliberately without it becoming everyone's default.

The platform side is [try-hola/hola ADR 0005](https://github.com/try-hola/hola/blob/main/docs/adr/0005-release-channels.md);
this document is the publishing side of the same contract.

## The contract the Hola server reads

Each `catalog.json` `versions[]` entry may carry a `channel`:

```jsonc
{ "id": "remo",
  "versions": [
    { "version": "0.10.1",      "channel": "stable", "refs": { "oci": "ghcr.io/try-hola/remo:0.10.1" } },
    { "version": "0.11.0-rc.1", "channel": "rc",     "refs": { "oci": "ghcr.io/try-hola/remo:0.11.0-rc.1" } }
  ] }
```

| Rule | Consequence for this repo |
| --- | --- |
| `channel` is optional; absent or `null` ⇒ `stable`. | We emit it **explicitly on every entry**, `stable` included, so the file states its own meaning rather than relying on a default. |
| Grammar `^[a-z][a-z0-9-]{0,31}$`. A value outside it **drops the entry** — it is never promoted to `stable`. | A typo doesn't publish an rc as everyone's default; it makes the version invisible. So the marker is asserted twice here: `bin/build-catalog.sh` fails as it emits, `bin/validate-catalog.mjs` fails on the finished file. |
| A version string listed twice keeps the first entry. | The generator emits each version exactly once. |
| `stable` is the floor every channel is offered; the browse card and the default install always resolve to the newest stable. | Every app must have a stable entry — `validate-catalog.mjs` fails an app that has none. |
| Ordering is semver precedence (`1.3.0 > 1.3.0-rc.10 > 1.3.0-rc.9`), never list position. | The generator sorts by the same precedence rather than by string. |

The channel is a fact about the **listing**, not about the bundle: `manifest.json` is unchanged,
and a bundle can be re-listed from `rc` to `stable` without republishing it.

"Deploy the rc" means a **bundle pre-release** — `remo 0.11.0-rc.1`, whose `compose.yaml` pins the
matching upstream image and whose manifest carries the matching `upgrade` metadata — never an
image override on a stable bundle.

## Where the versions come from

Two different sources, on purpose:

| Entry | Source | Why |
| --- | --- | --- |
| **stable** | `src/<name>/package.json` | The repo is the source of truth for what is released. A release tag that exists in GHCR but not in `package.json` is **not** listed, so reverting a bad release in git retires it from the catalog even though the registry keeps the tag forever. |
| **pre-releases** | the tags of `ghcr.io/try-hola/<name>` (`oras repo tags`) | A pre-release is published **from a pull request** and its version is never merged into main's `package.json` — the registry is the only place it exists. |

**Retention: the newest stable, plus every pre-release strictly newer than it.** An rc retires
itself the moment it graduates: the release that supersedes it is newer by semver precedence, so
the rc drops out of the next regeneration. Nothing needs pruning by hand for the normal path.

**Channel names are derived**, not typed: the alphabetic prefix of the first prerelease
identifier, lower-cased. `0.11.0-rc.1` → `rc`, `2.0.0-beta.3` → `beta`, `1.5.0-alpha.1` → `alpha`.
A pre-release with no alphabetic prefix (`1.0.0-1`) has no channel name and fails the build.

`bin/build-catalog.sh` takes `CATALOG_PRERELEASES=auto|require|skip`:

- `auto` (default) — discover when the ORAS CLI is installed; warn loudly and emit a stable-only
  catalog when it isn't. For local runs.
- `require` — discovery is mandatory. **CI uses this on main**: a missing ORAS CLI or a failed tag
  listing fails the workflow, because an empty listing is indistinguishable from "every
  pre-release was retired" and acting on it would drop live versions out of the public index.
- `skip` — never contact the registry; stable entries only.

The only tolerated listing failure is "this package has never been published", which is normal for
an app added in the same commit.

## Publishing an rc

```
                      PR: bump to 0.11.0-rc.1              merge: bump to 0.11.0
src/remo/package.json  ─────────────────────────► (stays 0.10.1 on main) ──────────► 0.11.0
GHCR tags              0.10.1, latest ──► + 0.11.0-rc.1 (`:latest` untouched)
catalog.json           0.10.1 stable  ──► 0.10.1 stable + 0.11.0-rc.1 rc ─────────► 0.11.0 stable
```

1. **Bump to a pre-release.** Run the *Automatic Version Bump* workflow with
   `bump: preminor` (or `prerelease` for the next rc of an existing one) and
   `identifier: rc`. It moves `package.json` **and** `src/manifest.json` and opens a PR. Edit the
   PR to pin the upstream pre-release image and update the manifest's `upgrade`/`backup` metadata,
   exactly as for a release.
2. **The PR publishes the bundle.** `build-and-publish.yml` publishes changed packages whose
   version is a pre-release straight from the pull request — `ghcr.io/try-hola/remo:0.11.0-rc.1`,
   with the moving tag suppressed. Release versions still publish only on merge to `main`.
   (Fork PRs are skipped: `GITHUB_TOKEN` is read-only there.)
3. **Leave the PR open.** Main's `package.json` stays on the released version, which is what keeps
   `0.10.1` the stable entry while the rc is being tried.
4. **The rc joins the catalog on the next regeneration from `main`** — any merge to main, or the
   *Build and Publish* workflow run manually (`workflow_dispatch`) on main, which exists as the
   button for exactly this. Operators then get it with
   `hola install remo --channel rc --as remo-rc`.
5. **Graduate or retire.** To graduate, bump the same PR to the release version (`0.11.0`) and
   merge it: the release publishes on main, moves `:latest`, becomes the stable entry, and the rc
   drops out by the retention rule. To abandon an rc, close the PR and delete that version of the
   GHCR package — the tag is the only thing keeping it in the index.

## Why `:latest` is never moved for a pre-release

`:latest` is what an unpinned `oras pull` resolves to. `bin/push-oci-package.sh` therefore refuses
to move it whenever the version contains a `-`, whatever its `moving-tag` argument says, and CI
passes `none` on PR publishes as well — two independent guards, because the failure mode is
silent and global: an rc would become the default bundle for every install.

## What CI checks

| Job | Checks |
| --- | --- |
| `validate-catalog` (PRs) | Every manifest, plus `catalog.json` against `schemas/catalog.schema.json`: the channel grammar, one `stable` entry per app, no repeated version, no pre-release listed as stable, and `refs.oci` tagged with the version it claims. |
| `build-catalog` (main) | Regenerates the index with `CATALOG_PRERELEASES=require` and validates it again before committing, so a malformed marker can't reach the hosted index through a bot commit no pull request reviewed. |
