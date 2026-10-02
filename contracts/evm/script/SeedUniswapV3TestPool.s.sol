// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "openzeppelin-contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "openzeppelin-contracts/utils/math/Math.sol";
import {AggregatorV3Interface} from "../src/interfaces/IAggregatorV3.sol";

interface ISeedUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
}

interface ISeedUniswapV3Pool {
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
    function liquidity() external view returns (uint128);
    function initialize(uint160 sqrtPriceX96) external;
}

interface ISeedPositionManager {
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
    // forge-lint: disable-next-line(mixed-case-function)
    function WETH9() external view returns (address);
    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
}

interface ISeedWrappedNative {
    function deposit() external payable;
}

/// @notice The public faucet of Naryx Test USDC and of the GMX Arbitrum Sepolia test tokens.
interface ISeedMintableTestToken {
    function mint(address recipient, uint256 amount) external;
}

/// @notice Gives a Uniswap V3 wrapped-native / test-quote pool real depth at the live oracle price, so the package
/// spot leg trades against the canonical Uniswap V3 contracts the way it does on mainnet. It creates the pool at the
/// oracle price when the fee tier has none, refuses a pool that already trades away from the oracle (an empty
/// mispriced pool cannot be moved without a swap helper; choose another fee tier), wraps native gas into the base
/// token and mints the test quote the position needs, then adds one concentrated position around the current tick.
/// Testnet only; nothing is sent unless the operator runs it with `--broadcast`.
contract SeedUniswapV3TestPool is Script {
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84_532;
    uint256 public constant ARBITRUM_SEPOLIA_CHAIN_ID = 421_614;
    address public constant BASE_SEPOLIA_POSITION_MANAGER = 0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2;
    address public constant ARBITRUM_SEPOLIA_POSITION_MANAGER = 0x6b2937Bde17889EDCf8fbD8dE31C3C2a70Bc4d65;

    uint160 private constant MIN_SQRT_RATIO = 4_295_128_739;
    uint160 private constant MAX_SQRT_RATIO = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342;
    int24 private constant MAX_TICK = 887_272;
    uint256 private constant BPS = 10_000;

    struct Parameters {
        /// Test quote token with a public `mint(address,uint256)`: Naryx Test USDC or the GMX test USDC.
        address quoteToken;
        uint24 fee;
        /// Base asset / USD reference. The pool is created at this price, or must already trade near it.
        AggregatorV3Interface oracle;
        uint32 maxOracleAgeSeconds;
        uint16 maxPoolDeviationBps;
        /// The position spans this many ticks on each side of the current tick, widened to the pool spacing.
        int24 halfWidthTicks;
        /// Wrapped from the sender's native balance when its wrapped balance is short.
        uint256 baseAmount;
        /// Minted to the sender through the token faucet when its balance is short.
        uint256 quoteAmount;
        address liquidityRecipient;
    }

    struct Seeded {
        address pool;
        bool created;
        uint160 sqrtPriceX96;
        int24 tickLower;
        int24 tickUpper;
        uint256 tokenId;
        uint128 liquidity;
        uint256 baseUsed;
        uint256 quoteUsed;
    }

    error InvalidChain();
    error InvalidParameters();
    error StaleOracle(uint256 updatedAt);
    error PoolPriceOffOracle(address pool, uint256 poolToOracleBps);

    function run(Parameters calldata parameters) external returns (Seeded memory seeded) {
        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        seeded = seed(parameters, sender);
        vm.stopBroadcast();
    }

    /// @notice Seeds the pool with calls sent from `sender`, which pays the native gas token and receives the mint.
    function seed(Parameters calldata parameters, address sender) public returns (Seeded memory seeded) {
        if (
            parameters.quoteToken == address(0) || parameters.liquidityRecipient == address(0)
                || parameters.maxPoolDeviationBps == 0 || parameters.maxPoolDeviationBps >= BPS
                || parameters.halfWidthTicks <= 0 || parameters.halfWidthTicks > MAX_TICK || parameters.baseAmount == 0
                || parameters.quoteAmount == 0
        ) revert InvalidParameters();
        ISeedPositionManager positionManager = _positionManager();
        address base = positionManager.WETH9();
        _price(parameters, positionManager, base, seeded);
        _fund(parameters, address(positionManager), base, sender);
        _mintPosition(parameters, positionManager, base, seeded);
    }

    /// @dev Creates the pool at the oracle price, or requires the existing pool to trade near it, then sets the range.
    function _price(
        Parameters calldata parameters,
        ISeedPositionManager positionManager,
        address base,
        Seeded memory seeded
    ) private {
        ISeedUniswapV3Factory factory = ISeedUniswapV3Factory(positionManager.factory());
        seeded.pool = factory.getPool(base, parameters.quoteToken, parameters.fee);
        if (seeded.pool == address(0)) {
            seeded.pool = factory.createPool(base, parameters.quoteToken, parameters.fee);
            seeded.created = true;
        }
        ISeedUniswapV3Pool pool = ISeedUniswapV3Pool(seeded.pool);
        uint160 oracleSqrtPriceX96 = _oracleSqrtPriceX96(parameters, base, base < parameters.quoteToken);
        (uint160 poolSqrtPriceX96,,,,,,) = pool.slot0();
        if (poolSqrtPriceX96 == 0) {
            pool.initialize(oracleSqrtPriceX96);
        } else {
            uint256 ratioBps = Math.mulDiv(
                Math.mulDiv(poolSqrtPriceX96, poolSqrtPriceX96, oracleSqrtPriceX96), BPS, oracleSqrtPriceX96
            );
            if (ratioBps + parameters.maxPoolDeviationBps < BPS || ratioBps > BPS + parameters.maxPoolDeviationBps) {
                revert PoolPriceOffOracle(seeded.pool, ratioBps);
            }
        }
        int24 tick;
        (seeded.sqrtPriceX96, tick,,,,,) = pool.slot0();
        (seeded.tickLower, seeded.tickUpper) = _range(tick, parameters.halfWidthTicks, pool.tickSpacing());
    }

    /// @dev Wraps native gas and mints test quote up to the requested amounts, then approves the position manager.
    function _fund(Parameters calldata parameters, address positionManager, address base, address sender) private {
        uint256 wrapped = IERC20(base).balanceOf(sender);
        if (wrapped < parameters.baseAmount) {
            ISeedWrappedNative(base).deposit{value: parameters.baseAmount - wrapped}();
        }
        uint256 held = IERC20(parameters.quoteToken).balanceOf(sender);
        if (held < parameters.quoteAmount) {
            ISeedMintableTestToken(parameters.quoteToken).mint(sender, parameters.quoteAmount - held);
        }
        IERC20(base).approve(positionManager, parameters.baseAmount);
        IERC20(parameters.quoteToken).approve(positionManager, parameters.quoteAmount);
    }

    function _mintPosition(
        Parameters calldata parameters,
        ISeedPositionManager positionManager,
        address base,
        Seeded memory seeded
    ) private {
        bool baseIsToken0 = base < parameters.quoteToken;
        uint256 amount0;
        uint256 amount1;
        (seeded.tokenId, seeded.liquidity, amount0, amount1) = positionManager.mint(
            ISeedPositionManager.MintParams({
                token0: baseIsToken0 ? base : parameters.quoteToken,
                token1: baseIsToken0 ? parameters.quoteToken : base,
                fee: parameters.fee,
                tickLower: seeded.tickLower,
                tickUpper: seeded.tickUpper,
                amount0Desired: baseIsToken0 ? parameters.baseAmount : parameters.quoteAmount,
                amount1Desired: baseIsToken0 ? parameters.quoteAmount : parameters.baseAmount,
                // The price was checked against the oracle above; test liquidity carries no value to protect.
                amount0Min: 0,
                amount1Min: 0,
                recipient: parameters.liquidityRecipient,
                deadline: block.timestamp + 1 hours
            })
        );
        (seeded.baseUsed, seeded.quoteUsed) = baseIsToken0 ? (amount0, amount1) : (amount1, amount0);
    }

    function _positionManager() private view returns (ISeedPositionManager) {
        if (block.chainid == BASE_SEPOLIA_CHAIN_ID) return ISeedPositionManager(BASE_SEPOLIA_POSITION_MANAGER);
        if (block.chainid == ARBITRUM_SEPOLIA_CHAIN_ID) return ISeedPositionManager(ARBITRUM_SEPOLIA_POSITION_MANAGER);
        revert InvalidChain();
    }

    /// @dev sqrt(token1 atoms per token0 atom) in Q64.96, from a base/USD feed and a quote token worth one USD.
    function _oracleSqrtPriceX96(Parameters calldata parameters, address base, bool baseIsToken0)
        private
        view
        returns (uint160)
    {
        (, int256 answer,, uint256 updatedAt,) = parameters.oracle.latestRoundData();
        if (answer <= 0) revert InvalidParameters();
        if (
            updatedAt == 0 || updatedAt > block.timestamp
                || block.timestamp - updatedAt > parameters.maxOracleAgeSeconds
        ) {
            revert StaleOracle(updatedAt);
        }
        uint256 quoteDecimals = IERC20Metadata(parameters.quoteToken).decimals();
        uint256 baseDecimals = IERC20Metadata(base).decimals();
        uint256 feedDecimals = parameters.oracle.decimals();
        if (quoteDecimals > 18 || baseDecimals > 18 || feedDecimals > 18) revert InvalidParameters();
        // Quote atoms per whole base unit, scaled by the feed's decimals, over base atoms per whole unit at that scale.
        uint256 quoteScaled = uint256(answer) * 10 ** quoteDecimals;
        uint256 baseScaled = 10 ** (feedDecimals + baseDecimals);
        uint256 priceX192 = baseIsToken0
            ? Math.mulDiv(quoteScaled, uint256(1) << 192, baseScaled)
            : Math.mulDiv(baseScaled, uint256(1) << 192, quoteScaled);
        uint256 sqrtPriceX96 = Math.sqrt(priceX192);
        if (sqrtPriceX96 <= MIN_SQRT_RATIO || sqrtPriceX96 >= MAX_SQRT_RATIO) revert InvalidParameters();
        return uint160(sqrtPriceX96);
    }

    function _range(int24 tick, int24 halfWidth, int24 spacing) private pure returns (int24 lower, int24 upper) {
        int24 maxUsable = (MAX_TICK / spacing) * spacing;
        lower = _floor(tick - halfWidth, spacing);
        upper = _floor(tick + halfWidth, spacing) + spacing;
        if (lower < -maxUsable) lower = -maxUsable;
        if (upper > maxUsable) upper = maxUsable;
        if (lower >= upper) revert InvalidParameters();
    }

    function _floor(int24 tick, int24 spacing) private pure returns (int24) {
        int24 compressed = tick / spacing;
        if (tick < 0 && tick % spacing != 0) compressed--;
        return compressed * spacing;
    }
}
