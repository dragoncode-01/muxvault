import assert from "node:assert/strict";
import test from "node:test";
import { parseAmount, parseAssetUnits, parseLedger, parseU64 } from "../packages/sdk-ts/src/amount.ts";
import { anchorReference, networkId, wReference } from "../packages/sdk-ts/src/references.ts";
import { parsePayment } from "../services/anchor-adapter/src/payment.ts";
import { finishPage, planWindow } from "../services/event-watcher/src/checkpoint.ts";

const scope = { passphrase: "testnet", vault: "vault", asset: "asset" };
const checkpoint = { nextLedger: 90, windowEnd: null, cursor: null };
const eventId = "0000000000000000010-0000000001";
const nextEventId = "0000000000000000010-0000000002";

test("integer parsers preserve u64 and i128 boundaries", () => {
  const u64 = (1n << 64n) - 1n;
  const i128 = (1n << 127n) - 1n;
  assert.equal(parseU64(u64.toString()), u64);
  assert.equal(parseU64("0"), 0n);
  assert.equal(parseAmount(i128.toString()), i128);
  assert.equal(parseLedger("4294967295"), 4_294_967_295);
  for (const invalid of ["", "-1", "+1", "1e3", "0x10", "01", " 1", (u64 + 1n).toString()]) {
    assert.throws(() => parseU64(invalid));
  }
  assert.throws(() => parseAmount((i128 + 1n).toString()));
  assert.throws(() => parseAmount("0"));
  assert.throws(() => parseLedger("4294967296"));
});

test("anchor amounts use exact seven-decimal conversion", () => {
  assert.equal(parseAssetUnits("2.3456789"), 23_456_789n);
  assert.equal(parseAssetUnits("0.0000001"), 1n);
  assert.equal(parseAssetUnits("1"), 10_000_000n);
  for (const invalid of ["0", "0.0000000", "1.23456789", "1e2", ".1", "1."]) {
    assert.throws(() => parseAssetUnits(invalid));
  }
});

test("references bind network, asset, vault and payment or event identity", () => {
  const tx = "ab".repeat(32);
  const anchor = anchorReference(scope, "example", "id");
  const w = wReference(scope, tx, eventId);
  assert.match(anchor, /^[a-f0-9]{64}$/);
  assert.equal(anchor, anchorReference(scope, "example", "id"));
  assert.equal(w, wReference(scope, tx.toUpperCase(), eventId));
  assert.notEqual(w, wReference(scope, tx, nextEventId));
  assert.notEqual(anchor, anchorReference({ ...scope, passphrase: "other" }, "example", "id"));
  assert.notEqual(anchor, anchorReference({ ...scope, asset: "other" }, "example", "id"));
  assert.notEqual(anchor, anchorReference({ ...scope, vault: "other" }, "example", "id"));
  assert.notEqual(anchor, anchorReference(scope, "different", "id"));
  assert.notEqual(w, anchorReference(scope, "example", eventId));
});

test("checkpoint keeps the bounded window through pagination and restart", () => {
  const end = planWindow(checkpoint, 50, 100);
  assert.equal(end, 101);
  const rows = [{ ledger: 93 }, { ledger: 91 }]; // Delivery order within a page does not matter.
  const first = finishPage(checkpoint, end, rows, eventId, 2);
  assert.deepEqual(first.within, rows);
  assert.deepEqual(first.next, { nextLedger: 90, windowEnd: 101, cursor: eventId });
  assert.equal(planWindow(first.next, 55, 150), 101);
  const duplicate = finishPage(first.next, end, [{ ledger: 93 }, { ledger: 99 }], nextEventId, 2);
  assert.equal(duplicate.next.cursor, nextEventId);
  const last = finishPage(duplicate.next, end, [{ ledger: 101 }, { ledger: 100 }], "", 2);
  assert.deepEqual(last.within, [{ ledger: 100 }]);
  assert.deepEqual(last.next, { nextLedger: 101, windowEnd: null, cursor: null });
});

test("checkpoint advances empty windows and fails closed on retention gaps", () => {
  assert.deepEqual(finishPage(checkpoint, 95, [], "").next, { nextLedger: 95, windowEnd: null, cursor: null });
  assert.throws(() => planWindow(checkpoint, 91, 100), /history gap/);
  assert.equal(planWindow(checkpoint, 80, 89), null);
  assert.throws(() => finishPage({ ...checkpoint, cursor: eventId }, 100, [{ ledger: 90 }], eventId, 1), /cursor/);
  assert.throws(() => finishPage(checkpoint, 100, [{ ledger: 89 }], ""), /ledger range/);
});

test("anchor mock settlement requires separate fiat readiness and refuses existing payouts", () => {
  const tx = {
    id: "order-42",
    kind: "deposit",
    status: "pending_anchor",
    amount_out: "8.5000001",
    amount_out_asset: "stellar:native",
    stellar_transaction_id: null,
    muxvault: { fiat_ready: true, vault: scope.vault, network_id: networkId(scope.passphrase), customer_id: "3" },
  };
  const parse = (transaction: Record<string, unknown>) =>
    parsePayment({ transaction }, scope, "native", "anchor", "order-42");
  const payment = parse(tx);
  assert.equal(payment.amount, 85_000_001n);
  assert.equal(payment.customerId, 3n);
  assert.deepEqual(parse(tx), payment);
  for (const status of ["completed", "pending_stellar", "refunded", "error"]) {
    assert.throws(() => parse({ ...tx, status }), /ineligible/);
  }
  assert.throws(() => parse({ ...tx, stellar_transaction_id: "existing" }), /ineligible/);
  assert.throws(() => parse({ ...tx, amount_out_asset: "stellar:OTHER" }), /asset/);
  assert.throws(() => parse({ ...tx, muxvault: { ...tx.muxvault, fiat_ready: false } }), /readiness/);
  assert.throws(() => parse({ ...tx, muxvault: { ...tx.muxvault, network_id: "different" } }), /readiness/);
  assert.throws(() => parse({ ...tx, muxvault: { ...tx.muxvault, vault: "different" } }), /readiness/);
});
