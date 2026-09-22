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
containers. See [Consistent backups](#consistent-backups-the-hooks-wire-themselves).

After installing, open the Backrest UI and:

1. **Add a repository** — your off-site destination (S3/B2/SFTP/…) and an
   **encryption password**. Keep that password safe; without it the backups are
   unrecoverable.
2. **Add a backup plan** — point it at the apps data root (default
   `/srv/hola/apps`), set a schedule and retention. One plan captures every app.
3. That is all — the backup hooks wire themselves onto every repository you
   create. See [Consistent backups](#consistent-backups-the-hooks-wire-themselves).
4. Restore is whole-directory or per-path (restic supports restoring a single
   app's `<deploymentId>/` subtree).

## Consistent backups: the hooks wire themselves

A file-level copy of a running database is crash-consistent at best. Hola fixes
that by running each app's own pre/post hooks around the capture — but it has to be
told when the capture starts and ends, and only Backrest knows that.

This bundle installs two scripts for the purpose:

| Script | Backrest hook condition | Error behavior |
| --- | --- | --- |
| `/config/hola/backup-prepare.sh` | `CONDITION_SNAPSHOT_START` | **`ON_ERROR_CANCEL`** |
| `/config/hola/backup-finalize.sh` | `CONDITION_SNAPSHOT_END` | `ON_ERROR_IGNORE` |

**You do not have to add these yourself.** Backrest has no global hooks — a hook
hangs off a repository or a plan — so a script on disk does nothing until it is
attached to something, and at install time there is no repository yet. This
bundle therefore runs a small reconciler alongside Backrest that attaches both
hooks to every repository you create, through Backrest's own API, and keeps them
attached. A repository you add next month is wired within 30 seconds.

They attach at the **repository** level, which covers every plan backing onto
that repository — add as many plans as you like, the wiring is already done.

Before 2.1.0 this was a manual step, and skipping it was silent: the snapshot
still ran, it just copied live database files, while Hola's dashboard reported
the accepting apps as quiesced (#159). If you wired the hooks by hand on an
earlier version, nothing changes — the reconciler recognises them by command
path and leaves them alone.

**To manage the hooks yourself**, set `BACKREST_HOLA_AUTOWIRE=false` in the app's
configuration. Nothing is added and nothing already there is removed; add both as
**Command** hooks on the repository (or an individual plan) in the Backrest UI,
with the command set to the script path and the error behavior in the table above.

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

## Restoring: this app can hand a capture back (2.2.0)

Backing up and restoring are different promises, and until 2.2.0 this package
only made the first one. It now also declares `restore@1`, which lets Hola offer
your captures as a source when you install an app — including an app that no
longer exists on this host, which is the case that matters after you lose one.

**It needs its own consent at install.** `restore@1` is a separate contract from
`backup@1`, not a wider version of it, because it needs something `backup@1`
deliberately does not have: somewhere to write. Upgrading an existing install
does **not** grant it — Hola shows a new consent row and the provider gains
nothing until you accept it. Decline and this app keeps backing up exactly as
before, offering no captures.

**What it can write is one scratch directory.** Hola injects a writable mount of
its own restore staging root (a sibling of the apps root, not inside it) and
nominates a fresh destination per restore. This app never gets write access to
any app's data, and gains no read access it did not already have for backups.

**How it works.** A third component, `backrest-hola-restore`, asks Hola for
pending work every 30 seconds. Backrest's hooks only fire on snapshot start and
end, so there is no event here to react to — nothing in Backrest happens when an
install elsewhere wants a capture — which is why the provider polls rather than
being called. On startup and whenever Hola says it holds no index, it enumerates
your repositories and publishes a list of what it holds: **metadata only**, never
any backed-up bytes. Per capture it reads the small `.hola/instance.json` marker
Hola writes into every app's data root, so a capture can be attributed to the
right app rather than guessed at from its path; those reads are cached
permanently, since a snapshot never changes.

**Two knobs**, both advanced and both safe to leave alone:

- `BACKREST_HOLA_RESTORE` — `false` stops serving restores without uninstalling
  or withdrawing consent.
- `BACKREST_HOLA_RESTORE_MAX_SNAPSHOTS` — how far back to offer, newest first
  (default 25). The first index pass costs one small read per capture.

**What it deliberately will not do.** It cannot restore *itself* — the captures
are only readable with the repository password this app's own `/config` holds, so
restoring it from its own backup is circular. And on a brand-new host nothing can
be offered until you install this app and point it at your existing repository,
which needs that password: an operator-held secret Hola never has a copy of.

## Upgrading from 1.x

1.x declared `consumes: apps-data` to get its read-only view of app data. 2.0
declares `provides: ["backup@1"]` instead. That is the same access arriving through
the contract, but now **disclosed to you for consent at install** rather than only
to whoever reviewed the bundle. Expect a permission prompt when you promote; the
app keeps the mount only if you approve it.

2.0 also adds the hook scripts above, as new files under `/config/hola/`.

## Upgrading from 2.0.x

2.0 wrote the hook scripts but never registered them, so unless you wired them by
hand in the Backrest UI they never ran (#159) — and the dashboard reported the
accepting apps as quiesced anyway. 2.1 adds the reconciler that registers them
for you. On first start after the upgrade it adds both hooks to every existing
repository; if you already wired them by hand, it recognises them and leaves them
alone. Your repos, plans, schedules, retention and encryption passwords are
untouched.

## Notes

- **Trust:** Backrest can read all app data and holds your destination
  credentials + encryption key. The UI is gated behind Hola SSO (`forward-auth`).
- **Coverage:** Hola's dashboard lists which installed apps accept `backup@1` and
  which don't. An app that accepts nothing reads as **uncovered** — worth checking
  after installing something new.
- **Scope:** app data roots only. Backing up Hola's own control-plane state
  (`/data`) is not included yet.
