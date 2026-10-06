// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "openzeppelin-contracts/interfaces/IERC4626.sol";
import {Create2} from "openzeppelin-contracts/utils/Create2.sol";
import {ERC4626TypedVaultAdapter} from "./ERC4626TypedVaultAdapter.sol";
import {INaryxMultiStrategyAccountFactory} from "./interfaces/INaryxMultiStrategyAccountFactory.sol";
import {ITypedStrategyAdapterFactory} from "./interfaces/ITypedStrategyAdapterFactory.sol";

contract ERC4626TypedVaultAdapterFactory is ITypedStrategyAdapterFactory {
    bytes32 public constant ADAPTER_CLASS_ID = keccak256("naryx.evm.erc4626-exact");
    uint32 public constant ADAPTER_CLASS_VERSION = 1;

    struct Deployment {
        uint256 chainId;
        INaryxMultiStrategyAccountFactory accountFactory;
        IERC4626 vault;
        IERC20 assetToken;
        bytes32 accountFactoryCodeHash;
        bytes32 strategyAccountCodeHash;
        bytes32 vaultCodeHash;
        bytes32 assetTokenCodeHash;
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

    uint256 public immutable deploymentChainId;
    INaryxMultiStrategyAccountFactory public immutable accountFactory;
    IERC4626 public immutable vault;
    IERC20 public immutable assetToken;
    bytes32 public immutable accountFactoryCodeHash;
    bytes32 public immutable strategyAccountCodeHash;
    bytes32 public immutable vaultCodeHash;
    bytes32 public immutable assetTokenCodeHash;

    mapping(address instance => InstanceBinding binding) public instanceBinding;

    constructor(Deployment memory deployment) {
        if (
            deployment.chainId == 0 || address(deployment.accountFactory).code.length == 0
                || address(deployment.vault).code.length == 0 || address(deployment.assetToken).code.length == 0
                || address(deployment.vault) == address(deployment.assetToken)
                || deployment.accountFactoryCodeHash == bytes32(0)
                || deployment.strategyAccountCodeHash == bytes32(0) || deployment.vaultCodeHash == bytes32(0)
                || deployment.assetTokenCodeHash == bytes32(0)
        ) revert InvalidConfiguration();
        deploymentChainId = deployment.chainId;
        accountFactory = deployment.accountFactory;
        vault = deployment.vault;
        assetToken = deployment.assetToken;
        accountFactoryCodeHash = deployment.accountFactoryCodeHash;
        strategyAccountCodeHash = deployment.strategyAccountCodeHash;
        vaultCodeHash = deployment.vaultCodeHash;
        assetTokenCodeHash = deployment.assetTokenCodeHash;
        _assertDeployment();
    }

    function factoryMetadata() external view returns (bytes32, uint32, address, address) {
        return (ADAPTER_CLASS_ID, ADAPTER_CLASS_VERSION, address(assetToken), address(vault));
    }

    function adapterOf(address strategyAccount, bytes32 packageId) public view returns (address) {
        return Create2.computeAddress(
            _salt(strategyAccount, packageId),
            keccak256(
                abi.encodePacked(
                    type(ERC4626TypedVaultAdapter).creationCode,
                    abi.encode(_adapterDeployment(strategyAccount, packageId))
                )
            )
        );
    }

    function create(address strategyAccount, bytes32 packageId) external returns (ERC4626TypedVaultAdapter instance) {
        _assertDeployment();
        if (!accountFactory.isAccount(strategyAccount) || strategyAccount.codehash != strategyAccountCodeHash) {
            revert InvalidStrategyAccount();
        }
        if (packageId == bytes32(0)) revert InvalidPackage();
        address predicted = adapterOf(strategyAccount, packageId);
        if (predicted.code.length == 0) {
            address created = address(
                new ERC4626TypedVaultAdapter{salt: _salt(strategyAccount, packageId)}(
                    _adapterDeployment(strategyAccount, packageId)
                )
            );
            if (created != predicted) revert InstanceMismatch();
            instanceBinding[created] = InstanceBinding(strategyAccount, packageId);
            emit InstanceCreated(strategyAccount, packageId, created);
        }
        InstanceBinding memory binding = instanceBinding[predicted];
        if (binding.strategyAccount != strategyAccount || binding.packageId != packageId) revert InstanceMismatch();
        return ERC4626TypedVaultAdapter(predicted);
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
            && accountFactory.isAccount(strategyAccount) && strategyAccount.codehash == strategyAccountCodeHash;
    }

    function _adapterDeployment(address strategyAccount, bytes32 packageId)
        private
        view
        returns (ERC4626TypedVaultAdapter.Deployment memory)
    {
        return ERC4626TypedVaultAdapter.Deployment({
            chainId: deploymentChainId,
            strategyAccount: strategyAccount,
            packageId: packageId,
            vault: vault,
            assetToken: assetToken,
            strategyAccountCodeHash: strategyAccountCodeHash,
            vaultCodeHash: vaultCodeHash,
            assetTokenCodeHash: assetTokenCodeHash
        });
    }

    function _assertDeployment() private view {
        if (
            block.chainid != deploymentChainId || address(accountFactory).codehash != accountFactoryCodeHash
                || accountFactory.accountCodeHash() != strategyAccountCodeHash || address(vault).codehash != vaultCodeHash
                || address(assetToken).codehash != assetTokenCodeHash || vault.asset() != address(assetToken)
        ) revert DeploymentChanged();
    }

    function _salt(address strategyAccount, bytes32 packageId) private pure returns (bytes32) {
        return keccak256(abi.encode(strategyAccount, packageId));
    }
}
