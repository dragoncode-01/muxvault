use soroban_sdk::contracterror;

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VaultError {
    MissingState = 1,
    InvalidRole = 2,
    InvalidAddress = 3,
    UnknownCustomer = 4,
    InactiveCustomer = 5,
    InvalidAmount = 6,
    Overflow = 7,
    InsufficientBalance = 8,
    Paused = 9,
    Underfunded = 10,
    AssetFrozen = 11,
    UnexpectedReserve = 12,
    DuplicateReference = 13,
    WSettlementDisabled = 14,
    InvalidEventLedger = 15,
    NonzeroBalance = 16,
    UnknownReference = 17,
    InvalidAsset = 18,
}
