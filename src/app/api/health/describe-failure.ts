/**
 * What /api/health says when the database cannot be reached. Anyone on the
 * network can call that endpoint, so it answers with the failure's code and
 * a fixed sentence for it, never the driver's own text: that names the host,
 * port, role and database ("connect ECONNREFUSED 10.0.0.5:5432", "database
 * \"aktivacity\" does not exist"). The full error goes to the server log.
 */
const EXPLAINED: Record<string, string> = {
  ECONNREFUSED: 'connection refused; is PostgreSQL running at the configured host and port?',
  ENOTFOUND: 'database host not found',
  EAI_AGAIN: 'database host name could not be resolved',
  ETIMEDOUT: 'connection timed out',
  EHOSTUNREACH: 'database host unreachable',
  ECONNRESET: 'connection reset by the database server',
  CONNECT_TIMEOUT: 'connection timed out',
  CONNECTION_CLOSED: 'the database server closed the connection',
  '3D000': 'the database does not exist',
  '28P01': 'password authentication failed',
  '28000': 'the database server refused this role or client',
  '42P01': 'the database has no migrations yet (npm run db:migrate)',
  '57P03': 'the database server is starting up',
  '53300': 'the database server has too many connections',
};

/** src/db's own refusal; it holds nothing but the variable's name. */
const NO_URL = 'DATABASE_URL is not set';

export function describeDbFailure(error: unknown): string {
  // postgres.js reports a refused connection as an AggregateError with an
  // empty message, one attempt per address the host resolved to; the first
  // attempt speaks for it.
  const cause =
    error instanceof AggregateError && error.errors.length > 0 ? error.errors[0] : error;
  const rawCode = (cause as { code?: unknown } | null)?.code;
  const code = typeof rawCode === 'string' ? rawCode : '';
  if (code) return EXPLAINED[code] ? `${EXPLAINED[code]} (${code})` : `database error ${code}`;
  if (cause instanceof Error && cause.message === NO_URL) return NO_URL;
  return 'unexpected error; the server log has the details';
}
