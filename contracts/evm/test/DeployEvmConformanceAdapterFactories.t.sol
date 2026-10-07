// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {DeployEvmConformanceAdapterFactories} from "../script/DeployEvmConformanceAdapterFactories.s.sol";
import {DeployEvmConformanceMarkets} from "../script/DeployEvmConformanceMarkets.s.sol";
import {DeployEvmMultiStrategyCore} from "../script/DeployEvmMultiStrategyCore.s.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {SolverRegistry} from "../src/SolverRegistry.sol";
import {SynFuturesTypedPerpAdapterFactory} from "../src/SynFuturesTypedPerpAdapterFactory.sol";
import {NaryxTestPerpMarket} from "../src/conformance/NaryxTestPerpMarket.sol";
import {AggregatorV3Interface} from "../src/interfaces/IAggregatorV3.sol";

contract DeployEvmConformanceAdapterFactoriesTest is Test {
    function testDeploysFactoriesBoundToTheMultiStrategyCore() public {
        vm.chainId(31_337);
        ProtocolConfig config = new ProtocolConfig(
            "eip155:31337",
            1,
            keccak256("local-domain-v1"),
            1,
            address(0x101),
            address(0x102),
            address(0x103),
            address(0x104)
        );
        SolverRegistry solverRegistry = new SolverRegistry(config, address(0x201));
        DeployEvmMultiStrategyCore coreScript = new DeployEvmMultiStrategyCore();
        DeployEvmMultiStrategyCore.Deployment memory core = coreScript.deploy(
            DeployEvmMultiStrategyCore.Parameters({
                expectedChainId: 31_337,
                expectedDomainManifestVersion: 1,
                expectedDomainManifestHash: keccak256("local-domain-v1"),
                config: config,
                solverRegistry: solverRegistry,
                feePolicySubjectId: keccak256("multi-strategy-fees")
            })
        );
        DeployEvmConformanceMarkets marketScript = new DeployEvmConformanceMarkets();
        DeployEvmConformanceMarkets.Deployment memory markets = marketScript.deploy(
            DeployEvmConformanceMarkets.Parameters({
                expectedChainId: 31_337,
                maximumBaseFaucetBalanceAtoms: 10_000_000 ether,
                maximumQuoteFaucetBalanceAtoms: 10_000_000e6,
                optionLiquidityAtomsPerPool: 1_000_000 ether,
                lowerStrike: 2_000e18,
                upperStrike: 2_500e18,
                maturity: block.timestamp + 30 days,
                lowerStrikePremiumBps: 1_000,
                upperStrikePremiumBps: 500,
                exerciseValueBps: 2_000,
                collateralPriceQuoteAtomsPerWholeToken: 2_000e6,
                loanToValueBps: 5_000,
                liquidationThresholdBps: 7_500,
                perpetualMarket: _marketParameters(365 days),
                nearFutureMarket: _marketParameters(30 days),
                farFutureMarket: _marketParameters(90 days)
            })
        );
        DeployEvmConformanceAdapterFactories factoryScript = new DeployEvmConformanceAdapterFactories();
        DeployEvmConformanceAdapterFactories.Deployment memory factories = factoryScript.deploy(
            DeployEvmConformanceAdapterFactories.Parameters({
                expectedChainId: 31_337,
                accountFactory: core.accountFactory,
                baseAsset: markets.baseAsset,
                quoteAsset: markets.quoteAsset,
                lowerStrikeCallPool: markets.lowerStrikeCallPool,
                upperStrikeCallPool: markets.upperStrikeCallPool,
                lendingPool: markets.lendingPool,
                vault: markets.vault,
                perpetualInstrument: markets.perpetualMarket,
                perpetualObserver: markets.perpetualMarket,
                perpetualMarginGate: markets.perpetualMarket,
                perpetualExpiry: markets.perpetualMarket.expiry(),
                nearFutureInstrument: markets.nearFutureMarket,
                nearFutureObserver: markets.nearFutureMarket,
                nearFutureMarginGate: markets.nearFutureMarket,
                nearFutureExpiry: markets.nearFutureMarket.expiry(),
                farFutureInstrument: markets.farFutureMarket,
                farFutureObserver: markets.farFutureMarket,
                farFutureMarginGate: markets.farFutureMarket,
                farFutureExpiry: markets.farFutureMarket.expiry()
            })
        );

        (bytes32 optionClass,, address optionBase, address optionQuote) =
            factories.lowerStrikeOptionFactory.factoryMetadata();
        assertEq(optionClass, keccak256("naryx.evm.premia-v3-option-exact"));
        assertEq(optionBase, address(markets.baseAsset));
        assertEq(optionQuote, address(markets.quoteAsset));
        (bytes32 inventoryClass,, address inventoryBase, address inventoryQuote) =
            factories.inventoryFactory.factoryMetadata();
        assertEq(inventoryClass, keccak256("naryx.evm.inventory-custody-exact"));
        assertEq(inventoryBase, address(markets.baseAsset));
        assertEq(inventoryQuote, address(markets.quoteAsset));
        _assertFactoryMetadata(
            factories.perpetualFactory,
            keccak256("naryx.evm.perp-exact"),
            address(markets.baseAsset),
            address(markets.quoteAsset),
            address(markets.perpetualMarket)
        );
        _assertFactoryMetadata(
            factories.nearFutureFactory,
            keccak256("naryx.evm.future-exact"),
            address(markets.baseAsset),
            address(markets.quoteAsset),
            address(markets.nearFutureMarket)
        );
        _assertFactoryMetadata(
            factories.farFutureFactory,
            keccak256("naryx.evm.future-exact"),
            address(markets.baseAsset),
            address(markets.quoteAsset),
            address(markets.farFutureMarket)
        );
    }

    function _assertFactoryMetadata(
        SynFuturesTypedPerpAdapterFactory factory,
        bytes32 expectedClass,
        address expectedBase,
        address expectedQuote,
        address expectedInstrument
    ) private view {
        (bytes32 adapterClass,, address base, address quote) = factory.factoryMetadata();
        assertEq(adapterClass, expectedClass);
        assertEq(base, expectedBase);
        assertEq(quote, expectedQuote);
        assertEq(address(factory.instrument()), expectedInstrument);
    }

    function _marketParameters(uint256 expiryOffset) private view returns (NaryxTestPerpMarket.Parameters memory) {
        return NaryxTestPerpMarket.Parameters({
            owner: address(this),
            fundingKeeper: address(this),
            feeRecipient: address(0xFEE),
            collateral: IERC20(address(0)),
            oracle: AggregatorV3Interface(address(0)),
            expiry: uint32(block.timestamp + expiryOffset),
            maxOracleAgeSeconds: 1 days,
            takerFeeBps: 5,
            halfSpreadBps: 5,
            impactBps: 25,
            impactSizeWad: 1_000 ether,
            initialMarginBps: 1_000,
            maintenanceMarginBps: 500,
            liquidationPenaltyBps: 100,
            maxPositionSizeWad: 10_000 ether,
            maxMarginWad: 10_000_000 ether,
            maxAbsFundingRatePerSecond: 1e11
        });
    }
}
