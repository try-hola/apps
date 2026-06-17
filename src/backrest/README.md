# Backrest (Hola app package)

[Backrest](https://github.com/garethgeorge/backrest) is a web UI + scheduler over
the [restic](https://restic.net/) backup engine (encrypted, deduplicated,
incremental snapshots to local, SFTP, S3/B2/GCS/Azure, rclone, …).

## How it works on Hola

Hola grants Backrest **read-only access to every installed app's data** by
injecting a mount of the apps root at deploy time (the manifest declares
`consumes: apps-data`). Inside the container that path is the same as on the host
(default `/srv/hola/apps`), with one sub-directory per app (`<deploymentId>/…`).

After installing, open the Backrest UI and:

1. **Add a repository** — your off-site destination (S3/B2/SFTP/…) and an
   **encryption password**. Keep that password safe; without it the backups are
   unrecoverable.
2. **Add a backup plan** — point it at the apps data root (default
   `/srv/hola/apps`), set a schedule and retention. One plan captures every app.
3. Restore is whole-directory or per-path (restic supports restoring a single
   app's `<deploymentId>/` subtree).

## Notes

- **Trust:** Backrest can read all app data and holds your destination
  credentials + encryption key. The UI is gated behind Hola SSO (`forward-auth`).
- **Consistency:** file-level snapshots of a running app are crash-consistent,
  not transaction-consistent. Most apps (and SQLite) restore fine; DB-backed apps
  may need a pre-backup dump — tracked in try-hola/hola#121.
- **Scope (v1):** app data roots only. Backing up Hola's own control-plane state
  (`/data`) is not included yet.
