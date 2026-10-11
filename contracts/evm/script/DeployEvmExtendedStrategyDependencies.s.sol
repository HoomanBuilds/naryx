// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "openzeppelin-contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "openzeppelin-contracts/utils/math/Math.sol";
import {AaveV3TypedLendingAdapterFactory} from "../src/AaveV3TypedLendingAdapterFactory.sol";
import {NaryxMultiStrategyAccountFactory} from "../src/NaryxMultiStrategyAccountFactory.sol";
import {UniswapV3TypedSpotAdapterFactory} from "../src/UniswapV3TypedSpotAdapterFactory.sol";
import {INaryxMultiStrategyAccountFactory} from "../src/interfaces/INaryxMultiStrategyAccountFactory.sol";
import {NaryxTestLendingPool, INaryxTestMintableToken} from "../src/conformance/NaryxTestLendingPool.sol";
import {TestnetChains} from "./TestnetChains.sol";

interface IExtendedStrategyFactory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
}

interface IExtendedStrategyPool {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
    function tickSpacing() external view returns (int24);
    function initialize(uint160 sqrtPriceX96) external;
}

interface IExtendedStrategyPositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function factory() external view returns (address);
    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
}

interface IExtendedStrategyMintableToken is IERC20 {
    function mint(address recipient, uint256 amount) external;
}

contract DeployEvmExtendedStrategyDependencies is Script {
    uint160 private constant MIN_SQRT_RATIO = 4_295_128_739;
    uint160 private constant MAX_SQRT_RATIO = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342;
    int24 private constant MAX_TICK = 887_272;

    struct Parameters {
        uint256 expectedChainId;
        NaryxMultiStrategyAccountFactory accountFactory;
        IExtendedStrategyFactory uniswapFactory;
        IExtendedStrategyPositionManager positionManager;
        IERC20 baseAsset;
        IERC20 quoteAsset;
        uint24 poolFee;
        uint256 quoteAtomsPerWholeBase;
        int24 halfWidthTicks;
        uint256 baseLiquidityAtoms;
        uint256 quoteLiquidityAtoms;
        address liquidityRecipient;
        uint16 reverseLoanToValueBps;
        uint16 reverseLiquidationThresholdBps;
    }

    struct Deployment {
        address spotPool;
        uint256 liquidityTokenId;
        uint128 liquidity;
        UniswapV3TypedSpotAdapterFactory spotFactory;
        NaryxTestLendingPool reverseLendingPool;
        AaveV3TypedLendingAdapterFactory reverseLendingFactory;
    }

    error InvalidChain();
    error InvalidConfiguration();
    error PoolAlreadyInitialized();

    function run(Parameters calldata parameters) external returns (Deployment memory deployment) {
        if (
            parameters.expectedChainId == 0 || block.chainid != parameters.expectedChainId
                || !TestnetChains.isAllowed(block.chainid)
        ) revert InvalidChain();
        _validate(parameters);

        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        address pool = parameters.uniswapFactory.getPool(
            address(parameters.baseAsset), address(parameters.quoteAsset), parameters.poolFee
        );
        if (pool == address(0)) {
            pool = parameters.uniswapFactory.createPool(
                address(parameters.baseAsset), address(parameters.quoteAsset), parameters.poolFee
            );
        }
        (uint160 currentSqrtPriceX96,,,,,,) = IExtendedStrategyPool(pool).slot0();
        if (currentSqrtPriceX96 != 0) revert PoolAlreadyInitialized();
        IExtendedStrategyPool(pool).initialize(_sqrtPrice(parameters));
        _fund(parameters, sender);
        (deployment.liquidityTokenId, deployment.liquidity,,) = _mintPosition(parameters, pool);
        deployment.spotPool = pool;

        bytes32 accountFactoryCodeHash = address(parameters.accountFactory).codehash;
        bytes32 strategyAccountCodeHash = parameters.accountFactory.accountCodeHash();
        deployment.spotFactory = new UniswapV3TypedSpotAdapterFactory(
            UniswapV3TypedSpotAdapterFactory.Deployment({
                chainId: block.chainid,
                accountFactory: INaryxMultiStrategyAccountFactory(address(parameters.accountFactory)),
                factory: address(parameters.uniswapFactory),
                pool: pool,
                baseToken: parameters.baseAsset,
                quoteToken: parameters.quoteAsset,
                baseTokenDecimals: IERC20Metadata(address(parameters.baseAsset)).decimals(),
                quoteTokenDecimals: IERC20Metadata(address(parameters.quoteAsset)).decimals(),
                poolFee: parameters.poolFee,
                accountFactoryCodeHash: accountFactoryCodeHash,
                strategyAccountCodeHash: strategyAccountCodeHash,
                factoryCodeHash: address(parameters.uniswapFactory).codehash,
                poolCodeHash: pool.codehash,
                baseTokenCodeHash: address(parameters.baseAsset).codehash,
                quoteTokenCodeHash: address(parameters.quoteAsset).codehash
            })
        );

        uint256 reverseCollateralPrice = Math.mulDiv(
            10 ** IERC20Metadata(address(parameters.baseAsset)).decimals(),
            10 ** IERC20Metadata(address(parameters.quoteAsset)).decimals(),
            parameters.quoteAtomsPerWholeBase
        );
        deployment.reverseLendingPool = new NaryxTestLendingPool(
            parameters.quoteAsset,
            INaryxTestMintableToken(address(parameters.baseAsset)),
            reverseCollateralPrice,
            parameters.reverseLoanToValueBps,
            parameters.reverseLiquidationThresholdBps
        );
        deployment.reverseLendingFactory = new AaveV3TypedLendingAdapterFactory(
            AaveV3TypedLendingAdapterFactory.Deployment({
                chainId: block.chainid,
                accountFactory: INaryxMultiStrategyAccountFactory(address(parameters.accountFactory)),
                pool: deployment.reverseLendingPool,
                collateralToken: parameters.quoteAsset,
                debtToken: parameters.baseAsset,
                accountFactoryCodeHash: accountFactoryCodeHash,
                strategyAccountCodeHash: strategyAccountCodeHash,
                poolCodeHash: address(deployment.reverseLendingPool).codehash,
                collateralTokenCodeHash: address(parameters.quoteAsset).codehash,
                debtTokenCodeHash: address(parameters.baseAsset).codehash
            })
        );
        vm.stopBroadcast();
    }

    function _validate(Parameters calldata parameters) private view {
        if (
            address(parameters.accountFactory).code.length == 0
                || address(parameters.uniswapFactory).code.length == 0
                || address(parameters.positionManager).code.length == 0
                || parameters.positionManager.factory() != address(parameters.uniswapFactory)
                || address(parameters.baseAsset).code.length == 0 || address(parameters.quoteAsset).code.length == 0
                || address(parameters.baseAsset) == address(parameters.quoteAsset) || parameters.poolFee == 0
                || parameters.quoteAtomsPerWholeBase == 0 || parameters.halfWidthTicks <= 0
                || parameters.halfWidthTicks > MAX_TICK || parameters.baseLiquidityAtoms == 0
                || parameters.quoteLiquidityAtoms == 0 || parameters.liquidityRecipient == address(0)
                || parameters.reverseLoanToValueBps == 0
                || parameters.reverseLoanToValueBps >= parameters.reverseLiquidationThresholdBps
                || parameters.reverseLiquidationThresholdBps > 10_000
        ) revert InvalidConfiguration();
    }

    function _fund(Parameters calldata parameters, address sender) private {
        uint256 baseBalance = parameters.baseAsset.balanceOf(sender);
        if (baseBalance < parameters.baseLiquidityAtoms) {
            IExtendedStrategyMintableToken(address(parameters.baseAsset))
                .mint(sender, parameters.baseLiquidityAtoms - baseBalance);
        }
        uint256 quoteBalance = parameters.quoteAsset.balanceOf(sender);
        if (quoteBalance < parameters.quoteLiquidityAtoms) {
            IExtendedStrategyMintableToken(address(parameters.quoteAsset))
                .mint(sender, parameters.quoteLiquidityAtoms - quoteBalance);
        }
        parameters.baseAsset.approve(address(parameters.positionManager), parameters.baseLiquidityAtoms);
        parameters.quoteAsset.approve(address(parameters.positionManager), parameters.quoteLiquidityAtoms);
    }

    function _mintPosition(Parameters calldata parameters, address pool)
        private
        returns (uint256 tokenId, uint128 liquidity, uint256, uint256)
    {
        (, int24 tick,,,,,) = IExtendedStrategyPool(pool).slot0();
        int24 spacing = IExtendedStrategyPool(pool).tickSpacing();
        (int24 lower, int24 upper) = _range(tick, parameters.halfWidthTicks, spacing);
        bool baseIsToken0 = address(parameters.baseAsset) < address(parameters.quoteAsset);
        return parameters.positionManager.mint(
            IExtendedStrategyPositionManager.MintParams({
                token0: baseIsToken0 ? address(parameters.baseAsset) : address(parameters.quoteAsset),
                token1: baseIsToken0 ? address(parameters.quoteAsset) : address(parameters.baseAsset),
                fee: parameters.poolFee,
                tickLower: lower,
                tickUpper: upper,
                amount0Desired: baseIsToken0 ? parameters.baseLiquidityAtoms : parameters.quoteLiquidityAtoms,
                amount1Desired: baseIsToken0 ? parameters.quoteLiquidityAtoms : parameters.baseLiquidityAtoms,
                amount0Min: 0,
                amount1Min: 0,
                recipient: parameters.liquidityRecipient,
                deadline: block.timestamp + 1 hours
            })
        );
    }

    function _sqrtPrice(Parameters calldata parameters) private view returns (uint160) {
        uint256 baseUnit = 10 ** IERC20Metadata(address(parameters.baseAsset)).decimals();
        bool baseIsToken0 = address(parameters.baseAsset) < address(parameters.quoteAsset);
        uint256 priceX192 = baseIsToken0
            ? Math.mulDiv(parameters.quoteAtomsPerWholeBase, uint256(1) << 192, baseUnit)
            : Math.mulDiv(baseUnit, uint256(1) << 192, parameters.quoteAtomsPerWholeBase);
        uint256 value = Math.sqrt(priceX192);
        if (value <= MIN_SQRT_RATIO || value >= MAX_SQRT_RATIO) revert InvalidConfiguration();
        return uint160(value);
    }

    function _range(int24 tick, int24 halfWidth, int24 spacing) private pure returns (int24 lower, int24 upper) {
        int24 maxUsable = (MAX_TICK / spacing) * spacing;
        lower = _floor(tick - halfWidth, spacing);
        upper = _floor(tick + halfWidth, spacing) + spacing;
        if (lower < -maxUsable) lower = -maxUsable;
        if (upper > maxUsable) upper = maxUsable;
        if (lower >= upper) revert InvalidConfiguration();
    }

    function _floor(int24 tick, int24 spacing) private pure returns (int24) {
        int24 compressed = tick / spacing;
        if (tick < 0 && tick % spacing != 0) compressed--;
        return compressed * spacing;
    }
}
