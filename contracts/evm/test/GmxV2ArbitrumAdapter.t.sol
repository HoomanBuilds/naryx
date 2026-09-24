// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {AsyncBondedPackageCoordinator} from "../src/AsyncBondedPackageCoordinator.sol";
import {GmxV2ArbitrumAdapter} from "../src/GmxV2ArbitrumAdapter.sol";
import {GmxV2OrderVerifier} from "../src/GmxV2OrderVerifier.sol";
import {GmxV2ExitController} from "../src/GmxV2ExitController.sol";
import {GmxV2ExitOrderVerifier} from "../src/GmxV2ExitOrderVerifier.sol";
import {GmxV2IsolatedAccount} from "../src/GmxV2IsolatedAccount.sol";
import {UniswapV3SpotPort} from "../src/UniswapV3SpotPort.sol";
import {IAsyncVenueAdapter} from "../src/interfaces/IAsyncVenueAdapter.sol";
import {GmxV2, IGmxV2ExchangeRouter, IGmxV2OrderCallbackReceiver} from "../src/interfaces/IGmxV2.sol";

contract GmxTestToken is ERC20 {
    constructor() ERC20("Collateral", "COL") {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

contract GmxTestCode {}

contract GmxSpotFactory {
    address public tokenA;
    address public tokenB;
    uint24 public poolFee;
    address public pool;

    function setPool(address tokenA_, address tokenB_, uint24 poolFee_, address pool_) external {
        tokenA = tokenA_;
        tokenB = tokenB_;
        poolFee = poolFee_;
        pool = pool_;
    }

    function getPool(address tokenA_, address tokenB_, uint24 poolFee_) external view returns (address) {
        bool matches = (tokenA_ == tokenA && tokenB_ == tokenB) || (tokenA_ == tokenB && tokenB_ == tokenA);
        return matches && poolFee_ == poolFee ? pool : address(0);
    }
}

contract GmxSpotPool {
    address public immutable factory;
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;

    constructor(address factory_, address token0_, address token1_, uint24 fee_) {
        factory = factory_;
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        if (zeroForOne) {
            require(amountSpecified > 0);
            amount0 = amountSpecified;
            amount1 = -2 * amountSpecified;
            require(IERC20(token1).transfer(recipient, uint256(-amount1)));
        } else {
            require(amountSpecified < 0);
            amount0 = amountSpecified;
            amount1 = -2 * amountSpecified;
            require(IERC20(token0).transfer(recipient, uint256(-amount0)));
        }
        UniswapV3SpotPort(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
    }
}

contract GmxTestOrderVault {
    function refund(IERC20 token, address recipient, uint256 amount) external {
        require(token.transfer(recipient, amount));
    }
}

contract GmxTestDataStore {
    mapping(bytes32 setKey => mapping(bytes32 value => bool)) private _contains;
    mapping(bytes32 key => uint256 value) private _uints;

    function containsBytes32(bytes32 setKey, bytes32 value) external view returns (bool) {
        return _contains[setKey][value];
    }

    function getUint(bytes32 key) external view returns (uint256) {
        return _uints[key];
    }

    function setContains(bytes32 setKey, bytes32 value, bool exists) external {
        _contains[setKey][value] = exists;
    }

    function setUint(bytes32 key, uint256 value) external {
        _uints[key] = value;
    }
}

contract GmxTestRoleStore {
    mapping(address account => mapping(bytes32 role => bool)) private _roles;

    function hasRole(address account, bytes32 role) external view returns (bool) {
        return _roles[account][role];
    }

    function setRole(address account, bytes32 role, bool active) external {
        _roles[account][role] = active;
    }
}

contract GmxTestRouter {
    function pull(address token, address account, address receiver, uint256 amount) external {
        require(IERC20(token).transferFrom(account, receiver, amount));
    }
}

contract GmxTestOrderHandler {
    function executeOrder(IGmxV2OrderCallbackReceiver callback, bytes32 key, GmxV2.EventLogData calldata orderData)
        external
    {
        GmxV2.EventLogData memory eventData;
        callback.afterOrderExecution(key, orderData, eventData);
    }

    function cancelOrder(IGmxV2OrderCallbackReceiver callback, bytes32 key, GmxV2.EventLogData calldata orderData)
        external
    {
        GmxV2.EventLogData memory eventData;
        callback.afterOrderCancellation(key, orderData, eventData);
    }

    function freezeOrder(IGmxV2OrderCallbackReceiver callback, bytes32 key, GmxV2.EventLogData calldata orderData)
        external
    {
        GmxV2.EventLogData memory eventData;
        callback.afterOrderFrozen(key, orderData, eventData);
    }
}

contract GmxTestExchangeRouter {
    bytes32 private constant ORDER_LIST = keccak256(abi.encode("ORDER_LIST"));

    address public immutable dataStore;
    address public immutable eventEmitter;
    address public immutable router;
    address public immutable orderHandler;
    address public immutable roleStore;
    address public immutable orderVault;

    address public lastAccount;
    address public receiver;
    address public cancellationReceiver;
    address public callbackContract;
    address public uiFeeReceiver;
    address public market;
    address public initialCollateralToken;
    uint256 public sizeDeltaUsd;
    uint256 public initialCollateralDeltaAmount;
    uint256 public triggerPrice;
    uint256 public acceptablePrice;
    uint256 public executionFee;
    uint256 public callbackGasLimit;
    uint256 public minOutputAmount;
    uint256 public validFromTime;
    GmxV2.OrderType public orderType;
    GmxV2.DecreasePositionSwapType public decreasePositionSwapType;
    bool public isLong;
    bool public shouldUnwrapNativeToken;
    bool public autoCancel;
    bytes32 public referralCode;
    uint256 public receivedWnt;
    uint256 public nonce;
    bool public failCreate;
    address[] private _swapPath;
    bytes32[] private _dataList;

    constructor(
        address dataStore_,
        address eventEmitter_,
        address router_,
        address orderHandler_,
        address roleStore_,
        address orderVault_
    ) {
        dataStore = dataStore_;
        eventEmitter = eventEmitter_;
        router = router_;
        orderHandler = orderHandler_;
        roleStore = roleStore_;
        orderVault = orderVault_;
    }

    function setFailCreate(bool fail) external {
        failCreate = fail;
    }

    function dataList(uint256 index) external view returns (bytes32) {
        return _dataList[index];
    }

    function swapPathLength() external view returns (uint256) {
        return _swapPath.length;
    }

    function sendTokens(address token, address receiver_, uint256 amount) external payable {
        GmxTestRouter(router).pull(token, msg.sender, receiver_, amount);
    }

    function sendWnt(address receiver_, uint256 amount) external payable {
        require(receiver_ == orderVault && msg.value == amount);
        receivedWnt += amount;
    }

    function createOrder(GmxV2.CreateOrderParams calldata params) external payable returns (bytes32 key) {
        if (failCreate) revert("CREATE_FAILED");
        lastAccount = msg.sender;
        receiver = params.addresses.receiver;
        cancellationReceiver = params.addresses.cancellationReceiver;
        callbackContract = params.addresses.callbackContract;
        uiFeeReceiver = params.addresses.uiFeeReceiver;
        market = params.addresses.market;
        initialCollateralToken = params.addresses.initialCollateralToken;
        delete _swapPath;
        for (uint256 i; i < params.addresses.swapPath.length; i++) {
            _swapPath.push(params.addresses.swapPath[i]);
        }
        sizeDeltaUsd = params.numbers.sizeDeltaUsd;
        initialCollateralDeltaAmount = params.numbers.initialCollateralDeltaAmount;
        triggerPrice = params.numbers.triggerPrice;
        acceptablePrice = params.numbers.acceptablePrice;
        executionFee = params.numbers.executionFee;
        callbackGasLimit = params.numbers.callbackGasLimit;
        minOutputAmount = params.numbers.minOutputAmount;
        validFromTime = params.numbers.validFromTime;
        orderType = params.orderType;
        decreasePositionSwapType = params.decreasePositionSwapType;
        isLong = params.isLong;
        shouldUnwrapNativeToken = params.shouldUnwrapNativeToken;
        autoCancel = params.autoCancel;
        referralCode = params.referralCode;
        delete _dataList;
        for (uint256 i; i < params.dataList.length; i++) {
            _dataList.push(params.dataList[i]);
        }
        key = keccak256(abi.encode(msg.sender, ++nonce));
        GmxTestDataStore(dataStore).setContains(ORDER_LIST, key, true);
    }

    function cancelOrder(bytes32 key) external payable {
        require(msg.sender == lastAccount);
        require(GmxTestDataStore(dataStore).containsBytes32(ORDER_LIST, key));
        GmxTestDataStore(dataStore).setContains(ORDER_LIST, key, false);
        if (orderType == GmxV2.OrderType.MarketIncrease) {
            GmxTestOrderVault(orderVault)
                .refund(IERC20(initialCollateralToken), cancellationReceiver, initialCollateralDeltaAmount);
        }
        GmxTestOrderHandler(orderHandler).cancelOrder(IGmxV2OrderCallbackReceiver(callbackContract), key, orderData());
    }

    function executeOrder(bytes32 key, uint256 resultingSize) external {
        GmxTestDataStore(dataStore).setContains(ORDER_LIST, key, false);
        bytes32 positionKey = keccak256(abi.encode(lastAccount, market, initialCollateralToken, isLong));
        bytes32 sizeKey = keccak256(abi.encode(positionKey, keccak256(abi.encode("SIZE_IN_USD"))));
        GmxTestDataStore(dataStore).setUint(sizeKey, resultingSize);
        GmxTestOrderHandler(orderHandler).executeOrder(IGmxV2OrderCallbackReceiver(callbackContract), key, orderData());
    }

    function executeDecreaseOrder(bytes32 key, uint256 resultingSize, uint256 outputAmount) external {
        require(orderType == GmxV2.OrderType.MarketDecrease);
        GmxTestDataStore(dataStore).setContains(ORDER_LIST, key, false);
        bytes32 positionKey = keccak256(abi.encode(lastAccount, market, initialCollateralToken, isLong));
        bytes32 sizeKey = keccak256(abi.encode(positionKey, keccak256(abi.encode("SIZE_IN_USD"))));
        GmxTestDataStore(dataStore).setUint(sizeKey, resultingSize);
        if (outputAmount != 0) {
            GmxTestOrderVault(orderVault).refund(IERC20(initialCollateralToken), receiver, outputAmount);
        }
        GmxTestOrderHandler(orderHandler).executeOrder(IGmxV2OrderCallbackReceiver(callbackContract), key, orderData());
    }

    function orderData() public view returns (GmxV2.EventLogData memory data) {
        data.addressItems.items = new GmxV2.AddressKeyValue[](7);
        data.addressItems.items[0] = GmxV2.AddressKeyValue("account", lastAccount);
        data.addressItems.items[1] = GmxV2.AddressKeyValue("receiver", receiver);
        data.addressItems.items[2] = GmxV2.AddressKeyValue("callbackContract", callbackContract);
        data.addressItems.items[3] = GmxV2.AddressKeyValue("uiFeeReceiver", uiFeeReceiver);
        data.addressItems.items[4] = GmxV2.AddressKeyValue("market", market);
        data.addressItems.items[5] = GmxV2.AddressKeyValue("initialCollateralToken", initialCollateralToken);
        data.addressItems.items[6] = GmxV2.AddressKeyValue("cancellationReceiver", cancellationReceiver);
        data.addressItems.arrayItems = new GmxV2.AddressArrayKeyValue[](1);
        address[] memory swapPath = new address[](_swapPath.length);
        for (uint256 i; i < _swapPath.length; i++) {
            swapPath[i] = _swapPath[i];
        }
        data.addressItems.arrayItems[0] = GmxV2.AddressArrayKeyValue("swapPath", swapPath);

        data.uintItems.items = new GmxV2.UintKeyValue[](12);
        data.uintItems.items[0] = GmxV2.UintKeyValue("orderType", uint256(orderType));
        data.uintItems.items[1] = GmxV2.UintKeyValue("decreasePositionSwapType", uint256(decreasePositionSwapType));
        data.uintItems.items[2] = GmxV2.UintKeyValue("sizeDeltaUsd", sizeDeltaUsd);
        data.uintItems.items[3] = GmxV2.UintKeyValue("initialCollateralDeltaAmount", initialCollateralDeltaAmount);
        data.uintItems.items[4] = GmxV2.UintKeyValue("triggerPrice", triggerPrice);
        data.uintItems.items[5] = GmxV2.UintKeyValue("acceptablePrice", acceptablePrice);
        data.uintItems.items[6] = GmxV2.UintKeyValue("executionFee", executionFee);
        data.uintItems.items[7] = GmxV2.UintKeyValue("callbackGasLimit", callbackGasLimit);
        data.uintItems.items[8] = GmxV2.UintKeyValue("minOutputAmount", minOutputAmount);
        data.uintItems.items[9] = GmxV2.UintKeyValue("updatedAtTime", block.timestamp);
        data.uintItems.items[10] = GmxV2.UintKeyValue("validFromTime", validFromTime);
        data.uintItems.items[11] = GmxV2.UintKeyValue("srcChainId", 0);

        data.boolItems.items = new GmxV2.BoolKeyValue[](3);
        data.boolItems.items[0] = GmxV2.BoolKeyValue("isLong", isLong);
        data.boolItems.items[1] = GmxV2.BoolKeyValue("shouldUnwrapNativeToken", shouldUnwrapNativeToken);
        data.boolItems.items[2] = GmxV2.BoolKeyValue("autoCancel", autoCancel);

        data.bytes32Items.arrayItems = new GmxV2.Bytes32ArrayKeyValue[](1);
        bytes32[] memory list = new bytes32[](_dataList.length);
        for (uint256 i; i < _dataList.length; i++) {
            list[i] = _dataList[i];
        }
        data.bytes32Items.arrayItems[0] = GmxV2.Bytes32ArrayKeyValue("dataList", list);
    }
}

contract GmxV2ArbitrumAdapterTest is Test {
    bytes32 private constant PACKAGE_ID = keccak256("package");
    bytes32 private constant CONTROLLER_ROLE = keccak256(abi.encode("CONTROLLER"));
    uint256 private constant COLLATERAL = 5_000_000;
    uint256 private constant SIZE = 4_000e30;
    uint256 private constant ACCEPTABLE_PRICE = 2_500e30;
    uint256 private constant EXECUTION_FEE = 0.002 ether;
    uint256 private constant CALLBACK_GAS = 2_000_000;
    uint256 private constant SPOT_BASE = 1_000_000;
    uint256 private constant MAX_SPOT_QUOTE = 3_000_000;
    uint256 private constant MIN_ROLLBACK_QUOTE = 1_000_000;
    uint24 private constant POOL_FEE = 3000;

    GmxTestToken private token;
    GmxTestToken private baseToken;
    GmxSpotFactory private spotFactory;
    GmxSpotPool private spotPool;
    UniswapV3SpotPort private spotPort;
    GmxTestDataStore private dataStore;
    GmxTestRoleStore private roleStore;
    GmxTestRouter private router;
    GmxTestOrderHandler private orderHandler;
    GmxTestExchangeRouter private exchangeRouter;
    GmxTestCode private eventEmitter;
    GmxTestOrderVault private orderVault;
    GmxTestCode private market;
    GmxV2OrderVerifier private orderVerifier;
    AsyncBondedPackageCoordinator private coordinator;
    GmxV2IsolatedAccount private account;
    GmxV2ArbitrumAdapter private adapter;
    GmxV2.Deployment private deployment;

    receive() external payable {}

    function setUp() public {
        vm.warp(10_000);
        vm.deal(address(this), 10 ether);
        token = new GmxTestToken();
        dataStore = new GmxTestDataStore();
        roleStore = new GmxTestRoleStore();
        router = new GmxTestRouter();
        orderHandler = new GmxTestOrderHandler();
        eventEmitter = new GmxTestCode();
        orderVault = new GmxTestOrderVault();
        market = new GmxTestCode();
        orderVerifier = new GmxV2OrderVerifier();
        exchangeRouter = new GmxTestExchangeRouter(
            address(dataStore),
            address(eventEmitter),
            address(router),
            address(orderHandler),
            address(roleStore),
            address(orderVault)
        );
        roleStore.setRole(address(orderHandler), CONTROLLER_ROLE, true);

        ProtocolConfig config = new ProtocolConfig(
            "eip155:421614", 1, keccak256("manifest"), 1, address(1), address(2), address(3), address(4)
        );
        coordinator = new AsyncBondedPackageCoordinator(config, token, keccak256("execution-class"));

        deployment = GmxV2.Deployment({
            dataStore: address(dataStore),
            eventEmitter: address(eventEmitter),
            exchangeRouter: address(exchangeRouter),
            router: address(router),
            orderVault: address(orderVault),
            orderHandler: address(orderHandler),
            roleStore: address(roleStore),
            dataStoreCodeHash: address(dataStore).codehash,
            eventEmitterCodeHash: address(eventEmitter).codehash,
            exchangeRouterCodeHash: address(exchangeRouter).codehash,
            routerCodeHash: address(router).codehash,
            orderVaultCodeHash: address(orderVault).codehash,
            orderHandlerCodeHash: address(orderHandler).codehash,
            roleStoreCodeHash: address(roleStore).codehash
        });

        account = new GmxV2IsolatedAccount(address(0xBEEF), address(this), address(market), token, deployment);
        adapter = new GmxV2ArbitrumAdapter(
            coordinator,
            address(coordinator).codehash,
            address(this),
            address(0xBEEF),
            address(market),
            address(market).codehash,
            token,
            address(token).codehash,
            account,
            orderVerifier,
            address(orderVerifier).codehash,
            deployment
        );
        vm.prank(address(0xBEEF));
        account.configureEntryController(address(adapter), address(adapter).codehash);
        baseToken = new GmxTestToken();
        spotFactory = new GmxSpotFactory();
        spotPool = new GmxSpotPool(address(spotFactory), address(baseToken), address(token), POOL_FEE);
        spotFactory.setPool(address(baseToken), address(token), POOL_FEE, address(spotPool));
        spotPort = new UniswapV3SpotPort(
            address(account),
            UniswapV3SpotPort.Deployment({
                chainId: block.chainid,
                factory: address(spotFactory),
                pool: address(spotPool),
                baseToken: baseToken,
                quoteToken: token,
                baseTokenDecimals: 18,
                quoteTokenDecimals: 18,
                poolFee: POOL_FEE,
                factoryCodeHash: address(spotFactory).codehash,
                poolCodeHash: address(spotPool).codehash,
                baseTokenCodeHash: address(baseToken).codehash,
                quoteTokenCodeHash: address(token).codehash
            })
        );
        vm.prank(address(0xBEEF));
        account.configureSpotPort(spotPort, address(spotPort).codehash);
        baseToken.mint(address(spotPool), SPOT_BASE * 100);
        token.mint(address(spotPool), MAX_SPOT_QUOTE * 100);
        token.mint(address(this), (COLLATERAL + MAX_SPOT_QUOTE) * 10);
        token.approve(address(adapter), type(uint256).max);
        _mockPackage(_request(), address(0xBEEF));
    }

    function testCreatesExactlyBoundRequestAndCleansApproval() public {
        IAsyncVenueAdapter.VenueRequest memory request = _request();
        bytes32 requestHash = keccak256(abi.encode(request));
        bytes32 key = _fundAndCreate(request);

        assertEq(token.balanceOf(address(orderVault)), COLLATERAL);
        assertEq(token.allowance(address(adapter), address(router)), 0);
        assertEq(exchangeRouter.receivedWnt(), EXECUTION_FEE);
        assertEq(exchangeRouter.lastAccount(), address(adapter.isolatedAccount()));
        assertEq(exchangeRouter.receiver(), address(0xBEEF));
        assertEq(exchangeRouter.cancellationReceiver(), address(this));
        assertEq(exchangeRouter.callbackContract(), address(adapter));
        assertEq(exchangeRouter.market(), address(market));
        assertEq(exchangeRouter.initialCollateralToken(), address(token));
        assertEq(exchangeRouter.sizeDeltaUsd(), SIZE);
        assertEq(exchangeRouter.initialCollateralDeltaAmount(), COLLATERAL);
        assertEq(exchangeRouter.acceptablePrice(), ACCEPTABLE_PRICE);
        assertEq(exchangeRouter.executionFee(), EXECUTION_FEE);
        assertEq(exchangeRouter.callbackGasLimit(), CALLBACK_GAS);
        assertEq(uint8(exchangeRouter.orderType()), uint8(GmxV2.OrderType.MarketIncrease));
        assertFalse(exchangeRouter.isLong());
        assertEq(exchangeRouter.swapPathLength(), 0);
        assertEq(exchangeRouter.dataList(0), PACKAGE_ID);
        assertEq(exchangeRouter.dataList(1), requestHash);
        assertEq(baseToken.balanceOf(address(account)), SPOT_BASE);
        assertEq(token.balanceOf(address(account)), 0);
        assertTrue(account.hasActiveSpotInventory());
        GmxV2.SpotEntryRegistration memory spotRegistration = account.activeSpotRegistration();
        assertEq(spotRegistration.fundingOwner, address(this));
        assertEq(spotRegistration.orderHash, request.orderHash);
        assertEq(spotRegistration.quoteHash, request.quoteHash);
        assertEq(spotRegistration.routeHash, request.routeHash);
        assertEq(spotRegistration.packageNonce, request.packageNonce);

        assertNotEq(adapter.requestRegistrationHash(key), bytes32(0));
        assertEq(uint8(_status(key)), uint8(GmxV2ArbitrumAdapter.Status.PENDING));
    }

    function testOfficialInterfaceSelectors() public pure {
        assertEq(IGmxV2ExchangeRouter.createOrder.selector, bytes4(0xf59c48eb));
        assertEq(IGmxV2OrderCallbackReceiver.afterOrderExecution.selector, bytes4(0xffaf393f));
        assertEq(IGmxV2OrderCallbackReceiver.afterOrderCancellation.selector, bytes4(0xd8bbbe42));
        assertEq(IGmxV2OrderCallbackReceiver.afterOrderFrozen.selector, bytes4(0x83fc34cf));
    }

    function testAuthenticatesCallbackAndRecordsExactExecution() public {
        bytes32 key = _fundAndCreate(_request());
        GmxV2.EventLogData memory orderData = exchangeRouter.orderData();
        GmxV2.EventLogData memory eventData;
        vm.expectRevert(GmxV2ArbitrumAdapter.UnauthorizedCaller.selector);
        adapter.afterOrderExecution(key, orderData, eventData);

        exchangeRouter.executeOrder(key, SIZE);
        assertEq(uint8(_status(key)), uint8(GmxV2ArbitrumAdapter.Status.EXECUTED));
        (GmxV2ArbitrumAdapter.Status status, bytes32 evidenceHash,, uint256 positionSizeAfter,) =
            adapter.requestEvidence(key);
        assertEq(uint8(status), uint8(GmxV2ArbitrumAdapter.Status.EXECUTED));
        assertEq(positionSizeAfter, SIZE);
        assertNotEq(evidenceHash, bytes32(0));
        vm.expectRevert(GmxV2ArbitrumAdapter.InvalidOutcome.selector);
        adapter.finalizeUnfilledRequest(key);
    }

    function testRejectsCoordinatorPackageBindingMismatch() public {
        IAsyncVenueAdapter.VenueRequest memory request = _request();
        _mockPackage(request, address(0xBAD));
        adapter.fundRequest{value: EXECUTION_FEE}(PACKAGE_ID, request);
        vm.prank(address(coordinator));
        vm.expectRevert(GmxV2ArbitrumAdapter.InvalidRequest.selector);
        adapter.createRequest(PACKAGE_ID, request);
        assertEq(token.balanceOf(address(adapter)), COLLATERAL + MAX_SPOT_QUOTE);
        assertEq(token.balanceOf(address(orderVault)), 0);
    }

    function testRejectsLongEntry() public {
        IAsyncVenueAdapter.VenueRequest memory request = _request();
        request.sizeDelta = int256(SIZE);
        vm.expectRevert(GmxV2ArbitrumAdapter.InvalidRequest.selector);
        adapter.fundRequest{value: EXECUTION_FEE}(PACKAGE_ID, request);
    }

    function testRejectsVenueDeadlineBeforeConfiguredCancellationDelay() public {
        dataStore.setUint(adapter.REQUEST_EXPIRATION_TIME(), 201);
        vm.expectRevert(GmxV2ArbitrumAdapter.InvalidRequest.selector);
        adapter.fundRequest{value: EXECUTION_FEE}(PACKAGE_ID, _request());
    }

    function testRequiresBondAndCollateralTokenEquality() public {
        GmxTestToken otherToken = new GmxTestToken();
        vm.expectRevert(GmxV2ArbitrumAdapter.InvalidConfiguration.selector);
        new GmxV2ArbitrumAdapter(
            coordinator,
            address(coordinator).codehash,
            address(this),
            address(0xBEEF),
            address(market),
            address(market).codehash,
            otherToken,
            address(otherToken).codehash,
            account,
            orderVerifier,
            address(orderVerifier).codehash,
            deployment
        );
    }

    function testRecordsCancelledAndFrozenOutcomes() public {
        bytes32 key = _fundAndCreate(_request());
        dataStore.setContains(adapter.ORDER_LIST(), key, false);
        orderHandler.cancelOrder(adapter, key, exchangeRouter.orderData());
        assertEq(uint8(_status(key)), uint8(GmxV2ArbitrumAdapter.Status.CANCELLED));
    }

    function testCancellationWithUnexpectedPositionFailsClosed() public {
        bytes32 key = _fundAndCreate(_request());
        dataStore.setContains(adapter.ORDER_LIST(), key, false);
        bytes32 positionKey =
            keccak256(abi.encode(address(adapter.isolatedAccount()), address(market), address(token), false));
        bytes32 sizeKey = keccak256(abi.encode(positionKey, adapter.SIZE_IN_USD()));
        dataStore.setUint(sizeKey, SIZE);
        orderHandler.cancelOrder(adapter, key, exchangeRouter.orderData());
        assertEq(uint8(_status(key)), uint8(GmxV2ArbitrumAdapter.Status.CONFLICT));
    }

    function testRecordsFrozenOutcome() public {
        bytes32 key = _fundAndCreate(_request());
        orderHandler.freezeOrder(adapter, key, exchangeRouter.orderData());
        assertEq(uint8(_status(key)), uint8(GmxV2ArbitrumAdapter.Status.FROZEN));
    }

    function testDuplicateCallbackIsIdempotentAndConflictFailsClosed() public {
        bytes32 key = _fundAndCreate(_request());
        exchangeRouter.executeOrder(key, SIZE);
        uint64 revision = _revision(key);
        orderHandler.executeOrder(adapter, key, exchangeRouter.orderData());
        assertEq(_revision(key), revision);
        orderHandler.freezeOrder(adapter, key, exchangeRouter.orderData());
        assertEq(uint8(_status(key)), uint8(GmxV2ArbitrumAdapter.Status.CONFLICT));
    }

    function testPinsDeploymentCodeIdentity() public {
        GmxV2.Deployment memory invalid = deployment;
        invalid.dataStoreCodeHash = bytes32(uint256(1));
        vm.expectRevert(GmxV2ArbitrumAdapter.InvalidConfiguration.selector);
        new GmxV2ArbitrumAdapter(
            coordinator,
            address(coordinator).codehash,
            address(this),
            address(0xBEEF),
            address(market),
            address(market).codehash,
            token,
            address(token).codehash,
            account,
            orderVerifier,
            address(orderVerifier).codehash,
            invalid
        );

        bytes32 key = _fundAndCreate(_request());
        vm.etch(address(orderHandler), hex"00");
        GmxV2.EventLogData memory orderData = exchangeRouter.orderData();
        GmxV2.EventLogData memory eventData;
        vm.expectRevert(GmxV2ArbitrumAdapter.DeploymentChanged.selector);
        adapter.afterOrderExecution(key, orderData, eventData);
    }

    function testRecoveryCancelsAndRecordsRecoveredOutcome() public {
        IAsyncVenueAdapter.VenueRequest memory request = _request();
        bytes32 key = _fundAndCreate(request);
        vm.warp(request.venueDeadline + 1);
        vm.prank(address(coordinator));
        bool accepted = adapter.requestRecovery(PACKAGE_ID, key, IAsyncVenueAdapter.RecoveryAction.CANCEL_OR_RECONCILE);
        assertTrue(accepted);
        assertEq(uint8(_status(key)), uint8(GmxV2ArbitrumAdapter.Status.RECOVERED));
        assertFalse(dataStore.containsBytes32(adapter.ORDER_LIST(), key));
        assertEq(token.balanceOf(address(0xBEEF)), 0);
        assertEq(token.balanceOf(address(this)), (COLLATERAL + MAX_SPOT_QUOTE) * 10 - 2 * SPOT_BASE);
        adapter.finalizeUnfilledRequest(key);
        assertEq(token.balanceOf(address(this)), (COLLATERAL + MAX_SPOT_QUOTE) * 10);
        assertEq(adapter.activePackageId(), bytes32(0));
        assertEq(adapter.activeRequestKey(), bytes32(0));
    }

    function testAuthenticatedLateExecutionPreventsSpotRollback() public {
        bytes32 key = _fundAndCreate(_request());
        dataStore.setContains(adapter.ORDER_LIST(), key, false);
        orderHandler.cancelOrder(adapter, key, exchangeRouter.orderData());
        assertEq(uint8(_status(key)), uint8(GmxV2ArbitrumAdapter.Status.CANCELLED));

        exchangeRouter.executeOrder(key, SIZE);
        assertEq(uint8(_status(key)), uint8(GmxV2ArbitrumAdapter.Status.EXECUTED));
        vm.expectRevert(GmxV2ArbitrumAdapter.InvalidOutcome.selector);
        adapter.finalizeUnfilledRequest(key);
        assertEq(baseToken.balanceOf(address(account)), SPOT_BASE);
        assertTrue(account.hasActiveSpotInventory());
    }

    function testSpotPortCodeChangeBlocksRollback() public {
        bytes32 key = _fundAndCreate(_request());
        dataStore.setContains(adapter.ORDER_LIST(), key, false);
        orderHandler.cancelOrder(adapter, key, exchangeRouter.orderData());
        vm.etch(address(spotPort), hex"00");

        vm.expectRevert(GmxV2IsolatedAccount.DeploymentChanged.selector);
        adapter.finalizeUnfilledRequest(key);
        assertTrue(account.hasActiveSpotInventory());
    }

    function testUnexpectedSpotResidueBlocksRecoveryCompletion() public {
        bytes32 key = _fundAndCreate(_request());
        dataStore.setContains(adapter.ORDER_LIST(), key, false);
        orderHandler.cancelOrder(adapter, key, exchangeRouter.orderData());
        baseToken.mint(address(account), 1);

        vm.expectRevert(GmxV2IsolatedAccount.InvalidRequest.selector);
        adapter.finalizeUnfilledRequest(key);
        assertTrue(account.hasActiveSpotInventory());
        assertEq(adapter.activePackageId(), PACKAGE_ID);
    }

    function testCreateFailureRollsBackCustodyAndFundingState() public {
        IAsyncVenueAdapter.VenueRequest memory request = _request();
        adapter.fundRequest{value: EXECUTION_FEE}(PACKAGE_ID, request);
        uint256 poolBaseBefore = baseToken.balanceOf(address(spotPool));
        uint256 poolQuoteBefore = token.balanceOf(address(spotPool));
        exchangeRouter.setFailCreate(true);
        vm.prank(address(coordinator));
        vm.expectRevert(bytes("CREATE_FAILED"));
        adapter.createRequest(PACKAGE_ID, request);

        assertEq(token.balanceOf(address(adapter)), COLLATERAL + MAX_SPOT_QUOTE);
        assertEq(address(adapter).balance, EXECUTION_FEE);
        assertEq(token.balanceOf(address(orderVault)), 0);
        assertEq(token.allowance(address(adapter), address(router)), 0);
        assertEq(baseToken.balanceOf(address(account)), 0);
        assertEq(token.balanceOf(address(account)), 0);
        assertEq(baseToken.balanceOf(address(spotPool)), poolBaseBefore);
        assertEq(token.balanceOf(address(spotPool)), poolQuoteBefore);
        assertFalse(account.hasActiveSpotInventory());
        (,,,,, bool consumed) = adapter.funding(PACKAGE_ID);
        assertFalse(consumed);
    }

    function _fundAndCreate(IAsyncVenueAdapter.VenueRequest memory request) private returns (bytes32 key) {
        adapter.fundRequest{value: EXECUTION_FEE}(PACKAGE_ID, request);
        vm.prank(address(coordinator));
        key = adapter.createRequest(PACKAGE_ID, request);
        assertNotEq(key, bytes32(0));
    }

    function _request() private view returns (IAsyncVenueAdapter.VenueRequest memory) {
        return IAsyncVenueAdapter.VenueRequest({
            marketId: bytes32(uint256(uint160(address(market)))),
            collateralToken: address(token),
            sizeDelta: -int256(SIZE),
            collateralAtoms: COLLATERAL,
            acceptablePrice: ACCEPTABLE_PRICE,
            executionFeeWei: EXECUTION_FEE,
            callbackGasLimit: CALLBACK_GAS,
            packageNonce: 7,
            orderHash: keccak256("order"),
            quoteHash: keccak256("quote"),
            routeHash: keccak256("route"),
            spot: IAsyncVenueAdapter.SpotEntry({
                fundingOwner: address(this),
                port: address(spotPort),
                portCodeHash: address(spotPort).codehash,
                baseToken: address(baseToken),
                quoteToken: address(token),
                baseAtoms: SPOT_BASE,
                maxQuoteAtoms: MAX_SPOT_QUOTE,
                rollbackMinQuoteAtoms: MIN_ROLLBACK_QUOTE,
                entryFillCommitment: keccak256("entry-fill"),
                rollbackFillCommitment: keccak256("rollback-fill")
            }),
            submissionDeadline: uint64(block.timestamp + 100),
            venueDeadline: uint64(block.timestamp + 200),
            recoveryDeadline: uint64(block.timestamp + 300)
        });
    }

    function _mockPackage(IAsyncVenueAdapter.VenueRequest memory request, address owner) private {
        AsyncBondedPackageCoordinator.Package memory packageData;
        packageData.terms.owner = owner;
        packageData.terms.solver = address(this);
        packageData.terms.adapter = address(adapter);
        packageData.terms.handler = address(adapter);
        packageData.terms.adapterCodeHash = address(adapter).codehash;
        packageData.terms.handlerCodeHash = address(adapter).codehash;
        packageData.terms.requestPayloadHash = keccak256(abi.encode(request));
        packageData.terms.orderHash = request.orderHash;
        packageData.terms.quoteHash = request.quoteHash;
        packageData.terms.routeHash = request.routeHash;
        packageData.terms.nonce = request.packageNonce;
        packageData.terms.lossAsset = address(token);
        packageData.terms.residualAsset = address(token);
        packageData.terms.submissionDeadline = request.submissionDeadline;
        packageData.terms.venueDeadline = request.venueDeadline;
        packageData.terms.recoveryDeadline = request.recoveryDeadline;
        vm.mockCall(
            address(coordinator),
            abi.encodeWithSelector(AsyncBondedPackageCoordinator.packageState.selector, PACKAGE_ID),
            abi.encode(packageData)
        );
    }

    function _status(bytes32 key) private view returns (GmxV2ArbitrumAdapter.Status status) {
        (status,,,,) = adapter.requestEvidence(key);
    }

    function _revision(bytes32 key) private view returns (uint64 revision) {
        (,,,, revision) = adapter.requestEvidence(key);
    }
}

contract GmxV2CoordinatedSpotEntryTest is Test {
    uint256 private constant OWNER_KEY = 0xB0B;
    uint256 private constant COLLATERAL = 5_000_000;
    uint256 private constant SPOT_BASE = 1_000_000;
    uint256 private constant MAX_SPOT_QUOTE = 3_000_000;
    uint256 private constant EXECUTION_FEE = 0.002 ether;
    uint24 private constant POOL_FEE = 3000;

    GmxTestToken private token;
    GmxTestToken private baseToken;
    GmxTestDataStore private dataStore;
    GmxTestRoleStore private roleStore;
    GmxTestRouter private router;
    GmxTestOrderHandler private orderHandler;
    GmxTestExchangeRouter private exchangeRouter;
    GmxTestCode private eventEmitter;
    GmxTestOrderVault private orderVault;
    GmxTestCode private market;
    GmxV2OrderVerifier private orderVerifier;
    ProtocolConfig private config;
    AsyncBondedPackageCoordinator private coordinator;
    GmxV2IsolatedAccount private account;
    GmxV2ArbitrumAdapter private adapter;
    UniswapV3SpotPort private spotPort;
    GmxV2.Deployment private deployment;
    address private owner;

    function setUp() public {
        vm.warp(20_000);
        vm.deal(address(this), 10 ether);
        owner = vm.addr(OWNER_KEY);
        token = new GmxTestToken();
        baseToken = new GmxTestToken();
        dataStore = new GmxTestDataStore();
        roleStore = new GmxTestRoleStore();
        router = new GmxTestRouter();
        orderHandler = new GmxTestOrderHandler();
        eventEmitter = new GmxTestCode();
        orderVault = new GmxTestOrderVault();
        market = new GmxTestCode();
        orderVerifier = new GmxV2OrderVerifier();
        exchangeRouter = new GmxTestExchangeRouter(
            address(dataStore),
            address(eventEmitter),
            address(router),
            address(orderHandler),
            address(roleStore),
            address(orderVault)
        );
        roleStore.setRole(address(orderHandler), keccak256(abi.encode("CONTROLLER")), true);
        dataStore.setUint(keccak256(abi.encode("REQUEST_EXPIRATION_TIME")), 50);
        config = new ProtocolConfig(
            "eip155:421614", 1, keccak256("manifest"), 1, address(0xA1), address(0xA2), address(0xA3), address(0xA4)
        );
        coordinator = new AsyncBondedPackageCoordinator(config, token, keccak256("execution-class"));
        deployment = _deployment();
        account = new GmxV2IsolatedAccount(owner, address(this), address(market), token, deployment);
        adapter = new GmxV2ArbitrumAdapter(
            coordinator,
            address(coordinator).codehash,
            address(this),
            owner,
            address(market),
            address(market).codehash,
            token,
            address(token).codehash,
            account,
            orderVerifier,
            address(orderVerifier).codehash,
            deployment
        );
        vm.prank(owner);
        account.configureEntryController(address(adapter), address(adapter).codehash);

        GmxSpotFactory factory = new GmxSpotFactory();
        GmxSpotPool pool = new GmxSpotPool(address(factory), address(baseToken), address(token), POOL_FEE);
        factory.setPool(address(baseToken), address(token), POOL_FEE, address(pool));
        spotPort = new UniswapV3SpotPort(
            address(account),
            UniswapV3SpotPort.Deployment({
                chainId: block.chainid,
                factory: address(factory),
                pool: address(pool),
                baseToken: baseToken,
                quoteToken: token,
                baseTokenDecimals: 18,
                quoteTokenDecimals: 18,
                poolFee: POOL_FEE,
                factoryCodeHash: address(factory).codehash,
                poolCodeHash: address(pool).codehash,
                baseTokenCodeHash: address(baseToken).codehash,
                quoteTokenCodeHash: address(token).codehash
            })
        );
        vm.prank(owner);
        account.configureSpotPort(spotPort, address(spotPort).codehash);
        baseToken.mint(address(pool), SPOT_BASE * 100);
        token.mint(address(pool), MAX_SPOT_QUOTE * 100);

        vm.prank(address(0xA1));
        coordinator.proposeAdmission(
            address(adapter), address(adapter), address(adapter).codehash, address(adapter).codehash
        );
        vm.warp(block.timestamp + 1);
        vm.prank(address(0xA3));
        coordinator.activateAdmission(address(adapter));
        vm.prank(address(0xA1));
        config.scheduleUnpause();
        vm.warp(block.timestamp + 1);
        vm.prank(address(0xA3));
        config.activateUnpause();
    }

    function testOwnerSignedTermsCoordinateSpotBuyAndGmxSubmission() public {
        IAsyncVenueAdapter.VenueRequest memory request = _request();
        AsyncBondedPackageCoordinator.Terms memory terms = _terms(request);
        bytes32 id = coordinator.packageId(terms);
        bytes memory signature = _signature(coordinator.reserveDigest(terms));

        token.mint(address(this), COLLATERAL + MAX_SPOT_QUOTE + terms.bondAtoms + terms.recoveryReserveAtoms);
        token.approve(address(coordinator), terms.bondAtoms + terms.recoveryReserveAtoms);
        token.approve(address(adapter), COLLATERAL + MAX_SPOT_QUOTE);
        assertEq(coordinator.reserve(terms, signature), id);
        adapter.fundRequest{value: EXECUTION_FEE}(id, request);
        bytes32 requestKey = coordinator.submitRequest(id, 1, request);

        assertNotEq(requestKey, bytes32(0));
        assertEq(baseToken.balanceOf(address(account)), SPOT_BASE);
        assertEq(token.balanceOf(address(account)), 0);
        assertTrue(account.hasActiveSpotInventory());
        assertEq(account.activeSpotRegistration().fundingOwner, address(this));
        assertEq(exchangeRouter.lastAccount(), address(account));
        assertEq(exchangeRouter.dataList(0), id);
        assertEq(exchangeRouter.dataList(1), keccak256(abi.encode(request)));
        assertEq(
            uint8(coordinator.packageState(id).state), uint8(AsyncBondedPackageCoordinator.State.REQUEST_SUBMITTED)
        );
    }

    function _request() private view returns (IAsyncVenueAdapter.VenueRequest memory) {
        return IAsyncVenueAdapter.VenueRequest({
            marketId: bytes32(uint256(uint160(address(market)))),
            collateralToken: address(token),
            sizeDelta: -int256(4_000e30),
            collateralAtoms: COLLATERAL,
            acceptablePrice: 2_500e30,
            executionFeeWei: EXECUTION_FEE,
            callbackGasLimit: 2_000_000,
            packageNonce: 0,
            orderHash: keccak256("coordinated-order"),
            quoteHash: keccak256("coordinated-quote"),
            routeHash: keccak256("coordinated-route"),
            spot: IAsyncVenueAdapter.SpotEntry({
                fundingOwner: address(this),
                port: address(spotPort),
                portCodeHash: address(spotPort).codehash,
                baseToken: address(baseToken),
                quoteToken: address(token),
                baseAtoms: SPOT_BASE,
                maxQuoteAtoms: MAX_SPOT_QUOTE,
                rollbackMinQuoteAtoms: SPOT_BASE,
                entryFillCommitment: keccak256("coordinated-entry-fill"),
                rollbackFillCommitment: keccak256("coordinated-rollback-fill")
            }),
            submissionDeadline: uint64(block.timestamp + 100),
            venueDeadline: uint64(block.timestamp + 200),
            recoveryDeadline: uint64(block.timestamp + 300)
        });
    }

    function _terms(IAsyncVenueAdapter.VenueRequest memory request)
        private
        view
        returns (AsyncBondedPackageCoordinator.Terms memory terms)
    {
        terms.domain = AsyncBondedPackageCoordinator.DomainRef(keccak256("eip155:421614"), 1, keccak256("manifest"));
        terms.owner = owner;
        terms.solver = address(this);
        terms.adapter = address(adapter);
        terms.handler = address(adapter);
        terms.adapterCodeHash = address(adapter).codehash;
        terms.handlerCodeHash = address(adapter).codehash;
        terms.orderHash = request.orderHash;
        terms.quoteHash = request.quoteHash;
        terms.routeHash = request.routeHash;
        terms.seriesIdentityKey = keccak256("series");
        terms.seriesBindingVersion = 1;
        terms.seriesBindingHash = keccak256("series-binding");
        terms.executionClassIdentityHash = coordinator.EXECUTION_CLASS_ID();
        terms.executionClassManifestHash = keccak256("execution-class");
        terms.requestPayloadHash = keccak256(abi.encode(request));
        terms.evidenceSchemaHash = coordinator.EVIDENCE_SCHEMA_ID();
        terms.bondRecipient = address(0xB1);
        terms.recoveryReserveRecipient = address(0xB2);
        terms.slashRecipient = address(0xB3);
        terms.lossAsset = address(token);
        terms.residualAsset = address(token);
        terms.bondAtoms = 100;
        terms.recoveryReserveAtoms = 25;
        terms.maxAggregateLossAtoms = 25;
        terms.maxIntermediateResidualAtoms = COLLATERAL;
        terms.maxTerminalResidualAtoms = 1;
        terms.nonce = request.packageNonce;
        terms.submissionDeadline = request.submissionDeadline;
        terms.venueDeadline = request.venueDeadline;
        terms.recoveryDeadline = request.recoveryDeadline;
        terms.bondHash = coordinator.bondCommitment(terms);
        terms.reservationHash = coordinator.reservationCommitment(terms);
        terms.recoveryPolicyHash = coordinator.recoveryPolicyCommitment(terms);
    }

    function _deployment() private view returns (GmxV2.Deployment memory) {
        return GmxV2.Deployment({
            dataStore: address(dataStore),
            eventEmitter: address(eventEmitter),
            exchangeRouter: address(exchangeRouter),
            router: address(router),
            orderVault: address(orderVault),
            orderHandler: address(orderHandler),
            roleStore: address(roleStore),
            dataStoreCodeHash: address(dataStore).codehash,
            eventEmitterCodeHash: address(eventEmitter).codehash,
            exchangeRouterCodeHash: address(exchangeRouter).codehash,
            routerCodeHash: address(router).codehash,
            orderVaultCodeHash: address(orderVault).codehash,
            orderHandlerCodeHash: address(orderHandler).codehash,
            roleStoreCodeHash: address(roleStore).codehash
        });
    }

    function _signature(bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }
}

contract GmxV2ExitControllerTest is Test {
    bytes32 private constant PACKAGE_ID = keccak256("exit-package");
    bytes32 private constant CONTROLLER_ROLE = keccak256(abi.encode("CONTROLLER"));
    uint256 private constant OWNER_KEY = 0xA11CE;
    uint256 private constant COLLATERAL = 5_000_000;
    uint256 private constant SIZE = 4_000e30;
    uint256 private constant ENTRY_PRICE = 2_500e30;
    uint256 private constant EXIT_PRICE = 2_400e30;
    uint256 private constant EXECUTION_FEE = 0.002 ether;
    uint256 private constant CALLBACK_GAS = 2_000_000;
    uint256 private constant SPOT_BASE = 1_000_000;
    uint256 private constant MAX_SPOT_QUOTE = 3_000_000;
    uint256 private constant MIN_ROLLBACK_QUOTE = 1_000_000;
    uint24 private constant POOL_FEE = 3000;

    GmxTestToken private token;
    GmxTestToken private baseToken;
    GmxSpotFactory private spotFactory;
    GmxSpotPool private spotPool;
    UniswapV3SpotPort private spotPort;
    GmxTestDataStore private dataStore;
    GmxTestRoleStore private roleStore;
    GmxTestRouter private router;
    GmxTestOrderHandler private orderHandler;
    GmxTestExchangeRouter private exchangeRouter;
    GmxTestCode private eventEmitter;
    GmxTestOrderVault private orderVault;
    GmxTestCode private market;
    GmxV2OrderVerifier private entryVerifier;
    GmxV2ExitOrderVerifier private exitVerifier;
    AsyncBondedPackageCoordinator private coordinator;
    GmxV2ArbitrumAdapter private adapter;
    GmxV2IsolatedAccount private account;
    GmxV2ExitController private exitController;
    GmxV2.Deployment private deployment;

    address private owner;
    address private feePayer = address(0xFEE);
    address private feeRefundRecipient = address(0xCAFE);
    bytes32 private entryRequestKey;

    function setUp() public {
        vm.warp(10_000);
        vm.deal(address(this), 10 ether);
        vm.deal(feePayer, 10 ether);
        owner = vm.addr(OWNER_KEY);
        token = new GmxTestToken();
        dataStore = new GmxTestDataStore();
        roleStore = new GmxTestRoleStore();
        router = new GmxTestRouter();
        orderHandler = new GmxTestOrderHandler();
        eventEmitter = new GmxTestCode();
        orderVault = new GmxTestOrderVault();
        market = new GmxTestCode();
        entryVerifier = new GmxV2OrderVerifier();
        exitVerifier = new GmxV2ExitOrderVerifier();
        exchangeRouter = new GmxTestExchangeRouter(
            address(dataStore),
            address(eventEmitter),
            address(router),
            address(orderHandler),
            address(roleStore),
            address(orderVault)
        );
        roleStore.setRole(address(orderHandler), CONTROLLER_ROLE, true);
        dataStore.setUint(keccak256(abi.encode("REQUEST_EXPIRATION_TIME")), 50);

        ProtocolConfig config = new ProtocolConfig(
            "eip155:421614", 1, keccak256("manifest"), 1, address(1), address(2), address(3), address(4)
        );
        coordinator = new AsyncBondedPackageCoordinator(config, token, keccak256("execution-class"));
        deployment = GmxV2.Deployment({
            dataStore: address(dataStore),
            eventEmitter: address(eventEmitter),
            exchangeRouter: address(exchangeRouter),
            router: address(router),
            orderVault: address(orderVault),
            orderHandler: address(orderHandler),
            roleStore: address(roleStore),
            dataStoreCodeHash: address(dataStore).codehash,
            eventEmitterCodeHash: address(eventEmitter).codehash,
            exchangeRouterCodeHash: address(exchangeRouter).codehash,
            routerCodeHash: address(router).codehash,
            orderVaultCodeHash: address(orderVault).codehash,
            orderHandlerCodeHash: address(orderHandler).codehash,
            roleStoreCodeHash: address(roleStore).codehash
        });
        account = new GmxV2IsolatedAccount(owner, address(this), address(market), token, deployment);
        adapter = new GmxV2ArbitrumAdapter(
            coordinator,
            address(coordinator).codehash,
            address(this),
            owner,
            address(market),
            address(market).codehash,
            token,
            address(token).codehash,
            account,
            entryVerifier,
            address(entryVerifier).codehash,
            deployment
        );
        vm.prank(owner);
        account.configureEntryController(address(adapter), address(adapter).codehash);
        exitController = new GmxV2ExitController(
            adapter,
            address(adapter).codehash,
            account,
            address(account).codehash,
            exitVerifier,
            address(exitVerifier).codehash,
            deployment
        );
        vm.prank(owner);
        account.configureExitController(address(exitController), address(exitController).codehash);

        baseToken = new GmxTestToken();
        spotFactory = new GmxSpotFactory();
        spotPool = new GmxSpotPool(address(spotFactory), address(baseToken), address(token), POOL_FEE);
        spotFactory.setPool(address(baseToken), address(token), POOL_FEE, address(spotPool));
        spotPort = new UniswapV3SpotPort(
            address(account),
            UniswapV3SpotPort.Deployment({
                chainId: block.chainid,
                factory: address(spotFactory),
                pool: address(spotPool),
                baseToken: baseToken,
                quoteToken: token,
                baseTokenDecimals: 18,
                quoteTokenDecimals: 18,
                poolFee: POOL_FEE,
                factoryCodeHash: address(spotFactory).codehash,
                poolCodeHash: address(spotPool).codehash,
                baseTokenCodeHash: address(baseToken).codehash,
                quoteTokenCodeHash: address(token).codehash
            })
        );
        vm.prank(owner);
        account.configureSpotPort(spotPort, address(spotPort).codehash);
        baseToken.mint(address(spotPool), SPOT_BASE * 100);
        token.mint(address(spotPool), MAX_SPOT_QUOTE * 100);

        token.mint(address(this), COLLATERAL + MAX_SPOT_QUOTE);
        token.approve(address(adapter), COLLATERAL + MAX_SPOT_QUOTE);
        IAsyncVenueAdapter.VenueRequest memory request = _entryRequest();
        _mockPackage(request);
        adapter.fundRequest{value: EXECUTION_FEE}(PACKAGE_ID, request);
        vm.prank(address(coordinator));
        entryRequestKey = adapter.createRequest(PACKAGE_ID, request);
        exchangeRouter.executeOrder(entryRequestKey, SIZE);
        assertEq(account.positionSize(false), SIZE);
    }

    function testSignedFullClosePaysOnlyOwnerAndKeepsSpotInventoryLocked() public {
        GmxV2ExitController.ExitAuthorization memory authorization = _authorization();
        bytes32 exitRequestKey = _submit(authorization);

        assertEq(exchangeRouter.lastAccount(), address(account));
        assertEq(exchangeRouter.receiver(), owner);
        assertEq(exchangeRouter.cancellationReceiver(), feeRefundRecipient);
        assertEq(exchangeRouter.callbackContract(), address(exitController));
        assertEq(exchangeRouter.sizeDeltaUsd(), SIZE);
        assertEq(exchangeRouter.initialCollateralDeltaAmount(), type(uint256).max);
        assertEq(exchangeRouter.minOutputAmount(), authorization.minOutputAmount);
        assertEq(uint8(exchangeRouter.orderType()), uint8(GmxV2.OrderType.MarketDecrease));
        assertFalse(exchangeRouter.isLong());

        exchangeRouter.executeDecreaseOrder(exitRequestKey, 0, COLLATERAL);

        (GmxV2ExitController.Status status,,,, bool released) = exitController.exitEvidence(exitRequestKey);
        assertEq(uint8(status), uint8(GmxV2ExitController.Status.EXECUTED));
        assertFalse(released);
        assertEq(token.balanceOf(owner), COLLATERAL);
        assertEq(token.balanceOf(feePayer), 0);
        assertEq(token.balanceOf(feeRefundRecipient), 0);
        assertEq(adapter.activePackageId(), PACKAGE_ID);
        assertEq(adapter.activeRequestKey(), entryRequestKey);
        assertTrue(account.hasActiveSpotInventory());
    }

    function testRejectsExpiredAuthorizationAndReplay() public {
        GmxV2ExitController.ExitAuthorization memory expired = _authorization();
        expired.authorizationExpiry = uint64(block.timestamp);
        expired.cancelAfter = uint64(block.timestamp + 100);
        bytes memory expiredSignature = _sign(expired);
        vm.prank(feePayer);
        vm.expectRevert(GmxV2ExitController.InvalidAuthorization.selector);
        exitController.submitFullClose{value: EXECUTION_FEE}(expired, expiredSignature);
        assertEq(exitController.nextNonce(), 0);

        GmxV2ExitController.ExitAuthorization memory authorization = _authorization();
        bytes32 exitRequestKey = _submit(authorization);
        dataStore.setContains(exitController.ORDER_LIST(), exitRequestKey, false);
        orderHandler.cancelOrder(exitController, exitRequestKey, exchangeRouter.orderData());

        bytes memory replaySignature = _sign(authorization);
        vm.prank(feePayer);
        vm.expectRevert(GmxV2ExitController.InvalidAuthorization.selector);
        exitController.submitFullClose{value: EXECUTION_FEE}(authorization, replaySignature);
        assertEq(exitController.nextNonce(), 1);
    }

    function testDelayedCancellationAcceptsAuthenticatedLateExecution() public {
        GmxV2ExitController.ExitAuthorization memory authorization = _authorization();
        bytes32 exitRequestKey = _submit(authorization);
        vm.warp(authorization.cancelAfter);

        bool terminal = exitController.requestCancellationOrReconciliation(exitRequestKey);
        assertTrue(terminal);
        (GmxV2ExitController.Status recoveredStatus,,,,) = exitController.exitEvidence(exitRequestKey);
        assertEq(uint8(recoveredStatus), uint8(GmxV2ExitController.Status.RECOVERED));
        assertEq(account.positionSize(false), SIZE);

        exchangeRouter.executeOrder(exitRequestKey, 0);
        (GmxV2ExitController.Status finalStatus,,,, bool released) = exitController.exitEvidence(exitRequestKey);
        assertEq(uint8(finalStatus), uint8(GmxV2ExitController.Status.EXECUTED));
        assertFalse(released);
    }

    function testAuthenticatesCallbackAndRejectsUnexpectedShrink() public {
        GmxV2ExitController.ExitAuthorization memory authorization = _authorization();
        bytes32 exitRequestKey = _submit(authorization);
        GmxV2.EventLogData memory orderData = exchangeRouter.orderData();
        GmxV2.EventLogData memory eventData;
        vm.expectRevert(GmxV2ExitController.UnauthorizedCaller.selector);
        exitController.afterOrderExecution(exitRequestKey, orderData, eventData);

        orderData.addressItems.items[1].value = address(0xBAD);
        vm.prank(address(orderHandler));
        vm.expectRevert(GmxV2ExitOrderVerifier.InvalidOrderData.selector);
        exitController.afterOrderExecution(exitRequestKey, orderData, eventData);

        vm.warp(authorization.cancelAfter);
        _setPositionSize(0);
        dataStore.setContains(exitController.ORDER_LIST(), exitRequestKey, false);
        bool terminal = exitController.requestCancellationOrReconciliation(exitRequestKey);
        assertFalse(terminal);
        (GmxV2ExitController.Status status,,,,) = exitController.exitEvidence(exitRequestKey);
        assertEq(uint8(status), uint8(GmxV2ExitController.Status.CONFLICT));
        assertEq(adapter.activePackageId(), PACKAGE_ID);
    }

    function testPartialDecreaseCallbackNeverLabelsFullClose() public {
        GmxV2ExitController.ExitAuthorization memory authorization = _authorization();
        bytes32 exitRequestKey = _submit(authorization);
        exchangeRouter.executeOrder(exitRequestKey, SIZE / 2);

        (GmxV2ExitController.Status status,,,, bool released) = exitController.exitEvidence(exitRequestKey);
        assertEq(uint8(status), uint8(GmxV2ExitController.Status.CONFLICT));
        assertFalse(released);
        assertEq(adapter.activePackageId(), PACKAGE_ID);
    }

    function testOwnerCannotAuthorizeDifferentPositionReceiverOrHiddenFeeRecipient() public {
        GmxV2ExitController.ExitAuthorization memory authorization = _authorization();
        authorization.receiver = address(0xBAD);
        bytes memory invalidReceiverSignature = _sign(authorization);
        vm.prank(feePayer);
        vm.expectRevert(GmxV2ExitController.InvalidAuthorization.selector);
        exitController.submitFullClose{value: EXECUTION_FEE}(authorization, invalidReceiverSignature);

        authorization = _authorization();
        authorization.feePayer = address(0xBAD);
        bytes memory invalidFeePayerSignature = _sign(authorization);
        vm.prank(feePayer);
        vm.expectRevert(GmxV2ExitController.FundingMismatch.selector);
        exitController.submitFullClose{value: EXECUTION_FEE}(authorization, invalidFeePayerSignature);
    }

    function _submit(GmxV2ExitController.ExitAuthorization memory authorization) private returns (bytes32 requestKey) {
        bytes memory signature = _sign(authorization);
        vm.prank(feePayer);
        requestKey = exitController.submitFullClose{value: EXECUTION_FEE}(authorization, signature);
        assertNotEq(requestKey, bytes32(0));
    }

    function _sign(GmxV2ExitController.ExitAuthorization memory authorization) private view returns (bytes memory) {
        bytes32 digest = exitController.exitDigest(authorization);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _authorization() private view returns (GmxV2ExitController.ExitAuthorization memory) {
        return GmxV2ExitController.ExitAuthorization({
            packageId: PACKAGE_ID,
            entryRequestKey: entryRequestKey,
            account: address(account),
            owner: owner,
            receiver: owner,
            feePayer: feePayer,
            executionFeeRefundRecipient: feeRefundRecipient,
            market: address(market),
            collateralToken: address(token),
            isLong: false,
            fullCloseSizeUsd: SIZE,
            acceptablePrice: EXIT_PRICE,
            minOutputAmount: 1_000e30,
            executionFeeWei: EXECUTION_FEE,
            callbackGasLimit: CALLBACK_GAS,
            authorizationExpiry: uint64(block.timestamp + 100),
            cancelAfter: uint64(block.timestamp + 200),
            nonce: exitController.nextNonce()
        });
    }

    function _entryRequest() private view returns (IAsyncVenueAdapter.VenueRequest memory) {
        return IAsyncVenueAdapter.VenueRequest({
            marketId: bytes32(uint256(uint160(address(market)))),
            collateralToken: address(token),
            sizeDelta: -int256(SIZE),
            collateralAtoms: COLLATERAL,
            acceptablePrice: ENTRY_PRICE,
            executionFeeWei: EXECUTION_FEE,
            callbackGasLimit: CALLBACK_GAS,
            packageNonce: 9,
            orderHash: keccak256("exit-order"),
            quoteHash: keccak256("exit-quote"),
            routeHash: keccak256("exit-route"),
            spot: IAsyncVenueAdapter.SpotEntry({
                fundingOwner: address(this),
                port: address(spotPort),
                portCodeHash: address(spotPort).codehash,
                baseToken: address(baseToken),
                quoteToken: address(token),
                baseAtoms: SPOT_BASE,
                maxQuoteAtoms: MAX_SPOT_QUOTE,
                rollbackMinQuoteAtoms: MIN_ROLLBACK_QUOTE,
                entryFillCommitment: keccak256("exit-entry-fill"),
                rollbackFillCommitment: keccak256("exit-rollback-fill")
            }),
            submissionDeadline: uint64(block.timestamp + 100),
            venueDeadline: uint64(block.timestamp + 200),
            recoveryDeadline: uint64(block.timestamp + 300)
        });
    }

    function _mockPackage(IAsyncVenueAdapter.VenueRequest memory request) private {
        AsyncBondedPackageCoordinator.Package memory packageData;
        packageData.terms.owner = owner;
        packageData.terms.solver = address(this);
        packageData.terms.adapter = address(adapter);
        packageData.terms.handler = address(adapter);
        packageData.terms.adapterCodeHash = address(adapter).codehash;
        packageData.terms.handlerCodeHash = address(adapter).codehash;
        packageData.terms.requestPayloadHash = keccak256(abi.encode(request));
        packageData.terms.orderHash = request.orderHash;
        packageData.terms.quoteHash = request.quoteHash;
        packageData.terms.routeHash = request.routeHash;
        packageData.terms.nonce = request.packageNonce;
        packageData.terms.lossAsset = address(token);
        packageData.terms.residualAsset = address(token);
        packageData.terms.submissionDeadline = request.submissionDeadline;
        packageData.terms.venueDeadline = request.venueDeadline;
        packageData.terms.recoveryDeadline = request.recoveryDeadline;
        vm.mockCall(
            address(coordinator),
            abi.encodeWithSelector(AsyncBondedPackageCoordinator.packageState.selector, PACKAGE_ID),
            abi.encode(packageData)
        );
    }

    function _setPositionSize(uint256 size) private {
        bytes32 positionKey = keccak256(abi.encode(address(account), address(market), address(token), false));
        bytes32 sizeKey = keccak256(abi.encode(positionKey, account.SIZE_IN_USD()));
        dataStore.setUint(sizeKey, size);
    }
}
