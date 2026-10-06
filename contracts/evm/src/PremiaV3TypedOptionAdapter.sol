// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/utils/ReentrancyGuard.sol";
import {IPremiaV3Pool} from "./interfaces/IPremiaV3Pool.sol";
import {ITypedStrategyAdapter} from "./interfaces/ITypedStrategyAdapter.sol";

contract PremiaV3TypedOptionAdapter is ITypedStrategyAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant TRADE = 1;
    uint8 public constant EXERCISE = 2;
    uint8 public constant SETTLE_SHORT = 3;
    uint256 public constant SHORT_TOKEN_ID = 0;
    uint256 public constant LONG_TOKEN_ID = 1;
    bytes32 public constant ADAPTER_CLASS_ID = keccak256("naryx.evm.premia-v3-option-exact");
    uint32 public constant ADAPTER_CLASS_VERSION = 1;

    struct Deployment {
        uint256 chainId;
        address strategyAccount;
        bytes32 packageId;
        IPremiaV3Pool pool;
        IERC20 baseToken;
        IERC20 quoteToken;
        IERC20 poolToken;
        address oracleAdapter;
        uint256 strike;
        uint256 maturity;
        bool isCallPool;
        bytes32 strategyAccountCodeHash;
        bytes32 poolCodeHash;
        bytes32 baseTokenCodeHash;
        bytes32 quoteTokenCodeHash;
        bytes32 oracleAdapterCodeHash;
    }

    struct ExactOptionLeg {
        bytes32 packageId;
        bytes32 orderHash;
        bytes32 quoteHash;
        bytes32 routeHash;
        uint8 action;
        bool isBuy;
        uint256 size;
        uint256 premiumLimit;
        uint256 maximumInputAtoms;
        uint256 expectedPreLongs;
        uint256 expectedPreShorts;
        uint256 expectedPostLongs;
        uint256 expectedPostShorts;
        int256 minimumAccountTokenDelta;
        int256 maximumAccountTokenDelta;
    }

    struct ExecutionOutcome {
        uint256 primaryOutput;
        int256 secondaryOutput;
        uint256 preLongs;
        uint256 preShorts;
        uint256 postLongs;
        uint256 postShorts;
        int256 accountTokenDelta;
    }

    error InvalidConfiguration();
    error UnauthorizedCaller();
    error InvalidLeg();
    error DeploymentChanged();
    error PreconditionFailed();
    error PostconditionFailed();

    address public immutable strategyAccount;
    bytes32 public immutable packageId;
    uint256 public immutable deploymentChainId;
    IPremiaV3Pool public immutable pool;
    IERC20 public immutable baseToken;
    IERC20 public immutable quoteToken;
    IERC20 public immutable poolToken;
    address public immutable oracleAdapter;
    uint256 public immutable strike;
    uint256 public immutable maturity;
    bool public immutable isCallPool;
    bytes32 public immutable strategyAccountCodeHash;
    bytes32 public immutable poolCodeHash;
    bytes32 public immutable baseTokenCodeHash;
    bytes32 public immutable quoteTokenCodeHash;
    bytes32 public immutable oracleAdapterCodeHash;

    constructor(Deployment memory deployment) {
        if (
            deployment.chainId == 0 || deployment.strategyAccount.code.length == 0
                || deployment.packageId == bytes32(0) || address(deployment.pool).code.length == 0
                || address(deployment.baseToken).code.length == 0 || address(deployment.quoteToken).code.length == 0
                || address(deployment.baseToken) == address(deployment.quoteToken)
                || address(deployment.poolToken) != (deployment.isCallPool ? address(deployment.baseToken) : address(deployment.quoteToken))
                || deployment.oracleAdapter.code.length == 0 || deployment.strike == 0 || deployment.maturity == 0
                || deployment.strategyAccountCodeHash == bytes32(0) || deployment.poolCodeHash == bytes32(0)
                || deployment.baseTokenCodeHash == bytes32(0) || deployment.quoteTokenCodeHash == bytes32(0)
                || deployment.oracleAdapterCodeHash == bytes32(0)
        ) revert InvalidConfiguration();
        strategyAccount = deployment.strategyAccount;
        packageId = deployment.packageId;
        deploymentChainId = deployment.chainId;
        pool = deployment.pool;
        baseToken = deployment.baseToken;
        quoteToken = deployment.quoteToken;
        poolToken = deployment.poolToken;
        oracleAdapter = deployment.oracleAdapter;
        strike = deployment.strike;
        maturity = deployment.maturity;
        isCallPool = deployment.isCallPool;
        strategyAccountCodeHash = deployment.strategyAccountCodeHash;
        poolCodeHash = deployment.poolCodeHash;
        baseTokenCodeHash = deployment.baseTokenCodeHash;
        quoteTokenCodeHash = deployment.quoteTokenCodeHash;
        oracleAdapterCodeHash = deployment.oracleAdapterCodeHash;
        _assertDeployment();
    }

    function adapterMetadata() external view returns (address, bytes32, uint32, address, address) {
        return (strategyAccount, ADAPTER_CLASS_ID, ADAPTER_CLASS_VERSION, address(baseToken), address(quoteToken));
    }

    function executeLeg(bytes calldata payload) external nonReentrant returns (bytes32 evidenceHash) {
        if (msg.sender != strategyAccount) revert UnauthorizedCaller();
        ExactOptionLeg memory leg = abi.decode(payload, (ExactOptionLeg));
        _validateLeg(leg);
        _assertDeployment();
        uint256 preLongs = pool.balanceOf(address(this), LONG_TOKEN_ID);
        uint256 preShorts = pool.balanceOf(address(this), SHORT_TOKEN_ID);
        if (preLongs != leg.expectedPreLongs || preShorts != leg.expectedPreShorts) revert PreconditionFailed();
        uint256 accountTokenBefore = poolToken.balanceOf(strategyAccount);
        uint256 adapterTokenBefore = poolToken.balanceOf(address(this));
        uint256 primaryOutput;
        int256 secondaryOutput;
        if (leg.action == TRADE) {
            (primaryOutput, secondaryOutput) = _trade(leg, adapterTokenBefore);
        } else if (leg.action == EXERCISE) {
            uint256 fee;
            (primaryOutput, fee) = pool.exercise();
            secondaryOutput = _toSigned(fee);
        } else {
            primaryOutput = pool.settle();
        }
        uint256 adapterTokenAfter = poolToken.balanceOf(address(this));
        if (adapterTokenAfter > adapterTokenBefore) {
            poolToken.safeTransfer(strategyAccount, adapterTokenAfter - adapterTokenBefore);
        } else if (adapterTokenAfter < adapterTokenBefore) {
            revert PostconditionFailed();
        }
        uint256 postLongs = pool.balanceOf(address(this), LONG_TOKEN_ID);
        uint256 postShorts = pool.balanceOf(address(this), SHORT_TOKEN_ID);
        int256 accountDelta = _delta(poolToken.balanceOf(strategyAccount), accountTokenBefore);
        if (
            postLongs != leg.expectedPostLongs || postShorts != leg.expectedPostShorts
                || accountDelta < leg.minimumAccountTokenDelta || accountDelta > leg.maximumAccountTokenDelta
                || poolToken.balanceOf(address(this)) != adapterTokenBefore
        ) revert PostconditionFailed();
        ExecutionOutcome memory outcome = ExecutionOutcome({
            primaryOutput: primaryOutput,
            secondaryOutput: secondaryOutput,
            preLongs: preLongs,
            preShorts: preShorts,
            postLongs: postLongs,
            postShorts: postShorts,
            accountTokenDelta: accountDelta
        });
        return keccak256(abi.encode(address(this), deploymentChainId, leg, outcome));
    }

    function assertDeployment() external view {
        _assertDeployment();
    }

    function _trade(ExactOptionLeg memory leg, uint256 adapterTokenBefore)
        private
        returns (uint256 totalPremium, int256 collateralDelta)
    {
        if (leg.maximumInputAtoms != 0) {
            if (poolToken.allowance(strategyAccount, address(this)) != leg.maximumInputAtoms) revert InvalidLeg();
            poolToken.safeTransferFrom(strategyAccount, address(this), leg.maximumInputAtoms);
            poolToken.forceApprove(address(pool), leg.maximumInputAtoms);
        }
        IPremiaV3Pool.PositionDelta memory positionDelta;
        (totalPremium, positionDelta) = pool.trade(leg.size, leg.isBuy, leg.premiumLimit, address(0));
        if (leg.maximumInputAtoms != 0) poolToken.forceApprove(address(pool), 0);
        collateralDelta = positionDelta.collateral;
        if (poolToken.balanceOf(address(this)) < adapterTokenBefore) revert PostconditionFailed();
    }

    function _validateLeg(ExactOptionLeg memory leg) private view {
        if (
            leg.packageId != packageId || leg.orderHash == bytes32(0) || leg.quoteHash == bytes32(0)
                || leg.routeHash == bytes32(0) || leg.action < TRADE || leg.action > SETTLE_SHORT
                || leg.minimumAccountTokenDelta > leg.maximumAccountTokenDelta
        ) revert InvalidLeg();
        if (leg.action == TRADE) {
            if (leg.size == 0 || leg.premiumLimit == 0) revert InvalidLeg();
        } else if (leg.isBuy || leg.size != 0 || leg.premiumLimit != 0 || leg.maximumInputAtoms != 0) {
            revert InvalidLeg();
        }
    }

    function _assertDeployment() private view {
        if (
            block.chainid != deploymentChainId || strategyAccount.codehash != strategyAccountCodeHash
                || address(pool).codehash != poolCodeHash || address(baseToken).codehash != baseTokenCodeHash
                || address(quoteToken).codehash != quoteTokenCodeHash || oracleAdapter.codehash != oracleAdapterCodeHash
        ) revert DeploymentChanged();
        (address currentBase, address currentQuote, address currentOracle, uint256 currentStrike, uint256 currentMaturity, bool currentIsCall) =
            pool.getPoolSettings();
        if (
            currentBase != address(baseToken) || currentQuote != address(quoteToken) || currentOracle != oracleAdapter
                || currentStrike != strike || currentMaturity != maturity || currentIsCall != isCallPool
        ) revert DeploymentChanged();
    }

    function _delta(uint256 afterBalance, uint256 beforeBalance) private pure returns (int256) {
        if (afterBalance >= beforeBalance) return _toSigned(afterBalance - beforeBalance);
        return -_toSigned(beforeBalance - afterBalance);
    }

    function _toSigned(uint256 value) private pure returns (int256) {
        if (value > uint256(type(int256).max)) revert PostconditionFailed();
        return int256(value);
    }
}
