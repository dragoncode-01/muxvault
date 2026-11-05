import pg from "pg";
import type { Pool, PoolClient } from "pg";
import { networkId } from "../packages/sdk-ts/src/references.ts";
import type { VaultScope } from "../packages/sdk-ts/src/types.ts";

export function openDatabase(): Pool {
  if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL");
  return new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000 });
}

export function scopeKey(scope: VaultScope): [string, string] {
  return [networkId(scope.passphrase), scope.vault];
}

export async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
