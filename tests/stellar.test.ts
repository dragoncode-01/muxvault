import assert from "node:assert/strict";
import test from "node:test";
import { Address, Keypair, Networks, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { assetInfo } from "../packages/sdk-ts/src/asset.ts";
import {
  authorizationAddress, decodeWAddress, encodeWAddress, validateDestination,
} from "../packages/sdk-ts/src/w-address.ts";
import { decodeWTransfer } from "../services/event-watcher/src/events.ts";
import type { RawEvent } from "../services/event-watcher/src/events.ts";

const vault = "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA";
const otherVault = StrKey.encodeContract(Buffer.alloc(32, 2));
const sender = Keypair.random().publicKey();
const scope = { passphrase: Networks.TESTNET, vault, asset: assetInfo("native", Networks.TESTNET).address };
const maxU64 = (1n << 64n) - 1n;
const knownW = "WA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAAAWWC";

function transfer(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    type: "contract",
    ledger: 3727845,
    contractId: scope.asset,
    id: "0016010972359577600-0000000001",
    operationIndex: 0,
    topic: [
      xdr.ScVal.scvSymbol("transfer"),
      Address.fromString(sender).toScVal(),
      Address.fromString(vault).toScVal(),
      xdr.ScVal.scvString("native"),
    ].map((value) => value.toXDR("base64")),
    value: xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"), val: nativeToScVal(50n, { type: "i128" }) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("to_muxed_id"), val: xdr.ScVal.scvU64(maxU64) }),
    ]).toXDR("base64"),
    txHash: "ab".repeat(32),
    ...overrides,
  };
}

test("W address round-trips the SEP-23 vector and full u64 boundary", () => {
  assert.equal(encodeWAddress(vault, 0n), knownW);
  for (const id of [0n, 1n, 9_007_199_254_740_993n, maxU64]) {
    assert.deepEqual(decodeWAddress(encodeWAddress(vault, id)), { vault, customerId: id });
  }
  assert.throws(() => encodeWAddress(vault, maxU64 + 1n));
  assert.throws(() => decodeWAddress(knownW.slice(0, -1) + "A"));
  assert.throws(() => authorizationAddress(knownW));
  assert.equal(authorizationAddress(vault).toString(), vault);
});

test("destination verification checks vault, network and active registration", async () => {
  const id = 13n;
  const address = encodeWAddress(vault, id);
  const account = { owner: sender, active: true, created_ledger: 2, balance: 0n };
  const check = async () => {};
  assert.equal(await validateDestination(address, vault, check, async () => account), id);
  await assert.rejects(validateDestination(address, otherVault, check, async () => account), /different vault/);
  await assert.rejects(validateDestination(address, vault, async () => { throw Error("wrong network"); }, async () => account), /network/);
  await assert.rejects(validateDestination(address, vault, check, async () => null), /unknown/);
  await assert.rejects(validateDestination(address, vault, check, async () => ({ ...account, active: false })), /inactive/);
});

test("watcher accepts the successful SAC transfer shape and keeps precision", () => {
  const event = transfer();
  const parsed = decodeWTransfer(event, scope);
  assert.ok(parsed);
  assert.equal(parsed.amount, "50");
  assert.equal(parsed.customerId, maxU64.toString());
  assert.equal(parsed.sender, sender);
  assert.equal(parsed.eventIndex, 1);
  assert.equal(parsed.reference, decodeWTransfer({ ...event, txHash: event.txHash.toUpperCase() }, scope)?.reference);
  assert.equal(parsed.reference, decodeWTransfer({ ...event, topic: event.topic.slice(0, 3) }, scope)?.reference);
});

test("watcher filters failed calls, other assets, other vaults, mint and untagged deposits", () => {
  const event = transfer();
  const differentTo = [...event.topic];
  differentTo[2] = Address.fromString(otherVault).toScVal().toXDR("base64");
  const mint = [xdr.ScVal.scvSymbol("mint").toXDR("base64"), ...event.topic.slice(1)];
  for (const raw of [
    { ...event, inSuccessfulContractCall: false },
    { ...event, type: "diagnostic" },
    { ...event, contractId: otherVault },
    { ...event, topic: differentTo },
    { ...event, topic: mint },
    { ...event, value: nativeToScVal(50n, { type: "i128" }).toXDR("base64") },
  ]) {
    assert.equal(decodeWTransfer(raw, scope), null);
  }
});
