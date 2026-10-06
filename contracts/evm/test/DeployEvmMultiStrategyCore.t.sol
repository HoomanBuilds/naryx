// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {DeployEvmMultiStrategyCore} from "../script/DeployEvmMultiStrategyCore.s.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {SolverRegistry} from "../src/SolverRegistry.sol";

contract DeployEvmMultiStrategyCoreTest is Test {
    uint256 private constant CHAIN_ID = 84_532;
    bytes32 private constant DOMAIN_MANIFEST_HASH = keccak256("base-sepolia-domain-v1");
    bytes32 private constant FEE_POLICY_SUBJECT_ID = keccak256("naryx.multi-strategy.fees");

    DeployEvmMultiStrategyCore private script;
    ProtocolConfig private config;
    SolverRegistry private solverRegistry;

    function setUp() public {
        vm.chainId(CHAIN_ID);
        config = new ProtocolConfig(
            "eip155:84532", 1, DOMAIN_MANIFEST_HASH, 1, address(0x101), address(0x102), address(0x103), address(0x104)
        );
        solverRegistry = new SolverRegistry(config, address(0x201));
        script = new DeployEvmMultiStrategyCore();
    }

    function testDeploysCoreAgainstReviewedDomain() public {
        DeployEvmMultiStrategyCore.Deployment memory deployment = script.deploy(_parameters());

        assertEq(address(deployment.adapterRegistry.config()), address(config));
        assertEq(address(deployment.feePolicyRegistry.config()), address(config));
        assertEq(address(deployment.accountFactory.config()), address(config));
        assertEq(address(deployment.accountFactory.solverRegistry()), address(solverRegistry));
        assertEq(address(deployment.accountFactory.adapterRegistry()), address(deployment.adapterRegistry));
        assertEq(address(deployment.accountFactory.feePolicyRegistry()), address(deployment.feePolicyRegistry));
        assertEq(deployment.accountFactory.feePolicySubjectId(), FEE_POLICY_SUBJECT_ID);
        assertTrue(deployment.accountFactory.referenceAccount().code.length > 0);
    }

    function testRejectsDomainThatDoesNotMatchChainIdentity() public {
        ProtocolConfig wrongConfig = new ProtocolConfig(
            "eip155:421614", 1, DOMAIN_MANIFEST_HASH, 1, address(0x101), address(0x102), address(0x103), address(0x104)
        );
        SolverRegistry wrongSolverRegistry = new SolverRegistry(wrongConfig, address(0x201));
        DeployEvmMultiStrategyCore.Parameters memory parameters = _parameters();
        parameters.config = wrongConfig;
        parameters.solverRegistry = wrongSolverRegistry;

        vm.expectRevert(DeployEvmMultiStrategyCore.InvalidDomain.selector);
        script.deploy(parameters);
    }

    function _parameters() private view returns (DeployEvmMultiStrategyCore.Parameters memory) {
        return DeployEvmMultiStrategyCore.Parameters({
            expectedChainId: CHAIN_ID,
            expectedDomainManifestVersion: 1,
            expectedDomainManifestHash: DOMAIN_MANIFEST_HASH,
            config: config,
            solverRegistry: solverRegistry,
            feePolicySubjectId: FEE_POLICY_SUBJECT_ID
        });
    }
}
