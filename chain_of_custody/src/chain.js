const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");
const { compile } = require("./compile");

const ROLE = {
  ADMIN: ethers.id("ADMIN"),
  INVESTIGATOR: ethers.id("INVESTIGATOR"),
  SUPERVISOR: ethers.id("SUPERVISOR"),
};

/**
 * Start a local Ganache chain with deterministic keys, then deploy and wire the
 * four contracts. Account layout:
 *   0 admin | 1 Police investigator | 2 Lab investigator | 3 Court investigator
 *   4 supervisor | 5 unauthorised outsider | 6.. benchmark investigators
 */
async function startChain({ benchAccounts = 0 } = {}) {
  const total = 6 + benchAccounts;
  const keys = [];
  for (let i = 0; i < total; i++) {
    keys.push(ethers.keccak256(ethers.toUtf8Bytes("custody-test-account-" + i)));
  }
  const server = ganache.provider({
    wallet: {
      accounts: keys.map((k) => ({ secretKey: k, balance: ethers.toQuantity(ethers.parseEther("1000")) })),
    },
    logging: { quiet: true },
    miner: { instamine: "strict" },
    chain: { chainId: 1337 },
  });
  const provider = new ethers.BrowserProvider(server);
  provider.pollingInterval = 300; // ethers default is 4s per receipt poll; keep latency numbers meaningful
  const signers = keys.map((k) => new ethers.Wallet(k, provider));

  const compiled = compile();
  const deploy = async (name, args, signer) => {
    const factory = new ethers.ContractFactory(compiled[name].abi, compiled[name].bytecode, signer);
    const c = await factory.deploy(...args);
    await c.waitForDeployment();
    return c;
  };

  const admin = signers[0];
  const roles = await deploy("Roles", [], admin);
  const registry = await deploy("EvidenceRegistry", [await roles.getAddress()], admin);
  const transfers = await deploy("TransferManager", [await registry.getAddress(), await roles.getAddress()], admin);
  const sharing = await deploy("SharingProtocol", [await registry.getAddress()], admin);

  await (await registry.setModule(await transfers.getAddress(), true)).wait();
  await (await registry.setModule(await sharing.getAddress(), true)).wait();

  for (const i of [1, 2, 3, ...Array.from({ length: benchAccounts }, (_, j) => 6 + j)]) {
    await (await roles.grant(ROLE.INVESTIGATOR, signers[i].address)).wait();
  }
  await (await roles.grant(ROLE.SUPERVISOR, signers[4].address)).wait();

  const contracts = {
    roles: roles.connect(admin),
    registry,
    transfers,
    sharing,
  };
  const connectAs = (c, i) => c.connect(signers[i]);

  return {
    provider,
    server,
    signers,
    contracts,
    connectAs,
    ROLE,
    close: () => server.close ? server.close() : undefined,
    evm: (method, params = []) => provider.send(method, params),
  };
}

module.exports = { startChain, ROLE };
