import { Address, StrKey, encodeMuxedContractAddress, extractBaseAddress } from "@stellar/stellar-sdk";
import { parseU64 } from "./amount.ts";
import type { Subaccount } from "./types.ts";

export function requireContract(address: string): string {
  if (!StrKey.isValidContract(address)) throw new Error("Expected a C-address");
  return address;
}

export function authorizationAddress(address: string): Address {
  if (!StrKey.isValidEd25519PublicKey(address) && !StrKey.isValidContract(address)) {
    throw new Error("Authorization requires a G- or C-address");
  }
  return Address.fromString(address);
}

export function encodeWAddress(vault: string, customerId: bigint): string {
  return encodeMuxedContractAddress(requireContract(vault), parseU64(customerId.toString()).toString());
}

export function decodeWAddress(address: string): { vault: string; customerId: bigint } {
  if (!StrKey.isValidMuxedContract(address)) throw new Error("Invalid W-address");
  const decoded = Address.fromString(address).toScAddress();
  if (decoded.type !== "scAddressTypeMuxedContract") throw new Error("Invalid W-address");
  return { vault: extractBaseAddress(address), customerId: decoded.muxedContract.id };
}

export async function validateDestination(
  address: string,
  expectedVault: string,
  verifyProtocol30Network: () => Promise<void>,
  lookup: (id: bigint) => Promise<Subaccount | null>,
): Promise<bigint> {
  const { vault, customerId } = decodeWAddress(address);
  if (vault !== expectedVault) throw new Error("Destination belongs to a different vault");
  await verifyProtocol30Network();
  if (!(await lookup(customerId))?.active) throw new Error("Customer is unknown or inactive");
  return customerId;
}
