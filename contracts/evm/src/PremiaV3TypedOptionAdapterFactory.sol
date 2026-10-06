// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {Create2} from "openzeppelin-contracts/utils/Create2.sol";
import {PremiaV3TypedOptionAdapter} from "./PremiaV3TypedOptionAdapter.sol";
import {IPremiaV3Pool} from "./interfaces/IPremiaV3Pool.sol";
import {INaryxMultiStrategyAccountFactory} from "./interfaces/INaryxMultiStrategyAccountFactory.sol";
import {ITypedStrategyAdapterFactory} from "./interfaces/ITypedStrategyAdapterFactory.sol";

contract PremiaV3TypedOptionAdapterFactory is ITypedStrategyAdapterFactory {
    bytes32 public constant ADAPTER_CLASS_ID = keccak256("naryx.evm.premia-v3-option-exact");
    uint32 public constant ADAPTER_CLASS_VERSION = 1;

    struct Deployment {
        uint256 chainId;
        INaryxMultiStrategyAccountFactory accountFactory;
        IPremiaV3Pool pool;
        IERC20 baseToken;
        IERC20 quoteToken;
        IERC20 poolToken;
        address oracleAdapter;
        uint256 strike;
        uint256 maturity;
        bool isCallPool;
        bytes32 accountFactoryCodeHash;
        bytes32 strategyAccountCodeHash;
        bytes32 poolCodeHash;
        bytes32 baseTokenCodeHash;
        bytes32 quoteTokenCodeHash;
        bytes32 oracleAdapterCodeHash;
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
                || address(deployment.pool).code.length == 0 || address(deployment.baseToken).code.length == 0
                || address(deployment.quoteToken).code.length == 0
                || address(deployment.baseToken) == address(deployment.quoteToken)
                || address(deployment.poolToken) != (deployment.isCallPool ? address(deployment.baseToken) : address(deployment.quoteToken))
                || deployment.oracleAdapter.code.length == 0 || deployment.strike == 0 || deployment.maturity == 0
                || deployment.accountFactoryCodeHash == bytes32(0)
                || deployment.strategyAccountCodeHash == bytes32(0) || deployment.poolCodeHash == bytes32(0)
                || deployment.baseTokenCodeHash == bytes32(0) || deployment.quoteTokenCodeHash == bytes32(0)
                || deployment.oracleAdapterCodeHash == bytes32(0)
        ) revert InvalidConfiguration();
        _deployment = deployment;
        _assertDeployment();
    }

    function factoryMetadata() external view returns (bytes32, uint32, address, address) {
        return (ADAPTER_CLASS_ID, ADAPTER_CLASS_VERSION, address(_deployment.baseToken), address(_deployment.quoteToken));
    }

    function adapterOf(address strategyAccount, bytes32 packageId) public view returns (address) {
        return Create2.computeAddress(
            _salt(strategyAccount, packageId),
            keccak256(
                abi.encodePacked(
                    type(PremiaV3TypedOptionAdapter).creationCode,
                    abi.encode(_adapterDeployment(strategyAccount, packageId))
                )
            )
        );
    }

    function create(address strategyAccount, bytes32 packageId) external returns (PremiaV3TypedOptionAdapter instance) {
        _assertDeployment();
        if (
            !_deployment.accountFactory.isAccount(strategyAccount)
                || strategyAccount.codehash != _deployment.strategyAccountCodeHash
        ) revert InvalidStrategyAccount();
        if (packageId == bytes32(0)) revert InvalidPackage();
        address predicted = adapterOf(strategyAccount, packageId);
        if (predicted.code.length == 0) {
            address created = address(
                new PremiaV3TypedOptionAdapter{salt: _salt(strategyAccount, packageId)}(
                    _adapterDeployment(strategyAccount, packageId)
                )
            );
            if (created != predicted) revert InstanceMismatch();
            instanceBinding[created] = InstanceBinding(strategyAccount, packageId);
            emit InstanceCreated(strategyAccount, packageId, created);
        }
        InstanceBinding memory binding = instanceBinding[predicted];
        if (binding.strategyAccount != strategyAccount || binding.packageId != packageId) revert InstanceMismatch();
        return PremiaV3TypedOptionAdapter(predicted);
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
        returns (PremiaV3TypedOptionAdapter.Deployment memory)
    {
        return PremiaV3TypedOptionAdapter.Deployment({
            chainId: _deployment.chainId,
            strategyAccount: strategyAccount,
            packageId: packageId,
            pool: _deployment.pool,
            baseToken: _deployment.baseToken,
            quoteToken: _deployment.quoteToken,
            poolToken: _deployment.poolToken,
            oracleAdapter: _deployment.oracleAdapter,
            strike: _deployment.strike,
            maturity: _deployment.maturity,
            isCallPool: _deployment.isCallPool,
            strategyAccountCodeHash: _deployment.strategyAccountCodeHash,
            poolCodeHash: _deployment.poolCodeHash,
            baseTokenCodeHash: _deployment.baseTokenCodeHash,
            quoteTokenCodeHash: _deployment.quoteTokenCodeHash,
            oracleAdapterCodeHash: _deployment.oracleAdapterCodeHash
        });
    }

    function _assertDeployment() private view {
        if (
            block.chainid != _deployment.chainId
                || address(_deployment.accountFactory).codehash != _deployment.accountFactoryCodeHash
                || _deployment.accountFactory.accountCodeHash() != _deployment.strategyAccountCodeHash
                || address(_deployment.pool).codehash != _deployment.poolCodeHash
                || address(_deployment.baseToken).codehash != _deployment.baseTokenCodeHash
                || address(_deployment.quoteToken).codehash != _deployment.quoteTokenCodeHash
                || _deployment.oracleAdapter.codehash != _deployment.oracleAdapterCodeHash
        ) revert DeploymentChanged();
        (address base, address quote, address oracle, uint256 strike, uint256 maturity, bool isCall) =
            _deployment.pool.getPoolSettings();
        if (
            base != address(_deployment.baseToken) || quote != address(_deployment.quoteToken)
                || oracle != _deployment.oracleAdapter || strike != _deployment.strike
                || maturity != _deployment.maturity || isCall != _deployment.isCallPool
        ) revert DeploymentChanged();
    }

    function _salt(address strategyAccount, bytes32 packageId) private pure returns (bytes32) {
        return keccak256(abi.encode(strategyAccount, packageId));
    }
}
