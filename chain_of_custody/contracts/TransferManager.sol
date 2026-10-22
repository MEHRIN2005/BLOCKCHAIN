// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./Roles.sol";
import "./EvidenceRegistry.sol";

/// @notice Transfer Management Contract (paper Sec. III-B-ii).
/// Sensitive transfers need dual approval: the custodian requests, a supervisor
/// who is not the requester approves, and the receiver accepts.
/// Emergency transfers bypass approval but are flagged and need a stated reason.
contract TransferManager {
    enum State { None, Requested, Approved, Completed, Cancelled }

    struct Transfer {
        bytes32 evidenceId;
        address from;
        address to;
        address approver;
        State state;
        uint64 requestedAt;
        string reason;
    }

    EvidenceRegistry public immutable registry;
    Roles public immutable roles;
    uint256 public nextTransferId;
    mapping(uint256 => Transfer) public transfers;

    event TransferRequested(uint256 indexed transferId, bytes32 indexed evidenceId, address indexed from, address to);
    event TransferApproved(uint256 indexed transferId, address indexed approver);
    event TransferCompleted(uint256 indexed transferId, bytes32 indexed evidenceId, address indexed to);
    event TransferCancelled(uint256 indexed transferId);
    event EmergencyTransferExecuted(bytes32 indexed evidenceId, address indexed by, address indexed to, string reason);

    constructor(EvidenceRegistry _registry, Roles _roles) {
        registry = _registry;
        roles = _roles;
        nextTransferId = 1;
    }

    function requestTransfer(bytes32 evidenceId, address to, string calldata reason) external returns (uint256 id) {
        require(roles.hasRole(INVESTIGATOR, msg.sender), "Transfer: not an investigator");
        require(registry.custodianOf(evidenceId) == msg.sender, "Transfer: caller is not custodian");
        require(roles.hasRole(INVESTIGATOR, to), "Transfer: receiver not an investigator");
        require(to != msg.sender, "Transfer: receiver is custodian");

        id = nextTransferId++;
        transfers[id] = Transfer(evidenceId, msg.sender, to, address(0), State.Requested, uint64(block.timestamp), reason);
        registry.appendEvent(evidenceId, EvidenceRegistry.Action.TransferRequested, msg.sender, to, reason);
        emit TransferRequested(id, evidenceId, msg.sender, to);
    }

    /// @notice Second party of the dual approval. Must differ from the requester.
    function approveTransfer(uint256 id) external {
        require(roles.hasRole(SUPERVISOR, msg.sender), "Transfer: not a supervisor");
        Transfer storage t = transfers[id];
        require(t.state == State.Requested, "Transfer: not pending");
        require(msg.sender != t.from, "Transfer: requester cannot approve");

        t.approver = msg.sender;
        t.state = State.Approved;
        registry.appendEvent(t.evidenceId, EvidenceRegistry.Action.TransferApproved, t.from, t.to, "approved");
        emit TransferApproved(id, msg.sender);
    }

    /// @notice Receiver accepts an approved transfer, completing custody handover.
    function completeTransfer(uint256 id) external {
        Transfer storage t = transfers[id];
        require(t.state == State.Approved, "Transfer: not approved");
        require(msg.sender == t.to, "Transfer: only receiver can accept");

        t.state = State.Completed;
        registry.appendEvent(t.evidenceId, EvidenceRegistry.Action.Transferred, t.from, t.to, "custody accepted");
        emit TransferCompleted(id, t.evidenceId, t.to);
    }

    function cancelTransfer(uint256 id) external {
        Transfer storage t = transfers[id];
        require(t.state == State.Requested || t.state == State.Approved, "Transfer: cannot cancel");
        require(msg.sender == t.from, "Transfer: only requester can cancel");

        t.state = State.Cancelled;
        registry.appendEvent(t.evidenceId, EvidenceRegistry.Action.TransferCancelled, t.from, t.to, "cancelled");
        emit TransferCancelled(id);
    }

    /// @notice Emergency path for urgent investigations: no approval round, but reason is mandatory and logged.
    function emergencyTransfer(bytes32 evidenceId, address to, string calldata reason) external {
        require(roles.hasRole(SUPERVISOR, msg.sender), "Transfer: not a supervisor");
        require(bytes(reason).length > 0, "Transfer: reason required");
        require(roles.hasRole(INVESTIGATOR, to), "Transfer: receiver not an investigator");

        address previous = registry.custodianOf(evidenceId);
        registry.appendEvent(evidenceId, EvidenceRegistry.Action.EmergencyTransfer, previous, to, reason);
        emit EmergencyTransferExecuted(evidenceId, msg.sender, to, reason);
    }
}
