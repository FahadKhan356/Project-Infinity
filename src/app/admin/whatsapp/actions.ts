'use server';

import { revalidatePath } from 'next/cache';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
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

/**
 * Saves or updates a user's WhatsApp alert number in PostgreSQL database.
 */
export async function saveExecutiveContact(
  _prev: WhatsAppAdminState,
  formData: FormData,
): Promise<WhatsAppAdminState> {
  const actor = await requireActor();
  if (actor.role !== 'ceo' && actor.role !== 'coo') {
    return { error: 'Only the CEO and COO are permitted to manage executive WhatsApp alerts.' };
  }

  const userId = Number(formData.get('userId'));
  const phone = String(formData.get('phone') ?? '').trim();
  const enabled = formData.get('enabled') === 'on' || formData.get('enabled') === 'true';

  if (!Number.isInteger(userId)) {
    return { error: 'Invalid user ID.' };
  }

  const cleanDigits = phone.replace(/[^\d+]/g, '');
  if (enabled && cleanDigits.length < 8) {
    return { error: 'Please enter a valid phone number with country code (e.g. +923001234567).' };
  }

  try {
    const db = getDb();
    await db.execute(sql`
      INSERT INTO user_channel_prefs (user_id, channel, enabled, address, updated_at)
      VALUES (${userId}, 'whatsapp', ${enabled}, ${cleanDigits || null}, now())
      ON CONFLICT (user_id, channel) DO UPDATE
        SET enabled = EXCLUDED.enabled, address = EXCLUDED.address, updated_at = now()
    `);

    revalidatePath('/admin/whatsapp');
    return { success: `WhatsApp alert settings successfully updated!` };
  } catch (err) {
    return { error: `Failed to save contact: ${(err as Error).message}` };
  }
}

/**
 * Removes or disables a user from WhatsApp alerts.
 */
export async function removeExecutiveContact(
  _prev: WhatsAppAdminState,
  formData: FormData,
): Promise<WhatsAppAdminState> {
  const actor = await requireActor();
  if (actor.role !== 'ceo' && actor.role !== 'coo') {
    return { error: 'Only the CEO and COO are permitted to manage executive WhatsApp alerts.' };
  }

  const userId = Number(formData.get('userId'));
  if (!Number.isInteger(userId)) {
    return { error: 'Invalid user ID.' };
  }

  try {
    const db = getDb();
    await db.execute(sql`
      UPDATE user_channel_prefs
      SET enabled = false, updated_at = now()
      WHERE user_id = ${userId} AND channel = 'whatsapp'
    `);

    revalidatePath('/admin/whatsapp');
    return { success: 'Contact disabled from WhatsApp alerts.' };
  } catch (err) {
    return { error: `Failed to remove contact: ${(err as Error).message}` };
  }
}

/**
 * Triggers a test alert to all configured recipients.
 */
export async function sendTestAlert(
  _prev: WhatsAppAdminState,
  _formData: FormData,
): Promise<WhatsAppAdminState> {
  const actor = await requireActor();
  if (actor.role !== 'ceo' && actor.role !== 'coo') {
    return { error: 'Only the CEO and COO are permitted to trigger test alerts.' };
  }

  const recipients = await getExecutiveRecipients();
  if (recipients.length === 0) {
    return {
      error:
        'No executive phone numbers are configured. Enter your phone number below and click Save.',
    };
  }

  const testMessage = [
    `*🧪 AKTIVACITY TEST DISPATCH*`,
    `This is a verified test notification from the Aktivacity Project Portal.`,
    ``,
    `• *Triggered By:* ${actor.fullName} (${actor.role.toUpperCase()})`,
    `• *Status:* Executive WhatsApp Alert Network is Active ✅`,
    `• *Active Triggers:* Client Revisions, QA Reviews, Assignments, Deadlines, & Intake.`,
    `• *Target Recipients:* ${recipients.map((r) => `${r.name} (${r.phone})`).join(', ')}`,
  ].join('\n');

  try {
    const res = await sendExecutiveWhatsAppAlert(testMessage, '/dashboard');
    revalidatePath('/admin/whatsapp');

    if (res.sent > 0) {
      return {
        success: `Successfully delivered test WhatsApp alert to ${res.sent} executive recipient(s)!`,
      };
    }
    return {
      success: `Test message prepared for ${recipients.map((r) => `${r.role}: ${r.phone}`).join(', ')}. (Check gateway terminal for real-time delivery audit).`,
    };
  } catch (err) {
    return { error: `Failed to dispatch test message: ${(err as Error).message}` };
  }
}
