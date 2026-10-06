// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {Create2} from "openzeppelin-contracts/utils/Create2.sol";
import {AaveV3TypedLendingAdapter} from "./AaveV3TypedLendingAdapter.sol";
import {IAaveV3Pool} from "./interfaces/IAaveV3Pool.sol";
import {INaryxMultiStrategyAccountFactory} from "./interfaces/INaryxMultiStrategyAccountFactory.sol";
import {ITypedStrategyAdapterFactory} from "./interfaces/ITypedStrategyAdapterFactory.sol";

contract AaveV3TypedLendingAdapterFactory is ITypedStrategyAdapterFactory {
    bytes32 public constant ADAPTER_CLASS_ID = keccak256("naryx.evm.aave-v3-lending-exact");
    uint32 public constant ADAPTER_CLASS_VERSION = 1;

    struct Deployment {
        uint256 chainId;
        INaryxMultiStrategyAccountFactory accountFactory;
        IAaveV3Pool pool;
        IERC20 collateralToken;
        IERC20 debtToken;
        bytes32 accountFactoryCodeHash;
        bytes32 strategyAccountCodeHash;
        bytes32 poolCodeHash;
        bytes32 collateralTokenCodeHash;
        bytes32 debtTokenCodeHash;
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
                || address(deployment.pool).code.length == 0 || address(deployment.collateralToken).code.length == 0
                || address(deployment.debtToken).code.length == 0
                || address(deployment.collateralToken) == address(deployment.debtToken)
                || deployment.accountFactoryCodeHash == bytes32(0)
                || deployment.strategyAccountCodeHash == bytes32(0) || deployment.poolCodeHash == bytes32(0)
                || deployment.collateralTokenCodeHash == bytes32(0) || deployment.debtTokenCodeHash == bytes32(0)
        ) revert InvalidConfiguration();
        _deployment = deployment;
        _assertDeployment();
    }

    function factoryMetadata() external view returns (bytes32, uint32, address, address) {
        return (
            ADAPTER_CLASS_ID,
            ADAPTER_CLASS_VERSION,
            address(_deployment.collateralToken),
            address(_deployment.debtToken)
        );
    }

    function adapterOf(address strategyAccount, bytes32 packageId) public view returns (address) {
        return Create2.computeAddress(
            _salt(strategyAccount, packageId),
            keccak256(
                abi.encodePacked(
                    type(AaveV3TypedLendingAdapter).creationCode,
                    abi.encode(_adapterDeployment(strategyAccount, packageId))
                )
            )
        );
    }

    function create(address strategyAccount, bytes32 packageId) external returns (AaveV3TypedLendingAdapter instance) {
        _assertDeployment();
        if (
            !_deployment.accountFactory.isAccount(strategyAccount)
                || strategyAccount.codehash != _deployment.strategyAccountCodeHash
        ) revert InvalidStrategyAccount();
        if (packageId == bytes32(0)) revert InvalidPackage();
        address predicted = adapterOf(strategyAccount, packageId);
        if (predicted.code.length == 0) {
            address created = address(
                new AaveV3TypedLendingAdapter{salt: _salt(strategyAccount, packageId)}(
                    _adapterDeployment(strategyAccount, packageId)
                )
            );
            if (created != predicted) revert InstanceMismatch();
            instanceBinding[created] = InstanceBinding(strategyAccount, packageId);
            emit InstanceCreated(strategyAccount, packageId, created);
        }
        InstanceBinding memory binding = instanceBinding[predicted];
        if (binding.strategyAccount != strategyAccount || binding.packageId != packageId) revert InstanceMismatch();
        return AaveV3TypedLendingAdapter(predicted);
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
        returns (AaveV3TypedLendingAdapter.Deployment memory)
    {
        return AaveV3TypedLendingAdapter.Deployment({
            chainId: _deployment.chainId,
            strategyAccount: strategyAccount,
            packageId: packageId,
            pool: _deployment.pool,
            collateralToken: _deployment.collateralToken,
            debtToken: _deployment.debtToken,
            strategyAccountCodeHash: _deployment.strategyAccountCodeHash,
            poolCodeHash: _deployment.poolCodeHash,
            collateralTokenCodeHash: _deployment.collateralTokenCodeHash,
            debtTokenCodeHash: _deployment.debtTokenCodeHash
        });
    }

    function _assertDeployment() private view {
        if (
            block.chainid != _deployment.chainId
                || address(_deployment.accountFactory).codehash != _deployment.accountFactoryCodeHash
                || _deployment.accountFactory.accountCodeHash() != _deployment.strategyAccountCodeHash
                || address(_deployment.pool).codehash != _deployment.poolCodeHash
                || address(_deployment.collateralToken).codehash != _deployment.collateralTokenCodeHash
                || address(_deployment.debtToken).codehash != _deployment.debtTokenCodeHash
        ) revert DeploymentChanged();
    }

    function _salt(address strategyAccount, bytes32 packageId) private pure returns (bytes32) {
        return keccak256(abi.encode(strategyAccount, packageId));
    }
}
