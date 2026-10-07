/**
 * Seeds the first administrator. Departments are seeded by migration 0001.
 * Idempotent: re-running leaves an existing admin untouched.
 */
import { hash } from '@node-rs/argon2';
import postgres from 'postgres';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set to seed the first administrator');
  }
  if (password.length < 12) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters');
  }

  const sql = postgres(url, { max: 1 });

  try {
    const existing = await sql`SELECT id FROM users WHERE lower(email) = lower(${email})`;
    if (existing.length > 0) {
      console.log(`Administrator ${email} already exists — nothing to do.`);
      return;
    }

    const passwordHash = await hash(password);
    const [user] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, full_name, role, must_change_password)
      VALUES (${email}, ${passwordHash}, ${process.env.ADMIN_NAME ?? 'Administrator'}, 'admin', true)
      RETURNING id
    `;

    await sql`
      INSERT INTO activity_log (actor_id, action, entity_type, entity_id, metadata)
      VALUES (${user.id}, 'user.seeded', 'user', ${user.id}, ${sql.json({ via: 'seed script' })})
    `;

    const depts = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM departments`;
    console.log(`Seeded administrator ${email} (id ${user.id}).`);
    console.log(`Departments present: ${depts[0].count}.`);
    console.log('They must change this password at first login.');
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
