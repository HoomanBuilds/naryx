// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {DeployEvmConformanceAdapterFactories} from "../script/DeployEvmConformanceAdapterFactories.s.sol";
import {DeployEvmConformanceMarkets} from "../script/DeployEvmConformanceMarkets.s.sol";
import {DeployEvmMultiStrategyCore} from "../script/DeployEvmMultiStrategyCore.s.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {SolverRegistry} from "../src/SolverRegistry.sol";

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
                liquidationThresholdBps: 7_500
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
                vault: markets.vault
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
    }
}
