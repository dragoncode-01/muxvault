import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Address, BASE_FEE, Keypair, Networks, Operation, TransactionBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { assetInfo, stellarAsset } from "../packages/sdk-ts/src/asset.ts";
import { VaultClient } from "../packages/sdk-ts/src/client.ts";
import { authorizationAddress, requireContract } from "../packages/sdk-ts/src/w-address.ts";
import { requiredEnv } from "../services/settings.ts";
import { submit } from "../services/submit.ts";

async function main() {
  const rpcUrl = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
  if (new URL(rpcUrl).protocol !== "https:") throw new Error("Testnet RPC must use HTTPS");
  const server = new rpc.Server(rpcUrl, { timeout: 20_000 });
  const network = await server.getNetwork();
  const protocol = Number(network.protocolVersion);
  if (network.passphrase !== Networks.TESTNET || !Number.isInteger(protocol) || protocol < 29) {
    throw new Error("Deployment requires Stellar Testnet with Protocol 29 or newer");
  }

  const signer = Keypair.fromSecret(requiredEnv("DEPLOYER_SEED"));
  const source = signer.publicKey();
  const admin = authorizationAddress(process.env.ADMIN_ADDRESS ?? source);
  const funding = authorizationAddress(requiredEnv("FUNDING_ADDRESS"));
  const guardian = authorizationAddress(requiredEnv("GUARDIAN_ADDRESS"));
  if (new Set([admin, funding, guardian].map((address) => address.toString())).size !== 3) {
    throw new Error("Use distinct admin, funding and guardian addresses");
  }
  const descriptor = requiredEnv("ASSET");
  const asset = stellarAsset(descriptor);
  const info = assetInfo(descriptor, Networks.TESTNET);
  const wasmPath = process.argv[2] ?? "target/wasm32v1-none/release/muxvault.wasm";
  const wasm = await readFile(wasmPath);
  const wasmHash = createHash("sha256").update(wasm).digest();

  const send = async (operation: ReturnType<typeof Operation.uploadContractWasm>) => {
    const account = await server.getAccount(source);
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(operation)
      .setTimeout(120)
      .build();
    const prepared = await server.prepareTransaction(tx);
    prepared.sign(signer);
    return submit(server, prepared);
  };

  const instanceKey = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
    contract: Address.fromString(info.address).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent,
  }));
  const { entries } = await server.getLedgerEntries(instanceKey);
  if (entries.length === 0) {
    const deployedAsset = await send(Operation.createStellarAssetContract({ asset }));
    console.log(`SAC deployment ${deployedAsset.hash}`);
  }

  const uploaded = await send(Operation.uploadContractWasm({ wasm }));
  console.log(`WASM upload ${uploaded.hash}`);
  const deployed = await send(Operation.createCustomContract({
    address: Address.fromString(source),
    wasmHash,
    constructorArgs: [
      admin.toScVal(), xdr.ScVal.scvBytes(Buffer.from(info.xdrHex, "hex")), funding.toScVal(), guardian.toScVal(),
    ],
  }));
  if (typeof deployed.value !== "string") throw new Error(`Deployment returned no contract address. ${deployed.hash}`);
  const vault = requireContract(deployed.value);
  const client = new VaultClient(rpcUrl, Networks.TESTNET, vault);
  const config = await client.config(source);
  if (config.asset !== info.address || config.admin !== admin.toString()
    || config.settlement_signer !== funding.toString() || config.guardian !== guardian.toString()
    || config.w_settlement_signer !== null || config.schema_version !== 1) {
    throw new Error(`Deployed config did not match deployment inputs. ${deployed.hash}`);
  }

  let commit: string | null = null;
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    // A source archive has no Git commit.
  }
  const manifest = {
    vault, asset: info.address, stellarAsset: descriptor, networkPassphrase: Networks.TESTNET,
    protocol, deploymentLedger: deployed.ledger, deploymentTx: deployed.hash,
    wasmHash: wasmHash.toString("hex"), wasmUploadTx: uploaded.hash, sourceCommit: commit,
    admin: config.admin, funding: config.settlement_signer, guardian: config.guardian,
  };
  await mkdir("deployments", { recursive: true });
  const filename = `deployments/testnet-${vault}.json`;
  await writeFile(filename, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  console.log(`Manifest ${filename}\nVAULT_ID=${vault}\nWATCH_START_LEDGER=${deployed.ledger}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Testnet deployment failed");
  process.exitCode = 1;
});
