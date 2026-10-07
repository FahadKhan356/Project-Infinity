import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

type Sql = ReturnType<typeof postgres>;
type Db = ReturnType<typeof drizzle<typeof schema>>;

const cache = globalThis as unknown as { __sql?: Sql; __db?: Db };

/**
 * Lazy so that `next build` never needs DATABASE_URL — the connection is
 * opened on first query, not at module load.
 */
export function getDb(): Db {
  if (cache.__db) return cache.__db;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const sql = postgres(url, {
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idle_timeout: 30,
    connect_timeout: 10,
  });
  const db = drizzle(sql, { schema });

  cache.__sql = sql;
  cache.__db = db;
  return db;
}

export function getSql(): Sql {
  getDb();
  return cache.__sql!;
}

export { schema };
