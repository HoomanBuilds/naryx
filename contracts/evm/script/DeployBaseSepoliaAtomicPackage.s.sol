// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {CashCarrySeriesRegistry} from "../src/CashCarrySeriesRegistry.sol";
import {NaryxStrategyAccountFactory} from "../src/NaryxStrategyAccountFactory.sol";
import {PackageQuoteShardRegistry} from "../src/PackageQuoteShardRegistry.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";
import {PackageVerifier} from "../src/PackageVerifier.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {ResourceRegistry} from "../src/ResourceRegistry.sol";
import {SolverRegistry} from "../src/SolverRegistry.sol";
import {UniswapV3SpotPort} from "../src/UniswapV3SpotPort.sol";
import {NaryxTestPerpMarket} from "../src/conformance/NaryxTestPerpMarket.sol";

contract DeployBaseSepoliaAtomicPackage is Script {
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;
    string public constant DOMAIN_ID = "eip155:84532";

    address public constant UNISWAP_FACTORY = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address public constant UNISWAP_POOL = 0x46880b404CD35c165EDdefF7421019F8dD25F4Ad;
    address public constant WETH = 0x4200000000000000000000000000000000000006;
    address public constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    uint24 public constant UNISWAP_POOL_FEE = 3000;

    bytes32 public constant UNISWAP_FACTORY_CODE_HASH =
        0x02ee6e36873eea6fbb674a23d53b735646f12dc84efa08eac17872fe2fad9d06;
    bytes32 public constant UNISWAP_POOL_CODE_HASH = 0xbbda0bdc9da3fd1f4832633a5ea75dc401ca24fdbca3d64a2511f27583ec7c4d;
    bytes32 public constant WETH_CODE_HASH = 0x83f731a17e6c0cdd04bc6f60b15d3e789e215b71403087b84b48650a1e5cbb21;
    bytes32 public constant USDC_CODE_HASH = 0xedc5281a85c0efecd49999a1ef668390c59b88702f2d4a07029d7f5d63059d6c;

    struct Parameters {
        uint32 domainManifestVersion;
        bytes32 domainManifestHash;
        uint64 configDelaySeconds;
        address proposer;
        address canceller;
        address executor;
        address pauser;
        address solver;
        /// The test perpetual market. Its collateral must be the pinned USDC.
        NaryxTestPerpMarket.Parameters perpetualMarket;
    }

    struct Deployment {
        ProtocolConfig config;
        SolverRegistry solverRegistry;
        ResourceRegistry resourceRegistry;
        CashCarrySeriesRegistry cashCarrySeriesRegistry;
        PackageQuoteShardRegistry packageQuoteShardRegistry;
        PackageVerifier verifier;
        NaryxStrategyAccountFactory strategyAccountFactory;
        UniswapV3SpotPort spotPort;
        NaryxTestPerpMarket perpetualMarket;
    }

    error InvalidChain();
    error InvalidPerpetualCollateral();

    function run(Parameters calldata parameters) external returns (Deployment memory deployment) {
        vm.startBroadcast();
        deployment = deploy(parameters);
        vm.stopBroadcast();
    }

    function deploy(Parameters calldata parameters) public returns (Deployment memory deployment) {
        if (block.chainid != BASE_SEPOLIA_CHAIN_ID) revert InvalidChain();
        if (address(parameters.perpetualMarket.collateral) != USDC) revert InvalidPerpetualCollateral();

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
        deployment.solverRegistry = new SolverRegistry(deployment.config, parameters.solver);
        // The cash-and-carry template manifest hash is not a deploy parameter: the template commits to the reviewed
        // domain manifest, which commits to the verifier code hash, so it is set after the domain rotation through
        // the delayed ProtocolConfig template steps.
        deployment.resourceRegistry = new ResourceRegistry(deployment.config);
        deployment.cashCarrySeriesRegistry = new CashCarrySeriesRegistry(deployment.config, deployment.resourceRegistry);
        deployment.packageQuoteShardRegistry = new PackageQuoteShardRegistry(deployment.config);
        deployment.verifier = new PackageVerifier(
            deployment.config,
            deployment.solverRegistry,
            deployment.resourceRegistry,
            deployment.cashCarrySeriesRegistry,
            deployment.packageQuoteShardRegistry,
            // Solver fees stay disabled in this deployment; a fee-enabled verifier binds a PolicyRegistry fee subject.
            PolicyRegistry(address(0)),
            bytes32(0)
        );
        // Strategy accounts are created per owner through the factory, never by this script.
        deployment.strategyAccountFactory = new NaryxStrategyAccountFactory(deployment.verifier);
        deployment.spotPort = new UniswapV3SpotPort(address(deployment.verifier), _uniswapDeployment());
        deployment.perpetualMarket = new NaryxTestPerpMarket(parameters.perpetualMarket);
    }

    function _uniswapDeployment() private pure returns (UniswapV3SpotPort.Deployment memory deployment) {
        deployment = UniswapV3SpotPort.Deployment({
            chainId: BASE_SEPOLIA_CHAIN_ID,
            factory: UNISWAP_FACTORY,
            pool: UNISWAP_POOL,
            baseToken: IERC20(WETH),
            quoteToken: IERC20(USDC),
            baseTokenDecimals: 18,
            quoteTokenDecimals: 6,
            poolFee: UNISWAP_POOL_FEE,
            factoryCodeHash: UNISWAP_FACTORY_CODE_HASH,
            poolCodeHash: UNISWAP_POOL_CODE_HASH,
            baseTokenCodeHash: WETH_CODE_HASH,
            quoteTokenCodeHash: USDC_CODE_HASH
        });
    }
}
