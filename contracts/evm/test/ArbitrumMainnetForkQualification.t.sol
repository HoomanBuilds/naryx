// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {AsyncBondedPackageCoordinator} from "../src/AsyncBondedPackageCoordinator.sol";
import {GmxV2ArbitrumAdapter} from "../src/GmxV2ArbitrumAdapter.sol";
import {GmxV2IsolatedAccountFactory} from "../src/GmxV2IsolatedAccountFactory.sol";
import {GmxV2OrderVerifier} from "../src/GmxV2OrderVerifier.sol";
import {GmxV2, IGmxV2ExchangeRouter, IGmxV2RoleStore} from "../src/interfaces/IGmxV2.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";

contract ArbitrumForkAdapterDeployer {
    struct Inputs {
        AsyncBondedPackageCoordinator coordinator;
        address market;
        bytes32 marketCodeHash;
        IERC20 collateralToken;
        bytes32 collateralCodeHash;
        GmxV2IsolatedAccountFactory factory;
        GmxV2OrderVerifier verifier;
    }

    function deploy(Inputs memory inputs, GmxV2.Deployment memory gmx) external returns (GmxV2ArbitrumAdapter adapter) {
        adapter = new GmxV2ArbitrumAdapter(
            inputs.coordinator,
            address(inputs.coordinator).codehash,
            inputs.market,
            inputs.marketCodeHash,
            inputs.collateralToken,
            inputs.collateralCodeHash,
            inputs.factory,
            address(inputs.factory).codehash,
            inputs.verifier,
            address(inputs.verifier).codehash,
            gmx
        );
    }
}

contract ArbitrumMainnetForkQualificationTest is Test {
    uint256 private constant ARBITRUM_CHAIN_ID = 42161;
    bytes32 private constant CONTROLLER_ROLE = keccak256(abi.encode("CONTROLLER"));

    function testPinnedArbitrumGmxDependenciesComposeWithCurrentAdapter() external {
        string memory rpcUrl = vm.envOr("ARBITRUM_MAINNET_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) {
            vm.skip(true, "ARBITRUM_MAINNET_RPC_URL absent: skipping pinned Arbitrum fork qualification");
        }

        uint256 forkBlock = vm.envUint("ARBITRUM_MAINNET_FORK_BLOCK");
        require(forkBlock != 0, "ARBITRUM_MAINNET_FORK_BLOCK is zero");
        vm.createSelectFork(rpcUrl, forkBlock);
        assertEq(block.chainid, ARBITRUM_CHAIN_ID);
        assertEq(block.number, forkBlock);

        GmxV2.Deployment memory gmx = _deployment();
        address market = _requiredAddress("ARBITRUM_GMX_MARKET");
        IERC20 collateralToken = IERC20(_requiredAddress("ARBITRUM_GMX_COLLATERAL_TOKEN"));
        bytes32 marketCodeHash = _requiredHash("ARBITRUM_GMX_MARKET_CODE_HASH");
        bytes32 collateralCodeHash = _requiredHash("ARBITRUM_GMX_COLLATERAL_TOKEN_CODE_HASH");
        assertEq(market.codehash, marketCodeHash);
        assertEq(address(collateralToken).codehash, collateralCodeHash);

        IGmxV2ExchangeRouter exchange = IGmxV2ExchangeRouter(gmx.exchangeRouter);
        assertEq(exchange.dataStore(), gmx.dataStore);
        assertEq(exchange.eventEmitter(), gmx.eventEmitter);
        assertEq(exchange.router(), gmx.router);
        assertEq(exchange.orderHandler(), gmx.orderHandler);
        assertEq(exchange.roleStore(), gmx.roleStore);
        assertTrue(IGmxV2RoleStore(gmx.roleStore).hasRole(gmx.orderHandler, CONTROLLER_ROLE));

        (GmxV2ArbitrumAdapter adapter, GmxV2IsolatedAccountFactory factory) =
            _deployAdapter(gmx, market, collateralToken, marketCodeHash, collateralCodeHash);

        assertEq(factory.deploymentHash(), keccak256(abi.encode(gmx)));
        assertEq(address(adapter.factory()), address(factory));
        // The factory route is unbound on the fork, so every entry fails closed.
        vm.expectRevert();
        adapter.fundRequest(bytes32(uint256(1)), _emptyRequest());
    }

    function _deployAdapter(
        GmxV2.Deployment memory gmx,
        address market,
        IERC20 collateralToken,
        bytes32 marketCodeHash,
        bytes32 collateralCodeHash
    ) private returns (GmxV2ArbitrumAdapter adapter, GmxV2IsolatedAccountFactory factory) {
        ProtocolConfig config = new ProtocolConfig(
            "eip155:42161",
            1,
            keccak256("arbitrum-mainnet-fork-evidence"),
            1,
            makeAddr("forkProposer"),
            makeAddr("forkCanceller"),
            makeAddr("forkExecutor"),
            makeAddr("forkPauser")
        );
        AsyncBondedPackageCoordinator coordinator =
            new AsyncBondedPackageCoordinator(config, collateralToken, keccak256("gmx-v2-async-bonded"));
        GmxV2OrderVerifier verifier = new GmxV2OrderVerifier();
        factory = new GmxV2IsolatedAccountFactory(market, collateralToken, gmx);
        ArbitrumForkAdapterDeployer deployer = new ArbitrumForkAdapterDeployer();
        adapter = deployer.deploy(
            ArbitrumForkAdapterDeployer.Inputs({
                coordinator: coordinator,
                market: market,
                marketCodeHash: marketCodeHash,
                collateralToken: collateralToken,
                collateralCodeHash: collateralCodeHash,
                factory: factory,
                verifier: verifier
            }),
            gmx
        );
    }

    function _deployment() private view returns (GmxV2.Deployment memory deployment) {
        deployment = GmxV2.Deployment({
            dataStore: _requiredAddress("ARBITRUM_GMX_DATA_STORE"),
            eventEmitter: _requiredAddress("ARBITRUM_GMX_EVENT_EMITTER"),
            exchangeRouter: _requiredAddress("ARBITRUM_GMX_EXCHANGE_ROUTER"),
            router: _requiredAddress("ARBITRUM_GMX_ROUTER"),
            orderVault: _requiredAddress("ARBITRUM_GMX_ORDER_VAULT"),
            orderHandler: _requiredAddress("ARBITRUM_GMX_ORDER_HANDLER"),
            roleStore: _requiredAddress("ARBITRUM_GMX_ROLE_STORE"),
            dataStoreCodeHash: _requiredHash("ARBITRUM_GMX_DATA_STORE_CODE_HASH"),
            eventEmitterCodeHash: _requiredHash("ARBITRUM_GMX_EVENT_EMITTER_CODE_HASH"),
            exchangeRouterCodeHash: _requiredHash("ARBITRUM_GMX_EXCHANGE_ROUTER_CODE_HASH"),
            routerCodeHash: _requiredHash("ARBITRUM_GMX_ROUTER_CODE_HASH"),
            orderVaultCodeHash: _requiredHash("ARBITRUM_GMX_ORDER_VAULT_CODE_HASH"),
            orderHandlerCodeHash: _requiredHash("ARBITRUM_GMX_ORDER_HANDLER_CODE_HASH"),
            roleStoreCodeHash: _requiredHash("ARBITRUM_GMX_ROLE_STORE_CODE_HASH")
        });
    }

    function _emptyRequest() private pure returns (GmxV2ArbitrumAdapter.VenueRequest memory request) {
        return request;
    }

    function _requiredAddress(string memory name) private view returns (address value) {
        value = vm.envAddress(name);
        require(value != address(0), "required fork address is zero");
    }

    function _requiredHash(string memory name) private view returns (bytes32 value) {
        value = vm.envBytes32(name);
        require(value != bytes32(0), "required fork code hash is zero");
    }
}
