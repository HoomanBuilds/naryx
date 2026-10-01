// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {DeployBaseSepoliaAtomicPackage} from "../script/DeployBaseSepoliaAtomicPackage.s.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {NaryxStrategyAccount} from "../src/NaryxStrategyAccount.sol";
import {NaryxTestPerpMarket} from "../src/conformance/NaryxTestPerpMarket.sol";
import {UniswapV3SpotPort} from "../src/UniswapV3SpotPort.sol";
import {AggregatorV3Interface} from "../src/interfaces/IAggregatorV3.sol";

contract DeployBaseSepoliaAtomicPackageTest is Test {
    uint256 private constant FORK_BLOCK = 47_200_000;
    bytes32 private constant DOMAIN_MANIFEST_HASH = keccak256("base-sepolia-domain-manifest-v1");
    bytes32 private constant TEMPLATE_MANIFEST_HASH = keccak256("cash-carry-template-manifest-v1");
    address private constant ETH_USD_FEED = 0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1;

    function testDeploysWiredPausedCompositionAndFailsClosedAcrossChains() public {
        vm.createSelectFork("https://sepolia.base.org", FORK_BLOCK);
        DeployBaseSepoliaAtomicPackage script = new DeployBaseSepoliaAtomicPackage();
        address proposer = makeAddr("proposer");
        address canceller = makeAddr("canceller");
        address executor = makeAddr("executor");
        address pauser = makeAddr("pauser");
        address solver = makeAddr("solver");
        address strategyOwner = makeAddr("strategyOwner");
        DeployBaseSepoliaAtomicPackage.Parameters memory parameters = DeployBaseSepoliaAtomicPackage.Parameters({
            domainManifestVersion: 1,
            domainManifestHash: DOMAIN_MANIFEST_HASH,
            cashCarryTemplateManifestHash: TEMPLATE_MANIFEST_HASH,
            configDelaySeconds: 1 days,
            proposer: proposer,
            canceller: canceller,
            executor: executor,
            pauser: pauser,
            solver: solver,
            perpetualMarket: _perpetualMarket(script.USDC())
        });

        DeployBaseSepoliaAtomicPackage.Deployment memory deployment = script.deploy(parameters);

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
        assertEq(address(deployment.strategyAccountFactory.verifier()), address(deployment.verifier));
        NaryxStrategyAccount strategyAccount = deployment.strategyAccountFactory.create(strategyOwner);
        assertEq(address(strategyAccount), deployment.strategyAccountFactory.accountOf(strategyOwner));
        assertEq(strategyAccount.owner(), strategyOwner);
        assertEq(address(strategyAccount).codehash, deployment.strategyAccountFactory.accountCodeHash());
        assertEq(deployment.spotPort.verifier(), address(deployment.verifier));
        assertEq(deployment.spotPort.factory(), script.UNISWAP_FACTORY());
        assertEq(deployment.spotPort.pool(), script.UNISWAP_POOL());
        assertEq(address(deployment.spotPort.baseToken()), script.WETH());
        assertEq(address(deployment.spotPort.quoteToken()), script.USDC());
        assertEq(deployment.spotPort.deploymentChainId(), script.BASE_SEPOLIA_CHAIN_ID());
        assertEq(address(deployment.perpetualMarket.collateral()), script.USDC());
        assertEq(deployment.perpetualMarket.collateralScale(), 1e12);
        assertEq(deployment.perpetualMarket.deploymentChainId(), script.BASE_SEPOLIA_CHAIN_ID());
        // Read-only: the pinned fork block's live feed passes every oracle check.
        assertGt(deployment.perpetualMarket.oraclePriceWad(), 0);

        vm.chainId(8453);
        vm.expectRevert(UniswapV3SpotPort.DeploymentChanged.selector);
        deployment.spotPort.assertDeployment();
        vm.expectRevert(NaryxTestPerpMarket.InvalidChain.selector);
        deployment.perpetualMarket
            .getPosition(address(deployment.perpetualMarket), type(uint32).max, address(strategyAccount));
        vm.expectRevert(DeployBaseSepoliaAtomicPackage.InvalidChain.selector);
        script.deploy(parameters);

        vm.chainId(84532);
        parameters.perpetualMarket.collateral = IERC20(script.WETH());
        vm.expectRevert(DeployBaseSepoliaAtomicPackage.InvalidPerpetualCollateral.selector);
        script.deploy(parameters);
    }

    function _perpetualMarket(address usdc) private returns (NaryxTestPerpMarket.Parameters memory) {
        return NaryxTestPerpMarket.Parameters({
            owner: makeAddr("marketOwner"),
            fundingKeeper: makeAddr("fundingKeeper"),
            feeRecipient: makeAddr("feeRecipient"),
            collateral: IERC20(usdc),
            oracle: AggregatorV3Interface(ETH_USD_FEED),
            expiry: type(uint32).max,
            maxOracleAgeSeconds: 1 days,
            takerFeeBps: 5,
            halfSpreadBps: 2,
            impactBps: 1,
            impactSizeWad: 10e18,
            initialMarginBps: 1_000,
            maintenanceMarginBps: 500,
            liquidationPenaltyBps: 50,
            maxPositionSizeWad: 10e18,
            maxMarginWad: 100_000e18,
            maxAbsFundingRatePerSecond: 1e15
        });
    }
}
