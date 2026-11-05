import {
  BASE_FEE, Contract, StrKey, TransactionBuilder, nativeToScVal, rpc, scValToNative, xdr,
} from "@stellar/stellar-sdk";
import type { Transaction } from "@stellar/stellar-sdk";
import { parseAmount, parseLedger, parseU64 } from "./amount.ts";
import type { Config, Health, Receipt, Subaccount } from "./types.ts";
import { authorizationAddress, requireContract } from "./w-address.ts";

const TX_TTL_SECONDS = 120;

function customerId(id: bigint) {
  return nativeToScVal(parseU64(id.toString()), { type: "u64" });
}

function units(amount: bigint) {
  return nativeToScVal(parseAmount(amount.toString()), { type: "i128" });
}

function referenceBytes(reference: string) {
  if (!/^[a-f0-9]{64}$/.test(reference)) throw new Error("Expected a SHA-256 hex reference");
  const bytes = Uint8Array.from(reference.match(/../g) ?? [], (hex) => Number.parseInt(hex, 16));
  return xdr.ScVal.scvBytes(bytes);
}

function nullable<T>(value: xdr.ScVal): T | null {
  return value.type === "scvVoid" ? null : scValToNative(value) as T;
}

export class VaultClient {
  readonly rpc: rpc.Server;
  readonly vault: string;
  readonly passphrase: string;

  constructor(rpcUrl: string, passphrase: string, vault: string) {
    this.vault = requireContract(vault);
    this.passphrase = passphrase;
    const url = new URL(rpcUrl);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const allowHttp = local && url.protocol === "http:";
    if (!allowHttp && url.protocol !== "https:") throw new Error("RPC must use HTTPS or loopback HTTP");
    this.rpc = new rpc.Server(url.toString(), { allowHttp, timeout: 25_000 });
  }

  async verifyNetwork(minimumProtocol = 29) {
    const network = await this.rpc.getNetwork();
    if (network.passphrase !== this.passphrase) throw new Error("Unexpected Stellar network passphrase");
    const protocol = Number(network.protocolVersion);
    if (!Number.isInteger(protocol) || protocol < minimumProtocol) {
      throw new Error(`Protocol ${minimumProtocol} is required, RPC reports ${network.protocolVersion}`);
    }
    return network;
  }

  async transaction(source: string, contract: string, method: string, args: readonly xdr.ScVal[]) {
    if (!StrKey.isValidEd25519PublicKey(source)) throw new Error("Transaction source requires a G-address");
    const account = await this.rpc.getAccount(source);
    return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: this.passphrase })
      .addOperation(new Contract(requireContract(contract)).call(method, ...args))
      .setTimeout(TX_TTL_SECONDS)
      .build();
  }

  async read(source: string, method: string, ...args: xdr.ScVal[]) {
    const tx = await this.transaction(source, this.vault, method, args);
    const result = await this.rpc.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(result) || !result.result) {
      const detail = rpc.Api.isSimulationError(result) ? result.error : "Missing simulation result";
      throw new Error(`${method} simulation failed. ${detail}`);
    }
    return result.result.retval;
  }

  async config(source: string): Promise<Config> {
    const config = scValToNative(await this.read(source, "config")) as Config;
    return { ...config, w_settlement_signer: config.w_settlement_signer ?? null };
  }

  async health(source: string): Promise<Health> {
    return scValToNative(await this.read(source, "health")) as Health;
  }

  async subaccount(source: string, id: bigint): Promise<Subaccount | null> {
    return nullable<Subaccount>(await this.read(source, "subaccount", customerId(id)));
  }

  async receipt(source: string, reference: string): Promise<Receipt | null> {
    return nullable<Receipt>(await this.read(source, "settlement_receipt", referenceBytes(reference)));
  }

  async prepare(source: string, method: string, args: readonly xdr.ScVal[], contract = this.vault): Promise<Transaction> {
    return this.rpc.prepareTransaction(await this.transaction(source, contract, method, args));
  }

  register(source: string) {
    return this.prepare(source, "register_subaccount", [authorizationAddress(source).toScVal()]);
  }

  deposit(source: string, id: bigint, amount: bigint) {
    return this.prepare(source, "deposit", [customerId(id), units(amount)]);
  }

  withdraw(source: string, id: bigint, recipient: string, amount: bigint) {
    return this.prepare(source, "withdraw", [
      customerId(id), authorizationAddress(recipient).toScVal(), units(amount),
    ]);
  }

  anchorDeposit(source: string, id: bigint, amount: bigint, reference: string) {
    return this.prepare(source, "anchor_deposit_for", [customerId(id), units(amount), referenceBytes(reference)]);
  }

  settleW(source: string, id: bigint, amount: bigint, eventLedger: number, reference: string) {
    return this.prepare(source, "settle_external_w_deposit", [
      customerId(id), units(amount), xdr.ScVal.scvU32(parseLedger(String(eventLedger))), referenceBytes(reference),
    ]);
  }
}
