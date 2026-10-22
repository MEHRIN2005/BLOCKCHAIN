const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * Off-chain content store standing in for IPFS (paper: "files stored off-chain but
 * cryptographically anchored"). Content is addressed by a CID derived from its bytes,
 * so a retrieved file can always be checked against the CID it was stored under.
 * Swap put/get for an IPFS client (e.g. Pinata) without changing the callers.
 */
class ContentStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  static sha256Hex(buf) {
    return crypto.createHash("sha256").update(buf).digest("hex");
  }

  put(buf) {
    const sha256 = ContentStore.sha256Hex(buf);
    const cid = "cid-" + sha256.slice(0, 46);
    fs.writeFileSync(path.join(this.dir, cid), buf);
    return { cid, sha256 };
  }

  get(cid) {
    const p = path.join(this.dir, cid);
    if (!fs.existsSync(p)) throw new Error("content not found: " + cid);
    return fs.readFileSync(p);
  }
}

module.exports = { ContentStore };
