// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {ConfigureArbitrumSepoliaAsyncGmx} from "../script/ConfigureArbitrumSepoliaAsyncGmx.s.sol";
import {DeployArbitrumSepoliaAsyncGmx} from "../script/DeployArbitrumSepoliaAsyncGmx.s.sol";
import {AsyncBondedPackageCoordinator} from "../src/AsyncBondedPackageCoordinator.sol";
import {GmxV2ExitController} from "../src/GmxV2ExitController.sol";
import {UniswapV3SpotPort} from "../src/UniswapV3SpotPort.sol";

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
    address private fundingAuthority;
    address private beneficiary;

    function testComposesExactPausedRouteAndRejectsWrongDependencyAndEarlyActivation() public {
        vm.createSelectFork("https://sepolia-rollup.arbitrum.io/rpc", FORK_BLOCK);
        vm.warp(1_000);
        proposer = makeAddr("proposer");
        canceller = makeAddr("canceller");
        executor = makeAddr("executor");
        pauser = makeAddr("pauser");
        fundingAuthority = makeAddr("fundingAuthority");
        beneficiary = makeAddr("beneficiary");

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
        assertEq(deployment.coordinator.executionClassManifestHash(), EXECUTION_CLASS_MANIFEST_HASH);
        assertEq(deployment.isolatedAccount.owner(), beneficiary);
        assertEq(deployment.isolatedAccount.fundingAuthority(), fundingAuthority);
        assertEq(deployment.isolatedAccount.market(), ETH_USD_MARKET);
        assertEq(address(deployment.isolatedAccount.collateralToken()), USDC);
        assertEq(address(deployment.adapter.isolatedAccount()), address(deployment.isolatedAccount));

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
            coordinator: deployment.coordinator,
            coordinatorCodeHash: address(deployment.coordinator).codehash,
            isolatedAccount: deployment.isolatedAccount,
            isolatedAccountCodeHash: address(deployment.isolatedAccount).codehash,
            adapter: deployment.adapter,
            adapterCodeHash: address(deployment.adapter).codehash,
            exitController: GmxV2ExitController(address(0)),
            exitControllerCodeHash: bytes32(0),
            spotPort: UniswapV3SpotPort(address(0)),
            spotPortCodeHash: bytes32(0)
        });

        operator.runBindEntryController(route, beneficiary);
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
        assertEq(deployment.isolatedAccount.entryController(), address(deployment.adapter));
        assertTrue(deployment.config.entryPaused());

        vm.chainId(42161);
        vm.expectRevert(ConfigureArbitrumSepoliaAsyncGmx.InvalidChain.selector);
        operator.runProposeAdmission(route, proposer);
    }

    function _parameters(DeployArbitrumSepoliaAsyncGmx deployer)
        private
        view
        returns (DeployArbitrumSepoliaAsyncGmx.Parameters memory parameters)
    {
        parameters = DeployArbitrumSepoliaAsyncGmx.Parameters({
            domainManifestVersion: 1,
            domainManifestHash: DOMAIN_MANIFEST_HASH,
            configDelaySeconds: DELAY,
            proposer: proposer,
            canceller: canceller,
            executor: executor,
            pauser: pauser,
            fundingAuthority: fundingAuthority,
            beneficiary: beneficiary,
            market: ETH_USD_MARKET,
            marketCodeHash: ETH_USD_MARKET.codehash,
            collateralToken: IERC20(USDC),
            collateralTokenCodeHash: USDC.codehash,
            executionClassManifestHash: EXECUTION_CLASS_MANIFEST_HASH,
            gmxCodeHashes: DeployArbitrumSepoliaAsyncGmx.GmxCodeHashes({
                dataStore: deployer.GMX_DATA_STORE().codehash,
                eventEmitter: deployer.GMX_EVENT_EMITTER().codehash,
                exchangeRouter: deployer.GMX_EXCHANGE_ROUTER().codehash,
                router: deployer.GMX_ROUTER().codehash,
                orderVault: deployer.GMX_ORDER_VAULT().codehash,
                orderHandler: deployer.GMX_ORDER_HANDLER().codehash,
                roleStore: deployer.GMX_ROLE_STORE().codehash
            })
        });
    }
}
