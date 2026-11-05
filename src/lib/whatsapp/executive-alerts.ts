import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { channelConfig } from '@/lib/channels/config';
import { makeSenders } from '@/lib/channels/senders';

export interface AlertRecipient {
  userId?: number;
  role: 'ceo' | 'coo' | 'management';
  name: string;
  phone: string;
}

export interface ExecutiveContact {
  userId: number;
  fullName: string;
  role: string;
  email: string;
  phone: string;
  enabled: boolean;
  source: 'database' | 'env';
}

/**
 * Loads all active executive contacts for the Management UI.
 * Shows CEO, COO, and any user who has an active WhatsApp preference.
 */
export async function getExecutiveContactsManagement(): Promise<ExecutiveContact[]> {
  try {
    const db = getDb();
    const rows = await db.execute<{
      id: number;
      full_name: string;
      role: string;
      email: string;
      address: string | null;
      enabled: boolean | null;
    }>(sql`
      SELECT u.id, u.full_name, u.role, u.email, p.address, p.enabled
      FROM users u
      LEFT JOIN user_channel_prefs p ON p.user_id = u.id AND p.channel = 'whatsapp'
      WHERE u.is_active AND (u.role IN ('ceo', 'coo', 'admin') OR p.address IS NOT NULL)
      ORDER BY 
        CASE u.role 
          WHEN 'ceo' THEN 1 
          WHEN 'coo' THEN 2 
          WHEN 'admin' THEN 3 
          ELSE 4 
        END,
        u.full_name ASC
    `);

    return rows.map((r) => {
      const hasDbPhone = Boolean(r.address?.trim());
      let phone = r.address?.trim() ?? '';
      let enabled = r.enabled === true;
      let source: 'database' | 'env' = 'database';

      // Fallback to .env for CEO/COO if not explicitly set in database
      if (!hasDbPhone) {
        if (r.role === 'ceo' && process.env.WHATSAPP_CEO_PHONE?.trim()) {
          phone = process.env.WHATSAPP_CEO_PHONE.trim();
          enabled = true;
          source = 'env';
        } else if (r.role === 'coo' && process.env.WHATSAPP_COO_PHONE?.trim()) {
          phone = process.env.WHATSAPP_COO_PHONE.trim();
          enabled = true;
          source = 'env';
        }
      }

      return {
        userId: r.id,
        fullName: r.full_name,
        role: r.role,
        email: r.email,
        phone,
        enabled,
        source,
      };
    });
  } catch (err) {
    console.error('[WhatsApp Management] Failed to load contacts:', err);
    return [];
  }
}

/**
 * Loads all eligible users (non-clients) that can be added to WhatsApp alerts.
 */
export async function getEligibleManagementUsers(): Promise<{ id: number; full_name: string; role: string; email: string }[]> {
  try {
    const db = getDb();
    return await db.execute<{ id: number; full_name: string; role: string; email: string }>(sql`
      SELECT id, full_name, role, email
      FROM users
      WHERE is_active AND role NOT IN ('client')
      ORDER BY full_name ASC
    `);
  } catch {
    return [];
  }
}

/**
 * Loads configured phone numbers for CEO and COO.
 * Priority:
 * 1. Database user_channel_prefs for users with enabled whatsapp channel (CEO, COO, Management)
 * 2. Fallback to explicit env vars WHATSAPP_CEO_PHONE, WHATSAPP_COO_PHONE, WHATSAPP_MANAGEMENT_PHONES
 */
export async function getExecutiveRecipients(): Promise<AlertRecipient[]> {
  const recipients: AlertRecipient[] = [];
  const foundRoles = new Set<string>();

  // 1. Primary: Database user_channel_prefs for active users
  try {
    const db = getDb();
    const rows = await db.execute<{
      user_id: number;
      role: string;
      full_name: string;
      address: string | null;
      enabled: boolean;
    }>(sql`
      SELECT u.id AS user_id, u.role, u.full_name, p.address, p.enabled
      FROM users u
      JOIN user_channel_prefs p ON p.user_id = u.id AND p.channel = 'whatsapp'
      WHERE u.is_active AND p.enabled AND p.address IS NOT NULL AND p.address <> ''
    `);

    for (const r of rows) {
      if (r.address?.trim()) {
        const cleanPhone = r.address.trim().replace(/[^\d+]/g, '');
        if (cleanPhone.length >= 8 && !recipients.some((existing) => existing.phone === cleanPhone)) {
          const mappedRole: 'ceo' | 'coo' | 'management' =
            r.role === 'ceo' ? 'ceo' : r.role === 'coo' ? 'coo' : 'management';
          recipients.push({
            userId: r.user_id,
            role: mappedRole,
            name: r.full_name,
            phone: cleanPhone,
          });
          foundRoles.add(r.role);
        }
      }
    }
  } catch (err) {
    console.error('[WhatsApp Executive Alerts] Failed to read recipients from db:', err);
  }

  // 2. Fallback to .env for CEO if not found in db
  if (!foundRoles.has('ceo') && process.env.WHATSAPP_CEO_PHONE?.trim()) {
    const clean = process.env.WHATSAPP_CEO_PHONE.trim().replace(/[^\d+]/g, '');
    if (clean.length >= 8 && !recipients.some((r) => r.phone === clean)) {
      recipients.push({ role: 'ceo', name: 'CEO', phone: clean });
    }
  }

  // 3. Fallback to .env for Vice President (COO) if not found in db
  if (!foundRoles.has('coo') && process.env.WHATSAPP_COO_PHONE?.trim()) {
    const clean = process.env.WHATSAPP_COO_PHONE.trim().replace(/[^\d+]/g, '');
    if (clean.length >= 8 && !recipients.some((r) => r.phone === clean)) {
      recipients.push({ role: 'coo', name: 'Vice President', phone: clean });
    }
  }

  // 4. Extra management numbers from .env
  if (process.env.WHATSAPP_MANAGEMENT_PHONES?.trim()) {
    const extras = process.env.WHATSAPP_MANAGEMENT_PHONES.split(',')
      .map((p) => p.trim().replace(/[^\d+]/g, ''))
      .filter((p) => p.length >= 8);
    for (const phone of extras) {
      if (!recipients.some((r) => r.phone === phone)) {
        recipients.push({ role: 'management', name: 'Management', phone });
      }
    }
  }

  return recipients;
}

/**
 * Dispatches a WhatsApp notification to CEO and COO via the available gateway:
 * - Local Free Gateway (Baileys / Evolution API on port 3001)
 * - Official Meta Cloud API (fallback)
 * - Terminal / Server Log (always recorded for audit trail)
 */
export async function sendExecutiveWhatsAppAlert(
  message: string,
  linkPath: string | null = null,
): Promise<{ sent: number; attempted: number; errors: string[] }> {
  const recipients = await getExecutiveRecipients();
  const outcome = { sent: 0, attempted: recipients.length, errors: [] as string[] };

  if (recipients.length === 0) {
    console.log('[WhatsApp Executive Alerts] No CEO/COO phone numbers configured yet.');
    return outcome;
  }

  const baseUrl = (process.env.PORTAL_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const fullLink = linkPath ? (linkPath.startsWith('http') ? linkPath : `${baseUrl}${linkPath}`) : null;
  const outboundText = fullLink ? `${message}\n\n🔗 *Open in Portal:* ${fullLink}` : message;

  const gatewayUrl = process.env.WHATSAPP_GATEWAY_URL?.trim() || 'http://localhost:3001/send';
  const gatewayApiKey = process.env.WHATSAPP_GATEWAY_API_KEY?.trim();

  const metaConfig = channelConfig();
  const senders = makeSenders(metaConfig);

  for (const r of recipients) {
    try {
      let sentSuccess = false;

      // Method A: Free Self-Hosted Gateway (Baileys)
      if (gatewayUrl) {
        try {
          const res = await fetch(gatewayUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(gatewayApiKey ? { Authorization: `Bearer ${gatewayApiKey}`, apikey: gatewayApiKey } : {}),
            },
            body: JSON.stringify({
              number: r.phone.replace(/^\+/, ''),
              phone: r.phone,
              to: r.phone,
              text: outboundText,
              message: outboundText,
            }),
            signal: AbortSignal.timeout(10_000),
          });
          if (res.ok) {
            sentSuccess = true;
            outcome.sent++;
            console.log(`[WhatsApp Alert] Sent to ${r.role.toUpperCase()} (${r.name}: ${r.phone}) via Gateway`);
          } else {
            const errBody = await res.text().catch(() => '');
            outcome.errors.push(`Gateway returned ${res.status} for ${r.phone}: ${errBody.slice(0, 100)}`);
          }
        } catch (fetchErr) {
          outcome.errors.push(`Gateway error for ${r.phone}: ${(fetchErr as Error).message}`);
        }
      }

      // Method B: Meta Cloud API fallback
      if (!sentSuccess && senders.whatsapp) {
        try {
          await senders.whatsapp(r.phone, {
            title: message.slice(0, 900),
            body: null,
            link: fullLink,
          });
          sentSuccess = true;
          outcome.sent++;
          console.log(`[WhatsApp Alert] Sent to ${r.role.toUpperCase()} (${r.name}: ${r.phone}) via Meta API`);
        } catch (metaErr) {
          outcome.errors.push(`Meta Cloud API error for ${r.phone}: ${(metaErr as Error).message}`);
        }
      }

      // Fallback: Always record to server logs for verification and audit
      if (!sentSuccess) {
        console.log(`[WhatsApp Alert Audit Log]`);
        console.log(`To ${r.role.toUpperCase()} (${r.name} - ${r.phone}):\n${outboundText}\n`);
      }
    } catch (e) {
      outcome.errors.push(`Unexpected error sending to ${r.phone}: ${(e as Error).message}`);
    }
  }

  return outcome;
}

/* =========================================================================
 * 5 EXECUTIVE EVENT TRIGGERS (RICH CONTEXTUAL FORMATTING)
 * ========================================================================= */

/**
 * Trigger 1: Revision Requested
 * Triggered when a client or sales opens a revision round.
 */
export async function notifyExecutivesRevision(data: {
  projectCode: string;
  projectTitle: string;
  clientName: string;
  revisionNo: number;
  title: string;
  clientFeedback: string;
  priority: string;
  deliverablesSummary?: string | null;
  assignedTeamOrExecutive?: string | null;
  deadline?: string | null;
  revisionId: number;
}): Promise<void> {
  const isUrgent = data.priority.toLowerCase() === 'urgent';
  const priorityEmoji = isUrgent ? '🚨 URGENT' : '🔄 NORMAL';
  const msg = [
    `*🔄 AKTIVACITY EXECUTIVE DISPATCH*`,
    `*Client Revision Requested*`,
    ``,
    `• *Project:* ${data.projectTitle} (\`${data.projectCode}\`)`,
    `• *Client:* ${data.clientName}`,
    `• *Revision Round:* #${String(data.revisionNo).padStart(2, '0')} — ${data.title}`,
    `• *Priority:* ${priorityEmoji}`,
    data.deliverablesSummary ? `• *Deliverables Affected:* ${data.deliverablesSummary}` : null,
    data.assignedTeamOrExecutive ? `• *Assigned Team/Lead:* ${data.assignedTeamOrExecutive}` : null,
    data.deadline ? `• *Revision Due:* ${data.deadline}` : null,
    ``,
    `• *Client Feedback:*`,
    `"${data.clientFeedback.slice(0, 300)}"`,
    ``,
    `• *Action:* Team Lead to review client feedback and re-assign tasks.`,
  ]
    .filter(Boolean)
    .join('\n');

  await sendExecutiveWhatsAppAlert(msg, `/revisions/${data.revisionId}`);
}

/**
 * Trigger 2: QA Review Decision
 * Triggered when a Team Lead or PM approves, rejects, or requests changes.
 */
export async function notifyExecutivesQaDecision(data: {
  projectCode: string;
  projectTitle: string;
  deliverableName: string;
  department: string;
  producerName?: string | null;
  reviewerName: string;
  reviewerRole: string;
  decision: 'approved' | 'changes_requested' | 'rejected';
  comments?: string | null;
  versionNo: number;
  deliverableId: number;
}): Promise<void> {
  const icon =
    data.decision === 'approved' ? '✅' : data.decision === 'changes_requested' ? '⚠️' : '❌';
  const decisionText =
    data.decision === 'approved'
      ? 'APPROVED'
      : data.decision === 'changes_requested'
        ? 'CHANGES REQUESTED'
        : 'REJECTED';

  const nextStep =
    data.decision === 'approved'
      ? 'Approved for client delivery queue.'
      : data.decision === 'changes_requested'
        ? 'Sent back to executive for correction.'
        : 'Deliverable rejected — requires complete rebuild.';

  const msg = [
    `*${icon} AKTIVACITY EXECUTIVE DISPATCH*`,
    `*QA Review Decision: Deliverable ${decisionText}*`,
    ``,
    `• *Deliverable:* ${data.deliverableName} (v${data.versionNo}) · ${data.department}`,
    `• *Project:* ${data.projectTitle} (\`${data.projectCode}\`)`,
    data.producerName ? `• *Produced By:* ${data.producerName}` : null,
    `• *Reviewed By:* ${data.reviewerName} (${data.reviewerRole})`,
    `• *QA Decision:* ${decisionText}`,
    data.comments ? `• *Reviewer Notes:* "${data.comments.slice(0, 300)}"` : null,
    `• *Next Step:* ${nextStep}`,
  ]
    .filter(Boolean)
    .join('\n');

  await sendExecutiveWhatsAppAlert(msg, `/qa`);
}

/**
 * Trigger 3: New Assignment Created
 * Triggered when Team Lead assigns work to an executive.
 */
export async function notifyExecutivesAssignment(data: {
  projectCode: string;
  projectTitle: string;
  department: string;
  assignerName?: string | null;
  executiveName: string;
  deliverableNames: string[];
  startsOn?: string | null;
  endsOn?: string | null;
  teamId: number;
}): Promise<void> {
  const msg = [
    `*📋 AKTIVACITY EXECUTIVE DISPATCH*`,
    `*Work Allocated to Executive*`,
    ``,
    `• *Department:* ${data.department}`,
    data.assignerName ? `• *Assigned By Lead:* ${data.assignerName}` : null,
    `• *Executive Assigned:* ${data.executiveName}`,
    `• *Project:* ${data.projectTitle} (\`${data.projectCode}\`)`,
    `• *Deliverables:* ${data.deliverableNames.join(', ')}`,
    data.startsOn || data.endsOn ? `• *Timeline:* ${data.startsOn ?? 'Immediate'} → ${data.endsOn ?? 'TBD'}` : null,
    `• *Status:* Executive notified to start production.`,
  ]
    .filter(Boolean)
    .join('\n');

  await sendExecutiveWhatsAppAlert(msg, `/planning/${data.teamId}`);
}

/**
 * Trigger 4: Upcoming Deadline / Overdue
 * Triggered when a project or deliverable is due within 24 hours or overdue.
 */
export async function notifyExecutivesDeadline(data: {
  projectCode: string;
  projectTitle: string;
  title: string;
  kind: string;
  due: string;
  daysLeft: number;
  clientName?: string | null;
  assigneeName?: string | null;
  linkPath: string;
}): Promise<void> {
  const isOverdue = data.daysLeft < 0;
  const urgencyIcon = isOverdue ? '🚨' : data.daysLeft === 0 ? '⏰' : '⚠️';
  const urgencyTitle = isOverdue
    ? `CRITICAL OVERDUE ALERT (${Math.abs(data.daysLeft)} days late)`
    : data.daysLeft === 0
      ? 'DEADLINE DUE TODAY'
      : 'DEADLINE DUE IN 24 HOURS';

  const statusNote = isOverdue
    ? `Task missed its committed deadline by ${Math.abs(data.daysLeft)} days.`
    : data.daysLeft === 0
      ? 'Due by end of day today.'
      : 'Due tomorrow.';

  const msg = [
    `*${urgencyIcon} AKTIVACITY EXECUTIVE DISPATCH*`,
    `*${urgencyTitle}*`,
    ``,
    `• *Project:* ${data.projectTitle} (\`${data.projectCode}\`)`,
    data.clientName ? `• *Client:* ${data.clientName}` : null,
    `• *Item:* ${data.title} (${data.kind})`,
    data.assigneeName ? `• *Responsible Assignee:* ${data.assigneeName}` : null,
    `• *Committed Due Date:* ${data.due}`,
    `• *Status Detail:* ${statusNote}`,
    `• *Risk:* Immediate team follow-up required to prevent client escalation.`,
  ]
    .filter(Boolean)
    .join('\n');

  await sendExecutiveWhatsAppAlert(msg, data.linkPath);
}

/**
 * Trigger 5: New Project Filed (Sales Triage)
 * Triggered when Sales files a new project awaiting PM triage.
 */
export async function notifyExecutivesNewProject(data: {
  projectCode: string;
  title: string;
  clientName: string;
  salesName: string;
  period?: string | null;
  projectId: number;
}): Promise<void> {
  const msg = [
    `*🌟 AKTIVACITY EXECUTIVE DISPATCH*`,
    `*New Client Deal Closed & Project Filed*`,
    ``,
    `• *Project:* ${data.title} (\`${data.projectCode}\`)`,
    `• *Client:* ${data.clientName}`,
    `• *Closed By Sales:* ${data.salesName}`,
    data.period ? `• *Target Period:* ${data.period}` : null,
    `• *Status:* Awaiting PM Review in Project Closure Report (PCR)`,
    `• *Next Action:* Project Manager to review brief and allocate department teams.`,
  ]
    .filter(Boolean)
    .join('\n');

  await sendExecutiveWhatsAppAlert(msg, `/triage`);
}
