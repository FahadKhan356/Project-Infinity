import nodemailer from 'nodemailer';
import type { Channel, ChannelConfig } from './config';

export interface OutboundMessage {
  title: string;
  body: string | null;
  /** Absolute link back into the portal, or null. */
  link: string | null;
}

export type Sender = (to: string, message: OutboundMessage) => Promise<void>;

/**
 * One function per connected channel. Each throws on anything but a clear
 * success, so the dispatcher can retry; none of them is called from a web
 * request.
 */
export function makeSenders(config: ChannelConfig): Partial<Record<Channel, Sender>> {
  const senders: Partial<Record<Channel, Sender>> = {};

  if (config.email) {
    const { url, from } = config.email;
    const transport = nodemailer.createTransport(url);
    senders.email = async (to, m) => {
      const lines = [m.body, m.link ? `Open it in the portal: ${m.link}` : null].filter(Boolean);
      await transport.sendMail({
        from, to, subject: m.title,
        text: `${lines.join('\n\n')}\n\n— Aktivacity Portal`,
      });
    };
  }

  if (config.slack) {
    const { token, apiBase } = config.slack;
    senders.slack = async (to, m) => {
      const text = [`*${m.title}*`, m.body, m.link ? `<${m.link}|Open in the portal>` : null].filter(Boolean).join('\n');
      const res = await fetch(`${apiBase}/chat.postMessage`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel: to, text, unfurl_links: false }),
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || json.ok !== true) throw new Error(`Slack: ${json.error ?? res.status}`);
    };
  }

  if (config.whatsapp) {
    const { token, phoneNumberId, template, language, apiBase } = config.whatsapp;
    // Business-initiated WhatsApp messages must use an approved template. The
    // template is expected to take two body parameters: the title and a link.
    senders.whatsapp = async (to, m) => {
      const res = await fetch(`${apiBase}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: to.replace(/^\+/, ''),
          type: 'template',
          template: {
            name: template,
            language: { code: language },
            components: [{
              type: 'body',
              parameters: [
                { type: 'text', text: m.title.slice(0, 900) },
                { type: 'text', text: m.link ?? '-' },
              ],
            }],
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`WhatsApp: ${res.status} ${detail.slice(0, 200)}`);
      }
    };
  }

  return senders;
}
