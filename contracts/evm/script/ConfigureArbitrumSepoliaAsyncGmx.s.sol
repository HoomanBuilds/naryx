// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {AsyncBondedPackageCoordinator} from "../src/AsyncBondedPackageCoordinator.sol";
import {GmxV2ArbitrumAdapter} from "../src/GmxV2ArbitrumAdapter.sol";
import {GmxV2ExitController} from "../src/GmxV2ExitController.sol";
import {GmxV2IsolatedAccount} from "../src/GmxV2IsolatedAccount.sol";
import {GmxV2IsolatedAccountFactory} from "../src/GmxV2IsolatedAccountFactory.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {UniswapV3SpotPort} from "../src/UniswapV3SpotPort.sol";

contract ConfigureArbitrumSepoliaAsyncGmx is Script {
    uint256 public constant ARBITRUM_SEPOLIA_CHAIN_ID = 421614;
    bytes32 public constant DOMAIN_ID_HASH = keccak256("eip155:421614");

    uint8 private constant PROPOSER = 1;
    uint8 private constant EXECUTOR = 2;

    struct Route {
        ProtocolConfig config;
        bytes32 configCodeHash;
        uint32 domainManifestVersion;
        bytes32 domainManifestHash;
        AsyncBondedPackageCoordinator coordinator;
        bytes32 coordinatorCodeHash;
        GmxV2IsolatedAccountFactory accountFactory;
        bytes32 accountFactoryCodeHash;
        GmxV2ArbitrumAdapter adapter;
        bytes32 adapterCodeHash;
        GmxV2ExitController exitController;
        bytes32 exitControllerCodeHash;
        UniswapV3SpotPort spotPort;
        bytes32 spotPortCodeHash;
        bytes32 accountCodeHash;
    }

    error InvalidChain();
    error InvalidOperator();
    error InvalidRoute();

    /// @notice Proposes the reviewed domain manifest. The deployment starts on a provisional manifest
    /// because the reviewed one commits to execution verifier code that exists only after deployment.
    function runProposeDomain(
        ProtocolConfig config,
        uint32 manifestVersion,
        bytes32 manifestHash,
        address operatorAddress
    ) external {
        _requireConfigRole(config, operatorAddress, PROPOSER);
        vm.startBroadcast(operatorAddress);
        _verifyDomainStep(config);
        config.proposeDomain(manifestVersion, manifestHash);
        vm.stopBroadcast();
    }

    function runActivateDomain(
        ProtocolConfig config,
        uint32 manifestVersion,
        bytes32 manifestHash,
        address operatorAddress
    ) external {
        _requireConfigRole(config, operatorAddress, EXECUTOR);
        vm.startBroadcast(operatorAddress);
        _verifyDomainStep(config);
        (bool exists, uint32 pendingVersion, bytes32 pendingHash,) = config.pendingDomain();
        if (!exists || pendingVersion != manifestVersion || pendingHash != manifestHash) revert InvalidRoute();
        config.activateDomain();
        vm.stopBroadcast();
    }

    function runProposeAdmission(Route calldata route, address operatorAddress) external {
        _requireOperator(route, operatorAddress, PROPOSER);
        vm.startBroadcast(operatorAddress);
        _verifyPausedRoute(route);
        route.coordinator
            .proposeAdmission(
                address(route.adapter), address(route.adapter), route.adapterCodeHash, route.adapterCodeHash
            );
        vm.stopBroadcast();
    }

    function runActivateAdmission(Route calldata route, address operatorAddress) external {
        _requireOperator(route, operatorAddress, EXECUTOR);
        vm.startBroadcast(operatorAddress);
        _verifyPausedRoute(route);
        route.coordinator.activateAdmission(address(route.adapter));
        if (!route.config.entryPaused()) revert InvalidRoute();
        vm.stopBroadcast();
    }

    function runScheduleUnpause(Route calldata route, address operatorAddress) external {
        _requireOperator(route, operatorAddress, PROPOSER);
        vm.startBroadcast(operatorAddress);
        _verifyPausedRoute(route);
        _verifyEntryReady(route);
        route.config.scheduleUnpause();
        vm.stopBroadcast();
    }

    function runActivateEntry(Route calldata route, address operatorAddress) external {
        _requireOperator(route, operatorAddress, EXECUTOR);
        vm.startBroadcast(operatorAddress);
        _verifyPausedRoute(route);
        _verifyEntryReady(route);
        route.config.activateUnpause();
        verifyActiveRoute(route);
        vm.stopBroadcast();
    }

    /// @notice Read-only check of the final state: the exact route is bound and entry is open.
    function verifyActiveRoute(Route calldata route) public view {
        _verifyRoute(route);
        _verifyEntryReady(route);
        if (route.config.entryPaused()) revert InvalidRoute();
    }

    function _verifyPausedRoute(Route calldata route) private view {
        _verifyRoute(route);
        if (!route.config.entryPaused()) revert InvalidRoute();
    }

    function _verifyRoute(Route calldata route) private view {
        if (block.chainid != ARBITRUM_SEPOLIA_CHAIN_ID) revert InvalidChain();
        (string memory domainId, uint32 manifestVersion, bytes32 manifestHash) = route.config.domain();
        if (
            address(route.config).codehash != route.configCodeHash
                || address(route.coordinator).codehash != route.coordinatorCodeHash
                || address(route.accountFactory).codehash != route.accountFactoryCodeHash
                || address(route.adapter).codehash != route.adapterCodeHash || route.configCodeHash == bytes32(0)
                || route.coordinatorCodeHash == bytes32(0) || route.accountFactoryCodeHash == bytes32(0)
                || route.adapterCodeHash == bytes32(0) || address(route.coordinator.config()) != address(route.config)
                || route.coordinator.deploymentChainId() != ARBITRUM_SEPOLIA_CHAIN_ID
                || route.coordinator.deploymentDomainIdHash() != DOMAIN_ID_HASH
                || address(route.coordinator.bondToken()) != address(route.accountFactory.collateralToken())
                || address(route.adapter.factory()) != address(route.accountFactory)
                || keccak256(bytes(domainId)) != DOMAIN_ID_HASH || manifestVersion != route.domainManifestVersion
                || manifestHash != route.domainManifestHash
        ) revert InvalidRoute();
        _verifyFactoryBinding(route);
    }

    /// @notice The factory binds exactly this adapter, exit controller, spot port, and account code.
    function _verifyFactoryBinding(Route calldata route) private view {
        GmxV2IsolatedAccountFactory factory = route.accountFactory;
        if (
            route.exitControllerCodeHash == bytes32(0) || route.spotPortCodeHash == bytes32(0)
                || route.accountCodeHash == bytes32(0)
                || address(route.exitController).codehash != route.exitControllerCodeHash
                || address(route.spotPort).codehash != route.spotPortCodeHash
                || factory.adapter() != address(route.adapter) || factory.adapterCodeHash() != route.adapterCodeHash
                || factory.exitController() != address(route.exitController)
                || factory.exitControllerCodeHash() != route.exitControllerCodeHash
                || address(factory.spotPort()) != address(route.spotPort)
                || factory.spotPortCodeHash() != route.spotPortCodeHash
                || factory.accountCodeHash() != route.accountCodeHash
                || address(route.exitController.entryAdapter()) != address(route.adapter)
                || address(route.exitController.factory()) != address(factory)
                || route.spotPort.verifier() != address(factory)
        ) revert InvalidRoute();
    }

    function _verifyEntryReady(Route calldata route) private view {
        (address handler, bytes32 adapterCodeHash, bytes32 handlerCodeHash, bool active,) =
            route.coordinator.admissions(address(route.adapter));
        if (
            !active || handler != address(route.adapter) || adapterCodeHash != route.adapterCodeHash
                || handlerCodeHash != route.adapterCodeHash
        ) revert InvalidRoute();
        GmxV2IsolatedAccount(route.accountFactory.implementation()).assertDeployment();
        route.spotPort.assertDeployment();
    }

    function _verifyDomainStep(ProtocolConfig config) private view {
        if (block.chainid != ARBITRUM_SEPOLIA_CHAIN_ID) revert InvalidChain();
        (string memory domainId,,) = config.domain();
        if (keccak256(bytes(domainId)) != DOMAIN_ID_HASH || !config.entryPaused()) revert InvalidRoute();
    }

    function _requireOperator(Route calldata route, address operatorAddress, uint8 role) private view {
        _requireConfigRole(route.config, operatorAddress, role);
    }

    function _requireConfigRole(ProtocolConfig config, address operatorAddress, uint8 role) private view {
        (address proposer,, address executor,) = config.roles();
        if (operatorAddress == address(0) || operatorAddress != (role == PROPOSER ? proposer : executor)) {
            revert InvalidOperator();
        }
    }
}
