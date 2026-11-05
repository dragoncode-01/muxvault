import { Networks, StrKey } from "@stellar/stellar-sdk";
import { VaultClient } from "../packages/sdk-ts/src/client.ts";
import type { VaultScope } from "../packages/sdk-ts/src/types.ts";

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

export function readAccount(): string {
  const account = requiredEnv("READ_ACCOUNT");
  if (!StrKey.isValidEd25519PublicKey(account)) throw new Error("READ_ACCOUNT must be a funded G-address");
  return account;
}

export function settings() {
  const rpcUrl = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
  const passphrase = process.env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET;
  if (passphrase !== Networks.TESTNET && passphrase !== "Standalone Network ; February 2017") {
    throw new Error("Reference tools require Stellar Testnet or the local standalone network");
  }
  const client = new VaultClient(rpcUrl, passphrase, requiredEnv("VAULT_ID"));
  return { rpcUrl, client };
}

export async function vaultScope(client: VaultClient, source: string, minimumProtocol = 29): Promise<VaultScope> {
  await client.verifyNetwork(minimumProtocol);
  const config = await client.config(source);
  if (config.schema_version !== 1) throw new Error("Unsupported vault schema version");
  return { passphrase: client.passphrase, vault: client.vault, asset: config.asset };
}
