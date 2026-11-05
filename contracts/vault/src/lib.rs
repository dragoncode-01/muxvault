#![no_std]

mod errors;
mod events;
mod storage;
mod token;

use soroban_sdk::{contract, contractimpl, contracttype, Address, Bytes, BytesN, Env};

pub use errors::VaultError;
pub use storage::{Config, Receipt, SettlementKind, Subaccount};
use storage::{Core, Key};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Health {
    pub reserve: i128,
    pub liabilities: i128,
    pub asset_authorized: bool,
    pub healthy: bool,
    pub paused: bool,
}

#[contract]
pub struct MuxVault;

#[contractimpl]
impl MuxVault {
    /// Deployed atomically with the vault. Derives the built-in SAC from Stellar Asset XDR.
    pub fn __constructor(
        env: Env,
        admin: Address,
        asset_xdr: Bytes,
        settlement_signer: Address,
        guardian: Address,
    ) -> Result<(), VaultError> {
        let asset = env
            .deployer()
            .with_stellar_asset(asset_xdr)
            .deployed_address();
        let config = Config {
            asset,
            admin,
            settlement_signer,
            guardian,
            w_settlement_signer: None,
            paused: false,
            schema_version: 1,
        };
        validate_roles(&env, &config)?;
        if soroban_sdk::token::StellarAssetClient::new(&env, &config.asset).try_decimals()
            != Ok(Ok(7))
        {
            return Err(VaultError::InvalidAsset);
        }
        storage::save_core(
            &env,
            &Core {
                config,
                next_id: 1,
                liabilities: 0,
            },
        );
        Ok(())
    }

    pub fn register_subaccount(env: Env, owner: Address) -> Result<u64, VaultError> {
        reject_vault(&env, &owner)?;
        owner.require_auth();
        let mut core = storage::core(&env)?;
        let id = core.next_id;
        core.next_id = id.checked_add(1).ok_or(VaultError::Overflow)?;
        let account = Subaccount {
            owner: owner.clone(),
            balance: 0,
            active: true,
            created_ledger: env.ledger().sequence(),
        };
        storage::save_customer(&env, id, &account);
        storage::save_core(&env, &core);
        events::Registered {
            customer_id: id,
            owner,
        }
        .publish(&env);
        Ok(id)
    }

    pub fn deposit(env: Env, customer_id: u64, amount: i128) -> Result<(), VaultError> {
        let mut core = open_core(&env)?;
        let mut account = storage::active_customer(&env, customer_id)?;
        account.owner.require_auth();
        fund_credit(&env, &mut core, &mut account, None, amount)?;
        storage::save_customer(&env, customer_id, &account);
        storage::save_core(&env, &core);
        events::Deposited {
            customer_id,
            amount,
        }
        .publish(&env);
        Ok(())
    }

    pub fn anchor_deposit_for(
        env: Env,
        customer_id: u64,
        amount: i128,
        external_ref: BytesN<32>,
    ) -> Result<(), VaultError> {
        let mut core = open_core(&env)?;
        let mut account = storage::active_customer(&env, customer_id)?;
        let payer = core.config.settlement_signer.clone();
        payer.require_auth();
        require_unused(&env, &external_ref)?;
        fund_credit(&env, &mut core, &mut account, Some(&payer), amount)?;
        storage::save_customer(&env, customer_id, &account);
        storage::save_core(&env, &core);
        record_settlement(
            &env,
            SettlementKind::Anchor,
            customer_id,
            amount,
            external_ref,
        );
        Ok(())
    }

    /// The external signer attests to both the historical event and its routing metadata.
    pub fn settle_external_w_deposit(
        env: Env,
        customer_id: u64,
        amount: i128,
        event_ledger: u32,
        event_ref: BytesN<32>,
    ) -> Result<(), VaultError> {
        let mut core = open_core(&env)?;
        let signer = core
            .config
            .w_settlement_signer
            .as_ref()
            .ok_or(VaultError::WSettlementDisabled)?;
        signer.require_auth();
        let mut account = storage::active_customer(&env, customer_id)?;
        if event_ledger <= account.created_ledger || event_ledger >= env.ledger().sequence() {
            return Err(VaultError::InvalidEventLedger);
        }
        require_unused(&env, &event_ref)?;
        apply_credit(&mut core, &mut account, amount)?;
        token::check_reserve(&env, &core.config.asset, core.liabilities)?;
        storage::save_customer(&env, customer_id, &account);
        storage::save_core(&env, &core);
        record_settlement(
            &env,
            SettlementKind::ExternalW,
            customer_id,
            amount,
            event_ref,
        );
        Ok(())
    }

    pub fn withdraw(
        env: Env,
        customer_id: u64,
        recipient: Address,
        amount: i128,
    ) -> Result<(), VaultError> {
        let mut core = open_core(&env)?;
        let mut account = storage::active_customer(&env, customer_id)?;
        account.owner.require_auth();
        reject_vault(&env, &recipient)?;
        require_positive(amount)?;
        if account.balance < amount {
            return Err(VaultError::InsufficientBalance);
        }
        let asset = core.config.asset.clone();
        let before = token::check_reserve(&env, &asset, core.liabilities)?;
        account.balance -= amount;
        core.liabilities = core
            .liabilities
            .checked_sub(amount)
            .filter(|remaining| *remaining >= 0)
            .ok_or(VaultError::Underfunded)?;
        storage::save_customer(&env, customer_id, &account);
        storage::save_core(&env, &core);
        token::transfer(
            &env,
            &asset,
            &env.current_contract_address(),
            &recipient,
            amount,
        );
        if token::reserve(&env, &asset) != before - amount {
            return Err(VaultError::UnexpectedReserve);
        }
        events::Withdrawn {
            customer_id,
            recipient,
            amount,
        }
        .publish(&env);
        Ok(())
    }

    pub fn rotate_owner(env: Env, customer_id: u64, new_owner: Address) -> Result<(), VaultError> {
        reject_vault(&env, &new_owner)?;
        let mut account = storage::active_customer(&env, customer_id)?;
        account.owner.require_auth();
        new_owner.require_auth();
        account.owner = new_owner.clone();
        storage::save_customer(&env, customer_id, &account);
        events::OwnerRotated {
            customer_id,
            owner: new_owner,
        }
        .publish(&env);
        Ok(())
    }

    pub fn deactivate(env: Env, customer_id: u64) -> Result<(), VaultError> {
        storage::core(&env)?.config.admin.require_auth();
        let mut account = storage::active_customer(&env, customer_id)?;
        if account.balance != 0 {
            return Err(VaultError::NonzeroBalance);
        }
        account.active = false;
        storage::save_customer(&env, customer_id, &account);
        events::Deactivated { customer_id }.publish(&env);
        Ok(())
    }

    pub fn set_settlement_signers(
        env: Env,
        funding: Address,
        external_w: Option<Address>,
    ) -> Result<(), VaultError> {
        let mut core = storage::core(&env)?;
        core.config.admin.require_auth();
        core.config.settlement_signer = funding.clone();
        core.config.w_settlement_signer = external_w.clone();
        validate_roles(&env, &core.config)?;
        storage::save_core(&env, &core);
        events::SignersChanged {
            funding,
            external_w,
        }
        .publish(&env);
        Ok(())
    }

    pub fn pause(env: Env, actor: Address) -> Result<(), VaultError> {
        let mut core = storage::core(&env)?;
        if actor != core.config.admin && actor != core.config.guardian {
            return Err(VaultError::InvalidRole);
        }
        actor.require_auth();
        core.config.paused = true;
        storage::save_core(&env, &core);
        events::PauseChanged {
            actor,
            paused: true,
        }
        .publish(&env);
        Ok(())
    }

    pub fn resume(env: Env) -> Result<(), VaultError> {
        let mut core = storage::core(&env)?;
        let actor = core.config.admin.clone();
        actor.require_auth();
        token::check_reserve(&env, &core.config.asset, core.liabilities)?;
        core.config.paused = false;
        storage::save_core(&env, &core);
        events::PauseChanged {
            actor,
            paused: false,
        }
        .publish(&env);
        Ok(())
    }

    pub fn config(env: Env) -> Result<Config, VaultError> {
        Ok(storage::core(&env)?.config)
    }

    pub fn subaccount(env: Env, customer_id: u64) -> Option<Subaccount> {
        env.storage().persistent().get(&Key::Customer(customer_id))
    }

    pub fn balance_of(env: Env, customer_id: u64) -> Result<i128, VaultError> {
        Ok(storage::customer(&env, customer_id)?.balance)
    }

    pub fn total_liabilities(env: Env) -> Result<i128, VaultError> {
        Ok(storage::core(&env)?.liabilities)
    }

    pub fn actual_reserve(env: Env) -> Result<i128, VaultError> {
        Ok(token::reserve(&env, &storage::core(&env)?.config.asset))
    }

    pub fn health(env: Env) -> Result<Health, VaultError> {
        let core = storage::core(&env)?;
        let reserve = token::reserve(&env, &core.config.asset);
        let asset_authorized = token::spendable(&env, &core.config.asset);
        Ok(Health {
            reserve,
            liabilities: core.liabilities,
            asset_authorized,
            healthy: reserve >= core.liabilities && asset_authorized,
            paused: core.config.paused,
        })
    }

    pub fn settlement_receipt(env: Env, reference: BytesN<32>) -> Option<Receipt> {
        storage::receipt(&env, reference)
    }

    /// Anyone may pay to extend the vault and the given persistent entries.
    pub fn keep_alive(
        env: Env,
        customer_id: Option<u64>,
        reference: Option<BytesN<32>>,
    ) -> Result<(), VaultError> {
        storage::core(&env)?;
        storage::extend(&env, &Key::Core);
        let max = env.storage().max_ttl();
        env.storage().instance().extend_ttl(max / 2, max);
        if let Some(id) = customer_id {
            storage::customer(&env, id)?;
            storage::extend(&env, &Key::Customer(id));
        }
        if let Some(reference) = reference {
            storage::receipt(&env, reference.clone()).ok_or(VaultError::UnknownReference)?;
            storage::extend(&env, &Key::Reference(reference));
        }
        Ok(())
    }
}

fn validate_roles(env: &Env, config: &Config) -> Result<(), VaultError> {
    let roles = [&config.admin, &config.settlement_signer, &config.guardian];
    for role in roles {
        reject_vault(env, role)?;
        if role == &config.asset {
            return Err(VaultError::InvalidRole);
        }
    }
    if roles[0] == roles[1] || roles[0] == roles[2] || roles[1] == roles[2] {
        return Err(VaultError::InvalidRole);
    }
    if let Some(signer) = &config.w_settlement_signer {
        reject_vault(env, signer)?;
        if signer == &config.asset || roles.contains(&signer) {
            return Err(VaultError::InvalidRole);
        }
    }
    Ok(())
}

fn reject_vault(env: &Env, address: &Address) -> Result<(), VaultError> {
    if address == &env.current_contract_address() {
        return Err(VaultError::InvalidAddress);
    }
    Ok(())
}

fn open_core(env: &Env) -> Result<Core, VaultError> {
    let core = storage::core(env)?;
    if core.config.paused {
        return Err(VaultError::Paused);
    }
    Ok(core)
}

fn require_positive(amount: i128) -> Result<(), VaultError> {
    if amount <= 0 {
        return Err(VaultError::InvalidAmount);
    }
    Ok(())
}

fn apply_credit(core: &mut Core, account: &mut Subaccount, amount: i128) -> Result<(), VaultError> {
    require_positive(amount)?;
    account.balance = account
        .balance
        .checked_add(amount)
        .ok_or(VaultError::Overflow)?;
    core.liabilities = core
        .liabilities
        .checked_add(amount)
        .ok_or(VaultError::Overflow)?;
    Ok(())
}

fn fund_credit(
    env: &Env,
    core: &mut Core,
    account: &mut Subaccount,
    payer: Option<&Address>,
    amount: i128,
) -> Result<(), VaultError> {
    let asset = core.config.asset.clone();
    let before = token::check_reserve(env, &asset, core.liabilities)?;
    apply_credit(core, account, amount)?;
    let expected = before.checked_add(amount).ok_or(VaultError::Overflow)?;
    token::transfer(
        env,
        &asset,
        payer.unwrap_or(&account.owner),
        &env.current_contract_address(),
        amount,
    );
    if token::reserve(env, &asset) != expected {
        return Err(VaultError::UnexpectedReserve);
    }
    Ok(())
}

fn require_unused(env: &Env, reference: &BytesN<32>) -> Result<(), VaultError> {
    if storage::receipt(env, reference.clone()).is_some() {
        return Err(VaultError::DuplicateReference);
    }
    Ok(())
}

fn record_settlement(
    env: &Env,
    kind: SettlementKind,
    customer_id: u64,
    amount: i128,
    reference: BytesN<32>,
) {
    let receipt = Receipt {
        kind,
        customer_id,
        amount,
        ledger: env.ledger().sequence(),
    };
    storage::save_receipt(env, reference.clone(), &receipt);
    events::Settled {
        customer_id,
        reference,
        kind,
        amount,
    }
    .publish(env);
}

#[cfg(test)]
mod test;
