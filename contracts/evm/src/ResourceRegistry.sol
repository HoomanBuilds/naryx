// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20Metadata} from "openzeppelin-contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "openzeppelin-contracts/utils/math/Math.sol";
import {ProtocolConfig} from "./ProtocolConfig.sol";

contract ResourceRegistry {
    bytes32 public constant CASH_AND_CARRY_TEMPLATE_ID = keccak256("cash-and-carry-v1");
    uint32 public constant CASH_AND_CARRY_TEMPLATE_VERSION = 1;
    bytes32 public constant ATOMIC_POSTCONDITION_ID = keccak256("ATOMIC_POSTCONDITION");
    uint32 public constant ATOMIC_POSTCONDITION_VERSION = 1;
    bytes32 public constant BASE_SPOT_ADAPTER_CLASS = keccak256("base-strategy-spot-adapter-v1");
    bytes32 public constant BASE_PERP_PORT_CLASS = keccak256("base-strategy-perp-port-v1");
    uint32 public constant ADAPTER_CLASS_VERSION = 1;

    uint8 public constant ENTRY = 1;
    uint8 public constant EXIT = 2;

    enum ResourceKind {
        ASSET,
        VENUE,
        MARKET,
        ADAPTER
    }

    enum LegRole {
        NONE,
        SPOT,
        PERPETUAL
    }

    enum Lifecycle {
        ACTIVE,
        ENTRY_PAUSED,
        EXIT_ONLY,
        ALL_PAUSED,
        DEPRECATED
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

    struct MarketParameters {
        uint256 baseLotAtoms;
        uint256 quoteTickAtomsPerBaseLot;
        uint256 minimumQuoteNotionalAtoms;
        uint256 contractMultiplierNumerator;
        uint256 contractMultiplierDenominator;
        uint8 baseDecimals;
        uint8 quoteDecimals;
    }

    struct ResourceBinding {
        ResourceKind kind;
        DomainRef domain;
        ManifestRef identity;
        address localAddress;
        bytes32 expectedCodeHash;
        uint8 decimals;
        LegRole legRole;
        bytes32 adapterClassId;
        uint32 adapterClassVersion;
        ManifestRef venue;
        ManifestRef market;
        ManifestRef baseAsset;
        ManifestRef quoteAsset;
        MarketParameters marketParameters;
        TemplateRef allowedTemplate;
        SettlementClassRef settlementClass;
    }

    struct ResourceControl {
        Lifecycle state;
        ManifestRef quoteAsset;
        uint8 quoteDecimals;
        uint256 maximumPackageNotionalQuoteAtoms;
    }

    struct PendingRegistration {
        ResourceBinding binding;
        ResourceControl control;
        uint64 activationTimestamp;
        bool exists;
    }

    struct PendingControl {
        bytes32 recordKey;
        Lifecycle state;
        uint256 maximumPackageNotionalQuoteAtoms;
        uint64 activationTimestamp;
        bool exists;
    }

    struct ResourceRef {
        ManifestRef manifest;
        address localAddress;
        bytes32 expectedCodeHash;
    }

    struct AssetRef {
        ManifestRef manifest;
        address localAddress;
        bytes32 expectedCodeHash;
        uint8 decimals;
    }

    struct LegAdmission {
        ResourceRef adapter;
        bytes32 adapterClassId;
        uint32 adapterClassVersion;
        ResourceRef market;
        ResourceRef venue;
        uint256 quantityAtoms;
        uint256 limitQuoteAtomsPerBaseLot;
    }

    struct CashCarryAdmission {
        DomainRef domain;
        TemplateRef template;
        SettlementClassRef settlementClass;
        LegAdmission spot;
        LegAdmission perpetual;
        AssetRef baseAsset;
        AssetRef quoteAsset;
        uint8 action;
        uint256 packageNotionalQuoteAtoms;
    }

    error InvalidConfiguration();
    error UnauthorizedRole(address caller, address requiredRole);
    error ActivationTimestampOverflow();
    error InvalidBinding();
    error DomainMismatch();
    error ResourceUnknown(ResourceKind kind, bytes32 subjectId);
    error ResourceMismatch(ResourceKind kind, bytes32 subjectId);
    error ResourceCodeMismatch(ResourceKind kind, bytes32 subjectId);
    error AssetDecimalsMismatch(bytes32 subjectId);
    error ManifestVersionNotIncreasing(uint32 activeVersion, uint32 proposedVersion);
    error RegistrationProposalExists();
    error RegistrationProposalMissing();
    error RegistrationProposalNotReady(uint64 activationTimestamp);
    error ControlProposalExists();
    error ControlProposalMissing();
    error ControlProposalNotReady(uint64 activationTimestamp);
    error StaleControlProposal();
    error UnsafeImmediateControlChange();
    error ActionNotAllowed(ResourceKind kind, bytes32 subjectId, Lifecycle state);
    error InvalidAdmission();
    error PackageNotionalMismatch(uint256 expectedQuoteAtoms, uint256 providedQuoteAtoms);
    error PackageNotionalExceeded(uint256 maximumQuoteAtoms, uint256 requestedQuoteAtoms);

    event RegistrationProposed(
        address indexed actor,
        ResourceKind indexed kind,
        bytes32 indexed subjectId,
        uint32 manifestVersion,
        bytes32 manifestHash,
        uint64 activationTimestamp
    );
    event RegistrationCancelled(
        address indexed actor,
        ResourceKind indexed kind,
        bytes32 indexed subjectId,
        uint32 manifestVersion,
        bytes32 manifestHash
    );
    event ResourceActivated(
        address indexed actor,
        ResourceKind indexed kind,
        bytes32 indexed subjectId,
        uint32 manifestVersion,
        bytes32 manifestHash,
        bytes32 localBindingHash,
        Lifecycle state,
        uint256 maximumPackageNotionalQuoteAtoms
    );
    event ControlProposed(
        address indexed actor,
        ResourceKind indexed kind,
        bytes32 indexed subjectId,
        Lifecycle state,
        uint256 maximumPackageNotionalQuoteAtoms,
        uint64 activationTimestamp
    );
    event ControlProposalCancelled(address indexed actor, ResourceKind indexed kind, bytes32 indexed subjectId);
    event ControlActivated(
        address indexed actor,
        ResourceKind indexed kind,
        bytes32 indexed subjectId,
        Lifecycle state,
        uint256 maximumPackageNotionalQuoteAtoms
    );
    event ControlTightened(
        address indexed actor,
        ResourceKind indexed kind,
        bytes32 indexed subjectId,
        Lifecycle state,
        uint256 maximumPackageNotionalQuoteAtoms
    );

    ProtocolConfig public immutable config;

    mapping(bytes32 recordKey => ResourceBinding binding) private _records;
    mapping(bytes32 recordKey => ResourceControl control) private _controls;
    mapping(bytes32 subjectKey => ManifestRef manifest) private _active;
    mapping(bytes32 subjectKey => uint32 version) private _latestVersion;
    mapping(bytes32 subjectKey => PendingRegistration proposal) private _pendingRegistrations;
    mapping(bytes32 subjectKey => PendingControl proposal) private _pendingControls;

    constructor(ProtocolConfig config_) {
        if (address(config_).code.length == 0) revert InvalidConfiguration();
        config = config_;
    }

    /// @notice The active cash-and-carry template manifest hash, governed in `ProtocolConfig`. It is not an
    /// immutable so that this registry's code hash does not depend on it: the template commits to the domain
    /// manifest, which commits to the verifier code hash, which pins this registry's code hash.
    function cashCarryTemplateManifestHash() public view returns (bytes32) {
        return config.cashCarryTemplateManifestHash();
    }

    function proposeRegistration(ResourceBinding calldata binding, ResourceControl calldata control) external {
        _checkProposer();
        _validateBinding(binding, control);

        bytes32 subjectKey = _subjectKey(binding.kind, binding.identity.subjectId);
        if (_pendingRegistrations[subjectKey].exists) revert RegistrationProposalExists();
        if (_pendingControls[subjectKey].exists) revert ControlProposalExists();
        uint32 latestVersion = _latestVersion[subjectKey];
        if (binding.identity.manifestVersion <= latestVersion) {
            revert ManifestVersionNotIncreasing(latestVersion, binding.identity.manifestVersion);
        }

        uint64 activationTimestamp = _activationTimestamp();
        _pendingRegistrations[subjectKey] = PendingRegistration({
            binding: binding, control: control, activationTimestamp: activationTimestamp, exists: true
        });
        emit RegistrationProposed(
            msg.sender,
            binding.kind,
            binding.identity.subjectId,
            binding.identity.manifestVersion,
            binding.identity.manifestHash,
            activationTimestamp
        );
    }

    function cancelRegistration(ResourceKind kind, bytes32 subjectId) external {
        _checkCanceller();
        bytes32 subjectKey = _subjectKey(kind, subjectId);
        if (!_pendingRegistrations[subjectKey].exists) revert RegistrationProposalMissing();
        _cancelRegistration(subjectKey, msg.sender);
    }

    function activateRegistration(ResourceKind kind, bytes32 subjectId) external {
        _checkExecutor();
        bytes32 subjectKey = _subjectKey(kind, subjectId);
        PendingRegistration storage pending = _pendingRegistrations[subjectKey];
        if (!pending.exists) revert RegistrationProposalMissing();
        if (block.timestamp < pending.activationTimestamp) {
            revert RegistrationProposalNotReady(pending.activationTimestamp);
        }

        ResourceBinding memory binding = pending.binding;
        ResourceControl memory control = pending.control;
        _validateBinding(binding, control);
        bytes32 recordKey = _recordKey(kind, binding.identity);
        _records[recordKey] = binding;
        _controls[recordKey] = control;
        _active[subjectKey] = binding.identity;
        _latestVersion[subjectKey] = binding.identity.manifestVersion;
        delete _pendingRegistrations[subjectKey];
        bytes32 localBindingHash = _bindingHash(binding);
        emit ResourceActivated(
            msg.sender,
            kind,
            subjectId,
            binding.identity.manifestVersion,
            binding.identity.manifestHash,
            localBindingHash,
            control.state,
            control.maximumPackageNotionalQuoteAtoms
        );
    }

    function proposeControl(
        ResourceKind kind,
        bytes32 subjectId,
        Lifecycle state,
        uint256 maximumPackageNotionalQuoteAtoms
    ) external {
        _checkProposer();
        bytes32 subjectKey = _subjectKey(kind, subjectId);
        if (_pendingRegistrations[subjectKey].exists) revert RegistrationProposalExists();
        if (_pendingControls[subjectKey].exists) revert ControlProposalExists();
        ManifestRef memory active = _active[subjectKey];
        if (active.manifestVersion == 0) revert ResourceUnknown(kind, subjectId);
        _validateActiveDomain(_records[_recordKey(kind, active)].domain);

        uint64 activationTimestamp = _activationTimestamp();
        _pendingControls[subjectKey] = PendingControl({
            recordKey: _recordKey(kind, active),
            state: state,
            maximumPackageNotionalQuoteAtoms: maximumPackageNotionalQuoteAtoms,
            activationTimestamp: activationTimestamp,
            exists: true
        });
        emit ControlProposed(msg.sender, kind, subjectId, state, maximumPackageNotionalQuoteAtoms, activationTimestamp);
    }

    function cancelControl(ResourceKind kind, bytes32 subjectId) external {
        _checkCanceller();
        bytes32 subjectKey = _subjectKey(kind, subjectId);
        if (!_pendingControls[subjectKey].exists) revert ControlProposalMissing();
        delete _pendingControls[subjectKey];
        emit ControlProposalCancelled(msg.sender, kind, subjectId);
    }

    function activateControl(ResourceKind kind, bytes32 subjectId) external {
        _checkExecutor();
        bytes32 subjectKey = _subjectKey(kind, subjectId);
        PendingControl storage pending = _pendingControls[subjectKey];
        if (!pending.exists) revert ControlProposalMissing();
        if (block.timestamp < pending.activationTimestamp) revert ControlProposalNotReady(pending.activationTimestamp);

        ManifestRef memory active = _active[subjectKey];
        bytes32 recordKey = _recordKey(kind, active);
        if (recordKey != pending.recordKey) revert StaleControlProposal();
        _validateActiveDomain(_records[recordKey].domain);
        ResourceControl storage control = _controls[recordKey];
        control.state = pending.state;
        control.maximumPackageNotionalQuoteAtoms = pending.maximumPackageNotionalQuoteAtoms;
        Lifecycle state = pending.state;
        uint256 maximumQuoteAtoms = pending.maximumPackageNotionalQuoteAtoms;
        delete _pendingControls[subjectKey];
        emit ControlActivated(msg.sender, kind, subjectId, state, maximumQuoteAtoms);
    }

    function tightenControl(
        ResourceKind kind,
        bytes32 subjectId,
        Lifecycle state,
        uint256 maximumPackageNotionalQuoteAtoms
    ) external {
        _checkPauser();
        bytes32 subjectKey = _subjectKey(kind, subjectId);
        ManifestRef memory active = _active[subjectKey];
        if (active.manifestVersion == 0) revert ResourceUnknown(kind, subjectId);
        bytes32 recordKey = _recordKey(kind, active);
        ResourceControl storage control = _controls[recordKey];
        if (
            maximumPackageNotionalQuoteAtoms > control.maximumPackageNotionalQuoteAtoms
                || (_permissions(state) | _permissions(control.state)) != _permissions(control.state)
        ) revert UnsafeImmediateControlChange();

        if (_pendingRegistrations[subjectKey].exists) _cancelRegistration(subjectKey, msg.sender);
        if (_pendingControls[subjectKey].exists) {
            delete _pendingControls[subjectKey];
            emit ControlProposalCancelled(msg.sender, kind, subjectId);
        }
        control.state = state;
        control.maximumPackageNotionalQuoteAtoms = maximumPackageNotionalQuoteAtoms;
        emit ControlTightened(msg.sender, kind, subjectId, state, maximumPackageNotionalQuoteAtoms);
    }

    function activeResource(ResourceKind kind, bytes32 subjectId)
        external
        view
        returns (ResourceBinding memory manifest, ResourceControl memory control)
    {
        ManifestRef memory active = _active[_subjectKey(kind, subjectId)];
        if (active.manifestVersion == 0) revert ResourceUnknown(kind, subjectId);
        bytes32 recordKey = _recordKey(kind, active);
        manifest = _records[recordKey];
        _validateActiveDomain(manifest.domain);
        return (manifest, _controls[recordKey]);
    }

    function resource(ResourceKind kind, ManifestRef calldata identity)
        external
        view
        returns (ResourceBinding memory manifest, ResourceControl memory control)
    {
        bytes32 recordKey = _recordKey(kind, identity);
        manifest = _records[recordKey];
        if (manifest.identity.manifestVersion == 0) revert ResourceUnknown(kind, identity.subjectId);
        return (manifest, _controls[recordKey]);
    }

    function pendingRegistration(ResourceKind kind, bytes32 subjectId)
        external
        view
        returns (PendingRegistration memory)
    {
        return _pendingRegistrations[_subjectKey(kind, subjectId)];
    }

    function pendingControl(ResourceKind kind, bytes32 subjectId) external view returns (PendingControl memory) {
        return _pendingControls[_subjectKey(kind, subjectId)];
    }

    function bindingHash(ResourceBinding calldata binding) external pure returns (bytes32) {
        return _bindingHash(binding);
    }

    function validateCashCarry(CashCarryAdmission calldata admission)
        external
        view
        returns (uint256 maximumPackageNotionalQuoteAtoms)
    {
        _validateActiveDomain(admission.domain);
        if (
            admission.action != ENTRY && admission.action != EXIT || admission.packageNotionalQuoteAtoms == 0
                || !_validTemplate(admission.template) || !_validSettlementClass(admission.settlementClass)
                || admission.spot.adapter.manifest.subjectId == admission.perpetual.adapter.manifest.subjectId
                || admission.spot.market.manifest.subjectId == admission.perpetual.market.manifest.subjectId
        ) revert InvalidAdmission();

        (ResourceBinding memory baseAsset, ResourceControl memory baseControl) = _validateAssetRef(admission.baseAsset);
        (ResourceBinding memory quoteAsset, ResourceControl memory quoteControl) =
            _validateAssetRef(admission.quoteAsset);
        if (_sameRef(baseAsset.identity, quoteAsset.identity)) revert InvalidAdmission();

        _validateControlQuote(baseControl, admission.quoteAsset);
        _validateControlQuote(quoteControl, admission.quoteAsset);
        _validateAction(ResourceKind.ASSET, baseAsset.identity.subjectId, baseControl.state, admission.action);
        _validateAction(ResourceKind.ASSET, quoteAsset.identity.subjectId, quoteControl.state, admission.action);

        (uint256 spotMaximum, uint256 spotEconomicQuantity, uint256 spotNotional) =
            _validateLeg(admission.spot, admission, LegRole.SPOT, BASE_SPOT_ADAPTER_CLASS);
        (uint256 perpMaximum, uint256 perpEconomicQuantity, uint256 perpNotional) =
            _validateLeg(admission.perpetual, admission, LegRole.PERPETUAL, BASE_PERP_PORT_CLASS);
        if (spotEconomicQuantity != perpEconomicQuantity) revert InvalidAdmission();
        uint256 expectedPackageNotional = spotNotional > perpNotional ? spotNotional : perpNotional;
        if (admission.packageNotionalQuoteAtoms != expectedPackageNotional) {
            revert PackageNotionalMismatch(expectedPackageNotional, admission.packageNotionalQuoteAtoms);
        }

        maximumPackageNotionalQuoteAtoms = _minimum(
            baseControl.maximumPackageNotionalQuoteAtoms,
            quoteControl.maximumPackageNotionalQuoteAtoms,
            spotMaximum,
            perpMaximum
        );
        if (admission.action == ENTRY && admission.packageNotionalQuoteAtoms > maximumPackageNotionalQuoteAtoms) {
            revert PackageNotionalExceeded(maximumPackageNotionalQuoteAtoms, admission.packageNotionalQuoteAtoms);
        }
    }

    function _validateLeg(
        LegAdmission calldata leg,
        CashCarryAdmission calldata admission,
        LegRole role,
        bytes32 adapterClassId
    )
        private
        view
        returns (
            uint256 maximumPackageNotionalQuoteAtoms,
            uint256 economicQuantityAtoms,
            uint256 legLimitNotionalQuoteAtoms
        )
    {
        if (leg.adapterClassId != adapterClassId || leg.adapterClassVersion != ADAPTER_CLASS_VERSION) {
            revert InvalidAdmission();
        }
        (ResourceBinding memory adapter, ResourceControl memory adapterControl) =
            _validateRef(ResourceKind.ADAPTER, leg.adapter);
        (ResourceBinding memory market, ResourceControl memory marketControl) =
            _validateRef(ResourceKind.MARKET, leg.market);
        (ResourceBinding memory venue, ResourceControl memory venueControl) =
            _validateRef(ResourceKind.VENUE, leg.venue);

        if (
            adapter.legRole != role || market.legRole != role || venue.legRole != LegRole.NONE
                || adapter.adapterClassId != adapterClassId || adapter.adapterClassVersion != ADAPTER_CLASS_VERSION
                || !_sameTemplate(adapter.allowedTemplate, admission.template)
                || !_sameSettlementClass(adapter.settlementClass, admission.settlementClass)
                || !_sameRef(adapter.market, leg.market.manifest) || !_sameRef(adapter.venue, leg.venue.manifest)
                || !_sameRef(adapter.baseAsset, admission.baseAsset.manifest)
                || !_sameRef(adapter.quoteAsset, admission.quoteAsset.manifest)
                || !_sameRef(market.venue, leg.venue.manifest)
                || !_sameRef(market.baseAsset, admission.baseAsset.manifest)
                || !_sameRef(market.quoteAsset, admission.quoteAsset.manifest)
        ) revert InvalidAdmission();

        _validateControlQuote(adapterControl, admission.quoteAsset);
        _validateControlQuote(marketControl, admission.quoteAsset);
        _validateControlQuote(venueControl, admission.quoteAsset);
        _validateAction(ResourceKind.ADAPTER, adapter.identity.subjectId, adapterControl.state, admission.action);
        _validateAction(ResourceKind.MARKET, market.identity.subjectId, marketControl.state, admission.action);
        _validateAction(ResourceKind.VENUE, venue.identity.subjectId, venueControl.state, admission.action);
        (economicQuantityAtoms, legLimitNotionalQuoteAtoms) =
            _validateMarketSizing(market.marketParameters, leg.quantityAtoms, leg.limitQuoteAtomsPerBaseLot);

        maximumPackageNotionalQuoteAtoms = _minimum(
            adapterControl.maximumPackageNotionalQuoteAtoms,
            marketControl.maximumPackageNotionalQuoteAtoms,
            venueControl.maximumPackageNotionalQuoteAtoms,
            type(uint256).max
        );
    }

    function _validateBinding(ResourceBinding memory manifest, ResourceControl memory control) private view {
        _validateActiveDomain(manifest.domain);
        if (
            manifest.identity.subjectId == bytes32(0) || manifest.identity.manifestVersion == 0
                || manifest.identity.manifestHash == bytes32(0) || manifest.localAddress == address(0)
                || manifest.expectedCodeHash == bytes32(0) || manifest.localAddress.code.length == 0
                || manifest.localAddress.codehash != manifest.expectedCodeHash
        ) revert InvalidBinding();
        _validateControlDenomination(manifest, control);

        if (manifest.kind == ResourceKind.ASSET) {
            if (
                manifest.legRole != LegRole.NONE || !_adapterFieldsEmpty(manifest) || !_refsEmpty(manifest)
                    || !_marketParametersEmpty(manifest.marketParameters)
            ) {
                revert InvalidBinding();
            }
            _validateDecimals(manifest.identity.subjectId, manifest.localAddress, manifest.decimals);
            return;
        }
        if (manifest.decimals != 0) revert InvalidBinding();
        if (manifest.kind == ResourceKind.VENUE) {
            if (
                manifest.legRole != LegRole.NONE || !_adapterFieldsEmpty(manifest) || !_refsEmpty(manifest)
                    || !_marketParametersEmpty(manifest.marketParameters)
            ) {
                revert InvalidBinding();
            }
            return;
        }
        if (manifest.kind == ResourceKind.MARKET) {
            if (
                manifest.legRole == LegRole.NONE || !_adapterFieldsEmpty(manifest) || !_refEmpty(manifest.market)
                    || !_isActiveExact(ResourceKind.VENUE, manifest.venue)
                    || !_isActiveExact(ResourceKind.ASSET, manifest.baseAsset)
                    || !_isActiveExact(ResourceKind.ASSET, manifest.quoteAsset)
                    || _sameRef(manifest.baseAsset, manifest.quoteAsset)
            ) revert InvalidBinding();
            _validateMarketParameters(manifest);
            return;
        }

        bytes32 expectedClass = manifest.legRole == LegRole.SPOT
            ? BASE_SPOT_ADAPTER_CLASS
            : manifest.legRole == LegRole.PERPETUAL ? BASE_PERP_PORT_CLASS : bytes32(0);
        if (
            expectedClass == bytes32(0) || manifest.adapterClassId != expectedClass
                || manifest.adapterClassVersion != ADAPTER_CLASS_VERSION || !_validTemplate(manifest.allowedTemplate)
                || !_validSettlementClass(manifest.settlementClass)
                || !_marketParametersEmpty(manifest.marketParameters)
                || !_isActiveExact(ResourceKind.VENUE, manifest.venue)
                || !_isActiveExact(ResourceKind.MARKET, manifest.market)
                || !_isActiveExact(ResourceKind.ASSET, manifest.baseAsset)
                || !_isActiveExact(ResourceKind.ASSET, manifest.quoteAsset)
        ) revert InvalidBinding();

        ResourceBinding storage market = _records[_recordKey(ResourceKind.MARKET, manifest.market)];
        if (
            market.legRole != manifest.legRole || !_sameRef(market.venue, manifest.venue)
                || !_sameRef(market.baseAsset, manifest.baseAsset) || !_sameRef(market.quoteAsset, manifest.quoteAsset)
        ) revert InvalidBinding();
    }

    function _validateControlDenomination(ResourceBinding memory manifest, ResourceControl memory control)
        private
        view
    {
        if (
            control.maximumPackageNotionalQuoteAtoms == 0 || control.quoteAsset.subjectId == bytes32(0)
                || control.quoteAsset.manifestVersion == 0 || control.quoteAsset.manifestHash == bytes32(0)
        ) revert InvalidBinding();
        if (manifest.kind == ResourceKind.ASSET && _sameRef(manifest.identity, control.quoteAsset)) {
            if (manifest.decimals != control.quoteDecimals) revert InvalidBinding();
            return;
        }
        if (!_isActiveExact(ResourceKind.ASSET, control.quoteAsset)) revert InvalidBinding();
        ResourceBinding storage quoteAsset = _records[_recordKey(ResourceKind.ASSET, control.quoteAsset)];
        if (quoteAsset.decimals != control.quoteDecimals) revert InvalidBinding();
        if (
            (manifest.kind == ResourceKind.MARKET || manifest.kind == ResourceKind.ADAPTER)
                && !_sameRef(manifest.quoteAsset, control.quoteAsset)
        ) revert InvalidBinding();
        _validateDecimals(quoteAsset.identity.subjectId, quoteAsset.localAddress, quoteAsset.decimals);
    }

    function _validateRef(ResourceKind kind, ResourceRef calldata inputRef)
        private
        view
        returns (ResourceBinding memory manifest, ResourceControl memory control)
    {
        (manifest, control) = _activeRecord(kind, inputRef.manifest);
        if (manifest.localAddress != inputRef.localAddress || manifest.expectedCodeHash != inputRef.expectedCodeHash) {
            revert ResourceMismatch(kind, inputRef.manifest.subjectId);
        }
        if (inputRef.localAddress.code.length == 0 || inputRef.localAddress.codehash != inputRef.expectedCodeHash) {
            revert ResourceCodeMismatch(kind, inputRef.manifest.subjectId);
        }
    }

    function _validateAssetRef(AssetRef calldata inputRef)
        private
        view
        returns (ResourceBinding memory manifest, ResourceControl memory control)
    {
        (manifest, control) = _activeRecord(ResourceKind.ASSET, inputRef.manifest);
        if (
            manifest.localAddress != inputRef.localAddress || manifest.expectedCodeHash != inputRef.expectedCodeHash
                || manifest.decimals != inputRef.decimals
        ) revert ResourceMismatch(ResourceKind.ASSET, inputRef.manifest.subjectId);
        if (inputRef.localAddress.code.length == 0 || inputRef.localAddress.codehash != inputRef.expectedCodeHash) {
            revert ResourceCodeMismatch(ResourceKind.ASSET, inputRef.manifest.subjectId);
        }
        _validateDecimals(inputRef.manifest.subjectId, inputRef.localAddress, inputRef.decimals);
    }

    function _activeRecord(ResourceKind kind, ManifestRef calldata identity)
        private
        view
        returns (ResourceBinding memory manifest, ResourceControl memory control)
    {
        ManifestRef memory active = _active[_subjectKey(kind, identity.subjectId)];
        if (active.manifestVersion == 0) revert ResourceUnknown(kind, identity.subjectId);
        if (!_sameRef(active, identity)) revert ResourceMismatch(kind, identity.subjectId);
        bytes32 recordKey = _recordKey(kind, active);
        manifest = _records[recordKey];
        _validateActiveDomain(manifest.domain);
        return (manifest, _controls[recordKey]);
    }

    function _validateActiveDomain(DomainRef memory domain) private view {
        (string memory domainId, uint32 manifestVersion, bytes32 manifestHash) = config.domain();
        if (
            domain.domainIdHash == bytes32(0) || domain.manifestVersion == 0 || domain.manifestHash == bytes32(0)
                || domain.domainIdHash != keccak256(bytes(domainId)) || domain.manifestVersion != manifestVersion
                || domain.manifestHash != manifestHash
        ) revert DomainMismatch();
    }

    function _validateControlQuote(ResourceControl memory control, AssetRef calldata quoteAsset) private pure {
        if (!_sameRef(control.quoteAsset, quoteAsset.manifest) || control.quoteDecimals != quoteAsset.decimals) {
            revert InvalidAdmission();
        }
    }

    function _validateAction(ResourceKind kind, bytes32 subjectId, Lifecycle state, uint8 action) private pure {
        uint8 permissions = _permissions(state);
        if ((action == ENTRY && permissions & 1 == 0) || (action == EXIT && permissions & 2 == 0)) {
            revert ActionNotAllowed(kind, subjectId, state);
        }
    }

    function _validateDecimals(bytes32 subjectId, address asset, uint8 expectedDecimals) private view {
        try IERC20Metadata(asset).decimals() returns (uint8 actualDecimals) {
            if (actualDecimals != expectedDecimals) revert AssetDecimalsMismatch(subjectId);
        } catch {
            revert AssetDecimalsMismatch(subjectId);
        }
    }

    function _isActiveExact(ResourceKind kind, ManifestRef memory identity) private view returns (bool) {
        if (identity.subjectId == bytes32(0) || !_sameRef(_active[_subjectKey(kind, identity.subjectId)], identity)) {
            return false;
        }
        ResourceBinding storage binding = _records[_recordKey(kind, identity)];
        return _activeDomainMatches(binding.domain);
    }

    function _validateMarketParameters(ResourceBinding memory binding) private view {
        MarketParameters memory parameters = binding.marketParameters;
        if (
            parameters.baseLotAtoms == 0 || parameters.quoteTickAtomsPerBaseLot == 0
                || parameters.minimumQuoteNotionalAtoms == 0 || parameters.contractMultiplierNumerator == 0
                || parameters.contractMultiplierDenominator == 0
                || _greatestCommonDivisor(
                        parameters.contractMultiplierNumerator, parameters.contractMultiplierDenominator
                    ) != 1
        ) revert InvalidBinding();

        ResourceBinding storage base = _records[_recordKey(ResourceKind.ASSET, binding.baseAsset)];
        ResourceBinding storage quote = _records[_recordKey(ResourceKind.ASSET, binding.quoteAsset)];
        if (base.decimals != parameters.baseDecimals || quote.decimals != parameters.quoteDecimals) {
            revert InvalidBinding();
        }
        _validateActiveDomain(base.domain);
        _validateActiveDomain(quote.domain);
        _validateDecimals(base.identity.subjectId, base.localAddress, base.decimals);
        _validateDecimals(quote.identity.subjectId, quote.localAddress, quote.decimals);
    }

    function _validateMarketSizing(
        MarketParameters memory parameters,
        uint256 quantityAtoms,
        uint256 limitQuoteAtomsPerBaseLot
    ) private pure returns (uint256 economicQuantityAtoms, uint256 legLimitNotionalQuoteAtoms) {
        if (
            quantityAtoms == 0 || quantityAtoms % parameters.baseLotAtoms != 0 || limitQuoteAtomsPerBaseLot == 0
                || limitQuoteAtomsPerBaseLot % parameters.quoteTickAtomsPerBaseLot != 0
        ) revert InvalidAdmission();
        uint256 lotCount = quantityAtoms / parameters.baseLotAtoms;
        if (lotCount > type(uint256).max / limitQuoteAtomsPerBaseLot) revert InvalidAdmission();
        legLimitNotionalQuoteAtoms = lotCount * limitQuoteAtomsPerBaseLot;
        if (legLimitNotionalQuoteAtoms < parameters.minimumQuoteNotionalAtoms) {
            revert InvalidAdmission();
        }
        if (
            mulmod(quantityAtoms, parameters.contractMultiplierNumerator, parameters.contractMultiplierDenominator) != 0
        ) {
            revert InvalidAdmission();
        }
        economicQuantityAtoms = Math.mulDiv(
            quantityAtoms, parameters.contractMultiplierNumerator, parameters.contractMultiplierDenominator
        );
    }

    function _marketParametersEmpty(MarketParameters memory parameters) private pure returns (bool) {
        return parameters.baseLotAtoms == 0 && parameters.quoteTickAtomsPerBaseLot == 0
            && parameters.minimumQuoteNotionalAtoms == 0 && parameters.contractMultiplierNumerator == 0
            && parameters.contractMultiplierDenominator == 0 && parameters.baseDecimals == 0
            && parameters.quoteDecimals == 0;
    }

    function _greatestCommonDivisor(uint256 a, uint256 b) private pure returns (uint256) {
        while (b != 0) {
            (a, b) = (b, a % b);
        }
        return a;
    }

    function _activeDomainMatches(DomainRef memory domain) private view returns (bool) {
        (string memory domainId, uint32 manifestVersion, bytes32 manifestHash) = config.domain();
        return domain.domainIdHash != bytes32(0) && domain.manifestVersion != 0 && domain.manifestHash != bytes32(0)
            && domain.domainIdHash == keccak256(bytes(domainId)) && domain.manifestVersion == manifestVersion
            && domain.manifestHash == manifestHash;
    }

    function _validTemplate(TemplateRef memory template) private view returns (bool) {
        return template.templateManifestHash != bytes32(0) && template.templateId == CASH_AND_CARRY_TEMPLATE_ID
            && template.templateVersion == CASH_AND_CARRY_TEMPLATE_VERSION
            && template.templateManifestHash == cashCarryTemplateManifestHash();
    }

    function _validSettlementClass(SettlementClassRef memory settlementClass) private pure returns (bool) {
        return settlementClass.classId == ATOMIC_POSTCONDITION_ID
            && settlementClass.classVersion == ATOMIC_POSTCONDITION_VERSION;
    }

    function _adapterFieldsEmpty(ResourceBinding memory manifest) private pure returns (bool) {
        return manifest.adapterClassId == bytes32(0) && manifest.adapterClassVersion == 0
            && _templateEmpty(manifest.allowedTemplate) && _settlementClassEmpty(manifest.settlementClass);
    }

    function _refsEmpty(ResourceBinding memory manifest) private pure returns (bool) {
        return _refEmpty(manifest.venue) && _refEmpty(manifest.market) && _refEmpty(manifest.baseAsset)
            && _refEmpty(manifest.quoteAsset);
    }

    function _refEmpty(ManifestRef memory inputRef) private pure returns (bool) {
        return inputRef.subjectId == bytes32(0) && inputRef.manifestVersion == 0 && inputRef.manifestHash == bytes32(0);
    }

    function _templateEmpty(TemplateRef memory template) private pure returns (bool) {
        return template.templateId == bytes32(0) && template.templateVersion == 0
            && template.templateManifestHash == bytes32(0);
    }

    function _settlementClassEmpty(SettlementClassRef memory settlementClass) private pure returns (bool) {
        return settlementClass.classId == bytes32(0) && settlementClass.classVersion == 0;
    }

    function _sameRef(ManifestRef memory left, ManifestRef memory right) private pure returns (bool) {
        return left.subjectId == right.subjectId && left.manifestVersion == right.manifestVersion
            && left.manifestHash == right.manifestHash;
    }

    function _sameTemplate(TemplateRef memory left, TemplateRef memory right) private pure returns (bool) {
        return left.templateId == right.templateId && left.templateVersion == right.templateVersion
            && left.templateManifestHash == right.templateManifestHash;
    }

    function _sameSettlementClass(SettlementClassRef memory left, SettlementClassRef memory right)
        private
        pure
        returns (bool)
    {
        return left.classId == right.classId && left.classVersion == right.classVersion;
    }

    function _permissions(Lifecycle state) private pure returns (uint8) {
        if (state == Lifecycle.ACTIVE) return 3;
        if (state == Lifecycle.ENTRY_PAUSED || state == Lifecycle.EXIT_ONLY) return 2;
        return 0;
    }

    function _minimum(uint256 a, uint256 b, uint256 c, uint256 d) private pure returns (uint256 result) {
        result = a < b ? a : b;
        result = result < c ? result : c;
        result = result < d ? result : d;
    }

    function _subjectKey(ResourceKind kind, bytes32 subjectId) private pure returns (bytes32) {
        return keccak256(abi.encode(kind, subjectId));
    }

    function _recordKey(ResourceKind kind, ManifestRef memory identity) private pure returns (bytes32) {
        return keccak256(abi.encode(kind, identity.subjectId, identity.manifestVersion, identity.manifestHash));
    }

    function _bindingHash(ResourceBinding memory binding) private pure returns (bytes32) {
        return keccak256(abi.encode(binding));
    }

    function _activationTimestamp() private view returns (uint64) {
        uint64 delaySeconds = config.configDelaySeconds();
        if (block.timestamp > uint256(type(uint64).max) - uint256(delaySeconds)) {
            revert ActivationTimestampOverflow();
        }
        return uint64(block.timestamp) + delaySeconds;
    }

    function _cancelRegistration(bytes32 subjectKey, address actor) private {
        PendingRegistration storage pending = _pendingRegistrations[subjectKey];
        emit RegistrationCancelled(
            actor,
            pending.binding.kind,
            pending.binding.identity.subjectId,
            pending.binding.identity.manifestVersion,
            pending.binding.identity.manifestHash
        );
        delete _pendingRegistrations[subjectKey];
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
