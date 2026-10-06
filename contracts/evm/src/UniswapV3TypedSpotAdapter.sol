// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "openzeppelin-contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/utils/ReentrancyGuard.sol";
import {ITypedStrategyAdapter} from "./interfaces/ITypedStrategyAdapter.sol";

interface ITypedUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface ITypedUniswapV3Pool {
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

contract UniswapV3TypedSpotAdapter is ITypedStrategyAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant BUY_EXACT_OUTPUT = 1;
    uint8 public constant SELL_EXACT_INPUT = 2;
    bytes32 public constant ADAPTER_CLASS_ID = keccak256("naryx.evm.spot-exact");
    uint32 public constant ADAPTER_CLASS_VERSION = 1;

    uint160 private constant MIN_SQRT_RATIO_PLUS_ONE = 4_295_128_740;
    uint160 private constant MAX_SQRT_RATIO_MINUS_ONE =
        1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341;

    struct Deployment {
        uint256 chainId;
        address strategyAccount;
        bytes32 packageId;
        address factory;
        address pool;
        IERC20 baseToken;
        IERC20 quoteToken;
        uint8 baseTokenDecimals;
        uint8 quoteTokenDecimals;
        uint24 poolFee;
        bytes32 strategyAccountCodeHash;
        bytes32 factoryCodeHash;
        bytes32 poolCodeHash;
        bytes32 baseTokenCodeHash;
        bytes32 quoteTokenCodeHash;
    }

    struct ExactSpotLeg {
        bytes32 packageId;
        bytes32 orderHash;
        bytes32 quoteHash;
        bytes32 routeHash;
        uint8 action;
        uint256 baseAtoms;
        uint256 quoteBoundAtoms;
    }

    error InvalidConfiguration();
    error UnauthorizedCaller();
    error InvalidLeg();
    error DeploymentChanged();
    error InvalidCallback();
    error PostconditionFailed();

    address public immutable strategyAccount;
    bytes32 public immutable packageId;
    uint256 public immutable deploymentChainId;
    address public immutable factory;
    address public immutable pool;
    IERC20 public immutable baseToken;
    IERC20 public immutable quoteToken;
    uint8 public immutable baseTokenDecimals;
    uint8 public immutable quoteTokenDecimals;
    uint24 public immutable poolFee;
    bytes32 public immutable strategyAccountCodeHash;
    bytes32 public immutable factoryCodeHash;
    bytes32 public immutable poolCodeHash;
    bytes32 public immutable baseTokenCodeHash;
    bytes32 public immutable quoteTokenCodeHash;
    bool public immutable quoteIsToken0;

    bytes32 private _callbackCommitment;

    constructor(Deployment memory deployment) {
        if (
            deployment.chainId == 0 || deployment.strategyAccount.code.length == 0 || deployment.packageId == bytes32(0)
                || deployment.factory == address(0) || deployment.pool == address(0)
                || address(deployment.baseToken) == address(0) || address(deployment.quoteToken) == address(0)
                || address(deployment.baseToken) == address(deployment.quoteToken) || deployment.poolFee == 0
                || deployment.strategyAccountCodeHash == bytes32(0) || deployment.factoryCodeHash == bytes32(0)
                || deployment.poolCodeHash == bytes32(0) || deployment.baseTokenCodeHash == bytes32(0)
                || deployment.quoteTokenCodeHash == bytes32(0)
        ) revert InvalidConfiguration();

        strategyAccount = deployment.strategyAccount;
        packageId = deployment.packageId;
        deploymentChainId = deployment.chainId;
        factory = deployment.factory;
        pool = deployment.pool;
        baseToken = deployment.baseToken;
        quoteToken = deployment.quoteToken;
        baseTokenDecimals = deployment.baseTokenDecimals;
        quoteTokenDecimals = deployment.quoteTokenDecimals;
        poolFee = deployment.poolFee;
        strategyAccountCodeHash = deployment.strategyAccountCodeHash;
        factoryCodeHash = deployment.factoryCodeHash;
        poolCodeHash = deployment.poolCodeHash;
        baseTokenCodeHash = deployment.baseTokenCodeHash;
        quoteTokenCodeHash = deployment.quoteTokenCodeHash;

        _assertDeployment();
        quoteIsToken0 = ITypedUniswapV3Pool(deployment.pool).token0() == address(deployment.quoteToken);
    }

    function adapterMetadata() external view returns (address, bytes32, uint32, address, address) {
        return (strategyAccount, ADAPTER_CLASS_ID, ADAPTER_CLASS_VERSION, address(baseToken), address(quoteToken));
    }

    function executeLeg(bytes calldata payload) external nonReentrant returns (bytes32 evidenceHash) {
        if (msg.sender != strategyAccount) revert UnauthorizedCaller();
        ExactSpotLeg memory leg = abi.decode(payload, (ExactSpotLeg));
        if (
            leg.packageId != packageId || leg.orderHash == bytes32(0) || leg.quoteHash == bytes32(0)
                || leg.routeHash == bytes32(0) || leg.baseAtoms == 0 || leg.baseAtoms > uint256(type(int256).max)
                || leg.quoteBoundAtoms == 0 || (leg.action != BUY_EXACT_OUTPUT && leg.action != SELL_EXACT_INPUT)
        ) revert InvalidLeg();
        _assertDeployment();

        uint256 quoteAtoms = leg.action == BUY_EXACT_OUTPUT ? _buy(leg) : _sell(leg);
        evidenceHash = keccak256(
            abi.encode(
                address(this),
                deploymentChainId,
                leg.packageId,
                leg.orderHash,
                leg.quoteHash,
                leg.routeHash,
                leg.action,
                leg.baseAtoms,
                quoteAtoms
            )
        );
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        bytes32 commitment = _callbackCommitment;
        if (msg.sender != pool || commitment == bytes32(0) || keccak256(data) != commitment) {
            revert InvalidCallback();
        }
        _callbackCommitment = bytes32(0);

        (bool quoteOwed, uint256 maximumOwed) = abi.decode(data, (bool, uint256));
        int256 owedDelta = quoteOwed == quoteIsToken0 ? amount0Delta : amount1Delta;
        int256 outputDelta = quoteOwed == quoteIsToken0 ? amount1Delta : amount0Delta;
        if (owedDelta <= 0 || outputDelta >= 0 || uint256(owedDelta) > maximumOwed) revert InvalidCallback();
        (quoteOwed ? quoteToken : baseToken).safeTransfer(pool, uint256(owedDelta));
    }

    function assertDeployment() external view {
        _assertDeployment();
    }

    function _buy(ExactSpotLeg memory leg) private returns (uint256 quoteIn) {
        if (quoteToken.allowance(strategyAccount, address(this)) != leg.quoteBoundAtoms) revert InvalidLeg();
        uint256 adapterBaseBefore = baseToken.balanceOf(address(this));
        uint256 adapterQuoteBefore = quoteToken.balanceOf(address(this));
        uint256 accountBaseBefore = baseToken.balanceOf(strategyAccount);
        uint256 accountQuoteBefore = quoteToken.balanceOf(strategyAccount);

        quoteToken.safeTransferFrom(strategyAccount, address(this), leg.quoteBoundAtoms);
        if (quoteToken.balanceOf(address(this)) != adapterQuoteBefore + leg.quoteBoundAtoms) {
            revert PostconditionFailed();
        }

        bytes memory callbackData = abi.encode(true, leg.quoteBoundAtoms);
        _callbackCommitment = keccak256(callbackData);
        bool zeroForOne = quoteIsToken0;
        (int256 amount0, int256 amount1) = ITypedUniswapV3Pool(pool)
            .swap(
                strategyAccount,
                zeroForOne,
                -int256(leg.baseAtoms),
                zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE,
                callbackData
            );
        if (_callbackCommitment != bytes32(0)) revert PostconditionFailed();
        int256 quoteDelta = quoteIsToken0 ? amount0 : amount1;
        int256 baseDelta = quoteIsToken0 ? amount1 : amount0;
        if (quoteDelta <= 0 || baseDelta != -int256(leg.baseAtoms)) revert PostconditionFailed();
        quoteIn = uint256(quoteDelta);
        if (quoteIn > leg.quoteBoundAtoms) revert PostconditionFailed();

        quoteToken.safeTransfer(strategyAccount, leg.quoteBoundAtoms - quoteIn);
        if (
            baseToken.balanceOf(address(this)) != adapterBaseBefore
                || quoteToken.balanceOf(address(this)) != adapterQuoteBefore
                || baseToken.balanceOf(strategyAccount) != accountBaseBefore + leg.baseAtoms
                || quoteToken.balanceOf(strategyAccount) != accountQuoteBefore - quoteIn
        ) revert PostconditionFailed();
    }

    function _sell(ExactSpotLeg memory leg) private returns (uint256 quoteOut) {
        if (baseToken.allowance(strategyAccount, address(this)) != leg.baseAtoms) revert InvalidLeg();
        uint256 adapterBaseBefore = baseToken.balanceOf(address(this));
        uint256 adapterQuoteBefore = quoteToken.balanceOf(address(this));
        uint256 accountBaseBefore = baseToken.balanceOf(strategyAccount);
        uint256 accountQuoteBefore = quoteToken.balanceOf(strategyAccount);

        baseToken.safeTransferFrom(strategyAccount, address(this), leg.baseAtoms);
        if (baseToken.balanceOf(address(this)) != adapterBaseBefore + leg.baseAtoms) revert PostconditionFailed();

        bytes memory callbackData = abi.encode(false, leg.baseAtoms);
        _callbackCommitment = keccak256(callbackData);
        bool zeroForOne = !quoteIsToken0;
        (int256 amount0, int256 amount1) = ITypedUniswapV3Pool(pool)
            .swap(
                strategyAccount,
                zeroForOne,
                int256(leg.baseAtoms),
                zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE,
                callbackData
            );
        if (_callbackCommitment != bytes32(0)) revert PostconditionFailed();
        int256 quoteDelta = quoteIsToken0 ? amount0 : amount1;
        int256 baseDelta = quoteIsToken0 ? amount1 : amount0;
        if (quoteDelta >= 0 || quoteDelta == type(int256).min || baseDelta != int256(leg.baseAtoms)) {
            revert PostconditionFailed();
        }
        quoteOut = uint256(-quoteDelta);
        if (quoteOut < leg.quoteBoundAtoms) revert PostconditionFailed();

        if (
            baseToken.balanceOf(address(this)) != adapterBaseBefore
                || quoteToken.balanceOf(address(this)) != adapterQuoteBefore
                || baseToken.balanceOf(strategyAccount) != accountBaseBefore - leg.baseAtoms
                || quoteToken.balanceOf(strategyAccount) != accountQuoteBefore + quoteOut
        ) revert PostconditionFailed();
    }

    function _assertDeployment() private view {
        if (
            block.chainid != deploymentChainId || strategyAccount.codehash != strategyAccountCodeHash
                || factory.codehash != factoryCodeHash || pool.codehash != poolCodeHash
                || address(baseToken).codehash != baseTokenCodeHash
                || address(quoteToken).codehash != quoteTokenCodeHash
                || IERC20Metadata(address(baseToken)).decimals() != baseTokenDecimals
                || IERC20Metadata(address(quoteToken)).decimals() != quoteTokenDecimals
        ) revert DeploymentChanged();

        address token0 = ITypedUniswapV3Pool(pool).token0();
        address token1 = ITypedUniswapV3Pool(pool).token1();
        bool tokensMatch = (token0 == address(quoteToken) && token1 == address(baseToken))
            || (token0 == address(baseToken) && token1 == address(quoteToken));
        if (
            ITypedUniswapV3Pool(pool).factory() != factory
                || ITypedUniswapV3Factory(factory).getPool(address(baseToken), address(quoteToken), poolFee) != pool
                || !tokensMatch || ITypedUniswapV3Pool(pool).fee() != poolFee
        ) revert DeploymentChanged();
    }
}
