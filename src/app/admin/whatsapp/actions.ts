'use server';

import { revalidatePath } from 'next/cache';
import { requireActor } from '@/lib/auth/dal';
import { can } from '@/lib/authz';
import {
  getExecutiveRecipients,
  sendExecutiveWhatsAppAlert,
} from '@/lib/whatsapp/executive-alerts';

export interface WhatsAppAdminState {
  success?: string;
  error?: string;
}

export async function sendTestAlert(
  _prev: WhatsAppAdminState,
  _formData: FormData,
): Promise<WhatsAppAdminState> {
  const actor = await requireActor();
  if (!can(actor, 'users.manage')) {
    return { error: 'You are not permitted to manage notifications.' };
  }

  const recipients = await getExecutiveRecipients();
  if (recipients.length === 0) {
    return {
      error:
        'No CEO or COO phone numbers are configured. Add WHATSAPP_CEO_PHONE or WHATSAPP_COO_PHONE to .env or user settings.',
    };
  }

  const testMessage = [
    `*🧪 Aktivacity Test Alert*`,
    `This is a verified test notification from the Aktivacity Project Portal.`,
    `• *Triggered by:* ${actor.fullName} (${actor.role.toUpperCase()})`,
    `• *Status:* Executive WhatsApp Alert System is Active ✅`,
    `• *Monitored Events:* Revisions, QA Reviews, Assignments, Deadlines, & Intake.`,
  ].join('\n');

  try {
    const res = await sendExecutiveWhatsAppAlert(testMessage, '/dashboard');
    revalidatePath('/admin/whatsapp');

    if (res.sent > 0) {
      return {
        success: `Successfully sent test WhatsApp alert to ${res.sent} executive recipient(s)!`,
      };
    }
    return {
      success: `Test message prepared for ${recipients.map((r) => `${r.role}: ${r.phone}`).join(', ')}. (Check gateway connection status or server log for dispatch audit).`,
    };
  } catch (err) {
    return { error: `Failed to dispatch test message: ${(err as Error).message}` };
  }
}
