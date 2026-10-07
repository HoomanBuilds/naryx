// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {DeployEvmConformanceMarkets} from "../script/DeployEvmConformanceMarkets.s.sol";
import {NaryxTestLendingPool} from "../src/conformance/NaryxTestLendingPool.sol";
import {NaryxTestOptionPool} from "../src/conformance/NaryxTestOptionPool.sol";
import {NaryxTestPerpMarket} from "../src/conformance/NaryxTestPerpMarket.sol";
import {AggregatorV3Interface} from "../src/interfaces/IAggregatorV3.sol";

contract EvmConformanceMarketsTest is Test {
    DeployEvmConformanceMarkets.Deployment private deployment;

    function setUp() public {
        vm.chainId(31_337);
        DeployEvmConformanceMarkets script = new DeployEvmConformanceMarkets();
        deployment = script.deploy(
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
    }

    function testOptionPoolSupportsLongAndShortRoundTrips() public {
        NaryxTestOptionPool pool = deployment.lowerStrikeCallPool;
        deployment.baseAsset.mint(address(this), 1_000 ether);
        deployment.baseAsset.approve(address(pool), type(uint256).max);

        pool.trade(100 ether, true, 10 ether, address(0));
        assertEq(pool.balanceOf(address(this), pool.LONG_TOKEN_ID()), 100 ether);
        pool.trade(100 ether, false, 10 ether, address(0));
        assertEq(pool.balanceOf(address(this), pool.LONG_TOKEN_ID()), 0);

        pool.trade(100 ether, false, 10 ether, address(0));
        assertEq(pool.balanceOf(address(this), pool.SHORT_TOKEN_ID()), 100 ether);
        pool.trade(100 ether, true, 10 ether, address(0));
        assertEq(pool.balanceOf(address(this), pool.SHORT_TOKEN_ID()), 0);
    }

    function testLendingPoolSupportsSupplyBorrowRepayAndWithdraw() public {
        NaryxTestLendingPool pool = deployment.lendingPool;
        deployment.baseAsset.mint(address(this), 100 ether);
        deployment.baseAsset.approve(address(pool), 100 ether);
        pool.supply(address(deployment.baseAsset), 100 ether, address(this), 0);
        pool.borrow(address(deployment.quoteAsset), 40e6, 2, 0, address(this));
        deployment.quoteAsset.approve(address(pool), 40e6);
        pool.repay(address(deployment.quoteAsset), 40e6, 2, address(this));
        pool.withdraw(address(deployment.baseAsset), 100 ether, address(this));

        assertEq(pool.collateralOf(address(this)), 0);
        assertEq(pool.debtOf(address(this)), 0);
        assertEq(IERC20(address(deployment.baseAsset)).balanceOf(address(this)), 100 ether);
    }

    function testPerpetualMarketUsesTheSharedConformanceAssetsAndOracle() public view {
        assertEq(address(deployment.perpetualMarket.collateral()), address(deployment.quoteAsset));
        assertEq(address(deployment.perpetualMarket.oracle()), address(deployment.oracleMarker));
        assertEq(deployment.perpetualMarket.oraclePriceWad(), 2_000 ether);
    }

    function testDatedFuturesUseDistinctOrderedExpiriesAndSharedDependencies() public view {
        assertEq(address(deployment.nearFutureMarket.collateral()), address(deployment.quoteAsset));
        assertEq(address(deployment.farFutureMarket.collateral()), address(deployment.quoteAsset));
        assertEq(address(deployment.nearFutureMarket.oracle()), address(deployment.oracleMarker));
        assertEq(address(deployment.farFutureMarket.oracle()), address(deployment.oracleMarker));
        assertLt(deployment.nearFutureMarket.expiry(), deployment.farFutureMarket.expiry());
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
