// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {PackageQuoteShard} from "./PackageQuoteShard.sol";
import {ProtocolConfig} from "./ProtocolConfig.sol";

contract PackageQuoteShardRegistry {
    bytes32 public constant IDENTITY_PREFIX = keccak256("NARYX_PACKAGE_QUOTE_SHARD_IDENTITY_V1");
    bytes32 public constant RECORD_PREFIX = keccak256("NARYX_PACKAGE_QUOTE_SHARD_RECORD_V1");
    uint64 public constant HARD_MAX_HEARTBEAT_SECONDS = 7 days;
    uint16 public constant HARD_MAX_BATCH_SIZE = 128;
    uint32 public constant HARD_MAX_LEVEL_COUNT = 4096;

    enum Lifecycle {
        ACTIVE,
        ENTRY_PAUSED,
        ALL_PAUSED,
        DEPRECATED
    }

    struct ShardIdentity {
        bytes32 seriesManifestHash;
        bytes32 executionClassManifestHash;
        address solver;
    }

    struct ShardBinding {
        bytes32 identityKey;
        bytes32 seriesManifestHash;
        bytes32 executionClassManifestHash;
        address solver;
        uint32 manifestVersion;
        bytes32 manifestHash;
        address shard;
        bytes32 shardCodeHash;
        address consumer;
        bytes32 consumerCodeHash;
    }

    struct ShardReference {
        bytes32 identityKey;
        uint32 manifestVersion;
        bytes32 manifestHash;
        address shard;
        bytes32 shardCodeHash;
        address consumer;
        bytes32 consumerCodeHash;
    }

    struct PendingRegistration {
        bytes32 recordKey;
        uint64 activationTimestamp;
        bool exists;
    }

    struct PendingLifecycle {
        bytes32 recordKey;
        Lifecycle state;
        uint64 activationTimestamp;
        bool exists;
    }

    struct DomainPin {
        uint32 manifestVersion;
        bytes32 manifestHash;
    }

    error InvalidConfiguration();
    error DeploymentChanged();
    error DomainChanged();
    error UnauthorizedRole(address caller, address requiredRole);
    error InvalidIdentity();
    error InvalidManifest();
    error InvalidShard();
    error ShardCodeMismatch();
    error ActivationTimestampOverflow();
    error ManifestVersionNotIncreasing(uint32 latestVersion, uint32 proposedVersion);
    error RegistrationProposalExists();
    error RegistrationProposalMissing();
    error RegistrationProposalNotReady(uint64 activationTimestamp);
    error LifecycleProposalExists();
    error LifecycleProposalMissing();
    error LifecycleProposalNotReady(uint64 activationTimestamp);
    error ShardUnknown(bytes32 identityKey);
    error StaleProposal();
    error UnsafeImmediateLifecycleChange();
    error InvalidLifecycleRelaxation();
    error ShardReferenceMismatch(bytes32 identityKey);
    error EntryNotAllowed(bytes32 identityKey, Lifecycle state);

    event RegistrationProposed(
        address indexed actor,
        bytes32 indexed identityKey,
        uint32 indexed manifestVersion,
        bytes32 manifestHash,
        address shard,
        bytes32 shardCodeHash,
        address consumer,
        bytes32 consumerCodeHash,
        uint64 activationTimestamp
    );
    event RegistrationCancelled(
        address indexed actor, bytes32 indexed identityKey, uint32 indexed manifestVersion, bytes32 manifestHash
    );
    event ShardActivated(
        address indexed actor,
        bytes32 indexed identityKey,
        uint32 indexed manifestVersion,
        bytes32 manifestHash,
        address shard,
        bytes32 shardCodeHash,
        address consumer,
        bytes32 consumerCodeHash
    );
    event LifecycleProposed(
        address indexed actor, bytes32 indexed identityKey, Lifecycle state, uint64 activationTimestamp
    );
    event LifecycleProposalCancelled(address indexed actor, bytes32 indexed identityKey);
    event LifecycleActivated(address indexed actor, bytes32 indexed identityKey, Lifecycle state);
    event LifecycleTightened(address indexed actor, bytes32 indexed identityKey, Lifecycle state);

    ProtocolConfig public immutable config;
    uint256 public immutable deploymentChainId;
    bytes32 public immutable configCodeHash;
    bytes32 public immutable domainIdHash;
    uint64 public immutable configDelaySeconds;

    mapping(bytes32 identityKey => uint32 version) public latestVersion;
    mapping(bytes32 identityKey => bytes32 recordKey) private _currentRecords;
    mapping(bytes32 recordKey => ShardBinding binding) private _records;
    mapping(bytes32 recordKey => Lifecycle state) private _lifecycles;
    // The domain manifest each record was proposed under. A domain rotation retires every record
    // until it is registered again under the active domain, instead of retiring the registry that
    // the verifier pins by code hash.
    mapping(bytes32 recordKey => DomainPin domain) private _recordDomains;
    mapping(bytes32 recordKey => bool current) private _isCurrent;
    mapping(bytes32 identityKey => PendingRegistration proposal) private _pendingRegistrations;
    mapping(bytes32 identityKey => PendingLifecycle proposal) private _pendingLifecycles;

    constructor(ProtocolConfig config_) {
        if (address(config_).code.length == 0) revert InvalidConfiguration();
        (string memory domainId, uint32 manifestVersion, bytes32 manifestHash) = config_.domain();
        uint64 delaySeconds = config_.configDelaySeconds();
        if (bytes(domainId).length == 0 || manifestVersion == 0 || manifestHash == bytes32(0) || delaySeconds == 0) {
            revert InvalidConfiguration();
        }

        config = config_;
        deploymentChainId = block.chainid;
        configCodeHash = address(config_).codehash;
        domainIdHash = keccak256(bytes(domainId));
        configDelaySeconds = delaySeconds;
    }

    function identityKey(ShardIdentity calldata identity) external pure returns (bytes32) {
        return _identityKey(identity);
    }

    function proposeRegistration(
        ShardIdentity calldata identity,
        uint32 manifestVersion,
        bytes32 manifestHash,
        address shard,
        bytes32 shardCodeHash,
        address consumer,
        bytes32 consumerCodeHash
    ) external {
        DomainPin memory activeDomain = _assertConfig();
        _checkProposer();
        bytes32 key = _identityKey(identity);
        if (_pendingRegistrations[key].exists) revert RegistrationProposalExists();
        if (_pendingLifecycles[key].exists) revert LifecycleProposalExists();
        if (manifestVersion == 0 || manifestHash == bytes32(0)) revert InvalidManifest();
        uint32 latest = latestVersion[key];
        if (manifestVersion <= latest) revert ManifestVersionNotIncreasing(latest, manifestVersion);

        ShardBinding memory binding = ShardBinding({
            identityKey: key,
            seriesManifestHash: identity.seriesManifestHash,
            executionClassManifestHash: identity.executionClassManifestHash,
            solver: identity.solver,
            manifestVersion: manifestVersion,
            manifestHash: manifestHash,
            shard: shard,
            shardCodeHash: shardCodeHash,
            consumer: consumer,
            consumerCodeHash: consumerCodeHash
        });
        _validateShard(binding);

        bytes32 keyForRecord = _recordKey(key, manifestVersion);
        _records[keyForRecord] = binding;
        _recordDomains[keyForRecord] = activeDomain;
        latestVersion[key] = manifestVersion;
        uint64 activationTimestamp = _activationTimestamp();
        _pendingRegistrations[key] =
            PendingRegistration({recordKey: keyForRecord, activationTimestamp: activationTimestamp, exists: true});

        emit RegistrationProposed(
            msg.sender,
            key,
            manifestVersion,
            manifestHash,
            shard,
            shardCodeHash,
            consumer,
            consumerCodeHash,
            activationTimestamp
        );
    }

    function cancelRegistration(bytes32 key) external {
        _assertConfig();
        _checkCanceller();
        if (!_pendingRegistrations[key].exists) revert RegistrationProposalMissing();
        _cancelRegistration(key, msg.sender);
    }

    function activateRegistration(bytes32 key) external {
        DomainPin memory activeDomain = _assertConfig();
        _checkExecutor();
        PendingRegistration memory pending = _pendingRegistrations[key];
        if (!pending.exists) revert RegistrationProposalMissing();
        if (block.timestamp < pending.activationTimestamp) {
            revert RegistrationProposalNotReady(pending.activationTimestamp);
        }
        _requireRecordDomain(pending.recordKey, activeDomain);

        ShardBinding memory binding = _records[pending.recordKey];
        if (binding.identityKey != key) revert StaleProposal();
        _validateShard(binding);

        bytes32 previousRecord = _currentRecords[key];
        if (previousRecord != bytes32(0)) _isCurrent[previousRecord] = false;
        _currentRecords[key] = pending.recordKey;
        _isCurrent[pending.recordKey] = true;
        _lifecycles[pending.recordKey] = Lifecycle.ACTIVE;
        delete _pendingRegistrations[key];

        emit ShardActivated(
            msg.sender,
            key,
            binding.manifestVersion,
            binding.manifestHash,
            binding.shard,
            binding.shardCodeHash,
            binding.consumer,
            binding.consumerCodeHash
        );
    }

    function proposeLifecycle(bytes32 key, Lifecycle state) external {
        _assertConfig();
        _checkProposer();
        if (_pendingRegistrations[key].exists) revert RegistrationProposalExists();
        if (_pendingLifecycles[key].exists) revert LifecycleProposalExists();
        bytes32 currentRecord = _requireCurrent(key);
        Lifecycle currentState = _lifecycles[currentRecord];
        if (currentState == Lifecycle.DEPRECATED || uint8(state) >= uint8(currentState)) {
            revert InvalidLifecycleRelaxation();
        }

        uint64 activationTimestamp = _activationTimestamp();
        _pendingLifecycles[key] = PendingLifecycle({
            recordKey: currentRecord, state: state, activationTimestamp: activationTimestamp, exists: true
        });
        emit LifecycleProposed(msg.sender, key, state, activationTimestamp);
    }

    function cancelLifecycle(bytes32 key) external {
        _assertConfig();
        _checkCanceller();
        if (!_pendingLifecycles[key].exists) revert LifecycleProposalMissing();
        delete _pendingLifecycles[key];
        emit LifecycleProposalCancelled(msg.sender, key);
    }

    function activateLifecycle(bytes32 key) external {
        DomainPin memory activeDomain = _assertConfig();
        _checkExecutor();
        PendingLifecycle memory pending = _pendingLifecycles[key];
        if (!pending.exists) revert LifecycleProposalMissing();
        if (block.timestamp < pending.activationTimestamp) {
            revert LifecycleProposalNotReady(pending.activationTimestamp);
        }
        bytes32 currentRecord = _requireCurrent(key);
        if (pending.recordKey != currentRecord) revert StaleProposal();
        _requireRecordDomain(currentRecord, activeDomain);
        Lifecycle currentState = _lifecycles[currentRecord];
        if (currentState == Lifecycle.DEPRECATED || uint8(pending.state) >= uint8(currentState)) {
            revert InvalidLifecycleRelaxation();
        }
        _validateShard(_records[currentRecord]);

        _lifecycles[currentRecord] = pending.state;
        delete _pendingLifecycles[key];
        emit LifecycleActivated(msg.sender, key, pending.state);
    }

    function tightenLifecycle(bytes32 key, Lifecycle state) external {
        _assertConfig();
        _checkPauser();
        bytes32 currentRecord = _requireCurrent(key);
        Lifecycle currentState = _lifecycles[currentRecord];
        if (uint8(state) < uint8(currentState)) revert UnsafeImmediateLifecycleChange();

        if (_pendingRegistrations[key].exists) _cancelRegistration(key, msg.sender);
        if (_pendingLifecycles[key].exists) {
            delete _pendingLifecycles[key];
            emit LifecycleProposalCancelled(msg.sender, key);
        }
        _lifecycles[currentRecord] = state;
        emit LifecycleTightened(msg.sender, key, state);
    }

    function validateEntry(ShardReference calldata exactRef) external view returns (ShardBinding memory binding) {
        DomainPin memory activeDomain = _assertConfig();
        bytes32 currentRecord = _requireCurrent(exactRef.identityKey);
        _requireRecordDomain(currentRecord, activeDomain);
        binding = _records[currentRecord];
        if (
            binding.identityKey != exactRef.identityKey || binding.manifestVersion != exactRef.manifestVersion
                || binding.manifestHash != exactRef.manifestHash || binding.shard != exactRef.shard
                || binding.shardCodeHash != exactRef.shardCodeHash || binding.consumer != exactRef.consumer
                || binding.consumerCodeHash != exactRef.consumerCodeHash || !_isCurrent[currentRecord]
        ) revert ShardReferenceMismatch(exactRef.identityKey);
        Lifecycle state = _lifecycles[currentRecord];
        if (state != Lifecycle.ACTIVE) revert EntryNotAllowed(exactRef.identityKey, state);
        _validateShard(binding);
    }

    function activeShard(bytes32 key) external view returns (ShardBinding memory binding, Lifecycle state) {
        bytes32 currentRecord = _requireCurrent(key);
        return (_records[currentRecord], _lifecycles[currentRecord]);
    }

    function shardRecord(bytes32 key, uint32 manifestVersion)
        external
        view
        returns (ShardBinding memory binding, Lifecycle state, bool current)
    {
        bytes32 keyForRecord = _recordKey(key, manifestVersion);
        binding = _records[keyForRecord];
        if (binding.manifestVersion == 0) revert ShardUnknown(key);
        return (binding, _lifecycles[keyForRecord], _isCurrent[keyForRecord]);
    }

    function recordDomain(bytes32 key, uint32 manifestVersion) external view returns (DomainPin memory) {
        bytes32 keyForRecord = _recordKey(key, manifestVersion);
        if (_records[keyForRecord].manifestVersion == 0) revert ShardUnknown(key);
        return _recordDomains[keyForRecord];
    }

    function pendingRegistration(bytes32 key) external view returns (PendingRegistration memory) {
        return _pendingRegistrations[key];
    }

    function pendingLifecycle(bytes32 key) external view returns (PendingLifecycle memory) {
        return _pendingLifecycles[key];
    }

    function _assertConfig() private view returns (DomainPin memory activeDomain) {
        if (
            block.chainid != deploymentChainId || address(config).code.length == 0
                || address(config).codehash != configCodeHash || config.configDelaySeconds() != configDelaySeconds
        ) revert DeploymentChanged();
        (string memory domainId, uint32 manifestVersion, bytes32 manifestHash) = config.domain();
        if (keccak256(bytes(domainId)) != domainIdHash || manifestVersion == 0 || manifestHash == bytes32(0)) {
            revert DomainChanged();
        }
        activeDomain = DomainPin({manifestVersion: manifestVersion, manifestHash: manifestHash});
    }

    function _requireRecordDomain(bytes32 recordKey, DomainPin memory activeDomain) private view {
        DomainPin memory pinned = _recordDomains[recordKey];
        if (pinned.manifestVersion != activeDomain.manifestVersion || pinned.manifestHash != activeDomain.manifestHash)
        {
            revert DomainChanged();
        }
    }

    function _validateShard(ShardBinding memory binding) private view {
        if (
            binding.identityKey == bytes32(0) || binding.seriesManifestHash == bytes32(0)
                || binding.executionClassManifestHash == bytes32(0) || binding.solver == address(0)
                || binding.manifestVersion == 0 || binding.manifestHash == bytes32(0)
                || binding.shardCodeHash == bytes32(0) || binding.consumer.code.length == 0
                || binding.consumerCodeHash == bytes32(0) || binding.consumer.codehash != binding.consumerCodeHash
        ) revert InvalidShard();
        if (binding.shard.code.length == 0 || binding.shard.codehash != binding.shardCodeHash) {
            revert ShardCodeMismatch();
        }
        if (
            binding.identityKey
                != keccak256(
                    abi.encode(
                        IDENTITY_PREFIX, binding.seriesManifestHash, binding.executionClassManifestHash, binding.solver
                    )
                )
        ) revert InvalidIdentity();

        PackageQuoteShard shard = PackageQuoteShard(binding.shard);
        uint64 heartbeat = shard.maxHeartbeatSeconds();
        uint16 batchSize = shard.maxBatchSize();
        uint32 levelCount = shard.maxLevelCount();
        if (
            shard.deploymentChainId() != deploymentChainId || shard.config() != address(config)
                || shard.configCodeHash() != configCodeHash || shard.solver() != binding.solver
                || shard.seriesManifestHash() != binding.seriesManifestHash
                || shard.executionClassManifestHash() != binding.executionClassManifestHash
                || shard.consumer() != binding.consumer || shard.consumerCodeHash() != binding.consumerCodeHash
                || heartbeat == 0 || heartbeat > HARD_MAX_HEARTBEAT_SECONDS || batchSize == 0
                || batchSize > HARD_MAX_BATCH_SIZE || levelCount == 0 || levelCount > HARD_MAX_LEVEL_COUNT
                || batchSize > levelCount
        ) revert InvalidShard();
    }

    function _requireCurrent(bytes32 key) private view returns (bytes32 currentRecord) {
        currentRecord = _currentRecords[key];
        if (currentRecord == bytes32(0)) revert ShardUnknown(key);
    }

    function _cancelRegistration(bytes32 key, address actor) private {
        PendingRegistration memory pending = _pendingRegistrations[key];
        ShardBinding memory binding = _records[pending.recordKey];
        delete _pendingRegistrations[key];
        emit RegistrationCancelled(actor, key, binding.manifestVersion, binding.manifestHash);
    }

    function _identityKey(ShardIdentity memory identity) private pure returns (bytes32) {
        if (
            identity.seriesManifestHash == bytes32(0) || identity.executionClassManifestHash == bytes32(0)
                || identity.solver == address(0)
        ) revert InvalidIdentity();
        return keccak256(
            abi.encode(
                IDENTITY_PREFIX, identity.seriesManifestHash, identity.executionClassManifestHash, identity.solver
            )
        );
    }

    function _recordKey(bytes32 key, uint32 manifestVersion) private pure returns (bytes32) {
        return keccak256(abi.encode(RECORD_PREFIX, key, manifestVersion));
    }

    function _activationTimestamp() private view returns (uint64) {
        if (block.timestamp > uint256(type(uint64).max) - uint256(configDelaySeconds)) {
            revert ActivationTimestampOverflow();
        }
        return uint64(block.timestamp) + configDelaySeconds;
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
