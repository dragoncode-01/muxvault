import { rpc, scValToNative } from "@stellar/stellar-sdk";
import type { Transaction } from "@stellar/stellar-sdk";

export function assertSourceAuthorization(transaction: Transaction, address: string) {
  if (transaction.source !== address) throw new Error("Signer differs from the transaction source");
  for (const operation of transaction.operations) {
    if (operation.type === "invokeHostFunction" && operation.auth?.some(
      ({ credentials }) => credentials.type !== "sorobanCredentialsSourceAccount",
    )) {
      throw new Error("Additional Soroban authorization is required before submission");
    }
  }
}

export function transactionHash(transaction: Transaction): string {
  return Array.from(transaction.hash(), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class RejectedTransaction extends Error {}

export function transactionResult(result: rpc.Api.GetSuccessfulTransactionResponse, hash: string) {
  return {
    hash,
    ledger: result.ledger,
    value: result.returnValue ? scValToNative(result.returnValue) : null,
  };
}

export async function submit(server: rpc.Server, transaction: Transaction) {
  const hash = transactionHash(transaction);
  const sent = await server.sendTransaction(transaction);
  if (sent.hash !== hash) throw new Error(`Unexpected submission hash for ${hash}`);
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    throw new RejectedTransaction(`Stellar submission ${sent.status} for ${hash}`);
  }
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await server.getTransaction(hash);
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) return transactionResult(result, hash);
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new RejectedTransaction(`Stellar transaction failed. ${hash}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Stellar confirmation timed out. Check transaction ${hash} before retrying.`);
}
