import 'server-only';
import type { Actor } from '@/lib/authz';
import { can } from '@/lib/authz';
import { clientCsv, csvFilename, portfolioCsv } from './csv';
import { loadClientReport, loadPortfolioReport, parsePeriod, periodValue, type Period } from './monthly';

export type ReportExport =
  | { ok: false; status: 403 | 404; error: string }
  | {
      ok: true;
      kind: 'portfolio' | 'client';
      period: Period;
      clientId: number | null;
      rows: number;
      csv: string;
      filename: string;
    };

/**
 * The CSV behind /reports/export, kept apart from the route handler so the
 * permission rule can be tested without a request. Exporting is its own
 * capability (brief §23): being able to read a report on screen is not the
 * same as being allowed to take it out of the portal.
 */
export async function exportReport(
  actor: Actor,
  params: { period?: string | null; client?: string | null },
): Promise<ReportExport> {
  if (!can(actor, 'reports.export')) {
    return { ok: false, status: 403, error: 'You are not permitted to export reports.' };
  }

  const period = parsePeriod(params.period);
  const rawClient = params.client?.trim();
  if (rawClient) {
    const clientId = Number(rawClient);
    const report = Number.isInteger(clientId) && clientId > 0
      ? await loadClientReport(actor, clientId, period)
      : null;
    if (!report) return { ok: false, status: 404, error: 'Not found.' };
    return {
      ok: true, kind: 'client', period, clientId, rows: report.projects.length,
      csv: clientCsv(report),
      filename: csvFilename([report.client.name, periodValue(period)]),
    };
  }

  const report = await loadPortfolioReport(actor, period);
  return {
    ok: true, kind: 'portfolio', period, clientId: null, rows: report.rows.length,
    csv: portfolioCsv(report),
    filename: csvFilename(['aktivacity-report', periodValue(period)]),
  };
}
