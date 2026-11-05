import { Keypair, Networks, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import type { VaultClient } from "../../packages/sdk-ts/src/client.ts";
import { assertSourceAuthorization, transactionHash } from "../../packages/sdk-ts/src/transactions.ts";

export interface Wallet {
  address: string;
  kind: "demo" | "freighter";
  sign(transaction: Transaction): Promise<Transaction>;
}

export function createDemoWallet(): Wallet {
  const keypair = Keypair.random();
  const address = keypair.publicKey();
  return {
    address,
    kind: "demo",
    async sign(transaction) {
      assertSourceAuthorization(transaction, address);
      transaction.sign(keypair);
      return transaction;
    },
  };
}

async function requireFreighterTestnet(api: typeof import("@stellar/freighter-api")) {
  const network = await api.getNetworkDetails();
  if (network.error) throw new Error("Could not read Freighter's network. Open the extension and try again.");
  if (network.networkPassphrase !== Networks.TESTNET) {
    throw new Error("Switch Freighter to Stellar Testnet and try again.");
  }
}

export async function connectFreighter(): Promise<Wallet> {
  const api = await import("@stellar/freighter-api");
  const connection = await api.isConnected();
  if (!connection.isConnected) throw new Error("Install the Freighter browser extension or use a demo wallet.");
  await requireFreighterTestnet(api);
  const access = await api.requestAccess();
  if (access.error || !access.address) throw new Error("Wallet access was declined. Reconnect to try again.");
  const address = access.address;
  return {
    address,
    kind: "freighter",
    async sign(transaction) {
      assertSourceAuthorization(transaction, address);
      await requireFreighterTestnet(api);
      const active = await api.getAddress();
      if (active.error || active.address !== address) {
        throw new Error("Freighter changed accounts. Disconnect and reconnect to the wallet you want to use.");
      }
      const expected = transactionHash(transaction);
      const signed = await api.signTransaction(transaction.toXDR(), { address, networkPassphrase: Networks.TESTNET });
      if (signed.error || !signed.signedTxXdr) throw new Error("Freighter did not sign the transaction.");
      const parsed = TransactionBuilder.fromXDR(signed.signedTxXdr, Networks.TESTNET);
      if (!(parsed instanceof Transaction) || transactionHash(parsed) !== expected || parsed.signatures.length === 0) {
        throw new Error("Freighter returned an unexpected transaction.");
      }
      return parsed;
    },
  };
}

export async function isFunded(client: VaultClient, address: string): Promise<boolean> {
  try {
    await client.rpc.getAccount(address);
    return true;
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) return false;
    throw error;
  }
}

export async function fundTestnetWallet(client: VaultClient, address: string) {
  await client.verifyNetwork(30);
  if (await isFunded(client, address)) return;
  const faucet = new URL("https://friendbot.stellar.org");
  faucet.searchParams.set("addr", address);
  const response = await fetch(faucet, { signal: AbortSignal.timeout(25_000) });
  if (!response.ok && !await isFunded(client, address)) {
    throw new Error("Friendbot could not fund this wallet. Try again in a moment.");
  }
  for (let attempt = 0; attempt < 7; attempt++) {
    if (await isFunded(client, address)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error("Funding is waiting for a ledger. Use Refresh to check again.");
}
