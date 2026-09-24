// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/utils/ReentrancyGuard.sol";
import {GmxV2, IGmxV2DataStore, IGmxV2ExchangeRouter} from "./interfaces/IGmxV2.sol";

contract GmxV2IsolatedAccount is ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant SIZE_IN_USD = keccak256(abi.encode("SIZE_IN_USD"));

    error InvalidConfiguration();
    error DeploymentChanged();
    error UnauthorizedCaller();
    error InvalidRequest();
    error FundingMismatch();

    event ExitControllerConfigured(address indexed controller, bytes32 codeHash);

    address public immutable entryController;
    address public immutable owner;
    address public immutable fundingAuthority;
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

    address public exitController;
    bytes32 public exitControllerCodeHash;

    constructor(
        address entryController_,
        address owner_,
        address fundingAuthority_,
        address market_,
        IERC20 collateralToken_,
        GmxV2.Deployment memory deployment
    ) {
        if (
            entryController_ == address(0) || owner_ == address(0) || fundingAuthority_ == address(0)
                || market_ == address(0) || address(collateralToken_) == address(0)
        ) revert InvalidConfiguration();
        _validateDeployment(deployment);
        entryController = entryController_;
        owner = owner_;
        fundingAuthority = fundingAuthority_;
        market = market_;
        collateralToken = collateralToken_;
        dataStore = deployment.dataStore;
        eventEmitter = deployment.eventEmitter;
        exchangeRouter = deployment.exchangeRouter;
        router = deployment.router;
        orderVault = deployment.orderVault;
        orderHandler = deployment.orderHandler;
        roleStore = deployment.roleStore;
        dataStoreCodeHash = deployment.dataStoreCodeHash;
        eventEmitterCodeHash = deployment.eventEmitterCodeHash;
        exchangeRouterCodeHash = deployment.exchangeRouterCodeHash;
        routerCodeHash = deployment.routerCodeHash;
        orderVaultCodeHash = deployment.orderVaultCodeHash;
        orderHandlerCodeHash = deployment.orderHandlerCodeHash;
        roleStoreCodeHash = deployment.roleStoreCodeHash;
        deploymentHash = keccak256(abi.encode(deployment));
    }

    function configureExitController(address controller, bytes32 codeHash) external {
        if (msg.sender != owner) revert UnauthorizedCaller();
        if (
            exitController != address(0) || controller == address(0) || codeHash == bytes32(0)
                || controller.codehash != codeHash
        ) revert InvalidConfiguration();
        exitController = controller;
        exitControllerCodeHash = codeHash;
        emit ExitControllerConfigured(controller, codeHash);
    }

    function createIncrease(GmxV2.RequestRegistration calldata registration)
        external
        payable
        nonReentrant
        returns (bytes32 requestKey)
    {
        _assertDeployment();
        if (msg.sender != entryController) revert UnauthorizedCaller();
        if (
            registration.packageId == bytes32(0) || registration.requestPayloadHash == bytes32(0)
                || registration.beneficiary != owner || registration.refundRecipient != fundingAuthority
                || registration.market != market || registration.collateralToken != address(collateralToken)
                || registration.isLong || registration.sizeDeltaUsd == 0 || registration.collateralAtoms == 0
                || registration.acceptablePrice == 0 || registration.executionFeeWei != msg.value
                || registration.callbackGasLimit == 0
        ) revert InvalidRequest();
        _sendCollateral(registration.collateralAtoms);
        _sendExecutionFee(registration.executionFeeWei);
        requestKey = IGmxV2ExchangeRouter(exchangeRouter).createOrder(_increaseParams(registration));
        if (requestKey == bytes32(0)) revert InvalidRequest();
    }

    function createFullClose(GmxV2.ExitRegistration calldata registration)
        external
        payable
        nonReentrant
        returns (bytes32 requestKey)
    {
        _assertExitController();
        if (
            registration.packageId == bytes32(0) || registration.entryRequestKey == bytes32(0)
                || registration.authorizationHash == bytes32(0) || registration.account != address(this)
                || registration.owner != owner || registration.receiver != owner || registration.market != market
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
        _assertDeployment();
        if (msg.sender != entryController) revert UnauthorizedCaller();
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

    function _increaseParams(GmxV2.RequestRegistration calldata registration)
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
