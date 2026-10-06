// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Math} from "openzeppelin-contracts/utils/math/Math.sol";
import {ProtocolConfig} from "./ProtocolConfig.sol";

contract StrategyFeePolicyRegistry {
    uint16 public constant HARD_MAX_TOTAL_FEE_BPS = 1_000;

    struct Policy {
        uint32 version;
        bytes32 manifestHash;
        address token;
        bytes32 expectedTokenCodeHash;
        address protocolRecipient;
        uint16 maximumProtocolFeeBps;
        uint16 maximumSolverFeeBps;
        bool paused;
    }

    struct PendingPolicy {
        Policy policy;
        uint64 activationTimestamp;
        bool resume;
        bool exists;
    }

    error InvalidConfiguration();
    error InvalidPolicy();
    error UnauthorizedRole(address caller, address requiredRole);
    error ActivationTimestampOverflow();
    error VersionNotIncreasing(uint32 latestVersion, uint32 proposedVersion);
    error ProposalExists();
    error ProposalMissing();
    error ProposalNotReady(uint64 activationTimestamp);
    error PolicyUnknown();
    error PolicyMismatch();
    error PolicyPaused();
    error TokenCodeMismatch();
    error FeeExceedsPolicy();
    error AlreadyPaused();
    error NotPaused();

    event PolicyProposed(
        bytes32 indexed subjectId,
        uint32 indexed version,
        bytes32 manifestHash,
        address token,
        address protocolRecipient,
        uint16 maximumProtocolFeeBps,
        uint16 maximumSolverFeeBps,
        uint64 activationTimestamp
    );
    event PolicyProposalCancelled(bytes32 indexed subjectId, uint32 indexed version);
    event PolicyActivated(bytes32 indexed subjectId, uint32 indexed version, bytes32 manifestHash);
    event PolicyPausedState(bytes32 indexed subjectId, uint32 indexed version);
    event PolicyResumeProposed(bytes32 indexed subjectId, uint32 indexed version, uint64 activationTimestamp);
    event PolicyResumed(bytes32 indexed subjectId, uint32 indexed version);

    ProtocolConfig public immutable config;
    bytes32 public immutable configCodeHash;

    mapping(bytes32 subjectId => Policy policy) private _active;
    mapping(bytes32 subjectId => PendingPolicy proposal) private _pending;

    constructor(ProtocolConfig config_) {
        if (address(config_).code.length == 0 || config_.configDelaySeconds() == 0) revert InvalidConfiguration();
        config = config_;
        configCodeHash = address(config_).codehash;
    }

    function policy(bytes32 subjectId) external view returns (Policy memory) {
        return _active[subjectId];
    }

    function pending(bytes32 subjectId) external view returns (PendingPolicy memory) {
        return _pending[subjectId];
    }

    function proposePolicy(bytes32 subjectId, Policy calldata proposed) external {
        _requireConfiguration();
        _requireRole(0);
        _validatePolicy(subjectId, proposed);
        if (_pending[subjectId].exists) revert ProposalExists();
        uint32 latestVersion = _active[subjectId].version;
        if (proposed.version <= latestVersion) revert VersionNotIncreasing(latestVersion, proposed.version);
        uint64 activationTimestamp = _activationTimestamp();
        _pending[subjectId] = PendingPolicy(proposed, activationTimestamp, false, true);
        emit PolicyProposed(
            subjectId,
            proposed.version,
            proposed.manifestHash,
            proposed.token,
            proposed.protocolRecipient,
            proposed.maximumProtocolFeeBps,
            proposed.maximumSolverFeeBps,
            activationTimestamp
        );
    }

    function proposeResume(bytes32 subjectId) external {
        _requireConfiguration();
        _requireRole(0);
        Policy memory active = _active[subjectId];
        if (active.version == 0) revert PolicyUnknown();
        if (!active.paused) revert NotPaused();
        if (_pending[subjectId].exists) revert ProposalExists();
        uint64 activationTimestamp = _activationTimestamp();
        _pending[subjectId] = PendingPolicy(active, activationTimestamp, true, true);
        emit PolicyResumeProposed(subjectId, active.version, activationTimestamp);
    }

    function cancel(bytes32 subjectId) external {
        _requireConfiguration();
        _requireRole(1);
        PendingPolicy memory proposal = _pending[subjectId];
        if (!proposal.exists) revert ProposalMissing();
        delete _pending[subjectId];
        emit PolicyProposalCancelled(subjectId, proposal.policy.version);
    }

    function activate(bytes32 subjectId) external {
        _requireConfiguration();
        _requireRole(2);
        PendingPolicy memory proposal = _pending[subjectId];
        if (!proposal.exists) revert ProposalMissing();
        if (block.timestamp < proposal.activationTimestamp) revert ProposalNotReady(proposal.activationTimestamp);
        delete _pending[subjectId];
        if (proposal.resume) {
            Policy storage active = _active[subjectId];
            if (active.version != proposal.policy.version || active.manifestHash != proposal.policy.manifestHash) {
                revert PolicyMismatch();
            }
            active.paused = false;
            emit PolicyResumed(subjectId, active.version);
            return;
        }
        uint32 latestVersion = _active[subjectId].version;
        if (proposal.policy.version <= latestVersion) {
            revert VersionNotIncreasing(latestVersion, proposal.policy.version);
        }
        bool paused = _active[subjectId].paused;
        _active[subjectId] = proposal.policy;
        _active[subjectId].paused = paused;
        emit PolicyActivated(subjectId, proposal.policy.version, proposal.policy.manifestHash);
    }

    function pause(bytes32 subjectId) external {
        _requireConfiguration();
        _requireRole(3);
        Policy storage active = _active[subjectId];
        if (active.version == 0) revert PolicyUnknown();
        if (active.paused) revert AlreadyPaused();
        active.paused = true;
        emit PolicyPausedState(subjectId, active.version);
    }

    function validateFees(
        bytes32 subjectId,
        uint32 version,
        bytes32 manifestHash,
        address token,
        uint256 protocolFeeAtoms,
        uint256 solverFeeAtoms,
        uint256 grossNotionalAtoms
    ) external view returns (address protocolRecipient) {
        _requireConfiguration();
        Policy storage active = _active[subjectId];
        if (
            active.version == 0 || active.version != version || active.manifestHash != manifestHash
                || active.token != token
        ) revert PolicyMismatch();
        if (token.codehash != active.expectedTokenCodeHash) revert TokenCodeMismatch();
        if (active.paused && (protocolFeeAtoms != 0 || solverFeeAtoms != 0)) revert PolicyPaused();
        if (
            protocolFeeAtoms > Math.mulDiv(grossNotionalAtoms, active.maximumProtocolFeeBps, 10_000)
                || solverFeeAtoms > Math.mulDiv(grossNotionalAtoms, active.maximumSolverFeeBps, 10_000)
        ) revert FeeExceedsPolicy();
        return active.protocolRecipient;
    }

    function _validatePolicy(bytes32 subjectId, Policy calldata proposed) private view {
        if (
            subjectId == bytes32(0) || proposed.version == 0 || proposed.manifestHash == bytes32(0)
                || proposed.token == address(0) || proposed.token.code.length == 0
                || proposed.expectedTokenCodeHash == bytes32(0)
                || proposed.token.codehash != proposed.expectedTokenCodeHash || proposed.protocolRecipient == address(0)
                || proposed.protocolRecipient == address(this) || proposed.paused
                || uint256(proposed.maximumProtocolFeeBps) + uint256(proposed.maximumSolverFeeBps)
                    > HARD_MAX_TOTAL_FEE_BPS
        ) revert InvalidPolicy();
    }

    function _activationTimestamp() private view returns (uint64) {
        uint64 delay = config.configDelaySeconds();
        if (block.timestamp > uint256(type(uint64).max) - uint256(delay)) revert ActivationTimestampOverflow();
        return uint64(block.timestamp) + delay;
    }

    function _requireConfiguration() private view {
        if (address(config).codehash != configCodeHash) revert InvalidConfiguration();
    }

    function _requireRole(uint8 role) private view {
        (address proposer, address canceller, address executor, address pauser) = config.roles();
        address requiredRole = role == 0 ? proposer : role == 1 ? canceller : role == 2 ? executor : pauser;
        if (msg.sender != requiredRole) revert UnauthorizedRole(msg.sender, requiredRole);
    }
}
