"use strict";
/**
 * Web interface for the chain-of-custody prototype.
 * Uses only Node's built-in http module plus the project's own src/ files,
 * so no extra packages are needed. Run:  node server.js   then open http://localhost:3000
 *
 * It starts the same local Ganache chain used by the tests, deploys the four contracts,
 * and exposes a small JSON API that the page in public/index.html calls.
 * The chain lives in memory: restarting the server starts a fresh chain.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { startChain } = require("./src/chain");
const { makeEvidenceId, waitForReceipt, ContentStore } = require("./src/evidence");

const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY = 30 * 1024 * 1024;

const ACTIONS = [
  "Registered", "TransferRequested", "TransferApproved", "Transferred", "EmergencyTransfer",
  "AccessGranted", "AccessRevoked", "AccessUsed", "TransferCancelled",
];
const TRANSFER_STATES = ["None", "Requested", "Approved", "Completed", "Cancelled"];
const SCOPES = { 1: "METADATA", 2: "HASH", 4: "FILE" };

// Account index = signer index in src/chain.js
const ACCOUNT_INFO = [
  { id: 1, name: "Police", role: "Investigator" },
  { id: 2, name: "Forensic Lab", role: "Investigator" },
  { id: 3, name: "Court", role: "Investigator" },
  { id: 4, name: "Supervisor", role: "Supervisor" },
  { id: 5, name: "Outsider", role: "No role" },
];

class UserError extends Error {}

let chain;
let store;
const registered = []; // { evidenceId, filename } in registration order

// One blockchain transaction at a time, so nonces never clash.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

function reasonOf(e) {
  const raw = String((e && (e.reason || e.shortMessage || e.message)) || e);
  return raw.replace(/^execution reverted:?\s*/i, "").replace(/^"|"$/g, "") || "Transaction rejected by the contract";
}

/** Run a contract call as one account. A static call first, so rule violations return their reason text. */
async function send(contract, account, method, args) {
  const c = contract.connect(chain.signers[account]);
  try {
    await c[method].staticCall(...args);
  } catch (e) {
    throw new UserError(reasonOf(e));
  }
  const tx = await c[method](...args);
  return waitForReceipt(chain.provider, tx.hash);
}

function needAccount(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new UserError("Choose which account is acting");
  return n;
}
function needId(v) {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new UserError("Select an evidence item first");
  return v;
}
function needBytes(b64) {
  if (typeof b64 !== "string" || b64.length === 0) throw new UserError("Choose a file or type some text first");
  const buf = Buffer.from(b64, "base64");
  if (buf.length === 0) throw new UserError("The file or text is empty");
  return buf;
}
function addrOf(i) {
  return chain.signers[i].address;
}

async function evidenceView(item) {
  const reg = chain.contracts.registry;
  const e = await reg.getEvidence(item.evidenceId);
  const n = await reg.custodyLength(item.evidenceId);
  return {
    evidenceId: item.evidenceId,
    filename: item.filename,
    sha256: e[0],
    cid: e[1],
    caseId: e[2],
    custodian: e[3],
    registeredBy: e[4],
    registeredAt: Number(e[5]),
    events: Number(n),
  };
}

async function custodyLog(evidenceId) {
  const reg = chain.contracts.registry;
  const n = Number(await reg.custodyLength(evidenceId));
  const out = [];
  for (let i = 0; i < n; i++) {
    const ev = await reg.getCustodyEvent(evidenceId, i);
    out.push({ action: ACTIONS[Number(ev[0])], from: ev[1], to: ev[2], timestamp: Number(ev[3]), note: ev[4] });
  }
  return out;
}

async function listTransfers(evidenceId) {
  const tm = chain.contracts.transfers;
  const next = Number(await tm.nextTransferId());
  const out = [];
  for (let i = 1; i < next; i++) {
    const t = await tm.transfers(i);
    if (evidenceId && String(t[0]).toLowerCase() !== evidenceId.toLowerCase()) continue;
    out.push({
      id: i, evidenceId: t[0], from: t[1], to: t[2], approver: t[3],
      state: TRANSFER_STATES[Number(t[4])], requestedAt: Number(t[5]), reason: t[6],
    });
  }
  return out;
}

async function listGrants(evidenceId) {
  const sh = chain.contracts.sharing;
  const now = Math.floor(Date.now() / 1000);
  const out = [];
  for (const a of ACCOUNT_INFO) {
    const g = await sh.grants(evidenceId, addrOf(a.id));
    const scope = Number(g[0]);
    if (scope === 0) continue;
    const expiresAt = Number(g[1]);
    const active = Boolean(g[2]);
    out.push({
      agency: addrOf(a.id), scope,
      scopeNames: Object.entries(SCOPES).filter(([bit]) => scope & Number(bit)).map(([, n]) => n),
      expiresAt, active,
      status: !active ? "Revoked" : now > expiresAt ? "Expired" : "Active",
    });
  }
  return out;
}

const routes = {
  "GET /api/accounts": async () => ({
    accounts: ACCOUNT_INFO.map((a) => ({ ...a, address: addrOf(a.id) })),
  }),

  "GET /api/evidence": async () => {
    const items = [];
    for (const r of registered) items.push(await evidenceView(r));
    return { evidence: items };
  },

  "POST /api/register": async (body) => {
    const account = needAccount(body.account);
    const caseId = String(body.caseId || "").trim();
    if (!caseId) throw new UserError("Enter a case ID");
    const buffer = needBytes(body.contentBase64);
    const filename = String(body.filename || "evidence").slice(0, 120);
    return serial(async () => {
      const { cid, sha256 } = store.put(buffer);
      const evidenceId = makeEvidenceId(caseId, sha256);
      const receipt = await send(chain.contracts.registry, account, "register", [evidenceId, "0x" + sha256, cid, caseId]);
      registered.push({ evidenceId, filename });
      return {
        message: "Evidence registered. Its SHA-256 hash and storage ID are now on the blockchain.",
        evidenceId, sha256, cid, gasUsed: Number(receipt.gasUsed),
      };
    });
  },

  "POST /api/verify": async (body) => {
    const evidenceId = needId(body.evidenceId);
    const buf = needBytes(body.contentBase64);
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    const reg = chain.contracts.registry;
    const authentic = await reg.verify(evidenceId, "0x" + hash);
    const e = await reg.getEvidence(evidenceId);
    return { authentic, uploadedHash: hash, onChainHash: String(e[0]).replace(/^0x/, "") };
  },

  "GET /api/custody": async (_b, q) => ({ events: await custodyLog(needId(q.get("evidenceId"))) }),
  "GET /api/transfers": async (_b, q) => ({ transfers: await listTransfers(needId(q.get("evidenceId"))) }),
  "GET /api/grants": async (_b, q) => ({ grants: await listGrants(needId(q.get("evidenceId"))) }),

  "POST /api/transfer/request": async (b) => serial(async () => {
    const to = addrOf(needAccount(b.to));
    await send(chain.contracts.transfers, needAccount(b.account), "requestTransfer", [needId(b.evidenceId), to, String(b.reason || "")]);
    return { message: "Transfer requested. It now needs a supervisor's approval." };
  }),
  "POST /api/transfer/approve": async (b) => serial(async () => {
    await send(chain.contracts.transfers, needAccount(b.account), "approveTransfer", [BigInt(b.transferId)]);
    return { message: "Transfer approved. The receiver can now accept it." };
  }),
  "POST /api/transfer/accept": async (b) => serial(async () => {
    await send(chain.contracts.transfers, needAccount(b.account), "completeTransfer", [BigInt(b.transferId)]);
    return { message: "Transfer completed. Custody has moved to the receiver." };
  }),
  "POST /api/transfer/cancel": async (b) => serial(async () => {
    await send(chain.contracts.transfers, needAccount(b.account), "cancelTransfer", [BigInt(b.transferId)]);
    return { message: "Transfer cancelled." };
  }),
  "POST /api/transfer/emergency": async (b) => serial(async () => {
    const to = addrOf(needAccount(b.to));
    await send(chain.contracts.transfers, needAccount(b.account), "emergencyTransfer", [needId(b.evidenceId), to, String(b.reason || "")]);
    return { message: "Emergency transfer executed and flagged in the custody log." };
  }),

  "POST /api/share/grant": async (b) => serial(async () => {
    const minutes = Number(b.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) throw new UserError("Enter an expiry in minutes");
    const scope = Number(b.scope);
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + Math.round(minutes * 60));
    await send(chain.contracts.sharing, needAccount(b.account), "grantAccess", [needId(b.evidenceId), addrOf(needAccount(b.agency)), scope, expiresAt]);
    return { message: "Access granted with the chosen scope and expiry." };
  }),
  "POST /api/share/revoke": async (b) => serial(async () => {
    await send(chain.contracts.sharing, needAccount(b.account), "revokeAccess", [needId(b.evidenceId), addrOf(needAccount(b.agency))]);
    return { message: "Access revoked." };
  }),
  "POST /api/share/use": async (b) => serial(async () => {
    await send(chain.contracts.sharing, needAccount(b.account), "useAccess", [needId(b.evidenceId), Number(b.scope)]);
    return { message: "Access used. This use is now recorded in the custody log." };
  }),
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new UserError("File too large for this demo (max about 20 MB)"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (_) {
        reject(new UserError("Bad request"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = fs.readFileSync(path.join(__dirname, "public", "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
      return;
    }
    const handler = routes[req.method + " " + url.pathname];
    if (!handler) return sendJson(res, 404, { ok: false, error: "Not found" });
    const body = req.method === "POST" ? await readBody(req) : {};
    const result = await handler(body, url.searchParams);
    sendJson(res, 200, { ok: true, ...result });
  } catch (e) {
    const user = e instanceof UserError;
    if (!user) console.error(e);
    sendJson(res, user ? 400 : 500, { ok: false, error: user ? e.message : reasonOf(e) });
  }
});

(async () => {
  console.log("Starting local blockchain and deploying contracts (takes a few seconds)...");
  chain = await startChain();
  store = new ContentStore(path.join(__dirname, "evidence_store"));
  server.listen(PORT, () => {
    console.log("\nChain of custody interface is running.");
    console.log("Open http://localhost:" + PORT + "  (in Codespaces, open the forwarded port 3000 from the Ports tab)");
  });
})().catch((e) => {
  console.error("Failed to start:", e);
  process.exit(1);
});
