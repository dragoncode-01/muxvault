import type { Keypair } from "@stellar/stellar-sdk";
import type { Pool } from "pg";
import { assetInfo } from "../../../packages/sdk-ts/src/asset.ts";
import type { VaultClient } from "../../../packages/sdk-ts/src/client.ts";
import { anchorReference } from "../../../packages/sdk-ts/src/references.ts";
import type { VaultScope } from "../../../packages/sdk-ts/src/types.ts";
import { scopeKey } from "../../database.ts";
import { settle } from "../../settlement.ts";
import { requiredEnv } from "../../settings.ts";
import { parsePayment } from "./payment.ts";

async function readMockStatus(id: string) {
  const url = new URL(process.env.ANCHOR_MOCK_URL ?? "http://127.0.0.1:4242");
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("The reference anchor mock must be on loopback HTTP");
  }
  url.pathname = "/transaction";
  url.search = "";
  url.searchParams.set("id", id);
  const result = await fetch(url, {
    headers: { authorization: `Bearer ${requiredEnv("ANCHOR_MOCK_TOKEN")}` },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!result.ok) throw new Error(`Anchor status endpoint returned ${result.status}`);
  return result.json() as Promise<unknown>;
}

export async function creditAnchorPayment(
  pool: Pool,
  client: VaultClient,
  scope: VaultScope,
  signer: Keypair,
  id: string,
) {
  const asset = requiredEnv("ASSET");
  if (assetInfo(asset, scope.passphrase).address !== scope.asset) {
    throw new Error("Configured anchor asset is different from the onchain vault SAC");
  }
  const namespace = process.env.ANCHOR_NAMESPACE ?? "muxvault-mock";
  anchorReference(scope, namespace, id);
  const payment = parsePayment(await readMockStatus(id), scope, asset, namespace, id);
  const key = [...scopeKey(scope), namespace, id];
  const write = await pool.query(
    `INSERT INTO anchor_payment (network_id, vault, namespace, payment_id, asset, customer_id, amount, reference)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (network_id, vault, namespace, payment_id) DO UPDATE SET payment_id=EXCLUDED.payment_id
     WHERE (anchor_payment.asset, anchor_payment.customer_id, anchor_payment.amount, anchor_payment.reference)
         = (EXCLUDED.asset, EXCLUDED.customer_id, EXCLUDED.amount, EXCLUDED.reference)`,
    [...key, scope.asset, payment.customerId.toString(), payment.amount.toString(), payment.reference],
  );
  if (write.rowCount !== 1) throw new Error("Anchor payment ID was already bound to different payout details");

  const source = signer.publicKey();
  const result = await settle(pool, client, scope, signer, { kind: "Anchor", ...payment }, async () => {
    const config = await client.config(source);
    if (config.settlement_signer !== source) throw new Error("Signer is different from the onchain funding signer");
    return client.anchorDeposit(source, payment.customerId, payment.amount, payment.reference);
  });
  await pool.query(
    `UPDATE anchor_payment SET settlement_ledger=$5, settlement_tx_hash=COALESCE(settlement_tx_hash,$6)
     WHERE network_id=$1 AND vault=$2 AND namespace=$3 AND payment_id=$4`,
    [...key, result.ledger, result.txHash],
  );
  return result;
}
