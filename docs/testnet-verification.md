# Testnet verification

The dashboard was exercised on Stellar Testnet with a new browser-generated wallet. Friendbot funded the wallet, and the vault registered customer ID 1. The dashboard then confirmed a 2 XLM deposit and a 0.5 XLM withdrawal back to the same wallet. Its subaccount balance displayed 1.50 XLM.

| Operation | Ledger | Testnet transaction |
| --- | --- | --- |
| Register subaccount 1 | 5576992 | [Registration](https://stellar.expert/explorer/testnet/tx/eaea60950e9ba08220fc62642be9b5af44fa4f4341b362fcbaf19479f7786f81) |
| Deposit 2 XLM | 5577006 | [Deposit](https://stellar.expert/explorer/testnet/tx/9117d99aa7867544d5693e69a458c54070f820f646b5b20a8ef34c9aff77aac2) |
| Withdraw 0.5 XLM | 5577013 | [Withdrawal](https://stellar.expert/explorer/testnet/tx/6043ccab2978f532b110ff9ff1092301b6edc21222402086a00be16a6caa88a6) |

[Deployment manifest](testnet-deployment.json) records the exact vault, native asset contract, and WASM hash. The explorer links are for Stellar Testnet.

## Operator verification

The mock anchor deposited 0.30 XLM. A second submission returned the same receipt. The W transfer left the customer balance unchanged until the watcher indexed it and the separate settlement signer credited it. Reingesting the event produced one PostgreSQL row, and repeating settlement returned the same receipt.

| Operation | Ledger | Testnet transaction |
| --- | --- | --- |
| Mock anchor credit of 0.30 XLM | 5577012 | [View transaction](https://stellar.expert/explorer/testnet/tx/1c0c97b5e7de70fc87005126dd54b5a3d7ac39a9a75ec4419f26fc47ebe65b18) |
| Direct W-address transfer of 0.10 XLM | 5577035 | [View transaction](https://stellar.expert/explorer/testnet/tx/4c567c95398e6e95b941d6ff6a336ca0b88c5d5c40e8a91180ecbfde3db9e8b4) |
| Reconciled W credit of 0.10 XLM | 5577062 | [View transaction](https://stellar.expert/explorer/testnet/tx/237bdca3620389d94a4525d217b4af3631b5fe0cf386de1eb59ed482004fde60) |
