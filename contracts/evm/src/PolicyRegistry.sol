// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ProtocolConfig} from "./ProtocolConfig.sol";

/// @notice The onchain registry of package template manifests and fee policy manifests. Every
/// activation is proposed by the proposer role and takes effect only after the protocol config's
/// delay through the executor role; the canceller can withdraw a pending proposal. Pausing is a
/// tightening and takes effect immediately; resuming is a loosening and waits out the delay. A fee
/// policy carries its maximum fee in basis points, bounded by a hard cap; a template carries none.
/// Consumers check an exact (kind, subject, version, manifest hash) binding with `isActive`.
contract PolicyRegistry {
    uint16 public constant HARD_MAX_FEE_BPS = 1_000;

    enum PolicyKind {
        TEMPLATE,
        FEE_POLICY
    }

    struct Policy {
        uint32 version;
        bytes32 manifestHash;
        uint16 maximumFeeBps;
        bool paused;
    }

    struct Pending {
        uint32 version;
        bytes32 manifestHash;
        uint16 maximumFeeBps;
        bool resume;
        uint64 activationTimestamp;
        bool exists;
    }

    error InvalidConfiguration();
    error UnauthorizedRole(address caller, address requiredRole);
    error InvalidPolicy();
    error VersionNotIncreasing(uint32 latestVersion, uint32 proposedVersion);
    error ProposalExists();
    error ProposalMissing();
    error ProposalNotReady(uint64 activationTimestamp);
    error PolicyUnknown();
    error AlreadyPaused();
    error NotPaused();

    event PolicyProposed(
        PolicyKind indexed kind,
        bytes32 indexed subjectId,
        uint32 version,
        bytes32 manifestHash,
        uint16 maximumFeeBps,
        bool resume,
        uint64 activationTimestamp
    );
    event PolicyProposalCancelled(PolicyKind indexed kind, bytes32 indexed subjectId);
    event PolicyActivated(
        PolicyKind indexed kind, bytes32 indexed subjectId, uint32 version, bytes32 manifestHash, uint16 maximumFeeBps
    );
    event PolicyPaused(PolicyKind indexed kind, bytes32 indexed subjectId);
    event PolicyResumed(PolicyKind indexed kind, bytes32 indexed subjectId);

    ProtocolConfig public immutable config;
    uint64 public immutable delaySeconds;
    mapping(bytes32 key => Policy policy) private _active;
    mapping(bytes32 key => Pending proposal) private _pending;

    constructor(ProtocolConfig config_) {
        if (address(config_).code.length == 0) revert InvalidConfiguration();
        uint64 delay = config_.configDelaySeconds();
        if (delay == 0) revert InvalidConfiguration();
        config = config_;
        delaySeconds = delay;
    }

    function policy(PolicyKind kind, bytes32 subjectId) external view returns (Policy memory) {
        return _active[_key(kind, subjectId)];
    }

    function pending(PolicyKind kind, bytes32 subjectId) external view returns (Pending memory) {
        return _pending[_key(kind, subjectId)];
    }

    /// @notice Whether exactly this version and manifest hash is the active, unpaused policy.
    function isActive(PolicyKind kind, bytes32 subjectId, uint32 version, bytes32 manifestHash)
        external
        view
        returns (bool)
    {
        Policy storage entry = _active[_key(kind, subjectId)];
        return entry.version != 0 && !entry.paused && entry.version == version && entry.manifestHash == manifestHash;
    }

    function proposeActivation(
        PolicyKind kind,
        bytes32 subjectId,
        uint32 version,
        bytes32 manifestHash,
        uint16 maximumFeeBps
    ) external {
        _requireRole(0);
        if (subjectId == bytes32(0) || version == 0 || manifestHash == bytes32(0)) revert InvalidPolicy();
        if (kind == PolicyKind.TEMPLATE ? maximumFeeBps != 0 : maximumFeeBps > HARD_MAX_FEE_BPS) {
            revert InvalidPolicy();
        }
        bytes32 key = _key(kind, subjectId);
        uint32 latest = _active[key].version;
        if (version <= latest) revert VersionNotIncreasing(latest, version);
        _propose(kind, subjectId, key, Pending(version, manifestHash, maximumFeeBps, false, 0, true));
    }

    /// @notice Resuming a paused policy loosens it, so it waits out the delay like an activation.
    function proposeResume(PolicyKind kind, bytes32 subjectId) external {
        _requireRole(0);
        bytes32 key = _key(kind, subjectId);
        Policy storage entry = _active[key];
        if (entry.version == 0) revert PolicyUnknown();
        if (!entry.paused) revert NotPaused();
        _propose(kind, subjectId, key, Pending(entry.version, entry.manifestHash, entry.maximumFeeBps, true, 0, true));
    }

    function cancel(PolicyKind kind, bytes32 subjectId) external {
        _requireRole(1);
        bytes32 key = _key(kind, subjectId);
        if (!_pending[key].exists) revert ProposalMissing();
        delete _pending[key];
        emit PolicyProposalCancelled(kind, subjectId);
    }

    function activate(PolicyKind kind, bytes32 subjectId) external {
        _requireRole(2);
        bytes32 key = _key(kind, subjectId);
        Pending memory proposal = _pending[key];
        if (!proposal.exists) revert ProposalMissing();
        if (block.timestamp < proposal.activationTimestamp) revert ProposalNotReady(proposal.activationTimestamp);
        delete _pending[key];
        if (proposal.resume) {
            _active[key].paused = false;
            emit PolicyResumed(kind, subjectId);
            return;
        }
        // A newer version may have activated since the proposal; an older one never replaces it.
        if (proposal.version <= _active[key].version) {
            revert VersionNotIncreasing(_active[key].version, proposal.version);
        }
        _active[key] = Policy(proposal.version, proposal.manifestHash, proposal.maximumFeeBps, false);
        emit PolicyActivated(kind, subjectId, proposal.version, proposal.manifestHash, proposal.maximumFeeBps);
    }

    /// @notice Pausing only tightens, so the pauser applies it at once.
    function pause(PolicyKind kind, bytes32 subjectId) external {
        _requireRole(3);
        Policy storage entry = _active[_key(kind, subjectId)];
        if (entry.version == 0) revert PolicyUnknown();
        if (entry.paused) revert AlreadyPaused();
        entry.paused = true;
        emit PolicyPaused(kind, subjectId);
    }

    function _propose(PolicyKind kind, bytes32 subjectId, bytes32 key, Pending memory proposal) private {
        if (_pending[key].exists) revert ProposalExists();
        proposal.activationTimestamp = uint64(block.timestamp) + delaySeconds;
        _pending[key] = proposal;
        emit PolicyProposed(
            kind,
            subjectId,
            proposal.version,
            proposal.manifestHash,
            proposal.maximumFeeBps,
            proposal.resume,
            proposal.activationTimestamp
        );
    }

    /// @dev 0 proposer, 1 canceller, 2 executor, 3 pauser, read from the protocol config.
    function _requireRole(uint8 role) private view {
        (address proposer, address canceller, address executor, address pauser) = config.roles();
        address required = role == 0 ? proposer : role == 1 ? canceller : role == 2 ? executor : pauser;
        if (msg.sender != required) revert UnauthorizedRole(msg.sender, required);
    }

    function _key(PolicyKind kind, bytes32 subjectId) private pure returns (bytes32) {
        return keccak256(abi.encode(kind, subjectId));
    }
}
