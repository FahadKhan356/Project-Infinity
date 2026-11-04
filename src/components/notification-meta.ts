export type NotificationTone = 'emerald' | 'rose' | 'amber' | 'sky' | 'indigo' | 'violet' | 'slate';

export interface NotificationStyle {
  label: string;
  tone: NotificationTone;
  badgeClass: string;
  accentBarClass: string;
  iconBgClass: string;
  iconKind: 'check' | 'x' | 'alert' | 'route' | 'upload' | 'task' | 'revision' | 'comment' | 'clock' | 'folder';
}

const TONE_STYLES: Record<NotificationTone, { badgeClass: string; accentBarClass: string; iconBgClass: string }> = {
  emerald: {
    badgeClass: 'border-emerald-500/30 bg-emerald-500/12 text-emerald-600 dark:text-emerald-400',
    accentBarClass: 'bg-emerald-500',
    iconBgClass: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  },
  rose: {
    badgeClass: 'border-rose-500/30 bg-rose-500/12 text-rose-600 dark:text-rose-400',
    accentBarClass: 'bg-rose-500',
    iconBgClass: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
  },
  amber: {
    badgeClass: 'border-amber-500/30 bg-amber-500/12 text-amber-600 dark:text-amber-400',
    accentBarClass: 'bg-amber-500',
    iconBgClass: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  },
  sky: {
    badgeClass: 'border-sky-500/30 bg-sky-500/12 text-sky-600 dark:text-sky-400',
    accentBarClass: 'bg-sky-500',
    iconBgClass: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  },
  indigo: {
    badgeClass: 'border-indigo-500/30 bg-indigo-500/12 text-indigo-600 dark:text-indigo-400',
    accentBarClass: 'bg-indigo-500',
    iconBgClass: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400',
  },
  violet: {
    badgeClass: 'border-violet-500/30 bg-violet-500/12 text-violet-600 dark:text-violet-400',
    accentBarClass: 'bg-violet-500',
    iconBgClass: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  },
  slate: {
    badgeClass: 'border-border bg-background text-muted',
    accentBarClass: 'bg-slate-400 dark:bg-slate-500',
    iconBgClass: 'bg-slate-500/15 text-muted',
  },
};

export function getNotificationStyle(type: string, title?: string): NotificationStyle {
  const t = type.toLowerCase();
  const heading = (title ?? '').toLowerCase();

  if (t === 'delivery.ready' || heading.startsWith('ready for delivery')) {
    return { label: 'Ready for Delivery', tone: 'emerald', ...TONE_STYLES.emerald, iconKind: 'check' };
  }
  if (t === 'delivery.delivered' || heading.startsWith('delivered')) {
    return { label: 'Delivered', tone: 'emerald', ...TONE_STYLES.emerald, iconKind: 'check' };
  }
  if (t === 'qa.approved' || heading.includes('approved')) {
    return { label: 'QA Approved', tone: 'emerald', ...TONE_STYLES.emerald, iconKind: 'check' };
  }
  if (t === 'qa.rejected' || heading.includes('rejected') || heading.includes('sent back')) {
    return { label: 'QA Rejected', tone: 'rose', ...TONE_STYLES.rose, iconKind: 'x' };
  }
  if (t === 'qa.required' || heading.startsWith('qa needed')) {
    return { label: 'QA Needed', tone: 'amber', ...TONE_STYLES.amber, iconKind: 'alert' };
  }
  if (t === 'deliverable.uploaded' || heading.startsWith('uploaded:')) {
    return { label: 'File Uploaded', tone: 'sky', ...TONE_STYLES.sky, iconKind: 'upload' };
  }
  if (t === 'project.routed' || heading.includes('routed by the pm')) {
    return { label: 'Project Routed', tone: 'indigo', ...TONE_STYLES.indigo, iconKind: 'route' };
  }
  if (t === 'project.created' || heading.startsWith('new project:')) {
    return { label: 'New Project', tone: 'sky', ...TONE_STYLES.sky, iconKind: 'folder' };
  }
  if (t === 'project.assigned' || t === 'project.lead_assigned') {
    return { label: 'Team Assigned', tone: 'violet', ...TONE_STYLES.violet, iconKind: 'route' };
  }
  if (t === 'assignment.created' || heading.startsWith('new task')) {
    return { label: 'Task Assigned', tone: 'indigo', ...TONE_STYLES.indigo, iconKind: 'task' };
  }
  if (t.startsWith('revision.')) {
    return { label: 'Revision', tone: 'amber', ...TONE_STYLES.amber, iconKind: 'revision' };
  }
  if (t === 'comment.posted' || heading.startsWith('new comment')) {
    return { label: 'Comment', tone: 'sky', ...TONE_STYLES.sky, iconKind: 'comment' };
  }
  if (t === 'project.on_hold') {
    return { label: 'On Hold', tone: 'amber', ...TONE_STYLES.amber, iconKind: 'alert' };
  }
  if (t === 'project.cancelled') {
    return { label: 'Cancelled', tone: 'rose', ...TONE_STYLES.rose, iconKind: 'x' };
  }
  if (t === 'project.resumed') {
    return { label: 'Resumed', tone: 'emerald', ...TONE_STYLES.emerald, iconKind: 'check' };
  }
  if (t === 'deadline.overdue' || t === 'project.delayed' || heading.startsWith('overdue')) {
    return { label: 'Overdue', tone: 'rose', ...TONE_STYLES.rose, iconKind: 'clock' };
  }
  if (t.startsWith('deadline.')) {
    return { label: 'Deadline', tone: 'amber', ...TONE_STYLES.amber, iconKind: 'clock' };
  }
  if (t === 'project.details_edited') {
    return { label: 'Project Updated', tone: 'slate', ...TONE_STYLES.slate, iconKind: 'folder' };
  }

  return { label: 'Update', tone: 'sky', ...TONE_STYLES.sky, iconKind: 'folder' };
}

/**
 * Extracts project code (e.g. AKT-2026-0082) from notification title/body
 * so it can be displayed as a distinct badge.
 */
export function extractProjectMeta(title: string, body: string | null): {
  projectCode: string | null;
  projectName: string | null;
  cleanBody: string | null;
} {
  const combined = `${title} ${body ?? ''}`;
  const codeMatch = combined.match(/\b(AKT-\d{4}-\d{4})\b/);
  const projectCode = codeMatch ? codeMatch[1] : null;

  if (!body) {
    return { projectCode, projectName: null, cleanBody: null };
  }

  // Many notification bodies start with: "AKT-2026-0082 · Project Title. Rest of sentence."
  const prefixMatch = body.match(/^(AKT-\d{4}-\d{4})\s*·\s*([^.]+)\.\s*(.*)$/);
  if (prefixMatch) {
    return {
      projectCode: prefixMatch[1],
      projectName: prefixMatch[2].trim(),
      cleanBody: prefixMatch[3].trim() || null,
    };
  }

  const dashMatch = body.match(/^(AKT-\d{4}-\d{4})\s*·\s*([^-—]+)[—-]\s*(.*)$/);
  if (dashMatch) {
    return {
      projectCode: dashMatch[1],
      projectName: dashMatch[2].trim(),
      cleanBody: dashMatch[3].trim() || null,
    };
  }

  return { projectCode, projectName: null, cleanBody: body };
}

