export interface Config {
  asset: string;
  admin: string;
  settlement_signer: string;
  guardian: string;
  w_settlement_signer: string | null;
  paused: boolean;
  schema_version: number;
}

export interface Subaccount {
  owner: string;
  balance: bigint;
  active: boolean;
  created_ledger: number;
}

export interface Health {
  reserve: bigint;
  liabilities: bigint;
  asset_authorized: boolean;
  healthy: boolean;
  paused: boolean;
}

export interface Receipt {
  kind: readonly ["Anchor" | "ExternalW"];
  customer_id: bigint;
  amount: bigint;
  ledger: number;
}

export interface VaultScope {
  passphrase: string;
  vault: string;
  asset: string;
}
