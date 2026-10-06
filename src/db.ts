import { Pool, PoolClient } from "pg";
import { config } from "./config";

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.pgSsl ? { rejectUnauthorized: false } : undefined,
});

export type Row = Record<string, unknown>;

/**
 * Multi-row INSERT ... ON CONFLICT DO UPDATE. All rows must share the same keys.
 * `imported_at` is always refreshed so stale rows (deleted in HubSpot) can be
 * spotted by comparing against the run start time.
 */
export async function upsert(
  client: PoolClient,
  table: string,
  rows: Row[],
  conflictCols: string[],
): Promise<void> {
  if (rows.length === 0) return;
  // ON CONFLICT can't touch the same row twice in one statement: keep the last duplicate.
  const byKey = new Map<string, Row>();
  for (const row of rows) byKey.set(JSON.stringify(conflictCols.map((c) => row[c])), row);
  rows = [...byKey.values()];
  const cols = Object.keys(rows[0]);
  const params: unknown[] = [];
  const tuples = rows.map((row) => {
    const placeholders = cols.map((c) => {
      params.push(row[c] === undefined ? null : row[c]);
      return `$${params.length}`;
    });
    return `(${placeholders.join(", ")})`;
  });
  const updates = cols
    .filter((c) => !conflictCols.includes(c))
    .map((c) => `${c} = EXCLUDED.${c}`)
    .concat("imported_at = now()");

  await client.query(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES ${tuples.join(", ")}
     ON CONFLICT (${conflictCols.join(", ")}) DO UPDATE SET ${updates.join(", ")}`,
    params,
  );
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
