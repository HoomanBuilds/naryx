// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {Create2} from "openzeppelin-contracts/utils/Create2.sol";
import {PackageInventoryAdapter} from "./PackageInventoryAdapter.sol";
import {INaryxMultiStrategyAccountFactory} from "./interfaces/INaryxMultiStrategyAccountFactory.sol";
import {ITypedStrategyAdapterFactory} from "./interfaces/ITypedStrategyAdapterFactory.sol";

contract PackageInventoryAdapterFactory is ITypedStrategyAdapterFactory {
    bytes32 public constant ADAPTER_CLASS_ID = keccak256("naryx.evm.inventory-custody-exact");
    uint32 public constant ADAPTER_CLASS_VERSION = 1;

    struct Deployment {
        uint256 chainId;
        INaryxMultiStrategyAccountFactory accountFactory;
        IERC20 inventoryToken;
        IERC20 quoteToken;
        bytes32 accountFactoryCodeHash;
        bytes32 strategyAccountCodeHash;
        bytes32 inventoryTokenCodeHash;
        bytes32 quoteTokenCodeHash;
    }

    struct InstanceBinding {
        address strategyAccount;
        bytes32 packageId;
    }

    error InvalidConfiguration();
    error InvalidStrategyAccount();
    error InvalidPackage();
    error DeploymentChanged();
    error InstanceMismatch();

    event InstanceCreated(address indexed strategyAccount, bytes32 indexed packageId, address indexed instance);

    Deployment private _deployment;
    mapping(address instance => InstanceBinding binding) public instanceBinding;

    constructor(Deployment memory deployment) {
        if (
            deployment.chainId == 0 || address(deployment.accountFactory).code.length == 0
                || address(deployment.inventoryToken).code.length == 0
                || address(deployment.quoteToken).code.length == 0
                || address(deployment.inventoryToken) == address(deployment.quoteToken)
                || deployment.accountFactoryCodeHash == bytes32(0) || deployment.strategyAccountCodeHash == bytes32(0)
                || deployment.inventoryTokenCodeHash == bytes32(0) || deployment.quoteTokenCodeHash == bytes32(0)
        ) revert InvalidConfiguration();
        _deployment = deployment;
        _assertDeployment();
    }

    function factoryMetadata() external view returns (bytes32, uint32, address, address) {
        return
            (
                ADAPTER_CLASS_ID,
                ADAPTER_CLASS_VERSION,
                address(_deployment.inventoryToken),
                address(_deployment.quoteToken)
            );
    }

    function adapterOf(address strategyAccount, bytes32 packageId) public view returns (address) {
        return Create2.computeAddress(
            _salt(strategyAccount, packageId),
            keccak256(
                abi.encodePacked(
                    type(PackageInventoryAdapter).creationCode,
                    abi.encode(_adapterDeployment(strategyAccount, packageId))
                )
            )
        );
    }

    function create(address strategyAccount, bytes32 packageId) external returns (PackageInventoryAdapter instance) {
        _assertDeployment();
        if (
            !_deployment.accountFactory.isAccount(strategyAccount)
                || strategyAccount.codehash != _deployment.strategyAccountCodeHash
        ) revert InvalidStrategyAccount();
        if (packageId == bytes32(0)) revert InvalidPackage();
        address predicted = adapterOf(strategyAccount, packageId);
        if (predicted.code.length == 0) {
            address created = address(
                new PackageInventoryAdapter{salt: _salt(strategyAccount, packageId)}(
                    _adapterDeployment(strategyAccount, packageId)
                )
            );
            if (created != predicted) revert InstanceMismatch();
            instanceBinding[created] = InstanceBinding(strategyAccount, packageId);
            emit InstanceCreated(strategyAccount, packageId, created);
        }
        InstanceBinding memory binding = instanceBinding[predicted];
        if (binding.strategyAccount != strategyAccount || binding.packageId != packageId) revert InstanceMismatch();
        return PackageInventoryAdapter(predicted);
    }

    function validateInstance(address instance, address strategyAccount, bytes32 packageId)
        external
        view
        returns (bool)
    {
        _assertDeployment();
        InstanceBinding memory binding = instanceBinding[instance];
        return instance.code.length != 0 && instance == adapterOf(strategyAccount, packageId)
            && binding.strategyAccount == strategyAccount && binding.packageId == packageId
            && _deployment.accountFactory.isAccount(strategyAccount)
            && strategyAccount.codehash == _deployment.strategyAccountCodeHash;
    }

    function _adapterDeployment(address strategyAccount, bytes32 packageId)
        private
        view
        returns (PackageInventoryAdapter.Deployment memory)
    {
        return PackageInventoryAdapter.Deployment({
            chainId: _deployment.chainId,
            strategyAccount: strategyAccount,
            packageId: packageId,
            inventoryToken: _deployment.inventoryToken,
            quoteToken: _deployment.quoteToken,
            strategyAccountCodeHash: _deployment.strategyAccountCodeHash,
            inventoryTokenCodeHash: _deployment.inventoryTokenCodeHash,
            quoteTokenCodeHash: _deployment.quoteTokenCodeHash
        });
    }

    function _assertDeployment() private view {
        if (
            block.chainid != _deployment.chainId
                || address(_deployment.accountFactory).codehash != _deployment.accountFactoryCodeHash
                || _deployment.accountFactory.accountCodeHash() != _deployment.strategyAccountCodeHash
                || address(_deployment.inventoryToken).codehash != _deployment.inventoryTokenCodeHash
                || address(_deployment.quoteToken).codehash != _deployment.quoteTokenCodeHash
        ) revert DeploymentChanged();
    }

    function _salt(address strategyAccount, bytes32 packageId) private pure returns (bytes32) {
        return keccak256(abi.encode(strategyAccount, packageId));
    }
}
