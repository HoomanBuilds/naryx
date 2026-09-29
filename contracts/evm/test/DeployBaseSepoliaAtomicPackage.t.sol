// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {DeployBaseSepoliaAtomicPackage} from "../script/DeployBaseSepoliaAtomicPackage.s.sol";
import {NaryxBaseSepoliaPerpTestSupport} from "../src/conformance/NaryxBaseSepoliaPerpTestSupport.sol";
import {UniswapV3SpotPort} from "../src/UniswapV3SpotPort.sol";

contract DeployBaseSepoliaAtomicPackageTest is Test {
    uint256 private constant FORK_BLOCK = 47_200_000;
    bytes32 private constant DOMAIN_MANIFEST_HASH = keccak256("base-sepolia-domain-manifest-v1");
    bytes32 private constant TEMPLATE_MANIFEST_HASH = keccak256("cash-carry-template-manifest-v1");

    function testDeploysWiredPausedCompositionAndFailsClosedAcrossChains() public {
        vm.createSelectFork("https://sepolia.base.org", FORK_BLOCK);
        DeployBaseSepoliaAtomicPackage script = new DeployBaseSepoliaAtomicPackage();
        address proposer = makeAddr("proposer");
        address canceller = makeAddr("canceller");
        address executor = makeAddr("executor");
        address pauser = makeAddr("pauser");
        address solver = makeAddr("solver");
        address strategyOwner = makeAddr("strategyOwner");
        address conformanceOwner = makeAddr("conformanceOwner");

        DeployBaseSepoliaAtomicPackage.Deployment memory deployment = script.deploy(
            DeployBaseSepoliaAtomicPackage.Parameters({
                domainManifestVersion: 1,
                domainManifestHash: DOMAIN_MANIFEST_HASH,
                cashCarryTemplateManifestHash: TEMPLATE_MANIFEST_HASH,
                configDelaySeconds: 1 days,
                proposer: proposer,
                canceller: canceller,
                executor: executor,
                pauser: pauser,
                solver: solver,
                strategyOwner: strategyOwner,
                conformanceOwner: conformanceOwner,
                perpetualExpiry: 4_102_444_800,
                perpetualEntryPriceWad: 2_000e18,
                maximumPerpetualSizeWad: 10e18,
                maximumPerpetualBalanceWad: 100_000e18
            })
        );

        assertTrue(deployment.config.entryPaused());
        (string memory domainId, uint32 domainManifestVersion, bytes32 domainManifestHash) = deployment.config.domain();
        assertEq(domainId, script.DOMAIN_ID());
        assertEq(domainManifestVersion, 1);
        assertEq(domainManifestHash, DOMAIN_MANIFEST_HASH);
        assertTrue(deployment.solverRegistry.isActiveSolver(solver));
        assertEq(deployment.solverRegistry.activeSolverCount(), 1);
        assertEq(address(deployment.resourceRegistry.config()), address(deployment.config));
        assertEq(deployment.resourceRegistry.cashCarryTemplateManifestHash(), TEMPLATE_MANIFEST_HASH);
        assertEq(address(deployment.cashCarrySeriesRegistry.resources()), address(deployment.resourceRegistry));
        assertEq(address(deployment.packageQuoteShardRegistry.config()), address(deployment.config));
        assertEq(address(deployment.verifier.config()), address(deployment.config));
        assertEq(address(deployment.verifier.solverRegistry()), address(deployment.solverRegistry));
        assertEq(address(deployment.verifier.resourceRegistry()), address(deployment.resourceRegistry));
        assertEq(address(deployment.verifier.cashCarrySeriesRegistry()), address(deployment.cashCarrySeriesRegistry));
        assertEq(
            address(deployment.verifier.packageQuoteShardRegistry()), address(deployment.packageQuoteShardRegistry)
        );
        assertEq(address(deployment.strategyAccount.verifier()), address(deployment.verifier));
        assertEq(deployment.strategyAccount.owner(), strategyOwner);
        assertEq(deployment.spotPort.verifier(), address(deployment.verifier));
        assertEq(deployment.spotPort.factory(), script.UNISWAP_FACTORY());
        assertEq(deployment.spotPort.pool(), script.UNISWAP_POOL());
        assertEq(address(deployment.spotPort.baseToken()), script.WETH());
        assertEq(address(deployment.spotPort.quoteToken()), script.USDC());
        assertEq(deployment.spotPort.deploymentChainId(), script.BASE_SEPOLIA_CHAIN_ID());
        assertEq(deployment.perpetualTestSupport.strategyAccount(), address(deployment.strategyAccount));
        assertEq(deployment.perpetualTestSupport.owner(), conformanceOwner);
        assertEq(deployment.perpetualTestSupport.deploymentChainId(), script.BASE_SEPOLIA_CHAIN_ID());

        vm.chainId(8453);
        vm.expectRevert(UniswapV3SpotPort.DeploymentChanged.selector);
        deployment.spotPort.assertDeployment();
        vm.expectRevert(NaryxBaseSepoliaPerpTestSupport.InvalidChain.selector);
        deployment.perpetualTestSupport
            .getPosition(address(deployment.perpetualTestSupport), 4_102_444_800, address(deployment.strategyAccount));
        vm.expectRevert(DeployBaseSepoliaAtomicPackage.InvalidChain.selector);
        script.deploy(
            DeployBaseSepoliaAtomicPackage.Parameters({
                domainManifestVersion: 1,
                domainManifestHash: DOMAIN_MANIFEST_HASH,
                cashCarryTemplateManifestHash: TEMPLATE_MANIFEST_HASH,
                configDelaySeconds: 1 days,
                proposer: proposer,
                canceller: canceller,
                executor: executor,
                pauser: pauser,
                solver: solver,
                strategyOwner: strategyOwner,
                conformanceOwner: conformanceOwner,
                perpetualExpiry: 4_102_444_800,
                perpetualEntryPriceWad: 2_000e18,
                maximumPerpetualSizeWad: 10e18,
                maximumPerpetualBalanceWad: 100_000e18
            })
        );
    }
}
