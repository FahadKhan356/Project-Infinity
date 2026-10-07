/**
 * The proxy is an optimistic gate. Its one dangerous failure mode is treating
 * a cookie as proof of a session: a stale cookie then bounces between /login
 * and /dashboard forever, which is what happens on every expiry, revocation
 * and password change.
 */
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { NextRequest } from 'next/server';

let proxy: typeof import('../src/proxy').proxy;

before(async () => {
  ({ proxy } = await import('../src/proxy'));
});

function request(path: string, withCookie: boolean) {
  const req = new NextRequest(new URL(`http://portal.test${path}`));
  if (withCookie) req.cookies.set('aktivacity_session', 'bd4f2c2e-0000-4000-8000-000000000000');
  return req;
}

const locationOf = (res: Response) => res.headers.get('location');

describe('proxy', () => {
  test('sends a visitor with no cookie to the login page', () => {
    const res = proxy(request('/dashboard', false));
    assert.equal(res.status, 307);
    assert.equal(new URL(locationOf(res)!).pathname, '/login');
  });

  test('lets a visitor with no cookie reach the login page', () => {
    const res = proxy(request('/login', false));
    assert.equal(locationOf(res), null);
  });

  test('lets a phone fetch the manifest and icons before signing in (brief §29)', () => {
    for (const path of ['/manifest.webmanifest', '/icon', '/apple-icon']) {
      assert.equal(locationOf(proxy(request(path, false))), null, path);
    }
    assert.notEqual(locationOf(proxy(request('/iconography', false))), null, 'only those exact paths');
  });

  test('does NOT bounce a cookie holder off /login', () => {
    // A stale cookie must not create a redirect loop; only the login page,
    // which can actually resolve the session, may redirect away.
    const res = proxy(request('/login', true));
    assert.equal(locationOf(res), null, '/login must render for a cookie holder');
  });

  test('lets a cookie holder through to protected pages for the real check', () => {
    const res = proxy(request('/projects', true));
    assert.equal(locationOf(res), null);
  });
});
