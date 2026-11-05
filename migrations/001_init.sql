BEGIN;

CREATE TABLE IF NOT EXISTS watcher_checkpoint (
    network_id text NOT NULL,
    vault text NOT NULL,
    asset text NOT NULL,
    next_ledger bigint NOT NULL CHECK (next_ledger > 0),
    window_end bigint,
    cursor text,
    PRIMARY KEY (network_id, vault),
    CHECK ((window_end IS NULL) = (cursor IS NULL)),
    CHECK (window_end IS NULL OR window_end > next_ledger)
);

CREATE TABLE IF NOT EXISTS w_transfer (
    network_id text NOT NULL,
    vault text NOT NULL,
    asset text NOT NULL,
    event_id text NOT NULL,
    tx_hash text NOT NULL,
    operation_index integer NOT NULL CHECK (operation_index >= 0),
    event_index bigint NOT NULL CHECK (event_index >= 0),
    ledger bigint NOT NULL CHECK (ledger > 0),
    sender text NOT NULL,
    customer_id numeric(20, 0) NOT NULL CHECK (customer_id BETWEEN 0 AND 18446744073709551615),
    amount numeric(39, 0) NOT NULL CHECK (amount BETWEEN 1 AND 170141183460469231731687303715884105727),
    reference text NOT NULL,
    evidence jsonb NOT NULL,
    settlement_ledger bigint,
    settlement_tx_hash text,
    PRIMARY KEY (network_id, vault, event_id),
    UNIQUE (network_id, vault, tx_hash, operation_index, event_index),
    UNIQUE (network_id, vault, reference)
);

CREATE INDEX IF NOT EXISTS w_transfer_unallocated
    ON w_transfer (network_id, vault, ledger, event_id) WHERE settlement_ledger IS NULL;

CREATE TABLE IF NOT EXISTS anchor_payment (
    network_id text NOT NULL,
    vault text NOT NULL,
    asset text NOT NULL,
    namespace text NOT NULL,
    payment_id text NOT NULL,
    customer_id numeric(20, 0) NOT NULL CHECK (customer_id BETWEEN 1 AND 18446744073709551615),
    amount numeric(39, 0) NOT NULL CHECK (amount BETWEEN 1 AND 170141183460469231731687303715884105727),
    reference text NOT NULL,
    settlement_ledger bigint,
    settlement_tx_hash text,
    PRIMARY KEY (network_id, vault, namespace, payment_id),
    UNIQUE (network_id, vault, reference)
);

CREATE TABLE IF NOT EXISTS settlement_attempt (
    network_id text NOT NULL,
    vault text NOT NULL,
    reference text NOT NULL,
    tx_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (network_id, vault, reference, tx_hash)
);

COMMIT;
