# Blockchain-Enhanced Chain of Custody: Implementation

Implementation of the design in *"Blockchain-Enhanced Chain of Custody for Digital Forensic
Evidence Management"* (ICBDS 2025, DOI 10.1109/ICBDS67396.2025.11379799), built on the stack
used in our project: Solidity smart contracts, a local Ethereum test chain (Ganache), and
content-addressed off-chain storage (IPFS-style CIDs).

## What the paper's design maps to

| Paper component | Implementation |
|---|---|
| Evidence Layer: SHA-256 hashing, unique IDs, on-chain registration | `EvidenceRegistry.register()`, `src/evidence.js` |
| Protocol Layer: contracts enforce custody rules, automatic logging | `EvidenceRegistry` custody log (append-only), written by modules |
| Access Layer: role-based permissions | `Roles.sol` (ADMIN, INVESTIGATOR, SUPERVISOR) |
| Evidence Registration Contract (verify structure, hash comparison) | `EvidenceRegistry.verify()` |
| Transfer Management Contract (dual approval, audit trail, emergency access) | `TransferManager.sol`: request, supervisor approval (not the requester), receiver acceptance, cancel, emergency transfer with mandatory reason |
| Sharing Protocol Contract (cross-jurisdiction access, selective disclosure) | `SharingProtocol.sol`: scoped grants (METADATA / HASH / FILE), expiry, revocation, logged use |
| External storage (IPFS): large files off-chain, anchored on-chain | `src/store.js` (CID derived from content), hash and CID stored on-chain |
| Metrics: latency, throughput, transaction cost | `bench/benchmark.js` |

## Deviations from the paper (and why)

1. **Ethereum (Ganache) instead of Hyperledger Fabric 2.4.** Our project uses Ethereum, and Fabric
   needs a multi-container network. The contracts follow the paper's three contract types and
   access model, and enforce the same rules on-chain.
2. **Single-chain prototype.** The paper's consortium (police, labs, courts) is simulated with
   separate accounts on one chain. A real deployment needs permissioned nodes per agency.
3. **Content store is local.** Files are kept in a local directory with CIDs derived from their
   bytes. Swap `src/store.js` for an IPFS client (e.g. Pinata) without changing callers.
4. **Metrics are measured here, not copied from the paper.** The paper reports 65% faster
   processing and 250-400 TPS from Hyperledger Composer. We did not reproduce those figures.

## Running

```bash
npm install
npm test                 # 20 tests: registration, tamper check, dual approval, sharing, custody log
npm run bench            # latency, throughput and gas figures, written to bench/results.json
```

Requirements: Node.js 18+ (tested on 22). Ganache prints a µWS fallback warning on this Node
version; it does not affect results.

## Layout

```
contracts/          Roles.sol, EvidenceRegistry.sol, TransferManager.sol, SharingProtocol.sol
src/compile.js      solc-js compiler (EVM target: shanghai, as supported by Ganache 7)
src/chain.js        starts Ganache, deploys and wires the contracts
src/store.js        off-chain content store (IPFS stand-in)
src/evidence.js     evidence registration helper
test/               node:test suite
bench/              benchmark script and results
```

## Notes from building it

- Solc 0.8.26 defaults to the Cancun EVM. Ganache 7 does not support Cancun opcodes, so
  `evmVersion` is set to `shanghai`.
- Ganache drops revert reasons during gas estimation. The tests read reasons with a static call.
- ethers polls for receipts every 4 s by default. The chain uses 300 ms, which keeps latency
  figures meaningful. Very short intervals (20 ms) hang on this Ganache version.

## Measured results (this sandbox, Ganache local chain)

Source: `bench/results.json`, produced by `npm run bench`.

| Metric | Result |
|---|---|
| Registration latency (50 runs, mean / p95) | 405.6 ms / 463.7 ms |
| Registration gas (mean) | 265,685 |
| Dual-approval transfer, 3 transactions (20 runs, mean / p95) | 1,305 ms / 1,480 ms |
| Dual-approval transfer gas, total (mean) | 497,807 |
| Throughput: 200 registrations from 20 investigators in parallel | 11.0 tx/s (18.2 s total) |

How to read these numbers:

- Latency includes the receipt-polling interval (300 ms for transfers; 50 ms for registrations).
  Real latency is lower than shown, by up to one polling interval per transaction.
- Throughput was measured with explicit nonces and gas. Under ethers' default per-call lookups,
  parallel submissions stalled on this Ganache build. The transactions themselves are unchanged.
- These are single-node figures. The paper's 250-400 TPS and "65% faster" claims come from a
  different platform (Hyperledger Composer) and a multi-agency setup. We do not reproduce them here.
