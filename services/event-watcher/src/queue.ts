import type { Keypair } from "@stellar/stellar-sdk";
import type { Pool } from "pg";
import { parseAmount, parseLedger, parseU64 } from "../../../packages/sdk-ts/src/amount.ts";
import type { VaultClient } from "../../../packages/sdk-ts/src/client.ts";
import { scopeKey } from "../../database.ts";
import { settle } from "../../settlement.ts";
import { verifyQueuedTransfer } from "./watcher.ts";
import type { EventRpc } from "./watcher.ts";

interface QueueRow {
  asset: string;
  event_id: string;
  customer_id: string;
  amount: string;
  ledger: string;
  reference: string;
  tx_hash: string;
  settlement_ledger: string | null;
  settlement_tx_hash: string | null;
}

export async function listQueue(
  pool: Pool, client: VaultClient, events: EventRpc, source: string, after: string | null,
) {
  if (after !== null && !/^\d{19}-\d{10}$/.test(after)) throw new Error("Invalid queue event ID");
  const { rows } = await pool.query<QueueRow>(
    `SELECT asset, event_id, customer_id, amount, ledger, reference, tx_hash, settlement_ledger, settlement_tx_hash
     FROM w_transfer WHERE network_id=$1 AND vault=$2 AND settlement_ledger IS NULL
       AND ($3::text IS NULL OR event_id > $3)
     ORDER BY event_id LIMIT 50`,
    [...scopeKey(events.scope), after],
  );
  const customers = new Map<string, Awaited<ReturnType<VaultClient["subaccount"]>>>();
  const items = [];
  for (const row of rows) {
    if (!customers.has(row.customer_id)) {
      customers.set(row.customer_id, await client.subaccount(source, parseU64(row.customer_id)));
    }
    const account = customers.get(row.customer_id);
    let review = "ready_for_review";
    if (!account) review = "unknown_customer";
    else if (!account.active) review = "inactive_customer";
    else if (account.created_ledger >= Number(row.ledger)) review = "registration_too_late";
    items.push({ ...row, review });
  }
  return { items, nextAfter: rows.length === 50 ? rows.at(-1)?.event_id : null };
}

export async function creditQueuedTransfer(pool: Pool, client: VaultClient, events: EventRpc, signer: Keypair, eventId: string) {
  const key = [...scopeKey(events.scope), eventId];
  const { rows: [row] } = await pool.query<QueueRow>(
    `SELECT asset, event_id, customer_id, amount, ledger, reference, tx_hash, settlement_ledger, settlement_tx_hash
     FROM w_transfer WHERE network_id=$1 AND vault=$2 AND event_id=$3`,
    key,
  );
  if (!row || row.asset !== events.scope.asset) throw new Error("No matching W-transfer in the reconciliation queue");
  const source = signer.publicKey();
  const customerId = parseU64(row.customer_id);
  const amount = parseAmount(row.amount);
  const ledger = parseLedger(row.ledger);
  const result = await settle(
    pool, client, events.scope, signer, { kind: "ExternalW", customerId, amount, reference: row.reference },
    async () => {
      const config = await client.config(source);
      if (config.w_settlement_signer !== source) throw new Error("Signer is different from the onchain W settlement signer");
      const account = await client.subaccount(source, customerId);
      if (!account?.active || account.created_ledger >= ledger) {
        throw new Error("Customer must be active and registered before the transfer ledger");
      }
      const observed = await verifyQueuedTransfer(events, ledger, eventId);
      if (!observed || observed.reference !== row.reference || observed.customerId !== row.customer_id
        || observed.amount !== row.amount || observed.txHash !== row.tx_hash) {
        throw new Error("Queued transfer differs from retained Stellar RPC evidence");
      }
      return client.settleW(source, customerId, amount, ledger, row.reference);
    },
  );
  await pool.query(
    `UPDATE w_transfer SET settlement_ledger=$4, settlement_tx_hash=COALESCE(settlement_tx_hash,$5)
     WHERE network_id=$1 AND vault=$2 AND event_id=$3`,
    [...key, result.ledger, result.txHash],
  );
  return result;
}
