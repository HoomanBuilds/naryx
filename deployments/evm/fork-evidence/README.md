# EVM fork evidence

This directory is reserved for reviewed Base and Arbitrum production-state fork qualification evidence.

Each evidence record must state:

- network and exact chain ID;
- pinned block number and block hash;
- dependency addresses and expected runtime code hashes;
- critical relationship checks performed;
- exact focused test command and result;
- whether any fork-local Naryx contracts or test balances were created;
- confirmation that no signer, broadcast, or production-state write path existed.

An evidence record is a dated observation. It is not a deployment manifest, a runtime source of truth, or authorization for a production transaction. Do not commit RPC URLs, credentials, keys, or environment files.
