/**
 * Turns an activity_log row into the one-line sentence brief §25 shows:
 *
 *   24 Sep, 10:32 AM — Sales created project
 *   25 Sep, 5:10 PM — Team Lead rejected Video V1
 *
 * Pure, so the wording can be tested without a database.
 */
export interface ActivityInput {
  action: string;
  actorName: string | null;
  metadata: Record<string, unknown>;
}

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export function describeActivity({ action, actorName, metadata: m }: ActivityInput): string {
  const who = actorName ?? 'Someone';
  const slot = str(m.deliverableName);
  const version = num(m.versionNo);
  const slotV = slot ? `${slot}${version !== null ? ` v${version}` : ''}` : 'a deliverable';

  switch (action) {
    case 'project.created': {
      const code = str(m.projectCode);
      return `${who} created the project${code ? ` ${code}` : ''}`;
    }
    case 'project.triaged': {
      const teams = Array.isArray(m.teams) ? m.teams.filter((t): t is string => typeof t === 'string') : [];
      if (teams.length > 0) return `${who} routed the project to ${teams.join(', ')}`;
      return m.status === 'planned'
        ? `${who} routed the project to every team`
        : `${who} routed the project (${num(m.assignedTeams) ?? 0} of ${num(m.totalTeams) ?? 0} teams have a lead)`;
    }
    case 'project.notes_updated':
      return `${who} updated the internal notes`;
    case 'assignment.created': {
      const n = num(m.deliverables) ?? 0;
      const assignee = str(m.assigneeName) ?? 'a team member';
      return `${who} assigned work to ${assignee} (${n} deliverable${n === 1 ? '' : 's'})`;
    }
    case 'file.uploaded':
      return slot ? `${who} uploaded ${slotV}` : `${who} uploaded an attachment`;
    case 'file.deleted':
      return `${who} deleted a file`;
    case 'qa.reviewed': {
      const verb =
        m.decision === 'approved' ? 'approved'
        : m.decision === 'rejected' ? 'rejected'
        : 'requested changes on';
      return `${who} ${verb} ${slotV}`;
    }
    case 'delivery.updated': {
      const name = slot ?? 'a deliverable';
      switch (m.status) {
        case 'delivered': return `${who} delivered ${name} to the client`;
        case 'client_feedback_received': return `${who} received client feedback on ${name}`;
        case 'revision_required': return `${who} marked ${name} as needing a revision`;
        case 'completed': return `${who} marked ${name} complete`;
        default: return `${who} updated the delivery of ${name}`;
      }
    }
    case 'comment.posted':
      return slot ? `${who} commented on ${slot}` : `${who} commented`;
    default:
      return `${who} ${action.replace('.', ' ').replace(/_/g, ' ')}`;
  }
}
