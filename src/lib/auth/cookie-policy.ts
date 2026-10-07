/**
 * Whether the session cookie carries the Secure flag.
 *
 * Browsers drop a Secure cookie that arrives over plain HTTP from anywhere
 * but localhost. Tying the flag to NODE_ENV therefore broke every colleague
 * who opened a production build (`npm start`) at http://<server-ip>:3000:
 * sign-in "worked" and landed straight back on /login. So the flag follows
 * the connection the browser actually used.
 *
 * SESSION_COOKIE_SECURE=true|false decides outright; the Docker deployment
 * pins it to true, since Caddy serves only HTTPS. Left blank, the first
 * X-Forwarded-Proto value decides. Next fills that header itself on a plain
 * `next start`, and Caddy overwrites whatever a client sent. A client that
 * forges "https" over plain HTTP only loses its own cookie.
 *
 * Pure (no next/headers), so the rule is tested without a request.
 */
export function sessionCookieSecure(
  forwardedProto: string | null,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const override = env.SESSION_COOKIE_SECURE?.trim().toLowerCase();
  if (override === 'true') return true;
  if (override === 'false') return false;
  return forwardedProto?.split(',')[0]?.trim().toLowerCase() === 'https';
}
