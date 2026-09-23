# Runbook

Operational procedures for the Aktivacity Portal on the internal server.

> **Status:** covers everything M0 delivers. Backup and restore procedures are
> specified here but **not yet implemented** — they are part of the deployment
> work described in `docs/phase-1a-plan.md`. Do not treat this as a tested
> recovery plan until the restore rehearsal in that section has been done.

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
   not validate.

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
   Expect `{"status":"ok","database":"reachable","migrationsApplied":1,...}`.

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
| Purge expired files | `docker compose exec app npx tsx scripts/files:sweep` |

**Deploying a change:** `git pull && docker compose up -d --build`. Migrations
apply automatically before the new app container accepts traffic.

---

## Backup — NOT YET IMPLEMENTED

Target design, per brief §44–45:

- **Database:** nightly `pg_dump --format=custom` into `./backups`, plus WAL
  archiving for point-in-time recovery.
- **Files:** nightly `restic` snapshot of the `storage` volume to a second
  machine or NAS, with retention.
- **Destination must not be the primary server.** A backup on the same disk is
  not a backup.
- **Retention sweep:** `npm run files:sweep` nightly, before the file backup,
  so deleted bytes stop being copied. Soft-deleted files are recoverable until
  it runs — the window is `--retention-days`, 30 by default.

Until this exists, the only copy of production data is the `pgdata` and
`storage` volumes on one machine. Say so plainly to whoever signs off on
go-live.

## Restore — NOT YET IMPLEMENTED

Must be written *and rehearsed* before go-live. It needs to cover: restore from
dump, point-in-time recovery from WAL, file-store restore, and a full rebuild on
replacement hardware. An unrehearsed restore procedure is a guess.

**RPO/RTO once implemented:** RPO is the gap since the last WAL archive
(minutes). RTO is a rebuild plus restore. There is no high availability — this
is a single server by design (brief §40).
