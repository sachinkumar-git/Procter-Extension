import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 20 });
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await pool.query(sql, params);
      return { rows: result.rows as T[] };
    },
    async exec(sql) {
      await pool.query(sql);
    },
    close: () => pool.end(),
  };
}

export async function migrate(db: Db): Promise<void> {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const { rows } = await db.query<{ name: string }>(
    "SELECT name FROM schema_migrations",
  );
  const applied = new Set(rows.map((row) => row.name));
  const directory = new URL("../migrations/", import.meta.url);
  const files = (await readdir(directory)).filter((f) => f.endsWith(".sql"));

  for (const file of files.sort()) {
    if (!applied.has(file)) {
      await db.exec(await readFile(new URL(file, directory), "utf8"));
      await db.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
        file,
      ]);
    }
  }
}
