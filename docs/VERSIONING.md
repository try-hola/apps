# Versioning & updates

How catalog packages are versioned, how we pin upstream images, and how we handle
updates to the underlying projects. (The migration-safety machinery this references
is being designed in [try-hola/hola#284](https://github.com/try-hola/hola/issues/284);
[try-hola/apps#45](https://github.com/try-hola/apps/issues/45) tracks annotating the
existing bundles.)

## Two version numbers, decoupled

Every package carries two independent versions:

| | Where | Whose number |
| --- | --- | --- |
| **Upstream project version** | the `image:` pin in `compose.yaml` (e.g. `ghcr.io/get2knowio/hangar:0.1.0`) | theirs |
| **Bundle / catalog version** | `package.json` `version` (e.g. `1.0.0`) | **ours** |

`bin/build-catalog.sh` reads the version from **`package.json`** — that's the OCI tag CI
publishes (`ghcr.io/try-hola/<name>:<version>`) and the version the Hola server resolves
against. (`manifest.json` keeps a copy of `version`; keep the two in sync.) The two lineages
are unrelated — uptime-kuma is bundle `1.2.1` on image `1.23.16`; hangar is bundle `1.0.0` on
image `0.1.0`.

## Pinning the project image

The compose validator (`@hola/shared/compose-validate`) **requires every service image to be
pinned** — it runs at publish time and on the server at deploy:

- **No tag** (implicit `:latest`) → error `IMAGE_MISSING_TAG`
- **A floating tag** — `latest`, `stable`, `edge`, `nightly`, `rolling`, `current`, `lts` → error `IMAGE_MUTABLE_TAG`
- **A specific version tag** (`:1.23.16`) → ✅
- **An `@sha256:` digest** → ✅ (and bypasses the tag check — a digest is immutable)

So a service needs **either a specific immutable tag or a digest**. Prefer **tag + digest** for
the project container (`ghcr.io/get2knowio/hangar:0.1.0@sha256:…`): even if upstream re-pushes the
same tag onto a different build, the digest keeps every install on the exact image we verified.
(The validator also rejects `build:`-only services — catalog apps must reference a **prebuilt,
published** image.)

## Bumping the bundle version (semver from the *Hola user's* perspective)

Our semver describes the impact of the change on **the person who installs the bundle**, not a
mirror of upstream's numbers. The bump type is a deliberate choice (the
`Automatic Version Bump` workflow offers patch/minor/major):

| Change | Bump |
| --- | --- |
| Packaging-only fix, same image (healthcheck, perms, env tweak) | **patch** |
| Bump the image pin to an upstream patch/minor that's a transparent drop-in | **patch / minor** |
| Update that needs user action — new required env, breaking config, a data migration | **minor / major**, *regardless of what upstream called it* |
| Remove/rename something users depend on, or anything not safe to auto-apply | **major** |

The asymmetry is the point: an **upstream major can be a drop-in for us** (new pin → our minor),
while an **upstream patch can be breaking for us** (it adds a required env var → our major). We
**translate**, not mirror. Because images are pinned, the only way an install's image changes is
when we cut a new bundle version — so our semver fully owns the "what changed for you" signal.

## When the underlying project releases

1. Update the `image:` pin (tag **and** digest) in `compose.yaml`.
2. Update any **infra the new version needs** in the same bundle — a coupled sidecar (e.g.
   Immich's pgvecto-rs→VectorChord DB image, Paperless's Gotenberg 7→8), a bundled-datastore
   major, new/renamed env. **Validate the upgrade path on a disposable VM** (install the old
   version → real data → upgrade → confirm the app migrates and comes up), not just a fresh
   install.
3. Bump the bundle version by **impact** (table above).
4. Note breaking/migration steps in the package `README.md`.

## Upgrade hazards

Most apps migrate their own DB on boot, so a tag bump "just works" — but several patterns break a
naive bump-to-latest. Until the structured metadata from
[try-hola/hola#284](https://github.com/try-hola/hola/issues/284) ships (`breaking`,
`minFromVersion`, `waypoints[]`, bundled-datastore `majorVersion`, `sidecarTransform`,
`preUpgradeBackup`, …), capture these in the package **README** and reflect them in the bundle
**major** number:

- **Forward-only / no-downgrade** — once the app migrates the schema, rolling the image back boots
  old code against a new schema (refuse-to-start or corruption). Rollback = restore a backup.
- **No version skipping** — some projects forbid jumping (Nextcloud: one major at a time; Immich:
  version floors + mandatory waypoints). Don't ship a bundle that lets a user skip the chain.
- **Bundled-datastore major bump** — the official `postgres` image does **not** auto-migrate across
  majors; a 16→17 tag bump on a populated volume **refuses to start**. Pin a bundled datastore's
  major deliberately and treat a major change as a migration, not a tag bump. (Affects every app
  that bundles its own Postgres — Immich, Postiz, …)
- **Back up first** — because the above are largely irreversible, advise a backup (e.g. via the
  `backrest` app) before a breaking upgrade.

See [try-hola/hola#284](https://github.com/try-hola/hola/issues/284) for the full hazard taxonomy
and the planned server-side enforcement (skip-guards, pre-upgrade snapshots, data-aware rollback,
migration hooks).

## Pre-publish checklist

- [ ] `compose.yaml` images pinned (tag **+** digest for the project container).
- [ ] `package.json` and `manifest.json` `version` match, bumped by **impact on the user**.
- [ ] Upgrade path tested on a VM (not just fresh install) if the image moved.
- [ ] Breaking/migration notes in the package `README.md`; breaking ⇒ **major** bump.
