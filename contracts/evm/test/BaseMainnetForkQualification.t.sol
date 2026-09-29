// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "openzeppelin-contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {UniswapV3SpotPort} from "../src/UniswapV3SpotPort.sol";
import {ISpotFillRecorder} from "../src/interfaces/ISpotFillRecorder.sol";

interface IBaseForkUniswapFactory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IBaseForkUniswapPool {
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
}

contract BaseForkFillRecorder is ISpotFillRecorder {
    uint8 public action;
    uint256 public baseAtoms;
    uint256 public quoteAtoms;

    function recordSpotFill(
        address,
        uint256,
        bytes32,
        bytes32,
        bytes32,
        bytes32,
        uint8 action_,
        address,
        address,
        uint256 baseAtoms_,
        uint256 quoteAtoms_
    ) external {
        action = action_;
        baseAtoms = baseAtoms_;
        quoteAtoms = quoteAtoms_;
    }
}

contract BaseMainnetForkQualificationTest is Test {
    uint256 private constant BASE_CHAIN_ID = 8453;
    bytes32 private constant FILL_COMMITMENT = keccak256("base-mainnet-fork-fill");
    bytes32 private constant ORDER_HASH = keccak256("base-mainnet-fork-order");
    bytes32 private constant QUOTE_HASH = keccak256("base-mainnet-fork-quote");
    bytes32 private constant ROUTE_HASH = keccak256("base-mainnet-fork-route");

    function testPinnedBaseUniswapDeploymentAndForkLocalRoundTrip() external {
        string memory rpcUrl = vm.envOr("BASE_MAINNET_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) {
            vm.skip(true, "BASE_MAINNET_RPC_URL absent: skipping pinned Base fork qualification");
        }

        uint256 forkBlock = vm.envUint("BASE_MAINNET_FORK_BLOCK");
        require(forkBlock != 0, "BASE_MAINNET_FORK_BLOCK is zero");
        vm.createSelectFork(rpcUrl, forkBlock);
        assertEq(block.chainid, BASE_CHAIN_ID);
        assertEq(block.number, forkBlock);

        UniswapV3SpotPort.Deployment memory deployment = _deployment();
        _assertRelationships(deployment);

        BaseForkFillRecorder recorder = new BaseForkFillRecorder();
        UniswapV3SpotPort port = new UniswapV3SpotPort(address(recorder), deployment);
        port.assertDeployment();

        uint256 quantity = vm.envUint("BASE_FORK_ROUND_TRIP_BASE_ATOMS");
        uint256 maxQuote = vm.envUint("BASE_FORK_ROUND_TRIP_MAX_QUOTE_ATOMS");
        require(quantity != 0 && maxQuote != 0, "fork-local trade bounds are zero");
        deal(address(deployment.quoteToken), address(this), maxQuote);
        deployment.quoteToken.approve(address(port), maxQuote);
        uint256 quoteIn =
            port.buyExactOutput(1, FILL_COMMITMENT, ORDER_HASH, QUOTE_HASH, ROUTE_HASH, quantity, maxQuote);
        assertGt(quoteIn, 0);
        assertEq(recorder.action(), port.ENTRY());

        deployment.baseToken.approve(address(port), quantity);
        uint256 quoteOut = port.sellExactInput(2, FILL_COMMITMENT, ORDER_HASH, QUOTE_HASH, ROUTE_HASH, quantity, 1);
        assertGt(quoteOut, 0);
        assertEq(recorder.action(), port.EXIT());
        assertEq(recorder.baseAtoms(), quantity);
        assertEq(recorder.quoteAtoms(), quoteOut);
        assertEq(deployment.baseToken.balanceOf(address(port)), 0);
        assertEq(deployment.quoteToken.balanceOf(address(port)), 0);
    }

    function _deployment() private view returns (UniswapV3SpotPort.Deployment memory deployment) {
        deployment = UniswapV3SpotPort.Deployment({
            chainId: BASE_CHAIN_ID,
            factory: _requiredAddress("BASE_UNISWAP_V3_FACTORY"),
            pool: _requiredAddress("BASE_UNISWAP_V3_POOL"),
            baseToken: IERC20(_requiredAddress("BASE_SPOT_BASE_TOKEN")),
            quoteToken: IERC20(_requiredAddress("BASE_SPOT_QUOTE_TOKEN")),
            baseTokenDecimals: uint8(vm.envUint("BASE_SPOT_BASE_TOKEN_DECIMALS")),
            quoteTokenDecimals: uint8(vm.envUint("BASE_SPOT_QUOTE_TOKEN_DECIMALS")),
            poolFee: uint24(vm.envUint("BASE_UNISWAP_V3_POOL_FEE")),
            factoryCodeHash: _requiredHash("BASE_UNISWAP_V3_FACTORY_CODE_HASH"),
            poolCodeHash: _requiredHash("BASE_UNISWAP_V3_POOL_CODE_HASH"),
            baseTokenCodeHash: _requiredHash("BASE_SPOT_BASE_TOKEN_CODE_HASH"),
            quoteTokenCodeHash: _requiredHash("BASE_SPOT_QUOTE_TOKEN_CODE_HASH")
        });
    }

    function _assertRelationships(UniswapV3SpotPort.Deployment memory deployment) private view {
        assertEq(deployment.factory.codehash, deployment.factoryCodeHash);
        assertEq(deployment.pool.codehash, deployment.poolCodeHash);
        assertEq(address(deployment.baseToken).codehash, deployment.baseTokenCodeHash);
        assertEq(address(deployment.quoteToken).codehash, deployment.quoteTokenCodeHash);
        assertEq(
            IBaseForkUniswapFactory(deployment.factory)
                .getPool(address(deployment.baseToken), address(deployment.quoteToken), deployment.poolFee),
            deployment.pool
        );
        assertEq(IBaseForkUniswapPool(deployment.pool).factory(), deployment.factory);
        assertEq(IBaseForkUniswapPool(deployment.pool).fee(), deployment.poolFee);
        address token0 = IBaseForkUniswapPool(deployment.pool).token0();
        address token1 = IBaseForkUniswapPool(deployment.pool).token1();
        assertTrue(
            (token0 == address(deployment.baseToken) && token1 == address(deployment.quoteToken))
                || (token0 == address(deployment.quoteToken) && token1 == address(deployment.baseToken))
        );
        assertEq(IERC20Metadata(address(deployment.baseToken)).decimals(), deployment.baseTokenDecimals);
        assertEq(IERC20Metadata(address(deployment.quoteToken)).decimals(), deployment.quoteTokenDecimals);
    }

    function _requiredAddress(string memory name) private view returns (address value) {
        value = vm.envAddress(name);
        require(value != address(0), "required fork address is zero");
    }

    function _requiredHash(string memory name) private view returns (bytes32 value) {
        value = vm.envBytes32(name);
        require(value != bytes32(0), "required fork code hash is zero");
    }
}
