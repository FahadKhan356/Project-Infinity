'use server';

import { revalidatePath } from 'next/cache';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { recordActivity } from '@/lib/auth/audit';
import { requireActor } from '@/lib/auth/dal';
import { TriageError, parseTriageForm, triageProject } from '@/lib/projects/triage';

export interface TriageFormState {
  error?: string;
  notice?: string;
}

export async function submitTriage(
  _prev: TriageFormState,
  formData: FormData,
): Promise<TriageFormState> {
  const actor = await requireActor();

  let result;
  try {
    const input = parseTriageForm(formData);
    if (!Number.isInteger(input.projectId)) return { error: 'Unknown project.' };
    result = await triageProject(actor, input);
  } catch (error) {
    if (error instanceof TriageError) return { error: error.message };
    throw error;
  }

  const routed = await getDb().execute<{ name: string }>(sql`
    SELECT d.name FROM project_departments pd
    JOIN departments d ON d.id = pd.department_id
    WHERE pd.project_id = ${result.projectId} AND pd.team_lead_id IS NOT NULL
    ORDER BY d.sort_order
  `);

  await recordActivity({
    actorId: actor.id,
    action: 'project.triaged',
    entityType: 'project',
    entityId: result.projectId,
    projectId: result.projectId,
    metadata: {
      status: result.status,
      assignedTeams: result.assignedTeams,
      totalTeams: result.totalTeams,
      teams: routed.map((r) => r.name),
    },
  });

  revalidatePath('/triage');
  revalidatePath('/planning');
  revalidatePath(`/projects/${result.projectId}`);

  return {
    notice:
      result.status === 'planned'
        ? 'Assigned. Every team now has a lead and the project is ready to plan.'
        : `Saved. ${result.totalTeams - result.assignedTeams} team(s) still need a lead.`,
  };
}
