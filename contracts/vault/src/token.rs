use soroban_sdk::{token::StellarAssetClient, Address, Env};

use crate::VaultError;

pub(crate) fn reserve(env: &Env, asset: &Address) -> i128 {
    StellarAssetClient::new(env, asset).balance(&env.current_contract_address())
}

pub(crate) fn spendable(env: &Env, asset: &Address) -> bool {
    StellarAssetClient::new(env, asset).authorized(&env.current_contract_address())
}

pub(crate) fn check_reserve(
    env: &Env,
    asset: &Address,
    liabilities: i128,
) -> Result<i128, VaultError> {
    let balance = reserve(env, asset);
    if balance < liabilities {
        return Err(VaultError::Underfunded);
    }
    if !spendable(env, asset) {
        return Err(VaultError::AssetFrozen);
    }
    Ok(balance)
}

pub(crate) fn transfer(env: &Env, asset: &Address, from: &Address, to: &Address, amount: i128) {
    StellarAssetClient::new(env, asset).transfer(from, to, &amount);
}
