// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {DeployBaseSepoliaFirmLiquidity} from "../script/DeployBaseSepoliaFirmLiquidity.s.sol";
import {PackageQuoteShard} from "../src/PackageQuoteShard.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";

contract FirmLiquidityToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}
}

/// Stands in for the package verifier: the port and shard only read its config and code hash.
contract FirmLiquidityVerifier {
    ProtocolConfig public immutable config;

    constructor(ProtocolConfig config_) {
        config = config_;
    }
}

contract DeployBaseSepoliaFirmLiquidityTest is Test {
    bytes32 private constant DOMAIN_MANIFEST_HASH = keccak256("base-sepolia-domain-manifest-v1");
    bytes32 private constant SERIES_MANIFEST_HASH = keccak256("series-manifest-v1");
    bytes32 private constant EXECUTION_CLASS_MANIFEST_HASH = keccak256("execution-class-manifest-v1");

    DeployBaseSepoliaFirmLiquidity private script;
    ProtocolConfig private config;
    FirmLiquidityVerifier private verifier;
    FirmLiquidityToken private weth;
    FirmLiquidityToken private usdc;

    function setUp() public {
        vm.chainId(84532);
        script = new DeployBaseSepoliaFirmLiquidity();
        config = new ProtocolConfig(
            "eip155:84532",
            1,
            DOMAIN_MANIFEST_HASH,
            1 days,
            makeAddr("proposer"),
            makeAddr("canceller"),
            makeAddr("executor"),
            makeAddr("pauser")
        );
        verifier = new FirmLiquidityVerifier(config);
        weth = new FirmLiquidityToken("Wrapped Ether", "WETH");
        usdc = new FirmLiquidityToken("USD Coin", "USDC");
    }

    function _parameters() private returns (DeployBaseSepoliaFirmLiquidity.Parameters memory) {
        return DeployBaseSepoliaFirmLiquidity.Parameters({
            config: config,
            configCodeHash: address(config).codehash,
            verifier: address(verifier),
            verifierCodeHash: address(verifier).codehash,
            reservationMaximumTtlSeconds: 1 hours,
            maximumBaseAtomsPerReservation: 5 ether,
            maximumReservedBaseAtomsPerSolver: 20 ether,
            shardSolver: makeAddr("solver"),
            seriesManifestHash: SERIES_MANIFEST_HASH,
            executionClassManifestHash: EXECUTION_CLASS_MANIFEST_HASH,
            shardLimits: PackageQuoteShard.Limits({maxHeartbeatSeconds: 120, maxBatchSize: 8, maxLevelCount: 32}),
            bondClaimsAuthority: makeAddr("claims"),
            bondDisputeResolver: makeAddr("resolver")
        });
    }

    function _tokens() private view returns (DeployBaseSepoliaFirmLiquidity.Tokens memory) {
        return DeployBaseSepoliaFirmLiquidity.Tokens({
            base: IERC20(address(weth)),
            quote: IERC20(address(usdc)),
            baseCodeHash: address(weth).codehash,
            quoteCodeHash: address(usdc).codehash
        });
    }

    function testDeploysTheFirmLiquidityLayerBoundToThePinnedPackageDeployment() public {
        DeployBaseSepoliaFirmLiquidity.Deployment memory deployment = script.deployWith(_parameters(), _tokens());

        assertEq(address(deployment.reservationBook.config()), address(config));
        assertEq(address(deployment.reservationBook.baseToken()), address(weth));
        assertEq(address(deployment.reservationBook.quoteToken()), address(usdc));
        assertEq(deployment.spotPort.verifier(), address(verifier));
        assertEq(address(deployment.spotPort.reservationBook()), address(deployment.reservationBook));
        assertEq(deployment.spotPort.reservationBookCodeHash(), address(deployment.reservationBook).codehash);
        assertEq(deployment.spotPort.verifierCodeHash(), address(verifier).codehash);
        assertEq(deployment.spotPort.deploymentChainId(), 84532);
        assertEq(deployment.spotPort.deploymentDomainIdHash(), keccak256("eip155:84532"));
        deployment.spotPort.assertDeployment();
        assertEq(deployment.quoteShard.config(), address(config));
        assertEq(deployment.quoteShard.consumer(), address(verifier));
        assertEq(deployment.quoteShard.solver(), makeAddr("solver"));
        assertEq(deployment.quoteShard.seriesManifestHash(), SERIES_MANIFEST_HASH);
        deployment.quoteShard.assertDeployment();
        assertEq(deployment.bondVault.claimsAuthority(), makeAddr("claims"));
        assertEq(deployment.bondVault.disputeResolver(), makeAddr("resolver"));
    }

    function testRefusesAnotherChainOrAnyDependencyWhoseCodeChanged() public {
        DeployBaseSepoliaFirmLiquidity.Parameters memory parameters = _parameters();
        DeployBaseSepoliaFirmLiquidity.Tokens memory tokens = _tokens();

        vm.chainId(8453);
        vm.expectRevert(DeployBaseSepoliaFirmLiquidity.InvalidChain.selector);
        script.deployWith(parameters, tokens);
        vm.chainId(84532);

        parameters.configCodeHash = keccak256("reviewed-config");
        vm.expectRevert(
            abi.encodeWithSelector(DeployBaseSepoliaFirmLiquidity.DependencyChanged.selector, address(config))
        );
        script.deployWith(parameters, tokens);
        parameters = _parameters();

        parameters.verifierCodeHash = keccak256("reviewed-verifier");
        vm.expectRevert(
            abi.encodeWithSelector(DeployBaseSepoliaFirmLiquidity.DependencyChanged.selector, address(verifier))
        );
        script.deployWith(parameters, tokens);
        parameters = _parameters();

        tokens.quoteCodeHash = keccak256("reviewed-usdc");
        vm.expectRevert(
            abi.encodeWithSelector(DeployBaseSepoliaFirmLiquidity.DependencyChanged.selector, address(usdc))
        );
        script.deployWith(parameters, tokens);

        // The canonical Base Sepolia tokens are pinned by code hash; without them the script stops.
        vm.expectRevert(
            abi.encodeWithSelector(DeployBaseSepoliaFirmLiquidity.DependencyChanged.selector, script.WETH())
        );
        script.deploy(parameters);
    }
}
