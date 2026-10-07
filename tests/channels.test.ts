/**
 * Outbound notifications (brief §29, §46): optional email, Slack and
 * WhatsApp copies of inbox notifications.
 *
 * The senders are exercised against local fakes of an SMTP server and the
 * Slack and WhatsApp APIs; the dispatcher against a real database with fake
 * senders, so retries, opt-outs and leases are tested without any service.
 */
import assert from 'node:assert/strict';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run channel tests';

describe('channel configuration and addresses', () => {
  test('nothing is connected unless configured', async () => {
    const { channelConfig, connectedChannels } = await import('../src/lib/channels/config');
    assert.deepEqual(connectedChannels(channelConfig({})), []);
    const c = channelConfig({
      SMTP_URL: 'smtp://mail.local:25', MAIL_FROM: 'portal@x.com', SLACK_BOT_TOKEN: 'xoxb-1',
      WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1', PORTAL_HOSTNAME: 'portal.local',
    });
    assert.deepEqual(connectedChannels(c), ['email', 'slack'], 'WhatsApp needs its template too');
    assert.equal(c.baseUrl, 'https://portal.local');
  });

  test('addresses are checked per channel', async () => {
    const { addressProblem } = await import('../src/lib/channels/config');
    assert.equal(addressProblem('email', null), null);
    assert.ok(addressProblem('email', 'not-an-email'));
    assert.ok(addressProblem('slack', 'ahmed'));
    assert.equal(addressProblem('slack', 'U0123ABCD'), null);
    assert.ok(addressProblem('whatsapp', '0501234567'));
    assert.equal(addressProblem('whatsapp', '+971501234567'), null);
  });
});

describe('the real senders, against local fakes', () => {
  const servers: { close: () => void }[] = [];
  after(() => servers.forEach((s) => s.close()));

  async function http(handler: (body: string, auth: string | undefined, url: string) => [number, string]) {
    const seen: { body: string; auth?: string; url: string }[] = [];
    const server: Server = createHttpServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ body, auth: req.headers.authorization, url: req.url ?? '' });
        const [status, out] = handler(body, req.headers.authorization, req.url ?? '');
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(out);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
  }

  test('email goes through SMTP with the title as subject and the link in the body', async () => {
    const received: string[] = [];
    const smtp = createTcpServer((socket) => {
      let inData = false; let data = '';
      socket.write('220 fake ESMTP\r\n');
      socket.on('data', (chunk) => {
        for (const line of chunk.toString().split('\r\n').filter((l, i, a) => l !== '' || i < a.length - 1)) {
          if (inData) {
            if (line === '.') { inData = false; received.push(data); socket.write('250 queued\r\n'); } else data += `${line}\n`;
            continue;
          }
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === 'EHLO' || cmd === 'HELO') socket.write('250 fake\r\n');
          else if (cmd === 'DATA') { inData = true; socket.write('354 go\r\n'); }
          else if (cmd === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
          else if (line) socket.write('250 ok\r\n');
        }
      });
    });
    await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
    servers.push(smtp);
    const { makeSenders } = await import('../src/lib/channels/senders');
    const { channelConfig } = await import('../src/lib/channels/config');
    const port = (smtp.address() as AddressInfo).port;
    const senders = makeSenders(channelConfig({ SMTP_URL: `smtp://127.0.0.1:${port}`, MAIL_FROM: 'portal@aktivacity.test' }));
    await senders.email!('ahmed@aktivacity.test', { title: 'QA approved: Video 01', body: 'Nice cut.', link: 'https://portal.local/projects/1' });
    assert.equal(received.length, 1);
    assert.match(received[0], /Subject: QA approved: Video 01/);
    assert.match(received[0], /https:\/\/portal\.local\/projects\/1/);
  });

  test('Slack posts a direct message and treats ok:false as a failure', async () => {
    let ok = true;
    const fake = await http(() => [200, JSON.stringify(ok ? { ok: true } : { ok: false, error: 'user_not_found' })]);
    const { makeSenders } = await import('../src/lib/channels/senders');
    const { channelConfig } = await import('../src/lib/channels/config');
    const senders = makeSenders(channelConfig({ SLACK_BOT_TOKEN: 'xoxb-test', SLACK_API_BASE: fake.base }));
    await senders.slack!('U0123ABCD', { title: 'New task', body: null, link: 'https://portal.local/work' });
    const sent = JSON.parse(fake.seen[0].body);
    assert.equal(fake.seen[0].url, '/chat.postMessage');
    assert.equal(fake.seen[0].auth, 'Bearer xoxb-test');
    assert.equal(sent.channel, 'U0123ABCD');
    assert.match(sent.text, /New task[\s\S]*portal\.local\/work/);
    ok = false;
    await assert.rejects(senders.slack!('U0123ABCD', { title: 'x', body: null, link: null }), /user_not_found/);
  });

  test('WhatsApp sends the approved template with the title and link', async () => {
    const fake = await http(() => [200, '{"messages":[{"id":"x"}]}']);
    const { makeSenders } = await import('../src/lib/channels/senders');
    const { channelConfig } = await import('../src/lib/channels/config');
    const senders = makeSenders(channelConfig({
      WHATSAPP_TOKEN: 'wa', WHATSAPP_PHONE_NUMBER_ID: '555', WHATSAPP_TEMPLATE: 'portal_update', WHATSAPP_API_BASE: fake.base,
    }));
    await senders.whatsapp!('+971501234567', { title: 'Revision #03 received', body: null, link: 'https://portal.local/revisions/3' });
    const sent = JSON.parse(fake.seen[0].body);
    assert.equal(fake.seen[0].url, '/555/messages');
    assert.equal(sent.to, '971501234567');
    assert.equal(sent.template.name, 'portal_update');
    assert.deepEqual(sent.template.components[0].parameters.map((p: { text: string }) => p.text),
      ['Revision #03 received', 'https://portal.local/revisions/3']);
  });
});

describe('the dispatcher (brief §29)', { skip }, () => {
  let sql: ReturnType<typeof postgres>;
  let dispatchDue: typeof import('../src/lib/channels/dispatch').dispatchDue;
  let getDb: typeof import('../src/db').getDb;
  const ids: Record<string, number> = {};
  const DOMAIN = '@chantest.local';
  const sent: { channel: string; to: string; title: string; link: string | null }[] = [];
  let failNext = 0;
  const fake = (channel: string) => async (to: string, m: { title: string; link: string | null }) => {
    if (failNext > 0) { failNext--; throw new Error('mail server down'); }
    sent.push({ channel, to, title: m.title, link: m.link });
  };
  const senders = { email: fake('email'), slack: fake('slack') };
  const run = () => dispatchDue(getDb(), senders, { baseUrl: 'https://portal.local' });
  const notify = async (userId: number, title: string) => Number((await sql`
    INSERT INTO notifications (user_id, type, title, link_path) VALUES (${userId}, 'test', ${title}, '/work') RETURNING id`)[0].id);

  before(async () => {
    if (skip) return;
    sql = postgres(DATABASE_URL!, { max: 1, onnotice: () => {} });
    ({ dispatchDue } = await import('../src/lib/channels/dispatch'));
    ({ getDb } = await import('../src/db'));
    await sql`DELETE FROM users WHERE email LIKE ${'%' + DOMAIN}`;
    for (const key of ['ahmed', 'sara', 'omar']) {
      ids[key] = Number((await sql`INSERT INTO users (email, password_hash, full_name, role)
        VALUES (${key + DOMAIN}, 'x', ${key}, 'executive') RETURNING id`)[0].id);
    }
    await sql`INSERT INTO notifications (user_id, type, title, created_at)
      VALUES (${ids.ahmed}, 'test', 'Before opting in', now() - interval '1 hour')`;
    await sql`INSERT INTO user_channel_prefs (user_id, channel, enabled, address, updated_at) VALUES
      (${ids.ahmed}, 'email', true, null, now() - interval '1 second'),
      (${ids.ahmed}, 'slack', true, 'U0AHMED01', now() - interval '1 second'),
      (${ids.sara}, 'email', false, null, now() - interval '1 second'),
      (${ids.omar}, 'whatsapp', true, '+971500000000', now() - interval '1 second')`;
  });
  after(async () => {
    if (skip || !sql) return;
    await sql`DELETE FROM users WHERE email LIKE ${'%' + DOMAIN}`;
    await sql.end();
  });

  test('each opted-in channel gets one copy, with a link; nobody else does', async () => {
    await notify(ids.ahmed, 'New task assigned');
    await notify(ids.sara, 'For Sara');
    await notify(ids.omar, 'For Omar'); // WhatsApp is not connected in this run
    await run();
    const mine = sent.filter((s) => s.title !== 'Before opting in');
    assert.deepEqual(mine.map((s) => [s.channel, s.to, s.title]).sort(), [
      ['email', `ahmed${DOMAIN}`, 'New task assigned'],
      ['slack', 'U0AHMED01', 'New task assigned'],
    ]);
    assert.equal(mine[0].link, 'https://portal.local/work');
    assert.equal(sent.some((s) => s.title === 'Before opting in'), false, 'switching on does not replay the past');
    await run();
    assert.equal(sent.filter((s) => s.title === 'New task assigned').length, 2, 'never twice');
  });

  test('a failure is retried with backoff, then given up', async () => {
    const id = await notify(ids.ahmed, 'Deadline approaching');
    await sql`UPDATE user_channel_prefs SET enabled = false WHERE user_id = ${ids.ahmed} AND channel = 'slack'`;
    failNext = 1;
    const first = await run();
    assert.equal(first.retrying, 1);
    const [row] = await sql`SELECT status, attempts, last_error, next_attempt_at > now() AS later FROM notification_dispatches WHERE notification_id = ${id}`;
    assert.deepEqual([row.status, row.attempts, row.last_error, row.later], ['pending', 1, 'mail server down', true]);
    await sql`UPDATE notification_dispatches SET next_attempt_at = now() WHERE notification_id = ${id}`;
    await run();
    assert.ok(sent.some((s) => s.title === 'Deadline approaching'));
    const [done] = await sql`SELECT status, attempts FROM notification_dispatches WHERE notification_id = ${id}`;
    assert.deepEqual([done.status, done.attempts], ['sent', 2]);

    const doomed = await notify(ids.ahmed, 'Doomed');
    for (let i = 0; i < 5; i++) {
      failNext = 1;
      await sql`UPDATE notification_dispatches SET next_attempt_at = now() WHERE notification_id = ${doomed}`;
      await run();
    }
    const [gaveUp] = await sql`SELECT status, attempts FROM notification_dispatches WHERE notification_id = ${doomed}`;
    assert.deepEqual([gaveUp.status, gaveUp.attempts], ['failed', 5]);
  });

  test('switching a channel off drops what was waiting', async () => {
    const id = await notify(ids.ahmed, 'Waiting');
    failNext = 1;
    await run();
    await sql`UPDATE user_channel_prefs SET enabled = false WHERE user_id = ${ids.ahmed} AND channel = 'email'`;
    await sql`UPDATE notification_dispatches SET next_attempt_at = now() WHERE notification_id = ${id}`;
    await run();
    const [row] = await sql`SELECT status, last_error FROM notification_dispatches WHERE notification_id = ${id} AND channel = 'email'`;
    assert.deepEqual([row.status, row.last_error], ['failed', 'Channel switched off.']);
    assert.equal(sent.some((s) => s.title === 'Waiting'), false);
  });

  test('two dispatchers at once send each copy once', async () => {
    await sql`UPDATE user_channel_prefs SET enabled = true, updated_at = now() - interval '1 second' WHERE user_id = ${ids.ahmed} AND channel = 'email'`;
    for (let i = 0; i < 5; i++) await notify(ids.ahmed, `Burst ${i}`);
    await Promise.all([run(), run(), run()]);
    const burst = sent.filter((s) => s.title.startsWith('Burst'));
    assert.equal(burst.length, 5);
    assert.equal(new Set(burst.map((s) => s.title)).size, 5);
  });
});
