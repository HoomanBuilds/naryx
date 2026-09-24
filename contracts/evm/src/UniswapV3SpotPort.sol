// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "openzeppelin-contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/utils/ReentrancyGuard.sol";
import {IExactSpotPort} from "./interfaces/IExactSpotPort.sol";
import {ISpotFillRecorder} from "./interfaces/ISpotFillRecorder.sol";

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IUniswapV3Pool {
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

contract UniswapV3SpotPort is IExactSpotPort, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant ENTRY = 1;
    uint8 public constant EXIT = 2;

    uint160 private constant MIN_SQRT_RATIO_PLUS_ONE = 4_295_128_740;
    uint160 private constant MAX_SQRT_RATIO_MINUS_ONE =
        1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341;

    struct Deployment {
        uint256 chainId;
        address factory;
        address pool;
        IERC20 baseToken;
        IERC20 quoteToken;
        uint8 baseTokenDecimals;
        uint8 quoteTokenDecimals;
        uint24 poolFee;
        bytes32 factoryCodeHash;
        bytes32 poolCodeHash;
        bytes32 baseTokenCodeHash;
        bytes32 quoteTokenCodeHash;
    }

    error InvalidConfiguration();
    error InvalidQuantity();
    error DeploymentChanged();
    error InvalidCallback();
    error PostconditionFailed();

    address public immutable verifier;
    bytes32 public immutable verifierCodeHash;
    uint256 public immutable deploymentChainId;
    address public immutable factory;
    address public immutable pool;
    IERC20 public immutable baseToken;
    IERC20 public immutable quoteToken;
    uint8 public immutable baseTokenDecimals;
    uint8 public immutable quoteTokenDecimals;
    uint24 public immutable poolFee;
    bytes32 public immutable factoryCodeHash;
    bytes32 public immutable poolCodeHash;
    bytes32 public immutable baseTokenCodeHash;
    bytes32 public immutable quoteTokenCodeHash;
    bool public immutable quoteIsToken0;

    bytes32 private _callbackCommitment;

    constructor(address verifier_, Deployment memory deployment) {
        if (
            verifier_.code.length == 0 || deployment.chainId == 0 || deployment.factory == address(0)
                || deployment.pool == address(0) || address(deployment.baseToken) == address(0)
                || address(deployment.quoteToken) == address(0)
                || address(deployment.baseToken) == address(deployment.quoteToken) || deployment.poolFee == 0
                || verifier_ == deployment.factory || verifier_ == deployment.pool
                || verifier_ == address(deployment.baseToken) || verifier_ == address(deployment.quoteToken)
                || deployment.factoryCodeHash == bytes32(0) || deployment.poolCodeHash == bytes32(0)
                || deployment.baseTokenCodeHash == bytes32(0) || deployment.quoteTokenCodeHash == bytes32(0)
        ) revert InvalidConfiguration();

        verifier = verifier_;
        verifierCodeHash = verifier_.codehash;
        deploymentChainId = deployment.chainId;
        factory = deployment.factory;
        pool = deployment.pool;
        baseToken = deployment.baseToken;
        quoteToken = deployment.quoteToken;
        baseTokenDecimals = deployment.baseTokenDecimals;
        quoteTokenDecimals = deployment.quoteTokenDecimals;
        poolFee = deployment.poolFee;
        factoryCodeHash = deployment.factoryCodeHash;
        poolCodeHash = deployment.poolCodeHash;
        baseTokenCodeHash = deployment.baseTokenCodeHash;
        quoteTokenCodeHash = deployment.quoteTokenCodeHash;

        _assertDeployment();
        quoteIsToken0 = IUniswapV3Pool(deployment.pool).token0() == address(deployment.quoteToken);
    }

    function buyExactOutput(uint256 packageNonce, bytes32 spotFillCommitment, uint256 quantity, uint256 maxQuote)
        external
        nonReentrant
        returns (uint256 quoteIn)
    {
        if (quantity == 0 || quantity > uint256(type(int256).max) || maxQuote == 0) {
            revert InvalidQuantity();
        }
        _assertDeployment();

        uint256 portBaseBefore = baseToken.balanceOf(address(this));
        uint256 portQuoteBefore = quoteToken.balanceOf(address(this));
        uint256 strategyBaseBefore = baseToken.balanceOf(msg.sender);
        uint256 strategyQuoteBefore = quoteToken.balanceOf(msg.sender);

        quoteToken.safeTransferFrom(msg.sender, address(this), maxQuote);
        if (quoteToken.balanceOf(address(this)) != portQuoteBefore + maxQuote) revert PostconditionFailed();

        {
            bytes memory callbackData = abi.encode(msg.sender, packageNonce, spotFillCommitment, true, maxQuote);
            _callbackCommitment = keccak256(callbackData);
            bool zeroForOne = quoteIsToken0;
            (int256 amount0, int256 amount1) = IUniswapV3Pool(pool)
                .swap(
                    msg.sender,
                    zeroForOne,
                    -int256(quantity),
                    zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE,
                    callbackData
                );
            if (_callbackCommitment != bytes32(0)) revert PostconditionFailed();

            int256 quoteDelta = quoteIsToken0 ? amount0 : amount1;
            int256 baseDelta = quoteIsToken0 ? amount1 : amount0;
            if (quoteDelta <= 0 || baseDelta != -int256(quantity)) revert PostconditionFailed();
            quoteIn = uint256(quoteDelta);
            if (quoteIn > maxQuote) revert PostconditionFailed();
        }

        quoteToken.safeTransfer(msg.sender, maxQuote - quoteIn);
        if (
            baseToken.balanceOf(address(this)) != portBaseBefore
                || quoteToken.balanceOf(address(this)) != portQuoteBefore
                || baseToken.balanceOf(msg.sender) != strategyBaseBefore + quantity
                || quoteToken.balanceOf(msg.sender) != strategyQuoteBefore - quoteIn
        ) revert PostconditionFailed();
        _recordSpotFill(packageNonce, spotFillCommitment, ENTRY, quantity, quoteIn);
    }

    function sellExactInput(uint256 packageNonce, bytes32 spotFillCommitment, uint256 quantity, uint256 minQuote)
        external
        nonReentrant
        returns (uint256 quoteOut)
    {
        if (quantity == 0 || quantity > uint256(type(int256).max) || minQuote == 0) {
            revert InvalidQuantity();
        }
        _assertDeployment();

        uint256 portBaseBefore = baseToken.balanceOf(address(this));
        uint256 portQuoteBefore = quoteToken.balanceOf(address(this));
        uint256 strategyBaseBefore = baseToken.balanceOf(msg.sender);
        uint256 strategyQuoteBefore = quoteToken.balanceOf(msg.sender);

        baseToken.safeTransferFrom(msg.sender, address(this), quantity);
        if (baseToken.balanceOf(address(this)) != portBaseBefore + quantity) revert PostconditionFailed();

        {
            bytes memory callbackData = abi.encode(msg.sender, packageNonce, spotFillCommitment, false, quantity);
            _callbackCommitment = keccak256(callbackData);
            bool zeroForOne = !quoteIsToken0;
            (int256 amount0, int256 amount1) = IUniswapV3Pool(pool)
                .swap(
                    msg.sender,
                    zeroForOne,
                    int256(quantity),
                    zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE,
                    callbackData
                );
            if (_callbackCommitment != bytes32(0)) revert PostconditionFailed();

            int256 quoteDelta = quoteIsToken0 ? amount0 : amount1;
            int256 baseDelta = quoteIsToken0 ? amount1 : amount0;
            if (quoteDelta >= 0 || quoteDelta == type(int256).min || baseDelta != int256(quantity)) {
                revert PostconditionFailed();
            }
            quoteOut = uint256(-quoteDelta);
            if (quoteOut < minQuote) revert PostconditionFailed();
        }

        if (
            baseToken.balanceOf(address(this)) != portBaseBefore
                || quoteToken.balanceOf(address(this)) != portQuoteBefore
                || baseToken.balanceOf(msg.sender) != strategyBaseBefore - quantity
                || quoteToken.balanceOf(msg.sender) != strategyQuoteBefore + quoteOut
        ) revert PostconditionFailed();
        _recordSpotFill(packageNonce, spotFillCommitment, EXIT, quantity, quoteOut);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        bytes32 commitment = _callbackCommitment;
        if (msg.sender != pool || commitment == bytes32(0) || keccak256(data) != commitment) {
            revert InvalidCallback();
        }
        _callbackCommitment = bytes32(0);

        (,,, bool quoteOwed, uint256 maxOwed) = abi.decode(data, (address, uint256, bytes32, bool, uint256));
        int256 owedDelta = quoteOwed == quoteIsToken0 ? amount0Delta : amount1Delta;
        int256 outputDelta = quoteOwed == quoteIsToken0 ? amount1Delta : amount0Delta;
        if (owedDelta <= 0 || outputDelta >= 0 || uint256(owedDelta) > maxOwed) revert InvalidCallback();

        IERC20 owedToken = quoteOwed ? quoteToken : baseToken;
        owedToken.safeTransfer(pool, uint256(owedDelta));
    }

    function assertDeployment() external view {
        _assertDeployment();
    }

    function _recordSpotFill(
        uint256 packageNonce,
        bytes32 spotFillCommitment,
        uint8 action,
        uint256 baseAtoms,
        uint256 quoteAtoms
    ) private {
        ISpotFillRecorder(verifier)
            .recordSpotFill(
                msg.sender,
                packageNonce,
                spotFillCommitment,
                action,
                address(baseToken),
                address(quoteToken),
                baseAtoms,
                quoteAtoms
            );
    }

    function _assertDeployment() private view {
        if (
            block.chainid != deploymentChainId || verifier.codehash != verifierCodeHash
                || factory.codehash != factoryCodeHash || pool.codehash != poolCodeHash
                || address(baseToken).codehash != baseTokenCodeHash
                || address(quoteToken).codehash != quoteTokenCodeHash
                || IERC20Metadata(address(baseToken)).decimals() != baseTokenDecimals
                || IERC20Metadata(address(quoteToken)).decimals() != quoteTokenDecimals
        ) revert DeploymentChanged();

        address token0 = IUniswapV3Pool(pool).token0();
        address token1 = IUniswapV3Pool(pool).token1();
        bool tokensMatch = (token0 == address(quoteToken) && token1 == address(baseToken))
            || (token0 == address(baseToken) && token1 == address(quoteToken));
        if (
            IUniswapV3Pool(pool).factory() != factory
                || IUniswapV3Factory(factory).getPool(address(baseToken), address(quoteToken), poolFee) != pool
                || !tokensMatch || IUniswapV3Pool(pool).fee() != poolFee
        ) revert DeploymentChanged();
    }
}
