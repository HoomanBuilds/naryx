// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "openzeppelin-contracts/token/ERC20/extensions/IERC20Metadata.sol";
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

interface IBaseSepoliaUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

contract DeployBaseSepoliaAtomicPackage is Script {
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;
    string public constant DOMAIN_ID = "eip155:84532";
    bytes32 public constant SOLVER_FEE_POLICY_SUBJECT_ID = keccak256("naryx.cash-carry.solver-fee");

    address public constant UNISWAP_FACTORY = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address public constant WETH = 0x4200000000000000000000000000000000000006;
    uint8 public constant QUOTE_DECIMALS = 6;

    bytes32 public constant UNISWAP_FACTORY_CODE_HASH =
        0x02ee6e36873eea6fbb674a23d53b735646f12dc84efa08eac17872fe2fad9d06;
    bytes32 public constant WETH_CODE_HASH = 0x83f731a17e6c0cdd04bc6f60b15d3e789e215b71403087b84b48650a1e5cbb21;

    /// @notice The six-decimal quote token and its WETH pool on the canonical Uniswap V3 factory. The hosted test
    /// deployment uses Naryx Test USDC with a pool seeded at the oracle price (SeedUniswapV3TestPool); Circle test
    /// USDC also qualifies. Both code hashes are reviewed inputs pinned here and again by the spot port.
    struct SpotQuote {
        IERC20 token;
        bytes32 tokenCodeHash;
        address pool;
        bytes32 poolCodeHash;
        uint24 poolFee;
    }

    struct Parameters {
        uint32 domainManifestVersion;
        bytes32 domainManifestHash;
        uint64 configDelaySeconds;
        address proposer;
        address canceller;
        address executor;
        address pauser;
        address solver;
        SpotQuote quote;
        /// The test perpetual market. Its collateral must be the quote token.
        NaryxTestPerpMarket.Parameters perpetualMarket;
    }

    struct Deployment {
        ProtocolConfig config;
        SolverRegistry solverRegistry;
        ResourceRegistry resourceRegistry;
        CashCarrySeriesRegistry cashCarrySeriesRegistry;
        PackageQuoteShardRegistry packageQuoteShardRegistry;
        PolicyRegistry policyRegistry;
        PackageVerifier verifier;
        NaryxStrategyAccountFactory strategyAccountFactory;
        UniswapV3SpotPort spotPort;
        NaryxTestPerpMarket perpetualMarket;
    }

    error InvalidChain();
    error InvalidPerpetualCollateral();
    error InvalidQuoteToken();
    error InvalidSpotPool();

    function run(Parameters calldata parameters) external returns (Deployment memory deployment) {
        vm.startBroadcast();
        deployment = deploy(parameters);
        vm.stopBroadcast();
    }

    function deploy(Parameters calldata parameters) public returns (Deployment memory deployment) {
        if (block.chainid != BASE_SEPOLIA_CHAIN_ID) revert InvalidChain();
        SpotQuote calldata quote = parameters.quote;
        address quoteToken = address(quote.token);
        if (
            quoteToken.code.length == 0 || quoteToken.codehash != quote.tokenCodeHash || quoteToken == WETH
                || IERC20Metadata(quoteToken).decimals() != QUOTE_DECIMALS
        ) revert InvalidQuoteToken();
        if (
            quote.pool == address(0) || quote.pool.codehash != quote.poolCodeHash
                || IBaseSepoliaUniswapV3Factory(UNISWAP_FACTORY).getPool(WETH, quoteToken, quote.poolFee) != quote.pool
        ) revert InvalidSpotPool();
        if (address(parameters.perpetualMarket.collateral) != quoteToken) revert InvalidPerpetualCollateral();

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
        deployment.policyRegistry = new PolicyRegistry(deployment.config);
        deployment.verifier = new PackageVerifier(
            deployment.config,
            deployment.solverRegistry,
            deployment.resourceRegistry,
            deployment.cashCarrySeriesRegistry,
            deployment.packageQuoteShardRegistry,
            deployment.policyRegistry,
            SOLVER_FEE_POLICY_SUBJECT_ID
        );
        // Strategy accounts are created per owner through the factory, never by this script.
        deployment.strategyAccountFactory = new NaryxStrategyAccountFactory(deployment.verifier);
        deployment.spotPort = new UniswapV3SpotPort(address(deployment.verifier), _uniswapDeployment(quote));
        deployment.perpetualMarket = new NaryxTestPerpMarket(parameters.perpetualMarket);
    }

    function _uniswapDeployment(SpotQuote calldata quote)
        private
        pure
        returns (UniswapV3SpotPort.Deployment memory deployment)
    {
        deployment = UniswapV3SpotPort.Deployment({
            chainId: BASE_SEPOLIA_CHAIN_ID,
            factory: UNISWAP_FACTORY,
            pool: quote.pool,
            baseToken: IERC20(WETH),
            quoteToken: quote.token,
            baseTokenDecimals: 18,
            quoteTokenDecimals: QUOTE_DECIMALS,
            poolFee: quote.poolFee,
            factoryCodeHash: UNISWAP_FACTORY_CODE_HASH,
            poolCodeHash: quote.poolCodeHash,
            baseTokenCodeHash: WETH_CODE_HASH,
            quoteTokenCodeHash: quote.tokenCodeHash
        });
    }
}
