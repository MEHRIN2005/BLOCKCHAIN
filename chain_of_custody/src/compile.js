const fs = require("fs");
const path = require("path");
const solc = require("solc");

const CONTRACTS_DIR = path.join(__dirname, "..", "contracts");

/** Compile every .sol file in contracts/ and return { ContractName: { abi, bytecode } }. */
function compile() {
  const sources = {};
  for (const f of fs.readdirSync(CONTRACTS_DIR).filter((f) => f.endsWith(".sol"))) {
    sources[f] = { content: fs.readFileSync(path.join(CONTRACTS_DIR, f), "utf8") };
  }
  const input = {
    language: "Solidity",
    sources,
    settings: { evmVersion: "shanghai", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors || []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));

  const result = {};
  for (const file of Object.keys(out.contracts)) {
    for (const [name, c] of Object.entries(out.contracts[file])) {
      result[name] = { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
    }
  }
  return result;
}

module.exports = { compile };
