// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {DirectInventorySpotPort} from "../src/DirectInventorySpotPort.sol";
import {FirmInventoryReservationBook} from "../src/FirmInventoryReservationBook.sol";
import {PackageQuoteShard} from "../src/PackageQuoteShard.sol";
import {PerformanceBondVault} from "../src/PerformanceBondVault.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";

/// @notice Deploys the firm liquidity layer on top of an existing Base Sepolia atomic package
/// deployment: the firm inventory reservation book, the direct inventory spot port, one solver's
/// package quote shard, and the performance bond vault. Every dependency it binds to is pinned by
/// code hash before anything is created, and nothing is registered or configured here: shard
/// registration and port approval go through the delayed governance path of the configure script.
contract DeployBaseSepoliaFirmLiquidity is Script {
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;

    address public constant WETH = 0x4200000000000000000000000000000000000006;
    address public constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    bytes32 public constant WETH_CODE_HASH = 0x83f731a17e6c0cdd04bc6f60b15d3e789e215b71403087b84b48650a1e5cbb21;
    bytes32 public constant USDC_CODE_HASH = 0xedc5281a85c0efecd49999a1ef668390c59b88702f2d4a07029d7f5d63059d6c;

    struct Parameters {
        /// The atomic package deployment this layer binds to, with the code hashes its review pinned.
        ProtocolConfig config;
        bytes32 configCodeHash;
        address verifier;
        bytes32 verifierCodeHash;
        uint64 reservationMaximumTtlSeconds;
        uint256 maximumBaseAtomsPerReservation;
        uint256 maximumReservedBaseAtomsPerSolver;
        address shardSolver;
        bytes32 seriesManifestHash;
        bytes32 executionClassManifestHash;
        PackageQuoteShard.Limits shardLimits;
        address bondClaimsAuthority;
        address bondDisputeResolver;
    }

    struct Tokens {
        IERC20 base;
        IERC20 quote;
        bytes32 baseCodeHash;
        bytes32 quoteCodeHash;
    }

    struct Deployment {
        FirmInventoryReservationBook reservationBook;
        DirectInventorySpotPort spotPort;
        PackageQuoteShard quoteShard;
        PerformanceBondVault bondVault;
    }

    error InvalidChain();
    error DependencyChanged(address dependency);

    function run(Parameters calldata parameters) external returns (Deployment memory deployment) {
        vm.startBroadcast();
        deployment = deploy(parameters);
        vm.stopBroadcast();
    }

    /// @notice Broadcasts `deployWith`: the hosted test deployment pairs WETH with Naryx Test USDC.
    function runWith(Parameters calldata parameters, Tokens calldata tokens)
        external
        returns (Deployment memory deployment)
    {
        vm.startBroadcast();
        deployment = deployWith(parameters, tokens);
        vm.stopBroadcast();
    }

    function deploy(Parameters calldata parameters) public returns (Deployment memory deployment) {
        deployment = deployWith(
            parameters,
            Tokens({
                base: IERC20(WETH), quote: IERC20(USDC), baseCodeHash: WETH_CODE_HASH, quoteCodeHash: USDC_CODE_HASH
            })
        );
    }

    /// @notice Deploys against the given token pair, each pinned by its reviewed code hash; `deploy` pins WETH and
    /// Circle test USDC.
    function deployWith(Parameters calldata parameters, Tokens memory tokens)
        public
        returns (Deployment memory deployment)
    {
        if (block.chainid != BASE_SEPOLIA_CHAIN_ID) revert InvalidChain();
        _pinned(address(parameters.config), parameters.configCodeHash);
        _pinned(parameters.verifier, parameters.verifierCodeHash);
        _pinned(address(tokens.base), tokens.baseCodeHash);
        _pinned(address(tokens.quote), tokens.quoteCodeHash);
        (string memory domainId, uint32 domainManifestVersion, bytes32 domainManifestHash) = parameters.config.domain();

        deployment.reservationBook = new FirmInventoryReservationBook(
            parameters.config,
            tokens.base,
            tokens.quote,
            parameters.reservationMaximumTtlSeconds,
            parameters.maximumBaseAtomsPerReservation,
            parameters.maximumReservedBaseAtomsPerSolver
        );
        deployment.spotPort = new DirectInventorySpotPort(
            DirectInventorySpotPort.Deployment({
                chainId: BASE_SEPOLIA_CHAIN_ID,
                config: parameters.config,
                verifier: parameters.verifier,
                reservationBook: deployment.reservationBook,
                baseToken: tokens.base,
                quoteToken: tokens.quote,
                domainIdHash: keccak256(bytes(domainId)),
                domainManifestVersion: domainManifestVersion,
                domainManifestHash: domainManifestHash,
                configCodeHash: parameters.configCodeHash,
                verifierCodeHash: parameters.verifierCodeHash,
                reservationBookCodeHash: address(deployment.reservationBook).codehash,
                baseTokenCodeHash: tokens.baseCodeHash,
                quoteTokenCodeHash: tokens.quoteCodeHash
            })
        );
        // The verifier is the only contract that may consume the shard's capacity.
        deployment.quoteShard = new PackageQuoteShard(
            PackageQuoteShard.Deployment({
                chainId: BASE_SEPOLIA_CHAIN_ID,
                config: address(parameters.config),
                configCodeHash: parameters.configCodeHash,
                solver: parameters.shardSolver,
                consumer: parameters.verifier,
                consumerCodeHash: parameters.verifierCodeHash,
                seriesManifestHash: parameters.seriesManifestHash,
                executionClassManifestHash: parameters.executionClassManifestHash
            }),
            parameters.shardLimits
        );
        deployment.bondVault = new PerformanceBondVault(parameters.bondClaimsAuthority, parameters.bondDisputeResolver);
    }

    function _pinned(address dependency, bytes32 expectedCodeHash) private view {
        if (dependency.code.length == 0 || dependency.codehash != expectedCodeHash) {
            revert DependencyChanged(dependency);
        }
    }
}
