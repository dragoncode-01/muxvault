use soroban_sdk::{contracttype, Address, BytesN, Env};

use crate::VaultError;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub asset: Address,
    pub admin: Address,
    pub settlement_signer: Address,
    pub guardian: Address,
    pub w_settlement_signer: Option<Address>,
    pub paused: bool,
    pub schema_version: u32,
}

#[contracttype]
#[derive(Clone)]
pub(crate) struct Core {
    pub config: Config,
    pub next_id: u64,
    pub liabilities: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Subaccount {
    pub owner: Address,
    pub balance: i128,
    pub active: bool,
    pub created_ledger: u32,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SettlementKind {
    Anchor,
    ExternalW,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Receipt {
    pub kind: SettlementKind,
    pub customer_id: u64,
    pub amount: i128,
    pub ledger: u32,
}

#[contracttype]
#[derive(Clone)]
pub(crate) enum Key {
    Core,
    Customer(u64),
    Reference(BytesN<32>),
}

pub(crate) fn core(env: &Env) -> Result<Core, VaultError> {
    env.storage()
        .persistent()
        .get(&Key::Core)
        .ok_or(VaultError::MissingState)
}

pub(crate) fn customer(env: &Env, id: u64) -> Result<Subaccount, VaultError> {
    env.storage()
        .persistent()
        .get(&Key::Customer(id))
        .ok_or(VaultError::UnknownCustomer)
}

pub(crate) fn active_customer(env: &Env, id: u64) -> Result<Subaccount, VaultError> {
    let account = customer(env, id)?;
    if !account.active {
        return Err(VaultError::InactiveCustomer);
    }
    Ok(account)
}

pub(crate) fn save_core(env: &Env, state: &Core) {
    env.storage().persistent().set(&Key::Core, state);
    extend(env, &Key::Core);
    let max = env.storage().max_ttl();
    env.storage().instance().extend_ttl(max / 2, max);
}

pub(crate) fn save_customer(env: &Env, id: u64, account: &Subaccount) {
    let key = Key::Customer(id);
    env.storage().persistent().set(&key, account);
    extend(env, &key);
}

pub(crate) fn receipt(env: &Env, reference: BytesN<32>) -> Option<Receipt> {
    env.storage().persistent().get(&Key::Reference(reference))
}

pub(crate) fn save_receipt(env: &Env, reference: BytesN<32>, receipt: &Receipt) {
    let key = Key::Reference(reference);
    env.storage().persistent().set(&key, receipt);
    extend(env, &key);
}

pub(crate) fn extend(env: &Env, key: &Key) {
    let max = env.storage().max_ttl();
    env.storage().persistent().extend_ttl(key, max / 2, max);
}
