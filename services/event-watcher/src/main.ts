import { setTimeout as delay } from "node:timers/promises";
import { parseLedger } from "../../../packages/sdk-ts/src/amount.ts";
import { openDatabase } from "../../database.ts";
import { readAccount, requiredEnv, settings, vaultScope } from "../../settings.ts";
import { EventRpc, scanPage } from "./watcher.ts";

async function main() {
  const { rpcUrl, client } = settings();
  const scope = await vaultScope(client, readAccount(), 30);
  const startLedger = parseLedger(requiredEnv("WATCH_START_LEDGER"));
  const events = new EventRpc(rpcUrl, scope);
  const pool = openDatabase();
  const once = process.argv.includes("--once");
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });
  try {
    do {
      const result = await scanPage(pool, client, events, startLedger);
      if (result) console.log(JSON.stringify({ vault: scope.vault, ...result }));
      if (once) break;
      if (!result) await delay(5_000);
    } while (!stopping);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Watcher failed");
  process.exitCode = 1;
});
