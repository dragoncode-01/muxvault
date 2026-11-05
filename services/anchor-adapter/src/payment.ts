import { parseAssetUnits, parseU64 } from "../../../packages/sdk-ts/src/amount.ts";
import { anchorReference, networkId } from "../../../packages/sdk-ts/src/references.ts";
import type { VaultScope } from "../../../packages/sdk-ts/src/types.ts";

export interface Payment {
  namespace: string;
  id: string;
  customerId: bigint;
  amount: bigint;
  reference: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid anchor response");
  return value as Record<string, unknown>;
}

export function parsePayment(
  response: unknown,
  scope: VaultScope,
  assetDescriptor: string,
  namespace: string,
  requestedId: string,
): Payment {
  const transaction = object(object(response).transaction);
  if (transaction.id !== requestedId || transaction.kind !== "deposit") {
    throw new Error("Anchor returned a different transaction or a non-deposit");
  }
  if (transaction.status !== "pending_anchor" || transaction.stellar_transaction_id != null) {
    throw new Error("Anchor transaction is ineligible for a new Stellar payout");
  }
  const ready = object(transaction.muxvault);
  if (ready.fiat_ready !== true || ready.vault !== scope.vault || ready.network_id !== networkId(scope.passphrase)) {
    throw new Error("Missing verified fiat readiness for this vault and network");
  }
  if (transaction.amount_out_asset !== `stellar:${assetDescriptor}` || typeof transaction.amount_out !== "string"
    || typeof ready.customer_id !== "string") {
    throw new Error("Invalid payout asset, amount or customer ID");
  }
  const customerId = parseU64(ready.customer_id);
  if (customerId === 0n) throw new Error("Customer ID 0 is reserved");
  return {
    namespace,
    id: requestedId,
    customerId,
    amount: parseAssetUnits(transaction.amount_out),
    reference: anchorReference(scope, namespace, requestedId),
  };
}
