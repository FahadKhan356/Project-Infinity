import { NextResponse, type NextRequest } from 'next/server';

/**
 * Optimistic gate only: it checks whether a session cookie is *present*, never
 * whether it is valid. Real authorization happens in the data access layer
 * (src/lib/auth/dal.ts), which every page and action goes through.
 *
 * Proxy runs on every request including prefetches, so it must not touch the
 * database.
 */
const PUBLIC_PATHS = ['/login'];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = request.cookies.has('aktivacity_session');
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  // Send anyone without a cookie to the login page.
  if (!hasSession && !isPublic) {
    return NextResponse.redirect(new URL('/login', request.nextUrl));
  }

  // Deliberately NOT the mirror image: a cookie holder is never bounced off
  // /login from here. The cookie may be stale — expired, or belonging to a
  // session an administrator revoked — and this layer cannot tell. Redirecting
  // on presence alone produced /login → /dashboard → /login forever. The login
  // page itself resolves the session and redirects only when it is genuinely
  // valid.
  return NextResponse.next();
}

export const config = {
  // Skip API routes (they authorize themselves and must return JSON, not a
  // redirect), Next internals and static files.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
