// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {IPerpMarginGate} from "../src/interfaces/IPerpMarginGate.sol";
import {ISynFuturesInstrument} from "../src/interfaces/ISynFuturesInstrument.sol";
import {ISynFuturesPositionObserver} from "../src/interfaces/ISynFuturesPositionObserver.sol";
import {ITypedStrategyAdapter} from "../src/interfaces/ITypedStrategyAdapter.sol";
import {SynFuturesTypedPerpAdapter} from "../src/SynFuturesTypedPerpAdapter.sol";
import {UniswapV3TypedSpotAdapter} from "../src/UniswapV3TypedSpotAdapter.sol";

interface ITypedSpotCallback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

contract TypedAdapterToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

contract TypedAdapterAccountHarness {
    using SafeERC20 for IERC20;

    function execute(ITypedStrategyAdapter adapter, IERC20 approvalToken, uint256 approvalAtoms, bytes calldata payload)
        external
        returns (bytes32 evidenceHash)
    {
        if (approvalAtoms != 0) approvalToken.forceApprove(address(adapter), approvalAtoms);
        evidenceHash = adapter.executeLeg(payload);
        if (approvalAtoms != 0) approvalToken.forceApprove(address(adapter), 0);
    }
}

contract TypedAdapterV3Factory {
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

contract TypedAdapterV3Pool {
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
        ITypedSpotCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
    }
}

contract TypedAdapterPerpVenue is ISynFuturesInstrument, ISynFuturesPositionObserver, IPerpMarginGate {
    using SafeERC20 for IERC20;

    IERC20 public immutable override collateral;
    uint32 public immutable expiry;
    mapping(address trader => uint256 reserve) private _reserves;
    mapping(address trader => Position position) private _positions;

    constructor(IERC20 collateral_, uint32 expiry_) {
        collateral = collateral_;
        expiry = expiry_;
    }

    function reserveOf(address trader) external view returns (uint256) {
        return _reserves[trader];
    }

    function deposit(uint256 amount) external {
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        _reserves[msg.sender] += amount;
    }

    function withdraw(uint256 amount) external {
        require(amount != 0 && amount <= _reserves[msg.sender]);
        _reserves[msg.sender] -= amount;
        collateral.safeTransfer(msg.sender, amount);
    }

    function trade(bytes32[2] calldata args) external returns (PositionCache memory result) {
        uint256 packed = uint256(args[1]);
        int128 sizeDelta = int128(uint128(packed >> 128));
        int128 balanceDelta = int128(uint128(packed));
        Position storage current = _positions[msg.sender];
        if (current.size == 0) {
            require(sizeDelta != 0 && balanceDelta > 0);
            uint256 margin = uint256(uint128(balanceDelta));
            require(margin <= _reserves[msg.sender]);
            _reserves[msg.sender] -= margin;
            current.balance = balanceDelta;
            current.size = sizeDelta;
            current.entryNotional = uint128(_abs(sizeDelta) * 2);
        } else {
            require(sizeDelta == -current.size && balanceDelta == 0);
            _reserves[msg.sender] += uint256(uint128(current.balance));
            delete _positions[msg.sender];
        }
        Position memory observed = _positions[msg.sender];
        result = PositionCache(
            observed.balance,
            observed.size,
            observed.entryNotional,
            observed.entrySocialLossIndex,
            observed.entryFundingIndex
        );
    }

    function getPosition(address instrument, uint32 requestedExpiry, address target)
        external
        view
        returns (Position memory)
    {
        require(instrument == address(this) && requestedExpiry == expiry);
        return _positions[target];
    }

    function _abs(int128 value) private pure returns (uint256) {
        return value < 0 ? uint256(uint128(-value)) : uint256(uint128(value));
    }
}

    contract TypedStrategyAdaptersTest is Test {
        uint24 private constant POOL_FEE = 3_000;
        uint32 private constant EXPIRY = 1_900_000_000;
        bytes32 private constant PACKAGE_ID = keccak256("package");
        bytes32 private constant ORDER_HASH = keccak256("order");
        bytes32 private constant QUOTE_HASH = keccak256("quote");
        bytes32 private constant ROUTE_HASH = keccak256("route");

        TypedAdapterToken private base;
        TypedAdapterToken private quote;
        TypedAdapterAccountHarness private account;
        TypedAdapterV3Factory private factory;
        TypedAdapterV3Pool private pool;
        UniswapV3TypedSpotAdapter private spot;
        TypedAdapterPerpVenue private perpVenue;
        SynFuturesTypedPerpAdapter private perp;

        function setUp() public {
            base = new TypedAdapterToken("Base", "BASE");
            quote = new TypedAdapterToken("Quote", "QUOTE");
            account = new TypedAdapterAccountHarness();
            factory = new TypedAdapterV3Factory();
            pool = new TypedAdapterV3Pool(address(factory), address(base), address(quote), POOL_FEE);
            factory.setPool(address(base), address(quote), POOL_FEE, address(pool));
            spot = new UniswapV3TypedSpotAdapter(_spotDeployment());
            perpVenue = new TypedAdapterPerpVenue(quote, EXPIRY);
            perp = new SynFuturesTypedPerpAdapter(_perpDeployment());

            base.mint(address(pool), 1_000 ether);
            quote.mint(address(pool), 2_000 ether);
            base.mint(address(account), 10 ether);
            quote.mint(address(account), 1_000 ether);
        }

        function testExactSpotBuyAndSellReturnAssetsToStrategyAccount() public {
            bytes32 buyEvidence =
                account.execute(spot, quote, 3 ether, abi.encode(_spotLeg(spot.BUY_EXACT_OUTPUT(), 1 ether, 3 ether)));
            assertTrue(buyEvidence != bytes32(0));
            assertEq(base.balanceOf(address(account)), 11 ether);
            assertEq(quote.balanceOf(address(account)), 998 ether);
            assertEq(base.balanceOf(address(spot)), 0);
            assertEq(quote.balanceOf(address(spot)), 0);

            bytes32 sellEvidence =
                account.execute(spot, base, 1 ether, abi.encode(_spotLeg(spot.SELL_EXACT_INPUT(), 1 ether, 2 ether)));
            assertTrue(sellEvidence != bytes32(0));
            assertEq(base.balanceOf(address(account)), 10 ether);
            assertEq(quote.balanceOf(address(account)), 1_000 ether);
        }

        function testPerpAdapterKeepsPackagePositionIsolatedAndReturnsReserveOnExit() public {
            ISynFuturesPositionObserver.Position memory empty;
            SynFuturesTypedPerpAdapter.ExactPerpLeg memory open = _emptyPerpLeg();
            open.expectedPrePositionHash = keccak256(abi.encode(empty));
            open.tradeArgs[1] = _tradeArgs(10, 50 ether);
            open.expectedPostSizeWad = 10;
            open.minimumPostBalanceWad = 50 ether;
            open.maximumPostBalanceWad = 50 ether;
            open.minimumPostEntryNotionalWad = 20;
            open.maximumPostEntryNotionalWad = 20;
            open.minimumReserveAfterAtoms = 50 ether;
            open.maximumReserveAfterAtoms = 50 ether;
            open.collateralInAtoms = 100 ether;

            bytes32 openEvidence = account.execute(perp, quote, 100 ether, abi.encode(open));
            assertTrue(openEvidence != bytes32(0));
            assertEq(quote.balanceOf(address(account)), 900 ether);
            assertEq(perpVenue.reserveOf(address(perp)), 50 ether);

            ISynFuturesPositionObserver.Position memory current = perp.position();
            SynFuturesTypedPerpAdapter.ExactPerpLeg memory close = _emptyPerpLeg();
            close.expectedPrePositionHash = keccak256(abi.encode(current));
            close.tradeArgs[1] = _tradeArgs(-10, 0);
            close.expectedReserveBeforeAtoms = 50 ether;
            close.withdrawAll = true;
            close.minimumCollateralOutAtoms = 100 ether;
            close.maximumCollateralOutAtoms = 100 ether;

            bytes32 closeEvidence = account.execute(perp, quote, 0, abi.encode(close));
            assertTrue(closeEvidence != bytes32(0));
            assertEq(quote.balanceOf(address(account)), 1_000 ether);
            assertEq(quote.balanceOf(address(perp)), 0);
            assertEq(perpVenue.reserveOf(address(perp)), 0);
            assertEq(perp.position().size, 0);
        }

        function testAdaptersRejectCallsOutsideTheirBoundStrategyAccount() public {
            uint8 buyExactOutput = spot.BUY_EXACT_OUTPUT();
            vm.expectRevert(UniswapV3TypedSpotAdapter.UnauthorizedCaller.selector);
            spot.executeLeg(abi.encode(_spotLeg(buyExactOutput, 1 ether, 3 ether)));

            vm.expectRevert(SynFuturesTypedPerpAdapter.UnauthorizedCaller.selector);
            perp.executeLeg(abi.encode(_emptyPerpLeg()));
        }

        function _spotDeployment() private view returns (UniswapV3TypedSpotAdapter.Deployment memory) {
            return UniswapV3TypedSpotAdapter.Deployment({
                chainId: block.chainid,
                strategyAccount: address(account),
                packageId: PACKAGE_ID,
                factory: address(factory),
                pool: address(pool),
                baseToken: base,
                quoteToken: quote,
                baseTokenDecimals: 18,
                quoteTokenDecimals: 18,
                poolFee: POOL_FEE,
                strategyAccountCodeHash: address(account).codehash,
                factoryCodeHash: address(factory).codehash,
                poolCodeHash: address(pool).codehash,
                baseTokenCodeHash: address(base).codehash,
                quoteTokenCodeHash: address(quote).codehash
            });
        }

        function _perpDeployment() private view returns (SynFuturesTypedPerpAdapter.Deployment memory) {
            return SynFuturesTypedPerpAdapter.Deployment({
                chainId: block.chainid,
                strategyAccount: address(account),
                packageId: PACKAGE_ID,
                baseToken: base,
                collateralToken: quote,
                instrument: perpVenue,
                observer: perpVenue,
                marginGate: perpVenue,
                expiry: EXPIRY,
                strategyAccountCodeHash: address(account).codehash,
                baseTokenCodeHash: address(base).codehash,
                collateralTokenCodeHash: address(quote).codehash,
                instrumentCodeHash: address(perpVenue).codehash,
                observerCodeHash: address(perpVenue).codehash,
                marginGateCodeHash: address(perpVenue).codehash
            });
        }

        function _spotLeg(uint8 action, uint256 baseAtoms, uint256 quoteBoundAtoms)
            private
            pure
            returns (UniswapV3TypedSpotAdapter.ExactSpotLeg memory)
        {
            return UniswapV3TypedSpotAdapter.ExactSpotLeg({
                packageId: PACKAGE_ID,
                orderHash: ORDER_HASH,
                quoteHash: QUOTE_HASH,
                routeHash: ROUTE_HASH,
                action: action,
                baseAtoms: baseAtoms,
                quoteBoundAtoms: quoteBoundAtoms
            });
        }

        function _emptyPerpLeg() private pure returns (SynFuturesTypedPerpAdapter.ExactPerpLeg memory leg) {
            leg.packageId = PACKAGE_ID;
            leg.orderHash = ORDER_HASH;
            leg.quoteHash = QUOTE_HASH;
            leg.routeHash = ROUTE_HASH;
        }

        function _tradeArgs(int128 sizeDelta, int128 balanceDelta) private pure returns (bytes32) {
            return bytes32(uint256(uint128(sizeDelta)) << 128 | uint256(uint128(balanceDelta)));
        }
    }
