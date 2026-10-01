// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {ConfigureArbitrumSepoliaAsyncGmx} from "../script/ConfigureArbitrumSepoliaAsyncGmx.s.sol";
import {DeployArbitrumSepoliaAsyncGmx} from "../script/DeployArbitrumSepoliaAsyncGmx.s.sol";
import {AsyncBondedPackageCoordinator} from "../src/AsyncBondedPackageCoordinator.sol";
import {GmxV2ArbitrumAdapter} from "../src/GmxV2ArbitrumAdapter.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {UniswapV3SpotPort} from "../src/UniswapV3SpotPort.sol";
import {IAsyncVenueAdapter} from "../src/interfaces/IAsyncVenueAdapter.sol";
import {
    GmxSpotFactory,
    GmxSpotPool,
    GmxTestCode,
    GmxTestDataStore,
    GmxTestExchangeRouter,
    GmxTestOrderHandler,
    GmxTestOrderVault,
    GmxTestRoleStore,
    GmxTestRouter,
    GmxTestToken
} from "./GmxV2ArbitrumAdapter.t.sol";

/// Runs the Arbitrum Sepolia deploy and configure scripts end to end without a fork. The GMX test
/// doubles from the adapter tests are etched at the canonical addresses the scripts pin.
contract ConfigureArbitrumSepoliaAsyncGmxTest is Test {
    uint256 private constant OWNER_KEY = 0xB0B;
    uint64 private constant DELAY = 10;
    uint256 private constant COLLATERAL = 5_000_000;
    uint256 private constant SPOT_BASE = 1_000_000;
    uint256 private constant MAX_SPOT_QUOTE = 3_000_000;
    uint256 private constant EXECUTION_FEE = 0.002 ether;
    uint24 private constant POOL_FEE = 3000;
    bytes32 private constant PROVISIONAL_DOMAIN_MANIFEST_HASH =
        keccak256("arbitrum-sepolia-provisional-domain-manifest");
    bytes32 private constant DOMAIN_MANIFEST_HASH = keccak256("arbitrum-sepolia-domain-manifest-v2");
    bytes32 private constant EXECUTION_CLASS_MANIFEST_HASH = keccak256("gmx-v2-async-bonded-execution-v1");

    address private proposer;
    address private executor;
    address private owner;
    GmxTestToken private token;
    GmxTestToken private baseToken;
    GmxTestCode private market;
    DeployArbitrumSepoliaAsyncGmx private deployer;
    ConfigureArbitrumSepoliaAsyncGmx private operator;
    DeployArbitrumSepoliaAsyncGmx.Deployment private deployment;
    ConfigureArbitrumSepoliaAsyncGmx.Route private route;

    function setUp() public {
        vm.chainId(421614);
        vm.warp(1_000);
        vm.deal(address(this), 1 ether);
        proposer = makeAddr("proposer");
        executor = makeAddr("executor");
        owner = vm.addr(OWNER_KEY);
        deployer = new DeployArbitrumSepoliaAsyncGmx();
        operator = new ConfigureArbitrumSepoliaAsyncGmx();
        _etchGmx();
        token = new GmxTestToken();
        baseToken = new GmxTestToken();
        market = new GmxTestCode();

        deployment = deployer.deploy(
            DeployArbitrumSepoliaAsyncGmx.Parameters({
                domainManifestVersion: 1,
                domainManifestHash: PROVISIONAL_DOMAIN_MANIFEST_HASH,
                configDelaySeconds: DELAY,
                proposer: proposer,
                canceller: makeAddr("canceller"),
                executor: executor,
                pauser: makeAddr("pauser"),
                fundingAuthority: address(this),
                beneficiary: owner,
                market: address(market),
                marketCodeHash: address(market).codehash,
                collateralToken: IERC20(address(token)),
                collateralTokenCodeHash: address(token).codehash,
                executionClassManifestHash: EXECUTION_CLASS_MANIFEST_HASH,
                gmxCodeHashes: _gmxCodeHashes()
            })
        );
        route.config = deployment.config;
        route.configCodeHash = address(deployment.config).codehash;
        route.domainManifestVersion = 2;
        route.domainManifestHash = DOMAIN_MANIFEST_HASH;
        route.coordinator = deployment.coordinator;
        route.coordinatorCodeHash = address(deployment.coordinator).codehash;
        route.isolatedAccount = deployment.isolatedAccount;
        route.isolatedAccountCodeHash = address(deployment.isolatedAccount).codehash;
        route.adapter = deployment.adapter;
        route.adapterCodeHash = address(deployment.adapter).codehash;
    }

    function testFullSequenceOpensEntryOnlyAfterReviewedDomainBindingsAndDelayedUnpause() public {
        vm.expectRevert(ConfigureArbitrumSepoliaAsyncGmx.InvalidRoute.selector);
        operator.runBindEntryController(route, owner);
        // A script step that reverts leaves its broadcast open.
        vm.stopBroadcast();
        operator.runProposeDomain(route.config, 2, DOMAIN_MANIFEST_HASH, proposer);
        vm.warp(block.timestamp + DELAY);
        operator.runActivateDomain(route.config, 2, DOMAIN_MANIFEST_HASH, executor);

        operator.runBindEntryController(route, owner);
        DeployArbitrumSepoliaAsyncGmx.ExitAndSpotDeployment memory completion = deployer.deployExitAndSpot(
            DeployArbitrumSepoliaAsyncGmx.ExitAndSpotParameters({
                adapter: deployment.adapter,
                adapterCodeHash: route.adapterCodeHash,
                isolatedAccount: deployment.isolatedAccount,
                isolatedAccountCodeHash: route.isolatedAccountCodeHash,
                gmxCodeHashes: _gmxCodeHashes(),
                spot: _spotDeployment()
            })
        );
        route.exitController = completion.exitController;
        route.exitControllerCodeHash = address(completion.exitController).codehash;
        route.spotPort = completion.spotPort;
        route.spotPortCodeHash = address(completion.spotPort).codehash;
        operator.runProposeAdmission(route, proposer);
        vm.warp(block.timestamp + DELAY);
        operator.runActivateAdmission(route, executor);

        vm.expectRevert(ConfigureArbitrumSepoliaAsyncGmx.InvalidRoute.selector);
        operator.runScheduleUnpause(route, proposer);
        vm.stopBroadcast();
        operator.runBindExitAndSpot(route, owner);
        operator.runScheduleUnpause(route, proposer);
        uint64 readyAt = uint64(block.timestamp) + DELAY;

        IAsyncVenueAdapter.VenueRequest memory request = _request(readyAt);
        AsyncBondedPackageCoordinator.Terms memory terms = _terms(request);
        bytes memory signature = _signature(deployment.coordinator.reserveDigest(terms));
        token.mint(address(this), COLLATERAL + MAX_SPOT_QUOTE + terms.bondAtoms + terms.recoveryReserveAtoms);
        token.approve(address(deployment.coordinator), terms.bondAtoms + terms.recoveryReserveAtoms);
        token.approve(address(deployment.adapter), COLLATERAL + MAX_SPOT_QUOTE);

        vm.warp(readyAt - 1);
        vm.expectRevert(AsyncBondedPackageCoordinator.WrongState.selector);
        deployment.coordinator.reserve(terms, signature);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(ProtocolConfig.UnpauseNotReady.selector, readyAt));
        deployment.config.activateUnpause();

        vm.warp(readyAt);
        operator.runActivateEntry(route, executor);
        assertFalse(deployment.config.entryPaused());
        operator.verifyActiveRoute(route);

        bytes32 id = deployment.coordinator.reserve(terms, signature);
        assertEq(id, deployment.coordinator.packageId(terms));
        deployment.adapter.fundRequest{value: EXECUTION_FEE}(id, request);
        bytes32 requestKey = deployment.coordinator.submitRequest(id, 1, request);
        assertNotEq(requestKey, bytes32(0));
        assertEq(
            uint8(deployment.coordinator.packageState(id).state),
            uint8(AsyncBondedPackageCoordinator.State.REQUEST_SUBMITTED)
        );
        assertTrue(deployment.isolatedAccount.hasActiveSpotInventory());
        assertEq(baseToken.balanceOf(address(deployment.isolatedAccount)), SPOT_BASE);
    }

    function _etchGmx() private {
        vm.etch(deployer.GMX_DATA_STORE(), address(new GmxTestDataStore()).code);
        vm.etch(deployer.GMX_EVENT_EMITTER(), address(new GmxTestCode()).code);
        vm.etch(deployer.GMX_ROUTER(), address(new GmxTestRouter()).code);
        vm.etch(deployer.GMX_ORDER_VAULT(), address(new GmxTestOrderVault()).code);
        vm.etch(deployer.GMX_ORDER_HANDLER(), address(new GmxTestOrderHandler()).code);
        vm.etch(deployer.GMX_ROLE_STORE(), address(new GmxTestRoleStore()).code);
        GmxTestExchangeRouter exchangeRouter = new GmxTestExchangeRouter(
            deployer.GMX_DATA_STORE(),
            deployer.GMX_EVENT_EMITTER(),
            deployer.GMX_ROUTER(),
            deployer.GMX_ORDER_HANDLER(),
            deployer.GMX_ROLE_STORE(),
            deployer.GMX_ORDER_VAULT()
        );
        vm.etch(deployer.GMX_EXCHANGE_ROUTER(), address(exchangeRouter).code);
        GmxTestRoleStore(deployer.GMX_ROLE_STORE())
            .setRole(deployer.GMX_ORDER_HANDLER(), keccak256(abi.encode("CONTROLLER")), true);
        GmxTestDataStore(deployer.GMX_DATA_STORE()).setUint(keccak256(abi.encode("REQUEST_EXPIRATION_TIME")), 50);
    }

    function _gmxCodeHashes() private view returns (DeployArbitrumSepoliaAsyncGmx.GmxCodeHashes memory) {
        return DeployArbitrumSepoliaAsyncGmx.GmxCodeHashes({
            dataStore: deployer.GMX_DATA_STORE().codehash,
            eventEmitter: deployer.GMX_EVENT_EMITTER().codehash,
            exchangeRouter: deployer.GMX_EXCHANGE_ROUTER().codehash,
            router: deployer.GMX_ROUTER().codehash,
            orderVault: deployer.GMX_ORDER_VAULT().codehash,
            orderHandler: deployer.GMX_ORDER_HANDLER().codehash,
            roleStore: deployer.GMX_ROLE_STORE().codehash
        });
    }

    function _spotDeployment() private returns (UniswapV3SpotPort.Deployment memory) {
        GmxSpotFactory factory = new GmxSpotFactory();
        GmxSpotPool pool = new GmxSpotPool(address(factory), address(baseToken), address(token), POOL_FEE);
        factory.setPool(address(baseToken), address(token), POOL_FEE, address(pool));
        baseToken.mint(address(pool), SPOT_BASE * 100);
        token.mint(address(pool), MAX_SPOT_QUOTE * 100);
        return UniswapV3SpotPort.Deployment({
            chainId: block.chainid,
            factory: address(factory),
            pool: address(pool),
            baseToken: baseToken,
            quoteToken: token,
            baseTokenDecimals: 18,
            quoteTokenDecimals: 18,
            poolFee: POOL_FEE,
            factoryCodeHash: address(factory).codehash,
            poolCodeHash: address(pool).codehash,
            baseTokenCodeHash: address(baseToken).codehash,
            quoteTokenCodeHash: address(token).codehash
        });
    }

    function _request(uint64 openAt) private view returns (IAsyncVenueAdapter.VenueRequest memory) {
        return IAsyncVenueAdapter.VenueRequest({
            marketId: bytes32(uint256(uint160(address(market)))),
            collateralToken: address(token),
            sizeDelta: -int256(4_000e30),
            collateralAtoms: COLLATERAL,
            acceptablePrice: 2_500e30,
            executionFeeWei: EXECUTION_FEE,
            callbackGasLimit: 2_000_000,
            packageNonce: 0,
            orderHash: keccak256("arbitrum-order"),
            quoteHash: keccak256("arbitrum-quote"),
            routeHash: keccak256("arbitrum-route"),
            spot: IAsyncVenueAdapter.SpotEntry({
                fundingOwner: address(this),
                port: address(route.spotPort),
                portCodeHash: route.spotPortCodeHash,
                baseToken: address(baseToken),
                quoteToken: address(token),
                baseAtoms: SPOT_BASE,
                maxQuoteAtoms: MAX_SPOT_QUOTE,
                rollbackMinQuoteAtoms: SPOT_BASE,
                entryFillCommitment: keccak256("arbitrum-entry-fill"),
                rollbackFillCommitment: keccak256("arbitrum-rollback-fill")
            }),
            submissionDeadline: openAt + 100,
            venueDeadline: openAt + 200,
            recoveryDeadline: openAt + 300
        });
    }

    function _terms(IAsyncVenueAdapter.VenueRequest memory request)
        private
        view
        returns (AsyncBondedPackageCoordinator.Terms memory terms)
    {
        AsyncBondedPackageCoordinator coordinator = deployment.coordinator;
        GmxV2ArbitrumAdapter adapter = deployment.adapter;
        terms.domain = AsyncBondedPackageCoordinator.DomainRef(operator.DOMAIN_ID_HASH(), 2, DOMAIN_MANIFEST_HASH);
        terms.owner = owner;
        terms.solver = address(this);
        terms.adapter = address(adapter);
        terms.handler = address(adapter);
        terms.adapterCodeHash = address(adapter).codehash;
        terms.handlerCodeHash = address(adapter).codehash;
        terms.orderHash = request.orderHash;
        terms.quoteHash = request.quoteHash;
        terms.routeHash = request.routeHash;
        terms.seriesIdentityKey = keccak256("series");
        terms.seriesBindingVersion = 1;
        terms.seriesBindingHash = keccak256("series-binding");
        terms.executionClassIdentityHash = coordinator.EXECUTION_CLASS_ID();
        terms.executionClassManifestHash = EXECUTION_CLASS_MANIFEST_HASH;
        terms.requestPayloadHash = keccak256(abi.encode(request));
        terms.evidenceSchemaHash = coordinator.EVIDENCE_SCHEMA_ID();
        terms.bondRecipient = address(0xB1);
        terms.recoveryReserveRecipient = address(0xB2);
        terms.slashRecipient = address(0xB3);
        terms.lossAsset = address(token);
        terms.residualAsset = address(token);
        terms.bondAtoms = 100;
        terms.recoveryReserveAtoms = 25;
        terms.maxAggregateLossAtoms = 25;
        terms.maxIntermediateResidualAtoms = COLLATERAL;
        terms.maxTerminalResidualAtoms = 1;
        terms.nonce = request.packageNonce;
        terms.submissionDeadline = request.submissionDeadline;
        terms.venueDeadline = request.venueDeadline;
        terms.recoveryDeadline = request.recoveryDeadline;
        terms.bondHash = coordinator.bondCommitment(terms);
        terms.reservationHash = coordinator.reservationCommitment(terms);
        terms.recoveryPolicyHash = coordinator.recoveryPolicyCommitment(terms);
    }

    function _signature(bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }
}
