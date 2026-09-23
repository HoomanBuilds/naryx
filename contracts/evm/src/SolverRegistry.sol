// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ProtocolConfig} from "./ProtocolConfig.sol";

contract SolverRegistry {
    error InvalidConfiguration();
    error InvalidSolver();
    error UnauthorizedRole(address caller, address requiredRole);
    error ActivationTimestampOverflow();
    error SolverProposalExists();
    error SolverProposalMissing();
    error SolverProposalNotReady(uint64 activationTimestamp);

    event SolverProposed(
        address indexed actor, address indexed activeSolver, address indexed proposedSolver, uint64 activationTimestamp
    );
    event SolverProposalCancelled(
        address indexed actor, address indexed activeSolver, address indexed cancelledSolver, uint64 activationTimestamp
    );
    event SolverActivated(address indexed actor, address indexed previousSolver, address indexed newSolver);

    ProtocolConfig public immutable config;
    address public activeSolver;
    address public pendingSolver;
    uint64 public pendingActivationTimestamp;

    constructor(ProtocolConfig config_, address initialSolver) {
        if (address(config_).code.length == 0) revert InvalidConfiguration();
        if (initialSolver == address(0)) revert InvalidSolver();
        config = config_;
        activeSolver = initialSolver;
    }

    function proposeSolver(address proposedSolver) external {
        (address proposer,,,) = config.roles();
        _checkRole(proposer);
        if (pendingSolver != address(0)) revert SolverProposalExists();
        if (proposedSolver == address(0) || proposedSolver == activeSolver) revert InvalidSolver();

        uint64 delaySeconds = config.configDelaySeconds();
        if (block.timestamp > uint256(type(uint64).max) - uint256(delaySeconds)) {
            revert ActivationTimestampOverflow();
        }
        uint64 activationTimestamp = uint64(block.timestamp) + delaySeconds;
        pendingSolver = proposedSolver;
        pendingActivationTimestamp = activationTimestamp;

        emit SolverProposed(msg.sender, activeSolver, proposedSolver, activationTimestamp);
    }

    function cancelSolverProposal() external {
        (, address canceller,,) = config.roles();
        _checkRole(canceller);
        address proposedSolver = pendingSolver;
        if (proposedSolver == address(0)) revert SolverProposalMissing();

        uint64 activationTimestamp = pendingActivationTimestamp;
        pendingSolver = address(0);
        pendingActivationTimestamp = 0;

        emit SolverProposalCancelled(msg.sender, activeSolver, proposedSolver, activationTimestamp);
    }

    function activateSolver() external {
        (,, address executor,) = config.roles();
        _checkRole(executor);
        address proposedSolver = pendingSolver;
        if (proposedSolver == address(0)) revert SolverProposalMissing();
        uint64 activationTimestamp = pendingActivationTimestamp;
        if (block.timestamp < activationTimestamp) revert SolverProposalNotReady(activationTimestamp);

        address previousSolver = activeSolver;
        activeSolver = proposedSolver;
        pendingSolver = address(0);
        pendingActivationTimestamp = 0;

        emit SolverActivated(msg.sender, previousSolver, proposedSolver);
    }

    function _checkRole(address requiredRole) private view {
        if (msg.sender != requiredRole) revert UnauthorizedRole(msg.sender, requiredRole);
    }
}
