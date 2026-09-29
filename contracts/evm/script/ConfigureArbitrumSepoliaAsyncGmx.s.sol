// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {AsyncBondedPackageCoordinator} from "../src/AsyncBondedPackageCoordinator.sol";
import {GmxV2ArbitrumAdapter} from "../src/GmxV2ArbitrumAdapter.sol";
import {GmxV2IsolatedAccount} from "../src/GmxV2IsolatedAccount.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";

contract ConfigureArbitrumSepoliaAsyncGmx is Script {
    uint256 public constant ARBITRUM_SEPOLIA_CHAIN_ID = 421614;
    bytes32 public constant DOMAIN_ID_HASH = keccak256("eip155:421614");

    struct Route {
        ProtocolConfig config;
        bytes32 configCodeHash;
        AsyncBondedPackageCoordinator coordinator;
        bytes32 coordinatorCodeHash;
        GmxV2IsolatedAccount isolatedAccount;
        bytes32 isolatedAccountCodeHash;
        GmxV2ArbitrumAdapter adapter;
        bytes32 adapterCodeHash;
    }

    error InvalidChain();
    error InvalidOperator();
    error InvalidRoute();

    function runBindEntryController(Route calldata route, address operatorAddress) external {
        _requireOperator(route, operatorAddress, 0);
        vm.startBroadcast(operatorAddress);
        _verifyRoute(route);
        route.isolatedAccount.configureEntryController(address(route.adapter), route.adapterCodeHash);
        vm.stopBroadcast();
    }

    function runProposeAdmission(Route calldata route, address operatorAddress) external {
        _requireOperator(route, operatorAddress, 1);
        vm.startBroadcast(operatorAddress);
        _verifyRoute(route);
        if (
            route.isolatedAccount.entryController() != address(route.adapter)
                || route.isolatedAccount.entryControllerCodeHash() != route.adapterCodeHash
        ) revert InvalidRoute();
        route.coordinator
            .proposeAdmission(
                address(route.adapter), address(route.adapter), route.adapterCodeHash, route.adapterCodeHash
            );
        vm.stopBroadcast();
    }

    function runActivateAdmission(Route calldata route, address operatorAddress) external {
        _requireOperator(route, operatorAddress, 2);
        vm.startBroadcast(operatorAddress);
        _verifyRoute(route);
        route.coordinator.activateAdmission(address(route.adapter));
        if (!route.config.entryPaused()) revert InvalidRoute();
        vm.stopBroadcast();
    }

    function _verifyRoute(Route calldata route) private view {
        if (block.chainid != ARBITRUM_SEPOLIA_CHAIN_ID) revert InvalidChain();
        if (
            address(route.config).codehash != route.configCodeHash
                || address(route.coordinator).codehash != route.coordinatorCodeHash
                || address(route.isolatedAccount).codehash != route.isolatedAccountCodeHash
                || address(route.adapter).codehash != route.adapterCodeHash || route.configCodeHash == bytes32(0)
                || route.coordinatorCodeHash == bytes32(0) || route.isolatedAccountCodeHash == bytes32(0)
                || route.adapterCodeHash == bytes32(0) || address(route.coordinator.config()) != address(route.config)
                || route.coordinator.deploymentChainId() != ARBITRUM_SEPOLIA_CHAIN_ID
                || route.coordinator.deploymentDomainIdHash() != DOMAIN_ID_HASH
                || address(route.coordinator.bondToken()) != address(route.isolatedAccount.collateralToken())
                || address(route.adapter.isolatedAccount()) != address(route.isolatedAccount)
                || !route.config.entryPaused()
        ) revert InvalidRoute();
    }

    function _requireOperator(Route calldata route, address operatorAddress, uint8 role) private view {
        (address proposer,, address executor,) = route.config.roles();
        address required = role == 0 ? route.isolatedAccount.owner() : role == 1 ? proposer : executor;
        if (operatorAddress == address(0) || operatorAddress != required) revert InvalidOperator();
    }
}
