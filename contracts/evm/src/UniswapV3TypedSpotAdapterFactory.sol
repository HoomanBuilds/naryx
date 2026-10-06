// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "openzeppelin-contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Create2} from "openzeppelin-contracts/utils/Create2.sol";
import {UniswapV3TypedSpotAdapter, ITypedUniswapV3Factory, ITypedUniswapV3Pool} from "./UniswapV3TypedSpotAdapter.sol";
import {INaryxMultiStrategyAccountFactory} from "./interfaces/INaryxMultiStrategyAccountFactory.sol";
import {ITypedStrategyAdapterFactory} from "./interfaces/ITypedStrategyAdapterFactory.sol";

contract UniswapV3TypedSpotAdapterFactory is ITypedStrategyAdapterFactory {
    bytes32 public constant ADAPTER_CLASS_ID = keccak256("naryx.evm.spot-exact");
    uint32 public constant ADAPTER_CLASS_VERSION = 1;

    struct Deployment {
        uint256 chainId;
        INaryxMultiStrategyAccountFactory accountFactory;
        address factory;
        address pool;
        IERC20 baseToken;
        IERC20 quoteToken;
        uint8 baseTokenDecimals;
        uint8 quoteTokenDecimals;
        uint24 poolFee;
        bytes32 accountFactoryCodeHash;
        bytes32 strategyAccountCodeHash;
        bytes32 factoryCodeHash;
        bytes32 poolCodeHash;
        bytes32 baseTokenCodeHash;
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

    uint256 public immutable deploymentChainId;
    INaryxMultiStrategyAccountFactory public immutable accountFactory;
    address public immutable factory;
    address public immutable pool;
    IERC20 public immutable baseToken;
    IERC20 public immutable quoteToken;
    uint8 public immutable baseTokenDecimals;
    uint8 public immutable quoteTokenDecimals;
    uint24 public immutable poolFee;
    bytes32 public immutable accountFactoryCodeHash;
    bytes32 public immutable strategyAccountCodeHash;
    bytes32 public immutable factoryCodeHash;
    bytes32 public immutable poolCodeHash;
    bytes32 public immutable baseTokenCodeHash;
    bytes32 public immutable quoteTokenCodeHash;

    mapping(address instance => InstanceBinding binding) public instanceBinding;

    constructor(Deployment memory deployment) {
        if (
            deployment.chainId == 0 || address(deployment.accountFactory).code.length == 0
                || deployment.factory.code.length == 0 || deployment.pool.code.length == 0
                || address(deployment.baseToken).code.length == 0 || address(deployment.quoteToken).code.length == 0
                || address(deployment.baseToken) == address(deployment.quoteToken) || deployment.poolFee == 0
                || deployment.accountFactoryCodeHash == bytes32(0) || deployment.strategyAccountCodeHash == bytes32(0)
                || deployment.factoryCodeHash == bytes32(0) || deployment.poolCodeHash == bytes32(0)
                || deployment.baseTokenCodeHash == bytes32(0) || deployment.quoteTokenCodeHash == bytes32(0)
        ) revert InvalidConfiguration();
        deploymentChainId = deployment.chainId;
        accountFactory = deployment.accountFactory;
        factory = deployment.factory;
        pool = deployment.pool;
        baseToken = deployment.baseToken;
        quoteToken = deployment.quoteToken;
        baseTokenDecimals = deployment.baseTokenDecimals;
        quoteTokenDecimals = deployment.quoteTokenDecimals;
        poolFee = deployment.poolFee;
        accountFactoryCodeHash = deployment.accountFactoryCodeHash;
        strategyAccountCodeHash = deployment.strategyAccountCodeHash;
        factoryCodeHash = deployment.factoryCodeHash;
        poolCodeHash = deployment.poolCodeHash;
        baseTokenCodeHash = deployment.baseTokenCodeHash;
        quoteTokenCodeHash = deployment.quoteTokenCodeHash;
        _assertDeployment();
    }

    function factoryMetadata() external view returns (bytes32, uint32, address, address) {
        return (ADAPTER_CLASS_ID, ADAPTER_CLASS_VERSION, address(baseToken), address(quoteToken));
    }

    function adapterOf(address strategyAccount, bytes32 packageId) public view returns (address) {
        return Create2.computeAddress(
            _salt(strategyAccount, packageId),
            keccak256(
                abi.encodePacked(
                    type(UniswapV3TypedSpotAdapter).creationCode,
                    abi.encode(_adapterDeployment(strategyAccount, packageId))
                )
            )
        );
    }

    function create(address strategyAccount, bytes32 packageId) external returns (UniswapV3TypedSpotAdapter instance) {
        _assertDeployment();
        if (!accountFactory.isAccount(strategyAccount) || strategyAccount.codehash != strategyAccountCodeHash) {
            revert InvalidStrategyAccount();
        }
        if (packageId == bytes32(0)) revert InvalidPackage();
        address predicted = adapterOf(strategyAccount, packageId);
        if (predicted.code.length == 0) {
            address created = address(
                new UniswapV3TypedSpotAdapter{salt: _salt(strategyAccount, packageId)}(
                    _adapterDeployment(strategyAccount, packageId)
                )
            );
            if (created != predicted) revert InstanceMismatch();
            instanceBinding[created] = InstanceBinding(strategyAccount, packageId);
            emit InstanceCreated(strategyAccount, packageId, created);
        }
        InstanceBinding memory binding = instanceBinding[predicted];
        if (binding.strategyAccount != strategyAccount || binding.packageId != packageId) revert InstanceMismatch();
        return UniswapV3TypedSpotAdapter(predicted);
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
        returns (UniswapV3TypedSpotAdapter.Deployment memory)
    {
        return UniswapV3TypedSpotAdapter.Deployment({
            chainId: deploymentChainId,
            strategyAccount: strategyAccount,
            packageId: packageId,
            factory: factory,
            pool: pool,
            baseToken: baseToken,
            quoteToken: quoteToken,
            baseTokenDecimals: baseTokenDecimals,
            quoteTokenDecimals: quoteTokenDecimals,
            poolFee: poolFee,
            strategyAccountCodeHash: strategyAccountCodeHash,
            factoryCodeHash: factoryCodeHash,
            poolCodeHash: poolCodeHash,
            baseTokenCodeHash: baseTokenCodeHash,
            quoteTokenCodeHash: quoteTokenCodeHash
        });
    }

    function _assertDeployment() private view {
        if (
            block.chainid != deploymentChainId || address(accountFactory).codehash != accountFactoryCodeHash
                || accountFactory.accountCodeHash() != strategyAccountCodeHash || factory.codehash != factoryCodeHash
                || pool.codehash != poolCodeHash || address(baseToken).codehash != baseTokenCodeHash
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
                || ITypedUniswapV3Pool(pool).fee() != poolFee || !tokensMatch
        ) revert DeploymentChanged();
    }

    function _salt(address strategyAccount, bytes32 packageId) private pure returns (bytes32) {
        return keccak256(abi.encode(strategyAccount, packageId));
    }
}
