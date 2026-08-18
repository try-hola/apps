# Backrest (Hola app package)

[Backrest](https://github.com/garethgeorge/backrest) is a web UI + scheduler over
the [restic](https://restic.net/) backup engine (encrypted, deduplicated,
incremental snapshots to local, SFTP, S3/B2/GCS/Azure, rclone, …).

## How it works on Hola

Hola grants Backrest **read-only access to every installed app's data** by
injecting a mount of the apps root at deploy time. That access is the provider
grant of the `backup@1` capability contract (the manifest declares
`provides: ["backup@1"]`), so Hola discloses it during install and only injects the
mount once the operator consents. Inside the container the path is the same as on
the host (default `/srv/hola/apps`), with one sub-directory per app
(`<deploymentId>/…`).

After installing, open the Backrest UI and:

1. **Add a repository** — your off-site destination (S3/B2/SFTP/…) and an
   **encryption password**. Keep that password safe; without it the backups are
   unrecoverable.
2. **Add a backup plan** — point it at the apps data root (default
   `/srv/hola/apps`), set a schedule and retention. One plan captures every app.
3. Restore is whole-directory or per-path (restic supports restoring a single
   app's `<deploymentId>/` subtree).

## Database-consistent backups (recommended)

A file-level copy of a **running** database is crash-consistent, not
transaction-consistent: Postgres usually recovers such a copy from its WAL, but
"usually" is a poor property for the thing you only use after losing the original.
Apps that need a dump first declare `backup` hooks in their own manifests, and
Hola runs them **in that app's own containers** — Backrest never touches another
app, and needs to know nothing about which apps are installed.

Wire it up with two hooks in the Backrest UI (Plan → Hooks). Hola injects
`HOLA_API_URL` and `HOLA_CONTRACT_TOKEN` into this container; the token authorizes
these two endpoints and nothing else.

**1. On `CONDITION_SNAPSHOT_START` — action: Command, error behavior:
`ON_ERROR_CANCEL`**

```sh
set -eu
resp="$(curl -sf -X POST -H "X-API-Key: $HOLA_CONTRACT_TOKEN" "$HOLA_API_URL/api/contracts/backup/prepare")"
job="$(printf '%s' "$resp" | sed -n 's/.*"jobId":"\([^"]*\)".*/\1/p')"
[ -n "$job" ] || exit 0   # no installed app needs quiescing; nothing to wait for
while :; do
  status="$(curl -sf -H "X-API-Key: $HOLA_CONTRACT_TOKEN" "$HOLA_API_URL/api/contracts/backup/status/$job" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')"
  case "$status" in
    completed) exit 0 ;;
    failed|cancelled) echo "hola: pre-backup hooks failed; aborting snapshot" >&2; exit 1 ;;
  esac
  sleep 5
done
```

**2. On `CONDITION_SNAPSHOT_END` — action: Command, error behavior:
`ON_ERROR_IGNORE`**

```sh
curl -sf -X POST -H "X-API-Key: $HOLA_CONTRACT_TOKEN" "$HOLA_API_URL/api/contracts/backup/finalize" || true
```

Why those error behaviors:

- **Start is fail-closed** (`ON_ERROR_CANCEL`). `set -eu` plus `curl -sf` means an
  unreachable Hola, an auth failure, or a failed `pg_dump` all exit non-zero and
  cancel the snapshot. A backup you believe is transaction-consistent but isn't is
  worse than one that visibly didn't run.
- **End is best-effort** (`ON_ERROR_IGNORE`). It only removes the dump files the
  start hook created; the snapshot already happened, and failing the plan over
  cleanup would turn a good backup into a red one. Hola also cleans up on its own
  when the start hook fails partway.

Without these hooks Backrest still works — you get crash-consistent copies, which
is exactly right for SQLite and flat-file apps and is what every app got before.

## Notes

- **Trust:** Backrest can read all app data and holds your destination
  credentials + encryption key. The UI is gated behind Hola SSO (`forward-auth`).
- **Scope (v1):** app data roots only. Backing up Hola's own control-plane state
  (`/data`) is not included yet.
- **Requires** a Hola host running the release that ships the contract broker
  (try-hola/hola#418). On an older server the `provides` declaration is ignored and
  the apps-data mount falls back to the legacy path, so the app still installs and
  backs up — just without the hooks.
