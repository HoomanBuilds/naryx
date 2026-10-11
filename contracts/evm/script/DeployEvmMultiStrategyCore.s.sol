// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {Strings} from "openzeppelin-contracts/utils/Strings.sol";
import {NaryxMultiStrategyAccountFactory} from "../src/NaryxMultiStrategyAccountFactory.sol";
import {NaryxMultiStrategyAccountDeployer} from "../src/NaryxMultiStrategyAccountDeployer.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {RiskDomainRegistry} from "../src/RiskDomainRegistry.sol";
import {SolverRegistry} from "../src/SolverRegistry.sol";
import {StrategyFeePolicyRegistry} from "../src/StrategyFeePolicyRegistry.sol";
import {TypedStrategyAdapterRegistry} from "../src/TypedStrategyAdapterRegistry.sol";
import {TestnetChains} from "./TestnetChains.sol";

contract DeployEvmMultiStrategyCore is Script {
    using Strings for uint256;

    bytes32 public constant MULTI_STRATEGY_FEE_POLICY_SUBJECT_ID = keccak256("multi-strategy-fees");

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
        RiskDomainRegistry riskDomainRegistry;
        NaryxMultiStrategyAccountDeployer accountDeployer;
        NaryxMultiStrategyAccountFactory accountFactory;
    }

    struct FreshParameters {
        uint256 expectedChainId;
        uint32 expectedDomainManifestVersion;
        bytes32 expectedDomainManifestHash;
        ProtocolConfig config;
        address initialSolver;
        bytes32 feePolicySubjectId;
    }

    struct FreshDeployment {
        SolverRegistry solverRegistry;
        Deployment core;
    }

    error InvalidChain();
    error InvalidDomain();
    error InvalidConfiguration();

    function run(Parameters calldata parameters) external returns (Deployment memory deployment) {
        vm.startBroadcast();
        deployment = deploy(parameters);
        vm.stopBroadcast();
    }

    function runWithNewSolverRegistry(FreshParameters calldata parameters)
        external
        returns (FreshDeployment memory deployment)
    {
        vm.startBroadcast();
        deployment = deployWithNewSolverRegistry(parameters);
        vm.stopBroadcast();
    }

    function deploy(Parameters calldata parameters) public returns (Deployment memory deployment) {
        _requireDomain(
            parameters.expectedChainId,
            parameters.expectedDomainManifestVersion,
            parameters.expectedDomainManifestHash,
            parameters.config
        );
        if (
            address(parameters.solverRegistry).code.length == 0
                || parameters.feePolicySubjectId != MULTI_STRATEGY_FEE_POLICY_SUBJECT_ID
                || address(parameters.solverRegistry.config()) != address(parameters.config)
        ) revert InvalidConfiguration();

        deployment = _deploy(parameters.config, parameters.solverRegistry, parameters.feePolicySubjectId);
    }

    function deployWithNewSolverRegistry(FreshParameters calldata parameters)
        public
        returns (FreshDeployment memory deployment)
    {
        _requireDomain(
            parameters.expectedChainId,
            parameters.expectedDomainManifestVersion,
            parameters.expectedDomainManifestHash,
            parameters.config
        );
        if (
            parameters.initialSolver == address(0)
                || parameters.feePolicySubjectId != MULTI_STRATEGY_FEE_POLICY_SUBJECT_ID
        ) {
            revert InvalidConfiguration();
        }
        deployment.solverRegistry = new SolverRegistry(parameters.config, parameters.initialSolver);
        deployment.core = _deploy(parameters.config, deployment.solverRegistry, parameters.feePolicySubjectId);
    }

    function _requireDomain(
        uint256 expectedChainId,
        uint32 expectedDomainManifestVersion,
        bytes32 expectedDomainManifestHash,
        ProtocolConfig config
    ) private view {
        if (expectedChainId == 0 || block.chainid != expectedChainId || !TestnetChains.isAllowed(block.chainid)) {
            revert InvalidChain();
        }
        if (
            address(config).code.length == 0 || expectedDomainManifestVersion == 0
                || expectedDomainManifestHash == bytes32(0)
        ) revert InvalidConfiguration();

        (string memory domainId, uint32 manifestVersion, bytes32 manifestHash) = config.domain();
        string memory expectedDomainId = string.concat("eip155:", block.chainid.toString());
        if (
            keccak256(bytes(domainId)) != keccak256(bytes(expectedDomainId))
                || manifestVersion != expectedDomainManifestVersion || manifestHash != expectedDomainManifestHash
        ) revert InvalidDomain();
    }

    function _deploy(ProtocolConfig config, SolverRegistry solverRegistry, bytes32 feePolicySubjectId)
        private
        returns (Deployment memory deployment)
    {
        deployment.adapterRegistry = new TypedStrategyAdapterRegistry(config);
        deployment.feePolicyRegistry = new StrategyFeePolicyRegistry(config);
        deployment.riskDomainRegistry = new RiskDomainRegistry(config);
        deployment.accountDeployer = new NaryxMultiStrategyAccountDeployer();
        deployment.accountFactory = new NaryxMultiStrategyAccountFactory(
            config,
            solverRegistry,
            deployment.adapterRegistry,
            deployment.feePolicyRegistry,
            deployment.riskDomainRegistry,
            deployment.accountDeployer,
            feePolicySubjectId
        );
    }
}
