import { getActor } from '@/lib/auth/dal';
import { canViewSalesLeaderboard, salesLeaderboard } from '@/lib/leaderboard/sales';

export const dynamic = 'force-dynamic';

/** Polled by the dashboard leaderboard. Same privacy rules as the page. */
export async function GET() {
  const actor = await getActor();
  if (!actor || actor.mustChangePassword || !canViewSalesLeaderboard(actor)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const board = await salesLeaderboard(actor);
  return Response.json(board, { headers: { 'Cache-Control': 'no-store' } });
}

