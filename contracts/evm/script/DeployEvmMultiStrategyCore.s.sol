// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {Strings} from "openzeppelin-contracts/utils/Strings.sol";
import {NaryxMultiStrategyAccountFactory} from "../src/NaryxMultiStrategyAccountFactory.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {SolverRegistry} from "../src/SolverRegistry.sol";
import {StrategyFeePolicyRegistry} from "../src/StrategyFeePolicyRegistry.sol";
import {TypedStrategyAdapterRegistry} from "../src/TypedStrategyAdapterRegistry.sol";

contract DeployEvmMultiStrategyCore is Script {
    using Strings for uint256;

    struct Parameters {
        uint256 expectedChainId;
        uint32 expectedDomainManifestVersion;
        bytes32 expectedDomainManifestHash;
        ProtocolConfig config;
        SolverRegistry solverRegistry;
        bytes32 feePolicySubjectId;
    }

    struct Deployment {
        TypedStrategyAdapterRegistry adapterRegistry;
        StrategyFeePolicyRegistry feePolicyRegistry;
        NaryxMultiStrategyAccountFactory accountFactory;
    }

    error InvalidChain();
    error InvalidDomain();
    error InvalidConfiguration();

    function run(Parameters calldata parameters) external returns (Deployment memory deployment) {
        vm.startBroadcast();
        deployment = deploy(parameters);
        vm.stopBroadcast();
    }

    function deploy(Parameters calldata parameters) public returns (Deployment memory deployment) {
        if (parameters.expectedChainId == 0 || block.chainid != parameters.expectedChainId) revert InvalidChain();
        if (
            address(parameters.config).code.length == 0 || address(parameters.solverRegistry).code.length == 0
                || parameters.expectedDomainManifestVersion == 0 || parameters.expectedDomainManifestHash == bytes32(0)
                || parameters.feePolicySubjectId == bytes32(0)
                || address(parameters.solverRegistry.config()) != address(parameters.config)
        ) revert InvalidConfiguration();

        (string memory domainId, uint32 manifestVersion, bytes32 manifestHash) = parameters.config.domain();
        string memory expectedDomainId = string.concat("eip155:", block.chainid.toString());
        if (
            keccak256(bytes(domainId)) != keccak256(bytes(expectedDomainId))
                || manifestVersion != parameters.expectedDomainManifestVersion
                || manifestHash != parameters.expectedDomainManifestHash
        ) revert InvalidDomain();

        deployment.adapterRegistry = new TypedStrategyAdapterRegistry(parameters.config);
        deployment.feePolicyRegistry = new StrategyFeePolicyRegistry(parameters.config);
        deployment.accountFactory = new NaryxMultiStrategyAccountFactory(
            parameters.config,
            parameters.solverRegistry,
            deployment.adapterRegistry,
            deployment.feePolicyRegistry,
            parameters.feePolicySubjectId
        );
    }
}
