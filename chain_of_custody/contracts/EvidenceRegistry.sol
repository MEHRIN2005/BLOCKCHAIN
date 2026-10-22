// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./Roles.sol";

/// @notice Evidence Layer + Evidence Registration Contract (paper Sec. III-A/B).
/// Registers evidence with its SHA-256 hash and IPFS CID, tracks the current
/// custodian, and keeps an append-only chain-of-custody log.
contract EvidenceRegistry {
    enum Action {
        Registered,
        TransferRequested,
        TransferApproved,
        Transferred,
        EmergencyTransfer,
        AccessGranted,
        AccessRevoked,
        AccessUsed,
        TransferCancelled
    }

    struct Evidence {
        bytes32 sha256Hash;   // hash of the original evidence file
        string cid;           // content identifier of the stored (encrypted) file
        string caseId;
        address custodian;    // current custodian
        address registeredBy;
        uint64 registeredAt;
        bool exists;
    }

    struct CustodyEvent {
        Action action;
        address from;
        address to;
        uint64 timestamp;
        string note;
    }

    Roles public immutable roles;
    address public admin;
    mapping(address => bool) public isModule; // TransferManager, SharingProtocol

    mapping(bytes32 => Evidence) private _evidence;
    mapping(bytes32 => CustodyEvent[]) private _custody;

    event EvidenceRegistered(bytes32 indexed evidenceId, address indexed registeredBy, bytes32 sha256Hash, string cid);
    event CustodyRecorded(bytes32 indexed evidenceId, Action action, address indexed from, address indexed to, uint64 timestamp);
    event ModuleSet(address indexed module, bool enabled);

    modifier onlyModule() {
        require(isModule[msg.sender], "Registry: caller is not a module");
        _;
    }

    constructor(Roles _roles) {
        roles = _roles;
        admin = msg.sender;
    }

    function setModule(address module, bool enabled) external {
        require(msg.sender == admin, "Registry: not admin");
        isModule[module] = enabled;
        emit ModuleSet(module, enabled);
    }

    function register(bytes32 evidenceId, bytes32 sha256Hash, string calldata cid, string calldata caseId) external {
        require(roles.hasRole(INVESTIGATOR, msg.sender), "Registry: not an investigator");
        require(!_evidence[evidenceId].exists, "Registry: evidence exists");
        require(sha256Hash != bytes32(0), "Registry: empty hash");
        require(bytes(cid).length > 0, "Registry: empty CID");

        _evidence[evidenceId] = Evidence({
            sha256Hash: sha256Hash,
            cid: cid,
            caseId: caseId,
            custodian: msg.sender,
            registeredBy: msg.sender,
            registeredAt: uint64(block.timestamp),
            exists: true
        });
        _append(evidenceId, Action.Registered, address(0), msg.sender, "evidence registered");
        emit EvidenceRegistered(evidenceId, msg.sender, sha256Hash, cid);
    }

    /// @notice Verifies a file against the on-chain hash. Returns false if it differs (tamper detected).
    function verify(bytes32 evidenceId, bytes32 sha256Hash) external view returns (bool) {
        Evidence storage e = _evidence[evidenceId];
        return e.exists && e.sha256Hash == sha256Hash;
    }

    function getEvidence(bytes32 evidenceId) external view returns (Evidence memory) {
        require(_evidence[evidenceId].exists, "Registry: unknown evidence");
        return _evidence[evidenceId];
    }

    function custodianOf(bytes32 evidenceId) external view returns (address) {
        return _evidence[evidenceId].custodian;
    }

    function custodyLength(bytes32 evidenceId) external view returns (uint256) {
        return _custody[evidenceId].length;
    }

    function getCustodyEvent(bytes32 evidenceId, uint256 index) external view returns (CustodyEvent memory) {
        return _custody[evidenceId][index];
    }

    /// @notice Called only by authorised modules (TransferManager, SharingProtocol).
    function appendEvent(bytes32 evidenceId, Action action, address from, address to, string calldata note)
        external
        onlyModule
    {
        require(_evidence[evidenceId].exists, "Registry: unknown evidence");
        if (action == Action.Transferred || action == Action.EmergencyTransfer) {
            _evidence[evidenceId].custodian = to;
        }
        _append(evidenceId, action, from, to, note);
    }

    function _append(bytes32 evidenceId, Action action, address from, address to, string memory note) internal {
        _custody[evidenceId].push(CustodyEvent(action, from, to, uint64(block.timestamp), note));
        emit CustodyRecorded(evidenceId, action, from, to, uint64(block.timestamp));
    }
}
