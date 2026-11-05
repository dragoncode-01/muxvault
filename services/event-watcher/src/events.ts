import { Address, StrKey, scValToNative, xdr } from "@stellar/stellar-sdk";
import { parseAmount, parseLedger, parseU64 } from "../../../packages/sdk-ts/src/amount.ts";
import { wReference } from "../../../packages/sdk-ts/src/references.ts";
import type { VaultScope } from "../../../packages/sdk-ts/src/types.ts";

export interface RawEvent {
  type: string;
  ledger: number;
  contractId: string;
  id: string;
  operationIndex: number;
  inSuccessfulContractCall?: boolean;
  topic: string[];
  value: string;
  txHash: string;
}

export interface WTransfer {
  eventId: string;
  txHash: string;
  operationIndex: number;
  eventIndex: number;
  ledger: number;
  sender: string;
  customerId: string;
  amount: string;
  reference: string;
  evidence: RawEvent;
}

function addressTopic(value: xdr.ScVal) {
  return value.type === "scvAddress" ? Address.fromScVal(value).toString() : null;
}

export function decodeWTransfer(event: RawEvent, scope: VaultScope): WTransfer | null {
  if (event.type !== "contract" || event.inSuccessfulContractCall === false || event.contractId !== scope.asset) return null;
  if (event.topic.length < 3 || event.topic.length > 4) return null;
  const [verb, from, to] = event.topic.slice(0, 3).map((topic) => xdr.ScVal.fromXDR(topic, "base64"));
  if (verb.type !== "scvSymbol" || verb.value !== "transfer" || addressTopic(to) !== scope.vault) {
    return null;
  }
  const sender = addressTopic(from);
  if (!sender || (!StrKey.isValidEd25519PublicKey(sender) && !StrKey.isValidContract(sender)) || sender === scope.vault) {
    return null;
  }

  const payload = xdr.ScVal.fromXDR(event.value, "base64");
  if (payload.type !== "scvMap") return null;
  const entries = new Map((payload.map ?? []).flatMap(({ key, val }) =>
    key.type === "scvSymbol" ? [[key.value, val] as const] : [],
  ));
  const id = entries.get("to_muxed_id");
  if (id?.type !== "scvU64") return null;
  const amount = entries.get("amount");
  if (amount?.type !== "scvI128") throw new Error("Tagged SAC transfer is missing its i128 amount");
  const value = scValToNative(amount) as bigint;
  if (value === 0n) return null;

  const [, position] = /^\d{19}-(\d{10})$/.exec(event.id) ?? [];
  if (!position || !/^[a-f0-9]{64}$/i.test(event.txHash)
    || !Number.isInteger(event.operationIndex) || event.operationIndex < 0) {
    throw new Error("Tagged SAC transfer is missing its ledger position");
  }
  const txHash = event.txHash.toLowerCase();
  return {
    eventId: event.id,
    txHash,
    operationIndex: event.operationIndex,
    eventIndex: Number(position),
    ledger: parseLedger(String(event.ledger)),
    sender,
    customerId: parseU64(id.u64.toString()).toString(),
    amount: parseAmount(value.toString()).toString(),
    reference: wReference(scope, txHash, event.id),
    evidence: event,
  };
}
