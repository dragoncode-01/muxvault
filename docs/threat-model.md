# MuxVault threat model

## Authorities

| Role | Authority | Operational dependency |
| --- | --- | --- |
| Customer owner | Register, deposit, withdraw, and consent to owner rotation | The owner controls the Stellar account or Soroban authorization contract |
| Admin | Change settlement signers, pause, resume, and deactivate empty IDs | The admin can interrupt availability |
| Guardian | Pause credits and withdrawals | Resume requires the admin |
| Funding signer | Credit a customer while transferring its own SAC funds | Partner must verify fiat readiness and route the payment correctly |
| W settlement signer | Assign observed direct transfers from the existing reserve surplus | Correct historical evidence, amount, event ledger, and customer mapping |
| SAC issuer | Apply the configured authorization and clawback powers | Vault availability and reserve coverage depend on issuer controls |

The vault exposes no generic token invocation, asset replacement, reserve sweep, or unilateral owner change. A role address can own a customer ID only through that address's own registration and owner authorization.

## Accounting and failure modes

- Every successful credit or withdrawal changes one customer balance and total liabilities by the same amount. An atomic transfer failure rolls back both.
- Credits and withdrawals require reserve coverage and authorization. A frozen vault reports `asset_authorized=false`. A deficit prevents new credits and withdrawals until the reserve is restored.
- A receipt is written in the same transaction as its credit. Both settlement modes share the persistent reference namespace, so the same reference can be consumed only once.
- A direct W transfer raises pooled reserves. The vault cannot query Stellar RPC history. The W signer can misallocate available surplus by submitting false evidence or a new reference. Keep this role disabled until a trusted operator is ready. The reference CLI checks retained RPC evidence again before signing.
- Deposits for unknown, inactive, or same-ledger registrations remain in the reconciliation queue for review. Credits for same-ledger registration are rejected because the vault records the registration ledger without an intra-ledger ordering index.
- Administrator pause can temporarily lock withdrawals. A lost customer owner key requires recovery through that account's own policy. The vault rotation method requires both owner authorizations.
- Balances, addresses, and routing IDs are public on Stellar. Customer identity documents and anchor account records belong offchain.

The reserve check describes onchain SAC balances and recorded liabilities. Fiat receipt and partner solvency are separate offchain facts. Independent review, issuer vetting, governed role keys, archive recovery tests, and a real design partner are release gates for a mainnet pilot.
