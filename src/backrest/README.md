# Backrest (Hola app package)

[Backrest](https://github.com/garethgeorge/backrest) is a web UI + scheduler over
the [restic](https://restic.net/) backup engine (encrypted, deduplicated,
incremental snapshots to local, SFTP, S3/B2/GCS/Azure, rclone, …).

## How it works on Hola

Backrest is Hola's **backup provider**: its manifest declares
`provides: ["backup@1"]`, the capability contract for "capture an app's data
consistently". Two things follow from that declaration.

**The grant.** Hola injects read-only access to every installed app's data at
deploy time — the same path inside the container as on the host (default
`/srv/hola/apps`), one sub-directory per app (`<deploymentId>/…`). That is
elevated access, so Hola discloses it in the install wizard and injects it **only
if you consent**. The bundle cannot grant it to itself, and uninstalling revokes
it.

**The broker.** Apps that declare `accepts: ["backup@1"]` opt in to being backed
up, and some need work done around the copy — a `pg_dump` before, a cleanup after.
Backrest never reaches into another app to do that. It *announces* the start and
end of a run, and Hola runs each accepting app's hooks inside that app's own
containers. See [Consistent backups](#consistent-backups-wire-up-the-hooks).

After installing, open the Backrest UI and:

1. **Add a repository** — your off-site destination (S3/B2/SFTP/…) and an
   **encryption password**. Keep that password safe; without it the backups are
   unrecoverable.
2. **Add a backup plan** — point it at the apps data root (default
   `/srv/hola/apps`), set a schedule and retention. One plan captures every app.
3. **Wire up the hooks** — see below. Without them a scheduled run copies live
   database files.
4. Restore is whole-directory or per-path (restic supports restoring a single
   app's `<deploymentId>/` subtree).

## Consistent backups: wire up the hooks

A file-level copy of a running database is crash-consistent at best. Hola fixes
that by running each app's own pre/post hooks around the capture — but it has to be
told when the capture starts and ends, and only Backrest knows that.

This bundle installs two scripts for the purpose:

| Script | Backrest hook condition | Error behavior |
| --- | --- | --- |
| `/config/hola/backup-prepare.sh` | `CONDITION_SNAPSHOT_START` | **`ON_ERROR_CANCEL`** |
| `/config/hola/backup-finalize.sh` | `CONDITION_SNAPSHOT_END` | `ON_ERROR_IGNORE` |

Add both as **Command** hooks on the repo (or on an individual plan) in the
Backrest UI, with the command set to the script path.

`backup-prepare.sh` asks Hola to run every accepting app's `preHook` and waits for
them to finish before returning, so restic starts reading only once the dumps are
on disk. `backup-finalize.sh` runs the `postHook`s — removing those dumps — and
fires on both success and failure, so cleanup isn't skipped by a failed run.

**Why `ON_ERROR_CANCEL` on the start hook.** The contract is deliberately
*fail-closed*: if Hola can't be reached, or an app's dump fails, the correct
outcome is **no snapshot** rather than one that looks fine and cannot be restored.
A cancelled backup is loud; a silently inconsistent one isn't.

The scripts authenticate with a **contract-scoped token** Hola injects into this
container (`HOLA_CONTRACT_TOKEN`). It carries exactly one capability — announcing a
backup — and nothing else: no ability to read, install or reconfigure anything else
through the API. It is minted when this app is installed and revoked when it's
removed.

## Upgrading from 1.x

1.x declared `consumes: apps-data` to get its read-only view of app data. 2.0
declares `provides: ["backup@1"]` instead. That is the same access arriving through
the contract, but now **disclosed to you for consent at install** rather than only
to whoever reviewed the bundle. Expect a permission prompt when you promote; the
app keeps the mount only if you approve it.

2.0 also adds the hook scripts above. They're new files under `/config/hola/` —
your existing repos, plans, schedules and Backrest config are untouched, and the
hooks do nothing until you add them in the UI.

## Notes

- **Trust:** Backrest can read all app data and holds your destination
  credentials + encryption key. The UI is gated behind Hola SSO (`forward-auth`).
- **Coverage:** Hola's dashboard lists which installed apps accept `backup@1` and
  which don't. An app that accepts nothing reads as **uncovered** — worth checking
  after installing something new.
- **Scope:** app data roots only. Backing up Hola's own control-plane state
  (`/data`) is not included yet.
