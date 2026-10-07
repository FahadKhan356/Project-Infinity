import type { NextRequest } from 'next/server';
import { recordActivity } from '@/lib/auth/audit';
import { errorResponse, isResponse, requireApiActor } from '@/lib/files/api';
import { exportReport } from '@/lib/reports/export';
import { periodValue } from '@/lib/reports/monthly';

export const dynamic = 'force-dynamic';

/**
 * CSV download of a monthly report (brief §39). Same query parameters as
 * /reports; the same scoped numbers the page shows. Every export is logged —
 * a report leaving the portal is worth answering "who took that?" about.
 */
export async function GET(request: NextRequest) {
  const actor = await requireApiActor();
  if (isResponse(actor)) return actor;

  try {
    const params = request.nextUrl.searchParams;
    const result = await exportReport(actor, { period: params.get('period'), client: params.get('client') });
    if (!result.ok) {
      if (result.status === 403) {
        await recordActivity({
          actorId: actor.id,
          action: 'report.export_denied',
          entityType: 'report',
          metadata: { period: params.get('period'), client: params.get('client') },
        });
      }
      return Response.json({ error: result.error }, { status: result.status });
    }

    await recordActivity({
      actorId: actor.id,
      action: 'report.exported',
      entityType: result.kind === 'client' ? 'client' : 'report',
      entityId: result.clientId,
      clientId: result.clientId,
      metadata: { kind: result.kind, period: periodValue(result.period), rows: result.rows },
    });

    return new Response(result.csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        // Scoped, sometimes priced: no shared cache may hold it.
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
