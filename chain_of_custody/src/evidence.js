const { ethers } = require("ethers");
const { ContentStore } = require("./store");

/** Build the bytes32 evidence ID the way the paper's Evidence Layer does: unique per case and file. */
function makeEvidenceId(caseId, sha256Hex) {
  return ethers.solidityPackedKeccak256(
    ["string", "bytes32", "uint256", "uint256"],
    [caseId, "0x" + sha256Hex, Date.now(), Math.floor(Math.random() * 1e9)]
  );
}

/**
 * Wait for a receipt by polling eth_getTransactionReceipt directly.
 * ethers' tx.wait() can stall under heavy parallel submission on Ganache, so this
 * uses an explicit poll with a timeout instead.
 */
async function waitForReceipt(provider, hash, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await provider.getTransactionReceipt(hash);
    if (r) {
      if (r.status !== 1) throw new Error("transaction failed: " + hash);
      return r;
    }
    if (Date.now() > deadline) throw new Error("receipt timeout: " + hash);
    await new Promise((res) => setTimeout(res, 50));
  }
}

/** Register a file: store off-chain, anchor hash + CID on-chain, return the ids used. */
async function registerEvidence({ registry, signer, store, buffer, caseId, nonce }) {
  const { cid, sha256 } = store.put(buffer);
  const evidenceId = makeEvidenceId(caseId, sha256);
  // Optional explicit nonce/gas: used by parallel load tests to avoid ethers' per-call RPC lookups.
  const overrides = nonce === undefined ? {} : { nonce, gasLimit: 500000n, gasPrice: 1000000000n, type: 0 };
  const tx = await registry.connect(signer).register(evidenceId, "0x" + sha256, cid, caseId, overrides);
  const receipt = await waitForReceipt(tx.provider, tx.hash);
  return { evidenceId, cid, sha256, txHash: receipt.hash, receipt };
}

module.exports = { registerEvidence, makeEvidenceId, waitForReceipt, ContentStore };
