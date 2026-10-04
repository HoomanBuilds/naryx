// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ConfigureBaseSepoliaAtomicPackage} from "../script/ConfigureBaseSepoliaAtomicPackage.s.sol";
import {DeployBaseSepoliaAtomicPackage} from "../script/DeployBaseSepoliaAtomicPackage.s.sol";
import {CashCarrySeriesRegistry} from "../src/CashCarrySeriesRegistry.sol";
import {PackageQuoteShard} from "../src/PackageQuoteShard.sol";
import {PackageQuoteShardRegistry} from "../src/PackageQuoteShardRegistry.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {ResourceRegistry} from "../src/ResourceRegistry.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {NaryxTestPerpMarket} from "../src/conformance/NaryxTestPerpMarket.sol";
import {AggregatorV3Interface} from "../src/interfaces/IAggregatorV3.sol";

contract ConfigureBaseSepoliaAtomicPackageTest is Test {
    uint256 private constant FORK_BLOCK = 47_200_000;
    uint64 private constant DELAY = 10;
    bytes32 private constant PROVISIONAL_DOMAIN_MANIFEST_HASH = keccak256("base-sepolia-provisional-domain-manifest");
    bytes32 private constant SERIES_MANIFEST_HASH = keccak256("base-weth-usdc-cash-carry-series-v1");
    bytes32 private constant EXECUTION_CLASS_MANIFEST_HASH = keccak256("base-atomic-execution-class-v1");
    bytes32 private constant SHARD_MANIFEST_HASH = keccak256("base-package-quote-shard-v1");

    address private proposer;
    address private canceller;
    address private executor;
    address private pauser;
    address private solver;
    ConfigureBaseSepoliaAtomicPackage private operator;
    PolicyRegistry private policyRegistry;
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
                configDelaySeconds: DELAY,
                proposer: proposer,
                canceller: canceller,
                executor: executor,
                pauser: pauser,
                solver: solver,
                quote: DeployBaseSepoliaAtomicPackage.SpotQuote({
                    token: IERC20(0x036CbD53842c5426634e7929541eC2318f3dCF7e),
                    tokenCodeHash: 0xedc5281a85c0efecd49999a1ef668390c59b88702f2d4a07029d7f5d63059d6c,
                    pool: 0x46880b404CD35c165EDdefF7421019F8dD25F4Ad,
                    poolCodeHash: 0xbbda0bdc9da3fd1f4832633a5ea75dc401ca24fdbca3d64a2511f27583ec7c4d,
                    poolFee: 3000
                }),
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
        policyRegistry = deployed.policyRegistry;
        route.config = deployed.config;
        // The reviewed domain manifest commits to the deployed verifier's runtime code hash, and the template
        // manifest lists that domain reference, so both hashes exist only after deployment.
        route.domainManifestVersion = 2;
        route.domainManifestHash =
            keccak256(abi.encode("naryx-domain-manifest", uint32(2), address(deployed.verifier).codehash));
        route.cashCarryTemplateManifestHash = keccak256(
            abi.encode("naryx-cash-carry-template-manifest", route.domainManifestVersion, route.domainManifestHash)
        );
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
        bytes32 verifierCodeHash = address(route.verifier).codehash;
        bytes32 resourcesCodeHash = address(route.resources).codehash;
        bytes32 seriesCodeHash = address(route.seriesRegistry).codehash;
        operator.runProposeDomain(route.config, 2, route.domainManifestHash, proposer);
        vm.warp(block.timestamp + DELAY);
        operator.runActivateDomain(route.config, 2, route.domainManifestHash, executor);

        // Registrations bind the active template, so none can run before it is set.
        vm.expectRevert(ConfigureBaseSepoliaAtomicPackage.InvalidRoute.selector);
        operator.runProposeQuoteAsset(route, proposer);
        vm.stopBroadcast();
        operator.runProposeTemplate(
            route.config, 2, route.domainManifestHash, route.cashCarryTemplateManifestHash, proposer
        );
        vm.warp(block.timestamp + DELAY);
        operator.runActivateTemplate(
            route.config, 2, route.domainManifestHash, route.cashCarryTemplateManifestHash, executor
        );
        assertEq(route.resources.cashCarryTemplateManifestHash(), route.cashCarryTemplateManifestHash);
        assertEq(route.seriesRegistry.cashCarryTemplateManifestHash(), route.cashCarryTemplateManifestHash);
        // Setting the template changes no code hash, so the domain manifest's verifier code hash still holds.
        assertEq(address(route.verifier).codehash, verifierCodeHash);
        assertEq(address(route.resources).codehash, resourcesCodeHash);
        assertEq(address(route.seriesRegistry).codehash, seriesCodeHash);
        assertEq(route.verifier.resourceRegistryCodeHash(), resourcesCodeHash);
        assertEq(route.verifier.cashCarrySeriesRegistryCodeHash(), seriesCodeHash);

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

    function testSolverFeePolicyStartsDisabledAndChangesOnlyAfterDelay() public {
        bytes32 subject = operator.SOLVER_FEE_POLICY_SUBJECT_ID();
        assertEq(policyRegistry.policy(PolicyRegistry.PolicyKind.FEE_POLICY, subject).version, 0);

        bytes32 versionOneHash = keccak256("base-solver-fee-policy-v1");
        operator.runProposeSolverFeePolicy(route.config, route.verifier, policyRegistry, 1, versionOneHash, 0, proposer);
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.ProposalNotReady.selector, uint64(1_000 + DELAY)));
        operator.runActivateSolverFeePolicy(
            route.config, route.verifier, policyRegistry, 1, versionOneHash, 0, executor
        );
        vm.stopBroadcast();

        vm.warp(1_000 + DELAY);
        operator.runActivateSolverFeePolicy(
            route.config, route.verifier, policyRegistry, 1, versionOneHash, 0, executor
        );
        assertEq(policyRegistry.policy(PolicyRegistry.PolicyKind.FEE_POLICY, subject).maximumFeeBps, 0);

        bytes32 versionTwoHash = keccak256("base-solver-fee-policy-v2");
        operator.runProposeSolverFeePolicy(route.config, route.verifier, policyRegistry, 2, versionTwoHash, 1, proposer);
        vm.warp(block.timestamp + DELAY);
        operator.runActivateSolverFeePolicy(
            route.config, route.verifier, policyRegistry, 2, versionTwoHash, 1, executor
        );
        PolicyRegistry.Policy memory current = policyRegistry.policy(PolicyRegistry.PolicyKind.FEE_POLICY, subject);
        assertEq(current.version, 2);
        assertEq(current.maximumFeeBps, 1);
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
