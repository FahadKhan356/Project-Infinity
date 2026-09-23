/**
 * Migration runner.
 *
 * Applies every drizzle/*.sql file in filename order, once, each inside a
 * transaction. Postgres DDL is transactional, so a failed migration leaves
 * the database untouched.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';

const MIGRATIONS_DIR = path.join(process.cwd(), 'drizzle');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const sql = postgres(url, { max: 1, onnotice: () => {} });

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS _migrations (
        name        text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `;

    const applied = new Set(
      (await sql<{ name: string }[]>`SELECT name FROM _migrations`).map((r) => r.name),
    );

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  skip   ${file}`);
        continue;
      }
      const body = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      process.stdout.write(`  apply  ${file} ... `);
      await sql.begin(async (tx) => {
        await tx.unsafe(body).simple();
        await tx`INSERT INTO _migrations (name) VALUES (${file})`;
      });
      console.log('ok');
      count++;
    }

    console.log(count === 0 ? 'Database already up to date.' : `Applied ${count} migration(s).`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('\nMigration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
