# Runbook

Operational procedures for the Aktivacity Portal on the internal server.

> **Status:** backups and restore are implemented (brief §44–45) and the
> scripts have been exercised against a real PostgreSQL 17 cluster and a local
> restic repository. They are **not yet rehearsed on the production server
> with its NAS**. Do not treat this as a tested recovery plan until the full
> rebuild drill under "Restore" has been done there once and timed.

---

## First deployment

1. **Prepare the host.** Docker Engine + Compose plugin. Confirm free disk on
   the volume that will hold `storage` — project files grow fast (see the plan's
   file-volume note).

2. **Configure.**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and change **every** password and `PORTAL_HOSTNAME`.

3. **Point the hostname at the server.** Add an A record for
   `portal.aktivacity.local` on the internal DNS, or a `hosts` entry on each
   workstation. It must match `PORTAL_HOSTNAME` exactly or the certificate will
   not validate. The portal answers on that name only; `https://192.168.x.x/`
   is not served, by design — a name is what the certificate is issued for,
   and one DNS record is easier to move to new hardware than a hundred
   bookmarks. If the network has no internal DNS, the `hosts` entry is the
   route, and the brief's "http://192.168.x.x/" example (§40) is met by the
   name resolving to that address.

4. **Start.**
   ```bash
   docker compose up -d --build
   ```
   `migrate` runs to completion before `app` starts; `app` will not start if
   migrations fail.

5. **Seed the first administrator.**
   ```bash
   docker compose --profile seed run --rm seed
   ```
   Log in and change the password immediately — the account is flagged
   `must_change_password`.

6. **Verify.**
   ```bash
   curl -sk https://portal.aktivacity.local/api/health
   ```
   Expect `{"status":"ok","database":"reachable","migrationsApplied":1,...,"jobs":{...}}`.
   Each entry under `jobs` reads `"stale": true` until that job's first
   night (see "Scheduled jobs" below).

---

## Trusting the internal certificate

Caddy issues certificates from its own local CA, so browsers show a warning
until the root is installed once per workstation.

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./aktivacity-root.crt
```

- **Windows:** double-click → Install Certificate → Local Machine → Trusted Root
  Certification Authorities.
- **macOS:** open in Keychain Access → System → set to *Always Trust*.
- **Linux:** copy to `/usr/local/share/ca-certificates/` and run
  `update-ca-certificates`.

---

## Routine operations

| Task | Command |
|---|---|
| Logs | `docker compose logs -f app` |
| Restart the app | `docker compose restart app` |
| Apply new migrations | `docker compose up migrate` |
| Health | `curl -sk https://$PORTAL_HOSTNAME/api/health` |
| Open a psql shell | `docker compose exec postgres psql -U $POSTGRES_USER -d $POSTGRES_DB` |
| Stop everything | `docker compose down` (volumes are preserved) |
| Scheduler logs | `docker compose logs -f scheduler` |
| Purge expired files now | `docker compose run --rm scheduler sweep-now` (or `docker compose --profile ops run --rm sweep`) |
| File recurring orders now | `docker compose run --rm scheduler recurring-now` (or `--profile ops run --rm recurring`) |
| Run tonight's housekeeping now | `docker compose run --rm scheduler nightly-now` (or `--profile ops run --rm nightly`) |
| Job health | `curl -sk https://$PORTAL_HOSTNAME/api/health \| jq .jobs` |
| Back up now | `docker compose run --rm backup backup-now` |
| Rehearse a restore now | `docker compose run --rm backup verify-now` |
| What can be restored | `docker compose run --rm backup list` |
| Backup health | `cat backups/status/last-success.json` |

**Deploying a change:** `git pull && docker compose up -d --build`. Migrations
apply automatically before the new app container accepts traffic.

---

## Backup

Per brief §44. Everything runs in the `backup` service (`docker/backup/`,
scripts in `scripts/backup/`), which `docker compose up -d` starts with the
rest.

**What runs, and when.**

| When | What |
|---|---|
| Nightly, `BACKUP_SCHEDULE` (default `30 2 * * *`) | `pg_dump --format=custom` of the portal database, checked with `pg_restore --list` before it counts; local dump retention; restic snapshot of the file store and of the dumps to the off-box repository; `restic forget --prune` |
| Weekly, `VERIFY_SCHEDULE` (default `30 4 * * 0`, Sunday) | Restore rehearsal — see below |
| Nightly, `scheduler` service, `SWEEP_SCHEDULE` (default `0 2 * * *`), **before** the backup | Retention sweep |
| Nightly, `scheduler` service, `RECURRING_SCHEDULE` (default `15 2 * * *`) | Recurring projects |
| Nightly, `scheduler` service, `NIGHTLY_SCHEDULE` (default `20 2 * * *`), after the recurring run, **before** the backup | Deadline reminders and the month archive |

Schedules are in `BACKUP_TZ` (default UTC): the scheduler and the backup share
it, so "02:00 sweep, 02:30 backup" is the same night for both. See "Scheduled
jobs" below for the jobs themselves.

**What is covered.**

- The portal database, whole: schema, data, the `_migrations` ledger.
- The file store (`storage` volume), read-only mount.
- The dumps themselves, so the off-box copy carries the database too.

**What is not.** `.env` (keep a copy in the password manager — it holds the
database and restic passwords), the Caddy CA (`caddydata`: a rebuild issues a
new root, so workstations re-trust it), and the host itself. The repo is on
git.

**Where it goes.**

| | Location | Retention |
|---|---|---|
| Dumps | `./backups/db/aktivacity-<UTC timestamp>.dump` on the server | `BACKUP_KEEP_DAYS` days (14), never fewer than the newest `BACKUP_KEEP_MIN` (7) |
| Off-box | restic repository at `RESTIC_REPOSITORY`: the NAS / second disk mounted on the host at `BACKUP_REPO_HOST_DIR` (seen as `/repo`), or an `sftp:` / `rest:` URL | 7 daily, 4 weekly, 12 monthly (`RESTIC_KEEP_*`) |
| Status | `./backups/status/*.json`, also mounted read-only into `app` at `/backups/status` | latest only |

The repository is encrypted with `RESTIC_PASSWORD`. **Lose that password and
the off-box copy is unreadable.** Keep it in the password manager, not only in
`.env` on the server it is meant to outlive.

**The off-box copy is the backup, and file backups are mandatory (brief
§44).** With `RESTIC_REPOSITORY` unset the job still dumps the database
locally and keeps that dump, but the run **fails** (`"status": "failed"`,
`"offsite": "unconfigured"`, exit 1) and the dashboard says file backups are
not configured: the uploaded files are not backed up anywhere. The only way
to run without them is the explicit `BACKUP_FILES_DISABLED=1` in `.env`,
which records `"status": "disabled"` and exits 0 — database dumps only, and
the dashboard says so. Set it only when the files are backed up by other
means you can name (a NAS that snapshots the storage volume itself, say), and
remove it the moment a repository is configured. A local-path repository on
the same filesystem as `./backups` reports `degraded`, and if no repository
exists there yet the run **fails** rather than create one on the local disk —
that is what an unmounted NAS looks like. The Compose fallback for `/repo`,
`./backups/restic-NOT-OFFSITE`, is on this box's own disk and is not a backup.

Upgrading an install that had no `RESTIC_REPOSITORY`: its nightly run goes
from `degraded` (exit 0) to `failed` (exit 1) with this version until the
repository, or the opt-out, is set.

### The file store without Docker

In the Docker deployment the file store is a named volume nothing else
mounts, which is what keeps brief §43 true: the portal is the only way to a
file. On a plain `npm` install `STORAGE_ROOT` is an ordinary directory, so
make it one only the portal's own user can enter, and never share it over
SMB or AFP:

```bash
sudo chown -R aktivacity:aktivacity /var/lib/aktivacity/storage
sudo chmod 700 /var/lib/aktivacity/storage
```

Backups read it as that same user (below).

### Backups without Docker

The same scripts run on a plain `npm` install (macOS/Linux; on Windows run
them from Git Bash or WSL, or use the Docker deployment). They read the
portal's `.env`: `DATABASE_URL` gives the connection, `STORAGE_ROOT` the file
store, `BACKUP_DIR` (default `./backups`) the dumps and `BACKUP_STATUS_DIR`
(default `./backups/status`) the status files the dashboard and
`/api/health` read. `pg_dump` is taken from `PATH`, then from the newest
Homebrew, Postgres.app or apt install; set `PG_BIN` otherwise. It must be at
least as new as the server.

| Command | What |
|---|---|
| `npm run backup` | `pg_dump` into `BACKUP_DIR/db`, checked with `pg_restore --list`; local retention; restic off-box copy when `RESTIC_REPOSITORY` is set |
| `npm run backup:verify` | Restores the newest dump into a scratch database (`VERIFY_DB`, default `aktivacity_restore_check`; the role needs `CREATEDB`), compares row counts with the live database, then checks the off-box copy under the same rule as `npm run backup` (below) |
| `npm run backup:list` | Local dumps, restic snapshots and the status files |

Without `RESTIC_REPOSITORY` (e.g. `/Volumes/BackupDisk/aktivacity-restic`
plus `RESTIC_PASSWORD`; `brew install restic`) every run still dumps the
database but is recorded `failed` with `offsite: unconfigured`, because the
uploaded files are not backed up and a dump on the same disk is not a backup
(brief §44). The dashboard then says file backups are not configured;
`npm start` refuses to start and `npm run dev` warns. The explicit opt-out is
`BACKUP_FILES_DISABLED=1` in `.env` — database dumps only, recorded
`disabled` — for a machine whose files are backed up some other way. The
weekly `npm run backup:verify` applies the same rule: the dump is still
restored and compared, then the rehearsal is recorded `failed` with
`offsite: unconfigured` (exit 1), or `ok` with `offsite: disabled` under the
opt-out. Check `backups/backup.log` or `npm run backup:list` yourself in the
meantime.

Nothing is automatic until it is scheduled. With `crontab -e` (cron's `PATH`
is minimal, so name the folder `node` and `npm` live in):

```
PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
30 2 * * * cd /path/to/portal && mkdir -p backups && npm run backup >> backups/backup.log 2>&1
30 4 * * 0 cd /path/to/portal && npm run backup:verify >> backups/verify.log 2>&1
```

macOS keeps cron out of `~/Desktop`, `~/Documents` and `~/Downloads`: a portal
or restic target there fails with "Operation not permitted" before anything
is logged or recorded. Keep the portal elsewhere (e.g. `~/aktivacity-portal`)
or give `/usr/sbin/cron` Full Disk Access (System Settings → Privacy &
Security). A launchd alternative is
`~/Library/LaunchAgents/local.aktivacity.backup.plist` (runs while that user
is logged in; use `/Library/LaunchDaemons` with a `UserName` key to run
regardless):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.aktivacity.backup</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>-lc</string>
    <string>cd /path/to/portal &amp;&amp; mkdir -p backups &amp;&amp; npm run backup &gt;&gt; backups/backup.log 2&gt;&amp;1</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>2</integer><key>Minute</key><integer>30</integer></dict>
</dict></plist>
```

then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.aktivacity.backup.plist`;
a second plist with `Weekday` 0, `Hour` 4, `Minute` 30 and `npm run
backup:verify` covers the rehearsal. On Windows use Task Scheduler: a daily
task at 02:30 running `C:\Program Files\Git\bin\bash.exe` with the arguments
`-lc "cd /c/path/to/portal && npm run backup >> backups/backup.log 2>&1"`
(needs Git for Windows), and a weekly one the same way with `npm run
backup:verify`.

### Setting up the NAS target

1. Mount the NAS share or second disk on the host through `/etc/fstab`, so it
   is there before Docker starts — e.g. `/mnt/nas/aktivacity-restic`.
2. In `.env`:
   ```bash
   BACKUP_REPO_HOST_DIR=/mnt/nas/aktivacity-restic
   RESTIC_REPOSITORY=/repo
   RESTIC_PASSWORD=<long random, also stored in the password manager>
   ```
   For a remote machine instead: `RESTIC_REPOSITORY=sftp:backup@nas:/aktivacity`
   (mount an SSH key into the container with a compose override) or
   `rest:https://nas:8000/aktivacity`.
   For cloud storage: `RESTIC_REPOSITORY=s3:<endpoint>/<bucket>` with
   `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_DEFAULT_REGION`. This
   works with any S3-compatible service. Alternatively use
   `RESTIC_REPOSITORY=b2:<bucket>:<path>` with `B2_ACCOUNT_ID` and
   `B2_ACCOUNT_KEY`. Only the backup needs internet access; the portal does
   not. The data is encrypted with `RESTIC_PASSWORD` before it leaves the
   server.
   Once the repository is set, `BACKUP_FILES_DISABLED` must NOT be set (it
   is ignored with a warning while `RESTIC_REPOSITORY` is set, but remove it
   so a later edit cannot silently turn file backups off).
3. `docker compose up -d backup`, then run one now (below). The first run
   creates the repository.

If the NAS is remounted while the stack is up, `docker compose restart backup`
— a container keeps the mount point it started with.

### Running one now

```bash
docker compose run --rm backup backup-now
```

Exit 0 on `ok`, `degraded` or `disabled`, 1 on failure — including
`RESTIC_REPOSITORY` unset without `BACKUP_FILES_DISABLED=1` (`unconfigured`).
Runs are serialised by a lock in `backups/status/.lock`; a second run while
one is in progress refuses to start.

### The retention sweep

`npm run files:sweep` purges soft-deleted files past the retention window
(`FILE_RETENTION_DAYS`, 30) and clears abandoned uploads. It must run before
the file backup so purged bytes stop being copied. The `app` image cannot run
it — it carries neither `scripts/` nor `tsx` — so it runs from the migrator
image, which has both and is rebuilt on every deploy. It runs from the
`scheduler` service at `SWEEP_SCHEDULE` (default `0 2 * * *`); to run it now,
`docker compose run --rm scheduler sweep-now` (`--dry-run` lists what it
would purge). Without Docker, see "Scheduled jobs" below.

Soft-deleted files are recoverable in the app until the sweep purges them;
after that, only from a restic snapshot (see "Restore one file").

### Email, Slack and WhatsApp (optional)

The inbox inside the portal is always the record. These channels only carry
a copy outwards, and each person opts in under Inbox → settings (a client
login under Alerts, email only). Nothing here is needed for the portal to
work (brief §46).

1. Set the channels you want in `.env` (see `.env.example`):
   - **Email.** Set `SMTP_URL` and `MAIL_FROM`. The office mail server works
     without internet.
   - **Slack.** Set `SLACK_BOT_TOKEN`, from a Slack app with `chat:write`.
   - **WhatsApp.** Set `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` and
     `WHATSAPP_TEMPLATE`. The template must be approved by Meta and take two
     body parameters, the title and a link.
   - **Links.** Set `PORTAL_BASE_URL` so messages link back to the portal.
2. `docker compose up -d app` so the settings page shows the channels.
3. `docker compose --profile integrations up -d notifier` starts the
   dispatcher. It checks every 30 seconds.

A failed send is retried after 2, 4, 8 and 16 minutes, then given up. The
person sees the last error on their settings page. Notifications older than
48 hours are not sent. Turning a channel on never replays old ones. To see
what is stuck:

```sql
SELECT channel, status, count(*), max(last_error) FROM notification_dispatches
WHERE created_at > now() - interval '1 day' GROUP BY 1, 2;
```

### Recurring projects

Orders marked "Repeats every month" are copied into each new month by
`scripts/run-recurring.ts` (same migrator image). It is safe to run any
number of times: a chain already copied into the current month is left
alone, and a second run started meanwhile exits without doing anything. It
runs nightly from the `scheduler` service at `RECURRING_SCHEDULE` (default
`15 2 * * *`), so the 1st files the new month and any missed night is caught
up; to run it now, `docker compose run --rm scheduler recurring-now`.
Without Docker, see "Scheduled jobs" below.

Each copy is filed as its Sales owner and lands in the Project Manager's
intake like any new order. When a copy cannot be made, because the owner
has left or the month is closed, the PMs get a notification and the log
line says why. `npm run projects:recurring -- --dry-run` (or `docker compose
run --rm scheduler recurring-now --dry-run`) lists what is due without
filing anything.

### Nightly housekeeping

`scripts/nightly.ts` (same migrator image) does two things the portal cannot
do from inside a request:

- **Deadline reminders** (brief §20). Stored notifications for work coming
  due within three days, due today, or overdue — one per person per item as
  it crosses each line, and weekly again while it stays overdue. Each person
  is reminded of what their inbox lists, narrowed to the people on the work:
  Executives and Team Leads of their tasks, a Project Manager of the projects
  they manage (and of those still in intake), Sales of their own projects;
  management and administrators are not written to. These rows are what the
  optional email, Slack and WhatsApp channels pick up.
- **The month archive** (brief §36). A client month whose period ended more
  than a week ago, with every project completed or cancelled — a cancelled
  project with an approved file still awaiting delivery keeps it open — is
  closed and becomes read-only, and any revision in it whose slots were all
  delivered again is closed with it. It appears in the client's history as
  closed automatically (no closer named); CEO, COO and admin can reopen it,
  and a reopened month is left alone by the archive from then on: someone
  closes it by hand.

It runs nightly from the `scheduler` service at `NIGHTLY_SCHEDULE` (default
`20 2 * * *`), after the recurring run and before the 02:30 backup, so the
night's reminders and closures are in that night's dump; to run it now,
`docker compose run --rm scheduler nightly-now`. Without Docker, see
"Scheduled jobs" below.

`npm run jobs:nightly -- --dry-run` (or `docker compose run --rm scheduler
nightly-now --dry-run`) lists the months it would close.

### Scheduled jobs

The three jobs above — the retention sweep, the recurring projects and the
nightly housekeeping — run from the `scheduler` service, which `docker
compose up -d` starts with the rest: busybox crond in the migrator image
(`docker/scheduler/entrypoint.sh`; the `app` image has neither `tsx` nor
`scripts/`), so nothing needs to be installed on the host. The schedules are
`SWEEP_SCHEDULE` (default `0 2 * * *`), `RECURRING_SCHEDULE` (`15 2 * * *`)
and `NIGHTLY_SCHEDULE` (`20 2 * * *`) in `.env`, all in `BACKUP_TZ` and all
before the 02:30 backup; the sweep also takes `FILE_RETENTION_DAYS`. The
service needs the migrator image, which `docker compose up -d --build` builds;
`docker compose up -d scheduler` alone on a fresh host stops with "image not
found" until `migrate` has been built once.

```bash
docker compose logs -f scheduler                      # each run's output
docker compose run --rm scheduler nightly-now         # also sweep-now, recurring-now
docker compose run --rm scheduler nightly-now --dry-run
```

**What each run records.** A real run (not a dry run, and not one that found
another run holding the lock) writes `STORAGE_ROOT/jobs/<sweep|recurring|
nightly>.json` — in Docker under the `storage` volume, at `/storage/jobs` —
with `started_at`, `finished_at`, `status` (`ok` / `failed`), a one-line
`summary` of what it did and, on failure, `error`. The app reads those files
as the backup status files are read, so a job that stopped running is noticed
the next morning. A run killed mid-way leaves the previous record in place,
so it shows as stale the next day rather than as failed. A one-off run through
`--profile ops` (`sweep`, `recurring`, `nightly`) records itself the same way.

**Without Docker.** The same scripts run on a plain `npm` install and read the
portal's `.env` (`DATABASE_URL`, `STORAGE_ROOT`). Nothing is automatic until it
is scheduled. With `crontab -e`, next to the backup lines under "Backups
without Docker" (the same `PATH` line applies, and so does the macOS caveat
about `~/Desktop`, `~/Documents` and `~/Downloads`):

```
PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
0 2 * * * cd /path/to/portal && mkdir -p backups && npm run files:sweep >> backups/sweep.log 2>&1
15 2 * * * cd /path/to/portal && npm run projects:recurring >> backups/recurring.log 2>&1
20 2 * * * cd /path/to/portal && npm run jobs:nightly >> backups/nightly.log 2>&1
```

With launchd, three plists on the pattern of the backup one
(`local.aktivacity.sweep`, `local.aktivacity.recurring`,
`local.aktivacity.nightly`, each with `Hour` 2 and `Minute` 0, 15 and 20, and
the matching `npm run …` line in `ProgramArguments`), bootstrapped the same
way. On Windows, three daily Task Scheduler tasks like the backup one, each
running `C:\Program Files\Git\bin\bash.exe` with `-lc "cd /c/path/to/portal
&& npm run <files:sweep | projects:recurring | jobs:nightly> >> backups/<job>.log
2>&1"`.

**Verifying.** `/api/health` carries a `jobs` block — for each of `sweep`,
`recurring` and `nightly`, `stale` (true when the last run finished more than
36 hours ago, or the job has never run) and `lastRun` with `status`,
`startedAt`, `finishedAt` and `summary` (the error text is not public; the
dashboard shows it). The management and administrator dashboards show a
banner naming any job that is stale, has never run, or failed on its last
run. The HTTP status stays 200 either way.

```bash
curl -sk https://$PORTAL_HOSTNAME/api/health | jq .jobs
```

---

## Restore

Per brief §45. Every restore command runs in the `backup` container, with the
database and repository settings from `.env`. List what exists first:

```bash
docker compose run --rm backup list
```

### Restore the database from a dump

Use this for a bad migration, a destructive mistake, or a corrupted database.
Everything written after the dump is lost.

1. **Stop the app** so nothing writes during the restore. The script stops
   nothing itself, and refuses to run while other sessions are connected.
   ```bash
   docker compose stop app
   ```
2. **Pick a dump** from `list`. If it is only off-box (older than the local
   retention, or the server's disk is gone), fetch the dumps first:
   ```bash
   docker compose run --rm backup restic restore latest --host aktivacity-portal --tag db --target /
   ```
   (`latest` or a snapshot ID; files land back in `./backups/db`.)
3. **Restore.** `--recreate` drops and recreates the database so it matches
   the dump exactly; without it, objects the dump does not know about (a table
   from a later migration) survive.
   ```bash
   docker compose run --rm backup restore-db aktivacity-20260924T023000Z.dump --yes --recreate
   ```
   Without `--recreate` the restore runs as one transaction: it either fully
   succeeds or changes nothing.
4. **Start.** `migrate` applies any migration newer than the dump, then `app`
   starts.
   ```bash
   docker compose up -d
   ```
5. Check `/api/health`, log in, open a recent project.

### Restore the file store

```bash
docker compose stop app
docker compose run --rm -v aktivacity-portal_storage:/restore backup restore-files latest /restore --yes
docker compose up -d
```

`latest` or a snapshot ID from `list`. Check the volume name with
`docker volume ls` if the project name was changed. restic overwrites files
that differ and leaves extra files in place; ownership and permissions are
restored. Restore the database from the **same night** as the files, so every
row points at bytes that exist — the dump is taken before the file snapshot,
so a same-night pair is always consistent.

**Restore one file:** restore to a scratch directory and copy it back.
```bash
docker compose run --rm -v "$PWD/restored:/out" backup restic restore latest \
  --host aktivacity-portal --tag files --include /storage/<path from files.storage_path> --target /out
```

### Full rebuild on replacement hardware

The server is gone; the NAS and the password manager are not.

1. **Host.** Install Docker Engine + Compose plugin. Mount the NAS at the same
   path as before (`/etc/fstab`). Size the disk for the file store.
2. **Code.** `git clone` the repository and check out the tag or commit that
   was deployed (the newest dump's `_migrations` must not be ahead of it).
3. **Config.** Recreate `.env` from the password manager copy. It must carry
   the same `RESTIC_PASSWORD` and `RESTIC_REPOSITORY`.
4. **Build and create, but do not start the app.**
   ```bash
   docker compose build
   docker compose create
   docker compose up -d postgres
   ```
   `create` makes the volumes; postgres initialises an empty database.
5. **Confirm the repository is reachable.**
   ```bash
   docker compose run --rm backup list
   ```
6. **Database.** Fetch the dumps, then restore the newest:
   ```bash
   docker compose run --rm backup restic restore latest --host aktivacity-portal --tag db --target /
   docker compose run --rm backup list
   docker compose run --rm backup restore-db <newest dump> --yes
   ```
7. **Files.**
   ```bash
   docker compose run --rm -v aktivacity-portal_storage:/restore backup restore-files latest /restore --yes
   ```
8. **Start.** `docker compose up -d`. `migrate` finds everything applied.
9. **Verify.** `/api/health`, log in, open a project and download a file.
   Then `docker compose run --rm backup backup-now` and `verify-now`.
10. **Workstations.** Re-trust the new Caddy root (see "Trusting the internal
    certificate") and point DNS at the new host if its address changed.
11. **Scheduled jobs.** Nothing to reinstall on Docker — the `scheduler`
    service is part of the stack. A non-Docker install reinstalls the cron
    lines under "Scheduled jobs".

Write down how long each step took. That is the RTO, measured.

### Restore rehearsal

**Automated, weekly.** `verify-restore.sh` takes the newest dump, fails if it
is older than `VERIFY_MAX_DUMP_AGE_HOURS` (48), restores it into a scratch
database (`aktivacity_restore_check`, never the live one), compares row counts
of `users`, `clients`, `projects`, `deliverables`, `files`, `activity_log`
with the live database (within 10% or 100 rows; `_migrations` exactly),
confirms the newest restic `db` snapshot contains that dump, runs
`restic check --read-data-subset=2%`, drops the scratch database, and writes
`last-verify.json`. Run it any time:

```bash
docker compose run --rm backup verify-now
```

It proves the dumps restore and the repository is sound. It does **not**
restore files or rebuild a host.

The off-box part follows the same rule as the nightly run (brief §44): with
`RESTIC_REPOSITORY` unset the database part still runs and is recorded, but
the rehearsal **fails** (`"status": "failed"`, `"offsite": "unconfigured"`,
exit 1), because there is no off-box copy to check and the files are not
backed up. The explicit `BACKUP_FILES_DISABLED=1` records
`"offsite": "disabled"` and passes (exit 0): the dump restores, and nothing
off the box was there to check. With a repository configured the opt-out is
ignored, as in `backup.sh`.

**By hand, quarterly and before go-live.** Restore the files to a scratch
directory and spot-check a few against the app:
```bash
docker compose run --rm -v "$PWD/drill:/drill" backup restore-files latest /drill
```
and do the full rebuild once on a spare machine or VM, timed. An unrehearsed
restore procedure is a guess.

---

## Monitoring backups

The job writes three files to `./backups/status/` (the app sees them at
`/backups/status`):

| File | Written | Key fields |
|---|---|---|
| `last-run.json` | every run | `status` (`ok` / `degraded` / `disabled` / `failed`), `finished_at`, `dump_file`, `dump_bytes`, `offsite` (`ok` / `unconfigured` / `disabled` / `failed` / `not-reached`), `restic_snapshot_files`, `restic_snapshot_db` (ID or `skipped`), `warnings`, `error` |
| `last-success.json` | only when everything, including the off-box copy, succeeded | as above |
| `last-verify.json` | every rehearsal | `status` (`ok` / `failed`), `dump_file`, `dump_age_hours`, `restore_seconds`, per-table `live` / `restored` counts, `offsite` (`ok` / `unconfigured` / `disabled` / `failed` / `not-reached`, as in `last-run.json`), `offsite_has_dump`, `restic_check` (`ok` / `failed` / `skipped`), `error` |

**Something is wrong if:** `last-success.json` is older than about 26 hours,
`last-run.json` says `failed` (with `offsite: unconfigured`: no
`RESTIC_REPOSITORY` — the files are not backed up) or `degraded`, or
`last-verify.json` is older than 8 days or says `failed`. `disabled` means
`BACKUP_FILES_DISABLED=1` was set on purpose: database dumps only, and there
will never be a `last-success.json`. A quick look:

The portal reads the same files. The management and administrator
dashboards show a banner whenever backups are failing or need attention,
and `/api/health` carries `"backups": "ok" | "unknown" | "disabled" |
"warning" | "unconfigured" | "failed"` for an external monitor (always with
HTTP 200: the Compose healthcheck must not restart the app over a backup).
Beside it, `"backupsReason"` names the worst finding as one token, so a
monitor can tell the warnings apart — a same-disk repository is a standing
condition, a backup going stale or a rehearsal failing is news:

| `backupsReason` | `backups` | Meaning |
|---|---|---|
| `ok` | `ok` | last run and weekly rehearsal recent and clean |
| `never_run` | `unknown` | nothing has run yet, or the status directory is not mounted |
| `disabled` | `disabled` | `BACKUP_FILES_DISABLED=1`: database dumps only, on purpose |
| `same_disk_repository` | `warning` | `last-run.json` says `degraded` |
| `rehearsal_stale` | `warning` | `last-verify.json` older than 8 days, or none |
| `stale` | `warning` | no complete backup — or, dumps only, no dump — for over 36 hours |
| `rehearsal_failed` | `warning` | `last-verify.json` says `failed` |
| `unconfigured` | `unconfigured` | `RESTIC_REPOSITORY` is not set |
| `never_completed` | `failed` | there has never been a complete backup with an off-box copy |
| `run_failed` | `failed` | the last run failed for any other reason |

When several apply, the reason is the worst of them, in that order; the
dashboard spells out every one. The portal allows 36 hours before it calls
a success stale — or, with file backups switched off, before it calls the
last dump stale — so one missed night is flagged the next morning. The app
reads from `BACKUP_STATUS_DIR`, default `/backups/status`.

```bash
jq '{status, finished_at, offsite, error}' backups/status/last-run.json
jq '{status, finished_at, offsite, restic_check, error}' backups/status/last-verify.json
curl -sk https://$PORTAL_HOSTNAME/api/health | jq '{backups, backupsReason}'
docker compose logs --since 48h backup
```

Nothing pages anyone: the dashboard banner and the `backups` field of
`/api/health` are the alarm. Point an external monitor at `/api/health` if
one exists; otherwise a weekly look at the dashboard is the routine.

**Monitoring the jobs.** The same `/api/health` body carries a `jobs` block
for the retention sweep, the recurring projects and the nightly housekeeping,
each with `stale` (older than 36 hours, or never run) and its `lastRun`, read
from `STORAGE_ROOT/jobs/<name>.json`; the same dashboards show a banner when
any job is stale, has never run or failed last time (see "Scheduled jobs").

```bash
curl -sk https://$PORTAL_HOSTNAME/api/health | jq '.jobs'
docker compose logs --since 48h scheduler
```

---

## RPO and RTO

**RPO — how much can be lost:** everything since the last *successful* run.
With the nightly schedule that is up to 24 hours, and more if a night fails
unnoticed — which is why the status files matter. Tighten `BACKUP_SCHEDULE`
(e.g. `30 */6 * * *`) to shrink it; each run is a full dump plus an
incremental file snapshot.

**Point-in-time recovery is not implemented.** There is no WAL archiving, so
there is no restoring to "five minutes before the mistake". Getting there
means: `archive_mode = on` with an `archive_command` shipping WAL to the NAS
(pgBackRest or WAL-G rather than hand-rolled `cp`), periodic base backups
(`pg_basebackup`, or the same tool), retention for both, a restore procedure
using `recovery_target_time`, and a rehearsal of it. That would bring RPO to
minutes (`archive_timeout`).

**RTO — how long until staff work again:** a rebuild plus a restore. The
database part is quick (`restore_seconds` in `last-verify.json` is the
measured figure); the file store dominates — roughly its size divided by what
the NAS link delivers (1 TB over gigabit is 3 hours or more). Measure it in
the rebuild drill and write the number here. There is no high availability —
this is a single server by design (brief §40).
