/**
 * Which outbound channels are connected (brief §29, §46). Each is optional
 * and read from the environment; with none set, the portal's own inbox is
 * the only channel and nothing ever leaves the building.
 *
 *   SMTP_URL, MAIL_FROM                    — email, via the office mail server
 *   SLACK_BOT_TOKEN                        — Slack direct messages
 *   WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TEMPLATE[, WHATSAPP_TEMPLATE_LANG]
 *                                          — WhatsApp Business Cloud API
 *   PORTAL_BASE_URL                        — for links back into the portal
 */
export type Channel = 'email' | 'slack' | 'whatsapp';
export const CHANNELS: Channel[] = ['email', 'slack', 'whatsapp'];

export interface ChannelConfig {
  baseUrl: string;
  email: { url: string; from: string } | null;
  slack: { token: string; apiBase: string } | null;
  whatsapp: { token: string; phoneNumberId: string; template: string; language: string; apiBase: string } | null;
}

export function channelConfig(env: Record<string, string | undefined> = process.env): ChannelConfig {
  const baseUrl = (env.PORTAL_BASE_URL || (env.PORTAL_HOSTNAME ? `https://${env.PORTAL_HOSTNAME}` : '')).replace(/\/$/, '');
  return {
    baseUrl,
    email: env.SMTP_URL && env.MAIL_FROM ? { url: env.SMTP_URL, from: env.MAIL_FROM } : null,
    slack: env.SLACK_BOT_TOKEN
      ? { token: env.SLACK_BOT_TOKEN, apiBase: (env.SLACK_API_BASE || 'https://slack.com/api').replace(/\/$/, '') }
      : null,
    whatsapp: env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_TEMPLATE
      ? {
        token: env.WHATSAPP_TOKEN,
        phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
        template: env.WHATSAPP_TEMPLATE,
        language: env.WHATSAPP_TEMPLATE_LANG || 'en',
        apiBase: (env.WHATSAPP_API_BASE || 'https://graph.facebook.com/v21.0').replace(/\/$/, ''),
      }
      : null,
  };
}

export function connectedChannels(config: ChannelConfig = channelConfig()): Channel[] {
  return CHANNELS.filter((c) => config[c] !== null);
}

/** Checks an address for a channel; returns a problem, or null when it is usable. */
export function addressProblem(channel: Channel, address: string | null): string | null {
  if (channel === 'email') {
    return address && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? 'Enter a valid email address, or leave it blank to use your login.' : null;
  }
  if (!address) return channel === 'slack' ? 'Enter your Slack member ID.' : 'Enter your WhatsApp number.';
  if (channel === 'slack' && !/^[UW][A-Z0-9]{6,}$/.test(address)) {
    return 'A Slack member ID looks like U0123ABCD (Profile → ⋮ → Copy member ID).';
  }
  if (channel === 'whatsapp' && !/^\+[1-9]\d{7,14}$/.test(address)) {
    return 'Enter the number in international format, like +971501234567.';
  }
  return null;
}
