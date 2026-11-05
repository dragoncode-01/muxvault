import { Address, Keypair, Networks, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { parseAmount, parseU64 } from "../packages/sdk-ts/src/amount.ts";
import { assetInfo } from "../packages/sdk-ts/src/asset.ts";
import { authorizationAddress, encodeWAddress, validateDestination } from "../packages/sdk-ts/src/w-address.ts";
import { creditAnchorPayment } from "../services/anchor-adapter/src/adapter.ts";
import { openDatabase } from "../services/database.ts";
import { creditQueuedTransfer, listQueue } from "../services/event-watcher/src/queue.ts";
import { EventRpc } from "../services/event-watcher/src/watcher.ts";
import { readAccount, requiredEnv, settings, vaultScope } from "../services/settings.ts";
import { signAsSource, submit } from "../services/submit.ts";

const commandArgs = {
  "asset-info": ["ASSET"],
  config: [],
  health: [],
  account: ["ID"],
  "w-address": ["ID"],
  queue: ["[AFTER_EVENT_ID]"],
  register: [],
  deposit: ["ID", "BASE_UNITS"],
  withdraw: ["ID", "RECIPIENT", "BASE_UNITS"],
  "anchor-credit": ["PAYMENT_ID"],
  "w-credit": ["EVENT_ID"],
  "send-w": ["W_ADDRESS", "BASE_UNITS"],
  "set-signers": ["FUNDING_ADDRESS", "W_SIGNER_OR_OFF"],
  pause: [],
  resume: [],
  deactivate: ["ID"],
  "keep-alive": ["ID_OR_DASH", "REFERENCE_OR_DASH"],
} as const;

type Command = keyof typeof commandArgs;

function print(value: unknown) {
  console.log(JSON.stringify(value, (_, field) => typeof field === "bigint" ? field.toString() : field, 2));
}

async function main() {
  const [commandName = "help", ...args] = process.argv.slice(2);
  if (commandName === "help" || commandName === "--help") {
    console.log(Object.entries(commandArgs).map(([name, values]) => [name, ...values].join(" ")).join("\n"));
    return;
  }
  if (!Object.hasOwn(commandArgs, commandName)) throw new Error("Unknown command. Run npm run operator -- help");
  const command = commandName as Command;
  const expected = commandArgs[command].length;
  if (args.length !== expected && !(command === "queue" && args.length === 0)) {
    throw new Error(`Usage: ${command} ${commandArgs[command].join(" ")}`);
  }
  const [first, second, third] = args;
  if (command === "asset-info") {
    print(assetInfo(first, process.env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET));
    return;
  }

  const { rpcUrl, client } = settings();
  const needsW = ["w-address", "queue", "w-credit", "send-w"].includes(command);
  const minimumProtocol = needsW ? 30 : 29;

  if (command === "config" || command === "health" || command === "account" || command === "w-address" || command === "queue") {
    const source = readAccount();
    const scope = await vaultScope(client, source, minimumProtocol);
    if (command === "config") print(await client.config(source));
    if (command === "health") print(await client.health(source));
    if (command === "account") print(await client.subaccount(source, parseU64(first)));
    if (command === "w-address") {
      const customerId = parseU64(first);
      if (!(await client.subaccount(source, customerId))?.active) throw new Error("Customer is unknown or inactive");
      print({ customerId, address: encodeWAddress(client.vault, customerId) });
    }
    if (command === "queue") {
      const pool = openDatabase();
      try {
        print(await listQueue(pool, client, new EventRpc(rpcUrl, scope), source, first ?? null));
      } finally {
        await pool.end();
      }
    }
    return;
  }

  const signer = Keypair.fromSecret(requiredEnv("MUXVAULT_SIGNER_SEED"));
  const source = signer.publicKey();
  const scope = await vaultScope(client, source, minimumProtocol);
  if (command === "anchor-credit" || command === "w-credit") {
    const pool = openDatabase();
    try {
      const result = command === "anchor-credit"
        ? await creditAnchorPayment(pool, client, scope, signer, first)
        : await creditQueuedTransfer(pool, client, new EventRpc(rpcUrl, scope), signer, first);
      print(result);
    } finally {
      await pool.end();
    }
    return;
  }

  let transaction;
  switch (command) {
    case "register":
      transaction = await client.register(source);
      break;
    case "deposit":
      transaction = await client.deposit(source, parseU64(first), parseAmount(second));
      break;
    case "withdraw":
      transaction = await client.withdraw(source, parseU64(first), second, parseAmount(third));
      break;
    case "send-w":
      await validateDestination(
        first, scope.vault, async () => { await client.verifyNetwork(30); },
        (id) => client.subaccount(source, id),
      );
      transaction = await client.prepare(source, "transfer", [
        Address.fromString(source).toScVal(),
        Address.fromString(first).toScVal(),
        nativeToScVal(parseAmount(second), { type: "i128" }),
      ], scope.asset);
      break;
    case "set-signers":
      if (second !== "off") await client.verifyNetwork(30);
      transaction = await client.prepare(source, "set_settlement_signers", [
        authorizationAddress(first).toScVal(),
        second === "off" ? xdr.ScVal.scvVoid() : authorizationAddress(second).toScVal(),
      ]);
      break;
    case "pause":
      transaction = await client.prepare(source, "pause", [authorizationAddress(source).toScVal()]);
      break;
    case "resume":
      transaction = await client.prepare(source, "resume", []);
      break;
    case "deactivate":
      transaction = await client.prepare(source, "deactivate", [xdr.ScVal.scvU64(parseU64(first))]);
      break;
    case "keep-alive":
      if (second !== "-" && !/^[0-9a-f]{64}$/.test(second)) throw new Error("Expected a SHA-256 hex reference");
      transaction = await client.prepare(source, "keep_alive", [
        first === "-" ? xdr.ScVal.scvVoid() : xdr.ScVal.scvU64(parseU64(first)),
        second === "-" ? xdr.ScVal.scvVoid() : xdr.ScVal.scvBytes(Buffer.from(second, "hex")),
      ]);
      break;
  }
  signAsSource(transaction, signer);
  print(await submit(client.rpc, transaction));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Operator command failed");
  process.exitCode = 1;
});
