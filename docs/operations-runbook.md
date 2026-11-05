# MuxVault operations runbook

## Asset and network

Match the configured asset code and issuer to the network-specific SAC derived by `npm run operator -- asset-info CODE:ISSUER`. Verify the issuer account and its authorization, revocation, and clawback settings. Read vault `config` and `health` against the same RPC before accepting deposits. Use Testnet development keys for the reference commands.

Keep the W signer separate from the funding signer, guardian, and administrator. Use distinct process credentials for RPC and database access. The watcher runs without a signing seed. An operator invokes the W credit command only after reviewing an event.

## Pausing and restoring reserves

If the asset becomes frozen or the reserve drops below liabilities, record the health output and pause using the guardian or administrator. Coordinate issuer authorization recovery or replenish any shortfall with an untagged SAC transfer to the vault's base contract address. Confirm `healthy=true` before the administrator resumes. Replenishment changes reserve without minting a customer claim.

The paused flag blocks customer deposits, anchor deposits, W credits, and withdrawals. Read calls and TTL maintenance remain available while paused.

## Watcher cursor and reconciliation

Set `WATCH_START_LEDGER` to the deployment ledger for a new watcher. A restart uses the stored checkpoint for the vault and network. Run `npm run watch -- --once` to process one page. Repeating a page deduplicates its observations. Check logs for ledger lag, conflicting evidence, and missing history.

If the oldest retained RPC ledger advances beyond the checkpoint, the watcher stops. Backfill the gap using a trusted archive-backed Stellar ingest source before advancing the checkpoint. Preserve event IDs and transaction positions when importing. If a queued transfer is older than RPC retention, the reference command cannot recheck it. Recover the original evidence from a trusted archive before a governed manual attestation.

Review each W transfer's asset, sender, vault, ID, ledger, hash, and amount. Unknown or inactive IDs and transfers at or before registration need an operator investigation. Record the event position when reporting a routing incident. A settlement retry can recover its ledger from the onchain receipt even if RPC transaction history has aged out and the successful hash cannot be recovered from the journal.

Use the same anchor namespace and payment ID on every retry. Use `health`, the receipt, and the journal to distinguish an unpaid intent from a paid but unrecorded transaction. Query the transaction hash printed on a submission timeout before retrying a regular customer deposit or withdrawal.

## Contract storage

Mutations extend the core or customer entries they write. Settlement writes also extend the reference TTL. Use `npm run operator -- keep-alive ID_OR_DASH REFERENCE_OR_DASH` to extend selected existing records, core, instance, and WASM code. Keep a list of customer IDs and receipt references from ledger events. Monitor entry TTLs and keep a transaction budget for maintenance.

Core, customers, and receipts use persistent storage and are archived when their TTL expires. Use the supported RPC simulation and Stellar CLI restoration path to recover archived entries. Never treat an archived receipt as an unused reference. Before accepting real value, test archival and restoration for the vault's WASM, core, subaccounts, receipts, and the SAC balance entry on a network configured for archival. [Restore contract storage](https://developers.stellar.org/docs/tools/cli/cookbook/restore-contract-storage)

Back up the database and deployment manifest. Offchain recovery rebuilds observations from ledger events and confirms settlement status against the vault. Customer ownership and balances come from the contract.
