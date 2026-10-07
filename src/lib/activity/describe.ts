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

/** "#03", as the client numbers revisions — the same form the pages and notices use. */
const revisionTag = (n: number): string => `#${String(n).padStart(2, '0')}`;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
/** "September 2026" from {year, month} metadata, or "the month" when absent. */
function monthLabel(m: Record<string, unknown>): string {
  const year = num(m.year);
  const month = num(m.month);
  if (year === null || month === null || month < 1 || month > 12) return 'the month';
  return `${MONTHS[month - 1]} ${year}`;
}

/** " to revision #03" / " to the assignment Video edits" / "" for the project. */
function attachedTo(m: Record<string, unknown>): string {
  const rev = num(m.revisionNo);
  if (rev !== null) return ` to revision ${revisionTag(rev)}`;
  const assignment = str(m.assignmentTitle);
  if (assignment) return ` to the assignment ${assignment}`;
  return '';
}

export function describeActivity({ action, actorName, metadata: m }: ActivityInput): string {
  const who = actorName ?? 'Someone';
  const slot = str(m.deliverableName);
  const version = num(m.versionNo);
  const slotV = slot ? `${slot}${version !== null ? ` v${version}` : ''}` : 'a deliverable';

  switch (action) {
    case 'project.created': {
      const code = str(m.projectCode);
      const from = str(m.copiedFromCode);
      if (m.recurring === true) {
        return `${who}'s recurring order was filed automatically as ${code ?? 'a new project'}${from ? `, repeating ${from}` : ''}`;
      }
      return `${who} created the project${code ? ` ${code}` : ''}${from ? ` by copying ${from}` : ''}`;
    }
    case 'client.month_opened':
      return `${who} opened ${monthLabel(m)}`;
    case 'client.month_closed':
      // The nightly archive closes with no actor (brief §36); it is not "someone".
      if (m.automatic === true) return `${monthLabel(m)} was archived automatically`;
      return `${who} closed ${monthLabel(m)}`;
    case 'client.month_reopened':
      return `${who} reopened ${monthLabel(m)}`;
    case 'client.month_copied': {
      const n = num(m.projectCount) ?? 0;
      const from = str(m.fromLabel);
      return `${who} copied ${n} project${n === 1 ? '' : 's'}${from ? ` from ${from}` : ''} into ${monthLabel(m)}`;
    }
    case 'project.triaged': {
      const teams = Array.isArray(m.teams) ? m.teams.filter((t): t is string => typeof t === 'string') : [];
      if (teams.length > 0) return `${who} routed the project to ${teams.join(', ')}`;
      return m.status === 'planned'
        ? `${who} routed the project to every team`
        : `${who} routed the project (${num(m.assignedTeams) ?? 0} of ${num(m.totalTeams) ?? 0} teams have a lead)`;
    }
    case 'project.status_changed': {
      const reason = str(m.reason);
      const verb = m.change === 'hold' ? 'put the project on hold'
        : m.change === 'resume' ? 'resumed the project'
        : m.change === 'cancel' ? 'cancelled the project'
        : 'changed the project status';
      return `${who} ${verb}${reason ? ` (${reason})` : ''}`;
    }
    case 'project.details_edited': {
      const fields = Array.isArray(m.fields) ? m.fields.filter((f): f is string => typeof f === 'string') : [];
      return fields.length > 0 ? `${who} updated the project ${fields.join(', ')}` : `${who} updated the project details`;
    }
    case 'client.updated': {
      const fields = Array.isArray(m.fields) ? m.fields.filter((f): f is string => typeof f === 'string') : [];
      return fields.length > 0 ? `${who} updated the client ${fields.join(', ')}` : `${who} updated the client profile`;
    }
    case 'opportunity.won':
      return `${who} won the deal and filed it as this project`;
    case 'project.notes_updated':
      return `${who} updated the internal notes`;
    case 'assignment.created': {
      const n = num(m.deliverables) ?? 0;
      const assignee = str(m.assigneeName) ?? 'a team member';
      return `${who} assigned work to ${assignee} (${n} deliverable${n === 1 ? '' : 's'})`;
    }
    case 'file.uploaded': {
      const rev = num(m.revisionNo);
      if (!slot) {
        const name = str(m.filename);
        const po = str(m.kind) === 'po' ? 'the PO document ' : '';
        return `${who} attached ${po}${name ?? 'a file'}${attachedTo(m)}`;
      }
      return `${who} uploaded ${slotV}${rev !== null ? ` for revision ${revisionTag(rev)}` : ''}`;
    }
    case 'revision.created': {
      const n = num(m.revisionNo);
      const title = str(m.title);
      return `${who} opened revision${n !== null ? ` ${revisionTag(n)}` : ''}${title ? `: ${title}` : ''}`;
    }
    case 'revision.assigned': {
      const n = num(m.revisionNo);
      const assignee = str(m.assigneeName) ?? 'a team member';
      return `${who} assigned revision${n !== null ? ` ${revisionTag(n)}` : ''}${slot ? ` (${slot})` : ''} to ${assignee}`;
    }
    case 'revision.closed': {
      const n = num(m.revisionNo);
      const which = `revision${n !== null ? ` ${revisionTag(n)}` : ''}`;
      // Closing a month ends its delivered revisions (brief §36); the nightly
      // archive does so with no actor, and it is not "someone".
      if (m.automatic === true) return `${which.charAt(0).toUpperCase()}${which.slice(1)} was closed automatically when the month was archived`;
      const verb = m.status === 'cancelled' ? 'cancelled' : 'closed';
      return `${who} ${verb} ${which}${m.monthClosed === true ? ' with the month' : ''}`;
    }
    case 'file.deleted': {
      const name = str(m.filename);
      return `${who} deleted ${name ?? 'a file'}${slot ? ` from ${slotV}` : ''}`;
    }
    case 'qa.reviewed': {
      const verb =
        m.decision === 'approved' ? 'approved'
        : m.decision === 'rejected' ? 'rejected'
        : 'requested changes on';
      return `${who} ${verb} ${slotV}`;
    }
    case 'delivery.received':
      // The moment QA clears a file it is Sales' to deliver (brief §14); the
      // brief's example log says so in its own words, whoever approved it.
      return `Sales received delivery of ${slotV}`;
    case 'delivery.updated': {
      const name = slot ?? 'a deliverable';
      switch (m.status) {
        case 'delivered':
          // Auto-delivery (§29): the portal sent it on the reviewer's approval.
          return m.automatic === true
            ? `${name} was delivered to the client portal automatically`
            : `${who} delivered ${name} to the client`;
        case 'client_feedback_received': return `${who} received client feedback on ${name}`;
        case 'revision_required': return `${who} marked ${name} as needing a revision`;
        case 'completed': return `${who} marked ${name} complete`;
        default: return `${who} updated the delivery of ${name}`;
      }
    }
    case 'delivery.client_decision': {
      const name = str(m.deliverableName) ?? slot ?? 'a deliverable';
      return m.decision === 'approved'
        ? `Client approved ${name}`
        : `Client requested changes to ${name}`;
    }
    case 'comment.posted':
      // "on Thumbnail 01 v3" for a version thread (§10, §19), "on Thumbnail 01" for a slot.
      return slot ? `${who} commented on ${slotV}` : `${who} commented`;
    case 'project.shared':
      return `${who} shared the project with ${str(m.userName) ?? 'a Sales representative'}`;
    case 'project.unshared':
      return `${who} stopped sharing the project with ${str(m.userName) ?? 'a Sales representative'}`;
    default:
      return `${who} ${action.replace('.', ' ').replace(/_/g, ' ')}`;
  }
}
