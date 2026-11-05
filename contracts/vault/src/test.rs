use soroban_sdk::{
    testutils::{storage::Persistent as _, Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::StellarAssetClient,
    xdr::{Limits, WriteXdr},
    Bytes, IntoVal,
};

use super::*;

struct Fixture {
    env: Env,
    vault: Address,
    asset: Address,
    issuer_admin: Address,
    admin: Address,
    guardian: Address,
    funder: Address,
    w_signer: Address,
    alice: Address,
    bob: Address,
}

impl Fixture {
    fn new() -> Self {
        let env = Env::default();
        env.ledger().set_sequence_number(100);
        let issuer_admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(issuer_admin.clone());
        let asset = sac.address();
        sac.issuer()
            .set_flag(soroban_sdk::xdr::AccountFlags::RevocableFlag);
        sac.issuer()
            .set_flag(soroban_sdk::xdr::AccountFlags::ClawbackEnabledFlag);
        let xdr = sac.asset().to_xdr(Limits::none()).unwrap();
        let admin = Address::generate(&env);
        let funder = Address::generate(&env);
        let guardian = Address::generate(&env);
        let vault = env.register(
            MuxVault,
            (
                admin.clone(),
                Bytes::from_slice(&env, &xdr),
                funder.clone(),
                guardian.clone(),
            ),
        );
        let fixture = Self {
            vault,
            asset,
            issuer_admin,
            admin,
            guardian,
            funder,
            w_signer: Address::generate(&env),
            alice: Address::generate(&env),
            bob: Address::generate(&env),
            env,
        };
        fixture.env.mock_all_auths();
        for account in [&fixture.alice, &fixture.bob, &fixture.funder] {
            fixture.token().mint(account, &1_000);
        }
        fixture
    }

    fn client(&self) -> MuxVaultClient<'_> {
        MuxVaultClient::new(&self.env, &self.vault)
    }

    fn token(&self) -> StellarAssetClient<'_> {
        StellarAssetClient::new(&self.env, &self.asset)
    }

    fn reference(&self, value: u8) -> BytesN<32> {
        BytesN::from_array(&self.env, &[value; 32])
    }

    fn snapshot(&self, id: u64) -> (i128, i128, i128, i128, i128) {
        (
            self.client().balance_of(&id),
            self.client().total_liabilities(),
            self.client().actual_reserve(),
            self.token().balance(&self.alice),
            self.token().balance(&self.funder),
        )
    }
}

#[test]
fn atomic_accounting_and_funding_replay() {
    let f = Fixture::new();
    let vault = f.client();
    let alice_id = vault.register_subaccount(&f.alice);
    let bob_id = vault.register_subaccount(&f.bob);
    assert_eq!((alice_id, bob_id), (1, 2));
    assert_eq!(vault.config().asset, f.asset);
    vault.deposit(&alice_id, &100);
    vault.anchor_deposit_for(&bob_id, &40, &f.reference(1));
    assert_eq!(
        vault.settlement_receipt(&f.reference(1)).unwrap().kind,
        SettlementKind::Anchor
    );
    assert_eq!(
        vault.try_anchor_deposit_for(&alice_id, &5, &f.reference(1)),
        Err(Ok(VaultError::DuplicateReference))
    );
    vault.withdraw(&alice_id, &f.bob, &30);
    assert_eq!(vault.balance_of(&alice_id), 70);
    assert_eq!(vault.balance_of(&bob_id), 40);
    assert_eq!(f.token().balance(&f.bob), 1_030);
    assert_eq!(vault.health().liabilities, 110);
    assert_eq!(vault.actual_reserve(), 110);
}

#[test]
fn failures_leave_token_balances_liabilities_and_references_unchanged() {
    let f = Fixture::new();
    let vault = f.client();
    let id = vault.register_subaccount(&f.alice);
    vault.deposit(&id, &100);
    let before = f.snapshot(id);
    assert!(vault.try_deposit(&id, &1_001).is_err());
    assert!(vault
        .try_anchor_deposit_for(&id, &1_001, &f.reference(1))
        .is_err());
    assert_eq!(vault.settlement_receipt(&f.reference(1)), None);
    assert_eq!(
        vault.try_deposit(&id, &0),
        Err(Ok(VaultError::InvalidAmount))
    );
    assert_eq!(
        vault.try_deposit(&id, &-1),
        Err(Ok(VaultError::InvalidAmount))
    );
    assert_eq!(
        vault.try_deposit(&id, &i128::MAX),
        Err(Ok(VaultError::Overflow))
    );
    assert_eq!(
        vault.try_withdraw(&id, &f.bob, &101),
        Err(Ok(VaultError::InsufficientBalance))
    );
    assert_eq!(
        vault.try_withdraw(&id, &f.vault, &1),
        Err(Ok(VaultError::InvalidAddress))
    );
    f.token().set_authorized(&f.bob, &false);
    assert!(vault.try_withdraw(&id, &f.bob, &10).is_err());
    assert_eq!(f.snapshot(id), before);
    vault.anchor_deposit_for(&id, &10, &f.reference(1));
    assert_eq!(vault.balance_of(&id), 110);
}

#[test]
fn owner_auth_commits_to_recipient_amount_and_customer() {
    let f = Fixture::new();
    let vault = f.client();
    let id = vault.register_subaccount(&f.alice);
    let other_id = vault.register_subaccount(&f.bob);
    vault.deposit(&id, &100);
    vault.deposit(&other_id, &40);

    let invocation = MockAuthInvoke {
        contract: &f.vault,
        fn_name: "withdraw",
        args: (id, &f.bob, 10_i128).into_val(&f.env),
        sub_invokes: &[],
    };
    for unauthorized in [&f.admin, &f.guardian, &f.funder, &f.w_signer, &f.bob] {
        f.env.mock_auths(&[MockAuth {
            address: unauthorized,
            invoke: &invocation,
        }]);
        assert!(vault.try_withdraw(&id, &f.bob, &10).is_err());
    }
    f.env.mock_auths(&[MockAuth {
        address: &f.alice,
        invoke: &invocation,
    }]);
    assert!(vault.try_withdraw(&id, &f.funder, &10).is_err());
    f.env.mock_auths(&[MockAuth {
        address: &f.alice,
        invoke: &invocation,
    }]);
    assert!(vault.try_withdraw(&id, &f.bob, &11).is_err());
    f.env.mock_auths(&[MockAuth {
        address: &f.alice,
        invoke: &invocation,
    }]);
    assert!(vault.try_withdraw(&other_id, &f.bob, &10).is_err());
    f.env.mock_auths(&[MockAuth {
        address: &f.alice,
        invoke: &invocation,
    }]);
    vault.withdraw(&id, &f.bob, &10);
    assert_eq!(vault.balance_of(&id), 90);
    assert_eq!(vault.balance_of(&other_id), 40);
}

#[test]
fn guardian_pauses_and_only_admin_resumes() {
    let f = Fixture::new();
    let vault = f.client();
    let id = vault.register_subaccount(&f.alice);
    vault.deposit(&id, &100);
    let pause = MockAuthInvoke {
        contract: &f.vault,
        fn_name: "pause",
        args: (&f.guardian,).into_val(&f.env),
        sub_invokes: &[],
    };
    f.env.mock_auths(&[MockAuth {
        address: &f.guardian,
        invoke: &pause,
    }]);
    vault.pause(&f.guardian);
    assert_eq!(vault.try_deposit(&id, &1), Err(Ok(VaultError::Paused)));
    assert_eq!(
        vault.try_withdraw(&id, &f.alice, &1),
        Err(Ok(VaultError::Paused))
    );
    assert_eq!(
        vault.try_anchor_deposit_for(&id, &1, &f.reference(1)),
        Err(Ok(VaultError::Paused))
    );

    let resume = MockAuthInvoke {
        contract: &f.vault,
        fn_name: "resume",
        args: ().into_val(&f.env),
        sub_invokes: &[],
    };
    f.env.mock_auths(&[MockAuth {
        address: &f.guardian,
        invoke: &resume,
    }]);
    assert!(vault.try_resume().is_err());
    f.env.mock_auths(&[MockAuth {
        address: &f.admin,
        invoke: &resume,
    }]);
    vault.resume();
    assert!(!vault.health().paused);
}

#[test]
fn issuer_freeze_and_clawback_fail_closed() {
    let f = Fixture::new();
    let vault = f.client();
    assert_eq!(f.token().admin(), f.issuer_admin);
    let id = vault.register_subaccount(&f.alice);
    vault.deposit(&id, &100);
    f.token().set_authorized(&f.vault, &false);
    assert!(!vault.health().asset_authorized);
    assert_eq!(vault.try_deposit(&id, &1), Err(Ok(VaultError::AssetFrozen)));
    assert_eq!(
        vault.try_withdraw(&id, &f.alice, &1),
        Err(Ok(VaultError::AssetFrozen))
    );
    f.token().set_authorized(&f.vault, &true);
    f.token().clawback(&f.vault, &20);
    assert!(!vault.health().healthy);
    assert_eq!(vault.actual_reserve(), 80);
    assert_eq!(vault.try_deposit(&id, &1), Err(Ok(VaultError::Underfunded)));
    assert_eq!(
        vault.try_withdraw(&id, &f.alice, &1),
        Err(Ok(VaultError::Underfunded))
    );
    assert_eq!(vault.balance_of(&id), 100);
    f.token().transfer(&f.funder, &f.vault, &20);
    assert!(vault.health().healthy);
}

#[test]
fn w_credit_is_disabled_by_default_and_requires_prior_registration_and_surplus() {
    let f = Fixture::new();
    let vault = f.client();
    let id = vault.register_subaccount(&f.alice);
    f.env.ledger().set_sequence_number(102);
    assert_eq!(
        vault.try_settle_external_w_deposit(&id, &20, &101, &f.reference(1)),
        Err(Ok(VaultError::WSettlementDisabled))
    );
    assert_eq!(
        vault.try_set_settlement_signers(&f.funder, &Some(f.funder.clone())),
        Err(Ok(VaultError::InvalidRole))
    );
    vault.set_settlement_signers(&f.funder, &Some(f.w_signer.clone()));
    assert_eq!(
        vault.try_settle_external_w_deposit(&id, &20, &100, &f.reference(1)),
        Err(Ok(VaultError::InvalidEventLedger))
    );
    assert_eq!(
        vault.try_settle_external_w_deposit(&id, &20, &101, &f.reference(1)),
        Err(Ok(VaultError::Underfunded))
    );
    f.token().transfer(&f.funder, &f.vault, &30);
    let settle = MockAuthInvoke {
        contract: &f.vault,
        fn_name: "settle_external_w_deposit",
        args: (id, 20_i128, 101_u32, f.reference(1)).into_val(&f.env),
        sub_invokes: &[],
    };
    f.env.mock_auths(&[MockAuth {
        address: &f.funder,
        invoke: &settle,
    }]);
    assert!(vault
        .try_settle_external_w_deposit(&id, &20, &101, &f.reference(1))
        .is_err());
    f.env.mock_auths(&[MockAuth {
        address: &f.w_signer,
        invoke: &settle,
    }]);
    vault.settle_external_w_deposit(&id, &20, &101, &f.reference(1));
    f.env.mock_all_auths();
    assert_eq!(
        vault.try_anchor_deposit_for(&id, &1, &f.reference(1)),
        Err(Ok(VaultError::DuplicateReference))
    );
    assert_eq!(
        vault.settlement_receipt(&f.reference(1)).unwrap().kind,
        SettlementKind::ExternalW
    );
    assert_eq!(vault.balance_of(&id), 20);
    assert_eq!(vault.actual_reserve(), 30);
}

#[test]
fn owners_rotate_with_consent_and_admin_cannot_disable_a_balance() {
    let f = Fixture::new();
    let vault = f.client();
    let id = vault.register_subaccount(&f.alice);
    vault.deposit(&id, &100);
    assert_eq!(
        vault.try_deactivate(&id),
        Err(Ok(VaultError::NonzeroBalance))
    );
    let rotate = MockAuthInvoke {
        contract: &f.vault,
        fn_name: "rotate_owner",
        args: (id, &f.bob).into_val(&f.env),
        sub_invokes: &[],
    };
    f.env.mock_auths(&[MockAuth {
        address: &f.alice,
        invoke: &rotate,
    }]);
    assert!(vault.try_rotate_owner(&id, &f.bob).is_err());
    f.env.mock_auths(&[
        MockAuth {
            address: &f.alice,
            invoke: &rotate,
        },
        MockAuth {
            address: &f.bob,
            invoke: &rotate,
        },
    ]);
    vault.rotate_owner(&id, &f.bob);
    assert_eq!(vault.subaccount(&id).unwrap().owner, f.bob);

    f.env.mock_all_auths();
    vault.withdraw(&id, &f.bob, &100);
    vault.deactivate(&id);
    assert_eq!(
        vault.try_deposit(&id, &1),
        Err(Ok(VaultError::InactiveCustomer))
    );
    assert_eq!(vault.register_subaccount(&f.alice), id + 1);
    vault.keep_alive(&Some(id), &None);
    assert!(!vault.subaccount(&id).unwrap().active);
}

#[test]
fn maintenance_extends_existing_customer_and_receipt_ttl() {
    let f = Fixture::new();
    let vault = f.client();
    let id = vault.register_subaccount(&f.alice);
    let reference = f.reference(1);
    vault.anchor_deposit_for(&id, &10, &reference);
    let ttl = |key| {
        f.env
            .as_contract(&f.vault, || f.env.storage().persistent().get_ttl(key))
    };
    let customer = Key::Customer(id);
    let receipt = Key::Reference(reference.clone());
    let extension = ttl(&customer) * 3 / 4;
    f.env.ledger().set_sequence_number(100 + extension);
    let before = (ttl(&customer), ttl(&receipt));
    vault.keep_alive(&Some(id), &Some(reference.clone()));
    assert!(ttl(&customer) > before.0);
    assert!(ttl(&receipt) > before.1);
    assert_eq!(vault.settlement_receipt(&reference).unwrap().amount, 10);
}

#[test]
fn seeded_sequences_preserve_accounting() {
    for seed in 1_u64..=4 {
        let f = Fixture::new();
        let vault = f.client();
        let ids = [
            vault.register_subaccount(&f.alice),
            vault.register_subaccount(&f.bob),
        ];
        let mut random = seed;
        let mut balances = [0_i128; 2];
        let mut paused = false;
        for step in 0..24 {
            random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
            let index = ((random >> 32) % 2) as usize;
            let amount = ((random >> 40) % 25) as i128 + 1;
            let id = ids[index];
            match (random >> 48) % 5 {
                0 if !paused => {
                    vault.deposit(&id, &amount);
                    balances[index] += amount;
                }
                1 if !paused && balances[index] >= amount => {
                    vault.withdraw(&id, &f.bob, &amount);
                    balances[index] -= amount;
                }
                2 if !paused => {
                    let reference = f.reference(step);
                    vault.anchor_deposit_for(&id, &amount, &reference);
                    assert_eq!(
                        vault.try_anchor_deposit_for(&id, &amount, &reference),
                        Err(Ok(VaultError::DuplicateReference))
                    );
                    balances[index] += amount;
                }
                3 => {
                    vault.pause(&f.guardian);
                    paused = true;
                }
                4 => {
                    vault.resume();
                    paused = false;
                }
                _ => {
                    let before = f.snapshot(id);
                    assert!(vault.try_withdraw(&id, &f.bob, &amount).is_err());
                    assert_eq!(f.snapshot(id), before);
                }
            }
            assert_eq!(vault.balance_of(&ids[0]), balances[0]);
            assert_eq!(vault.balance_of(&ids[1]), balances[1]);
            assert_eq!(vault.total_liabilities(), balances[0] + balances[1]);
            assert_eq!(vault.actual_reserve(), vault.total_liabilities());
        }
    }
}
