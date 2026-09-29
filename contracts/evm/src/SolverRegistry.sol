// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ProtocolConfig} from "./ProtocolConfig.sol";

/// @notice The set of solvers whose signatures may authorize package settlement. Adding a solver
/// grants settlement authority, so it waits out the configuration delay after a proposal. Removing
/// one only takes authority away, so the pauser can do it immediately when a solver misbehaves.
contract SolverRegistry {
    uint256 public constant MAX_ACTIVE_SOLVERS = 64;

    error InvalidConfiguration();
    error InvalidSolver();
    error UnauthorizedRole(address caller, address requiredRole);
    error ActivationTimestampOverflow();
    error SolverProposalExists();
    error SolverProposalMissing();
    error SolverProposalNotReady(uint64 activationTimestamp);
    error SolverAlreadyActive();
    error SolverNotActive();
    error SolverSetFull();

    event SolverProposed(address indexed actor, address indexed proposedSolver, uint64 activationTimestamp);
    event SolverProposalCancelled(address indexed actor, address indexed cancelledSolver, uint64 activationTimestamp);
    event SolverActivated(address indexed actor, address indexed solver, uint256 activeSolverCount);
    event SolverRemoved(address indexed actor, address indexed solver, uint256 activeSolverCount);

    ProtocolConfig public immutable config;
    mapping(address solver => bool active) public isActiveSolver;
    mapping(address solver => uint64 activationTimestamp) public pendingActivationTimestamp;
    address[] private _activeSolvers;
    mapping(address solver => uint256 indexPlusOne) private _activeIndex;

    constructor(ProtocolConfig config_, address initialSolver) {
        if (address(config_).code.length == 0) revert InvalidConfiguration();
        if (initialSolver == address(0)) revert InvalidSolver();
        config = config_;
        _add(initialSolver);
        emit SolverActivated(msg.sender, initialSolver, 1);
    }

    function activeSolverCount() external view returns (uint256) {
        return _activeSolvers.length;
    }

    function activeSolvers() external view returns (address[] memory) {
        return _activeSolvers;
    }

    function proposeSolver(address proposedSolver) external {
        (address proposer,,,) = config.roles();
        _checkRole(proposer);
        if (proposedSolver == address(0)) revert InvalidSolver();
        if (isActiveSolver[proposedSolver]) revert SolverAlreadyActive();
        if (pendingActivationTimestamp[proposedSolver] != 0) revert SolverProposalExists();

        uint64 delaySeconds = config.configDelaySeconds();
        if (block.timestamp > uint256(type(uint64).max) - uint256(delaySeconds)) {
            revert ActivationTimestampOverflow();
        }
        // A zero delay would store a zero timestamp, which means "no proposal"; activate no earlier than the next second.
        uint64 activationTimestamp = uint64(block.timestamp) + delaySeconds;
        if (activationTimestamp == 0) activationTimestamp = 1;
        pendingActivationTimestamp[proposedSolver] = activationTimestamp;

        emit SolverProposed(msg.sender, proposedSolver, activationTimestamp);
    }

    function cancelSolverProposal(address proposedSolver) external {
        (, address canceller,,) = config.roles();
        _checkRole(canceller);
        uint64 activationTimestamp = pendingActivationTimestamp[proposedSolver];
        if (activationTimestamp == 0) revert SolverProposalMissing();
        delete pendingActivationTimestamp[proposedSolver];

        emit SolverProposalCancelled(msg.sender, proposedSolver, activationTimestamp);
    }

    function activateSolver(address proposedSolver) external {
        (,, address executor,) = config.roles();
        _checkRole(executor);
        uint64 activationTimestamp = pendingActivationTimestamp[proposedSolver];
        if (activationTimestamp == 0) revert SolverProposalMissing();
        if (block.timestamp < activationTimestamp) revert SolverProposalNotReady(activationTimestamp);
        if (_activeSolvers.length >= MAX_ACTIVE_SOLVERS) revert SolverSetFull();

        delete pendingActivationTimestamp[proposedSolver];
        _add(proposedSolver);

        emit SolverActivated(msg.sender, proposedSolver, _activeSolvers.length);
    }

    /// @notice Revokes a solver's settlement authority at once. Quotes it already signed stop settling.
    function removeSolver(address solver) external {
        (,,, address pauser) = config.roles();
        _checkRole(pauser);
        uint256 indexPlusOne = _activeIndex[solver];
        if (indexPlusOne == 0) revert SolverNotActive();

        uint256 lastIndex = _activeSolvers.length - 1;
        if (indexPlusOne - 1 != lastIndex) {
            address moved = _activeSolvers[lastIndex];
            _activeSolvers[indexPlusOne - 1] = moved;
            _activeIndex[moved] = indexPlusOne;
        }
        _activeSolvers.pop();
        delete _activeIndex[solver];
        delete isActiveSolver[solver];

        emit SolverRemoved(msg.sender, solver, _activeSolvers.length);
    }

    function _add(address solver) private {
        _activeSolvers.push(solver);
        _activeIndex[solver] = _activeSolvers.length;
        isActiveSolver[solver] = true;
    }

    function _checkRole(address requiredRole) private view {
        if (msg.sender != requiredRole) revert UnauthorizedRole(msg.sender, requiredRole);
    }
}
