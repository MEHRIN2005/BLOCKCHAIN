const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const { startChain } = require("../src/chain");
const { registerEvidence, ContentStore } = require("../src/evidence");
const { ethers } = require("ethers");
const os = require("os");
const fs = require("fs");
const path = require("path");

const SCOPE = { METADATA: 1, HASH: 2, FILE: 4 };

/**
 * Assert that a contract call reverts with a reason matching `regex`.
 * Ganache drops the revert reason during gas estimation, so the reason is read
 * with a static call (eth_call), which Ganache does report.
 */
async function reverts(contract, signer, method, args, regex) {
  let sent = false;
  try {
    await (await contract.connect(signer)[method](...args)).wait();
    sent = true;
  } catch (_) {}
  assert.equal(sent, false, `${method} should have reverted`);
  const reason = await contract.connect(signer)[method].staticCall(...args).then(
    () => "no revert",
    (e) => String(e.reason || e.shortMessage || e.message)
  );
  assert.match(reason, regex);
}

let chain, store, c, S;

const sample = Buffer.from("Disk image of suspect laptop, sector dump 0001-0500 (synthetic test data)");

before(async () => {
  chain = await startChain();
  S = chain.signers;
  c = chain.contracts;
  store = new ContentStore(fs.mkdtempSync(path.join(os.tmpdir(), "custody-")));
});
after(() => chain && chain.close());

describe("Evidence layer (registration and tamper check)", () => {
  let reg;
  before(async () => {
    reg = await registerEvidence({ registry: c.registry, signer: S[1], store, buffer: sample, caseId: "CASE-2026-001" });
  });

  test("registered evidence records hash, CID and custodian", async () => {
    const e = await c.registry.getEvidence(reg.evidenceId);
    assert.equal(e.sha256Hash, "0x" + reg.sha256);
    assert.equal(e.cid, reg.cid);
    assert.equal(e.custodian, S[1].address);
    assert.equal(e.caseId, "CASE-2026-001");
  });

  test("original file verifies against the chain", async () => {
    const retrieved = store.get(reg.cid);
    const hash = "0x" + ContentStore.sha256Hex(retrieved);
    assert.equal(await c.registry.verify(reg.evidenceId, hash), true);
  });

  test("altered file fails verification (tamper detected)", async () => {
    const tampered = Buffer.from(sample);
    tampered[10] ^= 0xff;
    const hash = "0x" + ContentStore.sha256Hex(tampered);
    assert.equal(await c.registry.verify(reg.evidenceId, hash), false);
  });

  test("unauthorised account cannot register evidence", async () => {
    await reverts(c.registry, S[5], "register", [ethers.id("x-id"), "0x" + "11".repeat(32), "cid-x", "CASE-X"], /not an investigator/);
  });

  test("duplicate evidence ID is rejected", async () => {
    await reverts(c.registry, S[1], "register", [reg.evidenceId, "0x" + reg.sha256, reg.cid, "CASE-2026-001"], /evidence exists/);
  });
});

describe("Transfer management (dual approval)", () => {
  let evidenceId;
  before(async () => {
    ({ evidenceId } = await registerEvidence({ registry: c.registry, signer: S[1], store, buffer: Buffer.from("phone image"), caseId: "CASE-T" }));
  });

  test("non-custodian cannot request a transfer", async () => {
    await reverts(c.transfers, S[2], "requestTransfer", [evidenceId, S[3].address, "handover"], /caller is not custodian/);
  });

  test("receiver must be authorised", async () => {
    await reverts(c.transfers, S[1], "requestTransfer", [evidenceId, S[5].address, "handover"], /receiver not an investigator/);
  });

  test("requester cannot approve their own transfer", async () => {
    await (await c.transfers.connect(S[1]).requestTransfer(evidenceId, S[2].address, "to lab")).wait();
    await reverts(c.transfers, S[1], "approveTransfer", [1], /not a supervisor/);
  });

  test("receiver cannot accept before supervisor approval", async () => {
    await reverts(c.transfers, S[2], "completeTransfer", [1], /not approved/);
  });

  test("supervisor approval then receiver acceptance moves custody", async () => {
    await (await c.transfers.connect(S[4]).approveTransfer(1)).wait();
    await (await c.transfers.connect(S[2]).completeTransfer(1)).wait();
    assert.equal(await c.registry.custodianOf(evidenceId), S[2].address);
  });

  test("a completed transfer cannot be approved again", async () => {
    await reverts(c.transfers, S[4], "approveTransfer", [1], /not pending/);
  });

  test("requester can cancel a pending transfer", async () => {
    await (await c.transfers.connect(S[2]).requestTransfer(evidenceId, S[3].address, "to court")).wait();
    await (await c.transfers.connect(S[2]).cancelTransfer(2)).wait();
    assert.equal(await c.registry.custodianOf(evidenceId), S[2].address);
  });

  test("emergency transfer needs a supervisor and a reason, and moves custody", async () => {
    await reverts(c.transfers, S[1], "emergencyTransfer", [evidenceId, S[3].address, "urgent"], /not a supervisor/);
    await reverts(c.transfers, S[4], "emergencyTransfer", [evidenceId, S[3].address, ""], /reason required/);
    await (await c.transfers.connect(S[4]).emergencyTransfer(evidenceId, S[3].address, "live court order")).wait();
    assert.equal(await c.registry.custodianOf(evidenceId), S[3].address);
  });
});

describe("Sharing protocol (cross-agency, selective disclosure)", () => {
  let evidenceId;
  before(async () => {
    ({ evidenceId } = await registerEvidence({ registry: c.registry, signer: S[1], store, buffer: Buffer.from("email export"), caseId: "CASE-S" }));
  });

  test("only the custodian can grant access", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    await reverts(c.sharing, S[2], "grantAccess", [evidenceId, S[3].address, SCOPE.HASH, exp], /not custodian/);
  });

  test("grant with HASH scope allows hash checks but not file retrieval", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    await (await c.sharing.connect(S[1]).grantAccess(evidenceId, S[3].address, SCOPE.HASH, exp)).wait();
    assert.equal(await c.sharing.hasScope(evidenceId, S[3].address, SCOPE.HASH), true);
    assert.equal(await c.sharing.hasScope(evidenceId, S[3].address, SCOPE.FILE), false);
  });

  test("agency use is logged in the custody chain", async () => {
    await (await c.sharing.connect(S[3]).useAccess(evidenceId, SCOPE.HASH)).wait();
    const n = await c.registry.custodyLength(evidenceId);
    const last = await c.registry.getCustodyEvent(evidenceId, n - 1n);
    assert.equal(last.action, 7n); // AccessUsed
    assert.equal(last.from, S[3].address);
  });

  test("access without a scope is denied", async () => {
    await reverts(c.sharing, S[3], "useAccess", [evidenceId, SCOPE.FILE], /access denied/);
  });

  test("expired grant is denied", async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    await (await c.sharing.connect(S[1]).grantAccess(evidenceId, S[2].address, SCOPE.METADATA, exp)).wait();
    await chain.evm("evm_increaseTime", [120]);
    await chain.evm("evm_mine", []);
    assert.equal(await c.sharing.hasScope(evidenceId, S[2].address, SCOPE.METADATA), false);
  });

  test("revoked grant is denied", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    await (await c.sharing.connect(S[1]).grantAccess(evidenceId, S[2].address, SCOPE.FILE, exp)).wait();
    await (await c.sharing.connect(S[1]).revokeAccess(evidenceId, S[2].address)).wait();
    assert.equal(await c.sharing.hasScope(evidenceId, S[2].address, SCOPE.FILE), false);
  });
});

describe("Chain of custody log", () => {
  test("events are stored in order with the expected action sequence", async () => {
    const { evidenceId } = await registerEvidence({ registry: c.registry, signer: S[1], store, buffer: Buffer.from("seq test"), caseId: "CASE-L" });
    await (await c.transfers.connect(S[1]).requestTransfer(evidenceId, S[2].address, "lab")).wait();
    await (await c.transfers.connect(S[4]).approveTransfer(await c.transfers.nextTransferId() - 1n)).wait();
    await (await c.transfers.connect(S[2]).completeTransfer(await c.transfers.nextTransferId() - 1n)).wait();
    const n = Number(await c.registry.custodyLength(evidenceId));
    const actions = [];
    for (let i = 0; i < n; i++) actions.push(Number((await c.registry.getCustodyEvent(evidenceId, i)).action));
    assert.deepEqual(actions, [0, 1, 2, 3]); // Registered, Requested, Approved, Transferred
  });
});
