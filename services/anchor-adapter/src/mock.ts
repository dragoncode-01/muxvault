import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { parseAssetUnits, parseU64 } from "../../../packages/sdk-ts/src/amount.ts";
import { networkId } from "../../../packages/sdk-ts/src/references.ts";
import { requiredEnv, settings } from "../../settings.ts";

function main() {
  const token = requiredEnv("ANCHOR_MOCK_TOKEN");
  if (token.length < 16) throw new Error("Use an ANCHOR_MOCK_TOKEN of at least 16 characters");
  const expectedAuth = Buffer.from(`Bearer ${token}`);
  const id = requiredEnv("MOCK_PAYMENT_ID");
  const amount = requiredEnv("MOCK_ASSET_AMOUNT");
  parseAssetUnits(amount);
  const customerId = parseU64(requiredEnv("MOCK_CUSTOMER_ID"));
  if (customerId === 0n) throw new Error("Customer ID 0 is reserved");
  const asset = requiredEnv("ASSET");
  const { client } = settings();
  const port = Number(process.env.ANCHOR_MOCK_PORT ?? "4242");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid anchor mock port");

  createServer((request, response) => {
    const reply = (status: number, data: object) => {
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(data));
    };
    const actualAuth = Buffer.from(request.headers.authorization ?? "");
    if (actualAuth.length !== expectedAuth.length || !timingSafeEqual(actualAuth, expectedAuth)) {
      reply(401, { error: "Unauthorized" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/transaction" || url.searchParams.get("id") !== id) {
      reply(404, { error: "Unknown transaction" });
      return;
    }
    reply(200, {
      transaction: {
        id,
        kind: "deposit",
        status: "pending_anchor",
        amount_out: amount,
        amount_out_asset: `stellar:${asset}`,
        stellar_transaction_id: null,
        muxvault: {
          fiat_ready: true,
          customer_id: customerId.toString(),
          vault: client.vault,
          network_id: networkId(client.passphrase),
        },
      },
    });
  }).listen(port, "127.0.0.1", () => console.log(`Controlled anchor fixture listening on 127.0.0.1:${port}`));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Anchor mock failed");
  process.exitCode = 1;
}
