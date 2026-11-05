import type { Keypair, Transaction } from "@stellar/stellar-sdk";
import { assertSourceAuthorization } from "../packages/sdk-ts/src/transactions.ts";

export { submit } from "../packages/sdk-ts/src/transactions.ts";

export function signAsSource(transaction: Transaction, signer: Keypair) {
  assertSourceAuthorization(transaction, signer.publicKey());
  transaction.sign(signer);
}
