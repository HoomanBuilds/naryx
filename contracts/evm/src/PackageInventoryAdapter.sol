// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/utils/ReentrancyGuard.sol";
import {ITypedStrategyAdapter} from "./interfaces/ITypedStrategyAdapter.sol";

contract PackageInventoryAdapter is ITypedStrategyAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant LOCK = 1;
    uint8 public constant RELEASE = 2;
    bytes32 public constant ADAPTER_CLASS_ID = keccak256("naryx.evm.inventory-custody-exact");
    uint32 public constant ADAPTER_CLASS_VERSION = 1;

    struct Deployment {
        uint256 chainId;
        address strategyAccount;
        bytes32 packageId;
        IERC20 inventoryToken;
        IERC20 quoteToken;
        bytes32 strategyAccountCodeHash;
        bytes32 inventoryTokenCodeHash;
        bytes32 quoteTokenCodeHash;
    }

    struct ExactInventoryLeg {
        bytes32 packageId;
        bytes32 orderHash;
        bytes32 quoteHash;
        bytes32 routeHash;
        uint8 action;
        uint256 inputAtoms;
        uint256 expectedPreInventoryAtoms;
        uint256 expectedPostInventoryAtoms;
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
    IERC20 public immutable inventoryToken;
    IERC20 public immutable quoteToken;
    bytes32 public immutable strategyAccountCodeHash;
    bytes32 public immutable inventoryTokenCodeHash;
    bytes32 public immutable quoteTokenCodeHash;

    constructor(Deployment memory deployment) {
        if (
            deployment.chainId == 0 || deployment.strategyAccount.code.length == 0 || deployment.packageId == bytes32(0)
                || address(deployment.inventoryToken).code.length == 0
                || address(deployment.quoteToken).code.length == 0
                || address(deployment.inventoryToken) == address(deployment.quoteToken)
                || deployment.strategyAccountCodeHash == bytes32(0) || deployment.inventoryTokenCodeHash == bytes32(0)
                || deployment.quoteTokenCodeHash == bytes32(0)
        ) revert InvalidConfiguration();
        strategyAccount = deployment.strategyAccount;
        packageId = deployment.packageId;
        deploymentChainId = deployment.chainId;
        inventoryToken = deployment.inventoryToken;
        quoteToken = deployment.quoteToken;
        strategyAccountCodeHash = deployment.strategyAccountCodeHash;
        inventoryTokenCodeHash = deployment.inventoryTokenCodeHash;
        quoteTokenCodeHash = deployment.quoteTokenCodeHash;
        _assertDeployment();
    }

    function adapterMetadata() external view returns (address, bytes32, uint32, address, address) {
        return (strategyAccount, ADAPTER_CLASS_ID, ADAPTER_CLASS_VERSION, address(inventoryToken), address(quoteToken));
    }

    function executeLeg(bytes calldata payload) external nonReentrant returns (bytes32 evidenceHash) {
        if (msg.sender != strategyAccount) revert UnauthorizedCaller();
        ExactInventoryLeg memory leg = abi.decode(payload, (ExactInventoryLeg));
        _validateLeg(leg);
        _assertDeployment();
        uint256 preInventory = inventoryToken.balanceOf(address(this));
        if (preInventory != leg.expectedPreInventoryAtoms) revert PreconditionFailed();
        uint256 accountBefore = inventoryToken.balanceOf(strategyAccount);
        if (leg.action == LOCK) {
            if (inventoryToken.allowance(strategyAccount, address(this)) != leg.inputAtoms) revert InvalidLeg();
            inventoryToken.safeTransferFrom(strategyAccount, address(this), leg.inputAtoms);
            if (inventoryToken.balanceOf(strategyAccount) != accountBefore - leg.inputAtoms) {
                revert PostconditionFailed();
            }
        } else {
            inventoryToken.safeTransfer(strategyAccount, leg.inputAtoms);
            if (inventoryToken.balanceOf(strategyAccount) != accountBefore + leg.inputAtoms) {
                revert PostconditionFailed();
            }
        }
        uint256 postInventory = inventoryToken.balanceOf(address(this));
        if (postInventory != leg.expectedPostInventoryAtoms) revert PostconditionFailed();
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
                preInventory,
                postInventory,
                accountBefore,
                inventoryToken.balanceOf(strategyAccount)
            )
        );
    }

    function assertDeployment() external view {
        _assertDeployment();
    }

    function _validateLeg(ExactInventoryLeg memory leg) private view {
        if (
            leg.packageId != packageId || leg.orderHash == bytes32(0) || leg.quoteHash == bytes32(0)
                || leg.routeHash == bytes32(0) || (leg.action != LOCK && leg.action != RELEASE) || leg.inputAtoms == 0
        ) revert InvalidLeg();
        if (
            (leg.action == LOCK && leg.expectedPostInventoryAtoms < leg.expectedPreInventoryAtoms)
                || (leg.action == RELEASE && leg.expectedPreInventoryAtoms < leg.expectedPostInventoryAtoms)
        ) revert InvalidLeg();
        uint256 difference = leg.action == LOCK
            ? leg.expectedPostInventoryAtoms - leg.expectedPreInventoryAtoms
            : leg.expectedPreInventoryAtoms - leg.expectedPostInventoryAtoms;
        if (difference != leg.inputAtoms) revert InvalidLeg();
    }

    function _assertDeployment() private view {
        if (
            block.chainid != deploymentChainId || strategyAccount.codehash != strategyAccountCodeHash
                || address(inventoryToken).codehash != inventoryTokenCodeHash
                || address(quoteToken).codehash != quoteTokenCodeHash
        ) revert DeploymentChanged();
    }
}
