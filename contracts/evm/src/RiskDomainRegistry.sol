// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Math} from "openzeppelin-contracts/utils/math/Math.sol";
import {ProtocolConfig} from "./ProtocolConfig.sol";

contract RiskDomainRegistry {
    uint256 public constant MAXIMUM_SERIES = 64;
    uint256 public constant MAXIMUM_DEPENDENCIES = 128;
    uint64 public constant MAXIMUM_LEVERAGE_BPS = 1_000_000;

    enum Lifecycle {
        UNSET,
        ACTIVE,
        ENTRY_PAUSED,
        EXIT_ONLY,
        DEPRECATED
    }

    struct SeriesRef {
        bytes32 seriesId;
        uint32 manifestVersion;
        bytes32 manifestHash;
    }

    struct DependencyLimit {
        bytes32 dependencyId;
        uint128 maximumGrossQuoteAtoms;
    }

    struct PolicyConfig {
        uint32 manifestVersion;
        bytes32 manifestHash;
        uint32 domainManifestVersion;
        bytes32 domainManifestHash;
        address accountingToken;
        bytes32 expectedTokenCodeHash;
        uint128 grossCapQuoteAtoms;
        uint128 netCapQuoteAtoms;
        uint128 minimumMarginFloorQuoteAtoms;
        uint64 maximumLeverageBps;
        uint64 maximumStalenessMs;
        uint64 maximumTimeToUnwindMs;
        uint128 requiredRecoveryReserveQuoteAtoms;
        uint16 aggregateHaircutBps;
    }

    struct Policy {
        PolicyConfig config;
        Lifecycle lifecycle;
        bool activated;
        uint16 seriesCount;
        uint16 dependencyCount;
    }

    struct PendingPolicy {
        uint32 manifestVersion;
        uint64 activationTimestamp;
        bool resume;
        bool exists;
    }

    struct DependencyExposure {
        bytes32 dependencyId;
        uint256 grossQuoteAtoms;
    }

    struct EntryRisk {
        address accountingToken;
        uint256 grossQuoteAtoms;
        uint256 netQuoteAtoms;
        uint256 marginQuoteAtoms;
        uint256 reservedRecoveryQuoteAtoms;
        uint64 observationAgeMs;
        uint64 timeToUnwindMs;
    }

    error InvalidConfiguration();
    error InvalidPolicy();
    error InvalidSeries();
    error InvalidDependency();
    error UnauthorizedRole(address caller, address requiredRole);
    error ActivationTimestampOverflow();
    error VersionNotIncreasing(uint32 latestVersion, uint32 proposedVersion);
    error ProposalExists();
    error ProposalMissing();
    error ProposalNotReady(uint64 activationTimestamp);
    error PolicyUnknown();
    error PolicyMismatch();
    error EntryUnavailable();
    error EntryAlreadyPaused();
    error EntryNotPaused();
    error SeriesUnsupported();
    error TokenMismatch();
    error RiskLimitExceeded();
    error MarginInsufficient(uint256 requiredAtoms, uint256 providedAtoms);
    error RecoveryReserveInsufficient();
    error ObservationStale();
    error UnwindTooSlow();
    error DependencyLimitExceeded(bytes32 dependencyId, uint256 maximumAtoms, uint256 providedAtoms);

    event PolicyProposed(
        bytes32 indexed riskDomainId,
        uint32 indexed manifestVersion,
        bytes32 manifestHash,
        address accountingToken,
        uint64 activationTimestamp
    );
    event PolicyProposalCancelled(bytes32 indexed riskDomainId, uint32 indexed manifestVersion);
    event PolicyActivated(bytes32 indexed riskDomainId, uint32 indexed manifestVersion, bytes32 manifestHash);
    event EntryPaused(bytes32 indexed riskDomainId, uint32 indexed manifestVersion);
    event EntryResumeProposed(bytes32 indexed riskDomainId, uint32 indexed manifestVersion, uint64 activationTimestamp);
    event EntryResumed(bytes32 indexed riskDomainId, uint32 indexed manifestVersion);

    ProtocolConfig public immutable config;
    bytes32 public immutable configCodeHash;
    uint256 public immutable deploymentChainId;

    mapping(bytes32 riskDomainId => uint32 manifestVersion) public activeVersion;
    mapping(bytes32 riskDomainId => uint32 manifestVersion) public latestVersion;
    mapping(bytes32 riskDomainId => PendingPolicy proposal) private _pending;
    mapping(bytes32 riskDomainId => mapping(uint32 manifestVersion => Policy policy)) private _policies;
    mapping(bytes32 riskDomainId => mapping(uint32 manifestVersion => mapping(bytes32 seriesKey => bool eligible)))
        private _eligibleSeries;
    mapping(
        bytes32 riskDomainId => mapping(uint32 manifestVersion => mapping(bytes32 dependencyId => uint128 cap))
    ) private _dependencyCaps;
    mapping(bytes32 riskDomainId => bool paused) private _entryPaused;

    constructor(ProtocolConfig config_) {
        if (address(config_).code.length == 0 || config_.configDelaySeconds() == 0) revert InvalidConfiguration();
        config = config_;
        configCodeHash = address(config_).codehash;
        deploymentChainId = block.chainid;
    }

    function policy(bytes32 riskDomainId, uint32 manifestVersion) external view returns (Policy memory) {
        return _policies[riskDomainId][manifestVersion];
    }

    function pending(bytes32 riskDomainId) external view returns (PendingPolicy memory) {
        return _pending[riskDomainId];
    }

    function isEligibleSeries(bytes32 riskDomainId, uint32 manifestVersion, SeriesRef calldata series)
        external
        view
        returns (bool)
    {
        return _eligibleSeries[riskDomainId][manifestVersion][_seriesKey(series)];
    }

    function dependencyCap(bytes32 riskDomainId, uint32 manifestVersion, bytes32 dependencyId)
        external
        view
        returns (uint128)
    {
        return _dependencyCaps[riskDomainId][manifestVersion][dependencyId];
    }

    function proposePolicy(
        bytes32 riskDomainId,
        PolicyConfig calldata proposed,
        SeriesRef[] calldata series,
        DependencyLimit[] calldata dependencies
    ) external {
        _requireConfiguration();
        _requireRole(0);
        _validatePolicy(riskDomainId, proposed, series, dependencies);
        if (_pending[riskDomainId].exists) revert ProposalExists();
        uint32 latest = latestVersion[riskDomainId];
        if (proposed.manifestVersion <= latest) {
            revert VersionNotIncreasing(latest, proposed.manifestVersion);
        }

        Policy storage record = _policies[riskDomainId][proposed.manifestVersion];
        if (record.config.manifestVersion != 0) revert InvalidPolicy();
        record.config = proposed;
        record.lifecycle = Lifecycle.UNSET;
        record.seriesCount = uint16(series.length);
        record.dependencyCount = uint16(dependencies.length);
        for (uint256 index; index < series.length; ++index) {
            _eligibleSeries[riskDomainId][proposed.manifestVersion][_seriesKey(series[index])] = true;
        }
        for (uint256 index; index < dependencies.length; ++index) {
            DependencyLimit calldata limit = dependencies[index];
            _dependencyCaps[riskDomainId][proposed.manifestVersion][limit.dependencyId] = limit.maximumGrossQuoteAtoms;
        }
        latestVersion[riskDomainId] = proposed.manifestVersion;
        uint64 activationTimestamp = _activationTimestamp();
        _pending[riskDomainId] = PendingPolicy(proposed.manifestVersion, activationTimestamp, false, true);
        emit PolicyProposed(
            riskDomainId, proposed.manifestVersion, proposed.manifestHash, proposed.accountingToken, activationTimestamp
        );
    }

    function proposeResume(bytes32 riskDomainId) external {
        _requireConfiguration();
        _requireRole(0);
        uint32 version = activeVersion[riskDomainId];
        if (version == 0) revert PolicyUnknown();
        if (!_entryPaused[riskDomainId]) revert EntryNotPaused();
        if (_pending[riskDomainId].exists) revert ProposalExists();
        uint64 activationTimestamp = _activationTimestamp();
        _pending[riskDomainId] = PendingPolicy(version, activationTimestamp, true, true);
        emit EntryResumeProposed(riskDomainId, version, activationTimestamp);
    }

    function cancel(bytes32 riskDomainId) external {
        _requireConfiguration();
        _requireRole(1);
        PendingPolicy memory proposal = _pending[riskDomainId];
        if (!proposal.exists) revert ProposalMissing();
        delete _pending[riskDomainId];
        if (!proposal.resume) _policies[riskDomainId][proposal.manifestVersion].lifecycle = Lifecycle.DEPRECATED;
        emit PolicyProposalCancelled(riskDomainId, proposal.manifestVersion);
    }

    function activate(bytes32 riskDomainId) external {
        _requireConfiguration();
        _requireRole(2);
        PendingPolicy memory proposal = _pending[riskDomainId];
        if (!proposal.exists) revert ProposalMissing();
        if (block.timestamp < proposal.activationTimestamp) revert ProposalNotReady(proposal.activationTimestamp);
        delete _pending[riskDomainId];
        if (proposal.resume) {
            if (activeVersion[riskDomainId] != proposal.manifestVersion) revert PolicyMismatch();
            _entryPaused[riskDomainId] = false;
            _policies[riskDomainId][proposal.manifestVersion].lifecycle = Lifecycle.ACTIVE;
            emit EntryResumed(riskDomainId, proposal.manifestVersion);
            return;
        }

        uint32 previousVersion = activeVersion[riskDomainId];
        if (previousVersion != 0) _policies[riskDomainId][previousVersion].lifecycle = Lifecycle.EXIT_ONLY;
        Policy storage record = _policies[riskDomainId][proposal.manifestVersion];
        if (record.config.manifestVersion != proposal.manifestVersion || record.activated) revert PolicyMismatch();
        record.activated = true;
        record.lifecycle = _entryPaused[riskDomainId] ? Lifecycle.ENTRY_PAUSED : Lifecycle.ACTIVE;
        activeVersion[riskDomainId] = proposal.manifestVersion;
        emit PolicyActivated(riskDomainId, proposal.manifestVersion, record.config.manifestHash);
    }

    function pauseEntry(bytes32 riskDomainId) external {
        _requireConfiguration();
        _requireRole(3);
        uint32 version = activeVersion[riskDomainId];
        if (version == 0) revert PolicyUnknown();
        if (_entryPaused[riskDomainId]) revert EntryAlreadyPaused();
        _entryPaused[riskDomainId] = true;
        _policies[riskDomainId][version].lifecycle = Lifecycle.ENTRY_PAUSED;
        emit EntryPaused(riskDomainId, version);
    }

    function validateEntry(
        bytes32 riskDomainId,
        uint32 manifestVersion,
        bytes32 manifestHash,
        SeriesRef calldata series,
        EntryRisk calldata risk,
        DependencyExposure[] calldata dependencies
    ) external view returns (uint256 minimumMarginAtoms) {
        _requireConfiguration();
        Policy storage record = _exactPolicy(riskDomainId, manifestVersion, manifestHash);
        if (activeVersion[riskDomainId] != manifestVersion || record.lifecycle != Lifecycle.ACTIVE) {
            revert EntryUnavailable();
        }
        if (!_eligibleSeries[riskDomainId][manifestVersion][_seriesKey(series)]) revert SeriesUnsupported();
        PolicyConfig storage rules = record.config;
        _requireDomain(rules);
        if (
            risk.accountingToken != rules.accountingToken
                || risk.accountingToken.codehash != rules.expectedTokenCodeHash
        ) revert TokenMismatch();
        if (
            risk.grossQuoteAtoms == 0 || risk.grossQuoteAtoms > rules.grossCapQuoteAtoms
                || risk.netQuoteAtoms > rules.netCapQuoteAtoms
        ) revert RiskLimitExceeded();
        minimumMarginAtoms = Math.mulDiv(risk.grossQuoteAtoms, 10_000, rules.maximumLeverageBps, Math.Rounding.Ceil);
        if (minimumMarginAtoms < rules.minimumMarginFloorQuoteAtoms) {
            minimumMarginAtoms = rules.minimumMarginFloorQuoteAtoms;
        }
        if (risk.marginQuoteAtoms < minimumMarginAtoms) {
            revert MarginInsufficient(minimumMarginAtoms, risk.marginQuoteAtoms);
        }
        if (risk.reservedRecoveryQuoteAtoms < rules.requiredRecoveryReserveQuoteAtoms) {
            revert RecoveryReserveInsufficient();
        }
        if (risk.observationAgeMs > rules.maximumStalenessMs) revert ObservationStale();
        if (risk.timeToUnwindMs > rules.maximumTimeToUnwindMs) revert UnwindTooSlow();
        _validateDependencies(riskDomainId, manifestVersion, record.dependencyCount, dependencies);
    }

    function validateExit(
        bytes32 riskDomainId,
        uint32 manifestVersion,
        bytes32 manifestHash,
        SeriesRef calldata series,
        address accountingToken
    ) external view {
        _requireConfiguration();
        Policy storage record = _exactPolicy(riskDomainId, manifestVersion, manifestHash);
        if (!record.activated || record.lifecycle == Lifecycle.DEPRECATED || record.lifecycle == Lifecycle.UNSET) {
            revert PolicyMismatch();
        }
        _requireDomain(record.config);
        if (!_eligibleSeries[riskDomainId][manifestVersion][_seriesKey(series)]) revert SeriesUnsupported();
        if (
            accountingToken != record.config.accountingToken
                || accountingToken.codehash != record.config.expectedTokenCodeHash
        ) revert TokenMismatch();
    }

    function _validatePolicy(
        bytes32 riskDomainId,
        PolicyConfig calldata proposed,
        SeriesRef[] calldata series,
        DependencyLimit[] calldata dependencies
    ) private view {
        if (
            riskDomainId == bytes32(0) || proposed.manifestVersion == 0 || proposed.manifestHash == bytes32(0)
                || proposed.domainManifestVersion == 0 || proposed.domainManifestHash == bytes32(0)
                || proposed.accountingToken == address(0) || proposed.accountingToken.code.length == 0
                || proposed.expectedTokenCodeHash == bytes32(0)
                || proposed.accountingToken.codehash != proposed.expectedTokenCodeHash
                || proposed.grossCapQuoteAtoms == 0 || proposed.netCapQuoteAtoms == 0
                || proposed.netCapQuoteAtoms > proposed.grossCapQuoteAtoms || proposed.minimumMarginFloorQuoteAtoms == 0
                || proposed.minimumMarginFloorQuoteAtoms > proposed.grossCapQuoteAtoms
                || proposed.maximumLeverageBps == 0 || proposed.maximumLeverageBps > MAXIMUM_LEVERAGE_BPS
                || proposed.maximumStalenessMs == 0 || proposed.maximumTimeToUnwindMs == 0
                || proposed.requiredRecoveryReserveQuoteAtoms == 0
                || proposed.requiredRecoveryReserveQuoteAtoms > proposed.grossCapQuoteAtoms
                || proposed.aggregateHaircutBps > 10_000 || series.length == 0 || series.length > MAXIMUM_SERIES
                || dependencies.length == 0 || dependencies.length > MAXIMUM_DEPENDENCIES
        ) revert InvalidPolicy();
        (, uint32 activeDomainManifestVersion, bytes32 activeDomainManifestHash) = config.domain();
        if (
            proposed.domainManifestVersion != activeDomainManifestVersion
                || proposed.domainManifestHash != activeDomainManifestHash
        ) revert InvalidPolicy();
        bytes32 previousSeriesKey;
        for (uint256 index; index < series.length; ++index) {
            bytes32 current = _seriesKey(series[index]);
            if (index != 0 && current <= previousSeriesKey) revert InvalidSeries();
            previousSeriesKey = current;
        }
        bytes32 previousDependency;
        for (uint256 index; index < dependencies.length; ++index) {
            DependencyLimit calldata limit = dependencies[index];
            if (
                limit.dependencyId == bytes32(0) || limit.maximumGrossQuoteAtoms == 0
                    || limit.maximumGrossQuoteAtoms > proposed.grossCapQuoteAtoms
                    || (index != 0 && limit.dependencyId <= previousDependency)
            ) revert InvalidDependency();
            previousDependency = limit.dependencyId;
        }
    }

    function _validateDependencies(
        bytes32 riskDomainId,
        uint32 manifestVersion,
        uint256 expectedCount,
        DependencyExposure[] calldata dependencies
    ) private view {
        if (dependencies.length != expectedCount) revert InvalidDependency();
        bytes32 previous;
        for (uint256 index; index < dependencies.length; ++index) {
            DependencyExposure calldata exposure = dependencies[index];
            if (exposure.dependencyId == bytes32(0) || (index != 0 && exposure.dependencyId <= previous)) {
                revert InvalidDependency();
            }
            uint256 cap = _dependencyCaps[riskDomainId][manifestVersion][exposure.dependencyId];
            if (cap == 0 || exposure.grossQuoteAtoms > cap) {
                revert DependencyLimitExceeded(exposure.dependencyId, cap, exposure.grossQuoteAtoms);
            }
            previous = exposure.dependencyId;
        }
    }

    function _requireDomain(PolicyConfig storage rules) private view {
        (, uint32 manifestVersion, bytes32 manifestHash) = config.domain();
        if (rules.domainManifestVersion != manifestVersion || rules.domainManifestHash != manifestHash) {
            revert PolicyMismatch();
        }
    }

    function _exactPolicy(bytes32 riskDomainId, uint32 manifestVersion, bytes32 manifestHash)
        private
        view
        returns (Policy storage record)
    {
        record = _policies[riskDomainId][manifestVersion];
        if (record.config.manifestVersion != manifestVersion || record.config.manifestHash != manifestHash) {
            revert PolicyMismatch();
        }
    }

    function _seriesKey(SeriesRef calldata series) private pure returns (bytes32) {
        if (series.seriesId == bytes32(0) || series.manifestVersion == 0 || series.manifestHash == bytes32(0)) {
            revert InvalidSeries();
        }
        return keccak256(abi.encode(series.seriesId, series.manifestVersion, series.manifestHash));
    }

    function _activationTimestamp() private view returns (uint64) {
        uint64 delay = config.configDelaySeconds();
        if (block.timestamp > uint256(type(uint64).max) - uint256(delay)) revert ActivationTimestampOverflow();
        return uint64(block.timestamp) + delay;
    }

    function _requireConfiguration() private view {
        if (block.chainid != deploymentChainId || address(config).codehash != configCodeHash) {
            revert InvalidConfiguration();
        }
    }

    function _requireRole(uint8 role) private view {
        (address proposer, address canceller, address executor, address pauser) = config.roles();
        address requiredRole = role == 0 ? proposer : role == 1 ? canceller : role == 2 ? executor : pauser;
        if (msg.sender != requiredRole) revert UnauthorizedRole(msg.sender, requiredRole);
    }
}
