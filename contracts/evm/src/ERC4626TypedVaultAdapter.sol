// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC4626} from "openzeppelin-contracts/interfaces/IERC4626.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/utils/ReentrancyGuard.sol";
import {ITypedStrategyAdapter} from "./interfaces/ITypedStrategyAdapter.sol";

contract ERC4626TypedVaultAdapter is ITypedStrategyAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant DEPOSIT_EXACT_ASSETS = 1;
    uint8 public constant REDEEM_EXACT_SHARES = 2;
    bytes32 public constant ADAPTER_CLASS_ID = keccak256("naryx.evm.erc4626-exact");
    uint32 public constant ADAPTER_CLASS_VERSION = 1;

    struct Deployment {
        uint256 chainId;
        address strategyAccount;
        bytes32 packageId;
        IERC4626 vault;
        IERC20 assetToken;
        bytes32 strategyAccountCodeHash;
        bytes32 vaultCodeHash;
        bytes32 assetTokenCodeHash;
    }

    struct ExactVaultLeg {
        bytes32 packageId;
        bytes32 orderHash;
        bytes32 quoteHash;
        bytes32 routeHash;
        uint8 action;
        uint256 inputAtoms;
        uint256 minimumOutputAtoms;
        uint256 maximumOutputAtoms;
    }

    error InvalidConfiguration();
    error UnauthorizedCaller();
    error InvalidLeg();
    error DeploymentChanged();
    error PostconditionFailed();

    address public immutable strategyAccount;
    bytes32 public immutable packageId;
    uint256 public immutable deploymentChainId;
    IERC4626 public immutable vault;
    IERC20 public immutable assetToken;
    bytes32 public immutable strategyAccountCodeHash;
    bytes32 public immutable vaultCodeHash;
    bytes32 public immutable assetTokenCodeHash;

    constructor(Deployment memory deployment) {
        if (
            deployment.chainId == 0 || deployment.strategyAccount.code.length == 0
                || deployment.packageId == bytes32(0) || address(deployment.vault).code.length == 0
                || address(deployment.assetToken).code.length == 0
                || address(deployment.vault) == address(deployment.assetToken)
                || deployment.strategyAccountCodeHash == bytes32(0) || deployment.vaultCodeHash == bytes32(0)
                || deployment.assetTokenCodeHash == bytes32(0)
        ) revert InvalidConfiguration();
        strategyAccount = deployment.strategyAccount;
        packageId = deployment.packageId;
        deploymentChainId = deployment.chainId;
        vault = deployment.vault;
        assetToken = deployment.assetToken;
        strategyAccountCodeHash = deployment.strategyAccountCodeHash;
        vaultCodeHash = deployment.vaultCodeHash;
        assetTokenCodeHash = deployment.assetTokenCodeHash;
        _assertDeployment();
    }

    function adapterMetadata() external view returns (address, bytes32, uint32, address, address) {
        return (strategyAccount, ADAPTER_CLASS_ID, ADAPTER_CLASS_VERSION, address(assetToken), address(vault));
    }

    function executeLeg(bytes calldata payload) external nonReentrant returns (bytes32 evidenceHash) {
        if (msg.sender != strategyAccount) revert UnauthorizedCaller();
        ExactVaultLeg memory leg = abi.decode(payload, (ExactVaultLeg));
        _validateLeg(leg);
        _assertDeployment();
        return leg.action == DEPOSIT_EXACT_ASSETS ? _deposit(leg) : _redeem(leg);
    }

    function assertDeployment() external view {
        _assertDeployment();
    }

    function _deposit(ExactVaultLeg memory leg) private returns (bytes32 evidenceHash) {
        uint256 accountAssetsBefore = assetToken.balanceOf(strategyAccount);
        uint256 accountSharesBefore = vault.balanceOf(strategyAccount);
        uint256 adapterAssetsBefore = assetToken.balanceOf(address(this));
        uint256 adapterSharesBefore = vault.balanceOf(address(this));
        if (assetToken.allowance(strategyAccount, address(this)) != leg.inputAtoms) revert InvalidLeg();
        assetToken.safeTransferFrom(strategyAccount, address(this), leg.inputAtoms);
        assetToken.forceApprove(address(vault), leg.inputAtoms);
        uint256 outputAtoms = vault.deposit(leg.inputAtoms, strategyAccount);
        assetToken.forceApprove(address(vault), 0);
        if (
            outputAtoms < leg.minimumOutputAtoms || outputAtoms > leg.maximumOutputAtoms
                || assetToken.balanceOf(strategyAccount) != accountAssetsBefore - leg.inputAtoms
                || vault.balanceOf(strategyAccount) != accountSharesBefore + outputAtoms
                || assetToken.balanceOf(address(this)) != adapterAssetsBefore
                || vault.balanceOf(address(this)) != adapterSharesBefore
        ) revert PostconditionFailed();
        return _evidenceHash(leg, accountAssetsBefore, accountSharesBefore, outputAtoms);
    }

    function _redeem(ExactVaultLeg memory leg) private returns (bytes32 evidenceHash) {
        uint256 accountAssetsBefore = assetToken.balanceOf(strategyAccount);
        uint256 accountSharesBefore = vault.balanceOf(strategyAccount);
        uint256 adapterAssetsBefore = assetToken.balanceOf(address(this));
        uint256 adapterSharesBefore = vault.balanceOf(address(this));
        if (vault.allowance(strategyAccount, address(this)) != leg.inputAtoms) revert InvalidLeg();
        IERC20(address(vault)).safeTransferFrom(strategyAccount, address(this), leg.inputAtoms);
        uint256 outputAtoms = vault.redeem(leg.inputAtoms, strategyAccount, address(this));
        if (
            outputAtoms < leg.minimumOutputAtoms || outputAtoms > leg.maximumOutputAtoms
                || vault.balanceOf(strategyAccount) != accountSharesBefore - leg.inputAtoms
                || assetToken.balanceOf(strategyAccount) != accountAssetsBefore + outputAtoms
                || assetToken.balanceOf(address(this)) != adapterAssetsBefore
                || vault.balanceOf(address(this)) != adapterSharesBefore
        ) revert PostconditionFailed();
        return _evidenceHash(leg, accountAssetsBefore, accountSharesBefore, outputAtoms);
    }

    function _evidenceHash(
        ExactVaultLeg memory leg,
        uint256 accountAssetsBefore,
        uint256 accountSharesBefore,
        uint256 outputAtoms
    ) private view returns (bytes32) {
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
                accountAssetsBefore,
                accountSharesBefore,
                assetToken.balanceOf(strategyAccount),
                vault.balanceOf(strategyAccount)
            )
        );
    }

    function _validateLeg(ExactVaultLeg memory leg) private view {
        if (
            leg.packageId != packageId || leg.orderHash == bytes32(0) || leg.quoteHash == bytes32(0)
                || leg.routeHash == bytes32(0)
                || (leg.action != DEPOSIT_EXACT_ASSETS && leg.action != REDEEM_EXACT_SHARES)
                || leg.inputAtoms == 0 || leg.minimumOutputAtoms == 0
                || leg.minimumOutputAtoms > leg.maximumOutputAtoms
        ) revert InvalidLeg();
    }

    function _assertDeployment() private view {
        if (
            block.chainid != deploymentChainId || strategyAccount.codehash != strategyAccountCodeHash
                || address(vault).codehash != vaultCodeHash || address(assetToken).codehash != assetTokenCodeHash
                || vault.asset() != address(assetToken)
        ) revert DeploymentChanged();
    }
}
