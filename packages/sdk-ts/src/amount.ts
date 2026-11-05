const U64_MAX = (1n << 64n) - 1n;
const I128_MAX = (1n << 127n) - 1n;

function unsignedDecimal(text: string, max: bigint, label: string): bigint {
  if (text.length > max.toString().length || !/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new Error(`Invalid ${label}`);
  }
  const value = BigInt(text);
  if (value > max) throw new Error(`Invalid ${label}`);
  return value;
}

export function parseU64(text: string): bigint {
  return unsignedDecimal(text, U64_MAX, "u64");
}

export function parseAmount(text: string): bigint {
  const amount = unsignedDecimal(text, I128_MAX, "amount in base units");
  if (amount === 0n) throw new Error("Amount must be positive");
  return amount;
}

export function parseLedger(text: string): number {
  const ledger = unsignedDecimal(text, 4_294_967_295n, "ledger");
  if (ledger === 0n) throw new Error("Ledger must be positive");
  return Number(ledger);
}

export function parseAssetUnits(text: string): bigint {
  const match = /^(0|[1-9][0-9]{0,31})(?:\.([0-9]{1,7}))?$/.exec(text);
  if (!match) throw new Error("Expected an asset amount with up to seven decimals");
  const whole = BigInt(match[1]) * 10_000_000n;
  const fractional = BigInt((match[2] ?? "").padEnd(7, "0"));
  return parseAmount((whole + fractional).toString());
}
