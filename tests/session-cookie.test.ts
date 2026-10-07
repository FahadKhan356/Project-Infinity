/**
 * The session cookie's Secure flag follows the connection, not NODE_ENV.
 *
 * A Secure cookie sent over plain HTTP is dropped by the browser, so a
 * production build opened at http://<server-ip>:3000 on the office network
 * would sign everyone straight back out (brief §40). Behind Caddy the flag
 * must still be set.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
// First of the Next imports, as in Next's own server: it provides the
// AsyncLocalStorage that request scopes (cookies(), headers()) live in.
import 'next/dist/server/node-environment-baseline';
import type postgres from 'postgres';
import { sessionCookieSecure } from '../src/lib/auth/cookie-policy';

const auto = {};

describe('session cookie Secure flag', () => {
  test('is set when the browser came over HTTPS (Caddy)', () => {
    assert.equal(sessionCookieSecure('https', auto), true);
    assert.equal(sessionCookieSecure('HTTPS', auto), true);
  });

  test('is not set on plain HTTP, so a LAN install keeps its sessions', () => {
    assert.equal(sessionCookieSecure('http', auto), false);
    assert.equal(sessionCookieSecure(null, auto), false);
    assert.equal(sessionCookieSecure('', auto), false);
  });

  test('only the first proxy hop counts', () => {
    assert.equal(sessionCookieSecure('https, http', auto), true);
    assert.equal(sessionCookieSecure('http, https', auto), false);
    assert.equal(sessionCookieSecure(' https ,http', auto), true);
  });

  test('does not depend on NODE_ENV', () => {
    const productionBuild = { NODE_ENV: 'production', SESSION_COOKIE_SECURE: undefined };
    assert.equal(sessionCookieSecure('http', productionBuild), false);
  });

  test('SESSION_COOKIE_SECURE overrides the detection either way', () => {
    assert.equal(sessionCookieSecure('http', { SESSION_COOKIE_SECURE: 'true' }), true);
    assert.equal(sessionCookieSecure(null, { SESSION_COOKIE_SECURE: 'TRUE' }), true);
    assert.equal(sessionCookieSecure('https', { SESSION_COOKIE_SECURE: 'false' }), false);
  });

  test('a blank or unrecognised SESSION_COOKIE_SECURE means detect', () => {
    assert.equal(sessionCookieSecure('https', { SESSION_COOKIE_SECURE: '' }), true);
    assert.equal(sessionCookieSecure('http', { SESSION_COOKIE_SECURE: '' }), false);
    assert.equal(sessionCookieSecure('http', { SESSION_COOKIE_SECURE: 'yes' }), false);
  });
});

/**
 * That the sign-in path actually applies the rule: createSession, run the
 * way Next runs it, inside a request scope (next 16.3's own store factories,
 * as in files.test.ts) whose X-Forwarded-Proto is what the browser used.
 * Needs DATABASE_URL, for the session row.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'set DATABASE_URL to a migrated database to run createSession';
const EMAIL = 'session-cookie-2083@test.local';

describe('createSession', { skip }, () => {
  let sql: ReturnType<typeof postgres>;
  let userId: number;
  let session: typeof import('../src/lib/auth/session');
  let next: {
    NextRequest: typeof import('next/server').NextRequest;
    workAsyncStorage: typeof import('next/dist/server/app-render/work-async-storage.external').workAsyncStorage;
    workUnitAsyncStorage: typeof import('next/dist/server/app-render/work-unit-async-storage.external').workUnitAsyncStorage;
    createRequestStoreForAPI: typeof import('next/dist/server/async-storage/request-store').createRequestStoreForAPI;
    createWorkStore: typeof import('next/dist/server/async-storage/work-store').createWorkStore;
  };
  let savedOverride: string | undefined;

  before(async () => {
    if (skip) return;
    next = {
      ...(await import('next/server')),
      ...(await import('next/dist/server/app-render/work-async-storage.external')),
      ...(await import('next/dist/server/app-render/work-unit-async-storage.external')),
      ...(await import('next/dist/server/async-storage/request-store')),
      ...(await import('next/dist/server/async-storage/work-store')),
    };
    session = await import('../src/lib/auth/session');
    sql = (await import('postgres')).default(DATABASE_URL!, { max: 1, onnotice: () => {} });

    await purge();
    [{ id: userId }] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role)
      VALUES (${EMAIL}, 'x', 'Session Cookie 2083', 'executive') RETURNING id::int AS id`;

    // The detection, not the override, is under test.
    savedOverride = process.env.SESSION_COOKIE_SECURE;
    delete process.env.SESSION_COOKIE_SECURE;
  });

  after(async () => {
    if (skip || !sql) return;
    if (savedOverride !== undefined) process.env.SESSION_COOKIE_SECURE = savedOverride;
    await purge();
    await sql.end({ timeout: 2 });
  });

  async function purge() {
    await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ${EMAIL})`;
    await sql`DELETE FROM users WHERE email = ${EMAIL}`;
  }

  /** The Set-Cookie createSession produces for a sign-in that arrived over `proto`. */
  async function cookieFor(proto: string | null) {
    const request = new next.NextRequest('http://portal.test/login', {
      method: 'POST',
      headers: proto === null ? {} : { 'x-forwarded-proto': proto },
    });
    const requestStore = next.createRequestStoreForAPI(
      request, request.nextUrl, undefined as never, undefined, undefined as never, undefined,
    );
    const workStore = next.createWorkStore({
      page: '/login',
      renderOpts: { experimental: {}, supportsDynamicResponse: true } as never,
      buildId: 'test',
      deploymentId: 'test',
      previouslyRevalidatedTags: [],
    });
    await next.workUnitAsyncStorage.run(requestStore, () =>
      next.workAsyncStorage.run(workStore, () => session.createSession(userId)));
    const cookie = requestStore.mutableCookies.get(session.SESSION_COOKIE);
    assert.ok(cookie, 'a session cookie is set');
    return cookie;
  }

  test('over HTTPS (Caddy) the cookie is Secure', async () => {
    const cookie = await cookieFor('https');
    assert.equal(cookie.secure, true);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, 'lax');
  });

  test('over plain HTTP on the office network it is not, so the browser keeps it', async () => {
    assert.equal((await cookieFor('http')).secure, false);
    assert.equal((await cookieFor(null)).secure, false);
  });

  test('each sign-in is a real session row', async () => {
    const cookie = await cookieFor('https');
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM sessions WHERE id = ${cookie.value}::uuid AND user_id = ${userId}`;
    assert.equal(row.n, 1);
  });
});
