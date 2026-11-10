import { pathToFileURL } from "node:url";
import { closeDb, connectDb, type Db } from "./index.js";
import { migrations } from "./migrations.js";
import { logger } from "../logger.js";

// Arbitrary constant key so concurrent app instances don't run migrations at the same time.
const MIGRATION_LOCK_KEY = 74_210_391;

export async function runMigrations(db: Db): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const applied: string[] = [];
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    const { rows } = await tx.query<{ id: string }>("SELECT id FROM schema_migrations");
    const done = new Set(rows.map((r) => r.id));
    for (const m of migrations) {
      if (done.has(m.id)) continue;
      // Statements run one by one so both node-postgres and PGlite accept them inside a transaction.
      for (const statement of splitSql(m.sql)) {
        await tx.query(statement);
      }
      await tx.query("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]);
      applied.push(m.id);
    }
  });
  return applied;
}

/** Splits a migration on top-level semicolons (our migrations contain no functions or string literals with ';'). */
function splitSql(sql: string): string[] {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const db = await connectDb();
  try {
    const applied = await runMigrations(db);
    logger.info({ applied }, applied.length ? "Migrations applied" : "Database already up to date");
  } finally {
    await closeDb();
  }
}
