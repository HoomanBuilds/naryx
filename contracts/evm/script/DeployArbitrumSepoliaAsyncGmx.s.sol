// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {AsyncBondedPackageCoordinator} from "../src/AsyncBondedPackageCoordinator.sol";
import {GmxV2ArbitrumAdapter} from "../src/GmxV2ArbitrumAdapter.sol";
import {GmxV2ExitController} from "../src/GmxV2ExitController.sol";
import {GmxV2ExitOrderVerifier} from "../src/GmxV2ExitOrderVerifier.sol";
import {GmxV2IsolatedAccount} from "../src/GmxV2IsolatedAccount.sol";
import {GmxV2IsolatedAccountFactory} from "../src/GmxV2IsolatedAccountFactory.sol";
import {GmxV2OrderVerifier} from "../src/GmxV2OrderVerifier.sol";
import {GmxV2, IGmxV2ExchangeRouter} from "../src/interfaces/IGmxV2.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {UniswapV3SpotPort} from "../src/UniswapV3SpotPort.sol";

contract DeployArbitrumSepoliaAsyncGmx is Script {
    uint256 public constant ARBITRUM_SEPOLIA_CHAIN_ID = 421614;
    string public constant DOMAIN_ID = "eip155:421614";

    address public constant GMX_DATA_STORE = 0xCF4c2C4c53157BcC01A596e3788fFF69cBBCD201;
    address public constant GMX_EVENT_EMITTER = 0xa973c2692C1556E1a3d478e745e9a75624AEDc73;
    address public constant GMX_EXCHANGE_ROUTER = 0x6B489dD5bB1AAE8df246359d59aA7316760a75d2;
    address public constant GMX_ROUTER = 0x72F13a44C8ba16a678CAD549F17bc9e06d2B8bD2;
    address public constant GMX_ORDER_VAULT = 0x1b8AC606de71686fd2a1AEDEcb6E0EFba28909a2;
    address public constant GMX_ORDER_HANDLER = 0xC881c2391611829d7bc81c12a285cB0201F08f8c;
    address public constant GMX_ROLE_STORE = 0x433E3C47885b929aEcE4149E3c835E565a20D95c;

    struct GmxCodeHashes {
        bytes32 dataStore;
        bytes32 eventEmitter;
        bytes32 exchangeRouter;
        bytes32 router;
        bytes32 orderVault;
        bytes32 orderHandler;
        bytes32 roleStore;
    }

    struct Parameters {
        uint32 domainManifestVersion;
        bytes32 domainManifestHash;
        uint64 configDelaySeconds;
        address proposer;
        address canceller;
        address executor;
        address pauser;
        address market;
        bytes32 marketCodeHash;
        IERC20 collateralToken;
        bytes32 collateralTokenCodeHash;
        GmxCodeHashes gmxCodeHashes;
        UniswapV3SpotPort.Deployment spot;
    }

    struct Deployment {
        ProtocolConfig config;
        AsyncBondedPackageCoordinator coordinator;
        GmxV2OrderVerifier orderVerifier;
        GmxV2ExitOrderVerifier exitOrderVerifier;
        GmxV2IsolatedAccountFactory accountFactory;
        GmxV2ArbitrumAdapter adapter;
        GmxV2ExitController exitController;
        UniswapV3SpotPort spotPort;
        GmxV2IsolatedAccount accountImplementation;
    }

    error InvalidChain();
    error InvalidDependency(address dependency);

    function run(Parameters calldata parameters) external returns (Deployment memory deployment) {
        vm.startBroadcast();
        deployment = deploy(parameters);
        vm.stopBroadcast();
    }

    /// @notice Deploys the whole shared route in one stage and binds it into the account factory, so no
    /// per-user account exists or is configured here. Any wallet later creates its own account with
    /// `accountFactory.create(owner)`. Entry stays paused; the configure script admits the single shared
    /// adapter. The spot venue identities are reviewed operator input.
    function deploy(Parameters calldata parameters) public returns (Deployment memory deployment) {
        if (block.chainid != ARBITRUM_SEPOLIA_CHAIN_ID) revert InvalidChain();
        GmxV2.Deployment memory gmx = _gmxDeployment(parameters.gmxCodeHashes);
        _verifyDependencies(parameters, gmx);
        if (
            parameters.spot.chainId != ARBITRUM_SEPOLIA_CHAIN_ID
                || address(parameters.spot.quoteToken) != address(parameters.collateralToken)
        ) revert InvalidDependency(address(parameters.spot.quoteToken));

        deployment.config = new ProtocolConfig(
            DOMAIN_ID,
            parameters.domainManifestVersion,
            parameters.domainManifestHash,
            parameters.configDelaySeconds,
            parameters.proposer,
            parameters.canceller,
            parameters.executor,
            parameters.pauser
        );
        deployment.coordinator =
            new AsyncBondedPackageCoordinator(deployment.config, parameters.collateralToken, bytes32(0));
        deployment.orderVerifier = new GmxV2OrderVerifier();
        deployment.exitOrderVerifier = new GmxV2ExitOrderVerifier();
        deployment.accountFactory = new GmxV2IsolatedAccountFactory(parameters.market, parameters.collateralToken, gmx);
        deployment.adapter = new GmxV2ArbitrumAdapter(
            deployment.coordinator,
            address(deployment.coordinator).codehash,
            parameters.market,
            parameters.marketCodeHash,
            parameters.collateralToken,
            parameters.collateralTokenCodeHash,
            deployment.accountFactory,
            address(deployment.accountFactory).codehash,
            deployment.orderVerifier,
            address(deployment.orderVerifier).codehash,
            gmx
        );
        deployment.exitController = new GmxV2ExitController(
            deployment.adapter,
            address(deployment.adapter).codehash,
            deployment.accountFactory,
            address(deployment.accountFactory).codehash,
            deployment.exitOrderVerifier,
            address(deployment.exitOrderVerifier).codehash,
            gmx
        );
        deployment.spotPort = new UniswapV3SpotPort(address(deployment.accountFactory), parameters.spot);
        deployment.accountImplementation = new GmxV2IsolatedAccount(
            GmxV2IsolatedAccount.Binding({
                factory: address(deployment.accountFactory),
                market: parameters.market,
                collateralToken: parameters.collateralToken,
                deployment: gmx,
                entryController: address(deployment.adapter),
                entryControllerCodeHash: address(deployment.adapter).codehash,
                exitController: address(deployment.exitController),
                exitControllerCodeHash: address(deployment.exitController).codehash,
                spotPort: deployment.spotPort,
                spotPortCodeHash: address(deployment.spotPort).codehash
            })
        );
        deployment.accountFactory
            .configure(
                address(deployment.adapter),
                address(deployment.adapter).codehash,
                address(deployment.exitController),
                address(deployment.exitController).codehash,
                deployment.spotPort,
                address(deployment.spotPort).codehash,
                deployment.accountImplementation
            );
    }

    function _verifyDependencies(Parameters calldata parameters, GmxV2.Deployment memory gmx) private view {
        _requireCode(parameters.market, parameters.marketCodeHash);
        _requireCode(address(parameters.collateralToken), parameters.collateralTokenCodeHash);
        _requireCode(gmx.dataStore, gmx.dataStoreCodeHash);
        _requireCode(gmx.eventEmitter, gmx.eventEmitterCodeHash);
        _requireCode(gmx.exchangeRouter, gmx.exchangeRouterCodeHash);
        _requireCode(gmx.router, gmx.routerCodeHash);
        _requireCode(gmx.orderVault, gmx.orderVaultCodeHash);
        _requireCode(gmx.orderHandler, gmx.orderHandlerCodeHash);
        _requireCode(gmx.roleStore, gmx.roleStoreCodeHash);

        IGmxV2ExchangeRouter exchange = IGmxV2ExchangeRouter(gmx.exchangeRouter);
        if (
            exchange.dataStore() != gmx.dataStore || exchange.eventEmitter() != gmx.eventEmitter
                || exchange.router() != gmx.router || exchange.orderHandler() != gmx.orderHandler
                || exchange.roleStore() != gmx.roleStore
        ) revert InvalidDependency(gmx.exchangeRouter);
    }

    function _requireCode(address dependency, bytes32 expectedCodeHash) private view {
        if (dependency == address(0) || expectedCodeHash == bytes32(0) || dependency.codehash != expectedCodeHash) {
            revert InvalidDependency(dependency);
        }
    }

    function _gmxDeployment(GmxCodeHashes calldata hashes) private pure returns (GmxV2.Deployment memory deployment) {
        deployment = GmxV2.Deployment({
            dataStore: GMX_DATA_STORE,
            eventEmitter: GMX_EVENT_EMITTER,
            exchangeRouter: GMX_EXCHANGE_ROUTER,
            router: GMX_ROUTER,
            orderVault: GMX_ORDER_VAULT,
            orderHandler: GMX_ORDER_HANDLER,
            roleStore: GMX_ROLE_STORE,
            dataStoreCodeHash: hashes.dataStore,
            eventEmitterCodeHash: hashes.eventEmitter,
            exchangeRouterCodeHash: hashes.exchangeRouter,
            routerCodeHash: hashes.router,
            orderVaultCodeHash: hashes.orderVault,
            orderHandlerCodeHash: hashes.orderHandler,
            roleStoreCodeHash: hashes.roleStore
        });
    }
}
