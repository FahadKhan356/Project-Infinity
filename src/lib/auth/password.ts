import 'server-only';
import { hash, verify } from '@node-rs/argon2';

/**
 * OWASP-recommended argon2id parameters (19 MiB, 2 iterations, 1 lane).
 * Raising these later is safe: existing hashes carry their own parameters,
 * so old passwords keep verifying and re-hash on next login.
 */
// @node-rs/argon2 declares Algorithm as a `const enum`, which cannot be
// imported under isolatedModules. Argon2id is 2 (see node_modules/@node-rs/argon2/index.d.ts).
const ARGON2ID = 2;

const OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const MIN_PASSWORD_LENGTH = 12;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(digest: string, password: string): Promise<boolean> {
  try {
    return await verify(digest, password, OPTIONS);
  } catch {
    // Malformed or unreadable hash: treat as a failed login, never as success.
    return false;
  }
}

/** Returns a human-readable reason, or null when the password is acceptable. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must contain both letters and numbers.';
  }
  return null;
}
