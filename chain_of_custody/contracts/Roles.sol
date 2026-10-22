// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Role-based access control shared by all custody contracts.
// Models the paper's Access Layer (role-based permissions for investigators,
// supervisors and administrators).
bytes32 constant ADMIN = keccak256("ADMIN");
bytes32 constant INVESTIGATOR = keccak256("INVESTIGATOR");
bytes32 constant SUPERVISOR = keccak256("SUPERVISOR");

/// @notice Holds role membership for the custody system.
contract Roles {

    mapping(bytes32 => mapping(address => bool)) private _has;

    event RoleGranted(bytes32 indexed role, address indexed account);
    event RoleRevoked(bytes32 indexed role, address indexed account);

    modifier onlyRole(bytes32 role) {
        require(_has[role][msg.sender], "Roles: missing role");
        _;
    }

    constructor() {
        _has[ADMIN][msg.sender] = true;
        emit RoleGranted(ADMIN, msg.sender);
    }

    function hasRole(bytes32 role, address account) public view returns (bool) {
        return _has[role][account];
    }

    function grant(bytes32 role, address account) external onlyRole(ADMIN) {
        _has[role][account] = true;
        emit RoleGranted(role, account);
    }

    function revoke(bytes32 role, address account) external onlyRole(ADMIN) {
        _has[role][account] = false;
        emit RoleRevoked(role, account);
    }
}
