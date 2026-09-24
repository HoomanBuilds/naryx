// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "openzeppelin-contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "openzeppelin-contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "openzeppelin-contracts/utils/cryptography/SignatureChecker.sol";
import {TransientSlot} from "openzeppelin-contracts/utils/TransientSlot.sol";
import {ProtocolConfig} from "./ProtocolConfig.sol";
import {PackageQuoteShard} from "./PackageQuoteShard.sol";
import {PackageQuoteShardRegistry} from "./PackageQuoteShardRegistry.sol";
import {ResourceRegistry} from "./ResourceRegistry.sol";
import {SolverRegistry} from "./SolverRegistry.sol";
import {IExactSpotPort} from "./interfaces/IExactSpotPort.sol";
import {ISpotFillRecorder} from "./interfaces/ISpotFillRecorder.sol";
import {ISynFuturesPositionObserver} from "./interfaces/ISynFuturesPositionObserver.sol";

contract PackageVerifier is EIP712, ISpotFillRecorder {
    using TransientSlot for bytes32;
    using TransientSlot for TransientSlot.BooleanSlot;
    using TransientSlot for TransientSlot.Bytes32Slot;
    using TransientSlot for TransientSlot.Uint256Slot;
    using TransientSlot for TransientSlot.Int256Slot;

    uint8 public constant ENTRY = 1;
    uint8 public constant EXIT = 2;
    bool public constant REQUIRES_PREFUNDED_PERP_MARGIN = true;

    bytes32 private constant TRADER_PERMIT_TYPEHASH = keccak256(
        "TraderPermit(bytes32 packageHash,bytes32 accountsHash,bytes32 limitsHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant SOLVER_AUTH_TYPEHASH = keccak256(
        "SolverAuthorization(bytes32 packageHash,bytes32 accountsHash,bytes32 limitsHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant RECEIPT_TYPEHASH = keccak256(
        "PackageReceiptCommitment(bytes32 packageHash,bytes32 accountsHash,bytes32 limitsHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant CONTEXT_NAMESPACE = keccak256("naryx.package-verifier.context.v1");
    bytes32 private constant CONTEXT_HASH_FIELD = keccak256("context-hash");
    bytes32 private constant BASE_BEFORE_FIELD = keccak256("base-before");
    bytes32 private constant QUOTE_BEFORE_FIELD = keccak256("quote-before");
    bytes32 private constant PERP_BALANCE_BEFORE_FIELD = keccak256("perp-balance-before");
    bytes32 private constant PERP_SIZE_BEFORE_FIELD = keccak256("perp-size-before");
    bytes32 private constant PERP_ENTRY_NOTIONAL_BEFORE_FIELD = keccak256("perp-entry-notional-before");
    bytes32 private constant SPOT_FILL_SEEN_FIELD = keccak256("spot-fill-seen");
    bytes32 private constant SPOT_QUOTE_FIELD = keccak256("spot-quote");
    bytes32 private constant PACKAGE_QUOTE_INTENT_FIELD = keccak256("package-quote-intent");
    bytes32 private constant PACKAGE_QUOTE_FILL_FIELD = keccak256("package-quote-fill");
    bytes32 private constant PACKAGE_QUOTE_INTENT_PREFIX = keccak256("NARYX_PACKAGE_QUOTE_INTENT_V1");

    struct Execution {
        bytes32 domainIdHash;
        uint32 domainManifestVersion;
        bytes32 domainManifestHash;
        bytes32 orderHash;
        bytes32 quoteHash;
        bytes32 routeHash;
        bytes32 spotFillCommitment;
        bytes32 packageQuoteIntentHash;
        uint8 action;
        address strategyAccount;
        address solver;
        address spotPort;
        address perpObserver;
        address perpInstrument;
        uint32 perpExpiry;
        address baseToken;
        address quoteToken;
        uint256 baseQuantityAtoms;
        uint256 perpQuantityWad;
        uint256 spotQuoteBoundAtoms;
        uint256 packageNotionalQuoteAtoms;
        uint128 packageSizeUnits;
        int128 expectedPrePerpBalanceWad;
        int128 expectedPrePerpSizeWad;
        uint128 expectedPrePerpEntryNotionalWad;
        int128 expectedPostPerpSizeWad;
        int128 minimumPostPerpBalanceWad;
        int128 maximumPostPerpBalanceWad;
        uint128 maximumPostPerpEntryNotionalWad;
        bytes32 entryReceiptHash;
        uint256 nonce;
        uint256 deadline;
    }

    struct QuoteIntent {
        PackageQuoteShardRegistry.ShardReference shardReference;
        PackageQuoteShard.ConsumeRequest consumeRequest;
    }

    struct OpenPackage {
        bytes32 entryReceiptHash;
        bytes32 routeHash;
        address spotPort;
        address perpObserver;
        address perpInstrument;
        uint32 perpExpiry;
        address baseToken;
        address quoteToken;
        uint256 baseQuantityAtoms;
        uint256 perpQuantityWad;
        uint128 entryPerpNotionalWad;
    }

    struct Receipt {
        bytes32 domainIdHash;
        uint32 domainManifestVersion;
        bytes32 domainManifestHash;
        bytes32 orderHash;
        bytes32 quoteHash;
        bytes32 routeHash;
        bytes32 spotFillCommitment;
        bytes32 packageQuoteIntentHash;
        bytes32 packageQuoteFillCommitment;
        uint8 action;
        address strategyAccount;
        address solver;
        bool recovery;
        uint256 baseQuantityAtoms;
        uint256 spotQuoteAtoms;
        uint128 packageSizeUnits;
        int128 prePerpBalanceWad;
        int128 prePerpSizeWad;
        uint128 prePerpEntryNotionalWad;
        int128 postPerpBalanceWad;
        int128 postPerpSizeWad;
        uint128 postPerpEntryNotionalWad;
        bytes32 entryReceiptHash;
        uint256 nonce;
    }

    error InvalidConfiguration();
    error InvalidExecution();
    error InvalidRecoveryExit();
    error DomainMismatch();
    error EntryPaused();
    error Expired();
    error InvalidNonce();
    error InvalidTraderSignature();
    error InvalidSolverSignature();
    error ResourceAdmissionFailed();
    error InvalidPackageQuote();
    error ContextAlreadyActive();
    error ContextNotActive();
    error InvalidSpotFill();
    error PositionExists();
    error PositionMismatch();
    error PostconditionFailed();

    event PackageVerified(
        bytes32 indexed receiptHash,
        address indexed strategyAccount,
        uint8 indexed action,
        address solver,
        bool recovery,
        uint256 baseQuantityAtoms,
        uint256 spotQuoteAtoms,
        bytes32 packageQuoteIntentHash,
        bytes32 packageQuoteFillCommitment
    );

    ProtocolConfig public immutable config;
    SolverRegistry public immutable solverRegistry;
    ResourceRegistry public immutable resourceRegistry;
    PackageQuoteShardRegistry public immutable packageQuoteShardRegistry;
    uint256 public immutable deploymentChainId;
    bytes32 public immutable deploymentDomainIdHash;
    bytes32 public immutable configCodeHash;
    bytes32 public immutable solverRegistryCodeHash;
    bytes32 public immutable resourceRegistryCodeHash;
    bytes32 public immutable packageQuoteShardRegistryCodeHash;

    mapping(address strategyAccount => uint256 nonce) public nextNonce;
    mapping(address strategyAccount => OpenPackage packageState) public openPackages;
    mapping(bytes32 receiptHash => Receipt receiptData) private _receipts;

    constructor(
        ProtocolConfig config_,
        SolverRegistry solverRegistry_,
        ResourceRegistry resourceRegistry_,
        PackageQuoteShardRegistry packageQuoteShardRegistry_
    ) EIP712("Naryx Package Verifier", "1") {
        if (
            address(config_).code.length == 0 || address(solverRegistry_).code.length == 0
                || address(resourceRegistry_).code.length == 0 || address(packageQuoteShardRegistry_).code.length == 0
                || address(solverRegistry_.config()) != address(config_)
                || address(resourceRegistry_.config()) != address(config_)
                || address(packageQuoteShardRegistry_.config()) != address(config_)
        ) revert InvalidConfiguration();
        (string memory domainId,,) = config_.domain();
        config = config_;
        solverRegistry = solverRegistry_;
        resourceRegistry = resourceRegistry_;
        packageQuoteShardRegistry = packageQuoteShardRegistry_;
        deploymentChainId = block.chainid;
        deploymentDomainIdHash = keccak256(bytes(domainId));
        configCodeHash = address(config_).codehash;
        solverRegistryCodeHash = address(solverRegistry_).codehash;
        resourceRegistryCodeHash = address(resourceRegistry_).codehash;
        packageQuoteShardRegistryCodeHash = address(packageQuoteShardRegistry_).codehash;
    }

    function traderPermitDigest(Execution calldata execution, ResourceRegistry.CashCarryAdmission calldata admission)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(_executionHash(TRADER_PERMIT_TYPEHASH, execution, _admissionHash(admission)));
    }

    function solverAuthorizationDigest(
        Execution calldata execution,
        ResourceRegistry.CashCarryAdmission calldata admission
    ) external view returns (bytes32) {
        return _hashTypedDataV4(_executionHash(SOLVER_AUTH_TYPEHASH, execution, _admissionHash(admission)));
    }

    function packageQuoteIntentHash(QuoteIntent calldata intent) external view returns (bytes32) {
        return _packageQuoteIntentHash(intent);
    }

    function receipt(bytes32 receiptHash) external view returns (Receipt memory) {
        return _receipts[receiptHash];
    }

    function hasOpenPackage(address strategyAccount) external view returns (bool) {
        return openPackages[strategyAccount].entryReceiptHash != bytes32(0);
    }

    function begin(
        Execution calldata execution,
        ResourceRegistry.CashCarryAdmission calldata admission,
        bytes calldata traderSignature,
        bytes calldata solverSignature
    ) external returns (bytes32 contextHash) {
        if (execution.packageQuoteIntentHash != bytes32(0)) {
            revert InvalidPackageQuote();
        }
        _validateCommon(execution, admission, traderSignature);
        _validateSolver(execution, admission, solverSignature);
        return _openContext(execution, admission, false, bytes32(0));
    }

    function beginFromQuoteShard(
        Execution calldata execution,
        ResourceRegistry.CashCarryAdmission calldata admission,
        QuoteIntent calldata intent,
        bytes calldata traderSignature,
        bytes calldata solverSignature
    ) external returns (bytes32 contextHash) {
        if (execution.action != ENTRY || execution.packageQuoteIntentHash == bytes32(0)) {
            revert InvalidPackageQuote();
        }
        _validateCommon(execution, admission, traderSignature);
        _validateSolver(execution, admission, solverSignature);
        bytes32 fillCommitment = _consumeQuote(execution, intent);
        return _openContext(execution, admission, false, fillCommitment);
    }

    function beginRecoveryExit(
        Execution calldata execution,
        ResourceRegistry.CashCarryAdmission calldata admission,
        bytes calldata traderSignature
    ) external returns (bytes32 contextHash) {
        if (execution.action != EXIT || execution.solver != address(0)) {
            revert InvalidRecoveryExit();
        }
        if (execution.packageQuoteIntentHash != bytes32(0)) revert InvalidRecoveryExit();
        _validateCommon(execution, admission, traderSignature);
        return _openContext(execution, admission, true, bytes32(0));
    }

    function recordSpotFill(
        address strategyAccount,
        uint256 packageNonce,
        bytes32 spotFillCommitment,
        bytes32 orderHash,
        bytes32 quoteHash,
        bytes32 routeHash,
        uint8 action,
        address baseToken,
        address quoteToken,
        uint256 baseAtoms,
        uint256 quoteAtoms
    ) external {
        bytes32 contextKey = _contextKey(strategyAccount, packageNonce);
        bytes32 contextHash = _transientBytes32(contextKey, CONTEXT_HASH_FIELD);
        if (contextHash == bytes32(0)) revert ContextNotActive();
        if (_transientBool(contextKey, SPOT_FILL_SEEN_FIELD)) revert InvalidSpotFill();
        bytes32 fillHash = keccak256(
            abi.encode(
                msg.sender,
                spotFillCommitment,
                orderHash,
                quoteHash,
                routeHash,
                action,
                baseToken,
                quoteToken,
                baseAtoms
            )
        );
        if (fillHash != contextHash) revert InvalidSpotFill();
        _storeTransientBool(contextKey, SPOT_FILL_SEEN_FIELD, true);
        _storeTransientUint(contextKey, SPOT_QUOTE_FIELD, quoteAtoms);
    }

    function finalize(
        Execution calldata execution,
        ResourceRegistry.CashCarryAdmission calldata admission,
        bool recovery
    ) external returns (bytes32 receiptHash) {
        if (msg.sender != execution.strategyAccount) {
            revert InvalidExecution();
        }
        bytes32 contextKey = _contextKey(execution.strategyAccount, execution.nonce);
        bytes32 expectedContextHash = _routeContextHash(execution);
        if (_transientBytes32(contextKey, CONTEXT_HASH_FIELD) != expectedContextHash) revert ContextNotActive();
        if (!_transientBool(contextKey, SPOT_FILL_SEEN_FIELD)) revert InvalidSpotFill();

        bytes32 admissionHash = _admissionHash(admission);
        if (_contextCommitment(execution, admissionHash, recovery) != _activeCommitment(contextKey)) {
            revert ContextNotActive();
        }
        bytes32 quoteIntentHash = _transientBytes32(contextKey, PACKAGE_QUOTE_INTENT_FIELD);
        bytes32 quoteFillCommitment = _transientBytes32(contextKey, PACKAGE_QUOTE_FILL_FIELD);
        if (
            quoteIntentHash != execution.packageQuoteIntentHash
                || (quoteIntentHash == bytes32(0) && quoteFillCommitment != bytes32(0))
                || (quoteIntentHash != bytes32(0) && quoteFillCommitment == bytes32(0))
        ) revert ContextNotActive();

        uint256 spotQuoteAtoms = _transientUint(contextKey, SPOT_QUOTE_FIELD);
        _validateSpotBound(execution.action, spotQuoteAtoms, execution.spotQuoteBoundAtoms);
        _validateTokenPostconditions(execution, contextKey, spotQuoteAtoms);
        ISynFuturesPositionObserver.Position memory post = _position(execution);
        if (
            post.size != execution.expectedPostPerpSizeWad || post.balance < execution.minimumPostPerpBalanceWad
                || post.balance > execution.maximumPostPerpBalanceWad
                || post.entryNotional > execution.maximumPostPerpEntryNotionalWad
                || (execution.action == ENTRY && post.entryNotional == 0)
                || (execution.action == EXIT && post.entryNotional != 0)
        ) revert PostconditionFailed();

        receiptHash = _commitReceipt(execution, admissionHash, recovery, spotQuoteAtoms, contextKey, post);
        _clearContext(contextKey);
        _emitPackageVerified(execution, receiptHash, recovery, spotQuoteAtoms, quoteFillCommitment);
    }

    function _emitPackageVerified(
        Execution calldata execution,
        bytes32 receiptHash,
        bool recovery,
        uint256 spotQuoteAtoms,
        bytes32 quoteFillCommitment
    ) private {
        emit PackageVerified(
            receiptHash,
            execution.strategyAccount,
            execution.action,
            execution.solver,
            recovery,
            execution.baseQuantityAtoms,
            spotQuoteAtoms,
            execution.packageQuoteIntentHash,
            quoteFillCommitment
        );
    }

    function _commitReceipt(
        Execution calldata execution,
        bytes32 admissionHash,
        bool recovery,
        uint256 spotQuoteAtoms,
        bytes32 contextKey,
        ISynFuturesPositionObserver.Position memory post
    ) private returns (bytes32 receiptHash) {
        int128 preBalance = int128(_transientInt(contextKey, PERP_BALANCE_BEFORE_FIELD));
        int128 preSize = int128(_transientInt(contextKey, PERP_SIZE_BEFORE_FIELD));
        uint128 preEntryNotional = uint128(_transientUint(contextKey, PERP_ENTRY_NOTIONAL_BEFORE_FIELD));
        bytes32 quoteFillCommitment = _transientBytes32(contextKey, PACKAGE_QUOTE_FILL_FIELD);
        nextNonce[execution.strategyAccount] = execution.nonce + 1;

        bytes32 receiptCommitment = _hashTypedDataV4(_executionHash(RECEIPT_TYPEHASH, execution, admissionHash));
        receiptHash = keccak256(
            abi.encode(
                receiptCommitment,
                recovery,
                quoteFillCommitment,
                spotQuoteAtoms,
                preBalance,
                preSize,
                preEntryNotional,
                post.balance,
                post.size,
                post.entryNotional
            )
        );
        Receipt memory receiptData;
        receiptData.domainIdHash = execution.domainIdHash;
        receiptData.domainManifestVersion = execution.domainManifestVersion;
        receiptData.domainManifestHash = execution.domainManifestHash;
        receiptData.orderHash = execution.orderHash;
        receiptData.quoteHash = execution.quoteHash;
        receiptData.routeHash = execution.routeHash;
        receiptData.spotFillCommitment = execution.spotFillCommitment;
        receiptData.packageQuoteIntentHash = execution.packageQuoteIntentHash;
        receiptData.packageQuoteFillCommitment = quoteFillCommitment;
        receiptData.action = execution.action;
        receiptData.strategyAccount = execution.strategyAccount;
        receiptData.solver = execution.solver;
        receiptData.recovery = recovery;
        receiptData.baseQuantityAtoms = execution.baseQuantityAtoms;
        receiptData.spotQuoteAtoms = spotQuoteAtoms;
        receiptData.packageSizeUnits = execution.packageSizeUnits;
        receiptData.prePerpBalanceWad = preBalance;
        receiptData.prePerpSizeWad = preSize;
        receiptData.prePerpEntryNotionalWad = preEntryNotional;
        receiptData.postPerpBalanceWad = post.balance;
        receiptData.postPerpSizeWad = post.size;
        receiptData.postPerpEntryNotionalWad = post.entryNotional;
        receiptData.entryReceiptHash = execution.entryReceiptHash;
        receiptData.nonce = execution.nonce;
        _receipts[receiptHash] = receiptData;

        _updateOpenPackage(execution, receiptHash, post.entryNotional);
    }

    function _updateOpenPackage(Execution calldata execution, bytes32 receiptHash, uint128 entryNotional) private {
        if (execution.action != ENTRY) {
            delete openPackages[execution.strategyAccount];
            return;
        }
        OpenPackage memory packageState;
        packageState.entryReceiptHash = receiptHash;
        packageState.routeHash = execution.routeHash;
        packageState.spotPort = execution.spotPort;
        packageState.perpObserver = execution.perpObserver;
        packageState.perpInstrument = execution.perpInstrument;
        packageState.perpExpiry = execution.perpExpiry;
        packageState.baseToken = execution.baseToken;
        packageState.quoteToken = execution.quoteToken;
        packageState.baseQuantityAtoms = execution.baseQuantityAtoms;
        packageState.perpQuantityWad = execution.perpQuantityWad;
        packageState.entryPerpNotionalWad = entryNotional;
        openPackages[execution.strategyAccount] = packageState;
    }

    function _validateCommon(
        Execution calldata execution,
        ResourceRegistry.CashCarryAdmission calldata admission,
        bytes calldata traderSignature
    ) private view {
        if (
            block.chainid != deploymentChainId || address(config).codehash != configCodeHash
                || address(solverRegistry).codehash != solverRegistryCodeHash
                || address(resourceRegistry).codehash != resourceRegistryCodeHash
                || address(packageQuoteShardRegistry).codehash != packageQuoteShardRegistryCodeHash
        ) revert InvalidConfiguration();
        if (
            msg.sender != execution.strategyAccount || execution.strategyAccount.code.length == 0
                || execution.spotPort.code.length == 0 || execution.perpObserver.code.length == 0
                || execution.perpInstrument.code.length == 0 || execution.baseToken.code.length == 0
                || execution.quoteToken.code.length == 0 || execution.baseToken == execution.quoteToken
                || execution.baseQuantityAtoms == 0 || execution.perpQuantityWad == 0
                || execution.perpQuantityWad > uint256(uint128(type(int128).max)) || execution.spotQuoteBoundAtoms == 0
                || execution.packageNotionalQuoteAtoms == 0 || execution.packageSizeUnits == 0
                || execution.orderHash == bytes32(0) || execution.quoteHash == bytes32(0)
                || execution.routeHash == bytes32(0) || execution.spotFillCommitment == bytes32(0)
                || (execution.action != ENTRY && execution.action != EXIT)
                || execution.minimumPostPerpBalanceWad > execution.maximumPostPerpBalanceWad
        ) revert InvalidExecution();
        if (block.timestamp >= execution.deadline) revert Expired();
        if (execution.nonce != nextNonce[execution.strategyAccount]) revert InvalidNonce();
        _validateDomain(execution);
        if (execution.action == ENTRY && config.entryPaused()) revert EntryPaused();
        _validatePositionShape(execution);
        _validateAdmission(execution, admission);

        bytes32 digest = _hashTypedDataV4(_executionHash(TRADER_PERMIT_TYPEHASH, execution, _admissionHash(admission)));
        if (!SignatureChecker.isValidSignatureNow(execution.strategyAccount, digest, traderSignature)) {
            revert InvalidTraderSignature();
        }
    }

    function _validateSolver(
        Execution calldata execution,
        ResourceRegistry.CashCarryAdmission calldata admission,
        bytes calldata solverSignature
    ) private view {
        address activeSolver = solverRegistry.activeSolver();
        if (execution.solver == address(0) || execution.solver != activeSolver) revert InvalidExecution();
        bytes32 digest = _hashTypedDataV4(_executionHash(SOLVER_AUTH_TYPEHASH, execution, _admissionHash(admission)));
        if (ECDSA.recover(digest, solverSignature) != activeSolver) revert InvalidSolverSignature();
    }

    function _validateDomain(Execution calldata execution) private view {
        (string memory activeDomainId, uint32 activeVersion, bytes32 activeManifestHash) = config.domain();
        if (
            keccak256(bytes(activeDomainId)) != deploymentDomainIdHash
                || execution.domainIdHash != deploymentDomainIdHash || execution.domainManifestVersion != activeVersion
                || execution.domainManifestHash != activeManifestHash
        ) revert DomainMismatch();
    }

    function _validatePositionShape(Execution calldata execution) private view {
        OpenPackage memory open = openPackages[execution.strategyAccount];
        int128 shortSize = -int128(uint128(execution.perpQuantityWad));
        if (execution.action == ENTRY) {
            if (
                open.entryReceiptHash != bytes32(0) || execution.entryReceiptHash != bytes32(0)
                    || execution.expectedPrePerpBalanceWad != 0 || execution.expectedPrePerpSizeWad != 0
                    || execution.expectedPrePerpEntryNotionalWad != 0 || execution.expectedPostPerpSizeWad != shortSize
                    || execution.minimumPostPerpBalanceWad < 0 || execution.maximumPostPerpEntryNotionalWad == 0
            ) revert PositionExists();
            return;
        }
        if (
            open.entryReceiptHash == bytes32(0)
                || (execution.entryReceiptHash != bytes32(0) && open.entryReceiptHash != execution.entryReceiptHash)
                || open.routeHash != execution.routeHash || open.spotPort != execution.spotPort
                || open.perpObserver != execution.perpObserver || open.perpInstrument != execution.perpInstrument
                || open.perpExpiry != execution.perpExpiry || open.baseToken != execution.baseToken
                || open.quoteToken != execution.quoteToken || open.baseQuantityAtoms != execution.baseQuantityAtoms
                || open.perpQuantityWad != execution.perpQuantityWad || execution.expectedPrePerpSizeWad != shortSize
                || execution.expectedPostPerpSizeWad != 0 || execution.maximumPostPerpEntryNotionalWad != 0
        ) revert PositionMismatch();
    }

    function _validateAdmission(Execution calldata execution, ResourceRegistry.CashCarryAdmission calldata admission)
        private
        view
    {
        try resourceRegistry.validateCashCarry(admission) returns (uint256) {}
        catch {
            revert ResourceAdmissionFailed();
        }
        if (
            admission.domain.domainIdHash != execution.domainIdHash
                || admission.domain.manifestVersion != execution.domainManifestVersion
                || admission.domain.manifestHash != execution.domainManifestHash || admission.action != execution.action
                || admission.packageNotionalQuoteAtoms != execution.packageNotionalQuoteAtoms
                || admission.spot.adapter.localAddress != execution.spotPort
                || admission.perpetual.adapter.localAddress != address(this)
                || admission.perpetual.market.localAddress != execution.perpInstrument
                || admission.perpetual.venue.localAddress != execution.perpObserver
                || admission.baseAsset.localAddress != execution.baseToken
                || admission.quoteAsset.localAddress != execution.quoteToken
                || admission.spot.quantityAtoms != execution.baseQuantityAtoms
                || admission.perpetual.quantityAtoms != execution.perpQuantityWad
        ) revert ResourceAdmissionFailed();
        IExactSpotPort spotPort = IExactSpotPort(execution.spotPort);
        if (
            spotPort.verifier() != address(this) || address(spotPort.baseToken()) != execution.baseToken
                || address(spotPort.quoteToken()) != execution.quoteToken
        ) revert ResourceAdmissionFailed();
    }

    function _openContext(
        Execution calldata execution,
        ResourceRegistry.CashCarryAdmission calldata admission,
        bool recovery,
        bytes32 packageQuoteFillCommitment
    ) private returns (bytes32 contextHash) {
        bytes32 contextKey = _contextKey(execution.strategyAccount, execution.nonce);
        if (_transientBytes32(contextKey, CONTEXT_HASH_FIELD) != bytes32(0)) revert ContextAlreadyActive();
        ISynFuturesPositionObserver.Position memory pre = _position(execution);
        if (
            pre.balance != execution.expectedPrePerpBalanceWad || pre.size != execution.expectedPrePerpSizeWad
                || pre.entryNotional != execution.expectedPrePerpEntryNotionalWad
        ) {
            revert PostconditionFailed();
        }
        contextHash = _routeContextHash(execution);
        _storeTransientBytes32(contextKey, CONTEXT_HASH_FIELD, contextHash);
        _storeTransientBytes32(
            contextKey, bytes32(0), _contextCommitment(execution, _admissionHash(admission), recovery)
        );
        _storeTransientUint(
            contextKey, BASE_BEFORE_FIELD, IERC20(execution.baseToken).balanceOf(execution.strategyAccount)
        );
        _storeTransientUint(
            contextKey, QUOTE_BEFORE_FIELD, IERC20(execution.quoteToken).balanceOf(execution.strategyAccount)
        );
        _storeTransientInt(contextKey, PERP_BALANCE_BEFORE_FIELD, pre.balance);
        _storeTransientInt(contextKey, PERP_SIZE_BEFORE_FIELD, pre.size);
        _storeTransientUint(contextKey, PERP_ENTRY_NOTIONAL_BEFORE_FIELD, pre.entryNotional);
        _storeTransientBytes32(contextKey, PACKAGE_QUOTE_INTENT_FIELD, execution.packageQuoteIntentHash);
        _storeTransientBytes32(contextKey, PACKAGE_QUOTE_FILL_FIELD, packageQuoteFillCommitment);
    }

    function _consumeQuote(Execution calldata execution, QuoteIntent calldata intent)
        private
        returns (bytes32 fillCommitment)
    {
        if (intent.consumeRequest.feeAtoms != 0) revert InvalidPackageQuote();
        PackageQuoteShardRegistry.ShardBinding memory binding;
        try packageQuoteShardRegistry.validateEntry(intent.shardReference) returns (
            PackageQuoteShardRegistry.ShardBinding memory validatedBinding
        ) {
            binding = validatedBinding;
        } catch {
            revert InvalidPackageQuote();
        }

        bytes32 verifierCodeHash = address(this).codehash;
        if (
            binding.consumer != address(this) || binding.consumerCodeHash != verifierCodeHash
                || binding.solver != execution.solver || intent.shardReference.consumer != address(this)
                || intent.shardReference.consumerCodeHash != verifierCodeHash
                || intent.consumeRequest.orderHash != execution.orderHash
                || intent.consumeRequest.quoteHash != execution.quoteHash
                || intent.consumeRequest.routeHash != execution.routeHash
                || intent.consumeRequest.sizeUnits != execution.packageSizeUnits
                || _packageQuoteIntentHash(intent) != execution.packageQuoteIntentHash
        ) revert InvalidPackageQuote();

        PackageQuoteShard shard = PackageQuoteShard(binding.shard);
        if (shard.config() != address(config)) revert InvalidPackageQuote();
        PackageQuoteShard.ExecutableQuote memory quote;
        try shard.getExecutableQuote(intent.consumeRequest.levelId, intent.consumeRequest.sizeUnits) returns (
            PackageQuoteShard.ExecutableQuote memory executableQuote
        ) {
            quote = executableQuote;
        } catch {
            revert InvalidPackageQuote();
        }

        if (
            (quote.quoteMode == shard.EXECUTION_COMMITMENT() && intent.consumeRequest.reservationId != bytes32(0))
                || (quote.quoteMode == shard.FIRM_ONCHAIN()
                    && (intent.consumeRequest.reservationId == bytes32(0)
                        || intent.consumeRequest.reservationId != execution.spotFillCommitment))
                || (quote.quoteMode != shard.EXECUTION_COMMITMENT() && quote.quoteMode != shard.FIRM_ONCHAIN())
        ) revert InvalidPackageQuote();

        try shard.consumeCapacity(intent.consumeRequest) returns (bytes32 consumedFillCommitment) {
            fillCommitment = consumedFillCommitment;
        } catch {
            revert InvalidPackageQuote();
        }
        if (fillCommitment == bytes32(0)) revert InvalidPackageQuote();
    }

    function _validateTokenPostconditions(Execution calldata execution, bytes32 contextKey, uint256 spotQuoteAtoms)
        private
        view
    {
        uint256 baseBefore = _transientUint(contextKey, BASE_BEFORE_FIELD);
        uint256 quoteBefore = _transientUint(contextKey, QUOTE_BEFORE_FIELD);
        uint256 baseAfter = IERC20(execution.baseToken).balanceOf(execution.strategyAccount);
        uint256 quoteAfter = IERC20(execution.quoteToken).balanceOf(execution.strategyAccount);
        if (execution.action == ENTRY) {
            if (
                baseBefore > type(uint256).max - execution.baseQuantityAtoms
                    || baseAfter != baseBefore + execution.baseQuantityAtoms || quoteBefore < spotQuoteAtoms
                    || quoteAfter != quoteBefore - spotQuoteAtoms
            ) revert PostconditionFailed();
        } else if (
            baseBefore < execution.baseQuantityAtoms || baseAfter != baseBefore - execution.baseQuantityAtoms
                || quoteBefore > type(uint256).max - spotQuoteAtoms || quoteAfter != quoteBefore + spotQuoteAtoms
        ) {
            revert PostconditionFailed();
        }
    }

    function _position(Execution calldata execution)
        private
        view
        returns (ISynFuturesPositionObserver.Position memory)
    {
        return ISynFuturesPositionObserver(execution.perpObserver)
            .getPosition(execution.perpInstrument, execution.perpExpiry, execution.strategyAccount);
    }

    function _validateSpotBound(uint8 action, uint256 quoteAtoms, uint256 bound) private pure {
        if (quoteAtoms == 0 || (action == ENTRY && quoteAtoms > bound) || (action == EXIT && quoteAtoms < bound)) {
            revert PostconditionFailed();
        }
    }

    function _executionHash(bytes32 typeHash, Execution calldata execution, bytes32 admissionHash)
        private
        view
        returns (bytes32)
    {
        bytes32 packageIdentityHash = keccak256(
            abi.encode(
                execution.domainIdHash,
                execution.domainManifestVersion,
                execution.domainManifestHash,
                execution.orderHash,
                execution.quoteHash,
                execution.routeHash,
                execution.spotFillCommitment,
                execution.packageQuoteIntentHash,
                admissionHash,
                execution.action
            )
        );
        bytes32 packageEconomicsHash = keccak256(
            abi.encode(
                execution.baseQuantityAtoms,
                execution.perpQuantityWad,
                execution.packageSizeUnits,
                execution.entryReceiptHash
            )
        );
        bytes32 packageHash = keccak256(abi.encode(packageIdentityHash, packageEconomicsHash));
        bytes32 accountsHash = keccak256(
            abi.encode(
                execution.strategyAccount,
                execution.solver,
                execution.spotPort,
                execution.perpObserver,
                execution.perpInstrument,
                execution.perpExpiry,
                execution.baseToken,
                execution.quoteToken,
                block.chainid
            )
        );
        bytes32 limitsHash = keccak256(
            abi.encode(
                execution.spotQuoteBoundAtoms,
                execution.packageNotionalQuoteAtoms,
                execution.expectedPrePerpBalanceWad,
                execution.expectedPrePerpSizeWad,
                execution.expectedPrePerpEntryNotionalWad,
                execution.expectedPostPerpSizeWad,
                execution.minimumPostPerpBalanceWad,
                execution.maximumPostPerpBalanceWad,
                execution.maximumPostPerpEntryNotionalWad
            )
        );
        return
            keccak256(abi.encode(typeHash, packageHash, accountsHash, limitsHash, execution.nonce, execution.deadline));
    }

    function _admissionHash(ResourceRegistry.CashCarryAdmission calldata admission) private pure returns (bytes32) {
        return keccak256(abi.encode(admission));
    }

    function _packageQuoteIntentHash(QuoteIntent calldata intent) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                PACKAGE_QUOTE_INTENT_PREFIX,
                address(packageQuoteShardRegistry),
                packageQuoteShardRegistryCodeHash,
                intent.shardReference,
                intent.consumeRequest
            )
        );
    }

    function _routeContextHash(Execution calldata execution) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                execution.spotPort,
                execution.spotFillCommitment,
                execution.orderHash,
                execution.quoteHash,
                execution.routeHash,
                execution.action,
                execution.baseToken,
                execution.quoteToken,
                execution.baseQuantityAtoms
            )
        );
    }

    function _contextCommitment(Execution calldata execution, bytes32 admissionHash, bool recovery)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(execution, admissionHash, recovery));
    }

    function _contextKey(address strategyAccount, uint256 packageNonce) private pure returns (bytes32) {
        return keccak256(abi.encode(CONTEXT_NAMESPACE, strategyAccount, packageNonce));
    }

    function _fieldSlot(bytes32 contextKey, bytes32 field) private pure returns (bytes32) {
        return keccak256(abi.encode(contextKey, field));
    }

    function _activeCommitment(bytes32 contextKey) private view returns (bytes32) {
        return _transientBytes32(contextKey, bytes32(0));
    }

    function _transientBytes32(bytes32 contextKey, bytes32 field) private view returns (bytes32) {
        return _fieldSlot(contextKey, field).asBytes32().tload();
    }

    function _transientUint(bytes32 contextKey, bytes32 field) private view returns (uint256) {
        return _fieldSlot(contextKey, field).asUint256().tload();
    }

    function _transientInt(bytes32 contextKey, bytes32 field) private view returns (int256) {
        return _fieldSlot(contextKey, field).asInt256().tload();
    }

    function _transientBool(bytes32 contextKey, bytes32 field) private view returns (bool) {
        return _fieldSlot(contextKey, field).asBoolean().tload();
    }

    function _storeTransientBytes32(bytes32 contextKey, bytes32 field, bytes32 value) private {
        _fieldSlot(contextKey, field).asBytes32().tstore(value);
    }

    function _storeTransientUint(bytes32 contextKey, bytes32 field, uint256 value) private {
        _fieldSlot(contextKey, field).asUint256().tstore(value);
    }

    function _storeTransientInt(bytes32 contextKey, bytes32 field, int256 value) private {
        _fieldSlot(contextKey, field).asInt256().tstore(value);
    }

    function _storeTransientBool(bytes32 contextKey, bytes32 field, bool value) private {
        _fieldSlot(contextKey, field).asBoolean().tstore(value);
    }

    function _clearContext(bytes32 contextKey) private {
        _storeTransientBytes32(contextKey, CONTEXT_HASH_FIELD, bytes32(0));
        _storeTransientBytes32(contextKey, bytes32(0), bytes32(0));
        _storeTransientBool(contextKey, SPOT_FILL_SEEN_FIELD, false);
        _storeTransientUint(contextKey, SPOT_QUOTE_FIELD, 0);
        _storeTransientBytes32(contextKey, PACKAGE_QUOTE_INTENT_FIELD, bytes32(0));
        _storeTransientBytes32(contextKey, PACKAGE_QUOTE_FILL_FIELD, bytes32(0));
    }
}
