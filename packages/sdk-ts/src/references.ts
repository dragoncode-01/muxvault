import { createHash } from "node:crypto";
import type { VaultScope } from "./types.ts";

function digest(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

export function networkId(passphrase: string): string {
  return createHash("sha256").update(passphrase, "utf8").digest("hex");
}

export function anchorReference(scope: VaultScope, namespace: string, paymentId: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(namespace) || !paymentId || paymentId.length > 256) {
    throw new Error("Invalid anchor reference inputs");
  }
  return digest(["muxvault.anchor.v1", networkId(scope.passphrase), scope.vault, scope.asset, namespace, paymentId]);
}

export function wReference(scope: VaultScope, txHash: string, eventId: string): string {
  return digest(["muxvault.w.v1", networkId(scope.passphrase), scope.vault, scope.asset, txHash.toLowerCase(), eventId]);
}
