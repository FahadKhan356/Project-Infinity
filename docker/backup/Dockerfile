# syntax=docker/dockerfile:1
#
# The `backup` service: the same PostgreSQL 17 client tools as the database
# (pg_dump must not be older than the server), restic for the off-box copy,
# and busybox crond for the schedule. Build context is the repository root.

FROM postgres:17-alpine

# openssh-client: for sftp: repositories. tzdata: so TZ applies to the schedule.
RUN apk add --no-cache restic openssh-client tzdata ca-certificates

COPY scripts/backup/ /usr/local/lib/aktivacity-backup/
COPY docker/backup/entrypoint.sh /usr/local/bin/aktivacity-backup
RUN chmod 755 /usr/local/lib/aktivacity-backup/*.sh /usr/local/bin/aktivacity-backup \
 && restic version && pg_dump --version

ENV BACKUP_DIR=/backups \
    STORAGE_DIR=/storage

ENTRYPOINT ["/usr/local/bin/aktivacity-backup"]
CMD ["cron"]
