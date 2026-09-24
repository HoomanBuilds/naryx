// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ProtocolConfig} from "./ProtocolConfig.sol";
import {ResourceRegistry} from "./ResourceRegistry.sol";

contract CashCarrySeriesRegistry {
    string private constant PROTOCOL_ID_IDENTITY_DOMAIN = "CON/v1/protocol-id-identity";
    string private constant DOMAIN_REF_IDENTITY_DOMAIN = "CON/v1/domain-ref-identity";
    string private constant SETTLEMENT_CLASS_IDENTITY_DOMAIN = "CON/v1/settlement-class-identity";
    string private constant SERIES_IDENTITY_DOMAIN = "CON/v1/cash-carry-series-identity";
    string private constant BINDING_HASH_DOMAIN = "CON/v1/cash-carry-series-binding";
    string private constant RECORD_KEY_DOMAIN = "CON/v1/cash-carry-series-record";

    uint32 public constant SCHEMA_VERSION = 1;
    uint32 public constant TEMPLATE_VERSION = 1;
    uint32 public constant SETTLEMENT_CLASS_VERSION = 1;
    uint8 public constant ATOMIC_POSTCONDITION = 1;
    uint8 public constant ENTRY_SIDE_ASK = 1;

    enum Lifecycle {
        ACTIVE,
        ENTRY_PAUSED,
        ALL_PAUSED,
        DEPRECATED
    }

    struct SeriesManifestRef {
        bytes32 subjectIdentity;
        uint32 manifestVersion;
        bytes32 manifestHash;
    }

    struct CashCarrySeriesBindingV1 {
        uint32 schemaVersion;
        uint32 bindingVersion;
        bytes32 domainRefIdentityHash;
        bytes32 seriesManifestHash;
        bytes32 executionClassManifestHash;
        bytes32 templateIdentityHash;
        uint32 templateVersion;
        bytes32 templateManifestHash;
        bytes32 settlementClassIdentityHash;
        SeriesManifestRef baseAsset;
        SeriesManifestRef quoteAsset;
        bytes32 quoteConventionIdentityHash;
        uint8 entrySide;
        uint128 spotBaseAtomsPerPackageUnit;
        uint128 perpQuantityAtomsPerPackageUnit;
    }

    struct BindingRecord {
        CashCarrySeriesBindingV1 binding;
        bytes32 bindingHash;
    }

    struct BindingReference {
        bytes32 identityKey;
        uint32 bindingVersion;
        bytes32 bindingHash;
    }

    struct PendingRegistration {
        bytes32 recordKey;
        uint64 activationTimestamp;
        bool exists;
    }

    struct PendingReactivation {
        bytes32 recordKey;
        uint64 activationTimestamp;
        bool exists;
    }

    error InvalidConfiguration();
    error DeploymentChanged();
    error DomainChanged();
    error UnauthorizedRole(address caller, address requiredRole);
    error InvalidBinding();
    error BindingHashMismatch(bytes32 expected, bytes32 actual);
    error EconomicSemanticsChanged(bytes32 identityKey);
    error AssetUnknown(bytes32 subjectIdentity);
    error AssetReferenceMismatch(bytes32 subjectIdentity);
    error AssetNotActive(bytes32 subjectIdentity, ResourceRegistry.Lifecycle state);
    error ActivationTimestampOverflow();
    error BindingVersionNotIncreasing(uint32 latestVersion, uint32 proposedVersion);
    error RegistrationProposalExists();
    error RegistrationProposalMissing();
    error RegistrationProposalNotReady(uint64 activationTimestamp);
    error ReactivationProposalExists();
    error ReactivationProposalMissing();
    error ReactivationProposalNotReady(uint64 activationTimestamp);
    error SeriesUnknown(bytes32 identityKey);
    error SeriesDeprecated(bytes32 identityKey);
    error StaleProposal();
    error UnsafeImmediateLifecycleChange();
    error InvalidReactivation();
    error BindingReferenceMismatch(bytes32 identityKey);
    error EntryNotAllowed(bytes32 identityKey, Lifecycle state);

    event RegistrationProposed(
        address indexed actor,
        bytes32 indexed identityKey,
        uint32 indexed bindingVersion,
        bytes32 bindingHash,
        uint64 activationTimestamp
    );
    event RegistrationCancelled(
        address indexed actor, bytes32 indexed identityKey, uint32 indexed bindingVersion, bytes32 bindingHash
    );
    event BindingActivated(
        address indexed actor,
        bytes32 indexed identityKey,
        uint32 indexed bindingVersion,
        bytes32 bindingHash,
        Lifecycle lifecycle
    );
    event ReactivationProposed(address indexed actor, bytes32 indexed identityKey, uint64 activationTimestamp);
    event ReactivationCancelled(address indexed actor, bytes32 indexed identityKey);
    event SeriesReactivated(address indexed actor, bytes32 indexed identityKey);
    event LifecycleTightened(address indexed actor, bytes32 indexed identityKey, Lifecycle state);

    ProtocolConfig public immutable config;
    ResourceRegistry public immutable resources;
    uint256 public immutable deploymentChainId;
    bytes32 public immutable configCodeHash;
    bytes32 public immutable resourceRegistryCodeHash;
    bytes32 public immutable deploymentDomainIdIdentityHash;
    bytes32 public immutable cashCarryTemplateManifestHash;
    uint64 public immutable configDelaySeconds;

    mapping(bytes32 identityKey => uint32 version) public latestVersion;
    mapping(bytes32 identityKey => bytes32 recordKey) private _anchorRecords;
    mapping(bytes32 identityKey => bytes32 recordKey) private _currentRecords;
    mapping(bytes32 recordKey => BindingRecord record) private _records;
    mapping(bytes32 recordKey => Lifecycle lifecycle) private _lifecycles;
    mapping(bytes32 recordKey => bool current) private _isCurrent;
    mapping(bytes32 identityKey => PendingRegistration proposal) private _pendingRegistrations;
    mapping(bytes32 identityKey => PendingReactivation proposal) private _pendingReactivations;
    mapping(bytes32 identityKey => bool deprecated) private _deprecated;

    constructor(ProtocolConfig config_, ResourceRegistry resources_) {
        if (address(config_).code.length == 0 || address(resources_).code.length == 0) {
            revert InvalidConfiguration();
        }
        (string memory domainId, uint32 manifestVersion, bytes32 manifestHash) = config_.domain();
        uint64 delaySeconds = config_.configDelaySeconds();
        if (
            bytes(domainId).length == 0 || manifestVersion == 0 || manifestHash == bytes32(0) || delaySeconds == 0
                || address(resources_.config()) != address(config_)
                || resources_.cashCarryTemplateManifestHash() == bytes32(0)
        ) revert InvalidConfiguration();

        config = config_;
        resources = resources_;
        deploymentChainId = block.chainid;
        configCodeHash = address(config_).codehash;
        resourceRegistryCodeHash = address(resources_).codehash;
        deploymentDomainIdIdentityHash = _protocolIdIdentityHash(domainId);
        cashCarryTemplateManifestHash = resources_.cashCarryTemplateManifestHash();
        configDelaySeconds = delaySeconds;
    }

    function cashCarryTemplateIdentityHash() public pure returns (bytes32) {
        return _protocolIdIdentityHash("cash-and-carry-v1");
    }

    function atomicPostconditionIdentityHash() public pure returns (bytes32) {
        return sha256(
            abi.encodePacked(
                bytes(SETTLEMENT_CLASS_IDENTITY_DOMAIN), bytes1(ATOMIC_POSTCONDITION), bytes4(SETTLEMENT_CLASS_VERSION)
            )
        );
    }

    function annualizedNetYieldIdentityHash() public pure returns (bytes32) {
        return _protocolIdIdentityHash("annualized-net-yield-v1");
    }

    function currentDomainRefIdentityHash() public view returns (bytes32) {
        (string memory domainId, uint32 manifestVersion, bytes32 manifestHash) = config.domain();
        return _domainRefIdentityHash(domainId, manifestVersion, manifestHash);
    }

    function identityKey(CashCarrySeriesBindingV1 calldata binding) external pure returns (bytes32) {
        return _identityKey(binding);
    }

    function bindingHash(CashCarrySeriesBindingV1 calldata binding) external pure returns (bytes32) {
        return _bindingHash(binding);
    }

    function proposeRegistration(CashCarrySeriesBindingV1 calldata binding, bytes32 expectedBindingHash) external {
        _assertDeployment();
        _checkProposer();
        _validateBinding(binding);

        bytes32 key = _identityKey(binding);
        if (_deprecated[key]) revert SeriesDeprecated(key);
        if (_pendingRegistrations[key].exists) revert RegistrationProposalExists();
        if (_pendingReactivations[key].exists) revert ReactivationProposalExists();
        uint32 latest = latestVersion[key];
        if (binding.bindingVersion <= latest) {
            revert BindingVersionNotIncreasing(latest, binding.bindingVersion);
        }

        bytes32 actualBindingHash = _bindingHash(binding);
        if (expectedBindingHash == bytes32(0) || expectedBindingHash != actualBindingHash) {
            revert BindingHashMismatch(expectedBindingHash, actualBindingHash);
        }
        bytes32 anchorRecord = _anchorRecords[key];
        if (anchorRecord != bytes32(0) && !_sameEconomicSemantics(_records[anchorRecord].binding, binding)) {
            revert EconomicSemanticsChanged(key);
        }

        bytes32 keyForRecord = _recordKey(key, binding.bindingVersion);
        _records[keyForRecord] = BindingRecord({binding: binding, bindingHash: actualBindingHash});
        if (anchorRecord == bytes32(0)) _anchorRecords[key] = keyForRecord;
        latestVersion[key] = binding.bindingVersion;
        uint64 activationTimestamp = _activationTimestamp();
        _pendingRegistrations[key] =
            PendingRegistration({recordKey: keyForRecord, activationTimestamp: activationTimestamp, exists: true});

        emit RegistrationProposed(msg.sender, key, binding.bindingVersion, actualBindingHash, activationTimestamp);
    }

    function cancelRegistration(bytes32 key) external {
        _assertDeployment();
        _checkCanceller();
        if (!_pendingRegistrations[key].exists) revert RegistrationProposalMissing();
        _cancelRegistration(key, msg.sender);
    }

    function activateRegistration(bytes32 key) external {
        _assertDeployment();
        _checkExecutor();
        PendingRegistration memory pending = _pendingRegistrations[key];
        if (!pending.exists) revert RegistrationProposalMissing();
        if (block.timestamp < pending.activationTimestamp) {
            revert RegistrationProposalNotReady(pending.activationTimestamp);
        }

        BindingRecord memory record = _records[pending.recordKey];
        if (_identityKey(record.binding) != key || _bindingHash(record.binding) != record.bindingHash) {
            revert StaleProposal();
        }
        _validateBinding(record.binding);
        bytes32 anchorRecord = _anchorRecords[key];
        if (anchorRecord == bytes32(0) || !_sameEconomicSemantics(_records[anchorRecord].binding, record.binding)) {
            revert EconomicSemanticsChanged(key);
        }

        bytes32 previousRecord = _currentRecords[key];
        Lifecycle lifecycle = previousRecord == bytes32(0) ? Lifecycle.ACTIVE : _lifecycles[previousRecord];
        if (lifecycle == Lifecycle.DEPRECATED || _deprecated[key]) revert SeriesDeprecated(key);
        if (previousRecord != bytes32(0)) _isCurrent[previousRecord] = false;
        _currentRecords[key] = pending.recordKey;
        _isCurrent[pending.recordKey] = true;
        _lifecycles[pending.recordKey] = lifecycle;
        delete _pendingRegistrations[key];

        emit BindingActivated(msg.sender, key, record.binding.bindingVersion, record.bindingHash, lifecycle);
    }

    function proposeReactivation(bytes32 key) external {
        _assertDeployment();
        _checkProposer();
        if (_pendingRegistrations[key].exists) revert RegistrationProposalExists();
        if (_pendingReactivations[key].exists) revert ReactivationProposalExists();
        bytes32 currentRecord = _requireCurrent(key);
        Lifecycle lifecycle = _lifecycles[currentRecord];
        if (lifecycle == Lifecycle.ACTIVE || lifecycle == Lifecycle.DEPRECATED || _deprecated[key]) {
            revert InvalidReactivation();
        }

        uint64 activationTimestamp = _activationTimestamp();
        _pendingReactivations[key] =
            PendingReactivation({recordKey: currentRecord, activationTimestamp: activationTimestamp, exists: true});
        emit ReactivationProposed(msg.sender, key, activationTimestamp);
    }

    function cancelReactivation(bytes32 key) external {
        _assertDeployment();
        _checkCanceller();
        if (!_pendingReactivations[key].exists) revert ReactivationProposalMissing();
        delete _pendingReactivations[key];
        emit ReactivationCancelled(msg.sender, key);
    }

    function activateReactivation(bytes32 key) external {
        _assertDeployment();
        _checkExecutor();
        PendingReactivation memory pending = _pendingReactivations[key];
        if (!pending.exists) revert ReactivationProposalMissing();
        if (block.timestamp < pending.activationTimestamp) {
            revert ReactivationProposalNotReady(pending.activationTimestamp);
        }
        bytes32 currentRecord = _requireCurrent(key);
        if (currentRecord != pending.recordKey) revert StaleProposal();
        Lifecycle lifecycle = _lifecycles[currentRecord];
        if (lifecycle == Lifecycle.ACTIVE || lifecycle == Lifecycle.DEPRECATED || _deprecated[key]) {
            revert InvalidReactivation();
        }
        BindingRecord memory record = _records[currentRecord];
        _validateBinding(record.binding);
        if (_bindingHash(record.binding) != record.bindingHash) revert StaleProposal();

        _lifecycles[currentRecord] = Lifecycle.ACTIVE;
        delete _pendingReactivations[key];
        emit SeriesReactivated(msg.sender, key);
    }

    function tightenLifecycle(bytes32 key, Lifecycle state) external {
        _assertDeployment();
        _checkPauser();
        bytes32 currentRecord = _requireCurrent(key);
        Lifecycle current = _lifecycles[currentRecord];
        if (uint8(state) < uint8(current)) revert UnsafeImmediateLifecycleChange();

        if (_pendingRegistrations[key].exists) _cancelRegistration(key, msg.sender);
        if (_pendingReactivations[key].exists) {
            delete _pendingReactivations[key];
            emit ReactivationCancelled(msg.sender, key);
        }
        _lifecycles[currentRecord] = state;
        if (state == Lifecycle.DEPRECATED) _deprecated[key] = true;
        emit LifecycleTightened(msg.sender, key, state);
    }

    function validateEntry(BindingReference calldata exactRef)
        external
        view
        returns (CashCarrySeriesBindingV1 memory binding)
    {
        _assertDeployment();
        bytes32 currentRecord = _requireCurrent(exactRef.identityKey);
        BindingRecord memory record = _records[currentRecord];
        if (
            record.binding.bindingVersion != exactRef.bindingVersion || record.bindingHash != exactRef.bindingHash
                || !_isCurrent[currentRecord] || _identityKey(record.binding) != exactRef.identityKey
                || _bindingHash(record.binding) != record.bindingHash
        ) revert BindingReferenceMismatch(exactRef.identityKey);
        Lifecycle lifecycle = _lifecycles[currentRecord];
        if (lifecycle != Lifecycle.ACTIVE) revert EntryNotAllowed(exactRef.identityKey, lifecycle);
        _validateBinding(record.binding);
        return record.binding;
    }

    function activeBinding(bytes32 key)
        external
        view
        returns (CashCarrySeriesBindingV1 memory binding, bytes32 hash, Lifecycle lifecycle)
    {
        _assertDeployment();
        bytes32 currentRecord = _requireCurrent(key);
        BindingRecord memory record = _records[currentRecord];
        return (record.binding, record.bindingHash, _lifecycles[currentRecord]);
    }

    function bindingRecord(bytes32 key, uint32 bindingVersion)
        external
        view
        returns (CashCarrySeriesBindingV1 memory binding, bytes32 hash, Lifecycle lifecycle, bool current)
    {
        bytes32 keyForRecord = _recordKey(key, bindingVersion);
        BindingRecord memory record = _records[keyForRecord];
        if (record.binding.bindingVersion == 0) revert SeriesUnknown(key);
        return (record.binding, record.bindingHash, _lifecycles[keyForRecord], _isCurrent[keyForRecord]);
    }

    function pendingRegistration(bytes32 key) external view returns (PendingRegistration memory) {
        return _pendingRegistrations[key];
    }

    function pendingReactivation(bytes32 key) external view returns (PendingReactivation memory) {
        return _pendingReactivations[key];
    }

    function _assertDeployment() private view {
        if (
            block.chainid != deploymentChainId || address(config).code.length == 0
                || address(config).codehash != configCodeHash || config.configDelaySeconds() != configDelaySeconds
                || address(resources).code.length == 0 || address(resources).codehash != resourceRegistryCodeHash
                || address(resources.config()) != address(config)
                || resources.cashCarryTemplateManifestHash() != cashCarryTemplateManifestHash
        ) revert DeploymentChanged();
        (string memory domainId, uint32 manifestVersion, bytes32 manifestHash) = config.domain();
        if (
            _protocolIdIdentityHash(domainId) != deploymentDomainIdIdentityHash || manifestVersion == 0
                || manifestHash == bytes32(0)
        ) {
            revert DomainChanged();
        }
    }

    function _validateBinding(CashCarrySeriesBindingV1 memory binding) private view {
        if (
            binding.schemaVersion != SCHEMA_VERSION || binding.bindingVersion == 0
                || binding.domainRefIdentityHash != currentDomainRefIdentityHash()
                || binding.seriesManifestHash == bytes32(0) || binding.executionClassManifestHash == bytes32(0)
                || binding.templateIdentityHash != cashCarryTemplateIdentityHash()
                || binding.templateVersion != TEMPLATE_VERSION
                || binding.templateManifestHash != cashCarryTemplateManifestHash
                || binding.settlementClassIdentityHash != atomicPostconditionIdentityHash()
                || binding.baseAsset.subjectIdentity == bytes32(0) || binding.baseAsset.manifestVersion == 0
                || binding.baseAsset.manifestHash == bytes32(0) || binding.quoteAsset.subjectIdentity == bytes32(0)
                || binding.quoteAsset.manifestVersion == 0 || binding.quoteAsset.manifestHash == bytes32(0)
                || binding.baseAsset.subjectIdentity == binding.quoteAsset.subjectIdentity
                || binding.quoteConventionIdentityHash != annualizedNetYieldIdentityHash()
                || binding.entrySide != ENTRY_SIDE_ASK || binding.spotBaseAtomsPerPackageUnit == 0
                || binding.perpQuantityAtomsPerPackageUnit == 0
        ) revert InvalidBinding();

        _validateAsset(binding.baseAsset);
        _validateAsset(binding.quoteAsset);
    }

    function _validateAsset(SeriesManifestRef memory exactRef) private view {
        try resources.activeResource(ResourceRegistry.ResourceKind.ASSET, exactRef.subjectIdentity) returns (
            ResourceRegistry.ResourceBinding memory binding, ResourceRegistry.ResourceControl memory control
        ) {
            if (
                binding.identity.subjectId != exactRef.subjectIdentity
                    || binding.identity.manifestVersion != exactRef.manifestVersion
                    || binding.identity.manifestHash != exactRef.manifestHash || binding.localAddress.code.length == 0
                    || binding.localAddress.codehash != binding.expectedCodeHash
            ) revert AssetReferenceMismatch(exactRef.subjectIdentity);
            if (control.state != ResourceRegistry.Lifecycle.ACTIVE) {
                revert AssetNotActive(exactRef.subjectIdentity, control.state);
            }
        } catch (bytes memory reason) {
            if (reason.length == 0) revert AssetUnknown(exactRef.subjectIdentity);
            assembly ("memory-safe") {
                revert(add(reason, 0x20), mload(reason))
            }
        }
    }

    function _sameEconomicSemantics(CashCarrySeriesBindingV1 memory anchor, CashCarrySeriesBindingV1 memory candidate)
        private
        pure
        returns (bool)
    {
        return anchor.schemaVersion == candidate.schemaVersion
            && anchor.domainRefIdentityHash == candidate.domainRefIdentityHash
            && anchor.seriesManifestHash == candidate.seriesManifestHash
            && anchor.executionClassManifestHash == candidate.executionClassManifestHash
            && anchor.templateIdentityHash == candidate.templateIdentityHash
            && anchor.templateVersion == candidate.templateVersion
            && anchor.templateManifestHash == candidate.templateManifestHash
            && anchor.settlementClassIdentityHash == candidate.settlementClassIdentityHash
            && anchor.baseAsset.subjectIdentity == candidate.baseAsset.subjectIdentity
            && anchor.quoteAsset.subjectIdentity == candidate.quoteAsset.subjectIdentity
            && anchor.quoteConventionIdentityHash == candidate.quoteConventionIdentityHash
            && anchor.entrySide == candidate.entrySide
            && anchor.spotBaseAtomsPerPackageUnit == candidate.spotBaseAtomsPerPackageUnit
            && anchor.perpQuantityAtomsPerPackageUnit == candidate.perpQuantityAtomsPerPackageUnit;
    }

    function _identityKey(CashCarrySeriesBindingV1 memory binding) private pure returns (bytes32) {
        if (
            binding.domainRefIdentityHash == bytes32(0) || binding.seriesManifestHash == bytes32(0)
                || binding.executionClassManifestHash == bytes32(0)
        ) revert InvalidBinding();
        return sha256(
            abi.encodePacked(
                bytes(SERIES_IDENTITY_DOMAIN),
                binding.domainRefIdentityHash,
                binding.seriesManifestHash,
                binding.executionClassManifestHash
            )
        );
    }

    function _bindingHash(CashCarrySeriesBindingV1 memory binding) private pure returns (bytes32) {
        return sha256(
            abi.encodePacked(
                bytes(BINDING_HASH_DOMAIN),
                _bindingHeaderBytes(binding),
                _bindingAssetBytes(binding),
                _bindingTailBytes(binding)
            )
        );
    }

    function _bindingHeaderBytes(CashCarrySeriesBindingV1 memory binding) private pure returns (bytes memory) {
        return abi.encodePacked(
            bytes4(binding.schemaVersion),
            bytes4(binding.bindingVersion),
            binding.domainRefIdentityHash,
            binding.seriesManifestHash,
            binding.executionClassManifestHash,
            binding.templateIdentityHash,
            bytes4(binding.templateVersion),
            binding.templateManifestHash,
            binding.settlementClassIdentityHash
        );
    }

    function _bindingAssetBytes(CashCarrySeriesBindingV1 memory binding) private pure returns (bytes memory) {
        return abi.encodePacked(
            binding.baseAsset.subjectIdentity,
            bytes4(binding.baseAsset.manifestVersion),
            binding.baseAsset.manifestHash,
            binding.quoteAsset.subjectIdentity,
            bytes4(binding.quoteAsset.manifestVersion),
            binding.quoteAsset.manifestHash
        );
    }

    function _bindingTailBytes(CashCarrySeriesBindingV1 memory binding) private pure returns (bytes memory) {
        return abi.encodePacked(
            binding.quoteConventionIdentityHash,
            bytes1(binding.entrySide),
            bytes16(binding.spotBaseAtomsPerPackageUnit),
            bytes16(binding.perpQuantityAtomsPerPackageUnit)
        );
    }

    function _recordKey(bytes32 key, uint32 bindingVersion) private pure returns (bytes32) {
        return sha256(abi.encodePacked(bytes(RECORD_KEY_DOMAIN), key, bytes4(bindingVersion)));
    }

    function _protocolIdIdentityHash(string memory value) private pure returns (bytes32) {
        bytes memory raw = bytes(value);
        return sha256(abi.encodePacked(bytes(PROTOCOL_ID_IDENTITY_DOMAIN), bytes4(uint32(raw.length)), raw));
    }

    function _domainRefIdentityHash(string memory domainId, uint32 manifestVersion, bytes32 manifestHash)
        private
        pure
        returns (bytes32)
    {
        bytes memory raw = bytes(domainId);
        return sha256(
            abi.encodePacked(
                bytes(DOMAIN_REF_IDENTITY_DOMAIN),
                bytes4(uint32(raw.length)),
                raw,
                bytes4(manifestVersion),
                manifestHash
            )
        );
    }

    function _requireCurrent(bytes32 key) private view returns (bytes32 currentRecord) {
        currentRecord = _currentRecords[key];
        if (currentRecord == bytes32(0)) revert SeriesUnknown(key);
    }

    function _activationTimestamp() private view returns (uint64) {
        if (block.timestamp > uint256(type(uint64).max) - uint256(configDelaySeconds)) {
            revert ActivationTimestampOverflow();
        }
        return uint64(block.timestamp) + configDelaySeconds;
    }

    function _cancelRegistration(bytes32 key, address actor) private {
        PendingRegistration memory pending = _pendingRegistrations[key];
        BindingRecord memory record = _records[pending.recordKey];
        delete _pendingRegistrations[key];
        emit RegistrationCancelled(actor, key, record.binding.bindingVersion, record.bindingHash);
    }

    function _checkProposer() private view {
        (address proposer,,,) = config.roles();
        _checkRole(proposer);
    }

    function _checkCanceller() private view {
        (, address canceller,,) = config.roles();
        _checkRole(canceller);
    }

    function _checkExecutor() private view {
        (,, address executor,) = config.roles();
        _checkRole(executor);
    }

    function _checkPauser() private view {
        (,,, address pauser) = config.roles();
        _checkRole(pauser);
    }

    function _checkRole(address requiredRole) private view {
        if (msg.sender != requiredRole) revert UnauthorizedRole(msg.sender, requiredRole);
    }
}
