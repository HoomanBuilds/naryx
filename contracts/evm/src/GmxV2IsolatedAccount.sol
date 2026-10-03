// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/utils/ReentrancyGuard.sol";
import {IAsyncVenueAdapter} from "./interfaces/IAsyncVenueAdapter.sol";
import {IExactSpotPort} from "./interfaces/IExactSpotPort.sol";
import {GmxV2, IGmxV2DataStore, IGmxV2ExchangeRouter} from "./interfaces/IGmxV2.sol";
import {ISpotFillRecorder} from "./interfaces/ISpotFillRecorder.sol";

/// @notice One owner's isolated GMX V2 strategy account. `GmxV2IsolatedAccountFactory` deploys a single
/// implementation and gives each owner a deterministic minimal clone of it at a CREATE2 address derived
/// from the owner, so every account shares one runtime code hash. The owner funds and receives every
/// leg; the shared entry adapter, exit controller, and spot port are implementation immutables pinned by
/// code hash.
contract GmxV2IsolatedAccount is ISpotFillRecorder, ReentrancyGuard {
    struct Binding {
        address factory;
        address market;
        IERC20 collateralToken;
        GmxV2.Deployment deployment;
        address entryController;
        bytes32 entryControllerCodeHash;
        address exitController;
        bytes32 exitControllerCodeHash;
        IExactSpotPort spotPort;
        bytes32 spotPortCodeHash;
    }

    using SafeERC20 for IERC20;

    bytes32 public constant SIZE_IN_USD = keccak256(abi.encode("SIZE_IN_USD"));
    bytes32 public constant ORDER_LIST = keccak256(abi.encode("ORDER_LIST"));
    bytes32 public constant SPOT_EXIT_EVIDENCE_DOMAIN = keccak256("NARYX_GMX_V2_SPOT_EXIT_EVIDENCE_V1");
    bytes32 public constant SPOT_IN_KIND_EVIDENCE_DOMAIN = keccak256("NARYX_GMX_V2_SPOT_IN_KIND_EVIDENCE_V1");

    error InvalidConfiguration();
    error DeploymentChanged();
    error UnauthorizedCaller();
    error InvalidRequest();
    error FundingMismatch();

    event SpotInventoryOpened(
        bytes32 indexed packageId,
        bytes32 indexed requestKey,
        address indexed fundingOwner,
        uint256 baseAtoms,
        uint256 quoteAtoms
    );
    event SpotInventoryRolledBack(
        bytes32 indexed packageId,
        bytes32 indexed requestKey,
        address indexed fundingOwner,
        uint256 baseAtoms,
        uint256 quoteAtoms
    );
    event SpotInventoryReturnedInKind(
        bytes32 indexed packageId, bytes32 indexed requestKey, address indexed recipient, uint256 baseAtoms
    );

    struct SpotFillContext {
        uint8 action;
        uint256 packageNonce;
        bytes32 fillCommitment;
        bytes32 orderHash;
        bytes32 quoteHash;
        bytes32 routeHash;
        uint256 baseAtoms;
        uint256 quoteBound;
    }

    struct SpotSale {
        uint256 packageNonce;
        bytes32 fillCommitment;
        bytes32 orderHash;
        bytes32 quoteHash;
        bytes32 routeHash;
        uint256 baseAtoms;
        uint256 minQuoteAtoms;
    }

    address public immutable factory;
    address public immutable entryController;
    bytes32 public immutable entryControllerCodeHash;
    address public immutable exitController;
    bytes32 public immutable exitControllerCodeHash;
    IExactSpotPort public immutable spotPort;
    bytes32 public immutable spotPortCodeHash;
    IERC20 public immutable spotBaseToken;
    bytes32 public immutable spotBaseTokenCodeHash;
    address public immutable market;
    IERC20 public immutable collateralToken;

    address private immutable dataStore;
    address private immutable eventEmitter;
    address private immutable exchangeRouter;
    address private immutable router;
    address private immutable orderVault;
    address private immutable orderHandler;
    address private immutable roleStore;
    bytes32 private immutable dataStoreCodeHash;
    bytes32 private immutable eventEmitterCodeHash;
    bytes32 private immutable exchangeRouterCodeHash;
    bytes32 private immutable routerCodeHash;
    bytes32 private immutable orderVaultCodeHash;
    bytes32 private immutable orderHandlerCodeHash;
    bytes32 private immutable roleStoreCodeHash;
    bytes32 public immutable deploymentHash;

    address private immutable implementation;

    /// @notice Set once by the factory in the clone's storage. Zero forever on the implementation.
    address public owner;

    GmxV2.SpotEntryRegistration private _spotRegistration;
    bytes32 public activeSpotRequestKey;
    uint256 public activeSpotQuoteAtoms;
    bool public hasActiveSpotInventory;
    SpotFillContext private _spotFillContext;
    uint256 private _recordedSpotQuoteAtoms;

    constructor(Binding memory p) {
        if (
            p.factory.code.length == 0 || p.market == address(0) || address(p.collateralToken) == address(0)
                || p.entryController == address(0) || p.entryControllerCodeHash == bytes32(0)
                || p.entryController.codehash != p.entryControllerCodeHash || p.exitController == address(0)
                || p.exitControllerCodeHash == bytes32(0) || p.exitController.codehash != p.exitControllerCodeHash
                || address(p.spotPort) == address(0) || p.spotPortCodeHash == bytes32(0)
                || address(p.spotPort).codehash != p.spotPortCodeHash || p.spotPort.verifier() != p.factory
                || p.spotPort.verifierCodeHash() != p.factory.codehash
                || address(p.spotPort.quoteToken()) != address(p.collateralToken)
                || address(p.spotPort.baseToken()) == address(0)
                || address(p.spotPort.baseToken()) == address(p.collateralToken)
        ) revert InvalidConfiguration();
        _validateDeployment(p.deployment);
        p.spotPort.assertDeployment();
        implementation = address(this);
        factory = p.factory;
        market = p.market;
        collateralToken = p.collateralToken;
        entryController = p.entryController;
        entryControllerCodeHash = p.entryControllerCodeHash;
        exitController = p.exitController;
        exitControllerCodeHash = p.exitControllerCodeHash;
        spotPort = p.spotPort;
        spotPortCodeHash = p.spotPortCodeHash;
        spotBaseToken = p.spotPort.baseToken();
        spotBaseTokenCodeHash = address(p.spotPort.baseToken()).codehash;
        dataStore = p.deployment.dataStore;
        eventEmitter = p.deployment.eventEmitter;
        exchangeRouter = p.deployment.exchangeRouter;
        router = p.deployment.router;
        orderVault = p.deployment.orderVault;
        orderHandler = p.deployment.orderHandler;
        roleStore = p.deployment.roleStore;
        dataStoreCodeHash = p.deployment.dataStoreCodeHash;
        eventEmitterCodeHash = p.deployment.eventEmitterCodeHash;
        exchangeRouterCodeHash = p.deployment.exchangeRouterCodeHash;
        routerCodeHash = p.deployment.routerCodeHash;
        orderVaultCodeHash = p.deployment.orderVaultCodeHash;
        orderHandlerCodeHash = p.deployment.orderHandlerCodeHash;
        roleStoreCodeHash = p.deployment.roleStoreCodeHash;
        deploymentHash = keccak256(abi.encode(p.deployment));
    }

    /// @notice Called once by the factory in the same transaction that clones the account.
    function initialize(address owner_) external {
        if (msg.sender != factory || address(this) == implementation || owner != address(0) || owner_ == address(0)) {
            revert UnauthorizedCaller();
        }
        owner = owner_;
    }

    /// @notice The owner is also the funding owner: it funds collateral and spot quote and receives every
    /// refund, rollback, and exit proceed.
    function fundingAuthority() external view returns (address) {
        return owner;
    }

    function createPackageEntry(
        bytes32 packageId,
        bytes32 requestPayloadHash,
        IAsyncVenueAdapter.VenueRequest calldata venueRequest
    ) external payable nonReentrant returns (bytes32 requestKey) {
        _assertEntryController();
        _assertSpotDeployment();
        _validateSpotRequest(packageId, requestPayloadHash, venueRequest);
        GmxV2.RequestRegistration memory registration = _entryRegistration(packageId, requestPayloadHash, venueRequest);
        if (
            registration.packageId == bytes32(0) || registration.requestPayloadHash == bytes32(0)
                || registration.beneficiary != owner || registration.refundRecipient != owner
                || registration.market != market || registration.collateralToken != address(collateralToken)
                || registration.isLong || registration.sizeDeltaUsd == 0 || registration.collateralAtoms == 0
                || registration.acceptablePrice == 0 || registration.executionFeeWei != msg.value
                || registration.callbackGasLimit == 0
        ) revert InvalidRequest();
        IAsyncVenueAdapter.SpotEntry calldata spotEntry = venueRequest.spot;
        if (
            hasActiveSpotInventory || activeSpotRequestKey != bytes32(0) || spotBaseToken.balanceOf(address(this)) != 0
                || collateralToken.balanceOf(address(this)) != registration.collateralAtoms + spotEntry.maxQuoteAtoms
                || address(this).balance != msg.value || spotBaseToken.allowance(address(this), address(spotPort)) != 0
                || collateralToken.allowance(address(this), address(spotPort)) != 0
        ) revert FundingMismatch();

        _armSpotFill(
            1,
            venueRequest.packageNonce,
            spotEntry.entryFillCommitment,
            venueRequest.orderHash,
            venueRequest.quoteHash,
            venueRequest.routeHash,
            spotEntry.baseAtoms,
            spotEntry.maxQuoteAtoms
        );
        collateralToken.forceApprove(address(spotPort), spotEntry.maxQuoteAtoms);
        uint256 quoteIn = spotPort.buyExactOutput(
            venueRequest.packageNonce,
            spotEntry.entryFillCommitment,
            venueRequest.orderHash,
            venueRequest.quoteHash,
            venueRequest.routeHash,
            spotEntry.baseAtoms,
            spotEntry.maxQuoteAtoms
        );
        collateralToken.forceApprove(address(spotPort), 0);
        if (_spotFillContext.action != 0 || quoteIn == 0 || quoteIn != _recordedSpotQuoteAtoms) {
            revert FundingMismatch();
        }
        _recordedSpotQuoteAtoms = 0;

        uint256 unusedQuote = spotEntry.maxQuoteAtoms - quoteIn;
        if (unusedQuote != 0) _transferExactToken(collateralToken, spotEntry.fundingOwner, unusedQuote);
        if (
            spotBaseToken.balanceOf(address(this)) != spotEntry.baseAtoms
                || collateralToken.balanceOf(address(this)) != registration.collateralAtoms
        ) revert FundingMismatch();

        _sendCollateral(registration.collateralAtoms);
        _sendExecutionFee(registration.executionFeeWei);
        requestKey = IGmxV2ExchangeRouter(exchangeRouter).createOrder(_increaseParams(registration));
        if (requestKey == bytes32(0)) revert InvalidRequest();
        if (
            spotBaseToken.balanceOf(address(this)) != spotEntry.baseAtoms
                || collateralToken.balanceOf(address(this)) != 0 || address(this).balance != 0
                || spotBaseToken.allowance(address(this), address(spotPort)) != 0
                || collateralToken.allowance(address(this), address(spotPort)) != 0
        ) revert FundingMismatch();
        _spotRegistration = GmxV2.SpotEntryRegistration({
            packageId: packageId,
            requestPayloadHash: requestPayloadHash,
            fundingOwner: spotEntry.fundingOwner,
            port: spotEntry.port,
            portCodeHash: spotEntry.portCodeHash,
            baseToken: spotEntry.baseToken,
            quoteToken: spotEntry.quoteToken,
            packageNonce: venueRequest.packageNonce,
            orderHash: venueRequest.orderHash,
            quoteHash: venueRequest.quoteHash,
            routeHash: venueRequest.routeHash,
            entryFillCommitment: spotEntry.entryFillCommitment,
            rollbackFillCommitment: spotEntry.rollbackFillCommitment,
            baseAtoms: spotEntry.baseAtoms,
            maxQuoteAtoms: spotEntry.maxQuoteAtoms,
            rollbackMinQuoteAtoms: spotEntry.rollbackMinQuoteAtoms
        });
        activeSpotRequestKey = requestKey;
        activeSpotQuoteAtoms = quoteIn;
        hasActiveSpotInventory = true;
        emit SpotInventoryOpened(packageId, requestKey, spotEntry.fundingOwner, spotEntry.baseAtoms, quoteIn);
    }

    /// @notice Sells the spot back for at least the signed rollback floor, or, when `inKind`, returns the spot
    /// base token itself to the funding owner. The entry controller decides who may choose `inKind` and when.
    function rollbackSpot(bytes32 packageId, bytes32 requestKey, bool inKind)
        external
        nonReentrant
        returns (uint256 quoteOut)
    {
        _assertEntryController();
        _assertSpotDeployment();
        GmxV2.SpotEntryRegistration memory registration = _spotRegistration;
        if (
            !hasActiveSpotInventory || packageId == bytes32(0) || packageId != registration.packageId
                || requestKey == bytes32(0) || requestKey != activeSpotRequestKey
                || IGmxV2DataStore(dataStore).containsBytes32(ORDER_LIST, requestKey) || positionSize(false) != 0
                || positionSize(true) != 0 || spotBaseToken.balanceOf(address(this)) != registration.baseAtoms
                || collateralToken.balanceOf(address(this)) != 0 || address(this).balance != 0
                || spotBaseToken.allowance(address(this), address(spotPort)) != 0
                || collateralToken.allowance(address(this), address(spotPort)) != 0
        ) revert InvalidRequest();

        if (!inKind) {
            quoteOut = _sellSpot(
                SpotSale({
                    packageNonce: registration.packageNonce,
                    fillCommitment: registration.rollbackFillCommitment,
                    orderHash: registration.orderHash,
                    quoteHash: registration.quoteHash,
                    routeHash: registration.routeHash,
                    baseAtoms: registration.baseAtoms,
                    minQuoteAtoms: registration.rollbackMinQuoteAtoms
                })
            );
        }
        _releaseSpot(packageId, requestKey, registration.fundingOwner, registration.baseAtoms, quoteOut, inKind);
        if (!inKind) {
            emit SpotInventoryRolledBack(
                packageId, requestKey, registration.fundingOwner, registration.baseAtoms, quoteOut
            );
        }
    }

    /// @notice Sells the spot for at least the signed exit floor, or, when `inKind`, returns the spot base token
    /// itself to the owner. The exit controller decides who may choose `inKind` and when.
    function completeSuccessfulExit(GmxV2.ExitRegistration calldata registration, bytes32 exitRequestKey, bool inKind)
        external
        nonReentrant
        returns (GmxV2.SpotExitResult memory result)
    {
        _assertExitController();
        _assertSpotDeployment();
        GmxV2.SpotEntryRegistration memory spotRegistration = _spotRegistration;
        bytes32 spotRegistrationHash = keccak256(abi.encode(spotRegistration));
        if (
            !hasActiveSpotInventory || exitRequestKey == bytes32(0)
                || registration.packageId != spotRegistration.packageId
                || registration.entryRequestKey != activeSpotRequestKey
                || registration.spotRegistrationHash != spotRegistrationHash || registration.account != address(this)
                || registration.owner != owner || registration.receiver != owner
                || registration.spotProceedsRecipient != owner || registration.market != market
                || registration.collateralToken != address(collateralToken) || registration.isLong
                || registration.fullCloseSizeUsd == 0 || registration.spotBaseAtoms != spotRegistration.baseAtoms
                || registration.packageNonce != spotRegistration.packageNonce || registration.spotMinQuoteAtoms == 0
                || registration.exitOrderHash == bytes32(0) || registration.exitQuoteHash == bytes32(0)
                || registration.exitRouteHash == bytes32(0) || registration.exitFillCommitment == bytes32(0)
                || registration.exitFillCommitment == spotRegistration.entryFillCommitment
                || registration.exitFillCommitment == spotRegistration.rollbackFillCommitment
                || IGmxV2DataStore(dataStore).containsBytes32(ORDER_LIST, exitRequestKey) || positionSize(false) != 0
                || positionSize(true) != 0 || spotBaseToken.balanceOf(address(this)) != spotRegistration.baseAtoms
                || collateralToken.balanceOf(address(this)) != 0 || address(this).balance != 0
                || spotBaseToken.allowance(address(this), address(spotPort)) != 0
                || collateralToken.allowance(address(this), address(spotPort)) != 0
        ) revert InvalidRequest();

        if (!inKind) {
            result.quoteAtoms = _sellSpot(
                SpotSale({
                    packageNonce: registration.packageNonce,
                    fillCommitment: registration.exitFillCommitment,
                    orderHash: registration.exitOrderHash,
                    quoteHash: registration.exitQuoteHash,
                    routeHash: registration.exitRouteHash,
                    baseAtoms: registration.spotBaseAtoms,
                    minQuoteAtoms: registration.spotMinQuoteAtoms
                })
            );
        }
        result.entryRequestPayloadHash = spotRegistration.requestPayloadHash;
        result.entryCommitmentsHash = keccak256(
            abi.encode(
                spotRegistration.packageNonce,
                spotRegistration.orderHash,
                spotRegistration.quoteHash,
                spotRegistration.routeHash,
                spotRegistration.entryFillCommitment,
                spotRegistration.rollbackFillCommitment
            )
        );
        bytes32 exitCommitmentsHash = keccak256(
            abi.encode(
                registration.packageNonce,
                registration.exitOrderHash,
                registration.exitQuoteHash,
                registration.exitRouteHash,
                registration.exitFillCommitment
            )
        );
        bytes32 exitIdentityHash = keccak256(
            abi.encode(
                registration.packageId,
                registration.entryRequestKey,
                exitRequestKey,
                registration.authorizationHash,
                spotRegistrationHash,
                exitCommitmentsHash
            )
        );
        result.evidenceHash = keccak256(
            abi.encode(
                inKind ? SPOT_IN_KIND_EVIDENCE_DOMAIN : SPOT_EXIT_EVIDENCE_DOMAIN,
                block.chainid,
                address(this),
                exitIdentityHash,
                registration.spotBaseAtoms,
                result.quoteAtoms,
                registration.spotProceedsRecipient
            )
        );

        _releaseSpot(
            registration.packageId,
            registration.entryRequestKey,
            registration.spotProceedsRecipient,
            registration.spotBaseAtoms,
            result.quoteAtoms,
            inKind
        );
    }

    function activeSpotRegistration() external view returns (GmxV2.SpotEntryRegistration memory) {
        return _spotRegistration;
    }

    function assertSpotCleared() external view {
        _assertSpotDeployment();
        if (
            hasActiveSpotInventory || activeSpotRequestKey != bytes32(0) || spotBaseToken.balanceOf(address(this)) != 0
                || collateralToken.balanceOf(address(this)) != 0 || address(this).balance != 0
                || spotBaseToken.allowance(address(this), address(spotPort)) != 0
                || collateralToken.allowance(address(this), address(spotPort)) != 0
        ) revert FundingMismatch();
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
        SpotFillContext memory expected = _spotFillContext;
        if (
            msg.sender != factory || address(spotPort).codehash != spotPortCodeHash || expected.action == 0
                || strategyAccount != address(this) || packageNonce != expected.packageNonce
                || spotFillCommitment != expected.fillCommitment || orderHash != expected.orderHash
                || quoteHash != expected.quoteHash || routeHash != expected.routeHash || action != expected.action
                || baseToken != address(spotBaseToken) || quoteToken != address(collateralToken)
                || baseAtoms != expected.baseAtoms || quoteAtoms == 0
                || (action == 1 && quoteAtoms > expected.quoteBound)
                || (action == 2 && quoteAtoms < expected.quoteBound) || (action != 1 && action != 2)
        ) revert InvalidRequest();
        delete _spotFillContext;
        _recordedSpotQuoteAtoms = quoteAtoms;
    }

    function createFullClose(GmxV2.ExitRegistration calldata registration)
        external
        payable
        nonReentrant
        returns (bytes32 requestKey)
    {
        _assertExitController();
        GmxV2.SpotEntryRegistration memory spotRegistration = _spotRegistration;
        if (
            registration.packageId == bytes32(0) || registration.entryRequestKey == bytes32(0)
                || registration.authorizationHash == bytes32(0) || registration.account != address(this)
                || registration.owner != owner || registration.receiver != owner || registration.market != market
                || !hasActiveSpotInventory || registration.entryRequestKey != activeSpotRequestKey
                || registration.spotRegistrationHash != keccak256(abi.encode(spotRegistration))
                || registration.spotProceedsRecipient != owner
                || registration.spotBaseAtoms != spotRegistration.baseAtoms
                || registration.packageNonce != spotRegistration.packageNonce || registration.spotMinQuoteAtoms == 0
                || registration.exitOrderHash == bytes32(0) || registration.exitQuoteHash == bytes32(0)
                || registration.exitRouteHash == bytes32(0) || registration.exitFillCommitment == bytes32(0)
                || registration.exitFillCommitment == spotRegistration.entryFillCommitment
                || registration.exitFillCommitment == spotRegistration.rollbackFillCommitment
                || registration.collateralToken != address(collateralToken) || registration.isLong
                || registration.fullCloseSizeUsd == 0 || registration.fullCloseSizeUsd != positionSize(false)
                || positionSize(true) != 0 || registration.acceptablePrice == 0
                || registration.executionFeeWei != msg.value || registration.callbackGasLimit == 0
        ) revert InvalidRequest();
        _sendExecutionFee(registration.executionFeeWei);
        requestKey = IGmxV2ExchangeRouter(exchangeRouter).createOrder(_decreaseParams(registration));
        if (requestKey == bytes32(0)) revert InvalidRequest();
    }

    function cancelExit(bytes32 requestKey) external nonReentrant {
        _assertExitController();
        if (requestKey == bytes32(0)) revert InvalidRequest();
        IGmxV2ExchangeRouter(exchangeRouter).cancelOrder(requestKey);
    }

    function cancelEntry(bytes32 requestKey) external nonReentrant {
        _assertEntryController();
        if (requestKey == bytes32(0)) revert InvalidRequest();
        IGmxV2ExchangeRouter(exchangeRouter).cancelOrder(requestKey);
    }

    function positionSize(bool isLong) public view returns (uint256) {
        bytes32 positionKey = keccak256(abi.encode(address(this), market, address(collateralToken), isLong));
        return IGmxV2DataStore(dataStore).getUint(keccak256(abi.encode(positionKey, SIZE_IN_USD)));
    }

    function assertDeployment() external view {
        _assertDeployment();
    }

    function _validateSpotRequest(
        bytes32 packageId,
        bytes32 requestPayloadHash,
        IAsyncVenueAdapter.VenueRequest calldata venueRequest
    ) private view {
        IAsyncVenueAdapter.SpotEntry calldata spotEntry = venueRequest.spot;
        if (
            packageId == bytes32(0) || requestPayloadHash == bytes32(0) || spotEntry.fundingOwner != owner
                || spotEntry.port != address(spotPort) || venueRequest.marketId != bytes32(uint256(uint160(market)))
                || venueRequest.collateralToken != address(collateralToken) || venueRequest.sizeDelta >= 0
                || venueRequest.sizeDelta == type(int256).min || venueRequest.collateralAtoms == 0
                || venueRequest.acceptablePrice == 0 || venueRequest.executionFeeWei == 0
                || venueRequest.callbackGasLimit == 0 || spotEntry.portCodeHash != spotPortCodeHash
                || spotEntry.baseToken != address(spotBaseToken) || spotEntry.quoteToken != address(collateralToken)
                || venueRequest.orderHash == bytes32(0) || venueRequest.quoteHash == bytes32(0)
                || venueRequest.routeHash == bytes32(0) || spotEntry.entryFillCommitment == bytes32(0)
                || spotEntry.rollbackFillCommitment == bytes32(0) || spotEntry.baseAtoms == 0
                || spotEntry.maxQuoteAtoms == 0 || spotEntry.rollbackMinQuoteAtoms == 0
        ) revert InvalidRequest();
    }

    function _entryRegistration(
        bytes32 packageId,
        bytes32 requestPayloadHash,
        IAsyncVenueAdapter.VenueRequest calldata venueRequest
    ) private view returns (GmxV2.RequestRegistration memory registration) {
        registration = GmxV2.RequestRegistration({
            packageId: packageId,
            requestPayloadHash: requestPayloadHash,
            beneficiary: owner,
            refundRecipient: owner,
            market: market,
            collateralToken: address(collateralToken),
            sizeDeltaUsd: uint256(-venueRequest.sizeDelta),
            isLong: false,
            collateralAtoms: venueRequest.collateralAtoms,
            acceptablePrice: venueRequest.acceptablePrice,
            executionFeeWei: venueRequest.executionFeeWei,
            callbackGasLimit: venueRequest.callbackGasLimit,
            submissionDeadline: venueRequest.submissionDeadline,
            venueDeadline: venueRequest.venueDeadline,
            recoveryDeadline: venueRequest.recoveryDeadline
        });
    }

    function _armSpotFill(
        uint8 action,
        uint256 packageNonce,
        bytes32 fillCommitment,
        bytes32 orderHash,
        bytes32 quoteHash,
        bytes32 routeHash,
        uint256 baseAtoms,
        uint256 quoteBound
    ) private {
        if (_spotFillContext.action != 0 || _recordedSpotQuoteAtoms != 0) revert InvalidRequest();
        _spotFillContext = SpotFillContext({
            action: action,
            packageNonce: packageNonce,
            fillCommitment: fillCommitment,
            orderHash: orderHash,
            quoteHash: quoteHash,
            routeHash: routeHash,
            baseAtoms: baseAtoms,
            quoteBound: quoteBound
        });
    }

    function _sellSpot(SpotSale memory sale) private returns (uint256 quoteOut) {
        _armSpotFill(
            2,
            sale.packageNonce,
            sale.fillCommitment,
            sale.orderHash,
            sale.quoteHash,
            sale.routeHash,
            sale.baseAtoms,
            sale.minQuoteAtoms
        );
        spotBaseToken.forceApprove(address(spotPort), sale.baseAtoms);
        quoteOut = spotPort.sellExactInput(
            sale.packageNonce,
            sale.fillCommitment,
            sale.orderHash,
            sale.quoteHash,
            sale.routeHash,
            sale.baseAtoms,
            sale.minQuoteAtoms
        );
        spotBaseToken.forceApprove(address(spotPort), 0);
        if (_spotFillContext.action != 0 || quoteOut == 0 || quoteOut != _recordedSpotQuoteAtoms) {
            revert FundingMismatch();
        }
        _recordedSpotQuoteAtoms = 0;
        if (
            spotBaseToken.balanceOf(address(this)) != 0 || collateralToken.balanceOf(address(this)) != quoteOut
                || address(this).balance != 0 || spotBaseToken.allowance(address(this), address(spotPort)) != 0
                || collateralToken.allowance(address(this), address(spotPort)) != 0
        ) revert FundingMismatch();
    }

    /// @dev Clears the active spot inventory, then pays the recipient either the sale proceeds or the base token.
    function _releaseSpot(
        bytes32 packageId,
        bytes32 requestKey,
        address recipient,
        uint256 baseAtoms,
        uint256 quoteAtoms,
        bool inKind
    ) private {
        delete _spotRegistration;
        activeSpotRequestKey = bytes32(0);
        activeSpotQuoteAtoms = 0;
        hasActiveSpotInventory = false;
        if (inKind) {
            _transferExactToken(spotBaseToken, recipient, baseAtoms);
            emit SpotInventoryReturnedInKind(packageId, requestKey, recipient, baseAtoms);
        } else {
            _transferExactToken(collateralToken, recipient, quoteAtoms);
        }
        if (
            spotBaseToken.balanceOf(address(this)) != 0 || collateralToken.balanceOf(address(this)) != 0
                || spotBaseToken.allowance(address(this), address(spotPort)) != 0
                || collateralToken.allowance(address(this), address(spotPort)) != 0
        ) revert FundingMismatch();
    }

    function _sendCollateral(uint256 amount) private {
        uint256 beforeBalance = collateralToken.balanceOf(address(this));
        if (beforeBalance < amount || collateralToken.allowance(address(this), router) != 0) revert FundingMismatch();
        collateralToken.forceApprove(router, amount);
        IGmxV2ExchangeRouter(exchangeRouter).sendTokens(address(collateralToken), orderVault, amount);
        collateralToken.forceApprove(router, 0);
        if (
            beforeBalance - collateralToken.balanceOf(address(this)) != amount
                || collateralToken.allowance(address(this), router) != 0
        ) {
            revert FundingMismatch();
        }
    }

    function _sendExecutionFee(uint256 amount) private {
        uint256 beforeBalance = address(this).balance;
        IGmxV2ExchangeRouter(exchangeRouter).sendWnt{value: amount}(orderVault, amount);
        if (beforeBalance - address(this).balance != amount) revert FundingMismatch();
    }

    function _transferExactToken(IERC20 token, address recipient, uint256 amount) private {
        uint256 beforeBalance = token.balanceOf(recipient);
        token.safeTransfer(recipient, amount);
        if (token.balanceOf(recipient) - beforeBalance != amount) revert FundingMismatch();
    }

    function _increaseParams(GmxV2.RequestRegistration memory registration)
        private
        view
        returns (GmxV2.CreateOrderParams memory params)
    {
        bytes32[] memory dataList = new bytes32[](2);
        dataList[0] = registration.packageId;
        dataList[1] = registration.requestPayloadHash;
        params = _baseParams(
            registration.beneficiary,
            registration.refundRecipient,
            entryController,
            registration.sizeDeltaUsd,
            registration.collateralAtoms,
            registration.acceptablePrice,
            registration.executionFeeWei,
            registration.callbackGasLimit,
            0,
            GmxV2.OrderType.MarketIncrease,
            dataList
        );
    }

    function _decreaseParams(GmxV2.ExitRegistration calldata registration)
        private
        view
        returns (GmxV2.CreateOrderParams memory params)
    {
        bytes32[] memory dataList = new bytes32[](3);
        dataList[0] = registration.packageId;
        dataList[1] = registration.entryRequestKey;
        dataList[2] = registration.authorizationHash;
        params = _baseParams(
            owner,
            registration.executionFeeRefundRecipient,
            exitController,
            registration.fullCloseSizeUsd,
            type(uint256).max,
            registration.acceptablePrice,
            registration.executionFeeWei,
            registration.callbackGasLimit,
            registration.minOutputAmount,
            GmxV2.OrderType.MarketDecrease,
            dataList
        );
    }

    function _baseParams(
        address receiver,
        address cancellationReceiver,
        address callbackContract,
        uint256 sizeDeltaUsd,
        uint256 collateralDeltaAmount,
        uint256 acceptablePrice,
        uint256 executionFee,
        uint256 callbackGasLimit,
        uint256 minOutputAmount,
        GmxV2.OrderType orderType,
        bytes32[] memory dataList
    ) private view returns (GmxV2.CreateOrderParams memory params) {
        params.addresses = GmxV2.CreateOrderParamsAddresses({
            receiver: receiver,
            cancellationReceiver: cancellationReceiver,
            callbackContract: callbackContract,
            uiFeeReceiver: address(0),
            market: market,
            initialCollateralToken: address(collateralToken),
            swapPath: new address[](0)
        });
        params.numbers = GmxV2.CreateOrderParamsNumbers({
            sizeDeltaUsd: sizeDeltaUsd,
            initialCollateralDeltaAmount: collateralDeltaAmount,
            triggerPrice: 0,
            acceptablePrice: acceptablePrice,
            executionFee: executionFee,
            callbackGasLimit: callbackGasLimit,
            minOutputAmount: minOutputAmount,
            validFromTime: 0
        });
        params.orderType = orderType;
        params.decreasePositionSwapType = GmxV2.DecreasePositionSwapType.NoSwap;
        params.isLong = false;
        params.shouldUnwrapNativeToken = false;
        params.autoCancel = false;
        params.referralCode = bytes32(0);
        params.dataList = dataList;
    }

    function _assertExitController() private view {
        _assertDeployment();
        if (
            msg.sender != exitController || msg.sender.codehash != exitControllerCodeHash
                || exitController == address(0)
        ) revert UnauthorizedCaller();
    }

    function _assertEntryController() private view {
        _assertDeployment();
        if (
            msg.sender != entryController || msg.sender.codehash != entryControllerCodeHash
                || entryController == address(0)
        ) revert UnauthorizedCaller();
    }

    function _assertSpotDeployment() private view {
        if (
            address(spotPort) == address(0) || address(spotPort).codehash != spotPortCodeHash
                || address(spotBaseToken).codehash != spotBaseTokenCodeHash || spotPort.verifier() != factory
                || spotPort.verifierCodeHash() != factory.codehash
                || address(spotPort.baseToken()) != address(spotBaseToken)
                || address(spotPort.quoteToken()) != address(collateralToken)
        ) revert DeploymentChanged();
        spotPort.assertDeployment();
    }

    function _assertDeployment() private view {
        if (
            dataStore.codehash != dataStoreCodeHash || eventEmitter.codehash != eventEmitterCodeHash
                || exchangeRouter.codehash != exchangeRouterCodeHash || router.codehash != routerCodeHash
                || orderVault.codehash != orderVaultCodeHash || orderHandler.codehash != orderHandlerCodeHash
                || roleStore.codehash != roleStoreCodeHash
        ) revert DeploymentChanged();
        IGmxV2ExchangeRouter exchange = IGmxV2ExchangeRouter(exchangeRouter);
        if (
            exchange.dataStore() != dataStore || exchange.eventEmitter() != eventEmitter || exchange.router() != router
                || exchange.orderHandler() != orderHandler || exchange.roleStore() != roleStore
        ) revert DeploymentChanged();
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
