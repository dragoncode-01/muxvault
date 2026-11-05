export interface Checkpoint {
  nextLedger: number;
  windowEnd: number | null;
  cursor: string | null;
}

const WINDOW_LEDGERS = 128;
export const PAGE_SIZE = 100;

export function planWindow(checkpoint: Checkpoint, oldestLedger: number, latestLedger: number) {
  if (!Number.isInteger(oldestLedger) || !Number.isInteger(latestLedger) || oldestLedger < 1 || latestLedger < oldestLedger) {
    throw new Error("RPC returned invalid ledger retention bounds");
  }
  if (checkpoint.nextLedger < oldestLedger) {
    throw new Error(`Event history gap. Need ledger ${checkpoint.nextLedger}, RPC starts at ${oldestLedger}`);
  }
  if (checkpoint.nextLedger > latestLedger || (checkpoint.windowEnd ?? 0) > latestLedger + 1) return null;
  return checkpoint.windowEnd ?? Math.min(checkpoint.nextLedger + WINDOW_LEDGERS, latestLedger + 1);
}

export function finishPage<T extends { ledger: number }>(
  checkpoint: Checkpoint,
  end: number,
  events: readonly T[],
  nextCursor: string,
  limit = PAGE_SIZE,
) {
  if (events.length > limit || events.some(({ ledger }) => !Number.isInteger(ledger) || ledger < checkpoint.nextLedger)) {
    throw new Error("RPC returned events outside the requested ledger range");
  }
  const within = events.filter(({ ledger }) => ledger < end);
  const complete = events.length < limit || within.length < events.length;
  if (!complete && (!/^\d{19}-\d{10}$/.test(nextCursor) || (checkpoint.cursor !== null && nextCursor <= checkpoint.cursor))) {
    throw new Error("RPC cursor did not advance");
  }
  const next: Checkpoint = complete
    ? { nextLedger: end, windowEnd: null, cursor: null }
    : { nextLedger: checkpoint.nextLedger, windowEnd: end, cursor: nextCursor };
  return { within, next };
}
