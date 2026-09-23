// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {UniswapV3SpotPort} from "../src/UniswapV3SpotPort.sol";

contract BaseSepoliaUniswapV3SpotPortTest is Test {
    uint256 private constant FORK_BLOCK = 47_200_000;
    uint256 private constant QUANTITY = 0.0001 ether;
    uint256 private constant MAX_QUOTE = 1e6;

    address private constant FACTORY = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address private constant POOL = 0x46880b404CD35c165EDdefF7421019F8dD25F4Ad;
    address private constant BASE_TOKEN = 0x4200000000000000000000000000000000000006;
    address private constant QUOTE_TOKEN = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    bytes32 private constant FACTORY_CODE_HASH = 0x02ee6e36873eea6fbb674a23d53b735646f12dc84efa08eac17872fe2fad9d06;
    bytes32 private constant POOL_CODE_HASH = 0xbbda0bdc9da3fd1f4832633a5ea75dc401ca24fdbca3d64a2511f27583ec7c4d;
    bytes32 private constant BASE_TOKEN_CODE_HASH = 0x83f731a17e6c0cdd04bc6f60b15d3e789e215b71403087b84b48650a1e5cbb21;
    bytes32 private constant QUOTE_TOKEN_CODE_HASH = 0xedc5281a85c0efecd49999a1ef668390c59b88702f2d4a07029d7f5d63059d6c;

    UniswapV3SpotPort private port;
    IERC20 private base;
    IERC20 private quote;

    function setUp() public {
        vm.createSelectFork("https://sepolia.base.org", FORK_BLOCK);
        port = new UniswapV3SpotPort(
            address(this),
            UniswapV3SpotPort.Deployment({
                chainId: 84532,
                factory: FACTORY,
                pool: POOL,
                baseToken: IERC20(BASE_TOKEN),
                quoteToken: IERC20(QUOTE_TOKEN),
                baseTokenDecimals: 18,
                quoteTokenDecimals: 6,
                poolFee: 3000,
                factoryCodeHash: FACTORY_CODE_HASH,
                poolCodeHash: POOL_CODE_HASH,
                baseTokenCodeHash: BASE_TOKEN_CODE_HASH,
                quoteTokenCodeHash: QUOTE_TOKEN_CODE_HASH
            })
        );
        base = IERC20(BASE_TOKEN);
        quote = IERC20(QUOTE_TOKEN);
        deal(address(quote), address(this), 10e6);
    }

    function testExactOutputEntryAndExactInputExitUsePinnedPool() public {
        uint256 baseBefore = base.balanceOf(address(this));
        uint256 quoteBefore = quote.balanceOf(address(this));

        quote.approve(address(port), MAX_QUOTE);
        uint256 quoteIn = port.buyExactOutput(QUANTITY, MAX_QUOTE);

        assertGt(quoteIn, 0);
        assertLe(quoteIn, MAX_QUOTE);
        assertEq(base.balanceOf(address(this)), baseBefore + QUANTITY);
        assertEq(quote.balanceOf(address(this)), quoteBefore - quoteIn);
        assertEq(base.balanceOf(address(port)), 0);
        assertEq(quote.balanceOf(address(port)), 0);

        base.approve(address(port), QUANTITY);
        uint256 quoteOut = port.sellExactInput(QUANTITY, 1);

        assertGt(quoteOut, 0);
        assertEq(base.balanceOf(address(this)), baseBefore);
        assertEq(quote.balanceOf(address(this)), quoteBefore - quoteIn + quoteOut);
        assertEq(base.balanceOf(address(port)), 0);
        assertEq(quote.balanceOf(address(port)), 0);
    }

    function testBoundsAndAuthorizationFailClosedWithoutMovingFunds() public {
        uint256 quoteBefore = quote.balanceOf(address(this));
        quote.approve(address(port), MAX_QUOTE);

        vm.expectRevert();
        port.buyExactOutput(QUANTITY, 1);
        assertEq(quote.balanceOf(address(this)), quoteBefore);
        assertEq(quote.balanceOf(address(port)), 0);

        uint256 quoteIn = port.buyExactOutput(QUANTITY, MAX_QUOTE);
        assertGt(quoteIn, 0);
        vm.expectRevert(UniswapV3SpotPort.InvalidCallback.selector);
        port.uniswapV3SwapCallback(1, -1, abi.encode(true, uint256(1)));

        vm.prank(address(0xBEEF));
        vm.expectRevert(UniswapV3SpotPort.UnauthorizedExecutor.selector);
        port.buyExactOutput(QUANTITY, MAX_QUOTE);

        vm.expectRevert(UniswapV3SpotPort.InvalidQuantity.selector);
        port.sellExactInput(QUANTITY, 0);
    }

    function testDeploymentIdentityAndChainAreCheckedAtExecution() public {
        vm.chainId(8453);
        vm.expectRevert(UniswapV3SpotPort.DeploymentChanged.selector);
        port.assertDeployment();

        vm.chainId(84532);
        vm.etch(POOL, hex"00");
        vm.expectRevert(UniswapV3SpotPort.DeploymentChanged.selector);
        port.assertDeployment();
    }
}
