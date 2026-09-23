import { getSql } from "@/db";

export const dynamic = "force-dynamic";

/**
 * Liveness plus database readiness. Used by the Compose healthcheck and to
 * confirm migrations landed after a deploy.
 */
export async function GET() {
  const started = Date.now();
  try {
    const sql = getSql();
    const [{ count }] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM _migrations
    `;
    return Response.json({
      status: "ok",
      database: "reachable",
      migrationsApplied: Number(count),
      latencyMs: Date.now() - started,
    });
  } catch (error) {
    return Response.json(
      {
        status: "degraded",
        database: "unreachable",
        error: error instanceof Error ? error.message : "unknown error",
      },
      { status: 503 },
    );
  }
}
