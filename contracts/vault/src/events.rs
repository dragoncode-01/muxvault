use soroban_sdk::{contractevent, Address, BytesN};

use crate::SettlementKind;

#[contractevent]
pub(crate) struct Registered {
    #[topic]
    pub customer_id: u64,
    pub owner: Address,
}

#[contractevent]
pub(crate) struct Deposited {
    #[topic]
    pub customer_id: u64,
    pub amount: i128,
}

#[contractevent]
pub(crate) struct Settled {
    #[topic]
    pub customer_id: u64,
    pub reference: BytesN<32>,
    pub kind: SettlementKind,
    pub amount: i128,
}

#[contractevent]
pub(crate) struct Withdrawn {
    #[topic]
    pub customer_id: u64,
    pub recipient: Address,
    pub amount: i128,
}

#[contractevent]
pub(crate) struct PauseChanged {
    pub actor: Address,
    pub paused: bool,
}

#[contractevent]
pub(crate) struct OwnerRotated {
    #[topic]
    pub customer_id: u64,
    pub owner: Address,
}

#[contractevent]
pub(crate) struct Deactivated {
    #[topic]
    pub customer_id: u64,
}

#[contractevent]
pub(crate) struct SignersChanged {
    pub funding: Address,
    pub external_w: Option<Address>,
}
