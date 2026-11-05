import { Address, xdr } from "@stellar/stellar-sdk";
import type { Pool, PoolClient } from "pg";
import type { VaultClient } from "../../../packages/sdk-ts/src/client.ts";
import type { VaultScope } from "../../../packages/sdk-ts/src/types.ts";
import { inTransaction, scopeKey } from "../../database.ts";
import { finishPage, PAGE_SIZE, planWindow } from "./checkpoint.ts";
import type { Checkpoint } from "./checkpoint.ts";
import { decodeWTransfer } from "./events.ts";
import type { RawEvent, WTransfer } from "./events.ts";

type EventPage = { events: RawEvent[]; cursor: string };

export class EventRpc {
  readonly url: string;
  readonly scope: VaultScope;

  constructor(url: string, scope: VaultScope) {
    this.url = url;
    this.scope = scope;
  }

  async read(checkpoint: Checkpoint, end: number): Promise<EventPage> {
    const transfer = xdr.ScVal.scvSymbol("transfer").toXDR("base64");
    const destination = Address.fromString(this.scope.vault).toScVal().toXDR("base64");
    const topic = [transfer, "*", destination];
    const params = {
      filters: [{ type: "contract", contractIds: [this.scope.asset], topics: [topic, [...topic, "*"]] }],
      ...(checkpoint.cursor ? {
        pagination: { limit: PAGE_SIZE, cursor: checkpoint.cursor },
      } : {
        startLedger: checkpoint.nextLedger,
        endLedger: end,
        pagination: { limit: PAGE_SIZE },
      }),
    };
    const response = await fetch(this.url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "muxvault", method: "getEvents", params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`getEvents HTTP ${response.status}`);
    const data = await response.json() as { id?: string; error?: { message: string }; result?: EventPage };
    if (data.id !== "muxvault" || data.error || !Array.isArray(data.result?.events)) {
      throw new Error(`getEvents failed. ${data.error?.message ?? "Invalid RPC response"}`);
    }
    return data.result;
  }
}

async function insertTransfer(db: PoolClient, scope: VaultScope, event: WTransfer) {
  const result = await db.query(
    `INSERT INTO w_transfer (
       network_id, vault, asset, event_id, tx_hash, operation_index, event_index, ledger,
       sender, customer_id, amount, reference, evidence
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (network_id, vault, event_id) DO UPDATE SET event_id = EXCLUDED.event_id
     WHERE (w_transfer.asset, w_transfer.tx_hash, w_transfer.operation_index, w_transfer.event_index,
            w_transfer.ledger, w_transfer.sender, w_transfer.customer_id, w_transfer.amount, w_transfer.reference)
         = (EXCLUDED.asset, EXCLUDED.tx_hash, EXCLUDED.operation_index, EXCLUDED.event_index,
            EXCLUDED.ledger, EXCLUDED.sender, EXCLUDED.customer_id, EXCLUDED.amount, EXCLUDED.reference)`,
    [...scopeKey(scope), scope.asset, event.eventId, event.txHash, event.operationIndex, event.eventIndex,
      event.ledger, event.sender, event.customerId, event.amount, event.reference, JSON.stringify(event.evidence)],
  );
  if (result.rowCount !== 1) throw new Error(`Conflicting evidence for event ${event.eventId}`);
}

export async function scanPage(
  pool: Pool,
  client: VaultClient,
  events: EventRpc,
  startLedger: number,
) {
  const scope = events.scope;
  const key = scopeKey(scope);
  return inTransaction(pool, async (db) => {
    await db.query(
      `INSERT INTO watcher_checkpoint (network_id, vault, asset, next_ledger) VALUES ($1,$2,$3,$4)
       ON CONFLICT (network_id, vault) DO NOTHING`,
      [...key, scope.asset, startLedger],
    );
    const { rows: [row] } = await db.query<{
      asset: string; next_ledger: string; window_end: string | null; cursor: string | null;
    }>(
      `SELECT asset, next_ledger, window_end, cursor FROM watcher_checkpoint
       WHERE network_id=$1 AND vault=$2 FOR UPDATE`,
      key,
    );
    if (row.asset !== scope.asset) throw new Error("Watcher asset differs from its checkpoint");
    const checkpoint = {
      nextLedger: Number(row.next_ledger),
      windowEnd: row.window_end === null ? null : Number(row.window_end),
      cursor: row.cursor,
    };
    const { oldestLedger, latestLedger } = await client.rpc.getHealth();
    const end = planWindow(checkpoint, oldestLedger, latestLedger);
    if (end === null) return null;

    const page = await events.read(checkpoint, end);
    const { within, next } = finishPage(checkpoint, end, page.events, page.cursor);
    let transfers = 0;
    for (const raw of within) {
      const transfer = decodeWTransfer(raw, scope);
      if (!transfer) continue;
      await insertTransfer(db, scope, transfer);
      transfers++;
    }
    await db.query(
      `UPDATE watcher_checkpoint SET next_ledger=$3, window_end=$4, cursor=$5
       WHERE network_id=$1 AND vault=$2`,
      [...key, next.nextLedger, next.windowEnd, next.cursor],
    );
    return { latestLedger, nextLedger: next.nextLedger, transfers };
  });
}

export async function verifyQueuedTransfer(events: EventRpc, ledger: number, eventId: string) {
  const end = ledger + 1;
  let checkpoint: Checkpoint = { nextLedger: ledger, windowEnd: null, cursor: null };
  while (checkpoint.nextLedger === ledger) {
    const page = await events.read(checkpoint, end);
    const { within, next } = finishPage(checkpoint, end, page.events, page.cursor);
    const raw = within.find((event) => event.id === eventId);
    if (raw) return decodeWTransfer(raw, events.scope);
    checkpoint = next;
  }
  return null;
}
