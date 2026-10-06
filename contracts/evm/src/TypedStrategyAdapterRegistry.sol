// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ProtocolConfig} from "./ProtocolConfig.sol";
import {ITypedStrategyAdapter} from "./interfaces/ITypedStrategyAdapter.sol";
import {ITypedStrategyAdapterFactory} from "./interfaces/ITypedStrategyAdapterFactory.sol";

contract TypedStrategyAdapterRegistry {
    bytes32 public constant ATOMIC_POSTCONDITION_ID = keccak256("ATOMIC_POSTCONDITION");
    uint32 public constant ATOMIC_POSTCONDITION_VERSION = 1;

    enum Lifecycle {
        ACTIVE,
        ENTRY_PAUSED,
        EXIT_ONLY,
        ALL_PAUSED,
        DEPRECATED
    }

    enum AdapterMode {
        DIRECT,
        FACTORY
    }

    struct DomainRef {
        bytes32 domainIdHash;
        uint32 manifestVersion;
        bytes32 manifestHash;
    }

    struct ManifestRef {
        bytes32 subjectId;
        uint32 manifestVersion;
        bytes32 manifestHash;
    }

    struct TemplateRef {
        bytes32 templateId;
        uint32 templateVersion;
        bytes32 templateManifestHash;
    }

    struct SettlementClassRef {
        bytes32 classId;
        uint32 classVersion;
    }

    struct AssetBinding {
        address token;
        bytes32 expectedCodeHash;
    }

    struct AdapterBinding {
        DomainRef domain;
        ManifestRef identity;
        AdapterMode mode;
        address adapter;
        bytes32 expectedCodeHash;
        bytes32 adapterClassId;
        uint32 adapterClassVersion;
        TemplateRef template;
        SettlementClassRef settlementClass;
        AssetBinding baseAsset;
        AssetBinding quoteAsset;
        uint256 maximumGasLimit;
    }

    struct AdapterControl {
        Lifecycle state;
        uint256 maximumApprovalAtoms;
        uint256 maximumGrossNotionalAtoms;
    }

    struct CallContext {
        address target;
        bytes32 packageId;
        bool riskIncreasing;
        address approvalToken;
        uint256 approvalAtoms;
        uint256 grossNotionalAtoms;
        uint256 gasLimit;
    }

    struct PendingRegistration {
        AdapterBinding binding;
        AdapterControl control;
        uint64 activationTimestamp;
        bool exists;
    }

    error InvalidConfiguration();
    error InvalidBinding();
    error UnauthorizedRole(address caller, address requiredRole);
    error ActivationTimestampOverflow();
    error RegistrationProposalExists();
    error RegistrationProposalMissing();
    error RegistrationProposalNotReady(uint64 activationTimestamp);
    error ManifestVersionNotIncreasing(uint32 activeVersion, uint32 proposedVersion);
    error AdapterUnknown(bytes32 subjectId, uint32 manifestVersion);
    error AdapterMismatch();
    error AdapterCodeMismatch();
    error ActionNotAllowed(Lifecycle state);
    error UnsafeImmediateControlChange();

    event RegistrationProposed(
        address indexed actor,
        bytes32 indexed subjectId,
        uint32 indexed manifestVersion,
        bytes32 manifestHash,
        uint64 activationTimestamp
    );
    event RegistrationCancelled(address indexed actor, bytes32 indexed subjectId, uint32 indexed manifestVersion);
    event AdapterActivated(
        address indexed actor,
        bytes32 indexed subjectId,
        uint32 indexed manifestVersion,
        bytes32 manifestHash,
        address adapter,
        Lifecycle state
    );
    event AdapterControlTightened(
        address indexed actor,
        bytes32 indexed subjectId,
        uint32 indexed manifestVersion,
        Lifecycle state,
        uint256 maximumApprovalAtoms,
        uint256 maximumGrossNotionalAtoms
    );

    ProtocolConfig public immutable config;

    mapping(bytes32 recordKey => AdapterBinding binding) private _bindings;
    mapping(bytes32 recordKey => AdapterControl control) private _controls;
    mapping(bytes32 subjectId => ManifestRef identity) private _active;
    mapping(bytes32 subjectId => uint32 version) private _latestVersion;
    mapping(bytes32 subjectId => PendingRegistration pending) private _pending;

    constructor(ProtocolConfig config_) {
        if (address(config_).code.length == 0) revert InvalidConfiguration();
        config = config_;
    }

    function proposeRegistration(AdapterBinding calldata binding, AdapterControl calldata control) external {
        _checkRole(0);
        _validateBinding(binding, control);
        if (_pending[binding.identity.subjectId].exists) revert RegistrationProposalExists();
        uint32 latestVersion = _latestVersion[binding.identity.subjectId];
        if (binding.identity.manifestVersion <= latestVersion) {
            revert ManifestVersionNotIncreasing(latestVersion, binding.identity.manifestVersion);
        }
        uint64 activationTimestamp = _activationTimestamp();
        _pending[binding.identity.subjectId] = PendingRegistration(binding, control, activationTimestamp, true);
        emit RegistrationProposed(
            msg.sender,
            binding.identity.subjectId,
            binding.identity.manifestVersion,
            binding.identity.manifestHash,
            activationTimestamp
        );
    }

    function cancelRegistration(bytes32 subjectId) external {
        _checkRole(1);
        PendingRegistration memory pending = _pending[subjectId];
        if (!pending.exists) revert RegistrationProposalMissing();
        delete _pending[subjectId];
        emit RegistrationCancelled(msg.sender, subjectId, pending.binding.identity.manifestVersion);
    }

    function activateRegistration(bytes32 subjectId) external {
        _checkRole(2);
        PendingRegistration storage pending = _pending[subjectId];
        if (!pending.exists) revert RegistrationProposalMissing();
        if (block.timestamp < pending.activationTimestamp) {
            revert RegistrationProposalNotReady(pending.activationTimestamp);
        }
        AdapterBinding memory binding = pending.binding;
        AdapterControl memory control = pending.control;
        _validateBinding(binding, control);
        bytes32 key = _recordKey(binding.identity);
        _bindings[key] = binding;
        _controls[key] = control;
        _active[subjectId] = binding.identity;
        _latestVersion[subjectId] = binding.identity.manifestVersion;
        delete _pending[subjectId];
        emit AdapterActivated(
            msg.sender,
            subjectId,
            binding.identity.manifestVersion,
            binding.identity.manifestHash,
            binding.adapter,
            control.state
        );
    }

    function tightenControl(
        ManifestRef calldata identity,
        Lifecycle state,
        uint256 maximumApprovalAtoms,
        uint256 maximumGrossNotionalAtoms
    ) external {
        _checkRole(3);
        bytes32 key = _recordKey(identity);
        AdapterBinding storage binding = _bindings[key];
        if (binding.identity.manifestVersion == 0) {
            revert AdapterUnknown(identity.subjectId, identity.manifestVersion);
        }
        AdapterControl storage control = _controls[key];
        if (
            maximumApprovalAtoms > control.maximumApprovalAtoms
                || maximumGrossNotionalAtoms > control.maximumGrossNotionalAtoms
                || (_permissions(state) | _permissions(control.state)) != _permissions(control.state)
        ) revert UnsafeImmediateControlChange();
        control.state = state;
        control.maximumApprovalAtoms = maximumApprovalAtoms;
        control.maximumGrossNotionalAtoms = maximumGrossNotionalAtoms;
        emit AdapterControlTightened(
            msg.sender,
            identity.subjectId,
            identity.manifestVersion,
            state,
            maximumApprovalAtoms,
            maximumGrossNotionalAtoms
        );
    }

    function activeAdapter(bytes32 subjectId)
        external
        view
        returns (AdapterBinding memory binding, AdapterControl memory control)
    {
        ManifestRef memory identity = _active[subjectId];
        if (identity.manifestVersion == 0) revert AdapterUnknown(subjectId, 0);
        return (_bindings[_recordKey(identity)], _controls[_recordKey(identity)]);
    }

    function adapter(ManifestRef calldata identity)
        external
        view
        returns (AdapterBinding memory binding, AdapterControl memory control)
    {
        bytes32 key = _recordKey(identity);
        binding = _bindings[key];
        if (binding.identity.manifestVersion == 0) {
            revert AdapterUnknown(identity.subjectId, identity.manifestVersion);
        }
        return (binding, _controls[key]);
    }

    function validateCall(
        ManifestRef calldata identity,
        TemplateRef calldata template,
        SettlementClassRef calldata settlementClass,
        CallContext calldata context
    ) external view returns (address adapterAddress) {
        bytes32 key = _recordKey(identity);
        AdapterBinding storage binding = _bindings[key];
        if (binding.identity.manifestVersion == 0) {
            revert AdapterUnknown(identity.subjectId, identity.manifestVersion);
        }
        AdapterControl storage control = _controls[key];
        _validateDomain(binding.domain);
        if (
            !_sameManifest(binding.identity, identity) || !_sameTemplate(binding.template, template)
                || binding.settlementClass.classId != settlementClass.classId
                || binding.settlementClass.classVersion != settlementClass.classVersion
        ) revert AdapterMismatch();
        if (context.riskIncreasing && !_sameManifest(_active[identity.subjectId], identity)) revert AdapterMismatch();
        if (
            context.target == address(0) || context.packageId == bytes32(0) || binding.adapter.code.length == 0
                || binding.adapter.codehash != binding.expectedCodeHash
        ) {
            revert AdapterCodeMismatch();
        }
        if (binding.mode == AdapterMode.DIRECT) {
            if (context.target != binding.adapter) revert AdapterMismatch();
            (address strategyAccount,,,,) = ITypedStrategyAdapter(context.target).adapterMetadata();
            if (strategyAccount != msg.sender) revert AdapterMismatch();
        } else if (!ITypedStrategyAdapterFactory(binding.adapter)
                .validateInstance(context.target, msg.sender, context.packageId)) {
            revert AdapterMismatch();
        }
        if (
            binding.baseAsset.token.codehash != binding.baseAsset.expectedCodeHash
                || binding.quoteAsset.token.codehash != binding.quoteAsset.expectedCodeHash
        ) revert AdapterCodeMismatch();
        uint8 permission = context.riskIncreasing ? 1 : 2;
        if (_permissions(control.state) & permission == 0) revert ActionNotAllowed(control.state);
        if (context.grossNotionalAtoms == 0 || context.gasLimit == 0 || context.gasLimit > binding.maximumGasLimit) {
            revert AdapterMismatch();
        }
        if (
            context.riskIncreasing
                && (context.approvalAtoms > control.maximumApprovalAtoms
                    || context.grossNotionalAtoms > control.maximumGrossNotionalAtoms)
        ) revert AdapterMismatch();
        if (
            (context.approvalAtoms == 0 && context.approvalToken != address(0))
                || (context.approvalAtoms != 0
                    && context.approvalToken != binding.baseAsset.token
                    && context.approvalToken != binding.quoteAsset.token)
        ) revert AdapterMismatch();
        return context.target;
    }

    function pendingRegistration(bytes32 subjectId) external view returns (PendingRegistration memory) {
        return _pending[subjectId];
    }

    function _validateBinding(AdapterBinding memory binding, AdapterControl memory control) private view {
        _validateDomain(binding.domain);
        if (
            binding.identity.subjectId == bytes32(0) || binding.identity.manifestVersion == 0
                || binding.identity.manifestHash == bytes32(0) || binding.adapter == address(0)
                || binding.adapter.code.length == 0 || binding.adapter.codehash != binding.expectedCodeHash
                || !_implementedAdapterClass(binding.adapterClassId, binding.adapterClassVersion)
                || !_implementedTemplate(binding.template.templateId, binding.template.templateVersion)
                || binding.template.templateManifestHash == bytes32(0)
                || binding.settlementClass.classId != ATOMIC_POSTCONDITION_ID
                || binding.settlementClass.classVersion != ATOMIC_POSTCONDITION_VERSION
                || binding.baseAsset.token == address(0) || binding.quoteAsset.token == address(0)
                || binding.baseAsset.token == binding.quoteAsset.token || binding.baseAsset.token.code.length == 0
                || binding.quoteAsset.token.code.length == 0
                || binding.baseAsset.token.codehash != binding.baseAsset.expectedCodeHash
                || binding.quoteAsset.token.codehash != binding.quoteAsset.expectedCodeHash
                || binding.maximumGasLimit == 0 || control.maximumApprovalAtoms == 0
                || control.maximumGrossNotionalAtoms == 0
        ) revert InvalidBinding();

        if (binding.mode == AdapterMode.DIRECT) {
            (
                address strategyAccount,
                bytes32 adapterClassId,
                uint32 adapterClassVersion,
                address baseAsset,
                address quoteAsset
            ) = ITypedStrategyAdapter(binding.adapter).adapterMetadata();
            if (
                strategyAccount == address(0) || adapterClassId != binding.adapterClassId
                    || adapterClassVersion != binding.adapterClassVersion || baseAsset != binding.baseAsset.token
                    || quoteAsset != binding.quoteAsset.token
            ) revert InvalidBinding();
        } else {
            (bytes32 adapterClassId, uint32 adapterClassVersion, address baseAsset, address quoteAsset) =
                ITypedStrategyAdapterFactory(binding.adapter).factoryMetadata();
            if (
                adapterClassId != binding.adapterClassId || adapterClassVersion != binding.adapterClassVersion
                    || baseAsset != binding.baseAsset.token || quoteAsset != binding.quoteAsset.token
            ) revert InvalidBinding();
        }
    }

    function _implementedTemplate(bytes32 templateId, uint32 version) private pure returns (bool) {
        if (version != 1) return false;
        return templateId == keccak256("cash-and-carry-v1") || templateId == keccak256("reverse-cash-and-carry-v1")
            || templateId == keccak256("perpetual-funding-spread-v1") || templateId == keccak256("hedge-migration-v1")
            || templateId == keccak256("delta-neutral-rebalance-v1")
            || templateId == keccak256("treasury-inventory-hedge-v1") || templateId == keccak256("calendar-spread-v1")
            || templateId == keccak256("option-spread-v1") || templateId == keccak256("collateral-conversion-hedge-v1")
            || templateId == keccak256("fixed-rate-refinance-v1") || templateId == keccak256("sol-structured-hedge-v1")
            || templateId == keccak256("session-aware-tokenized-asset-v1");
    }

    function _implementedAdapterClass(bytes32 classId, uint32 version) private pure returns (bool) {
        if (version != 1) return false;
        return classId == keccak256("naryx.evm.spot-exact") || classId == keccak256("naryx.evm.perp-exact");
    }

    function _validateDomain(DomainRef memory domain) private view {
        (string memory domainId, uint32 version, bytes32 manifestHash) = config.domain();
        if (
            domain.domainIdHash != keccak256(bytes(domainId)) || domain.manifestVersion != version
                || domain.manifestHash != manifestHash
        ) revert InvalidBinding();
    }

    function _activationTimestamp() private view returns (uint64) {
        uint64 delay = config.configDelaySeconds();
        if (block.timestamp > uint256(type(uint64).max) - uint256(delay)) revert ActivationTimestampOverflow();
        uint64 timestamp = uint64(block.timestamp) + delay;
        return timestamp == 0 ? 1 : timestamp;
    }

    function _checkRole(uint8 role) private view {
        (address proposer, address canceller, address executor, address pauser) = config.roles();
        address required = role == 0 ? proposer : role == 1 ? canceller : role == 2 ? executor : pauser;
        if (msg.sender != required) revert UnauthorizedRole(msg.sender, required);
    }

    function _recordKey(ManifestRef memory identity) private pure returns (bytes32) {
        return keccak256(abi.encode(identity.subjectId, identity.manifestVersion, identity.manifestHash));
    }

    function _sameManifest(ManifestRef memory left, ManifestRef memory right) private pure returns (bool) {
        return left.subjectId == right.subjectId && left.manifestVersion == right.manifestVersion
            && left.manifestHash == right.manifestHash;
    }

    function _sameTemplate(TemplateRef memory left, TemplateRef memory right) private pure returns (bool) {
        return left.templateId == right.templateId && left.templateVersion == right.templateVersion
            && left.templateManifestHash == right.templateManifestHash;
    }

    function _permissions(Lifecycle state) private pure returns (uint8) {
        if (state == Lifecycle.ACTIVE) return 3;
        if (state == Lifecycle.ENTRY_PAUSED || state == Lifecycle.EXIT_ONLY || state == Lifecycle.DEPRECATED) return 2;
        return 0;
    }
}
