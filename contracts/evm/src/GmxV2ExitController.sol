// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {EIP712} from "openzeppelin-contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "openzeppelin-contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/utils/ReentrancyGuard.sol";
import {GmxV2ArbitrumAdapter} from "./GmxV2ArbitrumAdapter.sol";
import {GmxV2IsolatedAccount} from "./GmxV2IsolatedAccount.sol";
import {
    GmxV2,
    IGmxV2DataStore,
    IGmxV2ExitOrderVerifier,
    IGmxV2OrderCallbackReceiver,
    IGmxV2RoleStore
} from "./interfaces/IGmxV2.sol";

contract GmxV2ExitController is EIP712, IGmxV2OrderCallbackReceiver, ReentrancyGuard {
    uint8 public constant TERMINAL_COMPLETE = 1;
    bytes32 public constant EXIT_AUTHORIZATION_TYPEHASH = keccak256(
        "ExitAuthorization(bytes32 packageId,bytes32 entryRequestKey,bytes32 spotRegistrationHash,address account,address owner,address receiver,address spotProceedsRecipient,address feePayer,address executionFeeRefundRecipient,address market,address collateralToken,bool isLong,uint256 fullCloseSizeUsd,uint256 spotBaseAtoms,uint256 spotMinQuoteAtoms,uint256 packageNonce,bytes32 exitOrderHash,bytes32 exitQuoteHash,bytes32 exitRouteHash,bytes32 exitFillCommitment,uint256 acceptablePrice,uint256 minOutputAmount,uint256 executionFeeWei,uint256 callbackGasLimit,uint64 authorizationExpiry,uint64 cancelAfter,uint256 nonce)"
    );
    bytes32 public constant EVIDENCE_DOMAIN = keccak256("NARYX_GMX_V2_EXIT_EVIDENCE_V1");
    bytes32 public constant FINAL_RECEIPT_DOMAIN = keccak256("NARYX_GMX_V2_FINAL_PACKAGE_RECEIPT_V1");
    bytes32 public constant CONTROLLER_ROLE = keccak256(abi.encode("CONTROLLER"));
    bytes32 public constant ORDER_LIST = keccak256(abi.encode("ORDER_LIST"));
    bytes32 public constant REQUEST_EXPIRATION_TIME = keccak256(abi.encode("REQUEST_EXPIRATION_TIME"));

    enum Status {
        NONE,
        PENDING,
        EXECUTED,
        CANCELLED,
        FROZEN,
        RECOVERED,
        CONFLICT
    }

    struct ExitAuthorization {
        bytes32 packageId;
        bytes32 entryRequestKey;
        bytes32 spotRegistrationHash;
        address account;
        address owner;
        address receiver;
        address spotProceedsRecipient;
        address feePayer;
        address executionFeeRefundRecipient;
        address market;
        address collateralToken;
        bool isLong;
        uint256 fullCloseSizeUsd;
        uint256 spotBaseAtoms;
        uint256 spotMinQuoteAtoms;
        uint256 packageNonce;
        bytes32 exitOrderHash;
        bytes32 exitQuoteHash;
        bytes32 exitRouteHash;
        bytes32 exitFillCommitment;
        uint256 acceptablePrice;
        uint256 minOutputAmount;
        uint256 executionFeeWei;
        uint256 callbackGasLimit;
        uint64 authorizationExpiry;
        uint64 cancelAfter;
        uint256 nonce;
    }

    struct ExitRecord {
        GmxV2.ExitRegistration registration;
        Status status;
        bytes32 evidenceHash;
        bytes32 callbackDataHash;
        uint64 revision;
        bool reconciling;
        bool released;
    }

    struct FinalPackageReceipt {
        bytes32 commitment;
        bytes32 packageId;
        bytes32 entryRequestKey;
        bytes32 exitRequestKey;
        bytes32 entryRequestPayloadHash;
        bytes32 spotRegistrationHash;
        bytes32 exitAuthorizationHash;
        bytes32 perpEvidenceHash;
        bytes32 spotEvidenceHash;
        bytes32 entryCommitmentsHash;
        bytes32 exitCommitmentsHash;
        address recipient;
        uint256 fullCloseSizeUsd;
        uint256 spotBaseAtoms;
        uint256 spotQuoteAtoms;
        uint8 perpStatus;
        uint8 terminalState;
    }

    error InvalidConfiguration();
    error DeploymentChanged();
    error UnauthorizedCaller();
    error InvalidAuthorization();
    error InvalidSignature();
    error InvalidOutcome();
    error FundingMismatch();

    event ExitSubmitted(bytes32 indexed packageId, bytes32 indexed requestKey, bytes32 authorizationHash);
    event ExitOutcomeRecorded(bytes32 indexed requestKey, Status status, uint64 revision, bytes32 evidenceHash);
    event ExitReconciliationRequested(bytes32 indexed requestKey);
    event IsolatedPositionReleased(bytes32 indexed packageId, bytes32 indexed requestKey);
    event FinalPackageReceiptRecorded(
        bytes32 indexed packageId,
        bytes32 indexed entryRequestKey,
        bytes32 indexed exitRequestKey,
        bytes32 commitment,
        address recipient,
        uint256 spotQuoteAtoms
    );

    GmxV2ArbitrumAdapter public immutable entryAdapter;
    GmxV2IsolatedAccount public immutable account;
    IGmxV2ExitOrderVerifier public immutable orderVerifier;
    bytes32 private immutable entryAdapterCodeHash;
    bytes32 private immutable accountCodeHash;
    bytes32 private immutable orderVerifierCodeHash;
    bytes32 private immutable deploymentHash;
    address private immutable dataStore;
    address private immutable orderHandler;
    address private immutable roleStore;
    bytes32 private immutable dataStoreCodeHash;
    bytes32 private immutable orderHandlerCodeHash;
    bytes32 private immutable roleStoreCodeHash;

    uint256 public nextNonce;
    bytes32 public activeExitRequestKey;
    mapping(bytes32 requestKey => ExitRecord record) private _exits;
    mapping(bytes32 requestKey => FinalPackageReceipt receipt) private _finalReceipts;

    constructor(
        GmxV2ArbitrumAdapter entryAdapter_,
        bytes32 entryAdapterCodeHash_,
        GmxV2IsolatedAccount account_,
        bytes32 accountCodeHash_,
        IGmxV2ExitOrderVerifier orderVerifier_,
        bytes32 orderVerifierCodeHash_,
        GmxV2.Deployment memory deployment
    ) EIP712("Naryx GMX V2 Exit", "1") {
        if (
            address(entryAdapter_) == address(0) || address(account_) == address(0)
                || address(orderVerifier_) == address(0) || entryAdapterCodeHash_ == bytes32(0)
                || accountCodeHash_ == bytes32(0) || orderVerifierCodeHash_ == bytes32(0)
                || address(entryAdapter_).codehash != entryAdapterCodeHash_
                || address(account_).codehash != accountCodeHash_
                || address(orderVerifier_).codehash != orderVerifierCodeHash_
                || address(entryAdapter_.isolatedAccount()) != address(account_)
                || account_.entryController() != address(entryAdapter_)
                || account_.deploymentHash() != keccak256(abi.encode(deployment))
        ) revert InvalidConfiguration();
        account_.assertDeployment();
        entryAdapter = entryAdapter_;
        account = account_;
        orderVerifier = orderVerifier_;
        entryAdapterCodeHash = entryAdapterCodeHash_;
        accountCodeHash = accountCodeHash_;
        orderVerifierCodeHash = orderVerifierCodeHash_;
        deploymentHash = keccak256(abi.encode(deployment));
        dataStore = deployment.dataStore;
        orderHandler = deployment.orderHandler;
        roleStore = deployment.roleStore;
        dataStoreCodeHash = deployment.dataStoreCodeHash;
        orderHandlerCodeHash = deployment.orderHandlerCodeHash;
        roleStoreCodeHash = deployment.roleStoreCodeHash;
    }

    function exitDigest(ExitAuthorization calldata authorization) external view returns (bytes32) {
        return _hashTypedDataV4(_authorizationHash(authorization));
    }

    function exitEvidence(bytes32 requestKey)
        external
        view
        returns (Status status, bytes32 evidenceHash, uint64 revision, bool reconciling, bool released)
    {
        ExitRecord storage stored = _exits[requestKey];
        return (stored.status, stored.evidenceHash, stored.revision, stored.reconciling, stored.released);
    }

    function exitRegistrationHash(bytes32 requestKey) external view returns (bytes32) {
        return keccak256(abi.encode(_exits[requestKey].registration));
    }

    function finalPackageReceipt(bytes32 requestKey) external view returns (FinalPackageReceipt memory) {
        return _finalReceipts[requestKey];
    }

    function submitFullClose(ExitAuthorization calldata authorization, bytes calldata ownerSignature)
        external
        payable
        nonReentrant
        returns (bytes32 requestKey)
    {
        _assertDeployment();
        if (
            activeExitRequestKey != bytes32(0) || msg.value != authorization.executionFeeWei
                || msg.sender != authorization.feePayer
        ) {
            revert FundingMismatch();
        }
        _validateAuthorization(authorization);
        bytes32 authorizationHash = _hashTypedDataV4(_authorizationHash(authorization));
        if (!SignatureChecker.isValidSignatureNow(account.owner(), authorizationHash, ownerSignature)) {
            revert InvalidSignature();
        }
        GmxV2.ExitRegistration memory registration = _registration(authorization, authorizationHash);
        nextNonce++;
        requestKey = account.createFullClose{value: msg.value}(registration);
        if (
            requestKey == bytes32(0) || _exits[requestKey].status != Status.NONE
                || !IGmxV2DataStore(dataStore).containsBytes32(ORDER_LIST, requestKey)
        ) revert InvalidOutcome();
        _exits[requestKey] = ExitRecord({
            registration: registration,
            status: Status.PENDING,
            evidenceHash: bytes32(0),
            callbackDataHash: bytes32(0),
            revision: 1,
            reconciling: false,
            released: false
        });
        activeExitRequestKey = requestKey;
        emit ExitSubmitted(authorization.packageId, requestKey, authorizationHash);
    }

    function requestCancellationOrReconciliation(bytes32 requestKey) external nonReentrant returns (bool terminal) {
        _assertDeployment();
        ExitRecord storage stored = _exit(requestKey);
        if (block.timestamp < stored.registration.cancelAfter) revert InvalidAuthorization();
        if (stored.status == Status.CONFLICT) return false;
        if (stored.status == Status.EXECUTED) return _release(stored, requestKey);
        if (stored.status == Status.CANCELLED || stored.status == Status.RECOVERED) return true;
        stored.reconciling = true;
        if (IGmxV2DataStore(dataStore).containsBytes32(ORDER_LIST, requestKey)) {
            try account.cancelExit(requestKey) {} catch {}
        }
        if (stored.status == Status.EXECUTED) return _release(stored, requestKey);
        if (stored.status == Status.CANCELLED || stored.status == Status.RECOVERED) return true;
        if (stored.status == Status.CONFLICT) return false;
        terminal = _reconcile(stored, requestKey);
        emit ExitReconciliationRequested(requestKey);
    }

    function processReconciliation(bytes32 requestKey) external nonReentrant returns (bool terminal) {
        _assertDeployment();
        ExitRecord storage stored = _exit(requestKey);
        if (!stored.reconciling || stored.status == Status.CONFLICT) revert InvalidOutcome();
        terminal = _reconcile(stored, requestKey);
    }

    function finalizeExecutedExit(bytes32 requestKey) external nonReentrant returns (bool released) {
        _assertDeployment();
        ExitRecord storage stored = _exit(requestKey);
        if (stored.status != Status.EXECUTED || account.positionSize(false) != 0 || account.positionSize(true) != 0) {
            revert InvalidOutcome();
        }
        released = _release(stored, requestKey);
    }

    function afterOrderExecution(
        bytes32 requestKey,
        GmxV2.EventLogData calldata orderData,
        GmxV2.EventLogData calldata eventData
    ) external {
        _assertCallbackCaller();
        ExitRecord storage stored = _exit(requestKey);
        orderVerifier.verify(address(this), stored.registration, orderData);
        bytes32 callbackDataHash = keccak256(abi.encode(orderData, eventData));
        if (account.positionSize(false) != 0 || account.positionSize(true) != 0) {
            _record(stored, requestKey, Status.CONFLICT, callbackDataHash);
            return;
        }
        _record(stored, requestKey, Status.EXECUTED, callbackDataHash);
        _release(stored, requestKey);
    }

    function afterOrderCancellation(
        bytes32 requestKey,
        GmxV2.EventLogData calldata orderData,
        GmxV2.EventLogData calldata eventData
    ) external {
        _assertCallbackCaller();
        ExitRecord storage stored = _exit(requestKey);
        orderVerifier.verify(address(this), stored.registration, orderData);
        bytes32 callbackDataHash = keccak256(abi.encode(orderData, eventData));
        uint256 shortSize = account.positionSize(false);
        uint256 longSize = account.positionSize(true);
        if (shortSize == 0 && longSize == 0) {
            _record(stored, requestKey, Status.CONFLICT, callbackDataHash);
            return;
        }
        if (
            shortSize != stored.registration.fullCloseSizeUsd || longSize != 0
                || IGmxV2DataStore(dataStore).containsBytes32(ORDER_LIST, requestKey)
        ) {
            _record(stored, requestKey, Status.CONFLICT, callbackDataHash);
            return;
        }
        Status status = stored.reconciling ? Status.RECOVERED : Status.CANCELLED;
        _record(stored, requestKey, status, callbackDataHash);
        if (activeExitRequestKey == requestKey) activeExitRequestKey = bytes32(0);
    }

    function afterOrderFrozen(
        bytes32 requestKey,
        GmxV2.EventLogData calldata orderData,
        GmxV2.EventLogData calldata eventData
    ) external {
        _assertCallbackCaller();
        ExitRecord storage stored = _exit(requestKey);
        orderVerifier.verify(address(this), stored.registration, orderData);
        bytes32 callbackDataHash = keccak256(abi.encode(orderData, eventData));
        uint256 shortSize = account.positionSize(false);
        uint256 longSize = account.positionSize(true);
        if (shortSize == 0 && longSize == 0) {
            _record(stored, requestKey, Status.CONFLICT, callbackDataHash);
            return;
        }
        Status status = shortSize == stored.registration.fullCloseSizeUsd && longSize == 0
            && IGmxV2DataStore(dataStore).containsBytes32(ORDER_LIST, requestKey)
            ? Status.FROZEN
            : Status.CONFLICT;
        _record(stored, requestKey, status, callbackDataHash);
    }

    function _validateAuthorization(ExitAuthorization calldata authorization) private view {
        uint256 cancellationDelay = IGmxV2DataStore(dataStore).getUint(REQUEST_EXPIRATION_TIME);
        GmxV2.SpotEntryRegistration memory spotRegistration = account.activeSpotRegistration();
        if (
            authorization.packageId != entryAdapter.activePackageId()
                || authorization.entryRequestKey != entryAdapter.activeRequestKey() || !account.hasActiveSpotInventory()
                || authorization.entryRequestKey != account.activeSpotRequestKey()
                || authorization.spotRegistrationHash != keccak256(abi.encode(spotRegistration))
                || authorization.packageId != spotRegistration.packageId || authorization.account != address(account)
                || authorization.owner != account.owner() || authorization.receiver != account.owner()
                || authorization.market != account.market() || authorization.spotProceedsRecipient != account.owner()
                || authorization.feePayer == address(0) || authorization.executionFeeRefundRecipient == address(0)
                || authorization.collateralToken != address(account.collateralToken()) || authorization.isLong
                || authorization.fullCloseSizeUsd == 0 || authorization.fullCloseSizeUsd != account.positionSize(false)
                || authorization.spotBaseAtoms == 0 || authorization.spotBaseAtoms != spotRegistration.baseAtoms
                || authorization.spotMinQuoteAtoms == 0 || authorization.packageNonce != spotRegistration.packageNonce
                || authorization.exitOrderHash == bytes32(0) || authorization.exitQuoteHash == bytes32(0)
                || authorization.exitRouteHash == bytes32(0) || authorization.exitFillCommitment == bytes32(0)
                || authorization.exitFillCommitment == spotRegistration.entryFillCommitment
                || authorization.exitFillCommitment == spotRegistration.rollbackFillCommitment
                || account.positionSize(true) != 0 || authorization.acceptablePrice == 0
                || authorization.minOutputAmount == 0 || authorization.executionFeeWei == 0
                || authorization.callbackGasLimit == 0 || authorization.nonce != nextNonce
                || block.timestamp >= authorization.authorizationExpiry
                || authorization.authorizationExpiry >= authorization.cancelAfter
                || cancellationDelay > type(uint64).max - block.timestamp
                || authorization.cancelAfter < block.timestamp + cancellationDelay
        ) revert InvalidAuthorization();
        (GmxV2ArbitrumAdapter.Status status,,, uint256 positionSizeAfter,) =
            entryAdapter.requestEvidence(authorization.entryRequestKey);
        if (status != GmxV2ArbitrumAdapter.Status.EXECUTED || positionSizeAfter != authorization.fullCloseSizeUsd) {
            revert InvalidAuthorization();
        }
    }

    function _registration(ExitAuthorization calldata authorization, bytes32 authorizationHash)
        private
        pure
        returns (GmxV2.ExitRegistration memory)
    {
        return GmxV2.ExitRegistration({
            packageId: authorization.packageId,
            entryRequestKey: authorization.entryRequestKey,
            authorizationHash: authorizationHash,
            spotRegistrationHash: authorization.spotRegistrationHash,
            account: authorization.account,
            owner: authorization.owner,
            receiver: authorization.receiver,
            spotProceedsRecipient: authorization.spotProceedsRecipient,
            feePayer: authorization.feePayer,
            executionFeeRefundRecipient: authorization.executionFeeRefundRecipient,
            market: authorization.market,
            collateralToken: authorization.collateralToken,
            isLong: authorization.isLong,
            fullCloseSizeUsd: authorization.fullCloseSizeUsd,
            spotBaseAtoms: authorization.spotBaseAtoms,
            spotMinQuoteAtoms: authorization.spotMinQuoteAtoms,
            packageNonce: authorization.packageNonce,
            exitOrderHash: authorization.exitOrderHash,
            exitQuoteHash: authorization.exitQuoteHash,
            exitRouteHash: authorization.exitRouteHash,
            exitFillCommitment: authorization.exitFillCommitment,
            acceptablePrice: authorization.acceptablePrice,
            minOutputAmount: authorization.minOutputAmount,
            executionFeeWei: authorization.executionFeeWei,
            callbackGasLimit: authorization.callbackGasLimit,
            authorizationExpiry: authorization.authorizationExpiry,
            cancelAfter: authorization.cancelAfter,
            nonce: authorization.nonce
        });
    }

    function _authorizationHash(ExitAuthorization calldata authorization) private pure returns (bytes32) {
        bytes memory first = abi.encode(
            EXIT_AUTHORIZATION_TYPEHASH,
            authorization.packageId,
            authorization.entryRequestKey,
            authorization.spotRegistrationHash,
            authorization.account,
            authorization.owner,
            authorization.receiver,
            authorization.spotProceedsRecipient,
            authorization.feePayer,
            authorization.executionFeeRefundRecipient
        );
        bytes memory second = abi.encode(
            authorization.market,
            authorization.collateralToken,
            authorization.isLong,
            authorization.fullCloseSizeUsd,
            authorization.spotBaseAtoms,
            authorization.spotMinQuoteAtoms,
            authorization.packageNonce,
            authorization.exitOrderHash
        );
        bytes memory third = abi.encode(
            authorization.exitQuoteHash,
            authorization.exitRouteHash,
            authorization.exitFillCommitment,
            authorization.acceptablePrice,
            authorization.minOutputAmount,
            authorization.executionFeeWei,
            authorization.callbackGasLimit,
            authorization.authorizationExpiry,
            authorization.cancelAfter
        );
        return keccak256(bytes.concat(first, second, third, abi.encode(authorization.nonce)));
    }

    function _reconcile(ExitRecord storage stored, bytes32 requestKey) private returns (bool) {
        if (stored.status == Status.EXECUTED) return _release(stored, requestKey);
        if (stored.status == Status.CANCELLED || stored.status == Status.RECOVERED) return true;
        uint256 shortSize = account.positionSize(false);
        uint256 longSize = account.positionSize(true);
        if (shortSize == 0 && longSize == 0) {
            _record(stored, requestKey, Status.CONFLICT, _reconciliationHash(requestKey, shortSize, longSize));
            return false;
        }
        if (shortSize != stored.registration.fullCloseSizeUsd || longSize != 0) {
            _record(stored, requestKey, Status.CONFLICT, _reconciliationHash(requestKey, shortSize, longSize));
            return false;
        }
        if (IGmxV2DataStore(dataStore).containsBytes32(ORDER_LIST, requestKey)) return false;
        _record(stored, requestKey, Status.RECOVERED, _reconciliationHash(requestKey, shortSize, longSize));
        if (activeExitRequestKey == requestKey) activeExitRequestKey = bytes32(0);
        return true;
    }

    function _release(ExitRecord storage stored, bytes32 requestKey) private returns (bool) {
        if (stored.released) return true;
        FinalPackageReceipt storage receipt = _finalReceipts[requestKey];
        if (receipt.commitment == bytes32(0)) {
            try account.completeSuccessfulExit(stored.registration, requestKey) returns (
                GmxV2.SpotExitResult memory spotResult
            ) {
                _storeFinalReceipt(stored, requestKey, spotResult);
            } catch {
                return false;
            }
        }
        try entryAdapter.finalizeExitedPosition(stored.registration.packageId, stored.registration.entryRequestKey) {
            stored.released = true;
            if (activeExitRequestKey == requestKey) activeExitRequestKey = bytes32(0);
            emit IsolatedPositionReleased(stored.registration.packageId, requestKey);
            return true;
        } catch {
            return false;
        }
    }

    function _storeFinalReceipt(ExitRecord storage stored, bytes32 requestKey, GmxV2.SpotExitResult memory spotResult)
        private
    {
        bytes32 exitCommitmentsHash = keccak256(
            abi.encode(
                stored.registration.packageNonce,
                stored.registration.exitOrderHash,
                stored.registration.exitQuoteHash,
                stored.registration.exitRouteHash,
                stored.registration.exitFillCommitment
            )
        );
        uint8 perpStatus = uint8(stored.status);
        uint8 terminalState = TERMINAL_COMPLETE;
        bytes32 commitment =
            _receiptCommitment(stored, requestKey, spotResult, exitCommitmentsHash, perpStatus, terminalState);
        FinalPackageReceipt storage receipt = _finalReceipts[requestKey];
        receipt.commitment = commitment;
        receipt.packageId = stored.registration.packageId;
        receipt.entryRequestKey = stored.registration.entryRequestKey;
        receipt.exitRequestKey = requestKey;
        receipt.entryRequestPayloadHash = spotResult.entryRequestPayloadHash;
        receipt.spotRegistrationHash = stored.registration.spotRegistrationHash;
        receipt.exitAuthorizationHash = stored.registration.authorizationHash;
        receipt.perpEvidenceHash = stored.evidenceHash;
        receipt.spotEvidenceHash = spotResult.evidenceHash;
        receipt.entryCommitmentsHash = spotResult.entryCommitmentsHash;
        receipt.exitCommitmentsHash = exitCommitmentsHash;
        receipt.recipient = stored.registration.spotProceedsRecipient;
        receipt.fullCloseSizeUsd = stored.registration.fullCloseSizeUsd;
        receipt.spotBaseAtoms = stored.registration.spotBaseAtoms;
        receipt.spotQuoteAtoms = spotResult.quoteAtoms;
        receipt.perpStatus = perpStatus;
        receipt.terminalState = terminalState;
        emit FinalPackageReceiptRecorded(
            receipt.packageId,
            receipt.entryRequestKey,
            requestKey,
            commitment,
            receipt.recipient,
            receipt.spotQuoteAtoms
        );
    }

    function _receiptCommitment(
        ExitRecord storage stored,
        bytes32 requestKey,
        GmxV2.SpotExitResult memory spotResult,
        bytes32 exitCommitmentsHash,
        uint8 perpStatus,
        uint8 terminalState
    ) private view returns (bytes32) {
        bytes32 receiptIdentityHash = keccak256(
            abi.encode(
                stored.registration.packageId,
                stored.registration.entryRequestKey,
                requestKey,
                spotResult.entryRequestPayloadHash,
                stored.registration.spotRegistrationHash,
                stored.registration.authorizationHash
            )
        );
        bytes32 outcomesHash = keccak256(
            abi.encode(
                stored.evidenceHash, spotResult.evidenceHash, spotResult.entryCommitmentsHash, exitCommitmentsHash
            )
        );
        bytes32 economicsHash = keccak256(
            abi.encode(
                stored.registration.spotProceedsRecipient,
                stored.registration.fullCloseSizeUsd,
                stored.registration.spotBaseAtoms,
                spotResult.quoteAtoms
            )
        );
        return keccak256(
            abi.encode(
                FINAL_RECEIPT_DOMAIN,
                block.chainid,
                address(this),
                address(account),
                receiptIdentityHash,
                outcomesHash,
                economicsHash,
                perpStatus,
                terminalState
            )
        );
    }

    function _record(ExitRecord storage stored, bytes32 requestKey, Status status, bytes32 callbackDataHash) private {
        bytes32 evidenceHash = keccak256(
            abi.encode(
                EVIDENCE_DOMAIN,
                block.chainid,
                address(this),
                requestKey,
                stored.registration.authorizationHash,
                status,
                callbackDataHash,
                account.positionSize(false),
                account.positionSize(true)
            )
        );
        if (stored.status == status && stored.evidenceHash == evidenceHash) return;
        bool lateExecution = status == Status.EXECUTED
            && (stored.status == Status.PENDING
                || stored.status == Status.CANCELLED
                || stored.status == Status.FROZEN
                || stored.status == Status.RECOVERED);
        bool recovery = status == Status.RECOVERED
            && (stored.status == Status.PENDING || stored.status == Status.CANCELLED || stored.status == Status.FROZEN);
        bool normal = stored.status == Status.PENDING
            && (status == Status.CANCELLED || status == Status.FROZEN || status == Status.CONFLICT);
        if (!lateExecution && !recovery && !normal) {
            status = Status.CONFLICT;
            evidenceHash = keccak256(abi.encode(EVIDENCE_DOMAIN, "CONFLICT", stored.evidenceHash, evidenceHash));
        }
        stored.status = status;
        stored.evidenceHash = evidenceHash;
        stored.callbackDataHash = callbackDataHash;
        stored.revision++;
        emit ExitOutcomeRecorded(requestKey, status, stored.revision, evidenceHash);
    }

    function _exit(bytes32 requestKey) private view returns (ExitRecord storage stored) {
        stored = _exits[requestKey];
        if (stored.status == Status.NONE) revert InvalidOutcome();
    }

    function _assertCallbackCaller() private view {
        _assertDeployment();
        if (
            msg.sender != orderHandler || msg.sender.codehash != orderHandlerCodeHash
                || !IGmxV2RoleStore(roleStore).hasRole(msg.sender, CONTROLLER_ROLE)
        ) revert UnauthorizedCaller();
    }

    function _assertDeployment() private view {
        if (
            address(entryAdapter).codehash != entryAdapterCodeHash || address(account).codehash != accountCodeHash
                || address(orderVerifier).codehash != orderVerifierCodeHash
                || account.deploymentHash() != deploymentHash || dataStore.codehash != dataStoreCodeHash
                || orderHandler.codehash != orderHandlerCodeHash || roleStore.codehash != roleStoreCodeHash
                || account.exitController() != address(this)
                || account.exitControllerCodeHash() != address(this).codehash
        ) revert DeploymentChanged();
        account.assertDeployment();
    }

    function _reconciliationHash(bytes32 requestKey, uint256 shortSize, uint256 longSize)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(EVIDENCE_DOMAIN, "DATA_STORE_RECONCILIATION", requestKey, shortSize, longSize));
    }
}
