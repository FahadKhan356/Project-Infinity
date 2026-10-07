/**
 * Sends inbox notifications out by email, Slack and WhatsApp (brief §29).
 * Optional (§46): with no channel configured it says so and exits.
 *
 *   npm run notifications:dispatch               — one pass
 *   npm run notifications:dispatch -- --watch    — every 30 s, for the `notifier` service
 */
import { getDb } from '../src/db';
import { channelConfig, connectedChannels } from '../src/lib/channels/config';
import { dispatchDue } from '../src/lib/channels/dispatch';
import { makeSenders } from '../src/lib/channels/senders';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const config = channelConfig();
  const channels = connectedChannels(config);
  if (channels.length === 0) {
    console.log('No outbound channel is configured (SMTP_URL, SLACK_BOT_TOKEN, WHATSAPP_TOKEN). Nothing to do.');
    return;
  }
  if (!config.baseUrl) console.warn('PORTAL_BASE_URL is not set; messages will carry no link.');
  const senders = makeSenders(config);
  const watch = process.argv.includes('--watch');
  console.log(`Dispatching over: ${channels.join(', ')}${watch ? ' (watching)' : ''}`);

  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  do {
    try {
      const r = await dispatchDue(getDb(), senders, { baseUrl: config.baseUrl });
      if (r.queued || r.sent || r.retrying || r.failed) {
        console.log(`${new Date().toISOString()} queued ${r.queued}, sent ${r.sent}, retrying ${r.retrying}, failed ${r.failed}`);
      }
    } catch (error) {
      // A database blip must not kill the watcher; the next pass tries again.
      console.error('dispatch pass failed:', error);
      if (!watch) throw error;
    }
    for (let i = 0; watch && !stopping && i < 30; i++) await sleep(1000);
  } while (watch && !stopping);

  const g = globalThis as unknown as { __sql?: { end: () => Promise<void> } };
  await g.__sql?.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
