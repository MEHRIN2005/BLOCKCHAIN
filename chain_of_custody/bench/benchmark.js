// Measures the three metrics the base paper reports: latency, throughput and transaction cost.
// Runs on a local Ganache chain (instant mining), so numbers reflect contract and client cost,
// not the network effects of a multi-node consortium.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startChain } = require("../src/chain");
const { registerEvidence, ContentStore } = require("../src/evidence");

const LATENCY_RUNS = 50;      // sequential registrations
const TRANSFER_RUNS = 20;    // full request -> approve -> accept cycles
const SIGNERS = 20;           // parallel investigators for throughput
const PER_SIGNER = 10;       // registrations per investigator

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

(async () => {
  const chain = await startChain({ benchAccounts: SIGNERS });
  const S = chain.signers, c = chain.contracts;
  const store = new ContentStore(fs.mkdtempSync(path.join(os.tmpdir(), "bench-")));
  const buf = (i) => Buffer.from(`evidence item ${i} ${Math.random()}`);
  const results = {};

  // 1. Latency and gas: registration, one at a time
  const regLat = [], regGas = [];
  for (let i = 0; i < LATENCY_RUNS; i++) {
    const t0 = process.hrtime.bigint();
    const r = await registerEvidence({ registry: c.registry, signer: S[1], store, buffer: buf(i), caseId: "BENCH-L" });
    regLat.push(Number(process.hrtime.bigint() - t0) / 1e6);
    regGas.push(Number(r.receipt.gasUsed));
  }
  results.registration = {
    runs: LATENCY_RUNS,
    meanLatencyMs: +mean(regLat).toFixed(2),
    p95LatencyMs: +pct(regLat, 95).toFixed(2),
    meanGas: Math.round(mean(regGas)),
  };

  // 2. Latency and gas: full dual-approval transfer cycle (3 transactions)
  const cycleLat = [], cycleGas = [];
  for (let i = 0; i < TRANSFER_RUNS; i++) {
    const { evidenceId } = await registerEvidence({ registry: c.registry, signer: S[1], store, buffer: buf("t" + i), caseId: "BENCH-T" });
    const t0 = process.hrtime.bigint();
    const id = (await c.transfers.nextTransferId());
    const r1 = await (await c.transfers.connect(S[1]).requestTransfer(evidenceId, S[2].address, "bench")).wait();
    const r2 = await (await c.transfers.connect(S[4]).approveTransfer(id)).wait();
    const r3 = await (await c.transfers.connect(S[2]).completeTransfer(id)).wait();
    cycleLat.push(Number(process.hrtime.bigint() - t0) / 1e6);
    cycleGas.push(Number(r1.gasUsed + r2.gasUsed + r3.gasUsed));
  }
  results.dualApprovalTransfer = {
    runs: TRANSFER_RUNS,
    meanLatencyMs: +mean(cycleLat).toFixed(2),
    p95LatencyMs: +pct(cycleLat, 95).toFixed(2),
    meanTotalGas: Math.round(mean(cycleGas)),
  };

  // 3. Throughput: many investigators submit in parallel. Nonces and gas are set explicitly
  // for this phase: ethers' default per-call lookups stall under heavy parallel submission on Ganache.
  const total = SIGNERS * PER_SIGNER;
  const par = S.slice(6, 6 + SIGNERS);
  const bases = await Promise.all(par.map((s) => chain.provider.getTransactionCount(s.address, "latest")));
  const t0 = process.hrtime.bigint();
  await Promise.all(
    par.map(async (signer, k) => {
      for (let j = 0; j < PER_SIGNER; j++) {
        await registerEvidence({
          registry: c.registry, signer, store, buffer: buf(`p${k}-${j}`), caseId: "BENCH-P", nonce: bases[k] + j,
        });
      }
    })
  );
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  results.throughput = {
    transactions: total,
    signers: SIGNERS,
    seconds: +secs.toFixed(2),
    txPerSecond: +(total / secs).toFixed(2),
  };

  const out = path.join(__dirname, "results.json");
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  chain.close && chain.close();
  process.exit(0);
})().catch((e) => {
  console.error("BENCH FAILED:", e);
  process.exit(1);
});
