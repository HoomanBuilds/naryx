// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/utils/ReentrancyGuard.sol";
import {AsyncBondedPackageCoordinator} from "./AsyncBondedPackageCoordinator.sol";
import {GmxV2IsolatedAccount} from "./GmxV2IsolatedAccount.sol";
import {GmxV2IsolatedAccountFactory} from "./GmxV2IsolatedAccountFactory.sol";
import {IAsyncVenueAdapter} from "./interfaces/IAsyncVenueAdapter.sol";
import {
    GmxV2,
    IGmxV2DataStore,
    IGmxV2ExchangeRouter,
    IGmxV2OrderCallbackReceiver,
    IGmxV2OrderVerifier,
    IGmxV2RoleStore
} from "./interfaces/IGmxV2.sol";

/// @notice The shared GMX V2 entry adapter for every account of one `GmxV2IsolatedAccountFactory`. One
/// coordinator admission of this adapter covers all factory accounts. A package's account is always the
/// factory account of the package owner, which funds the request and receives every refund.
contract GmxV2ArbitrumAdapter is IAsyncVenueAdapter, IGmxV2OrderCallbackReceiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant EVIDENCE_DOMAIN = keccak256("NARYX_GMX_V2_CALLBACK_EVIDENCE_V1");
    bytes32 public constant CONTROLLER_ROLE = keccak256(abi.encode("CONTROLLER"));
    bytes32 public constant ORDER_LIST = keccak256(abi.encode("ORDER_LIST"));
    bytes32 public constant SIZE_IN_USD = keccak256(abi.encode("SIZE_IN_USD"));
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

    struct Funding {
        address account;
        bytes32 requestPayloadHash;
        uint256 collateralAtoms;
        uint256 spotQuoteAtoms;
        uint256 executionFeeWei;
        uint64 submissionDeadline;
        bool consumed;
    }

    struct RequestRecord {
        GmxV2.RequestRegistration registration;
        address account;
        Status status;
        bytes32 evidenceHash;
        bytes32 callbackDataHash;
        uint256 positionSizeBefore;
        uint256 positionSizeAfter;
        uint64 revision;
        bool recovering;
    }

    error InvalidConfiguration();
    error DeploymentChanged();
    error UnauthorizedCaller();
    error InvalidRequest();
    error AlreadyFunded();
    error FundingMissing();
    error FundingMismatch();
    error DeadlinePassed();
    error InvalidOutcome();
    error UnknownAccount();

    event RequestFunded(
        bytes32 indexed packageId,
        address indexed owner,
        bytes32 requestPayloadHash,
        uint256 collateralAtoms,
        uint256 spotQuoteAtoms,
        uint256 feeWei
    );
    event RequestCreated(bytes32 indexed packageId, bytes32 indexed requestKey, bytes32 requestPayloadHash);
    event OutcomeRecorded(bytes32 indexed requestKey, Status status, uint64 revision, bytes32 evidenceHash);
    event EvidenceRelayed(bytes32 indexed requestKey, bytes32 indexed packageId, uint64 revision);
    event RecoveryRequested(bytes32 indexed packageId, bytes32 indexed requestKey);
    event ExpiredFundingReclaimed(bytes32 indexed packageId, address indexed owner);
    event UnfilledRequestReleased(bytes32 indexed packageId, bytes32 indexed requestKey, Status status);
    event ExitedPositionReleased(bytes32 indexed packageId, bytes32 indexed requestKey);

    AsyncBondedPackageCoordinator private immutable coordinator;
    address private immutable market;
    IERC20 private immutable collateralToken;
    address private immutable dataStore;
    address private immutable orderHandler;
    address private immutable roleStore;
    IGmxV2OrderVerifier private immutable orderVerifier;
    bytes32 private immutable coordinatorCodeHash;
    bytes32 private immutable marketCodeHash;
    bytes32 private immutable collateralTokenCodeHash;
    bytes32 private immutable orderVerifierCodeHash;
    GmxV2IsolatedAccountFactory public immutable factory;
    bytes32 private immutable factoryCodeHash;
    bytes32 private immutable orderHandlerCodeHash;

    /// @notice Funded but not yet consumed or reclaimed collateral and spot quote, across all owners.
    uint256 public unconsumedFundingAtoms;
    mapping(address account => bytes32 packageId) public activePackageOf;
    mapping(address account => bytes32 requestKey) public activeRequestKeyOf;
    mapping(bytes32 packageId => mapping(address owner => Funding requestFunding)) public funding;
    mapping(bytes32 requestKey => RequestRecord requestData) private _requests;
    mapping(bytes32 packageId => bytes32 requestKey) private _packageRequestKey;

    constructor(
        AsyncBondedPackageCoordinator coordinator_,
        bytes32 coordinatorCodeHash_,
        address market_,
        bytes32 marketCodeHash_,
        IERC20 collateralToken_,
        bytes32 collateralTokenCodeHash_,
        GmxV2IsolatedAccountFactory factory_,
        bytes32 factoryCodeHash_,
        IGmxV2OrderVerifier orderVerifier_,
        bytes32 orderVerifierCodeHash_,
        GmxV2.Deployment memory deployment
    ) {
        if (
            address(coordinator_) == address(0) || market_ == address(0) || address(collateralToken_) == address(0)
                || address(coordinator_).codehash != coordinatorCodeHash_ || market_.codehash != marketCodeHash_
                || address(collateralToken_).codehash != collateralTokenCodeHash_ || coordinatorCodeHash_ == bytes32(0)
                || address(orderVerifier_).codehash != orderVerifierCodeHash_ || marketCodeHash_ == bytes32(0)
                || collateralTokenCodeHash_ == bytes32(0) || orderVerifierCodeHash_ == bytes32(0)
                || address(coordinator_.bondToken()) != address(collateralToken_) || address(factory_).code.length == 0
                || factoryCodeHash_ == bytes32(0) || address(factory_).codehash != factoryCodeHash_
                || factory_.market() != market_ || address(factory_.collateralToken()) != address(collateralToken_)
                || factory_.deploymentHash() != keccak256(abi.encode(deployment))
        ) revert InvalidConfiguration();
        _validateDeployment(deployment);
        coordinator = coordinator_;
        market = market_;
        collateralToken = collateralToken_;
        coordinatorCodeHash = coordinatorCodeHash_;
        marketCodeHash = marketCodeHash_;
        collateralTokenCodeHash = collateralTokenCodeHash_;
        orderVerifier = orderVerifier_;
        orderVerifierCodeHash = orderVerifierCodeHash_;
        dataStore = deployment.dataStore;
        orderHandler = deployment.orderHandler;
        roleStore = deployment.roleStore;
        factory = factory_;
        factoryCodeHash = factoryCodeHash_;
        orderHandlerCodeHash = deployment.orderHandlerCodeHash;
    }

    function requestAccount(bytes32 requestKey) external view returns (address) {
        return _requests[requestKey].account;
    }

    function requestEvidence(bytes32 requestKey)
        external
        view
        returns (
            Status status,
            bytes32 evidenceHash,
            uint256 positionSizeBefore,
            uint256 positionSizeAfter,
            uint64 revision
        )
    {
        RequestRecord storage stored = _requests[requestKey];
        return
            (stored.status, stored.evidenceHash, stored.positionSizeBefore, stored.positionSizeAfter, stored.revision);
    }

    function requestRegistrationHash(bytes32 requestKey) external view returns (bytes32) {
        return keccak256(abi.encode(_requests[requestKey].registration));
    }

    /// @notice The package owner funds its own request from its wallet: collateral plus the spot quote
    /// bound, and the GMX execution fee as `msg.value`. The owner's factory account must already exist.
    function fundRequest(bytes32 packageId, VenueRequest calldata venueRequest) external payable nonReentrant {
        _assertDeployment();
        address account = _accountOf(msg.sender);
        _validateRequest(venueRequest);
        if (packageId == bytes32(0) || venueRequest.spot.fundingOwner != msg.sender) revert InvalidRequest();
        if (activePackageOf[account] != bytes32(0) || funding[packageId][msg.sender].requestPayloadHash != bytes32(0)) {
            revert AlreadyFunded();
        }
        if (msg.value != venueRequest.executionFeeWei) revert FundingMismatch();
        bytes32 requestPayloadHash = keccak256(abi.encode(venueRequest));
        uint256 totalFunding = venueRequest.collateralAtoms + venueRequest.spot.maxQuoteAtoms;
        activePackageOf[account] = packageId;
        funding[packageId][msg.sender] = Funding({
            account: account,
            requestPayloadHash: requestPayloadHash,
            collateralAtoms: venueRequest.collateralAtoms,
            spotQuoteAtoms: venueRequest.spot.maxQuoteAtoms,
            executionFeeWei: venueRequest.executionFeeWei,
            submissionDeadline: venueRequest.submissionDeadline,
            consumed: false
        });
        unconsumedFundingAtoms += totalFunding;
        uint256 beforeBalance = collateralToken.balanceOf(address(this));
        collateralToken.safeTransferFrom(msg.sender, address(this), totalFunding);
        if (collateralToken.balanceOf(address(this)) - beforeBalance != totalFunding) {
            revert FundingMismatch();
        }
        emit RequestFunded(
            packageId,
            msg.sender,
            requestPayloadHash,
            venueRequest.collateralAtoms,
            venueRequest.spot.maxQuoteAtoms,
            venueRequest.executionFeeWei
        );
    }

    function reclaimExpiredFunding(bytes32 packageId) external nonReentrant {
        _assertDeployment();
        Funding memory reserved = funding[packageId][msg.sender];
        if (reserved.requestPayloadHash == bytes32(0) || reserved.consumed) revert FundingMissing();
        if (block.timestamp < reserved.submissionDeadline) revert DeadlinePassed();
        uint256 totalFunding = reserved.collateralAtoms + reserved.spotQuoteAtoms;
        delete funding[packageId][msg.sender];
        if (activePackageOf[reserved.account] == packageId) activePackageOf[reserved.account] = bytes32(0);
        unconsumedFundingAtoms -= totalFunding;
        _transferExactCollateral(msg.sender, totalFunding);
        (bool sent,) = payable(msg.sender).call{value: reserved.executionFeeWei}("");
        if (!sent) revert FundingMismatch();
        emit ExpiredFundingReclaimed(packageId, msg.sender);
    }

    function createRequest(bytes32 packageId, VenueRequest calldata venueRequest)
        external
        nonReentrant
        returns (bytes32 requestKey)
    {
        _assertDeployment();
        if (msg.sender != address(coordinator)) revert UnauthorizedCaller();
        _validateRequest(venueRequest);
        bytes32 requestPayloadHash = keccak256(abi.encode(venueRequest));
        address owner = _validatePackageBinding(packageId, requestPayloadHash, venueRequest);
        GmxV2IsolatedAccount account = GmxV2IsolatedAccount(_accountOf(owner));
        Funding storage reserved = funding[packageId][owner];
        if (
            activePackageOf[address(account)] != packageId || reserved.account != address(account)
                || reserved.requestPayloadHash != requestPayloadHash || reserved.consumed
                || reserved.collateralAtoms != venueRequest.collateralAtoms
                || reserved.spotQuoteAtoms != venueRequest.spot.maxQuoteAtoms
                || reserved.executionFeeWei != venueRequest.executionFeeWei
        ) revert FundingMismatch();
        if (block.timestamp >= venueRequest.submissionDeadline) revert DeadlinePassed();
        reserved.consumed = true;
        uint256 totalFunding = venueRequest.collateralAtoms + venueRequest.spot.maxQuoteAtoms;
        unconsumedFundingAtoms -= totalFunding;

        GmxV2.RequestRegistration memory registration = GmxV2.RequestRegistration({
            packageId: packageId,
            requestPayloadHash: requestPayloadHash,
            beneficiary: owner,
            refundRecipient: owner,
            market: market,
            collateralToken: address(collateralToken),
            sizeDeltaUsd: _absoluteSize(venueRequest.sizeDelta),
            isLong: false,
            collateralAtoms: venueRequest.collateralAtoms,
            acceptablePrice: venueRequest.acceptablePrice,
            executionFeeWei: venueRequest.executionFeeWei,
            callbackGasLimit: venueRequest.callbackGasLimit,
            submissionDeadline: venueRequest.submissionDeadline,
            venueDeadline: venueRequest.venueDeadline,
            recoveryDeadline: venueRequest.recoveryDeadline
        });
        uint256 beforeBalance = collateralToken.balanceOf(address(account));
        collateralToken.safeTransfer(address(account), totalFunding);
        if (collateralToken.balanceOf(address(account)) - beforeBalance != totalFunding) {
            revert FundingMismatch();
        }
        requestKey = account.createPackageEntry{value: venueRequest.executionFeeWei}(
            packageId, requestPayloadHash, venueRequest
        );
        if (
            requestKey == bytes32(0) || _requests[requestKey].status != Status.NONE
                || _packageRequestKey[packageId] != bytes32(0)
        ) revert InvalidRequest();
        uint256 positionSizeBefore = _positionSize(address(account), venueRequest.sizeDelta > 0);
        if (positionSizeBefore != 0) revert InvalidRequest();
        _requests[requestKey] = RequestRecord({
            registration: registration,
            account: address(account),
            status: Status.PENDING,
            evidenceHash: bytes32(0),
            callbackDataHash: bytes32(0),
            positionSizeBefore: positionSizeBefore,
            positionSizeAfter: 0,
            revision: 1,
            recovering: false
        });
        _packageRequestKey[packageId] = requestKey;
        activeRequestKeyOf[address(account)] = requestKey;
        emit RequestCreated(packageId, requestKey, requestPayloadHash);
    }

    function requestRecovery(bytes32 packageId, bytes32 requestKey, RecoveryAction action)
        external
        nonReentrant
        returns (bool)
    {
        _assertDeployment();
        if (msg.sender != address(coordinator)) revert UnauthorizedCaller();
        RequestRecord storage stored = _request(requestKey);
        if (action != RecoveryAction.CANCEL_OR_RECONCILE || stored.registration.packageId != packageId) {
            revert InvalidRequest();
        }
        if (stored.status == Status.EXECUTED || stored.status == Status.RECOVERED) return true;
        if (stored.status == Status.CONFLICT) return false;
        stored.recovering = true;
        _recover(requestKey, stored);
        emit RecoveryRequested(packageId, requestKey);
        return true;
    }

    function processRecovery(bytes32 requestKey) external nonReentrant returns (bool recovered) {
        _assertDeployment();
        RequestRecord storage stored = _request(requestKey);
        if (!stored.recovering || stored.status == Status.CONFLICT) revert InvalidOutcome();
        recovered = _recover(requestKey, stored);
        if (recovered) emit RecoveryRequested(stored.registration.packageId, requestKey);
    }

    function _recover(bytes32 requestKey, RequestRecord storage stored) private returns (bool) {
        if (stored.status == Status.EXECUTED || stored.status == Status.RECOVERED) return true;
        if (stored.status == Status.CANCELLED) {
            if (
                IGmxV2DataStore(dataStore).containsBytes32(ORDER_LIST, requestKey)
                    || _positionSize(stored.account, stored.registration.isLong) != stored.positionSizeBefore
            ) return false;
            _record(stored, requestKey, Status.RECOVERED, _recoveryHash(requestKey), stored.positionSizeBefore);
            return true;
        }
        if (IGmxV2DataStore(dataStore).containsBytes32(ORDER_LIST, requestKey)) {
            if (block.timestamp < stored.registration.venueDeadline) return false;
            try GmxV2IsolatedAccount(stored.account).cancelEntry(requestKey) {}
            catch {
                return false;
            }
            if (stored.status == Status.EXECUTED || stored.status == Status.RECOVERED) {
                return true;
            }
            if (stored.status == Status.CONFLICT || IGmxV2DataStore(dataStore).containsBytes32(ORDER_LIST, requestKey))
            {
                return false;
            }
            _record(stored, requestKey, Status.RECOVERED, _recoveryHash(requestKey), stored.positionSizeBefore);
            return true;
        }
        uint256 currentSize = _positionSize(stored.account, stored.registration.isLong);
        if (currentSize == stored.positionSizeBefore) {
            _record(stored, requestKey, Status.RECOVERED, _recoveryHash(requestKey), currentSize);
            return true;
        }
        if (
            currentSize < stored.positionSizeBefore
                || currentSize - stored.positionSizeBefore != stored.registration.sizeDeltaUsd
        ) return false;
        _record(stored, requestKey, Status.EXECUTED, _executionReconciliationHash(requestKey, currentSize), currentSize);
        return true;
    }

    /// @notice Sells the rolled-back spot inventory to the owner and frees the owner's account. Callable by
    /// the package owner or the package solver; every amount goes to the owner.
    function finalizeUnfilledRequest(bytes32 requestKey) external nonReentrant {
        _assertDeployment();
        RequestRecord storage stored = _request(requestKey);
        bytes32 packageId = stored.registration.packageId;
        if (
            msg.sender != stored.registration.beneficiary
                && msg.sender != coordinator.packageState(packageId).terms.solver
        ) revert UnauthorizedCaller();
        if (stored.status != Status.CANCELLED && stored.status != Status.RECOVERED) revert InvalidOutcome();
        if (
            IGmxV2DataStore(dataStore).containsBytes32(ORDER_LIST, requestKey)
                || _positionSize(stored.account, stored.registration.isLong) != stored.positionSizeBefore
        ) revert InvalidOutcome();
        GmxV2IsolatedAccount account = _requireAccount(stored.account);
        account.rollbackSpot(packageId, requestKey);
        account.assertSpotCleared();
        delete funding[packageId][stored.registration.beneficiary];
        if (activePackageOf[address(account)] == packageId) activePackageOf[address(account)] = bytes32(0);
        if (activeRequestKeyOf[address(account)] == requestKey) activeRequestKeyOf[address(account)] = bytes32(0);
        emit UnfilledRequestReleased(packageId, requestKey, stored.status);
    }

    /// @notice Returns collateral held by the adapter beyond every owner's unconsumed funding. GMX never
    /// pays the adapter, so this is only stray balance; the owner of a terminal request receives it.
    function sweepUnpositionedCollateral(bytes32 requestKey) external nonReentrant {
        _assertDeployment();
        RequestRecord storage stored = _request(requestKey);
        if (msg.sender != stored.registration.beneficiary) revert UnauthorizedCaller();
        if (stored.status != Status.EXECUTED && stored.status != Status.CANCELLED && stored.status != Status.RECOVERED) revert InvalidOutcome();
        uint256 amount = _residualAtoms();
        if (amount == 0) revert InvalidOutcome();
        _transferExactCollateral(msg.sender, amount);
    }

    function finalizeExitedPosition(bytes32 packageId, bytes32 entryRequestKey) external nonReentrant {
        _assertDeployment();
        if (msg.sender != factory.exitController() || msg.sender.codehash != factory.exitControllerCodeHash()) {
            revert UnauthorizedCaller();
        }
        RequestRecord storage stored = _request(entryRequestKey);
        GmxV2IsolatedAccount account = _requireAccount(stored.account);
        if (
            activePackageOf[address(account)] != packageId || activeRequestKeyOf[address(account)] != entryRequestKey
                || stored.registration.packageId != packageId || stored.status != Status.EXECUTED
                || account.positionSize(false) != 0 || account.positionSize(true) != 0
                || account.hasActiveSpotInventory()
        ) revert InvalidOutcome();
        account.assertSpotCleared();
        delete funding[packageId][stored.registration.beneficiary];
        activePackageOf[address(account)] = bytes32(0);
        activeRequestKeyOf[address(account)] = bytes32(0);
        emit ExitedPositionReleased(packageId, entryRequestKey);
    }

    function afterOrderExecution(
        bytes32 requestKey,
        GmxV2.EventLogData calldata orderData,
        GmxV2.EventLogData calldata eventData
    ) external {
        _assertCallbackCaller();
        RequestRecord storage stored = _request(requestKey);
        orderVerifier.verify(stored.account, address(this), stored.registration, orderData);
        uint256 currentSize = _positionSize(stored.account, stored.registration.isLong);
        bytes32 callbackDataHash = keccak256(abi.encode(orderData, eventData));
        if (
            currentSize < stored.positionSizeBefore
                || currentSize - stored.positionSizeBefore != stored.registration.sizeDeltaUsd
                || !GmxV2IsolatedAccount(stored.account).hasActiveSpotInventory()
        ) {
            _record(stored, requestKey, Status.CONFLICT, callbackDataHash, currentSize);
            return;
        }
        _record(stored, requestKey, Status.EXECUTED, callbackDataHash, currentSize);
    }

    function afterOrderCancellation(
        bytes32 requestKey,
        GmxV2.EventLogData calldata orderData,
        GmxV2.EventLogData calldata eventData
    ) external {
        _assertCallbackCaller();
        RequestRecord storage stored = _request(requestKey);
        orderVerifier.verify(stored.account, address(this), stored.registration, orderData);
        Status status = stored.recovering ? Status.RECOVERED : Status.CANCELLED;
        uint256 currentSize = _positionSize(stored.account, stored.registration.isLong);
        if (
            currentSize != stored.positionSizeBefore
                || IGmxV2DataStore(dataStore).containsBytes32(ORDER_LIST, requestKey)
        ) status = Status.CONFLICT;
        _record(stored, requestKey, status, keccak256(abi.encode(orderData, eventData)), currentSize);
    }

    function afterOrderFrozen(
        bytes32 requestKey,
        GmxV2.EventLogData calldata orderData,
        GmxV2.EventLogData calldata eventData
    ) external {
        _assertCallbackCaller();
        RequestRecord storage stored = _request(requestKey);
        orderVerifier.verify(stored.account, address(this), stored.registration, orderData);
        uint256 currentSize = _positionSize(stored.account, stored.registration.isLong);
        Status status = currentSize == stored.positionSizeBefore
            && IGmxV2DataStore(dataStore).containsBytes32(ORDER_LIST, requestKey)
            ? Status.FROZEN
            : Status.CONFLICT;
        _record(stored, requestKey, status, keccak256(abi.encode(orderData, eventData)), currentSize);
    }

    function relayEvidence(bytes32 requestKey, uint64 expectedVersion) external nonReentrant {
        _assertDeployment();
        RequestRecord storage stored = _request(requestKey);
        AsyncBondedPackageCoordinator.Outcome outcome;
        uint256 intermediateResidualAtoms;
        if (stored.status == Status.EXECUTED) {
            outcome = AsyncBondedPackageCoordinator.Outcome.EXECUTED;
        } else if (stored.status == Status.CANCELLED) {
            outcome = AsyncBondedPackageCoordinator.Outcome.CANCELLED;
        } else if (stored.status == Status.FROZEN) {
            outcome = AsyncBondedPackageCoordinator.Outcome.FROZEN;
            intermediateResidualAtoms = stored.registration.collateralAtoms;
        } else if (stored.status == Status.RECOVERED) {
            outcome = AsyncBondedPackageCoordinator.Outcome.RECOVERED;
        } else {
            revert InvalidOutcome();
        }

        AsyncBondedPackageCoordinator.Package memory packageData =
            coordinator.packageState(stored.registration.packageId);
        if (packageData.terms.residualAsset != address(collateralToken)) revert InvalidOutcome();
        uint256 terminalResidualAtoms = _residualAtoms();
        if (
            (stored.status == Status.EXECUTED || stored.status == Status.CANCELLED || stored.status == Status.RECOVERED)
                && terminalResidualAtoms != 0
        ) revert InvalidOutcome();
        if (stored.status == Status.CANCELLED || stored.status == Status.RECOVERED) {
            _requireAccount(stored.account).assertSpotCleared();
        }
        coordinator.recordVenueEvidence(
            stored.registration.packageId,
            expectedVersion,
            AsyncBondedPackageCoordinator.VenueEvidence({
                requestKey: requestKey,
                requestPayloadHash: stored.registration.requestPayloadHash,
                evidenceSchemaHash: coordinator.EVIDENCE_SCHEMA_ID(),
                evidenceHash: stored.evidenceHash,
                outcome: outcome,
                lossAsset: packageData.terms.lossAsset,
                residualAsset: packageData.terms.residualAsset,
                observedLossAtoms: 0,
                intermediateResidualAtoms: intermediateResidualAtoms,
                terminalResidualAtoms: terminalResidualAtoms
            })
        );
        emit EvidenceRelayed(requestKey, stored.registration.packageId, stored.revision);
    }

    function _record(
        RequestRecord storage stored,
        bytes32 requestKey,
        Status status,
        bytes32 callbackDataHash,
        uint256 positionSizeAfter
    ) private {
        bytes32 evidenceHash = keccak256(
            abi.encode(
                EVIDENCE_DOMAIN,
                block.chainid,
                address(this),
                stored.registration.packageId,
                requestKey,
                stored.registration.requestPayloadHash,
                status,
                callbackDataHash,
                stored.positionSizeBefore,
                positionSizeAfter
            )
        );
        if (stored.status == status && stored.evidenceHash == evidenceHash) return;
        bool authoritativeProgression = status == Status.EXECUTED
            && (stored.status == Status.PENDING
                || stored.status == Status.CANCELLED
                || stored.status == Status.FROZEN
                || stored.status == Status.RECOVERED);
        bool recoveryProgression = status == Status.RECOVERED
            && (stored.status == Status.PENDING || stored.status == Status.CANCELLED || stored.status == Status.FROZEN);
        bool normalProgression = stored.status == Status.PENDING
            && (status == Status.CANCELLED || status == Status.FROZEN || status == Status.CONFLICT);
        if (!authoritativeProgression && !recoveryProgression && !normalProgression) {
            status = Status.CONFLICT;
            evidenceHash = keccak256(abi.encode(EVIDENCE_DOMAIN, "CONFLICT", stored.evidenceHash, evidenceHash));
        }
        stored.status = status;
        stored.evidenceHash = evidenceHash;
        stored.callbackDataHash = callbackDataHash;
        stored.positionSizeAfter = positionSizeAfter;
        stored.revision++;
        emit OutcomeRecorded(requestKey, status, stored.revision, evidenceHash);
    }

    function _validateRequest(VenueRequest calldata venueRequest) private view {
        uint256 cancellationDelay = IGmxV2DataStore(dataStore).getUint(REQUEST_EXPIRATION_TIME);
        if (
            venueRequest.marketId != bytes32(uint256(uint160(market)))
                || venueRequest.collateralToken != address(collateralToken) || venueRequest.sizeDelta >= 0
                || venueRequest.sizeDelta == type(int256).min || venueRequest.collateralAtoms == 0
                || venueRequest.acceptablePrice == 0 || venueRequest.executionFeeWei == 0
                || venueRequest.callbackGasLimit == 0 || venueRequest.orderHash == bytes32(0)
                || venueRequest.quoteHash == bytes32(0) || venueRequest.routeHash == bytes32(0)
                || venueRequest.spot.maxQuoteAtoms == 0 || block.timestamp >= venueRequest.submissionDeadline
                || venueRequest.submissionDeadline >= venueRequest.venueDeadline
                || venueRequest.venueDeadline >= venueRequest.recoveryDeadline
                || cancellationDelay > type(uint64).max - block.timestamp
                || venueRequest.venueDeadline < block.timestamp + cancellationDelay
        ) revert InvalidRequest();
    }

    function _validatePackageBinding(bytes32 packageId, bytes32 requestPayloadHash, VenueRequest calldata venueRequest)
        private
        view
        returns (address owner)
    {
        AsyncBondedPackageCoordinator.Package memory packageData = coordinator.packageState(packageId);
        AsyncBondedPackageCoordinator.Terms memory terms = packageData.terms;
        if (
            terms.adapter != address(this) || terms.handler != address(this) || terms.owner == address(0)
                || terms.adapterCodeHash != address(this).codehash || terms.handlerCodeHash != address(this).codehash
                || terms.requestPayloadHash != requestPayloadHash || terms.orderHash != venueRequest.orderHash
                || terms.quoteHash != venueRequest.quoteHash || terms.routeHash != venueRequest.routeHash
                || terms.nonce != venueRequest.packageNonce || venueRequest.spot.fundingOwner != terms.owner
                || terms.lossAsset != address(collateralToken) || terms.residualAsset != address(collateralToken)
                || terms.submissionDeadline != venueRequest.submissionDeadline
                || terms.venueDeadline != venueRequest.venueDeadline
                || terms.recoveryDeadline != venueRequest.recoveryDeadline
        ) revert InvalidRequest();
        return terms.owner;
    }

    /// @notice The owner's account, required to be a live factory account bound to this adapter.
    function _accountOf(address owner) private view returns (address account) {
        account = address(factory.requireAccount(owner));
        _requireAccount(account);
    }

    function _requireAccount(address account) private view returns (GmxV2IsolatedAccount) {
        if (!factory.isAccount(account) || GmxV2IsolatedAccount(account).entryController() != address(this)) {
            revert UnknownAccount();
        }
        return GmxV2IsolatedAccount(account);
    }

    function _residualAtoms() private view returns (uint256) {
        uint256 balance = collateralToken.balanceOf(address(this));
        if (balance < unconsumedFundingAtoms) revert FundingMismatch();
        return balance - unconsumedFundingAtoms;
    }

    function _request(bytes32 requestKey) private view returns (RequestRecord storage stored) {
        stored = _requests[requestKey];
        if (stored.status == Status.NONE) revert InvalidRequest();
    }

    function _positionSize(address account, bool isLong) private view returns (uint256) {
        bytes32 positionKey = keccak256(abi.encode(account, market, address(collateralToken), isLong));
        return IGmxV2DataStore(dataStore).getUint(keccak256(abi.encode(positionKey, SIZE_IN_USD)));
    }

    function _absoluteSize(int256 sizeDelta) private pure returns (uint256) {
        return uint256(sizeDelta > 0 ? sizeDelta : -sizeDelta);
    }

    function _recoveryHash(bytes32 requestKey) private pure returns (bytes32) {
        return keccak256(abi.encode(EVIDENCE_DOMAIN, "OBJECTIVE_CANCELLATION", requestKey));
    }

    function _executionReconciliationHash(bytes32 requestKey, uint256 size) private pure returns (bytes32) {
        return keccak256(abi.encode(EVIDENCE_DOMAIN, "DATA_STORE_EXECUTION", requestKey, size));
    }

    function _transferExactCollateral(address recipient, uint256 amount) private {
        uint256 beforeBalance = collateralToken.balanceOf(recipient);
        collateralToken.safeTransfer(recipient, amount);
        if (collateralToken.balanceOf(recipient) - beforeBalance != amount) revert FundingMismatch();
    }

    function _assertCallbackCaller() private view {
        _assertDeployment();
        if (
            msg.sender != orderHandler || msg.sender.codehash != orderHandlerCodeHash
                || !IGmxV2RoleStore(roleStore).hasRole(msg.sender, CONTROLLER_ROLE)
        ) revert UnauthorizedCaller();
    }

    /// @notice Pins this adapter's own dependencies by code hash, then has the factory's reviewed account
    /// implementation, which carries the identical GMX deployment (equal `deploymentHash`), verify every
    /// GMX contract's code hash and the exchange router's wiring.
    function _assertDeployment() private view {
        if (
            address(coordinator).codehash != coordinatorCodeHash || market.codehash != marketCodeHash
                || address(collateralToken).codehash != collateralTokenCodeHash
                || address(orderVerifier).codehash != orderVerifierCodeHash
                || address(factory).codehash != factoryCodeHash
        ) revert DeploymentChanged();
        GmxV2IsolatedAccount(factory.implementation()).assertDeployment();
    }

    function _validateDeployment(GmxV2.Deployment memory deployment) private view {
        if (
            deployment.dataStore == address(0) || deployment.eventEmitter == address(0)
                || deployment.exchangeRouter == address(0) || deployment.router == address(0)
                || deployment.orderVault == address(0) || deployment.orderHandler == address(0)
                || deployment.roleStore == address(0) || deployment.dataStore.codehash != deployment.dataStoreCodeHash
                || deployment.eventEmitter.codehash != deployment.eventEmitterCodeHash
                || deployment.exchangeRouter.codehash != deployment.exchangeRouterCodeHash
                || deployment.router.codehash != deployment.routerCodeHash
                || deployment.orderVault.codehash != deployment.orderVaultCodeHash
                || deployment.orderHandler.codehash != deployment.orderHandlerCodeHash
                || deployment.roleStore.codehash != deployment.roleStoreCodeHash
        ) revert InvalidConfiguration();
        IGmxV2ExchangeRouter exchange = IGmxV2ExchangeRouter(deployment.exchangeRouter);
        if (
            exchange.dataStore() != deployment.dataStore || exchange.eventEmitter() != deployment.eventEmitter
                || exchange.router() != deployment.router || exchange.orderHandler() != deployment.orderHandler
                || exchange.roleStore() != deployment.roleStore
        ) revert InvalidConfiguration();
    }
}
