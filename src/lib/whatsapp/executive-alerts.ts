import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { channelConfig } from '@/lib/channels/config';
import { makeSenders } from '@/lib/channels/senders';

export interface AlertRecipient {
  role: 'ceo' | 'coo' | 'management';
  name: string;
  phone: string;
}

/**
 * Loads configured phone numbers for CEO and COO.
 * Priority:
 * 1. Explicit env vars WHATSAPP_CEO_PHONE, WHATSAPP_COO_PHONE, WHATSAPP_MANAGEMENT_PHONES
 * 2. Database user_channel_prefs for users with role 'ceo' or 'coo'
 */
export async function getExecutiveRecipients(): Promise<AlertRecipient[]> {
  const recipients: AlertRecipient[] = [];

  // Check explicit env configuration
  if (process.env.WHATSAPP_CEO_PHONE?.trim()) {
    recipients.push({
      role: 'ceo',
      name: 'CEO',
      phone: process.env.WHATSAPP_CEO_PHONE.trim().replace(/[^\d+]/g, ''),
    });
  }
  if (process.env.WHATSAPP_COO_PHONE?.trim()) {
    recipients.push({
      role: 'coo',
      name: 'COO',
      phone: process.env.WHATSAPP_COO_PHONE.trim().replace(/[^\d+]/g, ''),
    });
  }

  // Comma-separated extras
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

  // Database lookup fallback for active CEO & COO accounts
  try {
    const db = getDb();
    const rows = await db.execute<{ role: 'ceo' | 'coo'; full_name: string; address: string | null }>(sql`
      SELECT u.role, u.full_name, p.address
      FROM users u
      LEFT JOIN user_channel_prefs p ON p.user_id = u.id AND p.channel = 'whatsapp' AND p.enabled
      WHERE u.is_active AND u.role IN ('ceo', 'coo')
    `);

    for (const r of rows) {
      if (r.address?.trim()) {
        const cleanPhone = r.address.trim().replace(/[^\d+]/g, '');
        if (cleanPhone.length >= 8 && !recipients.some((existing) => existing.phone === cleanPhone)) {
          recipients.push({ role: r.role, name: r.full_name, phone: cleanPhone });
        }
      }
    }
  } catch (err) {
    console.error('[WhatsApp Executive Alerts] Failed to read recipients from db:', err);
  }

  return recipients;
}

/**
 * Dispatches a WhatsApp notification to CEO and COO via the available gateway:
 * - Local Free Gateway (Evolution API, Baileys, or local webhook via WHATSAPP_GATEWAY_URL)
 * - Official Meta Cloud API (via WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID)
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
  const outboundText = fullLink ? `${message}\n\n🔗 Open in Portal: ${fullLink}` : message;

  // 1. Check for Free Local Gateway / Webhook (WHATSAPP_GATEWAY_URL)
  const gatewayUrl = process.env.WHATSAPP_GATEWAY_URL?.trim();
  const gatewayApiKey = process.env.WHATSAPP_GATEWAY_API_KEY?.trim();

  // 2. Check for Meta Cloud API config
  const metaConfig = channelConfig();
  const senders = makeSenders(metaConfig);

  for (const r of recipients) {
    try {
      let sentSuccess = false;

      // Method A: Free Self-Hosted Gateway (e.g. Evolution API, Baileys, or local microservice)
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

      // Method B: Meta Cloud API (if senders.whatsapp is configured and not sent yet)
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
        console.log(`[WhatsApp Alert Audit Log] (Standby - Configure Gateway to receive on phone)`);
        console.log(`To ${r.role.toUpperCase()} (${r.name} - ${r.phone}):\n${outboundText}\n`);
      }
    } catch (e) {
      outcome.errors.push(`Unexpected error sending to ${r.phone}: ${(e as Error).message}`);
    }
  }

  return outcome;
}

/* =========================================================================
 * 5 EXECUTIVE EVENT TRIGGERS
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
  revisionId: number;
}): Promise<void> {
  const priorityEmoji = data.priority.toLowerCase() === 'urgent' ? '🚨 URGENT' : '🔄';
  const msg = [
    `*${priorityEmoji} Aktivacity Alert: Revision Requested*`,
    `• *Project:* ${data.projectTitle} (\`${data.projectCode}\`)`,
    `• *Revision:* #${String(data.revisionNo).padStart(2, '0')} - ${data.title}`,
    `• *Client:* ${data.clientName}`,
    `• *Priority:* ${data.priority.toUpperCase()}`,
    `• *Feedback:* "${data.clientFeedback.slice(0, 200)}"`,
  ].join('\n');

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

  const msg = [
    `*${icon} Aktivacity QA Update: Deliverable ${decisionText}*`,
    `• *Deliverable:* ${data.deliverableName} (v${data.versionNo}) · ${data.department}`,
    `• *Project:* ${data.projectTitle} (\`${data.projectCode}\`)`,
    `• *Reviewed by:* ${data.reviewerName} (${data.reviewerRole})`,
    data.comments ? `• *Notes:* "${data.comments.slice(0, 200)}"` : null,
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
  executiveName: string;
  deliverableNames: string[];
  startsOn?: string | null;
  endsOn?: string | null;
  teamId: number;
}): Promise<void> {
  const msg = [
    `*📋 Aktivacity Alert: Work Assigned*`,
    `• *Team:* ${data.department}`,
    `• *Assigned to:* ${data.executiveName}`,
    `• *Project:* ${data.projectTitle} (\`${data.projectCode}\`)`,
    `• *Deliverables:* ${data.deliverableNames.join(', ')}`,
    data.startsOn || data.endsOn ? `• *Timeline:* ${data.startsOn ?? '—'} → ${data.endsOn ?? '—'}` : null,
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
  clientName: string;
  linkPath: string;
}): Promise<void> {
  const isOverdue = data.daysLeft < 0;
  const urgency = isOverdue
    ? `🚨 OVERDUE (${Math.abs(data.daysLeft)}d late)`
    : data.daysLeft === 0
      ? '⏰ DUE TODAY'
      : `⚠️ DUE IN 24 HOURS`;

  const msg = [
    `*${urgency} - Aktivacity Deadline Alert*`,
    `• *Project:* ${data.projectTitle} (\`${data.projectCode}\`)`,
    `• *Item:* ${data.title} (${data.kind})`,
    `• *Client:* ${data.clientName}`,
    `• *Due Date:* ${data.due}`,
  ].join('\n');

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
  projectId: number;
}): Promise<void> {
  const msg = [
    `*✨ Aktivacity Alert: New Project Filed*`,
    `• *Project:* ${data.title} (\`${data.projectCode}\`)`,
    `• *Client:* ${data.clientName}`,
    `• *Filed by Sales:* ${data.salesName}`,
    `• *Status:* Awaiting PM Review in Project Closure Report`,
  ].join('\n');

  await sendExecutiveWhatsAppAlert(msg, `/triage`);
}
