// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {Clones} from "openzeppelin-contracts/proxy/Clones.sol";
import {GmxV2IsolatedAccount} from "./GmxV2IsolatedAccount.sol";
import {IExactSpotPort} from "./interfaces/IExactSpotPort.sol";
import {GmxV2, IGmxV2ExchangeRouter} from "./interfaces/IGmxV2.sol";
import {ISpotFillRecorder} from "./interfaces/ISpotFillRecorder.sol";

interface IGmxV2FactoryBoundAdapter {
    function factory() external view returns (address);
}

interface IGmxV2FactoryBoundExitController {
    function factory() external view returns (address);
    function entryAdapter() external view returns (address);
}

/// @notice Creates one `GmxV2IsolatedAccount` per owner: an ERC-1167 minimal clone of one reviewed
/// implementation, deployed with CREATE2 salt `keccak256(abi.encode(owner))`, so the address depends only
/// on the owner and every account shares the runtime code hash `accountCodeHash`. The deployer binds the
/// shared entry adapter, exit controller, spot port, and implementation once, before any account exists.
/// The factory is the spot port's verifier and forwards each fill record to the factory account that
/// traded. Creation is permissionless; nobody but the owner's signature can act for an account.
contract GmxV2IsolatedAccountFactory is ISpotFillRecorder {
    error InvalidConfiguration();
    error AlreadyConfigured();
    error NotConfigured();
    error UnauthorizedCaller();
    error InvalidOwner();
    error AccountCodeMismatch();
    error UnknownAccount();

    event Configured(
        address indexed adapter, address indexed exitController, address indexed spotPort, bytes32 accountCodeHash
    );
    event AccountCreated(address indexed owner, address indexed account);

    address public immutable configurator;
    uint256 public immutable deploymentChainId;
    address public immutable market;
    IERC20 public immutable collateralToken;
    bytes32 public immutable deploymentHash;

    address public adapter;
    bytes32 public adapterCodeHash;
    address public exitController;
    bytes32 public exitControllerCodeHash;
    IExactSpotPort public spotPort;
    bytes32 public spotPortCodeHash;
    address public implementation;
    bytes32 public accountCodeHash;

    /// @notice The owner of every account this factory created. Zero for the implementation and for every
    /// address the factory did not create.
    mapping(address account => address accountOwner) public ownerOf;

    constructor(address market_, IERC20 collateralToken_, GmxV2.Deployment memory deployment) {
        if (market_.code.length == 0 || address(collateralToken_).code.length == 0) revert InvalidConfiguration();
        _validateDeployment(deployment);
        configurator = msg.sender;
        deploymentChainId = block.chainid;
        market = market_;
        collateralToken = collateralToken_;
        deploymentHash = keccak256(abi.encode(deployment));
    }

    /// @notice One-time binding of the shared route. Each contract must already name this factory, and the
    /// implementation must carry exactly this route as its immutables.
    function configure(
        address adapter_,
        bytes32 adapterCodeHash_,
        address exitController_,
        bytes32 exitControllerCodeHash_,
        IExactSpotPort spotPort_,
        bytes32 spotPortCodeHash_,
        GmxV2IsolatedAccount implementation_
    ) external {
        if (msg.sender != configurator) revert UnauthorizedCaller();
        if (accountCodeHash != bytes32(0)) revert AlreadyConfigured();
        if (
            block.chainid != deploymentChainId || adapter_ == address(0) || adapterCodeHash_ == bytes32(0)
                || adapter_.codehash != adapterCodeHash_ || exitController_ == address(0)
                || exitControllerCodeHash_ == bytes32(0) || exitController_.codehash != exitControllerCodeHash_
                || address(spotPort_) == address(0) || spotPortCodeHash_ == bytes32(0)
                || address(spotPort_).codehash != spotPortCodeHash_
                || IGmxV2FactoryBoundAdapter(adapter_).factory() != address(this)
                || IGmxV2FactoryBoundExitController(exitController_).factory() != address(this)
                || IGmxV2FactoryBoundExitController(exitController_).entryAdapter() != adapter_
                || spotPort_.verifier() != address(this) || spotPort_.verifierCodeHash() != address(this).codehash
        ) revert InvalidConfiguration();
        _verifyImplementation(
            implementation_, adapter_, adapterCodeHash_, exitController_, exitControllerCodeHash_, spotPort_, spotPortCodeHash_
        );
        adapter = adapter_;
        adapterCodeHash = adapterCodeHash_;
        exitController = exitController_;
        exitControllerCodeHash = exitControllerCodeHash_;
        spotPort = spotPort_;
        spotPortCodeHash = spotPortCodeHash_;
        implementation = address(implementation_);
        accountCodeHash = keccak256(
            abi.encodePacked(
                hex"363d3d373d3d3d363d73", address(implementation_), hex"5af43d82803e903d91602b57fd5bf3"
            )
        );
        emit Configured(adapter_, exitController_, address(spotPort_), accountCodeHash);
    }

    function _verifyImplementation(
        GmxV2IsolatedAccount implementation_,
        address adapter_,
        bytes32 adapterCodeHash_,
        address exitController_,
        bytes32 exitControllerCodeHash_,
        IExactSpotPort spotPort_,
        bytes32 spotPortCodeHash_
    ) private view {
        if (
            address(implementation_).code.length == 0 || implementation_.factory() != address(this)
                || implementation_.owner() != address(0) || implementation_.market() != market
                || address(implementation_.collateralToken()) != address(collateralToken)
                || implementation_.deploymentHash() != deploymentHash
                || implementation_.entryController() != adapter_
                || implementation_.entryControllerCodeHash() != adapterCodeHash_
                || implementation_.exitController() != exitController_
                || implementation_.exitControllerCodeHash() != exitControllerCodeHash_
                || address(implementation_.spotPort()) != address(spotPort_)
                || implementation_.spotPortCodeHash() != spotPortCodeHash_
        ) revert InvalidConfiguration();
        implementation_.assertDeployment();
    }

    /// @notice The account created, or to be created, for `owner`.
    function accountOf(address owner) public view returns (address) {
        if (implementation == address(0)) revert NotConfigured();
        return Clones.predictDeterministicAddress(implementation, _salt(owner));
    }

    /// @notice Permissionless and idempotent: returns the existing account when it is already deployed.
    function create(address owner) external returns (GmxV2IsolatedAccount account) {
        if (owner == address(0) || owner == address(this)) revert InvalidOwner();
        if (accountCodeHash == bytes32(0)) revert NotConfigured();
        if (block.chainid != deploymentChainId) revert InvalidConfiguration();
        address predicted = accountOf(owner);
        if (predicted.code.length == 0) {
            address created = Clones.cloneDeterministic(implementation, _salt(owner));
            if (created != predicted) revert AccountCodeMismatch();
            ownerOf[created] = owner;
            GmxV2IsolatedAccount(created).initialize(owner);
            emit AccountCreated(owner, created);
        }
        if (
            predicted.codehash != accountCodeHash || ownerOf[predicted] != owner
                || GmxV2IsolatedAccount(predicted).owner() != owner
        ) revert AccountCodeMismatch();
        return GmxV2IsolatedAccount(predicted);
    }

    /// @notice True only for an account this factory created, still carrying the shared runtime code.
    function isAccount(address account) public view returns (bool) {
        return accountCodeHash != bytes32(0) && ownerOf[account] != address(0) && account.codehash == accountCodeHash;
    }

    /// @notice The created account of `owner`; reverts when it is missing or its code changed.
    function requireAccount(address owner) external view returns (GmxV2IsolatedAccount account) {
        address predicted = accountOf(owner);
        if (owner == address(0) || ownerOf[predicted] != owner || !isAccount(predicted)) revert UnknownAccount();
        return GmxV2IsolatedAccount(predicted);
    }

    /// @notice The spot port reports a fill for the account that called it; only a factory account is
    /// accepted, and that account checks the fill against its own armed expectation.
    function recordSpotFill(
        address strategyAccount,
        uint256 packageNonce,
        bytes32 spotFillCommitment,
        bytes32 orderHash,
        bytes32 quoteHash,
        bytes32 routeHash,
        uint8 action,
        address baseToken,
        address quoteToken,
        uint256 baseAtoms,
        uint256 quoteAtoms
    ) external {
        if (
            accountCodeHash == bytes32(0) || msg.sender != address(spotPort)
                || msg.sender.codehash != spotPortCodeHash
        ) revert UnauthorizedCaller();
        if (!isAccount(strategyAccount)) revert UnknownAccount();
        GmxV2IsolatedAccount(strategyAccount)
            .recordSpotFill(
                strategyAccount,
                packageNonce,
                spotFillCommitment,
                orderHash,
                quoteHash,
                routeHash,
                action,
                baseToken,
                quoteToken,
                baseAtoms,
                quoteAtoms
            );
    }

    function _salt(address owner) private pure returns (bytes32) {
        return keccak256(abi.encode(owner));
    }

    function _validateDeployment(GmxV2.Deployment memory deployment) private view {
        if (
            deployment.dataStore == address(0) || deployment.eventEmitter == address(0)
                || deployment.exchangeRouter == address(0) || deployment.router == address(0)
                || deployment.orderVault == address(0) || deployment.orderHandler == address(0)
                || deployment.roleStore == address(0) || deployment.dataStore.codehash != deployment.dataStoreCodeHash
                || deployment.eventEmitter.codehash != deployment.eventEmitterCodeHash
                || deployment.exchangeRouter.codehash != deployment.exchangeRouterCodeHash
                || deployment.router.codehash != deployment.routerCodeHash
                || deployment.orderVault.codehash != deployment.orderVaultCodeHash
                || deployment.orderHandler.codehash != deployment.orderHandlerCodeHash
                || deployment.roleStore.codehash != deployment.roleStoreCodeHash
        ) revert InvalidConfiguration();
        IGmxV2ExchangeRouter exchange = IGmxV2ExchangeRouter(deployment.exchangeRouter);
        if (
            exchange.dataStore() != deployment.dataStore || exchange.eventEmitter() != deployment.eventEmitter
                || exchange.router() != deployment.router || exchange.orderHandler() != deployment.orderHandler
                || exchange.roleStore() != deployment.roleStore
        ) revert InvalidConfiguration();
    }
}
