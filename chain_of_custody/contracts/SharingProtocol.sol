// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./EvidenceRegistry.sol";

/// @notice Sharing Protocol Contract (paper Sec. III-B-iii).
/// The custodian grants another agency access with a selective-disclosure scope
/// and an expiry. Every grant, revocation and use is written to the custody log.
contract SharingProtocol {
    uint8 public constant SCOPE_METADATA = 1; // case + custody history
    uint8 public constant SCOPE_HASH = 2;     // on-chain hash for verification
    uint8 public constant SCOPE_FILE = 4;     // retrieve the encrypted file (CID)

    struct Grant {
        uint8 scope;
        uint64 expiresAt;
        bool active;
    }

    EvidenceRegistry public immutable registry;
    mapping(bytes32 => mapping(address => Grant)) public grants;

    event AccessGranted(bytes32 indexed evidenceId, address indexed agency, uint8 scope, uint64 expiresAt);
    event AccessRevoked(bytes32 indexed evidenceId, address indexed agency);
    event AccessUsed(bytes32 indexed evidenceId, address indexed agency, uint8 scope);

    constructor(EvidenceRegistry _registry) {
        registry = _registry;
    }

    function grantAccess(bytes32 evidenceId, address agency, uint8 scope, uint64 expiresAt) external {
        require(registry.custodianOf(evidenceId) == msg.sender, "Sharing: not custodian");
        require(scope != 0 && scope <= 7, "Sharing: invalid scope");
        require(expiresAt > block.timestamp, "Sharing: expiry in past");
        require(agency != msg.sender, "Sharing: self grant");

        grants[evidenceId][agency] = Grant(scope, expiresAt, true);
        registry.appendEvent(evidenceId, EvidenceRegistry.Action.AccessGranted, msg.sender, agency, "access granted");
        emit AccessGranted(evidenceId, agency, scope, expiresAt);
    }

    function revokeAccess(bytes32 evidenceId, address agency) external {
        require(registry.custodianOf(evidenceId) == msg.sender, "Sharing: not custodian");
        require(grants[evidenceId][agency].active, "Sharing: no active grant");

        grants[evidenceId][agency].active = false;
        registry.appendEvent(evidenceId, EvidenceRegistry.Action.AccessRevoked, msg.sender, agency, "access revoked");
        emit AccessRevoked(evidenceId, agency);
    }

    function hasScope(bytes32 evidenceId, address agency, uint8 scope) public view returns (bool) {
        Grant memory g = grants[evidenceId][agency];
        return g.active && block.timestamp <= g.expiresAt && (g.scope & scope) == scope;
    }

    /// @notice Agency logs each use of its access, so the custody chain shows who looked at what.
    function useAccess(bytes32 evidenceId, uint8 scope) external {
        require(hasScope(evidenceId, msg.sender, scope), "Sharing: access denied");
        registry.appendEvent(evidenceId, EvidenceRegistry.Action.AccessUsed, msg.sender, msg.sender, "access used");
        emit AccessUsed(evidenceId, msg.sender, scope);
    }
}
