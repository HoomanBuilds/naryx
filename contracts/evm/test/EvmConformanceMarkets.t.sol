// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {DeployEvmConformanceMarkets} from "../script/DeployEvmConformanceMarkets.s.sol";
import {NaryxTestLendingPool} from "../src/conformance/NaryxTestLendingPool.sol";
import {NaryxTestOptionPool} from "../src/conformance/NaryxTestOptionPool.sol";

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
                liquidationThresholdBps: 7_500
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
}
