import type { Config } from "drizzle-kit";

/**
 * drizzle-kit is used for introspection and `studio` only. Migrations are
 * hand-written SQL in drizzle/ and applied by scripts/migrate.ts, because
 * the SQL file is the source of truth for the model.
 */
export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  casing: "snake_case",
} satisfies Config;
