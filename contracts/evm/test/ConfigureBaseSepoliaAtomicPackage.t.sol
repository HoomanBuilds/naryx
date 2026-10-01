// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ConfigureBaseSepoliaAtomicPackage} from "../script/ConfigureBaseSepoliaAtomicPackage.s.sol";
import {DeployBaseSepoliaAtomicPackage} from "../script/DeployBaseSepoliaAtomicPackage.s.sol";
import {CashCarrySeriesRegistry} from "../src/CashCarrySeriesRegistry.sol";
import {PackageQuoteShard} from "../src/PackageQuoteShard.sol";
import {PackageQuoteShardRegistry} from "../src/PackageQuoteShardRegistry.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {ResourceRegistry} from "../src/ResourceRegistry.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {NaryxTestPerpMarket} from "../src/conformance/NaryxTestPerpMarket.sol";
import {AggregatorV3Interface} from "../src/interfaces/IAggregatorV3.sol";

contract ConfigureBaseSepoliaAtomicPackageTest is Test {
    uint256 private constant FORK_BLOCK = 47_200_000;
    uint64 private constant DELAY = 10;
    bytes32 private constant PROVISIONAL_DOMAIN_MANIFEST_HASH = keccak256("base-sepolia-provisional-domain-manifest");
    bytes32 private constant DOMAIN_MANIFEST_HASH = keccak256("base-sepolia-domain-manifest-v2");
    bytes32 private constant TEMPLATE_MANIFEST_HASH = keccak256("cash-carry-template-manifest-v1");
    bytes32 private constant SERIES_MANIFEST_HASH = keccak256("base-weth-usdc-cash-carry-series-v1");
    bytes32 private constant EXECUTION_CLASS_MANIFEST_HASH = keccak256("base-atomic-execution-class-v1");
    bytes32 private constant SHARD_MANIFEST_HASH = keccak256("base-package-quote-shard-v1");

    address private proposer;
    address private canceller;
    address private executor;
    address private pauser;
    address private solver;
    ConfigureBaseSepoliaAtomicPackage private operator;
    ConfigureBaseSepoliaAtomicPackage.Route private route;

    function setUp() public {
        vm.createSelectFork("https://sepolia.base.org", FORK_BLOCK);
        vm.warp(1_000);
        proposer = makeAddr("proposer");
        canceller = makeAddr("canceller");
        executor = makeAddr("executor");
        pauser = makeAddr("pauser");
        solver = makeAddr("solver");

        DeployBaseSepoliaAtomicPackage deployer = new DeployBaseSepoliaAtomicPackage();
        DeployBaseSepoliaAtomicPackage.Deployment memory deployed = deployer.deploy(
            DeployBaseSepoliaAtomicPackage.Parameters({
                domainManifestVersion: 1,
                domainManifestHash: PROVISIONAL_DOMAIN_MANIFEST_HASH,
                cashCarryTemplateManifestHash: TEMPLATE_MANIFEST_HASH,
                configDelaySeconds: DELAY,
                proposer: proposer,
                canceller: canceller,
                executor: executor,
                pauser: pauser,
                solver: solver,
                perpetualMarket: NaryxTestPerpMarket.Parameters({
                    owner: makeAddr("marketOwner"),
                    fundingKeeper: makeAddr("fundingKeeper"),
                    feeRecipient: makeAddr("feeRecipient"),
                    collateral: IERC20(0x036CbD53842c5426634e7929541eC2318f3dCF7e),
                    oracle: AggregatorV3Interface(0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1),
                    expiry: type(uint32).max,
                    maxOracleAgeSeconds: 1 hours,
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
                })
            })
        );

        PackageQuoteShard shard = new PackageQuoteShard(
            PackageQuoteShard.Deployment({
                chainId: block.chainid,
                config: address(deployed.config),
                configCodeHash: address(deployed.config).codehash,
                solver: solver,
                consumer: address(deployed.verifier),
                consumerCodeHash: address(deployed.verifier).codehash,
                seriesManifestHash: SERIES_MANIFEST_HASH,
                executionClassManifestHash: EXECUTION_CLASS_MANIFEST_HASH
            }),
            PackageQuoteShard.Limits({maxHeartbeatSeconds: 5 minutes, maxBatchSize: 8, maxLevelCount: 32})
        );

        operator = new ConfigureBaseSepoliaAtomicPackage();
        route.config = deployed.config;
        route.domainManifestVersion = 2;
        route.domainManifestHash = DOMAIN_MANIFEST_HASH;
        route.solverRegistry = deployed.solverRegistry;
        route.resources = deployed.resourceRegistry;
        route.seriesRegistry = deployed.cashCarrySeriesRegistry;
        route.quoteRegistry = deployed.packageQuoteShardRegistry;
        route.verifier = deployed.verifier;
        route.strategyAccountFactory = deployed.strategyAccountFactory;
        route.spotPort = deployed.spotPort;
        route.testPerpMarket = deployed.perpetualMarket;
        route.quoteShard = shard;
        route.solver = solver;
        route.baseAsset = _manifest("asset:weth", "asset:weth:v1");
        route.quoteAsset = _manifest("asset:usdc", "asset:usdc:v1");
        route.spotVenue = _manifest("venue:uniswap-v3", "venue:uniswap-v3:v1");
        route.perpetualVenue = _manifest("venue:naryx-test-perp", "venue:naryx-test-perp:v1");
        route.spotMarket = _manifest("market:weth-usdc-v3", "market:weth-usdc-v3:v1");
        route.perpetualMarket = _manifest("market:weth-usdc-perp-test", "market:weth-usdc-perp-test:v1");
        route.spotAdapter = _manifest("adapter:base-uniswap-v3", "adapter:base-uniswap-v3:v1");
        route.perpetualAdapter =
            _manifest("adapter:base-package-verifier-perp", "adapter:base-package-verifier-perp:v1");
        route.seriesManifestHash = SERIES_MANIFEST_HASH;
        route.executionClassManifestHash = EXECUTION_CLASS_MANIFEST_HASH;
        route.seriesBindingVersion = 1;
        route.spotBaseAtomsPerPackageUnit = 1e18;
        route.perpetualQuantityWadPerPackageUnit = 1e18;
        route.quoteShardManifestVersion = 1;
        route.quoteShardManifestHash = SHARD_MANIFEST_HASH;
        route.maximumPackageNotionalQuoteAtoms = 5_000e6;
        route.spotMarketParameters = _marketParameters();
        route.perpetualMarketParameters = _marketParameters();
    }

    function testDelayedStagesRejectPrematureActivationAndEnableOnlyExactRoute() public {
        vm.expectRevert(ConfigureBaseSepoliaAtomicPackage.InvalidRoute.selector);
        operator.runProposeQuoteAsset(route, proposer);
        // A script step that reverts leaves its broadcast open.
        vm.stopBroadcast();
        operator.runProposeDomain(route.config, 2, DOMAIN_MANIFEST_HASH, proposer);
        vm.warp(block.timestamp + DELAY);
        operator.runActivateDomain(route.config, 2, DOMAIN_MANIFEST_HASH, executor);

        operator.runProposeQuoteAsset(route, proposer);
        uint64 readyAt = uint64(block.timestamp) + DELAY;

        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(ResourceRegistry.RegistrationProposalNotReady.selector, readyAt));
        route.resources.activateRegistration(ResourceRegistry.ResourceKind.ASSET, route.quoteAsset.subjectId);

        vm.warp(readyAt);
        operator.runActivateQuoteAsset(route, executor);

        operator.runProposeFoundation(route, proposer);
        vm.warp(block.timestamp + DELAY);
        operator.runActivateFoundation(route, executor);

        operator.runProposeMarketsAndSeries(route, proposer);
        vm.warp(block.timestamp + DELAY);
        operator.runActivateMarketsAndSeries(route, executor);

        operator.runProposeAdapters(route, proposer);
        vm.warp(block.timestamp + DELAY);
        operator.runActivateAdapters(route, executor);

        operator.runScheduleUnpause(route, proposer);
        assertTrue(route.config.entryPaused());
        readyAt = uint64(block.timestamp) + DELAY;
        vm.warp(readyAt - 1);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(ProtocolConfig.UnpauseNotReady.selector, readyAt));
        route.config.activateUnpause();

        vm.warp(readyAt);
        operator.runActivateEntry(route, executor);
        assertFalse(route.config.entryPaused());

        ResourceRegistry.CashCarryAdmission memory exactAdmission =
            operator.admission(route, route.maximumPackageNotionalQuoteAtoms);
        assertEq(route.resources.validateCashCarry(exactAdmission), route.maximumPackageNotionalQuoteAtoms);
        assertEq(exactAdmission.perpetual.adapter.localAddress, address(route.verifier));
        assertEq(exactAdmission.perpetual.market.localAddress, address(route.testPerpMarket));
        assertEq(exactAdmission.perpetual.venue.localAddress, address(route.testPerpMarket));
        CashCarrySeriesRegistry.BindingReference memory seriesRef = operator.seriesReference(route);
        assertEq(route.seriesRegistry.validateEntry(seriesRef).seriesManifestHash, SERIES_MANIFEST_HASH);
        PackageQuoteShardRegistry.ShardReference memory shardRef = operator.shardReference(route);
        assertEq(route.quoteRegistry.validateEntry(shardRef).shard, address(route.quoteShard));

        exactAdmission.spot.adapter.manifest.manifestHash = keccak256("wrong-adapter-manifest");
        vm.expectRevert();
        route.resources.validateCashCarry(exactAdmission);
    }

    function _manifest(string memory subject, string memory manifest)
        private
        pure
        returns (ResourceRegistry.ManifestRef memory)
    {
        return ResourceRegistry.ManifestRef({
            subjectId: keccak256(bytes(subject)), manifestVersion: 1, manifestHash: keccak256(bytes(manifest))
        });
    }

    function _marketParameters() private pure returns (ResourceRegistry.MarketParameters memory) {
        return ResourceRegistry.MarketParameters({
            baseLotAtoms: 1e18,
            quoteTickAtomsPerBaseLot: 1,
            minimumQuoteNotionalAtoms: 1,
            contractMultiplierNumerator: 1,
            contractMultiplierDenominator: 1,
            baseDecimals: 18,
            quoteDecimals: 6
        });
    }
}
