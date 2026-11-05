import { rpc } from "@stellar/stellar-sdk";
import type { Keypair, Transaction } from "@stellar/stellar-sdk";
import type { Pool } from "pg";
import type { VaultClient } from "../packages/sdk-ts/src/client.ts";
import type { Receipt, VaultScope } from "../packages/sdk-ts/src/types.ts";
import { scopeKey } from "./database.ts";
import { signAsSource, submit } from "./submit.ts";

interface Settlement {
  kind: "Anchor" | "ExternalW";
  customerId: bigint;
  amount: bigint;
  reference: string;
}

function confirmReceipt(receipt: Receipt, intent: Settlement) {
  if (receipt.kind[0] !== intent.kind || receipt.customer_id !== intent.customerId || receipt.amount !== intent.amount) {
    throw new Error("Reference is bound to a different onchain settlement");
  }
}

export async function settle(
  pool: Pool,
  client: VaultClient,
  scope: VaultScope,
  signer: Keypair,
  intent: Settlement,
  prepare: () => Promise<Transaction>,
) {
  const key = [...scopeKey(scope), intent.reference];
  const source = signer.publicKey();
  let receipt = await client.receipt(source, intent.reference);
  let txHash: string | null = null;
  if (!receipt) {
    try {
      const transaction = await prepare();
      signAsSource(transaction, signer);
      const hash = Buffer.from(transaction.hash()).toString("hex");
      await pool.query(
        `INSERT INTO settlement_attempt (network_id, vault, reference, tx_hash)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [...key, hash],
      );
      txHash = (await submit(client.rpc, transaction)).hash;
    } catch (error) {
      // A concurrent retry or a lost submission response can still leave a valid receipt.
      receipt = await client.receipt(source, intent.reference);
      if (!receipt) throw error;
    }
    receipt ??= await client.receipt(source, intent.reference);
  }
  if (!receipt) throw new Error("Transaction has no visible onchain settlement receipt");
  confirmReceipt(receipt, intent);
  if (!txHash) {
    const attempts = await pool.query<{ tx_hash: string }>(
      `SELECT tx_hash FROM settlement_attempt WHERE network_id=$1 AND vault=$2 AND reference=$3
       ORDER BY created_at DESC LIMIT 20`,
      key,
    );
    for (const attempt of attempts.rows) {
      const transaction = await client.rpc.getTransaction(attempt.tx_hash);
      if (transaction.status === rpc.Api.GetTransactionStatus.SUCCESS && transaction.ledger === receipt.ledger) {
        txHash = attempt.tx_hash;
        break;
      }
    }
  }
  return { reference: intent.reference, ledger: receipt.ledger, txHash };
}
