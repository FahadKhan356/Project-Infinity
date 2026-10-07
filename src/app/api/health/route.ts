import { getSql } from "@/db";
import { backupHealth } from "@/lib/backup/health";
import { jobsHealth } from "@/lib/jobs/health";
import { describeDbFailure } from "./describe-failure";

export const dynamic = "force-dynamic";

/**
 * Liveness plus database readiness. Used by the Compose healthcheck and to
 * confirm migrations landed after a deploy. Also the backup verdict and each
 * scheduled job's last run, for an external monitor.
 */
export async function GET() {
  const started = Date.now();
  try {
    const sql = getSql();
    const [{ count }] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM _migrations
    `;
    const jobs = await jobsHealth();
    const backups = await backupHealth();
    return Response.json({
      status: "ok",
      database: "reachable",
      migrationsApplied: Number(count),
      // The verdict only — "ok" | "unknown" | "disabled" | "warning" |
      // "unconfigured" | "failed" (src/lib/backup/health.ts); details are
      // for the dashboard, behind a login. Always HTTP 200: the Compose
      // healthcheck keys on r.ok, and a bad backup must not restart the app.
      backups: backups.state,
      // Why, as one token (BackupReason there): the worst finding, so a
      // monitor can tell "same_disk_repository" from "stale" or
      // "rehearsal_failed", which all read "warning". Still no sentences.
      backupsReason: backups.reason,
      // Each scheduled job's last run (src/lib/jobs/health.ts): stale when
      // older than 36 hours or never run. Status, times and the job's own
      // summary line only — the error text, like the backup details, stays
      // behind the login (a driver message can name the host or role).
      // Still HTTP 200 for the same reason as above.
      jobs: Object.fromEntries(Object.values(jobs).map((job) => [job.name, {
        stale: job.stale,
        lastRun: job.lastRun
          ? {
            status: job.lastRun.status,
            startedAt: job.lastRun.started_at,
            finishedAt: job.lastRun.finished_at,
            summary: job.lastRun.summary,
          }
          : null,
      }])),
      latencyMs: Date.now() - started,
    });
  } catch (error) {
    // The whole story for the operator; the public body carries only the
    // code and a fixed sentence (./describe-failure).
    console.error("[health] database unreachable:", error);
    return Response.json(
      {
        status: "degraded",
        database: "unreachable",
        error: describeDbFailure(error),
      },
      { status: 503 },
    );
  }
}
