// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/utils/ReentrancyGuard.sol";
import {IAaveV3Pool} from "./interfaces/IAaveV3Pool.sol";
import {ITypedStrategyAdapter} from "./interfaces/ITypedStrategyAdapter.sol";

contract AaveV3TypedLendingAdapter is ITypedStrategyAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant SUPPLY_COLLATERAL = 1;
    uint8 public constant WITHDRAW_COLLATERAL = 2;
    uint8 public constant BORROW_DEBT = 3;
    uint8 public constant REPAY_DEBT = 4;
    uint256 public constant VARIABLE_INTEREST_RATE_MODE = 2;
    bytes32 public constant ADAPTER_CLASS_ID = keccak256("naryx.evm.aave-v3-lending-exact");
    uint32 public constant ADAPTER_CLASS_VERSION = 1;

    struct Deployment {
        uint256 chainId;
        address strategyAccount;
        bytes32 packageId;
        IAaveV3Pool pool;
        IERC20 collateralToken;
        IERC20 debtToken;
        bytes32 strategyAccountCodeHash;
        bytes32 poolCodeHash;
        bytes32 collateralTokenCodeHash;
        bytes32 debtTokenCodeHash;
    }

    struct AccountData {
        uint256 totalCollateralBase;
        uint256 totalDebtBase;
        uint256 availableBorrowsBase;
        uint256 currentLiquidationThreshold;
        uint256 ltv;
        uint256 healthFactor;
    }

    struct ExactLendingLeg {
        bytes32 packageId;
        bytes32 orderHash;
        bytes32 quoteHash;
        bytes32 routeHash;
        bytes32 expectedPreAccountDataHash;
        uint8 action;
        uint256 inputAtoms;
        uint256 minimumOutputAtoms;
        uint256 maximumOutputAtoms;
        uint256 minimumPostCollateralBase;
        uint256 maximumPostCollateralBase;
        uint256 minimumPostDebtBase;
        uint256 maximumPostDebtBase;
        uint256 minimumPostHealthFactor;
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
    IAaveV3Pool public immutable pool;
    IERC20 public immutable collateralToken;
    IERC20 public immutable debtToken;
    bytes32 public immutable strategyAccountCodeHash;
    bytes32 public immutable poolCodeHash;
    bytes32 public immutable collateralTokenCodeHash;
    bytes32 public immutable debtTokenCodeHash;

    constructor(Deployment memory deployment) {
        if (
            deployment.chainId == 0 || deployment.strategyAccount.code.length == 0
                || deployment.packageId == bytes32(0) || address(deployment.pool).code.length == 0
                || address(deployment.collateralToken).code.length == 0
                || address(deployment.debtToken).code.length == 0
                || address(deployment.collateralToken) == address(deployment.debtToken)
                || deployment.strategyAccountCodeHash == bytes32(0) || deployment.poolCodeHash == bytes32(0)
                || deployment.collateralTokenCodeHash == bytes32(0) || deployment.debtTokenCodeHash == bytes32(0)
        ) revert InvalidConfiguration();
        strategyAccount = deployment.strategyAccount;
        packageId = deployment.packageId;
        deploymentChainId = deployment.chainId;
        pool = deployment.pool;
        collateralToken = deployment.collateralToken;
        debtToken = deployment.debtToken;
        strategyAccountCodeHash = deployment.strategyAccountCodeHash;
        poolCodeHash = deployment.poolCodeHash;
        collateralTokenCodeHash = deployment.collateralTokenCodeHash;
        debtTokenCodeHash = deployment.debtTokenCodeHash;
        _assertDeployment();
    }

    function adapterMetadata() external view returns (address, bytes32, uint32, address, address) {
        return (
            strategyAccount,
            ADAPTER_CLASS_ID,
            ADAPTER_CLASS_VERSION,
            address(collateralToken),
            address(debtToken)
        );
    }

    function executeLeg(bytes calldata payload) external nonReentrant returns (bytes32 evidenceHash) {
        if (msg.sender != strategyAccount) revert UnauthorizedCaller();
        ExactLendingLeg memory leg = abi.decode(payload, (ExactLendingLeg));
        _validateLeg(leg);
        _assertDeployment();
        AccountData memory pre = _accountData();
        if (keccak256(abi.encode(pre)) != leg.expectedPreAccountDataHash) revert PreconditionFailed();
        uint256 outputAtoms;
        if (leg.action == SUPPLY_COLLATERAL) outputAtoms = _supply(leg.inputAtoms);
        else if (leg.action == WITHDRAW_COLLATERAL) outputAtoms = _withdraw(leg.inputAtoms);
        else if (leg.action == BORROW_DEBT) outputAtoms = _borrow(leg.inputAtoms);
        else outputAtoms = _repay(leg.inputAtoms);
        AccountData memory post = _accountData();
        if (
            outputAtoms < leg.minimumOutputAtoms || outputAtoms > leg.maximumOutputAtoms
                || post.totalCollateralBase < leg.minimumPostCollateralBase
                || post.totalCollateralBase > leg.maximumPostCollateralBase
                || post.totalDebtBase < leg.minimumPostDebtBase || post.totalDebtBase > leg.maximumPostDebtBase
                || post.healthFactor < leg.minimumPostHealthFactor
        ) revert PostconditionFailed();
        return keccak256(
            abi.encode(
                address(this),
                deploymentChainId,
                leg.packageId,
                leg.orderHash,
                leg.quoteHash,
                leg.routeHash,
                leg.action,
                leg.inputAtoms,
                outputAtoms,
                keccak256(abi.encode(pre)),
                keccak256(abi.encode(post))
            )
        );
    }

    function accountData() external view returns (AccountData memory) {
        return _accountData();
    }

    function assertDeployment() external view {
        _assertDeployment();
    }

    function _supply(uint256 amount) private returns (uint256) {
        if (collateralToken.allowance(strategyAccount, address(this)) != amount) revert InvalidLeg();
        uint256 accountBefore = collateralToken.balanceOf(strategyAccount);
        uint256 adapterBefore = collateralToken.balanceOf(address(this));
        collateralToken.safeTransferFrom(strategyAccount, address(this), amount);
        collateralToken.forceApprove(address(pool), amount);
        pool.supply(address(collateralToken), amount, address(this), 0);
        collateralToken.forceApprove(address(pool), 0);
        if (
            collateralToken.balanceOf(strategyAccount) != accountBefore - amount
                || collateralToken.balanceOf(address(this)) != adapterBefore
        ) revert PostconditionFailed();
        return amount;
    }

    function _withdraw(uint256 amount) private returns (uint256 withdrawn) {
        uint256 accountBefore = collateralToken.balanceOf(strategyAccount);
        uint256 adapterBefore = collateralToken.balanceOf(address(this));
        withdrawn = pool.withdraw(address(collateralToken), amount, address(this));
        if (withdrawn == 0 || collateralToken.balanceOf(address(this)) != adapterBefore + withdrawn) {
            revert PostconditionFailed();
        }
        collateralToken.safeTransfer(strategyAccount, withdrawn);
        if (
            collateralToken.balanceOf(strategyAccount) != accountBefore + withdrawn
                || collateralToken.balanceOf(address(this)) != adapterBefore
        ) revert PostconditionFailed();
    }

    function _borrow(uint256 amount) private returns (uint256) {
        uint256 accountBefore = debtToken.balanceOf(strategyAccount);
        uint256 adapterBefore = debtToken.balanceOf(address(this));
        pool.borrow(address(debtToken), amount, VARIABLE_INTEREST_RATE_MODE, 0, address(this));
        if (debtToken.balanceOf(address(this)) != adapterBefore + amount) revert PostconditionFailed();
        debtToken.safeTransfer(strategyAccount, amount);
        if (
            debtToken.balanceOf(strategyAccount) != accountBefore + amount
                || debtToken.balanceOf(address(this)) != adapterBefore
        ) revert PostconditionFailed();
        return amount;
    }

    function _repay(uint256 amount) private returns (uint256 repaid) {
        if (debtToken.allowance(strategyAccount, address(this)) != amount) revert InvalidLeg();
        uint256 accountBefore = debtToken.balanceOf(strategyAccount);
        uint256 adapterBefore = debtToken.balanceOf(address(this));
        debtToken.safeTransferFrom(strategyAccount, address(this), amount);
        debtToken.forceApprove(address(pool), amount);
        repaid = pool.repay(address(debtToken), amount, VARIABLE_INTEREST_RATE_MODE, address(this));
        debtToken.forceApprove(address(pool), 0);
        if (repaid == 0 || repaid > amount) revert PostconditionFailed();
        if (amount != repaid) debtToken.safeTransfer(strategyAccount, amount - repaid);
        if (
            debtToken.balanceOf(strategyAccount) != accountBefore - repaid
                || debtToken.balanceOf(address(this)) != adapterBefore
        ) revert PostconditionFailed();
    }

    function _accountData() private view returns (AccountData memory data) {
        (
            data.totalCollateralBase,
            data.totalDebtBase,
            data.availableBorrowsBase,
            data.currentLiquidationThreshold,
            data.ltv,
            data.healthFactor
        ) = pool.getUserAccountData(address(this));
    }

    function _validateLeg(ExactLendingLeg memory leg) private view {
        if (
            leg.packageId != packageId || leg.orderHash == bytes32(0) || leg.quoteHash == bytes32(0)
                || leg.routeHash == bytes32(0) || leg.expectedPreAccountDataHash == bytes32(0)
                || leg.action < SUPPLY_COLLATERAL || leg.action > REPAY_DEBT || leg.inputAtoms == 0
                || leg.minimumOutputAtoms == 0 || leg.minimumOutputAtoms > leg.maximumOutputAtoms
                || leg.minimumPostCollateralBase > leg.maximumPostCollateralBase
                || leg.minimumPostDebtBase > leg.maximumPostDebtBase
        ) revert InvalidLeg();
    }

    function _assertDeployment() private view {
        if (
            block.chainid != deploymentChainId || strategyAccount.codehash != strategyAccountCodeHash
                || address(pool).codehash != poolCodeHash
                || address(collateralToken).codehash != collateralTokenCodeHash
                || address(debtToken).codehash != debtTokenCodeHash
        ) revert DeploymentChanged();
    }
}
