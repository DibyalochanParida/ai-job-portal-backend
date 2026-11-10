import pg from "pg";
import { mkdir } from "node:fs/promises";
import { config } from "../config.js";

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  kind: "postgres" | "pglite";
  /** Run a multi-statement SQL script without parameters. */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// int8 (count(*), bigint) -> number. Values used here stay well under 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
// numeric -> number
pg.types.setTypeParser(1700, (v) => Number(v));

function createPostgresDb(url: string): Db {
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  });
  const wrap = (client: pg.Pool | pg.PoolClient): Queryable => ({
    async query<T>(text: string, params?: unknown[]) {
      const res = await client.query(text, params as unknown[]);
      return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
    },
  });
  return {
    kind: "postgres",
    ...wrap(pool),
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(wrap(client));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function createPgliteDb(url: string): Promise<Db> {
  // Loaded lazily: PGlite is a dev/test dependency and is not installed in production images.
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite-pgvector");
  const location = url.replace(/^pglite:\/\//, "");
  const dataDir = location === "memory" || location === "" ? undefined : location;
  if (dataDir) await mkdir(dataDir, { recursive: true });
  const lite = await PGlite.create({ dataDir, extensions: { vector } });

  type LiteLike = { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }> };
  const wrap = (client: LiteLike): Queryable => ({
    async query<T>(text: string, params?: unknown[]) {
      const res = await client.query(text, params);
      return { rows: res.rows as T[], rowCount: res.affectedRows ?? res.rows.length };
    },
  });
  return {
    kind: "pglite",
    ...wrap(lite),
    async exec(sql) {
      await lite.exec(sql);
    },
    transaction: (fn) => lite.transaction((tx) => fn(wrap(tx))),
    close: () => lite.close(),
  };
}

let current: Db | null = null;

export async function connectDb(url: string = config.databaseUrl): Promise<Db> {
  if (current) return current;
  current = url.startsWith("pglite:") ? await createPgliteDb(url) : createPostgresDb(url);
  await current.query("SELECT 1");
  return current;
}

export function getDb(): Db {
  if (!current) throw new Error("Database not connected. Call connectDb() first.");
  return current;
}

export async function closeDb(): Promise<void> {
  if (current) {
    const db = current;
    current = null;
    await db.close();
  }
}

/** Shorthand for getDb().query(...) */
export function query<T = Record<string, unknown>>(text: string, params?: unknown[]) {
  return getDb().query<T>(text, params);
}

/** Serialise a number[] for a `$n::vector` parameter. */
export function toVector(values: number[] | null | undefined): string | null {
  if (!values || values.length === 0) return null;
  return `[${values.map((v) => (Number.isFinite(v) ? Number(v.toFixed(6)) : 0)).join(",")}]`;
}

/** Small helper for building parameterised WHERE clauses. */
export class SqlParams {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}
