// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {NaryxTestAsset} from "../src/conformance/NaryxTestAsset.sol";
import {INaryxTestMintableToken, NaryxTestLendingPool} from "../src/conformance/NaryxTestLendingPool.sol";
import {NaryxTestOptionPool} from "../src/conformance/NaryxTestOptionPool.sol";
import {NaryxTestOracleMarker} from "../src/conformance/NaryxTestOracleMarker.sol";
import {NaryxTestPerpMarket} from "../src/conformance/NaryxTestPerpMarket.sol";
import {NaryxTestVault} from "../src/conformance/NaryxTestVault.sol";

contract DeployEvmConformanceMarkets is Script {
    struct Parameters {
        uint256 expectedChainId;
        uint256 maximumBaseFaucetBalanceAtoms;
        uint256 maximumQuoteFaucetBalanceAtoms;
        uint256 optionLiquidityAtomsPerPool;
        uint256 lowerStrike;
        uint256 upperStrike;
        uint256 maturity;
        uint16 lowerStrikePremiumBps;
        uint16 upperStrikePremiumBps;
        uint16 exerciseValueBps;
        uint256 collateralPriceQuoteAtomsPerWholeToken;
        uint16 loanToValueBps;
        uint16 liquidationThresholdBps;
        NaryxTestPerpMarket.Parameters perpetualMarket;
        NaryxTestPerpMarket.Parameters nearFutureMarket;
        NaryxTestPerpMarket.Parameters farFutureMarket;
    }

    struct Deployment {
        NaryxTestAsset baseAsset;
        NaryxTestAsset quoteAsset;
        NaryxTestOracleMarker oracleMarker;
        NaryxTestOptionPool lowerStrikeCallPool;
        NaryxTestOptionPool upperStrikeCallPool;
        NaryxTestLendingPool lendingPool;
        NaryxTestVault vault;
        NaryxTestPerpMarket perpetualMarket;
        NaryxTestPerpMarket nearFutureMarket;
        NaryxTestPerpMarket farFutureMarket;
    }

    error InvalidChain();
    error InvalidConfiguration();

    function run(Parameters calldata parameters) external returns (Deployment memory deployment) {
        vm.startBroadcast();
        deployment = deploy(parameters);
        vm.stopBroadcast();
    }

    function deploy(Parameters calldata parameters) public returns (Deployment memory deployment) {
        if (parameters.expectedChainId == 0 || block.chainid != parameters.expectedChainId) revert InvalidChain();
        if (
            parameters.maximumBaseFaucetBalanceAtoms == 0 || parameters.maximumQuoteFaucetBalanceAtoms == 0
                || parameters.optionLiquidityAtomsPerPool == 0
                || parameters.optionLiquidityAtomsPerPool > parameters.maximumBaseFaucetBalanceAtoms
                || parameters.lowerStrike == 0 || parameters.upperStrike <= parameters.lowerStrike
                || parameters.maturity <= block.timestamp
                || address(parameters.perpetualMarket.collateral) != address(0)
                || address(parameters.perpetualMarket.oracle) != address(0)
                || address(parameters.nearFutureMarket.collateral) != address(0)
                || address(parameters.nearFutureMarket.oracle) != address(0)
                || address(parameters.farFutureMarket.collateral) != address(0)
                || address(parameters.farFutureMarket.oracle) != address(0)
                || parameters.nearFutureMarket.expiry <= block.timestamp
                || parameters.farFutureMarket.expiry <= parameters.nearFutureMarket.expiry
        ) revert InvalidConfiguration();

        deployment.baseAsset =
            new NaryxTestAsset("Naryx Test Base", "ntBASE", 18, parameters.maximumBaseFaucetBalanceAtoms);
        deployment.quoteAsset =
            new NaryxTestAsset("Naryx Test Quote", "ntQUOTE", 6, parameters.maximumQuoteFaucetBalanceAtoms);
        deployment.oracleMarker = new NaryxTestOracleMarker();
        deployment.perpetualMarket = _perpMarket(parameters.perpetualMarket, deployment);
        deployment.nearFutureMarket = _perpMarket(parameters.nearFutureMarket, deployment);
        deployment.farFutureMarket = _perpMarket(parameters.farFutureMarket, deployment);
        deployment.lowerStrikeCallPool = new NaryxTestOptionPool(
            deployment.baseAsset,
            INaryxTestMintableToken(address(deployment.quoteAsset)),
            address(deployment.oracleMarker),
            parameters.lowerStrike,
            parameters.maturity,
            true,
            parameters.lowerStrikePremiumBps,
            parameters.exerciseValueBps
        );
        deployment.upperStrikeCallPool = new NaryxTestOptionPool(
            deployment.baseAsset,
            deployment.quoteAsset,
            address(deployment.oracleMarker),
            parameters.upperStrike,
            parameters.maturity,
            true,
            parameters.upperStrikePremiumBps,
            parameters.exerciseValueBps
        );
        deployment.lendingPool = new NaryxTestLendingPool(
            deployment.baseAsset,
            INaryxTestMintableToken(address(deployment.quoteAsset)),
            parameters.collateralPriceQuoteAtomsPerWholeToken,
            parameters.loanToValueBps,
            parameters.liquidationThresholdBps
        );
        deployment.vault = new NaryxTestVault(deployment.baseAsset);
        deployment.baseAsset.mint(address(deployment.lowerStrikeCallPool), parameters.optionLiquidityAtomsPerPool);
        deployment.baseAsset.mint(address(deployment.upperStrikeCallPool), parameters.optionLiquidityAtomsPerPool);
    }

    function _perpMarket(NaryxTestPerpMarket.Parameters calldata source, Deployment memory deployment)
        private
        returns (NaryxTestPerpMarket market)
    {
        NaryxTestPerpMarket.Parameters memory parameters = source;
        parameters.collateral = deployment.quoteAsset;
        parameters.oracle = deployment.oracleMarker;
        return new NaryxTestPerpMarket(parameters);
    }
}
