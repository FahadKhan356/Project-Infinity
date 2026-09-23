import 'server-only';

/**
 * In-memory login throttle. Adequate for a single application container on one
 * internal server, which is the deployment this system targets (brief §40).
 * It resets on restart and is not shared across replicas — if the portal is
 * ever scaled out, move this to the database or Redis.
 */
interface Attempt {
  count: number;
  firstAt: number;
  blockedUntil: number;
}

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const BLOCK_MS = 15 * 60 * 1000;

const attempts = new Map<string, Attempt>();

export function loginBlockedFor(key: string): number {
  const entry = attempts.get(key);
  if (!entry) return 0;
  const remaining = entry.blockedUntil - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

export function recordFailedLogin(key: string): void {
  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry || now - entry.firstAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: now, blockedUntil: 0 });
    return;
  }

  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.blockedUntil = now + BLOCK_MS;
    entry.count = 0;
    entry.firstAt = now;
  }
}

export function clearFailedLogins(key: string): void {
  attempts.delete(key);
}

/** Test seam. */
export function resetRateLimiter(): void {
  attempts.clear();
}
