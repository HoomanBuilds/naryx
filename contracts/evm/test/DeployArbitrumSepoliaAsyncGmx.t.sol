// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {ConfigureArbitrumSepoliaAsyncGmx} from "../script/ConfigureArbitrumSepoliaAsyncGmx.s.sol";
import {DeployArbitrumSepoliaAsyncGmx} from "../script/DeployArbitrumSepoliaAsyncGmx.s.sol";
import {AsyncBondedPackageCoordinator} from "../src/AsyncBondedPackageCoordinator.sol";
import {GmxV2ExitController} from "../src/GmxV2ExitController.sol";
import {UniswapV3SpotPort} from "../src/UniswapV3SpotPort.sol";
import {GmxSpotFactory, GmxSpotPool, GmxTestToken} from "./GmxV2ArbitrumAdapter.t.sol";

contract DeployArbitrumSepoliaAsyncGmxTest is Test {
    uint256 private constant FORK_BLOCK = 313_856_606;
    uint64 private constant DELAY = 10;
    address private constant ETH_USD_MARKET = 0x482Df3D320C964808579b585a8AC7Dd5D144eFaF;
    address private constant USDC = 0x3321Fd36aEaB0d5CdfD26f4A3A93E2D2aAcCB99f;
    bytes32 private constant DOMAIN_MANIFEST_HASH = keccak256("arbitrum-sepolia-domain-manifest-v1");
    bytes32 private constant EXECUTION_CLASS_MANIFEST_HASH = keccak256("gmx-v2-async-bonded-execution-v1");

    address private proposer;
    address private canceller;
    address private executor;
    address private pauser;

    function testComposesExactPausedRouteAndRejectsWrongDependencyAndEarlyActivation() public {
        string memory rpcUrl = vm.envOr("ARBITRUM_SEPOLIA_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) {
            vm.skip(true, "ARBITRUM_SEPOLIA_RPC_URL absent: skipping pinned Arbitrum Sepolia fork test");
        }
        vm.createSelectFork(rpcUrl, FORK_BLOCK);
        vm.warp(1_000);
        proposer = makeAddr("proposer");
        canceller = makeAddr("canceller");
        executor = makeAddr("executor");
        pauser = makeAddr("pauser");

        DeployArbitrumSepoliaAsyncGmx deployer = new DeployArbitrumSepoliaAsyncGmx();
        DeployArbitrumSepoliaAsyncGmx.Parameters memory parameters = _parameters(deployer);
        DeployArbitrumSepoliaAsyncGmx.Deployment memory deployment = deployer.deploy(parameters);

        assertTrue(deployment.config.entryPaused());
        (string memory domainId, uint32 manifestVersion, bytes32 manifestHash) = deployment.config.domain();
        assertEq(domainId, deployer.DOMAIN_ID());
        assertEq(manifestVersion, 1);
        assertEq(manifestHash, DOMAIN_MANIFEST_HASH);
        assertEq(address(deployment.coordinator.config()), address(deployment.config));
        assertEq(address(deployment.coordinator.bondToken()), USDC);
        assertEq(deployment.coordinator.deploymentChainId(), deployer.ARBITRUM_SEPOLIA_CHAIN_ID());
        assertEq(deployment.coordinator.deploymentDomainIdHash(), keccak256(bytes(deployer.DOMAIN_ID())));
        assertEq(deployment.coordinator.executionClassManifestHash(), bytes32(0));
        assertEq(deployment.accountFactory.market(), ETH_USD_MARKET);
        assertEq(address(deployment.accountFactory.collateralToken()), USDC);
        assertEq(address(deployment.adapter.factory()), address(deployment.accountFactory));
        assertEq(deployment.accountFactory.adapter(), address(deployment.adapter));
        assertEq(deployment.accountFactory.exitController(), address(deployment.exitController));
        assertEq(address(deployment.accountFactory.spotPort()), address(deployment.spotPort));
        assertEq(deployment.accountImplementation.owner(), address(0));

        parameters.gmxCodeHashes.eventEmitter = keccak256("wrong-event-emitter-code");
        vm.expectRevert(
            abi.encodeWithSelector(
                DeployArbitrumSepoliaAsyncGmx.InvalidDependency.selector, deployer.GMX_EVENT_EMITTER()
            )
        );
        deployer.deploy(parameters);

        ConfigureArbitrumSepoliaAsyncGmx operator = new ConfigureArbitrumSepoliaAsyncGmx();
        ConfigureArbitrumSepoliaAsyncGmx.Route memory route = ConfigureArbitrumSepoliaAsyncGmx.Route({
            config: deployment.config,
            configCodeHash: address(deployment.config).codehash,
            domainManifestVersion: 1,
            domainManifestHash: DOMAIN_MANIFEST_HASH,
            executionClassManifestHash: EXECUTION_CLASS_MANIFEST_HASH,
            coordinator: deployment.coordinator,
            coordinatorCodeHash: address(deployment.coordinator).codehash,
            accountFactory: deployment.accountFactory,
            accountFactoryCodeHash: address(deployment.accountFactory).codehash,
            adapter: deployment.adapter,
            adapterCodeHash: address(deployment.adapter).codehash,
            exitController: deployment.exitController,
            exitControllerCodeHash: address(deployment.exitController).codehash,
            spotPort: deployment.spotPort,
            spotPortCodeHash: address(deployment.spotPort).codehash,
            accountCodeHash: deployment.accountFactory.accountCodeHash()
        });

        operator.runProposeAdmission(route, proposer);
        uint64 readyAt = uint64(block.timestamp) + DELAY;
        vm.prank(executor);
        vm.expectRevert(AsyncBondedPackageCoordinator.AdmissionNotReady.selector);
        deployment.coordinator.activateAdmission(address(deployment.adapter));

        vm.warp(readyAt);
        operator.runActivateAdmission(route, executor);
        (address handler, bytes32 adapterCodeHash, bytes32 handlerCodeHash, bool active, uint64 generation) =
            deployment.coordinator.admissions(address(deployment.adapter));
        assertEq(handler, address(deployment.adapter));
        assertEq(adapterCodeHash, address(deployment.adapter).codehash);
        assertEq(handlerCodeHash, address(deployment.adapter).codehash);
        assertTrue(active);
        assertEq(generation, 1);
        assertTrue(deployment.config.entryPaused());

        vm.chainId(42161);
        vm.expectRevert(ConfigureArbitrumSepoliaAsyncGmx.InvalidChain.selector);
        operator.runProposeAdmission(route, proposer);
    }

    function _parameters(DeployArbitrumSepoliaAsyncGmx deployer)
        private
        returns (DeployArbitrumSepoliaAsyncGmx.Parameters memory parameters)
    {
        // No reviewed Arbitrum Sepolia Uniswap V3 pool is pinned, so the spot venue is a local test double.
        GmxTestToken baseToken = new GmxTestToken();
        GmxSpotFactory spotFactory = new GmxSpotFactory();
        GmxSpotPool pool = new GmxSpotPool(address(spotFactory), address(baseToken), USDC, 3000);
        spotFactory.setPool(address(baseToken), USDC, 3000, address(pool));
        parameters = DeployArbitrumSepoliaAsyncGmx.Parameters({
            domainManifestVersion: 1,
            domainManifestHash: DOMAIN_MANIFEST_HASH,
            configDelaySeconds: DELAY,
            proposer: proposer,
            canceller: canceller,
            executor: executor,
            pauser: pauser,
            market: ETH_USD_MARKET,
            marketCodeHash: ETH_USD_MARKET.codehash,
            collateralToken: IERC20(USDC),
            collateralTokenCodeHash: USDC.codehash,
            gmxCodeHashes: DeployArbitrumSepoliaAsyncGmx.GmxCodeHashes({
                dataStore: deployer.GMX_DATA_STORE().codehash,
                eventEmitter: deployer.GMX_EVENT_EMITTER().codehash,
                exchangeRouter: deployer.GMX_EXCHANGE_ROUTER().codehash,
                router: deployer.GMX_ROUTER().codehash,
                orderVault: deployer.GMX_ORDER_VAULT().codehash,
                orderHandler: deployer.GMX_ORDER_HANDLER().codehash,
                roleStore: deployer.GMX_ROLE_STORE().codehash
            }),
            spot: UniswapV3SpotPort.Deployment({
                chainId: block.chainid,
                factory: address(spotFactory),
                pool: address(pool),
                baseToken: baseToken,
                quoteToken: IERC20(USDC),
                baseTokenDecimals: 18,
                quoteTokenDecimals: 6,
                poolFee: 3000,
                factoryCodeHash: address(spotFactory).codehash,
                poolCodeHash: address(pool).codehash,
                baseTokenCodeHash: address(baseToken).codehash,
                quoteTokenCodeHash: USDC.codehash
            })
        });
    }
}
