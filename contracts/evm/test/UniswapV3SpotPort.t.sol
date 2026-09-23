// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {UniswapV3SpotPort} from "../src/UniswapV3SpotPort.sol";

contract MockToken is ERC20 {
    uint8 private immutable _tokenDecimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _tokenDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _tokenDecimals;
    }

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

contract MockV3Factory {
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
        bool tokensMatch = (tokenA_ == tokenA && tokenB_ == tokenB) || (tokenA_ == tokenB && tokenB_ == tokenA);
        return tokensMatch && poolFee_ == poolFee ? pool : address(0);
    }
}

contract MockV3Pool {
    enum CallbackMode {
        VALID,
        WRONG_DATA,
        DUPLICATE
    }

    address public immutable factory;
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    CallbackMode public callbackMode;

    constructor(address factory_, address token0_, address token1_, uint24 fee_) {
        factory = factory_;
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
    }

    function setCallbackMode(CallbackMode callbackMode_) external {
        callbackMode = callbackMode_;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(amountSpecified != 0);
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

        bytes memory callbackData = callbackMode == CallbackMode.WRONG_DATA ? abi.encode(bytes32("wrong")) : data;
        UniswapV3SpotPort(msg.sender).uniswapV3SwapCallback(amount0, amount1, callbackData);
        if (callbackMode == CallbackMode.DUPLICATE) {
            UniswapV3SpotPort(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        }
    }
}

contract UniswapV3SpotPortTest is Test {
    uint24 private constant POOL_FEE = 3000;
    uint256 private constant QUANTITY = 1 ether;

    MockToken private base;
    MockToken private quote;
    MockV3Factory private factory;
    MockV3Pool private pool;
    UniswapV3SpotPort private port;

    function setUp() public {
        base = new MockToken("Base", "BASE", 18);
        quote = new MockToken("Quote", "QUOTE", 18);
        factory = new MockV3Factory();
        pool = new MockV3Pool(address(factory), address(base), address(quote), POOL_FEE);
        factory.setPool(address(base), address(quote), POOL_FEE, address(pool));

        port = new UniswapV3SpotPort(address(this), _deployment(18, 18));
        base.mint(address(pool), 100 ether);
        quote.mint(address(pool), 200 ether);
        base.mint(address(this), 10 ether);
        quote.mint(address(this), 20 ether);
        base.approve(address(port), type(uint256).max);
        quote.approve(address(port), type(uint256).max);
    }

    function testReversedTokenOrderingBuysAndSellsWithoutPoolAllowance() public {
        uint256 quoteBefore = quote.balanceOf(address(this));

        uint256 quoteIn = port.buyExactOutput(QUANTITY, 3 ether);
        assertEq(quoteIn, 2 ether);
        assertEq(base.balanceOf(address(this)), 11 ether);
        assertEq(quote.balanceOf(address(this)), quoteBefore - quoteIn);

        uint256 quoteOut = port.sellExactInput(QUANTITY, 2 ether);
        assertEq(quoteOut, 2 ether);
        assertEq(base.balanceOf(address(this)), 10 ether);
        assertEq(quote.balanceOf(address(this)), quoteBefore);
        assertEq(base.allowance(address(port), address(pool)), 0);
        assertEq(quote.allowance(address(port), address(pool)), 0);
        assertEq(base.balanceOf(address(port)), 0);
        assertEq(quote.balanceOf(address(port)), 0);
    }

    function testWrongCallbackDataRevertsAndAFollowingSwapSucceeds() public {
        pool.setCallbackMode(MockV3Pool.CallbackMode.WRONG_DATA);
        vm.expectRevert(UniswapV3SpotPort.InvalidCallback.selector);
        port.buyExactOutput(QUANTITY, 3 ether);

        pool.setCallbackMode(MockV3Pool.CallbackMode.VALID);
        assertEq(port.buyExactOutput(QUANTITY, 3 ether), 2 ether);
    }

    function testDuplicateCallbackRevertsAndAFollowingSwapSucceeds() public {
        pool.setCallbackMode(MockV3Pool.CallbackMode.DUPLICATE);
        vm.expectRevert(UniswapV3SpotPort.InvalidCallback.selector);
        port.sellExactInput(QUANTITY, 1);

        pool.setCallbackMode(MockV3Pool.CallbackMode.VALID);
        assertEq(port.sellExactInput(QUANTITY, 2 ether), 2 ether);
    }

    function testConstructorRejectsWrongDecimalsAndExecutorIdentity() public {
        vm.expectRevert(UniswapV3SpotPort.DeploymentChanged.selector);
        new UniswapV3SpotPort(address(this), _deployment(18, 6));

        vm.expectRevert(UniswapV3SpotPort.InvalidConfiguration.selector);
        new UniswapV3SpotPort(address(pool), _deployment(18, 18));
    }

    function _deployment(uint8 baseDecimals, uint8 quoteDecimals)
        private
        view
        returns (UniswapV3SpotPort.Deployment memory)
    {
        return UniswapV3SpotPort.Deployment({
            chainId: block.chainid,
            factory: address(factory),
            pool: address(pool),
            baseToken: IERC20(address(base)),
            quoteToken: IERC20(address(quote)),
            baseTokenDecimals: baseDecimals,
            quoteTokenDecimals: quoteDecimals,
            poolFee: POOL_FEE,
            factoryCodeHash: address(factory).codehash,
            poolCodeHash: address(pool).codehash,
            baseTokenCodeHash: address(base).codehash,
            quoteTokenCodeHash: address(quote).codehash
        });
    }
}
