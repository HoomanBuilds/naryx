// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {Create2} from "openzeppelin-contracts/utils/Create2.sol";
import {SynFuturesTypedPerpAdapter} from "./SynFuturesTypedPerpAdapter.sol";
import {INaryxMultiStrategyAccountFactory} from "./interfaces/INaryxMultiStrategyAccountFactory.sol";
import {IPerpMarginGate} from "./interfaces/IPerpMarginGate.sol";
import {ISynFuturesInstrument} from "./interfaces/ISynFuturesInstrument.sol";
import {ISynFuturesPositionObserver} from "./interfaces/ISynFuturesPositionObserver.sol";
import {ITypedStrategyAdapterFactory} from "./interfaces/ITypedStrategyAdapterFactory.sol";

contract SynFuturesTypedPerpAdapterFactory is ITypedStrategyAdapterFactory {
    bytes32 public constant ADAPTER_CLASS_ID = keccak256("naryx.evm.perp-exact");
    uint32 public constant ADAPTER_CLASS_VERSION = 1;

    struct Deployment {
        uint256 chainId;
        INaryxMultiStrategyAccountFactory accountFactory;
        IERC20 baseToken;
        IERC20 collateralToken;
        ISynFuturesInstrument instrument;
        ISynFuturesPositionObserver observer;
        IPerpMarginGate marginGate;
        uint32 expiry;
        bytes32 accountFactoryCodeHash;
        bytes32 strategyAccountCodeHash;
        bytes32 baseTokenCodeHash;
        bytes32 collateralTokenCodeHash;
        bytes32 instrumentCodeHash;
        bytes32 observerCodeHash;
        bytes32 marginGateCodeHash;
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
    IERC20 public immutable baseToken;
    IERC20 public immutable collateralToken;
    ISynFuturesInstrument public immutable instrument;
    ISynFuturesPositionObserver public immutable observer;
    IPerpMarginGate public immutable marginGate;
    uint32 public immutable expiry;
    bytes32 public immutable accountFactoryCodeHash;
    bytes32 public immutable strategyAccountCodeHash;
    bytes32 public immutable baseTokenCodeHash;
    bytes32 public immutable collateralTokenCodeHash;
    bytes32 public immutable instrumentCodeHash;
    bytes32 public immutable observerCodeHash;
    bytes32 public immutable marginGateCodeHash;

    mapping(address instance => InstanceBinding binding) public instanceBinding;

    constructor(Deployment memory deployment) {
        if (
            deployment.chainId == 0 || address(deployment.accountFactory).code.length == 0
                || address(deployment.baseToken).code.length == 0
                || address(deployment.collateralToken).code.length == 0
                || address(deployment.baseToken) == address(deployment.collateralToken)
                || address(deployment.instrument).code.length == 0 || address(deployment.observer).code.length == 0
                || address(deployment.marginGate).code.length == 0 || deployment.expiry == 0
                || deployment.accountFactoryCodeHash == bytes32(0) || deployment.strategyAccountCodeHash == bytes32(0)
                || deployment.baseTokenCodeHash == bytes32(0) || deployment.collateralTokenCodeHash == bytes32(0)
                || deployment.instrumentCodeHash == bytes32(0) || deployment.observerCodeHash == bytes32(0)
                || deployment.marginGateCodeHash == bytes32(0)
        ) revert InvalidConfiguration();
        deploymentChainId = deployment.chainId;
        accountFactory = deployment.accountFactory;
        baseToken = deployment.baseToken;
        collateralToken = deployment.collateralToken;
        instrument = deployment.instrument;
        observer = deployment.observer;
        marginGate = deployment.marginGate;
        expiry = deployment.expiry;
        accountFactoryCodeHash = deployment.accountFactoryCodeHash;
        strategyAccountCodeHash = deployment.strategyAccountCodeHash;
        baseTokenCodeHash = deployment.baseTokenCodeHash;
        collateralTokenCodeHash = deployment.collateralTokenCodeHash;
        instrumentCodeHash = deployment.instrumentCodeHash;
        observerCodeHash = deployment.observerCodeHash;
        marginGateCodeHash = deployment.marginGateCodeHash;
        _assertDeployment();
    }

    function factoryMetadata() external view returns (bytes32, uint32, address, address) {
        return (ADAPTER_CLASS_ID, ADAPTER_CLASS_VERSION, address(baseToken), address(collateralToken));
    }

    function adapterOf(address strategyAccount, bytes32 packageId) public view returns (address) {
        return Create2.computeAddress(
            _salt(strategyAccount, packageId),
            keccak256(
                abi.encodePacked(
                    type(SynFuturesTypedPerpAdapter).creationCode,
                    abi.encode(_adapterDeployment(strategyAccount, packageId))
                )
            )
        );
    }

    function create(address strategyAccount, bytes32 packageId) external returns (SynFuturesTypedPerpAdapter instance) {
        _assertDeployment();
        if (!accountFactory.isAccount(strategyAccount) || strategyAccount.codehash != strategyAccountCodeHash) {
            revert InvalidStrategyAccount();
        }
        if (packageId == bytes32(0)) revert InvalidPackage();
        address predicted = adapterOf(strategyAccount, packageId);
        if (predicted.code.length == 0) {
            address created = address(
                new SynFuturesTypedPerpAdapter{salt: _salt(strategyAccount, packageId)}(
                    _adapterDeployment(strategyAccount, packageId)
                )
            );
            if (created != predicted) revert InstanceMismatch();
            instanceBinding[created] = InstanceBinding(strategyAccount, packageId);
            emit InstanceCreated(strategyAccount, packageId, created);
        }
        InstanceBinding memory binding = instanceBinding[predicted];
        if (binding.strategyAccount != strategyAccount || binding.packageId != packageId) revert InstanceMismatch();
        return SynFuturesTypedPerpAdapter(predicted);
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
        returns (SynFuturesTypedPerpAdapter.Deployment memory)
    {
        return SynFuturesTypedPerpAdapter.Deployment({
            chainId: deploymentChainId,
            strategyAccount: strategyAccount,
            packageId: packageId,
            baseToken: baseToken,
            collateralToken: collateralToken,
            instrument: instrument,
            observer: observer,
            marginGate: marginGate,
            expiry: expiry,
            strategyAccountCodeHash: strategyAccountCodeHash,
            baseTokenCodeHash: baseTokenCodeHash,
            collateralTokenCodeHash: collateralTokenCodeHash,
            instrumentCodeHash: instrumentCodeHash,
            observerCodeHash: observerCodeHash,
            marginGateCodeHash: marginGateCodeHash
        });
    }

    function _assertDeployment() private view {
        if (
            block.chainid != deploymentChainId || address(accountFactory).codehash != accountFactoryCodeHash
                || accountFactory.accountCodeHash() != strategyAccountCodeHash
                || address(baseToken).codehash != baseTokenCodeHash
                || address(collateralToken).codehash != collateralTokenCodeHash
                || address(instrument).codehash != instrumentCodeHash || address(observer).codehash != observerCodeHash
                || address(marginGate).codehash != marginGateCodeHash
                || address(marginGate.collateral()) != address(collateralToken)
        ) revert DeploymentChanged();
    }

    function _salt(address strategyAccount, bytes32 packageId) private pure returns (bytes32) {
        return keccak256(abi.encode(strategyAccount, packageId));
    }
}
